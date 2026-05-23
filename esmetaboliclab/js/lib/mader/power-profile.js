/*
 * Power/Pace-only metabolic profile derivation.
 *
 * Takes max-effort intensities at four canonical durations (15 s, 3 min,
 * 6 min, 12 min) and derives the two physiological parameters the Mader
 * engine needs: VLamax and VO2max. These are then handed to the engine
 * exactly the same way as the lactate-anchored pipeline.
 *
 * ⚠ Be honest about what this is and isn't. The lactate-anchored path
 * measures VLamax directly via the (peak − baseline) / glycolytic-time
 * formula. The power-only path infers it from sprint power via an
 * empirical regression — it's calibrated to typical population ranges but
 * cannot capture an individual's true VLamax with the same precision. The
 * VO2max derivation is more defensible (sustained ~6-min max effort is
 * routinely used as a VO2max-equivalent power surrogate in the lab) but
 * still rests on assumed gross efficiency / running economy values.
 *
 * Suggested reading:
 *   - Hawley & Noakes 1992 (5-min Pmax as VO2max surrogate)
 *   - Monod & Scherrer 1965 (critical power model)
 *   - Pinot & Grappe 2011 (record power profile)
 *   - di Prampero 1986 (running energy cost)
 *   - Mader & Heck 1986 (the underlying lactate model)
 */

import { MADER } from './constants.js';
import { powerToVO2, speedToVO2 } from './sport.js';

/* ───────── VLamax regression ──────────────────────────────
 *
 * VLamax (mmol/L/s) scales roughly linearly with average 15-second
 * relative sprint power (cycling) or relative sprint speed (running).
 * The slope and intercept here are tuned to:
 *
 *   Cycling, average 15-s W/kg →  VLamax
 *      6 W/kg (untrained)      →  ~0.29
 *      8 W/kg (recreational)   →  ~0.37
 *     11 W/kg (trained)        →  ~0.49
 *     14 W/kg (well-trained)   →  ~0.61
 *     17 W/kg (sprinter)       →  ~0.73
 *     20 W/kg (elite sprinter) →  ~0.85
 *
 * Running, average 15-s speed (m/s) → VLamax
 *      6 m/s  (recreational)   →  ~0.33
 *      7 m/s  (trained)        →  ~0.43
 *      8 m/s  (well-trained)   →  ~0.53
 *      9 m/s  (sub-elite)      →  ~0.63
 *     10 m/s  (elite sprinter) →  ~0.73
 *
 * Female adjustment: 0.95×. Sex effect on VLamax is modest in the
 * literature; this captures the direction without overstating it.
 */

const VLAMAX_CYCLING = { slope_per_W_per_kg: 0.040, intercept: 0.050 };
const VLAMAX_RUNNING = { slope_per_m_per_s:  0.100, intercept: -0.260 };
const VLAMAX_SEX_MULT_FEMALE = 0.95;
const VLAMAX_BOUNDS = { lo: 0.20, hi: 1.00 };

function clampVLamax(v) {
  return Math.max(VLAMAX_BOUNDS.lo, Math.min(VLAMAX_BOUNDS.hi, v));
}

/**
 * Derive VLamax from average 15-second sprint effort.
 *
 * @param {Object} input
 * @param {string} input.sport      'cycling' | 'running'
 * @param {number} input.sprint15s  W (cycling) | m/s (running)
 * @param {number} input.bodyMass   kg
 * @param {string} input.sex        'M' | 'F'
 * @returns {{ VLamax: number, intensity_per_unit: number, warnings: string[] }}
 */
export function deriveVLamax({ sport, sprint15s, bodyMass, sex }) {
  const warnings = [];
  let raw;
  let intensity_per_unit;

  if (sport === 'cycling') {
    const w_per_kg = sprint15s / bodyMass;
    intensity_per_unit = w_per_kg;
    raw = VLAMAX_CYCLING.slope_per_W_per_kg * w_per_kg + VLAMAX_CYCLING.intercept;
    if (w_per_kg < 4)   warnings.push('Sprint power (' + w_per_kg.toFixed(1) + ' W/kg) is unusually low for a 15-second max effort. Was this a true all-out sprint?');
    if (w_per_kg > 24)  warnings.push('Sprint power (' + w_per_kg.toFixed(1) + ' W/kg) is above the elite-sprinter range; double-check the inputs.');
  } else if (sport === 'running') {
    intensity_per_unit = sprint15s;            // m/s — already "per body mass" in running terms
    raw = VLAMAX_RUNNING.slope_per_m_per_s * sprint15s + VLAMAX_RUNNING.intercept;
    if (sprint15s < 4) warnings.push('Sprint speed (' + sprint15s.toFixed(1) + ' m/s) is unusually low for a 15-second max effort.');
    if (sprint15s > 11) warnings.push('Sprint speed (' + sprint15s.toFixed(1) + ' m/s) is above the elite-sprinter range; double-check the inputs.');
  } else {
    throw new Error('Unsupported sport: ' + sport);
  }

  if (sex === 'F') raw *= VLAMAX_SEX_MULT_FEMALE;

  return { VLamax: clampVLamax(raw), intensity_per_unit, warnings };
}

