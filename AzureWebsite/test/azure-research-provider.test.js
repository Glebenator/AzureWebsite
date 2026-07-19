'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ANSWER_SCHEMA,
  AzureResearchProviderConfigurationError,
  AzureResearchProviderError,
  DEFAULT_GUARDRAIL_MODE,
  MODEL_SCOPE,
  SEARCH_SCOPE,
  createAzureResearchProvider
} = require('../services/azure-research-provider');

function environment(overrides = {}) {
  return {
    RESEARCH_ASSISTANT_ENABLED: 'true',
    AZURE_SEARCH_ENDPOINT: 'https://example-search.search.windows.net',
    AZURE_SEARCH_INDEX: 'research-chunks-v1',
    AZURE_OPENAI_ENDPOINT: 'https://example-model.openai.azure.com',
    AZURE_OPENAI_DEPLOYMENT: 'research-luna-2026-07-09',
    ...overrides
  };
}

function credential(calls = []) {
  return {
    async getToken(scope) {
      calls.push(scope);
      return { token: scope === SEARCH_SCOPE ? 'search-token' : 'model-token' };
    }
  };
}

function json(value, status = 200, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function evidence(overrides = {}) {
  return {
    number: 1,
    id: 'chunk-1',
    articleSlug: 'grounded-note',
    title: 'Grounded note',
    headingId: 'main-finding',
    heading: 'Main finding',
    excerpt: 'A supported finding.',
    content: 'The note reports a supported finding with important limitations.',
    sourceEtag: 'etag-1',
    url: '/research/grounded-note#main-finding',
    ...overrides
  };
}

test('provider stays disabled without configuration and rejects enabled partial or key-based configuration', () => {
  assert.equal(createAzureResearchProvider({ env: {} }), null);
  assert.equal(createAzureResearchProvider({ env: { RESEARCH_ASSISTANT_ENABLED: 'false' } }), null);

  assert.throws(
    () => createAzureResearchProvider({ env: environment({ AZURE_SEARCH_INDEX: undefined }) }),
    AzureResearchProviderConfigurationError
  );
  assert.throws(
    () => createAzureResearchProvider({
      env: environment({ AZURE_SEARCH_ENDPOINT: 'http://example-search.search.windows.net' })
    }),
    AzureResearchProviderConfigurationError
  );
  assert.throws(
    () => createAzureResearchProvider({
      env: environment(),
      apiKey: 'keys-are-not-supported'
    }),
    /API-key authentication is not supported/
  );
  assert.throws(
    () => createAzureResearchProvider({ env: environment({ RESEARCH_ASSISTANT_ENABLED: 'yes' }) }),
    (error) => error.researchAssistantErrorKind === 'configuration'
  );
});

test('retrieve uses managed identity, keyword search, canonical fields, and article filtering', async () => {
  const tokenScopes = [];
  let request;
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(tokenScopes),
    async fetch(url, options) {
      request = { url, options };
      return json({
        value: [{
          id: 'chunk-1',
          articleSlug: 'grounded-note',
          articleTitle: 'Grounded note',
          headingId: 'main-finding',
          headingLabel: 'Main finding',
          content: 'A supported finding with limitations.',
          sourceEtag: 'etag-1',
          url: 'https://invented.example'
        }]
      });
    }
  });

  const result = await provider.retrieve({
    question: 'What is supported?',
    scope: 'article',
    slug: 'grounded-note',
    limit: 8
  });

  assert.equal(DEFAULT_GUARDRAIL_MODE, 'standard');

  assert.deepEqual(tokenScopes, [SEARCH_SCOPE]);
  assert.match(request.url, /^https:\/\/example-search\.search\.windows\.net\/indexes\/research-chunks-v1\/docs\/search\?/);
  assert.equal(request.options.headers.Authorization, 'Bearer search-token');
  assert.equal('api-key' in request.options.headers, false);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    search: 'What is supported?',
    queryType: 'simple',
    searchMode: 'any',
    top: 8,
    select: 'id,articleSlug,articleTitle,headingId,headingLabel,content,sourceEtag',
    filter: "articleSlug eq 'grounded-note'"
  });
  assert.deepEqual(result, [{
    id: 'chunk-1',
    articleSlug: 'grounded-note',
    articleTitle: 'Grounded note',
    headingId: 'main-finding',
    headingLabel: 'Main finding',
    excerpt: 'A supported finding with limitations.',
    content: 'A supported finding with limitations.',
    sourceEtag: 'etag-1'
  }]);
  assert.doesNotMatch(JSON.stringify(result), /invented\.example/);
});

