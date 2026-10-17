/*
 * Profile controller: stitches the wizard UI to the Mader engine.
 *
 *   - 4-step wizard: Athlete → Sprint VLamax → Step test → Results.
 *     Sprint VLamax is collected inline (was a separate page). Saved values
 *     load from users/{uid}.esmetlab.vlamax as defaults; the user can keep
 *     them or re-measure.
 *   - on "Run profile", calls getMetabolicProfile(...) and renders results.
 *   - Plotly for charts, jsPDF for export.
 */

import { getMetabolicProfile } from '../js/lib/mader/index.js';
import { computeVLamax } from '../js/lib/mader/sprint.js';
import { altitudeFactor } from '../js/lib/mader/constants.js';
import { generateZones } from '../js/ui/zones.js';
import { minPerKmToPaceString, paceStringToMinPerKm, speedToPaceString } from '../js/lib/mader/sport.js';
import { paceInputHTML, wirePaceInputs, readPaceMps, getDefaultPaceUnit, setDefaultPaceUnit, mpsToPaceString } from '../js/ui/pace-input.js';
import { wireHowToMeasureTriggers } from '../js/ui/how-to-measure.js';
import { wireStepTestTriggers }    from '../js/ui/how-to-step-test.js';
import { wireSprintProtocolTriggers } from '../js/ui/how-to-sprint-test.js';
import { drawLactateChart, drawSubstrateChart, redrawAllCharts } from '../js/ui/charts.js';
import { downloadStepTestReport } from '../js/ui/pdf-report.js';
import { profileGuideHtml } from '../js/ui/profile-guide.js';
import { showConfirmModal } from '../js/ui/confirm-modal.js';

// Saved sessions come from the user's own doc, and the admin renders them
// too when acting as that user -- escape before putting them in markup.
function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Wire the page-level protocol buttons.
wireHowToMeasureTriggers();
wireStepTestTriggers();
wireSprintProtocolTriggers();

// Charts read the theme tokens; recolour them when the theme flips.
if (window.esLabs && esLabs.onThemeChange) esLabs.onThemeChange(() => redrawAllCharts());

const $   = (sel) => document.querySelector(sel);
const $$  = (sel) => Array.from(document.querySelectorAll(sel));
const fmt = {
  W:   (v) => v.toFixed(0) + ' W',
  V:   (v) => v.toFixed(1) + ' mL/min/kg',
  La:  (v) => v.toFixed(2) + ' mmol/L',
  G:   (v) => v.toFixed(2) + ' g/min',
  pct: (v) => (v * 100).toFixed(1) + '%',
  ms:  (v) => v.toFixed(2) + ' m/s',
  pace:(v) => speedToPaceString(v, getDefaultPaceUnit()),
};

/* Mass unit handling — canonical storage is kg; display unit (lb | kg) is
   per-user in localStorage, shared with the power-profile tool. */
const LB_PER_KG = 2.2046226218;
function getMassUnit() {
  try { return localStorage.getItem('esml-mass-unit') === 'lb' ? 'lb' : 'kg'; }
  catch (e) { return 'kg'; }
}
function setMassUnit(u) {
  try { if (u === 'lb' || u === 'kg') localStorage.setItem('esml-mass-unit', u); }
  catch (e) { /* private mode — fine */ }
}
function kgToDisplay(kg, unit) {
  if (!isFinite(kg)) return '';
  return unit === 'lb' ? Math.round(kg * LB_PER_KG * 10) / 10 : Math.round(kg * 10) / 10;
}
function displayToKg(val, unit) {
  const v = String(val).trim() === '' ? NaN : parseFloat(val);
  if (!isFinite(v)) return NaN;
  return unit === 'lb' ? v / LB_PER_KG : v;
}

/* Altitude unit handling — canonical storage is metres; display unit (m | ft)
   is per-user in localStorage, shared with the power-profile tool. */
const FT_PER_M = 3.2808398950;
function getAltUnit() {
  try { return localStorage.getItem('esml-alt-unit') === 'ft' ? 'ft' : 'm'; }
  catch (e) { return 'm'; }
}
function setAltUnit(u) {
  try { if (u === 'ft' || u === 'm') localStorage.setItem('esml-alt-unit', u); }
  catch (e) { /* private mode — fine */ }
}
function mToDisplay(m, unit) {
  if (!isFinite(m)) return 0;
  return unit === 'ft' ? Math.round(m * FT_PER_M) : Math.round(m);
}
function displayToM(val, unit) {
  const v = parseFloat(val);
  if (!isFinite(v)) return 0;
  return unit === 'ft' ? v / FT_PER_M : v;
}

/* ───────── State ───────── */

const state = {
  step: 1,
  sex: 'M',
  sport: 'running',
  bodyMass: 70,
  altitude_m: 0,          // testing altitude; running paces corrected to sea level above 800 m
  VLamax: null,           // set after Firestore load
  VLamax_measured_at: null,
  VLamax_inputs: null,    // {La_pre, La_peak_post, duration_s, t_PCr_s}
  // A new test starts empty: the example readings below are shown as
  // placeholders only (5-min stages are the protocol, so that stays filled).
  stages: [0, 1, 2, 3, 4].map(() => ({ intensity: NaN, durationMin: 5, lactate: NaN, hr: '' })),
  profile: null,
  sessions: [],            // saved lactate tests, newest-last
  activeSessionId: null,   // test currently being viewed/edited; re-running updates it
};

// Pristine copy of the default stages, used to reset for a brand-new test.
const DEFAULT_STAGES = state.stages.map((s) => Object.assign({}, s));
// Example readings (placeholders): running 8:00 → 6:00 /mi, cycling 150 → 270 W.
const EX_MPS = [3.35, 3.58, 3.83, 4.13, 4.47];
const EX_W   = [150, 180, 210, 240, 270];
const EX_LA  = [1.4, 2.0, 3.0, 4.5, 7.5];
const readOnly = () => !!(window.__esml && window.__esml.readOnly);
const PRICING_FROM = '/esmetaboliclab/pricing/?from=lactate';

/* ───────── Helpers ───────── */

// "62.4 mL/min/kg" -> ["62.4","mL/min/kg"]; "6:51/mi" -> ["6:51","/mi"]; "245 W" -> ["245","W"]
function splitValUnit(s) { const m = String(s).match(/^([\d.:,–-]+)\s*(.*)$/); return m ? [m[1], m[2]] : [s, '']; }
function metricValueHtml(v) {
  const [num, unit] = splitValUnit(v);
  return '<div class="metric-value">' + num + (unit ? '<span class="metric-unit">' + unit + '</span>' : '') + '</div>';
}

