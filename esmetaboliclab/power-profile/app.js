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
import { generateZones }       from '../js/ui/zones.js';
import { drawLactateChart, drawSubstrateChart } from '../js/ui/charts.js';
import { minPerKmToPaceString, paceStringToMinPerKm, speedToPaceDualString } from '../js/lib/mader/sport.js';

const $   = (sel) => document.querySelector(sel);
const $$  = (sel) => Array.from(document.querySelectorAll(sel));
const fmt = {
  W:   (v) => v.toFixed(0) + ' W',
  V:   (v) => v.toFixed(1) + ' mL/min/kg',
  La:  (v) => v.toFixed(2) + ' mmol/L',
  G:   (v) => v.toFixed(2) + ' g/min',
  pct: (v) => (v * 100).toFixed(1) + '%',
  ms:  (v) => v.toFixed(2) + ' m/s',
  pace:(v) => speedToPaceDualString(v),
};
const db = firebase.firestore();

/* ───────── State ───────── */

const state = {
  sport: 'running',
  sex: 'M',
  bodyMass: 70,
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

function parseIntensity(sport, raw) {
  if (sport === 'running') {
    const t = String(raw).trim();
    if (/^\d+:\d+(\.\d+)?$/.test(t)) {
      const pace = paceStringToMinPerKm(t);
      return 1000 / (pace * 60); // m/s
    }
  }
  const v = parseFloat(raw);
  return isFinite(v) ? v : NaN;
}

function intensityPlaceholder(sport, duration) {
  if (sport === 'cycling') {
    return ({ sprint15s: '1000', peak3min: '380', peak6min: '340', peak12min: '305' })[duration];
  }
  return ({ sprint15s: '8.0',  peak3min: '5.9',  peak6min: '5.3',  peak12min: '4.9'  })[duration];
}

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

    // Auto-load the latest session's profile so results show on landing
    if (state.sessions.length > 0) {
      const latest = state.sessions[state.sessions.length - 1];
      hydrateActiveFromSession(latest);
    }
    render();
  } catch (e) {
    console.error('Power profiles load failed:', e);
    state.sessions = [];
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
  } catch (e) {
    console.warn('Replay failed:', e);
  }
}

