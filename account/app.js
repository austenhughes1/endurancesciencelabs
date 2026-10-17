// ════════════════════════════════════════════════════════════════
// /account/app.js
//
// User profile + features + billing page. Uses the shared site.js
// for auth, nav, and effective-pass state -- this file only handles
// account-page-specific UI.
//
// Profile fields are optional for everyone by default; for users who
// are coaching clients (active sub OR a coach has claimed them) a
// banner + required-field markers prompt them to complete the
// fields the coach needs.
// ════════════════════════════════════════════════════════════════

(function () {
'use strict';

if (!window.esLabs) {
  console.error('account/app.js: esLabs must be loaded first');
  return;
}

// Canonical PR distance order -- used for the dropdown options and for
// sorting saved PRs in the rendered list.
var PR_DISTANCES = [
  { key: '800m',     label: '800m' },
  { key: '1500m',    label: '1500m' },
  { key: 'mile',     label: 'Mile' },
  { key: '5k',       label: '5K' },
  { key: '10k',      label: '10K' },
  { key: 'half',     label: 'Half marathon' },
  { key: 'marathon', label: 'Marathon' },
  { key: '50k',      label: '50K' },
  { key: '50mi',     label: '50 mile' },
  { key: '100mi',    label: '100 mile' }
];

// Required fields for coaching clients. injury history + PRs are
// optional even for coaching clients -- not every athlete has them.
var COACHING_REQUIRED = ['displayName', 'dob', 'gender', 'runningYears', 'weeklyMiles', 'goals'];

// Labels + jump targets for the "Required for your coach" banner.
var FIELD_META = {
  displayName:  { label: 'Name', id: 'f-name' },
  dob:          { label: 'Date of birth', id: 'f-dob' },
  gender:       { label: 'Gender', id: 'f-gender-male' },
  runningYears: { label: 'Years running', id: 'f-years' },
  weeklyMiles:  { label: 'Typical miles per week', id: 'f-miles' },
  goals:        { label: 'Goals', id: 'f-goals' }
};

// m:ss, h:mm:ss, optional decimals ("18:30", "1:23:45", "2:05.4").
var TIME_RE = /^(\d{1,2}:)?\d{1,2}:\d{2}(\.\d+)?$/;

var CONTACT_EMAIL = 'austen@endurancesciencelabs.com';

// No nav link is "active" on this page; the account pill is.
var NAV_OPTS = { active: 'account' };
esLabs.mountNav('#acct-nav', NAV_OPTS);

esLabs.mountAuthGate('#acct-gate', {
  eyebrow: '◉ My account',
  headline: 'Sign in to manage your account',
  sub: 'Update your profile, see which features you have access to, and manage billing.',
  microcopy: '<strong>Free account</strong> · 1-tap signup',
  emailDefault: 'signin'
});

var LOADING_HTML = '<div class="esl-loading" role="status"><span class="esl-spin" aria-hidden="true"></span>Loading your account&hellip;</div>';

var pageState = {
  userDoc: null,
  shellRendered: false,
  uid: null,
  rosterCount: null,     // coach mode: athletes on this coach's roster (-1 = couldn't load)
  rosterFor: null,
  baseline: null,        // serialized form values as last loaded/saved
  dirty: false,
  savedTimer: null
};

esLabs.onAuthChange(function (user) {
  var app = document.getElementById('acct-app');
  if (!app) return;
  var adminTools = document.getElementById('admin-tools');
  if (user) {
    app.classList.add('show');
    if (adminTools) adminTools.style.display = (user.uid === esLabs.ADMIN_UID) ? 'block' : 'none';
  } else {
    app.classList.remove('show');
    if (adminTools) adminTools.style.display = 'none';
    resetContent();
  }
});

var unsubUserDoc = null;

esLabs.onAuthChange(function (user) {
  if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
  if (!user) return;
  subscribeUserDoc(user.uid);
});

esLabs.onPassChange(function () { renderApp(); });

function resetContent() {
  pageState.shellRendered = false;
  pageState.userDoc = null;
  pageState.rosterCount = null;
  pageState.rosterFor = null;
  setDirty(false);
  var content = document.getElementById('acct-content');
  if (content) {
    content.innerHTML = LOADING_HTML;
    content.setAttribute('aria-busy', 'true');
  }
}

function subscribeUserDoc(uid) {
  if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
  pageState.uid = uid;
  unsubUserDoc = esLabs.db.collection('users').doc(uid).onSnapshot(function (snap) {
    pageState.userDoc = snap.exists ? snap.data() : {};
    renderApp();
  }, function (err) {
    console.warn('users doc snapshot error:', err && err.message);
    unsubUserDoc = null;
    if (pageState.shellRendered) {
      setStatus('Lost connection to your account — reload the page before saving.', 'error');
      showSaveBar(true);
      return;
    }
    var content = document.getElementById('acct-content');
    if (!content) return;
    content.removeAttribute('aria-busy');
    content.innerHTML = ''
      + '<div class="esl-callout esl-callout--bad" role="alert">'
      + '  <p class="esl-callout-title">Couldn’t load your account</p>'
      + '  <p class="acct-error-text">Check your connection, then try again.</p>'
      + '  <button type="button" class="esl-btn esl-btn--outline esl-btn--sm" id="btn-acct-retry">Retry</button>'
      + '</div>';
    var retry = document.getElementById('btn-acct-retry');
    if (retry) retry.addEventListener('click', function () {
      content.innerHTML = LOADING_HTML;
      content.setAttribute('aria-busy', 'true');
      var u = esLabs.user;
      if (u) subscribeUserDoc(u.uid);
    });
  });
}

// ──────────────────────────────────────────────────────────────
//  Coaching-client detection
// ──────────────────────────────────────────────────────────────
// Returns true if the user must complete the profile for their coach.
function isCoachingClient(userDoc, pass) {
  if (!userDoc) return false;
  // Coaches don't need to complete an athlete profile.
  if (userDoc.role === 'coach') return false;
  if (pass && (pass.hasPremiumCoach || pass.hasStandardCoach)) return true;
  if (userDoc.coachUid) return true;
  return false;
}

// Returns the list of required-field keys that are currently missing.
function missingRequiredFields(userDoc) {
  if (!userDoc) return COACHING_REQUIRED.slice();
  return COACHING_REQUIRED.filter(function (k) {
    var v = userDoc[k];
    if (k === 'weeklyMiles' || k === 'runningYears') {
      return v === null || v === undefined || v === '' || isNaN(Number(v));
    }
    return !v || (typeof v === 'string' && v.trim() === '');
  });
}

function isCoachMode(doc) {
  return !!(doc && doc.role === 'coach');
}

// ──────────────────────────────────────────────────────────────
//  Main render
// ──────────────────────────────────────────────────────────────
function renderApp() {
  var root = document.getElementById('acct-content');
  var user = esLabs.user;
  if (!root || !user || pageState.userDoc === null) return;

  var doc = pageState.userDoc || {};
  var pass = esLabs.getPassState();
  // While acting as an athlete the pass state is the admin's own, so the
  // banner relies on the athlete's coachUid only.
  var coachingClient = isCoachingClient(doc, user.isActingAs ? null : pass);
  var coachMode = isCoachMode(doc);

  if (!pageState.shellRendered) {
    var ownProfile = trainingCardHtml(doc, coachMode) + prsCardHtml(doc, coachMode);
    if (coachMode) {
      ownProfile = ''
        + '<details class="acct-own" id="acct-own-profile">'
        + '  <summary><span class="acct-own-title">My own running profile (optional)</span>'
        + '  <span class="acct-own-hint">Training background and PRs, if you train too.</span></summary>'
        +    ownProfile
        + '</details>';
    }
    root.innerHTML = ''
      + '<div id="banner-mount"></div>'
      + '<div id="features-card-mount"></div>'
      + '<div id="esml-vo2-mount"></div>'
      + profileCardHtml(doc, user.email)
      + ownProfile
      + saveBarHtml()
      + appearanceCardHtml()
      + dangerZoneHtml(user);
    root.removeAttribute('aria-busy');

    wireProfileCard();
    wirePrsCard();
    wireSaveBar();
    wireAppearanceCard();
    wireDangerZone();
    pageState.shellRendered = true;
    pageState.baseline = serializeForm();
    setDirty(false);
  }

  if (coachMode && !user.isActingAs && pageState.rosterFor !== user.uid) loadRosterCount(user.uid);

  // Re-render banner + features on every state change. Form cards
  // keep their in-flight edits.
  var bannerMount = document.getElementById('banner-mount');
  if (bannerMount) bannerMount.innerHTML = bannerHtml(doc, coachingClient);

  applyRequiredMarkers(coachingClient);

  var vo2Mount = document.getElementById('esml-vo2-mount');
  if (vo2Mount) vo2Mount.innerHTML = esmlVo2CardHtml(doc);

  renderFeatures();
}

function renderFeatures() {
  var featMount = document.getElementById('features-card-mount');
  var user = esLabs.user;
  if (!featMount || !user) return;
  featMount.innerHTML = featuresCardHtml(esLabs.getPassState(), pageState.userDoc || {}, user);
  wireFeaturesCard();
}

// Coach mode: count the athletes on this coach's roster (the users rules
// let a coach query users where coachUid == their uid).
function loadRosterCount(uid) {
  pageState.rosterFor = uid;
  esLabs.db.collection('users').where('coachUid', '==', uid).get().then(function (snap) {
    if (pageState.rosterFor !== uid) return;
    var n = 0;
    snap.forEach(function (d) {
      var data = d.data() || {};
      if (d.id !== uid && data.role !== 'coach') n++;
    });
    pageState.rosterCount = n;
    renderFeatures();
  }).catch(function (e) {
    console.warn('roster count:', e && e.message);
    if (pageState.rosterFor !== uid) return;
    pageState.rosterCount = -1;
    renderFeatures();
  });
}

// ──────────────────────────────────────────────────────────────
//  "My ESLabs metabolic profile" card
// ──────────────────────────────────────────────────────────────
// Reads the user's saved esMetabolicLab data and routes them to
// the tool that holds their current profile. Never duplicates
// rendering of the underlying data — this is a discovery card,
// not a copy of the full results view.
//
// Priority:
//   1. Saved Lactate Step Test session → VO₂max + VLamax (lactate-anchored)
//   2. Saved Sprint VLamax only → lactate-anchored VLamax
//   3. Power Profile session → free / estimated route
//   4. Nothing → empty-state CTA into the free funnel
function esmlVo2CardHtml(doc) {
  var ml = (doc && doc.esmetlab) || {};
  var hasVlamax = !!(ml.vlamax && typeof ml.vlamax.value === 'number');
  var powerProfiles = Array.isArray(ml.powerProfiles) ? ml.powerProfiles : [];
  var latestPP = powerProfiles.length ? powerProfiles[powerProfiles.length - 1] : null;
  var lactateSessions = Array.isArray(ml.lactateSessions) ? ml.lactateSessions : [];
  var latestLS = lactateSessions.length ? lactateSessions[lactateSessions.length - 1] : null;
  var ppAlt = latestPP
    ? '<a class="vo2-alt esl-btn esl-btn--ghost" href="/esmetaboliclab/power-profile/">Power Profile →</a>'
    : '';

  // State 1: a saved Lactate Step Test (VO₂max + VLamax from the real curve).
  if (latestLS && latestLS.derived && typeof latestLS.derived.VO2max === 'number' && typeof latestLS.derived.VLamax === 'number') {
    var lsSec = tsToSec(latestLS.measured_at);
    var lsDate = lsSec ? formatDate(lsSec) : '';
    return ''
      + '<section class="acct-card vo2-card vo2-card-lactate">'
      + '  <div class="vo2-card-head">'
      + '    <h2><span class="vo2-card-glyph" aria-hidden="true">⬡</span> My ESLabs metabolic profile</h2>'
      + '    <span class="esl-badge esl-badge--purple">Lactate-anchored</span>'
      + '  </div>'
      + '  <div class="vo2-card-stats">'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VO₂max</div>'
      + '      <div class="vo2-stat-value">' + latestLS.derived.VO2max.toFixed(1) + '<span class="vo2-stat-unit">mL/min/kg</span></div>'
      + '    </div>'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VLamax</div>'
      + '      <div class="vo2-stat-value">' + latestLS.derived.VLamax.toFixed(3) + '<span class="vo2-stat-unit">mmol/L/s</span></div>'
      + '      <div class="vo2-stat-note">From your Lactate Step Test</div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="vo2-meta">'
      + (lsDate ? '<span>Tested ' + esc(lsDate) + '</span><span aria-hidden="true">·</span>' : '')
      + '    <span>Source: <strong>Lactate Step Test</strong></span>'
      + '  </div>'
      + '  <p class="vo2-card-msg">Your MLSS, LT1, Fatmax and training zones are in your full profile.</p>'
      + '  <div class="vo2-card-cta">'
      + '    <a class="esl-btn esl-btn--purple" href="/esmetaboliclab/profile/">View full profile →</a>'
      +      ppAlt
      + '  </div>'
      + '</section>';
  }

  // State 2: lactate-anchored Sprint VLamax only.
  if (hasVlamax) {
    var vlamax = ml.vlamax.value;
    var measuredSec = tsToSec(ml.vlamax.measured_at);
    var dateStr = measuredSec ? formatDate(measuredSec) : '';
    return ''
      + '<section class="acct-card vo2-card vo2-card-lactate">'
      + '  <div class="vo2-card-head">'
      + '    <h2><span class="vo2-card-glyph" aria-hidden="true">⬡</span> My ESLabs metabolic profile</h2>'
      + '    <span class="esl-badge esl-badge--purple">Lactate-anchored</span>'
      + '  </div>'
      + '  <div class="vo2-card-stats">'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VLamax</div>'
      + '      <div class="vo2-stat-value">' + vlamax.toFixed(3) + '<span class="vo2-stat-unit">mmol/L/s</span></div>'
      + '      <div class="vo2-stat-note">Measured from your Sprint VLamax Test</div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="vo2-meta">'
      + (dateStr ? '<span>Saved ' + esc(dateStr) + '</span><span aria-hidden="true">·</span>' : '')
      + '    <span>Source: <strong>Sprint VLamax Test</strong></span>'
      + '  </div>'
      + '  <p class="vo2-card-msg">'
      + '    Run the full Lactate Step Test to anchor your VO₂max, MLSS, LT1, Fatmax, and training zones to your real lactate curve.'
      + '  </p>'
      + '  <div class="vo2-card-cta">'
      + '    <a class="esl-btn esl-btn--purple" href="/esmetaboliclab/profile/">Open Lactate Step Test →</a>'
      +      ppAlt
      + '  </div>'
      + '</section>';
  }

  // State 3: power-only profile (estimate).
  if (latestPP && latestPP.derived && typeof latestPP.derived.VO2max === 'number') {
    var d = latestPP.derived;
    var ppSec = tsToSec(latestPP.measured_at);
    var ppDate = ppSec ? formatDate(ppSec) : '';
    var sport = (latestPP.inputs && latestPP.inputs.sport) || '';
    var sportLabel = sport === 'cycling' ? 'Cycling' : (sport === 'running' ? 'Running' : '');
    var vlaTile = typeof d.VLamax === 'number'
      ? '    <div class="vo2-stat">'
        + '      <div class="vo2-stat-label">VLamax</div>'
        + '      <div class="vo2-stat-value">' + d.VLamax.toFixed(3) + '<span class="vo2-stat-unit">mmol/L/s</span></div>'
        + '      <div class="vo2-stat-note">Back-derived from sprint power</div>'
        + '    </div>'
      : '';
    return ''
      + '<section class="acct-card vo2-card vo2-card-power">'
      + '  <div class="vo2-card-head">'
      + '    <h2><span class="vo2-card-glyph" aria-hidden="true">⬡</span> My ESLabs metabolic profile</h2>'
      + '    <span class="esl-badge esl-badge--warn">Estimate</span>'
      + '  </div>'
      + '  <div class="vo2-card-stats">'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VO₂max</div>'
      + '      <div class="vo2-stat-value">' + d.VO2max.toFixed(1) + '<span class="vo2-stat-unit">mL/min/kg</span></div>'
      + '    </div>'
      +      vlaTile
      + '  </div>'
      + '  <div class="vo2-meta">'
      + (ppDate ? '<span>Saved ' + esc(ppDate) + '</span><span aria-hidden="true">·</span>' : '')
      + '    <span>Source: <strong>Power Profile</strong>' + (sportLabel ? ' · ' + esc(sportLabel) : '') + '</span>'
      + '  </div>'
      + '  <p class="vo2-card-msg">'
      + '    This is an estimate. For lactate-anchored precision, run the Sprint VLamax Test — or upgrade with <a href="/coaching/">Full Access coaching</a>.'
      + '  </p>'
      + '  <div class="vo2-card-cta">'
      + '    <a class="esl-btn" href="/esmetaboliclab/power-profile/">View full profile →</a>'
      + '    <a class="vo2-alt esl-btn esl-btn--ghost" href="/esmetaboliclab/pricing/">See pricing →</a>'
      + '  </div>'
      + '</section>';
  }

  // State 4: nothing saved yet.
  return ''
    + '<section class="acct-card vo2-card vo2-card-empty">'
    + '  <div class="vo2-card-head">'
    + '    <h2><span class="vo2-card-glyph" aria-hidden="true">⬡</span> My ESLabs metabolic profile</h2>'
    + '  </div>'
    + '  <p class="vo2-card-msg">'
    + '    Build your VO₂max, lactate threshold, training zones, and fueling profile — free in your browser, no equipment, in about 30 minutes.'
    + '  </p>'
    + '  <div class="vo2-card-cta">'
    + '    <a class="esl-btn" href="/esmetaboliclab/power-profile/">Build your free profile →</a>'
    + '  </div>'
    + '</section>';
}

// Coerce a Firestore Timestamp / number / seconds-object to unix seconds.
function tsToSec(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t;
  if (typeof t.seconds === 'number') return t.seconds;
  if (typeof t.toDate === 'function') {
    try { return Math.floor(t.toDate().getTime() / 1000); } catch (e) { return null; }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
//  Banner (coaching client + incomplete profile)
// ──────────────────────────────────────────────────────────────
function bannerHtml(userDoc, coachingClient) {
  if (!coachingClient) return '';
  var missing = missingRequiredFields(userDoc);
  if (missing.length === 0) return '';
  var links = missing.map(function (k) {
    var m = FIELD_META[k];
    return '<button type="button" class="esl-link" data-jump="' + esc(m.id) + '">' + esc(m.label) + '</button>';
  }).join(', ');
  return ''
    + '<div class="coach-banner esl-callout esl-callout--warn">'
    + '  <p class="esl-callout-title">Required for your coach</p>'
    + '  <p class="coach-banner-text">Your coach needs a few more details. Missing: ' + links + '. '
    + 'Required fields are marked <span class="req-star req-star--inline" aria-hidden="true">*</span>.</p>'
    + '</div>';
}

function applyRequiredMarkers(coachingClient) {
  document.querySelectorAll('[data-required]').forEach(function (el) {
    el.style.display = coachingClient ? 'inline' : 'none';
  });
  ['f-name', 'f-dob', 'f-years', 'f-miles', 'f-goals', 'f-gender'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (coachingClient) el.setAttribute('aria-required', 'true');
    else el.removeAttribute('aria-required');
  });
}

// ──────────────────────────────────────────────────────────────
//  Profile card
// ──────────────────────────────────────────────────────────────
function reqStar() {
  return '<span class="req-star" data-required aria-hidden="true">*</span>';
}

function profileCardHtml(doc, email) {
  var displayName = doc.displayName || (esLabs.user && esLabs.user.displayName) || '';
  var gender = (doc.gender === 'male' || doc.gender === 'female') ? doc.gender : '';
  var dob = doc.dob || '';
  return ''
    + '<section class="acct-card">'
    + '  <h2>Profile</h2>'
    + '  <p class="card-sub">Your name appears on saved sessions. Gender picks the reference group esFormLab compares you with, and date of birth estimates your max heart rate for Fitness &amp; Form.</p>'
    + '  <div class="field-grid">'
    + '    <div class="field">'
    + '      <label class="field-label" for="f-name">Name' + reqStar() + '</label>'
    + '      <input id="f-name" class="field-input esl-input" type="text" maxlength="80" autocomplete="name" value="' + esc(displayName) + '" placeholder="Your name">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Email</span>'
    + '      <div class="field-static">' + esc(email) + ' <span class="esl-badge">Read-only</span></div>'
    + '    </div>'
    + '    <div class="field">'
    + '      <label class="field-label" for="f-dob">Date of birth' + reqStar() + '</label>'
    + '      <input id="f-dob" class="field-input esl-input" type="date" autocomplete="bday" value="' + esc(dob) + '" max="' + todayIso() + '">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label" id="lbl-gender">Gender' + reqStar() + '</span>'
    + '      <div class="radio-row" id="f-gender" role="radiogroup" aria-labelledby="lbl-gender">'
    + '        <label class="radio-pill' + (gender === 'male' ? ' checked' : '') + '" data-val="male"><input type="radio" id="f-gender-male" name="acct-gender" value="male"' + (gender === 'male' ? ' checked' : '') + '><span>&#9794; Male</span></label>'
    + '        <label class="radio-pill' + (gender === 'female' ? ' checked' : '') + '" data-val="female"><input type="radio" id="f-gender-female" name="acct-gender" value="female"' + (gender === 'female' ? ' checked' : '') + '><span>&#9792; Female</span></label>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</section>';
}

// Radio pills: wire the inputs' change event (fires for label clicks AND
// arrow keys) and mirror the checked state onto the pill.
function syncPills(rowSel, val) {
  document.querySelectorAll(rowSel + ' .radio-pill').forEach(function (p) {
    var on = p.getAttribute('data-val') === val;
    p.classList.toggle('checked', on);
    var i = p.querySelector('input');
    if (i) i.checked = on;
  });
}

function wireProfileCard() {
  document.querySelectorAll('#f-gender input').forEach(function (inp) {
    inp.addEventListener('change', function () { syncPills('#f-gender', inp.value); });
  });
}

// ──────────────────────────────────────────────────────────────
//  Training profile card
// ──────────────────────────────────────────────────────────────
function trainingCardHtml(doc, coachMode) {
  var years = (doc.runningYears !== undefined && doc.runningYears !== null) ? String(doc.runningYears) : '';
  var miles = (doc.weeklyMiles !== undefined && doc.weeklyMiles !== null) ? String(doc.weeklyMiles) : '';
  var maxHr = (typeof doc.maxHr === 'number' && doc.maxHr > 0) ? String(doc.maxHr) : '';
  var goals = doc.goals || '';
  var injuries = doc.injuryHistory || '';
  var sub = coachMode
    ? 'Your own running background. Optional &mdash; fill it in only if you train with Endurance Science Labs too.'
    : 'Background your coach uses to tailor your plan. Leave anything blank if it doesn&rsquo;t apply.';
  return ''
    + '<section class="acct-card">'
    + '  <h2>Training profile</h2>'
    + '  <p class="card-sub">' + sub + '</p>'
    + '  <div class="field-grid">'
    + '    <div class="field">'
    + '      <label class="field-label" for="f-years">Years running' + reqStar() + '</label>'
    + '      <input id="f-years" class="field-input esl-input" type="number" min="0" max="80" step="0.5" value="' + esc(years) + '" placeholder="e.g. 3">'
    + '    </div>'
    + '    <div class="field">'
    + '      <label class="field-label" for="f-miles">Typical miles per week' + reqStar() + '</label>'
    + '      <input id="f-miles" class="field-input esl-input" type="number" min="0" max="300" step="1" value="' + esc(miles) + '" placeholder="e.g. 30">'
    + '    </div>'
    + '    <div class="field">'
    + '      <label class="field-label" for="f-maxhr">Max heart rate (bpm) <span class="field-label-hint">(optional)</span></label>'
    + '      <input id="f-maxhr" class="field-input esl-input" type="number" min="120" max="230" step="1" inputmode="numeric" value="' + esc(maxHr) + '" placeholder="e.g. 188" aria-describedby="f-maxhr-hint">'
    + '      <p class="esl-hint" id="f-maxhr-hint">Improves training-load accuracy. Leave blank to estimate it from your date of birth.</p>'
    + '    </div>'
    + '  </div>'
    + '  <div class="field field--full">'
    + '    <label class="field-label" for="f-goals">Goals' + reqStar() + '</label>'
    + '    <textarea id="f-goals" class="field-input esl-textarea field-textarea" rows="3" maxlength="600" placeholder="What are you training for? Specific races, time goals, distances, life-goals (“finish my first marathon”), etc.">' + esc(goals) + '</textarea>'
    + '  </div>'
    + '  <div class="field field--full">'
    + '    <label class="field-label" for="f-injuries">Injury history <span class="field-label-hint">(optional)</span></label>'
    + '    <textarea id="f-injuries" class="field-input esl-textarea field-textarea" rows="3" maxlength="800" placeholder="Recent or recurring injuries your coach should know about. Leave blank if none.">' + esc(injuries) + '</textarea>'
    + '  </div>'
    + '</section>';
}

// ──────────────────────────────────────────────────────────────
//  Personal records card
// ──────────────────────────────────────────────────────────────
function prsCardHtml(doc, coachMode) {
  var prs = normalizePrs(doc.prs);
  return ''
    + '<section class="acct-card">'
    + '  <h2>Personal records</h2>'
    + '  <p class="card-sub">' + (coachMode ? 'Your own PR at each distance, if you want them on file. ' : 'Your current PR at each distance. Add a date if you remember it. ') + 'One PR per distance &mdash; updating is replacing.</p>'
    + '  <div class="pr-head" aria-hidden="true"><span>Distance</span><span>Time</span><span>Date set (optional)</span><span></span></div>'
    + '  <div id="prs-list" class="prs-list">'
    +      prs.map(function (pr) { return prRowHtml(pr); }).join('')
    + '  </div>'
    + '  <button type="button" class="esl-btn esl-btn--outline esl-btn--sm" id="btn-add-pr">+ Add PR</button>'
    + '</section>';
}

// Returns an array of { distance, time, date }, sorted by canonical
// distance order. Tolerates the legacy-array shape in case anyone
// wrote to the field in the past.
function normalizePrs(raw) {
  var byDist = {};
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw)) {
      raw.forEach(function (entry) {
        if (entry && entry.distance) byDist[entry.distance] = { time: entry.time || '', date: entry.date || '' };
      });
    } else {
      Object.keys(raw).forEach(function (dist) {
        var entry = raw[dist];
        if (entry && typeof entry === 'object') {
          byDist[dist] = { time: entry.time || '', date: entry.date || '' };
        }
      });
    }
  }
  var out = [];
  PR_DISTANCES.forEach(function (d) {
    if (byDist[d.key]) {
      out.push({ distance: d.key, time: byDist[d.key].time, date: byDist[d.key].date });
    }
  });
  return out;
}

