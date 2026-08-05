// ─────────────────────────────────────────────────────────────────────────────
//  KFO — admin rendering
//
//  `buildHtml(result)` is a PURE function returning a string, so the copy-audit
//  tests can assert on the exact wording without a DOM. `mount()` handles the
//  DOM side.
//
//  Copy rules enforced by those tests:
//    - never describes geometry as a measured ground-reaction force
//    - never presents efficiency, economy, or a single composite as a result
//    - always shows uncertainty, the method, and the model version
//    - reference similarity always carries its not-economy disclaimer
//    - orientation-only arrows are drawn at a fixed length and labelled as such,
//      so nothing implies a force magnitude
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var api = factory(core);
  if (isNode) module.exports = api;
  if (root) root.KFORender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO) {
  'use strict';

  var FEATURE_TITLE = 'Kinematic Force-Orientation Estimate';
  var FEATURE_SUBTITLE = 'Vertical force magnitude from stance and flight timing, plus support-line geometry ' +
    'across stance. Not a direct GRF measurement.';
  var PERSISTENT_NOTICE = 'These are video-derived estimates of vertical force magnitude and support-line ' +
    'orientation, not a direct ground-reaction-force measurement.';
  var METHOD_EXPLANATION = 'The estimate is based on body and contact geometry. Actual ground-reaction ' +
    'force also depends on center-of-mass acceleration, center-of-pressure location and force magnitude.';
  var ECONOMY_DISCLAIMER = 'Reference similarity is not a direct measure of running economy.';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function bandColor(band) {
    return band === 'high' ? 'var(--good, #22c78a)'
         : band === 'moderate' ? 'var(--warn, #f5a623)'
         : band === 'low' ? 'var(--bad, #ff5d5d)'
         : 'var(--muted2, #8aa0c0)';
  }
  function orientationColor(v) {
    if (!isNum(v)) return 'var(--muted2, #8aa0c0)';
    if (v < -4) return 'var(--bad, #ff5d5d)';        // braking-oriented
    if (v > 4) return 'var(--cyan, #00e5c8)';        // propulsive-oriented
    return 'var(--purple, #8b7cf8)';                 // near vertical
  }
  /** Neutral, descriptive orientation wording. Never praise or blame. */
  function orientationWord(v) {
    if (!isNum(v)) return 'not available';
    if (v < -8) return 'strongly braking-oriented';
    if (v < -3) return 'braking-oriented';
    if (v <= 3) return 'near vertical';
    if (v <= 8) return 'propulsive-oriented';
    return 'strongly propulsive-oriented';
  }

  function box(inner, extra) {
    return '<div style="border:1px solid var(--border2,#2a3550);border-radius:10px;padding:12px 14px;' +
      'background:var(--panel2,#121724);' + (extra || '') + '">' + inner + '</div>';
  }
  function label(text) {
    return '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:5px">' + esc(text) + '</div>';
  }

  // ── Vertical force headline ───────────────────────────────────────────────
  //
  // The headline quantity, because it is the one that varies between runners.
  // Deliberately NOT colour-banded: a higher peak vertical force is a larger
  // load, not a fault, and a red/green scale would read as a verdict.
  var FORCE_NOTICE = 'Estimated from stance and flight timing. This is not a ground-reaction-force measurement.';
  var FORCE_METHOD_NOTE = 'Over a complete step at steady speed the vertical impulse must support ' +
    'bodyweight, so mean force in bodyweights is exactly 1 / duty factor. The peak additionally ' +
    'assumes a half-sine force waveform (Morin et al. 2005; Patoz et al. 2023).';
  var FORCE_UNAVAILABLE_REASON = {
    double_support_detected_not_running: 'Overlapping stance phases were detected, which is walking rather ' +
      'than running. The flight-time relationship this estimate depends on does not hold without flight.',
    insufficient_steps: 'Too few complete steps (one contact plus the following flight) passed the timing ' +
      'checks in this clip.',
    vertical_force_module_not_loaded: 'The vertical-force module was not loaded on this page.'
  };

  /** value ± timing uncertainty, in bodyweights. */
  function forceValue(agg, relativeUncertainty) {
    if (!agg || !isNum(agg.median)) return '—';
    var v = agg.median;
    if (!isNum(relativeUncertainty) || relativeUncertainty <= 0) return v.toFixed(2) + ' BW';
    return v.toFixed(2) + ' ± ' + Math.max(0.01, v * relativeUncertainty).toFixed(2) + ' BW';
  }

  function bigStat(title, value, sub) {
    return '<div style="flex:1 1 150px;min-width:130px">' + label(title) +
      '<div style="font-size:23px;font-weight:800;letter-spacing:-.5px;color:var(--cyan,#00e5c8);' +
      'line-height:1.15">' + esc(value) + '</div>' +
      (sub ? '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:3px;line-height:1.45">' +
        esc(sub) + '</div>' : '') + '</div>';
  }

  function timingChips(vf) {
    var chips = [];
    function chip(name, text) {
      chips.push('<span style="display:inline-block;font-size:11px;padding:3px 9px;border-radius:20px;' +
        'border:1px solid var(--border,#243044);color:var(--muted2,#8aa0c0)">' +
        esc(name) + ' <strong style="color:inherit">' + esc(text) + '</strong></span>');
    }
    var df = vf.dutyFactor, ct = vf.contactSeconds, ft = vf.flightSeconds, cad = vf.cadenceSpm;
    if (df && isNum(df.median)) chip('Duty factor', df.median.toFixed(3));
    if (ct && isNum(ct.median)) chip('Contact', Math.round(ct.median * 1000) + ' ms');
    if (ft && isNum(ft.median)) chip('Flight', Math.round(ft.median * 1000) + ' ms');
    if (cad && isNum(cad.median)) chip('Step rate', Math.round(cad.median) + ' spm');
    chip('Steps', String(vf.stepsAnalyzed || 0) + (vf.stepsRejected ? ' (' + vf.stepsRejected + ' rejected)' : ''));
    return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:11px">' + chips.join('') + '</div>';
  }

  /**
   * Exported so the copy-audit tests can assert on this block alone: it is the
   * one place a force number is shown, so it is the one place the "not measured"
   * rule has to hold word by word.
   */
  function verticalForceSection(result) {
    var vf = result && result.verticalForce;
    if (!vf) return '';

    if (vf.availability !== KFO.AVAILABILITY.AVAILABLE) {
      return box(
        label('Estimated vertical force') +
        '<div style="font-size:12px;line-height:1.6">' +
        esc(FORCE_UNAVAILABLE_REASON[vf.reason] ||
            'A vertical force estimate could not be produced from this clip’s timing.') + '</div>' +
        '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:7px;font-family:var(--mono,monospace)">' +
        'reason: ' + esc(vf.reason || 'unavailable') + '</div>'
      );
    }

    var rel = isNum(vf.relativeUncertainty) ? vf.relativeUncertainty : null;
    var peakSd = (vf.peakVerticalForceBw && isNum(vf.peakVerticalForceBw.sd))
      ? 'Step-to-step SD ' + vf.peakVerticalForceBw.sd.toFixed(2) + ' BW' : null;
    var meanSub = 'Exact consequence of the impulse balance, given the timing.';

    var caveats = (vf.caveats || []).map(function (c) {
      return '<li style="margin-bottom:3px">' + esc(c) + '</li>';
    }).join('');

    var horiz = vf.horizontal || {};

    return box(
      label('Estimated vertical force · headline') +
      '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">' +
      bigStat('Peak, per bodyweight', forceValue(vf.peakVerticalForceBw, rel), peakSd) +
      bigStat('Mean over contact', forceValue(vf.meanVerticalForceBw, rel), meanSub) +
      '</div>' +
      '<div style="margin-top:11px;padding:8px 11px;border-left:3px solid var(--warn,#f5a623);' +
      'background:rgba(245,166,35,.08);border-radius:6px;font-size:11.5px;line-height:1.55">' +
      '<strong>' + esc(FORCE_NOTICE) + '</strong></div>' +
      timingChips(vf) +
      (vf.peakBiasNote ? '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:9px;line-height:1.5">' +
        esc(vf.peakBiasNote) + '</div>' : '') +
      (caveats ? '<ul style="margin:8px 0 0;padding-left:16px;font-size:11px;line-height:1.55;' +
        'color:var(--muted2,#8aa0c0)">' + caveats + '</ul>' : '') +
      '<div style="margin-top:9px;padding-top:8px;border-top:1px dashed var(--border,#243044);' +
      'font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.5">' +
      '<strong>Horizontal force is not reported.</strong> ' +
      esc(horiz.explanation || 'At constant average speed the braking and propulsive impulses cancel, so ' +
        'there is no net horizontal force to report.') + '</div>' +
      '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;' +
      'color:var(--muted2,#8aa0c0)">How this is derived</summary>' +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:5px;line-height:1.55">' +
      esc(FORCE_METHOD_NOTE) + ' Force is computed per step and then aggregated, because 1 / duty factor ' +
      'is convex and averaging duty factor first would bias the result.</div></details>'
    );
  }

  // ── Summary cards ─────────────────────────────────────────────────────────
  function phaseCard(result, phase) {
    var win = KFO.PHASE_WINDOWS[phase];
    var l = result.left && result.left.phases ? result.left.phases[phase] : null;
    var r = result.right && result.right.phases ? result.right.phases[phase] : null;

    function sideLine(side, p) {
      if (!p || !isNum(p.angle.median)) {
        return '<div style="font-size:12px;color:var(--muted2,#8aa0c0)">' + side + ': not available</div>';
      }
      var u = p.confidence ? p.confidence.angleUncertaintyDegrees : null;
      return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-top:3px">' +
        '<span style="color:var(--muted2,#8aa0c0)">' + side + '</span>' +
        '<span style="font-weight:700;color:' + orientationColor(p.angle.median) + '">' +
        esc(KFO.formatAngle(p.angle.median, u)) + '</span>' +
        '<span style="color:var(--muted2,#8aa0c0)">n=' + p.angle.n + '</span>' +
        '</div>';
    }

    var repr = (l && isNum(l.angle.median)) ? l.angle.median : (r && isNum(r.angle.median) ? r.angle.median : null);
    return box(
      label(win.label + ' · ' + win.minPercent + '–' + win.maxPercent + '% of stance') +
      '<div style="font-size:13px;font-weight:700;margin-bottom:6px">' + esc(orientationWord(repr)) + '</div>' +
      sideLine('Left', l) + sideLine('Right', r) +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:7px;line-height:1.45">' +
      esc(win.intent) + '</div>'
    );
  }

  function metricCard(title, value, note, band) {
    return box(
      label(title) +
      '<div style="font-size:15px;font-weight:800;color:' + bandColor(band) + '">' + esc(value) + '</div>' +
      (note ? '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:5px;line-height:1.45">' +
        esc(note) + '</div>' : '')
    );
  }

  /**
   * Support-line geometry, demoted to a secondary row. Orientation says which way
   * the support line points; it never says how hard the runner pushes, so it sits
   * below the force headline rather than beside it.
   */
  function geometryGrid(result) {
    var cards = KFO.PHASE_ORDER.map(function (p) { return phaseCard(result, p); });
    return '<div style="margin-top:14px">' +
      '<div style="font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:3px">Support-line geometry · secondary</div>' +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-bottom:8px;line-height:1.5">' +
      'The support-line angle is a geometric descriptor of orientation across stance. It carries no force ' +
      'magnitude, and a near-vertical late stance is not a deficiency.</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px">' +
      cards.join('') + '</div></div>';
  }

  function summaryGrid(result) {
    var cards = [];

    var sym = result.symmetry || {};
    cards.push(metricCard('Left / right symmetry',
      sym.available ? (sym.band === 'high' ? 'High' : sym.band === 'moderate' ? 'Moderate' : 'Low') : 'Not available',
      sym.available ? 'Largest side difference ' + sym.maxAbsoluteDifferenceDegrees.toFixed(1) + '° in median support-line angle.'
                    : (sym.reason || ''),
      sym.band));

    var cons = result.consistency || {};
    var cl = cons.left || {}, cr = cons.right || {};
    var worstBand = (cl.band === 'low' || cr.band === 'low') ? 'low'
                  : (cl.band === 'moderate' || cr.band === 'moderate') ? 'moderate'
                  : (cl.band === 'high' || cr.band === 'high') ? 'high' : 'unknown';
    var consNote = [];
    if (isNum(cl.maxPhaseSdDegrees)) consNote.push('left SD ' + cl.maxPhaseSdDegrees.toFixed(1) + '°');
    if (isNum(cr.maxPhaseSdDegrees)) consNote.push('right SD ' + cr.maxPhaseSdDegrees.toFixed(1) + '°');
    cards.push(metricCard('Stride consistency',
      worstBand === 'unknown' ? 'Not available' : worstBand.charAt(0).toUpperCase() + worstBand.slice(1),
      consNote.length ? 'Stride-to-stride spread: ' + consNote.join(', ') + '.' : '',
      worstBand));

    var q = result.quality || {};
    var conf = q.confidence || {};
    cards.push(metricCard('Data confidence',
      isNum(conf.score) ? Math.round(conf.score * 100) + '/100' : 'Not available',
      (isNum(conf.angleUncertaintyDegrees) ? 'Angle uncertainty ±' + conf.angleUncertaintyDegrees.toFixed(1) + '°. ' : '') +
      'Strides: L ' + ((result.left && result.left.stridesAnalyzed) || 0) +
      ', R ' + ((result.right && result.right.stridesAnalyzed) || 0) + '.',
      q.confidenceBand));

    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px">' +
      cards.join('') + '</div>';
  }

  // ── Coupled pattern narrative ─────────────────────────────────────────────
  function coupledSection(result) {
    var cp = result.coupledPattern || {};
    if (!cp.left && !cp.right) return '';
    function row(side, c) {
      if (!c) return '';
      var exc = isNum(c.foreAftGeometricExcursionDegrees)
        ? c.foreAftGeometricExcursionDegrees.toFixed(1) + '°' : '—';
      return '<div style="margin-top:8px">' +
        '<div style="font-size:12px;font-weight:700;text-transform:capitalize">' + esc(side) + '</div>' +
        '<div style="font-size:11.5px;color:var(--muted2,#8aa0c0);margin-top:2px">' +
        'Fore–aft geometric excursion ' + esc(exc) +
        (isNum(c.brakingMagnitudeDegrees) ? ' (braking ' + c.brakingMagnitudeDegrees.toFixed(1) +
          '° + propulsive ' + c.propulsiveMagnitudeDegrees.toFixed(1) + '°)' : '') + '</div>' +
        '<div style="font-size:11.5px;margin-top:4px;line-height:1.5">' + esc(c.interpretation) + '</div>' +
        '</div>';
    }
    var diff = '';
    if (isNum(cp.excursionDifferenceDegrees) && cp.higherExcursionSide) {
      diff = '<div style="font-size:11.5px;margin-top:9px;padding-top:8px;border-top:1px dashed var(--border,#243044)">' +
        'The <strong>' + esc(cp.higherExcursionSide) + '</strong> side shows a larger fore–aft geometric excursion ' +
        'than the other, by ' + cp.excursionDifferenceDegrees.toFixed(1) + '°. Force magnitude is not available ' +
        'from this analysis, so this describes geometry only.</div>';
    }
    return box(
      label('Coupled braking / propulsion pattern') +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.5">' +
      'Braking and propulsion are interpreted together. A larger excursion is reported as greater braking and ' +
      're-propulsion demand — it is not treated as better propulsion.</div>' +
      row('left', cp.left) + row('right', cp.right) + diff,
      'margin-top:12px'
    );
  }

  // ── Reference similarity (kept visually distinct from anything score-like) ──
  function referenceSection(result) {
    var rc = result.referenceComparison || {};
    function sideBlock(side, data) {
      if (!data) return '';
      var rows = KFO.PHASE_ORDER.map(function (p) {
        var e = data.phases ? data.phases[p] : null;
        var win = KFO.PHASE_WINDOWS[p];
        if (!e || !e.available) {
          return '<tr><td style="padding:3px 6px">' + esc(win.label) + '</td>' +
            '<td colspan="2" style="padding:3px 6px;color:var(--muted2,#8aa0c0)">' +
            esc((e && (e.note || e.reason)) || 'no reference') + '</td></tr>';
        }
        return '<tr><td style="padding:3px 6px">' + esc(win.label) + '</td>' +
          '<td style="padding:3px 6px;font-weight:700">' + e.similarity + '/100</td>' +
          '<td style="padding:3px 6px;font-size:10.5px;color:var(--muted2,#8aa0c0)">' + esc(e.note || '') +
          (e.record && e.record.assumptions && e.record.assumptions.length
            ? '<br>' + esc(e.record.assumptions.join('; ')) : '') + '</td></tr>';
      }).join('');
      return '<div style="margin-top:7px"><div style="font-size:11.5px;font-weight:700;text-transform:capitalize">' +
        esc(side) + '</div><table style="width:100%;border-collapse:collapse;font-size:11.5px">' + rows + '</table></div>';
    }
    return box(
      label('Reference similarity') +
      '<div style="font-size:11px;color:var(--warn,#f5a623);font-weight:700;line-height:1.5">' +
      esc(ECONOMY_DISCLAIMER) + '</div>' +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:4px;line-height:1.5">' +
      'This is distance from a reference distribution, nothing more. Matching a reference mean is not evidence ' +
      'of an optimised stride.</div>' +
      sideBlock('left', rc.left) + sideBlock('right', rc.right),
      'margin-top:12px'
    );
  }

  // ── Quality warnings ──────────────────────────────────────────────────────
  function qualitySection(result) {
    var q = result.quality || {};
    var flags = q.flags || [];
    if (!flags.length) return '';
    var items = flags.map(function (f) {
      return '<li style="margin-bottom:2px">' + esc(KFO.FLAG_LABEL[f] || f) +
        ' <span style="color:var(--muted2,#8aa0c0);font-size:10px">(' + esc(f) + ')</span></li>';
    }).join('');
    return box(
      label('Data quality flags') +
      '<ul style="margin:0;padding-left:16px;font-size:11.5px;line-height:1.55">' + items + '</ul>',
      'margin-top:12px'
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  function distributionTable(side) {
    if (!side || !side.phases) return '';
    var rows = KFO.PHASE_ORDER.map(function (p) {
      var ph = side.phases[p], a = ph.angle;
      var conf = ph.confidence || {};
      function n(v, dp) { return isNum(v) ? v.toFixed(dp == null ? 1 : dp) + '°' : '—'; }
      return '<tr>' +
        '<td style="padding:3px 5px">' + esc(ph.label) + '</td>' +
        '<td style="padding:3px 5px">' + a.n + '</td>' +
        '<td style="padding:3px 5px;font-weight:700;color:' + orientationColor(a.median) + '">' + n(a.median) + '</td>' +
        '<td style="padding:3px 5px">' + n(a.mean) + '</td>' +
        '<td style="padding:3px 5px">' + n(a.sd) + '</td>' +
        '<td style="padding:3px 5px">' + n(a.iqr) + '</td>' +
        '<td style="padding:3px 5px">' + (a.ci95 ? n(a.ci95[0]) + ' to ' + n(a.ci95[1]) : '—') + '</td>' +
        '<td style="padding:3px 5px">' + n(a.min) + ' / ' + n(a.max) + '</td>' +
        '<td style="padding:3px 5px">' + (a.outlierCount || 0) + '</td>' +
        '<td style="padding:3px 5px">' + (isNum(conf.angleUncertaintyDegrees) ? '±' + conf.angleUncertaintyDegrees.toFixed(1) + '°' : '—') + '</td>' +
        '<td style="padding:3px 5px">' + n(ph.comLegDivergence ? ph.comLegDivergence.median : null) + '</td>' +
        '<td style="padding:3px 5px">' + (isNum(ph.meanEventConfidence) ? ph.meanEventConfidence.toFixed(2) : '—') + '</td>' +
        '</tr>';
    }).join('');
    return '<div style="overflow-x:auto;margin-top:6px"><table style="width:100%;min-width:760px;border-collapse:collapse;font-size:11px">' +
      '<thead><tr style="text-align:left;color:var(--muted2,#8aa0c0);border-bottom:1px solid var(--border,#243044)">' +
      '<th style="padding:4px 5px">Phase</th><th>n</th><th>Median</th><th>Mean</th><th>SD</th><th>IQR</th>' +
      '<th>95% CI</th><th>Min / Max</th><th>Outliers</th><th>Uncertainty</th><th>COM↔leg</th><th>Event conf.</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function detailSection(result) {
    var vm = result.videoMetadata || {};
    var defs = KFO.PHASE_ORDER.map(function (p) {
      var w = KFO.PHASE_WINDOWS[p];
      return '<li><strong>' + esc(w.label) + '</strong> — ' + w.minPercent + '–' + w.maxPercent +
        '% of stance (target ' + w.targetPercent + '%). ' + esc(w.intent) + '</li>';
    }).join('');

    var sideBlocks = ['left', 'right'].map(function (s) {
      var sd = result[s];
      if (!sd) return '';
      return '<div style="margin-top:10px"><div style="font-size:12px;font-weight:700;text-transform:capitalize">' +
        esc(s) + ' — ' + sd.stridesAnalyzed + ' strides analysed, ' + sd.stridesRejected + ' rejected</div>' +
        distributionTable(sd) + '</div>';
    }).join('');

    return '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;font-weight:700">' +
      'Detailed view — distributions, method, phase definitions</summary>' +
      '<div style="margin-top:10px">' +
      box(label('How this is estimated') +
        '<div style="font-size:11.5px;line-height:1.6">' + esc(METHOD_EXPLANATION) + '</div>' +
        '<div style="font-size:11.5px;line-height:1.6;margin-top:6px">Sign convention: negative = braking ' +
        'orientation, positive = propulsive orientation, zero = vertical support. Angles are measured from ' +
        'true vertical and normalised for the direction of travel, so mirrored or right-to-left footage reads ' +
        'the same way.</div>' +
        '<div style="font-size:11.5px;line-height:1.6;margin-top:6px">Support point: ' +
        esc(KFO.SUPPORT_POINT_MODEL.note) + ' It is an <strong>estimated support point</strong>, not centre of ' +
        'pressure.</div>') +
      box(label('Stance phase definitions') +
        '<ul style="margin:0;padding-left:16px;font-size:11.5px;line-height:1.6">' + defs + '</ul>' +
        '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:6px;line-height:1.5">' +
        'Exact foot strike and toe-off are deliberately excluded: force magnitude approaches zero at those ' +
        'instants, so orientation there is both ill-conditioned and mechanically uninformative. They remain ' +
        'available on the stride-analysis cards.</div>', 'margin-top:10px') +
      sideBlocks +
      box(label('Method and versions') +
        '<div style="font-size:11px;line-height:1.7;font-family:var(--mono,monospace)">' +
        'method: ' + esc(result.method) + '<br>' +
        'modelVersion: ' + esc(result.modelVersion) + '<br>' +
        'referenceVersion: ' + esc(result.referenceVersion) + '<br>' +
        'schemaVersion: ' + esc(result.schemaVersion) + '<br>' +
        'isValidated: ' + (result.isValidated ? 'true' : 'false') + '<br>' +
        'runningDirection: ' + esc(vm.runningDirection) + ' (source: ' + esc(vm.runningDirectionSource) +
        ', confidence ' + (isNum(vm.runningDirectionConfidence) ? vm.runningDirectionConfidence.toFixed(2) : '—') + ')<br>' +
        'effectiveSampleRateHz: ' + (isNum(vm.effectiveSampleRateHz) ? vm.effectiveSampleRateHz.toFixed(1) : '—') + '<br>' +
        'estimatedSpeedMps: ' + (vm.estimatedSpeedMps == null ? 'null' : esc(vm.estimatedSpeedMps)) + '<br>' +
        'forceMetrics: ' + esc(result.forceMetrics ? result.forceMetrics.availability : 'unavailable') +
        ' (' + esc(result.forceMetrics ? result.forceMetrics.reason : '') + ')<br>' +
        'verticalForce.method: ' + esc(result.verticalForce ? (result.verticalForce.method || 'null') : 'null') + '<br>' +
        'verticalForce.availability: ' + esc(result.verticalForce ? result.verticalForce.availability : 'unavailable') +
        '<br>verticalForce.isValidated: ' +
        ((result.verticalForce && result.verticalForce.isValidated) ? 'true' : 'false') + '<br>' +
        'verticalForce.runLoadDfProxy: ' +
        ((result.verticalForce && result.verticalForce.runLoadDfProxy &&
          isNum(result.verticalForce.runLoadDfProxy.value))
            ? Math.round(result.verticalForce.runLoadDfProxy.value) +
              ' (' + esc(result.verticalForce.runLoadDfProxy.convention) + ')'
            : 'null') +
        '</div>' +
        (result.verticalForce && result.verticalForce.limitations &&
         result.verticalForce.limitations.length
          ? '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:7px;line-height:1.5">' +
            'Vertical force limitations: ' + esc(result.verticalForce.limitations.join(' · ')) + '</div>'
          : '') +
        '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:7px;line-height:1.5">Limitations: ' +
        esc((result.limitations || []).join(' · ')) + '</div>', 'margin-top:10px') +
      '</div></details>';
  }

  // ── Unavailable states ────────────────────────────────────────────────────
  function unavailableHtml(result, extraNote) {
    var reason = (result && result.reason) || 'unavailable';
    var flags = (result && result.quality && result.quality.flagLabels) || [];
    return wrapper(
      box(label('Not available for this session') +
        '<div style="font-size:12px;line-height:1.6">' + esc(reasonText(reason)) + '</div>' +
        (extraNote ? '<div style="font-size:11.5px;color:var(--muted2,#8aa0c0);margin-top:6px">' +
          esc(extraNote) + '</div>' : '') +
        (flags.length ? '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:6px">' +
          esc(flags.join(' · ')) + '</div>' : '') +
        '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:8px;font-family:var(--mono,monospace)">' +
        'reason: ' + esc(reason) + '</div>')
    );
  }

  function reasonText(reason) {
    var map = {
      insufficient_samples: 'Too few analysable frames in this clip to identify stance phases.',
      running_direction_unknown: 'The direction of travel could not be established, so the braking/propulsive ' +
        'sign convention cannot be applied.',
      no_valid_stance_phases_detected: 'No clean stance phases passed the quality checks in this clip.',
      analysis_predates_kinematic_force_orientation: 'This session was saved before this analysis existed. ' +
        'Pose keypoints were not stored, so it cannot be computed retroactively.'
    };
    return map[reason] || 'This analysis could not be produced for this session.';
  }

  // ── Wrapper with the persistent notice ────────────────────────────────────
  function extraNotice(text) {
    if (!text) return '';
    return '<div style="margin-bottom:10px;padding:8px 11px;border-left:3px solid var(--purple,#8b7cf8);' +
      'background:rgba(139,124,248,.08);border-radius:6px;font-size:11px;line-height:1.5">' +
      esc(text) + '</div>';
  }

  function wrapper(inner, badgeText) {
    return '<div id="kfo-report" style="margin-top:26px;padding:18px;border:1px solid var(--border2,#2a3550);' +
      'border-radius:12px;background:var(--panel,#0f1420)">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">' +
      '<div><div style="font-weight:800;letter-spacing:.3px;font-size:15px">' + esc(FEATURE_TITLE) +
      '<span style="font-size:10px;color:var(--gold,#f5c451);border:1px solid var(--gold,#f5c451);' +
      'border-radius:20px;padding:2px 8px;margin-left:8px;vertical-align:middle">' +
      esc(badgeText || 'ADMIN · V2') + '</span></div>' +
      '<div style="font-size:11.5px;color:var(--muted2,#8aa0c0);margin-top:3px">' + esc(FEATURE_SUBTITLE) + '</div>' +
      '</div></div>' +
      '<div style="margin:11px 0;padding:9px 12px;border-left:3px solid var(--warn,#f5a623);' +
      'background:rgba(245,166,35,.08);border-radius:6px;font-size:11.5px;line-height:1.55">' +
      '<strong>' + esc(PERSISTENT_NOTICE) + '</strong>' +
      '<details style="margin-top:5px"><summary style="cursor:pointer;color:var(--muted2,#8aa0c0)">' +
      'What does that mean?</summary><div style="margin-top:5px;color:var(--muted2,#8aa0c0)">' +
      esc(METHOD_EXPLANATION) + '</div></details></div>' +
      inner +
      '</div>';
  }

  /**
   * @param {Object} result  a KFO analysis result, or a migrated envelope
   * @returns {string} HTML
   */
  function buildHtml(result, opts) {
    opts = opts || {};
    if (!result) return unavailableHtml({ reason: 'unavailable' });
    if (result.availability !== KFO.AVAILABILITY.AVAILABLE) {
      var note = result.availability === KFO.AVAILABILITY.INSUFFICIENT_QUALITY
        ? 'Stance phases were found, but data confidence was too low to report a comparison.' : null;
      return unavailableHtml(result, note || opts.notice);
    }
    return wrapper(
      extraNotice(opts.notice) +
      verticalForceSection(result) +
      geometryGrid(result) +
      '<div style="margin-top:10px">' + summaryGrid(result) + '</div>' +
      coupledSection(result) +
      referenceSection(result) +
      qualitySection(result) +
      detailSection(result)
    );
  }

  // ── Stored-form rendering ─────────────────────────────────────────────────
  /**
   * Rehydrate the compact persisted block into the shape `buildHtml` expects.
   * Stride-level detail is not persisted, so the fields that depended on it
   * (IQR, min/max, outliers, per-phase divergence) come back as null and render
   * as "—" rather than as zeros that would look like real measurements.
   */
  function fromStoredForm(stored) {
    if (!stored) return null;
    function side(s) {
      if (!s) return null;
      var phases = {};
      KFO.PHASE_ORDER.forEach(function (p) {
        var sp = s.phases ? s.phases[p] : null;
        var win = KFO.PHASE_WINDOWS[p];
        phases[p] = {
          phase: p, label: win.label,
          window: { minPercent: win.minPercent, maxPercent: win.maxPercent, targetPercent: win.targetPercent },
          angle: {
            n: sp && isNum(sp.n) ? sp.n : 0,
            median: sp ? sp.median : null, mean: sp ? sp.mean : null, sd: sp ? sp.sd : null,
            iqr: null, min: null, max: null, q1: null, q3: null,
            ci95: sp ? sp.ci95 : null, sem: null, outlierCount: 0, outliers: []
          },
          comLegDivergence: { n: 0, median: null, mean: null, sd: null, iqr: null, min: null, max: null,
                              q1: null, q3: null, ci95: null, sem: null, outlierCount: 0, outliers: [] },
          meanPoseConfidence: null,
          meanEventConfidence: null,
          confidence: {
            score: sp ? sp.confidence : null,
            angleUncertaintyDegrees: sp ? sp.uncertaintyDegrees : null,
            components: null
          }
        };
      });
      return { side: s === stored.left ? 'left' : 'right',
               stridesAnalyzed: s.stridesAnalyzed || 0, stridesRejected: s.stridesRejected || 0,
               phases: phases, strides: null };
    }
    return {
      analysisType: stored.analysisType, schemaVersion: stored.schemaVersion,
      method: stored.method, modelVersion: stored.modelVersion,
      referenceVersion: stored.referenceVersion, isValidated: !!stored.isValidated,
      availability: stored.availability, reason: stored.reason || null,
      angleConvention: stored.angleConvention || {
        units: 'degrees', referenceAxis: 'vertical',
        negative: 'braking orientation', positive: 'propulsive orientation', zero: 'vertical support'
      },
      limitations: stored.limitations || [],
      videoMetadata: stored.videoMetadata || {},
      quality: stored.quality ? {
        flags: stored.quality.flags || [],
        flagLabels: (stored.quality.flags || []).map(function (f) { return KFO.FLAG_LABEL[f] || f; }),
        confidence: { score: stored.quality.confidenceScore, angleUncertaintyDegrees: null },
        confidenceBand: stored.quality.confidenceBand
      } : null,
      left: side(stored.left), right: side(stored.right),
      // The persisted force block is already the aggregate shape the card reads,
      // so it needs no reshaping — only a null guard for pre-force saves.
      verticalForce: stored.verticalForce || null,
      symmetry: stored.symmetry || { available: false, reason: 'not_persisted' },
      consistency: { left: {}, right: {} },
      coupledPattern: stored.coupledPattern || {},
      referenceComparison: { left: null, right: null, disclaimer: ECONOMY_DISCLAIMER },
      forceMetrics: { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'geometry_proxy_has_no_force_magnitude' },
      restoredFromSavedSession: true
    };
  }

  function buildStoredHtml(stored) {
    var result = fromStoredForm(stored);
    if (!result) return unavailableHtml({ reason: 'unavailable' });
    return buildHtml(result, {
      notice: 'Restored from a saved session. Aggregate values were stored; stride-level detail was not, ' +
        'so distributions show only what was persisted.'
    });
  }

  // ── Canvas overlay ────────────────────────────────────────────────────────
  // Arrows are drawn at a FIXED length. Only direction is estimated, so a
  // variable-length arrow would imply a magnitude this method does not produce.
  var OVERLAY = Object.freeze({
    fixedArrowLengthFraction: 0.40,
    orientationOnly: true,
    caption: 'Orientation only — arrow length is fixed and carries no magnitude.'
  });

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} o  {com, supportPoint, angleDegrees, phase, stancePercent,
   *                     confidenceScore, runningDirection, canvasHeight}
   */
  function drawOverlay(ctx, o) {
    if (!ctx || !o || !o.com || !o.supportPoint) return;
    var len = (o.canvasHeight || 400) * OVERLAY.fixedArrowLengthFraction;
    var c = o.supportPoint, com = o.com;

    function arrow(fromX, fromY, toX, toY, color, width) {
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width || 3;
      ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
      var a = Math.atan2(toY - fromY, toX - fromX), h = 10;
      ctx.beginPath(); ctx.moveTo(toX, toY);
      ctx.lineTo(toX - h * Math.cos(a - 0.4), toY - h * Math.sin(a - 0.4));
      ctx.lineTo(toX - h * Math.cos(a + 0.4), toY - h * Math.sin(a + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Vertical reference.
    arrow(c.x, c.y, c.x, c.y - len, 'rgba(139,124,248,.85)', 2);
    // Support line, at the SAME fixed length as the vertical reference.
    var vx = com.x - c.x, vy = com.y - c.y, vm = Math.hypot(vx, vy) || 1;
    var col = !isNum(o.angleDegrees) ? '#8aa0c0'
            : o.angleDegrees < -4 ? '#ff5d5d'
            : o.angleDegrees > 4 ? '#00e5c8' : '#8b7cf8';
    arrow(c.x, c.y, c.x + vx / vm * len, c.y + vy / vm * len, col, 4);

    // Markers.
    ctx.save();
    ctx.beginPath(); ctx.arc(com.x, com.y, 6, 0, 6.2832);
    ctx.fillStyle = '#f5c451'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, 6.2832);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    ctx.restore();

    // Caption block.
    var lines = [
      (KFO.PHASE_WINDOWS[o.phase] ? KFO.PHASE_WINDOWS[o.phase].label : o.phase || '') +
        (isNum(o.stancePercent) ? ' · ' + o.stancePercent.toFixed(0) + '% of stance' : ''),
      'Support-line angle ' + KFO.formatAngle(o.angleDegrees, o.uncertaintyDegrees),
      'Confidence ' + (isNum(o.confidenceScore) ? Math.round(o.confidenceScore * 100) + '/100' : '—') +
        ' · ' + String(o.runningDirection || '').replace(/_/g, ' '),
      OVERLAY.caption
    ];
    ctx.save();
    ctx.font = '600 11px "Space Mono", monospace';
    var w = 0;
    lines.forEach(function (t) { w = Math.max(w, ctx.measureText(t).width); });
    ctx.fillStyle = 'rgba(6,8,13,.82)';
    ctx.fillRect(8, 8, w + 16, lines.length * 15 + 10);
    ctx.fillStyle = '#e6ecf5'; ctx.textBaseline = 'top';
    lines.forEach(function (t, i) { ctx.fillText(t, 16, 14 + i * 15); });
    ctx.restore();
  }

  // ── DOM mount ─────────────────────────────────────────────────────────────
  function mount(result, hostId) {
    if (typeof document === 'undefined') return null;
    var host = document.getElementById(hostId || 'kfo-admin-report');
    if (!host) {
      host = document.createElement('div');
      host.id = hostId || 'kfo-admin-report';
      var details = document.getElementById('report-details');
      var section = document.getElementById('report-section');
      if (details && details.parentNode) details.parentNode.insertBefore(host, details.nextSibling);
      else if (section) section.appendChild(host);
      else return null;
    }
    host.innerHTML = buildHtml(result);
    return host;
  }

  return {
    FEATURE_TITLE: FEATURE_TITLE,
    FEATURE_SUBTITLE: FEATURE_SUBTITLE,
    PERSISTENT_NOTICE: PERSISTENT_NOTICE,
    METHOD_EXPLANATION: METHOD_EXPLANATION,
    ECONOMY_DISCLAIMER: ECONOMY_DISCLAIMER,
    FORCE_NOTICE: FORCE_NOTICE,
    FORCE_METHOD_NOTE: FORCE_METHOD_NOTE,
    OVERLAY: OVERLAY,
    verticalForceSection: verticalForceSection,
    buildHtml: buildHtml,
    buildStoredHtml: buildStoredHtml,
    fromStoredForm: fromStoredForm,
    unavailableHtml: unavailableHtml,
    drawOverlay: drawOverlay,
    mount: mount,
    orientationWord: orientationWord
  };
});
