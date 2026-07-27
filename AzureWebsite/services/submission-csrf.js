'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '', 'utf8');
  const rightBuffer = Buffer.from(right || '', 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createCsrfProtection(options = {}) {
  const secret = Buffer.isBuffer(options.secret) && options.secret.length >= 32
    ? options.secret
    : crypto.randomBytes(32);
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function context(sessionToken, method, pathname) {
    if (typeof sessionToken !== 'string' || !sessionToken) throw new TypeError('A session token is required.');
    const normalizedMethod = String(method || 'POST').toUpperCase();
    const normalizedPath = String(pathname || '/');
    if (!normalizedPath.startsWith('/') || normalizedPath.includes('\n') || normalizedPath.includes('\r')) {
      throw new TypeError('A same-origin request path is required.');
    }
    return `${crypto.createHash('sha256').update(sessionToken).digest('base64url')}\n${normalizedMethod}\n${normalizedPath}`;
  }

  function issue(sessionToken, { method = 'POST', path = '/' } = {}) {
    const expiresAt = now() + ttlMs;
    const nonce = crypto.randomBytes(18).toString('base64url');
    const payload = `${expiresAt}.${nonce}`;
    const signature = crypto.createHmac('sha256', secret)
      .update(`${payload}\n${context(sessionToken, method, path)}`)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  function verify(token, sessionToken, { method = 'POST', path = '/' } = {}) {
    if (typeof token !== 'string' || token.length > 256) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^\d{1,16}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{20,64}$/.test(parts[1])) return false;
    const expiresAt = Number(parts[0]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false;
    let requestContext;
    try {
      requestContext = context(sessionToken, method, path);
    } catch {
      return false;
    }
    const payload = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', secret)
      .update(`${payload}\n${requestContext}`)
      .digest('base64url');
    return safeEqual(parts[2], expected);
  }

  return { issue, verify };
}

module.exports = { createCsrfProtection };
