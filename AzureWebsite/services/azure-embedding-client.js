'use strict';

const { DefaultAzureCredential } = require('@azure/identity');

const MODEL_SCOPE = 'https://cognitiveservices.azure.com/.default';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_EMBEDDING_INPUT_CHARS = 24000;
const MAX_EMBEDDING_BATCH_SIZE = 16;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 12000;
const RETRY_DELAYS_MS = [250, 500, 1000];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class AzureEmbeddingConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AzureEmbeddingConfigurationError';
    this.code = 'embedding_configuration_error';
    this.researchAssistantErrorKind = 'configuration';
  }
}

class AzureEmbeddingError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AzureEmbeddingError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.researchAssistantErrorKind = options.kind || 'upstream';
  }
}

function azureOpenAIEndpoint(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AzureEmbeddingConfigurationError('AZURE_OPENAI_ENDPOINT must be a valid HTTPS Azure OpenAI endpoint.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || !['.openai.azure.com', '.cognitiveservices.azure.com', '.services.ai.azure.com'].some((suffix) => host.endsWith(suffix))) {
    throw new AzureEmbeddingConfigurationError('AZURE_OPENAI_ENDPOINT must be a valid HTTPS Azure OpenAI endpoint.');
  }
  return url.origin;
}

function configuredDeployment(value) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new AzureEmbeddingConfigurationError('AZURE_OPENAI_EMBEDDING_DEPLOYMENT contains unsupported characters.');
  }
  return value;
}

function timeout(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 120000) {
    throw new AzureEmbeddingConfigurationError('Embedding timeout is outside the supported range.');
  }
  return number;
}

function inputText(value) {
  if (typeof value !== 'string') throw new AzureEmbeddingError('embedding_invalid_input', 'Embedding input is invalid.', { kind: 'input' });
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_EMBEDDING_INPUT_CHARS) {
    throw new AzureEmbeddingError('embedding_invalid_input', 'Embedding input is outside the supported bounds.', { kind: 'input' });
  }
  return text;
}

function validVector(value) {
  return Array.isArray(value)
    && value.length === EMBEDDING_DIMENSIONS
    && value.every((number) => typeof number === 'number' && Number.isFinite(number));
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function retryDelay(response, fallback) {
  const raw = response?.headers?.get?.('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60000, Math.max(fallback, Math.ceil(seconds * 1000)));
  const at = Date.parse(raw || '');
  return Number.isFinite(at) ? Math.min(60000, Math.max(fallback, at - Date.now())) : fallback;
}

function cancelledError(cause) {
  return new AzureEmbeddingError('embedding_cancelled', 'The embedding request was cancelled.', { cause, kind: 'cancelled' });
}

async function token(credential, timeoutMs, externalSignal) {
  if (externalSignal?.aborted) throw cancelledError();
  let timer;
  let abort;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Credential timeout.')), timeoutMs);
    });
    const cancellation = new Promise((_, reject) => {
      abort = () => reject(cancelledError());
      externalSignal?.addEventListener?.('abort', abort, { once: true });
    });
    const result = await Promise.race([credential.getToken(MODEL_SCOPE), deadline, cancellation]);
    if (!result || typeof result.token !== 'string' || !result.token) throw new Error('Missing token.');
    return result.token;
  } catch (cause) {
    if (cause instanceof AzureEmbeddingError) throw cause;
    throw new AzureEmbeddingError('embedding_authentication_failed', 'The embedding service could not authenticate.', { cause, kind: 'authentication' });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', abort);
  }
}

async function timedFetch(fetchImplementation, url, options, timeoutMs, externalSignal) {
  if (externalSignal?.aborted) {
    throw new AzureEmbeddingError('embedding_cancelled', 'The embedding request was cancelled.', { kind: 'cancelled' });
  }
  const controller = new AbortController();
  let externallyAborted = false;
  const abort = () => { externallyAborted = true; controller.abort(); };
  externalSignal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fetchImplementation(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (externallyAborted) throw new AzureEmbeddingError('embedding_cancelled', 'The embedding request was cancelled.', { cause, kind: 'cancelled' });
    if (controller.signal.aborted || cause?.name === 'AbortError') {
      throw new AzureEmbeddingError('embedding_timeout', 'The embedding request timed out.', { cause, retryable: true, kind: 'timeout' });
    }
    throw new AzureEmbeddingError('embedding_unavailable', 'The embedding service could not be reached.', { cause, retryable: true, kind: 'unavailable' });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', abort);
  }
}

