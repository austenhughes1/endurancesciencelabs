// ════════════════════════════════════════════════════════════════
// esformlab/v2/scan-v2.test.js
//
// Checks of scan-v2.js's pure helpers (EslScanV2._core). Run with plain node:
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

console.log('scan-v2: ' + (checks - failures) + ' of ' + checks + ' checks passed');
if (failures) process.exit(1);