function prRowHtml(pr) {
  var distance = (pr && pr.distance) || '';
  var time = (pr && pr.time) || '';
  var date = (pr && pr.date) || '';
  var optsHtml = '<option value="">Select distance…</option>'
    + PR_DISTANCES.map(function (d) {
        return '<option value="' + esc(d.key) + '"' + (d.key === distance ? ' selected' : '') + '>' + esc(d.label) + '</option>';
      }).join('');
  return ''
    + '<div class="pr-row" data-pr-row>'
    + '  <select class="field-input esl-select esl-select--sm pr-distance" data-pr-distance aria-label="PR distance">' + optsHtml + '</select>'
    + '  <input type="text" class="field-input esl-input esl-input--sm pr-time" placeholder="e.g. 18:30 or 1:23:45" value="' + esc(time) + '" data-pr-time aria-label="PR time">'
    + '  <input type="date" class="field-input esl-input esl-input--sm pr-date" value="' + esc(date) + '" max="' + todayIso() + '" data-pr-date aria-label="Date set (optional)">'
    + '  <button type="button" class="pr-remove esl-btn esl-btn--outline esl-btn--icon" data-pr-remove aria-label="Remove PR">&times;</button>'
    + '</div>';
}

function wirePrsCard() {
  document.getElementById('btn-add-pr').addEventListener('click', addPrRow);
  var list = document.getElementById('prs-list');
  list.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pr-remove]');
    if (t) {
      var row = t.closest('[data-pr-row]');
      if (row) row.parentNode.removeChild(row);
      refreshDistanceOptions();
      refreshAddPrButton();
      updateDirty();
      var add = document.getElementById('btn-add-pr');
      if (add && !add.disabled) add.focus();
    }
  });
  list.addEventListener('change', function (e) {
    if (e.target.closest('[data-pr-distance]')) refreshDistanceOptions();
  });
  refreshDistanceOptions();
  refreshAddPrButton();
}

