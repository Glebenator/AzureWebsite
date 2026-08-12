'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  correlationFromResponse,
  evidencePresentation,
  eventMatchesCorrelation,
  formatElapsed,
  normalizeModelCatalog,
  requestedMode,
  resultPresentation,
  shouldSubmitFromKey
} = require('../public/javascripts/research-lab');

test('research lab composer sends on Enter and preserves Shift+Enter for new lines', () => {
  assert.equal(shouldSubmitFromKey({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitFromKey({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitFromKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitFromKey({ key: 'a', shiftKey: false, isComposing: false }), false);
});

test('research lab formats live elapsed time and sends an explicit response mode', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(65_999), '01:05');
  assert.equal(requestedMode('direct'), 'direct');
  assert.equal(requestedMode('research'), 'research');
  assert.equal(requestedMode('unexpected'), 'research');
});

test('research lab accepts only free model identifiers from the server catalog', () => {
  const catalog = normalizeModelCatalog({
    defaultModel: 'example/current:free',
    models: [
      { id: 'openrouter/free', name: 'Free Models Router', contextLength: 200000 },
      { id: 'example/current:free', name: 'Current Free', contextLength: 65536 },
      { id: 'example/paid', name: 'Paid' },
      { id: 'not a slug', name: 'Invalid' }
    ]
  }, 'openrouter/free');

  assert.equal(catalog.defaultModel, 'example/current:free');
  assert.deepEqual(catalog.models.map((item) => item.id), [
    'openrouter/free',
    'example/current:free'
  ]);
  assert.equal(catalog.models[1].contextLength, 65536);

  const staleDefault = normalizeModelCatalog({
    defaultModel: 'example/removed:free',
    models: [{ id: 'example/current:free', name: 'Current Free' }]
  }, 'example/removed:free');
  assert.equal(staleDefault.defaultModel, 'openrouter/free');
  assert.deepEqual(staleDefault.models.map((item) => item.id), [
    'openrouter/free',
    'example/current:free'
  ]);
});

test('research lab presents direct, reference-valid, unsupported, and unknown output without false reassurance', () => {
  const direct = resultPresentation({ mode: 'quick', evidenceCount: 0 });
  const referenceValid = resultPresentation({
    mode: 'research',
    evidenceCount: 3,
    validation: {
      citationSyntax: 'valid',
      referenceValidity: 'valid',
      topicAlignment: 'aligned',
      semanticSupport: 'not_assessed'
    }
  });
  const unsupported = resultPresentation({
    mode: 'research',
    evidenceCount: 1,
    validation: {
      citationSyntax: 'valid',
      referenceValidity: 'valid',
      topicAlignment: 'mismatch',
      semanticSupport: 'unsupported'
    }
  });
  const unknown = resultPresentation({ mode: 'research', evidenceCount: 2 });

  assert.deepEqual(direct, {
    label: 'Direct answer',
    mode: 'Direct answer',
    note: 'Direct answer. No external sources were searched.',
    summary: 'Direct answer · no sources',
    unverified: false
  });
  assert.match(referenceValid.summary, /references resolve · support not assessed/);
  assert.match(referenceValid.note, /not independently assessed/);
  assert.equal(referenceValid.unverified, true);
  assert.equal(unsupported.unverified, true);
  assert.match(unsupported.note, /not supported/);
  assert.equal(unknown.unverified, true);
  assert.match(unknown.note, /Treat this output as unsupported/);
});

test('research lab accepts only matching UUID correlation headers and bound events', () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const response = {
    headers: {
      get(name) {
        return name === 'X-Request-Id' ? requestId : name === 'X-Research-Run-Id' ? runId : null;
      }
    }
  };
  const correlation = correlationFromResponse(response);
  assert.deepEqual(correlation, { requestId, runId });
  assert.equal(eventMatchesCorrelation({ requestId, runId }, correlation), true);
  assert.equal(eventMatchesCorrelation({ requestId, runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, correlation), false);
  assert.equal(eventMatchesCorrelation({ requestId }, correlation), false);
  assert.equal(correlationFromResponse({ headers: { get: () => 'not-a-uuid' } }), null);
});

test('evidence drawer view model is bounded and exposes exact source metadata', () => {
  const citations = [{
    number: 1,
    title: 'Emergency power',
    url: 'https://en.wikipedia.org/wiki/Emergency_power_system',
    excerpt: 'An exact retrieved excerpt.',
    source: 'English Wikipedia',
    sourceType: 'Introductory extract'
  }];
  const view = evidencePresentation(citations, 99);

  assert.equal(view.index, 0);
  assert.equal(view.position, 'Source 1 of 1');
  assert.equal(view.metadata, 'English Wikipedia · Introductory extract');
  assert.equal(view.item.excerpt, 'An exact retrieved excerpt.');
  assert.equal(view.hasPrevious, false);
  assert.equal(view.hasNext, false);
  assert.equal(evidencePresentation([], 0), null);
});
