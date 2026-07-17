'use strict';

const express = require('express');
const { ResearchStorageError } = require('../services/research-repository');

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

function createResearchRouter(repository) {
  const router = express.Router();

  router.get('/', async function(req, res, next) {
    try {
      const articles = await repository.listArticles();
      res.render('research/index', {
        title: 'Research — Gleb Gladyshevskiy',
        description: 'A read-only library of technical, scientific, and systems research notes.',
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
