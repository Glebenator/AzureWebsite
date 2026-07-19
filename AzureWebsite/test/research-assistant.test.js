'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const {
  DEFAULT_GUARDRAIL_MODE,
  GUARDRAIL_REFUSAL_ANSWER,
  NO_EVIDENCE_ANSWER,
  ResearchAssistantInvalidResponseError,
  ResearchAssistantUnavailableError,
  createResearchAssistant
} = require('../services/research-assistant');
const { createResearchRepository } = require('../services/research-repository');
const createResearchRouter = require('../routes/research');

function createMockContainer(source, etag = 'current-etag', blobName = 'grounded-note.md') {
  return {
    async *listBlobsFlat() {
      yield {
        name: blobName,
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
    topicKey: 'other',
    url: '/research/grounded-note#main-finding'
  };
}

function createAskRouteInvoker(
  assistant,
  repositoryOverride = {},
  routerOptions = {}
) {
  const repository = {
    async getArticle(slug) { return { slug }; },
    async resolveEvidenceSource() { return null; },
    ...repositoryOverride
  };
  const router = createResearchRouter(repository, assistant, routerOptions);
  const layer = router.stack.find((item) => item.route && item.route.path === '/ask');
  const handler = layer.route.stack[0].handle;

  return async function invoke(
    body = { question: 'What does the evidence show?', scope: 'library' },
    ip = '203.0.113.42'
  ) {
    const req = Object.assign(new EventEmitter(), {
      body,
      ip,
      socket: { remoteAddress: ip },
      get(name) {
        if (name.toLowerCase() === 'host') return 'research.example';
        return undefined;
      },
      is(value) { return value === 'application/json'; }
    });
    const res = Object.assign(new EventEmitter(), {
      headers: {},
      statusCode: 200,
      writableEnded: false,
      set(name, value) {
        if (typeof name === 'object') Object.assign(this.headers, name);
        else this.headers[name] = value;
        return this;
      },
      status(value) {
        this.statusCode = value;
        return this;
      },
      json(value) {
        this.body = value;
        this.writableEnded = true;
        return this;
      }
    });

    await handler(req, res, () => {
      throw new Error('The research ask route unexpectedly delegated to the HTML error handler.');
    });
    return res;
  };
}

async function invokeAskRoute(
  assistant,
  body = { question: 'What does the evidence show?', scope: 'library' },
  repositoryOverride = {}
) {
  return createAskRouteInvoker(assistant, repositoryOverride)(body);
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
    topicKey: 'other',
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

test('repository supplies canonical health topic provenance for neutrally worded articles', async () => {
  const source = [
    '---',
    'title: Plant Research Note',
    '---',
    '',
    '# Observations',
    '',
    'The note describes measured outcomes.'
  ].join('\n');
  const repository = createResearchRepository({
    containerClient: createMockContainer(
      source,
      'marijuana-etag',
      'marijuana-consumption-effects-research.md'
    )
  });

  const resolved = await repository.resolveEvidenceSource({
    articleSlug: 'marijuana-consumption-effects-research',
    headingId: 'observations',
    sourceEtag: 'marijuana-etag'
  });
  assert.equal(resolved.topicKey, 'health');
  assert.equal(resolved.title, 'Plant Research Note');
});

test('assistant canonicalizes retrieved evidence and derives sparse sources from citations', async () => {
  let generationRequest = null;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve(request) {
        assert.deepEqual(request, {
          question: 'What is supported?', scope: 'library', slug: '', limit: 8
        });
        assert.equal(request.guardrailMode, 'standard');
        return [
          candidate({ topicKey: 'health' }),
          candidate({ id: 'chunk-2', excerpt: 'A second excerpt.', topicKey: 'security' })
        ];
      },
      async generate(request) {
        generationRequest = request;
        assert.equal(request.guardrailMode, 'standard');
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
  assert.equal(result.guardrailMode, DEFAULT_GUARDRAIL_MODE);
  assert.equal(generationRequest.evidence[0].title, 'Canonical Grounded Note');
  assert.equal(generationRequest.evidence[0].heading, 'Main finding');
  assert.equal(generationRequest.evidence[0].topicKey, 'other');
  assert.equal(generationRequest.evidence[1].topicKey, 'other');
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0], {
    number: 2,
    title: 'Canonical Grounded Note',
    heading: 'Main finding',
    excerpt: 'A second excerpt.',
    url: '/research/grounded-note#main-finding'
  });
  assert.deepEqual(result.followUps, [
    'What limitations or uncertainties do the cited notes describe?',
    'Where do the cited notes agree or disagree?'
  ]);
  assert.doesNotMatch(JSON.stringify(result.followUps), /How strong is that evidence/);
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
    guardrailMode: 'standard',
    sources: [],
    status: 'no_evidence'
  });
  assert.doesNotMatch(JSON.stringify(result), /high dose|Which dose/);
});

