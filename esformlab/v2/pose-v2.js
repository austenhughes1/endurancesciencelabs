// ==============================================================
//  esFormLab v2 -- runner localiser and stateless pose (EslPoseV2)
// ==============================================================
//
// Replaces the page's pose input for detection. Today every frame is drawn
// at most 400 px wide and passed to a long-lived pose-detection MoveNet
// detector that crops each call around the previous call's pose (often a
// different clip) and is never reset. Here, instead:
//
//   1. A cheap pre-pass makes a 1/4-scale grey thumbnail of every stored
//      frame and measures frame-to-frame change: duplicate frames (screen
//      recordings, slow-motion exports) and scene cuts.
//   2. A localiser finds the runner: seeds on spread probe frames (motion
//      blobs on a static camera, whole frame, a grid of squares), then
//      tracks forwards and backwards with a predicted square region of
//      interest (ROI) that follows motion and growth toward the camera.
//      Tracks are ranked; bystanders drop out. ROIs are smoothed.
//   3. Every frame is posed on its own ROI: the square is cut from the
//      full stored frame and resized to the model's input. Each call is
//      independent of every other call.
//
// Model calls go straight to the MoveNet TF.js graph model (the same
// weights pose-detection loads; the page's detector's own copy is reused
// when present). pose-detection's MoveNet detector is not used for these
// calls because it is stateful (crop carried between calls), crops and
// resizes the input itself and drops poses under its own score floor.
//
// Coordinates everywhere are stored-frame pixels (store.videoWidth x
// store.videoHeight), keypoints are {x, y, score, name} like pose-detection
// returns, so computeMetrics, drawPose and the rest work unchanged.
//
// The pure maths is in plain functions on arrays (EslPoseV2._core) and is
// tested in node by pose-v2.test.js. The algorithm and its parameters are
// a port of the offline lab localiser; differences are listed in the
// lab's PORT.md.
var EslPoseV2 = (function () {
  'use strict';

  // ── parameters (same values as the lab localiser) ──────────────────────
  var P = {
    dupRatio: 0.2,        // frame is a duplicate if its block diff is < dupRatio x the local (+-6 frames) 85th percentile
    dupClipFrac: 0.02,    // ...and at least this fraction of the clip looks like that (screen recordings)
    dupAbs: 0.3,          // ...or the block diff is below this absolute level (grey levels)
    probes: 16,           // probe frames used to find seeds
    bgSamples: 31,        // frames in the background median
    fgThr: 16,            // grey levels: |frame - background| above this is foreground
    staticFrac: 0.10,     // camera counts as static if the median foreground fraction is below this
    seedMin: 0.2,         // tile/blob pose must reach this core score to be refined
    seedOk: 0.40,         // refined seed core score to keep a seed
    trackOk: 0.22,        // core score to accept a tracked pose
    torsoK: 1.95, bodyK: 1.25, // ROI half-size = max(torsoK x torso range, bodyK x body range) from the hip centre
    minRoi: 48,           // px: below this the runner is too small to follow
    maxMissSec: 0.35,     // give up a track after this long without an accepted pose
    minTrackSec: 0.25,    // a track needs this many seconds of accepted poses
    trackMeanCs: 0.40,    // ...and this mean core score
    keepFrac: 0.25,       // secondary tracks must reach this fraction of the main track's quality
    seedPrioFrac: 0.12,   // seeds much weaker/smaller than the best seed are not followed
    maxTracks: 6,         // at least; montages get (cuts + 3)
    cutAbs: 15, cutRatio: 2.0, // scene cut: mean frame diff > cutAbs and > cutRatio x local median
    thumbK: 4,            // thumbnail = box average over K x K pixels
    block: 8,             // block size (thumbnail px) for the local difference statistic
    // ── browser-only additions (not in the lab localiser) ──
    stillLeg: 0.04,       // a track whose ankle-to-ankle offset (ROI sizes) varies less than this (p90 - p10) is a person
                          // standing still, not the runner (real runner tracks: 0.11 and up); it ranks after moving tracks
    rivalFrac: 0.5,       // a moving track dropped for overlapping the runner's frames, with at least this fraction of the
                          // runner's quality, makes the clip ambiguous (diag.rivals)
    minPoseScore: 0.25,   // poseAt answers null below this pose score, like pose-detection's estimatePoses
    modelTimeoutMs: 90000 // a model download that takes longer than this is abandoned (the next call retries)
  };

  var NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee',
    'right_knee', 'left_ankle', 'right_ankle'];
  var BLAZE_NAMES = ['nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye',
    'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index',
    'right_index', 'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee',
    'left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'];
  // BlazePose index of each of the 17 MoveNet (COCO) keypoints
  var BLAZE_TO_COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  var CORE = [5, 6, 11, 12, 13, 14, 15, 16];

  var MODELS = {
    thunder: { size: 256, url: 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/thunder/4' },
    lightning: { size: 192, url: 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4' },
    blaze: { size: 256, url: 'https://tfhub.dev/mediapipe/tfjs-model/blazepose_3d/landmark/full/2' }
  };
  var TRACK_MODEL = 'lightning';

  // ═══════════════════════════ pure core ════════════════════════════════
  // Keypoints inside the core are arrays [x, y, score] in frame pixels.

  function sortNum(a) { return Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); }
  function median(a) { var s = sortNum(a); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; }
  function pct(a, p) { var s = sortNum(a); return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))]; }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function round(v, d) { var m = Math.pow(10, d); return Math.round(v * m) / m; }

  // Mean absolute difference of two grey thumbnails and the largest
  // block x block mean absolute difference (both rounded to 3 decimals, as the lab stores them).
  function frameDiff(cur, prev, gw, gh, B) {
    B = B || P.block;
    var s = 0, mx = 0;
    var bw = Math.floor(gw / B), bh = Math.floor(gh / B);
    var blk = new Float64Array(Math.max(1, bw * bh));
    for (var y = 0; y < gh; y++) {
      var by = Math.floor(y / B), row = y * gw;
      for (var x = 0; x < gw; x++) {
        var a = Math.abs(cur[row + x] - prev[row + x]); s += a;
        var bx = Math.floor(x / B);
        if (by < bh && bx < bw) blk[by * bw + bx] += a;
      }
    }
    for (var j = 0; j < bw * bh; j++) if (blk[j] > mx) mx = blk[j];
    return { diff: round(s / (gw * gh), 3), dmax: round(mx / (B * B), 3) };
  }

  // dmax[0] is null (no previous frame). -> dup[] of 0/1.
  function dupFlags(dmax) {
    var n = dmax.length, W = 6, r = [], i;
    for (i = 0; i < n; i++) r.push(1);
    for (i = 1; i < n; i++) {
      var w = dmax.slice(Math.max(1, i - W), Math.min(n, i + W + 1));
      r[i] = dmax[i] / Math.max(pct(w, 0.85), 1e-6);
    }
    var low = 0; for (i = 0; i < n; i++) if (r[i] < P.dupRatio) low++;
    var frac = n ? low / n : 0;
    var dup = []; for (i = 0; i < n; i++) dup.push(0);
    for (i = 1; i < n; i++) if (dmax[i] < P.dupAbs || (frac >= P.dupClipFrac && r[i] < P.dupRatio)) dup[i] = 1;
    return dup;
  }

  // Scene cuts (montage reels, camera bumps): global diff far above its neighbourhood.
  function cutFlags(diff) {
    var n = diff.length, cut = [], i;
    for (i = 0; i < n; i++) cut.push(0);
    for (i = 1; i < n; i++) {
      var w = diff.slice(Math.max(1, i - 12), i + 13).filter(function (v) { return v > 1; });
      if (diff[i] > P.cutAbs && diff[i] > P.cutRatio * (median(w) || 1)) cut[i] = 1;
    }
    return cut;
  }

  // Per-pixel median of a list of equally sized thumbnails (lower median, as median()).
  // Sorts a reused Uint8Array in place: same answer as median(), ~5x faster, so the
  // background of 31 thumbnails does not hold the main thread for half a second.
  function bgMedian(greys) {
    var ns = greys.length, len = greys[0].length, mid = (ns - 1) >> 1;
    var bg = new Uint8Array(len), tmp = new Uint8Array(ns);
    for (var p = 0; p < len; p++) {
      for (var j = 0; j < ns; j++) tmp[j] = greys[j][p];
      tmp.sort();
      bg[p] = tmp[mid];
    }
    return bg;
  }
  function fgFraction(g, bg, thr) {
    thr = thr == null ? P.fgThr : thr;
    var c = 0; for (var p = 0; p < g.length; p++) if (Math.abs(g[p] - bg[p]) > thr) c++;
    return c / g.length;
  }

  // Foreground blobs of one thumbnail -> [{x0,y0,x1,y1,area}] in frame px, largest first.
  function blobs(g, bg, gw, gh, K) {
    var m = new Uint8Array(gw * gh), p, x, y;
    for (p = 0; p < g.length; p++) if (Math.abs(g[p] - bg[p]) > P.fgThr) m[p] = 1;
    var d = new Uint8Array(gw * gh);   // 3x3 dilation
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      var v = 0;
      for (var dy = -1; dy <= 1 && !v; dy++) for (var dx = -1; dx <= 1; dx++) {
        var yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < gh && xx >= 0 && xx < gw && m[yy * gw + xx]) { v = 1; break; }
      }
      d[y * gw + x] = v;
    }
    var res = [], st = [];
    for (var p0 = 0; p0 < d.length; p0++) if (d[p0] === 1) {
      var bx0 = gw, by0 = gh, bx1 = 0, by1 = 0, area = 0; st.push(p0); d[p0] = 2;
      while (st.length) {
        p = st.pop(); y = Math.floor(p / gw); x = p - y * gw; area++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (x > 0 && d[p - 1] === 1) { d[p - 1] = 2; st.push(p - 1); }
        if (x < gw - 1 && d[p + 1] === 1) { d[p + 1] = 2; st.push(p + 1); }
        if (y > 0 && d[p - gw] === 1) { d[p - gw] = 2; st.push(p - gw); }
        if (y < gh - 1 && d[p + gw] === 1) { d[p + gw] = 2; st.push(p + gw); }
      }
      if (area >= 20) res.push({ x0: bx0 * K, y0: by0 * K, x1: (bx1 + 1) * K, y1: (by1 + 1) * K, area: area });
    }
    return res.sort(function (a, b) { return b.area - a.area; });
  }

  // Mean grey of a frame-px square (every 2nd thumbnail px), to skip black pillarbox tiles.
  function greyMean(g, gw, gh, K, x0, y0, s) {
    var sum = 0, c = 0;
    for (var y = Math.max(0, Math.floor(y0 / K)); y < Math.min(gh, Math.ceil((y0 + s) / K)); y += 2)
      for (var x = Math.max(0, Math.floor(x0 / K)); x < Math.min(gw, Math.ceil((x0 + s) / K)); x += 2) { sum += g[y * gw + x]; c++; }
    return c ? sum / c : 0;
  }

  // Seed proposals: level 0 = whole frame as one square, 1 = half-overlapping grid of
  // short-side squares, 2 = the same with half-short-side squares (tiny runners).
  function tiles(level, W, H) {
    var res = [], S = Math.max(W, H), s1 = Math.min(W, H);
    function grid(s) {
      var nx = Math.max(1, Math.ceil((W - s) / (s / 2)) + 1), ny = Math.max(1, Math.ceil((H - s) / (s / 2)) + 1);
      for (var iy = 0; iy < ny; iy++) for (var ix = 0; ix < nx; ix++)
        res.push({ cx: (nx === 1 ? W / 2 : s / 2 + ix * (W - s) / (nx - 1)), cy: (ny === 1 ? H / 2 : s / 2 + iy * (H - s) / (ny - 1)), s: s });
    }
    if (level === 0) res.push({ cx: W / 2, cy: H / 2, s: S });
    if (level === 1) grid(s1);
    if (level === 2) grid(s1 / 2);
    return res;
  }

  function coreScore(k) { var s = 0; for (var j = 0; j < CORE.length; j++) s += k[CORE[j]][2]; return s / CORE.length; }

  // Square ROI {cx, cy, s} from a pose (the MoveNet library's crop-tracker construction, more generous).
  function roiFromPose(k, thr) {
    thr = thr == null ? 0.2 : thr;
    function ok(j) { return k[j][2] > thr; }
    if (!((ok(11) || ok(12)) && (ok(5) || ok(6)))) return null;
    var cx = (k[11][0] + k[12][0]) / 2, cy = (k[11][1] + k[12][1]) / 2;
    var tr = 0, br = 0, j;
    var T4 = [5, 6, 11, 12];
    for (j = 0; j < 4; j++) tr = Math.max(tr, Math.abs(k[T4[j]][0] - cx), Math.abs(k[T4[j]][1] - cy));
    for (j = 0; j < 17; j++) if (ok(j)) br = Math.max(br, Math.abs(k[j][0] - cx), Math.abs(k[j][1] - cy));
    var half = Math.max(tr * P.torsoK, br * P.bodyK);
    if (!(half > 0)) return null;
    return { cx: cx, cy: cy, s: 2 * half };
  }
  function sq(r) { return [r.cx - r.s / 2, r.cy - r.s / 2, r.s]; }
  // upright and non-degenerate: shoulders above hips, torso has some length
  function plausible(k, s) {
    var shy = (k[5][1] + k[6][1]) / 2, hipy = (k[11][1] + k[12][1]) / 2;
    var torso = hipy - shy;
    return torso > 0.08 * s && torso < 0.6 * s;
  }

  // MoveNet output [y, x, score] x 17, normalised to the crop -> frame px [x, y, score].
  function mapMoveNet(d, roi) {
    var k = [];
    for (var j = 0; j < 17; j++) k.push([roi[0] + d[j * 3 + 1] * roi[2], roi[1] + d[j * 3] * roi[2], d[j * 3 + 2]]);
    return k;
  }

  // Where to draw a square ROI [x0, y0, size] of a W x H frame so that it fills a T x T canvas
  // (parts outside the frame stay black). Source rect clipped to the frame, destination scaled
  // to match; null when the ROI misses the frame. Done by hand because browsers disagree on
  // out-of-bounds source rectangles.
  function cropRects(roi, W, H, T) {
    var x0 = roi[0], y0 = roi[1], s = roi[2];
    var sx0 = Math.max(0, x0), sy0 = Math.max(0, y0), sx1 = Math.min(W, x0 + s), sy1 = Math.min(H, y0 + s);
    if (!(sx1 > sx0 && sy1 > sy0)) return null;
    var f = T / s;
    return { sx: sx0, sy: sy0, sw: sx1 - sx0, sh: sy1 - sy0, dx: (sx0 - x0) * f, dy: (sy0 - y0) * f, dw: (sx1 - sx0) * f, dh: (sy1 - sy0) * f };
  }

  // BlazePose landmark decoding (as the library and the lab do): ld (39 x 5, input px),
  // heatmap 64 x 64 x 39, flag. -> 33 x [x, y, score] in frame px, or null if no pose.
  function decodeBlaze(ld, flag, hm, roi, size) {
    size = size || 256;
    if (!(flag >= 0.5)) return null;
    var res = [];
    for (var j = 0; j < 33; j++) {
      var x = ld[j * 5] / size, y = ld[j * 5 + 1] / size, s = 1 / (1 + Math.exp(-ld[j * 5 + 3]));
      var cc = Math.trunc(x * 64), cr = Math.trunc(y * 64);
      if (hm && cc >= 0 && cc < 64 && cr >= 0 && cr < 64) {
        var sum = 0, wc = 0, wr = 0, mx = 0;
        for (var r = Math.max(0, cr - 3); r < Math.min(64, cr + 4); r++) for (var c = Math.max(0, cc - 3); c < Math.min(64, cc + 4); c++) {
          var v = hm[(r * 64 + c) * 39 + j]; sum += v; if (v > mx) mx = v; wc += c * v; wr += r * v;
        }
        if (mx >= 0.5 && sum > 0) { x = wc / 64 / sum; y = wr / 64 / sum; }
      }
      res.push([roi[0] + x * roi[2], roi[1] + y * roi[2], s]);
    }
    return res;
  }

  // Probe frames (indices into the unique-frame list): `probes` spread frames plus one
  // 3 frames after every cut.
  function probeList(U, ucut, probes) {
    var set = {}, out = [], j, ui;
    var np = Math.min(probes == null ? P.probes : probes, U);
    for (j = 0; j < np; j++) set[Math.floor((j + 0.5) * U / np)] = 1;
    for (ui = 1; ui < U; ui++) if (ucut[ui] && ui + 3 < U) set[ui + 3] = 1;
    for (var k in set) out.push(+k);
    return out.sort(function (a, b) { return a - b; });
  }

  // Tracker update after an accepted measurement m (pose-derived ROI) against the
  // prediction pr. r was already advanced by the prediction on missed frames, so this is a
  // one-step change. -> {r, v}
  function trackAccept(r, v, pr, m, grow) {
    var nv = { x: m.cx - r.cx, y: m.cy - r.cy, ls: Math.log(m.s / r.s) };
    return {
      v: { x: 0.5 * v.x + 0.5 * nv.x, y: 0.5 * v.y + 0.2 * nv.y, ls: 0.7 * v.ls + 0.3 * Math.max(-0.05, Math.min(0.05, nv.ls)) },
      r: { cx: m.cx, cy: m.cy, s: 0.6 * pr.s / grow + 0.4 * m.s }
    };
  }
  function trackMiss(v, pr, grow) {
    return { r: { cx: pr.cx, cy: pr.cy, s: pr.s / grow }, v: { x: v.x * 0.85, y: v.y * 0.5, ls: v.ls * 0.5 } };
  }
  function trackPredict(r, v, miss) {
    var grow = 1 + 0.08 * Math.min(miss, 4);
    return { grow: grow, pr: { cx: r.cx + v.x, cy: r.cy + v.y, s: r.s * Math.exp(v.ls) * grow } };
  }
  function consistentRoi(m, pr) {
    return !!m && Math.hypot(m.cx - pr.cx, m.cy - pr.cy) < 0.35 * pr.s && m.s > 0.55 * pr.s && m.s < 1.7 * pr.s;
  }
  function outOfFrame(pr, W, H) {
    return pr.cx < -0.2 * pr.s || pr.cx > W + 0.2 * pr.s || pr.cy < -0.2 * pr.s || pr.cy > H + 0.2 * pr.s;
  }

  // How much the two ankles move relative to each other along a track: max over x and y of
  // the p90 - p10 spread of (left ankle - right ankle) / ROI size, over the accepted frames.
  // A runner's feet pass each other (side) or lift in turn (front, back); a person standing
  // still keeps them put. pts: [[ax, ay], ...] -> number (0 when fewer than 4 points).
  function legMotion(pts) {
    if (!pts || pts.length < 4) return 0;
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    return Math.max(pct(xs, 0.9) - pct(xs, 0.1), pct(ys, 0.9) - pct(ys, 0.1));
  }

  // Track selection. cand: [{st: Map(ui -> {cx,cy,s,cs,hit}), keys, info}], U, minHits.
  // The best track is the runner; weaker tracks keep only the frames the better ones do not
  // cover, and only if substantial. Tracks of a person standing still (info.still) rank after
  // every moving track and are dropped once a moving track is kept (lab: quality alone).
  // Kept tracks are numbered 0, 1, ... in rank order (0 = the runner); dropped ones get id
  // null (lab: every candidate counted). A moving track dropped only because the runner
  // already owns its frames, with >= rivalFrac of the runner's quality, is a rival.
  // -> {owner[], ownerId[], tracks[], rivals[]} (cand sorted in place).
  function selectTracks(cand, U, minHits) {
    cand.sort(function (a, b) { return ((a.info.still ? 1 : 0) - (b.info.still ? 1 : 0)) || (b.info.quality - a.info.quality); });
    var owner = [], ownerId = [], tracks = [], rivals = [], bestQ = 0, nKept = 0, movingKept = false, u;
    for (u = 0; u < U; u++) { owner.push(null); ownerId.push(-1); }
    cand.forEach(function (c, rank) {
      var free = c.keys.filter(function (x) { return !owner[x]; });
      var freeHits = free.filter(function (x) { return c.st.get(x).hit; }).length;
      var solid = c.info.meanCs >= P.trackMeanCs && c.info.hits >= minHits && c.info.quality >= P.keepFrac * bestQ;
      var ok = solid && freeHits >= minHits && !(c.info.still && movingKept);
      c.info.kept = ok; c.info.rank = rank; c.info.id = ok ? nKept++ : null; c.info.framesOwned = ok ? free.length : 0;
      if (ok) {
        if (!bestQ) bestQ = c.info.quality;
        if (!c.info.still) movingKept = true;
        free.forEach(function (x) { owner[x] = c.st.get(x); ownerId[x] = c.info.id; });
      } else if (solid && !c.info.still && freeHits < minHits && c.info.quality >= P.rivalFrac * bestQ) {
        rivals.push({ rank: rank, quality: c.info.quality, ratio: round(c.info.quality / bestQ, 3), from: c.info.from, to: c.info.to, overlap: c.keys.length - free.length });
      }
      tracks.push(c.info);
    });
    return { owner: owner, ownerId: ownerId, tracks: tracks, rivals: rivals };
  }

  // Smooth ROIs per contiguous run of one track: misses interpolated, centre = median then
  // mean (0.05 s half-window), size = median (0.07 s), rolling 75th percentile (0.2 s), mean.
  // -> {rois[n], src[n], trk[n]} (frame indexed; dup frames reuse the previous ROI; frames
  // flagged in bad[] (not decodable) have none and are skipped when looking back).
  function smoothRois(owner, ownerId, ucut, uniq, ufps, n, dup, bad) {
    var U = uniq.length, rois = [], src = [], trk = [], i;
    for (i = 0; i < n; i++) { rois.push(null); src.push(null); trk.push(null); }
    var a = 0;
    while (a < U) {
      if (!owner[a]) { a++; continue; }
      var b = a; while (b + 1 < U && owner[b + 1] && ownerId[b + 1] === ownerId[a] && !ucut[b + 1]) b++;
      var seg = owner.slice(a, b + 1), m = seg.length;
      var hitIdx = []; seg.forEach(function (s, j) { if (s.hit) hitIdx.push(j); });
      var val = function (key) {
        var o = new Array(m), h, j;
        if (!hitIdx.length) { for (j = 0; j < m; j++) o[j] = seg[j][key]; return o; }   // (lab: undefined; never seen)
        for (h = 0; h < hitIdx.length; h++) {
          var j0 = hitIdx[h], j1 = hitIdx[Math.min(h + 1, hitIdx.length - 1)];
          o[j0] = seg[j0][key];
          for (j = j0 + 1; j < j1; j++) o[j] = seg[j0][key] + (seg[j1][key] - seg[j0][key]) * (j - j0) / (j1 - j0);
        }
        for (j = 0; j < hitIdx[0]; j++) o[j] = seg[hitIdx[0]][key];
        for (j = hitIdx[hitIdx.length - 1] + 1; j < m; j++) o[j] = seg[hitIdx[hitIdx.length - 1]][key];
        return o;
      };
      var win = function (arr, j, hw) { return arr.slice(Math.max(0, j - hw), Math.min(m, j + hw + 1)); };
      var smooth = function (arr, hw) {
        var md = arr.map(function (_, j) { return median(win(arr, j, hw)); });
        return md.map(function (_, j) { return mean(win(md, j, hw)); });
      };
      var hwC = Math.max(1, Math.round(0.05 * ufps)), hwS = Math.max(2, Math.round(0.2 * ufps));
      var cx = smooth(val('cx'), hwC), cy = smooth(val('cy'), hwC);
      var s0 = val('s'), hwM = Math.max(1, Math.round(0.07 * ufps));
      var sRaw = s0.map(function (_, j) { return median(win(s0, j, hwM)); });   // drop single-frame size spikes first
      var sP = sRaw.map(function (_, j) { return pct(win(sRaw, j, hwS), 0.75); });
      var hwS2 = Math.max(1, Math.round(hwS / 2));
      var s = sP.map(function (_, j) { return mean(win(sP, j, hwS2)); });
      for (var j = 0; j < m; j++) {
        i = uniq[a + j];
        rois[i] = [round(cx[j] - s[j] / 2, 1), round(cy[j] - s[j] / 2, 1), round(s[j], 1)];
        src[i] = seg[j].hit ? 't' : 'i'; trk[i] = ownerId[a + j];
      }
      a = b + 1;
    }
    if (dup) {
      var last = -1;
      for (i = 0; i < n; i++) {
        if (bad && bad[i]) continue;
        if (dup[i] && last >= 0 && rois[last]) { rois[i] = rois[last]; src[i] = 'd'; trk[i] = trk[last]; }
        last = i;
      }
    }
    return { rois: rois, src: src, trk: trk };
  }

  // ── the localiser, with the model and frames injected ──────────────────
  // ctx: {n, W, H, span (s), dmax[], diff[], gw, gh, K,
  //       bad[]? (1 = frame could not be decoded: never posed, not a duplicate; dmax/diff of the
  //               next good frame are against the last good one, a bad frame's own are ignored),
  //       grey(i) -> thumbnail (Uint8Array, may be a promise),
  //       pose(i, roiSquare) -> [[x, y, score] x 17] in frame px (may be a promise),
  //       progress(frac 0..1, text)?}
  // -> {dup, cut, rois, src, trk, tracks, rivals, seeds, cam, fgFrac, unique, ufps, bg}
  async function localise(ctx) {
    var n = ctx.n, W = ctx.W, H = ctx.H, K = ctx.K, gw = ctx.gw, gh = ctx.gh;
    var progressRaw = ctx.progress || function () {}, lastProg = 0;
    function progress(f, text) { lastProg = Math.max(lastProg, Math.min(1, f)); progressRaw(lastProg, text); }
    var calls = 0, i;
    // duplicates and cuts over the decodable frames only (identical to the lab when none is bad)
    var bad = ctx.bad || null, good = [];
    for (i = 0; i < n; i++) if (!bad || !bad[i]) good.push(i);
    var dupG = dupFlags(good.map(function (fi, q) { return q ? ctx.dmax[fi] : null; }));
    var cutG = cutFlags(good.map(function (fi, q) { return q ? ctx.diff[fi] : null; }));
    var dup = [], cut = [];
    for (i = 0; i < n; i++) { dup.push(0); cut.push(0); }
    good.forEach(function (fi, q) { dup[fi] = dupG[q]; cut[fi] = cutG[q]; });
    var uniq = []; for (i = 0; i < n; i++) if ((!bad || !bad[i]) && !dup[i]) uniq.push(i);
    var U = uniq.length;
    if (!U) {
      return { dup: dup, cut: cut, rois: dup.map(function () { return null; }), src: dup.map(function () { return null; }), trk: dup.map(function () { return null; }),
        tracks: [], rivals: [], seeds: 0, cam: 'moving', fgFrac: 0, unique: 0, ufps: 0, modelCalls: 0, bg: null, camStatic: false };
    }
    var dur = ctx.span || n / 30;
    var ufps = U / Math.max(dur, 0.1);

    // background median (static cameras)
    var ns = Math.min(P.bgSamples, U), samp = [], greys = [], j;
    for (j = 0; j < ns; j++) samp.push(uniq[Math.floor((j + 0.5) * U / ns)]);
    for (j = 0; j < ns; j++) greys.push(await ctx.grey(samp[j]));
    var bg = bgMedian(greys);
    var fgFrac = greys.map(function (g) { return fgFraction(g, bg); });
    greys = null;
    var camStatic = median(fgFrac) < P.staticFrac;

    function pose(ui, r) { calls++; return ctx.pose(uniq[ui], sq(r)); }

    // Refine: re-crop around the pose until the ROI settles. -> {r, k, cs} or null
    async function refine(ui, k0, iters) {
      iters = iters == null ? 2 : iters;
      var r = roiFromPose(k0), k = k0;
      for (var it = 0; it < iters && r; it++) {
        if (r.s < P.minRoi) return null;
        k = await pose(ui, r); var r2 = roiFromPose(k);
        if (!r2) return null;
        var done = Math.hypot(r2.cx - r.cx, r2.cy - r.cy) < 0.06 * r.s && Math.abs(Math.log(r2.s / r.s)) < 0.08;
        r = r2; if (done) break;
      }
      if (!r || r.s < P.minRoi) return null;
      return { r: r, k: k, cs: coreScore(k) };
    }

    // seeds on probe frames
    var ucut = uniq.map(function (x) { return cut[x]; });
    var probes = probeList(U, ucut);
    var perProbe = {}, seeds = [];
    var probeDone = 0, probeTotal = probes.length;
    async function probeFrame(ui, levels) {
      var fi = uniq[ui], g = await ctx.grey(fi);
      var found = perProbe[ui] || []; perProbe[ui] = found;
      async function tryRoi(r, src) {
        if (greyMean(g, gw, gh, K, r.cx - r.s / 2, r.cy - r.s / 2, r.s) < 10) return;
        var k = await pose(ui, r);
        if (coreScore(k) < P.seedMin) return;
        var f = await refine(ui, k);
        if (!f || f.cs < P.seedOk || !plausible(f.k, f.r.s)) return;
        for (var q = 0; q < found.length; q++) {
          var o = found[q];
          if (Math.hypot(o.r.cx - f.r.cx, o.r.cy - f.r.cy) < 0.3 * Math.max(o.r.s, f.r.s)) { if (f.cs > o.cs) { o.r = f.r; o.k = f.k; o.cs = f.cs; o.src = src; } return; }
        }
        f.src = src; found.push(f);
      }
      if (levels.indexOf('m') >= 0 && camStatic) {
        var bl = blobs(g, bg, gw, gh, K).slice(0, 4);
        for (var q = 0; q < bl.length; q++) {
          var b = bl[q], s = Math.max(1.4 * Math.max(b.x1 - b.x0, b.y1 - b.y0), 96);
          await tryRoi({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, s: s }, 'motion');
        }
      }
      for (var lv = 0; lv <= 2; lv++) if (levels.indexOf(lv) >= 0) {
        var ts = tiles(lv, W, H);
        for (var t = 0; t < ts.length; t++) await tryRoi(ts[t], 'tile' + lv);
      }
    }
    // Progress: phase A 0-0.2, phase B 0.2-0.3, tracking 0.3-1 (never stalls: it moves with
    // every tracking step and with every seed considered).
    // phase A: motion blobs + whole frame + short-side squares on every probe frame
    for (j = 0; j < probes.length; j++) {
      await probeFrame(probes[j], ['m', 0, 1]);
      progress(0.2 * (++probeDone) / probeTotal, 'finding the runner');
    }
    // phase B: only when the runner was rarely found - half-size tiles on the probe frames without a seed
    var goodProbes = probes.filter(function (ui) { return perProbe[ui].some(function (f) { return f.cs >= 0.5; }); }).length;
    if (goodProbes < Math.min(3, probes.length)) {
      var emptyProbes = probes.filter(function (ui) { return !perProbe[ui].length; });
      for (j = 0; j < emptyProbes.length; j++) {
        await probeFrame(emptyProbes[j], [2]);
        progress(0.2 + 0.1 * (j + 1) / emptyProbes.length, 'finding the runner');
      }
    }
    progress(0.3, 'finding the runner');
    probes.forEach(function (ui) {
      perProbe[ui].forEach(function (f) { seeds.push({ ui: ui, i: uniq[ui], r: f.r, k: f.k, cs: f.cs, src: f.src, prio: f.cs * f.cs * f.r.s }); });
    });
    seeds.sort(function (a, b) { return b.prio - a.prio; });

    // tracks
    var maxMiss = Math.max(4, Math.round(P.maxMissSec * ufps));
    // (browser: a clip with very few unique frames needs only half of them; the lab never had one)
    var minHits = Math.min(Math.max(4, Math.round(P.minTrackSec * ufps)), Math.max(1, Math.ceil(U / 2)));
    var stepsDone = 0, seedsDone = 0;
    function trackProgress() {
      progress(0.3 + 0.7 * Math.max(1 - Math.exp(-stepsDone / U), seedsDone / Math.max(1, seeds.length)), 'following the runner');
    }
    function ankles(k, s) { return { ax: (k[15][0] - k[16][0]) / s, ay: (k[15][1] - k[16][1]) / s }; }
    async function runTrack(seed) {
      var st = new Map(), a0 = ankles(seed.k, seed.r.s);
      st.set(seed.ui, { cx: seed.r.cx, cy: seed.r.cy, s: seed.r.s, cs: seed.cs, hit: 1, ax: a0.ax, ay: a0.ay });
      var dirs = [1, -1];
      for (var di = 0; di < 2; di++) {
        var dir = dirs[di];
        var r = { cx: seed.r.cx, cy: seed.r.cy, s: seed.r.s }, v = { x: 0, y: 0, ls: 0 }, miss = 0;
        for (var ui = seed.ui + dir; ui >= 0 && ui < U; ui += dir) {
          if (ucut[dir === 1 ? ui : ui + 1]) break;   // never follow across a scene cut
          var p = trackPredict(r, v, miss), pr = p.pr, grow = p.grow;
          if (outOfFrame(pr, W, H)) break;
          var k = await pose(ui, pr), m = roiFromPose(k), cs = coreScore(k);
          var ok = cs >= P.trackOk && consistentRoi(m, pr);
          if (ok && (Math.hypot(m.cx - pr.cx, m.cy - pr.cy) > 0.10 * pr.s || Math.abs(Math.log(m.s / pr.s)) > 0.15)) {
            // prediction was off: look again from the measured ROI
            var k2 = await pose(ui, m), m2 = roiFromPose(k2), cs2 = coreScore(k2);
            if (cs2 >= cs * 0.9 && consistentRoi(m2, pr)) { k = k2; m = m2; cs = cs2; }
          }
          if (ok && m.s < P.minRoi) ok = false;
          if (ok) {
            var acc = trackAccept(r, v, pr, m, grow); r = acc.r; v = acc.v;
            var an = ankles(k, m.s);
            st.set(ui, { cx: r.cx, cy: r.cy, s: m.s, cs: cs, hit: 1, ax: an.ax, ay: an.ay }); miss = 0;
          } else {
            miss++; var ms = trackMiss(v, pr, grow); r = ms.r; v = ms.v;
            st.set(ui, { cx: r.cx, cy: r.cy, s: r.s, cs: cs, hit: 0 });
            if (miss > maxMiss) break;
          }
          stepsDone++;
          trackProgress();
        }
        // trim trailing misses
        var keysNow = Array.from(st.keys());
        for (var u2 = (dir === 1 ? Math.max.apply(null, keysNow) : Math.min.apply(null, keysNow)); st.has(u2) && !st.get(u2).hit; u2 -= dir) st.delete(u2);
      }
      return st;
    }
    var cand = [];
    var topPrio = seeds.length ? seeds[0].prio : 0;
    var nCuts = ucut.filter(Boolean).length;
    for (j = 0; j < seeds.length; j++, seedsDone++, trackProgress()) {
      var seed = seeds[j];
      if (cand.length >= Math.max(P.maxTracks, nCuts + 3)) break;   // montages: one track per shot
      if (seed.prio < P.seedPrioFrac * topPrio) continue;           // far-away bystanders
      // already explained by a track passing through the same place in that frame?
      var explained = cand.some(function (c) {
        var s = c.st.get(seed.ui);
        return s && Math.hypot(s.cx - seed.r.cx, s.cy - seed.r.cy) < 0.35 * Math.max(s.s, seed.r.s);
      });
      if (explained) continue;
      var st = await runTrack(seed);
      var keys = Array.from(st.keys()).sort(function (a, b) { return a - b; });
      var hits = keys.filter(function (u) { return st.get(u).hit; });
      var info = {
        seedFrame: seed.i, seedSrc: seed.src, from: uniq[keys[0]], to: uniq[keys[keys.length - 1]], frames: keys.length, hits: hits.length,
        meanCs: round(hits.reduce(function (s, u) { return s + st.get(u).cs; }, 0) / Math.max(1, hits.length), 3),
        medSize: Math.round(median(hits.map(function (u) { return st.get(u).s; })))
      };
      info.quality = round(info.meanCs * info.medSize * Math.sqrt(hits.length), 1);   // confident, large, long
      info.legMotion = round(legMotion(hits.map(function (u) { var e = st.get(u); return [e.ax, e.ay]; })), 3);
      info.still = hits.length >= 4 && info.legMotion < P.stillLeg;
      cand.push({ st: st, keys: keys, info: info });
    }
    var sel = selectTracks(cand, U, minHits);
    var sm = smoothRois(sel.owner, sel.ownerId, ucut, uniq, ufps, n, dup, bad);
    progress(1, 'runner located');
    return {
      dup: dup, cut: cut, rois: sm.rois, src: sm.src, trk: sm.trk, tracks: sel.tracks, rivals: sel.rivals, seeds: seeds.length,
      cam: camStatic ? 'static' : 'moving', fgFrac: round(median(fgFrac), 3), unique: U, ufps: round(ufps, 2),
      modelCalls: calls, bg: bg, camStatic: camStatic
    };
  }

  // Pose every frame on its ROI; a dup frame with the same ROI as the previous frame reuses
  // its pose (same picture, same answer). poseFn(i, roi) -> keypoints or null (may be a promise).
  // bad[]? as in localise: undecodable frames are skipped when looking back for the repeated frame.
  async function posePass(rois, dup, poseFn, onFrame, bad) {
    var n = rois.length, out = [], inferred = 0, last = -1;
    for (var i = 0; i < n; i++) {
      var r = rois[i], k = null;
      if (!r) k = null;
      else if (dup[i] && last >= 0 && out[last] && sameRoi(r, rois[last])) k = out[last];
      else { k = await poseFn(i, r); inferred++; }
      out.push(k);
      if (!bad || !bad[i]) last = i;
      if (onFrame) onFrame(i, n);
    }
    return { kps: out, inferred: inferred };
  }
  function sameRoi(a, b) { return !!(a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]); }

  // Single frame, no track: seed search on one frame (blobs when a background is given).
  // poseFn(roiSquare) -> keypoints. -> {roi:[x0,y0,s], cs, src} or null.
  async function localiseOne(W, H, poseFn, opt) {
    opt = opt || {};
    var found = [];
    function poseR(r) { return poseFn(sq(r)); }
    async function refine1(k0) {
      var r = roiFromPose(k0), k = k0;
      for (var it = 0; it < 2 && r; it++) {
        if (r.s < P.minRoi) return null;
        k = await poseR(r); var r2 = roiFromPose(k);
        if (!r2) return null;
        var done = Math.hypot(r2.cx - r.cx, r2.cy - r.cy) < 0.06 * r.s && Math.abs(Math.log(r2.s / r.s)) < 0.08;
        r = r2; if (done) break;
      }
      if (!r || r.s < P.minRoi) return null;
      return { r: r, k: k, cs: coreScore(k) };
    }
    async function tryRoi(r, src) {
      if (opt.grey && greyMean(opt.grey, opt.gw, opt.gh, opt.K, r.cx - r.s / 2, r.cy - r.s / 2, r.s) < 10) return;
      var k = await poseR(r);
      if (coreScore(k) < P.seedMin) return;
      var f = await refine1(k);
      if (!f) return;
      f.ok = f.cs >= P.seedOk && plausible(f.k, f.r.s);
      f.src = src; found.push(f);
    }
    var props = [], q;
    if (opt.grey && opt.bg) {
      var bl = blobs(opt.grey, opt.bg, opt.gw, opt.gh, opt.K).slice(0, 4);
      for (q = 0; q < bl.length; q++) {
        var b = bl[q];
        props.push([{ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, s: Math.max(1.4 * Math.max(b.x1 - b.x0, b.y1 - b.y0), 96) }, 'motion']);
      }
    }
    tiles(0, W, H).concat(tiles(1, W, H)).forEach(function (r) { props.push([r, 'tile']); });
    for (q = 0; q < props.length; q++) await tryRoi(props[q][0], props[q][1]);
    if (!found.some(function (f) { return f.ok && f.cs >= 0.5; })) {
      var t2 = tiles(2, W, H);
      for (q = 0; q < t2.length; q++) await tryRoi(t2[q], 'tile2');
    }
    // best: a proper seed if there is one, else the best upright refined hit that a track would accept
    var pool = found.filter(function (f) { return f.ok; });
    if (!pool.length) pool = found.filter(function (f) { return f.cs >= P.trackOk && plausible(f.k, f.r.s); });
    if (!pool.length) return null;
    pool.sort(function (a, b) { return b.cs * b.cs * b.r.s - a.cs * a.cs * a.r.s; });
    var best = pool[0];
    return { roi: sq(best.r).map(function (v) { return round(v, 1); }), cs: best.cs, src: best.src };
  }

  // For a frame trackClip left without an ROI: the nearest frame within gap seconds that has
  // one, without crossing a scene cut (frames[j].cut = cut just before frame j). Ties go to
  // the lower track id (0 = the runner). frames: [{t, cut, roi, trk}] -> {j, roi, trk, dt} | null.
  function borrowRoi(frames, i, gap) {
    var t = frames[i].t, best = null;
    [-1, 1].forEach(function (dir) {
      for (var j = i + dir; j >= 0 && j < frames.length; j += dir) {
        if (frames[dir === 1 ? j : j + 1].cut) break;
        var dt = Math.abs(frames[j].t - t);
        if (!(dt <= gap + 1e-9)) break;
        if (frames[j].roi) {
          var tr = frames[j].trk == null ? 1e9 : frames[j].trk;
          if (!best || dt < best.dt - 1e-9 || (Math.abs(dt - best.dt) <= 1e-9 && tr < best.trk)) best = { j: j, roi: frames[j].roi, trk: tr, dt: dt };
          break;
        }
      }
    });
    return best;
  }

  // 17 COCO keypoints [x, y, score] of a MoveNet (17) or BlazePose (33) answer.
  function coco17(k) { return !k ? null : k.length === 33 ? BLAZE_TO_COCO.map(function (b) { return k[b]; }) : k; }

  function named(k) {
    if (!k) return null;
    return k.map(function (p, j) { return { x: p[0], y: p[1], score: p[2], name: NAMES[j] }; });
  }
  function namedBlaze(k33) {
    if (!k33) return null;
    var out = BLAZE_TO_COCO.map(function (b, j) { var p = k33[b]; return { x: p[0], y: p[1], score: p[2], name: NAMES[j] }; });
    out.blaze33 = k33.map(function (p, j) { return { x: p[0], y: p[1], score: p[2], name: BLAZE_NAMES[j] }; });
    return out;
  }
  // pose-detection's pose score: mean score of keypoints scoring above 0.2 (the library
  // drops a pose under 0.25 by this measure).
  function poseScore(kps) {
    var s = 0, c = 0;
    for (var j = 0; j < kps.length; j++) { var v = kps[j].score != null ? kps[j].score : kps[j][2]; if (v > 0.2) { s += v; c++; } }
    return c ? s / c : 0;
  }

  // ═══════════════════════════ browser layer ════════════════════════════
  var _models = {};            // kind -> Promise<{model, size, kind}>
  var _cache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;   // store -> last trackClip result
  var _cv = {};                // reusable canvases: crop-<T>, thumb
  var stats = { calls: {}, ms: {} };

  function tfg() { return (typeof tf !== 'undefined') ? tf : null; }
  function canvas(key, w, h, readback) {
    var c = _cv[key];
    if (!c) {
      var el = document.createElement('canvas');
      var ctx = el.getContext('2d', readback ? { alpha: false, willReadFrequently: true } : { alpha: false });
      c = _cv[key] = { el: el, ctx: ctx };
    }
    if (c.el.width !== w || c.el.height !== h) { c.el.width = w; c.el.height = h; }
    c.ctx.imageSmoothingEnabled = true;
    c.ctx.imageSmoothingQuality = 'high';
    return c;
  }

  // The page's detectors already hold the MoveNet weights; reuse them instead of a second download.
  function pageGraphModel(kind) {
    try {
      /* global detector, scanDetector */
      if (kind === 'thunder' && typeof detector !== 'undefined' && detector && detector.moveNetModel) return detector.moveNetModel;
      if (kind === 'lightning' && typeof scanDetector !== 'undefined' && scanDetector && scanDetector.moveNetModel) return scanDetector.moveNetModel;
    } catch (e) {}
    return null;
  }
  // The page's Lightning detector may still be loading (phones): wait for it rather than
  // starting a second download of the same weights.
  function pageModelPending(kind) {
    try {
      /* global scanDetectorPromise */
      if (kind === 'lightning' && typeof scanDetectorPromise !== 'undefined' && scanDetectorPromise &&
          !(typeof scanDetector !== 'undefined' && scanDetector)) return scanDetectorPromise;
    } catch (e) {}
    return null;
  }
  function modelError(msg, cause) { var e = new Error(msg); e.eslModelError = true; e.cause = cause; return e; }
  function wrapModel(model, kind, shared) { return { model: model, size: MODELS[kind].size, kind: kind, shared: shared }; }

  // A model we load ourselves keeps its weights for good: the page wraps the phone scan in
  // tf.engine().startScope()/endScope(), which would otherwise dispose weights created inside it.
  function keepWeights(T, model) {
    var w = model && model.weights;
    if (!w) return;
    Object.keys(w).forEach(function (name) { [].concat(w[name]).forEach(function (t) { if (t && !t.kept) T.keep(t); }); });
  }

  // -> Promise<{model, size, kind, shared}>. Reuses the page's copy when it has one (also when
  // it appears while ours downloads: ours is then disposed). A failed load is forgotten so the
  // next call retries. Callers inside this module wait through waitModel (cancel + timeout).
  function getModel(kind) {
    kind = kind || 'thunder';
    if (!MODELS[kind]) return Promise.reject(new Error('EslPoseV2: unknown model ' + kind));
    if (_models[kind]) return _models[kind];
    var shared = pageGraphModel(kind);
    if (shared) return (_models[kind] = Promise.resolve(wrapModel(shared, kind, true)));
    var T = tfg();
    if (!T) return Promise.reject(modelError('EslPoseV2: TF.js is not loaded'));
    var pending = pageModelPending(kind);
    var p = Promise.resolve(pending).then(function () {}, function () {}).then(function () {
      var sh = pageGraphModel(kind);
      if (sh) return wrapModel(sh, kind, true);
      return T.loadGraphModel(MODELS[kind].url, { fromTFHub: true }).then(function (model) {
        keepWeights(T, model);
        var sh2 = pageGraphModel(kind);
        if (sh2) { try { model.dispose(); } catch (e) {} return wrapModel(sh2, kind, true); }
        var S = MODELS[kind].size;
        T.tidy(function () {
          if (kind === 'blaze') model.execute(T.zeros([1, S, S, 3]), ['ld_3d', 'output_poseflag', 'activation_heatmap']);
          else model.execute(T.zeros([1, S, S, 3], 'int32'));
        });
        return wrapModel(model, kind, false);
      }, function (e) { throw modelError('EslPoseV2: could not load the ' + kind + ' model: ' + (e && e.message || e), e); });
    });
    _models[kind] = p;
    p.then(function (m) {
      if (!_models[kind]) _models[kind] = p;   // finished after a timeout gave up on it: use it after all
    }, function () { if (_models[kind] === p) delete _models[kind]; });
    return p;
  }
  // getModel, but gives up when checkCancel throws (polled) or after timeoutMs; a timed-out
  // load is forgotten so the next call starts afresh. Load failures and timeouts reject with
  // an error carrying eslModelError = true; a cancel rejects with whatever checkCancel threw.
  function waitModel(kind, checkCancel, timeoutMs) {
    var p = getModel(kind);
    timeoutMs = timeoutMs > 0 ? timeoutMs : P.modelTimeoutMs;
    return new Promise(function (resolve, reject) {
      var done = false, iv = null, to = null;
      function fin(f, v) { if (done) return; done = true; if (iv) clearInterval(iv); if (to) clearTimeout(to); f(v); }
      p.then(function (m) { fin(resolve, m); }, function (e) { fin(reject, e && e.eslModelError ? e : modelError(String(e && e.message || e), e)); });
      if (done) return;
      if (checkCancel) iv = setInterval(function () { try { checkCancel(); } catch (e) { fin(reject, e); } }, 200);
      to = setTimeout(function () {
        if (_models[kind] === p) delete _models[kind];
        fin(reject, modelError('EslPoseV2: the ' + kind + ' model did not load within ' + Math.round(timeoutMs / 1000) + ' s'));
      }, timeoutMs);
    });
  }
  // For tests and tools: use a given graph model for a kind.
  function setModel(kind, graphModel) { _models[kind] = Promise.resolve(wrapModel(graphModel, kind, true)); }

  // Draw the square ROI of img into the T x T crop canvas (black outside the frame).
  function drawCrop(img, roi, T) {
    var c = canvas('crop-' + T, T, T, false);
    var W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
    c.ctx.fillStyle = '#000';
    c.ctx.fillRect(0, 0, T, T);
    var R = cropRects(roi, W, H, T);
    if (R) c.ctx.drawImage(img, R.sx, R.sy, R.sw, R.sh, R.dx, R.dy, R.dw, R.dh);
    return c.el;
  }

  // One stateless model call on a square ROI of a decoded frame. -> [[x, y, score] x 17]
  // (MoveNet) or 33 (BlazePose; null when it reports no pose), frame px.
  // rs: optional per-run counters {calls, ms} (so concurrent runs report their own numbers).
  async function poseRoi(m, img, roi, rs) {
    var T = tfg(), t0 = now();
    var el = drawCrop(img, roi, m.size);
    if (m.kind === 'blaze') {
      var outs = T.tidy(function () {
        var x = T.div(T.expandDims(T.cast(T.browser.fromPixels(el), 'float32'), 0), 255);
        return m.model.execute(x, ['ld_3d', 'output_poseflag', 'activation_heatmap']);
      });
      var dd;
      try { dd = await Promise.all(outs.map(function (o) { return o.data(); })); }
      finally { outs.forEach(function (o) { o.dispose(); }); }
      tick(m.kind, t0, rs);
      return decodeBlaze(dd[0], dd[1][0], dd[2], roi, m.size);
    }
    var out = T.tidy(function () { return m.model.execute(T.expandDims(T.browser.fromPixels(el), 0)); });
    var d;
    try { d = await out.data(); } finally { out.dispose(); }
    tick(m.kind, t0, rs);
    return mapMoveNet(d, roi);
  }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function tick(kind, t0, rs) {
    var dt = now() - t0;
    [stats, rs].forEach(function (s) { if (s) { s.calls[kind] = (s.calls[kind] || 0) + 1; s.ms[kind] = (s.ms[kind] || 0) + dt; } });
  }

  // Decoded frames of one store, by index: a small LRU of our own ImageBitmaps (closed on
  // eviction), so nothing else can close a frame we are using and the store's own cache is
  // left alone. Falls back to store.image() where createImageBitmap or blobs are missing.
  function FrameSource(store, max) {
    this.store = store; this.max = max || 6; this.map = new Map();
    this.own = typeof createImageBitmap === 'function' && !!store.blobs && store.blobs.length === store.times.length;
  }
  // entry: {p: Promise<{img, own}>}; only our own bitmaps are ever closed
  FrameSource.prototype._entry = function (i) {
    var hit = this.map.get(i);
    if (hit) { this.map.delete(i); this.map.set(i, hit); return hit; }
    var store = this.store, t = store.times[i];
    var p = (this.own
      ? createImageBitmap(store.blobs[i]).then(function (b) { return { img: b, own: true }; },
        function () { return Promise.resolve(store.image(t)).then(function (im) { return { img: im, own: false }; }); })
      : Promise.resolve(store.image(t)).then(function (im) { return { img: im, own: false }; })
    ).then(null, function () { return { img: null, own: false }; });   // a frame that cannot be decoded is null, never a throw
    var e = { p: p };
    this.map.set(i, e);
    while (this.map.size > this.max) {
      var k = this.map.keys().next().value, old = this.map.get(k);
      this.map.delete(k);
      release(old);
    }
    return e;
  };
  function release(e) { e.p.then(function (r) { if (r && r.own && r.img && r.img.close) r.img.close(); }); }
  FrameSource.prototype.get = function (i) { return this._entry(i).p.then(function (r) { return r ? r.img : null; }); };
  // start decoding frame i in the background (it then waits in the LRU)
  FrameSource.prototype.prefetch = function (i) { if (i >= 0 && i < this.store.times.length) this._entry(i); };
  // done with frame i for good (sequential passes): close it now
  FrameSource.prototype.drop = function (i) { var e = this.map.get(i); if (e) { this.map.delete(i); release(e); } };
  FrameSource.prototype.close = function () { this.map.forEach(release); this.map.clear(); };

  function thumbDims(W, H) { var K = P.thumbK; return { K: K, gw: Math.max(1, Math.floor(W / K)), gh: Math.max(1, Math.floor(H / K)) }; }
  // 1/K-scale grey thumbnail: the canvas box-downscale of the frame's top-left gw*K x gh*K
  // pixels (the lab's 'valid' average pool), grey = channel mean.
  function thumbOf(img, d) {
    var c = canvas('thumb', d.gw, d.gh, true);
    c.ctx.drawImage(img, 0, 0, d.gw * d.K, d.gh * d.K, 0, 0, d.gw, d.gh);
    var px = c.ctx.getImageData(0, 0, d.gw, d.gh).data, g = new Uint8Array(d.gw * d.gh);
    for (var p = 0, q = 0; p < g.length; p++, q += 4) g[p] = Math.round((px[q] + px[q + 1] + px[q + 2]) / 3);
    return g;
  }

  function macrotask() {
    return new Promise(function (r) {
      if (typeof MessageChannel !== 'undefined') { var ch = new MessageChannel(); ch.port1.onmessage = function () { r(); }; ch.port2.postMessage(0); }
      else setTimeout(r, 0);
    });
  }
  function storeSpan(store) {
    var t = store.times, n = t.length;
    return n > 1 && t[n - 1] > t[0] ? t[n - 1] - t[0] : n / 30;
  }
  function indexOfTime(store, t) {
    if (typeof store.indexAt === 'function') return store.indexAt(t);
    var times = store.times, lo = 0, hi = times.length - 1, key = t + 5e-4;
    if (hi < 0) return -1;
    if (!(key >= times[0])) return 0;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (times[mid] <= key) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function storeGuard(store, checkCancel) {
    return function () {
      if (checkCancel) checkCancel();
      if (!store || !store.ok) { var e = new Error('EslPoseV2: store released'); e.eslStoreReleased = true; throw e; }
    };
  }
  var _single = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;   // store -> Map(frame index -> single-frame search ROI | null)
  function singleCache(store) {
    if (!_single) return new Map();
    var m = _single.get(store);
    if (!m) { m = new Map(); _single.set(store, m); }
    return m;
  }

  // Localise and pose every stored frame of a clip.
  // opts: model ('thunder' | 'lightning' | 'blaze'), onProgress(fraction, text), checkCancel()
  //       (throws to cancel; also polled while a model downloads), yieldEvery (model calls
  //       between macrotask yields, default 6), modelTimeoutMs (default PARAMS.modelTimeoutMs).
  // Model downloads start at once and run during the pre-pass. If Lightning cannot be loaded the
  // runner is tracked with Thunder (diag.trackModel, diag.trackFallback). If the store is
  // released while this runs it throws 'EslPoseV2: store released' (err.eslStoreReleased) and
  // caches nothing.
  // -> {frames: [{i, t, dup, cut, bad, trk, roi, kps, score}], diag}
  //    bad = the frame could not be decoded (no pose, never a duplicate); trk 0 = the runner;
  //    score = pose-detection's pose score of kps (it would drop a pose under 0.25).
  async function trackClip(store, opts) {
    opts = opts || {};
    var kind = opts.model || 'thunder';
    if (!MODELS[kind]) throw new Error('EslPoseV2: unknown model ' + kind);
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var checkCancel = typeof opts.checkCancel === 'function' ? opts.checkCancel : null;
    var guard = storeGuard(store, checkCancel);
    var yieldEvery = opts.yieldEvery > 0 ? opts.yieldEvery : 6;
    var t0 = now(), ms = {};
    var n = store && store.ok ? store.frameCount() : 0;
    if (!n) return { frames: [], diag: { n: 0, error: 'no frames' } };
    var times = store.times.slice();
    var W = store.videoWidth, H = store.videoHeight;
    var d = thumbDims(W, H);
    var rs = { calls: {}, ms: {} };
    // start the downloads now, so they overlap the pre-pass (waited for below with cancel + timeout)
    getModel(TRACK_MODEL).then(null, function () {});
    if (kind !== TRACK_MODEL) getModel(kind).then(null, function () {});
    if (_single) _single.delete(store);
    var src = new FrameSource(store, 6);
    var sinceYield = 0;
    async function maybeYield() { if (++sinceYield >= yieldEvery) { sinceYield = 0; await macrotask(); } }
    try {
      // 1. pre-pass: thumbnails, frame differences (one thumbnail held at a time). A frame that
      //    cannot be decoded is marked bad; the next good frame is compared with the last good one.
      var diff = [], dmax = [], bad = [], prev = null, nBad = 0;
      for (var i = 0; i < n; i++) {
        guard();
        src.prefetch(i + 1); src.prefetch(i + 2);
        var img = await src.get(i);
        if (!img) { bad.push(1); nBad++; diff.push(null); dmax.push(null); }
        else {
          var g = thumbOf(img, d);
          bad.push(0);
          if (prev) { var fd = frameDiff(g, prev, d.gw, d.gh, P.block); diff.push(fd.diff); dmax.push(fd.dmax); }
          else { diff.push(null); dmax.push(null); }
          prev = g;
        }
        src.drop(i);   // sequential: never needed again in this pass
        if (i % 10 === 9) { onProgress(0.12 * (i + 1) / n, 'checking frames'); await macrotask(); }
      }
      guard();
      ms.pre = Math.round(now() - t0);

      // 2. localise (Lightning; Thunder if Lightning cannot be loaded)
      var t1 = now(), trackKind = TRACK_MODEL, trackFallback = null, lm = null;
      if (nBad < n) {
        try { lm = await waitModel(TRACK_MODEL, guard, opts.modelTimeoutMs); }
        catch (e) {
          if (!e || !e.eslModelError) throw e;
          trackFallback = e.message; trackKind = 'thunder';
          lm = await waitModel('thunder', guard, opts.modelTimeoutMs);
        }
      }
      var greyCache = new Map();
      var loc = await localise({
        n: n, W: W, H: H, span: storeSpan(store), dmax: dmax, diff: diff, bad: bad, gw: d.gw, gh: d.gh, K: d.K,
        grey: async function (fi) {
          if (greyCache.has(fi)) return greyCache.get(fi);
          guard();
          var im = await src.get(fi), gg = im ? thumbOf(im, d) : new Uint8Array(d.gw * d.gh);
          greyCache.set(fi, gg);
          return gg;
        },
        pose: async function (fi, roi) {
          guard();
          await maybeYield();
          var im = await src.get(fi);
          if (!im) return emptyPose(roi);
          return poseRoi(lm, im, roi, rs);
        },
        progress: function (f, text) { onProgress(0.12 + 0.48 * f, text); }
      });
      greyCache.clear();
      guard();
      ms.localise = Math.round(now() - t1);

      // 3. pose every frame on its ROI with the requested model
      var t2 = now();
      var withRoi = loc.rois.filter(Boolean).length;
      // Lightning asked for the poses too but it could not be loaded for tracking: pose with
      // Thunder as well rather than wait out a second timeout and fail the clip
      if (trackFallback && kind === TRACK_MODEL) kind = trackKind;
      var pm = withRoi ? await waitModel(kind, guard, opts.modelTimeoutMs) : null;
      var pp = await posePass(loc.rois, loc.dup, async function (fi, roi) {
        guard();
        await maybeYield();
        var im = await src.get(fi);
        src.prefetch(fi + 1);   // decode the next frame while the model runs
        var k = im ? await poseRoi(pm, im, roi, rs) : null;
        src.drop(fi);
        return k;
      }, function (fi, nn) { if (fi % 5 === 4 || fi === nn - 1) onProgress(0.6 + 0.4 * (fi + 1) / nn, 'posing frames'); }, bad);
      guard();
      ms.pose = Math.round(now() - t2);
      ms.total = Math.round(now() - t0);

      var frames = [];
      for (i = 0; i < n; i++) {
        var k = pp.kps[i];
        var f = { i: i, t: times[i], dup: !!loc.dup[i], cut: !!loc.cut[i], bad: !!bad[i], trk: loc.rois[i] ? loc.trk[i] : null, roi: loc.rois[i], kps: null, score: null };
        if (k) { f.kps = kind === 'blaze' ? namedBlaze(k) : named(k); f.score = round(poseScore(f.kps), 3); }
        frames.push(f);
      }
      function delta(kd) {
        var c = rs.calls[kd] || 0, m = rs.ms[kd] || 0;
        return c ? { calls: c, msPerCall: round(m / c, 1) } : null;
      }
      var kept = loc.tracks.filter(function (x) { return x.kept; });
      var diag = {
        n: n, w: W, h: H, unique: loc.unique, ufps: loc.ufps, cam: loc.cam, fgFrac: loc.fgFrac,
        dups: loc.dup.filter(Boolean).length, cuts: loc.cut.filter(Boolean).length, bad: nBad,
        framesWithRoi: withRoi, framesWithPose: frames.filter(function (x) { return x.kps; }).length,
        seeds: loc.seeds, tracks: loc.tracks, mainTrk: kept.length ? 0 : null,
        rivals: loc.rivals, ambiguous: loc.rivals.length > 0,
        localiseCalls: loc.modelCalls, poseCalls: pp.inferred,
        model: kind, modelAsked: opts.model || 'thunder', trackModel: trackKind, trackFallback: trackFallback,
        models: { track: delta(trackKind), pose: kind === trackKind ? null : delta(kind) },
        ms: ms, msPerFrame: round(ms.total / n, 1), backend: (tfg() && tfg().getBackend) ? tfg().getBackend() : null
      };
      if (_cache && store.ok) _cache.set(store, { frames: frames, model: kind, bg: loc.bg, camStatic: loc.camStatic, d: d });
      return { frames: frames, diag: diag };
    } finally {
      src.close();
    }
  }
  function emptyPose(roi) { var k = []; for (var j = 0; j < 17; j++) k.push([roi[0] + roi[2] / 2, roi[1] + roi[2] / 2, 0]); return k; }

  // Stateless pose of the frame shown at t, consistent with trackClip:
  //  - a frame trackClip posed: that pose (opts.fresh re-runs the model on the same ROI);
  //  - a tracked clip's frame without an ROI (runner lost or not in shot): the ROI of the nearest
  //    tracked frame within opts.maxGapSec (default 0.2 s) on the same side of every scene cut,
  //    re-centred once on the pose found there and kept only if that is a runner where the track
  //    would accept one (core score, consistent ROI, upright); else null, because trackClip found
  //    no runner there. opts.search: true runs the single-frame search instead of answering null;
  //  - a store never tracked (or opts.search): a single-frame seed search on that frame
  //    (motion blobs when the tracked clip had a static camera, whole frame, grids); its ROI, or
  //    "no runner", is cached per frame until the next trackClip or forget.
  // Under opts.minScore (default 0.25, pose-detection's floor) by poseScore the answer is null.
  // opts: model ('thunder' default), fresh, maxGapSec, search, minScore, checkCancel, modelTimeoutMs.
  // -> keypoints [{x, y, score, name}] or null.
  async function poseAt(store, t, opts) {
    opts = opts || {};
    var kind = opts.model || 'thunder';
    if (!MODELS[kind]) throw new Error('EslPoseV2: unknown model ' + kind);
    var minScore = opts.minScore == null ? P.minPoseScore : opts.minScore;
    function gate(nk) { return nk && poseScore(nk) >= minScore ? nk : null; }
    if (!store || !store.ok || !store.frameCount()) return null;
    var guard = storeGuard(store, typeof opts.checkCancel === 'function' ? opts.checkCancel : null);
    var i = indexOfTime(store, t);
    if (i < 0) return null;
    var c = _cache ? _cache.get(store) : null, roi = null, near = false;
    if (c && c.frames[i]) {
      var f = c.frames[i];
      if (f.roi) {
        if (f.kps && c.model === kind && !opts.fresh) return gate(cloneKps(f.kps));
        roi = f.roi;
      } else {
        var nb = borrowRoi(c.frames, i, opts.maxGapSec == null ? 0.2 : opts.maxGapSec);
        if (nb) { roi = nb.roi; near = true; }
        else if (!opts.search) return null;
      }
    }
    var sc = singleCache(store);
    if (!roi && sc.has(i)) { roi = sc.get(i); if (!roi) return null; }
    var src = new FrameSource(store, 2);
    try {
      guard();
      var img = await src.get(i);
      guard();
      if (!img) return null;
      if (!roi) {
        var lm = await waitModel(TRACK_MODEL, guard, opts.modelTimeoutMs).then(null, function (e) {
          if (!e || !e.eslModelError) throw e;
          return waitModel('thunder', guard, opts.modelTimeoutMs);
        });
        var W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
        var o = { };
        if (c && c.d && c.bg && c.camStatic) { o.grey = thumbOf(img, c.d); o.bg = c.bg; o.gw = c.d.gw; o.gh = c.d.gh; o.K = c.d.K; }
        else { var dd = thumbDims(W, H); o.grey = thumbOf(img, dd); o.gw = dd.gw; o.gh = dd.gh; o.K = dd.K; }
        var loc = await localiseOne(W, H, function (r) { guard(); return poseRoi(lm, img, r); }, o);
        guard();
        sc.set(i, loc ? loc.roi : null);
        if (!loc) return null;
        roi = loc.roi;
      }
      var m = await waitModel(kind, guard, opts.modelTimeoutMs);
      var k = await poseRoi(m, img, roi);
      if (near) {
        // the borrowed ROI is up to maxGapSec of movement away: re-centre once, then accept only
        // what the tracker would have accepted here
        var k17 = coco17(k), pr = { cx: roi[0] + roi[2] / 2, cy: roi[1] + roi[2] / 2, s: roi[2] };
        var r2 = k17 ? roiFromPose(k17) : null;
        if (!r2 || coreScore(k17) < P.trackOk || !consistentRoi(r2, pr) || r2.s < P.minRoi) return null;
        guard();
        k = await poseRoi(m, img, sq(r2).map(function (v) { return round(v, 1); }));
        k17 = coco17(k);
        if (!k17 || coreScore(k17) < P.trackOk || !plausible(k17, r2.s)) return null;
      }
      return gate(kind === 'blaze' ? namedBlaze(k) : named(k));
    } finally {
      src.close();
    }
  }
  // Pose the frame shown at t on a given square ROI [x0, y0, size] (stored-frame px). A raw
  // tool: no score floor. opts: model as poseAt, checkCancel, modelTimeoutMs. -> keypoints or null.
  async function poseInRoi(store, t, roi, opts) {
    opts = opts || {};
    var kind = opts.model || 'thunder';
    if (!MODELS[kind]) throw new Error('EslPoseV2: unknown model ' + kind);
    if (!store || !store.ok || !roi) return null;
    var guard = storeGuard(store, typeof opts.checkCancel === 'function' ? opts.checkCancel : null);
    var i = indexOfTime(store, t);
    var src = new FrameSource(store, 1);
    try {
      var img = await src.get(i);
      if (!img) return null;
      var m = await waitModel(kind, guard, opts.modelTimeoutMs);
      var k = await poseRoi(m, img, roi);
      return kind === 'blaze' ? namedBlaze(k) : named(k);
    } finally {
      src.close();
    }
  }
  function cloneKps(k) {
    var out = k.map(function (p) { return { x: p.x, y: p.y, score: p.score, name: p.name }; });
    if (k.blaze33) out.blaze33 = k.blaze33.map(function (p) { return { x: p.x, y: p.y, score: p.score, name: p.name }; });
    return out;
  }
  // The last trackClip result for a store (or null), and forgetting it (and cached single-frame searches).
  function tracked(store) { return _cache ? (_cache.get(store) || null) : null; }
  function forget(store) { if (_cache) _cache.delete(store); if (_single) _single.delete(store); }

  return {
    trackClip: trackClip,
    poseAt: poseAt,
    poseInRoi: poseInRoi,
    tracked: tracked,
    forget: forget,
    getModel: getModel,
    waitModel: waitModel,
    setModel: setModel,
    poseScore: poseScore,
    stats: stats,
    NAMES: NAMES,
    MODEL_KINDS: Object.keys(MODELS),
    TRACK_MODEL: TRACK_MODEL,
    PARAMS: Object.freeze(JSON.parse(JSON.stringify(P))),   // a read-only copy; the live values are _core.P
    _core: {
      P: P, NAMES: NAMES, CORE: CORE, median: median, pct: pct, frameDiff: frameDiff, dupFlags: dupFlags, cutFlags: cutFlags,
      bgMedian: bgMedian, fgFraction: fgFraction, blobs: blobs, greyMean: greyMean, tiles: tiles, coreScore: coreScore,
      roiFromPose: roiFromPose, sq: sq, plausible: plausible, mapMoveNet: mapMoveNet, cropRects: cropRects,
      decodeBlaze: decodeBlaze, probeList: probeList, trackPredict: trackPredict, trackAccept: trackAccept,
      trackMiss: trackMiss, consistentRoi: consistentRoi, outOfFrame: outOfFrame, selectTracks: selectTracks,
      smoothRois: smoothRois, localise: localise, posePass: posePass, localiseOne: localiseOne, named: named,
      namedBlaze: namedBlaze, poseScore: poseScore, thumbDims: thumbDims, sameRoi: sameRoi,
      legMotion: legMotion, borrowRoi: borrowRoi, coco17: coco17
    }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = EslPoseV2;
