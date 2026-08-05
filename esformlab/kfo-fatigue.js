// ─────────────────────────────────────────────────────────────────────────────
//  KFO — longitudinal windows and fatigue-zone readiness
//
//  SCOPE, DELIBERATELY NARROW. esFormLab analyses one clip at a time; nothing in
//  this repository yet captures repeated gait windows across a workout. So this
//  file is ARCHITECTURE ONLY: a window data model, ordering, a rolling-baseline
//  change-point interface, and tests. There is no UI, no storage, and no caller
//  in the product. It exists so that when repeated windows do arrive, the
//  analysis has a defined shape to land in rather than being invented under
//  deadline.
//
//  WHAT A "FATIGUE ZONE" WOULD BE. A sustained departure from a within-session
//  baseline in the mechanics metrics, located in time or distance. What it is
//  NOT, and must never be presented as: a diagnosis, an injury-risk threshold, or
//  a validated physiological boundary. No universal threshold is defined here —
//  `CONFIG.standardizedChangeThreshold` is a provisional working value and every
//  result carries `validationStatus: 'experimental'`.
//
//  WHY A ROLLING BASELINE. A fixed absolute cutoff would compare runners to each
//  other; a within-session baseline compares a runner to their own fresh state,
//  which is the only comparison the data can currently support. Baseline windows
//  are named in the output so a reviewer can see exactly what "fresh" meant.
//
//  METRIC VALENCE IS NOT ENCODED. A metric moving up is reported as a change, not
//  as a decline. Whether increased fore-aft turnover late in a workout is
//  fatigue, pacing, terrain or measurement drift is not decidable from these
//  data, and the interpretation strings say so.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var imp = isNode ? require('./kfo-impulse.js') : root.KFOImpulse;
  var api = factory(core, imp);
  if (isNode) module.exports = api;
  if (root) root.KFOFatigue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, KFOImpulse) {
  'use strict';

  var CALCULATION_VERSION = 'kfo-fatigue-zone-v0.1.0-experimental';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** How repeated windows from one session may be ordered. */
  var ORDER_BY = Object.freeze({
    TIME_ELAPSED: 'time_elapsed',
    DISTANCE_ELAPSED: 'distance_elapsed',
    LAP: 'lap',
    SPEED: 'speed',
    EFFORT: 'effort'
  });

  var ORDER_FIELD = Object.freeze({
    time_elapsed: 'timeElapsedSeconds',
    distance_elapsed: 'distanceElapsedMeters',
    lap: 'lapIndex',
    speed: 'speedMps',
    effort: 'effortValue'
  });

  // ── Provisional configuration ─────────────────────────────────────────────
  var CONFIG = Object.freeze({
    minWindows: 4,
    baselineWindowCount: 2,
    // A change must persist across this many consecutive windows to count. A
    // single deviant window is far more likely to be a bad clip than a change in
    // the runner.
    sustainedWindows: 2,
    // PROVISIONAL. Number of baseline SDs a metric must move. Not a validated
    // fatigue threshold, and not derived from any published study.
    standardizedChangeThreshold: 1.5,
    // Used when the baseline SD is degenerate (identical values), so a change is
    // expressed relative to the baseline magnitude instead.
    minRelativeChange: 0.10,
    epsilon: 1e-9,
    isProvisional: true,
    provisionalNote: 'Change-detection settings are provisional working values, not validated ' +
      'fatigue thresholds. No universal fatigue-zone boundary is defined.'
  });

  // ── Trend metric registry ─────────────────────────────────────────────────
  //
  // Each entry knows how to pull its value out of a KFO analysis result. Geometry
  // proxies and impulse quantities are kept in separate `family` groups so a
  // downstream consumer cannot mix a degree-valued orientation proxy with a
  // BW·s-valued impulse in the same trend.
  var TREND_METRICS = Object.freeze([
    {
      key: 'brakingOrientationProxy', family: 'geometry_proxy', unit: 'degrees',
      label: 'Early-stance braking orientation proxy',
      extract: function (r) { return proxyValue(r, 'brakingOrientationProxy'); }
    },
    {
      key: 'replacementOrientationProxy', family: 'geometry_proxy', unit: 'degrees',
      label: 'Late-stance replacement orientation proxy',
      extract: function (r) { return proxyValue(r, 'replacementOrientationProxy'); }
    },
    {
      key: 'foreAftGeometricExcursion', family: 'geometry_proxy', unit: 'degrees',
      label: 'Fore-aft geometric excursion',
      extract: function (r) {
        var p = r && r.momentumPreservationProxies;
        if (!p) return null;
        var vals = ['left', 'right'].map(function (side) {
          var e = p[side] && p[side].foreAftGeometricExcursion;
          return e && isNum(e.valueDegrees) ? e.valueDegrees : null;
        }).filter(isNum);
        if (!vals.length) return null;
        return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      }
    },
    {
      key: 'JBrake', family: 'impulse', unit: 'BW*s', label: 'Braking impulse',
      extract: function (r) { return impulseField(r, 'JBrake'); }
    },
    {
      key: 'JProp', family: 'impulse', unit: 'BW*s', label: 'Propulsive replacement impulse',
      extract: function (r) { return impulseField(r, 'JProp'); }
    },
    {
      key: 'JhTurnover', family: 'impulse', unit: 'BW*s', label: 'Fore-aft impulse turnover',
      extract: function (r) { return impulseField(r, 'JhTurnover'); }
    },
    {
      key: 'JvEffective', family: 'impulse', unit: 'BW*s', label: 'Effective vertical impulse',
      extract: function (r) { return impulseField(r, 'JvEffective'); }
    },
    {
      key: 'projectionReplacementVerticalShare', family: 'impulse_composition', unit: 'share',
      label: 'Projection / replacement vertical share',
      extract: function (r) { return compositionShare(r, 'projectionReplacement'); }
    },
    {
      key: 'activeProjectionTurnoverVerticalShare', family: 'impulse_composition', unit: 'share',
      label: 'Active projection / turnover vertical share',
      extract: function (r) { return compositionShare(r, 'activeProjectionTurnover'); }
    },
    {
      key: 'leftRightAsymmetry', family: 'quality', unit: 'degrees',
      label: 'Left/right support-line difference',
      extract: function (r) {
        var s = r && r.symmetry;
        return s && isNum(s.maxAbsoluteDifferenceDegrees) ? s.maxAbsoluteDifferenceDegrees : null;
      }
    },
    {
      key: 'strideVariability', family: 'quality', unit: 'degrees',
      label: 'Stride-to-stride variability',
      extract: function (r) {
        var c = r && r.consistency;
        var vals = [c && c.left && c.left.maxPhaseSdDegrees, c && c.right && c.right.maxPhaseSdDegrees]
          .filter(isNum);
        if (!vals.length) return null;
        return Math.max.apply(null, vals);
      }
    }
  ]);

  /**
   * A trend needs one number per window, but the proxies are per side. Both sides
   * are equally valid, so the mean of whichever sides are available is used — and
   * side asymmetry is tracked as its own trend metric rather than being hidden
   * inside this average.
   */
  function proxyValue(result, name) {
    var p = result && result.momentumPreservationProxies;
    if (!p) return null;
    var vals = ['left', 'right'].map(function (side) {
      var m = p[side] && p[side][name];
      return m && isNum(m.medianDegrees) ? m.medianDegrees : null;
    }).filter(isNum);
    if (!vals.length) return null;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }
  function impulseField(result, field) {
    var im = result && result.impulseMetrics;
    var c = im && im.combined;
    return c && isNum(c[field]) ? c[field] : null;
  }
  function compositionShare(result, compositionKey) {
    var im = result && result.impulseMetrics;
    var c = im && im.combined && im.combined.compositions && im.combined.compositions[compositionKey];
    return c && isNum(c.verticalShareScalarSum) ? c.verticalShareScalarSum : null;
  }

  function metricByKey(key) {
    for (var i = 0; i < TREND_METRICS.length; i++) if (TREND_METRICS[i].key === key) return TREND_METRICS[i];
    return null;
  }

  // ── Window model ──────────────────────────────────────────────────────────
  /**
   * One gait-analysis window from a session, with everything needed to order it
   * and to read its trend metrics.
   *
   * Ordering keys are all optional and all retained: a session may know elapsed
   * time but not distance, or laps but not heart rate. `orderWindows` refuses
   * rather than guessing when the requested key is missing.
   *
   * @param {Object} input
   * @param {string} input.windowId
   * @param {Object} input.analysis  a KFO analysis result (or stored form)
   * @param {number} [input.timeElapsedSeconds]
   * @param {number} [input.distanceElapsedMeters]
   * @param {number} [input.lapIndex]
   * @param {number} [input.speedMps]
   * @param {number} [input.heartRateBpm]
   * @param {number} [input.effortValue]  RPE or any effort scalar
   */
  function buildWindow(input) {
    input = input || {};
    var r = input.analysis || null;
    var metrics = {};
    TREND_METRICS.forEach(function (m) {
      var v = null;
      try { v = m.extract(r); } catch (e) { v = null; }
      metrics[m.key] = {
        value: isNum(v) ? v : null,
        unit: m.unit,
        family: m.family,
        availability: isNum(v) ? 'available' : 'unavailable'
      };
    });
    return {
      windowId: input.windowId || null,
      timeElapsedSeconds: isNum(input.timeElapsedSeconds) ? input.timeElapsedSeconds : null,
      distanceElapsedMeters: isNum(input.distanceElapsedMeters) ? input.distanceElapsedMeters : null,
      lapIndex: isNum(input.lapIndex) ? input.lapIndex : null,
      speedMps: isNum(input.speedMps) ? input.speedMps : null,
      heartRateBpm: isNum(input.heartRateBpm) ? input.heartRateBpm : null,
      effortValue: isNum(input.effortValue) ? input.effortValue
                 : (isNum(input.heartRateBpm) ? input.heartRateBpm : null),
      method: r ? r.method || null : null,
      confidenceScore: (r && r.quality && r.quality.confidence) ? r.quality.confidence.score : null,
      metrics: metrics,
      calculationVersion: CALCULATION_VERSION
    };
  }

  /**
   * Order windows by one key. Windows missing that key are returned separately
   * rather than sorted to the front or dropped.
   */
  function orderWindows(windows, orderBy) {
    var key = ORDER_FIELD[orderBy];
    if (!key) {
      return { ok: false, reason: 'unknown_order_key', orderBy: orderBy || null, ordered: [], unordered: (windows || []).slice() };
    }
    var have = [], missing = [];
    (windows || []).forEach(function (w) {
      if (w && isNum(w[key])) have.push(w); else if (w) missing.push(w);
    });
    have.sort(function (a, b) { return a[key] - b[key]; });
    return {
      ok: have.length > 0,
      reason: have.length ? null : 'no_windows_carry_this_order_key',
      orderBy: orderBy, orderField: key,
      ordered: have, unordered: missing
    };
  }

  // ── Rolling baseline and change detection ─────────────────────────────────
  /**
   * Mean and SD of the first `count` values. Deliberately the FIRST windows
   * rather than the whole session: a baseline that includes the fatigued portion
   * cannot detect a departure from fresh.
   */
  function rollingBaseline(values, count) {
    var v = (values || []).filter(isNum).slice(0, Math.max(1, count || CONFIG.baselineWindowCount));
    if (!v.length) return { n: 0, mean: null, sd: null };
    var agg = KFO.aggregate(v);
    return { n: agg.n, mean: agg.mean, sd: agg.sd, values: v };
  }

  /**
   * Standardized change against the baseline. Falls back to a relative change
   * when the baseline SD is degenerate, and says which rule it used.
   */
  function standardizedChange(current, baseline) {
    if (!isNum(current) || !baseline || !isNum(baseline.mean)) return null;
    var delta = current - baseline.mean;
    if (isNum(baseline.sd) && baseline.sd > CONFIG.epsilon) {
      return { rule: 'standardized', delta: delta, standardizedChange: delta / baseline.sd,
               relativeChange: Math.abs(baseline.mean) > CONFIG.epsilon ? delta / baseline.mean : null };
    }
    var rel = Math.abs(baseline.mean) > CONFIG.epsilon ? delta / baseline.mean : null;
    return { rule: 'relative_baseline_sd_degenerate', delta: delta, standardizedChange: null, relativeChange: rel };
  }

  function exceedsThreshold(change, cfg) {
    if (!change) return false;
    if (isNum(change.standardizedChange)) {
      return Math.abs(change.standardizedChange) >= cfg.standardizedChangeThreshold;
    }
    return isNum(change.relativeChange) && Math.abs(change.relativeChange) >= cfg.minRelativeChange;
  }

  /**
   * First index at which a metric departs from baseline and STAYS departed for
   * `sustainedWindows` consecutive windows, in the same direction.
   */
  function detectChangePoint(series, baseline, cfg) {
    cfg = cfg || CONFIG;
    var n = series.length;
    for (var i = baseline.n; i < n; i++) {
      var first = standardizedChange(series[i].value, baseline);
      if (!exceedsThreshold(first, cfg)) continue;
      var dir = first.delta > 0 ? 1 : -1;
      var sustained = 1;
      for (var j = i + 1; j < n && sustained < cfg.sustainedWindows; j++) {
        var c = standardizedChange(series[j].value, baseline);
        if (!exceedsThreshold(c, cfg) || (c.delta > 0 ? 1 : -1) !== dir) break;
        sustained++;
      }
      if (sustained >= cfg.sustainedWindows) {
        return { index: i, direction: dir, change: first, sustainedWindows: sustained };
      }
    }
    return null;
  }

  // ── The analysis ──────────────────────────────────────────────────────────
  /**
   * @param {Object} input
   * @param {Array} input.windows  buildWindow() results
   * @param {string} [input.orderBy]  one of ORDER_BY, default time_elapsed
   * @param {string[]} [input.metrics]  trend metric keys, default all available
   * @param {Object} [input.config]
   * @returns {Object} FatigueZoneAnalysis
   */
  function analyzeFatigueZone(input) {
    input = input || {};
    var cfg = input.config ? mergeConfig(input.config) : CONFIG;
    var orderBy = input.orderBy || ORDER_BY.TIME_ELAPSED;

    var out = {
      availability: KFOImpulse.METRIC_AVAILABILITY.UNAVAILABLE,
      calculationVersion: CALCULATION_VERSION,
      orderBy: orderBy,
      config: cfg,
      baselineWindowIds: [],
      changedMetrics: [],
      interpretation: [],
      validationStatus: 'experimental',
      isFatigueThresholdValidated: false
    };

    var ordering = orderWindows(input.windows, orderBy);
    out.windowsProvided = (input.windows || []).length;
    out.windowsOrdered = ordering.ordered.length;
    out.windowsMissingOrderKey = ordering.unordered.length;

    if (!ordering.ok) {
      out.reason = ordering.reason;
      out.interpretation = ['Windows could not be ordered by ' + orderBy + ', so no trend can be assessed.'];
      return out;
    }
    if (ordering.ordered.length < cfg.minWindows) {
      out.reason = 'insufficient_windows';
      out.interpretation = ['At least ' + cfg.minWindows + ' ordered windows are needed to separate a ' +
        'baseline from a change; ' + ordering.ordered.length + ' were supplied.'];
      return out;
    }

    var windows = ordering.ordered;
    out.baselineWindowIds = windows.slice(0, cfg.baselineWindowCount).map(function (w) { return w.windowId; });

    var keys = input.metrics && input.metrics.length
      ? input.metrics
      : TREND_METRICS.map(function (m) { return m.key; });

    var assessed = 0;
    keys.forEach(function (key) {
      var def = metricByKey(key);
      if (!def) return;
      var series = windows.map(function (w) {
        var m = w.metrics ? w.metrics[key] : null;
        return { windowId: w.windowId, value: m ? m.value : null,
                 orderValue: w[ORDER_FIELD[orderBy]] };
      });
      var present = series.filter(function (s) { return isNum(s.value); });
      // Every window must carry the metric: a trend computed over a subset that
      // silently changes membership mid-series is not a trend.
      if (present.length < windows.length) {
        out.changedMetrics.push({
          metric: key, label: def.label, unit: def.unit, family: def.family,
          availability: 'unavailable',
          reason: present.length ? 'metric_missing_in_some_windows' : 'metric_unavailable_in_all_windows',
          windowsWithValue: present.length, windowsTotal: windows.length
        });
        return;
      }
      assessed++;
      var baseline = rollingBaseline(series.map(function (s) { return s.value; }), cfg.baselineWindowCount);
      var cp = detectChangePoint(series, baseline, cfg);
      var current = series[series.length - 1].value;
      var latest = standardizedChange(current, baseline);

      var record = {
        metric: key, label: def.label, unit: def.unit, family: def.family,
        availability: 'experimental',
        baselineValue: baseline.mean,
        baselineSd: baseline.sd,
        currentValue: current,
        standardizedChange: latest ? latest.standardizedChange : null,
        relativeChange: latest ? latest.relativeChange : null,
        changeRule: latest ? latest.rule : null,
        exceedsProvisionalThreshold: exceedsThreshold(latest, cfg),
        confidence: seriesConfidence(windows),
        series: series
      };
      if (cp) {
        record.changePoint = {
          windowId: series[cp.index].windowId,
          orderValue: series[cp.index].orderValue,
          direction: cp.direction > 0 ? 'increase' : 'decrease',
          sustainedWindows: cp.sustainedWindows
        };
      }
      out.changedMetrics.push(record);
    });

    if (!assessed) {
      out.reason = 'no_trend_metric_available_across_all_windows';
      out.interpretation = ['None of the trend metrics were present in every window, so no baseline ' +
        'comparison could be made.'];
      return out;
    }

    out.availability = KFOImpulse.METRIC_AVAILABILITY.EXPERIMENTAL;

    // The earliest sustained change across all metrics is the session-level
    // candidate change point.
    var withCp = out.changedMetrics.filter(function (m) { return m.changePoint; });
    if (withCp.length) {
      var earliest = withCp.reduce(function (best, m) {
        var idxA = indexOfWindow(windows, m.changePoint.windowId);
        var idxB = best ? indexOfWindow(windows, best.changePoint.windowId) : Infinity;
        return idxA < idxB ? m : best;
      }, null);
      var w = windows[indexOfWindow(windows, earliest.changePoint.windowId)];
      out.detectedChangePoint = {
        windowId: earliest.changePoint.windowId,
        timeSeconds: w ? w.timeElapsedSeconds : null,
        distanceMeters: w ? w.distanceElapsedMeters : null,
        // Confidence is the share of assessed metrics agreeing that something
        // changed, scaled by data confidence. It is not a probability.
        confidence: clamp01((withCp.length / assessed) * (seriesConfidence(windows) == null ? 1 : seriesConfidence(windows))),
        agreeingMetrics: withCp.map(function (m) { return m.metric; }),
        metricsAssessed: assessed,
        confidenceBasis: 'share of assessed metrics with a sustained change, scaled by mean data confidence'
      };
      out.interpretation.push('A sustained change from the session baseline was detected in ' +
        withCp.length + ' of ' + assessed + ' metrics, first at window ' + earliest.changePoint.windowId + '.');
      out.interpretation.push('Whether this reflects fatigue, pacing, terrain, or measurement drift cannot ' +
        'be determined from these data alone.');
    } else {
      out.interpretation.push('No sustained departure from the session baseline was detected in the ' +
        assessed + ' metrics assessed.');
    }
    out.interpretation.push(cfg.provisionalNote);
    return out;
  }

  function indexOfWindow(windows, windowId) {
    for (var i = 0; i < windows.length; i++) if (windows[i].windowId === windowId) return i;
    return Infinity;
  }
  function clamp01(v) { return !isNum(v) ? null : (v < 0 ? 0 : v > 1 ? 1 : v); }
  function seriesConfidence(windows) {
    var c = windows.map(function (w) { return w.confidenceScore; }).filter(isNum);
    if (!c.length) return null;
    return c.reduce(function (a, b) { return a + b; }, 0) / c.length;
  }
  function mergeConfig(overrides) {
    var out = {}, k;
    for (k in CONFIG) if (Object.prototype.hasOwnProperty.call(CONFIG, k)) out[k] = CONFIG[k];
    for (k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) out[k] = overrides[k];
    out.isProvisional = true;
    return out;
  }

  return {
    CALCULATION_VERSION: CALCULATION_VERSION,
    ORDER_BY: ORDER_BY,
    ORDER_FIELD: ORDER_FIELD,
    CONFIG: CONFIG,
    TREND_METRICS: TREND_METRICS,
    metricByKey: metricByKey,
    buildWindow: buildWindow,
    orderWindows: orderWindows,
    rollingBaseline: rollingBaseline,
    standardizedChange: standardizedChange,
    detectChangePoint: detectChangePoint,
    analyzeFatigueZone: analyzeFatigueZone
  };
});
