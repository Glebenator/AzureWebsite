'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicationProgress, elapsedLabel } = require('../services/submission-publication-progress');

function record(status, publication = {}, extra = {}) {
  return {
    status,
    updatedAt: '2026-08-04T12:00:00.000Z',
    failureCode: null,
    publication,
    ...extra
  };
}

test('published Markdown and incomplete AI indexing are surfaced as separate states', () => {
  const progress = createPublicationProgress(record('published', {
    status: 'published',
    publicWritten: true,
    indexingStatus: 'indexing',
    indexed: false,
    embeddingCompleted: 8,
    embeddingTotal: 22,
    indexingStartedAt: '2026-08-04T12:00:00.000Z',
    substage: 'embedding'
  }), Date.parse('2026-08-04T12:02:00.000Z'));

  assert.equal(progress.publicationLabel, 'Published');
  assert.equal(progress.aiLabel, 'Embedding 8 of 22 sections');
  assert.equal(progress.publicAvailable, true);
  assert.equal(progress.aiReady, false);
  assert.equal(progress.active, true);
  assert.deepEqual(progress.checkpoints.map((item) => item.status), ['complete', 'complete', 'active', 'pending']);
  assert.match(progress.detail, /2m elapsed/);
});

test('verified Search completion is the only AI-ready state', () => {
  const ready = createPublicationProgress(record('published', {
    status: 'published', publicWritten: true, indexingStatus: 'ready', indexed: true
  }));
  const partial = createPublicationProgress(record('published', {
    status: 'published', publicWritten: true, indexingStatus: 'ready', indexed: false
  }));

  assert.equal(ready.summary, 'Published · AI ready');
  assert.equal(ready.aiReady, true);
  assert.equal(partial.aiReady, false);
  assert.notEqual(partial.aiLabel, 'AI ready');
});

test('index failure stays visibly published and retryable without raw error detail', () => {
  const progress = createPublicationProgress(record('published', {
    status: 'published',
    publicWritten: true,
    indexingStatus: 'failed',
    indexingFailureCode: 'search_http_503',
    indexed: false
  }));

  assert.equal(progress.summary, 'Published · AI indexing failed');
  assert.equal(progress.publicAvailable, true);
  assert.equal(progress.requiresAction, true);
  assert.doesNotMatch(JSON.stringify(progress), /search_http_503/);
});

test('public write recovery is distinct from embedding and Search work', () => {
  const progress = createPublicationProgress(record('publishing', {
    status: 'failed', indexingStatus: 'pending', publicWritten: false
  }, { failureCode: 'public_write_failed' }));

  assert.equal(progress.publicationLabel, 'Publication failed');
  assert.equal(progress.publicAvailable, false);
  assert.equal(progress.requiresAction, true);
  assert.equal(progress.active, false);
  assert.equal(progress.checkpoints[0].status, 'failed');
});

test('elapsed labels remain bounded and human readable', () => {
  const now = Date.parse('2026-08-04T14:02:03.000Z');
  assert.equal(elapsedLabel('2026-08-04T14:01:58.000Z', now), '5s elapsed');
  assert.equal(elapsedLabel('2026-08-04T13:58:00.000Z', now), '4m elapsed');
  assert.equal(elapsedLabel('2026-08-04T12:00:00.000Z', now), '2h 2m elapsed');
  assert.equal(elapsedLabel('not-a-date', now), '');
});
