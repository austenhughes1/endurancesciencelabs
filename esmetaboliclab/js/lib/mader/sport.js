/*
 * Sport-specific conversions between external work and metabolic demand.
 *
 *   Cycling:  power (W) → VO2 demand (mL/min/kg) via gross efficiency
 *   Running:  speed (m/s) → VO2 demand (mL/min/kg) via energy cost (di Prampero)
 *
 * Both directions (forward and inverse) are exposed so the engine can use
 * VO2 demand internally and translate back to the user's chosen units for
 * presentation.
 */

import { MADER } from './constants.js';

/* ───────────── Cycling ───────────── */

/**
 * Cycling: external power in watts → metabolic VO2 demand in mL/min/kg.
 *
 *   ATP_energy_rate (J/s = W)   = P / GE
 *   VO2 (mL/min)                = (P / GE) × 60 s/min / 20.9 J/mL
 *   VO2/kg                      = above / bodyMass_kg
 *
 * GE = gross mechanical efficiency, default 22.5% (range 21–24% in trained).
 */
export function powerToVO2(P_watts, bodyMass_kg, GE = MADER.cycling_GE_default) {
  if (P_watts <= 0 || bodyMass_kg <= 0) return 0;
  const metabolic_W = P_watts / GE;
  const VO2_mL_per_min = metabolic_W * 60 / MADER.O2_energy_density_J_per_mL;
  return VO2_mL_per_min / bodyMass_kg;
}

/** Inverse of powerToVO2 — used after the engine solves for an intensity. */
export function vO2ToPower(VO2_mL_per_min_per_kg, bodyMass_kg, GE = MADER.cycling_GE_default) {
  const VO2_mL_per_min = VO2_mL_per_min_per_kg * bodyMass_kg;
  const metabolic_W = VO2_mL_per_min * MADER.O2_energy_density_J_per_mL / 60;
  return metabolic_W * GE;
}

/* ───────────── Running ───────────── */

/**
 * Running: speed in m/s → metabolic VO2 demand in mL/min/kg.
 *
 *   Energy cost (di Prampero 1986): Cr [J/kg/m] × speed [m/s] = J/kg/s (= W/kg)
 *   VO2 (mL/kg/min)                = Cr × v × 60 / 20.9
 *
 * Cr = horizontal-running energy cost, default 3.86 J/kg/m (range 3.5 elite – 4.2 untrained).
 */
export function speedToVO2(v_m_per_s, Cr = MADER.Cr_default_J_per_kg_per_m) {
  if (v_m_per_s <= 0) return 0;
  return Cr * v_m_per_s * 60 / MADER.O2_energy_density_J_per_mL;
}

/** Inverse — VO2 demand back to running speed in m/s. */
export function vO2ToSpeed(VO2_mL_per_min_per_kg, Cr = MADER.Cr_default_J_per_kg_per_m) {
  return VO2_mL_per_min_per_kg * MADER.O2_energy_density_J_per_mL / (Cr * 60);
}

/* ───────────── Unit conversions for UI ───────────── */

/** m/s ↔ pace (min/km) */
export function speedToPace_min_per_km(v_m_per_s) {
  if (v_m_per_s <= 0) return Infinity;
  const sec_per_km = 1000 / v_m_per_s;
  return sec_per_km / 60;
}
export function pace_min_per_km_to_speed(pace_min_per_km) {
  if (pace_min_per_km <= 0) return Infinity;
  return 1000 / (pace_min_per_km * 60);
}

/** "4:15" pace string ↔ min/km number */
export function paceStringToMinPerKm(s) {
  if (!s) return NaN;
  const m = String(s).trim().match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) {
    const f = parseFloat(s);
    return isFinite(f) ? f : NaN;
  }
  return parseInt(m[1], 10) + parseFloat(m[2]) / 60;
}
export function minPerKmToPaceString(p) {
  if (!isFinite(p) || p <= 0) return '—';
  const min = Math.floor(p);
  const sec = Math.round((p - min) * 60);
  if (sec === 60) return (min + 1) + ':00';
  return min + ':' + (sec < 10 ? '0' : '') + sec;
}

/** m/s → minutes per mile */
const METERS_PER_MILE = 1609.344;
export function speedToPace_min_per_mile(v_m_per_s) {
  if (v_m_per_s <= 0) return Infinity;
  return METERS_PER_MILE / v_m_per_s / 60;
}

/**
 * Format a speed in m/s as "m:ss/mi · m:ss/km" — both units side by side.
 */
export function speedToPaceDualString(v_m_per_s) {
  if (!isFinite(v_m_per_s) || v_m_per_s <= 0) return '—';
  const mi = minPerKmToPaceString(speedToPace_min_per_mile(v_m_per_s));
  const km = minPerKmToPaceString(speedToPace_min_per_km(v_m_per_s));
  return mi + '/mi · ' + km + '/km';
}

/**
 * Format a speed in m/s in a single unit ('mi' or 'km').
 */
export function speedToPaceString(v_m_per_s, unit) {
  if (!isFinite(v_m_per_s) || v_m_per_s <= 0) return '—';
  if (unit === 'km') return minPerKmToPaceString(speedToPace_min_per_km(v_m_per_s)) + '/km';
  return minPerKmToPaceString(speedToPace_min_per_mile(v_m_per_s)) + '/mi';
}

/**
 * Forward dispatcher: given a stage's recorded intensity (in the user's chosen
 * unit), return VO2 demand in mL/min/kg.
 *
 * @param {string} sport     'cycling' | 'running'
 * @param {number} intensity W (cycling) | m/s (running)
 * @param {Object} ctx       { bodyMass, GE, Cr }
 */
export function intensityToVO2(sport, intensity, ctx) {
  if (sport === 'cycling') return powerToVO2(intensity, ctx.bodyMass, ctx.GE);
  if (sport === 'running') return speedToVO2(intensity, ctx.Cr);
  throw new Error('Unsupported sport: ' + sport);
}

export function vO2ToIntensity(sport, vo2, ctx) {
  if (sport === 'cycling') return vO2ToPower(vo2, ctx.bodyMass, ctx.GE);
  if (sport === 'running') return vO2ToSpeed(vo2, ctx.Cr);
  throw new Error('Unsupported sport: ' + sport);
}
