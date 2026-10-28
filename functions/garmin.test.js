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
var fakes = {
  'firebase-admin': { initializeApp: function () {}, firestore: Object.assign(function () { return db; }, { FieldValue: FieldValue, Timestamp: Timestamp }) },
  'firebase-functions/v2/https': {
    onCall: function (opts, fn) { return fn; },
    onRequest: function (opts, fn) { return fn; },
    HttpsError: HttpsError,
  },
  'firebase-functions/v2/firestore': { onDocumentCreated: function (opts, fn) { triggerOpts[opts.document] = opts; return fn; } },
  'firebase-functions/v2/scheduler': { onSchedule: function (opts, fn) { return fn; } },
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

fitSection('a file that lands before its summary keeps its values', async function () {
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

section('an item that fails is still removed from the inbox', async function () {
  reset();
  store.set('garminUsers/g-111', { uid: 'u-gone' }); // no users/u-gone doc
  await push({ userPermissionsChange: [{ userId: 'g-111', permissions: [] }] }); await work();
  eq('inbox drained', inbox().length, 0);
  eq('error logged', logged.some(function (l) { return /onGarminInbox userPermissionsChange error/.test(l); }), true);
});

(async function () {
  for (var i = 0; i < sections.length; i++) {
    say(sections[i][0]);
    try { await sections[i][1](); } catch (e) { failures++; checks++; say('  FAIL threw: ' + (e && e.stack || e)); }
  }
  say('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})();
