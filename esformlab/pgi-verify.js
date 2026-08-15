// ─────────────────────────────────────────────────────────────────────────────
//  PGI — stance-landmark verification
//
//  Automatic stance-edge detection at the scan sample rate is coarse enough to
//  pick visibly wrong frames, and every downstream number reads those edges. So
//  landmark verification is a FORCED step: the report is not shown until a
//  human has looked at each used stance's touchdown, minimum-COM and toe-off
//  frames and either confirmed or corrected them.
//
//  This module is the LOGIC only (queue building, state, override assembly,
//  summary) so it runs in node for tests. The DOM/video work — thumbnails,
//  seeking, buttons — lives in pgi-app.js.
//
//  What a correction changes: stance start/end feed timing, phase windows,
//  COM step extraction and touchdown-preparation windows; the minimum-COM time
//  feeds the loading/rebound split. The automatic times are always retained
//  next to the corrected ones — the difference is the training signal for
//  improving detection.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var api = factory(core);
  if (isNode) module.exports = api;
  if (root) root.PGIVerify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var EVENTS = Object.freeze(['touchdown', 'minimumCom', 'toeoff']);
  var EVENT_LABEL = Object.freeze({
    touchdown: 'Touchdown', minimumCom: 'Minimum COM', toeoff: 'Toe-off'
  });

  /**
   * Build the verification queue from an analysis result: one item per used
   * stance, carrying the AUTO times (immutable identifiers) and the working
   * times (what the reviewer nudges).
   */
  function buildQueue(result) {
    var items = [];
    if (!result || !result.supportGeometry) return items;

    // Minimum-COM per step, matched by side + touchdown time.
    var minComByKey = {};
    var steps = (result.comTrajectory && result.comTrajectory.stepResults) || [];
    steps.forEach(function (s) {
      if (!s || !s.valid || !s.minimumCom || !s.minimumCom.available) return;
      minComByKey[s.contactSide + ':' + Math.round(s.startTime * 1000)] = s.minimumCom;
    });

    ['left', 'right'].forEach(function (side) {
      var sd = result.supportGeometry[side];
      ((sd && sd.stanceIntervals) || []).forEach(function (iv) {
        if (!isNum(iv.startTime) || !isNum(iv.endTime)) return;
        var mc = minComByKey[side + ':' + Math.round(iv.startTime * 1000)] || null;
        items.push({
          id: side + '-' + Math.round(iv.startTime * 1000),
          side: side,
          // Auto times identify the stance and never change.
          autoStart: iv.startTime,
          autoEnd: iv.endTime,
          autoMinCom: mc ? mc.t : null,
          minComConfidence: mc ? mc.confidence : null,
          // Working times, nudged by the reviewer.
          start: iv.startTime,
          end: iv.endTime,
          minCom: mc ? mc.t : null,
          confirmed: false
        });
      });
    });
    items.sort(function (a, b) { return a.autoStart - b.autoStart; });
    return items;
  }

  /** Nudge one event time on one item. Ordering TD < MIN < TO is enforced. */
  function nudge(item, eventKey, deltaSeconds, clipDuration) {
    if (!item || !isNum(deltaSeconds)) return item;
    var MIN_STANCE = 0.05;
    if (eventKey === 'touchdown') {
      var ns = item.start + deltaSeconds;
      if (ns >= 0 && ns <= item.end - MIN_STANCE) item.start = ns;
      if (isNum(item.minCom) && item.minCom <= item.start) item.minCom = item.start + 0.005;
    } else if (eventKey === 'toeoff') {
      var ne = item.end + deltaSeconds;
      var cap = isNum(clipDuration) ? clipDuration : Infinity;
      if (ne <= cap && ne >= item.start + MIN_STANCE) item.end = ne;
      if (isNum(item.minCom) && item.minCom >= item.end) item.minCom = item.end - 0.005;
    } else if (eventKey === 'minimumCom' && isNum(item.minCom)) {
      var nm = item.minCom + deltaSeconds;
      if (nm > item.start && nm < item.end) item.minCom = nm;
    }
    item.confirmed = false; // a nudged item must be re-confirmed
    return item;
  }

  function timeOf(item, eventKey) {
    return eventKey === 'touchdown' ? item.start
         : eventKey === 'toeoff' ? item.end
         : item.minCom;
  }

  function isAdjusted(item) {
    return item.start !== item.autoStart || item.end !== item.autoEnd ||
           (isNum(item.minCom) && isNum(item.autoMinCom) &&
            Math.abs(item.minCom - item.autoMinCom) > 1e-9);
  }

  function allConfirmed(items) {
    return items.length > 0 && items.every(function (i) { return i.confirmed; });
  }

  /**
   * Assemble the analysis-input overrides from a confirmed queue.
   * Confirmed-but-unadjusted items still emit a stance override (identity
   * times), so the interval is tagged `verified` in the result.
   */
  function toOverrides(items) {
    var stance = { left: [], right: [] };
    var minCom = [];
    (items || []).forEach(function (i) {
      if (!i.confirmed) return;
      stance[i.side].push({ autoStartTime: i.autoStart, startTime: i.start, endTime: i.end });
      if (isNum(i.minCom) && isNum(i.autoMinCom) && Math.abs(i.minCom - i.autoMinCom) > 1e-9) {
        // The stance may have moved; the min-COM override is matched by the
        // CORRECTED start time, which is what the re-analysis will detect.
        minCom.push({ side: i.side, autoStartTime: i.start, time: i.minCom });
      }
    });
    return { stanceOverrides: stance, minComOverrides: minCom };
  }

  /** Compact record of what verification did, for the envelope and storage. */
  function summarize(items) {
    var confirmed = (items || []).filter(function (i) { return i.confirmed; });
    var corrections = [];
    confirmed.forEach(function (i) {
      EVENTS.forEach(function (ev) {
        var autoT = ev === 'touchdown' ? i.autoStart : ev === 'toeoff' ? i.autoEnd : i.autoMinCom;
        var t = timeOf(i, ev);
        if (isNum(autoT) && isNum(t) && Math.abs(t - autoT) > 1e-9) {
          corrections.push({
            side: i.side, event: ev,
            autoTimeSeconds: Math.round(autoT * 10000) / 10000,
            adjustedTimeSeconds: Math.round(t * 10000) / 10000,
            deltaMs: Math.round((t - autoT) * 1000)
          });
        }
      });
    });
    return {
      verified: allConfirmed(items),
      stancesReviewed: confirmed.length,
      stancesTotal: (items || []).length,
      stancesAdjusted: confirmed.filter(isAdjusted).length,
      corrections: corrections,
      note: 'Automatic times are retained beside corrections; the difference is the training ' +
        'signal for improving event detection.'
    };
  }

  return {
    EVENTS: EVENTS,
    EVENT_LABEL: EVENT_LABEL,
    buildQueue: buildQueue,
    nudge: nudge,
    timeOf: timeOf,
    isAdjusted: isAdjusted,
    allConfirmed: allConfirmed,
    toOverrides: toOverrides,
    summarize: summarize
  };
});
