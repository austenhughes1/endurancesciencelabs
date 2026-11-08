// ════════════════════════════════════════════════════════════════
// functions/garmin-series.test.js
//
// The series builder in functions/garmin-series.js: binning, units, laps,
// session values, the size fallback, re-binning and the summary/file merge.
// Pure: no Firebase, no FIT parser (garmin.test.js runs real FIT files).
// Run with plain node:
//
//   node functions/garmin-series.test.js
//
// All values are made up. Never put real athlete data here (AGENTS.md).
// ════════════════════════════════════════════════════════════════
'use strict';
var gs = require('./garmin-series');

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  var a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.log('  FAIL ' + label + ': got ' + a + ', want ' + b); }
}
function section(name, fn) {
  console.log(name);
  try { fn(); } catch (e) { failures++; checks++; console.log('  FAIL threw: ' + (e && e.stack || e)); }
}

var T0 = 1800000000000;
// A record t seconds after T0, as fit-file-parser's "list" mode gives it.
function rec(t, f) { return Object.assign({ timestamp: new Date(T0 + t * 1000) }, f || {}); }
function item(extra) {
  return Object.assign({ userId: 'g-1', activityId: 4242, activityType: 'RUNNING', activityName: 'Made-up run', deviceName: 'Test Watch' }, extra || {});
}
function copy(o, extra) { return Object.assign({}, o, extra); }

section('sportFor maps Garmin activity types', function () {
  eq('runs', ['RUNNING', 'TREADMILL_RUNNING', 'TRAIL_RUNNING', 'VIRTUAL_RUN', 'INDOOR_RUNNING'].map(gs.sportFor), ['running', 'running', 'running', 'running', 'running']);
  eq('rides', ['CYCLING', 'ROAD_BIKING', 'INDOOR_CYCLING', 'VIRTUAL_RIDE', 'MOUNTAIN_BIKING', 'GRAVEL_CYCLING'].map(gs.sportFor), ['cycling', 'cycling', 'cycling', 'cycling', 'cycling', 'cycling']);
  eq('swims', ['LAP_SWIMMING', 'OPEN_WATER_SWIMMING'].map(gs.sportFor), ['swimming', 'swimming']);
  eq('anything else, lowercased', [gs.sportFor('STRENGTH_TRAINING'), gs.sportFor('yoga')], ['strength_training', 'yoga']);
  eq('none', [gs.sportFor(''), gs.sportFor(undefined)], [null, null]);
});

section('seriesUids reads the comma-separated allow-list', function () {
  eq('unset', gs.seriesUids({}), []);
  eq('spaces and empties dropped', gs.seriesUids({ GARMIN_SERIES_UIDS: ' u-1 , ,u-2,' }), ['u-1', 'u-2']);
});

section('bins are the mean of the records in each 5 s window; altitude is the last value', function () {
  var records = [
    rec(0, { heart_rate: 140, power: 300, speed: 3.0, altitude: 1600.4 }),
    rec(1, { heart_rate: 142, power: 310, speed: 3.2, altitude: 1600.8 }),
    rec(4, { heart_rate: 150, power: 0, speed: 3.4, altitude: 1601.2 }),
    rec(5, { heart_rate: 151, speed: 3.5 }),
    rec(9.9, { heart_rate: 153, speed: 3.7, altitude: 1603 }),
  ];
  var d = gs.buildSeriesDoc(item(), { records: records, sessions: [], laps: [] });
  eq('step and n', [d.step, d.n], [5, 2]);
  eq('hr mean, rounded', d.series.hr, [144, 152]);
  eq('power mean; 0 W is a value', d.series.power, [203, null]);
  eq('speed m/s -> cm/s', d.series.speed, [320, 360]);
  eq('alt m -> dm, last value in the bin', d.series.alt, [16012, 16030]);
  eq('every field has n values', gs.FIELDS.every(function (f) { return d.series[f].length === 2; }), true);
  eq('starts at the first record', d.startTs, T0);
});

