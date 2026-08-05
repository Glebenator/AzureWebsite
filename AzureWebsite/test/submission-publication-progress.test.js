'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicationProgress } = require('../services/submission-publication-progress');

function record(status, publication = {}, overrides = {}) {
  return {
    status,
    updatedAt: '2026-08-04T12:00:00.000Z',
    publication,
    ...overrides
  };
}

test('publication progress reports exact embedding counts and bounded operational context', () => {
  const progress = createPublicationProgress(record('embedding', {
    attempt: 2,
    embeddingCompleted: 8,
    embeddingStartedAt: '2026-08-04T12:00:00.000Z',
    embeddingTotal: 22,
    lastProgressAt: '2026-08-04T12:03:00.000Z',
    substage: 'embedding'
  }), Date.parse('2026-08-04T12:04:30.000Z'));

  assert.equal(progress.summary, 'Embedding 8 of 22 sections');
  assert.equal(progress.detail, 'Attempt 2 · 4m elapsed');
  assert.equal(progress.completed, 8);
  assert.equal(progress.total, 22);
  assert.equal(progress.checkpoints[0].status, 'active');
  assert.equal(JSON.stringify(progress).includes('content'), false);
});

test('publishing progress derives the active operation from persisted checkpoints', () => {
  const writing = createPublicationProgress(record('publishing', {
    embeddingsReadyAt: '2026-08-04T12:01:00.000Z',
    publicWritten: false,
    indexed: false,
    substage: 'public_write'
  }));
  assert.equal(writing.summary, 'Writing the public Markdown note');

  const search = createPublicationProgress(record('publishing', {
    embeddingsReadyAt: '2026-08-04T12:01:00.000Z',
    publicWritten: true,
    indexed: false,
    substage: 'search_commit'
  }));
  assert.equal(search.summary, 'Updating and verifying Search');
  assert.equal(search.checkpoints[1].status, 'complete');
  assert.equal(search.checkpoints[2].status, 'active');

  const activating = createPublicationProgress(record('publishing', {
    publicWritten: true,
    indexed: true,
    substage: 'activating'
  }));
  assert.equal(activating.summary, 'Activating the published note');
  assert.equal(activating.checkpoints[3].status, 'active');
});

test('cleanup and failure states remain actionable without exposing raw causes', () => {
  const cleanup = createPublicationProgress(record('publishing', {
    substage: 'cleanup'
  }, { failureCode: 'cleanup_required' }));
  assert.equal(cleanup.summary, 'Cleanup requires a retry');
  assert.equal(cleanup.active, false);
  assert.equal(cleanup.requiresAction, true);

  const failed = createPublicationProgress(record('failed', {
    embeddingCompleted: 4,
    embeddingTotal: 12,
    substage: 'failed'
  }, { failureCode: 'embedding_failed' }));
  assert.equal(failed.summary, 'Embedding stopped safely');
  assert.equal(failed.checkpoints[0].status, 'failed');

  const recovery = createPublicationProgress(record('publishing', {
    embeddingCompleted: 2,
    embeddingTotal: 10,
    substage: 'embedding_recovery'
  }));
  assert.equal(recovery.summary, 'Embedding 2 of 10 sections');
  assert.equal(recovery.checkpoints[0].status, 'active');
});