function addPrRow() {
  var list = document.getElementById('prs-list');
  var wrap = document.createElement('div');
  wrap.innerHTML = prRowHtml({ distance: '', time: '', date: '' });
  var row = wrap.firstElementChild;
  list.appendChild(row);
  refreshDistanceOptions();
  refreshAddPrButton();
  var sel = row.querySelector('[data-pr-distance]');
  if (sel) sel.focus();
}

// One PR per distance: a distance picked in one row is disabled in the others.
function refreshDistanceOptions() {
  var selects = document.querySelectorAll('#prs-list [data-pr-distance]');
  var used = [];
  selects.forEach(function (s) { if (s.value) used.push(s.value); });
  selects.forEach(function (s) {
    Array.prototype.forEach.call(s.options, function (o) {
      o.disabled = !!o.value && o.value !== s.value && used.indexOf(o.value) !== -1;
    });
  });
}

function refreshAddPrButton() {
  var btn = document.getElementById('btn-add-pr');
  if (!btn) return;
  var rowCount = document.querySelectorAll('#prs-list .pr-row').length;
  if (rowCount >= PR_DISTANCES.length) {
    btn.disabled = true;
    btn.textContent = 'All distances added';
  } else {
    btn.disabled = false;
    btn.textContent = '+ Add PR';
  }
}

