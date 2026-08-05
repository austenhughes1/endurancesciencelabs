// ─────────────────────────────────────────────────────────────────────────────
//  KFO — research export and force-plate validation harness
//
//  Two jobs:
//    1. Export stride-level and frame-level data so a future force-plate study
//       can be run against real output rather than reconstructed guesses.
//    2. Provide the statistics that would actually constitute validation —
//       including agreement, not just correlation.
//
//  A high correlation between an estimate and a criterion is NOT validation: a
//  systematically biased estimate can correlate almost perfectly. Bias,
//  calibration slope and Bland–Altman limits of agreement are therefore computed
//  alongside r, and `interpretValidation()` refuses to call anything validated
//  on correlation alone.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var imp = isNode ? require('./kfo-impulse.js') : root.KFOImpulse;
  var api = factory(core, imp);
  if (isNode) module.exports = api;
  if (root) root.KFOExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, KFOImpulse) {
  'use strict';

  // v2 adds the impulse-accounting and geometry-proxy columns. The export version
  // moves independently of the analysis schema version: a consumer parsing CSV
  // needs to know which columns exist, which is a different question from which
  // fields a stored document has.
  var EXPORT_VERSION = 'kfo-export-v2';
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // ── CSV helpers ───────────────────────────────────────────────────────────
  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    // Guard against spreadsheet formula injection in exported research data.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(columns, rows) {
    var head = columns.join(',');
    var body = rows.map(function (r) {
      return columns.map(function (c) { return csvCell(r[c]); }).join(',');
    });
    return [head].concat(body).join('\n');
  }

  // ── Manual event corrections ──────────────────────────────────────────────
  /**
   * Manual frame corrections are kept ALONGSIDE the automatic value, never
   * overwriting it — the difference between the two is itself the training
   * signal for improving event detection.
   */
  function makeAdjustmentRecord(o) {
    o = o || {};
    return {
      autoFrame: o.autoFrame == null ? null : o.autoFrame,
      autoTimestampMs: o.autoTimestampMs == null ? null : o.autoTimestampMs,
      adjustedFrame: o.adjustedFrame == null ? null : o.adjustedFrame,
      adjustedTimestampMs: o.adjustedTimestampMs == null ? null : o.adjustedTimestampMs,
      adjustmentReason: o.adjustmentReason || null,
      adjustedBy: o.adjustedBy || null,
      adjustedAt: o.adjustedAt || null,
      wasAdjusted: o.adjustedFrame != null && o.adjustedFrame !== o.autoFrame
    };
  }

  var STRIDE_COLUMNS = [
    'exportVersion', 'analysisId', 'subjectId', 'videoId', 'side', 'strideIndex',
    'footStrikeTimestampMs', 'toeOffTimestampMs', 'stanceDurationMs',
    'runningSpeedMps', 'gradePercent', 'surface', 'footwear',
    'earlyStanceTimestampMs', 'earlyStanceActualPercent', 'earlyStanceAngleDeg',
    'centralStanceTimestampMs', 'centralStanceActualPercent', 'centralStanceAngleDeg',
    'lateStanceTimestampMs', 'lateStanceActualPercent', 'lateStanceAngleDeg',
    'foreAftExcursionDeg', 'comLegDivergenceEarlyDeg', 'comLegDivergenceCentralDeg',
    'comLegDivergenceLateDeg', 'poseConfidence', 'eventConfidenceMean',
    'sampleCount', 'qualityFlags', 'wasManuallyAdjusted', 'adjustmentReason',
    'runningDirection', 'method', 'modelVersion', 'referenceVersion', 'schemaVersion',
    // Per-step timing and force. A "step" is this contact plus the flight that
    // follows it, so the last contact of a clip has no step and these stay empty.
    'stepContactMs', 'stepFlightMs', 'stepDurationMs', 'stepDutyFactor', 'stepCadenceSpm',
    'stepMeanVerticalForceBw', 'stepPeakVerticalForceBw', 'verticalForceMethod',
    // ── Impulse accounting, per stance ──────────────────────────────────────
    // Empty on the geometry-only path, and empty is the correct value: these are
    // impulses, and no arrangement of the angle columns above can produce one.
    // Geometry proxies are exported in their own `proxy*` columns so a downstream
    // analysis cannot confuse a degree-valued orientation with a BW·s impulse.
    'JvTotal', 'JvEffective', 'JBrake', 'JProp', 'JhTurnover', 'JxNet',
    'impulseUnit', 'impulseNormalizedToBodyWeight',
    'horizontalImpulseImbalance', 'steadyStateClassification',
    'totalSupportReplacementVerticalShare', 'totalSupportReplacementHorizontalShare',
    'projectionReplacementVerticalShare', 'projectionReplacementHorizontalShare',
    'activeProjectionTurnoverVerticalShare', 'activeProjectionTurnoverHorizontalShare',
    'forceEstimatorMethod', 'forceEstimatorVersion', 'filterSettings', 'forceConfidence',
    'impulseAvailability', 'impulseRejectReason',
    // ── Geometry proxies, kept separate from every force-derived column ──────
    'proxyBrakingOrientationDeg', 'proxySupportAlignmentDeg',
    'proxyReplacementOrientationDeg', 'proxyForeAftGeometricExcursionDeg',
    'proxyMomentumPreservationGeometryPattern'
  ];

  /**
   * Index the per-step force records by contact side and start time so each
   * stride row can pick up its own step.
   *
   * Both come from the same stance intervals, so the start times are identical
   * rather than merely close; the tolerance only guards against float drift.
   */
  var STEP_MATCH_TOLERANCE_SECONDS = 0.002;

  function stepLookup(result) {
    var vf = result && result.verticalForce;
    var steps = (vf && vf.steps) || [];
    return function (side, startTime) {
      var best = null, bestDt = Infinity;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].contactSide !== side) continue;
        var dt = Math.abs(steps[i].startTime - startTime);
        if (dt < bestDt) { bestDt = dt; best = steps[i]; }
      }
      return bestDt <= STEP_MATCH_TOLERANCE_SECONDS ? best : null;
    };
  }

  /**
   * Index the per-stance impulse records the same way, by side and stance start
   * time. Matching on time rather than on stride index means a row can never pick
   * up a neighbouring stance's impulses if the two lists ever diverge.
   */
  function impulseLookup(result) {
    var im = result && result.impulseMetrics;
    var stances = [];
    if (im && im.perSide) {
      ['left', 'right'].forEach(function (side) {
        var s = im.perSide[side];
        if (s && s.perStance) stances = stances.concat(s.perStance);
      });
    }
    if (!stances.length && im && im.combined && im.combined.perStance) {
      stances = im.combined.perStance.slice();
    }
    return function (side, startTime) {
      var best = null, bestDt = Infinity;
      for (var i = 0; i < stances.length; i++) {
        if (stances[i].side !== side) continue;
        var dt = Math.abs(stances[i].stanceStartSeconds - startTime);
        if (dt < bestDt) { bestDt = dt; best = stances[i]; }
      }
      return bestDt <= STEP_MATCH_TOLERANCE_SECONDS ? best : null;
    };
  }

  /**
   * Per-stance accounting shares. Computed from THAT stance's impulses, never
   * copied down from the session aggregate: a share is nonlinear in its inputs,
   * so an aggregate share is not any individual stance's share.
   */
  function stanceCompositions(stance) {
    if (!stance || !KFOImpulse) return null;
    if (!stance.isPlausible) return null;
    return KFOImpulse.buildCompositions(stance, { method: stance.method });
  }

  function proxyFor(result, side, phaseKey) {
    var p = result && result.momentumPreservationProxies;
    var s = p && p[side];
    var m = s && s[phaseKey];
    return m && isNum(m.medianDegrees) ? m.medianDegrees : null;
  }

  /**
   * @param {Object} result   KFO analysis result
   * @param {Object} [meta]   {analysisId, subjectId, videoId, surface, footwear, adjustments}
   */
  function strideRows(result, meta) {
    meta = meta || {};
    if (!result || !result.left) return [];
    var vm = result.videoMetadata || {};
    var flags = (result.quality && result.quality.flags) ? result.quality.flags.join('|') : '';
    var findStep = stepLookup(result);
    var findStance = impulseLookup(result);
    var vfMethod = (result.verticalForce && result.verticalForce.method) || null;
    var im = result.impulseMetrics || null;
    var ss = im && im.steadyStateConsistency ? im.steadyStateConsistency : null;
    var filterSettings = null;
    if (im && im.filter) filterSettings = JSON.stringify(im.filter);
    else if (meta.filterSettings) filterSettings = JSON.stringify(meta.filterSettings);
    var rows = [];

    ['left', 'right'].forEach(function (side) {
      var sd = result[side];
      if (!sd || !sd.strides) return;
      sd.strides.forEach(function (st) {
        if (!st.valid) return;
        function ph(p, field) {
          var e = st.phases[p];
          if (!e || !e.available) return null;
          if (field === 'angle') return round(e.angleDegrees, 3);
          if (field === 'ts') return e.event.timestampMs;
          if (field === 'pct') return round(e.event.actualPercent, 2);
          if (field === 'div') return round(e.comLegDivergenceDegrees, 3);
          return null;
        }
        var early = ph(KFO.PHASE.EARLY_STANCE, 'angle');
        var late = ph(KFO.PHASE.LATE_STANCE, 'angle');
        var evConfs = KFO.PHASE_ORDER.map(function (p) {
          return st.phases[p] && st.phases[p].available ? st.phases[p].event.eventConfidence : null;
        }).filter(isNum);
        var adj = (meta.adjustments && meta.adjustments[side + ':' + st.strideIndex]) || null;
        var step = findStep(side, st.startTime);
        var stance = findStance(side, st.startTime);
        var comps = stanceCompositions(stance);
        function share(key, which) {
          var c = comps && comps[key];
          if (!c) return null;
          var v = which === 'v' ? c.verticalShareScalarSum : c.horizontalShareScalarSum;
          return round(v, 6);
        }
        // Per-stance imbalance, so a single bad stance is visible rather than
        // averaged into the session number.
        var stanceImbalance = (stance && isNum(stance.JxNet) && isNum(stance.JhTurnover) &&
                               stance.JhTurnover > 0)
          ? Math.abs(stance.JxNet) / stance.JhTurnover : null;
        // Per step, never recomputed from the aggregate duty factor: 1/DF is
        // convex, so a row-level value derived from a mean would not be this
        // step's force.
        var stepDf = step ? step.dutyFactor : null;

        rows.push({
          exportVersion: EXPORT_VERSION,
          analysisId: meta.analysisId || null,
          subjectId: meta.subjectId || null,
          videoId: meta.videoId || null,
          side: side,
          strideIndex: st.strideIndex,
          footStrikeTimestampMs: Math.round(st.startTime * 1000),
          toeOffTimestampMs: Math.round(st.endTime * 1000),
          stanceDurationMs: Math.round(st.durationSeconds * 1000),
          runningSpeedMps: vm.estimatedSpeedMps == null ? null : vm.estimatedSpeedMps,
          gradePercent: vm.gradePercent == null ? null : vm.gradePercent,
          surface: meta.surface || null,
          footwear: meta.footwear || null,
          earlyStanceTimestampMs: ph(KFO.PHASE.EARLY_STANCE, 'ts'),
          earlyStanceActualPercent: ph(KFO.PHASE.EARLY_STANCE, 'pct'),
          earlyStanceAngleDeg: early,
          centralStanceTimestampMs: ph(KFO.PHASE.CENTRAL_STANCE, 'ts'),
          centralStanceActualPercent: ph(KFO.PHASE.CENTRAL_STANCE, 'pct'),
          centralStanceAngleDeg: ph(KFO.PHASE.CENTRAL_STANCE, 'angle'),
          lateStanceTimestampMs: ph(KFO.PHASE.LATE_STANCE, 'ts'),
          lateStanceActualPercent: ph(KFO.PHASE.LATE_STANCE, 'pct'),
          lateStanceAngleDeg: late,
          foreAftExcursionDeg: (isNum(early) && isNum(late)) ? round(Math.abs(early) + Math.abs(late), 3) : null,
          comLegDivergenceEarlyDeg: ph(KFO.PHASE.EARLY_STANCE, 'div'),
          comLegDivergenceCentralDeg: ph(KFO.PHASE.CENTRAL_STANCE, 'div'),
          comLegDivergenceLateDeg: ph(KFO.PHASE.LATE_STANCE, 'div'),
          poseConfidence: round(st.poseConfidence, 4),
          eventConfidenceMean: evConfs.length ? round(evConfs.reduce(function (a, b) { return a + b; }, 0) / evConfs.length, 4) : null,
          sampleCount: st.sampleCount,
          qualityFlags: flags,
          wasManuallyAdjusted: adj ? adj.wasAdjusted : false,
          adjustmentReason: adj ? adj.adjustmentReason : null,
          runningDirection: vm.runningDirection || null,
          method: result.method,
          modelVersion: result.modelVersion,
          referenceVersion: result.referenceVersion,
          schemaVersion: result.schemaVersion,
          stepContactMs: step ? Math.round(step.contactSeconds * 1000) : null,
          stepFlightMs: step ? Math.round(step.flightSeconds * 1000) : null,
          stepDurationMs: step ? Math.round(step.stepSeconds * 1000) : null,
          stepDutyFactor: round(stepDf, 4),
          stepCadenceSpm: step ? round(step.cadenceSpm, 2) : null,
          stepMeanVerticalForceBw: isNum(stepDf) && stepDf > 0 ? round(1 / stepDf, 4) : null,
          stepPeakVerticalForceBw: isNum(stepDf) && stepDf > 0 ? round(Math.PI / 2 / stepDf, 4) : null,
          verticalForceMethod: step ? vfMethod : null,

          JvTotal: stance ? round(stance.JvTotal, 6) : null,
          JvEffective: stance ? round(stance.JvEffective, 6) : null,
          JBrake: stance ? round(stance.JBrake, 6) : null,
          JProp: stance ? round(stance.JProp, 6) : null,
          JhTurnover: stance ? round(stance.JhTurnover, 6) : null,
          JxNet: stance ? round(stance.JxNet, 6) : null,
          impulseUnit: stance ? stance.unit : null,
          impulseNormalizedToBodyWeight: stance ? stance.normalizedToBodyWeight !== false : null,
          horizontalImpulseImbalance: round(stanceImbalance, 6),
          steadyStateClassification: ss ? ss.state : null,
          totalSupportReplacementVerticalShare: share('totalSupportReplacement', 'v'),
          totalSupportReplacementHorizontalShare: share('totalSupportReplacement', 'h'),
          projectionReplacementVerticalShare: share('projectionReplacement', 'v'),
          projectionReplacementHorizontalShare: share('projectionReplacement', 'h'),
          activeProjectionTurnoverVerticalShare: share('activeProjectionTurnover', 'v'),
          activeProjectionTurnoverHorizontalShare: share('activeProjectionTurnover', 'h'),
          forceEstimatorMethod: im ? (im.method || null) : null,
          forceEstimatorVersion: im ? (im.calculationVersion || null) : null,
          filterSettings: filterSettings,
          forceConfidence: (result.quality && result.quality.confidence)
            ? round(result.quality.confidence.score, 4) : null,
          impulseAvailability: im ? im.availability : null,
          // A stance the estimator refused says WHY here, so a gap in the impulse
          // columns can be told apart from a gap in the force source.
          impulseRejectReason: stance ? (stance.reason || null) : (im ? im.reason || null : null),

          proxyBrakingOrientationDeg: round(proxyFor(result, side, 'brakingOrientationProxy'), 3),
          proxySupportAlignmentDeg: round(proxyFor(result, side, 'supportAlignmentProxy'), 3),
          proxyReplacementOrientationDeg: round(proxyFor(result, side, 'replacementOrientationProxy'), 3),
          proxyForeAftGeometricExcursionDeg: (function () {
            var p = result.momentumPreservationProxies;
            var s = p && p[side] && p[side].foreAftGeometricExcursion;
            return s ? round(s.valueDegrees, 3) : null;
          })(),
          proxyMomentumPreservationGeometryPattern: (function () {
            var p = result.momentumPreservationProxies;
            return (p && p[side] && p[side].momentumPreservationGeometryPattern) || null;
          })()
        });
      });
    });
    return rows;
  }

  var FRAME_COLUMNS = [
    'exportVersion', 'analysisId', 'videoId', 'side', 'strideIndex', 'phase',
    'timestampMs', 'frameIndex', 'stancePercent', 'contactState',
    'comX', 'comY', 'comMethod', 'comMassCoverage',
    'supportPointX', 'supportPointY', 'supportPointAnchor',
    'supportLineAngleDeg', 'legAxisAngleDeg', 'comLegDivergenceDeg',
    'poseConfidence', 'landmarkConfidenceMin', 'landmarks',
    'rawComX', 'rawComY', 'smoothedComX', 'smoothedComY',
    'experimentalAxMps2', 'experimentalAzMps2', 'experimentalFxBw', 'experimentalFzBw',
    // Which integration region this instant falls in, so a reviewer can see where
    // each impulse came from instead of taking the totals on trust.
    'horizontalIntegrationRegion', 'verticalIntegrationRegion', 'bodyWeightLine',
    'stanceStartMs', 'stanceEndMs',
    'method', 'modelVersion'
  ];

  /**
   * Classify one instant against a stance's integration regions.
   * Returns nulls rather than 'none' when no force source exists: absence of a
   * region and an instant genuinely outside every region are different facts.
   */
  function regionAt(stance, t) {
    var regions = stance && stance.diagnostics && stance.diagnostics.integrationRegions;
    if (!regions) return { horizontal: null, vertical: null, bodyWeightLine: null };
    function inAny(list) {
      for (var i = 0; i < (list || []).length; i++) {
        if (t >= list[i].startTime && t <= list[i].endTime) return true;
      }
      return false;
    }
    return {
      horizontal: inAny(regions.braking) ? 'braking' : inAny(regions.propulsive) ? 'propulsive' : 'zero_crossing',
      vertical: inAny(regions.aboveBodyWeight) ? 'above_body_weight'
              : inAny(regions.belowBodyWeight) ? 'below_body_weight' : 'at_body_weight',
      bodyWeightLine: regions.bodyWeightLine == null ? null : regions.bodyWeightLine
    };
  }

  /**
   * Frame-level rows. `includeLandmarks` embeds the full pose as JSON, which is
   * what makes the export usable for retraining or re-deriving any geometry —
   * it is large, so it is opt-in.
   */
  function frameRows(result, samples, opts) {
    opts = opts || {};
    if (!result || !result.left) return [];
    var rows = [];
    var experimental = opts.experimentalSeries || null;
    var findStance = impulseLookup(result);

    function expAt(t) {
      if (!experimental) return null;
      var best = null, bestDt = Infinity;
      for (var i = 0; i < experimental.length; i++) {
        var dt = Math.abs(experimental[i].t - t);
        if (dt < bestDt) { bestDt = dt; best = experimental[i]; }
      }
      return bestDt <= 0.02 ? best : null;
    }

    ['left', 'right'].forEach(function (side) {
      var sd = result[side];
      if (!sd || !sd.strides) return;
      sd.strides.forEach(function (st) {
        KFO.PHASE_ORDER.forEach(function (phase) {
          var e = st.phases[phase];
          if (!e || !e.available) return;
          var t = e.event.representativeTimestampMs / 1000;
          var sample = null, frameIndex = null;
          for (var i = 0; i < (samples || []).length; i++) {
            if (Math.abs(samples[i].t - t) < 0.0005) { sample = samples[i]; frameIndex = i; break; }
          }
          var minConf = null;
          if (sample && sample.kps) {
            minConf = sample.kps.reduce(function (m, k) {
              var s = (k && isNum(k.score)) ? k.score : 0;
              return m == null ? s : Math.min(m, s);
            }, null);
          }
          var ex = expAt(t);
          var stance = findStance(side, st.startTime);
          var reg = regionAt(stance, t);
          rows.push({
            exportVersion: EXPORT_VERSION,
            analysisId: opts.analysisId || null,
            videoId: opts.videoId || null,
            side: side,
            strideIndex: st.strideIndex,
            phase: phase,
            timestampMs: e.event.representativeTimestampMs,
            frameIndex: frameIndex,
            stancePercent: round(e.event.actualPercent, 2),
            contactState: 'stance',
            comX: round(e.com ? e.com.x : null, 3),
            comY: round(e.com ? e.com.y : null, 3),
            comMethod: e.com ? e.com.method : null,
            comMassCoverage: round(e.com ? e.com.massCoverage : null, 4),
            supportPointX: round(e.supportPoint ? e.supportPoint.x : null, 3),
            supportPointY: round(e.supportPoint ? e.supportPoint.y : null, 3),
            supportPointAnchor: e.supportPoint ? e.supportPoint.anchor : null,
            supportLineAngleDeg: round(e.angleDegrees, 3),
            legAxisAngleDeg: null,
            comLegDivergenceDeg: round(e.comLegDivergenceDegrees, 3),
            poseConfidence: round(e.poseConfidence, 4),
            landmarkConfidenceMin: round(minConf, 4),
            landmarks: (opts.includeLandmarks && sample && sample.kps) ? JSON.stringify(sample.kps.map(function (k) {
              return k ? [round(k.x, 2), round(k.y, 2), round(k.score, 3)] : null;
            })) : null,
            rawComX: round(e.com ? e.com.x : null, 3),
            rawComY: round(e.com ? e.com.y : null, 3),
            smoothedComX: ex ? round(ex.comX, 3) : null,
            smoothedComY: ex ? round(ex.comY, 3) : null,
            experimentalAxMps2: ex ? round(ex.axMps2, 4) : null,
            experimentalAzMps2: ex ? round(ex.azMps2, 4) : null,
            experimentalFxBw: ex ? round(ex.fxBodyWeights, 4) : null,
            experimentalFzBw: ex ? round(ex.fzBodyWeights, 4) : null,
            horizontalIntegrationRegion: reg.horizontal,
            verticalIntegrationRegion: reg.vertical,
            bodyWeightLine: reg.bodyWeightLine,
            stanceStartMs: stance ? Math.round(stance.stanceStartSeconds * 1000) : null,
            stanceEndMs: stance ? Math.round(stance.stanceEndSeconds * 1000) : null,
            method: result.method,
            modelVersion: result.modelVersion
          });
        });
      });
    });
    return rows;
  }

  function round(v, dp) {
    if (!isNum(v)) return null;
    var f = Math.pow(10, dp == null ? 3 : dp);
    return Math.round(v * f) / f;
  }

  /** Full research bundle. */
  function buildExport(result, samples, meta) {
    meta = meta || {};
    var strides = strideRows(result, meta);
    var frames = frameRows(result, samples, meta);
    return {
      exportVersion: EXPORT_VERSION,
      generatedFor: meta.analysisId || null,
      analysis: result,
      strideLevel: strides,
      frameLevel: frames,
      csv: {
        strides: toCsv(STRIDE_COLUMNS, strides),
        frames: toCsv(FRAME_COLUMNS, frames)
      },
      impulseAccounting: {
        availability: (result && result.impulseMetrics) ? result.impulseMetrics.availability : 'unavailable',
        reason: (result && result.impulseMetrics) ? result.impulseMetrics.reason || null : null,
        method: (result && result.impulseMetrics) ? result.impulseMetrics.method || null : null,
        calculationVersion: KFOImpulse ? KFOImpulse.CALCULATION_VERSION : null,
        signConvention: KFOImpulse ? KFOImpulse.SIGN_CONVENTION : null,
        definitions: KFOImpulse ? KFOImpulse.IMPULSE_DEFINITIONS : null,
        compositionSpec: KFOImpulse ? KFOImpulse.COMPOSITION_SPEC : null,
        provisionalThresholds: KFOImpulse ? {
          imbalanceWarnRatio: KFOImpulse.CONFIG.imbalanceWarnRatio,
          imbalanceRejectRatio: KFOImpulse.CONFIG.imbalanceRejectRatio,
          isProvisional: true,
          note: KFOImpulse.CONFIG.provisionalNote
        } : null
      },
      notes: [
        'Support-line angles are kinematic estimates, not measured ground-reaction force.',
        'Angle convention: degrees from vertical, negative = braking, positive = propulsive.',
        'Manual event corrections are retained beside automatic values, not substituted for them.',
        'Vertical force columns are timing-derived estimates in bodyweights, not measured force. ' +
          'Mean = 1 / duty factor (exact at steady state); peak assumes a half-sine waveform and ' +
          'underestimates the force-plate peak by roughly 5-15%.',
        'Net horizontal force is not reported: net horizontal impulse is ~0 at steady speed. The ' +
          'discriminating quantity is braking impulse MAGNITUDE, which needs force measurement or a ' +
          'speed estimate that this pipeline does not capture.',
        'Impulse columns (Jv*, JBrake, JProp, JhTurnover, JxNet) are empty unless a force-time series ' +
          'was supplied. They cannot be derived from the angle columns, which carry no magnitude.',
        'The three composition share pairs are DIFFERENT ACCOUNTING VIEWS of the same stance, not ' +
          'competing estimates of one quantity: total vs effective vertical impulse, and ' +
          'replacement-only vs total fore-aft turnover. Each is a scalar-sum share, not a direction ' +
          'cosine, and none is a validated efficiency target.',
        'proxy* columns are geometric orientations in DEGREES. They are not impulses, force shares, ' +
          'work or energy, and must not be pooled with the impulse columns.',
        'Vertical impact peak and loading rate are not exported: they need a force source sampled at ' +
          '200 Hz or better. Vertical impact is not the same quantity as horizontal braking impulse.'
      ]
    };
  }

  // ── Force-plate import ────────────────────────────────────────────────────
  /**
   * Parse a simple force-data CSV. Expected headers (case-insensitive, order
   * free): timestamp, fx, fy, fz, copx, copy, copz, contactside.
   *
   * Returns per-contact groupings so each stance can be matched to a video
   * stride. Rejects rows rather than coercing garbage into zeros.
   */
  function parseForcePlateCsv(text) {
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return { ok: false, reason: 'empty_or_header_only', rows: [] };
    var head = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
    function col(name) { return head.indexOf(name); }
    var iT = col('timestamp'), iFx = col('fx'), iFy = col('fy'), iFz = col('fz');
    if (iT < 0 || iFx < 0 || iFz < 0) {
      return { ok: false, reason: 'missing_required_columns_timestamp_fx_fz', rows: [] };
    }
    var iCopX = col('copx'), iCopY = col('copy'), iCopZ = col('copz'), iSide = col('contactside');
    var rows = [], rejected = 0;
    for (var i = 1; i < lines.length; i++) {
      var p = lines[i].split(',');
      var t = parseFloat(p[iT]), fx = parseFloat(p[iFx]), fz = parseFloat(p[iFz]);
      if (!isNum(t) || !isNum(fx) || !isNum(fz)) { rejected++; continue; }
      rows.push({
        t: t, fx: fx,
        fy: iFy >= 0 ? parseFloat(p[iFy]) : null,
        fz: fz,
        copX: iCopX >= 0 ? parseFloat(p[iCopX]) : null,
        copY: iCopY >= 0 ? parseFloat(p[iCopY]) : null,
        copZ: iCopZ >= 0 ? parseFloat(p[iCopZ]) : null,
        contactSide: iSide >= 0 ? String(p[iSide]).trim().toLowerCase() : null
      });
    }
    return { ok: rows.length > 0, reason: rows.length ? null : 'no_valid_rows', rows: rows, rejectedRows: rejected };
  }

  /**
   * Segment a force trace into contacts using a vertical-force threshold, then
   * report the true GRF angle at the three kinetic instants the brief names.
   * These are the criterion values a geometry estimate should be compared with.
   */
  function extractCriterionAngles(rows, opts) {
    opts = opts || {};
    var threshold = isNum(opts.thresholdNewtons) ? opts.thresholdNewtons : 20;
    var contacts = [], current = null;
    rows.forEach(function (r) {
      if (r.fz > threshold) {
        if (!current) current = { side: r.contactSide, samples: [] };
        current.samples.push(r);
      } else if (current) {
        if (current.samples.length > 3) contacts.push(current);
        current = null;
      }
    });
    if (current && current.samples.length > 3) contacts.push(current);

    return contacts.map(function (c, idx) {
      var s = c.samples;
      var t0 = s[0].t, t1 = s[s.length - 1].t;
      var peakBrake = null, peakProp = null, peakVert = null, zeroCross = null;
      s.forEach(function (r, i) {
        if (peakBrake === null || r.fx < s[peakBrake].fx) peakBrake = i;
        if (peakProp === null || r.fx > s[peakProp].fx) peakProp = i;
        if (peakVert === null || r.fz > s[peakVert].fz) peakVert = i;
        if (i > 0 && s[i - 1].fx < 0 && r.fx >= 0 && zeroCross === null) zeroCross = i;
      });
      function angleAt(i) {
        if (i == null) return null;
        // Signed angle from vertical of the true resultant.
        return KFO._internals.toDeg(Math.atan2(s[i].fx, s[i].fz));
      }
      function pct(i) { return (i == null || !(t1 > t0)) ? null : ((s[i].t - t0) / (t1 - t0)) * 100; }
      return {
        contactIndex: idx,
        side: c.side,
        startTime: t0, endTime: t1, durationSeconds: t1 - t0,
        peakBrakingAngleDeg: angleAt(peakBrake), peakBrakingPercent: pct(peakBrake),
        peakVerticalAngleDeg: angleAt(peakVert), peakVerticalPercent: pct(peakVert),
        peakPropulsiveAngleDeg: angleAt(peakProp), peakPropulsivePercent: pct(peakProp),
        apZeroCrossingPercent: pct(zeroCross),
        impulses: KFO.computeImpulseMetrics(s, opts.bodyWeightNewtons)
      };
    });
  }

  // ── Validation statistics ─────────────────────────────────────────────────
  /**
   * @param {Array<{estimate:number, criterion:number, subjectId?:string, speedMps?:number, side?:string, confidence?:number}>} pairs
   */
  function validationStats(pairs) {
    var p = (pairs || []).filter(function (x) { return x && isNum(x.estimate) && isNum(x.criterion); });
    var n = p.length;
    if (n < 3) return { ok: false, reason: 'insufficient_paired_observations', n: n };

    var diffs = p.map(function (x) { return x.estimate - x.criterion; });
    var absDiffs = diffs.map(Math.abs);
    var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
    var mae = mean(absDiffs);
    var bias = mean(diffs);
    var rmse = Math.sqrt(mean(diffs.map(function (d) { return d * d; })));
    var sdDiff = Math.sqrt(p.length > 1
      ? diffs.reduce(function (s, d) { return s + Math.pow(d - bias, 2); }, 0) / (n - 1) : 0);

    var mx = mean(p.map(function (x) { return x.criterion; }));
    var my = mean(p.map(function (x) { return x.estimate; }));
    var sxy = 0, sxx = 0, syy = 0;
    p.forEach(function (x) {
      var dx = x.criterion - mx, dy = x.estimate - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    });
    var slope = sxx > 0 ? sxy / sxx : null;              // calibration slope, ideal 1
    var intercept = slope != null ? my - slope * mx : null;
    var r = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;

    // Confidence calibration: does the reported uncertainty actually cover the error?
    var withConf = p.filter(function (x) { return isNum(x.confidence) && isNum(x.uncertaintyDegrees); });
    var coverage = null;
    if (withConf.length >= 3) {
      var inside = withConf.filter(function (x) {
        return Math.abs(x.estimate - x.criterion) <= x.uncertaintyDegrees;
      }).length;
      coverage = inside / withConf.length;
    }

    return {
      ok: true, n: n,
      meanAbsoluteError: mae,
      rmse: rmse,
      bias: bias,
      sdOfDifferences: sdDiff,
      calibrationSlope: slope,
      calibrationIntercept: intercept,
      correlation: r,
      rSquared: r == null ? null : r * r,
      blandAltman: {
        bias: bias,
        lowerLimitOfAgreement: bias - 1.96 * sdDiff,
        upperLimitOfAgreement: bias + 1.96 * sdDiff,
        note: 'Limits of agreement are bias ± 1.96 SD of the differences.'
      },
      confidenceCalibration: coverage == null ? null : {
        coverage: coverage,
        expected: 0.68,
        note: 'Fraction of observations whose error fell within the reported ±1 uncertainty.'
      }
    };
  }

  function stratify(pairs, keyFn) {
    var groups = {};
    (pairs || []).forEach(function (p) {
      var k = keyFn(p);
      if (k == null) return;
      (groups[k] = groups[k] || []).push(p);
    });
    var out = {};
    Object.keys(groups).forEach(function (k) { out[k] = validationStats(groups[k]); });
    return out;
  }

  /** Leave-one-subject-out performance, the honest generalisation check. */
  function perSubjectHoldout(pairs) {
    var subjects = {};
    (pairs || []).forEach(function (p) { if (p.subjectId) subjects[p.subjectId] = true; });
    var ids = Object.keys(subjects);
    if (ids.length < 2) return { ok: false, reason: 'need_at_least_two_subjects' };
    var out = {};
    ids.forEach(function (id) {
      out[id] = validationStats(pairs.filter(function (p) { return p.subjectId === id; }));
    });
    return { ok: true, perSubject: out };
  }

  /**
   * Gatekeeper. Correlation alone can never satisfy this — a biased estimate can
   * correlate almost perfectly, so bias, calibration slope and limits of
   * agreement all have to pass before anything may be called validated.
   */
  var VALIDATION_CRITERIA = Object.freeze({
    maxMeanAbsoluteErrorDegrees: 4,
    maxAbsoluteBiasDegrees: 2,
    calibrationSlopeRange: [0.85, 1.15],
    maxLimitsOfAgreementWidthDegrees: 12,
    minSubjects: 10,
    minPairedObservations: 100
  });

  function interpretValidation(stats, context) {
    context = context || {};
    var c = VALIDATION_CRITERIA;
    var failures = [];
    if (!stats || !stats.ok) return { validated: false, failures: ['insufficient_data'], criteria: c };
    if (!(stats.meanAbsoluteError <= c.maxMeanAbsoluteErrorDegrees)) failures.push('mean_absolute_error');
    if (!(Math.abs(stats.bias) <= c.maxAbsoluteBiasDegrees)) failures.push('bias');
    if (stats.calibrationSlope == null ||
        stats.calibrationSlope < c.calibrationSlopeRange[0] ||
        stats.calibrationSlope > c.calibrationSlopeRange[1]) failures.push('calibration_slope');
    var width = stats.blandAltman.upperLimitOfAgreement - stats.blandAltman.lowerLimitOfAgreement;
    if (!(width <= c.maxLimitsOfAgreementWidthDegrees)) failures.push('limits_of_agreement');
    if (!(stats.n >= c.minPairedObservations)) failures.push('sample_size');
    if (!(isNum(context.subjectCount) && context.subjectCount >= c.minSubjects)) failures.push('subject_count');
    return {
      validated: failures.length === 0,
      failures: failures,
      criteria: c,
      note: 'Correlation is reported but is never sufficient: a biased estimate can correlate almost perfectly, ' +
        'so agreement criteria must also pass.'
    };
  }

  /** Pair exported strides against force-plate contacts by temporal overlap. */
  function pairWithCriterion(strideRowsArr, criterionContacts, opts) {
    opts = opts || {};
    var phaseMap = {
      early_stance: { est: 'earlyStanceAngleDeg', crit: 'peakBrakingAngleDeg' },
      central_stance: { est: 'centralStanceAngleDeg', crit: 'peakVerticalAngleDeg' },
      late_stance: { est: 'lateStanceAngleDeg', crit: 'peakPropulsiveAngleDeg' }
    };
    var tolerance = isNum(opts.toleranceSeconds) ? opts.toleranceSeconds : 0.08;
    var offset = isNum(opts.syncOffsetSeconds) ? opts.syncOffsetSeconds : 0;
    var pairs = [];
    (strideRowsArr || []).forEach(function (row) {
      var strideStart = row.footStrikeTimestampMs / 1000 + offset;
      var match = null, bestDt = Infinity;
      (criterionContacts || []).forEach(function (c) {
        if (c.side && row.side && c.side !== row.side) return;
        var dt = Math.abs(c.startTime - strideStart);
        if (dt < bestDt) { bestDt = dt; match = c; }
      });
      if (!match || bestDt > tolerance) return;
      Object.keys(phaseMap).forEach(function (phase) {
        var m = phaseMap[phase];
        if (!isNum(row[m.est]) || !isNum(match[m.crit])) return;
        pairs.push({
          phase: phase, side: row.side, subjectId: row.subjectId,
          speedMps: row.runningSpeedMps,
          estimate: row[m.est], criterion: match[m.crit],
          syncErrorSeconds: bestDt
        });
      });
    });
    return pairs;
  }

  return {
    EXPORT_VERSION: EXPORT_VERSION,
    STRIDE_COLUMNS: STRIDE_COLUMNS,
    FRAME_COLUMNS: FRAME_COLUMNS,
    VALIDATION_CRITERIA: VALIDATION_CRITERIA,
    toCsv: toCsv,
    makeAdjustmentRecord: makeAdjustmentRecord,
    impulseLookup: impulseLookup,
    regionAt: regionAt,
    strideRows: strideRows,
    frameRows: frameRows,
    buildExport: buildExport,
    parseForcePlateCsv: parseForcePlateCsv,
    extractCriterionAngles: extractCriterionAngles,
    validationStats: validationStats,
    stratify: stratify,
    perSubjectHoldout: perSubjectHoldout,
    interpretValidation: interpretValidation,
    pairWithCriterion: pairWithCriterion
  };
});
