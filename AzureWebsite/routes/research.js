'use strict';

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

function createResearchRouter(repository, assistant) {
  const router = express.Router();
  const checkRateLimit = createResearchRateLimiter();

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
        return next(error);
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

    try {
      const response = await assistant.ask({
        question,
        scope,
        slug,
        resolveEvidenceSource: repository.resolveEvidenceSource.bind(repository)
      });
      return res.json({
        ...response,
        notice: 'Research summary only, not medical advice. Do not use it for personal health decisions.'
      });
    } catch (error) {
      if (error instanceof ResearchStorageError) {
        return assistantError(res, 503, 'library_unavailable', 'The research library is temporarily unavailable.');
      }
      if (error instanceof ResearchAssistantUnavailableError) {
        return assistantError(res, 503, 'assistant_unavailable', 'Source-grounded answers are temporarily unavailable.');
      }
      if (error instanceof ResearchAssistantInvalidResponseError) {
        console.error(error);
        return assistantError(res, 502, 'grounding_failed', 'The answer could not be verified against its sources.');
      }
      return next(error);
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
