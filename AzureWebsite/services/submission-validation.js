'use strict';

const path = require('node:path');
const matter = require('gray-matter');
const { createMarkdownRenderer } = require('./research-repository');

const MAX_MARKDOWN_BYTES = 3 * 1024 * 1024;
const DEFAULT_MAX_FRONT_MATTER_BYTES = 16 * 1024;
const DEFAULT_MAX_METADATA_FIELDS = 32;
const DEFAULT_MAX_METADATA_VALUE_LENGTH = 2_000;

class SubmissionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubmissionValidationError';
    this.code = code;
    this.status = 400;
  }
}

function invalid(code, message) {
  throw new SubmissionValidationError(code, message);
}

function assertMarkdownFilename(filename) {
  if (typeof filename !== 'string' || path.posix.extname(filename) !== '.md') {
    invalid('invalid_extension', 'Choose a Markdown file whose name ends in .md.');
  }
}

function decodeUtf8(bytes, maxBytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    invalid('invalid_upload', 'The uploaded file could not be read.');
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0) invalid('empty_file', 'The Markdown file is empty.');
  if (buffer.length > maxBytes) {
    invalid('file_too_large', `The Markdown file must not exceed ${maxBytes} bytes.`);
  }
  if (buffer.includes(0)) invalid('binary_file', 'The upload must be a UTF-8 text file.');

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return invalid('invalid_utf8', 'The upload must be valid UTF-8 text.');
  }
}

function rejectBinaryControls(source) {
  // Tabs, LF, and CR are the only C0 controls useful in Markdown text.
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) {
    invalid('binary_file', 'The upload contains unsupported binary control characters.');
  }
}

function frontMatterBounds(source, maximumBytes) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return;
  const openingLength = source.startsWith('---\r\n') ? 5 : 4;
  const close = /(?:\r?\n)(?:---|\.\.\.)(?:\r?\n|$)/g;
  close.lastIndex = openingLength;
  const match = close.exec(source);
  if (!match) invalid('invalid_front_matter', 'The front matter is not terminated.');
  const end = match.index + match[0].length;
  if (Buffer.byteLength(source.slice(0, end), 'utf8') > maximumBytes) {
    invalid('front_matter_too_large', 'The front matter is too large.');
  }
}

function normalizeMetadataValue(value, maximumLength, pathLabel, traversal = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  traversal.nodes += 1;
  if (traversal.nodes > 256 || depth > 4) {
    invalid('metadata_too_complex', `Metadata field ${pathLabel} is too complex.`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    if (value.length > maximumLength) {
      invalid('metadata_too_large', `Metadata field ${pathLabel} is too long.`);
    }
    return value.normalize('NFC').trim();
  }
  if (Array.isArray(value)) {
    if (value.length > 32) invalid('metadata_too_complex', `Metadata field ${pathLabel} has too many values.`);
    if (traversal.seen.has(value)) invalid('metadata_too_complex', `Metadata field ${pathLabel} is recursive.`);
    traversal.seen.add(value);
    return value.map((item, index) => normalizeMetadataValue(
      item,
      maximumLength,
      `${pathLabel}[${index}]`,
      traversal,
      depth + 1
    ));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 32) invalid('metadata_too_complex', `Metadata field ${pathLabel} is too complex.`);
    if (traversal.seen.has(value)) invalid('metadata_too_complex', `Metadata field ${pathLabel} is recursive.`);
    traversal.seen.add(value);
    return Object.fromEntries(entries.map(([key, item]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        invalid('invalid_metadata', `Metadata field ${pathLabel} contains an invalid key.`);
      }
      return [key, normalizeMetadataValue(item, maximumLength, `${pathLabel}.${key}`, traversal, depth + 1)];
    }));
  }
  invalid('invalid_metadata', `Metadata field ${pathLabel} has an unsupported value.`);
}

