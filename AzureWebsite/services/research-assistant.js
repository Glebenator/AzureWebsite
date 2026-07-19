'use strict';

const MIN_QUESTION_LENGTH = 3;
const MAX_QUESTION_LENGTH = 600;
const MAX_ANSWER_LENGTH = 6000;
const MAX_EVIDENCE = 8;
const MAX_FOLLOW_UPS = 3;
const NO_EVIDENCE_ANSWER = 'I could not find enough relevant evidence in the published research notes to answer that question.';
const GUARDRAIL_REFUSAL_ANSWER = 'The draft crossed the standard health-language guardrails, so it was not shown.';
const DEFAULT_GUARDRAIL_MODE = 'standard';
const GUARDRAIL_MODES = new Set([DEFAULT_GUARDRAIL_MODE, 'experimental']);
const SAFE_FOLLOW_UPS = Object.freeze({
  article: Object.freeze([
    'What limitations does this note identify?',
    'Which cited passages provide the strongest support?'
  ]),
  library: Object.freeze([
    'What limitations or uncertainties do the cited notes describe?',
    'Where do the cited notes agree or disagree?'
  ])
});
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADING_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOPIC_KEYS = new Set(['health', 'technology', 'engineering', 'security', 'culture', 'other']);
const COMPARISON_PATTERN = /\b(?:compare|comparison|contrast|differ|difference|different|versus|vs\.?)\b/i;
const GENERIC_TITLE_TERMS = new Set([
  'analysis', 'benefits', 'comprehensive', 'effects', 'explained', 'functions', 'health',
  'latest', 'overview', 'research', 'risks', 'state', 'supplementation', 'understanding'
]);
const TITLE_STOP_TERMS = new Set([
  'a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'vs', 'with'
]);

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

function normalizeGuardrailMode(value) {
  const normalized = value === undefined || value === null || value === ''
    ? DEFAULT_GUARDRAIL_MODE
    : String(value).trim().toLowerCase();
  return GUARDRAIL_MODES.has(normalized) ? normalized : null;
}

