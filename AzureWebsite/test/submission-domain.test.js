'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createFileSubmissionRepository,
  createInMemorySubmissionRepository
} = require('../services/submission-repository');
const { canTransition } = require('../services/submission-state');
const {
  requireAdmin,
  requireAuthenticated,
  requireOwner
} = require('../services/submission-authorization');

function input(ownerId = 'account-one', title = 'Research title') {
  return { ownerId, markdown: `---\ntitle: ${title}\n---\n# Finding\nEvidence.\n`, metadata: { title } };
}

test('state machine exposes only the reviewed publication path', () => {
  assert.equal(canTransition('pending', 'ready_for_review'), true);
  assert.equal(canTransition('pending', 'publishing'), false);
  assert.equal(canTransition('ready_for_review', 'pending'), true);
  assert.equal(canTransition('ready_for_review', 'publishing'), true);
  assert.equal(canTransition('ready_for_review', 'embedding'), false);
  assert.equal(canTransition('embedding_pending', 'embedding'), true);
  assert.equal(canTransition('embedding', 'publishing'), true);
  assert.equal(canTransition('publishing', 'published'), true);
  assert.equal(canTransition('rejected', 'pending'), true);
  assert.equal(canTransition('failed', 'embedding_pending'), true);
  assert.equal(canTransition('published', 'pending'), false);
});

test('version-1 records migrate publication and AI readiness independently', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-migration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'submissions.json');
  const id = 'abcdefghijklmnopqrstuvwx';
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    slugReservations: { 'recovery-note': id },
    records: {
      [id]: {
        id,
        ownerId: 'owner',
        status: 'publishing',
        markdown: '---\ntitle: Recovery note\n---\n# Finding\nEvidence.\n',
        metadata: { title: 'Recovery note' },
        revision: 1,
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:01:00.000Z',
        publishedSlug: 'recovery-note',
        rejectionReason: null,
        failureCode: 'cleanup_required',
        publication: { publicWritten: true, indexed: false }
      }
    }
  }), { mode: 0o600 });

  const repository = createFileSubmissionRepository({ filePath });
  const migrated = await repository.get(id);
  assert.equal(migrated.status, 'publishing');
  assert.equal(migrated.publication.status, 'verifying');
  assert.equal(migrated.publication.indexingStatus, 'failed');
  assert.equal(migrated.publication.publicWritten, true);
});

test('repository generates opaque IDs, isolates owners, and safely returns revisions to draft', async () => {
  const repository = createInMemorySubmissionRepository();
  const first = await repository.create(input('owner-a'));
  const second = await repository.create(input('owner-b'));

  assert.match(first.id, /^[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(first.id, second.id);
  assert.deepEqual((await repository.listByOwner('owner-a')).map((item) => item.id), [first.id]);

  const replaced = await repository.replace(first.id, 'owner-a', input('owner-a', 'Replacement'));
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.metadata.title, 'Replacement');
  await assert.rejects(() => repository.replace(first.id, 'owner-b', input('owner-b')), { code: 'not_found' });
  await repository.transition(first.id, 'ready_for_review');
  const revised = await repository.replace(first.id, 'owner-a', input('owner-a', 'Revised after submission'));
  assert.equal(revised.status, 'pending');
  assert.equal(revised.revision, 3);
  await repository.transition(first.id, 'ready_for_review');
  await repository.transition(first.id, 'embedding_pending');
  await repository.transition(first.id, 'embedding');
  await repository.transition(first.id, 'publishing');
  await repository.transition(first.id, 'published');
  await assert.rejects(() => repository.replace(first.id, 'owner-a', input('owner-a')), { code: 'state_conflict' });
});

test('durable file repository survives reinstantiation and reserves unique deterministic slugs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-repository-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'private', 'submissions.json');
  const ids = ['abcdefghijklmnopqrstuvwx', 'zyxwvutsrqponmlkjihgfedc'];
  const firstRepository = createFileSubmissionRepository({ filePath, generateId: () => ids.shift(), now: () => 0 });
  const first = await firstRepository.create(input('owner-a', 'Same title'));
  const second = await firstRepository.create(input('owner-b', 'Same title'));
  const firstSlug = await firstRepository.reserveSlug(first.id, first.metadata.title);
  const secondSlug = await firstRepository.reserveSlug(second.id, second.metadata.title);

  assert.equal(firstSlug, 'same-title');
  assert.match(secondSlug, /^same-title-[a-f0-9]{10}$/);
  assert.notEqual(firstSlug, secondSlug);

  const reopened = createFileSubmissionRepository({ filePath });
  assert.equal((await reopened.get(first.id)).markdown, first.markdown);
  assert.equal(await reopened.reserveSlug(first.id, 'Changed title'), firstSlug);
  const mode = (await fs.stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('authorization fails closed without leaking another owner submission and binds admin to Google sub', () => {
  const submission = { id: 'opaque', ownerId: 'internal-owner' };
  const ownerSession = { accountId: 'internal-owner', googleSub: 'google-owner-sub' };
  assert.equal(requireAuthenticated(ownerSession), ownerSession);
  assert.equal(requireOwner(ownerSession, submission), submission);
  assert.throws(
    () => requireOwner({ accountId: 'other-owner', googleSub: 'other-sub' }, submission),
    { code: 'submission_not_found', status: 404 }
  );
  assert.equal(requireAdmin(ownerSession, 'google-owner-sub'), ownerSession);
  assert.throws(() => requireAdmin(ownerSession, 'different-admin-subject'), { code: 'admin_required', status: 403 });
  assert.throws(() => requireAuthenticated(null), { code: 'authentication_required', status: 401 });
});
