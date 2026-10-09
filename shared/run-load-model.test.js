// ════════════════════════════════════════════════════════════════
// shared/run-load-model.test.js
//
// Acceptance pins for the Impact Load model. Run with plain node:
//
//   node shared/run-load-model.test.js
//
// run-load-model.js is a browser IIFE that attaches to window.RunLoad, so it
// is evaluated here inside a fake `window`. Every number below is an agreed
// behaviour shared with the Lever IQ port of this model (lever-iq
// lib/features/impact_load/domain/impact_load_model.dart and its tests); if
// one of these changes, change the other port too.
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'run-load-model.js'), 'utf8'),
  { window: win, Number: Number, Math: Math, Date: Date, Set: Set, Object: Object, Array: Array, String: String, console: console });
var RL = win.RunLoad;

// functions/index.js boots firebase-admin at require time, so stravaRunDoc (the Strava
// SummaryActivity → run-doc mapper) is lifted out of its source text and evaluated alone.
// Testing THROUGH the mapper matters: Lever IQ's first treadmill test passed while its mapper
// was broken because the test hand-built a 'Treadmill Running' record instead.
var fnSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
var fnStart = fnSrc.indexOf('function stravaRunDoc(act) {');
var fnEnd = fnSrc.indexOf('\n}\n', fnStart) + 2;
var stravaRunDoc = vm.runInNewContext(fnSrc.slice(fnStart, fnEnd) + '; stravaRunDoc', { Date: Date, String: String, isFinite: isFinite, Math: Math });

