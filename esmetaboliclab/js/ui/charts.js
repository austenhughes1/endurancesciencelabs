/*
 * Shared chart rendering for esMetabolicLab profile pages.
 *
 * Two charts:
 *   1. drawLactateChart — lactate production rate + max clearance rate +
 *      simulated [La] curve, with measured step-test points overlaid where
 *      available.
 *   2. drawSubstrateChart — fat / carbs burned (g/min) vs intensity, with
 *      a vertical at Fatmax.
 *
 * Layperson-friendly labels and legends (technical terms are explained in
 * the chart expandables on the page, not crammed onto the chart itself).
 * For running, the x-axis is formatted as pace (min/mi or min/km) based
 * on the caller's paceUnit; data values stay in m/s internally.
 *
 * Plotly.js is expected to be loaded as a global (window.Plotly) by the
 * host page — we don't import it here to avoid duplicate downloads.
 *
 * Colours come from the site theme tokens (transparent paper, so the chart
 * sits on the card in light and dark); redrawAllCharts() re-renders after a
 * theme change, and chartFigureForExport() rebuilds a chart with a fixed
 * light "pdf" theme for the PDF report. The x-window is presentation only:
 * it focuses on the useful range and always contains every measured sample
 * and the three markers — the model curves themselves are unchanged.
 */

const METERS_PER_MILE = 1609.344;

/** Theme palette: 'screen' reads the live CSS tokens; 'pdf' is fixed light. */
function chartTheme(name) {
  if (name === 'pdf') {
    return { text: '#161922', muted: '#586072', grid: 'rgba(0,0,0,.10)', accent: '#067566', purple: '#5a49d6',
             gold: '#7a5d00', coral: '#b3400f', good: '#0b7a50', paper: '#ffffff', marker: '#ffffff',
             goldWash: 'rgba(122,93,0,.10)', coralWash: 'rgba(179,64,15,.08)',
             ui: 'Helvetica, Arial, sans-serif', mono: 'Courier, monospace' };
  }
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue(k).trim();
  return { text: v('--text'), muted: v('--muted2'), grid: v('--border2'), accent: v('--accent-ink'), purple: v('--purple-ink'),
           gold: v('--gold-ink'), coral: v('--coral-ink'), good: v('--good-ink'), paper: 'rgba(0,0,0,0)', marker: v('--panel'),
           goldWash: v('--gold-wash'), coralWash: v('--coral-wash'),
           ui: v('--ui') || 'Inter, sans-serif', mono: v('--mono') || 'monospace' };
}

const finiteVals = (arr) => (arr || []).filter((v) => isFinite(v));
const maxOf = (arr) => { const f = finiteVals(arr); return f.length ? Math.max(...f) : 0; };

/**
 * Focused x-window (presentation only): from ~75 % of the lower marker to
 * ~110 % VO₂max, widened to contain every measured sample and MLSS.
 */
function xWindow(profile, measured) {
  const I = profile.curves.intensities, xs = profile.curves.xs || [];
  const at = (x) => { const i = xs.findIndex((v) => v >= x); return I[i < 0 ? I.length - 1 : i]; };
  let lo = 0.75 * Math.min(profile.fatmax.intensity, profile.lt1.intensity), hi = at(1.10);
  (measured || []).forEach((s) => {
    if (isFinite(s.intensity) && s.intensity > 0) { lo = Math.min(lo, s.intensity * 0.97); hi = Math.max(hi, s.intensity * 1.03); }
  });
  hi = Math.max(hi, profile.mlss.intensity * 1.05);
  const firstPos = I.find((v) => v > 0);
  return [Math.max(lo, firstPos || lo), hi];
}

// Values of `ys` whose x lies inside the window.
function inWindow(xsArr, ys, win) {
  const out = [];
  for (let i = 0; i < xsArr.length; i++) if (xsArr[i] >= win[0] && xsArr[i] <= win[1] && isFinite(ys[i])) out.push(ys[i]);
  return out;
}

/**
 * Generate Plotly x-axis config that displays a speed (m/s) axis with
 * pace tick labels (m:ss/mi or /km).
 *
 * Uses a curated candidate list of "interesting" pace values rather than
 * a uniform interval — at low speeds (slow walking), each minute of pace
 * difference compresses into a tiny speed gap and uniform ticks pile up.
 * Ticks are computed for the visible window; on narrow charts every other
 * tick is kept so labels never collide.
 */