async function abortableWait(wait, milliseconds, externalSignal) {
  if (externalSignal?.aborted) throw cancelledError();
  let abort;
  try {
    await Promise.race([
      wait(milliseconds),
      new Promise((_, reject) => {
        abort = () => reject(cancelledError());
        externalSignal?.addEventListener?.('abort', abort, { once: true });
      })
    ]);
  } finally {
    externalSignal?.removeEventListener?.('abort', abort);
  }
}

function errorForStatus(response) {
  if (response.status === 429) return new AzureEmbeddingError('embedding_busy', 'The embedding service is busy.', { retryable: true, kind: 'throttled' });
  if (response.status === 503) return new AzureEmbeddingError('embedding_unavailable', 'The embedding service is unavailable.', { retryable: true, kind: 'unavailable' });
  if (response.status === 401) return new AzureEmbeddingError('embedding_authentication_failed', 'The embedding service could not authenticate.', { kind: 'authentication' });
  if (response.status === 403) return new AzureEmbeddingError('embedding_authorization_failed', 'The embedding service is not authorized.', { kind: 'authorization' });
  return new AzureEmbeddingError('embedding_upstream_error', 'The embedding service returned an unexpected response.');
}

async function responseVectors(response, count) {
  let payload;
  try { payload = await response.json(); } catch (cause) {
    throw new AzureEmbeddingError('embedding_invalid_response', 'The embedding service returned invalid JSON.', { cause });
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (data.length !== count) throw new AzureEmbeddingError('embedding_invalid_response', 'The embedding service returned an incomplete batch.');
  const ordered = data.slice().sort((a, b) => Number(a?.index) - Number(b?.index));
  if (ordered.some((item, index) => Number(item?.index) !== index || !validVector(item?.embedding))) {
    throw new AzureEmbeddingError('embedding_invalid_response', 'The embedding service returned an invalid vector.');
  }
  return ordered.map((item) => item.embedding);
}

function createAzureEmbeddingClient(options = {}) {
  const environment = options.env || process.env;
  if (options.apiKey || options.openAIApiKey || environment.AZURE_OPENAI_API_KEY || environment.OPENAI_API_KEY) {
    throw new AzureEmbeddingConfigurationError('API-key authentication is not supported.');
  }
  const endpoint = azureOpenAIEndpoint(environment.AZURE_OPENAI_ENDPOINT);
  const deployment = configuredDeployment(environment.AZURE_OPENAI_EMBEDDING_DEPLOYMENT);
  const credential = options.credential || new DefaultAzureCredential({ excludeInteractiveBrowserCredential: true });
  const fetchImplementation = options.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new AzureEmbeddingConfigurationError('A Fetch API implementation is required.');
  const requestTimeoutMs = timeout(options.timeoutMs, DEFAULT_EMBEDDING_TIMEOUT_MS);
  const wait = options.sleep || sleep;

  return {
    async embed(inputs, optionsForRequest = {}) {
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_EMBEDDING_BATCH_SIZE) {
        throw new AzureEmbeddingError('embedding_invalid_input', 'Embedding batch is outside the supported bounds.', { kind: 'input' });
      }
      const normalized = inputs.map(inputText);
      let response;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        const accessToken = await token(credential, requestTimeoutMs, optionsForRequest.signal);
        response = await timedFetch(fetchImplementation, `${endpoint}/openai/v1/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: deployment, input: normalized, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' })
        }, requestTimeoutMs, optionsForRequest.signal);
        if (response.ok) return responseVectors(response, normalized.length);
        const error = errorForStatus(response);
        if (!error.retryable || attempt === RETRY_DELAYS_MS.length) throw error;
        await abortableWait(wait, retryDelay(response, RETRY_DELAYS_MS[attempt]), optionsForRequest.signal);
      }
      throw errorForStatus(response || { status: 503 });
    }
  };
}

module.exports = {
  AzureEmbeddingConfigurationError,
  AzureEmbeddingError,
  EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_INPUT_CHARS,
  MODEL_SCOPE,
  createAzureEmbeddingClient,
  validVector
};