function searchableTerms(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function comparisonTargetSlugs(question, articles) {
  const normalizedQuestion = safeText(question, MAX_QUESTION_LENGTH).toLowerCase();
  if (!COMPARISON_PATTERN.test(normalizedQuestion) || !Array.isArray(articles)) return [];

  const catalog = articles.slice(0, 100).map((article) => {
    const slug = safeText(article?.slug, 180).toLowerCase();
    const title = safeText(article?.title, 240);
    if (!SLUG_PATTERN.test(slug) || !title) return null;
    return { slug, title, terms: searchableTerms(title) };
  }).filter(Boolean);
  const questionTerms = searchableTerms(normalizedQuestion);
  const questionTermSet = new Set(questionTerms);
  const questionPairs = new Map();
  for (let index = 0; index < questionTerms.length - 1; index += 1) {
    const pair = `${questionTerms[index]} ${questionTerms[index + 1]}`;
    if (!questionPairs.has(pair)) questionPairs.set(pair, index);
  }

  const documentFrequency = new Map();
  for (const article of catalog) {
    for (const term of new Set(article.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const matches = [];
  for (const article of catalog) {
    let position = Number.POSITIVE_INFINITY;
    for (let index = 0; index < article.terms.length - 1; index += 1) {
      const left = article.terms[index];
      const right = article.terms[index + 1];
      if (TITLE_STOP_TERMS.has(left) && TITLE_STOP_TERMS.has(right)) continue;
      const questionPosition = questionPairs.get(`${left} ${right}`);
      if (questionPosition !== undefined) position = Math.min(position, questionPosition);
    }
    for (const term of article.terms) {
      if (
        term.length >= 5
        && !GENERIC_TITLE_TERMS.has(term)
        && !TITLE_STOP_TERMS.has(term)
        && documentFrequency.get(term) === 1
        && questionTermSet.has(term)
      ) {
        position = Math.min(position, questionTerms.indexOf(term));
      }
    }
    if (Number.isFinite(position)) matches.push({ slug: article.slug, position });
  }

  if (matches.length < 2) return [];
  return matches
    .sort((left, right) => left.position - right.position || left.slug.localeCompare(right.slug))
    .slice(0, 4)
    .map((match) => match.slug);
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

function noEvidenceResponse(guardrailMode = DEFAULT_GUARDRAIL_MODE) {
  return {
    answer: NO_EVIDENCE_ANSWER,
    followUps: [],
    guardrailMode,
    sources: [],
    status: 'no_evidence'
  };
}

function guardrailRefusalResponse(guardrailMode = DEFAULT_GUARDRAIL_MODE) {
  return {
    answer: GUARDRAIL_REFUSAL_ANSWER,
    followUps: [],
    guardrailMode,
    sources: [],
    status: 'guardrail_refusal'
  };
}

function normalizeGeneratedResponse(
  value,
  evidence = [],
  scope = 'library',
  guardrailMode = DEFAULT_GUARDRAIL_MODE
) {
  if (!value || typeof value !== 'object') throw new ResearchAssistantInvalidResponseError();
  if (value.status === 'no_evidence') return noEvidenceResponse(guardrailMode);
  if (value.status === 'guardrail_refusal') {
    if (guardrailMode === 'experimental') {
      throw new ResearchAssistantInvalidResponseError(
        'The assistant returned a guardrail refusal in Experimental mode.'
      );
    }
    return guardrailRefusalResponse(guardrailMode);
  }
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
  const followUps = (SAFE_FOLLOW_UPS[scope] || SAFE_FOLLOW_UPS.library).slice(0, MAX_FOLLOW_UPS);

  return { answer, followUps, guardrailMode, sources, status: 'answered' };
}

function observe(request, detail) {
  if (typeof request.observe !== 'function') return;
  try {
    request.observe(detail);
  } catch {
    // Observability must never affect the answer path.
  }
}

function withRequestContext(value, { signal, guardrailMode }) {
  if (signal && typeof signal.addEventListener === 'function') {
    Object.defineProperty(value, 'signal', {
      configurable: false,
      enumerable: false,
      value: signal,
      writable: false
    });
  }
  Object.defineProperty(value, 'guardrailMode', {
    configurable: false,
    enumerable: false,
    value: guardrailMode,
    writable: false
  });
  return value;
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
    const canonicalTopicKey = safeText(canonical && canonical.topicKey, 40).toLowerCase();
    if (
      !title
      || !heading
      || url !== `/research/${articleSlug}#${headingId}`
      || (canonicalTopicKey && !TOPIC_KEYS.has(canonicalTopicKey))
    ) continue;

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
      topicKey: canonicalTopicKey || null,
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
      const guardrailMode = normalizeGuardrailMode(request.guardrailMode);
      if (
        !question
        || (scope !== 'article' && scope !== 'library')
        || (scope === 'article' && !SLUG_PATTERN.test(slug))
        || !guardrailMode
        || typeof request.resolveEvidenceSource !== 'function'
      ) {
        throw new ResearchAssistantInvalidResponseError('The assistant request is invalid.');
      }

      const retrievalStartedAt = Date.now();
      const targetSlugs = scope === 'library'
        ? comparisonTargetSlugs(question, request.articles)
        : [];
      const retrievalRequest = {
        question,
        scope,
        slug,
        limit: MAX_EVIDENCE
      };
      if (targetSlugs.length > 1) retrievalRequest.targetSlugs = targetSlugs;
      const candidates = await provider.retrieve(withRequestContext(
        retrievalRequest,
        { signal: request.signal, guardrailMode }
      ));
      observe(request, {
        count: Array.isArray(candidates) ? candidates.length : 0,
        durationMs: Date.now() - retrievalStartedAt,
        stage: 'retrieval'
      });
      const evidence = await canonicalizeEvidence(candidates, {
        resolveEvidenceSource: request.resolveEvidenceSource,
        scope,
        slug
      });
      observe(request, { count: evidence.length, stage: 'canonicalization' });
      if (evidence.length === 0) {
        observe(request, { sourceCount: 0, stage: 'result', status: 'no_evidence' });
        return noEvidenceResponse(guardrailMode);
      }

      const generationStartedAt = Date.now();
      const generated = await provider.generate(withRequestContext(
        { question, scope, evidence },
        { signal: request.signal, guardrailMode }
      ));
      observe(request, { durationMs: Date.now() - generationStartedAt, stage: 'generation' });
      const response = normalizeGeneratedResponse(generated, evidence, scope, guardrailMode);
      observe(request, {
        sourceCount: response.sources.length,
        stage: 'result',
        status: response.status
      });
      return response;
    }
  };
}

module.exports = {
  DEFAULT_GUARDRAIL_MODE,
  GUARDRAIL_REFUSAL_ANSWER,
  MAX_QUESTION_LENGTH,
  NO_EVIDENCE_ANSWER,
  ResearchAssistantInvalidResponseError,
  ResearchAssistantUnavailableError,
  comparisonTargetSlugs,
  createResearchAssistant,
  normalizeQuestion,
  normalizeResponse: normalizeGeneratedResponse,
  safeResearchUrl
};
