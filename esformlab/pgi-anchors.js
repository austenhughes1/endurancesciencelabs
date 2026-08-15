// ─────────────────────────────────────────────────────────────────────────────
//  PGI — published reference anchors
//
//  "Slow compared to what?" — every headline number in the report is shown next
//  to a PUBLISHED measurement or the runner's own stride-to-stride spread, so a
//  value is never a bare number or a vague word.
//
//  RULES
//  -----
//  - Every anchor is a real measurement (or a reconstruction from published
//    means, labelled as such). Nothing here is invented, and nothing here is a
//    target: an anchor says what was MEASURED in a named population at a named
//    speed, never what this runner should do. Every formatted line carries
//    that framing and tests assert it.
//  - Anchors are speed-matched where the source has speeds. When the runner's
//    speed is unknown, only broad ranges are offered and they say so.
//  - The Dorn 2012 rows are the same values this repo already validates the
//    timing force model against in kfo-tests.js — one source of truth.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var api = factory();
  if (isNode) module.exports = api;
  if (root) root.PGIAnchors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var PROVENANCE = Object.freeze({
    LAB_MEASURED: 'lab_measured',
    RECONSTRUCTED: 'reconstructed_from_published_means',
    INTERNAL_BASELINE: 'internal_model_baseline',
    APPROXIMATE_POPULATION: 'approximate_device_population'
  });

  // ── Dorn, Arnold & Pandy 2012 (J Exp Biol) ─────────────────────────────────
  // Overground running, 9 subjects, force-plate measured. Duty factor and peak
  // vertical GRF are the published values already asserted in kfo-tests.js.
  // Mean vertical support (1/DF) follows algebraically from the duty factor.
  var DORN_2012 = Object.freeze([
    Object.freeze({ speedMps: 3.49, dutyFactor: 0.637, peakVerticalBw: 2.71 }),
    Object.freeze({ speedMps: 5.17, dutyFactor: 0.533, peakVerticalBw: 3.10 }),
    Object.freeze({ speedMps: 6.97, dutyFactor: 0.507, peakVerticalBw: 3.58 }),
    Object.freeze({ speedMps: 8.99, dutyFactor: 0.514, peakVerticalBw: 3.59 })
  ]);
  var DORN_SOURCE = Object.freeze({
    id: 'dorn_2012', short: 'Dorn 2012', n: 9,
    population: 'trained runners, overground, force-plate measured',
    provenance: PROVENANCE.LAB_MEASURED
  });

  // ── Clark, Ryan & Weyand 2012 (reconstruction) ─────────────────────────────
  // Contact time reconstructed from their published means at 5.0 m/s
  // (total vertical impulse 0.30 BW·s / mean force 1.70 BW = 0.176 s) — the
  // same reconstruction kfo-impulse.js documents and tests.
  var CLARK_5MS = Object.freeze({
    speedMps: 5.0, contactSeconds: 0.176, meanVerticalBw: 1.70,
    source: Object.freeze({
      id: 'clark_2012', short: 'Clark 2012 (reconstructed)', n: null,
      population: 'competitive runners, treadmill',
      provenance: PROVENANCE.RECONSTRUCTED
    })
  });

  // ── This site's Run Dynamics easy-run baseline ─────────────────────────────
  // shared/run-load-model.js carries baseDF = 42408 (cadence·spm × GCT·ms) as
  // its easy-run fallback, which is duty factor 42408/60000 ≈ 0.707. Using it
  // here keeps the video-derived number comparable with the device-derived one.
  var EASY_RUN_DF = Object.freeze({
    dutyFactor: 42408 / 60000,
    source: Object.freeze({
      id: 'run_load_baseline', short: 'this site’s Run Dynamics easy-run baseline',
      n: null, population: 'easy-pace recreational running',
      provenance: PROVENANCE.INTERNAL_BASELINE
    })
  });

  // ── Broad device-population ranges ─────────────────────────────────────────
  // Deliberately wide, explicitly approximate, for when speed is unknown.
  // These describe where most wearable-reported values fall, not where any
  // value should be.
  var DEVICE_RANGES = Object.freeze({
    contactSeconds: Object.freeze({ lo: 0.240, hi: 0.300 }),
    verticalOscillationCm: Object.freeze({ lo: 6, hi: 13 }),
    source: Object.freeze({
      id: 'device_population', short: 'typical wearable-reported range',
      n: null, population: 'recreational runners, running-dynamics devices',
      provenance: PROVENANCE.APPROXIMATE_POPULATION
    })
  });

  var NOT_A_TARGET = 'a measured value from that study, not a target';

  // ── Selection ──────────────────────────────────────────────────────────────

  function nearestDorn(speedMps) {
    if (!isNum(speedMps)) return null;
    var best = null;
    DORN_2012.forEach(function (r) {
      if (!best || Math.abs(r.speedMps - speedMps) < Math.abs(best.speedMps - speedMps)) best = r;
    });
    // Beyond ~1.2 m/s away the comparison is a different kind of running.
    return (best && Math.abs(best.speedMps - speedMps) <= 1.2) ? best : null;
  }

  /**
   * Best anchor for a metric at the runner's speed.
   * @returns {null|{value:number|null, range:[lo,hi]|null, unit, atSpeedMps, source, isTarget:false, text}}
   */
  function anchorFor(metric, speedMps) {
    var d = nearestDorn(speedMps);
    switch (metric) {
      case 'dutyFactor':
        if (d) return make(d.dutyFactor, null, '', d.speedMps, DORN_SOURCE, 2);
        return make(EASY_RUN_DF.dutyFactor, null, '', null, EASY_RUN_DF.source, 2);
      case 'meanVerticalSupportBW':
        if (d) return make(1 / d.dutyFactor, null, ' BW', d.speedMps, DORN_SOURCE, 2,
          'follows from the measured duty factor');
        return make(1 / EASY_RUN_DF.dutyFactor, null, ' BW', null, EASY_RUN_DF.source, 2);
      case 'peakVerticalSupportBW':
        if (d) return make(d.peakVerticalBw, null, ' BW', d.speedMps, DORN_SOURCE, 2);
        return null;
      case 'contactSeconds':
        if (isNum(speedMps) && Math.abs(speedMps - CLARK_5MS.speedMps) <= 1.0) {
          return make(CLARK_5MS.contactSeconds, null, ' s', CLARK_5MS.speedMps,
            CLARK_5MS.source, 3);
        }
        return make(null, [DEVICE_RANGES.contactSeconds.lo, DEVICE_RANGES.contactSeconds.hi],
          ' s', null, DEVICE_RANGES.source, 3);
      case 'verticalOscillationCm':
        return make(null, [DEVICE_RANGES.verticalOscillationCm.lo, DEVICE_RANGES.verticalOscillationCm.hi],
          ' cm', null, DEVICE_RANGES.source, 0);
      default:
        return null;
    }
  }

  function make(value, range, unit, atSpeedMps, source, dp, extra) {
    var val = isNum(value) ? value.toFixed(dp) + unit
      : range ? range[0].toFixed(dp) + '–' + range[1].toFixed(dp) + unit : null;
    if (val == null) return null;
    var speedPart = isNum(atSpeedMps) ? ' at ' + atSpeedMps.toFixed(1) + ' m/s' : '';
    var nPart = isNum(source.n) ? ', n=' + source.n : '';
    return {
      value: isNum(value) ? value : null,
      range: range || null,
      unit: unit.trim(),
      atSpeedMps: isNum(atSpeedMps) ? atSpeedMps : null,
      source: source,
      isTarget: false,
      extra: extra || null,
      text: val + speedPart + ' (' + source.short + nPart + ')'
    };
  }

  /**
   * One-line comparison of the runner's value against an anchor:
   * "233 ms · lab value at 3.5 m/s: 240 ms (Dorn 2012, n=9)".
   * Returns null when no honest anchor exists — a missing anchor is better
   * than a stretched one.
   */
  function contextLine(metric, runnerValue, speedMps) {
    var a = anchorFor(metric, speedMps);
    if (!a) return null;
    var rel = null;
    if (isNum(runnerValue) && isNum(a.value) && a.value !== 0) {
      rel = (runnerValue - a.value) / a.value;
    }
    var relText = '';
    if (isNum(rel) && Math.abs(rel) >= 0.03) {
      relText = ' — ' + (rel > 0 ? '+' : '−') + Math.round(Math.abs(rel) * 100) + '% vs that value';
    } else if (isNum(rel)) {
      relText = ' — close to that value';
    }
    var kind = a.source.provenance === PROVENANCE.LAB_MEASURED ? 'lab-measured'
             : a.source.provenance === PROVENANCE.RECONSTRUCTED ? 'reconstructed from published means'
             : a.source.provenance === PROVENANCE.INTERNAL_BASELINE ? 'model baseline'
             : 'approximate population range';
    return {
      anchor: a,
      relative: rel,
      text: kind + ': ' + a.text + relText,
      framing: NOT_A_TARGET
    };
  }

  return {
    PROVENANCE: PROVENANCE,
    DORN_2012: DORN_2012,
    CLARK_5MS: CLARK_5MS,
    EASY_RUN_DF: EASY_RUN_DF,
    DEVICE_RANGES: DEVICE_RANGES,
    NOT_A_TARGET: NOT_A_TARGET,
    nearestDorn: nearestDorn,
    anchorFor: anchorFor,
    contextLine: contextLine
  };
});
