// ════════════════════════════════════════════════════════════════
// functions/es-mcp.test.js
//
// The esMcp read path in functions/es-mcp.js: the key check, the account it
// serves, the four tools over an in-memory Firestore, and (when the MCP SDK is
// installed in functions/) a full MCP handshake over a loopback HTTP server.
// Nothing leaves this machine. Run with plain node:
//
//   node functions/es-mcp.test.js
//
// All ids and values are made up. Never put real athlete data here (AGENTS.md).
// ════════════════════════════════════════════════════════════════
'use strict';
var Module = require('module');
var http = require('http');

// ── In-memory Firestore: doc get, where, select (a real projection) ──
var store = new Map();
function Timestamp(ms) { this.ms = ms; }
Timestamp.prototype.toMillis = function () { return this.ms; };

function field(d, f) { return f.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, d); }
function project(d, fields) {
  if (!fields) return d;
  var out = {};
  fields.forEach(function (f) {
    var v = field(d, f);
    if (v === undefined) return;
    var parts = f.split('.'), o = out;
    parts.slice(0, -1).forEach(function (k) { o = o[k] = o[k] || {}; });
    o[parts[parts.length - 1]] = v;
  });
  return out;
}
function Snap(id, data) { this.id = id; this.exists = data !== undefined; this._d = data; }
Snap.prototype.data = function () { return this.exists ? JSON.parse(JSON.stringify(this._d), revive) : undefined; };
function revive(k, v) { return v && v.__ts != null ? new Timestamp(v.__ts) : v; }
function DocRef(p) { this.path = p; this.id = p.slice(p.lastIndexOf('/') + 1); }
DocRef.prototype.collection = function (n) { return new Query(this.path + '/' + n, [], null); };
DocRef.prototype.get = function () { reads.push(this.path); return Promise.resolve(new Snap(this.id, store.get(this.path))); };
function Query(coll, filters, fields) { this.coll = coll; this.filters = filters; this.fields = fields; }
Query.prototype.doc = function (id) { return new DocRef(this.coll + '/' + id); };
Query.prototype.where = function (f, op, v) { return new Query(this.coll, this.filters.concat([[f, op, v]]), this.fields); };
Query.prototype.select = function () { return new Query(this.coll, this.filters, Array.prototype.slice.call(arguments)); };
Query.prototype.get = function () {
  var self = this, docs = [];
  reads.push(this.coll + (this.fields ? ' select ' + this.fields.join(',') : ''));
  store.forEach(function (d, p) {
    if (p.slice(0, p.lastIndexOf('/')) !== self.coll) return;
    var ok = self.filters.every(function (w) {
      var x = field(d, w[0]);
      if (x == null) return false;
      return w[1] === '>=' ? x >= w[2] : w[1] === '<' ? x < w[2] : w[1] === '==' ? x === w[2] : false;
    });
    if (ok) docs.push(new Snap(p.slice(p.lastIndexOf('/') + 1), project(d, self.fields)));
  });
  return Promise.resolve({ docs: docs, size: docs.length, empty: !docs.length });
};
var reads = [];
var db = { collection: function (n) { return new Query(n, [], null); } };

var requestOpts = null;
var fakes = {
  'firebase-admin': { firestore: function () { return db; } },
  'firebase-functions/v2/https': { onRequest: function (opts, fn) { requestOpts = opts; return fn; } },
};
var realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
  return realLoad.apply(this, arguments);
};
var mcp = require('./es-mcp');
Module._load = realLoad;

var KEY = 'k'.repeat(16) + '-test-key-made-up-0123';
process.env.ES_MCP_KEY = KEY;
process.env.GARMIN_SERIES_UIDS = 'u-s, u-x';

var quiet = console.error, logged = [];
console.error = function () { logged.push(Array.prototype.join.call(arguments, ' ')); };

