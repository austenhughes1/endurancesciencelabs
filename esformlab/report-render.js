// ════════════════════════════════════════════════════════════════
// On-screen report rendering for esFormLab.
//
// Extracted from the main esformlab/index.html inline <script> so
// the page is easier to navigate. Pure relocation -- function
// bodies are byte-identical to the originals and the globals they
// reference (REPORT_DATA, phases, lastIssues, PHASE_DEFS,
// METRIC_ROWS, METRIC_BIO, SUMMARY_COL_ORDER, getRange,
// getRangeStats, isRelevant, positionLabel, positionSymbol)
// remain defined in the main inline script. Both scripts share the
// same global scope; this file is loaded after the inline block so
// callers see these functions hoisted.
// ════════════════════════════════════════════════════════════════

function buildBellCurveSVG(val, metricKey, phaseKey, fmtFn) {
  if (val===undefined||val===null||!isFinite(val)) return '';
  var stats = getRangeStats(phaseKey||'mid', metricKey||'trunk');
  var mean = stats.mean, sd = stats.sd;
  var rng = getRange(phaseKey||'mid', metricKey||'trunk');
  var green = rng.green;
  var W=220, H=72, PAD_L=10, PAD_R=10, CURVE_H=40, BASE_Y=54;
  var xMin=mean-3.5*sd, xRange=7*sd;
  var toX=function(v){return PAD_L+(v-xMin)/xRange*(W-PAD_L-PAD_R);};
  var pts=[];
  for(var i=0;i<=60;i++){
    var x=xMin+(xRange*i/60);
    var z=(x-mean)/sd;
    var y=Math.exp(-0.5*z*z);
    pts.push({px:toX(x), py:BASE_Y-y*CURVE_H});
  }
  var curvePath='M'+pts.map(function(p){return p.px.toFixed(1)+','+p.py.toFixed(1);}).join('L');
  var bL=Math.max(toX(green[0]),PAD_L), bR=Math.min(toX(green[1]),W-PAD_R);
  var bandPts=[];
  for(var i2=0;i2<=30;i2++){
    var x2=green[0]+(green[1]-green[0])*i2/30;
    var z2=(x2-mean)/sd;
    var y2=Math.exp(-0.5*z2*z2);
    bandPts.push({px:toX(x2), py:BASE_Y-y2*CURVE_H});
  }
  var bandPath='M'+bandPts[0].px.toFixed(1)+','+BASE_Y+' L'+bandPts.map(function(p){return p.px.toFixed(1)+','+p.py.toFixed(1);}).join('L')+' L'+bandPts[bandPts.length-1].px.toFixed(1)+','+BASE_Y+' Z';
  var vx=Math.max(PAD_L,Math.min(W-PAD_R,toX(val)));
  var fmtVal=fmtFn?fmtFn(val):val.toFixed(1);
  var mx=toX(mean);
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="display:block">'+
    '<path d="'+curvePath+' L'+pts[pts.length-1].px.toFixed(1)+','+BASE_Y+' L'+pts[0].px.toFixed(1)+','+BASE_Y+' Z" fill="rgba(100,120,160,.08)" stroke="none"/>'+
    '<path d="'+bandPath+'" fill="rgba(100,120,160,.18)" stroke="none"/>'+
    '<path d="'+curvePath+'" fill="none" stroke="rgba(100,120,160,.35)" stroke-width="1.5"/>'+
    '<line x1="'+vx.toFixed(1)+'" y1="'+(BASE_Y-CURVE_H-4)+'" x2="'+vx.toFixed(1)+'" y2="'+BASE_Y+'" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="3,2"/>'+
    '<text x="'+vx.toFixed(1)+'" y="'+(BASE_Y-CURVE_H-8)+'" class="bell-label bell-label-you" text-anchor="middle" font-size="9">'+fmtVal+'</text>'+
    '<text x="'+mx.toFixed(1)+'" y="'+(BASE_Y+11)+'" class="bell-label" text-anchor="middle" font-size="8">Elite avg</text>'+
    '<line x1="'+mx.toFixed(1)+'" y1="'+(BASE_Y-2)+'" x2="'+mx.toFixed(1)+'" y2="'+(BASE_Y+3)+'" stroke="var(--muted)" stroke-width="1"/>'+
  '</svg>';
}

