// ════════════════════════════════════════════════════════════════
// Saved analyses + comparison UI for esFormLab.
//
// Extracted from the main esformlab/index.html inline <script>. All
// referenced globals (currentUser, savedAnalysesList, isViewingSaved,
// phases, lastIssues, selectedSex, PHASE_DEFS, METRIC_ROWS, isRelevant,
// metricSideLabel, getRange, detectIssues, renderReport, resetApp,
// signInWithGoogle, IS_MOBILE_RUNNER, the firebase compat object)
// remain defined in the main inline script. Both scripts share the
// global scope; this file is loaded after the inline block so the
// function declarations are hoisted before any user interaction.
// ════════════════════════════════════════════════════════════════

// ==============================================================
//  SAVE / LOAD / COMPARE
// ==============================================================

async function saveAnalysis() {
  if (!currentUser) { signInWithGoogle(); return; }
  var nameVal = document.getElementById('save-name').value.trim();
  var dateVal = document.getElementById('save-date').value;
  var statusEl = document.getElementById('save-status');
  if (!nameVal) { statusEl.textContent = 'Please enter a session name.'; statusEl.style.color = 'var(--warn)'; return; }
  if (!dateVal) { statusEl.textContent = 'Please select a date.'; statusEl.style.color = 'var(--warn)'; return; }

  var btn = document.getElementById('btn-save');
  btn.disabled = true; btn.textContent = 'Saving...';

  var data = {
    name: nameVal,
    date: dateVal,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    sex: selectedSex,
    phases: {},
    issues: lastIssues || detectIssues()
  };

  PHASE_DEFS.forEach(function(def) {
    var ph = phases[def.key];
    if (!ph || !ph.detected) return;
    var entry = { t: ph.t, detected: true };
    if (ph.metrics && def.videoKey === 'side') {
      entry.metrics = {};
      METRIC_ROWS.forEach(function(r) {
        if (isRelevant(def.key, r.key) && ph.metrics[r.key] !== undefined) {
          entry.metrics[r.key] = ph.metrics[r.key];
        }
      });
    }
    if (ph.frontBackMetrics) {
      entry.frontBackMetrics = ph.frontBackMetrics;
    }
    var q = ph.kps ? getDetectionQuality(ph.kps) : null;
    entry.quality = q ? q.level : null;
    data.phases[def.key] = entry;
  });

  try {
    var db = firebase.firestore();
    await db.collection('users').doc(currentUser.uid).collection('analyses').add(data);
    statusEl.textContent = 'Saved successfully!';
    statusEl.style.color = 'var(--good)';
    btn.textContent = 'Saved';
    btn.disabled = true;
    await loadAnalysesList();
    setTimeout(function() { btn.textContent = 'Save analysis'; btn.disabled = false; }, 3000);
  } catch(e) {
    statusEl.textContent = 'Save failed: ' + e.message;
    statusEl.style.color = 'var(--bad)';
    btn.textContent = 'Save analysis';
    btn.disabled = false;
  }
}

function startNewSession() {
  if (!isViewingSaved) {
    var hasAnalysis = PHASE_DEFS.some(function(d) { return phases[d.key] && phases[d.key].metrics; });
    if (hasAnalysis && !confirm('Start a new session? This will discard your current analysis if it has not been saved.')) return;
  }
  // Mobile only: hard-reload instead of in-place reset. The previous scan leaves
  // accumulated TF.js / WebGL / decoder state that dramatically slows subsequent
  // scans -- a behavior the user can already reproduce manually by NOT reloading.
  // location.reload() restores a clean slate.
  if (IS_MOBILE_RUNNER) {
    window.location.reload();
    return;
  }
  isViewingSaved = false;
  lastIssues = null;
  var saveEl = document.getElementById('save-section');
  if (saveEl) saveEl.style.display = 'none';
  var banner = document.getElementById('saved-view-banner');
  if (banner) banner.style.display = 'none';
  var reportEl = document.getElementById('report-section');
  if (reportEl) reportEl.style.display = 'none';
  var summaryEl = document.getElementById('summary-section');
  if (summaryEl) summaryEl.style.display = 'none';
  var ccaNS = document.getElementById('coaching-cta-section');
  if (ccaNS) ccaNS.style.display = 'none';
  var rfnNS = document.getElementById('report-footnotes');
  if (rfnNS) rfnNS.style.display = 'none';
  // Restore elements that viewSavedAnalysis hides
  var instrBanner = document.querySelector('#screen-phases > .instr-banner');
  if (instrBanner) instrBanner.style.display = '';
  var phaseGroupsEl = document.getElementById('phase-groups');
  if (phaseGroupsEl) phaseGroupsEl.style.display = '';
  var scanSummaryBar = document.getElementById('scan-summary-bar');
  if (scanSummaryBar) scanSummaryBar.style.display = '';
  closeMyAnalyses();
  closeCompare();
  resetApp();
}

