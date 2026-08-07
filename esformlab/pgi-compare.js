// ─────────────────────────────────────────────────────────────────────────────
//  PGI — condition comparison (pre/post)
//
//  Compares two analyses of the same runner under different conditions: before
//  and after a form change, fresh vs fatigued, a coaching cue, different shoes,
//  different speeds, rehab progression.
//
//  WHAT MAKES THIS HONEST
//  ----------------------
//  1. SPEED IS CHECKED FIRST AND LOUDLY. Most of these mechanics move with
//     speed. If the two conditions were run at materially different speeds the
//     comparison is still shown — hiding it would be worse — but every pattern
//     is confidence-scaled and carries the warning, and the block itself sets
//     `speedComparable: false`.
//
//  2. A DIFFERENCE MUST EXCEED STRIDE-TO-STRIDE VARIABILITY. Each metric is
//     aggregated across strides with a 95% confidence interval, so a change is
//     tested against that spread rather than against a bare relative threshold.
//     A change inside the noise is reported as unchanged, with its numbers
//     still visible.
//
//  3. NEITHER CONDITION IS "BETTER". The comparison describes what changed
//     mechanically and, through pgi-patterns, whether the changes cohere into a
//     recognisable pattern. It does not rank the conditions.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var pat = isNode ? require('./pgi-patterns.js') : root.PGIPatterns;
  var api = factory(core, pgi, pat);
  if (isNode) module.exports = api;
  if (root) root.PGICompare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI, PGIPatterns) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // Speeds this far apart make a mechanical comparison speed-confounded.
  var SPEED_TOLERANCE = Object.freeze({ relative: 0.05, absoluteMps: 0.15 });

  var SPEED_WARNING = 'Conditions were performed at different speeds; mechanical differences may be ' +
    'speed-dependent.';

  // ── Metric registry ────────────────────────────────────────────────────────
  //
  // Each entry knows how to pull its aggregate out of a PGI envelope, so the
  // comparison never has to guess at a path and a missing block yields null
  // rather than an exception.

  function ovr(block) { return block && block.overall ? block.overall : null; }

  function bothSidesMean(td, get) {
    var vals = ['left', 'right'].map(function (s) {
      var side = td && td[s];
      if (!side || side.availability !== KFO.AVAILABILITY.AVAILABLE) return null;
      return get(side.aggregate);
    }).filter(isNum);
    return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
  }

  /** {value, sd, n, ci95} from a KFO.aggregate, or nulls. */
  function fromAggregate(a) {
    if (!a || !isNum(a.median)) return { value: null, sd: null, n: 0, ci95: null };
    return { value: a.median, mean: a.mean, sd: a.sd, n: a.n, ci95: a.ci95 };
  }
  function scalar(v) {
    return { value: isNum(v) ? v : null, sd: null, n: null, ci95: null };
  }

  var METRICS = [
    // ── Touchdown preparation ──
    { key: 'footComOffsetLegLengths', group: 'touchdownPreparation', unit: 'leg lengths', dp: 3,
      label: 'Foot-to-COM offset at touchdown',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.footComOffsetAtTouchdownLegLengths && a.footComOffsetAtTouchdownLegLengths.median; })); } },
    { key: 'retractionTimeMs', group: 'touchdownPreparation', unit: 'ms', dp: 0,
      label: 'Retraction period',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.retractionTimeMs && a.retractionTimeMs.median; })); } },
    { key: 'retractionDistanceComLegLengths', group: 'touchdownPreparation', unit: 'leg lengths', dp: 3,
      label: 'Retraction distance (COM-relative)',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.retractionDistanceComLegLengths && a.retractionDistanceComLegLengths.median; })); } },
    { key: 'clearRetractionFraction', group: 'touchdownPreparation', unit: '', dp: 2,
      label: 'Contacts with clear retraction',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.clearRetractionFraction; })); } },
    { key: 'horizontalFootVelocityMps', group: 'touchdownPreparation', unit: 'm/s', dp: 2,
      label: 'Pre-contact horizontal foot velocity',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.horizontalFootVelocityMps && a.horizontalFootVelocityMps.median; })); } },
    { key: 'footGroundVelocityMps', group: 'touchdownPreparation', unit: 'm/s', dp: 2,
      label: 'Foot-ground velocity mismatch',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.footGroundVelocityMps && a.footGroundVelocityMps.median; })); } },
    { key: 'verticalFootVelocityMps', group: 'touchdownPreparation', unit: 'm/s', dp: 2,
      label: 'Pre-contact vertical foot velocity',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.verticalFootVelocityMps && a.verticalFootVelocityMps.median; })); } },
    { key: 'approachAngleDegrees', group: 'touchdownPreparation', unit: '°', dp: 1,
      label: 'Foot approach angle',
      get: function (r) { return scalar(bothSidesMean(r.touchdownPreparation, function (a) {
        return a.approachAngleDegrees && a.approachAngleDegrees.median; })); } },

    // ── Projection ──
    { key: 'gctSeconds', group: 'projection', unit: 's', dp: 3, label: 'Ground contact time',
      get: function (r) { return fromAggregate(ovr(r.strideTiming) && ovr(r.strideTiming).contactSeconds); } },
    { key: 'stepSeconds', group: 'projection', unit: 's', dp: 3, label: 'Step time',
      get: function (r) { return fromAggregate(ovr(r.strideTiming) && ovr(r.strideTiming).stepSeconds); } },
    { key: 'dutyFactor', group: 'projection', unit: '', dp: 3, label: 'Duty factor',
      get: function (r) { return fromAggregate(ovr(r.strideTiming) && ovr(r.strideTiming).dutyFactor); } },
    { key: 'flightSeconds', group: 'projection', unit: 's', dp: 3, label: 'Flight time',
      get: function (r) { return fromAggregate(ovr(r.strideTiming) && ovr(r.strideTiming).flightSeconds); } },
    { key: 'meanVerticalSupportBW', group: 'projection', unit: 'BW', dp: 2,
      label: 'Mean vertical support estimate',
      get: function (r) { return fromAggregate(r.verticalProjection && r.verticalProjection.verticalSupport
        ? r.verticalProjection.verticalSupport.meanVerticalSupportBW : null); } },
    { key: 'verticalTakeoffVelocityMps', group: 'projection', unit: 'm/s', dp: 3,
      label: 'Vertical take-off velocity',
      get: function (r) { return fromAggregate(ovr(r.verticalProjection) &&
        ovr(r.verticalProjection).verticalTakeoffVelocityMps); } },
    { key: 'effectiveVerticalImpulsePerMass', group: 'projection', unit: 'N·s/kg', dp: 3,
      label: 'Effective vertical impulse per unit mass',
      get: function (r) { return fromAggregate(ovr(r.verticalProjection) &&
        ovr(r.verticalProjection).effectiveVerticalImpulsePerMassNsPerKg); } },
    { key: 'stanceReboundLegLengths', group: 'projection', unit: 'leg lengths', dp: 3,
      label: 'Stance rebound',
      get: function (r) { var d = r.comTrajectory && r.comTrajectory.decomposition
        ? r.comTrajectory.decomposition.overall : null;
        return scalar(d && d.stanceRebound ? d.stanceRebound.medianLegLengths : null); } },
    { key: 'stanceCompressionLegLengths', group: 'projection', unit: 'leg lengths', dp: 3,
      label: 'Stance compression',
      get: function (r) { var d = r.comTrajectory && r.comTrajectory.decomposition
        ? r.comTrajectory.decomposition.overall : null;
        return scalar(d && d.stanceCompression ? d.stanceCompression.medianLegLengths : null); } },
    { key: 'aerialRiseMeasuredLegLengths', group: 'projection', unit: 'leg lengths', dp: 3,
      label: 'Aerial rise (measured)',
      get: function (r) { var d = r.comTrajectory && r.comTrajectory.decomposition
        ? r.comTrajectory.decomposition.overall : null;
        return scalar(d && d.aerialRiseMeasured ? d.aerialRiseMeasured.medianLegLengths : null); } },
    { key: 'verticalOscillationLegLengths', group: 'projection', unit: 'leg lengths', dp: 3,
      label: 'Total vertical oscillation',
      get: function (r) { var d = r.comTrajectory && r.comTrajectory.decomposition
        ? r.comTrajectory.decomposition.overall : null;
        return scalar(d && d.verticalOscillation ? d.verticalOscillation.medianLegLengths : null); } },
    { key: 'verticalOscillationCm', group: 'projection', unit: 'cm', dp: 1,
      label: 'Total vertical oscillation',
      get: function (r) { var d = r.comTrajectory && r.comTrajectory.decomposition
        ? r.comTrajectory.decomposition.overall : null;
        return scalar(d && d.verticalOscillation ? d.verticalOscillation.medianCentimeters : null); } },
    { key: 'reversalRateLegLengthsPerS2', group: 'projection', unit: 'leg lengths/s²', dp: 2,
      label: 'COM vertical velocity reversal rate',
      get: function (r) { return fromAggregate(r.rebound && r.rebound.reversalRateLegLengthsPerS2); } },

    // ── Outcome ──
    { key: 'cadenceSpm', group: 'outcome', unit: 'spm', dp: 1, label: 'Cadence',
      get: function (r) { return fromAggregate(ovr(r.strideTiming) && ovr(r.strideTiming).cadenceSpm); } },
    { key: 'stepLengthMeters', group: 'outcome', unit: 'm', dp: 3, label: 'Step length',
      get: function (r) { return fromAggregate(r.strideOutcome && r.strideOutcome.stepLengthMeters); } },
    { key: 'strideLengthMeters', group: 'outcome', unit: 'm', dp: 3, label: 'Stride length',
      get: function (r) { return fromAggregate(r.strideOutcome && r.strideOutcome.strideLengthMeters); } },
    { key: 'flightDistanceMeters', group: 'outcome', unit: 'm', dp: 3, label: 'Flight distance',
      get: function (r) { return fromAggregate(r.strideOutcome && r.strideOutcome.flightDistanceMeters); } },
    { key: 'speedMps', group: 'outcome', unit: 'm/s', dp: 2, label: 'Running speed',
      get: function (r) { return scalar(r.video ? r.video.speedMps : null); } },

    // ── Ground interaction (secondary descriptive geometry) ──
    { key: 'earlySupportAngleDegrees', group: 'groundInteraction', unit: '°', dp: 1,
      label: 'Early-stance support geometry',
      get: function (r) { return scalar(supportAngle(r, 'early_stance')); } },
    { key: 'centralSupportAngleDegrees', group: 'groundInteraction', unit: '°', dp: 1,
      label: 'Central-stance support alignment',
      get: function (r) { return scalar(supportAngle(r, 'central_stance')); } },
    { key: 'lateSupportAngleDegrees', group: 'groundInteraction', unit: '°', dp: 1,
      label: 'Late-stance support geometry',
      get: function (r) { return scalar(supportAngle(r, 'late_stance')); } },
    { key: 'comLegDivergenceDegrees', group: 'groundInteraction', unit: '°', dp: 1,
      label: 'COM-to-leg divergence',
      get: function (r) { return scalar(divergence(r)); } }
  ];

  function supportAngle(r, phase) {
    var sg = r.supportGeometry;
    if (!sg) return null;
    var vals = ['left', 'right'].map(function (s) {
      var side = sg[s];
      return (side && side.phases && side.phases[phase] && side.phases[phase].angle)
        ? side.phases[phase].angle.median : null;
    }).filter(isNum);
    return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
  }
  function divergence(r) {
    var sg = r.supportGeometry;
    if (!sg) return null;
    var vals = [];
    ['left', 'right'].forEach(function (s) {
      var side = sg[s];
      if (!side || !side.phases) return;
      Object.keys(side.phases).forEach(function (p) {
        var d = side.phases[p].comLegDivergence;
        if (d && isNum(d.median)) vals.push(d.median);
      });
    });
    return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
  }

  // ── Delta computation ──────────────────────────────────────────────────────

  /**
   * A change is only called real if it clears stride-to-stride variability.
   * With confidence intervals on both sides that is a non-overlap test; with
   * SDs it is a pooled standardised difference; with neither it is left null so
   * the caller falls back to a relative dead-band alone.
   */
  function exceedsVariability(a, b) {
    if (a.ci95 && b.ci95 && isNum(a.ci95[0]) && isNum(b.ci95[0])) {
      return !(a.ci95[0] <= b.ci95[1] && b.ci95[0] <= a.ci95[1]);
    }
    if (isNum(a.sd) && isNum(b.sd) && isNum(a.n) && isNum(b.n) && a.n > 1 && b.n > 1) {
      var pooled = Math.sqrt(((a.n - 1) * a.sd * a.sd + (b.n - 1) * b.sd * b.sd) / (a.n + b.n - 2));
      if (!(pooled > 0)) return null;
      return Math.abs(b.value - a.value) / pooled >= 0.8;   // large standardised difference
    }
    return null;
  }

  function delta(metric, ra, rb) {
    var a = metric.get(ra) || scalar(null);
    var b = metric.get(rb) || scalar(null);
    if (!isNum(a.value) || !isNum(b.value)) {
      return {
        key: metric.key, label: metric.label, group: metric.group, unit: metric.unit,
        available: false,
        reason: !isNum(a.value) && !isNum(b.value) ? 'unavailable_in_both_conditions'
              : !isNum(a.value) ? 'unavailable_in_condition_a' : 'unavailable_in_condition_b',
        conditionA: isNum(a.value) ? a.value : null,
        conditionB: isNum(b.value) ? b.value : null
      };
    }
    var abs = b.value - a.value;
    return {
      key: metric.key, label: metric.label, group: metric.group, unit: metric.unit,
      decimals: metric.dp,
      available: true,
      conditionA: a.value, conditionB: b.value,
      baseline: a.value,
      absolute: abs,
      percent: a.value !== 0 ? (abs / Math.abs(a.value)) * 100 : null,
      exceedsVariability: exceedsVariability(a, b),
      distributions: {
        a: { median: a.value, mean: a.mean == null ? null : a.mean, sd: a.sd, n: a.n, ci95: a.ci95 },
        b: { median: b.value, mean: b.mean == null ? null : b.mean, sd: b.sd, n: b.n, ci95: b.ci95 }
      }
    };
  }

  // ── Speed comparability ────────────────────────────────────────────────────

  function speedComparability(ra, rb) {
    var sa = ra.video ? ra.video.speedMps : null;
    var sb = rb.video ? rb.video.speedMps : null;
    if (!isNum(sa) || !isNum(sb)) {
      return {
        comparable: null,
        speedA: isNum(sa) ? sa : null, speedB: isNum(sb) ? sb : null,
        sourceA: ra.video ? ra.video.speedSource : null,
        sourceB: rb.video ? rb.video.speedSource : null,
        warning: 'Running speed is unknown for at least one condition, so it cannot be established ' +
          'whether the differences are speed-dependent.',
        severity: 'caution'
      };
    }
    var absDiff = Math.abs(sb - sa);
    var relDiff = sa > 0 ? absDiff / sa : null;
    var mismatch = (isNum(relDiff) && relDiff > SPEED_TOLERANCE.relative) ||
                   absDiff > SPEED_TOLERANCE.absoluteMps;
    return {
      comparable: !mismatch,
      speedA: sa, speedB: sb,
      sourceA: ra.video.speedSource, sourceB: rb.video.speedSource,
      absoluteDifferenceMps: absDiff,
      relativeDifference: relDiff,
      tolerance: SPEED_TOLERANCE,
      warning: mismatch ? SPEED_WARNING : null,
      severity: mismatch ? 'warning' : 'none'
    };
  }

  // ── Top level ──────────────────────────────────────────────────────────────

  /**
   * @param {Object} conditionA {result, label}
   * @param {Object} conditionB {result, label}
   */
  function compare(conditionA, conditionB) {
    var ra = (conditionA && conditionA.result) || null;
    var rb = (conditionB && conditionB.result) || null;
    var labels = {
      a: (conditionA && conditionA.label) || 'Condition A',
      b: (conditionB && conditionB.label) || 'Condition B'
    };
    if (!ra || !rb) {
      return { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'two_analyses_required', labels: labels };
    }
    if (ra.analysisType !== PGI.ANALYSIS_TYPE || rb.analysisType !== PGI.ANALYSIS_TYPE) {
      return {
        availability: KFO.AVAILABILITY.UNAVAILABLE,
        reason: 'both_conditions_must_be_projection_ground_interaction_analyses',
        labels: labels,
        note: 'A legacy force-orientation analysis cannot be compared against a projection & ground ' +
          'interaction analysis: the stored quantities are not the same measurements.'
      };
    }

    var speed = speedComparability(ra, rb);
    var deltas = {}, byGroup = { touchdownPreparation: [], projection: [], outcome: [], groundInteraction: [] };
    METRICS.forEach(function (m) {
      var d = delta(m, ra, rb);
      deltas[m.key] = d;
      if (byGroup[m.group]) byGroup[m.group].push(d);
    });

    var interpretation = PGIPatterns.interpretComparison(deltas, {
      speedComparable: speed.comparable === null ? undefined : speed.comparable,
      labels: labels
    });

    // Confidence in the comparison is bounded by the weaker of the two analyses.
    function qConf(r) {
      return (r.quality && r.quality.confidence && isNum(r.quality.confidence.score))
        ? r.quality.confidence.score : null;
    }
    var ca = qConf(ra), cb = qConf(rb);
    var pairConfidence = (isNum(ca) && isNum(cb)) ? Math.min(ca, cb) : (isNum(ca) ? ca : cb);
    if (speed.comparable === false && isNum(pairConfidence)) pairConfidence *= 0.6;

    return {
      availability: KFO.AVAILABILITY.AVAILABLE,
      schemaVersion: PGI.SCHEMA_VERSION,
      labels: labels,
      speed: speed,
      deltas: deltas,
      groups: byGroup,
      patterns: interpretation.patterns,
      directions: interpretation.directions,
      confidence: pairConfidence,
      confidenceBand: KFO.confidenceBand(pairConfidence),
      disclaimer: PGI.DISCLAIMER,
      note: 'Differences describe how the two conditions differ mechanically. Neither condition is ' +
        'ranked as better.',
      changesExceedingVariability: Object.keys(deltas).filter(function (k) {
        return deltas[k].available && deltas[k].exceedsVariability === true;
      })
    };
  }

  return {
    SPEED_TOLERANCE: SPEED_TOLERANCE,
    SPEED_WARNING: SPEED_WARNING,
    METRICS: METRICS,
    exceedsVariability: exceedsVariability,
    speedComparability: speedComparability,
    compare: compare
  };
});
