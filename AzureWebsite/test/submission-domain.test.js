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
  assert.equal(canTransition('ready_for_review', 'publishing'), true);
  assert.equal(canTransition('publishing', 'published'), true);
  assert.equal(canTransition('failed', 'publishing'), true);
  assert.equal(canTransition('published', 'pending'), false);
});

test('repository generates opaque IDs, isolates owner lists, and permits replacement only while pending', async () => {
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
