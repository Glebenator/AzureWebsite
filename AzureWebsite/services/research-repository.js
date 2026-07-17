'use strict';

const path = require('node:path');
const matter = require('gray-matter');
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');
const { topicForSlug } = require('../data/research-topics');

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

function normalizeReferenceList(markdownSource) {
  const lines = markdownSource.split(/\r?\n/);
  const bibliographyHeading = /^#{1,6}\s+(?:\*\*|__)?\s*(?:works cited|references|bibliography|sources|citations)\s*(?:\*\*|__)?\s*$/i;
  const headingIndex = lines.findIndex((line) => bibliographyHeading.test(line.trim()));
  if (headingIndex === -1) return markdownSource;

  const bibliography = lines.slice(headingIndex + 1).join('\n').replace(
    /(^|[ \t]+)([1-9]\d{0,2})\\\.\s+/gm,
    (match, prefix, referenceNumber) => `${prefix ? '\n' : ''}${referenceNumber}. `
  );
  return [...lines.slice(0, headingIndex + 1), bibliography].join('\n');
}

function plainMarkdownText(value, fallback = '') {
  return safeText(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[\\*_~`]+/g, '')
      .replace(/&amp;/g, '&'),
    fallback,
    240
  );
}

function headingSlug(label, usedSlugs) {
  const base = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  const nextCount = (usedSlugs.get(base) || 0) + 1;
  usedSlugs.set(base, nextCount);
  return nextCount === 1 ? base : `${base}-${nextCount}`;
}

function collectReferenceDetails(markdownSource) {
  const lines = markdownSource.split(/\r?\n/);
  const bibliographyHeading = /^#{1,6}\s+(?:\*\*|__)?\s*(?:works cited|references|bibliography|sources|citations)\s*(?:\*\*|__)?\s*$/i;
  const headingIndex = lines.findIndex((line) => bibliographyHeading.test(line.trim()));
  if (headingIndex === -1) return new Map();

  const details = new Map();
  for (const line of lines.slice(headingIndex + 1)) {
    const match = line.match(/^\s*([1-9]\d{0,2})\.\s+(.+)$/);
    if (!match) continue;

    const referenceNumber = Number.parseInt(match[1], 10);
    const rawReference = match[2].trim();
    const markdownUrl = rawReference.match(/\]\((https?:\/\/[^)]+)\)/i);
    const bareUrl = rawReference.match(/https?:\/\/[^\s)]+/i);
    const sourceUrl = safeSourceUrl((markdownUrl && markdownUrl[1]) || (bareUrl && bareUrl[0]));
    let domain = '';
    if (sourceUrl) {
      domain = new URL(sourceUrl).hostname.replace(/^www\./, '').slice(0, 120);
    }

    const titleSource = rawReference
      .replace(/,?\s*accessed\s+.+$/i, '')
      .replace(/,?\s*\[?https?:\/\/.+$/i, '');
    details.set(referenceNumber, {
      domain,
      title: plainMarkdownText(titleSource, `Reference ${referenceNumber}`).slice(0, 180)
    });
  }
  return details;
}

function createCitationTokens(state, referenceNumber, counters, referenceDetails) {
  const occurrence = (counters.get(referenceNumber) || 0) + 1;
  counters.set(referenceNumber, occurrence);
  const detail = referenceDetails.get(referenceNumber) || {};

  const open = new state.Token('link_open', 'a', 1);
  open.attrSet('href', `#reference-${referenceNumber}`);
  open.attrSet('id', `citation-${referenceNumber}-${occurrence}`);
  open.attrSet('class', 'research-citation');
  open.attrSet('aria-label', `Reference ${referenceNumber}`);
  if (detail.title) open.attrSet('data-reference-title', detail.title);
  if (detail.domain) open.attrSet('data-reference-domain', detail.domain);

  const text = new state.Token('text', '', 0);
  text.content = String(referenceNumber);

  const close = new state.Token('link_close', 'a', -1);
  return [open, text, close];
}

function linkCitationText(state, content, referenceDetails, counters) {
  const pattern = /\[([1-9]\d{0,2}(?:\s*[,–-]\s*[1-9]\d{0,2})*)\]|([.,;:!?)\]’”])([1-9]\d{0,2})(?=$|[\s.,;:)\]’”])/g;
  const tokens = [];
  let cursor = 0;
  let match;

  function pushText(value) {
    if (!value) return;
    const token = new state.Token('text', '', 0);
    token.content = value;
    tokens.push(token);
  }

  while ((match = pattern.exec(content)) !== null) {
    const bracketed = match[1];
    const punctuation = match[2];
    const singleReference = match[3] ? Number.parseInt(match[3], 10) : null;
    const decimalLike = punctuation === '.' && /\d/.test(content.charAt(match.index - 1));
    const hasLinkedReference = bracketed
      ? bracketed.split(/\s*[,–-]\s*/).some((value) => referenceDetails.has(Number.parseInt(value, 10)))
      : referenceDetails.has(singleReference);

    if (decimalLike || !hasLinkedReference) continue;

    pushText(content.slice(cursor, match.index));
    if (bracketed) {
      pushText('[');
      const pieces = bracketed.split(/(\s*[,–-]\s*)/);
      for (const piece of pieces) {
        if (/^[1-9]\d{0,2}$/.test(piece) && referenceDetails.has(Number.parseInt(piece, 10))) {
          tokens.push(...createCitationTokens(
            state,
            Number.parseInt(piece, 10),
            counters,
            referenceDetails
          ));
        } else {
          pushText(piece);
        }
      }
      pushText(']');
    } else {
      pushText(punctuation);
      tokens.push(...createCitationTokens(state, singleReference, counters, referenceDetails));
    }
    cursor = pattern.lastIndex;
  }

  if (cursor === 0) return null;
  pushText(content.slice(cursor));
  return tokens;
}