test('assistant distinguishes a server-owned guardrail refusal from no evidence', async () => {
  const providerRefusal = 'The model says to take a private treatment.';
  const assistant = createResearchAssistant({
    provider: {
      async retrieve(request) {
        assert.equal(request.guardrailMode, 'standard');
        return [candidate()];
      },
      async generate(request) {
        assert.equal(request.guardrailMode, 'standard');
        return {
          status: 'guardrail_refusal',
          answer: providerRefusal,
          sources: [{ title: 'Invented source' }],
          followUps: ['Unsafe follow-up']
        };
      }
    }
  });

  const result = await assistant.ask({
    question: 'What should I take?', scope: 'library', resolveEvidenceSource: resolver
  });
  assert.deepEqual(result, {
    answer: GUARDRAIL_REFUSAL_ANSWER,
    followUps: [],
    guardrailMode: 'standard',
    sources: [],
    status: 'guardrail_refusal'
  });
  assert.notEqual(result.answer, NO_EVIDENCE_ANSWER);
  assert.doesNotMatch(JSON.stringify(result), /private treatment|Invented|Unsafe follow-up/);
});

test('assistant passes an explicit experimental mode without weakening evidence canonicalization', async () => {
  let generateCalls = 0;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve(request) {
        assert.equal(request.guardrailMode, 'experimental');
        assert.deepEqual(Object.keys(request).sort(), ['limit', 'question', 'scope', 'slug']);
        return [
          candidate({ sourceEtag: 'stale-etag' }),
          candidate({ id: 'valid' })
        ];
      },
      async generate(request) {
        generateCalls += 1;
        assert.equal(request.guardrailMode, 'experimental');
        assert.deepEqual(Object.keys(request).sort(), ['evidence', 'question', 'scope']);
        assert.equal(request.evidence.length, 1);
        return { status: 'answered', answer: 'Take 20 mg daily. [1]' };
      }
    }
  });

  const result = await assistant.ask({
    question: 'What should I take?',
    scope: 'library',
    guardrailMode: 'experimental',
    resolveEvidenceSource: resolver
  });
  assert.equal(generateCalls, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.guardrailMode, 'experimental');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, '/research/grounded-note#main-finding');
});

test('assistant rejects a provider guardrail refusal in Experimental mode', async () => {
  const assistant = createResearchAssistant({
    provider: {
      async retrieve() { return [candidate()]; },
      async generate() {
        return {
          status: 'guardrail_refusal',
          answer: 'Provider-authored refusal.',
          sources: [],
          followUps: []
        };
      }
    }
  });
  await assert.rejects(
    assistant.ask({
      question: 'What should I take?',
      scope: 'library',
      guardrailMode: 'experimental',
      resolveEvidenceSource: resolver
    }),
    ResearchAssistantInvalidResponseError
  );
});

test('assistant rejects unsupported guardrail modes before retrieval', async () => {
  let retrieveCalls = 0;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve() { retrieveCalls += 1; return []; },
      async generate() { assert.fail('Generation must not run.'); }
    }
  });
  await assert.rejects(
    assistant.ask({
      question: 'What is supported?',
      scope: 'library',
      guardrailMode: 'off',
      resolveEvidenceSource: resolver
    }),
    ResearchAssistantInvalidResponseError
  );
  assert.equal(retrieveCalls, 0);
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

