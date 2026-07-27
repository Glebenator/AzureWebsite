'use strict';

const SUBMISSION_STATES = Object.freeze([
  'pending',
  'ready_for_review',
  'publishing',
  'published',
  'rejected',
  'failed',
  'deleted'
]);

const TRANSITIONS = new Map([
  ['pending', new Set(['ready_for_review', 'deleted'])],
  ['ready_for_review', new Set(['publishing', 'rejected', 'deleted'])],
  ['publishing', new Set(['published', 'failed'])],
  ['published', new Set(['deleted'])],
  ['rejected', new Set(['deleted'])],
  ['failed', new Set(['publishing', 'rejected', 'deleted'])],
  ['deleted', new Set()]
]);

class SubmissionStateError extends Error {
  constructor(from, to) {
    super(`Submission cannot transition from ${from} to ${to}.`);
    this.name = 'SubmissionStateError';
    this.code = 'invalid_state_transition';
    this.status = 409;
  }
}

function assertSubmissionState(state) {
  if (!TRANSITIONS.has(state)) throw new TypeError('Unknown submission state.');
  return state;
}

function canTransition(from, to) {
  return TRANSITIONS.has(from) && TRANSITIONS.get(from).has(to);
}

function assertTransition(from, to) {
  assertSubmissionState(from);
  assertSubmissionState(to);
  if (!canTransition(from, to)) throw new SubmissionStateError(from, to);
  return true;
}

module.exports = {
  SUBMISSION_STATES,
  SubmissionStateError,
  assertSubmissionState,
  assertTransition,
  canTransition
};
