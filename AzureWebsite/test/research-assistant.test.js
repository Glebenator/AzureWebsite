'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  NO_EVIDENCE_ANSWER,
  ResearchAssistantInvalidResponseError,
  createResearchAssistant
} = require('../services/research-assistant');
const { createResearchRepository } = require('../services/research-repository');

function createMockContainer(source, etag = 'current-etag') {
  return {
    async *listBlobsFlat() {
      yield {
        name: 'grounded-note.md',
        properties: {
          contentLength: Buffer.byteLength(source),
          etag,
          lastModified: new Date('2026-07-01T12:00:00.000Z')
        }
      };
    },
    getBlobClient() {
      return {
        async download() {
          return { readableStreamBody: Readable.from([source]) };
        }
      };
    }
  };
}

function candidate(overrides = {}) {
  return {
    id: 'chunk-1',
    articleSlug: 'grounded-note',
    articleTitle: 'Provider-controlled title',
    headingId: 'main-finding',
    headingLabel: 'Provider-controlled heading',
    excerpt: 'A concise evidence excerpt.',
    content: 'The note describes a supported finding and its limitations.',
    sourceEtag: 'current-etag',
    ...overrides
  };
}

function resolver(value) {
  if (
    value.articleSlug !== 'grounded-note'
    || value.headingId !== 'main-finding'
    || value.sourceEtag !== 'current-etag'
  ) return null;
  return {
    title: 'Canonical Grounded Note',
    heading: 'Main finding',
    url: '/research/grounded-note#main-finding'
  };
}

test('repository resolves only current catalog entries and rendered headings', async () => {
  const source = [
    '---',
    'title: Canonical Grounded Note',
    '---',
    '',
    '# Main finding',
    '',
    'Grounded evidence.',
    '',
    '### Limitations',
    '',
    'A bounded limitation.'
  ].join('\n');
  const repository = createResearchRepository({ containerClient: createMockContainer(source) });

  assert.deepEqual(await repository.resolveEvidenceSource({
    articleSlug: 'grounded-note',
    headingId: 'main-finding',
    sourceEtag: 'current-etag'
  }), {
    articleSlug: 'grounded-note',
    headingId: 'main-finding',
    heading: 'Main finding',
    sourceEtag: 'current-etag',
    title: 'Canonical Grounded Note',
    url: '/research/grounded-note#main-finding'
  });
  assert.equal(await repository.resolveEvidenceSource({
    articleSlug: 'grounded-note', headingId: 'invented', sourceEtag: 'current-etag'
  }), null);
  assert.equal(await repository.resolveEvidenceSource({
    articleSlug: 'grounded-note', headingId: 'main-finding', sourceEtag: 'stale-etag'
  }), null);
  assert.equal(await repository.resolveEvidenceSource({
    articleSlug: 'missing-note', headingId: 'main-finding', sourceEtag: 'current-etag'
  }), null);
});

test('assistant canonicalizes retrieved evidence and derives sparse sources from citations', async () => {
  let generationRequest = null;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve(request) {
        assert.deepEqual(request, {
          question: 'What is supported?', scope: 'library', slug: '', limit: 8
        });
        return [candidate(), candidate({ id: 'chunk-2', excerpt: 'A second excerpt.' })];
      },
      async generate(request) {
        generationRequest = request;
        return {
          status: 'answered',
          answer: 'The limitations are explicitly discussed. [2]',
          sources: [{ title: 'Invented', url: 'https://example.com' }],
          followUps: ['How strong is that evidence?']
        };
      }
    }
  });

  const result = await assistant.ask({
    question: 'What is supported?',
    scope: 'library',
    resolveEvidenceSource: resolver
  });

  assert.equal(generationRequest.evidence.length, 2);
  assert.equal(generationRequest.evidence[0].title, 'Canonical Grounded Note');
  assert.equal(generationRequest.evidence[0].heading, 'Main finding');
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0], {
    number: 2,
    title: 'Canonical Grounded Note',
    heading: 'Main finding',
    excerpt: 'A second excerpt.',
    url: '/research/grounded-note#main-finding'
  });
});

test('assistant replaces provider-authored no-evidence claims with fixed safe text', async () => {
  const assistant = createResearchAssistant({
    provider: {
      async retrieve() { return [candidate()]; },
      async generate() {
        return {
          status: 'no_evidence',
          answer: 'Take a high dose every day.',
          sources: [{ title: 'Invented source' }],
          followUps: ['Which dose should I take?']
        };
      }
    }
  });

  const result = await assistant.ask({
    question: 'What dose should I take?', scope: 'library', resolveEvidenceSource: resolver
  });
  assert.deepEqual(result, {
    answer: NO_EVIDENCE_ANSWER,
    followUps: [],
    sources: [],
    status: 'no_evidence'
  });
  assert.doesNotMatch(JSON.stringify(result), /high dose|Which dose/);
});

test('assistant never generates when retrieval has no current in-scope evidence', async () => {
  let generateCalls = 0;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve() {
        return [
          candidate({ articleSlug: 'another-note' }),
          candidate({ id: 'stale', sourceEtag: 'stale-etag' }),
          candidate({ id: 'invented-heading', headingId: 'invented' })
        ];
      },
      async generate() { generateCalls += 1; }
    }
  });

  const result = await assistant.ask({
    question: 'What is supported?',
    scope: 'article',
    slug: 'grounded-note',
    resolveEvidenceSource: resolver
  });
  assert.equal(generateCalls, 0);
  assert.equal(result.status, 'no_evidence');
  assert.equal(result.answer, NO_EVIDENCE_ANSWER);
});

test('assistant rejects missing, invented, and invalid request citations', async () => {
  async function rejectsAnswer(answer) {
    const assistant = createResearchAssistant({
      provider: {
        async retrieve() { return [candidate()]; },
        async generate() { return { status: 'answered', answer }; }
      }
    });
    await assert.rejects(
      assistant.ask({
        question: 'What is supported?', scope: 'library', resolveEvidenceSource: resolver
      }),
      ResearchAssistantInvalidResponseError
    );
  }

  await rejectsAnswer('This has no citation.');
  await rejectsAnswer('This cites invented evidence. [2]');
  await rejectsAnswer('This mixes valid and invalid citations. [1] [0]');
  await rejectsAnswer('This uses a noncanonical citation marker. [01]');
  await rejectsAnswer('This hides invented evidence in a compound marker. [1] [2, 3]');

  const assistant = createResearchAssistant({
    provider: { async retrieve() { return []; }, async generate() {} }
  });
  await assert.rejects(
    assistant.ask({
      question: 'What is supported?', scope: 'unsupported', resolveEvidenceSource: resolver
    }),
    ResearchAssistantInvalidResponseError
  );
});
