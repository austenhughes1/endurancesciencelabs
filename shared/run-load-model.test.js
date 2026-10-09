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

console.log(checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
