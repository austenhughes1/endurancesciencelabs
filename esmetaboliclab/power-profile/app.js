/*
 * Power / Pace-only Profile — UI controller.
 *
 * Standalone, no prerequisites: enter 4 max-effort durations + athlete
 * details → derive VLamax + VO2max → run the Mader engine → render the
 * same metric grid + charts as the lactate-anchored profile.
 *
 * Storage:
 *   users/{uid}.esmetlab.powerProfiles[]  — array of saved sessions,
 *                                            newest-last. Entirely separate
 *                                            from .vlamax / .sprintSessions
 *                                            so the lactate-anchored data
 *                                            is never overwritten by the
 *                                            less-accurate estimate.
 */

import { getMetabolicProfile } from '../js/lib/mader/index.js';
import { derivePowerProfile }  from '../js/lib/mader/power-profile.js';
import { altitudeFactor }      from '../js/lib/mader/constants.js';
import { generateZones }       from '../js/ui/zones.js';
import { drawLactateChart, drawSubstrateChart } from '../js/ui/charts.js';
import { downloadPowerProfileReport } from '../js/ui/pdf-report.js';
import { minPerKmToPaceString, paceStringToMinPerKm, speedToPaceString } from '../js/lib/mader/sport.js';
import { distanceInputHTML, wireDistanceInputs, readDistanceMeters, metersToDistanceString, getDefaultDistanceUnit } from '../js/ui/distance-input.js';
import { getDefaultPaceUnit, setDefaultPaceUnit } from '../js/ui/pace-input.js';
import { showConfirmModal } from '../js/ui/confirm-modal.js';
import { profileGuideHtml } from '../js/ui/profile-guide.js';

const $   = (sel) => document.querySelector(sel);
const $$  = (sel) => Array.from(document.querySelectorAll(sel));

/* Mass + altitude unit handling.
   Canonical storage is always kg / metres; display unit is per-user, kept in
   localStorage so the preference persists across visits. Conversions live
   here so the rest of the controller only ever sees canonical values. */