function paceAxisConfig(win, unit, narrow) {
  const minV = Math.max(0.5, win[0]);
  const maxV = win[1];
  const M = unit === 'mi' ? METERS_PER_MILE : 1000;

  // Curated tick candidates from slowest (walking) to fastest (sprinting).
  const candidates = unit === 'mi'
    ? [20, 15, 12, 11, 10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3]
    : [12, 10, 8, 7, 6.5, 6, 5.5, 5, 4.75, 4.5, 4.25, 4, 3.75, 3.5, 3.25, 3, 2.5, 2];

  let ticks = [];
  for (const p of candidates) {
    const v = M / (p * 60);
    if (v >= minV * 0.98 && v <= maxV * 1.02) ticks.push(p);
  }
  // Keep whole minutes when there are plenty of ticks.
  if (ticks.length > 9) ticks = ticks.filter((p) => Number.isInteger(p) || ticks.filter(Number.isInteger).length < 4);
  if (narrow && ticks.length > 5) ticks = ticks.filter((_, i) => i % 2 === 0);
  const tickvals = [], ticktext = [];
  ticks.forEach((p) => {
    tickvals.push(M / (p * 60));
    const min = Math.floor(p);
    const sec = Math.round((p - min) * 60);
    ticktext.push(min + ':' + (sec < 10 ? '0' : '') + sec);
  });
  return { tickmode: 'array', tickvals, ticktext };
}

function axisBase(t, narrow, title) {
  return {
    title: { text: title, font: { size: narrow ? 11 : 12, color: t.muted, family: t.ui } },
    gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.grid,
    tickfont: { family: t.mono, size: 11, color: t.muted },
    tickangle: 0, automargin: true,
  };
}

function xAxisFor(t, sport, win, paceUnit, narrow) {
  if (sport === 'cycling') {
    return Object.assign(axisBase(t, narrow, 'Power (watts)'), { range: win, nticks: narrow ? 5 : 8 });
  }
  const unitLabel = paceUnit === 'km' ? 'min per kilometer' : 'min per mile';
  return Object.assign(axisBase(t, narrow, 'Pace (' + unitLabel + ')'), { range: win }, paceAxisConfig(win, paceUnit || 'mi', narrow));
}

function baseLayout(t, narrow, rightAxis) {
  return {
    paper_bgcolor: t.paper, plot_bgcolor: t.paper,
    font: { family: t.ui, color: t.text, size: 12 },
    margin: { t: 36, r: rightAxis ? (narrow ? 44 : 70) : (narrow ? 16 : 30), b: 44, l: narrow ? 44 : 60 },
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: narrow ? 11 : 12, color: t.text } },
  };
}

const isNarrow = (id) => { const el = document.getElementById(id); return !!el && el.clientWidth > 0 && el.clientWidth < 480; };

// Last arguments per chart element, for theme redraws and the PDF export.
const lastArgs = new Map();

function plot(id, fig) {
  window.Plotly.newPlot(id, fig.data, fig.layout, { displayModeBar: false, responsive: true });
}

function buildLactateFigure(themeName, elementId, profile, sport, measuredStages, opts) {
  const t = chartTheme(themeName);
  const narrow = themeName === 'pdf' ? false : isNarrow(elementId);
  const I = profile.curves.intensities;
  const measured = (measuredStages || []).filter((s) => isFinite(s.intensity) && s.intensity > 0 && isFinite(s.lactate));
  const win = xWindow(profile, measured);

  const data = [
    { x: I, y: profile.curves.vLass, name: 'Lactate production',
      mode: 'lines', line: { color: t.coral, width: 2.5 }, yaxis: 'y2' },
    { x: I, y: profile.curves.vLaoxmax, name: 'Max lactate clearance',
      mode: 'lines', line: { color: t.accent, width: 2.5, dash: 'dot' }, yaxis: 'y2' },
    { x: I, y: profile.curves.lactate, name: 'Predicted blood lactate at each effort',
      mode: 'lines', line: { color: t.purple, width: 2.5 } },
  ];
  if (measured.length) {
    data.push({
      x: measured.map((s) => s.intensity), y: measured.map((s) => s.lactate),
      name: 'Your measured samples', mode: 'markers',
      marker: { color: t.gold, size: 10, line: { color: t.marker, width: 2 } },
    });
  }

  const yMax = 1.1 * Math.max(maxOf(inWindow(I, profile.curves.lactate, win)), maxOf(measured.map((s) => s.lactate)), 1);
  const y2Max = 1.1 * Math.max(maxOf(inWindow(I, profile.curves.vLass, win)), maxOf(inWindow(I, profile.curves.vLaoxmax, win)), 0.01);
  const close = Math.abs(profile.mlss.intensity - profile.lt1.intensity) < 0.08 * (win[1] - win[0]);

  const layout = Object.assign(baseLayout(t, narrow, true), {
    xaxis: xAxisFor(t, sport, win, opts.paceUnit, narrow),
    yaxis: Object.assign(axisBase(t, narrow, 'Blood lactate (mmol/L)'), { range: [0, yMax] }),
    yaxis2: Object.assign(axisBase(t, narrow, 'Lactate flux (mmol/L · s⁻¹)'), { overlaying: 'y', side: 'right', gridcolor: 'rgba(0,0,0,0)', range: [0, y2Max] }),
    shapes: [
      { type: 'line', x0: profile.mlss.intensity, x1: profile.mlss.intensity, y0: 0, y1: 1, yref: 'paper',
        line: { color: t.good, width: 1.5, dash: 'dash' } },
      { type: 'line', x0: profile.lt1.intensity,  x1: profile.lt1.intensity,  y0: 0, y1: 1, yref: 'paper',
        line: { color: t.purple, width: 1.5, dash: 'dash' } },
    ],
    annotations: [
      { x: profile.mlss.intensity, y: 1, yref: 'paper', text: 'MLSS', showarrow: false, font: { color: t.good, size: 11, family: t.ui }, yshift: -8 },
      { x: profile.lt1.intensity,  y: 1, yref: 'paper', text: 'LT1',  showarrow: false, font: { color: t.purple, size: 11, family: t.ui }, yshift: close ? -26 : -8 },
    ],
  });
  return { data, layout };
}

