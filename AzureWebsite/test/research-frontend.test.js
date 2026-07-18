'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ASSISTANT_REQUEST_TIMEOUT_MS,
  AssistantRequestError,
  assistantFailureMessage,
  createRequestDeadline,
  readAssistantResponse,
  resultPresentation,
  validAssistantPayload,
  validCanonicalSource
} = require('../public/javascripts/research');

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; }
  };
}

test('assistant response reader preserves bounded public server errors', async () => {
  await assert.rejects(
    readAssistantResponse(mockResponse(503, JSON.stringify({
      error: { message: `  Public   message ${'x'.repeat(500)}` }
    }))),
    (error) => {
      assert.ok(error instanceof AssistantRequestError);
      assert.match(error.message, /^Public message/);
      assert.equal(error.message.length, 320);
      return true;
    }
  );
});

test('assistant response reader never exposes non-JSON upstream bodies', async () => {
  await assert.rejects(
    readAssistantResponse(mockResponse(502, '<html>private upstream failure</html>')),
    (error) => {
      assert.match(error.message, /temporarily unavailable/i);
      assert.doesNotMatch(error.message, /private upstream failure|html/i);
      return true;
    }
  );

  await assert.rejects(
    readAssistantResponse(mockResponse(200, 'not-json')),
    /temporarily unavailable/i
  );

  await assert.rejects(
    readAssistantResponse(mockResponse(429, 'rate limit gateway page')),
    /wait before asking another question/i
  );
});

test('assistant response reader accepts the existing answer protocol', async () => {
  const payload = {
    status: 'answered',
    guardrailMode: 'standard',
    answer: 'A grounded result. [1]',
    sources: [{ number: 1, title: 'Note', url: '/research/note#finding' }],
    followUps: ['What are the limitations?']
  };
  assert.deepEqual(
    await readAssistantResponse(mockResponse(200, JSON.stringify(payload))),
    payload
  );
});

test('assistant response protocol distinguishes missing evidence from a guardrail refusal', async () => {
  const noEvidence = {
    status: 'no_evidence',
    guardrailMode: 'standard',
    answer: 'Suitable passages were not found.',
    sources: [],
    followUps: []
  };
  const refusal = {
    status: 'guardrail_refusal',
    guardrailMode: 'standard',
    answer: 'Evidence was found, but the draft was withheld.',
    sources: [],
    followUps: []
  };

  assert.deepEqual(
    await readAssistantResponse(mockResponse(200, JSON.stringify(noEvidence))),
    noEvidence
  );
  assert.deepEqual(
    await readAssistantResponse(mockResponse(200, JSON.stringify(refusal))),
    refusal
  );

  assert.equal(resultPresentation(noEvidence, 0).label, 'Evidence not found');
  assert.match(resultPresentation(noEvidence, 0).grounding, /passages were not found/i);
  assert.equal(resultPresentation(refusal, 1).label, 'Answer withheld');
  assert.equal(
    resultPresentation(refusal, 1).grounding,
    'Relevant passages were found. Experimental mode can show a source-grounded version.'
  );
  assert.doesNotMatch(resultPresentation(refusal, 1).grounding, /draft|withheld/i);
});

test('assistant response protocol requires the server-selected guardrail mode', () => {
  assert.equal(validAssistantPayload({
    status: 'answered',
    answer: 'A grounded result. [1]',
    sources: [{ number: 1, title: 'Note', url: '/research/note#finding' }]
  }), false);
  assert.equal(validAssistantPayload({
    status: 'answered',
    guardrailMode: 'experimental',
    answer: 'A grounded result. [1]',
    sources: [{ number: 1, title: 'Note', url: '/research/note#finding' }]
  }), true);
});

test('assistant response protocol rejects guardrail refusals in experimental mode', () => {
  assert.equal(validAssistantPayload({
    status: 'guardrail_refusal',
    guardrailMode: 'experimental',
    answer: 'The answer was withheld.',
    sources: [],
    followUps: []
  }), false);
});

test('assistant response protocol rejects ungrounded answers and sources attached to terminal states', () => {
  assert.equal(validAssistantPayload({
    status: 'answered',
    guardrailMode: 'standard',
    answer: 'An unsupported answer.',
    sources: [],
    followUps: []
  }), false);
  assert.equal(validAssistantPayload({
    status: 'answered',
    guardrailMode: 'standard',
    answer: 'An answer with an external source. [1]',
    sources: [{ number: 1, title: 'Outside', url: 'https://example.com/note#finding' }],
    followUps: []
  }), false);
  assert.equal(validAssistantPayload({
    status: 'no_evidence',
    guardrailMode: 'standard',
    answer: 'Suitable passages were not found.',
    sources: [{ number: 1, title: 'Note', url: '/research/note#finding' }],
    followUps: []
  }), false);
  assert.equal(validAssistantPayload({
    status: 'guardrail_refusal',
    guardrailMode: 'standard',
    answer: 'The answer was withheld.',
    sources: [],
    followUps: ['Try again']
  }), false);
});