const LB_PER_KG = 2.2046226218;
const FT_PER_M  = 3.2808398950;
function getMassUnit() {
  try { return localStorage.getItem('esml-mass-unit') === 'lb' ? 'lb' : 'kg'; }
  catch (e) { return 'kg'; }
}
function setMassUnit(u) {
  try { if (u === 'lb' || u === 'kg') localStorage.setItem('esml-mass-unit', u); }
  catch (e) { /* private mode etc — fine */ }
}
function getAltUnit() {
  try { return localStorage.getItem('esml-alt-unit') === 'ft' ? 'ft' : 'm'; }
  catch (e) { return 'm'; }
}
function setAltUnit(u) {
  try { if (u === 'ft' || u === 'm') localStorage.setItem('esml-alt-unit', u); }
  catch (e) { /* private mode etc — fine */ }
}
function kgToDisplay(kg, unit) {
  if (!isFinite(kg)) return '';
  return unit === 'lb' ? Math.round(kg * LB_PER_KG * 10) / 10 : Math.round(kg * 10) / 10;
}
function displayToKg(val, unit) {
  const v = parseFloat(val);
  if (!isFinite(v)) return NaN;
  return unit === 'lb' ? v / LB_PER_KG : v;
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

const fmt = {
  W:   (v) => v.toFixed(0) + ' W',
  V:   (v) => v.toFixed(1) + ' mL/min/kg',
  La:  (v) => v.toFixed(2) + ' mmol/L',
  G:   (v) => v.toFixed(2) + ' g/min',
  pct: (v) => (v * 100).toFixed(1) + '%',
  ms:  (v) => v.toFixed(2) + ' m/s',
  pace:(v) => speedToPaceString(v, getDefaultPaceUnit()),
};
const db = firebase.firestore();

/* ───────── State ───────── */

const state = {
  sport: 'running',
  sex: 'M',
  bodyMass: 70,
  altitude_m: 0,
  efforts: { sprint15s: '', peak3min: '', peak6min: '', peak12min: '' },
  sessions: [],
  newFormOpen: false,
  profile: null,        // active profile (latest session) for results pane
};

/* ───────── Helpers ───────── */

function fmtDate(ts) {
  if (!ts) return '—';
  let d;
  if (ts.toDate) d = ts.toDate();
  else d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtIntensity(sport, v) {
  return sport === 'cycling' ? fmt.W(v) : fmt.pace(v);
}

/* Effort durations in seconds — used to convert between distance (what the
 * user enters for running) and m/s (what the engine consumes). */
const EFFORT_DUR_S = {
  sprint15s: 15,
  peak3min:  180,
  peak6min:  360,
  peak12min: 720,
};

function parseCyclingPower(raw) {
  const v = parseFloat(raw);
  return isFinite(v) ? v : NaN;
}

/** Cycling placeholders by duration. Running uses distance-input placeholders. */
function cyclingPlaceholder(duration) {
  return ({ sprint15s: '1000', peak3min: '380', peak6min: '340', peak12min: '305' })[duration];
}

/** Per-unit running distance placeholders (typical values for a trained runner). */
const RUNNING_DIST_PLACEHOLDERS = {
  sprint15s: { m: '100',  mi: '0.062' },
  peak3min:  { m: '1000', mi: '0.62'  },
  peak6min:  { m: '1900', mi: '1.18'  },
  peak12min: { m: '3500', mi: '2.17'  },
};

function generateId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ───────── Firestore: load + save ───────── */

async function loadSessions(user) {
  try {
    const doc = await db.collection('users').doc(user.uid).get();
    const data = doc.exists ? doc.data() : null;
    const esml = (data && data.esmetlab) || {};
    state.sessions = Array.isArray(esml.powerProfiles) ? esml.powerProfiles.slice() : [];

    // Auto-load the latest session's profile so results show on landing.
    // First-time visitors (no saved profiles) get the new-profile form
    // expanded by default so they can start entering efforts immediately.
    if (state.sessions.length > 0) {
      const latest = state.sessions[state.sessions.length - 1];
      hydrateActiveFromSession(latest);
    } else {
      state.newFormOpen = true;
    }
    render();
  } catch (e) {
    console.error('Power profiles load failed:', e);
    state.sessions = [];
    state.newFormOpen = true;
    render();
  }
}

function hydrateActiveFromSession(s) {
  // Replay the session through the engine so we have curves to chart
  if (!s || !s.derived || !s.inputs) return;
  try {
    state.profile = getMetabolicProfile({
      sport: s.inputs.sport,
      sex:   s.inputs.sex,
      bodyMass: s.inputs.bodyMass,
      VLamax: s.derived.VLamax,
      VO2max: s.derived.VO2max,
      steps: [],
    });
    state.sport = s.inputs.sport;
    state.sex   = s.inputs.sex;
    state.bodyMass = s.inputs.bodyMass;
    state.altitude_m = s.inputs.altitude_m || 0;
  } catch (e) {
    console.warn('Replay failed:', e);
  }
}

async function saveSession(derived, sportInputs) {
  const user = window.__esml && window.__esml.user;
  if (!user) throw new Error('Sign in required.');

  const session = {
    id: generateId(),
    measured_at: firebase.firestore.Timestamp.now(),
    inputs: {
      sport:       sportInputs.sport,
      sex:         sportInputs.sex,
      bodyMass:    sportInputs.bodyMass,
      altitude_m:  sportInputs.altitude_m || 0,
      efforts:     sportInputs.efforts,
    },
    derived: {
      VLamax: derived.VLamax,
      VO2max: derived.VO2max,
    },
  };
  const newSessions = [...state.sessions, session];
  await db.collection('users').doc(user.uid).set({
    esmetlab: { powerProfiles: newSessions },
  }, { merge: true });

  state.sessions = newSessions;
  state.newFormOpen = false;
  hydrateActiveFromSession(session);
  render();
  window.scrollTo({ top: document.querySelector('#results-block').offsetTop - 24, behavior: 'smooth' });
}

async function deleteSession(id) {
  const user = window.__esml && window.__esml.user;
  if (!user) throw new Error('Sign in required.');
  const newSessions = state.sessions.filter((s) => s.id !== id);
  await db.collection('users').doc(user.uid).set({
    esmetlab: { powerProfiles: newSessions },
  }, { merge: true });
  state.sessions = newSessions;
  if (newSessions.length > 0) {
    // Re-hydrate the new latest session as the active profile
    hydrateActiveFromSession(newSessions[newSessions.length - 1]);
  } else {
    // No sessions left — clear the active profile and re-open the new-
    // profile form so the user can start over without an extra click.
    state.profile = null;
    state.newFormOpen = true;
  }
  render();
}

/* ───────── New-session form (inline) ───────── */

function newFormHTML() {
  // Prefer the last saved session as a prefill source, but only if it
  // matches the currently-selected sport — different sports use different
  // intensity units and we don't want to splat watts into a running form.
  const last = state.sessions[state.sessions.length - 1];
  const lastMatches = last && last.inputs && last.inputs.sport === state.sport;
  const prefill = lastMatches
    ? {
        sport: last.inputs.sport, sex: last.inputs.sex,
        bodyMass: last.inputs.bodyMass,
        altitude_m: last.inputs.altitude_m != null ? last.inputs.altitude_m : 0,
        efforts: last.inputs.efforts || state.efforts,
      }
    : {
        sport: state.sport, sex: state.sex,
        bodyMass: state.bodyMass,
        altitude_m: state.altitude_m || 0,
        efforts: state.efforts,
      };

  const isRunning = prefill.sport === 'running';
  const massUnit = getMassUnit();
  const altUnit  = getAltUnit();

  // For running, convert the stored m/s into meters so the form displays
  // the distance the user actually ran. Cycling stays in raw watts.
  const effortValueAttr = (key) => {
    const v = prefill.efforts && prefill.efforts[key];
    if (!isFinite(+v) || +v <= 0) return '';
    return isRunning ? metersToDistanceString(+v * EFFORT_DUR_S[key], getDefaultDistanceUnit()) : v;
  };
  // Render a single effort input — distance-input for running, plain power input for cycling
  const effortInput = (key, idSuffix) => {
    if (isRunning) {
      const meters = prefill.efforts && isFinite(+prefill.efforts[key]) && +prefill.efforts[key] > 0
        ? +prefill.efforts[key] * EFFORT_DUR_S[key]
        : null;
      return distanceInputHTML({
        id: 'ps-' + idSuffix,
        meters: meters,
        placeholders: RUNNING_DIST_PLACEHOLDERS[key],
      });
    }
    // Cycling: power is always watts, so show a fixed "W" unit chip on the
    // right edge — same slot the running fields use for their m | mi toggle.
    return `
      <div class="pace-input">
        <input type="text" class="pace-text" id="ps-${idSuffix}" inputmode="decimal" autocomplete="off"
               placeholder="${cyclingPlaceholder(key)}" value="${prefill.efforts && prefill.efforts[key] || ''}">
        <div class="unit-static">W</div>
      </div>`;
  };

  const subCopy = isRunning
    ? `For each duration, run all-out and record the distance you covered.
       On a <strong>track</strong>, read off the exact meters. On a
       <strong>flat outdoor route with GPS</strong>, record the miles.
       Toggle the unit on any field. Each effort must be a <strong>genuine
       maximum</strong> — pacing leaves the result unreliable.`
    : `Use your best 15-second sprint, 3-minute, 6-minute, and 12-minute
       all-out efforts. These can come from a structured field test you
       run today or from prior race / interval files in TrainingPeaks /
       Strava / Garmin. Each must be a <strong>genuine maximum</strong> for
       that duration; pacing leaves the result unreliable.`;

  const effortHeader = isRunning ? 'Distance covered in each duration' : 'Max effort power (W)';
  const sprintHint   = isRunning ? 'Track: usually 90–130 m at race speed' : 'Average across the full 15 seconds, not the 1-sec peak';
  const sixMinHint   = isRunning ? 'VO₂max-equivalent effort — the headline number' : 'VO₂max-equivalent intensity — the headline number';

  return `
    <div class="new-session-card" id="ps-form">
      <div class="new-session-h">
        <div class="h-title">▶ New power profile</div>
        <button type="button" class="btn ghost" id="ps-cancel" style="padding:7px 14px;font-size:12px">Cancel</button>
      </div>
      <p class="new-session-sub">${subCopy}</p>

      <div class="grid-2">
        <div class="field">
          <span class="lab">Sport</span>
          <div class="radio-row">
            <label><input type="radio" name="ps-sport" value="running"${prefill.sport === 'running' ? ' checked' : ''}><span>Running</span></label>
            <label><input type="radio" name="ps-sport" value="cycling"${prefill.sport === 'cycling' ? ' checked' : ''}><span>Cycling</span></label>
          </div>
        </div>
        <div class="field">
          <span class="lab">Sex</span>
          <div class="radio-row">
            <label><input type="radio" name="ps-sex" value="M"${prefill.sex === 'M' ? ' checked' : ''}><span>♂ Male</span></label>
            <label><input type="radio" name="ps-sex" value="F"${prefill.sex === 'F' ? ' checked' : ''}><span>♀ Female</span></label>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <label class="field">
          <span class="lab">Body mass</span>
          <div class="pace-input">
            <input type="number" class="pace-text" id="ps-mass" step="0.1"
                   min="${massUnit === 'lb' ? Math.round(30 * LB_PER_KG) : 30}"
                   max="${massUnit === 'lb' ? Math.round(160 * LB_PER_KG) : 160}"
                   value="${kgToDisplay(prefill.bodyMass, massUnit)}">
            <div class="unit-toggle-inline" data-mass-toggle role="tablist" aria-label="Mass unit">
              <button type="button" data-mass-unit="lb"${massUnit === 'lb' ? ' class="active"' : ''}>lb</button>
              <button type="button" data-mass-unit="kg"${massUnit === 'kg' ? ' class="active"' : ''}>kg</button>
            </div>
          </div>
        </label>
        <label class="field">
          <span class="lab">Testing altitude</span>
          <div class="pace-input">
            <input type="number" class="pace-text" id="ps-alt"
                   step="${altUnit === 'ft' ? 100 : 50}"
                   min="0"
                   max="${altUnit === 'ft' ? Math.round(5000 * FT_PER_M) : 5000}"
                   value="${mToDisplay(prefill.altitude_m, altUnit)}" placeholder="0">
            <div class="unit-toggle-inline" data-alt-toggle role="tablist" aria-label="Altitude unit">
              <button type="button" data-alt-unit="ft"${altUnit === 'ft' ? ' class="active"' : ''}>ft</button>
              <button type="button" data-alt-unit="m"${altUnit === 'm' ? ' class="active"' : ''}>m</button>
            </div>
          </div>
          <span class="hint">Performance loss begins ~800 m / 2,600 ft. Boulder ≈ 1650 m, Denver ≈ 1600 m. Zones reported as sea-level equivalents.</span>
        </label>
      </div>

      <div style="margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--muted2);letter-spacing:.5px;text-transform:uppercase">${effortHeader}</div>
      <div class="grid-2" style="margin-top:6px">
        <label class="field">
          <span class="lab">15-second sprint</span>
          ${effortInput('sprint15s', 'sprint')}
          <span class="hint">${sprintHint}</span>
        </label>
        <label class="field">
          <span class="lab">3-minute max</span>
          ${effortInput('peak3min', '3min')}
        </label>
      </div>
      <div class="grid-2">
        <label class="field">
          <span class="lab">6-minute max</span>
          ${effortInput('peak6min', '6min')}
          <span class="hint">${sixMinHint}</span>
        </label>
        <label class="field">
          <span class="lab">12-minute max</span>
          ${effortInput('peak12min', '12min')}
        </label>
      </div>

      <div class="new-session-result" id="ps-result"></div>
      <div class="new-session-actions">
        <button type="button" class="btn primary" id="ps-save">Save profile</button>
      </div>
    </div>
  `;
}

function wireNewForm() {
  const sportRadios = document.querySelectorAll('input[name="ps-sport"]');
  sportRadios.forEach((r) => r.addEventListener('change', (e) => {
    // Persist the new sport to state, clear effort values (units don't carry
    // across sports), and re-render with the form still open.
    state.sport = e.target.value;
    state.efforts = { sprint15s: '', peak3min: '', peak6min: '', peak12min: '' };
    state.newFormOpen = true;
    render();
  }));

  ['ps-mass', 'ps-alt', 'ps-sprint', 'ps-3min', 'ps-6min', 'ps-12min'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener('input', recalcPreview);
  });

  // Mass unit toggle (lb | kg) — convert the current input value to the new
  // unit in place, update min/max, and persist the choice. Don't re-render
  // the whole form so the user keeps caret position on other fields.
  document.querySelectorAll('[data-mass-toggle] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const newUnit = btn.dataset.massUnit;
      const oldUnit = getMassUnit();
      if (newUnit === oldUnit) return;
      const input = $('#ps-mass');
      if (input) {
        const kg = displayToKg(input.value, oldUnit);
        if (isFinite(kg)) input.value = String(kgToDisplay(kg, newUnit));
        input.min = newUnit === 'lb' ? Math.round(30 * LB_PER_KG) : 30;
        input.max = newUnit === 'lb' ? Math.round(160 * LB_PER_KG) : 160;
      }
      setMassUnit(newUnit);
      btn.parentElement.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      recalcPreview();
    });
  });

  // Altitude unit toggle (ft | m) — same pattern.
  document.querySelectorAll('[data-alt-toggle] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const newUnit = btn.dataset.altUnit;
      const oldUnit = getAltUnit();
      if (newUnit === oldUnit) return;
      const input = $('#ps-alt');
      if (input) {
        const m = displayToM(input.value, oldUnit);
        input.value = m > 0 ? String(mToDisplay(m, newUnit)) : '';
        input.step = newUnit === 'ft' ? 100 : 50;
        input.max = newUnit === 'ft' ? Math.round(5000 * FT_PER_M) : 5000;
      }
      setAltUnit(newUnit);
      btn.parentElement.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      recalcPreview();
    });
  });

  $('#ps-cancel').addEventListener('click', () => {
    state.newFormOpen = false;
    render();
  });

  $('#ps-save').addEventListener('click', onSave);

  // For running, wire the distance-unit toggle and recompute on flip
  if (state.sport === 'running') {
    wireDistanceInputs(() => recalcPreview());
  }

  recalcPreview();
}

