'use strict';

const { isDeepStrictEqual } = require('node:util');
const {
  CAPTURE_SCHEMA_VERSION,
  ResearchLabReplayError
} = require('./research-lab-diagnostics');
const {
  createDeepResearchHarness,
  normalizeRequestedModel,
  normalizeResearchQuery
} = require('./deep-research-harness');

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dependencyKind(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'en.wikipedia.org' && parsed.pathname === '/w/api.php') {
    if (parsed.searchParams.get('list') === 'search') return 'wikipedia_search';
    if (parsed.searchParams.get('prop') === 'extracts') return 'wikipedia_read';
  }
  if (parsed.hostname === 'openrouter.ai' && parsed.pathname === '/api/v1/chat/completions') {
    return 'model_completion';
  }
  return null;
}

function replaySummary(result) {
  return {
    outcome: 'completed',
    mode: result.mode,
    evidenceCount: result.evidenceCount,
    citationCount: Array.isArray(result.citations) ? result.citations.length : 0,
    answerLength: typeof result.answer === 'string' ? result.answer.length : 0,
    modelRequested: result.modelRequested,
    modelUsed: result.modelUsed,
    validation: result.validation
  };
}

function validateReplayCapture(capture, now = Date.now()) {
  const replay = capture && capture.replay;
  if (capture?.schemaVersion === CAPTURE_SCHEMA_VERSION && Number.isFinite(capture.expiresAt) && capture.expiresAt <= now) {
    throw new ResearchLabReplayError('expired_capture', 'The diagnostic capture has expired.');
  }
  if (
    capture?.schemaVersion !== CAPTURE_SCHEMA_VERSION
    || !ID_PATTERN.test(capture.requestId || '')
    || !ID_PATTERN.test(capture.runId || '')
    || !Number.isFinite(capture.expiresAt)
    || !replay
    || !normalizeResearchQuery(replay.input && replay.input.query)
    || !['quick', 'research'].includes(replay.input && replay.input.mode)
    || !normalizeRequestedModel(replay.input && replay.input.model)
    || !Array.isArray(replay.dependencies)
    || replay.dependencies.length < 1
    || replay.dependencies.length > 4
    || !replay.expected
  ) {
    throw new ResearchLabReplayError('invalid_capture', 'The diagnostic capture cannot be replayed.');
  }
  for (const dependency of replay.dependencies) {
    const responseKindValid = dependency.responseKind === undefined
      || (dependency.kind === 'model_completion' && dependency.responseKind === 'invalid_json');
    if (
      dependency.requestId !== capture.requestId
      || dependency.runId !== capture.runId
      || !['wikipedia_search', 'wikipedia_read', 'model_completion'].includes(dependency.kind)
      || !responseKindValid
      || !Number.isInteger(dependency.status)
      || dependency.status < 100
      || dependency.status > 599
    ) {
      throw new ResearchLabReplayError('run_binding_mismatch', 'A replay fixture is not bound to this run.');
    }
  }
  return replay;
}

async function replayResearchLabCapture(capture, options = {}) {
  const nowValue = (options.now || Date.now)();
  const replay = validateReplayCapture(capture, nowValue);
  let index = 0;
  let dependencyError = null;
  const replayFetch = async function(url) {
    const kind = dependencyKind(url);
    const fixture = replay.dependencies[index];
    if (!kind || !fixture || fixture.kind !== kind) {
      dependencyError = new ResearchLabReplayError(
        'unexpected_dependency',
        'Replay attempted an unexpected dependency call.'
      );
      throw dependencyError;
    }
    index += 1;
    const body = fixture.responseKind === 'invalid_json'
      ? '{invalid-json'
      : JSON.stringify(fixture.body);
    return new Response(body, {
      status: fixture.status,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const disabledDiagnostics = Object.freeze({
    configurationIssue: null,
    startRun() { return null; }
  });
  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'offline-replay-placeholder',
    model: replay.input.model,
    fetch: replayFetch,
    diagnosticRecorder: disabledDiagnostics,
    now: () => nowValue
  });

  let actual;
  try {
    const result = await harness.run({
      query: replay.input.query,
      mode: replay.input.mode === 'quick' ? 'direct' : 'research',
      model: replay.input.model,
      requestId: capture.requestId,
      runId: capture.runId
    });
    actual = replaySummary(result);
  } catch (error) {
    if (dependencyError) throw dependencyError;
    actual = {
      outcome: 'failed',
      failureCategory: error && error.code === 'invalid_model_response'
        ? 'invalid_response'
        : 'internal'
    };
  }

  if (index !== replay.dependencies.length) {
    throw new ResearchLabReplayError('unused_dependency', 'Replay did not consume every recorded dependency.');
  }
  if (!isDeepStrictEqual(actual, replay.expected)) {
    throw new ResearchLabReplayError('replay_divergence', 'Replay outcome diverged from the recorded summary.');
  }
  return {
    requestId: capture.requestId,
    runId: capture.runId,
    category: capture.category,
    dependencyCount: index,
    outcome: actual.outcome,
    validation: actual.validation
  };
}

module.exports = {
  replayResearchLabCapture,
  validateReplayCapture
};
