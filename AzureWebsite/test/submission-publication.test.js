'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicationCoordinator, indexingFailureCode } = require('../services/submission-publication');
const { PublicationConflictError } = require('../services/azure-submission-publication');
const { createInMemorySubmissionRepository } = require('../services/submission-repository');

function input(title = 'Reviewed research') {
  return {
    ownerId: 'internal-owner',
    markdown: `---\ntitle: ${title}\n---\n# Finding\nEvidence.\n`,
    metadata: { title }
  };
}

function fakeAdapters(events, options = {}) {
  return {
    publicStore: {
      async write(payload) {
        events.push(`public.write:${payload.slug}`);
        if (options.writeConflict) throw new PublicationConflictError('slug in use');
        if (options.writeFailsAfterAccept) {
          options.publicExists = true;
          throw Object.assign(new Error('response lost after acceptance'), { code: 'blob_unavailable' });
        }
        if (options.writeFails) throw Object.assign(new Error('write failed'), { code: 'blob_unavailable' });
        options.publicExists = true;
        return { etag: 'public-etag' };
      },
      async verify(payload) {
        events.push(`public.verify:${payload.slug}`);
        return options.publicExists ? { etag: 'public-etag' } : null;
      },
      async verifyOwnership(payload) {
        events.push(`public.ownership:${payload.slug}`);
        if (options.collisionExists) throw new PublicationConflictError('owned by another operation');
        return options.publicExists ? { etag: 'public-etag' } : null;
      },
      async remove(payload) {
        events.push(`public.remove:${payload.slug}`);
        if (options.publicRemoveFails) throw new Error('public removal failed');
        options.publicExists = false;
      }
    },
    searchIndex: {
      async prepare(payload, progress = {}) {
        const completed = Array.isArray(progress.checkpoint?.vectors)
          ? progress.checkpoint.vectors.length
          : 0;
        events.push(`embedding:${payload.slug}:${completed}`);
        if (completed === 0) {
          const checkpoint = { contentHash: 'hash', total: 3, vectors: [[]] };
          await progress.onCheckpoint?.(checkpoint);
          await progress.onProgress?.(1, 3);
          if (options.embeddingFailsOnce && !options.embeddingFailureUsed) {
            options.embeddingFailureUsed = true;
            throw Object.assign(new Error('embedding failed'), { code: 'embedding_timeout' });
          }
        }
        const prepared = { contentHash: 'hash', total: 3, vectors: [[], [], []] };
        await progress.onCheckpoint?.(prepared);
        await progress.onProgress?.(3, 3);
        return prepared;
      },
      async commit(payload, prepared) {
        assert.equal(prepared.vectors.length, 3);
        events.push(`index.write:${payload.slug}`);
        options.indexMayExist = true;
        if (options.indexFailsOnce && !options.indexFailureUsed) {
          options.indexFailureUsed = true;
          throw Object.assign(new Error('index failed'), { code: 'search_verification_failed' });
        }
        return { version: 'index-version' };
      },
      async remove(payload) {
        events.push(`index.remove:${payload.slug}`);
        if (options.indexRemoveFails) throw new Error('index removal failed');
        options.indexMayExist = false;
      }
    }
  };
}

async function readySubmission(repository, title) {
  const pending = await repository.create(input(title));
  return repository.transition(pending.id, 'ready_for_review');
}

test('approval verifies public Markdown before indexing and exposes independent readiness states', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository);
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events) });

  const queued = await coordinator.enqueue(ready.id);
  const publicRecord = await repository.get(ready.id);
  assert.deepEqual(queued, {
    id: ready.id,
    slug: 'reviewed-research',
    status: 'published',
    indexingStatus: 'pending',
    idempotent: false,
    activated: true
  });
  assert.equal(publicRecord.status, 'published');
  assert.equal(publicRecord.publication.status, 'published');
  assert.equal(publicRecord.publication.indexingStatus, 'pending');
  assert.equal(publicRecord.publication.indexed, false);
  assert.deepEqual(events, ['public.verify:reviewed-research', 'public.write:reviewed-research']);

  const result = await coordinator.process(ready.id);
  assert.equal(result.indexingStatus, 'ready');
  assert.equal((await repository.get(ready.id)).publication.indexed, true);
  assert.deepEqual(events.slice(-2), ['embedding:reviewed-research:0', 'index.write:reviewed-research']);
});

