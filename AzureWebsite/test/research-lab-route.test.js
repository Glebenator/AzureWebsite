'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const { DeepResearchHarnessError } = require('../services/deep-research-harness');

async function withServer(application, run) {
  const server = application.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    await run(`http://${host}:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function unavailableHarness() {
  return {
    model: 'openrouter/free',
    isAvailable: () => false,
    configurationIssue: () => 'OPENROUTER_API_KEY is not configured.'
  };
}

test('experimental page is clearly labelled and renders missing-key state', async () => {
  const application = app.createApp({ deepResearchHarness: unavailableHarness() });
  await withServer(application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research-lab`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Experimental · bounded/);
    assert.match(html, /OpenRouter credential is not configured/);
    assert.match(html, /data-available="false"/);
    assert.match(html, /Every request is independent/);
    assert.match(html, /data-evidence-drawer/);
    assert.match(html, /data-lab-activity/);
    assert.match(html, /data-run-details/);
    assert.match(html, /data-model-select/);
    assert.doesNotMatch(html, /RUN TRACE/i);
    assert.match(response.headers.get('cache-control'), /no-store/);
  });
});

test('run route streams traceable NDJSON and forwards the selected stateless mode and free model', async () => {
  let receivedMode;
  let receivedModel;
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async run(request) {
      receivedMode = request.mode;
      receivedModel = request.model;
      request.emit({ type: 'progress', stage: 'search', status: 'running', detail: 'Searching.' });
      request.emit({
        type: 'evidence',
        items: [{ number: 1, title: 'Source', url: 'https://en.wikipedia.org/wiki/Source', excerpt: 'Evidence.' }]
      });
      request.emit({
        type: 'result',
        answer: 'Supported [1].',
        citations: [{ number: 1, title: 'Source', url: 'https://en.wikipedia.org/wiki/Source', excerpt: 'Evidence.' }]
      });
    }
  };
  const application = app.createApp({ deepResearchHarness: harness });
  await withServer(application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ query: 'A bounded question', mode: 'research', model: 'example/current:free' })
    });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const requestId = response.headers.get('x-request-id');
    const runId = response.headers.get('x-research-run-id');
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.match(runId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(events.map((event) => event.type), ['progress', 'evidence', 'result', 'done']);
    assert.ok(events.every((event) => event.requestId === requestId && event.runId === runId));
    assert.equal(receivedMode, 'research');
    assert.equal(receivedModel, 'example/current:free');
  });
});

test('models route returns only the injected free catalog and selected default', async () => {
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async listFreeModels() {
      return [
        { id: 'openrouter/free', name: 'Free Models Router', contextLength: 200000 },
        { id: 'example/current:free', name: 'Current Free', contextLength: 65536 }
      ];
    }
  };
  const application = app.createApp({ deepResearchHarness: harness });
  await withServer(application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research-lab/models`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.defaultModel, 'openrouter/free');
    assert.deepEqual(payload.models.map((item) => item.id), [
      'openrouter/free',
      'example/current:free'
    ]);
    assert.match(response.headers.get('cache-control'), /no-store/);
  });
});

test('run route rejects an unknown response mode before starting the harness', async () => {
  let starts = 0;
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async run() { starts += 1; }
  };
  const application = app.createApp({ deepResearchHarness: harness });
  await withServer(application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'A bounded question', mode: 'conversation-history' })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'invalid_mode');
    assert.equal(payload.requestId, response.headers.get('x-request-id'));
    assert.equal(payload.runId, response.headers.get('x-research-run-id'));
    assert.equal(starts, 0);
  });
});

test('malformed and oversized JSON receive correlation without logging request content', async () => {
  const telemetry = [];
  const sentinel = 'PRIVATE_BODY_SENTINEL';
  const application = app.createApp({
    deepResearchHarness: unavailableHarness(),
    researchLabTelemetryWrite: (line) => telemetry.push(JSON.parse(line))
  });
  await withServer(application, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"query":"${sentinel}"`
    });
    const malformedPayload = await malformed.json();
    assert.equal(malformed.status, 400);
    assert.equal(malformedPayload.error.code, 'invalid_json');
    assert.equal(malformedPayload.requestId, malformed.headers.get('x-request-id'));
    assert.equal(malformedPayload.runId, malformed.headers.get('x-research-run-id'));

    const oversized = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sentinel.repeat(200) })
    });
    const oversizedPayload = await oversized.json();
    assert.equal(oversized.status, 413);
    assert.equal(oversizedPayload.error.code, 'request_body_too_large');
    assert.equal(oversizedPayload.requestId, oversized.headers.get('x-request-id'));
    assert.equal(oversizedPayload.runId, oversized.headers.get('x-research-run-id'));
  });

  assert.equal(telemetry.filter((event) => event.stage === 'request' && event.status === 'started').length, 2);
  assert.deepEqual(
    telemetry.filter((event) => event.stage === 'request' && event.status === 'failed')
      .map((event) => event.httpStatusClass),
    ['4xx', '4xx']
  );
  assert.doesNotMatch(JSON.stringify(telemetry), new RegExp(sentinel));
});