function readForm() {
  const sport = (document.querySelector('input[name="ps-sport"]:checked') || {}).value || 'running';
  const sex   = (document.querySelector('input[name="ps-sex"]:checked')   || {}).value || 'M';
  // Read mass + altitude in their current display unit and normalize
  // to canonical (kg, metres) before they leave the form.
  const bodyMass   = displayToKg($('#ps-mass').value, getMassUnit());
  const altRawM    = displayToM($('#ps-alt').value, getAltUnit());
  const altitude_m = (isFinite(altRawM) && altRawM > 0) ? altRawM : 0;

  // Running: the form holds distances; convert to m/s via the known duration.
  // Cycling: the form holds watts directly.
  function readOne(idSuffix, key) {
    const el = $('#ps-' + idSuffix);
    if (!el) return NaN;
    if (sport === 'running') {
      const meters = readDistanceMeters(el);
      if (!isFinite(meters) || meters <= 0) return NaN;
      return meters / EFFORT_DUR_S[key];
    }
    return parseCyclingPower(el.value);
  }
  const efforts = {
    sprint15s: readOne('sprint',  'sprint15s'),
    peak3min:  readOne('3min',    'peak3min'),
    peak6min:  readOne('6min',    'peak6min'),
    peak12min: readOne('12min',   'peak12min'),
  };
  return { sport, sex, bodyMass, altitude_m, efforts };
}

