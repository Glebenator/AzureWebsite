'use strict';

const crypto = require('node:crypto');
const matter = require('gray-matter');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');
const { topicForSlug } = require('../data/research-topics');
const {
  headingSlug,
  plainMarkdownText,
  slugFromBlobName
} = require('../services/research-repository');

const SEARCH_API_VERSION = '2026-04-01';
const SEARCH_SCOPE = 'https://search.azure.com/.default';
const DEFAULT_SEARCH_ENDPOINT = 'https://cvkeresearch-search.search.windows.net';
const DEFAULT_INDEX_NAME = 'research-chunks-v1';
const DEFAULT_STORAGE_ACCOUNT = 'cvkeresearch';
const DEFAULT_STORAGE_CONTAINER = 'research';
const MAX_BLOB_BYTES = 3 * 1024 * 1024;
const MAX_CHUNK_CHARACTERS = 2600;
const OVERLAP_CHARACTERS = 320;
const SEARCH_PAGE_SIZE = 1000;
const INDEX_BATCH_SIZE = 500;
const RETRYABLE_INDEX_STATUS_CODES = new Set([409, 422, 429, 503]);
const RETRY_DELAYS_MS = [250, 500, 1000];

function environmentName(value, fallback, pattern, label) {
  const selected = value || fallback;
  if (!pattern.test(selected)) throw new Error(`${label} contains unsupported characters.`);
  return selected;
}

function cleanEndpoint(value) {
  const endpoint = new URL(value || DEFAULT_SEARCH_ENDPOINT);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.search.windows.net')) {
    throw new Error('AZURE_SEARCH_ENDPOINT must be an HTTPS Azure AI Search endpoint.');
  }
  return endpoint.origin;
}

async function streamToString(stream) {
  if (!stream) throw new Error('Blob download did not return a readable stream.');
  const buffers = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BLOB_BYTES) throw new Error('Research blob exceeds the indexing size limit.');
    buffers.push(buffer);
  }
  return Buffer.concat(buffers).toString('utf8');
}

function safeMetadataText(value, fallback, maximumLength) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maximumLength) : fallback;
}

function titleFromSlug(slug) {
  return slug.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function lastBoundary(text, pattern, minimum, maximum) {
  pattern.lastIndex = minimum;
  let selected = -1;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary > maximum) break;
    selected = boundary;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return selected;
}

function preferredChunkBoundary(text, start, maximum) {
  const minimum = start + Math.ceil((maximum - start) * 0.6);
  const patterns = [
    /\n\s*\n/g,
    /[.!?](?:["')\]]*)\s+/g,
    /\s+/g
  ];

  for (const pattern of patterns) {
    const boundary = lastBoundary(text, pattern, minimum, maximum);
    if (boundary !== -1) return boundary;
  }
  return maximum;
}

function sectionChunks(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const chunks = [];
  let start = 0;

  while (start < source.length) {
    if (source.length - start <= MAX_CHUNK_CHARACTERS) {
      const finalChunk = source.slice(start).trim();
      if (finalChunk) chunks.push(finalChunk);
      break;
    }

    const maximum = start + MAX_CHUNK_CHARACTERS;
    const end = preferredChunkBoundary(source, start, maximum);
    const chunk = source.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    let nextStart = Math.max(start + 1, end - OVERLAP_CHARACTERS);
    if (nextStart > start && nextStart < end && !/\s/.test(source[nextStart - 1])) {
      const nextWhitespace = source.slice(nextStart, end).search(/\s/);
      if (nextWhitespace !== -1) nextStart += nextWhitespace + 1;
    }
    while (nextStart < end && /\s/.test(source[nextStart])) nextStart += 1;
    start = nextStart;
  }
  return chunks;
}

function markdownSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const bibliography = /^(?:works cited|references|bibliography|sources|citations)$/i;
  const usedSlugs = new Map([['references', 1]]);
  const sections = [];
  let section = null;
  let topLevelHeading = '';

  function flush() {
    if (!section) return;
    const text = section.lines.join('\n').trim();
    if (text) sections.push({ ...section, text });
  }

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const label = plainMarkdownText(match[2], 'Section');
      if (bibliography.test(label)) {
        flush();
        section = null;
        break;
      }

      const sourceLevel = match[1].length;
      const renderedLevel = sourceLevel === 1 ? 2 : sourceLevel;
      if (renderedLevel === 2 || renderedLevel === 3) {
        flush();
        const id = headingSlug(label, usedSlugs);
        if (renderedLevel === 2) topLevelHeading = label;
        section = {
          headingId: id,
          headingLabel: label,
          headingPath: renderedLevel === 3 && topLevelHeading
            ? `${topLevelHeading} > ${label}`
            : label,
          lines: []
        };
        continue;
      }
    }

    if (!section && line.trim()) {
      section = {
        headingId: 'overview',
        headingLabel: 'Overview',
        headingPath: 'Overview',
        lines: []
      };
    }
    if (section) section.lines.push(line);
  }
  flush();
  return sections;
}

