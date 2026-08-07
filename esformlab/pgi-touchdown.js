// ─────────────────────────────────────────────────────────────────────────────
//  PGI — touchdown preparation and braking patterns
//
//  THE POINT OF THIS MODULE. Two runners can land with the foot in almost the
//  same position relative to the COM and interact with the ground completely
//  differently. What separates them is what the foot was DOING on the way in:
//  whether it reached and kept travelling forward into the surface, or reached,
//  retracted, and arrived already moving backwards relative to the ground.
//
//  Static touchdown geometry alone cannot tell those apart, which is why the
//  previous force-vector paradigm could not describe a "scuffing" forefoot
//  contact that was not a classic heel-strike overstride. This module analyses
//  the final ~150 ms before contact so a FOOT PLACEMENT problem and a FOOT
//  ARRIVAL VELOCITY problem are separable findings.
//
//  FOOT REPRESENTATION. COCO-17 has no heel, toe or foot landmark, so the
//  ankle is the foot proxy throughout (`footRepresentation: 'ankle'`). For a
//  heel striker this understates true foot-to-COM offset. Disclosed, not
//  modelled away.
//
//  SIGN CONVENTIONS (all normalised for the direction of travel, so
//  right-to-left and mirrored clips read identically):
//
//    forwardOffset   = (footX − comX) · dirSign   + means foot AHEAD of the COM
//    footForward     = footX · dirSign            world position along travel
//    footHeight      = −footY                     up-positive (image +y is down)
//    horizontal foot velocity  + = travelling forward (with the runner)
//    vertical foot velocity    + = rising, − = descending
//    approach angle  0° = purely forward, +90° = straight down, − = rising
//
//  COORDINATE SPACES. The coarse side scan estimates poses on a ≤400 px canvas
//  while any dense pre-contact rescan may use full video resolution. Merging
//  them without rescaling would corrupt every velocity by that ratio, so dense
//  samples are rescaled by declared frame width AND cross-checked against body
//  scale; a mismatch that survives both is refused rather than merged.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGITouchdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function median(a) { return KFO._internals.median(a); }

  var CONFIG = Object.freeze({
    preContactMs: 150,          // late-swing window analysed before contact
    postContactMs: 100,         // retained for the trajectory visualisation
    minSamplesForPosition: 2,
    minSamplesForVelocity: 3,
    // Retraction is "clearly present" only with BOTH a real duration and a real
    // distance — a single noisy sample must not create one.
    minRetractionMs: 40,
    minRetractionLegLengths: 0.03,
    // Provisional working bands, NOT validated cutoffs. Foot-to-COM horizontal
    // offset at touchdown, in leg lengths (ankle-anchored, so lower than a
    // heel-referenced figure would be).
    offsetModerateLegLengths: 0.28,
    offsetElevatedLegLengths: 0.38,
    // Forward foot-ground velocity at contact that counts as a mismatch.
    forwardFootGroundMps: 0.40,
    // Without calibration: COM-relative forward velocity at contact, in leg
    // lengths per second, that counts as "still reaching".
    forwardFootComLegLengthsPerS: 0.35,
    // Body-scale agreement required before dense samples may be merged.
    denseScaleTolerance: 0.15,
    pathPoints: 25
  });

  var THRESHOLD_NOTE = 'Thresholds are provisional internal working values, not validated ' +
    'scientific cutoffs.';

  // ── Sample merging ─────────────────────────────────────────────────────────

  function scaleKeypoints(kps, factor) {
    if (!kps || factor === 1) return kps;
    return kps.map(function (k) {
      return k ? { x: k.x * factor, y: k.y * factor, score: k.score, name: k.name } : k;
    });
  }

  /**
   * Merge dense pre-contact samples into the coarse scan series.
   *
   * Dense samples are rescaled into the coarse coordinate space by declared
   * frame width, then verified against body scale. If they still disagree the
   * dense set is REFUSED — a silently mis-scaled velocity is worse than a
   * coarser one.
   *
   * @returns {{samples:Array, denseUsed:boolean, reason:string|null, rescaleFactor:number|null}}
   */
  function mergeDenseSamples(coarse, denseGroups, opts) {
    var cfg = (opts && opts.config) || CONFIG;
    var base = (coarse || []).filter(function (s) { return s && isNum(s.t) && s.kps; });
    if (!denseGroups || !denseGroups.length) {
      return { samples: base, denseUsed: false, reason: 'no_dense_windows_supplied', rescaleFactor: null };
    }

    var denseSamples = [];
    denseGroups.forEach(function (g) {
      (g && g.samples ? g.samples : []).forEach(function (s) {
        if (s && isNum(s.t) && s.kps) denseSamples.push(s);
      });
    });
    if (!denseSamples.length) {
      return { samples: base, denseUsed: false, reason: 'dense_windows_empty', rescaleFactor: null };
    }

    var coarseWidth = median(base.map(function (s) { return s.frameWidth; }).filter(isNum));
    var denseWidth = median(denseSamples.map(function (s) { return s.frameWidth; }).filter(isNum));
    var factor = (isNum(coarseWidth) && isNum(denseWidth) && denseWidth > 0)
      ? coarseWidth / denseWidth : 1;

    var rescaled = denseSamples.map(function (s) {
      return factor === 1 ? s : {
        t: s.t, kps: scaleKeypoints(s.kps, factor),
        scale: isNum(s.scale) ? s.scale * factor : s.scale,
        conf: s.conf, frameWidth: coarseWidth, rescaledBy: factor
      };
    });

    // Body scale is an independent check on the rescale: shoulder-mid to hip-mid
    // is the same anatomy in both passes, so it must agree after rescaling.
    var coarseScale = median(base.map(function (s) { return s.scale; }).filter(isNum));
    var denseScale = median(rescaled.map(function (s) { return s.scale; }).filter(isNum));
    if (isNum(coarseScale) && isNum(denseScale) && coarseScale > 0) {
      var rel = Math.abs(denseScale - coarseScale) / coarseScale;
      if (rel > cfg.denseScaleTolerance) {
        return {
          samples: base, denseUsed: false, rescaleFactor: factor,
          reason: 'dense_sample_scale_mismatch',
          detail: { coarseBodyScale: coarseScale, denseBodyScale: denseScale, relativeDifference: rel }
        };
      }
    }

    // Dense samples take precedence inside their own time spans.
    var spans = denseGroups.map(function (g) {
      var ts = (g.samples || []).map(function (s) { return s.t; }).filter(isNum);
      return ts.length ? { lo: Math.min.apply(null, ts), hi: Math.max.apply(null, ts) } : null;
    }).filter(Boolean);
    var kept = base.filter(function (s) {
      return !spans.some(function (sp) { return s.t >= sp.lo && s.t <= sp.hi; });
    });
    var merged = kept.concat(rescaled).sort(function (a, b) { return a.t - b.t; });
    return { samples: merged, denseUsed: true, reason: null, rescaleFactor: factor };
  }

  // ── Foot / COM series ──────────────────────────────────────────────────────

  /**
   * Build the smoothed foot series for one side. Smoothing runs ONCE over the
   * whole clip so that short pre-contact windows still get fitted derivatives
   * rather than raw frame-to-frame differences.
   */
  function buildFootSeries(samples, side, dirSign, smoothing) {
    var ankleIdx = side === 'left' ? 15 : 16;
    var raw = [];
    (samples || []).forEach(function (s) {
      if (!s || !isNum(s.t) || !s.kps) return;
      var ankle = PGI._internals.kpAt(s.kps, ankleIdx);
      if (!ankle) return;
      var com = KFO.computeCOM(s.kps, 'segmental');
      if (!com) return;
      raw.push({
        t: s.t,
        footX: ankle.x, footY: ankle.y,
        comX: com.x, comY: com.y,
        forwardOffset: (ankle.x - com.x) * dirSign,
        footForward: ankle.x * dirSign,
        footHeight: -ankle.y,
        comForward: com.x * dirSign
      });
    });
    raw.sort(function (a, b) { return a.t - b.t; });
    if (raw.length < 8) return { raw: raw, insufficient: true };

    function sm(key) {
      return PGI.smoothSeries(raw.map(function (p) { return { t: p.t, v: p[key] }; }), smoothing);
    }
    var offset = sm('forwardOffset');
    var forward = sm('footForward');
    var height = sm('footHeight');
    return {
      raw: raw,
      offset: offset.points,     // {t, value, d1}  COM-relative forward offset
      forward: forward.points,   // {t, value, d1}  world forward position
      height: height.points,     // {t, value, d1}  up-positive height
      filter: offset.filter,
      insufficient: !!(offset.insufficient || forward.insufficient || height.insufficient)
    };
  }

  function countInWindow(points, t0, t1) {
    var n = 0;
    (points || []).forEach(function (p) { if (p.t >= t0 && p.t <= t1) n++; });
    return n;
  }

  /** Mean of a smoothed derivative over a window. */
  function meanDerivative(points, t0, t1) {
    var vals = [];
    (points || []).forEach(function (p) {
      if (p.t >= t0 && p.t <= t1 && isNum(p.d1)) vals.push(p.d1);
    });
    if (!vals.length) return null;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }

  // ── Per-stance analysis ────────────────────────────────────────────────────

  /**
   * @param {Object} series   buildFootSeries output
   * @param {Object} stance   {startTime, endTime, side}
   * @param {Object} ctx      {legLengthPx, calibration, velocityWindow, config, surfaceType, treadmillSpeedMps}
   */
  function analyzeStance(series, stance, ctx) {
    var cfg = ctx.config || CONFIG;
    var td = stance.startTime;
    var t0 = td - cfg.preContactMs / 1000;
    var leg = isNum(ctx.legLengthPx) && ctx.legLengthPx > 0 ? ctx.legLengthPx : null;
    var cal = ctx.calibration;

    var out = {
      side: stance.side,
      touchdownTime: td,
      preContactWindowMs: cfg.preContactMs,
      footRepresentation: 'ankle',
      samplesInWindow: countInWindow(series.offset, t0, td),
      position: { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: null },
      retraction: { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: null },
      arrivalVelocity: { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: null }
    };

    // ── Position (Phase 3.1–3.4) ──
    var offsetAtTd = PGI.valueAtTime(series.offset, td, 'value');
    var maxAnterior = PGI.extremumInWindow(series.offset, t0, td, 'value', 'max');
    if (out.samplesInWindow < cfg.minSamplesForPosition || !isNum(offsetAtTd) || !maxAnterior) {
      out.position.reason = 'insufficient_pre_contact_samples';
    } else {
      out.position = {
        availability: KFO.AVAILABILITY.AVAILABLE,
        footComOffsetAtTouchdownPx: offsetAtTd,
        footComOffsetAtTouchdownLegLengths: leg ? offsetAtTd / leg : null,
        footComOffsetAtTouchdownMeters: PGI.pxToMeters(offsetAtTd, cal),
        maxAnteriorExcursionPx: maxAnterior.v,
        maxAnteriorExcursionLegLengths: leg ? maxAnterior.v / leg : null,
        maxAnteriorExcursionTime: maxAnterior.t,
        timeFromMaxAnteriorToTouchdownMs: (td - maxAnterior.t) * 1000
      };
    }

    // ── Retraction (Phase 3.4–3.6, 3.12) ──
    if (out.position.availability === KFO.AVAILABILITY.AVAILABLE) {
      var retractionTime = td - maxAnterior.t;
      // COM-relative: how much the foot came back under the body.
      var retractionDistanceCom = maxAnterior.v - offsetAtTd;
      // World-relative: the foot can still be advancing in world coordinates
      // while retracting relative to a COM that is advancing faster. Both are
      // reported so neither reading can be mistaken for the other.
      var fwdMax = PGI.valueAtTime(series.forward, maxAnterior.t, 'value');
      var fwdTd = PGI.valueAtTime(series.forward, td, 'value');
      var retractionDistanceWorld = (isNum(fwdMax) && isNum(fwdTd)) ? fwdMax - fwdTd : null;

      var meanRetractionVel = retractionTime > 0 ? retractionDistanceCom / retractionTime : null;
      var peakRetract = PGI.extremumInWindow(series.offset, maxAnterior.t, td, 'd1', 'min');

      var clear = retractionTime * 1000 >= cfg.minRetractionMs &&
                  (leg ? retractionDistanceCom / leg >= cfg.minRetractionLegLengths
                       : retractionDistanceCom > 0) &&
                  out.samplesInWindow >= cfg.minSamplesForVelocity;

      out.retraction = {
        availability: KFO.AVAILABILITY.AVAILABLE,
        retractionTimeMs: retractionTime * 1000,
        retractionDistanceComPx: retractionDistanceCom,
        retractionDistanceComLegLengths: leg ? retractionDistanceCom / leg : null,
        retractionDistanceComMeters: PGI.pxToMeters(retractionDistanceCom, cal),
        retractionDistanceWorldPx: retractionDistanceWorld,
        retractionDistanceWorldLegLengths: (leg && isNum(retractionDistanceWorld))
          ? retractionDistanceWorld / leg : null,
        meanRetractionVelocityPxPerS: meanRetractionVel,
        meanRetractionVelocityLegLengthsPerS: (leg && isNum(meanRetractionVel))
          ? meanRetractionVel / leg : null,
        meanRetractionVelocityMps: PGI.pxToMeters(meanRetractionVel, cal),
        // d1 of the COM-relative offset is negative while retracting; report the
        // magnitude of the most negative value as the peak retraction rate.
        peakRetractionVelocityPxPerS: peakRetract && isNum(peakRetract.v) ? -peakRetract.v : null,
        peakRetractionVelocityMps: (peakRetract && isNum(peakRetract.v))
          ? PGI.pxToMeters(-peakRetract.v, cal) : null,
        clearRetractionDetected: clear,
        detectionRule: 'Requires at least ' + cfg.minRetractionMs + ' ms and ' +
          cfg.minRetractionLegLengths + ' leg lengths of COM-relative retraction, with at least ' +
          cfg.minSamplesForVelocity + ' samples in the pre-contact window.'
      };
    } else {
      out.retraction.reason = out.position.reason;
    }

    // ── Arrival velocity (Phase 3.7–3.11, 3.13, Phase 4) ──
    var vw = ctx.velocityWindow;
    if (!vw || !vw.available) {
      out.arrivalVelocity.reason = (vw && vw.reason) || 'video_frame_rate_insufficient';
      out.arrivalVelocity.note = 'Pre-contact velocity estimate unavailable: video frame rate insufficient.';
    } else {
      var vt0 = td - vw.windowMs / 1000;
      var nVel = countInWindow(series.forward, vt0, td);
      if (nVel < cfg.minSamplesForVelocity) {
        out.arrivalVelocity.reason = 'insufficient_samples_in_velocity_window';
        out.arrivalVelocity.samplesInVelocityWindow = nVel;
      } else {
        var vxWorld = meanDerivative(series.forward, vt0, td);     // px/s, + = forward
        var vyUp = meanDerivative(series.height, vt0, td);         // px/s, + = rising
        var vxCom = meanDerivative(series.offset, vt0, td);        // px/s relative to COM
        var vxAtTd = PGI.valueAtTime(series.forward, td, 'd1');
        // Change over the final window: how abruptly horizontal foot velocity
        // is changing as contact arrives.
        var vxStart = PGI.valueAtTime(series.forward, vt0, 'd1');
        var deltaVx = (isNum(vxAtTd) && isNum(vxStart)) ? vxAtTd - vxStart : null;

        var resultant = (isNum(vxWorld) && isNum(vyUp)) ? Math.hypot(vxWorld, vyUp) : null;
        // Approach angle below horizontal: 0° purely forward, +90° straight down.
        var approach = (isNum(vxWorld) && isNum(vyUp)) ? Math.atan2(-vyUp, vxWorld) * 180 / Math.PI : null;

        var worldMps = PGI.pxToMeters(vxWorld, cal);
        var ground = PGI.footGroundVelocity({
          worldFootVelocityMps: worldMps,
          surfaceType: ctx.surfaceType,
          treadmillSpeedMps: ctx.treadmillSpeedMps
        });

        out.arrivalVelocity = {
          availability: KFO.AVAILABILITY.AVAILABLE,
          windowMs: vw.windowMs,
          samplesInVelocityWindow: nVel,
          horizontalFootVelocityPxPerS: vxWorld,
          horizontalFootVelocityMps: worldMps,
          horizontalFootVelocityLegLengthsPerS: leg && isNum(vxWorld) ? vxWorld / leg : null,
          verticalFootVelocityPxPerS: vyUp,
          verticalFootVelocityMps: PGI.pxToMeters(vyUp, cal),
          resultantFootVelocityPxPerS: resultant,
          resultantFootVelocityMps: PGI.pxToMeters(resultant, cal),
          approachAngleDegrees: approach,
          approachAngleConvention: '0° = travelling forward, +90° = straight down, negative = rising',
          footVelocityRelativeToComPxPerS: vxCom,
          footVelocityRelativeToComLegLengthsPerS: leg && isNum(vxCom) ? vxCom / leg : null,
          horizontalVelocityChangePxPerS: deltaVx,
          horizontalVelocityChangeMps: PGI.pxToMeters(deltaVx, cal),
          footGroundVelocity: ground,
          signConvention: 'positive_in_direction_of_travel'
        };
      }
    }

    // ── Trajectory for the visualisation (Phase 23) ──
    out.path = buildPath(series, td, stance.endTime, ctx);
    return out;
  }

  /**
   * Foot path from ~150 ms pre-contact to ~100 ms post-contact, in COM-relative
   * and world coordinates, normalised by leg length and referenced to the
   * touchdown position so paths from different strides overlay.
   */
  function buildPath(series, td, stanceEnd, ctx) {
    var cfg = ctx.config || CONFIG;
    var leg = isNum(ctx.legLengthPx) && ctx.legLengthPx > 0 ? ctx.legLengthPx : null;
    if (!leg) return null;
    var t0 = td - cfg.preContactMs / 1000;
    var t1 = td + cfg.postContactMs / 1000;
    var fwdTd = PGI.valueAtTime(series.forward, td, 'value');
    var hTd = PGI.valueAtTime(series.height, td, 'value');
    if (!isNum(fwdTd) || !isNum(hTd)) return null;

    var pts = [];
    for (var i = 0; i < cfg.pathPoints; i++) {
      var frac = i / (cfg.pathPoints - 1);
      var t = t0 + (t1 - t0) * frac;
      var fwd = PGI.valueAtTime(series.forward, t, 'value');
      var h = PGI.valueAtTime(series.height, t, 'value');
      var off = PGI.valueAtTime(series.offset, t, 'value');
      pts.push({
        tMsFromTouchdown: Math.round((t - td) * 1000),
        worldForward: isNum(fwd) ? (fwd - fwdTd) / leg : null,
        height: isNum(h) ? (h - hTd) / leg : null,
        comRelativeForward: isNum(off) ? off / leg : null
      });
    }
    return {
      unit: 'leg_lengths',
      referencedTo: 'touchdown_position',
      points: pts,
      markers: {
        touchdownMs: 0,
        stanceEndMs: isNum(stanceEnd) ? Math.round((stanceEnd - td) * 1000) : null
      }
    };
  }

  // ── Braking pattern classification (Phase 5) ───────────────────────────────
  //
  // No pattern is assigned from one metric. Position evidence and velocity
  // evidence are gathered independently and the pattern is the COMBINATION —
  // which is what makes "foot placement problem" and "foot arrival problem"
  // separable findings rather than one undifferentiated "overstriding" verdict.

  var PATTERN_INTERPRETATION = Object.freeze({
    positional_overstride:
      'Foot contact occurs relatively far ahead of the body, creating braking-oriented landing geometry.',
    velocity_mismatch_touchdown:
      'Foot placement is not markedly overextended, but touchdown occurs before the foot has fully ' +
      'prepared for ground contact.',
    combined_braking:
      'Both touchdown position and arrival velocity may increase braking demand.',
    well_prepared_touchdown:
      'Moderate foot placement with clear pre-contact retraction and low arrival-velocity mismatch.',
    indeterminate:
      'Not enough consistent touchdown data to describe a braking pattern.'
  });

  var PATTERN_ALTERNATIVES = Object.freeze({
    positional_overstride: ['Camera not perpendicular to the runner',
                            'Ankle landmark understates a heel-first contact',
                            'Acceleration during the trial'],
    velocity_mismatch_touchdown: ['Low frame rate', 'Video calibration error',
                                  'Acceleration during the trial',
                                  'Contact frame located one sample early'],
    combined_braking: ['Camera not perpendicular to the runner', 'Low frame rate',
                       'Acceleration during the trial'],
    well_prepared_touchdown: ['Contact frame located one sample late',
                              'Sparse pre-contact sampling smoothing over a late reach'],
    indeterminate: ['Insufficient pre-contact sampling', 'Occluded ankle landmark']
  });

  /**
   * @param {Object} agg  aggregated side metrics from aggregateSide()
   * @param {Object} ctx  {config, calibration, confidence}
   */
  function classifyBraking(agg, ctx) {
    var cfg = (ctx && ctx.config) || CONFIG;
    var observations = [], supporting = {}, evidence = {
      positionAvailable: false, velocityAvailable: false,
      positionElevated: null, retractionClear: null, velocityMismatch: null
    };

    // — Position evidence —
    var offset = agg.footComOffsetAtTouchdownLegLengths;
    if (offset && isNum(offset.median)) {
      evidence.positionAvailable = true;
      supporting.footComOffsetLegLengths = offset.median;
      evidence.positionElevated = offset.median >= cfg.offsetElevatedLegLengths;
      var moderate = offset.median >= cfg.offsetModerateLegLengths;
      observations.push('Foot-to-COM horizontal offset at touchdown ' + offset.median.toFixed(2) +
        ' leg lengths (' + (evidence.positionElevated ? 'elevated' : moderate ? 'moderate' : 'low') +
        ' by provisional bands)');
    }

    // — Retraction evidence —
    if (isNum(agg.clearRetractionFraction)) {
      evidence.retractionClear = agg.clearRetractionFraction >= 0.6;
      supporting.clearRetractionFraction = agg.clearRetractionFraction;
      observations.push('Clear pre-contact retraction on ' +
        Math.round(agg.clearRetractionFraction * 100) + '% of analysed contacts');
    }
    if (agg.retractionTimeMs && isNum(agg.retractionTimeMs.median)) {
      supporting.retractionTimeMs = agg.retractionTimeMs.median;
      observations.push('Median retraction period ' + Math.round(agg.retractionTimeMs.median) + ' ms');
    }

    // — Arrival-velocity evidence —
    // Ground-relative velocity is the direct evidence when it exists; without a
    // belt speed or calibration, COM-relative forward velocity at contact is the
    // honest stand-in and is labelled as such.
    var groundAgg = agg.footGroundVelocityMps;
    var comVelAgg = agg.footVelocityRelativeToComLegLengthsPerS;
    if (groundAgg && isNum(groundAgg.median)) {
      evidence.velocityAvailable = true;
      supporting.footGroundVelocityMps = groundAgg.median;
      evidence.velocityMismatch = groundAgg.median >= cfg.forwardFootGroundMps;
      observations.push('Foot was still moving ' +
        (groundAgg.median >= 0 ? 'forward' : 'backward') + ' relative to the ground at ' +
        Math.abs(groundAgg.median).toFixed(2) + ' m/s approaching contact');
    } else if (comVelAgg && isNum(comVelAgg.median)) {
      evidence.velocityAvailable = true;
      evidence.velocityBasis = 'com_relative';
      supporting.footVelocityRelativeToComLegLengthsPerS = comVelAgg.median;
      evidence.velocityMismatch = comVelAgg.median >= cfg.forwardFootComLegLengthsPerS;
      observations.push('Foot was still advancing relative to the body at ' +
        comVelAgg.median.toFixed(2) + ' leg lengths/s approaching contact ' +
        '(ground-relative velocity unavailable)');
    }
    // A short retraction period is velocity evidence in its own right.
    if (evidence.retractionClear === false) {
      evidence.velocityAvailable = true;
      if (evidence.velocityMismatch !== true) evidence.velocityMismatch = true;
    }

    var P = PGI.BRAKING_PATTERN;
    var pattern = P.INDETERMINATE;
    if (!evidence.positionAvailable && !evidence.velocityAvailable) {
      pattern = P.INDETERMINATE;
    } else if (evidence.positionElevated === true && evidence.velocityMismatch === true) {
      pattern = P.COMBINED_BRAKING;
    } else if (evidence.positionElevated === true) {
      pattern = P.POSITIONAL_OVERSTRIDE;
    } else if (evidence.velocityMismatch === true && evidence.positionElevated === false) {
      pattern = P.VELOCITY_MISMATCH;
    } else if (evidence.positionElevated === false && evidence.retractionClear === true &&
               evidence.velocityMismatch === false) {
      pattern = P.WELL_PREPARED;
    }

    // Confidence: needs both evidence classes and enough contacts to mean
    // anything. A one-sided read is explicitly less certain.
    var conf = 0.35;
    if (evidence.positionAvailable) conf += 0.2;
    if (evidence.velocityAvailable) conf += 0.2;
    if (isNum(agg.n) && agg.n >= 5) conf += 0.1;
    if (evidence.velocityBasis === 'com_relative') conf -= 0.1;
    if (isNum(ctx && ctx.confidence)) conf *= (0.5 + 0.5 * ctx.confidence);

    return {
      pattern: pattern,
      interpretation: PATTERN_INTERPRETATION[pattern],
      confidence: Math.max(0, Math.min(0.95, conf)),
      observations: observations,
      alternatives: PATTERN_ALTERNATIVES[pattern].slice(),
      supportingMetrics: supporting,
      evidence: evidence,
      thresholds: {
        offsetModerateLegLengths: cfg.offsetModerateLegLengths,
        offsetElevatedLegLengths: cfg.offsetElevatedLegLengths,
        forwardFootGroundMps: cfg.forwardFootGroundMps,
        forwardFootComLegLengthsPerS: cfg.forwardFootComLegLengthsPerS,
        isProvisional: true,
        note: THRESHOLD_NOTE
      }
    };
  }

  // ── Aggregation ────────────────────────────────────────────────────────────

  function aggregateSide(stances) {
    function a(path) {
      var vals = [];
      stances.forEach(function (s) {
        var cur = s, parts = path.split('.');
        for (var i = 0; i < parts.length && cur; i++) cur = cur[parts[i]];
        if (isNum(cur)) vals.push(cur);
      });
      return KFO.aggregate(vals);
    }
    var withRetraction = stances.filter(function (s) {
      return s.retraction && s.retraction.availability === KFO.AVAILABILITY.AVAILABLE;
    });
    var clearCount = withRetraction.filter(function (s) { return s.retraction.clearRetractionDetected; }).length;

    return {
      n: stances.length,
      contactsWithPosition: stances.filter(function (s) {
        return s.position.availability === KFO.AVAILABILITY.AVAILABLE; }).length,
      contactsWithVelocity: stances.filter(function (s) {
        return s.arrivalVelocity.availability === KFO.AVAILABILITY.AVAILABLE; }).length,
      footComOffsetAtTouchdownLegLengths: a('position.footComOffsetAtTouchdownLegLengths'),
      footComOffsetAtTouchdownMeters: a('position.footComOffsetAtTouchdownMeters'),
      maxAnteriorExcursionLegLengths: a('position.maxAnteriorExcursionLegLengths'),
      timeFromMaxAnteriorToTouchdownMs: a('position.timeFromMaxAnteriorToTouchdownMs'),
      retractionTimeMs: a('retraction.retractionTimeMs'),
      retractionDistanceComLegLengths: a('retraction.retractionDistanceComLegLengths'),
      retractionDistanceComMeters: a('retraction.retractionDistanceComMeters'),
      meanRetractionVelocityMps: a('retraction.meanRetractionVelocityMps'),
      meanRetractionVelocityLegLengthsPerS: a('retraction.meanRetractionVelocityLegLengthsPerS'),
      peakRetractionVelocityMps: a('retraction.peakRetractionVelocityMps'),
      clearRetractionFraction: withRetraction.length ? clearCount / withRetraction.length : null,
      horizontalFootVelocityMps: a('arrivalVelocity.horizontalFootVelocityMps'),
      horizontalFootVelocityLegLengthsPerS: a('arrivalVelocity.horizontalFootVelocityLegLengthsPerS'),
      verticalFootVelocityMps: a('arrivalVelocity.verticalFootVelocityMps'),
      resultantFootVelocityMps: a('arrivalVelocity.resultantFootVelocityMps'),
      approachAngleDegrees: a('arrivalVelocity.approachAngleDegrees'),
      footVelocityRelativeToComLegLengthsPerS: a('arrivalVelocity.footVelocityRelativeToComLegLengthsPerS'),
      horizontalVelocityChangeMps: a('arrivalVelocity.horizontalVelocityChangeMps'),
      footGroundVelocityMps: a('arrivalVelocity.footGroundVelocity.valueMps')
    };
  }

  /** Mean normalised foot path across a side's contacts, for the visualisation. */
  function meanPath(stances, cfg) {
    var n = cfg.pathPoints;
    var acc = [];
    for (var i = 0; i < n; i++) acc.push({ w: 0, h: 0, c: 0, k: 0, t: null });
    var any = false;
    stances.forEach(function (s) {
      if (!s.path || !s.path.points || s.path.points.length !== n) return;
      any = true;
      s.path.points.forEach(function (p, i) {
        acc[i].t = p.tMsFromTouchdown;
        if (isNum(p.worldForward) && isNum(p.height) && isNum(p.comRelativeForward)) {
          acc[i].w += p.worldForward; acc[i].h += p.height; acc[i].c += p.comRelativeForward; acc[i].k++;
        }
      });
    });
    if (!any) return null;
    return {
      unit: 'leg_lengths',
      referencedTo: 'touchdown_position',
      points: acc.map(function (p) {
        return {
          tMsFromTouchdown: p.t,
          worldForward: p.k ? p.w / p.k : null,
          height: p.k ? p.h / p.k : null,
          comRelativeForward: p.k ? p.c / p.k : null,
          n: p.k
        };
      })
    };
  }

  // ── Top level ──────────────────────────────────────────────────────────────

  /**
   * @param {Object} input
   * @param {Array} input.samples                coarse scan samples
   * @param {Array} [input.denseWindows]         [{side, touchdownTime, samples:[{t,kps,scale,frameWidth}]}]
   * @param {Object} input.stanceIntervals       {left:[...], right:[...]}
   * @param {number} input.directionSign
   * @param {number|null} input.legLengthPx
   * @param {Object|null} input.calibration
   * @param {number|null} input.effectiveSampleRateHz
   * @param {string} input.surfaceType
   * @param {number|null} [input.treadmillSpeedMps]
   * @param {number|null} [input.confidence]
   * @param {Object} [input.config]
   */
  function analyze(input) {
    input = input || {};
    var cfg = input.config || CONFIG;
    var merged = mergeDenseSamples(input.samples, input.denseWindows, { config: cfg });

    // The velocity window is chosen from the rate ACTUALLY available in the
    // pre-contact region, which is higher than the clip average when a dense
    // rescan succeeded.
    var effectiveRate = input.effectiveSampleRateHz;
    if (merged.denseUsed && isNum(input.densePreContactRateHz)) {
      effectiveRate = input.densePreContactRateHz;
    }
    var vw = PGI.velocityWindow(effectiveRate);

    var out = {
      availability: KFO.AVAILABILITY.UNAVAILABLE,
      reason: null,
      footRepresentation: 'ankle',
      footRepresentationNote: 'COCO-17 provides no heel, toe or foot landmark, so the ankle is the ' +
        'foot proxy. For a heel-first contact this understates true foot-to-COM offset.',
      preContactWindowMs: cfg.preContactMs,
      densePreContactSampling: {
        used: merged.denseUsed,
        reason: merged.reason,
        rescaleFactor: merged.rescaleFactor,
        detail: merged.detail || null
      },
      velocityWindow: vw,
      left: null, right: null
    };

    var dirSign = isNum(input.directionSign) && input.directionSign !== 0
      ? (input.directionSign > 0 ? 1 : -1) : null;
    if (dirSign === null) {
      out.reason = 'unknown_running_direction';
      return out;
    }

    var ctxBase = {
      legLengthPx: input.legLengthPx,
      calibration: input.calibration,
      velocityWindow: vw,
      config: cfg,
      surfaceType: input.surfaceType || PGI.SURFACE.UNKNOWN,
      treadmillSpeedMps: input.treadmillSpeedMps == null ? null : input.treadmillSpeedMps
    };

    var anySide = false;
    ['left', 'right'].forEach(function (side) {
      var intervals = (input.stanceIntervals && input.stanceIntervals[side]) || [];
      var series = buildFootSeries(merged.samples, side, dirSign, input.smoothing);
      if (series.insufficient || !intervals.length) {
        out[side] = {
          side: side, availability: KFO.AVAILABILITY.UNAVAILABLE,
          reason: series.insufficient ? 'insufficient_foot_trajectory' : 'no_stance_intervals'
        };
        return;
      }
      var stances = intervals.map(function (iv) {
        return analyzeStance(series, { side: side, startTime: iv.startTime, endTime: iv.endTime }, ctxBase);
      });
      var usable = stances.filter(function (s) {
        return s.position.availability === KFO.AVAILABILITY.AVAILABLE ||
               s.arrivalVelocity.availability === KFO.AVAILABILITY.AVAILABLE;
      });
      if (!usable.length) {
        out[side] = { side: side, availability: KFO.AVAILABILITY.UNAVAILABLE,
                      reason: 'no_usable_pre_contact_windows', contactsExamined: stances.length };
        return;
      }
      anySide = true;
      var aggregated = aggregateSide(usable);
      out[side] = {
        side: side,
        availability: KFO.AVAILABILITY.AVAILABLE,
        contactsExamined: stances.length,
        contactsUsed: usable.length,
        aggregate: aggregated,
        brakingPattern: classifyBraking(aggregated, {
          config: cfg, calibration: input.calibration, confidence: input.confidence
        }),
        meanPath: meanPath(usable, cfg),
        contacts: usable,        // runtime/export only; not persisted
        filter: series.filter
      };
    });

    if (!anySide) {
      out.reason = out.reason || 'no_usable_pre_contact_windows';
      return out;
    }
    out.availability = KFO.AVAILABILITY.AVAILABLE;

    // Side-to-side asymmetry in touchdown preparation (Phase 17 / test case 11).
    if (out.left && out.right &&
        out.left.availability === KFO.AVAILABILITY.AVAILABLE &&
        out.right.availability === KFO.AVAILABILITY.AVAILABLE) {
      var diff = function (field) {
        var l = out.left.aggregate[field], r = out.right.aggregate[field];
        return (l && r && isNum(l.median) && isNum(r.median)) ? l.median - r.median : null;
      };
      out.asymmetry = {
        available: true,
        footComOffsetDifferenceLegLengths: diff('footComOffsetAtTouchdownLegLengths'),
        retractionTimeDifferenceMs: diff('retractionTimeMs'),
        clearRetractionDifference: (isNum(out.left.aggregate.clearRetractionFraction) &&
                                    isNum(out.right.aggregate.clearRetractionFraction))
          ? out.left.aggregate.clearRetractionFraction - out.right.aggregate.clearRetractionFraction : null,
        patternsDiffer: out.left.brakingPattern.pattern !== out.right.brakingPattern.pattern,
        note: 'Differences are descriptive. Side-to-side variation is normal; a large difference is ' +
          'a prompt to check event detection before it is a finding about the runner.'
      };
    } else {
      out.asymmetry = { available: false, reason: 'both_sides_required' };
    }

    return out;
  }

  return {
    CONFIG: CONFIG,
    THRESHOLD_NOTE: THRESHOLD_NOTE,
    PATTERN_INTERPRETATION: PATTERN_INTERPRETATION,
    PATTERN_ALTERNATIVES: PATTERN_ALTERNATIVES,
    mergeDenseSamples: mergeDenseSamples,
    buildFootSeries: buildFootSeries,
    analyzeStance: analyzeStance,
    classifyBraking: classifyBraking,
    aggregateSide: aggregateSide,
    analyze: analyze
  };
});
