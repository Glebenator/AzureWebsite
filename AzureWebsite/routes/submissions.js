'use strict';

const crypto = require('node:crypto');
const express = require('express');
const {
  SubmissionAuthorizationError,
  requireAdmin,
  requireAuthenticated,
  requireOwner,
  sameSecret
} = require('../services/submission-authorization');
const {
  MultipartUploadError,
  parseMarkdownEditMultipart,
  parseMarkdownMultipart
} = require('../services/multipart-markdown');
const {
  SubmissionValidationError,
  createSanitizedPreview,
  normalizeSubmissionForPublication,
  validateMarkdownUpload
} = require('../services/submission-validation');
const { createPublicationProgress } = require('../services/submission-publication-progress');

const SESSION_COOKIE = 'research_session';
const LOGIN_COOKIE = 'research_login';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 1000;
const OWNER_EDITABLE_STATES = new Set(['pending', 'ready_for_review', 'rejected', 'failed']);
const OWNER_DELETABLE_STATES = new Set([
  'pending', 'ready_for_review', 'embedding_pending', 'embedding', 'publishing',
  'published', 'rejected', 'failed'
]);

function createLoginAttemptStore(options = {}) {
  const now = options.now || Date.now;
  const attempts = new Map();
  function sweep() {
    const current = now();
    for (const [key, value] of attempts) if (value.expiresAt <= current) attempts.delete(key);
  }
  return {
    issue(attempt) {
      sweep();
      if (attempts.size >= LOGIN_ATTEMPT_LIMIT) throw new Error('The sign-in service is busy.');
      const token = crypto.randomBytes(32).toString('base64url');
      attempts.set(crypto.createHash('sha256').update(token).digest('hex'), {
        ...attempt,
        expiresAt: Math.min(Number(attempt.expiresAt) || 0, now() + LOGIN_TTL_MS)
      });
      return token;
    },
    consume(token) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
      sweep();
      const key = crypto.createHash('sha256').update(token).digest('hex');
      const attempt = attempts.get(key) || null;
      attempts.delete(key);
      return attempt;
    }
  };
}

function requestIsSameOrigin(req) {
  const supplied = req.get('origin') || req.get('referer');
  if (!supplied) return false;
  try {
    const value = new URL(supplied);
    const expectedProtocol = `${req.protocol}:`;
    return value.protocol === expectedProtocol && value.host === req.get('host');
  } catch {
    return false;
  }
}

function statusMessage(value) {
  const messages = {
    created: 'Private preview created. Review it before submitting.',
    submitted: 'Submission sent for administrator review.',
    edited: 'Markdown changes saved and revalidated.',
    replaced: 'Pending Markdown replaced and revalidated.',
    deleted: 'Submission data was deleted.',
    published: 'Submission published. AI indexing continues separately in the background.',
    published_ai_ready: 'Submission published and AI indexing is ready.',
    rejected: 'Submission rejected with a reason.'
  };
  return messages[value] || '';
}

function publicError(error) {
  const status = Number(error?.status);
  if (error instanceof SubmissionAuthorizationError) return { status: error.status, message: error.message };
  if (error instanceof SubmissionValidationError || error instanceof MultipartUploadError) {
    return { status: error.status || 400, message: error.message };
  }
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, message: String(error.message || 'The request could not be completed.').slice(0, 500) };
  }
  return { status: 500, message: 'The request could not be completed. Please try again.' };
}

function ownerLabel(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId) return 'deleted-account';
  return `account-${crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 10)}`;
}

