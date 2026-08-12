'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CAPTURE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 25;
const HARD_MAX_FILES = 100;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const HARD_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ANOMALIES = new Set([
  'invalid_model_response',
  'replay_divergence',
  'topic_mismatch'
]);
const ALLOWED_DEPENDENCIES = new Set([
  'model_completion',
  'wikipedia_read',
  'wikipedia_search'
]);
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|connection[-_]?string|client[-_]?secret|account[-_]?key|sas)$/i;

class ResearchLabDiagnosticConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResearchLabDiagnosticConfigurationError';
    this.code = 'diagnostic_configuration_rejected';
  }
}

class ResearchLabReplayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResearchLabReplayError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function explicitBoolean(value) {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function replaceExactSecrets(value, secrets) {
  let output = value;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function redactString(value, secrets) {
  return replaceExactSecrets(value, secrets)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '[REDACTED HEADER]')
    .replace(/\b(?:api[-_]?key|token|secret|password)\s*[=:]\s*[^\s&,;]+/gi, '$1=[REDACTED]')
    .replace(/([?&](?:sig|token|key|code|credential|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/Account(?:Key)\s*=\s*[^;\s]+/gi, `Account${'Key'}=[REDACTED]`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, 16000);
}

function sanitizeDiagnosticValue(value, options = {}, state = { depth: 0, counter: { nodes: 0 } }) {
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  const traversal = state && state.counter
    ? state
    : { depth: state && Number.isInteger(state.depth) ? state.depth : 0, counter: { nodes: 0 } };
  if (traversal.counter.nodes >= 1000 || traversal.depth > 8) return '[TRUNCATED]';
  traversal.counter.nodes += 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeDiagnosticValue(
      item,
      options,
      { depth: traversal.depth + 1, counter: traversal.counter }
    ));
  }
  if (!value || typeof value !== 'object') return undefined;

  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    const safeKey = String(key).slice(0, 100);
    output[safeKey] = SENSITIVE_KEY.test(safeKey)
      ? '[REDACTED]'
      : sanitizeDiagnosticValue(item, options, {
          depth: traversal.depth + 1,
          counter: traversal.counter
        });
  }
  return output;
}

function projectedRealPath(value) {
  let existing = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function safeCaptureDirectory(directory, publicRoot) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new ResearchLabDiagnosticConfigurationError('Diagnostic capture requires an explicit absolute directory.');
  }
  const requested = path.resolve(directory);
  if (fs.existsSync(requested) && fs.lstatSync(requested).isSymbolicLink()) {
    throw new ResearchLabDiagnosticConfigurationError('Diagnostic capture directory must not be a symbolic link.');
  }
  const resolved = projectedRealPath(requested);
  const resolvedPublic = projectedRealPath(publicRoot || path.join(__dirname, '..', 'public'));
  if (resolved === path.parse(resolved).root || resolved === resolvedPublic || resolved.startsWith(`${resolvedPublic}${path.sep}`)) {
    throw new ResearchLabDiagnosticConfigurationError('Diagnostic capture directory must be private and outside the web root.');
  }
  return resolved;
}

class LocalResearchLabDiagnosticStore {
  constructor(options = {}) {
    this.directory = safeCaptureDirectory(options.directory, options.publicRoot);
    this.maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1024, HARD_MAX_BYTES);
    this.maxFiles = boundedInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, HARD_MAX_FILES);
    this.now = options.now || Date.now;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  async prune() {
    const entries = await fsp.readdir(this.directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      const filename = path.join(this.directory, entry.name);
      const stat = await fsp.lstat(filename);
      if (stat.isSymbolicLink()) continue;
      let expired = false;
      if (stat.size > this.maxBytes) {
        expired = true;
      } else {
        try {
          const parsed = JSON.parse(await fsp.readFile(filename, 'utf8'));
          expired = !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= this.now();
        } catch {
          expired = true;
        }
      }
      if (expired) {
        await fsp.unlink(filename);
      } else {
        files.push({ filename, mtimeMs: stat.mtimeMs });
      }
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    while (files.length >= this.maxFiles) {
      const oldest = files.shift();
      await fsp.unlink(oldest.filename);
    }
  }

  async write(envelope) {
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      return { stored: false, reason: 'capture_too_large' };
    }
    await this.prune();
    const captureId = crypto.randomUUID();
    const filename = path.join(this.directory, `${captureId}.json`);
    const handle = await fsp.open(filename, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.chmod(filename, 0o600);
    return { stored: true, captureId, filename };
  }
}

function disabledRecorder(issue = null) {
  return Object.freeze({
    enabled: false,
    contentEnabled: false,
    configurationIssue: issue,
    async capture() { return { stored: false, reason: 'capture_disabled' }; },
    startRun() { return null; }
  });
}

