'use strict';

const crypto = require('node:crypto');
const express = require('express');
const {
  DeepResearchHarnessError,
  MAX_QUERY_LENGTH,
  classifyQueryMode,
  normalizeResearchQuery,
  normalizeRequestedMode,
  normalizeRequestedModel
} = require('../services/deep-research-harness');
const { createResearchRateLimiter } = require('../services/research-rate-limiter');
const {
  createResearchLabObserver,
  failureCategory
} = require('../services/research-lab-observability');

const RUN_CONTEXT = Symbol('researchLabRunContext');
const RUN_BODY_LIMIT = '2kb';

const PUBLIC_RUN_ERRORS = Object.freeze({
  free_model_unavailable: { status: 400, message: 'That free OpenRouter model is no longer available. Reload the model list and choose another.' },
  invalid_model: { status: 400, message: 'Choose the free router or a currently available :free model.' },
  invalid_model_response: { status: 502, message: 'OpenRouter returned an invalid response.' },
  invalid_query: { status: 400, message: `Enter a research question between 3 and ${MAX_QUERY_LENGTH} characters.` },
  model_catalog_invalid_response: { status: 503, message: 'OpenRouter free models could not be loaded.' },
  model_catalog_network: { status: 503, message: 'OpenRouter free models could not be loaded.' },
  model_catalog_timeout: { status: 503, message: 'OpenRouter free models took too long to load.' },
  model_catalog_unavailable: { status: 503, message: 'OpenRouter free models could not be loaded.' },
  model_network: { status: 502, message: 'OpenRouter could not be reached.' },
  model_timeout: { status: 504, message: 'OpenRouter took too long to respond.' },
  model_unavailable: { status: 502, message: 'OpenRouter could not complete the synthesis.' },
  no_evidence: { status: 422, message: 'The bounded search found no readable evidence for this question.' },
  openrouter_authentication_failed: { status: 503, message: 'OpenRouter rejected the server configuration.' },
  openrouter_rate_limited: { status: 429, message: 'The selected OpenRouter model is currently rate limited.' },
  research_harness_unavailable: { status: 503, message: 'The experimental research harness is unavailable.' },
  wikipedia_read_invalid_response: { status: 502, message: 'Wikipedia returned invalid article data.' },
  wikipedia_read_network: { status: 502, message: 'Wikipedia article data could not be reached.' },
  wikipedia_read_timeout: { status: 504, message: 'Wikipedia article reading took too long.' },
  wikipedia_read_unavailable: { status: 502, message: 'Wikipedia article data was unavailable.' },
  wikipedia_search_invalid_response: { status: 502, message: 'Wikipedia returned invalid search data.' },
  wikipedia_search_network: { status: 502, message: 'Wikipedia search could not be reached.' },
  wikipedia_search_timeout: { status: 504, message: 'Wikipedia search took too long.' },
  wikipedia_search_unavailable: { status: 502, message: 'Wikipedia search was unavailable.' }
});

