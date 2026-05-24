/*
 * Substrate-utilization layer: fat / CHO oxidation rates from the Mader
 * model output, using the pyruvate-deficit theory.
 *
 *   - Total energy demand at intensity x is met by aerobic + anaerobic ATP.
 *   - Of the aerobic portion (vO2ss), some carbon comes from glycolytic
 *     pyruvate that did NOT get diverted to lactate; the remainder must come
 *     from fat oxidation.
 *   - The carbon balance: max pyruvate oxidation capacity minus the actual
 *     glycolytic flux available for oxidation = the "deficit" that gets
 *     filled by fat (β-oxidation feeding the TCA cycle).
 *
 * Stoichiometry (Péronnet & Massicotte 1991):
 *   1 g fat ↔ 2.02 L O2
 *   1 g CHO ↔ 0.83 L O2
 *
 * Reference: Mader 1984, Achten & Jeukendrup 2003, Frayn 1983.
 */

import { MADER } from './constants.js';
import { vLass } from './kinetics.js';
import { intensityToADP } from './solver.js';

/**
 * Fat / CHO oxidation rates at relative intensity x.
 *
 * Why we don't use vO2ss(ADP) for the aerobic VO2 here:
 *
 *   The Mader oxidative Hill curve has K1 = 0.035 mmol/kg, which saturates
 *   very quickly — at intensityToADP(x = 0.15) the ADP is already ~7 K1
 *   and vO2ss reads ~80% of VO2max. That's fine for MLSS root-finding
 *   (where the relevant ADP range is well past saturation) but it's wrong
 *   for substrate accounting at low intensities, where actual VO2 should
 *   scale ~linearly with relative intensity x.
 *
 *   So here we model aerobic VO2 as x × VO2max directly. The substrate
 *   curve and Fatmax then come out in physiologically sensible places
 *   (peak fat oxidation at ~60% VO2max for trained athletes, matching
 *   Achten & Jeukendrup 2003).
 *
 * Fat fraction model: fat_frac(x) = 0.70 × (1 − x)^0.7 × glycolytic_suppression.
 *   The (1 − x)^0.7 shape gives x_Fatmax ≈ 1 / (1 + 0.7) = 0.588 — i.e.
 *   peak fat oxidation in g/min lands around 59% VO2max, in the
 *   literature-typical band of 55–65% for trained athletes.
 *
 * Stoichiometry (Péronnet & Massicotte 1991):
 *   1 g fat ↔ 2.02 L O2
 *   1 g CHO ↔ 0.83 L O2
 *
 * @returns {{ fat_g_per_min: number, cho_g_per_min: number, fat_pct: number }}
 */
export function substrateOxidation(x, VO2max, VLamax, ctx) {
  const bodyMass = (ctx && ctx.bodyMass) || 70;

  // Aerobic VO2 scales linearly with relative intensity, capped at VO2max.
  const x_eff = Math.max(0, Math.min(1.0, x));
  const aerobic_VO2_mL_per_min_per_kg = x_eff * VO2max;
  const aerobic_VO2_L_per_min = aerobic_VO2_mL_per_min_per_kg * bodyMass / 1000;

  // Glycolytic suppression: at high intensity, accumulated pyruvate crowds
  // the mitochondrial import and CHO dominates.
  const ADP = intensityToADP(x);
  const glyc_flux = vLass(ADP, VLamax);
  const glyc_ratio = VLamax > 0 ? Math.min(1, glyc_flux / VLamax) : 0;

  // Fat fraction: starts high at low intensity, declines as x rises,
  // collapses faster when glycolysis ramps up.
  const fat_fraction = Math.max(
    0,
    0.70 * Math.pow(1 - x_eff, 0.7)
         * (1 - 0.6 * glyc_ratio)
  );

  const fat_VO2_L_per_min = aerobic_VO2_L_per_min * fat_fraction;
  const cho_VO2_L_per_min = aerobic_VO2_L_per_min * (1 - fat_fraction);

  const fat_g_per_min = fat_VO2_L_per_min / MADER.fat_O2_L_per_g;
  const cho_g_per_min = cho_VO2_L_per_min / MADER.cho_O2_L_per_g;

  return {
    fat_g_per_min,
    cho_g_per_min,
    fat_pct: fat_fraction,
  };
}
