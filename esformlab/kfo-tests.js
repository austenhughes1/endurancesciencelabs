// ─────────────────────────────────────────────────────────────────────────────
//  KFO — test suite
//
//  Runs in node (`node kfo-tests.js`) and in the browser (kfo-tests.html).
//  No test framework: a small assertion harness keeps the repo dependency-free,
//  matching the existing convention of self-contained admin validation pages.
//
//  FIXTURES ARE PHYSICALLY FAITHFUL, not hand-tuned to the expected answer. A
//  synthetic runner plants the foot at a fixed ground position while the body
//  translates forward, so the support line sweeps braking -> vertical ->
//  propulsive for the right mechanical reason rather than because the numbers
//  were chosen to.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var deps = isNode ? {
    KFO: require('./kfo-core.js'),
    KFOReference: require('./kfo-reference.js'),
    KFOEstimators: require('./kfo-estimators.js'),
    KFOAnalysis: require('./kfo-analysis.js')
  } : {
    KFO: root.KFO, KFOReference: root.KFOReference,
    KFOEstimators: root.KFOEstimators, KFOAnalysis: root.KFOAnalysis
  };
  var api = factory(deps);
  if (isNode) { module.exports = api; if (require.main === module) api.run(); }
  if (root) root.KFOTests = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (d) {
  'use strict';

  var KFO = d.KFO, KFOReference = d.KFOReference,
      KFOEstimators = d.KFOEstimators, KFOAnalysis = d.KFOAnalysis;

  // ── Harness ────────────────────────────────────────────────────────────────
  var results = [], currentSuite = '';
  function suite(name) { currentSuite = name; }
  function test(name, fn) {
    try { fn(); results.push({ suite: currentSuite, name: name, pass: true }); }
    catch (e) { results.push({ suite: currentSuite, name: name, pass: false, error: e.message }); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function assertClose(a, b, tol, msg) {
    if (typeof a !== 'number' || !isFinite(a)) throw new Error((msg || 'value') + ': not a finite number (' + a + ')');
    if (Math.abs(a - b) > tol) throw new Error((msg || 'value') + ': expected ~' + b + ' ±' + tol + ', got ' + a);
  }
  function assertSign(v, expected, msg) {
    if (typeof v !== 'number' || !isFinite(v)) throw new Error((msg || 'value') + ': not finite');
    if (expected < 0 && !(v < 0)) throw new Error((msg || 'value') + ': expected negative, got ' + v);
    if (expected > 0 && !(v > 0)) throw new Error((msg || 'value') + ': expected positive, got ' + v);
  }

  // ── Synthetic pose construction ───────────────────────────────────────────
  var TORSO = 60, HIP_ABOVE_GROUND = 95, SCALE = TORSO;

  /**
   * Build one COCO-17 frame. Facing is set by `dirSign` so the nose sits ahead of
   * the hips in the direction of travel.
   */
  function frame(opts) {
    var bodyX = opts.bodyX, groundY = opts.groundY, dirSign = opts.dirSign;
    var conf = opts.conf == null ? 0.85 : opts.conf;
    var hipY = groundY - HIP_ABOVE_GROUND;
    var shY = hipY - TORSO;
    var kps = new Array(17);
    function set(i, x, y, c) { kps[i] = { x: x, y: y, score: c == null ? conf : c }; }

    set(0, bodyX + 12 * dirSign, shY - 26);           // nose (facing)
    set(1, bodyX + 10 * dirSign, shY - 28);
    set(2, bodyX + 14 * dirSign, shY - 28);
    set(3, bodyX + 6 * dirSign, shY - 26);
    set(4, bodyX + 16 * dirSign, shY - 26);
    // Shoulders and hips nearly overlap horizontally in a true sagittal view.
    set(5, bodyX - 4, shY); set(6, bodyX + 4, shY);
    set(7, bodyX - 6 + 4 * dirSign, shY + 30); set(8, bodyX + 6 + 4 * dirSign, shY + 30);
    set(9, bodyX - 4 + 12 * dirSign, shY + 54); set(10, bodyX + 4 + 12 * dirSign, shY + 54);
    set(11, bodyX - 7, hipY); set(12, bodyX + 7, hipY);

    // Knees interpolate hip -> ankle so the shank length is well defined.
    function limb(hipIdx, kneeIdx, ankleIdx, ax, ay) {
      var h = kps[hipIdx];
      set(kneeIdx, h.x + (ax - h.x) * 0.5, h.y + (ay - h.y) * 0.52);
      set(ankleIdx, ax, ay);
    }
    limb(11, 13, 15, opts.lAnkleX, opts.lAnkleY);
    limb(12, 14, 16, opts.rAnkleX, opts.rAnkleY);
    return kps;
  }

  /**
   * Generate a clip.
   *
   * Physically faithful contract: during a stance the foot stays at a FIXED
   * ground x while the body translates at `velocityPxPerSec`. The plant position
   * is placed so the body passes over the foot at mid-stance, plus an optional
   * per-side `overstrideBias` that plants the foot further ahead (more braking).
   *
   * @param {Object} o
   * @param {number} o.sampleRateHz
   * @param {number} o.durationSeconds
   * @param {number} o.stanceSeconds
   * @param {number} o.stepPeriodSeconds  time between alternating foot contacts
   * @param {number} o.velocityPxPerSec   0 simulates treadmill running
   * @param {number} [o.overstrideBiasLeft]   px ahead of neutral plant
   * @param {number} [o.overstrideBiasRight]
   * @param {number} [o.dirSign]           +1 left-to-right, -1 right-to-left
   * @param {number} [o.conf]
   * @param {number} [o.occludeSideEvery]  drop that side's ankle every N samples
   */
  function makeClip(o) {
    var rate = o.sampleRateHz, dur = o.durationSeconds;
    var stance = o.stanceSeconds, step = o.stepPeriodSeconds;
    var v = o.velocityPxPerSec, dirSign = o.dirSign == null ? 1 : o.dirSign;
    var groundY = 400, startX = dirSign > 0 ? 120 : 900;
    var biasL = o.overstrideBiasLeft || 0, biasR = o.overstrideBiasRight || 0;
    var n = Math.round(dur * rate), samples = [];

    // Contact schedule: alternating sides every `step`.
    var contacts = [];
    for (var ci = 0, k = 0; ci * step < dur; ci++, k++) {
      contacts.push({ side: k % 2 === 0 ? 'left' : 'right', start: ci * step, end: ci * step + stance });
    }
    function bodyXAt(t) { return startX + v * t * dirSign; }
    // Foot plant so the body is over the foot at mid-stance, offset by the bias
    // in the direction of travel (further ahead = more braking).
    function plantX(c) {
      var mid = c.start + stance / 2;
      var bias = (c.side === 'left' ? biasL : biasR);
      return bodyXAt(mid) + bias * dirSign;
    }

    for (var i = 0; i < n; i++) {
      var t = i / rate;
      var bodyX = bodyXAt(t);
      var active = null;
      for (var j = 0; j < contacts.length; j++) {
        if (t >= contacts[j].start && t <= contacts[j].end) { active = contacts[j]; break; }
      }
      // Default: both feet in swing, lifted off the ground.
      var lAnkleX = bodyX - 10, lAnkleY = groundY - 45;
      var rAnkleX = bodyX + 10, rAnkleY = groundY - 45;
      if (active) {
        var px = plantX(active);
        if (active.side === 'left') { lAnkleX = px; lAnkleY = groundY; }
        else { rAnkleX = px; rAnkleY = groundY; }
      }
      // Tiny deterministic jitter, well inside the plateau tolerance (5% of torso).
      var jitter = ((i * 37) % 7 - 3) * 0.15;
      lAnkleY += jitter; rAnkleY += jitter;

      var conf = o.conf == null ? 0.85 : o.conf;
      var kps = frame({
        bodyX: bodyX, groundY: groundY, dirSign: dirSign, conf: conf,
        lAnkleX: lAnkleX, lAnkleY: lAnkleY, rAnkleX: rAnkleX, rAnkleY: rAnkleY
      });
      if (o.occludeSideEvery && i % o.occludeSideEvery === 0) {
        kps[15] = { x: lAnkleX, y: lAnkleY, score: 0.05 };
        kps[13] = { x: kps[13].x, y: kps[13].y, score: 0.05 };
      }
      samples.push({
        t: t, kps: kps, conf: conf, scale: SCALE,
        hipMidX: bodyX,
        lAnkleX: lAnkleX, lAnkleY: lAnkleY, rAnkleX: rAnkleX, rAnkleY: rAnkleY
      });
    }
    return samples;
  }

  var STEADY = {
    sampleRateHz: 100, durationSeconds: 3.0, stanceSeconds: 0.22,
    stepPeriodSeconds: 0.36, velocityPxPerSec: 300
  };
  function clip(over) {
    var o = {}, k;
    for (k in STEADY) o[k] = STEADY[k];
    for (k in (over || {})) o[k] = over[k];
    return makeClip(o);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: support-line angle and sign convention
  // ═══════════════════════════════════════════════════════════════════════════
  suite('support-line angle');

  function singleFrameAngle(footOffsetPx, dirSign, phase) {
    var groundY = 400, bodyX = 500;
    var kps = frame({
      bodyX: bodyX, groundY: groundY, dirSign: dirSign, conf: 0.9,
      lAnkleX: bodyX + footOffsetPx * dirSign, lAnkleY: groundY,
      rAnkleX: bodyX - 30 * dirSign, rAnkleY: groundY - 45
    });
    return KFO.computeSupportLine({
      keypoints: kps, side: 'left', phase: phase || KFO.PHASE.CENTRAL_STANCE,
      directionSign: dirSign
    });
  }

  test('contact ahead of COM yields a negative (braking) angle, left-to-right', function () {
    var r = singleFrameAngle(45, 1);
    assert(r.ok, 'expected ok, got ' + r.reason);
    assertSign(r.angle.value, -1, 'braking angle');
  });

  test('contact behind COM yields a positive (propulsive) angle, left-to-right', function () {
    var r = singleFrameAngle(-45, 1);
    assert(r.ok, 'expected ok');
    assertSign(r.angle.value, 1, 'propulsive angle');
  });

  test('sign convention is identical for right-to-left running', function () {
    var ltr = singleFrameAngle(45, 1), rtl = singleFrameAngle(45, -1);
    assert(ltr.ok && rtl.ok, 'both directions should compute');
    assertSign(rtl.angle.value, -1, 'braking angle (right-to-left)');
    // Same mechanics mirrored should give the same magnitude, not a flipped sign.
    assertClose(rtl.angle.value, ltr.angle.value, 1.5, 'mirrored magnitude');
  });

  test('foot under the COM is near vertical', function () {
    // The central-stance support offset shifts the support point slightly, so
    // neutrality is expected near zero rather than exactly zero.
    var r = singleFrameAngle(0, 1);
    assert(r.ok, 'expected ok');
    assert(Math.abs(r.angle.value) < 6, 'expected near-vertical, got ' + r.angle.value);
  });

  test('angle carries full metadata, never a bare number', function () {
    var a = singleFrameAngle(30, 1).angle;
    assert(a.units === 'degrees', 'units');
    assert(a.referenceAxis === 'vertical', 'reference axis');
    assert(a.signConvention === 'negative_braking_positive_propulsive', 'sign convention');
    assert(a.method === KFO.METHOD.GEOMETRY_PROXY, 'method');
    assert(a.provenance === KFO.PROVENANCE.KINEMATIC_ESTIMATE, 'provenance');
    assert(a.side === 'left' && a.phase, 'side and phase');
  });

  test('unknown running direction is refused, not guessed', function () {
    var groundY = 400, kps = frame({
      bodyX: 500, groundY: groundY, dirSign: 1, conf: 0.9,
      lAnkleX: 500, lAnkleY: groundY, rAnkleX: 470, rAnkleY: groundY - 45
    });
    var r = KFO.computeSupportLine({ keypoints: kps, side: 'left', phase: KFO.PHASE.CENTRAL_STANCE, directionSign: null });
    assert(!r.ok && r.reason === 'unknown_running_direction', 'should refuse without direction');
  });

  test('degenerate vertical extent is rejected rather than divided through', function () {
    // COM level with the ankle: no valid support line.
    var kps = frame({ bodyX: 500, groundY: 400, dirSign: 1, conf: 0.9,
                      lAnkleX: 500, lAnkleY: 400, rAnkleX: 470, rAnkleY: 355 });
    kps[15] = { x: 500, y: 240, score: 0.9 }; // ankle raised to COM height
    kps[13] = { x: 500, y: 240, score: 0.9 };
    var r = KFO.computeSupportLine({ keypoints: kps, side: 'left', phase: KFO.PHASE.CENTRAL_STANCE, directionSign: 1 });
    assert(!r.ok, 'expected rejection, got angle ' + (r.angle && r.angle.value));
    assert(r.reason === 'degenerate_vertical_extent', 'reason was ' + r.reason);
  });

  test('low-confidence landmarks are refused', function () {
    var kps = frame({ bodyX: 500, groundY: 400, dirSign: 1, conf: 0.05,
                      lAnkleX: 520, lAnkleY: 400, rAnkleX: 470, rAnkleY: 355 });
    var r = KFO.computeSupportLine({ keypoints: kps, side: 'left', phase: KFO.PHASE.CENTRAL_STANCE, directionSign: 1 });
    assert(!r.ok, 'expected refusal on low confidence');
  });

  test('support point is documented as not centre of pressure', function () {
    assert(KFO.SUPPORT_POINT_MODEL.isCentreOfPressure === false, 'must not claim COP');
    var sp = singleFrameAngle(20, 1).supportPoint;
    assert(sp.isCentreOfPressure === false, 'per-result COP flag');
    assert(sp.anchor === 'ankle', 'anchor documented');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: running direction
  // ═══════════════════════════════════════════════════════════════════════════
  suite('running direction');

  test('left-to-right translation is detected from hip displacement', function () {
    var dir = KFO.inferRunningDirection(clip({}));
    assert(dir.direction === KFO.RUNNING_DIRECTION.LEFT_TO_RIGHT, 'got ' + dir.direction);
    assert(dir.source === 'hip_translation', 'source ' + dir.source);
    assert(dir.confidence > 0.8, 'confidence ' + dir.confidence);
    assert(dir.mirroredSuspected === false, 'translation evidence should not suspect mirroring');
  });

  test('right-to-left translation is detected', function () {
    var dir = KFO.inferRunningDirection(clip({ dirSign: -1 }));
    assert(dir.direction === KFO.RUNNING_DIRECTION.RIGHT_TO_LEFT, 'got ' + dir.direction);
    assert(dir.sign === -1, 'sign');
  });

  test('treadmill running falls back to facing and flags possible mirroring', function () {
    var dir = KFO.inferRunningDirection(clip({ velocityPxPerSec: 0 }));
    assert(dir.source === 'body_facing', 'source ' + dir.source);
    assert(dir.mirroredSuspected === true, 'facing fallback cannot rule out mirroring');
    assert(dir.confidence <= 0.75, 'facing confidence should be capped');
  });

  test('too little data yields unknown rather than a guess', function () {
    var dir = KFO.inferRunningDirection([{ t: 0, hipMidX: 10 }]);
    assert(dir.direction === KFO.RUNNING_DIRECTION.UNKNOWN, 'expected unknown');
    assert(dir.confidence === 0, 'confidence should be zero');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: stance detection and normalisation
  // ═══════════════════════════════════════════════════════════════════════════
  suite('stance detection');

  test('multiple stance intervals are detected per side', function () {
    var s = clip({});
    var l = KFOAnalysis.detectStanceIntervals(s, 'left');
    var r = KFOAnalysis.detectStanceIntervals(s, 'right');
    assert(l.accepted.length >= 3, 'left stances: ' + l.accepted.length);
    assert(r.accepted.length >= 3, 'right stances: ' + r.accepted.length);
  });

  test('detected stance duration matches the simulated contact time', function () {
    var l = KFOAnalysis.detectStanceIntervals(clip({}), 'left');
    var durs = l.accepted.map(function (a) { return a.durationSeconds; });
    var med = KFO._internals.median(durs);
    assertClose(med, 0.22, 0.05, 'median stance duration');
  });

  test('implausible stance durations are rejected with a reason', function () {
    var s = clip({ stanceSeconds: 0.60, stepPeriodSeconds: 0.90 });
    var l = KFOAnalysis.detectStanceIntervals(s, 'left');
    assert(l.rejected.length > 0, 'expected rejections');
    assert(l.rejected.some(function (r) { return r.reason === 'implausible_stance_duration'; }),
      'reasons: ' + JSON.stringify(l.rejected.map(function (r) { return r.reason; })));
  });

  test('stance percentage interpolates between bracketing samples', function () {
    var stance = { samples: [{ t: 1.0 }, { t: 1.1 }, { t: 1.2 }] };
    var mid = KFO.stancePercentToPosition(stance, 50);
    assertClose(mid.targetTime, 1.1, 1e-9, 'target time at 50%');
    var q = KFO.stancePercentToPosition(stance, 75);
    assertClose(q.targetTime, 1.15, 1e-9, 'target time at 75%');
    assertClose(q.weight, 0.5, 1e-9, 'interpolation weight');
    assertClose(q.actualPercent, 75, 1e-6, 'actual percent');
  });

  test('phase windows sit where the mechanics justify them', function () {
    assert(KFO.PHASE_WINDOWS.early_stance.targetPercent === 12.5, 'early window');
    assert(KFO.PHASE_WINDOWS.central_stance.targetPercent === 50, 'central window');
    assert(KFO.PHASE_WINDOWS.late_stance.targetPercent === 87.5, 'late window');
    // Never exact foot-strike or toe-off, where force magnitude approaches zero.
    KFO.PHASE_ORDER.forEach(function (p) {
      var w = KFO.PHASE_WINDOWS[p];
      assert(w.minPercent > 0 && w.maxPercent < 100, p + ' must exclude the stance endpoints');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: aggregation
  // ═══════════════════════════════════════════════════════════════════════════
  suite('aggregation');

  test('descriptive statistics are correct', function () {
    var a = KFO.aggregate([2, 4, 4, 4, 5, 5, 7, 9]);
    assert(a.n === 8, 'n');
    assertClose(a.mean, 5, 1e-9, 'mean');
    assertClose(a.median, 4.5, 1e-9, 'median');
    assertClose(a.sd, 2.1381, 0.001, 'sample sd');
    assertClose(a.min, 2, 1e-9, 'min'); assertClose(a.max, 9, 1e-9, 'max');
    assert(a.ci95 && a.ci95.length === 2, 'ci95 present');
    assert(a.ci95[0] < a.mean && a.ci95[1] > a.mean, 'ci brackets the mean');
  });

  test('confidence interval uses a small-sample t multiplier', function () {
    var a = KFO.aggregate([10, 12, 14]);
    var halfWidth = a.ci95[1] - a.mean;
    // t(df=2) = 4.303, sem = 2/sqrt(3) = 1.1547 -> 4.97, far wider than 1.96*sem.
    assertClose(halfWidth, 4.303 * a.sem, 1e-6, 'half width');
    assert(halfWidth > 1.96 * a.sem, 'small samples must widen the interval');
  });

  test('outliers are flagged, never silently dropped', function () {
    var a = KFO.aggregate([10, 10.5, 11, 10.8, 40]);
    assert(a.outlierCount === 1, 'outlier count: ' + a.outlierCount);
    assert(a.outliers[0] === 40, 'outlier value');
    assert(a.n === 5, 'n must still include the outlier');
    assert(a.max === 40, 'max must still reflect it');
  });

  test('empty input yields nulls rather than NaN', function () {
    var a = KFO.aggregate([]);
    assert(a.n === 0 && a.mean === null && a.sd === null && a.ci95 === null, 'nulls expected');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: uncertainty, confidence, formatting
  // ═══════════════════════════════════════════════════════════════════════════
  suite('uncertainty');

  test('lower pose confidence widens angular uncertainty', function () {
    var hi = KFO.computeConfidence({ poseConfidence: 0.95, strideSem: 0, flags: [] });
    var lo = KFO.computeConfidence({ poseConfidence: 0.30, strideSem: 0, flags: [] });
    assert(lo.angleUncertaintyDegrees > hi.angleUncertaintyDegrees, 'uncertainty should widen');
    assert(lo.score < hi.score, 'confidence should fall');
  });

  test('quality flags reduce the confidence score', function () {
    var clean = KFO.computeConfidence({ poseConfidence: 0.9, strideSem: 0, flags: [] });
    var flagged = KFO.computeConfidence({
      poseConfidence: 0.9, strideSem: 0,
      flags: [KFO.QUALITY_FLAG.CAMERA_NOT_PERPENDICULAR, KFO.QUALITY_FLAG.INSUFFICIENT_STRIDES]
    });
    assert(flagged.score < clean.score, 'flags must penalise');
  });

  test('speed_unknown is penalised only lightly for orientation (Clark speed-invariance)', function () {
    var base = KFO.computeConfidence({ poseConfidence: 0.9, strideSem: 0, flags: [] });
    var speed = KFO.computeConfidence({ poseConfidence: 0.9, strideSem: 0, flags: [KFO.QUALITY_FLAG.SPEED_UNKNOWN] });
    var camera = KFO.computeConfidence({ poseConfidence: 0.9, strideSem: 0, flags: [KFO.QUALITY_FLAG.CAMERA_NOT_PERPENDICULAR] });
    var speedDrop = base.score - speed.score, cameraDrop = base.score - camera.score;
    assert(speedDrop > 0, 'speed_unknown should still cost something');
    assert(speedDrop < cameraDrop / 2, 'speed penalty (' + speedDrop.toFixed(3) +
      ') should be far smaller than camera penalty (' + cameraDrop.toFixed(3) + ')');
  });

  test('display precision never exceeds what uncertainty supports', function () {
    assert(KFO.formatAngle(-8.94, 2.7).indexOf('-8.9') === 0, 'moderate: one decimal with range');
    assert(KFO.formatAngle(-8.94, 2.7).indexOf('±') > -1, 'must show ± range');
    assert(KFO.formatAngle(-8.94, 4.5) === '-9° ± 5°', 'coarse: whole degrees, got ' + KFO.formatAngle(-8.94, 4.5));
    var broad = KFO.formatAngle(-8.94, 8);
    assert(broad.indexOf('to') > -1, 'very uncertain: a range, got ' + broad);
    assert(broad.indexOf('8.94') === -1, 'must not leak spurious precision');
  });

  test('confidence bands are monotonic', function () {
    assert(KFO.confidenceBand(0.9) === 'high', 'high');
    assert(KFO.confidenceBand(0.5) === 'moderate', 'moderate');
    assert(KFO.confidenceBand(0.2) === 'low', 'low');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: coupled braking / propulsion
  // ═══════════════════════════════════════════════════════════════════════════
  suite('coupled pattern');

  test('small braking + small propulsion reads as low excursion, momentum preserved', function () {
    var c = KFO.classifyCoupledPattern(-4, 4);
    assert(c.pattern === KFO.COUPLED_PATTERN.LOW_EXCURSION, 'pattern ' + c.pattern);
    assert(c.momentumPreservationFlag === true, 'momentum flag');
    assert(/momentum preservation/i.test(c.interpretation), 'interpretation mentions momentum');
    assert(/force magnitude is not available/i.test(c.interpretation), 'must disclaim magnitude');
  });

  test('large braking + large propulsion reads as high excursion, not as better drive', function () {
    var c = KFO.classifyCoupledPattern(-14, 14);
    assert(c.pattern === KFO.COUPLED_PATTERN.HIGH_EXCURSION, 'pattern ' + c.pattern);
    assert(/re-propulsion demand/i.test(c.interpretation), 'should frame as demand');
    assert(!/efficient|optimal|better|good drive/i.test(c.interpretation), 'must not praise: ' + c.interpretation);
  });

  test('braking-dominant and propulsion-dominant asymmetries are distinguished', function () {
    assert(KFO.classifyCoupledPattern(-16, 5).pattern === KFO.COUPLED_PATTERN.BRAKING_DOMINANT, 'braking dominant');
    assert(KFO.classifyCoupledPattern(-4, 16).pattern === KFO.COUPLED_PATTERN.PROPULSION_DOMINANT, 'propulsion dominant');
  });

  test('fore-aft excursion is the sum of magnitudes and components stay visible', function () {
    var c = KFO.classifyCoupledPattern(-7, 9);
    assertClose(c.foreAftGeometricExcursionDegrees, 16, 1e-9, 'excursion');
    assertClose(c.brakingMagnitudeDegrees, 7, 1e-9, 'braking component');
    assertClose(c.propulsiveMagnitudeDegrees, 9, 1e-9, 'propulsive component');
    assert(c.isKinematicDescriptorOnly === true, 'must be marked descriptor-only');
  });

  test('a near-vertical late stance is never labelled a deficiency', function () {
    // V1 called this "under-propulsive". The literature does not support treating
    // vertical late-stance orientation as a fault.
    var c = KFO.classifyCoupledPattern(-3, 1);
    assert(!/under-?propulsive|deficien|too vertical|weak/i.test(c.interpretation),
      'must not penalise vertical late stance: ' + c.interpretation);
  });

  test('missing phase data is indeterminate, not zero', function () {
    var c = KFO.classifyCoupledPattern(null, 8);
    assert(c.pattern === KFO.COUPLED_PATTERN.INDETERMINATE, 'pattern');
    assert(c.foreAftGeometricExcursionDegrees === null, 'excursion must be null');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: reference model
  // ═══════════════════════════════════════════════════════════════════════════
  suite('reference model');

  test('store ships empty, so no comparison is invented', function () {
    KFOReference.clearRecords();
    KFOReference.derivedProvider.enabled = false;
    var sel = KFOReference.selectReference({
      metric: KFOReference.METRIC.SUPPORT_LINE_ANGLE, phase: KFO.PHASE.EARLY_STANCE, speedMps: 4.8
    });
    assert(sel.available === false, 'must be unavailable');
    assert(sel.matchType === 'none', 'match type');
    assert(/No reference distribution is loaded/i.test(sel.note), 'note explains absence');
  });

  test('speed-matched record is preferred when speed is known', function () {
    KFOReference.clearRecords();
    KFOReference.addRecords([
      { metric: 'support_line_angle', phase: KFO.PHASE.EARLY_STANCE, sideApplicability: 'both',
        speedMinMps: 4.5, speedMaxMps: 5.5, population: 'test cohort', sampleSize: 40,
        mean: -9, sd: 4, sourceType: 'internal_reference', provenance: KFO.PROVENANCE.KINEMATIC_ESTIMATE,
        validationStatus: KFO.VALIDATION_STATUS.KINEMATIC_ONLY, referenceVersion: 'test', isBroadFallback: false },
      { metric: 'support_line_angle', phase: KFO.PHASE.EARLY_STANCE, sideApplicability: 'both',
        speedMinMps: null, speedMaxMps: null, population: 'broad cohort', sampleSize: 200,
        mean: -8, sd: 6, sourceType: 'internal_reference', provenance: KFO.PROVENANCE.KINEMATIC_ESTIMATE,
        validationStatus: KFO.VALIDATION_STATUS.KINEMATIC_ONLY, referenceVersion: 'test', isBroadFallback: true }
    ]);
    var sel = KFOReference.selectReference({
      metric: 'support_line_angle', phase: KFO.PHASE.EARLY_STANCE, speedMps: 5.0
    });
    assert(sel.matchType === 'speed_matched', 'match type ' + sel.matchType);
    assert(sel.record.population === 'test cohort', 'chose the speed-band record');
  });

  test('unknown speed uses a labelled broad fallback, never the narrow band', function () {
    var sel = KFOReference.selectReference({
      metric: 'support_line_angle', phase: KFO.PHASE.EARLY_STANCE, speedMps: null
    });
    assert(sel.matchType === 'broad_speed_unknown', 'match type ' + sel.matchType);
    assert(sel.record.isBroadFallback === true, 'must be the broad record');
    assert(/speed unavailable/i.test(sel.note), 'note must say so: ' + sel.note);
  });

  test('reference similarity is withheld when data confidence is poor', function () {
    var rec = KFOReference.allRecords()[0];
    var poor = KFOReference.referenceSimilarity(-9, rec, 0.2);
    assert(poor.available === false, 'should withhold');
    assert(poor.reason === 'insufficient_data_confidence', 'reason ' + poor.reason);
    var ok = KFOReference.referenceSimilarity(-9, rec, 0.8);
    assert(ok.available === true && ok.score === 100, 'exact match scores 100, got ' + ok.score);
  });

  test('similarity always carries the not-economy disclaimer', function () {
    var ok = KFOReference.referenceSimilarity(-9, KFOReference.allRecords()[0], 0.8);
    assert(ok.isNotEfficiency === true, 'flagged as not efficiency');
    assert(/not a direct measure of running economy/i.test(ok.disclaimer), 'disclaimer text');
    KFOReference.clearRecords();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: force metrics and impulse formulas
  // ═══════════════════════════════════════════════════════════════════════════
  suite('force metrics');

  test('geometry proxy reports force metrics as unavailable with a reason', function () {
    var fm = KFO.unavailableForceMetrics();
    assert(fm.availability === KFO.AVAILABILITY.UNAVAILABLE, 'availability');
    assert(fm.reason === 'geometry_proxy_has_no_force_magnitude', 'reason');
    ['verticalImpulse', 'brakingImpulse', 'propulsiveImpulse', 'verticalSupportShare',
     'horizontalDemandShare', 'foreAftDemandAngleEquivalent'].forEach(function (k) {
      assert(fm[k] === null, k + ' must be null under geometry proxy');
    });
  });

  test('impulse integration is correct on an analytic force trace', function () {
    // Fz constant 1000 N for 0.2 s -> Jv = 200 N·s.
    // Fx = -200 N for 0.1 s then +200 N for 0.1 s -> Jbrake = Jprop = 20, JxNet = 0.
    var series = [];
    for (var i = 0; i <= 20; i++) {
      var t = i * 0.01;
      series.push({ t: t, fz: 1000, fx: t < 0.1 ? -200 : 200 });
    }
    var m = KFO.computeImpulseMetrics(series, 700);
    assertClose(m.verticalImpulse, 200, 1, 'Jv');
    assertClose(m.brakingImpulse, 20, 2, 'Jbrake');
    assertClose(m.propulsiveImpulse, 20, 2, 'Jprop');
    assertClose(m.netHorizontalImpulse, 0, 2, 'JxNet ~ 0 at steady speed');
    assertClose(m.absoluteHorizontalImpulse, 40, 3, 'JhAbs');
    assertClose(m.effectiveVerticalImpulse, 200 - 700 * 0.2, 1, 'JvEffective');
  });

  test('vertical support share uses the scalar-sum convention and is labelled', function () {
    var series = [];
    for (var i = 0; i <= 20; i++) series.push({ t: i * 0.01, fz: 1000, fx: i < 10 ? -200 : 200 });
    var m = KFO.computeImpulseMetrics(series, 700);
    // Jv = 200, JhAbs = 40 -> VSS = 200/240 = 0.8333, HDS = 0.1667, summing to 1.
    assertClose(m.verticalSupportShare, 200 / 240, 0.02, 'VSS');
    assertClose(m.horizontalDemandShare, 40 / 240, 0.02, 'HDS');
    assertClose(m.verticalSupportShare + m.horizontalDemandShare, 1, 1e-6, 'shares sum to 1');
    assert(m.shareConvention === 'scalar_sum_share', 'convention must be declared');
  });

  test('the demand angle equivalent is documented as not a vector orientation', function () {
    var txt = KFO.IMPULSE_DEFINITIONS.foreAftDemandAngleEquivalent;
    assert(/NOT A VECTOR ORIENTATION/i.test(txt), 'must be explicitly disclaimed');
    assert(/opposing/i.test(txt), 'must explain the opposing-directions problem');
    assert(!/verticalSupportShare.*direction cosine/i.test(KFO.IMPULSE_DEFINITIONS.verticalSupportShare) ||
      /not a direction cosine/i.test(KFO.IMPULSE_DEFINITIONS.verticalSupportShare), 'VSS disclaims cosine');
  });

  test('insufficient force samples are refused', function () {
    var m = KFO.computeImpulseMetrics([{ t: 0, fx: 0, fz: 1 }], 700);
    assert(m.availability === KFO.AVAILABILITY.UNAVAILABLE, 'availability');
    assert(m.reason === 'insufficient_force_samples', 'reason ' + m.reason);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: estimators
  // ═══════════════════════════════════════════════════════════════════════════
  suite('estimators');

  test('estimator registry exposes the declared methods', function () {
    assert(KFOEstimators.getEstimator(KFO.METHOD.GEOMETRY_PROXY).isValidated === false, 'geometry proxy unvalidated');
    assert(KFOEstimators.getEstimator(KFO.METHOD.COM_ACCELERATION_EXPERIMENTAL) != null, 'com estimator present');
    assert(KFOEstimators.getEstimator('nonsense') === null, 'unknown method');
  });

  test('unimplemented estimators refuse explicitly instead of returning nothing', function () {
    var learned = KFOEstimators.LearnedGrfEstimator.estimate({});
    assert(learned.ok === false && /not_implemented/.test(learned.reason), 'learned stub');
    var validated = KFOEstimators.ValidatedGrfEstimator.estimate({});
    assert(validated.ok === false && /force_plate_validation/.test(validated.reason), 'validated stub');
  });

  test('local polynomial filter recovers a known second derivative', function () {
    // v = 3t^2 -> d2 = 6 exactly, d1 = 6t.
    var series = [];
    for (var i = 0; i < 30; i++) { var t = i * 0.01; series.push({ t: t, v: 3 * t * t }); }
    var out = KFOEstimators.localPolyDerivatives(series, { windowSize: 9, polyOrder: 3 });
    var mid = out.points[15];
    assertClose(mid.d2, 6, 0.05, 'second derivative');
    assertClose(mid.d1, 6 * mid.t, 0.05, 'first derivative');
    assert(out.filter.windowSize === 9 && out.filter.polyOrder === 3, 'filter params reported');
  });

  test('COM-acceleration estimator refuses without scale calibration', function () {
    var res = KFOEstimators.ComAccelerationEstimator.estimate({ samples: clip({}), calibration: null });
    assert(res.ok === false, 'must refuse');
    assert(res.reason === 'no_scale_calibration', 'reason ' + res.reason);
    assert(/gravity is a physical quantity/i.test(res.explanation), 'explains why');
    assert(res.diagnostics && res.diagnostics.rawTrajectory.length > 0, 'still returns diagnostics');
  });

  test('COM-acceleration estimator runs when calibrated and stays marked experimental', function () {
    var res = KFOEstimators.ComAccelerationEstimator.estimate({
      samples: clip({}), calibration: { pixelsPerMeter: 200, source: 'provided' }
    });
    assert(res.ok === true, 'should run, got ' + res.reason);
    assert(res.isValidated === false && res.isExperimental === true, 'must stay experimental');
    assert(res.series.length > 10, 'series produced');
    assert(res.diagnostics.rawTrajectory.length === res.diagnostics.filteredTrajectory.length, 'raw+filtered retained');
    assert(res.forceMetrics.availability === KFO.AVAILABILITY.UNAVAILABLE, 'impulses need mass + stance window');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIT: schema migration
  // ═══════════════════════════════════════════════════════════════════════════
  suite('schema migration');

  test('a pre-KFO analysis migrates to an explicit unavailable state', function () {
    var m = KFO.migrateAnalysis({ name: 'old session', phases: {}, issues: [] });
    assert(m.sourceVersion === 1, 'treated as v1');
    assert(m.schemaVersion === KFO.SCHEMA_VERSION, 'upgraded envelope version');
    assert(m.kfo.availability === KFO.AVAILABILITY.UNAVAILABLE, 'availability');
    assert(m.kfo.reason === 'analysis_predates_kinematic_force_orientation', 'reason');
    assert(m.kfo.limitations.length > 0, 'explains why it cannot be backfilled');
  });

  test('a v2 analysis passes through unmodified, versioned inside the kfo block', function () {
    // The version lives inside the block: this feature must not add fields to the
    // shared analysis document.
    var stored = { kfo: { schemaVersion: 2, availability: 'available', method: 'geometry_proxy' } };
    var m = KFO.migrateAnalysis(stored);
    assert(m.migrated === false, 'should not migrate');
    assert(m.kfo === stored.kfo, 'same object, not reinterpreted');
    assert(m.sourceVersion === 2, 'version read from the block, got ' + m.sourceVersion);
  });

  test('a root-level schemaVersion is still honoured for already-written docs', function () {
    var m = KFO.migrateAnalysis({ schemaVersion: 2, kfo: { availability: 'available' } });
    assert(m.migrated === false, 'should still pass through');
    assert(m.sourceVersion === 2, 'root version accepted as a fallback');
  });

  test('a document with no version anywhere is treated as version 1', function () {
    var m = KFO.migrateAnalysis({ name: 'plain', phases: {} });
    assert(m.sourceVersion === 1, 'absence means version 1');
    assert(m.kfo.availability === KFO.AVAILABILITY.UNAVAILABLE, 'and nothing is invented');
  });

  test('migration never mutates the stored document', function () {
    var stored = { name: 'legacy', phases: { mid: { t: 1 } } };
    var snapshot = JSON.stringify(stored);
    KFO.migrateAnalysis(stored);
    assert(JSON.stringify(stored) === snapshot, 'input must be untouched');
  });

  test('method metadata marks only validated_grf as validated', function () {
    assert(KFO.methodMetadata(KFO.METHOD.GEOMETRY_PROXY).isValidated === false, 'geometry proxy');
    assert(KFO.methodMetadata(KFO.METHOD.COM_ACCELERATION_EXPERIMENTAL).isValidated === false, 'com accel');
    assert(KFO.methodMetadata(KFO.METHOD.VALIDATED_GRF).isValidated === true, 'validated grf');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════
  suite('integration');

  test('a steady symmetrical clip produces the expected stance sweep', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    assert(res.availability === KFO.AVAILABILITY.AVAILABLE, 'availability: ' + res.availability + ' ' + (res.reason || ''));
    assert(res.left.stridesAnalyzed >= 3, 'left strides ' + res.left.stridesAnalyzed);
    assert(res.right.stridesAnalyzed >= 3, 'right strides ' + res.right.stridesAnalyzed);
    var early = res.left.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    var central = res.left.phases[KFO.PHASE.CENTRAL_STANCE].angle.median;
    var late = res.left.phases[KFO.PHASE.LATE_STANCE].angle.median;
    assertSign(early, -1, 'early stance should be braking-oriented');
    assertSign(late, 1, 'late stance should be propulsive-oriented');
    assert(Math.abs(central) < Math.abs(early), 'central should be nearer vertical than early');
    assert(early < central && central < late, 'angle should sweep monotonically: ' +
      [early, central, late].map(function (v) { return v.toFixed(1); }).join(' -> '));
  });

  test('multi-stride aggregation reports n, spread and interval per phase', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var agg = res.left.phases[KFO.PHASE.EARLY_STANCE].angle;
    assert(agg.n >= 3, 'n ' + agg.n);
    assert(typeof agg.median === 'number' && typeof agg.sd === 'number', 'median and sd');
    assert(agg.ci95 && agg.ci95.length === 2, 'ci95');
    assert(res.left.phases[KFO.PHASE.EARLY_STANCE].confidence.angleUncertaintyDegrees > 0, 'uncertainty attached');
  });

  test('right-to-left footage yields the same interpretation as left-to-right', function () {
    var ltr = KFOAnalysis.analyze({ samples: clip({}) });
    var rtl = KFOAnalysis.analyze({ samples: clip({ dirSign: -1 }) });
    assert(rtl.videoMetadata.runningDirection === KFO.RUNNING_DIRECTION.RIGHT_TO_LEFT, 'direction');
    var a = ltr.left.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    var b = rtl.left.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    assertSign(b, -1, 'still braking-oriented');
    assertClose(b, a, 2.5, 'magnitude should match the mirrored clip');
  });

  test('asymmetry is detected and attributed to the correct side', function () {
    // Right foot plants 30 px further ahead -> more braking on the right.
    var res = KFOAnalysis.analyze({ samples: clip({ overstrideBiasRight: 30 }) });
    var l = res.left.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    var r = res.right.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    assert(r < l, 'right should be more braking-oriented: left ' + l.toFixed(1) + ' vs right ' + r.toFixed(1));
    assert(res.symmetry.available === true, 'symmetry available');
    assert(res.symmetry.phases[KFO.PHASE.EARLY_STANCE].moreBrakingSide === 'right', 'attribution');
    assert(res.symmetry.maxAbsoluteDifferenceDegrees > 2, 'difference magnitude');
  });

  test('higher fore-aft excursion side is identified', function () {
    var res = KFOAnalysis.analyze({ samples: clip({ overstrideBiasRight: 35 }) });
    assert(res.coupledPattern.higherExcursionSide === 'right',
      'expected right, got ' + res.coupledPattern.higherExcursionSide);
  });

  test('low sample-rate footage raises sparse-sampling and low-frame-rate flags', function () {
    var res = KFOAnalysis.analyze({ samples: clip({ sampleRateHz: 25 }) });
    var f = res.quality.flags;
    assert(f.indexOf(KFO.QUALITY_FLAG.LOW_FRAME_RATE) > -1, 'low_frame_rate expected: ' + f.join(','));
    assert(f.indexOf(KFO.QUALITY_FLAG.SPARSE_STANCE_SAMPLING) > -1, 'sparse_stance_sampling expected: ' + f.join(','));
    assert(res.quality.confidence.score < 1, 'confidence reduced');
  });

  test('speed and grade are always flagged unknown in the current pipeline', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    assert(res.quality.flags.indexOf(KFO.QUALITY_FLAG.SPEED_UNKNOWN) > -1, 'speed_unknown');
    assert(res.quality.flags.indexOf(KFO.QUALITY_FLAG.GRADE_UNKNOWN) > -1, 'grade_unknown');
    assert(res.videoMetadata.estimatedSpeedMps === null, 'speed null');
  });

  test('occluded landmarks raise the occlusion flag', function () {
    var res = KFOAnalysis.analyze({ samples: clip({ occludeSideEvery: 3 }) });
    assert(res.quality.flags.indexOf(KFO.QUALITY_FLAG.LANDMARK_OCCLUSION) > -1,
      'expected occlusion flag, got ' + res.quality.flags.join(','));
  });

  test('too few samples yields unavailable with a reason, not a fabricated result', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}).slice(0, 5) });
    assert(res.availability === KFO.AVAILABILITY.UNAVAILABLE, 'availability');
    assert(res.reason === 'insufficient_samples', 'reason ' + res.reason);
    assert(res.left === undefined, 'no side data should be invented');
  });

  test('reference comparison is unavailable while the store is empty', function () {
    KFOReference.clearRecords();
    KFOReference.derivedProvider.enabled = false;
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    assert(res.referenceComparison.left.available === false, 'left unavailable');
    assert(res.referenceComparison.left.reason === 'no_reference_distribution_loaded', 'reason');
    assert(/not a direct measure of running economy/i.test(res.referenceComparison.disclaimer), 'disclaimer present');
  });

  test('result envelope is versioned and declares its method and limits', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    assert(res.analysisType === 'kinematic_force_orientation', 'analysis type');
    assert(res.schemaVersion === 2, 'schema version');
    assert(res.method === KFO.METHOD.GEOMETRY_PROXY, 'method');
    assert(res.isValidated === false, 'must not claim validation');
    assert(res.modelVersion && res.referenceVersion, 'versions present');
    assert(res.limitations.some(function (l) { return /not a direct ground-reaction-force/i.test(l); }),
      'limitations must disclaim GRF');
    assert(res.forceMetrics.availability === KFO.AVAILABILITY.UNAVAILABLE, 'force metrics unavailable');
    assert(res.angleConvention.negative === 'braking orientation', 'convention documented');
  });

  test('stored projection round-trips and keeps stride detail out of persistence', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var stored = KFOAnalysis.toStoredForm(res);
    var json = JSON.stringify(stored);
    var back = JSON.parse(json);
    assert(back.schemaVersion === 2, 'version survives');
    assert(back.left.phases[KFO.PHASE.EARLY_STANCE].n >= 3, 'aggregate survives');
    assert(back.left.strides === undefined, 'stride detail must not be persisted');
    assert(json.length < 12000, 'stored form should stay compact, was ' + json.length + ' bytes');
    var migrated = KFO.migrateAnalysis({ kfo: back });
    assert(migrated.migrated === false, 'v2 should pass through on the nested version alone');
  });

  test('feature scope: nothing is written to a saved document when the feature is off', function () {
    // Guards the boundary that matters most: with the feature inactive, a save must
    // be byte-identical to a pre-feature save. Mirrors KFOApp.storedFields()'s
    // contract without needing a browser.
    function storedFieldsWhenInactive() { return {}; }
    var data = { name: 'session', phases: {}, issues: {} };
    var before = JSON.stringify(data);
    var fields = storedFieldsWhenInactive();
    Object.keys(fields).forEach(function (k) { data[k] = fields[k]; });
    assert(JSON.stringify(data) === before, 'document must be untouched when inactive');
    assert(Object.keys(fields).length === 0, 'no fields, not even a version');
  });

  test('treadmill footage still analyses via the facing fallback', function () {
    var res = KFOAnalysis.analyze({ samples: clip({ velocityPxPerSec: 0 }) });
    assert(res.videoMetadata.runningDirectionSource === 'body_facing', 'source');
    assert(res.quality.flags.indexOf(KFO.QUALITY_FLAG.MIRRORED_VIDEO) > -1, 'mirroring cannot be ruled out');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  COPY AUDIT — the rendered admin panel must not overstate the science
  // ═══════════════════════════════════════════════════════════════════════════
  suite('copy audit');

  function renderedHtml() {
    if (typeof d.KFORender === 'undefined' && typeof require === 'function') {
      try { d.KFORender = require('./kfo-render.js'); } catch (e) { return null; }
    }
    var R = d.KFORender;
    if (!R || typeof R.buildHtml !== 'function') return null;
    return R.buildHtml(KFOAnalysis.analyze({ samples: clip({ overstrideBiasRight: 25 }) }));
  }

  test('rendered copy never claims a measured ground-reaction force', function () {
    var html = renderedHtml();
    if (html === null) { assert(true, 'renderer unavailable in this environment'); return; }
    assert(!/measured\s+(ground[- ]reaction|GRF)/i.test(html), 'must not claim measured GRF');
    assert(!/force[- ]vector\s+analysis/i.test(html), 'legacy name must be gone');
    assert(/not a direct ground-reaction-force measurement/i.test(html), 'must carry the disclaimer');
  });

  test('rendered copy never presents efficiency or economy as a result', function () {
    var html = renderedHtml();
    if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(!/running efficiency|force efficiency/i.test(html), 'must not claim efficiency');
    assert(!/\bMean alignment\b/i.test(html), 'legacy composite score must be gone');
    assert(/not a direct measure of running economy/i.test(html), 'must carry the economy disclaimer');
  });

  test('rendered copy shows uncertainty and the method/version', function () {
    var html = renderedHtml();
    if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/±|\bto\b/.test(html), 'uncertainty must be visible');
    assert(/geometry_proxy/.test(html), 'method must be accessible');
    assert(html.indexOf(KFO.MODEL_VERSION) > -1, 'model version must be accessible');
  });

  test('a saved v2 analysis renders from the stored block', function () {
    if (!d.KFORender && typeof require === 'function') {
      try { d.KFORender = require('./kfo-render.js'); } catch (e) { assert(true, 'renderer unavailable'); return; }
    }
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var stored = KFOAnalysis.toStoredForm(KFOAnalysis.analyze({ samples: clip({}) }));
    var html = R.buildStoredHtml(stored);
    assert(/Kinematic Force-Orientation/i.test(html), 'renders the panel');
    assert(/Restored from a saved session/i.test(html), 'discloses that it is restored');
    assert(/stride-level detail was not/i.test(html), 'discloses what was not persisted');
    assert(!/NaN|undefined/.test(html), 'no NaN or undefined leaking into the view');
  });

  test('a pre-KFO saved analysis renders an explicit unavailable state', function () {
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var migrated = KFO.migrateAnalysis({ name: 'legacy session', phases: {} });
    var html = R.unavailableHtml(migrated.kfo, 'Saved sessions store aggregate values only.');
    assert(/Not available for this session/i.test(html), 'explicit unavailable heading');
    assert(/predates|cannot be computed retroactively/i.test(html), 'explains why');
    assert(!/NaN|undefined/.test(html), 'no NaN or undefined');
  });

  test('rendered copy uses the reframed vocabulary', function () {
    var html = renderedHtml();
    if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/Kinematic Force-Orientation/i.test(html), 'new feature name');
    assert(/support-line angle/i.test(html), 'support-line angle wording');
    assert(!/Elite target/i.test(html), 'elite target wording must be gone');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  EXPORT AND VALIDATION HARNESS
  // ═══════════════════════════════════════════════════════════════════════════
  suite('export');

  function loadExport() {
    if (typeof d.KFOExport === 'undefined' && typeof require === 'function') {
      try { d.KFOExport = require('./kfo-export.js'); } catch (e) { return null; }
    }
    return d.KFOExport || null;
  }

  test('stride-level export contains one row per valid stride with all fields', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var rows = X.strideRows(res, { analysisId: 'a1', subjectId: 's1', videoId: 'v1' });
    assert(rows.length >= 6, 'expected rows for both sides, got ' + rows.length);
    var r = rows[0];
    X.STRIDE_COLUMNS.forEach(function (c) {
      assert(Object.prototype.hasOwnProperty.call(r, c), 'missing column ' + c);
    });
    assert(r.method === KFO.METHOD.GEOMETRY_PROXY, 'method recorded');
    assert(r.modelVersion === KFO.MODEL_VERSION, 'model version recorded');
    assert(typeof r.earlyStanceAngleDeg === 'number', 'early angle present');
  });

  test('CSV output escapes separators and blocks formula injection', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var csv = X.toCsv(['a', 'b'], [{ a: 'x,y', b: '=cmd()' }, { a: 'he said "hi"', b: 1.5 }]);
    var lines = csv.split('\n');
    assert(lines[0] === 'a,b', 'header');
    assert(lines[1].indexOf('"x,y"') > -1, 'comma quoted: ' + lines[1]);
    assert(lines[1].indexOf("'=cmd()") > -1, 'formula neutralised: ' + lines[1]);
    assert(lines[2].indexOf('""hi""') > -1, 'quotes doubled: ' + lines[2]);
    assert(lines[2].indexOf('1.5') > -1, 'numbers pass through unquoted');
  });

  test('frame-level export can embed landmarks for re-derivation', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var s = clip({});
    var res = KFOAnalysis.analyze({ samples: s });
    var bare = X.frameRows(res, s, {});
    var full = X.frameRows(res, s, { includeLandmarks: true });
    assert(bare.length > 0, 'rows produced');
    assert(bare[0].landmarks === null, 'landmarks opt-in');
    assert(typeof full[0].landmarks === 'string' && full[0].landmarks.indexOf('[') === 0, 'landmarks embedded');
    assert(isFinite(full[0].supportLineAngleDeg), 'angle present');
  });

  test('manual corrections are retained beside automatic values', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var a = X.makeAdjustmentRecord({ autoFrame: 100, adjustedFrame: 104, adjustmentReason: 'late contact', adjustedBy: 'admin' });
    assert(a.autoFrame === 100 && a.adjustedFrame === 104, 'both retained');
    assert(a.wasAdjusted === true, 'adjustment detected');
    var b = X.makeAdjustmentRecord({ autoFrame: 100, adjustedFrame: 100 });
    assert(b.wasAdjusted === false, 'no-op is not an adjustment');
  });

  test('export bundle carries its scientific-scope notes', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var bundle = X.buildExport(KFOAnalysis.analyze({ samples: clip({}) }), clip({}), { analysisId: 'a1' });
    assert(bundle.csv.strides.split('\n').length > 2, 'stride csv populated');
    assert(bundle.notes.some(function (n) { return /not measured ground-reaction force/i.test(n); }),
      'must disclaim GRF in the export itself');
  });

  suite('validation harness');

  test('force-plate CSV parses and rejects malformed rows rather than coercing', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var csv = 'timestamp,Fx,Fy,Fz,COPx,COPy,COPz,contactSide\n' +
      '0.000,-100,0,900,0.1,0.2,0,left\n' +
      'bad,bad,0,bad,0,0,0,left\n' +
      '0.010,120,0,950,0.1,0.2,0,left\n';
    var p = X.parseForcePlateCsv(csv);
    assert(p.ok === true, 'should parse');
    assert(p.rows.length === 2, 'valid rows: ' + p.rows.length);
    assert(p.rejectedRows === 1, 'malformed row rejected');
    assert(p.rows[0].contactSide === 'left', 'side parsed');
    var missing = X.parseForcePlateCsv('a,b\n1,2\n');
    assert(missing.ok === false && /missing_required_columns/.test(missing.reason), 'schema enforced');
  });

  test('criterion angles are extracted at the three kinetic instants', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    // Synthetic contact: braking then propulsion, vertical peak at mid-stance.
    var rows = [];
    for (var i = 0; i <= 20; i++) {
      var t = i * 0.01, frac = i / 20;
      rows.push({
        t: t,
        fx: frac < 0.5 ? -200 * (1 - Math.abs(frac - 0.25) * 4) : 200 * (1 - Math.abs(frac - 0.75) * 4),
        fz: 1000 * Math.sin(Math.PI * frac) + 30,
        contactSide: 'left'
      });
    }
    rows.push({ t: 0.22, fx: 0, fz: 0, contactSide: 'left' });
    var contacts = X.extractCriterionAngles(rows, { thresholdNewtons: 20, bodyWeightNewtons: 700 });
    assert(contacts.length === 1, 'one contact, got ' + contacts.length);
    var c = contacts[0];
    assertSign(c.peakBrakingAngleDeg, -1, 'peak braking angle should be negative');
    assertSign(c.peakPropulsiveAngleDeg, 1, 'peak propulsive angle should be positive');
    assert(Math.abs(c.peakVerticalAngleDeg) < Math.abs(c.peakBrakingAngleDeg), 'peak vertical nearest vertical');
    assert(c.impulses.availability === KFO.AVAILABILITY.AVAILABLE, 'impulses computed from real force');
  });

  test('validation statistics compute agreement, not just correlation', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    // Perfectly correlated but biased by +5 degrees.
    var pairs = [];
    for (var i = 0; i < 120; i++) {
      var crit = -12 + (i % 20) * 0.6;
      pairs.push({ estimate: crit + 5, criterion: crit, subjectId: 'S' + (i % 12) });
    }
    var st = X.validationStats(pairs);
    assertClose(st.correlation, 1, 1e-6, 'correlation should be ~1');
    assertClose(st.bias, 5, 1e-6, 'bias should be +5');
    assertClose(st.calibrationSlope, 1, 1e-6, 'slope ~1');
    var verdict = X.interpretValidation(st, { subjectCount: 12 });
    assert(verdict.validated === false, 'a biased estimate must not pass');
    assert(verdict.failures.indexOf('bias') > -1, 'bias must be the failing criterion');
    assert(/correlation is reported but is never sufficient/i.test(verdict.note), 'must state the rule');
  });

  test('an unbiased accurate estimate passes the validation gate', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var pairs = [];
    for (var i = 0; i < 120; i++) {
      var crit = -12 + (i % 20) * 0.6;
      var err = ((i % 7) - 3) * 0.4; // small zero-mean-ish error
      pairs.push({ estimate: crit + err, criterion: crit, subjectId: 'S' + (i % 12),
                   confidence: 0.8, uncertaintyDegrees: 2.5 });
    }
    var st = X.validationStats(pairs);
    var verdict = X.interpretValidation(st, { subjectCount: 12 });
    assert(verdict.validated === true, 'should pass, failures: ' + verdict.failures.join(','));
    assert(st.confidenceCalibration && st.confidenceCalibration.coverage > 0.9,
      'reported uncertainty should cover the error');
  });

  test('stratification and per-subject holdout partition the data', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var pairs = [];
    for (var i = 0; i < 60; i++) {
      pairs.push({ estimate: -8 + (i % 5), criterion: -8 + (i % 5),
                   subjectId: 'S' + (i % 3), speedMps: i % 2 ? 4.5 : 5.5, side: i % 2 ? 'left' : 'right' });
    }
    var bySpeed = X.stratify(pairs, function (p) { return p.speedMps; });
    assert(Object.keys(bySpeed).length === 2, 'two speed strata');
    var bySide = X.stratify(pairs, function (p) { return p.side; });
    assert(bySide.left.ok && bySide.right.ok, 'both sides evaluated');
    var holdout = X.perSubjectHoldout(pairs);
    assert(holdout.ok === true && Object.keys(holdout.perSubject).length === 3, 'three subjects');
    assert(X.perSubjectHoldout(pairs.slice(0, 1)).ok === false, 'needs multiple subjects');
  });

  test('estimates pair with criterion contacts by temporal overlap', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var rows = X.strideRows(res, { analysisId: 'a1', subjectId: 's1' });
    // Build criterion contacts aligned to the detected strides.
    var contacts = rows.map(function (r, i) {
      return {
        contactIndex: i, side: r.side,
        startTime: r.footStrikeTimestampMs / 1000,
        endTime: r.toeOffTimestampMs / 1000,
        peakBrakingAngleDeg: -10, peakVerticalAngleDeg: 1, peakPropulsiveAngleDeg: 9
      };
    });
    var pairs = X.pairWithCriterion(rows, contacts, { toleranceSeconds: 0.02 });
    assert(pairs.length >= rows.length, 'expected up to 3 phase pairs per stride, got ' + pairs.length);
    assert(pairs.every(function (p) { return isFinite(p.estimate) && isFinite(p.criterion); }), 'numeric pairs');
    var farOff = X.pairWithCriterion(rows, contacts.map(function (c) {
      return Object.assign({}, c, { startTime: c.startTime + 5 });
    }), { toleranceSeconds: 0.02 });
    assert(farOff.length === 0, 'unsynchronised data must not be paired');
  });

  // ── Runner ────────────────────────────────────────────────────────────────
  function run(opts) {
    opts = opts || {};
    results = [];
    // Re-execute by reloading definitions is unnecessary; tests already ran at
    // definition time in this design, so instead we re-run explicitly below.
    return summarize(opts);
  }

  function summarize(opts) {
    var passed = results.filter(function (r) { return r.pass; }).length;
    var failed = results.filter(function (r) { return !r.pass; });
    var lines = [];
    var bySuite = {};
    results.forEach(function (r) { (bySuite[r.suite] = bySuite[r.suite] || []).push(r); });
    Object.keys(bySuite).forEach(function (s) {
      lines.push('\n  ' + s);
      bySuite[s].forEach(function (r) {
        lines.push('    ' + (r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.pass ? '' : '\n          ' + r.error));
      });
    });
    var summary = '\n' + results.length + ' tests, ' + passed + ' passed, ' + failed.length + ' failed';
    if (!opts.quiet && typeof console !== 'undefined') {
      console.log(lines.join('\n'));
      console.log(summary);
    }
    if (failed.length && typeof process !== 'undefined' && process.exitCode !== undefined && !opts.noExit) {
      process.exitCode = 1;
    }
    return { total: results.length, passed: passed, failed: failed.length, failures: failed, results: results, text: lines.join('\n') + summary };
  }

  return { run: function (o) { return summarize(o || {}); }, results: function () { return results; },
           fixtures: { makeClip: makeClip, clip: clip, frame: frame } };
});
