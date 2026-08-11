'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PublicationConfigurationError,
  PublicationConflictError,
  createAzurePublicPublisher,
  createAzureSubmissionIndexer,
  publicationInput
} = require('../services/azure-submission-publication');

function conflict(statusCode) {
  return Object.assign(new Error('condition failed'), { statusCode });
}

function input(overrides = {}) {
  return {
    slug: 'reviewed-note',
    markdown: '---\ntitle: Reviewed note\n---\n\n# Finding\n\nEvidence.\n',
    operationId: 'opaque-operation-id-123456',
    ...overrides
  };
}

test('Azure publisher creates one Markdown blob using a conditional managed-identity write', async () => {
  const calls = {};
  const publisher = createAzurePublicPublisher({
    env: {},
    credential: { async getToken() { throw new Error('not used by injected client'); } },
    containerClient: {
      getBlockBlobClient(name) {
        calls.name = name;
        return {
          async uploadData(bytes, options) {
            calls.bytes = bytes;
            calls.options = options;
            return { etag: 'etag-one', lastModified: new Date('2026-07-22T12:00:00.000Z') };
          },
          async getProperties() {
            return {
              etag: 'etag-one',
              lastModified: new Date('2026-07-22T12:00:00.000Z'),
              metadata: {
                operationhash: calls.options.metadata.operationhash,
                contenthash: calls.options.metadata.contenthash
              }
            };
          }
        };
      }
    }
  });

  const result = await publisher.publish(input());
  assert.equal(calls.name, 'reviewed-note.md');
  assert.equal(calls.options.conditions.ifNoneMatch, '*');
  assert.equal(calls.options.blobHTTPHeaders.blobContentType, 'text/markdown; charset=utf-8');
  assert.equal(calls.options.metadata.source, 'reviewed-submission');
  assert.match(calls.options.metadata.contenthash, /^[a-f0-9]{64}$/);
  assert.match(calls.options.metadata.operationhash, /^[a-f0-9]{64}$/);
  assert.equal(result.etag, 'etag-one');
});

test('Azure publisher does not activate a write until Blob metadata is read back and verified', async () => {
  const publisher = createAzurePublicPublisher({
    env: {},
    credential: {},
    containerClient: {
      getBlockBlobClient() {
        return {
          async uploadData() { return { etag: 'unverified' }; },
          async getProperties() {
            return { etag: 'other', metadata: { operationhash: 'wrong', contenthash: 'wrong' } };
          }
        };
      }
    }
  });
  await assert.rejects(() => publisher.write(input()), PublicationConflictError);
});

test('Azure publisher retries idempotently only when operation and content hashes match', async () => {
  const normalized = publicationInput(input());
  const matching = createAzurePublicPublisher({
    env: {},
    credential: {},
    containerClient: {
      getBlockBlobClient() {
        return {
          async uploadData() { throw conflict(412); },
          async getProperties() {
            return {
              etag: 'existing-etag',
              metadata: {
                operationhash: normalized.operationHash,
                contenthash: normalized.contentHash
              }
            };
          }
        };
      }
    }
  });
  assert.equal((await matching.publish(input())).etag, 'existing-etag');

  const conflicting = createAzurePublicPublisher({
    env: {},
    credential: {},
    containerClient: {
      getBlockBlobClient() {
        return {
          async uploadData() { throw conflict(409); },
          async getProperties() {
            return { etag: 'other', metadata: { operationhash: 'different', contenthash: 'different' } };
          }
        };
      }
    }
  });
  await assert.rejects(conflicting.publish(input()), PublicationConflictError);
});

test('Azure publisher deletion needs only immutable publication identity and deletes only the same operation', async () => {
  const normalized = publicationInput(input());
  const calls = {};
  const publisher = createAzurePublicPublisher({
    env: {},
    credential: {},
    containerClient: {
      getBlockBlobClient() {
        return {
          async getProperties() {
            return { etag: 'matching-etag', metadata: { operationhash: normalized.operationHash } };
          },
          async delete(options) { calls.deleteOptions = options; }
        };
      }
    }
  });
  assert.equal(await publisher.remove({ slug: 'reviewed-note', submissionId: input().operationId }), true);
  assert.deepEqual(calls.deleteOptions, { conditions: { ifMatch: 'matching-etag' } });
});

