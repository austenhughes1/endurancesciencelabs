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

  // Running: energy cost of horizontal running (di Prampero 1986)
  // Range 3.5 (elite) – 4.2 (untrained) J/kg/m. Default mid-range.
  Cr_default_J_per_kg_per_m: 3.86,

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

// Population-sanity ranges (warnings only — not validation failures).
// Outside these, surface a "check inputs" warning in the report.
export const SANITY_RANGES = {
  VO2max:   { lo: 25,   hi: 95   },  // mL/min/kg
  VLamax:   { lo: 0.15, hi: 1.0  },  // mmol/L/s
  MLSS_pct_VO2max: { lo: 0.35, hi: 0.90 },  // ratio MLSS-VO2 / VO2max
};
