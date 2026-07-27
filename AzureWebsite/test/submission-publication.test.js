'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicationCoordinator } = require('../services/submission-publication');
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
        if (options.writeFails) throw new Error('write failed');
        return { etag: 'public-etag' };
      },
      async remove(payload) {
        events.push(`public.remove:${payload.slug}`);
        if (options.publicRemoveFails) throw new Error('public removal failed');
      }
    },
    searchIndex: {
      async index(payload) {
        events.push(`index.write:${payload.slug}`);
        if (options.indexFailsOnce && !options.indexFailureUsed) {
          options.indexFailureUsed = true;
          throw new Error('index failed');
        }
        return { version: 'index-version' };
      },
      async remove(payload) {
        events.push(`index.remove:${payload.slug}`);
        if (options.indexRemoveFails) throw new Error('index removal failed');
      }
    }
  };
}

async function readySubmission(repository, title) {
  const pending = await repository.create(input(title));
  return repository.transition(pending.id, 'ready_for_review');
}

test('publication writes public content, indexes it, and only then marks published', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository);
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events) });

  const result = await coordinator.publish(ready.id);
  const stored = await repository.get(ready.id);
  assert.deepEqual(events, ['public.write:reviewed-research', 'index.write:reviewed-research']);
  assert.deepEqual(result, { id: ready.id, slug: 'reviewed-research', status: 'published', idempotent: false });
  assert.equal(stored.status, 'published');
  assert.deepEqual(stored.publication, {
    publicWritten: true,
    indexed: true,
    publicVersion: 'public-etag',
    indexVersion: 'index-version'
  });
});

test('published retry is idempotent and concurrent publish requests do not duplicate documents', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository);
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events) });

  const [first, second] = await Promise.all([coordinator.publish(ready.id), coordinator.publish(ready.id)]);
  assert.equal(first.status, 'published');
  assert.equal(second.idempotent, true);
  assert.deepEqual(events, ['public.write:reviewed-research', 'index.write:reviewed-research']);
  assert.equal((await coordinator.publish(ready.id)).idempotent, true);
  assert.equal(events.length, 2);
});

test('index failure compensates index and public writes, records failed, and safely retries the same slug', async () => {
  const events = [];
  const options = { indexFailsOnce: true };
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository, 'Stable slug');
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events, options) });

  await assert.rejects(() => coordinator.publish(ready.id), { code: 'publication_failed' });
  const failed = await repository.get(ready.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.publication, { publicWritten: false, indexed: false });
  assert.deepEqual(events, [
    'public.write:stable-slug',
    'index.write:stable-slug',
    'index.remove:stable-slug',
    'public.remove:stable-slug'
  ]);

  const retried = await coordinator.publish(ready.id);
  assert.equal(retried.slug, 'stable-slug');
  assert.equal(retried.status, 'published');
  assert.deepEqual(events.slice(-2), ['public.write:stable-slug', 'index.write:stable-slug']);
});

test('incomplete compensation stays publishing and blocks deletion instead of claiming a safe failure', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository);
  const options = { writeFails: true, publicRemoveFails: true };
  const adapters = fakeAdapters(events, options);
  const coordinator = createPublicationCoordinator({ repository, ...adapters });

  await assert.rejects(() => coordinator.publish(ready.id), { code: 'cleanup_required' });
  assert.equal((await repository.get(ready.id)).status, 'publishing');
  await assert.rejects(() => coordinator.remove(ready.id), { code: 'cleanup_required' });

  options.writeFails = false;
  options.publicRemoveFails = false;
  const retried = await coordinator.publish(ready.id);
  assert.equal(retried.status, 'published');
  assert.deepEqual(events.slice(-2), [
    'public.write:reviewed-research',
    'index.write:reviewed-research'
  ]);
});

test('slug conflict never compensates public or Search content owned by another publication', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository, 'Existing article');
  const coordinator = createPublicationCoordinator({
    repository,
    ...fakeAdapters(events, { writeConflict: true })
  });

  await assert.rejects(() => coordinator.publish(ready.id), { code: 'publication_failed' });
  assert.deepEqual(events, ['public.write:existing-article']);
  assert.equal((await repository.get(ready.id)).status, 'failed');
});

test('pending, rejected, and deleted submissions never reach public or index adapters', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events) });
  const pending = await repository.create(input('Pending'));

  await assert.rejects(() => coordinator.publish(pending.id), { code: 'not_publishable' });
  await repository.transition(pending.id, 'ready_for_review');
  const rejected = await coordinator.reject(pending.id, 'Insufficient source support.');
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(() => coordinator.publish(pending.id), { code: 'not_publishable' });
  assert.equal((await coordinator.remove(pending.id)).status, 'deleted');
  await assert.rejects(() => coordinator.publish(pending.id), { code: 'not_publishable' });
  assert.deepEqual(events, []);
});

test('removing a published submission deletes searchable chunks before the public copy and then marks deleted', async () => {
  const events = [];
  const repository = createInMemorySubmissionRepository();
  const ready = await readySubmission(repository);
  const coordinator = createPublicationCoordinator({ repository, ...fakeAdapters(events) });
  await coordinator.publish(ready.id);
  events.length = 0;

  const removed = await coordinator.remove(ready.id);
  assert.deepEqual(events, ['index.remove:reviewed-research', 'public.remove:reviewed-research']);
  assert.deepEqual(removed, { id: ready.id, status: 'deleted', idempotent: false });
  assert.equal((await repository.get(ready.id)).status, 'deleted');
  assert.equal((await coordinator.remove(ready.id)).idempotent, true);
});
