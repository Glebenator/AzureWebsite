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

function workflow(repository, events) {
  return createPublicationCoordinator({
    repository,
    publicStore: {
      async write(payload) { events.push(`public:${payload.slug}`); return { etag: 'etag' }; },
      async remove() {}
    },
    searchIndex: {
      async prepare(payload) { events.push(`embed:${payload.slug}`); return { vectors: true }; },
      async commit(payload) { events.push(`search:${payload.slug}`); return { version: 'index' }; },
      async remove() {}
    }
  });
}

test('enqueue persists embedding pending before background work begins', async () => {
  const repository = createInMemorySubmissionRepository();
  const record = await ready(repository);
  const events = [];
  let scheduled;
  const worker = createPublicationWorker({
    publication: workflow(repository, events),
    repository,
    log() {},
    schedule(callback) { scheduled = callback; }
  });

  const queued = await worker.enqueue(record.id);
  assert.equal(queued.status, 'embedding_pending');
  assert.equal((await repository.get(record.id)).status, 'embedding_pending');
  assert.deepEqual(events, []);

  scheduled();
  await worker.waitForIdle();
  assert.equal((await repository.get(record.id)).status, 'published');
  assert.deepEqual(events, ['embed:queued-note', 'public:queued-note', 'search:queued-note']);
});

test('startup resumes a durable embedding checkpoint', async () => {
  const repository = createInMemorySubmissionRepository();
  const record = await ready(repository, 'Recovered note');
  await repository.transition(record.id, 'embedding_pending');
  await repository.transition(record.id, 'embedding');
  const events = [];
  const worker = createPublicationWorker({
    publication: workflow(repository, events),
    repository,
    log() {}
  });

  await worker.start();
  await worker.waitForIdle();
  assert.equal((await repository.get(record.id)).status, 'published');
  assert.deepEqual(events, ['embed:recovered-note', 'public:recovered-note', 'search:recovered-note']);
});
