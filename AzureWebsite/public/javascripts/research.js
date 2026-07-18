(function() {
  'use strict';

  var ASSISTANT_REQUEST_TIMEOUT_MS = 45000;
  var ASSISTANT_TIMEOUT_MESSAGE = 'The answer took too long. Please try again.';
  var ASSISTANT_UPSTREAM_MESSAGE = 'Source-grounded answers are temporarily unavailable. Please try again.';
  var ASSISTANT_NETWORK_MESSAGE = 'The research assistant could not be reached. Check your connection and try again.';

  function AssistantRequestError(message, kind) {
    this.name = 'AssistantRequestError';
    this.message = message;
    this.kind = kind || 'upstream';
    if (Error.captureStackTrace) Error.captureStackTrace(this, AssistantRequestError);
  }

  AssistantRequestError.prototype = Object.create(Error.prototype);
  AssistantRequestError.prototype.constructor = AssistantRequestError;

  function safeServerMessage(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 320);
  }

  function fallbackResponseMessage(status) {
    if (status === 429) return 'Please wait before asking another question.';
    if (status === 403) return 'This question could not be submitted from the current page.';
    return ASSISTANT_UPSTREAM_MESSAGE;
  }

  function validAssistantPayload(payload) {
    var hasValidShape = Boolean(
      payload
      && typeof payload === 'object'
      && (
        payload.status === 'answered'
        || payload.status === 'no_evidence'
        || payload.status === 'guardrail_refusal'
      )
      && (payload.guardrailMode === 'standard' || payload.guardrailMode === 'experimental')
      && typeof payload.answer === 'string'
      && Array.isArray(payload.sources)
      && (payload.followUps === undefined || Array.isArray(payload.followUps))
    );
    if (!hasValidShape) return false;

    if (payload.status === 'answered') {
      if (payload.sources.length === 0 || !payload.sources.every(validCanonicalSource)) return false;

      var sourceNumbers = payload.sources.map(function(source) { return source.number; });
      var uniqueSourceNumbers = new Set(sourceNumbers);
      if (uniqueSourceNumbers.size !== sourceNumbers.length) return false;

      var numericBracketTokens = payload.answer.match(/\[[^\]\r\n]{0,80}\d[^\]\r\n]{0,80}\]/g) || [];
      if (
        numericBracketTokens.length === 0
        || numericBracketTokens.some(function(token) { return !/^\[[1-9]\d*\]$/.test(token); })
      ) return false;

      var citedNumbers = new Set(numericBracketTokens.map(function(token) {
        return Number.parseInt(token.slice(1, -1), 10);
      }));
      return Array.from(citedNumbers).every(function(number) { return uniqueSourceNumbers.has(number); })
        && sourceNumbers.every(function(number) { return citedNumbers.has(number); });
    }

    if (payload.status === 'guardrail_refusal' && payload.guardrailMode === 'experimental') {
      return false;
    }

    return payload.sources.length === 0
      && Array.isArray(payload.followUps)
      && payload.followUps.length === 0;
  }

  function resultPresentation(payload, sourceCount) {
    var modeLabel = payload.guardrailMode === 'experimental'
      ? 'Experimental mode'
      : 'Standard mode';

    if (payload.status === 'guardrail_refusal') {
      return {
        announcement: `Answer withheld in ${modeLabel.toLowerCase()}.`,
        grounding: 'Relevant passages were found. Experimental mode can show a source-grounded version.',
        label: 'Answer withheld',
        modeLabel
      };
    }

    if (payload.status === 'no_evidence') {
      return {
        announcement: `No grounded answer in ${modeLabel.toLowerCase()}.`,
        grounding: 'Suitable passages were not found in the selected research scope.',
        label: 'Evidence not found',
        modeLabel
      };
    }

    return {
      announcement: `Grounded answer ready in ${modeLabel.toLowerCase()}.`,
      grounding: `Grounded in ${sourceCount} ${sourceCount === 1 ? 'passage' : 'passages'}.`,
      label: 'Grounded answer',
      modeLabel
    };
  }

  async function readAssistantResponse(response) {
    var raw = await response.text();
    var payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      var serverMessage = safeServerMessage(payload && payload.error && payload.error.message);
      throw new AssistantRequestError(
        serverMessage || fallbackResponseMessage(response.status),
        response.status === 429 ? 'rate_limited' : 'upstream'
      );
    }
    if (!validAssistantPayload(payload)) {
      throw new AssistantRequestError(ASSISTANT_UPSTREAM_MESSAGE, 'upstream');
    }
    return payload;
  }

  function createRequestDeadline(timeoutMs, dependencies) {
    var tools = dependencies || {};
    var Controller = tools.AbortController
      || (typeof AbortController === 'function' ? AbortController : null);
    var schedule = tools.setTimeout || setTimeout;
    var cancel = tools.clearTimeout || clearTimeout;
    var duration = Math.min(60000, Math.max(5000, Number(timeoutMs) || ASSISTANT_REQUEST_TIMEOUT_MS));
    var timedOut = false;
    var controller = Controller ? new Controller() : null;
    var timer = controller ? schedule(function() {
      timedOut = true;
      controller.abort();
    }, duration) : null;

    return {
      signal: controller ? controller.signal : undefined,
      clear: function() {
        if (timer !== null) cancel(timer);
      },
      didTimeOut: function() { return timedOut; }
    };
  }

  function assistantFailureMessage(error, deadline) {
    if ((deadline && deadline.didTimeOut()) || (error && error.name === 'AbortError')) {
      return ASSISTANT_TIMEOUT_MESSAGE;
    }
    if (error instanceof AssistantRequestError) return error.message;
    if (error instanceof TypeError) return ASSISTANT_NETWORK_MESSAGE;
    return ASSISTANT_UPSTREAM_MESSAGE;
  }

  function appendAnswerWithCitations(container, answer, sources) {
    container.replaceChildren();
    var paragraph = document.createElement('p');
    var pattern = /\[([1-9]\d*)\]/g;
    var sourceNumbers = new Set(sources.map(function(source) { return source.number; }));
    var cursor = 0;
    var match;

    while ((match = pattern.exec(answer)) !== null) {
      paragraph.append(document.createTextNode(answer.slice(cursor, match.index)));
      var number = Number.parseInt(match[1], 10);
      if (sourceNumbers.has(number)) {
        var citation = document.createElement('a');
        citation.className = 'assistant-citation';
        citation.href = `#assistant-source-${number}`;
        citation.setAttribute('aria-label', `Source ${number}`);
        citation.textContent = `[${number}]`;
        paragraph.append(citation);
      } else {
        paragraph.append(document.createTextNode(match[0]));
      }
      cursor = pattern.lastIndex;
    }

    paragraph.append(document.createTextNode(answer.slice(cursor)));
    container.append(paragraph);
  }

  function validCanonicalSource(source) {
    return Boolean(
      source
      && Number.isInteger(source.number)
      && typeof source.title === 'string'
      && typeof source.url === 'string'
      && /^\/research\/[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.url)
    );
  }

  function renderSources(list, sources) {
    list.replaceChildren();
    sources.forEach(function(source) {
      var item = document.createElement('li');
      item.id = `assistant-source-${source.number}`;

      var number = document.createElement('span');
      number.className = 'assistant-source-number';
      number.textContent = String(source.number).padStart(2, '0');

      var copy = document.createElement('div');
      var link = document.createElement('a');
      link.href = source.url;
      link.textContent = source.heading ? `${source.title} · ${source.heading}` : source.title;
      copy.append(link);
      if (source.excerpt) {
        var excerpt = document.createElement('p');
        excerpt.textContent = source.excerpt;
        copy.append(excerpt);
      }

      item.append(number, copy);
      list.append(item);
    });
  }

  function initializeResearchAssistant() {
    var assistant = document.querySelector('[data-research-assistant]');
    if (!assistant || assistant.dataset.assistantAvailable !== 'true') return;

    var form = assistant.querySelector('[data-assistant-form]');
    var question = assistant.querySelector('[data-assistant-question]');
    var submit = assistant.querySelector('[data-assistant-submit]');
    var submitLabel = assistant.querySelector('[data-assistant-submit-label]');
    var status = assistant.querySelector('[data-assistant-status]');
    var retry = assistant.querySelector('[data-assistant-retry]');
    var loading = assistant.querySelector('[data-assistant-loading]');
    var result = assistant.querySelector('[data-assistant-result]');
    var answer = assistant.querySelector('[data-assistant-answer]');
    var resultLabel = assistant.querySelector('[data-assistant-result-label]');
    var grounding = assistant.querySelector('[data-assistant-grounding]');
    var sources = assistant.querySelector('[data-assistant-sources]');
    var evidence = assistant.querySelector('[data-assistant-evidence]');
    var followUps = assistant.querySelector('[data-assistant-follow-ups]');
    var followUpList = assistant.querySelector('[data-assistant-follow-up-list]');
    var notice = assistant.querySelector('[data-assistant-notice]');
    var guardrails = assistant.querySelector('[data-assistant-guardrails]');
    var resultMode = assistant.querySelector('[data-assistant-result-mode]');
    var experimentalWarning = assistant.querySelector('[data-assistant-experimental-warning]');

    function setBusy(busy) {
      assistant.setAttribute('aria-busy', busy ? 'true' : 'false');
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
      submit.disabled = busy;
      question.readOnly = busy;
      guardrails.disabled = busy;
      submitLabel.textContent = busy ? 'Checking…' : 'Ask';
      loading.hidden = !busy;
      assistant.querySelectorAll('[data-assistant-suggestion], [data-assistant-follow-up-list] button')
        .forEach(function(button) { button.disabled = busy; });
      if (busy) {
        status.classList.remove('visually-hidden');
        result.hidden = true;
        retry.hidden = true;
        status.hidden = false;
        status.textContent = 'Searching the published notes and checking citations…';
      }
    }

    function useQuestion(value, submitImmediately) {
      question.value = value;
      question.focus();
      if (submitImmediately) form.requestSubmit();
    }

    assistant.querySelectorAll('[data-assistant-suggestion]').forEach(function(button) {
      button.addEventListener('click', function() {
        useQuestion(button.dataset.assistantSuggestion, false);
      });
    });

    retry.addEventListener('click', function() {
      form.requestSubmit();
    });

    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (!form.reportValidity()) return;

      setBusy(true);
      var selectedMode = form.querySelector('[data-assistant-guardrail-mode]:checked');
      var deadline = createRequestDeadline(ASSISTANT_REQUEST_TIMEOUT_MS);
      var refocusQuestion = false;
      try {
        var response = await fetch('/research/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: deadline.signal,
          body: JSON.stringify({
            question: question.value,
            scope: assistant.dataset.assistantScope,
            slug: assistant.dataset.assistantSlug || undefined,
            guardrailMode: selectedMode ? selectedMode.value : 'standard'
          })
        });
        var payload = await readAssistantResponse(response);
        var sourceNumbers = new Set();
        var canonicalSources = payload.sources.filter(function(source) {
          if (!validCanonicalSource(source) || sourceNumbers.has(source.number)) return false;
          sourceNumbers.add(source.number);
          return true;
        });
        var presentation = resultPresentation(payload, canonicalSources.length);

        appendAnswerWithCitations(answer, payload.answer, canonicalSources);
        renderSources(sources, canonicalSources);
        resultLabel.textContent = presentation.label;
        resultMode.textContent = presentation.modeLabel;
        resultMode.classList.toggle('is-experimental', payload.guardrailMode === 'experimental');
        experimentalWarning.hidden = !(
          payload.status === 'answered' && payload.guardrailMode === 'experimental'
        );
        grounding.textContent = presentation.grounding;
        evidence.hidden = payload.status === 'no_evidence' || canonicalSources.length === 0;
        notice.textContent = payload.notice || '';
        result.dataset.resultStatus = payload.status;
        result.dataset.guardrailMode = payload.guardrailMode;

        followUpList.replaceChildren();
        (payload.followUps || []).forEach(function(item) {
          var button = document.createElement('button');
          button.type = 'button';
          button.textContent = item;
          button.addEventListener('click', function() { useQuestion(item, true); });
          followUpList.append(button);
        });
        followUps.hidden = followUpList.children.length === 0;

        status.textContent = presentation.announcement;
        status.classList.add('visually-hidden');
        status.hidden = false;
        retry.hidden = true;
        result.hidden = false;
        result.focus({ preventScroll: true });
        var reduceMotion = window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        result.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
      } catch (error) {
        result.hidden = true;
        status.classList.remove('visually-hidden');
        status.hidden = false;
        status.textContent = assistantFailureMessage(error, deadline);
        retry.hidden = false;
        refocusQuestion = true;
      } finally {
        deadline.clear();
        setBusy(false);
        if (refocusQuestion) question.focus({ preventScroll: true });
      }
    });
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      ASSISTANT_REQUEST_TIMEOUT_MS,
      AssistantRequestError,
      assistantFailureMessage,
      createRequestDeadline,
      readAssistantResponse,
      resultPresentation,
      safeServerMessage,
      validAssistantPayload,
      validCanonicalSource
    };
  }

  if (typeof document === 'undefined') return;

  initializeResearchAssistant();

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