// -- Coverage (display only; mirrors which inputs each check reads in detectIssues) --
function eflNum(v) { return v !== null && v !== undefined && isFinite(v); }
function eflPhaseUsable(def) {
  var ph = phases[def.key];
  if (!ph || ph.noPose) return false;
  if (def.videoKey === 'side') return !!ph.metrics && ph.sideView !== false;
  return !!(ph.frontBackMetrics || ph.metrics);
}
function eflUnusablePhaseCount() {
  return PHASE_DEFS.filter(function(d) { return !eflPhaseUsable(d); }).length;
}
// True when detectIssues had at least one input for the check.
function eflCheckMeasured(key) {
  function m(pk) { return phases[pk] && phases[pk].metrics ? phases[pk].metrics : null; }
  function fb(pk) { return phases[pk] && phases[pk].frontBackMetrics ? phases[pk].frontBackMetrics : null; }
  if (key === 'overstriding') {
    return ['l_foot', 'r_foot'].some(function(pk, i) {
      var mm = m(pk); if (!mm) return false;
      if (mm.leadFoot !== undefined) return eflNum(mm.leadFoot);
      return eflNum(i === 0 ? mm.lFoot : mm.rFoot);
    });
  }
  if (key === 'torsoPosition') return ['l_foot','r_foot','l_toe','r_toe','mid'].some(function(pk) { var mm = m(pk); return !!mm && mm.trunk !== undefined; });
  if (key === 'armAngle') return ['l_toe','r_toe'].some(function(pk) { var mm = m(pk); return !!mm && (eflNum(mm.nearElbow) || eflNum(mm.lElbow) || eflNum(mm.rElbow)); });
  if (key === 'hipDrop') return ['mid_front_l','mid_front_r','mid_back_l','mid_back_r'].some(function(pk) { var f = fb(pk); return !!f && eflNum(f.hipDropDeg); });
  if (key === 'armsCrossing') return !!(fb('mid_front_l') || fb('mid_front_r'));
  if (key === 'kneeValgus') {
    var fl = fb('mid_front_l'), fr = fb('mid_front_r');
    return !!((fl && eflNum(fl.lKneeValgusDeg)) || (fr && eflNum(fr.rKneeValgusDeg)));
  }
  return true;
}
var EFL_CHECK_INPUTS = {
  overstriding: 'the L and R foot-strike frames',
  torsoPosition: 'the side-view frames',
  armAngle: 'the L and R toe-off frames',
  hipDrop: 'the front and back mid-stance frames',
  armsCrossing: 'the front mid-stance frames',
  kneeValgus: 'the front mid-stance frames'
};

function renderAnomalyBanner(issues) {
  var banner = document.getElementById('anomaly-banner');
  if (!banner) return;
  var notable = 0, mild = 0, total = 0;
  if (issues) {
    Object.keys(issues).forEach(function(k){
      var iss = issues[k];
      if (iss && iss.detected) {
        total++;
        if (iss.severity === 'notable') notable++;
        else if (iss.severity === 'mild') mild++;
      }
    });
  }
  var tone, icon, headline, sub;
  var unusable = eflUnusablePhaseCount();
  var reviewLink = isViewingSaved ? '' : ' <a href="#phase-groups" class="ab-link" onclick="event.preventDefault();var pg=document.getElementById(\'phase-groups\');if(pg)pg.scrollIntoView({block:\'start\'})">Review the phase cards</a>';
  if (total === 0 && unusable > 0) {
    tone = 'warn';
    icon = '&#9888;';
    headline = 'Your scan is incomplete &mdash; <em>' + unusable + '</em> of ' + PHASE_DEFS.length + ' phases have no usable frame';
    sub = 'Some checks couldn&rsquo;t run, so &ldquo;no issues&rdquo; isn&rsquo;t a clean result yet. ' + (isViewingSaved ? 'Start a new analysis with clearer clips before you rely on this report.' : 'Pick a usable frame on each flagged card (or re-film that view) before you rely on this report.' + reviewLink);
  } else if (total === 0) {
    tone = 'clear';
    icon = '&#10003;';
    headline = 'Clean run &mdash; but there&rsquo;s more behind that result';
    sub = '<em>&ldquo;No issues flagged&rdquo;</em> is the headline, not the full story. Unlock the report to see <strong>exactly where each of your angles sits against elite reference ranges</strong> (with bell curves in the PDF) &mdash; being <em>in range</em> doesn&rsquo;t mean <em>optimal</em>, and runners closest to the edge of a band are where small tweaks pay off most. Your pass is also <strong>90 days of unlimited analyses</strong> &mdash; film a 5K-effort or fatigued-legs clip and compare. Clean form at easy pace often hides issues at race effort.';
  } else {
    var noun = total === 1 ? 'issue' : 'issues';
    if (notable > 0) {
      tone = 'alert';
      icon = '&#9888;';
      headline = '<em>' + total + '</em> ' + noun + ' detected in your form';
      sub = 'Unlock the full report to see <strong>exactly what they are</strong>, why each one matters for performance and injury risk, and the <strong>specific form cues</strong> to work on for each one.';
    } else {
      tone = 'warn';
      icon = '&#9888;';
      headline = '<em>' + total + '</em> ' + noun + ' detected in your form';
      sub = 'Mild but worth addressing. Unlock the full report for the <strong>form cues and personalized PDF</strong> showing exactly what to work on before they get worse.';
    }
    if (unusable > 0) sub += ' <span class="ab-incomplete">Note: ' + unusable + ' of ' + PHASE_DEFS.length + ' phases have no usable frame, so some checks couldn&rsquo;t run.</span>' + reviewLink;
  }
  banner.className = 'anomaly-banner ' + tone;
  banner.innerHTML =
    '<div class="ab-icon">' + icon + '</div>' +
    '<div class="ab-content">' +
      '<div class="ab-headline">' + headline + '</div>' +
      '<div class="ab-subline">' + sub + '</div>' +
    '</div>';
  banner.setAttribute('data-populated', '1');
}

