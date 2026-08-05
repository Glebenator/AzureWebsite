'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createGoogleOidc } = require('./google-oidc');
const { createAzurePublicPublisher, createAzureSubmissionIndexer } = require('./azure-submission-publication');
const { createCsrfProtection } = require('./submission-csrf');
const { createPublicationCoordinator } = require('./submission-publication');
const { createPublicationWorker } = require('./submission-publication-worker');
const { createSubmissionQuota } = require('./submission-quota');
const { createFileSubmissionRepository } = require('./submission-repository');
const { createOpaqueSessionStore, sessionCookieOptions } = require('./submission-session');

const GOOGLE_SUB_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

function pathIsWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function validatePrivateDataFile(filePath) {
  const resolvedFilePath = path.resolve(filePath);
  const parentPath = path.dirname(resolvedFilePath);
  fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });

  const publicRoot = fs.realpathSync.native(path.resolve(__dirname, '..', 'public'));
  const realParent = fs.realpathSync.native(parentPath);
  if (pathIsWithin(realParent, publicRoot)) {
    throw new Error('SUBMISSION_DATA_FILE must remain outside the publicly served directory.');
  }

  if (fs.existsSync(resolvedFilePath)) {
    const fileStat = fs.lstatSync(resolvedFilePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error('SUBMISSION_DATA_FILE must not be a symbolic link.');
    }
    const realFilePath = fs.realpathSync.native(resolvedFilePath);
    if (pathIsWithin(realFilePath, publicRoot)) {
      throw new Error('SUBMISSION_DATA_FILE must remain outside the publicly served directory.');
    }
  }
  return resolvedFilePath;
}

function positiveEnvironmentInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Research submission limit configuration is invalid.');
  }
  return parsed;
}

function createUnavailablePublishingError() {
  const error = new Error('Publishing is disabled until the managed-identity public and Search adapters are configured.');
  error.status = 503;
  error.code = 'publishing_disabled';
  return error;
}

function createSubmissionSystem(options = {}) {
  const env = options.env || process.env;
  if (options.enabled === false || (options.enabled === undefined && env.RESEARCH_SUBMISSIONS_ENABLED !== 'true')) {
    return { enabled: false };
  }

  const adminGoogleSub = options.adminGoogleSub || env.ADMIN_GOOGLE_SUB;
  if (!GOOGLE_SUB_PATTERN.test(adminGoogleSub || '')) {
    throw new Error('ADMIN_GOOGLE_SUB must be the sole administrator immutable Google subject.');
  }

  let repository = options.repository;
  if (!repository) {
    const filePath = env.SUBMISSION_DATA_FILE;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('SUBMISSION_DATA_FILE must be an absolute path on durable private storage.');
    }
    repository = createFileSubmissionRepository({ filePath: validatePrivateDataFile(filePath) });
  }

  const sessionStore = options.sessionStore || createOpaqueSessionStore({
    ttlMs: positiveEnvironmentInteger(env.SUBMISSION_SESSION_TTL_MS, 8 * 60 * 60 * 1000, 15 * 60 * 1000, 24 * 60 * 60 * 1000),
    maxSessions: positiveEnvironmentInteger(env.SUBMISSION_MAX_SESSIONS, 10_000, 10, 100_000)
  });
  const csrf = options.csrf || createCsrfProtection();
  const quota = options.quota || createSubmissionQuota({
    accountLimit: positiveEnvironmentInteger(env.SUBMISSION_ACCOUNT_DAILY_LIMIT, 5, 1, 50),
    ipLimit: positiveEnvironmentInteger(env.SUBMISSION_IP_DAILY_LIMIT, 20, 1, 200),
    windowMs: 24 * 60 * 60 * 1000
  });
  const oidc = options.oidc || createGoogleOidc({ env });
  const publishingEnabled = options.publishingEnabled === true
    || (options.publishingEnabled === undefined && env.SUBMISSION_PUBLISHING_ENABLED === 'true');
  const publicStore = options.publicStore || (publishingEnabled ? createAzurePublicPublisher({ env }) : {
    async write() { throw createUnavailablePublishingError(); },
    async remove() { return true; }
  });
  const searchIndex = options.searchIndex || (publishingEnabled ? createAzureSubmissionIndexer({ env }) : {
    async index() { throw createUnavailablePublishingError(); },
    async remove() { return true; }
  });
  const publicationLog = options.publicationLog || ((detail) => console.log(JSON.stringify({
    event: 'submission_publication_stage',
    ...detail
  })));
  const coordinator = options.publication || createPublicationCoordinator({
    repository,
    publicStore,
    searchIndex,
    observe: publicationLog
  });
  const publication = publishingEnabled || options.publication
    ? coordinator
    : {
        enqueue() { throw createUnavailablePublishingError(); },
        publish() { throw createUnavailablePublishingError(); },
        reject: coordinator.reject,
        remove: coordinator.remove
      };

  const system = {
    enabled: true,
    production: env.NODE_ENV === 'production',
    adminGoogleSub,
    csrf,
    oidc,
    publication,
    quota,
    repository,
    sessionCookieOptions: sessionCookieOptions({ production: env.NODE_ENV === 'production' }),
    sessionStore
  };
  system.publicationVisibility = async ({ slug, metadata } = {}) => {
    if (typeof slug !== 'string' || metadata?.source !== 'reviewed-submission') return false;
    const records = await repository.listAll({ includeDeleted: true });
    const record = records.find((candidate) => candidate.publishedSlug === slug);
    if (!record || record.status !== 'published') return false;
    const operationHash = crypto.createHash('sha256').update(record.id).digest('hex');
    return metadata.operationhash === operationHash;
  };
  if (
    (publishingEnabled || options.publication)
    && typeof coordinator.enqueue === 'function'
    && typeof coordinator.process === 'function'
  ) {
    system.publicationWorker = options.publicationWorker || createPublicationWorker({
      publication: coordinator,
      repository,
      timeoutMs: positiveEnvironmentInteger(
        env.SUBMISSION_PUBLICATION_TIMEOUT_MS,
        30 * 60 * 1000,
        60 * 1000,
        60 * 60 * 1000
      ),
      log: publicationLog,
      onPublished() {
        return system.onCorpusChanged?.();
      }
    });
  }
  return system;
}

module.exports = { createSubmissionSystem, positiveEnvironmentInteger, validatePrivateDataFile };
