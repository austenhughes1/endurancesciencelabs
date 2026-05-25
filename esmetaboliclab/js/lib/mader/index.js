/*
 * Public engine API. The UI layer (and any test harness) calls
 * getMetabolicProfile(inputs) and gets back a complete profile object.
 *
 * Nothing in this module knows anything about the DOM, Plotly, or Firebase.
 */

import { MADER, SANITY_RANGES } from './constants.js';
import { vLass, vO2ss, vLaoxmax } from './kinetics.js';
import {
  intensityToADP,
  steadyStateLactate,
  snapshot,
  findMLSS_relative,
  findLT1_relative,
  findFatmax_relative,
} from './solver.js';
import { intensityToVO2, vO2ToIntensity } from './sport.js';
import { computeVLamax } from './sprint.js';
import { substrateOxidation } from './substrate.js';
import { fitVO2max, sensitivityVO2max } from './fit.js';

/**
 * Build the curve arrays for the headline dual-curve metabolic plot.
 *
 * @param {number} VO2max  — fitted or supplied (mL/min/kg)
 * @param {number} VLamax  — supplied (mmol/L/s)
 * @param {string} sport
 * @param {Object} ctx     — { bodyMass, GE, Cr }
 */
function buildCurves(VO2max, VLamax, sport, ctx) {
  const N = 121;
  const xMax = 1.4;
  const intensities = [];      // user-facing units (W or m/s)
  const xs = [];               // relative intensity x = vo2_demand / VO2max
  const vLassArr = [];
  const vLaoxArr = [];
  const vO2Arr = [];
  const lactateArr = [];
  const fatArr = [];
  const choArr = [];

  for (let i = 0; i <= N; i++) {
    const x = (i / N) * xMax;
    const ADP = intensityToADP(x);
    const vo2_demand = x * VO2max;
    const intensity = vO2ToIntensity(sport, vo2_demand, ctx);
    const sub = substrateOxidation(x, VO2max, VLamax, ctx);

    xs.push(x);
    intensities.push(intensity);
    vLassArr.push(vLass(ADP, VLamax));
    vLaoxArr.push(vLaoxmax(ADP, VO2max));
    vO2Arr.push(vO2ss(ADP, VO2max));
    lactateArr.push(steadyStateLactate(x, VO2max, VLamax));
    fatArr.push(sub.fat_g_per_min);
    choArr.push(sub.cho_g_per_min);
  }

  return { xs, intensities, vLass: vLassArr, vLaoxmax: vLaoxArr, vO2: vO2Arr,
           lactate: lactateArr, fatOx: fatArr, choOx: choArr };
}

/**
 * Run the full profile.
 *
 * @param {Object} inputs
 * @param {string} inputs.sport          'cycling' | 'running'
 * @param {string} inputs.sex            'M' | 'F'
 * @param {number} inputs.bodyMass       kg
 * @param {number} inputs.VLamax         mmol/L/s
 * @param {Array}  inputs.steps          [{intensity, durationMin, lactate}]
 * @param {number} [inputs.VO2max]       if supplied, skip the fit
 * @param {Object} [inputs.options]      { GE, Cr }
 */
export function getMetabolicProfile(inputs) {
  const warnings = [];
  const sport = inputs.sport;
  const ctx = {
    bodyMass: inputs.bodyMass,
    GE: (inputs.options && inputs.options.GE) || MADER.cycling_GE_default,
    Cr: (inputs.options && inputs.options.Cr) || MADER.Cr_default_J_per_kg_per_m,
  };
  const stages = (inputs.steps || []).map(s => ({
    intensity: +s.intensity,
    durationMin: +(s.durationMin || 4),
    lactate: +s.lactate,
  }));

  // VO2max: fitted from lactate curve, or user-supplied
  let VO2max, rmse = null, sensitivity = null;
  if (typeof inputs.VO2max === 'number' && inputs.VO2max > 0) {
    VO2max = inputs.VO2max;
  } else {
    const fit = fitVO2max(stages, inputs.VLamax, sport, ctx);
    VO2max = fit.VO2max;
    rmse = fit.rmse;
    sensitivity = sensitivityVO2max(stages, inputs.VLamax, sport, ctx, 0.5);
  }

  // Thresholds
  const mlss_x  = findMLSS_relative(VO2max, inputs.VLamax);
  const lt1_x   = findLT1_relative(VO2max, inputs.VLamax);
  const mlss_vo2 = mlss_x * VO2max;
  const lt1_vo2  = lt1_x  * VO2max;
  const mlss_intensity = vO2ToIntensity(sport, mlss_vo2, ctx);
  const lt1_intensity  = vO2ToIntensity(sport, lt1_vo2,  ctx);

  const fatOxFn = (x) => substrateOxidation(x, VO2max, inputs.VLamax, ctx).fat_g_per_min;
  const fatmax_x = findFatmax_relative(VO2max, inputs.VLamax, fatOxFn);
  const fatmax_vo2 = fatmax_x * VO2max;
  const fatmax_intensity = vO2ToIntensity(sport, fatmax_vo2, ctx);
  const fatmax_g_per_min = fatOxFn(fatmax_x);

  // Sanity warnings
  if (VO2max < SANITY_RANGES.VO2max.lo || VO2max > SANITY_RANGES.VO2max.hi) {
    warnings.push('Fitted VO₂max (' + VO2max.toFixed(1) + ') is outside the typical 25–95 mL/min/kg range — re-check inputs.');
  }
  if (inputs.VLamax < SANITY_RANGES.VLamax.lo || inputs.VLamax > SANITY_RANGES.VLamax.hi) {
    warnings.push('VLamax (' + inputs.VLamax.toFixed(2) + ') outside the typical 0.10–2.0 mmol/L/s range — at the elite-sprinter or pure-endurance edge. Worth a sanity check.');
  }
  const mlssRatio = mlss_x;
  if (mlssRatio < SANITY_RANGES.MLSS_pct_VO2max.lo || mlssRatio > SANITY_RANGES.MLSS_pct_VO2max.hi) {
    warnings.push('MLSS is at an unusual ' + (mlssRatio * 100).toFixed(0) + '% of VO₂max — check VLamax and step-test lactate values.');
  }

  const curves = buildCurves(VO2max, inputs.VLamax, sport, ctx);

  return {
    inputs:    { sport, sex: inputs.sex, bodyMass: inputs.bodyMass,
                 VLamax: inputs.VLamax, VO2max_supplied: inputs.VO2max != null, options: ctx },
    VO2max,
    VLamax: inputs.VLamax,
    mlss:   { x: mlss_x, vo2: mlss_vo2, intensity: mlss_intensity,
              lactate: steadyStateLactate(mlss_x, VO2max, inputs.VLamax) },
    lt1:    { x: lt1_x,  vo2: lt1_vo2,  intensity: lt1_intensity,
              lactate: steadyStateLactate(lt1_x,  VO2max, inputs.VLamax) },
    fatmax: { x: fatmax_x, vo2: fatmax_vo2, intensity: fatmax_intensity,
              fat_g_per_min: fatmax_g_per_min },
    curves,
    diagnostics: { rmse, sensitivity, warnings },
  };
}

// Re-export the lower-level pieces so tests and the UI can use them.
export {
  MADER, SANITY_RANGES,
  vLass, vO2ss, vLaoxmax,
  intensityToADP, steadyStateLactate, snapshot,
  findMLSS_relative, findLT1_relative, findFatmax_relative,
  intensityToVO2, vO2ToIntensity,
  computeVLamax,
  substrateOxidation,
  fitVO2max, sensitivityVO2max,
};
