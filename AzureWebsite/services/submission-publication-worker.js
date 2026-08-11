'use strict';

const LEGACY_ACTIVE_STATES = new Set(['embedding_pending', 'embedding', 'publishing']);

function needsIndexing(record) {
  return record?.status === 'published'
    && ['pending', 'indexing'].includes(record?.publication?.indexingStatus);
}

function safeCategory(error) {
  const category = String(error?.code || error?.name || 'error');
  return /^[A-Za-z0-9_]{1,64}$/.test(category) ? category : 'error';
}

function createPublicationWorker({
  publication,
  repository,
  onPublished = () => {},
  log = (event) => console.log(JSON.stringify(event)),
  timeoutMs = 30 * 60 * 1000,
  schedule = setImmediate
} = {}) {
  if (!publication || typeof publication.enqueue !== 'function' || typeof publication.process !== 'function') {
    throw new TypeError('A queued publication coordinator is required.');
  }
  if (!repository || typeof repository.listAll !== 'function') {
    throw new TypeError('A submission repository is required.');
  }

  const queue = new Set();
  let scheduled = false;
  let running = false;
  let idleWaiters = [];

  function safeLog(detail) {
    try { log({ event: 'submission_publication_worker', ...detail }); } catch {}
  }

  function resolveIdle() {
    if (running || scheduled || queue.size) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  async function processOne(id) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const result = await publication.process(id, { signal: controller.signal });
      safeLog({ status: result?.indexingStatus === 'ready' ? 'completed' : 'skipped' });
    } catch (error) {
      safeLog({ category: safeCategory(error), status: 'failed' });
    } finally {
      clearTimeout(timer);
    }
  }

  async function drain() {
    if (running) return;
    scheduled = false;
    running = true;
    try {
      while (queue.size) {
        const id = queue.values().next().value;
        queue.delete(id);
        await processOne(id);
      }
    } finally {
      running = false;
      if (queue.size) trigger();
      resolveIdle();
    }
  }

  function trigger() {
    if (scheduled || running) return;
    scheduled = true;
    schedule(() => { drain().catch(() => {}); });
  }

  return {
    async enqueue(id) {
      const result = await publication.enqueue(id);
      if (result?.activated) {
        try { await onPublished(); } catch {}
      }
      if (result?.status === 'published' && result?.indexingStatus !== 'ready') {
        queue.add(id);
        trigger();
      }
      return result;
    },

    async start() {
      const records = await repository.listAll();
      for (const record of records) {
        if (!LEGACY_ACTIVE_STATES.has(record.status) && !needsIndexing(record)) continue;
        try {
          const result = await publication.enqueue(record.id);
          if (result?.activated) {
            try { await onPublished(); } catch {}
          }
          if (result?.status === 'published' && result?.indexingStatus !== 'ready') queue.add(record.id);
        } catch (error) {
          safeLog({ category: safeCategory(error), status: 'recovery_failed' });
        }
      }
      if (queue.size) trigger();
    },

    waitForIdle() {
      if (!running && !scheduled && !queue.size) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    }
  };
}

module.exports = { LEGACY_ACTIVE_STATES, createPublicationWorker, needsIndexing };
