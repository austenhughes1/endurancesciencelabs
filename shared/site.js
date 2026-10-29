// ════════════════════════════════════════════════════════════════
// shared/site.js
//
// Single source of truth for: Firebase init, auth flow, sign-in UI,
// the top nav, and effective-pass state across the ESLabs site.
//
// Load order on a page:
//   <link rel="stylesheet" href="/shared/site.css">
//   <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-functions-compat.js"></script>
//   <script src="/shared/site.js"></script>
//
// Then call:
//   esLabs.mountNav('#nav-mount', { active: 'esformlab' });
//   esLabs.mountAuthGate('#gate-mount', { headline: '...', bullets: [...] });
//   esLabs.onAuthChange(function(user) { ... });
//
// Shared UI helpers (DESIGN-STANDARD §3.10/§3.11) for page code:
//   esLabs.toast(msg, {err, action:{label, fn}, timeout})
//   esLabs.openDialog(overlay, {trigger, initialFocus, dismissable, onClose}) / closeDialog(overlay)
//   esLabs.openSignIn({trigger})       one sign-in UI (page gate or shared dialog)
//   esLabs.whenAuthReady() / esLabs.authResolved
//   esLabs.owns(key) / esLabs.requireNotActing()   purchases (owner decision D7)
//   esLabs.refreshNav(), esLabs.prefersReducedMotion(), esLabs.escapeHtml()
// Link both files with ?v= (GitHub Pages caches ~10 min) and bump it on change.
// ════════════════════════════════════════════════════════════════

