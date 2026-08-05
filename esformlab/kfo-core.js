// ─────────────────────────────────────────────────────────────────────────────
//  KINEMATIC FORCE-ORIENTATION (KFO) — core domain module
//
//  Estimates the ORIENTATION of a runner's support line from side-view pose
//  geometry. This is NOT a ground-reaction-force measurement. See
//  docs/kinematic-force-orientation.md.
//
//  ANGLE CONVENTION (single source of truth for the whole feature)
//  ---------------------------------------------------------------
//  Symbol            : theta ("estimated support-line angle")
//  Units             : degrees
//  Reference axis    : true vertical (gravity), image-space +y is DOWN
//  Sign              : NEGATIVE = braking orientation  (support point ahead of
//                                 the COM along the direction of travel)
//                      POSITIVE = propulsive orientation (support point behind
//                                 the COM along the direction of travel)
//                      ZERO     = vertically aligned support
//  Direction-invariant: sign is normalised by inferred running direction, so a
//                      right-to-left or mirrored clip yields the same sign for
//                      the same mechanics.
//
//  SCIENTIFIC SCOPE. The spring-mass approximation says stance GRF acts roughly
//  along the line from the support point through the COM, so this geometry may
//  correlate with GRF direction. It is not equivalent: true GRF also depends on
//  COM acceleration, centre-of-pressure migration, segmental angular dynamics
//  and force magnitude. Magnitude is not estimated here at all.
//
//  A NOTE ON WHAT IS *NOT* SCORED. Late-stance geometry closer to vertical is
//  deliberately NOT treated as a deficiency. In the point-mass relation used by
//  Dorn et al. (L = v_x * I_v,eff / (m*g)), modelled stride length is monotonic
//  in effective VERTICAL impulse (dL/dI = v_x/(g*m) > 0) and contains no
//  vertical-to-horizontal force ratio. The familiar 45-degree optimum only
//  appears once a fixed-launch-speed constraint is added, which steady-state
//  running does not satisfy — a runner enters stance with horizontal velocity
//  already established. Larger fore-aft excursion is therefore reported as
//  greater braking + re-propulsion demand, never as "better drive".
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KFO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 2;
  var MODEL_VERSION = 'kinematic-force-orientation-v2.0.0';
  var ANALYSIS_TYPE = 'kinematic_force_orientation';

  // ── Enums ──────────────────────────────────────────────────────────────────

  /** How a result was produced. Only `validated_grf` may be called a measurement. */
  var METHOD = Object.freeze({
    GEOMETRY_PROXY: 'geometry_proxy',
    COM_ACCELERATION_EXPERIMENTAL: 'com_acceleration_experimental',
    LEARNED_GRF_EXPERIMENTAL: 'learned_grf_experimental',
    VALIDATED_GRF: 'validated_grf'
  });

  var METHOD_IS_VALIDATED = Object.freeze({
    geometry_proxy: false,
    com_acceleration_experimental: false,
    learned_grf_experimental: false,
    validated_grf: true
  });

  /**
   * Stance analysis phases. Deliberately NOT foot-strike / toe-off: force
   * magnitude approaches zero at those instants, so orientation there is both
   * ill-conditioned and mechanically uninformative.
   *
   * The central window brackets ~48% of stance, where Munro et al. (1987)
   * observed the fore-aft force zero crossing — i.e. the instant the resultant
   * is closest to purely vertical support.
   */
  var PHASE = Object.freeze({
    EARLY_STANCE: 'early_stance',
    CENTRAL_STANCE: 'central_stance',
    LATE_STANCE: 'late_stance'
  });

  var PHASE_WINDOWS = Object.freeze({
    early_stance: Object.freeze({
      key: 'early_stance', label: 'Early stance',
      minPercent: 10, maxPercent: 15, targetPercent: 12.5,
      intent: 'Braking-oriented geometry, after meaningful force has developed.'
    }),
    central_stance: Object.freeze({
      key: 'central_stance', label: 'Central stance',
      minPercent: 45, maxPercent: 55, targetPercent: 50,
      intent: 'Vertical support alignment near the fore-aft force zero crossing.'
    }),
    late_stance: Object.freeze({
      key: 'late_stance', label: 'Late stance',
      minPercent: 85, maxPercent: 90, targetPercent: 87.5,
      intent: 'Propulsive-oriented geometry before force falls close to zero.'
    })
  });
  var PHASE_ORDER = Object.freeze([PHASE.EARLY_STANCE, PHASE.CENTRAL_STANCE, PHASE.LATE_STANCE]);

  /** Event-selection strategies. Kinetic strategies become available only with a validated estimator. */
  var EVENT_SELECTION = Object.freeze({
    NORMALIZED_STANCE_WINDOW: 'normalized_stance_window',
    PEAK_BRAKING_FORCE: 'peak_braking_force',
    PEAK_VERTICAL_FORCE: 'peak_vertical_force',
    AP_FORCE_ZERO_CROSSING: 'ap_force_zero_crossing',
    PEAK_PROPULSIVE_FORCE: 'peak_propulsive_force'
  });

  var QUALITY_FLAG = Object.freeze({
    LOW_FRAME_RATE: 'low_frame_rate',
    SPARSE_STANCE_SAMPLING: 'sparse_stance_sampling',
    CAMERA_NOT_PERPENDICULAR: 'camera_not_perpendicular',
    EXCESSIVE_PERSPECTIVE: 'excessive_perspective',
    LANDMARK_OCCLUSION: 'landmark_occlusion',
    LOW_POSE_CONFIDENCE: 'low_pose_confidence',
    UNCERTAIN_CONTACT_FRAME: 'uncertain_contact_frame',
    INSUFFICIENT_STRIDES: 'insufficient_strides',
    SPEED_UNKNOWN: 'speed_unknown',
    ACCELERATION_DETECTED: 'acceleration_detected',
    GRADE_UNKNOWN: 'grade_unknown',
    MIRRORED_VIDEO: 'mirrored_video',
    UNSTABLE_RUNNING_DIRECTION: 'unstable_running_direction',
    HIGH_STRIDE_VARIABILITY: 'high_stride_variability'
  });

  var FLAG_LABEL = Object.freeze({
    low_frame_rate: 'Low effective frame rate',
    sparse_stance_sampling: 'Few samples inside stance — window angles interpolated',
    camera_not_perpendicular: 'Camera may not be perpendicular to the runner',
    excessive_perspective: 'Strong perspective distortion',
    landmark_occlusion: 'Some joints were occluded',
    low_pose_confidence: 'Low pose-detection confidence',
    uncertain_contact_frame: 'Contact frame uncertain',
    insufficient_strides: 'Too few clean strides for a stable estimate',
    speed_unknown: 'Running speed unavailable',
    acceleration_detected: 'Runner may not be at steady speed',
    grade_unknown: 'Grade unavailable',
    mirrored_video: 'Video may be mirrored',
    unstable_running_direction: 'Direction of travel was inconsistent',
    high_stride_variability: 'High stride-to-stride variability'
  });

  var PROVENANCE = Object.freeze({
    MEASURED: 'measured',
    KINEMATIC_ESTIMATE: 'kinematic_estimate',
    DERIVED: 'derived',
    EXPERIMENTAL: 'experimental',
    UNAVAILABLE: 'unavailable'
  });

  var VALIDATION_STATUS = Object.freeze({
    KINEMATIC_ONLY: 'kinematic_only',
    DERIVED_KINEMATIC: 'derived_kinematic',
    FORCE_PLATE_VALIDATED: 'force_plate_validated',
    UNVALIDATED: 'unvalidated'
  });

  var RUNNING_DIRECTION = Object.freeze({
    LEFT_TO_RIGHT: 'left_to_right',
    RIGHT_TO_LEFT: 'right_to_left',
    UNKNOWN: 'unknown'
  });

  var AVAILABILITY = Object.freeze({
    AVAILABLE: 'available',
    UNAVAILABLE: 'unavailable',
    INSUFFICIENT_QUALITY: 'insufficient_quality'
  });

  var GEOMETRY_LIMITATIONS = Object.freeze([
    'Video-derived kinematic estimate',
    'Not a direct ground-reaction-force measurement',
    'Does not estimate force magnitude',
    'Two-dimensional sagittal geometry only'
  ]);

  // ── JSDoc types ────────────────────────────────────────────────────────────

  /**
   * @typedef {Object} Keypoint
   * @property {number} x  image-space x, pixels
   * @property {number} y  image-space y, pixels (increases DOWNWARD)
   * @property {number} score  detector confidence, 0..1
   */

  /**
   * An angle carried together with everything needed to interpret it. Raw
   * numbers are never passed between modules.
   * @typedef {Object} AngleMeasure
   * @property {number} value  degrees
   * @property {'degrees'} units
   * @property {'vertical'} referenceAxis
   * @property {'negative_braking_positive_propulsive'} signConvention
   * @property {string} phase
   * @property {'left'|'right'|null} side
   * @property {string} method  one of METHOD
   * @property {string} provenance  one of PROVENANCE
   * @property {number|null} uncertaintyDegrees
   */

  /**
   * @typedef {Object} SupportLineInput
   * @property {Keypoint[]} keypoints  COCO-17
   * @property {string} phase  one of PHASE
   * @property {'left'|'right'} side
   * @property {number} directionSign  +1 travelling toward +x, -1 toward -x
   * @property {string} [comMethod]  'segmental' | 'hip'
   */

  // ── Small numeric helpers ─────────────────────────────────────────────────

  var DEG = 180 / Math.PI;
  function toDeg(r) { return r * DEG; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function median(arr) {
    var v = arr.filter(isNum).slice().sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function quantile(sorted, p) {
    if (!sorted.length) return null;
    var i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // Two-sided 95% t multipliers by degrees of freedom (n-1). Honest small-sample
  // intervals instead of always using 1.96.
  var T95 = { 1: 12.71, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
              8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160,
              14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
              20: 2.086, 25: 2.060, 30: 2.042 };
  function tMultiplier(n) {
    if (n < 2) return null;
    var df = n - 1;
    if (T95[df]) return T95[df];
    if (df > 30) return 1.96;
    var keys = Object.keys(T95).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) if (keys[i] >= df) return T95[keys[i]];
    return 1.96;
  }

  // ── COM estimation ─────────────────────────────────────────────────────────
  // Winter segment mass fractions, renormalised over visible segments. Head uses
  // the nose as its proxy because COCO-17 has no cranial-vertex landmark.
  var MIN_CONF = 0.25;
  var SEGMENTS = Object.freeze([
    { frac: 0.497, a: 'shMid', b: 'hipMid', r: 0.50 },
    { frac: 0.081, a: 'nose', b: 'shMid', r: 0.00 },
    { frac: 0.028, a: 5, b: 7, r: 0.436 }, { frac: 0.028, a: 6, b: 8, r: 0.436 },
    { frac: 0.022, a: 7, b: 9, r: 0.50 }, { frac: 0.022, a: 8, b: 10, r: 0.50 },
    { frac: 0.100, a: 11, b: 13, r: 0.433 }, { frac: 0.100, a: 12, b: 14, r: 0.433 },
    { frac: 0.061, a: 13, b: 15, r: 0.50 }, { frac: 0.061, a: 14, b: 16, r: 0.50 }
  ]);

  function kp(kps, i, minConf) {
    var c = minConf == null ? MIN_CONF : minConf;
    return (kps && kps[i] && isNum(kps[i].x) && isNum(kps[i].y) && (kps[i].score || 0) >= c) ? kps[i] : null;
  }
  function midpoint(a, b) { return (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }

  /**
   * Whole-body COM in image space.
   * @returns {{x:number,y:number,method:string,massCoverage:number}|null}
   */
  function computeCOM(kps, method) {
    var hipMid = midpoint(kp(kps, 11), kp(kps, 12));
    var shMid = midpoint(kp(kps, 5), kp(kps, 6));
    if (method === 'hip' || !hipMid || !shMid) {
      return hipMid ? { x: hipMid.x, y: hipMid.y, method: 'hip', massCoverage: 0 } : null;
    }
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
    if (sw < 0.4) return { x: hipMid.x, y: hipMid.y, method: 'hip_fallback', massCoverage: sw };
    return { x: sx / sw, y: sy / sw, method: 'segmental', massCoverage: sw };
  }

  // ── Support point ──────────────────────────────────────────────────────────
  // COCO-17 has no heel, toe, or foot landmark, so the support point is
  // ANKLE-ANCHORED with a modelled longitudinal offset that walks the estimated
  // contact region posterior → central → anterior across stance. Offsets are
  // fractions of shank length applied along the direction of travel.
  //
  // THIS IS NOT CENTRE OF PRESSURE. It is an estimated support point, and it is
  // labelled as such everywhere it surfaces.
  var SUPPORT_POINT_MODEL = Object.freeze({
    anchor: 'ankle',
    offsetUnit: 'shank_length_fraction',
    isCentreOfPressure: false,
    offsets: Object.freeze({ early_stance: -0.06, central_stance: 0.04, late_stance: 0.18 }),
    note: 'Ankle-anchored estimate; COCO-17 provides no foot landmark.'
  });

  function shankLength(kps, side) {
    var knee = kp(kps, side === 'left' ? 13 : 14);
    var ankle = kp(kps, side === 'left' ? 15 : 16);
    if (!knee || !ankle) return null;
    var d = Math.hypot(ankle.x - knee.x, ankle.y - knee.y);
    return d > 1 ? d : null;
  }

  /**
   * Estimated support point for a phase.
   * @returns {{x:number,y:number,anchor:string,offsetApplied:number,isCentreOfPressure:boolean}|null}
   */
  function estimateSupportPoint(kps, side, phase, directionSign) {
    var ankle = kp(kps, side === 'left' ? 15 : 16);
    if (!ankle) return null;
    var frac = SUPPORT_POINT_MODEL.offsets[phase];
    var len = shankLength(kps, side);
    var dx = (frac != null && len != null && isNum(directionSign)) ? frac * len * directionSign : 0;
    return {
      x: ankle.x + dx, y: ankle.y,
      anchor: 'ankle', offsetApplied: dx,
      isCentreOfPressure: false
    };
  }

  // ── Running direction ─────────────────────────────────────────────────────
  /**
   * Infer travel direction from hip-midpoint displacement, falling back to body
   * facing when there is little translation (treadmill running, or a panning
   * camera that tracks the runner).
   *
   * @param {Array<{t:number,hipMidX:number,kps:Keypoint[]}>} samples
   * @returns {{sign:number, direction:string, confidence:number, source:string, mirroredSuspected:boolean}}
   */
  function inferRunningDirection(samples) {
    var pts = (samples || []).filter(function (s) { return s && isNum(s.t) && isNum(s.hipMidX); });
    var unknown = {
      sign: 1, direction: RUNNING_DIRECTION.UNKNOWN, confidence: 0,
      source: 'none', mirroredSuspected: false
    };
    if (pts.length < 3) return unknown;

    // Least-squares slope of hipMidX against t.
    var n = pts.length, st = 0, sx = 0;
    for (var i = 0; i < n; i++) { st += pts[i].t; sx += pts[i].hipMidX; }
    var mt = st / n, mx = sx / n, num = 0, den = 0;
    for (var j = 0; j < n; j++) {
      var dt = pts[j].t - mt;
      num += dt * (pts[j].hipMidX - mx);
      den += dt * dt;
    }
    if (den <= 0) return unknown;
    var slope = num / den; // px/s

    // Coefficient of determination for the linear trend.
    var ssTot = 0, ssRes = 0;
    for (var k = 0; k < n; k++) {
      var pred = mx + slope * (pts[k].t - mt);
      ssTot += Math.pow(pts[k].hipMidX - mx, 2);
      ssRes += Math.pow(pts[k].hipMidX - pred, 2);
    }
    var r2 = ssTot > 0 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;

    // Body scale sets what counts as "meaningful" translation.
    var scales = samples.map(function (s) { return s && s.scale; }).filter(isNum);
    var scale = median(scales) || 60;
    var translationPerSecond = Math.abs(slope) / scale; // in torso-lengths/s

    if (translationPerSecond > 0.35 && r2 > 0.55) {
      return {
        sign: slope > 0 ? 1 : -1,
        direction: slope > 0 ? RUNNING_DIRECTION.LEFT_TO_RIGHT : RUNNING_DIRECTION.RIGHT_TO_LEFT,
        confidence: clamp(0.55 + 0.45 * r2, 0, 1),
        source: 'hip_translation',
        mirroredSuspected: false
      };
    }

    // Fallback: facing, from nose relative to hip midpoint. Works on a treadmill
    // but cannot detect a mirrored clip, so flag that possibility.
    var votes = 0, total = 0;
    (samples || []).forEach(function (s) {
      var nose = s && s.kps ? kp(s.kps, 0) : null;
      if (!nose || !isNum(s.hipMidX)) return;
      total++;
      votes += (nose.x > s.hipMidX) ? 1 : -1;
    });
    if (!total) return unknown;
    var facingSign = votes >= 0 ? 1 : -1;
    var agreement = Math.abs(votes) / total;
    return {
      sign: facingSign,
      direction: facingSign > 0 ? RUNNING_DIRECTION.LEFT_TO_RIGHT : RUNNING_DIRECTION.RIGHT_TO_LEFT,
      confidence: clamp(0.20 + 0.5 * agreement, 0, 0.75),
      source: 'body_facing',
      mirroredSuspected: true
    };
  }

  // ── The support-line angle ─────────────────────────────────────────────────
  /**
   * Signed support-line angle from vertical.
   *
   * Image space has +y DOWNWARD, so the "up" component is (support.y - com.y).
   * atan2 is used rather than a slope ratio so a vertically-aligned support line
   * (dx = 0) and a degenerate near-zero vertical extent are both handled without
   * a division.
   *
   * @param {SupportLineInput} input
   * @returns {{ok:boolean, reason?:string, angle?:AngleMeasure, com?:Object,
   *            supportPoint?:Object, legAxisAngleDegrees?:number|null,
   *            comLegDivergenceDegrees?:number|null, poseConfidence?:number}}
   */
  function computeSupportLine(input) {
    input = input || {};
    var kps = input.keypoints;
    var side = input.side;
    var phase = input.phase || PHASE.CENTRAL_STANCE;
    var dirSign = isNum(input.directionSign) && input.directionSign !== 0 ? (input.directionSign > 0 ? 1 : -1) : null;

    if (!kps || !kps.length) return { ok: false, reason: 'no_keypoints' };
    if (side !== 'left' && side !== 'right') return { ok: false, reason: 'invalid_side' };
    if (dirSign === null) return { ok: false, reason: 'unknown_running_direction' };

    var com = computeCOM(kps, input.comMethod || 'segmental');
    if (!com) return { ok: false, reason: 'com_unavailable' };

    var support = estimateSupportPoint(kps, side, phase, dirSign);
    if (!support) return { ok: false, reason: 'support_point_unavailable' };

    var verticalExtent = support.y - com.y; // > 0 when COM is above the support point
    var forward = (com.x - support.x) * dirSign;

    // Degenerate geometry: COM level with or below the support point means the
    // pose is not a plausible stance frame.
    var scaleRef = shankLength(kps, side) || 40;
    if (verticalExtent < 0.15 * scaleRef) {
      return { ok: false, reason: 'degenerate_vertical_extent' };
    }

    var theta = toDeg(Math.atan2(forward, verticalExtent));

    // Stance-leg axis as an independent cross-check. Spring-mass theory expects
    // GRF roughly along the leg; a large divergence means the COM is not stacked
    // over the stance limb.
    var hip = kp(kps, side === 'left' ? 11 : 12);
    var ankle = kp(kps, side === 'left' ? 15 : 16);
    var legAxis = null, divergence = null;
    if (hip && ankle) {
      var legVert = ankle.y - hip.y;
      if (legVert > 0.15 * scaleRef) {
        legAxis = toDeg(Math.atan2((hip.x - ankle.x) * dirSign, legVert));
        divergence = Math.abs(theta - legAxis);
      }
    }

    var relevant = [0, 5, 6, 11, 12, side === 'left' ? 13 : 14, side === 'left' ? 15 : 16];
    var confSum = 0, confN = 0;
    relevant.forEach(function (i) {
      if (kps[i] && isNum(kps[i].score)) { confSum += kps[i].score; confN++; }
    });

    return {
      ok: true,
      angle: {
        value: theta,
        units: 'degrees',
        referenceAxis: 'vertical',
        signConvention: 'negative_braking_positive_propulsive',
        phase: phase,
        side: side,
        method: METHOD.GEOMETRY_PROXY,
        provenance: PROVENANCE.KINEMATIC_ESTIMATE,
        uncertaintyDegrees: null
      },
      com: com,
      supportPoint: support,
      legAxisAngleDegrees: legAxis,
      comLegDivergenceDegrees: divergence,
      poseConfidence: confN ? confSum / confN : 0
    };
  }

  // ── Stance normalisation ──────────────────────────────────────────────────
  /**
   * Convert a target stance percentage into an interpolated sample position.
   * Returns the bracketing indices and a weight so callers can interpolate
   * angles rather than snapping to the nearest available frame.
   */
  function stancePercentToPosition(stance, percent) {
    if (!stance || !stance.samples || stance.samples.length < 2) return null;
    var s = stance.samples, t0 = s[0].t, t1 = s[s.length - 1].t;
    if (!(t1 > t0)) return null;
    var target = t0 + (t1 - t0) * (clamp(percent, 0, 100) / 100);
    for (var i = 0; i < s.length - 1; i++) {
      if (target >= s[i].t && target <= s[i + 1].t) {
        var span = s[i + 1].t - s[i].t;
        var w = span > 0 ? (target - s[i].t) / span : 0;
        return {
          loIndex: i, hiIndex: i + 1, weight: w, targetTime: target,
          actualPercent: ((target - t0) / (t1 - t0)) * 100
        };
      }
    }
    var last = s.length - 1;
    return { loIndex: last, hiIndex: last, weight: 0, targetTime: target, actualPercent: percent };
  }

  // ── Robust aggregation ────────────────────────────────────────────────────
  /**
   * Descriptive statistics for one metric across strides.
   * Outliers are FLAGGED, never silently dropped: the rule is a fixed 1.5*IQR
   * Tukey fence, and both the count and the values are reported.
   */
  function aggregate(values) {
    var v = (values || []).filter(isNum);
    var n = v.length;
    if (!n) {
      return { n: 0, mean: null, median: null, sd: null, iqr: null, min: null, max: null,
               q1: null, q3: null, ci95: null, sem: null, outlierCount: 0, outliers: [] };
    }
    var sorted = v.slice().sort(function (a, b) { return a - b; });
    var sum = v.reduce(function (a, b) { return a + b; }, 0);
    var mean = sum / n;
    var variance = n > 1 ? v.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / (n - 1) : 0;
    var sd = Math.sqrt(variance);
    var q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
    var iqr = (q1 != null && q3 != null) ? q3 - q1 : null;
    var sem = n > 1 ? sd / Math.sqrt(n) : null;
    var tMul = tMultiplier(n);
    var ci95 = (sem != null && tMul != null) ? [mean - tMul * sem, mean + tMul * sem] : null;

    var outliers = [];
    if (iqr != null && iqr > 0) {
      var lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
      outliers = v.filter(function (x) { return x < lo || x > hi; });
    }
    return {
      n: n, mean: mean, median: median(v), sd: sd, iqr: iqr,
      min: sorted[0], max: sorted[n - 1], q1: q1, q3: q3,
      ci95: ci95, sem: sem, outlierCount: outliers.length, outliers: outliers
    };
  }

  // ── Uncertainty and quality ───────────────────────────────────────────────
  //
  // Angular uncertainty is combined in quadrature from independent contributors.
  // Each contributor is expressed in degrees so the total is interpretable.
  var UNCERTAINTY_MODEL = Object.freeze({
    // Pose jitter: at MIN_CONF the landmark scatter is worth roughly this much
    // angular error; it falls toward the floor as confidence approaches 1.
    poseFloorDegrees: 1.2,
    poseMaxDegrees: 6.5,
    // Interpolating a stance window between sparse samples.
    samplingBaseDegrees: 0.8,
    samplingSparseDegrees: 3.2,
    // Out-of-plane / perspective error when the camera is not square-on.
    perspectiveDegrees: 3.0,
    occlusionDegrees: 2.5,
    // Confidence penalties, multiplicative on a 0..1 score.
    penalties: Object.freeze({
      low_pose_confidence: 0.80,
      sparse_stance_sampling: 0.88,
      low_frame_rate: 0.88,
      camera_not_perpendicular: 0.82,
      excessive_perspective: 0.80,
      landmark_occlusion: 0.85,
      insufficient_strides: 0.70,
      unstable_running_direction: 0.72,
      mirrored_video: 0.95,
      high_stride_variability: 0.85,
      acceleration_detected: 0.88,
      // Speed and grade are weighted LIGHTLY for orientation specifically.
      // Clark et al. (2012) found the vertical:horizontal force ratio nearly
      // speed-invariant (5.86:1 at 5 m/s vs 5.85:1 at top speed; ~5.2% change
      // across each runner's range), so orientation is far less speed-sensitive
      // than impulse or stride-length metrics would be. This penalty must NOT be
      // reused for any impulse-derived quantity.
      speed_unknown: 0.96,
      grade_unknown: 0.98,
      uncertain_contact_frame: 0.85
    })
  });

  /**
   * @param {Object} ctx
   * @param {number} ctx.poseConfidence 0..1
   * @param {number} ctx.samplesInStance
   * @param {number|null} ctx.strideSem  SEM of the metric across strides, degrees
   * @param {string[]} ctx.flags
   * @returns {{score:number, angleUncertaintyDegrees:number, components:Object}}
   */
  function computeConfidence(ctx) {
    ctx = ctx || {};
    var m = UNCERTAINTY_MODEL;
    var flags = ctx.flags || [];
    var conf = clamp(isNum(ctx.poseConfidence) ? ctx.poseConfidence : 0, 0, 1);

    // Pose contribution: interpolate between max (at conf 0.25) and floor (at 1).
    var span = Math.max(0.0001, 1 - MIN_CONF);
    var poseFrac = clamp((conf - MIN_CONF) / span, 0, 1);
    var uPose = m.poseMaxDegrees - (m.poseMaxDegrees - m.poseFloorDegrees) * poseFrac;

    var sparse = flags.indexOf(QUALITY_FLAG.SPARSE_STANCE_SAMPLING) !== -1;
    var uSampling = sparse ? m.samplingSparseDegrees : m.samplingBaseDegrees;

    var uPerspective = (flags.indexOf(QUALITY_FLAG.CAMERA_NOT_PERPENDICULAR) !== -1 ||
                        flags.indexOf(QUALITY_FLAG.EXCESSIVE_PERSPECTIVE) !== -1) ? m.perspectiveDegrees : 0;
    var uOcclusion = flags.indexOf(QUALITY_FLAG.LANDMARK_OCCLUSION) !== -1 ? m.occlusionDegrees : 0;
    var uStride = isNum(ctx.strideSem) ? ctx.strideSem : 0;

    var total = Math.sqrt(uPose * uPose + uSampling * uSampling +
                          uPerspective * uPerspective + uOcclusion * uOcclusion +
                          uStride * uStride);

    var score = 0.35 + 0.65 * poseFrac;
    flags.forEach(function (f) {
      var p = m.penalties[f];
      if (p) score *= p;
    });

    return {
      score: clamp(score, 0, 1),
      angleUncertaintyDegrees: total,
      components: {
        pose: uPose, sampling: uSampling, perspective: uPerspective,
        occlusion: uOcclusion, strideSem: uStride
      }
    };
  }

  /**
   * Display precision driven by uncertainty, so a ±2.7° estimate can never be
   * rendered as "−8.94°".
   */
  function formatAngle(value, uncertaintyDegrees) {
    if (!isNum(value)) return '—';
    var u = isNum(uncertaintyDegrees) ? uncertaintyDegrees : null;
    var sign = value > 0 ? '+' : '';
    if (u == null) return sign + value.toFixed(1) + '°';
    if (u > 6) {
      var lo = Math.round(value - u), hi = Math.round(value + u);
      return lo + '° to ' + (hi > 0 ? '+' : '') + hi + '°';
    }
    if (u > 3) return sign + Math.round(value) + '° ± ' + Math.round(u) + '°';
    return sign + value.toFixed(1) + '° ± ' + u.toFixed(1) + '°';
  }

  function confidenceBand(score) {
    if (!isNum(score)) return 'unknown';
    if (score >= 0.75) return 'high';
    if (score >= 0.45) return 'moderate';
    return 'low';
  }

  // ── Coupled braking / propulsion interpretation ───────────────────────────
  //
  // Braking and propulsion are read as ONE pattern. Neither is scored well for
  // being large. At steady speed the net fore-aft impulse over a step is ~0
  // (Munro et al. observed braking and propulsive impulses rising together with
  // speed), so a large early angle paired with a large late angle describes
  // greater speed loss and re-acceleration demand — not more "drive".
  var COUPLED_PATTERN = Object.freeze({
    LOW_EXCURSION: 'low_fore_aft_excursion',
    HIGH_EXCURSION: 'high_fore_aft_excursion',
    BRAKING_DOMINANT: 'braking_dominant',
    PROPULSION_DOMINANT: 'propulsion_dominant',
    INDETERMINATE: 'indeterminate'
  });

  var EXCURSION_THRESHOLD_DEGREES = 9;   // per-phase magnitude considered "large"
  var DOMINANCE_RATIO = 1.8;             // one phase this many times the other

  /**
   * @param {number|null} earlyAngle  degrees (expected negative)
   * @param {number|null} lateAngle   degrees (expected positive)
   */
  function classifyCoupledPattern(earlyAngle, lateAngle) {
    if (!isNum(earlyAngle) || !isNum(lateAngle)) {
      return {
        pattern: COUPLED_PATTERN.INDETERMINATE,
        foreAftGeometricExcursionDegrees: null,
        brakingMagnitudeDegrees: isNum(earlyAngle) ? Math.abs(earlyAngle) : null,
        propulsiveMagnitudeDegrees: isNum(lateAngle) ? Math.abs(lateAngle) : null,
        couplingRatio: null,
        momentumPreservationFlag: false,
        interpretation: 'Not enough phase data to interpret braking and propulsion together.'
      };
    }
    var b = Math.abs(earlyAngle), p = Math.abs(lateAngle);
    var excursion = b + p;
    var ratio = p > 0.0001 ? b / p : null;
    var bigB = b >= EXCURSION_THRESHOLD_DEGREES, bigP = p >= EXCURSION_THRESHOLD_DEGREES;

    var pattern, interpretation, momentum = false;
    if (ratio != null && ratio >= DOMINANCE_RATIO && bigB) {
      pattern = COUPLED_PATTERN.BRAKING_DOMINANT;
      interpretation = 'Braking-oriented contact geometry without a matching late-stance propulsive orientation. ' +
        'Review event detection, speed stability and side-to-side differences.';
    } else if (ratio != null && ratio <= 1 / DOMINANCE_RATIO && bigP) {
      pattern = COUPLED_PATTERN.PROPULSION_DOMINANT;
      interpretation = 'Low braking orientation with strong late-stance propulsive geometry. ' +
        'Confirm event timing and acceleration state.';
    } else if (!bigB && !bigP) {
      pattern = COUPLED_PATTERN.LOW_EXCURSION;
      momentum = true;
      interpretation = 'Low fore–aft geometric excursion. This may indicate good momentum preservation, ' +
        'but force magnitude is not available from this analysis.';
    } else {
      pattern = COUPLED_PATTERN.HIGH_EXCURSION;
      interpretation = 'High fore–aft geometric excursion. This pattern may indicate greater braking and ' +
        're-propulsion demand.';
    }

    return {
      pattern: pattern,
      foreAftGeometricExcursionDegrees: excursion,
      brakingMagnitudeDegrees: b,
      propulsiveMagnitudeDegrees: p,
      couplingRatio: ratio,
      momentumPreservationFlag: momentum,
      interpretation: interpretation,
      isKinematicDescriptorOnly: true
    };
  }

  // ── Impulse / force domain definitions (Phase 12) ─────────────────────────
  //
  // Defined now so a validated estimator can populate them later. Under
  // geometry_proxy every field is null with an explicit reason — these require
  // force MAGNITUDE and time weighting and must never be synthesised from a few
  // phase angles.
  var IMPULSE_DEFINITIONS = Object.freeze({
    verticalImpulse: 'Jv = ∫ Fz dt over stance',
    effectiveVerticalImpulse: 'JvEffective = ∫ (Fz − bodyWeight) dt over stance',
    brakingImpulse: 'Jbrake = −∫ Fx dt over portions where Fx < 0',
    propulsiveImpulse: 'Jprop = ∫ Fx dt over portions where Fx > 0',
    absoluteHorizontalImpulse: 'JhAbs = Jbrake + Jprop',
    netHorizontalImpulse: 'JxNet = Jprop − Jbrake (≈ 0 at steady speed)',
    foreAftDemandRatio: 'FAD = JhAbs / Jv',
    verticalSupportShare: 'VSS = Jv / (Jv + JhAbs) — SCALAR-SUM SHARE, not a direction cosine',
    horizontalDemandShare: 'HDS = JhAbs / (Jv + JhAbs) — SCALAR-SUM SHARE, not a direction cosine',
    foreAftDemandAngleEquivalent:
      'atan(JhAbs / Jv), in degrees. NOT A VECTOR ORIENTATION: JhAbs sums two ' +
      'opposing force directions, so no instantaneous resultant points this way. ' +
      'Retained as a scalar demand descriptor only.'
  });

  function unavailableForceMetrics(reason) {
    return {
      availability: AVAILABILITY.UNAVAILABLE,
      reason: reason || 'geometry_proxy_has_no_force_magnitude',
      verticalImpulse: null,
      effectiveVerticalImpulse: null,
      brakingImpulse: null,
      propulsiveImpulse: null,
      absoluteHorizontalImpulse: null,
      netHorizontalImpulse: null,
      foreAftDemandRatio: null,
      verticalSupportShare: null,
      horizontalDemandShare: null,
      foreAftDemandAngleEquivalent: null,
      shareConvention: 'scalar_sum_share',
      definitions: IMPULSE_DEFINITIONS
    };
  }

  /**
   * Impulse metrics from a genuine force-time series. Shares are labelled
   * scalar-sum so they can never be mistaken for direction cosines.
   * @param {Array<{t:number,fx:number,fz:number}>} series
   * @param {number|null} bodyWeightNewtons
   */
  function computeImpulseMetrics(series, bodyWeightNewtons) {
    var pts = (series || []).filter(function (p) { return p && isNum(p.t) && isNum(p.fx) && isNum(p.fz); });
    if (pts.length < 3) return unavailableForceMetrics('insufficient_force_samples');
    pts.sort(function (a, b) { return a.t - b.t; });

    var jv = 0, jvEff = 0, jBrake = 0, jProp = 0;
    for (var i = 1; i < pts.length; i++) {
      var dt = pts[i].t - pts[i - 1].t;
      if (!(dt > 0)) continue;
      var fzAvg = (pts[i].fz + pts[i - 1].fz) / 2;
      var fxAvg = (pts[i].fx + pts[i - 1].fx) / 2;
      jv += fzAvg * dt;
      if (isNum(bodyWeightNewtons)) jvEff += (fzAvg - bodyWeightNewtons) * dt;
      if (fxAvg < 0) jBrake += -fxAvg * dt; else jProp += fxAvg * dt;
    }
    var jhAbs = jBrake + jProp;
    var denom = jv + jhAbs;
    return {
      availability: AVAILABILITY.AVAILABLE,
      reason: null,
      verticalImpulse: jv,
      effectiveVerticalImpulse: isNum(bodyWeightNewtons) ? jvEff : null,
      brakingImpulse: jBrake,
      propulsiveImpulse: jProp,
      absoluteHorizontalImpulse: jhAbs,
      netHorizontalImpulse: jProp - jBrake,
      foreAftDemandRatio: jv !== 0 ? jhAbs / jv : null,
      verticalSupportShare: denom !== 0 ? jv / denom : null,
      horizontalDemandShare: denom !== 0 ? jhAbs / denom : null,
      foreAftDemandAngleEquivalent: jv !== 0 ? toDeg(Math.atan(jhAbs / jv)) : null,
      shareConvention: 'scalar_sum_share',
      definitions: IMPULSE_DEFINITIONS
    };
  }

  // ── Schema migration ──────────────────────────────────────────────────────
  /**
   * Read-time normalisation of a stored analysis. Never mutates or rewrites the
   * stored document; a pre-KFO analysis becomes an explicit "unavailable"
   * envelope rather than an empty or fabricated panel.
   */
  function migrateAnalysis(stored) {
    var doc = stored || {};
    // The version lives INSIDE the kfo block: this feature must not add fields to
    // the shared analysis document. A root-level schemaVersion is still accepted,
    // because a small number of documents were written that way before the scope
    // was tightened.
    var version = (doc.kfo && isNum(doc.kfo.schemaVersion)) ? doc.kfo.schemaVersion
                : isNum(doc.schemaVersion) ? doc.schemaVersion
                : 1;
    if (version >= SCHEMA_VERSION && doc.kfo) {
      return { schemaVersion: version, kfo: doc.kfo, migrated: false, sourceVersion: version };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      migrated: true,
      sourceVersion: version,
      kfo: {
        analysisType: ANALYSIS_TYPE,
        schemaVersion: SCHEMA_VERSION,
        availability: AVAILABILITY.UNAVAILABLE,
        reason: 'analysis_predates_kinematic_force_orientation',
        method: null,
        modelVersion: null,
        limitations: ['Saved before kinematic force-orientation existed; pose keypoints were not stored, so it cannot be computed retroactively.']
      }
    };
  }

  function methodMetadata(method, referenceVersion) {
    return {
      method: method,
      modelVersion: MODEL_VERSION,
      calibrationVersion: referenceVersion || null,
      isValidated: !!METHOD_IS_VALIDATED[method],
      limitations: method === METHOD.GEOMETRY_PROXY ? GEOMETRY_LIMITATIONS.slice() : []
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MODEL_VERSION: MODEL_VERSION,
    ANALYSIS_TYPE: ANALYSIS_TYPE,
    MIN_CONF: MIN_CONF,
    METHOD: METHOD,
    METHOD_IS_VALIDATED: METHOD_IS_VALIDATED,
    PHASE: PHASE,
    PHASE_WINDOWS: PHASE_WINDOWS,
    PHASE_ORDER: PHASE_ORDER,
    EVENT_SELECTION: EVENT_SELECTION,
    QUALITY_FLAG: QUALITY_FLAG,
    FLAG_LABEL: FLAG_LABEL,
    PROVENANCE: PROVENANCE,
    VALIDATION_STATUS: VALIDATION_STATUS,
    RUNNING_DIRECTION: RUNNING_DIRECTION,
    AVAILABILITY: AVAILABILITY,
    GEOMETRY_LIMITATIONS: GEOMETRY_LIMITATIONS,
    SUPPORT_POINT_MODEL: SUPPORT_POINT_MODEL,
    UNCERTAINTY_MODEL: UNCERTAINTY_MODEL,
    COUPLED_PATTERN: COUPLED_PATTERN,
    IMPULSE_DEFINITIONS: IMPULSE_DEFINITIONS,
    EXCURSION_THRESHOLD_DEGREES: EXCURSION_THRESHOLD_DEGREES,

    computeCOM: computeCOM,
    shankLength: shankLength,
    estimateSupportPoint: estimateSupportPoint,
    inferRunningDirection: inferRunningDirection,
    computeSupportLine: computeSupportLine,
    stancePercentToPosition: stancePercentToPosition,
    aggregate: aggregate,
    computeConfidence: computeConfidence,
    formatAngle: formatAngle,
    confidenceBand: confidenceBand,
    classifyCoupledPattern: classifyCoupledPattern,
    unavailableForceMetrics: unavailableForceMetrics,
    computeImpulseMetrics: computeImpulseMetrics,
    migrateAnalysis: migrateAnalysis,
    methodMetadata: methodMetadata,

    // exposed for tests
    _internals: { median: median, quantile: quantile, tMultiplier: tMultiplier, toDeg: toDeg }
  };
});