function fmtDate(ts) {
  if (!ts) return '—';
  let d;
  if (ts.toDate) d = ts.toDate();
  else d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ───────── Step 2: sprint VLamax (inline, replaces the old separate page) ───────── */

// Default sprint inputs if the user has never run one. Sane mid-range starting values.
const DEFAULT_VL_INPUTS = { La_pre: 1.4, La_peak_post: 11.0, duration_s: 15, t_PCr_s: 3.5 };   // examples (placeholders)
const EMPTY_VL_INPUTS = { La_pre: '', La_peak_post: '', duration_s: 15, t_PCr_s: 3.5 };

function renderVLamaxStep() {
  const body = $('#vlamax-step-body');
  if (!body) return;
  const inp = state.VLamax_inputs || EMPTY_VL_INPUTS;
  const hasSaved = typeof state.VLamax === 'number';

  // One VLamax on screen (the live result below); a saved sprint is a note.
  const savedNote = hasSaved
    ? '<p class="vlc-note">Pre-filled from your test on ' + fmtDate(state.VLamax_measured_at) +
      ' (VLamax ' + state.VLamax.toFixed(3) + ' mmol·L⁻¹·s⁻¹). Keep these values, or enter a new sprint — it saves with this step test.</p>'
    : '';

  body.innerHTML =
    savedNote +
    '<div class="grid-3">' +
      '<label class="field"><span class="lab">Pre-sprint La (mmol/L)</span>' +
        '<input type="number" id="vlc-la-pre" step="0.1" min="0" max="5" placeholder="' + DEFAULT_VL_INPUTS.La_pre + '" value="' + escAttr(inp.La_pre) + '"></label>' +
      '<label class="field"><span class="lab">Peak post-sprint La (mmol/L)</span>' +
        '<input type="number" id="vlc-la-post" step="0.1" min="2" max="30" placeholder="' + DEFAULT_VL_INPUTS.La_peak_post.toFixed(1) + '" value="' + escAttr(inp.La_peak_post) + '"></label>' +
      '<label class="field"><span class="lab">Sprint duration (s)</span>' +
        '<input type="number" id="vlc-dur" step="1" min="10" max="30" value="' + escAttr(inp.duration_s) + '"></label>' +
    '</div>' +
    '<div class="vlc-result" id="vlc-result"></div>';

  ['vlc-la-pre','vlc-la-post','vlc-dur'].forEach(id =>
    $('#' + id).addEventListener('input', recalcLive)
  );
  recalcLive();
}

// Blank or unparseable input is missing (NaN), never 0.
const numOrNaN = (v) => (String(v).trim() === '' ? NaN : +v);

function readVLamaxInputs() {
  return {
    La_pre:        numOrNaN($('#vlc-la-pre').value),
    La_peak_post:  numOrNaN($('#vlc-la-post').value),
    duration_s:    numOrNaN($('#vlc-dur').value),
    t_PCr_s:       DEFAULT_VL_INPUTS.t_PCr_s,   // fixed alactic time (3.5 s); not user-adjustable
  };
}

function recalcLive() {
  const inputs = readVLamaxInputs();
  ['vlc-la-pre', 'vlc-la-post', 'vlc-dur'].forEach((id) => { const el = $('#' + id); if (el) el.removeAttribute('aria-invalid'); });
  if (![inputs.La_pre, inputs.La_peak_post, inputs.duration_s].every(isFinite)) {
    $('#vlc-result').innerHTML = '<div class="vlc-result-empty">Enter all three sprint values to compute.</div>';
    return;
  }
  const r = computeVLamax(inputs);
  const bad = (r.errors && r.errors.length) || !isFinite(r.VLamax) || !(r.glycolytic_time_s > 0) || r.VLamax < 0;
  const errList = (r.errors && r.errors.length) ? r.errors : (bad ? ['These sprint values don’t produce a valid VLamax — recheck them.'] : []);
  const errHtml = errList.length
    ? '<div class="esl-callout esl-callout--bad" role="alert" style="margin-top:10px">✕ ' + errList.join('<br>✕ ') + '</div>'
    : '';
  const warnHtml = r.warnings.length
    ? '<div style="font-size:12px;color:var(--warn-ink);margin-top:6px">⚠ ' + r.warnings.join(' ') + '</div>'
    : '';
  $('#vlc-result').innerHTML =
    '<div class="vlc-result-box">' +
      '<div class="vlc-result-label">Your VLamax</div>' +
      (bad
        ? '<div class="vlc-result-val"><span class="is-na">–</span></div>'
        : '<div class="vlc-result-val">' + r.VLamax.toFixed(3) + ' <span class="vlc-unit">mmol·L⁻¹·s⁻¹</span></div>') +
      errHtml +
      warnHtml +
    '</div>';
}

// Advance from the sprint step. VLamax is part of the session and is persisted
// together with the step test on "Run" (autoSaveSession) — so this just
// validates the sprint, captures it into state, and moves on. No standalone
// write. If the sprint inputs changed from what was loaded, stamp a fresh
// measurement date for this test.
function continueFromVLamax() {
  const inputs = readVLamaxInputs();
  const ids = { La_pre: 'vlc-la-pre', La_peak_post: 'vlc-la-post', duration_s: 'vlc-dur' };
  const r = [inputs.La_pre, inputs.La_peak_post, inputs.duration_s].every(isFinite) ? computeVLamax(inputs) : null;
  if (!r || !isFinite(r.VLamax) || !(r.glycolytic_time_s > 0) || r.VLamax < 0 || (r.errors && r.errors.length)) {
    recalcLive();
    // Missing values are the invalid ones; otherwise flag all three (the
    // engine's error names the relationship, e.g. post below pre).
    let invalid = Object.keys(ids).filter((k) => !isFinite(inputs[k]));
    if (!invalid.length) invalid = Object.keys(ids);
    invalid.forEach((k) => $('#' + ids[k]).setAttribute('aria-invalid', 'true'));
    const res = $('#vlc-result');
    if (res) res.insertAdjacentHTML('beforeend', '<p class="esl-field-error" role="alert">Fix the sprint values above to continue.</p>');
    $('#' + ids[invalid[0]]).focus();
    return;
  }

  const sameAsBefore = state.VLamax_inputs
    && state.VLamax_inputs.La_pre       === inputs.La_pre
    && state.VLamax_inputs.La_peak_post === inputs.La_peak_post
    && state.VLamax_inputs.duration_s   === inputs.duration_s
    && state.VLamax_inputs.t_PCr_s      === inputs.t_PCr_s;
  if (!sameAsBefore) {
    state.VLamax_inputs = inputs;
    state.VLamax_measured_at = new Date();   // freshly measured for this test
  }
  state.VLamax = r.VLamax;
  gotoStep(3);
}

async function loadVLamax(user) {
  try {
    const db = firebase.firestore();
    const doc = await db.collection('users').doc(user.uid).get();
    const data = doc.exists ? doc.data() : null;
    const esml = (data && data.esmetlab) || {};
    state.sessions = Array.isArray(esml.lactateSessions) ? esml.lactateSessions.slice() : [];
    // VLamax default for a NEW test: carry over the most recent saved session's
    // sprint (VLamax + step test are one session). Fall back to a legacy
    // standalone VLamax doc for accounts created before sessions existed.
    if (!applyLatestSessionVLamax() && esml.vlamax && typeof esml.vlamax.value === 'number') {
      state.VLamax = esml.vlamax.value;
      state.VLamax_inputs = esml.vlamax.inputs || null;
      state.VLamax_measured_at = esml.vlamax.measured_at || null;
    }
    prefillAthlete(data);
  } catch (e) {
    console.error('Failed to load saved tests:', e);
  }
  renderVLamaxStep();
  renderSavedTests();
}

// Prefill sex / mass / sport for a new test once: latest saved test first,
// then the account profile (gender, weightLb). Never over a loaded test.
function prefillAthlete(doc) {
  if (state.prefilled || state.activeSessionId) return;
  state.prefilled = true;
  const latest = state.sessions[state.sessions.length - 1];
  const li = latest && latest.inputs;
  const d = doc || {};
  const sex = li && li.sex ? li.sex : (d.gender === 'female' ? 'F' : d.gender === 'male' ? 'M' : null);
  const kg = li && li.bodyMass > 0 ? li.bodyMass : (d.weightLb > 0 ? d.weightLb / LB_PER_KG : null);
  const sport = li && li.sport ? li.sport : null;
  if (sex) state.sex = sex;
  if (kg) state.bodyMass = Math.round(kg * 10) / 10;
  if (sport && sport !== state.sport) {
    state.sport = sport;
    if (sport === 'cycling') state.stages.forEach((st) => { st.intensity = NaN; });
  }
  syncInputsToUI();
}

// Lapsed upload access with saved tests: the paywall shows the app read-only.
window.addEventListener('esml-readonly', () => { renderSavedTests(); syncRunLabel(); });

window.addEventListener('esml-auth', (ev) => loadVLamax(ev.detail.user));
if (window.__esml && window.__esml.user) loadVLamax(window.__esml.user);
// Render the Step 2 form immediately with defaults so it's wired before
// auth resolves; loadVLamax will re-render with any saved values.
renderVLamaxStep();

const vlamaxNextBtn = $('#vlamax-next');
if (vlamaxNextBtn) vlamaxNextBtn.addEventListener('click', continueFromVLamax);

/* ───────── Step navigation ───────── */

function gotoStep(n) {
  state.step = n;
  $$('.step-section').forEach(el => el.classList.toggle('active', +el.dataset.step === n));
  for (let i = 1; i <= 4; i++) {
    const bar = document.getElementById('step-bar-' + i);
    if (!bar) continue;
    bar.classList.toggle('active', i === n);
    bar.classList.toggle('done',   i < n);
    if (i === n) bar.setAttribute('aria-current', 'step'); else bar.removeAttribute('aria-current');
  }
  if (n === 3) syncRunLabel();
  syncWizardChrome();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wiz = document.getElementById('wizard');
  if (wiz) wiz.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

// Re-running a loaded test updates it — say so on the Run button.
function syncRunLabel() {
  const run = $('#run');
  const note = $('#run-note');
  const runNew = $('#run-new');
  const s = state.activeSessionId && state.sessions.find((x) => x.id === state.activeSessionId);
  if (readOnly()) {
    if (run) run.textContent = 'See plans to run →';
    if (runNew) runNew.hidden = true;
    if (note) { note.hidden = false; note.textContent = 'Running or updating a test needs upload access. Your saved tests stay viewable.'; }
    return;
  }
  if (run) run.textContent = s ? 'Update this test →' : 'Run profile →';
  if (runNew) runNew.hidden = !s;
  if (note) {
    note.hidden = !s;
    note.textContent = s ? 'Re-running updates your test from ' + fmtDate(s.measured_at) + ' — or save it as a new test.' : '';
  }
}

// Wizard extras: completed steps are links back; a "Saved tests (N)" chip
// on steps 2–4 jumps to the list on step 1.
function syncWizardChrome() {
  for (let i = 1; i <= 4; i++) {
    const bar = document.getElementById('step-bar-' + i);
    if (!bar) continue;
    const lbl = bar.querySelector('.s-lbl');
    const text = lbl ? lbl.textContent : '';
    const want = i < state.step ? 'button' : 'span';
    if (lbl && lbl.tagName.toLowerCase() !== want) {
      bar.innerHTML = want === 'button'
        ? '<button type="button" class="s-lbl" data-step-jump="' + i + '">' + text + '</button>'
        : '<span class="s-lbl">' + text + '</span>';
    }
  }
  const chip = document.getElementById('saved-chip');
  if (chip) {
    const n = state.sessions.length;
    chip.hidden = !(n > 0 && state.step > 1);
    chip.textContent = 'Saved tests (' + n + ')';
  }
}
document.querySelector('.stepper').addEventListener('click', (e) => {
  const b = e.target.closest('[data-step-jump]');
  if (b) gotoStep(+b.dataset.stepJump);
});
const savedChip = document.getElementById('saved-chip');
if (savedChip) savedChip.addEventListener('click', () => gotoStep(1));

// Step 1 → 2 needs a usable body mass (30–160 kg).
function validateBodyMass() {
  const bm = $('#bodyMass');
  const ok = state.bodyMass >= 30 && state.bodyMass <= 160;
  let err = document.getElementById('bodyMass-err');
  if (ok) {
    if (err) err.remove();
    if (bm) { bm.removeAttribute('aria-invalid'); bm.removeAttribute('aria-describedby'); }
    return true;
  }
  if (!err && bm) {
    err = document.createElement('p');
    err.className = 'esl-field-error';
    err.id = 'bodyMass-err';
    err.setAttribute('role', 'alert');
    err.textContent = getMassUnit() === 'lb'
      ? 'Enter your body mass (' + Math.round(30 * LB_PER_KG) + '–' + Math.round(160 * LB_PER_KG) + ' lb).'
      : 'Enter your body mass (30–160 kg).';
    bm.closest('.field').appendChild(err);
  }
  if (bm) { bm.setAttribute('aria-invalid', 'true'); bm.setAttribute('aria-describedby', 'bodyMass-err'); bm.focus(); }
  return false;
}

$$('[data-go]').forEach(btn => btn.addEventListener('click', () => {
  const to = +btn.dataset.go;
  if (to === 2 && state.step === 1 && !validateBodyMass()) return;
  gotoStep(to);
}));

/* ───────── Step 1: athlete bindings ───────── */

document.querySelectorAll('input[name=sex]').forEach(r => r.addEventListener('change', e => state.sex = e.target.value));
// The step-test guide opens on the athlete's sport.
function syncStepTestSport() {
  document.querySelectorAll('[data-howto-step-test]').forEach((b) => { b.dataset.stepTestSport = state.sport; });
}
syncStepTestSport();
document.querySelectorAll('input[name=sport]').forEach(r => r.addEventListener('change', e => {
  state.sport = e.target.value;
  // Pace (m/s) and power (W) aren't interchangeable: clear stage intensities.
  const had = state.stages.some((s) => isFinite(s.intensity) && s.intensity > 0);
  state.stages.forEach((s) => { s.intensity = NaN; });
  state.sportClearedNote = had;
  syncStepTestSport();
  renderIntensityHeader();
  toggleAltitudeField();
  renderStages();
}));
$('#bodyMass').addEventListener('input', e => {
  state.bodyMass = String(e.target.value).trim() === '' ? NaN : displayToKg(e.target.value, getMassUnit());
  if (document.getElementById('bodyMass-err')) validateBodyMass();
});

// Body-mass unit toggle (lb | kg) — converts in place; state.bodyMass stays kg.
function syncMassUnitUI() {
  const unit = getMassUnit();
  const bm = $('#bodyMass');
  if (bm) {
    bm.min = unit === 'lb' ? Math.round(30 * LB_PER_KG) : 30;
    bm.max = unit === 'lb' ? Math.round(160 * LB_PER_KG) : 160;
    bm.value = kgToDisplay(state.bodyMass, unit);
  }
  document.querySelectorAll('[data-mass-toggle] button').forEach((b) => {
    b.classList.toggle('active', b.dataset.massUnit === unit);
    b.setAttribute('aria-pressed', String(b.dataset.massUnit === unit));
  });
}
document.querySelectorAll('[data-mass-toggle] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const newUnit = btn.dataset.massUnit;
    if (newUnit === getMassUnit()) return;
    setMassUnit(newUnit);
    syncMassUnitUI();
  });
});
syncMassUnitUI();

