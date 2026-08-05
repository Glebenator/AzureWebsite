'use strict';

const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');
const { createAzureEmbeddingClient } = require('./azure-embedding-client');
const {
  applyIndexActions,
  buildDocuments,
  embedDocuments
} = require('../scripts/index-research');

const MAX_MARKDOWN_BYTES = 3 * 1024 * 1024;
const SEARCH_API_VERSION = '2026-04-01';
const SEARCH_SCOPE = 'https://search.azure.com/.default';
const SEARCH_REQUEST_TIMEOUT_MS = 30 * 1000;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,127}$/;

class PublicationConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicationConfigurationError';
  }
}

class PublicationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicationConflictError';
  }
}

function validateNoKeys(options, env) {
  if (
    options.connectionString || options.accountKey || options.sasToken || options.searchApiKey
    || env.AZURE_STORAGE_CONNECTION_STRING || env.AZURE_STORAGE_ACCOUNT_KEY
    || env.AZURE_SEARCH_API_KEY
  ) {
    throw new PublicationConfigurationError('Key, SAS, and connection-string authentication are not supported.');
  }
}

function configuredName(value, fallback, label) {
  const selected = String(value || fallback || '').trim();
  if (!NAME_PATTERN.test(selected)) throw new PublicationConfigurationError(`${label} contains unsupported characters.`);
  return selected;
}

function configuredSearchEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch {
    throw new PublicationConfigurationError('Azure AI Search endpoint is not configured.');
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || !endpoint.hostname.endsWith('.search.windows.net')
  ) {
    throw new PublicationConfigurationError('Azure AI Search endpoint is invalid.');
  }
  return endpoint.origin;
}

function publicationIdentity(input) {
  if (!input || typeof input !== 'object' || !SLUG_PATTERN.test(input.slug || '')) {
    throw new TypeError('Publication slug is invalid.');
  }
  const operationId = input.operationId || input.submissionId;
  if (typeof operationId !== 'string' || operationId.length < 16 || operationId.length > 255) {
    throw new TypeError('Publication operation identifier is invalid.');
  }
  return {
    ...input,
    blobName: `${input.slug}.md`,
    operationId,
    operationHash: crypto.createHash('sha256').update(operationId).digest('hex')
  };
}

function publicationInput(input) {
  const identity = publicationIdentity(input);
  if (typeof input.markdown !== 'string' || !input.markdown.trim()) {
    throw new TypeError('Publication Markdown is invalid.');
  }
  const bytes = Buffer.from(input.markdown, 'utf8');
  if (bytes.length > MAX_MARKDOWN_BYTES) throw new TypeError('Publication Markdown exceeds 3 MiB.');
  return {
    ...identity,
    bytes,
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

function createDefaultContainerClient(options, env, credential) {
  const accountName = configuredName(
    options.accountName || env.AZURE_STORAGE_ACCOUNT_NAME,
    'cvkeresearch',
    'Azure storage account name'
  );
  const containerName = configuredName(
    options.containerName || env.AZURE_STORAGE_CONTAINER,
    'research',
    'Azure storage container name'
  );
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  ).getContainerClient(containerName);
}

function createAzurePublicPublisher(options = {}) {
  const env = options.env || process.env;
  validateNoKeys(options, env);
  const credential = options.credential || new DefaultAzureCredential({ excludeInteractiveBrowserCredential: true });
  const containerClient = options.containerClient || createDefaultContainerClient(options, env, credential);

  const adapter = {
    async write(input, optionsForRequest = {}) {
      const value = publicationInput(input);
      const client = containerClient.getBlockBlobClient(value.blobName);
      try {
        const response = await client.uploadData(value.bytes, {
          conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: 'text/markdown; charset=utf-8' },
          metadata: {
            contenthash: value.contentHash,
            operationhash: value.operationHash,
            source: 'reviewed-submission'
          },
          ...(optionsForRequest.signal ? { abortSignal: optionsForRequest.signal } : {})
        });
        if (!response?.etag) throw new Error('Azure Blob upload did not return an ETag.');
        return { blobName: value.blobName, etag: response.etag, lastModified: response.lastModified || new Date() };
      } catch (error) {
        if (![409, 412].includes(Number(error?.statusCode))) throw error;
        const properties = await client.getProperties(
          optionsForRequest.signal ? { abortSignal: optionsForRequest.signal } : undefined
        );
        if (
          properties?.metadata?.operationhash !== value.operationHash
          || properties?.metadata?.contenthash !== value.contentHash
        ) {
          throw new PublicationConflictError('The selected public slug is already in use.');
        }
        return { blobName: value.blobName, etag: properties.etag, lastModified: properties.lastModified || new Date() };
      }
    },

    async remove(input, optionsForRequest = {}) {
      const value = publicationIdentity(input);
      const client = containerClient.getBlockBlobClient(value.blobName);
      let properties;
      try {
        properties = await client.getProperties(
          optionsForRequest.signal ? { abortSignal: optionsForRequest.signal } : undefined
        );
      } catch (error) {
        if (Number(error?.statusCode) === 404) return false;
        throw error;
      }
      if (properties?.metadata?.operationhash !== value.operationHash) {
        throw new PublicationConflictError('Refusing to remove a public document owned by another operation.');
      }
      await client.delete({
        conditions: properties.etag ? { ifMatch: properties.etag } : undefined,
        ...(optionsForRequest.signal ? { abortSignal: optionsForRequest.signal } : {})
      });
      return true;
    }
  };
  adapter.publish = adapter.write;
  return adapter;
}

