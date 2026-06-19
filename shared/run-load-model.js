// ════════════════════════════════════════════════════════════════
// shared/run-load-model.js
//
// Transparent mechanical-load model for the Run Dynamics tool.
// Per-run Impact Load (equivalent easy miles) + acute/chronic load
// tracking and ACWR, per the ESL Mechanical Load Management spec.
//
// Pure functions only — no DOM, no Firebase. Exposed as window.RunLoad
// so both the coaching dashboard tab and the standalone page can share
// one implementation (the rendering differs per page; the math does not).
//
// Every parameter is exposed and tunable — transparency is the product
// differentiator vs a black-box model. Modeled outputs are an
// individual-relative trend/estimate, NOT a measured force.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// Tunable defaults. basePaceSec / baseVO are normally overridden per
// athlete by calibrateBaseline() so a baseline easy mile scores ~1.0.
var DEFAULTS = {
  kPace:      1.5,   // pace (intensity) exponent
  kImpact:    1.0,   // per-step impact exponent — peak vGRF ∝ 1/duty factor (Morin 2005; Patoz 2023)
  useGrade:   false, // enable grade surcharge (needs ascent/descent metres)
  acuteN:     7,     // acute EWMA window (days)
  chronicN:   28,    // chronic EWMA window (days)
  refWeight:  1.0,   // reference weight; = athlete weight for clean eq-miles
  basePaceSec: 420,  // easy-run baseline pace (s/mi) — fallback
  baseDF:     42408  // easy-run baseline duty-factor proxy = cadence(spm) × GCT(ms) — fallback (~186×228)
};

function median(arr) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Per-athlete, per-device baseline from their easy-run history (pace at or
// slower than the easy/workout cutoff). Falls back to all runs, then to
// DEFAULTS, when there aren't enough easy runs. Normalising every factor to
// this baseline makes the model self-calibrating and cancels most of the
// cross-device absolute offset in VO/GCT.
function calibrateBaseline(runs, cutoffSec) {
  var easy = runs.filter(function (r) { return r.paceSec != null && r.paceSec >= cutoffSec; });
  var pool = easy.length >= 5 ? easy : runs;
  var basePace = median(pool.map(function (r) { return r.paceSec; }).filter(function (v) { return v != null; }));
  var baseDF   = median(pool.map(function (r) { return (r.cadence != null && r.gct != null) ? r.cadence * r.gct : null; }).filter(function (v) { return v != null; }));
  return {
    basePaceSec: basePace || DEFAULTS.basePaceSec,
    baseDF:      baseDF   || DEFAULTS.baseDF
  };
}

// Per-run Impact Load in equivalent easy miles. Null when distance/pace
// are missing (can't model). VO and grade degrade gracefully to 1.0.
function impactLoad(run, p) {
  p = p || DEFAULTS;
  if (run.distMi == null || run.paceSec == null) return null;
  var paceF = Math.pow(p.basePaceSec / run.paceSec, p.kPace);
  // Per-step impact from duty factor (cadence × GCT), normalized to the athlete's easy-run
  // baseline. Peak vGRF ∝ 1/duty factor (Morin 2005; Patoz 2023), so a lower duty factor —
  // shorter contact / more flight — loads each step harder ⇒ factor > 1. This is a load term,
  // NOT an injury predictor. Needs cadence + GCT; defaults to 1 on devices that don't report them.
  var dfF   = (run.cadence != null && run.gct != null)
    ? Math.pow(p.baseDF / (run.cadence * run.gct), p.kImpact) : 1;
  var wF    = (run.weight || p.refWeight) / p.refWeight;
  var il = run.distMi * paceF * dfF * wF;
  if (p.useGrade && run.distMi) {
    var distM = run.distMi * 1609.34;
    var g = 1 + 1.2 * ((run.descentM || 0) / distM) + 0.6 * ((run.ascentM || 0) / distM);
    il *= Math.min(g, 2.5);
  }
  return il;
}

// Collapse runs into a dense per-day Impact Load series (0 on rest days).
// Iterates by CALENDAR day (setDate), not a fixed 86,400,000 ms step — otherwise
// daylight-saving transitions drift the cursor off local-midnight day keys and
// inject spurious zero-load days for ~half of every year.
function dailyLoads(runs, p) {
  var byDay = {}, stamps = [];
  runs.forEach(function (r) {
    var il = impactLoad(r, p); if (il == null) return;
    var d = new Date(r.ts); d.setHours(0, 0, 0, 0);
    var k = d.getTime();
    byDay[k] = (byDay[k] || 0) + il;
    stamps.push(k);
  });
  if (!stamps.length) return [];
  var cur = new Date(Math.min.apply(null, stamps)); cur.setHours(0, 0, 0, 0);
  var end = Math.max.apply(null, stamps), out = [];
  while (cur.getTime() <= end) {
    out.push({ ts: cur.getTime(), load: byDay[cur.getTime()] || 0 });
    cur.setDate(cur.getDate() + 1);   // advance one calendar day (DST-safe)
    cur.setHours(0, 0, 0, 0);         // re-normalize to local midnight across DST flips
  }
  return out;
}

// ── Estimated ground-reaction force (Morin "sine" method) ──────────
// Peak vertical GRF from contact time + flight time. In body-weights it
// needs only cadence + GCT (mass cancels); Newtons needs body mass.
//   Fmax = (π/2) · mg · (step_time / contact_time)
// Validated field method (Morin et al. 2005); best for steady level
// running. Returns null when the inputs aren't present.
var GRAVITY = 9.80665;
function flightContact(run) {
  if (run.cadence == null || run.gct == null || run.cadence <= 0) return null;
  var step = 60 / run.cadence;     // seconds between consecutive footfalls
  var tc = run.gct / 1000;         // contact time (s)
  if (tc <= 0 || tc >= step) return null;
  return { step: step, tc: tc, tf: step - tc };
}
function vgrfBW(run) {              // peak vertical GRF in body-weights (no mass needed)
  var fc = flightContact(run);
  return fc ? (Math.PI / 2) * (fc.step / fc.tc) : null;
}
function vgrfN(run, weightKg) {     // peak vertical GRF in Newtons (needs body mass)
  if (!weightKg) return null;
  var bw = vgrfBW(run);
  return bw == null ? null : bw * weightKg * GRAVITY;
}

function ewma(series, N) {
  var lam = 2 / (N + 1), prev = series.length ? series[0].load : 0;
  return series.map(function (d) { prev = d.load * lam + prev * (1 - lam); return prev; });
}

// Full daily timeline: daily load, acute/chronic EWMAs, ACWR, and a flag.
function loadTimeline(runs, params) {
  var p = Object.assign({}, DEFAULTS, params || {});
  var series = dailyLoads(runs, p);
  var acute = ewma(series, p.acuteN), chronic = ewma(series, p.chronicN);
  return series.map(function (d, i) {
    var a = acute[i], c = chronic[i], r = c > 0 ? a / c : null;
    return {
      ts: d.ts, daily: d.load, acute: a, chronic: c, acwr: r,
      flag: c > 0 ? (r > 1.5 ? 'spike' : r < 0.8 ? 'low' : 'ok') : null
    };
  });
}

window.RunLoad = {
  DEFAULTS: DEFAULTS,
  GRAVITY: GRAVITY,
  median: median,
  calibrateBaseline: calibrateBaseline,
  impactLoad: impactLoad,
  vgrfBW: vgrfBW,
  vgrfN: vgrfN,
  dailyLoads: dailyLoads,
  ewma: ewma,
  loadTimeline: loadTimeline
};

})();
