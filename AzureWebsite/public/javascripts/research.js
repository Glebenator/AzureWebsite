(function() {
  'use strict';

  var article = document.getElementById('article-content');
  if (!article) return;

  var progress = document.querySelector('[data-reading-progress]');
  var progressBar = document.querySelector('[data-reading-progress-bar]');
  var readingStatuses = document.querySelectorAll('[data-reading-status]');
  var backToTop = document.querySelector('[data-back-to-top]');
  var readingMinutes = Number.parseInt(article.dataset.readingMinutes, 10) || 1;
  var frameQueued = false;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function updateReadingProgress() {
    frameQueued = false;
    var bounds = article.getBoundingClientRect();
    var articleTop = window.scrollY + bounds.top;
    var articleEnd = articleTop + article.offsetHeight;
    var readingPoint = window.scrollY + (window.innerHeight * 0.3);
    var trackLength = Math.max(1, articleEnd - articleTop - (window.innerHeight * 0.3));
    var ratio = clamp((readingPoint - articleTop) / trackLength, 0, 1);
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) ratio = 1;

    var percentage = Math.round(ratio * 100);
    var label = percentage >= 99
      ? 'Finished'
      : `${percentage}% read · ${Math.max(1, Math.ceil(readingMinutes * (1 - ratio)))} min left`;

    if (progressBar) progressBar.style.transform = `scaleX(${ratio})`;
    if (progress) progress.setAttribute('aria-valuenow', String(percentage));
    if (backToTop) backToTop.hidden = ratio < 0.08;
    readingStatuses.forEach(function(status) {
      status.textContent = label;
    });
  }

  function scheduleReadingProgress() {
    if (frameQueued) return;
    frameQueued = true;
    window.requestAnimationFrame(updateReadingProgress);
  }

  window.addEventListener('scroll', scheduleReadingProgress, { passive: true });
  window.addEventListener('resize', scheduleReadingProgress);
  scheduleReadingProgress();

  var tocLinks = Array.from(document.querySelectorAll('[data-toc-link]'));
  var sectionIds = new Set(tocLinks.map(function(link) { return link.dataset.tocLink; }));
  var sections = Array.from(article.querySelectorAll('[id]')).filter(function(section) {
    return sectionIds.has(section.id);
  });
  var activeSectionId = '';

  function keepActiveTocLinkVisible(id) {
    document.querySelectorAll('.article-toc').forEach(function(toc) {
      if (window.getComputedStyle(toc).display === 'none') return;
      var activeLink = Array.from(toc.querySelectorAll('[data-toc-link]')).find(function(link) {
        return link.dataset.tocLink === id;
      });
      if (!activeLink) return;

      var group = activeLink.closest('[data-toc-group]');
      if (group && !group.open) group.open = true;

      window.requestAnimationFrame(function() {
        var tocBounds = toc.getBoundingClientRect();
        var linkBounds = activeLink.getBoundingClientRect();
        var topBuffer = 64;
        var bottomBuffer = 24;
        if (linkBounds.top < tocBounds.top + topBuffer) {
          toc.scrollTop -= (tocBounds.top + topBuffer) - linkBounds.top;
        } else if (linkBounds.bottom > tocBounds.bottom - bottomBuffer) {
          toc.scrollTop += linkBounds.bottom - (tocBounds.bottom - bottomBuffer);
        }
      });
    });
  }

  function setActiveSection(id) {
    if (!id || id === activeSectionId) return;
    activeSectionId = id;
    tocLinks.forEach(function(link) {
      if (link.dataset.tocLink === id) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    });
    keepActiveTocLinkVisible(id);
  }

  if (tocLinks.length > 0) {
    var initialId = window.location.hash.slice(1);
    setActiveSection(sectionIds.has(initialId) ? initialId : tocLinks[0].dataset.tocLink);
    tocLinks.forEach(function(link) {
      link.addEventListener('click', function() {
        setActiveSection(link.dataset.tocLink);
      });
      if (link.parentElement && link.parentElement.tagName === 'SUMMARY') {
        link.addEventListener('click', function(event) {
          event.stopPropagation();
        });
      }
    });
  }

  if ('IntersectionObserver' in window && sections.length > 0) {
    var sectionObserver = new IntersectionObserver(function(entries) {
      var visible = entries
        .filter(function(entry) { return entry.isIntersecting; })
        .sort(function(left, right) { return left.boundingClientRect.top - right.boundingClientRect.top; });
      if (visible.length > 0) setActiveSection(visible[0].target.id);
    }, {
      rootMargin: '-18% 0px -72% 0px',
      threshold: 0
    });
    sections.forEach(function(section) { sectionObserver.observe(section); });
  }

  var tooltip = document.getElementById('research-citation-tooltip');
  var tooltipTitle = tooltip && tooltip.querySelector('[data-citation-tooltip-title]');
  var tooltipDomain = tooltip && tooltip.querySelector('[data-citation-tooltip-domain]');
  var hoverQuery = window.matchMedia('(hover: hover)');
  var activeCitation = null;

  function hideCitationTooltip() {
    if (!tooltip || !activeCitation) return;
    activeCitation.removeAttribute('aria-describedby');
    activeCitation = null;
    tooltip.hidden = true;
  }

  function showCitationTooltip(citation) {
    if (!tooltip || !citation.dataset.referenceTitle) return;
    if (activeCitation && activeCitation !== citation) activeCitation.removeAttribute('aria-describedby');
    activeCitation = citation;
    tooltipTitle.textContent = citation.dataset.referenceTitle;
    tooltipDomain.textContent = citation.dataset.referenceDomain || 'Source reference';
    tooltip.hidden = false;
    citation.setAttribute('aria-describedby', tooltip.id);

    var citationBounds = citation.getBoundingClientRect();
    var tooltipBounds = tooltip.getBoundingClientRect();
    var left = clamp(
      citationBounds.left + (citationBounds.width / 2) - (tooltipBounds.width / 2),
      12,
      window.innerWidth - tooltipBounds.width - 12
    );
    var top = citationBounds.bottom + 10;
    if (top + tooltipBounds.height > window.innerHeight - 12) {
      top = citationBounds.top - tooltipBounds.height - 10;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(12, top)}px`;
  }

  if (tooltip) {
    article.querySelectorAll('.research-citation').forEach(function(citation) {
      citation.addEventListener('mouseenter', function() {
        if (hoverQuery.matches) showCitationTooltip(citation);
      });
      citation.addEventListener('mouseleave', function() {
        if (document.activeElement !== citation) hideCitationTooltip();
      });
      citation.addEventListener('focus', function() {
        showCitationTooltip(citation);
      });
      citation.addEventListener('blur', hideCitationTooltip);
    });

    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') hideCitationTooltip();
    });
    window.addEventListener('scroll', hideCitationTooltip, { passive: true });
  }
})();