test('hybrid retrieval combines the keyword query with a validated embedding and falls back explicitly', async () => {
  const requests = [];
  const observations = [];
  const vector = Array.from({ length: 1536 }, () => 0.25);
  const provider = createAzureResearchProvider({
    env: environment({
      RESEARCH_RETRIEVAL_MODE: 'hybrid',
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'research-embedding-3-small'
    }),
    credential: credential(),
    embeddingClient: { async embed() { return [vector]; } },
    async fetch(_url, options) { requests.push(JSON.parse(options.body)); return json({ value: [] }); }
  });
  await provider.retrieve({ question: 'paraphrased question', scope: 'article', slug: 'grounded-note', limit: 8, observe: (detail) => observations.push(detail) });
  assert.equal(requests[0].search, 'paraphrased question');
  assert.deepEqual(requests[0].vectorQueries, [{ kind: 'vector', vector, fields: 'contentVector', k: 32 }]);
  assert.equal(requests[0].vectorFilterMode, 'preFilter');
  assert.deepEqual(observations, [{ stage: 'retrieval_mode', mode: 'hybrid' }]);

  const fallbackObservations = [];
  const fallback = createAzureResearchProvider({
    env: environment({ RESEARCH_RETRIEVAL_MODE: 'hybrid', AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'research-embedding-3-small' }),
    credential: credential(),
    embeddingClient: { async embed() {
      const { AzureEmbeddingError } = require('../services/azure-embedding-client');
      throw new AzureEmbeddingError('embedding_unavailable', 'temporary failure', { kind: 'unavailable' });
    } },
    async fetch(_url, options) { return json({ value: [] }); }
  });
  await fallback.retrieve({ question: 'paraphrased question', scope: 'library', slug: '', limit: 8, observe: (detail) => fallbackObservations.push(detail) });
  assert.deepEqual(fallbackObservations, [{ stage: 'retrieval_mode', mode: 'keyword_fallback', category: 'embedding_unavailable' }]);
});

test('comparison retrieval expands candidates and prevents one article from consuming the evidence window', async () => {
  let request;
  const values = [];
  for (let index = 0; index < 9; index += 1) {
    values.push({
      id: `d-${index}`,
      articleSlug: 'vitamin-d-note',
      articleTitle: 'Vitamin D Note',
      headingId: `finding-${index}`,
      headingLabel: `Finding ${index}`,
      content: `Vitamin D finding ${index}.`,
      sourceEtag: 'd-etag'
    });
  }
  for (let index = 0; index < 4; index += 1) {
    values.push({
      id: `c-${index}`,
      articleSlug: 'vitamin-c-note',
      articleTitle: 'Vitamin C Note',
      headingId: `finding-${index}`,
      headingLabel: `Finding ${index}`,
      content: `Vitamin C finding ${index}.`,
      sourceEtag: 'c-etag'
    });
  }
  const provider = createAzureResearchProvider({
    env: environment(), credential: credential(),
    async fetch(_url, options) { request = JSON.parse(options.body); return json({ value: values }); }
  });
  const result = await provider.retrieve({
    question: 'How do vitamin C and vitamin D differ?', scope: 'library', slug: '', limit: 8
  });
  assert.equal(request.top, 32);
  assert.equal(result.length, 8);
  assert.equal(result.filter((item) => item.articleSlug === 'vitamin-d-note').length, 4);
  assert.equal(result.filter((item) => item.articleSlug === 'vitamin-c-note').length, 4);
});

