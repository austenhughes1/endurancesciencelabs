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
import { paceInputHTML, wirePaceInputs, readPaceMps, getDefaultPaceUnit, setDefaultPaceUnit } from '../js/ui/pace-input.js';
import { wireHowToMeasureTriggers } from '../js/ui/how-to-measure.js';
import { wireStepTestTriggers }    from '../js/ui/how-to-step-test.js';
import { wireSprintProtocolTriggers } from '../js/ui/how-to-sprint-test.js';
import { drawLactateChart, drawSubstrateChart } from '../js/ui/charts.js';
import { downloadStepTestReport } from '../js/ui/pdf-report.js';
import { profileGuideHtml } from '../js/ui/profile-guide.js';
import { showConfirmModal } from '../js/ui/confirm-modal.js';

// Wire the page-level protocol buttons.
wireHowToMeasureTriggers();
wireStepTestTriggers();
wireSprintProtocolTriggers();

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
  stages: [
    // Default to running speeds (8:00, 7:30, 7:00, 6:30, 6:00 per mile)
    { intensity: 3.35, durationMin: 5, lactate: 1.4, hr: '' },
    { intensity: 3.58, durationMin: 5, lactate: 2.0, hr: '' },
    { intensity: 3.83, durationMin: 5, lactate: 3.0, hr: '' },
    { intensity: 4.13, durationMin: 5, lactate: 4.5, hr: '' },
    { intensity: 4.47, durationMin: 5, lactate: 7.5, hr: '' },
  ],
  profile: null,
  sessions: [],            // saved lactate tests, newest-last
  activeSessionId: null,   // test currently being viewed/edited; re-running updates it
};

// Pristine copy of the default stages, used to reset for a brand-new test.
const DEFAULT_STAGES = state.stages.map((s) => Object.assign({}, s));

/* ───────── Helpers ───────── */