var failures = 0, checks = 0;
function close(label, got, want, tol) {
  checks++;
  var ok = typeof got === 'number' && Math.abs(got - want) <= (tol == null ? 1e-3 : tol);
  if (!ok) { failures++; console.log('  FAIL ' + label + ': got ' + got + ', want ' + want); }
}
function eq(label, got, want) {
  checks++;
  if (got !== want) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function section(name, fn) { console.log(name); fn(); }

// Flat outdoor run, no dynamics, no offload, scored against a 9:00/mi baseline.
var P = Object.assign({}, RL.DEFAULTS, { basePaceSec: 540, baseDF: 42408, useGrade: true, offload: 0.15 });
function run(o) { return Object.assign({ distMi: 10, paceSec: 540, type: 'Running' }, o); }
function il(o, p) { return RL.impactLoad(run(o), p || P); }

section('§1 pace exponent kPace = 0.5', function () {
  eq('DEFAULTS.kPace', RL.DEFAULTS.kPace, 0.5);
  close('(420/360)^0.5', Math.pow(420 / 360, RL.DEFAULTS.kPace), 1.0801, 1e-4);
  close('10 mi @ 8:00 vs 9:00', il({ paceSec: 480 }), 10.61, 5e-3);
  close('10 mi @ 7:00 vs 9:00', il({ paceSec: 420 }), 11.34, 5e-3);
  close('10 mi @ 6:00 vs 9:00', il({ paceSec: 360 }), 12.25, 5e-3);
  close('10 mi @ 5:00 vs 9:00', il({ paceSec: 300 }), 13.42, 5e-3);
  close('easy pace floors at distance', il({ paceSec: 600 }), 10, 1e-9);
});

section('§2 offload: kOffload 0.85, scored at belt pace', function () {
  eq('DEFAULTS.kOffload', RL.DEFAULTS.kOffload, 0.85);
  eq('offloadPaceK removed', RL.DEFAULTS.offloadPaceK, undefined);
  close('easy 10 mi @ 15% offload', il({ offload: 0.15 }), 8.725, 1e-9);
  close('easy 10 mi @ 20% offload', il({ offload: 0.20 }), 8.30, 1e-9);
  close('easy 10 mi @ 30% offload', il({ offload: 0.30 }), 7.45, 1e-9);
  close('clamp: offload 0.99 → 1 − 0.85×0.95', RL.offloadFactor(0.99), 0.1925, 1e-12);
  close('negative offload → 1', RL.offloadFactor(-0.3), 1, 0);
  close('offloadFactor(0.2)', RL.offloadFactor(0.2), 0.83, 1e-12);
  close('impactPerMileAtLoad(100)', RL.impactPerMileAtLoad(100), 1, 0);
  close('impactPerMileAtLoad(85)', RL.impactPerMileAtLoad(85), 0.8725, 1e-12);
  close('impactPerMileAtLoad(80)', RL.impactPerMileAtLoad(80), 0.83, 1e-12);
  close('impactPerMileAtLoad(55)', RL.impactPerMileAtLoad(55), 0.6175, 1e-12);
  // A Lever run at the baseline pace scores exactly dist × (1 − 0.85·O): no road-equivalent pace
  // conversion, so the pace term is neutral and the floor holds.
  close('lever run at baseline pace = dist × (1 − 0.85·O)', il({ lever: true, distMi: 4 }), 4 * (1 - 0.85 * 0.15), 1e-12);
  close('lever run per-run offload wins over profile', il({ lever: true, offload: 0.3, distMi: 4 }), 4 * (1 - 0.85 * 0.3), 1e-12);
  // A fast Lever run is priced as fast: belt pace, not a slower road-equivalent.
  close('fast lever run = dist × factor × (P0/P)^0.5', il({ offload: 0.2, distMi: 4, paceSec: 500 }), 4 * 0.83 * Math.pow(540 / 500, 0.5), 1e-12);
  // A prescribed Lever distance earns back its own budget.
  var hi = 6.2, miles = hi / RL.impactPerMileAtLoad(85);
  close('hi / impactPerMileAtLoad(85) = hi / 0.8725', miles, hi / 0.8725, 1e-12);
  close('…and running it scores hi', il({ distMi: miles, offload: 0.15 }), hi, 1e-9);
});

section('§3 grade: indoor exclusion, read-time descent mirroring, useGrade default', function () {
  eq('DEFAULTS.useGrade', RL.DEFAULTS.useGrade, true);
  // ESL's own target: 100–300 ft flat, 500 a nudge, 1000 a clear bump — only holds when BOTH
  // directions count, which is the evidence for mirroring an absent outdoor descent.
  [[100, 0.2], [300, 1.4], [500, 4.0], [1000, 15.8]].forEach(function (c) {
    var m = c[0] * 0.3048;
    close('10 mi, ascent = descent = ' + c[0] + ' ft → +' + c[1] + '%', (il({ ascentM: m, descentM: m }) / 10 - 1) * 100, c[1], 0.06);
  });
  close('outdoor, ascent 300 / descent absent == ascent 300 / descent 300',
    il({ ascentM: 300 }), il({ ascentM: 300, descentM: 300 }), 1e-12);
  close('treadmill, ascent 300, no descent → exactly dist', il({ type: 'Treadmill Running', ascentM: 300 }), 10, 1e-12);
  close('treadmill, ascent 300, stored descent 300 → exactly dist', il({ type: 'Treadmill Running', ascentM: 300, descentM: 300 }), 10, 1e-12);
  ['Virtual Run', 'Indoor Running'].forEach(function (t) {
    close(t + ' is indoor too', il({ type: t, ascentM: 300, descentM: 300 }), 10, 1e-12);
  });
  var ascentOnly = 10 * (1 + 110 * Math.pow(300 / 16093.4, 2));
  close('recorded descent 0 + ascent 300 → ascent term only', il({ ascentM: 300, descentM: 0 }), ascentOnly, 1e-9);
  close('negative elevation totals are treated as 0', il({ ascentM: -50, descentM: -50 }), 10, 1e-12);

  // elevation(): the read-time rule.
  eq('outdoor absent descent mirrors', JSON.stringify(RL.elevation({ ascentM: 120 })), JSON.stringify({ ascent: 120, descent: 120 }));
  eq('recorded 0 wins', JSON.stringify(RL.elevation({ ascentM: 120, descentM: 0 })), JSON.stringify({ ascent: 120, descent: 0 }));
  eq('indoor never mirrors', JSON.stringify(RL.elevation({ type: 'Treadmill Running', ascentM: 120 })), JSON.stringify({ ascent: 120, descent: 0 }));
  eq('a Strava doc\'s stored descent is never a measurement (outdoor → mirror)',
    JSON.stringify(RL.elevation({ source: 'strava', ascentM: 120, descentM: 120 })), JSON.stringify({ ascent: 120, descent: 120 }));
  eq('a Strava doc\'s stored descent is never a measurement (indoor → 0)',
    JSON.stringify(RL.elevation({ source: 'strava', type: 'Treadmill Running', ascentM: 120, descentM: 120 })), JSON.stringify({ ascent: 120, descent: 0 }));

  // The mirror feeds calibration too: a hilly loop with no recorded descent gets the same
  // GAP adjustment as one with descent recorded equal to ascent.
  var hilly = run({ ascentM: 300, paceSec: 600 });
  close('calibPace mirrors an absent outdoor descent', RL.calibPace(hilly, P), RL.calibPace(run({ ascentM: 300, descentM: 300, paceSec: 600 }), P), 1e-12);
  close('calibPace: treadmill incline still slows the pace (ascent only)', RL.calibPace(run({ type: 'Treadmill Running', ascentM: 300, paceSec: 600 }), P),
    600 / (1 + 3.5 * 300 / 16093.4), 1e-9);
  close('meanTotalGrade mirrors', RL.meanTotalGrade(hilly), 600 / 16093.4, 1e-12);
  close('meanTotalGrade indoor = ascent only', RL.meanTotalGrade(run({ type: 'Treadmill Running', ascentM: 300 })), 300 / 16093.4, 1e-12);

  // Through the real mapper with API-shaped payloads.
  var base = { id: 1, name: 'Lunch Run', start_date: '2026-09-01T12:00:00Z', start_date_local: '2026-09-01T06:00:00Z',
    distance: 16093.4, moving_time: 5400, total_elevation_gain: 304.8, average_cadence: 85 };
  var tm = stravaRunDoc(Object.assign({}, base, { sport_type: 'Run', trainer: true }));
  eq('mapper: trainer → Treadmill Running', tm.type, 'Treadmill Running');
  eq('mapper: descentM written as null', tm.descentM, null);
  eq('mapper: source strava', tm.source, 'strava');
  close('mapper: treadmill with 1000 ft incline scores exactly dist', RL.impactLoad(tm, P), 10, 1e-12);
  var vr = stravaRunDoc(Object.assign({}, base, { sport_type: 'VirtualRun' }));
  close('mapper: VirtualRun scores exactly dist', RL.impactLoad(vr, P), 10, 1e-12);
  var out = stravaRunDoc(Object.assign({}, base, { sport_type: 'Run' }));
  eq('mapper: outdoor → Running', out.type, 'Running');
  close('mapper: outdoor 10 mi / 1000 ft mirrors → +15.8%', RL.impactLoad(out, P), 11.578, 2e-3);
  var legacy = Object.assign({}, out, { descentM: 304.8 });   // an older sync that wrote the mirror
  close('legacy Strava doc with mirrored descentM scores the same as a fresh one', RL.impactLoad(legacy, P), RL.impactLoad(out, P), 1e-12);
  var legacyTm = Object.assign({}, tm, { descentM: 304.8 });
  close('legacy Strava treadmill doc with mirrored descentM is no longer surcharged', RL.impactLoad(legacyTm, P), 10, 1e-12);
});

console.log(checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