test('Search failure keeps verified Markdown public and retry reuses embeddings without another public write', async () => {
  const events = [];
  const options = { indexFailsOnce: true };
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository, 'Stable public note');
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events, options) });

  await coordinator.enqueue(ready.id);
  await assert.rejects(() => coordinator.process(ready.id), { code: 'search_verification_failed' });
  const failed = await repository.get(ready.id);
  assert.equal(failed.status, 'published');
  assert.equal(failed.publication.publicWritten, true);
  assert.equal(failed.publication.indexingStatus, 'failed');
  assert.equal(failed.publication.indexingFailureCode, 'search_verification_failed');
  assert.equal(failed.publication.embeddingCheckpoint.vectors.length, 3);
  assert.equal(events.filter((event) => event.startsWith('public.write')).length, 1);
  assert.equal(events.filter((event) => event.startsWith('public.remove')).length, 0);

  await coordinator.enqueue(ready.id);
  const retried = await coordinator.process(ready.id);
  assert.equal(retried.indexingStatus, 'ready');
  assert.equal(events.at(-2), 'embedding:stable-public-note:3');
  assert.equal(events.filter((event) => event.startsWith('public.write')).length, 1);
});

test('embedding crash checkpoint resumes completed work while public visibility stays active', async () => {
  const events = [];
  const options = { embeddingFailsOnce: true };
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository, 'Resumable note');
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events, options) });

  await coordinator.enqueue(ready.id);
  await assert.rejects(() => coordinator.process(ready.id), { code: 'embedding_timeout' });
  const interrupted = await repository.get(ready.id);
  assert.equal(interrupted.status, 'published');
  assert.equal(interrupted.publication.embeddingCheckpoint.vectors.length, 1);

  await coordinator.enqueue(ready.id);
  await coordinator.process(ready.id);
  assert.ok(events.includes('embedding:resumable-note:1'));
  assert.equal(events.filter((event) => event.startsWith('public.write')).length, 1);
});

test('ambiguous public write remains retryable and verifies the existing owned Blob without rewriting it', async () => {
  const events = [];
  const options = { writeFailsAfterAccept: true };
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository, 'Recovered public write');
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events, options) });

  await assert.rejects(() => coordinator.enqueue(ready.id), { code: 'public_write_failed' });
  options.writeFailsAfterAccept = false;
  const retry = await coordinator.enqueue(ready.id);
  assert.equal(retry.status, 'published');
  assert.equal(events.at(-1), 'public.verify:recovered-public-write');
  assert.equal(events.filter((event) => event.startsWith('public.write')).length, 1);
});

test('slug conflict cannot delete Search or Blob content owned by another publication', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository, 'Existing article');
  const coordinator = createPublicationCoordinator({
    repository,
    ...fakeAdapters(events, { writeConflict: true, collisionExists: true })
  });

  await assert.rejects(() => coordinator.enqueue(ready.id), { code: 'publication_conflict' });
  assert.deepEqual(events, ['public.verify:existing-article', 'public.write:existing-article']);
  assert.equal((await repository.get(ready.id)).status, 'publishing');
  await assert.rejects(() => coordinator.remove(ready.id), { code: 'unpublish_failed' });
  assert.deepEqual(events.slice(-1), ['public.ownership:existing-article']);
  assert.equal(events.some((event) => event.startsWith('index.remove')), false);
});

test('deletion removes partial Search state and the public Blob before erasing the record', async () => {
  const events = [];
  const options = { indexFailsOnce: true };
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository);
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events, options) });
  await coordinator.enqueue(ready.id);
  await assert.rejects(() => coordinator.process(ready.id));
  events.length = 0;

  const removed = await coordinator.remove(ready.id);
  assert.deepEqual(events, [
    'public.ownership:reviewed-research',
    'index.remove:reviewed-research',
    'public.remove:reviewed-research'
  ]);
  assert.deepEqual(removed, { id: ready.id, status: 'deleted', idempotent: false });
  assert.equal((await repository.get(ready.id)).status, 'deleted');
});

test('private, rejected, and deleted submissions never reach public or Search adapters', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events) });
  const pending = await repository.create(input('Pending'));

  await assert.rejects(() => coordinator.enqueue(pending.id), { code: 'not_publishable' });
  await repository.transition(pending.id, 'ready_for_review');
  await coordinator.reject(pending.id, 'Insufficient source support.');
  await assert.rejects(() => coordinator.enqueue(pending.id), { code: 'not_publishable' });
  await coordinator.remove(pending.id);
  assert.deepEqual(events, []);
});

test('existing embedding and Search failure categories remain safe and diagnosable', () => {
  assert.equal(indexingFailureCode({ code: 'embedding_authentication_failed' }), 'embedding_authentication_failed');
  assert.equal(indexingFailureCode({ code: 'embedding_busy' }), 'embedding_busy');
  assert.equal(indexingFailureCode({ code: 'search_http_503' }), 'search_http_503');
  assert.equal(indexingFailureCode({ code: 'search_index_rejected' }), 'search_index_rejected');
  assert.equal(indexingFailureCode({ code: 'search_verification_failed' }), 'search_verification_failed');
  assert.equal(indexingFailureCode({ code: 'raw-secret-or-content' }), 'indexing_failed');
  assert.equal(indexingFailureCode(new Error('sensitive upstream response')), 'indexing_failed');
});
