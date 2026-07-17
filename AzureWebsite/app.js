var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var createResearchRouter = require('./routes/research');
var createResearchRepository = require('./services/research-repository').createResearchRepository;

function createApp(options) {
  var app = express();
  var researchRepository = options && options.researchRepository
    ? options.researchRepository
    : createResearchRepository();

  app.disable('x-powered-by');
  app.set('env', process.env.NODE_ENV === 'development' ? 'development' : 'production');

  // view engine setup
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  logger.token('safe-path', function(req) {
    return req.originalUrl.split('?')[0];
  });

  app.use(logger(':method :safe-path :status :response-time ms'));
  app.use(function(req, res, next) {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/icons', express.static(path.join(__dirname, 'node_modules/@phosphor-icons/web/src')));

  app.use('/', indexRouter);
  app.use('/research', createResearchRouter(researchRepository));

  // catch 404 and forward to error handler
  app.use(function(req, res, next) {
    next(createError(404));
  });

  // error handler
  app.use(function(err, req, res, next) {
    var status = err.status || 500;

    if (status >= 500) {
      console.error(err);
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
