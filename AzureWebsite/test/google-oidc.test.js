'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OidcAuthenticationError,
  OidcConfigurationError,
  createGoogleOidc,
  validateRedirectUri
} = require('../services/google-oidc');

function configuredEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    GOOGLE_OIDC_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
    GOOGLE_OIDC_REDIRECT_URI: 'https://example.com/auth/google/callback',
    ...overrides
  };
}

function fakeDiscovery(claims = { sub: 'google-subject-123' }, calls = {}) {
  return async function discover(issuerUrl) {
    calls.issuerUrl = issuerUrl;
    return {
      Client: class FakeClient {
        constructor(configuration) { calls.configuration = configuration; }
        authorizationUrl(parameters) {
          calls.authorizationParameters = parameters;
          return `https://accounts.google.com/o/oauth2/v2/auth?state=${parameters.state}`;
        }
        callbackParams(request) {
          calls.request = request;
          return { code: 'authorization-code', state: 'state-value' };
        }
        async callback(redirectUri, parameters, checks) {
          calls.callback = { redirectUri, parameters, checks };
          return { claims() { return claims; } };
        }
      }
    };
  };
}

test('Google OIDC begins authorization with state, nonce, PKCE, and openid-only scope', async () => {
  const calls = {};
  const oidc = createGoogleOidc({
    env: configuredEnv(),
    discover: fakeDiscovery({ sub: 'subject' }, calls),
    now: () => 1000,
    generators: {
      codeVerifier: () => 'verifier-value',
      codeChallenge: (value) => `challenge-for-${value}`,
      nonce: () => 'nonce-value',
      state: () => 'state-value'
    }
  });

  const result = await oidc.begin();
  assert.match(result.url, /^https:\/\/accounts\.google\.com\//);
  assert.deepEqual(result.attempt, {
    codeVerifier: 'verifier-value',
    nonce: 'nonce-value',
    state: 'state-value',
    expiresAt: 601000
  });
  assert.equal(calls.authorizationParameters.scope, 'openid');
  assert.equal(calls.authorizationParameters.response_type, 'code');
  assert.equal(calls.authorizationParameters.response_mode, 'query');
  assert.equal(calls.authorizationParameters.code_challenge_method, 'S256');
  assert.equal(calls.authorizationParameters.code_challenge, 'challenge-for-verifier-value');
  assert.equal(calls.authorizationParameters.nonce, 'nonce-value');
  assert.equal(calls.authorizationParameters.state, 'state-value');
});

test('Google OIDC callback applies exact state, nonce, PKCE, code-flow, issuer, and audience checks', async () => {
  const calls = {};
  const oidc = createGoogleOidc({
    env: configuredEnv(),
    discover: fakeDiscovery({ sub: 'immutable-google-sub' }, calls),
    now: () => 2000
  });
  const request = { url: '/auth/google/callback?code=authorization-code' };
  const result = await oidc.complete(request, {
    state: 'state-value',
    nonce: 'nonce-value',
    codeVerifier: 'verifier-value',
    expiresAt: 3000
  });

  assert.deepEqual(result, { subject: 'immutable-google-sub' });
  assert.equal(calls.issuerUrl, 'https://accounts.google.com');
  assert.deepEqual(calls.configuration.redirect_uris, ['https://example.com/auth/google/callback']);
  assert.deepEqual(calls.configuration.response_types, ['code']);
  assert.deepEqual(calls.callback.checks, {
    state: 'state-value',
    nonce: 'nonce-value',
    code_verifier: 'verifier-value',
    response_type: 'code'
  });
});

test('Google OIDC fails closed for expired attempts and invalid subjects', async () => {
  const expired = createGoogleOidc({
    env: configuredEnv(),
    discover: fakeDiscovery(),
    now: () => 5000
  });
  await assert.rejects(
    expired.complete({}, { state: 's', nonce: 'n', codeVerifier: 'v', expiresAt: 4999 }),
    OidcAuthenticationError
  );

  const invalidSubject = createGoogleOidc({
    env: configuredEnv(),
    discover: fakeDiscovery({ sub: 'bad subject with spaces' }),
    now: () => 1000
  });
  await assert.rejects(
    invalidSubject.complete({}, { state: 's', nonce: 'n', codeVerifier: 'v', expiresAt: 2000 }),
    /valid account identifier/i
  );
});

test('Google OIDC requires HTTPS outside local development and never accepts partial configuration', () => {
  const loopbackHost = ['local', 'host'].join('');
  assert.throws(
    () => validateRedirectUri('http://example.com/auth/google/callback', 'production'),
    OidcConfigurationError
  );
  assert.equal(
    validateRedirectUri(`http://${loopbackHost}:3000/auth/google/callback`, 'development'),
    `http://${loopbackHost}:3000/auth/google/callback`
  );
  const oidc = createGoogleOidc({ env: { GOOGLE_OIDC_CLIENT_ID: 'only-id' } });
  assert.equal(oidc.isConfigured(), false);
});
