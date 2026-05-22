/*
 * Hill-type kinetic functions for glycolytic and oxidative ATP supply,
 * both modeled as functions of free cytosolic [ADP].
 *
 *   vLass(ADP) = VLamax / (1 + (K2/ADP)^n2)
 *   vO2ss(ADP) = VO2max / (1 + (K1/ADP)^n1)
 *
 * Both forms are equivalent to the standard Hill / Michaelis–Menten
 * activation curve, where the flux equals half its maximum at ADP = K.
 *
 * Units:
 *   ADP       mmol/kg (cytosolic, free)
 *   VLamax    mmol/L/s  (whole-body blood lactate accumulation rate)
 *   vLass     mmol/L/s
 *   VO2max    mL/min/kg body mass
 *   vO2ss     mL/min/kg body mass
 *
 * The vLaoxmax (maximum rate of lactate elimination via oxidation) is
 * expressed in lactate-equivalent units so it can be balanced against
 * vLass directly. The conversion uses the 1-lactate-to-3-O2 stoichiometry
 * plus the active-muscle pool scaling.
 */

import { MADER } from './constants.js';

/**
 * Glycolytic lactate-production flux at steady state, given [ADP].
 * @param {number} ADP       — free [ADP] in mmol/kg
 * @param {number} VLamax    — max glycolytic rate, mmol/L/s
 * @returns {number} glycolytic flux, mmol/L/s
 */
export function vLass(ADP, VLamax) {
  if (ADP <= 0) return 0;
  const ratio = MADER.K2 / ADP;
  return VLamax / (1 + Math.pow(ratio, MADER.n2));
}

/**
 * Oxidative ATP-supply flux at steady state, given [ADP].
 * Expressed as O2 consumption rate.
 * @param {number} ADP      — free [ADP] in mmol/kg
 * @param {number} VO2max   — aerobic ceiling, mL/min/kg
 * @returns {number} oxidative flux, mL O2 / min / kg
 */
export function vO2ss(ADP, VO2max) {
  if (ADP <= 0) return 0;
  const ratio = MADER.K1 / ADP;
  return VO2max / (1 + Math.pow(ratio, MADER.n1));
}

/**
 * Maximum rate at which oxidation can clear lactate, expressed in
 * blood-lactate equivalents (mmol/L/s) so it lives in the same units as vLass.
 *
 * Derivation:
 *   vO2ss is in mL O2/min/kg body mass.
 *   1 mmol of lactate oxidized consumes O2_per_lactate (= 3) mmol of O2.
 *   1 mmol O2 at STPD ≈ 22.414 mL O2.
 *   So mL O2/min/kg → mmol O2/min/kg by dividing by 22.414.
 *   Dividing by O2_per_lactate gives mmol La/min/kg of body mass (potential).
 *   Convert /min → /s by /60.
 *   Active-muscle pool: only a fraction of body mass is metabolically active,
 *   so the per-kg-body-mass capacity is what we want — no extra scaling here,
 *   since both vLass and vO2ss are already whole-body terms.
 *
 * The result is the per-second whole-body lactate-elimination capacity that
 * the oxidative system can support at this ADP, expressed in mmol/L/s for
 * direct comparison with vLass.
 *
 * Note on units: vLass is mmol/L/s (blood). To compare with the O2-derived
 * elimination capacity (which is per kg of body mass), we use the standard
 * Mader convention of treating blood lactate as distributed across the
 * lactate-distribution-space of ~50% body mass. With water/distribution
 * volume of ~0.5 L/kg, the unit conversion folds in cleanly: mmol/min/kg
 * body mass × (1 / 0.5 L/kg) → mmol/L/min. That additional factor of 2
 * (= 1 / 0.5) is folded into the conversion below.
 *
 * @param {number} ADP    — free [ADP] in mmol/kg
 * @param {number} VO2max — mL/min/kg
 * @returns {number} max lactate elimination via oxidation, mmol/L/s
 */
export function vLaoxmax(ADP, VO2max) {
  const vo2 = vO2ss(ADP, VO2max);                       // mL O2 / min / kg
  const mmolO2_per_min_per_kg = vo2 / 22.414;           // mmol O2 / min / kg
  const mmolLa_per_min_per_kg = mmolO2_per_min_per_kg
                              / MADER.O2_per_lactate_mmol_per_mmol; // ÷ 3
  const mmolLa_per_min_per_L  = mmolLa_per_min_per_kg / 0.5;        // ÷ 0.5 L/kg
  return mmolLa_per_min_per_L / 60;                                 // /s
}

/**
 * Resting (baseline) [ADP] that produces a small but nonzero oxidative flux.
 * Used as a floor for the simulation. Not physiologically critical but keeps
 * the curve smooth near zero intensity.
 */
export const ADP_REST = 0.005;  // mmol/kg

/**
 * Convenience: simulated steady-state blood lactate at a given ADP, given a
 * production and elimination flux. We use a simple steady-state mass balance:
 *
 *   [La]_ss = La_baseline + max(0, vLass - vLaoxmax) * tau
 *
 * where tau (~ a few minutes) lumps the elimination time constant into a
 * single empirical scale factor. For the Mader implementation, the more
 * principled approach is to find the [La] at which production = elimination
 * at that intensity, but the dependence of elimination on [La] requires
 * a separate kinetic term we don't model here. Instead, simulatedLactate()
 * is provided by solver.js using the iterative MLSS root-finder.
 *
 * Don't use this function directly for the lactate curve — see solver.js.
 */