(function () {
'use strict';

// ── Theme (dark default, light opt-in) ──────────────────────────
// A tiny inline <script> in each page's <head> applies the saved theme
// before first paint (no flash). This is the fuller machinery: it keeps
// localStorage + the signed-in user's Firestore doc in sync, swaps the
// white logos for their dark variants, and notifies listeners.
var THEME_KEY = 'esl-theme';
var themeListeners = [];

// Apply ASAP in case the head snippet is missing on some page.
try {
  if (localStorage.getItem(THEME_KEY) === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
} catch (e) {}

// ── Firebase config (the single hardcoded copy) ─────────────────
var FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDh4LorLQx1DPovQIA4HM3127fAYpyuaY8',
  authDomain: 'es-form-labs.firebaseapp.com',
  projectId: 'es-form-labs',
  storageBucket: 'es-form-labs.firebasestorage.app',
  messagingSenderId: '215373817428',
  appId: '1:215373817428:web:9a80d81815f6843ce2afc1',
  measurementId: 'G-P2RRN15M8K'
};

var ADMIN_UID = '2z9Z3K5ZwShvadUuqZmwMv0s1Od2';
var STRIPE_PASS_PRICE_ID = 'price_1UPp34IFO8pppwnFSpUiY96l';  // $90 90-day pass (Oct 2026)
// Price(s) the esFormLab 90-day pass sells under. Only a payment for one of
// these unlocks esFormLab -- metabolic and coaching payments land in the
// same customers/{uid}/payments collection and must not. If the pass price
// ever changes after people have bought it, keep the old ID in this list.
// Keep in sync with ESFORMLAB_PASS_PRICE_IDS in functions/index.js.
var ESFORMLAB_PASS_PRICE_IDS = [
  STRIPE_PASS_PRICE_ID
];
// Coaching subscriptions: monthly prices and 4-month "training block" prices
// (recurring every 4 months). Keep in sync with coaching/index.html and
// functions/index.js.
var COACHING_PREMIUM_PRICE_ID = 'price_1UOlXBIFO8pppwnFMym4W83P';          // $275 / mo
var COACHING_STANDARD_PRICE_ID = 'price_1TVIadIFO8pppwnFuj3vYy9S';         // $175 / mo
var COACHING_PREMIUM_BLOCK_PRICE_ID = 'price_1UPoiIIFO8pppwnFyugPYaSf';    // $1000 / 4 mo
var COACHING_STANDARD_BLOCK_PRICE_ID = 'price_1UPogpIFO8pppwnFytHL4QA1';   // $600 / 4 mo
var COACHING_PREMIUM_PRICE_IDS = [COACHING_PREMIUM_PRICE_ID, COACHING_PREMIUM_BLOCK_PRICE_ID];
var COACHING_STANDARD_PRICE_IDS = [COACHING_STANDARD_PRICE_ID, COACHING_STANDARD_BLOCK_PRICE_ID];
var PASS_DURATION_SEC = 90 * 24 * 60 * 60;

// esMetabolicLab price IDs (4 tiers).
// - Lifetime: one-time $90, unlimited lactate uploads forever.
// - Yearly:   auto-renewing $60/yr subscription, unlimited uploads while active.
// - Single:   one-time $30, unlimited uploads for 7 days from purchase.
// - InPerson: one-time $145, books an in-person test with a coach. Does NOT
//             grant any upload entitlement on its own.
var METLAB_LIFETIME_PRICE_ID = 'price_1TahG1IFO8pppwnFG3vtYfXI';
var METLAB_YEARLY_PRICE_ID   = 'price_1TahFFIFO8pppwnFYFMvh9xP';
var METLAB_SINGLE_PRICE_ID   = 'price_1TahDbIFO8pppwnFDD8rkJWP';
var METLAB_INPERSON_PRICE_ID = 'price_1TahCGIFO8pppwnFHqaaKbwW';
var METLAB_SINGLE_WINDOW_SEC = 7 * 24 * 60 * 60;

// Shockwave + EMTT session price IDs (one-time, in person).
// - Standard: $150 per session.
// - Member:   $50 per session for any active coaching subscriber.
// Full Access's free monthly session skips checkout entirely.
var SHOCKWAVE_PRICE_ID        = 'price_1UPT2VIFO8pppwnFl0eiEFAL';
var SHOCKWAVE_MEMBER_PRICE_ID = 'price_1UPT3oIFO8pppwnFibQ5DIq9';
var SHOCKWAVE_PRICE_IDS = [SHOCKWAVE_PRICE_ID, SHOCKWAVE_MEMBER_PRICE_ID];

if (typeof firebase === 'undefined') {
  console.error('esLabs/site.js: firebase compat SDK must be loaded first');
  return;
}
if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);

var auth = firebase.auth();
var db = firebase.firestore();

// ── State ────────────────────────────────────────────────────────
var state = {
  user: null,
  userDoc: null,
  hasPaidPass: false,
  paidPassUntil: null,
  hasGrantedFlag: false,
  grantedUntilSec: null,
  hasPremiumCoach: false,
  hasStandardCoach: false,
  premiumCoachPeriodEnd: null,
  subsLoaded: false,              // first subscriptions snapshot has arrived
  shockwaveLatestPaid: null,      // unix seconds of most recent Shockwave + EMTT payment
  // esMetabolicLab entitlements (client-derived from payments + subs docs)
  metlabHasLifetime: false,
  metlabYearlyActive: false,
  metlabYearlyPeriodEnd: null,
  metlabSingleUntil: null,        // unix seconds when the 7-day window expires
  metlabInPersonLatest: null,     // unix seconds of most recent in-person payment
  metlabAdminGranted: false,      // users/{uid}.features.esMetabolicLab — coach grant
  // Subscription status detail (display only -- access rules unchanged;
  // past_due never unlocks anything).
  standardCoachPeriodEnd: null,
  coachCancelAtPeriodEnd: false,  // active coaching sub set to end at period end
  coachPastDue: null,             // {tier, periodEnd, status} when no active coaching sub
  metlabYearlyCancelAtPeriodEnd: false,
  coachingGranted: false,         // users/{uid}.features.coaching — coach/admin grant
  paymentsLoaded: false,          // first payments snapshot (or error) has arrived
  userDocLoaded: false,           // first users/{uid} snapshot (or error) has arrived
  // Auth restore: false until Firebase reports the persisted session (or
  // its absence). authGaveUp flips after 5 s so gates never spin forever.
  authResolved: false,
  authGaveUp: false,
  gateMounted: null,              // the page's own gate (not the shared sign-in dialog)
  emailAuthMode: 'signup'
};
var authListeners = [];
var passListeners = [];
var passWatchers = { user: null, payments: null, subs: null };
var gateInstances = [];   // every mounted auth gate (incl. the shared sign-in dialog)
var gateSeq = 0;

// ── Sign-in API ──────────────────────────────────────────────────
function signInGoogle() {
  return auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
    .catch(function (e) {
      if (e && e.code === 'auth/popup-closed-by-user') return;
      throw e;
    });
}
function signInEmail(email, pw) { return auth.signInWithEmailAndPassword(email, pw); }
function createAccount(email, pw) { return auth.createUserWithEmailAndPassword(email, pw); }
function sendPasswordReset(email) { return auth.sendPasswordResetEmail(email); }
function signOut() { clearActAs(); return auth.signOut(); }

// ── Act-as (admin-only impersonation layer) ──────────────────────
// The admin can browse the site "as" another user: pages receive a
// stand-in user object whose uid is the target's, so every Firestore
// read/write keyed on user.uid lands on the target's data. The real
// Firebase session stays the admin's — Firestore rules (admin may
// read/update any users/{uid} doc) are what actually authorize the
// writes, so this is UX, not a privilege escalation. Per-tab
// (sessionStorage), and inert unless the signed-in uid is ADMIN_UID.
// Internal pass/entitlement state (attachPassWatchers, isAdmin, the
// esLabs.user getter) intentionally stays on the REAL user — the
// admin keeps their own paywall bypass, and we never try to read the
// target's customers/{uid} docs (rules would reject that).
var ACT_AS_KEY = 'eslActAs';

function getActAs() {
  if (!state.user || state.user.uid !== ADMIN_UID) return null;
  try {
    var info = JSON.parse(sessionStorage.getItem(ACT_AS_KEY) || 'null');
    if (!info || !info.uid || info.uid === ADMIN_UID) return null;
    return info;
  } catch (e) { return null; }
}

function effectiveUser() {
  var real = state.user;
  var act = getActAs();
  if (!real || !act) return real;
  return {
    uid: act.uid,
    displayName: act.name || null,
    email: act.email || null,
    photoURL: null,
    emailVerified: true,
    isAnonymous: false,
    providerData: [],
    isActingAs: true,
    realUid: real.uid,
    getIdToken: function () { return real.getIdToken.apply(real, arguments); },
    // Never let a page rename/modify the ADMIN's Auth record while
    // acting; the meaningful profile fields live in users/{uid} anyway.
    updateProfile: function () { return Promise.resolve(); }
  };
}

function startActAs(info) {
  if (!state.user || state.user.uid !== ADMIN_UID) return false;
  if (!info || !info.uid || info.uid === ADMIN_UID) return false;
  try {
    sessionStorage.setItem(ACT_AS_KEY, JSON.stringify({
      uid: info.uid, name: info.name || null, email: info.email || null
    }));
  } catch (e) { return false; }
  return true;
}

function clearActAs() {
  try { sessionStorage.removeItem(ACT_AS_KEY); } catch (e) {}
}

function stopActAs() {
  clearActAs();
  window.location.reload();
}

// The banner is fixed to the bottom. Its real height (it wraps to ~97px at
// 390px) is published as --esl-bottom-inset so fixed-bottom UI (toasts,
// sticky bars) can sit above it, and added to the page's own bottom padding.
// Inline styles on purpose, so the banner still looks right on a page that
// loads site.js without site.css.
var bannerObserver = null;
var bannerResizeHandler = null;

function syncBottomInset(el) {
  if (!el || !document.body || !document.body.contains(el)) return;
  var h = Math.ceil(el.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--esl-bottom-inset', h + 'px');
  var body = document.body;
  if (body.dataset.eslPb === undefined) {
    // The page's own padding-bottom, read once before the first override.
    body.dataset.eslPb = getComputedStyle(body).paddingBottom || '0px';
  }
  body.style.paddingBottom = 'calc(' + body.dataset.eslPb + ' + ' + h + 'px)';
}

function watchBanner(el) {
  if (bannerObserver || bannerResizeHandler) return;
  if (typeof ResizeObserver === 'function') {
    bannerObserver = new ResizeObserver(function () { syncBottomInset(el); });
    bannerObserver.observe(el);
  } else {
    var t = null;
    bannerResizeHandler = function () {
      clearTimeout(t);
      t = setTimeout(function () { syncBottomInset(el); }, 120);
    };
    window.addEventListener('resize', bannerResizeHandler);
  }
}

function unwatchBanner() {
  if (bannerObserver) { bannerObserver.disconnect(); bannerObserver = null; }
  if (bannerResizeHandler) { window.removeEventListener('resize', bannerResizeHandler); bannerResizeHandler = null; }
}

function refreshActAsBanner() {
  var act = getActAs();
  var el = document.getElementById('eslabs-actas-banner');
  if (!act) {
    if (el) {
      el.remove();
      unwatchBanner();
      document.documentElement.style.removeProperty('--esl-bottom-inset');
      document.body.style.paddingBottom = '';
      delete document.body.dataset.eslPb;
    }
    return;
  }
  var who = act.name || act.email || act.uid;
  if (!el) {
    el = document.createElement('div');
    el.id = 'eslabs-actas-banner';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Act-as session');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;'
      + 'display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;'
      + 'padding:10px 16px;background:#b45309;color:#fff;'
      + 'font:600 14px/1.4 var(--ui, system-ui, -apple-system, sans-serif);'
      + 'box-shadow:0 -2px 12px rgba(0,0,0,.35)';
    document.body.appendChild(el);
  }
  // Admin-only tools (requireAdmin gates) keep working on the admin's own
  // account, so the "saved to their account" warning would be wrong there.
  var adminTool = gateInstances.some(function (g) {
    return g.host._eslGateOpts && g.host._eslGateOpts.requireAdmin && document.body.contains(g.host);
  });
  el.innerHTML = '<span>&#9888;&#65039; Acting as <strong>' + escapeHtml(who) + '</strong> &mdash; '
    + (adminTool ? 'this admin tool uses your own admin account.' : 'anything you enter is saved to their account.') + '</span>'
    + '<button type="button" id="eslabs-actas-stop" style="background:transparent;color:#fff;'
    + 'border:1.5px solid rgba(255,255,255,.75);border-radius:8px;min-height:32px;padding:5px 12px;'
    + 'font:700 13px/1.2 var(--ui, system-ui, sans-serif);cursor:pointer">Stop acting</button>';
  document.getElementById('eslabs-actas-stop').addEventListener('click', stopActAs);
  syncBottomInset(el);
  watchBanner(el);
}

// Firebase's Google OAuth popup stashes its handoff state in sessionStorage.
// When that write is blocked the SDK dies on a blank "Unable to save initial
// state" handler page. Two contexts break it on phones: private/incognito mode
// (sessionStorage throws) and in-app browsers (Instagram/Facebook/etc., which
// partition storage). Detect both up front so we can steer users to email.
function sessionStorageWorks() {
  try {
    var k = '__esl_probe__';
    window.sessionStorage.setItem(k, '1');
    window.sessionStorage.removeItem(k);
    return true;
  } catch (e) { return false; }
}
function isInAppBrowser() {
  var ua = navigator.userAgent || '';
  // `; wv)` is the Android WebView marker (Chrome Custom Tabs don't carry it).
  return /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|TikTok|musical_ly|MicroMessenger|WeChat|Snapchat|Pinterest|LinkedInApp|; wv\)/i.test(ua);
}
function googleOAuthAvailable() {
  return sessionStorageWorks() && !isInAppBrowser();
}

function onAuthChange(cb) {
  authListeners.push(cb);
  // Fire immediately with the latest known state so callers don't race.
  // Listeners get the effective user (act-as stand-in when active).
  try { cb(effectiveUser()); } catch (e) { console.error(e); }
  return function () {
    var i = authListeners.indexOf(cb);
    if (i !== -1) authListeners.splice(i, 1);
  };
}

// Resolves once Firebase has reported the persisted session (or its absence).
// Unlike onAuthChange, never fires with the pre-restore null.
function whenAuthReady() {
  if (state.authResolved) return Promise.resolve(effectiveUser());
  return new Promise(function (resolve) {
    var done = false, off = null;
    off = onAuthChange(function (u) {
      if (done || !state.authResolved) return;
      done = true;
      if (off) off();
      resolve(u);
    });
    // onAuthChange fires synchronously before `off` exists; re-check here.
    if (done && off) off();
  });
}

auth.onAuthStateChanged(function (user) {
  state.authResolved = true;
  state.user = user;
  detachPassWatchers();
  state.userDoc = null;
  state.hasPaidPass = false;
  state.paidPassUntil = null;
  state.hasGrantedFlag = false;
  state.grantedUntilSec = null;
  state.hasPremiumCoach = false;
  state.hasStandardCoach = false;
  state.premiumCoachPeriodEnd = null;
  state.subsLoaded = false;
  state.shockwaveLatestPaid = null;
  state.metlabHasLifetime = false;
  state.metlabYearlyActive = false;
  state.metlabYearlyPeriodEnd = null;
  state.metlabSingleUntil = null;
  state.metlabInPersonLatest = null;
  state.metlabAdminGranted = false;
  state.standardCoachPeriodEnd = null;
  state.coachCancelAtPeriodEnd = false;
  state.coachPastDue = null;
  state.metlabYearlyCancelAtPeriodEnd = false;
  state.coachingGranted = false;
  state.paymentsLoaded = false;
  state.userDocLoaded = false;
  if (user) attachPassWatchers(user.uid);
  notifyAuthListeners();
  refreshMountedNav();
  refreshActAsBanner();
});

// Safety net: if auth never reports (blocked storage, SDK hiccup), stop the
// gate spinners after 5 s and show the normal sign-in card. Page
// onAuthChange callbacks are NOT re-fired.
setTimeout(function () {
  if (state.authResolved) return;
  state.authGaveUp = true;
  gateInstances.forEach(function (g) { try { g._sync(); } catch (e) { console.error(e); } });
  refreshMountedNav();
}, 5000);

function notifyAuthListeners() {
  var u = effectiveUser();
  // Iterate a copy: a listener may unsubscribe itself (e.g. whenAuthReady).
  authListeners.slice().forEach(function (cb) {
    try { cb(u); } catch (e) { console.error(e); }
  });
}
function notifyPassListeners() {
  var snap = passSnapshot();
  passListeners.slice().forEach(function (cb) {
    try { cb(snap); } catch (e) { console.error(e); }
  });
}

// ── Pass state ───────────────────────────────────────────────────
function passSnapshot() {
  var now = Math.floor(Date.now() / 1000);
  var unlocked = false, source = null, until = null;
  if (state.hasPremiumCoach) {
    unlocked = true; source = 'coaching-bundle';
    until = state.premiumCoachPeriodEnd || null;
  } else if (state.hasGrantedFlag) {
    unlocked = true; source = 'granted-flag'; until = null;
  } else if (state.grantedUntilSec && state.grantedUntilSec > now) {
    unlocked = true; source = 'granted-until'; until = state.grantedUntilSec;
  } else if (state.hasPaidPass) {
    unlocked = true; source = 'paid'; until = state.paidPassUntil;
  }

  // esMetabolicLab upload access — any of: admin grant / lifetime / active
  // yearly / Full Access coaching / unexpired single. Admin grant
  // (users/{uid}.features.esMetabolicLab) acts as a lifetime grant for
  // coaches/beta testers without a Stripe purchase. Full Access coaching
  // advertises "Access to ESLabs Metabolic Testing", so it bundles upload
  // access for as long as the subscription is active.
  var metlabUpload = false, metlabSource = null, metlabUntil = null;
  if (state.metlabAdminGranted) {
    metlabUpload = true; metlabSource = 'admin-grant';
  } else if (state.metlabHasLifetime) {
    metlabUpload = true; metlabSource = 'lifetime';
  } else if (state.metlabYearlyActive) {
    metlabUpload = true; metlabSource = 'yearly'; metlabUntil = state.metlabYearlyPeriodEnd;
  } else if (state.hasPremiumCoach) {
    metlabUpload = true; metlabSource = 'coaching-bundle'; metlabUntil = state.premiumCoachPeriodEnd || null;
  } else if (state.metlabSingleUntil && state.metlabSingleUntil > now) {
    metlabUpload = true; metlabSource = 'single'; metlabUntil = state.metlabSingleUntil;
  }

  return {
    unlocked: unlocked,
    source: source,
    until: until,
    hasPaidPass: state.hasPaidPass,
    paidPassUntil: state.paidPassUntil,
    hasGrantedFlag: state.hasGrantedFlag,
    grantedUntilSec: state.grantedUntilSec,
    hasPremiumCoach: state.hasPremiumCoach,
    hasStandardCoach: state.hasStandardCoach,
    premiumCoachPeriodEnd: state.premiumCoachPeriodEnd,
    // False until the coaching subscription state is known -- pages that
    // price by membership should wait for it rather than flash list price.
    subscriptionsLoaded: state.subsLoaded,
    shockwaveLatestPaid: state.shockwaveLatestPaid,
    // Subscription status detail (display only; access rules above are
    // unchanged and past_due never unlocks anything).
    hasCoaching: state.hasPremiumCoach || state.hasStandardCoach,
    standardCoachPeriodEnd: state.standardCoachPeriodEnd,
    coachCancelAtPeriodEnd: state.coachCancelAtPeriodEnd,
    coachPastDue: state.coachPastDue,
    metlabYearlyCancelAtPeriodEnd: state.metlabYearlyCancelAtPeriodEnd,
    // users/{uid}.features.coaching grant (no Stripe sub). Does NOT qualify
    // for the Shockwave member rate (owner decision D7).
    coachingGranted: state.coachingGranted,
    paymentsLoaded: state.paymentsLoaded,
    userDocLoaded: state.userDocLoaded,
    // True once the user doc, payments and subscriptions snapshots have each
    // delivered (or errored) once; for a signed-out visitor, once auth is known.
    loaded: entitlementsLoaded(),
    entitlementsLoaded: entitlementsLoaded(),
    metlab: {
      uploadAccess: metlabUpload,
      source: metlabSource,
      until: metlabUntil,
      hasLifetime: state.metlabHasLifetime,
      yearlyActive: state.metlabYearlyActive,
      yearlyPeriodEnd: state.metlabYearlyPeriodEnd,
      yearlyCancelAtPeriodEnd: state.metlabYearlyCancelAtPeriodEnd,
      singleSessionUntil: state.metlabSingleUntil,
      inPersonLatest: state.metlabInPersonLatest,
      adminGranted: state.metlabAdminGranted
    }
  };
}

function entitlementsLoaded() {
  if (!state.user) return state.authResolved || state.authGaveUp;
  return state.subsLoaded && state.paymentsLoaded && state.userDocLoaded;
}

function attachPassWatchers(uid) {
  passWatchers.user = db.collection('users').doc(uid).onSnapshot(function (snap) {
    state.userDoc = snap.exists ? snap.data() : {};
    state.userDocLoaded = true;
    state.hasGrantedFlag = !!(state.userDoc.features && state.userDoc.features.esFormLab === true);
    state.grantedUntilSec = toSeconds(state.userDoc.formAnalyzerPassUntil);
    state.metlabAdminGranted = !!(state.userDoc.features && state.userDoc.features.esMetabolicLab === true);
    state.coachingGranted = !!(state.userDoc.features && state.userDoc.features.coaching === true);
    // Sync the saved theme preference (source of truth across devices).
    if ((state.userDoc.theme === 'light' || state.userDoc.theme === 'dark')
        && state.userDoc.theme !== currentTheme()) {
      applyTheme(state.userDoc.theme);
    }
    notifyPassListeners();
  }, function (err) {
    console.warn('users doc snapshot:', err.message);
    state.userDocLoaded = true;
    notifyPassListeners();
  });

  passWatchers.payments = db.collection('customers').doc(uid).collection('payments')
    .onSnapshot(function (snap) {
      var now = Math.floor(Date.now() / 1000);
      var active = false; var until = null;
      // esMetabolicLab one-time purchases:
      var hasLifetime = false;
      var latestSingleSec = null;
      var latestInPersonSec = null;
      var latestShockwaveSec = null;
      snap.docs.forEach(function (d) {
        var p = d.data();
        if (p.status !== 'succeeded') return;
        var sec = toSeconds(p.created);
        if (sec === null) return;
        // Per-price detection. Look at line_items + price metadata recorded by the extension.
        var paidPriceIds = paymentPriceIds(p);
        // esFormLab 90-day pass
        var isPassPayment = paidPriceIds.some(function (id) {
          return ESFORMLAB_PASS_PRICE_IDS.indexOf(id) !== -1;
        });
        if (isPassPayment && now - sec < PASS_DURATION_SEC) {
          active = true;
          var u = sec + PASS_DURATION_SEC;
          if (until === null || u > until) until = u;
        }
        if (paidPriceIds.indexOf(METLAB_LIFETIME_PRICE_ID) !== -1) {
          hasLifetime = true;
        }
        if (paidPriceIds.indexOf(METLAB_SINGLE_PRICE_ID) !== -1) {
          if (latestSingleSec === null || sec > latestSingleSec) latestSingleSec = sec;
        }
        if (paidPriceIds.indexOf(METLAB_INPERSON_PRICE_ID) !== -1) {
          if (latestInPersonSec === null || sec > latestInPersonSec) latestInPersonSec = sec;
        }
        var isShockwave = paidPriceIds.some(function (id) {
          return SHOCKWAVE_PRICE_IDS.indexOf(id) !== -1;
        });
        if (isShockwave && (latestShockwaveSec === null || sec > latestShockwaveSec)) {
          latestShockwaveSec = sec;
        }
      });
      state.hasPaidPass = active;
      state.paidPassUntil = until;
      state.metlabHasLifetime = hasLifetime;
      state.metlabSingleUntil = latestSingleSec ? (latestSingleSec + METLAB_SINGLE_WINDOW_SEC) : null;
      state.metlabInPersonLatest = latestInPersonSec;
      state.shockwaveLatestPaid = latestShockwaveSec;
      state.paymentsLoaded = true;
      notifyPassListeners();
    }, function (err) {
      console.warn('payments snapshot:', err.message);
      state.paymentsLoaded = true;
      notifyPassListeners();
    });

  passWatchers.subs = db.collection('customers').doc(uid).collection('subscriptions')
    .onSnapshot(function (snap) {
      var foundPremium = null;
      var foundStandard = null;
      var foundMetlabYearly = null;
      var pastDue = null;
      snap.docs.forEach(function (d) {
        var sub = d.data();
        var ids = collectPriceIds(sub);
        var isPremium = ids.some(function (id) { return COACHING_PREMIUM_PRICE_IDS.indexOf(id) !== -1; });
        var isStandard = !isPremium && ids.some(function (id) { return COACHING_STANDARD_PRICE_IDS.indexOf(id) !== -1; });
        // Display only: a failed coaching payment. Never unlocks anything.
        if (!pastDue && (isPremium || isStandard) && (sub.status === 'past_due' || sub.status === 'unpaid')) {
          pastDue = { tier: isPremium ? 'premium' : 'standard', periodEnd: toSeconds(sub.current_period_end), status: sub.status };
        }
        if (sub.status !== 'active' && sub.status !== 'trialing') return;
        if (isPremium) { foundPremium = sub; return; }
        if (isStandard) { foundStandard = sub; }
        if (ids.indexOf(METLAB_YEARLY_PRICE_ID) !== -1) { foundMetlabYearly = sub; }
      });
      var coachSub = foundPremium || foundStandard;
      state.hasPremiumCoach = !!foundPremium;
      state.hasStandardCoach = !!foundStandard;
      state.premiumCoachPeriodEnd = foundPremium ? toSeconds(foundPremium.current_period_end) : null;
      state.standardCoachPeriodEnd = foundStandard ? toSeconds(foundStandard.current_period_end) : null;
      state.coachCancelAtPeriodEnd = !!(coachSub && coachSub.cancel_at_period_end);
      state.coachPastDue = coachSub ? null : pastDue;
      state.metlabYearlyActive = !!foundMetlabYearly;
      state.metlabYearlyPeriodEnd = foundMetlabYearly ? toSeconds(foundMetlabYearly.current_period_end) : null;
      state.metlabYearlyCancelAtPeriodEnd = !!(foundMetlabYearly && foundMetlabYearly.cancel_at_period_end);
      state.subsLoaded = true;
      notifyPassListeners();
    }, function (err) {
      console.warn('subs snapshot:', err.message);
      // Unknown membership prices at list rate rather than blocking checkout.
      state.subsLoaded = true;
      notifyPassListeners();
    });
}

// Extract the price IDs that a Stripe payment doc was for. The extension writes
// `items[].price.id` for line items but older versions use `prices[]`. Try both.
function paymentPriceIds(p) {
  var out = [];
  if (Array.isArray(p.items)) {
    p.items.forEach(function (it) {
      if (it && it.price && typeof it.price.id === 'string') out.push(it.price.id);
      else if (typeof it.price === 'string') out.push(it.price);
    });
  }
  if (Array.isArray(p.prices)) {
    p.prices.forEach(function (pp) {
      if (pp && typeof pp.id === 'string') out.push(pp.id);
      else if (typeof pp === 'string') out.push(pp);
    });
  }
  // Some checkout-sessions also record amount/price directly on the doc
  if (typeof p.price === 'string') out.push(p.price);
  return out;
}

function detachPassWatchers() {
  if (passWatchers.user) { passWatchers.user(); passWatchers.user = null; }
  if (passWatchers.payments) { passWatchers.payments(); passWatchers.payments = null; }
  if (passWatchers.subs) { passWatchers.subs(); passWatchers.subs = null; }
}

function onPassChange(cb) {
  passListeners.push(cb);
  try { cb(passSnapshot()); } catch (e) { console.error(e); }
  return function () {
    var i = passListeners.indexOf(cb);
    if (i !== -1) passListeners.splice(i, 1);
  };
}

function collectPriceIds(sub) {
  var out = [];
  if (Array.isArray(sub.items)) {
    sub.items.forEach(function (it) {
      if (it && it.price && typeof it.price.id === 'string') out.push(it.price.id);
      else if (typeof it.price === 'string') out.push(it.price);
    });
  }
  if (Array.isArray(sub.prices)) {
    sub.prices.forEach(function (p) {
      if (p && typeof p.id === 'string') out.push(p.id);
    });
  }
  return out;
}

function toSeconds(t) {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return t;
  if (typeof t.seconds === 'number') return t.seconds;
  if (typeof t.toDate === 'function') {
    try { return Math.floor(t.toDate().getTime() / 1000); } catch (e) { return null; }
  }
  return null;
}

// ── Stripe customer portal ───────────────────────────────────────
// Purchases and billing always go to the REAL signed-in account. While the
// admin is acting as an athlete that would charge / open the admin's own
// billing, so refuse (owner decision D7). Returns true when it's OK to go on.
function requireNotActing() {
  var act = getActAs();
  if (!act) return true;
  var who = act.name || act.email || 'this athlete';
  toast('Stop acting as ' + who + ' to buy or manage billing \u2014 purchases always go to your own account.', { err: true });
  return false;
}
function actingRefusal() {
  var e = new Error('Purchases and billing are unavailable while acting as another user.');
  e.code = 'eslabs/acting-as';
  e.handled = true;   // the toast already told the user
  return e;
}

// Signed-out fallback for checkout / portal calls: open the sign-in UI
// (the visible page gate, else the shared sign-in dialog). Callers'
// .then/.catch chains keep working (resolves without starting checkout).
function requireSignIn(trigger) {
  openSignIn({ trigger: trigger });
  return Promise.resolve();
}

function openCustomerPortal() {
  if (!state.user) return requireSignIn();
  if (!requireNotActing()) return Promise.resolve();
  var fns = firebase.app().functions('us-central1');
  var createPortalLink = fns.httpsCallable('ext-firestore-stripe-payments-createPortalLink');
  return createPortalLink({ returnUrl: window.location.href }).then(function (result) {
    var url = result && result.data && result.data.url;
    if (url) window.location.assign(url);
    else alert('Could not open the subscription portal. Please try again.');
  }).catch(function (e) {
    console.error('Customer portal error:', e);
    alert('Could not open the subscription portal: ' + (e.message || e));
  });
}

// Write a checkout_sessions doc for the signed-in user; the Stripe
// extension fills in the hosted URL (or an error) and we redirect to it.
function startCheckout(priceId, mode, successUrl, cancelUrl) {
  if (!requireNotActing()) return Promise.reject(actingRefusal());
  return db.collection('customers').doc(state.user.uid)
    .collection('checkout_sessions').add({
      mode: mode,
      price: priceId,
      success_url: successUrl,
      cancel_url: cancelUrl || window.location.href,
      allow_promotion_codes: true
    }).then(function (ref) {
      return new Promise(function (resolve, reject) {
        ref.onSnapshot(function (snap) {
          var data = snap.data();
          if (!data) return;
          if (data.error) { reject(new Error(data.error.message)); return; }
          if (data.url) { window.location.assign(data.url); resolve(); }
        });
      });
    });
}

function startPassCheckout(opts) {
  opts = opts || {};
  if (!state.user) return requireSignIn();
  return startCheckout(STRIPE_PASS_PRICE_ID, 'payment',
    opts.successUrl || (window.location.origin + '/esformlab/?paid=1'), opts.cancelUrl);
}

// Generic checkout starter for esMetabolicLab purchases.
//   tier: 'lifetime' | 'yearly' | 'single' | 'inperson'
//   opts: { successUrl, cancelUrl }
// On success the Stripe extension redirects to the success URL with ?paid=1.
function startMetlabCheckout(tier, opts) {
  opts = opts || {};
  if (!state.user) return requireSignIn();
  var priceId, mode;
  if (tier === 'lifetime')      { priceId = METLAB_LIFETIME_PRICE_ID; mode = 'payment'; }
  else if (tier === 'yearly')   { priceId = METLAB_YEARLY_PRICE_ID;   mode = 'subscription'; }
  else if (tier === 'single')   { priceId = METLAB_SINGLE_PRICE_ID;   mode = 'payment'; }
  else if (tier === 'inperson') { priceId = METLAB_INPERSON_PRICE_ID; mode = 'payment'; }
  else return Promise.reject(new Error('Unknown esMetabolicLab tier: ' + tier));

  var defaultSuccess = window.location.origin + window.location.pathname + '?paid=1';
  return startCheckout(priceId, mode, opts.successUrl || defaultSuccess, opts.cancelUrl);
}

// Checkout for one Shockwave + EMTT session.
//   rate: 'standard' ($150) | 'member' ($50, active coaching subscribers only)
// On success Stripe redirects back to /shockwave/?paid=1 to pick a time.
function startShockwaveCheckout(rate, opts) {
  opts = opts || {};
  if (!state.user) return requireSignIn();
  var priceId;
  if (rate === 'standard') priceId = SHOCKWAVE_PRICE_ID;
  else if (rate === 'member') {
    if (!state.hasPremiumCoach && !state.hasStandardCoach) {
      return Promise.reject(new Error('The member rate is for active coaching athletes.'));
    }
    priceId = SHOCKWAVE_MEMBER_PRICE_ID;
  }
  else return Promise.reject(new Error('Unknown Shockwave rate: ' + rate));
  return startCheckout(priceId, 'payment',
    opts.successUrl || (window.location.origin + '/shockwave/?paid=1'), opts.cancelUrl);
}

// ── Nav mounting ─────────────────────────────────────────────────
// The nav links live in the shared module. Pages pass `active` to
// highlight one.
var NAV_LINKS = [
  { key: 'home',        label: 'Home',              href: '/' },
  { key: 'esformlab',   label: 'Form analysis',     href: '/esformlab/' },
  { key: 'coaching',    label: 'Coaching',          href: '/coaching/' },
  { key: 'esmetlab',    label: 'Metabolic testing', href: '/esmetaboliclab/' },
  { key: 'shockwave',   label: 'Shockwave',         href: '/shockwave/' }
];

var mountedNavs = [];   // [{ el, opts }]
var navSeq = 0;

// mountNav(selectorOrEl, opts)
//   opts.active          NAV_LINKS key to highlight ('account' marks the pill)
//   opts.extrasHtml      extra controls before the auth pill (desktop)
//   opts.mobileExtrasHtml extra controls inside the mobile menu
//   opts.onRender(host, realUser)  post-render hook (runs on every re-render)
//   opts.collapse:'wide' hamburger up to 1140px instead of 768px
function mountNav(selectorOrEl, opts) {
  opts = opts || {};
  var host = resolveEl(selectorOrEl);
  if (!host) return null;
  host.classList.add('eslabs-nav');
  if (opts.collapse === 'wide') host.classList.add('nav-collapse-wide');
  if (!host.id) host.id = 'eslabs-nav-' + (++navSeq);
  host.classList.remove('menu-open');
  host.innerHTML = renderNavHtml(opts, host.id);
  wireNav(host, opts);
  if (!host._eslNavHostWired) { wireNavHost(host); host._eslNavHostWired = true; }
  swapThemedLogos(currentTheme());
  // Re-mounting the same host replaces its entry instead of stacking another.
  var existing = null;
  mountedNavs.forEach(function (m) { if (m.el === host) existing = m; });
  if (existing) existing.opts = opts;
  else mountedNavs.push({ el: host, opts: opts });
  syncGatePositions();
  return host;
}

// Re-render every mounted nav from the current auth state (e.g. after a
// profile name change). Exported as esLabs.refreshNav().
function refreshMountedNav() {
  mountedNavs.forEach(function (m) {
    if (!document.body.contains(m.el)) return;
    m.el.classList.remove('menu-open');
    m.el.innerHTML = renderNavHtml(m.opts, m.el.id);
    wireNav(m.el, m.opts);
  });
  swapThemedLogos(currentTheme());
  syncGatePositions();
}

function navUserName(user) {
  if (!user) return '';
  return user.displayName
    || (user.providerData && user.providerData[0] ? user.providerData[0].displayName : null)
    || (user.email ? user.email.split('@')[0] : 'User');
}

function renderNavHtml(opts, hostId) {
  var active = opts.active || '';
  var user = state.user;   // the REAL account (deliberate: see the act-as notes)
  var linksId = (hostId || 'eslabs-nav') + '-links';

  var linksHtml = NAV_LINKS.map(function (link) {
    var on = link.key === active;
    return '<a class="nav-link' + (on ? ' active' : '') + '" href="' + link.href + '"'
      + (on ? ' aria-current="page"' : '') + '>' + escapeHtml(link.label) + '</a>';
  }).join('');

  var rightHtml, mobileAuthHtml;
  var acct = active === 'account';
  if (user) {
    var name = navUserName(user);
    var photo = user.photoURL
      || (user.providerData && user.providerData[0] ? user.providerData[0].photoURL : null)
      || '';
    var initial = (String(name || '').trim().charAt(0) || '?').toUpperCase();
    rightHtml = ''
      + '<a class="nav-auth-pill" href="/account/" title="My account" aria-label="' + escapeAttr('My account (' + name + ')') + '"'
      + (acct ? ' aria-current="page"' : '') + '>'
      + (photo
          ? '<img class="nav-auth-avatar" src="' + escapeAttr(photo) + '" alt="">'
          : '<span class="nav-auth-avatar nav-auth-initial" aria-hidden="true">' + escapeHtml(initial) + '</span>')
      + '<span class="nav-auth-name">' + escapeHtml(name) + '</span>'
      + '</a>';
    mobileAuthHtml = ''
      + '<a class="nav-mobile-row" href="/account/"' + (acct ? ' aria-current="page"' : '') + '>'
      + (photo
          ? '<img src="' + escapeAttr(photo) + '" alt="">'
          : '<span class="nav-auth-initial" aria-hidden="true">' + escapeHtml(initial) + '</span>')
      + '<span class="nav-mobile-name">' + escapeHtml(name) + '</span>'
      + '</a>'
      + '<a class="nav-mobile-action" href="/account/">My account</a>'
      + '<button type="button" class="nav-mobile-action signout" data-eslabs-signout>Sign out</button>';
  } else if (!state.authResolved && !state.authGaveUp) {
    // Auth still restoring: reserve the slot, never flash "Sign in".
    rightHtml = '<span class="nav-auth-pending" aria-hidden="true"></span>';
    mobileAuthHtml = '';
  } else {
    rightHtml = '<button type="button" class="nav-signin-btn" data-eslabs-signin>Sign in</button>';
    mobileAuthHtml = '<button type="button" class="nav-mobile-action primary" data-eslabs-signin>Sign in</button>';
  }

  var extrasHtml = opts.extrasHtml || '';
  var mobileExtrasHtml = opts.mobileExtrasHtml || '';

  return ''
    + '<a class="esl-skip" href="#main" data-eslabs-skip>Skip to content</a>'
    + '<a href="/" class="nav-logo" aria-label="Endurance Science Labs home">'
    + '  <img src="/images/generic_logo_white_clean.png" alt="Endurance Science Labs" class="nav-logo-img">'
    + '</a>'
    + '<button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="' + linksId + '" data-eslabs-nav-toggle>'
    + '<span></span><span></span><span></span>'
    + '</button>'
    + '<div class="nav-links" id="' + linksId + '">' + linksHtml
    + '  <div class="nav-mobile-section">' + mobileAuthHtml + mobileExtrasHtml + '</div>'
    + '</div>'
    + '<div class="nav-right">' + extrasHtml + rightHtml + '</div>';
}

function setMenu(host, open, returnFocus) {
  host.classList.toggle('menu-open', !!open);
  var t = host.querySelector('[data-eslabs-nav-toggle]');
  if (t) {
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && returnFocus) { try { t.focus(); } catch (e) {} }
  }
}

