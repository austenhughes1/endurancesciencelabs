// ════════════════════════════════════════════════════════════════
// functions/garmin.test.js
//
// The Garmin Connect link flow in functions/garmin.js, run against an
// in-memory Firestore and a fake fetch (nothing leaves this process).
// Run with plain node:
//
//   node functions/garmin.test.js
//
// All ids, tokens and runs are made up. Never put real athlete data here
// (AGENTS.md).
// ════════════════════════════════════════════════════════════════
'use strict';
var Module = require('module');
var fs = require('fs'), path = require('path');

// ── In-memory Firestore ──────────────────────────────────────────
var store = new Map(); // full doc path -> plain object

function Timestamp(ms) { this.ms = ms; }
Timestamp.prototype.toMillis = function () { return this.ms; };
Timestamp.prototype.valueOf = function () { return this.ms; };
Timestamp.fromMillis = function (ms) { return new Timestamp(ms); };
Timestamp.now = function () { return new Timestamp(Date.now()); };
var SERVER_TS = { op: 'serverTimestamp' }, DELETE_FIELD = { op: 'delete' };
var FieldValue = { serverTimestamp: function () { return SERVER_TS; }, delete: function () { return DELETE_FIELD; } };

function applyFields(base, data) {
  var out = Object.assign({}, base);
  Object.keys(data).forEach(function (k) {
    var v = data[k];
    if (v === DELETE_FIELD) delete out[k];
    else out[k] = v === SERVER_TS ? Timestamp.now() : v;
  });
  return out;
}

// Reads answer on a later turn of the event loop, as a real backend does, so
// work started together interleaves the way it does in production.
function later(v) { return new Promise(function (r) { setImmediate(function () { r(v); }); }); }

// A write outside a transaction to a document an open transaction has read
// waits until that transaction ends, as the server SDK's locks make it.
var locks = new Map(); // doc path -> promise that settles when its transaction ends
function unlocked(p, apply) {
  var l = locks.get(p);
  if (l) return l.then(function () { return unlocked(p, apply); });
  try { apply(); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
}

var autoId = 0;
function DocRef(p) { this.path = p; this.id = p.slice(p.lastIndexOf('/') + 1); }
DocRef.prototype.collection = function (name) { return new Query(this.path + '/' + name, []); };
DocRef.prototype.get = function () { return later(new Snap(this, store.get(this.path))); };
DocRef.prototype._set = function (data, opts) {
  store.set(this.path, applyFields(opts && opts.merge ? store.get(this.path) || {} : {}, data));
};
DocRef.prototype._update = function (data) {
  if (!store.has(this.path)) throw new Error('NOT_FOUND: ' + this.path);
  store.set(this.path, applyFields(store.get(this.path), data));
};
DocRef.prototype._delete = function () { store.delete(this.path); };
DocRef.prototype.set = function (data, opts) { var r = this; return unlocked(r.path, function () { r._set(data, opts); }); };
DocRef.prototype.update = function (data) { var r = this; return unlocked(r.path, function () { r._update(data); }); };
DocRef.prototype.delete = function () { var r = this; return unlocked(r.path, function () { r._delete(); }); };

function Snap(ref, data) { this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this._d = data; }
Snap.prototype.data = function () { return this.exists ? Object.assign({}, this._d) : undefined; };
Snap.prototype.get = function (f) { return this.exists ? this._d[f] : undefined; };

function field(d, f) { return f.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, d); }
function cmp(a, op, b) {
  var x = a && a.toMillis ? a.toMillis() : a, y = b && b.toMillis ? b.toMillis() : b;
  if (op === '==') return x === y;
  if (x === undefined || x === null) return false;
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : op === '>=' ? x >= y : false;
}
function Query(collPath, filters, lim) { this.collPath = collPath; this.filters = filters; this.lim = lim; }
Query.prototype.doc = function (id) { return new DocRef(this.collPath + '/' + (id || 'auto' + (++autoId))); };
Query.prototype.where = function (f, op, v) { return new Query(this.collPath, this.filters.concat([[f, op, v]]), this.lim); };
Query.prototype.limit = function (n) { return new Query(this.collPath, this.filters, n); };
Query.prototype.get = function () {
  var self = this, docs = [];
  store.forEach(function (d, p) {
    if (p.slice(0, p.lastIndexOf('/')) !== self.collPath) return;
    if (self.filters.every(function (w) { return cmp(field(d, w[0]), w[1], w[2]); })) docs.push(new Snap(new DocRef(p), d));
  });
  if (self.lim != null) docs = docs.slice(0, self.lim);
  return later({ docs: docs, size: docs.length, empty: docs.length === 0 });
};

var db = {
  collection: function (name) { return new Query(name, []); },
  batch: function () {
    var ops = [];
    return {
      set: function (ref, data, opts) { ops.push(function () { return ref.set(data, opts); }); },
      update: function (ref, data) { ops.push(function () { return ref.update(data); }); },
      delete: function (ref) { ops.push(function () { return ref.delete(); }); },
      commit: async function () { for (var i = 0; i < ops.length; i++) await ops[i](); },
    };
  },
  // One transaction at a time, standing in for the locks a real one takes;
  // documents it reads are locked (see unlocked) and its writes apply when the
  // callback finishes.
  runTransaction: function (fn) {
    var run = txQueue.then(async function () {
      var ops = [], held = [], release;
      var ended = new Promise(function (r) { release = r; });
      var t = {
        get: function (x) {
          if (x instanceof DocRef && !locks.has(x.path)) { locks.set(x.path, ended); held.push(x.path); }
          return x.get();
        },
        set: function (ref, data, opts) { ops.push(function () { ref._set(data, opts); }); return t; },
        update: function (ref, data) { ops.push(function () { ref._update(data); }); return t; },
        delete: function (ref) { ops.push(function () { ref._delete(); }); return t; },
      };
      try {
        var out = await fn(t);
        ops.forEach(function (op) { op(); });
        return out;
      } finally {
        held.forEach(function (p) { locks.delete(p); });
        release();
      }
    });
    txQueue = run.catch(function () {});
    return run;
  },
};
var txQueue = Promise.resolve();

function HttpsError(code, message) { var e = new Error(message); e.code = code; return e; }
var triggerOpts = {}; // document pattern -> the options its trigger was declared with
var scheduleOpts = null; // the options the scheduled job was declared with
var fakes = {
  'firebase-admin': { initializeApp: function () {}, firestore: Object.assign(function () { return db; }, { FieldValue: FieldValue, Timestamp: Timestamp }) },
  'firebase-functions/v2/https': {
    onCall: function (opts, fn) { return fn; },
    onRequest: function (opts, fn) { return fn; },
    HttpsError: HttpsError,
  },
  'firebase-functions/v2/firestore': { onDocumentCreated: function (opts, fn) { triggerOpts[opts.document] = opts; return fn; } },
  'firebase-functions/v2/scheduler': { onSchedule: function (opts, fn) { scheduleOpts = opts; return fn; } },
};

// ── Fake Garmin (fetch) ──────────────────────────────────────────
var calls = [], garmin = {};
function resetGarmin() {
  calls = [];
  garmin = {
    userId: 'g-111',
    tokenStatus: 200,
    permStatus: 200,
    permissions: ['ACTIVITY_EXPORT'],
    files: {}, // callback URL -> FIT bytes; null = not available; a number = that HTTP status
  };
}
var tokenSeq = 0;
function reply(status, body) {
  return {
    ok: status >= 200 && status < 300, status: status,
    json: async function () { return body; },
    text: async function () { return JSON.stringify(body); },
  };
}
global.fetch = async function (url, opts) {
  var method = (opts && opts.method) || 'GET';
  var auth = opts && opts.headers && opts.headers.Authorization;
  if (/oauth\/token$/.test(url)) {
    calls.push('POST token');
    tokenSeq++;
    return reply(garmin.tokenStatus, { access_token: 'acc-' + tokenSeq, refresh_token: 'ref-' + tokenSeq, expires_in: 86400, refresh_token_expires_in: 7776000 });
  }
  if (Object.prototype.hasOwnProperty.call(garmin.files, url)) {
    calls.push(method + ' file');
    var bytes = garmin.files[url];
    if (typeof bytes === 'number') return { ok: false, status: bytes };
    return {
      ok: !!bytes, status: bytes ? 200 : 404,
      arrayBuffer: async function () { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
  var m =/\/user\/(id|permissions|registration)$/.exec(url);
  if (!m) throw new Error('unexpected fetch ' + url);
  calls.push(method + ' ' + m[1] + (method === 'DELETE' ? ' ' + auth : ''));
  if (m[1] === 'id') return reply(200, { userId: garmin.userId });
  if (m[1] === 'permissions') return reply(garmin.permStatus, { permissions: garmin.permissions });
  return reply(204, null);
};

// ── Load garmin.js with the fakes ────────────────────────────────
process.env.GARMIN_CLIENT_ID = 'test-client-id';
process.env.GARMIN_CLIENT_SECRET = 'test-client-secret';
process.env.GARMIN_PUSH_KEY = 'test-push-key';
var realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
  return realLoad.apply(this, arguments);
};
var g = require('./garmin');
Module._load = realLoad;
var lib = require('./garmin-lib');

// Keep the module's own warnings out of the test output, but keep them so
// tests can check what would reach the logs.
var quiet = { log: console.log, warn: console.warn, error: console.error };
var logged = [];
console.log = console.warn = console.error = function () { logged.push(Array.prototype.join.call(arguments, ' ')); };
var say = quiet.log;

// ── Harness ──────────────────────────────────────────────────────
var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  var a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; say('  FAIL ' + label + ': got ' + a + ', want ' + b); }
}
var sections = [];
function section(name, fn) { sections.push([name, fn]); }

function reset() { store.clear(); resetGarmin(); logged.length = 0; }
function doc(p) { return store.get(p); }
function seedUser(uid, extra) { store.set('users/' + uid, Object.assign({ name: 'Test ' + uid }, extra || {})); }
// A stored link for uid to Garmin account gid, with a token that is still good.
function seedLink(uid, gid) {
  store.set('users/' + uid + '/private/garmin', {
    accessToken: 'stored-' + uid, refreshToken: 'stored-ref-' + uid, garminUserId: gid,
    expiresAt: Date.now() + 3600e3, refreshExpiresAt: Date.now() + 80 * 86400e3,
  });
  store.set('garminUsers/' + gid, { uid: uid });
  var u = store.get('users/' + uid);
  if (u) store.set('users/' + uid, Object.assign({}, u, { garminConnected: true, garminSharing: true }));
}
function seedRun(uid, id, source) { store.set('users/' + uid + '/garminActivities/' + id, { id: id, source: source, ts: 1700000000000 }); }
function runIds(uid) {
  var out = [];
  store.forEach(function (d, p) { if (p.indexOf('users/' + uid + '/garminActivities/') === 0) out.push(d.id); });
  return out.sort();
}
// Lever marks and exclusions on the user doc, as Running Dynamics stores them,
// on two Garmin runs and two of the athlete's own.
function seedRunNotes(uid) {
  var u = store.get('users/' + uid);
  u.runLeverMarks = [
    { id: 'garmin_1', lever: true, offload: 0.3, ts: 1700000000000, mi: 5.01 },
    { id: '20231114221320_treadmillrunning', lever: false, ts: 1700000000000, mi: 3.1 },
  ];
  u.runExcluded = [
    { id: 'garmin_2', ts: 1700000600000, at: 1700001000000 },
    { id: 'own_1', ts: 1700000900000, at: 1700001000000 },
  ];
}
var OWN_NOTE_IDS = { runLeverMarks: ['20231114221320_treadmillrunning'], runExcluded: ['own_1'] };
function runNoteIds(uid) {
  var u = store.get('users/' + uid) || {};
  var ids = function (l) { return Array.isArray(l) ? l.map(function (m) { return m.id; }) : l; };
  return { runLeverMarks: ids(u.runLeverMarks), runExcluded: ids(u.runExcluded) };
}