const altInput = document.getElementById('altitude');
if (altInput) altInput.addEventListener('input', () => {
  const m = displayToM(altInput.value, getAltUnit());
  state.altitude_m = (isFinite(m) && m > 0) ? m : 0;
});

// Altitude unit toggle (ft | m) — same pattern as the power profile.
document.querySelectorAll('[data-alt-toggle] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const newUnit = btn.dataset.altUnit;
    const oldUnit = getAltUnit();
    if (newUnit === oldUnit) return;
    if (altInput) {
      const m = displayToM(altInput.value, oldUnit);   // state.altitude_m unchanged
      altInput.value = m > 0 ? String(mToDisplay(m, newUnit)) : '';
      altInput.step = newUnit === 'ft' ? 100 : 50;
      altInput.max  = newUnit === 'ft' ? Math.round(5000 * FT_PER_M) : 5000;
    }
    setAltUnit(newUnit);
    btn.parentElement.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
  });
});

// Reflect the current altitude (canonical metres) + unit into the input/pills.
function syncAltitudeUnitUI() {
  const unit = getAltUnit();
  if (altInput) {
    altInput.step = unit === 'ft' ? 100 : 50;
    altInput.max  = unit === 'ft' ? Math.round(5000 * FT_PER_M) : 5000;
    altInput.value = state.altitude_m > 0 ? String(mToDisplay(state.altitude_m, unit)) : '';
  }
  document.querySelectorAll('[data-alt-toggle] button').forEach((b) => {
    b.classList.toggle('active', b.dataset.altUnit === unit);
    b.setAttribute('aria-pressed', String(b.dataset.altUnit === unit));
  });
}
syncAltitudeUnitUI();

function renderIntensityHeader() {
  const h = document.getElementById('intensity-header');
  if (h) h.textContent = state.sport === 'cycling' ? 'Power (W)' : 'Pace';
}
renderIntensityHeader();

// Altitude correction only applies to running paces (cycling power is
// altitude-neutral), so hide the field for cycling.
function toggleAltitudeField() {
  const f = document.getElementById('altitude-field');
  if (f) f.style.display = state.sport === 'running' ? '' : 'none';
}
toggleAltitudeField();

/* ───────── Step 2: stages table ───────── */

const stagesBody = $('#stages-body');

function intensityPlaceholder(i) {
  if (state.sport === 'cycling') return String(EX_W[i] != null ? EX_W[i] : 270 + 30 * (i - 4));
  const v = EX_MPS[i] != null ? EX_MPS[i] : 4.47 + 0.3 * (i - 4);
  return mpsToPaceString(v, getDefaultPaceUnit());
}

