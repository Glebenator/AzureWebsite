'use strict';

const path = require('node:path');
const matter = require('gray-matter');
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const DEFAULT_ACCOUNT_NAME = 'cvkeresearch';
const DEFAULT_CONTAINER_NAME = 'research';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_CACHE_TTL_MS = 10 * 1000;
const MAX_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_BLOB_BYTES = 3 * 1024 * 1024;
const MAX_EXCERPT_LENGTH = 220;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class ResearchStorageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ResearchStorageError';
  }
}

function boundedCacheTtl(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CACHE_TTL_MS;
  return Math.min(MAX_CACHE_TTL_MS, Math.max(MIN_CACHE_TTL_MS, parsed));
}

function validateStorageName(value, label) {
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return value;
}

function createDefaultContainerClient(options = {}) {
  const accountName = validateStorageName(
    options.accountName || process.env.AZURE_STORAGE_ACCOUNT_NAME || DEFAULT_ACCOUNT_NAME,
    'Azure storage account name'
  );
  const containerName = validateStorageName(
    options.containerName || process.env.AZURE_STORAGE_CONTAINER || DEFAULT_CONTAINER_NAME,
    'Azure storage container name'
  );
  const credential = options.credential || new DefaultAzureCredential({
    excludeInteractiveBrowserCredential: true
  });
  const serviceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  );

  return serviceClient.getContainerClient(containerName);
}

function slugFromBlobName(blobName) {
  const extension = path.posix.extname(blobName).toLowerCase();
  if (extension !== '.md' && extension !== '.markdown') return null;

  const baseName = path.posix.basename(blobName, extension)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return SLUG_PATTERN.test(baseName) ? baseName : null;
}

