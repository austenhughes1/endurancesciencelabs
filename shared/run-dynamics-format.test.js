// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-format.test.js
//
// Pins for the Run Dynamics pace and duration formatters. Run with plain node:
//
//   node shared/run-dynamics-format.test.js
//
// run-dynamics.js is a browser IIFE that exposes only window.RunDynamics, so
// fmtPace and fmtDur are lifted out of its source text and evaluated alone.
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var src = fs.readFileSync(path.join(__dirname, 'run-dynamics.js'), 'utf8');
var start = src.indexOf('function fmtPace(');
var durStart = src.indexOf('function fmtDur(');
if (start < 0 || durStart < start) throw new Error('fmtPace/fmtDur not found in run-dynamics.js');
var end = src.indexOf('\n', durStart);
var lib = vm.runInNewContext(src.slice(start, end) + '; ({ fmtPace: fmtPace, fmtDur: fmtDur })', { Math: Math, String: String });

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  if (got !== want) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function section(name, fn) { console.log(name); fn(); }

section('fmtPace rounds to whole seconds before splitting', function () {
  eq('479.6', lib.fmtPace(479.6), '8:00');
  eq('479.4', lib.fmtPace(479.4), '7:59');
  eq('59.7', lib.fmtPace(59.7), '1:00');
  eq('419.5 rounds up', lib.fmtPace(419.5), '7:00');
  eq('null', lib.fmtPace(null), '–');
  eq('undefined', lib.fmtPace(undefined), '–');
  eq('425 pads seconds', lib.fmtPace(425), '7:05');
  eq('540', lib.fmtPace(540), '9:00');
  eq('0', lib.fmtPace(0), '0:00');
});

section('fmtDur rounds to whole minutes before splitting', function () {
  eq('3599', lib.fmtDur(3599), '1h 0m');
  eq('7170', lib.fmtDur(7170), '2h 0m');
  eq('3569', lib.fmtDur(3569), '59m');
  eq('3600', lib.fmtDur(3600), '1h 0m');
  eq('3660', lib.fmtDur(3660), '1h 1m');
  eq('5400', lib.fmtDur(5400), '1h 30m');
  eq('90', lib.fmtDur(90), '2m');
  eq('0', lib.fmtDur(0), '0m');
});

console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
