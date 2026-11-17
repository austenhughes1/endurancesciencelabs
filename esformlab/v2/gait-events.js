// ==============================================================
//  esFormLab v2 -- gait events from per-frame pose (EslGaitEvents)
// ==============================================================
//
// Picks the gait-phase frames of one clip from per-frame MoveNet keypoints:
//
//   side view:        l_foot, r_foot  (foot strike of each leg: the frame where the foot first
//                                      FULLY contacts the ground; see C.LOAD_DELAY)
//                     l_toe,  r_toe   (toe-off of each leg)
//                     mid             (mid-stance)
//   front/back view:  l, r            (mid-stance of each leg)
//
// EslGaitEvents.detect(input) -> { phases, contacts, diag }
//
//   input = { view: 'side'|'front'|'back',
//             meta: { fps, times, w, h }          (w, h = frame size in pixels)
//             frames: [{ i, t, dup, kps: [[x, y, score] x17] | null }],
//             manifest: { view } }                (view is read from here if input.view is absent)
//
//   frames is every stored frame in order; i is the frame index the picks are
//   reported in, t its time in seconds, dup true when the picture repeats the
//   previous one (screen recordings, slow-motion exports). kps is MoveNet's 17
//   keypoints in pixels (BlazePose's 33 are accepted too) or null when no pose.
//
// Nothing else is known: facing direction and which leg is near the camera are
// inferred here. The method is purely kinematic (no learned model): the ankle's
// forward/backward reach relative to the hips in a side view, the trunk's
// vertical bounce in front/back views. Classic browser script, no
// dependencies, no DOM; node loads it through module.exports for the tests.
var EslGaitEvents = (function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  //  Shared numerics. Plain functions on arrays.
  // ════════════════════════════════════════════════════════════════

  // MoveNet keypoint indices used here.
  var KP = { nose: 0, lEar: 3, rEar: 4, lSh: 5, rSh: 6, lHip: 11, rHip: 12, lKnee: 13, rKnee: 14, lAnk: 15, rAnk: 16 };
  // The same joints in BlazePose's 33-point layout.
  var KP33 = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28 };

  function finiteOnly(a) { return a.filter(function (v) { return v != null && isFinite(v); }); }
  function median(a) {
    var b = finiteOnly(a).sort(function (x, y) { return x - y; });
    if (!b.length) return null;
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : 0.5 * (b[m - 1] + b[m]);
  }
  function quantile(a, q) {
    var b = finiteOnly(a).sort(function (x, y) { return x - y; });
    if (!b.length) return null;
    var p = q * (b.length - 1), i = Math.floor(p), f = p - i;
    return i + 1 < b.length ? b[i] * (1 - f) + b[i + 1] * f : b[i];
  }
  function mean(a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) { s += a[i]; n++; } return n ? s / n : null; }

  // Unique-frame series: drops duplicated pictures (a repeated picture carries no new motion and
  // would flatten velocities and shift extrema); keeps frames without pose as gaps (kps null).
  function uniqueFrames(frames) {
    var out = [];
    for (var i = 0; i < frames.length; i++) { var f = frames[i]; if (f.dup) continue; out.push(f); }
    return out;
  }

  // A keypoint, or null when its score is under the floor.
  function pt(k, j, minS) { return k && k[j] && k[j][2] >= (minS || 0) ? k[j] : null; }
  // Midpoint of two keypoints; its score is the weaker of the two.
  function mid2(a, b) { return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.min(a[2], b[2])] : null; }

  // Time-windowed median of a series given times (null-tolerant). Used for the body scale, so a
  // single bad pose cannot change it.
  function medianFilterT(t, v, half) {
    var out = new Array(v.length), lo = 0, hi = 0;
    for (var i = 0; i < v.length; i++) {
      while (t[lo] < t[i] - half - 1e-9) lo++;
      while (hi + 1 < v.length && t[hi + 1] <= t[i] + half + 1e-9) hi++;
      var w = [];
      for (var j = lo; j <= hi; j++) if (v[j] != null) w.push(v[j]);
      out[i] = w.length ? median(w) : null;
    }
    return out;
  }

  // Local quadratic fit of v around index i using samples within +-half seconds; returns
  // {a,b,c} for v ~ a + b*(t-ti) + c*(t-ti)^2 or null. Locates an extremum between frames,
  // which matters at 15-30 fps where one frame is a large part of a stance.
  function quadFit(t, v, i, half, w) {
    var S = [0, 0, 0, 0, 0], T = [0, 0, 0], n = 0;
    function add(j) {
      if (v[j] == null) return;
      var x = t[j] - t[i], ww = w ? (w[j] || 0) : 1; if (!(ww > 0)) return;
      var p = 1;
      for (var k = 0; k < 5; k++) { S[k] += ww * p; if (k < 3) T[k] += ww * p * v[j]; p *= x; }
      n++;
    }
    var j;
    for (j = i; j >= 0 && t[i] - t[j] <= half + 1e-9; j--) add(j);
    for (j = i + 1; j < v.length && t[j] - t[i] <= half + 1e-9; j++) add(j);
    if (n < 3) return null;
    var M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
    var sol = solve3(M, T);
    return sol ? { a: sol[0], b: sol[1], c: sol[2], n: n } : null;
  }
  // 3x3 linear solve, Gauss-Jordan with partial pivoting; null when singular.
  function solve3(M, y) {
    var A = M.map(function (r, i) { return r.concat([y[i]]); });
    for (var c = 0; c < 3; c++) {
      var p = c, r;
      for (r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      var tmp = A[c]; A[c] = A[p]; A[p] = tmp;
      for (r = 0; r < 3; r++) if (r !== c) { var f = A[r][c] / A[c][c]; for (var k = c; k < 4; k++) A[r][k] -= f * A[c][k]; }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  }
  // Weighted least-squares line v ~ a + b*(t - t0) over index set idx.
  function lineFit(t, v, idx, t0, w) {
    var s0 = 0, s1 = 0, s2 = 0, y0 = 0, y1 = 0;
    for (var q = 0; q < idx.length; q++) {
      var j = idx[q]; if (v[j] == null) continue;
      var ww = w ? w[j] : 1, x = t[j] - t0;
      s0 += ww; s1 += ww * x; s2 += ww * x * x; y0 += ww * v[j]; y1 += ww * x * v[j];
    }
    var d = s0 * s2 - s1 * s1;
    if (s0 <= 0) return null;
    if (Math.abs(d) < 1e-12) return { a: y0 / s0, b: 0 };
    return { a: (y0 * s2 - y1 * s1) / d, b: (s0 * y1 - s1 * y0) / d };
  }

  // ════════════════════════════════════════════════════════════════
  //  Series: per unique frame, time, body scale, hip/shoulder centres,
  //  ankles and knees per MoveNet label, scores. Pure arrays.
  // ════════════════════════════════════════════════════════════════

  var MINS = 0.2; // keypoint score floor for use at all (scores are weights above this)

  function buildSeries(frames, meta) {
    var U = uniqueFrames(frames);
    var n = U.length;
    var S = { n: n, i: [], t: [], ok: [], hip: [], sh: [], ank: [[], []], knee: [[], []], hipL: [[], []], nose: [], ear: [[], []], trunk: [], core: [], w: meta.w, h: meta.h };
    var q;
    for (q = 0; q < n; q++) {
      var f = U[q], k = f.kps;
      S.i.push(f.i); S.t.push(f.t);
      var ix = k && k.length === 33 ? KP33 : KP;
      var hip = k ? mid2(pt(k, ix.lHip, MINS), pt(k, ix.rHip, MINS)) : null;
      var sh = k ? mid2(pt(k, ix.lSh, MINS), pt(k, ix.rSh, MINS)) : null;
      // one hip/shoulder is enough in a side view (the far one is often hidden)
      if (k && !hip) hip = pt(k, ix.lHip, MINS) || pt(k, ix.rHip, MINS);
      if (k && !sh) sh = pt(k, ix.lSh, MINS) || pt(k, ix.rSh, MINS);
      S.hip.push(hip); S.sh.push(sh);
      S.ank[0].push(k ? k[ix.lAnk] : null); S.ank[1].push(k ? k[ix.rAnk] : null);
      S.knee[0].push(k ? k[ix.lKnee] : null); S.knee[1].push(k ? k[ix.rKnee] : null);
      S.hipL[0].push(k ? k[ix.lHip] : null); S.hipL[1].push(k ? k[ix.rHip] : null);
      S.nose.push(k ? k[ix.nose] : null);
      S.ear[0].push(k ? k[ix.lEar] : null); S.ear[1].push(k ? k[ix.rEar] : null);
      S.trunk.push(hip && sh ? Math.hypot(hip[0] - sh[0], hip[1] - sh[1]) : null);
      // core confidence: mean score of the shoulders, hips, knees and ankles (pose quality weight)
      var cs = 0, cn = 0;
      if (k) [ix.lSh, ix.rSh, ix.lHip, ix.rHip, ix.lKnee, ix.rKnee, ix.lAnk, ix.rAnk].forEach(function (j) { cs += k[j][2]; cn++; });
      S.core.push(cn ? cs / cn : 0);
      // a frame is usable when it has a pose with a hip and a shoulder centre
      S.ok.push(!!(k && hip && sh));
    }
    // body scale: trunk length (shoulder centre to hip centre), median over +-0.25 s; held across
    // gaps. Every distance below is in trunk lengths, so thresholds do not depend on how far the
    // runner is from the camera or on the video resolution.
    var tr = medianFilterT(S.t, S.trunk, 0.25);
    var last = median(S.trunk);
    S.scale = tr.map(function (v) { if (v != null) last = v; return v; });
    for (q = n - 1; q >= 0; q--) { if (S.scale[q] == null) S.scale[q] = last; else last = S.scale[q]; }
    // effective frame interval: the median gap between unique frames (after duplicates are
    // dropped this is the real sampling interval, not 1/fps of the container)
    var dts = [];
    for (q = 1; q < n; q++) dts.push(S.t[q] - S.t[q - 1]);
    S.dt = median(dts) || 1 / (meta.fps || 30);
    return S;
  }

  // ════════════════════════════════════════════════════════════════
  //  Side view: facing, leg identity repair, stride period, events,
  //  contact quality.
  // ════════════════════════════════════════════════════════════════

  // ---- constants (seconds, trunk lengths or fractions) ----
  var C = {
    MIN_ANK: 0.2,          // ankle score floor
    STRIDE_MIN: 0.45,      // plausible stride period (same leg), s
    STRIDE_MAX: 1.6,
    // The ankle's forward reach peaks at about touchdown and its backward reach at about toe-off;
    // the biases are the measured mean offsets of hand-labelled events from those extrema.
    STRIKE_BIAS: 0.01,     // tau_strike = time of max forward ankle reach (hip-relative) + bias, s
    TOE_BIAS: -0.054,      // tau_toeoff = time of max backward ankle reach + bias, s
    // Foot strike is reported as the moment the foot first FULLY contacts the ground, not the first
    // picture where the shoe seems to touch it: a shoe (thick-soled ones especially) can look
    // grounded a frame or two before it truly is. That is the owner's (a running coach's)
    // definition, and his elite reference ranges (overstriding and the other foot-strike metrics)
    // were measured on frames he picked that way, so a user's foot strike must be the same moment.
    // (The names tau_load / contacts[].load are historical: this is full contact, not load onset.)
    // Full-contact instant
    // tau_load = tau_strike + LOAD_DELAY, never later than mid-stance (load builds toward a peak at
    // mid-stance). tau_strike stays the first-contact estimate: stance windows, mid-stance, toe-off
    // and leg logic use it, and contacts[].strike reports it. On his own labelled clips his
    // foot-strike frames sit a median 0.075 s (spread 0.013 s) after tau_strike, about 50 ms after
    // the first picture with the foot down; delays of 0.065-0.075 s fit them equally well. A fixed
    // delay matched them more closely than a fraction of stance or any pose signal (knee starting
    // to flex, ankle stopping, hip dropping fastest).
    LOAD_DELAY: 0.07,      // s after tau_strike
    EXT_HALF: 0.025        // half-window of the local quadratic used for sub-frame extremum, s (>= 1.5 frames)
  };

  // Facing direction: +1 = runner faces image right. Votes: nose ahead of the hips, and the swing
  // foot moving forward fast relative to the hips (swing is short and fast, stance long and slow,
  // so the hip-relative ankle velocity is skewed toward the running direction).
  function facing(S) {
    var v = 0, w = 0, q;
    for (q = 0; q < S.n; q++) {
      var n = S.nose[q], h = S.hip[q], sc = S.scale[q];
      if (n && h && n[2] > 0.3) v += Math.max(-1, Math.min(1, (n[0] - h[0]) / (0.3 * sc))) * n[2];
    }
    // ankle relative velocity skewness (sign of the third moment)
    var m3 = 0;
    for (var leg = 0; leg < 2; leg++) for (q = 1; q < S.n; q++) {
      var a = S.ank[leg][q], b = S.ank[leg][q - 1], h1 = S.hip[q], h0 = S.hip[q - 1];
      if (!a || !b || !h1 || !h0 || a[2] < C.MIN_ANK || b[2] < C.MIN_ANK) continue;
      var d = ((a[0] - h1[0]) - (b[0] - h0[0])) / S.scale[q] / (S.t[q] - S.t[q - 1]);
      m3 += d * d * d; w++;
    }
    var skew = w ? m3 / w : 0;
    // the skew vote weighs at least as much as 3 confident nose frames (10% of the clip on long
    // clips), saturating at |skew| = 50 (trunk lengths/s)^3
    var vote = v + (skew > 0 ? 1 : skew < 0 ? -1 : 0) * Math.max(3, 0.1 * S.n) * Math.min(1, Math.abs(skew) / 50);
    return vote < 0 ? -1 : 1;
  }

  // Leg identity: 2-state Viterbi over "MoveNet labels kept / swapped" with a continuity cost on the
  // hip-relative knee+ankle positions and a small prior for keeping MoveNet's own labels. In a side
  // view MoveNet often swaps left and right for a few frames when the legs cross; a leg cannot jump,
  // so the labelling that moves each leg least from frame to frame is taken. Frames found swapped
  // are relabelled here (ankle and knee). Returns the swap count and the per-frame state
  // (1 = MoveNet's labels at that frame belong to the other leg).
  function repairLegs(S, dir) {
    var n = S.n, INF = 1e18, q;
    function legPos(q, leg) {
      var h = S.hip[q], A = S.ank[leg][q], K = S.knee[leg][q], sc = S.scale[q];
      if (!h || !A || !K || A[2] < C.MIN_ANK) return null;
      return [dir * (A[0] - h[0]) / sc, (A[1] - h[1]) / sc, dir * (K[0] - h[0]) / sc, (K[1] - h[1]) / sc];
    }
    function d2(a, b) { var s = 0; for (var k = 0; k < 4; k++) s += (a[k] - b[k]) * (a[k] - b[k]); return Math.sqrt(s); }
    // a swapped frame costs 0.35 (trunk lengths of movement): a swap is taken only when it saves more
    // leg movement than that
    var cost = [[0, 0.35]], back = [[0, 0]];
    var P = [[legPos(0, 0), legPos(0, 1)]];
    for (q = 1; q < n; q++) {
      P.push([legPos(q, 0), legPos(q, 1)]);
      var c = [INF, INF], b = [0, 0];
      for (var s = 0; s < 2; s++) {
        for (var r = 0; r < 2; r++) {
          // movement cost between consecutive frames when both legs are seen in both; a gap in
          // time is divided out so a missed frame does not look like a jump
          var tr = 0;
          var a0 = P[q - 1][r], a1 = P[q - 1][1 - r], b0 = P[q][s], b1 = P[q][1 - s];
          if (a0 && a1 && b0 && b1) {
            var dtq = Math.max(1, (S.t[q] - S.t[q - 1]) / S.dt);
            tr = (d2(a0, b0) + d2(a1, b1)) / dtq;
          }
          var v = cost[q - 1][r] + tr + (s ? 0.35 : 0);
          if (v < c[s]) { c[s] = v; b[s] = r; }
        }
      }
      cost.push(c); back.push(b);
    }
    var st = new Array(n);
    if (n) {
      st[n - 1] = cost[n - 1][0] <= cost[n - 1][1] ? 0 : 1;
      for (q = n - 1; q > 0; q--) st[q - 1] = back[q][st[q]];
    }
    var swaps = 0;
    for (q = 0; q < n; q++) if (st[q]) {
      swaps++;
      var t = S.ank[0][q]; S.ank[0][q] = S.ank[1][q]; S.ank[1][q] = t;
      t = S.knee[0][q]; S.knee[0][q] = S.knee[1][q]; S.knee[1][q] = t;
    }
    return { swaps: swaps, st: st };
  }

  // Stride period from the autocorrelation of the hip-relative ankle separation: the legs'
  // fore-aft separation repeats once per stride (one step of each leg).
  function stridePeriod(S, u) {
    var d = [], q;
    for (q = 0; q < S.n; q++) d.push(u[0][q] != null && u[1][q] != null ? u[0][q] - u[1][q] : null);
    var m = mean(d); if (m == null) return 0.7;   // no data: a typical running stride, s
    var best = null, bestR = -2;
    for (var lagT = C.STRIDE_MIN; lagT <= C.STRIDE_MAX; lagT += S.dt / 2) {
      var lag = Math.round(lagT / S.dt), s = 0, s1 = 0, s2 = 0, cnt = 0;
      for (q = 0; q + lag < S.n; q++) {
        if (d[q] == null || d[q + lag] == null) continue;
        s += (d[q] - m) * (d[q + lag] - m); s1 += (d[q] - m) * (d[q] - m); s2 += (d[q + lag] - m) * (d[q + lag] - m); cnt++;
      }
      if (cnt < 8) continue;   // too few overlapping samples for a correlation
      var r = s / Math.sqrt(s1 * s2 + 1e-12);
      if (r > bestR + 1e-9) { bestR = r; best = lag * S.dt; }
      // first strong peak wins (avoid multiples of the period)
      if (bestR > 0.5 && r < bestR - 0.3) break;
    }
    return best || 0.7;
  }

  // Sub-frame extremum of v near index q (sign +1 max, -1 min): the vertex of a local quadratic,
  // accepted only when the parabola opens the right way and the vertex is within one frame.
  function refineExt(S, v, q, sign) {
    var f = quadFit(S.t, v, q, Math.max(C.EXT_HALF, 1.6 * S.dt));
    var ts = S.t[q];
    if (f && sign * f.c < 0) { var o = -f.b / (2 * f.c); if (Math.abs(o) <= S.dt) ts += o; }
    return ts;
  }

  // Local extrema of v: a sample that is the strict extreme within +-half seconds (ties go to the
  // earlier sample) with at least one sample on each side (an extremum at a gap or clip edge may be
  // a cut-off slope, not a turning point).
  function extrema(S, v, sign, half) {
    var out = [];
    for (var q = 0; q < S.n; q++) {
      if (v[q] == null) continue;
      var ok = true, nl = 0, nr = 0, k;
      for (k = q - 1; k >= 0 && S.t[q] - S.t[k] <= half; k--) if (v[k] != null) { nl++; if (sign * v[k] > sign * v[q]) { ok = false; break; } }
      if (!ok) continue;
      for (k = q + 1; k < S.n && S.t[k] - S.t[q] <= half; k++) if (v[k] != null) { nr++; if (sign * v[k] >= sign * v[q]) { ok = false; break; } }
      if (!ok || nl < 1 || nr < 1) continue;
      out.push({ q: q, ts: refineExt(S, v, q, sign), v: v[q] });
    }
    return out;
  }

  // Single-frame ankle outliers (a label jumping onto the other foot or the background for one frame):
  // the hip-relative ankle is more than 0.5 trunk lengths from the mean of its two neighbours while the
  // neighbours agree with each other. Such a point is dropped (null), not moved.
  function dropSpikes(S) {
    var dropped = 0;
    for (var leg = 0; leg < 2; leg++) {
      var rel = [], q;
      for (q = 0; q < S.n; q++) {
        var A = S.ank[leg][q], h = S.hip[q];
        rel.push(A && h && A[2] >= C.MIN_ANK ? [(A[0] - h[0]) / S.scale[q], (A[1] - h[1]) / S.scale[q]] : null);
      }
      for (q = 1; q < S.n - 1; q++) {
        var a = rel[q - 1], b = rel[q], c = rel[q + 1];
        if (!a || !b || !c) continue;
        var mx = 0.5 * (a[0] + c[0]), my = 0.5 * (a[1] + c[1]);
        var dev = Math.hypot(b[0] - mx, b[1] - my), spread = Math.hypot(a[0] - c[0], a[1] - c[1]);
        if (dev > 0.5 && dev > 1.5 * spread) { S.ank[leg][q] = null; dropped++; }
      }
    }
    return dropped;
  }

  // Side-view contacts. Each leg's hip-relative forward ankle position u (in trunk lengths,
  // positive = ahead of the hips in the running direction) swings between a forward maximum at
  // touchdown and a backward minimum at toe-off. A contact = a maximum (strike) paired with the next
  // minimum (toe-off) of the same leg.
  function detectSide(S) {
    var dir = facing(S);
    var rep = repairLegs(S, dir);
    var spikes = dropSpikes(S);
    var u = [[], []], sc = S.scale, leg, q, j;
    for (leg = 0; leg < 2; leg++) for (q = 0; q < S.n; q++) {
      var A = S.ank[leg][q], h = S.hip[q];
      u[leg].push(A && h && A[2] >= C.MIN_ANK ? dir * (A[0] - h[0]) / sc[q] : null);
    }
    var P = stridePeriod(S, u);
    var contacts = [];
    var maxScale = quantile(S.scale, 0.9);
    for (leg = 0; leg < 2; leg++) {
      // extrema at least a quarter stride apart: the forward and backward turning points of one leg
      // are about half a stride apart, so a quarter-stride window keeps one of each per swing
      var mx = extrema(S, u[leg], 1, 0.25 * P), mn = extrema(S, u[leg], -1, 0.25 * P);
      for (var k = 0; k < mx.length; k++) {
        var m = mx[k], nx = null;
        for (j = 0; j < mn.length; j++) if (mn[j].q > m.q) { nx = mn[j]; break; }
        var c = { leg: leg, tS: m.ts + C.STRIKE_BIAS, qS: m.q, amp: null };
        // the next minimum is this contact's toe-off when it comes within 3/4 of a stride and before
        // the leg's next forward maximum (a stance is shorter than a stride; past the next maximum it
        // belongs to the next contact). amp = the reach from front to back, in trunk lengths.
        if (nx && nx.ts - m.ts < 0.75 * P && (k + 1 >= mx.length || nx.q < mx[k + 1].q)) { c.tT = nx.ts + C.TOE_BIAS; c.qT = nx.q; c.amp = m.v - nx.v; }
        c.tL = loadTime(c.tS, c.tT != null && c.tT > c.tS ? c.tT - c.tS : null);
        contacts.push(c);
      }
      // a toe-off whose strike lies before the clip/visible part
      for (j = 0; j < mn.length; j++) {
        var qT = mn[j].q;
        var used = contacts.some(function (c) { return c.leg === leg && c.qT === qT; });
        if (!used) contacts.push({ leg: leg, tS: null, qS: null, tT: mn[j].ts + C.TOE_BIAS, qT: qT, amp: null });
      }
    }
    // quality of each contact: ankle and core keypoint confidence over the contact (+-2 frames),
    // the runner's size in the picture (squared: a small, far runner is much less reliable), the
    // swing amplitude relative to the clip's median (a short swing is often a mis-tracked or hidden
    // leg; 0.7 when the contact has no toe-off to measure it) and the distance of the legs from the
    // picture border (squared).
    var amps = contacts.map(function (c) { return c.amp; });
    var medAmp = median(amps) || 1;
    contacts.forEach(function (c) {
      var qs = [c.qS, c.qT].filter(function (v) { return v != null; });
      var qa = Math.min.apply(null, qs), qb = Math.max.apply(null, qs);
      var sAnk = [], sCore = [], scl = [], edge = [];
      for (var q = Math.max(0, qa - 2); q <= Math.min(S.n - 1, qb + 2); q++) {
        var A = S.ank[c.leg][q]; sAnk.push(A ? A[2] : 0); sCore.push(S.core[q]); scl.push(S.scale[q]);
        edge.push(edgeQ(S, q));
      }
      var size = Math.min(1, (median(scl) || 0) / maxScale);
      var ampQ = c.amp != null ? Math.min(1, c.amp / medAmp) : 0.7;
      c.quality = (mean(sAnk) || 0) * (mean(sCore) || 0) * size * size * ampQ * Math.pow(Math.min.apply(null, edge), 2);
    });
    return { dir: dir, swaps: rep.swaps, swapState: rep.st, spikes: spikes, P: P, contacts: contacts };
  }

  // Full-contact instant (the reported foot strike) of a contact that starts at first contact tS and
  // lasts `stance` seconds (null when unknown): LOAD_DELAY after first contact, capped at
  // mid-stance.
  function loadTime(tS, stance) {
    if (tS == null) return null;
    return tS + (stance != null ? Math.min(C.LOAD_DELAY, 0.5 * stance) : C.LOAD_DELAY);
  }

  // 1 when the legs are well inside the picture, falling to 0 as any hip/knee/ankle keypoint gets
  // within 0.4 trunk lengths of the picture border (feet cut off or squeezed against the edge).
  // A missing keypoint caps it at 0.5.
  function edgeQ(S, q) {
    var m = 1, sc = S.scale[q];
    var pts = [S.ank[0][q], S.ank[1][q], S.knee[0][q], S.knee[1][q], S.hipL[0][q], S.hipL[1][q]];
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k]; if (!p) { m = Math.min(m, 0.5); continue; }
      var d = Math.min(p[0], S.w - p[0], p[1], S.h - p[1]);
      m = Math.min(m, Math.max(0, Math.min(1, d / (0.4 * sc))));
    }
    return m;
  }

  // Frame index (into the unique series) for an event time. Strike = first frame at or after tau:
  // the first picture with the foot down. Toe-off = last frame at or before tau: the last picture
  // with the foot still down. Near = the frame nearest tau, used for the loading instant (the
  // reported foot strike: load is building on both sides of it, so the nearest picture shows it
  // best; owner's rule 1) and for mid-stance.
  function frameAt(S, tau, kind) {
    var best = null, q;
    if (kind === 'near') { var d = Infinity; for (q = 0; q < S.n; q++) if (Math.abs(S.t[q] - tau) < d) { d = Math.abs(S.t[q] - tau); best = q; } return best; }
    if (kind === 'strike') { for (q = 0; q < S.n; q++) if (S.t[q] >= tau - 1e-9) { best = q; break; } if (best == null) best = S.n - 1; }
    else { for (q = S.n - 1; q >= 0; q--) if (S.t[q] <= tau + 1e-9) { best = q; break; } if (best == null) best = 0; }
    return best;
  }

  // ════════════════════════════════════════════════════════════════
  //  Side view: phase picking.
  // ════════════════════════════════════════════════════════════════

  var LEG = ['left', 'right'];
  var SIDE_KEYS = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid'];

  // Candidates in descending score; ties keep their original order, so the first candidate is
  // exactly the first-found maximum. NaN scores are never candidates.
  function ranked(list) {
    list.forEach(function (c, k) { c.k = k; });
    return list.sort(function (a, b) { return b.s - a.s || a.k - b.k; });
  }

  // Nearest unique frame to q not in `used`, preferring posed frames; `later` searches forward
  // first on equal distance. Returns q itself when every frame is used.
  function nearestFree(S, q, used, later) {
    for (var pass = 0; pass < 2; pass++) {
      for (var d = 1; d < S.n; d++) {
        var a = later ? [q + d, q - d] : [q - d, q + d];
        for (var j = 0; j < 2; j++) {
          var x = a[j];
          if (x < 0 || x >= S.n || used[S.i[x]]) continue;
          if (pass === 0 && !S.ok[x]) continue;
          return x;
        }
      }
    }
    return q;
  }

  function pickSide(S, res) {
    var ph = { l_foot: null, r_foot: null, l_toe: null, r_toe: null, mid: null };
    var conf = { l_foot: null, r_foot: null, l_toe: null, r_toe: null, mid: null };
    var contacts = [], k;
    // the foot-strike (load) frame of a contact: the picture nearest its loading instant, never
    // before its first-contact picture
    function loadQ(c) { return Math.max(frameAt(S, c.tL, 'near'), frameAt(S, c.tS, 'strike')); }
    res.contacts.forEach(function (c) {
      // strike = earliest touch, load = the reported foot strike (first full contact), toeOff = toe-off
      var o = { leg: LEG[c.leg], strike: c.tS != null ? S.i[frameAt(S, c.tS, 'strike')] : null, load: c.tL != null ? S.i[loadQ(c)] : null, toeOff: c.tT != null ? S.i[frameAt(S, c.tT, 'toe')] : null };
      contacts.push(o); c.out = o;
    });
    // timing quality: how close the chosen frame is to the estimated event instant (owner's rule 1).
    // A toe-off frame is the last picture at or before its instant, up to a frame away; a foot-strike
    // (load) frame is the nearest picture, at most half a frame away, so its offset counts double:
    // both terms run from 1 (a picture at the instant) to 0.5 (the worst placement possible).
    function timing(tau, q, nearest) { return 1 - (nearest ? 1 : 0.5) * Math.min(1, Math.abs(S.t[q] - tau) / S.dt); }
    // Every contact of a leg is a candidate for that leg's foot strike (its loading instant) and
    // toe-off, scored by contact quality x timing; the best candidate is the pick. The timing term
    // prefers the stride whose stored frame lands closest to its loading instant.
    function cands(leg, kind) {
      var out = [];
      res.contacts.forEach(function (c) {
        if (c.leg !== leg) return;
        var tau = kind === 'load' ? c.tL : c.tT; if (tau == null) return;
        var q = kind === 'load' ? loadQ(c) : frameAt(S, tau, kind);
        var s = c.quality * timing(tau, q, kind === 'load');
        if (s > -1) out.push({ f: S.i[q], s: s });
      });
      return ranked(out);
    }
    // Mid-stance candidates: the frame nearest the midpoint of a contact that has both events.
    var midC = [];
    res.contacts.forEach(function (c) {
      if (c.tS == null || c.tT == null || c.tT <= c.tS) return;
      var tm = 0.5 * (c.tS + c.tT), q = 0, d = 1e9;
      for (var k = 0; k < S.n; k++) if (Math.abs(S.t[k] - tm) < d) { d = Math.abs(S.t[k] - tm); q = k; }
      var s = c.quality * (1 - 0.5 * Math.min(1, d / S.dt));
      if (s > -1) midC.push({ f: S.i[q], s: s });
    });
    var cand = { l_foot: cands(0, 'load'), r_foot: cands(1, 'load'), l_toe: cands(0, 'toe'), r_toe: cands(1, 'toe'), mid: ranked(midC) };
    // Two phases never share a frame. Phases choose in order of their best score; a phase whose best
    // frame is already taken falls back to its next-best candidate (for a leg, its best other
    // stride). Two strikes of different legs on one frame mean one leg's events are unreliable
    // (typically a hidden far leg whose labels sit on the near foot), and the stronger one keeps the
    // frame. When no two best frames coincide, every phase gets its best candidate.
    var order = SIDE_KEYS.filter(function (key) { return cand[key].length; });
    order.sort(function (a, b) { return cand[b][0].s - cand[a][0].s || SIDE_KEYS.indexOf(a) - SIDE_KEYS.indexOf(b); });
    var taken = {};
    order.forEach(function (key) {
      for (var j = 0; j < cand[key].length; j++) {
        var f = cand[key][j].f;
        if (taken[f]) continue;
        ph[key] = f; conf[key] = cand[key][j].s; taken[f] = true; return;
      }
    });
    // never give up. A missing event is derived from the events found: the same event of the other
    // leg half a stride away, or the other event of the same leg one typical stance time away.
    var tc = [];
    res.contacts.forEach(function (c) { if (c.tS != null && c.tT != null && c.tT > c.tS) tc.push(c.tT - c.tS); });
    var Tc = median(tc) || 0.38 * res.P;   // stance ~ 35-40% of a stride in running
    var Dl = loadTime(0, Tc);               // typical load delay after first contact, s
    function tauOf(key) {
      var f = ph[key]; if (f == null) return null;
      var q = S.i.indexOf(f); return q < 0 ? null : S.t[q];
    }
    var other = { l_foot: 'r_foot', r_foot: 'l_foot', l_toe: 'r_toe', r_toe: 'l_toe' };
    // foot strike (load) = toe-off - stance + load delay; toe-off = foot strike - load delay + stance
    var pair = { l_foot: ['l_toe', Dl - Tc], r_foot: ['r_toe', Dl - Tc], l_toe: ['l_foot', Tc - Dl], r_toe: ['r_foot', Tc - Dl] };
    var t0 = S.t[0], t1 = S.t[S.n - 1];
    // two passes: an event derived in the first pass can anchor another in the second
    for (var pass = 0; pass < 2; pass++) Object.keys(other).forEach(function (key) {
      if (ph[key] != null) return;
      var kind = key.indexOf('foot') > 0 ? 'near' : 'toe', tau = null;
      var to = tauOf(other[key]);
      // half a stride after the other leg's event, or before it when after would leave the clip
      if (to != null) tau = to + res.P / 2 <= t1 ? to + res.P / 2 : to - res.P / 2;
      var tp = tauOf(pair[key][0]);
      if (tau == null && tp != null) tau = tp + pair[key][1];
      if (tau != null) ph[key] = S.i[frameAt(S, Math.max(t0, Math.min(t1, tau)), kind)];
    });
    // mid-stance with no complete contact: halfway between the left first contact (foot strike
    // minus the load delay) and toe-off, else half a stance after the left first contact
    if (ph.mid == null) {
      var a = tauOf('l_foot'), b = tauOf('l_toe');
      if (a != null) a -= Dl;
      ph.mid = a != null && b != null && b > a ? S.i[frameAt(S, (a + b) / 2, 'near')] : a != null ? S.i[frameAt(S, a + Tc / 2, 'near')] : null;
    }
    // last resort (no usable motion at all): spread the phases over 30-70% of the posed frames
    var okq = [];
    for (k = 0; k < S.n; k++) if (S.ok[k]) okq.push(k);
    if (!okq.length) okq = [S.n >> 1];
    SIDE_KEYS.forEach(function (key, j) {
      if (ph[key] == null) ph[key] = S.i[okq[Math.floor((0.3 + 0.1 * j) * (okq.length - 1))]];
    });
    // Final guard on the derived picks: a derived phase that lands on a frame already used moves to
    // the nearest free frame (a strike or mid-stance forward first, where the foot is still down;
    // a toe-off backward first, for the same reason). Observed picks are placed first.
    var used = {}, fin = SIDE_KEYS.filter(function (key) { return conf[key] != null; })
      .concat(SIDE_KEYS.filter(function (key) { return conf[key] == null; }));
    fin.forEach(function (key) {
      var f = ph[key];
      if (used[f]) {
        var q = S.i.indexOf(f);
        if (q < 0) { var d = 1e9; for (var x = 0; x < S.n; x++) if (Math.abs(S.i[x] - f) < d) { d = Math.abs(S.i[x] - f); q = x; } }
        f = S.i[nearestFree(S, q, used, key.indexOf('toe') < 0)];
        ph[key] = f;
      }
      used[f] = true;
    });
    return { phases: ph, contacts: contacts, confidence: conf };
  }

  // ════════════════════════════════════════════════════════════════
  //  Front / back views: mid-stance of each leg.
  //  Mid-stance = the lowest point of the trunk's vertical oscillation (spring-mass running: the body
  //  is lowest at mid-stance), the stance leg = the extended leg whose ankle is far below the hips
  //  while the other (swing) ankle is tucked up; consecutive mid-stances alternate legs.
  // ════════════════════════════════════════════════════════════════

  var FB = {
    MIN_S: 0.2,
    STEP_MIN: 0.22,  // plausible step period (one foot to the other), s
    STEP_MAX: 0.8
  };

  // Put MoveNet's left/right labels into anatomical order for the view: in a back view the runner's
  // left hip is on the image left, in a front view on the image right. A frame whose hips are the
  // wrong way round is relabelled (hip, knee and ankle labels swapped). Returns the count and the
  // per-frame flags (1 = relabelled).
  function fixMirror(S, view) {
    var want = view === 'back' ? -1 : 1, fixed = 0, flag = [];
    for (var q = 0; q < S.n; q++) {
      flag.push(0);
      var lh = S.hipL[0][q], rh = S.hipL[1][q];
      if (!lh || !rh) continue;
      var hipSign = Math.sign(lh[0] - rh[0]);
      if (hipSign === -want) {
        fixed++; flag[q] = 1;
        var t = S.ank[0][q]; S.ank[0][q] = S.ank[1][q]; S.ank[1][q] = t;
        t = S.knee[0][q]; S.knee[0][q] = S.knee[1][q]; S.knee[1][q] = t;
        t = S.hipL[0][q]; S.hipL[0][q] = S.hipL[1][q]; S.hipL[1][q] = t;
      }
    }
    return { fixed: fixed, flag: flag };
  }

  function nearestOkQ(S, tau) {
    var b = null, d = 1e9;
    for (var q = 0; q < S.n; q++) { if (!S.ok[q]) continue; var x = Math.abs(S.t[q] - tau); if (x < d) { d = x; b = q; } }
    return b;
  }
  function nearestQ(S, tau) {
    var b = 0, d = 1e9;
    for (var q = 0; q < S.n; q++) { var x = Math.abs(S.t[q] - tau); if (x < d) { d = x; b = q; } }
    return b;
  }

  // Period from the autocorrelation of d between pmin and pmax seconds; the first strong peak wins
  // (avoids multiples of the period). 0.7 s when there is too little data.
  function period(S, d, pmin, pmax) {
    var m = mean(d); if (m == null) return 0.7;
    var best = null, bestR = -2;
    for (var lagT = pmin; lagT <= pmax; lagT += S.dt / 2) {
      var lag = Math.max(1, Math.round(lagT / S.dt)), s = 0, s1 = 0, s2 = 0, cnt = 0;
      for (var q = 0; q + lag < S.n; q++) {
        if (d[q] == null || d[q + lag] == null) continue;
        s += (d[q] - m) * (d[q + lag] - m); s1 += (d[q] - m) * (d[q] - m); s2 += (d[q + lag] - m) * (d[q + lag] - m); cnt++;
      }
      if (cnt < 6) continue;
      var r = s / Math.sqrt(s1 * s2 + 1e-12);
      if (r > bestR + 1e-9) { bestR = r; best = lag * S.dt; }
      if (bestR > 0.4 && r < bestR - 0.3) break;
    }
    return best || 0.7;
  }

  function detectFrontBack(S, view) {
    var mir = fixMirror(S, view);
    var n = S.n, q, k, leg;
    // trunk centre height (hips + shoulders), and per-leg ankle depth below the hips, in trunk lengths
    var cy = [], e = [[], []];
    for (q = 0; q < n; q++) {
      var h = S.hip[q], s = S.sh[q], sc = S.scale[q];
      cy.push(h && s ? 0.5 * (h[1] + s[1]) : h ? h[1] : null);
      for (leg = 0; leg < 2; leg++) {
        var A = S.ank[leg][q];
        e[leg].push(A && h && A[2] >= FB.MIN_S ? (A[1] - h[1]) / sc : null);
      }
    }
    // dif > 0: the left ankle is lower (further below the hips) than the right
    var dif = [];
    for (q = 0; q < n; q++) dif.push(e[0][q] != null && e[1][q] != null ? e[0][q] - e[1][q] : null);
    // stride period from the leg-difference signal (period = 2 steps)
    var P = period(S, dif, 2 * FB.STEP_MIN, 2 * FB.STEP_MAX);
    var step = P / 2;
    // detrended trunk height in trunk lengths: residual from a local line over +-step/2 (removes the
    // runner approaching or leaving the camera, which changes height in the picture)
    var r = new Array(n);
    for (q = 0; q < n; q++) {
      if (cy[q] == null) { r[q] = null; continue; }
      var idx = [];
      for (k = q; k >= 0 && S.t[q] - S.t[k] <= 0.5 * step; k--) idx.push(k);
      for (k = q + 1; k < n && S.t[k] - S.t[q] <= 0.5 * step; k++) idx.push(k);
      var lf = lineFit(S.t, cy, idx, S.t[q]);
      r[q] = lf ? (cy[q] - lf.a) / S.scale[q] : null;
    }
    // light smoothing (3-point mean)
    var rs = r.map(function (v, q) {
      var w = [r[q - 1], v, r[q + 1]].filter(function (x) { return x != null; });
      return v == null ? null : w.reduce(function (a, b) { return a + b; }, 0) / w.length;
    });
    // mid-stance instants: maxima of the detrended height (image y grows downward = body lowest)
    var mids = [];
    // A maximum over +-0.35 step, with pose on both sides reaching at least 0.2 step away (so a
    // peak cut off by a pose gap or the clip edge is not taken). The window must hold a frame
    // between the two: when one frame interval is longer than the 0.15 step between them (low
    // frame rates, e.g. 15 fps at 160-180 steps/min), the window reaches one frame interval past
    // 0.2 step. At 30 fps and above 0.35 step is always the larger.
    var reach = 0.2 * step, span = Math.max(0.35 * step, reach + S.dt);
    for (q = 0; q < n; q++) {
      if (rs[q] == null) continue;
      var ok = true, tl = S.t[q], tr = S.t[q];
      for (k = q - 1; k >= 0 && S.t[q] - S.t[k] <= span; k--) if (rs[k] != null) { tl = S.t[k]; if (rs[k] > rs[q]) { ok = false; break; } }
      if (!ok) continue;
      for (k = q + 1; k < n && S.t[k] - S.t[q] <= span; k++) if (rs[k] != null) { tr = S.t[k]; if (rs[k] >= rs[q]) { ok = false; break; } }
      if (!ok || S.t[q] - tl < reach || tr - S.t[q] < reach) continue;
      // sub-frame instant from a local quadratic, accepted within a quarter step
      var f = quadFit(S.t, rs, q, Math.max(1.6 * S.dt, 0.15 * step));
      var tau = S.t[q];
      if (f && f.c < 0) { var o = -f.b / (2 * f.c); if (Math.abs(o) <= 0.25 * step) tau += o; }
      // leg evidence: which ankle is further below the hips around tau
      var ev = 0, ew = 0;
      for (k = 0; k < n; k++) if (Math.abs(S.t[k] - tau) <= 0.15 * step && dif[k] != null) { ev += dif[k]; ew++; }
      mids.push({ q: q, tau: tau, ev: ew ? ev / ew : 0, amp: rs[q] });
    }
    // alternation: parity of each mid-stance on a step grid; choose the parity that agrees best
    var picks = { l: null, r: null }, conf = { l: null, r: null };
    if (mids.length) {
      // step index counted incrementally (a missed instant adds one step), so a slightly wrong
      // period cannot drift the parity over a long clip
      var vote = 0;
      mids.forEach(function (m, j) {
        m.k = j ? mids[j - 1].k + Math.max(1, Math.round((m.tau - mids[j - 1].tau) / step)) : 0;
        // each instant votes with its own leg evidence, saturating at 0.3 trunk lengths
        vote += (m.k % 2 === 0 ? 1 : -1) * Math.max(-1, Math.min(1, m.ev / 0.3));
      });
      mids.forEach(function (m) {
        var even = m.k % 2 === 0;
        m.leg = (even === (vote >= 0)) ? 0 : 1;
        // agreement of this instant's own evidence with the alternation
        m.agree = (m.leg === 0 ? 1 : -1) * m.ev;
      });
      var cand = [[], []];
      var maxScale = quantile(S.scale, 0.9);
      mids.forEach(function (m) {
        var q = nearestOkQ(S, m.tau); if (q == null) q = nearestQ(S, m.tau);
        // pose quality over the step around the instant: both ankles, the core, the picture edge
        var cf = [], edge = 1;
        for (var k = 0; k < n; k++) {
          if (Math.abs(S.t[k] - m.tau) > 0.3 * step) continue;
          var a0 = S.ank[0][k], a1 = S.ank[1][k];
          cf.push(Math.min(a0 ? a0[2] : 0, a1 ? a1[2] : 0) * S.core[k]);
          edge = Math.min(edge, edgeQ(S, k));
        }
        // runner size relative to the clip's large frames (a far runner is less reliable)
        var size = Math.min(1, S.scale[q] / (0.75 * maxScale));
        // steady running: the neighbouring mid-stances are one step away (irregular = start-up,
        // turning, or a spurious instant)
        var reg = 1, j = mids.indexOf(m);
        [mids[j - 1], mids[j + 1]].forEach(function (o) {
          if (!o) { reg *= 0.8; return; }
          var dv = (Math.abs(o.tau - m.tau) - step) / (0.15 * step);
          reg *= Math.max(0.2, Math.exp(-0.5 * dv * dv));
        });
        m.reg = reg;
        // score: confidence x size x edge x regularity, x0.3 when the instant's own evidence
        // disagrees with the alternation, less up to 30% for a frame far from the instant
        var sc = (mean(cf) || 0) * size * edge * reg * (m.agree > 0 ? 1 : 0.3) * (1 - 0.3 * Math.min(1, Math.abs(S.t[q] - m.tau) / S.dt));
        m.score = sc;
        if (sc > -1e9) cand[m.leg].push({ q: q, s: sc });
      });
      ranked(cand[0]); ranked(cand[1]);
      var best = [cand[0].length ? cand[0][0].q : null, cand[1].length ? cand[1][0].q : null];
      var bs = [cand[0].length ? cand[0][0].s : null, cand[1].length ? cand[1][0].s : null];
      // Two legs never share a frame (possible when sparse pose maps two instants to one posed
      // frame): the weaker leg takes its next-best instant on another frame, or none.
      if (best[0] != null && best[0] === best[1]) {
        var lo = bs[0] >= bs[1] ? 1 : 0, alt = null;
        for (var jj = 1; jj < cand[lo].length; jj++) if (cand[lo][jj].q !== best[1 - lo]) { alt = cand[lo][jj]; break; }
        best[lo] = alt ? alt.q : null; bs[lo] = alt ? alt.s : null;
      }
      // a leg with no instant of its own: one step before/after the other leg's pick
      for (var lg = 0; lg < 2; lg++) if (best[lg] == null && best[1 - lg] != null) {
        var to = S.t[best[1 - lg]], c1 = nearestOkQ(S, to + step), c2 = nearestOkQ(S, to - step);
        var d1 = c1 == null ? 1e9 : Math.abs(S.t[c1] - to - step), d2 = c2 == null ? 1e9 : Math.abs(S.t[c2] - to + step);
        best[lg] = d1 <= d2 ? c1 : c2; bs[lg] = null;
      }
      picks.l = best[0] != null ? S.i[best[0]] : null;
      picks.r = best[1] != null ? S.i[best[1]] : null;
      conf.l = picks.l != null ? bs[0] : null;
      conf.r = picks.r != null ? bs[1] : null;
    }
    // no oscillation found at all: the frame where each ankle is furthest below the hips relative to
    // the other (weighted by pose confidence); last resort 35% / 65% through the posed frames
    if (picks.l == null || picks.r == null) {
      var bl = null, br = null, vl = -1e9, vr = -1e9, okq = [];
      for (q = 0; q < n; q++) {
        if (!S.ok[q]) continue; okq.push(q);
        if (dif[q] == null) continue;
        var w = S.core[q] * edgeQ(S, q);
        if (dif[q] * w > vl) { vl = dif[q] * w; bl = q; }
        if (-dif[q] * w > vr) { vr = -dif[q] * w; br = q; }
      }
      if (!okq.length) for (q = 0; q < n; q++) okq.push(q);
      if (bl == null) bl = okq[Math.floor(0.35 * (okq.length - 1))];
      if (br == null) br = okq[Math.floor(0.65 * (okq.length - 1))];
      if (picks.l == null && bl != null) picks.l = S.i[bl];
      if (picks.r == null && br != null) picks.r = S.i[br];
    }
    // final guard: the legs never share a frame; the right (or the derived) pick moves to the
    // nearest free frame
    if (picks.l != null && picks.l === picks.r && n > 1) {
      var mv = conf.r == null || (conf.l != null && conf.l >= conf.r) ? 'r' : 'l';
      var used = {}; used[picks[mv === 'r' ? 'l' : 'r']] = true;
      var qm = S.i.indexOf(picks[mv]);
      picks[mv] = S.i[nearestFree(S, qm, used, true)]; conf[mv] = null;
    }
    return { phases: picks, contacts: [], P: P, mirrored: mir.fixed, mirrorFlag: mir.flag, mids: mids.length, confidence: conf };
  }

  // ════════════════════════════════════════════════════════════════
  //  Entry point.
  // ════════════════════════════════════════════════════════════════

  // Per unique frame flags -> one boolean per input frame position. A duplicate frame repeats the
  // previous picture, so it takes that picture's flag.
  function perInputFrame(frames, flags) {
    var out = [], q = -1;
    for (var k = 0; k < frames.length; k++) {
      if (!frames[k].dup) q++;
      out.push(!!flags[Math.max(0, q)]);
    }
    return out;
  }

  function detect(input) {
    var view = input.view || (input.manifest && input.manifest.view);
    var meta = input.meta || {};
    var frames = input.frames || [];
    var S = buildSeries(frames, meta);
    if (!S.n) {
      // nothing to work on: every phase is missing
      return { phases: view === 'side' ? { l_foot: null, r_foot: null, l_toe: null, r_toe: null, mid: null } : { l: null, r: null },
        contacts: [], diag: { view: view, legSwap: perInputFrame(frames, []), confidence: {}, facing: null } };
    }
    if (view === 'side') {
      var res = detectSide(S);
      var out = pickSide(S, res);
      return { phases: out.phases, contacts: out.contacts, diag: {
        view: view,
        facing: res.dir > 0 ? 'right' : 'left',   // image direction the runner faces
        dir: res.dir, swaps: res.swaps, spikes: res.spikes, P: res.P,
        legSwap: perInputFrame(frames, res.swapState),
        confidence: out.confidence
      } };
    }
    var fb = detectFrontBack(S, view);
    return { phases: fb.phases, contacts: fb.contacts, diag: {
      view: view, facing: view === 'front' ? 'toward' : 'away', P: fb.P, mirrored: fb.mirrored, mids: fb.mids,
      legSwap: perInputFrame(frames, fb.mirrorFlag),
      confidence: fb.confidence
    } };
  }

  return { detect: detect, _core: { buildSeries: buildSeries, frameAt: frameAt, C: C, FB: FB } };
})();

if (typeof module !== 'undefined') module.exports = EslGaitEvents;
