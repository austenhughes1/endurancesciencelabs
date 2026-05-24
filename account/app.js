// ════════════════════════════════════════════════════════════════
// /account/app.js
//
// User profile + features + billing page.
//
// Mirrors auth + paywall conventions from esformlab/auth-paywall.js
// so a user signed in here sees the same features they see in the
// esFormLab analyzer.
// ════════════════════════════════════════════════════════════════

(function () {
'use strict';

// Same project as esFormLab + reference-data, hardcoded in both.
var FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDh4LorLQx1DPovQIA4HM3127fAYpyuaY8',
  authDomain: 'es-form-labs.firebaseapp.com',
  projectId: 'es-form-labs',
  storageBucket: 'es-form-labs.firebasestorage.app',
  messagingSenderId: '215373817428',
  appId: '1:215373817428:web:9a80d81815f6843ce2afc1',
  measurementId: 'G-P2RRN15M8K'
};

// Mirror of the constants in esformlab/auth-paywall.js -- if these
// change there, change here too.
var STRIPE_PASS_PRICE_ID = 'price_1TVIadIFO8pppwnFTfqv3CCh';
var PASS_DURATION_SEC = 90 * 24 * 60 * 60;
var COACHING_PREMIUM_PRICE_ID = 'price_1TVJJuIFO8pppwnF5uECviT3';
var ADMIN_UID = '2z9Z3K5ZwShvadUuqZmwMv0s1Od2';

if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
var auth = firebase.auth();
var db = firebase.firestore();

var state = {
  user: null,
  userDoc: null,
  paidPassCreatedSec: null,   // timestamp of the most-recent succeeded pass payment, or null
  grantedPassUntilSec: null,  // user doc formAnalyzerPassUntil seconds, or Infinity for boolean grant
  hasGrantedPassFlag: false,  // users/{uid}.features.esFormLab === true (no expiry)
  hasPremiumCoach: false,
  premiumCoachCurrentPeriodEnd: null,
  shellRendered: false,       // whether profile card has been laid down (prevents clobbering edits on snapshot updates)
  unsub: { user: null, payments: null, subs: null },
  emailAuthMode: 'signin'
};

// ──────────────────────────────────────────────────────────────
//  Auth handlers (exposed via window for inline onclick)
// ──────────────────────────────────────────────────────────────
window.acctSignInGoogle = function () {
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function (e) {
    if (e && e.code === 'auth/popup-closed-by-user') return;
    showAuthError(friendlyAuthError(e));
  });
};

window.acctSignOut = function () {
  auth.signOut();
};

window.acctToggleEmailAuth = function () {
  var form = document.getElementById('sg-email-form');
  var btn = document.getElementById('sg-email-toggle-btn');
  var label = document.getElementById('sg-email-toggle-label');
  if (!form || !btn || !label) return;
  var open = form.style.display !== 'none';
  if (open) {
    form.style.display = 'none';
    btn.classList.remove('open');
    label.textContent = 'Or sign in with email instead';
  } else {
    form.style.display = 'block';
    btn.classList.add('open');
    label.textContent = 'Hide email form';
    setTimeout(function () {
      var e = document.getElementById('sg-email');
      if (e) e.focus();
    }, 60);
  }
};

window.acctSetEmailMode = function (mode) {
  state.emailAuthMode = (mode === 'signup') ? 'signup' : 'signin';
  var tabs = document.querySelectorAll('.sg-mode-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === state.emailAuthMode);
  }
  var submit = document.getElementById('sg-email-submit');
  if (submit) submit.textContent = (state.emailAuthMode === 'signup') ? 'Create account' : 'Sign in';
  var pw = document.getElementById('sg-password');
  if (pw) {
    pw.setAttribute('autocomplete', state.emailAuthMode === 'signup' ? 'new-password' : 'current-password');
    pw.placeholder = state.emailAuthMode === 'signup' ? 'Password (6+ characters)' : 'Password';
  }
  var forgot = document.getElementById('sg-forgot-btn');
  if (forgot) forgot.style.display = (state.emailAuthMode === 'signin') ? 'block' : 'none';
  clearAuthError();
};