function buildSubstrateFigure(themeName, elementId, profile, sport, opts) {
  const t = chartTheme(themeName);
  const narrow = themeName === 'pdf' ? false : isNarrow(elementId);
  const I = profile.curves.intensities;
  const win = xWindow(profile, null);

  const data = [
    { x: I, y: profile.curves.fatOx, name: 'Fat burned (g/min)', mode: 'lines',
      line: { color: t.gold, width: 2.5 }, fill: 'tozeroy', fillcolor: t.goldWash },
    { x: I, y: profile.curves.choOx, name: 'Carbs burned (g/min)', mode: 'lines',
      line: { color: t.coral, width: 2.5 }, fill: 'tozeroy', fillcolor: t.coralWash },
  ];
  const yMax = 1.1 * Math.max(maxOf(inWindow(I, profile.curves.fatOx, win)), maxOf(inWindow(I, profile.curves.choOx, win)), 0.1);

  const layout = Object.assign(baseLayout(t, narrow, false), {
    xaxis: xAxisFor(t, sport, win, opts.paceUnit, narrow),
    yaxis: Object.assign(axisBase(t, narrow, 'Grams burned per minute'), { range: [0, yMax] }),
    shapes: [
      { type: 'line', x0: profile.fatmax.intensity, x1: profile.fatmax.intensity, y0: 0, y1: 1, yref: 'paper',
        line: { color: t.gold, width: 1.5, dash: 'dash' } },
    ],
    annotations: [
      { x: profile.fatmax.intensity, y: 1, yref: 'paper', text: 'Fatmax', showarrow: false, font: { color: t.gold, size: 11, family: t.ui }, yshift: -8 },
    ],
  });
  return { data, layout };
}

/**
 * Render the lactate production/elimination + simulated [La] chart.
 *
 * @param {string} elementId            Target DOM element id
 * @param {Object} profile              Output of getMetabolicProfile()
 * @param {string} sport                'cycling' | 'running'
 * @param {Array}  [measuredStages]     Optional [{intensity, lactate}, ...]
 * @param {Object} [opts]               { paceUnit: 'mi' | 'km' }
 */
export function drawLactateChart(elementId, profile, sport, measuredStages, opts) {
  if (!window.Plotly) { console.warn('Plotly not loaded'); return; }
  opts = opts || {};
  const build = (themeName) => buildLactateFigure(themeName, elementId, profile, sport, measuredStages, opts);
  lastArgs.set(elementId, { fn: drawLactateChart, args: [profile, sport, measuredStages, opts], build });
  plot(elementId, build('screen'));
}

/**
 * Render the fat/CHO substrate-oxidation chart with Fatmax marker.
 *
 * @param {string} elementId   Target DOM element id
 * @param {Object} profile     Output of getMetabolicProfile()
 * @param {string} sport       'cycling' | 'running'
 * @param {Object} [opts]      { paceUnit: 'mi' | 'km' }
 */
export function drawSubstrateChart(elementId, profile, sport, opts) {
  if (!window.Plotly) { console.warn('Plotly not loaded'); return; }
  opts = opts || {};
  const build = (themeName) => buildSubstrateFigure(themeName, elementId, profile, sport, opts);
  lastArgs.set(elementId, { fn: drawSubstrateChart, args: [profile, sport, opts], build });
  plot(elementId, build('screen'));
}

/** Re-render every chart still on the page (e.g. after a theme change). */
export function redrawAllCharts() {
  lastArgs.forEach((a, id) => { if (document.getElementById(id)) a.fn(id, ...a.args); });
}

/** {data, layout} for a drawn chart, rebuilt with the light PDF theme (or null). */
export function chartFigureForExport(id) {
  const a = lastArgs.get(id);
  return a ? a.build('pdf') : null;
}