function renderStages() {
  const intensityLbl = state.sport === 'cycling' ? 'Power (W)' : 'Pace';
  stagesBody.innerHTML = state.stages.map((s, i) => `
    <tr>
      <td class="st-n"><span class="st-n-lbl">Stage </span>${i + 1}</td>
      <td class="st-pace" data-label="${intensityLbl}">${
        state.sport === 'running'
          ? paceInputHTML({ id: 'stage-intensity-' + i, mps: s.intensity, placeholder: intensityPlaceholder(i), extraAttrs: 'data-i="' + i + '" data-k="intensity" aria-label="Stage ' + (i + 1) + ' pace"' })
          : '<div class="pace-input"><input type="text" class="pace-text" inputmode="decimal" id="stage-intensity-' + i + '" data-i="' + i + '" data-k="intensity" aria-label="Stage ' + (i + 1) + ' power (W)" value="' + escAttr(isFinite(s.intensity) && s.intensity > 0 ? s.intensity : '') + '" placeholder="' + intensityPlaceholder(i) + '"><span class="unit-static">W</span></div>'
      }</td>
      <td data-label="Duration (min)"><input type="number" step="0.5" min="2" max="10" data-i="${i}" data-k="durationMin" aria-label="Stage ${i + 1} duration (min)" placeholder="5" value="${escAttr(isFinite(s.durationMin) ? s.durationMin : '')}"></td>
      <td data-label="Lactate (mmol/L)"><input type="number" step="0.1" min="0"  max="25" data-i="${i}" data-k="lactate" aria-label="Stage ${i + 1} lactate (mmol/L)" placeholder="${EX_LA[i] != null ? EX_LA[i].toFixed(1) : ''}" value="${escAttr(isFinite(s.lactate) ? s.lactate : '')}"></td>
      <td class="st-rm">${state.stages.length > 3 ? '<button type="button" class="row-remove" data-rm="' + i + '" aria-label="Remove stage ' + (i + 1) + '">×</button>' : ''}</td>
    </tr>
  `).join('');

  stagesBody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const i = +e.target.dataset.i;
      const k = e.target.dataset.k;
      if (!k) return;  // unit-toggle button has no data-k
      const raw = e.target.value.trim();
      e.target.removeAttribute('aria-invalid');
      if (k === 'intensity') {
        state.sportClearedNote = false;
        if (state.sport === 'running') {
          state.stages[i][k] = readPaceMps(e.target);   // NaN on blank
        } else {
          state.stages[i][k] = parseFloat(raw);          // NaN on blank
        }
      } else if (k === 'hr')   state.stages[i][k] = e.target.value;
      else                     state.stages[i][k] = raw === '' ? NaN : +raw;
      checkStageWarnings();
    });
  });
  stagesBody.querySelectorAll('[data-rm]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.rm;
      state.stages.splice(i, 1);
      renderStages();
    });
  });

  // Pace-unit toggle: when the user flips the unit, re-read every running
  // stage in the new unit (the display has already been converted).
  wirePaceInputs(() => {
    if (state.sport !== 'running') return;
    stagesBody.querySelectorAll('input.pace-text').forEach((inp) => {
      const i = +inp.dataset.i;
      const mps = readPaceMps(inp);
      if (isFinite(mps)) state.stages[i].intensity = mps;
    });
    checkStageWarnings();
  });

  const add = $('#add-stage');
  if (add) {
    add.disabled = state.stages.length >= 9;
    add.textContent = add.disabled ? 'Maximum 9 stages' : '+ Add stage';
  }

  checkStageWarnings();
}

$('#add-stage').addEventListener('click', () => {
  if (state.stages.length >= 9) return;
  const last = state.stages[state.stages.length - 1] || {};
  const ok = (v) => isFinite(v) && v > 0;
  state.stages.push({
    intensity: !ok(last.intensity) ? NaN
      : state.sport === 'cycling' ? Math.round(last.intensity + 30) : +(last.intensity + 0.3).toFixed(2),
    durationMin: ok(last.durationMin) ? last.durationMin : 5,
    lactate: NaN,
    hr: '',
  });
  renderStages();
});

function checkStageWarnings() {
  const out = [];
  const fin = (v) => isFinite(v);
  const exNote = document.getElementById('stages-example-note');
  if (exNote) exNote.hidden = !state.stages.some((s) => !(fin(s.intensity) && s.intensity > 0) || !fin(s.lactate));
  if (state.stages.length < 5) out.push('Need at least 5 stages for a meaningful fit (most tests run 5–9).');
  for (let i = 1; i < state.stages.length; i++) {
    if (fin(state.stages[i].intensity) && fin(state.stages[i - 1].intensity)
        && state.stages[i].intensity <= state.stages[i - 1].intensity)
      out.push('Stage ' + (i + 1) + ' intensity should exceed stage ' + i + '.');
  }
  let nonMono = 0;
  for (let i = 1; i < state.stages.length; i++) {
    if (state.stages[i].lactate < state.stages[i - 1].lactate - 0.1) nonMono++;
  }
  if (nonMono > 0) out.push(nonMono + ' stage(s) have lower lactate than the prior stage — possible sampling error.');
  const last = state.stages[state.stages.length - 1];
  if (last && fin(last.lactate) && last.lactate < 4) out.push('Final stage lactate is ' + last.lactate + ' mmol/L (&lt; 4) — the test may not have reached threshold.');
  if (state.stages.some((s) => fin(s.durationMin) && s.durationMin < 3))
    out.push('Stage durations &lt; 3 min may not have reached steady state.');
  // A bare number in a pace box is read as m/s (power-user input): say so.
  if (state.sport === 'running') {
    stagesBody.querySelectorAll('input.pace-text[data-k="intensity"]').forEach((inp) => {
      const raw = inp.value.trim();
      if (/^\d+(\.\d+)?$/.test(raw)) {
        const v = +raw;
        out.push('Stage ' + (+inp.dataset.i + 1) + ': “' + raw + '” is read as ' + v.toFixed(2) + ' m/s ('
          + speedToPaceString(v, getDefaultPaceUnit()) + '). Type ' + raw + ':00 for a ' + raw + '-minute pace.');
      }
    });
  }
  state.stageWarnings = out.slice();
  const cleared = state.sportClearedNote
    ? '<div class="info">Stage ' + (state.sport === 'cycling' ? 'powers' : 'paces') + ' were cleared — pace and power use different units. Enter your '
      + (state.sport === 'cycling' ? 'watts' : 'paces') + ' for each stage.</div>'
    : '';
  $('#stage-warnings').innerHTML = cleared + (out.length ? out.map(w => '<div class="warn">⚠ ' + w + '</div>').join('') : '');
}

// Blocking check before Run: every stage needs intensity, duration, lactate.
function validateBeforeRun() {
  const errs = [], bad = [];
  const what = state.sport === 'cycling' ? 'a power' : 'a pace';
  state.stages.forEach((s, i) => {
    const row = stagesBody.querySelectorAll('tr')[i];
    const q = (k) => row && row.querySelector('[data-k="' + k + '"]');
    if (!(isFinite(s.intensity) && s.intensity > 0)) { errs.push('Stage ' + (i + 1) + ': enter ' + what); bad.push(q('intensity')); }
    if (!(isFinite(s.durationMin) && s.durationMin > 0)) { errs.push('Stage ' + (i + 1) + ': enter a duration'); bad.push(q('durationMin')); }
    if (!(isFinite(s.lactate) && s.lactate >= 0)) { errs.push('Stage ' + (i + 1) + ': enter lactate'); bad.push(q('lactate')); }
  });
  if (!(state.bodyMass > 0)) errs.push('Enter your body mass on step 1');
  if (!errs.length) return true;
  checkStageWarnings();
  bad.filter(Boolean).forEach((el) => el.setAttribute('aria-invalid', 'true'));
  $('#stage-warnings').insertAdjacentHTML('afterbegin',
    '<div class="esl-callout esl-callout--bad" role="alert"><p class="esl-callout-title">Fix these before running</p><ul>'
    + errs.map((e) => '<li>' + e + '</li>').join('') + '</ul></div>');
  const first = bad.find(Boolean);
  if (first) first.focus();
  return false;
}

renderStages();

/* ───────── Run profile ───────── */

const buildSteps = (stages) => stages.map((s) => ({
  intensity: s.intensity, durationMin: s.durationMin, lactate: s.lactate,
}));

const runProfile = (stages) => getMetabolicProfile({
  sport: state.sport, sex: state.sex, bodyMass: state.bodyMass,
  VLamax: state.VLamax, steps: buildSteps(stages),
});

