'use strict';

const Busboy = require('busboy');
const { MAX_MARKDOWN_BYTES } = require('./submission-validation');

class MultipartUploadError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MultipartUploadError';
    this.code = code;
    this.status = status;
  }
}

function parseMarkdownMultipart(request, options = {}) {
  const maximumBytes = Number.isInteger(options.maximumBytes) ? options.maximumBytes : MAX_MARKDOWN_BYTES;
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          fieldNameSize: 64,
          fieldSize: 512,
          fields: 1,
          fileSize: maximumBytes,
          files: 1,
          parts: 3
        }
      });
    } catch {
      reject(new MultipartUploadError('invalid_multipart', 'The upload form is invalid.'));
      return;
    }

    let failure = null;
    let csrfToken = '';
    let file = null;
    let filesSeen = 0;

    function fail(code, message) {
      if (!failure) failure = new MultipartUploadError(code, message);
    }

    parser.on('field', (name, value, info) => {
      if (name !== '_csrf' || info.valueTruncated || typeof value !== 'string' || value.length > 256) {
        fail('invalid_form_field', 'The upload form contains an invalid field.');
        return;
      }
      csrfToken = value;
    });

    parser.on('file', (name, stream, info) => {
      filesSeen += 1;
      if (name !== 'researchFile' || filesSeen !== 1) {
        fail('invalid_file_field', 'Choose exactly one Markdown file.');
      }
      const chunks = [];
      let total = 0;
      stream.on('limit', () => fail('file_too_large', 'The Markdown file must not exceed 3 MiB.'));
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maximumBytes) {
          fail('file_too_large', 'The Markdown file must not exceed 3 MiB.');
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        file = {
          bytes: Buffer.concat(chunks),
          filename: typeof info.filename === 'string' ? info.filename : ''
        };
      });
      stream.resume();
    });

    parser.on('filesLimit', () => fail('too_many_files', 'Choose exactly one Markdown file.'));
    parser.on('fieldsLimit', () => fail('too_many_fields', 'The upload form contains too many fields.'));
    parser.on('partsLimit', () => fail('too_many_parts', 'The upload form contains too many parts.'));
    parser.on('error', () => fail('invalid_multipart', 'The upload form could not be read.'));
    parser.on('close', () => {
      if (failure) return reject(failure);
      if (!file || filesSeen !== 1) return reject(new MultipartUploadError('missing_file', 'Choose one Markdown file.'));
      if (!csrfToken) return reject(new MultipartUploadError('missing_csrf', 'The form expired. Refresh and try again.', 403));
      resolve({ csrfToken, file });
    });
    request.pipe(parser);
  });
}

function parseMarkdownEditMultipart(request, options = {}) {
  const maximumBytes = Number.isInteger(options.maximumBytes) ? options.maximumBytes : MAX_MARKDOWN_BYTES;
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          fieldNameSize: 64,
          fieldSize: Math.max(maximumBytes, 512),
          fields: 2,
          files: 0,
          parts: 3
        }
      });
    } catch {
      reject(new MultipartUploadError('invalid_multipart', 'The edit form is invalid.'));
      return;
    }

    let failure = null;
    let csrfToken = '';
    let markdown = null;
    const fieldsSeen = new Set();

    function fail(code, message) {
      if (!failure) failure = new MultipartUploadError(code, message);
    }

    parser.on('field', (name, value, info) => {
      if (fieldsSeen.has(name)) {
        fail('duplicate_form_field', 'The edit form contains a duplicate field.');
        return;
      }
      fieldsSeen.add(name);
      if (name === '_csrf') {
        if (info.valueTruncated || typeof value !== 'string' || value.length > 256) {
          fail('invalid_form_field', 'The edit form contains an invalid field.');
          return;
        }
        csrfToken = value;
        return;
      }
      if (name === 'markdown') {
        if (
          info.valueTruncated
          || typeof value !== 'string'
          || Buffer.byteLength(value, 'utf8') > maximumBytes
        ) {
          fail('file_too_large', 'The Markdown content must not exceed 3 MiB.');
          return;
        }
        markdown = value;
        return;
      }
      fail('invalid_form_field', 'The edit form contains an invalid field.');
    });

    parser.on('file', (_name, stream) => {
      fail('unexpected_file', 'The edit form must not contain a file.');
      stream.resume();
    });
    parser.on('filesLimit', () => fail('unexpected_file', 'The edit form must not contain a file.'));
    parser.on('fieldsLimit', () => fail('too_many_fields', 'The edit form contains too many fields.'));
    parser.on('partsLimit', () => fail('too_many_parts', 'The edit form contains too many parts.'));
    parser.on('error', () => fail('invalid_multipart', 'The edit form could not be read.'));
    parser.on('close', () => {
      if (failure) return reject(failure);
      if (!csrfToken) return reject(new MultipartUploadError('missing_csrf', 'The form expired. Refresh and try again.', 403));
      if (markdown === null) return reject(new MultipartUploadError('missing_markdown', 'Markdown content is required.'));
      resolve({ csrfToken, markdown });
    });
    request.pipe(parser);
  });
}

module.exports = { MultipartUploadError, parseMarkdownEditMultipart, parseMarkdownMultipart };
