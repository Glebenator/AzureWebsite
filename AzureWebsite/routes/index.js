var express = require('express');
var router = express.Router();
var portfolio = require('../data/portfolio');

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', {
    title: 'Gleb Gladyshevskiy — Software Developer',
    description: 'Portfolio of Gleb Gladyshevskiy, building practical AI, automation, backend, and hardware-adjacent software.',
    portfolio: portfolio
  });
});

module.exports = router;