/*
 * Convert altitude-measured running paces into their sea-level equivalents
 * (same lactate, faster pace) before the curve is fit, so VO₂max / MLSS /
 * zones come out as sea-level numbers — consistent with the power-profile
 * tool, which does the same via effortsToSeaLevel().
 *
 * Uses the shared, literature-anchored altitudeFactor model (Faulkner 1968 /
 * Wagner 2000 VO₂max decrement; Daniels & Gilbert 1979 intensity scaling).
 * Unlike the power profile — whose three efforts all sit near VO₂max effort,
 * so it applies a flat x=1.15 factor — a step test spans easy→max, so each
 * stage gets an intensity-scaled factor keyed to its own relative intensity
 * (pace / MLSS): easy stages are corrected less than threshold stages, exactly
 * as the Daniels conversion tables prescribe.
 *
 * Cycling power and the alactic sprint (VLamax) are altitude-neutral and pass
 * through unchanged.
 */
function stagesToSeaLevel(stages) {
  if (state.sport !== 'running' || !(state.altitude_m > 800)) return stages;  // 800 m = ALTITUDE.threshold_m
  // First pass at the measured paces just locates MLSS, which sets the
  // relative-intensity each stage's correction is keyed to.
  const mlss = runProfile(stages).mlss.intensity;
  if (!(mlss > 0)) return stages;
  return stages.map((s) => {
    const f = altitudeFactor(state.altitude_m, s.intensity / mlss);  // ≤ 1
    return f < 1 ? Object.assign({}, s, { intensity: s.intensity / f }) : s;
  });
}

async function runAndSave(asNew) {
  if (readOnly()) { window.location.href = PRICING_FROM; return; }   // lapsed: re-runs need access
  if (!state.VLamax) {
    gotoStep(2);
    continueFromVLamax();   // shows the inline sprint error
    return;
  }
  if (!validateBeforeRun()) return;
  if (asNew) state.activeSessionId = null;
  try {
    const fitStages = stagesToSeaLevel(state.stages);
    state.fitStages = fitStages;
    state.altitudeCorrected = fitStages !== state.stages;
    state.profile = runProfile(fitStages);
    gotoStep(4);       // visible first, so the charts size to the full width
    renderResults();
    await autoSaveSession(state.profile);   // persist (new) or update the active test
  } catch (e) {
    console.error(e);
    $('#stage-warnings').insertAdjacentHTML('afterbegin',
      '<div class="esl-callout esl-callout--bad" role="alert">Couldn’t compute a profile from these stages. Check the values and try again.</div>');
  }
}
$('#run').addEventListener('click', () => runAndSave(false));
const runNewBtn = $('#run-new');
if (runNewBtn) runNewBtn.addEventListener('click', () => runAndSave(true));

/* ───────── Saved tests (Firestore sessions) ─────────
 *
 * Stored at users/{uid}.esmetlab.lactateSessions[] — newest-last, kept
 * separate from .vlamax and the power-profile .powerProfiles[]. Tests
 * auto-save on every run: a fresh run creates a new record, and re-running
 * while a saved test is loaded UPDATES that same record (so the athlete can
 * tweak data without spawning duplicates). Stages are stored as measured
 * (altitude paces); the sea-level correction is re-applied on replay.
 */

function generateId() {
  return 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Set the default VLamax (for a new test) from the most recent saved session.
// Returns true if a session VLamax was applied.
function applyLatestSessionVLamax() {
  const latest = state.sessions[state.sessions.length - 1];
  if (!latest || !latest.inputs || typeof latest.inputs.VLamax !== 'number') return false;
  state.VLamax = latest.inputs.VLamax;
  state.VLamax_inputs = latest.inputs.VLamax_inputs || null;
  state.VLamax_measured_at = latest.inputs.VLamax_measured_at || latest.measured_at || null;
  return true;
}

function toTimestamp(v) {
  if (!v) return null;
  if (v.toDate) return v;                                  // already a Firestore Timestamp
  try { return firebase.firestore.Timestamp.fromDate(new Date(v)); }
  catch (e) { return null; }
}

function buildSessionRecord(profile) {
  return {
    inputs: {
      sport: state.sport, sex: state.sex, bodyMass: state.bodyMass,
      altitude_m: state.altitude_m || 0,
      // VLamax sprint and step test are saved together as one session.
      VLamax: state.VLamax,
      VLamax_inputs: state.VLamax_inputs || null,
      VLamax_measured_at: toTimestamp(state.VLamax_measured_at),
      stages: state.stages.map((s) => ({
        intensity: s.intensity, durationMin: s.durationMin,
        lactate: s.lactate, hr: s.hr || '',
      })),
    },
    derived: { VO2max: profile.VO2max, VLamax: profile.VLamax },
  };
}

async function persistSessions(list) {
  const user = window.__esml && window.__esml.user;
  if (!user) throw new Error('Sign in required.');
  await firebase.firestore().collection('users').doc(user.uid).set(
    { esmetlab: { lactateSessions: list } }, { merge: true });
}

// Auto-save after a run: update the active test in place, or create a new one.
async function autoSaveSession(profile) {
  const user = window.__esml && window.__esml.user;
  if (!user) return;                       // app is auth-gated, but fail safe
  const now = firebase.firestore.Timestamp.now();
  const record = buildSessionRecord(profile);
  const idx = state.activeSessionId
    ? state.sessions.findIndex((s) => s.id === state.activeSessionId) : -1;
  // Write first; local state changes only once the save succeeded.
  const next = state.sessions.slice();
  let id = state.activeSessionId;
  if (idx >= 0) {
    const prev = next[idx];
    next[idx] = Object.assign({}, prev, record,
      { id: prev.id, measured_at: prev.measured_at || now, updated_at: now });
  } else {
    id = generateId();
    next.push(Object.assign({ id, measured_at: now }, record));
  }
  try { await persistSessions(next); }
  catch (e) {
    console.error('Test save failed:', e);
    state.saveError = true;
    updateSaveStatus();
    return;
  }
  state.sessions = next;
  state.activeSessionId = id;
  state.saveError = false;
  state.justSaved = true;
  renderSavedTests();
  updateSaveStatus();
}

async function deleteSession(id) {
  const ok = await showConfirmModal({
    title: 'Delete this test?',
    body: 'This permanently removes the saved lactate test. This cannot be undone.',
    confirmLabel: 'Delete', cancelLabel: 'Keep it', danger: true,
  });
  if (!ok) return;
  const next = state.sessions.filter((s) => s.id !== id);
  try { await persistSessions(next); }
  catch (e) {
    console.error(e);
    renderSavedTests();
    const root = document.getElementById('saved-tests-root');
    if (root) root.insertAdjacentHTML('afterbegin',
      '<div class="esl-callout esl-callout--bad" role="alert" style="margin-bottom:12px">Couldn’t delete that test. Please try again.</div>');
    return;
  }
  state.sessions = next;
  if (state.activeSessionId === id) state.activeSessionId = null;
  renderSavedTests();
}

// Load a saved test into the wizard, replay it, and show the results.
function loadSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s || !s.inputs) return;
  const inp = s.inputs;
  state.sport = inp.sport || 'running';
  state.sex = inp.sex || 'M';
  state.bodyMass = inp.bodyMass || 70;
  state.altitude_m = inp.altitude_m || 0;
  state.VLamax = inp.VLamax;
  if (inp.VLamax_inputs) state.VLamax_inputs = inp.VLamax_inputs;
  if (inp.VLamax_measured_at) state.VLamax_measured_at = inp.VLamax_measured_at;
  state.stages = (inp.stages || []).map((st) => ({
    intensity: st.intensity, durationMin: st.durationMin,
    lactate: st.lactate, hr: st.hr || '',
  }));
  state.activeSessionId = id;
  state.justSaved = false;
  state.saveError = false;
  state.sportClearedNote = false;
  syncInputsToUI();
  try {
    const fitStages = stagesToSeaLevel(state.stages);
    state.fitStages = fitStages;
    state.altitudeCorrected = fitStages !== state.stages;
    state.profile = runProfile(fitStages);
    gotoStep(4);       // visible first, so the charts size to the full width
    renderResults();
  } catch (e) {
    alert('Could not load that test: ' + e.message);
    console.error(e);
  }
}