test('assistant response protocol enforces an exact citation-to-source mapping', () => {
  const sourceOne = { number: 1, title: 'First note', url: '/research/first-note#finding' };
  const sourceTwo = { number: 2, title: 'Second note', url: '/research/second-note#finding' };
  const answered = (answer, sources) => ({
    status: 'answered',
    guardrailMode: 'standard',
    answer,
    sources,
    followUps: []
  });

  assert.equal(validAssistantPayload(answered(
    'Supported by the library. [1]',
    [sourceOne, { number: 2, title: 'Outside', url: 'https://example.com/note#finding' }]
  )), false, 'rejects mixed canonical and external sources');
  assert.equal(validAssistantPayload(answered(
    'Supported by the library. [1]',
    [sourceOne, { ...sourceTwo, number: 1 }]
  )), false, 'rejects duplicate source numbers');
  assert.equal(validAssistantPayload(answered(
    'Supported by the library.',
    [sourceOne]
  )), false, 'rejects an answer without an exact citation');
  assert.equal(validAssistantPayload(answered(
    'Supported by the library. [2]',
    [sourceOne]
  )), false, 'rejects a citation without a matching source');
  assert.equal(validAssistantPayload(answered(
    'Supported by one passage. [1]',
    [sourceOne, sourceTwo]
  )), false, 'rejects a supplied source that is not cited');
  assert.equal(validAssistantPayload(answered(
    'Supported by the library. [source 1]',
    [sourceOne]
  )), false, 'rejects malformed numeric bracket tokens');
  assert.equal(validAssistantPayload(answered(
    'Supported by both passages. [1] [2]',
    [sourceOne, sourceTwo]
  )), true, 'accepts a complete canonical citation mapping');
});

test('assistant accepts only canonical in-library source anchors', () => {
  assert.equal(validCanonicalSource({
    number: 1,
    title: 'Note',
    url: '/research/note#finding'
  }), true);
  assert.equal(validCanonicalSource({
    number: 1,
    title: 'Outside',
    url: 'https://example.com/research/note#finding'
  }), false);
  assert.equal(validCanonicalSource({
    number: 1,
    title: 'Traversal',
    url: '/research/../admin#finding'
  }), false);
});

test('assistant deadline is bounded, abortable, and clearable', () => {
  let scheduled = null;
  let scheduledFor = null;
  let cleared = null;
  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  }

  const deadline = createRequestDeadline(ASSISTANT_REQUEST_TIMEOUT_MS, {
    AbortController: FakeAbortController,
    setTimeout(callback, timeout) {
      scheduled = callback;
      scheduledFor = timeout;
      return 42;
    },
    clearTimeout(timer) { cleared = timer; }
  });

  assert.equal(scheduledFor, 45000);
  assert.equal(deadline.signal.aborted, false);
  scheduled();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.didTimeOut(), true);
  assert.match(assistantFailureMessage(new Error('private timeout detail'), deadline), /took too long/i);
  deadline.clear();
  assert.equal(cleared, 42);
});

test('assistant maps network failures to a public retry message', () => {
  const deadline = { didTimeOut() { return false; } };
  const message = assistantFailureMessage(new TypeError('private socket detail'), deadline);
  assert.match(message, /could not be reached/i);
  assert.doesNotMatch(message, /private socket detail/);
});

test('assistant markup exposes busy state, live feedback, and retry controls', () => {
  const markup = fs.readFileSync(
    path.join(__dirname, '../views/research/_assistant.ejs'),
    'utf8'
  );
  assert.match(markup, /aria-busy="false"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /data-assistant-retry>Try again<\/button>/);
  assert.match(markup, /class="assistant-retry" type="button"/);
  assert.match(markup, /aria-controls="assistant-result-/);
  assert.match(markup, /<fieldset[\s\S]*data-assistant-guardrails/);
  assert.match(markup, /value="standard"[\s\S]*checked/);
  assert.match(markup, /value="experimental"/);
  assert.match(markup, /Evidence checks and citations stay required/);
  assert.match(markup, /data-assistant-result-mode/);
  assert.match(markup, /data-assistant-experimental-warning/);
});

test('assistant request sends the selected guardrail mode and labels from the response mode', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '../public/javascripts/research.js'),
    'utf8'
  );
  assert.match(script, /guardrailMode: selectedMode \? selectedMode\.value : 'standard'/);
  assert.match(script, /resultMode\.textContent = presentation\.modeLabel/);
  assert.match(script, /payload\.guardrailMode === 'experimental'/);
});
