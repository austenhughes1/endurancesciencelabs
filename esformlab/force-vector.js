// ─────────────────────────────────────────────────────────────────────────
//  FORCE-VECTOR (admin-only)  ·  Route A — leg-axis / COM-alignment proxy
//
//  Estimates the DIRECTION of the ground-reaction force (GRF) a runner applies
//  during stance, from the per-phase keypoints the standard esFormLab flow
//  already captures (phases[key].kps). No second upload, no magnitude claim.
//
//  Physics: in the spring-mass model of running the resultant GRF acts roughly
//  along the line from the foot contact point through the center of mass (COM),
//  so the force DIRECTION is recoverable from geometry alone. theta is the
//  signed angle of that line from vertical:
//      theta > 0  → force tilts forward  (propulsive)
//      theta < 0  → force tilts backward (braking)
//      theta = 0  → purely vertical support
//
//  Elite targets are derived from the live elite reference data: the elite
//  foot-offset distribution (getCombinedStats) maps directly to an elite theta
//  via theta = atan2(-footOffset, R), R = vertical leg-to-torso ratio. This
//  replaces the gimmick movement names with a physics-grounded "how close is
//  this runner's force direction to the elite column" score.
//
//  Globals it relies on (all defined by gait-data.js, loaded earlier):
//    MIN_CONF, getCombinedStats, MIN_N
//  COCO-17 indices: 0 nose · 5/6 shoulders · 7/8 elbows · 9/10 wrists ·
//                   11/12 hips · 13/14 knees · 15/16 ankles. y points DOWN.
// ─────────────────────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  var CONF = (typeof MIN_CONF !== 'undefined') ? MIN_CONF : 0.25;
  var MINN = (typeof MIN_N !== 'undefined') ? MIN_N : 5;

  // Nominal vertical (hip→ankle) distance as a multiple of torso length
  // (shoulder→hip vertical). Used only to convert the elite foot-offset ratio
  // into an elite theta. Documented anthropometric constant, tunable.
  var LEG_TORSO_RATIO = 1.6;

  // Winter segment mass fractions for a whole-body COM (renormalized over
  // visible segments; falls back to hip midpoint).
  var SEGMENTS = [
    { frac: 0.497, a: 'shMid', b: 'hipMid', r: 0.50 },
    { frac: 0.081, a: 'nose',  b: 'shMid',  r: 0.00 },
    { frac: 0.028, a: 5,  b: 7,  r: 0.436 }, { frac: 0.028, a: 6,  b: 8,  r: 0.436 },
    { frac: 0.022, a: 7,  b: 9,  r: 0.50 },  { frac: 0.022, a: 8,  b: 10, r: 0.50 },
    { frac: 0.100, a: 11, b: 13, r: 0.433 }, { frac: 0.100, a: 12, b: 14, r: 0.433 },
    { frac: 0.061, a: 13, b: 15, r: 0.50 },  { frac: 0.061, a: 14, b: 16, r: 0.50 }
  ];

  // Hand-set fallbacks, used only when elite data for a phase isn't reliable.
  var PHASE_FALLBACK = {
    l_foot: { ideal: 0,  sigma: 8,  bias: 'brake',  label: 'L foot strike' },
    r_foot: { ideal: 0,  sigma: 8,  bias: 'brake',  label: 'R foot strike' },
    mid:    { ideal: 0,  sigma: 6,  bias: 'either', label: 'Mid-stance' },
    l_toe:  { ideal: 18, sigma: 10, bias: 'propel', label: 'L toe-off' },
    r_toe:  { ideal: 18, sigma: 10, bias: 'propel', label: 'R toe-off' }
  };
  // Which foot-offset metric corresponds to the stance/landing foot per phase.
  var PHASE_FOOT_METRIC = { l_foot: 'lFoot', r_foot: 'rFoot', l_toe: 'lFoot', r_toe: 'rFoot' };

  function kp(kps, i) { return (kps && kps[i] && kps[i].score >= CONF) ? kps[i] : null; }
  function mid(a, b) { return (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }
  function deg(r) { return r * 180 / Math.PI; }

  function computeCOM(kps, method) {
    var hipMid = mid(kp(kps, 11), kp(kps, 12));
    var shMid  = mid(kp(kps, 5),  kp(kps, 6));
    if (method !== 'segmental' || !hipMid || !shMid) return hipMid;
    var named = { shMid: shMid, hipMid: hipMid, nose: kp(kps, 0) || shMid };
    var sx = 0, sy = 0, sw = 0;
    for (var i = 0; i < SEGMENTS.length; i++) {
      var s = SEGMENTS[i];
      var pa = (typeof s.a === 'string') ? named[s.a] : kp(kps, s.a);
      var pb = (typeof s.b === 'string') ? named[s.b] : kp(kps, s.b);
      if (!pa || !pb) continue;
      sx += (pa.x + (pb.x - pa.x) * s.r) * s.frac;
      sy += (pa.y + (pb.y - pa.y) * s.r) * s.frac;
      sw += s.frac;
    }
    return (sw < 0.4) ? hipMid : { x: sx / sw, y: sy / sw };
  }

  function stanceAnkle(kps, phaseKey, side) {
    var lAn = kp(kps, 15), rAn = kp(kps, 16);
    var s = side || (/^l_/.test(phaseKey || '') ? 'left' : /^r_/.test(phaseKey || '') ? 'right' : null);
    if (s === 'left')  return lAn;
    if (s === 'right') return rAn;
    if (lAn && rAn)    return (lAn.y >= rAn.y) ? lAn : rAn; // lower ankle = stance
    return lAn || rAn;
  }
  function matchHip(kps, ankle) {
    return (ankle && ankle === kp(kps, 15)) ? kp(kps, 11) : kp(kps, 12);
  }
  function angleFromVertical(fwd, up) { return deg(Math.atan2(fwd, up)); }

  // ── Elite target for a phase, derived from live elite foot-offset stats ──
  // Returns { ideal, sigma, bias, source:'live'|'default', n }.
  function eliteTarget(phaseKey) {
    var fb = PHASE_FALLBACK[phaseKey] || PHASE_FALLBACK.mid;
    var metric = PHASE_FOOT_METRIC[phaseKey];
    if (metric && typeof getCombinedStats === 'function') {
      var st = null;
      try { st = getCombinedStats(phaseKey, metric); } catch (e) { st = null; }
      if (st && st.source === 'live' && st.n >= MINN && st.sd > 0) {
        var R = LEG_TORSO_RATIO;
        var idealDeg = angleFromVertical(-st.mean, R);
        // Propagate foot-offset sd through theta = atan2(-fo, R):
        // dtheta/dfo = -R / (R^2 + fo^2).
        var slope = R / (R * R + st.mean * st.mean);
        var sigmaDeg = Math.max(3, deg(slope * st.sd));
        return { ideal: idealDeg, sigma: sigmaDeg, bias: fb.bias, source: 'live', n: st.n };
      }
    }
    return { ideal: fb.ideal, sigma: fb.sigma, bias: fb.bias, source: 'default', n: 0 };
  }

  function classify(theta, bias) {
    if (bias === 'propel') {
      if (theta < 5)  return 'Under-propulsive (force too vertical at push-off)';
      if (theta > 32) return 'Over-reaching (force tilted excessively forward)';
      return 'Propulsive (force well-oriented for forward drive)';
    }
    if (bias === 'brake') {
      if (theta < -12) return 'Strong braking (contact well ahead of COM — overstriding)';
      if (theta < -4)  return 'Mild braking (contact slightly ahead of COM)';
      if (theta > 6)   return 'Already propelling at contact (check frame/phase)';
      return 'Vertically aligned (minimal braking at contact)';
    }
    if (theta < -6) return 'COM behind base (sitting / drifting back)';
    if (theta > 6)  return 'COM ahead of base (falling forward)';
    return 'Balanced over base (force near vertical)';
  }

  function scoreVs(theta, target) {
    var z = (theta - target.ideal) / (target.sigma || 6);
    return Math.round(100 * Math.exp(-0.5 * z * z));
  }

  // estimate(kps, { phaseKey, side, comMethod }) → full per-phase result.
  function estimate(kps, opts) {
    opts = opts || {};
    var phaseKey = opts.phaseKey || 'mid';
    var comMethod = opts.comMethod || 'segmental';

    var nose = kp(kps, 0), hipMid = mid(kp(kps, 11), kp(kps, 12));
    if (!hipMid) return { ok: false, phaseKey: phaseKey, reason: 'Hips not detected.' };
    var com = computeCOM(kps, comMethod);
    var contact = stanceAnkle(kps, phaseKey, opts.side);
    if (!com || !contact) return { ok: false, phaseKey: phaseKey, reason: 'Missing COM or stance ankle.' };

    var dir = (nose && nose.x > hipMid.x) ? 1 : -1;
    var theta = angleFromVertical((com.x - contact.x) * dir, (contact.y - com.y));

    var hip = matchHip(kps, contact), legAxisTheta = null, comDivergence = null;
    if (hip) {
      legAxisTheta = angleFromVertical((hip.x - contact.x) * dir, (contact.y - hip.y));
      comDivergence = Math.abs(theta - legAxisTheta);
    }

    var target = eliteTarget(phaseKey);
    return {
      ok: true, phaseKey: phaseKey, theta: theta,
      target: target, score: scoreVs(theta, target),
      classification: classify(theta, target.bias),
      dir: dir, com: com, contact: contact, hip: hip || null,
      legAxisTheta: legAxisTheta, comDivergence: comDivergence, comMethod: comMethod
    };
  }

  global.ForceVector = {
    LEG_TORSO_RATIO: LEG_TORSO_RATIO,
    PHASE_FALLBACK: PHASE_FALLBACK,
    computeCOM: computeCOM,
    eliteTarget: eliteTarget,
    classify: classify,
    estimate: estimate
  };
})(typeof window !== 'undefined' ? window : this);
