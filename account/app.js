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
  userDoc: null,
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

// ──────────────────────────────────────────────────────────────
//  Main render
// ──────────────────────────────────────────────────────────────
function renderApp() {
  var root = document.getElementById('acct-content');
  var user = esLabs.user;
  if (!root || !user || pageState.userDoc === null) return;

  var doc = pageState.userDoc || {};
  var pass = esLabs.getPassState();
  var coachingClient = isCoachingClient(doc, pass);

  if (!pageState.shellRendered) {
    root.innerHTML = ''
      + '<div id="banner-mount"></div>'
      + '<div id="esml-vo2-mount"></div>'
      + profileCardHtml(doc, user.email)
      + trainingCardHtml(doc)
      + prsCardHtml(doc)
      + saveBarHtml()
      + '<div id="features-card-mount"></div>'
      + dangerZoneHtml(user);

    wireProfileCard();
    wireTrainingCard();
    wirePrsCard();
    wireSaveBar();
    wireDangerZone();
    pageState.shellRendered = true;
  }

  // Re-render banner + features on every state change. Form cards
  // keep their in-flight edits.
  var bannerMount = document.getElementById('banner-mount');
  if (bannerMount) bannerMount.innerHTML = bannerHtml(doc, coachingClient);

  applyRequiredMarkers(coachingClient);

  var vo2Mount = document.getElementById('esml-vo2-mount');
  if (vo2Mount) vo2Mount.innerHTML = esmlVo2CardHtml(doc);

  var featMount = document.getElementById('features-card-mount');
  if (featMount) {
    featMount.innerHTML = featuresCardHtml(pass);
    wireFeaturesCard();
  }
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
//   1. Saved Sprint VLamax → lactate-anchored route
//   2. Power Profile session → free / estimated route
//   3. Nothing → empty-state CTA into the free funnel
function esmlVo2CardHtml(doc) {
  var ml = (doc && doc.esmetlab) || {};
  var hasVlamax = !!(ml.vlamax && typeof ml.vlamax.value === 'number');
  var powerProfiles = Array.isArray(ml.powerProfiles) ? ml.powerProfiles : [];
  var latestPP = powerProfiles.length ? powerProfiles[powerProfiles.length - 1] : null;

  // State 1: lactate-anchored (Sprint VLamax exists).
  if (hasVlamax) {
    var vlamax = ml.vlamax.value;
    var measuredSec = tsToSec(ml.vlamax.measured_at);
    var dateStr = measuredSec ? formatDate(measuredSec) : '';
    var altCta = latestPP
      ? '<a class="vo2-alt" href="/esmetaboliclab/power-profile/">Power Profile →</a>'
      : '';
    return ''
      + '<section class="acct-card vo2-card vo2-card-lactate">'
      + '  <div class="vo2-card-head">'
      + '    <h2><span class="vo2-card-glyph">⬡</span> My ESLabs metabolic profile</h2>'
      + '    <span class="vo2-card-tag tag-lactate">Lactate-anchored</span>'
      + '  </div>'
      + '  <div class="vo2-card-stats">'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VLamax</div>'
      + '      <div class="vo2-stat-value">' + vlamax.toFixed(3) + ' <span class="vo2-stat-unit">mmol/L/s</span></div>'
      + '      <div class="vo2-stat-note">Measured from your Sprint VLamax Test</div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="vo2-meta">'
      + (dateStr ? '<span>Saved ' + esc(dateStr) + '</span>' : '')
      + '    <span>·</span>'
      + '    <span>Source: <strong>Sprint VLamax Test</strong></span>'
      + '  </div>'
      + '  <p class="vo2-card-msg">'
      + '    Run the full Lactate Step Test to anchor your VO₂max, MLSS, LT1, Fatmax, and training zones to your real lactate curve.'
      + '  </p>'
      + '  <div class="vo2-card-cta">'
      + '    <a class="btn-primary" href="/esmetaboliclab/profile/">Open Lactate Step Test →</a>'
      +      altCta
      + '  </div>'
      + '</section>';
  }

  // State 2: power-only profile (estimate).
  if (latestPP && latestPP.derived && typeof latestPP.derived.VO2max === 'number') {
    var d = latestPP.derived;
    var ppSec = tsToSec(latestPP.measured_at);
    var ppDate = ppSec ? formatDate(ppSec) : '';
    var sport = (latestPP.inputs && latestPP.inputs.sport) || '';
    var sportLabel = sport === 'cycling' ? 'Cycling' : (sport === 'running' ? 'Running' : '');
    return ''
      + '<section class="acct-card vo2-card vo2-card-power">'
      + '  <div class="vo2-card-head">'
      + '    <h2><span class="vo2-card-glyph">⬡</span> My ESLabs metabolic profile</h2>'
      + '    <span class="vo2-card-tag tag-estimate">Estimate</span>'
      + '  </div>'
      + '  <div class="vo2-card-stats">'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VO₂max</div>'
      + '      <div class="vo2-stat-value">' + d.VO2max.toFixed(1) + ' <span class="vo2-stat-unit">mL/min/kg</span></div>'
      + '    </div>'
      + '    <div class="vo2-stat">'
      + '      <div class="vo2-stat-label">VLamax</div>'
      + '      <div class="vo2-stat-value">' + d.VLamax.toFixed(3) + ' <span class="vo2-stat-unit">mmol/L/s</span></div>'
      + '      <div class="vo2-stat-note">Back-derived from sprint power</div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="vo2-meta">'
      + (ppDate ? '<span>Saved ' + esc(ppDate) + '</span><span>·</span>' : '')
      + '    <span>Source: <strong>Power Profile</strong>' + (sportLabel ? ' · ' + esc(sportLabel) : '') + '</span>'
      + '  </div>'
      + '  <p class="vo2-card-msg">'
      + '    This is an estimate. For lactate-anchored precision, run the Sprint VLamax Test — or upgrade with <a href="/coaching/">Premium Coaching</a>.'
      + '  </p>'
      + '  <div class="vo2-card-cta">'
      + '    <a class="btn-primary" href="/esmetaboliclab/power-profile/">View full profile →</a>'
      + '    <a class="vo2-alt" href="/esmetaboliclab/pricing/">See pricing →</a>'
      + '  </div>'
      + '</section>';
  }

  // State 3: nothing saved yet.
  return ''
    + '<section class="acct-card vo2-card vo2-card-empty">'
    + '  <div class="vo2-card-head">'
    + '    <h2><span class="vo2-card-glyph">⬡</span> My ESLabs metabolic profile</h2>'
    + '  </div>'
    + '  <p class="vo2-card-msg">'
    + '    Build your VO₂max, lactate threshold, training zones, and fueling profile — free in your browser, no equipment, in about 30 minutes.'
    + '  </p>'
    + '  <div class="vo2-card-cta">'
    + '    <a class="btn-primary" href="/esmetaboliclab/power-profile/">Build your free profile →</a>'
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
  return ''
    + '<div class="coach-banner">'
    + '  <div class="coach-banner-icon">&#9888;</div>'
    + '  <div class="coach-banner-body">'
    + '    <div class="coach-banner-title">Required for your coach</div>'
    + '    <div class="coach-banner-text">Please complete the fields marked <span class="req-star">*</span> below so your coach can train you effectively.</div>'
    + '  </div>'
    + '</div>';
}

function applyRequiredMarkers(coachingClient) {
  document.querySelectorAll('[data-required]').forEach(function (el) {
    el.style.display = coachingClient ? 'inline' : 'none';
  });
}

// ──────────────────────────────────────────────────────────────
//  Profile card
// ──────────────────────────────────────────────────────────────
function profileCardHtml(doc, email) {
  var displayName = doc.displayName || (esLabs.user && esLabs.user.displayName) || '';
  var gender = (doc.gender === 'male' || doc.gender === 'female') ? doc.gender : '';
  var dob = doc.dob || '';
  return ''
    + '<section class="acct-card">'
    + '  <h2>Profile</h2>'
    + '  <p class="card-sub">Your name appears on saved sessions. Date of birth and gender personalize how reference ranges grade your gait analysis.</p>'
    + '  <div class="field-grid">'
    + '    <div class="field">'
    + '      <span class="field-label">Name<span class="req-star" data-required>*</span></span>'
    + '      <input id="f-name" class="field-input" type="text" maxlength="80" value="' + esc(displayName) + '" placeholder="Your name">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Email</span>'
    + '      <div class="field-static">' + esc(email) + ' <span class="lock-pill">Read-only</span></div>'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Date of birth<span class="req-star" data-required>*</span></span>'
    + '      <input id="f-dob" class="field-input" type="date" value="' + esc(dob) + '" max="' + todayIso() + '">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Gender<span class="req-star" data-required>*</span></span>'
    + '      <div class="radio-row" id="f-gender">'
    + '        <label class="radio-pill' + (gender === 'male' ? ' checked' : '') + '" data-val="male"><input type="radio" name="acct-gender" value="male"' + (gender === 'male' ? ' checked' : '') + '><span>&#9794; Male</span></label>'
    + '        <label class="radio-pill' + (gender === 'female' ? ' checked' : '') + '" data-val="female"><input type="radio" name="acct-gender" value="female"' + (gender === 'female' ? ' checked' : '') + '><span>&#9792; Female</span></label>'
    + '      </div>'
    + '    </div>'
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
}

// ──────────────────────────────────────────────────────────────
//  Training profile card
// ──────────────────────────────────────────────────────────────
function trainingCardHtml(doc) {
  var years = (doc.runningYears !== undefined && doc.runningYears !== null) ? String(doc.runningYears) : '';
  var miles = (doc.weeklyMiles !== undefined && doc.weeklyMiles !== null) ? String(doc.weeklyMiles) : '';
  var goals = doc.goals || '';
  var injuries = doc.injuryHistory || '';
  return ''
    + '<section class="acct-card">'
    + '  <h2>Training profile</h2>'
    + '  <p class="card-sub">Background your coach uses to tailor your plan. Leave anything blank if it doesn&rsquo;t apply.</p>'
    + '  <div class="field-grid">'
    + '    <div class="field">'
    + '      <span class="field-label">Years running<span class="req-star" data-required>*</span></span>'
    + '      <input id="f-years" class="field-input" type="number" min="0" max="80" step="0.5" value="' + esc(years) + '" placeholder="e.g. 3">'
    + '    </div>'
    + '    <div class="field">'
    + '      <span class="field-label">Typical miles per week<span class="req-star" data-required>*</span></span>'
    + '      <input id="f-miles" class="field-input" type="number" min="0" max="300" step="1" value="' + esc(miles) + '" placeholder="e.g. 30">'
    + '    </div>'
    + '  </div>'
    + '  <div class="field" style="margin-top:16px">'
    + '    <span class="field-label">Goals<span class="req-star" data-required>*</span></span>'
    + '    <textarea id="f-goals" class="field-input field-textarea" rows="3" maxlength="600" placeholder="What are you training for? Specific races, time goals, distances, life-goals (“finish my first marathon”), etc.">' + esc(goals) + '</textarea>'
    + '  </div>'
    + '  <div class="field" style="margin-top:14px">'
    + '    <span class="field-label">Injury history <span class="field-label-hint">(optional)</span></span>'
    + '    <textarea id="f-injuries" class="field-input field-textarea" rows="3" maxlength="800" placeholder="Recent or recurring injuries your coach should know about. Leave blank if none.">' + esc(injuries) + '</textarea>'
    + '  </div>'
    + '</section>';
}

function wireTrainingCard() {
  // Nothing reactive yet -- values are read at save time.
}

// ──────────────────────────────────────────────────────────────
//  Personal records card
// ──────────────────────────────────────────────────────────────
function prsCardHtml(doc) {
  var prs = normalizePrs(doc.prs);
  return ''
    + '<section class="acct-card">'
    + '  <h2>Personal records</h2>'
    + '  <p class="card-sub">Your current PR at each distance. Add a date if you remember it. One PR per distance &mdash; updating is replacing.</p>'
    + '  <div id="prs-list" class="prs-list">'
    +      prs.map(function (pr) { return prRowHtml(pr); }).join('')
    + '  </div>'
    + '  <button type="button" class="btn-add-pr" id="btn-add-pr">+ Add PR</button>'
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
    + '  <input type="text" class="field-input pr-time" placeholder="e.g. 18:30 or 1:23:45" value="' + esc(time) + '" data-pr-time>'
    + '  <select class="field-input pr-distance" data-pr-distance>' + optsHtml + '</select>'
    + '  <input type="date" class="field-input pr-date" value="' + esc(date) + '" max="' + todayIso() + '" data-pr-date title="Date set (optional)">'
    + '  <button type="button" class="pr-remove" data-pr-remove title="Remove">&times;</button>'
    + '</div>';
}

function wirePrsCard() {
  document.getElementById('btn-add-pr').addEventListener('click', addPrRow);
  document.getElementById('prs-list').addEventListener('click', function (e) {
    var t = e.target.closest('[data-pr-remove]');
    if (t) {
      var row = t.closest('[data-pr-row]');
      if (row) row.parentNode.removeChild(row);
      refreshAddPrButton();
    }
  });
  refreshAddPrButton();
}

function addPrRow() {
  var list = document.getElementById('prs-list');
  var wrap = document.createElement('div');
  wrap.innerHTML = prRowHtml({ distance: '', time: '', date: '' });
  list.appendChild(wrap.firstElementChild);
  refreshAddPrButton();
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
//  Unified save bar
// ──────────────────────────────────────────────────────────────
function saveBarHtml() {
  return ''
    + '<div class="save-bar">'
    + '  <span class="save-status" id="save-status"></span>'
    + '  <button class="btn-primary" id="btn-save-profile">Save changes</button>'
    + '</div>';
}

function wireSaveBar() {
  document.getElementById('btn-save-profile').addEventListener('click', saveAll);
}

function saveAll() {
  var btn = document.getElementById('btn-save-profile');
  var user = esLabs.user;
  if (!user) return;

  var name = (document.getElementById('f-name').value || '').trim();
  var dob = (document.getElementById('f-dob').value || '').trim();
  var genderInput = document.querySelector('#f-gender input[name="acct-gender"]:checked');
  var gender = genderInput ? genderInput.value : '';
  var yearsRaw = (document.getElementById('f-years').value || '').trim();
  var milesRaw = (document.getElementById('f-miles').value || '').trim();
  var goals = (document.getElementById('f-goals').value || '').trim();
  var injuries = (document.getElementById('f-injuries').value || '').trim();

  if (dob) {
    if (isNaN(Date.parse(dob))) { setStatus('That date of birth does not look valid.', 'error'); return; }
    if (new Date(dob + 'T00:00:00').getTime() > Date.now()) {
      setStatus('Date of birth cannot be in the future.', 'error');
      return;
    }
  }
  if (yearsRaw && (isNaN(Number(yearsRaw)) || Number(yearsRaw) < 0 || Number(yearsRaw) > 80)) {
    setStatus('Years running should be a number between 0 and 80.', 'error');
    return;
  }
  if (milesRaw && (isNaN(Number(milesRaw)) || Number(milesRaw) < 0 || Number(milesRaw) > 300)) {
    setStatus('Typical miles per week should be a number between 0 and 300.', 'error');
    return;
  }

  // PRs: collect rows, dedupe by distance (last entry wins), drop rows with no time or no distance.
  var prsMap = {};
  document.querySelectorAll('#prs-list .pr-row').forEach(function (row) {
    var d = row.querySelector('[data-pr-distance]').value;
    var t = (row.querySelector('[data-pr-time]').value || '').trim();
    var dt = (row.querySelector('[data-pr-date]').value || '').trim();
    if (!d || !t) return;
    prsMap[d] = { time: t };
    if (dt) prsMap[d].date = dt;
  });

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
    goals: goals || del,
    injuryHistory: injuries || del,
    prs: Object.keys(prsMap).length ? prsMap : del,
    updatedAt: fb.firestore.FieldValue.serverTimestamp()
  };

  esLabs.db.collection('users').doc(user.uid).set(payload, { merge: true })
    .then(function () {
      if (name && user.displayName !== name) return user.updateProfile({ displayName: name });
    })
    .then(function () { setStatus('Saved.', 'success'); })
    .catch(function (e) {
      console.error('saveAll error:', e);
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
//  Features + billing card  (unchanged from previous version)
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
  } else if (pass.hasStandardCoach) {
    badge = '<span class="badge unlocked">Active</span>';
    line = 'Coaching subscription active.';
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
