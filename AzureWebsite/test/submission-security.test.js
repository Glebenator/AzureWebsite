'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCsrfProtection } = require('../services/submission-csrf');
const { createSubmissionQuota } = require('../services/submission-quota');
const { createOpaqueSessionStore, sessionCookieOptions } = require('../services/submission-session');

test('per-account and per-IP quotas are independent, atomic, private, and expire', () => {
  let currentTime = 0;
  const quota = createSubmissionQuota({
    accountLimit: 1,
    ipLimit: 2,
    windowMs: 1_000,
    now: () => currentTime,
    keySecret: Buffer.alloc(32, 7)
  });

  assert.deepEqual(quota({ accountId: 'account-a', ip: '192.0.2.1' }), {
    allowed: true,
    accountRemaining: 0,
    ipRemaining: 1,
    resetAt: '1970-01-01T00:00:01.000Z'
  });
  assert.equal(quota({ accountId: 'account-a', ip: '192.0.2.2' }).scope, 'account');
  // The denied account attempt did not consume the second IP's allowance.
  assert.equal(quota({ accountId: 'account-b', ip: '192.0.2.2' }).allowed, true);
  assert.equal(quota({ accountId: 'account-c', ip: '192.0.2.1' }).allowed, true);
  assert.equal(quota({ accountId: 'account-d', ip: '192.0.2.1' }).scope, 'ip');
  assert.equal(quota.size(), 5);

  currentTime = 1_000;
  assert.equal(quota({ accountId: 'account-a', ip: '192.0.2.1' }).allowed, true);
});

test('quota bucket capacity fails closed instead of evicting live limits', () => {
  const quota = createSubmissionQuota({ accountLimit: 2, ipLimit: 2, maxBuckets: 2, now: () => 0 });
  assert.equal(quota({ accountId: 'one', ip: '192.0.2.1' }).allowed, true);
  const result = quota({ accountId: 'two', ip: '192.0.2.2' });
  assert.equal(result.allowed, false);
  assert.equal(result.scope, 'capacity');
  assert.equal(quota({ accountId: 'one', ip: '192.0.2.1' }).allowed, true);
});

test('opaque server-side sessions expire, can be destroyed, and retain only minimum identity', () => {
  let currentTime = 10;
  const sessions = createOpaqueSessionStore({ ttlMs: 100, now: () => currentTime });
  const token = sessions.issue({
    accountId: 'internal-account',
    googleSub: 'immutable-google-sub',
    displayName: 'must-not-persist',
    accessToken: 'must-not-persist'
  });

  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(sessions.get(token), {
    accountId: 'internal-account',
    googleSub: 'immutable-google-sub',
    expiresAt: 110
  });
  assert.equal(sessions.get('not-a-valid-session-token'), null);
  currentTime = 110;
  assert.equal(sessions.get(token), null);
  assert.equal(sessions.size(), 0);

  const second = sessions.issue({ accountId: 'second', googleSub: 'second-sub' });
  assert.equal(sessions.destroy(second), true);
  assert.equal(sessions.get(second), null);
});

test('session cookie defaults are HttpOnly, SameSite Lax, and Secure in production', () => {
  assert.deepEqual(sessionCookieOptions({ production: true, maxAgeMs: 500 }), {
    httpOnly: true,
    maxAge: 500,
    path: '/',
    sameSite: 'lax',
    secure: true
  });
  assert.equal(sessionCookieOptions({ production: false }).secure, false);
});

test('CSRF tokens bind the session, method, and same-origin path and reject tampering or expiry', () => {
  let currentTime = 1_000;
  const csrf = createCsrfProtection({
    secret: Buffer.alloc(32, 3),
    ttlMs: 100,
    now: () => currentTime
  });
  const token = csrf.issue('opaque-session-a', { method: 'POST', path: '/submissions/one/delete' });

  assert.equal(csrf.verify(token, 'opaque-session-a', { method: 'POST', path: '/submissions/one/delete' }), true);
  assert.equal(csrf.verify(token, 'opaque-session-b', { method: 'POST', path: '/submissions/one/delete' }), false);
  assert.equal(csrf.verify(token, 'opaque-session-a', { method: 'DELETE', path: '/submissions/one/delete' }), false);
  assert.equal(csrf.verify(token, 'opaque-session-a', { method: 'POST', path: '/submissions/two/delete' }), false);
  assert.equal(csrf.verify(`${token.slice(0, -1)}x`, 'opaque-session-a', { method: 'POST', path: '/submissions/one/delete' }), false);
  currentTime = 1_100;
  assert.equal(csrf.verify(token, 'opaque-session-a', { method: 'POST', path: '/submissions/one/delete' }), false);
  assert.throws(() => csrf.issue('opaque-session-a', { path: 'https://evil.example/action' }), /same-origin/);
});