test('assistant propagates abort signals without changing the enumerable provider contract', async () => {
  const controller = new AbortController();
  const observations = [];
  let retrievalSignal;
  let generationSignal;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve(request) {
        retrievalSignal = request.signal;
        assert.deepEqual(request, {
          question: 'What is supported?', scope: 'library', slug: '', limit: 8
        });
        return [candidate()];
      },
      async generate(request) {
        generationSignal = request.signal;
        assert.equal(request.guardrailMode, 'standard');
        assert.deepEqual(Object.keys(request).sort(), ['evidence', 'question', 'scope']);
        return { status: 'answered', answer: 'A supported result. [1]' };
      }
    }
  });

  const result = await assistant.ask({
    question: 'What is supported?',
    scope: 'library',
    resolveEvidenceSource: resolver,
    signal: controller.signal,
    observe(detail) { observations.push(detail); }
  });

  assert.equal(result.status, 'answered');
  assert.equal(retrievalSignal, controller.signal);
  assert.equal(generationSignal, controller.signal);
  assert.deepEqual(observations.map((item) => item.stage), [
    'retrieval', 'canonicalization', 'generation', 'result'
  ]);
  assert.equal(observations[0].count, 1);
  assert.equal(observations[1].count, 1);
  assert.equal(observations[3].sourceCount, 1);
});

test('ask route maps provider failures to bounded public-safe JSON without logging content', async () => {
  const cases = [
    ['configuration', 503, 'assistant_unavailable'],
    ['authentication', 503, 'assistant_unavailable'],
    ['authorization', 503, 'assistant_unavailable'],
    ['unavailable', 503, 'assistant_unavailable'],
    ['grounding', 502, 'grounding_failed'],
    ['timeout', 504, 'assistant_timeout'],
    ['upstream', 502, 'assistant_upstream_failed']
  ];
  const originalInfo = console.info;
  const logs = [];
  console.info = (value) => logs.push(String(value));

  try {
    for (const [kind, status, code] of cases) {
      const failure = new Error('secret provider detail');
      failure.researchAssistantErrorKind = kind;
      const response = await invokeAskRoute({
        isAvailable() { return true; },
        async ask() { throw failure; }
      }, { question: 'private health detail must never be logged', scope: 'library' });

      assert.equal(response.statusCode, status);
      assert.equal(response.body.error.code, code);
      assert.doesNotMatch(JSON.stringify(response.body), /secret provider|private health/);
      assert.match(response.headers['X-Request-Id'], /^[0-9a-f-]{36}$/);
    }

    const throttled = new Error('secret throttle detail');
    throttled.researchAssistantErrorKind = 'throttled';
    throttled.retryAfterSeconds = 9999;
    const throttledResponse = await invokeAskRoute({
      isAvailable() { return true; },
      async ask() { throw throttled; }
    });
    assert.equal(throttledResponse.statusCode, 503);
    assert.equal(throttledResponse.body.error.code, 'assistant_busy');
    assert.equal(throttledResponse.headers['Retry-After'], '120');
    assert.equal(throttledResponse.body.error.retryAfterSeconds, 120);

    const unexpectedResponse = await invokeAskRoute({
      isAvailable() { return true; },
      async ask() { throw new Error('sensitive unexpected detail'); }
    });
    assert.equal(unexpectedResponse.statusCode, 500);
    assert.equal(unexpectedResponse.body.error.code, 'assistant_failed');
    assert.doesNotMatch(JSON.stringify(unexpectedResponse.body), /sensitive unexpected/);

    const groundingResponse = await invokeAskRoute({
      isAvailable() { return true; },
      async ask() { throw new ResearchAssistantInvalidResponseError('sensitive grounding detail'); }
    });
    assert.equal(groundingResponse.statusCode, 502);
    assert.equal(groundingResponse.body.error.code, 'grounding_failed');

    const unavailableResponse = await invokeAskRoute({
      isAvailable() { return true; },
      async ask() { throw new ResearchAssistantUnavailableError('sensitive unavailable detail'); }
    });
    assert.equal(unavailableResponse.statusCode, 503);
    assert.equal(unavailableResponse.body.error.code, 'assistant_unavailable');

    const repositoryResponse = await invokeAskRoute({
      isAvailable() { return true; },
      async ask() { throw new Error('Assistant should not run.'); }
    }, {
      question: 'private article question', scope: 'article', slug: 'grounded-note'
    }, {
      async getArticle() { throw new Error('sensitive repository detail'); }
    });
    assert.equal(repositoryResponse.statusCode, 500);
    assert.equal(repositoryResponse.body.error.code, 'assistant_failed');

    assert.doesNotMatch(
      logs.join('\n'),
      /secret provider|private health|secret throttle|sensitive unexpected|sensitive grounding|sensitive unavailable|private article|sensitive repository/
    );
    logs.forEach((line) => {
      const event = JSON.parse(line);
      assert.equal(event.event, 'research_assistant_request');
      assert.equal(typeof event.requestId, 'string');
      assert.equal(event.scope === 'library' || event.scope === 'article', true);
    });
  } finally {
    console.info = originalInfo;
  }
});