test('catalog-targeted comparisons run filtered searches and interleave evidence from every article', async () => {
  const requests = [];
  const provider = createAzureResearchProvider({
    env: environment(), credential: credential(),
    async fetch(_url, options) {
      const request = JSON.parse(options.body);
      requests.push(request);
      const slug = request.filter.match(/'([^']+)'/)[1];
      return json({ value: Array.from({ length: 8 }, (_, index) => ({
        id: `${slug}-${index}`,
        articleSlug: slug,
        articleTitle: slug === 'vitamin-c-note' ? 'Vitamin C Note' : 'Vitamin D Note',
        headingId: `finding-${index}`,
        headingLabel: `Finding ${index}`,
        content: `Finding ${index} from ${slug}.`,
        sourceEtag: `${slug}-etag`
      })) });
    }
  });
  const result = await provider.retrieve({
    question: 'How do vitamin C and vitamin D differ?',
    scope: 'library', slug: '', limit: 8,
    targetSlugs: ['vitamin-c-note', 'vitamin-d-note']
  });
  assert.deepEqual(requests.map((request) => request.filter), [
    "articleSlug eq 'vitamin-c-note'",
    "articleSlug eq 'vitamin-d-note'"
  ]);
  assert.ok(requests.every((request) => request.top === 8));
  assert.deepEqual(result.map((item) => item.articleSlug), [
    'vitamin-c-note', 'vitamin-d-note', 'vitamin-c-note', 'vitamin-d-note',
    'vitamin-c-note', 'vitamin-d-note', 'vitamin-c-note', 'vitamin-d-note'
  ]);
});

test('retrieval mode accepts only keyword or hybrid', () => {
  assert.throws(
    () => createAzureResearchProvider({ env: environment({ RESEARCH_RETRIEVAL_MODE: 'vector-only' }) }),
    AzureResearchProviderConfigurationError
  );
  assert.throws(
    () => createAzureResearchProvider({ env: environment({ RESEARCH_RETRIEVAL_MODE: 'hybrid' }) }),
    /AZURE_OPENAI_EMBEDDING_DEPLOYMENT/
  );
});

test('retrieve retries only 429 and 503 with bounded delays', async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  let calls = 0;
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => {
      const status = statuses[calls];
      calls += 1;
      return status === 200 ? json({ value: [] }) : json({}, status);
    },
    sleep: async (milliseconds) => delays.push(milliseconds)
  });

  assert.deepEqual(await provider.retrieve({
    question: 'What is supported?', scope: 'library', slug: '', limit: 8
  }), []);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);

  let permanentCalls = 0;
  const permanent = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => {
      permanentCalls += 1;
      return json({}, 500);
    },
    sleep: async () => assert.fail('Permanent failures must not be retried.')
  });
  await assert.rejects(
    permanent.retrieve({ question: 'What is supported?', scope: 'library', slug: '', limit: 8 }),
    (error) => error.code === 'provider_upstream_error'
      && error.researchAssistantErrorKind === 'upstream'
  );
  assert.equal(permanentCalls, 1);
});

test('retrieve exposes safe throttling metadata after retries are exhausted', async () => {
  let calls = 0;
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => {
      calls += 1;
      return json({}, 429, { 'Retry-After': '7' });
    },
    sleep: async () => {}
  });

  await assert.rejects(
    provider.retrieve({ question: 'What is supported?', scope: 'library', slug: '', limit: 8 }),
    (error) => error instanceof AzureResearchProviderError
      && error.researchAssistantErrorKind === 'throttled'
      && error.retryAfterSeconds === 7
  );
  assert.equal(calls, 4);
});

test('generate uses Responses with store disabled and assembles citations and follow-ups server-side', async () => {
  const tokenScopes = [];
  let request;
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(tokenScopes),
    async fetch(url, options) {
      request = { url, options };
      return json({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              status: 'answered',
              claims: [{ text: 'The note supports a bounded finding.', evidenceNumbers: [1] }],
              followUps: ['Take an unsafe generated action.'],
              sources: [{ url: 'https://invented.example' }]
            })
          }]
        }]
      });
    }
  });

  const result = await provider.generate({
    question: 'What is supported?', scope: 'article', evidence: [evidence()]
  });

  assert.deepEqual(tokenScopes, [MODEL_SCOPE]);
  assert.equal(request.url, 'https://example-model.openai.azure.com/openai/v1/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer model-token');
  assert.equal('api-key' in request.options.headers, false);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'research-luna-2026-07-09');
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, []);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema, ANSWER_SCHEMA);
  assert.match(body.instructions, /Do not give medical advice/);
  assert.match(body.instructions, /return guardrail_refusal with no claims/);
  assert.deepEqual(ANSWER_SCHEMA.properties.status.enum, [
    'answered', 'no_evidence', 'guardrail_refusal'
  ]);
  assert.doesNotMatch(body.input, /\/research\/|invented\.example/);
  assert.deepEqual(result, {
    status: 'answered',
    answer: 'The note supports a bounded finding. [1]',
    followUps: ['What limitations does this note discuss?', 'What evidence does this note cite?']
  });
  assert.doesNotMatch(JSON.stringify(result), /unsafe generated|invented\.example/);
});

