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
  if (total === 0) {
    tone = 'clear';
    icon = '&#10003;';
    headline = 'Clean run &mdash; but there&rsquo;s more behind that result';
    sub = '<em>&ldquo;No issues flagged&rdquo;</em> is the headline, not the full story. Unlock the report to see <strong>exactly where each of your angles sits on the bell curve vs. elite runners</strong> &mdash; being <em>in range</em> doesn&rsquo;t mean <em>optimal</em>, and runners closest to the edge of a band are where small tweaks pay off most. Your pass is also <strong>90 days of unlimited analyses</strong> &mdash; film a 5K-effort or fatigued-legs clip and compare. Clean form at easy pace often hides issues at race effort.';
  } else {
    var noun = total === 1 ? 'anomaly' : 'anomalies';
    if (notable > 0) {
      tone = 'alert';
      icon = '&#9888;';
      headline = '<em>' + total + '</em> ' + noun + ' detected in your form';
      sub = 'Unlock the full report to see <strong>exactly what they are</strong>, why each one matters for performance and injury risk, and the <strong>specific coaching cues and drills</strong> to fix each one.';
    } else {
      tone = 'warn';
      icon = '&#9888;';
      headline = '<em>' + total + '</em> ' + noun + ' detected in your form';
      sub = 'Mild but worth addressing. Unlock the full report for the <strong>coaching cues, drills, and personalized PDF</strong> showing exactly what to work on before they get worse.';
    }
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
    if(detected && severity && rd.summary[severity]) {
      summaryText = rd.summary[severity];
    } else if(!detected) {
      summaryText = rd.clear;
    }

    var severityIndicator = '';
    if(detected && severity === 'notable') {
      severityIndicator = '<span class="issue-severity notable">Notable</span>';
    } else if(detected && severity === 'mild') {
      severityIndicator = '<span class="issue-severity mild">Mild</span>';
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
    }

    // -- Summary card (grid) --
    cardsHtml += '<div class="'+cardClass+'">';
    cardsHtml += '<div class="issue-card-hdr">';
    cardsHtml += '<div class="issue-card-title">'+rd.title+'</div>';
    cardsHtml += severityIndicator;
    cardsHtml += sideTag;
    cardsHtml += '</div>';
    cardsHtml += '<div class="issue-card-summary">'+summaryText+'</div>';
    if(detected) {
      cardsHtml += '<div class="issue-card-detail-link" onclick="scrollToDetail(\'detail-'+idx+'\')">View full breakdown &#8595;</div>';
    }
    cardsHtml += '</div>';

    // -- Detail breakdown (below grid, only for detected) --
    if(detected) {
      var detailClass = 'issue-detail' + (severity === 'notable' ? ' notable' : severity === 'mild' ? ' mild' : '');
      detailsHtml += '<div class="'+detailClass+'" id="detail-'+idx+'">';
      detailsHtml += '<div class="issue-detail-hdr" onclick="toggleDetail(\'detail-body-'+idx+'\',this)">';
      detailsHtml += '<div class="issue-detail-title">'+rd.title+'</div>';
      detailsHtml += severityIndicator;
      detailsHtml += sideTag;
      detailsHtml += '<span class="issue-detail-toggle">&#9660; Expand</span>';
      detailsHtml += '</div>';
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
  if(detectedCount === 0) {
    cardsHtml = '<div style="grid-column:1/-1;background:var(--panel);border:1px solid rgba(0,229,200,.2);border-radius:16px;padding:28px 26px;margin-bottom:4px">' +
      '<div style="font-size:18px;font-weight:800;margin-bottom:10px;color:var(--text)">No major gait-pattern flags detected</div>' +
      '<div style="font-size:14px;color:var(--muted2);line-height:1.85;margin-bottom:14px">Your stride did not show meaningful signs of overstriding, hip drop, excessive arm crossover, overly upright torso position, overly open arm angle, or knee valgus in the analyzed clips. Most measured angles fell within the reference ranges used by this tool.</div>' +
      '<div style="font-size:13px;color:var(--muted);line-height:1.8">This does not mean your running form is &quot;perfect&quot; or that no improvement is possible. It means this analysis did not detect clear issues in these specific categories from the selected videos and frames. Small differences can still exist, and results can vary with speed, fatigue, camera angle, treadmill vs. overground running, and frame selection.</div>' +
    '</div>' + cardsHtml;
  }

  grid.innerHTML = cardsHtml;
  if(details) details.innerHTML = detectedCount > 0 ? '<div style="font-size:16px;font-weight:800;margin-bottom:12px">Detailed breakdowns</div>' + detailsHtml : '';
}

function scrollToDetail(id) {
  var el = document.getElementById(id);
  if(!el) return;
  el.scrollIntoView({behavior:'smooth', block:'start'});
  // Auto-expand it
  var body = el.querySelector('.issue-detail-body');
  var toggle = el.querySelector('.issue-detail-toggle');
  if(body && !body.classList.contains('open')) {
    body.classList.add('open');
    if(toggle) toggle.innerHTML = '&#9650; Collapse';
  }
}

function toggleDetail(bodyId, hdr) {
  var body = document.getElementById(bodyId);
  if(!body) return;
  var isOpen = body.classList.toggle('open');
  var toggle = hdr.querySelector('.issue-detail-toggle');
  if(toggle) toggle.innerHTML = isOpen ? '&#9650; Collapse' : '&#9660; Expand';
}

function buildSummaryTable(){
  var tbl = document.getElementById('summary-table');
  if (!tbl) return;
  tbl.querySelector('thead').innerHTML = '<tr><th>Metric</th>' + SUMMARY_COL_ORDER.map(function(k) {
    var ph = phases[k]; var idx = PHASE_DEFS.findIndex(function(d) { return d.key === k; });
    var side = ph && ph.side === 'left' ? ' th-left' : ph && ph.side === 'right' ? ' th-right' : '';
    return '<th class="' + side + '" onclick="openExpand(\'' + k + '\')">' + (idx + 1) + '. ' + (ph ? ph.label : k) + (ph && !ph.detected ? ' &#9888;' : '') + '</th>';
  }).join('') + '</tr>';
  var activeRows = METRIC_ROWS.filter(function(r) { return SUMMARY_COL_ORDER.some(function(pk) { return isRelevant(pk, r.key); }); });
  tbl.querySelector('tbody').innerHTML = activeRows.map(function(r) {
    return '<tr><td class="row-label">' + r.label + '</td>' + SUMMARY_COL_ORDER.map(function(k) {
      return '<td id="sc-' + k + '-' + r.key + '"><span class="sv na">--</span></td>';
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
    if(!isRelevant(key,r.key)){cell.innerHTML='<span class="sv na" title="Not applicable for this phase">--</span>';return;}
    var v=m[r.key],d=v!=null?r.fmt(v):'--';var pos=v!=null?positionLabel(v,r.key,key):'';var sym=v!=null?positionSymbol(v,r.key,key):'';
    cell.innerHTML=v!=null?'<span class="sv">'+sym+' '+d+'<span class="sv-pos">'+pos+'</span></span>':'<span class="sv na">--</span>';
  });
}
