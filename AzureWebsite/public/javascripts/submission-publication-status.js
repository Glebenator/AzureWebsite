'use strict';

(function() {
  var regions = Array.prototype.slice.call(document.querySelectorAll('[data-publication-refresh]'));
  if (!regions.length) return;

  function updateRegion(region, payload) {
    var progress = payload && payload.progress;
    if (!progress) return;
    var summary = region.querySelector('[data-publication-summary]');
    var detail = region.querySelector('[data-publication-detail]');
    var meter = region.querySelector('[data-publication-meter]');
    if (summary) summary.textContent = progress.summary || '';
    if (detail) detail.textContent = progress.detail || '';
    if (meter && Number.isInteger(progress.total) && Number.isInteger(progress.completed)) {
      meter.max = progress.total;
      meter.value = progress.completed;
      meter.textContent = progress.completed + ' of ' + progress.total;
    }
  }

  function poll(region) {
    var currentState = region.getAttribute('data-publication-state');
    var statusUrl = region.getAttribute('data-publication-status-url');
    if (!currentState || !statusUrl) return;
    window.fetch(statusUrl, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function(response) {
      if (!response.ok) throw new Error('Status unavailable.');
      return response.json();
    }).then(function(payload) {
      var nextState = payload && payload.status
        ? payload.status + ':' + (payload.indexingStatus || 'not_started')
        : '';
      if (nextState && nextState !== currentState) {
        window.location.reload();
        return;
      }
      updateRegion(region, payload);
      if (payload && payload.progress && payload.progress.active === false) return;
      window.setTimeout(function() { poll(region); }, 5000);
    }).catch(function() {
      window.setTimeout(function() { poll(region); }, 15000);
    });
  }

  regions.forEach(function(region) {
    window.setTimeout(function() { poll(region); }, 5000);
  });
})();
