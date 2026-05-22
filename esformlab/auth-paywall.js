// ════════════════════════════════════════════════════════════════
// Firebase init + auth + Stripe paywall for esFormLab.
//
// Extracted from the main esformlab/index.html inline <script>.
// Owns: initFirebase, initAuth, sign-in/out, email auth, Stripe
// 90-day pass checkout, the three pass-source watchers, and the
// applyPaywallState / updateAuthUI DOM updaters.
//
// State declared here (emailAuthMode, STRIPE_PRICE_ID,
// PASS_DURATION_SEC, hasPaidPass_, hasGrantedPass_,
// hasPremiumCoach_, paymentsUnsub_, userDocPassUnsub_,
// coachingSubsUnsub_, COACHING_PREMIUM_PRICE_ID) becomes window-
// global so the main inline script can still read it.
//
// Referenced globals that stay in the main script: FIREBASE_CONFIG,
// firebase, currentUser, auth2, selectedSex, phases, lastIssues,
// liveRanges, MIN_N, PHASE_DEFS, METRIC_ROWS, isRelevant,
// savedAnalysesList, setSex, viewSavedAnalysis, loadAnalysesList,
// upgradeEsMetLabNav, updateRangesStatus, getDetectionQuality.
// ════════════════════════════════════════════════════════════════

// -- Firebase + range fetching --
async function initFirebase() {
  try {
    if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') return;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    var db = firebase.firestore();
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
  } catch(e) { console.warn('esFormLab: could not fetch live ranges.', e.message); }
}

function initAuth() {
  auth2 = firebase.auth();
  auth2.onAuthStateChanged(async function(user) {
    currentUser = user;
    updateAuthUI();
    watchPaymentsForPass();
    upgradeEsMetLabNav(user);
    if (user) {
      await loadAnalysesList();
      loadUserProfile(user.uid);
      maybeResumeAfterCheckout();
    }
  });
}

function loadUserProfile(uid) {
  try {
    var db = firebase.firestore();
    db.collection('users').doc(uid).get().then(function(doc) {
      if (doc.exists) {
        var data = doc.data();
        if (data.gender && (data.gender === 'male' || data.gender === 'female') && !selectedSex) {
          setSex(data.gender);
        }
      }
    }).catch(function(e) {
      console.warn('Could not load user profile:', e.message);
    });
  } catch(e) {
    console.warn('loadUserProfile error:', e.message);
  }
}

function signInWithGoogle() {
  if (!auth2) return;
  var provider = new firebase.auth.GoogleAuthProvider();
  auth2.signInWithPopup(provider).catch(function(e) {
    console.error('Sign-in failed:', e.message);
  });
}

// -- Email / password auth (collapsible secondary option) --
var emailAuthMode = 'signup';

function toggleEmailAuth() {
  var form = document.getElementById('sg-email-form');
  var btn = document.getElementById('sg-email-toggle-btn');
  var label = document.getElementById('sg-email-toggle-label');
  if (!form || !btn || !label) return;
  var open = form.style.display !== 'none';
  if (open) {
    form.style.display = 'none';
    btn.classList.remove('open');
    label.textContent = 'Or sign up with email instead';
  } else {
    form.style.display = 'block';
    btn.classList.add('open');
    label.textContent = 'Hide email signup';
    setTimeout(function(){ var e = document.getElementById('sg-email'); if(e) e.focus(); }, 60);
  }
}

function setEmailAuthMode(mode) {
  emailAuthMode = (mode === 'signin') ? 'signin' : 'signup';
  var tabs = document.querySelectorAll('.sg-mode-tab');
  for (var i=0;i<tabs.length;i++){
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === emailAuthMode);
  }
  var submit = document.getElementById('sg-email-submit');
  if (submit) submit.textContent = (emailAuthMode === 'signup') ? 'Create account' : 'Sign in';
  var pw = document.getElementById('sg-password');
  if (pw) {
    pw.setAttribute('autocomplete', emailAuthMode === 'signup' ? 'new-password' : 'current-password');
    pw.placeholder = emailAuthMode === 'signup' ? 'Password (6+ characters)' : 'Password';
  }
  var forgot = document.getElementById('sg-forgot-btn');
  if (forgot) forgot.style.display = (emailAuthMode === 'signin') ? 'block' : 'none';
  clearEmailAuthError();
}

