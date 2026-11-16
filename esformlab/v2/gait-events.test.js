// ════════════════════════════════════════════════════════════════
// esformlab/v2/gait-events.test.js
//
// Checks of the gait-event detector (EslGaitEvents). Run with plain node:
//
//   node esformlab/v2/gait-events.test.js
//
// No video, no pose model, no athlete data: every runner here is SYNTHETIC. A
// generator draws MoveNet-style keypoints (17 x [x, y, score], pixels) for a
// runner with a known stride: periodic hip and ankle trajectories whose first
// contacts and toe-offs are known to the millisecond, plus small keypoint noise.
// Foot strike is LOAD ONSET (the owner's definition: when the foot starts seeing
// load, not when the rubber touches the ground); for the synthetic runner that
// is its first contact + LOAD_DELAY (70 ms), so l_foot/r_foot are checked
// against that instant and contacts[].strike stays first contact.
// Side views (facing left and right), front and back views; 15, 30 and 60 fps;
// duplicated frames; a run of frames with MoveNet's left/right labels swapped;
// a clip only two strides long.
//
// The kinematics follow running: the ankle's hip-relative forward reach peaks
// just before touchdown (10 ms) and its backward reach just after toe-off
// (54 ms, the foot keeps travelling back as it leaves the ground); the trunk is
// lowest at mid-stance and bobs twice per stride.
// ════════════════════════════════════════════════════════════════
'use strict';
var path = require('path');

var G = require(path.join(__dirname, 'gait-events.js'));

