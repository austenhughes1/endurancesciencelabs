// ─────────────────────────────────────────────────────────────────────────────
//  PGI — stride outcome and arm carriage
//
//  STRIDE OUTCOME (Phase 15). What the projection and ground interaction
//  actually produced: step length, stride length, and how much of the resulting
//  distance came from the aerial phase versus from stance.
//
//      stepLength     = speed · stepTime            (when speed is known)
//      strideLength   = speed · strideTime          (two consecutive steps)
//      flightDistance = speed · flightTime
//      stanceDistance = speed · contactTime
//
//  A second, independent route exists on calibrated OVERGROUND clips: the
//  forward translation of the COM between consecutive touchdowns. Both are
//  reported with their method when both are available, because agreement
//  between them is the best available check on either.
//
//  LONGER IS NOT AUTOMATICALLY BETTER, and stride length cannot be judged
//  without speed. Where a judgement would require a reference distribution that
//  does not exist, this module reports the dimensionless descriptors (step
//  length in leg lengths, Froude number) and states that no validated reference
//  is loaded — it does not band against invented numbers.
//
//  ARM CARRIAGE (Phase 16). Descriptive whole-body rhythm and angular-momentum
//  descriptors only. Arms do not generate vertical ground-reaction force and
//  nothing here says they do. In a sagittal view the far-side arm is frequently
//  occluded, so every arm metric carries its own landmark confidence and
//  degrades to null rather than to a confident wrong number. Metrics that a
//  side view genuinely cannot support (hand-to-midline distance) are present in
//  the schema and permanently null with a stated reason.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGIOutcome = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function median(a) { return KFO._internals.median(a); }

  var METHOD = Object.freeze({
    SPEED_X_TIME: 'speed_times_step_time',
    COM_TRANSLATION: 'com_translation_between_touchdowns',
    UNAVAILABLE: 'unavailable'
  });

  // ── Stride outcome ─────────────────────────────────────────────────────────

  /**
   * Step length from COM forward translation between consecutive touchdowns.
   * Overground + calibrated only: on a treadmill the COM does not translate, so
   * this route would return ~0 and must never be attempted there.
   */
  function stepLengthsFromTranslation(comSeriesX, steps, calibration, surfaceType) {
    if (surfaceType !== PGI.SURFACE.OVERGROUND) {
      return { available: false, reason: 'com_translation_requires_overground' };
    }
    if (!calibration || !isNum(calibration.pixelsPerMeter) || calibration.pixelsPerMeter <= 0) {
      return { available: false, reason: 'no_spatial_calibration' };
    }
    if (!comSeriesX || !comSeriesX.length) {
      return { available: false, reason: 'no_com_trajectory' };
    }
    var vals = [];
    (steps || []).forEach(function (s) {
      var t0 = s.startTime;
      var t1 = s.startTime + s.stepSeconds;
      var x0 = PGI.valueAtTime(comSeriesX, t0, 'value');
      var x1 = PGI.valueAtTime(comSeriesX, t1, 'value');
      if (!isNum(x0) || !isNum(x1)) return;
      var m = PGI.pxToMeters(Math.abs(x1 - x0), calibration);
      if (isNum(m) && m > 0.2 && m < 3.0) vals.push(m);
    });
    if (vals.length < 3) return { available: false, reason: 'insufficient_translation_samples' };
    return { available: true, aggregate: KFO.aggregate(vals), n: vals.length };
  }

  /**
   * @param {Object} input
   * @param {Object} input.timing        pgi-timing result
   * @param {Object} input.com           pgi-com result
   * @param {Object} input.speedContext  {speedMps, speedSource, speedConfidence}
   * @param {Object|null} input.calibration
   * @param {string} input.surfaceType
   * @param {number|null} [input.userHeightMeters]
   * @param {number|null} [input.legLengthPx]
   */
  function analyzeStrideOutcome(input) {
    input = input || {};
    var timing = input.timing || {};
    var speed = input.speedContext || {};
    var cal = input.calibration;
    var steps = timing.steps || [];

    var out = {
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: null,
      method: METHOD.UNAVAILABLE,
      speedMps: isNum(speed.speedMps) ? speed.speedMps : null,
      speedSource: speed.speedSource || PGI.SPEED_SOURCE.UNKNOWN,
      speedConfidence: isNum(speed.speedConfidence) ? speed.speedConfidence : null,
      cadenceSpm: (timing.timing && timing.timing.overall) ? timing.timing.overall.cadenceSpm : null,
      contactSeconds: (timing.timing && timing.timing.overall) ? timing.timing.overall.contactSeconds : null,
      flightSeconds: (timing.timing && timing.timing.overall) ? timing.timing.overall.flightSeconds : null
    };

    if (!steps.length) {
      out.reason = 'no_usable_steps';
      return out;
    }

    // Route 1: speed × time. Robust, needs no calibration.
    var byTime = null;
    if (isNum(speed.speedMps) && speed.speedMps > 0) {
      var v = speed.speedMps;
      byTime = {
        stepLengthMeters: KFO.aggregate(steps.map(function (s) { return v * s.stepSeconds; })),
        strideLengthMeters: KFO.aggregate(steps.map(function (s) { return v * s.stepSeconds * 2; })),
        flightDistanceMeters: KFO.aggregate(steps.map(function (s) { return v * s.flightSeconds; })),
        stanceDistanceMeters: KFO.aggregate(steps.map(function (s) { return v * s.contactSeconds; }))
      };
    }

    // Route 2: COM translation. Independent of the speed input, so where both
    // exist their agreement is a genuine cross-check.
    var byTranslation = stepLengthsFromTranslation(
      input.com && input.com.series ? input.com.series.smoothedX : null,
      steps, cal, input.surfaceType);

    if (!byTime && !byTranslation.available) {
      out.reason = isNum(speed.speedMps) ? 'stride_length_unavailable' : 'speed_unknown';
      out.note = 'Step and stride length need either a running speed or a calibrated overground clip.';
      return out;
    }

    out.availability = KFO.AVAILABILITY.AVAILABLE;
    out.method = byTime ? METHOD.SPEED_X_TIME : METHOD.COM_TRANSLATION;

    var primary = byTime || {
      stepLengthMeters: byTranslation.aggregate,
      strideLengthMeters: KFO.aggregate((byTranslation.aggregate.n ? [] : [])),
      flightDistanceMeters: KFO.aggregate([]),
      stanceDistanceMeters: KFO.aggregate([])
    };
    out.stepLengthMeters = primary.stepLengthMeters;
    out.strideLengthMeters = primary.strideLengthMeters;
    out.flightDistanceMeters = primary.flightDistanceMeters;
    out.stanceDistanceMeters = primary.stanceDistanceMeters;

    // Share of each step's distance produced during flight rather than stance.
    // This is a TIMING ratio (flight fraction) expressed as distance, so it is
    // available whenever the timing is, even without speed.
    if (timing.timing && timing.timing.overall && timing.timing.overall.flightFraction) {
      out.flightDistanceShare = timing.timing.overall.flightFraction.median;
      out.distanceShareNote = 'At constant horizontal speed the share of step distance covered in ' +
        'flight equals the flight fraction of step time.';
    }

    out.crossCheck = { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'only_one_method_available' };
    if (byTime && byTranslation.available) {
      var a = byTime.stepLengthMeters.median, b = byTranslation.aggregate.median;
      out.crossCheck = {
        availability: KFO.AVAILABILITY.AVAILABLE,
        speedTimesTimeMeters: a,
        comTranslationMeters: b,
        differenceMeters: (isNum(a) && isNum(b)) ? a - b : null,
        relativeDifference: (isNum(a) && isNum(b) && a > 0) ? Math.abs(a - b) / a : null,
        note: 'Two independent routes to step length. A large disagreement points at the speed input, ' +
          'the spatial calibration, or the event timing.'
      };
      out.stepLengthByTranslationMeters = byTranslation.aggregate;
    } else if (byTranslation.available) {
      out.stepLengthByTranslationMeters = byTranslation.aggregate;
    } else {
      out.translationUnavailableReason = byTranslation.reason;
    }

    // ── Dimensionless descriptors ──
    var stepMed = out.stepLengthMeters && isNum(out.stepLengthMeters.median)
      ? out.stepLengthMeters.median : null;
    var legMeters = (isNum(input.legLengthPx) && cal && isNum(cal.pixelsPerMeter))
      ? PGI.pxToMeters(input.legLengthPx, cal) : null;
    out.normalized = {
      legLengthMeters: legMeters,
      stepLengthPerLegLength: (isNum(stepMed) && isNum(legMeters) && legMeters > 0)
        ? stepMed / legMeters : null,
      stepLengthPerHeight: (isNum(stepMed) && isNum(input.userHeightMeters) && input.userHeightMeters > 0)
        ? stepMed / input.userHeightMeters : null,
      // Froude number: the standard dimensionless speed for gait comparison.
      froudeNumber: (isNum(speed.speedMps) && isNum(legMeters) && legMeters > 0)
        ? (speed.speedMps * speed.speedMps) / (PGI.GRAVITY_MPS2 * legMeters) : null
    };

    // ── Interpretation gate ──
    // Judging a stride "short" or "long" needs a speed-matched reference
    // distribution. None is loaded, and substituting a plausible number would
    // manufacture a provenance that does not exist.
    out.interpretation = {
      rating: 'unknown',
      speedKnown: isNum(speed.speedMps),
      reason: isNum(speed.speedMps)
        ? 'no_speed_matched_reference_distribution_loaded'
        : 'speed_unknown',
      note: isNum(speed.speedMps)
        ? 'Stride length is reported with the speed it was produced at. No speed-matched reference ' +
          'distribution is loaded, so it is not banded as short or long. Within-runner comparison ' +
          'at matched speed is the meaningful use.'
        : 'Running speed is unavailable, so stride length cannot be interpreted as short or long — ' +
          'the same stride length means different things at different speeds.'
    };
    return out;
  }

  // ── Arm carriage ───────────────────────────────────────────────────────────

  var ARM_LANDMARKS = { left: { shoulder: 5, elbow: 7, wrist: 9 },
                        right: { shoulder: 6, elbow: 8, wrist: 10 } };

  function angleAt(a, b, c) {
    if (!a || !b || !c) return null;
    var v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    var d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!(d > 0)) return null;
    var cos = (v1x * v2x + v1y * v2y) / d;
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }

  /**
   * Pearson correlation of two equal-length series with one shifted by `lag`
   * samples. Used to locate the arm/leg phase relationship.
   */
  function correlationAtLag(a, b, lag) {
    var xs = [], ys = [];
    for (var i = 0; i < a.length; i++) {
      var j = i + lag;
      if (j < 0 || j >= b.length) continue;
      if (!isNum(a[i]) || !isNum(b[j])) continue;
      xs.push(a[i]); ys.push(b[j]);
    }
    if (xs.length < 6) return null;
    var n = xs.length;
    var mx = xs.reduce(function (p, q) { return p + q; }, 0) / n;
    var my = ys.reduce(function (p, q) { return p + q; }, 0) / n;
    var num = 0, dx = 0, dy = 0;
    for (var k = 0; k < n; k++) {
      var ax = xs[k] - mx, by = ys[k] - my;
      num += ax * by; dx += ax * ax; dy += by * by;
    }
    return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
  }

  /**
   * @param {Object} input
   * @param {Array} input.samples
   * @param {number} input.directionSign
   * @param {number|null} input.legLengthPx
   * @param {number|null} [input.strideSeconds]  for the phase relationship
   */
  function analyzeArmCarriage(input) {
    input = input || {};
    var dirSign = isNum(input.directionSign) && input.directionSign !== 0
      ? (input.directionSign > 0 ? 1 : -1) : null;
    var out = {
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: null,
      isForceClaim: false,
      note: 'Descriptive whole-body rhythm and angular-momentum descriptors. Arm motion is not ' +
        'claimed to generate vertical ground-reaction force.',
      left: null, right: null, asymmetry: null,
      handToMidlineDistance: {
        availability: KFO.AVAILABILITY.UNAVAILABLE,
        reason: 'requires_frontal_view',
        note: 'Hand-to-midline distance is a frontal-plane quantity and cannot be measured from a ' +
          'sagittal clip.'
      }
    };
    if (dirSign === null) { out.reason = 'unknown_running_direction'; return out; }
    var samples = (input.samples || []).filter(function (s) { return s && isNum(s.t) && s.kps; });
    if (samples.length < 12) { out.reason = 'insufficient_samples'; return out; }

    var leg = isNum(input.legLengthPx) && input.legLengthPx > 0 ? input.legLengthPx : null;
    var series = { left: [], right: [] };
    var ankleSeries = { left: [], right: [] };

    samples.forEach(function (s) {
      ['left', 'right'].forEach(function (side) {
        var L = ARM_LANDMARKS[side];
        var sh = PGI._internals.kpAt(s.kps, L.shoulder);
        var el = PGI._internals.kpAt(s.kps, L.elbow);
        var wr = PGI._internals.kpAt(s.kps, L.wrist);
        var hipMidX = null;
        var lHip = PGI._internals.kpAt(s.kps, 11), rHip = PGI._internals.kpAt(s.kps, 12);
        if (lHip && rHip) hipMidX = (lHip.x + rHip.x) / 2;
        if (sh && el && wr) {
          series[side].push({
            t: s.t,
            elbowAngle: angleAt(sh, el, wr),
            // Wrist position along the direction of travel, relative to the
            // shoulder: + is anterior (in front of the body), − posterior.
            wristForwardOffset: (wr.x - sh.x) * dirSign,
            wristHeightRelShoulder: -(wr.y - sh.y),      // + = wrist above shoulder
            wristRelHip: hipMidX == null ? null : (wr.x - hipMidX) * dirSign,
            // Upper-arm orientation from vertical: + = elbow ahead of shoulder.
            shoulderAngleFromVertical: Math.atan2((el.x - sh.x) * dirSign, el.y - sh.y) * 180 / Math.PI,
            confidence: ((sh.score || 0) + (el.score || 0) + (wr.score || 0)) / 3
          });
        }
        var ank = PGI._internals.kpAt(s.kps, side === 'left' ? 15 : 16);
        if (ank && hipMidX != null) {
          ankleSeries[side].push({ t: s.t, v: (ank.x - hipMidX) * dirSign });
        }
      });
    });

    function sideBlock(side) {
      var rows = series[side];
      // A sagittal clip usually resolves the near arm well and the far arm
      // poorly. Below a third of the clip, no arm result is offered at all.
      if (rows.length < Math.max(8, samples.length * 0.33)) {
        return {
          side: side, availability: KFO.AVAILABILITY.UNAVAILABLE,
          reason: 'arm_landmarks_occluded',
          framesResolved: rows.length, framesExamined: samples.length
        };
      }
      var conf = median(rows.map(function (r) { return r.confidence; }));
      var fwd = rows.map(function (r) { return r.wristForwardOffset; }).filter(isNum);
      var shAng = rows.map(function (r) { return r.shoulderAngleFromVertical; }).filter(isNum);
      var maxAnterior = fwd.length ? Math.max.apply(null, fwd) : null;
      var maxPosterior = fwd.length ? Math.min.apply(null, fwd) : null;
      return {
        side: side,
        availability: KFO.AVAILABILITY.AVAILABLE,
        framesResolved: rows.length,
        framesExamined: samples.length,
        landmarkConfidence: conf,
        elbowAngleDegrees: KFO.aggregate(rows.map(function (r) { return r.elbowAngle; })),
        maxAnteriorWristExcursionLegLengths: (isNum(maxAnterior) && leg) ? maxAnterior / leg : null,
        maxPosteriorWristExcursionLegLengths: (isNum(maxPosterior) && leg) ? maxPosterior / leg : null,
        wristExcursionRangeLegLengths: (isNum(maxAnterior) && isNum(maxPosterior) && leg)
          ? (maxAnterior - maxPosterior) / leg : null,
        wristHeightRelShoulderLegLengths: leg
          ? KFO.aggregate(rows.map(function (r) {
              return isNum(r.wristHeightRelShoulder) ? r.wristHeightRelShoulder / leg : null; }))
          : KFO.aggregate([]),
        wristRelHipLegLengths: leg
          ? KFO.aggregate(rows.map(function (r) {
              return isNum(r.wristRelHip) ? r.wristRelHip / leg : null; }))
          : KFO.aggregate([]),
        shoulderAngleFromVerticalDegrees: KFO.aggregate(shAng),
        totalArmAngularExcursionDegrees: shAng.length
          ? Math.max.apply(null, shAng) - Math.min.apply(null, shAng) : null
      };
    }

    out.left = sideBlock('left');
    out.right = sideBlock('right');
    var anyArm = out.left.availability === KFO.AVAILABILITY.AVAILABLE ||
                 out.right.availability === KFO.AVAILABILITY.AVAILABLE;
    if (!anyArm) { out.reason = 'arm_landmarks_occluded'; return out; }
    out.availability = KFO.AVAILABILITY.AVAILABLE;

    // ── Arm–leg phase relationship ──
    // Contralateral coupling: the arm swings with the opposite leg. Correlating
    // wrist forward offset against the CONTRALATERAL ankle offset should peak
    // near zero lag in typical running.
    out.armLegPhase = {};
    ['left', 'right'].forEach(function (side) {
      var opposite = side === 'left' ? 'right' : 'left';
      var arm = series[side], leg2 = ankleSeries[opposite];
      if (out[side].availability !== KFO.AVAILABILITY.AVAILABLE ||
          arm.length < 12 || leg2.length < 12) {
        out.armLegPhase[side] = { availability: KFO.AVAILABILITY.UNAVAILABLE,
                                  reason: 'insufficient_paired_samples' };
        return;
      }
      // Resample both onto the arm timestamps so lags are in whole samples.
      var a = arm.map(function (r) { return r.wristForwardOffset; });
      var b = arm.map(function (r) { return PGI.valueAtTime(leg2.map(function (p) {
        return { t: p.t, value: p.v }; }), r.t, 'value'); });
      var best = null;
      var maxLag = Math.min(8, Math.floor(arm.length / 3));
      for (var lag = -maxLag; lag <= maxLag; lag++) {
        var c = correlationAtLag(a, b, lag);
        if (c == null) continue;
        if (!best || Math.abs(c) > Math.abs(best.correlation)) best = { lag: lag, correlation: c };
      }
      if (!best) {
        out.armLegPhase[side] = { availability: KFO.AVAILABILITY.UNAVAILABLE,
                                  reason: 'no_usable_correlation' };
        return;
      }
      var dt = arm.length > 1 ? (arm[arm.length - 1].t - arm[0].t) / (arm.length - 1) : null;
      var lagSeconds = isNum(dt) ? best.lag * dt : null;
      out.armLegPhase[side] = {
        availability: KFO.AVAILABILITY.AVAILABLE,
        pairedWith: opposite + '_leg',
        bestLagSamples: best.lag,
        bestLagSeconds: lagSeconds,
        lagFractionOfStride: (isNum(lagSeconds) && isNum(input.strideSeconds) && input.strideSeconds > 0)
          ? lagSeconds / input.strideSeconds : null,
        correlationAtBestLag: best.correlation,
        note: 'Contralateral coupling: a correlation near +1 at close to zero lag is the ordinary ' +
          'running pattern. This describes coordination timing, not force production.'
      };
    });

    // ── Left/right asymmetry ──
    if (out.left.availability === KFO.AVAILABILITY.AVAILABLE &&
        out.right.availability === KFO.AVAILABILITY.AVAILABLE) {
      var le = out.left.elbowAngleDegrees, re = out.right.elbowAngleDegrees;
      out.asymmetry = {
        available: true,
        elbowAngleDifferenceDegrees: (isNum(le.median) && isNum(re.median)) ? le.median - re.median : null,
        wristExcursionRangeDifferenceLegLengths:
          (isNum(out.left.wristExcursionRangeLegLengths) && isNum(out.right.wristExcursionRangeLegLengths))
            ? out.left.wristExcursionRangeLegLengths - out.right.wristExcursionRangeLegLengths : null,
        confidenceCaveat: 'In a sagittal view the far-side arm is partly occluded, so a side-to-side ' +
          'arm difference may reflect visibility rather than mechanics.',
        nearSideConfidence: { left: out.left.landmarkConfidence, right: out.right.landmarkConfidence }
      };
    } else {
      out.asymmetry = { available: false, reason: 'both_arms_required' };
    }
    return out;
  }

  return {
    METHOD: METHOD,
    stepLengthsFromTranslation: stepLengthsFromTranslation,
    analyzeStrideOutcome: analyzeStrideOutcome,
    analyzeArmCarriage: analyzeArmCarriage,
    _internals: { angleAt: angleAt, correlationAtLag: correlationAtLag }
  };
});