test('Azure Search removal paginates through every chunk and verifies the slug is empty', async () => {
  const documents = new Map(Array.from({ length: 1334 }, (_, index) => [
    `reviewed-note-${index}`,
    { id: `reviewed-note-${index}` }
  ]));
  const searchRequests = [];
  const request = async (_credential, _endpoint, path, options) => {
    const body = JSON.parse(options.body);
    if (path.includes('/docs/search?')) {
      searchRequests.push(body);
      return { value: [...documents.values()].slice(body.skip, body.skip + body.top) };
    }
    const results = body.value.map((action) => {
      documents.delete(action.id);
      return { key: action.id, status: true, statusCode: 200 };
    });
    return { value: results };
  };
  const indexer = createAzureSubmissionIndexer({
    env: { AZURE_SEARCH_ENDPOINT: 'https://research.search.windows.net' },
    credential: {},
    embeddingClient: { async embed() { throw new Error('not used'); } },
    request,
    sleep: async () => {}
  });

  const result = await indexer.remove(
    { slug: 'reviewed-note', publicVersion: 'public-etag' },
    { ownershipVerified: true }
  );
  assert.equal(result.deleted, 1334);
  assert.equal(documents.size, 0);
  assert.deepEqual(searchRequests.slice(0, 2).map((body) => body.skip), [0, 1000]);
  assert.equal(searchRequests.at(-1).skip, 0);
});

test('Azure indexer prepares embeddings without Search writes and commits them against the public ETag', async () => {
  const requests = [];
  const documents = new Map([[
    'reviewed-note-stale',
    { id: 'reviewed-note-stale', sourceEtag: 'old-etag' }
  ]]);
  const request = async (_credential, _endpoint, path, options) => {
    const body = JSON.parse(options.body);
    requests.push({ body, path });
    if (path.includes('/docs/search?')) {
      return {
        value: [...documents.values()].map((document) => ({
          id: document.id,
          sourceEtag: document.sourceEtag
        }))
      };
    }
    for (const action of body.value) {
      if (action['@search.action'] === 'delete') documents.delete(action.id);
      else documents.set(action.id, action);
    }
    return { value: body.value.map((action) => ({ key: action.id, status: true, statusCode: 200 })) };
  };
  const indexer = createAzureSubmissionIndexer({
    env: { AZURE_SEARCH_ENDPOINT: 'https://research.search.windows.net' },
    credential: {},
    embeddingClient: { async embed(values) { return values.map(() => Array(1536).fill(0.1)); } },
    request,
    sleep: async () => {}
  });

  const embeddingProgress = [];
  const prepared = await indexer.prepare(input(), {
    onProgress(completed, total) { embeddingProgress.push([completed, total]); }
  });
  assert.equal(prepared.vectors.length, 1);
  assert.deepEqual(embeddingProgress, [[0, 1], [1, 1]]);
  assert.equal(requests.length, 0);

  const result = await indexer.commit({
    ...input(),
    publicVersion: 'public-etag',
    lastModified: new Date('2026-08-04T12:00:00.000Z')
  }, prepared);
  assert.equal(result.verified, 1);
  assert.equal([...documents.values()][0].sourceEtag, 'public-etag');
  const writes = requests.filter((item) => item.path.includes('/docs/index?'));
  assert.equal(writes.length, 2);
  assert.ok(writes[0].body.value.every((action) => action['@search.action'] === 'delete'));
  assert.ok(writes[1].body.value.every((action) => action['@search.action'] === 'mergeOrUpload'));
  for (const write of writes) {
    assert.equal(new Set(write.body.value.map((action) => action.id)).size, write.body.value.length);
  }
});

test('Azure Search commit polls through eventual consistency before declaring documents verified', async () => {
  const documents = new Map();
  const waits = [];
  let indexed = false;
  let verificationReads = 0;
  const request = async (_credential, _endpoint, path, options) => {
    const body = JSON.parse(options.body);
    if (path.includes('/docs/search?')) {
      if (!indexed) return { value: [] };
      verificationReads += 1;
      if (verificationReads <= 2) return { value: [] };
      return {
        value: [...documents.values()].map((document) => ({
          id: document.id,
          sourceEtag: document.sourceEtag
        }))
      };
    }
    for (const action of body.value) documents.set(action.id, action);
    indexed = true;
    return { value: body.value.map((action) => ({ key: action.id, status: true, statusCode: 200 })) };
  };
  const indexer = createAzureSubmissionIndexer({
    env: { AZURE_SEARCH_ENDPOINT: 'https://research.search.windows.net' },
    credential: {},
    embeddingClient: { async embed(values) { return values.map(() => Array(1536).fill(0.1)); } },
    request,
    sleep: async (milliseconds) => { waits.push(milliseconds); }
  });

  const prepared = await indexer.prepare(input());
  const result = await indexer.commit({ ...input(), publicVersion: 'eventual-etag' }, prepared);

  assert.equal(result.verified, 1);
  assert.deepEqual(waits, [100, 250]);
});