async function defaultSearchRequest(credential, endpoint, path, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener?.('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEARCH_REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(Object.assign(new Error('Azure AI Search request was cancelled.'), { name: 'AbortError' }));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    const token = await Promise.race([credential.getToken(SEARCH_SCOPE), aborted]);
    if (!token?.token) throw new Error('Unable to obtain an Azure AI Search access token.');
    const response = await fetch(`${endpoint}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`Azure AI Search request failed with status ${response.status}.`);
    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timedOut
        ? 'Azure AI Search request timed out.'
        : 'Azure AI Search request was cancelled.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', rejectAbort);
    options.signal?.removeEventListener?.('abort', externalAbort);
  }
}

function createAzureSubmissionIndexer(options = {}) {
  const env = options.env || process.env;
  validateNoKeys(options, env);
  const endpoint = configuredSearchEndpoint(options.endpoint || env.AZURE_SEARCH_ENDPOINT);
  const indexName = configuredName(options.indexName || env.AZURE_SEARCH_INDEX, 'research-chunks-v2', 'Azure Search index name');
  const credential = options.credential || new DefaultAzureCredential({ excludeInteractiveBrowserCredential: true });
  const request = options.request || defaultSearchRequest;
  const wait = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const embeddingClient = options.embeddingClient || createAzureEmbeddingClient({ env, credential });

  async function documentsForSlug(slug, select = 'id', signal) {
    const documents = [];
    const pageSize = 1000;
    let skip = 0;
    while (true) {
      const payload = await request(
        credential,
        endpoint,
        `/indexes/${indexName}/docs/search?api-version=${SEARCH_API_VERSION}`,
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            search: '*',
            filter: `articleSlug eq '${slug}'`,
            select,
            top: pageSize,
            skip
          })
        }
      );
      const page = Array.isArray(payload?.value) ? payload.value : [];
      documents.push(...page);
      if (page.length < pageSize) return documents;
      skip += page.length;
    }
  }

  async function remove(value, optionsForRequest = {}) {
    const slug = typeof value === 'string' ? value : value?.slug;
    if (!SLUG_PATTERN.test(slug || '')) throw new TypeError('Publication slug is invalid.');
    const existing = await documentsForSlug(slug, 'id', optionsForRequest.signal);
    const requestWithSignal = (requestCredential, requestEndpoint, path, requestOptions = {}) => request(
      requestCredential,
      requestEndpoint,
      path,
      { ...requestOptions, signal: optionsForRequest.signal }
    );
    const result = existing.length
      ? await applyIndexActions(
          existing.map((document) => ({ '@search.action': 'delete', id: document.id })),
          { credential, endpoint, indexName, request: requestWithSignal, wait }
        )
      : { deleted: 0 };
    const remaining = await documentsForSlug(slug, 'id', optionsForRequest.signal);
    if (remaining.length) throw new Error('Published Search documents could not be removed completely.');
    return result;
  }

  async function prepare(input, optionsForRequest = {}) {
    const value = publicationInput(input);
    const rawDocuments = buildDocuments({
      slug: value.slug,
      blobName: value.blobName,
      etag: `embedding-${value.contentHash}`,
      lastModified: new Date(0)
    }, value.markdown);
    if (!rawDocuments.length) throw new Error('Publication produced no searchable sections.');
    if (typeof optionsForRequest.onProgress === 'function') {
      await optionsForRequest.onProgress(0, rawDocuments.length);
    }
    const documents = await embedDocuments(rawDocuments, embeddingClient, {
      batchSize: 1,
      onProgress: optionsForRequest.onProgress,
      signal: optionsForRequest.signal
    });
    return Object.freeze({
      contentHash: value.contentHash,
      vectors: Object.freeze(documents.map((document) => Object.freeze(document.contentVector.slice())))
    });
  }

  async function commit(input, prepared, optionsForRequest = {}) {
      const value = publicationInput(input);
      const publicVersion = input.etag || input.publicVersion;
      if (typeof publicVersion !== 'string' || !publicVersion) throw new TypeError('Publication ETag is required.');
      const rawDocuments = buildDocuments({
        slug: value.slug,
        blobName: value.blobName,
        etag: publicVersion,
        lastModified: input.lastModified instanceof Date ? input.lastModified : new Date()
      }, value.markdown);
      if (
        !rawDocuments.length
        || prepared?.contentHash !== value.contentHash
        || !Array.isArray(prepared?.vectors)
        || prepared.vectors.length !== rawDocuments.length
      ) {
        throw new Error('Prepared embeddings do not match the publication content.');
      }
      const documents = rawDocuments.map((document, index) => ({
        ...document,
        contentVector: prepared.vectors[index]
      }));
      const existing = await documentsForSlug(value.slug, 'id', optionsForRequest.signal);
      const actions = [
        ...existing.map((document) => ({ '@search.action': 'delete', id: document.id })),
        ...documents.map((document) => ({ '@search.action': 'mergeOrUpload', ...document }))
      ];
      const requestWithSignal = (requestCredential, requestEndpoint, path, requestOptions = {}) => request(
        requestCredential,
        requestEndpoint,
        path,
        { ...requestOptions, signal: optionsForRequest.signal }
      );
      const result = await applyIndexActions(actions, {
        credential,
        endpoint,
        indexName,
        request: requestWithSignal,
        wait
      });
      const verified = await documentsForSlug(value.slug, 'id,sourceEtag', optionsForRequest.signal);
      const expectedIds = new Set(documents.map((document) => document.id));
      if (
        verified.length !== expectedIds.size
        || verified.some((document) => !expectedIds.has(document.id) || document.sourceEtag !== publicVersion)
      ) {
        throw new Error('Published Search documents could not be verified.');
      }
      return { ...result, verified: verified.length };
  }

  return {
    prepare,
    commit,
    async index(input, optionsForRequest = {}) {
      const prepared = await prepare(input, optionsForRequest);
      return commit(input, prepared, optionsForRequest);
    },
    remove
  };
}

module.exports = {
  MAX_MARKDOWN_BYTES,
  PublicationConfigurationError,
  PublicationConflictError,
  createAzurePublicPublisher,
  createAzureSubmissionIndexer,
  publicationIdentity,
  publicationInput
};
