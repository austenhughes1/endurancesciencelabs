// ─────────────────────────────────────────────────────────────────────────
//  FORCE-VECTOR ADMIN REPORT  (admin-only, invisible to regular users)
//
//  Renders an extra report section AFTER the standard analysis completes,
//  reusing the per-phase keypoints the normal flow already captured
//  (global `phases`). Gated by isAdmin(); does nothing for anyone else.
//
//  Entry point: renderForceVectorReport() — called from completeAnalysis()
//  guarded by isAdmin(). Depends on ForceVector (force-vector.js).
// ─────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Side-view phases only — force direction is a sagittal-plane quantity.
  var FV_PHASES = [
    { key: 'l_foot', side: 'left'  },
    { key: 'r_foot', side: 'right' },
    { key: 'mid',    side: null    },
    { key: 'l_toe',  side: 'left'  },
    { key: 'r_toe',  side: 'right' }
  ];

  function fmtDeg(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '°'; }

  function thetaColor(theta) {
    if (theta < -4) return 'var(--bad, #ff5d5d)';
    if (theta > 4)  return 'var(--good, #2bd4a6)';
    return 'var(--cyan, #8b7cf8)';
  }
  function scoreColor(s) {
    if (s >= 75) return 'var(--good, #2bd4a6)';
    if (s >= 45) return 'var(--gold, #f5c451)';
    return 'var(--bad, #ff5d5d)';
  }

  function rowHtml(r) {
    var fb = (typeof ForceVector !== 'undefined' && ForceVector.PHASE_FALLBACK[r.phaseKey]) || {};
    var label = fb.label || r.phaseKey;
    if (!r.ok) {
      return '<tr><td>' + label + '</td><td colspan="5" style="color:var(--muted2)">' +
        (r.reason || 'not analyzed') + '</td></tr>';
    }
    var t = r.target || {};
    var src = t.source === 'live'
      ? '<span style="color:var(--good,#2bd4a6)">elite n=' + t.n + '</span>'
      : '<span style="color:var(--muted2)">default</span>';
    var div = (r.comDivergence == null) ? '—' : r.comDivergence.toFixed(1) + '°';
    return '<tr>' +
      '<td style="font-weight:700">' + label + '</td>' +
      '<td style="color:' + thetaColor(r.theta) + ';font-weight:700">' + fmtDeg(r.theta) + '</td>' +
      '<td>' + fmtDeg(t.ideal || 0) + ' ±' + (t.sigma || 0).toFixed(0) + '°<br>' +
        '<span style="font-size:10px">' + src + '</span></td>' +
      '<td><span style="display:inline-block;min-width:34px;text-align:center;font-weight:700;color:' +
        scoreColor(r.score) + '">' + r.score + '</span></td>' +
      '<td>' + div + '</td>' +
      '<td style="font-size:11px">' + r.classification + '</td>' +
      '</tr>';
  }

  function renderForceVectorReport() {
    if (typeof isAdmin === 'function' && !isAdmin()) return;
    if (typeof ForceVector === 'undefined' || typeof phases === 'undefined') return;

    var rows = FV_PHASES.map(function (p) {
      var ph = phases[p.key];
      if (!ph || !ph.kps || !ph.metrics) {
        return { ok: false, phaseKey: p.key, reason: 'not analyzed in this session' };
      }
      return ForceVector.estimate(ph.kps, { phaseKey: p.key, side: p.side, comMethod: 'segmental' });
    });

    var analyzed = rows.filter(function (r) { return r.ok; });
    var avg = analyzed.length
      ? Math.round(analyzed.reduce(function (s, r) { return s + r.score; }, 0) / analyzed.length)
      : null;

    var html = '' +
      '<div style="margin-top:26px;padding:18px;border:1px solid var(--border2,#2a3550);border-radius:12px;background:var(--panel2,#121724)">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">' +
      '<div style="font-weight:800;letter-spacing:.3px">Force-Vector Analysis ' +
      '<span style="font-size:11px;color:var(--gold,#f5c451);border:1px solid var(--gold,#f5c451);border-radius:20px;padding:2px 9px;margin-left:6px">ADMIN · PROTOTYPE</span></div>' +
      (avg != null ? '<div style="font-size:13px;color:var(--muted)">Mean alignment <b style="color:' +
        scoreColor(avg) + ';font-size:18px">' + avg + '</b>/100</div>' : '') +
      '</div>' +
      '<div style="font-size:11px;color:var(--muted2);margin:6px 0 12px">' +
      'Estimated GRF <b>direction</b> per stance phase (no magnitude). ' +
      'θ from vertical: <span style="color:var(--good,#2bd4a6)">+ propulsive</span> · ' +
      '<span style="color:var(--bad,#ff5d5d)">− braking</span> · 0 vertical. ' +
      'Elite targets derive from live foot-offset reference data; "default" = hand-set fallback.</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<thead><tr style="text-align:left;color:var(--muted2);border-bottom:1px solid var(--border,#243044)">' +
      '<th style="padding:6px 4px">Phase</th><th>θ measured</th><th>Elite target</th>' +
      '<th>Score</th><th>COM↔leg</th><th>Reading</th></tr></thead><tbody>' +
      rows.map(rowHtml).join('') +
      '</tbody></table>' +
      '<div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.5">' +
      'COM↔leg = divergence between the COM-based force line and the stance-leg axis ' +
      '(large = body not stacked over the leg). Targets use vertical leg‑to‑torso ratio R=' +
      (ForceVector.LEG_TORSO_RATIO) + '. Internal calibration tool — not shown to users.</div>' +
      '</div>';

    var host = document.getElementById('fv-admin-report');
    if (!host) {
      host = document.createElement('div');
      host.id = 'fv-admin-report';
      var details = document.getElementById('report-details');
      var section = document.getElementById('report-section');
      if (details && details.parentNode) details.parentNode.insertBefore(host, details.nextSibling);
      else if (section) section.appendChild(host);
      else return;
    }
    host.innerHTML = html;
  }

  window.renderForceVectorReport = renderForceVectorReport;
})();