function renderReport(issues) {
  var grid = document.getElementById('report-issues-grid');
  var details = document.getElementById('report-details');
  if(!grid) return;

  // Populate the locked-user incentive banner. Visibility is toggled later
  // by applyPaywallState() so this is safe to call even when unlocked.
  renderAnomalyBanner(issues);

  var issueList = [
    {key:'overstriding',  dataKey:'overstriding'},
    {key:'hipDrop',       dataKey:'hipDrop'},
    {key:'armsCrossing',  dataKey:'armsCrossing'},
    {key:'torsoPosition', dataKey:null},
    {key:'armAngle',      dataKey:'armAngle'},
    {key:'kneeValgus',    dataKey:'kneeValgus'},
  ];

  var cardsHtml = '';
  var detailsHtml = '';
  var detectedCount = 0;
  var unmeasuredCount = 0;

  issueList.forEach(function(item, idx) {
    var issue = issues[item.key];
    if(!issue) return;

    var detected = issue.detected;
    var severity = issue.severity;

    // Resolve the report data key (torso has sub-types)
    var dk = item.dataKey;
    if(item.key === 'torsoPosition' && issue.cueKey) dk = issue.cueKey;
    if(!dk) dk = 'torsoUpright';
    var rd = REPORT_DATA[dk];
    if(!rd) return;

    var summaryText = '';
    // A clear result with no input is "Not measured", never "Clear" (display only).
    var unmeasured = !detected && !eflCheckMeasured(item.key);
    if(detected && severity && rd.summary[severity]) {
      summaryText = rd.summary[severity];
    } else if(unmeasured) {
      summaryText = 'This check couldn&rsquo;t run &mdash; ' + (EFL_CHECK_INPUTS[item.key] || 'its frames') + ' had no usable measurement.';
    } else if(!detected) {
      summaryText = rd.clear;
    }

    var severityIndicator = '';
    if(detected && severity === 'notable') {
      severityIndicator = '<span class="issue-severity notable">Notable</span>';
    } else if(detected && severity === 'mild') {
      severityIndicator = '<span class="issue-severity mild">Mild</span>';
    } else if(unmeasured) {
      severityIndicator = '<span class="issue-severity unmeasured">Not measured</span>';
    } else {
      severityIndicator = '<span class="issue-severity clear">&#10003; Clear</span>';
    }

    // Side tag: only when detection has per-side severities and at least one side triggered.
    // sideTagLabel lets an issue override the noun ("side" by default; arms crossing uses "arm").
    var sideTag = '';
    if(detected && issue.sideSev) {
      var sL = issue.sideSev.L, sR = issue.sideSev.R;
      var noun = issue.sideTagLabel || 'side';
      var nounPlural = noun === 'arm' ? 'arms' : 'sides';
      if(sL && !sR)      sideTag = '<span class="issue-side-tag">Left '+noun+' only</span>';
      else if(sR && !sL) sideTag = '<span class="issue-side-tag">Right '+noun+' only</span>';
      else if(sL && sR)  sideTag = '<span class="issue-side-tag">Both '+nounPlural+'</span>';
    }

    var cardClass = 'issue-card';
    if(detected) {
      cardClass += ' detected';
      if(severity === 'notable') cardClass += ' notable';
      detectedCount++;
    } else {
      cardClass += ' not-detected';
      if(unmeasured) { cardClass += ' not-measured'; unmeasuredCount++; }
    }

    // -- Summary card (grid) --
    cardsHtml += '<div class="'+cardClass+'">';
    cardsHtml += '<div class="issue-card-hdr">';
    cardsHtml += '<h3 class="issue-card-title">'+rd.title+'</h3>';
    cardsHtml += severityIndicator;
    cardsHtml += sideTag;
    cardsHtml += '</div>';
    cardsHtml += '<div class="issue-card-summary">'+summaryText+'</div>';
    if(detected) {
      cardsHtml += '<a class="issue-card-detail-link" href="#detail-'+idx+'" onclick="event.preventDefault();scrollToDetail(\'detail-'+idx+'\')">View full breakdown &#8595;</a>';
    }
    cardsHtml += '</div>';

    // -- Detail breakdown (below grid, only for detected) --
    if(detected) {
      var detailClass = 'issue-detail' + (severity === 'notable' ? ' notable' : severity === 'mild' ? ' mild' : '');
      detailsHtml += '<div class="'+detailClass+'" id="detail-'+idx+'">';
      detailsHtml += '<h3 class="issue-detail-h"><button type="button" class="issue-detail-hdr" aria-expanded="false" aria-controls="detail-body-'+idx+'" onclick="toggleDetail(\'detail-body-'+idx+'\',this)">';
      detailsHtml += '<span class="issue-detail-title">'+rd.title+'</span>';
      detailsHtml += severityIndicator;
      detailsHtml += sideTag;
      detailsHtml += '<span class="issue-detail-toggle">&#9660; Expand</span>';
      detailsHtml += '</button></h3>';
      detailsHtml += '<div class="issue-detail-body" id="detail-body-'+idx+'">';

      // What this means
      detailsHtml += '<div class="issue-section">';
      detailsHtml += '<div class="issue-section-title">What this means</div>';
      detailsHtml += '<div class="issue-section-text">'+rd.whatThisMeans+'</div>';
      detailsHtml += '</div>';

      // Why it matters
      detailsHtml += '<div class="issue-section">';
      detailsHtml += '<div class="issue-section-title">Why it matters</div>';
      detailsHtml += '<div class="issue-section-text">'+rd.whyItMatters+'</div>';
      if(rd.whyItMattersRef) detailsHtml += '<div class="issue-ref"><a href="'+rd.whyItMattersRef+'" target="_blank" rel="noopener">View research</a></div>';
      detailsHtml += '</div>';

      // Possible reasons
      detailsHtml += '<div class="issue-section">';
      detailsHtml += '<div class="issue-section-title">Why this might be happening</div>';
      detailsHtml += '<ul class="issue-bullets">';
      rd.possibleReasons.forEach(function(r) {
        detailsHtml += '<li><strong>'+r.text+'</strong>';
        if(r.ref) detailsHtml += '<div class="issue-ref"><a href="'+r.ref+'" target="_blank" rel="noopener">Source</a></div>';
        detailsHtml += '</li>';
      });
      detailsHtml += '</ul></div>';

      // Form cues
      detailsHtml += '<div class="issue-section">';
      detailsHtml += '<div class="issue-section-title">Form cues to improve ' + rd.title.toLowerCase() + '</div>';
      detailsHtml += '<ul class="issue-bullets">';
      rd.formCues.forEach(function(c) {
        detailsHtml += '<li><strong>'+c.text+'</strong>';
        if(c.ref) detailsHtml += '<div class="issue-ref"><a href="'+c.ref+'" target="_blank" rel="noopener">Source</a></div>';
        detailsHtml += '</li>';
      });
      detailsHtml += '</ul></div>';

      // Confidence note
      if(rd.confidence) {
        detailsHtml += '<div class="issue-confidence">'+rd.confidence+'</div>';
      }

      detailsHtml += '</div>'; // end detail-body
      detailsHtml += '</div>'; // end issue-detail
    }
  });

  // No flags banner
  if(detectedCount === 0 && unmeasuredCount > 0) {
    cardsHtml = '<div class="no-flags incomplete">' +
      '<h3 class="no-flags-title">' + unmeasuredCount + ' of ' + issueList.length + ' checks couldn&rsquo;t be run</h3>' +
      '<div class="no-flags-body">The checks that did run found no clear issues, but the ones marked &ldquo;Not measured&rdquo; had no usable frame. ' + (isViewingSaved ? 'Start a new analysis with clearer clips to complete them.' : 'Pick a usable frame on those phase cards, or re-film that view, to complete them.') + '</div>' +
    '</div>' + cardsHtml;
  } else if(detectedCount === 0) {
    cardsHtml = '<div class="no-flags">' +
      '<h3 class="no-flags-title">No major gait-pattern flags detected</h3>' +
      '<div class="no-flags-body">Your stride did not show meaningful signs of overstriding, hip drop, excessive arm crossover, overly upright torso position, overly open arm angle, or knee valgus in the analyzed clips. Most measured angles fell within the reference ranges used by this tool.</div>' +
      '<div class="no-flags-foot">This does not mean your running form is &quot;perfect&quot; or that no improvement is possible. It means this analysis did not detect clear issues in these specific categories from the selected videos and frames. Small differences can still exist, and results can vary with speed, fatigue, camera angle, treadmill vs. overground running, and frame selection.</div>' +
    '</div>' + cardsHtml;
  }

  grid.innerHTML = cardsHtml;
  if(details) details.innerHTML = detectedCount > 0 ? '<h3 class="report-subhead">Detailed breakdowns</h3>' + detailsHtml : '';
  renderFrontBackTable();
}

