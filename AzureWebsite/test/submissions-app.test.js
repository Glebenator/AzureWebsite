'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const appModule = require('../app');
const { createCsrfProtection } = require('../services/submission-csrf');
const { createInMemorySubmissionRepository } = require('../services/submission-repository');
const { createOpaqueSessionStore } = require('../services/submission-session');
const { createSubmissionSystem } = require('../services/submission-system');

async function withServer(application, run) {
  const server = application.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    await run(`http://${host}:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fixture(options = {}) {
  const repository = createInMemorySubmissionRepository();
  const sessionStore = createOpaqueSessionStore();
  const csrf = createCsrfProtection({ secret: Buffer.alloc(32, 7) });
  const publicWrites = [];
  const indexed = [];
  const removedFromIndex = [];
  let cacheClears = 0;
  const system = createSubmissionSystem({
    enabled: true,
    publishingEnabled: true,
    env: { NODE_ENV: 'development' },
    adminGoogleSub: 'admin-google-sub',
    repository,
    sessionStore,
    csrf,
    quota: options.quota,
    oidc: {
      isConfigured() { return true; },
      async begin() { return { attempt: {}, url: 'https://accounts.google.com/auth' }; },
      async complete() { return { subject: 'callback-subject' }; }
    },
    publicStore: {
      async write(payload) { publicWrites.push(payload); return { etag: 'public-etag' }; },
      async remove() { return true; }
    },
    searchIndex: {
      async index(payload) { indexed.push(payload); return { version: 'search-version' }; },
      async remove(payload) { removedFromIndex.push(payload); return true; }
    }
  });
  const researchRepository = {
    async listArticles() { return []; },
    async getArticle() { return null; },
    clearCache() { cacheClears += 1; }
  };
  const application = appModule.createApp({
    researchRepository,
    researchAssistant: { isAvailable() { return false; } },
    submissionSystem: system
  });

  function auth(subject) {
    const token = sessionStore.issue({ accountId: subject, googleSub: subject });
    return {
      cookie: `research_session=${token}`,
      csrf: csrf.issue(token, { method: 'POST', path: '/' })
    };
  }
  return {
    application,
    auth,
    indexed,
    publicWrites,
    removedFromIndex,
    repository,
    cacheClears() { return cacheClears; }
  };
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

async function postForm(baseUrl, path, auth, values = {}, overrides = {}) {
  return fetch(baseUrl + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: auth.cookie,
      Origin: baseUrl,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...overrides.headers
    },
    body: formBody({ _csrf: auth.csrf, ...values })
  });
}

async function upload(baseUrl, auth, markdown, filename = 'note.md', path = '/research/submissions/preview') {
  const body = new FormData();
  body.append('_csrf', auth.csrf);
  body.append('researchFile', new Blob([markdown], { type: 'application/octet-stream' }), filename);
  return fetch(baseUrl + path, {
    method: 'POST', redirect: 'manual', headers: { Cookie: auth.cookie, Origin: baseUrl }, body
  });
}

async function editMarkdown(baseUrl, path, auth, markdown) {
  const body = new FormData();
  body.append('_csrf', auth.csrf);
  body.append('markdown', markdown);
  return fetch(baseUrl + path, {
    method: 'POST', redirect: 'manual', headers: { Cookie: auth.cookie, Origin: baseUrl }, body
  });
}

test('submission routes require authentication and conceal other owners records', async () => {
  const context = fixture();
  const owner = context.auth('owner-google-sub');
  const outsider = context.auth('outsider-google-sub');
  const record = await context.repository.create({
    ownerId: 'owner-google-sub', markdown: '# Owner only\n', metadata: {}, status: 'pending'
  });

  await withServer(context.application, async (baseUrl) => {
    const signIn = await fetch(baseUrl + '/research/submissions');
    assert.equal(signIn.status, 200);
    assert.match(await signIn.text(), /Sign in to submit research/);

    const admin = await fetch(baseUrl + '/admin/submissions', { headers: { Cookie: owner.cookie } });
    assert.equal(admin.status, 403);

    const leaked = await fetch(baseUrl + `/research/submissions/${record.id}`, {
      headers: { Cookie: outsider.cookie }
    });
    assert.equal(leaked.status, 404);
    const html = await leaked.text();
    assert.doesNotMatch(html, /Owner only|owner-google-sub/);
  });
});

test('request logging removes OAuth queries and opaque submission identifiers', () => {
  assert.equal(
    appModule.safeLogPath({ originalUrl: '/auth/google/callback?code=secret&state=secret' }),
    '/auth/google/callback'
  );
  assert.equal(
    appModule.safeLogPath({ originalUrl: '/admin/submissions/AbCdEfGhIjKlMnOpQrStUvWxYz012345/publish' }),
    '/admin/submissions/:submission/publish'
  );
});

test('upload requires same-origin CSRF, validates bytes, and renders only a sanitized private preview', async () => {
  const context = fixture();
  const owner = context.auth('owner-google-sub');
  await withServer(context.application, async (baseUrl) => {
    const noOriginBody = new FormData();
    noOriginBody.append('_csrf', owner.csrf);
    noOriginBody.append('researchFile', new Blob(['# Note\n']), 'note.md');
    const noOrigin = await fetch(baseUrl + '/research/submissions/preview', {
      method: 'POST', redirect: 'manual', headers: { Cookie: owner.cookie }, body: noOriginBody
    });
    assert.equal(noOrigin.status, 403);

    const uploaded = await upload(baseUrl, owner, [
      '---', 'title: Sanitized note', 'private_note: private-contact-value', '---', '',
      '# Finding', '', '<script>alert("xss")</script>', '', '[unsafe](javascript:alert(1))'
    ].join('\n'));
    assert.equal(uploaded.status, 303);
    const location = uploaded.headers.get('location');
    assert.match(location, /^\/research\/submissions\/[A-Za-z0-9_-]+\/review/);
    assert.equal(context.publicWrites.length, 0);
    assert.equal(context.indexed.length, 0);

    const preview = await fetch(baseUrl + location, { headers: { Cookie: owner.cookie } });
    const html = await preview.text();
    assert.equal(preview.status, 200);
    assert.match(html, /Sanitized note/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|href="javascript:|private-contact-value/);
    assert.match(html, /private and unavailable to public search|does not publish or index/i);
    assert.match(html, new RegExp(`/research/submissions/[A-Za-z0-9_-]+/edit`));
    assert.match(html, /Edit Markdown/);
    assert.match(html, /Replace file/);
    assert.match(html, /Delete draft/);

    const record = (await context.repository.listByOwner('owner-google-sub'))[0];
    const editor = await fetch(baseUrl + `/research/submissions/${record.id}/edit`, {
      headers: { Cookie: owner.cookie }
    });
    const editorHtml = await editor.text();
    assert.equal(editor.status, 200);
    assert.match(editorHtml, /Markdown source/);
    assert.match(editorHtml, /Sanitized note/);
    assert.doesNotMatch(editorHtml, /<script>alert/);

    const edited = await editMarkdown(
      baseUrl,
      `/research/submissions/${record.id}/edit`,
      owner,
      '---\ntitle: Revised note\n---\n\n# Revised finding\n\nUpdated evidence.\n'
    );
    assert.equal(edited.status, 303);
    assert.match(edited.headers.get('location'), /\/review\?status=edited$/);
    const revised = await context.repository.get(record.id);
    assert.equal(revised.metadata.title, 'Revised note');
    assert.equal(revised.revision, 2);
  });
});

test('owners can revise submitted work and delete private or published submissions', async () => {
  const context = fixture();
  const owner = context.auth('owner-google-sub');
  const submitted = await context.repository.create({
    ownerId: 'owner-google-sub',
    markdown: '---\ntitle: Awaiting review\n---\n\n# Finding\n\nEvidence.\n',
    metadata: { title: 'Awaiting review' },
    status: 'ready_for_review'
  });

  await withServer(context.application, async (baseUrl) => {
    const detail = await fetch(baseUrl + `/research/submissions/${submitted.id}`, {
      headers: { Cookie: owner.cookie }
    });
    const detailHtml = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(detailHtml, /Edit Markdown/);
    assert.match(detailHtml, /Delete submission/);

    const edited = await editMarkdown(
      baseUrl,
      `/research/submissions/${submitted.id}/edit`,
      owner,
      '---\ntitle: Revised draft\n---\n\n# Updated finding\n'
    );
    assert.equal(edited.status, 303);
    assert.equal((await context.repository.get(submitted.id)).status, 'pending');

    const deletedPrivate = await postForm(baseUrl, `/research/submissions/${submitted.id}/delete`, owner);
    assert.equal(deletedPrivate.status, 303);
    assert.equal((await context.repository.get(submitted.id)).status, 'deleted');

    const published = await context.repository.create({
      ownerId: 'owner-google-sub',
      markdown: '---\ntitle: Published owner note\n---\n\n# Finding\n\nEvidence.\n',
      metadata: { title: 'Published owner note' },
      status: 'ready_for_review'
    });
    await postForm(baseUrl, `/admin/submissions/${published.id}/publish`, context.auth('admin-google-sub'));
    const ownerDelete = await postForm(baseUrl, `/research/submissions/${published.id}/delete`, owner);
    assert.equal(ownerDelete.status, 303);
    assert.equal((await context.repository.get(published.id)).status, 'deleted');
    assert.equal(context.removedFromIndex.length, 1);
    assert.equal(context.cacheClears(), 2);
  });
});

test('only the sole admin can publish and status changes after public write and indexing', async () => {
  const context = fixture();
  const owner = context.auth('owner-google-sub');
  const admin = context.auth('admin-google-sub');
  const record = await context.repository.create({
    ownerId: 'owner-google-sub',
    markdown: '---\ntitle: Publish me\nprivate_field: remove-me\n---\n\n# Finding\n\nEvidence.\n',
    metadata: { title: 'Publish me', private_field: 'remove-me' },
    status: 'ready_for_review'
  });

  await withServer(context.application, async (baseUrl) => {
    const ownerAttempt = await postForm(baseUrl, `/admin/submissions/${record.id}/publish`, owner);
    assert.equal(ownerAttempt.status, 403);
    assert.equal(context.publicWrites.length, 0);

    const published = await postForm(baseUrl, `/admin/submissions/${record.id}/publish`, admin);
    assert.equal(published.status, 303);
    assert.equal(context.publicWrites.length, 1);
    assert.equal(context.indexed.length, 1);
    assert.doesNotMatch(context.publicWrites[0].markdown, /private_field|remove-me/);
    assert.equal((await context.repository.get(record.id)).status, 'published');
    assert.equal(context.cacheClears(), 1);

    const retry = await postForm(baseUrl, `/admin/submissions/${record.id}/publish`, admin);
    assert.equal(retry.status, 303);
    assert.equal(context.publicWrites.length, 1);
    assert.equal(context.indexed.length, 1);
    assert.equal(context.cacheClears(), 2);

    const deleted = await postForm(baseUrl, `/admin/submissions/${record.id}/delete`, admin);
    assert.equal(deleted.status, 303);
    assert.equal(context.removedFromIndex.length, 1);
    assert.equal(context.cacheClears(), 3);
    assert.equal((await context.repository.get(record.id)).status, 'deleted');
  });
});

test('deletion scrubs pending content and quotas return a bounded user-facing error', async () => {
  const quota = () => ({ allowed: false, retryAfterSeconds: 60, scope: 'account' });
  const limited = fixture({ quota });
  const limitedOwner = limited.auth('limited-owner');
  await withServer(limited.application, async (baseUrl) => {
    const response = await upload(baseUrl, limitedOwner, '# Limited\n');
    assert.equal(response.status, 429);
    assert.match(await response.text(), /Upload limit reached.*60 seconds/);
  });

  const context = fixture();
  const owner = context.auth('owner-google-sub');
  const record = await context.repository.create({
    ownerId: 'owner-google-sub', markdown: '# Sensitive pending content\n', metadata: {}, status: 'pending'
  });
  await withServer(context.application, async (baseUrl) => {
    const deleted = await postForm(baseUrl, `/research/submissions/${record.id}/delete`, owner);
    assert.equal(deleted.status, 303);
    const tombstone = await context.repository.get(record.id);
    assert.equal(tombstone.status, 'deleted');
    assert.equal(tombstone.markdown, null);
    assert.deepEqual(tombstone.metadata, {});
    assert.equal(context.publicWrites.length, 0);
    assert.equal(context.indexed.length, 0);
  });
});