function appendHeadingPermalink(state, headingToken, id, label) {
  if (!headingToken.children) headingToken.children = [];
  const spacing = new state.Token('text', '', 0);
  spacing.content = ' ';
  const open = new state.Token('link_open', 'a', 1);
  open.attrSet('href', `#${id}`);
  open.attrSet('class', 'heading-permalink');
  open.attrSet('aria-label', `Link to ${label}`);
  const text = new state.Token('text', '', 0);
  text.content = '#';
  const close = new state.Token('link_close', 'a', -1);
  headingToken.children.push(spacing, open, text, close);
}

function appendReferenceBacklinks(state, inlineToken, referenceNumber, citationCount) {
  if (!inlineToken || !inlineToken.children || citationCount < 1) return;
  const openSpan = new state.Token('html_inline', '', 0);
  openSpan.content = '<span class="reference-backlinks">';
  const label = new state.Token('text', '', 0);
  label.content = citationCount === 1 ? 'Used once: ' : `Used ${citationCount} times: `;
  inlineToken.children.push(openSpan, label);

  for (let occurrence = 1; occurrence <= citationCount; occurrence += 1) {
    if (occurrence > 1) {
      const separator = new state.Token('text', '', 0);
      separator.content = ', ';
      inlineToken.children.push(separator);
    }
    const open = new state.Token('link_open', 'a', 1);
    open.attrSet('href', `#citation-${referenceNumber}-${occurrence}`);
    open.attrSet('class', 'reference-backlink');
    open.attrSet(
      'aria-label',
      `Back to citation ${occurrence} of ${citationCount} for reference ${referenceNumber}`
    );
    const text = new state.Token('text', '', 0);
    text.content = String(occurrence);
    const close = new state.Token('link_close', 'a', -1);
    inlineToken.children.push(open, text, close);
  }

  const closeSpan = new state.Token('html_inline', '', 0);
  closeSpan.content = '</span>';
  inlineToken.children.push(closeSpan);
}

function addResearchNavigation(markdown) {
  markdown.core.ruler.after('inline', 'research-navigation', function(state) {
    const referenceDetails = state.env.referenceDetails;
    const counters = new Map();
    const referenceInlineTokens = new Map();
    const usedSlugs = new Map([['references', 1]]);
    let inBibliography = false;
    let referenceNumber = 1;
    let currentReferenceNumber = null;

    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type === 'heading_open') {
        const heading = state.tokens[index + 1];
        const label = heading && heading.type === 'inline'
          ? plainMarkdownText(heading.content, 'Section')
          : 'Section';
        const normalizedHeading = label.toLowerCase();
        const isBibliography = /^(works cited|references|bibliography|sources|citations)$/.test(normalizedHeading);
        const renderedLevel = token.tag === 'h1' ? 2 : Number.parseInt(token.tag.slice(1), 10);

        if (isBibliography) {
          inBibliography = true;
          token.attrSet('id', 'references');
          token.attrSet('class', 'research-references-heading');
          appendHeadingPermalink(state, heading, 'references', label);
          state.env.toc.push({ id: 'references', label, level: 2 });
        } else if (renderedLevel === 2 || renderedLevel === 3) {
          const id = headingSlug(label, usedSlugs);
          token.attrSet('id', id);
          token.attrSet('class', 'research-section-heading');
          appendHeadingPermalink(state, heading, id, label);
          state.env.toc.push({ id, label, level: renderedLevel });
        }
      }

      if (inBibliography) {
        if (token.type === 'ordered_list_open') {
          referenceNumber = Number.parseInt(token.attrGet('start') || '1', 10);
        }
        if (token.type === 'list_item_open') {
          token.attrSet('id', `reference-${referenceNumber}`);
          token.attrSet('class', 'research-reference');
          currentReferenceNumber = referenceNumber;
          referenceNumber += 1;
        }
        if (token.type === 'inline' && currentReferenceNumber !== null) {
          referenceInlineTokens.set(currentReferenceNumber, token);
          currentReferenceNumber = null;
        }
        continue;
      }

      if (!(referenceDetails instanceof Map) || referenceDetails.size === 0) continue;
      if (token.type !== 'inline' || !token.children) continue;
      const linkedChildren = [];
      let linkDepth = 0;
      for (const child of token.children) {
        if (child.type === 'link_open') linkDepth += 1;
        if (child.type === 'text' && linkDepth === 0) {
          const citationTokens = linkCitationText(state, child.content, referenceDetails, counters);
          linkedChildren.push(...(citationTokens || [child]));
        } else {
          linkedChildren.push(child);
        }
        if (child.type === 'link_close') linkDepth -= 1;
      }
      token.children = linkedChildren;
    }

    for (const [number, count] of counters.entries()) {
      appendReferenceBacklinks(state, referenceInlineTokens.get(number), number, count);
    }
    state.env.citationCount = Array.from(counters.values()).reduce((total, count) => total + count, 0);
  });
}

