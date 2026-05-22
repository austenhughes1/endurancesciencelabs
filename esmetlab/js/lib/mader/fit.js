/*
 * Inverse problem: given a set of step-test stages (intensity, measured La)
 * and a separately-known VLamax, fit VO2max by minimizing residuals between
 * simulated and measured lactate values.
 *
 * Approach: bounded 1-D minimization (golden-section search). The Mader
 * lactate curve is monotone in VO2max for any fixed intensity (higher VO2max
 * pushes MLSS up, lowering lactate at every submax intensity), so the SSE
 * landscape is convex-ish and amenable to golden-section.
 */

import { MADER } from './constants.js';
import { steadyStateLactate } from './solver.js';
import { intensityToVO2 } from './sport.js';

/**
 * Sum of squared residuals between measured and simulated lactate.
 */
function sse(VO2max, VLamax, stages, sport, ctx) {
  let s = 0;
  for (const stg of stages) {
    const vo2_demand = intensityToVO2(sport, stg.intensity, ctx);
    const x = vo2_demand / VO2max;
    const La_sim = steadyStateLactate(x, VO2max, VLamax, stg.durationMin || 4);
    const r = La_sim - stg.lactate;
    s += r * r;
  }
  return s;
}

/**
 * Golden-section search for the VO2max that minimizes SSE.
 */
export function fitVO2max(stages, VLamax, sport, ctx) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = MADER.VO2max_fit_min;
  let b = MADER.VO2max_fit_max;

  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = sse(c, VLamax, stages, sport, ctx);
  let fd = sse(d, VLamax, stages, sport, ctx);

  for (let i = 0; i < 80; i++) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - phi * (b - a);
      fc = sse(c, VLamax, stages, sport, ctx);
    } else {
      a = c; c = d; fc = fd;
      d = a + phi * (b - a);
      fd = sse(d, VLamax, stages, sport, ctx);
    }
    if (b - a < 0.01) break;
  }
  const VO2max_fit = 0.5 * (a + b);
  const residual = Math.sqrt(sse(VO2max_fit, VLamax, stages, sport, ctx) / stages.length);
  return { VO2max: VO2max_fit, rmse: residual };
}

/**
 * Sensitivity: how much does the fitted VO2max shift when one stage's
 * measured lactate is perturbed by ±delta?
 *
 * Returns the maximum absolute shift across stages.
 */
export function sensitivityVO2max(stages, VLamax, sport, ctx, delta = 0.5) {
  const base = fitVO2max(stages, VLamax, sport, ctx).VO2max;
  let worst = 0;
  for (let i = 0; i < stages.length; i++) {
    const up = stages.map((s, j) => j === i ? Object.assign({}, s, { lactate: s.lactate + delta }) : s);
    const dn = stages.map((s, j) => j === i ? Object.assign({}, s, { lactate: s.lactate - delta }) : s);
    const fitUp = fitVO2max(up, VLamax, sport, ctx).VO2max;
    const fitDn = fitVO2max(dn, VLamax, sport, ctx).VO2max;
    worst = Math.max(worst, Math.abs(fitUp - base), Math.abs(fitDn - base));
  }
  return { delta_lactate: delta, max_VO2max_shift: worst, base_VO2max: base };
}