// ──────────────────────────────────────────────────────────────
//  Appearance (theme) — applies + persists instantly, independent
//  of the Save changes button.
// ──────────────────────────────────────────────────────────────
function appearanceCardHtml() {
  var theme = esLabs.getTheme();
  return ''
    + '<section class="acct-card">'
    + '  <h2 id="lbl-theme">Appearance</h2>'
    + '  <p class="card-sub">Choose how Endurance Science Labs looks. Your choice is saved to your account and follows you across devices.</p>'
    + '  <div class="radio-row" id="f-theme" role="radiogroup" aria-label="Theme">'
    + '    <label class="radio-pill' + (theme === 'dark' ? ' checked' : '') + '" data-val="dark"><input type="radio" name="acct-theme" value="dark"' + (theme === 'dark' ? ' checked' : '') + '><span>&#9789; Dark</span></label>'
    + '    <label class="radio-pill' + (theme === 'light' ? ' checked' : '') + '" data-val="light"><input type="radio" name="acct-theme" value="light"' + (theme === 'light' ? ' checked' : '') + '><span>&#9788; Light</span></label>'
    + '  </div>'
    + '</section>';
}

var themeListenerAdded = false;
function wireAppearanceCard() {
  document.querySelectorAll('#f-theme input').forEach(function (inp) {
    inp.addEventListener('change', function () {
      esLabs.setTheme(inp.value);
      syncPills('#f-theme', inp.value);
    });
  });
  // Keep the pills in sync if the theme changes elsewhere (e.g. Firestore sync).
  if (!themeListenerAdded) {
    themeListenerAdded = true;
    esLabs.onThemeChange(function (t) { syncPills('#f-theme', t); });
  }
}

