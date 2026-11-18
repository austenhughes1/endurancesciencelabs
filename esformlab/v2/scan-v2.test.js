// ════════════════════════════════════════════════════════════════
// esformlab/v2/scan-v2.test.js
//
// Checks of scan-v2.js's pure helpers (EslScanV2._core), its all-or-nothing
// page hook-up (in a node vm), its autoScanAll with and without a front clip
// (in a node vm with the real gait-data.js and a fake page), and build-page.js's
// guards. Run with plain node:
//
//   node esformlab/v2/scan-v2.test.js
//
// No browser: scan-v2.js returns only its helpers when there is no document.
// Every input here is made up. The last section runs the made-up frames through
// gait-events.js to check that the hand-off between the two modules lines up.
// ════════════════════════════════════════════════════════════════
'use strict';
var path = require('path');

var Scan = require(path.join(__dirname, 'scan-v2.js'));
var C = Scan._core;

var failures = 0, checks = 0;
function ok(label, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL ' + label + (extra !== undefined ? ': ' + JSON.stringify(extra) : '')); }
}
function eq(label, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

var NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee',
  'right_knee', 'left_ankle', 'right_ankle'];
// a made-up pose: keypoint j at (10 j, 100 + j), score 0.5 + j / 100
function pose(dx) {
  return NAMES.map(function (n, j) { return { x: 10 * j + (dx || 0), y: 100 + j, score: 0.5 + j / 100, name: n }; });
}

// ── toDetectFrames ──
(function () {
  var frames = [
    { i: 0, t: 0, dup: false, kps: pose(), roi: [1, 2, 3] },
    { i: 1, t: 1 / 30, dup: true, kps: null, roi: null },
    { i: 2, t: 2 / 30, kps: pose(5) }
  ];
  var d = C.toDetectFrames(frames);
  eq('detect frames: count', d.length, 3);
  eq('detect frames: i is the position', d.map(function (f) { return f.i; }), [0, 1, 2]);
  eq('detect frames: kps as [x, y, score]', d[0].kps[15], [150, 115, 0.65]);
  eq('detect frames: 17 points', d[2].kps.length, 17);
  eq('detect frames: no pose stays null', d[1].kps, null);
  eq('detect frames: dup flag', d.map(function (f) { return f.dup; }), [false, true, false]);
  eq('detect frames: times kept', d[2].t, 2 / 30);
  eq('detect frames: roi kept', d[0].roi, [1, 2, 3]);
})();

// ── legSwapAt ──
eq('legSwap: null', C.legSwapAt(null, 3), false);
eq('legSwap: clip boolean true', C.legSwapAt(true, 3), true);
eq('legSwap: clip boolean false', C.legSwapAt(false, 0), false);
eq('legSwap: array in range', C.legSwapAt([false, true, false], 1), true);
eq('legSwap: array other index', C.legSwapAt([false, true, false], 2), false);
eq('legSwap: past the end takes the nearest', C.legSwapAt([false, false, true], 7), true);
eq('legSwap: negative takes the first', C.legSwapAt([true, false], -1), true);
eq('legSwap: hole takes a neighbour', C.legSwapAt([true, undefined, undefined, undefined, false], 1), true);
eq('legSwap: empty array', C.legSwapAt([], 0), false);

// ── relabelLegs ──
(function () {
  var k = pose();
  var same = C.relabelLegs(k, false);
  ok('relabel off: a copy', same !== k && same[11] !== k[11]);
  eq('relabel off: same values', same, k);
  var sw = C.relabelLegs(k, true);
  [[11, 12], [13, 14], [15, 16]].forEach(function (p) {
    eq('relabel: ' + NAMES[p[0]] + ' takes the other leg', [sw[p[0]].x, sw[p[0]].y, sw[p[0]].score], [k[p[1]].x, k[p[1]].y, k[p[1]].score]);
    eq('relabel: ' + NAMES[p[1]] + ' takes the other leg', [sw[p[1]].x, sw[p[1]].y, sw[p[1]].score], [k[p[0]].x, k[p[0]].y, k[p[0]].score]);
    eq('relabel: names stay with the index ' + p[0], [sw[p[0]].name, sw[p[1]].name], [NAMES[p[0]], NAMES[p[1]]]);
  });
  for (var j = 0; j <= 10; j++) eq('relabel: upper body unchanged ' + NAMES[j], sw[j], k[j]);
  eq('relabel: input untouched', k[11].x, 110);
  eq('relabel twice = original', C.relabelLegs(sw, true), k);
  eq('relabel: null', C.relabelLegs(null, true), null);
})();

// ── scaleKps ──
(function () {
  var s = C.scaleKps(pose(), 0.5, 2);
  eq('scale: x', s[4].x, 20);
  eq('scale: y', s[4].y, 208);
  eq('scale: score kept', s[4].score, 0.54);
  eq('scale: name kept', s[4].name, 'right_ear');
})();