function createMarkdownRenderer() {
  const markdown = new MarkdownIt({
    breaks: false,
    html: false,
    linkify: true,
    typographer: false
  });
  addResearchNavigation(markdown);

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
    const normalizedSource = normalizeReferenceList(markdownSource);
    const environment = {
      citationCount: 0,
      referenceDetails: collectReferenceDetails(normalizedSource),
      toc: []
    };
    const rendered = markdown.render(normalizedSource, environment);
    const headingIds = new Set(environment.toc.map((item) => item.id));
    const html = sanitizeHtml(rendered, {
      allowedTags: [
        'a', 'blockquote', 'br', 'code', 'del', 'em', 'h2', 'h3', 'h4', 'h5', 'h6',
        'hr', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td',
        'th', 'thead', 'tr', 'ul'
      ],
      allowedAttributes: {
        a: [
          'aria-label', 'class', 'data-reference-domain', 'data-reference-title', 'href',
          'id', 'rel', 'target', 'title'
        ],
        h2: ['class', 'id'],
        h3: ['class', 'id'],
        h4: ['class', 'id'],
        h5: ['class', 'id'],
        h6: ['class', 'id'],
        li: ['class', 'id'],
        span: ['class'],
        th: ['scope']
      },
      allowedSchemes: ['http', 'https'],
      disallowedTagsMode: 'discard',
      transformTags: {
        a(tagName, attribs) {
          if (/^#reference-[1-9]\d{0,2}$/.test(attribs.href || '')) {
            return {
              tagName,
              attribs: {
                href: attribs.href,
                class: 'research-citation',
                ...( /^citation-[1-9]\d{0,2}-[1-9]\d*$/.test(attribs.id || '') ? { id: attribs.id } : {}),
                ...( /^Reference [1-9]\d{0,2}$/.test(attribs['aria-label'] || '')
                  ? { 'aria-label': attribs['aria-label'] }
                  : {}),
                ...(attribs['data-reference-title']
                  ? { 'data-reference-title': safeText(attribs['data-reference-title'], '', 180) }
                  : {}),
                ...( /^[a-z0-9.-]{1,120}$/i.test(attribs['data-reference-domain'] || '')
                  ? { 'data-reference-domain': attribs['data-reference-domain'] }
                  : {})
              }
            };
          }
          if (/^#citation-[1-9]\d{0,2}-[1-9]\d*$/.test(attribs.href || '')) {
            return {
              tagName,
              attribs: {
                href: attribs.href,
                class: 'reference-backlink',
                ...(attribs['aria-label'] ? { 'aria-label': safeText(attribs['aria-label'], '', 160) } : {})
              }
            };
          }
          if (/^#[a-z0-9-]+$/.test(attribs.href || '') && headingIds.has(attribs.href.slice(1))) {
            return {
              tagName,
              attribs: {
                href: attribs.href,
                class: 'heading-permalink',
                ...(attribs['aria-label'] ? { 'aria-label': safeText(attribs['aria-label'], '', 260) } : {})
              }
            };
          }
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
    return {
      citationCount: environment.citationCount,
      html,
      toc: environment.toc
    };
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
    const rendered = renderMarkdown(parsed.content);
    const renderResult = typeof rendered === 'string'
      ? { citationCount: 0, html: rendered, toc: [] }
      : rendered;
    const article = {
      slug: entry.slug,
      title,
      excerpt,
      topic: topicForSlug(entry.slug),
      sourceUrl: safeSourceUrl(parsed.data.source_url),
      createdAt: safeIsoDate(parsed.data.created_at, entry.lastModified),
      modifiedAt: safeIsoDate(parsed.data.modified_at, entry.lastModified),
      readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
      citationCount: renderResult.citationCount,
      html: renderResult.html,
      toc: renderResult.toc
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
        items: articles.map(({ citationCount, html, sourceUrl, toc, ...summary }) => summary)
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