// ── Harness ──────────────────────────────────────────────────────
var failures = 0, checks = 0, sections = [];
function eq(label, got, want) {
  checks++;
  var a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.log('  FAIL ' + label + ': got ' + a + ', want ' + b); }
}
function section(name, fn) { sections.push([name, fn]); }
var hasSdk = (function () {
  try { require.resolve('@modelcontextprotocol/sdk/server/mcp.js', { paths: [__dirname] }); require.resolve('zod', { paths: [__dirname] }); return true; } catch (e) { return false; }
})();
function sdkSection(name, fn) {
  if (hasSdk) section(name, fn);
  else section(name + ' -- SKIPPED: run npm install in functions/ to test the MCP handshake', async function () {});
}
async function rejects(p) { try { await p; return null; } catch (e) { return e.message; } }

// The fields a logged query selected.
function selected(read) { var i = read.indexOf(' select '); return i < 0 ? [] : read.slice(i + 8).split(','); }

// ── Made-up data ─────────────────────────────────────────────────
var MI = 1609.34;
function seed(uid, coll, id, d) { store.set('users/' + uid + '/' + coll + '/' + id, d); }
function series(uid, id, d) {
  seed(uid, 'garminSeries', id, Object.assign({ activityId: id, subType: null, title: '', step: 5, n: 0, session: {}, fromFile: true }, d));
}
function speeds(list) { return { speed: list, hr: list.map(function () { return 140; }) }; }
// 2026-06-30 23:00 MDT and 2026-07-01 01:00 MDT
var JUN30_LATE = 1782882000000, JUL1_EARLY = 1782889200000;
// 2026-07-05 23:30 MDT: Sunday in Denver, already Monday in UTC
var SUN_LATE = 1783315800000;
var H = 3600e3;

function seedWorld() {
  store.clear(); reads.length = 0;
  series('u-s', '1001', { startTs: JUN30_LATE, sport: 'running', title: 'Easy', durSec: 3000, distM: 10000, n: 2, series: speeds([300, 310]),
    session: { avgHr: 140, avgPower: 250, normPower: 255, avgSpeedCms: 333 } });
  series('u-s', '1002', { startTs: JUL1_EARLY, sport: 'cycling', subType: 'road_biking', title: 'Ride', durSec: 3600, distM: 30000, n: 1, series: speeds([900]),
    session: { avgPower: 200 } });
  series('u-s', '1003', { startTs: JUL1_EARLY + 5 * H, sport: 'swimming', title: 'Swim', durSec: 1800, distM: 2000 });
  series('u-x', '2001', { startTs: JUL1_EARLY, sport: 'running', title: 'Other listed account', durSec: 600, distM: 1000, n: 1, series: speeds([300]) });
  series('u-other', '3001', { startTs: JUL1_EARLY, sport: 'running', title: 'Not listed', durSec: 600, distM: 1000, n: 1, series: speeds([300]) });
  // The run log: one covered by series 1001 (same Garmin id), one the athlete's
  // own upload of 1001 (overlapping), and one from before the series began.
  seed('u-s', 'garminActivities', 'garmin_1001', { id: 'garmin_1001', ts: JUN30_LATE, durSec: 3000, distMi: 6.2, source: 'garmin', garminActivityId: '1001' });
  seed('u-s', 'garminActivities', 'own_1001', { id: 'own_1001', ts: JUN30_LATE + 20e3, durSec: 2990, distMi: 6.2 });
  seed('u-s', 'garminActivities', 'own_old', { id: 'own_old', ts: JUL1_EARLY + 9 * H, type: 'Treadmill Running', title: 'Old upload', durSec: 1800, distMi: 3, avgHr: 135, paceSec: 600 });
}

