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
