/*
 * Profile controller: stitches the wizard UI to the Mader engine.
 *
 *   - VLamax is a prerequisite, loaded from users/{uid}.esmetlab.vlamax.
 *     If absent, the wizard is hidden and a "go run the sprint test first" prompt
 *     is shown instead.
 *   - 3-step wizard: Athlete → Step test → Results.
 *   - on "Run profile", calls getMetabolicProfile(...) and renders results.
 *   - Plotly for charts, jsPDF for export.
 */

import { getMetabolicProfile } from '../js/lib/mader/index.js';
import { computeVLamax } from '../js/lib/mader/sprint.js';
import { generateZones } from '../js/ui/zones.js';
import { minPerKmToPaceString, paceStringToMinPerKm, speedToPaceDualString } from '../js/lib/mader/sport.js';
import { wireHowToMeasureTriggers } from '../js/ui/how-to-measure.js';
import { wireStepTestTriggers }    from '../js/ui/how-to-step-test.js';
import { drawLactateChart, drawSubstrateChart } from '../js/ui/charts.js';

// Wire the page-level protocol buttons.
wireHowToMeasureTriggers();
wireStepTestTriggers();

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

/* ───────── State ───────── */

const state = {
  step: 1,
  sex: 'M',
  sport: 'running',
  bodyMass: 70,
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
};

/* ───────── Auth + VLamax prerequisite load ───────── */

