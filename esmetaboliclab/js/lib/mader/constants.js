/*
 * Mader/Heck bioenergetic model — canonical constants.
 *
 * Sources:
 *   Mader & Heck 1986, Int J Sports Med 7 Suppl 1:45–65
 *   Mader 2003, Eur J Appl Physiol 88:317–338
 *   Wackerhage et al. 2022, Front Physiol 13:899670 (English summary)
 *   Péronnet & Massicotte 1991, Can J Sport Sci 16(1):23–29 (substrate stoichiometry)
 *
 * Single source of truth — every other module imports from here.
 */

export const MADER = {
  // Hill kinetics — oxidative phosphorylation (mitochondrial)
  K1: 0.035,   // mmol/kg, half-activation [ADP] for oxidation
  n1: 2,       // Hill coefficient, second-order regulation of ox. phos.

  // Hill kinetics — glycolysis (PFK-limited)
  K2: 1.2,     // mmol/kg, half-activation [ADP] for glycolysis
  n2: 3,       // Hill coefficient, third-order PFK regulation

  // Alactic phosphagen contribution time for VLamax sprint calculation
  // (Mader 1994; supported by Quittmann et al. 2018, 2020)
  tPCr_default: 3.5,                // seconds

  // Active muscle fraction of body mass (cycling/running)
  // Mader uses ~28% as the standard active muscle pool
  activeMuscleFraction_default: 0.28,

  // Energy density of oxygen at STPD (heat of combustion equivalent)
  O2_energy_density_J_per_mL: 20.9, // J per mL O2 consumed

  // Substrate stoichiometry (Péronnet & Massicotte 1991)
  // Volume of O2 consumed per gram of substrate fully oxidized
  fat_O2_L_per_g: 2.02,   // L O2 per g fat
  cho_O2_L_per_g: 0.83,   // L O2 per g CHO (glycogen/glucose mixed)

  // Lactate ↔ oxygen stoichiometry
  // Full oxidation: 1 lactate → 3 O2 (lactate + 3 O2 → 3 CO2 + 3 H2O)
  // i.e. eliminating 1 mmol lactate via oxidation costs 3 mmol O2.
  // For converting mass-action lactate elimination to O2-equivalent flux.
  O2_per_lactate_mmol_per_mmol: 3.0,

  // Cycling: gross mechanical efficiency
  cycling_GE_default: 0.225,        // fraction (22.5%)

  // Running: energy cost of horizontal running.
  //
  // di Prampero 1986 reports Cr ≈ 3.86 J/kg/m at sustained moderate paces.
  // The Léger 1980/84 MAS→VO2max regression (used in the power-profile
  // forward VO2max derivation) has an implicit Cr ≈ 4.39 — higher because
  // at max effort, anaerobic + neuromuscular overhead inflates the
  // effective per-metre cost (12.6 × v_m/s × 20.9 / 60 = 4.39).
  //
  // 4.20 is the population-average default used for engine speed ↔ VO2
  // conversions. Splits the gap between submaximal (3.86) and max-effort
  // (4.39) Cr values. Per-athlete Cr varies 3.6 (elite-efficient) to 4.6
  // (recreational); any single global value is unavoidably a compromise.
  Cr_default_J_per_kg_per_m: 4.20,

  // Baseline (resting) blood lactate, used as floor for the simulated curve
  La_baseline_mmol_per_L: 1.0,

  // LT1 definition: intensity at which blood lactate first rises a fixed delta
  // above baseline. Mader's original definition is ~+0.5 mmol/L over baseline.
  LT1_delta_mmol_per_L: 0.5,

  // Solver bounds for [ADP] (mmol/kg). Physiologic range covers rest to maximal.
  ADP_min: 1e-4,
  ADP_max: 5.0,

  // Solver bounds for VO2max fit (mL/min/kg)
  VO2max_fit_min: 20,
  VO2max_fit_max: 95,
};

/**
 * Altitude performance decrement, anchored to literature:
 *   - VO₂max drops ~6–7% per 1,000 m above 1,500 m (Faulkner 1968, Wagner 2000)
 *   - Performance-time loss scales with effort intensity
 *     (Daniels & Gilbert 1979 altitude conversion tables):
 *       Mile / VO₂max effort  → 4–5% loss at 1,500–2,000 m
 *       Marathon-pace effort  → 2–3% loss at 1,500–2,000 m
 *       Easy / recovery       → ~1% loss
 *
 * We model the loss as separable: a linear-in-altitude component above an
 * 800 m threshold (where effects begin), scaled by an intensity factor
 * keyed to relative intensity x = (effort intensity) / (MLSS or VO₂max-
 * equivalent).
 */
export const ALTITUDE = {
  threshold_m: 800,            // altitude below which there's no penalty
  base_per_100m: 0.006,        // 0.6% per 100 m above threshold at hard effort
                               // (matches Faulkner 1968 + Daniels 1979 VO₂max tables)
  // Intensity factor scales quadratically with effort: floor at 0.10 (recovery),
  // hits 1.0 at x = 1.15 (Z7 floor). The quadratic shape was tuned against
  // Daniels' altitude conversion tables and field data at 1650 m:
  //   x=0.78 (recovery)         → ~1.0%
  //   x=0.95 (marathon pace)    → ~2.1%
  //   x=1.00 (MLSS)             → ~2.6%
  //   x=1.15 (VO₂max / Z7 floor) → ~5.1%
  intensity_min: 0.10,
  intensity_x_floor: 0.55,
  intensity_x_ceil:  1.15,
};

/**
 * Altitude factor for a given testing altitude and relative effort intensity.
 * Returns a number in (0, 1] — multiply sea-level speed by this to get
 * altitude-equivalent speed, or divide altitude speed by this to recover
 * sea-level speed.
 *
 * @param {number} alt_m   Altitude above sea level in meters
 * @param {number} x_rel   Relative effort intensity (1.0 ≈ MLSS, ~0.78 = recovery)
 */
export function altitudeFactor(alt_m, x_rel) {
  if (!isFinite(alt_m) || alt_m <= ALTITUDE.threshold_m) return 1.0;
  const altBase = ALTITUDE.base_per_100m * (alt_m - ALTITUDE.threshold_m) / 100;
  // Quadratic intensity factor — floor at intensity_min, 1.0 at intensity_x_ceil
  let intFactor;
  if (x_rel <= ALTITUDE.intensity_x_floor)       intFactor = ALTITUDE.intensity_min;
  else if (x_rel >= ALTITUDE.intensity_x_ceil)   intFactor = 1.0;
  else {
    const span = ALTITUDE.intensity_x_ceil - ALTITUDE.intensity_x_floor;
    const t = (x_rel - ALTITUDE.intensity_x_floor) / span;
    intFactor = ALTITUDE.intensity_min + (1.0 - ALTITUDE.intensity_min) * t * t;
  }
  const penalty = altBase * intFactor;
  return Math.max(0.7, 1 - penalty);
}

// Population-sanity ranges (warnings only — not validation failures).
// Outside these, surface a "check inputs" warning in the report.
export const SANITY_RANGES = {
  VO2max:   { lo: 25,   hi: 95   },  // mL/min/kg
  VLamax:   { lo: 0.10, hi: 2.0  },  // mmol/L/s — covers pure endurance (~0.15) through elite sprinter (~1.5–1.8)
  MLSS_pct_VO2max: { lo: 0.35, hi: 0.90 },  // ratio MLSS-VO2 / VO2max
};
