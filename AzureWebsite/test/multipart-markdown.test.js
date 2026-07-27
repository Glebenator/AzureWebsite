'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { parseMarkdownMultipart } = require('../services/multipart-markdown');

function multipart(parts, boundary = 'test-boundary') {
  const body = parts.map((part) => {
    if (part.file) {
      return [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        'Content-Type: application/octet-stream\r\n\r\n',
        part.value,
        '\r\n'
      ].join('');
    }
    return [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`,
      part.value,
      '\r\n'
    ].join('');
  }).join('') + `--${boundary}--\r\n`;
  const request = Readable.from([Buffer.from(body)]);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

test('multipart parser returns one opaque Markdown upload and CSRF field without trusting MIME', async () => {
  const result = await parseMarkdownMultipart(multipart([
    { name: '_csrf', value: 'csrf-token' },
    { file: true, name: 'researchFile', filename: 'note.md', value: '# Note\n' }
  ]));
  assert.equal(result.csrfToken, 'csrf-token');
  assert.equal(result.file.filename, 'note.md');
  assert.equal(result.file.bytes.toString('utf8'), '# Note\n');
});

test('multipart parser rejects oversized, missing, and unexpected file fields', async () => {
  await assert.rejects(
    parseMarkdownMultipart(multipart([
      { name: '_csrf', value: 'csrf-token' },
      { file: true, name: 'researchFile', filename: 'note.md', value: '123456' }
    ]), { maximumBytes: 5 }),
    (error) => error.code === 'file_too_large'
  );
  await assert.rejects(
    parseMarkdownMultipart(multipart([{ name: '_csrf', value: 'csrf-token' }])),
    (error) => error.code === 'missing_file'
  );
  await assert.rejects(
    parseMarkdownMultipart(multipart([
      { name: '_csrf', value: 'csrf-token' },
      { file: true, name: 'other', filename: 'note.md', value: '# Note' }
    ])),
    (error) => error.code === 'invalid_file_field'
  );
});
