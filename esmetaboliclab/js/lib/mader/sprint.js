/*
 * VLamax from a 15-second all-out sprint (Mader 1994 protocol).
 *
 *   vLamax = (La_peak_post − La_pre) / (t_test − t_PCr)
 *
 * Where t_PCr is the alactic phosphocreatine contribution time (~3.5 s),
 * representing the period at the start of the sprint during which phosphagen
 * stores supply ATP without engaging glycolysis.
 *
 * References:
 *   Mader 1994 — original protocol
 *   Quittmann et al. 2018, Eur J Appl Physiol — reliability
 *   Heck & Schulz — t_PCr calibration
 */

import { MADER } from './constants.js';

/**
 * Compute VLamax from sprint inputs.
 *
 * Returns two issue tiers:
 *   - `errors`   — physically implausible / unusable values. Callers should
 *                  refuse to save, mark the value invalid, and prompt the
 *                  athlete to re-check measurements.
 *   - `warnings` — unusual but plausible (e.g. elite-sprinter VLamax > 1.0).
 *                  Soft heads-up only; the value is still usable.
 *
 * @param {Object} input
 * @param {number} input.La_pre        pre-sprint blood lactate (mmol/L)
 * @param {number} input.La_peak_post  peak post-sprint blood lactate (mmol/L)
 * @param {number} input.duration_s    sprint duration in seconds (typ 15)
 * @param {number} [input.t_PCr_s]     alactic phosphagen time, default 3.5 s
 * @returns {{ VLamax: number, glycolytic_time_s: number, delta_La: number, warnings: string[], errors: string[] }}
 */
export function computeVLamax(input) {
  const La_pre = +input.La_pre;
  const La_peak_post = +input.La_peak_post;
  const duration_s = +input.duration_s;
  const t_PCr_s = +(input.t_PCr_s != null ? input.t_PCr_s : MADER.tPCr_default);

  const warnings = [];
  const errors = [];

  if (!isFinite(La_pre) || La_pre < 0)        errors.push('Pre-sprint lactate looks invalid.');
  if (!isFinite(La_peak_post) || La_peak_post < 0) errors.push('Post-sprint lactate looks invalid.');
  if (!isFinite(duration_s) || duration_s <= t_PCr_s) {
    errors.push('Sprint duration must exceed phosphagen contribution time (~3.5 s).');
  }
  if (La_peak_post <= La_pre) {
    errors.push('Peak post-sprint lactate must exceed pre-sprint lactate.');
  }
  if (La_peak_post > 30) {
    errors.push('Peak post-sprint lactate above 30 mmol/L is physically implausible — re-check your meter.');
  }
  if (duration_s < 10 || duration_s > 30) {
    warnings.push('Sprint duration outside the validated 10–30 s window — results approximate.');
  }

  const glycolytic_time_s = Math.max(0.001, duration_s - t_PCr_s);
  const delta_La = La_peak_post - La_pre;
  const VLamax = delta_La / glycolytic_time_s;

  // Hard error: physically implausible. Top human sprinters land around
  // 1.0–1.5 mmol/L/s; anything above ~2.5 implies a measurement error
  // (wrong unit, sampled too late, contaminated strip).
  if (isFinite(VLamax) && (VLamax > 2.5 || (VLamax > 0 && VLamax < 0.05))) {
    errors.push(
      'Computed VLamax (' + VLamax.toFixed(2) + ' mmol/L/s) is physically implausible — '
      + 'typical values fall between 0.15 and 1.5. Double-check your pre and peak lactate readings '
      + '(meter in mmol/L, not mg/dL) and your sprint duration.'
    );
  } else if (isFinite(VLamax) && (VLamax < 0.15 || VLamax > 1.5)) {
    warnings.push('VLamax outside the typical 0.15–1.5 mmol/L/s range — common in elite sprinters or pure endurance specialists, but worth a sanity check.');
  }

  return { VLamax, glycolytic_time_s, delta_La, warnings, errors };
}

/**
 * Population priors for VLamax when no sprint is available.
 * Used only when the athlete explicitly opts in — accuracy is degraded.
 */
export function estimateVLamaxFromPriors({ sex, sport }) {
  // Broad, conservative midpoints from literature ranges.
  const table = {
    cycling: { M: 0.45, F: 0.40 },
    running: { M: 0.55, F: 0.50 },
  };
  const sportRow = table[sport] || table.cycling;
  return sportRow[sex] || 0.45;
}
