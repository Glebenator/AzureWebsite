'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { assertSubmissionState, assertTransition } = require('./submission-state');

const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

class SubmissionRepositoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SubmissionRepositoryError';
    this.code = code;
    this.status = status;
  }
}

function generateOpaqueId() {
  return crypto.randomBytes(24).toString('base64url');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) {
    throw new SubmissionRepositoryError('invalid_owner', 'A valid internal owner identifier is required.');
  }
  return ownerId;
}

function cleanMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown) {
    throw new SubmissionRepositoryError('invalid_content', 'Validated Markdown content is required.');
  }
  return markdown;
}

function cleanMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return clone(metadata);
}

function slugBase(value) {
  const slug = String(value || 'research-submission')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'research-submission';
}

function newStore() {
  return { version: STORE_VERSION, records: {}, slugReservations: {} };
}

function migratePublication(record) {
  const publication = record.publication && typeof record.publication === 'object'
    ? clone(record.publication)
    : {};
  const legacyStatus = record.status;

  if (!publication.status) {
    if (legacyStatus === 'published') publication.status = 'published';
    else if (legacyStatus === 'publishing') publication.status = 'verifying';
    else if (['embedding_pending', 'embedding'].includes(legacyStatus)) publication.status = 'pending';
    else if (legacyStatus === 'failed') publication.status = 'failed';
    else publication.status = 'private';
  }
  if (!publication.indexingStatus) {
    if (publication.indexed || legacyStatus === 'published') publication.indexingStatus = 'ready';
    else if (legacyStatus === 'embedding') publication.indexingStatus = 'indexing';
    else if (legacyStatus === 'embedding_pending') publication.indexingStatus = 'pending';
    else if (record.failureCode === 'embedding_failed') publication.indexingStatus = 'failed';
    else if (legacyStatus === 'publishing' && record.failureCode === 'cleanup_required') publication.indexingStatus = 'failed';
    else publication.indexingStatus = 'not_started';
  }
  if (publication.publicWritten === undefined) publication.publicWritten = legacyStatus === 'published';
  if (publication.indexed === undefined) publication.indexed = legacyStatus === 'published';
  return publication;
}

function migrateStore(value) {
  if (
    !value
    || ![LEGACY_STORE_VERSION, STORE_VERSION].includes(value.version)
    || !value.records
    || typeof value.records !== 'object'
    || !value.slugReservations
    || typeof value.slugReservations !== 'object'
  ) {
    throw new SubmissionRepositoryError('invalid_store', 'The submission store is invalid.', 500);
  }
  const migrated = value.version === STORE_VERSION ? value : clone(value);
  migrated.version = STORE_VERSION;
  for (const [id, record] of Object.entries(migrated.records)) {
    if (!ID_PATTERN.test(id) || !record || record.id !== id) {
      throw new SubmissionRepositoryError('invalid_store', 'The submission store is invalid.', 500);
    }
    assertSubmissionState(record.status);
    record.publication = migratePublication(record);
  }
  return migrated;
}

const assertStore = migrateStore;