function isShown(el) {
  return !!(el && el.getClientRects && el.getClientRects().length);
}

// Where "Skip to content" lands: a visible page gate, else #main / main /
// [role=main] / the first h1, else the first visible sibling after the nav.
function skipTarget(host) {
  var pg = visiblePageGate();
  if (pg) return pg.host.querySelector('[data-eslabs-title]') || pg.host;
  var sels = ['#main', 'main', '[role="main"]', 'h1'];
  for (var i = 0; i < sels.length; i++) {
    var list = document.querySelectorAll(sels[i]);
    for (var j = 0; j < list.length; j++) {
      if (!host.contains(list[j]) && isShown(list[j])) return list[j];
    }
  }
  var sib = host.nextElementSibling;
  while (sib) {
    if (!sib.classList.contains('eslabs-gate') && isShown(sib)) return sib;
    sib = sib.nextElementSibling;
  }
  return null;
}

function wireNav(host, opts) {
  // Hamburger toggle
  var toggle = host.querySelector('[data-eslabs-nav-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      setMenu(host, !host.classList.contains('menu-open'));
    });
  }
  // Skip link
  var skip = host.querySelector('[data-eslabs-skip]');
  if (skip) {
    skip.addEventListener('click', function (e) {
      var t = skipTarget(host);
      if (!t) return;
      e.preventDefault();
      if (!t.matches('a[href],button,input,select,textarea,[tabindex]')) t.setAttribute('tabindex', '-1');
      try { t.focus(); } catch (err) {}
    });
  }
  // Sign in -- the visible page gate, else the shared sign-in dialog (D9).
  host.querySelectorAll('[data-eslabs-signin]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMenu(host, false);
      openSignIn({ trigger: btn });
    });
  });
  // Sign out
  host.querySelectorAll('[data-eslabs-signout]').forEach(function (btn) {
    btn.addEventListener('click', function () { signOut(); });
  });
  // Page-supplied post-render hook (for extras buttons etc.)
  if (typeof opts.onRender === 'function') {
    try { opts.onRender(host, state.user); } catch (e) { console.error(e); }
  }
}

