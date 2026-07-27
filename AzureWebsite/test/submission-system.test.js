'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubmissionSystem } = require('../services/submission-system');

test('submission storage configuration fails closed inside the public directory', () => {
  assert.throws(() => createSubmissionSystem({
    env: {
      RESEARCH_SUBMISSIONS_ENABLED: 'true',
      ADMIN_GOOGLE_SUB: 'sole-admin-subject',
      SUBMISSION_DATA_FILE: path.resolve(__dirname, '..', 'public', 'submissions.json')
    }
  }), /outside the publicly served directory/i);
});

test('submission storage rejects an external-looking parent symlink into public', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-path-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const linkedParent = path.join(temporaryRoot, 'private-data');
  fs.symlinkSync(path.resolve(__dirname, '..', 'public'), linkedParent, 'dir');

  assert.throws(() => createSubmissionSystem({
    env: {
      RESEARCH_SUBMISSIONS_ENABLED: 'true',
      ADMIN_GOOGLE_SUB: 'sole-admin-subject',
      SUBMISSION_DATA_FILE: path.join(linkedParent, 'submissions.json')
    }
  }), /outside the publicly served directory/i);
});

test('submission storage rejects an existing symbolic-link target', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-file-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const realFile = path.join(temporaryRoot, 'real.json');
  const linkedFile = path.join(temporaryRoot, 'linked.json');
  fs.writeFileSync(realFile, '{}', { mode: 0o600 });
  fs.symlinkSync(realFile, linkedFile, 'file');

  assert.throws(() => createSubmissionSystem({
    env: {
      RESEARCH_SUBMISSIONS_ENABLED: 'true',
      ADMIN_GOOGLE_SUB: 'sole-admin-subject',
      SUBMISSION_DATA_FILE: linkedFile
    }
  }), /must not be a symbolic link/i);
});