function createRepositoryOperations(load, save, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const generateId = typeof options.generateId === 'function' ? options.generateId : generateOpaqueId;
  let operations = Promise.resolve();

  function exclusive(operation) {
    const result = operations.then(operation, operation);
    operations = result.catch(() => {});
    return result;
  }

  async function withStore(mutator) {
    return exclusive(async () => {
      const store = assertStore(await load());
      const result = await mutator(store);
      await save(store);
      return clone(result);
    });
  }

  async function readStore(reader) {
    return exclusive(async () => reader(assertStore(await load())));
  }

  return {
    async create({ ownerId, markdown, metadata = {}, status = 'pending' } = {}) {
      assertSubmissionState(status);
      if (status !== 'pending' && status !== 'ready_for_review') {
        throw new SubmissionRepositoryError('invalid_initial_state', 'A new submission must start as pending or ready for review.');
      }
      return withStore((store) => {
        let id;
        do {
          id = generateId();
          if (!ID_PATTERN.test(id)) {
            throw new SubmissionRepositoryError('invalid_generated_id', 'The generated submission identifier is invalid.', 500);
          }
        } while (store.records[id]);
        const timestamp = new Date(now()).toISOString();
        const record = {
          id,
          ownerId: cleanOwnerId(ownerId),
          status,
          markdown: cleanMarkdown(markdown),
          metadata: cleanMetadata(metadata),
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          publishedSlug: null,
          rejectionReason: null,
          failureCode: null,
          publication: {
            status: 'private',
            indexingStatus: 'not_started',
            publicWritten: false,
            indexed: false
          }
        };
        store.records[id] = record;
        return record;
      });
    },

    async get(id) {
      return readStore((store) => clone(store.records[id] || null));
    },

    async listByOwner(ownerId, { includeDeleted = false } = {}) {
      cleanOwnerId(ownerId);
      return readStore((store) => Object.values(store.records)
        .filter((record) => record.ownerId === ownerId && (includeDeleted || record.status !== 'deleted'))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(clone));
    },

    async listAll({ includeDeleted = false } = {}) {
      return readStore((store) => Object.values(store.records)
        .filter((record) => includeDeleted || record.status !== 'deleted')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(clone));
    },

    async transition(id, to, patch = {}) {
      return withStore((store) => {
        const current = store.records[id];
        if (!current) throw new SubmissionRepositoryError('not_found', 'Submission not found.', 404);
        assertTransition(current.status, to);
        const forbidden = ['id', 'ownerId', 'createdAt', 'markdown', 'metadata', 'revision', 'status'];
        if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
          throw new SubmissionRepositoryError('invalid_patch', 'Immutable submission fields cannot be changed.');
        }
        const updated = {
          ...current,
          ...clone(patch),
          status: to,
          updatedAt: new Date(now()).toISOString()
        };
        if (to === 'deleted') {
          updated.ownerId = null;
          updated.markdown = null;
          updated.metadata = {};
          updated.rejectionReason = null;
        }
        store.records[id] = updated;
        return updated;
      });
    },

    async patch(id, patch = {}, { requiredStatus } = {}) {
      return withStore((store) => {
        const current = store.records[id];
        if (!current) throw new SubmissionRepositoryError('not_found', 'Submission not found.', 404);
        if (requiredStatus && current.status !== requiredStatus) {
          throw new SubmissionRepositoryError('state_conflict', 'The submission changed state.', 409);
        }
        const forbidden = ['id', 'ownerId', 'createdAt', 'markdown', 'metadata', 'revision', 'status'];
        if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
          throw new SubmissionRepositoryError('invalid_patch', 'Immutable submission fields cannot be changed.');
        }
        const updated = { ...current, ...clone(patch), updatedAt: new Date(now()).toISOString() };
        store.records[id] = updated;
        return updated;
      });
    },

    async replace(id, ownerId, { markdown, metadata = {} } = {}) {
      return withStore((store) => {
        const current = store.records[id];
        if (!current || current.ownerId !== cleanOwnerId(ownerId)) {
          throw new SubmissionRepositoryError('not_found', 'Submission not found.', 404);
        }
        if (!['pending', 'ready_for_review', 'rejected', 'failed'].includes(current.status)) {
          throw new SubmissionRepositoryError(
            'state_conflict',
            'Only a private submission that is not being published can be revised.',
            409
          );
        }
        const timestamp = new Date(now()).toISOString();
        const updated = {
          ...current,
          status: 'pending',
          markdown: cleanMarkdown(markdown),
          metadata: cleanMetadata(metadata),
          revision: current.revision + 1,
          updatedAt: timestamp,
          rejectionReason: null,
          failureCode: null,
          publication: {
            status: 'private',
            indexingStatus: 'not_started',
            publicWritten: false,
            indexed: false
          }
        };
        store.records[id] = updated;
        return updated;
      });
    },

    async reserveSlug(id, title) {
      return withStore((store) => {
        const record = store.records[id];
        if (!record) throw new SubmissionRepositoryError('not_found', 'Submission not found.', 404);
        if (record.publishedSlug) return record.publishedSlug;
        const base = slugBase(title);
        let candidate = base;
        if (store.slugReservations[candidate] && store.slugReservations[candidate] !== id) {
          const suffix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 10);
          candidate = `${base.slice(0, 69).replace(/-+$/g, '')}-${suffix}`;
        }
        let counter = 2;
        while (store.slugReservations[candidate] && store.slugReservations[candidate] !== id) {
          candidate = `${base.slice(0, 74).replace(/-+$/g, '')}-${counter}`;
          counter += 1;
        }
        store.slugReservations[candidate] = id;
        record.publishedSlug = candidate;
        record.updatedAt = new Date(now()).toISOString();
        return candidate;
      });
    }
  };
}

function createInMemorySubmissionRepository(options = {}) {
  let store = newStore();
  return createRepositoryOperations(
    async () => clone(store),
    async (next) => { store = clone(next); },
    options
  );
}

function createFileSubmissionRepository({ filePath, ...options } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('An absolute submission store filePath is required.');
  }

  async function load() {
    try {
      return assertStore(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return newStore();
      if (error instanceof SubmissionRepositoryError) throw error;
      throw new SubmissionRepositoryError('store_read_failed', 'The submission store could not be read.', 500);
    }
  }

  async function save(store) {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(store), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw new SubmissionRepositoryError('store_write_failed', 'The submission store could not be written.', 500);
    }
  }

  return createRepositoryOperations(load, save, options);
}

module.exports = {
  SubmissionRepositoryError,
  createFileSubmissionRepository,
  createInMemorySubmissionRepository,
  generateOpaqueId,
  migrateStore,
  slugBase
};