function openMyAnalyses() {
  document.getElementById('my-analyses-overlay').classList.add('open');
  if (currentUser) loadAnalysesList();
  else document.getElementById('ma-list').innerHTML = '<div style="text-align:center;padding:40px"><div style="font-size:15px;font-weight:700;margin-bottom:6px">Save your sessions — free</div><div style="font-size:12px;color:var(--muted2);margin-bottom:14px">One-tap signup. Your videos never leave your browser.</div><button class="btn-main" onclick="signInWithGoogle()">Continue with Google</button></div>';
}
function closeMyAnalyses() {
  document.getElementById('my-analyses-overlay').classList.remove('open');
}

async function loadAnalysesList() {
  if (!currentUser) return;
  var listEl = document.getElementById('ma-list');
  listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted2)">Loading...</div>';
  try {
    var db = firebase.firestore();
    var snap = await db.collection('users').doc(currentUser.uid).collection('analyses').orderBy('createdAt', 'desc').get();
    savedAnalysesList = [];
    snap.forEach(function(doc) { savedAnalysesList.push({ id: doc.id, data: doc.data() }); });

    if (savedAnalysesList.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted2)">No saved sessions yet. Complete an analysis and save it to see it here.</div>';
      return;
    }

    listEl.innerHTML = savedAnalysesList.map(function(item, idx) {
      var d = item.data;
      var issueCount = 0;
      if (d.issues) {
        Object.keys(d.issues).forEach(function(k) { if (d.issues[k] && d.issues[k].detected) issueCount++; });
      }
      var issueSummary = issueCount > 0 ? issueCount + ' issue' + (issueCount > 1 ? 's' : '') + ' detected' : 'No issues detected';
      return '<div class="ma-item" style="display:flex;align-items:center;gap:12px">' +
        '<input type="checkbox" class="ma-compare-check" data-id="' + item.id + '" style="width:18px;height:18px;accent-color:#00e5c8;cursor:pointer;flex-shrink:0" onchange="updateCompareSelection()">' +
        '<div class="ma-item-info" style="flex:1;min-width:0">' +
          '<div class="ma-item-name">' + (d.name || 'Untitled') + '</div>' +
          '<div class="ma-item-date">' + (d.date || '') + (d.sex ? ' -- ' + d.sex : '') + '</div>' +
          '<div class="ma-item-issues">' + issueSummary + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0">' +
          '<button class="ma-action-btn" data-action="view" data-id="' + item.id + '" style="padding:8px 18px;font-size:13px;font-weight:700;border-radius:8px;border:1px solid rgba(0,229,200,.35);background:rgba(0,229,200,.1);color:#00e5c8;cursor:pointer">View</button>' +
          '<button class="ma-action-btn" data-action="delete" data-id="' + item.id + '" style="padding:8px 18px;font-size:13px;font-weight:700;border-radius:8px;border:1px solid rgba(245,80,80,.3);background:rgba(245,80,80,.06);color:#f55050;cursor:pointer">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');

    // Show compare bar if 2+ sessions exist
    var compareBar = document.getElementById('ma-compare-bar');
    if (compareBar) compareBar.style.display = savedAnalysesList.length >= 2 ? 'block' : 'none';
    updateCompareSelection();

    // Attach event delegation for action buttons
    listEl.removeEventListener('click', handleAnalysisAction);
    listEl.addEventListener('click', handleAnalysisAction);
  } catch(e) {
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--bad)">Failed to load: ' + e.message + '</div>';
  }
}

