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
//  MINIMUM COM (four-phase model). The lowest point of the smoothed COM
//  trajectory within stance is the kinematic landmark separating
//  loading/compression (touchdown → minimum COM) from rebound/projection
//  (minimum COM → toe-off). It is the REVERSAL POINT of vertical COM motion —
//  vertical COM velocity is approximately zero there. It is NOT the onset of
//  propulsive force: upward force is already being produced before the minimum
//  in order to decelerate the descending COM, and the fore-aft (braking →
//  propulsion) force reversal is a separate event this video-only system does
//  not observe. detectMinimumCom() below never takes the single raw-frame
//  minimum: it works on the smoothed trajectory, tolerates broad flat minima by
//  reporting a region and choosing its centre, and carries quality flags plus a
//  confidence instead of failing silently.
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

  // ── Minimum-COM detection (four-phase model) ───────────────────────────────

  function heightAt(points, t) { return PGI.valueAtTime(points, t, 'value'); }
  function velocityAt(points, t) { return PGI.valueAtTime(points, t, 'd1'); }

  var MIN_COM_CONFIG = Object.freeze({
    // Heights within this fraction of the stance excursion range of the global
    // minimum belong to the "flat" region around it.
    flatEpsilonFraction: 0.05,
    // A flat region wider than this share of stance means the minimum is a
    // REGION: its centre is reported and temporal certainty is reduced. The
    // bound sits above the width a parabolic (sharp) minimum shows at this
    // epsilon (2·√0.05 of the half-stance ≈ 22% of stance) so an ordinary
    // smooth minimum is never mislabelled flat.
    flatRegionStancePercent: 30,
    // A minimum this close to a stance edge is suspicious — it usually means an
    // event-detection or trajectory problem rather than a mid-stance minimum.
    nearEdgeStancePercent: 12,
    // |vy| at the detected minimum, as a fraction of the peak |vy| in stance,
    // above which the minimum and the velocity estimate disagree.
    velocityInconsistencyFraction: 0.35,
    // More d1 sign changes than this within stance marks the trajectory noisy
    // (one genuine down→up reversal is expected).
    maxVelocitySignChanges: 3,
    minSamplesInStance: 3
  });

  /**
   * Locate the minimum of the SMOOTHED COM height within one stance interval.
   *
   * Works in up-positive height (h = −imageY), so the visually lowest COM is
   * the numerical minimum regardless of the image coordinate system — that
   * normalization happened in buildComSeries, and every downstream consumer of
   * this result can reason in "positive = upward".
   *
   * Never the single raw-frame minimum: candidates are the smoothed samples
   * inside the stance plus the interpolated stance endpoints. A broad flat
   * minimum yields a region whose centre is chosen, with the region bounds
   * retained; local-extremum multiplicity, edge proximity, trajectory noise and
   * a non-zero vertical velocity at the minimum each flag the detection and
   * reduce its confidence rather than being hidden.
   *
   * @returns {{available:boolean, reason?:string, t?:number, heightPx?:number,
   *   stancePercent?:number, window?:{startPercent:number,endPercent:number}|null,
   *   flatWidthPercent?:number, localMinimaCount?:number, samplesInStance?:number,
   *   vyAtMinimumPxPerS?:number|null, flags?:string[], confidence?:number,
   *   detectionMethod?:string}}
   */
  function detectMinimumCom(points, tTd, tTo, opts) {
    var cfg = opts || MIN_COM_CONFIG;
    var F = PGI.MIN_COM_FLAG;
    var stanceDur = tTo - tTd;
    if (!(stanceDur > 0)) return { available: false, reason: 'invalid_stance_interval' };

    var inside = (points || []).filter(function (p) {
      return p && isNum(p.t) && p.t > tTd && p.t < tTo && isNum(p.value);
    });
    var hTd = heightAt(points, tTd);
    var hTo = heightAt(points, tTo);
    var cand = [];
    if (isNum(hTd)) cand.push({ t: tTd, value: hTd });
    inside.forEach(function (p) { cand.push({ t: p.t, value: p.value, d1: p.d1 }); });
    if (isNum(hTo)) cand.push({ t: tTo, value: hTo });
    if (cand.length < cfg.minSamplesInStance) {
      return { available: false, reason: 'no_stance_samples', samplesInStance: cand.length };
    }

    var vals = cand.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var range = hi - lo;
    var eps = Math.max(range * cfg.flatEpsilonFraction, 1e-9);
    var argmin = 0;
    cand.forEach(function (p, i) { if (p.value < cand[argmin].value) argmin = i; });

    // Flat region: the contiguous run around the global minimum whose heights
    // sit within eps of it.
    var runStart = argmin, runEnd = argmin;
    while (runStart > 0 && cand[runStart - 1].value <= lo + eps) runStart--;
    while (runEnd < cand.length - 1 && cand[runEnd + 1].value <= lo + eps) runEnd++;
    var flatWidthPct = (cand[runEnd].t - cand[runStart].t) / stanceDur * 100;
    var isFlat = flatWidthPct >= cfg.flatRegionStancePercent;

    var tMin, method;
    if (isFlat) {
      // The centre of the flat region is the most defensible single frame; the
      // region bounds are retained so nothing pretends to a sharper answer.
      var mid = (cand[runStart].t + cand[runEnd].t) / 2;
      var best = runStart;
      for (var i = runStart; i <= runEnd; i++) {
        if (Math.abs(cand[i].t - mid) < Math.abs(cand[best].t - mid)) best = i;
      }
      tMin = cand[best].t;
      method = 'smoothed_com_flat_region_center';
    } else {
      tMin = cand[argmin].t;
      method = 'smoothed_com_extremum';
    }

    // Local-minimum multiplicity among interior candidates, counting only dips
    // that come within 2·eps of the global minimum.
    var localMinima = 0;
    for (var j = 1; j < cand.length - 1; j++) {
      if (cand[j].value < cand[j - 1].value && cand[j].value <= cand[j + 1].value &&
          cand[j].value <= lo + 2 * eps) localMinima++;
    }
    if (localMinima === 0) localMinima = 1; // the global minimum itself

    // Trajectory noise: sign changes of the fitted vertical velocity in stance.
    var signChanges = 0, prevSign = 0;
    inside.forEach(function (p) {
      if (!isNum(p.d1) || p.d1 === 0) return;
      var s = p.d1 > 0 ? 1 : -1;
      if (prevSign !== 0 && s !== prevSign) signChanges++;
      prevSign = s;
    });

    var pct = (tMin - tTd) / stanceDur * 100;
    var vyMin = velocityAt(points, tMin);
    var absVys = inside.map(function (p) { return isNum(p.d1) ? Math.abs(p.d1) : null; }).filter(isNum);
    var peakAbsVy = absVys.length ? Math.max.apply(null, absVys) : null;

    var flags = [];
    var confidence = 0.9;
    if (cand.length < 5) confidence *= 0.75;
    if (isFlat) { flags.push(F.FLAT_REGION); confidence *= 0.8; }
    if (localMinima > 1) { flags.push(F.MULTIPLE_LOCAL_EXTREMA); confidence *= 0.8; }
    if (pct < cfg.nearEdgeStancePercent) { flags.push(F.NEAR_TOUCHDOWN); confidence *= 0.6; }
    if (pct > 100 - cfg.nearEdgeStancePercent) { flags.push(F.NEAR_TOEOFF); confidence *= 0.6; }
    if (signChanges > cfg.maxVelocitySignChanges) { flags.push(F.TRAJECTORY_NOISY); confidence *= 0.8; }
    if (isNum(vyMin) && isNum(peakAbsVy) && peakAbsVy > 0 &&
        Math.abs(vyMin) > cfg.velocityInconsistencyFraction * peakAbsVy) {
      flags.push(F.VELOCITY_INCONSISTENT); confidence *= 0.8;
    }
    if (confidence < 0.5) flags.push(F.LOW_CONFIDENCE);

    return {
      available: true,
      t: tMin,
      heightPx: heightAt(points, tMin),
      stancePercent: pct,
      window: isFlat ? {
        startPercent: (cand[runStart].t - tTd) / stanceDur * 100,
        endPercent: (cand[runEnd].t - tTd) / stanceDur * 100
      } : null,
      flatWidthPercent: flatWidthPct,
      localMinimaCount: localMinima,
      samplesInStance: cand.length,
      vyAtMinimumPxPerS: isNum(vyMin) ? vyMin : null,
      flags: flags,
      confidence: Math.max(0.05, Math.min(1, confidence)),
      detectionMethod: method
    };
  }

  // ── Per-step extraction ────────────────────────────────────────────────────

  /**
   * @param {Array} points     smoothed COM height series {t,value,d1}
   * @param {Object} step      {startTime, contactSeconds, flightSeconds, ...}
   * @param {number|null} legLength
   * @param {Array} [pointsX]  smoothed COM horizontal series {t,value,d1}
   * @param {number|null} [dirSign]  +1/−1 so horizontal travel is forward-positive
   */
  function analyzeStep(points, step, legLength, pointsX, dirSign, minComOverrideTime) {
    var tTd = step.startTime;
    var tTo = step.startTime + step.contactSeconds;
    var tLand = tTo + step.flightSeconds; // opposite-foot touchdown

    var hTd = heightAt(points, tTd);
    var hTo = heightAt(points, tTo);
    if (!isNum(hTd) || !isNum(hTo)) return { valid: false, reason: 'com_coverage_incomplete' };

    var minCom = detectMinimumCom(points, tTd, tTo);
    // A manually verified minimum-COM time replaces the detected one wholesale.
    // Confidence is 1 by definition of the workflow — a human looked at the
    // frame — and the detection flags no longer apply; but the AUTO detection is
    // retained alongside so the correction stays visible as a training signal.
    if (isNum(minComOverrideTime) && minComOverrideTime > tTd && minComOverrideTime < tTo) {
      var stanceDur = tTo - tTd;
      minCom = {
        available: true,
        t: minComOverrideTime,
        heightPx: heightAt(points, minComOverrideTime),
        stancePercent: (minComOverrideTime - tTd) / stanceDur * 100,
        window: null,
        flatWidthPercent: null,
        localMinimaCount: null,
        samplesInStance: minCom && minCom.samplesInStance || null,
        vyAtMinimumPxPerS: velocityAt(points, minComOverrideTime),
        flags: [],
        confidence: 1,
        detectionMethod: 'manual_verification',
        autoDetection: (minCom && minCom.available) ? {
          t: minCom.t, stancePercent: minCom.stancePercent,
          confidence: minCom.confidence, detectionMethod: minCom.detectionMethod
        } : null
      };
    }
    if (!minCom.available) return { valid: false, reason: minCom.reason };
    var minStance = { t: minCom.t, v: minCom.heightPx };

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

    // ── Loading/compression and rebound/projection phase kinematics ──
    // Horizontal COM positions, forward-positive when a direction is known.
    var dir = (isNum(dirSign) && dirSign !== 0) ? (dirSign > 0 ? 1 : -1) : null;
    function xAt(t) { return pointsX ? PGI.valueAtTime(pointsX, t, 'value') : null; }
    var xTd = xAt(tTd), xMin = xAt(minStance.t), xTo = xAt(tTo);
    function fwd(a, b) {
      return (isNum(a) && isNum(b) && dir !== null) ? (b - a) * dir : null;
    }

    var loadingDur = minStance.t - tTd;
    var reboundDur = tTo - minStance.t;
    var risePx = hTo - minStance.v;
    var loading = {
      durationSeconds: loadingDur,
      fractionOfStance: gct > 0 ? loadingDur / gct : null,
      compressionPx: hTd - minStance.v,
      horizontalTravelPx: fwd(xTd, xMin)
    };
    var reboundPhase = {
      durationSeconds: reboundDur,
      fractionOfStance: gct > 0 ? reboundDur / gct : null,
      risePx: risePx,
      horizontalTravelPx: fwd(xMin, xTo),
      // "Mean COM rise velocity during rebound" — a motion quantity, not a force.
      meanRiseVelocityPxPerS: reboundDur > 0 ? risePx / reboundDur : null,
      vyAtMinimumPxPerS: minCom.vyAtMinimumPxPerS,
      vyAtToeoffPxPerS: isNum(vTo) ? vTo : null,
      // vy at the minimum should be ~0, so this is essentially the upward
      // velocity created between the reversal point and toe-off.
      velocityGainPxPerS: (isNum(vTo) && isNum(minCom.vyAtMinimumPxPerS))
        ? vTo - minCom.vyAtMinimumPxPerS : null,
      meanVerticalAccelerationProxyPxPerS2:
        (reboundDur > 0 && isNum(vTo) && isNum(minCom.vyAtMinimumPxPerS))
          ? (vTo - minCom.vyAtMinimumPxPerS) / reboundDur : null,
      compressionToReboundRatio: reboundDur > 0 ? loadingDur / reboundDur : null
    };

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
      // Minimum-COM detection detail and the two stance phases it separates.
      minimumCom: minCom,
      loading: loading,
      reboundPhase: reboundPhase,
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

  /** Aggregate the per-step minimum-COM detections for one side (or overall). */
  function minimumComBlock(stepResults, side) {
    var dets = stepResults.filter(function (s) {
      return s.valid && s.minimumCom && s.minimumCom.available &&
             (!side || s.contactSide === side);
    }).map(function (s) { return s.minimumCom; });
    var flagCounts = {};
    dets.forEach(function (d) {
      (d.flags || []).forEach(function (f) { flagCounts[f] = (flagCounts[f] || 0) + 1; });
    });
    return {
      side: side || 'overall',
      n: dets.length,
      stancePercent: KFO.aggregate(dets.map(function (d) { return d.stancePercent; })),
      confidence: KFO.aggregate(dets.map(function (d) { return d.confidence; })),
      flatWidthPercent: KFO.aggregate(dets.map(function (d) { return d.flatWidthPercent; })),
      flagCounts: flagCounts,
      detectionMethod: dets.length && dets.every(function (d) {
        return d.detectionMethod === dets[0].detectionMethod;
      }) ? dets[0].detectionMethod : (dets.length ? 'mixed' : null)
    };
  }

  /**
   * @param {Object} input
   * @param {Array} input.samples             retained scan samples (t + kps)
   * @param {Array} input.steps               per-step records from pgi-timing
   * @param {number|null} input.legLengthPx
   * @param {Object|null} input.userHeightCalibration  candidate from PGI.calibrationFromHeight
   * @param {number|null} [input.directionSign]  +1/−1 for forward-positive travel
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
    var dirSign = (isNum(input.directionSign) && input.directionSign !== 0)
      ? (input.directionSign > 0 ? 1 : -1) : null;
    // Manual minimum-COM corrections, matched to their step by side + the AUTO
    // touchdown time (which is how the verification UI identifies a stance).
    var minComOv = input.minComOverrides || [];
    function overrideFor(st) {
      var best = null;
      minComOv.forEach(function (o) {
        if (!o || o.side !== st.contactSide || !isNum(o.autoStartTime) || !isNum(o.time)) return;
        if (Math.abs(o.autoStartTime - st.startTime) <= 0.08 &&
            (!best || Math.abs(o.autoStartTime - st.startTime) <
                      Math.abs(best.autoStartTime - st.startTime))) best = o;
      });
      return best ? best.time : null;
    }
    var stepResults = steps.map(function (st) {
      return analyzeStep(series.smoothed, st, legLength, series.smoothedX, dirSign, overrideFor(st));
    });
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
    out.minimumCom = {
      overall: minimumComBlock(stepResults, null),
      left: minimumComBlock(stepResults, 'left'),
      right: minimumComBlock(stepResults, 'right'),
      note: 'Minimum COM is the kinematic reversal point of vertical COM motion — vertical COM ' +
        'velocity is approximately zero there. It is not the onset of propulsive force: upward ' +
        'force is already produced before it to decelerate the descending COM.'
    };
    // Reliability gate: strong loading/rebound interpretation is withheld when
    // the minimum cannot be reliably located on most steps.
    var medConf = out.minimumCom.overall.confidence;
    out.minimumComReliability = {
      medianConfidence: (medConf && isNum(medConf.median)) ? medConf.median : null,
      unreliable: !(medConf && isNum(medConf.median)) || medConf.median < 0.5
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
    MIN_COM_CONFIG: MIN_COM_CONFIG,
    buildComSeries: buildComSeries,
    detectMinimumCom: detectMinimumCom,
    analyzeStep: analyzeStep,
    crossCheck: crossCheck,
    analyze: analyze
  };
});