section('a bin with no records is null in every field; nothing is zero-filled', function () {
  var records = [rec(0, { heart_rate: 140, speed: 3 }), rec(3, { heart_rate: 140, speed: 3 }), rec(17, { heart_rate: 150, speed: 0 })];
  var d = gs.buildSeriesDoc(item(), { records: records });
  eq('n covers the last record', d.n, 4);
  eq('paused bins null in every field', [1, 2].every(function (k) { return gs.FIELDS.every(function (f) { return d.series[f][k] === null; }); }), true);
  eq('speed 0 after the pause is kept', d.series.speed, [300, null, null, 0]);
  eq('a field no record carries is null', d.series.gct, [null, null, null, null]);
});

section('n = whole bins from the first record to the last, the last record included', function () {
  eq('elapsed 10 s at 5 s -> 3 bins', gs.buildSeriesDoc(item(), { records: [rec(0, { heart_rate: 1 }), rec(10, { heart_rate: 2 })] }).n, 3);
  eq('elapsed 9 s -> 2 bins', gs.buildSeriesDoc(item(), { records: [rec(0, { heart_rate: 1 }), rec(9, { heart_rate: 2 })] }).n, 2);
  eq('one record -> 1 bin', gs.buildSeriesDoc(item(), { records: [rec(0, { heart_rate: 1 })] }).n, 1);
  var none = gs.buildSeriesDoc(item(), { records: [], sessions: [{ start_time: new Date(T0), total_timer_time: 60 }] });
  eq('no records -> n 0, empty arrays, start from the session', [none.n, none.series.hr, none.startTs], [0, [], T0]);
  var unsorted = gs.buildSeriesDoc(item(), { records: [rec(6, { heart_rate: 160 }), rec(0, { heart_rate: 120 }), rec(1, { heart_rate: 122 })] });
  eq('records out of order are sorted first', unsorted.series.hr, [121, 160]);
  eq('records without a timestamp are skipped', gs.buildSeriesDoc(item(), { records: [{ heart_rate: 99 }, rec(0, { heart_rate: 120 })] }).series.hr, [120]);
});

section('units: running dynamics and cadence', function () {
  var run = [
    rec(0, { cadence: 86, fractional_cadence: 0.5, stance_time: 245.0, vertical_oscillation: 85.0, step_length: 1200.0, stance_time_balance: 49.8 }),
    rec(1, { cadence: 88, fractional_cadence: 0, stance_time: 255.0, vertical_oscillation: 87.0, step_length: 1220.0, stance_time_balance: 50.2 }),
  ];
  var d = gs.buildSeriesDoc(item(), { records: run });
  eq('running cadence per leg + fraction, doubled', d.series.cadence, [175]);
  eq('gct ms', d.series.gct, [250]);
  eq('vo mm', d.series.vo, [86]);
  eq('step length mm', d.series.stepLen, [1210]);
  eq('gct balance percent x100', d.series.gctBalL, [5000]);
  var one = gs.buildSeriesDoc(item(), { records: [rec(0, { stance_time_balance: 51.12 })] });
  eq('51.12 % -> 5112', one.series.gctBalL, [5112]);
  var zeros = gs.buildSeriesDoc(item(), { records: [rec(0, { heart_rate: 0, stance_time: 0, vertical_oscillation: 0, step_length: 0, stance_time_balance: 0 })] });
  eq('0 = absent for hr and running dynamics', [zeros.series.hr, zeros.series.gct, zeros.series.vo, zeros.series.stepLen, zeros.series.gctBalL], [[null], [null], [null], [null], [null]]);

  var ride = gs.buildSeriesDoc(item({ activityType: 'ROAD_BIKING' }), { records: [rec(0, { cadence: 90, power: 250 }), rec(1, { cadence: 0, power: 0 })] });
  eq('cycling cadence rpm, not doubled; coasting 0 kept', [ride.sport, ride.series.cadence, ride.series.power], ['cycling', [45], [125]]);
  var enh = gs.buildSeriesDoc(item(), { records: [rec(0, { speed: 3.0, enhanced_speed: 3.123, altitude: 10, enhanced_altitude: 12.34 })] });
  eq('enhanced speed and altitude preferred', [enh.series.speed, enh.series.alt], [[312], [123]]);
  eq('negative altitude kept', gs.buildSeriesDoc(item(), { records: [rec(0, { altitude: -3.2 })] }).series.alt, [-32]);
});