function handleAnalysisAction(e) {
  var btn = e.target.closest('.ma-action-btn');
  if (!btn) return;
  var action = btn.getAttribute('data-action');
  var id = btn.getAttribute('data-id');
  if (!action || !id) return;
  if (action === 'view') viewSavedAnalysis(id);
  else if (action === 'delete') deleteAnalysis(id);
}

function updateCompareSelection() {
  var checks = document.querySelectorAll('.ma-compare-check:checked');
  var btn = document.getElementById('ma-compare-btn');
  var hint = document.getElementById('ma-compare-hint');
  if (!btn) return;
  if (checks.length === 2) {
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    if (hint) hint.textContent = '2 sessions selected';
  } else if (checks.length > 2) {
    // Uncheck the oldest selection (first checked that isn't the latest)
    var allChecks = document.querySelectorAll('.ma-compare-check');
    for (var ci = 0; ci < allChecks.length; ci++) {
      if (allChecks[ci].checked) {
        var isLatest = false;
        for (var cj = 0; cj < checks.length; cj++) {
          if (checks[cj] === allChecks[ci] && cj === checks.length - 1) isLatest = true;
        }
        if (!isLatest) { allChecks[ci].checked = false; break; }
      }
    }
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    if (hint) hint.textContent = '2 sessions selected';
  } else {
    btn.style.opacity = '.4';
    btn.style.pointerEvents = 'none';
    if (hint) hint.textContent = checks.length === 1 ? '1 selected -- pick one more to compare' : 'Select 2 sessions to compare';
  }
}

function compareSelected() {
  var checks = document.querySelectorAll('.ma-compare-check:checked');
  if (checks.length !== 2) return;
  var idA = checks[0].getAttribute('data-id');
  var idB = checks[1].getAttribute('data-id');
  closeMyAnalyses();
  openCompare(idA, idB);
}

async function deleteAnalysis(id) {
  if (!confirm('Delete this analysis? This cannot be undone.')) return;
  try {
    var db = firebase.firestore();
    await db.collection('users').doc(currentUser.uid).collection('analyses').doc(id).delete();
    await loadAnalysesList();
  } catch(e) {
    alert('Delete failed: ' + e.message);
  }
}

async function viewSavedAnalysis(id) {
  var item = savedAnalysesList.find(function(a) { return a.id === id; });
  if (!item) return;
  var d = item.data;

  closeMyAnalyses();
  isViewingSaved = true;

  // Hide upload/scanning screens, show phases container (report lives inside it)
  document.getElementById('screen-upload').style.display = 'none';
  document.getElementById('screen-scanning').style.display = 'none';
  document.getElementById('screen-phases').style.display = 'block';
  // Hide the instruction banner and phase cards (no video data for saved analyses)
  var instrBanner = document.querySelector('#screen-phases > .instr-banner');
  if (instrBanner) instrBanner.style.display = 'none';
  var scanSummaryBar = document.getElementById('scan-summary-bar');
  if (scanSummaryBar) scanSummaryBar.style.display = 'none';
  var phaseGroupsEl = document.getElementById('phase-groups');
  if (phaseGroupsEl) phaseGroupsEl.style.display = 'none';
  var bar = document.getElementById('complete-analysis-bar');
  if (bar) bar.classList.remove('show');

  // Show saved view banner
  var banner = document.getElementById('saved-view-banner');
  document.getElementById('saved-view-name').textContent = d.name || 'Untitled';
  document.getElementById('saved-view-date').textContent = d.date || '';
  banner.style.display = 'flex';

  // Set sex
  selectedSex = d.sex || null;

  // Populate phases from saved data
  PHASE_DEFS.forEach(function(def) {
    var saved = d.phases ? d.phases[def.key] : null;
    phases[def.key] = {
      key: def.key, label: def.label, desc: def.desc, videoKey: def.videoKey,
      side: def.side, detectsIssue: def.detectsIssue, guide: def.guide,
      t: saved ? saved.t : 0, detected: saved ? saved.detected : false,
      kps: null, metrics: saved ? saved.metrics : null,
      frontBackMetrics: saved ? saved.frontBackMetrics : null,
      sideView: true
    };
  });

  // Set issues for PDF generation
  lastIssues = d.issues || {};

  // Show report
  var reportEl = document.getElementById('report-section');
  if (reportEl) reportEl.style.display = 'block';
  renderReport(d.issues || {});

  // Show summary table
  var summaryEl = document.getElementById('summary-section');
  if (summaryEl) summaryEl.style.display = 'block';
  buildSummaryTable();
  PHASE_DEFS.forEach(function(def) {
    if (phases[def.key] && phases[def.key].metrics && def.videoKey === 'side') {
      updateSummaryCol(def.key);
    }
  });
  var ccaSV = document.getElementById('coaching-cta-section');
  if (ccaSV) ccaSV.style.display = 'block';
  var rfnSV = document.getElementById('report-footnotes');
  if (rfnSV) rfnSV.style.display = 'grid';
  applyPaywallState();

  // Hide save section (it is a saved analysis already)
  var saveEl = document.getElementById('save-section');
  if (saveEl) saveEl.style.display = 'none';
}