// Start a fresh test: clear the active record and reset the test-specific
// inputs (stages, altitude). Athlete details and VLamax carry over.
function newTest() {
  state.activeSessionId = null;
  state.justSaved = false;
  state.saveError = false;
  state.sportClearedNote = false;
  state.stages = DEFAULT_STAGES.map((s) => Object.assign({}, s));
  if (state.sport === 'cycling') state.stages.forEach((s) => { s.intensity = NaN; });
  state.altitude_m = 0;
  state.profile = null;
  state.fitStages = null;
  applyLatestSessionVLamax();   // default VLamax = most recent test's sprint
  syncInputsToUI();
  syncRunLabel();
  gotoStep(1);
}

// Push current state back into the Step 1/3 form controls.
function syncInputsToUI() {
  document.querySelectorAll('input[name=sex]').forEach((r) => { r.checked = (r.value === state.sex); });
  document.querySelectorAll('input[name=sport]').forEach((r) => { r.checked = (r.value === state.sport); });
  syncMassUnitUI();
  syncAltitudeUnitUI();
  syncStepTestSport();
  renderIntensityHeader();
  toggleAltitudeField();
  renderStages();
  renderVLamaxStep();
}

function sessionCardHTML(s) {
  const d = s.derived || {};
  const inp = s.inputs || {};
  const isActive = s.id === state.activeSessionId;
  const activePill = isActive ? '<span class="latest-pill">Viewing</span>' : '';
  const sport = inp.sport || 'running';
  const nStages = (inp.stages || []).length;
  const meta = (sport === 'cycling' ? 'Cycling' : 'Running') + ' · ' + nStages + ' stages'
    + (inp.altitude_m > 0 ? ' · ' + mToDisplay(inp.altitude_m, getAltUnit()) + ' ' + getAltUnit() : '');
  return '<div class="sess-card ' + (isActive ? 'latest' : '') + '" data-session-load="' + escAttr(s.id) + '" tabindex="0" role="button" aria-label="View test from ' + escAttr(fmtDate(s.measured_at)) + '">' +
    '<div><div class="sess-card-date"><span>' + fmtDate(s.measured_at) + '</span>' + activePill + '</div></div>' +
    '<div class="sess-card-vals">' +
      '<div class="sess-card-val">VO₂max ' + (d.VO2max ?? 0).toFixed(1) + '<span class="unit">mL/min/kg</span></div>' +
      '<div class="sess-card-sub">VLamax ' + (d.VLamax ?? 0).toFixed(3) + '</div>' +
    '</div>' +
    '<div class="sess-card-meta"><span>' + meta + '</span>' +
      '<button type="button" class="sess-delete" data-session-delete="' + escAttr(s.id) + '" aria-label="Delete the test from ' + escAttr(fmtDate(s.measured_at)) + '">Delete</button></div>' +
  '</div>';
}

function renderSavedTests() {
  const root = document.getElementById('saved-tests-root');
  if (!root) return;
  syncWizardChrome();
  if (!state.sessions.length) { root.innerHTML = ''; return; }
  const reversed = [...state.sessions].reverse();
  const ro = readOnly();
  root.innerHTML =
    (ro ? '<div class="esl-callout" role="status" style="margin-bottom:14px"><p class="esl-callout-title">Your upload access has ended</p>'
        + '<p>Your saved tests and their PDFs stay available to view. <a href="' + PRICING_FROM + '">See plans</a> to run a new test or update one.</p></div>' : '') +
    '<div class="panel" style="margin-bottom:18px">' +
      '<div class="sess-panel-h">' +
        '<h2 class="panel-h">Your saved tests</h2>' +
        (ro ? '<a class="btn primary" id="new-test-btn" href="' + PRICING_FROM + '">New test — see plans →</a>'
            : '<button type="button" class="btn primary" id="new-test-btn">+ New test</button>') +
      '</div>' +
      '<div class="sess-list">' + reversed.map(sessionCardHTML).join('') + '</div>' +
      '<div class="sess-foot">Click a test to view it. Editing the inputs and re-running updates that same test; use “+ New test” to start a fresh one.</div>' +
    '</div>';
  root.querySelectorAll('[data-session-load]').forEach((el) => {
    el.addEventListener('click', () => loadSession(el.dataset.sessionLoad));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      loadSession(el.dataset.sessionLoad);
    });
  });
  root.querySelectorAll('[data-session-delete]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(btn.dataset.sessionDelete); }));
  const nb = document.getElementById('new-test-btn');
  if (nb && !ro) nb.addEventListener('click', newTest);
}

function updateSaveStatus() {
  const el = document.getElementById('save-status');
  if (!el) return;
  syncRunLabel();
  if (state.saveError) {
    el.className = 'esl-callout esl-callout--bad';
    el.setAttribute('role', 'alert');
    el.style.display = '';
    el.innerHTML = '<p><strong>Couldn’t save this test.</strong> Your results are shown below but aren’t stored yet.</p>'
      + '<p style="margin-top:10px"><button type="button" class="btn" id="save-retry">Retry</button></p>';
    const retry = document.getElementById('save-retry');
    if (retry) retry.addEventListener('click', () => {
      retry.disabled = true; retry.textContent = 'Saving…';
      autoSaveSession(state.profile);
    });
    return;
  }
  el.className = 'info';
  el.removeAttribute('role');
  const s = state.activeSessionId && state.sessions.find((x) => x.id === state.activeSessionId);
  if (!s) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = state.justSaved
    ? '✓ Saved to <strong>Your saved tests</strong>. Edit any input and re-run to update this same test.'
    : 'Viewing your test from ' + fmtDate(s.measured_at) + '.' + (readOnly() ? '' : ' Edit any input and re-run to update it.');
}

/* ───────── Results renderer ───────── */

