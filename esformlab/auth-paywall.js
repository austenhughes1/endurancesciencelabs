// ════════════════════════════════════════════════════════════════
// esformlab/auth-paywall.js
//
// esFormLab-specific paywall + post-auth UI hooks. All cross-site
// auth / pass / billing logic lives in /shared/site.js (esLabs) --
// this file only wires the shared state to esFormLab's page-specific
// DOM: the blur on the report, the "My Sessions" button, save buttons,
// the auto-save-before-checkout flow, and the read-only fetch of the
// computed_ranges/{sex} reference data.
//
// Globals consumed (set by the main inline script):
//   currentUser, auth2, selectedSex, liveRanges, MIN_N, PHASE_DEFS,
//   METRIC_ROWS, isRelevant, phases, lastIssues, savedAnalysesList,
//   setSex, viewSavedAnalysis, loadAnalysesList, updateRangesStatus,
//   getDetectionQuality.
// ════════════════════════════════════════════════════════════════

// -- Read-only fetch of the computed_ranges reference data --------
async function loadLiveRanges() {
  try {
    var db = esLabs.db;
    var results = await Promise.allSettled([
      db.collection('computed_ranges').doc('male').get(),
      db.collection('computed_ranges').doc('female').get(),
      db.collection('computed_ranges').doc('combined').get(),
    ]);
    var mSnap = results[0], fSnap = results[1], cSnap = results[2];
    if (mSnap.status==='fulfilled'&&mSnap.value.exists) liveRanges.male     = mSnap.value.data().phases||null;
    if (fSnap.status==='fulfilled'&&fSnap.value.exists) liveRanges.female   = fSnap.value.data().phases||null;
    if (cSnap.status==='fulfilled'&&cSnap.value.exists) liveRanges.combined = cSnap.value.data().phases||null;
    var mN = liveRanges.male     ? Object.keys(liveRanges.male).length     : 0;
    var fN = liveRanges.female   ? Object.keys(liveRanges.female).length   : 0;
    var cN = liveRanges.combined ? Object.keys(liveRanges.combined).length : 0;
    console.log('esFormLab: loaded live ranges -- male: '+mN+', female: '+fN+', combined: '+cN+' phases');
    updateRangesStatus();
  } catch (e) { console.warn('esFormLab: could not fetch live ranges.', e.message); }
}

// -- esFormLab-specific reactions to auth state changes -----------
function loadUserProfile(uid) {
  try {
    esLabs.db.collection('users').doc(uid).get().then(function (doc) {
      if (doc.exists) {
        var data = doc.data();
        if (data.gender && (data.gender === 'male' || data.gender === 'female') && !selectedSex) {
          setSex(data.gender);
        }
      }
    }).catch(function (e) {
      console.warn('Could not load user profile:', e.message);
    });
  } catch (e) {
    console.warn('loadUserProfile error:', e.message);
  }
}

// Inline onclick="" handlers still call these by name -- keep as
// thin wrappers over esLabs.
function signInWithGoogle() {
  if (esLabs.user) { currentUser = esLabs.user; updateAuthUI(); return; }
  var showGate = function () {
    if (typeof esLabs.openSignIn === 'function') { esLabs.openSignIn(); return; }
    if (typeof esflGate !== 'undefined' && esflGate && esflGate.show) esflGate.show();
  };
  if (!esLabs.googleOAuthAvailable()) { showGate(); return; }
  var p = esLabs.signInGoogle();
  if (p && p.catch) p.catch(function (e) { console.warn('Google sign-in failed:', e && e.message); showGate(); });
}
function signOutUser() { esLabs.signOut(); }
function openCustomerPortal() { return esLabs.openCustomerPortal(); }

// Wire auth + pass state from the shared module to esFormLab's DOM.
esLabs.onAuthChange(async function (user) {
  currentUser = user;
  updateAuthUI();
  eflHandlePaidReturn();
  if (user) {
    await loadAnalysesList();
    loadUserProfile(user.uid);
    maybeResumeAfterCheckout();
  } else {
    savedAnalysesList = [];
  }
});

esLabs.onPassChange(function () { applyPaywallState(); eflHandlePaidReturn(); });

