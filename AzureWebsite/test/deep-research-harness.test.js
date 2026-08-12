'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyQueryMode,
  createDeepResearchHarness,
  normalizeFreeModelCatalog,
  reviewCitations
} = require('../services/deep-research-harness');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function fakeResearchFetch(requests) {
  return async function(url, options = {}) {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    if (parsed.hostname === 'en.wikipedia.org' && parsed.searchParams.get('list') === 'search') {
      return jsonResponse({ query: { search: [{ title: 'Desalination' }, { title: 'Reverse osmosis' }] } });
    }
    if (parsed.hostname === 'en.wikipedia.org' && parsed.searchParams.get('prop') === 'extracts') {
      return jsonResponse({
        query: {
          pages: {
            1: { title: 'Desalination', extract: 'Desalination removes salts from water.' },
            2: { title: 'Reverse osmosis', extract: 'Reverse osmosis uses a membrane and pressure.' }
          }
        }
      });
    }
    if (parsed.hostname === 'openrouter.ai') {
      if (parsed.pathname === '/api/v1/models') {
        return jsonResponse({
          data: [
            {
              id: 'example/free-model:free',
              name: 'Example Free Model',
              context_length: 131072,
              architecture: { output_modalities: ['text'] },
              pricing: { prompt: '0', completion: '0', request: '0' }
            }
          ]
        });
      }
      return jsonResponse({
        model: 'example/free-model:free',
        choices: [{ message: { content: 'Desalination removes salts [1]. Reverse osmosis uses pressure and a membrane [2].' } }]
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
}

test('bounded harness exposes progress, evidence, and reference-valid synthesis', async () => {
  const requests = [];
  const events = [];
  const observations = [];
  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'test-key-not-a-secret',
    model: 'openrouter/free',
    fetch: fakeResearchFetch(requests)
  });

  const result = await harness.run({
    query: 'How does desalination work?',
    emit(event) { events.push(event); },
    observe(detail) { observations.push(detail); }
  });

  assert.equal(requests.length, 3);
  assert.equal(requests.filter((request) => request.url.hostname === 'openrouter.ai').length, 1);
  assert.equal(result.type, 'result');
  assert.equal(result.citations.length, 2);
  assert.equal(result.modelRequested, 'openrouter/free');
  assert.equal(result.modelUsed, 'example/free-model:free');
  assert.ok(events.some((event) => event.type === 'plan'));
  assert.ok(events.some((event) => event.type === 'evidence' && event.items.length === 2));
  assert.deepEqual(
    requests.filter((request) => request.url.hostname === 'en.wikipedia.org')
      .map((request) => request.url.pathname),
    ['/w/api.php', '/w/api.php']
  );
  assert.deepEqual(
    new Set(observations.map((detail) => detail.stage)),
    new Set([
      'wikipedia_search',
      'wikipedia_read',
      'prompt_construction',
      'model_request',
      'model_response',
      'validation'
    ])
  );
  const serializedObservations = JSON.stringify(observations);
  assert.doesNotMatch(serializedObservations, /How does desalination work/);
  assert.doesNotMatch(serializedObservations, /test-key-not-a-secret/);
  assert.doesNotMatch(serializedObservations, /Desalination removes salts \[1\]/);
});

test('free model catalog includes only text-capable zero-cost options and the free router', () => {
  const models = normalizeFreeModelCatalog({
    data: [
      {
        id: 'example/specific:free',
        name: 'Specific Free',
        context_length: 65536,
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0', request: '0' }
      },
      {
        id: 'example/zero-priced',
        name: 'Zero Priced',
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0', request: '0' }
      },
      {
        id: 'example/paid',
        name: 'Paid',
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0.0001', completion: '0', request: '0' }
      },
      {
        id: 'example/image:free',
        name: 'Image Only',
        architecture: { output_modalities: ['image'] },
        pricing: { prompt: '0', completion: '0', request: '0' }
      }
    ]
  });

  assert.deepEqual(models.map((item) => item.id), [
    'openrouter/free',
    'example/specific:free'
  ]);
  assert.equal(models[1].contextLength, 65536);
});

test('free model catalog is cached and a selected current free model reaches OpenRouter', async () => {
  const requests = [];
  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'server-only-key',
    model: 'openrouter/free',
    fetch: fakeResearchFetch(requests),
    modelCatalogTtlMs: 60000
  });

  const firstCatalog = await harness.listFreeModels();
  const secondCatalog = await harness.listFreeModels();
  assert.deepEqual(firstCatalog, secondCatalog);
  assert.equal(requests.filter((request) => request.url.pathname === '/api/v1/models').length, 1);

  const result = await harness.run({
    query: 'Hi, what model is this?',
    model: 'example/free-model:free'
  });
  const completionRequest = requests.find((request) => request.url.pathname === '/api/v1/chat/completions');
  assert.equal(JSON.parse(completionRequest.options.body).model, 'example/free-model:free');
  assert.equal(result.modelRequested, 'example/free-model:free');
  assert.equal(requests.filter((request) => request.url.pathname === '/api/v1/models').length, 1);
});