function fmtDate(ts) {
  if (!ts) return '—';
  let d;
  if (ts.toDate) d = ts.toDate();
  else d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function showPrereq() {
  $('#prereq').style.display = 'block';
  $('#wizard').style.display = 'none';
}

function renderVLamaxCard() {
  // Default to the saved values if available, else sane defaults so the
  // recalc form can compute even on a profile that's not fully populated yet.
  const inp = state.VLamax_inputs || { La_pre: 1.4, La_peak_post: 11.0, duration_s: 15, t_PCr_s: 3.5 };
  const card = $('#vlamax-card');
  card.innerHTML =
    '<div class="vlc-summary">' +
      '<div class="vlc-meta">' +
        '<div class="vlc-pill">◈ Saved Sprint VLamax</div>' +
        '<div class="vlc-val">' + state.VLamax.toFixed(3) +
          ' <span class="vlc-unit">mmol·L⁻¹·s⁻¹</span></div>' +
        '<div class="vlc-date">Saved ' + fmtDate(state.VLamax_measured_at) +
          ' from your Sprint VLamax Test</div>' +
      '</div>' +
      '<div class="vlc-actions">' +
        '<button type="button" class="btn ghost" id="vlc-toggle">Recalculate VLamax</button>' +
      '</div>' +
    '</div>' +
    '<div class="vlc-form" id="vlc-form" hidden>' +
      '<div class="vlc-divider"></div>' +
      '<div class="vlc-form-h">Recalculate from new sprint data</div>' +
      '<p class="vlc-form-sub">Enter your latest 15-second sprint values. The new VLamax updates live below; click Save to overwrite the value on your profile.</p>' +
      '<div class="grid-3">' +
        '<label class="field"><span class="lab">Pre-sprint La (mmol/L)</span>' +
          '<input type="number" id="vlc-la-pre" step="0.1" min="0" max="5" value="' + inp.La_pre + '"></label>' +
        '<label class="field"><span class="lab">Peak post-sprint La (mmol/L)</span>' +
          '<input type="number" id="vlc-la-post" step="0.1" min="2" max="30" value="' + inp.La_peak_post + '"></label>' +
        '<label class="field"><span class="lab">Sprint duration (s)</span>' +
          '<input type="number" id="vlc-dur" step="1" min="10" max="30" value="' + inp.duration_s + '"></label>' +
      '</div>' +
      '<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted2);font-size:13px;font-family:var(--mono)">Advanced — phosphagen time</summary>' +
        '<label class="field" style="max-width:280px;margin-top:10px"><span class="lab">Alactic time t_PCr (s)</span>' +
        '<input type="number" id="vlc-tpcr" step="0.1" min="2" max="6" value="' + inp.t_PCr_s + '"></label>' +
      '</details>' +
      '<div class="vlc-result" id="vlc-result"></div>' +
      '<div class="vlc-form-actions">' +
        '<button type="button" class="btn primary" id="vlc-save">Save updated VLamax</button>' +
        '<button type="button" class="btn ghost"   id="vlc-cancel">Cancel</button>' +
      '</div>' +
    '</div>';
  wireRecalcCard();
}

function wireRecalcCard() {
  const toggle = $('#vlc-toggle');
  const form   = $('#vlc-form');
  toggle.addEventListener('click', () => {
    const open = !form.hasAttribute('hidden');
    if (open) { form.setAttribute('hidden', ''); toggle.textContent = 'Recalculate VLamax'; }
    else      { form.removeAttribute('hidden'); toggle.textContent = 'Hide recalculate'; recalcLive(); $('#vlc-la-pre').focus(); }
  });
  $('#vlc-cancel').addEventListener('click', () => {
    form.setAttribute('hidden', ''); toggle.textContent = 'Recalculate VLamax';
  });
  ['vlc-la-pre','vlc-la-post','vlc-dur','vlc-tpcr'].forEach(id =>
    $('#' + id).addEventListener('input', recalcLive)
  );
  $('#vlc-save').addEventListener('click', saveRecalc);
}

function readRecalcInputs() {
  return {
    La_pre:        +$('#vlc-la-pre').value,
    La_peak_post:  +$('#vlc-la-post').value,
    duration_s:    +$('#vlc-dur').value,
    t_PCr_s:       +$('#vlc-tpcr').value,
  };
}

function recalcLive() {
  const inputs = readRecalcInputs();
  const r = computeVLamax(inputs);
  if (!isFinite(r.VLamax) || r.glycolytic_time_s <= 0) {
    $('#vlc-result').innerHTML = '<div class="vlc-result-empty">Enter all three sprint values to compute.</div>';
    return;
  }
  const warnHtml = r.warnings.length
    ? '<div style="font-size:12px;color:var(--gold);margin-top:6px">⚠ ' + r.warnings.join(' ') + '</div>'
    : '';
  $('#vlc-result').innerHTML =
    '<div class="vlc-result-box">' +
      '<div class="vlc-result-label">NEW VLAMAX</div>' +
      '<div class="vlc-result-val">' + r.VLamax.toFixed(3) +
        ' <span class="vlc-unit">mmol·L⁻¹·s⁻¹</span></div>' +
      warnHtml +
    '</div>';
}

async function saveRecalc() {
  const user = window.__esml && window.__esml.user;
  if (!user) { alert('Sign in required.'); return; }
  const inputs = readRecalcInputs();
  const r = computeVLamax(inputs);
  if (!isFinite(r.VLamax) || r.glycolytic_time_s <= 0) {
    alert('Sprint values are not valid — recheck the inputs.');
    return;
  }
  const btn = $('#vlc-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const db = firebase.firestore();
    await db.collection('users').doc(user.uid).set(
      { esmetlab: { vlamax: {
        value: r.VLamax,
        measured_at: firebase.firestore.FieldValue.serverTimestamp(),
        inputs: inputs,
      } } },
      { merge: true }
    );
    state.VLamax = r.VLamax;
    state.VLamax_measured_at = new Date();
    state.VLamax_inputs = inputs;
    renderVLamaxCard();   // re-render — form collapsed, new saved value shown
  } catch (e) {
    console.error('Save failed:', e);
    alert('Save failed: ' + e.message);
    btn.disabled = false; btn.textContent = 'Save updated VLamax';
  }
}

function showWizard() {
  $('#prereq').style.display = 'none';
  $('#wizard').style.display = 'block';
  renderVLamaxCard();
}

async function loadVLamax(user) {
  try {
    const db = firebase.firestore();
    const doc = await db.collection('users').doc(user.uid).get();
    const data = doc.exists ? doc.data() : null;
    const v = data && data.esmetlab && data.esmetlab.vlamax;
    if (v && typeof v.value === 'number') {
      state.VLamax = v.value;
      state.VLamax_measured_at = v.measured_at || null;
      state.VLamax_inputs = v.inputs || null;
      showWizard();
    } else {
      showPrereq();
    }
  } catch (e) {
    console.error('Failed to load VLamax:', e);
    showPrereq();
  }
}

window.addEventListener('esml-auth', (ev) => loadVLamax(ev.detail.user));
if (window.__esml && window.__esml.user) loadVLamax(window.__esml.user);

/* ───────── Step navigation ───────── */

function gotoStep(n) {
  state.step = n;
  $$('.step-section').forEach(el => el.classList.toggle('active', +el.dataset.step === n));
  for (let i = 1; i <= 3; i++) {
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
  renderStages();
}));
$('#bodyMass').addEventListener('input', e => state.bodyMass = +e.target.value);

