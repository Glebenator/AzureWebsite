const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const portfolio = require('../data/portfolio');

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    await run(`http://${host}:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
