'use strict';

const crypto = require('node:crypto');

class SubmissionAuthorizationError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'SubmissionAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

function requireAuthenticated(session) {
  if (!session || typeof session.accountId !== 'string' || !session.accountId) {
    throw new SubmissionAuthorizationError('authentication_required', 'Sign in is required.', 401);
  }
  return session;
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const leftDigest = crypto.createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function requireOwner(session, submission) {
  const authenticated = requireAuthenticated(session);
  if (!submission || !sameSecret(authenticated.accountId, submission.ownerId)) {
    // Do not reveal whether another user's submission exists.
    throw new SubmissionAuthorizationError('submission_not_found', 'Submission not found.', 404);
  }
  return submission;
}

function requireAdmin(session, configuredAdminGoogleSub) {
  const authenticated = requireAuthenticated(session);
  if (!sameSecret(authenticated.googleSub, configuredAdminGoogleSub)) {
    throw new SubmissionAuthorizationError('admin_required', 'Administrator access is required.', 403);
  }
  return authenticated;
}

module.exports = {
  SubmissionAuthorizationError,
  requireAdmin,
  requireAuthenticated,
  requireOwner,
  sameSecret
};
