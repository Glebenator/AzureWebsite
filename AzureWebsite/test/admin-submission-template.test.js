'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');

const views = path.resolve(__dirname, '..', 'views', 'admin', 'submissions');
const legacySubmission = {
  id: 'abcdefghijklmnopqrstuvwx',
  title: 'Rolling deployment submission',
  status: 'publishing',
  ownerLabel: 'account-1234567890',
  createdAt: '2026-08-04T12:00:00.000Z',
  updatedAt: '2026-08-04T12:01:00.000Z',
  previewHtml: '<p>Safe preview.</p>',
  rejectionReason: '',
  failureCode: '',
  slug: ''
};

function locals(extra = {}) {
  return {
    title: 'Research submissions',
    description: 'Private admin review.',
    user: { accountId: 'admin' },
    isAdmin: true,
    csrfToken: 'csrf-token',
    flash: '',
    error: '',
    ...extra
  };
}

test('admin queue tolerates a legacy view model during a rolling deployment', async () => {
  const html = await ejs.renderFile(
    path.join(views, 'index.ejs'),
    locals({ submissions: [legacySubmission] })
  );
  assert.match(html, /Rolling deployment submission/);
  assert.match(html, /Publishing/);
  assert.doesNotMatch(html, /undefined/);
});

test('admin detail falls back safely during a rolling deployment', async () => {
  const html = await ejs.renderFile(
    path.join(views, 'detail.ejs'),
    locals({ submission: legacySubmission })
  );
  assert.match(html, /Publishing public Markdown/);
  assert.match(html, /Retry public publication/);
  assert.doesNotMatch(html, /Cannot read properties|undefined/);
});

test('admin detail shows published availability separately from failed AI indexing', async () => {
  const html = await ejs.renderFile(
    path.join(views, 'detail.ejs'),
    locals({
      submission: {
        ...legacySubmission,
        status: 'published',
        slug: 'rolling-deployment-submission',
        publicationProgress: {
          active: false,
          aiLabel: 'AI indexing failed',
          aiState: 'failed',
          checkpoints: [],
          completed: 1,
          detail: 'Attempt 2',
          publicAvailable: true,
          publicationLabel: 'Published',
          requiresAction: true,
          summary: 'Published · AI indexing failed',
          total: 3
        }
      }
    })
  );
  assert.match(html, /Published/);
  assert.match(html, /AI indexing failed/);
  assert.match(html, /verified Markdown remains public and readable/);
  assert.match(html, /Retry AI indexing/);
  assert.doesNotMatch(html, /Not public/);
  assert.doesNotMatch(html, /data-publication-refresh|Status refreshes automatically/);
});
