// ─────────────────────────────────────────────────────────────────────────────
//  PROJECTION & GROUND INTERACTION (PGI) — core domain module
//
//  Supersedes the Force-Vector / Kinematic Force-Orientation product surface.
//  The question this feature answers is:
//
//      "How is this runner creating stride length and interacting with the
//       ground?"
//
//  through five linked domains: PROJECT → PREPARE → LAND/LOAD → REBOUND →
//  FLIGHT/STRIDE OUTCOME. See docs/projection-ground-interaction-analysis.md.
//
//  This module holds the schema, enums, quality flags, calibration and speed
//  models, ballistic-flight formulas, and the smoothing wrapper. It depends on
//  kfo-core.js (COM estimation, aggregation, uncertainty) and kfo-estimators.js
//  (local-polynomial smoothing) — those calculations are preserved as inputs;
//  only the product paradigm around them was replaced.
//
//  WHAT THIS FEATURE NEVER CLAIMS
//  ------------------------------
//  - It does not measure ground-reaction force. Every force-adjacent quantity
//    is a timing- or kinematics-derived estimate and is labelled so.
//  - It does not score "more vertical force vector = better", and it does not
//    penalize vertical oscillation on its own. Interpretation is combination-
//    based (see pgi-patterns.js).
//  - It has no single efficiency score.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var est = isNode ? require('./kfo-estimators.js') : root.KFOEstimators;
  var api = factory(core, est);
  if (isNode) module.exports = api;
  if (root) root.PGI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, KFOEstimators) {
  'use strict';

  // The schemaVersion counts product generations of this analysis surface:
  //   1 = pre-KFO force-vector prototype era (nothing stored)
  //   2 = the `kfo` block (kinematic force-orientation)
  //   3 = the `pgi` block (projection & ground interaction)
  // A stored document carries the version INSIDE its own block, so `kfo` v3
  // (impulse accounting) and `pgi` v3 cannot collide: the block name plus
  // analysisType disambiguates.
  var SCHEMA_VERSION = 3;
  var MODEL_VERSION = 'projection-ground-interaction-v1.0.0';
  var ANALYSIS_TYPE = 'projection_ground_interaction';

  var SCHEMA_HISTORY = Object.freeze({
    1: 'Pre-KFO. Force-vector prototype era; nothing persisted.',
    2: 'Kinematic Force-Orientation `kfo` block (its own internal versions 2–3).',
    3: 'Projection & Ground Interaction `pgi` block: touchdown preparation, stride ' +
       'timing, vertical projection, COM trajectory decomposition, rebound, stride ' +
       'outcome, pattern interpretation, condition comparison. Support-line angles ' +
       'retained as secondary descriptive geometry.'
  });

  var GRAVITY_MPS2 = 9.80665;

  var DISCLAIMER = 'This analysis is derived from video kinematics. It does not directly ' +
    'measure ground-reaction force.';

  // ── Enums ──────────────────────────────────────────────────────────────────

  var AVAILABILITY = KFO.AVAILABILITY; // available / unavailable / insufficient_quality

  var SPEED_SOURCE = Object.freeze({
    MEASURED: 'measured',
    USER_ENTERED: 'user_entered',
    ESTIMATED_TRANSLATION: 'estimated_translation',
    UNKNOWN: 'unknown'
  });

  var SURFACE = Object.freeze({
    OVERGROUND: 'overground',
    TREADMILL: 'treadmill',
    UNKNOWN: 'unknown'
  });

  var CALIBRATION_SOURCE = Object.freeze({
    USER_HEIGHT: 'user_height',
    BALLISTIC_FLIGHT: 'ballistic_flight',
    NONE: 'none'
  });

  /** Braking-related touchdown patterns. Assigned from COMBINATIONS, never one metric. */
  var BRAKING_PATTERN = Object.freeze({
    POSITIONAL_OVERSTRIDE: 'positional_overstride',
    VELOCITY_MISMATCH: 'velocity_mismatch_touchdown',
    COMBINED_BRAKING: 'combined_braking',
    WELL_PREPARED: 'well_prepared_touchdown',
    INDETERMINATE: 'indeterminate'
  });

  /** Vertical-mechanics patterns. Descriptive, not ranked. */
  var VERTICAL_PATTERN = Object.freeze({
    LOW_PROJECTION: 'low_projection',
    SLOW_PROJECTION: 'slow_projection',
    PRODUCTIVE_PROJECTION: 'productive_projection',
    COLLISION_HEAVY: 'collision_heavy',
    EXCESSIVE_VERTICAL_EXCURSION: 'excessive_vertical_excursion',
    ELASTIC_RAPID_REBOUND: 'elastic_rapid_rebound',
    RUSHED_TOUCHDOWN: 'rushed_touchdown',
    UNPRODUCTIVE_VERTICAL_EXCURSION: 'unproductive_vertical_excursion',
    INDETERMINATE: 'indeterminate'
  });

  /** Domain summary ratings (Phase 21). Not a global score. */
  var DOMAIN_RATING = Object.freeze({
    touchdownPreparation: Object.freeze(['good', 'moderate', 'needs_review', 'unknown']),
    brakingIndicators: Object.freeze(['low', 'moderate', 'elevated', 'unknown']),
    verticalProjection: Object.freeze(['low', 'moderate', 'strong', 'unknown']),
    reboundTiming: Object.freeze(['slow', 'moderate', 'rapid', 'unknown']),
    strideOutcome: Object.freeze(['short_for_speed', 'appropriate', 'long_for_speed', 'unknown']),
    dataConfidence: Object.freeze(['high', 'moderate', 'low', 'unknown'])
  });

  // Extra quality flags on top of KFO.QUALITY_FLAG.
  var PGI_FLAG = Object.freeze({
    TREADMILL_SPEED_UNKNOWN: 'treadmill_speed_unknown',
    NO_SPATIAL_CALIBRATION: 'no_spatial_calibration',
    VELOCITY_SAMPLING_INSUFFICIENT: 'velocity_sampling_insufficient',
    CALIBRATION_IS_BALLISTIC: 'calibration_is_ballistic_implied',
    DENSE_PRECONTACT_UNAVAILABLE: 'dense_precontact_sampling_unavailable',
    SPEED_MISMATCH_BETWEEN_CONDITIONS: 'speed_mismatch_between_conditions'
  });

  var PGI_FLAG_LABEL = Object.freeze({
    treadmill_speed_unknown: 'Treadmill/belt speed unknown — ground-relative foot velocity unavailable',
    no_spatial_calibration: 'No spatial calibration — lengths reported in normalized units only',
    velocity_sampling_insufficient: 'Frame rate too low for reliable pre-contact velocity',
    calibration_is_ballistic_implied: 'Scale calibration implied from ballistic flight, not measured',
    dense_precontact_sampling_unavailable: 'Dense pre-contact sampling unavailable — coarse scan used',
    speed_mismatch_between_conditions: 'Conditions were performed at different speeds'
  });

  function flagLabel(f) { return PGI_FLAG_LABEL[f] || KFO.FLAG_LABEL[f] || f; }

  // ── Numeric helpers ────────────────────────────────────────────────────────

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function median(arr) { return KFO._internals.median(arr); }
  function round(v, dp) {
    if (!isNum(v)) return null;
    var f = Math.pow(10, dp == null ? 3 : dp);
    return Math.round(v * f) / f;
  }

  // ── Ballistic flight formulas (Phase 8) ────────────────────────────────────
  //
  // Under approximately ballistic flight, flight time alone pins the vertical
  // take-off velocity, the effective vertical impulse per unit mass, and the
  // aerial rise. These are the primary projection metrics because they need no
  // calibration and no pose-derived velocity.
  //
  //   verticalTakeoffVelocity      = g · tFlight / 2                 [m/s]
  //   effectiveVerticalImpulse/m   = 2 · vTakeoff = g · tFlight      [m/s ≡ N·s/kg]
  //   aerialRise                   = g · tFlight² / 8                [m]
  //   predictedFlightTime          = 2 · vTakeoff / g                [s]
  //
  // aerialRise is the BALLISTIC rise of the COM between toe-off and apex. It is
  // not total vertical oscillation, which also contains stance compression and
  // rebound — see pgi-com.js for the decomposition.

  function verticalTakeoffVelocityMps(flightSeconds) {
    return (isNum(flightSeconds) && flightSeconds >= 0) ? GRAVITY_MPS2 * flightSeconds / 2 : null;
  }
  function effectiveVerticalImpulsePerMass(flightSeconds) {
    return (isNum(flightSeconds) && flightSeconds >= 0) ? GRAVITY_MPS2 * flightSeconds : null;
  }
  function aerialRiseMeters(flightSeconds) {
    return (isNum(flightSeconds) && flightSeconds >= 0)
      ? GRAVITY_MPS2 * flightSeconds * flightSeconds / 8 : null;
  }
  function predictedFlightTimeSeconds(takeoffVelocityMps) {
    return (isNum(takeoffVelocityMps) && takeoffVelocityMps >= 0)
      ? 2 * takeoffVelocityMps / GRAVITY_MPS2 : null;
  }

  // ── Smoothing (Phase 11) ───────────────────────────────────────────────────
  //
  // One smoothing choice for the whole feature: the local-polynomial
  // (Savitzky–Golay-equivalent) fit already in kfo-estimators.js, which
  // tolerates the slightly non-uniform timestamps video seeking produces.
  // Raw series are always retained alongside smoothed ones.

  var SMOOTHING_DEFAULTS = Object.freeze({ windowSize: 7, polyOrder: 2 });

  /**
   * @param {Array<{t:number,v:number}>} series
   * @param {{windowSize?:number, polyOrder?:number}} [opts]
   * @returns {{filter:Object, points:Array<{t,value,d1,d2}>, insufficient:boolean}}
   */
  function smoothSeries(series, opts) {
    var o = opts || {};
    return KFOEstimators.localPolyDerivatives(series, {
      windowSize: o.windowSize || SMOOTHING_DEFAULTS.windowSize,
      polyOrder: o.polyOrder || SMOOTHING_DEFAULTS.polyOrder
    });
  }

  /** Linear interpolation of {t,value} points at time t. Null outside the range. */
  function valueAtTime(points, t, key) {
    var k = key || 'value';
    if (!points || !points.length || !isNum(t)) return null;
    if (t < points[0].t || t > points[points.length - 1].t) return null;
    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i], b = points[i + 1];
      if (t >= a.t && t <= b.t) {
        if (!isNum(a[k]) || !isNum(b[k])) return isNum(a[k]) ? a[k] : (isNum(b[k]) ? b[k] : null);
        var span = b.t - a.t;
        if (!(span > 0)) return a[k];
        return a[k] + (b[k] - a[k]) * ((t - a.t) / span);
      }
    }
    return points[points.length - 1][k];
  }

  /** Extremum of {t,value} points inside [t0,t1]. */
  function extremumInWindow(points, t0, t1, key, mode) {
    var k = key || 'value';
    var best = null;
    (points || []).forEach(function (p) {
      if (!p || !isNum(p.t) || p.t < t0 || p.t > t1 || !isNum(p[k])) return;
      if (!best ||
          (mode === 'min' ? p[k] < best.v : p[k] > best.v)) best = { t: p.t, v: p[k] };
    });
    return best;
  }

  // ── Body-relative normalization ────────────────────────────────────────────
  //
  // Without spatial calibration, pixel lengths are only comparable within a
  // runner. Leg length (hip→knee→ankle, straightened) is the normalizer for
  // foot-excursion metrics; body scale (shoulder-mid → hip-mid) backs it up.

  function legLengthPx(kps, side) {
    var hip = kpAt(kps, side === 'left' ? 11 : 12);
    var knee = kpAt(kps, side === 'left' ? 13 : 14);
    var ankle = kpAt(kps, side === 'left' ? 15 : 16);
    if (!hip || !knee || !ankle) return null;
    var thigh = Math.hypot(knee.x - hip.x, knee.y - hip.y);
    var shank = Math.hypot(ankle.x - knee.x, ankle.y - knee.y);
    var total = thigh + shank;
    return total > 2 ? total : null;
  }

  function kpAt(kps, i) {
    return (kps && kps[i] && isNum(kps[i].x) && isNum(kps[i].y) &&
            (kps[i].score || 0) >= KFO.MIN_CONF) ? kps[i] : null;
  }

  /** Median leg length across samples, both sides pooled (they should agree). */
  function medianLegLengthPx(samples) {
    var vals = [];
    (samples || []).forEach(function (s) {
      if (!s || !s.kps) return;
      var l = legLengthPx(s.kps, 'left');
      var r = legLengthPx(s.kps, 'right');
      if (isNum(l)) vals.push(l);
      if (isNum(r)) vals.push(r);
    });
    return median(vals);
  }

  // ── Spatial calibration (Phase 4 / 27) ─────────────────────────────────────
  //
  // pixelsPerMeter with an explicit source. Never invented: when no source is
  // available the calibration is {source:'none'} and metre/centimetre outputs
  // are withheld in favour of normalized units.

  /**
   * From user-entered standing height, via the nose-to-ankle extent model in
   * kfo-estimators.js, taken at the median over upright-looking samples.
   */
  function calibrationFromHeight(samples, heightMeters) {
    if (!isNum(heightMeters) || heightMeters < 1.2 || heightMeters > 2.3) return { source: CALIBRATION_SOURCE.NONE, pixelsPerMeter: null };
    var ppms = [];
    (samples || []).forEach(function (s) {
      if (!s || !s.kps) return;
      var cal = KFOEstimators.calibrationFromAssumedHeight(s.kps, heightMeters);
      if (cal && isNum(cal.pixelsPerMeter)) ppms.push(cal.pixelsPerMeter);
    });
    var med = median(ppms);
    if (!isNum(med)) return { source: CALIBRATION_SOURCE.NONE, pixelsPerMeter: null };
    return {
      source: CALIBRATION_SOURCE.USER_HEIGHT,
      pixelsPerMeter: med,
      sampleCount: ppms.length,
      assumptions: ['User-entered standing height ' + heightMeters + ' m',
                    'Nose-to-ankle taken as 0.87 of standing height'],
      isMeasured: false
    };
  }

  /**
   * Ballistic-implied calibration: pose-derived vertical take-off velocity is in
   * px/s while flight time pins it in m/s, so each step implies a px/m scale:
   *
   *     ppm_i = vTakeoffPx_i / (g · tFlight_i / 2)
   *
   * The spread of ppm across steps doubles as a consistency check on the
   * pose-derived COM velocity (Phase 12): a physically coherent trajectory
   * implies nearly the same scale on every step.
   *
   * IMPORTANT: when this calibration is used, the flight-time cross-check is no
   * longer independent — that circularity is flagged, never hidden.
   */
  function calibrationFromBallistic(pairs) {
    var ppms = [];
    (pairs || []).forEach(function (p) {
      if (!p || !isNum(p.takeoffVelocityPxPerS) || !isNum(p.flightSeconds)) return;
      var vMps = verticalTakeoffVelocityMps(p.flightSeconds);
      if (!isNum(vMps) || vMps <= 0.05) return;      // near-zero flight ⇒ unusable
      if (p.takeoffVelocityPxPerS <= 0) return;      // downward take-off ⇒ noise
      ppms.push(p.takeoffVelocityPxPerS / vMps);
    });
    if (ppms.length < 3) {
      return { source: CALIBRATION_SOURCE.NONE, pixelsPerMeter: null,
               reason: 'fewer_than_three_usable_steps' };
    }
    var med = median(ppms);
    var mean = ppms.reduce(function (a, b) { return a + b; }, 0) / ppms.length;
    var sd = Math.sqrt(ppms.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) /
                       (ppms.length - 1));
    var cv = mean > 0 ? sd / mean : null;
    return {
      source: CALIBRATION_SOURCE.BALLISTIC_FLIGHT,
      pixelsPerMeter: med,
      sampleCount: ppms.length,
      coefficientOfVariation: cv,
      impliedScales: ppms,
      assumptions: ['Approximately ballistic flight',
                    'Pose-derived COM vertical velocity at toe-off'],
      isMeasured: false,
      circularityNote: 'Derived from the same flight times the projection metrics use; the ' +
        'flight-time cross-check is not independent under this calibration.'
    };
  }

  /** Pick the best available calibration. Order: user height, ballistic, none. */
  function selectCalibration(candidates) {
    var bySource = {};
    (candidates || []).forEach(function (c) { if (c && c.source) bySource[c.source] = c; });
    if (bySource[CALIBRATION_SOURCE.USER_HEIGHT] && isNum(bySource[CALIBRATION_SOURCE.USER_HEIGHT].pixelsPerMeter)) {
      return bySource[CALIBRATION_SOURCE.USER_HEIGHT];
    }
    var b = bySource[CALIBRATION_SOURCE.BALLISTIC_FLIGHT];
    if (b && isNum(b.pixelsPerMeter) && (!isNum(b.coefficientOfVariation) || b.coefficientOfVariation <= 0.35)) {
      return b;
    }
    return { source: CALIBRATION_SOURCE.NONE, pixelsPerMeter: null };
  }

  function pxToMeters(px, calibration) {
    if (!isNum(px) || !calibration || !isNum(calibration.pixelsPerMeter) ||
        calibration.pixelsPerMeter <= 0) return null;
    return px / calibration.pixelsPerMeter;
  }

  // ── Speed model (Phase 18) ─────────────────────────────────────────────────

  /**
   * Resolve the speed context. User-entered speed wins; otherwise, overground
   * clips with strong hip translation and a calibration yield an estimate.
   *
   * @param {Object} o {userSpeedMps, samples, direction, calibration, surfaceType}
   * @returns {{speedMps:number|null, speedSource:string, speedConfidence:number|null, note:string|null}}
   */
  function resolveSpeed(o) {
    o = o || {};
    if (isNum(o.userSpeedMps) && o.userSpeedMps > 0.5 && o.userSpeedMps < 13) {
      return { speedMps: o.userSpeedMps, speedSource: SPEED_SOURCE.USER_ENTERED,
               speedConfidence: 0.9, note: null };
    }
    // Treadmill belt speed doubles as running speed when supplied.
    if (isNum(o.treadmillSpeedMps) && o.treadmillSpeedMps > 0.5 && o.treadmillSpeedMps < 13) {
      return { speedMps: o.treadmillSpeedMps, speedSource: SPEED_SOURCE.USER_ENTERED,
               speedConfidence: 0.9, note: 'Taken from entered treadmill speed.' };
    }
    var dir = o.direction;
    var cal = o.calibration;
    if (dir && dir.source === 'hip_translation' && cal && isNum(cal.pixelsPerMeter) &&
        o.samples && o.samples.length >= 8) {
      // Least-squares slope of hipMidX over time, converted through the calibration.
      var pts = o.samples.filter(function (s) { return s && isNum(s.t) && isNum(s.hipMidX); });
      if (pts.length >= 8) {
        var n = pts.length, st = 0, sx = 0;
        pts.forEach(function (p) { st += p.t; sx += p.hipMidX; });
        var mt = st / n, mx = sx / n, num = 0, den = 0;
        pts.forEach(function (p) { num += (p.t - mt) * (p.hipMidX - mx); den += Math.pow(p.t - mt, 2); });
        if (den > 0) {
          var pxPerS = Math.abs(num / den);
          var v = pxToMeters(pxPerS, cal);
          if (isNum(v) && v > 0.5 && v < 13) {
            var conf = 0.35 + 0.4 * (dir.confidence || 0);
            if (cal.source === CALIBRATION_SOURCE.BALLISTIC_FLIGHT) conf *= 0.8;
            return {
              speedMps: v, speedSource: SPEED_SOURCE.ESTIMATED_TRANSLATION,
              speedConfidence: clamp(conf, 0, 0.8),
              note: 'Estimated from hip translation and ' + cal.source + ' calibration.'
            };
          }
        }
      }
    }
    return { speedMps: null, speedSource: SPEED_SOURCE.UNKNOWN, speedConfidence: null,
             note: 'Speed unavailable; speed-specific interpretation is limited.' };
  }

  /**
   * Ground-relative horizontal foot velocity (Phase 4). Sign convention:
   * +x is the direction of travel after direction normalization.
   *
   * Overground, fixed camera: the ground is stationary in the image, so the
   * world foot velocity IS the ground-relative velocity.
   *
   * Treadmill: the belt surface moves opposite to the direction of travel at
   * beltSpeed, so footGround = worldFoot − (−beltSpeed) = worldFoot + beltSpeed.
   * Needs both belt speed AND a calibration to put them in shared units.
   *
   * @param {Object} o {worldFootVelocityMps, surfaceType, treadmillSpeedMps}
   */
  function footGroundVelocity(o) {
    o = o || {};
    if (!isNum(o.worldFootVelocityMps)) {
      return { availability: AVAILABILITY.UNAVAILABLE, valueMps: null,
               reason: 'world_foot_velocity_unavailable' };
    }
    if (o.surfaceType === SURFACE.TREADMILL) {
      if (!isNum(o.treadmillSpeedMps)) {
        return { availability: AVAILABILITY.UNAVAILABLE, valueMps: null,
                 reason: 'treadmill_speed_unknown',
                 note: 'Belt speed unknown; COM-relative retraction metrics are reported instead.' };
      }
      return {
        availability: AVAILABILITY.AVAILABLE,
        valueMps: o.worldFootVelocityMps + o.treadmillSpeedMps,
        signConvention: 'positive_in_direction_of_travel',
        surfaceType: SURFACE.TREADMILL,
        beltSpeedMps: o.treadmillSpeedMps
      };
    }
    if (o.surfaceType === SURFACE.OVERGROUND) {
      return {
        availability: AVAILABILITY.AVAILABLE,
        valueMps: o.worldFootVelocityMps,
        signConvention: 'positive_in_direction_of_travel',
        surfaceType: SURFACE.OVERGROUND,
        note: 'Fixed camera assumed: ground velocity is zero in world coordinates.'
      };
    }
    return { availability: AVAILABILITY.UNAVAILABLE, valueMps: null,
             reason: 'surface_type_unknown' };
  }

  /**
   * Infer the surface type when the user did not declare one. Strong hip
   * translation across the frame means overground with a fixed camera; little
   * translation means treadmill OR a tracking camera — indistinguishable from
   * pose alone, so the label stays honest about that.
   */
  function inferSurfaceType(declared, direction) {
    if (declared === SURFACE.OVERGROUND || declared === SURFACE.TREADMILL) {
      return { surfaceType: declared, source: 'user_declared', confidence: 0.95 };
    }
    if (direction && direction.source === 'hip_translation') {
      return { surfaceType: SURFACE.OVERGROUND, source: 'inferred_translation', confidence: 0.7 };
    }
    return {
      surfaceType: SURFACE.UNKNOWN, source: 'indeterminate', confidence: 0.3,
      note: 'Low translation across frame: treadmill or tracking camera — cannot distinguish from pose alone.'
    };
  }

  // ── FPS-aware velocity windows (Phase 3 / 27) ──────────────────────────────
  //
  // Pre-contact velocity is read over a short window before touchdown. The
  // window must contain enough samples to mean anything, so it is chosen from
  // the effective sample rate rather than fixed. Below the floor the metric is
  // refused, not degraded silently.

  var VELOCITY_WINDOWS_MS = Object.freeze([40, 60, 80, 120]);
  var MIN_SAMPLES_IN_WINDOW = 2;
  var MIN_RATE_FOR_VELOCITY_HZ = 15;

  function velocityWindow(effectiveRateHz) {
    if (!isNum(effectiveRateHz) || effectiveRateHz < MIN_RATE_FOR_VELOCITY_HZ) {
      return { available: false, windowMs: null,
               reason: 'video_frame_rate_insufficient',
               minimumRateHz: MIN_RATE_FOR_VELOCITY_HZ };
    }
    var periodMs = 1000 / effectiveRateHz;
    for (var i = 0; i < VELOCITY_WINDOWS_MS.length; i++) {
      if (VELOCITY_WINDOWS_MS[i] >= periodMs * MIN_SAMPLES_IN_WINDOW) {
        return { available: true, windowMs: VELOCITY_WINDOWS_MS[i],
                 samplePeriodMs: periodMs, samplesInWindow: VELOCITY_WINDOWS_MS[i] / periodMs };
      }
    }
    return { available: false, windowMs: null, reason: 'video_frame_rate_insufficient',
             minimumRateHz: MIN_RATE_FOR_VELOCITY_HZ };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SCHEMA_HISTORY: SCHEMA_HISTORY,
    MODEL_VERSION: MODEL_VERSION,
    ANALYSIS_TYPE: ANALYSIS_TYPE,
    GRAVITY_MPS2: GRAVITY_MPS2,
    DISCLAIMER: DISCLAIMER,

    AVAILABILITY: AVAILABILITY,
    SPEED_SOURCE: SPEED_SOURCE,
    SURFACE: SURFACE,
    CALIBRATION_SOURCE: CALIBRATION_SOURCE,
    BRAKING_PATTERN: BRAKING_PATTERN,
    VERTICAL_PATTERN: VERTICAL_PATTERN,
    DOMAIN_RATING: DOMAIN_RATING,
    PGI_FLAG: PGI_FLAG,
    PGI_FLAG_LABEL: PGI_FLAG_LABEL,
    flagLabel: flagLabel,

    SMOOTHING_DEFAULTS: SMOOTHING_DEFAULTS,
    VELOCITY_WINDOWS_MS: VELOCITY_WINDOWS_MS,
    MIN_RATE_FOR_VELOCITY_HZ: MIN_RATE_FOR_VELOCITY_HZ,

    verticalTakeoffVelocityMps: verticalTakeoffVelocityMps,
    effectiveVerticalImpulsePerMass: effectiveVerticalImpulsePerMass,
    aerialRiseMeters: aerialRiseMeters,
    predictedFlightTimeSeconds: predictedFlightTimeSeconds,

    smoothSeries: smoothSeries,
    valueAtTime: valueAtTime,
    extremumInWindow: extremumInWindow,

    legLengthPx: legLengthPx,
    medianLegLengthPx: medianLegLengthPx,

    calibrationFromHeight: calibrationFromHeight,
    calibrationFromBallistic: calibrationFromBallistic,
    selectCalibration: selectCalibration,
    pxToMeters: pxToMeters,

    resolveSpeed: resolveSpeed,
    footGroundVelocity: footGroundVelocity,
    inferSurfaceType: inferSurfaceType,
    velocityWindow: velocityWindow,

    _internals: { isNum: isNum, clamp: clamp, median: median, round: round, kpAt: kpAt }
  };
});
