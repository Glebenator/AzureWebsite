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
  normalize = normalizeSubmissionForPublication,
  observe = () => {}
} = {}) {
  if (!repository || ['get', 'transition', 'patch', 'reserveSlug'].some((method) => typeof repository[method] !== 'function')) {
    throw new TypeError('A submission repository is required.');
  }
  requireAdapter(publicStore, ['write', 'remove'], 'publicStore');
  if (
    !searchIndex
    || typeof searchIndex.remove !== 'function'
    || (typeof searchIndex.index !== 'function'
      && (typeof searchIndex.prepare !== 'function' || typeof searchIndex.commit !== 'function'))
  ) {
    throw new TypeError('searchIndex must implement remove and either index or prepare and commit.');
  }
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

  async function stage(name, operation) {
    const startedAt = Date.now();
    try {
      const result = await operation();
      try { observe({ durationMs: Date.now() - startedAt, stage: name, status: 'completed' }); } catch {}
      return result;
    } catch (error) {
      try { observe({ category: error?.code || error?.name || 'error', durationMs: Date.now() - startedAt, stage: name, status: 'failed' }); } catch {}
      throw error;
    }
  }

  async function enqueueUnlocked(id) {
    const record = await repository.get(id);
    if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
    if (record.status === 'published') {
      return { id: record.id, slug: record.publishedSlug, status: record.status, idempotent: true };
    }
    if (['embedding_pending', 'embedding', 'publishing'].includes(record.status)) {
      return { id: record.id, slug: record.publishedSlug, status: record.status, idempotent: true };
    }
    if (!['ready_for_review', 'failed'].includes(record.status)) {
      throw new SubmissionPublicationError('not_publishable', 'This submission is not ready to publish.', 409);
    }
    const queued = await repository.transition(record.id, 'embedding_pending', {
      failureCode: null,
      publication: { publicWritten: false, indexed: false }
    });
    return { id: queued.id, slug: queued.publishedSlug, status: queued.status, idempotent: false };
  }

  async function processUnlocked(id, options = {}) {
    let record = await repository.get(id);
    if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
    if (record.status === 'published') {
      return { id: record.id, slug: record.publishedSlug, status: record.status, idempotent: true };
    }
    if (!['embedding_pending', 'embedding', 'publishing'].includes(record.status)) {
      throw new SubmissionPublicationError('not_publishable', 'This submission is not ready to publish.', 409);
    }

    const normalized = normalize(record);
    const slug = await repository.reserveSlug(record.id, normalized.title);
    const payload = publicPayload(record, slug, () => normalized);
    let prepared = null;
    let publicMayExist = record.status === 'publishing';
    let indexMayExist = record.status === 'publishing';

    if (record.status === 'embedding_pending') {
      record = await repository.transition(record.id, 'embedding', {
        failureCode: null,
        publication: { publicWritten: false, indexed: false }
      });
    }

    try {
      if (typeof searchIndex.prepare === 'function') {
        prepared = await stage('embedding', () => searchIndex.prepare(payload, { signal: options.signal }));
      }
    } catch (cause) {
      if (record.status === 'publishing') {
        const cleaned = await compensate(payload, { indexMayExist, publicMayExist });
        if (!cleaned) {
          await repository.patch(record.id, { failureCode: 'cleanup_required' }, { requiredStatus: 'publishing' }).catch(() => {});
          throw new SubmissionPublicationError('cleanup_required', 'Publication cleanup is incomplete; retry before taking another action.', 503, { cause });
        }
      }
      const latest = await repository.get(record.id);
      if (latest?.status === 'embedding' || latest?.status === 'publishing') {
        await repository.transition(record.id, 'failed', {
          failureCode: 'embedding_failed',
          publication: { publicWritten: false, indexed: false }
        });
      }
      throw new SubmissionPublicationError(
        'embedding_failed',
        'Embedding failed before the submission was made public and can be retried.',
        502,
        { cause }
      );
    }

    if (record.status === 'embedding') {
      record = await repository.transition(record.id, 'publishing', {
        failureCode: null,
        publication: { publicWritten: false, indexed: false }
      });
    }

    try {
      // Always upsert both deterministic identities on a publishing retry. A
      // crash or ambiguous cleanup error can make persisted checkpoints lag
      // reality; adapter upserts keyed by slug/submissionId are required to be
      // idempotent and restore either missing side without creating duplicates.
      // A transport failure may occur after Blob accepted the write, so cleanup
      // must assume the deterministic public identity can exist once attempted.
      publicMayExist = true;
      const publicResult = await stage('public_write', () => publicStore.write(payload, { signal: options.signal }));
      const publicVersion = publicResult && (publicResult.etag || publicResult.version) || null;
      record = await repository.patch(record.id, {
        publication: { publicWritten: true, indexed: false, publicVersion }
      }, { requiredStatus: 'publishing' });

      indexMayExist = true;
      const indexInput = {
        ...payload,
        publicVersion,
        lastModified: publicResult?.lastModified
      };
      const indexResult = await stage('search_commit', () => (
        typeof searchIndex.commit === 'function'
          ? searchIndex.commit(indexInput, prepared, { signal: options.signal })
          : searchIndex.index(indexInput, { signal: options.signal })
      ));
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
      if (!['ready_for_review', 'failed'].includes(record.status)) {
        throw new SubmissionPublicationError('not_rejectable', 'Only a ready or failed submission can be rejected.', 409);
      }
      return repository.transition(id, 'rejected', { rejectionReason: normalizedReason });
    });
  }

  async function remove(id) {
    return exclusive(id, async () => {
      const record = await repository.get(id);
      if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
      if (record.status === 'deleted') return { id, status: 'deleted', idempotent: true };
      if (['embedding_pending', 'embedding', 'publishing'].includes(record.status)) {
        throw new SubmissionPublicationError('cleanup_required', 'A submission in the publication pipeline cannot be deleted.', 409);
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
    enqueue(id) {
      return exclusive(id, () => enqueueUnlocked(id));
    },
    process(id, options) {
      return exclusive(id, () => processUnlocked(id, options));
    },
    publish(id) {
      return exclusive(id, async () => {
        await enqueueUnlocked(id);
        return processUnlocked(id);
      });
    },
    reject,
    remove
  };
}

module.exports = {
  SubmissionPublicationError,
  createPublicationCoordinator
};
