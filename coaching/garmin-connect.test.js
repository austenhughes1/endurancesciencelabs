// ════════════════════════════════════════════════════════════════
// coaching/garmin-connect.test.js
//
// Pins for the Garmin Connect card and link flow on the coaching page. Run
// with plain node:
//
//   node coaching/garmin-connect.test.js
//
// coaching/index.html keeps its code in one inline script, so the Garmin
// functions are lifted out of the page source and run against fakes of the
// browser globals they use (location, history, esLabs, firebase, userDoc).
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// The whole function declaration `[async ]function name(...) { ... }`, found
// by matching braces from its opening one.
function lift(name) {
  var at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' not found in coaching/index.html');
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  var open = src.indexOf('{', src.indexOf(')', at));
  var depth = 0;
  for (var i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(name + ': unbalanced braces');
}

var NAMES = ['readGarminReturn', 'garminCardShown', 'garminCardHtml', 'garminOwnCardHtml', 'garminResultToast',
  'handleGarminReturn', 'connectGarmin', 'disconnectGarmin', 'renderGarminKeep', 'garminKeepSlotHtml',
  'garminLinkSig', 'syncAthleteGarminCard'];
var code = 'var GARMIN_RETURN = null; var userDoc = null; var currentUser = null; var isCoach = false;\n' +
  'var athleteGarminCardSig = null; var garminDisconnecting = false;\n' + NAMES.map(lift).join('\n');

// A fresh page per case: every fake records what the code did with it.
function page(opts) {
  opts = opts || {};
  var rec = { toasts: [], calls: [], replaced: [], renders: 0, confirms: 0, warns: 0, rd: [], dash: [] };
  // #athlete-dashboard: showing with a drawn card unless opts.dash says otherwise.
  var dashEl = opts.dash === null ? null : Object.assign({ style: { display: 'block' }, innerHTML: '<div class="dash-card"></div>' }, opts.dash || {});
  var ctx = {
    URLSearchParams: URLSearchParams, Promise: Promise, JSON: JSON, Object: Object, String: String,
    console: { warn: function () { rec.warns++; }, log: function () {}, error: function () {} },
    location: { search: opts.search || '', pathname: '/coaching/', hash: opts.hash || '' },
    history: {
      state: null,
      replaceState: function (s, t, url) { if (opts.replaceThrows) throw new Error('blocked'); rec.replaced.push(url); },
    },
    window: { location: { href: '/coaching/' } },
    document: {
      querySelectorAll: function (sel) { return sel === '[data-garmin-keep]' ? (opts.slots || []) : []; },
      getElementById: function (id) { return id === 'athlete-dashboard' ? dashEl : null; },
    },
    esLabs: {
      toast: function (msg, o) { rec.toasts.push({ msg: msg, err: !!(o && o.err) }); },
      isActingAs: function () { return !!opts.acting; },
    },
    firebase: {
      functions: function () {
        return {
          httpsCallable: function (name) {
            return function (data) {
              rec.calls.push({ name: name, data: data });
              var out = opts.callable ? opts.callable(name, data) : { data: {} };
              return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
            };
          },
        };
      },
    },
    confirm: function () { rec.confirms++; return opts.confirm !== false; },
    rerenderGarminViews: function () { rec.renders++; },
    // As the page's renderDashboard does, records what the card was drawn with.
    renderDashboard: function (id, role) { rec.dash.push(id + ' ' + role); ctx.athleteGarminCardSig = ctx.garminLinkSig(ctx.userDoc); },
  };
  if (opts.runDynamics) {
    ctx.window.RunDynamics = ctx.RunDynamics = {
      forget: function (uid) { rec.rd.push('forget ' + uid); },
      reload: function (uid) { rec.rd.push('reload ' + uid); return Promise.resolve(true); },
    };
  }
  vm.runInNewContext(code, ctx);
  ctx.userDoc = opts.userDoc === undefined ? {} : opts.userDoc;
  ctx.currentUser = opts.currentUser === undefined ? { uid: 'u-athlete' } : opts.currentUser;
  ctx.isCoach = !!opts.isCoach;
  return { ctx: ctx, rec: rec };
}

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log('  FAIL ' + label + ': got ' + g + ', want ' + w); }
}
function has(label, text, part, want) { eq(label, String(text).indexOf(part) >= 0, want !== false); }
async function section(name, fn) { console.log(name); await fn(); }