async function saveSession(derived, sportInputs, efforts) {
  const user = window.__esml && window.__esml.user;
  if (!user) throw new Error('Sign in required.');

  const session = {
    id: generateId(),
    measured_at: firebase.firestore.Timestamp.now(),
    inputs: {
      sport:    sportInputs.sport,
      sex:      sportInputs.sex,
      bodyMass: sportInputs.bodyMass,
      efforts:  efforts,
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
        efforts: last.inputs.efforts || state.efforts,
      }
    : {
        sport: state.sport, sex: state.sex,
        bodyMass: state.bodyMass,
        efforts: state.efforts,
      };

  const intensityHeader = prefill.sport === 'cycling' ? 'Power (W)' : 'Speed (m/s) or pace (mm:ss/km)';

  return `
    <div class="new-session-card" id="ps-form">
      <div class="new-session-h">
        <div class="h-title">▶ New power profile</div>
        <button type="button" class="btn ghost" id="ps-cancel" style="padding:7px 14px;font-size:12px">Cancel</button>
      </div>
      <p class="new-session-sub">
        Use your best 15-second sprint, 3-minute, 6-minute, and 12-minute
        all-out efforts. These can come from a structured field test you
        run today or from prior race / interval files in TrainingPeaks /
        Strava / Garmin. Each must be a <strong>genuine maximum</strong> for
        that duration; pacing leaves the result unreliable.
      </p>

      <div class="grid-2">
        <div class="field">
          <span class="lab">Sport</span>
          <div class="radio-row">
            <label><input type="radio" name="ps-sport" value="cycling"${prefill.sport === 'cycling' ? ' checked' : ''}><span>Cycling</span></label>
            <label><input type="radio" name="ps-sport" value="running"${prefill.sport === 'running' ? ' checked' : ''}><span>Running</span></label>
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

      <label class="field" style="max-width:280px">
        <span class="lab">Body mass (kg)</span>
        <input type="number" id="ps-mass" step="0.1" min="30" max="160" value="${prefill.bodyMass}">
      </label>

      <div style="margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--muted2);letter-spacing:.5px;text-transform:uppercase">Max effort intensities — <span id="ps-intensity-unit">${intensityHeader}</span></div>
      <div class="grid-2" style="margin-top:6px">
        <label class="field">
          <span class="lab">15-second sprint</span>
          <input type="text" id="ps-sprint" placeholder="${intensityPlaceholder(prefill.sport, 'sprint15s')}" value="${prefill.efforts.sprint15s ?? ''}">
          <span class="hint">Average across the full 15 seconds, not the 1-sec peak</span>
        </label>
        <label class="field">
          <span class="lab">3-minute max</span>
          <input type="text" id="ps-3min"   placeholder="${intensityPlaceholder(prefill.sport, 'peak3min')}" value="${prefill.efforts.peak3min ?? ''}">
        </label>
      </div>
      <div class="grid-2">
        <label class="field">
          <span class="lab">6-minute max</span>
          <input type="text" id="ps-6min"   placeholder="${intensityPlaceholder(prefill.sport, 'peak6min')}" value="${prefill.efforts.peak6min ?? ''}">
          <span class="hint">VO₂max-equivalent intensity — the headline number</span>
        </label>
        <label class="field">
          <span class="lab">12-minute max</span>
          <input type="text" id="ps-12min"  placeholder="${intensityPlaceholder(prefill.sport, 'peak12min')}" value="${prefill.efforts.peak12min ?? ''}">
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

  ['ps-mass', 'ps-sprint', 'ps-3min', 'ps-6min', 'ps-12min'].forEach((id) => {
    $('#' + id).addEventListener('input', recalcPreview);
  });

  $('#ps-cancel').addEventListener('click', () => {
    state.newFormOpen = false;
    render();
  });

  $('#ps-save').addEventListener('click', onSave);
  recalcPreview();
}

function readForm() {
  const sport = (document.querySelector('input[name="ps-sport"]:checked') || {}).value || 'running';
  const sex   = (document.querySelector('input[name="ps-sex"]:checked')   || {}).value || 'M';
  const bodyMass = parseFloat($('#ps-mass').value);

  const efforts = {
    sprint15s: parseIntensity(sport, $('#ps-sprint').value),
    peak3min:  parseIntensity(sport, $('#ps-3min').value),
    peak6min:  parseIntensity(sport, $('#ps-6min').value),
    peak12min: parseIntensity(sport, $('#ps-12min').value),
  };
  return { sport, sex, bodyMass, efforts };
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

  let derived;
  try {
    derived = derivePowerProfile({
      sport: inputs.sport, sex: inputs.sex,
      bodyMass: inputs.bodyMass,
      efforts: inputs.efforts,
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
    derived = derivePowerProfile(inputs);
  } catch (e) {
    alert(e.message);
    return;
  }
  const btn = $('#ps-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveSession(derived, inputs, inputs.efforts);
  } catch (e) {
    console.error(e);
    alert('Save failed: ' + e.message);
    btn.disabled = false; btn.textContent = 'Save profile';
  }
}

/* ───────── Sessions list render ───────── */

function effortsLine(sport, efforts) {
  if (!efforts) return '';
  const unit = sport === 'cycling' ? 'W' : 'm/s';
  const fmt = sport === 'cycling'
    ? (v) => Math.round(v) + ' ' + unit
    : (v) => v.toFixed(1) + ' ' + unit;
  return `15s ${fmt(efforts.sprint15s)} · 3m ${fmt(efforts.peak3min)} · 6m ${fmt(efforts.peak6min)} · 12m ${fmt(efforts.peak12min)}`;
}

function sessionCardHTML(s, isLatest) {
  const sport = (s.inputs && s.inputs.sport) || 'cycling';
  const latestPill = isLatest ? '<span class="latest-pill">Latest · active</span>' : '';
  const derived = s.derived || {};
  return `
    <div class="sess-card ${isLatest ? 'latest' : ''}">
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
    { label: 'VO₂max', value: fmt.V(p.VO2max), note: 'estimated from 6-min max effort' },
    { label: 'VLamax', value: p.VLamax.toFixed(3) + ' mmol/L/s', note: 'estimated from 15-s sprint' },
    { label: 'MLSS',   value: fmtIntensity(sport, p.mlss.intensity), note: fmt.pct(p.mlss.x) + ' of VO₂max · ' + fmt.La(p.mlss.lactate) },
    { label: 'LT1',    value: fmtIntensity(sport, p.lt1.intensity),  note: fmt.pct(p.lt1.x) + ' of VO₂max' },
    { label: 'Fatmax', value: fmtIntensity(sport, p.fatmax.intensity), note: fmt.G(p.fatmax.fat_g_per_min) + ' at ' + fmt.pct(p.fatmax.x) },
  ];
  const metricsHtml = metrics.map((m) =>
    '<div class="metric"><div class="metric-label">' + m.label + '</div>' +
    '<div class="metric-value">' + m.value + '</div>' +
    '<div class="metric-note">' + m.note + '</div>' +
    '</div>').join('');

  const warnHtml = (p.diagnostics.warnings || []).map((w) => '<div class="warn">⚠ ' + w + '</div>').join('');

  const zones = generateZones(sport, { MLSS_intensity: p.mlss.intensity, LT1_intensity: p.lt1.intensity });
  let zonesHtml = '';
  if (zones.coggan) zonesHtml += zoneTableHtml('Coggan 7-zone (cycling)', zones.coggan, sport);
  if (zones.friel)  zonesHtml += zoneTableHtml('Friel 7-zone (running)',  zones.friel, sport);
  if (zones.seiler) zonesHtml += zoneTableHtml('Seiler 3-zone',           zones.seiler, sport);

  return `
    <div id="results-block">
      <h2 style="font-family:var(--display);font-size:24px;font-weight:700;margin:30px 0 14px">Active profile</h2>
      <div class="metric-grid">${metricsHtml}</div>
      ${warnHtml}
      <div class="chart-block">
        <div class="chart-title">Lactate production vs elimination</div>
        <div class="chart-sub">Derived from your estimated VO₂max and VLamax — no measured lactate values, so no points are overlaid.</div>
        <div id="chart-lactate" class="plt"></div>
      </div>
      <div class="chart-block">
        <div class="chart-title">Substrate oxidation</div>
        <div class="chart-sub">Grams of fat and CHO oxidized per minute across intensities. Fatmax is the dashed marker.</div>
        <div id="chart-substrate" class="plt"></div>
      </div>
      <div class="panel"><div class="panel-h">Training zones</div>${zonesHtml}</div>
      <details class="edu" style="margin-top:18px">
        <summary>How are these numbers derived?</summary>
        <div class="body">
          <p><strong>VLamax</strong> comes from your 15-second sprint power (cycling) or speed (running), via an empirical linear regression calibrated to typical population ranges. This is the least-reliable part of the estimate — VLamax varies substantially at any given sprint power, and individual phenotype matters a lot.</p>
          <p><strong>VO₂max</strong> is derived from your 6-minute max effort. 6-min max is widely used as a VO₂max-equivalent power surrogate in the lab (Hawley & Noakes 1992 and the body of work that followed). We apply a small ~0.95× downscale to account for the typical 5–8% anaerobic contribution at 6-min duration.</p>
          <p>Once VO₂max and VLamax are estimated, the Mader/Heck engine runs exactly as it would on lactate-anchored values — MLSS, LT1, Fatmax, and substrate curves come from the same equations.</p>
        </div>
      </details>
    </div>
  `;
}