// ── mapPicks: frame index -> time ──
(function () {
  var frames = [];
  for (var i = 0; i < 40; i++) frames.push({ i: i, t: 0.1 + i / 30, kps: pose() });
  var m = C.mapPicks('side', { l_foot: 3, r_foot: 18, l_toe: 9, r_toe: 25, mid: 6 }, frames);
  eq('picks side: keys', Object.keys(m).sort(), ['l_foot', 'l_toe', 'mid', 'r_foot', 'r_toe']);
  eq('picks side: l_foot index', m.l_foot.i, 3);
  ok('picks side: l_foot time is frame 3 time', Math.abs(m.l_foot.t - (0.1 + 3 / 30)) < 1e-12);
  ok('picks side: r_toe time', Math.abs(m.r_toe.t - (0.1 + 25 / 30)) < 1e-12);
  var f = C.mapPicks('front', { l: 4, r: 12 }, frames);
  eq('picks front: page keys', Object.keys(f).sort(), ['mid_front_l', 'mid_front_r']);
  eq('picks front: l index', f.mid_front_l.i, 4);
  var b = C.mapPicks('back', { l: 30, r: null }, frames);
  eq('picks back: l', b.mid_back_l.i, 30);
  eq('picks back: missing r', b.mid_back_r, null);
  var bad = C.mapPicks('side', { l_foot: -1, r_foot: 40, l_toe: 2.5, r_toe: 'x', mid: undefined }, frames);
  eq('picks: out of range / not an index -> no pick', [bad.l_foot, bad.r_foot, bad.l_toe, bad.r_toe, bad.mid], [null, null, null, null, null]);
  var gap = frames.map(function (f) { return { i: f.i, t: f.t, kps: f.kps }; });
  gap[10].kps = null; gap[20].kps = null; gap[21].kps = null; gap[22].kps = null;
  var g = C.mapPicks('side', { l_foot: 10, r_foot: 21, l_toe: 2, r_toe: 3, mid: 4 }, gap);
  ok('picks: no-pose frame moves to a posed neighbour', (g.l_foot.i === 9 || g.l_foot.i === 11) && g.l_foot.t === gap[g.l_foot.i].t, g.l_foot);
  eq('picks: no posed frame within one interval -> pick stays', g.r_foot.i, 21);
  var none = C.mapPicks('back', null, frames);
  eq('picks: no phases', [none.mid_back_l, none.mid_back_r], [null, null]);
})();

// ── fpsOf ──
(function () {
  var t = []; for (var i = 0; i < 50; i++) t.push(i / 60);
  ok('fps 60', Math.abs(C.fpsOf(t) - 60) < 0.01, C.fpsOf(t));
  var d = []; for (i = 0; i < 50; i++) { d.push(i / 30); d.push(i / 30); }
  ok('fps ignores repeated times', Math.abs(C.fpsOf(d) - 30) < 0.01, C.fpsOf(d));
  eq('fps fallback', C.fpsOf([0], 25), 25);
})();

// ── stepInfo ──
(function () {
  var t = []; for (var i = 0; i < 100; i++) t.push(i / 25);
  var s = C.stepInfo('side', 0.8, 'posing frames', t);
  eq('step: posing text', s.text, 'Side view: posing frame 50 of 100 at 1.96s');
  eq('step: posing frame', s.k, 49);
  eq('step: last frame', C.stepInfo('back', 1, 'posing frames', t).text, 'Back view: posing frame 100 of 100 at 3.96s');
  eq('step: first frame', C.stepInfo('front', 0.6, 'posing frames', t).k, 0);
  var o = C.stepInfo('front', 0.2, 'finding the runner', t);
  eq('step: other stages', o.text, 'Front view: finding the runner…');
  eq('step: other stages have no frame', o.t, null);
})();