// ──────────────────────────────────────────────────────────────
//  Unsaved-changes tracking + sticky save bar
// ──────────────────────────────────────────────────────────────
function saveBarHtml() {
  return ''
    + '<div class="save-bar" id="save-bar" hidden>'
    + '  <span class="save-bar-badge esl-badge esl-badge--warn" id="save-bar-badge">Unsaved changes</span>'
    + '  <span class="save-status" id="save-status" role="status" aria-live="polite"></span>'
    + '  <div class="save-bar-actions">'
    + '    <button type="button" class="esl-btn esl-btn--ghost" id="btn-discard-profile">Discard</button>'
    + '    <button type="button" class="esl-btn" id="btn-save-profile">Save changes</button>'
    + '  </div>'
    + '</div>';
}

function wireSaveBar() {
  document.getElementById('btn-save-profile').addEventListener('click', function () { saveAll(); });
  document.getElementById('btn-discard-profile').addEventListener('click', discardChanges);
}

// Everything the Save button writes, as one comparable string. PR rows
// that are completely empty don't count (they're dropped on save).
function serializeForm() {
  function v(id) { var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
  var g = document.querySelector('#f-gender input[name="acct-gender"]:checked');
  var prs = [];
  document.querySelectorAll('#prs-list .pr-row').forEach(function (row) {
    var d = row.querySelector('[data-pr-distance]').value;
    var t = (row.querySelector('[data-pr-time]').value || '').trim();
    var dt = (row.querySelector('[data-pr-date]').value || '').trim();
    if (d || t || dt) prs.push([d, t, dt]);
  });
  prs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return JSON.stringify([v('f-name'), v('f-dob'), g ? g.value : '', v('f-years'), v('f-miles'), v('f-maxhr'), v('f-goals'), v('f-injuries'), prs]);
}

function updateDirty() {
  if (!pageState.shellRendered) return;
  setDirty(serializeForm() !== pageState.baseline);
}

function setDirty(on) {
  pageState.dirty = !!on;
  var badge = document.getElementById('save-bar-badge');
  if (badge) badge.hidden = !on;
  var discard = document.getElementById('btn-discard-profile');
  if (discard) discard.hidden = !on;
  if (on) {
    if (pageState.savedTimer) { clearTimeout(pageState.savedTimer); pageState.savedTimer = null; }
    showSaveBar(true);
  } else {
    var status = document.getElementById('save-status');
    var keep = status && status.classList.contains('error');
    if (!keep && !pageState.savedTimer) showSaveBar(false);
  }
}

function showSaveBar(on) {
  var bar = document.getElementById('save-bar');
  if (bar) bar.hidden = !on;
}

function discardChanges() {
  pageState.shellRendered = false;
  setStatus('');
  renderApp();
}

// Delegated: any edit in the form cards updates the dirty state, clears a
// field's error once it's edited, and drops a stale "Saved." line.
(function wireContentListeners() {
  var root = document.getElementById('acct-content');
  if (!root) return;
  function onEdit(e) {
    var t = e.target;
    if (!t || t.closest('#f-theme')) return;
    var status = document.getElementById('save-status');
    if (t.getAttribute && t.getAttribute('aria-invalid') === 'true') {
      clearFieldError(t);
      if (status && status.classList.contains('error') && !root.querySelector('[aria-invalid="true"]')) setStatus('');
    }
    if (status && status.classList.contains('success')) setStatus('');
    updateDirty();
  }
  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);
  root.addEventListener('click', function (e) {
    var j = e.target.closest('[data-jump]');
    if (!j) return;
    var el = document.getElementById(j.getAttribute('data-jump'));
    if (!el) return;
    revealField(el);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  });
})();

// Fields inside the collapsed coach-mode section must be visible before focus.
function revealField(el) {
  var d = el.closest('details');
  if (d && !d.open) d.open = true;
}