async function callback(query) {
  var res = { url: null, redirect: function (u) { this.url = u; } };
  await g.garminCallback({ query: query }, res);
  return new URL(res.url);
}
// Start a link as uid, have Garmin redirect back with a code, and return what
// the coaching page would get: { state, key } from the redirect.
async function startAndApprove(uid) {
  var out = await g.createGarminAuthUrl({ auth: { uid: uid }, data: {} });
  var state = new URL(out.url).searchParams.get('state');
  var back = await callback({ state: state, code: 'code-for-' + uid });
  return { state: state, key: back.searchParams.get('key'), back: back };
}
function finish(uid, state, key) {
  return g.finishGarminLink({ auth: uid ? { uid: uid } : null, data: { state: state, key: key } });
}

// ── Tests ────────────────────────────────────────────────────────
section('createGarminAuthUrl stores an expiring state and sweeps abandoned ones', async function () {
  reset();
  var threw = null;
  try { await g.createGarminAuthUrl({ auth: null, data: {} }); } catch (e) { threw = e.code; }
  eq('signed out is refused', threw, 'unauthenticated');

  store.set('garminAuth/old', { uid: 'u-a', verifier: 'v', expireAt: Timestamp.fromMillis(Date.now() - 1000) });
  store.set('garminAuth/live', { uid: 'u-b', verifier: 'v', expireAt: Timestamp.fromMillis(Date.now() + 60e3) });
  var out = await g.createGarminAuthUrl({ auth: { uid: 'u-a' }, data: {} });
  var u = new URL(out.url);
  var state = u.searchParams.get('state');
  var a = doc('garminAuth/' + state);
  eq('state doc holds the uid', a.uid, 'u-a');
  eq('expireAt is a Timestamp (TTL-ready)', a.expireAt instanceof Timestamp, true);
  eq('expires in about 15 minutes', Math.round((a.expireAt.toMillis() - Date.now()) / 60e3), 15);
  eq('expired attempt swept', store.has('garminAuth/old'), false);
  eq('live attempt kept', store.has('garminAuth/live'), true);
  eq('PKCE S256 requested', u.searchParams.get('code_challenge_method'), 'S256');
  eq('nothing sent to Garmin yet', calls, []);
});

section('garminCallback parks the code and hands the browser a key; it never exchanges', async function () {
  reset();
  eq('no state', (await callback({})).searchParams.get('reason'), 'params');
  eq('unknown state', (await callback({ state: 'nope', code: 'c' })).searchParams.get('reason'), 'state');

  store.set('garminAuth/stale', { uid: 'u-a', verifier: 'v', expireAt: Timestamp.fromMillis(Date.now() - 1) });
  eq('expired state', (await callback({ state: 'stale', code: 'c' })).searchParams.get('reason'), 'state');
  eq('expired state doc removed', store.has('garminAuth/stale'), false);

  store.set('garminAuth/cancel', { uid: 'u-a', verifier: 'v', expireAt: Timestamp.fromMillis(Date.now() + 60e3) });
  eq('no code means denied', (await callback({ state: 'cancel' })).searchParams.get('garmin'), 'denied');
  eq('denied state doc removed', store.has('garminAuth/cancel'), false);

  seedUser('u-a');
  var r = await startAndApprove('u-a');
  eq('redirects to finish', r.back.searchParams.get('garmin'), 'finish');
  eq('state passed back', r.back.searchParams.get('state'), r.state);
  eq('key handed to the browser', typeof r.key === 'string' && r.key.length >= 32, true);
  eq('code parked on the state doc', doc('garminAuth/' + r.state).code, 'code-for-u-a');
  eq('code not in the redirect', r.back.searchParams.get('code'), null);
  eq('a replayed callback is refused', (await callback({ state: r.state, code: 'other' })).searchParams.get('reason'), 'state');
  eq('no Garmin calls', calls, []);
});

section('finishGarminLink: only the account that started the link can finish it', async function () {
  reset();
  seedUser('u-attacker'); seedUser('u-target');
  var r = await startAndApprove('u-attacker');
  var res = await finish('u-target', r.state, r.key);
  eq('another account is refused', res, { result: 'error', reason: 'account' });
  eq('code never exchanged', calls, []);
  eq('state is single use', store.has('garminAuth/' + r.state), false);
  eq('nothing linked', [doc('users/u-attacker/private/garmin'), doc('garminUsers/g-111')], [undefined, undefined]);

  // Knowing the state is not enough: the key only reached the approving browser.
  var r2 = await startAndApprove('u-attacker');
  eq('wrong key', await finish('u-attacker', r2.state, 'guessed-key'), { result: 'error', reason: 'state' });
  eq('right key after a wrong try', await finish('u-attacker', r2.state, r2.key), { result: 'error', reason: 'state' });
  eq('still no exchange', calls, []);

  var threw = null;
  try { await finish(null, 'x', 'y'); } catch (e) { threw = e.code; }
  eq('signed out is refused', threw, 'unauthenticated');
  eq('missing key', await finish('u-target', 'x', ''), { result: 'error', reason: 'params' });
});

section('finishGarminLink links the account', async function () {
  reset();
  seedUser('u-a');
  var r = await startAndApprove('u-a');
  eq('connected', await finish('u-a', r.state, r.key), { result: 'connected' });
  eq('calls', calls, ['POST token', 'GET id', 'GET permissions']);
  eq('tokens stored with the Garmin user', doc('users/u-a/private/garmin').garminUserId, 'g-111');
  eq('mapping', doc('garminUsers/g-111').uid, 'u-a');
  eq('flags', [doc('users/u-a').garminConnected, doc('users/u-a').garminSharing], [true, true]);
});