// Host-level listeners, attached once per host (re-renders keep them).
function wireNavHost(host) {
  // A tap on the scrim (the nav's ::after) targets the host itself.
  host.addEventListener('click', function (e) {
    if (e.target === host && host.classList.contains('menu-open')) setMenu(host, false);
  });
  host.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && host.classList.contains('menu-open')) {
      setMenu(host, false, true);
      e.stopPropagation();
    }
  });
}

// D9: page gates sit below a visible, top-pinned nav so it stays usable.
// A nav inside a hidden container (e.g. coaching's #app before sign-in) is
// ignored, so those gates stay full-screen until the page moves its nav.
var gateResizeWired = false;
function syncGatePositions() {
  var nav = null;
  mountedNavs.forEach(function (m) {
    if (nav || !document.body.contains(m.el) || !isShown(m.el)) return;
    var pos = getComputedStyle(m.el).position;
    if (pos === 'sticky' || pos === 'fixed') nav = m.el;
  });
  var top = 0;
  if (nav) {
    var r = nav.getBoundingClientRect();
    top = Math.round(r.bottom);
    if (top <= 0 || top > 160) nav = null;
  }
  gateInstances.forEach(function (g) {
    if (g._modal) return;
    g.host.classList.toggle('below-nav', !!nav);
    if (nav) g.host.style.setProperty('--esl-gate-top', top + 'px');
    else g.host.style.removeProperty('--esl-gate-top');
  });
  if (!gateResizeWired && gateInstances.length) {
    gateResizeWired = true;
    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(syncGatePositions, 120);
    });
  }
}

