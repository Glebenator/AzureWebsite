'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { ResearchStorageError } = require('../services/research-repository');
const {
  MAX_QUESTION_LENGTH,
  ResearchAssistantInvalidResponseError,
  ResearchAssistantUnavailableError,
  normalizeQuestion
} = require('../services/research-assistant');
const { createResearchRateLimiter } = require('../services/research-rate-limiter');
const { TOPIC_LABELS } = require('../data/research-topics');

const SORT_OPTIONS = Object.freeze({
  newest: 'Newest first',
  title: 'Title A–Z',
  shortest: 'Shortest read',
  longest: 'Longest read'
});
const FILTER_TOPIC_KEYS = ['health', 'technology', 'engineering', 'security', 'culture'];
const GUARDRAIL_MODES = new Set(['standard', 'experimental']);
const DEFAULT_DAILY_ASSISTANT_LIMIT = 25;
const MIN_DAILY_ASSISTANT_LIMIT = 1;
const MAX_DAILY_ASSISTANT_LIMIT = 250;
const GLOBAL_ASSISTANT_CONCURRENCY = 1;
const MAX_UPSTREAM_RETRY_AFTER_SECONDS = 120;
const PROVIDER_ERROR_KINDS = new Set([
  'authentication',
  'authorization',
  'configuration',
  'grounding',
  'throttled',
  'timeout',
  'unavailable',
  'upstream'
]);

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeZone: 'UTC'
});

function displayDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date);
}

function renderUnavailable(res) {
  return res.status(503).render('research/unavailable', {
    title: 'Research temporarily unavailable',
    description: 'The research library is temporarily unavailable. Please try again shortly.'
  });
}

