// ─────────────────────────────────────────────────────────────────────────────
//  PGI — application integration
//
//  Owns the feature flags, the session-context inputs (height, speed, surface),
//  the retained-sample accessors, the render dispatcher, the condition-capture
//  store for pre/post comparison, and the research export actions.
//
//  Everything is admin-gated. With every flag off this file does nothing, adds
//  no fields to a saved analysis, and causes no samples to be retained.
//
//  ROLLOUT. `projectionGroundInteraction` is on for admins by default;
//  `legacyKfoPanel` is OFF by default — the force-orientation panel it shows is
//  superseded by this feature and is kept only for regression comparison.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var STORAGE_PREFIX = 'esl-pgi-';
  var CONTEXT_KEY = 'esl-pgi-session-context';
  var CONDITIONS_KEY = 'esl-pgi-conditions';

  var FLAG_DEFS = {
    projectionGroundInteraction: {
      label: 'Projection & Ground Interaction',
      adminDefault: true, userDefault: false,
      description: 'The mechanics analysis: touchdown preparation, projection, ground interaction, ' +
        'rebound and stride outcome.'
    },
    requireLandmarkVerification: {
      label: 'Require stance-landmark verification',
      adminDefault: true, userDefault: false,
      description: 'The report is withheld until each used stance\u2019s touchdown, minimum-COM and ' +
        'toe-off frames have been reviewed and confirmed or corrected.'
    },
    densePreContactScan: {
      label: 'Dense pre-contact rescan',
      adminDefault: true, userDefault: false,
      description: 'Extra ~30 Hz pose pass around each touchdown so pre-contact foot velocity is ' +
        'resolvable. Desktop only; adds a few seconds to the scan.'
    },
    conditionComparison: {
      label: 'Condition comparison (pre/post)',
      adminDefault: true, userDefault: false,
      description: 'Capture two conditions and compare them.'
    },
    researchExport: {
      label: 'Research export',
      adminDefault: false, userDefault: false,
      description: 'Stride-level and frame-level CSV/JSON for validation work.'
    },
    legacyKfoPanel: {
      label: 'Legacy force-orientation panel',
      adminDefault: false, userDefault: false,
      description: 'Superseded by Projection & Ground Interaction. Comparison only.'
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

  // ── Session context ───────────────────────────────────────────────────────
  //
  // Height, running speed, surface and belt speed are not otherwise captured
  // anywhere in this pipeline. They are optional: without them the analysis
  // still runs and simply withholds the quantities that need them.

  function readContext() {
    try {
      var raw = localStorage.getItem(CONTEXT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return {};
  }
  function writeContext(ctx) {
    try { localStorage.setItem(CONTEXT_KEY, JSON.stringify(ctx || {})); } catch (e) { /* ignore */ }
  }
  function setContext(patch) {
    var ctx = readContext();
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] === null || patch[k] === '') delete ctx[k]; else ctx[k] = patch[k];
    });
    writeContext(ctx);
    return ctx;
  }

  // ── Retained samples ──────────────────────────────────────────────────────

  function getSamples() {
    var s = (typeof window !== 'undefined') ? window.__pgiSamples : null;
    return (s && s.length) ? s : null;
  }
  function getDenseWindows() {
    var d = (typeof window !== 'undefined') ? window.__pgiDenseWindows : null;
    return (d && d.length) ? d : null;
  }

  /** Whether the side scan should hand its samples over for retention. */
  function shouldCapture() {
    try { return isAdminUser() && isEnabled('projectionGroundInteraction'); }
    catch (e) { return false; }
  }
  /** Whether to run the extra pre-contact pose pass. Desktop only. */
  function shouldDenseScan() {
    try {
      if (!shouldCapture() || !isEnabled('densePreContactScan')) return false;
      return !(typeof IS_MOBILE_RUNNER !== 'undefined' && IS_MOBILE_RUNNER);
    } catch (e) { return false; }
  }

  var lastResult = null;
  function getLastResult() { return lastResult; }

  function analyze() {
    if (typeof PGIAnalysis === 'undefined') return null;
    var samples = getSamples();
    if (!samples) return null;
    var ctx = readContext();
    var vid = (typeof document !== 'undefined') ? document.getElementById('video-side') : null;
    var meta = {};
    if (vid) { meta.width = vid.videoWidth || null; meta.height = vid.videoHeight || null; }
    var ov = (verifyState.applied && verifyState.overrides) ? verifyState.overrides : null;
    lastResult = PGIAnalysis.analyze({
      samples: samples,
      denseWindows: getDenseWindows(),
      stanceOverrides: ov ? ov.stanceOverrides : null,
      minComOverrides: ov ? ov.minComOverrides : null,
      videoMetadata: meta,
      userHeightMeters: numOrNull(ctx.heightMeters),
      userSpeedMps: numOrNull(ctx.speedMps),
      treadmillSpeedMps: numOrNull(ctx.treadmillSpeedMps),
      surfaceType: ctx.surfaceType || 'unknown',
      bodyMassKg: numOrNull(ctx.bodyMassKg),
      conditionLabel: ctx.conditionLabel || null
    });
    return lastResult;
  }
  function numOrNull(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }

  // ── Condition capture (pre/post comparison) ───────────────────────────────

  function readConditions() {
    try {
      var raw = localStorage.getItem(CONDITIONS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return [];
  }
  function writeConditions(list) {
    try { localStorage.setItem(CONDITIONS_KEY, JSON.stringify(list || [])); } catch (e) { /* ignore */ }
  }
  /** Store the CURRENT analysis as a named condition for later comparison. */
  function captureCondition(labelText) {
    if (!lastResult || typeof PGIAnalysis === 'undefined') return null;
    var stored = PGIAnalysis.toStoredForm(lastResult);
    if (!stored) return null;
    var list = readConditions();
    var entry = {
      label: labelText || ('Condition ' + String.fromCharCode(65 + list.length)),
      capturedAt: new Date().toISOString(),
      result: stored
    };
    list.push(entry);
    // Only the two most recent conditions are kept: a comparison is pairwise,
    // and a growing list in localStorage is a quiet way to run out of quota.
    while (list.length > 2) list.shift();
    writeConditions(list);
    renderComparison();
    return entry;
  }
  function clearConditions() { writeConditions([]); renderComparison(); }

  function comparison() {
    if (typeof PGICompare === 'undefined') return null;
    var list = readConditions();
    if (list.length < 2) return null;
    return PGICompare.compare(
      { result: rehydrate(list[0].result), label: list[0].label },
      { result: rehydrate(list[1].result), label: list[1].label });
  }
  function rehydrate(stored) {
    if (typeof PGIAnalysis === 'undefined' || !PGIAnalysis.rehydrateStatic) return stored;
    try { return PGIAnalysis.rehydrateStatic(JSON.parse(JSON.stringify(stored))); }
    catch (e) { return stored; }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function removeNode(id) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function ensureHost(id, afterId) {
    if (typeof document === 'undefined') return null;
    var host = document.getElementById(id);
    if (host) return host;
    host = document.createElement('div');
    host.id = id;
    var anchor = afterId ? document.getElementById(afterId) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
    else {
      var section = document.getElementById('report-details') || document.getElementById('report-section');
      if (!section) return null;
      section.appendChild(host);
    }
    return host;
  }

  // ── Session-context input UI ──────────────────────────────────────────────

  function mountContextInputs() {
    var host = ensureHost('pgi-context');
    if (!host) return;
    var ctx = readContext();
    function field(name, labelText, placeholder, value, type) {
      return '<label style="display:flex;flex-direction:column;gap:3px;font-size:10px;' +
        'color:var(--muted2,#8aa0c0);text-transform:uppercase;letter-spacing:.5px">' + labelText +
        '<input data-pgi-ctx="' + name + '" type="' + (type || 'number') + '" step="0.01" ' +
        'placeholder="' + placeholder + '" value="' + (value == null ? '' : value) + '" ' +
        'style="font:inherit;font-size:12px;text-transform:none;letter-spacing:0;padding:5px 7px;' +
        'border-radius:6px;border:1px solid var(--border2,#2a3550);background:transparent;' +
        'color:inherit;width:110px"></label>';
    }
    host.innerHTML =
      '<div style="margin-top:14px;padding:12px 14px;border:1px solid var(--border2,#2a3550);' +
      'border-radius:10px;background:var(--panel2,#121724)">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:8px">Session context (optional)</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' +
      field('heightMeters', 'Height (m)', '1.78', ctx.heightMeters) +
      field('speedMps', 'Speed (m/s)', 'e.g. 3.5', ctx.speedMps) +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--muted2,#8aa0c0);' +
      'text-transform:uppercase;letter-spacing:.5px">Surface' +
      '<select data-pgi-ctx="surfaceType" style="font:inherit;font-size:12px;text-transform:none;' +
      'letter-spacing:0;padding:5px 7px;border-radius:6px;border:1px solid var(--border2,#2a3550);' +
      'background:transparent;color:inherit;width:118px">' +
      ['unknown', 'overground', 'treadmill'].map(function (o) {
        return '<option value="' + o + '"' + (ctx.surfaceType === o ? ' selected' : '') + '>' +
          o.charAt(0).toUpperCase() + o.slice(1) + '</option>';
      }).join('') + '</select></label>' +
      field('treadmillSpeedMps', 'Belt (m/s)', 'if treadmill', ctx.treadmillSpeedMps) +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--muted2,#8aa0c0);' +
      'text-transform:uppercase;letter-spacing:.5px">Condition label' +
      '<input data-pgi-ctx="conditionLabel" type="text" placeholder="e.g. Post cue" value="' +
      (ctx.conditionLabel || '') + '" style="font:inherit;font-size:12px;text-transform:none;' +
      'letter-spacing:0;padding:5px 7px;border-radius:6px;border:1px solid var(--border2,#2a3550);' +
      'background:transparent;color:inherit;width:130px"></label>' +
      '<button type="button" data-pgi="recompute" style="font:inherit;font-size:11px;padding:6px 12px;' +
      'border-radius:6px;border:1px solid var(--border2,#2a3550);background:transparent;color:inherit;' +
      'cursor:pointer">Apply</button>' +
      '</div>' +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);line-height:1.5;margin-top:8px">' +
      'All optional. Height enables real-world lengths; speed enables stride-length and ' +
      'flight-distance figures. Without them those results are withheld rather than estimated.</div>' +
      '</div>';

    host.querySelectorAll('[data-pgi-ctx]').forEach(function (el) {
      el.addEventListener('change', function () {
        var patch = {};
        patch[el.getAttribute('data-pgi-ctx')] = el.value;
        setContext(patch);
      });
    });
    var btn = host.querySelector('[data-pgi="recompute"]');
    if (btn) btn.addEventListener('click', function () { render(); });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function render() {
    if (!isAdminUser()) return;

    if (isEnabled('projectionGroundInteraction')) {
      try {
        mountContextInputs();
        var result = analyze();
        if (!result) {
          mountMessage('pgi-report',
            'Projection & Ground Interaction needs the side-view scan data from this session. ' +
            'Re-run the analysis from the upload screen to populate it.');
          removeNode('pgi-verify');
        } else if (isEnabled('requireLandmarkVerification') && !verificationComplete(result)) {
          // FORCED verification: the report is not shown until every used
          // stance's landmark frames have been confirmed or corrected. The
          // automatic picks are coarse enough to be visibly wrong, and every
          // downstream number reads them.
          mountVerificationPanel(result);
          mountMessage('pgi-report',
            'Report withheld until the stance landmarks below are verified. Confirm each ' +
            'stance\u2019s frames \u2014 or correct them \u2014 then apply.');
        } else {
          removeNode('pgi-verify');
          if (typeof PGIRender !== 'undefined') PGIRender.mount(result, 'pgi-report');
        }
        if (isEnabled('conditionComparison')) mountConditionControls();
        renderComparison();
        if (isEnabled('researchExport')) mountResearchTools();
        else removeNode('pgi-research-tools');
      } catch (e) {
        console.error('[pgi] render failed:', e);
      }
    } else {
      ['pgi-context', 'pgi-report', 'pgi-verify', 'pgi-conditions', 'pgi-comparison',
       'pgi-research-tools'].forEach(removeNode);
    }

    // The superseded force-orientation panel, off by default.
    if (isEnabled('legacyKfoPanel') && typeof KFOApp !== 'undefined') {
      try { KFOApp.render(true); } catch (e) { console.error('[pgi] legacy kfo render failed:', e); }
    } else {
      removeNode('kfo-admin-report');
      removeNode('kfo-research-tools');
    }
  }

  function mountMessage(id, text) {
    var host = ensureHost(id);
    if (!host) return;
    host.innerHTML = '<div style="margin-top:22px;padding:14px;border:1px solid var(--border2,#2a3550);' +
      'border-radius:10px;background:var(--panel2,#121724);font-size:12px;line-height:1.6">' +
      String(text).replace(/[<>]/g, '') + '</div>';
  }

  function mountConditionControls() {
    var host = ensureHost('pgi-conditions', 'pgi-report');
    if (!host) return;
    var list = readConditions();
    var chips = list.map(function (c) {
      return '<span style="font-size:11px;padding:3px 9px;border-radius:99px;' +
        'border:1px solid var(--border2,#2a3550)">' +
        String(c.label).replace(/[<>]/g, '') + '</span>';
    }).join(' ');
    host.innerHTML =
      '<div style="margin-top:12px;padding:12px 14px;border:1px solid var(--border2,#2a3550);' +
      'border-radius:10px;background:var(--panel2,#121724)">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:8px">Condition comparison</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<button type="button" data-pgi="capture" style="font:inherit;font-size:11px;padding:6px 12px;' +
      'border-radius:6px;border:1px solid var(--border2,#2a3550);background:transparent;color:inherit;' +
      'cursor:pointer">Capture this analysis</button>' +
      (list.length ? '<button type="button" data-pgi="clear" style="font:inherit;font-size:11px;' +
        'padding:6px 12px;border-radius:6px;border:1px solid var(--border2,#2a3550);' +
        'background:transparent;color:inherit;cursor:pointer">Clear</button>' : '') +
      (chips ? '<span style="display:flex;gap:6px;flex-wrap:wrap">' + chips + '</span>' : '') +
      '</div>' +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);line-height:1.5;margin-top:7px">' +
      'Capture one analysis, then analyse the second clip and capture it too. The two most recent ' +
      'captures are compared. Set a condition label above before capturing.</div></div>';

    var cap = host.querySelector('[data-pgi="capture"]');
    if (cap) cap.addEventListener('click', function () {
      var ctx = readContext();
      captureCondition(ctx.conditionLabel || null);
      mountConditionControls();
    });
    var clr = host.querySelector('[data-pgi="clear"]');
    if (clr) clr.addEventListener('click', function () { clearConditions(); mountConditionControls(); });
  }

  function renderComparison() {
    if (!isAdminUser() || !isEnabled('projectionGroundInteraction') ||
        !isEnabled('conditionComparison')) {
      removeNode('pgi-comparison');
      return;
    }
    var cmp = comparison();
    if (!cmp) { removeNode('pgi-comparison'); return; }
    if (typeof PGIRender !== 'undefined') PGIRender.mountComparison(cmp, 'pgi-comparison');
  }

  // ── Research export ───────────────────────────────────────────────────────

  function mountResearchTools() {
    if (typeof PGIExport === 'undefined' || !lastResult) return;
    var host = ensureHost('pgi-research-tools');
    if (!host) return;
    host.innerHTML =
      '<div style="margin-top:12px;padding:14px;border:1px solid var(--border2,#2a3550);border-radius:10px;' +
      'background:var(--panel2,#121724)">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:7px">Research export (admin)</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      ['json:Download JSON', 'strides:Stride CSV', 'frames:Frame CSV',
       'framesLm:Frame CSV (with landmarks)'].map(function (spec) {
        var parts = spec.split(':');
        return '<button type="button" data-pgi-export="' + parts[0] + '" style="font:inherit;' +
          'font-size:11px;padding:6px 11px;border-radius:6px;border:1px solid var(--border2,#2a3550);' +
          'background:transparent;color:inherit;cursor:pointer">' + parts[1] + '</button>';
      }).join('') +
      '</div><div data-pgi="out" style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:9px;' +
      'line-height:1.6"></div></div>';

    var out = host.querySelector('[data-pgi="out"]');
    function download(name, text, mime) {
      var blob = new Blob([text], { type: mime || 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }
    host.querySelectorAll('button[data-pgi-export]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-pgi-export');
        try {
          var ctx = readContext();
          var b = PGIExport.buildExport(lastResult, getSamples(), {
            analysisId: 'session-' + Date.now(),
            conditionLabel: ctx.conditionLabel || null,
            includeLandmarks: kind === 'framesLm'
          });
          if (kind === 'json') download('pgi-export.json', JSON.stringify(b, null, 2), 'application/json');
          if (kind === 'strides') download('pgi-strides.csv', b.csv.strides, 'text/csv');
          if (kind === 'frames' || kind === 'framesLm') {
            download('pgi-frames.csv', b.csv.frames, 'text/csv');
          }
          out.textContent = 'Exported ' + b.strideLevel.length + ' stride rows and ' +
            b.frameLevel.length + ' frame rows.';
        } catch (e) { out.textContent = 'Export failed: ' + e.message; }
      });
    });
  }

  // ── Stance-landmark verification ──────────────────────────────────────────
  //
  // FORCED workflow (flag `requireLandmarkVerification`, default on): the
  // report is withheld until each used stance's touchdown, minimum-COM and
  // toe-off frames have been reviewed. Nudging an event reseeks the video and
  // redraws; confirming all stances enables re-analysis with the corrections
  // applied at the stance-detection source. Queue/override logic lives in
  // pgi-verify.js (node-tested); this is the DOM/video half.

  var verifyState = { samplesRef: null, items: null, applied: false, overrides: null };

  function verificationComplete(result) {
    ensureVerifyQueue(result);
    if (!verifyState.items || !verifyState.items.length) return true; // nothing to verify
    return verifyState.applied;
  }

  function ensureVerifyQueue(result) {
    var samples = getSamples();
    if (verifyState.samplesRef !== samples) {
      // New clip: any previous verification belonged to different footage.
      verifyState = { samplesRef: samples, items: null, applied: false, overrides: null };
    }
    if (!verifyState.items && typeof PGIVerify !== 'undefined' && result) {
      verifyState.items = PGIVerify.buildQueue(result);
    }
  }

  function nearestSample(t) {
    var samples = getSamples();
    if (!samples) return null;
    var best = null;
    samples.forEach(function (s) {
      if (!s || typeof s.t !== 'number' || !s.kps) return;
      if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    });
    return best;
  }

  function drawInspectorFrame(canvas, video, sample, side, eventName, t) {
    var ctx = canvas.getContext('2d');
    var vw = video.videoWidth || 640, vh = video.videoHeight || 360;
    var W = canvas.width, H = Math.round(W * vh / vw);
    canvas.height = H;
    ctx.drawImage(video, 0, 0, W, H);
    if (!sample || !sample.kps) return;

    // Samples were posed on the scan canvas; rescale through its frame width.
    var scale = W / (sample.frameWidth || 400);
    function P(i) {
      var k = sample.kps[i];
      return (k && typeof k.x === 'number' && (k.score || 0) >= 0.25)
        ? { x: k.x * scale, y: k.y * scale } : null;
    }
    function mid(a, b) { return (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }
    function line(a, b, color, width, dash) {
      if (!a || !b) return;
      ctx.beginPath();
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = color; ctx.lineWidth = width || 2;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    function dot(p, color, r) {
      if (!p) return;
      ctx.beginPath(); ctx.fillStyle = color;
      ctx.arc(p.x, p.y, r || 5, 0, Math.PI * 2); ctx.fill();
    }

    var hip = P(side === 'left' ? 11 : 12);
    var knee = P(side === 'left' ? 13 : 14);
    var ankle = P(side === 'left' ? 15 : 16);
    var shMid = mid(P(5), P(6)), hipMid = mid(P(11), P(12));
    var comRaw = (typeof KFO !== 'undefined') ? KFO.computeCOM(sample.kps, 'segmental') : null;
    var com = comRaw ? { x: comRaw.x * scale, y: comRaw.y * scale } : null;

    line(shMid, hipMid, 'rgba(77,163,255,.9)', 3);          // trunk
    line(hip, knee, 'rgba(61,220,151,.9)', 3);              // thigh
    line(knee, ankle, 'rgba(61,220,151,.9)', 3);            // shank
    line(ankle, com, 'rgba(255,176,32,.9)', 2, [6, 4]);     // support line
    dot(ankle, 'rgba(61,220,151,1)', 5);                    // support point
    dot(com, 'rgba(255,176,32,1)', 6);                      // COM

    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 3;
    var caption = eventName + '  ·  ' + t.toFixed(3) + ' s  ·  ' + side + ' stance';
    ctx.strokeText(caption, 10, H - 12);
    ctx.fillText(caption, 10, H - 12);
  }


  function verifyThumb(itemId, eventKey) {
    return '<div style="flex:1 1 150px;min-width:140px">' +
      '<div style="font-size:9.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:3px">' + PGIVerify.EVENT_LABEL[eventKey] + '</div>' +
      '<canvas data-verify-canvas="' + itemId + ':' + eventKey + '" width="220" height="124" ' +
      'style="width:100%;border-radius:6px;background:#000"></canvas>' +
      '<div style="display:flex;gap:3px;margin-top:4px;align-items:center;flex-wrap:wrap">' +
      [['-33', '\u25c0\u25c0'], ['-8', '\u25c0'], ['8', '\u25b6'], ['33', '\u25b6\u25b6']].map(function (b) {
        return '<button type="button" data-verify-nudge="' + itemId + ':' + eventKey + ':' + b[0] +
          '" style="font:inherit;font-size:10px;padding:3px 7px;border-radius:5px;' +
          'border:1px solid var(--border2,#2a3550);background:transparent;color:inherit;' +
          'cursor:pointer" title="' + b[0] + ' ms">' + b[1] + '</button>';
      }).join('') +
      '<span data-verify-time="' + itemId + ':' + eventKey + '" style="font-size:10px;' +
      'color:var(--muted2,#8aa0c0);margin-left:3px"></span>' +
      '</div></div>';
  }

  function mountVerificationPanel(result) {
    ensureVerifyQueue(result);
    var items = verifyState.items || [];
    var video = (typeof document !== 'undefined') ? document.getElementById('video-side') : null;
    if (!items.length || !video || typeof PGIVerify === 'undefined') { removeNode('pgi-verify'); return; }
    var host = ensureHost('pgi-verify', 'pgi-context');
    if (!host) return;

    var confirmed = items.filter(function (i) { return i.confirmed; }).length;
    var rows = items.map(function (i, idx) {
      var mcConf = (typeof i.minComConfidence === 'number')
        ? ' \u00b7 auto confidence ' + Math.round(i.minComConfidence * 100) + '%' : '';
      return '<div data-verify-row="' + i.id + '" style="margin-top:12px;padding:11px;border-radius:8px;' +
        'border:1px solid ' + (i.confirmed ? 'var(--good,#3ddc97)' : 'var(--border2,#2a3550)') + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<div style="font-size:11.5px;font-weight:700">' + (idx + 1) + ' \u00b7 ' +
        (i.side === 'left' ? 'Left' : 'Right') + ' stance at ' + i.autoStart.toFixed(2) + ' s' +
        '<span style="font-weight:400;color:var(--muted2,#8aa0c0)">' + mcConf + '</span></div>' +
        '<button type="button" data-verify-confirm="' + i.id + '" style="font:inherit;font-size:11px;' +
        'padding:5px 12px;border-radius:6px;border:1px solid ' +
        (i.confirmed ? 'var(--good,#3ddc97)' : 'var(--border2,#2a3550)') + ';background:transparent;' +
        'color:' + (i.confirmed ? 'var(--good,#3ddc97)' : 'inherit') + ';cursor:pointer">' +
        (i.confirmed ? '\u2713 Confirmed' : 'Confirm frames') + '</button></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
        PGIVerify.EVENTS.map(function (ev) {
          return (ev === 'minimumCom' && typeof i.minCom !== 'number') ? '' : verifyThumb(i.id, ev);
        }).join('') + '</div></div>';
    }).join('');

    host.innerHTML =
      '<div style="margin-top:14px;padding:14px;border:1.5px solid var(--warn,#ffb020);' +
      'border-radius:10px;background:var(--panel2,#121724)">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--warn,#ffb020);margin-bottom:6px">Verify stance landmarks \u2014 required</div>' +
      '<div style="font-size:11.5px;line-height:1.6;max-width:640px">Check that each frame shows what ' +
      'its label claims: <strong>touchdown</strong> \u2014 first frame the foot is on the ground; ' +
      '<strong>minimum COM</strong> \u2014 the body\u2019s lowest point (amber dot at its lowest); ' +
      '<strong>toe-off</strong> \u2014 last frame of contact. Nudge with the arrows if a frame is ' +
      'wrong, then confirm each stance. The analysis re-runs with your corrections.</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">' +
      '<button type="button" data-verify="confirm-all" style="font:inherit;font-size:11px;' +
      'padding:6px 12px;border-radius:6px;border:1px solid var(--border2,#2a3550);' +
      'background:transparent;color:inherit;cursor:pointer">Confirm all as shown</button>' +
      '<button type="button" data-verify="apply" ' + (confirmed === items.length ? '' : 'disabled ') +
      'style="font:inherit;font-size:11px;font-weight:700;padding:6px 14px;border-radius:6px;' +
      'border:1px solid var(--gold,#f5c451);background:' +
      (confirmed === items.length ? 'var(--gold,#f5c451)' : 'transparent') + ';color:' +
      (confirmed === items.length ? '#1a1400' : 'var(--muted2,#8aa0c0)') + ';cursor:pointer">' +
      'Apply &amp; analyze</button>' +
      '<span style="font-size:11px;color:var(--muted2,#8aa0c0)">' + confirmed + '/' + items.length +
      ' stances confirmed</span></div>' +
      rows + '</div>';

    // ── Wiring ──
    function itemById(id) {
      for (var k = 0; k < items.length; k++) if (items[k].id === id) return items[k];
      return null;
    }

    // Thumbnails are drawn through one serial seek queue: a <video> can only be
    // at one time at once, so parallel seeks would race each other.
    var drawQueue = [];
    var drawing = false;
    function enqueueDraw(itemId, eventKey) {
      drawQueue.push([itemId, eventKey]);
      if (!drawing) drawNext();
    }
    function drawNext() {
      var job = drawQueue.shift();
      if (!job) { drawing = false; return; }
      drawing = true;
      var item = itemById(job[0]);
      var canvas = host.querySelector('[data-verify-canvas="' + job[0] + ':' + job[1] + '"]');
      if (!item || !canvas) { drawNext(); return; }
      var t = PGIVerify.timeOf(item, job[1]);
      if (typeof t !== 'number') { drawNext(); return; }
      var timeEl = host.querySelector('[data-verify-time="' + job[0] + ':' + job[1] + '"]');
      if (timeEl) timeEl.textContent = t.toFixed(3) + ' s';
      var done = false;
      var finish = function () {
        if (done) return; done = true;
        video.removeEventListener('seeked', finish);
        try {
          drawInspectorFrame(canvas, video, nearestSample(t), item.side,
            PGIVerify.EVENT_LABEL[job[1]].toUpperCase(), t);
        } catch (e) { /* a failed thumbnail must not stall the queue */ }
        setTimeout(drawNext, 30);
      };
      video.addEventListener('seeked', finish);
      setTimeout(finish, 900); // seek watchdog
      try { video.currentTime = t; } catch (e) { finish(); }
    }

    host.querySelectorAll('[data-verify-nudge]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var parts = btn.getAttribute('data-verify-nudge').split(':');
        var item = itemById(parts[0]);
        if (!item) return;
        PGIVerify.nudge(item, parts[1], parseInt(parts[2], 10) / 1000, video.duration || null);
        // A nudge un-confirms the stance; rebuild so the row state shows it,
        // then redraw the affected thumbnails.
        mountVerificationPanel(result);
      });
    });
    host.querySelectorAll('[data-verify-confirm]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = itemById(btn.getAttribute('data-verify-confirm'));
        if (!item) return;
        item.confirmed = !item.confirmed;
        mountVerificationPanel(result);
      });
    });
    var allBtn = host.querySelector('[data-verify="confirm-all"]');
    if (allBtn) allBtn.addEventListener('click', function () {
      items.forEach(function (i) { i.confirmed = true; });
      mountVerificationPanel(result);
    });
    var applyBtn = host.querySelector('[data-verify="apply"]');
    if (applyBtn) applyBtn.addEventListener('click', function () {
      if (!PGIVerify.allConfirmed(items)) return;
      verifyState.overrides = PGIVerify.toOverrides(items);
      verifyState.applied = true;
      render();
    });

    // Draw every visible thumbnail, serially.
    items.forEach(function (i) {
      PGIVerify.EVENTS.forEach(function (ev) {
        if (ev === 'minimumCom' && typeof i.minCom !== 'number') return;
        enqueueDraw(i.id, ev);
      });
    });
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Fields merged into a saved-analysis document. Returns an EMPTY object unless
   * the feature is active, so a save by a user without it is byte-identical to a
   * pre-feature save.
   */
  function storedFields() {
    try {
      if (!isAdminUser() || !isEnabled('projectionGroundInteraction')) return {};
      if (typeof PGIAnalysis === 'undefined') return {};
      var result = lastResult || analyze();
      if (!result) return {};
      var stored = PGIAnalysis.toStoredForm(result);
      return stored ? { pgi: stored } : {};
    } catch (e) {
      console.warn('[pgi] stored fields skipped:', e.message);
      return {};
    }
  }

  function fromStored(doc) {
    if (typeof PGIAnalysis === 'undefined') return null;
    return PGIAnalysis.migrateAnalysis(doc);
  }

  /**
   * Render a SAVED analysis. Never recomputes: a saved session holds no
   * keypoints, and the retained sample buffer may belong to a different clip.
   */
  function renderSaved(doc) {
    if (!isAdminUser() || !isEnabled('projectionGroundInteraction')) {
      ['pgi-context', 'pgi-report', 'pgi-verify', 'pgi-conditions', 'pgi-comparison',
       'pgi-research-tools'].forEach(removeNode);
      return;
    }
    ['pgi-context', 'pgi-verify', 'pgi-conditions', 'pgi-comparison',
     'pgi-research-tools'].forEach(removeNode);
    lastResult = null;
    if (typeof PGIRender === 'undefined' || typeof PGIAnalysis === 'undefined') return;
    var migrated = fromStored(doc);
    var host = ensureHost('pgi-report');
    if (!host) return;

    if (migrated && migrated.generation === 'pgi' && migrated.pgi) {
      var view = PGIAnalysis.rehydrateStatic(migrated.pgi);
      host.innerHTML = PGIRender.buildHtml(view);
      return;
    }
    // A legacy session: show what it actually holds, labelled, and never
    // reinterpreted as a projection or ground-interaction measurement.
    var extra = migrated && migrated.generation === 'kfo'
      ? 'This session was analysed under the earlier force-orientation model. Its stored values are ' +
        'not converted into these metrics. Pose keypoints are never saved, so it cannot be ' +
        'recomputed retroactively.'
      : 'This session was saved before the mechanics analysis existed. Pose keypoints are never ' +
        'saved, so it cannot be recomputed retroactively.';
    host.innerHTML = PGIRender.unavailableHtml(migrated ? migrated.pgi : null, extra);
    if (migrated && migrated.generation === 'kfo' && isEnabled('legacyKfoPanel') &&
        typeof KFOApp !== 'undefined') {
      try { KFOApp.renderSaved(doc, true); } catch (e) { /* legacy panel is best-effort */ }
    }
  }

  // ── Console helper ────────────────────────────────────────────────────────

  function help() {
    var lines = ['PGI flags (localStorage, prefix "' + STORAGE_PREFIX + '"):'];
    var st = flagState();
    Object.keys(st).forEach(function (k) {
      lines.push('  ' + (st[k].enabled ? '[on ] ' : '[off] ') + k + ' — ' + st[k].description);
    });
    lines.push('');
    lines.push('Context: PGIApp.setContext({heightMeters:1.78, speedMps:3.5, surfaceType:"overground"})');
    lines.push('Compare: PGIApp.captureCondition("Pre cue")  … then analyse clip 2 and capture again');
    lines.push('Toggle:  PGIApp.setFlag("researchExport", true); location.reload();');
    lines.push('One-off: append ?' + STORAGE_PREFIX + 'researchExport=1 to the URL');
    var text = lines.join('\n');
    if (typeof console !== 'undefined') console.log(text);
    return text;
  }

  window.PGIApp = {
    STORAGE_PREFIX: STORAGE_PREFIX,
    FLAG_DEFS: FLAG_DEFS,
    isEnabled: isEnabled,
    setFlag: setFlag,
    clearFlag: clearFlag,
    flagState: flagState,
    readContext: readContext,
    setContext: setContext,
    getSamples: getSamples,
    getDenseWindows: getDenseWindows,
    shouldCapture: shouldCapture,
    shouldDenseScan: shouldDenseScan,
    analyze: analyze,
    getLastResult: getLastResult,
    captureCondition: captureCondition,
    clearConditions: clearConditions,
    readConditions: readConditions,
    comparison: comparison,
    render: render,
    renderSaved: renderSaved,
    storedFields: storedFields,
    fromStored: fromStored,
    help: help
  };
})();
