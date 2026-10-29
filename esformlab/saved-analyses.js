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

// "2026-10-04" -> "Oct 4, 2026" for display (falls back to the raw value).
function eflFmtDate(raw) {
  if (!raw) return '';
  try {
    var dt = new Date(String(raw) + 'T12:00:00');
    if (isNaN(dt.getTime())) return String(raw);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return String(raw); }
}

// Saved-analysis names/dates/ids are free text from the user's own doc, and
// the admin views them too when acting as that user -- escape before any
// innerHTML (text or quoted attribute).
function escSaved(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Firestore rejects any document containing undefined. The analysis payload is
// assembled from many optional blocks (one per phase), so one missed field
// must not break every save: drop undefined object fields, null them in arrays.
// Only plain objects are walked — Firestore sentinels like serverTimestamp()
// pass through untouched.
function stripUndefinedDeep(v) {
  if (Array.isArray(v)) {
    return v.map(function(x) { return x === undefined ? null : stripUndefinedDeep(x); });
  }
  if (v && typeof v === 'object' && v.constructor === Object) {
    var out = {};
    Object.keys(v).forEach(function(k) {
      if (v[k] !== undefined) out[k] = stripUndefinedDeep(v[k]);
    });
    return out;
  }
  return v;
}

async function saveAnalysis() {
  if (!currentUser) { signInWithGoogle(); return; }
  var nameVal = document.getElementById('save-name').value.trim();
  var dateVal = document.getElementById('save-date').value;
  var statusEl = document.getElementById('save-status');
  if (!nameVal) { statusEl.textContent = 'Please enter a session name.'; statusEl.style.color = 'var(--warn-ink)'; return; }
  if (!dateVal) { statusEl.textContent = 'Please select a date.'; statusEl.style.color = 'var(--warn-ink)'; return; }

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
    await db.collection('users').doc(currentUser.uid).collection('analyses').add(stripUndefinedDeep(data));
    window.__eflSavedThisRun = true;
    statusEl.textContent = 'Saved successfully!';
    statusEl.style.color = 'var(--good-ink)';
    btn.textContent = 'Saved';
    btn.disabled = true;
    await loadAnalysesList();
    setTimeout(function() { btn.textContent = 'Save analysis'; btn.disabled = false; }, 3000);
  } catch(e) {
    statusEl.textContent = 'Save failed: ' + e.message;
    statusEl.style.color = 'var(--bad-ink)';
    btn.textContent = 'Save analysis';
    btn.disabled = false;
  }
}