test('generate returns a server-normalizable no-evidence result without model-authored text', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'no_evidence',
        claims: [],
        answer: 'Take a high dose.',
        followUps: ['Which dose?']
      })
    })
  });

  assert.deepEqual(await provider.generate({
    question: 'What dose should I take?', scope: 'library', evidence: [evidence()]
  }), { status: 'no_evidence', answer: '', followUps: [] });
});

test('generate accepts an explicit model guardrail refusal without model-authored text', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'guardrail_refusal',
        claims: [],
        answer: 'Model-authored refusal must not be shown.',
        followUps: ['Unsafe follow-up']
      })
    })
  });

  assert.deepEqual(await provider.generate({
    question: 'What should I take?', scope: 'library', evidence: [evidence()]
  }), { status: 'guardrail_refusal', answer: '', followUps: [] });
});

test('standard mode turns health-language output into an explicit guardrail refusal', async () => {
  const unsafeClaims = [
    'Take 20 mg daily.',
    'Avoid this medication.',
    'Continue treatment for six weeks.',
    'Do not stop treatment.',
    'Try 20 mg daily.',
    'You should stop treatment immediately.',
    'This supplement is guaranteed and risk-free.'
  ];

  for (const text of unsafeClaims) {
    const provider = createAzureResearchProvider({
      env: environment(),
      credential: credential(),
      fetch: async () => json({
        output_text: JSON.stringify({
          status: 'answered',
          claims: [{ text, evidenceNumbers: [1] }]
        })
      })
    });
    assert.deepEqual(await provider.generate({
      question: 'What is supported?', scope: 'library', evidence: [evidence()]
    }), { status: 'guardrail_refusal', answer: '', followUps: [] });
  }
});

test('standard mode permits grounded technical directives outside health context', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'answered',
        claims: [{
          text: 'Use TLS 1.3 for transport security.',
          evidenceNumbers: [1]
        }]
      })
    })
  });
  const result = await provider.generate({
    question: 'Which transport protocol does the note recommend?',
    scope: 'library',
    evidence: [evidence({
      title: 'Transport security',
    heading: 'Protocol selection',
      topicKey: 'security',
      content: 'The technical note recommends TLS 1.3 for transport security.'
    })]
  });
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Use TLS 1.3 for transport security. [1]');
});

test('standard mode evaluates health context from the full eighth cited evidence entry', async () => {
  const retrievedEvidence = Array.from({ length: 8 }, (_, index) => evidence({
    number: index + 1,
    id: `chunk-${index + 1}`,
    articleSlug: `note-${index + 1}`,
    title: `Note ${index + 1}`,
    headingId: `finding-${index + 1}`,
    heading: `Finding ${index + 1}`,
    content: index === 7
      ? `${'x'.repeat(5900)} clinical finding about the intervention.`
      : 'A technical background passage.'
  }));
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'answered',
        claims: [{ text: 'Use the cited approach.', evidenceNumbers: [8] }]
      })
    })
  });
  assert.deepEqual(await provider.generate({
    question: 'What approach does the note describe?',
    scope: 'library',
    evidence: retrievedEvidence
  }), { status: 'guardrail_refusal', answer: '', followUps: [] });
});

