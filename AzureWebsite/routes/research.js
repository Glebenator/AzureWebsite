'use strict';

const express = require('express');
const { ResearchStorageError } = require('../services/research-repository');
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

function createResearchRouter(repository) {
  const router = express.Router();

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
        }
      });
    } catch (error) {
      if (error instanceof ResearchStorageError) return renderUnavailable(res);
      return next(error);
    }
  });

  return router;
}

module.exports = createResearchRouter;
module.exports.filterAndSortArticles = filterAndSortArticles;