function createSubmissionsRouter(system = {}) {
  const router = express.Router();
  const enabled = system.enabled !== false;
  const repository = system.repository;
  const sessionStore = system.sessionStore;
  const csrf = system.csrf;
  const oidc = system.oidc;
  const quota = system.quota;
  const publication = system.publication;
  const publicationWorker = system.publicationWorker;
  const adminGoogleSub = system.adminGoogleSub || '';
  const loginAttempts = system.loginAttempts || createLoginAttemptStore(system);
  const production = Boolean(system.production);
  const sessionCookie = system.sessionCookieOptions || {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
    sameSite: 'lax',
    secure: production
  };
  const loginCookie = {
    httpOnly: true,
    maxAge: LOGIN_TTL_MS,
    path: '/auth/google',
    sameSite: 'lax',
    secure: production
  };

  router.use(['/research/submissions', '/admin/submissions', '/auth'], (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, private',
      'Pragma': 'no-cache',
      'Vary': 'Cookie'
    });
    const token = req.cookies?.[SESSION_COOKIE] || '';
    req.sessionToken = token;
    req.authSession = sessionStore?.get(token, { touch: true }) || null;
    if (production && req.app.get('trust proxy') && !req.secure) {
      return res.status(400).render('error', {
        title: 'Secure connection required',
        status: 400,
        heading: 'Secure connection required.',
        message: 'Research submissions require HTTPS.'
      });
    }
    next();
  });

  function isAdmin(req) {
    return Boolean(req.authSession && sameSecret(req.authSession.googleSub, adminGoogleSub));
  }

  function csrfToken(req) {
    return csrf.issue(req.sessionToken, { method: 'POST', path: '/' });
  }

  function common(req, extra = {}) {
    return {
      title: 'Research submissions — Gleb Gladyshevskiy',
      description: 'Private research submission review.',
      user: req.authSession,
      isAdmin: isAdmin(req),
      csrfToken: req.authSession ? csrfToken(req) : '',
      flash: statusMessage(req.query?.status),
      error: '',
      ...extra
    };
  }

  function requireUser(req) {
    return requireAuthenticated(req.authSession);
  }

  function verifyBrowserPost(req, token) {
    if (!requestIsSameOrigin(req)) {
      throw new SubmissionAuthorizationError('cross_origin_request', 'The form must be submitted from this site.', 403);
    }
    if (!csrf.verify(token, req.sessionToken, { method: 'POST', path: '/' })) {
      throw new SubmissionAuthorizationError('invalid_csrf', 'The form expired. Refresh and try again.', 403);
    }
  }

  async function ownedRecord(req, id) {
    const session = requireUser(req);
    return requireOwner(session, await repository.get(id));
  }

  function viewRecord(record, { admin = false, includeMarkdown = false } = {}) {
    const normalized = record.status === 'deleted' ? { title: 'Deleted submission' } : normalizeSubmissionForPublication(record);
    return {
      id: record.id,
      title: normalized.title,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      previewHtml: record.status === 'deleted' ? '' : createSanitizedPreview(record.markdown),
      publicationProgress: createPublicationProgress(record),
      rejectionReason: record.rejectionReason || '',
      failureCode: record.failureCode || '',
      indexingFailureCode: record.publication?.indexingFailureCode || '',
      slug: record.publishedSlug || '',
      ...(includeMarkdown ? { markdown: record.markdown } : {}),
      ...(admin ? { ownerLabel: ownerLabel(record.ownerId) } : {})
    };
  }

  function requireOwnerEditable(record) {
    if (!OWNER_EDITABLE_STATES.has(record.status)) {
      const error = new Error('This submission cannot be edited while it is being published or after publication.');
      error.status = 409;
      throw error;
    }
    return record;
  }

  function renderSignIn(req, res, status = 200, error = '') {
    return res.status(status).render('submissions/sign-in', common(req, {
      title: 'Sign in to submit research',
      description: 'Sign in with Google to submit private Markdown research for review.',
      error
    }));
  }

  if (!enabled || !repository || !sessionStore || !csrf || !oidc || !quota || !publication) {
    router.get('/research/submissions', (req, res) => renderSignIn(
      req,
      res,
      503,
      'Research submissions are not configured on this environment.'
    ));
    router.get('/auth/google', (req, res) => renderSignIn(
      req,
      res,
      503,
      'Google sign-in is not configured on this environment.'
    ));
    return router;
  }

  router.get('/auth/google', async (req, res) => {
    try {
      if (!oidc.isConfigured()) return renderSignIn(req, res, 503, 'Google sign-in is not configured.');
      const authorization = await oidc.begin();
      const token = loginAttempts.issue(authorization.attempt);
      res.cookie(LOGIN_COOKIE, token, loginCookie);
      return res.redirect(303, authorization.url);
    } catch {
      return renderSignIn(req, res, 503, 'Google sign-in is temporarily unavailable.');
    }
  });

  router.get('/auth/google/callback', async (req, res) => {
    const attempt = loginAttempts.consume(req.cookies?.[LOGIN_COOKIE]);
    res.clearCookie(LOGIN_COOKIE, { path: '/auth/google' });
    try {
      const identity = await oidc.complete(req, attempt);
      if (req.sessionToken) sessionStore.destroy(req.sessionToken);
      const token = sessionStore.issue({ accountId: identity.subject, googleSub: identity.subject });
      res.cookie(SESSION_COOKIE, token, sessionCookie);
      return res.redirect(303, '/research/submissions');
    } catch {
      return renderSignIn(req, res, 401, 'Google sign-in could not be verified. Please try again.');
    }
  });

  router.post('/auth/logout', (req, res) => {
    try {
      requireUser(req);
      verifyBrowserPost(req, req.body?._csrf);
      sessionStore.destroy(req.sessionToken);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return res.redirect(303, '/research');
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('submissions/sign-in', common(req, { error: failure.message }));
    }
  });

  router.get('/research/submissions', async (req, res, next) => {
    if (!req.authSession) return renderSignIn(req, res);
    try {
      const records = await repository.listByOwner(req.authSession.accountId);
      return res.render('submissions/index', common(req, {
        submissions: records.map((record) => viewRecord(record))
      }));
    } catch (error) { return next(error); }
  });

  router.get('/research/submissions/new', (req, res) => {
    try {
      requireUser(req);
      return res.render('submissions/upload', common(req, {
        title: 'Upload research Markdown'
      }));
    } catch { return renderSignIn(req, res, 401, 'Sign in to upload research.'); }
  });

  router.post('/research/submissions/preview', async (req, res) => {
    let parsed;
    try {
      requireUser(req);
      if (!requestIsSameOrigin(req)) throw new SubmissionAuthorizationError('cross_origin_request', 'The form must be submitted from this site.', 403);
      parsed = await parseMarkdownMultipart(req);
      verifyBrowserPost(req, parsed.csrfToken);
      const limit = quota({ accountId: req.authSession.accountId, ip: req.ip });
      if (!limit.allowed) {
        const error = new Error(`Upload limit reached. Try again in ${limit.retryAfterSeconds} seconds.`);
        error.status = 429;
        throw error;
      }
      const validated = validateMarkdownUpload(parsed.file);
      const record = await repository.create({
        ownerId: req.authSession.accountId,
        markdown: validated.markdown,
        metadata: validated.metadata,
        status: 'pending'
      });
      return res.redirect(303, `/research/submissions/${record.id}/review?status=created`);
    } catch (error) {
      const failure = publicError(error);
      if (failure.status >= 500) return res.status(failure.status).render('error', {
        title: 'Something went wrong', status: failure.status, heading: 'The upload failed.', message: failure.message
      });
      return res.status(failure.status).render('submissions/upload', common(req, {
        title: 'Upload research Markdown', error: failure.message
      }));
    }
  });

  router.get('/research/submissions/:id/review', async (req, res) => {
    try {
      const record = await ownedRecord(req, req.params.id);
      if (record.status !== 'pending') return res.redirect(303, `/research/submissions/${record.id}`);
      return res.render('submissions/review', common(req, {
        title: 'Review research submission',
        submission: viewRecord(record)
      }));
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Submission unavailable', status: failure.status, heading: 'Submission unavailable.', message: failure.message
      });
    }
  });

  async function submitPending(req, res) {
    try {
      verifyBrowserPost(req, req.body?._csrf);
      const record = await ownedRecord(req, req.params.id || req.body?.draftId);
      await repository.transition(record.id, 'ready_for_review');
      return res.redirect(303, `/research/submissions/${record.id}?status=submitted`);
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Submission not sent', status: failure.status, heading: 'Submission not sent.', message: failure.message
      });
    }
  }
  router.post('/research/submissions', submitPending);
  router.post('/research/submissions/:id/submit', submitPending);

  router.get('/research/submissions/:id/edit', async (req, res) => {
    try {
      const record = requireOwnerEditable(await ownedRecord(req, req.params.id));
      return res.render('submissions/edit', common(req, {
        title: 'Edit research Markdown',
        submission: viewRecord(record, { includeMarkdown: true })
      }));
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Editing unavailable', status: failure.status, heading: 'Editing unavailable.', message: failure.message
      });
    }
  });

  router.post('/research/submissions/:id/edit', async (req, res) => {
    try {
      requireUser(req);
      if (!requestIsSameOrigin(req)) throw new SubmissionAuthorizationError('cross_origin_request', 'The form must be submitted from this site.', 403);
      const parsed = await parseMarkdownEditMultipart(req);
      verifyBrowserPost(req, parsed.csrfToken);
      const current = requireOwnerEditable(await ownedRecord(req, req.params.id));
      const limit = quota({ accountId: req.authSession.accountId, ip: req.ip });
      if (!limit.allowed) {
        const error = new Error(`Edit limit reached. Try again in ${limit.retryAfterSeconds} seconds.`);
        error.status = 429;
        throw error;
      }
      const validated = validateMarkdownUpload({
        filename: 'submission.md',
        bytes: Buffer.from(parsed.markdown, 'utf8')
      });
      await repository.replace(current.id, req.authSession.accountId, {
        markdown: validated.markdown,
        metadata: validated.metadata
      });
      return res.redirect(303, `/research/submissions/${current.id}/review?status=edited`);
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Edit failed', status: failure.status, heading: 'Edit failed.', message: failure.message
      });
    }
  });

  router.get('/research/submissions/:id/replace', async (req, res) => {
    try {
      const record = requireOwnerEditable(await ownedRecord(req, req.params.id));
      return res.render('submissions/replace', common(req, {
        title: 'Replace pending research', submission: viewRecord(record)
      }));
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Replacement unavailable', status: failure.status, heading: 'Replacement unavailable.', message: failure.message
      });
    }
  });

  router.post('/research/submissions/:id/replace', async (req, res) => {
    try {
      requireUser(req);
      if (!requestIsSameOrigin(req)) throw new SubmissionAuthorizationError('cross_origin_request', 'The form must be submitted from this site.', 403);
      const parsed = await parseMarkdownMultipart(req);
      verifyBrowserPost(req, parsed.csrfToken);
      const current = requireOwnerEditable(await ownedRecord(req, req.params.id));
      const limit = quota({ accountId: req.authSession.accountId, ip: req.ip });
      if (!limit.allowed) {
        const error = new Error(`Upload limit reached. Try again in ${limit.retryAfterSeconds} seconds.`); error.status = 429; throw error;
      }
      const validated = validateMarkdownUpload(parsed.file);
      await repository.replace(current.id, req.authSession.accountId, {
        markdown: validated.markdown, metadata: validated.metadata
      });
      return res.redirect(303, `/research/submissions/${current.id}/review?status=replaced`);
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Replacement failed', status: failure.status, heading: 'Replacement failed.', message: failure.message
      });
    }
  });

  router.post('/research/submissions/:id/delete', async (req, res) => {
    try {
      verifyBrowserPost(req, req.body?._csrf);
      const record = await ownedRecord(req, req.params.id);
      if (!OWNER_DELETABLE_STATES.has(record.status)) {
        const error = new Error('A submission cannot be deleted while publication is in progress.');
        error.status = 409;
        throw error;
      }
      await publication.remove(record.id);
      if (record.status === 'published' && typeof system.onCorpusChanged === 'function') {
        system.onCorpusChanged();
      }
      return res.redirect(303, '/research/submissions?status=deleted');
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Deletion failed', status: failure.status, heading: 'Deletion failed.', message: failure.message
      });
    }
  });

  router.get('/research/submissions/:id/status', async (req, res) => {
    try {
      const record = await ownedRecord(req, req.params.id);
      return res.json({
        progress: createPublicationProgress(record),
        status: record.status,
        publicationStatus: record.publication?.status || 'private',
        indexingStatus: record.publication?.indexingStatus || 'not_started',
        updatedAt: record.updatedAt
      });
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).json({ error: { message: failure.message } });
    }
  });

  router.get('/research/submissions/:id', async (req, res) => {
    try {
      const record = await ownedRecord(req, req.params.id);
      return res.render('submissions/detail', common(req, {
        title: 'Research submission status', submission: viewRecord(record)
      }));
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Submission unavailable', status: failure.status, heading: 'Submission unavailable.', message: failure.message
      });
    }
  });

  function requireSoleAdmin(req) {
    return requireAdmin(req.authSession, adminGoogleSub);
  }

  router.get('/admin/submissions', async (req, res) => {
    try {
      requireSoleAdmin(req);
      const records = await repository.listAll();
      return res.render('admin/submissions/index', common(req, {
        title: 'Research submission queue', submissions: records.map((record) => viewRecord(record, { admin: true }))
      }));
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Administrator access required', status: failure.status, heading: 'Administrator access required.', message: failure.message
      });
    }
  });

  router.get('/admin/submissions/:id', async (req, res) => {
    try {
      requireSoleAdmin(req);
      const record = await repository.get(req.params.id);
      if (!record) { const error = new Error('Submission not found.'); error.status = 404; throw error; }
      return res.render('admin/submissions/detail', common(req, {
        title: 'Review research submission', submission: viewRecord(record, { admin: true })
      }));
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Submission unavailable', status: failure.status, heading: 'Submission unavailable.', message: failure.message
      });
    }
  });

  router.get('/admin/submissions/:id/status', async (req, res) => {
    try {
      requireSoleAdmin(req);
      const record = await repository.get(req.params.id);
      if (!record) { const error = new Error('Submission not found.'); error.status = 404; throw error; }
      return res.json({
        progress: createPublicationProgress(record),
        status: record.status,
        publicationStatus: record.publication?.status || 'private',
        indexingStatus: record.publication?.indexingStatus || 'not_started',
        updatedAt: record.updatedAt
      });
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).json({ error: { message: failure.message } });
    }
  });

  async function adminAction(req, res, action) {
    try {
      requireSoleAdmin(req);
      verifyBrowserPost(req, req.body?._csrf);
      await action();
      if (typeof system.onCorpusChanged === 'function' && req.path.endsWith('/delete')) {
        system.onCorpusChanged();
      }
      const result = req.path.endsWith('/reject') ? 'rejected' : 'deleted';
      return res.redirect(303, `/admin/submissions${result === 'deleted' ? '' : `/${req.params.id}`}?status=${result}`);
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Administrator action failed', status: failure.status, heading: 'Administrator action failed.', message: failure.message
      });
    }
  }

  router.post('/admin/submissions/:id/publish', async (req, res) => {
    try {
      requireSoleAdmin(req);
      verifyBrowserPost(req, req.body?._csrf);
      const result = publicationWorker
        ? await publicationWorker.enqueue(req.params.id)
        : await publication.publish(req.params.id);
      if (result?.activated && !publicationWorker && typeof system.onCorpusChanged === 'function') {
        await system.onCorpusChanged();
      }
      const status = result?.indexingStatus === 'ready' ? 'published_ai_ready' : 'published';
      return res.redirect(303, `/admin/submissions/${req.params.id}?status=${status}`);
    } catch (error) {
      const failure = publicError(error);
      return res.status(failure.status).render('error', {
        title: 'Administrator action failed', status: failure.status, heading: 'Administrator action failed.', message: failure.message
      });
    }
  });
  router.post('/admin/submissions/:id/reject', (req, res) => adminAction(req, res, () => publication.reject(req.params.id, req.body?.reason)));
  router.post('/admin/submissions/:id/delete', (req, res) => adminAction(req, res, () => publication.remove(req.params.id)));

  return router;
}

module.exports = {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  createLoginAttemptStore,
  createSubmissionsRouter,
  requestIsSameOrigin
};