/* ───────── VO2max derivation ──────────────────────────────
 *
 * 6-min max effort corresponds approximately to 105–108% of VO2max-
 * equivalent intensity for trained athletes (Hawley & Noakes 1992 family
 * of work). We use the 6-min value as the primary anchor and apply a
 * small downscale to land at VO2max proper.
 *
 *   VO2max ≈ 0.95 × VO2_demand_at_6min
 *
 * The 0.95 figure is a reasonable point estimate across trained athletes.
 * Highly anaerobic athletes (sprinters) may have a larger gap (use a
 * lower factor — they sustain less VO2 over 6 min); pure aerobic types a
 * smaller gap. We don't auto-adjust; instead we surface the implied
 * 3-min : 6-min : 12-min ratio so the user can see if the shape is
 * unusual.
 */

const VO2MAX_FACTOR = 0.95;

/**
 * Derive VO2max from 6-min max effort.
 *
 * @param {Object} input
 * @param {string} input.sport    'cycling' | 'running'
 * @param {number} input.peak6min W (cycling) | m/s (running)
 * @param {number} input.bodyMass kg
 * @param {number} [input.GE]     cycling gross efficiency (default 0.225)
 * @param {number} [input.Cr]     running energy cost (default 3.86)
 * @returns {{ VO2max: number, VO2_demand_at_6min: number }}
 */
export function deriveVO2max({ sport, peak6min, bodyMass, GE, Cr }) {
  let vo2_at_6min;
  if (sport === 'cycling') {
    vo2_at_6min = powerToVO2(peak6min, bodyMass, GE || MADER.cycling_GE_default);
  } else if (sport === 'running') {
    vo2_at_6min = speedToVO2(peak6min, Cr || MADER.Cr_default_J_per_kg_per_m);
  } else {
    throw new Error('Unsupported sport: ' + sport);
  }
  return {
    VO2max: VO2MAX_FACTOR * vo2_at_6min,
    VO2_demand_at_6min: vo2_at_6min,
  };
}

/* ───────── Full power-profile derivation ─────────────────── */

/**
 * Derive both VLamax and VO2max from the four-duration max-effort inputs.
 * Adds sanity warnings if the power-duration shape looks unusual.
 *
 * @param {Object} input
 * @param {string} input.sport         'cycling' | 'running'
 * @param {string} input.sex           'M' | 'F'
 * @param {number} input.bodyMass      kg
 * @param {Object} input.efforts       { sprint15s, peak3min, peak6min, peak12min }
 * @param {Object} [input.options]     { GE, Cr }
 * @returns {{
 *   VLamax: number, VO2max: number,
 *   diagnostics: {
 *     VLamax_sprint_intensity: number,  // W/kg (cycling) or m/s (running)
 *     VO2_demand_at_6min: number,       // mL/min/kg
 *     pd_ratios: { p3_over_p6: number, p12_over_p6: number },
 *     warnings: string[],
 *   }
 * }}
 */
export function derivePowerProfile(input) {
  const { sport, sex, bodyMass, efforts, options } = input;
  const GE = (options && options.GE) || MADER.cycling_GE_default;
  const Cr = (options && options.Cr) || MADER.Cr_default_J_per_kg_per_m;

  const vlx = deriveVLamax({
    sport, sprint15s: efforts.sprint15s, bodyMass, sex,
  });

  const vo2 = deriveVO2max({
    sport, peak6min: efforts.peak6min, bodyMass, GE, Cr,
  });

  // Power-duration shape sanity
  const warnings = [...vlx.warnings];
  const p3 = efforts.peak3min;
  const p6 = efforts.peak6min;
  const p12 = efforts.peak12min;
  const p3_over_p6  = p6 > 0 ? p3 / p6  : NaN;
  const p12_over_p6 = p6 > 0 ? p12 / p6 : NaN;

  if (isFinite(p3) && isFinite(p6) && p3 <= p6) {
    warnings.push('Your 3-minute max (' + p3 + ') is not greater than your 6-minute max (' + p6 + '). The 3-min should be ~5–15% higher than 6-min — check the values.');
  }
  if (isFinite(p12) && isFinite(p6) && p12 >= p6) {
    warnings.push('Your 12-minute max (' + p12 + ') is not lower than your 6-minute max (' + p6 + '). The 12-min should be ~3–10% lower — check the values.');
  }
  if (isFinite(p3_over_p6) && (p3_over_p6 < 1.03 || p3_over_p6 > 1.25)) {
    warnings.push('3-min : 6-min ratio of ' + p3_over_p6.toFixed(2) + ' is outside the typical 1.05–1.18 band. Either an effort wasn\'t maximal or the durations are off.');
  }
  if (isFinite(efforts.sprint15s) && isFinite(p3) && efforts.sprint15s <= p3 * 1.5) {
    if (sport === 'cycling') {
      warnings.push('Your 15-second sprint power isn\'t much higher than your 3-minute power. Real 15-s peaks are usually 1.8–3× your 3-min power.');
    }
  }

  return {
    VLamax: vlx.VLamax,
    VO2max: vo2.VO2max,
    diagnostics: {
      VLamax_sprint_intensity: vlx.intensity_per_unit,
      VO2_demand_at_6min: vo2.VO2_demand_at_6min,
      pd_ratios: { p3_over_p6, p12_over_p6 },
      warnings,
    },
  };
}