test('ask route records an explicit keyword fallback mode without request content', async () => {
  const originalInfo = console.info;
  const logs = [];
  console.info = (value) => logs.push(String(value));
  try {
    const response = await invokeAskRoute({
      isAvailable() { return true; },
      async ask(request) {
        request.observe({ stage: 'retrieval_mode', mode: 'keyword_fallback', category: 'embedding_unavailable' });
        return { answer: NO_EVIDENCE_ANSWER, followUps: [], guardrailMode: 'standard', sources: [], status: 'no_evidence' };
      }
    }, { question: 'private fallback question', scope: 'library' });
    assert.equal(response.statusCode, 200);
    const event = JSON.parse(logs.at(-1));
    assert.equal(event.retrievalMode, 'keyword_fallback');
    assert.equal(event.retrievalFallbackCategory, 'embedding_unavailable');
    assert.doesNotMatch(JSON.stringify(event), /private fallback question/);
  } finally {
    console.info = originalInfo;
  }
});

test('ask route admits only one global provider call and releases capacity afterward', async () => {
  let starts = 0;
  let finishFirst;
  const completed = {
    answer: NO_EVIDENCE_ANSWER,
    followUps: [],
    sources: [],
    status: 'no_evidence'
  };
  const assistant = {
    isAvailable() { return true; },
    async ask() {
      starts += 1;
      if (starts === 1) {
        return new Promise((resolve) => { finishFirst = () => resolve(completed); });
      }
      return completed;
    }
  };
  const invoke = createAskRouteInvoker(assistant);
  const originalInfo = console.info;
  console.info = () => {};

  try {
    const first = invoke(undefined, '203.0.113.1');
    await new Promise((resolve) => setImmediate(resolve));
    const concurrent = await invoke(undefined, '203.0.113.2');

    assert.equal(starts, 1);
    assert.equal(concurrent.statusCode, 503);
    assert.equal(concurrent.body.error.code, 'assistant_busy');
    assert.equal(concurrent.headers['Retry-After'], '1');

    finishFirst();
    const firstResponse = await first;
    assert.equal(firstResponse.statusCode, 200);

    const afterward = await invoke(undefined, '203.0.113.3');
    assert.equal(afterward.statusCode, 200);
    assert.equal(starts, 2);
  } finally {
    console.info = originalInfo;
  }
});

test('ask route counts attempted starts against a UTC daily limit and resets next day', async () => {
  let currentTime = Date.UTC(2026, 6, 17, 23, 59, 50);
  let starts = 0;
  const assistant = {
    isAvailable() { return true; },
    async ask() {
      starts += 1;
      if (starts === 1) throw new Error('failed attempts still count');
      return {
        answer: NO_EVIDENCE_ANSWER,
        followUps: [],
        sources: [],
        status: 'no_evidence'
      };
    }
  };
  const invoke = createAskRouteInvoker(assistant, {}, {
    costGuard: { dailyLimit: 2, now: () => currentTime }
  });
  const originalInfo = console.info;
  console.info = () => {};

  try {
    const failedAttempt = await invoke(undefined, '203.0.113.11');
    assert.equal(failedAttempt.statusCode, 500);
    const successfulAttempt = await invoke(undefined, '203.0.113.12');
    assert.equal(successfulAttempt.statusCode, 200);

    const limited = await invoke(undefined, '203.0.113.13');
    assert.equal(starts, 2);
    assert.equal(limited.statusCode, 503);
    assert.equal(limited.body.error.code, 'assistant_busy');
    assert.equal(limited.headers['Retry-After'], '10');
    assert.equal(limited.body.error.retryAfterSeconds, 10);

    currentTime += 10 * 1000;
    const nextDay = await invoke(undefined, '203.0.113.14');
    assert.equal(nextDay.statusCode, 200);
    assert.equal(starts, 3);
  } finally {
    console.info = originalInfo;
  }
});
