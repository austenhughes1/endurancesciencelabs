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

  // ── Momentum-preservation proxies (geometry-only) ──────────────────────────
  //
  // What the geometry path can honestly say about braking and replacement. Every
  // row is in DEGREES and named as a proxy, so nothing here can be misread as an
  // impulse or a force share. The closing line states the unavailability rather
  // than leaving the reader to infer it from an absence.
  var PROXY_UNAVAILABLE_NOTE = 'Force and impulse percentages require force magnitude and are not ' +
    'available from geometry-only video.';

  function proxyRow(name, m) {
    if (!m) return '';
    var val = isNum(m.medianDegrees) ? KFO.formatAngle(m.medianDegrees, m.sdDegrees) : '—';
    return '<tr><td style="padding:3px 6px">' + esc(name) + '</td>' +
      '<td style="padding:3px 6px;font-weight:700;color:' + orientationColor(m.medianDegrees) + '">' +
      esc(val) + '</td>' +
      '<td style="padding:3px 6px;color:var(--muted2,#8aa0c0)">n=' + (m.n || 0) + '</td></tr>';
  }

  function proxySideBlock(side, p) {
    if (!p) return '';
    var exc = p.foreAftGeometricExcursion;
    var rows = proxyRow('Early-stance braking orientation', p.brakingOrientationProxy) +
      proxyRow('Central-stance support alignment', p.supportAlignmentProxy) +
      proxyRow('Late-stance replacement orientation', p.replacementOrientationProxy) +
      (exc && isNum(exc.valueDegrees)
        ? '<tr><td style="padding:3px 6px">Fore–aft geometric excursion</td>' +
          '<td style="padding:3px 6px;font-weight:700">' + exc.valueDegrees.toFixed(1) + '°</td>' +
          '<td style="padding:3px 6px;color:var(--muted2,#8aa0c0)">span</td></tr>'
        : '');
    return '<div style="margin-top:7px">' +
      '<div style="font-size:11.5px;font-weight:700;text-transform:capitalize">' + esc(side) + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' + rows + '</table></div>';
  }

  function momentumProxySection(result) {
    var p = result && result.momentumPreservationProxies;
    if (!p || p.availability !== 'available') return '';
    var diff = '';
    if (isNum(p.leftRightDifferenceDegrees)) {
      diff = '<div style="font-size:11.5px;margin-top:8px">Left/right difference in fore–aft excursion: ' +
        '<strong>' + p.leftRightDifferenceDegrees.toFixed(1) + '°</strong>' +
        (p.higherExcursionSide ? ' (larger on the ' + esc(p.higherExcursionSide) + ')' : '') + '.</div>';
    }
    var conf = isNum(p.confidence)
      ? '<div style="font-size:11.5px;margin-top:4px;color:var(--muted2,#8aa0c0)">Confidence ' +
        Math.round(p.confidence * 100) + '/100 · ' + esc(KFO.confidenceBand(p.confidence)) + '</div>'
      : '';
    return box(
      label('Momentum-preservation proxies') +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.5">' +
      'Geometric precursors to braking and propulsive replacement, in degrees. They are orientations, ' +
      'not impulses, and not force shares.</div>' +
      proxySideBlock('left', p.left) + proxySideBlock('right', p.right) + diff + conf +
      '<div style="margin-top:9px;padding:7px 10px;border-left:3px solid var(--purple,#8b7cf8);' +
      'background:rgba(139,124,248,.08);border-radius:6px;font-size:11px;line-height:1.5">' +
      esc(PROXY_UNAVAILABLE_NOTE) + '</div>',
      'margin-top:12px'
    );
  }

  // ── Impulse accounting ────────────────────────────────────────────────────
  //
  // Three compositions, shown side by side and never reconciled into one number.
  // Deliberately NOT colour-banded and deliberately without a target: there is no
  // validated cutoff for any of them, and a red/green scale would invent one.
  var WHY_RATIOS_DIFFER = [
    ['Total vertical impulse vs effective vertical impulse',
     'Total vertical impulse (JvTotal = ∫Fz dt) includes the impulse needed just to hold bodyweight up ' +
     'during contact. Effective vertical impulse (JvEffective = ∫(Fz − BW) dt) is the part above ' +
     'bodyweight — the net upward projection, and the quantity in Dorn et al. 2012 equations A5–A6. ' +
     'Because the bodyweight-support portion is large, swapping one for the other moves the vertical ' +
     'share a long way.'],
    ['Replacement-only vs total turnover',
     'Counting only the propulsive impulse (JProp) gives the horizontal impulse needed to replace what ' +
     'braking removed. Counting braking as well (JBrake + JProp) gives the total fore-aft turnover, ' +
     'which is roughly double, so the horizontal share roughly doubles with it.'],
    ['Why the signed net is not used',
     'At steady speed the propulsive and braking impulses cancel, so the signed net horizontal impulse ' +
     '(JProp − JBrake) is near zero for everyone. It is a quality check on the steady-speed assumption, ' +
     'not a metric.'],
    ['85/15, 71/29 and 55/45 from one trial',
     'Reconstructing the Clark, Ryan & Weyand 2012 rounded means at 5 m/s gives 85.7% vertical on the ' +
     'first composition, 71.2% on the second and 55.3% on the third. Same trial, three accounting ' +
     'choices. None of them is a validated efficiency target.'],
    ['These are not vector percentages',
     'Each share is a magnitude divided by a sum of magnitudes — a scalar-sum share. It is not a ' +
     'direction cosine, not a percentage of a resultant force vector, and not an energy fraction. ' +
     'Where the horizontal term is a turnover sum it adds two opposing directions, so the angle ' +
     'equivalent corresponds to no physical direction at all.'],
    ['Impulse is not work',
     'Impulse (∫F dt) changes momentum; work (∫F·dx) changes energy. Braking and propulsion cancelling ' +
     'in impulse does not mean the energy cost cancels: the muscle does negative work then positive ' +
     'work, and both cost.']
  ];

  var IMPULSE_PANEL_NOTICE = 'Experimental force estimates. None of these compositions is a validated ' +
    'efficiency score, and no target value is applied to any of them.';

  function impulseFmt(v, unit) {
    if (!isNum(v)) return '—';
    var dp = unit === 'BW*s' ? 3 : 1;
    return v.toFixed(dp) + ' ' + (unit || '');
  }
  function pct(v) { return isNum(v) ? (v * 100).toFixed(1) + '%' : '—'; }

  function badge(text, color) {
    return '<span style="font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;' +
      'border:1px solid ' + color + ';color:' + color + ';border-radius:20px;padding:2px 7px">' +
      esc(text) + '</span>';
  }

  function compositionCard(c, ctx) {
    if (!c) return '';
    // The badge reads off the composition's OWN availability, not a caller flag:
    // "available" is reserved for a force source that has passed criterion
    // validation, so a source that merely claims to be validated still reads
    // experimental here.
    var badgeHtml = c.availability === 'unavailable'
      ? badge('unavailable', 'var(--muted2,#8aa0c0)')
      : c.availability === 'available'
        ? badge('validated', 'var(--cyan,#00e5c8)')
        : badge('experimental', 'var(--warn,#f5a623)');

    if (c.availability === 'unavailable') {
      return box(
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">' +
        '<div style="font-size:12.5px;font-weight:800">' + esc(c.label) + '</div>' + badgeHtml + '</div>' +
        '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:6px;line-height:1.5">' +
        esc(c.availabilityReason || 'Not available for this analysis.') + '</div>'
      );
    }

    var conf = ctx && isNum(ctx.confidenceScore)
      ? 'Confidence ' + Math.round(ctx.confidenceScore * 100) + '/100'
      : null;
    var vAgg = c.verticalShareAggregate;
    var spread = (vAgg && isNum(vAgg.sd))
      ? 'Stance-to-stance SD ' + (vAgg.sd * 100).toFixed(1) + ' pp over n=' + vAgg.n
      : null;

    return box(
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">' +
      '<div style="font-size:12.5px;font-weight:800">' + esc(c.label) + '</div>' + badgeHtml + '</div>' +

      '<div style="display:flex;gap:14px;margin-top:9px;flex-wrap:wrap">' +
      '<div style="flex:1 1 90px">' + label('Vertical') +
      '<div style="font-size:20px;font-weight:800;color:var(--cyan,#00e5c8);line-height:1.15">' +
      esc(pct(c.verticalShareScalarSum)) + '</div></div>' +
      '<div style="flex:1 1 90px">' + label('Horizontal') +
      '<div style="font-size:20px;font-weight:800;color:var(--purple,#8b7cf8);line-height:1.15">' +
      esc(pct(c.horizontalShareScalarSum)) + '</div></div>' +
      '</div>' +

      '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:9px">' +
      '<tr><td style="padding:2px 0;color:var(--muted2,#8aa0c0)">Numerator</td>' +
      '<td style="padding:2px 0;text-align:right">' + esc(c.numeratorLabel) + '</td></tr>' +
      '<tr><td style="padding:2px 0;color:var(--muted2,#8aa0c0)">Denominator</td>' +
      '<td style="padding:2px 0;text-align:right">' + esc(c.denominatorLabel) + '</td></tr>' +
      '<tr><td style="padding:2px 0;color:var(--muted2,#8aa0c0)">' +
      esc((c.verticalImpulse && c.verticalImpulse.symbol) || 'Vertical impulse') + '</td>' +
      '<td style="padding:2px 0;text-align:right;font-family:var(--mono,monospace)">' +
      esc(impulseFmt(c.verticalImpulse ? c.verticalImpulse.value : null,
                     c.verticalImpulse ? c.verticalImpulse.unit : null)) + '</td></tr>' +
      '<tr><td style="padding:2px 0;color:var(--muted2,#8aa0c0)">' +
      esc((c.horizontalImpulse && c.horizontalImpulse.symbol) || 'Horizontal impulse') + '</td>' +
      '<td style="padding:2px 0;text-align:right;font-family:var(--mono,monospace)">' +
      esc(impulseFmt(c.horizontalImpulse ? c.horizontalImpulse.value : null,
                     c.horizontalImpulse ? c.horizontalImpulse.unit : null)) + '</td></tr>' +
      '<tr><td style="padding:2px 0;color:var(--muted2,#8aa0c0)">Angle equivalent</td>' +
      '<td style="padding:2px 0;text-align:right;font-family:var(--mono,monospace)">' +
      (isNum(c.angleEquivalentDegrees) ? c.angleEquivalentDegrees.toFixed(1) + '°' : '—') + '</td></tr>' +
      '</table>' +

      ((conf || spread) ? '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:6px">' +
        esc([conf, spread].filter(Boolean).join(' · ')) + '</div>' : '') +

      '<div style="font-size:11px;line-height:1.5;margin-top:8px">' + esc(c.interpretation) + '</div>' +
      '<div style="font-size:11px;line-height:1.5;margin-top:6px;color:var(--warn,#f5a623)">' +
      '<strong>What this does not mean:</strong> ' + esc(c.disclaimer) + '</div>' +
      '<ul style="margin:6px 0 0;padding-left:15px;font-size:10.5px;line-height:1.5;' +
      'color:var(--muted2,#8aa0c0)">' +
      (c.limitations || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') +
      '</ul>' +
      '<div style="font-size:10px;color:var(--muted2,#8aa0c0);margin-top:6px;font-family:var(--mono,monospace)">' +
      'vertical: ' + esc(c.verticalBasis) + ' · horizontal: ' + esc(c.horizontalBasis) + ' · ' +
      esc(c.shareConvention || 'scalar_sum_share') + '</div>'
    );
  }

  function steadyStateRow(ss) {
    if (!ss) return '';
    var imb = isNum(ss.horizontalImpulseImbalance) ? pct(ss.horizontalImpulseImbalance) : '—';
    return box(
      label('Steady-state check · signed net horizontal impulse') +
      '<div style="font-size:11.5px;line-height:1.55">' +
      '<strong>' + esc(String(ss.state || '').replace(/_/g, ' ')) + '</strong> — imbalance ' + esc(imb) +
      ' (|JxNet| / JhTurnover). JxNet ' +
      (isNum(ss.JxNet) ? ss.JxNet.toFixed(3) : '—') + ', turnover ' +
      (isNum(ss.JhTurnover) ? ss.JhTurnover.toFixed(3) : '—') + '.</div>' +
      (ss.interpretation ? '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:5px;' +
        'line-height:1.5">' + esc(ss.interpretation) + '</div>' : '') +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:5px;line-height:1.5">' +
      'Thresholds ' + esc(String(ss.warnThreshold)) + ' / ' + esc(String(ss.rejectThreshold)) +
      ' are provisional internal working values, not validated cutoffs. Near-zero net horizontal ' +
      'impulse is the expected condition at steady speed, not an achievement.' +
      (ss.normativeComparisonAllowed ? '' : ' Normative comparison is withheld for this clip.') +
      '</div>',
      'margin-top:10px'
    );
  }

  function momentumPreservationRow(mp) {
    if (!mp || !mp.interpretation || !mp.interpretation.length) return '';
    var items = mp.interpretation.map(function (t) {
      return '<li style="margin-bottom:3px">' + esc(t) + '</li>';
    }).join('');
    function line(name, a) {
      if (!a || !isNum(a.value)) return '';
      return '<tr><td style="padding:2px 6px 2px 0;color:var(--muted2,#8aa0c0)">' + esc(name) + '</td>' +
        '<td style="padding:2px 0;text-align:right;font-family:var(--mono,monospace)">' +
        esc(impulseFmt(a.value, a.unit)) + '</td>' +
        '<td style="padding:2px 0 2px 8px;color:var(--muted2,#8aa0c0);font-size:10px">' +
        esc(a.basis || '') + '</td></tr>';
    }
    return box(
      label('Momentum-preservation reading') +
      '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      line('Braking demand', mp.brakingDemand) +
      line('Replacement demand', mp.replacementDemand) +
      line('Fore–aft turnover', mp.foreAftTurnover) +
      line('Effective projection', mp.effectiveProjection) +
      line('Left/right asymmetry', mp.leftRightAsymmetry) +
      '</table>' +
      '<ul style="margin:8px 0 0;padding-left:16px;font-size:11.5px;line-height:1.55">' + items + '</ul>',
      'margin-top:10px'
    );
  }

  function whyRatiosDiffer() {
    var body = WHY_RATIOS_DIFFER.map(function (pair) {
      return '<div style="margin-top:7px"><div style="font-size:11.5px;font-weight:700">' +
        esc(pair[0]) + '</div><div style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.55;' +
        'margin-top:2px">' + esc(pair[1]) + '</div></div>';
    }).join('');
    return '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;' +
      'font-weight:700">Why do these ratios differ?</summary>' +
      '<div style="margin-top:4px">' + body + '</div></details>';
  }

  /**
   * Exported so the copy-audit tests can assert on this panel alone: it is the
   * only place a force SHARE is shown, so it is the only place the
   * "no universal ratio, no efficiency claim" rule has to hold word by word.
   */
  function impulseAccountingSection(result) {
    var im = result && result.impulseMetrics;
    if (!im) return '';

    if (im.availability === 'unavailable' || !im.combined) {
      return box(
        label('Impulse accounting') +
        '<div style="font-size:12px;line-height:1.6">' + esc(PROXY_UNAVAILABLE_NOTE) + '</div>' +
        '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:6px;line-height:1.55">' +
        'Total and effective vertical impulse, braking impulse and propulsive replacement impulse all ' +
        'need a force-time series. Support-line angles carry no magnitude, so none of them can be ' +
        'derived from this analysis.</div>' +
        '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:6px;line-height:1.55">' +
        'Nothing is subtracted from the landing phase to reach this state — there is no force signal to ' +
        'partition. Vertical impact and horizontal braking impulse remain separate quantities and one is ' +
        'never used in place of the other.</div>' +
        '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:7px;' +
        'font-family:var(--mono,monospace)">reason: ' + esc(im.reason || 'unavailable') + '</div>' +
        whyRatiosDiffer(),
        'margin-top:12px'
      );
    }

    var comps = im.combined.compositions || {};
    var ctx = {
      isValidated: !!im.isValidated,
      confidenceScore: (result.quality && result.quality.confidence)
        ? result.quality.confidence.score : null
    };
    var cards = ['totalSupportReplacement', 'projectionReplacement', 'activeProjectionTurnover']
      .map(function (k) { return compositionCard(comps[k], ctx); }).join('');

    return box(
      label('Impulse accounting') +
      '<div style="margin-bottom:9px;padding:8px 11px;border-left:3px solid var(--warn,#f5a623);' +
      'background:rgba(245,166,35,.08);border-radius:6px;font-size:11.5px;line-height:1.55">' +
      '<strong>' + esc(IMPULSE_PANEL_NOTICE) + '</strong></div>' +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-bottom:9px;line-height:1.5">' +
      'Three accounting views of the same stance phases. They differ because they count different ' +
      'things, not because one is more accurate.' +
      (im.unit ? ' Impulses in ' + esc(im.unit) + '.' : '') +
      ' Stances analysed: ' + (im.combined.stancesAnalyzed || 0) +
      (im.combined.stancesRejected ? ' (' + im.combined.stancesRejected + ' rejected)' : '') + '.</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px">' +
      cards + '</div>' +
      steadyStateRow(im.steadyStateConsistency) +
      momentumPreservationRow(im.momentumPreservation) +
      impactPartitionRow(im.impact) +
      whyRatiosDiffer(),
      'margin-top:12px'
    );
  }

  /**
   * The landing phase is partitioned, not removed. Saying so where the impulse
   * numbers are shown is the only way a reader can tell that "no impact metric"
   * means "not resolvable here", rather than "impact was subtracted out".
   */
  function impactPartitionRow(impact) {
    if (!impact) return '';
    return box(
      label('Vertical impact · partitioned, not removed') +
      '<div style="font-size:11.5px;line-height:1.55">The landing phase is kept in every integral ' +
      'above. No generic impact component is subtracted.</div>' +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:5px;line-height:1.55">' +
      'Impact peak and loading rate are separate <strong>vertical</strong> measures and are not ' +
      'reported: they need a force source sampled at ' + esc(String(impact.minimumSampleRateHz || 200)) +
      ' Hz or better, which neither 30–60 fps video nor a doubly-differentiated centre-of-mass ' +
      'trajectory provides. Vertical impact is not the same quantity as horizontal braking impulse, ' +
      'and one is never substituted for the other.</div>' +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:6px;' +
      'font-family:var(--mono,monospace)">impact: ' + esc(impact.availability || 'unavailable') +
      ' (' + esc(impact.reason || '') + ')</div>',
      'margin-top:10px'
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
      (opts.hideImpulseAccounting ? '' : momentumProxySection(result)) +
      (opts.hideImpulseAccounting ? '' : impulseAccountingSection(result)) +
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
      // Both blocks are already the aggregate shape their panels read, so they
      // need no reshaping. A document saved before impulse accounting existed
      // carries neither: the migration supplies an explicitly-unavailable impulse
      // block, and the proxy section simply does not render.
      impulseMetrics: stored.impulseMetrics ||
        (KFO.unavailableImpulseBlock ? KFO.unavailableImpulseBlock('analysis_predates_impulse_accounting')
                                     : null),
      momentumPreservationProxies: stored.momentumPreservationProxies || null,
      symmetry: stored.symmetry || { available: false, reason: 'not_persisted' },
      consistency: { left: {}, right: {} },
      coupledPattern: stored.coupledPattern || {},
      referenceComparison: { left: null, right: null, disclaimer: ECONOMY_DISCLAIMER },
      forceMetrics: { availability: KFO.AVAILABILITY.UNAVAILABLE, reason: 'geometry_proxy_has_no_force_magnitude' },
      restoredFromSavedSession: true
    };
  }

  function buildStoredHtml(stored, opts) {
    opts = opts || {};
    var result = fromStoredForm(stored);
    if (!result) return unavailableHtml({ reason: 'unavailable' });
    return buildHtml(result, {
      hideImpulseAccounting: !!opts.hideImpulseAccounting,
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
  function mount(result, hostId, opts) {
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
    host.innerHTML = buildHtml(result, opts || {});
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
    PROXY_UNAVAILABLE_NOTE: PROXY_UNAVAILABLE_NOTE,
    IMPULSE_PANEL_NOTICE: IMPULSE_PANEL_NOTICE,
    WHY_RATIOS_DIFFER: WHY_RATIOS_DIFFER,
    OVERLAY: OVERLAY,
    verticalForceSection: verticalForceSection,
    momentumProxySection: momentumProxySection,
    impulseAccountingSection: impulseAccountingSection,
    compositionCard: compositionCard,
    buildHtml: buildHtml,
    buildStoredHtml: buildStoredHtml,
    fromStoredForm: fromStoredForm,
    unavailableHtml: unavailableHtml,
    drawOverlay: drawOverlay,
    mount: mount,
    orientationWord: orientationWord
  };
});
