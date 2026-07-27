'use strict';

const { normalizeSubmissionForPublication } = require('./submission-validation');

class SubmissionPublicationError extends Error {
  constructor(code, message, status = 500, options) {
    super(message, options);
    this.name = 'SubmissionPublicationError';
    this.code = code;
    this.status = status;
  }
}

function requireAdapter(adapter, methods, label) {
  if (!adapter || methods.some((method) => typeof adapter[method] !== 'function')) {
    throw new TypeError(`${label} must implement ${methods.join(' and ')}.`);
  }
  return adapter;
}

function publicPayload(record, slug, normalize) {
  const normalized = normalize(record);
  if (!normalized || typeof normalized.markdown !== 'string' || typeof normalized.title !== 'string') {
    throw new SubmissionPublicationError('normalization_failed', 'The reviewed Markdown could not be normalized.', 500);
  }
  return Object.freeze({
    submissionId: record.id,
    slug,
    markdown: normalized.markdown,
    metadata: { ...(normalized.metadata || {}), title: normalized.title }
  });
}

function createPublicationCoordinator({
  repository,
  publicStore,
  searchIndex,
  normalize = normalizeSubmissionForPublication
} = {}) {
  if (!repository || ['get', 'transition', 'patch', 'reserveSlug'].some((method) => typeof repository[method] !== 'function')) {
    throw new TypeError('A submission repository is required.');
  }
  requireAdapter(publicStore, ['write', 'remove'], 'publicStore');
  requireAdapter(searchIndex, ['index', 'remove'], 'searchIndex');
  if (typeof normalize !== 'function') throw new TypeError('A publication normalizer is required.');
  const locks = new Map();

  function exclusive(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(id, current);
    return current.finally(() => {
      if (locks.get(id) === current) locks.delete(id);
    });
  }

  async function compensate(payload, { indexMayExist, publicMayExist }) {
    const indexResult = !indexMayExist || await Promise.resolve()
      .then(() => searchIndex.remove(payload))
      .then(() => true, () => false);
    const publicResult = !publicMayExist || await Promise.resolve()
      .then(() => publicStore.remove(payload))
      .then(() => true, () => false);
    return indexResult && publicResult;
  }

  async function publishUnlocked(id) {
    let record = await repository.get(id);
    if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
    if (record.status === 'published') {
      return { id: record.id, slug: record.publishedSlug, status: record.status, idempotent: true };
    }
    if (!['ready_for_review', 'failed', 'publishing'].includes(record.status)) {
      throw new SubmissionPublicationError('not_publishable', 'This submission is not ready to publish.', 409);
    }

    const normalized = normalize(record);
    const slug = await repository.reserveSlug(record.id, normalized.title);
    if (record.status !== 'publishing') {
      record = await repository.transition(record.id, 'publishing', {
        failureCode: null,
        publication: { publicWritten: false, indexed: false }
      });
    }
    const payload = publicPayload(record, slug, () => normalized);
    let publicMayExist = false;
    let indexMayExist = false;

    try {
      // Always upsert both deterministic identities on a publishing retry. A
      // crash or ambiguous cleanup error can make persisted checkpoints lag
      // reality; adapter upserts keyed by slug/submissionId are required to be
      // idempotent and restore either missing side without creating duplicates.
      // A transport failure may occur after Blob accepted the write, so cleanup
      // must assume the deterministic public identity can exist once attempted.
      publicMayExist = true;
      const publicResult = await publicStore.write(payload);
      const publicVersion = publicResult && (publicResult.etag || publicResult.version) || null;
      record = await repository.patch(record.id, {
        publication: { publicWritten: true, indexed: false, publicVersion }
      }, { requiredStatus: 'publishing' });

      indexMayExist = true;
      const indexResult = await searchIndex.index({ ...payload, publicVersion });
      record = await repository.patch(record.id, {
        publication: {
          publicWritten: true,
          indexed: true,
          publicVersion,
          indexVersion: indexResult && (indexResult.etag || indexResult.version) || null
        }
      }, { requiredStatus: 'publishing' });

      const published = await repository.transition(record.id, 'published', { failureCode: null });
      return { id: published.id, slug, status: published.status, idempotent: false };
    } catch (cause) {
      // A conditional conflict explicitly proves this operation did not create
      // or own the existing public document. Never compensate another article.
      if (cause?.name === 'PublicationConflictError') publicMayExist = false;
      const cleaned = await compensate(payload, { indexMayExist, publicMayExist });
      if (cleaned) {
        const latest = await repository.get(record.id);
        if (latest?.status === 'publishing') {
          await repository.transition(record.id, 'failed', {
            failureCode: 'publication_failed',
            publication: { publicWritten: false, indexed: false }
          });
        }
        throw new SubmissionPublicationError(
          'publication_failed',
          'Publication failed safely and can be retried.',
          502,
          { cause }
        );
      }

      // A partial public/index write may still exist. Keep the state non-deletable
      // and retryable until an idempotent retry or operator cleanup resolves it.
      await repository.patch(record.id, {
        failureCode: 'cleanup_required'
      }, { requiredStatus: 'publishing' }).catch(() => {});
      throw new SubmissionPublicationError(
        'cleanup_required',
        'Publication cleanup is incomplete; retry before taking another action.',
        503,
        { cause }
      );
    }
  }

  async function reject(id, reason) {
    const normalizedReason = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
    if (!normalizedReason || normalizedReason.length > 500) {
      throw new SubmissionPublicationError('invalid_rejection_reason', 'A rejection reason of 1 to 500 characters is required.', 400);
    }
    return exclusive(id, async () => {
      const record = await repository.get(id);
      if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
      if (record.status !== 'ready_for_review') {
        throw new SubmissionPublicationError('not_rejectable', 'Only a ready submission can be rejected.', 409);
      }
      return repository.transition(id, 'rejected', { rejectionReason: normalizedReason });
    });
  }

  async function remove(id) {
    return exclusive(id, async () => {
      const record = await repository.get(id);
      if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
      if (record.status === 'deleted') return { id, status: 'deleted', idempotent: true };
      if (record.status === 'publishing') {
        throw new SubmissionPublicationError('cleanup_required', 'A publishing submission cannot be deleted.', 409);
      }
      if (record.status === 'published') {
        // Deletion must remain possible even if an older record no longer
        // passes the current normalization policy.
        const payload = Object.freeze({ submissionId: record.id, slug: record.publishedSlug });
        try {
          await searchIndex.remove(payload);
          await publicStore.remove(payload);
        } catch (cause) {
          throw new SubmissionPublicationError(
            'unpublish_failed',
            'The published submission could not be removed safely; retry the operation.',
            502,
            { cause }
          );
        }
      } else if (record.publication?.publicWritten || record.publication?.indexed) {
        throw new SubmissionPublicationError('cleanup_required', 'Publication cleanup is required before deletion.', 409);
      }
      const deleted = await repository.transition(id, 'deleted', {
        rejectionReason: null,
        failureCode: null,
        publication: { publicWritten: false, indexed: false }
      });
      return { id, status: deleted.status, idempotent: false };
    });
  }

  return {
    publish(id) {
      return exclusive(id, () => publishUnlocked(id));
    },
    reject,
    remove
  };
}

module.exports = {
  SubmissionPublicationError,
  createPublicationCoordinator
};
