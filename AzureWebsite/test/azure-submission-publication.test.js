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

  const result = await indexer.remove('reviewed-note');
  assert.equal(result.deleted, 1334);
  assert.equal(documents.size, 0);
  assert.deepEqual(searchRequests.slice(0, 2).map((body) => body.skip), [0, 1000]);
  assert.equal(searchRequests.at(-1).skip, 0);
});

test('Azure publication rejects key-based configuration and invalid publication inputs', () => {
  assert.throws(
    () => createAzurePublicPublisher({ env: { AZURE_STORAGE_CONNECTION_STRING: 'secret' } }),
    PublicationConfigurationError
  );
  assert.throws(() => publicationInput(input({ slug: '../escape' })), /slug/i);
  assert.throws(() => publicationInput(input({ operationId: 'short' })), /operation/i);
});