function openCompare(idA, idB) {
  document.getElementById('compare-overlay').classList.add('open');
  var picker = document.getElementById('compare-picker');
  if (savedAnalysesList.length < 2) {
    picker.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted2)">You need at least 2 saved sessions to compare.</div>';
    document.getElementById('compare-results').innerHTML = '';
    return;
  }

  var optionsHtml = savedAnalysesList.map(function(item) {
    return '<option value="' + item.id + '">' + (item.data.name || 'Untitled') + ' (' + (item.data.date || '') + ')</option>';
  }).join('');

  picker.innerHTML = '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
    '<div style="flex:1;min-width:200px"><label style="font-size:11px;font-family:var(--mono);color:var(--muted2);display:block;margin-bottom:4px">Session A (earlier)</label><select class="save-input" id="compare-a" onchange="runCompare()">' + optionsHtml + '</select></div>' +
    '<div style="font-size:18px;color:var(--muted)">vs</div>' +
    '<div style="flex:1;min-width:200px"><label style="font-size:11px;font-family:var(--mono);color:var(--muted2);display:block;margin-bottom:4px">Session B (later)</label><select class="save-input" id="compare-b" onchange="runCompare()">' + optionsHtml + '</select></div>' +
  '</div>';

  if (!idA || !idB) {
    // Default to the two most-recently-saved sessions when no IDs are supplied.
    idA = savedAnalysesList[1].id;
    idB = savedAnalysesList[0].id;
  }
  // Always render A as the OLDER session by the user-entered analysis date.
  // Callers (the My Analyses checkbox flow, "Compare with this") may pass
  // them in arbitrary order; the labels promise A=earlier / B=later, so we
  // sort here rather than asking each caller to.
  var aItem = savedAnalysesList.find(function(x) { return x.id === idA; });
  var bItem = savedAnalysesList.find(function(x) { return x.id === idB; });
  if (aItem && bItem) {
    var aDate = (aItem.data && aItem.data.date) || '';
    var bDate = (bItem.data && bItem.data.date) || '';
    if (aDate && bDate && aDate > bDate) {
      var tmp = idA; idA = idB; idB = tmp;
    }
  }
  document.getElementById('compare-a').value = idA;
  document.getElementById('compare-b').value = idB;
  runCompare();
}

function closeCompare() {
  document.getElementById('compare-overlay').classList.remove('open');
}