test('standard mode treats canonical health topic metadata as primary for neutral wording', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'answered',
        claims: [{ text: 'Use the cited approach.', evidenceNumbers: [1] }]
      })
    })
  });
  assert.deepEqual(await provider.generate({
    question: 'What approach does the note describe?',
    scope: 'library',
    evidence: [evidence({
      articleSlug: 'marijuana-consumption-effects-research',
      title: 'Plant Research Note',
      heading: 'Observations',
      content: 'The note describes measured outcomes.',
      topicKey: 'health'
    })]
  }), { status: 'guardrail_refusal', answer: '', followUps: [] });
});

test('standard mode uses only each claim\'s cited evidence for contextual health patterns', async () => {
  const mixedEvidence = [
    evidence({
      number: 1,
      id: 'health-chunk',
      title: 'Clinical evidence',
      heading: 'Patient findings',
      topicKey: 'health',
      content: 'The clinical evidence describes a treatment outcome.'
    }),
    evidence({
      number: 2,
      id: 'tls-chunk',
      articleSlug: 'transport-security',
      title: 'Transport security',
      headingId: 'protocol-selection',
      heading: 'Protocol selection',
      topicKey: 'security',
      content: 'The technical note recommends TLS 1.3 for transport security.'
    })
  ];
  const drafts = [
    { status: 'answered', claims: [{ text: 'Use TLS 1.3 for transport security.', evidenceNumbers: [2] }] },
    { status: 'answered', claims: [{ text: 'Use the cited approach.', evidenceNumbers: [1] }] }
  ];
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({ output_text: JSON.stringify(drafts.shift()) })
  });

  const technical = await provider.generate({
    question: 'For this health and TLS comparison, which transport protocol is recommended?',
    scope: 'library',
    evidence: mixedEvidence
  });
  assert.equal(technical.status, 'answered');
  assert.equal(technical.answer, 'Use TLS 1.3 for transport security. [2]');

  assert.deepEqual(await provider.generate({
    question: 'What approach is described?',
    scope: 'library',
    evidence: mixedEvidence
  }), { status: 'guardrail_refusal', answer: '', followUps: [] });
});

test('generate rejects model-authored, missing, and out-of-range citation data in every mode', async () => {
  async function rejects(claim) {
    const provider = createAzureResearchProvider({
      env: environment(),
      credential: credential(),
      fetch: async () => json({
        output_text: JSON.stringify({ status: 'answered', claims: [claim] })
      })
    });
    for (const mode of ['standard', 'experimental']) {
      await assert.rejects(
        provider.generate({
          question: 'What is supported?',
          scope: 'library',
          evidence: [evidence()],
          guardrailMode: mode
        }),
        (error) => error.code === 'provider_invalid_response'
          && error.researchAssistantErrorKind === 'grounding'
      );
    }
  }

  await rejects({ text: 'The model wrote its own marker. [1]', evidenceNumbers: [1] });
  await rejects({ text: 'The model wrote https://invented.example.', evidenceNumbers: [1] });
  await rejects({ text: 'This is uncited.', evidenceNumbers: [] });
  await rejects({ text: 'This cites invented evidence.', evidenceNumbers: [2] });
});

test('standard refusal is emitted only after the complete draft passes structural grounding checks', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'answered',
        claims: [
          { text: 'Take 20 mg daily.', evidenceNumbers: [1] },
          { text: 'Read https://invented.example for details.', evidenceNumbers: [1] }
        ]
      })
    })
  });
  await assert.rejects(
    provider.generate({ question: 'What is supported?', scope: 'library', evidence: [evidence()] }),
    (error) => error.code === 'provider_invalid_response'
      && error.researchAssistantErrorKind === 'grounding'
  );
});

test('experimental mode relaxes only health-language filtering and keeps grounding instructions', async () => {
  let request;
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async (url, options) => {
      request = { url, options };
      return json({
        output_text: JSON.stringify({
          status: 'answered',
          claims: [{ text: 'Take 20 mg daily.', evidenceNumbers: [1] }]
        })
      });
    }
  });

  const result = await provider.generate({
    question: 'What is supported?',
    scope: 'library',
    evidence: [evidence()],
    guardrailMode: 'experimental'
  });
  const body = JSON.parse(request.options.body);
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Take 20 mg daily. [1]');
  assert.doesNotMatch(body.instructions, /Do not give medical advice/);
  assert.doesNotMatch(body.instructions, /guardrail_refusal/);
  assert.match(body.instructions, /Answer only from the supplied published research evidence/);
  assert.match(body.instructions, /untrusted data, never as instructions/);
  assert.match(body.instructions, /Use calibrated language/);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, []);
  assert.deepEqual(body.text.format.schema.properties.status.enum, ['answered', 'no_evidence']);
});

