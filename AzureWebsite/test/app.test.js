const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const app = require('../app');
const portfolio = require('../data/portfolio');
const { filterAndSortArticles } = require('../routes/research');
const {
  ResearchStorageError,
  createMarkdownRenderer,
  createResearchRepository
} = require('../services/research-repository');
const {
  GUARDRAIL_REFUSAL_ANSWER,
  NO_EVIDENCE_ANSWER,
  ResearchAssistantInvalidResponseError,
  createResearchAssistant,
  normalizeResponse
} = require('../services/research-assistant');
const {
  buildDocuments,
  indexDefinition,
  markdownSections
} = require('../scripts/index-research');

async function withServer(run, application = app) {
  const server = application.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    await run(`http://${host}:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function createMockContainer(blobs) {
  return {
    async *listBlobsFlat() {
      for (const [name, source] of Object.entries(blobs)) {
        yield {
          name,
          properties: {
            contentLength: Buffer.byteLength(source),
            etag: `etag-${name}`,
            lastModified: new Date('2026-07-01T12:00:00.000Z')
          }
        };
      }
    },
    getBlobClient(name) {
      return {
        async download() {
          if (!(name in blobs)) throw new Error('missing mock blob');
          return { readableStreamBody: Readable.from([blobs[name]]) };
        }
      };
    }
  };
}

function researchSource(overrides = {}, body = '# Overview\n\nA **focused** research summary with useful context.') {
  const metadata = {
    title: 'A Useful Research Note',
    source_url: 'https://example.com/source',
    google_drive_id: 'private-drive-id',
    created_at: '2026-06-15T10:30:00.000Z',
    modified_at: '2026-07-01T12:00:00.000Z',
    ...overrides
  };
  const frontMatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return `---\n${frontMatter}\n---\n\n${body}`;
}

test('homepage renders verified portfolio content and security headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(response.headers.get('content-type'), /application\/json/);
    assert.match(html, /Gleb Gladyshevskiy/);
    assert.match(html, /CvkeHarness/);
    assert.match(html, /Skip to content/);
    assert.doesNotMatch(html, /mailto:|tel:|Live Demo|Download|Try It/);
  });
});

test('static visual and icon assets are served locally', async () => {
  await withServer(async (baseUrl) => {
    const [hero, icons] = await Promise.all([
      fetch(baseUrl + '/images/hero-systems-diagram.png'),
      fetch(baseUrl + '/icons/regular/style.css')
    ]);

    assert.equal(hero.status, 200);
    assert.match(hero.headers.get('content-type'), /image\/png/);
    assert.equal(icons.status, 200);
    assert.match(icons.headers.get('content-type'), /text\/css/);
  });
});

test('unknown routes render a generic public-safe error page', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/does-not-exist');
    const html = await response.text();

    assert.equal(response.status, 404);
    assert.match(html, /This page is off the map/);
    assert.doesNotMatch(html, /Error:|at Layer|node_modules/);
  });
});

test('all published destinations are HTTPS and placeholders remain null', () => {
  const links = [
    ...portfolio.social.map((item) => item.url),
    ...portfolio.projects.map((project) => project.actions.github.url)
  ];

  links.forEach((url) => assert.equal(new URL(url).protocol, 'https:'));
  portfolio.projects.forEach((project) => {
    assert.equal(project.actions.liveDemo, null);
    assert.equal(project.actions.download, null);
    assert.equal(project.actions.tryIt, null);
  });
});

test('Azure App Service trusts exactly one platform proxy hop', () => {
  const previousSiteName = process.env.WEBSITE_SITE_NAME;
  process.env.WEBSITE_SITE_NAME = 'cvkewebsite';
  try {
    const azureApp = app.createApp();
    assert.equal(azureApp.get('trust proxy'), 1);
  } finally {
    if (previousSiteName === undefined) {
      delete process.env.WEBSITE_SITE_NAME;
    } else {
      process.env.WEBSITE_SITE_NAME = previousSiteName;
    }
  }

  const localApp = app.createApp();
  assert.equal(localApp.get('trust proxy'), false);
});

test('research index lists enumerated Markdown blobs with metadata', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource()
    })
  });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/research');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /A Useful Research Note/);
    assert.match(html, /1\s+entry/);
    assert.match(html, /research, not medical advice/i);
    assert.match(html, /Ask across the archive/);
    assert.match(html, /Source-grounded answers are being connected/);
    assert.match(html, /data-assistant-available="false"/);
    assert.match(html, /href="\/research\/a-useful-research-note"/);
    assert.doesNotMatch(html, /private-drive-id/);
  }, researchApp);
});

test('research catalog cache avoids per-view listings and reuses ETag-matched articles', async () => {
  const source = researchSource();
  let currentTime = 0;
  let listCalls = 0;
  let downloadCalls = 0;
  const containerClient = {
    async *listBlobsFlat() {
      listCalls += 1;
      yield {
        name: 'cached-note.md',
        properties: {
          contentLength: Buffer.byteLength(source),
          etag: 'stable-etag',
          lastModified: new Date('2026-07-01T12:00:00.000Z')
        }
      };
    },
    getBlobClient() {
      return {
        async download() {
          downloadCalls += 1;
          return { readableStreamBody: Readable.from([source]) };
        }
      };
    }
  };
  const repository = createResearchRepository({
    cacheTtlMs: 10_000,
    containerClient,
    now: () => currentTime
  });

  await repository.listArticles();
  await repository.listArticles();
  assert.equal(listCalls, 1);
  assert.equal(downloadCalls, 1);

  currentTime = 10_001;
  await repository.listArticles();
  assert.equal(listCalls, 2);
  assert.equal(downloadCalls, 1);
});

test('research article renders Markdown and preserves safe source attribution', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource(
        {},
        '# Overview\n\n### Supporting detail\n\nA **focused** research summary with useful context.'
      )
    })
  });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/research/a-useful-research-note');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<h2 id="overview" class="research-section-heading">Overview/);
    assert.match(html, /href="#overview" class="heading-permalink"/);
    assert.match(html, /On this page/);
    assert.match(html, /class="toc-group" data-toc-group="overview" open/);
    assert.match(html, /class="back-to-top" href="#main-content" data-back-to-top hidden/);
    assert.match(html, /Ask this note/);
    assert.match(html, /Scope: <strong>A Useful Research Note<\/strong>/);
    assert.match(html, /A <strong>focused<\/strong> research summary/);
    assert.match(html, /href="https:\/\/example\.com\/source"/);
    assert.match(html, /Original source/);
  }, researchApp);
});

test('research slugs must resolve through the enumerated blob catalog', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'known-note.md': researchSource({ title: 'Known Note' })
    })
  });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/research/not-in-storage');
    const html = await response.text();

    assert.equal(response.status, 404);
    assert.match(html, /This page is off the map/);
  }, researchApp);
});

test('research rendering neutralizes raw HTML and unsafe link schemes', async () => {
  const unsafeSource = `${researchSource()}\n\n<script>alert('xss')</script>\n\n[unsafe](javascript:alert('xss'))`;
  const repository = createResearchRepository({
    containerClient: createMockContainer({ 'unsafe-note.md': unsafeSource })
  });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/research/unsafe-note');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal((html.match(/<script\b/gi) || []).length, 1);
    assert.match(html, /<script src="\/javascripts\/research\.js" defer><\/script>/);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, /onerror=/i);
  }, researchApp);
});

test('research citation callouts link to matching numbered references', () => {
  const renderMarkdown = createMarkdownRenderer();
  const rendered = renderMarkdown([
    'Evidence supports the first claim.1 A dose of 0.2 remains a decimal, and step 2 is ordinary text. [2, 3]',
    '',
    '#### **Works cited**',
    '',
    '1. First source, [https://example.com/one](https://example.com/one)  ',
    '2. Second source, [https://example.com/two](https://example.com/two)  ',
    '3. Third source, [https://example.com/three](https://example.com/three)'
  ].join('\n'));
  const html = rendered.html;

  assert.equal(rendered.citationCount, 3);
  assert.match(html, /href="#reference-1"[^>]*class="research-citation"/);
  assert.match(html, /href="#reference-2"[^>]*class="research-citation"/);
  assert.match(html, /href="#reference-3"[^>]*class="research-citation"/);
  assert.match(html, /data-reference-title="First source"/);
  assert.match(html, /data-reference-domain="example.com"/);
  assert.match(html, /<li id="reference-1" class="research-reference">/);
  assert.match(html, /href="#citation-1-1" class="reference-backlink"/);
  assert.match(html, /<h4 id="references" class="research-references-heading">/);
  assert.match(html, /A dose of 0\.2 remains a decimal, and step 2 is ordinary text/);
  assert.match(html, /href="https:\/\/example\.com\/one" rel="noopener noreferrer" target="_blank"/);

  const escapedListHtml = renderMarkdown([
    'Another supported claim.1',
    '',
    '#### **Works cited**',
    '',
    '1\\. First exported source, https://example.com/one 2\\. Second exported source, https://example.com/two'
  ].join('\n')).html;
  assert.match(escapedListHtml, /href="#reference-1"/);
  assert.match(escapedListHtml, /<li id="reference-1" class="research-reference">/);
  assert.match(escapedListHtml, /<li id="reference-2" class="research-reference">/);
});

test('research renderer creates stable TOC entries and duplicate-safe heading permalinks', () => {
  const rendered = createMarkdownRenderer()([
    '# Main Finding',
    '',
    '## Repeated section',
    '',
    '### Detail',
    '',
    '## Repeated section',
    '',
    '#### **Works cited**',
    '',
    '1. Example source, https://example.com'
  ].join('\n'));

  assert.deepEqual(rendered.toc, [
    { id: 'main-finding', label: 'Main Finding', level: 2 },
    { id: 'repeated-section', label: 'Repeated section', level: 2 },
    { id: 'detail', label: 'Detail', level: 3 },
    { id: 'repeated-section-2', label: 'Repeated section', level: 2 },
    { id: 'references', label: 'Works cited', level: 2 }
  ]);
  assert.match(rendered.html, /id="repeated-section-2"/);
  assert.match(rendered.html, /href="#repeated-section-2" class="heading-permalink"/);
});

test('research filtering searches metadata and supports every sort order', () => {
  const articles = [
    {
      title: 'Alpha Health', excerpt: 'Nutrition evidence', topic: { key: 'health' },
      readingMinutes: 5, modifiedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      title: 'Beta Systems', excerpt: 'Autonomous engines', topic: { key: 'technology' },
      readingMinutes: 2, modifiedAt: '2026-02-01T00:00:00.000Z'
    },
    {
      title: 'Gamma Culture', excerpt: 'Music and identity', topic: { key: 'culture' },
      readingMinutes: 8, modifiedAt: '2026-03-01T00:00:00.000Z'
    }
  ];

  assert.deepEqual(
    filterAndSortArticles([...articles], { q: 'engines', topic: 'technology', sort: 'newest' })
      .map((article) => article.title),
    ['Beta Systems']
  );
  assert.deepEqual(
    filterAndSortArticles([...articles], { q: '', topic: '', sort: 'newest' })
      .map((article) => article.title),
    ['Gamma Culture', 'Beta Systems', 'Alpha Health']
  );
  assert.deepEqual(
    filterAndSortArticles([...articles], { q: '', topic: '', sort: 'title' })
      .map((article) => article.title),
    ['Alpha Health', 'Beta Systems', 'Gamma Culture']
  );
  assert.deepEqual(
    filterAndSortArticles([...articles], { q: '', topic: '', sort: 'shortest' })
      .map((article) => article.title),
    ['Beta Systems', 'Alpha Health', 'Gamma Culture']
  );
  assert.deepEqual(
    filterAndSortArticles([...articles], { q: '', topic: '', sort: 'longest' })
      .map((article) => article.title),
    ['Gamma Culture', 'Alpha Health', 'Beta Systems']
  );
});

test('research query controls filter cached catalog data and handle invalid or empty results', async () => {
  const blobs = {
    'autonomous-taxi-ai-state-and-future.md': researchSource({
      title: 'Autonomous Taxi Systems',
      modified_at: '2026-03-01T00:00:00.000Z'
    }),
    'music-taste-factors-and-personality.md': researchSource({
      title: 'Music and Personality',
      modified_at: '2026-02-01T00:00:00.000Z'
    }),
    'vitamin-d-supplementation-research-overview.md': researchSource({
      title: 'Vitamin D Evidence',
      modified_at: '2026-01-01T00:00:00.000Z'
    })
  };
  const baseContainer = createMockContainer(blobs);
  let listCalls = 0;
  const containerClient = {
    async *listBlobsFlat() {
      listCalls += 1;
      for await (const blob of baseContainer.listBlobsFlat()) yield blob;
    },
    getBlobClient: baseContainer.getBlobClient
  };
  const repository = createResearchRepository({ containerClient });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const combined = await fetch(baseUrl + '/research?q=Taxi&topic=technology&sort=title');
    const combinedHtml = await combined.text();
    assert.equal(combined.status, 200);
    assert.match(combinedHtml, /Autonomous Taxi Systems/);
    assert.doesNotMatch(combinedHtml, /Music and Personality/);
    assert.match(combinedHtml, /1\s+of\s+3/);
    assert.match(combinedHtml, /value="Taxi"/);
    assert.match(combinedHtml, /value="technology" selected/);

    const noResults = await fetch(baseUrl + '/research?q=unfindable');
    const noResultsHtml = await noResults.text();
    assert.equal(noResults.status, 200);
    assert.match(noResultsHtml, /No matching research/);
    assert.match(noResultsHtml, /Clear filters/);

    const invalid = await fetch(baseUrl + '/research?topic=unknown&sort=unknown');
    const invalidHtml = await invalid.text();
    assert.equal(invalid.status, 200);
    assert.match(invalidHtml, /3\s+entries/);
    assert.doesNotMatch(invalidHtml, /value="unknown" selected/);
    assert.equal(listCalls, 1);
  }, researchApp);
});

test('research storage failures return a useful public-safe state', async () => {
  const researchApp = app.createApp({
    researchRepository: {
      async listArticles() {
        throw new ResearchStorageError('mock storage failure');
      },
      async getArticle() {
        throw new ResearchStorageError('mock storage failure');
      }
    }
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/research');
    const html = await response.text();

    assert.equal(response.status, 503);
    assert.match(html, /temporarily out of reach/);
    assert.doesNotMatch(html, /mock storage failure|ResearchStorageError/);
  }, researchApp);
});

test('application wires a configured research provider and never serves the local RAG ledger', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource()
    })
  });
  const researchApp = app.createApp({
    researchRepository: repository,
    researchProvider: {
      async retrieve() {
        return [{
          id: 'chunk-1',
          articleSlug: 'a-useful-research-note',
          articleTitle: 'Indexed title',
          headingId: 'overview',
          headingLabel: 'Indexed heading',
          excerpt: 'A focused research summary.',
          content: 'A focused research summary with useful context.',
          sourceEtag: 'etag-a-useful-research-note.md'
        }];
      },
      async generate() {
        return { status: 'answered', answer: 'The note provides a focused summary. [1]' };
      }
    }
  });

  await withServer(async (baseUrl) => {
    const page = await fetch(baseUrl + '/research');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-assistant-available="true"/);

    const response = await fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does this note contain?', scope: 'library' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, 'answered');
    assert.equal(payload.guardrailMode, 'standard');
    assert.equal(payload.sources[0].url, '/research/a-useful-research-note#overview');

    const ledger = await fetch(baseUrl + '/RAG_STATUS.html');
    assert.equal(ledger.status, 404);
    assert.doesNotMatch(await ledger.text(), /Research RAG implementation ledger/);
  }, researchApp);
});

test('research assistant returns a citation-validated answer for the requested scope', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource()
    })
  });
  let capturedRetrieval = null;
  let capturedGeneration = null;
  const assistant = createResearchAssistant({
    provider: {
      async retrieve(request) {
        capturedRetrieval = request;
        return [{
          id: 'chunk-1',
          articleSlug: 'a-useful-research-note',
          articleTitle: 'Provider-controlled title',
          headingId: 'overview',
          headingLabel: 'Provider-controlled heading',
          excerpt: 'A focused research summary with useful context.',
          content: 'A focused research summary with useful context.',
          sourceEtag: 'etag-a-useful-research-note.md'
        }];
      },
      async generate(request) {
        capturedGeneration = request;
        return {
          status: 'answered',
          answer: 'The note describes a focused research summary. [1]',
          followUps: ['What limitations does the note identify?']
        };
      }
    }
  });
  const researchApp = app.createApp({ researchAssistant: assistant, researchRepository: repository });

  await withServer(async (baseUrl) => {
    const page = await fetch(baseUrl + '/research/a-useful-research-note');
    const pageHtml = await page.text();
    assert.equal(page.status, 200);
    assert.match(pageHtml, /data-assistant-available="true"/);
    assert.doesNotMatch(pageHtml, /Source-grounded answers are being connected/);

    const response = await fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What does this note conclude?',
        scope: 'article',
        slug: 'a-useful-research-note'
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(capturedRetrieval, {
      question: 'What does this note conclude?',
      scope: 'article',
      slug: 'a-useful-research-note',
      limit: 8
    });
    assert.equal(capturedGeneration.evidence.length, 1);
    assert.equal(capturedGeneration.guardrailMode, 'standard');
    assert.equal(capturedGeneration.evidence[0].title, 'A Useful Research Note');
    assert.equal(capturedGeneration.evidence[0].heading, 'Overview');
    assert.equal(payload.sources[0].number, 1);
    assert.equal(payload.sources[0].url, '/research/a-useful-research-note#overview');
    assert.match(payload.answer, /\[1\]/);
    assert.equal(payload.guardrailMode, 'standard');
    assert.match(payload.notice, /not medical advice/i);
  }, researchApp);
});

test('research assistant guardrail modes preserve grounding and return distinct safe states', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource()
    })
  });
  const retrievals = [];
  const generations = [];
  const provider = {
    async retrieve(request) {
      retrievals.push(request);
      if (request.question.includes('missing evidence')) return [];
      return [{
        id: `chunk-${retrievals.length}`,
        articleSlug: 'a-useful-research-note',
        articleTitle: 'Provider-controlled title',
        headingId: 'overview',
        headingLabel: 'Provider-controlled heading',
        excerpt: 'A focused research summary with useful context.',
        content: 'A focused research summary with useful context.',
        sourceEtag: 'etag-a-useful-research-note.md'
      }];
    },
    async generate(request) {
      generations.push(request);
      if (request.question.includes('personal health') && request.guardrailMode === 'standard') {
        return {
          status: 'guardrail_refusal',
          answer: 'Provider-authored refusal text must not reach the browser.',
          followUps: ['Provider-authored follow-up must not reach the browser.']
        };
      }
      return {
        status: 'answered',
        answer: 'The published note supports this research summary. [1]'
      };
    }
  };
  const researchApp = app.createApp({
    researchAssistant: createResearchAssistant({ provider }),
    researchRepository: repository
  });

  async function ask(baseUrl, body) {
    const response = await fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { response, payload: await response.json() };
  }

  await withServer(async (baseUrl) => {
    const invalid = await ask(baseUrl, {
      question: 'What does this note contain?',
      scope: 'library',
      guardrailMode: 'disabled'
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error.code, 'invalid_guardrail_mode');
    assert.equal(retrievals.length, 0);
    assert.equal(generations.length, 0);

    const standard = await ask(baseUrl, {
      question: 'What does this note contain?', scope: 'library'
    });
    assert.equal(standard.response.status, 200);
    assert.equal(standard.payload.status, 'answered');
    assert.equal(standard.payload.guardrailMode, 'standard');
    assert.equal(generations.at(-1).guardrailMode, 'standard');

    const experimental = await ask(baseUrl, {
      question: 'Summarize the personal health research language.',
      scope: 'article',
      slug: 'a-useful-research-note',
      guardrailMode: 'experimental'
    });
    assert.equal(experimental.response.status, 200);
    assert.equal(experimental.payload.status, 'answered');
    assert.equal(experimental.payload.guardrailMode, 'experimental');
    assert.equal(generations.at(-1).guardrailMode, 'experimental');
    assert.equal(generations.at(-1).evidence[0].title, 'A Useful Research Note');
    assert.equal(experimental.payload.sources[0].url, '/research/a-useful-research-note#overview');
    assert.match(experimental.payload.notice, /not medical advice/i);
    assert.deepEqual(retrievals.at(-1), {
      question: 'Summarize the personal health research language.',
      scope: 'article',
      slug: 'a-useful-research-note',
      limit: 8
    });

    const noEvidence = await ask(baseUrl, {
      question: 'What missing evidence is available?',
      scope: 'library',
      guardrailMode: 'experimental'
    });
    assert.equal(noEvidence.response.status, 200);
    assert.equal(noEvidence.payload.status, 'no_evidence');
    assert.equal(noEvidence.payload.guardrailMode, 'experimental');
    assert.equal(noEvidence.payload.answer, NO_EVIDENCE_ANSWER);
    assert.deepEqual(noEvidence.payload.sources, []);
    assert.deepEqual(noEvidence.payload.followUps, []);

    const refusal = await ask(baseUrl, {
      question: 'Give me a personal health recommendation.',
      scope: 'library',
      guardrailMode: 'standard'
    });
    assert.equal(refusal.response.status, 200);
    assert.equal(refusal.payload.status, 'guardrail_refusal');
    assert.equal(refusal.payload.guardrailMode, 'standard');
    assert.equal(refusal.payload.answer, GUARDRAIL_REFUSAL_ANSWER);
    assert.notEqual(refusal.payload.answer, NO_EVIDENCE_ANSWER);
    assert.deepEqual(refusal.payload.sources, []);
    assert.deepEqual(refusal.payload.followUps, []);
    assert.doesNotMatch(JSON.stringify(refusal.payload), /Provider-authored/);
  }, researchApp);
});

test('research assistant API rejects invalid input and stays public-safe when unavailable', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource()
    })
  });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const invalid = await fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'x', scope: 'library' })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_question');

    const missingArticle = await fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does this say?', scope: 'article', slug: 'missing-note' })
    });
    assert.equal(missingArticle.status, 404);
    assert.equal((await missingArticle.json()).error.code, 'article_not_found');

    const unavailable = await fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What themes appear?', scope: 'library' })
    });
    const unavailablePayload = await unavailable.json();
    assert.equal(unavailable.status, 503);
    assert.equal(unavailablePayload.error.code, 'assistant_unavailable');
    assert.doesNotMatch(JSON.stringify(unavailablePayload), /stack|ResearchAssistantUnavailableError/);
  }, researchApp);
});

test('Azure proxy-aware assistant limits clients independently', async () => {
  const repository = createResearchRepository({
    containerClient: createMockContainer({
      'a-useful-research-note.md': researchSource()
    })
  });
  const assistant = createResearchAssistant({
    provider: {
      async retrieve() { return []; },
      async generate() { throw new Error('Generation should not run without evidence.'); }
    }
  });
  const previousSiteName = process.env.WEBSITE_SITE_NAME;
  process.env.WEBSITE_SITE_NAME = 'cvkewebsite';
  const researchApp = app.createApp({ researchAssistant: assistant, researchRepository: repository });
  if (previousSiteName === undefined) {
    delete process.env.WEBSITE_SITE_NAME;
  } else {
    process.env.WEBSITE_SITE_NAME = previousSiteName;
  }

  async function ask(baseUrl, forwardedFor) {
    return fetch(baseUrl + '/research/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': forwardedFor
      },
      body: JSON.stringify({ question: 'What themes appear?', scope: 'library' })
    });
  }

  await withServer(async (baseUrl) => {
    for (let index = 0; index < 5; index += 1) {
      const response = await ask(baseUrl, '203.0.113.10');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'no_evidence');
    }

    const limited = await ask(baseUrl, '203.0.113.10');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');

    const independent = await ask(baseUrl, '198.51.100.20');
    assert.equal(independent.status, 200);
  }, researchApp);
});

test('research assistant response contract rejects invented or missing citations', () => {
  assert.throws(
    () => normalizeResponse({
      answer: 'An unsupported answer.',
      sources: [{ title: 'Note', url: '/research/note#overview' }]
    }),
    ResearchAssistantInvalidResponseError
  );
  assert.throws(
    () => normalizeResponse({
      answer: 'An answer with an invented source. [2]',
      sources: [{ title: 'Note', url: '/research/note#overview' }]
    }),
    ResearchAssistantInvalidResponseError
  );
  assert.throws(
    () => normalizeResponse({
      answer: 'An answer with an external source. [1]',
      sources: [{ title: 'Note', url: 'https://example.com/invented' }]
    }),
    ResearchAssistantInvalidResponseError
  );
});

test('research indexer preserves viewer heading IDs and excludes the bibliography', () => {
  const sections = markdownSections([
    '# Main finding',
    '',
    'Opening evidence.1',
    '',
    '## Repeated section',
    '',
    'First repeated evidence.2',
    '',
    '## Repeated section',
    '',
    'Second repeated evidence.3',
    '',
    '#### Works cited',
    '',
    '1. A source that should not become answer evidence.'
  ].join('\n'));

  assert.deepEqual(sections.map((section) => section.headingId), [
    'main-finding',
    'repeated-section',
    'repeated-section-2'
  ]);
  assert.doesNotMatch(sections.map((section) => section.text).join(' '), /should not become/);

  const documents = buildDocuments({
    blobName: 'a-useful-research-note.md',
    slug: 'a-useful-research-note',
    etag: 'stable-etag',
    lastModified: new Date('2026-07-01T12:00:00.000Z')
  }, researchSource({}, '# Overview\n\nA grounded passage.1\n\n#### Works cited\n\n1. Source'));

  assert.equal(documents.length, 1);
  assert.equal(documents[0].articleUrl, '/research/a-useful-research-note#overview');
  assert.equal(documents[0].headingPath, 'Overview');
  assert.equal(documents[0].sourceEtag, 'stable-etag');
  assert.doesNotMatch(documents[0].content, /Works cited|Source/);
});

test('research index definition reserves a vector field without requiring vectors during initial load', () => {
  const definition = indexDefinition('research-chunks-v1');
  const vectorField = definition.fields.find((field) => field.name === 'contentVector');

  assert.equal(definition.name, 'research-chunks-v1');
  assert.equal(vectorField.dimensions, 1536);
  assert.equal(vectorField.vectorSearchProfile, 'research-vector-profile');
  assert.equal(definition.vectorSearch.algorithms[0].kind, 'hnsw');
});
