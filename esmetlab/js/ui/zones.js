/*
 * Training-zone generators. Each takes an anchor pair (LT1, MLSS) and the
 * athlete's sport context, and returns an array of zone bands with
 * { zone, label, lo, hi } in the user's preferred display units.
 *
 * Schemes implemented:
 *   - Coggan 7-zone (cycling) — % FTP, anchored to MLSS as FTP proxy.
 *   - Seiler 3-zone (universal) — LT1 and MLSS as boundaries.
 *   - Friel 7-zone (universal) — % LTHR-style, anchored to MLSS.
 *
 * All bands are returned in the same intensity unit the user is working in
 * (watts for cycling, m/s for running) — UI layer formats for display.
 */

import { vO2ToIntensity } from '../lib/mader/sport.js';

/** Coggan 7-zone cycling, anchored to MLSS (Mader's MLSS ≈ Coggan's FTP). */
export function cogganZones(MLSS_W) {
  return [
    { zone: 1, label: 'Active Recovery',    lo: 0,                   hi: MLSS_W * 0.55 },
    { zone: 2, label: 'Endurance',          lo: MLSS_W * 0.56,       hi: MLSS_W * 0.75 },
    { zone: 3, label: 'Tempo',              lo: MLSS_W * 0.76,       hi: MLSS_W * 0.90 },
    { zone: 4, label: 'Lactate Threshold',  lo: MLSS_W * 0.91,       hi: MLSS_W * 1.05 },
    { zone: 5, label: 'VO₂max',             lo: MLSS_W * 1.06,       hi: MLSS_W * 1.20 },
    { zone: 6, label: 'Anaerobic Capacity', lo: MLSS_W * 1.21,       hi: MLSS_W * 1.50 },
    { zone: 7, label: 'Neuromuscular',      lo: MLSS_W * 1.51,       hi: Infinity      },
  ];
}

/** Seiler 3-zone, LT1 / MLSS anchored. Same shape for cycling and running. */
export function seilerZones(LT1, MLSS) {
  return [
    { zone: 1, label: 'Low (below LT1)',          lo: 0,    hi: LT1   },
    { zone: 2, label: 'Moderate (LT1 → MLSS)',    lo: LT1,  hi: MLSS  },
    { zone: 3, label: 'High (above MLSS)',        lo: MLSS, hi: Infinity },
  ];
}

/** Friel 7-zone for running (pace), anchored to MLSS pace. */
export function frielZonesRunning(MLSS_speed_m_per_s) {
  const v = MLSS_speed_m_per_s;
  return [
    { zone: 1, label: 'Recovery',                 lo: 0,         hi: v * 0.78 },
    { zone: 2, label: 'Aerobic',                  lo: v * 0.78,  hi: v * 0.88 },
    { zone: 3, label: 'Tempo',                    lo: v * 0.88,  hi: v * 0.95 },
    { zone: 4, label: 'Sub-threshold',            lo: v * 0.95,  hi: v * 1.00 },
    { zone: 5, label: 'Threshold',                lo: v * 1.00,  hi: v * 1.06 },
    { zone: 6, label: 'VO₂max',                   lo: v * 1.06,  hi: v * 1.15 },
    { zone: 7, label: 'Anaerobic',                lo: v * 1.15,  hi: Infinity },
  ];
}

/** Dispatcher that returns all zone schemes appropriate for the sport. */
export function generateZones(sport, anchors) {
  if (sport === 'cycling') {
    return {
      coggan: cogganZones(anchors.MLSS_intensity),
      seiler: seilerZones(anchors.LT1_intensity, anchors.MLSS_intensity),
    };
  }
  if (sport === 'running') {
    return {
      friel:  frielZonesRunning(anchors.MLSS_intensity),
      seiler: seilerZones(anchors.LT1_intensity, anchors.MLSS_intensity),
    };
  }
  return { seiler: seilerZones(anchors.LT1_intensity, anchors.MLSS_intensity) };
}
