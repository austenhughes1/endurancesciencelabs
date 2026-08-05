// ─────────────────────────────────────────────────────────────────────────────
//  KFO — impulse accounting
//
//  WHY THIS EXISTS. The product conversation started from a simplified
//  "80% vertical / 20% horizontal" idea. The same force trace yields several
//  legitimate but different ratios depending on what is counted, so there is no
//  single "correct force-vector ratio" to report. This module makes the
//  accounting explicit instead of picking one and hiding the choice.
//
//  THE SIX QUANTITIES (all over ONE stance phase; Fz up-positive, Fx positive in
//  the direction of travel):
//
//      JvTotal     = ∫ Fz dt                          total vertical support
//      JvEffective = ∫ (Fz − bodyWeight) dt           net upward projection
//      JBrake      = −∫ Fx dt  where Fx < 0           braking magnitude
//      JProp       =  ∫ Fx dt  where Fx > 0           propulsive replacement
//      JhTurnover  = JBrake + JProp                    total fore-aft turnover
//      JxNet       = JProp − JBrake                    signed net (≈0 steady)
//
//  JvEffective is Dorn et al. 2012's projection quantity (their equations
//  A5–A6). It is NOT JvTotal: most of JvTotal is the unavoidable cost of holding
//  bodyweight up during contact, and including it swamps the part the runner
//  actually modulates.
//
//  WHY THREE COMPOSITIONS. Reconstructing Clark/Ryan/Weyand 2012's rounded means
//  at 5 m/s (mean Fz 1.70 BW, JvTotal 0.30 BW·s, one-phase horizontal impulse
//  0.05 BW·s → t_contact ≈ 0.176 s, JvEffective ≈ 0.124 BW·s):
//
//      JvTotal     / (JvTotal + JProp)                 = 85.7% vertical
//      JvEffective / (JvEffective + JProp)             = 71.2% vertical
//      JvEffective / (JvEffective + JBrake + JProp)    = 55.3% vertical
//
//  85/15, 70/30 and 55/45 all describe the same trial. They are not competing
//  answers, and none of them is a validated efficiency target.
//
//  WHAT THESE SHARES ARE NOT. They are SCALAR-SUM shares: a magnitude divided by
//  a sum of magnitudes. They are not direction cosines, not percentages of a
//  resultant vector, and not energy or work fractions. JhTurnover in particular
//  adds two opposing force directions together, so no instantaneous force ever
//  points along the "angle equivalent" derived from it.
//
//  IMPULSE IS NOT WORK. Impulse is ∫F dt and changes momentum; work is ∫F·dx and
//  changes energy. A braking impulse that nets to zero over a step does NOT mean
//  the energy cost nets to zero — the muscle does negative then positive work,
//  both metabolically expensive.
//
//  IMPACT IS NOT BRAKING. The early-stance vertical impact transient is a
//  VERTICAL feature (peak, loading rate). Horizontal braking impulse is a
//  FORE-AFT quantity. They co-occur and are routinely conflated; this module
//  keeps them in separate blocks and refuses to estimate impact metrics from any
//  signal that cannot resolve them.
//
//  AVAILABILITY IS HONEST. Under geometry_proxy every field here is null with a
//  machine-readable reason. Nothing in this module may be synthesised from phase
//  angles.
//
//  References
//    Dorn, Arnold & Pandy 2012        https://doi.org/10.1242/jeb.064527
//    Clark, Ryan & Weyand 2012        https://digitalcommons.wku.edu/ijesab/vol2/iss4/4/
//    Chang & Kram 1999                https://doi.org/10.1152/jappl.1999.86.5.1657
//    Heiderscheit et al. 2011         https://doi.org/10.1249/MSS.0b013e3181ebedf4
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var api = factory(core);
  if (isNode) module.exports = api;
  if (root) root.KFOImpulse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO) {
  'use strict';

  var CALCULATION_VERSION = 'kfo-impulse-accounting-v1.0.0';
  var DEG = 180 / Math.PI;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** Shallow merge, so the module stays in the ES5 idiom the other KFO files use. */
  function merge(a, b) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
  }

  // ── Coordinate and sign conventions ───────────────────────────────────────
  //
  // Stated once, exported, and asserted in tests. Every consumer of this module
  // reads these rather than assuming.
  var SIGN_CONVENTION = Object.freeze({
    verticalPositive: 'upward (away from the ground)',
    horizontalPositive: 'anterior — the runner\'s direction of travel',
    horizontalNegative: 'posterior — braking, opposing the direction of travel',
    note: 'Fx and Fz are GROUND-reaction components, i.e. the force the ground ' +
      'applies to the runner. Image-space +y is DOWN elsewhere in KFO; force ' +
      'series reaching this module must already be in this physical convention.'
  });

  // ── Units and bases ───────────────────────────────────────────────────────
  var IMPULSE_UNIT = Object.freeze({
    BW_SECONDS: 'BW*s',
    NEWTON_SECONDS: 'N*s',
    METERS_PER_SECOND: 'm/s'   // impulse per unit mass, i.e. a velocity change
  });

  var VERTICAL_BASIS = Object.freeze({
    TOTAL: 'total_vertical',
    EFFECTIVE: 'effective_vertical'
  });

  var HORIZONTAL_BASIS = Object.freeze({
    SIGNED_NET: 'signed_net',
    REPLACEMENT_ONLY: 'replacement_only',
    TOTAL_TURNOVER: 'total_turnover'
  });

  var COMPOSITION = Object.freeze({
    TOTAL_SUPPORT_REPLACEMENT: 'total_support_replacement',
    PROJECTION_REPLACEMENT: 'projection_replacement',
    ACTIVE_PROJECTION_TURNOVER: 'active_projection_turnover'
  });

  var COMPOSITION_ORDER = Object.freeze([
    COMPOSITION.TOTAL_SUPPORT_REPLACEMENT,
    COMPOSITION.PROJECTION_REPLACEMENT,
    COMPOSITION.ACTIVE_PROJECTION_TURNOVER
  ]);

  var STEADY_STATE = Object.freeze({
    CONSISTENT: 'steady_state_consistent',
    POSSIBLE_ACCELERATION: 'possible_acceleration',
    POSSIBLE_DECELERATION: 'possible_deceleration',
    POSSIBLE_GRADE_OR_WIND: 'possible_grade_or_wind_effect',
    ESTIMATOR_INCONSISTENCY: 'estimator_inconsistency',
    INSUFFICIENT_CONFIDENCE: 'insufficient_confidence'
  });

  var METRIC_AVAILABILITY = Object.freeze({
    AVAILABLE: 'available',
    EXPERIMENTAL: 'experimental',
    UNAVAILABLE: 'unavailable'
  });

  // ── Provisional thresholds ────────────────────────────────────────────────
  //
  // PROVISIONAL, NOT SCIENTIFIC CUTOFFS. No published threshold separates
  // "steady enough to compare" from "not"; these are internal working values
  // chosen to be conservative, and every consumer must surface
  // `isProvisional`. They exist so a plainly accelerating trial cannot be
  // silently normalised against steady-state references.
  var CONFIG = Object.freeze({
    // |JxNet| / JhTurnover above this: flag but still report.
    imbalanceWarnRatio: 0.15,
    // Above this: no normative steady-state comparison is offered at all.
    imbalanceRejectRatio: 0.30,
    // Guard for the imbalance denominator.
    epsilon: 1e-9,
    // Below this confidence the imbalance number is not trusted enough to classify.
    minConfidenceToClassify: 0.30,
    // A stance whose mean Fz is this far from 1 BW·(step/contact) is implausible.
    maxMeanVerticalForceBw: 6.0,
    minMeanVerticalForceBw: 0.8,
    minStanceSeconds: 0.05,
    maxStanceSeconds: 0.60,
    minStancesForAggregate: 3,
    isProvisional: true,
    provisionalNote: 'Thresholds are provisional internal working values, not validated ' +
      'scientific cutoffs. They gate comparison, never diagnosis.'
  });

  // ── ImpulseValue ──────────────────────────────────────────────────────────
  /**
   * A single impulse carried with everything needed to interpret it. Bare
   * numbers are never returned from this module.
   *
   * @param {number|null} value
   * @param {Object} opts {unit, normalizedToBodyWeight, method, confidence,
   *                       validationStatus, provenance, definition, symbol}
   * @returns {Object} ImpulseValue
   */
  function impulseValue(value, opts) {
    opts = opts || {};
    return {
      value: isNum(value) ? value : null,
      unit: opts.unit || IMPULSE_UNIT.BW_SECONDS,
      normalizedToBodyWeight: opts.normalizedToBodyWeight !== false,
      symbol: opts.symbol || null,
      definition: opts.definition || null,
      method: opts.method || null,
      confidence: opts.confidence || null,
      validationStatus: opts.validationStatus || KFO.VALIDATION_STATUS.UNVALIDATED,
      provenance: opts.provenance || KFO.PROVENANCE.EXPERIMENTAL
    };
  }

  var IMPULSE_DEFINITIONS = Object.freeze({
    JvTotal: 'JvTotal = ∫ Fz dt over stance — total vertical support impulse.',
    JvEffective: 'JvEffective = ∫ (Fz − bodyWeight) dt over stance — net upward ' +
      'projection/redirection impulse (Dorn et al. 2012, eqs A5–A6). NOT JvTotal.',
    JBrake: 'JBrake = −∫ Fx dt over the portions where Fx < 0 — magnitude of the ' +
      'braking (posterior) impulse. Reported as a positive magnitude.',
    JProp: 'JProp = ∫ Fx dt over the portions where Fx > 0 — propulsive impulse ' +
      'that replaces the horizontal momentum lost to braking.',
    JhTurnover: 'JhTurnover = JBrake + JProp — total fore-aft impulse turnover. ' +
      'Sums two OPPOSING directions, so it is a demand magnitude, not a vector.',
    JxNet: 'JxNet = JProp − JBrake — signed net horizontal impulse. ≈ 0 in steady ' +
      'level running; used as a quality check, not as a performance metric.',
    shares: 'verticalShare = Jv / (Jv + Jh); horizontalShare = Jh / (Jv + Jh). ' +
      'SCALAR-SUM shares. Not direction cosines, not percentages of a resultant ' +
      'vector magnitude, not energy fractions.',
    angleEquivalent: 'theta = atan(Jh / Jv), degrees. An IMPULSE-COMPONENT ANGLE ' +
      'EQUIVALENT only. It is NOT an instantaneous ground-reaction-force angle, and ' +
      'where Jh is a turnover sum it corresponds to no physical direction at all.',
    impulseVsWork: 'Impulse (∫F dt) changes momentum. Work (∫F·dx) changes energy. ' +
      'A net horizontal impulse of zero does not imply zero energy cost: braking ' +
      'does negative work and re-propulsion positive work, both metabolically costly.',
    impactVsBraking: 'The vertical impact transient is a VERTICAL early-stance ' +
      'feature (peak force, loading rate). Braking impulse is a FORE-AFT quantity. ' +
      'They are not interchangeable and are never substituted for one another.'
  });

  // ── Signed integration with zero-crossing splitting ───────────────────────
  /**
   * Trapezoidal integration of a series, split at sign changes so a sample
   * interval straddling zero contributes its braking part to braking and its
   * propulsive part to propulsion. Bucketing whole intervals by the sign of
   * their mean would leak one into the other near the crossing, which is exactly
   * where the fore-aft trace spends the most time.
   *
   * No clamping: the split is what the phase-integration definition requires.
   *
   * @param {Array<{t:number,v:number}>} pts  sorted by t
   * @returns {{negative:number, positive:number, crossings:number[],
   *            negativeRegions:Array, positiveRegions:Array}}
   */
  function integrateBySign(pts) {
    var neg = 0, pos = 0, crossings = [];
    var negRegions = [], posRegions = [];

    function addRegion(list, a, b) {
      if (!(b > a)) return;
      var last = list[list.length - 1];
      if (last && Math.abs(last.endTime - a) < 1e-12) last.endTime = b;
      else list.push({ startTime: a, endTime: b });
    }

    for (var i = 1; i < pts.length; i++) {
      var t0 = pts[i - 1].t, t1 = pts[i].t;
      var v0 = pts[i - 1].v, v1 = pts[i].v;
      var dt = t1 - t0;
      if (!(dt > 0)) continue;

      if ((v0 < 0 && v1 > 0) || (v0 > 0 && v1 < 0)) {
        var tc = t0 + dt * (v0 / (v0 - v1));   // linear zero crossing
        crossings.push(tc);
        var a1 = 0.5 * v0 * (tc - t0);
        var a2 = 0.5 * v1 * (t1 - tc);
        if (a1 < 0) { neg += -a1; addRegion(negRegions, t0, tc); } else { pos += a1; addRegion(posRegions, t0, tc); }
        if (a2 < 0) { neg += -a2; addRegion(negRegions, tc, t1); } else { pos += a2; addRegion(posRegions, tc, t1); }
      } else {
        var area = (v0 + v1) / 2 * dt;
        if (area < 0) { neg += -area; addRegion(negRegions, t0, t1); }
        else if (area > 0) { pos += area; addRegion(posRegions, t0, t1); }
      }
    }
    return {
      negative: neg, positive: pos, crossings: crossings,
      negativeRegions: negRegions, positiveRegions: posRegions
    };
  }

  /** Plain trapezoidal integral, no sign splitting. */
  function integrate(pts) {
    var sum = 0;
    for (var i = 1; i < pts.length; i++) {
      var dt = pts[i].t - pts[i - 1].t;
      if (dt > 0) sum += (pts[i].v + pts[i - 1].v) / 2 * dt;
    }
    return sum;
  }

  // ── Stance integration ────────────────────────────────────────────────────
  /**
   * All six impulse quantities for ONE stance phase from a real force-time
   * series. There is no path into this function from geometry.
   *
   * @param {Array<{t:number,fx:number,fz:number}>} series  one stance phase
   * @param {Object} opts
   * @param {number|null} opts.bodyWeight  1 if normalized, newtons otherwise
   * @param {boolean} opts.normalizedToBodyWeight
   * @param {string} opts.method  one of KFO.METHOD
   * @param {Object} [opts.confidence]
   * @param {string} [opts.side]
   * @param {number} [opts.strideIndex]
   * @returns {Object} StanceImpulses, or an unavailable envelope
   */
  function integrateStance(series, opts) {
    opts = opts || {};
    var normalized = opts.normalizedToBodyWeight !== false;
    var unit = opts.unit || (normalized ? IMPULSE_UNIT.BW_SECONDS : IMPULSE_UNIT.NEWTON_SECONDS);
    var bw = isNum(opts.bodyWeight) ? opts.bodyWeight : (normalized ? 1 : null);

    var pts = (series || []).filter(function (p) {
      return p && isNum(p.t) && isNum(p.fx) && isNum(p.fz);
    }).sort(function (a, b) { return a.t - b.t; });

    if (pts.length < 3) {
      return unavailableStance('insufficient_force_samples', opts);
    }
    var stanceStart = pts[0].t, stanceEnd = pts[pts.length - 1].t;
    var stanceDuration = stanceEnd - stanceStart;
    if (!(stanceDuration > 0)) {
      return unavailableStance('non_positive_stance_duration', opts);
    }
    if (bw == null) {
      // Without a bodyweight reference JvEffective is undefined. Refuse rather
      // than fall back to JvTotal, which would silently change the metric.
      return unavailableStance('body_weight_reference_unavailable', opts);
    }

    var fz = pts.map(function (p) { return { t: p.t, v: p.fz }; });
    var fx = pts.map(function (p) { return { t: p.t, v: p.fx }; });

    var jvTotal = integrate(fz);
    var jvEffectiveDirect = integrate(pts.map(function (p) { return { t: p.t, v: p.fz - bw }; }));
    var horiz = integrateBySign(fx);
    var jBrake = horiz.negative;
    var jProp = horiz.positive;

    // The BW-normalized shortcut JvEffective = JvTotal − stanceDuration is only
    // valid when the series really is normalized. It is computed as a DIAGNOSTIC
    // cross-check of the direct integration, never as the reported value.
    var shortcut = normalized && Math.abs(bw - 1) < 1e-9
      ? jvTotal - stanceDuration
      : jvTotal - bw * stanceDuration;
    var meanFz = jvTotal / stanceDuration;

    var aboveBw = integrateBySign(pts.map(function (p) { return { t: p.t, v: p.fz - bw }; }));

    var plausibility = assessStancePlausibility({
      meanVerticalForceBw: meanFz / bw,
      stanceDuration: stanceDuration,
      jvTotal: jvTotal
    });

    return {
      availability: plausibility.ok ? METRIC_AVAILABILITY.EXPERIMENTAL : METRIC_AVAILABILITY.UNAVAILABLE,
      reason: plausibility.ok ? null : plausibility.reason,
      isPlausible: plausibility.ok,
      plausibility: plausibility,
      method: opts.method || null,
      calculationVersion: CALCULATION_VERSION,
      side: opts.side || null,
      strideIndex: isNum(opts.strideIndex) ? opts.strideIndex : null,
      unit: unit,
      normalizedToBodyWeight: normalized,
      bodyWeightReference: bw,
      stanceStartSeconds: stanceStart,
      stanceEndSeconds: stanceEnd,
      stanceDurationSeconds: stanceDuration,
      sampleCount: pts.length,
      sampleRateHz: (pts.length - 1) / stanceDuration,
      meanVerticalForce: meanFz,
      meanVerticalForceBw: meanFz / bw,

      JvTotal: jvTotal,
      JvEffective: jvEffectiveDirect,
      JBrake: jBrake,
      JProp: jProp,
      JhTurnover: jBrake + jProp,
      JxNet: jProp - jBrake,

      // Both the integration result and the reconstruction are retained, per the
      // requirement that a diagnostic reconstruction never replaces the direct
      // value.
      diagnostics: {
        JvEffectiveDirectIntegration: jvEffectiveDirect,
        JvEffectiveShortcutReconstruction: shortcut,
        JvEffectiveShortcutDelta: jvEffectiveDirect - shortcut,
        shortcutValidWhen: 'series is bodyweight-normalized and stance bounds are exact',
        fxZeroCrossings: horiz.crossings,
        integrationRegions: {
          stance: { startTime: stanceStart, endTime: stanceEnd },
          bodyWeightLine: bw,
          braking: horiz.negativeRegions,
          propulsive: horiz.positiveRegions,
          aboveBodyWeight: aboveBw.positiveRegions,
          belowBodyWeight: aboveBw.negativeRegions
        }
      }
    };
  }

  function unavailableStance(reason, opts) {
    opts = opts || {};
    return {
      availability: METRIC_AVAILABILITY.UNAVAILABLE,
      reason: reason,
      isPlausible: false,
      method: opts.method || null,
      calculationVersion: CALCULATION_VERSION,
      side: opts.side || null,
      strideIndex: isNum(opts.strideIndex) ? opts.strideIndex : null,
      JvTotal: null, JvEffective: null, JBrake: null, JProp: null,
      JhTurnover: null, JxNet: null,
      stanceDurationSeconds: null
    };
  }

  /**
   * Reject implausible stances rather than aggregating them. A stance whose mean
   * vertical force is below bodyweight cannot be a running contact: over one step
   * the mean must exceed 1 BW by exactly 1/dutyFactor.
   */
  function assessStancePlausibility(x) {
    var m = x.meanVerticalForceBw;
    if (!isNum(m)) return { ok: false, reason: 'mean_vertical_force_unavailable' };
    if (!isNum(x.stanceDuration) || x.stanceDuration <= 0) {
      return { ok: false, reason: 'non_positive_stance_duration' };
    }
    if (x.stanceDuration < CONFIG.minStanceSeconds || x.stanceDuration > CONFIG.maxStanceSeconds) {
      return { ok: false, reason: 'stance_duration_out_of_running_range',
               stanceDurationSeconds: x.stanceDuration };
    }
    if (m < CONFIG.minMeanVerticalForceBw) {
      return { ok: false, reason: 'mean_vertical_force_below_body_weight', meanVerticalForceBw: m };
    }
    if (m > CONFIG.maxMeanVerticalForceBw) {
      return { ok: false, reason: 'implausible_mean_vertical_force', meanVerticalForceBw: m };
    }
    return { ok: true, reason: null, meanVerticalForceBw: m };
  }

  // ── The three compositions ────────────────────────────────────────────────
  var COMPOSITION_SPEC = Object.freeze({
    total_support_replacement: Object.freeze({
      id: COMPOSITION.TOTAL_SUPPORT_REPLACEMENT,
      label: 'Total Support / Replacement',
      verticalBasis: VERTICAL_BASIS.TOTAL,
      horizontalBasis: HORIZONTAL_BASIS.REPLACEMENT_ONLY,
      numeratorLabel: 'Total vertical impulse (JvTotal)',
      denominatorLabel: 'JvTotal + propulsive replacement impulse (JProp)',
      interpretation: 'Total vertical support impulse relative to the positive horizontal ' +
        'impulse that replaces braking losses. Values near the familiar 85/15 range appear ' +
        'in fast running data because the vertical term is dominated by holding bodyweight up.',
      disclaimer: 'Includes the vertical impulse required to support body weight during contact.',
      limitations: [
        'Dominated by bodyweight support, not by force the runner modulates',
        'Must not be presented as active-force efficiency',
        'Scalar-sum share, not a direction cosine'
      ]
    }),
    projection_replacement: Object.freeze({
      id: COMPOSITION.PROJECTION_REPLACEMENT,
      label: 'Projection / Replacement',
      verticalBasis: VERTICAL_BASIS.EFFECTIVE,
      horizontalBasis: HORIZONTAL_BASIS.REPLACEMENT_ONLY,
      numeratorLabel: 'Effective vertical impulse (JvEffective = ∫(Fz − BW) dt)',
      denominatorLabel: 'JvEffective + propulsive replacement impulse (JProp)',
      interpretation: 'Net upward projection impulse compared with the positive horizontal ' +
        'impulse needed to restore braking losses. This is the metric closest to the coaching ' +
        'concept under discussion, and it is a candidate research metric only.',
      disclaimer: 'Excludes the bodyweight-support portion of the vertical impulse. ' +
        'Not a validated efficiency score.',
      limitations: [
        'Candidate research metric, not metabolically validated',
        'Sensitive to stance-boundary detection, because JvEffective subtracts BW × stance duration',
        'Scalar-sum share, not a direction cosine'
      ]
    }),
    active_projection_turnover: Object.freeze({
      id: COMPOSITION.ACTIVE_PROJECTION_TURNOVER,
      label: 'Active Projection / Fore-Aft Turnover',
      verticalBasis: VERTICAL_BASIS.EFFECTIVE,
      horizontalBasis: HORIZONTAL_BASIS.TOTAL_TURNOVER,
      numeratorLabel: 'Effective vertical impulse (JvEffective)',
      denominatorLabel: 'JvEffective + braking + propulsive impulse (JBrake + JProp)',
      interpretation: 'Effective upward projection compared with total braking and ' +
        're-propulsion turnover. This captures total fore-aft impulse demand most fully and ' +
        'is the candidate momentum-preservation metric.',
      disclaimer: 'Counts braking and propulsion separately, so the horizontal term is ' +
        'roughly double the replacement-only term. Not a direct measure of running economy.',
      limitations: [
        'Horizontal term sums two opposing directions; the angle equivalent is not a vector angle',
        'Not a measure of running economy until metabolically validated',
        'Scalar-sum share, not a direction cosine'
      ]
    })
  });

  /**
   * One accounting composition. `ratioVerticalToHorizontal` and
   * `angleEquivalentDegrees` are null when the horizontal term is zero — no
   * division, no Infinity leaking into a rendered value.
   *
   * @param {string} id  one of COMPOSITION
   * @param {Object} impulses  a StanceImpulses or aggregate with the six fields
   * @param {Object} [ctx] {method, confidence, unit, normalizedToBodyWeight,
   *                        validationStatus, availability}
   */
  function buildComposition(id, impulses, ctx) {
    ctx = ctx || {};
    var spec = COMPOSITION_SPEC[id];
    if (!spec) return null;

    var vertical = spec.verticalBasis === VERTICAL_BASIS.TOTAL ? impulses && impulses.JvTotal
                                                               : impulses && impulses.JvEffective;
    var horizontal = spec.horizontalBasis === HORIZONTAL_BASIS.TOTAL_TURNOVER
      ? (impulses && impulses.JhTurnover)
      : (impulses && impulses.JProp);

    var unit = ctx.unit || (impulses && impulses.unit) || IMPULSE_UNIT.BW_SECONDS;
    var normalized = ctx.normalizedToBodyWeight != null
      ? ctx.normalizedToBodyWeight
      : (impulses ? impulses.normalizedToBodyWeight !== false : true);
    var vOpts = {
      unit: unit, normalizedToBodyWeight: normalized, method: ctx.method || (impulses && impulses.method),
      confidence: ctx.confidence || null,
      validationStatus: ctx.validationStatus || KFO.VALIDATION_STATUS.UNVALIDATED,
      provenance: ctx.provenance || KFO.PROVENANCE.EXPERIMENTAL
    };

    var base = {
      id: spec.id,
      label: spec.label,
      verticalBasis: spec.verticalBasis,
      horizontalBasis: spec.horizontalBasis,
      numeratorLabel: spec.numeratorLabel,
      denominatorLabel: spec.denominatorLabel,
      interpretation: spec.interpretation,
      disclaimer: spec.disclaimer,
      limitations: spec.limitations.slice(),
      calculationVersion: CALCULATION_VERSION,
      isEfficiencyValidated: false
    };

    if (!isNum(vertical) || !isNum(horizontal)) {
      base.availability = METRIC_AVAILABILITY.UNAVAILABLE;
      base.availabilityReason = (impulses && impulses.reason) || 'impulse_inputs_unavailable';
      base.verticalImpulse = impulseValue(null, vOpts);
      base.horizontalImpulse = impulseValue(null, vOpts);
      base.verticalShareScalarSum = null;
      base.horizontalShareScalarSum = null;
      base.ratioVerticalToHorizontal = null;
      base.angleEquivalentDegrees = null;
      return base;
    }

    var denom = vertical + horizontal;
    base.availability = ctx.availability || METRIC_AVAILABILITY.EXPERIMENTAL;
    base.availabilityReason = ctx.availabilityReason || null;
    base.verticalImpulse = impulseValue(vertical, merge(vOpts, {
      symbol: spec.verticalBasis === VERTICAL_BASIS.TOTAL ? 'JvTotal' : 'JvEffective',
      definition: spec.verticalBasis === VERTICAL_BASIS.TOTAL
        ? IMPULSE_DEFINITIONS.JvTotal : IMPULSE_DEFINITIONS.JvEffective
    }));
    base.horizontalImpulse = impulseValue(horizontal, merge(vOpts, {
      symbol: spec.horizontalBasis === HORIZONTAL_BASIS.TOTAL_TURNOVER ? 'JhTurnover' : 'JProp',
      definition: spec.horizontalBasis === HORIZONTAL_BASIS.TOTAL_TURNOVER
        ? IMPULSE_DEFINITIONS.JhTurnover : IMPULSE_DEFINITIONS.JProp
    }));
    base.verticalShareScalarSum = Math.abs(denom) > CONFIG.epsilon ? vertical / denom : null;
    base.horizontalShareScalarSum = Math.abs(denom) > CONFIG.epsilon ? horizontal / denom : null;
    base.ratioVerticalToHorizontal = Math.abs(horizontal) > CONFIG.epsilon ? vertical / horizontal : null;
    base.angleEquivalentDegrees = Math.abs(vertical) > CONFIG.epsilon
      ? Math.atan(horizontal / vertical) * DEG : null;
    base.shareConvention = 'scalar_sum_share';
    base.angleEquivalentConvention = 'impulse_component_angle_equivalent_not_grf_angle';
    return base;
  }

  /** All three compositions for one set of impulses. */
  function buildCompositions(impulses, ctx) {
    var out = {};
    COMPOSITION_ORDER.forEach(function (id) {
      out[camel(id)] = buildComposition(id, impulses, ctx);
    });
    return out;
  }

  function camel(snake) {
    return String(snake).replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  // ── Steady-state quality control ──────────────────────────────────────────
  /**
   * `JxNet` is used ONLY as a quality check. Near-zero net horizontal impulse is
   * the expected condition at steady level speed, not an achievement, and a
   * large value is a reason to distrust the comparison rather than a finding
   * about the runner.
   *
   * @param {Object} impulses  aggregate or single-stance impulses
   * @param {Object} [ctx] {confidenceScore, gradeKnown, speedKnown, config}
   */
  function classifySteadyState(impulses, ctx) {
    ctx = ctx || {};
    var cfg = ctx.config || CONFIG;
    var jxNet = impulses && impulses.JxNet;
    var turnover = impulses && impulses.JhTurnover;

    var out = {
      availability: METRIC_AVAILABILITY.UNAVAILABLE,
      state: STEADY_STATE.INSUFFICIENT_CONFIDENCE,
      JxNet: isNum(jxNet) ? jxNet : null,
      JhTurnover: isNum(turnover) ? turnover : null,
      horizontalImpulseImbalance: null,
      warnThreshold: cfg.imbalanceWarnRatio,
      rejectThreshold: cfg.imbalanceRejectRatio,
      isProvisional: true,
      provisionalNote: cfg.provisionalNote,
      normativeComparisonAllowed: false,
      interpretation: null
    };

    if (!isNum(jxNet) || !isNum(turnover)) {
      out.reason = 'horizontal_impulses_unavailable';
      out.interpretation = 'Signed net horizontal impulse could not be computed, so steady-state ' +
        'consistency cannot be checked.';
      return out;
    }

    var imbalance = Math.abs(jxNet) / Math.max(turnover, cfg.epsilon);
    out.horizontalImpulseImbalance = imbalance;
    out.availability = METRIC_AVAILABILITY.EXPERIMENTAL;

    if (isNum(ctx.confidenceScore) && ctx.confidenceScore < cfg.minConfidenceToClassify) {
      out.state = STEADY_STATE.INSUFFICIENT_CONFIDENCE;
      out.interpretation = 'Estimator confidence is too low to interpret the horizontal impulse balance.';
      return out;
    }

    if (imbalance <= cfg.imbalanceWarnRatio) {
      out.state = STEADY_STATE.CONSISTENT;
      out.normativeComparisonAllowed = true;
      out.interpretation = 'Braking and propulsive impulses are close to balanced, which is consistent ' +
        'with steady level running. This is an expected condition, not a performance result.';
      return out;
    }

    // Beyond the reject threshold no single cause can be identified from the
    // trace alone, so every plausible cause is named rather than one guessed at.
    if (imbalance > cfg.imbalanceRejectRatio) {
      out.state = jxNet > 0 ? STEADY_STATE.POSSIBLE_ACCELERATION : STEADY_STATE.POSSIBLE_DECELERATION;
      out.interpretation = 'Horizontal impulse is inconsistent with steady-speed assumptions ' +
        '(imbalance ' + (imbalance * 100).toFixed(0) + '%). Check acceleration state, event detection, ' +
        'grade, wind and estimator quality. Normative comparison is withheld.';
      out.candidateCauses = ['acceleration_or_deceleration', 'grade', 'wind_or_drag',
                             'stance_boundary_error', 'estimator_bias'];
      return out;
    }

    // Between warn and reject: report, allow comparison, but name the ambiguity.
    if (!ctx.gradeKnown || !ctx.speedKnown) {
      out.state = STEADY_STATE.POSSIBLE_GRADE_OR_WIND;
      out.normativeComparisonAllowed = true;
      out.interpretation = 'A modest horizontal imbalance was seen. Grade and speed are not captured ' +
        'in this pipeline, so a gradient, wind or a small speed change cannot be ruled out.';
      return out;
    }
    out.state = jxNet > 0 ? STEADY_STATE.POSSIBLE_ACCELERATION : STEADY_STATE.POSSIBLE_DECELERATION;
    out.normativeComparisonAllowed = true;
    out.interpretation = 'A modest signed net horizontal impulse was seen, consistent with a small ' +
      'speed change across the clip.';
    return out;
  }

  // ── Vertical impact partition ─────────────────────────────────────────────
  //
  // The landing phase is PARTITIONED, never deleted and never subtracted as a
  // generic "impact component". These four fields describe the vertical impact
  // transient and are kept unavailable unless a force source can actually
  // resolve them: an instantaneous loading rate needs sampling in the hundreds
  // of hertz, which neither 30–60 fps video nor a doubly-differentiated COM
  // trajectory provides.
  var IMPACT_MIN_SAMPLE_RATE_HZ = 200;

  function impactMetrics(input) {
    input = input || {};
    var rate = input.sampleRateHz;
    var validated = !!input.isForceMeasurementValidated;
    var base = {
      verticalImpactPeak: null,
      verticalAverageLoadingRate: null,
      verticalInstantaneousLoadingRate: null,
      impactTransientDetected: null,
      minimumSampleRateHz: IMPACT_MIN_SAMPLE_RATE_HZ,
      partitionedNotRemoved: true,
      isBrakingImpulse: false,
      notEquivalentTo: IMPULSE_DEFINITIONS.impactVsBraking,
      definitions: {
        verticalImpactPeak: 'First (impact) peak of Fz during early stance, in BW.',
        verticalAverageLoadingRate: 'Mean dFz/dt between 20% and 80% of the impact peak, BW/s.',
        verticalInstantaneousLoadingRate: 'Maximum dFz/dt before the impact peak, BW/s.',
        impactTransientDetected: 'Whether a distinct early-stance vertical peak is resolvable at all.'
      }
    };
    if (!validated) {
      base.availability = METRIC_AVAILABILITY.UNAVAILABLE;
      base.reason = 'impact_metrics_require_a_validated_high_rate_force_source';
      return base;
    }
    if (!isNum(rate) || rate < IMPACT_MIN_SAMPLE_RATE_HZ) {
      base.availability = METRIC_AVAILABILITY.UNAVAILABLE;
      base.reason = 'sample_rate_too_low_for_impact_metrics';
      base.sampleRateHz = isNum(rate) ? rate : null;
      return base;
    }
    base.availability = METRIC_AVAILABILITY.UNAVAILABLE;
    base.reason = 'impact_metric_extraction_not_implemented';
    base.sampleRateHz = rate;
    return base;
  }

  // ── Aggregation across stances ────────────────────────────────────────────
  var IMPULSE_FIELDS = Object.freeze(['JvTotal', 'JvEffective', 'JBrake', 'JProp', 'JhTurnover', 'JxNet']);

  /**
   * Aggregate per-stance impulses. Shares are computed PER STANCE and then
   * aggregated, never recomputed from aggregate impulses: a share is a nonlinear
   * function of its inputs, so the share of the means is not the mean of the
   * shares (the same Jensen's-inequality discipline the timing force estimate
   * follows). The pooled value is retained as a diagnostic.
   *
   * Implausible stances are excluded from the aggregate and counted, not dropped
   * silently.
   */
  function aggregateStances(stances, ctx) {
    ctx = ctx || {};
    var all = (stances || []).filter(Boolean);
    var usable = all.filter(function (s) {
      return s.isPlausible && IMPULSE_FIELDS.every(function (f) { return isNum(s[f]); });
    });
    var rejected = all.filter(function (s) { return usable.indexOf(s) === -1; })
      .map(function (s) {
        return { side: s.side, strideIndex: s.strideIndex, reason: s.reason || 'implausible_stance' };
      });

    var out = {
      availability: METRIC_AVAILABILITY.UNAVAILABLE,
      reason: null,
      method: ctx.method || (usable[0] && usable[0].method) || null,
      calculationVersion: CALCULATION_VERSION,
      unit: (usable[0] && usable[0].unit) || ctx.unit || IMPULSE_UNIT.BW_SECONDS,
      normalizedToBodyWeight: usable[0] ? usable[0].normalizedToBodyWeight !== false : true,
      stancesAnalyzed: usable.length,
      stancesRejected: rejected.length,
      rejections: rejected,
      signConvention: SIGN_CONVENTION
    };

    if (usable.length < CONFIG.minStancesForAggregate) {
      out.reason = usable.length ? 'insufficient_stances_for_aggregate' : 'no_plausible_stances';
      IMPULSE_FIELDS.forEach(function (f) { out[f] = null; out[f + 'Aggregate'] = null; });
      out.compositions = buildCompositions(out, { method: out.method, availability: METRIC_AVAILABILITY.UNAVAILABLE });
      out.steadyStateConsistency = classifySteadyState(out, ctx);
      out.impact = impactMetrics(ctx);
      return out;
    }

    // `available` is reserved for a force source that has actually passed
    // criterion validation. Everything else — including a source that merely
    // declares itself validated — stays `experimental`.
    out.availability = ctx.isForceMeasurementValidated
      ? METRIC_AVAILABILITY.AVAILABLE : METRIC_AVAILABILITY.EXPERIMENTAL;
    IMPULSE_FIELDS.forEach(function (f) {
      var agg = KFO.aggregate(usable.map(function (s) { return s[f]; }));
      out[f + 'Aggregate'] = agg;
      out[f] = agg.median;
    });
    out.stanceDurationSecondsAggregate = KFO.aggregate(usable.map(function (s) { return s.stanceDurationSeconds; }));
    out.meanVerticalForceBwAggregate = KFO.aggregate(usable.map(function (s) { return s.meanVerticalForceBw; }));

    // Per-stance compositions, then aggregate the shares.
    var perStance = usable.map(function (s) {
      return { impulses: s, compositions: buildCompositions(s, { method: s.method, confidence: ctx.confidence }) };
    });
    out.compositions = {};
    COMPOSITION_ORDER.forEach(function (id) {
      var key = camel(id);
      var vShares = perStance.map(function (p) {
        return p.compositions[key] ? p.compositions[key].verticalShareScalarSum : null;
      });
      var pooled = buildComposition(id, out, {
        method: out.method, confidence: ctx.confidence,
        unit: out.unit, normalizedToBodyWeight: out.normalizedToBodyWeight,
        availability: out.availability,
        validationStatus: ctx.isForceMeasurementValidated
          ? KFO.VALIDATION_STATUS.FORCE_PLATE_VALIDATED : KFO.VALIDATION_STATUS.UNVALIDATED,
        provenance: ctx.isForceMeasurementValidated
          ? KFO.PROVENANCE.MEASURED : KFO.PROVENANCE.EXPERIMENTAL
      });
      var shareAgg = KFO.aggregate(vShares);
      // Reported share is the per-stance median; the pooled value stays visible.
      if (isNum(shareAgg.median)) {
        pooled.verticalShareScalarSum = shareAgg.median;
        pooled.horizontalShareScalarSum = 1 - shareAgg.median;
        pooled.ratioVerticalToHorizontal = shareAgg.median < 1
          ? shareAgg.median / (1 - shareAgg.median) : null;
        pooled.angleEquivalentDegrees = shareAgg.median > 0
          ? Math.atan((1 - shareAgg.median) / shareAgg.median) * DEG : null;
      }
      pooled.verticalShareAggregate = shareAgg;
      pooled.aggregationNote = 'Share is the median of per-stance shares, not a share of the median ' +
        'impulses; a share is nonlinear in its inputs.';
      pooled.pooledFromAggregateImpulses = {
        note: 'Diagnostic only — computed from aggregate impulses rather than per stance.',
        verticalShareScalarSum: (function () {
          var v = id === COMPOSITION.TOTAL_SUPPORT_REPLACEMENT ? out.JvTotal : out.JvEffective;
          var h = id === COMPOSITION.ACTIVE_PROJECTION_TURNOVER ? out.JhTurnover : out.JProp;
          return (isNum(v) && isNum(h) && Math.abs(v + h) > CONFIG.epsilon) ? v / (v + h) : null;
        })()
      };
      out.compositions[key] = pooled;
    });

    out.perStance = usable;
    out.steadyStateConsistency = classifySteadyState(out, ctx);
    out.impact = impactMetrics(ctx);
    out.definitions = IMPULSE_DEFINITIONS;
    return out;
  }

  /** Combine both sides' stance lists into one aggregate. */
  function combineSides(left, right, ctx) {
    var stances = [].concat((left && left.perStance) || [], (right && right.perStance) || []);
    return aggregateStances(stances, ctx);
  }

  // ── Unavailable envelope (geometry-only path) ──────────────────────────────
  /**
   * The shape returned whenever force magnitude is absent. Every impulse field
   * is null with a reason — never zero, because a zero would aggregate and
   * compare as if it were a measurement.
   */
  function unavailableImpulseMetrics(reason, ctx) {
    ctx = ctx || {};
    var envelope = {
      availability: METRIC_AVAILABILITY.UNAVAILABLE,
      reason: reason || 'geometry_proxy_does_not_estimate_force_magnitude_or_impulse',
      method: ctx.method || KFO.METHOD.GEOMETRY_PROXY,
      calculationVersion: CALCULATION_VERSION,
      isEfficiencyValidated: false,
      signConvention: SIGN_CONVENTION,
      definitions: IMPULSE_DEFINITIONS,
      requires: ['force magnitude over time', 'stance boundaries', 'a bodyweight reference'],
      note: 'Force and impulse percentages require force magnitude and are not available from ' +
        'geometry-only video.'
    };
    IMPULSE_FIELDS.forEach(function (f) { envelope[f] = null; envelope[f + 'Aggregate'] = null; });
    envelope.compositions = buildCompositions(envelope, {
      method: envelope.method, availability: METRIC_AVAILABILITY.UNAVAILABLE,
      availabilityReason: envelope.reason
    });
    envelope.steadyStateConsistency = classifySteadyState(envelope, ctx);
    envelope.impact = impactMetrics(ctx);
    envelope.perSide = { left: null, right: null };
    // `combined` carries the same null-filled shape rather than being null itself.
    // A consumer reading `combined.JvEffective` then gets an honest null instead of
    // a TypeError, which is the difference between a renderer that says "not
    // available" and one that throws on the geometry-only path.
    envelope.combined = {
      availability: envelope.availability,
      reason: envelope.reason,
      method: envelope.method,
      stancesAnalyzed: 0,
      stancesRejected: 0,
      compositions: envelope.compositions
    };
    IMPULSE_FIELDS.forEach(function (f) {
      envelope.combined[f] = null;
      envelope.combined[f + 'Aggregate'] = null;
    });
    envelope.momentumPreservation = momentumPreservation(null, ctx);
    return envelope;
  }

  // ── Momentum-preservation interpretation layer ─────────────────────────────
  function assessment(opts) {
    opts = opts || {};
    return {
      availability: opts.availability || METRIC_AVAILABILITY.UNAVAILABLE,
      value: isNum(opts.value) ? opts.value : null,
      unit: opts.unit || null,
      descriptor: opts.descriptor || null,
      basis: opts.basis || null,
      confidence: opts.confidence == null ? null : opts.confidence,
      note: opts.note || null,
      isEfficiencyValidated: false
    };
  }

  /**
   * Reads braking, replacement and turnover as ONE pattern, the same way the
   * geometry-only coupled classifier does. Low turnover is never asserted to be
   * more economical: no metabolic measurement exists to support that.
   *
   * @param {Object|null} impulses  aggregate impulses (combined)
   * @param {Object} [ctx] {confidenceScore, symmetry, strideVariability,
   *                        speedStateConfidence, longitudinal}
   */
  function momentumPreservation(impulses, ctx) {
    ctx = ctx || {};
    var out = {
      availability: METRIC_AVAILABILITY.UNAVAILABLE,
      calculationVersion: CALCULATION_VERSION,
      brakingDemand: assessment({ basis: 'JBrake' }),
      replacementDemand: assessment({ basis: 'JProp' }),
      foreAftTurnover: assessment({ basis: 'JhTurnover' }),
      effectiveProjection: assessment({ basis: 'JvEffective' }),
      steadyStateConsistency: assessment({ basis: 'JxNet / JhTurnover' }),
      leftRightAsymmetry: assessment({ basis: 'per-side JhTurnover difference' }),
      interpretation: [],
      isEfficiencyValidated: false,
      validationStatus: KFO.VALIDATION_STATUS.UNVALIDATED
    };

    if (!impulses || impulses.availability === METRIC_AVAILABILITY.UNAVAILABLE) {
      out.reason = (impulses && impulses.reason) ||
        'geometry_proxy_does_not_estimate_force_magnitude_or_impulse';
      out.interpretation = ['Impulse quantities are unavailable, so the momentum-preservation ' +
        'reading is limited to the geometric proxies reported separately.'];
      return out;
    }

    var unit = impulses.unit || IMPULSE_UNIT.BW_SECONDS;
    var conf = isNum(ctx.confidenceScore) ? ctx.confidenceScore : null;
    out.availability = METRIC_AVAILABILITY.EXPERIMENTAL;

    out.brakingDemand = assessment({
      availability: METRIC_AVAILABILITY.EXPERIMENTAL, value: impulses.JBrake, unit: unit,
      basis: 'JBrake', confidence: conf,
      note: 'Magnitude of the posterior impulse during stance.'
    });
    out.replacementDemand = assessment({
      availability: METRIC_AVAILABILITY.EXPERIMENTAL, value: impulses.JProp, unit: unit,
      basis: 'JProp', confidence: conf,
      note: 'Positive horizontal impulse restoring the momentum lost to braking.'
    });
    out.foreAftTurnover = assessment({
      availability: METRIC_AVAILABILITY.EXPERIMENTAL, value: impulses.JhTurnover, unit: unit,
      basis: 'JBrake + JProp', confidence: conf,
      note: 'Total fore-aft impulse demand per stance. A demand magnitude, not a vector.'
    });
    out.effectiveProjection = assessment({
      availability: METRIC_AVAILABILITY.EXPERIMENTAL, value: impulses.JvEffective, unit: unit,
      basis: '∫(Fz − BW) dt', confidence: conf,
      note: 'Net upward projection impulse (Dorn et al. 2012 eqs A5–A6).'
    });

    var ss = impulses.steadyStateConsistency || classifySteadyState(impulses, ctx);
    out.steadyStateConsistency = assessment({
      availability: ss.availability, value: ss.horizontalImpulseImbalance,
      unit: 'ratio', basis: 'abs(JxNet) / JhTurnover', descriptor: ss.state,
      confidence: conf, note: ss.interpretation
    });

    if (ctx.symmetry && isNum(ctx.symmetry.turnoverDifference)) {
      out.leftRightAsymmetry = assessment({
        availability: METRIC_AVAILABILITY.EXPERIMENTAL, value: ctx.symmetry.turnoverDifference,
        unit: unit, basis: 'left JhTurnover − right JhTurnover', confidence: conf,
        note: 'Side difference in fore-aft turnover.'
      });
    }
    if (ctx.strideVariability) out.strideVariability = ctx.strideVariability;
    if (ctx.speedStateConfidence != null) out.speedStateConfidence = ctx.speedStateConfidence;
    if (ctx.longitudinal) out.longitudinalChange = ctx.longitudinal;

    out.projectionReplacementComposition = impulses.compositions
      ? impulses.compositions.projectionReplacement : null;
    out.activeProjectionTurnoverComposition = impulses.compositions
      ? impulses.compositions.activeProjectionTurnover : null;

    // ── Narrative, in the coupled-pattern spirit ────────────────────────────
    var brake = impulses.JBrake, prop = impulses.JProp, turnover = impulses.JhTurnover;
    var imbalance = ss.horizontalImpulseImbalance;
    var lines = [];

    if (ss.state === STEADY_STATE.CONSISTENT) {
      // Braking and propulsion match, so the pattern is read off turnover only.
      // Bands are relative to the observed distribution, not a universal cutoff.
      var ref = ctx.turnoverReference;
      var high = isNum(ref) && isNum(turnover) ? turnover > ref : null;
      if (high === true) {
        lines.push('Elevated braking and propulsive replacement demand. The runner is restoring more ' +
          'horizontal momentum each stance cycle.');
      } else if (high === false) {
        lines.push('Low fore-aft impulse turnover at this speed. This may indicate good momentum ' +
          'preservation, but metabolic efficiency has not been directly measured.');
      } else {
        lines.push('Braking and propulsive replacement impulses are balanced, as expected at steady ' +
          'speed. There is no reference distribution yet to say whether the turnover magnitude is ' +
          'high or low for this speed.');
      }
    } else if (isNum(imbalance) && isNum(brake) && isNum(prop)) {
      if (brake > prop) {
        lines.push('Horizontal impulse is inconsistent with steady-speed assumptions: braking exceeds ' +
          'propulsion. Check acceleration state, event detection, grade, wind and estimator quality.');
      } else {
        lines.push('Positive net horizontal impulse may indicate acceleration or estimator imbalance.');
      }
    }

    if (ctx.geometryPattern === KFO.COUPLED_PATTERN.LOW_EXCURSION && isNum(turnover) &&
        isNum(ctx.turnoverReference) && turnover > ctx.turnoverReference) {
      lines.push('Kinematic alignment appears favourable, but estimated fore-aft impulse demand remains ' +
        'elevated. Geometry alone may not capture the full kinetic pattern.');
    }

    lines.push('These are experimental force estimates. Lower turnover is not established as more ' +
      'economical; that requires metabolic validation.');
    out.interpretation = lines;
    return out;
  }

  // ── Accounting example reconstruction (fixtures and documentation) ─────────
  /**
   * Rebuild the six impulse quantities from published rounded MEANS, the way the
   * Clark/Ryan/Weyand conference values are reconstructed in the documentation.
   *
   * This is an ACCOUNTING EXAMPLE, not a measurement and not a normative target.
   * It exists so the three compositions can be tested against arithmetic that a
   * reader can follow, and it marks itself as such in its output.
   *
   * @param {Object} m
   * @param {number} m.averageVerticalForceBw     mean Fz over contact, BW
   * @param {number} m.totalVerticalImpulseBwSeconds  JvTotal, BW·s
   * @param {number} m.phaseHorizontalImpulseBwSeconds  one-phase |Jh|, BW·s
   * @param {string} [m.label]
   */
  function fromNormalizedMeans(m) {
    m = m || {};
    var fvAvg = m.averageVerticalForceBw;
    var jvTotal = m.totalVerticalImpulseBwSeconds;
    var jhPhase = m.phaseHorizontalImpulseBwSeconds;
    if (!isNum(fvAvg) || fvAvg <= 0 || !isNum(jvTotal) || jvTotal <= 0 || !isNum(jhPhase) || jhPhase < 0) {
      return unavailableStance('invalid_reconstruction_inputs', { method: KFO.METHOD.VALIDATED_GRF });
    }
    var contact = jvTotal / fvAvg;
    // Normalized units: bodyWeight = 1 BW, so JvEffective = JvTotal − contactTime.
    var jvEffective = jvTotal - contact;
    return {
      availability: METRIC_AVAILABILITY.EXPERIMENTAL,
      reason: null,
      isPlausible: true,
      isAccountingExample: true,
      exampleNote: 'Reconstructed from rounded conference-abstract means. An accounting example, ' +
        'not a measurement and not a normative target.',
      label: m.label || null,
      method: m.method || KFO.METHOD.VALIDATED_GRF,
      calculationVersion: CALCULATION_VERSION,
      unit: IMPULSE_UNIT.BW_SECONDS,
      normalizedToBodyWeight: true,
      bodyWeightReference: 1,
      stanceDurationSeconds: contact,
      contactTimeSeconds: contact,
      meanVerticalForceBw: fvAvg,
      JvTotal: jvTotal,
      JvEffective: jvEffective,
      JBrake: jhPhase,
      JProp: jhPhase,
      JhTurnover: 2 * jhPhase,
      JxNet: 0,
      diagnostics: {
        JvEffectiveDirectIntegration: null,
        JvEffectiveShortcutReconstruction: jvEffective,
        shortcutValidWhen: 'bodyweight-normalized means with a known contact time',
        note: 'No force-time series exists for this example, so only the shortcut is available.'
      },
      provenance: KFO.PROVENANCE.DERIVED,
      validationStatus: KFO.VALIDATION_STATUS.UNVALIDATED
    };
  }

  // ── Geometry-only precursors ──────────────────────────────────────────────
  /**
   * Kinematic precursors, named so they can never be read as impulse, work,
   * energy or force shares. Each carries `isImpulse: false` and its degree unit.
   *
   * @param {Object} input {early, central, late, coupled, confidence} per side
   */
  function geometryProxies(input) {
    input = input || {};
    function proxy(name, agg, description) {
      return {
        name: name,
        availability: agg && isNum(agg.median) ? METRIC_AVAILABILITY.AVAILABLE : METRIC_AVAILABILITY.UNAVAILABLE,
        medianDegrees: agg ? agg.median : null,
        sdDegrees: agg ? agg.sd : null,
        n: agg ? agg.n : 0,
        unit: 'degrees',
        isImpulse: false,
        isForceShare: false,
        isWorkOrEnergy: false,
        description: description
      };
    }
    var coupled = input.coupled || {};
    return {
      availability: METRIC_AVAILABILITY.AVAILABLE,
      method: KFO.METHOD.GEOMETRY_PROXY,
      calculationVersion: CALCULATION_VERSION,
      brakingOrientationProxy: proxy('brakingOrientationProxy', input.early,
        'Early-stance support-line orientation. A geometric precursor to braking, not a braking impulse.'),
      supportAlignmentProxy: proxy('supportAlignmentProxy', input.central,
        'Central-stance support-line alignment with vertical. Not a vertical impulse.'),
      replacementOrientationProxy: proxy('replacementOrientationProxy', input.late,
        'Late-stance support-line orientation. A geometric precursor to propulsive replacement, ' +
        'not a propulsive impulse.'),
      foreAftGeometricExcursion: {
        name: 'foreAftGeometricExcursion',
        availability: isNum(coupled.foreAftGeometricExcursionDegrees)
          ? METRIC_AVAILABILITY.AVAILABLE : METRIC_AVAILABILITY.UNAVAILABLE,
        valueDegrees: isNum(coupled.foreAftGeometricExcursionDegrees)
          ? coupled.foreAftGeometricExcursionDegrees : null,
        unit: 'degrees',
        isImpulse: false,
        description: 'Sum of the early and late orientation magnitudes. A geometric span, ' +
          'not a fore-aft impulse turnover.'
      },
      momentumPreservationGeometryPattern: coupled.pattern || null,
      confidence: input.confidence == null ? null : input.confidence,
      impulseNote: 'Force and impulse percentages require force magnitude and are not available from ' +
        'geometry-only video.'
    };
  }

  return {
    CALCULATION_VERSION: CALCULATION_VERSION,
    SIGN_CONVENTION: SIGN_CONVENTION,
    IMPULSE_UNIT: IMPULSE_UNIT,
    VERTICAL_BASIS: VERTICAL_BASIS,
    HORIZONTAL_BASIS: HORIZONTAL_BASIS,
    COMPOSITION: COMPOSITION,
    COMPOSITION_ORDER: COMPOSITION_ORDER,
    COMPOSITION_SPEC: COMPOSITION_SPEC,
    STEADY_STATE: STEADY_STATE,
    METRIC_AVAILABILITY: METRIC_AVAILABILITY,
    CONFIG: CONFIG,
    IMPULSE_FIELDS: IMPULSE_FIELDS,
    IMPULSE_DEFINITIONS: IMPULSE_DEFINITIONS,
    IMPACT_MIN_SAMPLE_RATE_HZ: IMPACT_MIN_SAMPLE_RATE_HZ,

    impulseValue: impulseValue,
    integrate: integrate,
    integrateBySign: integrateBySign,
    integrateStance: integrateStance,
    assessStancePlausibility: assessStancePlausibility,
    buildComposition: buildComposition,
    buildCompositions: buildCompositions,
    classifySteadyState: classifySteadyState,
    impactMetrics: impactMetrics,
    aggregateStances: aggregateStances,
    combineSides: combineSides,
    unavailableImpulseMetrics: unavailableImpulseMetrics,
    momentumPreservation: momentumPreservation,
    fromNormalizedMeans: fromNormalizedMeans,
    geometryProxies: geometryProxies,
    assessment: assessment
  };
});