test('run route overwrites spoofed IDs and keeps telemetry free of request content and secrets', async () => {
  const sentinelQuery = 'PRIVATE_QUERY_SENTINEL';
  const sentinelSecret = 'PRIVATE_SECRET_SENTINEL';
  const telemetry = [];
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async run(request) {
      request.observe({
        stage: 'model_response',
        status: 'completed',
        responseLength: 20,
        answer: sentinelQuery,
        Authorization: `Bearer ${sentinelSecret}`,
        Cookie: sentinelSecret,
        modelUsed: 'example/current:free'
      });
      request.emit({
        type: 'result',
        requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        answer: 'Public answer.'
      });
    }
  };
  const application = app.createApp({
    deepResearchHarness: harness,
    researchLabTelemetryWrite: (line) => telemetry.push(line)
  });
  await withServer(application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sentinelSecret },
      body: JSON.stringify({ query: sentinelQuery, mode: 'research' })
    });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    const requestId = response.headers.get('x-request-id');
    const runId = response.headers.get('x-research-run-id');
    assert.ok(events.every((event) => event.requestId === requestId && event.runId === runId));
    const serializedTelemetry = telemetry.join('\n');
    assert.doesNotMatch(serializedTelemetry, new RegExp(sentinelQuery));
    assert.doesNotMatch(serializedTelemetry, new RegExp(sentinelSecret));
    assert.doesNotMatch(serializedTelemetry, /Authorization|Cookie|answer/);
  });
});

test('streamed failures report the actual HTTP status class and a separate logical failure category', async () => {
  const telemetry = [];
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async run() {
      throw new DeepResearchHarnessError('model_timeout', 'private upstream detail', 504);
    }
  };
  const application = app.createApp({
    deepResearchHarness: harness,
    researchLabTelemetryWrite: (line) => telemetry.push(JSON.parse(line))
  });
  await withServer(application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'A bounded question', mode: 'research' })
    });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(response.status, 200);
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).error.status, 504);
  });

  const streamingFailure = telemetry.find((event) => event.stage === 'streaming' && event.status === 'failed');
  const requestFailure = telemetry.find((event) => event.stage === 'request' && event.status === 'failed');
  assert.equal(streamingFailure.httpStatusClass, '2xx');
  assert.equal(streamingFailure.failureCategory, 'timeout');
  assert.equal(requestFailure.httpStatusClass, '2xx');
  assert.equal(requestFailure.failureCategory, 'timeout');
  assert.doesNotMatch(JSON.stringify(telemetry), /private upstream detail/);
});

test('run gate binds the active lease to one run and releases it for a later run', async () => {
  let releaseFirst;
  let starts = 0;
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async run(request) {
      starts += 1;
      if (starts === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      request.emit({ type: 'result', answer: 'Completed.' });
    }
  };
  const application = app.createApp({ deepResearchHarness: harness });
  await withServer(application, async (baseUrl) => {
    const firstPromise = fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'First bounded question', mode: 'research' })
    });
    while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));

    const second = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Second bounded question', mode: 'research' })
    });
    assert.equal(second.status, 429);
    const secondPayload = await second.json();
    assert.equal(secondPayload.error.code, 'research_harness_busy');
    assert.equal(secondPayload.runId, second.headers.get('x-research-run-id'));

    releaseFirst();
    const first = await firstPromise;
    await first.text();
    const third = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Third bounded question', mode: 'research' })
    });
    assert.equal(third.status, 200);
    await third.text();
    assert.equal(starts, 2);
  });
});

test('run route rejects paid or stale model selection before streaming', async () => {
  let starts = 0;
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async resolveRequestedModel(model) {
      if (model === 'example/stale:free') {
        throw new DeepResearchHarnessError(
          'free_model_unavailable',
          'That free OpenRouter model is no longer available. Reload the model list and choose another.',
          400
        );
      }
      return model;
    },
    async run() { starts += 1; }
  };
  const application = app.createApp({ deepResearchHarness: harness });
  await withServer(application, async (baseUrl) => {
    const paid = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'A bounded question', model: 'example/paid' })
    });
    assert.equal(paid.status, 400);
    assert.equal((await paid.json()).error.code, 'invalid_model');

    const stale = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'A bounded question', model: 'example/stale:free' })
    });
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).error.code, 'free_model_unavailable');
    assert.equal(starts, 0);
  });
});

test('run route rejects missing configuration and cross-origin requests before streaming', async () => {
  const application = app.createApp({ deepResearchHarness: unavailableHarness() });
  await withServer(application, async (baseUrl) => {
    const unavailable = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'A bounded question' })
    });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, 'research_harness_unavailable');

    const rejected = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({ query: 'A bounded question' })
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'origin_rejected');
  });
});

test('run route bounds each client to five starts per minute', async () => {
  const harness = {
    model: 'openrouter/free',
    isAvailable: () => true,
    configurationIssue: () => null,
    async run(request) {
      request.emit({ type: 'result', answer: 'Supported [1].', citations: [] });
    }
  };
  const application = app.createApp({ deepResearchHarness: harness });
  await withServer(application, async (baseUrl) => {
    for (let count = 0; count < 5; count += 1) {
      const accepted = await fetch(`${baseUrl}/research-lab/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'A bounded question' })
      });
      assert.equal(accepted.status, 200);
      await accepted.text();
    }

    const limited = await fetch(`${baseUrl}/research-lab/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'A bounded question' })
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'research_harness_rate_limited');
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
  });
});