function startNewSession() {
  var wasSaved = isViewingSaved;
  currentSavedId = null;
  // Mid-scan: the scan loop can't be stopped in place, so start over with a reload.
  if (typeof scanInProgress !== 'undefined' && scanInProgress) {
    if (confirm('Stop the scan and start over? The page will reload and you\u2019ll pick your videos again.')) window.location.reload();
    return;
  }
  if (!isViewingSaved) {
    var hasAnalysis = PHASE_DEFS.some(function(d) { return phases[d.key] && phases[d.key].metrics; });
    if (IS_MOBILE_RUNNER) {
      if (hasAnalysis && !confirm('Start a new analysis? The page will reload \u2014 save first if you want to keep this analysis. You\u2019ll need to pick your videos again.')) return;
    } else if (hasAnalysis && !confirm('Start a new analysis? This discards your current analysis if it hasn\u2019t been saved.')) return;
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
  var reviewActions = document.getElementById('review-actions');
  if (reviewActions) reviewActions.style.display = '';
  closeMyAnalyses();
  closeCompare();
  resetApp();
  var clickHintNS = document.getElementById('summary-click-hint');
  if (clickHintNS) clickHintNS.textContent = 'Click any column header to open and re-examine that phase.';
  // Viewing a saved session switched the grading sex; restore the live choice.
  if (wasSaved) setSex(window.__eflLiveSex || null);
}

function openMyAnalyses() {
  var maOv = document.getElementById('my-analyses-overlay');
  var wasOpen = maOv.classList.contains('open');
  maOv.classList.add('open');
  if (!wasOpen) esLabs.openDialog(maOv, { initialFocus: maOv.querySelector('.ma-hdr .ep-close'), onClose: closeMyAnalyses });
  if (currentUser) loadAnalysesList();
  else {
    // Google popups fail in in-app browsers / without sessionStorage: offer the email sign-in instead.
    var signInBtn = (esLabs.googleOAuthAvailable && esLabs.googleOAuthAvailable())
      ? '<button class="btn-main" onclick="signInWithGoogle()">Continue with Google</button>'
      : '<button class="btn-main" onclick="closeMyAnalyses();signInWithGoogle()">Sign in</button>';
    document.getElementById('ma-list').innerHTML = '<div style="text-align:center;padding:40px"><div style="font-size:15px;font-weight:700;margin-bottom:6px">Save your sessions — free</div><div style="font-size:12px;color:var(--muted2);margin-bottom:14px">One-tap signup. Your videos never leave your browser.</div>' + signInBtn + '</div>';
  }
}
function closeMyAnalyses() {
  var maOv = document.getElementById('my-analyses-overlay');
  if (!maOv.classList.contains('open')) return;
  maOv.classList.remove('open');
  esLabs.closeDialog(maOv);
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
      var nameEsc = escSaved(d.name || 'Untitled');
      return '<div class="ma-item">' +
        '<input type="checkbox" class="ma-compare-check" data-id="' + escSaved(item.id) + '" aria-label="Compare ' + nameEsc + '" onchange="updateCompareSelection(this)">' +
        '<div class="ma-item-info">' +
          '<div class="ma-item-name">' + nameEsc + '</div>' +
          '<div class="ma-item-date">' + escSaved(eflFmtDate(d.date)) + (d.sex ? ' · ' + escSaved(d.sex.charAt(0).toUpperCase() + d.sex.slice(1)) : '') + '</div>' +
          '<div class="ma-item-issues">' + issueSummary + '</div>' +
        '</div>' +
        '<div class="ma-item-actions">' +
          '<button type="button" class="ma-action-btn view esl-btn esl-btn--sm esl-btn--outline" data-action="view" data-id="' + escSaved(item.id) + '">View</button>' +
          '<button type="button" class="ma-action-btn delete esl-btn esl-btn--sm esl-btn--danger" data-action="delete" data-id="' + escSaved(item.id) + '">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');

    // Show compare bar if 2+ sessions exist
    var compareBar = document.getElementById('ma-compare-bar');
    if (compareBar) compareBar.style.display = savedAnalysesList.length >= 2 ? 'block' : 'none';
    eflCompareOrder = [];
    updateCompareSelection();

    // Attach event delegation for action buttons
    listEl.removeEventListener('click', handleAnalysisAction);
    listEl.addEventListener('click', handleAnalysisAction);
  } catch(e) {
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--bad-ink)">Failed to load: ' + e.message + '</div>';
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

// Ticked rows in click order: a third tick replaces the oldest click (esflpdf-11).
var eflCompareOrder = [];
function updateCompareSelection(el) {
  if (el && el.dataset && el.dataset.id) {
    var id = el.dataset.id;
    eflCompareOrder = eflCompareOrder.filter(function(x) { return x !== id; });
    if (el.checked) eflCompareOrder.push(id);
  }
  // Drop ids whose box is no longer ticked (e.g. after a list reload).
  eflCompareOrder = eflCompareOrder.filter(function(x) {
    var cb = document.querySelector('.ma-compare-check[data-id="' + (window.CSS && CSS.escape ? CSS.escape(x) : x) + '"]');
    return cb && cb.checked;
  });
  // Ticked boxes we haven't seen a click for (set programmatically) join at the end.
  Array.prototype.forEach.call(document.querySelectorAll('.ma-compare-check:checked'), function(cb) {
    var cid = cb.getAttribute('data-id');
    if (cid && eflCompareOrder.indexOf(cid) === -1) eflCompareOrder.push(cid);
  });
  while (eflCompareOrder.length > 2) {
    var oldest = eflCompareOrder.shift();
    var ocb = document.querySelector('.ma-compare-check[data-id="' + (window.CSS && CSS.escape ? CSS.escape(oldest) : oldest) + '"]');
    if (ocb) ocb.checked = false;
  }
  var count = eflCompareOrder.length;
  var btn = document.getElementById('ma-compare-btn');
  var hint = document.getElementById('ma-compare-hint');
  if (!btn) return;
  btn.disabled = count !== 2;
  if (hint) hint.textContent = count === 2 ? '2 sessions selected' : count === 1 ? '1 selected \u2014 pick one more to compare' : 'Select 2 sessions to compare';
}

