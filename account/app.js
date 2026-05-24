// ════════════════════════════════════════════════════════════════
// /account/app.js
//
// User profile + features + billing page. Uses the shared site.js
// for auth, nav, and effective-pass state -- this file only handles
// account-page-specific UI.
// ════════════════════════════════════════════════════════════════

(function () {
'use strict';

if (!window.esLabs) {
  console.error('account/app.js: esLabs must be loaded first');
  return;
}

esLabs.mountNav('#acct-nav', { active: 'home' });

esLabs.mountAuthGate('#acct-gate', {
  eyebrow: '◉ My account',
  headline: 'Sign in to manage your account',
  sub: 'Update your profile, see which features you have access to, and manage billing.',
  microcopy: '<strong>Free account</strong> · 1-tap signup',
  emailDefault: 'signin',
  foot: '<a href="/" style="color:var(--cyan);text-decoration:none">&larr; Back to home</a>'
});

var pageState = {
  userDoc: null,        // null until the first user-doc-derived snapshot arrives
  shellRendered: false
};

esLabs.onAuthChange(function (user) {
  var app = document.getElementById('acct-app');
  if (!app) return;
  if (user) {
    app.classList.add('show');
  } else {
    app.classList.remove('show');
    pageState.shellRendered = false;
    pageState.userDoc = null;
    var content = document.getElementById('acct-content');
    if (content) content.innerHTML = '<div class="acct-loading">Loading your account…</div>';
  }
});

// The shared module watches users/{uid}, payments, and subscriptions.
// We re-read the doc directly here for profile fields (displayName,
// gender, dob) because the shared module only surfaces the
// pass-relevant fields.
var unsubUserDoc = null;

esLabs.onAuthChange(function (user) {
  if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
  if (!user) return;
  unsubUserDoc = esLabs.db.collection('users').doc(user.uid).onSnapshot(function (snap) {
    pageState.userDoc = snap.exists ? snap.data() : {};
    renderApp();
  }, function (err) { console.warn('users doc snapshot error:', err.message); });
});

esLabs.onPassChange(function () { renderApp(); });

// ──────────────────────────────────────────────────────────────
//  Main render
// ──────────────────────────────────────────────────────────────
function renderApp() {
  var root = document.getElementById('acct-content');
  var user = esLabs.user;
  if (!root || !user || pageState.userDoc === null) return;

  if (!pageState.shellRendered) {
    var doc = pageState.userDoc || {};
    var displayName = doc.displayName || user.displayName || '';
    var email = user.email || '';
    var gender = (doc.gender === 'male' || doc.gender === 'female') ? doc.gender : '';
    var dob = doc.dob || '';

    root.innerHTML = ''
      + profileCardHtml(displayName, email, gender, dob)
      + '<div id="features-card-mount"></div>'
      + dangerZoneHtml(user);

    wireProfileCard();
    wireDangerZone();
    pageState.shellRendered = true;
  }

  var mount = document.getElementById('features-card-mount');
  if (mount) {
    mount.innerHTML = featuresCardHtml(esLabs.getPassState());
    wireFeaturesCard();
  }
}

function profileCardHtml(displayName, email, gender, dob) {
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
  var user = esLabs.user;
  if (!user) return;
  var name = (document.getElementById('f-name').value || '').trim();
  var dob = (document.getElementById('f-dob').value || '').trim();
  var genderInput = document.querySelector('#f-gender input[name="acct-gender"]:checked');
  var gender = genderInput ? genderInput.value : '';

  if (dob) {
    var parts = dob.split('-');
    if (parts.length !== 3 || isNaN(Date.parse(dob))) {
      setStatus('That date of birth does not look valid.', 'error');
      return;
    }
    if (new Date(dob + 'T00:00:00').getTime() > Date.now()) {
      setStatus('Date of birth cannot be in the future.', 'error');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  setStatus('');

  var fb = esLabs.firebase;
  var payload = {
    displayName: name || fb.firestore.FieldValue.delete(),
    gender: gender || fb.firestore.FieldValue.delete(),
    dob: dob || fb.firestore.FieldValue.delete(),
    updatedAt: fb.firestore.FieldValue.serverTimestamp()
  };

  esLabs.db.collection('users').doc(user.uid).set(payload, { merge: true })
    .then(function () {
      if (name && user.displayName !== name) return user.updateProfile({ displayName: name });
    })
    .then(function () { setStatus('Saved.', 'success'); })
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
function featuresCardHtml(pass) {
  return ''
    + '<section class="acct-card">'
    + '  <h2>Features &amp; billing</h2>'
    + '  <p class="card-sub">What you have access to today, and how it was unlocked.</p>'
    + '  ' + esFormLabRow(pass)
    + '  ' + coachingRow(pass)
    + '  <div class="billing-foot">'
    + '    <div class="billing-foot-text">'
    + '      Payments are processed by Stripe. Manage your subscription, payment methods, and invoices through the secure customer portal. '
    + '      <strong>One-time esFormLab passes</strong> aren&rsquo;t subscriptions &mdash; nothing recurring to cancel.'
    + '    </div>'
    + '    <button class="btn-link cyan" id="btn-portal">Manage billing in Stripe &rarr;</button>'
    + '  </div>'
    + '</section>';
}

function esFormLabRow(pass) {
  var statusBadge, statusLine, ctaHtml;
  if (pass.unlocked) {
    statusBadge = '<span class="badge unlocked">Unlocked</span>';
    if (pass.source === 'paid') {
      statusLine = '90-day pass active &middot; expires ' + formatDate(pass.until);
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>'
              + '<button class="btn-link" id="btn-portal-feat-form">Manage billing</button>';
    } else if (pass.source === 'coaching-bundle') {
      statusBadge += ' <span class="badge source">Bundled with Premium coaching</span>';
      statusLine = pass.until
        ? 'Included with your active coaching subscription &middot; renews ' + formatDate(pass.until)
        : 'Included with your active coaching subscription';
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>';
    } else if (pass.source === 'granted-until') {
      statusBadge += ' <span class="badge source">Granted by ESLabs</span>';
      statusLine = 'Comped access &middot; expires ' + formatDate(pass.until);
      ctaHtml = '<a class="btn-link" href="/esformlab/">Open form analysis &rarr;</a>';
    } else {
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

function coachingRow(pass) {
  var badge, line, cta;
  if (pass.hasPremiumCoach) {
    badge = '<span class="badge unlocked">Active</span>';
    line = pass.premiumCoachPeriodEnd
      ? 'Premium coaching subscription &middot; renews ' + formatDate(pass.premiumCoachPeriodEnd)
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
  ['btn-portal', 'btn-portal-feat-form', 'btn-portal-feat-coach'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function () {
      var origText = b.textContent;
      b.disabled = true;
      b.textContent = 'Opening Stripe…';
      esLabs.openCustomerPortal().catch(function () {
        b.disabled = false;
        b.textContent = origText;
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────
//  Danger zone (sign out)
// ──────────────────────────────────────────────────────────────
function dangerZoneHtml(user) {
  return ''
    + '<div class="danger-zone">'
    + '  <span class="danger-zone-text">Signed in as <strong>' + esc(user.email || user.uid) + '</strong></span>'
    + '  <button class="btn-signout" id="btn-signout">Sign out</button>'
    + '</div>';
}

function wireDangerZone() {
  var btn = document.getElementById('btn-signout');
  if (btn) btn.addEventListener('click', function () { esLabs.signOut(); });
}

// ──────────────────────────────────────────────────────────────
//  Utilities
// ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function todayIso() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
function formatDate(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

})();