function sameOriginRequest(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function jsonError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function safeConfigurationIssue(harness) {
  const issue = typeof harness.configurationIssue === 'function'
    ? harness.configurationIssue()
    : null;
  if (typeof issue !== 'string') return null;
  if (/disabled/i.test(issue)) return 'The experimental research harness is disabled.';
  if (/OPENROUTER_API_KEY/i.test(issue)) return 'The server-side OpenRouter credential is not configured.';
  if (/OPENROUTER_RESEARCH_MODEL/i.test(issue)) return 'The configured OpenRouter research model is invalid.';
  return 'The experimental research harness is unavailable.';
}

function publicRunError(error) {
  if (error instanceof DeepResearchHarnessError && PUBLIC_RUN_ERRORS[error.code]) {
    return { code: error.code, ...PUBLIC_RUN_ERRORS[error.code] };
  }
  return {
    code: 'research_run_failed',
    message: 'The experimental research run could not be completed.',
    status: 500
  };
}

function createRunGate() {
  let activeRunId = null;
  return {
    activeRunId() { return activeRunId; },
    tryAcquire(runId) {
      if (activeRunId) return null;
      activeRunId = runId;
      let released = false;
      return {
        release() {
          if (released || activeRunId !== runId) return false;
          released = true;
          activeRunId = null;
          return true;
        }
      };
    }
  };
}

function createResearchLabRouter(harness, options = {}) {
  const router = express.Router();
  const checkRateLimit = createResearchRateLimiter();
  const runGate = options.runGate || createRunGate();

  router.get('/', function(req, res) {
    res.set('Cache-Control', 'no-store');
    res.render('research-lab/index', {
      title: 'Deep Research Harness — Experimental',
      description: 'A bounded experimental research loop with visible progress, correlation, and qualified citations.',
      available: harness.isAvailable(),
      configurationIssue: safeConfigurationIssue(harness),
      model: harness.model
    });
  });

  router.get('/models', async function(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!harness.isAvailable()) {
      return jsonError(res, 503, 'research_harness_unavailable', safeConfigurationIssue(harness));
    }
    if (typeof harness.listFreeModels !== 'function') {
      return jsonError(res, 503, 'model_catalog_unavailable', 'OpenRouter free models could not be loaded.');
    }
    try {
      const models = await harness.listFreeModels();
      return res.json({ defaultModel: harness.model, models });
    } catch (error) {
      const safeError = publicRunError(error);
      return jsonError(res, safeError.status, safeError.code, safeError.message);
    }
  });

  function initializeRun(req, res, next) {
    const requestId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const observe = createResearchLabObserver(
      { requestId, runId },
      options.telemetryWrite
    );
    req[RUN_CONTEXT] = { requestId, runId, startedAt, observe };
    res.set({
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
      'X-Research-Run-Id': runId
    });
    observe({ stage: 'request', status: 'started' });
    next();
  }

  function rejectInvalidJson(error, req, res, next) {
    if (!error) return next();
    const oversized = error.type === 'entity.too.large' || error.status === 413;
    const malformed = error instanceof SyntaxError && error.status === 400;
    if (!oversized && !malformed) return next(error);
    const context = req[RUN_CONTEXT];
    const status = oversized ? 413 : 400;
    const code = oversized ? 'request_body_too_large' : 'invalid_json';
    const message = oversized
      ? 'Send a smaller research request.'
      : 'Send a valid JSON research request.';
    context.observe({
      stage: 'request',
      status: 'failed',
      durationMs: Date.now() - context.startedAt,
      failureCategory: 'invalid_input',
      httpStatusClass: status
    });
    return res.status(status).json({
      error: { code, message },
      requestId: context.requestId,
      runId: context.runId
    });
  }

  router.post(
    '/runs',
    initializeRun,
    express.json({ limit: RUN_BODY_LIMIT, strict: true }),
    rejectInvalidJson,
    async function(req, res) {
    const { requestId, runId, startedAt, observe } = req[RUN_CONTEXT];
    let query;
    let requestMode;
    let resolvedMode;
    let selectedModel;
    let lease;
    let streamStartedAt = 0;
    let streamEventCount = 0;
    let streamByteCount = 0;
    let requestTerminal = false;

    function terminalRequest(status, detail = {}) {
      if (requestTerminal) return;
      requestTerminal = true;
      observe({
        stage: 'request',
        status,
        durationMs: Date.now() - startedAt,
        queryLength: query && query.length,
        mode: resolvedMode,
        modelRequested: selectedModel,
        ...detail
      });
    }

    function reject(status, code, message, category, telemetryStatus = 'failed') {
      terminalRequest(telemetryStatus, {
        failureCategory: category,
        httpStatusClass: status
      });
      return res.status(status).json({
        error: { code, message },
        requestId,
        runId
      });
    }

    if (!sameOriginRequest(req)) {
      return reject(
        403,
        'origin_rejected',
        'Start research runs from the experimental harness page.',
        'origin_rejected'
      );
    }
    if (!req.is('application/json')) {
      return reject(
        415,
        'content_type_required',
        'Send the research question as JSON.',
        'content_type'
      );
    }
    query = normalizeResearchQuery(req.body && req.body.query);
    if (!query) {
      return reject(
        400,
        'invalid_query',
        `Enter a research question between 3 and ${MAX_QUERY_LENGTH} characters.`,
        'invalid_input'
      );
    }
    requestMode = normalizeRequestedMode(req.body && req.body.mode);
    if (req.body && req.body.mode !== undefined && !requestMode) {
      return reject(400, 'invalid_mode', 'Choose direct answer or research mode.', 'invalid_input');
    }
    resolvedMode = classifyQueryMode(query, requestMode);
    const requestedModel = req.body && req.body.model === undefined
      ? harness.model
      : normalizeRequestedModel(req.body && req.body.model);
    if (!requestedModel) {
      return reject(
        400,
        'invalid_model',
        'Choose the free router or a currently available :free model.',
        'invalid_input'
      );
    }
    selectedModel = requestedModel;
    if (!harness.isAvailable()) {
      return reject(
        503,
        'research_harness_unavailable',
        'The experimental research harness is unavailable.',
        'configuration'
      );
    }
    const retryAfterSeconds = checkRateLimit(req.ip || req.socket.remoteAddress || 'unknown');
    if (retryAfterSeconds > 0) {
      res.set('Retry-After', String(retryAfterSeconds));
      return reject(
        429,
        'research_harness_rate_limited',
        'Please wait before starting another research run.',
        'rate_limited',
        'limited'
      );
    }
    lease = runGate.tryAcquire(runId);
    if (!lease) {
      return reject(
        429,
        'research_harness_busy',
        'One bounded research run is already active on this app process.',
        'concurrency_limited',
        'limited'
      );
    }

    const controller = new AbortController();
    function abortOnDisconnect() {
      if (!res.writableEnded) controller.abort();
    }
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);

    function emit(event) {
      if (res.writableEnded || res.destroyed) return false;
      const line = `${JSON.stringify({ ...event, requestId, runId })}\n`;
      const written = res.write(line);
      streamEventCount += 1;
      streamByteCount += Buffer.byteLength(line, 'utf8');
      return written;
    }

    try {
      if (typeof harness.resolveRequestedModel === 'function') {
        selectedModel = await harness.resolveRequestedModel(requestedModel, {
          signal: controller.signal,
          observe
        });
      }
      if (controller.signal.aborted) {
        terminalRequest('cancelled', { failureCategory: 'cancelled' });
        return undefined;
      }
      res.status(200);
      res.type('application/x-ndjson');
      res.set('X-Content-Type-Options', 'nosniff');
      res.flushHeaders();
      streamStartedAt = Date.now();
      observe({
        stage: 'streaming',
        status: 'started',
        mode: resolvedMode,
        modelRequested: selectedModel
      });
      await harness.run({
        query,
        mode: requestMode,
        model: selectedModel,
        requestId,
        runId,
        signal: controller.signal,
        emit,
        observe
      });
      emit({ type: 'done' });
      observe({
        stage: 'streaming',
        status: 'completed',
        durationMs: Date.now() - streamStartedAt,
        streamEventCount,
        streamByteCount,
        mode: resolvedMode,
        modelRequested: selectedModel
      });
      terminalRequest('completed', {
        httpStatusClass: 200,
        streamEventCount,
        streamByteCount
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (streamStartedAt) {
          observe({
            stage: 'streaming',
            status: 'cancelled',
            durationMs: Date.now() - streamStartedAt,
            streamEventCount,
            streamByteCount,
            failureCategory: 'cancelled'
          });
        }
        terminalRequest('cancelled', { failureCategory: 'cancelled' });
      } else if (res.headersSent) {
        const safeError = publicRunError(error);
        emit({ type: 'error', error: safeError });
        observe({
          stage: 'streaming',
          status: 'failed',
          durationMs: streamStartedAt ? Date.now() - streamStartedAt : undefined,
          streamEventCount,
          streamByteCount,
          failureCategory: failureCategory(error),
          httpStatusClass: res.statusCode
        });
        terminalRequest('failed', {
          failureCategory: failureCategory(error),
          httpStatusClass: res.statusCode
        });
      } else {
        const safeError = publicRunError(error);
        return reject(
          safeError.status,
          safeError.code,
          safeError.message,
          failureCategory(error)
        );
      }
    } finally {
      if (lease) lease.release();
      req.removeListener('aborted', abortOnDisconnect);
      res.removeListener('close', abortOnDisconnect);
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

module.exports = {
  createResearchLabRouter,
  createRunGate,
  publicRunError,
  safeConfigurationIssue,
  sameOriginRequest
};
