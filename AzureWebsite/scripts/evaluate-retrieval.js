'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const evaluationSet = require('../data/retrieval-evaluation.json');
const { createAzureResearchProvider } = require('../services/azure-research-provider');
const { createResearchRepository } = require('../services/research-repository');

const QUESTIONS = Object.freeze({
  'exact-audio': 'audio compression quality',
  'paraphrase-tdem': 'electromagnetic sensing research using unmanned aircraft',
  'synonym-retinoid': 'comparison of vitamin A skin care derivatives',
  'cross-topic-substance': 'research effects of cannabis consumption',
  'health-nutrition': 'dietary requirements associated with building muscle',
  'technical-security': 'techniques that circumvent memory corruption defenses',
  'article-scope-vitamin-c': 'What functions, benefits, and risks are covered?',
  'article-scope-culture': 'What factors are associated with musical preference?'
});

function rank(results, expectedSlug) {
  const index = results.findIndex((item) => item.articleSlug === expectedSlug);
  return index === -1 ? null : index + 1;
}

async function runMode(mode) {
  const provider = createAzureResearchProvider({
    env: { ...process.env, RESEARCH_ASSISTANT_ENABLED: 'true', RESEARCH_RETRIEVAL_MODE: mode }
  });
  if (!provider) throw new Error('Research provider is not configured.');
  const repository = createResearchRepository();
  const results = [];
  for (const item of evaluationSet) {
    const observations = [];
    const chunks = await provider.retrieve({
      question: QUESTIONS[item.id], scope: item.scope, slug: item.slug, limit: 8,
      observe: (detail) => observations.push(detail)
    });
    const scopeLeak = item.scope === 'article' && chunks.some((chunk) => chunk.articleSlug !== item.slug);
    let groundingRejects = 0;
    for (const chunk of chunks) {
      try {
        await repository.resolveEvidenceSource({
          articleSlug: chunk.articleSlug, headingId: chunk.headingId, sourceEtag: chunk.sourceEtag
        });
      } catch {
        groundingRejects += 1;
      }
    }
    results.push({
      id: item.id,
      mode: observations.find((detail) => detail.stage === 'retrieval_mode')?.mode || 'unknown',
      expectedRank: rank(chunks, item.expectedSlug),
      scopeLeak,
      groundingRejects,
      ranked: chunks.map((chunk) => ({ id: chunk.id, slug: chunk.articleSlug, heading: chunk.headingId }))
    });
  }
  return results;
}

function summary(results) {
  return {
    queryCount: results.length,
    expectedTop1: results.filter((item) => item.expectedRank === 1).length,
    expectedTop8: results.filter((item) => item.expectedRank !== null).length,
    scopeLeaks: results.filter((item) => item.scopeLeak).length,
    groundingRejects: results.reduce((total, item) => total + item.groundingRejects, 0),
    fallbackCount: results.filter((item) => item.mode === 'keyword_fallback').length
  };
}

function comparison(keyword, hybrid) {
  let improved = 0;
  let regressed = 0;
  let neutral = 0;
  for (let index = 0; index < keyword.length; index += 1) {
    const keywordRank = keyword[index].expectedRank || 9;
    const hybridRank = hybrid[index].expectedRank || 9;
    if (hybridRank < keywordRank) improved += 1;
    else if (hybridRank > keywordRank) regressed += 1;
    else neutral += 1;
  }
  return {
    improved,
    neutral,
    regressed,
    verdict: regressed > 0 ? 'regressed' : improved > 0 ? 'improved' : 'neutral'
  };
}

async function main() {
  const keyword = await runMode('keyword');
  const hybrid = await runMode('hybrid');
  const report = {
    generatedAt: new Date().toISOString(), keyword, hybrid,
    summary: { keyword: summary(keyword), hybrid: summary(hybrid), comparison: comparison(keyword, hybrid) }
  };
  if (report.summary.keyword.scopeLeaks || report.summary.hybrid.scopeLeaks || report.summary.hybrid.fallbackCount || report.summary.keyword.groundingRejects || report.summary.hybrid.groundingRejects || report.summary.comparison.verdict === 'regressed') {
    throw new Error('Retrieval evaluation failed its scope-leak, stale-grounding, hybrid-fallback, or ranking-regression gate.');
  }
  const output = path.resolve(__dirname, '../../artifacts/local/VECTOR_RETRIEVAL_EVALUATION.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: 'retrieval_evaluation_complete', ...report.summary }));
}

// Keep the CLI alive while managed-identity and Blob requests settle.
const keepAlive = setInterval(() => {}, 1000);
main().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => clearInterval(keepAlive));
