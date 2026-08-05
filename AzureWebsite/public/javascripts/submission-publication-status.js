'use strict';

(function() {
  var region = document.querySelector('[data-publication-refresh]');
  if (!region) return;
  var currentStatus = region.getAttribute('data-publication-status');
  var statusUrl = region.getAttribute('data-publication-status-url');
  if (!currentStatus || !statusUrl) return;

  function poll() {
    window.fetch(statusUrl, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function(response) {
      if (!response.ok) throw new Error('Status unavailable.');
      return response.json();
    }).then(function(payload) {
      if (payload && payload.status && payload.status !== currentStatus) {
        window.location.reload();
        return;
      }
      window.setTimeout(poll, 5000);
    }).catch(function() {
      window.setTimeout(poll, 15000);
    });
  }

  window.setTimeout(poll, 5000);
})();