// ── The key check and the trigger ────────────────────────────────
function mkRes() {
  return {
    code: null, body: null, headers: {}, headersSent: false,
    status: function (n) { this.code = n; return this; },
    set: function (k, v) { this.headers[k] = v; return this; },
    send: function (b) { this.body = b; this.headersSent = true; return this; },
    on: function () { return this; },
  };
}
async function call(path, method) {
  var res = mkRes();
  await mcp.esMcp({ method: method || 'POST', path: path, headers: {}, body: {} }, res);
  return res;
}
async function withEnv(k, v, fn) {
  var old = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { await fn(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; }
}

section('esMcp: a wrong or missing key gets a 404', async function () {
  eq('wrong key', (await call('/' + KEY.slice(1) + 'x')).code, 404);
  eq('no key', (await call('/')).code, 404);
  eq('the key with something after it', (await call('/' + KEY + '/x')).code, 404);
  eq('the key in a query is not the path', (await call('/?k=' + KEY)).code, 404);
  eq('the body says Not found', (await call('/nope')).body, 'Not found');
  await withEnv('ES_MCP_KEY', undefined, async function () { eq('ES_MCP_KEY unset', (await call('/' + KEY)).code, 404); });
  await withEnv('ES_MCP_KEY', 'short-key', async function () { eq('a key under 32 characters never serves', (await call('/short-key')).code, 404); });
  await withEnv('GARMIN_SERIES_UIDS', undefined, async function () { eq('no account to serve', (await call('/' + KEY)).code, 404); });
  eq('right key, not a POST: 405', [(await call('/' + KEY, 'GET')).code, (await call('/esMcp/' + KEY, 'DELETE')).code], [405, 405]);
  eq('no Firestore read for any of these', reads, []);
});

section('esMcp is declared small: 2 instances, 60 s, 256 MiB', async function () {
  eq('options', [requestOpts.maxInstances, requestOpts.timeoutSeconds, requestOpts.memory, requestOpts.cors], [2, 60, '256MiB', false]);
});

// ── The tools ────────────────────────────────────────────────────
var T = mcp.makeTools(db, 'u-s');

section('list_activities: ranges are local dates, at most 92 days', async function () {
  seedWorld();
  eq('92 days is fine', (await T.listActivities({ from: '2026-04-01', to: '2026-07-01' })).from, '2026-04-01');
  eq('93 days is refused', /93 days/.test(await rejects(T.listActivities({ from: '2026-04-01', to: '2026-07-02' }))), true);
  eq('to before from', await rejects(T.listActivities({ from: '2026-07-02', to: '2026-07-01' })), 'to is before from.');
  eq('not a date', await rejects(T.listActivities({ from: 'last week', to: '2026-07-01' })), 'from and to must be dates, YYYY-MM-DD.');
  eq('no such day', await rejects(T.listActivities({ from: '2026-02-30', to: '2026-03-01' })), 'from and to must be dates, YYYY-MM-DD.');
  var r = await T.listActivities({ from: '2026-07-01', to: '2026-07-01' });
  eq('23:00 on Jun 30 in Denver is not Jul 1, though it is in UTC', r.activities.map(function (a) { return a.activityId; }), ['1002', '1003', 'own_old']);
  eq('a full ISO time is read as its date', (await T.listActivities({ from: '2026-06-30T12:00:00Z', to: '2026-06-30' })).activities.map(function (a) { return a.activityId; }), ['1001']);
});

section('list_activities: series first, runs without one from the run log, oldest first', async function () {
  seedWorld();
  var r = await T.listActivities({ from: '2026-06-30', to: '2026-07-01' });
  eq('ids in order', r.activities.map(function (a) { return a.activityId; }), ['1001', '1002', '1003', 'own_old']);
  eq('count', r.count, 4);
  eq('a series entry', r.activities[0], { activityId: '1001', startTs: JUN30_LATE, sport: 'running', subType: null, title: 'Easy', durSec: 3000, distM: 10000,
    avgHr: 140, avgPower: 250, normPower: 255, avgSpeedCms: 333, seriesAvailable: true });
  eq('a summary-only series doc', [r.activities[2].sport, r.activities[2].seriesAvailable], ['swimming', false]);
  eq('a run with no series', r.activities[3], { activityId: 'own_old', startTs: JUL1_EARLY + 9 * H, sport: 'running', subType: 'treadmill_running', title: 'Old upload',
    durSec: 1800, distM: 4828, avgHr: 135, avgPower: null, normPower: null, avgSpeedCms: 268, source: 'upload', seriesAvailable: false });
  eq('runs a series covers (same Garmin id, or an overlapping upload) are not listed twice', r.activities.filter(function (a) { return /1001/.test(a.activityId); }).length, 1);
  eq('sport filter', (await T.listActivities({ from: '2026-06-30', to: '2026-07-01', sport: 'Cycling' })).activities.map(function (a) { return a.activityId; }), ['1002']);
  eq('the series list never reads the series arrays', reads.filter(function (x) { return /garminSeries/.test(x); }).every(function (x) {
    return /select /.test(x) && selected(x).every(function (f) { return f !== 'series' && f.indexOf('series.') !== 0; });
  }), true);
});

section('the tools read only the account they were made for', async function () {
  seedWorld();
  var r = await T.listActivities({ from: '2026-06-30', to: '2026-07-01', uid: 'u-other' });
  eq("a uid argument is ignored", r.activities.some(function (a) { return a.activityId === '3001' || a.activityId === '2001'; }), false);
  eq('every read under users/u-s', reads.every(function (x) { return x.indexOf('users/u-s/') === 0; }), true);
  eq("another account's activity is not found", await rejects(T.getActivity({ activityId: '3001' })), 'No activity 3001.');
  eq('a path in the id is refused', await rejects(T.getActivity({ activityId: '../../u-other/garminSeries/3001' })), 'activityId is required.');
});

section('get_activity returns the whole doc as plain JSON', async function () {
  seedWorld();
  store.set('users/u-s/garminSeries/1001', Object.assign({}, store.get('users/u-s/garminSeries/1001'), { createdAt: { __ts: Date.UTC(2026, 6, 1) } }));
  var d = await T.getActivity({ activityId: 1001 });
  eq('series and session', [d.series.speed, d.session.avgHr], [[300, 310], 140]);
  eq('timestamps as ISO text', d.createdAt, '2026-07-01T00:00:00.000Z');
  eq('missing', await rejects(T.getActivity({ activityId: '999' })), 'No activity 999.');
});

section('get_series re-bins on the server and returns only the fields asked for', async function () {
  seedWorld();
  series('u-s', '1010', { startTs: JUL1_EARLY, sport: 'running', durSec: 35, step: 5, n: 7,
    series: { hr: [100, 110, null, 120, null, null, 130], alt: [10, 11, null, 13, null, null, 15], speed: [1, 2, 3, 4, 5, 6, 7] } });
  var r = await T.getSeries({ activityId: '1010', fields: ['hr', 'alt'], step: 10 });
  eq('only step, n, series', Object.keys(r), ['step', 'n', 'series']);
  eq('10 s bins', [r.step, r.n, r.series.hr, r.series.alt], [10, 4, [105, 120, null, 130], [11, 13, null, 15]]);
  eq('fields limited', Object.keys(r.series), ['hr', 'alt']);
  eq('30 s', (await T.getSeries({ activityId: '1010', fields: ['speed'], step: 30 })).series.speed, [4, 7]);
  var stored = await T.getSeries({ activityId: '1010', fields: ['hr'] });
  eq('no step: as stored', [stored.step, stored.series.hr], [5, [100, 110, null, 120, null, null, 130]]);
  eq('all fields by default', Object.keys((await T.getSeries({ activityId: '1010' })).series).length, 9);
  eq('another step is refused', await rejects(T.getSeries({ activityId: '1010', step: 7 })), 'step must be one of 5, 10, 30.');
  eq('an unknown field is refused', /Unknown field lat/.test(await rejects(T.getSeries({ activityId: '1010', fields: ['lat'] }))), true);
  eq('a summary-only doc has no series', /no series stored/.test(await rejects(T.getSeries({ activityId: '1003' }))), true);
  series('u-s', '1011', { startTs: JUL1_EARLY, step: 30, n: 1, series: { hr: [140] } });
  eq('finer than stored: the stored step', (await T.getSeries({ activityId: '1011', fields: ['hr'], step: 5 })).step, 30);
});

// A run of whole 5 s bins at each speed: [cm/s, bins].
function runSeries(parts) {
  var out = [];
  parts.forEach(function (p) { for (var i = 0; i < p[1]; i++) out.push(p[0]); });
  return out;
}
function miles(cms, bins) { return cms / 100 * 5 * bins / MI; }
function r2(v) { return Math.round(v * 100) / 100; }

section('weekly_summary: pace bands from the speed series, Lever apart, Mon-Sun in Denver', async function () {
  store.clear();
  var spd = runSeries([[560, 100], [510, 100], [470, 100], [430, 100], [400, 100], [300, 100], [0, 20], [null, 30]]);
  series('u-s', 'r1', { startTs: Date.UTC(2026, 5, 30, 14), sport: 'running', title: 'Steady', durSec: 3000, distM: 16093.4, step: 5, n: spd.length, series: { speed: spd } });
  series('u-s', 'r2', { startTs: Date.UTC(2026, 6, 2, 14), sport: 'running', title: 'LEVER 80%', durSec: 1800, distM: 8046.7, step: 5, n: 50, series: { speed: runSeries([[470, 50]]) } });
  series('u-s', 'r3', { startTs: SUN_LATE, sport: 'running', title: 'Sunday night', durSec: 1200, distM: 4023.35 });
  series('u-s', 'b1', { startTs: Date.UTC(2026, 6, 1, 14), sport: 'cycling', title: 'Ride', durSec: 3600, session: { avgPower: 200, tss: 50 } });
  series('u-s', 'b2', { startTs: Date.UTC(2026, 6, 3, 14), sport: 'cycling', title: 'Long ride', durSec: 7200, session: { avgPower: 300, tss: 120.5 } });
  series('u-s', 'b3', { startTs: Date.UTC(2026, 6, 4, 14), sport: 'cycling', title: 'No meter', durSec: 3600, session: {} });
  series('u-s', 's1', { startTs: Date.UTC(2026, 6, 8, 14), sport: 'swimming', durSec: 2700 });
  reads.length = 0;
  var r = await T.weeklySummary({ from: '2026-06-29', to: '2026-07-19' });
  eq('three weeks, empty ones included', r.weeks.map(function (w) { return [w.week, w.weekStart, w.weekEnd]; }),
    [['2026-W27', '2026-06-29', '2026-07-05'], ['2026-W28', '2026-07-06', '2026-07-12'], ['2026-W29', '2026-07-13', '2026-07-19']]);
  var w = r.weeks[0];
  eq('Sunday 23:30 in Denver counts in that week, not the next', w.sessions, 6);
  eq('hours by sport', w.hoursBySport, { running: 1.67, cycling: 4 });
  eq('run miles from distance, Lever not in them', w.runMiles, 12.5);
  eq('pace bands', w.runMilesByPace, {
    '<5:00': r2(miles(560, 100)), '5:00-5:30': r2(miles(510, 100)), '5:30-6:00': r2(miles(470, 100)),
    '6:00-6:30': r2(miles(430, 100)), '6:30-7:00': r2(miles(400, 100)), '>7:00': r2(miles(300, 100)),
  });
  eq('miles with no speed series', w.runMilesNoSeries, 2.5);
  eq('longest run, Lever aside', w.longestRunMi, 10);
  eq('Lever apart', w.lever, { sessions: 1, miles: 5, milesByPace: { '<5:00': 0, '5:00-5:30': 0, '5:30-6:00': r2(miles(470, 50)), '6:00-6:30': 0, '6:30-7:00': 0, '>7:00': 0 } });
  eq('bike: hours, power weighted by time over rides with power, TSS', w.bike, { sessions: 3, hours: 4, avgPowerW: 267, powerHours: 3, tss: 170.5 });
  eq('next week', [r.weeks[1].sessions, r.weeks[1].hoursBySport, r.weeks[1].bike.avgPowerW, r.weeks[1].bike.tss], [1, { swimming: 0.75 }, null, null]);
  eq('an empty week', [r.weeks[2].sessions, r.weeks[2].runMiles, r.weeks[2].longestRunMi], [0, 0, 0]);
  eq('only the speed series is read', reads.filter(function (x) { return /garminSeries/.test(x); }).every(function (x) { return /series\.speed/.test(x) && !/series\.hr/.test(x); }), true);
  eq('92-day cap', /93 days/.test(await rejects(T.weeklySummary({ from: '2026-04-01', to: '2026-07-02' }))), true);
});

section('weekly_summary labels ISO weeks across a year end', async function () {
  store.clear();
  var r = await T.weeklySummary({ from: '2026-12-30', to: '2027-01-05' });
  eq('W53 then W01', r.weeks.map(function (w) { return w.week; }), ['2026-W53', '2027-W01']);
});

// ── A real MCP handshake over loopback HTTP ──────────────────────
function serve() {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        var text = Buffer.concat(chunks).toString();
        req.body = text ? JSON.parse(text) : undefined;
        req.path = req.url.split('?')[0];
        res.status = function (n) { res.statusCode = n; return res; };
        res.set = function (k, v) { res.setHeader(k, v); return res; };
        res.send = function (b) { res.end(b); return res; };
        mcp.esMcp(req, res);
      });
    });
    srv.listen(0, '127.0.0.1', function () { resolve(srv); });
  });
}
var realFetch = global.fetch;
var rpcId = 0;
async function rpc(base, path, method, params) {
  var r = await realFetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: method, params: params || {} }),
  });
  var text = await r.text();
  var body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { status: r.status, body: body };
}
function toolJson(res) { return JSON.parse(res.body.result.content[0].text); }

