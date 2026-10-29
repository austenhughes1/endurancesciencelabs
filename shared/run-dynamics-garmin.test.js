// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-garmin.test.js
//
// Pins for the Garmin credit line the Run Dynamics views show under their
// titles, and for how uploads and run notes treat runs Garmin Connect sent.
// Run with plain node:
//
//   node shared/run-dynamics-garmin.test.js
//
// run-dynamics.js is a browser IIFE that exposes only window.RunDynamics, so
// the functions under test are lifted out of its source text and evaluated
// alone (the run store against an in-memory Firestore). All runs are made up.
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
// Data & settings shows run counts, the calibrated easy pace and Lever counts, so it is credited too.
var MOUNTS = ['gcHero', 'gcChart', 'gcPat', 'gcForm', 'gcLv', 'gcSet', 'gcInc', 'gcData'];
section('renderGarminCredit: every section, the Lever modal and Data & settings name Garmin as a source', function () {
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

// The panel's own credit sits above its first group; links open the panel straight at What's included
// and Import & data (openSettings scrolls past the panel's top), so those groups carry their own.
section('Data & settings template: credit mounts where each view of the panel opens', function () {
  function between(id, from, to) {
    var a = src.indexOf(from), b = src.indexOf(to, a), m = src.indexOf('id="' + id + '"', a);
    return a >= 0 && b > a && m > a && m < b;
  }
  MOUNTS.forEach(function (id) { eq(id + ' mount in the template', src.indexOf('id="' + id + '"') >= 0, true); });
  eq('gcSet atop the panel', between('gcSet', 'id="settingsPanel"', 'id="set-events"'), true);
  eq('gcInc in What’s included', between('gcInc', 'id="set-included"', 'id="set-data"'), true);
  eq('gcData in Import & data', between('gcData', 'id="set-data"', 'id="sec-empty"'), true);
});

// ── Uploads and notes against Garmin runs, on an in-memory Firestore ──
// backfill and updateProfileList span many lines, so these are lifted by matching braces.
function liftFn(name) {
  var at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' not found in run-dynamics.js');
  var depth = 0;
  for (var i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(name + ': unbalanced braces');
}
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
// The run-store code of run-dynamics.js, mounted for athlete u-a with profile.
function store(docs, profile) {
  var ctx = { DB: fakeDb(docs), UID: 'u-a', MOUNT: 1, LIST_Q: {}, STD_PROFILE: profile,
    toast: function () {}, profileBlocked: function () { return null; }, canonJSON: JSON.stringify };
  vm.runInNewContext([lift('actCol'), lift('sameRunSpan'), liftFn('backfill'), liftFn('moveRunNotes'),
    liftFn('updateProfileList'), liftFn('goneGarminRuns')].join('\n'), ctx);
  return ctx;
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

(async function () {
  for (var i = 0; i < asyncSections.length; i++) {
    console.log(asyncSections[i][0]);
    try { await asyncSections[i][1](); } catch (e) { checks++; failures++; console.log('  FAIL threw: ' + (e && e.stack || e)); }
  }
  console.log(checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})();
