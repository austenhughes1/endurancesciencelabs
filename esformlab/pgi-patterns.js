// ─────────────────────────────────────────────────────────────────────────────
//  PGI — mechanics pattern interpretation engine
//
//  Replaces score-first interpretation with combination rules. Every emitted
//  pattern carries observations, a mechanical interpretation, a confidence,
//  alternative explanations, and the metrics that produced it.
//
//  WHAT IS AND IS NOT INDEPENDENT EVIDENCE
//  ---------------------------------------
//  A rule that counts the same quantity twice manufactures confidence. Within a
//  step there are only TWO independent timing quantities — contact time and
//  flight time. Everything else is algebra on them:
//
//      stepTime      = GCT + flight
//      dutyFactor    = GCT / stepTime
//      cadence       = 60 / stepTime
//      meanVerticalSupport (BW) = 1 / dutyFactor
//      verticalTakeoffVelocity  = g · flight / 2
//      effectiveVerticalImpulse = g · flight
//      ballistic aerial rise    = g · flight² / 8
//
//  So the rules below are written on GCT and flight time, and the derived
//  quantities appear as supporting VIEWS rather than as extra votes. The
//  genuinely independent evidence classes are:
//
//      timing      : GCT, flight time
//      COM         : stance compression, stance rebound, measured aerial rise,
//                    vertical velocity and its reversal rate
//      touchdown   : foot-COM offset, retraction, arrival velocity
//      outcome     : stride length, flight distance  (needs speed)
//
//  MEASURED vs BALLISTIC AERIAL RISE. Flight time predicts the rise; the COM
//  trajectory measures it. Their agreement is a cross-check, not two findings.
//
//  NOTHING HERE PENALISES VERTICAL OSCILLATION ON ITS OWN. Vertical oscillation
//  is interpreted only jointly with contact time, flight time, its own
//  decomposition, and stride outcome — in both single-condition and
//  pre/post-comparison form (see interpretComparison).
//
//  THRESHOLDS ARE PROVISIONAL internal working values, speed-dependent in
//  reality, and are labelled as such on every pattern. When speed is unknown,
//  patterns still fire but confidence is reduced and the wording says so.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGIPatterns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // ── Provisional thresholds ─────────────────────────────────────────────────
  var THRESHOLDS = Object.freeze({
    // Timing, seconds. Real values move with speed; these describe easy-to-
    // moderate running and are why speed-unknown lowers confidence.
    //
    // THE BANDS MUST BE REACHABLE INSIDE THE ACCEPTED RUNNING RANGE. Since
    // dutyFactor = GCT/(GCT + flight), requiring "long contact AND short flight"
    // implies a duty factor of at least gctLong/(gctLong + flightShort). The
    // step validator in kfo-vertical-force.js rejects anything above 0.75 as
    // not-running, so a stricter pair here would define a low-projection pattern
    // that could never fire on data the pipeline accepts. With these values the
    // implied floor is 0.72, leaving a real 0.72–0.75 window.
    gctLongSeconds: 0.265,
    gctShortSeconds: 0.225,
    flightShortSeconds: 0.105,
    flightAmpleSeconds: 0.135,
    // Duty factor, reported as the derived summary rather than as a rule input.
    dutyFactorHigh: 0.62,
    dutyFactorLow: 0.55,
    // COM quantities, normalised to leg length.
    voHighLegLengths: 0.105,
    voLowLegLengths: 0.070,
    stanceCompressionLargeLegLengths: 0.075,
    // Reversal rate, leg lengths per second squared.
    reversalRapidLegLengthsPerS2: 8.5,
    reversalSlowLegLengthsPerS2: 5.0,
    // Share of total vertical oscillation contributed by the aerial phase.
    aerialShareHigh: 0.45,
    aerialShareLow: 0.25,
    // Fraction of contacts needing clear retraction to call preparation clean.
    clearRetractionFraction: 0.6
  });

  var THRESHOLD_NOTE = 'Thresholds are provisional internal working values, not validated ' +
    'scientific cutoffs, and the underlying quantities vary with running speed.';

  var SPEED_CAVEAT = 'Running speed is unavailable, so this reading is based on absolute timing ' +
    'values that in reality shift with speed.';

  // ── Pattern factory ────────────────────────────────────────────────────────
  /**
   * The single shape every interpretation takes. `sortWeight` is INTERNAL: it
   * orders the list in the UI and is never rendered as a score.
   */
  function makePattern(spec) {
    return {
      pattern: spec.pattern,
      domain: spec.domain,
      confidence: Math.max(0, Math.min(0.97, isNum(spec.confidence) ? spec.confidence : 0.5)),
      observations: spec.observations || [],
      interpretation: spec.interpretation,
      alternatives: spec.alternatives || [],
      supportingMetrics: spec.supportingMetrics || {},
      evidenceClasses: spec.evidenceClasses || [],
      isDescriptive: true,
      isValidated: false,
      thresholds: { isProvisional: true, note: THRESHOLD_NOTE },
      sortWeight: isNum(spec.sortWeight) ? spec.sortWeight : 0
    };
  }

  // ── Readings ───────────────────────────────────────────────────────────────
  /**
   * Pull the scalars the rules need into one flat, availability-aware object, so
   * a rule never has to navigate three result trees and cannot silently read a
   * missing value as zero.
   */
  function readings(input) {
    var r = { available: {} };
    function set(name, value) {
      r[name] = isNum(value) ? value : null;
      r.available[name] = isNum(value);
    }
    var t = input.timing || {}, c = input.com || {}, td = input.touchdown || {},
        o = input.outcome || {};

    var to = (t.timing && t.timing.overall) || null;
    set('gctSeconds', to && to.contactSeconds ? to.contactSeconds.median : null);
    set('flightSeconds', to && to.flightSeconds ? to.flightSeconds.median : null);
    set('dutyFactor', to && to.dutyFactor ? to.dutyFactor.median : null);
    set('flightFraction', to && to.flightFraction ? to.flightFraction.median : null);
    set('cadenceSpm', to && to.cadenceSpm ? to.cadenceSpm.median : null);
    set('meanVerticalSupportBW',
        t.verticalSupport && t.verticalSupport.meanVerticalSupportBW
          ? t.verticalSupport.meanVerticalSupportBW.median : null);
    var proj = (t.projection && t.projection.overall) || null;
    set('verticalTakeoffVelocityMps',
        proj && proj.verticalTakeoffVelocityMps ? proj.verticalTakeoffVelocityMps.median : null);
    set('effectiveVerticalImpulsePerMass',
        proj && proj.effectiveVerticalImpulsePerMassNsPerKg
          ? proj.effectiveVerticalImpulsePerMassNsPerKg.median : null);
    set('ballisticAerialRiseMeters',
        proj && proj.aerialRiseBallisticMeters ? proj.aerialRiseBallisticMeters.median : null);

    var d = (c.decomposition && c.decomposition.overall) || null;
    function lens(block) { return block && isNum(block.medianLegLengths) ? block.medianLegLengths : null; }
    set('verticalOscillationLegLengths', d ? lens(d.verticalOscillation) : null);
    set('stanceCompressionLegLengths', d ? lens(d.stanceCompression) : null);
    set('stanceReboundLegLengths', d ? lens(d.stanceRebound) : null);
    set('aerialRiseMeasuredLegLengths', d ? lens(d.aerialRiseMeasured) : null);
    var v = (c.velocity && c.velocity.overall) || null;
    set('reversalRateLegLengthsPerS2',
        v && v.reversalRateLegLengthsPerS2 ? v.reversalRateLegLengthsPerS2.median : null);
    set('comVelocityAtTouchdownLegLengthsPerS',
        v && v.touchdown ? v.touchdown.medianLegLengthsPerS : null);
    set('comVelocityAtToeoffLegLengthsPerS',
        v && v.toeoff ? v.toeoff.medianLegLengthsPerS : null);

    // Aerial share of total vertical oscillation: how much of the excursion is
    // flight rather than stance collapse and rebound.
    r.aerialShareOfOscillation =
      (isNum(r.aerialRiseMeasuredLegLengths) && isNum(r.verticalOscillationLegLengths) &&
       r.verticalOscillationLegLengths > 0)
        ? r.aerialRiseMeasuredLegLengths / r.verticalOscillationLegLengths : null;
    r.available.aerialShareOfOscillation = isNum(r.aerialShareOfOscillation);

    // Touchdown: worse of the two sides drives the braking reading, since a
    // one-sided problem is still a problem.
    var sides = ['left', 'right'].map(function (s) { return td[s]; })
      .filter(function (s) { return s && s.availability === KFO.AVAILABILITY.AVAILABLE; });
    r.brakingPatterns = sides.map(function (s) { return s.brakingPattern.pattern; });
    r.available.touchdown = sides.length > 0;
    var offsets = sides.map(function (s) {
      var a = s.aggregate.footComOffsetAtTouchdownLegLengths;
      return a && isNum(a.median) ? a.median : null;
    }).filter(isNum);
    set('footComOffsetLegLengths', offsets.length ? Math.max.apply(null, offsets) : null);
    var retr = sides.map(function (s) { return s.aggregate.clearRetractionFraction; }).filter(isNum);
    set('clearRetractionFraction', retr.length
      ? retr.reduce(function (a, b) { return a + b; }, 0) / retr.length : null);
    var retrTime = sides.map(function (s) {
      var a = s.aggregate.retractionTimeMs;
      return a && isNum(a.median) ? a.median : null;
    }).filter(isNum);
    set('retractionTimeMs', retrTime.length
      ? retrTime.reduce(function (a, b) { return a + b; }, 0) / retrTime.length : null);
    r.velocityMismatch = sides.some(function (s) {
      return s.brakingPattern.evidence && s.brakingPattern.evidence.velocityMismatch === true;
    });
    r.positionElevated = sides.some(function (s) {
      return s.brakingPattern.evidence && s.brakingPattern.evidence.positionElevated === true;
    });

    set('stepLengthMeters', o.stepLengthMeters ? o.stepLengthMeters.median : null);
    set('flightDistanceMeters', o.flightDistanceMeters ? o.flightDistanceMeters.median : null);
    set('speedMps', o.speedMps);
    r.speedKnown = isNum(o.speedMps);
    return r;
  }

  /** Derived timing views, listed together so they read as one quantity restated. */
  function timingViews(r) {
    return {
      gctSeconds: r.gctSeconds,
      flightSeconds: r.flightSeconds,
      derivedFromTiming: {
        dutyFactor: r.dutyFactor,
        meanVerticalSupportBW: r.meanVerticalSupportBW,
        verticalTakeoffVelocityMps: r.verticalTakeoffVelocityMps,
        effectiveVerticalImpulsePerMassNsPerKg: r.effectiveVerticalImpulsePerMass,
        note: 'These are algebraic consequences of contact and flight time, not independent evidence.'
      }
    };
  }

  function conf(base, r, extra) {
    var c = base;
    if (!r.speedKnown) c *= 0.8;
    if (isNum(extra)) c *= extra;
    return c;
  }

  // ── Single-condition rules ─────────────────────────────────────────────────

  function verticalOscillationComposition(r, T) {
    if (!r.available.verticalOscillationLegLengths || !isNum(r.aerialShareOfOscillation)) return null;
    var obs = ['Total vertical excursion ' + r.verticalOscillationLegLengths.toFixed(3) + ' leg lengths'];
    if (isNum(r.stanceCompressionLegLengths)) {
      obs.push('Stance compression ' + r.stanceCompressionLegLengths.toFixed(3) + ' leg lengths');
    }
    if (isNum(r.stanceReboundLegLengths)) {
      obs.push('Stance rebound ' + r.stanceReboundLegLengths.toFixed(3) + ' leg lengths');
    }
    obs.push('Aerial rise contributes ' + Math.round(r.aerialShareOfOscillation * 100) +
      '% of total vertical excursion');
    var dominant = r.aerialShareOfOscillation >= T.aerialShareHigh ? 'aerial rise'
                 : r.aerialShareOfOscillation <= T.aerialShareLow ? 'stance motion'
                 : 'a mix of stance motion and aerial rise';
    return makePattern({
      pattern: 'vertical_oscillation_composition',
      domain: 'projection',
      confidence: conf(0.75, r),
      observations: obs,
      interpretation: 'Vertical excursion here comes mainly from ' + dominant + '. The same total ' +
        'excursion can be produced by deep stance collapse or by genuine aerial time, and those are ' +
        'different mechanics — neither is good or bad on its own.',
      alternatives: ['Sparse sampling flattening the trajectory extremes',
                     'COM estimate degraded by occluded landmarks'],
      supportingMetrics: {
        verticalOscillationLegLengths: r.verticalOscillationLegLengths,
        stanceCompressionLegLengths: r.stanceCompressionLegLengths,
        stanceReboundLegLengths: r.stanceReboundLegLengths,
        aerialRiseMeasuredLegLengths: r.aerialRiseMeasuredLegLengths,
        aerialShareOfOscillation: r.aerialShareOfOscillation
      },
      evidenceClasses: ['com'],
      sortWeight: 30
    });
  }

  function lowProjection(r, T) {
    if (!r.available.flightSeconds || !r.available.gctSeconds) return null;
    if (!(r.flightSeconds <= T.flightShortSeconds && r.gctSeconds >= T.gctLongSeconds)) return null;
    var obs = [
      'Ground contact time ' + Math.round(r.gctSeconds * 1000) + ' ms (long by provisional bands)',
      'Flight time ' + Math.round(r.flightSeconds * 1000) + ' ms (short by provisional bands)'
    ];
    if (isNum(r.dutyFactor)) obs.push('Duty factor ' + r.dutyFactor.toFixed(2) + ' — the derived summary of the two above');
    return makePattern({
      pattern: PGI.VERTICAL_PATTERN.LOW_PROJECTION,
      domain: 'projection',
      confidence: conf(0.72, r),
      observations: obs,
      interpretation: 'Limited upward projection results in a relatively ground-bound stride.' +
        (r.speedKnown ? '' : ' ' + SPEED_CAVEAT),
      alternatives: ['Slow running speed — duty factor rises as speed falls',
                     'Uphill running', 'Stance edges detected too generously at this sample rate'],
      supportingMetrics: timingViews(r),
      evidenceClasses: ['timing'],
      sortWeight: 80
    });
  }

  function slowProjection(r, T) {
    if (!r.available.flightSeconds || !r.available.gctSeconds) return null;
    if (!(r.flightSeconds > T.flightShortSeconds && r.gctSeconds >= T.gctLongSeconds)) return null;
    var slowRebound = isNum(r.reversalRateLegLengthsPerS2) &&
                      r.reversalRateLegLengthsPerS2 <= T.reversalSlowLegLengthsPerS2;
    var obs = [
      'Flight time ' + Math.round(r.flightSeconds * 1000) + ' ms is adequate',
      'Ground contact time ' + Math.round(r.gctSeconds * 1000) + ' ms is long'
    ];
    if (slowRebound) {
      obs.push('COM vertical velocity reverses at ' + r.reversalRateLegLengthsPerS2.toFixed(1) +
        ' leg lengths/s² — slow by provisional bands');
    }
    return makePattern({
      pattern: PGI.VERTICAL_PATTERN.SLOW_PROJECTION,
      domain: 'projection',
      confidence: conf(slowRebound ? 0.72 : 0.58, r),
      observations: obs,
      interpretation: 'Vertical projection is achieved over a relatively long contact period.' +
        (r.speedKnown ? '' : ' ' + SPEED_CAVEAT),
      alternatives: ['Slow running speed', 'Contact edges over-extended by sparse stance sampling'],
      supportingMetrics: {
        timing: timingViews(r),
        reversalRateLegLengthsPerS2: r.reversalRateLegLengthsPerS2
      },
      evidenceClasses: slowRebound ? ['timing', 'com'] : ['timing'],
      sortWeight: 70
    });
  }

  function productiveProjection(r, T) {
    if (!r.available.flightSeconds || !r.available.gctSeconds) return null;
    if (!(r.gctSeconds <= T.gctShortSeconds && r.flightSeconds >= T.flightAmpleSeconds)) return null;
    // Braking must not be elevated — productive projection is not a licence to
    // ignore how the contact was arrived at.
    var brakingOk = !r.available.touchdown ||
      (r.brakingPatterns.indexOf(PGI.BRAKING_PATTERN.COMBINED_BRAKING) === -1);
    if (!brakingOk) return null;
    var obs = [
      'Ground contact time ' + Math.round(r.gctSeconds * 1000) + ' ms (short by provisional bands)',
      'Flight time ' + Math.round(r.flightSeconds * 1000) + ' ms (ample by provisional bands)'
    ];
    if (isNum(r.dutyFactor)) obs.push('Duty factor ' + r.dutyFactor.toFixed(2));
    if (isNum(r.verticalOscillationLegLengths)) {
      obs.push('Vertical excursion ' + r.verticalOscillationLegLengths.toFixed(3) + ' leg lengths');
    }
    if (isNum(r.aerialShareOfOscillation)) {
      obs.push('Aerial rise contributes ' + Math.round(r.aerialShareOfOscillation * 100) +
        '% of vertical excursion');
    }
    if (r.available.touchdown) obs.push('Braking indicators are not elevated');
    return makePattern({
      pattern: PGI.VERTICAL_PATTERN.PRODUCTIVE_PROJECTION,
      domain: 'projection',
      confidence: conf(0.75, r, r.available.touchdown ? 1 : 0.9),
      observations: obs,
      interpretation: 'The runner creates useful aerial time through relatively rapid vertical ' +
        'support and converts it into stride length.' + (r.speedKnown ? '' : ' ' + SPEED_CAVEAT),
      alternatives: ['Fast running speed — contact shortens and flight lengthens with speed',
                     'Downhill running'],
      supportingMetrics: {
        timing: timingViews(r),
        verticalOscillationLegLengths: r.verticalOscillationLegLengths,
        aerialShareOfOscillation: r.aerialShareOfOscillation,
        stepLengthMeters: r.stepLengthMeters
      },
      evidenceClasses: ['timing', 'com', 'touchdown'],
      sortWeight: 85
    });
  }

  function collisionHeavy(r, T) {
    if (!r.available.touchdown || !r.velocityMismatch) return null;
    var bigCompression = isNum(r.stanceCompressionLegLengths) &&
                         r.stanceCompressionLegLengths >= T.stanceCompressionLargeLegLengths;
    var limitedFlight = isNum(r.flightSeconds) && r.flightSeconds <= T.flightShortSeconds;
    if (!bigCompression && !limitedFlight) return null;
    var obs = ['Foot arrival velocity indicates a mismatch at touchdown'];
    if (bigCompression) {
      obs.push('Stance compression ' + r.stanceCompressionLegLengths.toFixed(3) +
        ' leg lengths (large by provisional bands)');
    }
    if (limitedFlight) obs.push('Flight time ' + Math.round(r.flightSeconds * 1000) + ' ms is limited');
    if (isNum(r.comVelocityAtTouchdownLegLengthsPerS)) {
      obs.push('COM vertical velocity at touchdown ' +
        r.comVelocityAtTouchdownLegLengthsPerS.toFixed(2) + ' leg lengths/s');
    }
    return makePattern({
      pattern: PGI.VERTICAL_PATTERN.COLLISION_HEAVY,
      domain: 'ground_interaction',
      confidence: conf(0.62, r, (bigCompression && limitedFlight) ? 1 : 0.85),
      observations: obs,
      interpretation: 'Early stance appears dominated by collision and loading rather than effective ' +
        'rebound. This describes the kinematic pattern; impact force and loading rate are not measured.',
      alternatives: ['Contact frame located one sample early',
                     'Low frame rate exaggerating the velocity change at contact',
                     'COM estimate degraded by occluded landmarks'],
      supportingMetrics: {
        stanceCompressionLegLengths: r.stanceCompressionLegLengths,
        comVelocityAtTouchdownLegLengthsPerS: r.comVelocityAtTouchdownLegLengthsPerS,
        flightSeconds: r.flightSeconds,
        clearRetractionFraction: r.clearRetractionFraction
      },
      evidenceClasses: ['touchdown', 'com', 'timing'],
      sortWeight: 90
    });
  }

  function excessiveVerticalExcursion(r, T) {
    if (!r.available.verticalOscillationLegLengths) return null;
    if (r.verticalOscillationLegLengths < T.voHighLegLengths) return null;
    // High excursion is only "excessive" when it is NOT buying flight — i.e.
    // when contact is long, flight is short, or the excursion is mostly stance
    // motion rather than aerial rise.
    var longContact = isNum(r.gctSeconds) && r.gctSeconds >= T.gctLongSeconds;
    var shortFlight = isNum(r.flightSeconds) && r.flightSeconds <= T.flightShortSeconds;
    var mostlyStance = isNum(r.aerialShareOfOscillation) &&
                       r.aerialShareOfOscillation <= T.aerialShareLow;
    if (!longContact && !shortFlight && !mostlyStance) return null;
    var obs = ['Vertical excursion ' + r.verticalOscillationLegLengths.toFixed(3) +
      ' leg lengths (high by provisional bands)'];
    if (longContact) obs.push('Ground contact time ' + Math.round(r.gctSeconds * 1000) + ' ms is long');
    if (shortFlight) obs.push('Flight time ' + Math.round(r.flightSeconds * 1000) + ' ms is short');
    if (mostlyStance) {
      obs.push('Only ' + Math.round(r.aerialShareOfOscillation * 100) +
        '% of the excursion is aerial rise; most is stance motion');
    }
    return makePattern({
      pattern: PGI.VERTICAL_PATTERN.EXCESSIVE_VERTICAL_EXCURSION,
      domain: 'projection',
      confidence: conf(0.62, r),
      observations: obs,
      interpretation: 'Vertical displacement is high relative to the resulting stride outcome. ' +
        'Vertical excursion is not penalised on its own — this reading depends on it not being ' +
        'converted into aerial time.',
      alternatives: ['Slow running speed', 'COM estimate noise inflating the excursion',
                     'Camera not perpendicular to the runner'],
      supportingMetrics: {
        verticalOscillationLegLengths: r.verticalOscillationLegLengths,
        aerialShareOfOscillation: r.aerialShareOfOscillation,
        timing: timingViews(r),
        stepLengthMeters: r.stepLengthMeters
      },
      evidenceClasses: ['com', 'timing'],
      sortWeight: 75
    });
  }

  function elasticRapidRebound(r, T) {
    if (!isNum(r.gctSeconds) || r.gctSeconds > T.gctShortSeconds) return null;
    var rapid = isNum(r.reversalRateLegLengthsPerS2) &&
                r.reversalRateLegLengthsPerS2 >= T.reversalRapidLegLengthsPerS2;
    var containedCollapse = isNum(r.stanceCompressionLegLengths) &&
                            r.stanceCompressionLegLengths < T.stanceCompressionLargeLegLengths;
    var cleanTouchdown = isNum(r.clearRetractionFraction) &&
                         r.clearRetractionFraction >= T.clearRetractionFraction;
    if (!rapid || !containedCollapse) return null;
    var obs = [
      'Ground contact time ' + Math.round(r.gctSeconds * 1000) + ' ms (short by provisional bands)',
      'COM vertical velocity reverses at ' + r.reversalRateLegLengthsPerS2.toFixed(1) +
        ' leg lengths/s² (rapid by provisional bands)',
      'Stance compression ' + r.stanceCompressionLegLengths.toFixed(3) + ' leg lengths is contained'
    ];
    if (cleanTouchdown) {
      obs.push('Clear pre-contact retraction on ' + Math.round(r.clearRetractionFraction * 100) +
        '% of contacts');
    }
    return makePattern({
      pattern: PGI.VERTICAL_PATTERN.ELASTIC_RAPID_REBOUND,
      domain: 'rebound',
      confidence: conf(0.68, r, cleanTouchdown ? 1 : 0.88),
      observations: obs,
      interpretation: 'Downward COM motion is redirected upward quickly over a short contact, with ' +
        'limited stance collapse. This is a kinematic timing description, not a measure of ' +
        'tendon elasticity or of stored energy.',
      alternatives: ['Fast running speed', 'Stance edges detected too tightly',
                     'Smoothing window shorter than the true reversal'],
      supportingMetrics: {
        gctSeconds: r.gctSeconds,
        reversalRateLegLengthsPerS2: r.reversalRateLegLengthsPerS2,
        stanceCompressionLegLengths: r.stanceCompressionLegLengths,
        clearRetractionFraction: r.clearRetractionFraction
      },
      evidenceClasses: ['timing', 'com', 'touchdown'],
      sortWeight: 78
    });
  }

  /** Re-emit each side's touchdown/braking classification into the unified list. */
  function touchdownPatterns(input) {
    var out = [];
    ['left', 'right'].forEach(function (side) {
      var s = (input.touchdown || {})[side];
      if (!s || s.availability !== KFO.AVAILABILITY.AVAILABLE) return;
      var bp = s.brakingPattern;
      if (bp.pattern === PGI.BRAKING_PATTERN.INDETERMINATE) return;
      out.push(makePattern({
        pattern: bp.pattern,
        domain: 'touchdown_preparation',
        confidence: bp.confidence,
        observations: bp.observations.map(function (o) { return side + ': ' + o; }),
        interpretation: bp.interpretation,
        alternatives: bp.alternatives,
        supportingMetrics: bp.supportingMetrics,
        evidenceClasses: ['touchdown'],
        sortWeight: bp.pattern === PGI.BRAKING_PATTERN.COMBINED_BRAKING ? 95
                  : bp.pattern === PGI.BRAKING_PATTERN.WELL_PREPARED ? 60 : 88
      }));
    });
    return out;
  }

  // ── Domain summary (Phase 21) ──────────────────────────────────────────────

  function domainSummary(r, input, T) {
    var q = input.quality || {};
    function rate(value, reason) { return { rating: value, reason: reason || null }; }

    // Touchdown preparation
    var prep = rate('unknown', 'touchdown_preparation_unavailable');
    if (r.available.touchdown) {
      var combined = r.brakingPatterns.indexOf(PGI.BRAKING_PATTERN.COMBINED_BRAKING) !== -1;
      var wellPrepped = r.brakingPatterns.length &&
        r.brakingPatterns.every(function (p) { return p === PGI.BRAKING_PATTERN.WELL_PREPARED; });
      prep = combined ? rate('needs_review')
           : wellPrepped ? rate('good')
           : rate('moderate');
    }

    // Braking indicators
    var braking = rate('unknown', 'touchdown_preparation_unavailable');
    if (r.available.touchdown) {
      braking = (r.positionElevated && r.velocityMismatch) ? rate('elevated')
              : (r.positionElevated || r.velocityMismatch) ? rate('moderate')
              : rate('low');
    }

    // Vertical projection — from flight time, the quantity that pins projection.
    var projection = rate('unknown', 'flight_time_unavailable');
    if (r.available.flightSeconds) {
      projection = r.flightSeconds >= T.flightAmpleSeconds ? rate('strong')
                 : r.flightSeconds <= T.flightShortSeconds ? rate('low')
                 : rate('moderate');
    }

    // Rebound timing — contact time and, when available, the reversal rate.
    var rebound = rate('unknown', 'contact_time_unavailable');
    if (r.available.gctSeconds) {
      var fast = r.gctSeconds <= T.gctShortSeconds;
      var slow = r.gctSeconds >= T.gctLongSeconds;
      if (isNum(r.reversalRateLegLengthsPerS2)) {
        fast = fast && r.reversalRateLegLengthsPerS2 >= T.reversalRapidLegLengthsPerS2;
        slow = slow || r.reversalRateLegLengthsPerS2 <= T.reversalSlowLegLengthsPerS2;
      }
      rebound = fast ? rate('rapid') : slow ? rate('slow') : rate('moderate');
    }

    // Stride outcome — deliberately 'unknown' without a speed-matched reference.
    var outcome = (input.outcome && input.outcome.interpretation)
      ? rate(input.outcome.interpretation.rating, input.outcome.interpretation.reason)
      : rate('unknown', 'stride_outcome_unavailable');

    var band = q.confidenceBand || (q.confidence ? KFO.confidenceBand(q.confidence.score) : 'unknown');

    return {
      touchdownPreparation: prep,
      brakingIndicators: braking,
      verticalProjection: projection,
      reboundTiming: rebound,
      strideOutcome: outcome,
      dataConfidence: rate(band === 'unknown' ? 'unknown' : band),
      note: 'Domains are reported separately on purpose. There is no combined efficiency score, ' +
        'because no combination of these has been validated against running economy.',
      speedKnown: r.speedKnown
    };
  }

  // ── Top level (single condition) ───────────────────────────────────────────

  function interpret(input) {
    input = input || {};
    var T = input.thresholds || THRESHOLDS;
    var r = readings(input);
    var patterns = [];
    [verticalOscillationComposition, lowProjection, slowProjection, productiveProjection,
     collisionHeavy, excessiveVerticalExcursion, elasticRapidRebound].forEach(function (rule) {
      var p = rule(r, T);
      if (p) patterns.push(p);
    });
    patterns = patterns.concat(touchdownPatterns(input));
    patterns.sort(function (a, b) { return b.sortWeight - a.sortWeight; });
    return {
      patterns: patterns,
      domains: domainSummary(r, input, T),
      readings: r,
      thresholds: T,
      thresholdNote: THRESHOLD_NOTE
    };
  }

  // ── Comparison rules (Phase 14) ────────────────────────────────────────────
  //
  // THE HIGHEST-PRIORITY REQUIREMENT. An increase in vertical oscillation is
  // productive or unproductive depending entirely on what happened to contact
  // time, flight time, stride length and braking alongside it. These rules read
  // the whole combination; neither can fire on vertical oscillation alone.

  var DIRECTION = Object.freeze({ UP: 'increased', DOWN: 'decreased', SAME: 'unchanged',
                                  UNKNOWN: 'unknown' });

  /**
   * Direction of a change, with a relative dead-band so measurement noise does
   * not read as a change. When both conditions supply a spread, a change that
   * does not exceed stride-to-stride variability is reported as unchanged.
   */
  function direction(delta, relativeThreshold) {
    if (!delta || !isNum(delta.absolute) || !isNum(delta.baseline)) return DIRECTION.UNKNOWN;
    var rel = delta.baseline !== 0 ? Math.abs(delta.absolute / delta.baseline) : null;
    var thr = isNum(relativeThreshold) ? relativeThreshold : 0.03;
    if (isNum(rel) && rel < thr) return DIRECTION.SAME;
    if (delta.exceedsVariability === false) return DIRECTION.SAME;
    return delta.absolute > 0 ? DIRECTION.UP : DIRECTION.DOWN;
  }

  /**
   * @param {Object} deltas  from pgi-compare: {metricName: {absolute, percent, baseline, exceedsVariability}}
   * @param {Object} ctx     {speedComparable:boolean, labels:{a,b}, confidence}
   */
  function interpretComparison(deltas, ctx) {
    ctx = ctx || {};
    var d = deltas || {};
    var patterns = [];
    var speedNote = ctx.speedComparable === false
      ? ' Conditions were performed at different speeds, so part of this difference may be ' +
        'speed-dependent rather than a change in mechanics.'
      : '';
    var confScale = ctx.speedComparable === false ? 0.6 : 1;

    var vo = direction(d.verticalOscillationLegLengths, 0.04);
    var gct = direction(d.gctSeconds, 0.02);
    var flight = direction(d.flightSeconds, 0.04);
    var stride = direction(d.stepLengthMeters, 0.02);
    var compression = direction(d.stanceCompressionLegLengths, 0.05);
    var cadence = direction(d.cadenceSpm, 0.015);
    var retraction = direction(d.retractionTimeMs, 0.08);

    /**
     * Render one delta as an observation line.
     *
     * A delta that rounds to nothing at its own display precision is NOT listed:
     * a line reading "+0.00 (0.0%)" underneath a pattern reads as supporting
     * evidence for a change that did not happen. It is dropped rather than
     * shown, and the metric is still visible in the comparison table.
     */
    function obs(name, delta, unit, dp) {
      if (!delta || !isNum(delta.absolute)) return null;
      var places = dp == null ? 3 : dp;
      var shown = delta.absolute.toFixed(places);
      if (Math.abs(parseFloat(shown)) === 0) return null;
      var sign = delta.absolute > 0 ? '+' : '';
      var pct = isNum(delta.percent) ? ' (' + (delta.percent > 0 ? '+' : '') +
        delta.percent.toFixed(1) + '%)' : '';
      return name + ' ' + sign + shown + ' ' + unit + pct;
    }

    // ── Productive vertical excursion ──
    if (vo === DIRECTION.UP && flight === DIRECTION.UP &&
        (gct === DIRECTION.DOWN || gct === DIRECTION.SAME)) {
      var brakingWorse = direction(d.footComOffsetLegLengths, 0.05) === DIRECTION.UP &&
                         direction(d.clearRetractionFraction, 0.08) === DIRECTION.DOWN;
      if (!brakingWorse) {
        var o = [
          obs('Vertical excursion', d.verticalOscillationLegLengths, 'leg lengths'),
          obs('Flight time', d.flightSeconds, 's', 3),
          obs('Ground contact time', d.gctSeconds, 's', 3)
        ].filter(Boolean);
        if (stride === DIRECTION.UP) o.push(obs('Step length', d.stepLengthMeters, 'm', 3));
        if (cadence === DIRECTION.DOWN) o.push(obs('Cadence', d.cadenceSpm, 'spm', 1));
        if (direction(d.dutyFactor, 0.02) === DIRECTION.DOWN) {
          o.push(obs('Duty factor', d.dutyFactor, '', 3));
        }
        patterns.push(makePattern({
          pattern: PGI.VERTICAL_PATTERN.PRODUCTIVE_PROJECTION,
          domain: 'comparison',
          confidence: 0.8 * confScale,
          observations: o,
          interpretation: 'Greater vertical excursion appears to be contributing to useful aerial ' +
            'time rather than simply increasing bounce. Contact time did not lengthen and flight ' +
            'time increased alongside the larger excursion.' + speedNote,
          alternatives: ['Different running speed between conditions',
                         'Different surface or grade', 'Event detection differing between clips'],
          supportingMetrics: {
            verticalOscillationLegLengths: d.verticalOscillationLegLengths,
            gctSeconds: d.gctSeconds, flightSeconds: d.flightSeconds,
            stepLengthMeters: d.stepLengthMeters, cadenceSpm: d.cadenceSpm,
            dutyFactor: d.dutyFactor
          },
          evidenceClasses: ['timing', 'com', 'outcome'],
          sortWeight: 100
        }));
      }
    }

    // ── Unproductive vertical excursion ──
    if (vo === DIRECTION.UP && flight !== DIRECTION.UP &&
        (gct === DIRECTION.UP || gct === DIRECTION.SAME)) {
      var o2 = [
        obs('Vertical excursion', d.verticalOscillationLegLengths, 'leg lengths'),
        obs('Ground contact time', d.gctSeconds, 's', 3),
        'Flight time ' + (flight === DIRECTION.SAME ? 'was unchanged' : 'did not increase'),
        'Step length ' + (stride === DIRECTION.UP ? 'increased'
                        : stride === DIRECTION.SAME ? 'was unchanged' : 'did not increase')
      ].filter(Boolean);
      if (compression === DIRECTION.UP) {
        o2.push(obs('Stance compression', d.stanceCompressionLegLengths, 'leg lengths'));
      }
      patterns.push(makePattern({
        pattern: PGI.VERTICAL_PATTERN.UNPRODUCTIVE_VERTICAL_EXCURSION,
        domain: 'comparison',
        confidence: 0.72 * confScale,
        observations: o2,
        interpretation: 'Vertical excursion increased without a corresponding improvement in flight ' +
          'or stride outcome.' + speedNote,
        alternatives: ['Different running speed between conditions', 'Fatigue between conditions',
                       'COM estimate noisier in one clip'],
        supportingMetrics: {
          verticalOscillationLegLengths: d.verticalOscillationLegLengths,
          gctSeconds: d.gctSeconds, flightSeconds: d.flightSeconds,
          stepLengthMeters: d.stepLengthMeters,
          stanceCompressionLegLengths: d.stanceCompressionLegLengths
        },
        evidenceClasses: ['timing', 'com', 'outcome'],
        sortWeight: 98
      }));
    }

    // ── Touchdown preparation change ──
    if (retraction === DIRECTION.UP || direction(d.clearRetractionFraction, 0.08) === DIRECTION.UP) {
      var o3 = [
        obs('Retraction period', d.retractionTimeMs, 'ms', 0),
        obs('Fraction of contacts with clear retraction', d.clearRetractionFraction, '', 2)
      ].filter(Boolean);
      if (direction(d.footGroundVelocityMps, 0.08) === DIRECTION.DOWN) {
        o3.push(obs('Forward foot velocity at contact', d.footGroundVelocityMps, 'm/s', 2));
      }
      patterns.push(makePattern({
        pattern: 'improved_touchdown_preparation',
        domain: 'comparison',
        confidence: 0.7 * confScale,
        observations: o3,
        interpretation: 'The foot had more time to organise before contact in the second condition.' +
          speedNote,
        alternatives: ['Different running speed between conditions',
                       'Contact frames detected differently between clips',
                       'Different pre-contact sampling density between clips'],
        supportingMetrics: {
          retractionTimeMs: d.retractionTimeMs,
          clearRetractionFraction: d.clearRetractionFraction,
          footGroundVelocityMps: d.footGroundVelocityMps
        },
        evidenceClasses: ['touchdown'],
        sortWeight: 92
      }));
    }

    patterns.sort(function (a, b) { return b.sortWeight - a.sortWeight; });
    return {
      patterns: patterns,
      directions: {
        verticalOscillation: vo, gct: gct, flight: flight, stepLength: stride,
        stanceCompression: compression, cadence: cadence, retractionTime: retraction
      },
      speedComparable: ctx.speedComparable === undefined ? null : ctx.speedComparable
    };
  }

  // ── Static text registry ───────────────────────────────────────────────────
  //
  // `alternatives` is fixed per pattern, so it is not written into every stored
  // document — it is rebuilt from here at read time. Interpretations are NOT in
  // this registry: several are constructed with computed values and conditional
  // caveats, so they are stored verbatim rather than reconstructed.
  var ALTERNATIVES_BY_PATTERN = Object.freeze({
    vertical_oscillation_composition: ['Sparse sampling flattening the trajectory extremes',
                                       'COM estimate degraded by occluded landmarks'],
    low_projection: ['Slow running speed — duty factor rises as speed falls', 'Uphill running',
                     'Stance edges detected too generously at this sample rate'],
    slow_projection: ['Slow running speed', 'Contact edges over-extended by sparse stance sampling'],
    productive_projection: ['Different running speed', 'Downhill running',
                            'Event detection differing between clips'],
    collision_heavy: ['Contact frame located one sample early',
                      'Low frame rate exaggerating the velocity change at contact',
                      'COM estimate degraded by occluded landmarks'],
    excessive_vertical_excursion: ['Slow running speed', 'COM estimate noise inflating the excursion',
                                   'Camera not perpendicular to the runner'],
    elastic_rapid_rebound: ['Fast running speed', 'Stance edges detected too tightly',
                            'Smoothing window shorter than the true reversal'],
    unproductive_vertical_excursion: ['Different running speed between conditions',
                                      'Fatigue between conditions',
                                      'COM estimate noisier in one clip'],
    improved_touchdown_preparation: ['Different running speed between conditions',
                                     'Contact frames detected differently between clips',
                                     'Different pre-contact sampling density between clips'],
    positional_overstride: ['Camera not perpendicular to the runner',
                            'Ankle landmark understates a heel-first contact',
                            'Acceleration during the trial'],
    velocity_mismatch_touchdown: ['Low frame rate', 'Video calibration error',
                                  'Acceleration during the trial',
                                  'Contact frame located one sample early'],
    combined_braking: ['Camera not perpendicular to the runner', 'Low frame rate',
                       'Acceleration during the trial'],
    well_prepared_touchdown: ['Contact frame located one sample late',
                              'Sparse pre-contact sampling smoothing over a late reach']
  });

  function alternativesFor(pattern) {
    return ALTERNATIVES_BY_PATTERN[pattern] ? ALTERNATIVES_BY_PATTERN[pattern].slice() : [];
  }

  return {
    THRESHOLDS: THRESHOLDS,
    THRESHOLD_NOTE: THRESHOLD_NOTE,
    DIRECTION: DIRECTION,
    ALTERNATIVES_BY_PATTERN: ALTERNATIVES_BY_PATTERN,
    alternativesFor: alternativesFor,
    makePattern: makePattern,
    readings: readings,
    direction: direction,
    domainSummary: domainSummary,
    interpret: interpret,
    interpretComparison: interpretComparison
  };
});
