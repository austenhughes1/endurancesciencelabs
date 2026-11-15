// ════════════════════════════════════════════════════════════════
// esformlab/v2/pose-v2.test.js
//
// Checks of the runner localiser's pure maths (EslPoseV2._core). Run with plain node:
//
//   node esformlab/v2/pose-v2.test.js
//
// No browser, no TF.js, no real video: every input here is made up. The "world" is a
// synthetic scene (flat textured background, a dark rectangle for a runner) and the
// "model" is a fake that returns the made-up runner's keypoints when a square crop
// frames them sensibly, and low scores otherwise -- enough to drive the whole
// localiser (thumbnails -> duplicates and cuts -> background -> seeds -> tracks ->
// selection -> smoothing) and the pose pass.
// ════════════════════════════════════════════════════════════════
'use strict';
var path = require('path');

var Pose = require(path.join(__dirname, 'pose-v2.js'));
var C = Pose._core;

var failures = 0, checks = 0;
function ok(label, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL ' + label + (extra !== undefined ? ': ' + JSON.stringify(extra) : '')); }
}
function close(label, got, want, tol) {
  checks++;
  var good = typeof got === 'number' && Math.abs(got - want) <= (tol == null ? 1e-6 : tol);
  if (!good) { failures++; console.log('  FAIL ' + label + ': got ' + got + ', want ' + want + ' +- ' + tol); }
}
function eq(label, got, want) {
  checks++;
  var a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.log('  FAIL ' + label + ': got ' + a + ', want ' + b); }
}
async function section(name, fn) { console.log(name); await fn(); }

// ── a synthetic world ─────────────────────────────────────────────────────
// A runner is {x, y, h, score}: hip centre (frame px), standing height (px) and the
// score the fake model gives their keypoints. Keypoint layout in units of h, relative to
// the hip centre (x right, y down): nose -0.55, shoulders -0.4, hips 0, knees 0.25, ankles 0.48.
var LAYOUT = [[0, -0.55], [-0.02, -0.57], [0.02, -0.57], [-0.04, -0.55], [0.04, -0.55], [-0.06, -0.4], [0.06, -0.4],
  [-0.08, -0.2], [0.08, -0.2], [-0.07, -0.02], [0.07, -0.02], [-0.04, 0], [0.04, 0], [-0.05, 0.25], [0.05, 0.25],
  [-0.06, 0.48], [0.06, 0.48]];

// Optional: r.swing (ankles swing +-swing x h in x with phase r.ph, as a runner's feet do),
// r.flip (upside down).
function bodyKps(r) {
  return LAYOUT.map(function (o, j) {
    var dx = o[0], dy = r.flip ? -o[1] : o[1];
    if (r.swing && (j === 15 || j === 16)) dx += (j === 15 ? 1 : -1) * r.swing * Math.sin(r.ph || 0);
    return [r.x + dx * r.h, r.y + dy * r.h, r.score];
  });
}

// The fake model: the runner whose hips are inside the crop and who fills a sensible share of
// it (0.2..1.3 of the crop side) is "seen"; the largest such runner wins. Keypoints outside the
// crop or outside the frame score 0.05. Nobody seen: every keypoint at the crop centre, 0.05.
function fakePose(people, W, H) {
  return function (roi) {
    var x0 = roi[0], y0 = roi[1], s = roi[2], best = null;
    people.forEach(function (r) {
      if (!r) return;
      var inside = r.x >= x0 && r.x <= x0 + s && r.y >= y0 && r.y <= y0 + s && r.x >= 0 && r.x <= W && r.y >= 0 && r.y <= H;
      var f = r.h / s;
      if (inside && f > 0.2 && f < 1.3 && (!best || r.h > best.h)) best = r;
    });
    if (!best) { var k = []; for (var j = 0; j < 17; j++) k.push([x0 + s / 2, y0 + s / 2, 0.05]); return k; }
    return bodyKps(best).map(function (p) {
      var seen = p[0] >= x0 && p[0] <= x0 + s && p[1] >= y0 && p[1] <= y0 + s && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
      return [p[0], p[1], seen ? p[2] : 0.05];
    });
  };
}

// Grey thumbnail (1/K scale) of a frame: textured static background + dark runner boxes.
function thumb(W, H, K, people, bgShift) {
  var gw = Math.floor(W / K), gh = Math.floor(H / K), g = new Uint8Array(gw * gh);
  for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) g[y * gw + x] = 80 + ((x * 7 + y * 13 + (bgShift || 0)) % 40);
  people.forEach(function (r) {
    if (!r) return;
    var bx0 = Math.floor((r.x - 0.12 * r.h) / K), bx1 = Math.ceil((r.x + 0.12 * r.h) / K);
    var by0 = Math.floor((r.y - 0.6 * r.h) / K), by1 = Math.ceil((r.y + 0.5 * r.h) / K);
    for (var yy = Math.max(0, by0); yy < Math.min(gh, by1); yy++) for (var xx = Math.max(0, bx0); xx < Math.min(gw, bx1); xx++) g[yy * gw + xx] = 20;
  });
  return g;
}

