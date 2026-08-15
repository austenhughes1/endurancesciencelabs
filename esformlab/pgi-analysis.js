// ─────────────────────────────────────────────────────────────────────────────
//  PGI — analysis orchestration
//
//  Pipeline (the order matters, and it is not arbitrary):
//
//    retained scan samples
//      -> running direction, surface type
//      -> per-side stance intervals            (shared with the KFO detector, so
//                                               PGI and the stride cards cannot
//                                               disagree about where stance is)
//      -> support geometry                     (SECONDARY descriptive geometry)
//      -> stride timing + vertical projection  (GCT, flight, duty factor, the
//                                               ballistic projection metrics)
//      -> COM trajectory                       (needs the steps; ALSO produces
//                                               the ballistic-implied calibration)
//      -> spatial calibration selection        (user height beats ballistic)
//      -> running speed                        (needs the calibration)
//      -> touchdown preparation                (needs the calibration for
//                                               ground-relative velocities)
//      -> stride outcome, arm carriage         (need speed + calibration)
//      -> rebound assembly
//      -> pattern interpretation + domain summary
//      -> schema-v3 envelope
//
//  The calibration dependency is why COM runs before speed: flight time pins
//  vertical take-off velocity in m/s while pose gives it in px/s, so the COM
//  pass can imply a pixels-per-metre scale where no measured one exists.
//
//  SCOPE. This module computes; it renders nothing and stores nothing. What
//  reaches Firestore is `toStoredForm()` — aggregates plus the two normalised
//  trajectory paths, never per-stride detail or keypoints.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var deps = isNode ? {
    KFO: require('./kfo-core.js'),
    KFOAnalysis: require('./kfo-analysis.js'),
    KFOEstimators: require('./kfo-estimators.js'),
    KFOVerticalForce: require('./kfo-vertical-force.js'),
    PGI: require('./pgi-core.js'),
    PGITiming: require('./pgi-timing.js'),
    PGICom: require('./pgi-com.js'),
    PGITouchdown: require('./pgi-touchdown.js'),
    PGIOutcome: require('./pgi-outcome.js'),
    PGIPhases: require('./pgi-phases.js'),
    PGIPatterns: require('./pgi-patterns.js')
  } : {
    KFO: root.KFO, KFOAnalysis: root.KFOAnalysis, KFOEstimators: root.KFOEstimators,
    KFOVerticalForce: root.KFOVerticalForce,
    PGI: root.PGI, PGITiming: root.PGITiming, PGICom: root.PGICom,
    PGITouchdown: root.PGITouchdown, PGIOutcome: root.PGIOutcome,
    PGIPhases: root.PGIPhases, PGIPatterns: root.PGIPatterns
  };
  var api = factory(deps);
  if (isNode) module.exports = api;
  if (root) root.PGIAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (d) {
  'use strict';

  var KFO = d.KFO, KFOAnalysis = d.KFOAnalysis, KFOEstimators = d.KFOEstimators,
      KFOVerticalForce = d.KFOVerticalForce,
      PGI = d.PGI, PGITiming = d.PGITiming, PGICom = d.PGICom,
      PGITouchdown = d.PGITouchdown, PGIOutcome = d.PGIOutcome,
      PGIPhases = d.PGIPhases, PGIPatterns = d.PGIPatterns;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function median(a) { return KFO._internals.median(a); }
  function round(v, dp) { return PGI._internals.round(v, dp); }

  var LIMITATIONS = Object.freeze([
    'Video-derived kinematic estimate; not a direct ground-reaction-force measurement',
    'Two-dimensional sagittal geometry only',
    'The ankle is the foot proxy — COCO-17 provides no heel, toe or foot landmark',
    'Stance edges are located at the scan sample rate, which bounds every timing quantity',
    'Interpretation thresholds are provisional working values and vary with running speed',
    'No metric here has been validated against force-plate or metabolic measurement'
  ]);

  // ── Quality ────────────────────────────────────────────────────────────────

  function buildQuality(ctx) {
    // The KFO flag set covers the pose/camera/stride conditions; PGI adds the
    // ones that only matter once velocities, calibration and speed are in play.
    var flags = KFOAnalysis.buildQualityFlags(ctx.kfoContext).slice();
    function add(f) { if (flags.indexOf(f) === -1) flags.push(f); }
    var F = PGI.PGI_FLAG;

    if (!ctx.calibration || !isNum(ctx.calibration.pixelsPerMeter)) add(F.NO_SPATIAL_CALIBRATION);
    else if (ctx.calibration.source === PGI.CALIBRATION_SOURCE.BALLISTIC_FLIGHT) {
      add(F.CALIBRATION_IS_BALLISTIC);
    }
    if (ctx.surfaceType === PGI.SURFACE.TREADMILL && !isNum(ctx.treadmillSpeedMps)) {
      add(F.TREADMILL_SPEED_UNKNOWN);
    }
    if (ctx.velocityWindow && !ctx.velocityWindow.available) add(F.VELOCITY_SAMPLING_INSUFFICIENT);
    if (ctx.denseRequested && !ctx.denseUsed) add(F.DENSE_PRECONTACT_UNAVAILABLE);
    if (ctx.minimumComReliability && ctx.minimumComReliability.unreliable &&
        ctx.comAvailable) add(F.MINIMUM_COM_UNRELIABLE);
    return flags;
  }

  // ── Rebound assembly ───────────────────────────────────────────────────────
  //
  // Rebound is not a separate measurement: it is stance compression, stance
  // rebound, the COM velocity reversal and contact time read together. It is
  // assembled here so the UI section and the export have one source.

  function buildRebound(com, timing) {
    var out = { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: null,
                note: 'Rebound is described by how far the COM fell during stance, how much of that ' +
                      'it recovered before toe-off, how quickly downward motion reversed, and how ' +
                      'long contact lasted. None of these is a force.' };
    if (!com || com.availability !== KFO.AVAILABILITY.AVAILABLE) {
      out.reason = (com && com.reason) || 'com_trajectory_unavailable';
      return out;
    }
    var v = com.velocity && com.velocity.overall;
    var dec = com.decomposition && com.decomposition.overall;
    var to = timing && timing.timing && timing.timing.overall;
    out.availability = KFO.AVAILABILITY.AVAILABLE;
    out.stanceCompression = dec ? dec.stanceCompression : null;
    out.stanceRebound = dec ? dec.stanceRebound : null;
    out.contactSeconds = to ? to.contactSeconds : null;
    out.comVelocityAtTouchdown = v ? v.touchdown : null;
    out.comVelocityAtToeoff = v ? v.toeoff : null;
    out.comVelocityMostNegative = v ? v.mostNegative : null;
    out.comVelocityAtMinimumHeight = v ? v.atMinimumHeight : null;
    out.maxPositiveStanceVelocity = v ? v.maxPositiveStance : null;
    out.verticalVelocityReversal = v ? v.reversal : null;
    out.reversalRateLegLengthsPerS2 = v ? v.reversalRateLegLengthsPerS2 : null;
    out.reversalRateMps2 = v ? v.reversalRateMps2 : null;
    out.perSide = {
      left: com.velocity ? com.velocity.left : null,
      right: com.velocity ? com.velocity.right : null
    };
    out.flightCrossCheck = com.flightCrossCheck || null;
    return out;
  }

  // ── Symmetry ───────────────────────────────────────────────────────────────

  function buildSymmetry(parts) {
    var out = { available: false, note: 'Side-to-side differences are descriptive. Some asymmetry ' +
      'is normal; a large difference is first a prompt to check event detection.' };
    var td = parts.touchdown, timing = parts.timing, com = parts.com, geom = parts.geometry;
    var any = false;

    if (td && td.asymmetry && td.asymmetry.available) {
      out.touchdownPreparation = td.asymmetry; any = true;
    }
    if (timing && timing.timing) {
      var l = timing.timing.left, r = timing.timing.right;
      if (l && r && l.contactSeconds && r.contactSeconds &&
          isNum(l.contactSeconds.median) && isNum(r.contactSeconds.median)) {
        out.contactTimeDifferenceSeconds = l.contactSeconds.median - r.contactSeconds.median;
        out.flightTimeDifferenceSeconds =
          (isNum(l.flightSeconds.median) && isNum(r.flightSeconds.median))
            ? l.flightSeconds.median - r.flightSeconds.median : null;
        any = true;
      }
    }
    if (com && com.decomposition) {
      var cl = com.decomposition.left, cr = com.decomposition.right;
      function lens(b) { return b && isNum(b.medianLegLengths) ? b.medianLegLengths : null; }
      if (cl && cr) {
        var a = lens(cl.stanceCompression), b2 = lens(cr.stanceCompression);
        out.stanceCompressionDifferenceLegLengths = (isNum(a) && isNum(b2)) ? a - b2 : null;
        if (isNum(out.stanceCompressionDifferenceLegLengths)) any = true;
      }
    }
    if (geom && geom.symmetry && geom.symmetry.available) {
      out.supportGeometry = geom.symmetry; any = true;
    }

    // ── Loading/rebound phase asymmetry (four-phase model) ──
    // Descriptive deltas only: no red/yellow/green banding exists for these
    // until normative data do.
    var ph = parts.phases;
    if (ph && ph.availability === 'available' && ph.loadingCompression && ph.reboundProjection) {
      function medOf(block, path) {
        var cur = block;
        path.split('.').forEach(function (k) { cur = cur ? cur[k] : null; });
        return (cur && isNum(cur.median)) ? cur.median : null;
      }
      function diff(l, r) { return (isNum(l) && isNum(r)) ? l - r : null; }
      function relDiff(l, r) {
        if (!isNum(l) || !isNum(r)) return null;
        var mean = (l + r) / 2;
        return mean !== 0 ? (l - r) / mean : null;
      }
      var lcL = ph.loadingCompression.left, lcR = ph.loadingCompression.right;
      var rpL = ph.reboundProjection.left, rpR = ph.reboundProjection.right;
      var mcL = ph.minimumCom ? ph.minimumCom.left : null;
      var mcR = ph.minimumCom ? ph.minimumCom.right : null;
      if (lcL && lcR && lcL.n > 0 && lcR.n > 0 && rpL && rpR) {
        out.stancePhases = {
          minimumComStancePercentDifference: diff(
            mcL && mcL.stancePercent ? mcL.stancePercent.median : null,
            mcR && mcR.stancePercent ? mcR.stancePercent.median : null),
          compressionDurationDifferenceMs: diff(medOf(lcL, 'durationMs'), medOf(lcR, 'durationMs')),
          compressionDepthDifferenceLegLengths: diff(
            lcL.compression ? lcL.compression.medianLegLengths : null,
            lcR.compression ? lcR.compression.medianLegLengths : null),
          reboundDurationDifferenceMs: diff(medOf(rpL, 'durationMs'), medOf(rpR, 'durationMs')),
          reboundDurationRelativeDifference: relDiff(medOf(rpL, 'durationMs'), medOf(rpR, 'durationMs')),
          reboundRiseDifferenceLegLengths: diff(
            rpL.comRise ? rpL.comRise.medianLegLengths : null,
            rpR.comRise ? rpR.comRise.medianLegLengths : null),
          meanReboundVelocityDifferenceLegLengthsPerS: diff(
            rpL.meanComRiseVelocity ? rpL.meanComRiseVelocity.medianLegLengthsPerS : null,
            rpR.meanComRiseVelocity ? rpR.meanComRiseVelocity.medianLegLengthsPerS : null)
        };
        any = true;
      }
    }
    out.available = any;
    if (!any) out.reason = 'insufficient_bilateral_data';
    return out;
  }

  /**
   * Build per-side stance overrides from the user's phase-card selections.
   *
   * The stance overlapping each side's picks ALWAYS takes the user's exact
   * times. What varies is how the measured auto-vs-user edge delta is carried
   * to the side's sibling stances — a correction that must never break the
   * clip it is meant to fix. Candidate modes, tried in order:
   *
   *   full        shift AND resize every sibling by (dStart, dEnd)
   *   shift_only  move every sibling by the midpoint shift, keep its duration
   *   anchor_only leave siblings on their detected edges
   *
   * Each candidate's interval set is validated with the SAME step builder the
   * timing analysis uses; the first mode that yields at least as many accepted
   * steps as the uncorrected set — and no new double-support overlaps — wins.
   * Widened picks on short-flight clips can otherwise overlap consecutive
   * stances and take down every downstream section at once.
   *
   * Same-side auto stances that overlap the user's window are detector
   * fragments of the same true stance and are absorbed (dropped) in every mode.
   *
   * @param {Object|null} events {left:{footStrikeTime,toeOffTime}, right:{...}}
   */
  function buildUserAnchors(samples, events) {
    var out = { any: false, overrides: { left: null, right: null },
                anchors: { left: null, right: null }, propagationMode: null };
    if (!events) return out;

    // Per-side raw material.
    var sides = {};
    ['left', 'right'].forEach(function (side) {
      var ev = events[side];
      var det = KFOAnalysis.detectStanceIntervals(samples, side).accepted;
      var entry = { det: det, ev: null, best: null, dStart: 0, dEnd: 0, absorbed: [] };
      sides[side] = entry;
      if (!ev || !isNum(ev.footStrikeTime) || !isNum(ev.toeOffTime) ||
          !(ev.toeOffTime > ev.footStrikeTime) || !det.length) return;

      var best = null, bestOverlap = 0;
      det.forEach(function (iv) {
        var overlap = Math.min(iv.endTime, ev.toeOffTime) - Math.max(iv.startTime, ev.footStrikeTime);
        if (overlap > bestOverlap) { bestOverlap = overlap; best = iv; }
      });
      if (!best) {
        var mid = (ev.footStrikeTime + ev.toeOffTime) / 2;
        det.forEach(function (iv) {
          var d2 = Math.abs((iv.startTime + iv.endTime) / 2 - mid);
          if (d2 <= 0.5 && (!best || d2 < Math.abs((best.startTime + best.endTime) / 2 - mid))) best = iv;
        });
      }
      if (!best) return;
      entry.ev = ev;
      entry.best = best;
      entry.dStart = ev.footStrikeTime - best.startTime;
      entry.dEnd = ev.toeOffTime - best.endTime;
      // Fragments of the same true stance: any OTHER same-side interval that
      // overlaps the user's window is absorbed by the anchor.
      entry.absorbed = det.filter(function (iv) {
        return iv !== best &&
          Math.min(iv.endTime, ev.toeOffTime) - Math.max(iv.startTime, ev.footStrikeTime) > 0;
      });
    });
    if (!sides.left.ev && !sides.right.ev) return out;

    function overridesFor(mode) {
      var o = { left: null, right: null };
      ['left', 'right'].forEach(function (side) {
        var e = sides[side];
        if (!e.det.length || !e.ev) return;
        o[side] = e.det.map(function (iv) {
          if (iv === e.best) {
            return { autoStartTime: iv.startTime, startTime: e.ev.footStrikeTime,
                     endTime: e.ev.toeOffTime, source: 'user_phase_selection' };
          }
          if (e.absorbed.indexOf(iv) !== -1) {
            return { autoStartTime: iv.startTime, drop: true, source: 'absorbed_into_user_stance' };
          }
          if (mode === 'anchor_only') return { autoStartTime: iv.startTime };
          var shift = (e.dStart + e.dEnd) / 2;
          var ds = mode === 'full' ? e.dStart : shift;
          var de = mode === 'full' ? e.dEnd : shift;
          return { autoStartTime: iv.startTime, startTime: iv.startTime + ds,
                   endTime: iv.endTime + de, source: 'user_bias_corrected' };
        });
      });
      return o;
    }

    /** Accepted-step count and double-support count for a candidate. */
    function evaluate(ov) {
      function corrected(side) {
        return KFOAnalysis.detectStanceIntervals(samples, side, undefined,
          ov ? ov[side] : null).accepted.map(function (iv) {
            return { startTime: iv.startTime, endTime: iv.endTime };
          });
      }
      var built = KFOVerticalForce.buildSteps(corrected('left'), corrected('right'));
      return { steps: built.steps.length, doubleSupport: built.doubleSupportCount };
    }

    var baseline = evaluate(null);
    var modes = ['full', 'shift_only', 'anchor_only'];
    var chosen = null, chosenOv = null, chosenScore = null;
    for (var m = 0; m < modes.length; m++) {
      var ov = overridesFor(modes[m]);
      var score = evaluate(ov);
      if (score.steps >= baseline.steps && score.doubleSupport <= baseline.doubleSupport) {
        chosen = modes[m]; chosenOv = ov; chosenScore = score;
        break;
      }
      // Remember the least-bad candidate in case none clears the baseline —
      // the user's own stance leads by definition even when it costs steps.
      if (!chosenScore || score.steps > chosenScore.steps) {
        chosen = modes[m]; chosenOv = ov; chosenScore = score;
      }
    }

    out.any = true;
    out.propagationMode = chosen;
    out.overrides = chosenOv;
    ['left', 'right'].forEach(function (side) {
      var e = sides[side];
      if (!e.ev) return;
      out.anchors[side] = {
        userFootStrikeTime: round(e.ev.footStrikeTime, 4),
        userToeOffTime: round(e.ev.toeOffTime, 4),
        autoStartTime: round(e.best.startTime, 4),
        autoEndTime: round(e.best.endTime, 4),
        startBiasMs: Math.round(e.dStart * 1000),
        endBiasMs: Math.round(e.dEnd * 1000),
        absorbedFragments: e.absorbed.length,
        siblingStancesCorrected: chosen === 'anchor_only'
          ? 0 : e.det.length - 1 - e.absorbed.length
      };
    });
    return out;
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  /**
   * @param {Object} input
   * @param {Array}  input.samples              retained side-scan samples (t + kps)
   * @param {Array}  [input.denseWindows]       optional dense pre-contact rescan
   * @param {Object} [input.videoMetadata]      {fps,width,height}
   * @param {number|null} [input.userSpeedMps]
   * @param {number|null} [input.treadmillSpeedMps]
   * @param {string}  [input.surfaceType]       'overground' | 'treadmill' | 'unknown'
   * @param {number|null} [input.userHeightMeters]
   * @param {number|null} [input.bodyMassKg]
   * @param {string|null} [input.conditionLabel]
   * @param {Object} [input.config]
   */
  function analyze(input) {
    input = input || {};
    var meta = input.videoMetadata || {};
    var samples = (input.samples || []).filter(function (s) { return s && isNum(s.t) && s.kps; });

    var envelope = {
      analysisType: PGI.ANALYSIS_TYPE,
      schemaVersion: PGI.SCHEMA_VERSION,
      modelVersion: PGI.MODEL_VERSION,
      method: 'video_kinematics',
      isValidated: false,
      conditionLabel: input.conditionLabel || null,
      disclaimer: PGI.DISCLAIMER,
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: null,
      limitations: LIMITATIONS.slice()
    };

    if (samples.length < 12) {
      envelope.reason = 'insufficient_samples';
      envelope.quality = { flags: [KFO.QUALITY_FLAG.INSUFFICIENT_STRIDES] };
      return envelope;
    }

    // ── Direction and surface ──
    var direction = KFO.inferRunningDirection(samples);
    if (direction.direction === KFO.RUNNING_DIRECTION.UNKNOWN) {
      envelope.reason = 'running_direction_unknown';
      envelope.quality = { flags: [KFO.QUALITY_FLAG.UNSTABLE_RUNNING_DIRECTION] };
      return envelope;
    }
    var surface = PGI.inferSurfaceType(input.surfaceType, direction);

    // ── Stance intervals + support geometry (shared with the KFO detector) ──
    // ── Stance edges anchored to the USER'S phase selections ──
    //
    // The product flow already makes the user review L/R initial-contact and
    // toe-off frames on the phase cards (scrubber, "Analyze this frame"). Those
    // picks are the ground truth here:
    //
    //   1. The auto-detected stance that overlaps a side's picks is replaced by
    //      the EXACT user times (source: user_phase_selection).
    //   2. The measured auto-vs-user delta on that stance is the clip's
    //      systematic plateau-edge bias for that side, so the same correction is
    //      applied to the side's OTHER stances (source: user_bias_corrected) —
    //      multi-stride timing keeps its sample size without keeping the bias.
    //
    // Corrections land at the stance-detection source, so every consumer —
    // timing, phase windows, COM steps, touchdown windows — reads the same
    // corrected intervals. Minimum COM stays auto-detected within them.
    var userAnchors = buildUserAnchors(samples, input.userStanceEvents);
    var stanceOv = userAnchors.any
      ? userAnchors.overrides
      : (input.stanceOverrides || null);
    var geomLeft = KFOAnalysis.analyzeSide(samples, 'left', direction,
      KFOEstimators.GeometryProxyEstimator, undefined, stanceOv ? stanceOv.left : null);
    var geomRight = KFOAnalysis.analyzeSide(samples, 'right', direction,
      KFOEstimators.GeometryProxyEstimator, undefined, stanceOv ? stanceOv.right : null);
    var stanceIntervals = { left: geomLeft.stanceIntervals, right: geomRight.stanceIntervals };

    var durationSeconds = samples[samples.length - 1].t - samples[0].t;
    var effectiveRate = durationSeconds > 0 ? samples.length / durationSeconds : null;
    var legLengthPx = PGI.medianLegLengthPx(samples);

    // ── Steady-speed / camera / occlusion context ──
    var steady = KFOAnalysis.assessSteadySpeed(
      (geomLeft.stanceIntervals.length >= geomRight.stanceIntervals.length
        ? KFOAnalysis.detectStanceIntervals(samples, 'left')
        : KFOAnalysis.detectStanceIntervals(samples, 'right')).accepted, direction);
    var perpendicularity = KFOAnalysis.assessPerpendicularity(samples);
    var occlusion = KFOAnalysis.occlusionRate(samples);
    var poseConfs = samples.map(function (s) { return s.conf; }).filter(isNum);
    var meanPoseConfidence = poseConfs.length
      ? poseConfs.reduce(function (a, b) { return a + b; }, 0) / poseConfs.length : null;

    // ── Stride timing + vertical projection ──
    var timing = PGITiming.analyze({
      leftStanceIntervals: stanceIntervals.left,
      rightStanceIntervals: stanceIntervals.right,
      effectiveSampleRateHz: effectiveRate,
      bodyMassKg: input.bodyMassKg == null ? null : input.bodyMassKg,
      steadySpeed: steady,
      qualityFlags: []
    });

    // ── COM trajectory (also yields the ballistic-implied calibration) ──
    var heightCal = isNum(input.userHeightMeters)
      ? PGI.calibrationFromHeight(samples, input.userHeightMeters) : null;
    var com = PGICom.analyze({
      samples: samples,
      steps: timing.steps || [],
      legLengthPx: legLengthPx,
      userHeightCalibration: heightCal,
      directionSign: direction.sign,
      minComOverrides: input.minComOverrides || null,
      smoothing: input.smoothing
    });
    var calibration = (com.availability === KFO.AVAILABILITY.AVAILABLE && com.calibration)
      ? com.calibration
      : PGI.selectCalibration([heightCal]);

    // ── Speed ──
    var speedContext = PGI.resolveSpeed({
      userSpeedMps: input.userSpeedMps,
      treadmillSpeedMps: input.treadmillSpeedMps,
      samples: samples,
      direction: direction,
      calibration: calibration,
      surfaceType: surface.surfaceType
    });

    // ── Touchdown preparation ──
    var denseRate = null;
    if (input.denseWindows && input.denseWindows.length) {
      var rates = input.denseWindows.map(function (g) {
        var ts = (g.samples || []).map(function (s) { return s.t; }).filter(isNum);
        if (ts.length < 2) return null;
        var span = Math.max.apply(null, ts) - Math.min.apply(null, ts);
        return span > 0 ? ts.length / span : null;
      }).filter(isNum);
      denseRate = median(rates);
    }
    var touchdown = PGITouchdown.analyze({
      samples: samples,
      denseWindows: input.denseWindows,
      densePreContactRateHz: denseRate,
      stanceIntervals: stanceIntervals,
      directionSign: direction.sign,
      legLengthPx: legLengthPx,
      calibration: calibration,
      effectiveSampleRateHz: effectiveRate,
      surfaceType: surface.surfaceType,
      treadmillSpeedMps: input.treadmillSpeedMps == null ? null : input.treadmillSpeedMps,
      smoothing: input.smoothing
    });

    // ── Quality flags and confidence ──
    var strideSds = [];
    [geomLeft, geomRight].forEach(function (sd) {
      KFO.PHASE_ORDER.forEach(function (p) {
        if (sd.phases[p] && isNum(sd.phases[p].angle.sd)) strideSds.push(sd.phases[p].angle.sd);
      });
    });
    var medianSamplesPerStance = median([geomLeft.medianSamplesPerStance,
                                         geomRight.medianSamplesPerStance].filter(isNum));
    var flags = buildQuality({
      kfoContext: {
        effectiveFps: effectiveRate,
        medianSamplesPerStance: medianSamplesPerStance,
        perpendicularity: perpendicularity,
        meanPoseConfidence: meanPoseConfidence,
        occlusion: occlusion,
        minStrides: Math.min(geomLeft.stridesAnalyzed, geomRight.stridesAnalyzed),
        meanEventConfidence: null,
        speedMps: speedContext.speedMps,
        gradePercent: null,
        steady: steady,
        direction: direction,
        maxStrideSd: strideSds.length ? Math.max.apply(null, strideSds) : null
      },
      calibration: calibration,
      surfaceType: surface.surfaceType,
      treadmillSpeedMps: input.treadmillSpeedMps,
      velocityWindow: touchdown.velocityWindow,
      denseRequested: !!(input.denseWindows && input.denseWindows.length),
      denseUsed: !!(touchdown.densePreContactSampling && touchdown.densePreContactSampling.used),
      minimumComReliability: com.minimumComReliability || null,
      comAvailable: com.availability === KFO.AVAILABILITY.AVAILABLE
    });
    var confidence = KFO.computeConfidence({
      poseConfidence: meanPoseConfidence,
      samplesInStance: medianSamplesPerStance,
      strideSem: null,
      flags: flags
    });

    // ── Outcome + arms ──
    var strideSeconds = (timing.timing && timing.timing.overall && timing.timing.overall.stepSeconds &&
                         isNum(timing.timing.overall.stepSeconds.median))
      ? timing.timing.overall.stepSeconds.median * 2 : null;
    var outcome = PGIOutcome.analyzeStrideOutcome({
      timing: timing, com: com, speedContext: speedContext,
      calibration: calibration, surfaceType: surface.surfaceType,
      userHeightMeters: input.userHeightMeters, legLengthPx: legLengthPx
    });
    var arms = PGIOutcome.analyzeArmCarriage({
      samples: samples, directionSign: direction.sign,
      legLengthPx: legLengthPx, strideSeconds: strideSeconds
    });

    var rebound = buildRebound(com, timing);

    // ── Four-phase stride model (minimum-COM landmark) ──
    var phases = PGIPhases.analyze({
      samples: samples,
      com: com,
      timing: timing,
      outcome: outcome,
      directionSign: direction.sign,
      legLengthPx: legLengthPx,
      calibration: calibration,
      effectiveSampleRateHz: effectiveRate,
      smoothing: input.smoothing
    });

    // ── Envelope ──
    envelope.video = {
      fps: isNum(meta.fps) ? meta.fps : null,
      effectiveSampleRateHz: effectiveRate,
      width: isNum(meta.width) ? meta.width : null,
      height: isNum(meta.height) ? meta.height : null,
      durationSeconds: durationSeconds,
      runningDirection: direction.direction,
      runningDirectionSource: direction.source,
      runningDirectionConfidence: direction.confidence,
      mirroredSuspected: !!direction.mirroredSuspected,
      surfaceType: surface.surfaceType,
      surfaceTypeSource: surface.source,
      treadmillSpeedMps: input.treadmillSpeedMps == null ? null : input.treadmillSpeedMps,
      speedMps: speedContext.speedMps,
      speedSource: speedContext.speedSource,
      speedConfidence: speedContext.speedConfidence,
      speedNote: speedContext.note,
      calibration: calibration,
      legLengthPx: legLengthPx
    };
    envelope.quality = {
      flags: flags,
      flagLabels: flags.map(PGI.flagLabel),
      confidence: confidence,
      confidenceBand: KFO.confidenceBand(confidence.score),
      meanPoseConfidence: meanPoseConfidence,
      occlusion: occlusion,
      perpendicularity: perpendicularity,
      steadySpeed: steady,
      stancesDetected: { left: stanceIntervals.left.length, right: stanceIntervals.right.length },
      stepsAnalyzed: timing.stepsAnalyzed || 0,
      medianSamplesPerStance: medianSamplesPerStance
    };
    envelope.touchdownPreparation = touchdown;
    // Support-line angles are RETAINED but DEMOTED: descriptive geometry, never
    // a score, never a force direction, and never matched against an elite
    // template. The vocabulary is braking-oriented / vertical / propulsive-
    // oriented support geometry.
    envelope.supportGeometry = {
      availability: (geomLeft.stridesAnalyzed || geomRight.stridesAnalyzed)
        ? KFO.AVAILABILITY.AVAILABLE : KFO.AVAILABILITY.UNAVAILABLE,
      role: 'secondary_descriptive_geometry',
      note: 'Support-line orientation at three normalised stance windows. This is body geometry, ' +
        'not a measured force direction, and it is not scored.',
      vocabulary: {
        early_stance: 'braking-oriented support geometry',
        central_stance: 'vertical support alignment',
        late_stance: 'propulsive-oriented support geometry'
      },
      windows: KFO.PHASE_WINDOWS,
      signConvention: 'negative = support point ahead of the COM (braking-oriented); ' +
        'positive = behind (propulsive-oriented)',
      supportPointModel: KFO.SUPPORT_POINT_MODEL,
      left: { side: 'left', stridesAnalyzed: geomLeft.stridesAnalyzed, phases: geomLeft.phases,
              stanceIntervals: geomLeft.stanceIntervals },
      right: { side: 'right', stridesAnalyzed: geomRight.stridesAnalyzed, phases: geomRight.phases,
               stanceIntervals: geomRight.stanceIntervals },
      symmetry: KFOAnalysis.buildSymmetry(geomLeft, geomRight),
      coupledPattern: {
        left: KFO.classifyCoupledPattern(
          geomLeft.phases[KFO.PHASE.EARLY_STANCE].angle.median,
          geomLeft.phases[KFO.PHASE.LATE_STANCE].angle.median),
        right: KFO.classifyCoupledPattern(
          geomRight.phases[KFO.PHASE.EARLY_STANCE].angle.median,
          geomRight.phases[KFO.PHASE.LATE_STANCE].angle.median)
      }
    };
    envelope.strideTiming = timing.timing
      ? {
          availability: timing.availability,
          overall: timing.timing.overall, left: timing.timing.left, right: timing.timing.right,
          stepsAnalyzed: timing.stepsAnalyzed, stepsRejected: timing.stepsRejected,
          rejections: timing.rejections, gaitValidity: timing.gaitValidity,
          uncertainty: timing.timing.uncertainty, definitionNote: timing.timing.definitionNote,
          // Runtime only — the research export reads these; toStoredForm drops them.
          steps: timing.steps || []
        }
      : { availability: timing.availability, reason: timing.reason,
          stepsAnalyzed: timing.stepsAnalyzed, stepsRejected: timing.stepsRejected,
          rejections: timing.rejections, gaitValidity: timing.gaitValidity };
    envelope.verticalProjection = timing.projection
      ? {
          availability: timing.projection.availability,
          method: timing.projection.method,
          assumptions: timing.projection.assumptions,
          note: timing.projection.note,
          overall: timing.projection.overall,
          left: timing.projection.left, right: timing.projection.right,
          verticalSupport: timing.verticalSupport
        }
      : { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: timing.reason,
          verticalSupport: timing.verticalSupport };
    envelope.comTrajectory = com;
    envelope.rebound = rebound;
    // The four-phase blocks. minimumCom is exposed even when the joint-angle
    // pass could not run, because the landmark itself only needs the COM pass.
    envelope.minimumCom = (com.availability === KFO.AVAILABILITY.AVAILABLE && com.minimumCom)
      ? {
          availability: KFO.AVAILABILITY.AVAILABLE,
          overall: com.minimumCom.overall,
          left: com.minimumCom.left,
          right: com.minimumCom.right,
          reliability: com.minimumComReliability,
          note: com.minimumCom.note,
          definition: phases.definition ? phases.definition.minimumCom : null
        }
      : { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: com.reason || 'com_trajectory_unavailable' };
    envelope.loadingCompression = phases.availability === KFO.AVAILABILITY.AVAILABLE
      ? {
          availability: KFO.AVAILABILITY.AVAILABLE,
          definition: phases.definition.loadingCompression,
          overall: phases.loadingCompression.overall,
          left: phases.loadingCompression.left,
          right: phases.loadingCompression.right,
          note: phases.loadingCompression.note
        }
      : { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: phases.reason };
    envelope.reboundProjection = phases.availability === KFO.AVAILABILITY.AVAILABLE
      ? {
          availability: KFO.AVAILABILITY.AVAILABLE,
          definition: phases.definition.reboundProjection,
          overall: phases.reboundProjection.overall,
          left: phases.reboundProjection.left,
          right: phases.reboundProjection.right,
          note: phases.reboundProjection.note,
          outcomeChain: phases.outcomeChain,
          movementSummary: phases.movementSummary,
          stepPhases: phases.stepPhases   // runtime/export only; not persisted
        }
      : { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: phases.reason };
    envelope.strideOutcome = outcome;
    envelope.armCarriage = arms;

    var interpreted = PGIPatterns.interpret({
      touchdown: touchdown, timing: timing, com: com, outcome: outcome,
      phases: phases,
      quality: envelope.quality
    });
    envelope.patterns = interpreted.patterns;
    envelope.domains = interpreted.domains;
    envelope.symmetry = buildSymmetry({
      touchdown: touchdown, timing: timing, com: com, geometry: envelope.supportGeometry,
      phases: phases
    });
    envelope.comparison = null;

    // ── Landmark verification record ──
    // Assembled from the interval tags so it reflects what was actually applied,
    // not what the caller intended to apply.
    var verifiedIvs = [], adjustedIvs = 0, vCorrections = [];
    [geomLeft, geomRight].forEach(function (sd) {
      (sd.stanceIntervals || []).forEach(function (iv) {
        if (iv.verified) verifiedIvs.push(iv);
        if (iv.manualAdjustment) {
          adjustedIvs++;
          if (iv.manualAdjustment.adjustedBy === 'user_bias_corrected') return;
          if (iv.manualAdjustment.autoStartTime !== iv.startTime) {
            vCorrections.push({ side: sd.side, event: 'touchdown',
              autoTimeSeconds: round(iv.manualAdjustment.autoStartTime, 4),
              adjustedTimeSeconds: round(iv.startTime, 4),
              deltaMs: Math.round((iv.startTime - iv.manualAdjustment.autoStartTime) * 1000) });
          }
          if (iv.manualAdjustment.autoEndTime !== iv.endTime) {
            vCorrections.push({ side: sd.side, event: 'toeoff',
              autoTimeSeconds: round(iv.manualAdjustment.autoEndTime, 4),
              adjustedTimeSeconds: round(iv.endTime, 4),
              deltaMs: Math.round((iv.endTime - iv.manualAdjustment.autoEndTime) * 1000) });
          }
        }
      });
    });
    (input.minComOverrides || []).forEach(function (o) {
      if (o && isNum(o.time)) {
        vCorrections.push({ side: o.side, event: 'minimumCom',
          adjustedTimeSeconds: round(o.time, 4) });
      }
    });
    var totalIvs = (geomLeft.stanceIntervals || []).length + (geomRight.stanceIntervals || []).length;
    envelope.verification = {
      landmarksVerified: totalIvs > 0 && verifiedIvs.length === totalIvs,
      source: userAnchors.any ? 'user_phase_selection' : (input.stanceOverrides ? 'manual_verification' : null),
      anchors: userAnchors.any ? userAnchors.anchors : null,
      stancesVerified: verifiedIvs.length,
      stancesTotal: totalIvs,
      stancesAdjusted: adjustedIvs,
      corrections: vCorrections,
      propagationMode: userAnchors.any ? userAnchors.propagationMode : null,
      note: userAnchors.any
        ? (userAnchors.propagationMode === 'full'
            ? 'Stance edges are anchored to the initial-contact and toe-off frames selected on the ' +
              'phase cards; sibling stances carry the same measured edge correction. Minimum COM ' +
              'remains auto-detected within those edges.'
            : userAnchors.propagationMode === 'shift_only'
              ? 'Stance edges are anchored to the frames selected on the phase cards. The full edge ' +
                'correction would have made neighbouring stances overlap, so sibling stances carry ' +
                'only the timing shift, not the width change.'
              : 'Stance edges are anchored to the frames selected on the phase cards. The measured ' +
                'edge correction could not be applied to sibling stances without breaking step ' +
                'detection, so they remain on their automatic edges.')
        : verifiedIvs.length
          ? 'Stance landmarks were reviewed; automatic times are retained beside any corrections.'
          : 'Stance landmarks are automatic and have not been human-verified.'
    };

    var anyDomain = (timing.availability === KFO.AVAILABILITY.AVAILABLE) ||
                    (com.availability === KFO.AVAILABILITY.AVAILABLE) ||
                    (touchdown.availability === KFO.AVAILABILITY.AVAILABLE);
    envelope.availability = anyDomain
      ? (confidence.score < 0.25 ? KFO.AVAILABILITY.INSUFFICIENT_QUALITY : KFO.AVAILABILITY.AVAILABLE)
      : KFO.AVAILABILITY.UNAVAILABLE;
    if (!anyDomain) envelope.reason = 'no_usable_gait_events_detected';

    return envelope;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Aggregate-only projection for Firestore.
   *
   * Kept: every aggregate a reader needs, the pattern list, the domain summary,
   * and the two NORMALISED trajectory paths — those are small and are what make
   * a saved session still able to draw its charts.
   *
   * Dropped: per-step and per-contact records, raw and smoothed series, stance
   * sample buffers, and anything holding keypoints.
   */
  function toStoredForm(result) {
    if (!result) return null;

    /**
     * Static prose is NOT persisted. Notes, vocabularies, sign conventions,
     * assumption lists and the standing limitation list are the same in every
     * document, would go stale the moment the wording improves, and are rebuilt
     * at read time by `rehydrateStatic()`. Anything containing a COMPUTED value
     * — a pattern's observations, the uncertainty caveats — is kept verbatim,
     * because that is the record of what the analysis actually said.
     */
    function withoutNote(o) {
      if (!o || typeof o !== 'object') return o || null;
      var out = {};
      Object.keys(o).forEach(function (k) {
        if (k === 'note' || k === 'notes' || k === 'confidenceCaveat') return;
        out[k] = o[k];
      });
      return out;
    }

    // `mean` is dropped throughout: medians lead everywhere in this feature.
    //
    // `ci95` is kept only where pgi-compare's variability test actually reads it
    // — the timing, projection, rebound-rate and outcome metrics it pulls with
    // `fromAggregate`. Metrics it reads as bare scalars (touchdown, support
    // geometry, arms, COM decomposition) keep n and sd for display and drop the
    // interval, which is reconstructible from them.
    function aggLite(a, withCi) {
      if (!a || !isNum(a.median)) return null;
      var o = { n: a.n, median: round(a.median, 4), sd: round(a.sd, 4) };
      if (withCi !== false && a.ci95) o.ci95 = [round(a.ci95[0], 4), round(a.ci95[1], 4)];
      return o;
    }
    function aggDisplay(a) { return aggLite(a, false); }
    // Pixel aggregates are dropped: they are meaningless outside this clip's
    // coordinate space, and the leg-length normalisation is the portable form.
    function lengthLite(v) {
      if (!v) return null;
      return { n: v.px ? v.px.n : null,
               medianLegLengths: round(v.medianLegLengths, 4),
               medianCentimeters: round(v.medianCentimeters, 2) };
    }
    function velLite(v) {
      if (!v) return null;
      return { n: v.pxPerS ? v.pxPerS.n : null,
               medianLegLengthsPerS: round(v.medianLegLengthsPerS, 4),
               medianMps: round(v.medianMps, 4) };
    }
    /** Stored paths are downsampled: a 25-point chart reads the same at 13. */
    function downsample(points) {
      if (!points || points.length <= 13) return points;
      return points.filter(function (_, i) { return i % 2 === 0 || i === points.length - 1; });
    }
    /**
     * Trajectories persist as PARALLEL ARRAYS rather than an array of objects:
     * the same 25 points cost about a third as much without losing a value, and
     * a saved session can still draw its charts.
     */
    function pathLite(p) {
      if (!p || !p.points) return null;
      var out = { unit: p.unit, referencedTo: p.referencedTo };
      var pts = downsample(p.points);
      function col(key, get, dp) {
        var vals = pts.map(get);
        if (vals.some(isNum)) out[key] = vals.map(function (v) { return isNum(v) ? round(v, dp) : null; });
      }
      col('t', function (q) { return q.tMsFromTouchdown; }, 0);
      col('pct', function (q) { return q.pct; }, 0);
      col('w', function (q) { return q.worldForward; }, 3);
      // Touchdown paths carry `height`; the COM step path carries `h`.
      col('h', function (q) { return isNum(q.height) ? q.height : q.h; }, 3);
      col('c', function (q) { return q.comRelativeForward; }, 3);
      return out;
    }

    function timingBlockLite(b) {
      if (!b) return null;
      return {
        n: b.n,
        stepSeconds: aggLite(b.stepSeconds), contactSeconds: aggLite(b.contactSeconds),
        flightSeconds: aggLite(b.flightSeconds), dutyFactor: aggLite(b.dutyFactor),
        flightFraction: aggLite(b.flightFraction), cadenceSpm: aggLite(b.cadenceSpm)
      };
    }
    function projectionBlockLite(b) {
      if (!b) return null;
      return {
        flightSeconds: aggLite(b.flightSeconds),
        verticalTakeoffVelocityMps: aggLite(b.verticalTakeoffVelocityMps),
        effectiveVerticalImpulsePerMassNsPerKg: aggLite(b.effectiveVerticalImpulsePerMassNsPerKg),
        aerialRiseBallisticMeters: aggLite(b.aerialRiseBallisticMeters)
      };
    }
    function decompLite(b) {
      if (!b) return null;
      return {
        n: b.n,
        stanceCompression: lengthLite(b.stanceCompression),
        stanceRebound: lengthLite(b.stanceRebound),
        aerialRiseMeasured: lengthLite(b.aerialRiseMeasured),
        verticalOscillation: lengthLite(b.verticalOscillation)
      };
    }
    function touchdownSideLite(s) {
      if (!s) return null;
      if (s.availability !== KFO.AVAILABILITY.AVAILABLE) {
        return { side: s.side, availability: s.availability, reason: s.reason || null };
      }
      // Metrics that are the same quantity in a second unit are NOT stored:
      // leg lengths and metres differ by the stored calibration and leg length,
      // and a median divided by a constant is still the median.
      var a = s.aggregate, keep = {};
      ['footComOffsetAtTouchdownLegLengths', 'maxAnteriorExcursionLegLengths',
       'timeFromMaxAnteriorToTouchdownMs', 'retractionTimeMs',
       'retractionDistanceComLegLengths', 'meanRetractionVelocityMps',
       'peakRetractionVelocityMps', 'horizontalFootVelocityMps', 'verticalFootVelocityMps',
       'resultantFootVelocityMps', 'approachAngleDegrees',
       'footVelocityRelativeToComLegLengthsPerS', 'horizontalVelocityChangeMps',
       'footGroundVelocityMps'].forEach(function (k) { keep[k] = aggDisplay(a[k]); });
      keep.clearRetractionFraction = round(a.clearRetractionFraction, 3);
      keep.n = a.n;
      // The pattern's observations, alternatives and supporting metrics are
      // carried once, in `patterns[]`. Keeping a second copy here would double
      // the largest block in the document to say the same thing twice.
      var bp = s.brakingPattern;
      return {
        side: s.side, availability: s.availability,
        contactsExamined: s.contactsExamined, contactsUsed: s.contactsUsed,
        aggregate: keep,
        brakingPattern: {
          pattern: bp.pattern, confidence: round(bp.confidence, 3), evidence: bp.evidence
        },
        meanPath: pathLite(s.meanPath)
      };
    }
    function geometrySideLite(s) {
      if (!s || !s.phases) return null;
      var phases = {};
      KFO.PHASE_ORDER.forEach(function (p) {
        var ph = s.phases[p];
        if (!ph) return;
        // Labels and window bounds are static (KFO.PHASE_WINDOWS) and are
        // rebuilt at read time rather than written into every document.
        phases[p] = {
          angle: aggDisplay(ph.angle),
          comLegDivergence: aggDisplay(ph.comLegDivergence),
          confidence: ph.confidence ? round(ph.confidence.score, 3) : null,
          uncertaintyDegrees: ph.confidence ? round(ph.confidence.angleUncertaintyDegrees, 2) : null
        };
      });
      return { side: s.side, stridesAnalyzed: s.stridesAnalyzed, phases: phases };
    }

    function coupledLite(c) {
      if (!c) return null;
      return {
        pattern: c.pattern,
        foreAftGeometricExcursionDegrees: round(c.foreAftGeometricExcursionDegrees, 2),
        brakingMagnitudeDegrees: round(c.brakingMagnitudeDegrees, 2),
        propulsiveMagnitudeDegrees: round(c.propulsiveMagnitudeDegrees, 2)
      };
    }

    function armSideLite(s) {
      if (!s) return null;
      if (s.availability !== KFO.AVAILABILITY.AVAILABLE) {
        return { side: s.side, availability: s.availability, reason: s.reason || null };
      }
      return {
        side: s.side, availability: s.availability,
        landmarkConfidence: round(s.landmarkConfidence, 3),
        elbowAngleDegrees: aggDisplay(s.elbowAngleDegrees),
        maxAnteriorWristExcursionLegLengths: round(s.maxAnteriorWristExcursionLegLengths, 4),
        maxPosteriorWristExcursionLegLengths: round(s.maxPosteriorWristExcursionLegLengths, 4),
        wristExcursionRangeLegLengths: round(s.wristExcursionRangeLegLengths, 4),
        totalArmAngularExcursionDegrees: round(s.totalArmAngularExcursionDegrees, 2)
      };
    }

    // ── Four-phase blocks (compact) ──
    // Per-side joint blocks keep only the CHANGE aggregates; the overall block
    // keeps the endpoint angles too. The permanently-unavailable ankle/pelvis
    // markers and all static notes are rebuilt at read time.
    function jointLite(j, full) {
      if (!j || j.availability === 'unavailable') return null;
      var o = { changeDegrees: aggDisplay(j.changeDegrees) };
      if (full) {
        o.angleAtStartDegrees = aggDisplay(j.angleAtStartDegrees);
        o.angleAtEndDegrees = aggDisplay(j.angleAtEndDegrees);
      }
      return o;
    }
    function jointChangesLite(jc, full) {
      if (!jc) return null;
      return { hip: jointLite(jc.hip, full), knee: jointLite(jc.knee, full),
               trunk: jointLite(jc.trunk, full), shank: jointLite(jc.shank, full) };
    }
    // Side blocks store the compact core (duration, depth/rise, rise velocity);
    // the overall block carries joint endpoints, support geometry, fractions and
    // the toe-off velocity pair. Side-to-side deltas persist in
    // symmetry.stancePhases, so the per-side detail is not duplicated here.
    function minComSideLite(b, full) {
      if (!b || !b.n) return b ? { n: 0 } : null;
      var o = {
        n: b.n,
        stancePercent: full ? aggLite(b.stancePercent) : aggDisplay(b.stancePercent),
        confidence: aggDisplay(b.confidence)
      };
      if (full) {
        o.flagCounts = (b.flagCounts && Object.keys(b.flagCounts).length) ? b.flagCounts : null;
        o.detectionMethod = b.detectionMethod;
      }
      return o;
    }
    function loadingSideLite(b, full) {
      if (!b || !b.n) return b ? { n: 0 } : null;
      var o = {
        n: b.n,
        durationMs: full ? aggLite(b.durationMs) : aggDisplay(b.durationMs),
        compression: lengthLite(b.compression)
      };
      if (full) {
        o.fractionOfStance = aggLite(b.fractionOfStance);
        o.horizontalTravel = lengthLite(b.horizontalTravel);
        o.jointChanges = jointChangesLite(b.jointChanges, true);
        o.supportGeometry = b.supportGeometry ? {
          angleAtTouchdownDegrees: aggDisplay(b.supportGeometry.angleAtTouchdownDegrees),
          angleAtMinimumComDegrees: aggDisplay(b.supportGeometry.angleAtMinimumComDegrees)
        } : null;
      }
      return o;
    }
    function reboundSideLite(b, full) {
      if (!b || !b.n) return b ? { n: 0 } : null;
      var vto = b.verticalVelocityAtToeoff || {};
      var o = {
        n: b.n,
        durationMs: full ? aggLite(b.durationMs) : aggDisplay(b.durationMs),
        comRise: lengthLite(b.comRise),
        meanComRiseVelocity: velLite(b.meanComRiseVelocity)
      };
      if (full) {
        o.fractionOfStance = aggLite(b.fractionOfStance);
        o.horizontalTravel = lengthLite(b.horizontalTravel);
        o.verticalVelocityAtToeoff = {
          poseDerived: velLite(vto.poseDerived),
          ballisticFromFlightMps: aggLite(vto.ballisticFromFlightMps),
          agreement: (vto.agreement && isNum(vto.agreement.medianRelativeError)) ? {
            medianRelativeError: round(vto.agreement.medianRelativeError, 4),
            isIndependent: vto.agreement.isIndependent
          } : null
        };
        o.compressionToReboundRatio = aggLite(b.compressionToReboundRatio);
        o.jointChanges = jointChangesLite(b.jointChanges, true);
        o.supportGeometry = b.supportGeometry ? {
          angleAtMinimumComDegrees: aggDisplay(b.supportGeometry.angleAtMinimumComDegrees),
          angleAtLateStanceDegrees: aggDisplay(b.supportGeometry.angleAtLateStanceDegrees)
        } : null;
        o.comVelocityAtMinimum = velLite(b.comVelocityAtMinimum);
        if (b.meanVerticalAccelerationProxy && b.meanVerticalAccelerationProxy.pxPerS2) {
          o.meanVerticalAccelerationProxy = {
            medianLegLengthsPerS2: round(b.meanVerticalAccelerationProxy.medianLegLengthsPerS2, 3),
            medianMps2: round(b.meanVerticalAccelerationProxy.medianMps2, 3)
          };
        }
      }
      return o;
    }
    function chainLite(c) {
      if (!c) return null;
      return {
        minimumComStancePercent: round(c.minimumComStancePercent, 2),
        reboundRiseLegLengths: round(c.reboundRiseLegLengths, 4),
        reboundRiseCentimeters: round(c.reboundRiseCentimeters, 2),
        reboundDurationMs: round(c.reboundDurationMs, 1),
        verticalVelocityAtToeoffMps: round(c.verticalVelocityAtToeoffMps, 4),
        flightSeconds: round(c.flightSeconds, 4),
        aerialRiseBallisticMeters: round(c.aerialRiseBallisticMeters, 5),
        strideLengthMeters: round(c.strideLengthMeters, 3)
      };
    }

    var td = result.touchdownPreparation || {};
    var com = result.comTrajectory || {};
    var sg = result.supportGeometry || {};
    var vp = result.verticalProjection || {};
    var st = result.strideTiming || {};
    var so = result.strideOutcome || {};
    var rb = result.rebound || {};
    var mc = result.minimumCom || {};
    var lc = result.loadingCompression || {};
    var rp = result.reboundProjection || {};

    return {
      analysisType: result.analysisType,
      schemaVersion: result.schemaVersion,
      modelVersion: result.modelVersion,
      isValidated: false,
      availability: result.availability,
      reason: result.reason || null,
      conditionLabel: result.conditionLabel || null,
      video: result.video ? {
        fps: result.video.fps,
        effectiveSampleRateHz: round(result.video.effectiveSampleRateHz, 2),
        durationSeconds: round(result.video.durationSeconds, 3),
        runningDirection: result.video.runningDirection,
        surfaceType: result.video.surfaceType,
        surfaceTypeSource: result.video.surfaceTypeSource,
        treadmillSpeedMps: result.video.treadmillSpeedMps,
        speedMps: round(result.video.speedMps, 3),
        speedSource: result.video.speedSource,
        speedConfidence: round(result.video.speedConfidence, 3),
        calibration: result.video.calibration ? {
          source: result.video.calibration.source,
          pixelsPerMeter: round(result.video.calibration.pixelsPerMeter, 3),
          isMeasured: !!result.video.calibration.isMeasured
        } : null,
        legLengthPx: round(result.video.legLengthPx, 2)
      } : null,
      quality: result.quality ? {
        flags: result.quality.flags,
        confidenceScore: round(result.quality.confidence ? result.quality.confidence.score : null, 3),
        confidenceBand: result.quality.confidenceBand,
        stepsAnalyzed: result.quality.stepsAnalyzed,
        stancesDetected: result.quality.stancesDetected,
        medianSamplesPerStance: result.quality.medianSamplesPerStance
      } : null,
      touchdownPreparation: {
        availability: td.availability,
        reason: td.reason || null,
        footRepresentation: td.footRepresentation || null,
        preContactWindowMs: td.preContactWindowMs || null,
        velocityWindow: td.velocityWindow || null,
        densePreContactSampling: td.densePreContactSampling
          ? { used: td.densePreContactSampling.used, reason: td.densePreContactSampling.reason } : null,
        left: touchdownSideLite(td.left), right: touchdownSideLite(td.right),
        asymmetry: withoutNote(td.asymmetry)
      },
      supportGeometry: {
        availability: sg.availability,
        left: geometrySideLite(sg.left), right: geometrySideLite(sg.right),
        symmetry: withoutNote(sg.symmetry),
        coupledPattern: sg.coupledPattern ? {
          // The interpretation string is static per pattern enum; the enum and
          // the degree values are what were computed.
          left: withoutNote(coupledLite(sg.coupledPattern.left)),
          right: withoutNote(coupledLite(sg.coupledPattern.right))
        } : null
      },
      strideTiming: {
        availability: st.availability, reason: st.reason || null,
        stepsAnalyzed: st.stepsAnalyzed, stepsRejected: st.stepsRejected,
        gaitValidity: st.gaitValidity || null,
        overall: timingBlockLite(st.overall),
        left: timingBlockLite(st.left), right: timingBlockLite(st.right)
      },
      // Static assumption/limitation prose is NOT persisted — it would bloat
      // every document and go stale the moment the wording improves. A reader
      // gets the current text from pgi-timing.js. Per-side projection blocks are
      // dropped too: take-off velocity and effective impulse are linear in
      // flight time, which is stored per side in strideTiming.
      verticalProjection: {
        availability: vp.availability, method: vp.method || null,
        overall: projectionBlockLite(vp.overall),
        verticalSupport: vp.verticalSupport ? {
          availability: vp.verticalSupport.availability,
          reason: vp.verticalSupport.reason || null,
          method: vp.verticalSupport.method,
          isValidated: false,
          meanVerticalSupportBW: aggLite(vp.verticalSupport.meanVerticalSupportBW),
          peakVerticalSupportBW: aggLite(vp.verticalSupport.peakVerticalSupportBW),
          conditions: vp.verticalSupport.conditions || null,
          relativeUncertainty: round(vp.verticalSupport.relativeUncertainty, 4),
          caveats: vp.verticalSupport.caveats || null
        } : null
      },
      comTrajectory: {
        availability: com.availability, reason: com.reason || null,
        stepsAnalyzed: com.stepsAnalyzed || 0,
        decomposition: com.decomposition ? {
          overall: decompLite(com.decomposition.overall),
          left: decompLite(com.decomposition.left),
          right: decompLite(com.decomposition.right)
        } : null,
        flightCrossCheck: com.flightCrossCheck ? {
          availability: com.flightCrossCheck.availability,
          reason: com.flightCrossCheck.reason || null,
          n: com.flightCrossCheck.n || null,
          medianRelativeError: round(com.flightCrossCheck.medianRelativeError, 4),
          comVelocityConfidence: round(com.flightCrossCheck.comVelocityConfidence, 3),
          // Absent on the unavailable branches; Firestore rejects undefined.
          isIndependent: com.flightCrossCheck.isIndependent == null
            ? null : com.flightCrossCheck.isIndependent
        } : null,
        meanPath: pathLite(com.meanPath ? { unit: 'leg_lengths', referencedTo: 'step_minimum',
                                            points: com.meanPath } : null)
      },
      rebound: {
        availability: rb.availability, reason: rb.reason || null,
        stanceCompression: lengthLite(rb.stanceCompression),
        stanceRebound: lengthLite(rb.stanceRebound),
        contactSeconds: aggLite(rb.contactSeconds),
        comVelocityAtTouchdown: velLite(rb.comVelocityAtTouchdown),
        comVelocityAtToeoff: velLite(rb.comVelocityAtToeoff),
        verticalVelocityReversal: velLite(rb.verticalVelocityReversal),
        reversalRateLegLengthsPerS2: aggLite(rb.reversalRateLegLengthsPerS2),
        reversalRateMps2: aggLite(rb.reversalRateMps2)
      },
      minimumCom: mc.availability === KFO.AVAILABILITY.AVAILABLE ? {
        availability: mc.availability,
        overall: minComSideLite(mc.overall, true),
        left: minComSideLite(mc.left, false),
        right: minComSideLite(mc.right, false),
        reliability: mc.reliability ? {
          medianConfidence: round(mc.reliability.medianConfidence, 3),
          unreliable: !!mc.reliability.unreliable
        } : null
      } : { availability: mc.availability || null, reason: mc.reason || null },
      loadingCompression: lc.availability === KFO.AVAILABILITY.AVAILABLE ? {
        availability: lc.availability,
        overall: loadingSideLite(lc.overall, true),
        left: loadingSideLite(lc.left, false),
        right: loadingSideLite(lc.right, false)
      } : { availability: lc.availability || null, reason: lc.reason || null },
      reboundProjection: rp.availability === KFO.AVAILABILITY.AVAILABLE ? {
        availability: rp.availability,
        overall: reboundSideLite(rp.overall, true),
        left: reboundSideLite(rp.left, false),
        right: reboundSideLite(rp.right, false),
        outcomeChain: chainLite(rp.outcomeChain),
        // The movement summary is built from computed values, so it is stored
        // verbatim like pattern observations.
        movementSummary: (rp.movementSummary && rp.movementSummary.availability === 'available') ? {
          text: rp.movementSummary.text,
          patternNote: rp.movementSummary.patternNote || null
        } : null
      } : { availability: rp.availability || null, reason: rp.reason || null },
      strideOutcome: {
        availability: so.availability, reason: so.reason || null, method: so.method || null,
        speedMps: round(so.speedMps, 3), speedSource: so.speedSource,
        stepLengthMeters: aggLite(so.stepLengthMeters),
        strideLengthMeters: aggLite(so.strideLengthMeters),
        flightDistanceMeters: aggLite(so.flightDistanceMeters),
        stanceDistanceMeters: aggLite(so.stanceDistanceMeters),
        cadenceSpm: aggLite(so.cadenceSpm),
        flightDistanceShare: round(so.flightDistanceShare, 4),
        normalized: so.normalized ? {
          stepLengthPerLegLength: round(so.normalized.stepLengthPerLegLength, 4),
          stepLengthPerHeight: round(so.normalized.stepLengthPerHeight, 4),
          froudeNumber: round(so.normalized.froudeNumber, 4)
        } : null,
        crossCheck: so.crossCheck ? {
          availability: so.crossCheck.availability,
          relativeDifference: round(so.crossCheck.relativeDifference, 4)
        } : null,
        interpretation: withoutNote(so.interpretation)
      },
      armCarriage: result.armCarriage ? {
        availability: result.armCarriage.availability,
        reason: result.armCarriage.reason || null,
        left: armSideLite(result.armCarriage.left),
        right: armSideLite(result.armCarriage.right),
        asymmetry: withoutNote(result.armCarriage.asymmetry),
        armLegPhase: result.armCarriage.armLegPhase ? {
          left: withoutNote(result.armCarriage.armLegPhase.left),
          right: withoutNote(result.armCarriage.armLegPhase.right)
        } : null
      } : null,
      // Observations, the interpretation and the supporting metrics are the
      // record of what this analysis actually told the user, so they are kept
      // verbatim — several interpretations are built with computed values and
      // conditional caveats and could not be faithfully reconstructed. Only
      // `alternatives`, which is fixed text per pattern, is rebuilt at read time.
      patterns: (result.patterns || []).map(function (p) {
        return {
          pattern: p.pattern, domain: p.domain, confidence: round(p.confidence, 3),
          observations: p.observations, interpretation: p.interpretation,
          supportingMetrics: p.supportingMetrics,
          evidenceClasses: p.evidenceClasses, isValidated: false
        };
      }),
      verification: result.verification ? {
        landmarksVerified: !!result.verification.landmarksVerified,
        source: result.verification.source || null,
        propagationMode: result.verification.propagationMode || null,
        anchors: result.verification.anchors || null,
        stancesVerified: result.verification.stancesVerified,
        stancesTotal: result.verification.stancesTotal,
        stancesAdjusted: result.verification.stancesAdjusted,
        corrections: result.verification.corrections
      } : null,
      domains: withoutNote(result.domains),
      symmetry: withoutNote(result.symmetry),
      comparison: null
    };
  }

  /**
   * Restore the static prose a stored document deliberately omits, so a saved
   * analysis renders identically to a live one. Read-time only — it never
   * writes, and it never invents a computed value.
   */
  function rehydrateStatic(stored) {
    if (!stored) return null;
    var out = stored;
    out.disclaimer = PGI.DISCLAIMER;
    out.limitations = LIMITATIONS.slice();
    if (out.supportGeometry) {
      out.supportGeometry.role = 'secondary_descriptive_geometry';
      out.supportGeometry.note = 'Support-line orientation at three normalised stance windows. This ' +
        'is body geometry, not a measured force direction, and it is not scored.';
      out.supportGeometry.vocabulary = {
        early_stance: 'braking-oriented support geometry',
        central_stance: 'vertical support alignment',
        late_stance: 'propulsive-oriented support geometry'
      };
      out.supportGeometry.signConvention = 'negative = support point ahead of the COM ' +
        '(braking-oriented); positive = behind (propulsive-oriented)';
      out.supportGeometry.windows = KFO.PHASE_WINDOWS;
      ['left', 'right'].forEach(function (side) {
        var s = out.supportGeometry[side];
        if (!s || !s.phases) return;
        Object.keys(s.phases).forEach(function (p) {
          if (KFO.PHASE_WINDOWS[p]) {
            s.phases[p].label = KFO.PHASE_WINDOWS[p].label;
            s.phases[p].window = {
              minPercent: KFO.PHASE_WINDOWS[p].minPercent,
              maxPercent: KFO.PHASE_WINDOWS[p].maxPercent,
              targetPercent: KFO.PHASE_WINDOWS[p].targetPercent
            };
          }
        });
      });
      if (out.supportGeometry.coupledPattern) {
        ['left', 'right'].forEach(function (side) {
          var c = out.supportGeometry.coupledPattern[side];
          if (!c || !c.pattern) return;
          var re = KFO.classifyCoupledPattern(
            isNum(c.brakingMagnitudeDegrees) ? -c.brakingMagnitudeDegrees : null,
            isNum(c.propulsiveMagnitudeDegrees) ? c.propulsiveMagnitudeDegrees : null);
          c.interpretation = re.interpretation;
        });
      }
    }
    if (out.patterns) {
      out.patterns.forEach(function (p) {
        if (!p.alternatives) p.alternatives = PGIPatterns.alternativesFor(p.pattern);
      });
    }

    // ── Four-phase static prose ──
    var MIN_COM_DEFINITION = 'Kinematic reversal point of vertical COM motion (vertical COM ' +
      'velocity ≈ 0). Not the onset of propulsive force, and not the fore-aft ' +
      'braking-to-propulsion force reversal, which is a separate unobserved event.';
    function restoreJointMarkers(sideBlock) {
      if (!sideBlock || !sideBlock.jointChanges) return;
      sideBlock.jointChanges.ankle = {
        availability: 'unavailable', reason: 'requires_foot_landmark',
        note: 'COCO-17 provides no heel, toe or foot landmark, so no foot segment exists to ' +
          'measure plantarflexion against. The shank angle carries the distal-segment motion instead.'
      };
      sideBlock.jointChanges.pelvis = {
        availability: 'unavailable', reason: 'requires_pelvis_landmarks',
        note: 'Sagittal pelvis orientation cannot be resolved from the two near-collinear COCO-17 ' +
          'hip points.'
      };
      if (sideBlock.supportGeometry) {
        sideBlock.supportGeometry.signConvention = 'negative = support point ahead of the COM';
        sideBlock.supportGeometry.role = 'secondary_descriptive_geometry';
      }
    }
    if (out.minimumCom && out.minimumCom.availability === 'available') {
      out.minimumCom.definition = MIN_COM_DEFINITION;
      out.minimumCom.note = 'Minimum COM is the kinematic reversal point of vertical COM motion — ' +
        'vertical COM velocity is approximately zero there. It is not the onset of propulsive ' +
        'force: upward force is already produced before it to decelerate the descending COM.';
    }
    if (out.loadingCompression && out.loadingCompression.availability === 'available') {
      out.loadingCompression.definition = 'touchdown → minimum COM';
      out.loadingCompression.note = 'How the runner receives and compresses into the ground. More ' +
        'compression is not automatically worse — deep and shallow strategies both appear in ' +
        'effective running.';
      ['overall', 'left', 'right'].forEach(function (s) {
        restoreJointMarkers(out.loadingCompression[s]);
      });
    }
    if (out.reboundProjection && out.reboundProjection.availability === 'available') {
      out.reboundProjection.definition = 'minimum COM → toe-off';
      out.reboundProjection.note = 'How the body is organised from the lowest COM point through ' +
        'toe-off to create the outgoing stride. These are motion quantities: none is a measured ' +
        'force, and no single joint is credited with creating propulsion on its own.';
      ['overall', 'left', 'right'].forEach(function (s) {
        var b = out.reboundProjection[s];
        restoreJointMarkers(b);
        if (b && b.verticalVelocityAtToeoff) {
          b.verticalVelocityAtToeoff.preferredSource = 'ballistic_flight_time';
        }
      });
      if (out.reboundProjection.outcomeChain) {
        out.reboundProjection.outcomeChain.sequence = ['minimum_com', 'rebound_rise',
          'rebound_duration', 'vertical_velocity_at_toeoff', 'toe_off', 'flight_time',
          'aerial_rise', 'stride_length'];
        out.reboundProjection.outcomeChain.verticalVelocitySource = 'ballistic_flight_time';
        out.reboundProjection.outcomeChain.note = 'A temporal sequence, not a full causal chain: ' +
          'mechanics link these quantities in order, but no step is claimed to be produced by a ' +
          'single joint or fully determined by the one before it.';
      }
      if (out.reboundProjection.movementSummary) {
        out.reboundProjection.movementSummary.availability = 'available';
        out.reboundProjection.movementSummary.isDescriptive = true;
      }
    }
    return out;
  }

  // ── Read-time migration ────────────────────────────────────────────────────
  //
  // Historical documents must stay renderable and must NEVER be reinterpreted.
  // A stored force-vector score or a stored support-line angle is not a
  // projection or ground-interaction measurement, and nothing here converts one
  // into the other. Migration is read-time only and never rewrites a document.

  function migrateAnalysis(stored) {
    var doc = stored || {};

    if (doc.pgi && isNum(doc.pgi.schemaVersion)) {
      return {
        generation: 'pgi', schemaVersion: doc.pgi.schemaVersion,
        pgi: doc.pgi, kfo: doc.kfo || null, migrated: false, isLegacy: false
      };
    }
    if (doc.kfo) {
      // A KFO-era save. Everything it holds stays valid AS A KFO RESULT and is
      // handed back for the legacy renderer; no field of it becomes a PGI field.
      var kfoMigrated = KFO.migrateAnalysis(doc);
      return {
        generation: 'kfo',
        schemaVersion: 2,
        kfo: kfoMigrated.kfo,
        isLegacy: true,
        migrated: true,
        pgi: {
          analysisType: PGI.ANALYSIS_TYPE,
          schemaVersion: PGI.SCHEMA_VERSION,
          availability: KFO.AVAILABILITY.UNAVAILABLE,
          reason: 'analysis_predates_projection_ground_interaction',
          note: 'This session was analysed under the earlier force-orientation model. Its stored ' +
            'values are shown as they were computed. They are not converted into projection or ' +
            'ground-interaction metrics, which need pose keypoints that were never stored.',
          limitations: ['Saved before projection & ground interaction existed',
                        'Pose keypoints are not persisted, so it cannot be recomputed retroactively']
        }
      };
    }
    return {
      generation: 'pre_kfo',
      schemaVersion: 1,
      isLegacy: true,
      migrated: true,
      kfo: null,
      pgi: {
        analysisType: PGI.ANALYSIS_TYPE,
        schemaVersion: PGI.SCHEMA_VERSION,
        availability: KFO.AVAILABILITY.UNAVAILABLE,
        reason: 'analysis_predates_mechanics_analysis',
        limitations: ['Saved before any mechanics analysis existed',
                      'Pose keypoints are not persisted, so it cannot be recomputed retroactively']
      }
    };
  }

  return {
    LIMITATIONS: LIMITATIONS,
    buildQuality: buildQuality,
    buildRebound: buildRebound,
    buildSymmetry: buildSymmetry,
    analyze: analyze,
    toStoredForm: toStoredForm,
    rehydrateStatic: rehydrateStatic,
    migrateAnalysis: migrateAnalysis
  };
});