section('permissions call fails: an error, not "scope"', async function () {
  reset();
  seedUser('u-a');
  garmin.permStatus = 503;
  var r = await startAndApprove('u-a');
  eq('new link -> exchange error', await finish('u-a', r.state, r.key), { result: 'error', reason: 'exchange' });
  eq('new link is undone with Garmin', calls.slice(-1), ['DELETE registration Bearer acc-' + tokenSeq]);
  eq('nothing stored', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111')], [undefined, undefined]);

  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111'); seedRun('u-a', 'garmin_1', 'garmin');
  garmin.permStatus = 503;
  r = await startAndApprove('u-a');
  eq('existing link -> exchange error', await finish('u-a', r.state, r.key), { result: 'error', reason: 'exchange' });
  eq('existing link is not deregistered', calls.filter(function (c) { return c.indexOf('DELETE') === 0; }), []);
  eq('existing link keeps working on the fresh token', doc('users/u-a/private/garmin').accessToken, 'acc-' + tokenSeq);
  eq('mapping kept', doc('garminUsers/g-111').uid, 'u-a');
  eq('runs kept', runIds('u-a'), ['garmin_1']);
  eq('still connected', doc('users/u-a').garminConnected, true);
});

section('activity sharing not granted: scope, and local state matches Garmin', async function () {
  reset();
  seedUser('u-a');
  garmin.permissions = ['HEALTH_EXPORT'];
  var r = await startAndApprove('u-a');
  eq('new link -> scope', await finish('u-a', r.state, r.key), { result: 'scope' });
  eq('registration deleted', calls.slice(-1), ['DELETE registration Bearer acc-' + tokenSeq]);
  eq('nothing stored', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111')], [undefined, undefined]);

  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111');
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'garmin_2', 'garmin'); seedRun('u-a', 'own_1', 'fit'); seedRun('u-a', 'strava_1', 'strava');
  garmin.permissions = [];
  r = await startAndApprove('u-a');
  eq('re-link without sharing -> scope', await finish('u-a', r.state, r.key), { result: 'scope' });
  eq('registration deleted', calls.filter(function (c) { return c.indexOf('DELETE') === 0; }).length, 1);
  eq('tokens purged', doc('users/u-a/private/garmin'), undefined);
  eq('mapping purged', doc('garminUsers/g-111'), undefined);
  eq('Garmin runs purged, others kept', runIds('u-a'), ['own_1', 'strava_1']);
  eq('shown as disconnected', doc('users/u-a').garminConnected, false);
});

section('one Garmin account per ESL account, but a stale mapping does not lock it out', async function () {
  reset();
  seedUser('u-a'); seedUser('u-b'); seedLink('u-b', 'g-111');
  var r = await startAndApprove('u-a');
  eq('live link elsewhere -> inuse', await finish('u-a', r.state, r.key), { result: 'error', reason: 'inuse' });
  eq('other link not deregistered', calls.filter(function (c) { return c.indexOf('DELETE') === 0; }), []);
  eq('other link untouched', doc('garminUsers/g-111').uid, 'u-b');

  reset();
  seedUser('u-new');
  store.set('garminUsers/g-111', { uid: 'u-deleted' }); // its users/ doc is gone
  r = await startAndApprove('u-new');
  eq('stale mapping -> connected', await finish('u-new', r.state, r.key), { result: 'connected' });
  eq('mapping now points at the new account', doc('garminUsers/g-111').uid, 'u-new');
});

section('switching Garmin accounts drops the old link and its runs', async function () {
  reset();
  seedUser('u-a'); seedLink('u-a', 'g-old'); seedRun('u-a', 'garmin_old', 'garmin'); seedRun('u-a', 'own_1', 'fit');
  garmin.userId = 'g-new';
  var r = await startAndApprove('u-a');
  eq('connected', await finish('u-a', r.state, r.key), { result: 'connected' });
  eq('old account deregistered with its own token', calls.indexOf('DELETE registration Bearer stored-u-a') >= 0, true);
  eq('old mapping gone', doc('garminUsers/g-old'), undefined);
  eq('new mapping', doc('garminUsers/g-new').uid, 'u-a');
  eq('old runs gone, own kept', runIds('u-a'), ['own_1']);
});

section('endGarminLinkForDeletion tells Garmin and frees the mapping', async function () {
  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111');
  eq('no warning', await g.endGarminLinkForDeletion('u-a'), null);
  eq('deregistered with the stored token', calls, ['DELETE registration Bearer stored-u-a']);
  eq('mapping gone', doc('garminUsers/g-111'), undefined);

  reset();
  seedUser('u-a');
  eq('no link -> nothing to do', await g.endGarminLinkForDeletion('u-a'), null);
  eq('no calls', calls, []);

  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111');
  var p = doc('users/u-a/private/garmin');
  p.expiresAt = Date.now() - 1; p.refreshExpiresAt = Date.now() - 1;
  var w = await g.endGarminLinkForDeletion('u-a');
  eq('lapsed token -> warning', typeof w === 'string' && w.length > 0, true);
  eq('mapping still freed', doc('garminUsers/g-111'), undefined);

  reset();
  seedUser('u-a'); seedUser('u-b'); seedLink('u-b', 'g-111');
  store.set('users/u-a/private/garmin', { garminUserId: 'g-111', accessToken: 'stored-u-a', expiresAt: Date.now() + 3600e3 });
  await g.endGarminLinkForDeletion('u-a');
  eq("another account's mapping is left alone", doc('garminUsers/g-111').uid, 'u-b');

  // adminDeleteUser must call it before users/{uid} (and its token) is deleted.
  var src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  var fn = src.slice(src.indexOf('exports.adminDeleteUser'));
  var unlink = fn.indexOf('garmin.endGarminLinkForDeletion(uid)');
  var wipe = fn.indexOf('db.recursiveDelete(db.collection("users").doc(uid))');
  eq('adminDeleteUser ends the Garmin link first', unlink > 0 && wipe > unlink, true);
});

// ── Push intake and the inbox worker ─────────────────────────────

// A made-up FIT file: one session message per entry, each field given as
// [field number, base type, raw value].
var FIT_EPOCH_S = 631065600; // FIT time zero, 1989-12-31T00:00:00Z, in Unix seconds
var ENUM = 0x00, U8 = 0x02, U16 = 0x84, U32 = 0x86;
var FIT_SIZE = { 0: 1, 2: 1, 132: 2, 134: 4 };
function fitCrc(bytes) {
  var T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  var crc = 0;
  bytes.forEach(function (b) {
    var t = T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ T[b & 0xF];
    t = T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ T[(b >> 4) & 0xF];
  });
  return crc;
}
function fitFile(sessions) {
  var data = [];
  sessions.forEach(function (fields) {
    data.push(0x40, 0, 0, 18, 0, fields.length); // definition: local 0, little endian, global 18 (session)
    fields.forEach(function (f) { data.push(f[0], FIT_SIZE[f[1]], f[1]); });
    data.push(0x00); // data message, local 0
    fields.forEach(function (f) { for (var i = 0; i < FIT_SIZE[f[1]]; i++) data.push((f[2] >>> (8 * i)) & 0xFF); });
  });
  var n = data.length;
  var head = [14, 0x20, 0x2D, 0x08, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF, 0x2E, 0x46, 0x49, 0x54];
  var hc = fitCrc(head), fc = fitCrc(data);
  return Buffer.from(head.concat([hc & 0xFF, hc >> 8], data, [fc & 0xFF, fc >> 8]));
}
var RUN_SESSION = [
  [2, U32, 1800000000 - FIT_EPOCH_S], // start_time
  [5, ENUM, 1],                       // sport: running
  [8, U32, 2400000],                  // total_timer_time 2400 s
  [9, U32, 804670],                   // total_distance 8046.70 m
  [14, U16, 3353],                    // avg_speed 3.353 m/s
  [16, U8, 150], [17, U8, 171],       // avg / max heart rate
  [18, U8, 86], [92, U8, 64],         // cadence 86 per leg + 0.5
  [22, U16, 40], [23, U16, 38],       // total ascent / descent
  [24, U8, 32],                       // total_training_effect 3.2
  [89, U16, 850],                     // avg_vertical_oscillation 85.0 mm
  [91, U16, 2450],                    // avg_stance_time 245.0 ms
  [132, U16, 750],                    // avg_vertical_ratio 7.50 %
  [133, U16, 4980],                   // avg_stance_time_balance 49.80 %
  [134, U16, 12000],                  // avg_step_length 1200.0 mm
];
var BIKE_SESSION = [[2, U32, 1800000000 - 3600 - FIT_EPOCH_S], [5, ENUM, 2], [8, U32, 1800000], [16, U8, 120]];

var T0 = 1800000000000;
var SUMMARY = {
  userId: 'g-111', summaryId: 'S-9001', activityId: 9001, activityName: 'Easy run',
  activityType: 'RUNNING', startTimeInSeconds: T0 / 1000, startTimeOffsetInSeconds: -21600,
  durationInSeconds: 2400, distanceInMeters: 8046.7, averageSpeedInMetersPerSecond: 3.353,
  averageHeartRateInBeatsPerMinute: 150, maxHeartRateInBeatsPerMinute: 171,
  averageRunCadenceInStepsPerMinute: 86, steps: 7000,
  totalElevationGainInMeters: 40, totalElevationLossInMeters: 38, deviceName: 'Forerunner 965',
};
var FILE_URL = 'https://files.example.test/activity-file?id=9001&token=tok-secret-9001';
var FILE_ITEM = {
  userId: 'g-111', summaryId: 'F-9001', fileType: 'FIT', callbackURL: FILE_URL,
  activityId: 9001, activityType: 'RUNNING', activityName: 'Easy run',
  deviceName: 'Forerunner 965', startTimeInSeconds: T0 / 1000,
};
function copy(o, extra) { return Object.assign({}, o, extra); }
var RUN = 'users/u-a/garminActivities/garmin_9001';

// The browser's own imports (CSV, FIT) write no source field.
function seedRunAt(uid, id, ts, durSec, source) {
  var d = { id: id, ts: ts, durSec: durSec };
  if (source) d.source = source;
  store.set('users/' + uid + '/garminActivities/' + id, d);
}
function linked() { reset(); seedUser('u-a'); seedLink('u-a', 'g-111'); }

function mkRes() {
  return { code: null, body: null, status: function (n) { this.code = n; return this; }, send: function (b) { this.body = b; return this; } };
}
async function push(body, query, method) {
  var res = mkRes();
  await g.garminPush({ method: method || 'POST', query: query || { k: 'test-push-key' }, body: body }, res);
  return res;
}
function inbox() {
  var out = [];
  store.forEach(function (d, p) { if (p.indexOf('garminInbox/') === 0) out.push(d); });
  return out;
}
function inboxSnaps(only) {
  var snaps = [];
  store.forEach(function (d, p) { if (p.indexOf('garminInbox/') === 0 && (!only || d.kind === only)) snaps.push(new Snap(new DocRef(p), d)); });
  return snaps;
}
// Runs the worker on every queued item (or every item of one kind) at once, as
// the trigger would.
async function work(only) {
  await Promise.all(inboxSnaps(only).map(function (s) { return g.onGarminInbox({ data: s }); }));
}
// As work(), but returns how many items failed in a way the trigger retries.
async function workCountingRetries() {
  var out = await Promise.allSettled(inboxSnaps().map(function (s) { return g.onGarminInbox({ data: s }); }));
  return out.filter(function (r) { return r.status === 'rejected'; }).length;
}

// The file sections need the real FIT parser from functions/node_modules.
var hasFitParser = (function () {
  try { require.resolve('fit-file-parser', { paths: [__dirname] }); return true; } catch (e) { return false; }
})();
function fitSection(name, fn) {
  if (hasFitParser) section(name, fn);
  else section(name + ' -- SKIPPED: run npm install in functions/ to test the FIT parser', async function () {});
}

section('garminPush: a wrong or missing key gets a 404 and queues nothing', async function () {
  reset();
  eq('wrong key', (await push({ activities: [SUMMARY] }, { k: 'guess' })).code, 404);
  eq('no key', (await push({ activities: [SUMMARY] }, {})).code, 404);
  eq('not a POST', (await push({ activities: [SUMMARY] }, null, 'GET')).code, 404);
  delete process.env.GARMIN_PUSH_KEY;
  try {
    eq('push key not configured', (await push({ activities: [SUMMARY] })).code, 404);
  } finally {
    process.env.GARMIN_PUSH_KEY = 'test-push-key';
  }
  eq('nothing queued', inbox().length, 0);
});

section('garminPush queues runs, run files, deregistrations and permission changes only', async function () {
  reset();
  var res = await push({
    activities: [SUMMARY, copy(SUMMARY, { activityId: 9002, activityType: 'CYCLING' }), copy(SUMMARY, { userId: undefined }), null],
    activityFiles: [FILE_ITEM, copy(FILE_ITEM, { activityId: 9003, activityType: 'CYCLING' })],
    deregistrations: [{ userId: 'g-111' }],
    userPermissionsChange: [{ userId: 'g-111', permissions: ['ACTIVITY_EXPORT'] }],
    somethingElse: [{ userId: 'g-111' }],
  });
  eq('answers 200', [res.code, res.body], [200, 'OK']);
  var q = inbox();
  eq('queued kinds', q.map(function (x) { return x.kind; }).sort(), ['activities', 'activityFiles', 'deregistrations', 'userPermissionsChange']);
  eq('only the run summary and run file', q.filter(function (x) { return x.item.activityId; }).map(function (x) { return x.item.activityId; }), [9001, 9001]);
  eq('each stamped on arrival', q.every(function (x) { return x.receivedAt instanceof Timestamp; }), true);
  eq('nothing sent to Garmin', calls, []);

  reset();
  eq('a kind that is not a list -> 200', (await push({ activities: SUMMARY })).code, 200);
  eq('and nothing queued', inbox().length, 0);
});

section('garminPush still answers 200 when queueing fails', async function () {
  reset();
  var realBatch = db.batch, res;
  db.batch = function () { throw new Error('backend down'); };
  try { res = await push({ activities: [SUMMARY] }); } finally { db.batch = realBatch; }
  eq('200', res.code, 200);
  eq('error logged', logged.some(function (l) { return /garminPush error/.test(l); }), true);
});

section('garminPush stores only what the worker reads, with an expiry', async function () {
  reset();
  await push({
    activities: [copy(SUMMARY, { manual: false, userId: 111 })],
    activityFiles: [copy(FILE_ITEM, { extra: 'made-up' })],
    deregistrations: [{ userId: 'g-111', extra: 'made-up' }],
  });
  var by = {};
  inbox().forEach(function (x) { by[x.kind] = x; });
  eq('summary: unread fields dropped', ['startTimeOffsetInSeconds' in by.activities.item, 'manual' in by.activities.item], [false, false]);
  eq('summary: Garmin user id stored as text', by.activities.item.userId, '111');
  eq('file: unread fields dropped', 'extra' in by.activityFiles.item, false);
  eq('file: URL kept for the worker', by.activityFiles.item.callbackURL, FILE_URL);
  eq('deregistration: the user id only', by.deregistrations.item, { userId: 'g-111' });
  eq('each expires a day after arrival', inbox().every(function (x) {
    return x.expireAt instanceof Timestamp && Math.round((x.expireAt.toMillis() - Date.now()) / 3600e3) === 24;
  }), true);
});

section('the inbox trigger runs one item per instance and retries what it hands back', async function () {
  var o = triggerOpts['garminInbox/{id}'];
  eq('concurrency, instances, retry', [o.concurrency, o.maxInstances, o.retry], [1, 5, true]);
});

section('a run summary becomes a Garmin run in Running Dynamics', async function () {
  linked();
  await push({ activities: [SUMMARY] });
  await work();
  var d = doc(RUN);
  eq('one run', runIds('u-a'), ['garmin_9001']);
  eq('source', d.source, 'garmin');
  eq('start', d.ts, T0);
  eq('summary fields', [d.durSec, d.avgHr, d.steps, d.cadence, d.deviceName], [2400, 150, 7000, 172, 'Forerunner 965']);
  var want = lib.runDocFromSummary(SUMMARY);
  eq('nothing the run needs is lost at intake', Object.keys(want).filter(function (k) { return JSON.stringify(d[k]) !== JSON.stringify(want[k]); }), []);
  eq('sync stamp', d.syncedAt instanceof Timestamp, true);
  eq('inbox drained', inbox().length, 0);
  eq('no Garmin calls', calls, []);
});

section('items for a Garmin account linked to nobody are dropped', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activities: [copy(SUMMARY, { userId: 'g-999' })], activityFiles: [copy(FILE_ITEM, { userId: 'g-999' })] });
  await work();
  eq('no runs', runIds('u-a'), []);
  eq('no download', calls, []);
  eq('inbox drained', inbox().length, 0);
});

