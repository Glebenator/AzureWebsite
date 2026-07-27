'use strict';

const crypto = require('node:crypto');

const DEFAULT_ACCOUNT_LIMIT = 5;
const DEFAULT_IP_LIMIT = 20;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BUCKETS = 20_000;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createSubmissionQuota(options = {}) {
  const accountLimit = positiveInteger(options.accountLimit, DEFAULT_ACCOUNT_LIMIT);
  const ipLimit = positiveInteger(options.ipLimit, DEFAULT_IP_LIMIT);
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const maxBuckets = Math.max(2, positiveInteger(options.maxBuckets, DEFAULT_MAX_BUCKETS));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const keySecret = Buffer.isBuffer(options.keySecret) && options.keySecret.length >= 32
    ? options.keySecret
    : crypto.randomBytes(32);
  const buckets = new Map();

  function key(scope, identifier) {
    if (typeof identifier !== 'string' || !identifier || identifier.length > 512) {
      throw new TypeError(`A valid ${scope} quota identifier is required.`);
    }
    return `${scope}:${crypto.createHmac('sha256', keySecret).update(identifier).digest('base64url')}`;
  }

  function sweep(currentTime) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(bucketKey);
    }
  }

  function current(bucketKey, currentTime) {
    const bucket = buckets.get(bucketKey);
    return bucket && bucket.resetAt > currentTime ? bucket : null;
  }

  function denial(scope, bucket, currentTime) {
    return {
      allowed: false,
      scope,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000)),
      resetAt: new Date(bucket.resetAt).toISOString()
    };
  }

  function consume({ accountId, ip } = {}) {
    const currentTime = now();
    sweep(currentTime);
    const accountKey = key('account', accountId);
    const ipKey = key('ip', ip);
    const account = current(accountKey, currentTime);
    const network = current(ipKey, currentTime);

    if (account && account.count >= accountLimit) return denial('account', account, currentTime);
    if (network && network.count >= ipLimit) return denial('ip', network, currentTime);

    const needed = Number(!account) + Number(!network);
    if (buckets.size + needed > maxBuckets) {
      // Fail closed instead of evicting active quotas and enabling limit bypass.
      return {
        allowed: false,
        scope: 'capacity',
        retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
        resetAt: new Date(currentTime + windowMs).toISOString()
      };
    }

    const resetAt = currentTime + windowMs;
    buckets.set(accountKey, account ? { ...account, count: account.count + 1 } : { count: 1, resetAt });
    buckets.set(ipKey, network ? { ...network, count: network.count + 1 } : { count: 1, resetAt });
    return {
      allowed: true,
      accountRemaining: accountLimit - (account ? account.count + 1 : 1),
      ipRemaining: ipLimit - (network ? network.count + 1 : 1),
      resetAt: new Date(Math.min(account?.resetAt || resetAt, network?.resetAt || resetAt)).toISOString()
    };
  }

  consume.size = () => buckets.size;
  return consume;
}

module.exports = { createSubmissionQuota };