// ── Sign-in entry point (D9) ─────────────────────────────────────
// One sign-in UI everywhere: if the page's own gate is showing, focus it;
// otherwise open the shared on-demand dialog (Google + email). After a
// sign-in through the dialog it closes, the page stays put and a toast
// confirms. Exported as esLabs.openSignIn({trigger}).
var signInDialog = null;

function visiblePageGate() {
  for (var i = 0; i < gateInstances.length; i++) {
    var g = gateInstances[i];
    if (g._modal || !document.body.contains(g.host)) continue;
    if (!g.host.classList.contains('hidden') && isShown(g.host)) return g;
  }
  return null;
}

function siteCssLoaded() {
  try { return !!getComputedStyle(document.documentElement).getPropertyValue('--r-xl').trim(); }
  catch (e) { return false; }
}

function ensureSignInDialog() {
  if (signInDialog && document.body.contains(signInDialog.host)) return signInDialog;
  var el = document.createElement('div');
  el.id = 'eslabs-signin-gate';
  el.className = 'hidden';
  document.body.appendChild(el);
  signInDialog = mountAuthGate(el, {
    eyebrow: '◉ Sign in',
    headline: 'Sign in to Endurance Science Labs',
    sub: 'Use Google or your email.',
    emailDefault: 'signin',
    dismissable: true,
    modal: true,
    autoShow: false,
    backLink: false,
    _signinDialog: true
  });
  return signInDialog;
}

function openSignIn(opts) {
  opts = opts || {};
  if (state.user) return;
  var pg = visiblePageGate();
  if (pg) { pg._focusFirst(); return; }
  if (!document.body || !siteCssLoaded()) {
    // Pages without site.css (test harness pages): the old direct paths.
    if (state.gateMounted) { state.gateMounted.show(opts.trigger); return; }
    if (!googleOAuthAvailable()) { window.location.assign('/account/'); return; }
    signInGoogle().catch(function (e) { var m = friendlyAuthError(e); if (m) toast(m, { err: true }); });
    return;
  }
  ensureSignInDialog().show(opts.trigger);
}

// ── Auth gate mounting ───────────────────────────────────────────
//
// Options:
//   - logo: src URL (default: generic ESLabs logo)
//   - eyebrow: small uppercase tag above the title
//   - headline: required, the big sign-in heading
//   - sub: subtitle paragraph
//   - bullets: array of { strong, span } (or strings)
//   - microcopy: small line under the Google button (HTML allowed)
//   - foot: footer text (HTML allowed). Inline colour styles on its links
//     are stripped; site.css styles them for both themes.
//   - requireAdmin: if true, after sign-in the gate stays up and shows a
//     'not admin' message unless the user.uid === ADMIN_UID
//   - emailDefault: 'signup' (default) or 'signin'
//   - signinHeadline / signinSub: title + sub shown when a sign-up-first
//     gate is switched to Sign in (default 'Welcome back', sub hidden)
//   - subNoGoogle: replaces the sub where Google sign-in can't work
//   - backLink: false hides the default "← Back to home" (it's also hidden
//     when `foot` already contains a link). "Privacy" and "Terms" always
//     show, and so does the "By continuing you agree" line with the sign-in
//     controls.
//   - dismissable: true adds a ✕ button; Escape / a backdrop click hide it
//   - modal: true renders it as a dialog over the page (scrim, focus trap,
//     role=dialog) instead of a full page gate below the nav
//   - autoShow: false never shows from auth state, only on show()
//
// Instance: { host, show(trigger?), hide(), update(), destroy() }
function mountAuthGate(selectorOrEl, opts) {
  opts = opts || {};
  var host = resolveEl(selectorOrEl);
  if (!host) return null;
  var gid = host.id || ('eslabs-gate-' + (++gateSeq));
  host._eslGid = gid;
  host._eslGateOpts = opts;
  host._eslMode = (opts.emailDefault === 'signin') ? 'signin' : 'signup';
  host.classList.add('eslabs-gate');
  if (opts.modal) {
    host.classList.add('is-dialog');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
  } else {
    host.setAttribute('role', 'region');
  }
  host.setAttribute('aria-labelledby', gid + '-title');
  host.innerHTML = gateInnerHtml(opts, gid);
  wireGate(host, opts);
  swapThemedLogos(currentTheme());

  var lastFocus = null;
  var instance = {
    host: host,
    _modal: !!opts.modal,
    show: function (trigger) {
      var wasHidden = host.classList.contains('hidden');
      host.classList.remove('hidden');
      host.classList.remove('is-pending');
      syncGatePositions();
      if (!host._eslBusy) resetEmailForm(host, false);
      // A user action or a sign-out (not first paint): move focus in.
      if (wasHidden && state.authResolved) {
        var a = (trigger && trigger.focus) ? trigger : document.activeElement;
        lastFocus = (a && a !== document.body && !host.contains(a)) ? a : null;
        instance._focusFirst();
      }
    },
    hide: function () {
      var hadFocus = host.contains(document.activeElement);
      host.classList.add('hidden');
      host.classList.remove('is-pending');
      if (hadFocus && lastFocus && document.body.contains(lastFocus)) {
        try { lastFocus.focus(); } catch (e) {}
      }
      lastFocus = null;
    },
    update: function () {
      var cardBody = host.querySelector('.eslabs-gate-body');
      host._eslMode = (opts.emailDefault === 'signin') ? 'signin' : 'signup';
      if (cardBody) cardBody.innerHTML = gateBodyHtml(opts, gid);
      wireGate(host, opts);
      swapThemedLogos(currentTheme());
      instance._sync();
    },
    _focusFirst: function () {
      var pick = null;
      ['[data-eslabs-google]', '[data-eslabs-email]', '.eslabs-gate-deny [data-eslabs-signout]'].some(function (sel) {
        var el = host.querySelector(sel);
        if (el && isShown(el)) { pick = el; return true; }
        return false;
      });
      if (!pick) pick = focusables(host)[0] || null;
      if (pick) { try { pick.focus(); } catch (e) {} }
    }
  };

  instance._sync = function () {
    var user = effectiveUser();
    if (opts.autoShow === false) {
      host.classList.remove('is-pending');
      if (user && !host.classList.contains('hidden')) {
        resetEmailForm(host, true);
        instance.hide();
        if (opts._signinDialog) toast('Signed in as ' + navUserName(state.user) + '.');
      }
      return;
    }
    if (!user && !state.authResolved && !state.authGaveUp) {
      // Auth still restoring: a small delayed spinner, never the sign-up card.
      host.classList.add('is-pending');
      host.classList.remove('hidden');
      syncGatePositions();
      return;
    }
    host.classList.remove('is-pending');
    if (!user) {
      clearDeny(host);
      instance.show();
    } else if (opts.requireAdmin && (user.realUid || user.uid) !== ADMIN_UID) {
      instance.show();
      showDeny(host, user);
    } else {
      clearDeny(host);
      resetEmailForm(host, true);
      instance.hide();
    }
  };

  // Host-level listeners (once per host; update() re-wires only the body).
  host.addEventListener('click', function (e) {
    var close = e.target.closest && e.target.closest('[data-eslabs-gate-close]');
    if (close) { e.preventDefault(); instance.hide(); return; }
    if (opts.dismissable && e.target === host) instance.hide();
  });
  host.addEventListener('keydown', function (e) {
    if (host.classList.contains('hidden')) return;
    if (e.key === 'Escape' && opts.dismissable) {
      e.stopPropagation();
      instance.hide();
      return;
    }
    if (e.key === 'Tab' && opts.modal) trapTab(e, host);
  });

  gateInstances.push(instance);
  var unsub = onAuthChange(function () { instance._sync(); });
  instance.destroy = function () {
    unsub();
    var i = gateInstances.indexOf(instance);
    if (i !== -1) gateInstances.splice(i, 1);
    if (state.gateMounted === instance) state.gateMounted = null;
    host.innerHTML = '';
  };
  if (!opts._signinDialog) state.gateMounted = instance;
  if (opts.requireAdmin && document.getElementById('eslabs-actas-banner')) refreshActAsBanner();
  syncGatePositions();
  return instance;
}

