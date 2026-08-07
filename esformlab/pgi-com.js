// ─────────────────────────────────────────────────────────────────────────────
//  PGI — COM vertical trajectory, oscillation decomposition, rebound
//
//  Tracks the whole-body COM (Winter segmental estimate from kfo-core.js)
//  vertically through late swing → touchdown → stance → toe-off → flight, on a
//  SMOOTHED trajectory (local-polynomial / Savitzky–Golay-equivalent fit; raw
//  points retained alongside).
//
//  VERTICAL OSCILLATION IS DECOMPOSED, NEVER REPORTED ALONE (Phase 10):
//
//      stanceCompression  = COM_touchdown − COM_minimum          (drop under load)
//      stanceRebound      = COM_toeoff   − COM_minimum           (rise before leaving)
//      aerialRiseMeasured = COM_apex     − COM_toeoff            (rise in flight)
//      verticalOscillation = COM_max − COM_min over the step
//
//  Two runners can share a vertical oscillation value with entirely different
//  mechanics (deep stance collapse vs genuine aerial rise). No component is
//  labelled good or bad here; interpretation is combination-based and lives in
//  pgi-patterns.js.
//
//  COM VERTICAL VELOCITY (Phase 11) comes from the fitted first derivative,
//  never from raw frame-to-frame differences. Reported per step:
//  velocity at touchdown, most negative velocity, velocity at minimum height,
//  velocity at toe-off, maximum positive stance velocity, and
//
//      verticalVelocityReversal = v_toeoff − v_touchdown
//      verticalReversalRate     = reversal / GCT
//
//  — a KINEMATIC proxy for how rapidly downward COM motion is redirected. It is
//  not called a force anywhere.
//
//  FLIGHT-TIME CROSS-CHECK (Phase 12): ballistic flight predicts
//  tFlight ≈ 2·v_toeoff/g, so pose-derived toe-off velocity is checked against
//  the observed flight time. With an independent (user-height) calibration the
//  check is a genuine validation; the ballistic-implied calibration is by
//  construction NOT independent, and the result says so.
//
//  UNITS. Image +y is DOWN; this module works in an up-positive height
//  h = −y. All lengths are reported normalized to leg length ALWAYS, and in
//  metres/centimetres only when a spatial calibration exists (with its source).
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGICom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var PATH_POINTS = 25; // per-step normalized path resolution for the visualization

  // ── COM series ─────────────────────────────────────────────────────────────

  /**
   * Build the raw and smoothed COM height series (up-positive) plus the
   * horizontal series, from retained scan samples.
   */
  function buildComSeries(samples, smoothing) {
    var raw = [];
    (samples || []).forEach(function (s) {
      if (!s || !isNum(s.t) || !s.kps) return;
      var com = KFO.computeCOM(s.kps, 'segmental');
      if (!com) return;
      raw.push({ t: s.t, x: com.x, y: com.y, h: -com.y, massCoverage: com.massCoverage });
    });
    raw.sort(function (a, b) { return a.t - b.t; });
    var smoothH = PGI.smoothSeries(raw.map(function (p) { return { t: p.t, v: p.h }; }), smoothing);
    var smoothX = PGI.smoothSeries(raw.map(function (p) { return { t: p.t, v: p.x }; }), smoothing);
    return {
      raw: raw,
      smoothed: smoothH.points,          // {t, value:h, d1:vy(up+, px/s), d2}
      smoothedX: smoothX.points,         // {t, value:x, d1:vx(px/s), d2}
      filter: smoothH.filter,
      insufficient: !!smoothH.insufficient
    };
  }

  // ── Per-step extraction ────────────────────────────────────────────────────

  function heightAt(points, t) { return PGI.valueAtTime(points, t, 'value'); }
  function velocityAt(points, t) { return PGI.valueAtTime(points, t, 'd1'); }

  function analyzeStep(points, step, legLength) {
    var tTd = step.startTime;
    var tTo = step.startTime + step.contactSeconds;
    var tLand = tTo + step.flightSeconds; // opposite-foot touchdown

    var hTd = heightAt(points, tTd);
    var hTo = heightAt(points, tTo);
    if (!isNum(hTd) || !isNum(hTo)) return { valid: false, reason: 'com_coverage_incomplete' };

    var minStance = PGI.extremumInWindow(points, tTd, tTo, 'value', 'min');
    if (!minStance) return { valid: false, reason: 'no_stance_samples' };
    // Endpoints can undercut the interior samples on sparse stances.
    if (hTd < minStance.v) minStance = { t: tTd, v: hTd };
    if (hTo < minStance.v) minStance = { t: tTo, v: hTo };

    var apexFlight = PGI.extremumInWindow(points, tTo, tLand, 'value', 'max');
    var hLand = heightAt(points, tLand);
    if (!apexFlight || (isNum(hTo) && hTo > apexFlight.v)) apexFlight = { t: tTo, v: hTo };
    if (isNum(hLand) && hLand > (apexFlight ? apexFlight.v : -Infinity)) apexFlight = { t: tLand, v: hLand };

    var maxStep = PGI.extremumInWindow(points, tTd, tLand, 'value', 'max');
    var minStep = PGI.extremumInWindow(points, tTd, tLand, 'value', 'min');
    var hi = Math.max(apexFlight ? apexFlight.v : -Infinity, maxStep ? maxStep.v : -Infinity, hTd, hTo);
    var lo = Math.min(minStance.v, minStep ? minStep.v : Infinity, hTd, hTo);

    var vTd = velocityAt(points, tTd);
    var vTo = velocityAt(points, tTo);
    var vAtMin = velocityAt(points, minStance.t);
    var mostNeg = PGI.extremumInWindow(points, tTd, tTo, 'd1', 'min');
    var maxPos = PGI.extremumInWindow(points, tTd, tTo, 'd1', 'max');

    var reversal = (isNum(vTo) && isNum(vTd)) ? vTo - vTd : null;
    var gct = step.contactSeconds;

    // Normalized per-step COM path for the visualization: percent of step vs
    // height above the step minimum, in leg lengths.
    var path = [];
    if (isNum(legLength) && legLength > 0) {
      for (var i = 0; i < PATH_POINTS; i++) {
        var frac = i / (PATH_POINTS - 1);
        var t = tTd + (tLand - tTd) * frac;
        var h = heightAt(points, t);
        path.push({
          pct: Math.round(frac * 100),
          h: isNum(h) ? (h - lo) / legLength : null
        });
      }
    }

    return {
      valid: true,
      contactSide: step.contactSide,
      startTime: tTd,
      contactSeconds: step.contactSeconds,
      flightSeconds: step.flightSeconds,
      stepSeconds: step.stepSeconds,
      events: {
        touchdown: tTd,
        minimumHeight: minStance.t,
        toeoff: tTo,
        flightApex: apexFlight ? apexFlight.t : null,
        oppositeTouchdown: tLand
      },
      // Heights in px (up-positive), differences are what matter.
      heightsPx: {
        touchdown: hTd, minimum: minStance.v, toeoff: hTo,
        flightApex: apexFlight ? apexFlight.v : null,
        stepMax: hi, stepMin: lo
      },
      // The decomposition, px.
      stanceCompressionPx: hTd - minStance.v,
      stanceReboundPx: hTo - minStance.v,
      aerialRiseMeasuredPx: apexFlight ? apexFlight.v - hTo : null,
      verticalOscillationPx: hi - lo,
      // Velocities, px/s up-positive.
      velocityPxPerS: {
        touchdown: vTd,
        mostNegative: mostNeg ? mostNeg.v : null,
        atMinimumHeight: vAtMin,
        toeoff: vTo,
        maxPositiveStance: maxPos ? maxPos.v : null,
        reversal: reversal,
        reversalRatePerS: (isNum(reversal) && isNum(gct) && gct > 0) ? reversal / gct : null
      },
      path: path
    };
  }

  // ── Aggregation ────────────────────────────────────────────────────────────

  function agg(stepResults, fn, side) {
    var vals = [];
    stepResults.forEach(function (s) {
      if (!s.valid) return;
      if (side && s.contactSide !== side) return;
      var v = fn(s);
      if (isNum(v)) vals.push(v);
    });
    return KFO.aggregate(vals);
  }

  /** Length metric in three unit systems: px, leg lengths, metres (if calibrated). */
  function lengthViews(aggPx, legLength, calibration) {
    var norm = null, meters = null;
    if (aggPx && isNum(aggPx.median) && isNum(legLength) && legLength > 0) {
      norm = aggPx.median / legLength;
    }
    if (aggPx && isNum(aggPx.median)) {
      meters = PGI.pxToMeters(aggPx.median, calibration);
    }
    return {
      px: aggPx,
      medianLegLengths: norm,
      medianMeters: meters,
      medianCentimeters: isNum(meters) ? meters * 100 : null
    };
  }

  function decompositionBlock(stepResults, side, legLength, calibration) {
    return {
      side: side || 'overall',
      n: stepResults.filter(function (s) { return s.valid && (!side || s.contactSide === side); }).length,
      stanceCompression: lengthViews(agg(stepResults, function (s) { return s.stanceCompressionPx; }, side), legLength, calibration),
      stanceRebound: lengthViews(agg(stepResults, function (s) { return s.stanceReboundPx; }, side), legLength, calibration),
      aerialRiseMeasured: lengthViews(agg(stepResults, function (s) { return s.aerialRiseMeasuredPx; }, side), legLength, calibration),
      verticalOscillation: lengthViews(agg(stepResults, function (s) { return s.verticalOscillationPx; }, side), legLength, calibration)
    };
  }

  function velocityBlock(stepResults, side, legLength, calibration) {
    function velViews(a) {
      var norm = (a && isNum(a.median) && isNum(legLength) && legLength > 0) ? a.median / legLength : null;
      var mps = (a && isNum(a.median)) ? PGI.pxToMeters(a.median, calibration) : null;
      return { pxPerS: a, medianLegLengthsPerS: norm, medianMps: mps };
    }
    return {
      side: side || 'overall',
      touchdown: velViews(agg(stepResults, function (s) { return s.velocityPxPerS.touchdown; }, side)),
      mostNegative: velViews(agg(stepResults, function (s) { return s.velocityPxPerS.mostNegative; }, side)),
      atMinimumHeight: velViews(agg(stepResults, function (s) { return s.velocityPxPerS.atMinimumHeight; }, side)),
      toeoff: velViews(agg(stepResults, function (s) { return s.velocityPxPerS.toeoff; }, side)),
      maxPositiveStance: velViews(agg(stepResults, function (s) { return s.velocityPxPerS.maxPositiveStance; }, side)),
      reversal: velViews(agg(stepResults, function (s) { return s.velocityPxPerS.reversal; }, side)),
      // Reversal RATE is an acceleration-like quantity (px/s²). It is normalised
      // by leg length so it can be thresholded without a spatial calibration,
      // and converted to m/s² when one exists. It stays a kinematic descriptor:
      // it is never multiplied by a mass and never called a force.
      reversalRatePxPerS2: agg(stepResults, function (s) { return s.velocityPxPerS.reversalRatePerS; }, side),
      reversalRateLegLengthsPerS2: (isNum(legLength) && legLength > 0)
        ? agg(stepResults, function (s) {
            return isNum(s.velocityPxPerS.reversalRatePerS) ? s.velocityPxPerS.reversalRatePerS / legLength : null;
          }, side)
        : KFO.aggregate([]),
      reversalRateMps2: (calibration && isNum(calibration.pixelsPerMeter) && calibration.pixelsPerMeter > 0)
        ? agg(stepResults, function (s) {
            return isNum(s.velocityPxPerS.reversalRatePerS)
              ? s.velocityPxPerS.reversalRatePerS / calibration.pixelsPerMeter : null;
          }, side)
        : KFO.aggregate([]),
      note: 'Kinematic proxy for how rapidly downward COM motion is redirected upward. Not a force.'
    };
  }

  /** Mean normalized COM path across valid steps, for rendering. */
  function meanPath(stepResults) {
    var acc = [];
    for (var i = 0; i < PATH_POINTS; i++) acc.push({ sum: 0, n: 0 });
    stepResults.forEach(function (s) {
      if (!s.valid || !s.path || s.path.length !== PATH_POINTS) return;
      s.path.forEach(function (p, i) {
        if (isNum(p.h)) { acc[i].sum += p.h; acc[i].n++; }
      });
    });
    var out = [];
    for (var j = 0; j < PATH_POINTS; j++) {
      out.push({
        pct: Math.round(j / (PATH_POINTS - 1) * 100),
        h: acc[j].n ? acc[j].sum / acc[j].n : null
      });
    }
    return out.some(function (p) { return isNum(p.h); }) ? out : null;
  }

  // ── Flight-time cross-check (Phase 12) ─────────────────────────────────────

  function crossCheck(stepResults, calibration) {
    var pairs = stepResults.filter(function (s) {
      return s.valid && isNum(s.velocityPxPerS.toeoff) && isNum(s.flightSeconds);
    });
    if (!pairs.length) {
      return { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'no_usable_steps' };
    }
    if (!calibration || !isNum(calibration.pixelsPerMeter)) {
      return {
        availability: KFO.AVAILABILITY.UNAVAILABLE,
        reason: 'no_spatial_calibration',
        note: 'Predicted flight time needs pose velocity in m/s. The spread of the ballistic-' +
          'implied scale across steps stands in as the consistency signal.'
      };
    }
    var errors = [], relErrors = [];
    pairs.forEach(function (s) {
      var vMps = s.velocityPxPerS.toeoff / calibration.pixelsPerMeter;
      var predicted = PGI.predictedFlightTimeSeconds(Math.max(0, vMps));
      if (!isNum(predicted)) return;
      var err = s.flightSeconds - predicted;
      errors.push(err);
      if (s.flightSeconds > 0.02) relErrors.push(Math.abs(err) / s.flightSeconds);
    });
    if (!errors.length) {
      return { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'no_positive_takeoff_velocities' };
    }
    var errAgg = KFO.aggregate(errors);
    var medRel = KFO._internals.median(relErrors);
    var independent = calibration.source !== PGI.CALIBRATION_SOURCE.BALLISTIC_FLIGHT;
    // Confidence in the pose-derived COM velocity: 1 at 0% median error, 0 at ≥60%.
    var confidence = isNum(medRel) ? Math.max(0, Math.min(1, 1 - medRel / 0.6)) : null;
    return {
      availability: KFO.AVAILABILITY.AVAILABLE,
      n: errors.length,
      flightPredictionErrorSeconds: errAgg,
      medianRelativeError: medRel == null ? null : medRel,
      comVelocityConfidence: independent ? confidence : null,
      isIndependent: independent,
      calibrationSource: calibration.source,
      note: independent
        ? (isNum(medRel) && medRel > 0.35
            ? 'Large disagreement between pose-derived toe-off velocity and observed flight time — ' +
              'pose-derived vertical velocity may be noisy at this frame rate.'
            : 'Pose-derived toe-off velocity is broadly consistent with observed flight time.')
        : 'Calibration was itself implied from ballistic flight, so this check is not independent; ' +
          'the implied-scale spread across steps is the meaningful consistency signal.'
    };
  }

  // ── Top level ──────────────────────────────────────────────────────────────

  /**
   * @param {Object} input
   * @param {Array} input.samples             retained scan samples (t + kps)
   * @param {Array} input.steps               per-step records from pgi-timing
   * @param {number|null} input.legLengthPx
   * @param {Object|null} input.userHeightCalibration  candidate from PGI.calibrationFromHeight
   * @param {Object} [input.smoothing]
   */
  function analyze(input) {
    input = input || {};
    var steps = (input.steps || []).filter(function (s) {
      return s && isNum(s.startTime) && isNum(s.contactSeconds) && isNum(s.flightSeconds);
    });
    var series = buildComSeries(input.samples, input.smoothing);

    var out = {
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: null,
      filter: series.filter,
      rawPointCount: series.raw.length
    };
    if (series.insufficient || series.raw.length < 12) {
      out.reason = 'insufficient_com_trajectory';
      return out;
    }
    if (!steps.length) {
      out.reason = 'no_usable_steps';
      return out;
    }

    var legLength = isNum(input.legLengthPx) ? input.legLengthPx : null;
    var stepResults = steps.map(function (st) { return analyzeStep(series.smoothed, st, legLength); });
    var valid = stepResults.filter(function (s) { return s.valid; });
    if (!valid.length) {
      out.reason = 'com_coverage_incomplete';
      out.stepRejections = stepResults.filter(function (s) { return !s.valid; })
        .map(function (s) { return s.reason; });
      return out;
    }

    // Ballistic-implied calibration from these very steps, then selection
    // against the user-height candidate.
    var ballistic = PGI.calibrationFromBallistic(valid.map(function (s) {
      return { takeoffVelocityPxPerS: s.velocityPxPerS.toeoff, flightSeconds: s.flightSeconds };
    }));
    var calibration = PGI.selectCalibration([input.userHeightCalibration, ballistic]);

    out.availability = KFO.AVAILABILITY.AVAILABLE;
    out.stepsAnalyzed = valid.length;
    out.stepsRejected = stepResults.length - valid.length;
    out.legLengthPx = legLength;
    out.calibration = calibration;
    out.ballisticCalibration = ballistic;
    out.decomposition = {
      overall: decompositionBlock(stepResults, null, legLength, calibration),
      left: decompositionBlock(stepResults, 'left', legLength, calibration),
      right: decompositionBlock(stepResults, 'right', legLength, calibration),
      note: 'Stance compression, stance rebound and aerial rise are different mechanics that can ' +
        'produce the same total vertical oscillation. None is good or bad on its own.'
    };
    out.velocity = {
      overall: velocityBlock(stepResults, null, legLength, calibration),
      left: velocityBlock(stepResults, 'left', legLength, calibration),
      right: velocityBlock(stepResults, 'right', legLength, calibration)
    };
    out.flightCrossCheck = crossCheck(valid, calibration);
    out.meanPath = meanPath(valid);
    out.stepResults = stepResults;   // runtime/export only; not persisted
    // Raw + smoothed series retained at runtime for export and the overlay.
    out.series = { raw: series.raw, smoothed: series.smoothed, smoothedX: series.smoothedX };
    return out;
  }

  return {
    PATH_POINTS: PATH_POINTS,
    buildComSeries: buildComSeries,
    analyzeStep: analyzeStep,
    crossCheck: crossCheck,
    analyze: analyze
  };
});