function queryStringValue(value, maximumLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

function normalizeGuardrailMode(value) {
  if (value === undefined) return 'standard';
  return typeof value === 'string' && GUARDRAIL_MODES.has(value) ? value : null;
}

function searchableText(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function filterAndSortArticles(articles, filters) {
  const searchTerm = searchableText(filters.q);
  const filtered = articles.filter((article) => {
    const matchesSearch = !searchTerm
      || searchableText(`${article.title} ${article.excerpt || ''}`).includes(searchTerm);
    const matchesTopic = !filters.topic || article.topic.key === filters.topic;
    return matchesSearch && matchesTopic;
  });

  return filtered.sort((left, right) => {
    if (filters.sort === 'title') return left.title.localeCompare(right.title);
    if (filters.sort === 'shortest') {
      return left.readingMinutes - right.readingMinutes || left.title.localeCompare(right.title);
    }
    if (filters.sort === 'longest') {
      return right.readingMinutes - left.readingMinutes || left.title.localeCompare(right.title);
    }
    const leftDate = left.modifiedAt || left.createdAt || '';
    const rightDate = right.modifiedAt || right.createdAt || '';
    return rightDate.localeCompare(leftDate) || left.title.localeCompare(right.title);
  });
}

function assistantViewModel(assistant, scope, article = null) {
  const isArticle = scope === 'article';
  return {
    available: assistant.isAvailable(),
    description: isArticle
      ? 'Ask about this note. Answers stay within its text and link back to the passages used.'
      : 'Ask across the archive. Answers synthesize the published notes and link back to the passages used.',
    heading: isArticle ? 'Ask this note.' : 'Ask across the archive.',
    label: isArticle ? 'Ask this note' : 'Ask the archive',
    scope,
    scopeLabel: isArticle ? article.title : 'All published research notes',
    slug: isArticle ? article.slug : '',
    suggestions: isArticle
      ? [
        'What are the main findings and limitations?',
        'Which claims have the strongest support in this note?'
      ]
      : [
        'Which notes discuss evidence quality or uncertainty?',
        'What themes appear across the health research?'
      ]
  };
}

function sameOriginRequest(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function assistantError(res, status, code, message, extra = {}) {
  return res.status(status).json({
    error: { code, message, ...extra }
  });
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function boundedRetryAfter(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(MAX_UPSTREAM_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(parsed)));
}

function boundedDailyLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_ASSISTANT_LIMIT;
  return Math.min(MAX_DAILY_ASSISTANT_LIMIT, Math.max(MIN_DAILY_ASSISTANT_LIMIT, parsed));
}

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(value) {
  const current = new Date(value);
  const nextUtcDay = Date.UTC(
    current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1
  );
  return Math.min(24 * 60 * 60, Math.max(1, Math.ceil((nextUtcDay - value) / 1000)));
}

function createAssistantCostGuard(options = {}) {
  const now = options.now || Date.now;
  const dailyLimit = boundedDailyLimit(
    options.dailyLimit === undefined ? process.env.RESEARCH_ASSISTANT_DAILY_LIMIT : options.dailyLimit
  );
  let active = 0;
  let day = utcDay(now());
  let starts = 0;

  return {
    tryStart() {
      const currentTime = now();
      const currentDay = utcDay(currentTime);
      if (currentDay !== day) {
        day = currentDay;
        starts = 0;
      }
      if (active >= GLOBAL_ASSISTANT_CONCURRENCY) {
        return { allowed: false, category: 'concurrency_limited', retryAfterSeconds: 1 };
      }
      if (starts >= dailyLimit) {
        return {
          allowed: false,
          category: 'daily_limited',
          retryAfterSeconds: secondsUntilNextUtcDay(currentTime)
        };
      }

      active += 1;
      starts += 1;
      let released = false;
      return {
        allowed: true,
        release() {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
        }
      };
    }
  };
}

function providerErrorKind(error) {
  const kind = error && typeof error.researchAssistantErrorKind === 'string'
    ? error.researchAssistantErrorKind
    : '';
  return PROVIDER_ERROR_KINDS.has(kind) ? kind : '';
}

function publicProviderFailure(error) {
  const kind = providerErrorKind(error);
  if (!kind) return null;
  if (kind === 'throttled') {
    const retryAfterSeconds = boundedRetryAfter(error.retryAfterSeconds);
    return {
      code: 'assistant_busy',
      extra: { retryAfterSeconds },
      kind,
      message: 'The answer service is busy. Please try again shortly.',
      retryAfterSeconds,
      status: 503
    };
  }
  if (kind === 'timeout') {
    return {
      code: 'assistant_timeout',
      kind,
      message: 'The source-grounded answer took too long. Please try again.',
      status: 504
    };
  }
  if (kind === 'grounding') {
    return {
      code: 'grounding_failed',
      kind,
      message: 'The answer could not be verified against its sources.',
      status: 502
    };
  }
  if (kind === 'upstream') {
    return {
      code: 'assistant_upstream_failed',
      kind,
      message: 'The source-grounded answer could not be completed.',
      status: 502
    };
  }
  return {
    code: 'assistant_unavailable',
    kind,
    message: 'Source-grounded answers are temporarily unavailable.',
    status: 503
  };
}

function logAssistantRequest(detail) {
  const event = {
    event: 'research_assistant_request',
    requestId: detail.requestId,
    scope: detail.scope,
    slug: detail.slug || undefined,
    guardrailMode: GUARDRAIL_MODES.has(detail.guardrailMode) ? detail.guardrailMode : undefined,
    durationMs: Math.max(0, Date.now() - detail.startedAt),
    category: detail.category,
    status: detail.status,
    retrievedCount: safeCount(detail.retrievedCount),
    canonicalCount: safeCount(detail.canonicalCount),
    sourceCount: safeCount(detail.sourceCount),
    retrievalDurationMs: safeCount(detail.retrievalDurationMs),
    generationDurationMs: safeCount(detail.generationDurationMs),
    retrievalMode: ['keyword', 'hybrid', 'keyword_fallback'].includes(detail.retrievalMode)
      ? detail.retrievalMode
      : undefined,
    retrievalFallbackCategory: detail.retrievalFallbackCategory === 'embedding_unavailable'
      ? detail.retrievalFallbackCategory
      : undefined
  };
  console.info(JSON.stringify(event));
}

function createResearchRouter(repository, assistant, options = {}) {
  const router = express.Router();
  const checkRateLimit = createResearchRateLimiter();
  const checkCostGuard = createAssistantCostGuard(options.costGuard);

  router.get('/', async function(req, res, next) {
    try {
      const catalog = await repository.listArticles();
      const q = queryStringValue(req.query.q, 80);
      const requestedTopic = queryStringValue(req.query.topic, 24).toLowerCase();
      const requestedSort = queryStringValue(req.query.sort, 16).toLowerCase();
      const availableTopicKeys = catalog.some((article) => article.topic.key === 'other')
        ? [...FILTER_TOPIC_KEYS, 'other']
        : FILTER_TOPIC_KEYS;
      const filters = {
        q,
        topic: availableTopicKeys.includes(requestedTopic) ? requestedTopic : '',
        sort: Object.hasOwn(SORT_OPTIONS, requestedSort) ? requestedSort : 'newest'
      };
      const articles = filterAndSortArticles([...catalog], filters);
      res.render('research/index', {
        title: 'Research — Gleb Gladyshevskiy',
        description: 'A read-only library of technical, scientific, and systems research notes.',
        filters,
        hasFilters: Boolean(filters.q || filters.topic || filters.sort !== 'newest'),
        sortOptions: Object.entries(SORT_OPTIONS).map(([value, label]) => ({ value, label })),
        topics: availableTopicKeys.map((key) => ({ key, label: TOPIC_LABELS[key] })),
        totalArticles: catalog.length,
        assistant: assistantViewModel(assistant, 'library'),
        articles: articles.map((article) => ({
          ...article,
          displayDate: displayDate(article.modifiedAt || article.createdAt)
        }))
      });
    } catch (error) {
      if (error instanceof ResearchStorageError) return renderUnavailable(res);
      return next(error);
    }
  });

  router.post('/ask', async function(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const requestId = crypto.randomUUID();
    res.set('X-Request-Id', requestId);

    if (!sameOriginRequest(req)) {
      return assistantError(res, 403, 'origin_rejected', 'This request must come from the research viewer.');
    }
    if (!req.is('application/json')) {
      return assistantError(res, 415, 'content_type_required', 'Send the question as JSON.');
    }

    const question = normalizeQuestion(req.body && req.body.question);
    if (!question) {
      return assistantError(
        res,
        400,
        'invalid_question',
        `Enter a question between 3 and ${MAX_QUESTION_LENGTH} characters.`
      );
    }

    const guardrailMode = normalizeGuardrailMode(req.body && req.body.guardrailMode);
    if (!guardrailMode) {
      return assistantError(
        res,
        400,
        'invalid_guardrail_mode',
        'Choose either standard or experimental answer guardrails.'
      );
    }

    const scope = req.body && req.body.scope === 'article' ? 'article' : 'library';
    let slug = '';
    if (scope === 'article') {
      slug = queryStringValue(req.body && req.body.slug, 180).toLowerCase();
      try {
        const article = await repository.getArticle(slug);
        if (!article) return assistantError(res, 404, 'article_not_found', 'That research note is unavailable.');
      } catch (error) {
        if (error instanceof ResearchStorageError) {
          return assistantError(res, 503, 'library_unavailable', 'The research library is temporarily unavailable.');
        }
        logAssistantRequest({
          category: 'internal', guardrailMode, requestId, scope, slug,
          startedAt: Date.now(), status: 'failed'
        });
        return assistantError(res, 500, 'assistant_failed', 'The answer could not be completed.');
      }
    }

    if (!assistant.isAvailable()) {
      return assistantError(
        res,
        503,
        'assistant_unavailable',
        'Source-grounded answers are being connected. The research notes remain available to read.'
      );
    }

    const retryAfterSeconds = checkRateLimit(req.ip || req.socket.remoteAddress || 'unknown');
    if (retryAfterSeconds > 0) {
      res.set('Retry-After', String(retryAfterSeconds));
      return assistantError(
        res,
        429,
        'rate_limited',
        'Please wait before asking another question.',
        { retryAfterSeconds }
      );
    }

    const admission = checkCostGuard.tryStart();
    if (!admission.allowed) {
      res.set('Retry-After', String(admission.retryAfterSeconds));
      logAssistantRequest({
        category: admission.category,
        guardrailMode,
        requestId,
        scope,
        slug,
        startedAt: Date.now(),
        status: 'limited'
      });
      return assistantError(
        res,
        503,
        'assistant_busy',
        'The answer service is busy. Please try again later.',
        { retryAfterSeconds: admission.retryAfterSeconds }
      );
    }

    const startedAt = Date.now();
    const telemetry = {
      requestId,
      scope,
      slug,
      guardrailMode,
      startedAt
    };
    const controller = new AbortController();
    function abortOnDisconnect() {
      if (!res.writableEnded) controller.abort();
    }
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);

    try {
      const articles = scope === 'library' ? await repository.listArticles() : [];
      const response = await assistant.ask({
        articles,
        question,
        scope,
        slug,
        guardrailMode,
        signal: controller.signal,
        resolveEvidenceSource: repository.resolveEvidenceSource.bind(repository),
        observe(detail) {
          if (!detail || typeof detail !== 'object') return;
          if (detail.stage === 'retrieval') {
            telemetry.retrievedCount = safeCount(detail.count);
            telemetry.retrievalDurationMs = safeCount(detail.durationMs);
          } else if (detail.stage === 'canonicalization') {
            telemetry.canonicalCount = safeCount(detail.count);
          } else if (detail.stage === 'generation') {
            telemetry.generationDurationMs = safeCount(detail.durationMs);
          } else if (detail.stage === 'retrieval_mode') {
            telemetry.retrievalMode = detail.mode;
            if (detail.mode === 'keyword_fallback') {
              telemetry.retrievalFallbackCategory = detail.category;
            }
          } else if (detail.stage === 'result') {
            telemetry.sourceCount = safeCount(detail.sourceCount);
          }
        }
      });
      const responseGuardrailMode = response.guardrailMode === 'experimental'
        ? 'experimental'
        : 'standard';
      logAssistantRequest({ ...telemetry, category: response.status, status: 'completed' });
      return res.json({
        ...response,
        guardrailMode: responseGuardrailMode,
        notice: responseGuardrailMode === 'experimental'
          ? 'Experimental answer-writing mode. Citations remain enforced. This is not medical advice and must not guide personal health decisions.'
          : 'Research summary only, not medical advice. Do not use it for personal health decisions.'
      });
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) return undefined;
      if (error instanceof ResearchStorageError) {
        logAssistantRequest({ ...telemetry, category: 'library_unavailable', status: 'failed' });
        return assistantError(res, 503, 'library_unavailable', 'The research library is temporarily unavailable.');
      }
      if (error instanceof ResearchAssistantUnavailableError) {
        logAssistantRequest({ ...telemetry, category: 'unavailable', status: 'failed' });
        return assistantError(res, 503, 'assistant_unavailable', 'Source-grounded answers are temporarily unavailable.');
      }
      if (error instanceof ResearchAssistantInvalidResponseError) {
        logAssistantRequest({ ...telemetry, category: 'grounding_failed', status: 'failed' });
        return assistantError(res, 502, 'grounding_failed', 'The answer could not be verified against its sources.');
      }
      const providerFailure = publicProviderFailure(error);
      if (providerFailure) {
        logAssistantRequest({ ...telemetry, category: providerFailure.kind, status: 'failed' });
        if (providerFailure.retryAfterSeconds) {
          res.set('Retry-After', String(providerFailure.retryAfterSeconds));
        }
        return assistantError(
          res,
          providerFailure.status,
          providerFailure.code,
          providerFailure.message,
          providerFailure.extra
        );
      }
      logAssistantRequest({ ...telemetry, category: 'internal', status: 'failed' });
      return assistantError(res, 500, 'assistant_failed', 'The answer could not be completed.');
    } finally {
      admission.release();
      req.removeListener('aborted', abortOnDisconnect);
      res.removeListener('close', abortOnDisconnect);
    }
  });

  router.get('/:slug', async function(req, res, next) {
    try {
      const article = await repository.getArticle(req.params.slug);
      if (!article) return next();

      res.render('research/article', {
        title: `${article.title} — Research`,
        description: article.excerpt || 'Research note by Gleb Gladyshevskiy.',
        article: {
          ...article,
          displayCreatedAt: displayDate(article.createdAt),
          displayModifiedAt: displayDate(article.modifiedAt)
        },
        assistant: assistantViewModel(assistant, 'article', article)
      });
    } catch (error) {
      if (error instanceof ResearchStorageError) return renderUnavailable(res);
      return next(error);
    }
  });

  return router;
}

module.exports = createResearchRouter;
module.exports.assistantViewModel = assistantViewModel;
module.exports.filterAndSortArticles = filterAndSortArticles;
module.exports.normalizeGuardrailMode = normalizeGuardrailMode;
