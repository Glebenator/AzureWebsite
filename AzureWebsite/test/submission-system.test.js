'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubmissionSystem } = require('../services/submission-system');
const { createInMemorySubmissionRepository } = require('../services/submission-repository');

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

test('public visibility and assistant evidence readiness are independently gated', async () => {
  const repository = createInMemorySubmissionRepository();
  const system = createSubmissionSystem({
    enabled: true,
    adminGoogleSub: 'sole-admin-subject',
    env: { NODE_ENV: 'development' },
    repository
  });
  const record = await repository.create({
    ownerId: 'owner',
    markdown: '---\ntitle: Visibility note\n---\n\n# Finding\n\nEvidence.\n',
    metadata: { title: 'Visibility note' },
    status: 'ready_for_review'
  });
  await repository.reserveSlug(record.id, 'Visibility note');
  const metadata = {
    source: 'reviewed-submission',
    operationhash: crypto.createHash('sha256').update(record.id).digest('hex')
  };

  assert.equal(await system.publicationVisibility({ slug: 'visibility-note', metadata }), false);
  await repository.transition(record.id, 'publishing', {
    publication: { status: 'writing', indexingStatus: 'pending', publicWritten: false, indexed: false }
  });
  await repository.transition(record.id, 'published', {
    publication: { status: 'published', indexingStatus: 'pending', publicWritten: true, indexed: false }
  });
  assert.equal(await system.publicationVisibility({ slug: 'visibility-note', metadata }), true);
  assert.equal(await system.aiVisibility({ slug: 'visibility-note' }), false);
  await repository.patch(record.id, {
    publication: { status: 'published', indexingStatus: 'ready', publicWritten: true, indexed: true }
  }, { requiredStatus: 'published' });
  assert.equal(await system.aiVisibility({ slug: 'visibility-note' }), true);
  assert.equal(await system.publicationVisibility({
    slug: 'visibility-note',
    metadata: { ...metadata, operationhash: 'wrong' }
  }), false);
});
