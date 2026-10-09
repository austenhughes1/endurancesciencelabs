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

console.log(checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