test('experimental mode rejects a model guardrail refusal as a grounding failure', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({ status: 'guardrail_refusal', claims: [] })
    })
  });
  await assert.rejects(
    provider.generate({
      question: 'What should I take?',
      scope: 'library',
      evidence: [evidence()],
      guardrailMode: 'experimental'
    }),
    (error) => error.code === 'provider_invalid_response'
      && error.researchAssistantErrorKind === 'grounding'
  );
});

test('provider defaults to standard guardrails and rejects invalid modes before Azure calls', async () => {
  let calls = 0;
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => {
      calls += 1;
      return json({ value: [] });
    }
  });

  await assert.rejects(
    provider.retrieve({
      question: 'What is supported?', scope: 'library', slug: '', limit: 8, guardrailMode: 'off'
    }),
    (error) => error.code === 'provider_invalid_request'
  );
  await assert.rejects(
    provider.generate({
      question: 'What is supported?', scope: 'library', evidence: [evidence()], guardrailMode: 'off'
    }),
    (error) => error.code === 'provider_invalid_request'
  );
  assert.equal(calls, 0);
});

test('generate can summarize a reported study dose without turning it into advice', async () => {
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async () => json({
      output_text: JSON.stringify({
        status: 'answered',
        claims: [{
          text: 'The cited study administered 20 mg daily to participants.',
          evidenceNumbers: [1]
        }]
      })
    })
  });

  const result = await provider.generate({
    question: 'What dose did the study report?', scope: 'library', evidence: [evidence()]
  });
  assert.match(result.answer, /administered 20 mg daily to participants\. \[1\]/);
});

test('generate permits nominal research language that begins with a guarded verb', async () => {
  const neutralClaims = [
    'Use of alcohol was associated with the reported outcome.',
    'Increase in risk was observed in the cited cohort.',
    'Decrease in incidence appeared during follow-up.',
    'Start of symptoms occurred after the measured exposure.'
  ];

  for (const text of neutralClaims) {
    const provider = createAzureResearchProvider({
      env: environment(),
      credential: credential(),
      fetch: async () => json({
        output_text: JSON.stringify({
          status: 'answered',
          claims: [{ text, evidenceNumbers: [1] }]
        })
      })
    });
    const result = await provider.generate({
      question: 'What did the research report?', scope: 'library', evidence: [evidence()]
    });
    assert.equal(result.status, 'answered');
    assert.match(result.answer, /\[1\]$/);
  }
});

test('generate never retries and maps authorization and throttling safely', async () => {
  for (const [status, kind] of [[403, 'authorization'], [429, 'throttled'], [503, 'unavailable']]) {
    let calls = 0;
    const provider = createAzureResearchProvider({
      env: environment(),
      credential: credential(),
      fetch: async () => {
        calls += 1;
        return json({}, status, status === 429 ? { 'Retry-After': '3' } : undefined);
      }
    });
    await assert.rejects(
      provider.generate({ question: 'What is supported?', scope: 'library', evidence: [evidence()] }),
      (error) => error.researchAssistantErrorKind === kind
        && (status !== 429 || error.retryAfterSeconds === 3)
    );
    assert.equal(calls, 1);
  }
});

test('caller cancellation aborts the provider request with safe timeout metadata', async () => {
  const controller = new AbortController();
  const provider = createAzureResearchProvider({
    env: environment(),
    credential: credential(),
    fetch: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('The raw operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
      controller.abort();
    })
  });

  await assert.rejects(
    provider.retrieve({
      question: 'What is supported?', scope: 'library', slug: '', limit: 8, signal: controller.signal
    }),
    (error) => error.researchAssistantErrorKind === 'timeout'
      && !String(error.message).includes('raw operation')
  );
});
