'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_MARKDOWN_BYTES,
  SubmissionValidationError,
  createSanitizedPreview,
  normalizeSubmissionForPublication,
  validateMarkdownUpload
} = require('../services/submission-validation');

function validate(text, filename = 'research.md', options) {
  return validateMarkdownUpload({ filename, bytes: Buffer.from(text) }, options);
}

test('validates actual Markdown bytes, normalizes text, and returns bounded metadata', () => {
  const result = validate('---\r\ntitle: Cafe\u0301\r\ntags: [one, two]\r\n---\r\n# Finding  \r\nEvidence.\r\n');

  assert.equal(result.metadata.title, 'Caf\u00e9');
  assert.deepEqual(result.metadata.tags, ['one', 'two']);
  assert.equal(result.markdown, '---\ntitle: Caf\u00e9\ntags: [one, two]\n---\n# Finding\nEvidence.\n');
  assert.equal(result.bytes, Buffer.byteLength(result.markdown));
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'filename'), false);
});

test('requires the exact .md extension but never derives identity from the filename', () => {
  assert.throws(() => validate('# ok', 'research.markdown'), { code: 'invalid_extension' });
  assert.throws(() => validate('# ok', 'research.MD'), { code: 'invalid_extension' });
  assert.doesNotThrow(() => validate('# ok', '../../untrusted name.md'));
});

test('enforces the 3 MiB bound against actual bytes and rejects malformed or binary text', () => {
  assert.throws(
    () => validateMarkdownUpload({ filename: 'large.md', bytes: Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61) }),
    { code: 'file_too_large' }
  );
  assert.throws(
    () => validateMarkdownUpload({ filename: 'bad.md', bytes: Buffer.from([0xc3, 0x28]) }),
    { code: 'invalid_utf8' }
  );
  assert.throws(() => validate('valid\0hidden'), { code: 'binary_file' });
  assert.throws(() => validate('valid\u0001hidden'), { code: 'binary_file' });
  assert.throws(() => validate(''), { code: 'empty_file' });
});

test('bounds and validates front matter before publication', () => {
  assert.throws(
    () => validate(`---\ntitle: ${'x'.repeat(200)}\n---\nBody`, 'research.md', { maxMetadataValueLength: 20 }),
    { code: 'metadata_too_large' }
  );
  assert.throws(
    () => validate(`---\ntitle: ${'x'.repeat(200)}\n---\nBody`, 'research.md', { maxFrontMatterBytes: 64 }),
    { code: 'front_matter_too_large' }
  );
  assert.throws(() => validate('---\ntitle: no close\nBody'), { code: 'invalid_front_matter' });
  assert.throws(() => validate('---\ntitle: only metadata\n---\n'), { code: 'empty_content' });
  assert.throws(
    () => validate('---\na:\n  b:\n    c:\n      d:\n        e:\n          f: too deep\n---\nBody'),
    { code: 'metadata_too_complex' }
  );
});

test('uses the shared research renderer so hostile HTML is escaped and unsafe URLs are absent', () => {
  const preview = createSanitizedPreview([
    '# Safe title',
    '<script>alert(document.cookie)</script>',
    '[unsafe](javascript:alert(1))',
    '[safe](https://example.com)'
  ].join('\n\n'));

  assert.doesNotMatch(preview, /<script/i);
  assert.doesNotMatch(preview, /href="javascript:/i);
  assert.match(preview, /&lt;script&gt;/);
  assert.match(preview, /href="https:\/\/example\.com\/"/);
  assert.throws(() => createSanitizedPreview(null), SubmissionValidationError);
});

test('preview strips front matter and publication normalization keeps only public metadata', () => {
  const markdown = [
    '---',
    'title: Public title',
    'description: Public description',
    'source_url: https://example.com/source',
    'created_at: 2026-07-22',
    'private_note: private-contact-value',
    '---',
    '# Finding',
    'Evidence.'
  ].join('\n');

  const preview = createSanitizedPreview(markdown);
  assert.doesNotMatch(preview, /Public title|private_note|private-contact-value/);
  assert.match(preview, /<h2[^>]*>Finding/);

  const normalized = normalizeSubmissionForPublication({ markdown, metadata: { title: 'Public title' } });
  assert.equal(normalized.title, 'Public title');
  assert.match(normalized.markdown, /description: Public description/);
  assert.match(normalized.markdown, /source_url: ['"]?https:\/\/example\.com\/source['"]?/);
  assert.doesNotMatch(normalized.markdown, /private_note|private-contact-value/);
  assert.match(normalized.markdown, /# Finding/);
});