window.acctSubmitEmail = function () {
  var emailEl = document.getElementById('sg-email');
  var pwEl = document.getElementById('sg-password');
  var submit = document.getElementById('sg-email-submit');
  if (!emailEl || !pwEl || !submit) return;
  var email = emailEl.value.trim();
  var pw = pwEl.value;
  if (!email || !pw) { showAuthError('Please enter both your email and a password.'); return; }
  if (state.emailAuthMode === 'signup' && pw.length < 6) {
    showAuthError('Password must be at least 6 characters.');
    return;
  }
  clearAuthError();
  submit.disabled = true;
  var origLabel = (state.emailAuthMode === 'signup') ? 'Create account' : 'Sign in';
  submit.textContent = (state.emailAuthMode === 'signup') ? 'Creating account…' : 'Signing in…';
  var p = (state.emailAuthMode === 'signup')
    ? auth.createUserWithEmailAndPassword(email, pw)
    : auth.signInWithEmailAndPassword(email, pw);
  p.then(function () { pwEl.value = ''; })
   .catch(function (e) {
     submit.disabled = false;
     submit.textContent = origLabel;
     showAuthError(friendlyAuthError(e));
   });
};

window.acctSendReset = function () {
  var emailEl = document.getElementById('sg-email');
  if (!emailEl) return;
  var email = emailEl.value.trim();
  if (!email) { showAuthError('Type your email in the field above first.'); return; }
  auth.sendPasswordResetEmail(email).then(function () {
    showAuthError('Password reset email sent. Check your inbox (and spam folder).', true);
  }).catch(function (e) { showAuthError(friendlyAuthError(e)); });
};

