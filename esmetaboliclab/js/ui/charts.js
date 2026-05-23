/*
 * Shared chart rendering for esMetabolicLab profile pages.
 *
 * The lactate-anchored Lactate Step Test and the Power/Pace-only profile
 * both render the same two headline charts:
 *
 *   1. drawLactateChart — vLass (production) + vLaoxmax (elimination)
 *      + simulated [La] curve, with measured step-test points overlaid
 *      when available.
 *   2. drawSubstrateChart — fat / CHO oxidation g/min vs intensity, with
 *      a vertical at Fatmax.
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

/**
 * Render the lactate production/elimination + simulated [La] chart.
 *
 * @param {string} elementId             Target DOM element id
 * @param {Object} profile               Output of getMetabolicProfile()
 * @param {string} sport                 'cycling' | 'running'
 * @param {Array}  [measuredStages]      Optional [{intensity, lactate}, ...]
 */
export function drawLactateChart(elementId, profile, sport, measuredStages) {
  if (!window.Plotly) { console.warn('Plotly not loaded'); return; }
  const intensities = profile.curves.intensities;
  const xLabel = sport === 'cycling' ? 'Power (W)' : 'Speed (m/s)';

  const traces = [
    { x: intensities, y: profile.curves.vLass,
      name: 'vLass — glycolytic production',
      mode: 'lines', line: { color: '#ff6b35', width: 2.5 }, yaxis: 'y2' },
    { x: intensities, y: profile.curves.vLaoxmax,
      name: 'vLaoxmax — oxidative elimination cap',
      mode: 'lines', line: { color: '#00e5c8', width: 2.5, dash: 'dot' }, yaxis: 'y2' },
    { x: intensities, y: profile.curves.lactate,
      name: 'Simulated [La]',
      mode: 'lines', line: { color: '#8b7cf8', width: 2.5 } },
  ];

  if (measuredStages && measuredStages.length) {
    traces.push({
      x: measuredStages.map((s) => s.intensity),
      y: measuredStages.map((s) => s.lactate),
      name: 'Measured [La]',
      mode: 'markers',
      marker: { color: '#f5c842', size: 10, line: { color: '#0e1018', width: 2 } },
    });
  }

  const layout = {
    paper_bgcolor: PLOT_STYLE.paper_bgcolor, plot_bgcolor: PLOT_STYLE.plot_bgcolor,
    font: PLOT_STYLE.font,
    margin: { t: 16, r: 60, b: 50, l: 60 },
    xaxis:  { title: xLabel, gridcolor: PLOT_STYLE.gridcolor, zerolinecolor: PLOT_STYLE.gridcolor },
    yaxis:  { title: '[La] (mmol/L)', gridcolor: PLOT_STYLE.gridcolor, zerolinecolor: PLOT_STYLE.gridcolor, rangemode: 'tozero' },
    yaxis2: { title: 'Flux (mmol/L/s)', overlaying: 'y', side: 'right', gridcolor: 'transparent', rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.18, x: 0 },
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
 */
export function drawSubstrateChart(elementId, profile, sport) {
  if (!window.Plotly) { console.warn('Plotly not loaded'); return; }
  const intensities = profile.curves.intensities;
  const xLabel = sport === 'cycling' ? 'Power (W)' : 'Speed (m/s)';

  const traces = [
    { x: intensities, y: profile.curves.fatOx, name: 'Fat oxidation', mode: 'lines',
      line: { color: '#f5c842', width: 2.5 },
      fill: 'tozeroy', fillcolor: 'rgba(245,200,66,0.10)' },
    { x: intensities, y: profile.curves.choOx, name: 'CHO oxidation', mode: 'lines',
      line: { color: '#ff6b35', width: 2.5 },
      fill: 'tozeroy', fillcolor: 'rgba(255,107,53,0.08)' },
  ];

  const layout = {
    paper_bgcolor: PLOT_STYLE.paper_bgcolor, plot_bgcolor: PLOT_STYLE.plot_bgcolor,
    font: PLOT_STYLE.font,
    margin: { t: 16, r: 30, b: 50, l: 60 },
    xaxis: { title: xLabel, gridcolor: PLOT_STYLE.gridcolor, zerolinecolor: PLOT_STYLE.gridcolor },
    yaxis: { title: 'g/min',  gridcolor: PLOT_STYLE.gridcolor, zerolinecolor: PLOT_STYLE.gridcolor, rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.18, x: 0 },
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