function renderIntensityHeader() {
  const h = document.getElementById('intensity-header');
  if (h) h.textContent = state.sport === 'cycling' ? 'Power (W)' : 'Speed (m/s) or pace (mm:ss)';
}
renderIntensityHeader();

/* ───────── Step 2: stages table ───────── */

const stagesBody = $('#stages-body');

function intensityPlaceholder() {
  return state.sport === 'cycling' ? '200' : '4:30 or 3.7';
}

function parseIntensity(s) {
  if (state.sport === 'running') {
    const t = String(s).trim();
    if (/^\d+:\d+(\.\d+)?$/.test(t)) {
      const pace = paceStringToMinPerKm(t);
      return 1000 / (pace * 60); // m/s
    }
  }
  const v = parseFloat(s);
  return isFinite(v) ? v : 0;
}

function intensityDisplay(val) {
  if (state.sport === 'running') {
    if (val > 0 && val < 12) {
      const pace = 1000 / (val * 60);
      return minPerKmToPaceString(pace);
    }
  }
  return String(val);
}

function renderStages() {
  stagesBody.innerHTML = state.stages.map((s, i) => `
    <tr>
      <td style="font-family:var(--mono);color:var(--muted2)">${i + 1}</td>
      <td><input type="text"  data-i="${i}" data-k="intensity" value="${intensityDisplay(s.intensity)}" placeholder="${intensityPlaceholder()}"></td>
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
      const v = e.target.value;
      if (k === 'intensity') state.stages[i][k] = parseIntensity(v);
      else if (k === 'hr')   state.stages[i][k] = v;
      else                   state.stages[i][k] = +v;
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
  checkStageWarnings();
}

$('#add-stage').addEventListener('click', () => {
  if (state.stages.length >= 6) return;
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
  if (state.stages.length < 3) out.push('Need at least 3 stages for a meaningful fit.');
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

$('#run').addEventListener('click', () => {
  if (!state.VLamax) {
    alert('VLamax not loaded — please run a sprint test first.');
    return;
  }
  try {
    state.profile = getMetabolicProfile({
      sport: state.sport,
      sex: state.sex,
      bodyMass: state.bodyMass,
      VLamax: state.VLamax,
      steps: state.stages.map(s => ({
        intensity: s.intensity,
        durationMin: s.durationMin,
        lactate: s.lactate,
      })),
    });
    renderResults();
    gotoStep(3);
  } catch (e) {
    alert('Profile run failed: ' + e.message);
    console.error(e);
  }
});

/* ───────── Results renderer ───────── */

function renderResults() {
  const p = state.profile;
  const sport = state.sport;
  const fmtIntensity = sport === 'cycling' ? fmt.W : fmt.pace;

  const metrics = [
    { label: 'VO₂max',  value: fmt.V(p.VO2max), note: p.inputs.VO2max_supplied ? 'as supplied' : 'fitted from your curve' },
    { label: 'VLamax',  value: p.VLamax.toFixed(3) + ' mmol/L/s', note: 'from sprint test on ' + fmtDate(state.VLamax_measured_at) },
    { label: 'MLSS',    value: fmtIntensity(p.mlss.intensity), note: fmt.pct(p.mlss.x) + ' of VO₂max · ' + fmt.La(p.mlss.lactate) },
    { label: 'LT1',     value: fmtIntensity(p.lt1.intensity),  note: fmt.pct(p.lt1.x) + ' of VO₂max · ' + fmt.La(p.lt1.lactate) },
    { label: 'Fatmax',  value: fmtIntensity(p.fatmax.intensity), note: fmt.G(p.fatmax.fat_g_per_min) + ' at ' + fmt.pct(p.fatmax.x) + ' of VO₂max' },
  ];
  const metricsHtml = metrics.map(m =>
    '<div class="metric"><div class="metric-label">' + m.label + '</div>' +
    '<div class="metric-value">' + m.value + '</div>' +
    (m.note ? '<div class="metric-note">' + m.note + '</div>' : '') +
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

  const zones = generateZones(sport, { MLSS_intensity: p.mlss.intensity, LT1_intensity: p.lt1.intensity });
  let zonesHtml = '';
  if (zones.coggan) zonesHtml += zoneTableHtml('Coggan 7-zone (cycling)', zones.coggan, sport);
  if (zones.friel)  zonesHtml += zoneTableHtml('Friel 7-zone (running)',  zones.friel, sport);
  if (zones.seiler) zonesHtml += zoneTableHtml('Seiler 3-zone',           zones.seiler, sport);

  $('#results-root').innerHTML =
    '<div class="metric-grid">' + metricsHtml + '</div>' +
    sensHtml + warnHtml +
    '<div class="chart-block"><div class="chart-title">Lactate production vs elimination</div>' +
      '<div class="chart-sub">The intersection is MLSS — where your glycolytic flux equals your maximum oxidative elimination capacity. Your measured stages are overlaid on the simulated lactate curve.</div>' +
      '<div id="chart-lactate" class="plt"></div></div>' +
    '<div class="chart-block"><div class="chart-title">Substrate oxidation</div>' +
      '<div class="chart-sub">Grams of fat and CHO oxidized per minute across intensities. Fatmax is where fat oxidation peaks.</div>' +
      '<div id="chart-substrate" class="plt"></div></div>' +
    '<div class="panel"><div class="panel-h">Training zones</div>' + zonesHtml + '</div>' +
    educationHtml();

  drawCharts(p);
}

function zoneTableHtml(title, rows, sport) {
  const fmtRange = (lo, hi) => {
    if (sport === 'cycling') {
      const a = (lo === 0 || !isFinite(lo)) ? '0'      : Math.round(lo) + ' W';
      const b = isFinite(hi) ? Math.round(hi) + ' W'   : '∞';
      return a + ' – ' + b;
    } else {
      const a = (lo === 0 || !isFinite(lo)) ? '—'        : fmt.pace(lo);
      const b = isFinite(hi) ? fmt.pace(hi) : '—';
      return a + ' – ' + b;
    }
  };
  return '<h3 style="font-family:var(--display);font-size:16px;font-weight:600;margin:14px 0 8px">' + title + '</h3>' +
         '<table class="zones"><tr><th>Zone</th><th>Label</th><th>Range</th></tr>' +
         rows.map(r => '<tr><td>Z' + r.zone + '</td><td>' + r.label + '</td><td class="num">' + fmtRange(r.lo, r.hi) + '</td></tr>').join('') +
         '</table>';
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
  drawLactateChart('chart-lactate', p, state.sport, state.stages);
  drawSubstrateChart('chart-substrate', p, state.sport);
}

/* ───────── PDF export ───────── */

$('#export-pdf').addEventListener('click', async () => {
  if (!state.profile) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library not loaded yet — try again in a moment.');
    return;
  }
  const p = state.profile;
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  let y = 18;

  doc.setFontSize(18);
  doc.text('esMetabolicLab — Metabolic Profile', 14, y); y += 8;
  doc.setFontSize(11); doc.setTextColor(100);
  doc.text('Generated ' + new Date().toISOString().slice(0, 10) + ' · admin preview', 14, y); y += 10;

  doc.setTextColor(0); doc.setFontSize(12);
  doc.text('Athlete', 14, y); y += 6;
  doc.setFontSize(10); doc.setTextColor(60);
  doc.text('Sport: ' + state.sport + '   Sex: ' + state.sex + '   Mass: ' + state.bodyMass + ' kg', 14, y); y += 8;

  doc.setTextColor(0); doc.setFontSize(12); doc.text('Results', 14, y); y += 6;
  const lines = [
    ['VO₂max',  fmt.V(p.VO2max) + (p.inputs.VO2max_supplied ? ' (supplied)' : ' (fitted)')],
    ['VLamax',  p.VLamax.toFixed(3) + ' mmol/L/s'],
    ['MLSS',    (state.sport === 'cycling' ? fmt.W(p.mlss.intensity) : fmt.pace(p.mlss.intensity)) + '   ' + fmt.pct(p.mlss.x) + ' VO₂max   La=' + fmt.La(p.mlss.lactate)],
    ['LT1',     (state.sport === 'cycling' ? fmt.W(p.lt1.intensity)  : fmt.pace(p.lt1.intensity))  + '   ' + fmt.pct(p.lt1.x)  + ' VO₂max'],
    ['Fatmax',  (state.sport === 'cycling' ? fmt.W(p.fatmax.intensity) : fmt.pace(p.fatmax.intensity)) + '   ' + fmt.G(p.fatmax.fat_g_per_min) + ' @ ' + fmt.pct(p.fatmax.x)],
  ];
  doc.setFontSize(10);
  for (const [k, v] of lines) {
    doc.setTextColor(80); doc.text(k, 16, y);
    doc.setTextColor(0);  doc.text(v, 50, y);
    y += 5;
  }
  y += 4;

  if (p.diagnostics.sensitivity) {
    const s = p.diagnostics.sensitivity;
    doc.setFontSize(11); doc.setTextColor(0); doc.text('Sensitivity', 14, y); y += 5;
    doc.setFontSize(9); doc.setTextColor(70);
    doc.text('±0.5 mmol/L lactate perturbation shifts VO₂max by ≤ ' + s.max_VO2max_shift.toFixed(2)
           + ' mL/min/kg (' + (s.max_VO2max_shift/s.base_VO2max*100).toFixed(2) + '%). Fit RMSE = '
           + p.diagnostics.rmse.toFixed(2) + ' mmol/L.', 14, y, { maxWidth: W - 28 });
    y += 12;
  }

  for (const id of ['chart-lactate', 'chart-substrate']) {
    try {
      const img = await Plotly.toImage(id, { format: 'png', width: 760, height: 380 });
      if (y > 240) { doc.addPage(); y = 16; }
      doc.addImage(img, 'PNG', 14, y, W - 28, 80);
      y += 86;
    } catch (e) { /* keep going */ }
  }

  if (y > 260) { doc.addPage(); y = 16; }
  doc.setFontSize(8); doc.setTextColor(120);
  doc.text('Not medical advice. esMetabolicLab is provided for educational purposes only and does not constitute a medical diagnosis. Consult a qualified healthcare professional before changing your training based on these results.', 14, y, { maxWidth: W - 28 });

  doc.save('esmetaboliclab-profile-' + new Date().toISOString().slice(0, 10) + '.pdf');
});