fitSection('the activity file adds running dynamics to the run', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activities: [SUMMARY] }); await work();
  await push({ activityFiles: [FILE_ITEM] }); await work();
  var d = doc(RUN);
  eq('downloaded once', calls, ['GET file']);
  eq('still one run', runIds('u-a'), ['garmin_9001']);
  eq('GCT ms', d.gct, 245);
  eq('VO mm -> cm', d.vo, 8.5);
  eq('step mm -> m', d.stride, 1.2);
  eq('vertical ratio', d.vratio, 7.5);
  eq('GCT balance', d.gctBalL, 49.8);
  eq('training effect', d.aerobicTE, 3.2);
  eq('cadence from the file', d.cadence, 173);
  eq("summary's steps and title kept", [d.steps, d.title], [7000, 'Easy run']);
  eq('inbox drained', inbox().length, 0);
});

// A summary whose shared values differ from the file's (the file's are exact).
var LATE_SUMMARY = copy(SUMMARY, { averageRunCadenceInStepsPerMinute: 170, durationInSeconds: 2500, averageHeartRateInBeatsPerMinute: 149 });

fitSection('a file that lands before its summary keeps its values; a nameless one keeps the title', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activityFiles: [FILE_ITEM] }); await work();
  await push({ activities: [LATE_SUMMARY] }); await work();
  var d = doc(RUN);
  eq('dynamics kept', [d.gct, d.vo, d.stride], [245, 8.5, 1.2]);
  eq("file's cadence, duration and heart rate kept", [d.cadence, d.durSec, d.avgHr], [173, 2400, 150]);
  eq('steps added', d.steps, 7000);

  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activityFiles: [copy(FILE_ITEM, { activityName: undefined })] }); await work();
  await push({ activities: [copy(SUMMARY, { activityName: 'Lever session' })] }); await work();
  eq('an empty title is filled from the summary', [doc(RUN).title, doc(RUN).leverTitle], ['Lever session', true]);

  // The usual order: the summary first, then a file that carries no name.
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activities: [copy(SUMMARY, { activityName: 'Lever session' })] }); await work();
  await push({ activityFiles: [copy(FILE_ITEM, { activityName: undefined })] }); await work();
  eq("a nameless file keeps the summary's title", [doc(RUN).title, doc(RUN).leverTitle], ['Lever session', true]);
  eq('and still adds its dynamics', doc(RUN).gct, 245);
});

fitSection('a summary and its file handled at the same moment both land', async function () {
  var orders = { 'summary queued first': ['activities', 'activityFiles'], 'file queued first': ['activityFiles', 'activities'] };
  for (var name in orders) {
    linked();
    garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
    for (var i = 0; i < 2; i++) {
      var body = {};
      body[orders[name][i]] = [orders[name][i] === 'activities' ? LATE_SUMMARY : FILE_ITEM];
      await push(body);
    }
    await work();
    var d = doc(RUN);
    eq(name + ': one run', runIds('u-a'), ['garmin_9001']);
    eq(name + ": file's dynamics", [d.gct, d.vo], [245, 8.5]);
    eq(name + ": summary's steps", d.steps, 7000);
    eq(name + ": file's cadence and duration", [d.cadence, d.durSec], [173, 2400]);
  }
});

fitSection('a multisport file uses its running session', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([BIKE_SESSION, RUN_SESSION]);
  await push({ activityFiles: [FILE_ITEM] }); await work();
  var d = doc(RUN);
  eq('running session', [d.ts, d.durSec, d.gct], [T0, 2400, 245]);
});

section('a file that cannot be downloaded stores nothing and keeps its URL out of the logs', async function () {
  linked();
  garmin.files[FILE_URL] = null; // not available
  await push({ activityFiles: [FILE_ITEM] }); await work();
  eq('one try', calls, ['GET file']);
  eq('no run', runIds('u-a'), []);
  eq('status logged', logged.some(function (l) { return /404/.test(l) && /u-a/.test(l); }), true);
  eq('URL and its token never logged', logged.join('\n').indexOf('files.example.test') < 0 && logged.join('\n').indexOf('tok-secret') < 0, true);
  eq('inbox drained', inbox().length, 0);
});

fitSection('a file Garmin is too busy to send is kept and lands on retry', async function () {
  linked();
  garmin.files[FILE_URL] = 429;
  await push({ activityFiles: [FILE_ITEM] });
  eq('handed back for a retry', await workCountingRetries(), 1);
  eq('item kept', inbox().length, 1);
  eq('no run yet', runIds('u-a'), []);
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await work(); // the trigger's retry
  eq('run lands with its dynamics', doc(RUN) && doc(RUN).gct, 245);
  eq('two tries', calls, ['GET file', 'GET file']);
  eq('inbox drained', inbox().length, 0);

  linked();
  garmin.files[FILE_URL] = 503;
  await push({ activityFiles: [FILE_ITEM] });
  eq('a failing file server is retried too', await workCountingRetries(), 1);
  eq('URL never logged', logged.join('\n').indexOf('tok-secret') < 0, true);
});

section('a file URL never reaches the logs, even when the request itself fails', async function () {
  linked();
  // The fake fetch throws on a URL it does not know, naming the URL.
  await push({ activityFiles: [copy(FILE_ITEM, { callbackURL: 'https://files.example.test/activity-file?id=9004&token=tok-secret-9004' })] });
  eq('an unreachable file server is retried', await workCountingRetries(), 1);
  eq('error name logged with the uid', logged.some(function (l) { return /download failed for uid u-a: Error/.test(l); }), true);
  eq('URL and token never logged', logged.join('\n').indexOf('tok-secret') < 0 && logged.join('\n').indexOf('files.example.test') < 0, true);

  linked();
  await push({ activityFiles: [copy(FILE_ITEM, { callbackURL: 'https://exa mple.test/activity-file?token=tok-secret-bad' })] });
  eq('an unusable URL is dropped, not retried', await workCountingRetries(), 0);
  eq('never fetched', calls, []);
  eq('rejection logged without the URL', [logged.some(function (l) { return /URL rejected for uid u-a/.test(l); }), logged.join('\n').indexOf('tok-secret') < 0], [true, true]);
  eq('inbox drained', inbox().length, 0);
});

section('only FIT files with a URL are downloaded', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activityFiles: [copy(FILE_ITEM, { fileType: 'TCX' }), copy(FILE_ITEM, { callbackURL: undefined })] });
  await work();
  eq('no download', calls, []);
  eq('no run', runIds('u-a'), []);
});

section("the athlete's own upload wins; an overlapping Strava run is replaced", async function () {
  linked();
  seedRunAt('u-a', '20270115080030_running', T0 + 30e3, 2390);
  await push({ activities: [SUMMARY] }); await work();
  eq('own upload covers it -> skipped', runIds('u-a'), ['20270115080030_running']);

  linked();
  seedRunAt('u-a', 'strava_1', T0 + 20e3, 2390, 'strava');
  seedRunAt('u-a', 'strava_2', T0 + 6 * 3600e3, 1800, 'strava');
  seedRunAt('u-a', 'own_later', T0 + 8 * 3600e3, 1800);
  await push({ activities: [SUMMARY] }); await work();
  eq('overlapping Strava run replaced, the rest kept', runIds('u-a'), ['garmin_9001', 'own_later', 'strava_2']);
});

// A Strava sync that read the athlete's runs before the Garmin run existed can
// write its copy afterwards.
section('a Strava copy written after the Garmin run is replaced when the summary comes again', async function () {
  linked();
  await push({ activities: [SUMMARY] }); await work();
  seedRunAt('u-a', 'strava_race', T0 + 15e3, 2395, 'strava');
  await push({ activities: [SUMMARY] }); await work();
  eq('Strava copy gone', runIds('u-a'), ['garmin_9001']);
});

fitSection('a Strava copy written after the Garmin run is replaced when its file lands', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activities: [SUMMARY] }); await work();
  seedRunAt('u-a', 'strava_race', T0 + 15e3, 2395, 'strava');
  seedRunAt('u-a', 'strava_other_day', T0 + 3 * 86400e3, 1800, 'strava');
  await push({ activityFiles: [FILE_ITEM] }); await work();
  eq('overlapping Strava copy gone, the rest kept', runIds('u-a'), ['garmin_9001', 'strava_other_day']);
});

section('sharing turned off in Garmin Connect pauses new runs; turned on, they resume', async function () {
  linked();
  seedRunAt('u-a', 'garmin_1', T0 - 86400e3, 1800, 'garmin');
  await push({ userPermissionsChange: [{ userId: 'g-111', permissions: [] }] }); await work();
  eq('paused', doc('users/u-a').garminSharing, false);
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activities: [SUMMARY], activityFiles: [FILE_ITEM] }); await work();
  eq('nothing new while paused', runIds('u-a'), ['garmin_1']);
  eq('no download while paused', calls, []);
  eq('link and earlier runs kept', [doc('users/u-a').garminConnected, !!doc('users/u-a/private/garmin'), doc('garminUsers/g-111').uid], [true, true, 'u-a']);

  await push({ userPermissionsChange: [{ userId: 'g-111', permissions: ['ACTIVITY_EXPORT'] }] }); await work();
  eq('resumed', doc('users/u-a').garminSharing, true);
  await push({ activities: [SUMMARY] }); await work();
  eq('runs land again', runIds('u-a'), ['garmin_1', 'garmin_9001']);
});

// A permission change queued at receivedAt, as garminPush stores it.
function queuePermissionChange(id, permissions, receivedAtMs, gid) {
  store.set('garminInbox/' + id, {
    kind: 'userPermissionsChange', item: { userId: gid || 'g-111', permissions: permissions },
    receivedAt: Timestamp.fromMillis(receivedAtMs),
  });
}
function handle(id) { return g.onGarminInbox({ data: new Snap(new DocRef('garminInbox/' + id), doc('garminInbox/' + id)) }); }

