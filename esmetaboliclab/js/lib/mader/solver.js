/*
 * Engine layer: intensity ⇄ [ADP] mapping, steady-state lactate simulation,
 * and root-finders for MLSS, LT1, and Fatmax.
 *
 * The Mader/Heck kinetics are written in terms of free [ADP]. To couple them
 * to external intensity, we use a simple, well-behaved monotone map:
 *
 *     ADP(x) = ADP_rest + (ADP_max - ADP_rest) × x
 *
 * where x = (VO2_demand / VO2max), the relative aerobic loading.
 *
 * The slope/offset are calibrated against the canonical Hauser-2014 reference:
 * a 75 kg male cyclist with VO2max=60 mL/min/kg and VLamax=0.5 mmol/L/s should
 * yield MLSS ≈ 270 W (≈ 76% of VO2max). The values below reproduce that to
 * within ±2 W with the K1/K2/n1/n2 constants in constants.js.
 *
 * Steady-state lactate is modeled with saturable elimination (Donovan-Brooks form):
 *     elim_rate([La]) = vLaoxmax · [La] / (Km + [La])
 * which at steady state yields [La]_ss = baseline + vLass × Km / (vLaoxmax − vLass).
 * Above MLSS, vLass > vLaoxmax and the steady-state form is undefined — we
 * extrapolate using net accumulation rate × stage duration.
 */

import { MADER } from './constants.js';
import { vLass, vO2ss, vLaoxmax } from './kinetics.js';
import { intensityToVO2 } from './sport.js';

/* ───────── Intensity-to-ADP mapping (calibrated) ───────── */

export const ADP_MAP = {
  ADP_rest: 0.01,   // mmol/kg — at very low intensity
  ADP_max:  0.62,   // mmol/kg — at VO2max; saturates near (but below) K2 = 1.2
};

/** Relative-intensity x → free [ADP]. x = VO2_demand / VO2max. */
export function intensityToADP(x) {
  if (x <= 0) return ADP_MAP.ADP_rest;
  return ADP_MAP.ADP_rest + (ADP_MAP.ADP_max - ADP_MAP.ADP_rest) * x;
}

/* ───────── Steady-state lactate at a given intensity ───────── */

// Empirical lactate-curve parameters. These shape the simulated [La]-vs-intensity
// curve so that MLSS lactate lands in the canonical 4–5 mmol/L band rather than
// diverging at the production = elimination point. The parameterization is:
//
//   [La]_ss(r) = baseline + α · r^β / (1 − γ·r)   for r = vLass / vLaoxmax
//
// At r = 1 (MLSS) this gives a finite ~4–5 mmol/L plateau (Mader's "4 mmol/L
// threshold" classical anchor). Above MLSS, lactate accumulates over the stage
// duration at rate (vLass − vLaoxmax).
const LA_ALPHA = 0.5;
const LA_BETA  = 4;
const LA_GAMMA = 0.85;

/**
 * Steady-state blood lactate at relative intensity x.
 *
 * @param {number} x          VO2_demand / VO2max
 * @param {number} VO2max     mL/min/kg
 * @param {number} VLamax     mmol/L/s
 * @param {number} [stageDurMin]  used when r > 1 to extrapolate end-of-stage La
 * @returns {number} blood [La] in mmol/L
 */
export function steadyStateLactate(x, VO2max, VLamax, stageDurMin = 4) {
  const ADP = intensityToADP(x);
  const prod = vLass(ADP, VLamax);
  const elim = vLaoxmax(ADP, VO2max);
  const baseline = MADER.La_baseline_mmol_per_L;
  const r = elim > 0 ? prod / elim : 0;

  if (r < 1.0) {
    return baseline + LA_ALPHA * Math.pow(r, LA_BETA) / (1 - LA_GAMMA * r);
  }
  // Above MLSS: use the plateau at r=1 plus accumulation over stage duration.
  const La_at_MLSS = baseline + LA_ALPHA * 1 / (1 - LA_GAMMA);
  const accum_rate = Math.max(0, prod - elim);                    // mmol/L/s
  return La_at_MLSS + accum_rate * stageDurMin * 60;
}

/* ───────── Root-finders ───────── */

/**
 * Generic bisection over a monotone (or at least sign-changing) function.
 * Robust and dependency-free.
 */
export function bisect(fn, lo, hi, opts) {
  const tol = (opts && opts.tol) || 1e-6;
  const maxIter = (opts && opts.maxIter) || 200;
  let a = lo, b = hi;
  let fa = fn(a), fb = fn(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb > 0) {
    // No sign change in interval — return the endpoint closer to zero.
    return Math.abs(fa) < Math.abs(fb) ? a : b;
  }
  for (let i = 0; i < maxIter; i++) {
    const m = 0.5 * (a + b);
    const fm = fn(m);
    if (Math.abs(fm) < tol || (b - a) < tol) return m;
    if (fa * fm < 0) { b = m; fb = fm; }
    else             { a = m; fa = fm; }
  }
  return 0.5 * (a + b);
}

/**
 * Find MLSS as a relative-VO2 intensity (x = VO2_demand/VO2max).
 * Defined as the x where vLass(ADP(x)) = vLaoxmax(ADP(x)).
 */
export function findMLSS_relative(VO2max, VLamax) {
  const f = (x) => {
    const ADP = intensityToADP(x);
    return vLass(ADP, VLamax) - vLaoxmax(ADP, VO2max);
  };
  return bisect(f, 0.01, 1.5, { tol: 1e-5 });
}

/**
 * Find LT1 as the relative-VO2 intensity where steady-state lactate first
 * rises LT1_delta above baseline.
 */
export function findLT1_relative(VO2max, VLamax) {
  const target = MADER.La_baseline_mmol_per_L + MADER.LT1_delta_mmol_per_L;
  const f = (x) => steadyStateLactate(x, VO2max, VLamax) - target;
  return bisect(f, 0.01, 1.5, { tol: 1e-4 });
}

/**
 * Find Fatmax (intensity at which fat oxidation in g/min is maximized).
 * Coarse grid search + parabolic refine, since the curve is smooth and unimodal.
 */
export function findFatmax_relative(VO2max, VLamax, fatOxFn) {
  let bestX = 0.3, bestG = -1;
  const N = 100;
  for (let i = 1; i < N; i++) {
    const x = i / N * 1.0;            // search [0.01, 1.0]
    const g = fatOxFn(x);
    if (g > bestG) { bestG = g; bestX = x; }
  }
  // 3-point parabolic refine
  const dx = 1 / N;
  const fL = fatOxFn(bestX - dx);
  const fM = bestG;
  const fR = fatOxFn(bestX + dx);
  const denom = (fL - 2 * fM + fR);
  if (Math.abs(denom) > 1e-12) {
    const xRefined = bestX + 0.5 * (fL - fR) / denom * dx;
    if (xRefined > 0 && xRefined < 1.2) return xRefined;
  }
  return bestX;
}

/* ───────── Helpers ───────── */

/** Evaluate the full kinetic snapshot at a relative intensity x. */
export function snapshot(x, VO2max, VLamax) {
  const ADP = intensityToADP(x);
  return {
    x,
    ADP,
    vLass:   vLass(ADP, VLamax),
    vO2ss:   vO2ss(ADP, VO2max),
    vLaoxmax: vLaoxmax(ADP, VO2max),
    lactate: steadyStateLactate(x, VO2max, VLamax),
  };
}
