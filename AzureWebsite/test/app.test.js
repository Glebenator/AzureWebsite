const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const app = require('../app');
const portfolio = require('../data/portfolio');
const {
  ResearchStorageError,
  createResearchRepository
} = require('../services/research-repository');

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

function researchSource(overrides = {}) {
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
  return `---\n${frontMatter}\n---\n\n# Overview\n\nA **focused** research summary with useful context.`;
}

test('homepage renders verified portfolio content and security headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
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
    assert.match(html, /1 entry/);
    assert.match(html, /research, not medical advice/i);
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
      'a-useful-research-note.md': researchSource()
    })
  });
  const researchApp = app.createApp({ researchRepository: repository });

  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/research/a-useful-research-note');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<h2>Overview<\/h2>/);
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
    assert.doesNotMatch(html, /<script[\s>]/i);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, /onerror=/i);
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