function safeText(value, fallback, maxLength = 300) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function safeSourceUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeIsoDate(value, fallback) {
  const date = value ? new Date(value) : null;
  if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  if (fallback instanceof Date && !Number.isNaN(fallback.getTime())) return fallback.toISOString();
  return null;
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function extractExcerpt(markdown) {
  const plainText = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (plainText.length <= MAX_EXCERPT_LENGTH) return plainText;
  return `${plainText.slice(0, MAX_EXCERPT_LENGTH).replace(/\s+\S*$/, '')}…`;
}

function createMarkdownRenderer() {
  const markdown = new MarkdownIt({
    breaks: false,
    html: false,
    linkify: true,
    typographer: false
  });

  const defaultHeadingOpen = markdown.renderer.rules.heading_open
    || ((tokens, index, rendererOptions, environment, renderer) => renderer.renderToken(tokens, index, rendererOptions));
  const defaultHeadingClose = markdown.renderer.rules.heading_close
    || ((tokens, index, rendererOptions, environment, renderer) => renderer.renderToken(tokens, index, rendererOptions));

  markdown.renderer.rules.heading_open = function(tokens, index, rendererOptions, environment, renderer) {
    if (tokens[index].tag === 'h1') tokens[index].tag = 'h2';
    return defaultHeadingOpen(tokens, index, rendererOptions, environment, renderer);
  };
  markdown.renderer.rules.heading_close = function(tokens, index, rendererOptions, environment, renderer) {
    if (tokens[index].tag === 'h1') tokens[index].tag = 'h2';
    return defaultHeadingClose(tokens, index, rendererOptions, environment, renderer);
  };

  return function render(markdownSource) {
    const rendered = markdown.render(markdownSource);
    return sanitizeHtml(rendered, {
      allowedTags: [
        'a', 'blockquote', 'br', 'code', 'del', 'em', 'h2', 'h3', 'h4', 'h5', 'h6',
        'hr', 'li', 'ol', 'p', 'pre', 's', 'strong', 'table', 'tbody', 'td', 'th',
        'thead', 'tr', 'ul'
      ],
      allowedAttributes: {
        a: ['href', 'rel', 'target', 'title'],
        th: ['scope']
      },
      allowedSchemes: ['http', 'https'],
      disallowedTagsMode: 'discard',
      transformTags: {
        a(tagName, attribs) {
          const href = safeSourceUrl(attribs.href);
          if (!href) return { tagName: 'span', attribs: {} };
          return {
            tagName,
            attribs: {
              href,
              rel: 'noopener noreferrer',
              target: '_blank',
              ...(attribs.title ? { title: safeText(attribs.title, '', 200) } : {})
            }
          };
        }
      }
    });
  };
}

async function streamToString(stream, maximumBytes) {
  if (!stream) throw new Error('Blob download did not return a readable stream.');

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) throw new Error('Research blob exceeds the configured size limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function createResearchRepository(options = {}) {
  const containerClient = options.containerClient || createDefaultContainerClient(options);
  const cacheTtlMs = boundedCacheTtl(options.cacheTtlMs || process.env.RESEARCH_CACHE_TTL_MS);
  const now = options.now || Date.now;
  const renderMarkdown = options.renderMarkdown || createMarkdownRenderer();
  let catalog = null;
  let refreshPromise = null;
  const articleCache = new Map();

  async function downloadAndParse(entry, freshlyEnumerated = false) {
    const cached = articleCache.get(entry.blobName);
    const cacheIdentityMatches = cached && cached.etag === entry.etag;
    const cacheIsCurrent = cacheIdentityMatches && cached.expiresAt > now();
    const cacheWasRevalidated = cacheIdentityMatches && freshlyEnumerated && Boolean(entry.etag);
    if (cached && (cacheIsCurrent || cacheWasRevalidated)) {
      return cached.article;
    }

    const response = await containerClient.getBlobClient(entry.blobName).download();
    const source = await streamToString(response.readableStreamBody, MAX_BLOB_BYTES);
    const parsed = matter(source);
    const fallbackTitle = titleFromSlug(entry.slug);
    const title = safeText(parsed.data.title, fallbackTitle, 240);
    const excerpt = safeText(parsed.data.description, extractExcerpt(parsed.content), MAX_EXCERPT_LENGTH + 1);
    const wordCount = parsed.content.trim().split(/\s+/).filter(Boolean).length;
    const article = {
      slug: entry.slug,
      title,
      excerpt,
      sourceUrl: safeSourceUrl(parsed.data.source_url),
      createdAt: safeIsoDate(parsed.data.created_at, entry.lastModified),
      modifiedAt: safeIsoDate(parsed.data.modified_at, entry.lastModified),
      readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
      html: renderMarkdown(parsed.content)
    };

    articleCache.set(entry.blobName, {
      article,
      etag: entry.etag,
      expiresAt: now() + cacheTtlMs
    });
    return article;
  }

  async function refreshCatalog() {
    try {
      const entries = [];
      for await (const blob of containerClient.listBlobsFlat()) {
        const slug = slugFromBlobName(blob.name);
        if (!slug) continue;
        if (blob.properties.contentLength && blob.properties.contentLength > MAX_BLOB_BYTES) continue;
        entries.push({
          blobName: blob.name,
          slug,
          etag: blob.properties.etag || null,
          lastModified: blob.properties.lastModified || null
        });
      }

      const bySlug = new Map();
      const currentBlobNames = new Set();
      for (const entry of entries) {
        if (bySlug.has(entry.slug)) throw new Error(`Duplicate research slug: ${entry.slug}`);
        bySlug.set(entry.slug, entry);
        currentBlobNames.add(entry.blobName);
      }

      for (const blobName of articleCache.keys()) {
        if (!currentBlobNames.has(blobName)) articleCache.delete(blobName);
      }

      const articles = await mapWithConcurrency(entries, 4, (entry) => downloadAndParse(entry, true));
      articles.sort((left, right) => {
        const leftDate = left.modifiedAt || left.createdAt || '';
        const rightDate = right.modifiedAt || right.createdAt || '';
        return rightDate.localeCompare(leftDate) || left.title.localeCompare(right.title);
      });

      catalog = {
        bySlug,
        expiresAt: now() + cacheTtlMs,
        items: articles.map(({ html, sourceUrl, ...summary }) => summary)
      };
      return catalog;
    } catch (error) {
      throw new ResearchStorageError('The research library could not be loaded.', { cause: error });
    }
  }

  async function getCatalog() {
    if (catalog && catalog.expiresAt > now()) return catalog;
    if (!refreshPromise) {
      refreshPromise = refreshCatalog().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  return {
    async listArticles() {
      const currentCatalog = await getCatalog();
      return currentCatalog.items;
    },

    async getArticle(slug) {
      if (!SLUG_PATTERN.test(slug)) return null;
      const currentCatalog = await getCatalog();
      const entry = currentCatalog.bySlug.get(slug);
      if (!entry) return null;
      try {
        return await downloadAndParse(entry);
      } catch (error) {
        if (error instanceof ResearchStorageError) throw error;
        throw new ResearchStorageError('The research article could not be loaded.', { cause: error });
      }
    },

    clearCache() {
      catalog = null;
      articleCache.clear();
    }
  };
}

module.exports = {
  ResearchStorageError,
  createResearchRepository,
  createMarkdownRenderer,
  slugFromBlobName
};