function renderResults() {
  const p = state.profile;
  const sport = state.sport;
  const fmtIntensity = sport === 'cycling' ? fmt.W : fmt.pace;

  const metrics = [
    { label: 'VO₂max', value: fmt.V(p.VO2max),
      meaning: 'Your aerobic ceiling — the most oxygen your body can use per minute.',
      detail:  p.inputs.VO2max_supplied ? 'as supplied' : 'fitted from your curve' },
    { label: 'VLamax', value: p.VLamax.toFixed(3) + ' mmol/L/s',
      meaning: 'How fast your body produces lactate at all-out sprint effort.',
      detail:  'from sprint test on ' + fmtDate(state.VLamax_measured_at) },
    { label: 'MLSS', value: fmtIntensity(p.mlss.intensity),
      meaning: 'Maximum sustainable hard effort — about half-marathon / 1-hour race pace.',
      detail:  fmt.pct(p.mlss.x) + ' of VO₂max · ' + fmt.La(p.mlss.lactate) },
    { label: 'LT1', value: fmtIntensity(p.lt1.intensity),
      meaning: 'Top of your easy zone — above this, lactate starts to rise above baseline.',
      detail:  fmt.pct(p.lt1.x) + ' of VO₂max · ' + fmt.La(p.lt1.lactate) },
    { label: 'Fatmax', value: fmtIntensity(p.fatmax.intensity),
      meaning: 'Where you burn the most fat in g/min — long-run / aerobic-base territory.',
      detail:  fmt.G(p.fatmax.fat_g_per_min) + ' at ' + fmt.pct(p.fatmax.x) + ' of VO₂max' },
  ];
  const metricsHtml = metrics.map(m =>
    '<div class="metric"><div class="metric-label">' + m.label + '</div>' +
    metricValueHtml(m.value) +
    (m.meaning ? '<div class="metric-meaning">' + m.meaning + '</div>' : '') +
    (m.detail  ? '<div class="metric-note">'    + m.detail  + '</div>' : '') +
    '</div>').join('');

  let sensHtml = '';
  if (p.diagnostics.sensitivity) {
    const s = p.diagnostics.sensitivity;
    sensHtml = '<div class="info">Sensitivity: perturbing any single stage lactate by ±0.5 mmol/L shifts VO₂max by at most '
             + '<strong>' + s.max_VO2max_shift.toFixed(2) + ' mL/min/kg ('
             + (s.max_VO2max_shift / s.base_VO2max * 100).toFixed(2) + '%)</strong>. '
             + 'Fit RMSE = ' + p.diagnostics.rmse.toFixed(2) + ' mmol/L. '
             + 'This shows how robust the result is to small measurement errors.</div>';
  }

  let warnHtml = '';
  if (p.diagnostics.warnings && p.diagnostics.warnings.length) {
    warnHtml = p.diagnostics.warnings.map(w => '<div class="warn">⚠ ' + w + '</div>').join('');
  }

  let altHtml = '';
  if (state.altitudeCorrected) {
    altHtml = '<div class="info">Altitude correction: your step-test paces were measured at '
            + '<strong>' + Math.round(state.altitude_m) + ' m</strong> and converted to sea-level equivalents '
            + '(same lactate, faster pace) before fitting — so VO₂max, MLSS, and zones above are sea-level '
            + 'values, comparable to a sea-level test and to the power-profile tool. The correction is '
            + 'intensity-scaled (smaller for easy stages, larger near threshold) per the Daniels &amp; Gilbert '
            + '1979 conversion tables and Faulkner 1968 / Wagner 2000 VO₂max decrement. The 15-second sprint '
            + 'that sets VLamax is alactic and altitude-neutral, so it passes through unchanged.</div>';
  }

  const zones = generateZones(sport, { MLSS_intensity: p.mlss.intensity, LT1_intensity: p.lt1.intensity });
  const zoneOpts = { altitude_m: state.altitude_m || 0, mlss_speed: p.mlss.intensity };
  let zonesHtml = '';
  if (zones.coggan) zonesHtml += zoneTableHtml('Coggan 7-zone (cycling)', zones.coggan, sport, zoneOpts);
  if (zones.friel)  zonesHtml += zoneTableHtml('Friel 7-zone (running)',  zones.friel, sport, zoneOpts);
  if (zones.seiler) zonesHtml += zoneTableHtml('Seiler 3-zone',           zones.seiler, sport, zoneOpts);

  // Running pages show all paces in one unit at a time; cycling has no toggle.
  const u = getDefaultPaceUnit();
  const paceTogglePillHtml = sport === 'running'
    ? '<div class="unit-pill" id="pace-unit-pill" role="group" aria-label="Pace display unit">'
      + '<button type="button" data-pace-unit="mi" class="' + (u === 'mi' ? 'active' : '') + '" aria-pressed="' + (u === 'mi') + '">min/mi</button>'
      + '<button type="button" data-pace-unit="km" class="' + (u === 'km' ? 'active' : '') + '" aria-pressed="' + (u === 'km') + '">min/km</button>'
    + '</div>'
    : '';

  const stageWarnHtml = (state.stageWarnings || []).map((w) => '<div class="warn">⚠ ' + w + '</div>').join('');

  $('#results-root').innerHTML =
    '<h2 class="results-h">Your metabolic profile</h2>' +
    profileGuideHtml(sport) +
    paceTogglePillHtml +
    '<div class="metric-grid">' + metricsHtml + '</div>' +
    ((stageWarnHtml || warnHtml) ? '<div class="results-warnings">' + stageWarnHtml + warnHtml + '</div>' : '') +
    altHtml +
    '<div id="save-status" class="info" style="display:none"></div>' +
    '<div class="report-actions">' +
      '<button class="btn-download-report" id="export-pdf-big" type="button">' +
        '<span class="bdr-icon">⬇</span>' +
        '<span>Download PDF report</span>' +
        '<span class="bdr-sub">save · share · print</span>' +
      '</button>' +
    '</div>' +
    precisionExpandableHtml() +
    sensHtml +
    '<div class="panel"><h2 class="panel-h">Training zones</h2>' + zonesHtml + '</div>' +
    '<div class="chart-block"><h3 class="chart-title">Lactate response across intensities</h3>' +
      '<div class="chart-sub">How your blood lactate behaves — and how fast you produce and clear it — at every effort level. Your measured stages are overlaid as yellow dots.</div>' +
      '<div id="chart-lactate" class="plt"></div>' +
      lactateChartExplainerHtml() +
    '</div>' +
    '<div class="chart-block"><h3 class="chart-title">Fat vs carbohydrate burning</h3>' +
      '<div class="chart-sub">Grams of fat and carbs burned per minute at each intensity. Fatmax (yellow dashed line) is where fat-burning peaks.</div>' +
      '<div id="chart-substrate" class="plt"></div>' +
      substrateChartExplainerHtml() +
    '</div>' +
    educationHtml();

  // Wire pace-unit toggle (running only)
  const pillRoot = $('#pace-unit-pill');
  if (pillRoot) {
    pillRoot.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        setDefaultPaceUnit(b.dataset.paceUnit);
        renderResults();
      });
    });
  }

  // Wire the prominent in-results PDF button (re-created each render)
  const bigBtn = $('#export-pdf-big');
  if (bigBtn) bigBtn.addEventListener('click', () => triggerPdfExport(bigBtn));

  updateSaveStatus();
  drawCharts(p);
}

function zoneTableHtml(title, rows, sport, opts) {
  opts = opts || {};
  const altitude_m = opts.altitude_m || 0;
  const mlss_speed = opts.mlss_speed || 0;
  // Zone bounds are sea-level (the curve was fit at sea level); when a test
  // altitude is set we add a column showing the equivalent paces to actually
  // run at altitude. Same model/treatment as the power-profile tool.
  const showAlt = sport === 'running' && altitude_m > 800 && mlss_speed > 0;
  const pc = (v) => fmt.pace(v).replace(/\/(mi|km)$/, '');   // unit is in the header

  const fmtRange = (lo, hi) => {
    const loDef = !(lo === 0 || !isFinite(lo));
    const hiDef = isFinite(hi);
    if (sport === 'cycling') {
      if (!loDef && hiDef) return 'less than ' + Math.round(hi);
      if (loDef && !hiDef) return 'more than ' + Math.round(lo);
      return Math.round(lo) + ' – ' + Math.round(hi);
    }
    if (!loDef && hiDef) return 'slower than ' + pc(hi);
    if (loDef && !hiDef) return 'faster than ' + pc(lo);
    return pc(lo) + ' – ' + pc(hi);
  };

  // Altitude-adjusted speed for a sea-level boundary: each bound gets its own
  // intensity-scaled penalty at x = speed/MLSS (Daniels & Gilbert 1979).
  const altSpeed = (v) => {
    if (!isFinite(v) || v <= 0) return v;
    return v * altitudeFactor(altitude_m, v / mlss_speed);
  };
  const fmtAltRange = (lo, hi) => {
    const loDef = !(lo === 0 || !isFinite(lo));
    const hiDef = isFinite(hi);
    if (!loDef && hiDef) return 'slower than ' + pc(altSpeed(hi));
    if (loDef && !hiDef) return 'faster than ' + pc(altSpeed(lo));
    return pc(altSpeed(lo)) + ' – ' + pc(altSpeed(hi));
  };

  // Units live in the header so every range stays on one line on phones.
  const uLbl = sport === 'cycling' ? 'W' : (getDefaultPaceUnit() === 'km' ? 'min/km' : 'min/mi');
  const altHeaderCell = showAlt ? '<th>At altitude (' + uLbl + ')</th>' : '';
  const altDataCell = (r) => showAlt
    ? '<td class="num alt">' + fmtAltRange(r.lo, r.hi) + '</td>'
    : '';

  return '<h3 class="zone-h">' + title + '</h3>' +
         '<div class="zones-wrap"><table class="zones"><thead><tr><th>Zone</th><th>Label</th><th>' + (showAlt ? 'Sea level' : 'Range') + ' (' + uLbl + ')</th>' + altHeaderCell + '</tr></thead><tbody>' +
         rows.map((r) => '<tr><td>Z' + r.zone + '</td><td>' + r.label + '</td><td class="num">' + fmtRange(r.lo, r.hi) + '</td>' + altDataCell(r) + '</tr>').join('') +
         '</tbody></table></div>';
}

