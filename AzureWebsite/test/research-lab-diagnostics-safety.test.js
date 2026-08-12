'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  LocalResearchLabDiagnosticStore,
  createResearchLabDiagnosticRecorder,
  sanitizeDiagnosticValue
} = require('../services/research-lab-diagnostics');

const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('diagnostic capture is default-off and does not evaluate a lazy producer', async () => {
  let produced = 0;
  let written = 0;
  const recorder = createResearchLabDiagnosticRecorder({
    store: { async write() { written += 1; } }
  });

  const result = await recorder.capture('topic_mismatch', { requestId: REQUEST_ID, runId: RUN_ID }, () => {
    produced += 1;
    return { summary: { outcome: 'completed' } };
  });

  assert.equal(recorder.enabled, false);
  assert.equal(recorder.contentEnabled, false);
  assert.deepEqual(result, { stored: false, reason: 'capture_disabled' });
  assert.equal(produced, 0);
  assert.equal(written, 0);
});

test('diagnostic capture accepts only the explicit anomaly allowlist and remains summary-only by default', async () => {
  const envelopes = [];
  let rejectedProducerCalls = 0;
  const recorder = createResearchLabDiagnosticRecorder({
    enabled: true,
    nodeEnv: 'test',
    now: () => 1_000,
    store: {
      async write(envelope) {
        envelopes.push(envelope);
        return { stored: true, captureId: `capture-${envelopes.length}` };
      }
    }
  });

  for (const category of ['invalid_model_response', 'replay_divergence', 'topic_mismatch']) {
    const result = await recorder.capture(category, {
      requestId: REQUEST_ID,
      runId: RUN_ID,
      mode: 'research',
      model: 'openrouter/free'
    }, () => ({
      summary: { outcome: 'completed', answerLength: 17 },
      prompt: 'must not be captured',
      answer: 'must not be captured'
    }));
    assert.equal(result.stored, true, category);
  }

  const rejected = await recorder.capture('arbitrary_operator_request', {
    requestId: REQUEST_ID,
    runId: RUN_ID
  }, () => {
    rejectedProducerCalls += 1;
    return { summary: { outcome: 'failed' } };
  });

  assert.deepEqual(rejected, { stored: false, reason: 'anomaly_not_allowed' });
  assert.equal(rejectedProducerCalls, 0);
  assert.deepEqual(envelopes.map((item) => item.category), [
    'invalid_model_response',
    'replay_divergence',
    'topic_mismatch'
  ]);
  for (const envelope of envelopes) {
    assert.deepEqual(envelope.summary, { outcome: 'completed', answerLength: 17 });
    assert.equal(Object.hasOwn(envelope, 'replay'), false);
    assert.doesNotMatch(JSON.stringify(envelope), /must not be captured/);
    assert.equal(envelope.expiresAt - envelope.capturedAt, 60 * 60 * 1000);
  }
});

test('run-bound summary-only capture retains the bounded anomaly summary', async () => {
  let storedEnvelope;
  const recorder = createResearchLabDiagnosticRecorder({
    enabled: true,
    nodeEnv: 'test',
    now: () => 1_500,
    store: {
      async write(envelope) {
        storedEnvelope = envelope;
        return { stored: true, captureId: 'summary-capture' };
      }
    }
  });
  const session = recorder.startRun({
    requestId: REQUEST_ID,
    runId: RUN_ID,
    query: 'content must not be retained',
    mode: 'research',
    model: 'openrouter/free'
  });

  await session.capture('topic_mismatch', {
    outcome: 'completed',
    answerLength: 42,
    validation: { semanticSupport: 'unsupported' }
  });

  assert.deepEqual(storedEnvelope.summary, {
    outcome: 'completed',
    answerLength: 42,
    validation: { semanticSupport: 'unsupported' }
  });
  assert.equal(Object.hasOwn(storedEnvelope, 'replay'), false);
  assert.doesNotMatch(JSON.stringify(storedEnvelope), /content must not be retained/);
});

test('diagnostic sanitization redacts credential keys and credentials embedded in strings', () => {
  const exactSecret = 'exact-secret-12345';
  const bearerSecret = 'bearer-token-12345';
  const cookieSecret = 'cookie-session-12345';
  const apiSecret = 'api-secret-12345';
  const signatureSecret = 'signature-secret-12345';
  const accountSecret = 'account-secret-12345';
  const basicSecret = 'basic-password-12345';
  const accountKeyLabel = ['Account', 'Key'].join('');
  const sanitized = sanitizeDiagnosticValue({
    authorization: `Bearer ${bearerSecret}`,
    Cookie: `sid=${cookieSecret}`,
    apiKey: apiSecret,
    connectionString: `${accountKeyLabel}=${accountSecret}`,
    nested: {
      access_token: bearerSecret,
      note: [
        `Authorization: Bearer ${bearerSecret}`,
        `Cookie: sid=${cookieSecret}`,
        `api_key=${apiSecret}`,
        `https://example.invalid/path?sig=${signatureSecret}`,
        `${accountKeyLabel}=${accountSecret}`,
        `https://user:${basicSecret}@example.invalid/path`,
        `prefix ${exactSecret} suffix`
      ].join('\n')
    },
    safeCount: 2
  }, { secrets: [exactSecret] });

  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.Cookie, '[REDACTED]');
  assert.equal(sanitized.apiKey, '[REDACTED]');
  assert.equal(sanitized.connectionString, '[REDACTED]');
  assert.equal(sanitized.nested.access_token, '[REDACTED]');
  assert.equal(sanitized.safeCount, 2);
  const serialized = JSON.stringify(sanitized);
  for (const secret of [
    exactSecret,
    bearerSecret,
    cookieSecret,
    apiSecret,
    signatureSecret,
    accountSecret,
    basicSecret
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret), secret);
  }
  assert.match(serialized, /\[REDACTED\]/);
});

