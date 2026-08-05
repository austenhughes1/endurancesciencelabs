// ─────────────────────────────────────────────────────────────────────────────
//  KFO — force estimators
//
//  A swappable estimator interface so a validated GRF model can replace the
//  geometry proxy without touching call sites:
//
//    estimator.method     -> one of KFO.METHOD
//    estimator.isValidated
//    estimator.estimate(input) -> { ok, method, angle?, forceMetrics?, ... }
//
//  Implemented : GeometryProxyEstimator, ComAccelerationEstimator (experimental)
//  Prepared for: LearnedGrfEstimator, ValidatedGrfEstimator (registered stubs
//                that refuse to run rather than silently returning nothing)
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var imp = isNode ? require('./kfo-impulse.js') : root.KFOImpulse;
  var api = factory(core, imp);
  if (isNode) module.exports = api;
  if (root) root.KFOEstimators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, KFOImpulse) {
  'use strict';

  var GRAVITY_MPS2 = 9.80665;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // ── Local polynomial (Savitzky–Golay) smoothing and derivatives ────────────
  //
  // Implemented as a local least-squares polynomial fit rather than fixed
  // coefficient tables, so it tolerates the slightly non-uniform timestamps that
  // come out of video seeking. At each point a degree-`polyOrder` polynomial is
  // fitted in local time u = t - t_i; then
  //     value = a0,  first derivative = a1,  second derivative = 2*a2.
  //
  // Double differentiation amplifies noise, which is exactly why nothing here is
  // user-facing: a ~25 Hz pixel-quantised COM trajectory differentiated twice is
  // noise-dominated even after smoothing. Filter parameters are explicit and
  // returned alongside the output so a reviewer can see what was applied.
  function solveNormalEquations(A, b) {
    var n = A.length, i, j, k;
    var M = A.map(function (row, r) { return row.concat([b[r]]); });
    for (i = 0; i < n; i++) {
      var piv = i;
      for (k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      if (Math.abs(M[piv][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;
      for (k = i + 1; k < n; k++) {
        var f = M[k][i] / M[i][i];
        for (j = i; j <= n; j++) M[k][j] -= f * M[i][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /**
   * @param {Array<{t:number,v:number}>} series
   * @param {{windowSize?:number, polyOrder?:number}} opts
   * @returns {{filter:Object, points:Array<{t:number,value:number,d1:number,d2:number}>}}
   */
  function localPolyDerivatives(series, opts) {
    opts = opts || {};
    var polyOrder = opts.polyOrder || 3;
    var win = opts.windowSize || 9;
    if (win % 2 === 0) win += 1;
    var half = Math.floor(win / 2);
    var pts = (series || []).filter(function (p) { return p && isNum(p.t) && isNum(p.v); })
                            .sort(function (a, b) { return a.t - b.t; });
    var out = [];
    var filterMeta = {
      type: 'local_polynomial_least_squares',
      equivalentTo: 'savitzky_golay',
      windowSize: win, polyOrder: polyOrder,
      note: 'Applied to raw COM trajectory before differentiation.'
    };
    if (pts.length < Math.max(win, polyOrder + 1)) {
      return { filter: filterMeta, points: [], insufficient: true };
    }

    for (var i = 0; i < pts.length; i++) {
      var lo = Math.max(0, i - half), hi = Math.min(pts.length - 1, i + half);
      var m = polyOrder + 1;
      var A = [], b = [];
      for (var r = 0; r < m; r++) { A.push(new Array(m).fill(0)); b.push(0); }
      for (var k = lo; k <= hi; k++) {
        var u = pts[k].t - pts[i].t;
        var powers = [];
        for (var p = 0; p < m; p++) powers.push(Math.pow(u, p));
        for (var rr = 0; rr < m; rr++) {
          for (var cc = 0; cc < m; cc++) A[rr][cc] += powers[rr] * powers[cc];
          b[rr] += powers[rr] * pts[k].v;
        }
      }
      var coef = solveNormalEquations(A, b);
      if (!coef) { out.push({ t: pts[i].t, value: pts[i].v, d1: null, d2: null }); continue; }
      out.push({
        t: pts[i].t,
        value: coef[0],
        d1: coef.length > 1 ? coef[1] : null,
        d2: coef.length > 2 ? 2 * coef[2] : null
      });
    }
    return { filter: filterMeta, points: out, insufficient: false };
  }

  // ── Geometry proxy estimator ───────────────────────────────────────────────
  var GeometryProxyEstimator = {
    method: KFO.METHOD.GEOMETRY_PROXY,
    isValidated: false,
    label: 'Geometry proxy (support-line orientation)',
    /**
     * @param {Object} input  see KFO.computeSupportLine
     */
    estimate: function (input) {
      var res = KFO.computeSupportLine(input);
      if (!res.ok) return { ok: false, method: this.method, reason: res.reason };
      return {
        ok: true,
        method: this.method,
        isValidated: false,
        angle: res.angle,
        com: res.com,
        supportPoint: res.supportPoint,
        legAxisAngleDegrees: res.legAxisAngleDegrees,
        comLegDivergenceDegrees: res.comLegDivergenceDegrees,
        poseConfidence: res.poseConfidence,
        forceMetrics: KFO.unavailableForceMetrics('geometry_proxy_has_no_force_magnitude')
      };
    }
  };

  // ── Experimental COM-acceleration estimator ────────────────────────────────
  //
  //   Fx = m * ax          Fz = m * (az + g)
  //
  // Two hard prerequisites that the current pipeline does not supply:
  //
  //   1. SCALE. Accelerations come out in px/s^2, but g is physical. Without a
  //      pixels-per-metre calibration even the force *angle* is undefined,
  //      because the angle depends on ax/(az+g) and g must be in the same units.
  //   2. MASS. Needed for absolute force. Body-weight-normalised output avoids
  //      this (Fz/BW = az/g + 1, Fx/BW = ax/g), so mass is optional.
  //
  // If calibration is absent the estimator returns `ok:false` with a specific
  // reason instead of guessing. Experimental, admin-only, never user-facing.
  var ComAccelerationEstimator = {
    method: KFO.METHOD.COM_ACCELERATION_EXPERIMENTAL,
    isValidated: false,
    label: 'COM acceleration (experimental, unvalidated)',

    /**
     * @param {Object} input
     * @param {Array<{t:number,kps:Object[]}>} input.samples  full clip samples
     * @param {{pixelsPerMeter:number, source:string}|null} input.calibration
     * @param {number|null} [input.bodyMassKg]
     * @param {{windowSize?:number,polyOrder?:number}} [input.filter]
     * @param {{startTime:number,endTime:number}} [input.stanceWindow]
     */
    estimate: function (input) {
      input = input || {};
      var samples = input.samples || [];
      var cal = input.calibration;

      var traj = [];
      samples.forEach(function (s) {
        if (!s || !isNum(s.t) || !s.kps) return;
        var com = KFO.computeCOM(s.kps, 'segmental');
        if (!com) return;
        traj.push({ t: s.t, x: com.x, y: com.y });
      });
      if (traj.length < 12) {
        return { ok: false, method: this.method, reason: 'insufficient_com_trajectory' };
      }

      var fx = localPolyDerivatives(traj.map(function (p) { return { t: p.t, v: p.x }; }), input.filter);
      var fy = localPolyDerivatives(traj.map(function (p) { return { t: p.t, v: p.y }; }), input.filter);
      if (fx.insufficient || fy.insufficient) {
        return { ok: false, method: this.method, reason: 'insufficient_samples_for_filter' };
      }

      // Raw and filtered trajectories are both retained for diagnostics.
      var diagnostics = {
        filter: fx.filter,
        rawTrajectory: traj,
        filteredTrajectory: fx.points.map(function (p, i) {
          return { t: p.t, x: p.value, y: fy.points[i] ? fy.points[i].value : null };
        })
      };

      if (!cal || !isNum(cal.pixelsPerMeter) || cal.pixelsPerMeter <= 0) {
        return {
          ok: false,
          method: this.method,
          reason: 'no_scale_calibration',
          explanation: 'Pixels-per-metre calibration is required: the force angle depends on ' +
            'ax/(az+g) and gravity is a physical quantity, so an uncalibrated pixel ' +
            'trajectory cannot produce either a magnitude or an angle.',
          diagnostics: diagnostics
        };
      }

      var ppm = cal.pixelsPerMeter;
      var series = [];
      for (var i = 0; i < fx.points.length; i++) {
        var axPx = fx.points[i].d2, ayPx = fy.points[i] ? fy.points[i].d2 : null;
        if (!isNum(axPx) || !isNum(ayPx)) continue;
        var ax = axPx / ppm;
        // Image y increases downward, so upward acceleration is the negative of ay.
        var az = -ayPx / ppm;
        var fzBw = (az + GRAVITY_MPS2) / GRAVITY_MPS2;
        var fxBw = ax / GRAVITY_MPS2;
        series.push({
          t: fx.points[i].t,
          axMps2: ax, azMps2: az,
          fxBodyWeights: fxBw, fzBodyWeights: fzBw,
          // Signed angle from vertical of the acceleration-derived resultant.
          angleFromVerticalDegrees: KFO._internals.toDeg(Math.atan2(fxBw, fzBw))
        });
      }
      if (!series.length) {
        return { ok: false, method: this.method, reason: 'no_valid_acceleration_samples', diagnostics: diagnostics };
      }

      // Legacy single-view metrics, unchanged, and still requiring a mass because
      // they are expressed in newton-seconds.
      var forceMetrics = KFO.unavailableForceMetrics('experimental_estimator_impulses_require_stance_window_and_mass');
      if (input.stanceWindow && isNum(input.bodyMassKg)) {
        var w = input.stanceWindow;
        var bwN = input.bodyMassKg * GRAVITY_MPS2;
        var stance = series.filter(function (p) { return p.t >= w.startTime && p.t <= w.endTime; })
                           .map(function (p) {
                             return { t: p.t, fx: p.fxBodyWeights * bwN, fz: p.fzBodyWeights * bwN };
                           });
        if (stance.length >= 3) forceMetrics = KFO.computeImpulseMetrics(stance, bwN);
      }

      // Impulse accounting. Body mass is NOT required here: the series is already
      // bodyweight-normalised (Fz/BW = az/g + 1, Fx/BW = ax/g), so integrating it
      // gives BW·s directly and the bodyweight reference is exactly 1. Only the
      // scale calibration is load-bearing, and that has already been checked
      // above.
      var impulseMetrics = this.impulseAccounting(series, input);

      return {
        ok: true,
        method: this.method,
        isValidated: false,
        isExperimental: true,
        calibration: { pixelsPerMeter: ppm, source: cal.source || 'provided' },
        gravityMps2: GRAVITY_MPS2,
        series: series,
        forceMetrics: forceMetrics,
        impulseMetrics: impulseMetrics,
        diagnostics: diagnostics,
        limitations: [
          'Experimental and unvalidated',
          'Double differentiation of a low-rate pixel trajectory is noise-dominated',
          'Scale calibration is an assumption unless independently measured',
          'Not to be shown as a consumer-facing force magnitude'
        ]
      };
    },

    /**
     * Integrate the impulse quantities over each supplied stance window, per side,
     * and aggregate. Every stance is integrated on its OWN timestamps rather than
     * on a resampled grid, because the sample spacing out of video seeking is not
     * uniform and resampling would move the stance boundaries that JvEffective is
     * most sensitive to.
     *
     * @param {Array} series  bodyweight-normalised force series from estimate()
     * @param {Object} input  {stanceWindows|stanceWindow, confidence, sampleRateHz}
     */
    impulseAccounting: function (series, input) {
      input = input || {};
      if (!KFOImpulse) {
        return { availability: 'unavailable', reason: 'impulse_module_not_loaded' };
      }
      var windows = input.stanceWindows ||
        (input.stanceWindow ? [input.stanceWindow] : null);
      if (!windows || !windows.length) {
        return KFOImpulse.unavailableImpulseMetrics(
          'no_stance_windows_supplied_to_experimental_estimator',
          { method: this.method });
      }

      var self = this;
      var perSideStances = { left: [], right: [] };
      var all = [];
      windows.forEach(function (w, i) {
        var pts = series.filter(function (p) { return p.t >= w.startTime && p.t <= w.endTime; })
                        .map(function (p) { return { t: p.t, fx: p.fxBodyWeights, fz: p.fzBodyWeights }; });
        var stance = KFOImpulse.integrateStance(pts, {
          bodyWeight: 1,
          normalizedToBodyWeight: true,
          unit: KFOImpulse.IMPULSE_UNIT.BW_SECONDS,
          method: self.method,
          side: w.side || null,
          strideIndex: isNum(w.strideIndex) ? w.strideIndex : i
        });
        all.push(stance);
        if (w.side === 'left' || w.side === 'right') perSideStances[w.side].push(stance);
      });

      var ctx = {
        method: this.method,
        confidence: input.confidence || null,
        confidenceScore: input.confidenceScore == null ? null : input.confidenceScore,
        gradeKnown: !!input.gradeKnown,
        speedKnown: !!input.speedKnown,
        sampleRateHz: input.sampleRateHz == null ? null : input.sampleRateHz,
        isForceMeasurementValidated: false
      };
      var combined = KFOImpulse.aggregateStances(all, ctx);
      var out = {
        availability: combined.availability,
        reason: combined.reason,
        method: this.method,
        isValidated: false,
        isExperimental: true,
        calculationVersion: KFOImpulse.CALCULATION_VERSION,
        unit: KFOImpulse.IMPULSE_UNIT.BW_SECONDS,
        normalizedToBodyWeight: true,
        bodyMassRequired: false,
        bodyMassNote: 'Impulses are bodyweight-normalised, so body mass is not needed. It is needed only ' +
          'to express them in newton-seconds.',
        perSide: {
          left: perSideStances.left.length ? KFOImpulse.aggregateStances(perSideStances.left, ctx) : null,
          right: perSideStances.right.length ? KFOImpulse.aggregateStances(perSideStances.right, ctx) : null
        },
        combined: combined,
        steadyStateConsistency: combined.steadyStateConsistency,
        impact: combined.impact,
        definitions: KFOImpulse.IMPULSE_DEFINITIONS,
        signConvention: KFOImpulse.SIGN_CONVENTION
      };
      out.momentumPreservation = KFOImpulse.momentumPreservation(combined, ctx);
      // Everything an admin needs to see WHERE each integral came from, so a wrong
      // number can be traced to a wrong region rather than argued about.
      out.diagnostics = {
        fxSeriesBw: series.map(function (p) { return { t: p.t, v: p.fxBodyWeights }; }),
        fzSeriesBw: series.map(function (p) { return { t: p.t, v: p.fzBodyWeights }; }),
        bodyWeightLineBw: 1,
        perStance: all.map(function (s) {
          return {
            side: s.side, strideIndex: s.strideIndex,
            availability: s.availability, reason: s.reason,
            stanceBoundaries: { startTime: s.stanceStartSeconds, endTime: s.stanceEndSeconds },
            regions: s.diagnostics ? s.diagnostics.integrationRegions : null,
            fxZeroCrossings: s.diagnostics ? s.diagnostics.fxZeroCrossings : null,
            JvTotal: s.JvTotal, JvEffective: s.JvEffective,
            JBrake: s.JBrake, JProp: s.JProp,
            shortcutDelta: s.diagnostics ? s.diagnostics.JvEffectiveShortcutDelta : null
          };
        }),
        note: 'Regions are the intervals contributing to each integral: braking where Fx < 0, ' +
          'propulsive where Fx > 0, aboveBodyWeight where Fz > 1 BW. The total vertical integral ' +
          'spans the whole stance; the effective vertical integral is the signed area relative to ' +
          'the bodyweight line, so the below-bodyweight regions subtract from it.'
      };
      return out;
    }
  };

  // Registered-but-refusing stubs. Better an explicit refusal than a silent no-op.
  function notImplementedEstimator(method, label, reason) {
    return {
      method: method, isValidated: method === KFO.METHOD.VALIDATED_GRF, label: label,
      isImplemented: false,
      estimate: function () { return { ok: false, method: method, reason: reason }; }
    };
  }
  var LearnedGrfEstimator = notImplementedEstimator(
    KFO.METHOD.LEARNED_GRF_EXPERIMENTAL, 'Learned GRF model (not implemented)',
    'learned_grf_estimator_not_implemented');
  var ValidatedGrfEstimator = notImplementedEstimator(
    KFO.METHOD.VALIDATED_GRF, 'Validated GRF model (not implemented)',
    'validated_grf_requires_force_plate_validation');

  var REGISTRY = {};
  REGISTRY[KFO.METHOD.GEOMETRY_PROXY] = GeometryProxyEstimator;
  REGISTRY[KFO.METHOD.COM_ACCELERATION_EXPERIMENTAL] = ComAccelerationEstimator;
  REGISTRY[KFO.METHOD.LEARNED_GRF_EXPERIMENTAL] = LearnedGrfEstimator;
  REGISTRY[KFO.METHOD.VALIDATED_GRF] = ValidatedGrfEstimator;

  function getEstimator(method) { return REGISTRY[method] || null; }

  /**
   * Derive a pixels-per-metre calibration from an assumed standing height and
   * the observed nose-to-ankle pixel extent. Returned with source marked as an
   * assumption so downstream output stays honest about it.
   */
  function calibrationFromAssumedHeight(kps, assumedHeightMeters) {
    if (!kps || !isNum(assumedHeightMeters) || assumedHeightMeters <= 0) return null;
    var nose = kps[0], lAn = kps[15], rAn = kps[16];
    var ankleY = null;
    if (lAn && rAn) ankleY = Math.max(lAn.y, rAn.y);
    else if (lAn) ankleY = lAn.y;
    else if (rAn) ankleY = rAn.y;
    if (!nose || ankleY == null) return null;
    var px = Math.abs(ankleY - nose.y);
    if (!(px > 10)) return null;
    // Nose-to-ankle spans roughly 0.87 of standing height.
    return {
      pixelsPerMeter: px / (assumedHeightMeters * 0.87),
      source: 'assumed_height',
      assumptions: ['Assumed standing height ' + assumedHeightMeters + ' m',
                    'Nose-to-ankle taken as 0.87 of standing height']
    };
  }

  return {
    GRAVITY_MPS2: GRAVITY_MPS2,
    localPolyDerivatives: localPolyDerivatives,
    GeometryProxyEstimator: GeometryProxyEstimator,
    ComAccelerationEstimator: ComAccelerationEstimator,
    LearnedGrfEstimator: LearnedGrfEstimator,
    ValidatedGrfEstimator: ValidatedGrfEstimator,
    getEstimator: getEstimator,
    calibrationFromAssumedHeight: calibrationFromAssumedHeight
  };
});
