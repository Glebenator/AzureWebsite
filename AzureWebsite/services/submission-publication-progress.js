'use strict';

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
    publication.indexingStartedAt || publication.queuedAt || publication.publicWriteStartedAt || record?.updatedAt
  );
  const lastProgressAt = safeTimestamp(publication.lastProgressAt || record?.updatedAt);
  const elapsed = elapsedLabel(startedAt, now);
  const publicationState = publication.status || (record?.status === 'published' ? 'published' : 'private');
  const aiState = publication.indexingStatus || (publication.indexed ? 'ready' : 'not_started');
  const publicAvailable = record?.status === 'published'
    && publicationState === 'published'
    && Boolean(publication.publicWritten);
  const aiReady = publicAvailable && aiState === 'ready' && Boolean(publication.indexed);
  const requiresAction = publicationState === 'failed' || aiState === 'failed';
  const active = !requiresAction
    && (record?.status === 'publishing' || (publicAvailable && ['pending', 'indexing'].includes(aiState)));

  let publicationLabel = 'Private';
  if (publicationState === 'failed') publicationLabel = 'Publication failed';
  else if (record?.status === 'publishing') publicationLabel = 'Publishing public Markdown';
  else if (publicAvailable) publicationLabel = 'Published';

  let aiLabel = 'AI indexing not started';
  if (aiState === 'pending') aiLabel = 'Embeddings pending';
  else if (aiState === 'indexing' && publication.substage === 'search_commit') aiLabel = 'Search indexing';
  else if (aiState === 'indexing') aiLabel = total !== null && completed !== null
    ? `Embedding ${completed} of ${total} sections`
    : 'Embeddings indexing';
  else if (aiReady) aiLabel = 'AI ready';
  else if (aiState === 'failed') aiLabel = 'AI indexing failed';

  const summary = publicAvailable ? `${publicationLabel} · ${aiLabel}` : publicationLabel;
  const detail = `Attempt ${attempt}${elapsed ? ` · ${elapsed}` : ''}`;
  const embeddingComplete = aiReady || Boolean(publication.embeddingsReadyAt);

  return {
    active,
    aiReady,
    aiState,
    aiLabel,
    attempt,
    completed,
    detail,
    lastProgressAt,
    publicationLabel,
    publicationState,
    publicAvailable,
    requiresAction,
    startedAt,
    summary,
    total,
    checkpoints: [
      checkpoint(
        'Public Markdown',
        publicAvailable ? 'complete' : publicationState === 'failed' ? 'failed' : record?.status === 'publishing' ? 'active' : 'pending',
        publicAvailable ? 'Verified Blob is readable' : 'Not publicly active'
      ),
      checkpoint('Public visibility', publicAvailable ? 'complete' : 'pending', publicAvailable ? 'Active' : 'Private'),
      checkpoint(
        'Embeddings',
        embeddingComplete ? 'complete' : aiState === 'indexing' ? 'active' : aiState === 'failed' ? 'failed' : 'pending',
        total !== null && completed !== null ? `${completed} of ${total} sections` : aiState === 'failed' ? 'Retry available' : 'Section count pending'
      ),
      checkpoint(
        'Search index',
        aiReady ? 'complete' : aiState === 'indexing' && publication.substage === 'search_commit' ? 'active' : aiState === 'failed' ? 'failed' : 'pending',
        aiReady ? 'Documents completely verified' : aiState === 'failed' ? 'Not AI-visible; retry available' : 'Not AI-visible'
      )
    ]
  };
}

module.exports = { createPublicationProgress, elapsedLabel };
