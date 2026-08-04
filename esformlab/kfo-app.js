// ─────────────────────────────────────────────────────────────────────────────
//  KFO — application integration
//
//  Owns the feature flags, the retained-sample accessor, the render dispatcher,
//  and the admin export/validation actions. Kept separate so index.html needs
//  only a couple of call sites.
//
//  Everything here is admin-gated. With every flag off, this file does nothing.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var STORAGE_PREFIX = 'esl-kfo-';

  var FLAG_DEFS = {
    kinematicForceOrientationV2: {
      label: 'Kinematic Force-Orientation V2',
      adminDefault: true, userDefault: false,
      description: 'Multi-stride support-line orientation estimate with uncertainty.'
    },
    experimentalComForceEstimator: {
      label: 'Experimental COM-acceleration estimator',
      adminDefault: false, userDefault: false,
      description: 'Unvalidated. Requires scale calibration; emits body-weight-normalised shape only.'
    },
    forceValidationTools: {
      label: 'Force-plate validation tools',
      adminDefault: false, userDefault: false,
      description: 'Research export and force-plate agreement statistics.'
    },
    legacyForceVectorV1: {
      label: 'Legacy V1 panel (comparison only)',
      adminDefault: false, userDefault: false,
      description: 'Shows the superseded prototype alongside V2 for regression comparison.'
    }
  };

  function isAdminUser() {
    try { return typeof isAdmin === 'function' ? !!isAdmin() : false; } catch (e) { return false; }
  }

  function readStored(name) {
    try {
      var v = localStorage.getItem(STORAGE_PREFIX + name);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  // A query parameter overrides storage for the current page load only, so a
  // flag can be demoed without leaving it enabled.
  function readQuery(name) {
    if (typeof location === 'undefined' || !location.search) return null;
    try {
      var p = new URLSearchParams(location.search).get(STORAGE_PREFIX + name);
      if (p === '1' || p === 'true') return true;
      if (p === '0' || p === 'false') return false;
    } catch (e) { /* older browser */ }
    return null;
  }

  function isEnabled(name) {
    var def = FLAG_DEFS[name];
    if (!def) return false;
    var q = readQuery(name);
    if (q !== null) return q;
    var s = readStored(name);
    if (s !== null) return s;
    return isAdminUser() ? def.adminDefault : def.userDefault;
  }

  function setFlag(name, on) {
    if (!FLAG_DEFS[name]) return false;
    try { localStorage.setItem(STORAGE_PREFIX + name, on ? '1' : '0'); return true; }
    catch (e) { return false; }
  }
  function clearFlag(name) {
    try { localStorage.removeItem(STORAGE_PREFIX + name); return true; } catch (e) { return false; }
  }
  function flagState() {
    var out = {};
    Object.keys(FLAG_DEFS).forEach(function (k) {
      out[k] = { enabled: isEnabled(k), label: FLAG_DEFS[k].label, description: FLAG_DEFS[k].description };
    });
    return out;
  }

  // ── Retained scan samples ─────────────────────────────────────────────────
  // index.html stores the side-scan samples on window.__kfoSamples. They contain
  // full keypoints per sampled frame, which is what makes multi-stride analysis
  // possible without any extra pose inference.
  function getSamples() {
    var s = (typeof window !== 'undefined') ? window.__kfoSamples : null;
    return (s && s.length) ? s : null;
  }

  var lastResult = null;
  function getLastResult() { return lastResult; }

  function analyze() {
    if (typeof KFOAnalysis === 'undefined') return null;
    var samples = getSamples();
    if (!samples) return null;
    var vid = (typeof document !== 'undefined') ? document.getElementById('side-video') : null;
    var meta = {};
    if (vid) { meta.width = vid.videoWidth || null; meta.height = vid.videoHeight || null; }
    lastResult = KFOAnalysis.analyze({
      samples: samples,
      videoMetadata: meta,
      // Speed and grade are not captured anywhere in the pipeline, so they stay
      // null and the corresponding quality flags are always raised.
      speedMps: null,
      gradePercent: null,
      sex: (typeof selectedSex !== 'undefined') ? selectedSex : null
    });
    return lastResult;
  }

  /** Render dispatcher called from completeAnalysis() / analyzeCard(). */
  function render() {
    if (!isAdminUser()) return;

    if (isEnabled('kinematicForceOrientationV2')) {
      try {
        var result = analyze();
        if (typeof KFORender !== 'undefined') {
          if (result) KFORender.mount(result, 'kfo-admin-report');
          else mountMessage('kfo-admin-report',
            'Kinematic Force-Orientation needs the side-view scan data from this session. ' +
            'Re-run the analysis from the upload screen to populate it.');
        }
      } catch (e) {
        console.error('[kfo] render failed:', e);
      }
      if (isEnabled('forceValidationTools')) {
        try { mountResearchTools(); } catch (e) { console.error('[kfo] research tools failed:', e); }
      }
    } else {
      removeNode('kfo-admin-report');
      removeNode('kfo-research-tools');
    }

    // Legacy V1, comparison only, clearly labelled.
    if (isEnabled('legacyForceVectorV1') && typeof renderForceVectorReport === 'function') {
      try {
        renderForceVectorReport();
        var host = document.getElementById('fv-admin-report');
        if (host && !host.querySelector('.kfo-legacy-note')) {
          var note = document.createElement('div');
          note.className = 'kfo-legacy-note';
          note.style.cssText = 'margin-bottom:8px;padding:7px 10px;border-left:3px solid var(--bad,#ff5d5d);' +
            'background:rgba(255,93,93,.08);border-radius:6px;font-size:11px;line-height:1.5';
          note.innerHTML = '<strong>LEGACY — superseded.</strong> Retained only for regression comparison. ' +
            'Its late-stance scoring treated a near-vertical support line as a deficiency, which the ' +
            'evidence does not support. Use the V2 panel above.';
          host.insertBefore(note, host.firstChild);
        }
      } catch (e) { console.error('[kfo] legacy render failed:', e); }
    } else {
      removeNode('fv-admin-report');
    }
  }

  function removeNode(id) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function ensureHost(id) {
    var host = document.getElementById(id);
    if (host) return host;
    host = document.createElement('div');
    host.id = id;
    var anchor = document.getElementById('kfo-admin-report') || document.getElementById('report-details');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
    else {
      var section = document.getElementById('report-section');
      if (!section) return null;
      section.appendChild(host);
    }
    return host;
  }

  function mountMessage(id, text) {
    var host = ensureHost(id);
    if (!host) return;
    host.innerHTML = '<div style="margin-top:22px;padding:14px;border:1px solid var(--border2,#2a3550);' +
      'border-radius:10px;background:var(--panel2,#121724);font-size:12px;line-height:1.6">' +
      text.replace(/[<>]/g, '') + '</div>';
  }

  // ── Research tools ────────────────────────────────────────────────────────
  function mountResearchTools() {
    if (typeof KFOExport === 'undefined' || !lastResult) return;
    var host = ensureHost('kfo-research-tools');
    if (!host) return;
    host.innerHTML =
      '<div style="margin-top:12px;padding:14px;border:1px solid var(--border2,#2a3550);border-radius:10px;' +
      'background:var(--panel2,#121724)">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:7px">Research export &amp; validation (admin)</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" data-kfo="json" style="font:inherit;font-size:11px;padding:6px 11px;border-radius:6px;' +
      'border:1px solid var(--border2,#2a3550);background:transparent;color:inherit;cursor:pointer">Download JSON</button>' +
      '<button type="button" data-kfo="strides" style="font:inherit;font-size:11px;padding:6px 11px;border-radius:6px;' +
      'border:1px solid var(--border2,#2a3550);background:transparent;color:inherit;cursor:pointer">Stride CSV</button>' +
      '<button type="button" data-kfo="frames" style="font:inherit;font-size:11px;padding:6px 11px;border-radius:6px;' +
      'border:1px solid var(--border2,#2a3550);background:transparent;color:inherit;cursor:pointer">Frame CSV (with landmarks)</button>' +
      '<label style="font-size:11px;padding:6px 11px;border-radius:6px;border:1px solid var(--border2,#2a3550);cursor:pointer">' +
      'Import force-plate CSV<input type="file" accept=".csv,text/csv" data-kfo="import" style="display:none"></label>' +
      '</div>' +
      '<div data-kfo="out" style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:9px;line-height:1.6"></div>' +
      '</div>';

    var out = host.querySelector('[data-kfo="out"]');
    function bundle() {
      return KFOExport.buildExport(lastResult, getSamples(), {
        analysisId: 'session-' + (lastResult.videoMetadata ? Math.round(lastResult.videoMetadata.durationSeconds * 1000) : 0),
        includeLandmarks: true
      });
    }
    function download(name, text, mime) {
      var blob = new Blob([text], { type: mime || 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }

    host.querySelectorAll('button[data-kfo]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-kfo');
        try {
          var b = bundle();
          if (kind === 'json') download('kfo-export.json', JSON.stringify(b, null, 2), 'application/json');
          if (kind === 'strides') download('kfo-strides.csv', b.csv.strides, 'text/csv');
          if (kind === 'frames') download('kfo-frames.csv', b.csv.frames, 'text/csv');
          out.textContent = 'Exported ' + b.strideLevel.length + ' stride rows and ' +
            b.frameLevel.length + ' frame rows.';
        } catch (e) { out.textContent = 'Export failed: ' + e.message; }
      });
    });

    var importer = host.querySelector('input[data-kfo="import"]');
    if (importer) {
      importer.addEventListener('change', function (ev) {
        var file = ev.target.files && ev.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var parsed = KFOExport.parseForcePlateCsv(String(reader.result));
            if (!parsed.ok) { out.textContent = 'Import failed: ' + parsed.reason; return; }
            var contacts = KFOExport.extractCriterionAngles(parsed.rows, {});
            var rows = KFOExport.strideRows(lastResult, { analysisId: 'session' });
            var pairs = KFOExport.pairWithCriterion(rows, contacts, {});
            if (!pairs.length) {
              out.textContent = 'Parsed ' + parsed.rows.length + ' force rows and ' + contacts.length +
                ' contacts, but none aligned with the video strides. A sync offset is needed.';
              return;
            }
            var stats = KFOExport.validationStats(pairs);
            var verdict = KFOExport.interpretValidation(stats, { subjectCount: 1 });
            out.innerHTML = 'Paired ' + pairs.length + ' observations across ' + contacts.length + ' contacts.<br>' +
              'MAE ' + stats.meanAbsoluteError.toFixed(2) + '° · bias ' + stats.bias.toFixed(2) +
              '° · RMSE ' + stats.rmse.toFixed(2) + '° · slope ' +
              (stats.calibrationSlope == null ? '—' : stats.calibrationSlope.toFixed(3)) +
              ' · r ' + (stats.correlation == null ? '—' : stats.correlation.toFixed(3)) + '<br>' +
              'Limits of agreement ' + stats.blandAltman.lowerLimitOfAgreement.toFixed(2) + '° to ' +
              stats.blandAltman.upperLimitOfAgreement.toFixed(2) + '°<br>' +
              '<strong>Validated: ' + (verdict.validated ? 'yes' : 'no') + '</strong>' +
              (verdict.failures.length ? ' — unmet: ' + verdict.failures.join(', ') : '');
          } catch (e) { out.textContent = 'Import failed: ' + e.message; }
        };
        reader.readAsText(file);
      });
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  /**
   * Fields to merge into a saved-analysis document. Always stamps
   * `schemaVersion` so absence of the field can be read as "version 1" forever,
   * and attaches the aggregate KFO block when one is available.
   *
   * Stride-level detail is deliberately NOT persisted — it belongs in the
   * research export, not in every user document.
   */
  function storedFields() {
    var out = { schemaVersion: (typeof KFO !== 'undefined') ? KFO.SCHEMA_VERSION : 2 };
    try {
      if (!isAdminUser() || !isEnabled('kinematicForceOrientationV2')) return out;
      if (typeof KFOAnalysis === 'undefined') return out;
      var result = lastResult || analyze();
      if (!result) return out;
      var stored = KFOAnalysis.toStoredForm(result);
      if (stored) out.kfo = stored;
    } catch (e) { console.warn('[kfo] stored fields skipped:', e.message); }
    return out;
  }

  /** Read-time normalisation for rendering a saved analysis of any vintage. */
  function fromStored(doc) {
    if (typeof KFO === 'undefined') return null;
    return KFO.migrateAnalysis(doc);
  }

  /**
   * Render a SAVED analysis. Never recomputes: a saved session has no keypoints,
   * and window.__kfoSamples may still hold a previous clip's data, so recomputing
   * here would silently attribute one runner's mechanics to another's session.
   */
  function renderSaved(doc) {
    if (!isAdminUser() || !isEnabled('kinematicForceOrientationV2')) {
      removeNode('kfo-admin-report'); removeNode('kfo-research-tools');
      return;
    }
    removeNode('kfo-research-tools');
    lastResult = null;
    if (typeof KFORender === 'undefined' || typeof KFO === 'undefined') return;
    var migrated = fromStored(doc);
    var host = ensureHost('kfo-admin-report');
    if (!host) return;
    host.innerHTML = (migrated && migrated.kfo && migrated.kfo.availability === KFO.AVAILABILITY.AVAILABLE)
      ? KFORender.buildStoredHtml(migrated.kfo)
      : KFORender.unavailableHtml(migrated ? migrated.kfo : null,
          'Saved sessions store aggregate values only, and sessions saved before this feature existed ' +
          'store none at all. Pose keypoints are never persisted, so this cannot be recomputed retroactively.');
  }

  // ── Console helper ────────────────────────────────────────────────────────
  function help() {
    var lines = ['KFO flags (localStorage, prefix "' + STORAGE_PREFIX + '"):'];
    var st = flagState();
    Object.keys(st).forEach(function (k) {
      lines.push('  ' + (st[k].enabled ? '[on ] ' : '[off] ') + k + ' — ' + st[k].description);
    });
    lines.push('');
    lines.push('Toggle:  KFOApp.setFlag("experimentalComForceEstimator", true); location.reload();');
    lines.push('Reset:   KFOApp.clearFlag("experimentalComForceEstimator"); location.reload();');
    lines.push('One-off: append ?' + STORAGE_PREFIX + 'forceValidationTools=1 to the URL');
    var text = lines.join('\n');
    if (typeof console !== 'undefined') console.log(text);
    return text;
  }

  window.KFOApp = {
    STORAGE_PREFIX: STORAGE_PREFIX,
    FLAG_DEFS: FLAG_DEFS,
    isEnabled: isEnabled,
    setFlag: setFlag,
    clearFlag: clearFlag,
    flagState: flagState,
    getSamples: getSamples,
    analyze: analyze,
    getLastResult: getLastResult,
    render: render,
    renderSaved: renderSaved,
    storedFields: storedFields,
    fromStored: fromStored,
    help: help
  };
})();
