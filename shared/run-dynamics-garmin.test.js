// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-garmin.test.js
//
// Pins for the Garmin credit line the Run Dynamics views show under their
// titles. Run with plain node:
//
//   node shared/run-dynamics-garmin.test.js
//
// run-dynamics.js is a browser IIFE that exposes only window.RunDynamics, so
// esc, garminLabel and garminCredit (one line each) are lifted out of its
// source text and evaluated alone.
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var src = fs.readFileSync(path.join(__dirname, 'run-dynamics.js'), 'utf8');
function lift(name) {
  var a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error(name + ' not found in run-dynamics.js');
  return src.slice(a, src.indexOf('\n', a));
}
var lib = vm.runInNewContext([lift('esc'), lift('garminLabel'), lift('garminCredit')].join('\n') +
  '; ({ garminLabel: garminLabel, garminCredit: garminCredit })', { String: String });

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  if (got !== want) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function section(name, fn) { console.log(name); fn(); }

section('garminLabel names the device once, or just Garmin', function () {
  eq('model', lib.garminLabel('Forerunner 965'), 'Garmin Forerunner 965');
  eq('no double Garmin', lib.garminLabel('Garmin fenix 8'), 'Garmin fenix 8');
  eq('no double Garmin, any case', lib.garminLabel('GARMIN fenix 8'), 'Garmin fenix 8');
  eq('bare Garmin', lib.garminLabel('Garmin'), 'Garmin');
  eq('padded', lib.garminLabel('  Forerunner 265  '), 'Garmin Forerunner 265');
  eq('unknown', lib.garminLabel('unknown'), 'Garmin');
  eq('Unknown', lib.garminLabel('Unknown'), 'Garmin');
  eq('missing', lib.garminLabel(null), 'Garmin');
  eq('undefined', lib.garminLabel(undefined), 'Garmin');
  eq('blank', lib.garminLabel('   '), 'Garmin');
});

section('garminCredit: empty without Garmin runs', function () {
  eq('strava only', lib.garminCredit([{ source: 'strava' }], false), '');
  eq('device import', lib.garminCredit([{ type: 'Running' }], true), '');
  eq('no runs', lib.garminCredit([], true), '');
  eq('null list', lib.garminCredit(null, false), '');
  eq('holes in the list', lib.garminCredit([null, undefined], false), '');
});

section('garminCredit: direct and derived lines', function () {
  eq('direct, one device once',
    lib.garminCredit([{ source: 'garmin', deviceName: 'Forerunner 965' }, { source: 'garmin', deviceName: 'Forerunner 965' }], false),
    '<p class="rdx-garmin-credit">Garmin Forerunner 965</p>');
  eq('derived, two devices in first-seen order',
    lib.garminCredit([{ source: 'garmin', deviceName: 'Forerunner 965' }, { source: 'strava' }, { source: 'garmin', deviceName: 'fenix 8' }], true),
    '<p class="rdx-garmin-credit">Insights derived in part from Garmin device-sourced data · Garmin Forerunner 965, Garmin fenix 8</p>');
  eq('unknown model reads Garmin',
    lib.garminCredit([{ source: 'garmin' }], false),
    '<p class="rdx-garmin-credit">Garmin</p>');
  eq('unknown and named models both listed',
    lib.garminCredit([{ source: 'garmin', deviceName: null }, { source: 'garmin', deviceName: 'Edge 840' }], false),
    '<p class="rdx-garmin-credit">Garmin, Garmin Edge 840</p>');
  eq('device names are escaped',
    lib.garminCredit([{ source: 'garmin', deviceName: '<img src=x onerror=alert(1)>' }], false),
    '<p class="rdx-garmin-credit">Garmin &lt;img src=x onerror=alert(1)&gt;</p>');
});

// Every section credit sits over load-derived numbers (Form & volume's metric table has Impact Load
// and estimated forces), so each one names Garmin as a source of the insight and still names the device.
// The Mark Lever runs modal lists only treadmill runs, but each IAD in it is scored against a baseline
// calibrated from every run, so an outdoor Garmin run alone still credits the modal.
section('renderGarminCredit: every section and the Lever modal name Garmin as a source', function () {
  var mounts = {};
  ['gcHero', 'gcChart', 'gcPat', 'gcForm', 'gcLv'].forEach(function (id) { mounts[id] = { innerHTML: 'stale' }; });
  var ctx = { String: String,
    RAW: [{ source: 'garmin', deviceName: 'Forerunner 965', type: 'Running' }, { type: 'Treadmill Running' }],
    $: function (id) { return mounts[id] || null; } };
  vm.runInNewContext([lift('esc'), lift('garminLabel'), lift('garminCredit'), lift('renderGarminCredit')].join('\n') +
    '; renderGarminCredit();', ctx);
  var want = '<p class="rdx-garmin-credit">Insights derived in part from Garmin device-sourced data · Garmin Forerunner 965</p>';
  Object.keys(mounts).forEach(function (id) { eq(id, mounts[id].innerHTML, want); });
});

console.log(checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
if (failures) process.exit(1);
