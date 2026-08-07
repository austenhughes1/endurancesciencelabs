// ─────────────────────────────────────────────────────────────────────────────
//  PGI — four-phase stride model (minimum-COM landmark)
//
//  The stride timeline this module makes explicit:
//
//      TOUCHDOWN PREPARATION  (~150 ms before contact → touchdown; pgi-touchdown)
//      LOADING / COMPRESSION  (touchdown → minimum COM)
//      REBOUND / PROJECTION   (minimum COM → toe-off)
//      FLIGHT / STRIDE OUTCOME (toe-off → next touchdown; pgi-timing/pgi-outcome)
//
//  MINIMUM COM is the kinematic reversal point of vertical COM motion: the COM
//  descends, upward force decelerates the descent, vertical COM velocity passes
//  through approximately zero at the minimum, and the COM rises to toe-off. It
//  is an excellent landmark for summarizing the outgoing movement phase, but it
//  is NOT the onset of force production, NOT the start of positive vertical
//  force, and NOT the braking-to-propulsion (fore-aft force) transition — that
//  fore-aft reversal is a separate event that need not coincide with the
//  vertical reversal, and this video-only system does not observe it. Nothing
//  here may label minimum COM a "propulsive onset", and the phase after it is
//  named "rebound/projection", never simply "propulsive phase".
//
//  WHAT IS INDEPENDENT HERE. The minimum-COM timing within stance is the one
//  genuinely new independent quantity this module adds. Compression duration,
//  rebound duration, both phase fractions and the compression:rebound ratio are
//  algebra on GCT and that timing; mean rebound velocity is rebound rise over
//  rebound time. Rules and summaries treat them accordingly.
//
//  JOINT ANGLES are sagittal COCO-17 kinematics: hip (trunk–thigh interior
//  angle), knee (thigh–shank interior angle), trunk lean and shank inclination.
//  Ankle plantarflexion is PERMANENTLY UNAVAILABLE — COCO-17 has no heel, toe or
//  foot landmark, so no foot segment exists to measure it against; the shank
//  angle carries the distal-segment story instead. Pelvis orientation is
//  likewise unavailable from two near-collinear sagittal hip points. Both are
//  present in the schema with their reasons rather than silently missing.
//  No single joint is claimed to create propulsion independently: the summary
//  describes coordinated whole-body movement.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGIPhases = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  var DEG = 180 / Math.PI;

  var CONFIG = Object.freeze({
    // Support-line geometry is additionally read at this stance percent as the
    // "late stance" sample — inside the stance, away from the toe-off frame,
    // matching the KFO discipline of never treating exact toe-off as a force
    // event (support geometry stays descriptive body geometry in any case).
    lateStancePercent: 90,
    minSamplesForSeries: 8
  });

  var UNAVAILABLE_ANKLE = Object.freeze({
    availability: 'unavailable',
    reason: 'requires_foot_landmark',
    note: 'COCO-17 provides no heel, toe or foot landmark, so no foot segment exists to measure ' +
      'plantarflexion against. The shank angle carries the distal-segment motion instead.'
  });
  var UNAVAILABLE_PELVIS = Object.freeze({
    availability: 'unavailable',
    reason: 'requires_pelvis_landmarks',
    note: 'Sagittal pelvis orientation cannot be resolved from the two near-collinear COCO-17 hip ' +
      'points.'
  });

  // ── Angle definitions ──────────────────────────────────────────────────────

  function kpAt(kps, i) { return PGI._internals.kpAt(kps, i); }
  function midpoint(a, b) { return (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }

  /** Interior angle at vertex b between rays b→a and b→c, degrees. */
  function interiorAngle(a, b, c) {
    if (!a || !b || !c) return null;
    var v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    var d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!(d > 0)) return null;
    var cos = (v1x * v2x + v1y * v2y) / d;
    return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
  }

  /**
   * Build smoothed joint-angle series for one stance side.
   *
   * Conventions (direction-normalised; image +y is down):
   *   hip    interior angle at the hip between trunk (hip→shoulder-mid) and
   *          thigh (hip→knee). Larger = more extended. Extension change is
   *          angle(end) − angle(start), positive = extending.
   *   knee   interior angle at the knee between thigh (knee→hip) and shank
   *          (knee→ankle). Larger = straighter; positive change = extending.
   *   trunk  lean of shoulder-mid relative to hip-mid from vertical;
   *          positive = leaning forward (toward travel).
   *   shank  inclination of knee→ankle from vertical; positive = knee ahead of
   *          the ankle (shank rotated forward over the foot).
   *   support signed support-line angle from vertical, COM to stance ankle;
   *          negative = support point ahead of the COM (KFO sign convention).
   *          Descriptive geometry, never a force direction.
   */
  function buildJointSeries(samples, side, dirSign, smoothing) {
    var hipIdx = side === 'left' ? 11 : 12;
    var kneeIdx = side === 'left' ? 13 : 14;
    var ankleIdx = side === 'left' ? 15 : 16;
    var raw = { hip: [], knee: [], trunk: [], shank: [], support: [] };

    (samples || []).forEach(function (s) {
      if (!s || !isNum(s.t) || !s.kps) return;
      var hip = kpAt(s.kps, hipIdx), knee = kpAt(s.kps, kneeIdx), ankle = kpAt(s.kps, ankleIdx);
      var shMid = midpoint(kpAt(s.kps, 5), kpAt(s.kps, 6));
      var hipMid = midpoint(kpAt(s.kps, 11), kpAt(s.kps, 12));

      if (hip && knee && shMid) {
        var h = interiorAngle(shMid, hip, knee);
        if (isNum(h)) raw.hip.push({ t: s.t, v: h });
      }
      if (hip && knee && ankle) {
        var k = interiorAngle(hip, knee, ankle);
        if (isNum(k)) raw.knee.push({ t: s.t, v: k });
      }
      if (shMid && hipMid) {
        var vert = hipMid.y - shMid.y; // > 0: shoulders above hips
        if (vert > 1) {
          raw.trunk.push({ t: s.t, v: Math.atan2((shMid.x - hipMid.x) * dirSign, vert) * DEG });
        }
      }
      if (knee && ankle) {
        var sv = ankle.y - knee.y; // > 0: ankle below knee
        if (sv > 1) {
          raw.shank.push({ t: s.t, v: Math.atan2((knee.x - ankle.x) * dirSign, sv) * DEG });
        }
      }
      if (ankle) {
        var com = KFO.computeCOM(s.kps, 'segmental');
        if (com) {
          var ve = ankle.y - com.y; // > 0: COM above the support point
          if (ve > 1) {
            raw.support.push({ t: s.t, v: Math.atan2((com.x - ankle.x) * dirSign, ve) * DEG });
          }
        }
      }
    });

    var out = { insufficient: false };
    Object.keys(raw).forEach(function (key) {
      if (raw[key].length < CONFIG.minSamplesForSeries) {
        out[key] = null;
        if (key !== 'support') out.insufficient = out.insufficient || key === 'hip' || key === 'knee';
        return;
      }
      out[key] = PGI.smoothSeries(raw[key], smoothing).points;
    });
    return out;
  }

  function angleAt(series, t) {
    return series ? PGI.valueAtTime(series, t, 'value') : null;
  }

  // ── Per-step phase sampling ────────────────────────────────────────────────

  /**
   * Sample every angle at touchdown, minimum COM, late stance and toe-off for
   * one valid COM step record.
   */
  function sampleStep(step, jointSeries) {
    var tTd = step.events.touchdown;
    var tMin = step.events.minimumHeight;
    var tTo = step.events.toeoff;
    var gct = step.contactSeconds;
    var tLate = tTd + gct * CONFIG.lateStancePercent / 100;
    var js = jointSeries[step.contactSide];
    if (!js) return null;

    function at(key, t) { return angleAt(js[key], t); }
    function joint(key) {
      return {
        touchdown: at(key, tTd),
        minimumCom: at(key, tMin),
        toeoff: at(key, tTo)
      };
    }
    return {
      contactSide: step.contactSide,
      startTime: step.startTime,
      hip: joint('hip'),
      knee: joint('knee'),
      trunk: joint('trunk'),
      shank: joint('shank'),
      support: {
        touchdown: at('support', tTd),
        minimumCom: at('support', tMin),
        lateStance: at('support', tLate),
        toeoff: at('support', tTo)
      }
    };
  }

  // ── Aggregation helpers ────────────────────────────────────────────────────

  function agg(rows, fn, side) {
    var vals = [];
    rows.forEach(function (r) {
      if (!r) return;
      if (side && r.contactSide !== side) return;
      var v = fn(r);
      if (isNum(v)) vals.push(v);
    });
    return KFO.aggregate(vals);
  }

  function lengthViews(aggPx, legLength, calibration) {
    var norm = null, meters = null;
    if (aggPx && isNum(aggPx.median) && isNum(legLength) && legLength > 0) {
      norm = aggPx.median / legLength;
    }
    if (aggPx && isNum(aggPx.median)) meters = PGI.pxToMeters(aggPx.median, calibration);
    return {
      px: aggPx,
      medianLegLengths: norm,
      medianMeters: meters,
      medianCentimeters: isNum(meters) ? meters * 100 : null
    };
  }
  function velViews(aggPxPerS, legLength, calibration) {
    var norm = (aggPxPerS && isNum(aggPxPerS.median) && isNum(legLength) && legLength > 0)
      ? aggPxPerS.median / legLength : null;
    var mps = (aggPxPerS && isNum(aggPxPerS.median)) ? PGI.pxToMeters(aggPxPerS.median, calibration) : null;
    return { pxPerS: aggPxPerS, medianLegLengthsPerS: norm, medianMps: mps };
  }

  /**
   * One joint's phase summary: angles at the phase endpoints, the change, and —
   * when the frame rate supports velocity at all — the mean angular velocity.
   */
  function jointPhaseBlock(stepSamples, stepDurations, side, key, startField, endField, velocityOk) {
    function angleField(field) {
      return agg(stepSamples, function (r) { return r[key] ? r[key][field] : null; }, side);
    }
    var start = angleField(startField);
    var end = angleField(endField);
    var change = agg(stepSamples, function (r) {
      var j = r[key];
      return (j && isNum(j[startField]) && isNum(j[endField])) ? j[endField] - j[startField] : null;
    }, side);
    var velocity = velocityOk
      ? agg(stepSamples, function (r, i) {
          var j = r[key];
          var dur = stepDurations[r.startTime];
          return (j && isNum(j[startField]) && isNum(j[endField]) && isNum(dur) && dur > 0)
            ? (j[endField] - j[startField]) / dur : null;
        }, side)
      : null;
    return {
      angleAtStartDegrees: start,
      angleAtEndDegrees: end,
      changeDegrees: change,
      meanAngularVelocityDegPerS: velocity,
      velocityAvailability: velocityOk ? 'available'
        : { availability: 'unavailable', reason: 'video_frame_rate_insufficient' }
    };
  }

  // ── Phase blocks ───────────────────────────────────────────────────────────

  function loadingBlock(comSteps, stepSamples, side, ctx) {
    var durations = {};
    comSteps.forEach(function (s) { durations[s.startTime] = s.loading.durationSeconds; });
    function block(key) {
      return jointPhaseBlock(stepSamples, durations, side, key, 'touchdown', 'minimumCom', ctx.velocityOk);
    }
    return {
      side: side || 'overall',
      n: comSteps.filter(function (s) { return !side || s.contactSide === side; }).length,
      durationMs: agg(comSteps, function (s) { return s.loading.durationSeconds * 1000; }, side),
      fractionOfStance: agg(comSteps, function (s) { return s.loading.fractionOfStance; }, side),
      compression: lengthViews(
        agg(comSteps, function (s) { return s.loading.compressionPx; }, side),
        ctx.legLength, ctx.calibration),
      horizontalTravel: lengthViews(
        agg(comSteps, function (s) { return s.loading.horizontalTravelPx; }, side),
        ctx.legLength, ctx.calibration),
      jointChanges: {
        hip: block('hip'),
        knee: block('knee'),
        trunk: block('trunk'),
        shank: block('shank'),
        ankle: UNAVAILABLE_ANKLE,
        pelvis: UNAVAILABLE_PELVIS
      },
      supportGeometry: {
        angleAtTouchdownDegrees: agg(stepSamples, function (r) {
          return r.support ? r.support.touchdown : null; }, side),
        angleAtMinimumComDegrees: agg(stepSamples, function (r) {
          return r.support ? r.support.minimumCom : null; }, side),
        signConvention: 'negative = support point ahead of the COM',
        role: 'secondary_descriptive_geometry'
      }
    };
  }

  function reboundBlock(comSteps, stepSamples, side, ctx) {
    var durations = {};
    comSteps.forEach(function (s) { durations[s.startTime] = s.reboundPhase.durationSeconds; });
    function block(key) {
      return jointPhaseBlock(stepSamples, durations, side, key, 'minimumCom', 'toeoff', ctx.velocityOk);
    }
    var vyPose = velViews(
      agg(comSteps, function (s) { return s.reboundPhase.vyAtToeoffPxPerS; }, side),
      ctx.legLength, ctx.calibration);
    var vyBallistic = agg(comSteps, function (s) {
      return PGI.verticalTakeoffVelocityMps(s.flightSeconds); }, side);

    // Acceleration proxy is emitted only when the fitted COM velocity has been
    // cross-checked as broadly consistent with observed flight — otherwise it
    // would put a confident number on a derivative the data cannot support.
    var accel = null, accelReason = null;
    var cc = ctx.flightCrossCheck;
    var velocityQualityHigh = ctx.velocityOk && cc && cc.availability === 'available' &&
      (!isNum(cc.medianRelativeError) || cc.medianRelativeError <= 0.35);
    if (velocityQualityHigh) {
      var a = agg(comSteps, function (s) {
        return s.reboundPhase.meanVerticalAccelerationProxyPxPerS2; }, side);
      accel = {
        pxPerS2: a,
        medianLegLengthsPerS2: (a && isNum(a.median) && isNum(ctx.legLength) && ctx.legLength > 0)
          ? a.median / ctx.legLength : null,
        medianMps2: (a && isNum(a.median)) ? PGI.pxToMeters(a.median, ctx.calibration) : null,
        label: 'Mean vertical COM acceleration during rebound',
        note: 'A kinematic quantity from the fitted COM velocity. Not a ground-reaction force and ' +
          'not labelled one.'
      };
    } else {
      accelReason = ctx.velocityOk ? 'com_velocity_quality_insufficient' : 'video_frame_rate_insufficient';
    }

    return {
      side: side || 'overall',
      n: comSteps.filter(function (s) { return !side || s.contactSide === side; }).length,
      durationMs: agg(comSteps, function (s) { return s.reboundPhase.durationSeconds * 1000; }, side),
      fractionOfStance: agg(comSteps, function (s) { return s.reboundPhase.fractionOfStance; }, side),
      comRise: lengthViews(
        agg(comSteps, function (s) { return s.reboundPhase.risePx; }, side),
        ctx.legLength, ctx.calibration),
      horizontalTravel: lengthViews(
        agg(comSteps, function (s) { return s.reboundPhase.horizontalTravelPx; }, side),
        ctx.legLength, ctx.calibration),
      meanComRiseVelocity: velViews(
        agg(comSteps, function (s) { return s.reboundPhase.meanRiseVelocityPxPerS; }, side),
        ctx.legLength, ctx.calibration),
      comVelocityAtMinimum: velViews(
        agg(comSteps, function (s) { return s.reboundPhase.vyAtMinimumPxPerS; }, side),
        ctx.legLength, ctx.calibration),
      verticalVelocityAtToeoff: {
        // Two estimates on purpose. They are cross-checked, never silently
        // averaged; flight-derived leads user-facing summaries because it needs
        // no calibration and no pose-derived derivative.
        poseDerived: vyPose,
        ballisticFromFlightMps: vyBallistic,
        agreement: cc && cc.availability === 'available' ? {
          medianRelativeError: cc.medianRelativeError,
          isIndependent: cc.isIndependent,
          n: cc.n
        } : { availability: 'unavailable', reason: (cc && cc.reason) || 'cross_check_unavailable' },
        preferredSource: 'ballistic_flight_time'
      },
      meanVerticalAccelerationProxy: accel ||
        { availability: 'unavailable', reason: accelReason },
      compressionToReboundRatio: agg(comSteps, function (s) {
        return s.reboundPhase.compressionToReboundRatio; }, side),
      jointChanges: {
        hip: block('hip'),
        knee: block('knee'),
        trunk: block('trunk'),
        shank: block('shank'),
        ankle: UNAVAILABLE_ANKLE,
        pelvis: UNAVAILABLE_PELVIS
      },
      supportGeometry: {
        angleAtMinimumComDegrees: agg(stepSamples, function (r) {
          return r.support ? r.support.minimumCom : null; }, side),
        angleAtLateStanceDegrees: agg(stepSamples, function (r) {
          return r.support ? r.support.lateStance : null; }, side),
        lateStancePercent: CONFIG.lateStancePercent,
        signConvention: 'negative = support point ahead of the COM',
        role: 'secondary_descriptive_geometry'
      }
    };
  }

  // ── Outcome chain (Phase 7) ────────────────────────────────────────────────

  /**
   * The temporal sequence from minimum COM to stride length, in one object so
   * the UI and export share a single source. The `note` keeps it honest: this
   * is the order events happen in, not a claim that each step fully causes the
   * next.
   */
  function buildOutcomeChain(rebound, minCom, timing, outcome) {
    function med(a) { return a && isNum(a.median) ? a.median : null; }
    var to = timing && timing.timing && timing.timing.overall ? timing.timing.overall : null;
    var flight = to ? med(to.flightSeconds) : null;
    return {
      sequence: ['minimum_com', 'rebound_rise', 'rebound_duration',
                 'vertical_velocity_at_toeoff', 'toe_off', 'flight_time',
                 'aerial_rise', 'stride_length'],
      minimumComStancePercent: minCom && minCom.overall ? med(minCom.overall.stancePercent) : null,
      reboundRiseLegLengths: rebound && rebound.comRise ? rebound.comRise.medianLegLengths : null,
      reboundRiseCentimeters: rebound && rebound.comRise ? rebound.comRise.medianCentimeters : null,
      reboundDurationMs: rebound ? med(rebound.durationMs) : null,
      verticalVelocityAtToeoffMps: rebound && rebound.verticalVelocityAtToeoff
        ? med(rebound.verticalVelocityAtToeoff.ballisticFromFlightMps) : null,
      verticalVelocitySource: 'ballistic_flight_time',
      flightSeconds: flight,
      aerialRiseBallisticMeters: PGI.aerialRiseMeters(flight),
      strideLengthMeters: (outcome && outcome.strideLengthMeters) ? med(outcome.strideLengthMeters) : null,
      note: 'A temporal sequence, not a full causal chain: mechanics link these quantities in ' +
        'order, but no step is claimed to be produced by a single joint or fully determined by ' +
        'the one before it.'
    };
  }

  // ── Movement summary (Phase 8) ─────────────────────────────────────────────

  function fmt(v, dp) { return isNum(v) ? v.toFixed(dp == null ? 1 : dp) : null; }

  /**
   * A concise, DESCRIPTIVE rebound/projection summary for coaches. It reports
   * what the body did between minimum COM and toe-off; it does not grade it.
   */
  function buildMovementSummary(rebound, minCom, chain) {
    if (!rebound || !rebound.durationMs || !isNum(rebound.durationMs.median)) {
      return { availability: 'unavailable', reason: 'rebound_phase_unavailable' };
    }
    var parts = [];
    var pct = minCom && minCom.overall && minCom.overall.stancePercent
      ? minCom.overall.stancePercent.median : null;
    var riseCm = rebound.comRise ? rebound.comRise.medianCentimeters : null;
    var riseLl = rebound.comRise ? rebound.comRise.medianLegLengths : null;
    var riseText = isNum(riseCm) ? fmt(riseCm, 1) + ' cm'
      : (isNum(riseLl) ? fmt(riseLl, 3) + ' leg lengths' : null);

    var s1 = 'From minimum COM' + (isNum(pct) ? ' (' + Math.round(pct) + '% of stance)' : '') +
      ' to toe-off, the runner' + (riseText ? ' rises ' + riseText : ' rises') +
      ' over ' + Math.round(rebound.durationMs.median) + ' ms';

    var joints = [];
    var hip = rebound.jointChanges.hip.changeDegrees;
    var knee = rebound.jointChanges.knee.changeDegrees;
    var shank = rebound.jointChanges.shank.changeDegrees;
    if (hip && isNum(hip.median) && Math.abs(hip.median) >= 1) {
      joints.push((hip.median > 0 ? 'extending' : 'flexing') + ' the hip ' +
        Math.abs(Math.round(hip.median)) + '°');
    }
    if (knee && isNum(knee.median) && Math.abs(knee.median) >= 1) {
      joints.push((knee.median > 0 ? 'extending' : 'flexing') + ' the knee ' +
        Math.abs(Math.round(knee.median)) + '°');
    }
    if (shank && isNum(shank.median) && Math.abs(shank.median) >= 1) {
      joints.push('rotating the shank ' + Math.abs(Math.round(shank.median)) + '° ' +
        (shank.median > 0 ? 'forward' : 'backward'));
    }
    if (joints.length) s1 += ' while ' + joints.join(', ');
    s1 += '.';
    parts.push(s1);

    var vTo = chain ? chain.verticalVelocityAtToeoffMps : null;
    var flight = chain ? chain.flightSeconds : null;
    if (isNum(vTo) || isNum(flight)) {
      var s2 = [];
      if (isNum(vTo)) s2.push('estimated vertical take-off velocity ' + fmt(vTo, 2) +
        ' m/s (from flight time)');
      if (isNum(flight)) s2.push(Math.round(flight * 1000) + ' ms of flight');
      parts.push('The result is ' + s2.join(' with ') + '.');
    }

    // Optional pattern note — still descriptive, no grading vocabulary.
    var patternNote = null;
    var frac = rebound.fractionOfStance && isNum(rebound.fractionOfStance.median)
      ? rebound.fractionOfStance.median : null;
    if (isNum(frac)) {
      if (frac <= 0.45) {
        patternNote = 'Rebound occupies a relatively small share of contact (' +
          Math.round(frac * 100) + '%), so the vertical reversal is organised quickly.';
      } else if (frac >= 0.60) {
        patternNote = 'Rebound occupies a relatively large share of contact (' +
          Math.round(frac * 100) + '%), so the COM rise is produced over a longer interval.';
      }
    }

    return {
      availability: 'available',
      text: parts.join(' '),
      patternNote: patternNote,
      isDescriptive: true
    };
  }

  // ── Top level ──────────────────────────────────────────────────────────────

  /**
   * @param {Object} input
   * @param {Array}  input.samples          retained scan samples (t + kps)
   * @param {Object} input.com              pgi-com result (needs stepResults)
   * @param {Object} input.timing           pgi-timing result
   * @param {Object} [input.outcome]        pgi-outcome stride outcome
   * @param {number} input.directionSign
   * @param {number|null} input.legLengthPx
   * @param {Object|null} input.calibration
   * @param {number|null} input.effectiveSampleRateHz
   * @param {Object} [input.smoothing]
   */
  function analyze(input) {
    input = input || {};
    var com = input.com || {};
    var out = {
      availability: 'unavailable',
      reason: null,
      method: 'smoothed_com_minimum_landmark',
      definition: {
        loadingCompression: 'touchdown → minimum COM',
        reboundProjection: 'minimum COM → toe-off',
        minimumCom: 'Kinematic reversal point of vertical COM motion (vertical COM velocity ' +
          '≈ 0). Not the onset of propulsive force, and not the fore-aft ' +
          'braking-to-propulsion force reversal, which is a separate unobserved event.'
      }
    };
    if (com.availability !== 'available' || !com.stepResults) {
      out.reason = com.reason || 'com_trajectory_unavailable';
      return out;
    }
    var comSteps = com.stepResults.filter(function (s) {
      return s.valid && s.minimumCom && s.minimumCom.available;
    });
    if (!comSteps.length) {
      out.reason = 'no_steps_with_minimum_com';
      return out;
    }
    var dirSign = (isNum(input.directionSign) && input.directionSign !== 0)
      ? (input.directionSign > 0 ? 1 : -1) : null;
    if (dirSign === null) {
      out.reason = 'unknown_running_direction';
      return out;
    }

    var jointSeries = {
      left: buildJointSeries(input.samples, 'left', dirSign, input.smoothing),
      right: buildJointSeries(input.samples, 'right', dirSign, input.smoothing)
    };
    var stepSamples = comSteps.map(function (s) { return sampleStep(s, jointSeries); })
      .filter(Boolean);

    var ctx = {
      legLength: isNum(input.legLengthPx) ? input.legLengthPx : null,
      calibration: input.calibration || null,
      velocityOk: isNum(input.effectiveSampleRateHz) &&
        input.effectiveSampleRateHz >= PGI.MIN_RATE_FOR_VELOCITY_HZ,
      flightCrossCheck: com.flightCrossCheck || null
    };

    out.availability = 'available';
    out.stepsAnalyzed = comSteps.length;
    out.minimumCom = com.minimumCom;
    out.minimumComReliability = com.minimumComReliability || null;
    out.loadingCompression = {
      overall: loadingBlock(comSteps, stepSamples, null, ctx),
      left: loadingBlock(comSteps, stepSamples, 'left', ctx),
      right: loadingBlock(comSteps, stepSamples, 'right', ctx),
      note: 'How the runner receives and compresses into the ground. More compression is not ' +
        'automatically worse — deep and shallow strategies both appear in effective running.'
    };
    out.reboundProjection = {
      overall: reboundBlock(comSteps, stepSamples, null, ctx),
      left: reboundBlock(comSteps, stepSamples, 'left', ctx),
      right: reboundBlock(comSteps, stepSamples, 'right', ctx),
      note: 'How the body is organised from the lowest COM point through toe-off to create the ' +
        'outgoing stride. These are motion quantities: none is a measured force, and no single ' +
        'joint is credited with creating propulsion on its own.'
    };
    out.outcomeChain = buildOutcomeChain(out.reboundProjection.overall, out.minimumCom,
      input.timing, input.outcome);
    out.movementSummary = buildMovementSummary(out.reboundProjection.overall, out.minimumCom,
      out.outcomeChain);
    out.stepPhases = stepSamples; // runtime/export only; not persisted
    return out;
  }

  return {
    CONFIG: CONFIG,
    buildJointSeries: buildJointSeries,
    sampleStep: sampleStep,
    buildOutcomeChain: buildOutcomeChain,
    buildMovementSummary: buildMovementSummary,
    analyze: analyze,
    _internals: { interiorAngle: interiorAngle }
  };
});
