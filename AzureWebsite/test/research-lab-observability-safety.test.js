'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createResearchLabObserver,
  failureCategory,
  safeResearchLabTelemetry
} = require('../services/research-lab-observability');

const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('research-lab telemetry is an allowlist that omits content, credentials, and arbitrary fields', () => {
  const secret = 'telemetry-secret-value';
  const event = safeResearchLabTelemetry({
    requestId: REQUEST_ID,
    runId: RUN_ID,
    stage: 'model_response',
    status: 'completed',
    mode: 'research',
    durationMs: 42,
    responseLength: 91,
    resultCount: 3,
    modelRequested: 'openrouter/free',
    modelUsed: 'example/replay:free',
    httpStatusClass: 200,
    citationSyntax: 'valid',
    referenceValidity: 'valid',
    topicAlignment: 'aligned',
    semanticSupport: 'not_assessed',
    prompt: `full prompt ${secret}`,
    answer: `full answer ${secret}`,
    query: `private query ${secret}`,
    authorization: `Bearer ${secret}`,
    cookie: `session=${secret}`,
    apiKey: secret,
    headers: { Authorization: `Bearer ${secret}` },
    arbitrary: { nested: secret }
  });

  assert.deepEqual(event, {
    event: 'research_lab_stage',
    requestId: REQUEST_ID,
    runId: RUN_ID,
    stage: 'model_response',
    status: 'completed',
    mode: 'research',
    durationMs: 42,
    responseLength: 91,
    resultCount: 3,
    modelRequested: 'openrouter/free',
    modelUsed: 'example/replay:free',
    httpStatusClass: '2xx',
    citationSyntax: 'valid',
    referenceValidity: 'valid',
    topicAlignment: 'aligned',
    semanticSupport: 'not_assessed'
  });
  assert.doesNotMatch(JSON.stringify(event), new RegExp(secret));
  assert.equal(Object.hasOwn(event, 'prompt'), false);
  assert.equal(Object.hasOwn(event, 'answer'), false);
  assert.equal(Object.hasOwn(event, 'query'), false);
  assert.equal(Object.hasOwn(event, 'headers'), false);
});

test('research-lab observer binds trusted correlation and drops malformed events without logging secrets', () => {
  const lines = [];
  const observe = createResearchLabObserver(
    { requestId: REQUEST_ID.toUpperCase(), runId: RUN_ID.toUpperCase() },
    (line) => lines.push(line)
  );

  observe({
    requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    stage: 'request',
    status: 'started',
    queryLength: 12,
    prompt: 'never log this prompt',
    authorization: 'Bearer never-log-this-token'
  });
  observe({ stage: 'made_up_stage', status: 'completed', apiKey: 'never-log-this-key' });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'research_lab_stage',
    requestId: REQUEST_ID,
    runId: RUN_ID,
    stage: 'request',
    status: 'started',
    queryLength: 12
  });
  assert.doesNotMatch(lines.join('\n'), /never-log-this/i);
});

test('failure classification is stable, bounded, and never derived from an error message', () => {
  const cases = [
    ['invalid_query', 'invalid_input'],
    ['invalid_model', 'invalid_input'],
    ['research_harness_unavailable', 'configuration'],
    ['invalid_model_response', 'invalid_response'],
    ['wikipedia_search_invalid_response', 'invalid_response'],
    ['wikipedia_read_network', 'upstream_network'],
    ['model_network', 'upstream_network'],
    ['model_timeout', 'timeout'],
    ['openrouter_authentication_failed', 'upstream_authentication'],
    ['openrouter_rate_limited', 'upstream_rate_limited'],
    ['model_unavailable', 'upstream_response'],
    ['no_evidence', 'no_evidence'],
    ['research_run_failed', 'internal']
  ];

  for (const [code, expected] of cases) {
    assert.equal(failureCategory(code), expected, code);
    assert.equal(failureCategory({ code, message: 'Bearer private-secret-value' }), expected, code);
  }
  assert.equal(failureCategory({ code: 'novel_secret_named_error', message: 'private-secret-value' }), 'internal');
  assert.equal(failureCategory('unknown', 'cancelled'), 'cancelled');
  assert.equal(failureCategory('unknown', 'not-a-category'), 'internal');
});
