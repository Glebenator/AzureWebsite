'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createResearchRepository } = require('../services/research-repository');

test('cache invalidation cannot be undone by an older in-flight catalog refresh', async () => {
  const source = '---\ntitle: Soon deleted\n---\n\n# Finding\n\nOld evidence.\n';
  let available = true;
  let releaseDownload;
  let signalDownloadStarted;
  const downloadStarted = new Promise((resolve) => { signalDownloadStarted = resolve; });
  const downloadReleased = new Promise((resolve) => { releaseDownload = resolve; });
  const containerClient = {
    async *listBlobsFlat() {
      if (!available) return;
      yield {
        name: 'soon-deleted.md',
        properties: {
          contentLength: Buffer.byteLength(source),
          etag: 'old-etag',
          lastModified: new Date('2026-07-22T12:00:00.000Z')
        }
      };
    },
    getBlobClient() {
      return {
        async download() {
          signalDownloadStarted();
          await downloadReleased;
          return { readableStreamBody: Readable.from([source]) };
        }
      };
    }
  };
  const repository = createResearchRepository({ containerClient, cacheTtlMs: 60_000 });

  const staleRefresh = repository.listArticles();
  await downloadStarted;
  available = false;
  repository.clearCache();

  assert.deepEqual(await repository.listArticles(), []);
  releaseDownload();
  assert.deepEqual(await staleRefresh, []);
  assert.deepEqual(await repository.listArticles(), []);
  assert.equal(await repository.getArticle('soon-deleted'), null);
});

test('reviewed-submission blobs remain absent until the durable publication flag activates them', async () => {
  const source = '---\ntitle: Staged note\n---\n\n# Finding\n\nEvidence.\n';
  let visible = false;
  let downloads = 0;
  const containerClient = {
    async *listBlobsFlat(options) {
      assert.equal(options.includeMetadata, true);
      yield {
        name: 'staged-note.md',
        metadata: { operationhash: 'operation-hash', source: 'reviewed-submission' },
        properties: {
          contentLength: Buffer.byteLength(source),
          etag: 'staged-etag',
          lastModified: new Date('2026-08-04T12:00:00.000Z')
        }
      };
    },
    getBlobClient() {
      return {
        async download() {
          downloads += 1;
          return { readableStreamBody: Readable.from([source]) };
        }
      };
    }
  };
  const repository = createResearchRepository({
    containerClient,
    cacheTtlMs: 60_000,
    async publicationVisibility() { return visible; }
  });

  assert.deepEqual(await repository.listArticles(), []);
  assert.equal(downloads, 0);
  visible = true;
  repository.clearCache();
  assert.deepEqual((await repository.listArticles()).map((article) => article.slug), ['staged-note']);
  assert.equal(downloads, 1);
});

test('a readable reviewed submission is excluded from assistant evidence until AI indexing is ready', async () => {
  const source = '---\ntitle: Public before AI\n---\n\n# Finding\n\nEvidence.\n';
  let aiReady = false;
  const containerClient = {
    async *listBlobsFlat() {
      yield {
        name: 'public-before-ai.md',
        metadata: { operationhash: 'operation-hash', source: 'reviewed-submission' },
        properties: {
          contentLength: Buffer.byteLength(source),
          etag: 'public-etag',
          lastModified: new Date('2026-08-04T12:00:00.000Z')
        }
      };
    },
    getBlobClient() {
      return { async download() { return { readableStreamBody: Readable.from([source]) }; } };
    }
  };
  const repository = createResearchRepository({
    containerClient,
    async publicationVisibility() { return true; },
    async assistantEvidenceVisibility() { return aiReady; }
  });

  assert.deepEqual((await repository.listArticles()).map((article) => article.slug), ['public-before-ai']);
  assert.equal(await repository.resolveEvidenceSource({
    articleSlug: 'public-before-ai', headingId: 'finding', sourceEtag: 'public-etag'
  }), null);
  aiReady = true;
  assert.equal((await repository.resolveEvidenceSource({
    articleSlug: 'public-before-ai', headingId: 'finding', sourceEtag: 'public-etag'
  })).title, 'Public before AI');
});
