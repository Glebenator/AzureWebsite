'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sectionChunks,
  synchronizeIndex
} = require('../scripts/index-research');

const ENDPOINT = 'https://example.search.windows.net';
const INDEX_NAME = 'research-chunks-v1';

function successfulResults(actions) {
  return {
    value: actions.map((action) => ({
      key: action.id,
      status: true,
      statusCode: action['@search.action'] === 'delete' ? 200 : 201
    }))
  };
}

function requestBody(options) {
  return options.body ? JSON.parse(options.body) : null;
}

test('sectionChunks bounds oversized paragraphs and preserves bounded overlap', () => {
  const chunks = sectionChunks('x'.repeat(5000));

  assert.ok(chunks.length > 1);
  chunks.forEach((chunk) => assert.ok(chunk.length <= 2600));
  assert.equal(chunks[0].slice(-320), chunks[1].slice(0, 320));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [2600, 2600, 440]);
});

test('sectionChunks prefers paragraph boundaries in the final forty percent', () => {
  const firstParagraph = 'a'.repeat(1800);
  const secondParagraph = 'b'.repeat(1200);
  const chunks = sectionChunks(`${firstParagraph}\n\n${secondParagraph}`);

  assert.equal(chunks[0], firstParagraph);
  assert.ok(chunks.every((chunk) => chunk.length <= 2600));
  assert.ok(chunks[1].startsWith('a'.repeat(318)) || chunks[1].startsWith('b'));
});

test('sectionChunks keeps mixed Markdown bounded while retaining content', () => {
  const markdown = [
    '**Finding:** ' + 'Evidence sentence. '.repeat(180),
    '`measured outcome` ' + 'supporting detail '.repeat(180),
    '- final limitation marker'
  ].join('\n\n');
  const chunks = sectionChunks(markdown);

  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 2600));
  assert.match(chunks.join('\n'), /\*\*Finding:\*\*/);
  assert.match(chunks.join('\n'), /`measured outcome`/);
  assert.match(chunks.join('\n'), /final limitation marker/);
});

test('synchronizeIndex pages through all IDs before applying stale deletes', async () => {
  const calls = [];
  const desired = { id: 'keep', content: 'current' };
  const firstPage = [desired, ...Array.from({ length: 999 }, (_, index) => ({ id: `stale-${index}` }))];
  const secondPage = [{ id: 'stale-1000' }];
  const request = async (_credential, _endpoint, path, options) => {
    calls.push({ path, body: requestBody(options) });
    if (!path.includes('/docs/')) return {};
    if (path.includes('/docs/search')) {
      return options.body.includes('"skip":1000') ? { value: secondPage } : { value: firstPage };
    }
    return successfulResults(requestBody(options).value);
  };

  const result = await synchronizeIndex({}, ENDPOINT, INDEX_NAME, [desired], { request, sleep: async () => {} });
  const searches = calls.filter((call) => call.path.includes('/docs/search'));
  const mutations = calls.filter((call) => call.path.includes('/docs/index'));
  const mutatedActions = mutations.flatMap((call) => call.body.value);

  assert.deepEqual(searches.map((call) => call.body.skip), [0, 1000]);
  assert.equal(calls.findIndex((call) => call.path.includes('/docs/index')) > calls.findLastIndex((call) => call.path.includes('/docs/search')), true);
  assert.equal(mutatedActions.filter((action) => action['@search.action'] === 'delete').length, 1000);
  assert.equal(mutatedActions.some((action) => action.id === 'stale-1000'), true);
  assert.deepEqual(result, { deleted: 1000, uploaded: 1 });
});

test('synchronizeIndex retries only transiently failed actions and reports actual successes', async () => {
  const actionCalls = [];
  const delays = [];
  let attempt = 0;
  const documents = [
    { id: 'first', content: 'one' },
    { id: 'second', content: 'two' }
  ];
  const request = async (_credential, _endpoint, path, options) => {
    if (!path.includes('/docs/')) return {};
    if (path.includes('/docs/search')) return { value: [{ id: 'stale' }] };
    const actions = requestBody(options).value;
    actionCalls.push(actions.map((action) => action.id));
    attempt += 1;
    if (attempt === 1) {
      return {
        value: actions.map((action) => action.id === 'second'
          ? { key: action.id, status: false, statusCode: 503, errorMessage: 'try later' }
          : { key: action.id, status: true, statusCode: 200 })
      };
    }
    return successfulResults(actions);
  };

  const result = await synchronizeIndex({}, ENDPOINT, INDEX_NAME, documents, {
    request,
    sleep: async (delay) => delays.push(delay)
  });

  assert.deepEqual(actionCalls, [['stale', 'first', 'second'], ['second']]);
  assert.deepEqual(delays, [250]);
  assert.deepEqual(result, { deleted: 1, uploaded: 2 });
});

test('synchronizeIndex fails immediately for permanent per-document failures', async () => {
  let indexingCalls = 0;
  const request = async (_credential, _endpoint, path, options) => {
    if (!path.includes('/docs/')) return {};
    if (path.includes('/docs/search')) return { value: [] };
    indexingCalls += 1;
    const [action] = requestBody(options).value;
    return {
      value: [{ key: action.id, status: false, statusCode: 400, errorMessage: 'invalid field' }]
    };
  };

  await assert.rejects(
    synchronizeIndex({}, ENDPOINT, INDEX_NAME, [{ id: 'bad' }], { request, sleep: async () => {} }),
    /bad \(400: invalid field\)/
  );
  assert.equal(indexingCalls, 1);
});

test('synchronizeIndex fails after exhausting all transient retries', async () => {
  const delays = [];
  let indexingCalls = 0;
  const request = async (_credential, _endpoint, path, options) => {
    if (!path.includes('/docs/')) return {};
    if (path.includes('/docs/search')) return { value: [] };
    indexingCalls += 1;
    const [action] = requestBody(options).value;
    return {
      value: [{ key: action.id, status: false, statusCode: 429, errorMessage: 'throttled' }]
    };
  };

  await assert.rejects(
    synchronizeIndex({}, ENDPOINT, INDEX_NAME, [{ id: 'throttled' }], {
      request,
      sleep: async (delay) => delays.push(delay)
    }),
    /throttled \(429: throttled\)/
  );
  assert.equal(indexingCalls, 4);
  assert.deepEqual(delays, [250, 500, 1000]);
});
