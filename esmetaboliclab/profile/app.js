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
import { generateZones } from '../js/ui/zones.js';
import { minPerKmToPaceString, paceStringToMinPerKm, speedToPaceString } from '../js/lib/mader/sport.js';
import { paceInputHTML, wirePaceInputs, readPaceMps, getDefaultPaceUnit, setDefaultPaceUnit } from '../js/ui/pace-input.js';
import { wireHowToMeasureTriggers } from '../js/ui/how-to-measure.js';
import { wireStepTestTriggers }    from '../js/ui/how-to-step-test.js';
import { wireSprintProtocolTriggers } from '../js/ui/how-to-sprint-test.js';
import { drawLactateChart, drawSubstrateChart } from '../js/ui/charts.js';
import { downloadStepTestReport } from '../js/ui/pdf-report.js';
import { profileGuideHtml } from '../js/ui/profile-guide.js';

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
          '<div class="vlc-pill">◈ Saved VLamax on file</div>' +
          '<div class="vlc-val">' + state.VLamax.toFixed(3) +
            ' <span class="vlc-unit">mmol·L⁻¹·s⁻¹</span></div>' +
          '<div class="vlc-date">Saved ' + fmtDate(state.VLamax_measured_at) +
            ' — edit the sprint values below to update it, or keep the inputs as-is and continue.</div>' +
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

// "Save & continue" advances the wizard. If the sprint inputs match the
// already-saved values exactly, skip the Firestore write — otherwise persist
// the new VLamax and proceed to the step-test stage.
async function saveAndContinueVLamax() {
  const user = window.__esml && window.__esml.user;
  if (!user) { alert('Sign in required.'); return; }
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

  const sameAsSaved = state.VLamax_inputs
    && state.VLamax_inputs.La_pre       === inputs.La_pre
    && state.VLamax_inputs.La_peak_post === inputs.La_peak_post
    && state.VLamax_inputs.duration_s   === inputs.duration_s
    && state.VLamax_inputs.t_PCr_s      === inputs.t_PCr_s;

  const btn = $('#vlamax-next');
  const origLabel = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if (!sameAsSaved) {
      const db = firebase.firestore();
      await db.collection('users').doc(user.uid).set(
        { esmetlab: { vlamax: {
          value: r.VLamax,
          measured_at: firebase.firestore.FieldValue.serverTimestamp(),
          inputs: inputs,
        } } },
        { merge: true }
      );
      state.VLamax_measured_at = new Date();
      state.VLamax_inputs = inputs;
    }
    state.VLamax = r.VLamax;
    gotoStep(3);
  } catch (e) {
    console.error('VLamax save failed:', e);
    alert('Save failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = origLabel;
  }
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
    }
  } catch (e) {
    console.error('Failed to load saved VLamax:', e);
  }
  renderVLamaxStep();
}

window.addEventListener('esml-auth', (ev) => loadVLamax(ev.detail.user));
if (window.__esml && window.__esml.user) loadVLamax(window.__esml.user);
// Render the Step 2 form immediately with defaults so it's wired before
// auth resolves; loadVLamax will re-render with any saved values.
renderVLamaxStep();

const vlamaxNextBtn = $('#vlamax-next');
if (vlamaxNextBtn) vlamaxNextBtn.addEventListener('click', saveAndContinueVLamax);

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
  renderStages();
}));
$('#bodyMass').addEventListener('input', e => state.bodyMass = +e.target.value);

function renderIntensityHeader() {
  const h = document.getElementById('intensity-header');
  if (h) h.textContent = state.sport === 'cycling' ? 'Power (W)' : 'Pace';
}
renderIntensityHeader();

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

$('#run').addEventListener('click', () => {
  if (!state.VLamax) {
    alert('VLamax not set — go back to step 2 and save your sprint inputs.');
    gotoStep(2);
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
    gotoStep(4);
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

  const zones = generateZones(sport, { MLSS_intensity: p.mlss.intensity, LT1_intensity: p.lt1.intensity });
  let zonesHtml = '';
  if (zones.coggan) zonesHtml += zoneTableHtml('Coggan 7-zone (cycling)', zones.coggan, sport);
  if (zones.friel)  zonesHtml += zoneTableHtml('Friel 7-zone (running)',  zones.friel, sport);
  if (zones.seiler) zonesHtml += zoneTableHtml('Seiler 3-zone',           zones.seiler, sport);

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

  drawCharts(p);
}

function zoneTableHtml(title, rows, sport) {
  const fmtRange = (lo, hi) => {
    const loDef = !(lo === 0 || !isFinite(lo));
    const hiDef = isFinite(hi);
    if (sport === 'cycling') {
      if (!loDef && hiDef) return 'less than ' + Math.round(hi) + ' W';
      if (loDef && !hiDef) return 'more than ' + Math.round(lo) + ' W';
      return Math.round(lo) + ' – ' + Math.round(hi) + ' W';
    } else {
      if (!loDef && hiDef) return 'slower than ' + fmt.pace(hi);
      if (loDef && !hiDef) return 'faster than ' + fmt.pace(lo);
      return fmt.pace(lo) + ' – ' + fmt.pace(hi);
    }
  };
  return '<h3 style="font-family:var(--display);font-size:16px;font-weight:600;margin:14px 0 8px">' + title + '</h3>' +
         '<table class="zones"><tr><th>Zone</th><th>Label</th><th>Range</th></tr>' +
         rows.map(r => '<tr><td>Z' + r.zone + '</td><td>' + r.label + '</td><td class="num">' + fmtRange(r.lo, r.hi) + '</td></tr>').join('') +
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
  drawLactateChart('chart-lactate', p, state.sport, state.stages, opts);
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
      profile:  state.profile,
      sport:    state.sport,
      stages:   state.stages,
      bodyMass: state.bodyMass,
      sex:      state.sex,
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
