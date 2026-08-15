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
    lastResult = PGIAnalysis.analyze({
      samples: samples,
      denseWindows: getDenseWindows(),
      // The stance edges the user selected and submitted on the phase cards
      // (initial contact + toe-off per side, adjustable via the scrubber) are
      // the ground truth for stance detection. Minimum COM stays auto-detected.
      userStanceEvents: readUserStanceEvents(),
      stanceEdits: stanceEditsForAnalysis(),
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

  /**
   * The user-reviewed stance events from the main product flow: the l_foot /
   * l_toe / r_foot / r_toe phase cards, auto-detected then adjusted by the user
   * with the frame scrubber. Re-analysing a card re-renders this feature, so a
   * scrubber correction flows straight through.
   */
  function readUserStanceEvents() {
    try {
      if (typeof phases === 'undefined' || !phases) return null;
      function side(footKey, toeKey) {
        var f = phases[footKey], t = phases[toeKey];
        if (!f || !t || !f.detected || !t.detected) return null;
        var fs = numOrNull(f.t), to = numOrNull(t.t);
        if (fs == null || to == null || !(to > fs)) return null;
        return { footStrikeTime: fs, toeOffTime: to };
      }
      var out = { left: side('l_foot', 'l_toe'), right: side('r_foot', 'r_toe') };
      return (out.left || out.right) ? out : null;
    } catch (e) { return null; }
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

  // ── Stance-landmark cards (frame-scrub review) ─────────────────────────────
  //
  // The same interface the product already uses for phase frames: a card grid
  // (one card per landmark — touchdown and toe-off for every used stance) and
  // the familiar expand panel with the frame scrubber, working on the ORIGINAL
  // video frames. Two deliberate differences from the first, abandoned
  // verification UI:
  //
  //   1. Cards, not a blob: each landmark is its own navigable card, and the
  //      expand panel has Prev/Next so the whole set can be walked without
  //      closing it.
  //   2. The overlay is re-posed on EVERY scrubbed frame (detector.estimatePoses
  //      on the current frame, like "Analyze this frame") — never a stale
  //      overlay that stays put while the video moves.
  //
  // Lowest-COM stays automatic; only touchdown and toe-off are editable here.
  // Edits apply per stance, verbatim, through the same override path as the
  // phase-card anchors, and outrank them.

  var landmarkState = { samplesRef: null, stances: null, edits: {} };

  function editKey(side, autoStart) { return side + ':' + Math.round(autoStart * 1000); }

  /** Detected stances (with toe-off refinement, before any user overrides). */
  function rawStances() {
    var samples = getSamples();
    if (!samples) return null;
    if (landmarkState.samplesRef !== samples) {
      landmarkState = { samplesRef: samples, stances: null, edits: {} };
    }
    if (!landmarkState.stances && typeof KFOAnalysis !== 'undefined') {
      var list = [];
      ['left', 'right'].forEach(function (side) {
        KFOAnalysis.detectStanceIntervals(samples, side).accepted.forEach(function (iv) {
          list.push({ side: side, autoStart: iv.startTime, autoEnd: iv.endTime,
                      refined: !!iv.toeOffRefinement });
        });
      });
      list.sort(function (a, b) { return a.autoStart - b.autoStart; });
      var counters = { left: 0, right: 0 };
      list.forEach(function (st) {
        counters[st.side]++;
        st.label = (st.side === 'left' ? 'L' : 'R') + counters[st.side];
        st.key = editKey(st.side, st.autoStart);
      });
      landmarkState.stances = list;
    }
    return landmarkState.stances;
  }

  function stanceEditsForAnalysis() {
    var out = [];
    var stances = landmarkState.stances || [];
    stances.forEach(function (st) {
      var ed = landmarkState.edits[st.key];
      if (!ed) return;
      out.push({ side: st.side, autoStartTime: st.autoStart,
                 startTime: ed.startTime, endTime: ed.endTime });
    });
    return out;
  }

  /** The time a landmark currently uses: the edit if present, else detection. */
  function landmarkTime(st, eventKey) {
    var ed = landmarkState.edits[st.key] || {};
    if (eventKey === 'touchdown') {
      return typeof ed.startTime === 'number' ? ed.startTime : st.autoStart;
    }
    return typeof ed.endTime === 'number' ? ed.endTime : st.autoEnd;
  }
  function landmarkEdited(st, eventKey) {
    var ed = landmarkState.edits[st.key] || {};
    return eventKey === 'touchdown'
      ? typeof ed.startTime === 'number' : typeof ed.endTime === 'number';
  }

  /** Flat, ordered landmark list — the navigation order for cards and Prev/Next. */
  function landmarkList() {
    var stances = rawStances() || [];
    var out = [];
    stances.forEach(function (st) {
      out.push({ stance: st, event: 'touchdown', name: st.label + ' \u00b7 Touchdown',
                 desc: 'First frame the foot is on the ground' });
      out.push({ stance: st, event: 'toeoff', name: st.label + ' \u00b7 Toe-off',
                 desc: 'Last frame of contact \u2014 toes leaving, not heel rising' });
    });
    return out;
  }

  // ── Overlay drawing (shared by cards and the expand panel) ────────────────

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

  /**
   * Skeleton + COM + support line for one frame. `kps` and `kpsFrameWidth`
   * define the coordinate space the keypoints live in; they are rescaled to the
   * canvas. Live-pose callers pass keypoints estimated on the canvas itself
   * (kpsFrameWidth = canvas width); card thumbnails pass a retained scan sample.
   */
  function drawLandmarkOverlay(canvas, kps, kpsFrameWidth, side) {
    if (!kps) return;
    var ctx = canvas.getContext('2d');
    var scale = canvas.width / (kpsFrameWidth || canvas.width);
    if (typeof drawPose === 'function' && scale === 1) {
      try { drawPose(ctx, kps, canvas.width, canvas.height); } catch (e) { /* overlay only */ }
    }
    function P(i) {
      var k = kps[i];
      return (k && typeof k.x === 'number' && (k.score || 0) >= 0.25)
        ? { x: k.x * scale, y: k.y * scale } : null;
    }
    var ankle = P(side === 'left' ? 15 : 16);
    var comRaw = (typeof KFO !== 'undefined') ? KFO.computeCOM(kps, 'segmental') : null;
    var com = comRaw ? { x: comRaw.x * scale, y: comRaw.y * scale } : null;
    if (ankle && com) {
      ctx.beginPath(); ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,176,32,.9)'; ctx.lineWidth = 2;
      ctx.moveTo(ankle.x, ankle.y); ctx.lineTo(com.x, com.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ankle) { ctx.beginPath(); ctx.fillStyle = 'rgba(61,220,151,1)'; ctx.arc(ankle.x, ankle.y, 5, 0, Math.PI * 2); ctx.fill(); }
    if (com) { ctx.beginPath(); ctx.fillStyle = 'rgba(255,176,32,1)'; ctx.arc(com.x, com.y, 6, 0, Math.PI * 2); ctx.fill(); }
  }

  // ── Card grid ──────────────────────────────────────────────────────────────

  var thumbQueue = [], thumbBusy = false;
  function queueThumb(idx) {
    if (thumbQueue.indexOf(idx) === -1) thumbQueue.push(idx);
    if (!thumbBusy) nextThumb();
  }
  function nextThumb() {
    var idx = thumbQueue.shift();
    if (idx == null) { thumbBusy = false; return; }
    thumbBusy = true;
    var video = document.getElementById('video-side');
    var host = document.getElementById('pgi-landmark-cards');
    var canvas = host && host.querySelector('[data-pgi-lm-canvas="' + idx + '"]');
    var lm = landmarkList()[idx];
    if (!video || !canvas || !lm) { nextThumb(); return; }
    var t = landmarkTime(lm.stance, lm.event);
    var done = false;
    var finish = function () {
      if (done) return; done = true;
      video.removeEventListener('seeked', finish);
      try {
        var vw = video.videoWidth || 640, vh = video.videoHeight || 360;
        canvas.width = 320; canvas.height = Math.round(320 * vh / vw);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        // Thumbnails use the nearest retained sample for the overlay — cheap
        // and close enough at card size. The expand panel re-poses live.
        var smp = nearestSample(t);
        if (smp) drawLandmarkOverlay(canvas, smp.kps, smp.frameWidth || null, lm.stance.side);
      } catch (e) { /* thumbnail only */ }
      setTimeout(nextThumb, 25);
    };
    video.addEventListener('seeked', finish);
    setTimeout(finish, 900);
    try { video.currentTime = t; } catch (e) { finish(); }
  }

  function refreshLandmarkCardMeta(idx) {
    var host = document.getElementById('pgi-landmark-cards');
    if (!host) return;
    var lm = landmarkList()[idx];
    if (!lm) return;
    var timeEl = host.querySelector('[data-pgi-lm-time="' + idx + '"]');
    if (timeEl) timeEl.textContent = landmarkTime(lm.stance, lm.event).toFixed(2) + 's';
    var badge = host.querySelector('[data-pgi-lm-badge="' + idx + '"]');
    if (badge) {
      var edited = landmarkEdited(lm.stance, lm.event);
      var refined = lm.event === 'toeoff' && lm.stance.refined;
      badge.className = 'pc-badge ' + (edited ? 'ok' : refined ? 'ok' : 'pending');
      badge.textContent = edited ? 'edited' : refined ? 'refined' : 'auto';
    }
  }

  function mountLandmarkCards() {
    var list = landmarkList();
    var video = document.getElementById('video-side');
    if (!list.length || !video) { removeNode('pgi-landmark-cards'); return; }
    var host = document.getElementById('pgi-landmark-cards');
    var rebuilt = false;
    if (!host || host.getAttribute('data-count') !== String(list.length)) {
      host = ensureHost('pgi-landmark-cards', 'pgi-context');
      if (!host) return;
      host.setAttribute('data-count', String(list.length));
      rebuilt = true;
      host.innerHTML =
        '<div class="phase-group" style="margin-top:14px">' +
        '<div class="phase-group-label">Stance landmarks \u2014 tap a card to check the exact frame</div>' +
        '<div style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.5;margin:2px 0 8px">' +
        'Touchdown and toe-off drive every timing number below. Scrub any card that looks wrong; ' +
        'lowest-COM stays automatic.</div>' +
        '<div class="phase-group-cards">' +
        list.map(function (lm, idx) {
          return '<div class="phase-card" data-pgi-lm-card="' + idx + '">' +
            '<div class="pc-hdr"><div class="pc-num">' + (idx + 1) + '</div>' +
            '<div class="pc-name-wrap"><div class="pc-name">' + lm.name + '</div>' +
            '<div class="pc-desc">' + lm.desc + '</div></div>' +
            '<div class="pc-badge pending" data-pgi-lm-badge="' + idx + '">auto</div></div>' +
            '<div class="pc-canvas-wrap"><canvas class="pc-canvas" data-pgi-lm-canvas="' + idx + '"></canvas></div>' +
            '<div class="pc-footer"><span class="pc-time-display" data-pgi-lm-time="' + idx + '"></span>' +
            '<span class="pc-expand-hint">&#8599; Click to adjust</span></div>' +
            '</div>';
        }).join('') + '</div></div>';
      host.querySelectorAll('[data-pgi-lm-card]').forEach(function (card) {
        card.addEventListener('click', function () {
          openPgiExpand(parseInt(card.getAttribute('data-pgi-lm-card'), 10));
        });
      });
    }
    list.forEach(function (lm, idx) {
      refreshLandmarkCardMeta(idx);
      if (rebuilt) queueThumb(idx);
    });
  }

  // ── Expand panel (identical interface to the phase-card scrubber) ─────────

  var pgiEp = { idx: -1, t: 0, poseToken: 0 };

  function ensurePgiExpand() {
    if (document.getElementById('pgi-expand-overlay')) return;
    if (!document.getElementById('pgi-expand-style')) {
      var st = document.createElement('style');
      st.id = 'pgi-expand-style';
      st.textContent =
        '#pgi-expand-overlay{position:fixed;inset:0;background:rgba(6,8,13,.9);z-index:400;' +
        'display:none;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)}' +
        '#pgi-expand-overlay.open{display:flex}';
      document.head.appendChild(st);
    }
    var ov = document.createElement('div');
    ov.id = 'pgi-expand-overlay';
    ov.innerHTML =
      '<div class="expand-panel">' +
      '<div class="ep-hdr"><div class="ep-num" id="pgi-ep-num">1</div>' +
      '<div style="flex:1"><div class="ep-name" id="pgi-ep-name"></div>' +
      '<div class="ep-desc" id="pgi-ep-desc"></div></div>' +
      '<button class="ep-close" onclick="PGIApp._epClose()">&#10005;</button></div>' +
      '<div class="ep-body"><div class="ep-canvas-side">' +
      '<div class="ep-canvas-wrap"><canvas class="ep-canvas" id="pgi-ep-canvas"></canvas>' +
      '<div class="ep-loading" id="pgi-ep-loading"><div class="ep-spinner"></div></div></div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button class="step-btn-big" onclick="PGIApp._epStep(-25)" title="Back ~1 second">&#8722;1s</button>' +
      '<button class="step-btn-big" onclick="PGIApp._epStep(-5)">&#8722;5f</button>' +
      '<button class="step-btn-big" onclick="PGIApp._epStep(-1)">&#8722;1f</button>' +
      '<span class="ep-time" id="pgi-ep-time">0.00s</span>' +
      '<button class="step-btn-big" onclick="PGIApp._epStep(1)">+1f</button>' +
      '<button class="step-btn-big" onclick="PGIApp._epStep(5)">+5f</button>' +
      '<button class="step-btn-big" onclick="PGIApp._epStep(25)" title="Forward ~1 second">+1s</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button class="re-btn" id="pgi-ep-use" onclick="PGIApp._epUse()">&#10003; Use this frame</button>' +
      '<button class="step-btn-big" onclick="PGIApp._epNav(-1)">&#8249; Prev</button>' +
      '<button class="step-btn-big" onclick="PGIApp._epNav(1)">Next &#8250;</button>' +
      '<span id="pgi-ep-status" style="font-size:11px;color:var(--muted2,#8aa0c0)"></span>' +
      '</div>' +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);line-height:1.5;margin-top:8px">' +
      'The overlay (skeleton, centre of mass, support line) is re-detected on every frame you ' +
      'scrub to. It is body geometry, not a force direction.</div>' +
      '</div></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) epClose(); });
  }

  function openPgiExpand(idx) {
    var list = landmarkList();
    var lm = list[idx];
    if (!lm) return;
    ensurePgiExpand();
    pgiEp.idx = idx;
    document.getElementById('pgi-ep-num').textContent = String(idx + 1);
    document.getElementById('pgi-ep-name').textContent =
      lm.name.replace(/\u00b7/g, '\u00b7');
    document.getElementById('pgi-ep-desc').textContent = lm.desc +
      ' \u2014 ' + (lm.stance.side === 'left' ? 'left' : 'right') + ' foot';
    document.getElementById('pgi-expand-overlay').classList.add('open');
    epScrubTo(landmarkTime(lm.stance, lm.event));
  }
  function epClose() {
    var ov = document.getElementById('pgi-expand-overlay');
    if (ov) ov.classList.remove('open');
    pgiEp.idx = -1;
  }
  function epNav(dir) {
    var list = landmarkList();
    if (pgiEp.idx < 0 || !list.length) return;
    openPgiExpand((pgiEp.idx + dir + list.length) % list.length);
  }
  function epStep(frames) {
    var video = document.getElementById('video-side');
    if (!video) return;
    var t = Math.max(0, Math.min(video.duration || 0, pgiEp.t + frames * 0.04));
    epScrubTo(t);
  }

  /**
   * Seek, draw the ORIGINAL video frame, then re-pose THAT frame and draw the
   * overlay — the overlay always moves with the scrub. A token discards any
   * pose result that lands after the user has scrubbed again.
   */
  function epScrubTo(t) {
    var video = document.getElementById('video-side');
    var canvas = document.getElementById('pgi-ep-canvas');
    if (!video || !canvas || pgiEp.idx < 0) return;
    pgiEp.t = t;
    var token = ++pgiEp.poseToken;
    document.getElementById('pgi-ep-time').textContent = t.toFixed(2) + 's';
    var done = false;
    var onSeek = function () {
      if (done) return; done = true;
      video.removeEventListener('seeked', onSeek);
      if (token !== pgiEp.poseToken) return;
      var W = video.videoWidth || 640, H = video.videoHeight || 360;
      canvas.width = W; canvas.height = H;
      try { canvas.getContext('2d').drawImage(video, 0, 0, W, H); } catch (e) { return; }
      // Live pose on the frame just drawn.
      if (typeof detector === 'undefined' || !detector) return;
      var loading = document.getElementById('pgi-ep-loading');
      if (loading) loading.classList.add('show');
      detector.estimatePoses(canvas).then(function (poses) {
        if (loading) loading.classList.remove('show');
        if (token !== pgiEp.poseToken) return;
        var lm = landmarkList()[pgiEp.idx];
        if (poses && poses.length && lm) {
          drawLandmarkOverlay(canvas, poses[0].keypoints, W, lm.stance.side);
        }
      }).catch(function () { if (loading) loading.classList.remove('show'); });
    };
    video.addEventListener('seeked', onSeek);
    setTimeout(onSeek, 900);
    try { video.currentTime = t; } catch (e) { onSeek(); }
  }

  /** Commit the scrubbed frame as this landmark's time and re-analyse. */
  function epUse() {
    var lm = landmarkList()[pgiEp.idx];
    if (!lm) return;
    var ed = landmarkState.edits[lm.stance.key] || {};
    if (lm.event === 'touchdown') ed.startTime = pgiEp.t;
    else ed.endTime = pgiEp.t;
    // Ordering guard: an edit may not invert the stance.
    var startT = typeof ed.startTime === 'number' ? ed.startTime : lm.stance.autoStart;
    var endT = typeof ed.endTime === 'number' ? ed.endTime : lm.stance.autoEnd;
    var status = document.getElementById('pgi-ep-status');
    if (!(endT > startT + 0.04)) {
      if (status) status.textContent = 'Refused: toe-off must come after touchdown.';
      return;
    }
    landmarkState.edits[lm.stance.key] = ed;
    if (status) status.textContent = 'Saved \u2014 analysis updated with this frame.';
    refreshLandmarkCardMeta(pgiEp.idx);
    queueThumb(pgiEp.idx);
    render();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function render() {
    if (!isAdminUser()) return;

    if (isEnabled('projectionGroundInteraction')) {
      try {
        mountContextInputs();
        rawStances();
        var result = analyze();
        mountLandmarkCards();
        if (result) {
          if (typeof PGIRender !== 'undefined') PGIRender.mount(result, 'pgi-report');
        } else {
          mountMessage('pgi-report',
            'Projection & Ground Interaction needs the side-view scan data from this session. ' +
            'Re-run the analysis from the upload screen to populate it.');
        }
        removeNode('pgi-verify');
        if (isEnabled('conditionComparison')) mountConditionControls();
        renderComparison();
        if (isEnabled('researchExport')) mountResearchTools();
        else removeNode('pgi-research-tools');
      } catch (e) {
        console.error('[pgi] render failed:', e);
      }
    } else {
      ['pgi-context', 'pgi-report', 'pgi-verify', 'pgi-landmark-cards', 'pgi-conditions',
       'pgi-comparison', 'pgi-research-tools'].forEach(removeNode);
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
      ['pgi-context', 'pgi-report', 'pgi-verify', 'pgi-landmark-cards', 'pgi-conditions',
       'pgi-comparison', 'pgi-research-tools'].forEach(removeNode);
      return;
    }
    ['pgi-context', 'pgi-verify', 'pgi-landmark-cards', 'pgi-conditions', 'pgi-comparison',
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
    help: help,
    // Expand-panel handlers (bound from the injected markup).
    _epStep: epStep,
    _epNav: epNav,
    _epUse: epUse,
    _epClose: epClose
  };
})();