function buildDocuments(entry, source) {
  const parsed = matter(source);
  const title = safeMetadataText(parsed.data.title, titleFromSlug(entry.slug), 240);
  const topic = topicForSlug(entry.slug);
  const documents = [];

  for (const section of markdownSections(parsed.content)) {
    sectionChunks(section.text).forEach((content, ordinal) => {
      const identity = `${entry.blobName}|${entry.etag || ''}|${section.headingId}|${ordinal}`;
      documents.push({
        id: crypto.createHash('sha256').update(identity).digest('hex'),
        articleSlug: entry.slug,
        articleTitle: title,
        articleUrl: `/research/${entry.slug}#${section.headingId}`,
        chunkOrdinal: ordinal,
        content,
        headingId: section.headingId,
        headingLabel: section.headingLabel,
        headingPath: section.headingPath,
        sourceEtag: entry.etag || '',
        sourceModifiedAt: entry.lastModified ? entry.lastModified.toISOString() : null,
        topic: topic.key
      });
    });
  }
  return documents;
}

function indexDefinition(indexName) {
  return {
    name: indexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, filterable: true },
      { name: 'articleSlug', type: 'Edm.String', filterable: true, facetable: true },
      { name: 'articleTitle', type: 'Edm.String', searchable: true },
      { name: 'articleUrl', type: 'Edm.String' },
      { name: 'chunkOrdinal', type: 'Edm.Int32', filterable: true, sortable: true },
      { name: 'content', type: 'Edm.String', searchable: true },
      { name: 'headingId', type: 'Edm.String', filterable: true },
      { name: 'headingLabel', type: 'Edm.String', searchable: true },
      { name: 'headingPath', type: 'Edm.String', searchable: true },
      { name: 'sourceEtag', type: 'Edm.String', filterable: true },
      { name: 'sourceModifiedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
      { name: 'topic', type: 'Edm.String', filterable: true, facetable: true },
      {
        name: 'contentVector',
        type: 'Collection(Edm.Single)',
        searchable: true,
        dimensions: 1536,
        vectorSearchProfile: 'research-vector-profile'
      }
    ],
    vectorSearch: {
      algorithms: [{
        name: 'research-hnsw',
        kind: 'hnsw',
        hnswParameters: { metric: 'cosine' }
      }],
      profiles: [{
        name: 'research-vector-profile',
        algorithm: 'research-hnsw'
      }]
    }
  };
}

