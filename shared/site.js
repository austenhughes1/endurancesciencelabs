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
// ════════════════════════════════════════════════════════════════

(function () {
'use strict';

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
var STRIPE_PASS_PRICE_ID = 'price_1TVIadIFO8pppwnFTfqv3CCh';
var COACHING_PREMIUM_PRICE_ID = 'price_1TVJJuIFO8pppwnF5uECviT3';
var PASS_DURATION_SEC = 90 * 24 * 60 * 60;

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
  premiumCoachPeriodEnd: null,
  emailAuthMode: 'signup'
};
var authListeners = [];
var passListeners = [];
var passWatchers = { user: null, payments: null, subs: null };

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
function signOut() { return auth.signOut(); }

function onAuthChange(cb) {
  authListeners.push(cb);
  // Fire immediately with the latest known state so callers don't race.
  try { cb(state.user); } catch (e) { console.error(e); }
  return function () {
    var i = authListeners.indexOf(cb);
    if (i !== -1) authListeners.splice(i, 1);
  };
}

auth.onAuthStateChanged(function (user) {
  state.user = user;
  detachPassWatchers();
  state.userDoc = null;
  state.hasPaidPass = false;
  state.paidPassUntil = null;
  state.hasGrantedFlag = false;
  state.grantedUntilSec = null;
  state.hasPremiumCoach = false;
  state.premiumCoachPeriodEnd = null;
  if (user) attachPassWatchers(user.uid);
  notifyAuthListeners();
  refreshMountedNav();
});

function notifyAuthListeners() {
  authListeners.forEach(function (cb) {
    try { cb(state.user); } catch (e) { console.error(e); }
  });
}
function notifyPassListeners() {
  var snap = passSnapshot();
  passListeners.forEach(function (cb) {
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
  return {
    unlocked: unlocked,
    source: source,
    until: until,
    hasPaidPass: state.hasPaidPass,
    paidPassUntil: state.paidPassUntil,
    hasGrantedFlag: state.hasGrantedFlag,
    grantedUntilSec: state.grantedUntilSec,
    hasPremiumCoach: state.hasPremiumCoach,
    premiumCoachPeriodEnd: state.premiumCoachPeriodEnd
  };
}

function attachPassWatchers(uid) {
  passWatchers.user = db.collection('users').doc(uid).onSnapshot(function (snap) {
    state.userDoc = snap.exists ? snap.data() : {};
    state.hasGrantedFlag = !!(state.userDoc.features && state.userDoc.features.esFormLab === true);
    state.grantedUntilSec = toSeconds(state.userDoc.formAnalyzerPassUntil);
    notifyPassListeners();
  }, function (err) { console.warn('users doc snapshot:', err.message); });

  passWatchers.payments = db.collection('customers').doc(uid).collection('payments')
    .onSnapshot(function (snap) {
      var now = Math.floor(Date.now() / 1000);
      var active = false; var until = null;
      snap.docs.forEach(function (d) {
        var p = d.data();
        if (p.status !== 'succeeded') return;
        var sec = toSeconds(p.created);
        if (sec === null) return;
        if (now - sec < PASS_DURATION_SEC) {
          active = true;
          var u = sec + PASS_DURATION_SEC;
          if (until === null || u > until) until = u;
        }
      });
      state.hasPaidPass = active;
      state.paidPassUntil = until;
      notifyPassListeners();
    }, function (err) { console.warn('payments snapshot:', err.message); });

  passWatchers.subs = db.collection('customers').doc(uid).collection('subscriptions')
    .onSnapshot(function (snap) {
      var found = null;
      snap.docs.forEach(function (d) {
        var sub = d.data();
        if (sub.status !== 'active' && sub.status !== 'trialing') return;
        if (collectPriceIds(sub).indexOf(COACHING_PREMIUM_PRICE_ID) === -1) return;
        found = sub;
      });
      state.hasPremiumCoach = !!found;
      state.premiumCoachPeriodEnd = found ? toSeconds(found.current_period_end) : null;
      notifyPassListeners();
    }, function (err) { console.warn('subs snapshot:', err.message); });
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
function openCustomerPortal() {
  if (!state.user) return signInGoogle();
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

function startPassCheckout(opts) {
  opts = opts || {};
  if (!state.user) return signInGoogle();
  return db.collection('customers').doc(state.user.uid)
    .collection('checkout_sessions').add({
      mode: 'payment',
      price: STRIPE_PASS_PRICE_ID,
      success_url: opts.successUrl || (window.location.origin + '/esformlab/?paid=1'),
      cancel_url: opts.cancelUrl || window.location.href,
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

// ── Nav mounting ─────────────────────────────────────────────────
// The nav links live in the shared module. Pages pass `active` to
// highlight one. The Metabolic Testing entry is non-clickable
// "Coming soon" for the public; admin sees a clickable "Preview" link.
var NAV_LINKS = [
  { key: 'home',        label: 'Home',           href: '/' },
  { key: 'esformlab',   label: 'Form analysis',  href: '/esformlab/' },
  { key: 'coaching',    label: 'Coaching',       href: '/coaching/', pill: { text: 'Live', kind: 'live' } },
  { key: 'esmetlab',    label: 'Metabolic Testing', href: '/esmetaboliclab/', adminOnly: true, publicPill: { text: 'Soon', kind: '' }, adminPill: { text: 'Preview', kind: 'preview' } }
];

var mountedNavs = [];   // [{ el, opts }]

function mountNav(selectorOrEl, opts) {
  opts = opts || {};
  var host = resolveEl(selectorOrEl);
  if (!host) return null;
  host.innerHTML = renderNavHtml(opts);
  wireNav(host, opts);
  mountedNavs.push({ el: host, opts: opts });
  return host;
}

function refreshMountedNav() {
  mountedNavs.forEach(function (m) {
    if (!document.body.contains(m.el)) return;
    m.el.innerHTML = renderNavHtml(m.opts);
    wireNav(m.el, m.opts);
  });
}

function renderNavHtml(opts) {
  var active = opts.active || '';
  var user = state.user;
  var isAdmin = !!(user && user.uid === ADMIN_UID);

  var linksHtml = NAV_LINKS.map(function (link) {
    var classes = 'nav-link' + (link.key === active ? ' active' : '');
    var pillHtml = '';
    if (link.adminOnly) {
      // Admin-only links: render as clickable preview pill for admin, non-clickable Soon for everyone else.
      if (isAdmin) {
        pillHtml = link.adminPill ? ' <span class="pill ' + (link.adminPill.kind || '') + '">' + escapeHtml(link.adminPill.text) + '</span>' : '';
        return '<a class="' + classes + '" href="' + link.href + '">' + escapeHtml(link.label) + pillHtml + '</a>';
      } else {
        pillHtml = link.publicPill ? ' <span class="pill ' + (link.publicPill.kind || '') + '">' + escapeHtml(link.publicPill.text) + '</span>' : '';
        return '<span class="' + classes + '" style="cursor:default">' + escapeHtml(link.label) + pillHtml + '</span>';
      }
    }
    if (link.pill) pillHtml = ' <span class="pill ' + (link.pill.kind || '') + '">' + escapeHtml(link.pill.text) + '</span>';
    return '<a class="' + classes + '" href="' + link.href + '">' + escapeHtml(link.label) + pillHtml + '</a>';
  }).join('');

  var rightHtml, mobileAuthHtml;
  if (user) {
    var name = user.displayName
      || (user.providerData && user.providerData[0] ? user.providerData[0].displayName : null)
      || (user.email ? user.email.split('@')[0] : 'User');
    var photo = user.photoURL
      || (user.providerData && user.providerData[0] ? user.providerData[0].photoURL : null)
      || '';
    rightHtml = ''
      + '<a class="nav-auth-pill" href="/account/" title="My account">'
      + (photo ? '<img class="nav-auth-avatar" src="' + escapeAttr(photo) + '" alt="">' : '<span class="nav-auth-avatar" aria-hidden="true"></span>')
      + '<span class="nav-auth-name">' + escapeHtml(name) + '</span>'
      + '</a>';
    mobileAuthHtml = ''
      + '<a class="nav-mobile-row" href="/account/">'
      + (photo ? '<img src="' + escapeAttr(photo) + '" alt="">' : '<img alt="">')
      + '<span class="nav-mobile-name">' + escapeHtml(name) + '</span>'
      + '</a>'
      + '<a class="nav-mobile-action" href="/account/">My account</a>'
      + '<button class="nav-mobile-action signout" data-eslabs-signout>Sign out</button>';
  } else {
    rightHtml = '<button class="nav-signin-btn" data-eslabs-signin>Sign in</button>';
    mobileAuthHtml = '<button class="nav-mobile-action primary" data-eslabs-signin>Sign in</button>';
  }

  return ''
    + '<a href="/" class="nav-logo" aria-label="Endurance Science Labs home">'
    + '  <img src="/images/generic_logo_white_clean.png" alt="Endurance Science Labs" class="nav-logo-img">'
    + '</a>'
    + '<div class="nav-links">' + linksHtml
    + '  <div class="nav-mobile-section">' + mobileAuthHtml + '</div>'
    + '</div>'
    + '<div class="nav-right">' + rightHtml + '</div>'
    + '<button class="nav-toggle" aria-label="Toggle menu" aria-expanded="false" data-eslabs-nav-toggle>'
    + '  <span></span><span></span><span></span>'
    + '</button>';
}

function wireNav(host, opts) {
  // Hamburger toggle
  var toggle = host.querySelector('[data-eslabs-nav-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = host.classList.toggle('menu-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  // Sign in -- opens a gate if one is mounted, otherwise just calls Google directly.
  host.querySelectorAll('[data-eslabs-signin]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (state.gateMounted && !state.user) {
        state.gateMounted.show();
      } else {
        signInGoogle();
      }
    });
  });
  // Sign out
  host.querySelectorAll('[data-eslabs-signout]').forEach(function (btn) {
    btn.addEventListener('click', function () { signOut(); });
  });
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
//   - foot: footer text (HTML allowed)
//   - requireAdmin: if true, after sign-in the gate stays up and shows a
//     'not admin' message unless the user.uid === ADMIN_UID
//   - emailDefault: 'signup' (default) or 'signin'
function mountAuthGate(selectorOrEl, opts) {
  opts = opts || {};
  var host = resolveEl(selectorOrEl);
  if (!host) return null;
  host.classList.add('eslabs-gate');
  host.innerHTML = gateInnerHtml(opts);
  wireGate(host, opts);

  var instance = {
    host: host,
    show: function () { host.classList.remove('hidden'); },
    hide: function () { host.classList.add('hidden'); },
    update: function () {
      var cardBody = host.querySelector('.eslabs-gate-body');
      if (cardBody) cardBody.innerHTML = gateBodyHtml(opts);
      wireGate(host, opts);
    }
  };

  // Drive show/hide off auth state.
  var unsub = onAuthChange(function (user) {
    if (!user) {
      instance.show();
    } else if (opts.requireAdmin && user.uid !== ADMIN_UID) {
      instance.show();
      var card = host.querySelector('.eslabs-gate-card');
      if (card) {
        var denyExisting = host.querySelector('.eslabs-gate-deny');
        if (denyExisting) denyExisting.remove();
        var deny = document.createElement('div');
        deny.className = 'eslabs-gate-deny';
        deny.innerHTML = '<strong>Admin access required.</strong> You are signed in, but your account does not have admin access for this tool. <button class="eslabs-gate-forgot" data-eslabs-signout style="margin-top:8px">Sign out</button>';
        // Insert after the title block, before the buttons.
        var insertAfter = card.querySelector('.eslabs-gate-sub') || card.querySelector('.eslabs-gate-title') || card.firstChild;
        insertAfter.parentNode.insertBefore(deny, insertAfter.nextSibling);
        deny.querySelectorAll('[data-eslabs-signout]').forEach(function (b) {
          b.addEventListener('click', function () { signOut(); });
        });
      }
    } else {
      instance.hide();
      // Clean up any stale admin-deny banner from a previous wrong account.
      var deny = host.querySelector('.eslabs-gate-deny');
      if (deny) deny.remove();
    }
  });
  instance.destroy = function () { unsub(); host.innerHTML = ''; };
  state.gateMounted = instance;
  return instance;
}

function gateInnerHtml(opts) {
  return '<div class="eslabs-gate-card"><div class="eslabs-gate-body">' + gateBodyHtml(opts) + '</div></div>';
}

function gateBodyHtml(opts) {
  var logo = opts.logo || '/images/generic_logo_white_clean.png';
  var eyebrow = opts.eyebrow || '◉ Sign in';
  var headline = opts.headline || 'Sign in to Endurance Science Labs';
  var sub = opts.sub || '';
  var microcopy = opts.microcopy || '<strong>Free account</strong> · 1-tap signup';
  var foot = opts.foot || '';
  var bullets = Array.isArray(opts.bullets) ? opts.bullets : [];
  var emailDefault = (opts.emailDefault === 'signin') ? 'signin' : 'signup';
  state.emailAuthMode = emailDefault;

  var bulletsHtml = bullets.map(function (b) {
    var strong = '', span = '';
    if (typeof b === 'string') { strong = b; }
    else { strong = b.strong || ''; span = b.span || ''; }
    return '<div class="eslabs-gate-bullet"><span class="eslabs-gate-bullet-check">✓</span><div>'
      + (strong ? '<strong>' + escapeHtml(strong) + '</strong> ' : '')
      + (span ? '<span>' + escapeHtml(span) + '</span>' : '')
      + '</div></div>';
  }).join('');

  return ''
    + '<img src="' + escapeAttr(logo) + '" alt="" class="eslabs-gate-logo">'
    + (eyebrow ? '<div class="eslabs-gate-eyebrow">' + escapeHtml(eyebrow) + '</div>' : '')
    + '<div class="eslabs-gate-title">' + escapeHtml(headline) + '</div>'
    + (sub ? '<div class="eslabs-gate-sub">' + escapeHtml(sub) + '</div>' : '')
    + (bulletsHtml ? '<div class="eslabs-gate-bullets">' + bulletsHtml + '</div>' : '')
    + '<button class="eslabs-gate-google-btn" data-eslabs-google aria-label="Continue with Google">'
    + '  <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>'
    + '  Continue with Google'
    + '</button>'
    + '<div class="eslabs-gate-microcopy">' + microcopy + '</div>'
    + '<div class="eslabs-gate-email-toggle">'
    + '  <button class="eslabs-gate-email-toggle-btn" data-eslabs-email-toggle type="button">'
    + '    <span data-eslabs-email-toggle-label>' + (emailDefault === 'signin' ? 'Or sign in with email instead' : 'Or sign up with email instead') + '</span>'
    + '    <span class="caret">▼</span>'
    + '  </button>'
    + '</div>'
    + '<div class="eslabs-gate-email-form" data-eslabs-email-form>'
    + '  <div class="eslabs-gate-mode" role="tablist">'
    + '    <button class="eslabs-gate-mode-tab' + (emailDefault === 'signup' ? ' active' : '') + '" data-eslabs-mode="signup" type="button">Create account</button>'
    + '    <button class="eslabs-gate-mode-tab' + (emailDefault === 'signin' ? ' active' : '') + '" data-eslabs-mode="signin" type="button">Sign in</button>'
    + '  </div>'
    + '  <input type="email" class="eslabs-gate-email-input" data-eslabs-email placeholder="you@example.com" autocomplete="email">'
    + '  <input type="password" class="eslabs-gate-email-input" data-eslabs-password placeholder="' + (emailDefault === 'signup' ? 'Password (6+ characters)' : 'Password') + '" autocomplete="' + (emailDefault === 'signup' ? 'new-password' : 'current-password') + '">'
    + '  <button class="eslabs-gate-email-submit" data-eslabs-email-submit type="button">' + (emailDefault === 'signup' ? 'Create account' : 'Sign in') + '</button>'
    + '  <button class="eslabs-gate-forgot" data-eslabs-forgot type="button" style="' + (emailDefault === 'signin' ? '' : 'display:none') + '">Forgot your password?</button>'
    + '  <div class="eslabs-gate-error" data-eslabs-error></div>'
    + '</div>'
    + (foot ? '<div class="eslabs-gate-foot">' + foot + '</div>' : '');
}

function wireGate(host, opts) {
  var googleBtn = host.querySelector('[data-eslabs-google]');
  if (googleBtn) googleBtn.addEventListener('click', function () {
    googleBtn.disabled = true;
    signInGoogle().catch(function (e) {
      showGateError(host, friendlyAuthError(e));
    }).then(function () { googleBtn.disabled = false; });
  });

  var toggle = host.querySelector('[data-eslabs-email-toggle]');
  var form = host.querySelector('[data-eslabs-email-form]');
  var toggleLabel = host.querySelector('[data-eslabs-email-toggle-label]');
  if (toggle && form) {
    toggle.addEventListener('click', function () {
      var open = form.classList.toggle('open');
      toggle.classList.toggle('open', open);
      if (toggleLabel) {
        toggleLabel.textContent = open
          ? 'Hide email form'
          : (state.emailAuthMode === 'signin' ? 'Or sign in with email instead' : 'Or sign up with email instead');
      }
      if (open) {
        setTimeout(function () {
          var e = host.querySelector('[data-eslabs-email]');
          if (e) e.focus();
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
  });

  var forgot = host.querySelector('[data-eslabs-forgot]');
  if (forgot) forgot.addEventListener('click', function () { doPasswordReset(host); });
}

function setEmailMode(host, mode) {
  state.emailAuthMode = (mode === 'signin') ? 'signin' : 'signup';
  host.querySelectorAll('[data-eslabs-mode]').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-eslabs-mode') === state.emailAuthMode);
  });
  var submit = host.querySelector('[data-eslabs-email-submit]');
  if (submit) submit.textContent = state.emailAuthMode === 'signup' ? 'Create account' : 'Sign in';
  var pw = host.querySelector('[data-eslabs-password]');
  if (pw) {
    pw.setAttribute('autocomplete', state.emailAuthMode === 'signup' ? 'new-password' : 'current-password');
    pw.placeholder = state.emailAuthMode === 'signup' ? 'Password (6+ characters)' : 'Password';
  }
  var forgot = host.querySelector('[data-eslabs-forgot]');
  if (forgot) forgot.style.display = state.emailAuthMode === 'signin' ? 'block' : 'none';
  clearGateError(host);
}

function submitEmailAuth(host) {
  var emailEl = host.querySelector('[data-eslabs-email]');
  var pwEl = host.querySelector('[data-eslabs-password]');
  var submit = host.querySelector('[data-eslabs-email-submit]');
  if (!emailEl || !pwEl || !submit) return;
  var email = emailEl.value.trim();
  var pw = pwEl.value;
  if (!email || !pw) {
    showGateError(host, 'Please enter both your email and a password.');
    return;
  }
  if (state.emailAuthMode === 'signup' && pw.length < 6) {
    showGateError(host, 'Password must be at least 6 characters.');
    return;
  }
  clearGateError(host);
  submit.disabled = true;
  var origLabel = state.emailAuthMode === 'signup' ? 'Create account' : 'Sign in';
  submit.textContent = state.emailAuthMode === 'signup' ? 'Creating account…' : 'Signing in…';
  var p = state.emailAuthMode === 'signup'
    ? createAccount(email, pw)
    : signInEmail(email, pw);
  p.then(function () { pwEl.value = ''; })
   .catch(function (e) {
     submit.disabled = false;
     submit.textContent = origLabel;
     showGateError(host, friendlyAuthError(e));
   });
}

function doPasswordReset(host) {
  var emailEl = host.querySelector('[data-eslabs-email]');
  if (!emailEl) return;
  var email = emailEl.value.trim();
  if (!email) {
    showGateError(host, 'Type your email in the field above first, then click Forgot password.');
    return;
  }
  sendPasswordReset(email).then(function () {
    showGateError(host, 'Password reset email sent. Check your inbox (and spam folder).', true);
  }).catch(function (e) { showGateError(host, friendlyAuthError(e)); });
}

function showGateError(host, msg, isSuccess) {
  var err = host.querySelector('[data-eslabs-error]');
  if (!err) return;
  if (!msg) { err.classList.remove('show'); err.textContent = ''; return; }
  err.textContent = msg;
  err.classList.toggle('success', !!isSuccess);
  err.classList.add('show');
}
function clearGateError(host) { showGateError(host, ''); }

function friendlyAuthError(e) {
  if (!e) return 'Something went wrong. Please try again.';
  if (e.code === 'auth/popup-closed-by-user') return '';
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
  return e.message || 'Sign-in failed. Please try again.';
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
  get user() { return state.user; },
  isAdmin: function () { return !!(state.user && state.user.uid === ADMIN_UID); },
  signInGoogle: signInGoogle,
  signInEmail: signInEmail,
  createAccount: createAccount,
  sendPasswordReset: sendPasswordReset,
  signOut: signOut,
  onAuthChange: onAuthChange,
  onPassChange: onPassChange,
  getPassState: passSnapshot,
  mountNav: mountNav,
  mountAuthGate: mountAuthGate,
  openCustomerPortal: openCustomerPortal,
  startPassCheckout: startPassCheckout,
  STRIPE_PASS_PRICE_ID: STRIPE_PASS_PRICE_ID,
  COACHING_PREMIUM_PRICE_ID: COACHING_PREMIUM_PRICE_ID,
  PASS_DURATION_SEC: PASS_DURATION_SEC
};

})();