function fmtDate(ts) {
  if (!ts) return '—';
  let d;
  if (ts.toDate) d = ts.toDate();
  else d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ───────── Step 2: sprint VLamax (inline, replaces the old separate page) ───────── */

// Default sprint inputs if the user has never run one. Sane mid-range starting values.
const DEFAULT_VL_INPUTS = { La_pre: 1.4, La_peak_post: 11.0, duration_s: 15, t_PCr_s: 3.5 };

function renderVLamaxStep() {
  const body = $('#vlamax-step-body');
  if (!body) return;
  const inp = state.VLamax_inputs || DEFAULT_VL_INPUTS;
  const hasSaved = typeof state.VLamax === 'number';

  const savedSummary = hasSaved
    ? '<div class="vlc-summary" style="margin-bottom:18px">' +
        '<div class="vlc-meta">' +
          '<div class="vlc-pill">◈ Current VLamax</div>' +
          '<div class="vlc-val">' + state.VLamax.toFixed(3) +
            ' <span class="vlc-unit">mmol·L⁻¹·s⁻¹</span></div>' +
          '<div class="vlc-date">From your most recent test · measured ' + fmtDate(state.VLamax_measured_at) +
            ' — keep it for this test, or enter a new sprint below. It saves with the step test as one session.</div>' +
        '</div>' +
      '</div>'
    : '';

  body.innerHTML =
    savedSummary +
    '<div class="grid-3">' +
      '<label class="field"><span class="lab">Pre-sprint La (mmol/L)</span>' +
        '<input type="number" id="vlc-la-pre" step="0.1" min="0" max="5" value="' + inp.La_pre + '"></label>' +
      '<label class="field"><span class="lab">Peak post-sprint La (mmol/L)</span>' +
        '<input type="number" id="vlc-la-post" step="0.1" min="2" max="30" value="' + inp.La_peak_post + '"></label>' +
      '<label class="field"><span class="lab">Sprint duration (s)</span>' +
        '<input type="number" id="vlc-dur" step="1" min="10" max="30" value="' + inp.duration_s + '"></label>' +
    '</div>' +
    '<div class="vlc-result" id="vlc-result"></div>';

  ['vlc-la-pre','vlc-la-post','vlc-dur'].forEach(id =>
    $('#' + id).addEventListener('input', recalcLive)
  );
  recalcLive();
}

function readVLamaxInputs() {
  return {
    La_pre:        +$('#vlc-la-pre').value,
    La_peak_post:  +$('#vlc-la-post').value,
    duration_s:    +$('#vlc-dur').value,
    t_PCr_s:       DEFAULT_VL_INPUTS.t_PCr_s,   // fixed alactic time (3.5 s); not user-adjustable
  };
}

function recalcLive() {
  const inputs = readVLamaxInputs();
  const r = computeVLamax(inputs);
  if (!isFinite(r.VLamax) || r.glycolytic_time_s <= 0) {
    $('#vlc-result').innerHTML = '<div class="vlc-result-empty">Enter all three sprint values to compute.</div>';
    return;
  }
  const errHtml = r.errors && r.errors.length
    ? '<div style="font-size:13px;color:var(--bad);background:rgba(255,81,99,.08);border:1px solid rgba(255,81,99,.30);border-radius:8px;padding:10px 12px;margin-top:10px;line-height:1.55">✕ ' + r.errors.join('<br>✕ ') + '</div>'
    : '';
  const warnHtml = r.warnings.length
    ? '<div style="font-size:12px;color:var(--gold);margin-top:6px">⚠ ' + r.warnings.join(' ') + '</div>'
    : '';
  $('#vlc-result').innerHTML =
    '<div class="vlc-result-box">' +
      '<div class="vlc-result-label">YOUR VLAMAX</div>' +
      '<div class="vlc-result-val">' + r.VLamax.toFixed(3) +
        ' <span class="vlc-unit">mmol·L⁻¹·s⁻¹</span></div>' +
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
  const r = computeVLamax(inputs);
  if (!isFinite(r.VLamax) || r.glycolytic_time_s <= 0) {
    alert('Sprint values are not valid — recheck the inputs.');
    return;
  }
  if (r.errors && r.errors.length) {
    alert(r.errors.join('\n\n'));
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
  } catch (e) {
    console.error('Failed to load saved tests:', e);
  }
  renderVLamaxStep();
  renderSavedTests();
}

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
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('[data-go]').forEach(btn => btn.addEventListener('click', () => gotoStep(+btn.dataset.go)));

/* ───────── Step 1: athlete bindings ───────── */

document.querySelectorAll('input[name=sex]').forEach(r => r.addEventListener('change', e => state.sex = e.target.value));
document.querySelectorAll('input[name=sport]').forEach(r => r.addEventListener('change', e => {
  state.sport = e.target.value;
  renderIntensityHeader();
  toggleAltitudeField();
  renderStages();
}));
$('#bodyMass').addEventListener('input', e => state.bodyMass = +e.target.value);

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
    btn.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
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
  document.querySelectorAll('[data-alt-toggle] button').forEach((b) =>
    b.classList.toggle('active', b.dataset.altUnit === unit));
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

function intensityPlaceholder() {
  return state.sport === 'cycling' ? '200' : '7:00';
}

function renderStages() {
  stagesBody.innerHTML = state.stages.map((s, i) => `
    <tr>
      <td style="font-family:var(--mono);color:var(--muted2)">${i + 1}</td>
      <td>${
        state.sport === 'running'
          ? paceInputHTML({ id: 'stage-intensity-' + i, mps: s.intensity, placeholder: intensityPlaceholder(), extraAttrs: 'data-i="' + i + '" data-k="intensity"' })
          : '<input type="text" data-i="' + i + '" data-k="intensity" value="' + (s.intensity || '') + '" placeholder="' + intensityPlaceholder() + '">'
      }</td>
      <td><input type="number" step="0.5" min="2" max="10" data-i="${i}" data-k="durationMin" value="${s.durationMin}"></td>
      <td><input type="number" step="0.1" min="0"  max="25" data-i="${i}" data-k="lactate" value="${s.lactate}"></td>
      <td><input type="number" step="1"   min="50" max="220" data-i="${i}" data-k="hr"      value="${s.hr}"></td>
      <td>${state.stages.length > 3 ? '<button class="row-remove" data-rm="' + i + '">×</button>' : ''}</td>
    </tr>
  `).join('');

  stagesBody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const i = +e.target.dataset.i;
      const k = e.target.dataset.k;
      if (!k) return;  // unit-toggle button has no data-k
      if (k === 'intensity') {
        if (state.sport === 'running') {
          const mps = readPaceMps(e.target);
          state.stages[i][k] = isFinite(mps) ? mps : 0;
        } else {
          const v = parseFloat(e.target.value);
          state.stages[i][k] = isFinite(v) ? v : 0;
        }
      } else if (k === 'hr')   state.stages[i][k] = e.target.value;
      else                     state.stages[i][k] = +e.target.value;
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

  checkStageWarnings();
}

$('#add-stage').addEventListener('click', () => {
  if (state.stages.length >= 9) return;
  const last = state.stages[state.stages.length - 1];
  state.stages.push({
    intensity: state.sport === 'cycling' ? Math.round(last.intensity + 30) : +(last.intensity + 0.3).toFixed(2),
    durationMin: last.durationMin,
    lactate: +(last.lactate + 2).toFixed(1),
    hr: '',
  });
  renderStages();
});

function checkStageWarnings() {
  const out = [];
  if (state.stages.length < 5) out.push('Need at least 5 stages for a meaningful fit (most tests run 5–9).');
  for (let i = 1; i < state.stages.length; i++) {
    if (state.stages[i].intensity <= state.stages[i - 1].intensity)
      out.push('Stage ' + (i + 1) + ' intensity should exceed stage ' + i + '.');
  }
  let nonMono = 0;
  for (let i = 1; i < state.stages.length; i++) {
    if (state.stages[i].lactate < state.stages[i - 1].lactate - 0.1) nonMono++;
  }
  if (nonMono > 0) out.push(nonMono + ' stage(s) have lower lactate than the prior stage — possible sampling error.');
  const last = state.stages[state.stages.length - 1];
  if (last && last.lactate < 4) out.push('Final stage lactate is ' + last.lactate + ' mmol/L (&lt; 4) — the test may not have reached threshold.');
  for (const s of state.stages) {
    if (s.durationMin < 3) out.push('Stage durations &lt; 3 min may not have reached steady state.');
  }
  $('#stage-warnings').innerHTML = out.length ? out.map(w => '<div class="warn">⚠ ' + w + '</div>').join('') : '';
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

$('#run').addEventListener('click', async () => {
  if (!state.VLamax) {
    alert('VLamax not set — go back to step 2 and save your sprint inputs.');
    gotoStep(2);
    return;
  }
  try {
    const fitStages = stagesToSeaLevel(state.stages);
    state.fitStages = fitStages;
    state.altitudeCorrected = fitStages !== state.stages;
    state.profile = runProfile(fitStages);
    renderResults();
    gotoStep(4);
    await autoSaveSession(state.profile);   // persist (new) or update the active test
  } catch (e) {
    alert('Profile run failed: ' + e.message);
    console.error(e);
  }
});

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

async function persistSessions() {
  const user = window.__esml && window.__esml.user;
  if (!user) throw new Error('Sign in required.');
  await firebase.firestore().collection('users').doc(user.uid).set(
    { esmetlab: { lactateSessions: state.sessions } }, { merge: true });
}

// Auto-save after a run: update the active test in place, or create a new one.
async function autoSaveSession(profile) {
  const user = window.__esml && window.__esml.user;
  if (!user) return;                       // app is auth-gated, but fail safe
  const now = firebase.firestore.Timestamp.now();
  const record = buildSessionRecord(profile);
  const idx = state.activeSessionId
    ? state.sessions.findIndex((s) => s.id === state.activeSessionId) : -1;
  if (idx >= 0) {
    const prev = state.sessions[idx];
    state.sessions[idx] = Object.assign({}, prev, record,
      { id: prev.id, measured_at: prev.measured_at || now, updated_at: now });
  } else {
    const id = generateId();
    state.activeSessionId = id;
    state.sessions.push(Object.assign({ id, measured_at: now }, record));
  }
  try { await persistSessions(); }
  catch (e) { console.error('Test save failed:', e); }
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
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeSessionId === id) state.activeSessionId = null;
  try { await persistSessions(); }
  catch (e) { console.error(e); alert('Delete failed: ' + e.message); }
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
  syncInputsToUI();
  try {
    const fitStages = stagesToSeaLevel(state.stages);
    state.fitStages = fitStages;
    state.altitudeCorrected = fitStages !== state.stages;
    state.profile = runProfile(fitStages);
    renderResults();
    gotoStep(4);
  } catch (e) {
    alert('Could not load that test: ' + e.message);
    console.error(e);
  }
}

// Start a fresh test: clear the active record and reset the test-specific
// inputs (stages, altitude). Athlete details and VLamax carry over.
function newTest() {
  state.activeSessionId = null;
  state.stages = DEFAULT_STAGES.map((s) => Object.assign({}, s));
  state.altitude_m = 0;
  state.profile = null;
  state.fitStages = null;
  applyLatestSessionVLamax();   // default VLamax = most recent test's sprint
  syncInputsToUI();
  gotoStep(1);
}

// Push current state back into the Step 1/3 form controls.
function syncInputsToUI() {
  document.querySelectorAll('input[name=sex]').forEach((r) => { r.checked = (r.value === state.sex); });
  document.querySelectorAll('input[name=sport]').forEach((r) => { r.checked = (r.value === state.sport); });
  const bm = $('#bodyMass'); if (bm) bm.value = state.bodyMass;
  syncAltitudeUnitUI();
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
    + (inp.altitude_m > 0 ? ' · ' + Math.round(inp.altitude_m) + ' m' : '');
  return '<div class="sess-card ' + (isActive ? 'latest' : '') + '" data-session-load="' + s.id + '" style="cursor:pointer">' +
    '<button type="button" class="sess-delete" data-session-delete="' + s.id + '" title="Delete this test" aria-label="Delete this test">Delete</button>' +
    '<div><div class="sess-card-date">' + fmtDate(s.measured_at) + ' ' + activePill + '</div></div>' +
    '<div style="text-align:right">' +
      '<div style="font-family:var(--display);font-size:18px;font-weight:700;color:var(--text);line-height:1.1">VO₂max ' +
        (d.VO2max ?? 0).toFixed(1) + ' <span style="font-family:var(--mono);font-size:10px;color:var(--muted2);font-weight:400">mL/min/kg</span></div>' +
      '<div style="font-family:var(--display);font-size:14px;font-weight:600;color:var(--muted2);margin-top:2px">VLamax ' +
        (d.VLamax ?? 0).toFixed(3) + '</div>' +
    '</div>' +
    '<div class="sess-card-meta">' + meta + '</div>' +
  '</div>';
}

function renderSavedTests() {
  const root = document.getElementById('saved-tests-root');
  if (!root) return;
  if (!state.sessions.length) { root.innerHTML = ''; return; }
  const reversed = [...state.sessions].reverse();
  root.innerHTML =
    '<div class="panel" style="margin-bottom:18px">' +
      '<div class="sess-panel-h">' +
        '<div class="panel-h">Your saved tests</div>' +
        '<button type="button" class="btn primary" id="new-test-btn" style="padding:9px 18px;font-size:13px">+ New test</button>' +
      '</div>' +
      '<div class="sess-list">' + reversed.map(sessionCardHTML).join('') + '</div>' +
      '<div class="sess-foot">Click a test to view it. Editing the inputs and re-running updates that same test; use “+ New test” to start a fresh one.</div>' +
    '</div>';
  root.querySelectorAll('[data-session-load]').forEach((el) =>
    el.addEventListener('click', () => loadSession(el.dataset.sessionLoad)));
  root.querySelectorAll('[data-session-delete]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(btn.dataset.sessionDelete); }));
  const nb = document.getElementById('new-test-btn');
  if (nb) nb.addEventListener('click', newTest);
}

function updateSaveStatus() {
  const el = document.getElementById('save-status');
  if (!el) return;
  const s = state.activeSessionId && state.sessions.find((x) => x.id === state.activeSessionId);
  if (!s) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = '✓ Saved to <strong>Your saved tests</strong>'
    + (s.updated_at ? ' (updated)' : '')
    + '. It’s listed on the Athlete step — edit any input and re-run to update this same test.';
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
    '<div class="metric-value">' + m.value + '</div>' +
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
    ? '<div class="unit-pill" id="pace-unit-pill" role="tablist" aria-label="Pace display unit">'
      + '<button type="button" data-pace-unit="mi" class="' + (u === 'mi' ? 'active' : '') + '">min/mi</button>'
      + '<button type="button" data-pace-unit="km" class="' + (u === 'km' ? 'active' : '') + '">min/km</button>'
    + '</div>'
    : '';

  $('#results-root').innerHTML =
    profileGuideHtml(sport) +
    paceTogglePillHtml +
    '<div class="metric-grid">' + metricsHtml + '</div>' +
    altHtml +
    '<div id="save-status" class="info" style="display:none"></div>' +
    '<div class="report-actions">' +
      '<button class="btn-download-report" id="export-pdf-big" type="button">' +
        '<span class="bdr-icon">⬇</span>' +
        '<span>Download full report as PDF</span>' +
        '<span class="bdr-sub">save · share · print</span>' +
      '</button>' +
    '</div>' +
    precisionExpandableHtml() +
    sensHtml + warnHtml +
    '<div class="panel"><div class="panel-h">Training zones</div>' + zonesHtml + '</div>' +
    '<div class="chart-block"><div class="chart-title">Lactate response across intensities</div>' +
      '<div class="chart-sub">How your blood lactate behaves — and how fast you produce and clear it — at every effort level. Your measured stages are overlaid as yellow dots.</div>' +
      '<div id="chart-lactate" class="plt"></div>' +
      lactateChartExplainerHtml() +
    '</div>' +
    '<div class="chart-block"><div class="chart-title">Fat vs carbohydrate burning</div>' +
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

  const fmtRange = (lo, hi) => {
    const loDef = !(lo === 0 || !isFinite(lo));
    const hiDef = isFinite(hi);
    if (sport === 'cycling') {
      if (!loDef && hiDef) return 'less than ' + Math.round(hi) + ' W';
      if (loDef && !hiDef) return 'more than ' + Math.round(lo) + ' W';
      return Math.round(lo) + ' – ' + Math.round(hi) + ' W';
    }
    if (!loDef && hiDef) return 'slower than ' + fmt.pace(hi);
    if (loDef && !hiDef) return 'faster than ' + fmt.pace(lo);
    return fmt.pace(lo) + ' – ' + fmt.pace(hi);
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
    if (!loDef && hiDef) return 'slower than ' + fmt.pace(altSpeed(hi));
    if (loDef && !hiDef) return 'faster than ' + fmt.pace(altSpeed(lo));
    return fmt.pace(altSpeed(lo)) + ' – ' + fmt.pace(altSpeed(hi));
  };

  const altHeaderCell = showAlt ? '<th>At altitude</th>' : '';
  const altDataCell = (r) => showAlt
    ? '<td class="num" style="color:var(--muted2)">' + fmtAltRange(r.lo, r.hi) + '</td>'
    : '';

  return '<h3 style="font-family:var(--display);font-size:16px;font-weight:600;margin:14px 0 8px">' + title + '</h3>' +
         '<table class="zones"><tr><th>Zone</th><th>Label</th><th>' + (showAlt ? 'Sea level' : 'Range') + '</th>' + altHeaderCell + '</tr>' +
         rows.map(r => '<tr><td>Z' + r.zone + '</td><td>' + r.label + '</td><td class="num">' + fmtRange(r.lo, r.hi) + '</td>' + altDataCell(r) + '</tr>').join('') +
         '</table>';
}

function lactateChartExplainerHtml() {
  return '' +
    '<details class="edu" style="margin-top:14px"><summary>What this chart shows</summary>' +
    '<div class="body">' +
      '<p>Three curves and two reference markers, all plotted against your effort level (x-axis).</p>' +
      '<ul style="margin:0 0 10px 18px;padding:0">' +
        '<li><strong style="color:#8b7cf8">Purple solid line — Predicted blood lactate</strong>. The lactate concentration in your blood you\'d settle at if you held each pace for several minutes. It stays low and flat through easy and moderate efforts, then sweeps upward as you approach threshold.</li>' +
        '<li><strong style="color:#ff6b35">Orange solid line — Lactate production rate</strong>. How fast your muscles are pumping lactate into the blood at each pace. Reads on the right y-axis (mmol per liter per second). Small at easy pace; ramps up steeply once glycolysis kicks in. (Technical name: <em>vLass</em>.)</li>' +
        '<li><strong style="color:#00e5c8">Cyan dotted line — Max lactate clearance rate</strong>. The fastest your body can remove lactate from the blood via oxidation. Also on the right y-axis. Mostly limited by your aerobic capacity. (Technical: <em>vLaoxmax</em>.)</li>' +
        '<li><strong style="color:#f5c842">Yellow dots — Your measured samples</strong>. The lactate readings you recorded at each step-test stage, plotted at the stage\'s pace. These are how the curve gets fit to your physiology.</li>' +
        '<li><strong style="color:#22c78a">Green dashed vertical — MLSS</strong>. The intensity where production meets clearance. Below this you can hold pace indefinitely; above it lactate accumulates without bound and you fade.</li>' +
        '<li><strong style="color:#8b7cf8">Purple dashed vertical — LT1</strong>. Where blood lactate first rises noticeably above resting. The upper edge of your "all-day easy" zone.</li>' +
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
        '<li><strong style="color:#f5c842">Yellow area — Fat burned</strong>. Grams of fat oxidized per minute. Rises through easy and moderate paces, peaks around <strong>Fatmax</strong>, then falls as harder efforts force a shift to carbohydrate.</li>' +
        '<li><strong style="color:#ff6b35">Orange area — Carbs burned</strong>. Grams of carbohydrate (mostly muscle glycogen) oxidized per minute. Small at easy pace; climbs steeply as you push past tempo into threshold and above.</li>' +
        '<li><strong style="color:#f5c842">Yellow dashed vertical — Fatmax</strong>. The intensity where fat-burning is highest in g/min. Long-run / aerobic-base territory.</li>' +
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
    '<p>It\'s the same family of model used commercially by INSCYD and Aerotune. Our implementation is open and inspectable — see the engine source under <code>js/lib/mader/</code>.</p>' +
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