section('identity, laps and session values', function () {
  var data = {
    records: [rec(0, { heart_rate: 140 }), rec(600, { heart_rate: 150 })],
    laps: [
      { start_time: new Date(T0), total_timer_time: 300.25, total_elapsed_time: 310, total_distance: 1000.04, avg_heart_rate: 141, avg_speed: 3.333, avg_power: 280 },
      { start_time: new Date(T0 + 300000), total_elapsed_time: 300, total_distance: 990, enhanced_avg_speed: 3.3 },
    ],
    sessions: [{
      sport: 'running', start_time: new Date(T0), total_timer_time: 600.5, total_distance: 1990.04,
      avg_heart_rate: 145, max_heart_rate: 160, avg_power: 290, normalized_power: 295, avg_speed: 3.3166,
      total_ascent: 12, total_descent: 11, avg_cadence: 86, avg_fractional_cadence: 0.5,
      avg_stance_time: 245.04, avg_vertical_oscillation: 85.04, avg_step_length: 1200.04, avg_vertical_ratio: 7.5,
      avg_stance_time_balance: 49.8, total_training_effect: 3.2, total_anaerobic_training_effect: 1.1,
      training_load_peak: 120.5 * 65536, intensity_factor: 0.85, threshold_power: 340, training_stress_score: 61.3,
    }],
  };
  var d = gs.buildSeriesDoc(item({ activityType: 'TREADMILL_RUNNING', deviceName: 'unknown' }), data);
  eq('identity', [d.activityId, d.sport, d.subType, d.title, d.deviceName], ['4242', 'running', 'treadmill_running', 'Made-up run', null]);
  eq('duration and distance from the session', [d.durSec, d.distM], [600.5, 1990]);
  eq('laps', d.laps, [
    { startSec: 0, durSec: 300.3, distM: 1000, avgHr: 141, avgSpeedCms: 333, avgPower: 280 },
    { startSec: 300, durSec: 300, distM: 990, avgHr: null, avgSpeedCms: 330, avgPower: null },
  ]);
  eq('session', d.session, {
    avgHr: 145, maxHr: 160, avgPower: 290, normPower: 295, avgSpeedCms: 332, totalAscentM: 12, totalDescentM: 11,
    avgCadence: 173, avgGct: 245, avgVo: 85, avgStepLen: 1200, avgVratio: 7.5, avgGctBalL: 49.8,
    aerobicTE: 3.2, anaerobicTE: 1.1, trainingLoad: 120.5, intensityFactor: 0.85, thresholdPower: 340, tss: 61.3,
  });
  eq('marked as from the file', d.fromFile, true);

  var bare = gs.buildSeriesDoc(item(), { records: [rec(0, { heart_rate: 140 })] });
  eq('no session: every session value null', Object.keys(bare.session).filter(function (k) { return bare.session[k] !== null; }), []);
  eq('no session: same keys as a full one', Object.keys(bare.session), Object.keys(d.session));
  eq('no session: no duration or distance', [bare.durSec, bare.distM, bare.laps], [null, null, []]);

  var multi = gs.buildSeriesDoc(item({ activityType: 'CYCLING' }), { records: [rec(0)], sessions: [{ sport: 'running', avg_heart_rate: 150 }, { sport: 'cycling', avg_heart_rate: 130, avg_cadence: 88 }] });
  eq("the session for the item's sport", [multi.session.avgHr, multi.session.avgCadence], [130, 88]);

  eq('no activity id -> null', gs.buildSeriesDoc(item({ activityId: undefined }), data), null);
  eq('no start anywhere -> null', gs.buildSeriesDoc(item({ startTimeInSeconds: undefined }), { records: [] }), null);
});

