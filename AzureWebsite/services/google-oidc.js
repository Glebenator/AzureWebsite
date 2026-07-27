'use strict';

const { Issuer, generators } = require('openid-client');

const GOOGLE_ISSUER = 'https://accounts.google.com';
const AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SUB_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;
const LOCAL_DEVELOPMENT_HOST = ['local', 'host'].join('');

class OidcConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OidcConfigurationError';
  }
}

class OidcAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OidcAuthenticationError';
  }
}

function configuredValue(value, maximumLength = 2048) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximumLength ? trimmed : '';
}

function validateRedirectUri(value, environment) {
  const uri = configuredValue(value);
  if (!uri) throw new OidcConfigurationError('Google sign-in redirect URI is not configured.');

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new OidcConfigurationError('Google sign-in redirect URI is invalid.');
  }

  const localDevelopment = environment !== 'production'
    && parsed.protocol === 'http:'
    && (parsed.hostname === LOCAL_DEVELOPMENT_HOST || parsed.hostname === '::1');
  if (parsed.protocol !== 'https:' && !localDevelopment) {
    throw new OidcConfigurationError('Google sign-in redirect URI must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new OidcConfigurationError('Google sign-in redirect URI is invalid.');
  }
  return parsed.toString();
}

function readConfiguration(env) {
  const clientId = configuredValue(env.GOOGLE_OIDC_CLIENT_ID, 512);
  const clientSecret = configuredValue(env.GOOGLE_OIDC_CLIENT_SECRET, 1024);
  if (!clientId || !clientSecret) {
    throw new OidcConfigurationError('Google sign-in is not configured.');
  }
  return {
    clientId,
    clientSecret,
    redirectUri: validateRedirectUri(env.GOOGLE_OIDC_REDIRECT_URI, env.NODE_ENV)
  };
}

function createGoogleOidc(options = {}) {
  const env = options.env || process.env;
  const discover = options.discover || ((issuer) => Issuer.discover(issuer));
  const now = options.now || Date.now;
  const random = options.generators || generators;
  let clientPromise;

  function isConfigured() {
    return Boolean(
      configuredValue(env.GOOGLE_OIDC_CLIENT_ID, 512)
      && configuredValue(env.GOOGLE_OIDC_CLIENT_SECRET, 1024)
      && configuredValue(env.GOOGLE_OIDC_REDIRECT_URI)
    );
  }

  async function getClient() {
    const configuration = readConfiguration(env);
    if (!clientPromise) {
      clientPromise = Promise.resolve(discover(GOOGLE_ISSUER)).then((issuer) => {
        if (!issuer || typeof issuer.Client !== 'function') {
          throw new OidcConfigurationError('Google identity discovery failed.');
        }
        return new issuer.Client({
          client_id: configuration.clientId,
          client_secret: configuration.clientSecret,
          redirect_uris: [configuration.redirectUri],
          response_types: ['code']
        });
      });
    }
    return { client: await clientPromise, configuration };
  }

  async function begin() {
    const { client } = await getClient();
    const codeVerifier = random.codeVerifier();
    const attempt = {
      codeVerifier,
      nonce: random.nonce(),
      state: random.state(),
      expiresAt: now() + AUTH_ATTEMPT_TTL_MS
    };
    const url = client.authorizationUrl({
      scope: 'openid',
      response_type: 'code',
      response_mode: 'query',
      code_challenge: random.codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      nonce: attempt.nonce,
      state: attempt.state,
      prompt: 'select_account'
    });
    return { attempt, url };
  }

  async function complete(request, attempt) {
    if (!attempt || typeof attempt !== 'object' || now() > attempt.expiresAt) {
      throw new OidcAuthenticationError('The sign-in attempt expired. Please try again.');
    }
    if (!attempt.state || !attempt.nonce || !attempt.codeVerifier) {
      throw new OidcAuthenticationError('The sign-in attempt is invalid. Please try again.');
    }

    try {
      const { client, configuration } = await getClient();
      const params = client.callbackParams(request);
      const tokens = await client.callback(configuration.redirectUri, params, {
        state: attempt.state,
        nonce: attempt.nonce,
        code_verifier: attempt.codeVerifier,
        response_type: 'code'
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !GOOGLE_SUB_PATTERN.test(claims.sub)) {
        throw new OidcAuthenticationError('Google did not return a valid account identifier.');
      }
      return { subject: claims.sub };
    } catch (error) {
      if (error instanceof OidcAuthenticationError) throw error;
      throw new OidcAuthenticationError('Google sign-in could not be verified. Please try again.');
    }
  }

  return { begin, complete, isConfigured };
}

module.exports = {
  AUTH_ATTEMPT_TTL_MS,
  GOOGLE_ISSUER,
  OidcAuthenticationError,
  OidcConfigurationError,
  createGoogleOidc,
  readConfiguration,
  validateRedirectUri
};
