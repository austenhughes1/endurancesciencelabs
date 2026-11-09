// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-garmin.test.js
//
// Pins for the Garmin credit line the Run Dynamics views show under their
// titles, and for how uploads and run notes treat runs Garmin Connect sent.
// Run with plain node:
//
//   node shared/run-dynamics-garmin.test.js
//
// The credit line lives in the view (run-dynamics.js, a browser IIFE), so it
// is lifted out of its source text. The run store lives in
// run-dynamics-data.js and runs against an in-memory Firestore. All runs are
// made up.
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

// Every credit slot sits over numbers derived in part from every stored run: Today, Load, Form and Injury
// Patterns show load-derived numbers, and the load baseline is calibrated from all runs, so each names Garmin
// as a source of the insight and still names the device. The Mark Lever runs dialog lists only treadmill runs,
// but each IAD in it is scored against that baseline, so an outdoor Garmin run alone still credits it. Data
// shows run counts and Lever counts; Settings shows the calibrated easy pace.
var MOUNTS = ['gcToday', 'gcLoad', 'gcForm', 'gcPat', 'gcLv', 'gcData', 'gcSet'];
section('renderGarminCredit: every section, the Lever dialog, Data and Settings name Garmin as a source', function () {
  var mounts = {};
  MOUNTS.forEach(function (id) { mounts[id] = { innerHTML: 'stale' }; });
  var ctx = { String: String,
    RAW: [{ source: 'garmin', deviceName: 'Forerunner 965', type: 'Running' }, { type: 'Treadmill Running' }],
    $: function (id) { return mounts[id] || null; } };
  vm.runInNewContext([lift('esc'), lift('garminLabel'), lift('garminCredit'), lift('renderGarminCredit')].join('\n') +
    '; renderGarminCredit();', ctx);
  var want = '<p class="rdx-garmin-credit">Insights derived in part from Garmin device-sourced data · Garmin Forerunner 965</p>';
  Object.keys(mounts).forEach(function (id) { eq(id, mounts[id].innerHTML, want); });
});

// Each credit slot is in the markup of the part it credits: the slot ids sit inside the function that builds it.
section('templates: each credit slot is built by the part it credits', function () {
  function inside(id, fn) {
    var a = src.indexOf('function ' + fn + '('), b = src.indexOf('\nfunction ', a + 1), m = src.indexOf('id="' + id + '"', a);
    return a >= 0 && m > a && m < b;
  }
  eq('gcToday in the shell (above Today)', inside('gcToday', 'shellHTML'), true);
  eq('gcPat in the shell (Injury Patterns header)', inside('gcPat', 'shellHTML'), true);
  eq('gcLoad in Load', inside('gcLoad', 'renderLoadSec'), true);
  eq('gcForm in Form', inside('gcForm', 'renderFormSec'), true);
  eq('gcLv in the Lever dialog', inside('gcLv', 'leverModalHTML'), true);
  eq('gcData in the Data sheet', inside('gcData', 'dataSheetHTML'), true);
  eq('gcSet in the Settings sheet', inside('gcSet', 'settingsSheetHTML'), true);
});

// ── Uploads and notes against Garmin runs, on an in-memory Firestore ──
function same(label, got, want) { eq(label, JSON.stringify(got), JSON.stringify(want)); }

