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

function publicationCheckpoint(record, patch = {}) {
  return { ...(record?.publication || {}), ...patch };
}

function timestamp() {
  return new Date().toISOString();
}

function indexingFailureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^embedding_[a-z0-9_]+$/.test(code) || /^search_(?:[a-z0-9_]+|http_[1-5][0-9]{2})$/.test(code)) {
    return code;
  }
  return 'indexing_failed';
}

function safeTelemetryCategory(error) {
  const category = String(error?.code || error?.name || 'error');
  return /^[A-Za-z0-9_]{1,64}$/.test(category) ? category : 'error';
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
  requireAdapter(publicStore, ['write', 'verify', 'verifyOwnership', 'remove'], 'publicStore');
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

  async function stage(name, operation) {
    const startedAt = Date.now();
    try {
      const result = await operation();
      try { observe({ durationMs: Date.now() - startedAt, stage: name, status: 'completed' }); } catch {}
      return result;
    } catch (error) {
      try { observe({ category: safeTelemetryCategory(error), durationMs: Date.now() - startedAt, stage: name, status: 'failed' }); } catch {}
      throw error;
    }
  }

  async function publishPublicUnlocked(id, options = {}) {
    let record = await repository.get(id);
    if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
    const alreadyPublic = record.status === 'published'
      && record.publication?.status === 'published'
      && record.publication?.publicWritten;
    if (alreadyPublic) {
      return { record, slug: record.publishedSlug, idempotent: true, activated: false };
    }
    if (!['ready_for_review', 'failed', 'publishing', 'embedding_pending', 'embedding'].includes(record.status)) {
      throw new SubmissionPublicationError('not_publishable', 'This submission is not ready to publish.', 409);
    }

    // Normalization and a deterministic collision-safe slug are completed
    // before any public mutation. Legacy embedding states are accepted here so
    // version-1 approvals resume under the new public-first ordering.
    const normalized = normalize(record);
    const slug = await repository.reserveSlug(record.id, normalized.title);
    const payload = publicPayload(record, slug, () => normalized);
    const writingAt = timestamp();
    const patch = {
      failureCode: null,
      publication: publicationCheckpoint(record, {
        status: 'writing',
        indexingStatus: record.publication?.indexingStatus === 'ready' ? 'ready' : 'pending',
        indexingFailureCode: null,
        lastProgressAt: writingAt,
        publicWriteStartedAt: writingAt,
        substage: 'public_write'
      })
    };
    if (record.status === 'publishing') {
      record = await repository.patch(record.id, patch, { requiredStatus: 'publishing' });
    } else {
      record = await repository.transition(record.id, 'publishing', patch);
    }

    try {
      // Read the deterministic identity first on every attempt. This covers a
      // crash after Azure accepted and verified the Blob but before the local
      // visibility transition became durable, without issuing another write.
      let publicResult = await stage('public_verify', () => publicStore.verify(payload, { signal: options.signal }));
      if (!publicResult) {
        publicResult = await stage('public_write', () => publicStore.write(payload, { signal: options.signal }));
      }
      if (!publicResult || !(publicResult.etag || publicResult.version)) {
        throw new Error('The public Markdown write could not be verified.');
      }
      const activatedAt = timestamp();
      const published = await repository.transition(record.id, 'published', {
        failureCode: null,
        publication: publicationCheckpoint(record, {
          activatedAt,
          indexingStatus: record.publication?.indexingStatus === 'ready' ? 'ready' : 'pending',
          lastProgressAt: activatedAt,
          publicVersion: publicResult.etag || publicResult.version,
          publicWritten: true,
          publicWrittenAt: record.publication?.publicWrittenAt || activatedAt,
          status: 'published',
          substage: record.publication?.indexingStatus === 'ready' ? 'ready' : 'indexing_pending'
        })
      });
      return { record: published, slug, idempotent: false, activated: true };
    } catch (cause) {
      const failedAt = timestamp();
      await repository.patch(record.id, {
        failureCode: cause?.name === 'PublicationConflictError' ? 'publication_conflict' : 'public_write_failed',
        publication: publicationCheckpoint(record, {
          failedAt,
          lastProgressAt: failedAt,
          status: 'failed',
          substage: 'public_write_failed'
        })
      }, { requiredStatus: 'publishing' }).catch(() => {});
      throw new SubmissionPublicationError(
        cause?.name === 'PublicationConflictError' ? 'publication_conflict' : 'public_write_failed',
        cause?.name === 'PublicationConflictError'
          ? 'The public research slug is already owned by another article.'
          : 'The public Markdown write could not be verified and can be retried.',
        cause?.name === 'PublicationConflictError' ? 409 : 502,
        { cause }
      );
    }
  }

  async function enqueueUnlocked(id, options = {}) {
    const published = await publishPublicUnlocked(id, options);
    let record = published.record;
    const indexingStatus = record.publication?.indexingStatus || 'pending';
    if (indexingStatus === 'ready') {
      return {
        id: record.id,
        slug: record.publishedSlug,
        status: record.status,
        indexingStatus,
        idempotent: true,
        activated: published.activated
      };
    }
    const queuedAt = timestamp();
    if (!['pending', 'indexing'].includes(indexingStatus)) {
      record = await repository.patch(record.id, {
        publication: publicationCheckpoint(record, {
          attempt: Math.max(0, Number(record.publication?.attempt) || 0) + 1,
          indexingFailureCode: null,
          indexingStatus: 'pending',
          lastProgressAt: queuedAt,
          queuedAt,
          substage: 'indexing_pending'
        })
      }, { requiredStatus: 'published' });
    } else if (!record.publication?.queuedAt) {
      record = await repository.patch(record.id, {
        publication: publicationCheckpoint(record, {
          attempt: Math.max(0, Number(record.publication?.attempt) || 0) + 1,
          lastProgressAt: queuedAt,
          queuedAt
        })
      }, { requiredStatus: 'published' });
    }
    return {
      id: record.id,
      slug: record.publishedSlug,
      status: record.status,
      indexingStatus: record.publication.indexingStatus,
      idempotent: !published.activated && (indexingStatus === 'pending' || indexingStatus === 'indexing'),
      activated: published.activated
    };
  }

  async function processUnlocked(id, options = {}) {
    let record = await repository.get(id);
    if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
    if (record.status !== 'published' || record.publication?.status !== 'published' || !record.publication?.publicWritten) {
      const published = await publishPublicUnlocked(id, options);
      record = published.record;
    }
    if (record.publication?.indexingStatus === 'ready' && record.publication?.indexed) {
      return { id: record.id, slug: record.publishedSlug, status: record.status, indexingStatus: 'ready', idempotent: true };
    }

    const normalized = normalize(record);
    const slug = record.publishedSlug || await repository.reserveSlug(record.id, normalized.title);
    const payload = publicPayload(record, slug, () => normalized);
    const indexingStartedAt = timestamp();
    record = await repository.patch(record.id, {
      publication: publicationCheckpoint(record, {
        embeddingStartedAt: record.publication?.embeddingStartedAt || indexingStartedAt,
        indexed: false,
        indexingFailureCode: null,
        indexingStartedAt,
        indexingStatus: 'indexing',
        lastProgressAt: indexingStartedAt,
        substage: 'embedding'
      })
    }, { requiredStatus: 'published' });

    try {
      let prepared;
      if (typeof searchIndex.prepare === 'function') {
        prepared = await stage('embedding', () => searchIndex.prepare(payload, {
          checkpoint: record.publication?.embeddingCheckpoint,
          async onCheckpoint(checkpoint) {
            const checkpointAt = timestamp();
            record = await repository.patch(record.id, {
              publication: publicationCheckpoint(record, {
                embeddingCheckpoint: checkpoint,
                embeddingCompleted: Array.isArray(checkpoint?.vectors) ? checkpoint.vectors.length : 0,
                embeddingTotal: Number.isInteger(checkpoint?.total) ? checkpoint.total : record.publication?.embeddingTotal,
                lastProgressAt: checkpointAt
              })
            }, { requiredStatus: 'published' });
          },
          async onProgress(completed, total) {
            const progressAt = timestamp();
            record = await repository.patch(record.id, {
              publication: publicationCheckpoint(record, {
                embeddingCompleted: completed,
                embeddingTotal: total,
                lastProgressAt: progressAt
              })
            }, { requiredStatus: 'published' });
          },
          signal: options.signal
        }));
      }
      const preparedCount = Array.isArray(prepared?.vectors) ? prepared.vectors.length : null;
      const embeddingsReadyAt = timestamp();
      record = await repository.patch(record.id, {
        publication: publicationCheckpoint(record, {
          ...(preparedCount !== null ? { embeddingCompleted: preparedCount, embeddingTotal: preparedCount } : {}),
          embeddingsReadyAt,
          lastProgressAt: embeddingsReadyAt,
          substage: 'search_commit'
        })
      }, { requiredStatus: 'published' });

      const indexInput = {
        ...payload,
        publicVersion: record.publication.publicVersion,
        lastModified: record.publication.publicWrittenAt ? new Date(record.publication.publicWrittenAt) : undefined
      };
      const indexResult = await stage('search_commit', () => (
        typeof searchIndex.commit === 'function'
          ? searchIndex.commit(indexInput, prepared, { signal: options.signal })
          : searchIndex.index(indexInput, { signal: options.signal })
      ));
      const indexedAt = timestamp();
      record = await repository.patch(record.id, {
        failureCode: null,
        publication: publicationCheckpoint(record, {
          embeddingCheckpoint: null,
          indexed: true,
          indexedAt,
          indexingFailureCode: null,
          indexingStatus: 'ready',
          indexVersion: indexResult && (indexResult.etag || indexResult.version) || null,
          lastProgressAt: indexedAt,
          substage: 'ready'
        })
      }, { requiredStatus: 'published' });
      return { id: record.id, slug, status: record.status, indexingStatus: 'ready', idempotent: false };
    } catch (cause) {
      const failedAt = timestamp();
      const category = indexingFailureCode(cause);
      await repository.patch(record.id, {
        failureCode: null,
        publication: publicationCheckpoint(record, {
          failedAt,
          indexed: false,
          indexingFailureCode: category,
          indexingStatus: 'failed',
          lastProgressAt: failedAt,
          substage: 'indexing_failed'
        })
      }, { requiredStatus: 'published' }).catch(() => {});
      throw new SubmissionPublicationError(
        category,
        'The note is public, but AI indexing did not complete and can be retried.',
        502,
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
        throw new SubmissionPublicationError('not_rejectable', 'Only a ready or private failed submission can be rejected.', 409);
      }
      return repository.transition(id, 'rejected', { rejectionReason: normalizedReason });
    });
  }

  async function remove(id) {
    return exclusive(id, async () => {
      const record = await repository.get(id);
      if (!record) throw new SubmissionPublicationError('not_found', 'Submission not found.', 404);
      if (record.status === 'deleted') return { id, status: 'deleted', idempotent: true };
      if (record.publishedSlug) {
        const payload = Object.freeze({
          submissionId: record.id,
          slug: record.publishedSlug,
          publicVersion: record.publication?.publicVersion || null
        });
        try {
          // Prove immutable Blob ownership before deleting Search documents by
          // slug. If the Blob is already absent, Search removal is limited to
          // the durable source ETag so a collision can never erase another
          // article's evidence.
          const ownedBlob = await publicStore.verifyOwnership(payload);
          const externalStateMayExist = Boolean(
            ownedBlob
            || record.publication?.publicWritten
            || record.publication?.indexed
            || record.publication?.publicVersion
          );
          if (externalStateMayExist) {
            await searchIndex.remove(payload, { ownershipVerified: Boolean(ownedBlob) });
          }
          if (ownedBlob) await publicStore.remove(payload);
        } catch (cause) {
          throw new SubmissionPublicationError(
            'unpublish_failed',
            'The submission could not be removed safely; retry the deletion.',
            502,
            { cause }
          );
        }
      }
      const deleted = await repository.transition(id, 'deleted', {
        rejectionReason: null,
        failureCode: null,
        publication: {
          status: 'deleted',
          indexingStatus: 'not_started',
          publicWritten: false,
          indexed: false,
          embeddingCheckpoint: null
        }
      });
      return { id, status: deleted.status, idempotent: false };
    });
  }

  return {
    enqueue(id, options) {
      return exclusive(id, () => enqueueUnlocked(id, options));
    },
    process(id, options) {
      return exclusive(id, () => processUnlocked(id, options));
    },
    publish(id, options) {
      return exclusive(id, async () => {
        const queued = await enqueueUnlocked(id, options);
        if (queued.indexingStatus === 'ready') return queued;
        const processed = await processUnlocked(id, options);
        return { ...processed, activated: queued.activated };
      });
    },
    publishPublic(id, options) {
      return exclusive(id, () => publishPublicUnlocked(id, options));
    },
    reject,
    remove
  };
}

module.exports = {
  SubmissionPublicationError,
  createPublicationCoordinator,
  indexingFailureCode
};