sdkSection('an MCP client can connect, list the tools and call them', async function () {
  seedWorld();
  var srv = await serve();
  var base = 'http://127.0.0.1:' + srv.address().port;
  try {
    var init = await rpc(base, '/esMcp/' + KEY, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    eq('initialize', [init.status, init.body.result.serverInfo.name], [200, 'endurance-science-labs']);
    eq('tools offered', !!init.body.result.capabilities.tools, true);
    var list = await rpc(base, '/esMcp/' + KEY, 'tools/list');
    var tools = list.body.result.tools;
    eq('four tools', tools.map(function (t) { return t.name; }).sort(), ['get_activity', 'get_series', 'list_activities', 'weekly_summary']);
    eq('no tool takes a uid', tools.every(function (t) { return !('uid' in ((t.inputSchema || {}).properties || {})); }), true);
    eq('all read-only', tools.every(function (t) { return t.annotations && t.annotations.readOnlyHint === true; }), true);
    var call = await rpc(base, '/' + KEY, 'tools/call', { name: 'list_activities', arguments: { from: '2026-06-30', to: '2026-07-01', uid: 'u-other' } });
    var got = toolJson(call);
    eq('list_activities over MCP, for the served account only', got.activities.map(function (a) { return a.activityId; }), ['1001', '1002', '1003', 'own_old']);
    var tooLong = await rpc(base, '/' + KEY, 'tools/call', { name: 'list_activities', arguments: { from: '2026-01-01', to: '2026-07-01' } });
    eq('a refused range is a tool error Claude can read', [tooLong.body.result.isError, /at most 92/.test(tooLong.body.result.content[0].text)], [true, true]);
    var badStep = await rpc(base, '/' + KEY, 'tools/call', { name: 'get_series', arguments: { activityId: '1001', step: 7 } });
    eq('the schema refuses another step', !!(badStep.body.error || (badStep.body.result && badStep.body.result.isError)), true);
    var s = toolJson(await rpc(base, '/' + KEY, 'tools/call', { name: 'get_series', arguments: { activityId: '1001', fields: ['speed'], step: 10 } }));
    eq('get_series over MCP', s, { step: 10, n: 1, series: { speed: [305] } });
    var wrong = await rpc(base, '/esMcp/wrong-key', 'initialize', {});
    eq('wrong key over HTTP: 404', [wrong.status, wrong.body], [404, 'Not found']);
  } finally {
    srv.close();
  }
  eq('no unexpected errors logged', logged, []);
});

(async function () {
  for (var i = 0; i < sections.length; i++) {
    console.log(sections[i][0]);
    try { await sections[i][1](); } catch (e) { failures++; checks++; console.log('  FAIL threw: ' + (e && e.stack || e)); }
  }
  console.log('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  console.error = quiet;
  if (failures) process.exit(1);
})();