// ──────────────────────────────────────────────────────────────
//  Leaving with unsaved changes: Save / Discard / Cancel
// ──────────────────────────────────────────────────────────────
window.addEventListener('beforeunload', function (e) {
  if (!pageState.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('click', function (e) {
  if (!pageState.dirty) return;
  var t = e.target.closest('a[href], [data-eslabs-signout], #btn-signout, #btn-stop-actas, #eslabs-actas-stop');
  if (!t || t.closest('#acct-leave-modal')) return;
  if (t.tagName === 'A') {
    var href = t.getAttribute('href') || '';
    if (t.target === '_blank' || t.hasAttribute('download') || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href || href.charAt(0) === '#' || /^(mailto|tel|javascript):/i.test(href)) return;
  }
  e.preventDefault();
  e.stopPropagation();
  promptLeave(t, function () {
    if (t.tagName === 'A') { window.location.href = t.href; return; }
    if (t.id === 'btn-stop-actas' || t.id === 'eslabs-actas-stop') { esLabs.stopActAs(); return; }
    esLabs.signOut();
  });
}, true);

var leaveDialog = null;
function promptLeave(trigger, proceed) {
  var modal = document.getElementById('acct-leave-modal');
  if (!modal) { if (window.confirm('Discard your unsaved changes?')) { setDirty(false); proceed(); } return; }
  function close() {
    modal.hidden = true;
    if (leaveDialog) { leaveDialog.close(); leaveDialog = null; }
    modal.onclick = null;
  }
  modal.hidden = false;
  leaveDialog = esLabs.openDialog(modal, {
    trigger: trigger,
    initialFocus: modal.querySelector('[data-leave="save"]'),
    onClose: function () { modal.hidden = true; leaveDialog = null; modal.onclick = null; }
  });
  modal.onclick = function (e) {
    if (e.target === modal) { close(); return; }
    var b = e.target.closest('[data-leave]');
    if (!b) return;
    var act = b.getAttribute('data-leave');
    if (act === 'cancel') { close(); return; }
    if (act === 'discard') { close(); setDirty(false); proceed(); return; }
    if (act === 'save') {
      close();
      saveAll().then(function (ok) { if (ok) proceed(); });
    }
  };
}

// ──────────────────────────────────────────────────────────────
//  Save
// ──────────────────────────────────────────────────────────────
function reduceMotion() {
  return esLabs.prefersReducedMotion ? esLabs.prefersReducedMotion()
    : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clearFieldError(el) {
  if (!el) return;
  el.removeAttribute('aria-invalid');
  var errId = (el.id || '') + '-err';
  var desc = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (x) { return x && x !== errId && x !== 'pr-err'; });
  if (desc.length) el.setAttribute('aria-describedby', desc.join(' ')); else el.removeAttribute('aria-describedby');
  var e = el.id ? document.getElementById(errId) : null;
  if (e) e.remove();
  var row = el.closest('[data-pr-row]');
  if (row && !row.querySelector('[aria-invalid="true"]')) {
    var pe = row.querySelector('.pr-error');
    if (pe) pe.remove();
  }
}

function attachError(el, err, focusIt) {
  var desc = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (desc.indexOf(err.id) === -1) desc.push(err.id);
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', desc.join(' '));
  if (focusIt) {
    revealField(el);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    setStatus('Fix the highlighted field, then save again.', 'error');
    showSaveBar(true);
  }
}

// Shows msg under the field, marks it invalid and moves focus to it.
function fieldError(id, msg) {
  var el = document.getElementById(id);
  if (!el) return;
  clearFieldError(el);
  var err = document.createElement('p');
  err.className = 'esl-field-error';
  err.id = id + '-err';
  err.textContent = msg;
  // A hint under the field stays under it; the error goes below the hint.
  var after = el;
  var hint = el.nextElementSibling;
  if (hint && hint.classList.contains('esl-hint')) after = hint;
  after.insertAdjacentElement('afterend', err);
  attachError(el, err, true);
}

// PR rows: the error line spans the whole row.
function prRowError(row, control, msg, focusIt) {
  var old = row.querySelector('.pr-error');
  if (old) old.remove();
  var err = document.createElement('p');
  err.className = 'esl-field-error pr-error';
  err.id = 'pr-err-' + Math.random().toString(36).slice(2, 8);
  err.textContent = msg;
  row.appendChild(err);
  attachError(control, err, focusIt);
}

function clearAllErrors() {
  document.querySelectorAll('#acct-content [aria-invalid="true"]').forEach(clearFieldError);
  document.querySelectorAll('#acct-content .pr-error').forEach(function (e) { e.remove(); });
}

// Returns a Promise<boolean>: true when the profile was saved.
function saveAll() {
  var btn = document.getElementById('btn-save-profile');
  var user = esLabs.user;
  if (!user || !btn) return Promise.resolve(false);

  var name = (document.getElementById('f-name').value || '').trim();
  var dob = (document.getElementById('f-dob').value || '').trim();
  var genderInput = document.querySelector('#f-gender input[name="acct-gender"]:checked');
  var gender = genderInput ? genderInput.value : '';
  var yearsRaw = (document.getElementById('f-years').value || '').trim();
  var milesRaw = (document.getElementById('f-miles').value || '').trim();
  var maxHrRaw = (document.getElementById('f-maxhr').value || '').trim();
  var goals = (document.getElementById('f-goals').value || '').trim();
  var injuries = (document.getElementById('f-injuries').value || '').trim();

  clearAllErrors();

  if (dob) {
    if (isNaN(Date.parse(dob))) { fieldError('f-dob', 'That date of birth does not look valid.'); return Promise.resolve(false); }
    if (new Date(dob + 'T00:00:00').getTime() > Date.now()) {
      fieldError('f-dob', 'Date of birth cannot be in the future.');
      return Promise.resolve(false);
    }
  }
  if (yearsRaw && (isNaN(Number(yearsRaw)) || Number(yearsRaw) < 0 || Number(yearsRaw) > 80)) {
    fieldError('f-years', 'Years running should be a number between 0 and 80.');
    return Promise.resolve(false);
  }
  if (milesRaw && (isNaN(Number(milesRaw)) || Number(milesRaw) < 0 || Number(milesRaw) > 300)) {
    fieldError('f-miles', 'Typical miles per week should be a number between 0 and 300.');
    return Promise.resolve(false);
  }
  var maxHr = null;
  if (maxHrRaw) {
    maxHr = parseInt(maxHrRaw, 10);
    if (isNaN(maxHr) || maxHr < 120 || maxHr > 230) {
      fieldError('f-maxhr', 'Max HR should be between 120 and 230 bpm (or leave it blank).');
      return Promise.resolve(false);
    }
  }

  // PRs: drop empty rows, flag incomplete ones instead of silently losing them.
  var prsMap = {};
  var firstBad = null;
  document.querySelectorAll('#prs-list .pr-row').forEach(function (row) {
    var sel = row.querySelector('[data-pr-distance]');
    var timeEl = row.querySelector('[data-pr-time]');
    var d = sel.value;
    var t = (timeEl.value || '').trim();
    var dt = (row.querySelector('[data-pr-date]').value || '').trim();
    if (!d && !t && !dt) { row.parentNode.removeChild(row); return; }
    if (!d) {
      prRowError(row, sel, 'Pick a distance for this PR.', !firstBad);
      if (!firstBad) firstBad = sel;
      return;
    }
    if (!t || !TIME_RE.test(t)) {
      prRowError(row, timeEl, 'Enter a time like 18:30 or 1:23:45.', !firstBad);
      if (!firstBad) firstBad = timeEl;
      return;
    }
    prsMap[d] = { time: t };
    if (dt) prsMap[d].date = dt;
  });
  refreshDistanceOptions();
  refreshAddPrButton();
  if (firstBad) return Promise.resolve(false);

  btn.disabled = true;
  btn.textContent = 'Saving…';
  setStatus('');

  var fb = esLabs.firebase;
  var del = fb.firestore.FieldValue.delete();
  var payload = {
    displayName: name || del,
    gender: gender || del,
    dob: dob || del,
    runningYears: yearsRaw === '' ? del : Number(yearsRaw),
    weeklyMiles: milesRaw === '' ? del : Number(milesRaw),
    maxHr: maxHr === null ? del : maxHr,
    goals: goals || del,
    injuryHistory: injuries || del,
    prs: Object.keys(prsMap).length ? prsMap : del,
    updatedAt: fb.firestore.FieldValue.serverTimestamp()
  };

  return esLabs.db.collection('users').doc(user.uid).set(payload, { merge: true })
    .then(function () {
      if (name && user.displayName !== name) return user.updateProfile({ displayName: name });
    })
    .then(function () {
      // Refresh the nav pill's name (never while acting -- the nav shows the admin).
      if (!user.isActingAs && esLabs.refreshNav) esLabs.refreshNav();
      // Re-render the PR list from what was saved so the screen matches the data.
      var list = document.getElementById('prs-list');
      if (list) {
        list.innerHTML = normalizePrs(prsMap).map(prRowHtml).join('');
        refreshDistanceOptions();
        refreshAddPrButton();
      }
      pageState.baseline = serializeForm();
      setStatus('Saved.', 'success');
      setDirty(false);
      showSaveBar(true);
      if (pageState.savedTimer) clearTimeout(pageState.savedTimer);
      pageState.savedTimer = setTimeout(function () {
        pageState.savedTimer = null;
        if (!pageState.dirty) showSaveBar(false);
      }, 4000);
      return true;
    })
    .catch(function (e) {
      console.error('saveAll error:', e);
      setStatus('Could not save: ' + (e.message || e), 'error');
      showSaveBar(true);
      return false;
    })
    .then(function (ok) {
      btn.disabled = false;
      btn.textContent = 'Save changes';
      return ok;
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
function featuresCardHtml(pass, doc, user) {
  // Pass state belongs to the REAL (admin) account while acting, so never
  // show it as the athlete's billing.
  if (user && user.isActingAs) {
    var who = user.displayName || user.email || 'this athlete';
    return ''
      + '<section class="acct-card">'
      + '  <h2>Features &amp; billing</h2>'
      + '  <p class="card-sub">Billing and paid access are private to ' + esc(who) + ', so they aren’t shown while you’re acting as them. Access grants are in Manage Users.</p>'
      + '  <a class="esl-btn esl-btn--outline esl-btn--sm" href="/admin/users/">Open Manage Users &rarr;</a>'
      + '</section>';
  }
  var m = pass.metlab || {};
  var hasBilling = !!(pass.hasPaidPass || pass.hasPremiumCoach || pass.hasStandardCoach || pass.coachPastDue
    || m.yearlyActive || m.hasLifetime || m.singleSessionUntil || m.inPersonLatest || pass.shockwaveLatestPaid);
  var footText = hasBilling
    ? 'Payments are processed by Stripe. Manage your subscriptions, payment methods and invoices in the secure customer portal. '
      + '<strong>One-time passes</strong> aren&rsquo;t subscriptions &mdash; nothing recurring to cancel.'
    : 'Payments are processed by Stripe. Once you buy a plan or a pass, you can manage it here.';
  return ''
    + '<section class="acct-card">'
    + '  <h2>Features &amp; billing</h2>'
    + '  <p class="card-sub">What you have access to today, and how it was unlocked.</p>'
    + '  ' + coachingRow(pass, doc)
    + '  ' + runDynamicsRow(pass, doc)
    + '  ' + esFormLabRow(pass)
    + '  ' + metlabRow(pass)
    + '  <div class="billing-foot">'
    + '    <p class="billing-foot-text">' + footText + '</p>'
    + (hasBilling ? '    <button type="button" class="esl-btn esl-btn--outline esl-btn--sm" id="btn-portal">Manage billing &rarr;</button>' : '')
    + '  </div>'
    + '</section>';
}

function featureRowHtml(icon, title, badges, lines, ctaHtml) {
  return ''
    + '<div class="feature-row">'
    + '  <div class="feature-icon" aria-hidden="true">' + icon + '</div>'
    + '  <div class="feature-body">'
    + '    <h3 class="feature-name">' + title + ' ' + badges + '</h3>'
    +      lines.filter(Boolean).map(function (l) { return '<p class="feature-desc">' + l + '</p>'; }).join('')
    + (ctaHtml ? '    <div class="feature-actions">' + ctaHtml + '</div>' : '')
    + '  </div>'
    + '</div>';
}

function badge(text, variant) {
  return '<span class="esl-badge' + (variant ? ' esl-badge--' + variant : '') + '">' + text + '</span>';
}

function linkBtn(href, label) {
  return '<a class="esl-btn esl-btn--outline esl-btn--sm" href="' + href + '">' + label + '</a>';
}

function esFormLabRow(pass) {
  var badges, line, cta = linkBtn('/esformlab/', 'Open esFormLab &rarr;');
  var renewWord = pass.coachCancelAtPeriodEnd ? 'ends' : 'renews';
  if (pass.unlocked) {
    badges = badge('Unlocked', 'good');
    if (pass.source === 'paid') {
      line = '90-day pass active &middot; expires ' + formatDate(pass.until);
    } else if (pass.source === 'coaching-bundle') {
      badges += ' ' + badge('Included with Full Access', 'accent');
      line = pass.until
        ? 'Included with your Full Access coaching &middot; ' + renewWord + ' ' + formatDate(pass.until)
        : 'Included with your Full Access coaching';
    } else if (pass.source === 'granted-until') {
      badges += ' ' + badge('Granted by ESLabs', 'accent');
      line = 'Comped access &middot; expires ' + formatDate(pass.until);
    } else {
      badges += ' ' + badge('Granted by ESLabs', 'accent');
      line = 'Comped access &middot; no expiration';
    }
  } else {
    badges = badge('Locked');
    line = 'Upload &amp; scan are free. The full report (issues, coaching cues, bell-curve placement, downloadable PDF) unlocks with a one-time 90-day pass from the report screen.';
  }
  return featureRowHtml('&#9673;', 'esFormLab &mdash; full report', badges, [line], cta);
}

function coachingRow(pass, doc) {
  var dash = linkBtn('/coaching/', 'Coaching dashboard &rarr;');
  // Coach mode: coaches see their roster, not the coaching upsell.
  if (isCoachMode(doc)) {
    var n = pageState.rosterCount;
    var line = n === null ? 'Counting your athletes&hellip;'
      : n < 0 ? 'Your athletes are in the Coaching dashboard.'
      : 'You coach ' + n + ' athlete' + (n === 1 ? '' : 's') + '.';
    return featureRowHtml('&#9788;', 'Coaching', badge('Coach', 'accent'), [line], dash);
  }
  var shockFree = 'Includes a free <a class="esl-link" href="/shockwave/">Shockwave + EMTT</a> session each month.';
  var shockMember = 'Includes the $50 member rate on <a class="esl-link" href="/shockwave/">Shockwave + EMTT</a> sessions.';
  if (pass.hasPremiumCoach) {
    var pEnd = pass.premiumCoachPeriodEnd;
    var pLine = pEnd
      ? (pass.coachCancelAtPeriodEnd ? 'Full Access &middot; ends ' + formatDate(pEnd) + ' &mdash; won&rsquo;t renew' : 'Full Access &middot; renews ' + formatDate(pEnd))
      : 'Full Access subscription active.';
    return featureRowHtml('&#9788;', 'Coaching', badge('Active', 'good'), [pLine, shockFree], dash);
  }
  if (pass.hasStandardCoach) {
    var sEnd = pass.standardCoachPeriodEnd;
    var sLine = sEnd
      ? (pass.coachCancelAtPeriodEnd ? 'Standard Coaching &middot; ends ' + formatDate(sEnd) + ' &mdash; won&rsquo;t renew' : 'Standard Coaching &middot; renews ' + formatDate(sEnd))
      : 'Standard Coaching subscription active.';
    return featureRowHtml('&#9788;', 'Coaching', badge('Active', 'good'), [sLine, shockMember], dash);
  }
  if (pass.coachPastDue) {
    return featureRowHtml('&#9788;', 'Coaching', badge('Payment failed', 'warn'),
      ['Your last coaching payment didn&rsquo;t go through. Update your card to keep coaching.'],
      '<button type="button" class="esl-btn esl-btn--sm" id="btn-portal-feat-coach">Update payment &rarr;</button>');
  }
  if (doc && doc.features && doc.features.coaching === true) {
    return featureRowHtml('&#9788;', 'Coaching', badge('Granted by ESLabs', 'accent'),
      ['Coaching access granted by Endurance Science Labs. No subscription needed.'], dash);
  }
  return featureRowHtml('&#9788;', 'Coaching', badge('Not subscribed'),
    ['Coaching comes in two plans, Standard Coaching and Full Access, billed monthly or as a 4-month block. Full Access includes esFormLab reports.'],
    linkBtn('/coaching/', 'See coaching plans &rarr;'));
}

// Training Analysis + Injury Patterns (/running-dynamics/): same access as
// the coaching tabs -- a coaching subscription or grant, unless the
// per-athlete Running Dynamics switch is off. Coaches/admin always.
function runDynamicsRow(pass, doc) {
  doc = doc || {};
  var feats = doc.features || {};
  var staff = isCoachMode(doc) || esLabs.isAdmin();
  var hasCoachingAccess = staff || pass.hasCoaching || feats.coaching === true;
  var title = 'Training Analysis &amp; Injury Patterns';
  if (hasCoachingAccess && (staff || feats.runDynamics !== false)) {
    return featureRowHtml('&#8767;', title, badge('Unlocked', 'good'),
      ['Your training load in Impact Adjusted Distance (IAD), and a look back at how your training changed before past setbacks.'],
      linkBtn('/running-dynamics/', 'Training Analysis &rarr;') + linkBtn('/running-dynamics/?view=injury', 'Injury Patterns &rarr;'));
  }
  if (hasCoachingAccess) {
    return featureRowHtml('&#8767;', title, badge('Not included'),
      ['Not part of your current coaching setup. Ask your coach if you&rsquo;d like it turned on.'], '');
  }
  return featureRowHtml('&#8767;', title, badge('Included with coaching'),
    ['Comes with Standard Coaching and Full Access.'], '');
}

function metlabRow(pass) {
  var m = pass.metlab || {};
  var open = linkBtn('/esmetaboliclab/', 'Open esMetabolicLab &rarr;');
  var badges, line;
  if (m.adminGranted) {
    badges = badge('Unlocked', 'good') + ' ' + badge('Granted by ESLabs', 'accent');
    line = 'Upload access granted by Endurance Science Labs.';
  } else if (m.hasLifetime) {
    badges = badge('Lifetime', 'good');
    line = 'Lifetime access &middot; nothing to renew.';
  } else if (m.yearlyActive) {
    badges = badge('Active', 'good');
    line = m.yearlyPeriodEnd
      ? (m.yearlyCancelAtPeriodEnd ? 'Yearly &middot; ends ' + formatDate(m.yearlyPeriodEnd) + ' &mdash; won&rsquo;t renew' : 'Yearly &middot; renews ' + formatDate(m.yearlyPeriodEnd))
      : 'Yearly plan active.';
  } else if (m.source === 'coaching-bundle') {
    badges = badge('Unlocked', 'good') + ' ' + badge('Included with Full Access', 'accent');
    line = 'Included with your Full Access coaching.';
  } else if (m.source === 'single' && m.until) {
    badges = badge('Unlocked', 'good');
    line = '7-day pass &middot; until ' + formatDate(m.until);
  } else {
    badges = badge('Not purchased');
    line = 'Upload your lactate tests with a 7-day pass, a yearly plan or lifetime access.';
    open = linkBtn('/esmetaboliclab/pricing/', 'See pricing &rarr;');
  }
  var inPerson = m.inPersonLatest ? 'In-person lactate test paid ' + formatDate(m.inPersonLatest) + '.' : '';
  return featureRowHtml('&#11041;', 'esMetabolicLab', badges, [line, inPerson], open);
}

function wireFeaturesCard() {
  ['btn-portal', 'btn-portal-feat-coach'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function () {
      if (esLabs.requireNotActing && !esLabs.requireNotActing()) return;
      var origText = b.textContent;
      b.disabled = true;
      b.textContent = 'Opening Stripe…';
      Promise.resolve(esLabs.openCustomerPortal()).catch(function () {
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
  var deletion = '<p class="danger-zone-note">To delete your account and data, email '
    + '<a class="esl-link" href="mailto:' + CONTACT_EMAIL + '">' + CONTACT_EMAIL + '</a> '
    + '(see the <a class="esl-link" href="/privacy/">Privacy policy</a>).</p>';
  if (user.isActingAs) {
    var real = esLabs.realUser;
    return ''
      + '<div class="danger-zone">'
      + '  <span class="danger-zone-text">Acting as <strong>' + esc(user.displayName || user.email || user.uid) + '</strong> &middot; signed in as <strong>' + esc((real && (real.email || real.uid)) || '') + '</strong></span>'
      + '  <div class="danger-zone-actions">'
      + '    <button type="button" class="esl-btn esl-btn--outline esl-btn--sm" id="btn-stop-actas">Stop acting</button>'
      + '    <button type="button" class="esl-btn esl-btn--ghost esl-btn--sm" id="btn-signout">Sign out</button>'
      + '  </div>'
      + '</div>';
  }
  return ''
    + '<div class="danger-zone">'
    + '  <span class="danger-zone-text">Signed in as <strong>' + esc(user.email || user.uid) + '</strong></span>'
    + '  <button type="button" class="esl-btn esl-btn--outline esl-btn--sm" id="btn-signout">Sign out</button>'
    +    deletion
    + '</div>';
}

function wireDangerZone() {
  var btn = document.getElementById('btn-signout');
  if (btn) btn.addEventListener('click', function () { esLabs.signOut(); });
  var stop = document.getElementById('btn-stop-actas');
  if (stop) stop.addEventListener('click', function () { esLabs.stopActAs(); });
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