function zoneTableHtml(title, rows, sport) {
  const fmtRange = (lo, hi) => {
    if (sport === 'cycling') {
      const a = (lo === 0 || !isFinite(lo)) ? '0' : Math.round(lo) + ' W';
      const b = isFinite(hi) ? Math.round(hi) + ' W' : '∞';
      return a + ' – ' + b;
    }
    const a = (lo === 0 || !isFinite(lo)) ? '—' : fmt.pace(lo);
    const b = isFinite(hi) ? fmt.pace(hi) : '—';
    return a + ' – ' + b;
  };
  return '<h3 style="font-family:var(--display);font-size:16px;font-weight:600;margin:14px 0 8px">' + title + '</h3>' +
         '<table class="zones"><tr><th>Zone</th><th>Label</th><th>Range</th></tr>' +
         rows.map((r) => '<tr><td>Z' + r.zone + '</td><td>' + r.label + '</td><td class="num">' + fmtRange(r.lo, r.hi) + '</td></tr>').join('') +
         '</table>';
}

/* ───────── Top-level render ───────── */

function render() {
  const root = $('#root');
  let html = '';
  if (state.newFormOpen) html += newFormHTML();
  html += sessionsPanelHTML();
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

  if (state.profile) {
    drawLactateChart('chart-lactate', state.profile, state.sport, null);
    drawSubstrateChart('chart-substrate', state.profile, state.sport);
  }
}

/* ───────── Init ───────── */

window.addEventListener('esml-auth', (ev) => loadSessions(ev.detail.user));
if (window.__esml && window.__esml.user) loadSessions(window.__esml.user);
render();
