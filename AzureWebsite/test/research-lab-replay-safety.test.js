'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CAPTURE_SCHEMA_VERSION,
  readResearchLabDiagnosticCapture
} = require('../services/research-lab-diagnostics');
const {
  replayResearchLabCapture,
  validateReplayCapture
} = require('../services/research-lab-replay');

const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = 10_000;
const ANSWER = 'Microgrids balance solar batteries across electrical feeders [1].';

function replayCapture(overrides = {}) {
  const validation = {
    citationSyntax: 'valid',
    referenceValidity: 'valid',
    topicAlignment: 'mismatch',
    semanticSupport: 'unsupported',
    reasonCodes: ['topic_mismatch'],
    citationTokenCount: 1,
    validReferenceCount: 1
  };
  const capture = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    capturedAt: NOW - 100,
    expiresAt: NOW + 60_000,
    category: 'topic_mismatch',
    requestId: REQUEST_ID,
    runId: RUN_ID,
    mode: 'research',
    model: 'openrouter/free',
    replay: {
      input: {
        query: 'How does desalination remove salt from seawater?',
        mode: 'research',
        model: 'openrouter/free'
      },
      dependencies: [
        {
          kind: 'wikipedia_search',
          requestId: REQUEST_ID,
          runId: RUN_ID,
          status: 200,
          body: { query: { search: [{ title: 'Desalination' }] } }
        },
        {
          kind: 'wikipedia_read',
          requestId: REQUEST_ID,
          runId: RUN_ID,
          status: 200,
          body: {
            query: {
              pages: {
                1: {
                  title: 'Desalination',
                  extract: 'Desalination removes salt from seawater by membrane filtration.'
                }
              }
            }
          }
        },
        {
          kind: 'model_completion',
          requestId: REQUEST_ID,
          runId: RUN_ID,
          status: 200,
          body: {
            model: 'example/replay:free',
            choices: [{ message: { content: ANSWER } }]
          }
        }
      ],
      expected: {
        outcome: 'completed',
        mode: 'research',
        evidenceCount: 1,
        citationCount: 1,
        answerLength: ANSWER.length,
        modelRequested: 'openrouter/free',
        modelUsed: 'example/replay:free',
        validation
      }
    }
  };
  return {
    ...capture,
    ...overrides,
    replay: overrides.replay === undefined ? capture.replay : overrides.replay
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.code, code);
    return true;
  });
}

test('deterministic replay succeeds entirely from run-bound fixtures without live network access', async () => {
  const originalFetch = global.fetch;
  let liveNetworkCalls = 0;
  global.fetch = async () => {
    liveNetworkCalls += 1;
    throw new Error('Live network access is forbidden during replay.');
  };
  try {
    const result = await replayResearchLabCapture(replayCapture(), { now: () => NOW });
    assert.deepEqual(result, {
      requestId: REQUEST_ID,
      runId: RUN_ID,
      category: 'topic_mismatch',
      dependencyCount: 3,
      outcome: 'completed',
      validation: {
        citationSyntax: 'valid',
        referenceValidity: 'valid',
        topicAlignment: 'mismatch',
        semanticSupport: 'unsupported',
        reasonCodes: ['topic_mismatch'],
        citationTokenCount: 1,
        validReferenceCount: 1
      }
    });
    assert.equal(liveNetworkCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('invalid model JSON replays from a content-free failure marker', async () => {
  const capture = replayCapture();
  capture.category = 'invalid_model_response';
  capture.replay.dependencies[2] = {
    kind: 'model_completion',
    requestId: REQUEST_ID,
    runId: RUN_ID,
    status: 200,
    responseKind: 'invalid_json'
  };
  capture.replay.expected = {
    outcome: 'failed',
    failureCategory: 'invalid_response'
  };

  const result = await replayResearchLabCapture(capture, { now: () => NOW });
  assert.deepEqual(result, {
    requestId: REQUEST_ID,
    runId: RUN_ID,
    category: 'invalid_model_response',
    dependencyCount: 3,
    outcome: 'failed',
    validation: undefined
  });
});

test('replay rejects an expired capture with an explicit expiry category', () => {
  const capture = replayCapture({ expiresAt: NOW });
  assert.throws(
    () => validateReplayCapture(capture, NOW),
    (error) => error && error.code === 'expired_capture'
  );
});

test('capture reader converts corrupt JSON into a bounded invalid_capture error', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'research-lab-replay-corrupt-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'corrupt.json');
  await fs.writeFile(filename, '{not-json', { mode: 0o600 });

  await rejectsWithCode(
    readResearchLabDiagnosticCapture(filename, { now: () => NOW }),
    'invalid_capture'
  );
});

test('capture reader rejects oversized files before parsing their contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'research-lab-replay-oversized-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'oversized.json');
  await fs.writeFile(filename, 'x'.repeat(2_000), { mode: 0o600 });

  await rejectsWithCode(
    readResearchLabDiagnosticCapture(filename, { maxBytes: 1024, now: () => NOW }),
    'invalid_capture'
  );
});

test('replay rejects dependency fixtures bound to another run', async () => {
  const capture = replayCapture();
  capture.replay.dependencies[1].runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await rejectsWithCode(
    replayResearchLabCapture(capture, { now: () => NOW }),
    'run_binding_mismatch'
  );
});

test('replay reports an unexpected dependency sequence without falling back to live calls', async () => {
  const capture = replayCapture();
  [capture.replay.dependencies[0], capture.replay.dependencies[2]] = [
    capture.replay.dependencies[2],
    capture.replay.dependencies[0]
  ];

  await rejectsWithCode(
    replayResearchLabCapture(capture, { now: () => NOW }),
    'unexpected_dependency'
  );
});

test('replay reports deterministic divergence after consuming all fixtures', async () => {
  const capture = replayCapture();
  capture.replay.expected = {
    ...capture.replay.expected,
    answerLength: capture.replay.expected.answerLength + 1
  };

  await rejectsWithCode(
    replayResearchLabCapture(capture, { now: () => NOW }),
    'replay_divergence'
  );
});
