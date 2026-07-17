'use strict';

const DEFAULT_MAXIMUM = 5;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_BUCKETS = 10_000;
const DEFAULT_SWEEP_EVERY = 100;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createResearchRateLimiter(options = {}) {
  const maximum = positiveInteger(options.maximum, DEFAULT_MAXIMUM);
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const maxBuckets = positiveInteger(options.maxBuckets, DEFAULT_MAX_BUCKETS);
  const sweepEvery = positiveInteger(options.sweepEvery, DEFAULT_SWEEP_EVERY);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const buckets = new Map();
  let checks = 0;

  function sweepExpired(currentTime) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(key);
    }
  }

  function makeRoom(currentTime) {
    sweepExpired(currentTime);
    while (buckets.size >= maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      buckets.delete(oldestKey);
    }
  }

  function check(key) {
    const currentTime = now();
    const bucketKey = typeof key === 'string' && key ? key : 'unknown';
    checks += 1;

    if (checks % sweepEvery === 0 || buckets.size >= maxBuckets) {
      sweepExpired(currentTime);
    }

    const current = buckets.get(bucketKey);
    if (current && current.resetAt > currentTime) {
      if (current.count >= maximum) {
        return Math.max(1, Math.ceil((current.resetAt - currentTime) / 1000));
      }
      current.count += 1;
      return 0;
    }

    if (current) buckets.delete(bucketKey);
    if (buckets.size >= maxBuckets) makeRoom(currentTime);
    buckets.set(bucketKey, { count: 1, resetAt: currentTime + windowMs });
    return 0;
  }

  check.size = () => buckets.size;
  return check;
}

module.exports = {
  createResearchRateLimiter
};
