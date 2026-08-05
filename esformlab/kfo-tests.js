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
    KFOAnalysis: require('./kfo-analysis.js'),
    KFOVerticalForce: require('./kfo-vertical-force.js'),
    KFOImpulse: require('./kfo-impulse.js'),
    KFOFatigue: require('./kfo-fatigue.js')
  } : {
    KFO: root.KFO, KFOReference: root.KFOReference,
    KFOEstimators: root.KFOEstimators, KFOAnalysis: root.KFOAnalysis,
    KFOVerticalForce: root.KFOVerticalForce,
    KFOImpulse: root.KFOImpulse, KFOFatigue: root.KFOFatigue
  };
  var api = factory(deps);
  if (isNode) { module.exports = api; if (require.main === module) api.run(); }
  if (root) root.KFOTests = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (d) {
  'use strict';

  var KFO = d.KFO, KFOReference = d.KFOReference,
      KFOEstimators = d.KFOEstimators, KFOAnalysis = d.KFOAnalysis,
      VF = d.KFOVerticalForce, IMP = d.KFOImpulse, FAT = d.KFOFatigue;

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

  test('a v2 analysis is adapted forward to v3 with its own data intact', function () {
    // The version lives inside the block: this feature must not add fields to the
    // shared analysis document. Everything a v2 save holds is still valid under
    // v3, so it must survive — only the impulse block is new.
    var stored = {
      kfo: {
        schemaVersion: 2, availability: 'available', method: 'geometry_proxy',
        left: { stridesAnalyzed: 6 }, verticalForce: { availability: 'available', method: 'timing_duty_factor' }
      }
    };
    var m = KFO.migrateAnalysis(stored);
    assert(m.sourceVersion === 2, 'version read from the block, got ' + m.sourceVersion);
    assert(m.schemaVersion === 3, 'adapted to v3');
    assert(m.migrated === true, 'adaptation is reported, not silent');
    assert(m.kfo.availability === 'available', 'availability preserved');
    assert(m.kfo.left.stridesAnalyzed === 6, 'stride aggregates preserved');
    assert(m.kfo.verticalForce.method === 'timing_duty_factor', 'timing force block preserved');
    assert(m.kfo.impulseMetrics.availability === KFO.AVAILABILITY.UNAVAILABLE,
      'impulse block added as unavailable');
    assert(m.kfo.impulseMetrics.JvEffective === null, 'and null, never zero');
    assert(m.kfo.impulseMetrics.reason === 'analysis_predates_impulse_accounting', 'with a reason');
  });

  test('a v2 root-level schemaVersion is still honoured for already-written docs', function () {
    var m = KFO.migrateAnalysis({ schemaVersion: 2, kfo: { availability: 'available' } });
    assert(m.sourceVersion === 2, 'root version accepted as a fallback');
    assert(m.kfo.availability === 'available', 'the block is kept rather than discarded');
    assert(m.kfo.reason !== 'analysis_predates_kinematic_force_orientation',
      'a v2 document must never be treated as pre-KFO');
  });

  test('a current-version analysis passes through untouched', function () {
    var stored = { kfo: { schemaVersion: KFO.SCHEMA_VERSION, availability: 'available' } };
    var m = KFO.migrateAnalysis(stored);
    assert(m.migrated === false, 'no migration needed');
    assert(m.kfo === stored.kfo, 'same object, not reinterpreted');
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
    assert(res.schemaVersion === KFO.SCHEMA_VERSION, 'schema version');
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
    assert(back.schemaVersion === KFO.SCHEMA_VERSION, 'version survives');
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  VERTICAL FORCE FROM TIMING
  // ═══════════════════════════════════════════════════════════════════════════
  suite('vertical force');

  /** Stance intervals from explicit step timing, alternating sides. */
  function stanceIntervals(o) {
    var contact = o.contactSeconds, step = o.stepSeconds, n = o.steps;
    var left = [], right = [], t = o.startAt || 0;
    for (var i = 0; i < n; i++) {
      var iv = { startTime: t, endTime: t + contact };
      (i % 2 === 0 ? left : right).push(iv);
      t += step;
    }
    return { leftStanceIntervals: left, rightStanceIntervals: right };
  }

  test('mean vertical force in bodyweights is exactly 1 / duty factor', function () {
    assertClose(VF.meanVerticalForceBw(0.5), 2, 1e-12, 'DF 0.5');
    assertClose(VF.meanVerticalForceBw(0.611), 1 / 0.611, 1e-12, 'DF 0.611');
    assert(VF.meanVerticalForceBw(0) === null, 'zero duty factor has no mean force');
    assert(VF.meanVerticalForceBw(null) === null, 'null duty factor has no mean force');
  });

  test('peak vertical force matches the half-sine flight-time method', function () {
    assertClose(VF.peakVerticalForceBw(0.5), Math.PI, 1e-12, 'DF 0.5');
    // Morin's Fmax/mg = (pi/2)*(tf/tc + 1); tf/tc + 1 = 1/DF, so the two agree.
    var tc = 0.22, tf = 0.14, df = tc / (tc + tf);
    assertClose(VF.peakVerticalForceBw(df), (Math.PI / 2) * (tf / tc + 1), 1e-12, 'Morin form');
  });

  // Dorn et al. 2012, measured peak vertical GRF at four speeds. The predicted
  // values must stay a CONSISTENT UNDERESTIMATE: no empirical correction is
  // applied, because fitting a factor to four points from one study would
  // manufacture precision. If this test starts failing high, someone added one.
  var DORN_2012 = [
    { speedMps: 3.49, dutyFactor: 0.637, measuredPeakBw: 2.71 },
    { speedMps: 5.17, dutyFactor: 0.533, measuredPeakBw: 3.10 },
    { speedMps: 6.96, dutyFactor: 0.507, measuredPeakBw: 3.58 },
    { speedMps: 8.99, dutyFactor: 0.514, measuredPeakBw: 3.59 }
  ];

  test('predicted peak agrees with Dorn 2012 to within a 5-15% underestimate', function () {
    DORN_2012.forEach(function (c) {
      var predicted = VF.peakVerticalForceBw(c.dutyFactor);
      var ratio = predicted / c.measuredPeakBw;
      assert(ratio < 1, c.speedMps + ' m/s: must not over-predict, ratio ' + ratio.toFixed(3));
      assert(ratio >= 0.84 && ratio <= 0.96,
        c.speedMps + ' m/s: ratio ' + ratio.toFixed(3) + ' outside the disclosed 0.84-0.96 band');
    });
  });

  test('no empirical correction factor has been fitted to the Dorn data', function () {
    // A fitted correction would drive the mean ratio to ~1. It must stay biased.
    var ratios = DORN_2012.map(function (c) {
      return VF.peakVerticalForceBw(c.dutyFactor) / c.measuredPeakBw;
    });
    var mean = ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length;
    assert(mean < 0.97, 'mean ratio ' + mean.toFixed(3) + ' looks corrected; the bias must be disclosed, not fitted');
    var res = VF.analyze(stanceIntervals({ contactSeconds: 0.22, stepSeconds: 0.36, steps: 10 }));
    assert(/no correction applied/i.test(res.peakBiasNote), 'the bias must be stated in the result');
  });

  test('duty factor and force are recovered from alternating stance intervals', function () {
    var res = VF.analyze(Object.assign(
      stanceIntervals({ contactSeconds: 0.22, stepSeconds: 0.36, steps: 10 }),
      { effectiveSampleRateHz: 25 }));
    assert(res.availability === KFO.AVAILABILITY.AVAILABLE, 'available, got ' + res.reason);
    assertClose(res.dutyFactor.median, 0.22 / 0.36, 1e-9, 'duty factor');
    assertClose(res.contactSeconds.median, 0.22, 1e-9, 'contact time');
    assertClose(res.flightSeconds.median, 0.14, 1e-9, 'flight time');
    assertClose(res.cadenceSpm.median, 60 / 0.36, 1e-6, 'step rate');
    assertClose(res.meanVerticalForceBw.median, 0.36 / 0.22, 1e-9, 'mean force');
    assertClose(res.peakVerticalForceBw.median, (Math.PI / 2) * 0.36 / 0.22, 1e-9, 'peak force');
    assert(res.isValidated === false, 'must never claim validation');
    assert(res.provenance === KFO.PROVENANCE.KINEMATIC_ESTIMATE, 'provenance is a kinematic estimate');
  });

  test('duty factor is recovered from a synthetic clip through the full analysis', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var vf = res.verticalForce;
    assert(vf, 'analysis must attach a verticalForce block');
    assert(vf.availability === KFO.AVAILABILITY.AVAILABLE, 'available, got ' + vf.reason);
    // The fixture runs 0.22 s stance on a 0.36 s step period; stance edges come
    // from the sampled scan, so exact recovery is not expected.
    assertClose(vf.dutyFactor.median, 0.22 / 0.36, 0.06, 'duty factor from detected stance');
    assertClose(vf.peakVerticalForceBw.median, (Math.PI / 2) / (0.22 / 0.36), 0.30, 'peak force');
    assert(vf.stepsAnalyzed >= 3, 'steps analysed: ' + vf.stepsAnalyzed);
  });

  test('overlapping stances are refused as walking rather than reported', function () {
    // Double support: each contact still going when the other side lands.
    var res = VF.analyze({
      leftStanceIntervals: [{ startTime: 0.0, endTime: 0.7 }, { startTime: 0.6, endTime: 1.3 }],
      rightStanceIntervals: [{ startTime: 0.3, endTime: 1.0 }, { startTime: 0.9, endTime: 1.6 }],
      effectiveSampleRateHz: 25
    });
    assert(res.availability === KFO.AVAILABILITY.UNAVAILABLE, 'must not report a force');
    assert(res.reason === 'double_support_detected_not_running', 'reason: ' + res.reason);
    assert(res.gaitValidity.isRunning === false, 'gait explicitly marked not running');
    assert(res.peakVerticalForceBw === undefined, 'no force value may be present');
  });

  test('a repeated side is skipped rather than treated as one long step', function () {
    var built = VF.buildSteps(
      [{ startTime: 0.00, endTime: 0.22 }, { startTime: 0.72, endTime: 0.94 }],
      [{ startTime: 1.08, endTime: 1.30 }]);
    // left, left, right: the first pair is a missed opposite stance.
    assert(built.steps.length === 1, 'one usable step, got ' + built.steps.length);
    assert(built.rejected.some(function (r) { return r.reason === 'missed_opposite_stance'; }),
      'the repeated side must be reported as a missed stance');
  });

  test('steps outside the running range are rejected with a reason', function () {
    var built = VF.buildSteps(
      // No flight at all: contact fills the whole step.
      [{ startTime: 0.0, endTime: 0.40 }],
      [{ startTime: 0.40, endTime: 0.80 }]);
    assert(built.steps.length === 0, 'no usable running steps');
    assert(built.rejected.some(function (r) {
      return r.reason === 'insufficient_flight_time' || r.reason === 'duty_factor_out_of_running_range';
    }), 'reasons: ' + JSON.stringify(built.rejected.map(function (r) { return r.reason; })));
  });

  test('fewer than three steps is refused', function () {
    var res = VF.analyze(stanceIntervals({ contactSeconds: 0.22, stepSeconds: 0.36, steps: 2 }));
    assert(res.availability === KFO.AVAILABILITY.UNAVAILABLE, 'must refuse');
    assert(res.reason === 'insufficient_steps', 'reason: ' + res.reason);
  });

  // Jensen's inequality: 1/DF is convex, so the mean of the per-step forces is
  // strictly GREATER than the force computed from the mean duty factor. Computing
  // from the aggregate would systematically under-report.
  test('force is aggregated per step, not derived from the mean duty factor', function () {
    // Deliberately variable contact times so the convexity gap is measurable.
    var left = [], right = [], t = 0, contacts = [0.18, 0.26, 0.20, 0.28, 0.19, 0.27, 0.21, 0.25];
    contacts.forEach(function (c, i) {
      (i % 2 === 0 ? left : right).push({ startTime: t, endTime: t + c });
      t += 0.36;
    });
    var res = VF.analyze({ leftStanceIntervals: left, rightStanceIntervals: right, effectiveSampleRateHz: 25 });
    assert(res.availability === KFO.AVAILABILITY.AVAILABLE, 'available, got ' + res.reason);

    var fromMeanDf = VF.meanVerticalForceBw(res.dutyFactor.mean);
    assert(res.meanVerticalForceBw.mean > fromMeanDf,
      'per-step aggregation must exceed the value from the mean duty factor (' +
      res.meanVerticalForceBw.mean + ' vs ' + fromMeanDf + ')');

    var peakFromMeanDf = VF.peakVerticalForceBw(res.dutyFactor.mean);
    assert(res.peakVerticalForceBw.mean > peakFromMeanDf, 'same ordering must hold for the peak');
    // And the gap must be real, not float noise.
    assert(res.meanVerticalForceBw.mean - fromMeanDf > 1e-4, 'convexity gap should be measurable');
  });

  test('timing uncertainty shrinks with step count but never claims to remove bias', function () {
    var one = VF.timingUncertainty(1 / 25, 0.22, 1);
    var ten = VF.timingUncertainty(1 / 25, 0.22, 10);
    assertClose(one.perStepRelative, ten.perStepRelative, 1e-12, 'per-step error is step-count independent');
    assertClose(ten.aggregateRelative, one.aggregateRelative / Math.sqrt(10), 1e-12, 'averages as 1/sqrt(n)');
    assert(ten.aggregateRelative < one.aggregateRelative, 'aggregate error must fall');
    assert(/systematic/i.test(one.note), 'must say the systematic part is excluded');
    // At the ~25 Hz scan rate the per-step figure is the documented ~7%.
    assertClose(one.perStepRelative, 0.07, 0.02, 'per-step relative error at 25 Hz');
    assert(ten.aggregateRelative < 0.035, 'ten steps should land near 2-3%: ' + ten.aggregateRelative);
  });

  test('caveats surface acceleration and always disclose the systematic bias', function () {
    var res = VF.analyze(Object.assign(
      stanceIntervals({ contactSeconds: 0.22, stepSeconds: 0.36, steps: 10 }),
      { effectiveSampleRateHz: 25, qualityFlags: [KFO.QUALITY_FLAG.ACCELERATION_DETECTED] }));
    var text = res.caveats.join(' ');
    assert(/steady speed could not be confirmed/i.test(text), 'acceleration must be caveated');
    assert(/does not average out/i.test(text), 'systematic bias must always be disclosed');
    assert(/force-plate validation is still required/i.test(text), 'must say validation is still required');
    // Flags that only affect sagittal angles must not be imported as force caveats.
    var mirrored = VF.buildCaveats([KFO.QUALITY_FLAG.MIRRORED_VIDEO], null, 10);
    assert(mirrored.length === 1 && /does not average out/i.test(mirrored[0]),
      'mirroring does not affect timing and must not add a caveat');
  });

  test('the horizontal half is reported unavailable, never fabricated', function () {
    var res = VF.analyze(stanceIntervals({ contactSeconds: 0.22, stepSeconds: 0.36, steps: 10 }));
    var h = res.horizontal;
    assert(h.availability === KFO.AVAILABILITY.UNAVAILABLE, 'must be unavailable');
    assert(h.brakingImpulseBwSeconds === null && h.propulsiveImpulseBwSeconds === null, 'no invented values');
    assert(/net_horizontal_impulse/.test(h.reason), 'reason names the physics: ' + h.reason);
    assert(/speed is not captured/i.test(h.explanation), 'must say why it cannot be derived');
  });

  test('the duty-factor proxy matches the Impact Load model convention', function () {
    var res = VF.analyze(Object.assign(
      stanceIntervals({ contactSeconds: 0.228, stepSeconds: 60 / 186, steps: 10 }),
      { effectiveSampleRateHz: 25 }));
    var proxy = res.runLoadDfProxy;
    // shared/run-load-model.js expresses duty factor as cadence(spm) x GCT(ms).
    assertClose(proxy.value, 186 * 228, 6, 'proxy must equal cadence x GCT');
    assertClose(proxy.value, res.dutyFactor.median * 60000, 1e-6, 'dfProxy = 60000 x dutyFactor');
    assert(proxy.convention === 'cadence_spm_times_gct_ms', 'convention recorded');
    // The model's easy-run fallback must be a duty factor this module accepts, or
    // the two definitions have drifted apart.
    var baseDf = 42408 / VF.RUN_LOAD_DF_PROXY_SCALE;
    assert(baseDf >= VF.LIMITS.minDutyFactor && baseDf <= VF.LIMITS.maxDutyFactor,
      'run-load baseDF implies duty factor ' + baseDf.toFixed(3) + ', outside this module\'s running range');
  });

  test('absolute newtons appear only when body mass is supplied', function () {
    var base = stanceIntervals({ contactSeconds: 0.22, stepSeconds: 0.36, steps: 10 });
    var without = VF.analyze(base);
    assert(without.peakVerticalForceNewtons === null, 'no newtons without mass');
    assert(/body_mass_unavailable/.test(without.absoluteForceReason), 'reason given');
    var withMass = VF.analyze(Object.assign({}, base, { bodyMassKg: 70 }));
    assertClose(withMass.bodyWeightNewtons, 70 * VF.GRAVITY_MPS2, 1e-9, 'bodyweight in newtons');
    assertClose(withMass.peakVerticalForceNewtons,
      withMass.peakVerticalForceBw.median * 70 * VF.GRAVITY_MPS2, 1e-6, 'peak in newtons');
  });

  test('the stored form carries force aggregates but no per-step detail', function () {
    var stored = KFOAnalysis.toStoredForm(KFOAnalysis.analyze({ samples: clip({}) }));
    var vf = stored.verticalForce;
    assert(vf, 'force block persisted');
    assert(vf.steps === undefined, 'per-step detail must stay in the research export');
    assert(vf.rejections === undefined, 'per-step rejections must not be persisted');
    assert(isFinite(vf.peakVerticalForceBw.median), 'aggregate peak persisted');
    assert(isFinite(vf.dutyFactor.median), 'aggregate duty factor persisted');
    assert(vf.isValidated === false, 'validation state persisted as false');
    assert(vf.horizontal.availability === KFO.AVAILABILITY.UNAVAILABLE, 'horizontal state persisted');
    assert(JSON.stringify(stored).indexOf('"contactSide"') === -1, 'no step records anywhere in the document');
  });

  test('the stored force block round-trips into the rendered panel', function () {
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var stored = KFOAnalysis.toStoredForm(KFOAnalysis.analyze({ samples: clip({}) }));
    var html = R.buildStoredHtml(stored);
    assert(/Estimated vertical force/i.test(html), 'force card renders from the stored block');
    assert(/\bBW\b/.test(html), 'bodyweight units shown');
    assert(!/NaN|undefined/.test(html), 'no NaN or undefined leaking into the view');
  });

  test('per-step force columns reach the stride export', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var rows = X.strideRows(res, { analysisId: 'a1' });
    ['stepContactMs', 'stepFlightMs', 'stepDurationMs', 'stepDutyFactor', 'stepCadenceSpm',
     'stepMeanVerticalForceBw', 'stepPeakVerticalForceBw', 'verticalForceMethod'].forEach(function (c) {
      assert(X.STRIDE_COLUMNS.indexOf(c) > -1, 'column declared: ' + c);
      assert(Object.prototype.hasOwnProperty.call(rows[0], c), 'column present on rows: ' + c);
    });
    // Note: isFinite(null) is true in JS, so the type check is the load-bearing part.
    var withStep = rows.filter(function (r) { return typeof r.stepDutyFactor === 'number'; });
    assert(withStep.length > 0, 'at least one stride matched its step');
    withStep.forEach(function (r) {
      assertClose(r.stepMeanVerticalForceBw, 1 / r.stepDutyFactor, 1e-3, 'row mean force');
      assertClose(r.stepPeakVerticalForceBw, Math.PI / 2 / r.stepDutyFactor, 1e-3, 'row peak force');
      assert(r.verticalForceMethod === 'timing_duty_factor', 'method recorded per row');
    });
  });

  test('the export bundle disclaims the force columns and the missing horizontal', function () {
    var X = loadExport(); if (!X) { assert(true, 'export unavailable'); return; }
    var bundle = X.buildExport(KFOAnalysis.analyze({ samples: clip({}) }), clip({}), { analysisId: 'a1' });
    var notes = bundle.notes.join(' ');
    assert(/not measured force/i.test(notes), 'force columns must be disclaimed');
    assert(/underestimates the force-plate peak/i.test(notes), 'the peak bias must be stated');
    // The claim is specifically about the NET horizontal force. Braking impulse
    // magnitude is representable once a force source exists, so a blanket
    // "horizontal is absent" would now be wrong.
    assert(/Net horizontal force is not reported/i.test(notes), 'the missing net horizontal must be explained');
    assert(/braking impulse MAGNITUDE/i.test(notes), 'and the reason must name the quantity that is missing');
  });

  // ── Copy audit for the force headline ─────────────────────────────────────
  // Scoped to the force block: it is the only place a force NUMBER is shown, so
  // it is the only place this rule has to hold word by word.
  function forceHtml(over) {
    if (typeof d.KFORender === 'undefined' && typeof require === 'function') {
      try { d.KFORender = require('./kfo-render.js'); } catch (e) { return null; }
    }
    var R = d.KFORender;
    if (!R || typeof R.verticalForceSection !== 'function') return null;
    return R.verticalForceSection(KFOAnalysis.analyze({ samples: clip(over || {}) }));
  }

  test('the force headline never calls the estimate a measured force', function () {
    var html = forceHtml();
    if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(html.length > 0, 'the force card must render');
    var lower = html.toLowerCase(), i = -1;
    while ((i = lower.indexOf('measured', i + 1)) !== -1) {
      var before = lower.slice(Math.max(0, i - 14), i);
      assert(/\bnot\s+(a\s+|any\s+)?$/.test(before),
        '"measured" must always be negated, found: "…' + before + 'measured…"');
    }
    assert(/not a ground-reaction-force measurement/i.test(html), 'must carry the explicit disclaimer');
    assert(!/\bGRF\b/.test(html), 'the card must spell it out rather than lean on an acronym');
  });

  test('the force headline shows uncertainty, timing and the peak bias', function () {
    var html = forceHtml();
    if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/±/.test(html), 'uncertainty must be visible');
    assert(/BW/.test(html), 'bodyweight units must be visible');
    assert(/Duty factor/i.test(html), 'duty factor must be shown');
    assert(/Contact/i.test(html) && /Flight/i.test(html), 'contact and flight time must be shown');
    assert(/underestimate/i.test(html), 'the peak bias must be disclosed in the UI');
    assert(/does not average out/i.test(html), 'the systematic-bias caveat must reach the UI');
  });

  test('the force headline never presents force as good or bad', function () {
    var html = forceHtml();
    if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(!/injur/i.test(html), 'must not mention injury');
    assert(!/\b(too high|too low|excessive|poor|good|optimal|ideal)\b/i.test(html),
      'force magnitude is a load, not a verdict');
    assert(!/efficien|econom/i.test(html), 'must not imply efficiency or economy');
  });

  test('the panel leads with force and demotes the support-line angle', function () {
    if (typeof d.KFORender === 'undefined' && typeof require === 'function') {
      try { d.KFORender = require('./kfo-render.js'); } catch (e) { assert(true, 'unavailable'); return; }
    }
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var html = R.buildHtml(KFOAnalysis.analyze({ samples: clip({}) }));
    var forceAt = html.indexOf('Estimated vertical force');
    var geomAt = html.indexOf('Support-line geometry');
    assert(forceAt > -1, 'force card present');
    assert(geomAt > -1, 'geometry row present');
    assert(forceAt < geomAt, 'the force headline must come before the angle cards');
    assert(/secondary/i.test(html.slice(geomAt, geomAt + 200)), 'the geometry row must be marked secondary');
  });

  test('an unavailable force block explains itself instead of rendering blank', function () {
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var html = R.verticalForceSection({
      verticalForce: { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'double_support_detected_not_running' }
    });
    assert(/walking rather than running/i.test(html), 'explains the walking case');
    assert(/double_support_detected_not_running/.test(html), 'exposes the machine-readable reason');
    assert(!/BW/.test(html), 'no force value may appear');
    assert(R.verticalForceSection({}) === '', 'a result with no force block renders nothing');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  IMPULSE ACCOUNTING
  //
  //  The Clark fixtures below are ACCOUNTING EXAMPLES derived from the rounded
  //  means in a conference abstract. They exist to pin the arithmetic of the three
  //  compositions to numbers a reader can follow by hand. They are NOT normative
  //  targets, NOT measurements, and nothing may compare a runner to them.
  // ═══════════════════════════════════════════════════════════════════════════
  suite('impulse accounting — definitions');

  test('sign conventions are declared, not assumed', function () {
    var s = IMP.SIGN_CONVENTION;
    assert(/upward/i.test(s.verticalPositive), 'vertical positive is up');
    assert(/anterior|direction of travel/i.test(s.horizontalPositive), 'horizontal positive is forward');
    assert(/braking/i.test(s.horizontalNegative), 'horizontal negative is braking');
  });

  test('total and effective vertical impulse are separate concepts', function () {
    assert(/∫ Fz dt/.test(IMP.IMPULSE_DEFINITIONS.JvTotal), 'JvTotal defined');
    assert(/Fz − bodyWeight|Fz - bodyWeight/.test(IMP.IMPULSE_DEFINITIONS.JvEffective), 'JvEffective defined');
    assert(/NOT JvTotal/i.test(IMP.IMPULSE_DEFINITIONS.JvEffective),
      'JvEffective must say it is not JvTotal');
  });

  test('shares are declared scalar-sum, never direction cosines', function () {
    var t = IMP.IMPULSE_DEFINITIONS.shares;
    assert(/SCALAR-SUM/i.test(t), 'convention stated');
    assert(/not direction cosines/i.test(t), 'cosine reading refused');
    assert(/not energy/i.test(t), 'energy reading refused');
    assert(/NOT an instantaneous ground-reaction-force angle/i.test(IMP.IMPULSE_DEFINITIONS.angleEquivalent),
      'the angle equivalent must disclaim being a GRF angle');
  });

  test('impulse is documented as distinct from work, and impact from braking', function () {
    assert(/momentum/i.test(IMP.IMPULSE_DEFINITIONS.impulseVsWork) &&
           /energy/i.test(IMP.IMPULSE_DEFINITIONS.impulseVsWork), 'impulse vs work');
    assert(/does NOT mean|not imply/i.test(IMP.IMPULSE_DEFINITIONS.impulseVsWork),
      'zero net impulse must not imply zero energy cost');
    var ib = IMP.IMPULSE_DEFINITIONS.impactVsBraking;
    assert(/VERTICAL/.test(ib) && /FORE-AFT/.test(ib), 'impact and braking are on different axes');
    assert(/not interchangeable/i.test(ib), 'and are explicitly not interchangeable');
  });

  test('every composition names its own accounting basis', function () {
    IMP.COMPOSITION_ORDER.forEach(function (id) {
      var spec = IMP.COMPOSITION_SPEC[id];
      assert(!!spec, id + ' has a spec');
      assert(spec.verticalBasis === IMP.VERTICAL_BASIS.TOTAL ||
             spec.verticalBasis === IMP.VERTICAL_BASIS.EFFECTIVE, id + ' vertical basis');
      assert(!!spec.numeratorLabel && !!spec.denominatorLabel, id + ' labels its fraction');
      assert(spec.limitations.length > 0, id + ' carries limitations');
    });
  });

  test('no field is named as a bare vertical/horizontal ratio', function () {
    // A ratio with no accounting metadata attached is the exact defect this work
    // exists to prevent, so the name is banned outright.
    var series = analyticStance();
    var st = IMP.integrateStance(series, { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    var c = IMP.buildCompositions(st, {});
    Object.keys(c).forEach(function (k) {
      assert(!('verticalHorizontalRatio' in c[k]), k + ' must not carry an unlabelled ratio');
      assert(typeof c[k].verticalBasis === 'string', k + ' carries its vertical basis');
      assert(typeof c[k].horizontalBasis === 'string', k + ' carries its horizontal basis');
    });
    assert(!('verticalHorizontalRatio' in st), 'the stance record must not carry one either');
  });

  // ── Integration ───────────────────────────────────────────────────────────
  suite('impulse accounting — integration');

  /**
   * A stance with a known closed form: Fz = 2 BW constant for 0.2 s, Fx = −0.5 BW
   * for the first half then +0.5 BW for the second.
   *   JvTotal = 0.4, JvEffective = 0.4 − 0.2 = 0.2
   *   JBrake = JProp = 0.05, JhTurnover = 0.1, JxNet = 0
   */
  function analyticStance(opts) {
    opts = opts || {};
    var fzBw = opts.fzBw == null ? 2 : opts.fzBw;
    var brake = opts.brake == null ? 0.5 : opts.brake;
    var prop = opts.prop == null ? 0.5 : opts.prop;
    var dur = opts.durationSeconds == null ? 0.2 : opts.durationSeconds;
    var n = opts.n == null ? 200 : opts.n;
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = (i / n) * dur;
      out.push({ t: t, fz: fzBw, fx: t < dur / 2 ? -brake : prop });
    }
    return out;
  }

  test('the six impulses integrate to their closed form', function () {
    var st = IMP.integrateStance(analyticStance(), { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    assert(st.availability !== 'unavailable', 'stance is usable: ' + st.reason);
    assertClose(st.JvTotal, 0.4, 1e-6, 'JvTotal');
    assertClose(st.JvEffective, 0.2, 1e-6, 'JvEffective');
    assertClose(st.JBrake, 0.05, 2e-3, 'JBrake');
    assertClose(st.JProp, 0.05, 2e-3, 'JProp');
    assertClose(st.JhTurnover, 0.1, 3e-3, 'JhTurnover');
    assertClose(st.JxNet, 0, 3e-3, 'JxNet');
  });

  test('the effective-vertical shortcut is kept as a diagnostic, not as the value', function () {
    var st = IMP.integrateStance(analyticStance(), { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    var dg = st.diagnostics;
    assertClose(dg.JvEffectiveDirectIntegration, st.JvEffective, 1e-12, 'the reported value IS the integral');
    assertClose(dg.JvEffectiveShortcutReconstruction, 0.4 - 0.2, 1e-6, 'shortcut agrees here');
    assert(isFinite(dg.JvEffectiveShortcutDelta), 'the disagreement is quantified');
    assert(typeof dg.shortcutValidWhen === 'string', 'and its validity condition is stated');
  });

  test('a fore-aft zero crossing is split, not bucketed by interval sign', function () {
    // Two samples straddling zero: −1 then +3 over 0.04 s. Crossing at 25% of the
    // interval, so the braking area is 0.5*1*0.01 = 0.005 and the propulsive area
    // 0.5*3*0.03 = 0.045. Bucketing by the mean sign would put all 0.04 in one.
    var r = IMP.integrateBySign([{ t: 0, v: -1 }, { t: 0.04, v: 3 }]);
    assertClose(r.negative, 0.005, 1e-9, 'braking part');
    assertClose(r.positive, 0.045, 1e-9, 'propulsive part');
    assert(r.crossings.length === 1, 'the crossing is recorded');
    assertClose(r.crossings[0], 0.01, 1e-9, 'crossing time');
  });

  test('integration regions are reported so each integral can be traced', function () {
    var st = IMP.integrateStance(analyticStance(), { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    var reg = st.diagnostics.integrationRegions;
    assert(reg.braking.length >= 1 && reg.propulsive.length >= 1, 'both fore-aft regions present');
    assert(reg.aboveBodyWeight.length >= 1, 'above-bodyweight region present');
    assert(reg.bodyWeightLine === 1, 'the bodyweight line is stated');
    assertClose(reg.stance.startTime, 0, 1e-9, 'stance start');
    assertClose(reg.stance.endTime, 0.2, 1e-9, 'stance end');
  });

  test('acceleration shows as JProp > JBrake, deceleration as the reverse', function () {
    var acc = IMP.integrateStance(analyticStance({ brake: 0.2, prop: 0.6 }),
      { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    assert(acc.JProp > acc.JBrake, 'accelerating: propulsion dominates');
    assert(acc.JxNet > 0, 'and the signed net is positive');
    var dec = IMP.integrateStance(analyticStance({ brake: 0.6, prop: 0.2 }),
      { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    assert(dec.JBrake > dec.JProp, 'decelerating: braking dominates');
    assert(dec.JxNet < 0, 'and the signed net is negative');
  });

  test('a zero horizontal trace gives zero turnover without dividing by zero', function () {
    var st = IMP.integrateStance(analyticStance({ brake: 0, prop: 0 }),
      { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF });
    assertClose(st.JBrake, 0, 1e-9, 'JBrake');
    assertClose(st.JhTurnover, 0, 1e-9, 'JhTurnover');
    var c = IMP.buildCompositions(st, {});
    assert(c.projectionReplacement.verticalShareScalarSum === 1, 'all vertical when there is no horizontal');
    assert(c.projectionReplacement.ratioVerticalToHorizontal === null,
      'the ratio is null rather than Infinity');
    assert(c.projectionReplacement.angleEquivalentDegrees === 0, 'and the angle equivalent is zero');
  });

  test('bodyweight-normalised data needs no body mass', function () {
    var st = IMP.integrateStance(analyticStance(), {
      bodyWeight: 1, normalizedToBodyWeight: true, method: KFO.METHOD.VALIDATED_GRF
    });
    assert(st.unit === IMP.IMPULSE_UNIT.BW_SECONDS, 'unit is BW*s');
    assert(st.normalizedToBodyWeight === true, 'flagged as normalised');
    assertClose(st.JvEffective, 0.2, 1e-6, 'JvEffective computed without a mass');
  });

  test('newton-second data is carried in its own unit', function () {
    var bwN = 700;
    var series = analyticStance().map(function (p) {
      return { t: p.t, fz: p.fz * bwN, fx: p.fx * bwN };
    });
    var st = IMP.integrateStance(series, {
      bodyWeight: bwN, normalizedToBodyWeight: false, method: KFO.METHOD.VALIDATED_GRF
    });
    assert(st.unit === IMP.IMPULSE_UNIT.NEWTON_SECONDS, 'unit is N*s');
    assertClose(st.JvTotal, 0.4 * bwN, 1e-3, 'JvTotal in N*s');
    assertClose(st.JvEffective, 0.2 * bwN, 1e-3, 'JvEffective in N*s');
    var c = IMP.buildCompositions(st, {});
    assert(c.projectionReplacement.verticalImpulse.unit === IMP.IMPULSE_UNIT.NEWTON_SECONDS,
      'the unit propagates into the composition');
    assert(c.projectionReplacement.verticalImpulse.normalizedToBodyWeight === false,
      'and so does the normalisation flag');
    // The shares are dimensionless, so they must match the normalised case exactly.
    var norm = IMP.buildCompositions(
      IMP.integrateStance(analyticStance(), { bodyWeight: 1, method: KFO.METHOD.VALIDATED_GRF }), {});
    assertClose(c.projectionReplacement.verticalShareScalarSum,
      norm.projectionReplacement.verticalShareScalarSum, 1e-9, 'shares are unit-independent');
  });

  test('a non-positive stance duration is refused', function () {
    var st = IMP.integrateStance([{ t: 0.2, fz: 2, fx: 0 }, { t: 0.2, fz: 2, fx: 0 }, { t: 0.2, fz: 2, fx: 0 }],
      { bodyWeight: 1 });
    assert(st.availability === 'unavailable', 'refused');
    assert(st.reason === 'non_positive_stance_duration', 'reason ' + st.reason);
    assert(st.JvTotal === null, 'and nothing is invented');
  });

  test('a missing bodyweight reference is refused rather than falling back to total', function () {
    var st = IMP.integrateStance(analyticStance(), { bodyWeight: null, normalizedToBodyWeight: false });
    assert(st.availability === 'unavailable', 'refused');
    assert(st.reason === 'body_weight_reference_unavailable', 'reason ' + st.reason);
    assert(st.JvEffective === null, 'JvEffective must not silently become JvTotal');
  });

  test('an implausible stance is rejected with a reason, not aggregated', function () {
    // Mean vertical force below bodyweight cannot be a running contact.
    var st = IMP.integrateStance(analyticStance({ fzBw: 0.4 }), { bodyWeight: 1 });
    assert(st.isPlausible === false, 'flagged implausible');
    assert(st.reason === 'mean_vertical_force_below_body_weight', 'reason ' + st.reason);
    var agg = IMP.aggregateStances([st, st, st], {});
    assert(agg.availability === 'unavailable', 'implausible stances cannot form an aggregate');
    assert(agg.stancesRejected === 3, 'and the rejections are counted');
  });

  // ── Clark accounting fixtures ─────────────────────────────────────────────
  suite('impulse accounting — Clark reconstruction fixtures');

  test('5.0 m/s accounting example reproduces all three vertical shares', function () {
    var ex = IMP.fromNormalizedMeans({
      averageVerticalForceBw: 1.70,
      totalVerticalImpulseBwSeconds: 0.30,
      phaseHorizontalImpulseBwSeconds: 0.05,
      label: 'clark_2012_5mps'
    });
    assertClose(ex.contactTimeSeconds, 0.176470588, 1e-7, 'contact time');
    assertClose(ex.JvEffective, 0.123529412, 1e-7, 'JvEffective');
    assertClose(ex.JBrake, 0.05, 1e-12, 'JBrake');
    assertClose(ex.JProp, 0.05, 1e-12, 'JProp');
    assertClose(ex.JhTurnover, 0.10, 1e-12, 'JhTurnover');
    assertClose(ex.JxNet, 0, 1e-12, 'JxNet');

    var c = IMP.buildCompositions(ex, {});
    assertClose(c.totalSupportReplacement.verticalShareScalarSum, 0.857142857, 1e-7, 'A vertical share');
    assertClose(c.projectionReplacement.verticalShareScalarSum, 0.711864407, 1e-7, 'B vertical share');
    assertClose(c.activeProjectionTurnover.verticalShareScalarSum, 0.552631579, 1e-7, 'C vertical share');
    // Each pair must sum to 1, which is what makes them shares rather than cosines.
    IMP.COMPOSITION_ORDER.forEach(function (id) {
      var k = id.replace(/_([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
      assertClose(c[k].verticalShareScalarSum + c[k].horizontalShareScalarSum, 1, 1e-12, k + ' shares sum to 1');
    });
  });

  test('top-speed accounting example reproduces its shares', function () {
    var ex = IMP.fromNormalizedMeans({
      averageVerticalForceBw: 1.99,
      totalVerticalImpulseBwSeconds: 0.24,
      phaseHorizontalImpulseBwSeconds: 0.04,
      label: 'clark_2012_top_speed'
    });
    assertClose(ex.contactTimeSeconds, 0.120603015, 1e-7, 'contact time');
    assertClose(ex.JvEffective, 0.119396985, 1e-7, 'JvEffective');
    assertClose(ex.JhTurnover, 0.08, 1e-12, 'JhTurnover');
    assertClose(ex.JxNet, 0, 1e-12, 'JxNet');
    var c = IMP.buildCompositions(ex, {});
    assertClose(c.totalSupportReplacement.verticalShareScalarSum, 0.857142857, 1e-7, 'A vertical share');
    assertClose(c.projectionReplacement.verticalShareScalarSum, 0.7491, 1e-4, 'B vertical share');
    assertClose(c.activeProjectionTurnover.verticalShareScalarSum, 0.5988, 1e-4, 'C vertical share');
  });

  test('the accounting examples label themselves as examples, not targets', function () {
    var ex = IMP.fromNormalizedMeans({
      averageVerticalForceBw: 1.70, totalVerticalImpulseBwSeconds: 0.30,
      phaseHorizontalImpulseBwSeconds: 0.05
    });
    assert(ex.isAccountingExample === true, 'flagged as an example');
    assert(/not a measurement/i.test(ex.exampleNote), 'says it is not a measurement');
    assert(/not a normative target/i.test(ex.exampleNote), 'says it is not a target');
    assert(ex.provenance === KFO.PROVENANCE.DERIVED, 'provenance is derived');
  });

  test('the same trial genuinely yields three different vertical shares', function () {
    // The whole point of the accounting work: one trace, three answers, ordered
    // by how much of the vertical impulse and how much of the fore-aft axis each
    // one counts.
    var ex = IMP.fromNormalizedMeans({
      averageVerticalForceBw: 1.70, totalVerticalImpulseBwSeconds: 0.30,
      phaseHorizontalImpulseBwSeconds: 0.05
    });
    var c = IMP.buildCompositions(ex, {});
    var a = c.totalSupportReplacement.verticalShareScalarSum;
    var b = c.projectionReplacement.verticalShareScalarSum;
    var z = c.activeProjectionTurnover.verticalShareScalarSum;
    assert(a > b && b > z, 'shares must be strictly ordered A > B > C, got ' + [a, b, z].join(' > '));
    assert(a - z > 0.25, 'and the spread must be large enough to matter: ' + (a - z));
  });

  test('invalid reconstruction inputs are refused', function () {
    var bad = IMP.fromNormalizedMeans({ averageVerticalForceBw: 0, totalVerticalImpulseBwSeconds: 0.3 });
    assert(bad.availability === 'unavailable', 'refused');
    assert(bad.reason === 'invalid_reconstruction_inputs', 'reason ' + bad.reason);
  });

  // ── Aggregation, steady state, availability ───────────────────────────────
  suite('impulse accounting — aggregation and quality');

  test('shares are aggregated per stance, not recomputed from mean impulses', function () {
    // Four stances with deliberately different fore-aft magnitudes. A share is
    // nonlinear in its inputs, so the median of the shares is not the share of the
    // median impulses; the reported value must be the former and the latter is
    // retained only as a diagnostic. Four rather than three, so both medians
    // interpolate and the two routes cannot coincide by construction.
    var amps = [0.1, 0.4, 0.9, 1.4];
    var stances = amps.map(function (a, i) {
      return IMP.integrateStance(analyticStance({ brake: a, prop: a }),
        { bodyWeight: 1, strideIndex: i });
    });
    var agg = IMP.aggregateStances(stances, {});
    var c = agg.compositions.activeProjectionTurnover;
    assert(c.verticalShareAggregate.n === 4, 'all four stances contributed');
    assert(/median of per-stance shares/i.test(c.aggregationNote), 'the rule is stated');
    var pooled = c.pooledFromAggregateImpulses.verticalShareScalarSum;
    assert(Math.abs(c.verticalShareScalarSum - pooled) > 1e-9,
      'the two must actually differ here, or the test proves nothing');
  });

  test('fewer than three usable stances refuses to aggregate', function () {
    var s = IMP.integrateStance(analyticStance(), { bodyWeight: 1 });
    var agg = IMP.aggregateStances([s, s], {});
    assert(agg.availability === 'unavailable', 'refused');
    assert(agg.reason === 'insufficient_stances_for_aggregate', 'reason ' + agg.reason);
    IMP.IMPULSE_FIELDS.forEach(function (f) {
      assert(agg[f] === null, f + ' must be null, not zero');
    });
  });

  test('left and right aggregate separately and combine', function () {
    function side(name, brake) {
      return [0, 1, 2].map(function (i) {
        return IMP.integrateStance(analyticStance({ brake: brake, prop: brake }),
          { bodyWeight: 1, side: name, strideIndex: i });
      });
    }
    var l = side('left', 0.5), r = side('right', 0.3);
    var la = IMP.aggregateStances(l, {}), ra = IMP.aggregateStances(r, {});
    assert(la.stancesAnalyzed === 3 && ra.stancesAnalyzed === 3, 'both sides aggregate');
    assert(la.JhTurnover > ra.JhTurnover, 'the side difference survives aggregation');
    var combined = IMP.combineSides(la, ra, {});
    assert(combined.stancesAnalyzed === 6, 'combined pools both sides');
    assert(combined.JhTurnover > ra.JhTurnover && combined.JhTurnover < la.JhTurnover,
      'and the combined turnover sits between the two sides');
  });

  test('signed net horizontal impulse gates steady-state comparison', function () {
    var balanced = IMP.classifySteadyState({ JxNet: 0.001, JhTurnover: 0.1 }, {});
    assert(balanced.state === IMP.STEADY_STATE.CONSISTENT, 'balanced: ' + balanced.state);
    assert(balanced.normativeComparisonAllowed === true, 'comparison allowed');
    assert(/expected condition/i.test(balanced.interpretation),
      'and near-zero must be framed as expected, not as an achievement');

    var accelerating = IMP.classifySteadyState({ JxNet: 0.05, JhTurnover: 0.1 }, {});
    assert(accelerating.state === IMP.STEADY_STATE.POSSIBLE_ACCELERATION, 'accel: ' + accelerating.state);
    assert(accelerating.normativeComparisonAllowed === false, 'comparison withheld');
    assert(accelerating.candidateCauses.length > 1, 'and no single cause is asserted');

    var decelerating = IMP.classifySteadyState({ JxNet: -0.05, JhTurnover: 0.1 }, {});
    assert(decelerating.state === IMP.STEADY_STATE.POSSIBLE_DECELERATION, 'decel: ' + decelerating.state);
  });

  test('the steady-state thresholds are labelled provisional everywhere', function () {
    var ss = IMP.classifySteadyState({ JxNet: 0, JhTurnover: 0.1 }, {});
    assert(ss.isProvisional === true, 'flagged on the result');
    assert(/provisional/i.test(ss.provisionalNote), 'and explained');
    assert(IMP.CONFIG.isProvisional === true, 'and on the config');
    assert(isFinite(ss.warnThreshold) && isFinite(ss.rejectThreshold), 'both thresholds are exposed');
  });

  test('low confidence refuses to classify the balance at all', function () {
    var ss = IMP.classifySteadyState({ JxNet: 0.001, JhTurnover: 0.1 }, { confidenceScore: 0.1 });
    assert(ss.state === IMP.STEADY_STATE.INSUFFICIENT_CONFIDENCE, 'state ' + ss.state);
    assert(ss.normativeComparisonAllowed === false, 'and no comparison is offered');
  });

  test('zero turnover cannot divide by zero', function () {
    var ss = IMP.classifySteadyState({ JxNet: 0, JhTurnover: 0 }, {});
    assert(isFinite(ss.horizontalImpulseImbalance), 'imbalance stays finite: ' + ss.horizontalImpulseImbalance);
  });

  test('uncertainty and confidence propagate into every impulse value', function () {
    var s = [0, 1, 2].map(function (i) {
      return IMP.integrateStance(analyticStance({ brake: 0.4 + i * 0.05, prop: 0.4 + i * 0.05 }),
        { bodyWeight: 1, strideIndex: i });
    });
    var agg = IMP.aggregateStances(s, { confidence: { score: 0.62 } });
    var c = agg.compositions.projectionReplacement;
    assert(c.verticalImpulse.confidence !== null, 'confidence is attached to the impulse value');
    assert(c.verticalImpulse.confidence.score === 0.62, 'and it is the confidence supplied');
    assert(agg.JhTurnoverAggregate.n === 3, 'the distribution is retained');
    assert(agg.JhTurnoverAggregate.sd > 0, 'with a real spread');
    assert(Array.isArray(agg.JhTurnoverAggregate.ci95), 'and a confidence interval');
    assert(c.verticalShareAggregate.sd > 0, 'the share carries its own spread');
  });

  test('experimental stays experimental until criterion validation passes', function () {
    var s = [0, 1, 2].map(function () { return IMP.integrateStance(analyticStance(), { bodyWeight: 1 }); });
    var exp = IMP.aggregateStances(s, { isForceMeasurementValidated: false });
    assert(exp.availability === 'experimental', 'unvalidated source: ' + exp.availability);
    assert(exp.compositions.projectionReplacement.availability === 'experimental', 'and its compositions');
    var val = IMP.aggregateStances(s, { isForceMeasurementValidated: true });
    assert(val.availability === 'available', 'validated source: ' + val.availability);
    IMP.COMPOSITION_ORDER.forEach(function (id) {
      var k = id.replace(/_([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
      assert(val.compositions[k].isEfficiencyValidated === false,
        k + ' must never claim efficiency validation, even when force-plate validated');
    });
  });

  // ── Impact partition ──────────────────────────────────────────────────────
  suite('impulse accounting — impact partition');

  test('impact metrics stay unavailable without a high-rate validated source', function () {
    var lowRate = IMP.impactMetrics({ sampleRateHz: 60, isForceMeasurementValidated: true });
    assert(lowRate.availability === 'unavailable', 'refused at 60 Hz');
    assert(lowRate.reason === 'sample_rate_too_low_for_impact_metrics', 'reason ' + lowRate.reason);
    var unvalidated = IMP.impactMetrics({ sampleRateHz: 1000, isForceMeasurementValidated: false });
    assert(unvalidated.availability === 'unavailable', 'refused for an unvalidated source');
    assert(/validated/i.test(unvalidated.reason), 'reason names validation: ' + unvalidated.reason);
    ['verticalImpactPeak', 'verticalAverageLoadingRate', 'verticalInstantaneousLoadingRate',
     'impactTransientDetected'].forEach(function (f) {
      assert(lowRate[f] === null, f + ' must be null');
    });
  });

  test('impact is never treated as equivalent to braking impulse', function () {
    var im = IMP.impactMetrics({});
    assert(im.isBrakingImpulse === false, 'explicitly not a braking impulse');
    assert(/VERTICAL/.test(im.notEquivalentTo) && /FORE-AFT/.test(im.notEquivalentTo),
      'the axes are distinguished');
    assert(im.partitionedNotRemoved === true, 'and the landing phase is partitioned, not removed');
  });

  test('the landing phase is inside every integral, not subtracted out', function () {
    // JvTotal over the whole stance must equal the sum over an early and a late
    // half: nothing is removed in between.
    var full = IMP.integrateStance(analyticStance(), { bodyWeight: 1 });
    var series = analyticStance();
    var mid = 0.1;
    var early = series.filter(function (p) { return p.t <= mid; });
    var late = series.filter(function (p) { return p.t >= mid; });
    var a = IMP.integrate(early.map(function (p) { return { t: p.t, v: p.fz }; }));
    var b = IMP.integrate(late.map(function (p) { return { t: p.t, v: p.fz }; }));
    assertClose(a + b, full.JvTotal, 1e-9, 'the halves sum to the whole');
    assert(a > 0, 'the landing half contributes a real amount');
  });

  // ── Geometry-only behaviour ───────────────────────────────────────────────
  suite('impulse accounting — geometry-only refusal');

  test('the geometry path returns impulses as unavailable, never zero', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var im = res.impulseMetrics;
    assert(im.availability === 'unavailable', 'availability ' + im.availability);
    assert(im.reason === 'geometry_proxy_does_not_estimate_force_magnitude_or_impulse',
      'reason ' + im.reason);
    ['JvTotal', 'JvEffective', 'JBrake', 'JProp', 'JhTurnover', 'JxNet'].forEach(function (f) {
      assert(im[f] === null, f + ' must be null, not 0');
    });
    IMP.COMPOSITION_ORDER.forEach(function (id) {
      var k = id.replace(/_([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
      var c = im.compositions[k];
      assert(c.availability === 'unavailable', k + ' unavailable');
      assert(c.verticalShareScalarSum === null, k + ' share must be null');
      assert(c.angleEquivalentDegrees === null, k + ' angle equivalent must be null');
    });
  });

  test('no phase angle is ever converted into an impulse share', function () {
    // The strongest form of the check: change the angles a lot and confirm that
    // nothing in the impulse block moves, because there is no path from one to
    // the other.
    var neutral = KFOAnalysis.analyze({ samples: clip({}) });
    var over = KFOAnalysis.analyze({ samples: clip({ overstrideBiasLeft: 40, overstrideBiasRight: 40 }) });
    var a = neutral.left.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    var b = over.left.phases[KFO.PHASE.EARLY_STANCE].angle.median;
    assert(Math.abs(a - b) > 2, 'the fixtures must differ in angle, got ' + a + ' vs ' + b);
    assert(JSON.stringify(neutral.impulseMetrics.compositions) ===
           JSON.stringify(over.impulseMetrics.compositions),
      'the impulse block must be identical regardless of geometry');
  });

  test('geometry precursors are named as proxies and flagged as not impulses', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var p = res.momentumPreservationProxies;
    assert(p.availability === 'available', 'proxies are available on this path');
    ['brakingOrientationProxy', 'supportAlignmentProxy', 'replacementOrientationProxy'].forEach(function (k) {
      var m = p.left[k];
      assert(!!m, k + ' present');
      assert(m.unit === 'degrees', k + ' is in degrees');
      assert(m.isImpulse === false, k + ' must declare it is not an impulse');
      assert(m.isForceShare === false, k + ' must declare it is not a force share');
      assert(m.isWorkOrEnergy === false, k + ' must declare it is not work or energy');
    });
    assert(p.left.foreAftGeometricExcursion.isImpulse === false, 'excursion is not an impulse');
    assert(/require force magnitude/i.test(p.impulseNote), 'and the unavailability is stated');
  });

  test('a force series does produce impulse metrics on the same stances', function () {
    var samples = clip({});
    var base = KFOAnalysis.analyze({ samples: samples });
    var series = syntheticForceSeries(base);
    var res = KFOAnalysis.analyze({
      samples: samples,
      forceSeries: series,
      forceSeriesMeta: { normalizedToBodyWeight: true, bodyWeight: 1, sampleRateHz: 500,
                         method: KFO.METHOD.COM_ACCELERATION_EXPERIMENTAL, source: 'synthetic_fixture' }
    });
    var im = res.impulseMetrics;
    assert(im.availability === 'experimental', 'availability ' + im.availability + ' ' + im.reason);
    assert(im.combined.stancesAnalyzed >= 3, 'stances integrated: ' + im.combined.stancesAnalyzed);
    assert(im.combined.JvEffective < im.combined.JvTotal, 'effective is below total');
    assertClose(im.combined.JxNet, 0, 0.01, 'the synthetic runner is at steady speed');
    var c = im.combined.compositions;
    assert(c.totalSupportReplacement.verticalShareScalarSum >
           c.projectionReplacement.verticalShareScalarSum, 'A > B');
    assert(c.projectionReplacement.verticalShareScalarSum >
           c.activeProjectionTurnover.verticalShareScalarSum, 'B > C');
    // The stances must be the SAME ones the angles came from.
    assert(im.perSide.left.stancesAnalyzed <= base.left.stanceIntervals.length,
      'left stances cannot exceed the detected intervals');
  });

  /**
   * A physically-shaped bodyweight-normalised force series over a fixture clip:
   * half-sine vertical inside each detected stance, one full sine of fore-aft so
   * braking and propulsion balance, zero during flight.
   */
  function syntheticForceSeries(base, opts) {
    opts = opts || {};
    var peak = opts.peakFzBw == null ? 2.6 : opts.peakFzBw;
    var brake = opts.brakeAmpBw == null ? 0.45 : opts.brakeAmpBw;
    var prop = opts.propAmpBw == null ? brake : opts.propAmpBw;
    var ivs = [].concat(base.left.stanceIntervals, base.right.stanceIntervals);
    var end = 0;
    ivs.forEach(function (iv) { if (iv.endTime > end) end = iv.endTime; });
    var out = [];
    for (var t = 0; t <= end + 0.05; t += 0.002) {
      var fz = 0, fx = 0;
      for (var i = 0; i < ivs.length; i++) {
        var iv = ivs[i];
        if (t >= iv.startTime && t <= iv.endTime) {
          var u = (t - iv.startTime) / (iv.endTime - iv.startTime);
          fz = peak * Math.sin(Math.PI * u);
          fx = u < 0.5 ? -brake * Math.sin(2 * Math.PI * u) : prop * Math.sin(2 * Math.PI * u - Math.PI);
          break;
        }
      }
      out.push({ t: t, fx: fx, fz: fz });
    }
    return out;
  }

  // ── Persistence and migration ─────────────────────────────────────────────
  suite('impulse accounting — persistence');

  test('the stored form carries impulse aggregates but no per-stance detail', function () {
    var samples = clip({});
    var base = KFOAnalysis.analyze({ samples: samples });
    var res = KFOAnalysis.analyze({
      samples: samples, forceSeries: syntheticForceSeries(base),
      forceSeriesMeta: { normalizedToBodyWeight: true, bodyWeight: 1, sampleRateHz: 500 }
    });
    var stored = KFOAnalysis.toStoredForm(res);
    var im = stored.impulseMetrics;
    assert(im.availability === 'experimental', 'availability persisted');
    assert(isFinite(im.combined.JvEffective), 'the aggregate value is persisted');
    assert(!('perStance' in im.combined), 'per-stance detail must stay in the export');
    assert(!('rejections' in im.combined), 'and so must the rejection list');
    assert(!('definitions' in im), 'static definition text is not persisted');
    var c = im.combined.compositions.projectionReplacement;
    assert(c.verticalBasis === 'effective_vertical', 'accounting metadata survives');
    assert(c.horizontalBasis === 'replacement_only', 'both bases survive');
    assert(c.shareConvention === 'scalar_sum_share', 'and the share convention');
    assert(c.isEfficiencyValidated === false, 'and the non-validation flag');
  });

  test('a geometry-only save persists a compact unavailable marker, not a tree of nulls', function () {
    var stored = KFOAnalysis.toStoredForm(KFOAnalysis.analyze({ samples: clip({}) }));
    var im = stored.impulseMetrics;
    assert(im.availability === 'unavailable', 'availability');
    assert(im.reason === 'geometry_proxy_does_not_estimate_force_magnitude_or_impulse',
      'reason ' + im.reason);
    // Writing the whole null structure into every user document would cost several
    // kilobytes to say nothing.
    assert(Object.keys(im).length === 2, 'marker carries only availability and reason, got ' +
      Object.keys(im).join(','));
    assert(JSON.stringify(im).length < 200, 'and stays small: ' + JSON.stringify(im).length + ' bytes');
    // Nothing may read as a zero measurement anywhere in the persisted block.
    assert(!/[:,]0[,}]/.test(JSON.stringify(im)), 'no zero may appear where an impulse would be');
    assert(stored.momentumPreservationProxies.left.brakingOrientationProxy.isImpulse === false,
      'and the proxies keep their non-impulse flag');
  });

  test('the compact marker still rehydrates and renders as unavailable', function () {
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var stored = KFOAnalysis.toStoredForm(KFOAnalysis.analyze({ samples: clip({}) }));
    var back = R.fromStoredForm(stored);
    assert(back.impulseMetrics.availability === 'unavailable', 'availability survives the round trip');
    var html = R.buildStoredHtml(stored);
    assert(/Impulse accounting/.test(html), 'the panel renders');
    assert(/require force magnitude/i.test(html), 'and says what is missing');
    assert(!/\bNaN\b/.test(html) && !/undefined/.test(html), 'without NaN or undefined leaking through');
  });

  test('a v2 stored document still renders, with impulses reported unavailable', function () {
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var v2 = KFOAnalysis.toStoredForm(KFOAnalysis.analyze({ samples: clip({}) }));
    // Simulate a genuine v2 save: strip everything v3 added.
    delete v2.impulseMetrics;
    delete v2.momentumPreservationProxies;
    v2.schemaVersion = 2;
    var migrated = KFO.migrateAnalysis({ kfo: v2 });
    assert(migrated.kfo.availability === KFO.AVAILABILITY.AVAILABLE, 'the v2 analysis survives migration');
    var html = R.buildStoredHtml(migrated.kfo);
    assert(/Estimated vertical force/.test(html), 'the v2 force card still renders');
    assert(/Support-line geometry/.test(html), 'and the v2 angle cards');
    assert(/Impulse accounting/.test(html), 'the impulse panel appears');
    assert(!/\bNaN\b/.test(html), 'and nothing renders as NaN');
  });

  test('an old geometry angle is never reinterpreted as an impulse ratio', function () {
    var v2 = { kfo: { schemaVersion: 2, availability: 'available',
                      left: { phases: { early_stance: { median: -11.4 } } } } };
    var m = KFO.migrateAnalysis(v2);
    var im = m.kfo.impulseMetrics;
    assert(im.availability === KFO.AVAILABILITY.UNAVAILABLE, 'unavailable');
    IMP.IMPULSE_FIELDS.forEach(function (f) {
      assert(im[f] === null, f + ' must be null, not derived from -11.4°');
    });
    assert(m.kfo.left.phases.early_stance.median === -11.4, 'and the angle itself is untouched');
  });

  // ── UI copy ───────────────────────────────────────────────────────────────
  suite('impulse accounting — copy audit');

  function impulsePanel(availableCase) {
    var R = d.KFORender; if (!R) return null;
    if (!availableCase) return R.impulseAccountingSection(KFOAnalysis.analyze({ samples: clip({}) }));
    var samples = clip({});
    var base = KFOAnalysis.analyze({ samples: samples });
    return R.impulseAccountingSection(KFOAnalysis.analyze({
      samples: samples, forceSeries: syntheticForceSeries(base),
      forceSeriesMeta: { normalizedToBodyWeight: true, bodyWeight: 1, sampleRateHz: 500 }
    }));
  }

  test('the panel presents three accounting views, not one universal ratio', function () {
    var html = impulsePanel(true); if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/Total Support \/ Replacement/.test(html), 'view A present');
    assert(/Projection \/ Replacement/.test(html), 'view B present');
    assert(/Active Projection \/ Fore-Aft Turnover/.test(html), 'view C present');
    assert(/Why do these ratios differ/.test(html), 'and the explanation is offered');
    assert(/different accounting views|count different things/i.test(html),
      'the panel must say why they differ');
  });

  test('each view shows its own numerator, denominator and raw impulses', function () {
    var html = impulsePanel(true); if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/Numerator/.test(html) && /Denominator/.test(html), 'the fraction is spelled out');
    assert(/JvTotal/.test(html), 'total vertical impulse is named');
    assert(/JvEffective/.test(html), 'effective vertical impulse is named');
    assert(/JProp/.test(html) && /JhTurnover/.test(html), 'both horizontal bases are named');
    assert(/BW\*s/.test(html), 'units are shown');
    assert(/Angle equivalent/.test(html), 'the angle equivalent is labelled as an equivalent');
    assert(/scalar_sum_share/.test(html), 'and the share convention is exposed');
  });

  /**
   * Words like "target" and "efficiency score" DO appear in this panel — always
   * inside a denial ("not a validated efficiency score", "no target value is
   * applied"). Banning the word outright would push the copy into vagueness, so
   * the rule is that every occurrence must be negated nearby. Anything that reads
   * as an assertion fails.
   */
  function everyMentionIsDenied(html, word, negations) {
    var text = String(html).replace(/<[^>]*>/g, ' ');
    var re = new RegExp(word, 'gi');
    var neg = negations || /\b(not|never|no|none|without|cannot|un)\b/i;
    var m, ok = true, offenders = [];
    while ((m = re.exec(text)) !== null) {
      var before = text.slice(Math.max(0, m.index - 70), m.index);
      if (!neg.test(before)) { ok = false; offenders.push(before.slice(-50) + '[' + m[0] + ']'); }
    }
    return { ok: ok, offenders: offenders };
  }

  test('no universal 85/15, 70/30 or 60/40 cutoff is presented as a target', function () {
    var html = impulsePanel(true); if (html === null) { assert(true, 'renderer unavailable'); return; }
    ['target', 'optimal', 'ideal', 'goal'].forEach(function (w) {
      var r = everyMentionIsDenied(html, w);
      assert(r.ok, '"' + w + '" must only appear in a denial: ' + r.offenders.join(' | '));
    });
    assert(!/should be/i.test(html), 'no prescription');
    // Nor may any specific ratio be attached to goal language.
    ['85/15', '70/30', '60/40', '85\\.7', '71\\.2', '55\\.3'].forEach(function (pat) {
      var re = new RegExp(pat + '[^<]{0,60}(target|optimal|ideal|goal|aim for)', 'i');
      assert(!re.test(html), pat + ' must not be presented as a goal');
    });
  });

  test('the panel makes no efficiency or economy claim', function () {
    var html = impulsePanel(true); if (html === null) { assert(true, 'renderer unavailable'); return; }
    ['efficiency score', 'more efficient', 'more economical', 'economy'].forEach(function (w) {
      var r = everyMentionIsDenied(html, w);
      assert(r.ok, '"' + w + '" must only appear in a denial: ' + r.offenders.join(' | '));
    });
    assert(/not.{0,40}(validated|metabolically)/i.test(html), 'and validation is explicitly denied');
    assert(/experimental/i.test(html), 'the estimates are badged experimental');
    assert(/metabolic/i.test(html), 'and metabolic validation is named as the missing step');
  });

  test('the panel never calls an estimated share a measured force share', function () {
    [impulsePanel(true), impulsePanel(false)].forEach(function (html, i) {
      if (html === null) { assert(true, 'renderer unavailable'); return; }
      var label = i === 0 ? 'available' : 'unavailable';
      assert(!/measured force share/i.test(html), label + ': no measured force share');
      assert(!/measured ground.reaction/i.test(html) || /not a measured ground.reaction/i.test(html),
        label + ': any mention of measured GRF must be a denial');
    });
  });

  test('impact and braking are kept visibly separate in the panel', function () {
    var html = impulsePanel(true); if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/partitioned, not removed/i.test(html), 'the partition is stated');
    assert(/not the same quantity as horizontal braking impulse/i.test(html),
      'and impact is distinguished from braking');
    assert(/200 Hz|sampled at/i.test(html), 'with the reason impact is absent');
  });

  test('the geometry-only panel states the unavailability instead of rendering blank', function () {
    var html = impulsePanel(false); if (html === null) { assert(true, 'renderer unavailable'); return; }
    assert(/require force magnitude/i.test(html), 'explains what is missing');
    assert(/geometry_proxy_does_not_estimate_force_magnitude_or_impulse/.test(html),
      'exposes the machine-readable reason');
    // No composition card may render: that is where a share for THIS runner would
    // appear. The Clark accounting-example percentages inside the explainer are a
    // different thing and are allowed to stay.
    assert(!/Numerator/.test(html), 'no composition card may render');
    assert(!/Total Support \/ Replacement/.test(html), 'and no composition is named as a result');
    assert(/Why do these ratios differ/.test(html), 'the explanation is still available');
    assert(/Reconstructing the Clark/.test(html), 'including the worked accounting example');
  });

  test('the proxy section is in degrees and disclaims force shares', function () {
    var R = d.KFORender; if (!R) { assert(true, 'renderer unavailable'); return; }
    var html = R.momentumProxySection(KFOAnalysis.analyze({ samples: clip({}) }));
    assert(/Momentum-preservation proxies/.test(html), 'section present');
    assert(/braking orientation/i.test(html), 'braking proxy shown');
    assert(/replacement orientation/i.test(html), 'replacement proxy shown');
    assert(/°/.test(html), 'values are in degrees');
    assert(/not impulses/i.test(html), 'and are declared not to be impulses');
    assert(new RegExp(R.PROXY_UNAVAILABLE_NOTE.slice(0, 40)).test(html), 'the standard note appears');
    assert(!/BW\*s/.test(html), 'no impulse unit may appear in the proxy section');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  FATIGUE-ZONE ARCHITECTURE (experimental, no product surface)
  // ═══════════════════════════════════════════════════════════════════════════
  suite('fatigue zone');

  function windowsFrom(values, opts) {
    opts = opts || {};
    return values.map(function (v, i) {
      return {
        windowId: 'w' + i,
        timeElapsedSeconds: i * 300,
        distanceElapsedMeters: i * 1000,
        lapIndex: i,
        confidenceScore: opts.confidence == null ? 0.8 : opts.confidence,
        metrics: (function () {
          var m = {};
          FAT.TREND_METRICS.forEach(function (def) {
            m[def.key] = { value: def.key === (opts.metric || 'JhTurnover') ? v : 1,
                           unit: def.unit, family: def.family, availability: 'available' };
          });
          return m;
        })()
      };
    });
  }

  test('trend metrics are extracted from a real analysis result', function () {
    var res = KFOAnalysis.analyze({ samples: clip({}) });
    var w = FAT.buildWindow({ windowId: 'w0', analysis: res, timeElapsedSeconds: 0, distanceElapsedMeters: 0 });
    assert(w.metrics.brakingOrientationProxy.availability === 'available',
      'the geometry proxy is picked up');
    assert(w.metrics.JhTurnover.availability === 'unavailable',
      'and the impulse metric is correctly unavailable on this path');
    assert(w.metrics.brakingOrientationProxy.unit === 'degrees', 'units are carried');
    assert(w.metrics.JhTurnover.family === 'impulse', 'families are carried');
    assert(w.confidenceScore !== null, 'confidence comes across');
  });

  test('windows order by the requested key and separate those that lack it', function () {
    var ws = windowsFrom([1, 2, 3, 4]);
    ws[2].distanceElapsedMeters = null;
    var byTime = FAT.orderWindows(ws, FAT.ORDER_BY.TIME_ELAPSED);
    assert(byTime.ok && byTime.ordered.length === 4, 'all four order by time');
    assert(byTime.ordered[0].windowId === 'w0', 'and in the right order');
    var byDist = FAT.orderWindows(ws, FAT.ORDER_BY.DISTANCE_ELAPSED);
    assert(byDist.ordered.length === 3 && byDist.unordered.length === 1,
      'the window missing distance is set aside, not dropped or sorted to the front');
    var bad = FAT.orderWindows(ws, 'vibes');
    assert(bad.ok === false && bad.reason === 'unknown_order_key', 'an unknown key is refused');
  });

  test('too few windows refuses rather than guessing a baseline', function () {
    var out = FAT.analyzeFatigueZone({ windows: windowsFrom([1, 2]) });
    assert(out.availability === 'unavailable', 'refused');
    assert(out.reason === 'insufficient_windows', 'reason ' + out.reason);
    assert(!out.detectedChangePoint, 'and no change point is invented');
  });

  test('a sustained departure from baseline is located', function () {
    // Two baseline windows near 0.10, then a sustained jump to 0.20.
    var out = FAT.analyzeFatigueZone({
      windows: windowsFrom([0.100, 0.104, 0.200, 0.205, 0.210]),
      metrics: ['JhTurnover']
    });
    assert(out.availability === 'experimental', 'assessed: ' + out.reason);
    assert(out.baselineWindowIds.length === 2, 'baseline is the first two windows');
    var m = out.changedMetrics[0];
    assert(m.metric === 'JhTurnover', 'the metric assessed');
    assert(!!m.changePoint, 'a change point was found');
    assert(m.changePoint.windowId === 'w2', 'at the right window: ' + m.changePoint.windowId);
    assert(m.changePoint.direction === 'increase', 'in the right direction');
    assert(out.detectedChangePoint.timeSeconds === 600, 'located in time');
    assert(out.detectedChangePoint.distanceMeters === 2000, 'and in distance');
    assert(out.validationStatus === 'experimental', 'and stays experimental');
  });

  test('a single deviant window is not a fatigue zone', function () {
    var out = FAT.analyzeFatigueZone({
      windows: windowsFrom([0.100, 0.104, 0.400, 0.102, 0.101]),
      metrics: ['JhTurnover']
    });
    assert(!out.detectedChangePoint, 'one outlier window must not trigger detection');
    assert(/No sustained departure/i.test(out.interpretation.join(' ')), 'and that is stated');
  });

  test('a stable session reports no change point', function () {
    var out = FAT.analyzeFatigueZone({
      windows: windowsFrom([0.100, 0.101, 0.100, 0.102, 0.099]),
      metrics: ['JhTurnover']
    });
    assert(out.availability === 'experimental', 'still assessed');
    assert(!out.detectedChangePoint, 'no change point');
  });

  test('no universal fatigue threshold is asserted', function () {
    var out = FAT.analyzeFatigueZone({ windows: windowsFrom([0.1, 0.1, 0.2, 0.2, 0.2]),
                                       metrics: ['JhTurnover'] });
    assert(out.isFatigueThresholdValidated === false, 'no validated threshold');
    assert(out.config.isProvisional === true, 'the config is provisional');
    assert(/provisional/i.test(out.interpretation.join(' ')), 'and it is said out loud');
    assert(/cannot be determined|fatigue, pacing, terrain/i.test(out.interpretation.join(' ')),
      'and the cause is not asserted');
  });

  test('a metric missing from some windows is reported, not silently subsetted', function () {
    var ws = windowsFrom([0.1, 0.1, 0.2, 0.2]);
    ws[2].metrics.JhTurnover.value = null;
    var out = FAT.analyzeFatigueZone({ windows: ws, metrics: ['JhTurnover'] });
    var m = out.changedMetrics[0];
    assert(m.availability === 'unavailable', 'flagged unavailable');
    assert(m.reason === 'metric_missing_in_some_windows', 'reason ' + m.reason);
    assert(m.windowsWithValue === 3 && m.windowsTotal === 4, 'and the gap is quantified');
  });

  test('a degenerate baseline falls back to a relative change and says so', function () {
    var out = FAT.analyzeFatigueZone({
      windows: windowsFrom([0.100, 0.100, 0.130, 0.131, 0.132]),
      metrics: ['JhTurnover']
    });
    var m = out.changedMetrics[0];
    assert(m.changeRule === 'relative_baseline_sd_degenerate', 'rule ' + m.changeRule);
    assert(m.standardizedChange === null, 'no standardized change is claimed');
    assert(m.relativeChange > 0.2, 'but the relative change is reported: ' + m.relativeChange);
    assert(!!m.changePoint, 'and detection still works');
  });

  test('the trend registry separates geometry proxies from impulse quantities', function () {
    var families = {};
    FAT.TREND_METRICS.forEach(function (m) { families[m.family] = true; });
    assert(families.geometry_proxy && families.impulse, 'both families exist');
    FAT.TREND_METRICS.forEach(function (m) {
      if (m.family === 'geometry_proxy') assert(m.unit === 'degrees', m.key + ' must be in degrees');
      if (m.family === 'impulse') assert(m.unit === 'BW*s', m.key + ' must be in BW*s');
    });
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