// Records every everyS seconds for hours, every field present.
function longActivity(hours, everyS) {
  var out = [];
  for (var t = 0; t <= hours * 3600; t += everyS) {
    out.push(rec(t, { heart_rate: 140 + (t % 7), power: 200 + (t % 50), speed: 3 + (t % 3) / 10, cadence: 85, altitude: 1600 + (t % 100) / 10,
      stance_time: 250, vertical_oscillation: 80, step_length: 1100, stance_time_balance: 50.1 }));
  }
  return out;
}

section('a doc that would be over ~800 KB is binned at 10 s, then 30 s, then keeps session and laps only', function () {
  var short = gs.buildSeriesDoc(item(), { records: longActivity(2, 5) });
  eq('2 h stays at 5 s', [short.step, short.n], [5, 1441]);
  eq('2 h well under the limit', gs.estimateBytes(short) < 150 * 1024, true);
  var sparse = gs.buildSeriesDoc(item(), { records: longActivity(50, 30) });
  eq('mostly empty bins are cheap: 50 h of 30 s records fits at 5 s', sparse.step, 5);

  var ultra = gs.buildSeriesDoc(item(), { records: longActivity(16, 5) });
  eq('16 h -> 10 s', [ultra.step, ultra.n], [10, 5761]);
  eq('and under the limit', gs.estimateBytes(ultra) <= gs.MAX_DOC_BYTES, true);

  var huge = gs.buildSeriesDoc(item(), { records: longActivity(50, 5) });
  eq('50 h -> 30 s', [huge.step, huge.n], [30, 6001]);

  var laps = [{ start_time: new Date(T0), total_timer_time: 3600 }];
  var tooBig = gs.buildSeriesDoc(item(), { records: longActivity(100, 30), laps: laps, sessions: [{ sport: 'running', avg_heart_rate: 140 }] });
  eq('100 h -> no series, flagged', [tooBig.series, tooBig.step, tooBig.n, tooBig.seriesOmitted], [null, null, 0, true]);
  eq('session and laps kept', [tooBig.session.avgHr, tooBig.laps.length], [140, 1]);

  var asked = gs.buildSeriesDoc(item(), { records: longActivity(1, 5) }, 10);
  eq('a coarser starting step is honoured', asked.step, 10);
});

section('rebin averages groups of bins; altitude takes the last value', function () {
  var s = { hr: [100, 110, null, 120, null, null, 130], alt: [10, 11, null, 13, null, null, 15], power: [null, null, null, null, null, null, null] };
  var r = gs.rebin(s, 5, 10, ['hr', 'alt', 'power']);
  eq('step and n', [r.step, r.n], [10, 4]);
  eq('means of non-null, rounded', r.series.hr, [105, 120, null, 130]);
  eq('alt last non-null', r.series.alt, [11, 13, null, 15]);
  eq('all-null stays null', r.series.power, [null, null, null, null]);
  eq('5 -> 30', gs.rebin({ hr: [1, 2, 3, 4, 5, 6, 7] }, 5, 30, ['hr']).series.hr, [4, 7]);
  eq('fields limit what is returned', Object.keys(gs.rebin(s, 5, 10, ['hr']).series), ['hr']);
  eq('unknown fields ignored', Object.keys(gs.rebin(s, 5, 10, ['hr', 'lat']).series), ['hr']);
  var same = gs.rebin(s, 10, 5, ['hr']);
  eq('a finer step returns the stored step', [same.step, same.series.hr], [10, s.hr]);
  eq('the stored arrays are not shared', same.series.hr !== s.hr, true);
  eq('all fields by default', Object.keys(gs.rebin({}, 5, 10).series), gs.FIELDS);
});

