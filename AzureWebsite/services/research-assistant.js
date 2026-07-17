'use strict';

const MIN_QUESTION_LENGTH = 3;
const MAX_QUESTION_LENGTH = 600;
const MAX_ANSWER_LENGTH = 6000;
const MAX_EVIDENCE = 8;
const MAX_FOLLOW_UPS = 3;
const NO_EVIDENCE_ANSWER = 'I could not find enough relevant evidence in the published research notes to answer that question.';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADING_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class ResearchAssistantUnavailableError extends Error {
  constructor(message = 'The research assistant is not configured.') {
    super(message);
    this.name = 'ResearchAssistantUnavailableError';
  }
}

class ResearchAssistantInvalidResponseError extends Error {
  constructor(message = 'The research assistant returned an invalid response.') {
    super(message);
    this.name = 'ResearchAssistantInvalidResponseError';
  }
}

function safeText(value, maximumLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

function normalizeQuestion(value) {
  const question = safeText(value, MAX_QUESTION_LENGTH);
  if (question.length < MIN_QUESTION_LENGTH) return null;
  return question;
}

function safeResearchUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/research/')) return null;
  try {
    const url = new URL(value, 'https://research.invalid');
    if (url.origin !== 'https://research.invalid') return null;
    if (!/^\/research\/[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*$/.test(`${url.pathname}${url.hash}`)) {
      return null;
    }
    return `${url.pathname}${url.hash}`;
  } catch {
    return null;
  }
}

function noEvidenceResponse() {
  return {
    answer: NO_EVIDENCE_ANSWER,
    followUps: [],
    sources: [],
    status: 'no_evidence'
  };
}

function normalizeGeneratedResponse(value, evidence = []) {
  if (!value || typeof value !== 'object') throw new ResearchAssistantInvalidResponseError();
  if (value.status === 'no_evidence') return noEvidenceResponse();
  if (value.status !== 'answered') {
    throw new ResearchAssistantInvalidResponseError('The assistant response has an invalid status.');
  }

  const answer = safeText(value.answer, MAX_ANSWER_LENGTH);
  if (!answer) throw new ResearchAssistantInvalidResponseError('The assistant response has no answer.');

  const citationTokens = answer.match(/\[[^\]\r\n]{0,80}\d[^\]\r\n]{0,80}\]/g) || [];
  if (citationTokens.some((token) => !/^\[[1-9]\d*\]$/.test(token))) {
    throw new ResearchAssistantInvalidResponseError('The answer contains malformed citations.');
  }
  const citedNumbers = citationTokens.map((token) => Number.parseInt(token.slice(1, -1), 10));
  if (
    citedNumbers.length === 0
    || citedNumbers.some((number) => number < 1 || number > evidence.length)
  ) {
    throw new ResearchAssistantInvalidResponseError('The answer contains missing or invalid citations.');
  }

  const uniqueCitations = [...new Set(citedNumbers)];
  const sources = uniqueCitations.map((number) => {
    const item = evidence[number - 1];
    return {
      number,
      title: item.title,
      heading: item.heading,
      excerpt: item.excerpt,
      url: item.url
    };
  });
  const followUps = Array.isArray(value.followUps)
    ? value.followUps
      .map((item) => safeText(item, 220))
      .filter(Boolean)
      .slice(0, MAX_FOLLOW_UPS)
    : [];

  return { answer, followUps, sources, status: 'answered' };
}

async function canonicalizeEvidence(candidates, request) {
  if (!Array.isArray(candidates)) {
    throw new ResearchAssistantInvalidResponseError('The retrieval provider returned an invalid result.');
  }

  const evidence = [];
  const seenIds = new Set();
  for (const candidate of candidates) {
    if (evidence.length >= MAX_EVIDENCE) break;
    if (!candidate || typeof candidate !== 'object') continue;

    const id = safeText(candidate.id, 240);
    const articleSlug = safeText(candidate.articleSlug, 180).toLowerCase();
    const headingId = safeText(candidate.headingId, 180).toLowerCase();
    const sourceEtag = safeText(candidate.sourceEtag, 240);
    const content = safeText(candidate.content, 6000);
    if (
      !id
      || seenIds.has(id)
      || !SLUG_PATTERN.test(articleSlug)
      || !HEADING_PATTERN.test(headingId)
      || !sourceEtag
      || !content
      || (request.scope === 'article' && articleSlug !== request.slug)
    ) {
      continue;
    }

    const canonical = await request.resolveEvidenceSource({ articleSlug, headingId, sourceEtag });
    const title = safeText(canonical && canonical.title, 240);
    const heading = safeText(canonical && canonical.heading, 240);
    const url = safeResearchUrl(canonical && canonical.url);
    if (!title || !heading || url !== `/research/${articleSlug}#${headingId}`) continue;

    seenIds.add(id);
    evidence.push({
      number: evidence.length + 1,
      id,
      articleSlug,
      title,
      headingId,
      heading,
      excerpt: safeText(candidate.excerpt, 420) || content.slice(0, 420),
      content,
      sourceEtag,
      url
    });
  }
  return evidence;
}

function createResearchAssistant(options = {}) {
  const provider = options.provider || null;

  return {
    isAvailable() {
      return Boolean(
        provider
        && typeof provider.retrieve === 'function'
        && typeof provider.generate === 'function'
      );
    },

    async ask(request = {}) {
      if (!provider || typeof provider.retrieve !== 'function' || typeof provider.generate !== 'function') {
        throw new ResearchAssistantUnavailableError();
      }

      const question = normalizeQuestion(request.question);
      const scope = request.scope;
      const slug = scope === 'article' ? safeText(request.slug, 180).toLowerCase() : '';
      if (
        !question
        || (scope !== 'article' && scope !== 'library')
        || (scope === 'article' && !SLUG_PATTERN.test(slug))
        || typeof request.resolveEvidenceSource !== 'function'
      ) {
        throw new ResearchAssistantInvalidResponseError('The assistant request is invalid.');
      }

      const candidates = await provider.retrieve({
        question,
        scope,
        slug,
        limit: MAX_EVIDENCE
      });
      const evidence = await canonicalizeEvidence(candidates, {
        resolveEvidenceSource: request.resolveEvidenceSource,
        scope,
        slug
      });
      if (evidence.length === 0) return noEvidenceResponse();

      const generated = await provider.generate({ question, scope, evidence });
      return normalizeGeneratedResponse(generated, evidence);
    }
  };
}

module.exports = {
  MAX_QUESTION_LENGTH,
  NO_EVIDENCE_ANSWER,
  ResearchAssistantInvalidResponseError,
  ResearchAssistantUnavailableError,
  createResearchAssistant,
  normalizeQuestion,
  normalizeResponse: normalizeGeneratedResponse,
  safeResearchUrl
};