section('sharing changes handled out of order leave the latest one in place', async function () {
  var now = Date.now();
  linked();
  queuePermissionChange('p-off', [], now - 2000);
  queuePermissionChange('p-on', ['ACTIVITY_EXPORT'], now - 1000);
  await handle('p-on'); await handle('p-off');
  eq('turned off then on, handled on-first: sharing on', doc('users/u-a').garminSharing, true);
  eq('inbox drained', inbox().length, 0);
  await push({ activities: [SUMMARY] }); await work();
  eq('runs keep landing', runIds('u-a'), ['garmin_9001']);

  linked();
  queuePermissionChange('p-on', ['ACTIVITY_EXPORT'], now - 2000);
  queuePermissionChange('p-off', [], now - 1000);
  await handle('p-off'); await handle('p-on');
  eq('turned on then off, handled off-first: sharing paused', doc('users/u-a').garminSharing, false);

  // A change that reached us before the link was made is older than the
  // link's own check of what was granted.
  reset();
  seedUser('u-a');
  queuePermissionChange('p-before', [], Date.now() - 60e3);
  var r = await startAndApprove('u-a');
  eq('connected', await finish('u-a', r.state, r.key), { result: 'connected' });
  await handle('p-before');
  eq('an older change does not pause a new link', doc('users/u-a').garminSharing, true);
});

section('a deregistration from Garmin deletes everything Garmin sent', async function () {
  linked();
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1'); seedRun('u-a', 'strava_1', 'strava');
  await push({ deregistrations: [{ userId: 'g-111' }] }); await work();
  eq('Garmin runs gone, the rest kept', runIds('u-a'), ['own_1', 'strava_1']);
  eq('tokens and mapping gone', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111')], [undefined, undefined]);
  eq('shown as disconnected', doc('users/u-a').garminConnected, false);
  eq('Garmin not called back', calls, []);
  await push({ activities: [SUMMARY] }); await work();
  eq('a late summary is dropped', runIds('u-a'), ['own_1', 'strava_1']);

  linked();
  seedRunNotes('u-a');
  await push({ deregistrations: [{ userId: 'g-111' }] }); await work();
  eq('Lever marks and exclusions on Garmin runs gone, own kept', runNoteIds('u-a'), OWN_NOTE_IDS);
});

section('a summary handled together with a deregistration leaves no Garmin run', async function () {
  var orders = { 'summary first': ['activities', 'deregistrations'], 'deregistration first': ['deregistrations', 'activities'] };
  for (var name in orders) {
    linked();
    var body = {};
    orders[name].forEach(function (k) { body[k] = [k === 'activities' ? SUMMARY : { userId: 'g-111' }]; });
    await push(body);
    await work();
    eq(name + ': no Garmin run', runIds('u-a'), []);
    eq(name + ': link ended', [doc('users/u-a').garminConnected, doc('garminUsers/g-111'), doc('users/u-a/private/garmin')], [false, undefined, undefined]);
  }
});

fitSection('a run whose file is still downloading when a deregistration lands is not stored', async function () {
  linked();
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  await push({ activityFiles: [FILE_ITEM] });
  await push({ deregistrations: [{ userId: 'g-111' }] });
  await work();
  eq('handled together: no Garmin run', runIds('u-a'), []);

  linked();
  seedRun('u-a', 'garmin_1', 'garmin');
  garmin.files[FILE_URL] = fitFile([RUN_SESSION]);
  var realFetch = global.fetch;
  global.fetch = async function (url, opts) {
    var r = await realFetch(url, opts);
    if (url === FILE_URL) await new Promise(function (res) { setTimeout(res, 50); });
    return r;
  };
  try {
    await push({ activityFiles: [FILE_ITEM] });
    var downloading = work();
    await new Promise(function (res) { setTimeout(res, 5); });
    await push({ deregistrations: [{ userId: 'g-111' }] });
    await work('deregistrations');
    await downloading;
  } finally {
    global.fetch = realFetch;
  }
  eq('the download had started', calls, ['GET file']);
  eq('slow file: no Garmin run left', runIds('u-a'), []);
  eq('link ended', [doc('users/u-a').garminConnected, doc('garminUsers/g-111')], [false, undefined]);
});

section('a deregistration that fails part-way is kept and finishes when retried', async function () {
  linked();
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'garmin_2', 'garmin'); seedRun('u-a', 'own_1');
  await push({ deregistrations: [{ userId: 'g-111' }] });
  var realBatch = db.batch, failed = false, retries;
  db.batch = function () {
    var b = realBatch();
    if (!failed) { failed = true; b.commit = async function () { throw new Error('DEADLINE_EXCEEDED'); }; }
    return b;
  };
  try { retries = await workCountingRetries(); } finally { db.batch = realBatch; }
  eq('handed back for a retry', retries, 1);
  eq('item kept', inbox().map(function (x) { return x.kind; }), ['deregistrations']);
  eq('the account can still be found', doc('garminUsers/g-111').uid, 'u-a');
  await work(); // the trigger's retry
  eq('Garmin runs gone, own kept', runIds('u-a'), ['own_1']);
  eq('tokens and mapping gone', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111')], [undefined, undefined]);
  eq('shown as disconnected', doc('users/u-a').garminConnected, false);
  eq('inbox drained', inbox().length, 0);
});

section('a deregistration removes queued runs and files for that Garmin account only', async function () {
  linked();
  // Items whose worker never finished (it crashed or timed out).
  store.set('garminInbox/stuck-file', { kind: 'activityFiles', item: { userId: 'g-111', callbackURL: FILE_URL } });
  store.set('garminInbox/stuck-run', { kind: 'activities', item: { userId: 'g-111', activityId: 9001 } });
  store.set('garminInbox/other', { kind: 'activities', item: { userId: 'g-222', activityId: 9002 } });
  await push({ deregistrations: [{ userId: 'g-111' }] });
  await work('deregistrations');
  eq('stuck items gone, the other account\'s kept', ['stuck-file', 'stuck-run', 'other'].map(function (id) { return store.has('garminInbox/' + id); }), [false, false, true]);
});

section('a mapping the account no longer holds writes no runs and is freed by its deregistration', async function () {
  linked(); // u-a holds g-111
  store.set('garminUsers/g-old', { uid: 'u-a' }); // left over from an earlier link
  seedRunAt('u-a', 'garmin_1', T0 - 86400e3, 1800, 'garmin');
  await push({ activities: [copy(SUMMARY, { userId: 'g-old' })] }); await work();
  eq('no run from the old account', runIds('u-a'), ['garmin_1']);
  await push({ deregistrations: [{ userId: 'g-old' }] }); await work();
  eq('old mapping freed', doc('garminUsers/g-old'), undefined);
  eq('current link and its runs kept', [doc('users/u-a/private/garmin').garminUserId, doc('garminUsers/g-111').uid, doc('users/u-a').garminConnected, runIds('u-a')], ['g-111', 'u-a', true, ['garmin_1']]);

  reset();
  store.set('garminUsers/g-111', { uid: 'u-gone' }); // the account was deleted
  await push({ deregistrations: [{ userId: 'g-111' }] });
  eq('a deleted account needs no retry', await workCountingRetries(), 0);
  eq('mapping freed', doc('garminUsers/g-111'), undefined);
  eq('no account doc made', doc('users/u-gone'), undefined);
});

section("a permission change for a left-over mapping leaves the current link's sharing alone", async function () {
  linked(); // u-a holds g-111
  store.set('garminUsers/g-old', { uid: 'u-a' }); // left over from an earlier link
  await push({ userPermissionsChange: [{ userId: 'g-old', permissions: [] }] }); await work();
  eq('current link still sharing', doc('users/u-a').garminSharing, true);
  eq('old mapping freed', doc('garminUsers/g-old'), undefined);
  eq('current mapping kept', doc('garminUsers/g-111').uid, 'u-a');
  await push({ activities: [SUMMARY] }); await work();
  eq('runs from the current link land', runIds('u-a'), ['garmin_9001']);

  reset();
  store.set('garminUsers/g-111', { uid: 'u-gone' }); // the account was deleted
  await push({ userPermissionsChange: [{ userId: 'g-111', permissions: [] }] }); await work();
  eq('an ended link: nothing written', doc('users/u-gone'), undefined);
  eq('inbox drained', inbox().length, 0);
});

section('a switch whose purge fails part-way is finished by the next try', async function () {
  reset();
  seedUser('u-a'); seedLink('u-a', 'g-old'); seedRun('u-a', 'garmin_old', 'garmin'); seedRun('u-a', 'own_1');
  garmin.userId = 'g-new';
  var r = await startAndApprove('u-a');
  var realBatch = db.batch, failed = false, res;
  db.batch = function () {
    var b = realBatch();
    if (!failed) { failed = true; b.commit = async function () { throw new Error('DEADLINE_EXCEEDED'); }; }
    return b;
  };
  try { res = await finish('u-a', r.state, r.key); } finally { db.batch = realBatch; }
  eq('first try fails', res, { result: 'error', reason: 'exchange' });
  eq('tokens gone, old mapping left', [doc('users/u-a/private/garmin'), doc('garminUsers/g-old').uid], [undefined, 'u-a']);
  await push({ userPermissionsChange: [{ userId: 'g-old', permissions: [] }] }); await work();
  eq('a permission change for the old account changes nothing', doc('users/u-a').garminSharing, true);

  r = await startAndApprove('u-a');
  eq('next try connects', await finish('u-a', r.state, r.key), { result: 'connected' });
  eq('old runs gone, own kept', runIds('u-a'), ['own_1']);
  eq('old mapping freed', doc('garminUsers/g-old'), undefined);
  eq('new link', [doc('users/u-a/private/garmin').garminUserId, doc('garminUsers/g-new').uid, doc('users/u-a').garminConnected, doc('users/u-a').garminSharing], ['g-new', 'u-a', true, true]);
  await push({ userPermissionsChange: [{ userId: 'g-old', permissions: [] }] });
  await push({ activities: [copy(SUMMARY, { userId: 'g-new' })] }); await work();
  eq('runs from the new account land', runIds('u-a'), ['garmin_9001', 'own_1']);
});

function ticks(n) {
  var p = Promise.resolve();
  for (var i = 0; i < n; i++) p = p.then(function () { return later(); });
  return p;
}

section('a deregistration for the old account during a switch leaves the new link whole', async function () {
  // The deregistration starts n event-loop turns after the switch deletes the
  // old tokens, so it lands at each step of the switch in turn.
  for (var n = 0; n <= 12; n++) {
    reset();
    seedUser('u-a'); seedLink('u-a', 'g-old'); seedRun('u-a', 'garmin_old', 'garmin'); seedRun('u-a', 'own_1');
    garmin.userId = 'g-new';
    var r = await startAndApprove('u-a');
    await push({ deregistrations: [{ userId: 'g-old' }] });
    var dereg = inboxSnaps('deregistrations')[0];
    var realDelete = DocRef.prototype._delete, started = null, res;
    DocRef.prototype._delete = function () {
      realDelete.call(this);
      if (this.path === 'users/u-a/private/garmin' && !started) {
        started = ticks(n).then(function () { return g.onGarminInbox({ data: dereg }); });
      }
    };
    try {
      res = await finish('u-a', r.state, r.key);
      await started;
    } finally {
      DocRef.prototype._delete = realDelete;
    }
    var p = doc('users/u-a/private/garmin'), u = doc('users/u-a');
    eq('n=' + n + ': connected', res, { result: 'connected' });
    eq('n=' + n + ': new tokens kept', p && p.garminUserId, 'g-new');
    eq('n=' + n + ': mappings', [doc('garminUsers/g-new') && doc('garminUsers/g-new').uid, doc('garminUsers/g-old')], ['u-a', undefined]);
    eq('n=' + n + ': shown as connected and sharing', [u.garminConnected, u.garminSharing], [true, true]);
    eq('n=' + n + ': old runs gone, own kept', runIds('u-a'), ['own_1']);
  }
});

section('an item that fails is still removed from the inbox', async function () {
  linked();
  var realTx = db.runTransaction;
  db.runTransaction = function () { return Promise.reject(new Error('ABORTED')); };
  try { await push({ activities: [SUMMARY] }); await work(); } finally { db.runTransaction = realTx; }
  eq('inbox drained', inbox().length, 0);
  eq('error logged', logged.some(function (l) { return /onGarminInbox activities error/.test(l); }), true);
  eq('no run', runIds('u-a'), []);
});

// ── Disconnect and token upkeep ──────────────────────────────────

function disconnect(uid, data) { return g.disconnectGarmin({ auth: uid ? { uid: uid } : null, data: data || {} }); }
function tokensNeverLogged() {
  var all = logged.join('\n');
  return ['acc-', 'ref-', 'stored-'].every(function (t) { return all.indexOf(t) < 0; });
}

section('disconnectGarmin tells Garmin and deletes every run Garmin sent', async function () {
  reset();
  var threw = null;
  try { await disconnect(null); } catch (e) { threw = e.code; }
  eq('signed out is refused', threw, 'unauthenticated');
  eq('no calls', calls, []);

  linked();
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'garmin_2', 'garmin'); seedRun('u-a', 'own_1'); seedRun('u-a', 'strava_1', 'strava');
  store.set('garminInbox/stuck-run', { kind: 'activities', item: { userId: 'g-111', activityId: 9001 } });
  var res = await disconnect('u-a');
  eq('returns how many runs went', res, { deleted: 2 });
  eq('Garmin told with the stored token', calls, ['DELETE registration Bearer stored-u-a']);
  eq('Garmin runs gone, the rest kept', runIds('u-a'), ['own_1', 'strava_1']);
  eq('tokens and mapping gone', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111')], [undefined, undefined]);
  eq('queued runs gone', store.has('garminInbox/stuck-run'), false);
  var u = doc('users/u-a');
  eq('shown as disconnected', [u.garminConnected, 'garminSharing' in u, 'garminConnectedAt' in u], [false, false, false]);
  eq('disconnect time stamped', u.garminDisconnectedAt instanceof Timestamp, true);
  eq('no empty note lists added', ['runLeverMarks' in u, 'runExcluded' in u], [false, false]);
  eq('count and uid logged', logged.some(function (l) { return /disconnectGarmin: purged 2 runs for uid u-a/.test(l); }), true);
  eq('no token logged', tokensNeverLogged(), true);
  await push({ activities: [SUMMARY] }); await work();
  eq('a late summary is dropped', runIds('u-a'), ['own_1', 'strava_1']);
});

section('disconnectGarmin removes Lever marks and exclusions made on Garmin runs', async function () {
  linked();
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'garmin_2', 'garmin'); seedRun('u-a', 'own_1');
  seedRunNotes('u-a');
  await disconnect('u-a');
  eq('own marks and exclusions kept, none naming a Garmin run', runNoteIds('u-a'), OWN_NOTE_IDS);
  var u = JSON.stringify(doc('users/u-a'));
  eq('no Garmin run id, start or distance left on the user doc', [u.indexOf('garmin_'), u.indexOf('5.01'), u.indexOf('1700000600000')], [-1, -1, -1]);
  eq('own mark kept whole', doc('users/u-a').runLeverMarks[0], { id: '20231114221320_treadmillrunning', lever: false, ts: 1700000000000, mi: 3.1 });

  // A link made while the purge ran keeps its flags, but the runs went, so
  // their notes go too.
  linked();
  seedRun('u-a', 'garmin_1', 'garmin');
  seedRunNotes('u-a');
  var realBatch = db.batch;
  db.batch = function () {
    var b = realBatch(), commit = b.commit;
    b.commit = function () { store.set('users/u-a/private/garmin', { garminUserId: 'g-222', accessToken: 'stored-new' }); return commit(); };
    return b;
  };
  try { await disconnect('u-a'); } finally { db.batch = realBatch; }
  eq('new link: still shown as connected', doc('users/u-a').garminConnected, true);
  eq('new link: notes on the deleted runs gone', runNoteIds('u-a'), OWN_NOTE_IDS);
});

