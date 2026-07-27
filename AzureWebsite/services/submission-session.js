'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 10_000;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function digestToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
}

function minimalSessionData(data) {
  if (!data || typeof data.accountId !== 'string' || !data.accountId || data.accountId.length > 256) {
    throw new TypeError('Session accountId is required.');
  }
  if (typeof data.googleSub !== 'string' || !data.googleSub || data.googleSub.length > 256) {
    throw new TypeError('Session googleSub is required.');
  }
  return { accountId: data.accountId, googleSub: data.googleSub };
}

function createOpaqueSessionStore(options = {}) {
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
  const maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessions = new Map();

  function sweep(currentTime = now()) {
    for (const [key, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(key);
    }
  }

  function issue(data) {
    const currentTime = now();
    sweep(currentTime);
    if (sessions.size >= maxSessions) {
      throw new Error('The session store is at capacity.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(digestToken(token), {
      ...minimalSessionData(data),
      createdAt: currentTime,
      expiresAt: currentTime + ttlMs
    });
    return token;
  }

  function get(token, { touch = false } = {}) {
    const key = digestToken(token);
    if (!key) return null;
    const session = sessions.get(key);
    const currentTime = now();
    if (!session || session.expiresAt <= currentTime) {
      if (session) sessions.delete(key);
      return null;
    }
    if (touch) session.expiresAt = currentTime + ttlMs;
    return { accountId: session.accountId, googleSub: session.googleSub, expiresAt: session.expiresAt };
  }

  function destroy(token) {
    const key = digestToken(token);
    return key ? sessions.delete(key) : false;
  }

  return { destroy, get, issue, size: () => sessions.size, sweep };
}

function sessionCookieOptions({ production = process.env.NODE_ENV === 'production', maxAgeMs = DEFAULT_TTL_MS } = {}) {
  return Object.freeze({
    httpOnly: true,
    maxAge: maxAgeMs,
    path: '/',
    sameSite: 'lax',
    secure: Boolean(production)
  });
}

module.exports = {
  createOpaqueSessionStore,
  digestToken,
  sessionCookieOptions
};
