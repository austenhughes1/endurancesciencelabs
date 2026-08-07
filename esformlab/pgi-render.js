// ─────────────────────────────────────────────────────────────────────────────
//  PGI — user-facing rendering
//
//  `buildHtml(result)` is a PURE function returning a string, so the copy-audit
//  tests can assert on exact wording without a DOM. `mount()` handles insertion.
//
//  It accepts BOTH shapes: a live analysis result and a stored (aggregate-only)
//  one — they are deliberately the same shape, with the stored form carrying
//  fewer fields and its trajectories as parallel arrays.
//
//  COPY RULES ENFORCED BY TESTS
//  ----------------------------
//  - The technical disclaimer is always present.
//  - No text claims a measured ground-reaction force. Every occurrence of
//    "measure"/"measured" in a force context must be inside a denial.
//  - No single efficiency score, anywhere.
//  - Vertical oscillation is never labelled good, bad, high-is-worse, or
//    excessive on its own — only as part of a stated combination.
//  - No elite-target matching and no "ideal"/"optimal" angle language.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./kfo-core.js') : root.KFO;
  var pgi = isNode ? require('./pgi-core.js') : root.PGI;
  var api = factory(core, pgi);
  if (isNode) module.exports = api;
  if (root) root.PGIRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KFO, PGI) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var TITLE = 'Projection &amp; Ground Interaction';
  var SUBTITLE = 'How the runner prepares for contact, loads the ground, projects vertically, ' +
    'and converts that projection into stride.';

  // ── Small building blocks ──────────────────────────────────────────────────

  function panel(inner, extra) {
    return '<div style="margin-top:14px;padding:14px;border:1px solid var(--border2,#2a3550);' +
      'border-radius:10px;background:var(--panel2,#121724);' + (extra || '') + '">' + inner + '</div>';
  }
  function label(text) {
    return '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;' +
      'color:var(--muted2,#8aa0c0);margin-bottom:8px">' + text + '</div>';
  }
  function stat(title, value, sub) {
    return '<div style="flex:1 1 130px;min-width:120px;padding:9px 11px;border-radius:8px;' +
      'border:1px solid var(--border2,#2a3550)">' +
      '<div style="font-size:10px;color:var(--muted2,#8aa0c0);text-transform:uppercase;' +
      'letter-spacing:.5px;margin-bottom:3px">' + esc(title) + '</div>' +
      '<div style="font-size:17px;font-weight:700;line-height:1.2">' + value + '</div>' +
      (sub ? '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:3px;line-height:1.4">' +
        esc(sub) + '</div>' : '') + '</div>';
  }
  function row(inner) {
    return '<div style="display:flex;flex-wrap:wrap;gap:8px">' + inner + '</div>';
  }
  function note(text) {
    return '<div style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.6;margin-top:9px">' +
      esc(text) + '</div>';
  }
  function unavailable(text) {
    return '<div style="font-size:11.5px;color:var(--muted2,#8aa0c0);line-height:1.6;padding:8px 0">' +
      esc(text) + '</div>';
  }

  function med(a, dp, suffix) {
    if (!a || !isNum(a.median)) return '—';
    return a.median.toFixed(dp == null ? 2 : dp) + (suffix || '');
  }
  function spread(a, dp) {
    if (!a || !isNum(a.sd) || !isNum(a.n) || a.n < 2) return null;
    return '± ' + a.sd.toFixed(dp == null ? 2 : dp) + ' SD over ' + a.n;
  }
  function num(v, dp, suffix) {
    return isNum(v) ? v.toFixed(dp == null ? 2 : dp) + (suffix || '') : '—';
  }

  // ── Domain summary ─────────────────────────────────────────────────────────

  var DOMAIN_LABEL = {
    touchdownPreparation: 'Touchdown preparation',
    brakingIndicators: 'Braking indicators',
    verticalProjection: 'Vertical projection',
    reboundTiming: 'Rebound timing',
    strideOutcome: 'Stride outcome',
    dataConfidence: 'Data confidence'
  };
  var RATING_TEXT = {
    good: 'Good', moderate: 'Moderate', needs_review: 'Needs review',
    low: 'Low', elevated: 'Elevated', strong: 'Strong', rapid: 'Rapid', slow: 'Slow',
    appropriate: 'Appropriate', short_for_speed: 'Short for speed',
    long_for_speed: 'Long for speed', high: 'High', unknown: 'Not established'
  };

  function domainSection(result) {
    var d = result.domains;
    if (!d) return '';
    var order = ['touchdownPreparation', 'brakingIndicators', 'verticalProjection',
                 'reboundTiming', 'strideOutcome', 'dataConfidence'];
    var chips = order.map(function (k) {
      var v = d[k];
      if (!v) return '';
      var text = RATING_TEXT[v.rating] || v.rating;
      return stat(DOMAIN_LABEL[k], esc(text), v.rating === 'unknown' && v.reason
        ? String(v.reason).replace(/_/g, ' ') : null);
    }).join('');
    return panel(
      label('Mechanical domains') + row(chips) +
      note('These domains are reported separately on purpose. There is no combined efficiency ' +
           'score, because no combination of these measurements has been validated against ' +
           'running economy.'));
  }

  // ── Trajectory helpers ─────────────────────────────────────────────────────

  /** Accepts the live points array or the stored parallel-array form. */
  function pathPoints(p) {
    if (!p) return null;
    if (p.points && p.points.length) return p.points;
    if (p.t && p.t.length) {
      return p.t.map(function (t, i) {
        return {
          tMsFromTouchdown: t,
          worldForward: p.w ? p.w[i] : null,
          height: p.h ? p.h[i] : null,
          comRelativeForward: p.c ? p.c[i] : null
        };
      });
    }
    if (p.pct && p.pct.length) {
      return p.pct.map(function (pc, i) { return { pct: pc, h: p.h ? p.h[i] : null }; });
    }
    return null;
  }

  function svgFrame(w, h, inner) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h +
      '" style="max-width:100%;overflow:visible" role="img">' + inner + '</svg>';
  }

  /**
   * Foot path from ~150 ms before contact to ~100 ms after, in COM-relative
   * coordinates. Time is encoded by dot opacity so it is visible whether the
   * foot is still travelling forward at touchdown or already retracting.
   */
  function footTrajectorySvg(side) {
    var pts = pathPoints(side.meanPath);
    if (!pts || !pts.length) return '';
    var usable = pts.filter(function (p) {
      return isNum(p.comRelativeForward) && isNum(p.height);
    });
    if (usable.length < 4) return '';

    var W = 420, H = 170, padL = 34, padR = 12, padT = 12, padB = 26;
    var xs = usable.map(function (p) { return p.comRelativeForward; });
    var ys = usable.map(function (p) { return p.height; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var xr = (x1 - x0) || 0.1, yr = (y1 - y0) || 0.1;
    x0 -= xr * 0.12; x1 += xr * 0.12; y0 -= yr * 0.15; y1 += yr * 0.15;
    function sx(v) { return padL + (v - x0) / (x1 - x0) * (W - padL - padR); }
    function sy(v) { return H - padB - (v - y0) / (y1 - y0) * (H - padT - padB); }

    var parts = [];
    // Zero line = the COM's horizontal position.
    var zeroX = sx(0);
    if (zeroX > padL && zeroX < W - padR) {
      parts.push('<line x1="' + zeroX.toFixed(1) + '" y1="' + padT + '" x2="' + zeroX.toFixed(1) +
        '" y2="' + (H - padB) + '" stroke="var(--muted2,#8aa0c0)" stroke-width="1" ' +
        'stroke-dasharray="3 3" opacity=".55"/>');
      parts.push('<text x="' + (zeroX + 3).toFixed(1) + '" y="' + (padT + 9) +
        '" font-size="9" fill="var(--muted2,#8aa0c0)">under COM</text>');
    }
    // Ground line at the touchdown height.
    var gy = sy(0);
    parts.push('<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) +
      '" y2="' + gy.toFixed(1) + '" stroke="var(--muted2,#8aa0c0)" stroke-width="1" opacity=".35"/>');

    var poly = usable.map(function (p) { return sx(p.comRelativeForward).toFixed(1) + ',' + sy(p.height).toFixed(1); }).join(' ');
    parts.push('<polyline points="' + poly + '" fill="none" stroke="var(--accent,#4da3ff)" ' +
      'stroke-width="1.6" opacity=".55"/>');

    usable.forEach(function (p, i) {
      var op = 0.25 + 0.75 * (i / Math.max(1, usable.length - 1));
      var isTouchdown = Math.abs(p.tMsFromTouchdown) < 12;
      parts.push('<circle cx="' + sx(p.comRelativeForward).toFixed(1) + '" cy="' + sy(p.height).toFixed(1) +
        '" r="' + (isTouchdown ? 4.5 : 2.6) + '" fill="' +
        (isTouchdown ? 'var(--warn,#ffb020)' : 'var(--accent,#4da3ff)') + '" opacity="' + op.toFixed(2) + '"/>');
    });
    // Max anterior excursion = rightmost COM-relative point before touchdown.
    var pre = usable.filter(function (p) { return p.tMsFromTouchdown <= 0; });
    if (pre.length) {
      var maxA = pre.reduce(function (a, b) { return b.comRelativeForward > a.comRelativeForward ? b : a; });
      parts.push('<circle cx="' + sx(maxA.comRelativeForward).toFixed(1) + '" cy="' + sy(maxA.height).toFixed(1) +
        '" r="4" fill="none" stroke="var(--good,#3ddc97)" stroke-width="1.6"/>');
      parts.push('<text x="' + (sx(maxA.comRelativeForward) + 6).toFixed(1) + '" y="' +
        (sy(maxA.height) - 6).toFixed(1) + '" font-size="9" fill="var(--good,#3ddc97)">max reach</text>');
    }
    parts.push('<text x="' + padL + '" y="' + (H - 6) + '" font-size="9" fill="var(--muted2,#8aa0c0)">' +
      'behind COM &#8592; foot position (leg lengths) &#8594; ahead of COM</text>');
    parts.push('<text x="4" y="' + (padT + 6) + '" font-size="9" fill="var(--muted2,#8aa0c0)">height</text>');

    return '<div style="margin-top:10px">' + svgFrame(W, H, parts.join('')) +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);line-height:1.5;margin-top:2px">' +
      'Foot path relative to the centre of mass, 150 ms before to 100 ms after contact. ' +
      'Dots darken with time; the amber dot is touchdown. Ankle-anchored.</div></div>';
  }

  /**
   * COM vertical path across one normalised step. The stance events are marked
   * (TD, MIN COM, TO) and the two stance phases the minimum-COM landmark
   * separates are shaded: touchdown → minimum COM as loading/compression,
   * minimum COM → toe-off as rebound/projection.
   */
  function comTrajectorySvg(com, ctx) {
    ctx = ctx || {};
    var pts = pathPoints(com.meanPath);
    if (!pts || !pts.length) return '';
    var usable = pts.filter(function (p) { return isNum(p.h) || isNum(p.height); })
                    .map(function (p) { return { pct: p.pct, h: isNum(p.h) ? p.h : p.height }; })
                    .filter(function (p) { return isNum(p.pct) && isNum(p.h); });
    if (usable.length < 4) return '';

    var W = 420, H = 170, padL = 34, padR = 12, padT = 14, padB = 34;
    var ys = usable.map(function (p) { return p.h; });
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var yr = (y1 - y0) || 0.05;
    y0 -= yr * 0.2; y1 += yr * 0.2;
    function sx(pc) { return padL + (pc / 100) * (W - padL - padR); }
    function sy(v) { return H - padB - (v - y0) / (y1 - y0) * (H - padT - padB); }

    var parts = [];

    // Phase shading: the x-axis is % of STEP, so stance ends at dutyFactor and
    // the minimum sits at minComStancePercent × dutyFactor.
    var df = isNum(ctx.dutyFactor) ? ctx.dutyFactor : null;
    var minStancePct = isNum(ctx.minComStancePercent) ? ctx.minComStancePercent : null;
    var toPct = isNum(df) ? df * 100 : null;
    var minPct = (isNum(df) && isNum(minStancePct)) ? minStancePct * df : null;
    if (isNum(minPct) && isNum(toPct) && minPct > 0 && toPct > minPct) {
      parts.push('<rect x="' + sx(0).toFixed(1) + '" y="' + padT + '" width="' +
        (sx(minPct) - sx(0)).toFixed(1) + '" height="' + (H - padT - padB) +
        '" fill="var(--warn,#ffb020)" opacity=".08"/>');
      parts.push('<rect x="' + sx(minPct).toFixed(1) + '" y="' + padT + '" width="' +
        (sx(toPct) - sx(minPct)).toFixed(1) + '" height="' + (H - padT - padB) +
        '" fill="var(--good,#3ddc97)" opacity=".08"/>');
      parts.push('<text x="' + ((sx(0) + sx(minPct)) / 2).toFixed(1) + '" y="' + (H - padB + 10) +
        '" font-size="8" text-anchor="middle" fill="var(--muted2,#8aa0c0)">loading / compression</text>');
      parts.push('<text x="' + ((sx(minPct) + sx(toPct)) / 2).toFixed(1) + '" y="' + (H - padB + 10) +
        '" font-size="8" text-anchor="middle" fill="var(--muted2,#8aa0c0)">rebound / projection</text>');
    }

    var poly = usable.map(function (p) { return sx(p.pct).toFixed(1) + ',' + sy(p.h).toFixed(1); }).join(' ');
    parts.push('<polyline points="' + poly + '" fill="none" stroke="var(--accent,#4da3ff)" stroke-width="2"/>');

    function hAtPct(pc) {
      var best = usable[0];
      usable.forEach(function (p) { if (Math.abs(p.pct - pc) < Math.abs(best.pct - pc)) best = p; });
      return best.h;
    }
    // Event markers: TD, MIN COM, TO.
    parts.push('<line x1="' + sx(0).toFixed(1) + '" y1="' + padT + '" x2="' + sx(0).toFixed(1) +
      '" y2="' + (H - padB) + '" stroke="var(--muted2,#8aa0c0)" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>');
    parts.push('<text x="' + (sx(0) + 2).toFixed(1) + '" y="' + (padT + 8) +
      '" font-size="9" fill="var(--muted2,#8aa0c0)">TD</text>');
    if (isNum(toPct)) {
      parts.push('<line x1="' + sx(toPct).toFixed(1) + '" y1="' + padT + '" x2="' + sx(toPct).toFixed(1) +
        '" y2="' + (H - padB) + '" stroke="var(--muted2,#8aa0c0)" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>');
      parts.push('<text x="' + (sx(toPct) + 2).toFixed(1) + '" y="' + (padT + 8) +
        '" font-size="9" fill="var(--muted2,#8aa0c0)">TO</text>');
    }
    // Minimum-COM marker: at the landmark's timing when known, else at the
    // lowest point of the drawn path.
    var minP = usable.reduce(function (a, b) { return b.h < a.h ? b : a; });
    var mx = isNum(minPct) ? minPct : minP.pct;
    var my = isNum(minPct) ? hAtPct(minPct) : minP.h;
    parts.push('<circle cx="' + sx(mx).toFixed(1) + '" cy="' + sy(my).toFixed(1) +
      '" r="4.5" fill="var(--warn,#ffb020)"/>');
    parts.push('<text x="' + (sx(mx) + 6).toFixed(1) + '" y="' + (sy(my) + 12).toFixed(1) +
      '" font-size="9" font-weight="700" fill="var(--warn,#ffb020)">MIN COM</text>');
    // Apex marker.
    var maxP = usable.reduce(function (a, b) { return b.h > a.h ? b : a; });
    parts.push('<circle cx="' + sx(maxP.pct).toFixed(1) + '" cy="' + sy(maxP.h).toFixed(1) +
      '" r="4" fill="var(--good,#3ddc97)"/>');
    parts.push('<text x="' + (sx(maxP.pct) + 6).toFixed(1) + '" y="' + (sy(maxP.h) - 6).toFixed(1) +
      '" font-size="9" fill="var(--muted2,#8aa0c0)">flight apex</text>');
    parts.push('<text x="' + padL + '" y="' + (H - 6) + '" font-size="9" fill="var(--muted2,#8aa0c0)">' +
      'touchdown &#8594; stance &#8594; toe-off &#8594; flight (% of step)</text>');
    parts.push('<text x="4" y="' + (padT + 4) + '" font-size="9" fill="var(--muted2,#8aa0c0)">height</text>');

    return '<div style="margin-top:10px">' + svgFrame(W, H, parts.join('')) +
      '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);line-height:1.5;margin-top:2px">' +
      'Centre-of-mass height across one step, in leg lengths. Shaded: loading/compression ' +
      '(touchdown &#8594; minimum COM) and rebound/projection (minimum COM &#8594; toe-off).</div></div>';
  }

  /** Pull the SVG context (duty factor + min-COM stance %) from any result shape. */
  function comSvgContext(result) {
    var st = result.strideTiming;
    var t = st && st.overall ? st.overall : null;
    var mc = result.minimumCom;
    return {
      dutyFactor: t && t.dutyFactor && isNum(t.dutyFactor.median) ? t.dutyFactor.median : null,
      minComStancePercent: (mc && mc.availability === KFO.AVAILABILITY.AVAILABLE && mc.overall &&
                            mc.overall.stancePercent && isNum(mc.overall.stancePercent.median))
        ? mc.overall.stancePercent.median : null
    };
  }

  // ── Sections ───────────────────────────────────────────────────────────────

  /**
   * The stride timeline the whole report is organised around. Minimum COM is
   * emphasised as the transition landmark between loading and rebound — and the
   * caption keeps it honest about what it is not.
   */
  function timelineSection(result) {
    var steps = [
      { label: 'Touchdown preparation', phase: true },
      { label: 'TOUCHDOWN', event: true },
      { label: 'Loading / Compression', phase: true },
      { label: 'MINIMUM COM', event: true, emph: true },
      { label: 'Rebound / Projection', phase: true },
      { label: 'TOE-OFF', event: true },
      { label: 'Flight / Stride outcome', phase: true }
    ];
    var chips = steps.map(function (s) {
      var style = s.emph
        ? 'border:1.5px solid var(--warn,#ffb020);color:var(--warn,#ffb020);font-weight:800'
        : s.event
          ? 'border:1px solid var(--border2,#2a3550);font-weight:700'
          : 'border:1px solid var(--border2,#2a3550);color:var(--muted2,#8aa0c0)';
      return '<span style="font-size:10px;letter-spacing:.4px;padding:4px 9px;border-radius:99px;' +
        'white-space:nowrap;' + style + '">' + esc(s.label) + '</span>';
    }).join('<span style="color:var(--muted2,#8aa0c0);font-size:11px">&#8594;</span>');
    return panel(
      label('Stride timeline') +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">' + chips + '</div>' +
      note('Minimum COM is the reversal point of vertical COM motion — vertical COM velocity is ' +
           'approximately zero there. It is not the point where force production begins: upward ' +
           'force is already being produced before it to slow the descending COM, and the fore-aft ' +
           'braking-to-propulsion force reversal is a separate event this analysis does not observe.'));
  }

  function jointChangeText(j) {
    if (!j || j.availability === 'unavailable' || !j.changeDegrees ||
        !isNum(j.changeDegrees.median)) return '—';
    var v = j.changeDegrees.median;
    return (v > 0 ? '+' : '') + v.toFixed(1) + '&deg;';
  }

  function loadingSection(result) {
    var lc = result.loadingCompression;
    if (!lc || lc.availability !== KFO.AVAILABILITY.AVAILABLE || !lc.overall || !lc.overall.n) {
      return panel(label('B · Loading / Compression') +
        unavailable('Loading/compression phase is unavailable' +
          (lc && lc.reason ? ' (' + String(lc.reason).replace(/_/g, ' ') + ').' : '.')));
    }
    var o = lc.overall;
    var jc = o.jointChanges || {};
    var body = row(
      stat('Duration', med(o.durationMs, 0, ' ms'), 'touchdown &#8594; minimum COM') +
      stat('Share of contact', o.fractionOfStance && isNum(o.fractionOfStance.median)
             ? Math.round(o.fractionOfStance.median * 100) + '%' : '—', 'of ground contact time') +
      stat('Compression depth', lenText(o.compression), 'COM drop under load') +
      stat('Horizontal COM travel', lenText(o.horizontalTravel), 'during loading')
    );
    body += '<div style="margin-top:12px">' +
      '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Body-angle changes, touchdown &#8594; minimum COM</div>' +
      row(
        stat('Hip', jointChangeText(jc.hip), 'positive = extending') +
        stat('Knee', jointChangeText(jc.knee), 'positive = extending') +
        stat('Trunk', jointChangeText(jc.trunk), 'positive = more forward lean') +
        stat('Shank', jointChangeText(jc.shank), 'positive = rotating forward')
      ) + '</div>';
    return panel(label('B · Loading / Compression') + body +
      note('How the runner receives and compresses into the ground. More compression is not ' +
           'automatically worse — deep and shallow strategies both appear in effective running, ' +
           'so this phase is described, not scored.'));
  }

  function reboundProjectionSection(result) {
    var rp = result.reboundProjection;
    if (!rp || rp.availability !== KFO.AVAILABILITY.AVAILABLE || !rp.overall || !rp.overall.n) {
      return panel(label('C · Rebound / Projection') +
        unavailable('Rebound/projection phase is unavailable' +
          (rp && rp.reason ? ' (' + String(rp.reason).replace(/_/g, ' ') + ').' : '.')));
    }
    var o = rp.overall;
    var mc = result.minimumCom;
    var mcOverall = (mc && mc.availability === KFO.AVAILABILITY.AVAILABLE) ? mc.overall : null;
    var chain = rp.outcomeChain || {};
    var jc = o.jointChanges || {};
    var vto = o.verticalVelocityAtToeoff || {};

    var warn = '';
    if (mc && mc.reliability && mc.reliability.unreliable) {
      warn = '<div style="margin-top:8px;padding:8px 11px;border-radius:8px;border-left:3px solid ' +
        'var(--warn,#ffb020);background:rgba(255,176,32,.10);font-size:11px;line-height:1.6">' +
        'The minimum-COM point could not be reliably located on most steps, so these phase figures ' +
        'are low-confidence and no strong rebound interpretation is offered.</div>';
    }

    var body = row(
      stat('Minimum COM', mcOverall && mcOverall.stancePercent && isNum(mcOverall.stancePercent.median)
             ? Math.round(mcOverall.stancePercent.median) + '% of stance' : '—',
           'lowest COM point; vertical COM reversal') +
      stat('Rebound duration', med(o.durationMs, 0, ' ms'), 'minimum COM &#8594; toe-off') +
      stat('COM rise', lenText(o.comRise), 'from minimum COM to toe-off') +
      stat('Mean rebound velocity', velText(o.meanComRiseVelocity),
           'mean COM rise velocity — motion, not force') +
      stat('Vertical velocity at toe-off',
           vto.ballisticFromFlightMps && isNum(vto.ballisticFromFlightMps.median)
             ? vto.ballisticFromFlightMps.median.toFixed(2) + ' m/s' : '—',
           'from flight time (ballistic)') +
      stat('Flight time', isNum(chain.flightSeconds)
             ? Math.round(chain.flightSeconds * 1000) + ' ms' : '—', 'resulting flight') +
      stat('Stride length', isNum(chain.strideLengthMeters)
             ? chain.strideLengthMeters.toFixed(2) + ' m' : '—', 'resulting stride')
    );

    body += '<div style="margin-top:12px">' +
      '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Body-angle changes, minimum COM &#8594; toe-off</div>' +
      row(
        stat('Hip', jointChangeText(jc.hip), 'positive = extending') +
        stat('Knee', jointChangeText(jc.knee), 'positive = extending') +
        stat('Trunk', jointChangeText(jc.trunk), 'positive = more forward lean') +
        stat('Shank', jointChangeText(jc.shank), 'positive = rotating forward') +
        stat('Ankle', 'not measurable', 'no foot landmark in the pose model')
      ) +
      note('Coordinated whole-body movement: no single joint is credited with creating the ' +
           'outgoing stride on its own.') + '</div>';

    // The rebound → outcome chain, as a readable sequence.
    var chainItems = [];
    function chainItem(labelText, value) {
      if (value == null) return;
      chainItems.push('<span style="font-size:10.5px;padding:4px 9px;border-radius:8px;' +
        'border:1px solid var(--border2,#2a3550);white-space:nowrap">' +
        '<span style="color:var(--muted2,#8aa0c0)">' + esc(labelText) + '</span> ' +
        '<strong>' + value + '</strong></span>');
    }
    chainItem('min COM', isNum(chain.minimumComStancePercent)
      ? Math.round(chain.minimumComStancePercent) + '% stance' : null);
    chainItem('COM rise', isNum(chain.reboundRiseCentimeters)
      ? '+' + chain.reboundRiseCentimeters.toFixed(1) + ' cm'
      : (isNum(chain.reboundRiseLegLengths) ? '+' + chain.reboundRiseLegLengths.toFixed(3) + ' LL' : null));
    chainItem('over', isNum(chain.reboundDurationMs) ? Math.round(chain.reboundDurationMs) + ' ms' : null);
    chainItem('take-off v&#8593;', isNum(chain.verticalVelocityAtToeoffMps)
      ? chain.verticalVelocityAtToeoffMps.toFixed(2) + ' m/s' : null);
    chainItem('flight', isNum(chain.flightSeconds) ? Math.round(chain.flightSeconds * 1000) + ' ms' : null);
    chainItem('aerial rise', isNum(chain.aerialRiseBallisticMeters)
      ? (chain.aerialRiseBallisticMeters * 100).toFixed(1) + ' cm' : null);
    chainItem('stride', isNum(chain.strideLengthMeters) ? chain.strideLengthMeters.toFixed(2) + ' m' : null);
    if (chainItems.length >= 3) {
      body += '<div style="margin-top:12px">' +
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px">From minimum COM to stride</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center">' +
        chainItems.join('<span style="color:var(--muted2,#8aa0c0);font-size:11px">&#8594;</span>') +
        '</div>' +
        note('A temporal sequence, not a full causal chain: mechanics link these quantities in ' +
             'order, but no step is claimed to be fully determined by the one before it.') + '</div>';
    }

    // Movement summary (descriptive).
    var ms = rp.movementSummary;
    if (ms && (ms.availability === 'available' || ms.text)) {
      body += '<div style="margin-top:12px;padding:10px 12px;border-radius:8px;' +
        'border:1px solid var(--border2,#2a3550);font-size:12px;line-height:1.65">' +
        esc(ms.text) +
        (ms.patternNote ? '<div style="font-size:11px;color:var(--muted2,#8aa0c0);margin-top:6px">' +
          esc(ms.patternNote) + '</div>' : '') + '</div>';
    }

    // Toe-off velocity cross-check: two estimates, never averaged.
    var agree = vto.agreement;
    if (vto.poseDerived && isNum(vto.poseDerived.medianMps) && agree && isNum(agree.medianRelativeError)) {
      body += note('Cross-check: pose-derived toe-off velocity ' + vto.poseDerived.medianMps.toFixed(2) +
        ' m/s vs flight-derived ' + (vto.ballisticFromFlightMps && isNum(vto.ballisticFromFlightMps.median)
          ? vto.ballisticFromFlightMps.median.toFixed(2) : '—') + ' m/s (median disagreement ' +
        Math.round(agree.medianRelativeError * 100) + '%). The flight-derived value leads this ' +
        'summary; the two estimates are never averaged together.' +
        (agree.isIndependent === false ? ' The calibration itself came from flight time, so this ' +
          'check is not independent.' : ''));
    }

    return panel(label('C · Rebound / Projection') + warn + body +
      note('These describe how the body is organised from the lowest COM point through toe-off. ' +
           'They are motion measurements, not forces, and not a measure of tendon elasticity. ' +
           'Minimum COM is the vertical COM reversal point, not the start of force production.'));
  }

  function velText(v) {
    if (!v) return '—';
    if (isNum(v.medianMps)) return v.medianMps.toFixed(2) + ' m/s';
    return isNum(v.medianLegLengthsPerS) ? v.medianLegLengthsPerS.toFixed(2) + ' LL/s' : '—';
  }

  function touchdownSection(result) {
    var td = result.touchdownPreparation;
    if (!td || td.availability !== KFO.AVAILABILITY.AVAILABLE) {
      return panel(label('A · Touchdown preparation') +
        unavailable('Touchdown preparation is unavailable' +
          (td && td.reason ? ' (' + String(td.reason).replace(/_/g, ' ') + ').' : '.')));
    }
    var body = '';
    ['left', 'right'].forEach(function (sideKey) {
      var s = td[sideKey];
      if (!s) return;
      var title = sideKey === 'left' ? 'Left' : 'Right';
      if (s.availability !== KFO.AVAILABILITY.AVAILABLE) {
        body += '<div style="margin-top:10px"><strong>' + title + '</strong> — ' +
          esc(String(s.reason || 'unavailable').replace(/_/g, ' ')) + '</div>';
        return;
      }
      var a = s.aggregate;
      var vel = a.footGroundVelocityMps && isNum(a.footGroundVelocityMps.median)
        ? med(a.footGroundVelocityMps, 2, ' m/s')
        : (td.velocityWindow && !td.velocityWindow.available
            ? 'unavailable' : med(a.horizontalFootVelocityMps, 2, ' m/s'));
      var velSub = a.footGroundVelocityMps && isNum(a.footGroundVelocityMps.median)
        ? 'relative to the ground'
        : (td.velocityWindow && !td.velocityWindow.available
            ? 'frame rate insufficient' : 'relative to the camera');
      body += '<div style="margin-top:12px">' +
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px">' + title +
        ' &mdash; ' + esc(s.contactsUsed) + ' contacts</div>' +
        row(
          stat('Foot ahead of COM', med(a.footComOffsetAtTouchdownLegLengths, 3, ' LL'),
               spread(a.footComOffsetAtTouchdownLegLengths, 3) || 'leg lengths, at touchdown') +
          stat('Retraction period', med(a.retractionTimeMs, 0, ' ms'),
               'from furthest reach to contact') +
          stat('Retraction distance', med(a.retractionDistanceComLegLengths, 3, ' LL'),
               'relative to the body') +
          stat('Clear retraction', isNum(a.clearRetractionFraction)
                 ? Math.round(a.clearRetractionFraction * 100) + '%' : '—',
               'of contacts') +
          stat('Foot velocity at contact', vel, velSub) +
          stat('Approach angle', med(a.approachAngleDegrees, 0, '&deg;'),
               '0&deg; forward, 90&deg; straight down')
        ) + footTrajectorySvg(s) + '</div>';
    });
    if (td.asymmetry && td.asymmetry.available && td.asymmetry.patternsDiffer) {
      body += note('The two sides were described by different touchdown patterns. Some asymmetry is ' +
        'normal; a large difference is first a prompt to check event detection.');
    }
    var repNote = 'The ankle is used as the foot position: the pose model provides no heel or toe ' +
      'landmark, so for a heel-first contact this understates how far ahead the foot lands.';
    return panel(label('A · Touchdown preparation') + body + note(repNote));
  }

  function projectionSection(result) {
    var vp = result.verticalProjection, st = result.strideTiming, com = result.comTrajectory;
    if (!vp || vp.availability !== KFO.AVAILABILITY.AVAILABLE) {
      return panel(label('D · Flight &amp; projection') + unavailable('Projection metrics are unavailable.'));
    }
    var t = st && st.overall ? st.overall : null;
    var p = vp.overall;
    var vs = vp.verticalSupport;

    var supportValue = (vs && vs.availability === KFO.AVAILABILITY.AVAILABLE)
      ? med(vs.meanVerticalSupportBW, 2, ' BW') : 'withheld';
    var supportSub = (vs && vs.availability === KFO.AVAILABILITY.AVAILABLE)
      ? 'estimated from timing, not measured'
      : 'steady-speed assumption not met';

    var body = row(
      stat('Ground contact time', t ? med(t.contactSeconds, 3, ' s') : '—', spread(t && t.contactSeconds, 3)) +
      stat('Flight time', t ? med(t.flightSeconds, 3, ' s') : '—', spread(t && t.flightSeconds, 3)) +
      stat('Duty factor', t ? med(t.dutyFactor, 3) : '—', 'contact &divide; step time') +
      stat('Mean vertical support', supportValue, supportSub) +
      stat('Vertical take-off velocity', med(p && p.verticalTakeoffVelocityMps, 2, ' m/s'), 'from flight time') +
      stat('Effective vertical impulse', med(p && p.effectiveVerticalImpulsePerMassNsPerKg, 2, ' N&middot;s/kg'),
           'per unit body mass')
    );

    // Vertical oscillation, always decomposed.
    var dec = com && com.decomposition ? com.decomposition.overall : null;
    if (dec) {
      body += '<div style="margin-top:14px">' +
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Vertical excursion, broken down</div>' +
        row(
          stat('Stance compression', lenText(dec.stanceCompression), 'COM drop under load') +
          stat('Stance rebound', lenText(dec.stanceRebound), 'recovered before toe-off') +
          stat('Aerial rise', lenText(dec.aerialRiseMeasured), 'rise during flight') +
          stat('Total oscillation', lenText(dec.verticalOscillation), 'all three combined')
        ) +
        note('The same total excursion can come from a deep stance collapse or from genuine aerial ' +
             'time. Those are different mechanics, so the total is never interpreted on its own — ' +
             'and a larger value is not treated as a fault.') +
        comTrajectorySvg(com, comSvgContext(result)) + '</div>';
    }
    if (vs && vs.caveats && vs.caveats.length) {
      body += '<ul style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.6;margin:9px 0 0 16px;padding:0">' +
        vs.caveats.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>';
    }
    return panel(label('D · Flight &amp; projection') + body);
  }

  function lenText(v) {
    if (!v) return '—';
    if (isNum(v.medianCentimeters)) {
      return v.medianCentimeters.toFixed(1) + ' cm' +
        (isNum(v.medianLegLengths) ? ' <span style="font-size:11px;font-weight:500;color:var(--muted2,#8aa0c0)">(' +
          v.medianLegLengths.toFixed(3) + ' LL)</span>' : '');
    }
    return isNum(v.medianLegLengths) ? v.medianLegLengths.toFixed(3) + ' LL' : '—';
  }

  function groundInteractionSection(result) {
    var sg = result.supportGeometry;
    if (!sg || sg.availability !== KFO.AVAILABILITY.AVAILABLE) {
      return panel(label('F · Ground interaction') + unavailable('Support geometry is unavailable.'));
    }
    var rows = '';
    [['early_stance', 'Early stance', 'braking-oriented support geometry'],
     ['central_stance', 'Central stance', 'vertical support alignment'],
     ['late_stance', 'Late stance', 'propulsive-oriented support geometry']].forEach(function (spec) {
      var l = sg.left && sg.left.phases ? sg.left.phases[spec[0]] : null;
      var r = sg.right && sg.right.phases ? sg.right.phases[spec[0]] : null;
      function cell(p) {
        if (!p || !p.angle || !isNum(p.angle.median)) return '—';
        return KFO.formatAngle(p.angle.median, p.uncertaintyDegrees);
      }
      rows += '<tr>' +
        '<td style="padding:5px 8px 5px 0;font-size:11.5px">' + esc(spec[1]) +
        '<div style="font-size:10px;color:var(--muted2,#8aa0c0)">' + esc(spec[2]) + '</div></td>' +
        '<td style="padding:5px 8px;font-size:12px;font-variant-numeric:tabular-nums">' + cell(l) + '</td>' +
        '<td style="padding:5px 8px;font-size:12px;font-variant-numeric:tabular-nums">' + cell(r) + '</td>' +
        '</tr>';
    });
    var table = '<table style="border-collapse:collapse;width:100%;max-width:420px">' +
      '<tr><th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0);padding-bottom:4px"></th>' +
      '<th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0);padding-bottom:4px">LEFT</th>' +
      '<th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0);padding-bottom:4px">RIGHT</th></tr>' +
      rows + '</table>';

    var patterns = '';
    var td = result.touchdownPreparation;
    if (td) {
      ['left', 'right'].forEach(function (k) {
        var s = td[k];
        if (!s || !s.brakingPattern || !s.brakingPattern.pattern) return;
        patterns += '<div style="margin-top:6px;font-size:11.5px">' +
          '<strong>' + (k === 'left' ? 'Left' : 'Right') + ':</strong> ' +
          esc(String(s.brakingPattern.pattern).replace(/_/g, ' ')) + '</div>';
      });
    }

    return panel(label('F · Ground interaction') + table +
      (patterns ? '<div style="margin-top:12px"><div style="font-size:12px;font-weight:700">' +
        'Touchdown pattern</div>' + patterns + '</div>' : '') +
      note('These angles describe body geometry at three points in stance. They are not a measured ' +
           'force direction, they are not scored, and they are not compared against a target value. ' +
           'Negative means the support point is ahead of the centre of mass.'));
  }

  /**
   * COM velocity-reversal detail. The loading/rebound story now leads in the
   * dedicated phase cards; this keeps the whole-stance velocity quantities.
   */
  function reboundVelocitySection(result) {
    var rb = result.rebound;
    if (!rb || rb.availability !== KFO.AVAILABILITY.AVAILABLE) return '';
    var body = row(
      stat('COM velocity at touchdown', velText(rb.comVelocityAtTouchdown), 'negative is downward') +
      stat('COM velocity at toe-off', velText(rb.comVelocityAtToeoff), 'positive is upward') +
      stat('Velocity reversal rate', rb.reversalRateLegLengthsPerS2 &&
             isNum(rb.reversalRateLegLengthsPerS2.median)
               ? rb.reversalRateLegLengthsPerS2.median.toFixed(1) + ' LL/s&sup2;' : '—',
           'how fast downward motion turns around')
    );
    var cc = rb.flightCrossCheck;
    if (cc && cc.availability === KFO.AVAILABILITY.AVAILABLE) {
      body += note('Consistency check: pose-derived take-off velocity predicts a flight time within ' +
        (isNum(cc.medianRelativeError) ? Math.round(cc.medianRelativeError * 100) + '%' : 'an unknown margin') +
        ' of the observed flight time' +
        (cc.isIndependent ? '.' : ', though the scale calibration came from flight time itself, so ' +
          'this check is not independent.'));
    }
    return panel(label('COM velocity through stance') + body +
      note('These describe how quickly downward motion is redirected upward. They are motion ' +
           'measurements, not forces, and not a measure of tendon elasticity.'));
  }

  function outcomeSection(result) {
    var so = result.strideOutcome, st = result.strideTiming;
    var t = st && st.overall ? st.overall : null;
    var body = row(
      stat('Cadence', t ? med(t.cadenceSpm, 0, ' spm') : '—', 'steps per minute') +
      stat('Step length', so && so.stepLengthMeters ? med(so.stepLengthMeters, 2, ' m') : '—',
           so && so.method === 'speed_times_step_time' ? 'from speed and step time' : null) +
      stat('Stride length', so && so.strideLengthMeters ? med(so.strideLengthMeters, 2, ' m') : '—', null) +
      stat('Flight distance', so && so.flightDistanceMeters ? med(so.flightDistanceMeters, 2, ' m') : '—',
           'distance covered airborne') +
      stat('Speed', so && isNum(so.speedMps) ? so.speedMps.toFixed(2) + ' m/s' : 'unknown',
           so && so.speedSource ? String(so.speedSource).replace(/_/g, ' ') : null)
    );
    var interp = so && so.interpretation;
    if (interp) {
      body += note(interp.speedKnown
        ? 'Stride length is reported with the speed it was produced at. It is not labelled short or ' +
          'long: no speed-matched reference distribution is loaded, and a longer stride is not ' +
          'automatically better. Comparing the same runner at the same speed is the meaningful use.'
        : 'Running speed is unavailable, so stride length cannot be called short or long — the same ' +
          'stride length means different things at different speeds.');
    }
    return panel(label('E · Stride outcome') + body);
  }

  function patternsSection(result) {
    var ps = result.patterns || [];
    if (!ps.length) {
      return panel(label('What the combination suggests') +
        unavailable('No pattern reached the evidence needed to be reported.'));
    }
    var cards = ps.map(function (p) {
      var obs = (p.observations || []).map(function (o) {
        return '<li style="margin-bottom:2px">' + esc(o) + '</li>';
      }).join('');
      var alts = (p.alternatives || []).map(function (a) { return esc(a); }).join(' &middot; ');
      var confPct = isNum(p.confidence) ? Math.round(p.confidence * 100) : null;
      return '<div style="margin-top:10px;padding:11px;border-radius:8px;' +
        'border:1px solid var(--border2,#2a3550)">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">' +
        '<div style="font-size:12.5px;font-weight:700">' +
        esc(String(p.pattern).replace(/_/g, ' ')) + '</div>' +
        (confPct != null ? '<div style="font-size:10px;color:var(--muted2,#8aa0c0)">confidence ' +
          confPct + '%</div>' : '') + '</div>' +
        '<div style="font-size:11.5px;line-height:1.6;margin-top:5px">' + esc(p.interpretation) + '</div>' +
        (obs ? '<ul style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.55;' +
          'margin:7px 0 0 16px;padding:0">' + obs + '</ul>' : '') +
        (alts ? '<div style="font-size:10.5px;color:var(--muted2,#8aa0c0);margin-top:7px;line-height:1.5">' +
          '<strong>Could also be:</strong> ' + alts + '</div>' : '') +
        '</div>';
    }).join('');
    return panel(label('What the combination suggests') + cards);
  }

  function qualitySection(result) {
    var q = result.quality;
    if (!q) return '';
    var flags = (q.flags || []).map(function (f) {
      return '<li style="margin-bottom:2px">' + esc(PGI.flagLabel(f)) + '</li>';
    }).join('');
    var lim = (result.limitations || []).map(function (l) {
      return '<li style="margin-bottom:2px">' + esc(l) + '</li>';
    }).join('');
    return panel(
      label('Data quality and limits') +
      '<div style="font-size:11.5px;line-height:1.6">Confidence: <strong>' +
      esc(q.confidenceBand || 'unknown') + '</strong>' +
      (isNum(q.stepsAnalyzed) ? ' &middot; ' + q.stepsAnalyzed + ' steps analysed' : '') + '</div>' +
      (flags ? '<div style="font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;' +
        'color:var(--muted2,#8aa0c0);margin-top:9px">Conditions affecting this analysis</div>' +
        '<ul style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.55;margin:5px 0 0 16px;padding:0">' +
        flags + '</ul>' : '') +
      (lim ? '<div style="font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;' +
        'color:var(--muted2,#8aa0c0);margin-top:10px">Limitations</div>' +
        '<ul style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.55;margin:5px 0 0 16px;padding:0">' +
        lim + '</ul>' : ''));
  }

  function header(result) {
    var legacyBadge = result.isLegacyView
      ? '<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:rgba(255,176,32,.14);' +
        'color:var(--warn,#ffb020);margin-left:8px">legacy session</span>' : '';
    return '<div style="margin-top:22px">' +
      '<div style="font-size:15px;font-weight:800;letter-spacing:.2px">' + TITLE + legacyBadge + '</div>' +
      '<div style="font-size:11.5px;color:var(--muted2,#8aa0c0);line-height:1.6;margin-top:4px;' +
      'max-width:620px">' + esc(SUBTITLE) + '</div>' +
      '<div style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.6;margin-top:7px;' +
      'padding:7px 10px;border-left:3px solid var(--border2,#2a3550);background:rgba(125,150,190,.06);' +
      'border-radius:0 6px 6px 0;max-width:620px">' + esc(PGI.DISCLAIMER) + '</div></div>';
  }

  // ── Entry points ───────────────────────────────────────────────────────────

  function buildHtml(result, opts) {
    opts = opts || {};
    if (!result) return '';
    if (result.availability === KFO.AVAILABILITY.UNAVAILABLE) {
      return header(result) + panel(unavailable(
        'This analysis could not be produced' +
        (result.reason ? ': ' + String(result.reason).replace(/_/g, ' ') : '') + '.' +
        (result.note ? ' ' + result.note : '')));
    }
    return header(result) +
      timelineSection(result) +
      domainSection(result) +
      touchdownSection(result) +
      loadingSection(result) +
      reboundProjectionSection(result) +
      projectionSection(result) +
      outcomeSection(result) +
      groundInteractionSection(result) +
      reboundVelocitySection(result) +
      patternsSection(result) +
      (opts.hideQuality ? '' : qualitySection(result));
  }

  // ── Comparison view ────────────────────────────────────────────────────────

  var GROUP_LABEL = {
    touchdownPreparation: 'Touchdown preparation',
    loadingCompression: 'Loading / compression',
    reboundProjection: 'Rebound / projection',
    projection: 'Projection',
    outcome: 'Outcome',
    groundInteraction: 'Ground interaction'
  };

  function comparisonHtml(cmp) {
    if (!cmp) return '';
    if (cmp.availability !== KFO.AVAILABILITY.AVAILABLE) {
      return panel(label('Condition comparison') + unavailable(
        'Comparison unavailable' + (cmp.reason ? ': ' + String(cmp.reason).replace(/_/g, ' ') : '') + '.' +
        (cmp.note ? ' ' + cmp.note : '')));
    }
    var head = '<div style="font-size:15px;font-weight:800;margin-top:22px">Condition comparison</div>' +
      '<div style="font-size:11.5px;color:var(--muted2,#8aa0c0);margin-top:4px">' +
      esc(cmp.labels.a) + ' &rarr; ' + esc(cmp.labels.b) + '</div>';

    // The speed warning is deliberately prominent and never collapsed.
    var speedWarn = '';
    if (cmp.speed && cmp.speed.warning) {
      var isHard = cmp.speed.severity === 'warning';
      speedWarn = '<div style="margin-top:10px;padding:10px 12px;border-radius:8px;border-left:3px solid ' +
        (isHard ? 'var(--warn,#ffb020)' : 'var(--border2,#2a3550)') + ';background:' +
        (isHard ? 'rgba(255,176,32,.10)' : 'rgba(125,150,190,.06)') + ';font-size:11.5px;line-height:1.6">' +
        '<strong>' + (isHard ? 'Speeds differed' : 'Speed unknown') + '.</strong> ' +
        esc(cmp.speed.warning) +
        (isNum(cmp.speed.speedA) && isNum(cmp.speed.speedB)
          ? ' (' + cmp.speed.speedA.toFixed(2) + ' m/s vs ' + cmp.speed.speedB.toFixed(2) + ' m/s)' : '') +
        '</div>';
    }

    var groups = Object.keys(GROUP_LABEL).map(function (g) {
      var rows = (cmp.groups[g] || []).filter(function (dd) { return dd.available; }).map(function (dd) {
        var dp = isNum(dd.decimals) ? dd.decimals : 2;
        var arrow = dd.absolute > 0 ? '&uarr;' : dd.absolute < 0 ? '&darr;' : '&rarr;';
        var strong = dd.exceedsVariability === true;
        return '<tr>' +
          '<td style="padding:4px 8px 4px 0;font-size:11.5px">' + esc(dd.label) + '</td>' +
          '<td style="padding:4px 8px;font-size:11.5px;font-variant-numeric:tabular-nums">' +
            dd.conditionA.toFixed(dp) + '</td>' +
          '<td style="padding:4px 8px;font-size:11.5px;font-variant-numeric:tabular-nums">' +
            dd.conditionB.toFixed(dp) + '</td>' +
          '<td style="padding:4px 8px;font-size:11.5px;font-variant-numeric:tabular-nums;' +
            (strong ? 'font-weight:700' : 'opacity:.7') + '">' + arrow + ' ' +
            (dd.absolute > 0 ? '+' : '') + dd.absolute.toFixed(dp) +
            (isNum(dd.percent) ? ' <span style="font-size:10px;opacity:.75">(' +
              (dd.percent > 0 ? '+' : '') + dd.percent.toFixed(1) + '%)</span>' : '') + '</td>' +
          '</tr>';
      }).join('');
      if (!rows) return '';
      return '<div style="margin-top:12px">' +
        '<div style="font-size:12px;font-weight:700;margin-bottom:4px">' + GROUP_LABEL[g] + '</div>' +
        '<table style="border-collapse:collapse;width:100%">' +
        '<tr><th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0)"></th>' +
        '<th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0)">' + esc(cmp.labels.a) + '</th>' +
        '<th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0)">' + esc(cmp.labels.b) + '</th>' +
        '<th style="text-align:left;font-size:10px;color:var(--muted2,#8aa0c0)">CHANGE</th></tr>' +
        rows + '</table></div>';
    }).join('');

    var patterns = (cmp.patterns || []).map(function (p) {
      var obs = (p.observations || []).map(function (o) {
        return '<li style="margin-bottom:2px">' + esc(o) + '</li>'; }).join('');
      return '<div style="margin-top:10px;padding:11px;border-radius:8px;border:1px solid var(--border2,#2a3550)">' +
        '<div style="font-size:12.5px;font-weight:700">' + esc(String(p.pattern).replace(/_/g, ' ')) + '</div>' +
        '<div style="font-size:11.5px;line-height:1.6;margin-top:5px">' + esc(p.interpretation) + '</div>' +
        (obs ? '<ul style="font-size:11px;color:var(--muted2,#8aa0c0);line-height:1.55;margin:7px 0 0 16px;' +
          'padding:0">' + obs + '</ul>' : '') + '</div>';
    }).join('');

    return head + speedWarn +
      panel(label('What changed') + groups +
        note('Bold changes exceed the stride-to-stride variability in both conditions. Neither ' +
             'condition is ranked as better; the comparison describes how they differ.')) +
      (patterns ? panel(label('What the changes suggest together') + patterns) : '');
  }

  // ── Mounting ───────────────────────────────────────────────────────────────

  function ensureHost(id, anchorId) {
    if (typeof document === 'undefined') return null;
    var host = document.getElementById(id);
    if (host) return host;
    host = document.createElement('div');
    host.id = id;
    var anchor = anchorId ? document.getElementById(anchorId) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
    else {
      var section = document.getElementById('report-details') || document.getElementById('report-section');
      if (!section) return null;
      section.appendChild(host);
    }
    return host;
  }

  function mount(result, hostId, opts) {
    var host = ensureHost(hostId || 'pgi-report');
    if (!host) return null;
    host.innerHTML = buildHtml(result, opts);
    return host;
  }

  function mountComparison(cmp, hostId) {
    var host = ensureHost(hostId || 'pgi-comparison', 'pgi-report');
    if (!host) return null;
    host.innerHTML = comparisonHtml(cmp);
    return host;
  }

  function unavailableHtml(result, extra) {
    return header(result || {}) + panel(unavailable(
      (result && result.reason ? String(result.reason).replace(/_/g, ' ') + '. ' : '') + (extra || '')));
  }

  return {
    TITLE: TITLE,
    SUBTITLE: SUBTITLE,
    buildHtml: buildHtml,
    comparisonHtml: comparisonHtml,
    unavailableHtml: unavailableHtml,
    pathPoints: pathPoints,
    mount: mount,
    mountComparison: mountComparison
  };
});