// Another tab finishes a link for uid to gid while a disconnect runs: its token
// doc, mapping and a queued run land when the disconnect's batch number `at`
// commits (1: its runs are deleted; 2: queued items of the old link are).
function landLinkDuringBatch(uid, gid, at) {
  var realBatch = db.batch, n = 0;
  db.batch = function () {
    var b = realBatch(), commit = b.commit;
    b.commit = function () {
      if (++n === at) {
        store.set('users/' + uid + '/private/garmin', {
          accessToken: 'stored-new', refreshToken: 'stored-ref-new', garminUserId: gid,
          expiresAt: Date.now() + 3600e3, refreshExpiresAt: Date.now() + 5 * 86400e3,
        });
        store.set('garminUsers/' + gid, { uid: uid });
        Object.assign(store.get('users/' + uid), { garminConnected: true, garminSharing: true });
        store.set('garminInbox/new-run', { kind: 'activities', item: { userId: gid, activityId: 9002 } });
      }
      return commit();
    };
    return b;
  };
  return function restore() { db.batch = realBatch; };
}

section('a link finished while a disconnect runs keeps its mapping and is renewed', async function () {
  var cases = [
    ['another Garmin account, landing as the runs go', 'g-222', 1],
    ['the same Garmin account, landing as the queue is cleared', 'g-111', 2],
  ];
  for (var i = 0; i < cases.length; i++) {
    var name = cases[i][0], gid = cases[i][1];
    linked();
    seedRun('u-a', 'garmin_1', 'garmin');
    store.set('garminInbox/stuck-run', { kind: 'activities', item: { userId: 'g-111', activityId: 9001 } });
    var restore = landLinkDuringBatch('u-a', gid, cases[i][2]), res;
    try { res = await disconnect('u-a'); } finally { restore(); }
    eq(name + ': old runs deleted', [res, runIds('u-a')], [{ deleted: 1 }, []]);
    eq(name + ': new link whole', [doc('users/u-a/private/garmin').garminUserId, doc('garminUsers/' + gid) && doc('garminUsers/' + gid).uid, doc('users/u-a').garminConnected], [gid, 'u-a', true]);
    eq(name + ': its queued run kept', store.has('garminInbox/new-run'), true);
    if (gid !== 'g-111') eq(name + ': old mapping freed', doc('garminUsers/g-111'), undefined);
    calls = [];
    await g.refreshGarminTokens({});
    eq(name + ': renewed by the daily job', [calls, doc('users/u-a/private/garmin').refreshToken], [['POST token'], 'ref-' + tokenSeq]);
  }
});

// Runs fn the first time a request whose URL matches re reaches Garmin, before
// that request is answered.
function onGarminRequest(re, fn) {
  var realFetch = global.fetch, fired = false;
  global.fetch = async function (url, opts) {
    if (!fired && re.test(url)) { fired = true; await fn(); }
    return realFetch(url, opts);
  };
  return function restore() { global.fetch = realFetch; };
}

section('a link finished in another tab while disconnect is telling Garmin stays whole', async function () {
  var cases = [
    ['another Garmin account, during the deregistration', 'g-222', /\/user\/registration$/],
    ['the same Garmin account, during the deregistration', 'g-111', /\/user\/registration$/],
    ['another Garmin account, during the renewal', 'g-222', /oauth\/token$/],
  ];
  for (var i = 0; i < cases.length; i++) {
    var name = cases[i][0], gid = cases[i][1];
    linked();
    seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
    store.set('garminInbox/stuck-run', { kind: 'activities', item: { userId: 'g-111', activityId: 9001 } });
    if (/renewal/.test(name)) doc('users/u-a/private/garmin').expiresAt = Date.now() - 1;
    garmin.userId = gid;
    var r = await startAndApprove('u-a'), linkRes = null, linkedWith = null, res;
    var restore = onGarminRequest(cases[i][2], async function () {
      linkRes = await finish('u-a', r.state, r.key);
      linkedWith = 'acc-' + tokenSeq;
    });
    try { res = await disconnect('u-a'); } finally { restore(); }
    var told = /renewal/.test(name) ? 'acc-' + tokenSeq : 'stored-u-a';
    var p = doc('users/u-a/private/garmin') || {}, u = doc('users/u-a'), m = doc('garminUsers/' + gid) || {};
    eq(name + ': the other tab was told it is linked', linkRes, { result: 'connected' });
    eq(name + ': the old link told Garmin, the new one not', deletes(), ['DELETE registration Bearer ' + told]);
    // Linking another account counts as a switch, so that tab may delete the old runs first.
    eq(name + ': old runs deleted, own kept', [typeof res.deleted, runIds('u-a')], ['number', ['own_1']]);
    eq(name + ': new link whole', [p.garminUserId, p.accessToken, m.uid, u.garminConnected, u.garminSharing], [gid, linkedWith, 'u-a', true, true]);
    if (gid !== 'g-111') eq(name + ': old mapping and its queued run gone', [doc('garminUsers/g-111'), store.has('garminInbox/stuck-run')], [undefined, false]);
    eq(name + ': no token logged', tokensNeverLogged(), true);
  }
});

section('a switch that another tab beats to a link is undone with Garmin, and that link stays', async function () {
  reset();
  seedUser('u-a'); seedLink('u-a', 'g-old'); seedRun('u-a', 'garmin_old', 'garmin'); seedRun('u-a', 'own_1');
  garmin.userId = 'g-new';
  var a = await startAndApprove('u-a'), b = await startAndApprove('u-a'), resB = null;
  var first = tokenSeq + 1, second = tokenSeq + 2;
  // Tab A is switching to g-new; tab B links g-333 while A tells Garmin the old link ended.
  var restore = onGarminRequest(/\/user\/registration$/, async function () {
    garmin.userId = 'g-333';
    resB = await finish('u-a', b.state, b.key);
  });
  var resA;
  try { resA = await finish('u-a', a.state, a.key); } finally { restore(); }
  var p = doc('users/u-a/private/garmin') || {}, u = doc('users/u-a');
  eq('tab B linked', resB, { result: 'connected' });
  eq('tab A told it did not link', resA, { result: 'error', reason: 'busy' });
  eq("Garmin told of the old link and of tab A's", deletes(), ['DELETE registration Bearer stored-u-a', 'DELETE registration Bearer acc-' + first]);
  eq("tab B's link whole", [p.garminUserId, p.accessToken, doc('garminUsers/g-333') && doc('garminUsers/g-333').uid, u.garminConnected, u.garminSharing], ['g-333', 'acc-' + second, 'u-a', true, true]);
  eq('no mapping for the old account or tab A', [doc('garminUsers/g-old'), doc('garminUsers/g-new')], [undefined, undefined]);
  eq('old runs gone, own kept', runIds('u-a'), ['own_1']);
  eq('no token logged', tokensNeverLogged(), true);
});