// -- Ownership-aware UI (D7): pass chip, owned upsells, post-checkout toast --
function eflPassChipText(ps) {
  if (!ps || !ps.unlocked) return '';
  if (ps.source === 'coaching-bundle') return 'Pass active \u00b7 Full Access';
  if (ps.until) {
    try {
      var d = new Date(ps.until * 1000);
      if (!isNaN(d.getTime())) return 'Pass active \u00b7 until ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {}
  }
  return 'Pass active';
}
function eflUpdateOwnedUI() {
  var ps = esLabs.getPassState ? esLabs.getPassState() : null;
  var chip = document.getElementById('esfl-pass-chip');
  if (chip) {
    var txt = (typeof currentUser !== 'undefined' && currentUser) ? eflPassChipText(ps) : '';
    chip.textContent = txt;
    chip.hidden = !txt;
  }
  // "No pass yet? Save it anyway." only for people without a pass.
  var note = document.getElementById('save-pass-note');
  if (note) note.hidden = !!(ps && ps.unlocked);
  // Coaching subscribers: no upsell to coaching they already have.
  var cca = document.getElementById('coaching-cta-section');
  if (cca) {
    if (cca.__eflSellHtml == null) cca.__eflSellHtml = cca.innerHTML;
    var coached = !!(ps && ps.hasCoaching);
    if (coached && !cca.__eflCoachMode) {
      cca.innerHTML = '<div class="cca-eyebrow">&#9670; You have a coach</div>' +
        '<h2 class="cca-title">Talk it through with your coach</h2>' +
        '<div class="cca-body">Bring these findings to your next check-in and work through the cues together.</div>' +
        '<a href="/coaching/" class="cca-btn">Go to coaching <span class="cca-arrow">&#8594;</span></a>';
      cca.__eflCoachMode = true;
    } else if (!coached && cca.__eflCoachMode) {
      cca.innerHTML = cca.__eflSellHtml;
      cca.__eflCoachMode = false;
    }
  }
}
// Back from Stripe (?paid=1): acknowledge now, confirm once the webhook has granted the pass.
var eflPaidToast = null;
function eflHandlePaidReturn() {
  var params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
  if (params.get('paid') !== '1') return;
  var ps = esLabs.getPassState ? esLabs.getPassState() : null;
  if (ps && ps.unlocked) {
    if (eflPaidToast) eflPaidToast.dismiss();
    eflPaidToast = null;
    esLabs.toast('Pass unlocked \u2014 your full report is ready.');
    try {
      params.delete('paid');
      var qs = params.toString();
      history.replaceState(history.state, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    } catch (e) {}
  } else if (!eflPaidToast && esLabs.user) {
    eflPaidToast = esLabs.toast('Pass unlocked \u2014 finishing setup\u2026', { timeout: 10 * 60 * 1000 });
  }
}

// -- Paywall blur toggle ------------------------------------------
function applyPaywallState() {
  eflUpdateOwnedUI();
  var locked = document.getElementById('report-locked-content');
  var summary = document.getElementById('summary-section');
  var coachingCta = document.getElementById('coaching-cta-section');
  var footnotes = document.getElementById('report-footnotes');
  var paywall = document.getElementById('paywall-card');
  var anomalyBanner = document.getElementById('anomaly-banner');
  // The disclaimer footnotes always stay readable; the intro matches what a locked user sees.
  if (footnotes) footnotes.classList.remove('paywall-blur');
  var reportSub = document.getElementById('report-section-sub');
  if (reportSub) {
    if (reportSub.__eflUnlockedHtml == null) reportSub.__eflUnlockedHtml = reportSub.innerHTML;
    if (esLabs.getPassState().unlocked) reportSub.innerHTML = reportSub.__eflUnlockedHtml;
    else reportSub.textContent = 'Unlock your full report to see what each finding means, why it might matter, and the form cues to work on.';
  }
  if (esLabs.getPassState().unlocked) {
    if (locked) locked.classList.remove('paywall-blur');
    if (summary) summary.classList.remove('paywall-blur');
    if (coachingCta) coachingCta.classList.remove('paywall-blur');
    if (paywall) paywall.style.display = 'none';
    if (anomalyBanner) anomalyBanner.style.display = 'none';
  } else {
    if (locked) locked.classList.add('paywall-blur');
    if (summary) summary.classList.add('paywall-blur');
    if (coachingCta) coachingCta.classList.add('paywall-blur');
    if (paywall) paywall.style.display = 'block';
    if (anomalyBanner && anomalyBanner.getAttribute('data-populated') === '1') {
      anomalyBanner.style.display = 'flex';
    }
  }
}

// -- Stripe 90-day pass checkout with pre-save autosave -----------
async function startPassCheckout() {
  if (!currentUser) { signInWithGoogle(); return; }
  var btn = document.getElementById('paywall-cta-btn');
  var originalLabel = btn ? btn.textContent : 'Unlock pass';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving and opening checkout...'; }
  try {
    // Stripe Checkout is a full-page redirect, so all in-memory state
    // (videos, scrubbed frames, computed angles) gets cleared on return.
    // Save the analysis to the user's library first so we can auto-load
    // it back after payment via the resume flag in localStorage.
    var resumeId = await autosaveAnalysisForResume();
    if (resumeId) {
      try { localStorage.setItem('esformlab_resume_id', resumeId); } catch (e) {}
    }
    await esLabs.startPassCheckout({
      successUrl: window.location.origin + '/esformlab/?paid=1',
      cancelUrl: window.location.href
    });
  } catch (e) {
    console.error('startPassCheckout error:', e);
    alert('Could not start checkout: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

async function autosaveAnalysisForResume() {
  // Unlocking from a saved session resumes that session instead of saving a copy.
  if (isViewingSaved && typeof currentSavedId !== 'undefined' && currentSavedId) return currentSavedId;
  if (!currentUser) return null;
  var hasData = PHASE_DEFS.some(function (d) { return phases[d.key] && phases[d.key].metrics; });
  if (!hasData) return null;
  var now = new Date();
  var data = {
    name: 'Pre-checkout autosave',
    date: now.toLocaleDateString('en-CA'),
    createdAt: esLabs.firebase.firestore.FieldValue.serverTimestamp(),
    sex: selectedSex,
    phases: {},
    issues: lastIssues || {},
    autosave: true,
  };
  PHASE_DEFS.forEach(function (def) {
    var ph = phases[def.key];
    if (!ph || !ph.detected) return;
    var entry = { t: ph.t, detected: true };
    if (ph.metrics && def.videoKey === 'side') {
      entry.metrics = {};
      METRIC_ROWS.forEach(function (r) {
        if (isRelevant(def.key, r.key) && ph.metrics[r.key] !== undefined) {
          entry.metrics[r.key] = ph.metrics[r.key];
        }
      });
    }
    if (ph.frontBackMetrics) entry.frontBackMetrics = ph.frontBackMetrics;
    var q = ph.kps ? getDetectionQuality(ph.kps) : null;
    entry.quality = q ? q.level : null;
    data.phases[def.key] = entry;
  });
  if (typeof PGIApp !== 'undefined') {
    try {
      var pgiFields = PGIApp.storedFields();
      Object.keys(pgiFields).forEach(function (k) { data[k] = pgiFields[k]; });
    } catch (e) { console.warn('pgi autosave fields skipped:', e.message); }
  }
  if (typeof KFOApp !== 'undefined') {
    try {
      var kfoFields = KFOApp.storedFields();
      Object.keys(kfoFields).forEach(function (k) { data[k] = kfoFields[k]; });
    } catch (e) { console.warn('kfo autosave fields skipped:', e.message); }
  }

  try {
    var ref = await esLabs.db.collection('users').doc(currentUser.uid).collection('analyses').add(data);
    return ref.id;
  } catch (e) {
    console.warn('autosave before checkout failed:', e.message);
    return null;
  }
}

function maybeResumeAfterCheckout() {
  try {
    var id = localStorage.getItem('esformlab_resume_id');
    if (!id) return;
    var found = (savedAnalysesList || []).find(function (a) { return a.id === id; });
    if (!found) return; // list not ready -- next call will pick it up
    localStorage.removeItem('esformlab_resume_id');
    viewSavedAnalysis(id);
  } catch (e) {
    console.warn('resume after checkout failed:', e.message);
  }
}

// -- esFormLab-specific nav button visibility ---------------------
//
// The shared nav (esLabs.mountNav) handles the auth pill, sign-in
// button, and the responsive hamburger. This function only toggles
// the visibility of the esFormLab-specific extras inside the nav --
// "My Sessions" button, in-page Save button -- plus the in-page
// sign-in-to-save CTA.
function updateAuthUI() {
  var myAnalysesBtn = document.getElementById('btn-my-analyses');
  var saveBtn = document.getElementById('btn-save');
  var signInSaveBtn = document.getElementById('btn-sign-in-save');
  var mobileMyAnalyses = document.getElementById('nav-mobile-my-analyses');

  if (currentUser) {
    if (myAnalysesBtn) myAnalysesBtn.style.display = 'inline-flex';
    if (mobileMyAnalyses) mobileMyAnalyses.style.display = 'block';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    if (signInSaveBtn) signInSaveBtn.style.display = 'none';
  } else {
    if (myAnalysesBtn) myAnalysesBtn.style.display = 'none';
    if (mobileMyAnalyses) mobileMyAnalyses.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'none';
    if (signInSaveBtn) signInSaveBtn.style.display = 'inline-flex';
  }
  eflUpdateOwnedUI();
}
