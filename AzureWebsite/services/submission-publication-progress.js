'use strict';

const ACTIVE_STATES = new Set(['embedding_pending', 'embedding', 'publishing']);

function boundedCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 10000 ? count : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function elapsedLabel(startedAt, now = Date.now()) {
  const timestamp = Date.parse(startedAt || '');
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m elapsed`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m elapsed`;
}

function checkpoint(label, status, detail) {
  return { label, status, detail };
}

function createPublicationProgress(record, now = Date.now()) {
  const publication = record?.publication && typeof record.publication === 'object'
    ? record.publication
    : {};
  const completed = boundedCount(publication.embeddingCompleted);
  const total = boundedCount(publication.embeddingTotal);
  const attempt = Math.max(1, boundedCount(publication.attempt) || 1);
  const startedAt = safeTimestamp(
    publication.embeddingStartedAt || publication.queuedAt || record?.updatedAt
  );
  const lastProgressAt = safeTimestamp(publication.lastProgressAt || record?.updatedAt);
  const elapsed = elapsedLabel(startedAt, now);
  const substage = typeof publication.substage === 'string' ? publication.substage : '';
  const publicWritten = Boolean(publication.publicWritten);
  const indexed = Boolean(publication.indexed);
  const embeddingDone = Boolean(publication.embeddingsReadyAt)
    || (total !== null && total > 0 && completed === total)
    || (['publishing', 'published'].includes(record?.status) && substage !== 'embedding_recovery');

  let summary = 'Publication status unavailable';
  let detail = `Attempt ${attempt}${elapsed ? ` · ${elapsed}` : ''}`;
  if (record?.status === 'embedding_pending') {
    summary = 'Waiting for the embedding worker';
  } else if (record?.status === 'embedding' || substage === 'embedding_recovery') {
    summary = total !== null && completed !== null
      ? `Embedding ${completed} of ${total} sections`
      : substage === 'embedding_recovery'
        ? 'Restoring embeddings after restart'
        : 'Preparing sections for embedding';
  } else if (record?.status === 'publishing') {
    if (record.failureCode === 'cleanup_required') summary = 'Cleanup requires a retry';
    else if (substage === 'cleanup') summary = 'Cleaning up a partial publication';
    else if (!publicWritten) summary = 'Writing the public Markdown note';
    else if (!indexed) summary = 'Updating and verifying Search';
    else summary = 'Activating the published note';
  } else if (record?.status === 'published') {
    summary = 'Published and available to readers';
  } else if (record?.status === 'failed') {
    summary = record.failureCode === 'embedding_failed'
      ? 'Embedding stopped safely'
      : 'Publication stopped safely';
  }

  const embeddingStatus = embeddingDone
    ? 'complete'
    : record?.status === 'embedding' || substage === 'embedding_recovery'
      ? 'active'
      : record?.failureCode === 'embedding_failed'
        ? 'failed'
        : 'pending';
  const archiveStatus = publicWritten
    ? 'complete'
    : record?.status === 'publishing' && !['cleanup', 'embedding_recovery'].includes(substage)
      ? 'active'
      : 'pending';
  const searchStatus = indexed
    ? 'complete'
    : publicWritten && record?.status === 'publishing'
      ? 'active'
      : 'pending';
  const visibilityStatus = record?.status === 'published'
    ? 'complete'
    : indexed && record?.status === 'publishing'
      ? 'active'
      : 'pending';

  return {
    active: ACTIVE_STATES.has(record?.status),
    attempt,
    completed,
    detail,
    lastProgressAt,
    startedAt,
    summary,
    total,
    checkpoints: [
      checkpoint(
        'Embeddings',
        embeddingStatus,
        total !== null && completed !== null ? `${completed} of ${total} sections` : 'Section count pending'
      ),
      checkpoint('Public Markdown', archiveStatus, publicWritten ? 'Blob write confirmed' : 'Not written'),
      checkpoint('Search index', searchStatus, indexed ? 'Documents verified' : 'Not verified'),
      checkpoint('Visibility', visibilityStatus, record?.status === 'published' ? 'Active' : 'Private')
    ]
  };
}

module.exports = { createPublicationProgress, elapsedLabel };
