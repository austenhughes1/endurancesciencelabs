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

var autoId = 0;
function DocRef(p) { this.path = p; this.id = p.slice(p.lastIndexOf('/') + 1); }
DocRef.prototype.collection = function (name) { return new Query(this.path + '/' + name, []); };
DocRef.prototype.get = function () { return Promise.resolve(new Snap(this, store.get(this.path))); };
DocRef.prototype.set = function (data, opts) {
  store.set(this.path, applyFields(opts && opts.merge ? store.get(this.path) || {} : {}, data));
  return Promise.resolve();
};
DocRef.prototype.update = function (data) {
  if (!store.has(this.path)) return Promise.reject(new Error('NOT_FOUND: ' + this.path));
  store.set(this.path, applyFields(store.get(this.path), data));
  return Promise.resolve();
};
DocRef.prototype.delete = function () { store.delete(this.path); return Promise.resolve(); };

function Snap(ref, data) { this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this._d = data; }
Snap.prototype.data = function () { return this.exists ? Object.assign({}, this._d) : undefined; };
Snap.prototype.get = function (f) { return this.exists ? this._d[f] : undefined; };

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
    if (self.filters.every(function (w) { return cmp(d[w[0]], w[1], w[2]); })) docs.push(new Snap(new DocRef(p), d));
  });
  if (self.lim != null) docs = docs.slice(0, self.lim);
  return Promise.resolve({ docs: docs, size: docs.length, empty: docs.length === 0 });
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
};

function HttpsError(code, message) { var e = new Error(message); e.code = code; return e; }
var fakes = {
  'firebase-admin': { initializeApp: function () {}, firestore: Object.assign(function () { return db; }, { FieldValue: FieldValue, Timestamp: Timestamp }) },
  'firebase-functions/v2/https': {
    onCall: function (opts, fn) { return fn; },
    onRequest: function (opts, fn) { return fn; },
    HttpsError: HttpsError,
  },
  'firebase-functions/v2/firestore': { onDocumentCreated: function (opts, fn) { return fn; } },
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
  var m = /\/user\/(id|permissions|registration)$/.exec(url);
  if (!m) throw new Error('unexpected fetch ' + url);
  calls.push(method + ' ' + m[1] + (method === 'DELETE' ? ' ' + auth : ''));
  if (m[1] === 'id') return reply(200, { userId: garmin.userId });
  if (m[1] === 'permissions') return reply(garmin.permStatus, { permissions: garmin.permissions });
  return reply(204, null);
};

// ── Load garmin.js with the fakes ────────────────────────────────
process.env.GARMIN_CLIENT_ID = 'test-client-id';
process.env.GARMIN_CLIENT_SECRET = 'test-client-secret';
var realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
  return realLoad.apply(this, arguments);
};
var g = require('./garmin');
Module._load = realLoad;

// Keep the module's own warnings out of the test output.
var quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = function () {};
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

function reset() { store.clear(); resetGarmin(); }
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

(async function () {
  for (var i = 0; i < sections.length; i++) {
    say(sections[i][0]);
    try { await sections[i][1](); } catch (e) { failures++; checks++; say('  FAIL threw: ' + (e && e.stack || e)); }
  }
  say('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})();