// docs: full path -> data. Transactions apply their writes when the callback is done.
function fakeDb(docs) {
  function snap(path) {
    var d = docs.get(path);
    return { id: path.slice(path.lastIndexOf('/') + 1), exists: d !== undefined, ref: ref(path),
      data: function () { return d === undefined ? undefined : JSON.parse(JSON.stringify(d)); } };
  }
  function ref(path) {
    return { path: path, collection: function (n) { return col(path + '/' + n); },
      get: function () { return Promise.resolve(snap(path)); } };
  }
  function col(path) {
    return {
      doc: function (id) { return ref(path + '/' + id); },
      get: function () {
        var out = [];
        docs.forEach(function (d, p) { if (p.slice(0, p.lastIndexOf('/')) === path) out.push(snap(p)); });
        return Promise.resolve({ forEach: function (f) { out.forEach(f); } });
      },
    };
  }
  return {
    collection: col,
    batch: function () {
      var ops = [];
      return {
        set: function (r, d) { ops.push(function () { docs.set(r.path, JSON.parse(JSON.stringify(d))); }); },
        delete: function (r) { ops.push(function () { docs.delete(r.path); }); },
        commit: function () { ops.forEach(function (o) { o(); }); return Promise.resolve(); },
      };
    },
    runTransaction: function (fn) {
      var writes = [];
      var tx = {
        get: function (r) { return r.get(); },
        set: function (r, d, o) { writes.push(function () { docs.set(r.path, Object.assign({}, o && o.merge ? docs.get(r.path) : {}, JSON.parse(JSON.stringify(d)))); }); },
      };
      return Promise.resolve(fn(tx)).then(function (v) { writes.forEach(function (w) { w(); }); return v; });
    },
  };
}
// The run store (run-dynamics-data.js), opened for athlete u-a with profile, in a fresh context so
// each test starts with an empty write queue and cache.
function store(docs, profile) {
  var win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'run-dynamics-data.js'), 'utf8'), { window: win, console: { log: function () {}, warn: function () {}, error: function () {} } });   // failed writes log; keep the output clean
  var D = win.RunData, db = fakeDb(docs);
  D.open({ db: db, uid: 'u-a', notify: function () {} });
  D.S.profile = profile;
  return { DB: db, backfill: D.backfill, updateProfileList: D.updateProfileList, get STD_PROFILE() { return D.S.profile; } };
}
var ACT = 'users/u-a/garminActivities/';
var T = 1792500000000;   // made-up start time
function ids(docs) {
  var out = [];
  docs.forEach(function (d, p) { if (p.indexOf(ACT) === 0) out.push(p.slice(ACT.length)); });
  return out.sort();
}
function noteIds(list) { return (list || []).map(function (m) { return m.id; }); }

var asyncSections = [];
asyncSections.push(['an upload of a run Garmin Connect sent is stored, and the Garmin copy and its notes give way', async function () {
  var upload = { id: '20261020063000_running', type: 'Running', ts: T + 5000, durSec: 2395, distMi: 5, gct: 241 };
  var older = { id: '20261001070000_running', type: 'Running', ts: T - 19 * 864e5, durSec: 1800, distMi: 3 };
  var notes = {
    runLeverMarks: [{ id: 'garmin_77', lever: true, offload: 0.3, ts: T, mi: 5 }, { id: 'garmin_78', lever: false, ts: T + 864e5, mi: 4 }],
    runExcluded: [{ id: 'garmin_77', ts: T, at: T + 1000 }],
  };
  var docs = new Map([
    [ACT + 'garmin_77', { id: 'garmin_77', source: 'garmin', ts: T, durSec: 2400, distMi: 5, gct: 240 }],
    [ACT + 'garmin_78', { id: 'garmin_78', source: 'garmin', ts: T + 864e5, durSec: 2000, distMi: 4 }],   // the next day: not in the upload
    ['users/u-a', JSON.parse(JSON.stringify(notes))],
  ]);
  var ctx = store(docs, JSON.parse(JSON.stringify(notes)));
  var res = await ctx.backfill([upload, older]);
  same('both runs written as new', [res.added, res.dupes, res.updated], [2, 0, 0]);
  same('one Garmin copy replaced, no Strava run', [res.replacedGarmin, res.replaced], [1, 0]);
  same('stored runs', ids(docs), ['20261001070000_running', '20261020063000_running', 'garmin_78']);
  same('the upload as uploaded', docs.get(ACT + upload.id).gct, 241);
  same('Lever mark moved to the upload, the other Garmin run keeps its own', noteIds(docs.get('users/u-a').runLeverMarks), ['20261020063000_running', 'garmin_78']);
  same('exclusion moved to the upload', noteIds(docs.get('users/u-a').runExcluded), ['20261020063000_running']);
  same('mark keeps its offload', docs.get('users/u-a').runLeverMarks[0].offload, 0.3);
  same('the view has the moved notes too', noteIds(ctx.STD_PROFILE.runLeverMarks), ['20261020063000_running', 'garmin_78']);

  // A note already on the upload's run wins over the Garmin copy's.
  docs = new Map([
    [ACT + 'garmin_77', { id: 'garmin_77', source: 'garmin', ts: T, durSec: 2400 }],
    ['users/u-a', { runLeverMarks: [{ id: 'garmin_77', lever: true, offload: 0.3, ts: T }, { id: upload.id, lever: false, ts: T }] }],
  ]);
  ctx = store(docs, { runLeverMarks: [], runExcluded: [] });
  await ctx.backfill([upload]);
  same('the upload keeps its own mark', docs.get('users/u-a').runLeverMarks, [{ id: upload.id, lever: false, ts: T }]);

  // The same upload again: stored already, nothing replaced.
  res = await ctx.backfill([upload]);
  same('uploaded again: updated in place', [res.added, res.updated, res.replacedGarmin], [0, 1, 0]);

  // A watch upload of the same run still counts as stored (a different id scheme, same start).
  docs = new Map([[ACT + '20261020T123000Z', { id: '20261020T123000Z', ts: T, durSec: 2400 }], ['users/u-a', {}]]);
  ctx = store(docs, {});
  res = await ctx.backfill([upload]);
  same('own upload of the same run: a near-duplicate, as before', [res.added, res.dupes, ids(docs)], [0, 1, ['20261020T123000Z']]);
}]);