test('opt-in replay capture redacts configured and per-run secrets before storage', async () => {
  const configuredSecret = 'configured-capture-secret';
  const runSecret = 'per-run-capture-secret';
  let storedEnvelope;
  const recorder = createResearchLabDiagnosticRecorder({
    enabled: true,
    contentEnabled: true,
    nodeEnv: 'test',
    now: () => 2_000,
    secrets: [configuredSecret],
    store: {
      async write(envelope) {
        storedEnvelope = envelope;
        return { stored: true, captureId: 'redacted-capture' };
      }
    }
  });
  const session = recorder.startRun({
    requestId: REQUEST_ID,
    runId: RUN_ID,
    query: `Compare ${configuredSecret} and ${runSecret}`,
    mode: 'research',
    model: 'openrouter/free',
    secrets: [runSecret]
  });
  session.recordDependency('wikipedia_search', {
    requestId: '11111111-1111-4111-8111-111111111111',
    runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    status: 200,
    body: {
      authorization: `Bearer ${configuredSecret}`,
      extract: `Evidence containing ${runSecret}`
    }
  });
  session.recordDependency('operator_supplied_url', {
    status: 200,
    body: { value: configuredSecret }
  });

  const result = await session.capture('topic_mismatch', {
    outcome: 'completed',
    note: `Do not retain ${configuredSecret} or ${runSecret}`
  });

  assert.deepEqual(result, { stored: true, captureId: 'redacted-capture' });
  assert.equal(storedEnvelope.replay.dependencies.length, 1);
  assert.equal(storedEnvelope.replay.dependencies[0].requestId, REQUEST_ID);
  assert.equal(storedEnvelope.replay.dependencies[0].runId, RUN_ID);
  assert.equal(storedEnvelope.replay.dependencies[0].body.authorization, '[REDACTED]');
  const serialized = JSON.stringify(storedEnvelope);
  assert.doesNotMatch(serialized, new RegExp(configuredSecret));
  assert.doesNotMatch(serialized, new RegExp(runSecret));
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /operator_supplied_url/);
});

test('local diagnostic files are private, size-bounded, count-bounded, and expired captures are pruned', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'research-lab-diagnostic-test-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'private-captures');
  let now = 10_000;
  const store = new LocalResearchLabDiagnosticStore({
    directory,
    maxBytes: 1024,
    maxFiles: 1,
    now: () => now,
    publicRoot: path.join(parent, 'public')
  });

  const first = await store.write({ expiresAt: now + 100, marker: 'first' });
  assert.equal(first.stored, true);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(first.filename)).mode & 0o777, 0o600);

  const second = await store.write({ expiresAt: now + 100, marker: 'second' });
  assert.equal(second.stored, true);
  await assert.rejects(fs.stat(first.filename), (error) => error.code === 'ENOENT');
  assert.equal((await fs.readdir(directory)).length, 1);

  now += 101;
  const third = await store.write({ expiresAt: now + 100, marker: 'third' });
  assert.equal(third.stored, true);
  await assert.rejects(fs.stat(second.filename), (error) => error.code === 'ENOENT');
  assert.equal((await fs.readdir(directory)).length, 1);

  const oversized = await store.write({ expiresAt: now + 100, content: 'x'.repeat(2_000) });
  assert.deepEqual(oversized, { stored: false, reason: 'capture_too_large' });
  assert.equal((await fs.readdir(directory)).length, 1);
});

test('local diagnostic capture refuses a directory inside the public web root', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'research-lab-public-capture-test-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const publicRoot = path.join(parent, 'public');
  await fs.mkdir(publicRoot);

  const recorder = createResearchLabDiagnosticRecorder({
    enabled: true,
    contentEnabled: true,
    nodeEnv: 'test',
    directory: path.join(publicRoot, 'diagnostics'),
    publicRoot
  });

  assert.equal(recorder.enabled, false);
  assert.match(recorder.configurationIssue, /private|outside the web root/i);
  await assert.rejects(fs.stat(path.join(publicRoot, 'diagnostics')), (error) => error.code === 'ENOENT');
});

test('local diagnostic capture resolves parent symlinks before enforcing the public-root boundary', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'research-lab-public-alias-test-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const publicRoot = path.join(parent, 'public');
  const publicAlias = path.join(parent, 'public-alias');
  await fs.mkdir(publicRoot);
  await fs.symlink(publicRoot, publicAlias, 'dir');

  const recorder = createResearchLabDiagnosticRecorder({
    enabled: true,
    contentEnabled: true,
    nodeEnv: 'test',
    directory: path.join(publicAlias, 'diagnostics'),
    publicRoot
  });

  assert.equal(recorder.enabled, false);
  assert.match(recorder.configurationIssue, /private|outside the web root/i);
  await assert.rejects(fs.stat(path.join(publicRoot, 'diagnostics')), (error) => error.code === 'ENOENT');
});
