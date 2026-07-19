'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AzureEmbeddingConfigurationError,
  AzureEmbeddingError,
  EMBEDDING_DIMENSIONS,
  MODEL_SCOPE,
  createAzureEmbeddingClient
} = require('../services/azure-embedding-client');

function environment(overrides = {}) {
  return {
    AZURE_OPENAI_ENDPOINT: 'https://example-model.openai.azure.com',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'research-embedding-3-small',
    ...overrides
  };
}

function credential() { return { async getToken(scope) { assert.equal(scope, MODEL_SCOPE); return { token: 'token' }; } }; }
function vector() { return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index / 1000); }
function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }

test('embedding client uses managed identity and validates a 1536-float response', async () => {
  let request;
  const client = createAzureEmbeddingClient({
    env: environment(), credential: credential(),
    async fetch(url, options) { request = { url, options }; return response({ data: [{ index: 0, embedding: vector() }] }); }
  });
  const [result] = await client.embed(['Heading-aware content']);
  assert.equal(result.length, EMBEDDING_DIMENSIONS);
  assert.match(request.url, /\/openai\/v1\/embeddings$/);
  assert.equal(request.options.headers.Authorization, 'Bearer token');
  assert.equal('api-key' in request.options.headers, false);
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'research-embedding-3-small', input: ['Heading-aware content'], dimensions: 1536, encoding_format: 'float'
  });
});

test('embedding client rejects invalid configuration and malformed vectors', async () => {
  assert.throws(() => createAzureEmbeddingClient({ env: environment({ AZURE_OPENAI_EMBEDDING_DEPLOYMENT: '' }) }), AzureEmbeddingConfigurationError);
  assert.throws(() => createAzureEmbeddingClient({ env: environment({ AZURE_OPENAI_API_KEY: 'nope' }) }), /API-key authentication/);
  const client = createAzureEmbeddingClient({
    env: environment(), credential: credential(), fetch: async () => response({ data: [{ index: 0, embedding: [0, Infinity] }] })
  });
  await assert.rejects(client.embed(['valid']), (error) => error instanceof AzureEmbeddingError && error.code === 'embedding_invalid_response');
});

test('embedding client handles auth, throttling, timeout, and cancellation without leaking input', async () => {
  const auth = createAzureEmbeddingClient({
    env: environment(), credential: { async getToken() { throw new Error('denied'); } }, fetch: async () => assert.fail('fetch should not run')
  });
  await assert.rejects(auth.embed(['valid']), (error) => error.code === 'embedding_authentication_failed');

  const stalledCredential = createAzureEmbeddingClient({
    env: environment(), timeoutMs: 100,
    credential: { async getToken() { return new Promise(() => {}); } }, fetch: async () => assert.fail('fetch should not run')
  });
  await assert.rejects(stalledCredential.embed(['valid']), (error) => error.code === 'embedding_authentication_failed');

  const tokenController = new AbortController();
  const cancelledWhileAuthenticating = createAzureEmbeddingClient({
    env: environment(), timeoutMs: 1000,
    credential: { async getToken() { return new Promise(() => {}); } }, fetch: async () => assert.fail('fetch should not run')
  });
  setTimeout(() => tokenController.abort(), 10);
  await assert.rejects(
    cancelledWhileAuthenticating.embed(['valid'], { signal: tokenController.signal }),
    (error) => error.code === 'embedding_cancelled'
  );

  const delays = [];
  let calls = 0;
  const throttled = createAzureEmbeddingClient({
    env: environment(), credential: credential(), sleep: async (delay) => delays.push(delay),
    fetch: async () => { calls += 1; return response({}, 429); }
  });
  await assert.rejects(throttled.embed(['valid']), (error) => error.code === 'embedding_busy');
  assert.equal(calls, 4);
  assert.deepEqual(delays, [250, 500, 1000]);

  const timeout = createAzureEmbeddingClient({
    env: environment(), credential: credential(), timeoutMs: 100,
    fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  });
  await assert.rejects(timeout.embed(['valid']), (error) => error.code === 'embedding_timeout');

  const controller = new AbortController();
  controller.abort();
  const cancelled = createAzureEmbeddingClient({ env: environment(), credential: credential(), fetch: async () => assert.fail('fetch should not run') });
  await assert.rejects(cancelled.embed(['valid'], { signal: controller.signal }), (error) => error.code === 'embedding_cancelled');
});