// ── viewWarnings ──
(function () {
  var labels = { l_foot: 'L foot strike', r_foot: 'R foot strike', l_toe: 'L toe-off', r_toe: 'R toe-off', mid: 'Mid-stance',
    mid_front_l: 'L mid-stance (front)', mid_front_r: 'R mid-stance (front)', mid_back_l: 'L mid-stance (back)', mid_back_r: 'R mid-stance (back)' };
  var full = [{ leg: 'left', strike: 1, toeOff: 5 }, { leg: 'right', strike: 9, toeOff: 13 }, { leg: 'left', strike: 17, toeOff: 21 }];
  var good = { phases: { l_foot: 1, r_foot: 9, l_toe: 5, r_toe: 13, mid: 3 }, contacts: full,
    diag: { confidence: { l_foot: 0.8, r_foot: 0.7, l_toe: 0.6, r_toe: 0.9, mid: 0.5 } } };
  eq('warn: clean side clip says nothing', C.viewWarnings('side', { ambiguous: false }, good, labels), []);
  var w = C.viewWarnings('side', { ambiguous: true }, good, labels);
  eq('warn: two people', w.length, 1);
  ok('warn: two people text', /Someone else is moving in the side clip/.test(w[0]), w);
  var few = { phases: good.phases, contacts: [{ leg: 'left', strike: 1, toeOff: 5 }, { leg: 'right', strike: 9, toeOff: null }], diag: good.diag };
  w = C.viewWarnings('side', {}, few, labels);
  ok('warn: few strides', w.length === 1 && /only one full step/.test(w[0]), w);
  w = C.viewWarnings('side', {}, { phases: good.phases, contacts: [], diag: good.diag }, labels);
  ok('warn: no stride', w.length === 1 && /no full step/.test(w[0]), w);
  var derived = { phases: good.phases, contacts: full, diag: { confidence: { l_foot: 0.8, r_foot: null, l_toe: 0.6, r_toe: null, mid: 0.5 } } };
  w = C.viewWarnings('side', {}, derived, labels);
  eq('warn: placed picks', w, ['The scan placed the R foot strike, R toe-off frames from the steps around them — check them before you review.']);
  w = C.viewWarnings('front', {}, { phases: { l: 4, r: 12 }, contacts: [], diag: { mids: 2, confidence: { l: 0.4, r: null } } }, labels);
  eq('warn: front few steps + placed pick', w, [
    'The front clip shows only 2 steps the scan could follow — a few seconds of steady running gives it more strides to choose from.',
    'The scan placed the R mid-stance (front) frame from the steps around it — check it before you review.']);
  w = C.viewWarnings('back', {}, { phases: { l: 4, r: 12 }, contacts: [], diag: { mids: 8, confidence: { l: 0.4, r: 0.3 } } }, labels);
  eq('warn: clean back clip', w, []);
  w = C.viewWarnings('back', {}, { phases: { l: null, r: null }, contacts: [], diag: { mids: 8, confidence: { l: null, r: null } } }, labels);
  eq('warn: an unpicked phase is not "placed"', w, []);
  eq('warn: no gait result', C.viewWarnings('back', {}, null, labels), []);
})();

// ── hand-off to gait-events.js (made-up running pose) ──
(function () {
  var GE;
  try { GE = require(path.join(__dirname, 'gait-events.js')); } catch (e) { GE = null; }
  if (!GE) { console.log('  (gait-events.js not found: hand-off section SKIPPED)'); return; }
  // a made-up side-view runner at 30 fps facing right: legs swing in antiphase about the hip
  var fps = 30, n = 120, P = 0.7, frames = [];
  for (var i = 0; i < n; i++) {
    var t = i / fps, k = pose();
    var hipX = 300 + 2 * i, hipY = 200;
    k[5].x = hipX + 5; k[5].y = 120; k[6].x = hipX + 5; k[6].y = 120;
    k[11].x = hipX; k[11].y = hipY; k[12].x = hipX; k[12].y = hipY;
    [0, 1].forEach(function (leg) {
      var ph = 2 * Math.PI * (t / P + leg / 2), reach = 40 * Math.sin(ph), lift = Math.max(0, Math.cos(ph)) * 20;
      k[13 + leg].x = hipX + reach * 0.6; k[13 + leg].y = 250 - lift * 0.5;
      k[15 + leg].x = hipX + reach; k[15 + leg].y = 300 - lift;
    });
    k.forEach(function (p) { p.score = 0.8; });
    frames.push({ i: i, t: t, dup: false, kps: k });
  }
  var out = GE.detect({ view: 'side', meta: { fps: fps, times: frames.map(function (f) { return f.t; }), w: 1280, h: 720 },
    frames: C.toDetectFrames(frames), manifest: { view: 'side' } });
  ok('hand-off: detect returns phases', out && out.phases);
  ok('hand-off: legSwap covers every frame', out.diag && Array.isArray(out.diag.legSwap) && out.diag.legSwap.length === n);
  var m = C.mapPicks('side', out.phases, frames);
  C.SIDE_KEYS.forEach(function (key) {
    ok('hand-off: ' + key + ' picked to a frame time', m[key] && m[key].t === frames[m[key].i].t, m[key]);
  });
})();