var SUMMARY = {
  userId: 'g-1', activityId: 4242, activityType: 'RUNNING', activityName: 'Made-up run', startTimeInSeconds: T0 / 1000,
  durationInSeconds: 2500, distanceInMeters: 8000, averageSpeedInMetersPerSecond: 3.2, averageHeartRateInBeatsPerMinute: 149,
  maxHeartRateInBeatsPerMinute: 170, averageRunCadenceInStepsPerMinute: 85, totalElevationGainInMeters: 40, totalElevationLossInMeters: 38,
  deviceName: 'Test Watch',
};
var FILE_DOC = gs.buildSeriesDoc(item(), {
  records: [rec(0, { heart_rate: 150 }), rec(5, { heart_rate: 152 })],
  sessions: [{ sport: 'running', start_time: new Date(T0), total_timer_time: 2400, total_distance: 8046.7, avg_heart_rate: 150, avg_stance_time: 245 }],
});

section('seriesFromSummary carries identity and the session values a summary has', function () {
  var s = gs.seriesFromSummary(SUMMARY);
  eq('identity and times', [s.activityId, s.sport, s.startTs, s.durSec, s.distM], ['4242', 'running', T0, 2500, 8000]);
  eq('session', s.session, { avgHr: 149, maxHr: 170, avgSpeedCms: 320, totalAscentM: 40, totalDescentM: 38, avgCadence: 170 });
  eq('no series', [s.series, s.step, s.n], [undefined, undefined, undefined]);
  eq('ride: no run cadence', gs.seriesFromSummary(copy(SUMMARY, { activityType: 'CYCLING' })).session.avgCadence, null);
  eq('no start -> null', gs.seriesFromSummary(copy(SUMMARY, { startTimeInSeconds: undefined })), null);
});

section('mergeSeries: a file replaces a summary; a summary only fills a file', function () {
  var sum = gs.seriesFromSummary(SUMMARY);
  var first = gs.mergeSeries(null, sum, false);
  eq('summary alone', [first.fromFile, first.durSec, first.session.avgHr], [false, 2500, 149]);

  var thenFile = gs.mergeSeries(first, FILE_DOC, true);
  eq("file's values win", [thenFile.durSec, thenFile.distM, thenFile.session.avgHr, thenFile.session.avgGct], [2400, 8046.7, 150, 245]);
  eq("summary's values the file lacks stay", [thenFile.session.maxHr, thenFile.session.totalAscentM], [170, 40]);
  eq('series from the file', [thenFile.step, thenFile.n, thenFile.series.hr], [5, 2, [150, 152]]);
  eq('marked', thenFile.fromFile, true);

  var fileFirst = gs.mergeSeries(null, FILE_DOC, true);
  var thenSummary = gs.mergeSeries(fileFirst, sum, false);
  eq('a later summary never overwrites the file', [thenSummary.durSec, thenSummary.distM, thenSummary.session.avgHr], [2400, 8046.7, 150]);
  eq('it fills what the file lacks', [thenSummary.session.maxHr, thenSummary.session.avgSpeedCms], [170, 320]);
  eq('series untouched', thenSummary.series, fileFirst.series);
  eq('still from the file', thenSummary.fromFile, true);

  var renamed = gs.mergeSeries(first, gs.seriesFromSummary(copy(SUMMARY, { activityName: 'Renamed', durationInSeconds: 2600 })), false);
  eq('a summary over a summary updates it', [renamed.title, renamed.durSec], ['Renamed', 2600]);
  var nameless = gs.mergeSeries(first, gs.buildSeriesDoc(item({ activityName: undefined }), { records: [rec(0)] }), true);
  eq('an empty title never replaces a stored one', nameless.title, 'Made-up run');
  eq('have is not changed', first.durSec, 2500);
});

console.log('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
if (failures) process.exit(1);