test('Azure Search removal without Blob ownership is limited to the durable source ETag', async () => {
  const documents = new Map([
    ['owned-chunk', { id: 'owned-chunk', sourceEtag: 'owned-etag' }],
    ['other-chunk', { id: 'other-chunk', sourceEtag: 'other-etag' }]
  ]);
  const request = async (_credential, _endpoint, path, options) => {
    const body = JSON.parse(options.body);
    if (path.includes('/docs/search?')) return { value: [...documents.values()] };
    for (const action of body.value) documents.delete(action.id);
    return { value: body.value.map((action) => ({ key: action.id, status: true, statusCode: 200 })) };
  };
  const indexer = createAzureSubmissionIndexer({
    env: { AZURE_SEARCH_ENDPOINT: 'https://research.search.windows.net' },
    credential: {},
    embeddingClient: { async embed() { throw new Error('not used'); } },
    request,
    sleep: async () => {}
  });

  const result = await indexer.remove({ slug: 'reviewed-note', publicVersion: 'owned-etag' });
  assert.equal(result.deleted, 1);
  assert.deepEqual([...documents.keys()], ['other-chunk']);
  await assert.rejects(
    () => indexer.remove('reviewed-note'),
    (error) => error.code === 'search_ownership_unverified'
  );
});

test('Azure Search removal catches documents that appear after an initially empty query', async () => {
  const documents = new Map([[
    'eventual-chunk',
    { id: 'eventual-chunk', sourceEtag: 'eventual-etag' }
  ]]);
  let reads = 0;
  const request = async (_credential, _endpoint, path, options) => {
    const body = JSON.parse(options.body);
    if (path.includes('/docs/search?')) {
      reads += 1;
      return { value: reads < 3 ? [] : [...documents.values()] };
    }
    for (const action of body.value) documents.delete(action.id);
    return { value: body.value.map((action) => ({ key: action.id, status: true, statusCode: 200 })) };
  };
  const indexer = createAzureSubmissionIndexer({
    env: { AZURE_SEARCH_ENDPOINT: 'https://research.search.windows.net' },
    credential: {},
    embeddingClient: { async embed() { throw new Error('not used'); } },
    request,
    sleep: async () => {}
  });

  const result = await indexer.remove(
    { slug: 'reviewed-note', publicVersion: 'eventual-etag' },
    { ownershipVerified: true }
  );
  assert.equal(result.deleted, 1);
  assert.equal(documents.size, 0);
  assert.ok(reads >= 9);
});

test('Azure indexer resumes a durable embedding checkpoint without recomputing completed vectors', async () => {
  let embedded = 0;
  const vector = Array(1536).fill(0.2);
  const indexer = createAzureSubmissionIndexer({
    env: { AZURE_SEARCH_ENDPOINT: 'https://research.search.windows.net' },
    credential: {},
    embeddingClient: {
      async embed(values) {
        embedded += values.length;
        return values.map(() => vector.slice());
      }
    },
    request: async () => ({ value: [] }),
    sleep: async () => {}
  });
  const twoSections = input({
    markdown: '---\ntitle: Reviewed note\n---\n\n# One\n\nFirst.\n\n# Two\n\nSecond.\n'
  });
  const checkpoints = [];
  const first = await indexer.prepare(twoSections, {
    async onCheckpoint(value) {
      checkpoints.push(value);
      if (value.vectors.length === 1) throw Object.assign(new Error('crash'), { code: 'embedding_cancelled' });
    }
  }).catch((error) => {
    assert.equal(error.code, 'embedding_cancelled');
    return null;
  });
  assert.equal(first, null);
  assert.equal(embedded, 1);

  const resumed = await indexer.prepare(twoSections, { checkpoint: checkpoints[0] });
  assert.equal(resumed.vectors.length, 2);
  assert.equal(embedded, 2);
});

test('Azure publication rejects key-based configuration and invalid publication inputs', () => {
  assert.throws(
    () => createAzurePublicPublisher({ env: { AZURE_STORAGE_CONNECTION_STRING: 'secret' } }),
    PublicationConfigurationError
  );
  assert.throws(() => publicationInput(input({ slug: '../escape' })), /slug/i);
  assert.throws(() => publicationInput(input({ operationId: 'short' })), /operation/i);
});