// ── poseOrSearch: frames the tracker did not follow get the single-frame search ──
// A made-up Pose: tracked frames 0-4 have an ROI and a pose, 5-9 no ROI (runner lost).
function fakePose(trackedFrames) {
  var calls = [];
  return {
    calls: calls,
    tracked: function () { return trackedFrames ? { frames: trackedFrames } : null; },
    poseAt: async function (store, t, opts) {
      var i = store.indexAt(t), search = !!(opts && opts.search);
      calls.push({ i: i, search: search });
      if (search) return pose(100);   // the search finds someone
      var c = trackedFrames;
      if (!c) return pose(200);        // never tracked: poseAt itself searches
      return c[i] && c[i].roi ? c[i].kps : null;
    }
  };
}
function fakeStore(n) {
  return { ok: true, indexAt: function (t) { return Math.max(0, Math.min(n - 1, Math.round(t * 30))); } };
}
async function poseOrSearchChecks() {
  var tracked = [];
  for (var i = 0; i < 10; i++) tracked.push({ i: i, t: i / 30, roi: i < 5 ? [0, 0, 100] : null, kps: i < 5 ? pose(i) : null });
  tracked[3].kps = null;   // tracked frame whose pose fell under the floor
  var store = fakeStore(10);

  var P1 = fakePose(tracked);
  eq('poseOrSearch: a tracked pose is used as is', await C.poseOrSearch(P1, store, 2 / 30), pose(2));
  eq('poseOrSearch: ... without a search', P1.calls, [{ i: 2, search: false }]);

  var P2 = fakePose(tracked);
  eq('poseOrSearch: a frame without an ROI gets the search', await C.poseOrSearch(P2, store, 7 / 30), pose(100));
  eq('poseOrSearch: ... after the tracked answer', P2.calls, [{ i: 7, search: false }, { i: 7, search: true }]);

  var P3 = fakePose(tracked);
  eq('poseOrSearch: a tracked frame with no pose stays no pose', await C.poseOrSearch(P3, store, 3 / 30), null);
  eq('poseOrSearch: ... and is not searched', P3.calls.length, 1);

  var none = tracked.map(function (f) { return { i: f.i, t: f.t, roi: null, kps: null }; });
  var P4 = fakePose(none);
  ok('poseOrSearch: clip with no runner tracked: every frame can still be posed',
    (await C.poseOrSearch(P4, store, 0)) && (await C.poseOrSearch(P4, store, 9 / 30)));

  var P5 = fakePose(null);
  eq('poseOrSearch: an untracked clip is posed by poseAt alone', await C.poseOrSearch(P5, store, 1 / 30), pose(200));
  eq('poseOrSearch: ... one call', P5.calls.length, 1);
}

// ── waitFor ──
async function waitForChecks() {
  eq('waitFor: resolves with the value', await C.waitFor(Promise.resolve(7), function () {}, 5), 7);
  eq('waitFor: a failed load resolves with undefined', await C.waitFor(Promise.reject(new Error('x')), null, 5), undefined);
  var cancel = { eflCancelled: true }, n = 0, got = null;
  try { await C.waitFor(new Promise(function () {}), function () { if (++n >= 2) throw cancel; }, 5); } catch (e) { got = e; }
  ok('waitFor: a cancel while waiting rejects with the cancel', got === cancel);
}

// ── trackPacing and missingTargets ──
eq('trackPacing: phones pause as v1 did', C.trackPacing(true), { yieldEvery: 10, pauseMs: 60 });
eq('trackPacing: desktop uses trackClip defaults', C.trackPacing(false), {});
(function () {
  var all = {};
  C.TARGETS.forEach(function (n) { all[n] = 'function'; });
  eq('missingTargets: none missing', C.missingTargets(all), []);
  all.analyzePoseAtT = 'undefined';
  eq('missingTargets: a renamed function is reported', C.missingTargets(all), ['analyzePoseAtT']);
})();

// ── browser part: all of the page's functions are replaced, or none ──
function runBrowserPart(omit, search) {
  var vm = require('vm'), fs = require('fs');
  var orig = {};
  var ctx = { console: { error: function () {}, warn: function () {}, log: function () {} }, document: { title: 'esFormLab v2' },
    location: { search: search || '' },
    detector: null, Promise: Promise, setTimeout: setTimeout, clearInterval: clearInterval, setInterval: setInterval };
  ['autoScanAll', 'analyzeCard', 'epReanalyze', 'analyzePoseAtT', 'normalizeAndRetry', 'initModel'].forEach(function (n) {
    if (n === omit) return;
    orig[n] = ctx[n] = n === 'initModel' ? async function () { ctx.detector = { estimatePoses: function () {} }; } : function () {};
  });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8'), ctx);
  return { ctx: ctx, orig: orig };
}
async function browserPartChecks() {
  var r = runBrowserPart('analyzePoseAtT');
  ok('browser part, a page function missing: nothing replaced', Object.keys(r.orig).every(function (n) { return r.ctx[n] === r.orig[n]; }));
  ok('browser part, a page function missing: the tab title says so', /NOT ACTIVE/.test(r.ctx.document.title));
  eq('browser part, a page function missing: reported', r.ctx.EslScanV2.inactive, ['analyzePoseAtT']);

  var r2 = runBrowserPart(null);
  ok('browser part, all present: every function replaced', Object.keys(r2.orig).every(function (n) { return r2.ctx[n] !== r2.orig[n]; }));
  ok('browser part, all present: reports itself active', r2.ctx.EslScanV2.active === true);
  var r3 = runBrowserPart(null, '?paid=1&detector=v1');
  ok('browser part, ?detector=v1: nothing replaced', Object.keys(r3.orig).every(function (n) { return r3.ctx[n] === r3.orig[n]; }));
  ok('browser part, ?detector=v1: reports itself inactive', r3.ctx.EslScanV2.active === false);
  var r4 = runBrowserPart(null, '?detector=v12');
  ok('browser part, ?detector=v12 is not the escape hatch', r4.ctx.EslScanV2.active === true);
  await r2.ctx.initModel();
  ok('browser part: initModel installs the detector proxy', r2.ctx.detector && r2.ctx.detector.eslV2Proxy === true);
  eq('browser part: the title is untouched', r2.ctx.document.title, 'esFormLab v2');
}