async function searchRequest(credential, endpoint, path, options = {}) {
  const token = await credential.getToken(SEARCH_SCOPE);
  if (!token) throw new Error('Unable to obtain an Azure AI Search access token.');
  const response = await fetch(`${endpoint}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`Azure AI Search request failed (${response.status}): ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

async function loadBlobDocuments(containerClient) {
  const documents = [];
  let blobCount = 0;
  for await (const blob of containerClient.listBlobsFlat()) {
    const slug = slugFromBlobName(blob.name);
    if (!slug) continue;
    if (blob.properties.contentLength && blob.properties.contentLength > MAX_BLOB_BYTES) continue;

    const response = await containerClient.getBlobClient(blob.name).download();
    const source = await streamToString(response.readableStreamBody);
    documents.push(...buildDocuments({
      blobName: blob.name,
      slug,
      etag: blob.properties.etag || '',
      lastModified: blob.properties.lastModified || null
    }, source));
    blobCount += 1;
  }
  return { blobCount, documents };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listExistingIds(request, credential, endpoint, indexName) {
  const ids = new Set();
  let skip = 0;

  while (true) {
    const page = await request(
      credential,
      endpoint,
      `/indexes/${indexName}/docs/search?api-version=${SEARCH_API_VERSION}`,
      {
        method: 'POST',
        body: JSON.stringify({ search: '*', select: 'id', top: SEARCH_PAGE_SIZE, skip })
      }
    );
    const values = Array.isArray(page?.value) ? page.value : [];
    values.forEach((document) => {
      if (typeof document?.id === 'string' && document.id) ids.add(document.id);
    });
    if (values.length < SEARCH_PAGE_SIZE) break;
    skip += SEARCH_PAGE_SIZE;
  }
  return [...ids];
}

function normalizeIndexResults(actions, response) {
  const results = Array.isArray(response?.value) ? response.value : [];
  const byKey = new Map();
  results.forEach((result) => {
    if (typeof result?.key === 'string' && !byKey.has(result.key)) byKey.set(result.key, result);
  });
  const hasKeyedResults = byKey.size > 0;

  return actions.map((action, position) => {
    const result = byKey.get(action.id) || (hasKeyedResults ? null : results[position]) || null;
    const parsedCode = Number(result?.statusCode);
    const statusCode = Number.isInteger(parsedCode) ? parsedCode : 0;
    const succeeded = Boolean(result?.status) && statusCode >= 200 && statusCode < 300;
    return {
      action,
      errorMessage: typeof result?.errorMessage === 'string' ? result.errorMessage : '',
      statusCode,
      succeeded
    };
  });
}

function indexingFailure(failures) {
  const detail = failures.slice(0, 5).map((failure) => {
    const message = failure.errorMessage.replace(/\s+/g, ' ').trim().slice(0, 160);
    return `${failure.action.id} (${failure.statusCode || 'missing status'}${message ? `: ${message}` : ''})`;
  }).join(', ');
  const remainder = failures.length > 5 ? ` and ${failures.length - 5} more` : '';
  return new Error(`Azure AI Search rejected ${failures.length} indexing action(s): ${detail}${remainder}`);
}

async function submitIndexBatch({ actions, credential, endpoint, indexName, request, wait }) {
  let pending = actions;
  const successful = [];
  const failed = [];

  for (let attempt = 0; pending.length > 0; attempt += 1) {
    if (attempt > 0) await wait(RETRY_DELAYS_MS[attempt - 1]);
    const response = await request(
      credential,
      endpoint,
      `/indexes/${indexName}/docs/index?api-version=${SEARCH_API_VERSION}`,
      { method: 'POST', body: JSON.stringify({ value: pending }) }
    );
    const retry = [];

    for (const result of normalizeIndexResults(pending, response)) {
      if (result.succeeded) {
        successful.push(result.action);
      } else if (
        RETRYABLE_INDEX_STATUS_CODES.has(result.statusCode)
        && attempt < RETRY_DELAYS_MS.length
      ) {
        retry.push(result.action);
      } else {
        failed.push(result);
      }
    }
    if (failed.length) throw indexingFailure(failed);
    pending = retry;
  }

  return successful;
}

async function applyIndexActions(actions, options) {
  const successful = [];
  for (let index = 0; index < actions.length; index += INDEX_BATCH_SIZE) {
    successful.push(...await submitIndexBatch({
      ...options,
      actions: actions.slice(index, index + INDEX_BATCH_SIZE)
    }));
  }
  return {
    deleted: successful.filter((action) => action['@search.action'] === 'delete').length,
    uploaded: successful.filter((action) => action['@search.action'] === 'mergeOrUpload').length
  };
}

async function synchronizeIndex(credential, endpoint, indexName, documents, options = {}) {
  const request = options.request || searchRequest;
  const wait = options.sleep || sleep;
  await request(
    credential,
    endpoint,
    `/indexes/${indexName}?api-version=${SEARCH_API_VERSION}`,
    { method: 'PUT', body: JSON.stringify(indexDefinition(indexName)) }
  );

  const currentIds = await listExistingIds(request, credential, endpoint, indexName);
  const nextIds = new Set(documents.map((document) => document.id));
  const deletes = currentIds
    .filter((id) => !nextIds.has(id))
    .map((id) => ({ '@search.action': 'delete', id }));
  const uploads = documents.map((document) => ({ '@search.action': 'mergeOrUpload', ...document }));
  const actions = [...deletes, ...uploads];

  return applyIndexActions(actions, {
    credential,
    endpoint,
    indexName,
    request,
    wait
  });
}

async function main() {
  const accountName = environmentName(
    process.env.AZURE_STORAGE_ACCOUNT_NAME,
    DEFAULT_STORAGE_ACCOUNT,
    /^[a-z0-9]{3,24}$/,
    'Azure storage account name'
  );
  const containerName = environmentName(
    process.env.AZURE_STORAGE_CONTAINER,
    DEFAULT_STORAGE_CONTAINER,
    /^[a-z0-9-]{3,63}$/,
    'Azure storage container name'
  );
  const indexName = environmentName(
    process.env.AZURE_SEARCH_INDEX,
    DEFAULT_INDEX_NAME,
    /^[a-z0-9][a-z0-9-]{1,127}$/,
    'Azure AI Search index name'
  );
  const endpoint = cleanEndpoint(process.env.AZURE_SEARCH_ENDPOINT);
  const credential = new DefaultAzureCredential({ excludeInteractiveBrowserCredential: true });
  const blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  const containerClient = blobService.getContainerClient(containerName);

  const loaded = await loadBlobDocuments(containerClient);
  const synchronized = await synchronizeIndex(credential, endpoint, indexName, loaded.documents);
  console.log(
    `Indexed ${synchronized.uploaded} chunks from ${loaded.blobCount} Markdown blobs; `
    + `removed ${synchronized.deleted} stale chunks from ${indexName}.`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  applyIndexActions,
  buildDocuments,
  indexDefinition,
  listExistingIds,
  markdownSections,
  normalizeIndexResults,
  preferredChunkBoundary,
  sectionChunks,
  submitIndexBatch,
  synchronizeIndex
};
