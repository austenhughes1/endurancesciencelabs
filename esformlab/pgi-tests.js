// ─────────────────────────────────────────────────────────────────────────────
//  PGI — test suite
//
//  Runs in node (`node pgi-tests.js`) and in the browser (pgi-tests.html).
//  No framework: a small assertion harness, matching the existing convention.
//
//  FIXTURES ARE PHYSICALLY CONSTRUCTED, not tuned to the expected answer. The
//  synthetic runner has:
//
//    - a COM that falls during stance and rises through flight, following a
//      ballistic arc whose apex is set by the flight time actually used;
//    - a swing foot that follows a real trajectory — it reaches forward, then
//      either retracts before contact or does not, according to the fixture;
//    - a foot that stays planted at a fixed ground position during stance while
//      the body translates over it.
//
//  So a "retraction" fixture produces retraction because the foot really moves
//  backward relative to the body before touchdown, not because a number was
//  chosen. The KFO fixtures could not be reused: they hold the body at constant
//  height and snap the swing foot to its plant position.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var deps = isNode ? {
    KFO: require('./kfo-core.js'),
    PGI: require('./pgi-core.js'),
    PGITiming: require('./pgi-timing.js'),
    PGICom: require('./pgi-com.js'),
    PGITouchdown: require('./pgi-touchdown.js'),
    PGIOutcome: require('./pgi-outcome.js'),
    PGIPhases: require('./pgi-phases.js'),
    PGIPatterns: require('./pgi-patterns.js'),
    PGICompare: require('./pgi-compare.js'),
    PGIAnalysis: require('./pgi-analysis.js'),
    PGIRender: require('./pgi-render.js'),
    PGIExport: require('./pgi-export.js'),
    PGIVerify: require('./pgi-verify.js'),
    PGIAnchors: require('./pgi-anchors.js')
  } : {
    KFO: root.KFO, PGI: root.PGI, PGITiming: root.PGITiming, PGICom: root.PGICom,
    PGITouchdown: root.PGITouchdown, PGIOutcome: root.PGIOutcome,
    PGIPhases: root.PGIPhases, PGIPatterns: root.PGIPatterns, PGICompare: root.PGICompare,
    PGIAnalysis: root.PGIAnalysis, PGIRender: root.PGIRender, PGIExport: root.PGIExport,
    PGIVerify: root.PGIVerify, PGIAnchors: root.PGIAnchors
  };
  var api = factory(deps);
  if (isNode) { module.exports = api; if (require.main === module) api.run(); }
  if (root) root.PGITests = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (d) {
  'use strict';

  var KFO = d.KFO, PGI = d.PGI, PGITiming = d.PGITiming, PGICom = d.PGICom,
      PGITouchdown = d.PGITouchdown, PGIOutcome = d.PGIOutcome, PGIPhases = d.PGIPhases,
      PGIPatterns = d.PGIPatterns, PGICompare = d.PGICompare, PGIAnalysis = d.PGIAnalysis,
      PGIRender = d.PGIRender, PGIExport = d.PGIExport;

  // ── Harness ────────────────────────────────────────────────────────────────
  var results = [], currentSuite = '';
  function suite(name) { currentSuite = name; }
  function test(name, fn) {
    try { fn(); results.push({ suite: currentSuite, name: name, pass: true }); }
    catch (e) { results.push({ suite: currentSuite, name: name, pass: false, error: e.message }); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function assertClose(a, b, tol, msg) {
    if (typeof a !== 'number' || !isFinite(a)) throw new Error((msg || 'value') + ': not finite (' + a + ')');
    if (Math.abs(a - b) > tol) throw new Error((msg || 'value') + ': expected ~' + b + ' ±' + tol + ', got ' + a);
  }
  function assertGt(a, b, msg) {
    if (!(a > b)) throw new Error((msg || 'value') + ': expected > ' + b + ', got ' + a);
  }
  function assertLt(a, b, msg) {
    if (!(a < b)) throw new Error((msg || 'value') + ': expected < ' + b + ', got ' + a);
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /**
   * Copy audits work by NEGATION CHECKING, not word banning.
   *
   * Words like "better", "efficiency" and "measure" legitimately appear in this
   * UI — always inside a denial ("a longer stride is not automatically better").
   * Banning them outright would push the copy into vagueness; requiring the
   * denial is what actually enforces the rule. Each occurrence is checked
   * against a window of surrounding text for a negation.
   */
  function assertOnlyInDenial(html, pattern, label) {
    var re = new RegExp(pattern.source || pattern, 'gi');
    var text = html.replace(/<[^>]*>/g, ' ');
    var m, checked = 0;
    while ((m = re.exec(text)) !== null) {
      var ctx = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 60);
      if (!/\b(no|not|never|neither|without|rather than|instead of|cannot|does not|is not|are not)\b/i.test(ctx)) {
        throw new Error((label || 'phrase') + ' used without a negation nearby: "' +
          ctx.replace(/\s+/g, ' ').trim() + '"');
      }
      checked++;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return checked;
  }

  // ── Synthetic runner ───────────────────────────────────────────────────────

  var TORSO = 60, HIP_ABOVE_GROUND = 95, THIGH = 46, SHANK = 44;
  var GROUND_Y = 400;
  var G = 9.80665;

  /**
   * Build one COCO-17 frame from explicit joint positions.
   * Image +y is DOWN, so a HIGHER body means a SMALLER hipY.
   */
  function frame(o) {
    var conf = o.conf == null ? 0.85 : o.conf;
    var dir = o.dirSign;
    var hipY = o.hipY, bodyX = o.bodyX;
    var shY = hipY - TORSO;
    var kps = new Array(17);
    function set(i, x, y, c) { kps[i] = { x: x, y: y, score: c == null ? conf : c }; }

    set(0, bodyX + 12 * dir, shY - 26);                 // nose, facing travel
    set(1, bodyX + 10 * dir, shY - 28); set(2, bodyX + 14 * dir, shY - 28);
    set(3, bodyX + 6 * dir, shY - 26);  set(4, bodyX + 16 * dir, shY - 26);
    set(5, bodyX - 4, shY);             set(6, bodyX + 4, shY);           // shoulders
    // Arms swing anti-phase with the legs; amplitude is a fixture input.
    var armPhase = o.armPhase == null ? 0 : o.armPhase;
    var armAmp = o.armAmplitude == null ? 26 : o.armAmplitude;
    set(7, bodyX - 6 + armAmp * Math.sin(armPhase) * dir, shY + 30);
    set(8, bodyX + 6 - armAmp * Math.sin(armPhase) * dir, shY + 30);
    set(9, bodyX - 6 + armAmp * 1.6 * Math.sin(armPhase) * dir, shY + 56);
    set(10, bodyX + 6 - armAmp * 1.6 * Math.sin(armPhase) * dir, shY + 56);
    set(11, bodyX - 4, hipY); set(12, bodyX + 4, hipY);                   // hips

    // Knees are placed on the hip→ankle line at the thigh fraction, so leg
    // length stays anatomically consistent as the ankle moves.
    function knee(ankleX, ankleY) {
      var dx = ankleX - bodyX, dy = ankleY - hipY;
      var len = Math.hypot(dx, dy) || 1;
      var f = Math.min(0.62, THIGH / Math.max(len, THIGH + SHANK));
      // Bend the knee slightly forward so it is never collinear.
      return { x: bodyX + dx * f + 5 * dir, y: hipY + dy * f };
    }
    var lk = knee(o.lAnkleX, o.lAnkleY), rk = knee(o.rAnkleX, o.rAnkleY);
    set(13, lk.x, lk.y); set(14, rk.x, rk.y);
    set(15, o.lAnkleX, o.lAnkleY, o.lAnkleConf);
    set(16, o.rAnkleX, o.rAnkleY, o.rAnkleConf);
    return kps;
  }

  /**
   * Build a clip.
   *
   * @param {Object} o
   *   sampleRateHz, durationSeconds, stanceSeconds, flightSeconds
   *   velocityPxPerSec, dirSign
   *   comDropPx        COM fall from touchdown to mid-stance
   *   footAheadPx      how far ahead of the hip the foot plants (overstride knob)
   *   reachAheadPx     furthest forward the swing foot reaches before contact
   *   retractMs        how long before contact the foot starts coming back
   *                    (0 = no retraction: the foot reaches and lands there)
   *   asymmetric       apply a different reach/retract to the right side
   */
  function makeClip(o) {
    var rate = o.sampleRateHz, dur = o.durationSeconds;
    var stance = o.stanceSeconds, flight = o.flightSeconds;
    var step = stance + flight;
    var v = o.velocityPxPerSec, dir = o.dirSign == null ? 1 : o.dirSign;
    var comDrop = o.comDropPx == null ? 8 : o.comDropPx;
    var footAhead = o.footAheadPx == null ? 18 : o.footAheadPx;
    var reachAhead = o.reachAheadPx == null ? 46 : o.reachAheadPx;
    var retractMs = o.retractMs == null ? 90 : o.retractMs;
    var startX = dir > 0 ? 140 : 900;
    var n = Math.round(dur * rate);

    // Contact schedule, alternating sides.
    var contacts = [];
    for (var ci = 0; ci * step < dur; ci++) {
      contacts.push({
        side: ci % 2 === 0 ? 'left' : 'right',
        start: ci * step, end: ci * step + stance, index: ci
      });
    }
    function bodyXAt(t) { return startX + v * t * dir; }
    function plantXFor(c) {
      // Foot plants `footAhead` ahead of where the hip will be at touchdown.
      var ahead = (o.asymmetric && c.side === 'right') ? footAhead * 1.9 : footAhead;
      return bodyXAt(c.start) + ahead * dir;
    }

    /**
     * COM height above the ground line. During stance the body falls by comDrop
     * to mid-stance and recovers; during flight it follows a ballistic arc whose
     * rise is g*t_f^2/8 in metres, converted with a fixture scale so the
     * decomposition has a physically coherent shape.
     *
     * Four-phase fixture knobs:
     *   comDropRightPx    per-side compression depth (rebound asymmetry)
     *   minComSkew        >1 pushes the stance minimum later, <1 earlier
     *   minComSkewRight   per-side skew
     *   flatMinimum       clips the fall curve into a broad flat bottom
     *   stanceEndDropPx   stance ends this much lower than it began
     *                     (compression that is not recovered before toe-off)
     */
    var pxPerMeter = o.pixelsPerMeter == null ? 300 : o.pixelsPerMeter;
    var aerialRisePx = (G * flight * flight / 8) * pxPerMeter;
    var endDropPx = o.stanceEndDropPx == null ? 0 : o.stanceEndDropPx;
    function stanceFallPx(c, u) {
      var drop = (o.comDropRightPx != null && c.side === 'right') ? o.comDropRightPx : comDrop;
      var skew = (o.minComSkewRight != null && c.side === 'right')
        ? o.minComSkewRight : (o.minComSkew == null ? 1 : o.minComSkew);
      var shape = Math.sin(Math.PI * Math.pow(u, skew));
      if (o.flatMinimum) shape = Math.min(1, 1.35 * shape);
      return drop * shape + endDropPx * u;
    }
    function hipYAt(t) {
      var base = GROUND_Y - HIP_ABOVE_GROUND;
      // Which phase are we in?
      for (var i = 0; i < contacts.length; i++) {
        var c = contacts[i];
        if (t >= c.start && t <= c.end) {
          // Stance: fall then recover, minimum near mid-stance unless skewed.
          var u = (t - c.start) / stance;           // 0..1
          return base + stanceFallPx(c, u);         // +y is down => lower COM
        }
        var nextStart = (i + 1 < contacts.length) ? contacts[i + 1].start : null;
        if (nextStart != null && t > c.end && t < nextStart) {
          // Flight: ballistic arc, apex mid-flight, continuous with any
          // unrecovered stance drop.
          var w = (t - c.end) / (nextStart - c.end);
          var rise = aerialRisePx * 4 * w * (1 - w);  // parabola, peak at w=0.5
          return base + endDropPx * (1 - w) - rise;
        }
      }
      return base;
    }

    /**
     * Swing-foot position. The foot lifts, swings forward to `reachAhead` ahead
     * of the hip, then — if retractMs > 0 — comes back toward the plant position
     * over the final retractMs before contact. With retractMs = 0 it simply
     * arrives at its furthest reach, which is the rushed/scuffing case.
     */
    function swingFoot(side, t) {
      var next = null, prev = null;
      for (var i = 0; i < contacts.length; i++) {
        var c = contacts[i];
        if (c.side !== side) continue;
        if (c.start > t && (!next || c.start < next.start)) next = c;
        if (c.end < t && (!prev || c.end > prev.end)) prev = c;
      }
      var hipX = bodyXAt(t);
      if (!next) return { x: hipX - 12 * dir, y: GROUND_Y - 42 };

      var reach = (o.asymmetric && side === 'right') ? reachAhead * 1.35 : reachAhead;
      var retract = (o.asymmetric && side === 'right') ? 0 : retractMs;
      var plantX = plantXFor(next);
      var swingStart = prev ? prev.end : Math.max(0, next.start - (step * 2 - stance));
      var swingDur = next.start - swingStart;
      if (!(swingDur > 0)) return { x: plantX, y: GROUND_Y };

      var tRetractStart = next.start - retract / 1000;
      var maxReachX = bodyXAt(tRetractStart) + reach * dir;

      var x, y;
      if (retract > 0 && t >= tRetractStart) {
        // Retraction: move from the max-reach position back to the plant point.
        var r = (t - tRetractStart) / (next.start - tRetractStart);
        x = maxReachX + (plantX - maxReachX) * r;
        y = GROUND_Y - 26 * (1 - r);          // descending onto the ground
      } else {
        // Forward swing toward the reach position.
        var s = Math.max(0, Math.min(1, (t - swingStart) / Math.max(1e-6, tRetractStart - swingStart)));
        var lift = 52 * Math.sin(Math.PI * s);
        var fromX = prev ? bodyXAt(prev.end) - 30 * dir : hipX - 40 * dir;
        x = fromX + (maxReachX - fromX) * s;
        y = GROUND_Y - 26 - lift;
        if (retract === 0) {
          // No retraction: descend straight onto the plant point.
          y = GROUND_Y - 26 - lift * (1 - s);
          x = fromX + (plantX - fromX) * s;
        }
      }
      return { x: x, y: y };
    }

    var samples = [];
    for (var i2 = 0; i2 < n; i2++) {
      var t = i2 / rate;
      var bodyX = bodyXAt(t);
      var hipY = hipYAt(t);
      var active = null;
      for (var j = 0; j < contacts.length; j++) {
        if (t >= contacts[j].start && t <= contacts[j].end) { active = contacts[j]; break; }
      }
      var lFoot, rFoot;
      if (active && active.side === 'left') {
        lFoot = { x: plantXFor(active), y: GROUND_Y };
        rFoot = swingFoot('right', t);
      } else if (active && active.side === 'right') {
        rFoot = { x: plantXFor(active), y: GROUND_Y };
        lFoot = swingFoot('left', t);
      } else {
        lFoot = swingFoot('left', t);
        rFoot = swingFoot('right', t);
      }

      var conf = o.conf == null ? 0.85 : o.conf;
      var kps = frame({
        bodyX: bodyX, hipY: hipY, dirSign: dir, conf: conf,
        lAnkleX: lFoot.x, lAnkleY: lFoot.y, rAnkleX: rFoot.x, rAnkleY: rFoot.y,
        armPhase: (t / step) * Math.PI * 2,
        armAmplitude: o.armAmplitude
      });
      if (o.occludeEvery && i2 % o.occludeEvery === 0) {
        kps[15] = { x: lFoot.x, y: lFoot.y, score: 0.05 };
      }
      samples.push({
        t: t, kps: kps, conf: conf, scale: TORSO, frameWidth: 400,
        hipMidX: bodyX,
        lAnkleX: lFoot.x, lAnkleY: lFoot.y, rAnkleX: rFoot.x, rAnkleY: rFoot.y
      });
    }
    return samples;
  }

  var BASE = {
    sampleRateHz: 60, durationSeconds: 4.0, stanceSeconds: 0.235,
    flightSeconds: 0.125, velocityPxPerSec: 300, dirSign: 1,
    comDropPx: 9, footAheadPx: 18, reachAheadPx: 46, retractMs: 90
  };
  function clip(over) {
    var o = {};
    Object.keys(BASE).forEach(function (k) { o[k] = BASE[k]; });
    Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
    return makeClip(o);
  }
  function analyze(over, input) {
    var samples = clip(over);
    var base = { samples: samples, videoMetadata: { fps: 60 }, userHeightMeters: 1.78,
                 surfaceType: 'overground' };
    Object.keys(input || {}).forEach(function (k) { base[k] = input[k]; });
    return PGIAnalysis.analyze(base);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ballistic and timing formulas
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Ballistic projection formulas');

  test('take-off velocity is g*t/2 and round-trips through the flight-time prediction', function () {
    var tf = 0.125;
    var v = PGI.verticalTakeoffVelocityMps(tf);
    assertClose(v, 9.80665 * 0.125 / 2, 1e-9, 'takeoff velocity');
    assertClose(PGI.predictedFlightTimeSeconds(v), tf, 1e-9, 'round trip');
  });

  test('effective vertical impulse per mass is exactly g*t_flight', function () {
    assertClose(PGI.effectiveVerticalImpulsePerMass(0.13), 9.80665 * 0.13, 1e-9, 'impulse');
    assertClose(PGI.effectiveVerticalImpulsePerMass(0.13),
                2 * PGI.verticalTakeoffVelocityMps(0.13), 1e-9, 'equals 2*v');
  });

  test('ballistic aerial rise is g*t^2/8', function () {
    assertClose(PGI.aerialRiseMeters(0.12), 9.80665 * 0.0144 / 8, 1e-9, 'aerial rise');
  });

  test('negative or missing flight time yields null, never a number', function () {
    assert(PGI.verticalTakeoffVelocityMps(null) === null, 'null flight');
    assert(PGI.verticalTakeoffVelocityMps(-0.1) === null, 'negative flight');
    assert(PGI.aerialRiseMeters(undefined) === null, 'undefined flight');
  });

  suite('Stride timing');

  test('GCT, flight and duty factor are recovered from detected events', function () {
    var r = analyze({ stanceSeconds: 0.235, flightSeconds: 0.125 });
    var o = r.strideTiming.overall;
    assertClose(o.contactSeconds.median, 0.235, 0.035, 'GCT');
    assertClose(o.flightSeconds.median, 0.125, 0.035, 'flight');
    assertClose(o.dutyFactor.median, 0.235 / 0.36, 0.06, 'duty factor');
  });

  test('duty factor, cadence and step time are consistent with each other', function () {
    var r = analyze({});
    var o = r.strideTiming.overall;
    assertClose(o.dutyFactor.median, o.contactSeconds.median / o.stepSeconds.median, 0.02, 'DF identity');
    assertClose(o.cadenceSpm.median, 60 / o.stepSeconds.median, 1.5, 'cadence identity');
    assertClose(o.flightFraction.median, 1 - o.dutyFactor.median, 0.03, 'flight fraction');
  });

  test('mean vertical support is 1/duty factor', function () {
    var r = analyze({});
    var vs = r.verticalProjection.verticalSupport;
    assert(vs.availability === 'available', 'support available');
    var df = r.strideTiming.overall.dutyFactor.median;
    // Per-step then aggregated, so it sits at or above 1/mean(DF) by convexity.
    assert(vs.meanVerticalSupportBW.median >= 1 / df - 0.02, 'support >= 1/DF');
    assert(vs.isValidated === false, 'never marked validated');
    assert(vs.method === 'timing_derived', 'labelled timing-derived');
  });

  test('the vertical support estimate is withheld when acceleration is detected', function () {
    var out = PGITiming.analyze({
      leftStanceIntervals: [{ startTime: 0, endTime: 0.24 }, { startTime: 0.72, endTime: 0.96 }],
      rightStanceIntervals: [{ startTime: 0.36, endTime: 0.60 }, { startTime: 1.08, endTime: 1.32 }],
      effectiveSampleRateHz: 60,
      steadySpeed: { assessable: true, accelerationDetected: true }
    });
    assert(out.verticalSupport.availability === 'insufficient_quality', 'withheld under acceleration');
    assert(/steady_state/.test(out.verticalSupport.reason), 'reason names the assumption');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  COM trajectory and vertical-oscillation decomposition
  // ═══════════════════════════════════════════════════════════════════════════
  suite('COM trajectory');

  test('vertical oscillation is decomposed into compression, rebound and aerial rise', function () {
    var r = analyze({});
    var dec = r.comTrajectory.decomposition.overall;
    ['stanceCompression', 'stanceRebound', 'aerialRiseMeasured', 'verticalOscillation']
      .forEach(function (k) {
        assert(dec[k] && isNum(dec[k].medianLegLengths), k + ' present and numeric');
      });
    assert(dec.verticalOscillation.medianLegLengths > 0, 'oscillation positive');
  });

  test('total oscillation is at least as large as any single component', function () {
    var r = analyze({});
    var dec = r.comTrajectory.decomposition.overall;
    var total = dec.verticalOscillation.medianLegLengths;
    ['stanceCompression', 'stanceRebound', 'aerialRiseMeasured'].forEach(function (k) {
      assert(total >= dec[k].medianLegLengths - 1e-6, total + ' >= ' + k);
    });
  });

  test('a deeper stance collapse increases compression, not aerial rise', function () {
    var shallow = analyze({ comDropPx: 5 });
    var deep = analyze({ comDropPx: 20 });
    var a = shallow.comTrajectory.decomposition.overall;
    var b = deep.comTrajectory.decomposition.overall;
    assertGt(b.stanceCompression.medianLegLengths, a.stanceCompression.medianLegLengths,
      'compression rises with the modelled collapse');
    // Aerial rise is set by flight time, which is unchanged between the two, so
    // it must move far less than compression does. It is not asserted to be
    // perfectly constant: smoothing across the stance/flight boundary smears a
    // deeper collapse into the toe-off height, and that is real behaviour of the
    // measurement rather than something to hide.
    var compRel = (b.stanceCompression.medianLegLengths - a.stanceCompression.medianLegLengths) /
                  a.stanceCompression.medianLegLengths;
    var riseRel = Math.abs(b.aerialRiseMeasured.medianLegLengths -
                           a.aerialRiseMeasured.medianLegLengths) /
                  a.aerialRiseMeasured.medianLegLengths;
    assertGt(compRel, riseRel * 2, 'compression responds far more than aerial rise');
  });

  test('longer flight increases the measured aerial rise', function () {
    var short = analyze({ flightSeconds: 0.08 });
    var long = analyze({ flightSeconds: 0.16 });
    assertGt(long.comTrajectory.decomposition.overall.aerialRiseMeasured.medianLegLengths,
             short.comTrajectory.decomposition.overall.aerialRiseMeasured.medianLegLengths,
             'aerial rise grows with flight time');
  });

  test('COM vertical velocity reverses from negative at touchdown to positive at toe-off', function () {
    var r = analyze({});
    var v = r.comTrajectory.velocity.overall;
    assert(isNum(v.touchdown.medianLegLengthsPerS), 'touchdown velocity numeric');
    assert(isNum(v.toeoff.medianLegLengthsPerS), 'toe-off velocity numeric');
    assertGt(v.reversal.medianLegLengthsPerS, 0, 'reversal is positive (downward -> upward)');
  });

  test('the reversal rate is reported in normalised units and is not called a force', function () {
    var r = analyze({});
    var v = r.comTrajectory.velocity.overall;
    assert(isNum(v.reversalRateLegLengthsPerS2.median), 'normalised reversal rate present');
    assert(/not a force/i.test(v.note), 'note disclaims force');
  });

  test('the flight-time cross-check reports whether it is independent of the calibration', function () {
    var withHeight = analyze({}, { userHeightMeters: 1.78 });
    var cc = withHeight.comTrajectory.flightCrossCheck;
    assert(cc.availability === 'available', 'cross-check available with a calibration');
    assert(cc.isIndependent === true, 'user-height calibration makes it independent');

    var noHeight = analyze({}, { userHeightMeters: null });
    var cc2 = noHeight.comTrajectory.flightCrossCheck;
    if (cc2.availability === 'available') {
      assert(cc2.isIndependent === false, 'ballistic calibration is not independent');
      assert(cc2.comVelocityConfidence === null, 'no confidence claimed from a circular check');
    }
  });

  test('the stored form never contains undefined, which Firestore rejects outright', function () {
    function findUndefined(v, path) {
      if (v === undefined) return path;
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) {
          var p = findUndefined(v[i], path + '[' + i + ']');
          if (p) return p;
        }
        return null;
      }
      if (v && typeof v === 'object') {
        var keys = Object.keys(v);
        for (var j = 0; j < keys.length; j++) {
          var q = findUndefined(v[keys[j]], path + '.' + keys[j]);
          if (q) return q;
        }
      }
      return null;
    }
    var full = analyze({});
    var bad = findUndefined(PGIAnalysis.toStoredForm(full), 'pgi');
    assert(bad === null, 'undefined at ' + bad);

    // The unavailable branches omit fields the stored form reads: crossCheck()
    // without a calibration has no isIndependent, and timing-unavailable
    // verticalSupport has no conditions/caveats. Both shapes must still store.
    var degraded = analyze({});
    degraded.comTrajectory.flightCrossCheck =
      { availability: 'unavailable', reason: 'no_spatial_calibration' };
    degraded.verticalProjection.verticalSupport =
      { availability: 'unavailable', reason: 'no_usable_steps',
        method: 'timing_derived', isValidated: false };
    bad = findUndefined(PGIAnalysis.toStoredForm(degraded), 'pgi');
    assert(bad === null, 'undefined at ' + bad);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Touchdown preparation
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Touchdown preparation');

  test('a retracting foot is detected as retracting', function () {
    var r = analyze({ retractMs: 110, reachAheadPx: 52, footAheadPx: 16 });
    var L = r.touchdownPreparation.left;
    assert(L.availability === 'available', 'left available');
    assertGt(L.aggregate.retractionTimeMs.median, 40, 'retraction period found');
    assertGt(L.aggregate.retractionDistanceComLegLengths.median, 0, 'retraction distance positive');
    assertGt(L.aggregate.clearRetractionFraction, 0.5, 'clear retraction on most contacts');
  });

  test('a foot that never retracts is NOT reported as retracting', function () {
    var r = analyze({ retractMs: 0, reachAheadPx: 30, footAheadPx: 30 });
    var L = r.touchdownPreparation.left;
    assert(L.availability === 'available', 'left available');
    assertLt(L.aggregate.clearRetractionFraction, 0.5, 'retraction not claimed');
  });

  test('max anterior excursion precedes touchdown when the foot retracts', function () {
    var r = analyze({ retractMs: 110 });
    var L = r.touchdownPreparation.left;
    assertGt(L.aggregate.timeFromMaxAnteriorToTouchdownMs.median, 30,
      'furthest reach happens before contact');
    assertGt(L.aggregate.maxAnteriorExcursionLegLengths.median,
             L.aggregate.footComOffsetAtTouchdownLegLengths.median,
             'reach exceeds the landing offset');
  });

  test('a foot planted further ahead produces a larger foot-COM offset', function () {
    var near = analyze({ footAheadPx: 10 });
    var far = analyze({ footAheadPx: 55 });
    assertGt(far.touchdownPreparation.left.aggregate.footComOffsetAtTouchdownLegLengths.median,
             near.touchdownPreparation.left.aggregate.footComOffsetAtTouchdownLegLengths.median,
             'offset grows with the modelled plant position');
  });

  test('pre-contact velocity is refused, not estimated, when the frame rate is too low', function () {
    var w = PGI.velocityWindow(9);
    assert(w.available === false, 'window refused at 9 Hz');
    assert(w.reason === 'video_frame_rate_insufficient', 'reason is the frame rate');
    var r = analyze({ sampleRateHz: 10, durationSeconds: 4 });
    if (r.touchdownPreparation.availability === 'available') {
      var L = r.touchdownPreparation.left;
      if (L && L.availability === 'available') {
        assert(!isNum(L.aggregate.horizontalFootVelocityMps.median),
          'no velocity value fabricated at 10 Hz');
      }
    }
    assert(r.quality.flags.indexOf('velocity_sampling_insufficient') !== -1 ||
           r.availability !== 'available', 'insufficient-velocity flag raised');
  });

  test('the approach angle uses the stated convention', function () {
    var r = analyze({});
    var L = r.touchdownPreparation.left;
    var contact = L.contacts.filter(function (c) {
      return c.arrivalVelocity.availability === 'available'; })[0];
    assert(contact, 'a contact with arrival velocity exists');
    assert(/0.*forward.*90.*down/i.test(contact.arrivalVelocity.approachAngleConvention),
      'convention documented on the value');
    // The foot is descending onto the ground, so the angle is below horizontal.
    assertGt(contact.arrivalVelocity.approachAngleDegrees, 0, 'descending approach is positive');
  });

  suite('Braking pattern classification');

  test('positional overstride: foot far ahead but well prepared', function () {
    var cls = PGITouchdown.classifyBraking({
      n: 8,
      footComOffsetAtTouchdownLegLengths: { median: 0.46 },
      clearRetractionFraction: 0.85,
      retractionTimeMs: { median: 95 },
      footGroundVelocityMps: { median: -0.2 }
    }, {});
    assert(cls.pattern === PGI.BRAKING_PATTERN.POSITIONAL_OVERSTRIDE, 'got ' + cls.pattern);
    assert(/far ahead/i.test(cls.interpretation), 'interpretation mentions position');
  });

  test('velocity mismatch: normal position but the foot is still travelling forward', function () {
    var cls = PGITouchdown.classifyBraking({
      n: 8,
      footComOffsetAtTouchdownLegLengths: { median: 0.22 },
      clearRetractionFraction: 0.1,
      retractionTimeMs: { median: 15 },
      footGroundVelocityMps: { median: 0.9 }
    }, {});
    assert(cls.pattern === PGI.BRAKING_PATTERN.VELOCITY_MISMATCH, 'got ' + cls.pattern);
    assert(/not markedly overextended/i.test(cls.interpretation),
      'interpretation separates position from arrival');
  });

  test('combined braking needs BOTH position and velocity evidence', function () {
    var cls = PGITouchdown.classifyBraking({
      n: 8,
      footComOffsetAtTouchdownLegLengths: { median: 0.48 },
      clearRetractionFraction: 0.05,
      retractionTimeMs: { median: 10 },
      footGroundVelocityMps: { median: 1.1 }
    }, {});
    assert(cls.pattern === PGI.BRAKING_PATTERN.COMBINED_BRAKING, 'got ' + cls.pattern);
  });

  test('well-prepared touchdown: moderate position, clear retraction, low mismatch', function () {
    var cls = PGITouchdown.classifyBraking({
      n: 9,
      footComOffsetAtTouchdownLegLengths: { median: 0.20 },
      clearRetractionFraction: 0.9,
      retractionTimeMs: { median: 105 },
      footGroundVelocityMps: { median: -0.35 }
    }, {});
    assert(cls.pattern === PGI.BRAKING_PATTERN.WELL_PREPARED, 'got ' + cls.pattern);
  });

  test('no pattern is assigned from a single metric', function () {
    var onlyPosition = PGITouchdown.classifyBraking({
      n: 6, footComOffsetAtTouchdownLegLengths: { median: 0.20 }
    }, {});
    assert(onlyPosition.pattern !== PGI.BRAKING_PATTERN.WELL_PREPARED,
      'a good position alone does not earn "well prepared"');
    var nothing = PGITouchdown.classifyBraking({ n: 0 }, {});
    assert(nothing.pattern === PGI.BRAKING_PATTERN.INDETERMINATE, 'no evidence => indeterminate');
  });

  test('every classification carries alternatives and provisional thresholds', function () {
    var cls = PGITouchdown.classifyBraking({
      n: 8, footComOffsetAtTouchdownLegLengths: { median: 0.5 },
      clearRetractionFraction: 0.1, footGroundVelocityMps: { median: 1.0 }
    }, {});
    assert(cls.alternatives.length > 0, 'alternatives listed');
    assert(cls.thresholds.isProvisional === true, 'thresholds marked provisional');
    assert(/not validated/i.test(cls.thresholds.note), 'threshold note says unvalidated');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ground-relative velocity and treadmill handling
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Ground-relative foot velocity');

  test('overground with a fixed camera: ground velocity is zero', function () {
    var g = PGI.footGroundVelocity({ worldFootVelocityMps: 0.6, surfaceType: 'overground' });
    assert(g.availability === 'available', 'available overground');
    assertClose(g.valueMps, 0.6, 1e-9, 'equals the world velocity');
  });

  test('treadmill with a known belt speed: the belt speed is added', function () {
    var g = PGI.footGroundVelocity({
      worldFootVelocityMps: -3.0, surfaceType: 'treadmill', treadmillSpeedMps: 3.0 });
    assert(g.availability === 'available', 'available');
    assertClose(g.valueMps, 0, 1e-9, 'a foot matching belt speed reads zero mismatch');
  });

  test('treadmill without a belt speed: unavailable, never fabricated', function () {
    var g = PGI.footGroundVelocity({ worldFootVelocityMps: -3.0, surfaceType: 'treadmill' });
    assert(g.availability === 'unavailable', 'unavailable');
    assert(g.reason === 'treadmill_speed_unknown', 'reason names the belt speed');
    assert(g.valueMps === null, 'value is null, not zero');
  });

  test('an unknown treadmill speed raises its quality flag and keeps COM-relative metrics', function () {
    var r = analyze({}, { surfaceType: 'treadmill', treadmillSpeedMps: null });
    assert(r.quality.flags.indexOf('treadmill_speed_unknown') !== -1, 'flag raised');
    var L = r.touchdownPreparation.left;
    assert(isNum(L.aggregate.footVelocityRelativeToComLegLengthsPerS.median),
      'COM-relative velocity still reported');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Direction, mirroring, calibration, speed
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Direction and mirroring');

  test('right-to-left running produces the same mechanics as left-to-right', function () {
    var ltr = analyze({ dirSign: 1 });
    var rtl = analyze({ dirSign: -1 });
    assertClose(rtl.strideTiming.overall.contactSeconds.median,
                ltr.strideTiming.overall.contactSeconds.median, 0.02, 'GCT matches');
    assertClose(rtl.touchdownPreparation.left.aggregate.footComOffsetAtTouchdownLegLengths.median,
                ltr.touchdownPreparation.left.aggregate.footComOffsetAtTouchdownLegLengths.median,
                0.04, 'foot offset sign-normalised');
    assert(rtl.video.runningDirection === 'right_to_left', 'direction detected');
  });

  test('mirrored footage is flagged when direction comes from body facing alone', function () {
    // No translation across the frame => direction falls back to facing.
    var samples = clip({ velocityPxPerSec: 0 });
    var dir = KFO.inferRunningDirection(samples);
    if (dir.source === 'body_facing') {
      assert(dir.mirroredSuspected === true, 'mirroring suspected without translation evidence');
    }
  });

  suite('Calibration and speed');

  test('user height gives a calibration; absence of any source gives none', function () {
    var withH = analyze({}, { userHeightMeters: 1.78 });
    assert(withH.video.calibration.source === 'user_height', 'height calibration chosen');
    assert(withH.video.calibration.isMeasured === false, 'never claimed as measured');
  });

  test('no calibration means normalised units only, and a quality flag', function () {
    var r = PGIAnalysis.analyze({
      samples: clip({ velocityPxPerSec: 0 }), videoMetadata: { fps: 60 },
      userHeightMeters: null, surfaceType: 'treadmill'
    });
    if (r.availability === 'available' && r.comTrajectory.availability === 'available') {
      var dec = r.comTrajectory.decomposition.overall;
      if (r.video.calibration.source === 'none') {
        assert(dec.verticalOscillation.medianCentimeters === null, 'no centimetres without a scale');
        assert(isNum(dec.verticalOscillation.medianLegLengths), 'leg lengths still available');
        assert(r.quality.flags.indexOf('no_spatial_calibration') !== -1, 'flag raised');
      }
    }
  });

  test('speed is recovered from translation and tagged with its source', function () {
    var r = analyze({ velocityPxPerSec: 300 }, { userHeightMeters: 1.78 });
    assert(r.video.speedSource === 'estimated_translation', 'source tagged');
    assert(isNum(r.video.speedMps) && r.video.speedMps > 1 && r.video.speedMps < 8, 'plausible speed');
    assert(isNum(r.video.speedConfidence) && r.video.speedConfidence < 0.9,
      'estimated speed is not full confidence');
  });

  test('a user-entered speed wins over the estimate and is confidence-tagged', function () {
    var r = analyze({}, { userSpeedMps: 3.6 });
    assertClose(r.video.speedMps, 3.6, 1e-9, 'user speed used');
    assert(r.video.speedSource === 'user_entered', 'source tagged');
  });

  test('unknown speed withholds stride-outcome judgement rather than guessing', function () {
    var r = PGIAnalysis.analyze({
      samples: clip({ velocityPxPerSec: 0 }), videoMetadata: { fps: 60 },
      userHeightMeters: null, surfaceType: 'treadmill'
    });
    assert(r.domains.strideOutcome.rating === 'unknown', 'rating withheld');
    assert(r.strideOutcome.availability !== 'available' ||
           r.strideOutcome.interpretation.rating === 'unknown', 'no short/long claim');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dense-sample merging (the coordinate-space guard)
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Dense pre-contact sample merging');

  test('dense samples at a different frame width are rescaled before merging', function () {
    var coarse = clip({}).slice(0, 40);
    // Same anatomy at 3x the resolution.
    var dense = coarse.slice(10, 20).map(function (s) {
      return {
        t: s.t + 0.001,
        kps: s.kps.map(function (k) { return { x: k.x * 3, y: k.y * 3, score: k.score }; }),
        scale: s.scale * 3, conf: s.conf, frameWidth: 1200
      };
    });
    var merged = PGITouchdown.mergeDenseSamples(coarse, [{ side: 'left', samples: dense }]);
    assert(merged.denseUsed === true, 'merge accepted after rescaling');
    assertClose(merged.rescaleFactor, 400 / 1200, 1e-9, 'rescale factor');
  });

  test('dense samples that still disagree on body scale are REFUSED, not merged', function () {
    var coarse = clip({}).slice(0, 40);
    // Declares the same frame width but is actually at a different scale: the
    // body-scale check must catch what the width declaration missed.
    var dense = coarse.slice(10, 20).map(function (s) {
      return {
        t: s.t + 0.001,
        kps: s.kps.map(function (k) { return { x: k.x * 2.5, y: k.y * 2.5, score: k.score }; }),
        scale: s.scale * 2.5, conf: s.conf, frameWidth: 400
      };
    });
    var merged = PGITouchdown.mergeDenseSamples(coarse, [{ side: 'left', samples: dense }]);
    assert(merged.denseUsed === false, 'merge refused');
    assert(merged.reason === 'dense_sample_scale_mismatch', 'reason names the mismatch');
    assert(merged.samples.length === coarse.length, 'falls back to the coarse samples');
  });

  test('no dense windows is a normal state, not an error', function () {
    var coarse = clip({}).slice(0, 40);
    var merged = PGITouchdown.mergeDenseSamples(coarse, null);
    assert(merged.denseUsed === false && merged.samples.length === coarse.length, 'coarse used');
    assert(merged.reason === 'no_dense_windows_supplied', 'explicit reason');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Pattern interpretation
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Pattern interpretation');

  function readingsFor(over) { return PGIPatterns.readings(interpretInput(analyze(over))); }
  function interpretInput(r) {
    return {
      touchdown: r.touchdownPreparation,
      timing: { timing: r.strideTiming, verticalSupport: r.verticalProjection.verticalSupport,
                projection: r.verticalProjection, steps: [] },
      com: r.comTrajectory, outcome: r.strideOutcome, quality: r.quality
    };
  }

  test('low projection needs BOTH a long contact and a short flight', function () {
    var only = PGIPatterns.interpret({
      timing: { timing: { overall: { contactSeconds: { median: 0.30 },
                                     flightSeconds: { median: 0.14 },
                                     dutyFactor: { median: 0.68 } } } }
    });
    assert(!only.patterns.some(function (p) { return p.pattern === 'low_projection'; }),
      'a long contact alone does not make low projection');
    var both = PGIPatterns.interpret({
      timing: { timing: { overall: { contactSeconds: { median: 0.30 },
                                     flightSeconds: { median: 0.06 },
                                     dutyFactor: { median: 0.83 } } } }
    });
    assert(both.patterns.some(function (p) { return p.pattern === 'low_projection'; }),
      'long contact + short flight = low projection');
  });

  test('derived timing quantities are labelled as not independent evidence', function () {
    var out = PGIPatterns.interpret({
      timing: { timing: { overall: { contactSeconds: { median: 0.30 },
                                     flightSeconds: { median: 0.06 },
                                     dutyFactor: { median: 0.83 } } } }
    });
    var p = out.patterns.filter(function (x) { return x.pattern === 'low_projection'; })[0];
    var derived = p.supportingMetrics.derivedFromTiming;
    assert(derived, 'derived block present');
    assert(/not independent evidence/i.test(derived.note), 'note states non-independence');
  });

  test('vertical oscillation is never interpreted alone', function () {
    // High oscillation with good contact and flight must NOT be called excessive.
    var out = PGIPatterns.interpret({
      com: { decomposition: { overall: {
              verticalOscillation: { medianLegLengths: 0.13 },
              stanceCompression: { medianLegLengths: 0.05 },
              stanceRebound: { medianLegLengths: 0.05 },
              aerialRiseMeasured: { medianLegLengths: 0.08 } } },
             velocity: { overall: {} } },
      timing: { timing: { overall: { contactSeconds: { median: 0.21 },
                                     flightSeconds: { median: 0.14 },
                                     dutyFactor: { median: 0.60 } } } }
    });
    assert(!out.patterns.some(function (p) {
      return p.pattern === 'excessive_vertical_excursion'; }),
      'high VO with good flight is not called excessive');
  });

  test('high oscillation that does not buy flight IS flagged as excessive', function () {
    var out = PGIPatterns.interpret({
      com: { decomposition: { overall: {
              verticalOscillation: { medianLegLengths: 0.13 },
              stanceCompression: { medianLegLengths: 0.09 },
              stanceRebound: { medianLegLengths: 0.03 },
              aerialRiseMeasured: { medianLegLengths: 0.02 } } },
             velocity: { overall: {} } },
      timing: { timing: { overall: { contactSeconds: { median: 0.30 },
                                     flightSeconds: { median: 0.06 },
                                     dutyFactor: { median: 0.83 } } } }
    });
    assert(out.patterns.some(function (p) {
      return p.pattern === 'excessive_vertical_excursion'; }), 'flagged');
  });

  test('the oscillation composition pattern names which component dominates', function () {
    var out = PGIPatterns.interpret({
      com: { decomposition: { overall: {
              verticalOscillation: { medianLegLengths: 0.10 },
              stanceCompression: { medianLegLengths: 0.08 },
              stanceRebound: { medianLegLengths: 0.07 },
              aerialRiseMeasured: { medianLegLengths: 0.015 } } },
             velocity: { overall: {} } }
    });
    var p = out.patterns.filter(function (x) {
      return x.pattern === 'vertical_oscillation_composition'; })[0];
    assert(p, 'composition pattern emitted');
    assert(/stance motion/i.test(p.interpretation), 'names stance motion as dominant');
    assert(/neither is good or bad/i.test(p.interpretation), 'refuses to rank');
  });

  test('every pattern carries observations, alternatives and a confidence', function () {
    var r = analyze({});
    assert(r.patterns.length > 0, 'patterns emitted');
    r.patterns.forEach(function (p) {
      assert(p.observations && p.observations.length > 0, p.pattern + ' has observations');
      assert(p.alternatives && p.alternatives.length > 0, p.pattern + ' has alternatives');
      assert(isNum(p.confidence) && p.confidence > 0 && p.confidence <= 1, p.pattern + ' confidence');
      assert(p.isValidated === false, p.pattern + ' not marked validated');
    });
  });

  test('speed being unknown lowers pattern confidence', function () {
    function conf(input) {
      var out = PGIPatterns.interpret(input);
      var p = out.patterns.filter(function (x) { return x.pattern === 'low_projection'; })[0];
      return p ? p.confidence : null;
    }
    var timing = { timing: { overall: { contactSeconds: { median: 0.30 },
                                        flightSeconds: { median: 0.06 },
                                        dutyFactor: { median: 0.83 } } } };
    var unknown = conf({ timing: timing });
    var known = conf({ timing: timing, outcome: { speedMps: 3.2 } });
    assertGt(known, unknown, 'known speed yields higher confidence');
  });

  suite('Domain summary');

  test('six domains are reported and none is a combined score', function () {
    var r = analyze({});
    ['touchdownPreparation', 'brakingIndicators', 'verticalProjection', 'reboundTiming',
     'strideOutcome', 'dataConfidence'].forEach(function (k) {
      assert(r.domains[k] && typeof r.domains[k].rating === 'string', k + ' rated');
    });
    assert(!('overall' in r.domains) && !('score' in r.domains), 'no overall score field');
    assert(/no combined efficiency score/i.test(r.domains.note), 'note says so explicitly');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Pre/post comparison — the headline requirement
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Condition comparison');

  function deltaOf(a, b) {
    return { absolute: b - a, percent: a !== 0 ? (b - a) / Math.abs(a) * 100 : null,
             baseline: a, exceedsVariability: true };
  }

  test('THE BEFORE/AFTER CASE: VO up, GCT down, flight up, stride up reads as productive', function () {
    var out = PGIPatterns.interpretComparison({
      verticalOscillationLegLengths: deltaOf(0.073, 0.087),   // 6.6cm -> 7.9cm
      gctSeconds: deltaOf(0.238, 0.233),                       // -5 ms
      flightSeconds: deltaOf(0.095, 0.112),
      stepLengthMeters: deltaOf(1.02, 1.09),
      cadenceSpm: deltaOf(184, 178),                           // -6 spm
      dutyFactor: deltaOf(0.715, 0.675),
      stanceCompressionLegLengths: deltaOf(0.070, 0.068),
      retractionTimeMs: deltaOf(52, 74),
      clearRetractionFraction: deltaOf(0.4, 0.8)
    }, { speedComparable: true });
    var names = out.patterns.map(function (p) { return p.pattern; });
    assert(names.indexOf('productive_projection') !== -1,
      'productive projection identified, got: ' + names.join(', '));
    assert(names.indexOf('unproductive_vertical_excursion') === -1,
      'must NOT also call it unproductive');
    var p = out.patterns[0];
    assert(/rather than simply increasing bounce/i.test(p.interpretation),
      'interpretation states the distinction');
  });

  test('the inverse case reads as unproductive vertical excursion', function () {
    var out = PGIPatterns.interpretComparison({
      verticalOscillationLegLengths: deltaOf(0.073, 0.092),
      gctSeconds: deltaOf(0.238, 0.252),
      flightSeconds: deltaOf(0.100, 0.100),
      stepLengthMeters: deltaOf(1.02, 1.02),
      stanceCompressionLegLengths: deltaOf(0.068, 0.081)
    }, { speedComparable: true });
    var names = out.patterns.map(function (p) { return p.pattern; });
    assert(names.indexOf('unproductive_vertical_excursion') !== -1, 'flagged unproductive');
    assert(names.indexOf('productive_projection') === -1, 'not called productive');
  });

  test('a naive "lower VO is better" rule would prefer the PRE condition — this one does not', function () {
    // Same numbers as the before/after case. The PRE condition has LOWER
    // vertical oscillation, so any rule scoring VO downward alone would rank it
    // higher. The engine must instead describe the POST condition's excursion as
    // productive.
    var out = PGIPatterns.interpretComparison({
      verticalOscillationLegLengths: deltaOf(0.073, 0.087),
      gctSeconds: deltaOf(0.238, 0.233),
      flightSeconds: deltaOf(0.095, 0.112),
      stepLengthMeters: deltaOf(1.02, 1.09),
      cadenceSpm: deltaOf(184, 178)
    }, { speedComparable: true });
    assert(out.directions.verticalOscillation === 'increased', 'VO increased');
    assert(out.patterns.some(function (p) {
      return p.pattern === 'productive_projection'; }), 'increase read as productive');
    var joined = out.patterns.map(function (p) { return p.interpretation; }).join(' ');
    assert(!/excessive|too much|reduce/i.test(joined), 'no language penalising the increase');
  });

  test('improved touchdown preparation is detected from retraction changes', function () {
    var out = PGIPatterns.interpretComparison({
      retractionTimeMs: deltaOf(40, 85),
      clearRetractionFraction: deltaOf(0.3, 0.9),
      footGroundVelocityMps: deltaOf(0.8, 0.2)
    }, { speedComparable: true });
    assert(out.patterns.some(function (p) {
      return p.pattern === 'improved_touchdown_preparation'; }), 'detected');
  });

  test('a change inside stride-to-stride variability is reported as unchanged', function () {
    var d = { absolute: 0.002, percent: 0.9, baseline: 0.235, exceedsVariability: false };
    assert(PGIPatterns.direction(d, 0.02) === 'unchanged', 'noise-level change is unchanged');
  });

  test('the CI-overlap test drives the variability verdict', function () {
    var overlapping = PGICompare.exceedsVariability(
      { value: 0.235, ci95: [0.225, 0.245], sd: 0.01, n: 8 },
      { value: 0.240, ci95: [0.230, 0.250], sd: 0.01, n: 8 });
    assert(overlapping === false, 'overlapping intervals => not a real change');
    var separated = PGICompare.exceedsVariability(
      { value: 0.200, ci95: [0.195, 0.205], sd: 0.005, n: 8 },
      { value: 0.260, ci95: [0.255, 0.265], sd: 0.005, n: 8 });
    assert(separated === true, 'separated intervals => real change');
  });

  test('differing speeds produce a prominent warning and reduced confidence', function () {
    var a = analyze({}, { userSpeedMps: 3.0 });
    var b = analyze({}, { userSpeedMps: 4.2 });
    var cmp = PGICompare.compare({ result: a, label: 'Pre' }, { result: b, label: 'Post' });
    assert(cmp.speed.comparable === false, 'flagged as not comparable');
    assert(/different speeds/i.test(cmp.speed.warning), 'warning text present');
    assert(cmp.speed.severity === 'warning', 'severity is a warning, not a note');
    var html = PGIRender.comparisonHtml(cmp);
    assert(/Speeds differed/.test(html), 'warning is rendered, not hidden');
  });

  test('matched speeds compare without the mismatch warning', function () {
    var a = analyze({}, { userSpeedMps: 3.5 });
    var b = analyze({}, { userSpeedMps: 3.55 });
    var cmp = PGICompare.compare({ result: a, label: 'Pre' }, { result: b, label: 'Post' });
    assert(cmp.speed.comparable === true, 'comparable');
    assert(cmp.speed.warning === null, 'no warning');
  });

  test('unknown speed in one condition is called out rather than assumed', function () {
    var a = analyze({}, { userSpeedMps: 3.5 });
    var b = PGIAnalysis.analyze({
      samples: clip({ velocityPxPerSec: 0 }), videoMetadata: { fps: 60 }, surfaceType: 'treadmill' });
    var cmp = PGICompare.compare({ result: a, label: 'Pre' }, { result: b, label: 'Post' });
    assert(cmp.speed.comparable === null, 'comparability unknown');
    assert(/unknown/i.test(cmp.speed.warning), 'warning names the unknown speed');
  });

  test('a legacy analysis cannot be compared against a PGI analysis', function () {
    var a = analyze({});
    var cmp = PGICompare.compare(
      { result: { analysisType: 'kinematic_force_orientation' }, label: 'Old' },
      { result: a, label: 'New' });
    assert(cmp.availability === 'unavailable', 'refused');
    assert(/must_be_projection_ground_interaction/.test(cmp.reason), 'reason is explicit');
  });

  test('the comparison ranks neither condition', function () {
    var a = analyze({}, { userSpeedMps: 3.5 });
    var b = analyze({ flightSeconds: 0.15 }, { userSpeedMps: 3.5 });
    var cmp = PGICompare.compare({ result: a, label: 'Pre' }, { result: b, label: 'Post' });
    assert(/Neither condition is ranked/i.test(cmp.note), 'explicitly refuses to rank');
    var html = PGIRender.comparisonHtml(cmp);
    // "better" may appear only inside a denial, e.g. "Neither condition is
    // ranked as better".
    assertOnlyInDenial(html, /\bbetter\b/, 'ranking language');
    assert(!/\bworse\b|\bwinner\b|\boverall score\b/i.test(html), 'no verdict vocabulary');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Runner-type fixtures (Phase 28 cases)
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Runner-type fixtures');

  test('ground-bound runner: long contact, short flight, low projection domain', function () {
    // Duty factor 0.73 -- ground-bound but still inside the accepted running
    // range, so the steps are not rejected before the pattern can be read.
    var r = analyze({ stanceSeconds: 0.275, flightSeconds: 0.100 });
    assertLt(r.strideTiming.overall.dutyFactor.median, 0.75, 'fixture stays inside the running range');
    assert(r.domains.verticalProjection.rating === 'low',
      'projection rated low, got ' + r.domains.verticalProjection.rating);
    assert(r.patterns.some(function (p) { return p.pattern === 'low_projection'; }),
      'low projection pattern fires');
  });

  test('a duty factor above the running range is refused rather than described', function () {
    var r = analyze({ stanceSeconds: 0.30, flightSeconds: 0.055 });   // DF 0.845
    assert(r.strideTiming.availability !== 'available' || r.strideTiming.stepsAnalyzed === 0,
      'steps rejected as outside the running range');
    assert(r.domains.verticalProjection.rating === 'unknown',
      'no projection claim made from rejected steps');
  });

  test('floating runner: short contact, long flight, strong projection domain', function () {
    var r = analyze({ stanceSeconds: 0.20, flightSeconds: 0.155 });
    assert(r.domains.verticalProjection.rating === 'strong',
      'projection rated strong, got ' + r.domains.verticalProjection.rating);
  });

  test('rushed touchdown fixture: no retraction, braking indicators not "low"', function () {
    var r = analyze({ retractMs: 0, reachAheadPx: 34, footAheadPx: 34 });
    assert(r.domains.brakingIndicators.rating !== 'low',
      'braking not called low when the foot never retracts');
  });

  test('asymmetric fixture: the two sides differ and the difference is reported', function () {
    var r = analyze({ asymmetric: true });
    var asym = r.touchdownPreparation.asymmetry;
    assert(asym.available === true, 'asymmetry computed');
    assert(isNum(asym.footComOffsetDifferenceLegLengths), 'offset difference numeric');
    assert(Math.abs(asym.footComOffsetDifferenceLegLengths) > 0.02,
      'the modelled asymmetry is detected');
  });

  test('occluded ankle frames reduce quality without crashing', function () {
    var r = analyze({ occludeEvery: 4 });
    assert(r.availability !== undefined, 'analysis completes');
    assert(Array.isArray(r.quality.flags), 'flags present');
  });

  test('low frame rate degrades gracefully and says why', function () {
    var r = analyze({ sampleRateHz: 12, durationSeconds: 4 });
    assert(r.availability !== undefined, 'completes');
    var flagged = r.quality.flags.indexOf('velocity_sampling_insufficient') !== -1 ||
                  r.quality.flags.indexOf('low_frame_rate') !== -1;
    assert(flagged, 'a frame-rate flag is raised');
  });

  test('walking (no flight) is refused rather than analysed as running', function () {
    var samples = makeClip({
      sampleRateHz: 60, durationSeconds: 3, stanceSeconds: 0.62, flightSeconds: 0.0001,
      velocityPxPerSec: 120, dirSign: 1, comDropPx: 6, footAheadPx: 20,
      reachAheadPx: 30, retractMs: 60
    });
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 } });
    var st = r.strideTiming;
    assert(st.availability !== 'available' || st.stepsAnalyzed === 0 ||
           (st.gaitValidity && st.gaitValidity.isRunning === false),
      'no running timing reported for a walking clip');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Minimum-COM detection (four-phase model)
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Minimum COM detection');

  /** Synthetic smoothed-series points with analytic derivatives. */
  function comPoints(fn, t0, t1, n) {
    var pts = [], dt = (t1 - t0) / (n - 1), h = 1e-4;
    for (var i = 0; i < n; i++) {
      var t = t0 + i * dt;
      pts.push({ t: t, value: fn(t), d1: (fn(t + h) - fn(t - h)) / (2 * h) });
    }
    return pts;
  }

  test('a clean parabolic minimum is located at its true time with high confidence', function () {
    var pts = comPoints(function (t) { return 100 + 300 * Math.pow(t - 0.12, 2); }, 0, 0.24, 25);
    var det = PGICom.detectMinimumCom(pts, 0, 0.24);
    assert(det.available, 'detected');
    assertClose(det.stancePercent, 50, 8, 'minimum near mid-stance');
    assert(det.detectionMethod === 'smoothed_com_extremum', 'sharp extremum method');
    assert(det.window === null, 'no flat window on a sharp minimum');
    assertGt(det.confidence, 0.7, 'high confidence');
  });

  test('image-Y-down coordinates: the visually lowest COM is the detected minimum', function () {
    // Raw samples whose hip moves DOWN the image (y increases) to mid-interval.
    // buildComSeries owns the up-positive normalization (h = −y), so the
    // detector must find the minimum where image y is LARGEST.
    var samples = [];
    for (var i = 0; i <= 24; i++) {
      var t = i * 0.02, u = i / 24;
      var hipY = (GROUND_Y - HIP_ABOVE_GROUND) + 14 * Math.sin(Math.PI * u);
      samples.push({
        t: t,
        kps: frame({ bodyX: 300, hipY: hipY, dirSign: 1,
                     lAnkleX: 290, lAnkleY: GROUND_Y, rAnkleX: 310, rAnkleY: GROUND_Y - 30 })
      });
    }
    var series = PGICom.buildComSeries(samples);
    var det = PGICom.detectMinimumCom(series.smoothed, 0.06, 0.42);
    assert(det.available, 'detected');
    // Largest image y (visually lowest) is at t = 0.24, the middle of the dip.
    assertClose(det.t, 0.24, 0.05, 'minimum where the body is visually lowest');
  });

  test('a broad flat minimum yields a region whose centre is chosen, at lower confidence', function () {
    function f(t) {
      var d = Math.abs(t - 0.12);
      return d <= 0.055 ? 100 : 100 + 6000 * Math.pow(d - 0.055, 2);
    }
    var flat = PGICom.detectMinimumCom(comPoints(f, 0, 0.24, 33), 0, 0.24);
    assert(flat.available, 'detected');
    assert(flat.window, 'flat region reported as a window');
    assertGt(flat.flatWidthPercent, 15, 'region width recognised');
    assert(flat.detectionMethod === 'smoothed_com_flat_region_center', 'centre-of-region method');
    assertClose(flat.stancePercent, 50, 12, 'centre lands near the true middle');
    assert(flat.flags.indexOf('minimum_com_flat_region') !== -1, 'flat flag raised');
    var sharp = PGICom.detectMinimumCom(
      comPoints(function (t) { return 100 + 300 * Math.pow(t - 0.12, 2); }, 0, 0.24, 33), 0, 0.24);
    assertGt(sharp.confidence, flat.confidence, 'flat minimum is less certain than a sharp one');
  });

  test('multiple comparable local minima are flagged', function () {
    // Two equal dips at 25% and 75% of stance.
    var pts = comPoints(function (t) {
      return 102 - 2 * Math.cos(2 * Math.PI * (t - 0.06) / 0.12);
    }, 0, 0.24, 33);
    var det = PGICom.detectMinimumCom(pts, 0, 0.24);
    assert(det.available, 'detected');
    assertGt(det.localMinimaCount, 1, 'both dips counted');
    assert(det.flags.indexOf('minimum_com_multiple_local_extrema') !== -1, 'flagged');
  });

  test('a minimum at the stance edge is flagged rather than trusted', function () {
    var pts = comPoints(function (t) { return 100 + 60 * t; }, 0, 0.24, 25);
    var det = PGICom.detectMinimumCom(pts, 0, 0.24);
    assert(det.available, 'detected');
    assert(det.flags.indexOf('minimum_com_near_touchdown') !== -1, 'near-touchdown flag');
    assertLt(det.confidence, 0.65, 'confidence reduced');
  });

  test('a noisy trajectory raises the noise flag', function () {
    var pts = comPoints(function (t) {
      return 100 + 300 * Math.pow(t - 0.12, 2) + 0.6 * Math.sin(40 * Math.PI * t);
    }, 0, 0.24, 49);
    var det = PGICom.detectMinimumCom(pts, 0, 0.24);
    assert(det.available, 'detected');
    assert(det.flags.indexOf('com_trajectory_noisy') !== -1, 'noise flag raised');
  });

  test('a non-zero vertical velocity at the detected minimum is flagged as inconsistent', function () {
    // Heights form a parabola, but the (fabricated) fitted velocity never
    // passes near zero — the minimum and the derivative disagree.
    var pts = comPoints(function (t) { return 100 + 300 * Math.pow(t - 0.12, 2); }, 0, 0.24, 25)
      .map(function (p) { return { t: p.t, value: p.value, d1: -60 }; });
    var det = PGICom.detectMinimumCom(pts, 0, 0.24);
    assert(det.available, 'detected');
    assert(det.flags.indexOf('minimum_com_velocity_inconsistent') !== -1, 'velocity check fired');
  });

  test('the pipeline reports minimum COM per side with a reliability verdict', function () {
    var r = analyze({});
    var mc = r.minimumCom;
    assert(mc.availability === 'available', 'block available');
    assert(isNum(mc.overall.stancePercent.median), 'stance percent aggregated');
    assertGt(mc.overall.stancePercent.median, 20, 'minimum not at touchdown');
    assertLt(mc.overall.stancePercent.median, 85, 'minimum not at toe-off');
    assertGt(mc.overall.confidence.median, 0.5, 'confident on the clean fixture');
    assert(mc.reliability && mc.reliability.unreliable === false, 'reliable');
    assert(mc.left.n > 0 && mc.right.n > 0, 'both sides represented');
  });

  test('a skewed COM trajectory moves the detected minimum in the modelled direction', function () {
    var early = analyze({ minComSkew: 0.6 });
    var late = analyze({ minComSkew: 1.6 });
    assertGt(late.minimumCom.overall.stancePercent.median,
             early.minimumCom.overall.stancePercent.median + 5,
             'later-skewed fixture detects a later minimum');
  });

  test('a flat-bottomed COM trajectory is reported as a flat region in the pipeline', function () {
    // A deep clipped-bottom trajectory: smoothing rounds shallow plateaus away,
    // so the fixture uses a pronounced one.
    var r = analyze({ flatMinimum: true, comDropPx: 20 });
    var mc = r.minimumCom;
    assert(mc.availability === 'available', 'block available');
    var flagged = (mc.overall.flagCounts && mc.overall.flagCounts.minimum_com_flat_region > 0) ||
                  (isNum(mc.overall.flatWidthPercent.median) && mc.overall.flatWidthPercent.median >= 15);
    assert(flagged, 'flat region surfaced');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loading/compression and rebound/projection phases
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Loading and rebound phases');

  test('per step, loading + rebound exactly partition stance and the identities hold', function () {
    var r = analyze({});
    var steps = r.comTrajectory.stepResults.filter(function (s) { return s.valid; });
    assertGt(steps.length, 3, 'steps analysed');
    steps.forEach(function (s) {
      assertClose(s.loading.durationSeconds + s.reboundPhase.durationSeconds,
                  s.contactSeconds, 1e-9, 'durations partition GCT');
      assertClose(s.loading.fractionOfStance + s.reboundPhase.fractionOfStance, 1, 1e-9,
        'fractions sum to one');
      if (s.reboundPhase.durationSeconds > 0) {
        assertClose(s.reboundPhase.meanRiseVelocityPxPerS,
                    s.reboundPhase.risePx / s.reboundPhase.durationSeconds, 1e-9,
                    'mean rebound velocity is rise over time');
        assertClose(s.reboundPhase.compressionToReboundRatio,
                    s.loading.durationSeconds / s.reboundPhase.durationSeconds, 1e-9,
                    'compression:rebound ratio identity');
      }
    });
  });

  test('the envelope carries both phase blocks with durations that partition contact', function () {
    var r = analyze({});
    var lc = r.loadingCompression, rp = r.reboundProjection;
    assert(lc.availability === 'available' && rp.availability === 'available', 'both available');
    var gctMs = r.strideTiming.overall.contactSeconds.median * 1000;
    assertClose(lc.overall.durationMs.median + rp.overall.durationMs.median, gctMs, gctMs * 0.15,
      'phase medians approximately partition contact time');
    assertGt(rp.overall.comRise.medianLegLengths, 0, 'rebound rise positive');
    assertGt(lc.overall.compression.medianLegLengths, 0, 'compression positive');
  });

  test('a deeper modelled collapse increases the loading compression depth', function () {
    var shallow = analyze({ comDropPx: 5 });
    var deep = analyze({ comDropPx: 20 });
    assertGt(deep.loadingCompression.overall.compression.medianLegLengths,
             shallow.loadingCompression.overall.compression.medianLegLengths,
             'compression follows the model');
  });

  test('COM horizontal travel is forward-positive in both phases on an overground clip', function () {
    var r = analyze({});
    assertGt(r.loadingCompression.overall.horizontalTravel.px.median, 0, 'loading travel forward');
    assertGt(r.reboundProjection.overall.horizontalTravel.px.median, 0, 'rebound travel forward');
  });

  test('asymmetric compression is reported side-specifically and in the symmetry block', function () {
    var r = analyze({ comDropPx: 14, comDropRightPx: 5 });
    var lc = r.loadingCompression;
    assertGt(lc.left.compression.medianLegLengths, lc.right.compression.medianLegLengths,
      'left compresses more, as modelled');
    var sp = r.symmetry.stancePhases;
    assert(sp, 'stance-phase symmetry present');
    assertGt(sp.compressionDepthDifferenceLegLengths, 0.02, 'difference surfaced');
  });

  test('asymmetric rebound timing is reported as a duration difference', function () {
    var r = analyze({ minComSkewRight: 1.8 });
    var sp = r.symmetry.stancePhases;
    assert(sp, 'stance-phase symmetry present');
    // The right minimum arrives later, so the right rebound is SHORTER.
    assertGt(sp.reboundDurationDifferenceMs, 8, 'left rebound longer than right');
    assert(isNum(sp.reboundDurationRelativeDifference), 'relative difference for descriptive copy');
  });

  test('hip and knee changes are summarized for both phases; ankle and pelvis are refused', function () {
    var r = analyze({});
    var jc = r.reboundProjection.overall.jointChanges;
    ['hip', 'knee', 'trunk', 'shank'].forEach(function (k) {
      assert(isNum(jc[k].angleAtStartDegrees.median), k + ' angle at minimum COM');
      assert(isNum(jc[k].angleAtEndDegrees.median), k + ' angle at toe-off');
      assert(isNum(jc[k].changeDegrees.median), k + ' change');
    });
    assert(jc.ankle.availability === 'unavailable' &&
           jc.ankle.reason === 'requires_foot_landmark',
      'ankle plantarflexion refused: no foot landmark exists');
    assert(jc.pelvis.availability === 'unavailable', 'pelvis orientation refused');
    var lj = r.loadingCompression.overall.jointChanges;
    assert(isNum(lj.knee.changeDegrees.median), 'loading knee change');
  });

  test('joint angular velocities are refused below the frame-rate floor', function () {
    var r = analyze({});
    var lowRate = PGIPhases.analyze({
      samples: clip({}),
      com: r.comTrajectory,
      timing: { timing: { overall: r.strideTiming.overall } },
      directionSign: 1,
      legLengthPx: r.video.legLengthPx,
      calibration: r.video.calibration,
      effectiveSampleRateHz: 12
    });
    var hip = lowRate.reboundProjection.overall.jointChanges.hip;
    assert(hip.meanAngularVelocityDegPerS === null, 'no velocity fabricated at 12 Hz');
    assert(hip.velocityAvailability.reason === 'video_frame_rate_insufficient', 'reason stated');
    var okRate = r.reboundProjection.overall.jointChanges.hip;
    assert(okRate.meanAngularVelocityDegPerS && isNum(okRate.meanAngularVelocityDegPerS.median),
      'velocity available at 60 Hz');
  });

  test('toe-off velocity carries both estimates, cross-checked and never averaged', function () {
    var r = analyze({});
    var vto = r.reboundProjection.overall.verticalVelocityAtToeoff;
    var flightMed = r.strideTiming.overall.flightSeconds.median;
    assertClose(vto.ballisticFromFlightMps.median, 9.80665 * flightMed / 2, 0.08,
      'ballistic estimate is g·t_flight/2');
    assert(vto.poseDerived && isNum(vto.poseDerived.medianMps), 'pose-derived estimate exposed');
    assert(isNum(vto.agreement.medianRelativeError), 'agreement quantified');
    assert(vto.preferredSource === 'ballistic_flight_time', 'flight-derived leads');
  });

  test('the acceleration proxy is withheld when the COM velocity fails its cross-check', function () {
    var r = analyze({});
    var vto = r.reboundProjection.overall.verticalVelocityAtToeoff;
    var accel = r.reboundProjection.overall.meanVerticalAccelerationProxy;
    if (isNum(vto.agreement.medianRelativeError) && vto.agreement.medianRelativeError > 0.35) {
      assert(accel.availability === 'unavailable', 'proxy withheld');
      assert(accel.reason === 'com_velocity_quality_insufficient', 'reason names the gate');
    } else {
      assert(accel.pxPerS2, 'proxy available when the cross-check passes');
    }
  });

  test('the outcome chain runs from minimum COM to stride length in order', function () {
    var r = analyze({}, { userSpeedMps: 3.5 });
    var chain = r.reboundProjection.outcomeChain;
    assert(chain.sequence[0] === 'minimum_com', 'starts at minimum COM');
    assert(chain.sequence[chain.sequence.length - 1] === 'stride_length', 'ends at stride length');
    assert(isNum(chain.reboundDurationMs), 'rebound duration in the chain');
    assert(isNum(chain.verticalVelocityAtToeoffMps), 'take-off velocity in the chain');
    assert(isNum(chain.flightSeconds), 'flight in the chain');
    assert(isNum(chain.strideLengthMeters), 'stride length in the chain');
    assert(/not a full causal chain/i.test(chain.note), 'causality disclaimer');
  });

  test('the movement summary is descriptive and never grades the rebound', function () {
    var r = analyze({}, { userSpeedMps: 3.5 });
    var ms = r.reboundProjection.movementSummary;
    assert(ms.availability === 'available', 'summary produced');
    assert(/From minimum COM/.test(ms.text), 'anchored at minimum COM');
    assert(/toe-off/.test(ms.text), 'runs to toe-off');
    assert(!/excellent|poor|optimal|ideal/i.test(ms.text + ' ' + (ms.patternNote || '')),
      'no grading vocabulary');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Stance-organization patterns (four-phase model)
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Stance organization patterns');

  function hasPattern(r, name) {
    return r.patterns.some(function (p) { return p.pattern === name; });
  }

  test('deep compression with a strong rebound and useful flight reads as that combination', function () {
    var r = analyze({ comDropPx: 9 });
    assert(hasPattern(r, 'high_compression_strong_rebound'),
      'pattern fires on the compliant fixture: ' +
      r.patterns.map(function (p) { return p.pattern; }).join(', '));
    var p = r.patterns.filter(function (x) { return x.pattern === 'high_compression_strong_rebound'; })[0];
    assert(/neither is ranked/i.test(p.interpretation), 'refuses to rank strategies');
  });

  test('a short rebound with contained compression and real flight reads as rapid rebound', function () {
    var r = analyze({ stanceSeconds: 0.20, flightSeconds: 0.14, comDropPx: 5, stanceEndDropPx: -3 });
    assert(hasPattern(r, 'rapid_rebound'),
      'got: ' + r.patterns.map(function (p) { return p.pattern; }).join(', '));
  });

  test('a long rebound with limited flight reads as slow rebound', function () {
    var r = analyze({ stanceSeconds: 0.29, flightSeconds: 0.10, comDropPx: 9, minComSkew: 0.6 });
    assert(hasPattern(r, 'slow_rebound'),
      'got: ' + r.patterns.map(function (p) { return p.pattern; }).join(', '));
  });

  test('minimal compression with a quick reversal reads as the stiff strategy', function () {
    var r = analyze({ stanceSeconds: 0.20, flightSeconds: 0.13, comDropPx: 2.5 });
    assert(hasPattern(r, 'low_compression_rapid_rebound'),
      'got: ' + r.patterns.map(function (p) { return p.pattern; }).join(', '));
  });

  test('deep compression that is not recovered reads as high compression / low rebound', function () {
    var r = analyze({ stanceSeconds: 0.25, flightSeconds: 0.09, comDropPx: 10, stanceEndDropPx: 18 });
    assert(hasPattern(r, 'high_compression_low_rebound'),
      'got: ' + r.patterns.map(function (p) { return p.pattern; }).join(', '));
  });

  test('stance-organization patterns are withheld when the minimum is unreliable', function () {
    function phasesFixture(unreliable) {
      return {
        availability: 'available',
        minimumCom: { overall: { stancePercent: { median: 52 } } },
        minimumComReliability: { medianConfidence: unreliable ? 0.3 : 0.9, unreliable: unreliable },
        loadingCompression: { overall: { durationMs: { median: 130 },
                                         fractionOfStance: { median: 0.57 } } },
        reboundProjection: { overall: {
          durationMs: { median: 95 }, fractionOfStance: { median: 0.43 },
          comRise: { medianLegLengths: 0.08 },
          meanComRiseVelocity: { medianLegLengthsPerS: 0.85 },
          compressionToReboundRatio: { median: 1.35 } } }
      };
    }
    var base = {
      timing: { timing: { overall: { contactSeconds: { median: 0.225 },
                                     flightSeconds: { median: 0.14 },
                                     dutyFactor: { median: 0.62 } } } },
      com: { decomposition: { overall: {
              stanceCompression: { medianLegLengths: 0.05 },
              stanceRebound: { medianLegLengths: 0.08 },
              verticalOscillation: { medianLegLengths: 0.09 },
              aerialRiseMeasured: { medianLegLengths: 0.04 } } },
             velocity: { overall: {} } }
    };
    var okInput = { timing: base.timing, com: base.com, phases: phasesFixture(false) };
    var badInput = { timing: base.timing, com: base.com, phases: phasesFixture(true) };
    var ok = PGIPatterns.interpret(okInput);
    var bad = PGIPatterns.interpret(badInput);
    assert(ok.patterns.some(function (p) { return p.pattern === 'rapid_rebound'; }),
      'fires when reliable');
    assert(!bad.patterns.some(function (p) { return p.domain === 'rebound_projection'; }),
      'no stance-organization pattern from an unreliable minimum');
  });

  test('phase durations are declared derived views of the landmark, not extra evidence', function () {
    var r = analyze({ comDropPx: 9 });
    var p = r.patterns.filter(function (x) { return x.domain === 'rebound_projection'; })[0];
    assert(p, 'a stance-organization pattern fired');
    var derived = p.supportingMetrics.derivedFromLandmark;
    assert(derived, 'derived block present');
    assert(/not independent evidence/i.test(derived.note), 'independence stated');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rebound in pre/post comparison
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Rebound comparison');

  test('a faster, larger rebound with more flight is described — and not ranked', function () {
    var out = PGIPatterns.interpretComparison({
      reboundDurationMs: deltaOf(102, 87),
      reboundRiseLegLengths: deltaOf(0.044, 0.056),
      meanReboundVelocityLegLengthsPerS: deltaOf(0.43, 0.64),
      minComStancePercent: deltaOf(52, 49),
      flightSeconds: deltaOf(0.110, 0.126)
    }, { speedComparable: true });
    var p = out.patterns.filter(function (x) { return x.pattern === 'rebound_organization_change'; })[0];
    assert(p, 'rebound comparison pattern fired');
    assert(/faster and larger COM rebound/i.test(p.interpretation), 'describes the change');
    assert(/greater aerial time/i.test(p.interpretation), 'links to the flight outcome');
    assert(/neither condition is ranked/i.test(p.interpretation), 'refuses to rank');
  });

  test('THE BEFORE/AFTER CASE with rebound: the mechanical differences are reported faithfully', function () {
    // AFTER: lower cadence, shorter GCT, more vertical excursion, longer
    // flight, longer stride, faster and larger min-COM → toe-off rebound.
    var a = analyze({ stanceSeconds: 0.245, flightSeconds: 0.105, comDropPx: 8 },
                    { userSpeedMps: 3.5 });
    var b = analyze({ stanceSeconds: 0.225, flightSeconds: 0.145, comDropPx: 11 },
                    { userSpeedMps: 3.5 });
    var cmp = PGICompare.compare({ result: a, label: 'Before' }, { result: b, label: 'After' });
    assertLt(cmp.deltas.gctSeconds.absolute, 0, 'GCT shortened');
    assertGt(cmp.deltas.flightSeconds.absolute, 0, 'flight lengthened');
    assertLt(cmp.deltas.cadenceSpm.absolute, 0, 'cadence dropped');
    assertGt(cmp.deltas.stepLengthMeters.absolute, 0, 'stride lengthened');
    assertGt(cmp.deltas.verticalOscillationLegLengths.absolute, 0, 'excursion grew');
    assert(cmp.deltas.reboundDurationMs.available, 'rebound duration compared');
    assertLt(cmp.deltas.reboundDurationMs.absolute, 0, 'rebound got faster');
    assertGt(cmp.deltas.reboundRiseLegLengths.absolute, 0, 'rebound rise grew');
    assertGt(cmp.groups.reboundProjection.filter(function (d) { return d.available; }).length, 2,
      'rebound group populated');
    var names = cmp.patterns.map(function (p) { return p.pattern; });
    assert(names.indexOf('productive_projection') !== -1,
      'the productive combination is recognised, got: ' + names.join(', '));
    var html = PGIRender.comparisonHtml(cmp);
    assert(html.indexOf('Rebound / projection') !== -1, 'rebound group rendered');
    assertOnlyInDenial(html, /\bbetter\b/, 'ranking language');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Four-phase storage, rendering and copy
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Four-phase storage and rendering');

  test('the stored form persists the phase blocks without per-step joint records', function () {
    var stored = PGIAnalysis.toStoredForm(analyze({}, { userSpeedMps: 3.5 }));
    assert(stored.minimumCom.availability === 'available', 'minimum COM stored');
    assert(isNum(stored.minimumCom.overall.stancePercent.median), 'stance percent stored');
    assert(isNum(stored.loadingCompression.overall.durationMs.median), 'loading duration stored');
    assert(isNum(stored.reboundProjection.overall.comRise.medianLegLengths), 'rebound rise stored');
    assert(stored.reboundProjection.outcomeChain, 'outcome chain stored');
    assert(typeof stored.reboundProjection.movementSummary.text === 'string', 'summary stored verbatim');
    var json = JSON.stringify(stored);
    assert(json.indexOf('stepPhases') === -1, 'per-step joint samples never persisted');
  });

  test('rehydration restores the phase statics: ankle refusal, definitions, chain note', function () {
    var stored = PGIAnalysis.toStoredForm(analyze({}, { userSpeedMps: 3.5 }));
    var re = PGIAnalysis.rehydrateStatic(JSON.parse(JSON.stringify(stored)));
    assert(re.minimumCom.definition &&
           /Not the onset of propulsive force/i.test(re.minimumCom.definition),
      'minimum-COM definition restored with its denial');
    assert(re.loadingCompression.overall.jointChanges.ankle.reason === 'requires_foot_landmark',
      'ankle refusal restored');
    assert(re.reboundProjection.overall.verticalVelocityAtToeoff.preferredSource ===
           'ballistic_flight_time', 'preferred source restored');
    assert(/not a full causal chain/i.test(re.reboundProjection.outcomeChain.note),
      'chain note restored');
  });

  test('a stored analysis renders the timeline and both phase cards', function () {
    var re = PGIAnalysis.rehydrateStatic(
      PGIAnalysis.toStoredForm(analyze({}, { userSpeedMps: 3.5 })));
    var h = PGIRender.buildHtml(re);
    assert(h.indexOf('stride, measured') !== -1, 'measured timeline rendered');
    assert(/Loading<\/div><div[^>]*>\d+ ms/.test(h.replace(/\s+/g, '')) ||
           /Loading[\s\S]{0,120}?\d+ ms/.test(h), 'loading segment carries this runner\u2019s ms');
    assert(h.indexOf('MIN COM') !== -1 || h.indexOf('minimum COM') !== -1, 'minimum COM present');
    assert(h.indexOf('Loading / Compression') !== -1, 'loading card rendered');
    assert(h.indexOf('Rebound / Projection') !== -1, 'rebound card rendered');
    assert(h.indexOf('loading / compression') !== -1, 'trajectory shading labelled');
  });

  test('an old (pre-four-phase) stored document still renders, with the phase cards unavailable', function () {
    var stored = PGIAnalysis.toStoredForm(analyze({}, { userSpeedMps: 3.5 }));
    delete stored.minimumCom; delete stored.loadingCompression; delete stored.reboundProjection;
    stored.schemaVersion = 3;
    var re = PGIAnalysis.rehydrateStatic(JSON.parse(JSON.stringify(stored)));
    var h = PGIRender.buildHtml(re);
    assertGt(h.length, 2000, 'renders substantively');
    assert(h.indexOf('NaN') === -1 && h.indexOf('undefined') === -1, 'clean render');
    assert(/Loading \/ Compression/.test(h), 'loading card present as unavailable');
  });

  test('minimum COM is never described as the onset of propulsion', function () {
    var h = PGIRender.buildHtml(analyze({}, { userSpeedMps: 3.5 }));
    assert(/not the onset of propulsive force|not the point where force production begins|not the start of force production/i.test(h),
      'the denial is stated');
    assertOnlyInDenial(h, /onset of propulsive force/, 'propulsion-onset language');
    assertOnlyInDenial(h, /force production/, 'force-production language');
    assert(!/propulsive phase/i.test(h), 'the rebound phase is never named "propulsive phase"');
  });

  test('mean rebound velocity is labelled as motion, not force', function () {
    var h = PGIRender.buildHtml(analyze({}, { userSpeedMps: 3.5 }));
    assert(/Mean rebound velocity/i.test(h), 'metric shown');
    assert(/mean COM rise velocity/i.test(h), 'described as a COM rise velocity');
    assert(/motion, not force/i.test(h), 'denial adjacent to the metric');
  });

  test('the research export carries the minimum-COM and phase columns', function () {
    var samples = clip({});
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                  userHeightMeters: 1.78, surfaceType: 'overground',
                                  userSpeedMps: 3.5 });
    var b = PGIExport.buildExport(r, samples, { analysisId: 'P1' });
    ['minimumComStancePercent', 'minimumComConfidence', 'compressionDurationMs',
     'reboundDurationMs', 'reboundFraction', 'meanReboundVelocityMps',
     'vyToeoffPoseMps', 'vyToeoffBallisticMps', 'toeoffVelocityAgreementRelError',
     'hipAngleDeltaReboundDegrees', 'supportAngleMinComDegrees'].forEach(function (col) {
      assert(PGIExport.STRIDE_COLUMNS.indexOf(col) !== -1, col + ' declared');
      assert(b.strideLevel.some(function (row) { return isNum(row[col]); }),
        col + ' populated on at least one stride');
    });
    b.strideLevel.forEach(function (row) {
      assert(row.ankleAngleMinComDegrees === '' && row.ankleAngleDeltaReboundDegrees === '',
        'ankle columns stay empty — no foot landmark exists');
    });
    assert(/NOT the onset of propulsive force/i.test(b.conventions.minimumCom),
      'export conventions carry the denial');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Stride outcome and arms
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Stride outcome');

  test('step length follows speed x step time, and flight distance from flight time', function () {
    var r = analyze({}, { userSpeedMps: 3.5 });
    var so = r.strideOutcome;
    assert(so.availability === 'available', 'available');
    var stepT = r.strideTiming.overall.stepSeconds.median;
    assertClose(so.stepLengthMeters.median, 3.5 * stepT, 0.02, 'step length');
    assertClose(so.flightDistanceMeters.median,
                3.5 * r.strideTiming.overall.flightSeconds.median, 0.02, 'flight distance');
    assertClose(so.strideLengthMeters.median, so.stepLengthMeters.median * 2, 0.02, 'stride = 2 steps');
  });

  test('stride length is never labelled short or long without a reference distribution', function () {
    var r = analyze({}, { userSpeedMps: 3.5 });
    assert(r.strideOutcome.interpretation.rating === 'unknown', 'no rating claimed');
    assert(/no_speed_matched_reference/.test(r.strideOutcome.interpretation.reason),
      'reason names the missing reference');
  });

  test('the two step-length routes are cross-checked when both exist', function () {
    var r = analyze({}, { userSpeedMps: 3.5, userHeightMeters: 1.78 });
    var cc = r.strideOutcome.crossCheck;
    if (cc.availability === 'available') {
      assert(isNum(cc.relativeDifference), 'relative difference computed');
      assertLt(cc.relativeDifference, 0.25, 'the two routes broadly agree on the fixture');
    }
  });

  suite('Arm carriage');

  test('arm metrics are descriptive and disclaim force generation', function () {
    var r = analyze({});
    assert(/not claimed to generate vertical ground-reaction force/i.test(r.armCarriage.note),
      'force disclaimer present');
    assert(r.armCarriage.isForceClaim === false, 'flag set');
  });

  test('hand-to-midline stays unavailable on sagittal video', function () {
    var r = analyze({});
    var h = r.armCarriage.handToMidlineDistance;
    assert(h.availability === 'unavailable', 'unavailable');
    assert(h.reason === 'requires_frontal_view', 'reason is the view, not a failure');
  });

  test('arm-leg phase is computed against the CONTRALATERAL leg', function () {
    var r = analyze({});
    var ph = r.armCarriage.armLegPhase;
    if (ph && ph.left && ph.left.availability === 'available') {
      assert(ph.left.pairedWith === 'right_leg', 'left arm paired with right leg');
      assert(isNum(ph.left.correlationAtBestLag), 'correlation computed');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Support geometry stays secondary
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Support geometry demotion');

  test('support angles are retained at the three stance windows', function () {
    var r = analyze({});
    assert(r.supportGeometry.availability === 'available', 'available');
    ['early_stance', 'central_stance', 'late_stance'].forEach(function (p) {
      var a = r.supportGeometry.left.phases[p];
      assert(a && a.angle && isNum(a.angle.median), p + ' angle present');
    });
  });

  test('geometry is labelled secondary and carries the demoted vocabulary', function () {
    var r = analyze({});
    assert(r.supportGeometry.role === 'secondary_descriptive_geometry', 'role tagged');
    assert(/braking-oriented/.test(r.supportGeometry.vocabulary.early_stance), 'vocabulary used');
    assert(/not a measured force direction/i.test(r.supportGeometry.note), 'disclaims force');
    assert(/not scored/i.test(r.supportGeometry.note), 'states it is not scored');
  });

  test('no elite target or alignment score appears anywhere in the result', function () {
    var json = JSON.stringify(analyze({}));
    assert(!/eliteTarget|meanAlignment|alignmentScore|idealAngle/i.test(json),
      'no target/alignment scoring fields');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Schema, storage and migration
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Schema and storage');

  test('the envelope carries the declared analysis type and schema version', function () {
    var r = analyze({});
    assert(r.analysisType === 'projection_ground_interaction', 'analysis type');
    assert(r.schemaVersion === 4, 'schema version 4');
    assert(r.isValidated === false, 'not validated');
    assert(typeof r.modelVersion === 'string', 'model version present');
  });

  test('the stored form stays within the document budget', function () {
    var stored = PGIAnalysis.toStoredForm(analyze({}));
    var bytes = JSON.stringify(stored).length;
    // The budget rose from 20KB when the four-phase blocks (minimum COM,
    // loading/compression, rebound/projection) were added in schema v4.
    assertLt(bytes, 24576, 'stored bytes (' + bytes + ') under 24KB');
  });

  test('no keypoints, per-step records or raw series reach the stored form', function () {
    var stored = JSON.stringify(PGIAnalysis.toStoredForm(analyze({})));
    assert(!/"kps"/.test(stored), 'no keypoints');
    assert(!/"stepResults"/.test(stored), 'no per-step COM records');
    assert(!/"contacts"/.test(stored), 'no per-contact records');
    assert(!/"series"/.test(stored), 'no raw series');
    assert(!/"smoothed"/.test(stored), 'no smoothed series');
  });

  test('rehydration restores the stripped static text without altering computed values', function () {
    var r = analyze({});
    var stored = PGIAnalysis.toStoredForm(r);
    var gct = stored.strideTiming.overall.contactSeconds.median;
    var re = PGIAnalysis.rehydrateStatic(JSON.parse(JSON.stringify(stored)));
    assert(re.disclaimer === PGI.DISCLAIMER, 'disclaimer restored');
    assert(re.limitations.length > 0, 'limitations restored');
    assert(re.supportGeometry.vocabulary, 'vocabulary restored');
    assert(re.supportGeometry.left.phases.early_stance.label === 'Early stance', 'labels restored');
    assert(re.patterns.every(function (p) { return p.alternatives && p.alternatives.length; }),
      'pattern alternatives restored');
    assert(re.strideTiming.overall.contactSeconds.median === gct, 'computed value untouched');
  });

  test('a stored analysis still renders, including its trajectory charts', function () {
    var stored = PGIAnalysis.rehydrateStatic(PGIAnalysis.toStoredForm(analyze({})));
    var html = PGIRender.buildHtml(stored);
    assert(html.length > 2000, 'renders substantively');
    assert(html.indexOf('<svg') !== -1, 'charts render from the stored paths');
  });

  suite('Migration');

  test('a PGI document is recognised as current', function () {
    var stored = PGIAnalysis.toStoredForm(analyze({}));
    var m = PGIAnalysis.migrateAnalysis({ pgi: stored });
    assert(m.generation === 'pgi', 'generation');
    assert(m.isLegacy === false, 'not legacy');
  });

  test('a KFO-era document is legacy and its values are NOT converted', function () {
    var m = PGIAnalysis.migrateAnalysis({
      kfo: { schemaVersion: 3, availability: 'available',
             left: { phases: { early_stance: { median: -8.4 } } } } });
    assert(m.generation === 'kfo', 'generation');
    assert(m.isLegacy === true, 'legacy');
    assert(m.pgi.availability === 'unavailable', 'PGI block unavailable');
    assert(m.pgi.reason === 'analysis_predates_projection_ground_interaction', 'explicit reason');
    // The critical assertion: no stored angle became a PGI metric.
    var json = JSON.stringify(m.pgi);
    assert(!/-8\.4/.test(json), 'no legacy angle leaked into the PGI block');
    assert(m.kfo, 'the KFO block is still handed back for the legacy renderer');
  });

  test('a pre-KFO document is handled without inventing data', function () {
    var m = PGIAnalysis.migrateAnalysis({ name: 'old session', phases: {} });
    assert(m.generation === 'pre_kfo', 'generation');
    assert(m.pgi.availability === 'unavailable', 'unavailable');
    assert(/cannot be recomputed retroactively/.test(m.pgi.limitations.join(' ')),
      'says why it cannot be recomputed');
  });

  test('migration never mutates the stored document', function () {
    var doc = { kfo: { schemaVersion: 3, availability: 'available' } };
    var before = JSON.stringify(doc);
    PGIAnalysis.migrateAnalysis(doc);
    assert(JSON.stringify(doc) === before, 'input document unchanged');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Research export
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Research export');

  test('stride and frame rows are produced with the declared columns', function () {
    var samples = clip({});
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                  userHeightMeters: 1.78, surfaceType: 'overground' });
    var b = PGIExport.buildExport(r, samples, { analysisId: 'T1' });
    assertGt(b.strideLevel.length, 3, 'stride rows');
    assertGt(b.frameLevel.length, 100, 'frame rows');
    assert(b.csv.strides.split('\n').length === b.strideLevel.length + 1, 'stride CSV row count');
    assert(b.csv.frames.split('\n').length === b.frameLevel.length + 1, 'frame CSV row count');
  });

  test('unavailable metrics export as empty cells, never as zero', function () {
    var samples = clip({ velocityPxPerSec: 0 });
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                  surfaceType: 'treadmill' });
    var b = PGIExport.buildExport(r, samples, { analysisId: 'T2' });
    b.strideLevel.forEach(function (row) {
      // Speed is unknown here, so every speed-derived cell must be empty.
      assert(row.speedMps === '' || row.speedMps === null || !isNum(row.speedMps),
        'speed empty when unknown');
    });
    assert(/never a zero/i.test(b.conventions.emptyCells), 'convention documented');
  });

  test('CSV cells are quoted and formula injection is neutralised', function () {
    assert(PGIExport.csvCell('=SUM(A1)') === '"\'=SUM(A1)"', 'formula prefixed');
    assert(PGIExport.csvCell('say "hi"') === '"say ""hi"""', 'quotes doubled');
    assert(PGIExport.csvCell('') === '""', 'empty stays empty');
  });

  test('frame rows label stance state and gait events', function () {
    var samples = clip({});
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                  userHeightMeters: 1.78, surfaceType: 'overground' });
    var b = PGIExport.buildExport(r, samples, { analysisId: 'T3' });
    assertGt(b.frameLevel.filter(function (f) { return f.stanceState === 'stance'; }).length, 10,
      'stance frames labelled');
    assertGt(b.frameLevel.filter(function (f) { return f.eventLabel; }).length, 3,
      'event frames labelled');
  });

  test('frame rows carry raw AND smoothed trajectories', function () {
    var samples = clip({});
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                  userHeightMeters: 1.78, surfaceType: 'overground' });
    var b = PGIExport.buildExport(r, samples, { analysisId: 'T4' });
    var withBoth = b.frameLevel.filter(function (f) {
      return isNum(f.comYRaw) && isNum(f.comHeightSmoothed); });
    assertGt(withBoth.length, 50, 'raw and smoothed both present');
  });

  test('the export states that nothing in it is validated', function () {
    var samples = clip({});
    var r = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 } });
    var b = PGIExport.buildExport(r, samples, {});
    assert(b.isValidated === false, 'bundle not validated');
    assert(b.validationStatus.forcePlateValidated === false, 'force plate not validated');
    assert(b.validationStatus.metabolicallyValidated === false, 'economy not validated');
  });

  test('the export documents which quantities are not independent', function () {
    var samples = clip({});
    var b = PGIExport.buildExport(
      PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 } }), samples, {});
    assert(b.conventions.independentTimingQuantities.length === 3,
      'contact, flight and minimum-COM timing are the independent quantities');
    assert(/must not be treated as independent/i.test(b.conventions.independenceNote),
      'independence caveat present');
  });


  // ═══════════════════════════════════════════════════════════════════════════
  //  Stance-landmark verification
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Landmark verification');

  test('the queue lists every used stance with its three landmark times', function () {
    var r = analyze({});
    var q = PGIVerify.buildQueue(r);
    var stances = r.quality.stancesDetected.left + r.quality.stancesDetected.right;
    assert(q.length === stances, 'one item per stance (' + q.length + ' vs ' + stances + ')');
    q.forEach(function (i) {
      assert(isNum(i.autoStart) && isNum(i.autoEnd) && i.autoEnd > i.autoStart, 'ordered edges');
      assert(i.confirmed === false, 'nothing pre-confirmed');
    });
    assert(q.some(function (i) { return isNum(i.minCom); }), 'min-COM times attached');
  });

  test('nudging preserves event ordering and un-confirms the stance', function () {
    var i = { start: 1.0, end: 1.24, minCom: 1.11, autoStart: 1.0, autoEnd: 1.24,
              autoMinCom: 1.11, confirmed: true };
    PGIVerify.nudge(i, 'touchdown', 0.033);
    assert(i.start === 1.033 && i.confirmed === false, 'moved and un-confirmed');
    // A nudge that would cross the minimum stance width is refused.
    PGIVerify.nudge(i, 'touchdown', 10);
    assert(i.start === 1.033, 'ordering-violating nudge refused');
    PGIVerify.nudge(i, 'minimumCom', -0.5);
    assert(i.minCom === 1.11, 'min-COM cannot leave the stance');
  });

  test('an analysis with confirmed corrections reports verified with the deltas retained', function () {
    var samples = clip({});
    var auto = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                     userHeightMeters: 1.78, surfaceType: 'overground' });
    assert(auto.verification.landmarksVerified === false, 'unverified until reviewed');
    var q = PGIVerify.buildQueue(auto);
    PGIVerify.nudge(q[0], 'touchdown', 0.033);
    q.forEach(function (i) { i.confirmed = true; });
    var ov = PGIVerify.toOverrides(q);
    var re = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                   userHeightMeters: 1.78, surfaceType: 'overground',
                                   stanceOverrides: ov.stanceOverrides,
                                   minComOverrides: ov.minComOverrides });
    assert(re.verification.landmarksVerified === true, 'verified after review');
    assert(re.verification.stancesAdjusted === 1, 'one stance adjusted');
    var c = re.verification.corrections[0];
    assert(c.event === 'touchdown' && c.deltaMs === 33, 'auto vs adjusted delta retained');
    var stored = PGIAnalysis.toStoredForm(re);
    assert(stored.verification.landmarksVerified === true, 'verification persisted');
    assert(stored.verification.corrections.length >= 1, 'corrections persisted');
  });

  test('a manually corrected minimum COM overrides detection with confidence 1', function () {
    var samples = clip({});
    var auto = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                     userHeightMeters: 1.78, surfaceType: 'overground' });
    var q = PGIVerify.buildQueue(auto).filter(function (i) { return isNum(i.minCom); });
    assert(q.length > 0, 'a stance with min-COM exists');
    PGIVerify.nudge(q[0], 'minimumCom', 0.02);
    q.forEach(function (i) { i.confirmed = true; });
    var ov = PGIVerify.toOverrides(q);
    var re = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                   userHeightMeters: 1.78, surfaceType: 'overground',
                                   stanceOverrides: { left: ov.stanceOverrides.left, right: ov.stanceOverrides.right },
                                   minComOverrides: ov.minComOverrides });
    var manual = (re.comTrajectory.stepResults || []).filter(function (st) {
      return st.valid && st.minimumCom && st.minimumCom.detectionMethod === 'manual_verification';
    });
    assert(manual.length >= 1, 'manual min-COM applied');
    assert(manual[0].minimumCom.confidence === 1, 'human-verified confidence is 1');
    assert(manual[0].minimumCom.autoDetection, 'auto detection retained beside the correction');
  });

  test('confirmed-but-unadjusted stances still count as verified', function () {
    var samples = clip({});
    var auto = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 } });
    var q = PGIVerify.buildQueue(auto);
    q.forEach(function (i) { i.confirmed = true; });
    var ov = PGIVerify.toOverrides(q);
    var re = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                   stanceOverrides: ov.stanceOverrides });
    assert(re.verification.landmarksVerified === true, 'verified');
    assert(re.verification.stancesAdjusted === 0, 'nothing adjusted');
    assert(re.verification.corrections.length === 0, 'no corrections recorded');
  });

  test('the verification badge renders and the unverified state is visible', function () {
    var samples = clip({});
    var auto = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                     userHeightMeters: 1.78 });
    assert(/landmarks not human-verified/.test(PGIRender.buildHtml(auto)), 'unverified badge');
    var q = PGIVerify.buildQueue(auto);
    q.forEach(function (i) { i.confirmed = true; });
    var ov = PGIVerify.toOverrides(q);
    var re = PGIAnalysis.analyze({ samples: samples, videoMetadata: { fps: 60 },
                                   userHeightMeters: 1.78, stanceOverrides: ov.stanceOverrides });
    assert(/landmarks verified/.test(PGIRender.buildHtml(re)), 'verified badge');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Published anchors
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Published anchors');

  test('anchors are speed-matched to the nearest published measurement', function () {
    var a = PGIAnchors.anchorFor('dutyFactor', 3.5);
    assert(a && a.atSpeedMps === 3.49, 'nearest Dorn speed chosen');
    assert(a.source.short === 'Dorn 2012', 'source named');
    assert(a.isTarget === false, 'never a target');
    var far = PGIAnchors.nearestDorn(12);
    assert(far === null, 'no anchor stretched beyond its speed range');
  });

  test('with speed unknown, only broad honest anchors are offered', function () {
    var df = PGIAnchors.anchorFor('dutyFactor', null);
    assert(df && /baseline/.test(df.source.short), 'falls back to the internal baseline');
    var peak = PGIAnchors.anchorFor('peakVerticalSupportBW', null);
    assert(peak === null, 'peak force has no honest speed-free anchor');
    var gct = PGIAnchors.anchorFor('contactSeconds', null);
    assert(gct && gct.range, 'contact time falls back to a stated range');
    assert(gct.source.provenance === 'approximate_device_population', 'range labelled approximate');
  });

  test('every context line names its source and frames itself as not a target', function () {
    var c = PGIAnchors.contextLine('meanVerticalSupportBW', 1.57, 3.5);
    assert(c && /Dorn 2012/.test(c.text), 'source in the line');
    assert(/not a target/.test(c.framing), 'framing preserved');
    assert(/lab-measured/.test(c.text), 'provenance stated');
  });

  test('the Dorn anchors are byte-identical with the values the force model is tested against', function () {
    // One source of truth: kfo-tests.js asserts the timing force model against
    // these same rows, so the anchors cannot drift from the validated table.
    var d = PGIAnchors.DORN_2012;
    assertClose(d[0].dutyFactor, 0.637, 1e-9, 'DF at 3.49');
    assertClose(d[0].peakVerticalBw, 2.71, 1e-9, 'peak at 3.49');
    assertClose(d[3].speedMps, 8.99, 1e-9, 'top speed row');
  });

  test('the rendered report anchors its headline numbers', function () {
    var h = html();
    assert(/Dorn 2012/.test(h), 'a published anchor appears in the report');
    assert(/not targets|not a target/i.test(h), 'anchor framing appears in the report');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Condensed report layout
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Condensed report');

  test('the report opens with a plain-language narrative before any table', function () {
    var h = html();
    var text = h.replace(/<[^>]*>/g, ' ');
    var narrativeIdx = h.indexOf('description of the observed pattern');
    assert(narrativeIdx !== -1, 'narrative present');
    assert(narrativeIdx < h.indexOf('Mechanical domains'), 'narrative precedes the domain chips');
    assert(/foot|contact|flight/i.test(text.slice(0, text.indexOf('Mechanical domains'))),
      'the narrative talks about the runner, not the software');
  });

  test('detail sections are collapsed behind summaries with takeaways', function () {
    var h = html();
    var details = (h.match(/<details/g) || []).length;
    assert(details >= 5, 'major sections are collapsible (' + details + ')');
    assert(/<summary/.test(h), 'summaries present');
    assert(/ms contact|cm compression|ms flight/.test(h.replace(/<[^>]*>/g, ' ')),
      'takeaways carry numbers');
  });

  test('suppressed caveats do not appear while real ones still do', function () {
    var noHeight = PGIRender.buildHtml(PGIAnalysis.analyze({
      samples: clip({ velocityPxPerSec: 0 }), videoMetadata: { fps: 60 }, surfaceType: 'treadmill' }));
    assert(noHeight.indexOf('Running speed unavailable') === -1, 'speed caveat suppressed');
    assert(noHeight.indexOf('Grade unavailable') === -1, 'grade caveat suppressed');
    assert(noHeight.indexOf('Video may be mirrored') === -1, 'mirror caveat suppressed');
    // A caveat the user can act on still shows.
    assert(/belt speed unknown|ground-relative foot velocity unavailable/i.test(noHeight),
      'actionable treadmill caveat still shown');
  });

  test('the angle diagram explains the support-line angle in plain terms', function () {
    var h = html();
    assert(/contact point (&#8594;|→) centre of mass/.test(h), 'diagram states what the angle is');
    assert(/still behind the planted foot/i.test(h), 'plain-language reading present');
    assert(/BEHIND the planted foot|behind the planted foot/i.test(h), 'per-phase meaning shown');
  });

  test('the measured timeline shows this runner\u2019s proportions, not a generic strip', function () {
    var a = PGIRender.buildHtml(analyze({ stanceSeconds: 0.275, flightSeconds: 0.100 },
                                        { userSpeedMps: 3.0 }));
    var b = PGIRender.buildHtml(analyze({ stanceSeconds: 0.215, flightSeconds: 0.150 },
                                        { userSpeedMps: 3.0 }));
    function widths(h) { return (h.match(/flex:0 0 [\d.]+%/g) || []).join(','); }
    assert(widths(a).length > 0, 'segments have measured widths');
    assert(widths(a) !== widths(b), 'different clips draw different proportions');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Copy audit
  // ═══════════════════════════════════════════════════════════════════════════
  suite('Copy audit');

  function html() { return PGIRender.buildHtml(analyze({}, { userSpeedMps: 3.5 })); }

  test('the technical disclaimer is always present', function () {
    assert(html().indexOf('does not directly measure ground-reaction force') !== -1,
      'disclaimer rendered');
  });

  test('the section is named Projection & Ground Interaction with its subtitle', function () {
    var h = html();
    assert(h.indexOf('Projection &amp; Ground Interaction') !== -1, 'title');
    assert(/prepares for contact.*loads the ground.*projects vertically/i.test(h), 'subtitle');
  });

  test('no single efficiency score is presented anywhere', function () {
    var h = html();
    // "efficiency" may appear only inside a denial of having one.
    var n = assertOnlyInDenial(h, /efficiency/, 'efficiency');
    assert(n > 0, 'the no-combined-score statement is actually present');
    assert(!/\b\d{1,3}\s*\/\s*100\b/.test(h), 'no n/100 score');
    assert(!/Running Efficiency|Overall Score|Form Score/i.test(h), 'no overall score heading');
  });

  test('a measurement claim is either a denial or a citation of a named study', function () {
    // The rule protected: no text claims OUR values are measured force. Cited
    // lab values ("lab-measured: 0.64 (Dorn 2012)") are the opposite of that
    // claim — they name whose measurement it is — and kinematic idioms
    // ("measured from this clip's strides", "measured from vertical") claim
    // motion, not force. Each occurrence must match one of the three.
    var h = html();
    var text = h.replace(/<[^>]*>/g, ' ');
    var idx = 0;
    while ((idx = text.toLowerCase().indexOf('measur', idx)) !== -1) {
      var ctx = text.slice(Math.max(0, idx - 110), idx + 110);
      var negated = /\b(not|never|no|does not|rather than|instead|non-)\b/i.test(ctx);
      var cited = /Dorn|Clark|cited stud|lab-measured:|reconstructed|population range|baseline/i.test(ctx);
      var kinematic = /clip(\u2019|'|&#8217;|&amp;#8217;)?s strides|from vertical|measurements has been validated/i.test(ctx);
      assert(negated || cited || kinematic,
        'measurement claim must be denied or attributed near: "' +
        ctx.replace(/\s+/g, ' ').trim() + '"');
      idx += 6;
    }
    // The core guarantee, asserted directly: our support estimate never reads
    // as measured without attribution or denial in the same panel.
    assert(/estimated from timing|timing-derived/i.test(h), 'our estimate is labelled as an estimate');
  });

  test('vertical oscillation is not labelled good or bad on its own', function () {
    var h = html();
    // Find the oscillation copy and confirm it states the combination rule.
    assert(/never interpreted on its own|not interpreted on its own|is never interpreted/i.test(h) ||
           /larger value is not treated as a fault/i.test(h),
      'oscillation copy states it is not judged alone');
    assert(!/reduce your vertical oscillation|lower oscillation is better/i.test(h),
      'no advice to reduce oscillation');
  });

  test('support geometry copy states it is not a force and not scored', function () {
    var h = html();
    assert(/not a measured force direction/i.test(h), 'not a force');
    assert(/not scored/i.test(h), 'not scored');
    assert(/not compared against a target/i.test(h), 'no target matching');
  });

  test('the domains are shown separately with the no-combined-score statement', function () {
    var h = html();
    ['Touchdown preparation', 'Braking indicators', 'Vertical projection',
     'Rebound timing', 'Data confidence'].forEach(function (d2) {
      assert(h.indexOf(d2) !== -1, d2 + ' shown');
    });
    // Stride outcome was cut on purpose: wearables report it directly.
    assert(h.indexOf('Stride outcome') === -1, 'stride-outcome chip removed');
    assert(/wearable/i.test(h), 'the wearable hand-off is stated');
    assert(/no combined efficiency score/i.test(h), 'explicit statement present');
  });

  test('the ankle-as-foot limitation is disclosed in the touchdown section', function () {
    assert(/no heel or toe landmark/i.test(html()), 'limitation disclosed');
  });

  test('stride length is not called better when longer', function () {
    var h = html();
    // "better" appears once, inside the denial "a longer stride is not
    // automatically better". Negation checking is what enforces this, not a ban.
    assertOnlyInDenial(h, /\bbetter\b/, 'stride-length judgement');
    assert(/not automatically better|not labelled short or long/i.test(h),
      'explicitly refuses the judgement');
  });

  test('rebound copy does not claim elasticity or force', function () {
    var h = html();
    assert(/not forces/i.test(h) || /not a measure of tendon elasticity/i.test(h),
      'rebound disclaimers present');
  });

  test('an unavailable analysis renders an explanation rather than an empty panel', function () {
    var h = PGIRender.buildHtml({
      availability: 'unavailable', reason: 'insufficient_samples', limitations: [] });
    assert(h.indexOf('could not be produced') !== -1, 'explains the absence');
    assert(h.indexOf('insufficient samples') !== -1, 'names the reason');
  });

  test('rendering never emits NaN or undefined', function () {
    [analyze({}), analyze({}, { userSpeedMps: null, userHeightMeters: null }),
     analyze({ sampleRateHz: 14 })].forEach(function (r, i) {
      var h = PGIRender.buildHtml(r);
      assert(h.indexOf('NaN') === -1, 'no NaN in render ' + i);
      assert(h.indexOf('undefined') === -1, 'no undefined in render ' + i);
      assert(h.indexOf('null') === -1 || !/>null</.test(h), 'no bare null in render ' + i);
    });
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  function summarize(opts) {
    opts = opts || {};
    var passed = results.filter(function (r) { return r.pass; }).length;
    var failed = results.filter(function (r) { return !r.pass; });
    var lines = [], bySuite = {};
    results.forEach(function (r) { (bySuite[r.suite] = bySuite[r.suite] || []).push(r); });
    Object.keys(bySuite).forEach(function (s) {
      lines.push('\n  ' + s);
      bySuite[s].forEach(function (r) {
        lines.push('    ' + (r.pass ? 'PASS' : 'FAIL') + '  ' + r.name +
          (r.pass ? '' : '\n          ' + r.error));
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
    return { total: results.length, passed: passed, failed: failed.length,
             failures: failed, results: results, text: lines.join('\n') + summary };
  }

  return {
    run: function (o) { return summarize(o || {}); },
    results: function () { return results; },
    fixtures: { makeClip: makeClip, clip: clip, frame: frame, analyze: analyze }
  };
});