function clearEmailAuthError() {
  var err = document.getElementById('sg-email-error');
  if (!err) return;
  err.style.display = 'none';
  err.classList.remove('success');
  err.textContent = '';
}

function showEmailAuthError(msg, isSuccess) {
  var err = document.getElementById('sg-email-error');
  if (!err) return;
  err.textContent = msg;
  err.classList.toggle('success', !!isSuccess);
  err.style.display = 'block';
}

function friendlyAuthError(e) {
  if (!e) return 'Something went wrong. Please try again.';
  var code = e.code || '';
  if (code === 'auth/email-already-in-use') return 'An account already exists with that email. Switch to Sign in.';
  if (code === 'auth/invalid-email')        return 'That email address does not look valid.';
  if (code === 'auth/weak-password')        return 'Password too weak. Use at least 6 characters.';
  if (code === 'auth/wrong-password' ||
      code === 'auth/invalid-credential' ||
      code === 'auth/invalid-login-credentials') return 'Email or password is wrong. Try again or reset your password.';
  if (code === 'auth/user-not-found')       return 'No account with that email. Create one with the Create account tab instead.';
  if (code === 'auth/user-disabled')        return 'This account has been disabled. Contact support.';
  if (code === 'auth/too-many-requests')    return 'Too many attempts. Please wait a minute and try again.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  return e.message || 'Sign-in failed. Please try again.';
}

function submitEmailAuth() {
  if (!auth2) return;
  var emailEl = document.getElementById('sg-email');
  var pwEl = document.getElementById('sg-password');
  var submit = document.getElementById('sg-email-submit');
  if (!emailEl || !pwEl || !submit) return;
  var email = emailEl.value.trim();
  var pw = pwEl.value;
  if (!email || !pw) {
    showEmailAuthError('Please enter both your email and a password.');
    return;
  }
  if (emailAuthMode === 'signup' && pw.length < 6) {
    showEmailAuthError('Password must be at least 6 characters.');
    return;
  }
  clearEmailAuthError();
  submit.disabled = true;
  var origLabel = (emailAuthMode === 'signup') ? 'Create account' : 'Sign in';
  submit.textContent = (emailAuthMode === 'signup') ? 'Creating account...' : 'Signing in...';
  var p = (emailAuthMode === 'signup')
    ? auth2.createUserWithEmailAndPassword(email, pw)
    : auth2.signInWithEmailAndPassword(email, pw);
  p.then(function(){
    // onAuthStateChanged handles UI from here.
    pwEl.value = '';
  }).catch(function(e){
    submit.disabled = false;
    submit.textContent = origLabel;
    showEmailAuthError(friendlyAuthError(e));
  });
}

function sendPasswordReset() {
  if (!auth2) return;
  var emailEl = document.getElementById('sg-email');
  if (!emailEl) return;
  var email = emailEl.value.trim();
  if (!email) {
    showEmailAuthError('Type your email in the field above first, then click Forgot password.');
    return;
  }
  auth2.sendPasswordResetEmail(email).then(function(){
    showEmailAuthError('Password reset email sent. Check your inbox (and spam folder).', true);
  }).catch(function(e){
    showEmailAuthError(friendlyAuthError(e));
  });
}

function signOutUser() {
  if (!auth2) return;
  auth2.signOut().then(function() {
    currentUser = null;
    savedAnalysesList = [];
    updateAuthUI();
    if (paymentsUnsub_) { paymentsUnsub_(); paymentsUnsub_ = null; }
    if (userDocPassUnsub_) { userDocPassUnsub_(); userDocPassUnsub_ = null; }
    if (coachingSubsUnsub_) { coachingSubsUnsub_(); coachingSubsUnsub_ = null; }
    hasPaidPass_ = false;
    hasGrantedPass_ = false;
    hasPremiumCoach_ = false;
    applyPaywallState();
  });
}