section('a re-link without sharing keeps a link another tab made while Garmin was told', async function () {
  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111'); seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
  garmin.permissions = [];
  var a = await startAndApprove('u-a'), b = await startAndApprove('u-a'), resB = null;
  var first = tokenSeq + 1, second = tokenSeq + 2;
  // Tab A re-links g-111 without sharing; tab B links g-222 while A tells Garmin.
  var restore = onGarminRequest(/\/user\/registration$/, async function () {
    garmin.userId = 'g-222'; garmin.permissions = ['ACTIVITY_EXPORT'];
    resB = await finish('u-a', b.state, b.key);
  });
  var resA;
  try { resA = await finish('u-a', a.state, a.key); } finally { restore(); }
  var p = doc('users/u-a/private/garmin') || {}, u = doc('users/u-a');
  eq('tab A: scope', resA, { result: 'scope' });
  eq('tab B linked', resB, { result: 'connected' });
  eq('Garmin told of the old link and of tab A\'s', deletes(), ['DELETE registration Bearer stored-u-a', 'DELETE registration Bearer acc-' + first]);
  eq("tab B's link whole", [p.garminUserId, p.accessToken, doc('garminUsers/g-222') && doc('garminUsers/g-222').uid, u.garminConnected], ['g-222', 'acc-' + second, 'u-a', true]);
  eq('old mapping gone', doc('garminUsers/g-111'), undefined);
  eq('old runs gone, own kept', runIds('u-a'), ['own_1']);
});

section('a re-link whose permission check fails leaves a switch or disconnect made in another tab alone', async function () {
  // Tab A re-links g-111. While it asks Garmin what was granted, another tab
  // switches u-a to g-222 (or disconnects), and then A's request fails.
  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111'); seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
  var a = await startAndApprove('u-a'), b = await startAndApprove('u-a'), resB = null;
  var first = tokenSeq + 1, second = tokenSeq + 2;
  var restore = onGarminRequest(/\/user\/permissions$/, async function () {
    garmin.userId = 'g-222';
    resB = await finish('u-a', b.state, b.key);
    garmin.permStatus = 503;
  });
  var resA;
  try { resA = await finish('u-a', a.state, a.key); } finally { restore(); }
  var p = doc('users/u-a/private/garmin') || {}, u = doc('users/u-a');
  eq('switch: tab B linked', resB, { result: 'connected' });
  eq('switch: tab A told it did not link', resA, { result: 'error', reason: 'busy' });
  eq("switch: Garmin told of the old link and of tab A's", deletes(), ['DELETE registration Bearer stored-u-a', 'DELETE registration Bearer acc-' + first]);
  eq("switch: tab B's link keeps its own tokens", [p.garminUserId, p.accessToken, p.refreshToken], ['g-222', 'acc-' + second, 'ref-' + second]);
  eq("switch: tab B's mapping and flags", [doc('garminUsers/g-222') && doc('garminUsers/g-222').uid, doc('garminUsers/g-111'), u.garminConnected, u.garminSharing], ['u-a', undefined, true, true]);
  eq('switch: old runs gone, own kept', runIds('u-a'), ['own_1']);
  eq('switch: no token logged', tokensNeverLogged(), true);

  reset();
  seedUser('u-a'); seedLink('u-a', 'g-111'); seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
  a = await startAndApprove('u-a');
  first = tokenSeq + 1;
  var resD = null;
  restore = onGarminRequest(/\/user\/permissions$/, async function () {
    resD = await disconnect('u-a');
    garmin.permStatus = 503;
  });
  try { resA = await finish('u-a', a.state, a.key); } finally { restore(); }
  eq('disconnect: done', resD, { deleted: 1 });
  eq('disconnect: tab A told it did not link', resA, { result: 'error', reason: 'busy' });
  eq("disconnect: Garmin told of the old link and of tab A's", deletes(), ['DELETE registration Bearer stored-u-a', 'DELETE registration Bearer acc-' + first]);
  eq('disconnect: no token doc left behind', doc('users/u-a/private/garmin'), undefined);
  eq('disconnect: mapping gone, shown as disconnected', [doc('garminUsers/g-111'), doc('users/u-a').garminConnected], [undefined, false]);
  eq('disconnect: Garmin runs gone, own kept', runIds('u-a'), ['own_1']);
  eq('disconnect: no token logged', tokensNeverLogged(), true);
});

section('a new link whose permission check fails leaves a link another tab made to the same Garmin account alone', async function () {
  // Tab A links g-111. While it asks Garmin what was granted, tab B links
  // g-111 too (in the last case, g-222), and then A's request fails.
  var cases = [
    ['no link before', null, 'g-111'],
    ['switching from another account', 'g-old', 'g-111'],
    ['tab B links another account', null, 'g-222'],
  ];
  for (var i = 0; i < cases.length; i++) {
    var name = cases[i][0], before = cases[i][1], gidB = cases[i][2];
    reset();
    seedUser('u-a'); seedRun('u-a', 'own_1');
    if (before) { seedLink('u-a', before); seedRun('u-a', 'garmin_old', 'garmin'); }
    var a = await startAndApprove('u-a'), b = await startAndApprove('u-a'), resB = null, resA;
    var first = tokenSeq + 1, second = tokenSeq + 2;
    var restore = onGarminRequest(/\/user\/permissions$/, async function () {
      garmin.userId = gidB;
      resB = await finish('u-a', b.state, b.key);
      garmin.permStatus = 503;
    });
    try { resA = await finish('u-a', a.state, a.key); } finally { restore(); }
    var p = doc('users/u-a/private/garmin') || {}, u = doc('users/u-a'), m = doc('garminUsers/' + gidB) || {};
    var told = (before ? ['DELETE registration Bearer stored-u-a'] : [])
      .concat(gidB === 'g-111' ? [] : ['DELETE registration Bearer acc-' + first]);
    eq(name + ': tab B linked', resB, { result: 'connected' });
    eq(name + ': tab A gets an error', resA, { result: 'error', reason: 'exchange' });
    eq(name + ': Garmin told only of links that ended', deletes(), told);
    eq(name + ": tab B's link whole", [p.garminUserId, p.accessToken, p.refreshToken, m.uid, u.garminConnected, u.garminSharing], [gidB, 'acc-' + second, 'ref-' + second, 'u-a', true, true]);
    eq(name + ': no other mapping', [doc('garminUsers/g-old'), gidB === 'g-111' ? undefined : doc('garminUsers/g-111')], [undefined, undefined]);
    eq(name + ': old runs gone, own kept', runIds('u-a'), ['own_1']);
    eq(name + ': no token logged', tokensNeverLogged(), true);
  }
});

section("disconnectGarmin ends only the caller's own link", async function () {
  linked(); // u-a holds g-111
  seedUser('u-b'); seedRun('u-a', 'garmin_1', 'garmin');
  eq('nothing to delete for u-b', await disconnect('u-b', { uid: 'u-a', athleteUid: 'u-a' }), { deleted: 0 });
  eq('Garmin not called', calls, []);
  eq("u-a's link and runs kept", [doc('users/u-a/private/garmin').garminUserId, doc('garminUsers/g-111').uid, doc('users/u-a').garminConnected, runIds('u-a')], ['g-111', 'u-a', true, ['garmin_1']]);
});

section('disconnectGarmin refreshes an expired token before telling Garmin', async function () {
  linked();
  doc('users/u-a/private/garmin').expiresAt = Date.now() - 1;
  await disconnect('u-a');
  eq('refreshed, then told with the new token', calls, ['POST token', 'DELETE registration Bearer acc-' + tokenSeq]);
  eq('tokens gone', doc('users/u-a/private/garmin'), undefined);
});