/**
 * Convert altitude-measured efforts into sea-level equivalents.
 * The 15-second sprint is alactic and altitude-neutral, so it passes through.
 * The 3/6/12-min efforts are mostly aerobic, so we divide by the altitude
 * factor at near-MLSS intensity (x=1.0) to recover sea-level performance.
 */
function effortsToSeaLevel(efforts, sport, altitude_m) {
  if (sport !== 'running' || !(altitude_m > 0)) return efforts;
  // 3/6/12-min max efforts sit at or near VO₂max-equivalent intensity
  // (x_rel ≈ 1.15+ relative to MLSS), so use the ceiling-intensity factor.
  // 15-second sprint is alactic and passes through unchanged.
  const f = altitudeFactor(altitude_m, 1.15);
  if (f >= 1) return efforts;
  return {
    sprint15s: efforts.sprint15s,
    peak3min:  efforts.peak3min  / f,
    peak6min:  efforts.peak6min  / f,
    peak12min: efforts.peak12min / f,
  };
}

function effortsComplete(efforts) {
  return Object.values(efforts).every((v) => isFinite(v) && v > 0);
}

function recalcPreview() {
  const inputs = readForm();
  if (!isFinite(inputs.bodyMass) || inputs.bodyMass <= 0
      || !effortsComplete(inputs.efforts)) {
    $('#ps-result').innerHTML = '<div class="vlc-result-empty" style="font-family:var(--mono);font-size:12px;color:var(--muted2);padding:12px 14px;background:var(--panel2);border-radius:8px;border:1px dashed var(--border2)">Fill in body mass and all four efforts to preview your derived VO₂max and VLamax.</div>';
    return;
  }

  // Altitude correction: convert altitude-measured efforts into sea-level
  // equivalents before the engine sees them, so VO2max / zones come out
  // as sea-level fitness.
  const seaEfforts = effortsToSeaLevel(inputs.efforts, inputs.sport, inputs.altitude_m);

  let derived;
  try {
    derived = derivePowerProfile({
      sport: inputs.sport, sex: inputs.sex,
      bodyMass: inputs.bodyMass,
      efforts: seaEfforts,
    });
  } catch (e) {
    $('#ps-result').innerHTML = '<div class="warn">⚠ ' + e.message + '</div>';
    return;
  }

  const warnHtml = derived.diagnostics.warnings.length
    ? derived.diagnostics.warnings.map((w) => '<div class="warn" style="margin-top:8px">⚠ ' + w + '</div>').join('')
    : '';
  $('#ps-result').innerHTML = `
    <div class="new-session-result-box">
      <div class="new-session-result-label">DERIVED ESTIMATES (preview)</div>
      <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:4px">
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted2);letter-spacing:.6px">VO₂max</div>
          <div class="new-session-result-val">${derived.VO2max.toFixed(1)}<span class="unit">mL/min/kg</span></div>
        </div>
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted2);letter-spacing:.6px">VLamax</div>
          <div class="new-session-result-val">${derived.VLamax.toFixed(3)}<span class="unit">mmol·L⁻¹·s⁻¹</span></div>
        </div>
      </div>
    </div>
    ${warnHtml}
  `;
}

