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
import { vLass, vO2ss } from './kinetics.js';
import { intensityToADP } from './solver.js';

/**
 * Fat oxidation rate at relative intensity x.
 *
 * The fraction of aerobic VO2 fueled by fat ramps from ~0.4 at rest (fat-
 * dominant) down toward 0 as intensity rises and glycolysis crowds the
 * pyruvate pool. We model this with a smooth crossover anchored to the
 * Brooks-Mercier crossover concept:
 *
 *   fat_fraction(x) = max(0, 1 − (vLass / vLass_max_oxidation_rate))
 *
 * where the denominator is the rate at which glycolytic pyruvate fully
 * saturates the mitochondrial pyruvate-import capacity. With Hill K2=1.2,
 * n2=3 in ADP space, this gives the canonical crossover pattern (CHO takes
 * over above ~Fatmax which lies around 55–65% VO2max for trained athletes).
 *
 * @returns {{ fat_g_per_min: number, cho_g_per_min: number, fat_pct: number }}
 */
export function substrateOxidation(x, VO2max, VLamax, ctx) {
  const bodyMass = (ctx && ctx.bodyMass) || 70;
  const ADP = intensityToADP(x);

  const aerobic_VO2_mL_per_min = vO2ss(ADP, VO2max) * bodyMass;       // mL O2/min total
  const aerobic_VO2_L_per_min  = aerobic_VO2_mL_per_min / 1000;

  // Glycolytic pyruvate "competition" — at high intensity the mitochondria
  // are filled by pyruvate, leaving no room for fat-derived acetyl-CoA.
  // We anchor the crossover so that at vLass / VLamax ≈ 0.5 the fat fraction
  // has dropped to ~0.25; tunable.
  const glyc_flux = vLass(ADP, VLamax);                               // mmol/L/s
  const glyc_ratio = VLamax > 0 ? glyc_flux / VLamax : 0;             // ∈ [0,1]

  // Smooth crossover curve. Rest (x → 0) gives fat_fraction ≈ 0.55.
  // High glycolytic engagement collapses fat oxidation toward zero.
  const x_eff = Math.max(0, Math.min(1.0, x));
  const fat_fraction = Math.max(
    0,
    0.55 * (1 - x_eff)            // intensity-driven downshift
        * (1 - 0.85 * glyc_ratio) // glycolytic-suppression term
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
