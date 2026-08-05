// ─────────────────────────────────────────────────────────────────────────────
//  KFO — analysis orchestration
//
//  Pipeline:
//    retained scan samples
//      -> per-side stance intervals (ankle-Y peak + plateau, same algorithm the
//         production phase detector already uses in index.html findPhases)
//      -> per-stride support-line angle at three normalised stance windows
//      -> per-step vertical force magnitude from the same stance intervals
//      -> robust aggregation across strides
//      -> quality flags + uncertainty
//      -> reference comparison (if any reference is loaded)
//      -> coupled braking/propulsion pattern, symmetry, consistency
//      -> schema-v2 result envelope
//
//  Stance intervals come from ankle-Y maxima: in image space the ankle sits at
//  its lowest point (largest y) while the foot is planted, so the plateau around
//  each maximum IS the stance phase. This deliberately mirrors the existing
//  detector so KFO and the stride cards cannot disagree about where stance is.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var ref = isNode ? require('./kfo-reference.js') : root.KFOReference;
  var est = isNode ? require('./kfo-estimators.js') : root.KFOEstimators;
  // Optional: if the vertical-force module is not loaded the analysis still runs
  // and simply reports the force block as unavailable.
  var vf = isNode ? require('./kfo-vertical-force.js') : root.KFOVerticalForce;
  var api = factory(core, ref, est, vf);
  if (isNode) module.exports = api;
  if (root) root.KFOAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, KFOReference, KFOEstimators, KFOVerticalForce) {
  'use strict';

  var F = KFO.QUALITY_FLAG;

  var CONFIG = Object.freeze({
    minStrides: 3,
    recommendedStrides: 8,
    maxStrides: 20,
    minSamplesPerStance: 3,
    // The stance windows are 5 percentage points wide, so locating one needs
    // sample spacing finer than ~10% of stance — i.e. at least ~10 samples
    // inside stance. Below that, window placement is interpolation-dominated.
    sparseSamplesPerStance: 10,
    minStanceSeconds: 0.07,
    maxStanceSeconds: 0.50,
    lowEffectiveFps: 30,
    minPoseConfidence: 0.45,
    peakPercentileCut: 0.55,
    plateauTolScaleFraction: 0.05,
    perpendicularityShoulderRatio: 0.45,
    highVariabilitySdDegrees: 6
  });

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function median(a) { return KFO._internals.median(a); }

  // ── Stance interval detection ─────────────────────────────────────────────
  function localPeaks(samples, key, minSpacing) {
    var peaks = [];
    for (var i = 1; i < samples.length - 1; i++) {
      var v = samples[i][key];
      if (!isNum(v)) continue;
      var isMax = true;
      for (var w = 1; w <= minSpacing && isMax; w++) {
        var lo = i - w, hi = i + w;
        if (lo >= 0 && isNum(samples[lo][key]) && samples[lo][key] > v) isMax = false;
        if (hi < samples.length && isNum(samples[hi][key]) && samples[hi][key] > v) isMax = false;
      }
      if (isMax) peaks.push({ index: i, value: v, t: samples[i].t });
    }
    return peaks;
  }

  function prominenceFilter(samples, peaks, key, pct) {
    var vals = samples.map(function (s) { return s[key]; }).filter(isNum)
                      .sort(function (a, b) { return a - b; });
    if (vals.length < 6) return peaks;
    var cut = vals[Math.floor(vals.length * pct)];
    return peaks.filter(function (p) { return p.value >= cut; });
  }

  function findPlateau(samples, key, peakIndex, tol) {
    var peakVal = samples[peakIndex][key];
    if (!isNum(peakVal)) return null;
    var threshold = peakVal - tol;
    var lo = peakIndex, gap = 0, i, j;
    for (i = peakIndex - 1; i >= 0; i--) {
      var v = samples[i][key];
      if (!isNum(v) || v < threshold) { if (++gap >= 2) break; continue; }
      gap = 0; lo = i;
    }
    var hi = peakIndex; gap = 0;
    for (j = peakIndex + 1; j < samples.length; j++) {
      var v2 = samples[j][key];
      if (!isNum(v2) || v2 < threshold) { if (++gap >= 2) break; continue; }
      gap = 0; hi = j;
    }
    return { lo: lo, hi: hi };
  }

  /**
   * All plausible stance intervals for one side.
   * @returns {{accepted:Array, rejected:Array, plateauTolerance:number}}
   */
  function detectStanceIntervals(samples, side, cfg) {
    cfg = cfg || CONFIG;
    var key = side === 'left' ? 'lAnkleY' : 'rAnkleY';
    var sorted = samples.slice().sort(function (a, b) { return a.t - b.t; });
    var scales = sorted.map(function (s) { return s.scale; }).filter(isNum);
    var scaleMed = median(scales);
    var tol = isNum(scaleMed) ? scaleMed * cfg.plateauTolScaleFraction : 8;

    var peaks = prominenceFilter(sorted, localPeaks(sorted, key, 2), key, cfg.peakPercentileCut);
    var accepted = [], rejected = [], seen = {};

    peaks.forEach(function (pk) {
      var pl = findPlateau(sorted, key, pk.index, tol);
      if (!pl || pl.hi <= pl.lo) {
        rejected.push({ t: pk.t, reason: 'plateau_collapsed' });
        return;
      }
      var dedupeKey = pl.lo + ':' + pl.hi;
      if (seen[dedupeKey]) return;
      seen[dedupeKey] = true;

      var slice = sorted.slice(pl.lo, pl.hi + 1);
      var duration = slice[slice.length - 1].t - slice[0].t;
      if (slice.length < cfg.minSamplesPerStance) {
        rejected.push({ t: pk.t, reason: 'too_few_samples', samples: slice.length });
        return;
      }
      if (duration < cfg.minStanceSeconds || duration > cfg.maxStanceSeconds) {
        rejected.push({ t: pk.t, reason: 'implausible_stance_duration', durationSeconds: duration });
        return;
      }
      var confs = slice.map(function (s) { return s.conf; }).filter(isNum);
      var meanConf = confs.length ? confs.reduce(function (a, b) { return a + b; }, 0) / confs.length : 0;
      if (meanConf < cfg.minPoseConfidence) {
        rejected.push({ t: pk.t, reason: 'low_pose_confidence', poseConfidence: meanConf });
        return;
      }
      accepted.push({
        side: side,
        startTime: slice[0].t,
        endTime: slice[slice.length - 1].t,
        durationSeconds: duration,
        samples: slice,
        sampleCount: slice.length,
        poseConfidence: meanConf,
        peakTime: pk.t
      });
    });

    accepted.sort(function (a, b) { return a.startTime - b.startTime; });
    if (accepted.length > cfg.maxStrides) accepted = accepted.slice(0, cfg.maxStrides);
    return { accepted: accepted, rejected: rejected, plateauTolerance: tol };
  }

  // ── Per-stride analysis ───────────────────────────────────────────────────
  /**
   * Support-line angle at each stance window for one stance interval.
   * The angle is computed at both bracketing samples and interpolated, rather
   * than interpolating keypoints (which could synthesise an anatomically
   * impossible pose) or snapping to the nearest frame (which would discard the
   * timing precision the window definition depends on).
   */
  function analyzeStride(stance, directionSign, estimator, strideIndex) {
    var out = {
      strideIndex: strideIndex,
      side: stance.side,
      startTime: stance.startTime,
      endTime: stance.endTime,
      durationSeconds: stance.durationSeconds,
      sampleCount: stance.sampleCount,
      poseConfidence: stance.poseConfidence,
      phases: {},
      valid: false,
      rejectReasons: []
    };

    KFO.PHASE_ORDER.forEach(function (phase) {
      var win = KFO.PHASE_WINDOWS[phase];
      var pos = KFO.stancePercentToPosition(stance, win.targetPercent);
      if (!pos) {
        out.phases[phase] = { available: false, reason: 'stance_position_unavailable' };
        return;
      }
      var loS = stance.samples[pos.loIndex], hiS = stance.samples[pos.hiIndex];
      var a = estimator.estimate({
        keypoints: loS.kps, phase: phase, side: stance.side,
        directionSign: directionSign, comMethod: 'segmental'
      });
      var b = (pos.hiIndex !== pos.loIndex) ? estimator.estimate({
        keypoints: hiS.kps, phase: phase, side: stance.side,
        directionSign: directionSign, comMethod: 'segmental'
      }) : null;

      if (!a.ok && (!b || !b.ok)) {
        out.phases[phase] = { available: false, reason: (a.reason || (b && b.reason) || 'estimate_failed') };
        return;
      }
      var w = pos.weight;
      var angle, divergence, poseConf, repSample;
      if (a.ok && b && b.ok) {
        angle = a.angle.value * (1 - w) + b.angle.value * w;
        divergence = (isNum(a.comLegDivergenceDegrees) && isNum(b.comLegDivergenceDegrees))
          ? a.comLegDivergenceDegrees * (1 - w) + b.comLegDivergenceDegrees * w
          : (isNum(a.comLegDivergenceDegrees) ? a.comLegDivergenceDegrees : b.comLegDivergenceDegrees);
        poseConf = a.poseConfidence * (1 - w) + b.poseConfidence * w;
        repSample = w < 0.5 ? loS : hiS;
      } else {
        var ok = a.ok ? a : b;
        angle = ok.angle.value;
        divergence = ok.comLegDivergenceDegrees;
        poseConf = ok.poseConfidence;
        repSample = a.ok ? loS : hiS;
      }

      var reference = a.ok ? a : b;
      out.phases[phase] = {
        available: true,
        angleDegrees: angle,
        comLegDivergenceDegrees: isNum(divergence) ? divergence : null,
        poseConfidence: poseConf,
        com: reference.com,
        supportPoint: reference.supportPoint,
        event: {
          phase: phase,
          selectionMethod: KFO.EVENT_SELECTION.NORMALIZED_STANCE_WINDOW,
          targetPercent: win.targetPercent,
          actualPercent: pos.actualPercent,
          timestampMs: Math.round(pos.targetTime * 1000),
          representativeTimestampMs: Math.round(repSample.t * 1000),
          interpolated: pos.hiIndex !== pos.loIndex,
          eventConfidence: computeEventConfidence(stance, pos)
        }
      };
    });

    var avail = KFO.PHASE_ORDER.filter(function (p) { return out.phases[p] && out.phases[p].available; });
    out.valid = avail.length === KFO.PHASE_ORDER.length;
    if (!out.valid) out.rejectReasons.push('incomplete_phase_coverage');
    return out;
  }

  /**
   * Event confidence falls when a window must be interpolated across a wide gap
   * relative to stance duration — i.e. when sampling is too sparse to locate the
   * window precisely.
   */
  function computeEventConfidence(stance, pos) {
    var s = stance.samples;
    if (pos.hiIndex === pos.loIndex) return 0.6;
    var gap = s[pos.hiIndex].t - s[pos.loIndex].t;
    var frac = stance.durationSeconds > 0 ? gap / stance.durationSeconds : 1;
    // A gap of <10% of stance is precise; >40% is poor.
    return Math.max(0.15, Math.min(0.98, 1 - (frac - 0.10) / 0.30 * 0.6));
  }

  // ── Camera perpendicularity ───────────────────────────────────────────────
  /**
   * In a true sagittal view the two shoulders (and two hips) nearly overlap
   * horizontally. Large horizontal separation means the runner is angled toward
   * or away from the camera, which biases every sagittal angle.
   */
  function assessPerpendicularity(samples) {
    var ratios = [];
    samples.forEach(function (s) {
      if (!s || !s.kps) return;
      var lSh = s.kps[5], rSh = s.kps[6], lHi = s.kps[11], rHi = s.kps[12];
      if (!lSh || !rSh || !lHi || !rHi) return;
      if ((lSh.score || 0) < KFO.MIN_CONF || (rSh.score || 0) < KFO.MIN_CONF) return;
      var shMidY = (lSh.y + rSh.y) / 2, hiMidY = (lHi.y + rHi.y) / 2;
      var torso = Math.abs(hiMidY - shMidY);
      if (!(torso > 5)) return;
      ratios.push(Math.abs(lSh.x - rSh.x) / torso);
    });
    if (!ratios.length) return { score: null, medianRatio: null, perpendicular: null };
    var med = median(ratios);
    return {
      score: Math.max(0, Math.min(1, 1 - med / (CONFIG.perpendicularityShoulderRatio * 2))),
      medianRatio: med,
      perpendicular: med <= CONFIG.perpendicularityShoulderRatio
    };
  }

  // ── Steady-speed check ────────────────────────────────────────────────────
  /**
   * Only meaningful when the runner actually translates across the frame. On a
   * treadmill (or with a tracking camera) horizontal displacement is ~0 and no
   * conclusion is drawn rather than a false "steady" claim.
   */
  function assessSteadySpeed(stances, directionInfo) {
    if (!directionInfo || directionInfo.source !== 'hip_translation' || stances.length < 3) {
      return { assessable: false, accelerationDetected: false, reason: 'insufficient_translation_evidence' };
    }
    var vels = stances.map(function (st) {
      var s = st.samples, n = s.length;
      if (n < 2) return null;
      var dt = s[n - 1].t - s[0].t;
      if (!(dt > 0) || !isNum(s[0].hipMidX) || !isNum(s[n - 1].hipMidX)) return null;
      return Math.abs(s[n - 1].hipMidX - s[0].hipMidX) / dt;
    }).filter(isNum);
    if (vels.length < 3) return { assessable: false, accelerationDetected: false, reason: 'insufficient_velocity_samples' };
    var first = vels[0], last = vels[vels.length - 1];
    var med = median(vels) || 1;
    var relChange = Math.abs(last - first) / med;
    return {
      assessable: true,
      accelerationDetected: relChange > 0.15,
      relativeVelocityChange: relChange,
      reason: null
    };
  }

  // ── Side aggregation ──────────────────────────────────────────────────────
  function analyzeSide(samples, side, directionInfo, estimator, cfg) {
    cfg = cfg || CONFIG;
    var detection = detectStanceIntervals(samples, side, cfg);
    var strides = detection.accepted.map(function (st, i) {
      return analyzeStride(st, directionInfo.sign, estimator, i);
    });
    var valid = strides.filter(function (s) { return s.valid; });

    var phases = {};
    KFO.PHASE_ORDER.forEach(function (phase) {
      var angles = valid.map(function (s) { return s.phases[phase].angleDegrees; }).filter(isNum);
      var divs = valid.map(function (s) { return s.phases[phase].comLegDivergenceDegrees; }).filter(isNum);
      var confs = valid.map(function (s) { return s.phases[phase].poseConfidence; }).filter(isNum);
      var evConfs = valid.map(function (s) { return s.phases[phase].event.eventConfidence; }).filter(isNum);
      phases[phase] = {
        phase: phase,
        label: KFO.PHASE_WINDOWS[phase].label,
        window: {
          minPercent: KFO.PHASE_WINDOWS[phase].minPercent,
          maxPercent: KFO.PHASE_WINDOWS[phase].maxPercent,
          targetPercent: KFO.PHASE_WINDOWS[phase].targetPercent
        },
        angle: KFO.aggregate(angles),
        comLegDivergence: KFO.aggregate(divs),
        meanPoseConfidence: confs.length ? confs.reduce(function (a, b) { return a + b; }, 0) / confs.length : null,
        meanEventConfidence: evConfs.length ? evConfs.reduce(function (a, b) { return a + b; }, 0) / evConfs.length : null
      };
    });

    var sampleCounts = detection.accepted.map(function (s) { return s.sampleCount; });
    var medSamples = median(sampleCounts);
    return {
      side: side,
      stridesAnalyzed: valid.length,
      stridesRejected: detection.rejected.length + (strides.length - valid.length),
      rejections: detection.rejected.concat(
        strides.filter(function (s) { return !s.valid; })
               .map(function (s) { return { t: s.startTime, reason: s.rejectReasons.join(',') }; })),
      medianSamplesPerStance: medSamples,
      plateauTolerance: detection.plateauTolerance,
      phases: phases,
      strides: strides,
      stanceIntervals: detection.accepted.map(function (s) {
        return { startTime: s.startTime, endTime: s.endTime, durationSeconds: s.durationSeconds, sampleCount: s.sampleCount };
      })
    };
  }

  // ── Quality flags ─────────────────────────────────────────────────────────
  function buildQualityFlags(ctx) {
    var flags = [];
    function add(f) { if (flags.indexOf(f) === -1) flags.push(f); }

    if (isNum(ctx.effectiveFps) && ctx.effectiveFps < CONFIG.lowEffectiveFps) add(F.LOW_FRAME_RATE);
    if (isNum(ctx.medianSamplesPerStance) && ctx.medianSamplesPerStance < CONFIG.sparseSamplesPerStance) {
      add(F.SPARSE_STANCE_SAMPLING);
    }
    if (ctx.perpendicularity && ctx.perpendicularity.perpendicular === false) add(F.CAMERA_NOT_PERPENDICULAR);
    if (ctx.perpendicularity && isNum(ctx.perpendicularity.medianRatio) &&
        ctx.perpendicularity.medianRatio > CONFIG.perpendicularityShoulderRatio * 1.8) {
      add(F.EXCESSIVE_PERSPECTIVE);
    }
    if (isNum(ctx.meanPoseConfidence) && ctx.meanPoseConfidence < 0.55) add(F.LOW_POSE_CONFIDENCE);
    if (ctx.occlusion && (
          (isNum(ctx.occlusion.worstLandmark) && ctx.occlusion.worstLandmark > 0.12) ||
          (isNum(ctx.occlusion.overall) && ctx.occlusion.overall > 0.15))) {
      add(F.LANDMARK_OCCLUSION);
    }
    if (isNum(ctx.minStrides) && ctx.minStrides < CONFIG.minStrides) add(F.INSUFFICIENT_STRIDES);
    if (isNum(ctx.meanEventConfidence) && ctx.meanEventConfidence < 0.5) add(F.UNCERTAIN_CONTACT_FRAME);
    if (ctx.speedMps == null) add(F.SPEED_UNKNOWN);
    if (ctx.gradePercent == null) add(F.GRADE_UNKNOWN);
    if (ctx.steady && ctx.steady.accelerationDetected) add(F.ACCELERATION_DETECTED);
    if (ctx.direction && ctx.direction.mirroredSuspected) add(F.MIRRORED_VIDEO);
    if (ctx.direction && ctx.direction.confidence < 0.5) add(F.UNSTABLE_RUNNING_DIRECTION);
    if (isNum(ctx.maxStrideSd) && ctx.maxStrideSd > CONFIG.highVariabilitySdDegrees) add(F.HIGH_STRIDE_VARIABILITY);
    return flags;
  }

  /**
   * Occlusion is assessed PER LANDMARK as well as overall. Averaging across all
   * required landmarks hides the case that actually matters: losing the stance
   * ankle in a third of frames is only ~4% of all landmark observations, but it
   * disables the support point on those frames entirely. The worst single
   * landmark therefore drives the flag.
   */
  function occlusionRate(samples) {
    var needed = [5, 6, 11, 12, 13, 14, 15, 16];
    var missing = {}, seen = {}, totalMissing = 0, total = 0;
    needed.forEach(function (i) { missing[i] = 0; seen[i] = 0; });
    samples.forEach(function (s) {
      if (!s || !s.kps) return;
      needed.forEach(function (i) {
        total++; seen[i]++;
        if (!s.kps[i] || (s.kps[i].score || 0) < KFO.MIN_CONF) { missing[i]++; totalMissing++; }
      });
    });
    if (!total) return { overall: null, worstLandmark: null, worstIndex: null, perLandmark: null };
    var worst = 0, worstIdx = null, per = {};
    needed.forEach(function (i) {
      var r = seen[i] ? missing[i] / seen[i] : 0;
      per[i] = r;
      if (r > worst) { worst = r; worstIdx = i; }
    });
    return { overall: totalMissing / total, worstLandmark: worst, worstIndex: worstIdx, perLandmark: per };
  }

  // ── Symmetry and consistency ──────────────────────────────────────────────
  function buildSymmetry(left, right) {
    var out = { available: false, phases: {}, maxAbsoluteDifferenceDegrees: null, band: 'unknown' };
    if (!left || !right || !left.stridesAnalyzed || !right.stridesAnalyzed) {
      out.reason = 'both_sides_required';
      return out;
    }
    var maxDiff = 0, any = false;
    KFO.PHASE_ORDER.forEach(function (phase) {
      var l = left.phases[phase].angle.median, r = right.phases[phase].angle.median;
      if (!isNum(l) || !isNum(r)) { out.phases[phase] = { available: false }; return; }
      var d = Math.abs(l - r);
      any = true;
      if (d > maxDiff) maxDiff = d;
      out.phases[phase] = {
        available: true, leftMedian: l, rightMedian: r,
        absoluteDifferenceDegrees: d,
        moreBrakingSide: phase === KFO.PHASE.EARLY_STANCE ? (l < r ? 'left' : 'right') : null
      };
    });
    if (!any) { out.reason = 'no_comparable_phases'; return out; }
    out.available = true;
    out.maxAbsoluteDifferenceDegrees = maxDiff;
    out.band = maxDiff <= 2 ? 'high' : maxDiff <= 5 ? 'moderate' : 'low';
    out.note = 'Side-to-side difference in median support-line angle.';
    return out;
  }

  function buildConsistency(side) {
    if (!side || !side.stridesAnalyzed) return { available: false, band: 'unknown' };
    var sds = KFO.PHASE_ORDER.map(function (p) { return side.phases[p].angle.sd; }).filter(isNum);
    if (!sds.length) return { available: false, band: 'unknown' };
    var worst = Math.max.apply(null, sds);
    return {
      available: true,
      maxPhaseSdDegrees: worst,
      band: worst <= 2.5 ? 'high' : worst <= 5 ? 'moderate' : 'low',
      note: 'Stride-to-stride spread of the support-line angle.'
    };
  }

  // ── Reference comparison ──────────────────────────────────────────────────
  function buildReferenceComparison(sideResult, confidenceScore, context) {
    var out = { available: false, phases: {}, referenceVersion: KFOReference.REFERENCE_VERSION };
    if (!sideResult || !sideResult.stridesAnalyzed) { out.reason = 'no_strides'; return out; }
    var anyAvailable = false;
    KFO.PHASE_ORDER.forEach(function (phase) {
      var sel = KFOReference.selectReference({
        metric: KFOReference.METRIC.SUPPORT_LINE_ANGLE,
        phase: phase, side: sideResult.side,
        speedMps: context.speedMps, gradePercent: context.gradePercent, sex: context.sex
      });
      if (!sel.available) {
        out.phases[phase] = { available: false, note: sel.note, matchType: sel.matchType };
        return;
      }
      var sim = KFOReference.referenceSimilarity(
        sideResult.phases[phase].angle.median, sel.record, confidenceScore);
      out.phases[phase] = {
        available: sim.available,
        similarity: sim.score,
        z: sim.z,
        matchType: sel.matchType,
        note: sel.note,
        record: {
          population: sel.record.population, sampleSize: sel.record.sampleSize,
          mean: sel.record.mean, sd: sel.record.sd,
          provenance: sel.record.provenance, validationStatus: sel.record.validationStatus,
          assumptions: sel.record.assumptions || []
        },
        reason: sim.reason
      };
      if (sim.available) anyAvailable = true;
    });
    out.available = anyAvailable;
    out.disclaimer = 'Reference similarity is not a direct measure of running economy.';
    if (!anyAvailable) out.reason = 'no_reference_distribution_loaded';
    return out;
  }

  // ── Top-level ─────────────────────────────────────────────────────────────
  /**
   * @param {Object} input
   * @param {Array} input.samples       retained scan samples (need .t/.kps/.scale/.conf/.hipMidX/.lAnkleY/.rAnkleY)
   * @param {Object} [input.videoMetadata]
   * @param {number|null} [input.speedMps]
   * @param {number|null} [input.gradePercent]
   * @param {string|null} [input.sex]
   * @param {Object} [input.config]
   * @returns {Object} schema-v2 KFO result
   */
  function analyze(input) {
    input = input || {};
    var cfg = input.config || CONFIG;
    var samples = (input.samples || []).filter(function (s) { return s && isNum(s.t) && s.kps; });
    var meta = input.videoMetadata || {};

    var base = KFO.methodMetadata(KFO.METHOD.GEOMETRY_PROXY, KFOReference.REFERENCE_VERSION);
    var envelope = {
      analysisType: KFO.ANALYSIS_TYPE,
      schemaVersion: KFO.SCHEMA_VERSION,
      method: base.method,
      modelVersion: base.modelVersion,
      calibrationVersion: base.calibrationVersion,
      referenceVersion: KFOReference.REFERENCE_VERSION,
      isValidated: base.isValidated,
      limitations: base.limitations,
      angleConvention: {
        units: 'degrees', referenceAxis: 'vertical',
        negative: 'braking orientation', positive: 'propulsive orientation', zero: 'vertical support'
      },
      supportPointModel: KFO.SUPPORT_POINT_MODEL,
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: null
    };

    if (samples.length < 12) {
      envelope.reason = 'insufficient_samples';
      envelope.quality = { flags: [F.INSUFFICIENT_STRIDES], flagLabels: [KFO.FLAG_LABEL[F.INSUFFICIENT_STRIDES]] };
      return envelope;
    }

    var direction = KFO.inferRunningDirection(samples);
    if (direction.direction === KFO.RUNNING_DIRECTION.UNKNOWN) {
      envelope.reason = 'running_direction_unknown';
      envelope.quality = {
        flags: [F.UNSTABLE_RUNNING_DIRECTION],
        flagLabels: [KFO.FLAG_LABEL[F.UNSTABLE_RUNNING_DIRECTION]]
      };
      return envelope;
    }

    var estimator = KFOEstimators.GeometryProxyEstimator;
    var left = analyzeSide(samples, 'left', direction, estimator, cfg);
    var right = analyzeSide(samples, 'right', direction, estimator, cfg);

    var duration = samples[samples.length - 1].t - samples[0].t;
    var effectiveFps = duration > 0 ? samples.length / duration : null;
    var perpendicularity = assessPerpendicularity(samples);
    var steady = assessSteadySpeed(left.stanceIntervals.length >= right.stanceIntervals.length
      ? detectStanceIntervals(samples, 'left', cfg).accepted
      : detectStanceIntervals(samples, 'right', cfg).accepted, direction);

    var occlusion = occlusionRate(samples);
    var allConfs = samples.map(function (s) { return s.conf; }).filter(isNum);
    var meanPoseConfidence = allConfs.length ? allConfs.reduce(function (a, b) { return a + b; }, 0) / allConfs.length : null;

    var eventConfs = [];
    var strideSds = [];
    [left, right].forEach(function (sd) {
      KFO.PHASE_ORDER.forEach(function (p) {
        if (isNum(sd.phases[p].meanEventConfidence)) eventConfs.push(sd.phases[p].meanEventConfidence);
        if (isNum(sd.phases[p].angle.sd)) strideSds.push(sd.phases[p].angle.sd);
      });
    });

    var flags = buildQualityFlags({
      effectiveFps: effectiveFps,
      medianSamplesPerStance: median([left.medianSamplesPerStance, right.medianSamplesPerStance].filter(isNum)),
      perpendicularity: perpendicularity,
      meanPoseConfidence: meanPoseConfidence,
      occlusion: occlusion,
      minStrides: Math.min(left.stridesAnalyzed, right.stridesAnalyzed),
      meanEventConfidence: eventConfs.length ? eventConfs.reduce(function (a, b) { return a + b; }, 0) / eventConfs.length : null,
      speedMps: input.speedMps == null ? null : input.speedMps,
      gradePercent: input.gradePercent == null ? null : input.gradePercent,
      steady: steady,
      direction: direction,
      maxStrideSd: strideSds.length ? Math.max.apply(null, strideSds) : null
    });

    // Vertical force magnitude from stance/flight timing. This is the headline
    // quantity: unlike the support-line angle it says how hard the runner pushes,
    // and unlike the vertical:horizontal ratio it actually varies between runners.
    // It shares the stance intervals the angles are computed from, so the two can
    // never disagree about where stance was.
    var verticalForce = KFOVerticalForce ? KFOVerticalForce.analyze({
      leftStanceIntervals: left.stanceIntervals,
      rightStanceIntervals: right.stanceIntervals,
      effectiveSampleRateHz: effectiveFps,
      bodyMassKg: input.bodyMassKg == null ? null : input.bodyMassKg,
      qualityFlags: flags
    }) : {
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: 'vertical_force_module_not_loaded',
      isValidated: false
    };

    // Per-phase uncertainty, then attach to each aggregate.
    var overallSem = null;
    var sems = [];
    [left, right].forEach(function (sd) {
      KFO.PHASE_ORDER.forEach(function (p) {
        var agg = sd.phases[p].angle;
        var conf = KFO.computeConfidence({
          poseConfidence: sd.phases[p].meanPoseConfidence,
          samplesInStance: sd.medianSamplesPerStance,
          strideSem: agg.sem,
          flags: flags
        });
        sd.phases[p].confidence = conf;
        sd.phases[p].display = {
          angle: KFO.formatAngle(agg.median, conf.angleUncertaintyDegrees),
          band: KFO.confidenceBand(conf.score)
        };
        if (isNum(agg.sem)) sems.push(agg.sem);
      });
    });
    overallSem = sems.length ? median(sems) : null;

    var overallConfidence = KFO.computeConfidence({
      poseConfidence: meanPoseConfidence,
      samplesInStance: median([left.medianSamplesPerStance, right.medianSamplesPerStance].filter(isNum)),
      strideSem: overallSem,
      flags: flags
    });

    var context = {
      speedMps: input.speedMps == null ? null : input.speedMps,
      gradePercent: input.gradePercent == null ? null : input.gradePercent,
      sex: input.sex || null
    };

    var coupled = {};
    [['left', left], ['right', right]].forEach(function (pair) {
      var sd = pair[1];
      coupled[pair[0]] = KFO.classifyCoupledPattern(
        sd.phases[KFO.PHASE.EARLY_STANCE].angle.median,
        sd.phases[KFO.PHASE.LATE_STANCE].angle.median
      );
    });
    if (isNum(coupled.left.foreAftGeometricExcursionDegrees) &&
        isNum(coupled.right.foreAftGeometricExcursionDegrees)) {
      var dl = coupled.left.foreAftGeometricExcursionDegrees;
      var dr = coupled.right.foreAftGeometricExcursionDegrees;
      coupled.excursionDifferenceDegrees = Math.abs(dl - dr);
      coupled.higherExcursionSide = dl > dr ? 'left' : (dr > dl ? 'right' : null);
    }

    var hasStrides = left.stridesAnalyzed > 0 || right.stridesAnalyzed > 0;
    envelope.availability = hasStrides
      ? (overallConfidence.score < 0.25 ? KFO.AVAILABILITY.INSUFFICIENT_QUALITY : KFO.AVAILABILITY.AVAILABLE)
      : KFO.AVAILABILITY.UNAVAILABLE;
    if (!hasStrides) envelope.reason = 'no_valid_stance_phases_detected';

    envelope.videoMetadata = {
      fps: isNum(meta.fps) ? meta.fps : null,
      effectiveSampleRateHz: effectiveFps,
      width: isNum(meta.width) ? meta.width : null,
      height: isNum(meta.height) ? meta.height : null,
      durationSeconds: duration,
      runningDirection: direction.direction,
      runningDirectionSource: direction.source,
      runningDirectionConfidence: direction.confidence,
      estimatedSpeedMps: context.speedMps,
      gradePercent: context.gradePercent
    };
    envelope.quality = {
      flags: flags,
      flagLabels: flags.map(function (f) { return KFO.FLAG_LABEL[f] || f; }),
      meanPoseConfidence: meanPoseConfidence,
      occlusion: occlusion,
      perpendicularity: perpendicularity,
      steadySpeed: steady,
      confidence: overallConfidence,
      confidenceBand: KFO.confidenceBand(overallConfidence.score)
    };
    envelope.left = left;
    envelope.right = right;
    envelope.symmetry = buildSymmetry(left, right);
    envelope.consistency = { left: buildConsistency(left), right: buildConsistency(right) };
    envelope.coupledPattern = coupled;
    envelope.referenceComparison = {
      left: buildReferenceComparison(left, overallConfidence.score, context),
      right: buildReferenceComparison(right, overallConfidence.score, context),
      disclaimer: 'Reference similarity is not a direct measure of running economy.'
    };
    envelope.verticalForce = verticalForce;
    // forceMetrics stays unavailable: those are IMPULSE quantities requiring a
    // force-time series. A stride-averaged magnitude does not supply one.
    envelope.forceMetrics = KFO.unavailableForceMetrics('geometry_proxy_has_no_force_magnitude');
    envelope.config = {
      minStrides: cfg.minStrides, recommendedStrides: cfg.recommendedStrides, maxStrides: cfg.maxStrides
    };
    return envelope;
  }

  /** Aggregate-only projection for persistence (stride detail stays export-only). */
  function toStoredForm(result) {
    if (!result) return null;
    function sideSummary(s) {
      if (!s) return null;
      var phases = {};
      KFO.PHASE_ORDER.forEach(function (p) {
        if (!s.phases || !s.phases[p]) return;
        var a = s.phases[p].angle;
        phases[p] = {
          median: a.median, mean: a.mean, sd: a.sd, n: a.n,
          ci95: a.ci95,
          confidence: s.phases[p].confidence ? s.phases[p].confidence.score : null,
          uncertaintyDegrees: s.phases[p].confidence ? s.phases[p].confidence.angleUncertaintyDegrees : null
        };
      });
      return { stridesAnalyzed: s.stridesAnalyzed, stridesRejected: s.stridesRejected, phases: phases };
    }
    /**
     * Aggregate-only force block. Per-step timing and the per-step rejection list
     * stay in the research export: they are what a force-plate study needs and
     * what a user document has no reason to carry.
     */
    function forceSummary(vf) {
      if (!vf) return null;
      function agg(a) {
        if (!a) return null;
        return { n: a.n, median: a.median, mean: a.mean, sd: a.sd, ci95: a.ci95 };
      }
      return {
        method: vf.method || null,
        isValidated: !!vf.isValidated,
        availability: vf.availability,
        reason: vf.reason || null,
        stepsAnalyzed: vf.stepsAnalyzed || 0,
        stepsRejected: vf.stepsRejected || 0,
        dutyFactor: agg(vf.dutyFactor),
        contactSeconds: agg(vf.contactSeconds),
        flightSeconds: agg(vf.flightSeconds),
        cadenceSpm: agg(vf.cadenceSpm),
        meanVerticalForceBw: agg(vf.meanVerticalForceBw),
        peakVerticalForceBw: agg(vf.peakVerticalForceBw),
        relativeUncertainty: vf.relativeUncertainty == null ? null : vf.relativeUncertainty,
        peakBiasNote: vf.peakBiasNote || null,
        runLoadDfProxy: vf.runLoadDfProxy || null,
        gaitValidity: vf.gaitValidity || null,
        horizontal: vf.horizontal
          ? { availability: vf.horizontal.availability, reason: vf.horizontal.reason,
              explanation: vf.horizontal.explanation }
          : null,
        caveats: vf.caveats || [],
        limitations: vf.limitations || []
      };
    }
    return {
      analysisType: result.analysisType,
      schemaVersion: result.schemaVersion,
      method: result.method,
      modelVersion: result.modelVersion,
      referenceVersion: result.referenceVersion,
      isValidated: result.isValidated,
      availability: result.availability,
      reason: result.reason || null,
      angleConvention: result.angleConvention,
      videoMetadata: result.videoMetadata || null,
      quality: result.quality ? {
        flags: result.quality.flags,
        confidenceScore: result.quality.confidence ? result.quality.confidence.score : null,
        confidenceBand: result.quality.confidenceBand
      } : null,
      left: sideSummary(result.left),
      right: sideSummary(result.right),
      verticalForce: forceSummary(result.verticalForce),
      symmetry: result.symmetry || null,
      coupledPattern: result.coupledPattern || null,
      limitations: result.limitations || []
    };
  }

  return {
    CONFIG: CONFIG,
    detectStanceIntervals: detectStanceIntervals,
    analyzeStride: analyzeStride,
    analyzeSide: analyzeSide,
    assessPerpendicularity: assessPerpendicularity,
    assessSteadySpeed: assessSteadySpeed,
    buildQualityFlags: buildQualityFlags,
    buildSymmetry: buildSymmetry,
    buildConsistency: buildConsistency,
    buildReferenceComparison: buildReferenceComparison,
    occlusionRate: occlusionRate,
    analyze: analyze,
    toStoredForm: toStoredForm
  };
});