function compareSelected() {
  if (eflCompareOrder.length !== 2) return;
  var idA = eflCompareOrder[0];
  var idB = eflCompareOrder[1];
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
  if (typeof tourState !== 'undefined' && tourState.active) endTour(true);
  var item = savedAnalysesList.find(function(a) { return a.id === id; });
  if (!item) return;
  // Unsaved live work (a report, or analysed phases) would be replaced: ask first.
  var hasLiveWork = lastIssues !== null || PHASE_DEFS.some(function(pd) { return phases[pd.key] && phases[pd.key].metrics; });
  if (!isViewingSaved && hasLiveWork && !window.__eflSavedThisRun &&
      !confirm('Open this saved session? Your current analysis hasn\u2019t been saved and will be replaced.')) return;
  var d = item.data;
  if (!isViewingSaved) window.__eflLiveSex = selectedSex;
  currentSavedId = id;
  var rpmVS = document.getElementById('report-print-meta');
  if (rpmVS) rpmVS.textContent = '';
  var saveNameVS = document.getElementById('save-name');
  if (saveNameVS) saveNameVS.value = '';

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
  var reviewActions = document.getElementById('review-actions');
  if (reviewActions) reviewActions.style.display = 'none';
  var scanWarnBox = document.getElementById('scan-warnings');
  if (scanWarnBox) scanWarnBox.hidden = true;
  var clickHint = document.getElementById('summary-click-hint');
  if (clickHint) clickHint.textContent = 'Open a live analysis to re-examine phases.';
  document.body.classList.add('esfl-has-session');
  var phaseGroupsEl = document.getElementById('phase-groups');
  if (phaseGroupsEl) phaseGroupsEl.style.display = 'none';
  var bar = document.getElementById('complete-analysis-bar');
  if (bar) bar.classList.remove('show');

  // Show saved view banner
  var banner = document.getElementById('saved-view-banner');
  document.getElementById('saved-view-name').textContent = d.name || 'Untitled';
  document.getElementById('saved-view-date').textContent = eflFmtDate(d.date);
  banner.style.display = 'flex';

  // Set sex
  setSex(d.sex || null);

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



// Chronological order for Compare: user-entered date, then save time (esflpdf-02).
function eflOrderKey(item) {
  var d = (item && item.data) || {};
  var ca = d.createdAt;
  var ts = ca && ca.toMillis ? ca.toMillis() : (ca && ca.seconds ? ca.seconds * 1000 : 0);
  return [d.date || '', ts];
}
function isLater(a, b) {
  var ka = eflOrderKey(a), kb = eflOrderKey(b);
  return ka[0] > kb[0] || (ka[0] === kb[0] && ka[1] > kb[1]);
}

function openCompare(idA, idB) {
  document.getElementById('compare-overlay').classList.add('open');
  document.body.classList.add('compare-open');
  var picker = document.getElementById('compare-picker');
  if (savedAnalysesList.length < 2) {
    picker.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted2)">You need at least 2 saved sessions to compare.</div>';
    document.getElementById('compare-results').innerHTML = '';
    eflOpenCompareDialog();
    return;
  }

  // Sessions sharing a date also show the save time so the two can be told apart.
  var dateCounts = {};
  savedAnalysesList.forEach(function(item) { var k = item.data.date || ''; dateCounts[k] = (dateCounts[k] || 0) + 1; });
  var optionsHtml = savedAnalysesList.map(function(item) {
    var label = eflFmtDate(item.data.date);
    if (dateCounts[item.data.date || ''] > 1) {
      var ts = eflOrderKey(item)[1];
      if (ts) label += ' \u00b7 ' + new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return '<option value="' + escSaved(item.id) + '">' + escSaved(item.data.name || 'Untitled') + (label ? ' (' + escSaved(label) + ')' : '') + '</option>';
  }).join('');

  picker.innerHTML = '<div class="compare-pick-row">' +
    '<div class="compare-pick"><label for="compare-a">Session A (earlier)</label><select class="save-input" id="compare-a" onchange="runCompare()">' + optionsHtml + '</select></div>' +
    '<div class="compare-vs">vs</div>' +
    '<div class="compare-pick"><label for="compare-b">Session B (later)</label><select class="save-input" id="compare-b" onchange="runCompare()">' + optionsHtml + '</select></div>' +
  '</div>' +
  '<p class="compare-swap-hint esl-caption" id="compare-swap-hint" role="status" hidden></p>';

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
  if (aItem && bItem && isLater(aItem, bItem)) {
    var tmp = idA; idA = idB; idB = tmp;
  }
  document.getElementById('compare-a').value = idA;
  document.getElementById('compare-b').value = idB;
  runCompare();
  eflOpenCompareDialog();
}

// Compare dialog semantics (a11y-13): focus the first picker, trap Tab, Escape closes.
function eflOpenCompareDialog() {
  var cOv = document.getElementById('compare-overlay');
  esLabs.openDialog(cOv, { initialFocus: document.getElementById('compare-a') || cOv.querySelector('.compare-hdr .ep-close'), onClose: closeCompare });
}

function closeCompare() {
  var cOv = document.getElementById('compare-overlay');
  if (!cOv.classList.contains('open')) return;
  cOv.classList.remove('open');
  document.body.classList.remove('compare-open');
  esLabs.closeDialog(cOv);
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
  // Keep the "A = earlier" promise when the user picks them the other way round.
  var swapHint = document.getElementById('compare-swap-hint');
  if (isLater(itemA, itemB)) {
    var tmpItem = itemA; itemA = itemB; itemB = tmpItem;
    idA = itemA.id; idB = itemB.id;
    document.getElementById('compare-a').value = idA;
    document.getElementById('compare-b').value = idB;
    if (swapHint) { swapHint.textContent = 'Swapped so Session A is the earlier one'; swapHint.hidden = false; }
  } else if (swapHint) { swapHint.hidden = true; }

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
    if (issue && issue.detected && issue.severity === 'notable') return '<span class="esl-badge esl-badge--bad">Notable</span>';
    if (issue && issue.detected && issue.severity === 'mild') return '<span class="esl-badge esl-badge--warn">Mild</span>';
    return '<span class="esl-badge">Clear</span>';
  }

  var issueKeys = [
    { key: 'overstriding', title: 'Overstriding' },
    { key: 'hipDrop', title: 'Hip drop' },
    { key: 'armsCrossing', title: 'Arms crossing midline' },
    { key: 'torsoPosition', title: 'Torso position' },
    { key: 'armAngle', title: 'Arm angle' },
    { key: 'kneeValgus', title: 'Knee valgus' }
  ];

  var nameA = escSaved(dA.name || 'Session A'), nameB = escSaved(dB.name || 'Session B');
  var passOk = !(window.esLabs && esLabs.getPassState) || !!(esLabs.getPassState() || {}).unlocked;
  var html = '<div class="compare-results-inner">';

  html += '<div class="compare-dl"><button class="btn-download-report" onclick="downloadComparisonPDF()">' +
            '<span class="bdr-icon">&#11015;</span>' +
            '<span>Download comparison report as PDF</span>' +
            '<span class="bdr-sub">save &middot; share &middot; print</span>' +
          '</button>' +
          (passOk ? '' : '<p class="esl-caption compare-pass-hint">Requires an active 90-day pass</p>') +
          '</div>';
  html += '<h3 class="compare-subhead">Issue changes</h3>';
  html += '<div class="compare-grid">';
  html += '<div class="cmp-head" aria-hidden="true"><span>Issue</span><span>' + nameA + '</span><span>Change</span><span>' + nameB + '</span></div>';

  issueKeys.forEach(function(ik) {
    var a = issuesA[ik.key], b = issuesB[ik.key];
    var rA = sevRank(a), rB = sevRank(b);
    var dir = rB < rA ? 'improved' : rB === rA ? 'same' : 'worsened';
    var dirLabel = dir === 'improved' ? '&#9660; Improved' : dir === 'worsened' ? '&#9650; Worsened' : '&#8212; Same';
    var dirClass = 'direction-' + dir;

    html += '<div class="compare-issue-row">' +
      '<span class="cmp-issue">' + ik.title + '</span>' +
      '<span class="cmp-a"><span class="cmp-sess">Session A</span>' + sevLabel(a) + '</span>' +
      '<span class="cmp-dir ' + dirClass + '">' + dirLabel + '</span>' +
      '<span class="cmp-b"><span class="cmp-sess">Session B</span>' + sevLabel(b) + '</span>' +
    '</div>';
  });

  html += '</div>';

  html += '<div class="compare-details-wrap">';
  html += '<button class="compare-details-toggle" onclick="this.classList.toggle(\'open\');document.getElementById(\'compare-detail-table\').classList.toggle(\'open\')">Angle measurements detail <span class="toggle-arrow">&#9660;</span></button>';
  html += '<div class="compare-details-table" id="compare-detail-table">';

  var sidePhases = ['l_foot','r_foot','l_toe','r_toe','mid'];
  html += '<table class="stbl" style="min-width:500px"><thead><tr><th>Phase</th><th>Metric</th><th>' + nameA + '</th><th>' + nameB + '</th><th>Change</th></tr></thead><tbody>';

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
        var fA = vA != null ? r.fmt(vA) : '\u2013';
        var fB = vB != null ? r.fmt(vB) : '\u2013';
        var delta = '';
        var deltaStyle = 'color:var(--muted2)';
        if (vA != null && vB != null) {
          var diff = vB - vA;
          delta = (diff > 0 ? '+' : '') + diff.toFixed(1);
          var rng = getRange(pk, r.key);
          var center = (rng.green[0] + rng.green[1]) / 2;
          var distA = Math.abs(vA - center);
          var distB = Math.abs(vB - center);
          if (Math.abs(diff) < 0.5) deltaStyle = 'color:var(--muted2)';
          else if (distB < distA) deltaStyle = 'color:var(--good-ink)';
          else deltaStyle = 'color:var(--warn-ink)';
        }
        html += '<tr><td class="row-label">' + phaseLabel + '</td><td class="row-label">' + r.label + '</td><td style="font-family:var(--mono);font-size:12px">' + fA + '</td><td style="font-family:var(--mono);font-size:12px">' + fB + '</td><td style="font-family:var(--mono);font-size:12px;font-weight:700;' + deltaStyle + '">' + delta + '</td></tr>';
      });
    }
  });

  html += '</tbody></table>';
  html += '<p class="cmp-legend">Change: green = closer to the middle of the reference range than in Session A \u00b7 amber = further from it \u00b7 grey = changed by less than 0.5.</p>';
  html += '</div></div>';
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
    var payload = { idA: idA, idB: idB };
    // Admin acting as an athlete: the server reads the athlete's analyses (functions allow admin ownerUid).
    if (esLabs.isActingAs && esLabs.isActingAs() && currentUser && currentUser.uid) payload.ownerUid = currentUser.uid;
    var res = await call(payload);
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