// ──────────────────────────────────────────────────────────────
//  Stripe paywall: 90-day pass
// ──────────────────────────────────────────────────────────────
// Live-mode price ID. To smoke-test in test mode, swap to a test price
// AND swap the extension config (API key + webhook secret) back to test.
var STRIPE_PRICE_ID = 'price_1TVIadIFO8pppwnFTfqv3CCh';
var PASS_DURATION_SEC = 90 * 24 * 60 * 60;

// Three independent sources of access:
//   hasPaidPass_      -- a Stripe-succeeded payment within the last 90 days
//   hasGrantedPass_   -- admin-set users/{uid}.formAnalyzerPassUntil > now
//                        OR users/{uid}.features.esFormLab === true
//   hasPremiumCoach_  -- active Premium ($245/mo) coaching subscription,
//                        which bundles esFormLab access at no extra cost
var hasPaidPass_ = false;
var hasGrantedPass_ = false;
var hasPremiumCoach_ = false;
var paymentsUnsub_ = null;
var userDocPassUnsub_ = null;
var coachingSubsUnsub_ = null;
// Live Premium coaching price ID -- mirror of coaching/index.html constant.
var COACHING_PREMIUM_PRICE_ID = 'price_1TVJJuIFO8pppwnF5uECviT3';

function watchPaymentsForPass() {
  if (paymentsUnsub_) { paymentsUnsub_(); paymentsUnsub_ = null; }
  if (userDocPassUnsub_) { userDocPassUnsub_(); userDocPassUnsub_ = null; }
  if (coachingSubsUnsub_) { coachingSubsUnsub_(); coachingSubsUnsub_ = null; }
  if (!currentUser) {
    hasPaidPass_ = false;
    hasGrantedPass_ = false;
    hasPremiumCoach_ = false;
    applyPaywallState();
    return;
  }
  var db = firebase.firestore();
  paymentsUnsub_ = db.collection('customers').doc(currentUser.uid)
    .collection('payments').onSnapshot(function(snap) {
      hasPaidPass_ = computeActivePass(snap.docs);
      applyPaywallState();
    }, function(err) {
      console.warn('payments snapshot error:', err.message);
    });
  userDocPassUnsub_ = db.collection('users').doc(currentUser.uid)
    .onSnapshot(function(snap) {
      hasGrantedPass_ = computeGrantedPass(snap.exists ? snap.data() : null);
      applyPaywallState();
    }, function(err) {
      console.warn('user doc snapshot error:', err.message);
    });
  coachingSubsUnsub_ = db.collection('customers').doc(currentUser.uid)
    .collection('subscriptions').onSnapshot(function(snap) {
      hasPremiumCoach_ = computePremiumCoachingSub(snap.docs);
      applyPaywallState();
    }, function(err) {
      console.warn('coaching subscription snapshot error:', err.message);
    });
}

function computePremiumCoachingSub(docs) {
  for (var i = 0; i < docs.length; i++) {
    var sub = docs[i].data();
    if (sub.status !== 'active' && sub.status !== 'trialing') continue;
    var ids = [];
    if (Array.isArray(sub.items)) {
      for (var j = 0; j < sub.items.length; j++) {
        var it = sub.items[j];
        if (it.price && typeof it.price.id === 'string') ids.push(it.price.id);
        else if (typeof it.price === 'string') ids.push(it.price);
      }
    }
    if (Array.isArray(sub.prices)) {
      for (var k = 0; k < sub.prices.length; k++) {
        var p = sub.prices[k];
        if (p && typeof p.id === 'string') ids.push(p.id);
      }
    }
    if (ids.indexOf(COACHING_PREMIUM_PRICE_ID) !== -1) return true;
  }
  return false;
}