function createResearchLabDiagnosticRecorder(options = {}) {
  const enabled = explicitBoolean(options.enabled);
  if (!enabled) return disabledRecorder();
  const contentEnabled = explicitBoolean(options.contentEnabled);
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || 'production';
  let store = options.store;
  if (!store) {
    if (nodeEnv === 'production') {
      return disabledRecorder('Local diagnostic files are refused in production; inject an approved private store.');
    }
    try {
      store = new LocalResearchLabDiagnosticStore(options);
    } catch (error) {
      if (error instanceof ResearchLabDiagnosticConfigurationError) return disabledRecorder(error.message);
      throw error;
    }
  }
  if (!store || typeof store.write !== 'function') {
    return disabledRecorder('Diagnostic capture store must implement write(envelope).');
  }

  const now = options.now || Date.now;
  const ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 60 * 1000, HARD_MAX_TTL_MS);
  const baseSecrets = Array.isArray(options.secrets) ? options.secrets.filter((item) => typeof item === 'string') : [];

  async function capture(category, context, producer) {
    if (!ALLOWED_ANOMALIES.has(category)) return { stored: false, reason: 'anomaly_not_allowed' };
    const produced = typeof producer === 'function' ? await producer() : producer;
    const capturedAt = now();
    const envelope = sanitizeDiagnosticValue({
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      capturedAt,
      expiresAt: capturedAt + ttlMs,
      category,
      requestId: context && context.requestId,
      runId: context && context.runId,
      mode: context && context.mode,
      model: context && context.model,
      ...(contentEnabled ? { replay: produced } : { summary: produced && produced.summary })
    }, { secrets: [...baseSecrets, ...((context && context.secrets) || [])] });
    return store.write(envelope);
  }

  return Object.freeze({
    enabled: true,
    contentEnabled,
    configurationIssue: null,
    capture,
    startRun(context = {}) {
      const dependencies = [];
      const input = contentEnabled ? {
        query: context.query,
        mode: context.mode,
        model: context.model
      } : null;
      return {
        recordDependency(kind, fixture) {
          if (!contentEnabled || !ALLOWED_DEPENDENCIES.has(kind)) return;
          dependencies.push({
            kind,
            ...fixture,
            requestId: context.requestId,
            runId: context.runId
          });
        },
        async capture(category, summary) {
          return capture(category, context, () => contentEnabled
            ? { input, dependencies, expected: summary }
            : { summary });
        }
      };
    }
  });
}

function createEnvironmentDiagnosticRecorder(options = {}) {
  return createResearchLabDiagnosticRecorder({
    enabled: process.env.RESEARCH_LAB_DIAGNOSTIC_CAPTURE_ENABLED,
    contentEnabled: process.env.RESEARCH_LAB_DIAGNOSTIC_CONTENT_ENABLED,
    directory: process.env.RESEARCH_LAB_DIAGNOSTIC_DIRECTORY,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    nodeEnv: options.nodeEnv,
    publicRoot: options.publicRoot,
    secrets: options.secrets,
    store: options.store,
    ttlMs: options.ttlMs
  });
}

function createBlobResearchLabDiagnosticStore(options = {}) {
  const containerClient = options.containerClient;
  const prefix = typeof options.prefix === 'string' && /^[a-z0-9/_-]{1,80}$/i.test(options.prefix)
    ? options.prefix.replace(/^\/+|\/+$/g, '')
    : 'research-lab-flight-recorder';
  if (!containerClient || typeof containerClient.getBlockBlobClient !== 'function') {
    throw new ResearchLabDiagnosticConfigurationError('Azure diagnostic store requires an injected private container client.');
  }
  return Object.freeze({
    async write(envelope) {
      const captureId = crypto.randomUUID();
      const body = JSON.stringify(envelope);
      if (Buffer.byteLength(body, 'utf8') > HARD_MAX_BYTES) {
        return { stored: false, reason: 'capture_too_large' };
      }
      const blob = containerClient.getBlockBlobClient(`${prefix}/${captureId}.json`);
      await blob.uploadData(Buffer.from(body, 'utf8'), {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' },
        metadata: {
          category: envelope.category,
          expiresat: String(envelope.expiresAt),
          runid: envelope.runId
        },
        tags: { expiresAt: String(envelope.expiresAt) }
      });
      return { stored: true, captureId };
    }
  });
}

async function readResearchLabDiagnosticCapture(filename, options = {}) {
  const maximum = boundedInteger(options.maxBytes, HARD_MAX_BYTES, 1024, HARD_MAX_BYTES);
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw new ResearchLabReplayError('invalid_capture', 'The diagnostic capture is invalid or oversized.');
  }
  let capture;
  try {
    capture = JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch {
    throw new ResearchLabReplayError('invalid_capture', 'The diagnostic capture is invalid.');
  }
  const now = (options.now || Date.now)();
  if (
    capture.schemaVersion !== CAPTURE_SCHEMA_VERSION
    || !ID_PATTERN.test(capture.requestId || '')
    || !ID_PATTERN.test(capture.runId || '')
    || !ALLOWED_ANOMALIES.has(capture.category)
    || !Number.isFinite(capture.expiresAt)
  ) {
    throw new ResearchLabReplayError('invalid_capture', 'The diagnostic capture schema is invalid.');
  }
  if (capture.expiresAt <= now) {
    throw new ResearchLabReplayError('expired_capture', 'The diagnostic capture has expired.');
  }
  return capture;
}

module.exports = {
  CAPTURE_SCHEMA_VERSION,
  LocalResearchLabDiagnosticStore,
  ResearchLabReplayError,
  createBlobResearchLabDiagnosticStore,
  createEnvironmentDiagnosticRecorder,
  createResearchLabDiagnosticRecorder,
  readResearchLabDiagnosticCapture,
  sanitizeDiagnosticValue
};
