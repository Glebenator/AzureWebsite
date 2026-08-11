'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'javascripts', 'submission-publication-status.js'),
  'utf8'
);

async function runPoll(progress) {
  const timers = [];
  let reloads = 0;
  const region = {
    getAttribute(name) {
      if (name === 'data-publication-state') return 'published:failed';
      if (name === 'data-publication-status-url') return '/status';
      return null;
    },
    querySelector() { return null; }
  };
  const window = {
    fetch: async () => ({
      ok: true,
      async json() { return { status: 'published', indexingStatus: 'failed', progress }; }
    }),
    location: { reload() { reloads += 1; } },
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); }
  };
  vm.runInNewContext(source, {
    document: { querySelectorAll() { return [region]; } },
    window
  });
  assert.equal(timers.length, 1);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { reloads, timers };
}

test('publication status polling stops when a terminal state remains unchanged', async () => {
  const result = await runPoll({ active: false, summary: 'Published · AI indexing failed' });
  assert.equal(result.reloads, 0);
  assert.equal(result.timers.length, 1);
});

test('publication status polling continues while background indexing is active', async () => {
  const result = await runPoll({ active: true, summary: 'Published · Embeddings pending' });
  assert.equal(result.reloads, 0);
  assert.equal(result.timers.length, 2);
  assert.equal(result.timers[1].milliseconds, 5000);
});
