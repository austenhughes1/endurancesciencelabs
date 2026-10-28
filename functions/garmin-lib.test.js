// ════════════════════════════════════════════════════════════════
// functions/garmin-lib.test.js
//
// Pins for the Garmin import helpers. Run with plain node:
//
//   node functions/garmin-lib.test.js
//
// All values are made up. Never put real athlete data here (AGENTS.md).
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var lib = require('./garmin-lib');

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  var ok = (typeof want === 'number' && typeof got === 'number') ? Math.abs(got - want) < 1e-9 : got === want;
  if (!ok) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function section(name, fn) { console.log(name); fn(); }

section('PKCE challenge matches the RFC 7636 test vector', function () {
  eq('vector', lib.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  var p = lib.pkcePair();
  eq('verifier length in 43..128', p.verifier.length >= 43 && p.verifier.length <= 128, true);
  eq('verifier charset', /^[A-Za-z0-9\-._~]+$/.test(p.verifier), true);
  eq('pair is consistent', lib.challengeFor(p.verifier), p.challenge);
});

section('runTypeFor keeps runs and names them like the other importers', function () {
  eq('RUNNING', lib.runTypeFor('RUNNING'), 'Running');
  eq('STREET_RUNNING', lib.runTypeFor('STREET_RUNNING'), 'Running');
  eq('TRAIL_RUNNING', lib.runTypeFor('TRAIL_RUNNING'), 'Trail Running');
  eq('TRACK_RUNNING', lib.runTypeFor('TRACK_RUNNING'), 'Track Running');
  eq('TREADMILL_RUNNING', lib.runTypeFor('TREADMILL_RUNNING'), 'Treadmill Running');
  eq('INDOOR_RUNNING', lib.runTypeFor('INDOOR_RUNNING'), 'Treadmill Running');
  eq('VIRTUAL_RUN', lib.runTypeFor('VIRTUAL_RUN'), 'Treadmill Running');
  eq('CYCLING dropped', lib.runTypeFor('CYCLING'), null);
  eq('missing dropped', lib.runTypeFor(undefined), null);
});

var SUMMARY = {
  userId: 'u-test', summaryId: 'S1', activityId: 111, activityName: 'Lever tempo',
  activityType: 'RUNNING', startTimeInSeconds: 1800000000, startTimeOffsetInSeconds: -21600,
  durationInSeconds: 2400, distanceInMeters: 8046.7, averageSpeedInMetersPerSecond: 3.3528,
  averageHeartRateInBeatsPerMinute: 150, maxHeartRateInBeatsPerMinute: 171,
  averageRunCadenceInStepsPerMinute: 86, steps: 7000,
  totalElevationGainInMeters: 40, totalElevationLossInMeters: 38, deviceName: 'Forerunner 965'
};

section('runDocFromSummary', function () {
  var d = lib.runDocFromSummary(SUMMARY);
  eq('id', d.id, 'garmin_111');
  eq('type', d.type, 'Running');
  eq('title', d.title, 'Lever tempo');
  eq('leverTitle', d.leverTitle, true);
  eq('ts', d.ts, 1800000000000);
  eq('distMi', d.distMi, 8046.7 / 1609.34);
  eq('durSec', d.durSec, 2400);
  eq('paceSec', d.paceSec, 1609.34 / 3.3528);
  eq('per-leg cadence doubled', d.cadence, 172);
  eq('ascent', d.ascentM, 40);
  eq('descent', d.descentM, 38);
  eq('no dynamics in summary', d.gct, null);
  eq('source', d.source, 'garmin');
  eq('garminActivityId', d.garminActivityId, '111');
  eq('deviceName', d.deviceName, 'Forerunner 965');
  eq('full spm not doubled', lib.runDocFromSummary(Object.assign({}, SUMMARY, { averageRunCadenceInStepsPerMinute: 170 })).cadence, 170);
  eq('unknown device -> null', lib.runDocFromSummary(Object.assign({}, SUMMARY, { deviceName: 'unknown' })).deviceName, null);
  eq('non-run -> null', lib.runDocFromSummary(Object.assign({}, SUMMARY, { activityType: 'CYCLING' })), null);
  eq('zero distance -> null distMi', lib.runDocFromSummary(Object.assign({}, SUMMARY, { distanceInMeters: 0 })).distMi, null);
});

// Keys exactly as fit-file-parser@3.0.2 names them on a session message
// (cadence is `avg_cadence`, the stride count is `total_cycles`), so these
// pins exercise the path every parsed file takes.
var SESSION = {
  start_time: new Date(1800000000000), sport: 'running', total_distance: 8046.7,
  avg_speed: 3.3528, enhanced_avg_speed: 3.3528,
  total_timer_time: 2400, avg_heart_rate: 150, max_heart_rate: 171, total_training_effect: 3.4,
  avg_cadence: 85, avg_fractional_cadence: 0.5, avg_vertical_oscillation: 82,
  avg_step_length: 1180, avg_vertical_ratio: 6.9, avg_stance_time: 238, avg_stance_time_balance: 49.6,
  total_ascent: 40, total_descent: 38, total_cycles: 3500
};
var FILE_ITEM = { userId: 'u-test', summaryId: '111-file', fileType: 'FIT', activityId: 111,
  activityType: 'RUNNING', activityName: 'Lever tempo', deviceName: 'Forerunner 965', startTimeInSeconds: 1800000000 };

section('dynamicsFromFitSession converts units', function () {
  var x = lib.dynamicsFromFitSession(SESSION);
  eq('cadence from parsed avg_cadence', x.cadence, 171);
  eq('no cadence -> null', lib.dynamicsFromFitSession(Object.assign({}, SESSION, { avg_cadence: undefined })).cadence, null);
  eq('parsed file has no step count (summary steps are kept)', x.steps, null);
  eq('stride m', x.stride, 1.18);
  eq('vo cm', x.vo, 8.2);
  eq('vratio', x.vratio, 6.9);
  eq('gct', x.gct, 238);
  eq('balance', x.gctBalL, 49.6);
  eq('aerobicTE', x.aerobicTE, 3.4);
  eq('zero GCT is absent', lib.dynamicsFromFitSession(Object.assign({}, SESSION, { avg_stance_time: 0 })).gct, null);
  eq('vratio derived', lib.dynamicsFromFitSession(Object.assign({}, SESSION, { avg_vertical_ratio: undefined })).vratio, 82 / 1180 * 100);
});

section('runDocFromFile builds a full doc', function () {
  var d = lib.runDocFromFile(FILE_ITEM, SESSION);
  eq('same id as summary', d.id, 'garmin_111');
  eq('gct', d.gct, 238);
  eq('cadence', d.cadence, 171);
  eq('distMi', d.distMi, 8046.7 / 1609.34);
  eq('paceSec from enhanced speed alone', lib.runDocFromFile(FILE_ITEM, Object.assign({}, SESSION, { avg_speed: undefined })).paceSec, 1609.34 / 3.3528);
  eq('non-run -> null', lib.runDocFromFile(Object.assign({}, FILE_ITEM, { activityType: 'CYCLING' }), SESSION), null);
});

section('definedOnly drops null/undefined so a late summary never erases FIT values', function () {
  var o = lib.definedOnly({ a: 1, b: null, c: undefined, d: 0, e: '' });
  eq('keys', Object.keys(o).join(','), 'a,d,e');
});

section('hasActivityExport', function () {
  eq('yes', lib.hasActivityExport({ permissions: ['HEALTH_EXPORT', 'ACTIVITY_EXPORT'] }), true);
  eq('no', lib.hasActivityExport({ permissions: ['HEALTH_EXPORT'] }), false);
  eq('bad', lib.hasActivityExport(null), false);
});

section('FIT conversions match the browser importer (runFromFitSession)', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'run-dynamics.js'), 'utf8');
  var n0 = src.indexOf('function norm('), n1 = src.indexOf('\n', n0);
  var a = src.indexOf('function fitNum('), b = src.indexOf('/* Parse one .fit ArrayBuffer');
  if (n0 < 0 || a < 0 || b < a) throw new Error('browser FIT helpers not found in run-dynamics.js');
  var browser = vm.runInNewContext(src.slice(n0, n1) + '\n' + src.slice(a, b) + '; ({ runFromFitSession: runFromFitSession })',
    { Math: Math, String: String, Date: Date, isFinite: isFinite, isNaN: isNaN });
  var want = browser.runFromFitSession(SESSION), got = lib.dynamicsFromFitSession(SESSION);
  eq('browser reads parsed cadence too', want.cadence, 171);
  ['aerobicTE', 'cadence', 'stride', 'vratio', 'vo', 'gct', 'gctBalL', 'ascentM', 'descentM', 'steps'].forEach(function (k) {
    eq(k, got[k], want[k]);
  });
});

console.log('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
if (failures) process.exit(1);
