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
 */

const PLOT_STYLE = {
  paper_bgcolor: '#0e1018',
  plot_bgcolor:  '#0e1018',
  font: { color: '#e8ecf8', family: 'DM Sans, sans-serif' },
  gridcolor: '#1a1d27',
};

const METERS_PER_MILE = 1609.344;

/**
 * Generate Plotly x-axis config that displays a speed (m/s) axis with
 * pace tick labels (m:ss/mi or /km). Picks whole-minute ticks that fall
 * inside the data range; adds half-minute ticks when the visible range
 * is narrow.
 */
function paceAxisConfig(intensities, unit) {
  const finite = intensities.filter((v) => isFinite(v) && v > 0);
  if (!finite.length) return {};
  const minV = Math.max(0.5, Math.min(...finite));
  const maxV = Math.max(...finite);
  const M = unit === 'mi' ? METERS_PER_MILE : 1000;
  // Pace bounds (min per unit) from the speed range. Faster speed = smaller pace.
  const fastPace = M / maxV / 60;
  const slowPace = M / minV / 60;
  const span     = slowPace - fastPace;
  // For narrow ranges (<= 4 min span), include half-minute ticks
  const step = span <= 4 ? 0.5 : 1;
  const startPace = Math.max(2, Math.floor(fastPace * 2) / 2);   // round down to .5
  const endPace   = Math.min(30, Math.ceil(slowPace * 2) / 2);

  const tickvals = [];
  const ticktext = [];
  for (let p = startPace; p <= endPace + 1e-9; p += step) {
    const v = M / (p * 60);
    if (v >= minV * 0.98 && v <= maxV * 1.02) {
      tickvals.push(v);
      const min = Math.floor(p);
      const sec = Math.round((p - min) * 60);
      const label = min + ':' + (sec < 10 ? '0' : '') + sec;
      ticktext.push(label);
    }
  }
  return { tickmode: 'array', tickvals, ticktext };
}

function xAxisFor(sport, intensities, paceUnit) {
  if (sport === 'cycling') {
    return {
      title: 'Power (watts)',
      gridcolor: PLOT_STYLE.gridcolor,
      zerolinecolor: PLOT_STYLE.gridcolor,
    };
  }
  const unitLabel = paceUnit === 'km' ? 'min per kilometer' : 'min per mile';
  return Object.assign(
    {
      title: 'Pace (' + unitLabel + ')',
      gridcolor: PLOT_STYLE.gridcolor,
      zerolinecolor: PLOT_STYLE.gridcolor,
    },
    paceAxisConfig(intensities, paceUnit || 'mi')
  );
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
  const intensities = profile.curves.intensities;

  const traces = [
    { x: intensities, y: profile.curves.vLass,
      name: 'Lactate production',
      mode: 'lines', line: { color: '#ff6b35', width: 2.5 }, yaxis: 'y2' },
    { x: intensities, y: profile.curves.vLaoxmax,
      name: 'Max lactate clearance',
      mode: 'lines', line: { color: '#00e5c8', width: 2.5, dash: 'dot' }, yaxis: 'y2' },
    { x: intensities, y: profile.curves.lactate,
      name: 'Predicted blood lactate at each effort',
      mode: 'lines', line: { color: '#8b7cf8', width: 2.5 } },
  ];

  if (measuredStages && measuredStages.length) {
    traces.push({
      x: measuredStages.map((s) => s.intensity),
      y: measuredStages.map((s) => s.lactate),
      name: 'Your measured samples',
      mode: 'markers',
      marker: { color: '#f5c842', size: 10, line: { color: '#0e1018', width: 2 } },
    });
  }

  const layout = {
    paper_bgcolor: PLOT_STYLE.paper_bgcolor, plot_bgcolor: PLOT_STYLE.plot_bgcolor,
    font: PLOT_STYLE.font,
    margin: { t: 16, r: 70, b: 50, l: 60 },
    xaxis: xAxisFor(sport, intensities, opts.paceUnit),
    yaxis:  { title: 'Blood lactate (mmol/L)', gridcolor: PLOT_STYLE.gridcolor, zerolinecolor: PLOT_STYLE.gridcolor, rangemode: 'tozero' },
    yaxis2: { title: 'Lactate flux (mmol/L · s⁻¹)', overlaying: 'y', side: 'right', gridcolor: 'transparent', rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.22, x: 0 },
    shapes: [
      { type: 'line', x0: profile.mlss.intensity, x1: profile.mlss.intensity, y0: 0, y1: 1, yref: 'paper',
        line: { color: '#22c78a', width: 1.5, dash: 'dash' } },
      { type: 'line', x0: profile.lt1.intensity,  x1: profile.lt1.intensity,  y0: 0, y1: 1, yref: 'paper',
        line: { color: '#8b7cf8', width: 1.5, dash: 'dash' } },
    ],
    annotations: [
      { x: profile.mlss.intensity, y: 1, yref: 'paper', text: 'MLSS', showarrow: false, font: { color: '#22c78a' }, yshift: -8 },
      { x: profile.lt1.intensity,  y: 1, yref: 'paper', text: 'LT1',  showarrow: false, font: { color: '#8b7cf8' }, yshift: -8 },
    ],
  };
  window.Plotly.newPlot(elementId, traces, layout, { displayModeBar: false, responsive: true });
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
  const intensities = profile.curves.intensities;

  const traces = [
    { x: intensities, y: profile.curves.fatOx, name: 'Fat burned (g/min)', mode: 'lines',
      line: { color: '#f5c842', width: 2.5 },
      fill: 'tozeroy', fillcolor: 'rgba(245,200,66,0.10)' },
    { x: intensities, y: profile.curves.choOx, name: 'Carbs burned (g/min)', mode: 'lines',
      line: { color: '#ff6b35', width: 2.5 },
      fill: 'tozeroy', fillcolor: 'rgba(255,107,53,0.08)' },
  ];

  const layout = {
    paper_bgcolor: PLOT_STYLE.paper_bgcolor, plot_bgcolor: PLOT_STYLE.plot_bgcolor,
    font: PLOT_STYLE.font,
    margin: { t: 16, r: 30, b: 50, l: 60 },
    xaxis: xAxisFor(sport, intensities, opts.paceUnit),
    yaxis: { title: 'Grams burned per minute', gridcolor: PLOT_STYLE.gridcolor, zerolinecolor: PLOT_STYLE.gridcolor, rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.22, x: 0 },
    shapes: [
      { type: 'line', x0: profile.fatmax.intensity, x1: profile.fatmax.intensity, y0: 0, y1: 1, yref: 'paper',
        line: { color: '#f5c842', width: 1.5, dash: 'dash' } },
    ],
    annotations: [
      { x: profile.fatmax.intensity, y: 1, yref: 'paper', text: 'Fatmax', showarrow: false, font: { color: '#f5c842' }, yshift: -8 },
    ],
  };
  window.Plotly.newPlot(elementId, traces, layout, { displayModeBar: false, responsive: true });
}
