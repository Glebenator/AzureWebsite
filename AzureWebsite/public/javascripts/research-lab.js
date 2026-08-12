(function(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.initialize(root.document, root);
})(typeof window === 'undefined' ? null : window, function() {
  'use strict';

  function safeMessage(value, fallback) {
    return typeof value === 'string' && value.trim()
      ? value.replace(/\s+/g, ' ').trim().slice(0, 500)
      : fallback;
  }

  function shouldSubmitFromKey(event) {
    return Boolean(event)
      && event.key === 'Enter'
      && !event.shiftKey
      && !event.isComposing;
  }

  function formatElapsed(milliseconds) {
    var seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
    var minutes = Math.floor(seconds / 60);
    return String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }

  function requestedMode(value) {
    return value === 'direct' ? 'direct' : 'research';
  }

  function normalizeModelCatalog(payload, fallbackModel) {
    var modelPattern = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;
    function validFreeId(value) {
      return typeof value === 'string'
        && modelPattern.test(value)
        && (value === 'openrouter/free' || value.endsWith(':free'));
    }
    var fallback = validFreeId(fallbackModel) ? fallbackModel : 'openrouter/free';
    var hasLiveCatalog = Boolean(payload && Array.isArray(payload.models));
    var models = [];
    var seen = new Set();
    function add(item) {
      if (!item || !validFreeId(item.id) || seen.has(item.id)) return;
      seen.add(item.id);
      models.push({
        id: item.id,
        name: safeMessage(item.name, item.id),
        contextLength: Number.isSafeInteger(item.contextLength) && item.contextLength > 0
          ? item.contextLength
          : null
      });
    }
    (hasLiveCatalog ? payload.models : []).forEach(add);
    var requiredFallback = hasLiveCatalog ? 'openrouter/free' : fallback;
    if (!seen.has(requiredFallback)) {
      seen.add(requiredFallback);
      models.unshift({ id: requiredFallback, name: requiredFallback, contextLength: null });
    }
    var requestedDefault = payload && validFreeId(payload.defaultModel) && seen.has(payload.defaultModel)
      ? payload.defaultModel
      : requiredFallback;
    return {
      defaultModel: requestedDefault,
      models: models
    };
  }

  function resultPresentation(event) {
    var quick = event && event.mode === 'quick';
    var validation = event && event.validation && typeof event.validation === 'object'
      ? event.validation
      : null;
    var unsupported = Boolean(validation && validation.semanticSupport === 'unsupported');
    var referencesValid = Boolean(
      validation
      && validation.citationSyntax === 'valid'
      && validation.referenceValidity === 'valid'
    );
    var validationKnown = Boolean(
      validation
      && typeof validation.semanticSupport === 'string'
      && typeof validation.referenceValidity === 'string'
    );
    var evidenceCount = String((event && event.evidenceCount) || 0);
    return {
      label: quick ? 'Direct answer' : unsupported ? 'Unsupported research draft' : 'Research draft',
      mode: quick ? 'Direct answer' : 'Research mode',
      note: safeMessage(
        event && event.qualification,
        quick
          ? 'Direct answer. No external sources were searched.'
          : unsupported
            ? 'Off-topic output detected. This draft is not supported by the cited evidence.'
            : referencesValid
              ? 'Citation references resolve to retrieved evidence. Semantic support was not independently assessed.'
              : validationKnown
                ? 'Unverified research draft. Citation references were missing or invalid.'
                : 'Validation state is unavailable. Treat this output as unsupported.'
      ),
      summary: quick
        ? 'Direct answer · no sources'
        : unsupported
          ? evidenceCount + ' sources · off-topic output detected'
          : referencesValid
            ? evidenceCount + ' sources · references resolve · support not assessed'
            : validationKnown
              ? evidenceCount + ' sources · citation references incomplete'
              : evidenceCount + ' sources · validation unavailable',
      unverified: Boolean(!quick)
    };
  }

  function correlationFromResponse(response) {
    var requestId = response && response.headers && response.headers.get('X-Request-Id');
    var runId = response && response.headers && response.headers.get('X-Research-Run-Id');
    var idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return idPattern.test(requestId || '') && idPattern.test(runId || '')
      ? { requestId: requestId.toLowerCase(), runId: runId.toLowerCase() }
      : null;
  }

  function eventMatchesCorrelation(event, correlation) {
    return Boolean(
      event
      && correlation
      && event.requestId === correlation.requestId
      && event.runId === correlation.runId
    );
  }

  function evidencePresentation(citations, index) {
    var items = Array.isArray(citations) ? citations : [];
    if (items.length === 0) return null;
    var boundedIndex = Math.min(Math.max(Number(index) || 0, 0), items.length - 1);
    var item = items[boundedIndex] || {};
    return {
      item: item,
      index: boundedIndex,
      position: 'Source ' + (boundedIndex + 1) + ' of ' + items.length,
      metadata: safeMessage(item.source, 'English Wikipedia') + ' · ' + safeMessage(item.sourceType, 'Introductory extract'),
      hasPrevious: boundedIndex > 0,
      hasNext: boundedIndex < items.length - 1
    };
  }

  function initialize(document, browserWindow) {
    var lab = document.querySelector('[data-research-lab]');
    if (!lab || lab.dataset.available !== 'true') return;

    var form = lab.querySelector('[data-lab-form]');
    var query = lab.querySelector('[data-lab-query]');
    var submit = lab.querySelector('[data-lab-submit]');
    var submitLabel = lab.querySelector('[data-lab-submit-label]');
    var modePicker = lab.querySelector('[data-mode-picker]');
    var modelSelect = lab.querySelector('[data-model-select]');
    var modelStatus = lab.querySelector('[data-model-status]');
    var empty = lab.querySelector('[data-lab-empty]');
    var result = lab.querySelector('[data-lab-result]');
    var answer = lab.querySelector('[data-lab-answer]');
    var model = lab.querySelector('[data-lab-model]');
    var resultLabel = lab.querySelector('[data-lab-result-label]');
    var resultTitle = lab.querySelector('[data-lab-result-title]');
    var resultNote = lab.querySelector('[data-lab-result-note]');
    var qualification = lab.querySelector('[data-lab-qualification]');
    var runDetails = lab.querySelector('[data-run-details]');
    var runSummary = lab.querySelector('[data-run-summary]');
    var runMode = lab.querySelector('[data-run-mode]');
    var runElapsed = lab.querySelector('[data-run-elapsed]');
    var runRequestId = lab.querySelector('[data-run-request-id]');
    var runCorrelationId = lab.querySelector('[data-run-correlation-id]');
    var runLogElement = lab.querySelector('[data-run-log]');
    var activity = lab.querySelector('[data-lab-activity]');
    var activityStage = lab.querySelector('[data-activity-stage]');
    var activityDetail = lab.querySelector('[data-activity-detail]');
    var activityElapsed = lab.querySelector('[data-activity-elapsed]');
    var cancel = lab.querySelector('[data-activity-cancel]');
    var error = lab.querySelector('[data-lab-error]');
    var errorReference = lab.querySelector('[data-lab-error-reference]');
    var startOver = lab.querySelector('[data-start-over]');
    var casefileShell = lab.querySelector('[data-casefile-shell]');
    var drawer = lab.querySelector('[data-evidence-drawer]');
    var drawerTitle = lab.querySelector('#evidence-title');
    var drawerClose = lab.querySelector('[data-evidence-close]');
    var drawerPrevious = lab.querySelector('[data-evidence-previous]');
    var drawerNext = lab.querySelector('[data-evidence-next]');
    var drawerPosition = lab.querySelector('[data-evidence-position]');
    var drawerSourceTitle = lab.querySelector('[data-evidence-source-title]');
    var drawerMetadata = lab.querySelector('[data-evidence-metadata]');
    var drawerLink = lab.querySelector('[data-evidence-source-link]');
    var drawerUrl = lab.querySelector('[data-evidence-source-url]');
    var drawerExcerpt = lab.querySelector('[data-evidence-excerpt]');

    var controller = null;
    var startedAt = 0;
    var elapsedTimer = null;
    var runLog = [];
    var currentCitations = [];
    var activeCitationIndex = 0;
    var lastCitationTrigger = null;
    var completed = false;
    var activeCorrelation = null;

    function closeEvidence(options) {
      drawer.hidden = true;
      casefileShell.classList.remove('has-evidence');
      if (options && options.restoreFocus && lastCitationTrigger) lastCitationTrigger.focus();
      lastCitationTrigger = null;
    }

    function setBusy(busy) {
      lab.setAttribute('aria-busy', busy ? 'true' : 'false');
      query.readOnly = busy;
      submit.disabled = busy;
      modePicker.disabled = busy;
      modelSelect.disabled = busy || modelSelect.dataset.ready !== 'true';
      submitLabel.textContent = busy ? 'Working' : 'Start new';
      activity.hidden = !busy;
      cancel.disabled = !busy;
      if (!busy) {
        browserWindow.clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
    }

    function renderModelCatalog(catalog) {
      modelSelect.replaceChildren();
      catalog.models.forEach(function(item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name === item.id ? item.id : item.name + ' · ' + item.id;
        if (item.contextLength) option.title = item.contextLength.toLocaleString() + ' token context';
        modelSelect.append(option);
      });
      modelSelect.value = catalog.defaultModel;
      if (!modelSelect.value && modelSelect.options.length) modelSelect.selectedIndex = 0;
    }

    async function loadModelCatalog() {
      var fallback = modelSelect.dataset.defaultModel || 'openrouter/free';
      modelStatus.textContent = 'Loading current free models…';
      try {
        var response = await browserWindow.fetch('/research-lab/models', {
          method: 'GET',
          headers: { Accept: 'application/json' }
        });
        var payload = await response.json();
        if (!response.ok) {
          throw new Error(safeMessage(payload && payload.error && payload.error.message, 'Free models could not be loaded.'));
        }
        var catalog = normalizeModelCatalog(payload, fallback);
        renderModelCatalog(catalog);
        modelStatus.textContent = catalog.models.length + ' free ' + (catalog.models.length === 1 ? 'choice' : 'choices') + ', ranked by recent OpenRouter usage';
      } catch (caught) {
        renderModelCatalog(normalizeModelCatalog(null, fallback));
        modelStatus.textContent = safeMessage(caught && caught.message, 'Free models could not be refreshed.') + ' Using the configured free model.';
      } finally {
        modelSelect.dataset.ready = 'true';
        modelSelect.disabled = lab.getAttribute('aria-busy') === 'true';
      }
    }

    function beginActivity() {
      startedAt = Date.now();
      activityStage.textContent = 'Starting';
      activityDetail.textContent = 'Preparing an independent request';
      activityElapsed.textContent = '00:00';
      elapsedTimer = browserWindow.setInterval(function() {
        activityElapsed.textContent = formatElapsed(Date.now() - startedAt);
      }, 250);
    }

    function setActivity(stage, detail) {
      var labels = {
        qualify: 'Qualifying',
        plan: 'Planning',
        search: 'Searching',
        read: 'Reading',
        synthesize: 'Synthesizing',
        verify: 'Checking',
        answer: 'Answering',
        run: 'Starting'
      };
      activityStage.textContent = labels[stage] || 'Working';
      activityDetail.textContent = safeMessage(detail, 'Running a bounded request');
    }

    function addRunLog(stage, detail) {
      var copy = safeMessage(detail, 'Run step completed.');
      if (runLog.some(function(item) { return item.stage === stage && item.detail === copy; })) return;
      runLog.push({ stage: stage || 'step', detail: copy });
    }

    function renderRunLog() {
      runLogElement.replaceChildren();
      runLog.forEach(function(item, index) {
        var row = document.createElement('li');
        var marker = document.createElement('span');
        marker.textContent = String(index + 1).padStart(2, '0');
        var copy = document.createElement('p');
        copy.textContent = item.detail;
        row.append(marker, copy);
        runLogElement.append(row);
      });
    }

    function appendInlineCitations(parent, text, citations) {
      var allowed = new Map((citations || []).map(function(item, index) {
        return [Number(item.number), index];
      }));
      var pattern = /\[([1-9]\d*)\]/g;
      var cursor = 0;
      var match;
      while ((match = pattern.exec(text)) !== null) {
        parent.append(document.createTextNode(text.slice(cursor, match.index)));
        var number = Number.parseInt(match[1], 10);
        if (allowed.has(number)) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'casefile-citation';
          button.textContent = '[' + number + ']';
          button.dataset.citationIndex = String(allowed.get(number));
          button.setAttribute('aria-label', 'Open evidence source ' + number);
          parent.append(button);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
        cursor = pattern.lastIndex;
      }
      parent.append(document.createTextNode(text.slice(cursor)));
    }

    function renderAnswer(text, citations) {
      answer.replaceChildren();
      var blocks = String(text || '').split(/\n{2,}/).filter(function(block) { return block.trim(); });
      (blocks.length ? blocks : [String(text || '')]).forEach(function(block) {
        var lines = block.split('\n').filter(function(line) { return line.trim(); });
        var isList = lines.length > 1 && lines.every(function(line) { return /^\s*(?:[-*]|\d+[.)])\s+/.test(line); });
        if (isList) {
          var ordered = lines.every(function(line) { return /^\s*\d+[.)]\s+/.test(line); });
          var list = document.createElement(ordered ? 'ol' : 'ul');
          lines.forEach(function(line) {
            var item = document.createElement('li');
            appendInlineCitations(item, line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''), citations);
            list.append(item);
          });
          answer.append(list);
          return;
        }
        var paragraph = document.createElement('p');
        appendInlineCitations(paragraph, lines.join(' '), citations);
        answer.append(paragraph);
      });
    }

    function showEvidence(index, trigger) {
      var presentation = evidencePresentation(currentCitations, index);
      if (!presentation) return;
      activeCitationIndex = presentation.index;
      lastCitationTrigger = trigger || lastCitationTrigger;
      drawerPosition.textContent = presentation.position;
      drawerPrevious.disabled = !presentation.hasPrevious;
      drawerNext.disabled = !presentation.hasNext;
      drawerSourceTitle.textContent = safeMessage(presentation.item.title, 'Untitled source');
      drawerMetadata.textContent = presentation.metadata;
      drawerLink.href = presentation.item.url;
      drawerUrl.textContent = presentation.item.url;
      drawerExcerpt.textContent = typeof presentation.item.excerpt === 'string' && presentation.item.excerpt.trim()
        ? presentation.item.excerpt
        : 'No excerpt was returned.';
      drawer.hidden = false;
      casefileShell.classList.add('has-evidence');
      drawerTitle.focus();
    }

    function resetWorkspace(options) {
      closeEvidence();
      currentCitations = [];
      runLog = [];
      completed = false;
      activeCorrelation = null;
      result.hidden = true;
      empty.hidden = false;
      startOver.hidden = true;
      runDetails.open = false;
      error.hidden = true;
      error.textContent = '';
      errorReference.hidden = true;
      errorReference.textContent = '';
      answer.replaceChildren();
      if (options && options.clearQuery) query.value = '';
    }

    function renderResult(event, submittedQuery) {
      var presentation = resultPresentation(event);
      currentCitations = Array.isArray(event.citations) ? event.citations : [];
      resultLabel.textContent = presentation.label;
      resultTitle.textContent = submittedQuery;
      resultNote.classList.toggle('is-unverified', presentation.unverified);
      qualification.textContent = presentation.note;
      runSummary.textContent = presentation.summary;
      runMode.textContent = presentation.mode;
      model.textContent = safeMessage(event.modelUsed, 'Provider-reported model unavailable');
      runElapsed.textContent = formatElapsed(Date.now() - startedAt);
      runRequestId.textContent = activeCorrelation ? activeCorrelation.requestId : 'Unavailable';
      runCorrelationId.textContent = activeCorrelation ? activeCorrelation.runId : 'Unavailable';
      renderRunLog();
      renderAnswer(event.answer, currentCitations);
      empty.hidden = true;
      result.hidden = false;
      startOver.hidden = false;
      completed = true;
    }

    function handleEvent(event, submittedQuery, correlation) {
      if (!event || typeof event !== 'object') return;
      if (!eventMatchesCorrelation(event, correlation)) {
        throw new Error('Run correlation mismatch. The response was not rendered.');
      }
      if (event.type === 'run') {
        setActivity('run', event.mode === 'quick' ? 'Preparing a direct answer' : 'Preparing a bounded research casefile');
        addRunLog('run', 'Started an independent ' + (event.mode === 'quick' ? 'direct answer' : 'research run') + ' with ' + safeMessage(event.model, 'the selected model') + '.');
      } else if (event.type === 'plan') {
        (event.steps || []).forEach(function(step, index) { addRunLog('plan-' + index, step); });
      } else if (event.type === 'progress') {
        setActivity(event.stage, event.detail);
        addRunLog(event.stage, event.detail);
      } else if (event.type === 'evidence') {
        addRunLog('evidence', 'Retrieved ' + ((event.items && event.items.length) || 0) + ' bounded source extracts.');
      } else if (event.type === 'result') {
        renderResult(event, submittedQuery);
      } else if (event.type === 'error') {
        throw new Error(safeMessage(event.error && event.error.message, 'The request failed.'));
      }
    }

    async function readNdjson(response, submittedQuery, correlation) {
      if (!response.ok) {
        var payload = null;
        try { payload = await response.json(); } catch (ignored) { payload = null; }
        if (
          !correlation
          || !payload
          || payload.requestId !== correlation.requestId
          || payload.runId !== correlation.runId
        ) {
          throw new Error('Request correlation could not be validated.');
        }
        var publicError = new Error(safeMessage(payload && payload.error && payload.error.message, 'The request could not start.'));
        publicError.correlation = correlation;
        throw publicError;
      }
      if (!correlation) throw new Error('Request correlation headers were missing.');
      if (!response.body) throw new Error('The browser could not read live progress.');
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        var chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.filter(Boolean).forEach(function(line) { handleEvent(JSON.parse(line), submittedQuery, correlation); });
        if (chunk.done) break;
      }
      if (buffer.trim()) handleEvent(JSON.parse(buffer), submittedQuery, correlation);
    }

    query.addEventListener('keydown', function(event) {
      if (!shouldSubmitFromKey(event)) return;
      event.preventDefault();
      if (!submit.disabled && query.value.trim().length >= 3) form.requestSubmit();
    });

    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      var value = query.value.replace(/\s+/g, ' ').trim();
      if (value.length < 3) return;
      var selectedMode = form.querySelector('input[name="mode"]:checked');
      var selectedModel = modelSelect.value || modelSelect.dataset.defaultModel || 'openrouter/free';
      resetWorkspace();
      controller = new AbortController();
      beginActivity();
      setBusy(true);
      try {
        var response = await browserWindow.fetch('/research-lab/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: value,
            mode: requestedMode(selectedMode && selectedMode.value),
            model: selectedModel
          }),
          signal: controller.signal
        });
        activeCorrelation = correlationFromResponse(response);
        await readNdjson(response, value, activeCorrelation);
        if (!completed) throw new Error('The request ended before a model answer was returned.');
      } catch (caught) {
        if (caught && caught.name === 'AbortError') {
          error.textContent = 'Request cancelled. Nothing from this run was retained.';
        } else {
          error.textContent = safeMessage(caught && caught.message, 'The request failed.');
        }
        error.hidden = false;
        var correlation = (caught && caught.correlation) || activeCorrelation;
        if (correlation) {
          errorReference.textContent = 'Request ID ' + correlation.requestId + ' · Run ID ' + correlation.runId;
          errorReference.hidden = false;
        }
      } finally {
        setBusy(false);
        controller = null;
      }
    });

    cancel.addEventListener('click', function() {
      if (controller) controller.abort();
    });

    startOver.addEventListener('click', function() {
      resetWorkspace({ clearQuery: true });
      query.focus();
    });

    answer.addEventListener('click', function(event) {
      var trigger = event.target.closest('[data-citation-index]');
      if (!trigger) return;
      showEvidence(Number(trigger.dataset.citationIndex), trigger);
    });

    drawerClose.addEventListener('click', function() { closeEvidence({ restoreFocus: true }); });
    drawerPrevious.addEventListener('click', function() { showEvidence(activeCitationIndex - 1); });
    drawerNext.addEventListener('click', function() { showEvidence(activeCitationIndex + 1); });
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && !drawer.hidden) closeEvidence({ restoreFocus: true });
    });

    loadModelCatalog();
  }

  return {
    correlationFromResponse: correlationFromResponse,
    evidencePresentation: evidencePresentation,
    eventMatchesCorrelation: eventMatchesCorrelation,
    formatElapsed: formatElapsed,
    initialize: initialize,
    normalizeModelCatalog: normalizeModelCatalog,
    requestedMode: requestedMode,
    resultPresentation: resultPresentation,
    safeMessage: safeMessage,
    shouldSubmitFromKey: shouldSubmitFromKey
  };
});
