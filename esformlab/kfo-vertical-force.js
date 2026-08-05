// ─────────────────────────────────────────────────────────────────────────────
//  KFO — vertical force magnitude from stance/flight timing
//
//  WHY THIS EXISTS. The support-line angle says which way the support line points
//  but nothing about how hard the runner pushes. And the vertical:horizontal
//  RATIO is a poor individual metric: Clark et al. measured 5.86:1 at 5 m/s and
//  5.85:1 at each athlete's top speed — ~5.2% change across a runner's entire
//  speed range. Near-invariant quantities cannot discriminate athletes. What does
//  vary is force MAGNITUDE (Dorn: peak vertical 2.71 -> 3.58 BW with speed;
//  Weyand: 1.26x greater support force in faster runners).
//
//  THE PHYSICS. Over one complete step at steady state, vertical momentum change
//  is zero, so the vertical impulse must support bodyweight for the whole step:
//
//      integral(Fz dt) over contact = m*g*T_step
//      mean Fz / bodyweight = T_step / t_contact = 1 / dutyFactor      [EXACT]
//
//  The first relation is not a model — it follows from steady-state running. A
//  half-sine waveform approximation then gives the peak:
//
//      peak Fz / bodyweight ~= (pi/2) / dutyFactor                     [APPROX]
//
//  which is the spring-mass flight-time method (Morin et al. 2005; refined by
//  Patoz et al. 2023). It needs only TIMING — no scale calibration, no body mass,
//  no COM tracking. That is what makes it viable on video when the
//  COM-acceleration route is not.
//
//  Validated in kfo-tests.js against Dorn et al. 2012's measured peak vertical
//  GRF at four speeds: predicted/measured 0.85-0.95, i.e. a consistent ~5-15%
//  UNDERESTIMATE. No empirical correction is applied — fitting a fudge factor to
//  four points from one study would manufacture precision. The bias is reported.
//
//  CONSISTENCY WITH THE IMPACT LOAD MODEL. shared/run-load-model.js already uses
//  peak vGRF ∝ 1/duty factor (same citations) with duty factor expressed as the
//  proxy cadence(spm) × GCT(ms). The identity is dfProxy = 60000 × dutyFactor, and
//  `runLoadDfProxy` is emitted here in exactly that convention so the video-derived
//  and device-derived values are directly comparable.
//
//  HONEST CEILING. van Oeveren et al. 2021 found duty factor the strongest
//  spatiotemporal predictor of peak vertical GRF *between* runners at R^2 ~= 0.59
//  — strong for a timing-only estimate, but far from a measurement. Duty factor
//  also predicts peak force but NOT loading rate.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var api = factory(core);
  if (isNode) module.exports = api;
  if (root) root.KFOVerticalForce = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO) {
  'use strict';

  var GRAVITY_MPS2 = 9.80665;
  var HALF_SINE = Math.PI / 2;

  // dutyFactor = t_contact / T_step. run-load-model.js carries the same quantity
  // as cadence(spm) x GCT(ms); T_step = 60/cadence seconds, so
  //   dfProxy = cadence * GCT_ms = (60/T_step) * (t_contact*1000) = 60000 * DF.
  var RUN_LOAD_DF_PROXY_SCALE = 60000;

  var METHOD = 'timing_duty_factor';

  var LIMITS = Object.freeze({
    // Plausible running duty factors. Above ~0.75 there is little or no flight and
    // the identity's steady-state flight assumption stops holding.
    minDutyFactor: 0.20,
    maxDutyFactor: 0.75,
    minContactSeconds: 0.07,
    maxContactSeconds: 0.50,
    minFlightSeconds: 0.005,
    maxStepSeconds: 0.90,
    minSteps: 3,
    recommendedSteps: 8
  });

  var LIMITATIONS = Object.freeze([
    'Estimated from stance and flight timing, not measured force',
    'Assumes steady-speed level running; acceleration or grade breaks the impulse identity',
    'Peak value assumes a half-sine vertical force waveform and underestimates by roughly 5-15%',
    'Stride-averaged, not instantaneous',
    'Predicts peak force but not loading rate'
  ]);

  // Quality flags from the orientation analysis that specifically threaten the
  // TIMING estimate. Flags that only affect sagittal angles (perspective,
  // mirroring, direction) are deliberately absent: contact and flight time do
  // not depend on them.
  var CAVEAT_BY_FLAG = Object.freeze({
    acceleration_detected: 'Steady speed could not be confirmed. The impulse identity assumes steady-speed ' +
      'level running, so acceleration or deceleration biases both values.',
    grade_unknown: 'Grade is unknown. Running on a gradient breaks the level-running assumption the ' +
      'impulse identity depends on.',
    sparse_stance_sampling: 'Few samples fell inside stance, so each contact time is resolved coarsely.',
    low_frame_rate: 'Low effective frame rate limits how precisely stance edges can be located.',
    uncertain_contact_frame: 'Contact frames were uncertain, and that error propagates directly into contact time.'
  });

  var SYSTEMATIC_BIAS_CAVEAT = 'Systematic bias in locating stance edges does not average out across steps, ' +
    'which is why force-plate validation is still required.';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /**
   * Caveats specific to the timing estimate.
   *
   * The random-error line and the systematic-bias line are always present
   * together on purpose: quoting a shrinking random error without saying that
   * the systematic part does NOT shrink would read as a precision claim this
   * method cannot make.
   *
   * @param {string[]} qualityFlags  KFO.QUALITY_FLAG values from the analysis
   * @param {Object|null} uncertainty  output of timingUncertainty()
   * @param {number} nSteps
   */
  function buildCaveats(qualityFlags, uncertainty, nSteps) {
    var out = [];
    function add(text) { if (text && out.indexOf(text) === -1) out.push(text); }

    (qualityFlags || []).forEach(function (f) { add(CAVEAT_BY_FLAG[f]); });

    if (uncertainty && isNum(uncertainty.perStepRelative) && isNum(uncertainty.aggregateRelative)) {
      add('Random timing error is roughly ' + (uncertainty.perStepRelative * 100).toFixed(0) +
        '% per step, falling to roughly ' + (uncertainty.aggregateRelative * 100).toFixed(0) +
        '% averaged over ' + nSteps + ' step' + (nSteps === 1 ? '' : 's') + '. ' + SYSTEMATIC_BIAS_CAVEAT);
    } else {
      add(SYSTEMATIC_BIAS_CAVEAT);
    }

    if (isNum(nSteps) && nSteps < LIMITS.recommendedSteps) {
      add('Only ' + nSteps + ' step' + (nSteps === 1 ? '' : 's') + ' were usable (' +
        LIMITS.recommendedSteps + ' or more preferred). Multi-step averaging is what makes a timing-only ' +
        'estimate usable at all.');
    }
    return out;
  }

  /**
   * Build per-step timing from both sides' stance intervals.
   *
   * A step is one contact plus the flight that follows it. Consecutive stances
   * must ALTERNATE sides; a repeated side means a stance was missed, and that
   * pair is skipped rather than silently treated as one long step.
   *
   * Overlapping stances mean double support, which is walking, not running — the
   * flight assumption fails entirely, so it is flagged and no force is reported.
   *
   * @param {Array<{startTime:number,endTime:number}>} leftIntervals
   * @param {Array<{startTime:number,endTime:number}>} rightIntervals
   */
  function buildSteps(leftIntervals, rightIntervals) {
    var all = [];
    (leftIntervals || []).forEach(function (s) {
      if (isNum(s.startTime) && isNum(s.endTime) && s.endTime > s.startTime) {
        all.push({ side: 'left', start: s.startTime, end: s.endTime });
      }
    });
    (rightIntervals || []).forEach(function (s) {
      if (isNum(s.startTime) && isNum(s.endTime) && s.endTime > s.startTime) {
        all.push({ side: 'right', start: s.startTime, end: s.endTime });
      }
    });
    all.sort(function (a, b) { return a.start - b.start; });

    var steps = [], rejected = [], doubleSupport = 0;
    for (var i = 0; i < all.length - 1; i++) {
      var a = all[i], b = all[i + 1];
      if (a.side === b.side) {
        rejected.push({ t: a.start, reason: 'missed_opposite_stance' });
        continue;
      }
      var contact = a.end - a.start;
      var flight = b.start - a.end;
      if (flight < 0) {
        doubleSupport++;
        rejected.push({ t: a.start, reason: 'double_support_overlap', flightSeconds: flight });
        continue;
      }
      var step = contact + flight;
      var df = step > 0 ? contact / step : null;
      var ok = contact >= LIMITS.minContactSeconds && contact <= LIMITS.maxContactSeconds &&
               flight >= LIMITS.minFlightSeconds && step <= LIMITS.maxStepSeconds &&
               isNum(df) && df >= LIMITS.minDutyFactor && df <= LIMITS.maxDutyFactor;
      if (!ok) {
        rejected.push({
          t: a.start,
          reason: !(flight >= LIMITS.minFlightSeconds) ? 'insufficient_flight_time'
                : (isNum(df) && df > LIMITS.maxDutyFactor) ? 'duty_factor_out_of_running_range'
                : 'implausible_step_timing',
          contactSeconds: contact, flightSeconds: flight, dutyFactor: df
        });
        continue;
      }
      steps.push({
        contactSide: a.side,
        startTime: a.start,
        contactSeconds: contact,
        flightSeconds: flight,
        stepSeconds: step,
        dutyFactor: df,
        cadenceSpm: 60 / step
      });
    }
    return { steps: steps, rejected: rejected, doubleSupportCount: doubleSupport };
  }

  /**
   * Mean vertical force in bodyweights. Exact consequence of the steady-state
   * vertical impulse balance.
   */
  function meanVerticalForceBw(dutyFactor) {
    return (isNum(dutyFactor) && dutyFactor > 0) ? 1 / dutyFactor : null;
  }

  /**
   * Peak vertical force in bodyweights, half-sine waveform (Morin et al. 2005).
   * Equivalent to Morin's Fmax = mg*(pi/2)*(tf/tc + 1), since tf/tc + 1 = 1/DF.
   */
  function peakVerticalForceBw(dutyFactor) {
    return (isNum(dutyFactor) && dutyFactor > 0) ? HALF_SINE / dutyFactor : null;
  }

  /**
   * Timing precision. The stance edges come from the sampled scan, so the true
   * edge lies between two samples: a uniform error of +/- half a sample period,
   * sd = period/sqrt(12), and contact time carries two independent edges.
   *
   * This is RANDOM error only, and it shrinks with step count. Systematic bias in
   * plateau-edge detection is NOT captured here and does not average out — it is
   * the main reason this needs force-plate validation.
   */
  function timingUncertainty(samplePeriodSeconds, medianContactSeconds, nSteps) {
    if (!isNum(samplePeriodSeconds) || !isNum(medianContactSeconds) || medianContactSeconds <= 0) return null;
    var edgeSd = samplePeriodSeconds / Math.sqrt(12);
    var contactSd = edgeSd * Math.SQRT2;
    var perStepFraction = contactSd / medianContactSeconds;
    var n = Math.max(1, nSteps || 1);
    return {
      samplePeriodSeconds: samplePeriodSeconds,
      edgeSdSeconds: edgeSd,
      contactSdSeconds: contactSd,
      perStepRelative: perStepFraction,
      aggregateRelative: perStepFraction / Math.sqrt(n),
      note: 'Random sampling error only; systematic edge-detection bias is not included.'
    };
  }

  /**
   * @param {Object} input
   * @param {Array} input.leftStanceIntervals
   * @param {Array} input.rightStanceIntervals
   * @param {number} input.effectiveSampleRateHz
   * @param {number|null} [input.bodyMassKg]  enables absolute newtons
   * @param {string[]} [input.qualityFlags]  KFO quality flags, for caveats
   */
  function analyze(input) {
    input = input || {};
    var built = buildSteps(input.leftStanceIntervals, input.rightStanceIntervals);
    var steps = built.steps;

    var base = {
      method: METHOD,
      isValidated: false,
      provenance: KFO.PROVENANCE.KINEMATIC_ESTIMATE,
      limitations: LIMITATIONS.slice(),
      steps: steps,
      stepsAnalyzed: steps.length,
      stepsRejected: built.rejected.length,
      rejections: built.rejected,
      references: [
        'Morin et al. 2005 — spring-mass flight-time method',
        'Patoz et al. 2023 — peak vGRF from duty factor and contact/flight time',
        'van Oeveren et al. 2021 — duty factor as dominant between-runner predictor (R^2 ~= 0.59)'
      ]
    };

    if (built.doubleSupportCount > 0 && !steps.length) {
      base.availability = KFO.AVAILABILITY.UNAVAILABLE;
      base.reason = 'double_support_detected_not_running';
      base.gaitValidity = { isRunning: false, doubleSupportCount: built.doubleSupportCount };
      base.caveats = [];
      return base;
    }
    if (steps.length < LIMITS.minSteps) {
      base.availability = KFO.AVAILABILITY.UNAVAILABLE;
      base.reason = 'insufficient_steps';
      base.gaitValidity = { isRunning: null, doubleSupportCount: built.doubleSupportCount };
      base.caveats = [];
      return base;
    }

    var dfAgg = KFO.aggregate(steps.map(function (s) { return s.dutyFactor; }));
    var contactAgg = KFO.aggregate(steps.map(function (s) { return s.contactSeconds; }));
    var flightAgg = KFO.aggregate(steps.map(function (s) { return s.flightSeconds; }));
    var cadenceAgg = KFO.aggregate(steps.map(function (s) { return s.cadenceSpm; }));

    // Force is computed PER STEP and then aggregated, rather than from the mean
    // duty factor: 1/DF is convex, so averaging duty factor first would bias the
    // result (Jensen's inequality).
    var meanAgg = KFO.aggregate(steps.map(function (s) { return meanVerticalForceBw(s.dutyFactor); }));
    var peakAgg = KFO.aggregate(steps.map(function (s) { return peakVerticalForceBw(s.dutyFactor); }));

    var samplePeriod = (isNum(input.effectiveSampleRateHz) && input.effectiveSampleRateHz > 0)
      ? 1 / input.effectiveSampleRateHz : null;
    var uncertainty = timingUncertainty(samplePeriod, contactAgg.median, steps.length);

    base.availability = KFO.AVAILABILITY.AVAILABLE;
    base.reason = null;
    base.gaitValidity = {
      isRunning: true,
      doubleSupportCount: built.doubleSupportCount,
      note: built.doubleSupportCount > 0
        ? 'Some overlapping stances were seen and excluded; check event detection.' : null
    };
    base.dutyFactor = dfAgg;
    base.contactSeconds = contactAgg;
    base.flightSeconds = flightAgg;
    base.cadenceSpm = cadenceAgg;
    base.meanVerticalForceBw = meanAgg;
    base.peakVerticalForceBw = peakAgg;
    base.peakBiasNote = 'Half-sine assumption; checked against Dorn et al. 2012 at 0.85-0.95 of their ' +
      'force-plate peak, i.e. a likely 5-15% underestimate. No correction applied.';
    base.uncertainty = uncertainty;
    base.relativeUncertainty = uncertainty ? uncertainty.aggregateRelative : null;
    base.caveats = buildCaveats(input.qualityFlags, uncertainty, steps.length);

    // Same convention as shared/run-load-model.js (cadence(spm) x GCT(ms)), so the
    // video-derived value can be compared directly with the device-derived one.
    base.runLoadDfProxy = isNum(dfAgg.median) ? {
      value: dfAgg.median * RUN_LOAD_DF_PROXY_SCALE,
      convention: 'cadence_spm_times_gct_ms',
      equivalence: 'dfProxy = 60000 * dutyFactor',
      comparableWith: 'shared/run-load-model.js baseDF'
    } : null;

    if (isNum(input.bodyMassKg) && input.bodyMassKg > 0) {
      var bwN = input.bodyMassKg * GRAVITY_MPS2;
      base.bodyWeightNewtons = bwN;
      base.meanVerticalForceNewtons = isNum(meanAgg.median) ? meanAgg.median * bwN : null;
      base.peakVerticalForceNewtons = isNum(peakAgg.median) ? peakAgg.median * bwN : null;
    } else {
      base.bodyWeightNewtons = null;
      base.meanVerticalForceNewtons = null;
      base.peakVerticalForceNewtons = null;
      base.absoluteForceReason = 'body_mass_unavailable_values_are_bodyweight_normalised';
    }

    // The horizontal half, stated plainly rather than fabricated.
    base.horizontal = {
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: 'net_horizontal_impulse_is_near_zero_at_steady_speed',
      explanation: 'At constant average speed the braking and propulsive impulses cancel, so there is ' +
        'no net horizontal force to report. The discriminating quantity is braking impulse magnitude, ' +
        'which needs either force measurement or a running-speed estimate (Jbrake/BW = dVx/g). ' +
        'Speed is not captured anywhere in this pipeline.',
      brakingImpulseBwSeconds: null,
      propulsiveImpulseBwSeconds: null
    };
    return base;
  }

  return {
    METHOD: METHOD,
    GRAVITY_MPS2: GRAVITY_MPS2,
    HALF_SINE: HALF_SINE,
    RUN_LOAD_DF_PROXY_SCALE: RUN_LOAD_DF_PROXY_SCALE,
    LIMITS: LIMITS,
    LIMITATIONS: LIMITATIONS,
    CAVEAT_BY_FLAG: CAVEAT_BY_FLAG,
    SYSTEMATIC_BIAS_CAVEAT: SYSTEMATIC_BIAS_CAVEAT,
    buildSteps: buildSteps,
    buildCaveats: buildCaveats,
    meanVerticalForceBw: meanVerticalForceBw,
    peakVerticalForceBw: peakVerticalForceBw,
    timingUncertainty: timingUncertainty,
    analyze: analyze
  };
});
