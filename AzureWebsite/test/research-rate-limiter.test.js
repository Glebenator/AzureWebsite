'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResearchRateLimiter } = require('../services/research-rate-limiter');

test('rate limiter keeps independent request buckets for each client', () => {
  const check = createResearchRateLimiter({ maximum: 2, now: () => 0 });

  assert.equal(check('client-a'), 0);
  assert.equal(check('client-a'), 0);
  assert.equal(check('client-a'), 60);
  assert.equal(check('client-b'), 0);
  assert.equal(check.size(), 2);
});

test('rate limiter resets expired buckets and rounds Retry-After up', () => {
  let currentTime = 0;
  const check = createResearchRateLimiter({
    maximum: 1,
    windowMs: 60_000,
    now: () => currentTime
  });

  assert.equal(check('client'), 0);
  currentTime = 1;
  assert.equal(check('client'), 60);
  currentTime = 59_001;
  assert.equal(check('client'), 1);
  currentTime = 60_000;
  assert.equal(check('client'), 0);
});

test('rate limiter periodically sweeps expired buckets', () => {
  let currentTime = 0;
  const check = createResearchRateLimiter({
    windowMs: 10,
    sweepEvery: 3,
    now: () => currentTime
  });

  check('expired-a');
  check('expired-b');
  assert.equal(check.size(), 2);

  currentTime = 10;
  check('current');
  assert.equal(check.size(), 1);
});

test('rate limiter stays bounded and evicts the oldest active bucket', () => {
  let currentTime = 0;
  const check = createResearchRateLimiter({
    maximum: 1,
    maxBuckets: 3,
    now: () => currentTime
  });

  check('oldest');
  currentTime += 1;
  check('middle');
  currentTime += 1;
  check('newest');
  assert.equal(check.size(), 3);

  currentTime += 1;
  assert.equal(check('overflow'), 0);
  assert.equal(check.size(), 3);

  // The oldest bucket was evicted, so it starts a fresh request window.
  currentTime += 1;
  assert.equal(check('oldest'), 0);
  assert.equal(check.size(), 3);

  // A retained bucket is still limited until its original window expires.
  assert.equal(check('newest'), 60);
});