async function onSave() {
  const inputs = readForm();
  if (!effortsComplete(inputs.efforts)) {
    alert('Please fill in all four effort durations.');
    return;
  }
  let derived;
  try {
    const seaEfforts = effortsToSeaLevel(inputs.efforts, inputs.sport, inputs.altitude_m);
    derived = derivePowerProfile({
      sport: inputs.sport, sex: inputs.sex,
      bodyMass: inputs.bodyMass,
      efforts: seaEfforts,
    });
  } catch (e) {
    alert(e.message);
    return;
  }
  const btn = $('#ps-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveSession(derived, inputs);
  } catch (e) {
    console.error(e);
    alert('Save failed: ' + e.message);
    btn.disabled = false; btn.textContent = 'Save profile';
  }
}

/* ───────── Sessions list render ───────── */

function effortsLine(sport, efforts) {
  if (!efforts) return '';
  if (sport === 'cycling') {
    const f = (v) => Math.round(v) + ' W';
    return `15s ${f(efforts.sprint15s)} · 3m ${f(efforts.peak3min)} · 6m ${f(efforts.peak6min)} · 12m ${f(efforts.peak12min)}`;
  }
  // Running: convert each m/s back into the distance covered, displayed in
  // the user's current preferred unit (m or mi).
  const unit = getDefaultDistanceUnit();
  const dist = (mps, durKey) => {
    const meters = mps * EFFORT_DUR_S[durKey];
    return metersToDistanceString(meters, unit) + ' ' + unit;
  };
  return `15s ${dist(efforts.sprint15s, 'sprint15s')} · 3m ${dist(efforts.peak3min, 'peak3min')} · 6m ${dist(efforts.peak6min, 'peak6min')} · 12m ${dist(efforts.peak12min, 'peak12min')}`;
}

