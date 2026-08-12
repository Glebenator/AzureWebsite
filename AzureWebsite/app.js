var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var createResearchRouter = require('./routes/research');
var createResearchLabRouter = require('./routes/research-lab').createResearchLabRouter;
var createSubmissionsRouter = require('./routes/submissions').createSubmissionsRouter;
var createDeepResearchHarness = require('./services/deep-research-harness').createDeepResearchHarness;
var createResearchRepository = require('./services/research-repository').createResearchRepository;
var createResearchAssistant = require('./services/research-assistant').createResearchAssistant;
var createAzureResearchProvider = require('./services/azure-research-provider').createAzureResearchProvider;
var createSubmissionSystem = require('./services/submission-system').createSubmissionSystem;

function safeLogPath(req) {
  var pathname = String(req.originalUrl || '').split('?')[0];
  return pathname.replace(
    /^(\/(?:research|admin)\/submissions\/)[A-Za-z0-9_-]{20,128}(?=\/|$)/,
    '$1:submission'
  );
}

function createApp(options) {
  var app = express();
  var submissionSystem = options && Object.prototype.hasOwnProperty.call(options, 'submissionSystem')
    ? options.submissionSystem
    : createSubmissionSystem();
  var researchRepository = options && options.researchRepository
    ? options.researchRepository
    : createResearchRepository({
        publicationVisibility: submissionSystem && submissionSystem.publicationVisibility,
        assistantEvidenceVisibility: submissionSystem && submissionSystem.aiVisibility
      });
  var researchAssistant;
  if (options && options.researchAssistant) {
    researchAssistant = options.researchAssistant;
  } else {
    var researchProvider = options && Object.prototype.hasOwnProperty.call(options, 'researchProvider')
      ? options.researchProvider
      : createAzureResearchProvider();
    researchAssistant = createResearchAssistant({ provider: researchProvider });
  }
  var deepResearchHarness = options && Object.prototype.hasOwnProperty.call(options, 'deepResearchHarness')
    ? options.deepResearchHarness
    : createDeepResearchHarness();

  app.disable('x-powered-by');
  app.set('env', process.env.NODE_ENV === 'development' ? 'development' : 'production');
  if (process.env.WEBSITE_SITE_NAME) app.set('trust proxy', 1);

  // view engine setup
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  logger.token('safe-path', safeLogPath);

  app.use(logger(':method :safe-path :status :response-time ms'));
  app.use(function(req, res, next) {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    if (req.secure && app.get('env') === 'production') {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use('/research-lab', createResearchLabRouter(deepResearchHarness, {
    telemetryWrite: options && options.researchLabTelemetryWrite
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/icons', express.static(path.join(__dirname, 'node_modules/@phosphor-icons/web/src')));

  app.use('/', indexRouter);
  if (submissionSystem && submissionSystem.enabled && typeof submissionSystem.onCorpusChanged !== 'function') {
    submissionSystem.onCorpusChanged = function() { researchRepository.clearCache(); };
  }
  if (submissionSystem && submissionSystem.publicationWorker) {
    submissionSystem.publicationWorker.start().catch(function() {
      console.error(JSON.stringify({ event: 'submission_publication_recovery', status: 'failed' }));
    });
  }
  app.use('/', createSubmissionsRouter(submissionSystem));
  app.use('/research', createResearchRouter(researchRepository, researchAssistant, {
    submissionsEnabled: Boolean(submissionSystem && submissionSystem.enabled)
  }));

  // catch 404 and forward to error handler
  app.use(function(req, res, next) {
    next(createError(404));
  });

  // error handler
  app.use(function(err, req, res, next) {
    var status = Number.isInteger(err && err.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : 500;

    if (status >= 500) {
      console.error(JSON.stringify({
        event: 'http_request_error',
        category: 'internal',
        status: status
      }));
    }

    res.status(status);
    res.render('error', {
      title: status === 404 ? 'Page not found' : 'Something went wrong',
      status: status,
      heading: status === 404 ? 'This page is off the map.' : 'The signal dropped.',
      message: status === 404
        ? 'The page you requested does not exist.'
        : 'Please try again in a moment.'
    });
  });

  return app;
}

var app = createApp();

module.exports = app;
module.exports.createApp = createApp;
module.exports.safeLogPath = safeLogPath;
