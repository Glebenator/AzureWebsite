'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicationCoordinator } = require('../services/submission-publication');
const { createPublicationWorker } = require('../services/submission-publication-worker');
const { createInMemorySubmissionRepository } = require('../services/submission-repository');

async function ready(repository, title = 'Queued note') {
  const record = await repository.create({
    ownerId: 'owner',
    markdown: `---\ntitle: ${title}\n---\n\n# Finding\n\nEvidence.\n`,
    metadata: { title }
  });
  return repository.transition(record.id, 'ready_for_review');
}

function workflow(repository, events, options = {}) {
  let publicExists = Boolean(options.publicExists);
  return createPublicationCoordinator({
    repository,
    publicStore: {
      async write(payload) { events.push(`public:${payload.slug}`); publicExists = true; return { etag: 'etag' }; },
      async verify(payload) { events.push(`verify:${payload.slug}`); return publicExists ? { etag: 'etag' } : null; },
      async verifyOwnership(payload) { events.push(`ownership:${payload.slug}`); return publicExists ? { etag: 'etag' } : null; },
      async remove() {}
    },
    searchIndex: {
      async prepare(payload, options = {}) {
        const vectors = options.checkpoint?.vectors || [];
        events.push(`embed:${payload.slug}:${vectors.length}`);
        const prepared = { contentHash: 'hash', total: 1, vectors: [[]] };
        await options.onCheckpoint?.(prepared);
        return prepared;
      },
      async commit(payload) { events.push(`search:${payload.slug}`); return { version: 'index' }; },
      async remove() {}
    }
  });
}

test('enqueue verifies public availability before background indexing is scheduled', async () => {
  const repository = createInMemorySubmissionRepository();
  const record = await ready(repository);
  const events = [];
  let scheduled;
  let cacheInvalidations = 0;
  const worker = createPublicationWorker({
    publication: workflow(repository, events),
    repository,
    onPublished() { cacheInvalidations += 1; },
    log() {},
    schedule(callback) { scheduled = callback; }
  });

  const queued = await worker.enqueue(record.id);
  assert.equal(queued.status, 'published');
  assert.equal(queued.indexingStatus, 'pending');
  assert.equal((await repository.get(record.id)).status, 'published');
  assert.deepEqual(events, ['verify:queued-note', 'public:queued-note']);
  assert.equal(cacheInvalidations, 1);

  scheduled();
  await worker.waitForIdle();
  assert.equal((await repository.get(record.id)).publication.indexingStatus, 'ready');
  assert.deepEqual(events, ['verify:queued-note', 'public:queued-note', 'embed:queued-note:0', 'search:queued-note']);
});

test('startup resumes a durable published embedding checkpoint without another Blob write', async () => {
  const repository = createInMemorySubmissionRepository();
  const record = await ready(repository, 'Recovered note');
  const events = [];
  const publication = workflow(repository, events);
  await publication.enqueue(record.id);
  const published = await repository.get(record.id);
  await repository.patch(record.id, {
    publication: {
      ...published.publication,
      embeddingCheckpoint: { contentHash: 'hash', total: 1, vectors: [[]] },
      embeddingCompleted: 1,
      embeddingTotal: 1,
      indexingStatus: 'indexing'
    }
  }, { requiredStatus: 'published' });
  events.length = 0;
  const worker = createPublicationWorker({ publication, repository, log() {} });

  await worker.start();
  await worker.waitForIdle();
  assert.equal((await repository.get(record.id)).publication.indexingStatus, 'ready');
  assert.deepEqual(events, ['embed:recovered-note:1', 'search:recovered-note']);
});

test('startup converts a legacy publishing recovery record through Blob verification', async () => {
  const repository = createInMemorySubmissionRepository();
  const record = await ready(repository, 'Legacy recovery');
  await repository.transition(record.id, 'publishing', {
    failureCode: 'cleanup_required',
    publication: { publicWritten: true, indexed: false, status: 'verifying', indexingStatus: 'failed' }
  });
  const events = [];
  const worker = createPublicationWorker({ publication: workflow(repository, events, { publicExists: true }), repository, log() {} });

  await worker.start();
  await worker.waitForIdle();
  const recovered = await repository.get(record.id);
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.publication.indexingStatus, 'ready');
  assert.deepEqual(events, ['verify:legacy-recovery', 'embed:legacy-recovery:0', 'search:legacy-recovery']);
});