function sessionCardHTML(s, isLatest) {
  const sport = (s.inputs && s.inputs.sport) || 'running';
  const latestPill = isLatest ? '<span class="latest-pill">Latest · active</span>' : '';
  const derived = s.derived || {};
  return `
    <div class="sess-card ${isLatest ? 'latest' : ''}">
      <button type="button" class="sess-delete" data-session-delete="${s.id}" title="Delete this session" aria-label="Delete this session">Delete</button>
      <div>
        <div class="sess-card-date">${fmtDate(s.measured_at)} ${latestPill}</div>
      </div>
      <div style="text-align:right">
        <div style="font-family:var(--display);font-size:18px;font-weight:700;color:var(--text);line-height:1.1">
          VO₂max ${(derived.VO2max ?? 0).toFixed(1)} <span style="font-family:var(--mono);font-size:10px;color:var(--muted2);font-weight:400">mL/min/kg</span>
        </div>
        <div style="font-family:var(--display);font-size:14px;font-weight:600;color:var(--muted2);margin-top:2px">
          VLamax ${(derived.VLamax ?? 0).toFixed(3)}
        </div>
      </div>
      <div class="sess-card-meta">${effortsLine(sport, s.inputs && s.inputs.efforts)}</div>
    </div>
  `;
}

function sessionsPanelHTML() {
  if (state.sessions.length === 0) {
    return `
      <div class="panel">
        <div class="sess-panel-h">
          <div class="panel-h">Your power profiles</div>
        </div>
        <div class="sess-empty">
          <p>You haven't saved a power profile yet. Enter your four max efforts to derive a metabolic estimate.</p>
          <button type="button" class="btn primary" id="open-new-profile">+ Start your first profile</button>
        </div>
      </div>
    `;
  }
  const reversed = [...state.sessions].reverse();
  const latestId = state.sessions[state.sessions.length - 1].id;
  return `
    <div class="panel">
      <div class="sess-panel-h">
        <div class="panel-h">Your power profiles</div>
        <button type="button" class="btn primary" id="open-new-profile" style="padding:9px 18px;font-size:13px">+ New profile</button>
      </div>
      <div class="sess-list">
        ${reversed.map((s) => sessionCardHTML(s, s.id === latestId)).join('')}
      </div>
      <div class="sess-foot">The latest profile is active and shown below.</div>
    </div>
  `;
}

/* ───────── Results render ───────── */