// Front/back view measurements (live + saved sessions), from frontBackMetrics.
function renderFrontBackTable() {
  var host = document.getElementById('fb-summary');
  if (!host) return;
  var cols = ['mid_front_l', 'mid_front_r', 'mid_back_l', 'mid_back_r'];
  var any = false;
  var fbs = cols.map(function(k) { var ph = phases[k]; var f = ph && ph.frontBackMetrics ? ph.frontBackMetrics : null; if (f) any = true; return f; });
  if (!any) { host.innerHTML = ''; host.hidden = true; return; }
  var dash = '<span class="sv na" title="Not measured" aria-label="Not measured">&ndash;</span>';
  var deg = function(v) { return eflNum(v) ? '<span class="sv">' + v.toFixed(1) + '&deg;</span>' : dash; };
  var pct = function(v) { return eflNum(v) ? '<span class="sv">' + (v * 100).toFixed(1) + '%</span>' : dash; };
  var colSide = function(i) { var def = PHASE_DEFS.find(function(d) { return d.key === cols[i]; }); return def ? def.side : null; };
  var cap = function(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
  var rows = [
    ['Stance side', function(f, i) { var sd = f ? (f.stanceSide || colSide(i)) : null; return sd ? '<span class="sv">' + cap(sd) + '</span>' : dash; }],
    ['Hip drop', function(f) { return f ? deg(f.hipDropDeg) : dash; }],
    ['Stance-knee FPPA', function(f, i) { if (!f) return dash; var sd = f.stanceSide || colSide(i); return deg(sd === 'left' ? f.lKneeValgusDeg : sd === 'right' ? f.rKneeValgusDeg : null); }],
    ['L wrist crossing (% of shoulder width)', function(f, i) { return f && i < 2 ? pct(f.lWristCross) : (i >= 2 ? '<span class="sv na" title="Front view only" aria-label="Not applicable">&ndash;</span>' : dash); }],
    ['R wrist crossing (% of shoulder width)', function(f, i) { return f && i < 2 ? pct(f.rWristCross) : (i >= 2 ? '<span class="sv na" title="Front view only" aria-label="Not applicable">&ndash;</span>' : dash); }]
  ];
  var head = '<tr><th>Metric</th>' + cols.map(function(k) {
    var idx = PHASE_DEFS.findIndex(function(d) { return d.key === k; });
    var def = PHASE_DEFS[idx];
    var side = def && def.side === 'left' ? ' class="th-left"' : def && def.side === 'right' ? ' class="th-right"' : '';
    return '<th' + side + '>' + (idx + 1) + '. ' + (def ? def.label : k) + '</th>';
  }).join('') + '</tr>';
  var body = rows.map(function(r) {
    return '<tr><td class="row-label">' + r[0] + '</td>' + fbs.map(function(f, i) { return '<td>' + r[1](f, i) + '</td>'; }).join('') + '</tr>';
  }).join('');
  host.hidden = false;
  host.innerHTML = '<h3 class="report-subhead fb-title">Front/back view measurements</h3>' +
    '<div class="summary-sub">Hip drop and knee angle (FPPA) in degrees at mid-stance; wrist crossing as a share of shoulder width (front view only). Hip drop blends the front and back views in your results; knee valgus uses the front view.</div>' +
    '<div class="summary-scroll"><table class="stbl fb-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function scrollToDetail(id) {
  var el = document.getElementById(id);
  if(!el) return;
  var reduce=false;try{reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}
  el.scrollIntoView({behavior:reduce?'auto':'smooth', block:'start'});
  // Auto-expand it
  var body = el.querySelector('.issue-detail-body');
  var toggle = el.querySelector('.issue-detail-toggle');
  if(body && !body.classList.contains('open')) {
    body.classList.add('open');
    if(toggle) toggle.innerHTML = '&#9650; Collapse';
  }
  var hdrBtn = el.querySelector('.issue-detail-hdr');
  if(hdrBtn) hdrBtn.setAttribute('aria-expanded', 'true');
}

function toggleDetail(bodyId, hdr) {
  var body = document.getElementById(bodyId);
  if(!body) return;
  var isOpen = body.classList.toggle('open');
  var toggle = hdr.querySelector('.issue-detail-toggle');
  if(toggle) toggle.innerHTML = isOpen ? '&#9650; Collapse' : '&#9660; Expand';
  if(hdr && hdr.setAttribute) hdr.setAttribute('aria-expanded', String(isOpen));
}

function buildSummaryTable(){
  var tbl = document.getElementById('summary-table');
  if (!tbl) return;
  tbl.querySelector('thead').innerHTML = '<tr><th>Metric</th>' + SUMMARY_COL_ORDER.map(function(k) {
    var ph = phases[k]; var idx = PHASE_DEFS.findIndex(function(d) { return d.key === k; });
    var side = ph && ph.side === 'left' ? ' th-left' : ph && ph.side === 'right' ? ' th-right' : '';
    var lbl = (idx + 1) + '. ' + (ph ? ph.label : k) + (ph && !ph.detected ? ' &#9888;' : '');
    if (isViewingSaved) return '<th class="' + side + '">' + lbl + '</th>';
    return '<th class="' + side + '"><button type="button" class="th-btn" onclick="openExpand(\'' + k + '\')">' + lbl + '</button></th>';
  }).join('') + '</tr>';
  var activeRows = METRIC_ROWS.filter(function(r) { return SUMMARY_COL_ORDER.some(function(pk) { return isRelevant(pk, r.key); }); });
  tbl.querySelector('tbody').innerHTML = activeRows.map(function(r) {
    return '<tr><td class="row-label">' + r.label + '</td>' + SUMMARY_COL_ORDER.map(function(k) {
      return '<td id="sc-' + k + '-' + r.key + '">' + (isRelevant(k, r.key) ? '<span class="sv na pending">not analyzed</span>' : '<span class="sv na" title="Not applicable for this phase" aria-label="Not applicable">&ndash;</span>') + '</td>';
    }).join('') + '</tr>';
  }).join('');
}
function updateSummaryCol(key){
  var m = phases[key] ? phases[key].metrics : null;
  if(!m)return;
  // Only update for side-view phases in the summary
  if(SUMMARY_COL_ORDER.indexOf(key) === -1) return;
  METRIC_ROWS.forEach(function(r){
    var cell=document.getElementById('sc-'+key+'-'+r.key);if(!cell)return;
    if(!isRelevant(key,r.key)){cell.innerHTML='<span class="sv na" title="Not applicable for this phase" aria-label="Not applicable">&ndash;</span>';return;}
    var v=m[r.key],d=v!=null?r.fmt(v):'--';var pos=v!=null?positionLabel(v,r.key,key):'';var sym=v!=null?positionSymbol(v,r.key,key):'';
    cell.innerHTML=v!=null?'<span class="sv">'+sym+' '+d+'<span class="sv-pos">'+pos+'</span></span>':'<span class="sv na pending">not analyzed</span>';
  });
}
