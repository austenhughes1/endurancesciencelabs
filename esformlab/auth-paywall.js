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
function signInWithGoogle() { esLabs.signInGoogle(); }
function signOutUser() { esLabs.signOut(); }
function openCustomerPortal() { return esLabs.openCustomerPortal(); }

// Wire auth + pass state from the shared module to esFormLab's DOM.
esLabs.onAuthChange(async function (user) {
  currentUser = user;
  updateAuthUI();
  if (user) {
    await loadAnalysesList();
    loadUserProfile(user.uid);
    maybeResumeAfterCheckout();
  } else {
    savedAnalysesList = [];
  }
});

esLabs.onPassChange(function () { applyPaywallState(); });

// -- Paywall blur toggle ------------------------------------------
function applyPaywallState() {
  var locked = document.getElementById('report-locked-content');
  var summary = document.getElementById('summary-section');
  var coachingCta = document.getElementById('coaching-cta-section');
  var footnotes = document.getElementById('report-footnotes');
  var paywall = document.getElementById('paywall-card');
  var anomalyBanner = document.getElementById('anomaly-banner');
  if (esLabs.getPassState().unlocked) {
    if (locked) locked.classList.remove('paywall-blur');
    if (summary) summary.classList.remove('paywall-blur');
    if (coachingCta) coachingCta.classList.remove('paywall-blur');
    if (footnotes) footnotes.classList.remove('paywall-blur');
    if (paywall) paywall.style.display = 'none';
    if (anomalyBanner) anomalyBanner.style.display = 'none';
  } else {
    if (locked) locked.classList.add('paywall-blur');
    if (summary) summary.classList.add('paywall-blur');
    if (coachingCta) coachingCta.classList.add('paywall-blur');
    if (footnotes) footnotes.classList.add('paywall-blur');
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
  if (!currentUser) return null;
  var hasData = PHASE_DEFS.some(function (d) { return phases[d.key] && phases[d.key].metrics; });
  if (!hasData) return null;
  var now = new Date();
  var data = {
    name: 'Pre-checkout autosave',
    date: now.toISOString().slice(0, 10),
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

  if (currentUser) {
    if (myAnalysesBtn) myAnalysesBtn.style.display = 'inline-flex';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    if (signInSaveBtn) signInSaveBtn.style.display = 'none';
  } else {
    if (myAnalysesBtn) myAnalysesBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'none';
    if (signInSaveBtn) signInSaveBtn.style.display = 'inline-flex';
  }
}
