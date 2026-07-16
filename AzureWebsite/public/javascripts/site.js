(function() {
  'use strict';

  var root = document.documentElement;
  var motionButton = document.querySelector('.motion-toggle');
  var motionStatus = document.getElementById('motion-status');
  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var userReducedMotion = false;

  function renderMotionPreference() {
    var systemReducedMotion = motionQuery.matches;
    var effectiveReducedMotion = systemReducedMotion || userReducedMotion;

    root.dataset.motion = effectiveReducedMotion ? 'reduced' : 'full';

    if (motionButton) {
      motionButton.disabled = systemReducedMotion;
      motionButton.setAttribute('aria-pressed', String(effectiveReducedMotion));
    }

    if (motionStatus) {
      motionStatus.textContent = systemReducedMotion
        ? 'Motion is reduced by your system preference.'
        : (userReducedMotion ? 'Motion is reduced.' : 'Motion is enabled.');
    }
  }

  renderMotionPreference();

  if (motionButton) {
    motionButton.addEventListener('click', function() {
      if (motionQuery.matches) return;
      userReducedMotion = !userReducedMotion;
      renderMotionPreference();
    });
  }

  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', renderMotionPreference);
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener(renderMotionPreference);
  }

  document.querySelectorAll('.project-toggle').forEach(function(button) {
    button.addEventListener('click', function() {
      var project = button.closest('.project');
      var panel = document.getElementById(button.getAttribute('aria-controls'));
      var isOpen = button.getAttribute('aria-expanded') === 'true';

      button.setAttribute('aria-expanded', String(!isOpen));
      project.classList.toggle('is-open', !isOpen);
      panel.hidden = isOpen;
    });
  });
})();