section('disconnectGarmin still deletes everything when Garmin cannot be told', async function () {
  // The refresh token has lapsed: no call can be made.
  linked();
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
  var p = doc('users/u-a/private/garmin');
  p.expiresAt = Date.now() - 1; p.refreshExpiresAt = Date.now() - 1;
  eq('lapsed token: runs deleted', await disconnect('u-a'), { deleted: 1 });
  eq('lapsed token: no Garmin call', calls, []);
  eq('lapsed token: link ended', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111'), doc('users/u-a').garminConnected], [undefined, undefined, false]);

  // Garmin refuses, or cannot be reached.
  var outcomes = { 'Garmin refuses': 500, 'Garmin unreachable': 'throw' };
  for (var name in outcomes) {
    linked();
    seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
    var realFetch = global.fetch, outcome = outcomes[name];
    global.fetch = async function (url, opts) {
      if (/\/user\/registration$/.test(url)) {
        calls.push('DELETE registration');
        if (outcome === 'throw') throw new Error('connect ECONNREFUSED');
        return reply(outcome, null);
      }
      return realFetch(url, opts);
    };
    var res;
    try { res = await disconnect('u-a'); } finally { global.fetch = realFetch; }
    eq(name + ': Garmin was tried', calls, ['DELETE registration']);
    eq(name + ': runs deleted', [res, runIds('u-a')], [{ deleted: 1 }, ['own_1']]);
    eq(name + ': link ended', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111'), doc('users/u-a').garminConnected], [undefined, undefined, false]);
    eq(name + ': no token logged', tokensNeverLogged(), true);
  }
});

section('disconnectGarmin finishes a purge that failed part-way', async function () {
  reset();
  seedUser('u-a', { garminConnected: true, garminSharing: true });
  // Tokens already gone; the mapping and some runs were left behind.
  store.set('garminUsers/g-111', { uid: 'u-a' });
  seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
  eq('left-over runs deleted', await disconnect('u-a'), { deleted: 1 });
  eq('no Garmin call without a token', calls, []);
  eq('mapping freed', doc('garminUsers/g-111'), undefined);
  eq('shown as disconnected', doc('users/u-a').garminConnected, false);
  eq('own run kept', runIds('u-a'), ['own_1']);
});

// A link for uid to gid whose refresh token lapses in daysLeft days.
function seedLinkLapsingIn(uid, gid, daysLeft) {
  seedUser(uid); seedLink(uid, gid);
  var p = doc('users/' + uid + '/private/garmin');
  p.refreshExpiresAt = Date.now() + daysLeft * 86400e3;
  p.sharingChangedAt = 12345;
  return p;
}

section('refreshGarminTokens renews links within 30 days of lapsing, and only those', async function () {
  reset();
  seedLinkLapsingIn('u-soon', 'g-soon', 10);
  seedLinkLapsingIn('u-later', 'g-later', 45);
  store.set('garminUsers/g-gone', { uid: 'u-gone' }); // a mapping with no token left
  await g.refreshGarminTokens({});
  eq('one refresh', calls, ['POST token']);
  var p = doc('users/u-soon/private/garmin');
  eq('new tokens stored', [p.accessToken, p.refreshToken], ['acc-' + tokenSeq, 'ref-' + tokenSeq]);
  eq('new lapse time stored', Math.round((p.refreshExpiresAt - Date.now()) / 1000), 7776000);
  eq('rest of the link kept', [p.garminUserId, p.sharingChangedAt], ['g-soon', 12345]);
  eq('a link not yet due is left alone', doc('users/u-later/private/garmin').refreshToken, 'stored-ref-u-later');
  eq('no token made for a mapping without one', doc('users/u-gone/private/garmin'), undefined);
  eq('count logged', logged.some(function (l) { return /refreshGarminTokens: renewed 1 of 3/.test(l); }), true);
  eq('no token logged', tokensNeverLogged(), true);
});

section('refreshGarminTokens: one failed renewal does not stop the rest', async function () {
  reset();
  seedLinkLapsingIn('u-a', 'g-a', 5);
  seedLinkLapsingIn('u-b', 'g-b', 5);
  var realFetch = global.fetch, first = true;
  global.fetch = async function (url, opts) {
    if (/oauth\/token$/.test(url) && first) { first = false; calls.push('POST token'); return reply(400, {}); }
    return realFetch(url, opts);
  };
  try { await g.refreshGarminTokens({}); } finally { global.fetch = realFetch; }
  eq('both tried', calls, ['POST token', 'POST token']);
  var kept = [doc('users/u-a/private/garmin').refreshToken, doc('users/u-b/private/garmin').refreshToken].filter(function (t) { return /^stored-/.test(t); });
  eq('the failed one keeps its stored tokens, the other is renewed', kept.length, 1);
  eq('failure logged with the uid and status only', logged.some(function (l) { return /refreshGarminTokens: uid u-[ab] failed: garmin token HTTP 400/.test(l); }), true);
  eq('count logged', logged.some(function (l) { return /renewed 1 of 2/.test(l); }), true);
  eq('no token logged', tokensNeverLogged(), true);
});

section('a disconnect while a renewal is in flight leaves no tokens behind', async function () {
  reset();
  seedLinkLapsingIn('u-a', 'g-111', 5);
  seedRun('u-a', 'garmin_1', 'garmin');
  var realFetch = global.fetch, disconnected = null;
  global.fetch = async function (url, opts) {
    if (/oauth\/token$/.test(url) && !disconnected) {
      disconnected = disconnect('u-a');
      await disconnected;
    }
    return realFetch(url, opts);
  };
  try { await g.refreshGarminTokens({}); } finally { global.fetch = realFetch; }
  eq('disconnected', await disconnected, { deleted: 1 });
  eq('tokens stay gone', doc('users/u-a/private/garmin'), undefined);
  eq('shown as disconnected', doc('users/u-a').garminConnected, false);
  eq('mapping stays gone', doc('garminUsers/g-111'), undefined);
  eq('nothing counted as renewed', logged.some(function (l) { return /renewed 0 of 1/.test(l); }), true);

  // A newer token stored while the renewal ran (a re-link) is not overwritten.
  reset();
  seedLinkLapsingIn('u-a', 'g-111', 5);
  realFetch = global.fetch;
  global.fetch = async function (url, opts) {
    var r = await realFetch(url, opts);
    if (/oauth\/token$/.test(url)) Object.assign(doc('users/u-a/private/garmin'), { accessToken: 'relinked', refreshToken: 'relinked-ref' });
    return r;
  };
  try { await g.refreshGarminTokens({}); } finally { global.fetch = realFetch; }
  eq('the newer tokens kept', [doc('users/u-a/private/garmin').accessToken, doc('users/u-a/private/garmin').refreshToken], ['relinked', 'relinked-ref']);
  eq('a link that carries on is not deregistered', calls.filter(function (c) { return c.indexOf('DELETE') === 0; }), []);
});

// A Garmin token endpoint that refuses a refresh token it has already been
// sent once. onFirstRenewal runs when the first renewal reaches it, before
// (`before`) or after (`after`) that renewal is answered.
function refusingReusedRefreshTokens(when, onFirstRenewal) {
  var realFetch = global.fetch, used = new Set(), fired = false;
  global.fetch = async function (url, opts) {
    var rt = /oauth\/token$/.test(url) ? new URLSearchParams(opts.body).get('refresh_token') : null;
    if (!rt) return realFetch(url, opts);
    var fire = !fired;
    fired = true;
    if (fire && when === 'before') await onFirstRenewal();
    var r;
    if (used.has(rt)) { calls.push('POST token (reused, refused)'); r = reply(400, {}); }
    else { used.add(rt); r = await realFetch(url, opts); }
    if (fire && when === 'after') await onFirstRenewal();
    return r;
  };
  return function restore() { global.fetch = realFetch; };
}
function deletes() { return calls.filter(function (c) { return c.indexOf('DELETE') === 0; }); }

section('a disconnect during a renewal still has Garmin told, whichever renewal Garmin refuses', async function () {
  // The stored access token has expired, so the disconnect must renew it too.
  var orders = {
    'the daily renewal reaches Garmin first': 'after',
    "the disconnect's renewal reaches Garmin first": 'before',
  };
  for (var name in orders) {
    reset();
    var p = seedLinkLapsingIn('u-a', 'g-111', 5);
    p.expiresAt = Date.now() - 1;
    seedRun('u-a', 'garmin_1', 'garmin');
    var disconnected = null;
    var restore = refusingReusedRefreshTokens(orders[name], function () { return (disconnected = disconnect('u-a')); });
    try { await g.refreshGarminTokens({}); } finally { restore(); }
    eq(name + ': disconnected', await disconnected, { deleted: 1 });
    eq(name + ': one renewal refused', calls.filter(function (c) { return /refused/.test(c); }).length, 1);
    eq(name + ': Garmin told once, with the token Garmin issued', deletes(), ['DELETE registration Bearer acc-' + tokenSeq]);
    eq(name + ': tokens, mapping and runs gone', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111'), runIds('u-a')], [undefined, undefined, []]);
    eq(name + ': nothing counted as renewed', logged.some(function (l) { return /renewed 0 of 1/.test(l); }), true);
    eq(name + ': no token logged', tokensNeverLogged(), true);
  }
});

section('switching Garmin accounts during a renewal: the old account is told, the new link kept', async function () {
  reset();
  var p = seedLinkLapsingIn('u-a', 'g-old', 5);
  p.expiresAt = Date.now() - 1;
  garmin.userId = 'g-new';
  var r = await startAndApprove('u-a'), res = null, renewedFor = null;
  var restore = refusingReusedRefreshTokens('after', async function () {
    renewedFor = 'acc-' + tokenSeq;
    res = await finish('u-a', r.state, r.key);
  });
  try { await g.refreshGarminTokens({}); } finally { restore(); }
  var q = doc('users/u-a/private/garmin');
  eq('switch connected', res, { result: 'connected' });
  eq("the switch's own renewal was refused", calls.indexOf('POST token (reused, refused)') >= 0, true);
  eq('the old account told with the renewed token', deletes(), ['DELETE registration Bearer ' + renewedFor]);
  eq('new link kept', [q.garminUserId, q.accessToken !== renewedFor, doc('garminUsers/g-new').uid, doc('users/u-a').garminConnected], ['g-new', true, 'u-a', true]);
  eq('old mapping gone', doc('garminUsers/g-old'), undefined);
});

// Garmin accepting the requests stalls(url) picks and never answering them.
// AbortSignal.timeout is replaced so each request's own timeout fires at once
// and the test doesn't wait for it; the timeouts asked for are kept.
function stallingGarmin(stalls) {
  var realFetch = global.fetch, realTimeout = AbortSignal.timeout, asked = [];
  AbortSignal.timeout = function (ms) {
    asked.push(ms);
    var c = new AbortController();
    setTimeout(function () { c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); }, 5);
    return c.signal;
  };
  global.fetch = function (url, opts) {
    if (!stalls(url)) return realFetch(url, opts);
    calls.push('stalled');
    return new Promise(function (res, rej) {
      var s = opts && opts.signal;
      if (s) s.addEventListener('abort', function () { rej(s.reason); });
    });
  };
  return { asked: asked, restore: function () { global.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}
// p, or 'still waiting' if it has not settled within ms.
function within(ms, p) {
  var t;
  return Promise.race([p, new Promise(function (r) { t = setTimeout(r, ms, 'still waiting'); })]).finally(function () { clearTimeout(t); });
}

section('disconnectGarmin still deletes everything when Garmin never answers', async function () {
  var stalls = { 'the deregistration stalls': /\/user\/registration$/, 'the renewal stalls': /oauth\/token$/ };
  for (var name in stalls) {
    linked();
    seedRun('u-a', 'garmin_1', 'garmin'); seedRun('u-a', 'own_1');
    if (/renewal/.test(name)) doc('users/u-a/private/garmin').expiresAt = Date.now() - 1;
    var re = stalls[name], s = stallingGarmin(function (url) { return re.test(url); }), res;
    try { res = await within(1000, disconnect('u-a')); } finally { s.restore(); }
    eq(name + ': Garmin was tried', calls, ['stalled']);
    eq(name + ': runs deleted', [res, runIds('u-a')], [{ deleted: 1 }, ['own_1']]);
    eq(name + ': link ended', [doc('users/u-a/private/garmin'), doc('garminUsers/g-111'), doc('users/u-a').garminConnected], [undefined, undefined, false]);
    eq(name + ': each request gives up well inside the 120 s call', s.asked.length > 0 && s.asked.every(function (ms) { return ms > 0 && ms <= 20000; }), true);
    eq(name + ': no token logged', tokensNeverLogged(), true);
  }
});

section('refreshGarminTokens: a renewal Garmin never answers does not stop the rest', async function () {
  reset();
  seedLinkLapsingIn('u-a', 'g-a', 5);
  seedLinkLapsingIn('u-b', 'g-b', 5);
  var first = true, s = stallingGarmin(function (url) {
    var stall = first && /oauth\/token$/.test(url);
    if (stall) first = false;
    return stall;
  });
  var done;
  try { done = await within(1000, g.refreshGarminTokens({})); } finally { s.restore(); }
  eq('the job finishes', done, undefined);
  eq('both tried', calls, ['stalled', 'POST token']);
  eq('the stalled one logged with the uid', logged.some(function (l) { return /refreshGarminTokens: uid u-[ab] failed: .*timeout/.test(l); }), true);
  eq('count logged', logged.some(function (l) { return /renewed 1 of 2/.test(l); }), true);
  eq('the daily job has time for requests that time out', scheduleOpts.timeoutSeconds >= 300, true);
});

(async function () {
  for (var i = 0; i < sections.length; i++) {
    say(sections[i][0]);
    try { await sections[i][1](); } catch (e) { failures++; checks++; say('  FAIL threw: ' + (e && e.stack || e)); }
  }
  say('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})();