// For non-side-specific phases (mid), the L/R assignments
// depend on which leg happened to be captured. To compare sessions fairly,
// we normalize by pairing metrics by functional role rather than L/R label.
// Pairs: lKnee/rKnee, lHip/rHip, lElbow/rElbow, lFoot/rFoot
// For each pair, we pick the value closer to the "primary" role for that phase:
//   swing: the extending leg (higher knee angle)
function runCompare() {
  var idA = document.getElementById('compare-a').value;
  var idB = document.getElementById('compare-b').value;
  var resultsEl = document.getElementById('compare-results');

  if (idA === idB) {
    resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted2)">Select two different analyses to compare.</div>';
    return;
  }

  var itemA = savedAnalysesList.find(function(a) { return a.id === idA; });
  var itemB = savedAnalysesList.find(function(a) { return a.id === idB; });
  if (!itemA || !itemB) return;

  var dA = itemA.data, dB = itemB.data;
  var issuesA = dA.issues || {};
  var issuesB = dB.issues || {};

  function sevRank(issue) {
    if (!issue || !issue.detected) return 0;
    if (issue.severity === 'mild') return 1;
    if (issue.severity === 'notable') return 2;
    return 0;
  }

  function sevLabel(issue) {
    if (!issue || !issue.detected) return '<span style="color:var(--muted2)">Clear</span>';
    if (issue.severity === 'notable') return '<span style="color:var(--text)">&#9679; Notable</span>';
    if (issue.severity === 'mild') return '<span style="color:var(--muted2)">&#9675; Mild</span>';
    return '<span style="color:var(--muted2)">Clear</span>';
  }

  var issueKeys = [
    { key: 'overstriding', title: 'Overstriding' },
    { key: 'hipDrop', title: 'Hip drop' },
    { key: 'armsCrossing', title: 'Arms crossing midline' },
    { key: 'torsoPosition', title: 'Torso position' },
    { key: 'armAngle', title: 'Arm angle' },
    { key: 'kneeValgus', title: 'Knee valgus' }
  ];

  var html = '<div style="margin-top:20px">';

  html += '<div style="text-align:center;margin:8px 0 24px"><button class="btn-download-report" onclick="downloadComparisonPDF()">' +
            '<span class="bdr-icon">&#11015;</span>' +
            '<span>Download comparison report as PDF</span>' +
            '<span class="bdr-sub">save &middot; share &middot; print</span>' +
          '</button></div>';
  html += '<div style="font-size:14px;font-weight:700;margin-bottom:12px;padding:0 22px">Issue changes</div>';
  html += '<div class="compare-grid">';

  issueKeys.forEach(function(ik) {
    var a = issuesA[ik.key], b = issuesB[ik.key];
    var rA = sevRank(a), rB = sevRank(b);
    var dir = rB < rA ? 'improved' : rB === rA ? 'same' : 'worsened';
    var dirLabel = dir === 'improved' ? '&#9660; Improved' : dir === 'worsened' ? '&#9650; Worsened' : '&#8212; Same';
    var dirClass = 'direction-' + dir;

    html += '<div class="compare-issue-row">' +
      '<div class="compare-issue-card"><div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-bottom:4px">' + (dA.name || 'A') + '</div>' + sevLabel(a) + '</div>' +
      '<div class="compare-direction"><div class="' + dirClass + '">' + dirLabel + '</div><div style="font-size:10px;color:var(--muted);margin-top:2px">' + ik.title + '</div></div>' +
      '<div class="compare-issue-card"><div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-bottom:4px">' + (dB.name || 'B') + '</div>' + sevLabel(b) + '</div>' +
    '</div>';
  });

  html += '</div>';

  html += '<div style="margin-top:20px">';
  html += '<button class="compare-details-toggle" onclick="this.classList.toggle(\'open\');document.getElementById(\'compare-detail-table\').classList.toggle(\'open\')">Angle measurements detail <span class="toggle-arrow">&#9660;</span></button>';
  html += '<div class="compare-details-table" id="compare-detail-table">';

  var sidePhases = ['l_foot','r_foot','l_toe','r_toe','mid'];
  html += '<table class="stbl" style="min-width:500px"><thead><tr><th>Phase</th><th>Metric</th><th>' + (dA.name || 'A') + '</th><th>' + (dB.name || 'B') + '</th><th>Change</th></tr></thead><tbody>';

  sidePhases.forEach(function(pk) {
    var phA = dA.phases ? dA.phases[pk] : null;
    var phB = dB.phases ? dB.phases[pk] : null;
    var mA = phA ? phA.metrics : null;
    var mB = phB ? phB.metrics : null;
    var phaseDef = PHASE_DEFS.find(function(d) { return d.key === pk; });
    var phaseLabel = phaseDef ? phaseDef.label : pk;

    {
      // Compare using METRIC_ROWS + isRelevant (functional keys for bilateral, L/R for side-specific)
      METRIC_ROWS.forEach(function(r) {
        if (!isRelevant(pk, r.key)) return;
        var vA = mA ? mA[r.key] : null;
        var vB = mB ? mB[r.key] : null;
        var fA = vA != null ? r.fmt(vA) : '--';
        var fB = vB != null ? r.fmt(vB) : '--';
        var delta = '';
        var deltaStyle = 'color:var(--muted2)';
        if (vA != null && vB != null) {
          var diff = vB - vA;
          delta = (diff > 0 ? '+' : '') + diff.toFixed(1);
          var rng = getRange(pk, r.key);
          var center = (rng.green[0] + rng.green[1]) / 2;
          var distA = Math.abs(vA - center);
          var distB = Math.abs(vB - center);
          if (Math.abs(diff) < 0.5) deltaStyle = 'color:var(--muted)';
          else if (distB < distA) deltaStyle = 'color:var(--good)';
          else deltaStyle = 'color:var(--warn)';
        }
        html += '<tr><td class="row-label">' + phaseLabel + '</td><td class="row-label">' + r.label + '</td><td style="font-family:var(--mono);font-size:12px">' + fA + '</td><td style="font-family:var(--mono);font-size:12px">' + fB + '</td><td style="font-family:var(--mono);font-size:12px;font-weight:700;' + deltaStyle + '">' + delta + '</td></tr>';
      });
    }
  });

  html += '</tbody></table></div></div>';
  html += '</div>';

  resultsEl.innerHTML = html;
}

