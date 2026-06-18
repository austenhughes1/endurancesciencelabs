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
  kPace:      1.5,   // pace exponent (force rises faster than speed)
  mVO:        1.0,   // vertical-oscillation exponent
  useGrade:   false, // enable grade surcharge (needs ascent/descent metres)
  acuteN:     7,     // acute EWMA window (days)
  chronicN:   28,    // chronic EWMA window (days)
  refWeight:  1.0,   // reference weight; = athlete weight for clean eq-miles
  basePaceSec: 420,  // easy-run baseline pace (s/mi) — fallback
  baseVO:     6.9    // easy-run baseline vertical oscillation (cm) — fallback
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
  var baseVO   = median(pool.map(function (r) { return r.vo; }).filter(function (v) { return v != null; }));
  return {
    basePaceSec: basePace || DEFAULTS.basePaceSec,
    baseVO:      baseVO   || DEFAULTS.baseVO
  };
}

// Per-run Impact Load in equivalent easy miles. Null when distance/pace
// are missing (can't model). VO and grade degrade gracefully to 1.0.
function impactLoad(run, p) {
  p = p || DEFAULTS;
  if (run.distMi == null || run.paceSec == null) return null;
  var paceF = Math.pow(p.basePaceSec / run.paceSec, p.kPace);
  var voF   = run.vo != null ? Math.pow(run.vo / p.baseVO, p.mVO) : 1;
  var wF    = (run.weight || p.refWeight) / p.refWeight;
  var il = run.distMi * paceF * voF * wF;
  if (p.useGrade && run.distMi) {
    var distM = run.distMi * 1609.34;
    var g = 1 + 1.2 * ((run.descentM || 0) / distM) + 0.6 * ((run.ascentM || 0) / distM);
    il *= Math.min(g, 2.5);
  }
  return il;
}

// Collapse runs into a dense per-day Impact Load series (0 on rest days).
function dailyLoads(runs, p) {
  var byDay = {};
  runs.forEach(function (r) {
    var il = impactLoad(r, p); if (il == null) return;
    var d = new Date(r.ts); d.setHours(0, 0, 0, 0);
    var k = d.getTime();
    byDay[k] = (byDay[k] || 0) + il;
  });
  var keys = Object.keys(byDay).map(Number);
  if (!keys.length) return [];
  var start = Math.min.apply(null, keys), end = Math.max.apply(null, keys), DAY = 86400000, out = [];
  for (var t = start; t <= end; t += DAY) out.push({ ts: t, load: byDay[t] || 0 });
  return out;
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
  median: median,
  calibrateBaseline: calibrateBaseline,
  impactLoad: impactLoad,
  dailyLoads: dailyLoads,
  ewma: ewma,
  loadTimeline: loadTimeline
};

})();