function computeActivePass(docs) {
  var nowSec = Math.floor(Date.now() / 1000);
  for (var i = 0; i < docs.length; i++) {
    var p = docs[i].data();
    if (p.status !== 'succeeded') continue;
    var c = p.created;
    var createdSec = (typeof c === 'number') ? c
      : (c && typeof c.seconds === 'number') ? c.seconds
      : null;
    if (createdSec === null) continue;
    if (nowSec - createdSec < PASS_DURATION_SEC) return true;
  }
  return false;
}

// Admin grant — two independent ways to comp access on the user doc:
//   features.esFormLab === true: boolean toggle in the coaching admin
//                                Feature Access modal (no expiration)
//   formAnalyzerPassUntil: Firestore Timestamp / numeric seconds for a
//                          time-bounded grant set directly in Firestore
function computeGrantedPass(userData) {
  if (!userData) return false;
  if (userData.features && userData.features.esFormLab === true) return true;
  var until = userData.formAnalyzerPassUntil;
  if (!until) return false;
  var untilSec = (typeof until === 'number') ? until
    : (until && typeof until.seconds === 'number') ? until.seconds
    : null;
  if (untilSec === null) return false;
  return untilSec > Math.floor(Date.now() / 1000);
}

function effectiveHasPass() {
  return hasPaidPass_ || hasGrantedPass_ || hasPremiumCoach_;
}

function applyPaywallState() {
  var locked = document.getElementById('report-locked-content');
  var summary = document.getElementById('summary-section');
  var coachingCta = document.getElementById('coaching-cta-section');
  var footnotes = document.getElementById('report-footnotes');
  var paywall = document.getElementById('paywall-card');
  var anomalyBanner = document.getElementById('anomaly-banner');
  if (effectiveHasPass()) {
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
    // Only display the anomaly banner once renderAnomalyBanner has populated it.
    if (anomalyBanner && anomalyBanner.getAttribute('data-populated') === '1') {
      anomalyBanner.style.display = 'flex';
    }
  }
}

