// ─────────────────────────────────────────────────────────────────────────────
//  KFO — reference-distribution model
//
//  Replaces V1's hardcoded universal "elite target" angles with a queryable
//  distribution store that carries provenance, population description, sample
//  size and validation status on every record.
//
//  THE STORE SHIPS EMPTY. ON PURPOSE.
//  V1 used a hand-set late-stance target of +18 degrees with no source. The
//  obvious replacement would be a literature value (Clark et al. put the
//  phase-average resultant near 9.7 degrees from vertical), but that is a
//  measured GRF resultant on a force treadmill, not a video-derived support-line
//  angle at a normalised stance percentage — they are different quantities, and
//  equating them would manufacture a provenance that does not exist.
//
//  So `RECORDS` is empty until real support-line reference data is collected,
//  and reference similarity reports as unavailable rather than inventing a
//  comparison. One optional derived provider is included (see below), disabled
//  by default and clearly labelled when used.
//
//  IMPORTANT: reference similarity is NOT efficiency, and matching a reference
//  mean is NOT evidence of an optimised stride. The evidence synthesis is
//  explicit that a force-direction result cannot identify the metabolically
//  optimal amount of vertical oscillation, and that trained runners'
//  self-selected mechanics already sit near their own oxygen-cost minimum.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var core = (typeof module === 'object' && module.exports) ? require('./kfo-core.js') : root.KFO;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KFOReference = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO) {
  'use strict';

  var REFERENCE_VERSION = 'kfo-reference-empty-2026-08';

  /**
   * @typedef {Object} ReferenceRecord
   * @property {string} metric               e.g. 'support_line_angle'
   * @property {string} phase                one of KFO.PHASE
   * @property {'left'|'right'|'both'} sideApplicability
   * @property {number|null} speedMinMps
   * @property {number|null} speedMaxMps
   * @property {number|null} gradePercentMin
   * @property {number|null} gradePercentMax
   * @property {string|null} surface         'treadmill' | 'overground' | null
   * @property {string|null} sex
   * @property {string|null} footStrikePattern
   * @property {string} population           plain-language description
   * @property {number} sampleSize
   * @property {number} mean
   * @property {number} sd
   * @property {Object|null} percentiles     e.g. {p5, p25, p50, p75, p95}
   * @property {string} sourceType           'internal_reference' | 'published' | 'derived'
   * @property {string} provenance           one of KFO.PROVENANCE
   * @property {string} validationStatus     one of KFO.VALIDATION_STATUS
   * @property {string} referenceVersion
   * @property {boolean} isBroadFallback
   * @property {string[]} [assumptions]
   */

  /** @type {ReferenceRecord[]} */
  var RECORDS = [];

  var METRIC = Object.freeze({
    SUPPORT_LINE_ANGLE: 'support_line_angle',
    FORE_AFT_EXCURSION: 'fore_aft_geometric_excursion'
  });

  // ── Optional derived provider ─────────────────────────────────────────────
  //
  // The existing elite collection (`reference_sessions` → `computed_ranges`)
  // stores scalar metrics only — no keypoints — so a support-line angle cannot be
  // recomputed on elite poses. What it does store is FOOT OFFSET, the horizontal
  // ankle-to-hip offset normalised by torso length, which is geometrically
  // related to the support-line angle:
  //
  //     theta ≈ atan2(-footOffset, R)
  //
  // where R is the vertical hip-to-ankle distance as a multiple of torso length.
  // R is an anthropometric ASSUMPTION, not a measurement, and it shifts every
  // athlete and the reference baseline by the same amount — so this provider is
  // usable for trend and side-to-side comparison but not for absolute accuracy.
  //
  // It is therefore emitted with provenance 'derived', validationStatus
  // 'derived_kinematic', its assumption disclosed in the payload, and it is
  // DISABLED unless explicitly enabled.
  var LEG_TORSO_RATIO = 1.6;

  var derivedProvider = {
    enabled: false,
    /**
     * @param {string} phase
     * @returns {ReferenceRecord|null}
     */
    lookup: function (phase) {
      if (!this.enabled) return null;
      if (typeof getCombinedStats !== 'function') return null;
      // Foot offset is only meaningful for the strike-side / push-side phases in
      // the legacy phase vocabulary. Early stance maps onto the landing foot and
      // late stance onto the pushing foot of the SAME leg, so both read the same
      // legacy metric; central stance has no foot-offset analogue.
      var legacyPhase = phase === KFO.PHASE.EARLY_STANCE ? 'l_foot'
                      : phase === KFO.PHASE.LATE_STANCE ? 'l_toe' : null;
      if (!legacyPhase) return null;
      var st = null;
      try { st = getCombinedStats(legacyPhase, 'lFoot'); } catch (e) { return null; }
      if (!st || st.source !== 'live' || !(st.sd > 0) || !(st.n >= 5)) return null;

      var R = LEG_TORSO_RATIO;
      var mean = KFO._internals.toDeg(Math.atan2(-st.mean, R));
      // Propagate sd through theta = atan2(-fo, R): dtheta/dfo = -R/(R^2+fo^2).
      var slope = R / (R * R + st.mean * st.mean);
      var sd = Math.max(3, KFO._internals.toDeg(slope * st.sd));

      return {
        metric: METRIC.SUPPORT_LINE_ANGLE,
        phase: phase,
        sideApplicability: 'both',
        speedMinMps: null, speedMaxMps: null,
        gradePercentMin: null, gradePercentMax: null,
        surface: null, sex: null, footStrikePattern: null,
        population: st.n + ' internal reference sessions (foot-offset distribution)',
        sampleSize: st.n,
        mean: mean, sd: sd, percentiles: null,
        sourceType: 'derived',
        provenance: KFO.PROVENANCE.DERIVED,
        validationStatus: KFO.VALIDATION_STATUS.DERIVED_KINEMATIC,
        referenceVersion: REFERENCE_VERSION,
        isBroadFallback: true,
        assumptions: [
          'Support-line angle derived from the foot-offset distribution, not measured directly',
          'Assumes vertical hip-to-ankle distance R = ' + R + ' torso lengths',
          'Suitable for trend and side-to-side comparison, not absolute accuracy'
        ]
      };
    }
  };

  // ── Selection ─────────────────────────────────────────────────────────────
  /**
   * Choose the best reference record for a query. Never silently substitutes a
   * narrow speed-specific record when speed is unknown: it falls back to a
   * record explicitly marked `isBroadFallback` and says so.
   *
   * @param {Object} q
   * @param {string} q.metric
   * @param {string} q.phase
   * @param {'left'|'right'} [q.side]
   * @param {number|null} [q.speedMps]
   * @param {number|null} [q.gradePercent]
   * @param {string|null} [q.sex]
   * @returns {{available:boolean, record:ReferenceRecord|null, matchType:string,
   *            note:string, referenceVersion:string}}
   */
  function selectReference(q) {
    q = q || {};
    var speedKnown = typeof q.speedMps === 'number' && isFinite(q.speedMps);

    var candidates = RECORDS.filter(function (r) {
      if (r.metric !== q.metric || r.phase !== q.phase) return false;
      if (r.sideApplicability !== 'both' && q.side && r.sideApplicability !== q.side) return false;
      return true;
    });

    if (speedKnown) {
      var speedMatched = candidates.filter(function (r) {
        return r.speedMinMps != null && r.speedMaxMps != null &&
               q.speedMps >= r.speedMinMps && q.speedMps <= r.speedMaxMps;
      });
      if (speedMatched.length) {
        var best = speedMatched.sort(function (a, b) { return b.sampleSize - a.sampleSize; })[0];
        return {
          available: true, record: best, matchType: 'speed_matched',
          note: describe(best), referenceVersion: best.referenceVersion
        };
      }
    }

    var broad = candidates.filter(function (r) { return r.isBroadFallback; })
                          .sort(function (a, b) { return b.sampleSize - a.sampleSize; })[0];
    if (broad) {
      return {
        available: true, record: broad,
        matchType: speedKnown ? 'broad_no_speed_band' : 'broad_speed_unknown',
        note: (speedKnown ? 'Broad reference; no band matches this speed. '
                          : 'Broad reference; running speed unavailable. ') + describe(broad),
        referenceVersion: broad.referenceVersion
      };
    }

    var derived = derivedProvider.lookup(q.phase);
    if (derived && derived.metric === q.metric) {
      return {
        available: true, record: derived, matchType: 'derived_fallback',
        note: 'Derived reference (not measured directly). ' + describe(derived),
        referenceVersion: derived.referenceVersion
      };
    }

    return {
      available: false, record: null, matchType: 'none',
      note: 'No reference distribution is loaded for this phase, so no comparison is shown.',
      referenceVersion: REFERENCE_VERSION
    };
  }

  /** Plain-language description. Only claims what the record actually supports. */
  function describe(r) {
    if (!r) return '';
    var bits = ['Reference: n=' + r.sampleSize, r.population];
    if (r.speedMinMps != null && r.speedMaxMps != null) {
      bits.push('at ' + r.speedMinMps + '–' + r.speedMaxMps + ' m/s');
    }
    return bits.join(' · ');
  }

  /**
   * Reference similarity, 0..100. A z-scored Gaussian, reported ONLY as
   * similarity to a distribution — explicitly not economy, efficiency, or
   * optimality. Withheld entirely when data confidence is too low, so a noisy
   * estimate cannot produce a confident-looking comparison.
   */
  function referenceSimilarity(value, record, confidenceScore) {
    if (typeof value !== 'number' || !isFinite(value) || !record) {
      return { available: false, score: null, z: null, reason: 'no_reference_or_value' };
    }
    if (typeof confidenceScore === 'number' && confidenceScore < 0.35) {
      return { available: false, score: null, z: null, reason: 'insufficient_data_confidence' };
    }
    var sd = record.sd > 0 ? record.sd : null;
    if (!sd) return { available: false, score: null, z: null, reason: 'reference_sd_unavailable' };
    var z = (value - record.mean) / sd;
    return {
      available: true,
      score: Math.round(100 * Math.exp(-0.5 * z * z)),
      z: z,
      isNotEfficiency: true,
      disclaimer: 'Reference similarity is not a direct measure of running economy.',
      reason: null
    };
  }

  function addRecords(records) {
    (records || []).forEach(function (r) { RECORDS.push(r); });
    return RECORDS.length;
  }
  function clearRecords() { RECORDS.length = 0; }
  function allRecords() { return RECORDS.slice(); }

  return {
    REFERENCE_VERSION: REFERENCE_VERSION,
    METRIC: METRIC,
    LEG_TORSO_RATIO: LEG_TORSO_RATIO,
    derivedProvider: derivedProvider,
    selectReference: selectReference,
    referenceSimilarity: referenceSimilarity,
    describe: describe,
    addRecords: addRecords,
    clearRecords: clearRecords,
    allRecords: allRecords
  };
});
