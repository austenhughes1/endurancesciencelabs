// ─────────────────────────────────────────────────────────────────────────────
//  PGI — research export
//
//  Stride-level and frame-level JSON + CSV, for the force-plate validation that
//  every metric in this feature is still waiting on.
//
//  DESIGN RULES CARRIED OVER FROM kfo-export.js
//  --------------------------------------------
//  - CSV cells are quoted and a leading = + - @ is neutralised, so a value can
//    never execute as a spreadsheet formula.
//  - Empty is a legitimate value. A metric that was unavailable exports as an
//    empty cell, never as 0 — a zero would pool and average as if it had been
//    measured.
//  - Every row carries the provenance needed to interpret it: method, units,
//    calibration source, speed source, and the quality flags in force.
//
//  FRAME ROWS carry the raw AND smoothed trajectories side by side, so a
//  reviewer can see what the filter did rather than taking the derivatives on
//  trust — which matters most here, because every velocity in this feature is a
//  fitted derivative rather than a difference of two samples.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGIExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  var EXPORT_VERSION = 'pgi-export-v1';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round(v, dp) { return PGI._internals.round(v, dp); }

  /** Quote every cell and neutralise formula-injection prefixes. */
  function csvCell(v) {
    if (v == null || v === '') return '""';
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv(columns, rows) {
    var head = columns.map(csvCell).join(',');
    var body = rows.map(function (r) {
      return columns.map(function (c) { return csvCell(r[c]); }).join(',');
    });
    return [head].concat(body).join('\n');
  }

  // ── Stride-level ───────────────────────────────────────────────────────────

  var STRIDE_COLUMNS = [
    'analysisId', 'conditionId', 'conditionLabel', 'strideIndex', 'side',
    'startTimeSeconds',
    // context
    'speedMps', 'speedSource', 'speedConfidence', 'surfaceType', 'treadmillSpeedMps',
    'calibrationSource', 'pixelsPerMeter', 'legLengthPx', 'runningDirection',
    // timing
    'contactSeconds', 'flightSeconds', 'stepSeconds', 'dutyFactor', 'cadenceSpm',
    // projection
    'meanVerticalSupportBW', 'peakVerticalSupportBW', 'verticalTakeoffVelocityMps',
    'effectiveVerticalImpulsePerMassNsPerKg', 'aerialRiseBallisticMeters',
    // COM decomposition
    'verticalOscillationLegLengths', 'verticalOscillationCm',
    'stanceCompressionLegLengths', 'stanceReboundLegLengths', 'aerialRiseMeasuredLegLengths',
    'comVelocityTouchdownPxPerS', 'comVelocityToeoffPxPerS',
    'comVelocityReversalPxPerS', 'comReversalRatePxPerS2',
    // touchdown preparation
    'footComOffsetAtTouchdownLegLengths', 'footComOffsetAtTouchdownMeters',
    'maxAnteriorExcursionLegLengths', 'maxAnteriorExcursionTimeSeconds',
    'retractionTimeMs', 'retractionDistanceComLegLengths', 'retractionDistanceWorldLegLengths',
    'meanRetractionVelocityMps', 'peakRetractionVelocityMps',
    'horizontalFootVelocityMps', 'verticalFootVelocityMps', 'resultantFootVelocityMps',
    'approachAngleDegrees', 'footGroundVelocityMps', 'footGroundVelocityAvailability',
    'clearRetractionDetected', 'velocityWindowMs', 'samplesInPreContactWindow',
    // support geometry
    'earlyStanceAngleDegrees', 'centralStanceAngleDegrees', 'lateStanceAngleDegrees',
    'earlyStanceComLegDivergenceDegrees',
    // quality
    'poseConfidence', 'confidenceScore', 'confidenceBand', 'qualityFlags',
    'densePreContactUsed', 'footRepresentation', 'modelVersion', 'schemaVersion'
  ];

  /** Index the COM per-step results by side and start time. */
  function comLookup(result) {
    var map = {};
    var steps = (result.comTrajectory && result.comTrajectory.stepResults) || [];
    steps.forEach(function (s) {
      if (!s || !s.valid) return;
      map[s.contactSide + ':' + Math.round(s.startTime * 1000)] = s;
    });
    return function (side, startTime) {
      return map[side + ':' + Math.round(startTime * 1000)] || null;
    };
  }

  /** Index the touchdown per-contact results by side and touchdown time. */
  function touchdownLookup(result) {
    var map = {};
    ['left', 'right'].forEach(function (side) {
      var block = result.touchdownPreparation && result.touchdownPreparation[side];
      if (!block || !block.contacts) return;
      block.contacts.forEach(function (c) {
        map[side + ':' + Math.round(c.touchdownTime * 1000)] = c;
      });
    });
    return function (side, t) { return map[side + ':' + Math.round(t * 1000)] || null; };
  }

  function geometryFor(result, side, phase, field) {
    var sg = result.supportGeometry;
    if (!sg || !sg[side] || !sg[side].phases || !sg[side].phases[phase]) return null;
    var p = sg[side].phases[phase];
    var a = field === 'divergence' ? p.comLegDivergence : p.angle;
    return a && isNum(a.median) ? a.median : null;
  }

  function strideRows(result, meta) {
    meta = meta || {};
    if (!result) return [];
    var rows = [];
    var comAt = comLookup(result);
    var tdAt = touchdownLookup(result);
    var v = result.video || {};
    var q = result.quality || {};
    var flags = (q.flags || []).join('|');
    var cal = v.calibration || {};
    var steps = (result.strideTiming && result.strideTiming.steps) ||
                (result.__steps) || [];
    // The timing block keeps its per-step records at runtime; fall back to the
    // COM step results when only the assembled envelope is available.
    if (!steps.length && result.comTrajectory && result.comTrajectory.stepResults) {
      steps = result.comTrajectory.stepResults.filter(function (s) { return s.valid; })
        .map(function (s) {
          return { contactSide: s.contactSide, startTime: s.startTime,
                   contactSeconds: s.contactSeconds, flightSeconds: s.flightSeconds,
                   stepSeconds: s.stepSeconds,
                   dutyFactor: s.stepSeconds > 0 ? s.contactSeconds / s.stepSeconds : null,
                   cadenceSpm: s.stepSeconds > 0 ? 60 / s.stepSeconds : null };
        });
    }

    steps.forEach(function (st, i) {
      var com = comAt(st.contactSide, st.startTime);
      var td = tdAt(st.contactSide, st.startTime);
      var legLen = isNum(v.legLengthPx) && v.legLengthPx > 0 ? v.legLengthPx : null;
      function ll(px) { return (isNum(px) && legLen) ? round(px / legLen, 5) : ''; }
      var pos = td && td.position && td.position.availability === KFO.AVAILABILITY.AVAILABLE
        ? td.position : null;
      var ret = td && td.retraction && td.retraction.availability === KFO.AVAILABILITY.AVAILABLE
        ? td.retraction : null;
      var av = td && td.arrivalVelocity && td.arrivalVelocity.availability === KFO.AVAILABILITY.AVAILABLE
        ? td.arrivalVelocity : null;

      rows.push({
        analysisId: meta.analysisId || '',
        conditionId: meta.conditionId || '',
        conditionLabel: result.conditionLabel || meta.conditionLabel || '',
        strideIndex: i,
        side: st.contactSide,
        startTimeSeconds: round(st.startTime, 4),
        speedMps: round(v.speedMps, 4),
        speedSource: v.speedSource || '',
        speedConfidence: round(v.speedConfidence, 3),
        surfaceType: v.surfaceType || '',
        treadmillSpeedMps: round(v.treadmillSpeedMps, 3),
        calibrationSource: cal.source || '',
        pixelsPerMeter: round(cal.pixelsPerMeter, 3),
        legLengthPx: round(v.legLengthPx, 2),
        runningDirection: v.runningDirection || '',
        contactSeconds: round(st.contactSeconds, 4),
        flightSeconds: round(st.flightSeconds, 4),
        stepSeconds: round(st.stepSeconds, 4),
        dutyFactor: round(st.dutyFactor, 4),
        cadenceSpm: round(st.cadenceSpm, 2),
        meanVerticalSupportBW: isNum(st.dutyFactor) && st.dutyFactor > 0
          ? round(1 / st.dutyFactor, 4) : '',
        peakVerticalSupportBW: isNum(st.dutyFactor) && st.dutyFactor > 0
          ? round((Math.PI / 2) / st.dutyFactor, 4) : '',
        verticalTakeoffVelocityMps: round(PGI.verticalTakeoffVelocityMps(st.flightSeconds), 4),
        effectiveVerticalImpulsePerMassNsPerKg:
          round(PGI.effectiveVerticalImpulsePerMass(st.flightSeconds), 4),
        aerialRiseBallisticMeters: round(PGI.aerialRiseMeters(st.flightSeconds), 5),
        verticalOscillationLegLengths: com ? ll(com.verticalOscillationPx) : '',
        verticalOscillationCm: (com && isNum(com.verticalOscillationPx))
          ? round(PGI.pxToMeters(com.verticalOscillationPx, cal) * 100, 2) : '',
        stanceCompressionLegLengths: com ? ll(com.stanceCompressionPx) : '',
        stanceReboundLegLengths: com ? ll(com.stanceReboundPx) : '',
        aerialRiseMeasuredLegLengths: com ? ll(com.aerialRiseMeasuredPx) : '',
        comVelocityTouchdownPxPerS: com ? round(com.velocityPxPerS.touchdown, 3) : '',
        comVelocityToeoffPxPerS: com ? round(com.velocityPxPerS.toeoff, 3) : '',
        comVelocityReversalPxPerS: com ? round(com.velocityPxPerS.reversal, 3) : '',
        comReversalRatePxPerS2: com ? round(com.velocityPxPerS.reversalRatePerS, 3) : '',
        footComOffsetAtTouchdownLegLengths: pos ? round(pos.footComOffsetAtTouchdownLegLengths, 5) : '',
        footComOffsetAtTouchdownMeters: pos ? round(pos.footComOffsetAtTouchdownMeters, 5) : '',
        maxAnteriorExcursionLegLengths: pos ? round(pos.maxAnteriorExcursionLegLengths, 5) : '',
        maxAnteriorExcursionTimeSeconds: pos ? round(pos.maxAnteriorExcursionTime, 4) : '',
        retractionTimeMs: ret ? round(ret.retractionTimeMs, 2) : '',
        retractionDistanceComLegLengths: ret ? round(ret.retractionDistanceComLegLengths, 5) : '',
        retractionDistanceWorldLegLengths: ret ? round(ret.retractionDistanceWorldLegLengths, 5) : '',
        meanRetractionVelocityMps: ret ? round(ret.meanRetractionVelocityMps, 4) : '',
        peakRetractionVelocityMps: ret ? round(ret.peakRetractionVelocityMps, 4) : '',
        horizontalFootVelocityMps: av ? round(av.horizontalFootVelocityMps, 4) : '',
        verticalFootVelocityMps: av ? round(av.verticalFootVelocityMps, 4) : '',
        resultantFootVelocityMps: av ? round(av.resultantFootVelocityMps, 4) : '',
        approachAngleDegrees: av ? round(av.approachAngleDegrees, 2) : '',
        footGroundVelocityMps: (av && av.footGroundVelocity) ? round(av.footGroundVelocity.valueMps, 4) : '',
        footGroundVelocityAvailability: (av && av.footGroundVelocity)
          ? (av.footGroundVelocity.availability + (av.footGroundVelocity.reason
              ? ':' + av.footGroundVelocity.reason : '')) : '',
        clearRetractionDetected: ret ? (ret.clearRetractionDetected ? 'true' : 'false') : '',
        velocityWindowMs: (result.touchdownPreparation && result.touchdownPreparation.velocityWindow &&
                           result.touchdownPreparation.velocityWindow.windowMs) || '',
        samplesInPreContactWindow: td ? td.samplesInWindow : '',
        earlyStanceAngleDegrees: round(geometryFor(result, st.contactSide, 'early_stance'), 3),
        centralStanceAngleDegrees: round(geometryFor(result, st.contactSide, 'central_stance'), 3),
        lateStanceAngleDegrees: round(geometryFor(result, st.contactSide, 'late_stance'), 3),
        earlyStanceComLegDivergenceDegrees:
          round(geometryFor(result, st.contactSide, 'early_stance', 'divergence'), 3),
        poseConfidence: round(q.meanPoseConfidence, 3),
        confidenceScore: round(q.confidence ? q.confidence.score : q.confidenceScore, 3),
        confidenceBand: q.confidenceBand || '',
        qualityFlags: flags,
        densePreContactUsed: (result.touchdownPreparation &&
          result.touchdownPreparation.densePreContactSampling)
          ? (result.touchdownPreparation.densePreContactSampling.used ? 'true' : 'false') : '',
        footRepresentation: (result.touchdownPreparation &&
          result.touchdownPreparation.footRepresentation) || 'ankle',
        modelVersion: result.modelVersion || '',
        schemaVersion: result.schemaVersion || ''
      });
    });
    return rows;
  }

  // ── Frame-level ────────────────────────────────────────────────────────────

  var FRAME_COLUMNS = [
    'analysisId', 'conditionId', 'frameIndex', 'timestampSeconds',
    'comXRaw', 'comYRaw', 'comHeightSmoothed', 'comVerticalVelocityPxPerS',
    'comXSmoothed', 'comHorizontalVelocityPxPerS',
    'leftAnkleX', 'leftAnkleY', 'rightAnkleX', 'rightAnkleY',
    'leftFootComOffsetPx', 'rightFootComOffsetPx',
    'stanceState', 'stanceSide', 'stancePercent',
    'eventLabel', 'poseConfidence', 'bodyScalePx', 'landmarkConfidenceMin',
    'sampleSource', 'landmarksJson'
  ];

  /** Which stance (if any) a timestamp falls inside, and how far through it. */
  function stanceStateAt(result, t) {
    var out = { stanceState: 'flight', stanceSide: '', stancePercent: '' };
    var sides = ['left', 'right'];
    for (var i = 0; i < sides.length; i++) {
      var sd = result.supportGeometry && result.supportGeometry[sides[i]];
      var intervals = (sd && sd.stanceIntervals) || [];
      for (var j = 0; j < intervals.length; j++) {
        var iv = intervals[j];
        if (t >= iv.startTime && t <= iv.endTime) {
          var span = iv.endTime - iv.startTime;
          return {
            stanceState: 'stance', stanceSide: sides[i],
            stancePercent: span > 0 ? round(((t - iv.startTime) / span) * 100, 2) : ''
          };
        }
      }
    }
    return out;
  }

  function eventLabelAt(result, t, tolerance) {
    var tol = tolerance == null ? 0.012 : tolerance;
    var labels = [];
    ['left', 'right'].forEach(function (side) {
      var block = result.touchdownPreparation && result.touchdownPreparation[side];
      (block && block.contacts ? block.contacts : []).forEach(function (c) {
        if (Math.abs(c.touchdownTime - t) <= tol) labels.push(side + '_touchdown');
        if (c.position && isNum(c.position.maxAnteriorExcursionTime) &&
            Math.abs(c.position.maxAnteriorExcursionTime - t) <= tol) {
          labels.push(side + '_max_anterior_excursion');
        }
      });
    });
    var steps = (result.comTrajectory && result.comTrajectory.stepResults) || [];
    steps.forEach(function (s) {
      if (!s.valid) return;
      if (Math.abs(s.events.toeoff - t) <= tol) labels.push(s.contactSide + '_toeoff');
      if (Math.abs(s.events.minimumHeight - t) <= tol) labels.push(s.contactSide + '_com_minimum');
      if (isNum(s.events.flightApex) && Math.abs(s.events.flightApex - t) <= tol) {
        labels.push(s.contactSide + '_flight_apex');
      }
    });
    return labels.join('|');
  }

  function frameRows(result, samples, opts) {
    opts = opts || {};
    if (!result || !samples) return [];
    var series = (result.comTrajectory && result.comTrajectory.series) || null;
    var raw = series ? series.raw : [];
    var smoothed = series ? series.smoothed : [];
    var smoothedX = series ? series.smoothedX : [];
    var rawByT = {};
    raw.forEach(function (p) { rawByT[Math.round(p.t * 10000)] = p; });

    return samples.map(function (s, i) {
      var key = Math.round(s.t * 10000);
      var r = rawByT[key] || null;
      var h = PGI.valueAtTime(smoothed, s.t, 'value');
      var vy = PGI.valueAtTime(smoothed, s.t, 'd1');
      var xs = PGI.valueAtTime(smoothedX, s.t, 'value');
      var vx = PGI.valueAtTime(smoothedX, s.t, 'd1');
      var st = stanceStateAt(result, s.t);
      var lAn = PGI._internals.kpAt(s.kps, 15), rAn = PGI._internals.kpAt(s.kps, 16);
      var confs = (s.kps || []).map(function (k) { return k && isNum(k.score) ? k.score : null; })
                               .filter(isNum);
      return {
        analysisId: opts.analysisId || '',
        conditionId: opts.conditionId || '',
        frameIndex: i,
        timestampSeconds: round(s.t, 4),
        comXRaw: r ? round(r.x, 3) : '',
        comYRaw: r ? round(r.y, 3) : '',
        comHeightSmoothed: round(h, 3),
        comVerticalVelocityPxPerS: round(vy, 3),
        comXSmoothed: round(xs, 3),
        comHorizontalVelocityPxPerS: round(vx, 3),
        leftAnkleX: lAn ? round(lAn.x, 2) : '',
        leftAnkleY: lAn ? round(lAn.y, 2) : '',
        rightAnkleX: rAn ? round(rAn.x, 2) : '',
        rightAnkleY: rAn ? round(rAn.y, 2) : '',
        leftFootComOffsetPx: (lAn && r) ? round(lAn.x - r.x, 3) : '',
        rightFootComOffsetPx: (rAn && r) ? round(rAn.x - r.x, 3) : '',
        stanceState: st.stanceState,
        stanceSide: st.stanceSide,
        stancePercent: st.stancePercent,
        eventLabel: eventLabelAt(result, s.t),
        poseConfidence: round(s.conf, 4),
        bodyScalePx: round(s.scale, 2),
        landmarkConfidenceMin: confs.length ? round(Math.min.apply(null, confs), 4) : '',
        sampleSource: s.rescaledBy ? 'dense_rescaled' : 'coarse_scan',
        landmarksJson: opts.includeLandmarks && s.kps
          ? JSON.stringify(s.kps.map(function (k) {
              return k ? [round(k.x, 2), round(k.y, 2), round(k.score, 3)] : null; }))
          : ''
      };
    });
  }

  // ── Bundle ─────────────────────────────────────────────────────────────────

  function buildExport(result, samples, opts) {
    opts = opts || {};
    var strides = strideRows(result, opts);
    var frames = frameRows(result, samples || [], opts);
    return {
      exportVersion: EXPORT_VERSION,
      analysisType: result ? result.analysisType : null,
      schemaVersion: result ? result.schemaVersion : null,
      modelVersion: result ? result.modelVersion : null,
      analysisId: opts.analysisId || null,
      conditionId: opts.conditionId || null,
      conditionLabel: (result && result.conditionLabel) || opts.conditionLabel || null,
      isValidated: false,
      disclaimer: PGI.DISCLAIMER,
      // Everything a reviewer needs to interpret the numbers without the app.
      conventions: {
        signConvention: 'Horizontal quantities are positive in the direction of travel, after ' +
          'direction normalisation. Vertical quantities are positive upward.',
        footRepresentation: 'ankle landmark (no heel/toe landmark exists in COCO-17)',
        lengthNormalisation: 'LegLengths = value / (thigh + shank) pixel length',
        approachAngle: '0 degrees = travelling forward, +90 = straight down, negative = rising',
        emptyCells: 'An empty cell means unavailable. It is never a zero.',
        derivedFromFlightTime: ['verticalTakeoffVelocityMps = g*t_flight/2',
                                'effectiveVerticalImpulsePerMassNsPerKg = g*t_flight',
                                'aerialRiseBallisticMeters = g*t_flight^2/8'],
        derivedFromDutyFactor: ['meanVerticalSupportBW = 1/dutyFactor',
                                'peakVerticalSupportBW = (pi/2)/dutyFactor'],
        independentTimingQuantities: ['contactSeconds', 'flightSeconds'],
        independenceNote: 'Duty factor, cadence, step time, the support estimates and the ballistic ' +
          'projection quantities are all algebra on contact and flight time. They are exported for ' +
          'convenience and must not be treated as independent variables in an analysis.'
      },
      quality: result ? result.quality : null,
      video: result ? result.video : null,
      limitations: result ? result.limitations : [],
      validationStatus: {
        forcePlateValidated: false,
        metabolicallyValidated: false,
        note: 'No metric in this export has been validated against measured ground-reaction force ' +
          'or against running economy.'
      },
      strideLevel: strides,
      frameLevel: frames,
      csv: {
        strides: toCsv(STRIDE_COLUMNS, strides),
        frames: toCsv(FRAME_COLUMNS, frames)
      }
    };
  }

  /** Two conditions plus their comparison, as one research bundle. */
  function buildComparisonExport(conditionA, conditionB, comparison, opts) {
    opts = opts || {};
    return {
      exportVersion: EXPORT_VERSION,
      kind: 'condition_comparison',
      isValidated: false,
      disclaimer: PGI.DISCLAIMER,
      labels: comparison ? comparison.labels : null,
      speed: comparison ? comparison.speed : null,
      deltas: comparison ? comparison.deltas : null,
      patterns: comparison ? comparison.patterns : null,
      conditions: {
        a: buildExport(conditionA && conditionA.result, conditionA && conditionA.samples,
                       { analysisId: opts.analysisIdA || 'condition-a', conditionId: 'A',
                         conditionLabel: comparison ? comparison.labels.a : 'A',
                         includeLandmarks: opts.includeLandmarks }),
        b: buildExport(conditionB && conditionB.result, conditionB && conditionB.samples,
                       { analysisId: opts.analysisIdB || 'condition-b', conditionId: 'B',
                         conditionLabel: comparison ? comparison.labels.b : 'B',
                         includeLandmarks: opts.includeLandmarks })
      }
    };
  }

  return {
    EXPORT_VERSION: EXPORT_VERSION,
    STRIDE_COLUMNS: STRIDE_COLUMNS,
    FRAME_COLUMNS: FRAME_COLUMNS,
    csvCell: csvCell,
    toCsv: toCsv,
    strideRows: strideRows,
    frameRows: frameRows,
    stanceStateAt: stanceStateAt,
    eventLabelAt: eventLabelAt,
    buildExport: buildExport,
    buildComparisonExport: buildComparisonExport
  };
});