function gateInnerHtml(opts, gid) {
  return '<div class="eslabs-gate-card"><div class="eslabs-gate-body">' + gateBodyHtml(opts, gid) + '</div></div>'
    + '<div class="eslabs-gate-pending" role="status"><span class="esl-spin" aria-hidden="true"></span>'
    + '<span class="esl-sr-only">Checking sign-in…</span></div>';
}

function gateBodyHtml(opts, gid) {
  gid = gid || 'eslabs-gate';
  var logo = opts.logo || '/images/generic_logo_white_clean.png';
  var eyebrow = opts.eyebrow || '◉ Sign in';
  var headline = opts.headline || 'Sign in to Endurance Science Labs';
  var sub = opts.sub || '';
  var microcopy = opts.microcopy || '<strong>Free account</strong> · 1-tap signup';
  var foot = opts.foot || '';
  var bullets = Array.isArray(opts.bullets) ? opts.bullets : [];
  var emailDefault = (opts.emailDefault === 'signin') ? 'signin' : 'signup';
  var showBack = opts.backLink !== false && !/<a[\s>]/i.test(foot);
  state.emailAuthMode = emailDefault;

  var bulletsHtml = bullets.map(function (b) {
    var strong = '', span = '';
    if (typeof b === 'string') { strong = b; }
    else { strong = b.strong || ''; span = b.span || ''; }
    return '<div class="eslabs-gate-bullet"><span class="eslabs-gate-bullet-check" aria-hidden="true">✓</span><div>'
      + (strong ? '<strong>' + escapeHtml(strong) + '</strong> ' : '')
      + (span ? '<span>' + escapeHtml(span) + '</span>' : '')
      + '</div></div>';
  }).join('');

  return ''
    + (opts.dismissable ? '<button type="button" class="eslabs-gate-close" data-eslabs-gate-close aria-label="Close">✕</button>' : '')
    + '<a class="eslabs-gate-logo-link" href="/" aria-label="Endurance Science Labs home">'
    + '<img src="' + escapeAttr(logo) + '" alt="" class="eslabs-gate-logo"></a>'
    + (eyebrow ? '<div class="eslabs-gate-eyebrow">' + escapeHtml(eyebrow) + '</div>' : '')
    + '<h2 class="eslabs-gate-title" id="' + gid + '-title" data-eslabs-title>' + escapeHtml(headline) + '</h2>'
    + '<p class="eslabs-gate-sub" data-eslabs-sub' + (sub ? '' : ' hidden') + '>' + escapeHtml(sub) + '</p>'
    + (bulletsHtml ? '<div class="eslabs-gate-bullets">' + bulletsHtml + '</div>' : '')
    + '<button type="button" class="eslabs-gate-google-btn" data-eslabs-google aria-label="Continue with Google">'
    + '  <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>'
    + '  Continue with Google'
    + '</button>'
    + '<div class="eslabs-gate-microcopy">' + microcopy + '</div>'
    + '<div class="eslabs-gate-email-toggle">'
    + '  <button class="eslabs-gate-email-toggle-btn" data-eslabs-email-toggle type="button" aria-expanded="false" aria-controls="' + gid + '-email">'
    + '    <span data-eslabs-email-toggle-label>Use email instead</span>'
    + '    <span class="caret" aria-hidden="true">▼</span>'
    + '  </button>'
    + '</div>'
    + '<div class="eslabs-gate-email-form" id="' + gid + '-email" data-eslabs-email-form>'
    + '  <div class="eslabs-gate-notice" data-eslabs-notice hidden></div>'
    + '  <div class="eslabs-gate-mode" role="group" aria-label="Email sign-in mode">'
    + '    <button class="eslabs-gate-mode-tab' + (emailDefault === 'signup' ? ' active' : '') + '" data-eslabs-mode="signup" type="button" aria-pressed="' + (emailDefault === 'signup') + '">Create account</button>'
    + '    <button class="eslabs-gate-mode-tab' + (emailDefault === 'signin' ? ' active' : '') + '" data-eslabs-mode="signin" type="button" aria-pressed="' + (emailDefault === 'signin') + '">Sign in</button>'
    + '  </div>'
    + '  <label class="esl-sr-only" for="' + gid + '-em">Email</label>'
    + '  <input type="email" id="' + gid + '-em" class="eslabs-gate-email-input" data-eslabs-email placeholder="you@example.com" autocomplete="email" aria-describedby="' + gid + '-err">'
    + '  <label class="esl-sr-only" for="' + gid + '-pw">Password</label>'
    + '  <input type="password" id="' + gid + '-pw" class="eslabs-gate-email-input" data-eslabs-password placeholder="' + (emailDefault === 'signup' ? 'Password (6+ characters)' : 'Password') + '" autocomplete="' + (emailDefault === 'signup' ? 'new-password' : 'current-password') + '" aria-describedby="' + gid + '-err">'
    + '  <button class="eslabs-gate-email-submit" data-eslabs-email-submit type="button">' + (emailDefault === 'signup' ? 'Create account' : 'Sign in') + '</button>'
    + '  <button class="eslabs-gate-forgot" data-eslabs-forgot type="button" style="' + (emailDefault === 'signin' ? '' : 'display:none') + '">Forgot your password?</button>'
    + '  <div role="alert"><div class="eslabs-gate-error" id="' + gid + '-err" data-eslabs-error></div></div>'
    + '</div>'
    + '<p class="eslabs-gate-consent">By continuing you agree to our <a href="/terms/">Terms</a> and <a href="/privacy/">Privacy Policy</a>.</p>'
    + (foot ? '<div class="eslabs-gate-foot">' + foot + '</div>' : '')
    + '<div class="eslabs-gate-links">'
    + (showBack ? '<a href="/">← Back to home</a><span aria-hidden="true">·</span>' : '')
    + '<a href="/privacy/">Privacy</a><span aria-hidden="true">·</span><a href="/terms/">Terms</a></div>';
}

function wireGate(host, opts) {
  var googleBtn = host.querySelector('[data-eslabs-google]');
  if (googleBtn) googleBtn.addEventListener('click', function () {
    googleBtn.disabled = true;
    signInGoogle().catch(function (e) {
      showGateError(host, friendlyAuthError(e));
    }).then(function () { googleBtn.disabled = false; });
  });

  // Page-supplied foot links: drop inline colours (they fail in light);
  // site.css styles them. Their data-* hooks are untouched.
  host.querySelectorAll('.eslabs-gate-foot a').forEach(function (a) {
    a.style.removeProperty('color');
    a.style.removeProperty('text-decoration');
  });

  var toggle = host.querySelector('[data-eslabs-email-toggle]');
  var form = host.querySelector('[data-eslabs-email-form]');
  var toggleLabel = host.querySelector('[data-eslabs-email-toggle-label]');

  // Where Google OAuth can't work (private mode / in-app browser), hide the
  // button before it dumps the user on Firebase's blank error page, open the
  // email form, and explain why in a notice that mode switches can't erase.
  host._eslNoGoogle = false;
  if (googleBtn && !googleOAuthAvailable()) {
    host._eslNoGoogle = true;
    googleBtn.style.display = 'none';
    var micro = host.querySelector('.eslabs-gate-microcopy');
    if (micro) micro.style.display = 'none';
    if (form) form.classList.add('open');
    if (toggle) { toggle.style.display = 'none'; toggle.setAttribute('aria-expanded', 'true'); }
    var notice = host.querySelector('[data-eslabs-notice]');
    if (notice) {
      notice.innerHTML = '<p class="eslabs-gate-notice-title">Google sign-in isn’t available in this browser</p>'
        + '<p>Apps like Instagram and Facebook, and private browsing, block it. Signed up with Google before? '
        + 'Open this page in Safari or Chrome (in Instagram or Facebook, tap ⋯ then “Open in browser”). '
        + 'New here? Use your email below.</p>'
        + '<button type="button" class="esl-btn esl-btn--outline esl-btn--sm" data-eslabs-copylink>Copy link</button>';
      notice.hidden = false;
      var copyBtn = notice.querySelector('[data-eslabs-copylink]');
      copyBtn.addEventListener('click', function () { copyPageLink(copyBtn); });
    }
    if (opts.subNoGoogle) {
      var subEl = host.querySelector('[data-eslabs-sub]');
      if (subEl) { subEl.textContent = opts.subNoGoogle; subEl.hidden = false; }
    }
  }

  if (toggle && form) {
    toggle.addEventListener('click', function () {
      var open = form.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (toggleLabel) toggleLabel.textContent = open ? 'Hide email form' : 'Use email instead';
      if (open) {
        setTimeout(function () {
          // Only if focus hasn't moved on to another field meanwhile.
          var e = host.querySelector('[data-eslabs-email]');
          var ae = document.activeElement;
          if (e && (ae === toggle || ae === document.body || !host.contains(ae))) e.focus();
        }, 60);
      }
    });
  }

  host.querySelectorAll('[data-eslabs-mode]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      setEmailMode(host, tab.getAttribute('data-eslabs-mode'));
    });
  });

  var submit = host.querySelector('[data-eslabs-email-submit]');
  if (submit) submit.addEventListener('click', function () { submitEmailAuth(host); });

  host.querySelectorAll('[data-eslabs-email], [data-eslabs-password]').forEach(function (inp) {
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitEmailAuth(host);
    });
    inp.addEventListener('input', function () { inp.removeAttribute('aria-invalid'); });
  });

  var forgot = host.querySelector('[data-eslabs-forgot]');
  if (forgot) forgot.addEventListener('click', function () { doPasswordReset(host); });
}

function copyPageLink(btn) {
  var url = window.location.href;
  function done(ok) {
    btn.textContent = ok ? 'Link copied' : 'Couldn’t copy — use the ⋯ menu';
    setTimeout(function () { btn.textContent = 'Copy link'; }, 2000);
  }
  function fallback() {
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) { ok = false; }
    done(ok);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () { done(true); }, fallback);
  } else {
    fallback();
  }
}