function parseBoundedFrontMatter(source, options) {
  frontMatterBounds(source, options.maxFrontMatterBytes);
  let parsed;
  try {
    parsed = matter(source);
  } catch {
    invalid('invalid_front_matter', 'The front matter could not be parsed.');
  }

  const fields = Object.entries(parsed.data || {});
  if (fields.length > options.maxMetadataFields) {
    invalid('metadata_too_complex', 'The front matter has too many fields.');
  }
  const traversal = { nodes: 0, seen: new WeakSet() };
  const metadata = Object.fromEntries(fields.map(([key, value]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      invalid('invalid_metadata', 'The front matter contains an invalid field name.');
    }
    return [key, normalizeMetadataValue(value, options.maxMetadataValueLength, key, traversal)];
  }));
  return { metadata, content: parsed.content };
}

function normalizeMarkdown(source) {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const normalized = withoutBom.normalize('NFC').replace(/\r\n?/g, '\n');
  return `${normalized.replace(/[\t ]+$/gm, '').replace(/\n+$/u, '')}\n`;
}

function validateMarkdownUpload({ filename, bytes } = {}, options = {}) {
  assertMarkdownFilename(filename);
  const limits = {
    maxBytes: options.maxBytes || MAX_MARKDOWN_BYTES,
    maxFrontMatterBytes: options.maxFrontMatterBytes || DEFAULT_MAX_FRONT_MATTER_BYTES,
    maxMetadataFields: options.maxMetadataFields || DEFAULT_MAX_METADATA_FIELDS,
    maxMetadataValueLength: options.maxMetadataValueLength || DEFAULT_MAX_METADATA_VALUE_LENGTH
  };
  const source = decodeUtf8(bytes, limits.maxBytes);
  rejectBinaryControls(source);
  const normalizedMarkdown = normalizeMarkdown(source);
  const parsed = parseBoundedFrontMatter(normalizedMarkdown, limits);
  if (!parsed.content.trim()) invalid('empty_content', 'The Markdown file has no research content.');

  return Object.freeze({
    bytes: Buffer.byteLength(normalizedMarkdown, 'utf8'),
    metadata: Object.freeze(parsed.metadata),
    markdown: normalizedMarkdown
  });
}

function createSanitizedPreview(markdown, renderer = createMarkdownRenderer()) {
  if (typeof markdown !== 'string') invalid('invalid_upload', 'Markdown content is required.');
  const validated = validateMarkdownUpload({
    filename: 'submission.md',
    bytes: Buffer.from(markdown, 'utf8')
  });
  // The public reader parses gray-matter before rendering. Do the same here so
  // YAML is never shown as user content and review/public output stay identical.
  return renderer(matter(validated.markdown).content).html;
}

function safePublicationText(value, maximumLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function safePublicationUrl(value) {
  const normalized = safePublicationText(value, 2_000);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safePublicationDate(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function titleFromContent(content) {
  const heading = content.match(/^#{1,6}\s+(.+)$/m);
  return safePublicationText(heading?.[1]?.replace(/[*_`~\[\]]/g, ''), 240) || 'Research submission';
}

function normalizeSubmissionForPublication(record) {
  if (!record || typeof record.markdown !== 'string') {
    invalid('invalid_upload', 'Validated Markdown content is required.');
  }
  const validated = validateMarkdownUpload({
    filename: 'submission.md',
    bytes: Buffer.from(record.markdown, 'utf8')
  });
  const parsed = matter(validated.markdown);
  const source = { ...validated.metadata, ...(record.metadata || {}) };
  const title = safePublicationText(source.title, 240) || titleFromContent(parsed.content);
  const metadata = { title };
  const description = safePublicationText(source.description, 500);
  const sourceUrl = safePublicationUrl(source.source_url);
  const createdAt = safePublicationDate(source.created_at);
  const modifiedAt = safePublicationDate(source.modified_at);
  if (description) metadata.description = description;
  if (sourceUrl) metadata.source_url = sourceUrl;
  if (createdAt) metadata.created_at = createdAt;
  if (modifiedAt) metadata.modified_at = modifiedAt;

  return Object.freeze({
    title,
    metadata: Object.freeze(metadata),
    markdown: normalizeMarkdown(matter.stringify(parsed.content, metadata))
  });
}

module.exports = {
  MAX_MARKDOWN_BYTES,
  SubmissionValidationError,
  createSanitizedPreview,
  normalizeMarkdown,
  normalizeSubmissionForPublication,
  validateMarkdownUpload
};