function resultsBlockHTML() {
  if (!state.profile) return '<div id="results-block"></div>';
  const p = state.profile;
  const sport = state.sport;

  const metrics = [
    { label: 'VO₂max', value: fmt.V(p.VO2max),
      meaning: 'Your aerobic ceiling — the most oxygen your body can use per minute.',
      detail:  'estimated from your 6-min max effort' },
    { label: 'VLamax', value: p.VLamax.toFixed(3) + ' mmol/L/s',
      meaning: 'How fast your body produces lactate at all-out sprint effort.',
      detail:  'estimated from your 15-s sprint' },
    { label: 'MLSS',   value: fmtIntensity(sport, p.mlss.intensity),
      meaning: 'Maximum sustainable hard effort — about half-marathon / 1-hour race pace.',
      detail:  fmt.pct(p.mlss.x) + ' of VO₂max · ' + fmt.La(p.mlss.lactate) },
    { label: 'LT1',    value: fmtIntensity(sport, p.lt1.intensity),
      meaning: 'Top of your easy zone — above this, lactate starts to rise above baseline.',
      detail:  fmt.pct(p.lt1.x) + ' of VO₂max' },
    { label: 'Fatmax', value: fmtIntensity(sport, p.fatmax.intensity),
      meaning: 'Where you burn the most fat in g/min — long-run / aerobic-base territory.',
      detail:  fmt.G(p.fatmax.fat_g_per_min) + ' at ' + fmt.pct(p.fatmax.x) },
  ];
  const metricsHtml = metrics.map((m) =>
    '<div class="metric"><div class="metric-label">' + m.label + '</div>' +
    '<div class="metric-value">' + m.value + '</div>' +
    (m.meaning ? '<div class="metric-meaning">' + m.meaning + '</div>' : '') +
    (m.detail  ? '<div class="metric-note">'    + m.detail  + '</div>' : '') +
    '</div>').join('');

  const warnHtml = (p.diagnostics.warnings || []).map((w) => '<div class="warn">⚠ ' + w + '</div>').join('');

  const zones = generateZones(sport, { MLSS_intensity: p.mlss.intensity, LT1_intensity: p.lt1.intensity });
  const zoneOpts = { altitude_m: state.altitude_m || 0, mlss_speed: p.mlss.intensity };
  let zonesHtml = '';
  if (zones.coggan) zonesHtml += zoneTableHtml('Coggan 7-zone (cycling)', zones.coggan, sport, zoneOpts);
  if (zones.friel)  zonesHtml += zoneTableHtml('Friel 7-zone (running)',  zones.friel,  sport, zoneOpts);
  if (zones.seiler) zonesHtml += zoneTableHtml('Seiler 3-zone',           zones.seiler, sport, zoneOpts);

  const u = getDefaultPaceUnit();
  const paceTogglePillHtml = sport === 'running'
    ? '<div class="unit-pill" id="pace-unit-pill" role="tablist" aria-label="Pace display unit">'
      + '<button type="button" data-pace-unit="mi" class="' + (u === 'mi' ? 'active' : '') + '">min/mi</button>'
      + '<button type="button" data-pace-unit="km" class="' + (u === 'km' ? 'active' : '') + '">min/km</button>'
    + '</div>'
    : '';

  return `
    <div id="results-block">
      <h2 style="font-family:var(--display);font-size:24px;font-weight:700;margin:30px 0 14px">Active profile</h2>
      ${profileGuideHtml(sport)}
      ${paceTogglePillHtml}
      <div class="metric-grid">${metricsHtml}</div>
      <div class="report-actions">
        <button class="btn-download-report" id="export-power-pdf" type="button">
          <span class="bdr-icon">⬇</span>
          <span>Download profile as PDF</span>
          <span class="bdr-sub">save · share · print</span>
        </button>
      </div>
      ${precisionExpandableHtml()}
      ${warnHtml}
      <div class="panel"><div class="panel-h">Training zones</div>${zonesHtml}</div>
      <div class="chart-block">
        <div class="chart-title">Lactate response across intensities</div>
        <div class="chart-sub">How your blood lactate behaves — and how fast you produce and clear it — at every effort level.</div>
        <div id="chart-lactate" class="plt"></div>
        ${lactateChartExplainerHtml()}
      </div>
      <div class="chart-block">
        <div class="chart-title">Fat vs carbohydrate burning</div>
        <div class="chart-sub">Grams of fat and carbs burned per minute at each intensity. Fatmax (yellow dashed line) is where fat-burning peaks.</div>
        <div id="chart-substrate" class="plt"></div>
        ${substrateChartExplainerHtml()}
      </div>
      ${upsellCardHtml()}
      <details class="edu" style="margin-top:18px">
        <summary>How are these numbers derived?</summary>
        <div class="body">
          <p><strong>VLamax</strong> comes from your 15-second sprint effort, via an empirical linear regression calibrated to typical population ranges (cycling: relative sprint power in W/kg; running: average sprint speed in m/s). This is the least-reliable part of the estimate — VLamax varies substantially at any given sprint output, and individual phenotype matters a lot.</p>
          <p><strong>VO₂max — running.</strong> We use Léger's 1980 / 1984 empirical relation: <code>VO₂max (mL/min/kg) ≈ 12.6 × v</code>, where <em>v</em> is your 6-minute max speed in m/s. The 6-min max is treated as your "MAS" (Maximal Aerobic Speed — the velocity at which VO₂max is reached). Léger's regression is validated across hundreds of athletes and bakes in the population-typical mix of running economy plus the small anaerobic contribution at 6-min duration.</p>
          <p><strong>VO₂max — cycling.</strong> We compute the oxygen demand of your 6-minute power directly: <code>VO₂max ≈ P × 60 / (GE × 20.9) / bodyMass</code>, assuming a gross efficiency of 22.5%. Cyclists can sustain near-VO₂max for ~6 minutes, so no additional scale factor is applied.</p>
          <p><strong>Altitude correction.</strong> Enter your testing altitude in the form and the tool normalises automatically. Performance loss begins around 800 m and grows linearly with altitude; at 6-min duration it's roughly 0.5% per 100 m above 800 m (Faulkner 1968, Wagner 2000). We invert that to recover your sea-level VO₂max via Léger, then derive zones at sea level. The 15-second sprint is alactic and altitude-neutral, so VLamax passes through unchanged. The zones table also shows altitude-equivalent paces in a second column when you've entered a testing altitude — each zone bound gets an intensity-scaled penalty (Daniels & Gilbert 1979 conversion tables: ~1% slower at recovery effort, ~2–3% at marathon-pace effort, ~5% at VO₂max effort) so easy runs at altitude don't get over-corrected the way hard intervals do.</p>
          <p><strong>One internal compromise.</strong> Léger's regression for the forward VO₂max step has an implicit running cost of <code>Cr ≈ 4.39 J·kg⁻¹·m⁻¹</code>. The engine's inverse (VO₂ → speed for MLSS, LT1, Fatmax, zones) uses <code>Cr = 4.20 J·kg⁻¹·m⁻¹</code> — a population-average that splits the difference between submaximal Cr (3.86, di Prampero) and max-effort Cr (4.39, Léger). The mismatch comes from the fact that one regression is keyed to max-effort tests and the other to lab calorimetry. Highly efficient runners (Cr ≈ 3.6–3.9) will see their MLSS and zone paces slightly under-estimated; less efficient runners (Cr ≈ 4.3–4.6), slightly over-estimated. A per-athlete Cr would fix this; a single global value can't.</p>
          <p>Once VO₂max and VLamax are settled, the Mader/Heck engine runs exactly as it would on lactate-anchored values — MLSS, LT1, Fatmax, and substrate curves come from the same equations. References: Léger &amp; Lambert 1980; Léger &amp; Mercier 1984; di Prampero 1986; Mader &amp; Heck 1986.</p>
        </div>
      </details>
    </div>
  `;
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

function upsellCardHtml() {
  return '' +
    '<div class="upsell">' +
      '<div class="upsell-eyebrow">◆ Want the real numbers?</div>' +
      '<h3>This is an <em>estimate</em>. The lactate test is the measurement.</h3>' +
      '<p>The profile above is back-derived from your power and pace alone. It\'s a useful starting point — but VLamax in particular can be off by 5–15% at any given sprint power, which cascades into MLSS, Fatmax, and your zones. A blood-lactate test pins down the curve directly: same Mader / Heck model used by INSCYD and the sports-science labs, anchored to your actual physiology.</p>' +
      '<p>Two paths from here: have an Endurance Science Labs coach run the full sprint + step-test protocol with you in person (we bring the meter), or grab upload access and run the test yourself at home for a fraction of what a commercial lab session costs.</p>' +
      '<div class="row">' +
        '<a href="/esmetaboliclab/in-person/" class="btn primary">Book an in-person test — $145 →</a>' +
        '<a href="/esmetaboliclab/pricing/" class="btn">Upload your own lactate data →</a>' +
      '</div>' +
    '</div>';
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

function zoneTableHtml(title, rows, sport, opts) {
  opts = opts || {};
  const altitude_m = opts.altitude_m || 0;
  const mlss_speed = opts.mlss_speed || 0;
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

  // Altitude-adjusted speed for a given sea-level boundary speed.
  // Uses intensity factor at x = speed/MLSS_speed so each zone bound gets
  // its own duration-appropriate penalty.
  const altSpeed = (v) => {
    if (!isFinite(v) || v <= 0) return v;
    const xRel = v / mlss_speed;
    return v * altitudeFactor(altitude_m, xRel);
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
         rows.map((r) => '<tr><td>Z' + r.zone + '</td><td>' + r.label + '</td><td class="num">' + fmtRange(r.lo, r.hi) + '</td>' + altDataCell(r) + '</tr>').join('') +
         '</table>';
}

/* ───────── Top-level render ───────── */

function render() {
  const root = $('#root');
  let html = '';
  if (state.newFormOpen) html += newFormHTML();
  // Skip the empty sessions panel when the new-profile form is already
  // open and the user has no saved sessions — the panel would just say
  // "you haven't saved a profile yet" with a button to do what they're
  // already doing.
  if (!(state.sessions.length === 0 && state.newFormOpen)) {
    html += sessionsPanelHTML();
  }
  html += resultsBlockHTML();
  root.innerHTML = html;

  if (state.newFormOpen) wireNewForm();

  const openBtn = $('#open-new-profile');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      state.newFormOpen = true;
      render();
      const card = $('#ps-form');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Wire the per-card delete buttons
  document.querySelectorAll('[data-session-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.sessionDelete;
      const ok = await showConfirmModal({
        title: 'Delete this power profile?',
        body: 'This permanently removes this saved session. The next-most-recent session (if any) will become your active profile. This cannot be undone.',
        confirmLabel: 'Delete',
        cancelLabel: 'Keep it',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await deleteSession(id);
      } catch (err) {
        console.error('Delete failed:', err);
        alert('Failed to delete: ' + (err.message || err));
        btn.disabled = false;
      }
    });
  });

  // Wire the pace-unit pill toggle (running results only)
  const pillRoot = $('#pace-unit-pill');
  if (pillRoot) {
    pillRoot.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        setDefaultPaceUnit(b.dataset.paceUnit);
        render();
      });
    });
  }

  // Wire the PDF export button on the results block
  const pdfBtn = $('#export-power-pdf');
  if (pdfBtn) {
    pdfBtn.addEventListener('click', async () => {
      if (!state.profile) return;
      if (!window.jspdf || !window.jspdf.jsPDF) {
        alert('PDF library not loaded yet — try again in a moment.');
        return;
      }
      const label = pdfBtn.querySelector('span:nth-child(2)');
      const orig = label ? label.textContent : pdfBtn.textContent;
      pdfBtn.disabled = true;
      if (label) label.textContent = 'Building PDF…';
      try {
        await downloadPowerProfileReport({
          profile:    state.profile,
          sport:      state.sport,
          bodyMass:   state.bodyMass,
          sex:        state.sex,
          altitude_m: state.altitude_m || 0,
        });
      } catch (e) {
        console.error('PDF export failed:', e);
        alert('Couldn’t build the PDF: ' + (e.message || e));
      } finally {
        pdfBtn.disabled = false;
        if (label) label.textContent = orig;
      }
    });
  }

  if (state.profile) {
    const opts = { paceUnit: getDefaultPaceUnit() };
    drawLactateChart('chart-lactate', state.profile, state.sport, null, opts);
    drawSubstrateChart('chart-substrate', state.profile, state.sport, opts);
  }
}

/* ───────── Init ───────── */

window.addEventListener('esml-auth', (ev) => loadSessions(ev.detail.user));
if (window.__esml && window.__esml.user) loadSessions(window.__esml.user);
render();