test('model selection rejects paid configuration and stale free identifiers', async () => {
  const paidHarness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'server-only-key',
    model: 'example/paid-model'
  });
  assert.equal(paidHarness.isAvailable(), false);
  assert.match(paidHarness.configurationIssue(), /:free/);

  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'server-only-key',
    model: 'openrouter/free',
    fetch: fakeResearchFetch([])
  });
  await assert.rejects(
    harness.resolveRequestedModel('example/removed-model:free'),
    (error) => error.code === 'free_model_unavailable' && error.status === 400
  );
});

test('harness fails closed on configuration but preserves uncited model output as a draft', async () => {
  const disabled = createDeepResearchHarness({ enabled: false, apiKey: '', model: 'openrouter/free' });
  assert.equal(disabled.isAvailable(), false);
  assert.match(disabled.configurationIssue(), /disabled/);

  const requests = [];
  const noCitationHarness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'test-key-not-a-secret',
    model: 'openrouter/free',
    fetch: async function(url, options) {
      const response = await fakeResearchFetch(requests)(url, options);
      if (new URL(url).hostname === 'openrouter.ai') {
        return jsonResponse({ model: 'example/free-model:free', choices: [{ message: { content: 'An uncited answer.' } }] });
      }
      return response;
    }
  });
  const result = await noCitationHarness.run({ query: 'How does desalination work?' });
  assert.equal(result.answer, 'An uncited answer.');
  assert.equal(result.mode, 'research');
  assert.equal(result.validation.citationSyntax, 'missing');
  assert.equal(result.validation.referenceValidity, 'incomplete');
  assert.equal(result.validation.semanticSupport, 'not_assessed');
  assert.deepEqual(result.citations, []);
  assert.match(result.qualification, /semantic support was not independently assessed/);
});

test('invalid model JSON records a bounded replay marker before anomaly capture', async () => {
  const dependencies = [];
  let captured;
  const recorder = {
    configurationIssue: null,
    startRun() {
      return {
        recordDependency(kind, fixture) { dependencies.push({ kind, ...fixture }); },
        async capture(category, summary) {
          captured = { category, summary };
          return { stored: false, reason: 'test_store' };
        }
      };
    }
  };
  const requests = [];
  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'test-key-not-a-secret',
    model: 'openrouter/free',
    diagnosticRecorder: recorder,
    fetch: async function(url, options) {
      if (new URL(url).hostname === 'openrouter.ai') {
        return new Response('{invalid-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return fakeResearchFetch(requests)(url, options);
    }
  });

  await assert.rejects(
    harness.run({ query: 'How does desalination work?' }),
    (error) => error.code === 'invalid_model_response'
  );

  const modelFixture = dependencies.find((item) => item.kind === 'model_completion');
  assert.deepEqual(modelFixture, {
    kind: 'model_completion',
    status: 200,
    responseKind: 'invalid_json'
  });
  assert.deepEqual(captured, {
    category: 'invalid_model_response',
    summary: { outcome: 'failed', failureCategory: 'invalid_response' }
  });
});

test('OpenRouter requests keep the key server-side and use the configured model', async () => {
  const requests = [];
  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'server-only-key',
    model: 'openrouter/free',
    fetch: fakeResearchFetch(requests)
  });
  await harness.run({ query: 'How does desalination work?' });
  const modelRequest = requests.find((request) => request.url.hostname === 'openrouter.ai');
  const body = JSON.parse(modelRequest.options.body);
  assert.equal(body.model, 'openrouter/free');
  assert.equal(modelRequest.options.headers.Authorization, 'Bearer server-only-key');
  assert.doesNotMatch(JSON.stringify(body), /server-only-key/);
});