// Calls the server-rendered generateComparisonReport Cloud Function,
// which enforces the active-pass check and ownership of both analyses
// server-side. Replaces the old in-browser jsPDF renderer.
async function downloadComparisonPDF() {
  if (!currentUser) { alert('Please sign in to download the comparison report.'); return; }
  var idA = document.getElementById('compare-a') ? document.getElementById('compare-a').value : null;
  var idB = document.getElementById('compare-b') ? document.getElementById('compare-b').value : null;
  if (!idA || !idB || idA === idB) { alert('Select two different analyses to compare.'); return; }

  var btnEls = Array.prototype.slice.call(document.querySelectorAll('button[onclick*="downloadComparisonPDF"]'));
  var origLabels = btnEls.map(function(b) { return b.innerHTML; });
  btnEls.forEach(function(b) { b.disabled = true; b.innerHTML = 'Generating PDF…'; });

  try {
    var fns = firebase.app().functions('us-central1');
    var call = fns.httpsCallable('generateComparisonReport');
    var res = await call({ idA: idA, idB: idB });
    var data = res && res.data ? res.data : {};
    if (!data.pdfBase64) throw new Error('Empty response from comparison renderer.');

    var binary = atob(data.pdfBase64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = data.filename || ('esformlab-comparison-' + new Date().toISOString().slice(0,10) + '.pdf');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  } catch (err) {
    console.error('downloadComparisonPDF failed:', err);
    var code = err && err.code;
    if (code === 'functions/permission-denied' || code === 'permission-denied') {
      alert('An active esFormLab pass is required to download the comparison report.');
    } else if (code === 'functions/unauthenticated' || code === 'unauthenticated') {
      alert('Please sign in to download the comparison report.');
    } else if (code === 'functions/not-found' || code === 'not-found') {
      alert('Could not find one or both selected analyses.');
    } else {
      alert('Could not generate the comparison PDF. Please try again in a moment.\n\n' + (err && err.message ? err.message : ''));
    }
  } finally {
    btnEls.forEach(function(b, i) { b.disabled = false; b.innerHTML = origLabels[i]; });
  }
}