function setEmailMode(host, mode) {
  var m = (mode === 'signin') ? 'signin' : 'signup';
  host._eslMode = m;
  state.emailAuthMode = m;
  host.querySelectorAll('[data-eslabs-mode]').forEach(function (t) {
    var on = t.getAttribute('data-eslabs-mode') === m;
    t.classList.toggle('active', on);
    t.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  var submit = host.querySelector('[data-eslabs-email-submit]');
  if (submit && !host._eslBusy) submit.textContent = m === 'signup' ? 'Create account' : 'Sign in';
  var pw = host.querySelector('[data-eslabs-password]');
  if (pw) {
    pw.setAttribute('autocomplete', m === 'signup' ? 'new-password' : 'current-password');
    pw.placeholder = m === 'signup' ? 'Password (6+ characters)' : 'Password';
  }
  var forgot = host.querySelector('[data-eslabs-forgot]');
  if (forgot) forgot.style.display = m === 'signin' ? 'block' : 'none';
  // A sign-up-first gate switched to Sign in greets returning users.
  var opts = host._eslGateOpts || {};
  if (opts.emailDefault !== 'signin') {
    var titleEl = host.querySelector('[data-eslabs-title]');
    var subEl = host.querySelector('[data-eslabs-sub]');
    if (m === 'signin') {
      if (titleEl) titleEl.textContent = opts.signinHeadline || 'Welcome back';
      if (subEl) {
        if (opts.signinSub) { subEl.textContent = opts.signinSub; subEl.hidden = false; }
        else subEl.hidden = true;
      }
    } else {
      if (titleEl) titleEl.textContent = opts.headline || 'Sign in to Endurance Science Labs';
      if (subEl) {
        var s = (host._eslNoGoogle && opts.subNoGoogle) || opts.sub || '';
        subEl.textContent = s;
        subEl.hidden = !s;
      }
    }
  }
  clearGateError(host);
}

function markInvalid(el) {
  if (!el) return;
  el.setAttribute('aria-invalid', 'true');
  try { el.focus(); } catch (e) {}
}

// Back to a clean, usable form (after a sign-in, a sign-out, or re-showing).
function resetEmailForm(host, clearEmail) {
  var submit = host.querySelector('[data-eslabs-email-submit]');
  var emailEl = host.querySelector('[data-eslabs-email]');
  var pwEl = host.querySelector('[data-eslabs-password]');
  host._eslBusy = false;
  if (submit) {
    submit.disabled = false;
    submit.textContent = (host._eslMode || 'signup') === 'signup' ? 'Create account' : 'Sign in';
  }
  if (pwEl) { pwEl.value = ''; pwEl.removeAttribute('aria-invalid'); }
  if (emailEl) {
    emailEl.removeAttribute('aria-invalid');
    if (clearEmail) emailEl.value = '';
  }
}

function submitEmailAuth(host) {
  var emailEl = host.querySelector('[data-eslabs-email]');
  var pwEl = host.querySelector('[data-eslabs-password]');
  var submit = host.querySelector('[data-eslabs-email-submit]');
  if (!emailEl || !pwEl || !submit || host._eslBusy) return;
  var mode = host._eslMode || state.emailAuthMode;
  var email = emailEl.value.trim();
  var pw = pwEl.value;
  if (!email || !pw) {
    showGateError(host, 'Please enter both your email and a password.');
    markInvalid(!email ? emailEl : pwEl);
    return;
  }
  if (mode === 'signup' && pw.length < 6) {
    showGateError(host, 'Password must be at least 6 characters.');
    markInvalid(pwEl);
    return;
  }
  clearGateError(host);
  host._eslBusy = true;
  submit.disabled = true;
  var origLabel = mode === 'signup' ? 'Create account' : 'Sign in';
  submit.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
  var p = mode === 'signup' ? createAccount(email, pw) : signInEmail(email, pw);
  p.then(function () {
    resetEmailForm(host, true);
  }).catch(function (e) {
    host._eslBusy = false;
    submit.disabled = false;
    submit.textContent = origLabel;
    var code = e && e.code;
    if (code === 'auth/email-already-in-use') {
      showGateError(host, 'An account already exists with that email.', false, {
        label: 'Sign in instead',
        fn: function () {
          setEmailMode(host, 'signin');
          emailEl.removeAttribute('aria-invalid');
          pwEl.focus();
        }
      });
      markInvalid(emailEl);
      return;
    }
    if (code === 'auth/user-not-found') {
      showGateError(host, 'No account with that email.', false, {
        label: 'Create an account instead',
        fn: function () {
          setEmailMode(host, 'signup');
          emailEl.removeAttribute('aria-invalid');
          pwEl.focus();
        }
      });
      markInvalid(emailEl);
      return;
    }
    showGateError(host, friendlyAuthError(e));
    if (code === 'auth/invalid-email') markInvalid(emailEl);
    else if (code === 'auth/wrong-password' || code === 'auth/invalid-credential'
        || code === 'auth/invalid-login-credentials' || code === 'auth/weak-password') markInvalid(pwEl);
  });
}

function doPasswordReset(host) {
  var emailEl = host.querySelector('[data-eslabs-email]');
  if (!emailEl) return;
  var email = emailEl.value.trim();
  if (!email) {
    showGateError(host, 'Type your email in the field above first, then click Forgot password.');
    markInvalid(emailEl);
    return;
  }
  sendPasswordReset(email).then(function () {
    showGateError(host, 'Password reset email sent. Check your inbox (and spam folder).', true);
  }).catch(function (e) { showGateError(host, friendlyAuthError(e)); });
}

// action: optional { label, fn } rendered as a button after the message.
function showGateError(host, msg, isSuccess, action) {
  var err = host.querySelector('[data-eslabs-error]');
  if (!err) return;
  if (!msg) { err.classList.remove('show'); err.textContent = ''; return; }
  err.textContent = msg;
  if (action && action.label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'eslabs-gate-error-action';
    b.textContent = action.label;
    b.addEventListener('click', action.fn);
    err.appendChild(b);
  }
  err.classList.toggle('success', !!isSuccess);
  err.classList.add('show');
}
function clearGateError(host) { showGateError(host, ''); }

// Admin-only pages: signed in with the wrong account.
function showDeny(host, user) {
  var card = host.querySelector('.eslabs-gate-card');
  if (!card) return;
  card.classList.add('is-deny');
  var old = host.querySelector('.eslabs-gate-deny');
  if (old) old.remove();
  var deny = document.createElement('div');
  deny.className = 'eslabs-gate-deny';
  deny.setAttribute('role', 'alert');
  deny.innerHTML = '<p class="eslabs-gate-deny-title">Admin access required</p>'
    + '<p>You’re signed in as <strong>' + escapeHtml(user.email || user.displayName || 'this account') + '</strong>. '
    + 'This tool is only available to the Endurance Science Labs admin account.</p>'
    + '<div class="eslabs-gate-deny-actions"><button type="button" class="esl-btn esl-btn--outline esl-btn--sm" data-eslabs-signout>Switch account</button></div>';
  var insertAfter = card.querySelector('[data-eslabs-sub]') || card.querySelector('[data-eslabs-title]') || card.firstChild;
  insertAfter.parentNode.insertBefore(deny, insertAfter.nextSibling);
  deny.querySelector('[data-eslabs-signout]').addEventListener('click', function () { signOut(); });
}
function clearDeny(host) {
  var card = host.querySelector('.eslabs-gate-card');
  if (card) card.classList.remove('is-deny');
  var deny = host.querySelector('.eslabs-gate-deny');
  if (deny) deny.remove();
}

function friendlyAuthError(e) {
  if (!e) return 'Something went wrong. Please try again.';
  if (e.code === 'auth/popup-closed-by-user') return '';
  if (e.code === 'auth/popup-blocked') {
    return 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again, or use email instead.';
  }
  if (e.code === 'auth/email-already-in-use') return 'An account already exists with that email. Switch to Sign in.';
  if (e.code === 'auth/invalid-email') return 'That email address does not look valid.';
  if (e.code === 'auth/weak-password') return 'Password too weak. Use at least 6 characters.';
  if (e.code === 'auth/wrong-password'
      || e.code === 'auth/invalid-credential'
      || e.code === 'auth/invalid-login-credentials') {
    return 'Email or password is wrong. Try again or reset your password.';
  }
  if (e.code === 'auth/user-not-found') return 'No account with that email. Create one with the Create account tab.';
  if (e.code === 'auth/user-disabled') return 'This account has been disabled. Contact support.';
  if (e.code === 'auth/too-many-requests') return 'Too many attempts. Please wait a minute and try again.';
  if (e.code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  if (e.code === 'auth/web-storage-unsupported'
      || e.code === 'auth/operation-not-supported-in-this-environment'
      || /sessionStorage|initial state/i.test(e.message || '')) {
    return 'Google sign-in isn’t available in this browser (private mode or an in-app browser blocks it). Open this page in Safari or Chrome, or use email instead.';
  }
  return e.message || 'Sign-in failed. Please try again.';
}

// ── Toast, dialog, motion helpers (DESIGN-STANDARD §3.10, §3.11) ──
// esLabs.toast(msg, {err, action:{label, fn}, timeout}) → {dismiss}
//   One shared .esl-toast live region. Info toasts auto-hide (5 s); error
//   toasts stay until dismissed. A new toast replaces the old one. Sits
//   above the act-as banner via --esl-bottom-inset.
var toastHost = null;
var toastTimer = null;
var toastSeq = 0;
function toast(msg, opts) {
  opts = opts || {};
  if (!document.body || !msg) return { dismiss: function () {} };
  if (!toastHost || !document.body.contains(toastHost)) {
    toastHost = document.createElement('div');
    toastHost.className = 'esl-toast';
    document.body.appendChild(toastHost);
  }
  var my = ++toastSeq;
  clearTimeout(toastTimer);
  toastHost.innerHTML = '';
  toastHost.setAttribute('role', opts.err ? 'alert' : 'status');
  toastHost.setAttribute('aria-live', opts.err ? 'assertive' : 'polite');
  function dismiss() {
    if (my !== toastSeq || !toastHost) return;
    clearTimeout(toastTimer);
    toastHost.innerHTML = '';
  }
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  // Insert on the next frame so the live region exists before its content.
  raf(function () {
    if (my !== toastSeq) return;
    var box = document.createElement('div');
    box.className = 'esl-toast-box' + (opts.err ? ' err' : '');
    var span = document.createElement('span');
    span.textContent = msg;
    box.appendChild(span);
    if (opts.action && opts.action.label) {
      var act = document.createElement('button');
      act.type = 'button';
      act.textContent = opts.action.label;
      act.addEventListener('click', function () {
        dismiss();
        if (typeof opts.action.fn === 'function') {
          try { opts.action.fn(); } catch (e) { console.error(e); }
        }
      });
      box.appendChild(act);
    }
    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss message');
    x.textContent = '✕';
    x.addEventListener('click', dismiss);
    box.appendChild(x);
    toastHost.innerHTML = '';
    toastHost.appendChild(box);
    if (!opts.err) toastTimer = setTimeout(dismiss, opts.timeout || 5000);
  });
  return { dismiss: dismiss };
}

var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function focusables(root) {
  return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), isShown);
}
function trapTab(e, root) {
  var f = focusables(root);
  if (!f.length) return;
  var a = document.activeElement;
  if (e.shiftKey && (a === f[0] || !root.contains(a) || a === root)) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && (a === f[f.length - 1] || !root.contains(a))) { e.preventDefault(); f[0].focus(); }
}

