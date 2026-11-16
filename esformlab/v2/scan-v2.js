// ==============================================================
//  esFormLab v2 -- scan orchestration and pose hand-off (scan-v2.js)
// ==============================================================
//
// Loaded by the generated v2 page after the inline script, gait-events.js and
// pose-v2.js, and before initModel() runs. Classic scripts share globals, so
// this file replaces three things the inline script declared, without
// touching its code:
//
//   autoScanAll   v1's body with only the sampling and detection core
//                 replaced: for each decoded clip, EslPoseV2.trackClip poses
//                 every stored frame on a runner-centred square (stateless),
//                 EslGaitEvents.detect picks the gait-phase frames from those
//                 poses, and each pick becomes phases[key] = {t: that frame's
//                 time, detected: true, kps: that frame's pose}. Everything the
//                 user sees (stages, bar shares, step text, phase list, warnings,
//                 phone cool-downs and TF scope, diag line, summary bar, cards,
//                 tour, cancel) is v1's.
//   detector      after initModel loads Thunder, the global becomes a thin proxy.
//                 Its estimatePoses(canvas) answers with the tracked pose of the
//                 (clip, time) the canvas was drawn from (EslPoseV2.poseAt),
//                 scaled to the canvas, for the canvases analyzeCard, epReanalyze
//                 and analyzePoseAtT pose. Those three functions are wrapped only
//                 to record which (phase, time) their canvas shows. Any other
//                 canvas goes to the real Thunder detector, reset first so the
//                 call does not inherit the previous call's crop. moveNetModel is
//                 passed through (pose-v2.js reuses those weights).
//   legs          every pose handed to the page has its leg keypoints (11/12,
//                 13/14, 15/16) relabelled with gait-events' diag.legSwap, so
//                 "left" is the runner's anatomical left. Swap L/R in the
//                 inspector then works on the corrected labels as before.
//
// "No pose" behaves as before: estimatePoses resolves to [] when poseAt finds no
// runner at that frame. The pure helpers are in EslScanV2._core and are tested in
// node by scan-v2.test.js.
var EslScanV2 = (function () {
  'use strict';

  var SIDE_KEYS = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid'];
  // gait-events' front/back picks (l, r) -> the page's phase keys
  var FB_KEYS = { front: { l: 'mid_front_l', r: 'mid_front_r' }, back: { l: 'mid_back_l', r: 'mid_back_r' } };
  var LEG_PAIRS = [[11, 12], [13, 14], [15, 16]];
  var VIEW_LABEL = { side: 'Side', front: 'Front', back: 'Back' };

  // ── pure helpers (node-tested) ─────────────────────────────────────────

  // trackClip frames -> gait-events input frames (kps as [x, y, score] arrays; no pose -> null).
  function toDetectFrames(frames) {
    return frames.map(function (f, k) {
      return {
        i: k, t: f.t, dup: !!f.dup, roi: f.roi || null,
        kps: f.kps ? f.kps.map(function (p) { return [p.x, p.y, p.score]; }) : null
      };
    });
  }

  // Is frame position i's leg labelling swapped? legSwap: an array over frame positions or one
  // boolean for the clip. A position the array does not cover takes the nearest covered one.
  function legSwapAt(legSwap, i) {
    if (legSwap == null) return false;
    if (!Array.isArray(legSwap)) return !!legSwap;
    if (!legSwap.length) return false;
    i = Math.max(0, Math.min(legSwap.length - 1, i | 0));
    if (i >= 0 && i < legSwap.length && legSwap[i] != null) return !!legSwap[i];
    for (var d = 1; d < legSwap.length; d++) {
      if (i - d >= 0 && i - d < legSwap.length && legSwap[i - d] != null) return !!legSwap[i - d];
      if (i + d >= 0 && i + d < legSwap.length && legSwap[i + d] != null) return !!legSwap[i + d];
    }
    return false;
  }

  // A copy of kps ({x, y, score, name} x17) with the leg keypoints moved to the other side when
  // swap is true. Names stay with their index, so index 11 is always named left_hip.
  function relabelLegs(kps, swap) {
    if (!kps) return null;
    var out = kps.map(function (p) { return p ? { x: p.x, y: p.y, score: p.score, name: p.name } : p; });
    if (!swap) return out;
    LEG_PAIRS.forEach(function (pr) {
      var a = out[pr[0]], b = out[pr[1]];
      if (!a || !b) return;
      var ax = a.x, ay = a.y, as = a.score;
      a.x = b.x; a.y = b.y; a.score = b.score;
      b.x = ax; b.y = ay; b.score = as;
    });
    return out;
  }

  function scaleKps(kps, sx, sy) {
    if (!kps) return null;
    return kps.map(function (p) { return p ? { x: p.x * sx, y: p.y * sy, score: p.score, name: p.name } : p; });
  }

  // gait-events' picks (frame indices) -> {pageKey: {i, t} | null}. An index that is not a
  // frame of the clip counts as no pick.
  function mapPicks(view, picks, frames) {
    var keys = view === 'side' ? SIDE_KEYS.map(function (k) { return [k, k]; })
      : [['l', FB_KEYS[view].l], ['r', FB_KEYS[view].r]];
    var out = {};
    keys.forEach(function (kk) {
      var i = picks ? picks[kk[0]] : null;
      var ok = typeof i === 'number' && isFinite(i) && i === Math.floor(i) && i >= 0 && i < frames.length &&
        frames[i] && isFinite(frames[i].t);
      out[kk[1]] = ok ? { i: posedNear(frames, i), t: null } : null;
      if (out[kk[1]]) out[kk[1]].t = frames[out[kk[1]].i].t;
    });
    return out;
  }

  // A pick on a frame without a pose (gait-events derives some picks from the strides around
  // them) moves to the nearest posed frame within one frame interval; otherwise it stays.
  function posedNear(frames, i) {
    if (frames[i].kps) return i;
    var dts = [];
    for (var k = Math.max(1, i - 6); k <= Math.min(frames.length - 1, i + 6); k++) {
      var d = frames[k].t - frames[k - 1].t; if (d > 1e-4) dts.push(d);
    }
    dts.sort(function (a, b) { return a - b; });
    var step = dts.length ? dts[dts.length >> 1] : 1 / 30, best = i, bd = Infinity;
    for (var j = Math.max(0, i - 8); j <= Math.min(frames.length - 1, i + 8); j++) {
      if (!frames[j].kps) continue;
      var dt = Math.abs(frames[j].t - frames[i].t);
      if (dt <= step * 1.01 && dt < bd) { bd = dt; best = j; }
    }
    return best;
  }

  // Frames per second from stored frame times (median interval); fallback when unknown.
  function fpsOf(times, fallback) {
    var d = [];
    for (var k = 1; k < times.length; k++) { var x = times[k] - times[k - 1]; if (x > 1e-4) d.push(x); }
    if (!d.length) return fallback || 30;
    d.sort(function (a, b) { return a - b; });
    var m = d[d.length >> 1];
    return Math.round(1000 / m) / 1000;
  }

  // Step line and preview time during trackClip, in the v1 voice ("Side view: scanning frame 37
  // of 150 at 2.43s"). fraction and text come from trackClip's onProgress.
  function stepInfo(view, fraction, text, times) {
    var label = VIEW_LABEL[view] || view;
    var n = times.length;
    if (text === 'posing frames' && n) {
      var k = Math.max(0, Math.min(n - 1, Math.round((fraction - 0.6) / 0.4 * n) - 1));
      return { k: k, t: times[k], text: label + ' view: posing frame ' + (k + 1) + ' of ' + n + ' at ' + times[k].toFixed(2) + 's' };
    }
    return { k: -1, t: null, text: label + ' view: ' + (text || 'checking frames') + '…' };
  }

  // Scan warnings for one clip, in the page's voice. poseDiag = trackClip's diag, gait = detect()'s
  // result (or null), labels = {pageKey: phase label}.
  function viewWarnings(view, poseDiag, gait, labels) {
    var name = view;
    var msgs = [];
    if (poseDiag && poseDiag.ambiguous) {
      msgs.push('Someone else is moving in the ' + name + ' clip — check that each ' + name + ' frame shows the right runner.');
    }
    if (!gait) return msgs;
    var d = gait.diag || {};
    if (view === 'side') {
      var full = (gait.contacts || []).filter(function (c) { return c && c.strike != null && c.toeOff != null; }).length;
      if (full < 2) {
        msgs.push('The side clip shows ' + (full ? 'only one full step' : 'no full step') +
          ' the scan could follow — a few seconds of steady running gives it more strides to choose from.');
      }
    } else if (typeof d.mids === 'number' && d.mids < 3) {
      msgs.push('The ' + name + ' clip shows only ' + (d.mids === 1 ? 'one step' : d.mids + ' steps') +
        ' the scan could follow — a few seconds of steady running gives it more strides to choose from.');
    }
    // A pick with no confidence was not seen in the poses: it was placed from the other steps.
    var conf = d.confidence || {};
    var picked = gait.phases || {};
    var guessed = Object.keys(conf).filter(function (k) { return conf[k] == null && picked[k] != null; });
    if (guessed.length) {
      var keyOf = function (k) { return view === 'side' ? k : FB_KEYS[view][k]; };
      var names = guessed.map(function (k) { return labels[keyOf(k)] || keyOf(k); });
      msgs.push('The scan placed the ' + names.join(', ') + ' frame' + (names.length > 1 ? 's' : '') +
        ' from the steps around ' + (names.length > 1 ? 'them' : 'it') + ' — check ' + (names.length > 1 ? 'them' : 'it') + ' before you review.');
    }
    return msgs;
  }

  var core = {
    SIDE_KEYS: SIDE_KEYS, FB_KEYS: FB_KEYS, LEG_PAIRS: LEG_PAIRS, toDetectFrames: toDetectFrames, legSwapAt: legSwapAt,
    relabelLegs: relabelLegs, scaleKps: scaleKps, mapPicks: mapPicks, fpsOf: fpsOf, stepInfo: stepInfo, viewWarnings: viewWarnings
  };
  if (typeof document === 'undefined') return { _core: core };

  // ── browser part ───────────────────────────────────────────────────────
  /* global videoEls, phases, detector, scanDetector, scanDetectorPromise, PHASE_DEFS, IS_MOBILE_RUNNER, LOAD_BAR_PCT,
     getVideoFrame, isSideView, drawMiniSkeleton, eflCheckCancel, pushScanWarning, clearScanWarnings, initPhases,
     applyStanceFrame, showScanWarningsSummary, buildPhaseGroups, buildSummaryTable, analyzeCard, selectedSex,
     eflSyncWalkthroughLine, isViewingSaved, eflTourDone, startTour, scanInProgress, eflTfScopeOpen, tf,
     EslPoseV2, EslGaitEvents, initModel, epReanalyze, analyzePoseAtT, normalizeAndRetry, epAnalyzing, expandKey,
     epCurrentT, getVideoKeyForPhase */

  var byStore = new WeakMap();   // store -> {frames, diag, gait, legSwap} of its last scan
  var canvasCtx = new WeakMap(); // canvas -> {key, t}: which phase and time the canvas was drawn from
  var anonCtx = null;            // {key, t} of the analyzePoseAtT call in flight (its canvas is private)
  var realDetector = null;

  function labelsByKey() {
    var o = {};
    PHASE_DEFS.forEach(function (d) { o[d.key] = d.label; });
    return o;
  }
  function viewOfKey(key) {
    var d = PHASE_DEFS.filter(function (p) { return p.key === key; })[0];
    return d ? d.videoKey : null;
  }
  function isCancel(e) { return !!(e && e.eflCancelled); }

  // The tracked pose for (phase key, t), legs relabelled, in stored-frame pixels; null if none.
  async function poseFor(key, t) {
    var view = viewOfKey(key);
    var store = view && videoEls[view];
    if (!store || !store.ok) return null;
    var kps = await EslPoseV2.poseAt(store, t);
    if (!kps) return null;
    var st = byStore.get(store);
    var i = store.indexAt(t);
    return relabelLegs(kps, st ? legSwapAt(st.legSwap, i) : false);
  }

  // ── the detector proxy ──
  function makeProxy(real) {
    return {
      eslV2Proxy: true,
      get moveNetModel() { return real.moveNetModel; },
      reset: function () { if (real.reset) real.reset(); },
      dispose: function () { if (real.dispose) real.dispose(); },
      estimatePoses: async function (input, cfg) {
        var ctx = input && canvasCtx.get(input);
        if (!ctx && anonCtx && input && !(input.id)) ctx = anonCtx;
        if (!ctx) {
          // not one of the page's measuring canvases: a plain Thunder call, without the previous crop
          try { if (real.reset) real.reset(); } catch (e) {}
          return real.estimatePoses(input, cfg);
        }
        var view = viewOfKey(ctx.key), store = view && videoEls[view];
        var kps = null;
        try { kps = await poseFor(ctx.key, ctx.t); } catch (e) { console.warn('[esfl v2] pose at ' + ctx.key + ' ' + ctx.t + ':', e && e.message); }
        if (!kps || !store) return [];
        var sx = (input.width || store.videoWidth) / store.videoWidth, sy = (input.height || store.videoHeight) / store.videoHeight;
        if (sx !== 1 || sy !== 1) kps = scaleKps(kps, sx, sy);
        return [{ keypoints: kps, score: EslPoseV2.poseScore(kps) }];
      }
    };
  }
  function installProxy() {
    if (detector && !detector.eslV2Proxy) { realDetector = detector; detector = makeProxy(realDetector); }
  }

  // ── wrappers that record which (phase, time) a canvas shows ──
  var _initModel = initModel;
  initModel = async function () { var r = await _initModel.apply(this, arguments); installProxy(); return r; };

  var _analyzeCard = analyzeCard;
  analyzeCard = function (key) {
    var c = document.getElementById('canvas-' + key), ph = phases[key];
    if (c && ph) canvasCtx.set(c, { key: key, t: ph.t });
    return _analyzeCard.apply(this, arguments);
  };
  var _epReanalyze = epReanalyze;
  epReanalyze = function () {
    if (!epAnalyzing && expandKey) {
      var c = document.getElementById('ep-canvas');
      if (c) canvasCtx.set(c, { key: expandKey, t: epCurrentT });
    }
    return _epReanalyze.apply(this, arguments);
  };
  var _analyzePoseAtT = analyzePoseAtT;
  analyzePoseAtT = async function (t, phaseKey) {
    var mine = { key: phaseKey, t: t };
    anonCtx = mine;
    try { return await _analyzePoseAtT.apply(this, arguments); }
    finally { if (anonCtx === mine) anonCtx = null; }
  };
  // the weak-pose retry poses a brightened copy of the canvas: same frame, same answer
  var _normalizeAndRetry = normalizeAndRetry;
  normalizeAndRetry = function (src) {
    var out = _normalizeAndRetry.apply(this, arguments);
    var ctx = src && canvasCtx.get(src);
    if (ctx && out) canvasCtx.set(out, ctx);
    else if (anonCtx && out) canvasCtx.set(out, anonCtx);
    return out;
  };

  // ── preview drawing on #scan-canvas (as v1: <= 400 px wide, small skeleton) ──
  var previewBusy = false;
  async function drawPreview(store, t, kps) {
    var sc = document.getElementById('scan-canvas');
    if (!sc || !store || !store.ok) return;
    var img = await getVideoFrame(store, t);
    if (!img) return;
    sc.width = Math.min(400, store.videoWidth || 400);
    sc.height = store.videoWidth > 0 ? Math.round(sc.width * store.videoHeight / store.videoWidth) : 225;
    var ctx = sc.getContext('2d');
    try { ctx.drawImage(img, 0, 0, sc.width, sc.height); } catch (e) { return; }
    if (kps) drawMiniSkeleton(ctx, kps, sc.width / store.videoWidth, sc.height / store.videoHeight);
  }

  // Track, pose and pick one clip. Returns {res, gait, picks: {key: {i, t, kps}}} or null when the
  // clip gives nothing (warnings pushed here). Cancel passes through.
  async function scanView(view, store, barStart, barEnd) {
    if (!store || !store.ok || !store.frameCount()) return null;
    var label = VIEW_LABEL[view];
    var bar = document.getElementById('scan-bar'), step = document.getElementById('scan-step'), lab = document.getElementById('scan-label');
    var times = store.times.slice();
    var prev = byStore.get(store), res = null;
    var cached = EslPoseV2.tracked(store);
    if (prev && cached && cached.frames === prev.frames) {
      res = prev;   // Re-scan of the same clip: the poses are the same, only the picking runs again
      bar.style.width = Math.round(barEnd) + '%';
    } else {
      var lastDraw = 0;
      try {
        res = await EslPoseV2.trackClip(store, {
          model: 'thunder',
          checkCancel: eflCheckCancel,
          onProgress: function (f, text) {
            bar.style.width = Math.round(barStart + Math.max(0, Math.min(1, f)) * (barEnd - barStart)) + '%';
            var si = stepInfo(view, f, text, times);
            step.textContent = si.text;
            if (si.t != null) {
              lab.textContent = si.t.toFixed(2) + 's (' + view + ')';
              var now = Date.now();
              if (!previewBusy && now - lastDraw > 1000) {
                lastDraw = now; previewBusy = true;
                drawPreview(store, si.t, null).then(function () { previewBusy = false; }, function () { previewBusy = false; });
              }
            }
          }
        });
      } catch (e) {
        if (isCancel(e)) throw e;
        eflCheckCancel();
        console.error('[esfl v2] ' + view + ' pose tracking failed:', e);
        pushScanWarning(e && e.eslModelError
          ? 'The pose model couldn’t load for the ' + view + ' clip — check your connection, then re-scan (or pick its frames by hand).'
          : 'The ' + view + ' clip couldn’t be scanned — pick its frames by hand, or re-scan.');
        return null;
      }
    }
    eflCheckCancel();
    var frames = res.frames || [];
    var posed = frames.filter(function (f) { return !!f.kps; }).length;
    if (!posed) {
      pushScanWarning('No runner could be found in the ' + view + ' clip — pick its frames by hand, or film with the runner larger in the frame.');
      byStore.set(store, { frames: frames, diag: res.diag, gait: null, legSwap: null, posed: 0 });
      return { res: res, gait: null, picks: null, posed: 0, n: frames.length };
    }
    step.textContent = view === 'side' ? 'Side view: finding foot-strikes, toe-offs and mid-stance...' : label + ' view: finding L and R mid-stance...';
    var gait = null;
    try {
      gait = EslGaitEvents.detect({
        view: view,
        meta: { fps: store.fps || fpsOf(times, 30), times: times, w: store.videoWidth, h: store.videoHeight },
        frames: toDetectFrames(frames),
        manifest: { view: view }
      });
    } catch (e) {
      console.error('[esfl v2] ' + view + ' gait events failed:', e);
    }
    var legSwap = gait && gait.diag ? gait.diag.legSwap : null;
    byStore.set(store, { frames: frames, diag: res.diag, gait: gait, legSwap: legSwap, posed: posed });
    viewWarnings(view, res.diag, gait, labelsByKey()).forEach(pushScanWarning);
    var picks = {};
    var m = gait ? mapPicks(view, gait.phases, frames) : {};
    Object.keys(m).forEach(function (key) {
      var p = m[key];
      picks[key] = p ? { i: p.i, t: p.t, kps: relabelLegs(frames[p.i].kps, legSwapAt(legSwap, p.i)) } : null;
    });
    // show one picked frame with its skeleton, as v1 left its last sample on the preview
    var show = picks.mid || picks[(FB_KEYS[view] || {}).l] || null;
    if (show) { try { await drawPreview(store, show.t, show.kps); } catch (e) {} }
    return { res: res, gait: gait, picks: picks, posed: posed, n: frames.length };
  }

  // ── autoScanAll: v1's body, with the sampling and detection core replaced ──
  autoScanAll = async function () {
    clearScanWarnings();
    if (IS_MOBILE_RUNNER && scanDetectorPromise && !scanDetector) {
      try { await scanDetectorPromise; } catch (e) {}
    }
    installProxy();
    var tfScopeOpen = false;
    var tfMemPre = 0;
    if (IS_MOBILE_RUNNER && typeof tf !== 'undefined' && tf.engine) {
      try {
        tfMemPre = (tf.memory && tf.memory().numBytes) || 0;
        tf.engine().startScope();
        tfScopeOpen = true;
        eflTfScopeOpen = true;
      } catch (e) {
        console.warn('[esfl] could not open tf scope:', e && e.message);
      }
    }
    var sideVid = videoEls.side;
    var frontVid = videoEls.front;
    var backVid = videoEls.back;

    var loadStatus = {
      side: (sideVid.videoWidth || 0) > 0,
      front: (frontVid.videoWidth || 0) > 0,
      back: (backVid.videoWidth || 0) > 0
    };
    var failedLabels = [];
    if (!loadStatus.side) failedLabels.push('Side');
    if (!loadStatus.front) failedLabels.push('Front');
    if (!loadStatus.back) failedLabels.push('Back');
    if (failedLabels.length) {
      pushScanWarning(failedLabels.join(' & ') + ' video' + (failedLabels.length > 1 ? 's' : '') +
        ' couldn’t be decoded by this browser (phone clips are often HEVC / H.265). ' +
        'Re-export as H.264 .mp4 or try Safari / Chrome — scanning continues with whatever loaded.');
      console.warn('[esfl] video load failure:', failedLabels.join(', '));
    }

    var sideDur = sideVid.duration;
    if (!isFinite(sideDur) || isNaN(sideDur) || sideDur <= 0) { await new Promise(function (r) { setTimeout(r, 500); }); sideDur = sideVid.duration; }
    if (!isFinite(sideDur) || isNaN(sideDur) || sideDur <= 0) sideDur = 30;

    initPhases(sideDur / 2);

    [['side', 'Side', sideVid], ['front', 'Front', frontVid], ['back', 'Back', backVid]].forEach(function (c) {
      var st = c[2];
      if (!st || !st.ok) return;
      var dur = st.duration;
      if (st.frameCount() < 45 || (isFinite(dur) && dur < 2)) {
        pushScanWarning('The ' + c[1].toLowerCase() + ' clip is very short (' + (isFinite(dur) ? dur : 0).toFixed(1) + ' s) — a few seconds of steady running gives the scan full strides to work with.');
      }
    });

    var frontDur = frontVid.duration;
    if (!isFinite(frontDur) || isNaN(frontDur) || frontDur <= 0) frontDur = 30;
    var backDur = backVid.duration;
    if (!isFinite(backDur) || isNaN(backDur) || backDur <= 0) backDur = 30;
    phases.mid_front_l.t = frontDur * 0.35;
    phases.mid_front_r.t = frontDur * 0.65;
    phases.mid_back_l.t = backDur * 0.35;
    phases.mid_back_r.t = backDur * 0.65;

    document.getElementById('scan-phase-list').innerHTML = PHASE_DEFS.map(function (p) {
      return '<div class="spl-item" id="spl-' + p.key + '"><div class="spl-dot"></div><span class="spl-name">' + p.label + '</span><span class="spl-time" id="spl-t-' + p.key + '">--</span></div>';
    }).join('');

    // ---- STEP 1: side clip (v2: every stored frame posed, then gait events) ----
    document.getElementById('scan-sub-text').textContent = 'Scanning side view for ' + PHASE_DEFS.filter(function (d) { return d.videoKey === 'side'; }).length + ' gait phases…';
    eflCheckCancel();
    var side = await scanView('side', sideVid, LOAD_BAR_PCT, 75);
    var posesFound = side ? side.posed : 0;
    var N = side ? side.n : 0;
    if (side && side.posed) {
      // the facing check, on the first posed frames (v1 looked at its first pose)
      var first = side.res.frames.filter(function (f) { return f.kps && !f.dup; }).slice(0, 5);
      var notSide = first.filter(function (f) { return !isSideView(f.kps); }).length;
      if (first.length && notSide * 2 > first.length) {
        pushScanWarning('The side clip’s first poses look front- or back-facing — side-view angles need a dead-on side view.');
      }
    }
    if (side && side.picks) {
      SIDE_KEYS.forEach(function (key) {
        var p = side.picks[key];
        if (!p) return;
        phases[key].t = p.t;
        phases[key].kps = p.kps;
        phases[key].detected = true;
      });
    }

    eflCheckCancel();
    SIDE_KEYS.forEach(function (key) {
      var ph = phases[key]; var item = document.getElementById('spl-' + key); var tEl = document.getElementById('spl-t-' + key);
      if (!item || !tEl) return;
      if (ph && ph.detected) { item.classList.add('found'); tEl.textContent = ph.t.toFixed(2) + 's'; } else { item.classList.add('not-found'); tEl.textContent = 'manual'; }
    });

    if (IS_MOBILE_RUNNER) {
      document.getElementById('scan-sub-text').textContent = 'Brief cool-down between scans…';
      document.getElementById('scan-step').textContent = 'Pausing briefly between scans…';
      await new Promise(function (r) { setTimeout(r, 1500); });
    }

    // ---- STEPS 2 and 3: front and back clips ----
    var fbStages = [['front', frontVid, 75, 87], ['back', backVid, 87, 100]];
    for (var s = 0; s < fbStages.length; s++) {
      var view = fbStages[s][0];
      if (s > 0 && IS_MOBILE_RUNNER) {
        document.getElementById('scan-sub-text').textContent = 'Brief cool-down between scans…';
        document.getElementById('scan-step').textContent = 'Pausing briefly between scans…';
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
      eflCheckCancel();
      document.getElementById('scan-sub-text').textContent = 'Scanning ' + view + ' view for L and R mid-stance frames...';
      document.getElementById('scan-bar').style.width = fbStages[s][2] + '%';
      var r = await scanView(view, fbStages[s][1], fbStages[s][2], fbStages[s][3]);
      var keys = FB_KEYS[view];
      applyStanceFrame(keys.l, r && r.picks ? r.picks[keys.l] : null);
      applyStanceFrame(keys.r, r && r.picks ? r.picks[keys.r] : null);
    }

    // Finalize (v1 from here on)
    document.getElementById('scan-bar').style.width = '100%';
    document.getElementById('scan-step').textContent = 'Done — all 3 videos scanned';
    document.getElementById('scan-sub-text').textContent = 'Scan complete';

    var diag = document.getElementById('scan-diag'); diag.style.display = 'block';
    var fmtClip = function (v) { return v.ok ? (v.nativeWidth + 'x' + v.nativeHeight + (v.fps ? ' ' + v.fps + 'fps' : '')) : 'failed'; };
    diag.textContent = 'Side: ' + fmtClip(sideVid) + ' ' + sideDur.toFixed(1) + 's | Front: ' + fmtClip(frontVid) + ' | Back: ' + fmtClip(backVid);

    var partial = [['Side', sideVid], ['Front', frontVid], ['Back', backVid]].filter(function (p) { return p[1].ok && p[1].coverage < 0.9; });
    if (partial.length) {
      var partialMsg = 'Only part of the ' + partial.map(function (p) { return p[0].toLowerCase() + ' (' + Math.round(p[1].coverage * 100) + '% of frames)'; }).join(', ') +
        ' video could be loaded — re-exporting as H.264 .mp4 usually fixes this.';
      diag.innerHTML += '<br>&#9888; ' + partialMsg;
      pushScanWarning(partialMsg);
    }

    eflCheckCancel();
    await new Promise(function (r) { setTimeout(r, 700); });
    eflCheckCancel();
    document.getElementById('screen-scanning').style.display = 'none';
    document.getElementById('screen-phases').style.display = 'block';
    document.getElementById('btn-rescan').style.display = IS_MOBILE_RUNNER ? 'none' : 'inline-flex';
    var reviewActionsEl = document.getElementById('review-actions');
    if (reviewActionsEl) reviewActionsEl.style.display = IS_MOBILE_RUNNER ? 'none' : '';
    showScanWarningsSummary();
    var detected = PHASE_DEFS.filter(function (d) { return phases[d.key] && phases[d.key].detected; }).length;
    var sb = document.getElementById('scan-summary-bar'); sb.style.display = 'flex';
    var sexInfo = selectedSex ? '<span class="ss-item ' + selectedSex + '">Ranges: <strong>' + selectedSex + '</strong></span>' : '<span class="ss-item">Ranges: <strong>default</strong></span>';
    var fmtDim = function (v) { return v.ok ? (v.nativeWidth + 'x' + v.nativeHeight) : 'failed'; };
    var sideFailed = (sideVid.videoWidth || 0) === 0;
    var frontFailed = (frontVid.videoWidth || 0) === 0;
    var backFailed = (backVid.videoWidth || 0) === 0;
    var ssWarn = sideFailed || frontFailed || backFailed || posesFound < 15;
    sb.innerHTML = '<details class="ss-details"' + (ssWarn ? ' open' : '') + '><summary>Scan details &middot; ' + detected + ' of ' + PHASE_DEFS.length + ' auto-detected' + (ssWarn ? ' &middot; <span class="ss-warn-flag">check these</span>' : '') + '</summary><div class="ss-items">' +
      '<span class="ss-item ' + (sideFailed ? 'warn' : '') + '">Side: <strong>' + fmtDim(sideVid) + '</strong></span>' +
      '<span class="ss-item ' + (frontFailed ? 'warn' : '') + '">Front: <strong>' + fmtDim(frontVid) + '</strong></span>' +
      '<span class="ss-item ' + (backFailed ? 'warn' : '') + '">Back: <strong>' + fmtDim(backVid) + '</strong></span>' +
      '<span class="ss-item">Duration: <strong>' + sideDur.toFixed(1) + 's</strong></span>' +
      '<span class="ss-item ' + (posesFound < 15 ? 'warn' : '') + '">Side poses: <strong>' + posesFound + '/' + N + '</strong></span>' +
      '<span class="ss-item">Auto-detected: <strong>' + detected + '/' + PHASE_DEFS.length + '</strong></span>' + sexInfo + '</div></details>';
    if (sideFailed || frontFailed || backFailed) {
      sb.innerHTML += '<span class="ss-item warn" style="flex-basis:100%">&#9888; A video could not be decoded by this browser (phone clips are often HEVC / H.265) — re-export it as H.264 .mp4 or try Safari / Chrome.</span>';
    }
    buildPhaseGroups(); buildSummaryTable();
    for (var di = 0; di < PHASE_DEFS.length; di++) {
      var dKey = PHASE_DEFS[di].key;
      if (phases[dKey] && phases[dKey].detected) await analyzeCard(dKey);
    }
    if (tfScopeOpen) {
      try {
        var tfMemBefore = (tf.memory && tf.memory().numBytes) || 0;
        tf.engine().endScope();
        eflTfScopeOpen = false;
        var tfMemAfter = (tf.memory && tf.memory().numBytes) || 0;
        console.log('[esfl] tf memory bytes  pre-scan=' + tfMemPre + '  end-of-scan=' + tfMemBefore + '  after-cleanup=' + tfMemAfter);
      } catch (e) { console.warn('[esfl] tf scope close failed:', e && e.message); }
    }
    eflSyncWalkthroughLine();
    if (!isViewingSaved && !eflTourDone()) {
      setTimeout(function () { startTour(); }, 600);
    }
    scanInProgress = false;
  };

  return {
    _core: core,
    poseFor: poseFor,
    lastScan: function (view) { var s = videoEls[view]; return s ? byStore.get(s) || null : null; },
    realDetector: function () { return realDetector; }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = EslScanV2;