// ── autoScanAll: no front clip, three clips, a front clip that failed to decode ──
// The real gait-data.js (PHASE_DEFS, eflNoFront and its helpers) and scan-v2.js run in one
// vm context; everything else autoScanAll touches on the page is a fake. Clips, poses and
// picks are made up: 90 frames at 30 fps, every frame posed, no warning-worthy picks.
var SCAN_FPS = 30, SCAN_FRAMES = 90;
function clipStore(view) {
  var times = [];
  for (var i = 0; i < SCAN_FRAMES; i++) times.push(i / SCAN_FPS);
  return { view: view, ok: true, times: times, videoWidth: 640, videoHeight: 360, nativeWidth: 1920, nativeHeight: 1080,
    duration: SCAN_FRAMES / SCAN_FPS, fps: SCAN_FPS, coverage: 1,
    frameCount: function () { return this.times.length; },
    indexAt: function (t) { return Math.max(0, Math.min(this.times.length - 1, Math.round(t * SCAN_FPS))); } };
}
// what FrameStore gives for a clip the browser could not decode
function failedStore(view) {
  return { view: view, ok: false, times: [], videoWidth: 0, videoHeight: 0, nativeWidth: 0, nativeHeight: 0,
    duration: NaN, fps: null, coverage: 0, frameCount: function () { return 0; }, indexAt: function () { return -1; } };
}
// a page element: records the scan bar's widths and the scan step's texts
function fakeElement(id, log) {
  var classes = [], width = '', text = '';
  var el = { id: id, innerHTML: '', hidden: false, width: 0, height: 0, style: {},
    classList: { add: function (c) { if (classes.indexOf(c) < 0) classes.push(c); }, contains: function (c) { return classes.indexOf(c) >= 0; } },
    getContext: function () { return { drawImage: function () {} }; } };
  Object.defineProperty(el.style, 'width', { enumerable: true, get: function () { return width; },
    set: function (v) { width = v; if (id === 'scan-bar') log.bar.push(parseFloat(v)); } });
  Object.defineProperty(el, 'textContent', { enumerable: true, get: function () { return text; },
    set: function (v) { text = String(v); if (id === 'scan-step') log.steps.push(text); } });
  return el;
}
// opts: front = videoEls.front (a store or null), uploadFront = a front file was chosen,
// mobile = IS_MOBILE_RUNNER, noFrontBefore = eflNoFront left over from an earlier session.
function runScan(opts) {
  var vm = require('vm'), fs = require('fs');
  var noop = function () {};
  var log = { bar: [], steps: [], warnings: [], tracked: [], detected: [], stance: [], cards: [] };
  var els = {}, tracks = new Map(), ctx;
  var full = [{ leg: 'left', strike: 1, toeOff: 5 }, { leg: 'right', strike: 9, toeOff: 13 }, { leg: 'left', strike: 17, toeOff: 21 }];
  ctx = {
    console: { error: noop, warn: noop, log: noop }, location: { search: '' },
    document: { title: 'esFormLab',
      getElementById: function (id) {
        // as on the page, a phase-list row exists only once the scan has written the list
        if (/^spl-/.test(id) && (els['scan-phase-list'] ? els['scan-phase-list'].innerHTML : '').indexOf('id="' + id + '"') < 0) return null;
        return els[id] || (els[id] = fakeElement(id, log));
      } },
    setTimeout: function (fn) { fn(); return 0; }, setInterval: setInterval, clearInterval: clearInterval,
    detector: { estimatePoses: async function () { return []; } }, scanDetector: null, scanDetectorPromise: null,
    IS_MOBILE_RUNNER: !!opts.mobile, LOAD_BAR_PCT: 30,
    videoEls: { side: clipStore('side'), front: opts.front, back: clipStore('back') },
    uploadedFiles: { side: { name: 'side.mp4' }, front: opts.uploadFront ? { name: 'front.mp4' } : null, back: { name: 'back.mp4' } },
    phases: {}, scanInProgress: true, isViewingSaved: false, epAnalyzing: false, expandKey: null, epCurrentT: 0,
    eflCheckCancel: noop, clearScanWarnings: function () { log.warnings.length = 0; },
    pushScanWarning: function (m) { log.warnings.push(m); },
    showScanWarningsSummary: noop, buildPhaseGroups: noop, buildSummaryTable: noop, eflSyncWalkthroughLine: noop,
    eflTourDone: function () { return true; }, startTour: noop, isSideView: function () { return true; },
    getVideoFrame: function (store) { return Promise.resolve(store && store.ok ? {} : null); }, drawMiniSkeleton: noop,
    // the page's: builds only the session's phases, so the front ones stay undefined with no front clip
    initPhases: function (midT) {
      var t = (typeof midT === 'number' && isFinite(midT)) ? midT : 0;
      ctx.eflActivePhaseDefs().forEach(function (def) {
        var copy = ctx.eflPhaseCopy(def);
        ctx.phases[def.key] = { key: def.key, label: def.label, videoKey: def.videoKey, detectsIssue: copy.detectsIssue, t: t, detected: false, kps: null };
      });
    },
    // the page's, with its early return for a phase the session doesn't have
    applyStanceFrame: function (key, frame) {
      log.stance.push(key);
      if (!ctx.phases[key]) return;
      var item = ctx.document.getElementById('spl-' + key), tEl = ctx.document.getElementById('spl-t-' + key);
      if (frame) {
        ctx.phases[key].t = frame.t; ctx.phases[key].kps = frame.kps; ctx.phases[key].detected = true;
        if (item) item.classList.add('found');
        if (tEl) tEl.textContent = frame.t.toFixed(2) + 's';
      } else {
        if (item) item.classList.add('not-found');
        if (tEl) tEl.textContent = 'manual';
      }
    },
    autoScanAll: async function () {}, analyzeCard: function (key) { log.cards.push(key); },
    epReanalyze: noop, analyzePoseAtT: async function () {}, normalizeAndRetry: function (c) { return c; }, initModel: async function () {},
    EslPoseV2: {
      tracked: function (store) { return tracks.get(store) || null; },
      trackClip: async function (store, o) {
        log.tracked.push(store.view);
        o.onProgress(0, 'finding the runner'); o.onProgress(0.8, 'posing frames'); o.onProgress(1, 'posing frames');
        var res = { frames: store.times.map(function (t, i) { return { i: i, t: t, dup: false, roi: [0, 0, 100], kps: pose(i % 7) }; }), diag: { ambiguous: false } };
        tracks.set(store, res);
        return res;
      },
      poseAt: async function () { return null; }, poseScore: function () { return 0.8; }
    },
    EslGaitEvents: {
      detect: function (input) {
        log.detected.push(input.view);
        if (input.view === 'side') {
          return { phases: { l_foot: 3, r_foot: 18, l_toe: 9, r_toe: 25, mid: 6 }, contacts: full,
            diag: { confidence: { l_foot: 0.8, r_foot: 0.7, l_toe: 0.6, r_toe: 0.9, mid: 0.5 }, legSwap: false } };
        }
        return { phases: { l: 4, r: 12 }, contacts: [], diag: { mids: 8, confidence: { l: 0.5, r: 0.5 }, legSwap: false } };
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gait-data.js'), 'utf8'), ctx);
  if (opts.noFrontBefore != null) ctx.eflNoFront = opts.noFrontBefore;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8'), ctx);
  return { ctx: ctx, log: log, els: els };
}
async function scanned(opts) {
  var w = runScan(opts);
  w.active = w.ctx.EslScanV2.active;
  try { await w.ctx.autoScanAll(); w.threw = null; } catch (e) { w.threw = String(e && e.stack || e); }
  return w;
}
// the bar at the stage boundaries (75, 87, 100), repeats dropped
function barStages(bar) {
  return bar.filter(function (v) { return v === 75 || v === 87 || v === 100; })
    .filter(function (v, i, a) { return i === 0 || a[i - 1] !== v; });
}
function rising(bar) { return bar.every(function (v, i) { return i === 0 || v >= bar[i - 1]; }); }
// an element the scan wrote, or a blank one if it never got that far
function elOf(w, id) { return w.els[id] || fakeElement(id, { bar: [], steps: [] }); }
function rowCount(w) { return elOf(w, 'scan-phase-list').innerHTML.split('class="spl-item"').length - 1; }
function cooldowns(w) { return w.log.steps.filter(function (s) { return /^Pausing briefly/.test(s); }).length; }
var SIDE_AND_BACK = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid', 'mid_back_l', 'mid_back_r'];
var ALL_NINE = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid', 'mid_front_l', 'mid_front_r', 'mid_back_l', 'mid_back_r'];

async function scanChecks() {
  // no front clip; eflNoFront still false, as on a rescan that skips startAllVideos
  var a = await scanned({ front: null, uploadFront: false });
  ok('scan, no front: v2 is active', a.active === true);
  ok('scan, no front: resolves', !a.threw, a.threw);
  eq('scan, no front: the session has no front clip', a.ctx.eflNoFront, true);
  eq('scan, no front: only side and back are tracked', a.log.tracked, ['side', 'back']);
  eq('scan, no front: ... and picked', a.log.detected, ['side', 'back']);
  eq('scan, no front: no warnings (none about the front clip)', a.log.warnings, []);
  eq('scan, no front: seven rows in the phase list', rowCount(a), 7);
  ok('scan, no front: no front rows', elOf(a, 'scan-phase-list').innerHTML.indexOf('spl-mid_front_') < 0);
  eq('scan, no front: seven phases built', Object.keys(a.ctx.phases), SIDE_AND_BACK);
  eq('scan, no front: stance frames applied to the back phases only', a.log.stance, ['mid_back_l', 'mid_back_r']);
  ok('scan, no front: back picks shown', elOf(a, 'spl-mid_back_l').classList.contains('found') && elOf(a, 'spl-t-mid_back_r').textContent === '0.40s' &&
    a.ctx.phases.mid_back_r.detected === true);
  eq('scan, no front: the bar goes 75 -> 100', barStages(a.log.bar), [75, 100]);
  ok('scan, no front: the bar only rises', rising(a.log.bar), a.log.bar);
  eq('scan, no front: done text', elOf(a, 'scan-step').textContent, 'Done — side and back videos scanned');
  eq('scan, no front: diag line', elOf(a, 'scan-diag').textContent, 'Side: 1920x1080 30fps 3.0s | Back: 1920x1080 30fps');
  var sb = elOf(a, 'scan-summary-bar').innerHTML;
  ok('scan, no front: no Front in the scan details', sb.indexOf('Front') < 0, sb);
  ok('scan, no front: totals of 7', sb.indexOf('7 of 7 auto-detected') > 0 && sb.indexOf('Auto-detected: <strong>7/7</strong>') > 0, sb);
  ok('scan, no front: nothing flagged', sb.indexOf('check these') < 0 && sb.indexOf('could not be decoded') < 0, sb);
  eq('scan, no front: cards analysed', a.log.cards, SIDE_AND_BACK);
  eq('scan, no front: scan ends', a.ctx.scanInProgress, false);

  // three clips (eflNoFront left over from an earlier session without one)
  var b = await scanned({ front: clipStore('front'), uploadFront: true, noFrontBefore: true });
  ok('scan, three clips: resolves', !b.threw, b.threw);
  eq('scan, three clips: the session has a front clip', b.ctx.eflNoFront, false);
  eq('scan, three clips: every clip tracked', b.log.tracked, ['side', 'front', 'back']);
  eq('scan, three clips: no warnings', b.log.warnings, []);
  eq('scan, three clips: nine rows in the phase list', rowCount(b), 9);
  eq('scan, three clips: nine phases built', Object.keys(b.ctx.phases), ALL_NINE);
  eq('scan, three clips: stance frames applied', b.log.stance, ['mid_front_l', 'mid_front_r', 'mid_back_l', 'mid_back_r']);
  eq('scan, three clips: the bar goes 75 -> 87 -> 100', barStages(b.log.bar), [75, 87, 100]);
  ok('scan, three clips: the bar only rises', rising(b.log.bar), b.log.bar);
  eq('scan, three clips: done text', elOf(b, 'scan-step').textContent, 'Done — all 3 videos scanned');
  eq('scan, three clips: diag line', elOf(b, 'scan-diag').textContent, 'Side: 1920x1080 30fps 3.0s | Front: 1920x1080 30fps | Back: 1920x1080 30fps');
  sb = elOf(b, 'scan-summary-bar').innerHTML;
  ok('scan, three clips: Front in the scan details', sb.indexOf('<span class="ss-item ">Front: <strong>1920x1080</strong></span>') > 0, sb);
  ok('scan, three clips: totals of 9', sb.indexOf('9 of 9 auto-detected') > 0 && sb.indexOf('Auto-detected: <strong>9/9</strong>') > 0, sb);
  eq('scan, three clips: cards analysed', b.log.cards, ALL_NINE);
  eq('scan, three clips: scan ends', b.ctx.scanInProgress, false);

  // a front clip was uploaded but failed to decode: as before, front phases and a warning
  var c = await scanned({ front: failedStore('front'), uploadFront: true });
  ok('scan, front failed: resolves', !c.threw, c.threw);
  eq('scan, front failed: the session has a front clip', c.ctx.eflNoFront, false);
  eq('scan, front failed: the failed clip is not tracked', c.log.tracked, ['side', 'back']);
  eq('scan, front failed: one warning', c.log.warnings.length, 1);
  ok('scan, front failed: the front clip couldn’t be decoded', /^Front video couldn’t be decoded by this browser/.test(c.log.warnings[0]), c.log.warnings);
  eq('scan, front failed: nine rows in the phase list', rowCount(c), 9);
  ok('scan, front failed: front rows say manual', elOf(c, 'spl-mid_front_l').classList.contains('not-found') && elOf(c, 'spl-t-mid_front_r').textContent === 'manual');
  eq('scan, front failed: front phase times fall back as before', [c.ctx.phases.mid_front_l.t, c.ctx.phases.mid_front_r.t], [30 * 0.35, 30 * 0.65]);
  eq('scan, front failed: the bar goes 75 -> 87 -> 100', barStages(c.log.bar), [75, 87, 100]);
  eq('scan, front failed: done text', elOf(c, 'scan-step').textContent, 'Done — all 3 videos scanned');
  eq('scan, front failed: diag line', elOf(c, 'scan-diag').textContent, 'Side: 1920x1080 30fps 3.0s | Front: failed | Back: 1920x1080 30fps');
  sb = elOf(c, 'scan-summary-bar').innerHTML;
  ok('scan, front failed: Front: failed, flagged', sb.indexOf('<span class="ss-item warn">Front: <strong>failed</strong></span>') > 0 && sb.indexOf('check these') > 0, sb);
  ok('scan, front failed: totals of 9', sb.indexOf('7 of 9 auto-detected') > 0 && sb.indexOf('Auto-detected: <strong>7/9</strong>') > 0, sb);
  ok('scan, front failed: the decode note', sb.indexOf('A video could not be decoded by this browser') > 0, sb);
  eq('scan, front failed: cards analysed', c.log.cards, SIDE_AND_BACK);

  // phones: one cool-down with no front clip, two with three clips
  var m1 = await scanned({ front: null, uploadFront: false, mobile: true });
  ok('scan, phone, no front: resolves', !m1.threw, m1.threw);
  eq('scan, phone, no front: one cool-down', cooldowns(m1), 1);
  var m3 = await scanned({ front: clipStore('front'), uploadFront: true, mobile: true });
  ok('scan, phone, three clips: resolves', !m3.threw, m3.threw);
  eq('scan, phone, three clips: two cool-downs', cooldowns(m3), 2);

  // no front file chosen but a store left in videoEls.front: never read
  var reads = [];
  var stale = new Proxy({}, { get: function (o, k) { reads.push(String(k)); return undefined; } });
  var s = await scanned({ front: stale, uploadFront: false });
  ok('scan, no front, a store left over: resolves', !s.threw, s.threw);
  eq('scan, no front, a store left over: never read', reads, []);
}

// ── build-page.js: the v2 script tags in the main page, and its drift guards ──
function buildChecks() {
  var B = require(path.join(__dirname, 'build-page.js'));
  var inp = B.readInputs();
  function fails(label, src, v2, modules, re) {
    var msg = null;
    try { B.build(src, v2 || inp.v2, modules || inp.modules); } catch (e) { msg = e.message; }
    ok(label, msg && re.test(msg), msg);
  }
  var out = B.build(inp.src, inp.v2, inp.modules);
  B.V2_SCRIPTS.forEach(function (f) {
    ok('build: v2/' + f + ' loads with its content hash', out.indexOf('<script src="v2/' + f + '?v=' + B.sha(inp.v2[f]) + '"></script>') >= 0);
  });
  eq('build: running it twice changes nothing', B.build(out, inp.v2, inp.modules), out);
  ok('build: the v2 block sits after the inline script and before initModel()',
    out.indexOf(B.END + '\n<script>initModel();</script>') > 0 && out.lastIndexOf('</script>', out.indexOf(B.BEGIN)) > out.indexOf('async function autoScanAll'));
  ok('build: phase labels record which detection ran', /isCorrect: !!isCorrect,\n    detector: \(typeof EslScanV2 !== 'undefined' && EslScanV2\.active\) \? 'v2' : 'v1',\n/.test(out));
  var changed = Object.assign({}, inp.v2); changed['scan-v2.js'] += '\n// edit';
  ok('build: an edited v2 script gets a new hash', B.build(out, changed, inp.modules).indexOf('scan-v2.js?v=' + B.sha(changed['scan-v2.js'])) > 0);
  fails('build: missing markers fail', inp.src.replace(B.BEGIN, ''), null, null, /markers/);
  fails('build: doubled markers fail', inp.src.replace(B.END, B.END + '\n' + B.BEGIN + '\n' + B.END), null, null, /markers/);
  fails('build: a renamed global the v2 scripts use fails',
    inp.src.replace(/\nasync function analyzePoseAtT\(/, '\nasync function analysePoseAtT('), null, null, /analyzePoseAtT/);
  fails('build: a changed autoScanAll fails until the v2 copy is reviewed',
    inp.src.replace('\nasync function autoScanAll(){\n', '\nasync function autoScanAll(){\n  // a new line\n'), null, null, /autoScanAll .*changed/);
  ok('declares: comma-list let', B.declares('let a=1, phases={};\n', 'phases'));
  ok('declares: function', B.declares('async function foo(x){\n}\n', 'foo'));
  ok('declares: not a property', !B.declares('  obj.foo = 1;\n', 'foo'));
  ok('declares: not a nested function', !B.declares('  function foo(){}\n', 'foo'));
}

(async function () {
  await poseOrSearchChecks();
  await waitForChecks();
  await browserPartChecks();
  await scanChecks();
  buildChecks();
  console.log('scan-v2: ' + (checks - failures) + ' of ' + checks + ' checks passed');
  if (failures) process.exit(1);
})().catch(function (e) { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