async function openCustomerPortal() {
  if (!currentUser) { signInWithGoogle(); return; }
  try {
    var fns = firebase.app().functions('us-central1');
    var createPortalLink = fns.httpsCallable('ext-firestore-stripe-payments-createPortalLink');
    var result = await createPortalLink({ returnUrl: window.location.href });
    var url = result && result.data && result.data.url;
    if (url) {
      window.location.assign(url);
    } else {
      alert('Could not open the subscription portal. Please try again.');
    }
  } catch (e) {
    console.error('Customer portal error:', e);
    alert('Could not open the subscription portal: ' + (e.message || e));
  }
}

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

    var db = firebase.firestore();
    var ref = await db.collection('customers').doc(currentUser.uid)
      .collection('checkout_sessions').add({
        mode: 'payment',
        price: STRIPE_PRICE_ID,
        success_url: window.location.origin + '/esformlab/?paid=1',
        cancel_url: window.location.href,
        allow_promotion_codes: true,
      });
    ref.onSnapshot(function(snap) {
      var data = snap.data();
      if (!data) return;
      if (data.error) {
        alert('Checkout error: ' + data.error.message);
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      }
      if (data.url) {
        window.location.assign(data.url);
      }
    });
  } catch (e) {
    console.error('startPassCheckout error:', e);
    alert('Could not start checkout: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

async function autosaveAnalysisForResume() {
  if (!currentUser) return null;
  var hasData = PHASE_DEFS.some(function(d) { return phases[d.key] && phases[d.key].metrics; });
  if (!hasData) return null;
  var now = new Date();
  var data = {
    name: 'Pre-checkout autosave',
    date: now.toISOString().slice(0, 10),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    sex: selectedSex,
    phases: {},
    issues: lastIssues || {},
    autosave: true,
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
    if (ph.frontBackMetrics) entry.frontBackMetrics = ph.frontBackMetrics;
    var q = ph.kps ? getDetectionQuality(ph.kps) : null;
    entry.quality = q ? q.level : null;
    data.phases[def.key] = entry;
  });
  try {
    var db = firebase.firestore();
    var ref = await db.collection('users').doc(currentUser.uid).collection('analyses').add(data);
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
    var found = (savedAnalysesList || []).find(function(a) { return a.id === id; });
    if (!found) return; // list not ready -- next call will pick it up
    localStorage.removeItem('esformlab_resume_id');
    viewSavedAnalysis(id);
  } catch (e) {
    console.warn('resume after checkout failed:', e.message);
  }
}

function updateAuthUI() {
  var indicator = document.getElementById('auth-indicator');
  var nameEl = document.getElementById('auth-name');
  var avatarEl = document.getElementById('auth-avatar');
  var signOutBtn = document.getElementById('btn-sign-out');
  var myAnalysesBtn = document.getElementById('btn-my-analyses');
  var saveBtn = document.getElementById('btn-save');
  var signInSaveBtn = document.getElementById('btn-sign-in-save');
  var signinGate = document.getElementById('signin-gate');

  // Mobile menu auth elements
  var mUserRow = document.getElementById('nav-mobile-user-row');
  var mAvatar = document.getElementById('nav-mobile-avatar');
  var mName = document.getElementById('nav-mobile-name');
  var mSignIn = document.getElementById('nav-mobile-signin');
  var mSignOut = document.getElementById('nav-mobile-signout');
  var mMyAnalyses = document.getElementById('nav-mobile-my-analyses');

  function setName(text) {
    if (nameEl) nameEl.textContent = text;
    if (mName) mName.textContent = text;
  }

  if (currentUser) {
    if (indicator) indicator.style.display = 'inline-flex';
    var photoURL = currentUser.photoURL || (currentUser.providerData && currentUser.providerData[0] ? currentUser.providerData[0].photoURL : null);
    if (avatarEl && photoURL) { avatarEl.src = photoURL; avatarEl.style.display = 'block'; }
    if (mAvatar && photoURL) { mAvatar.src = photoURL; }
    // Try Auth displayName first, then fetch from Firestore user doc
    var authName = currentUser.displayName || (currentUser.providerData && currentUser.providerData[0] ? currentUser.providerData[0].displayName : null);
    if (authName) {
      setName(authName);
    } else {
      setName('Loading...');
      firebase.firestore().collection('users').doc(currentUser.uid).get().then(function(doc) {
        if (doc.exists && doc.data().displayName) {
          setName(doc.data().displayName);
        } else {
          setName(currentUser.email ? currentUser.email.split('@')[0] : 'User');
        }
      }).catch(function() {
        setName(currentUser.email ? currentUser.email.split('@')[0] : 'User');
      });
    }
    if (signOutBtn) signOutBtn.style.display = 'inline-flex';
    if (myAnalysesBtn) myAnalysesBtn.style.display = 'inline-flex';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    if (signInSaveBtn) signInSaveBtn.style.display = 'none';
    if (mUserRow) mUserRow.style.display = 'flex';
    if (mSignIn) mSignIn.style.display = 'none';
    if (mSignOut) mSignOut.style.display = 'block';
    if (mMyAnalyses) mMyAnalyses.style.display = 'block';
    if (signinGate) signinGate.style.display = 'none';
  } else {
    if (indicator) indicator.style.display = 'none';
    if (signOutBtn) signOutBtn.style.display = 'none';
    if (myAnalysesBtn) myAnalysesBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'none';
    if (signInSaveBtn) signInSaveBtn.style.display = 'inline-flex';
    if (mUserRow) mUserRow.style.display = 'none';
    if (mSignIn) mSignIn.style.display = 'block';
    if (mSignOut) mSignOut.style.display = 'none';
    if (mMyAnalyses) mMyAnalyses.style.display = 'none';
    if (signinGate) signinGate.style.display = 'flex';
  }
}