test('quick chat is qualified and reaches OpenRouter without search or citation requirements', async () => {
  const requests = [];
  const events = [];
  const harness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'test-key-not-a-secret',
    model: 'openrouter/free',
    fetch: fakeResearchFetch(requests)
  });

  assert.equal(classifyQueryMode('Hi, what model is this?'), 'quick');
  assert.equal(classifyQueryMode('How does desalination work?'), 'research');
  const result = await harness.run({
    query: 'Hi, what model is this?',
    emit(event) { events.push(event); }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, 'openrouter.ai');
  assert.equal(result.mode, 'quick');
  assert.equal(result.validation.semanticSupport, 'not_applicable');
  assert.equal(result.evidenceCount, 0);
  assert.match(result.qualification, /No external sources/);
  assert.ok(events.some((event) => event.stage === 'qualify'));
  const body = JSON.parse(requests[0].options.body);
  assert.match(body.messages[1].content, /No web research or citations are required/);
});

test('citation review separates reference validity from semantic support and catches blatant topic mismatch', () => {
  const evidence = [{
    number: 1,
    title: 'HTTP cookie',
    url: 'https://en.wikipedia.org/wiki/HTTP_cookie',
    excerpt: 'An HTTP cookie is a small block of data created by a web server and stored by a browser.'
  }];
  const mismatch = reviewCitations(
    'How do browser cookies work?',
    'Microgrids coordinate distributed energy resources and battery dispatch [1].',
    evidence
  );
  assert.equal(mismatch.validation.citationSyntax, 'valid');
  assert.equal(mismatch.validation.referenceValidity, 'valid');
  assert.equal(mismatch.validation.topicAlignment, 'mismatch');
  assert.equal(mismatch.validation.semanticSupport, 'unsupported');

  const topical = reviewCitations(
    'How do browser cookies work?',
    'An HTTP cookie stores a small block of web-server data in a browser [1].',
    evidence
  );
  assert.equal(topical.validation.referenceValidity, 'valid');
  assert.equal(topical.validation.topicAlignment, 'aligned');
  assert.equal(topical.validation.semanticSupport, 'not_assessed');
});

test('missing, malformed, and out-of-range citations never imply support', () => {
  const evidence = [{ number: 1, title: 'Source', excerpt: 'Relevant source evidence.' }];
  const missing = reviewCitations('Relevant question', 'Relevant answer without a citation.', evidence);
  const malformed = reviewCitations('Relevant question', 'Relevant answer [source 1].', evidence);
  const outOfRange = reviewCitations('Relevant question', 'Relevant answer [2].', evidence);

  assert.equal(missing.validation.citationSyntax, 'missing');
  assert.equal(malformed.validation.citationSyntax, 'malformed');
  assert.equal(outOfRange.validation.referenceValidity, 'out_of_range');
  for (const review of [missing, malformed, outOfRange]) {
    assert.notEqual(review.validation.semanticSupport, 'supported');
  }
});

test('explicit composer mode routes direct answers and research while keeping simple model questions direct', async () => {
  assert.equal(classifyQueryMode('Explain reverse osmosis', 'direct'), 'quick');
  assert.equal(classifyQueryMode('Explain reverse osmosis', 'research'), 'research');
  assert.equal(classifyQueryMode('Hi, what model is this?', 'research'), 'quick');

  const directRequests = [];
  const directHarness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'test-key-not-a-secret',
    model: 'openrouter/free',
    fetch: fakeResearchFetch(directRequests)
  });
  const directResult = await directHarness.run({ query: 'Explain reverse osmosis', mode: 'direct' });
  assert.equal(directResult.mode, 'quick');
  assert.equal(directRequests.length, 1);

  const researchRequests = [];
  const researchHarness = createDeepResearchHarness({
    enabled: true,
    apiKey: 'test-key-not-a-secret',
    model: 'openrouter/free',
    fetch: fakeResearchFetch(researchRequests)
  });
  const researchResult = await researchHarness.run({ query: 'Explain reverse osmosis', mode: 'research' });
  assert.equal(researchResult.mode, 'research');
  assert.equal(researchRequests.length, 3);
});