function lactateChartExplainerHtml() {
  return '' +
    '<details class="edu" style="margin-top:14px"><summary>What this chart shows</summary>' +
    '<div class="body">' +
      '<p>Three curves and two reference markers, all plotted against your effort level (x-axis).</p>' +
      '<ul style="margin:0 0 10px 18px;padding:0">' +
        '<li><strong style="color:var(--purple-ink)">Purple solid line — Predicted blood lactate</strong>. The lactate concentration in your blood you\'d settle at if you held each pace for several minutes. It stays low and flat through easy and moderate efforts, then sweeps upward as you approach threshold.</li>' +
        '<li><strong style="color:var(--coral-ink)">Orange solid line — Lactate production rate</strong>. How fast your muscles are pumping lactate into the blood at each pace. Reads on the right y-axis (mmol per liter per second). Small at easy pace; ramps up steeply once glycolysis kicks in. (Technical name: <em>vLass</em>.)</li>' +
        '<li><strong style="color:var(--accent-ink)">Cyan dotted line — Max lactate clearance rate</strong>. The fastest your body can remove lactate from the blood via oxidation. Also on the right y-axis. Mostly limited by your aerobic capacity. (Technical: <em>vLaoxmax</em>.)</li>' +
        '<li><strong style="color:var(--gold-ink)">Yellow dots — Your measured samples</strong>. The lactate readings you recorded at each step-test stage, plotted at the stage\'s pace. These are how the curve gets fit to your physiology.</li>' +
        '<li><strong style="color:var(--good-ink)">Green dashed vertical — MLSS</strong>. The intensity where production meets clearance. Below this you can hold pace indefinitely; above it lactate accumulates without bound and you fade.</li>' +
        '<li><strong style="color:var(--purple-ink)">Purple dashed vertical — LT1</strong>. Where blood lactate first rises noticeably above resting. The upper edge of your "all-day easy" zone.</li>' +
      '</ul>' +
      '<p>The key insight: <strong>MLSS is where the production curve crosses the clearance curve.</strong> Push faster and you\'re making lactate faster than you can clear it.</p>' +
    '</div></details>';
}

function substrateChartExplainerHtml() {
  return '' +
    '<details class="edu" style="margin-top:14px"><summary>What this chart shows</summary>' +
    '<div class="body">' +
      '<p>How much fat vs carbohydrate you burn per minute at each effort.</p>' +
      '<ul style="margin:0 0 10px 18px;padding:0">' +
        '<li><strong style="color:var(--gold-ink)">Yellow area — Fat burned</strong>. Grams of fat oxidized per minute. Rises through easy and moderate paces, peaks around <strong>Fatmax</strong>, then falls as harder efforts force a shift to carbohydrate.</li>' +
        '<li><strong style="color:var(--coral-ink)">Orange area — Carbs burned</strong>. Grams of carbohydrate (mostly muscle glycogen) oxidized per minute. Small at easy pace; climbs steeply as you push past tempo into threshold and above.</li>' +
        '<li><strong style="color:var(--gold-ink)">Yellow dashed vertical — Fatmax</strong>. The intensity where fat-burning is highest in g/min. Long-run / aerobic-base territory.</li>' +
      '</ul>' +
      '<p>Why this matters: <strong>fat is essentially unlimited fuel</strong> (most people carry tens of thousands of calories as body fat). Carbohydrate is limited — you store maybe 1,500–2,000 calories as muscle glycogen, and once you burn through that you crash. The fitter you are aerobically, the higher your Fatmax intensity — meaning you can burn fat at faster paces and save carb stores for surges and finishing kicks.</p>' +
    '</div></details>';
}

function precisionExpandableHtml() {
  return '' +
    '<details class="edu" style="margin-top:18px"><summary>How precise are these numbers?</summary>' +
    '<div class="body">' +
    '<p>These are <strong>point estimates</strong>, not exact measurements. Each headline value has real-world uncertainty:</p>' +
    '<ul style="margin:0 0 10px 18px;padding:0">' +
      '<li><strong>MLSS</strong> is conceptually a single pace — the highest intensity where lactate stays at steady state — but in practice expect about <strong>±2–3% day-to-day variance</strong> from hydration, glycogen, sleep, temperature, and acute fatigue. That\'s roughly ±5–10 s/mile or ±5–15 W for trained athletes.</li>' +
      '<li>Your <strong>half-marathon pace</strong> and <strong>1-hour TT pace</strong> usually land within a few seconds of MLSS in either direction — sometimes slightly faster (elite athletes can tolerate a small lactate creep), sometimes slightly slower.</li>' +
      '<li><strong>VO₂max</strong> from a 6-min field test has comparable precision (±3–5%). Repeated tests on different days routinely shift the estimate.</li>' +
      '<li><strong>VLamax</strong> has the largest test–retest variance of any single number here (literature CV 5–15%). One measurement is a snapshot.</li>' +
    '</ul>' +
    '<p>The training-zone bands (Z4 Sub-threshold + Z5 Threshold combined for the "near-MLSS" range) are intentionally wider than the single MLSS point — built that way so you don\'t need lab-pace precision to prescribe a session.</p>' +
    '</div></details>';
}

function educationHtml() {
  return '' +
    '<details class="edu" style="margin-top:18px"><summary>How do we read this profile?</summary>' +
    '<div class="body">' +
    '<p>The dual-curve chart is the heart of the Mader model. The rising curve is your glycolytic lactate production rate (vLass) — how fast you can pump lactate into the blood. The slower-rising curve is your maximum oxidative elimination capacity (vLaoxmax). Where they cross is MLSS — the highest intensity you can sustain without lactate accumulating.</p>' +
    '<p>Your LT1 (aerobic threshold) is where the simulated lactate first rises ~0.5 mmol/L above baseline. Below LT1, almost all energy comes from fat plus oxidative carbohydrate. Between LT1 and MLSS is your tempo / sweet-spot range. Above MLSS, lactate accumulates progressively.</p>' +
    '<p>Fatmax is the intensity at which fat oxidation (in g/min) peaks. For most trained athletes this sits in the lower-aerobic band, well below LT1.</p>' +
    '</div></details>' +
    '<details class="edu"><summary>Why we chose the Mader model</summary>' +
    '<div class="body">' +
    '<p>The Mader/Heck bioenergetic model has been refined continuously since 1976 by the German Sport University Cologne group. It treats the muscle cell as having two parallel ATP-resynthesis pathways — glycolysis and oxidation — each modulated by free [ADP] via Hill-type kinetics. From only two physiological parameters (VO₂max and VLamax) plus body composition, the model derives the complete lactate curve, MLSS, LT1, fat/CHO oxidation rates, and Fatmax.</p>' +
    '<p>It\'s the same family of model used commercially by INSCYD and Aerotune. Our implementation follows the published equations, and its assumptions are spelled out in “What this tool can’t tell you” below.</p>' +
    '</div></details>' +
    '<details class="edu"><summary>What this tool can\'t tell you</summary>' +
    '<div class="body">' +
    '<p>The model assumes a standard active-muscle pool fraction. Individuals vary, and the kinetic constants were calibrated primarily on trained European male cyclists.</p>' +
    '<p>VLamax has known within-subject variability (CV 5–15% across sessions). One measurement is a snapshot, not a permanent reading.</p>' +
    '<p>The steady-state model is most accurate for sustained efforts. It\'s more approximate for intervals, surges, and tactical race dynamics where lactate is not at equilibrium.</p>' +
    '</div></details>';
}

/* ───────── Charts ───────── */

function drawCharts(p) {
  const opts = { paceUnit: getDefaultPaceUnit() };
  // Overlay the stages that were actually fit (sea-level equivalents when an
  // altitude correction was applied) so the dots sit on the fitted curve.
  drawLactateChart('chart-lactate', p, state.sport, state.fitStages || state.stages, opts);
  drawSubstrateChart('chart-substrate', p, state.sport, opts);
}

/* ───────── PDF export ───────── */

async function triggerPdfExport(btn) {
  if (!state.profile) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library not loaded yet — try again in a moment.');
    return;
  }
  // Swap the inner label of the big button; for the small nav-actions button
  // just swap textContent.
  const label = btn ? btn.querySelector('span:nth-child(2)') : null;
  const origText = btn ? (label ? label.textContent : btn.textContent) : null;
  if (btn) {
    btn.disabled = true;
    if (label) label.textContent = 'Building PDF…';
    else btn.textContent = 'Building PDF…';
  }
  try {
    await downloadStepTestReport({
      profile:     state.profile,
      sport:       state.sport,
      stages:      state.fitStages || state.stages,
      bodyMass:    state.bodyMass,
      sex:         state.sex,
      altitude_m:  state.altitude_m || 0,
      measuredAt:  (state.sessions.find((s) => s.id === state.activeSessionId) || {}).measured_at || null,
    });
  } catch (e) {
    console.error('PDF export failed:', e);
    alert('Couldn’t build the PDF: ' + (e.message || e));
  } finally {
    if (btn) {
      btn.disabled = false;
      if (label) label.textContent = origText;
      else btn.textContent = origText;
    }
  }
}

$('#export-pdf').addEventListener('click', () => triggerPdfExport($('#export-pdf')));
