// ─────────────────────────────────────────────────────────────────────────────
//  PGI — stride timing + vertical projection
//
//  StrideTimingAnalyzer: step time, ground-contact time, flight time, cadence,
//  duty factor and flight fraction — all from DIRECTLY DETECTED gait events
//  (the same stance intervals the rest of the analysis uses), never from
//  algebraic reconstruction. Definitions:
//
//      stepTime    = time between consecutive opposite-foot contacts
//      flightTime  = one foot's toe-off → opposite foot's touchdown
//      dutyFactor  = GCT / stepTime
//      flightFraction = flightTime / stepTime
//
//  VerticalProjectionAnalyzer: the primary projection metrics, all pinned by
//  flight time under approximately ballistic flight (no calibration needed):
//
//      verticalTakeoffVelocity          = g · tFlight / 2
//      effectiveVerticalImpulse / mass  = g · tFlight
//      aerialRise (ballistic)           = g · tFlight² / 8
//
//  The timing-derived MEAN VERTICAL SUPPORT estimate (mean Fz over contact,
//  in bodyweights) comes from kfo-vertical-force.js:
//
//      meanVerticalSupportBW = stepTime / GCT = 1 / dutyFactor      [EXACT at
//                                                    steady state, level grade]
//
//  It is an estimate, not a measured force, is labelled "timing-derived", and
//  is withheld when the steady-state assumption visibly fails.
//
//  Everything is computed PER STEP and then aggregated (1/DF is convex, so
//  aggregating duty factor first would bias the force — Jensen's inequality;
//  the same discipline is applied to the ballistic quantities, which are
//  nonlinear in flight time).
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var vf = isNode ? require('./kfo-vertical-force.js') : root.KFOVerticalForce;
  var api = factory(core, pgi, vf);
  if (isNode) module.exports = api;
  if (root) root.PGITiming = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI, KFOVerticalForce) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var SUPPORT_ASSUMPTIONS = Object.freeze([
    'steady-speed running',
    'level surface',
    'periodic gait'
  ]);

  var PROJECTION_ASSUMPTIONS = Object.freeze([
    'approximately ballistic flight',
    'flight time from detected toe-off and opposite-foot touchdown'
  ]);

  /** Aggregate a per-step numeric field, optionally filtered by contact side. */
  function agg(steps, fn, side) {
    var vals = [];
    steps.forEach(function (s) {
      if (side && s.contactSide !== side) return;
      var v = fn(s);
      if (isNum(v)) vals.push(v);
    });
    return KFO.aggregate(vals);
  }

  function timingBlock(steps, side) {
    return {
      side: side || 'overall',
      n: side ? steps.filter(function (s) { return s.contactSide === side; }).length : steps.length,
      stepSeconds: agg(steps, function (s) { return s.stepSeconds; }, side),
      contactSeconds: agg(steps, function (s) { return s.contactSeconds; }, side),
      flightSeconds: agg(steps, function (s) { return s.flightSeconds; }, side),
      dutyFactor: agg(steps, function (s) { return s.dutyFactor; }, side),
      flightFraction: agg(steps, function (s) {
        return s.stepSeconds > 0 ? s.flightSeconds / s.stepSeconds : null;
      }, side),
      cadenceSpm: agg(steps, function (s) { return s.cadenceSpm; }, side)
    };
  }

  function projectionBlock(steps, side) {
    return {
      side: side || 'overall',
      flightSeconds: agg(steps, function (s) { return s.flightSeconds; }, side),
      verticalTakeoffVelocityMps: agg(steps, function (s) {
        return PGI.verticalTakeoffVelocityMps(s.flightSeconds);
      }, side),
      effectiveVerticalImpulsePerMassNsPerKg: agg(steps, function (s) {
        return PGI.effectiveVerticalImpulsePerMass(s.flightSeconds);
      }, side),
      aerialRiseBallisticMeters: agg(steps, function (s) {
        return PGI.aerialRiseMeters(s.flightSeconds);
      }, side)
    };
  }

  /**
   * @param {Object} input
   * @param {Array} input.leftStanceIntervals   [{startTime,endTime}...]
   * @param {Array} input.rightStanceIntervals
   * @param {number|null} input.effectiveSampleRateHz
   * @param {string[]} [input.qualityFlags]
   * @param {{assessable:boolean,accelerationDetected:boolean}} [input.steadySpeed]
   * @param {number|null} [input.bodyMassKg]
   */
  function analyze(input) {
    input = input || {};
    var vf = KFOVerticalForce.analyze({
      leftStanceIntervals: input.leftStanceIntervals,
      rightStanceIntervals: input.rightStanceIntervals,
      effectiveSampleRateHz: input.effectiveSampleRateHz,
      bodyMassKg: input.bodyMassKg == null ? null : input.bodyMassKg,
      qualityFlags: input.qualityFlags || []
    });

    var out = {
      availability: vf.availability,
      reason: vf.reason || null,
      method: 'detected_gait_events',
      stepsAnalyzed: vf.stepsAnalyzed || 0,
      stepsRejected: vf.stepsRejected || 0,
      rejections: vf.rejections || [],
      gaitValidity: vf.gaitValidity || null,
      // Per-step records are runtime/export only; the stored form drops them.
      steps: vf.steps || []
    };

    if (vf.availability !== KFO.AVAILABILITY.AVAILABLE) {
      out.timing = null;
      out.verticalSupport = { availability: vf.availability, reason: vf.reason || null,
                              method: 'timing_derived', isValidated: false };
      out.projection = { availability: vf.availability, reason: vf.reason || null };
      return out;
    }

    var steps = vf.steps;

    out.timing = {
      availability: KFO.AVAILABILITY.AVAILABLE,
      definitionNote: 'Step time is one contact plus the flight that follows it; duty factor is ' +
        'contact time over step time; flight fraction is flight time over step time.',
      overall: timingBlock(steps, null),
      left: timingBlock(steps, 'left'),
      right: timingBlock(steps, 'right'),
      uncertainty: vf.uncertainty || null
    };

    // ── Timing-derived mean vertical support (Phase 7) ──
    // Withheld (insufficient_quality) when the runner visibly accelerates:
    // the impulse identity assumes steady state. Grade is unknown on every
    // current path, so it stays an ASSUMPTION rather than a gate.
    var steady = input.steadySpeed || null;
    var accelerating = !!(steady && steady.assessable && steady.accelerationDetected);
    out.verticalSupport = {
      availability: accelerating ? KFO.AVAILABILITY.INSUFFICIENT_QUALITY : KFO.AVAILABILITY.AVAILABLE,
      reason: accelerating ? 'acceleration_detected_steady_state_assumption_fails' : null,
      label: 'Timing-derived mean vertical support',
      method: 'timing_derived',
      isValidated: false,
      meanVerticalSupportBW: vf.meanVerticalForceBw,       // aggregate of per-step 1/DF
      peakVerticalSupportBW: vf.peakVerticalForceBw,       // aggregate of per-step (π/2)/DF
      peakBiasNote: vf.peakBiasNote || null,
      perSide: {
        left: agg(steps, function (s) { return s.dutyFactor > 0 ? 1 / s.dutyFactor : null; }, 'left'),
        right: agg(steps, function (s) { return s.dutyFactor > 0 ? 1 / s.dutyFactor : null; }, 'right')
      },
      assumptions: SUPPORT_ASSUMPTIONS.slice(),
      conditions: {
        steadySpeed: steady && steady.assessable ? !steady.accelerationDetected : null,
        levelSurface: null,   // grade is not captured anywhere in the pipeline
        periodicGait: vf.gaitValidity ? vf.gaitValidity.isRunning : null
      },
      relativeUncertainty: vf.relativeUncertainty == null ? null : vf.relativeUncertainty,
      caveats: vf.caveats || [],
      limitations: (vf.limitations || []).concat([
        'Not peak impact force, not loading rate, and not a force-plate measurement'
      ]),
      runLoadDfProxy: vf.runLoadDfProxy || null
    };

    // ── Ballistic projection metrics (Phase 8) ──
    out.projection = {
      availability: KFO.AVAILABILITY.AVAILABLE,
      method: 'ballistic_flight_time',
      isValidated: false,
      assumptions: PROJECTION_ASSUMPTIONS.slice(),
      overall: projectionBlock(steps, null),
      left: projectionBlock(steps, 'left'),
      right: projectionBlock(steps, 'right'),
      note: 'Aerial rise here is the ballistic COM rise implied by flight time. It is not total ' +
        'vertical oscillation, which also contains stance compression and rebound.'
    };

    return out;
  }

  return {
    SUPPORT_ASSUMPTIONS: SUPPORT_ASSUMPTIONS,
    PROJECTION_ASSUMPTIONS: PROJECTION_ASSUMPTIONS,
    analyze: analyze
  };
});