var failures = 0, checks = 0;
function ok(label, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL ' + label + (extra !== undefined ? ': ' + JSON.stringify(extra) : '')); }
}
function eq(label, got, want) {
  checks++;
  if (got !== want) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function section(name, fn) { console.log(name); fn(); }

// ── seeded noise ──────────────────────────────────────────────────
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

// ── synthetic runner ──────────────────────────────────────────────
// the synthetic runner's loading instant: 70 ms after first contact (gait-events.js C.LOAD_DELAY)
var LOAD_DELAY = 0.07;
// o: view 'side'|'front'|'back', facing +1 (image right) / -1 (side only), fps (container rate),
//    dur (s), P (stride, s), Tc (stance, s), t0 (first left strike, s), dupEvery (every Nth frame
//    repeats the previous picture), swap: [t_from, t_to] pictures whose leg labels MoveNet swaps,
//    swapWhat: 'leg' (hip, knee, ankle) | 'ankle', noise (px), seed.
var W = 1280, H = 720;
function runner(o) {
  var view = o.view, dir = o.facing || 1, fps = o.fps, P = o.P || 0.72, Tc = o.Tc || 0.24;
  var t0 = o.t0 != null ? o.t0 : 0.2, sc = o.sc || 150, noise = o.noise != null ? o.noise : 1.0;
  var r = rng(o.seed || 1);
  var N = Math.round(o.dur * fps);
  var STRIKE_LEAD = 0.01, TOE_LAG = 0.054;
  // strike time of leg (0 left, 1 right) in stride k
  function strike(leg, k) { return t0 + leg * P / 2 + k * P; }
  // phase within the leg's own stride, from its last strike
  function since(leg, t) { var x = (t - strike(leg, 0)) % P; return x < 0 ? x + P : x; }
  // hip-relative forward ankle displacement (px): max at strike - 10 ms, min at toe-off + 54 ms
  function reach(leg, t) {
    var tm = since(leg, t + STRIKE_LEAD), D = Tc + STRIKE_LEAD + TOE_LAG, a = 0.6 * sc, c = 0.05 * sc;
    return tm < D ? c + a * Math.cos(Math.PI * tm / D) : c - a * Math.cos(Math.PI * (tm - D) / (P - D));
  }
  // foot lift above the ground (px): 0 in stance, a sine arch over the swing
  function lift(leg, t) {
    var x = since(leg, t);
    return x <= Tc ? 0 : 0.5 * sc * Math.sin(Math.PI * (x - Tc) / (P - Tc));
  }
  function J(x, y, s) { return [x + noise * gauss(r), y + noise * gauss(r), s]; }
  var frames = [], times = [], truth = { strikes: [[], []], loads: [[], []], toes: [[], []], mids: [[], []] }, prev = null;
  for (var k = 0; k * P + t0 - P < o.dur + P; k++) for (var leg = 0; leg < 2; leg++) {
    var s = strike(leg, k - 1);
    truth.strikes[leg].push(s); truth.loads[leg].push(s + LOAD_DELAY); truth.toes[leg].push(s + Tc); truth.mids[leg].push(s + Tc / 2);
  }
  var swapped = [];
  for (var f = 0; f < N; f++) {
    var t = f / fps;
    times.push(t);
    if (o.dupEvery && f % o.dupEvery === o.dupEvery - 1 && prev) {
      frames.push({ i: f, t: t, dup: true, kps: prev.kps.map(function (p) { return p.slice(); }) });
      swapped.push(swapped[swapped.length - 1]);
      continue;
    }
    var kps = new Array(17);
    var hx = W / 2 + (o.travel || 0) * dir * (t - o.dur / 2);
    // trunk lowest at each mid-stance (twice per stride), 0.04 trunk lengths of bob
    var hy = 330 + 0.04 * sc * Math.cos(2 * Math.PI * (t - (t0 + Tc / 2)) / (P / 2));
    var grow = 1 + (o.grow || 0) * t;
    var ground = hy + 1.9 * sc * grow;
    if (view === 'side') {
      kps[0] = J(hx + dir * 0.32 * sc, hy - 1.45 * sc, 0.9);              // nose
      kps[1] = J(hx + dir * 0.30 * sc, hy - 1.5 * sc, 0.8); kps[2] = J(hx + dir * 0.30 * sc, hy - 1.5 * sc, 0.5);
      kps[3] = J(hx + dir * 0.15 * sc, hy - 1.45 * sc, 0.7); kps[4] = J(hx + dir * 0.15 * sc, hy - 1.45 * sc, 0.4);
      kps[5] = J(hx + dir * 0.1 * sc, hy - sc, 0.85); kps[6] = J(hx + dir * 0.1 * sc, hy - sc, 0.6);
      kps[7] = J(hx, hy - 0.55 * sc, 0.7); kps[8] = J(hx, hy - 0.55 * sc, 0.5);
      kps[9] = J(hx + dir * 0.3 * sc, hy - 0.35 * sc, 0.7); kps[10] = J(hx + dir * 0.3 * sc, hy - 0.35 * sc, 0.5);
      for (var lg = 0; lg < 2; lg++) {
        var ax = hx + dir * reach(lg, t), ay = ground - lift(lg, t);
        var kx = hx + 0.5 * (ax - hx) + dir * (0.15 * sc + 0.4 * lift(lg, t)), ky = hy + 0.5 * (ay - hy);
        var sco = lg === 0 ? 0.85 : 0.7;
        kps[11 + lg] = J(hx + (lg ? -2 : 2), hy, sco);
        kps[13 + lg] = J(kx, ky, sco);
        kps[15 + lg] = J(ax, ay, sco);
      }
    } else {
      // front view: the runner's left side is on the image right; back view: on the image left
      var side = view === 'front' ? 1 : -1, g = sc * grow;
      kps[0] = J(hx, hy - 1.45 * g, 0.9);
      kps[1] = J(hx + side * 0.06 * g, hy - 1.5 * g, 0.8); kps[2] = J(hx - side * 0.06 * g, hy - 1.5 * g, 0.8);
      kps[3] = J(hx + side * 0.12 * g, hy - 1.45 * g, 0.7); kps[4] = J(hx - side * 0.12 * g, hy - 1.45 * g, 0.7);
      kps[5] = J(hx + side * 0.35 * g, hy - g, 0.85); kps[6] = J(hx - side * 0.35 * g, hy - g, 0.85);
      kps[7] = J(hx + side * 0.45 * g, hy - 0.55 * g, 0.7); kps[8] = J(hx - side * 0.45 * g, hy - 0.55 * g, 0.7);
      kps[9] = J(hx + side * 0.4 * g, hy - 0.2 * g, 0.6); kps[10] = J(hx - side * 0.4 * g, hy - 0.2 * g, 0.6);
      for (lg = 0; lg < 2; lg++) {
        var sx = lg === 0 ? side : -side;
        var fy = ground - lift(lg, t) * grow;
        kps[11 + lg] = J(hx + sx * 0.25 * g, hy, 0.85);
        kps[13 + lg] = J(hx + sx * 0.2 * g, hy + 0.5 * (fy - hy) - 0.3 * lift(lg, t), 0.8);
        kps[15 + lg] = J(hx + sx * 0.14 * g, fy, 0.8);
      }
    }
    var sw = !!(o.swap && t >= o.swap[0] && t <= o.swap[1]);
    if (sw) {
      var idx = o.swapWhat === 'ankle' ? [15] : [11, 13, 15];
      idx.forEach(function (j) { var x = kps[j]; kps[j] = kps[j + 1]; kps[j + 1] = x; });
    }
    swapped.push(sw);
    prev = { i: f, t: t, dup: false, kps: kps };
    frames.push(prev);
  }
  return {
    input: { view: view, meta: { fps: fps, times: times, w: W, h: H }, frames: frames, manifest: { view: view } },
    truth: truth, swapped: swapped
  };
}

// ── truth: frames as the detector reports them ────────────────────
// Unique pictures only (a duplicate shows an earlier picture). A first contact (strike) is the
// first picture at or after its instant; a toe-off the last picture at or before the toe-off; a
// foot strike (load onset) and a mid-stance the picture nearest the instant.
function uniq(input) { return input.frames.filter(function (f) { return !f.dup; }); }
function frameOf(U, tau, kind) {
  var q;
  if (kind === 'strike') { for (q = 0; q < U.length; q++) if (U[q].t >= tau - 1e-9) return q; return null; }
  if (kind === 'toe') { for (q = U.length - 1; q >= 0; q--) if (U[q].t <= tau + 1e-9) return q; return null; }
  var b = null, d = 1e9;
  for (q = 0; q < U.length; q++) if (Math.abs(U[q].t - tau) < d) { d = Math.abs(U[q].t - tau); b = q; }
  return b;
}
// distance in pictures from the pick to the nearest true event of the given leg(s) inside the clip
function err(sim, pick, kind, legs) {
  var U = uniq(sim.input), qp = -1, best = 1e9;
  for (var q = 0; q < U.length; q++) if (U[q].i === pick) qp = q;
  if (qp < 0) return null;
  var tEnd = U[U.length - 1].t;
  legs.forEach(function (leg) {
    var list = kind === 'strike' ? sim.truth.strikes[leg] : kind === 'load' ? sim.truth.loads[leg] : kind === 'toe' ? sim.truth.toes[leg] : sim.truth.mids[leg];
    list.forEach(function (tau) {
      if (tau < 0 || tau > tEnd) return;
      var qt = frameOf(U, tau, kind);
      if (qt != null) best = Math.min(best, Math.abs(qt - qp));
    });
  });
  return best;
}
// a pick is of the right leg when it is nearer a true event of that leg than of the other one
function checkSide(name, sim) {
  var out = G.detect(sim.input), ph = out.phases;
  var keys = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid'];
  keys.forEach(function (k) { ok(name + ': ' + k + ' picked', ph[k] != null, ph); });
  var spec = { l_foot: ['load', 0], r_foot: ['load', 1], l_toe: ['toe', 0], r_toe: ['toe', 1] };
  Object.keys(spec).forEach(function (k) {
    var e = err(sim, ph[k], spec[k][0], [spec[k][1]]), eo = err(sim, ph[k], spec[k][0], [1 - spec[k][1]]);
    ok(name + ': ' + k + ' within 1 frame of a true ' + (spec[k][1] ? 'right ' : 'left ') + spec[k][0], e != null && e <= 1, { pick: ph[k], err: e });
    ok(name + ': ' + k + ' is the anatomical ' + (spec[k][1] ? 'right' : 'left') + ' leg', e != null && eo != null && e < eo, { err: e, otherLegErr: eo });
  });
  checkLoadInStance(name, sim, out);
  var em = err(sim, ph.mid, 'mid', [0, 1]);
  ok(name + ': mid within 1 frame of a true mid-stance', em != null && em <= 1, { pick: ph.mid, err: em });
  noShared(name, ph, keys);
  noDupPick(name, sim, ph, keys);
  return out;
}
// Foot strike (load onset) lies between first contact and mid-stance: each foot-strike pick sits in
// the first half of a true stance of its leg (from its first-contact picture to its mid-stance
// picture), and so does every contact's load frame, which is never before its own strike frame.
function checkLoadInStance(name, sim, out) {
  var U = uniq(sim.input), tEnd = U[U.length - 1].t;
  function qOf(f) { for (var q = 0; q < U.length; q++) if (U[q].i === f) return q; return -1; }
  function inFirstHalf(f, legs) {
    var qp = qOf(f);
    return qp >= 0 && legs.some(function (leg) {
      return sim.truth.strikes[leg].some(function (s, k) {
        var tm = sim.truth.mids[leg][k];
        if (s < 0 || tm > tEnd) return false;
        var qa = frameOf(U, s, 'strike'), qm = frameOf(U, tm, 'mid');
        return qa != null && qm != null && qp >= qa && qp <= qm;
      });
    });
  }
  ['l_foot', 'r_foot'].forEach(function (k, leg) {
    ok(name + ': ' + k + ' lies between a true first contact and mid-stance of its leg', inFirstHalf(out.phases[k], [leg]), { pick: out.phases[k] });
  });
  var bad = out.contacts.filter(function (c) {
    if (c.strike == null) return c.load != null;
    if (c.load == null || c.load < c.strike) return true;
    return c.toeOff != null && c.load > c.strike + (c.toeOff - c.strike) / 2 + 1;
  });
  ok(name + ': every contact reports a load frame from its strike frame to its mid-stance', !bad.length, bad.slice(0, 4));
  // contacts[].strike stays first contact (the lab's event metrics compare it with first contact)
  var far = out.contacts.filter(function (c) {
    if (c.strike == null) return false;
    var e = err(sim, c.strike, 'strike', [c.leg === 'left' ? 0 : 1]);
    return e == null || e > 1;
  });
  ok(name + ': contacts[].strike within 1 frame of a true first contact', !far.length, far.slice(0, 4));
}
function checkFrontBack(name, sim) {
  var out = G.detect(sim.input), ph = out.phases;
  ok(name + ': l picked', ph.l != null, ph); ok(name + ': r picked', ph.r != null, ph);
  ['l', 'r'].forEach(function (k, leg) {
    var e = err(sim, ph[k], 'mid', [leg]), eo = err(sim, ph[k], 'mid', [1 - leg]);
    ok(name + ': ' + k + ' within 1 frame of a true ' + (leg ? 'right' : 'left') + ' mid-stance', e != null && e <= 1, { pick: ph[k], err: e });
    ok(name + ': ' + k + ' is the anatomical ' + (leg ? 'right' : 'left') + ' leg', e != null && eo != null && e < eo, { err: e, otherLegErr: eo });
  });
  noShared(name, ph, ['l', 'r']);
  noDupPick(name, sim, ph, ['l', 'r']);
  return out;
}
function noShared(name, ph, keys) {
  var seen = {}, dup = null;
  keys.forEach(function (k) { if (ph[k] != null) { if (seen[ph[k]] != null) dup = [seen[ph[k]], k]; seen[ph[k]] = k; } });
  ok(name + ': no two phases on one frame', dup == null, { phases: ph, shared: dup });
}
function noDupPick(name, sim, ph, keys) {
  var dupSet = {};
  sim.input.frames.forEach(function (f) { if (f.dup) dupSet[f.i] = true; });
  ok(name + ': no pick on a duplicate frame', keys.every(function (k) { return !dupSet[ph[k]]; }), ph);
}
function checkLegSwap(name, sim, out) {
  var ls = out.diag.legSwap;
  eq(name + ': legSwap has one entry per input frame', ls.length, sim.input.frames.length);
  var wrong = [];
  for (var k = 0; k < ls.length; k++) if (ls[k] !== sim.swapped[k]) wrong.push(k);
  ok(name + ': legSwap true exactly on the swapped frames', !wrong.length,
    { wrongAt: wrong.slice(0, 12), swapped: sim.swapped.reduce(function (a, s, k) { if (s) a.push(k); return a; }, []) });
}

// ── side views ────────────────────────────────────────────────────
[15, 30, 60].forEach(function (fps) {
  [1, -1].forEach(function (dir) {
    var face = dir > 0 ? 'right' : 'left';
    section('side, facing ' + face + ', ' + fps + ' fps', function () {
      var sim = runner({ view: 'side', facing: dir, fps: fps, dur: 3.0, seed: fps * 10 + (dir > 0 ? 1 : 2) });
      var out = checkSide('side ' + face + ' ' + fps, sim);
      eq('side ' + face + ' ' + fps + ': facing', out.diag.facing, face);
      checkLegSwap('side ' + face + ' ' + fps, sim, out);
      ok('side ' + face + ' ' + fps + ': every observed pick has a confidence',
        ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid'].every(function (k) { return typeof out.diag.confidence[k] === 'number'; }), out.diag.confidence);
    });
  });
});

section('side, overground pass (runner crosses the picture), 30 fps', function () {
  var sim = runner({ view: 'side', facing: -1, fps: 30, dur: 2.5, travel: 160, seed: 7 });
  checkSide('side travel', sim);
});

// MoveNet swaps the whole leg (hip, knee, ankle) for a few pictures around a foot strike, where
// the legs are far apart (a swap that starts or ends while the legs cross is ambiguous by nature).
[15, 30, 60].forEach(function (fps) {
  [1, -1].forEach(function (dir) {
    var face = dir > 0 ? 'right' : 'left';
    section('side, facing ' + face + ', ' + fps + ' fps, leg labels swapped for ~0.13 s', function () {
      // left strike of stride 2 at 0.2 + 1.44 = 1.64 s; legs well apart from 1.58 to 1.71 s
      var sim = runner({ view: 'side', facing: dir, fps: fps, dur: 3.0, swap: [1.58, 1.71], seed: 300 + fps + dir });
      var nsw = sim.swapped.filter(Boolean).length;
      ok('swap ' + face + ' ' + fps + ': the generator swapped some frames', nsw >= 2, nsw);
      var out = checkSide('swap ' + face + ' ' + fps, sim);
      checkLegSwap('swap ' + face + ' ' + fps, sim, out);
    });
  });
});

section('side, 30 fps, only the ankle labels swapped for ~0.13 s', function () {
  var sim = runner({ view: 'side', facing: 1, fps: 30, dur: 3.0, swap: [1.58, 1.71], swapWhat: 'ankle', seed: 41 });
  var out = checkSide('ankle swap', sim);
  checkLegSwap('ankle swap', sim, out);
});

// A rail or the near leg hides the far leg: MoveNet puts both legs' labels on the near leg for the
// whole clip. Leg identity is then unknowable; the detector must still pick every phase on distinct
// frames (the case behind the "two phases on one frame" guard).
section('side, far leg hidden (both leg labels on the near leg), 30 fps', function () {
  var sim = runner({ view: 'side', facing: 1, fps: 30, dur: 3.0, seed: 61 });
  sim.input.frames.forEach(function (f) { if (f.kps) [11, 13, 15].forEach(function (j) { f.kps[j + 1] = f.kps[j].slice(); }); });
  var out = G.detect(sim.input), ph = out.phases, keys = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid'];
  keys.forEach(function (k) { ok('hidden leg: ' + k + ' picked', ph[k] != null, ph); });
  noShared('hidden leg', ph, keys);
});

section('side, duplicate frames (every 3rd picture repeated), 60 fps container', function () {
  var sim = runner({ view: 'side', facing: -1, fps: 60, dur: 3.0, dupEvery: 3, swap: [1.58, 1.71], seed: 51 });
  var out = checkSide('dups', sim);
  checkLegSwap('dups', sim, out);
});

section('side, duplicate frames (every 2nd picture repeated: 15 fps content in 30 fps)', function () {
  var sim = runner({ view: 'side', facing: 1, fps: 30, dur: 3.0, dupEvery: 2, seed: 52 });
  checkSide('dups 2', sim);
});

[15, 30, 60].forEach(function (fps) {
  section('side, two strides only (' + fps + ' fps)', function () {
    var sim = runner({ view: 'side', facing: 1, fps: fps, dur: 1.6, t0: 0.12, seed: 60 + fps });
    checkSide('two strides ' + fps, sim);
  });
});

// ── front / back views ───────────────────────────────────────────
['front', 'back'].forEach(function (view) {
  [15, 30, 60].forEach(function (fps) {
    section(view + ', ' + fps + ' fps', function () {
      var sim = runner({ view: view, fps: fps, dur: 3.0, grow: view === 'front' ? 0.05 : -0.05, seed: (view === 'front' ? 700 : 800) + fps });
      var out = checkFrontBack(view + ' ' + fps, sim);
      checkLegSwap(view + ' ' + fps, sim, out);
      // the picks should come from the trunk-bob mid-stances, not the last-resort rule
      ok(view + ' ' + fps + ': mid-stances found from the trunk bob, picks carry a confidence',
        out.diag.mids > 0 && typeof out.diag.confidence.l === 'number' && typeof out.diag.confidence.r === 'number',
        { mids: out.diag.mids, confidence: out.diag.confidence });
    });
  });
  section(view + ', 30 fps, MoveNet mirrors the leg labels for ~0.2 s', function () {
    var sim = runner({ view: view, fps: 30, dur: 3.0, swap: [1.2, 1.4], seed: view === 'front' ? 901 : 902 });
    var out = checkFrontBack(view + ' mirrored', sim);
    checkLegSwap(view + ' mirrored', sim, out);
  });
  section(view + ', two strides only, 30 fps', function () {
    var sim = runner({ view: view, fps: 30, dur: 1.6, t0: 0.12, seed: view === 'front' ? 911 : 912 });
    checkFrontBack(view + ' two strides', sim);
  });
});

// ── degenerate input ─────────────────────────────────────────────
section('no pose at all', function () {
  var sim = runner({ view: 'side', facing: 1, fps: 30, dur: 1.0 });
  sim.input.frames.forEach(function (f) { f.kps = null; });
  var threw = null, out = null;
  try { out = G.detect(sim.input); } catch (e) { threw = e.message; }
  ok('no pose: does not throw', threw == null, threw);
  if (out) eq('no pose: legSwap length', out.diag.legSwap.length, sim.input.frames.length);
  var none = G.detect({ view: 'front', meta: { fps: 30, times: [], w: W, h: H }, frames: [], manifest: { view: 'front' } });
  ok('empty clip: phases null', none.phases.l === null && none.phases.r === null, none.phases);
});

console.log(checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