var MSG = {
  connected: 'Garmin Connect linked. Runs you record from now on will appear in Running Dynamics.',
  denied: 'Garmin Connect wasn’t linked: access was declined on Garmin.',
  scope: 'Garmin Connect wasn’t linked: activity sharing has to be allowed.',
  inuse: 'That Garmin account is already linked to another Endurance Science Labs account.',
  account: 'This Garmin Connect link was started from a different Endurance Science Labs account. Sign in to that account, or connect again from this one.',
  state: 'The Garmin Connect link expired or was already used. Try Connect again.',
  config: 'Garmin Connect is unavailable right now. Try again later.',
  generic: 'Garmin Connect couldn’t be linked. Try again.',
  actingFinish: 'Garmin Connect can only be linked by the athlete, from their own account. Stop acting as them and connect again.',
};

(async function main() {
  await section('readGarminReturn: takes the Garmin answer out of the address bar', function () {
    var p = page({ search: '' });
    eq('no garmin param: nothing', p.ctx.readGarminReturn(), null);
    eq('no garmin param: URL untouched', p.rec.replaced, []);

    p = page({ search: '?garmin=finish&state=s&key=k', hash: '#tab=training' });
    eq('finish read', p.ctx.readGarminReturn(), { v: 'finish', reason: '', state: 's', key: 'k' });
    eq('state and key gone, hash kept', p.rec.replaced, ['/coaching/#tab=training']);

    p = page({ search: '?x=1&garmin=error&reason=state' });
    eq('error read', p.ctx.readGarminReturn(), { v: 'error', reason: 'state', state: '', key: '' });
    eq('other params kept', p.rec.replaced, ['/coaching/?x=1']);

    p = page({ search: '?garmin=denied' });
    eq('denied read', p.ctx.readGarminReturn().v, 'denied');
    eq('denied cleaned', p.rec.replaced, ['/coaching/']);

    p = page({ search: '?garmin=finish&state=s&key=k', replaceThrows: true });
    eq('history refuses: nothing acted on', p.ctx.readGarminReturn(), null);
  });

  await section('garminCardShown: own dashboard only, admin only until live, never while acting', function () {
    var shown = page().ctx.garminCardShown;
    eq('athlete, admin, not live', shown('athlete', { acting: false, admin: true, live: false }), true);
    eq('athlete, not admin, not live', shown('athlete', { acting: false, admin: false, live: false }), false);
    eq('athlete, live', shown('athlete', { acting: false, admin: false, live: true }), true);
    eq('acting as an athlete, live', shown('athlete', { acting: true, admin: false, live: true }), false);
    eq('acting as an athlete, admin flag set', shown('athlete', { acting: true, admin: true, live: false }), false);
    eq('coach viewing an athlete (admin)', shown('coach', { acting: false, admin: true, live: true }), false);
    eq('coach home, admin', shown('coach-home', { acting: false, admin: true, live: false }), true);
    eq('coach home, other coach, live', shown('coach-home', { acting: false, admin: false, live: true }), false);
    eq('coach home, acting', shown('coach-home', { acting: true, admin: true, live: true }), false);

    // Holding a link: the card stays wherever the account's own views are, so it can be ended.
    eq('athlete, linked, not live', shown('athlete', { acting: false, admin: false, live: false, linked: true }), true);
    eq('coach home, other coach, linked', shown('coach-home', { acting: false, admin: false, live: false, linked: true }), true);
    eq('no Training Data card, linked', shown('no-training-card', { acting: false, admin: false, live: false, linked: true }), true);
    eq('no Training Data card, not linked, live', shown('no-training-card', { acting: false, admin: true, live: true }), false);
    eq('no Training Data card, linked, acting', shown('no-training-card', { acting: true, admin: true, live: true, linked: true }), false);
    eq('athlete, linked, acting', shown('athlete', { acting: true, admin: false, live: false, linked: true }), false);
    eq('coach viewing a linked athlete', shown('coach', { acting: false, admin: true, live: true, linked: true }), false);
  });

  await section('renderGarminKeep: views without a dashboard offer Disconnect while linked', function () {
    function slot() { return { hidden: true, innerHTML: '', dataset: {} }; }
    var a = slot(), b = slot();
    var p = page({ slots: [a, b], userDoc: { garminConnected: true, garminSharing: true } });
    p.ctx.renderGarminKeep();
    eq('linked: every slot shown', [a.hidden, b.hidden], [false, false]);
    has('linked: titled panel', a.innerHTML, '<h2 class="dash-title">Your Garmin Connect</h2>');
    has('linked: disconnect button', a.innerHTML, 'onclick="disconnectGarmin(this)"');
    has('linked: no connect button', a.innerHTML, 'onclick="connectGarmin()"', false);

    a.innerHTML = 'kept'; // an unchanged state leaves the slot (and a press in flight) alone
    p.ctx.renderGarminKeep();
    eq('unchanged: not redrawn', a.innerHTML, 'kept');
    p.ctx.userDoc.garminSharing = false;
    p.ctx.renderGarminKeep();
    has('sharing turned off: redrawn with the paused note', a.innerHTML, 'Sharing is turned off');
    p.ctx.userDoc.garminConnected = false;
    p.ctx.renderGarminKeep();
    eq('disconnected: hidden and emptied', [a.hidden, a.innerHTML, b.hidden], [true, '', true]);

    a = slot();
    page({ slots: [a], userDoc: {} }).ctx.renderGarminKeep();
    eq('never linked: nothing offered', [a.hidden, a.innerHTML], [true, '']);
    a = slot();
    page({ slots: [a], acting: true, userDoc: { garminConnected: true } }).ctx.renderGarminKeep();
    eq('acting as a linked athlete: hidden', a.hidden, true);
    a = slot();
    page({ slots: [a], isCoach: true, userDoc: { garminConnected: true } }).ctx.renderGarminKeep();
    eq('coach account: hidden', a.hidden, true);
  });

  await section('syncAthleteGarminCard: the Training Data card follows link changes made on the server', function () {
    // A page whose Training Data card was drawn with userDoc as it is.
    function drawn(o) {
      var p = page(o);
      p.ctx.athleteGarminCardSig = p.ctx.garminLinkSig(p.ctx.userDoc);
      return p;
    }
    var p = drawn({ userDoc: { garminConnected: true, garminSharing: true, stravaConnected: true } });
    p.ctx.userDoc.stravaLastSyncedAt = 1; // a change the card does not show
    p.ctx.syncAthleteGarminCard();
    eq('unchanged link: not redrawn', p.rec.dash, []);
    p.ctx.userDoc.garminSharing = false;
    p.ctx.syncAthleteGarminCard();
    eq('sharing turned off: redrawn', p.rec.dash, ['athlete-dashboard athlete']);
    p.ctx.syncAthleteGarminCard();
    eq('then left alone', p.rec.dash.length, 1);
    p.ctx.userDoc.garminSharing = true;
    p.ctx.syncAthleteGarminCard();
    eq('sharing turned on again: redrawn', p.rec.dash.length, 2);
    p.ctx.userDoc.garminConnected = false; delete p.ctx.userDoc.garminSharing;
    p.ctx.syncAthleteGarminCard();
    eq('link ended on Garmin\'s side: redrawn', p.rec.dash.length, 3);
    p.ctx.userDoc.garminConnected = true; p.ctx.userDoc.garminSharing = true;
    p.ctx.syncAthleteGarminCard();
    eq('linked in another tab: redrawn', p.rec.dash.length, 4);

    var paused = { garminConnected: true, garminSharing: false };
    p = drawn({ userDoc: { garminConnected: true } });
    p.ctx.userDoc.garminSharing = false;
    p.ctx.garminDisconnecting = true;
    p.ctx.syncAthleteGarminCard();
    eq('a Disconnect press in flight: not redrawn', p.rec.dash, []);
    p = drawn({ userDoc: { garminConnected: true }, dash: { style: { display: 'none' } } });
    p.ctx.userDoc = paused;
    p.ctx.syncAthleteGarminCard();
    eq('dashboard not showing: not drawn', p.rec.dash, []);
    p = drawn({ userDoc: { garminConnected: true }, dash: { innerHTML: '  ' } });
    p.ctx.userDoc = paused;
    p.ctx.syncAthleteGarminCard();
    eq('dashboard not drawn yet: not drawn', p.rec.dash, []);
    p = drawn({ userDoc: { garminConnected: true }, dash: null });
    p.ctx.userDoc = paused;
    p.ctx.syncAthleteGarminCard();
    eq('no dashboard on the page: nothing', p.rec.dash, []);
    p = drawn({ userDoc: { garminConnected: true }, isCoach: true });
    p.ctx.userDoc = paused;
    p.ctx.syncAthleteGarminCard();
    eq('coach account: nothing', p.rec.dash, []);
  });

  await section('garminKeepSlotHtml: a dashboard without the Training Plan tab carries a Garmin slot', function () {
    var p = page();
    var slot = p.ctx.garminKeepSlotHtml('athlete', false);
    has('athlete, no Training Plan tab: a hidden slot', slot, '<section class="garmin-keep" data-garmin-keep aria-label="Your Garmin Connect" hidden></section>');
    eq('athlete with the Training Plan tab: none (the Training Data card has the card)', p.ctx.garminKeepSlotHtml('athlete', true), '');
    eq("coach's view of an athlete: none", p.ctx.garminKeepSlotHtml('coach', false), '');

    // Filled by renderGarminKeep like the other slots: Disconnect while linked.
    var el = { hidden: true, innerHTML: '', dataset: {} };
    page({ slots: [el], userDoc: { garminConnected: true, features: { coaching: false, lifting: true } } }).ctx.renderGarminKeep();
    eq('linked athlete without the tab: slot shown', el.hidden, false);
    has('linked athlete without the tab: disconnect button', el.innerHTML, 'onclick="disconnectGarmin(this)"');
  });

  await section('garminCardHtml: linked and unlinked states', function () {
    var html = page().ctx.garminCardHtml;
    var off = html({});
    has('unlinked: connect button', off, 'onclick="connectGarmin()"');
    has('unlinked: full app name on the button', off, '>Connect Garmin Connect</button>');
    has('unlinked: official tile', off, 'src="/images/garmin/garmin-connect-tile.png" alt="Garmin Connect"');
    has('unlinked: Terms link', off, 'href="/terms/"');
    has('unlinked: Privacy link', off, 'href="/privacy/"');
    has('unlinked: no disconnect', off, 'disconnectGarmin', false);
    eq('null account reads as unlinked', html(null).indexOf('connectGarmin()') >= 0, true);

    var on = html({ garminConnected: true, garminSharing: true });
    has('linked: disconnect button', on, 'onclick="disconnectGarmin(this)"');
    has('linked: no connect button', on, 'onclick="connectGarmin()"', false);
    has('linked: no paused note', on, 'Sharing is turned off', false);
    has('linked, sharing unknown: no paused note', html({ garminConnected: true }), 'Sharing is turned off', false);
    has('linked, sharing off: paused note', html({ garminConnected: true, garminSharing: false }),
      '<strong>Sharing is turned off in Garmin Connect</strong>, so new runs are paused.');
  });

  await section('garminResultToast: one message per outcome', function () {
    function toast(result, reason) {
      var p = page();
      p.ctx.garminResultToast(result, reason);
      return p.rec.toasts;
    }
    eq('connected', toast('connected'), [{ msg: MSG.connected, err: false }]);
    eq('denied', toast('denied'), [{ msg: MSG.denied, err: true }]);
    eq('scope', toast('scope'), [{ msg: MSG.scope, err: true }]);
    ['inuse', 'account', 'state', 'config'].forEach(function (r) {
      eq('error ' + r, toast('error', r), [{ msg: MSG[r], err: true }]);
    });
    ['busy', 'exchange', 'params', 'user', '', 'constructor', 'toString', '__proto__'].forEach(function (r) {
      eq('error ' + (r || 'without reason') + ' reads generic', toast('error', r), [{ msg: MSG.generic, err: true }]);
    });
    eq('unknown result reads generic', toast('surprise'), [{ msg: MSG.generic, err: true }]);
  });

  await section('handleGarminReturn: finishes the link once, as the signed-in account', async function () {
    var p = page();
    await p.ctx.handleGarminReturn();
    eq('nothing held: no call', p.rec.calls, []);
    eq('nothing held: no toast', p.rec.toasts, []);

    p = page();
    p.ctx.GARMIN_RETURN = { v: 'denied', reason: '', state: '', key: '' };
    await p.ctx.handleGarminReturn();
    eq('denied: no call', p.rec.calls, []);
    eq('denied: toast', p.rec.toasts, [{ msg: MSG.denied, err: true }]);
    eq('denied: consumed', p.ctx.GARMIN_RETURN, null);

    p = page();
    p.ctx.GARMIN_RETURN = { v: 'error', reason: 'state', state: '', key: '' };
    await p.ctx.handleGarminReturn();
    eq('callback error: no call', p.rec.calls, []);
    eq('callback error: its message', p.rec.toasts, [{ msg: MSG.state, err: true }]);

    p = page({ acting: true });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('acting: no call', p.rec.calls, []);
    eq('acting: says who can link', p.rec.toasts, [{ msg: MSG.actingFinish, err: true }]);
    eq('acting: consumed', p.ctx.GARMIN_RETURN, null);

    p = page({ callable: function () { return { data: { result: 'connected' } }; } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    await p.ctx.handleGarminReturn();
    eq('connected: one call with state and key only', p.rec.calls, [{ name: 'finishGarminLink', data: { state: 's', key: 'k' } }]);
    eq('connected: card state', [p.ctx.userDoc.garminConnected, p.ctx.userDoc.garminSharing], [true, true]);
    eq('connected: card redrawn once', p.rec.renders, 1);
    eq('connected: toast', p.rec.toasts, [{ msg: MSG.connected, err: false }]);

    p = page({ userDoc: null, callable: function () { return { data: { result: 'connected' } }; } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('connected before the user doc loaded: toast only', [p.rec.renders, p.rec.toasts.length], [0, 1]);

    p = page({ callable: function () { return { data: { result: 'scope' } }; } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('scope: card unchanged', [p.ctx.userDoc.garminConnected, p.rec.renders], [undefined, 0]);
    eq('scope: toast', p.rec.toasts, [{ msg: MSG.scope, err: true }]);

    p = page({ callable: function () { return { data: { result: 'error', reason: 'account' } }; } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('account: toast', p.rec.toasts, [{ msg: MSG.account, err: true }]);

    p = page({ callable: function () { return { data: { result: 'error', reason: 'busy' } }; } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('busy: generic toast', p.rec.toasts, [{ msg: MSG.generic, err: true }]);

    p = page({ callable: function () { return new Error('internal'); } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('call fails: generic toast', p.rec.toasts, [{ msg: MSG.generic, err: true }]);
    eq('call fails: card unchanged', p.rec.renders, 0);

    p = page({ callable: function () { return {}; } });
    p.ctx.GARMIN_RETURN = { v: 'finish', reason: '', state: 's', key: 'k' };
    await p.ctx.handleGarminReturn();
    eq('empty answer: generic toast', p.rec.toasts, [{ msg: MSG.generic, err: true }]);
  });

  await section('connectGarmin: starts the link for the signed-in account only', async function () {
    var p = page({ acting: true });
    await p.ctx.connectGarmin();
    eq('acting: no call', p.rec.calls, []);
    eq('acting: toast', p.rec.toasts, [{ msg: 'Garmin Connect can only be linked by the athlete, from their own account.', err: true }]);

    p = page({ callable: function () { return { data: { url: 'https://example.test/approve?state=x' } }; } });
    await p.ctx.connectGarmin();
    eq('starts: one call, no arguments', p.rec.calls, [{ name: 'createGarminAuthUrl', data: {} }]);
    eq('starts: goes to the approval page', p.ctx.window.location.href, 'https://example.test/approve?state=x');

    p = page({ callable: function () { return new Error('unavailable'); } });
    await p.ctx.connectGarmin();
    eq('fails: stays on the page', p.ctx.window.location.href, '/coaching/');
    eq('fails: toast', p.rec.toasts, [{ msg: 'Couldn’t start the Garmin Connect link. Try again in a minute.', err: true }]);
  });

  await section('disconnectGarmin: confirms, ends the link, redraws the card in place', async function () {
    var linked = function () { return { garminConnected: true, garminSharing: true }; };
    var p = page({ acting: true, userDoc: linked() });
    await p.ctx.disconnectGarmin();
    eq('acting: no confirm, no call', [p.rec.confirms, p.rec.calls.length], [0, 0]);
    eq('acting: toast', p.rec.toasts, [{ msg: 'Garmin Connect can only be managed by the athlete, from their own account.', err: true }]);

    p = page({ confirm: false, userDoc: linked() });
    await p.ctx.disconnectGarmin();
    eq('declined: no call', p.rec.calls, []);
    eq('declined: still linked', p.ctx.userDoc.garminConnected, true);

    var btn = { disabled: false };
    p = page({ userDoc: linked(), callable: function () { return { data: { deleted: 3 } }; } });
    await p.ctx.disconnectGarmin(btn);
    eq('ends: one call', p.rec.calls, [{ name: 'disconnectGarmin', data: {} }]);
    eq('ends: card state', [p.ctx.userDoc.garminConnected, 'garminSharing' in p.ctx.userDoc], [false, false]);
    eq('ends: card redrawn once', p.rec.renders, 1);
    eq('ends: toast counts runs', p.rec.toasts, [{ msg: 'Garmin Connect disconnected. 3 runs removed.', err: false }]);

    p = page({ userDoc: linked(), runDynamics: true, callable: function () { return { data: { deleted: 2 } }; } });
    await p.ctx.disconnectGarmin();
    eq('ends: Running Dynamics forgets and re-reads the deleted runs', p.rec.rd, ['forget u-athlete', 'reload u-athlete']);

    p = page({ userDoc: linked(), callable: function () { return { data: { deleted: 1 } }; } });
    await p.ctx.disconnectGarmin();
    eq('one run', p.rec.toasts[0].msg, 'Garmin Connect disconnected. 1 run removed.');

    btn = { disabled: false };
    p = page({ userDoc: linked(), callable: function () { return new Error('internal'); } });
    await p.ctx.disconnectGarmin(btn);
    eq('fails: still linked', [p.ctx.userDoc.garminConnected, p.rec.renders], [true, 0]);
    eq('fails: button usable again', btn.disabled, false);
    eq('fails: toast', p.rec.toasts, [{ msg: 'Couldn’t disconnect Garmin Connect. Try again.', err: true }]);

    p = page({ userDoc: linked(), runDynamics: true, callable: function () { return new Error('internal'); } });
    await p.ctx.disconnectGarmin();
    eq('fails: Running Dynamics left as it is', p.rec.rd, []);

    // The server clears the link flags while the call is still out: the
    // Training Data card keeps its pressed button until the call ends.
    function pressWhileServerEnds(outcome) {
      var answer, q = page({ userDoc: linked(), callable: function () { return new Promise(function (r) { answer = r; }); } });
      q.ctx.athleteGarminCardSig = 'linked';
      var pressed = q.ctx.disconnectGarmin({ disabled: false });
      return Promise.resolve().then(function () {
        q.ctx.userDoc.garminConnected = false; delete q.ctx.userDoc.garminSharing; // the user-doc snapshot
        q.ctx.syncAthleteGarminCard();
        q.inFlight = q.rec.dash.slice();
        answer(outcome);
        return pressed;
      }).then(function () { return q; });
    }
    p = await pressWhileServerEnds({ data: { deleted: 2 } });
    eq('in flight: not redrawn by the snapshot', p.inFlight, []);
    eq('ends: redrawn once by the press', [p.rec.renders, p.ctx.garminDisconnecting], [1, false]);
    p = await pressWhileServerEnds(Promise.reject(new Error('deadline-exceeded')));
    eq('fails after the link ended: the card catches up', [p.inFlight, p.rec.dash, p.ctx.garminDisconnecting], [[], ['athlete-dashboard athlete'], false]);
    eq('fails after the link ended: toast', p.rec.toasts, [{ msg: 'Couldn’t disconnect Garmin Connect. Try again.', err: true }]);
    p = page({ userDoc: linked(), callable: function () { return new Error('internal'); } });
    p.ctx.athleteGarminCardSig = 'linked';
    await p.ctx.disconnectGarmin({ disabled: false });
    eq('fails with the link intact: the card and its button stay', [p.rec.dash, p.ctx.garminDisconnecting], [[], false]);
  });

  console.log(checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})().catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