// Build a localiser context for a clip of n frames; scene(i) -> {people:[...], bgShift}.
function makeClip(W, H, n, fps, scene) {
  var K = 4, gw = Math.floor(W / K), gh = Math.floor(H / K);
  var greys = [], diff = [null], dmax = [null];
  for (var i = 0; i < n; i++) {
    var sc = scene(i);
    greys.push(sc.same && i > 0 ? greys[i - 1] : thumb(W, H, K, sc.people, sc.bgShift));
    if (i > 0) { var fd = C.frameDiff(greys[i], greys[i - 1], gw, gh, 8); diff.push(fd.diff); dmax.push(fd.dmax); }
  }
  var calls = 0;
  return {
    calls: function () { return calls; },
    ctx: {
      n: n, W: W, H: H, span: (n - 1) / fps, dmax: dmax, diff: diff, gw: gw, gh: gh, K: K,
      grey: function (i) { return greys[i]; },
      pose: function (i, roi) { calls++; return fakePose(scene(i).people, W, H)(roi); }
    }
  };
}

function hipOf(k) { return [(k[11][0] + k[12][0]) / 2, (k[11][1] + k[12][1]) / 2]; }
function roiCentre(r) { return [r[0] + r[2] / 2, r[1] + r[2] / 2]; }

(async function main() {

  await section('§1 module shape: a classic script that also loads in node', function () {
    ok('trackClip is a function', typeof Pose.trackClip === 'function');
    ok('poseAt is a function', typeof Pose.poseAt === 'function');
    eq('17 MoveNet keypoint names', Pose.NAMES.length, 17);
    eq('name 15', Pose.NAMES[15], 'left_ankle');
    eq('core = shoulders, hips, knees, ankles', C.CORE, [5, 6, 11, 12, 13, 14, 15, 16]);
  });

  await section('§2 frame differences, duplicates and cuts', function () {
    var a = new Uint8Array(32 * 16), b = new Uint8Array(32 * 16);
    for (var i = 0; i < a.length; i++) { a[i] = 100; b[i] = 100; }
    for (var y = 0; y < 8; y++) for (var x = 8; x < 16; x++) b[y * 32 + x] = 140;   // one 8x8 block changes by 40
    var d = C.frameDiff(b, a, 32, 16, 8);
    close('mean abs diff', d.diff, 64 * 40 / 512, 1e-3);
    close('largest block diff', d.dmax, 40, 1e-3);

    // ordinary footage: every frame differs a little -> no duplicates
    var dm = [null]; for (i = 1; i < 60; i++) dm.push(3 + (i * 7) % 5);
    eq('no duplicates in ordinary footage', C.dupFlags(dm).filter(Boolean).length, 0);
    // a frozen frame (below 0.3 grey levels) is a duplicate even in ordinary footage
    dm[20] = 0.1;
    eq('a frozen frame is a duplicate', C.dupFlags(dm).map(function (v, j) { return v ? j : -1; }).filter(function (j) { return j >= 0; }), [20]);
    // screen recording: every other frame repeats with a little encoder noise (0.6 > dupAbs)
    var sr = [null]; for (i = 1; i < 60; i++) sr.push(i % 2 ? 6 + (i % 3) : 0.6);
    var dupSr = C.dupFlags(sr);
    eq('repeats in a screen recording are duplicates', dupSr.filter(Boolean).length, 29);
    ok('...and they are the even frames', dupSr.every(function (v, j) { return j === 0 || (v === 1) === (j % 2 === 0); }));

    // a cut: one huge global change against a calm neighbourhood
    var df = [null]; for (i = 1; i < 60; i++) df.push(3 + (i % 4));
    df[30] = 42;
    eq('one cut found', C.cutFlags(df).map(function (v, j) { return v ? j : -1; }).filter(function (j) { return j >= 0; }), [30]);
    // fast panning: every frame changes a lot -> no cut
    var pan = [null]; for (i = 1; i < 60; i++) pan.push(20 + (i % 5));
    eq('steady high motion is not a cut', C.cutFlags(pan).filter(Boolean).length, 0);
  });

  await section('§3 background, foreground blobs, black tiles', function () {
    var W = 320, H = 180, K = 4, gw = W / K, gh = H / K;
    var frames = [];
    for (var i = 0; i < 31; i++) frames.push(thumb(W, H, K, [{ x: 20 + i * 9, y: 110, h: 80, score: 0.8 }]));
    var bg = C.bgMedian(frames), clean = thumb(W, H, K, []);
    var wrong = 0; for (var p = 0; p < bg.length; p++) if (bg[p] !== clean[p]) wrong++;
    eq('median of 31 frames is the empty background', wrong, 0);
    ok('runner covers under 10% of the frame (static camera)', C.fgFraction(frames[10], bg) < 0.10, C.fgFraction(frames[10], bg));
    var bl = C.blobs(frames[10], bg, gw, gh, K);
    eq('one blob', bl.length, 1);
    var rx = 20 + 10 * 9;   // runner box x: rx +- 9.6, y: 62 .. 150
    ok('blob box holds the runner (frame px, dilated by one thumbnail px)', bl[0].x0 <= rx - 9 && bl[0].x1 >= rx + 9 && bl[0].y0 <= 62 && bl[0].y1 >= 148 && bl[0].x1 - bl[0].x0 < 40, bl[0]);
    var black = new Uint8Array(gw * gh);
    eq('mean grey of a black area', C.greyMean(black, gw, gh, K, 0, 0, 100), 0);
    ok('mean grey of the textured background', C.greyMean(clean, gw, gh, K, 0, 0, 100) > 80);
  });

  await section('§4 seed proposals and probe frames', function () {
    eq('level 0: whole frame', C.tiles(0, 1280, 720), [{ cx: 640, cy: 360, s: 1280 }]);
    var t1 = C.tiles(1, 1280, 720);
    eq('level 1 landscape: 3 short-side squares', t1.length, 3);
    eq('level 1 squares span the frame', [t1[0].cx - 360, t1[2].cx + 360], [0, 1280]);
    eq('level 1 portrait: 3 squares down the frame', C.tiles(1, 720, 1280).map(function (r) { return r.cy; }), [360, 640, 920]);
    eq('level 2 landscape: 7 x 3 half-size squares', C.tiles(2, 1280, 720).length, 21);
    var u = []; for (var i = 0; i < 100; i++) u.push(0);
    eq('16 spread probes', C.probeList(100, u).length, 16);
    u[40] = 1;
    ok('a probe 3 frames after a cut', C.probeList(100, u).indexOf(43) >= 0);
  });

  await section('§5 ROI from a pose, plausibility, crop maths', function () {
    var k = bodyKps({ x: 400, y: 300, h: 200, score: 0.9 });
    var r = C.roiFromPose(k);
    close('ROI centre x = hip midpoint', r.cx, 400, 1e-9);
    close('ROI centre y = hip midpoint', r.cy, 300, 1e-9);
    close('ROI side = 2 x max(1.95 x torso range, 1.25 x body range)', r.s, 2 * Math.max(1.95 * 0.4 * 200, 1.25 * 0.55 * 200), 1e-9);
    ok('upright runner is plausible', C.plausible(k, r.s));
    var flipped = k.map(function (p) { return [p[0], 600 - p[1], p[2]]; });
    ok('upside-down pose is not', !C.plausible(flipped, r.s));
    var weak = k.map(function (p, j) { return j >= 11 && j <= 12 ? [p[0], p[1], 0.1] : p; });
    eq('no hips above 0.2 -> no ROI', C.roiFromPose(weak), null);
    close('core score', C.coreScore(k), 0.9, 1e-12);

    // MoveNet output is [y, x, score] normalised to the crop
    var d = new Float32Array(51); d[15 * 3] = 0.5; d[15 * 3 + 1] = 0.25; d[15 * 3 + 2] = 0.7;
    var m = C.mapMoveNet(d, [100, 50, 200]);
    eq('crop -> frame px (ankle)', [m[15][0], m[15][1], +m[15][2].toFixed(3)], [150, 150, 0.7]);
    var cr = C.cropRects([-50, 10, 200], 640, 360, 256);
    eq('ROI hanging off the left edge: clipped source', [cr.sx, cr.sy, cr.sw, cr.sh], [0, 10, 150, 200]);
    eq('...drawn at the matching place in the crop', [cr.dx, cr.dy, cr.dw, cr.dh], [64, 0, 192, 256]);
    eq('ROI fully off the frame', C.cropRects([700, 0, 100], 640, 360, 256), null);
    var named = C.named(k);
    eq('named keypoints like pose-detection', Object.keys(named[0]), ['x', 'y', 'score', 'name']);
    eq('pose-detection pose score (mean of keypoints above 0.2)', +C.poseScore(named).toFixed(6), 0.9);
  });

  await section('§6 BlazePose landmark decoding', function () {
    var ld = new Float32Array(39 * 5);
    ld[27 * 5] = 128; ld[27 * 5 + 1] = 192; ld[27 * 5 + 3] = 0;   // left ankle at the crop's (0.5, 0.75), visibility logit 0
    eq('no pose flag -> null', C.decodeBlaze(ld, 0.3, null, [0, 0, 100]), null);
    var k = C.decodeBlaze(ld, 0.9, null, [10, 20, 100]);
    eq('33 landmarks', k.length, 33);
    eq('crop -> frame px, sigmoid score', [k[27][0], k[27][1], k[27][2]], [60, 95, 0.5]);
    var coco = C.namedBlaze(k);
    eq('mapped to the 17 MoveNet keypoints', [coco.length, coco[15].name, coco[15].x], [17, 'left_ankle', 60]);
    eq('full BlazePose set kept alongside', [coco.blaze33.length, coco.blaze33[29].name], [33, 'left_heel']);
  });

  await section('§7 track prediction follows growth toward the camera', function () {
    // a runner whose ROI grows 3% per frame and drifts 4 px per frame
    var r = { cx: 300, cy: 200, s: 100 }, v = { x: 0, y: 0, ls: 0 }, err = [];
    for (var i = 1; i <= 40; i++) {
      var p = C.trackPredict(r, v, 0);
      var truth = { cx: 300 + 4 * i, cy: 200, s: 100 * Math.pow(1.03, i) };
      err.push(Math.abs(Math.log(p.pr.s / truth.s)));
      ok('measurement consistent with prediction (frame ' + i + ')', C.consistentRoi(truth, p.pr));
      var a = C.trackAccept(r, v, p.pr, truth, p.grow); r = a.r; v = a.v;
    }
    ok('predicted size within 4% after settling', err.slice(-10).every(function (e) { return e < 0.04; }), err.slice(-10));
    close('size velocity learns the 3% growth', v.ls, Math.log(1.03), 0.004);
    close('x velocity learns 4 px per frame', v.x, 4, 0.05);
    // a miss widens the search box 8% and keeps moving along the velocity
    var p2 = C.trackPredict(r, v, 1);
    close('one miss: box 8% larger', p2.pr.s / (r.s * Math.exp(v.ls)), 1.08, 1e-9);
    var m = C.trackMiss(v, p2.pr, p2.grow);
    close('miss: velocity damped', m.v.x, v.x * 0.85, 1e-12);
    ok('far off measurement is not consistent', !C.consistentRoi({ cx: r.cx + r.s, cy: r.cy, s: r.s }, r));
    ok('box leaving the frame', C.outOfFrame({ cx: 700, cy: 100, s: 100 }, 640, 360) && !C.outOfFrame({ cx: 620, cy: 100, s: 100 }, 640, 360));
  });

  await section('§8 smoothing: interpolate misses, steady generous size', function () {
    // 30 unique frames of one track at 30 fps; frame 10 a miss, frame 20 a one-frame size spike
    var owner = [], ownerId = [], uniq = [];
    for (var u = 0; u < 30; u++) {
      owner.push({ cx: 100 + 5 * u + (u % 2 ? 3 : -3), cy: 200, s: u === 20 ? 260 : 150, cs: 0.7, hit: u === 10 ? 0 : 1 });
      ownerId.push(0); uniq.push(u);
    }
    owner[10].cx = 999;   // a miss's predicted centre is ignored (interpolated from the hits)
    var ucut = uniq.map(function () { return 0; });
    var sm = C.smoothRois(owner, ownerId, ucut, uniq, 30, 30, null);
    var c10 = roiCentre(sm.rois[10]);
    close('missed frame: centre interpolated between its neighbours', c10[0], 150, 4);
    eq('missed frame marked interpolated', sm.src[10], 'i');
    ok('one-frame size spike removed', sm.rois.every(function (r) { return Math.abs(r[2] - 150) < 1; }), sm.rois.map(function (r) { return r[2]; }));
    var jit = 0; for (u = 3; u < 27; u++) jit = Math.max(jit, Math.abs(roiCentre(sm.rois[u])[0] - (100 + 5 * u)));
    ok('+-3 px centre jitter reduced', jit < 2.5, jit);
    // a dup frame reuses the previous ROI; frames without an owner stay null
    var owner2 = owner.slice(0, 10).concat([null, null]), uniq2 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12];
    var dup = []; for (u = 0; u < 13; u++) dup.push(u === 10 ? 1 : 0);
    var sm2 = C.smoothRois(owner2, owner2.map(function (o) { return o ? 0 : -1; }), uniq2.map(function () { return 0; }), uniq2, 30, 13, dup);
    ok('dup frame reuses the previous ROI', sm2.rois[10] === sm2.rois[9] && sm2.src[10] === 'd');
    ok('frames no track owns have no ROI', sm2.rois[11] === null && sm2.rois[12] === null);
  });

  await section('§9 track selection: the runner wins, bystanders and overlaps drop out', function () {
    function cand(q, meanCs, from, to, hitsAll) {
      var st = new Map(), keys = [];
      for (var u = from; u <= to; u++) { st.set(u, { cx: 0, cy: 0, s: 100, cs: meanCs, hit: hitsAll ? 1 : (u % 2) }); keys.push(u); }
      return { st: st, keys: keys, info: { quality: q, meanCs: meanCs, hits: keys.filter(function (u) { return st.get(u).hit; }).length } };
    }
    var cs = [cand(500, 0.7, 0, 59, true), cand(400, 0.6, 0, 59, true), cand(300, 0.6, 60, 89, true), cand(50, 0.5, 60, 89, true), cand(450, 0.3, 90, 99, true)];
    var sel = C.selectTracks(cs, 100, 8);
    var kept = sel.tracks.filter(function (t) { return t.kept; }).map(function (t) { return t.quality; });
    eq('kept: main + second pass; overlap, weak bystander and low-confidence track dropped', kept, [500, 300]);
    eq('kept tracks numbered by rank, 0 = the runner (frame 70 -> id 1)', sel.ownerId[70], 1);
    eq('ids of all candidates: kept 0 and 1, dropped null', sel.tracks.map(function (t) { return t.id; }), [0, null, null, 1, null]);
    eq('frame 95 owned by nobody', sel.owner[95], null);
    eq('the overlapping strong track is a rival (0.8 of the runner)', sel.rivals.map(function (r) { return [r.quality, r.ratio, r.overlap]; }), [[400, 0.8, 60]]);

    // a person standing still (no leg movement) ranks after every moving track, even when larger
    var still = cand(900, 0.8, 0, 99, true); still.info.still = true;
    var mov = cand(400, 0.6, 0, 99, true), weakMov = cand(150, 0.5, 0, 99, true);
    var sel2 = C.selectTracks([still, weakMov, mov], 100, 8);
    eq('moving track kept as the runner, standing person dropped', sel2.tracks.map(function (t) { return [t.quality, t.kept, t.id]; }), [[400, true, 0], [150, false, null], [900, false, null]]);
    eq('a weak overlapping track is not a rival (under half the runner)', sel2.rivals.length, 0);
    var sel3 = C.selectTracks([cand(900, 0.8, 0, 99, true)].map(function (c) { c.info.still = true; return c; }), 100, 8);
    eq('a standing person is still kept when nobody moves', sel3.tracks[0].kept, true);

    eq('leg motion: fewer than 4 points -> 0', C.legMotion([[0, 0], [1, 1]]), 0);
    var lm = []; for (var i = 0; i < 30; i++) lm.push([0.3 * Math.sin(i / 3), 0.01]);
    ok('leg motion of swinging feet ~ 0.6 of the ROI', C.legMotion(lm) > 0.5 && C.legMotion(lm) < 0.61, C.legMotion(lm));
  });

  await section('§10 whole localiser: a small runner crossing a static camera', async function () {
    var W = 640, H = 360, n = 60;
    var scene = function (i) { return { people: [{ x: 60 + i * 10, y: 220, h: 110, score: 0.8 }] }; };
    var clip = makeClip(W, H, n, 30, scene);
    var loc = await C.localise(clip.ctx);
    eq('static camera found', loc.cam, 'static');
    eq('no duplicates, no cuts', [loc.dup.filter(Boolean).length, loc.cut.filter(Boolean).length], [0, 0]);
    var inFrame = [], outFrame = [];
    for (var i = 0; i < n; i++) { var x = 60 + i * 10; if (x < W - 30) inFrame.push(i); else if (x > W + 15) outFrame.push(i); }
    var missing = inFrame.filter(function (j) { return !loc.rois[j]; });
    eq('every frame with the runner in shot has an ROI', missing, []);
    var worst = 0, worstEnd = 0, sizeErr = 0;
    inFrame.forEach(function (j) {
      var c = roiCentre(loc.rois[j]), e = Math.hypot(c[0] - (60 + j * 10), c[1] - 220) / loc.rois[j][2];
      if (j >= 3 && j <= inFrame[inFrame.length - 1] - 3) worst = Math.max(worst, e); else worstEnd = Math.max(worstEnd, e);
      sizeErr = Math.max(sizeErr, Math.abs(loc.rois[j][2] / (1.56 * 110) - 1));
    });
    ok('ROI centre on the hips away from the track ends (within 1% of ROI size)', worst < 0.01, worst);
    // the smoothing windows are cut short at a track's ends, so a fast runner's ROI lags there
    ok('...and within 10% at the ends (truncated smoothing window)', worstEnd < 0.10, worstEnd);
    ok('ROI size within 5% of the pose-derived size', sizeErr < 0.05, sizeErr);
    ok('no ROI once the runner has left', outFrame.every(function (j) { return !loc.rois[j]; }), outFrame.map(function (j) { return loc.rois[j]; }));
    eq('one track kept', loc.tracks.filter(function (t) { return t.kept; }).length, 1);
    ok('motion blobs gave a seed', loc.tracks.some(function (t) { return t.seedSrc === 'motion'; }) || loc.seeds > 0);
  });

  await section('§11 whole localiser: a runner coming toward the camera (4x growth)', async function () {
    var W = 360, H = 640, n = 60;
    var h = function (i) { return 60 * Math.pow(4, i / (n - 1)); };
    var scene = function (i) { return { people: [{ x: 180 + 0.5 * i, y: 330 - 0.5 * h(i) + 30, h: h(i), score: 0.75 }] }; };
    var clip = makeClip(W, H, n, 30, scene);
    var loc = await C.localise(clip.ctx);
    var missing = []; for (var i = 0; i < n; i++) if (!loc.rois[i]) missing.push(i);
    eq('every frame tracked through the growth', missing, []);
    var ratio = loc.rois.map(function (r, j) { return r ? r[2] / h(j) : 0; });
    // size is the rolling 75th percentile, so a growing runner gets a crop sized a little ahead
    ok('ROI keeps the runner at a steady share of the crop (size / height 1.45..2.0)', ratio.every(function (q) { return q > 1.45 && q < 2.0; }), ratio.map(function (q) { return +q.toFixed(2); }));
    var worst = 0;
    for (i = 0; i < n; i++) { var c = roiCentre(loc.rois[i]), s = scene(i).people[0]; worst = Math.max(worst, Math.hypot(c[0] - s.x, c[1] - s.y) / loc.rois[i][2]); }
    ok('centre within 6% of ROI size', worst < 0.06, worst);
  });

  await section('§12 whole localiser: bystander, scene cut, duplicated frames', async function () {
    // shot 1 (frames 0-29): runner left to right + a small still bystander in the corner;
    // shot 2 (30-59, different background): the runner again, further right and larger.
    // Every 2nd frame is a repeat (a screen recording).
    var W = 640, H = 360, n = 60;
    var scene = function (i) {
      var shot2 = i >= 30, j = i - (i % 2);   // repeats show the previous frame's picture
      var people = shot2
        ? [{ x: 300 + (j - 30) * 6, y: 210, h: 150, score: 0.8 }]
        : [{ x: 80 + j * 8, y: 220, h: 120, score: 0.8 }, { x: 590, y: 90, h: 50, score: 0.45 }];
      return { people: people, bgShift: shot2 ? 17 : 0, same: i % 2 === 1 };
    };
    var clip = makeClip(W, H, n, 60, scene);
    var loc = await C.localise(clip.ctx);
    eq('cut found at the shot change', loc.cut.map(function (v, j) { return v ? j : -1; }).filter(function (j) { return j >= 0; }), [30]);
    eq('every repeat is a duplicate', loc.dup.filter(Boolean).length, 30);
    var spans = loc.rois.every(function (r, j) { return !r || j === 0 || !loc.rois[j - 1] || j !== 30 || loc.trk[j] !== loc.trk[j - 1]; });
    ok('no track continues across the cut', spans, loc.trk);
    var off = 0, owned = 0;
    for (var i = 0; i < n; i++) {
      if (!loc.rois[i]) continue; owned++;
      var c = roiCentre(loc.rois[i]), r = scene(i).people[0];
      off = Math.max(off, Math.hypot(c[0] - r.x, c[1] - r.y) / loc.rois[i][2]);
    }
    eq('every frame of both shots has an ROI', owned, n);
    ok('every ROI is on the runner, never the bystander (end lag included)', off < 0.16, off);
    eq('two tracks kept, one per shot; the bystander is not followed', loc.tracks.filter(function (t) { return t.kept; }).map(function (t) { return [t.from < 30, t.to >= 30]; }), [[false, true], [true, false]]);
    ok('dup frames reuse the ROI of the frame they repeat', loc.rois.every(function (r, j) { return !loc.dup[j] || r === loc.rois[j - 1]; }));
    eq('kept tracks numbered 0 and 1', Array.from(new Set(loc.trk.filter(function (v) { return v != null; }))).sort(), [0, 1]);

    // the pose pass poses unique frames only and copies the pose onto repeats
    var posed = [];
    var pp = await C.posePass(loc.rois, loc.dup, function (i, roi) { posed.push(i); return fakePose(scene(i).people, W, H)(roi); });
    eq('model run once per unique frame', pp.inferred, 30);
    ok('repeats share their pose object', pp.kps.every(function (k, j) { return !loc.dup[j] || k === pp.kps[j - 1]; }));
    var hip = hipOf(pp.kps[45]);
    ok('posed hips on the runner', Math.abs(hip[0] - scene(45).people[0].x) < 1e-6);
  });

  await section('§13 single frame without a track', async function () {
    var W = 1280, H = 720, people = [{ x: 1000, y: 470, h: 160, score: 0.7 }];
    var calls = 0, f = fakePose(people, W, H);
    var loc = await C.localiseOne(W, H, function (roi) { calls++; return f(roi); }, {});
    ok('runner found', !!loc);
    var c = roiCentre(loc.roi);
    ok('ROI on the runner', Math.hypot(c[0] - 1000, c[1] - 470) < 0.05 * loc.roi[2], loc);
    ok('bounded work: under 60 model calls', calls < 60, calls);
    var none = await C.localiseOne(W, H, fakePose([], W, H), {});
    eq('empty frame -> null', none, null);
  });

  await section('§14 background median: fast path gives the same answer as median()', function () {
    var greys = [], seed = 7;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
    for (var j = 0; j < 31; j++) { var g = new Uint8Array(500); for (var p = 0; p < 500; p++) g[p] = rnd() % 256; greys.push(g); }
    var bg = C.bgMedian(greys), wrong = 0;
    for (p = 0; p < 500; p++) if (bg[p] !== C.median(greys.map(function (g) { return g[p]; }))) wrong++;
    eq('31 frames: every pixel equals median()', wrong, 0);
    var even = greys.slice(0, 4), bg4 = C.bgMedian(even); wrong = 0;
    for (p = 0; p < 500; p++) if (bg4[p] !== C.median(even.map(function (g) { return g[p]; }))) wrong++;
    eq('even count (lower median): same as median()', wrong, 0);
  });

  await section('§15 a larger person standing still does not take the clip from the runner', async function () {
    // runner 260 px tall, legs swinging, crossing a static camera; a 420 px tall person stands at the right
    var W = 1280, H = 720, n = 60;
    function scene(swing) {
      return function (i) {
        return { people: [{ x: 100 + i * 12, y: 450, h: 260, score: 0.8, swing: swing, ph: i * 0.7 }, { x: 1090, y: 430, h: 420, score: 0.8 }] };
      };
    }
    var loc = await C.localise(makeClip(W, H, n, 30, scene(0.25)).ctx);
    var onRunner = 0, withRoi = 0;
    for (var i = 0; i < n; i++) if (loc.rois[i]) { withRoi++; if (Math.abs(roiCentre(loc.rois[i])[0] - (100 + i * 12)) < 40) onRunner++; }
    ok('the runner has an ROI on most frames', withRoi >= 50, withRoi);
    eq('...and every ROI is on the runner', onRunner, withRoi);
    eq('track 0 is the runner on every frame with an ROI', loc.trk.filter(function (v, j) { return loc.rois[j] && v !== 0; }).length, 0);
    var standing = loc.tracks.filter(function (t) { return t.still; });
    ok('the standing person was followed, marked still and dropped', standing.length >= 1 && standing.every(function (t) { return !t.kept && t.id === null; }), loc.tracks);
    eq('no rival: the clip is not ambiguous', loc.rivals.length, 0);
    // without leg movement both count as still and size wins (the lab rule)
    var loc0 = await C.localise(makeClip(W, H, n, 30, scene(0)).ctx);
    ok('(no leg movement anywhere: the larger person is track 0, as in the lab)', loc0.rois[30] && Math.abs(roiCentre(loc0.rois[30])[0] - 1090) < 40, loc0.rois[30]);
  });

  await section('§16 frames that cannot be decoded', async function () {
    var W = 640, H = 360, n = 40, K = 4, gw = W / K, gh = H / K;
    var scene = function (i) { return { people: [{ x: 60 + i * 12, y: 220, h: 110, score: 0.8 }] }; };
    var bad = []; for (var i = 0; i < n; i++) bad.push(i === 10 || i === 11 || i === 25 ? 1 : 0);
    var diff = [], dmax = [], prev = null;
    for (i = 0; i < n; i++) {
      if (bad[i]) { diff.push(null); dmax.push(null); continue; }
      var g = thumb(W, H, K, scene(i).people);
      if (prev) { var fd = C.frameDiff(g, prev, gw, gh, 8); diff.push(fd.diff); dmax.push(fd.dmax); } else { diff.push(null); dmax.push(null); }
      prev = g;
    }
    var loc = await C.localise({
      n: n, W: W, H: H, span: (n - 1) / 30, dmax: dmax, diff: diff, bad: bad, gw: gw, gh: gh, K: K,
      grey: function (j) { if (bad[j]) throw new Error('grey of a bad frame'); return thumb(W, H, K, scene(j).people); },
      pose: function (j, roi) { if (bad[j]) throw new Error('pose of a bad frame'); return fakePose(scene(j).people, W, H)(roi); }
    });
    eq('bad frames are neither duplicates nor cuts', [loc.dup[10], loc.dup[11], loc.dup[25], loc.cut[12], loc.cut[26]], [0, 0, 0, 0, 0]);
    eq('bad frames have no ROI', [loc.rois[10], loc.rois[11], loc.rois[25]], [null, null, null]);
    var miss = []; for (i = 0; i < n; i++) if (!bad[i] && 60 + i * 12 < W - 30 && !loc.rois[i]) miss.push(i);
    eq('every good frame with the runner in shot has an ROI', miss, []);
    eq('no frame is called a duplicate', loc.dup.filter(Boolean).length, 0);

    // a repeat right after a bad frame repeats the last good frame
    var A = [10, 20, 100];
    var sm = C.smoothRois([], [], [], [], 30, 3, [0, 0, 1], [0, 1, 0]);
    eq('(no owner: nothing to copy)', sm.rois, [null, null, null]);
    var calls = 0;
    var pp = await C.posePass([A, null, A], [0, 0, 1], function () { calls++; return [[1, 2, 0.9]]; }, null, [0, 1, 0]);
    eq('pose pass: the repeat after a bad frame reuses the last good pose', [calls, pp.kps[2] === pp.kps[0], pp.kps[1]], [1, true, null]);
    var owner = [{ cx: 50, cy: 50, s: 80, cs: 0.8, hit: 1 }];
    var sm2 = C.smoothRois(owner, [0], [0], [0], 30, 3, [0, 0, 1], [0, 1, 0]);
    ok('smoothing: the repeat after a bad frame takes the last good ROI', sm2.rois[2] === sm2.rois[0] && sm2.rois[1] === null && sm2.src[2] === 'd', sm2);
  });

  await section('§17 clips with only a few frames still find the runner', async function () {
    var W = 640, H = 360;
    var scene = function (i) { return { people: [{ x: 300 + i * 10, y: 200, h: 140, score: 0.8 }] }; };
    for (var nn = 1; nn <= 3; nn++) {
      var loc = await C.localise(makeClip(W, H, nn, 30, scene).ctx);
      eq(nn + '-frame clip: every frame has an ROI', loc.rois.filter(Boolean).length, nn);
    }
  });

  await section('§18 borrowing a neighbour ROI never crosses a cut', function () {
    function fr(t, roi, trk, cut) { return { t: t, roi: roi, trk: trk, cut: !!cut }; }
    var R0 = [0, 0, 100], R1 = [50, 0, 100];
    var frames = [fr(0, R0, 0), fr(0.1, null, null), fr(0.2, null, null, true), fr(0.3, R1, 1), fr(0.4, null, null), fr(0.9, R0, 0)];
    eq('nearest frame on the same side of the cut', C.borrowRoi(frames, 1, 0.2).j, 0);
    eq('after the cut: the frame after it, not the one before', C.borrowRoi(frames, 2, 0.2).j, 3);
    eq('nothing within the gap', C.borrowRoi(frames, 4, 0.2).j, 3);
    eq('gap too short -> null', C.borrowRoi(frames, 4, 0.05), null);
    var tie = [fr(0, R1, 1), fr(0.1, null, null), fr(0.2, R0, 0)];
    eq('equal distance: the runner (track 0) wins', C.borrowRoi(tie, 1, 0.2).trk, 0);
    var cutAt = [fr(0, R0, 0), fr(0.1, null, null, true)];
    eq('a cut just before the frame blocks the frame before it', C.borrowRoi(cutAt, 1, 0.2), null);
  });

  await section('§19 single-frame search: upside-down poses are never an answer', async function () {
    var W = 1280, H = 720;
    var flipped = await C.localiseOne(W, H, fakePose([{ x: 600, y: 360, h: 200, score: 0.5, flip: true }], W, H), {});
    eq('only an upside-down person -> null', flipped, null);
    var upright = await C.localiseOne(W, H, fakePose([{ x: 600, y: 360, h: 200, score: 0.35 }], W, H), {});
    ok('a weak (core 0.35) upright person is still found', !!upright, upright);
  });

  await section('§20 progress keeps moving, also while searching hard for a small runner', async function () {
    // moving camera (texture shifts every frame), small runner: phase A finds nothing, phase B does
    var W = 1280, H = 720, n = 48;
    var scene = function (i) { return { people: [{ x: 200 + i * 15, y: 400, h: 100, score: 0.8 }], bgShift: i * 3 }; };
    var clip = makeClip(W, H, n, 30, scene), prog = [];
    clip.ctx.progress = function (f, text) { prog.push([f, text]); };
    var loc = await C.localise(clip.ctx);
    ok('moving camera', loc.cam === 'moving', loc.cam);
    ok('runner found by the half-size tiles', loc.tracks.some(function (t) { return t.kept && /tile2/.test(t.seedSrc); }), loc.tracks);
    ok('progress never goes back', prog.every(function (p, j) { return !j || p[0] >= prog[j - 1][0]; }));
    ok('progress inside 0..1 and ends at 1', prog.every(function (p) { return p[0] >= 0 && p[0] <= 1; }) && prog[prog.length - 1][0] === 1);
    ok('several updates during the half-size search (0.2 - 0.3)', prog.filter(function (p) { return p[0] > 0.2 && p[0] < 0.3; }).length >= 5, prog.length);
    ok('updates while following the runner', prog.filter(function (p) { return p[1] === 'following the runner'; }).length >= 20);
  });

  await section('§21 public parameters are a read-only copy', function () {
    ok('PARAMS frozen', Object.isFrozen(Pose.PARAMS));
    ok('PARAMS is not the live object', Pose.PARAMS !== C.P && Pose.PARAMS.trackOk === C.P.trackOk);
    eq('model kinds', Pose.MODEL_KINDS, ['thunder', 'lightning', 'blaze']);
    eq('coco17 of a BlazePose answer picks the 17 MoveNet points', C.coco17(Array.from({ length: 33 }, function (_, j) { return [j, 0, 1]; })).map(function (p) { return p[0]; }), [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);
  });

  await section('§22 trackClip / poseAt reject an unknown model before doing any work', async function () {
    var store = { ok: true, times: [0], frameCount: function () { return 1; } }, msg1 = null, msg2 = null;
    try { await Pose.trackClip(store, { model: 'thundr' }); } catch (e) { msg1 = e.message; }
    try { await Pose.poseAt(store, 0, { model: 'thundr' }); } catch (e) { msg2 = e.message; }
    eq('trackClip', msg1, 'EslPoseV2: unknown model thundr');
    eq('poseAt', msg2, 'EslPoseV2: unknown model thundr');
  });

  await section('§23 model loading: weights kept, the page copy reused, failed or hung downloads retried', async function () {
    var loads = [], kept = [], mode = {};
    function fakeModel(tag) {
      return { tag: tag, executed: 0, weights: { a: [{ id: tag + '.a' }], b: [{ id: tag + '.b' }, { id: tag + '.c' }] },
        execute: function () { this.executed++; return {}; }, dispose: function () {} };
    }
    global.tf = {
      loadGraphModel: function (url) {
        var kind = /lightning/.test(url) ? 'lightning' : /thunder/.test(url) ? 'thunder' : 'blaze';
        loads.push(kind);
        if (mode[kind] === 'hang') return new Promise(function () {});
        if (mode[kind] === 'fail') return Promise.reject(new Error('Failed to fetch'));
        return Promise.resolve(fakeModel(kind + loads.length));
      },
      keep: function (t) { kept.push(t.id); t.kept = true; return t; },
      tidy: function (f) { return f(); },
      zeros: function () { return {}; }
    };
    try {
      var m = await Pose.getModel('thunder');
      eq('one download', loads, ['thunder']);
      eq('every weight tensor kept, so an outer tf scope cannot dispose it', kept.sort(), ['thunder1.a', 'thunder1.b', 'thunder1.c']);
      ok('warmed up once, not marked shared', m.model.executed === 1 && !m.shared);
      ok('cached: no second download', (await Pose.getModel('thunder')) === m && loads.length === 1);

      // the page's Lightning detector is still loading: wait for it rather than download the same weights
      var resolvePage, pageModel = fakeModel('page');
      global.scanDetector = null;
      global.scanDetectorPromise = new Promise(function (r) { resolvePage = r; });
      var pl = Pose.getModel('lightning');
      setTimeout(function () { global.scanDetector = { moveNetModel: pageModel }; resolvePage(global.scanDetector); }, 20);
      var lm = await pl;
      ok("the page's copy is used and nothing is downloaded", lm.model === pageModel && lm.shared && loads.length === 1);

      // a failed download is forgotten
      mode.blaze = 'fail';
      var err = null;
      try { await Pose.waitModel('blaze', null, 1000); } catch (e) { err = e; }
      ok('a failed download rejects with eslModelError', !!(err && err.eslModelError && /could not load/.test(err.message)), err && err.message);
      // a download that hangs: cancel gets through within a poll
      mode.blaze = 'hang';
      var t0 = Date.now(), stopAt = t0 + 50;
      err = null;
      try { await Pose.waitModel('blaze', function () { if (Date.now() > stopAt) throw new Error('cancelled by user'); }, 10000); } catch (e) { err = e; }
      eq('cancel rejects with the caller\'s error', err && err.message, 'cancelled by user');
      ok('...within one 200 ms poll', Date.now() - t0 < 600, Date.now() - t0);
      eq('the failed download was retried', loads.filter(function (k) { return k === 'blaze'; }).length, 2);
      // ...and a timeout gives up on it
      t0 = Date.now(); err = null;
      try { await Pose.waitModel('blaze', null, 60); } catch (e) { err = e; }
      ok('a hung download times out with eslModelError', !!(err && err.eslModelError && /did not load within/.test(err.message)), err && err.message);
      ok('...on time', Date.now() - t0 < 600, Date.now() - t0);
      mode.blaze = null;
      var bm = await Pose.waitModel('blaze', null, 1000);
      ok('after a timeout the next call downloads afresh and works', bm.kind === 'blaze' && bm.size === 256 && loads.filter(function (k) { return k === 'blaze'; }).length === 3);
    } finally {
      delete global.tf; delete global.scanDetector; delete global.scanDetectorPromise;
    }
  });

  console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
  process.exit(failures ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