asyncSections.push(['Lever marks and exclusions on Garmin runs a disconnect deleted are not written back', async function () {
  var docs = new Map([
    [ACT + 'garmin_2', { id: 'garmin_2', source: 'garmin', ts: T }],
    ['users/u-a', { runLeverMarks: [{ id: 'garmin_1', lever: true, ts: T - 864e5 }], runDismissedDrops: [] }],
  ]);
  var ctx = store(docs, { runLeverMarks: [{ id: 'garmin_1', lever: true, ts: T - 864e5 }] });
  var renders = 0;
  var add = function (list) { return list.concat([{ id: 'garmin_2', lever: true, ts: T }, { id: 'garmin_3', lever: true, ts: T + 1 }, { id: 'own_9', lever: false, ts: T + 2 }]); };
  same('saved', await ctx.updateProfileList('runLeverMarks', add, function () { renders++; }, false), true);
  same('a mark on a deleted Garmin run is dropped; the rest stored', noteIds(docs.get('users/u-a').runLeverMarks), ['garmin_1', 'garmin_2', 'own_9']);
  same('the view drops it too', [noteIds(ctx.STD_PROFILE.runLeverMarks), renders], [['garmin_1', 'garmin_2', 'own_9'], 1]);

  await ctx.updateProfileList('runExcluded', function (list) { return list.concat([{ id: 'garmin_3', ts: T }, { id: 'garmin_2', ts: T }]); }, null, false);
  same('exclusions: only runs still stored', noteIds(docs.get('users/u-a').runExcluded), ['garmin_2']);

  await ctx.updateProfileList('runDismissedDrops', function (list) { return list.concat([{ id: 'garmin_3' }]); }, null, false);
  same('other lists are not run notes', noteIds(docs.get('users/u-a').runDismissedDrops), ['garmin_3']);
}]);

asyncSections.push(['list writes to one field run in order, merge other devices\' entries, and survive a failed write', async function () {
  var docs = new Map([['users/u-a', { runEvents: [{ id: 'x', type: 'race', ts: T - 864e5 }] }]]);
  var ctx = store(docs, { runEvents: [] });
  var renders = [];
  var add = function (id) { return function (list) { return list.concat([{ id: id, type: 'race', ts: T }]); }; };
  var p1 = ctx.updateProfileList('runEvents', add('a'), function () { renders.push('a'); }, false);
  var p2 = ctx.updateProfileList('runEvents', add('b'), function () { renders.push('b'); }, false);
  same('the view shows both at once', noteIds(ctx.STD_PROFILE.runEvents), ['a', 'b']);
  same('both saved', [await p1, await p2], [true, true]);
  same('stored in order, on top of the other device\'s entry', noteIds(docs.get('users/u-a').runEvents), ['x', 'a', 'b']);
  same('the view adopts the stored list once, from the newest write', [noteIds(ctx.STD_PROFILE.runEvents), renders], [['x', 'a', 'b'], ['b']]);

  var real = ctx.DB.runTransaction, calls = 0;
  ctx.DB.runTransaction = function (fn) { if (calls++ === 0) return Promise.reject({ code: 'unavailable' }); return real(fn); };
  var f1 = ctx.updateProfileList('runEvents', add('c'), null, false);
  var f2 = ctx.updateProfileList('runEvents', add('d'), null, false);
  same('a failed write reports, the next still runs', [await f1, await f2], ['unavailable', true]);
  same('stored: the write that went through', noteIds(docs.get('users/u-a').runEvents), ['x', 'a', 'b', 'd']);
}]);

(async function () {
  for (var i = 0; i < asyncSections.length; i++) {
    console.log(asyncSections[i][0]);
    try { await asyncSections[i][1](); } catch (e) { checks++; failures++; console.log('  FAIL threw: ' + (e && e.stack || e)); }
  }
  console.log(checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})();
