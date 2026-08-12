'use strict';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;
const STAGES = new Set([
  'request',
  'model_catalog',
  'wikipedia_search',
  'wikipedia_read',
  'prompt_construction',
  'model_request',
  'model_response',
  'validation',
  'streaming',
  'diagnostic_capture'
]);
const STATUSES = new Set(['started', 'completed', 'failed', 'limited', 'cancelled', 'skipped']);
const MODES = new Set(['quick', 'research']);
const CITATION_SYNTAX = new Set(['valid', 'missing', 'malformed', 'not_applicable']);
const REFERENCE_VALIDITY = new Set(['valid', 'incomplete', 'out_of_range', 'not_applicable']);
const TOPIC_ALIGNMENT = new Set(['aligned', 'mismatch', 'indeterminate', 'not_applicable']);
const SEMANTIC_SUPPORT = new Set(['unsupported', 'not_assessed', 'not_applicable']);
const FAILURE_CATEGORIES = new Set([
  'cancelled',
  'concurrency_limited',
  'configuration',
  'content_type',
  'diagnostic_rejected',
  'internal',
  'invalid_input',
  'invalid_response',
  'no_evidence',
  'origin_rejected',
  'rate_limited',
  'timeout',
  'upstream_authentication',
  'upstream_network',
  'upstream_rate_limited',
  'upstream_response',
  'validation_failed'
]);

const ERROR_CATEGORY_BY_CODE = Object.freeze({
  free_model_unavailable: 'configuration',
  invalid_mode: 'invalid_input',
  invalid_model: 'invalid_input',
  invalid_model_response: 'invalid_response',
  invalid_query: 'invalid_input',
  model_catalog_invalid_response: 'invalid_response',
  model_catalog_network: 'upstream_network',
  model_catalog_timeout: 'timeout',
  model_catalog_unavailable: 'upstream_response',
  model_network: 'upstream_network',
  model_timeout: 'timeout',
  model_unavailable: 'upstream_response',
  no_evidence: 'no_evidence',
  openrouter_authentication_failed: 'upstream_authentication',
  openrouter_rate_limited: 'upstream_rate_limited',
  research_harness_unavailable: 'configuration',
  research_run_failed: 'internal',
  wikipedia_read_invalid_response: 'invalid_response',
  wikipedia_read_network: 'upstream_network',
  wikipedia_read_timeout: 'timeout',
  wikipedia_read_unavailable: 'upstream_response',
  wikipedia_search_invalid_response: 'invalid_response',
  wikipedia_search_network: 'upstream_network',
  wikipedia_search_timeout: 'timeout',
  wikipedia_search_unavailable: 'upstream_response'
});

function safeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : undefined;
}

function safeDuration(value) {
  return safeInteger(value, 24 * 60 * 60 * 1000);
}

function safeModel(value) {
  if (typeof value !== 'string') return undefined;
  const model = value.trim().slice(0, 160);
  return MODEL_PATTERN.test(model) ? model : undefined;
}

function safeStatusClass(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
    return `${Math.floor(value / 100)}xx`;
  }
  return ['2xx', '3xx', '4xx', '5xx'].includes(value) ? value : undefined;
}

function knownValue(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function failureCategory(errorOrCode, fallback = 'internal') {
  const code = typeof errorOrCode === 'string'
    ? errorOrCode
    : errorOrCode && typeof errorOrCode.code === 'string'
      ? errorOrCode.code
      : '';
  const category = ERROR_CATEGORY_BY_CODE[code];
  return category || (FAILURE_CATEGORIES.has(fallback) ? fallback : 'internal');
}

function safeResearchLabTelemetry(detail = {}) {
  const event = {
    event: 'research_lab_stage',
    requestId: safeId(detail.requestId),
    runId: safeId(detail.runId),
    stage: knownValue(detail.stage, STAGES),
    status: knownValue(detail.status, STATUSES),
    mode: knownValue(detail.mode, MODES),
    failureCategory: knownValue(detail.failureCategory, FAILURE_CATEGORIES),
    durationMs: safeDuration(detail.durationMs),
    queryLength: safeInteger(detail.queryLength, 500),
    promptLength: safeInteger(detail.promptLength, 50000),
    responseLength: safeInteger(detail.responseLength, 100000),
    resultCount: safeInteger(detail.resultCount, 1000),
    evidenceCount: safeInteger(detail.evidenceCount, 100),
    citationTokenCount: safeInteger(detail.citationTokenCount, 1000),
    validReferenceCount: safeInteger(detail.validReferenceCount, 1000),
    streamEventCount: safeInteger(detail.streamEventCount, 10000),
    streamByteCount: safeInteger(detail.streamByteCount, 10 * 1024 * 1024),
    promptTokenCount: safeInteger(detail.promptTokenCount, 10000000),
    completionTokenCount: safeInteger(detail.completionTokenCount, 10000000),
    totalTokenCount: safeInteger(detail.totalTokenCount, 10000000),
    modelRequested: safeModel(detail.modelRequested),
    modelUsed: safeModel(detail.modelUsed),
    httpStatusClass: safeStatusClass(detail.httpStatusClass),
    citationSyntax: knownValue(detail.citationSyntax, CITATION_SYNTAX),
    referenceValidity: knownValue(detail.referenceValidity, REFERENCE_VALIDITY),
    topicAlignment: knownValue(detail.topicAlignment, TOPIC_ALIGNMENT),
    semanticSupport: knownValue(detail.semanticSupport, SEMANTIC_SUPPORT)
  };

  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

function createResearchLabObserver(context = {}, write) {
  const output = typeof write === 'function' ? write : (line) => console.info(line);
  const requestId = safeId(context.requestId);
  const runId = safeId(context.runId);
  return function observe(detail) {
    try {
      const event = safeResearchLabTelemetry({ ...detail, requestId, runId });
      if (!event.requestId || !event.runId || !event.stage || !event.status) return;
      output(JSON.stringify(event));
    } catch {
      // Telemetry must never affect the research path.
    }
  };
}

module.exports = {
  createResearchLabObserver,
  failureCategory,
  safeResearchLabTelemetry
};