// esLabs.openDialog(overlay, {trigger, initialFocus, dismissable=true, onClose}) → {close}
// esLabs.closeDialog(overlay)
//   Semantics + focus only. Showing/hiding the element stays the page's job
//   (coaching .open, esFormLab style.display, [hidden]); Escape calls
//   onClose() and the page hides its element (then calls close()).
var openDialogs = [];
function openDialog(overlay, opts) {
  opts = opts || {};
  overlay = resolveEl(overlay);
  if (!overlay) return { close: function () {} };
  closeDialog(overlay, true);
  var panel = overlay.querySelector('[role="dialog"]') || overlay.firstElementChild || overlay;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (!panel.getAttribute('aria-labelledby') && !panel.getAttribute('aria-label')) {
    var heads = panel.querySelectorAll('h1,h2,h3,.modal-title,.esl-modal-title');
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].id) { panel.setAttribute('aria-labelledby', heads[i].id); break; }
    }
  }
  var a = opts.trigger || document.activeElement;
  var rec = {
    overlay: overlay,
    panel: panel,
    trigger: (a && a !== document.body && !overlay.contains(a)) ? a : null,
    onKey: function (e) {
      if (e.key === 'Escape') {
        if (opts.dismissable === false) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof opts.onClose === 'function') {
          try { opts.onClose(); } catch (err) { console.error(err); }
        }
        closeDialog(overlay);
        return;
      }
      if (e.key === 'Tab') trapTab(e, panel);
    }
  };
  overlay.addEventListener('keydown', rec.onKey);
  openDialogs.push(rec);
  var target = resolveEl(opts.initialFocus) || focusables(panel)[0];
  if (!target) {
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    target = panel;
  }
  // The page may still be un-hiding the element; focus on the next frame too.
  try { target.focus(); } catch (e) {}
  setTimeout(function () {
    if (openDialogs.indexOf(rec) !== -1 && !panel.contains(document.activeElement)) {
      try { target.focus(); } catch (e) {}
    }
  }, 30);
  return { close: function () { closeDialog(overlay); } };
}
function closeDialog(overlay, silent) {
  overlay = resolveEl(overlay);
  for (var i = openDialogs.length - 1; i >= 0; i--) {
    var rec = openDialogs[i];
    if (rec.overlay !== overlay) continue;
    overlay.removeEventListener('keydown', rec.onKey);
    openDialogs.splice(i, 1);
    if (!silent && rec.trigger && document.body.contains(rec.trigger)) {
      try { rec.trigger.focus(); } catch (e) {}
    }
  }
}

function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

// ── Ownership (D7) ───────────────────────────────────────────────
// esLabs.owns(key) — does the REAL signed-in account already have this?
// Pages use it to show "Included in your plan" instead of Buy. Keys:
//   'esformlab'         esFormLab report access (pass, grant or Full Access)
//   'esformlab-pass'    a paid 90-day pass specifically
//   'coaching'          any active coaching subscription
//   'coaching-premium' / 'coaching-standard'
//   'coaching-grant'    features.coaching grant (no subscription)
//   'metlab'            esMetabolicLab upload access (any source)
//   'metlab-lifetime' / 'metlab-yearly'
//   'shockwave-member'  qualifies for the $50 Shockwave rate (active
//                       coaching subscription only; grants don't qualify)
function owns(key) {
  var p = passSnapshot();
  switch (key) {
    case 'esformlab': return !!p.unlocked;
    case 'esformlab-pass': return !!p.hasPaidPass;
    case 'coaching': return !!p.hasCoaching;
    case 'coaching-premium': return !!p.hasPremiumCoach;
    case 'coaching-standard': return !!p.hasStandardCoach;
    case 'coaching-grant': return !!p.coachingGranted;
    case 'metlab': return !!p.metlab.uploadAccess;
    case 'metlab-lifetime': return !!p.metlab.hasLifetime;
    case 'metlab-yearly': return !!p.metlab.yearlyActive;
    case 'shockwave-member': return !!p.hasCoaching;
    default: return false;
  }
}

// ── Theme API ────────────────────────────────────────────────────
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  var t = (theme === 'light') ? 'light' : 'dark';
  var root = document.documentElement;
  if (t === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  swapThemedLogos(t);
  themeListeners.forEach(function (cb) { try { cb(t); } catch (e) { console.error(e); } });
}

// The nav/footer/gate logos are white artwork built for the dark UI. On
// light, swap to the matching dark-ink variant ("_white_clean" -> "_clean").
// The original src is stashed so dark mode can restore it.
function swapThemedLogos(theme) {
  var imgs = document.querySelectorAll('img.nav-logo-img, img.footer-logo-img, img.eslabs-gate-logo');
  imgs.forEach(function (img) {
    if (theme === 'light') {
      var src = img.getAttribute('src') || '';
      var dark = src.replace('_white_clean', '_clean').replace('_white.', '.');
      if (dark !== src) {
        if (!img.getAttribute('data-logo-white')) img.setAttribute('data-logo-white', src);
        img.setAttribute('src', dark);
      }
    } else {
      var white = img.getAttribute('data-logo-white');
      if (white) { img.setAttribute('src', white); img.removeAttribute('data-logo-white'); }
    }
  });
}

// Set the theme and (when signed in) remember it on the user's profile so
// it follows them across devices. Pass {skipPersist:true} to apply without
// writing (used when syncing FROM the Firestore doc).
function setTheme(theme, opts) {
  opts = opts || {};
  var t = (theme === 'light') ? 'light' : 'dark';
  applyTheme(t);
  if (!opts.skipPersist && state.user) {
    db.collection('users').doc(state.user.uid).set({ theme: t }, { merge: true })
      .catch(function (e) { console.warn('theme save:', e.message); });
  }
}
function toggleTheme() { setTheme(currentTheme() === 'light' ? 'dark' : 'light'); }
function onThemeChange(cb) {
  themeListeners.push(cb);
  try { cb(currentTheme()); } catch (e) { console.error(e); }
  return function () {
    var i = themeListeners.indexOf(cb);
    if (i !== -1) themeListeners.splice(i, 1);
  };
}

// Swap any static logos (e.g. the index footer) once the DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { swapThemedLogos(currentTheme()); });
} else {
  swapThemedLogos(currentTheme());
}

// ── DOM helpers ──────────────────────────────────────────────────
function resolveEl(target) {
  if (!target) return null;
  if (typeof target === 'string') return document.querySelector(target);
  return target;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Public API ───────────────────────────────────────────────────
window.esLabs = {
  ADMIN_UID: ADMIN_UID,
  firebase: firebase,
  auth: auth,
  db: db,
  // Effective user: the act-as stand-in when a session is active, else
  // the real signed-in user. Pages key Firestore paths off this, so it
  // must match what onAuthChange listeners receive.
  get user() { return effectiveUser(); },
  get realUser() { return state.user; },
  // Based on the REAL account — stays true while acting, so admin-only
  // affordances (e.g. the metlab paywall bypass) keep working.
  isAdmin: function () { return !!(state.user && state.user.uid === ADMIN_UID); },
  signInGoogle: signInGoogle,
  googleOAuthAvailable: googleOAuthAvailable,
  signInEmail: signInEmail,
  createAccount: createAccount,
  sendPasswordReset: sendPasswordReset,
  signOut: signOut,
  onAuthChange: onAuthChange,
  onPassChange: onPassChange,
  startActAs: startActAs,
  stopActAs: stopActAs,
  getActAs: getActAs,
  isActingAs: function () { return !!getActAs(); },
  // false until Firebase has reported the persisted session (or none).
  get authResolved() { return state.authResolved; },
  whenAuthReady: whenAuthReady,
  getPassState: passSnapshot,
  owns: owns,
  // Act-as purchase guard: returns true when buying/billing may proceed;
  // otherwise shows the "Stop acting as …" toast and returns false.
  requireNotActing: requireNotActing,
  getTheme: currentTheme,
  setTheme: setTheme,
  toggleTheme: toggleTheme,
  onThemeChange: onThemeChange,
  mountNav: mountNav,
  refreshNav: refreshMountedNav,
  mountAuthGate: mountAuthGate,
  openSignIn: openSignIn,
  toast: toast,
  openDialog: openDialog,
  closeDialog: closeDialog,
  prefersReducedMotion: prefersReducedMotion,
  escapeHtml: escapeHtml,
  NAV_LINKS: NAV_LINKS.map(function (l) { return { key: l.key, label: l.label, href: l.href }; }),
  openCustomerPortal: openCustomerPortal,
  startPassCheckout: startPassCheckout,
  startMetlabCheckout: startMetlabCheckout,
  startShockwaveCheckout: startShockwaveCheckout,
  STRIPE_PASS_PRICE_ID: STRIPE_PASS_PRICE_ID,
  COACHING_PREMIUM_PRICE_ID: COACHING_PREMIUM_PRICE_ID,
  COACHING_PREMIUM_PRICE_IDS: COACHING_PREMIUM_PRICE_IDS,
  COACHING_STANDARD_PRICE_IDS: COACHING_STANDARD_PRICE_IDS,
  METLAB_LIFETIME_PRICE_ID: METLAB_LIFETIME_PRICE_ID,
  METLAB_YEARLY_PRICE_ID: METLAB_YEARLY_PRICE_ID,
  METLAB_SINGLE_PRICE_ID: METLAB_SINGLE_PRICE_ID,
  METLAB_INPERSON_PRICE_ID: METLAB_INPERSON_PRICE_ID,
  METLAB_SINGLE_WINDOW_SEC: METLAB_SINGLE_WINDOW_SEC,
  PASS_DURATION_SEC: PASS_DURATION_SEC
};

})();