function clearAuthError() {
  var err = document.getElementById('sg-email-error');
  if (!err) return;
  err.style.display = 'none';
  err.classList.remove('success');
  err.textContent = '';
}
function showAuthError(msg, isSuccess) {
  var err = document.getElementById('sg-email-error');
  if (!err) return;
  err.textContent = msg;
  err.classList.toggle('success', !!isSuccess);
  err.style.display = 'block';
}
function friendlyAuthError(e) {
  if (!e) return 'Something went wrong. Please try again.';
  var c = e.code || '';
  if (c === 'auth/email-already-in-use') return 'An account already exists with that email. Switch to Sign in.';
  if (c === 'auth/invalid-email') return 'That email address does not look valid.';
  if (c === 'auth/weak-password') return 'Password too weak. Use at least 6 characters.';
  if (c === 'auth/wrong-password' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials')
    return 'Email or password is wrong. Try again or reset your password.';
  if (c === 'auth/user-not-found') return 'No account with that email. Create one with the Create account tab instead.';
  if (c === 'auth/too-many-requests') return 'Too many attempts. Please wait a minute and try again.';
  if (c === 'auth/popup-closed-by-user') return '';
  return e.message || 'Sign-in failed. Please try again.';
}

// ──────────────────────────────────────────────────────────────
//  Auth state -- routes the page between gate / app
// ──────────────────────────────────────────────────────────────
auth.onAuthStateChanged(function (user) {
  detachUserSubscriptions();
  state.user = user;
  if (!user) {
    document.getElementById('acct-signin-gate').classList.add('show');
    document.getElementById('acct-app').classList.remove('show');
    return;
  }
  document.getElementById('acct-signin-gate').classList.remove('show');
  document.getElementById('acct-app').classList.add('show');
  upgradeEsMetLabNav(user);
  renderNavUser(user);
  attachUserSubscriptions(user.uid);
});

function detachUserSubscriptions() {
  if (state.unsub.user) { state.unsub.user(); state.unsub.user = null; }
  if (state.unsub.payments) { state.unsub.payments(); state.unsub.payments = null; }
  if (state.unsub.subs) { state.unsub.subs(); state.unsub.subs = null; }
  state.userDoc = null;
  state.paidPassCreatedSec = null;
  state.grantedPassUntilSec = null;
  state.hasGrantedPassFlag = false;
  state.hasPremiumCoach = false;
  state.premiumCoachCurrentPeriodEnd = null;
  state.shellRendered = false;
  var root = document.getElementById('acct-content');
  if (root) root.innerHTML = '<div class="acct-loading">Loading your account&hellip;</div>';
}

function attachUserSubscriptions(uid) {
  // Initial render of skeleton -- becomes content as snapshots arrive.
  renderApp();

  state.unsub.user = db.collection('users').doc(uid).onSnapshot(function (snap) {
    state.userDoc = snap.exists ? snap.data() : {};
    var until = state.userDoc.formAnalyzerPassUntil;
    state.grantedPassUntilSec = toSeconds(until);
    state.hasGrantedPassFlag = !!(state.userDoc.features && state.userDoc.features.esFormLab === true);
    renderApp();
  }, function (err) {
    console.warn('user doc snapshot error:', err.message);
  });

  state.unsub.payments = db.collection('customers').doc(uid).collection('payments')
    .onSnapshot(function (snap) {
      var newest = null;
      snap.docs.forEach(function (d) {
        var p = d.data();
        if (p.status !== 'succeeded') return;
        var sec = toSeconds(p.created);
        if (sec === null) return;
        if (newest === null || sec > newest) newest = sec;
      });
      state.paidPassCreatedSec = newest;
      renderApp();
    }, function (err) { console.warn('payments snapshot error:', err.message); });

  state.unsub.subs = db.collection('customers').doc(uid).collection('subscriptions')
    .onSnapshot(function (snap) {
      var found = null;
      snap.docs.forEach(function (d) {
        var sub = d.data();
        if (sub.status !== 'active' && sub.status !== 'trialing') return;
        var ids = collectPriceIds(sub);
        if (ids.indexOf(COACHING_PREMIUM_PRICE_ID) === -1) return;
        found = sub;
      });
      state.hasPremiumCoach = !!found;
      state.premiumCoachCurrentPeriodEnd = found ? toSeconds(found.current_period_end) : null;
      renderApp();
    }, function (err) { console.warn('subscriptions snapshot error:', err.message); });
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

// ──────────────────────────────────────────────────────────────
//  Nav rendering
// ──────────────────────────────────────────────────────────────
function renderNavUser(user) {
  var ind = document.getElementById('auth-indicator');
  var avatar = document.getElementById('auth-avatar');
  var nameEl = document.getElementById('auth-name');
  if (!ind || !avatar || !nameEl) return;
  ind.style.display = 'inline-flex';
  var photo = user.photoURL || (user.providerData && user.providerData[0] ? user.providerData[0].photoURL : null);
  if (photo) { avatar.src = photo; avatar.style.display = 'block'; }
  else { avatar.style.display = 'none'; }
  var displayName = user.displayName
    || (user.providerData && user.providerData[0] ? user.providerData[0].displayName : null)
    || (user.email ? user.email.split('@')[0] : 'User');
  nameEl.textContent = displayName;
}

function upgradeEsMetLabNav(user) {
  var el = document.getElementById('nav-esmetlab');
  if (!el) return;
  if (user && user.uid === ADMIN_UID) {
    var a = document.createElement('a');
    a.href = '/esmetaboliclab/';
    a.className = 'nav-link';
    a.innerHTML = 'Metabolic Testing <span class="soon" style="background:rgba(139,124,248,.18);color:var(--purple)">Preview</span>';
    el.parentNode.replaceChild(a, el);
  }
}

// ──────────────────────────────────────────────────────────────
//  Main render
// ──────────────────────────────────────────────────────────────
function renderApp() {
  var root = document.getElementById('acct-content');
  if (!root) return;
  // Wait for the user doc snapshot before laying down the shell -- the
  // initial values depend on it.
  if (state.userDoc === null) return;

  if (!state.shellRendered) {
    var doc = state.userDoc || {};
    var displayName = doc.displayName || state.user.displayName || '';
    var email = state.user.email || '';
    var gender = (doc.gender === 'male' || doc.gender === 'female') ? doc.gender : '';
    var dob = doc.dob || '';

    root.innerHTML = ''
      + profileCardHtml(displayName, email, gender, dob)
      + '<div id="features-card-mount"></div>'
      + dangerZoneHtml();

    wireProfileCard();
    state.shellRendered = true;
  }

  // Re-render only the features section -- the profile form keeps any in-flight edits.
  var mount = document.getElementById('features-card-mount');
  if (mount) {
    mount.innerHTML = featuresCardHtml();
    wireFeaturesCard();
  }
}

function profileCardHtml(displayName, email, gender, dob) {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  return ''
    + '<section class="acct-card">'
    + '  <h2>Profile</h2>'
    + '  <p class="card-sub">Your name appears on saved sessions. Date of birth and gender personalize how reference ranges grade your gait analysis.</p>'
    + '  <div class="field-grid">'
    + '    <div class="field">'
    + '      <span class="field-label">Name</span>'
    + '      <input id="f-name" class="field-input" type="text" maxlength="80" value="' + esc(displayName) + '" placeholder="Your name">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Email</span>'
    + '      <div class="field-static">' + esc(email) + ' <span class="lock-pill">Read-only</span></div>'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Date of birth</span>'
    + '      <input id="f-dob" class="field-input" type="date" value="' + esc(dob) + '" max="' + todayIso() + '">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Gender</span>'
    + '      <div class="radio-row" id="f-gender">'
    + '        <label class="radio-pill' + (gender === 'male' ? ' checked' : '') + '" data-val="male"><input type="radio" name="acct-gender" value="male"' + (gender === 'male' ? ' checked' : '') + '><span>&#9794; Male</span></label>'
    + '        <label class="radio-pill' + (gender === 'female' ? ' checked' : '') + '" data-val="female"><input type="radio" name="acct-gender" value="female"' + (gender === 'female' ? ' checked' : '') + '><span>&#9792; Female</span></label>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '  <div class="save-row">'
    + '    <span class="save-status" id="save-status"></span>'
    + '    <button class="btn-primary" id="btn-save-profile">Save changes</button>'
    + '  </div>'
    + '</section>';
}

function todayIso() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function wireProfileCard() {
  var radios = document.querySelectorAll('#f-gender .radio-pill');
  for (var i = 0; i < radios.length; i++) {
    radios[i].addEventListener('click', function () {
      var val = this.getAttribute('data-val');
      for (var j = 0; j < radios.length; j++) {
        radios[j].classList.toggle('checked', radios[j].getAttribute('data-val') === val);
        var inp = radios[j].querySelector('input');
        if (inp) inp.checked = (radios[j].getAttribute('data-val') === val);
      }
    });
  }
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
}

function saveProfile() {
  var btn = document.getElementById('btn-save-profile');
  var statusEl = document.getElementById('save-status');
  var name = (document.getElementById('f-name').value || '').trim();
  var dob = (document.getElementById('f-dob').value || '').trim();
  var genderInput = document.querySelector('#f-gender input[name="acct-gender"]:checked');
  var gender = genderInput ? genderInput.value : '';

  if (dob) {
    // HTML date input gives us YYYY-MM-DD. Sanity-check it's a real date in the past.
    var parts = dob.split('-');
    if (parts.length !== 3 || isNaN(Date.parse(dob))) {
      setStatus('That date of birth does not look valid.', 'error');
      return;
    }
    var dobDate = new Date(dob + 'T00:00:00');
    if (dobDate.getTime() > Date.now()) {
      setStatus('Date of birth cannot be in the future.', 'error');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  setStatus('');

  var payload = {
    displayName: name || firebase.firestore.FieldValue.delete(),
    gender: gender || firebase.firestore.FieldValue.delete(),
    dob: dob || firebase.firestore.FieldValue.delete(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  db.collection('users').doc(state.user.uid).set(payload, { merge: true })
    .then(function () {
      // Keep Firebase Auth displayName in sync so navs everywhere update.
      if (name && state.user.displayName !== name) {
        return state.user.updateProfile({ displayName: name });
      }
    })
    .then(function () {
      setStatus('Saved.', 'success');
      // Update nav avatar/name immediately.
      var nameEl = document.getElementById('auth-name');
      if (nameEl && name) nameEl.textContent = name;
    })
    .catch(function (e) {
      console.error('saveProfile error:', e);
      setStatus('Could not save: ' + (e.message || e), 'error');
    })
    .then(function () {
      btn.disabled = false;
      btn.textContent = 'Save changes';
    });
}

function setStatus(msg, kind) {
  var el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('success', kind === 'success');
  el.classList.toggle('error', kind === 'error');
}

// ──────────────────────────────────────────────────────────────
//  Features + billing card
// ──────────────────────────────────────────────────────────────
function effectiveEsFormLabAccess() {
  // Returns { unlocked, source, until }. source: 'paid' | 'granted-flag' | 'granted-until' | 'coaching-bundle' | null
  var now = Math.floor(Date.now() / 1000);
  if (state.hasPremiumCoach) {
    return { unlocked: true, source: 'coaching-bundle', until: state.premiumCoachCurrentPeriodEnd || null };
  }
  if (state.hasGrantedPassFlag) {
    return { unlocked: true, source: 'granted-flag', until: null };
  }
  if (state.grantedPassUntilSec && state.grantedPassUntilSec > now) {
    return { unlocked: true, source: 'granted-until', until: state.grantedPassUntilSec };
  }
  if (state.paidPassCreatedSec && (now - state.paidPassCreatedSec) < PASS_DURATION_SEC) {
    return { unlocked: true, source: 'paid', until: state.paidPassCreatedSec + PASS_DURATION_SEC };
  }
  return { unlocked: false, source: null, until: null };
}

function featuresCardHtml() {
  var form = effectiveEsFormLabAccess();
  var coach = state.hasPremiumCoach;

  return ''
    + '<section class="acct-card">'
    + '  <h2>Features &amp; billing</h2>'
    + '  <p class="card-sub">What you have access to today, and how it was unlocked.</p>'
    + '  ' + esFormLabRow(form)
    + '  ' + coachingRow(coach)
    + '  <div class="billing-foot">'
    + '    <div class="billing-foot-text">'
    + '      Payments are processed by Stripe. Manage your subscription, payment methods, and invoices through the secure customer portal. '
    + '      <strong>One-time esFormLab passes</strong> aren&rsquo;t subscriptions &mdash; nothing recurring to cancel.'
    + '    </div>'
    + '    <button class="btn-link cyan" id="btn-portal">Manage billing in Stripe &rarr;</button>'
    + '  </div>'
    + '</section>';
}

function esFormLabRow(form) {
  var statusBadge, statusLine, ctaHtml;

  if (form.unlocked) {
    statusBadge = '<span class="badge unlocked">Unlocked</span>';
    if (form.source === 'paid') {
      statusLine = '90-day pass active &middot; expires ' + formatDate(form.until);
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>'
              + '<button class="btn-link" id="btn-portal-feat-form">Manage billing</button>';
    } else if (form.source === 'coaching-bundle') {
      statusBadge += ' <span class="badge source">Bundled with Premium coaching</span>';
      statusLine = form.until
        ? 'Included with your active coaching subscription &middot; renews ' + formatDate(form.until)
        : 'Included with your active coaching subscription';
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>';
    } else if (form.source === 'granted-until') {
      statusBadge += ' <span class="badge source">Granted by ESLabs</span>';
      statusLine = 'Comped access &middot; expires ' + formatDate(form.until);
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>';
    } else { // granted-flag
      statusBadge += ' <span class="badge source">Granted by ESLabs</span>';
      statusLine = 'Comped access &middot; no expiration';
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>';
    }
  } else {
    statusBadge = '<span class="badge locked">Locked</span>';
    statusLine = 'Sign in lets you upload &amp; scan videos for free. The full report (issues, coaching cues, bell-curve placement, downloadable PDF) unlocks with a one-time 90-day pass.';
    ctaHtml = '<a class="btn-link cyan" href="/esformlab/">Get a pass &rarr;</a>';
  }

  return ''
    + '<div class="feature-row">'
    + '  <div class="feature-icon">&#9673;</div>'
    + '  <div class="feature-body">'
    + '    <div class="feature-name">esFormLab &mdash; full report ' + statusBadge + '</div>'
    + '    <div class="feature-desc">' + statusLine + '</div>'
    + '    <div class="feature-actions">' + ctaHtml + '</div>'
    + '  </div>'
    + '</div>';
}

function coachingRow(active) {
  var badge, line, cta;
  if (active) {
    badge = '<span class="badge unlocked">Active</span>';
    line = state.premiumCoachCurrentPeriodEnd
      ? 'Premium coaching subscription &middot; renews ' + formatDate(state.premiumCoachCurrentPeriodEnd)
      : 'Premium coaching subscription active.';
    cta = '<a class="btn-link" href="/coaching/">Coaching dashboard &rarr;</a>'
        + '<button class="btn-link" id="btn-portal-feat-coach">Manage subscription</button>';
  } else {
    badge = '<span class="badge locked">Not subscribed</span>';
    line = 'Premium coaching is a monthly subscription that bundles esFormLab access at no extra cost.';
    cta = '<a class="btn-link" href="/coaching/">Learn more &rarr;</a>';
  }
  return ''
    + '<div class="feature-row">'
    + '  <div class="feature-icon">&#9788;</div>'
    + '  <div class="feature-body">'
    + '    <div class="feature-name">Premium coaching ' + badge + '</div>'
    + '    <div class="feature-desc">' + line + '</div>'
    + '    <div class="feature-actions">' + cta + '</div>'
    + '  </div>'
    + '</div>';
}

function wireFeaturesCard() {
  var btn = document.getElementById('btn-portal');
  if (btn) btn.addEventListener('click', openCustomerPortal);
  var bf = document.getElementById('btn-portal-feat-form');
  if (bf) bf.addEventListener('click', openCustomerPortal);
  var bc = document.getElementById('btn-portal-feat-coach');
  if (bc) bc.addEventListener('click', openCustomerPortal);
}

function openCustomerPortal() {
  var buttons = document.querySelectorAll('#btn-portal, #btn-portal-feat-form, #btn-portal-feat-coach');
  buttons.forEach(function (b) { b.disabled = true; });
  var origText = document.getElementById('btn-portal') ? document.getElementById('btn-portal').textContent : '';
  if (document.getElementById('btn-portal')) document.getElementById('btn-portal').textContent = 'Opening Stripe…';

  try {
    var fns = firebase.app().functions('us-central1');
    var createPortalLink = fns.httpsCallable('ext-firestore-stripe-payments-createPortalLink');
    createPortalLink({ returnUrl: window.location.href }).then(function (result) {
      var url = result && result.data && result.data.url;
      if (url) window.location.assign(url);
      else {
        alert('Could not open the subscription portal. Please try again.');
        buttons.forEach(function (b) { b.disabled = false; });
        if (document.getElementById('btn-portal')) document.getElementById('btn-portal').textContent = origText || 'Manage billing in Stripe →';
      }
    }).catch(function (e) {
      console.error('Customer portal error:', e);
      alert('Could not open the subscription portal: ' + (e.message || e));
      buttons.forEach(function (b) { b.disabled = false; });
      if (document.getElementById('btn-portal')) document.getElementById('btn-portal').textContent = origText || 'Manage billing in Stripe →';
    });
  } catch (e) {
    console.error('Customer portal error:', e);
    alert('Could not open the subscription portal: ' + (e.message || e));
    buttons.forEach(function (b) { b.disabled = false; });
  }
}

// ──────────────────────────────────────────────────────────────
//  Sign-out / danger zone
// ──────────────────────────────────────────────────────────────
function dangerZoneHtml() {
  return ''
    + '<div class="danger-zone">'
    + '  <span class="danger-zone-text">Signed in as <strong>' + escapeHtml(state.user.email || state.user.uid) + '</strong></span>'
    + '  <button class="btn-signout" onclick="window.acctSignOut()">Sign out</button>'
    + '</div>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(sec) {
  if (!sec) return '';
  var d = new Date(sec * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

})();
