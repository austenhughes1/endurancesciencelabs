// ════════════════════════════════════════════════════════════════
// admin/users/app.js
//
// "Manage Users" — admin-only console for the Endurance Science Labs
// site. Lists every user, with search / role / coach filters and
// sortable columns, and lets the admin:
//   - assign an athlete to a coach (users/{uid}.coachUid). Assigning
//     moves the athlete's existing training plan to the new coach,
//     closes a pending coaching request and tells the athlete (D8).
//   - switch a user's role between athlete and coach (users/{uid}.role)
//   - toggle feature access (users/{uid}.features.{feature})
//   - disconnect a user's Strava (deauthorizeStrava with athleteUid —
//     the function only honors athleteUid when the caller is the admin)
//   - permanently delete a user (adminDeleteUser — removes their data
//     and their sign-in account; refused while a Stripe sub is active)
//
// Access is gated two ways:
//   1. The shared sign-in gate is mounted with requireAdmin:true, so a
//      non-admin never sees the app shell.
//   2. Firestore rules only allow the admin UID to read the full users
//      collection and write to arbitrary user docs, so this is the real
//      enforcement — the gate is just UX.
//
// Row controls use delegated listeners on #mu-body (data-* attributes
// carry the escaped ids); the window.mu* functions stay as entry points.
// ════════════════════════════════════════════════════════════════
'use strict';

var db = esLabs.db;

var FEATURE_LIST   = ['coaching', 'lifting', 'esFormLab', 'esMetabolicLab'];
var FEATURE_LABELS = { coaching: 'Coaching', lifting: 'Lifting', esFormLab: 'esFormLab', esMetabolicLab: 'esMetabolicLab' };

// Strava's single-app athlete cap (the app is limited to this many
// connected athletes until Strava raises it).
var STRAVA_ATHLETE_CAP = 10;

// Official Strava mountain logo (per Strava brand guidelines — use as-is,
// never recreate). Same asset the coaching dashboard uses.
var STRAVA_LOGO_SVG = '<svg class="strava-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>';

// Sortable columns: key -> how to extract a comparable value from a user.
var COLUMNS = [
  { key: 'name',     label: 'User',          sortable: true },
  { key: 'role',     label: 'Role',          sortable: true },
  { key: 'coach',    label: 'Coach &amp; coaching', sortable: true },
  { key: 'feats',    label: 'Access grants', sortable: false },
  { key: 'strava',   label: 'Strava',        sortable: true },
  { key: 'joined',   label: 'Joined',        sortable: true }
];
var NCOLS = COLUMNS.length;

// ── State ────────────────────────────────────────────────────────
var allUsers = [];          // [{ id, data }]
var coachMap = {};          // uid -> displayName/email (role === 'coach')
var pendingReq = {};        // athleteUid -> true (pending request to the admin)
var filters = { search: '', role: 'all', coach: 'all', strava: false };
var sort = { key: 'name', dir: 'asc' };
var loaded = false;

// ── Auth / gate ──────────────────────────────────────────────────
esLabs.mountNav('#mu-nav', { active: '' });

esLabs.mountAuthGate('#mu-gate', {
  eyebrow: '◉ Admin',
  headline: 'Manage Users',
  sub: 'This console is restricted to the Endurance Science Labs admin account. Sign in to continue.',
  microcopy: 'Admin account only',
  requireAdmin: true,
  emailDefault: 'signin',
  foot: '<a href="/account/">&larr; Back to my account</a>'
});

esLabs.onAuthChange(function (user) {
  var app = document.getElementById('mu-app');
  if (!app) return;
  // realUid keeps the console usable while an act-as session is active
  // (the listener hands us the stand-in user in that case).
  if (user && (user.realUid || user.uid) === esLabs.ADMIN_UID) {
    app.classList.add('show');
    if (!loaded) loadUsers();
  } else {
    app.classList.remove('show');
  }
});

// ── Load ─────────────────────────────────────────────────────────
// Preferred path: the admin-only `listAllUsers` Cloud Function, which
// merges every Firebase Auth account with its Firestore users/{uid} doc
// (if any). The client SDK can't enumerate Auth, and docs are created
// lazily, so a plain users-collection query misses anyone who only ever
// used the public tools. Fall back to that query if the function isn't
// deployed yet.
function setTableBusy(on) {
  var t = document.getElementById('mu-table');
  if (!t) return;
  if (on) t.setAttribute('aria-busy', 'true'); else t.removeAttribute('aria-busy');
}

function loadUsers() {
  var body = document.getElementById('mu-body');
  body.innerHTML = '<tr><td colspan="' + NCOLS + '"><div class="esl-loading" role="status"><span class="esl-spin" aria-hidden="true"></span>Loading users…</div></td></tr>';
  setTableBusy(true);
  document.getElementById('mu-notice').innerHTML = '';

  var fns = esLabs.firebase.app().functions('us-central1');
  fns.httpsCallable('listAllUsers')().then(function (res) {
    var list = (res && res.data && res.data.users) || [];
    allUsers = list.map(function (u) {
      return {
        id: u.uid,
        data: {
          email: u.email, displayName: u.displayName, photoURL: u.photoURL,
          role: u.role, coachUid: u.coachUid, features: u.features || {},
          createdAt: u.createdAt, lastSignInAt: u.lastSignInAt,
          hasDoc: u.hasDoc, hasAuth: u.hasAuth, disabled: u.disabled,
          stravaConnected: u.stravaConnected === true,
          // Optional server fields (D12 #12): listAllUsers returns
          // coachingTier "Full Access" | "Standard" | null, coachingStatus
          // ("active" | "trialing" | "past_due") and coachingRequestPending.
          // Absent on an older deployment — the page then falls back to
          // grants + the admin's own pending-request query.
          coachingTier: tierKey(u.coachingTier),
          coachingStatus: u.coachingStatus || null,
          pendingRequest: u.coachingRequestPending === true
        }
      };
    });
    finishLoad();
  }).catch(function (e) {
    console.warn('listAllUsers unavailable, falling back to direct query:', e && e.message);
    db.collection('users').get().then(function (snap) {
      allUsers = [];
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        d.hasDoc = true;
        allUsers.push({ id: doc.id, data: d });
      });
      finishLoad();
      document.getElementById('mu-notice').innerHTML = ''
        + '<div class="esl-callout esl-callout--warn" role="status">'
        + '<p class="esl-callout-title">Showing Firestore profiles only</p>'
        + 'listAllUsers isn’t available, so sign-ups without a profile are missing from this list.'
        + '</div>';
    }).catch(function (e2) {
      console.error('Manage Users load failed:', e2);
      setTableBusy(false);
      body.innerHTML = '<tr><td colspan="' + NCOLS + '">'
        + '<div class="esl-callout esl-callout--bad" role="alert">'
        + '<p class="esl-callout-title">Couldn’t load users</p>'
        + '<p class="mu-error-text">' + esc(e2.message || 'Unknown error') + '</p>'
        + '<button type="button" class="esl-btn esl-btn--outline esl-btn--sm" data-mu-retry>Retry</button>'
        + '</div></td></tr>';
    });
  });
}
window.muRetryLoad = loadUsers;

function finishLoad() {
  loaded = true;
  setTableBusy(false);
  rebuildCoachMap();
  populateCoachFilter();
  render();
  loadPendingRequests();
}

// Pending coaching requests are addressed to the admin, so the admin can
// list them (rules: coachUid == auth.uid). Used for the Coaching column,
// "Awaiting a coach" and to close a request when assigning a coach.
function loadPendingRequests() {
  db.collection('coachingRequests')
    .where('coachUid', '==', esLabs.ADMIN_UID)
    .where('status', '==', 'pending')
    .get().then(function (snap) {
      pendingReq = {};
      snap.forEach(function (doc) {
        var r = doc.data() || {};
        if (r.athleteUid) pendingReq[r.athleteUid] = true;
      });
      render();
    }).catch(function (e) {
      console.warn('pending requests:', e && e.message);
    });
}

function rebuildCoachMap() {
  coachMap = {};
  allUsers.forEach(function (u) {
    if (u.data.role === 'coach') {
      coachMap[u.id] = u.data.displayName || u.data.email || u.id;
    }
  });
}

// ── Toolbar wiring ───────────────────────────────────────────────
function populateCoachFilter() {
  var sel = document.getElementById('mu-coach-filter');
  var coaches = sortedCoaches();
  var html = '<option value="all">All</option><option value="unassigned">Unassigned</option><option value="awaiting">Awaiting a coach</option>';
  coaches.forEach(function (c) {
    html += '<option value="' + esc(c.uid) + '">' + esc(c.label) + '</option>';
  });
  sel.innerHTML = html;
  // Keep the current selection if still valid, else reset.
  if (filters.coach !== 'all' && filters.coach !== 'unassigned' && filters.coach !== 'awaiting' && !coachMap[filters.coach]) {
    filters.coach = 'all';
  }
  sel.value = filters.coach;
}

function sortedCoaches() {
  return Object.keys(coachMap)
    .map(function (uid) { return { uid: uid, label: coachMap[uid] }; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });
}

document.getElementById('mu-search-input').addEventListener('input', function (e) {
  filters.search = e.target.value.trim().toLowerCase();
  render();
});
document.getElementById('mu-role-filter').addEventListener('change', function (e) {
  filters.role = e.target.value;
  render();
});
document.getElementById('mu-coach-filter').addEventListener('change', function (e) {
  filters.coach = e.target.value;
  render();
});
document.getElementById('mu-clear-btn').addEventListener('click', clearFilters);

function clearFilters() {
  filters = { search: '', role: 'all', coach: 'all', strava: false };
  document.getElementById('mu-search-input').value = '';
  document.getElementById('mu-role-filter').value = 'all';
  document.getElementById('mu-coach-filter').value = 'all';
  render();
}

// Stat tiles double as filters; clicking the active one clears it.
document.getElementById('mu-stats').addEventListener('click', function (e) {
  var b = e.target.closest('[data-stat-filter]');
  if (!b) return;
  var f = b.getAttribute('data-stat-filter');
  var on = b.getAttribute('aria-pressed') === 'true';
  if (f === 'total') { clearFilters(); focusStat(f); return; }
  if (f === 'coach' || f === 'athlete') {
    filters.role = on ? 'all' : f;
    document.getElementById('mu-role-filter').value = filters.role;
  } else if (f === 'awaiting') {
    filters.coach = on ? 'all' : 'awaiting';
    document.getElementById('mu-coach-filter').value = filters.coach;
  } else if (f === 'strava') {
    filters.strava = !on;
  }
  render();
  focusStat(f);
});
function focusStat(f) {
  var b = document.querySelector('[data-stat-filter="' + f + '"]');
  if (b) b.focus();
}

// ── Coaching status helpers ──────────────────────────────────────
function tierKey(t) {
  if (t === 'Full Access' || t === 'premium') return 'premium';
  if (t === 'Standard' || t === 'standard') return 'standard';
  return null;
}
function hasLiveCoach(d) { return !!(d.coachUid && coachMap[d.coachUid]); }
function isPending(u) { return u.data.pendingRequest === true || pendingReq[u.id] === true; }
function isCoachRole(d) { return d.role === 'coach'; }
// Wants a coach but has none: a coaching subscription (when the server
// reports it), a coaching grant, or a pending request.
function isAwaiting(u) {
  var d = u.data;
  if (isCoachRole(d) || hasLiveCoach(d)) return false;
  return !!(d.coachingTier || (d.features && d.features.coaching === true) || isPending(u));
}
// Coaching status chips shown under the coach select: subscription tier
// (when the server reports it) or a grant, plus "Request pending".
function statusChips(u) {
  var d = u.data;
  var chips = '';
  if (d.coachingTier === 'premium') chips += '<span class="esl-badge esl-badge--good">Full Access</span>';
  else if (d.coachingTier === 'standard') chips += '<span class="esl-badge esl-badge--good">Standard</span>';
  else if (d.features && d.features.coaching === true) chips += '<span class="esl-badge esl-badge--accent">Granted</span>';
  if (d.coachingTier && d.coachingStatus === 'past_due') chips += '<span class="esl-badge esl-badge--warn">Payment failed</span>';
  if (isPending(u) && !hasLiveCoach(d)) chips += '<span class="esl-badge esl-badge--warn">Request pending</span>';
  return chips;
}

// ── Filtering + sorting ──────────────────────────────────────────
function visibleUsers() {
  var out = allUsers.filter(function (u) {
    var d = u.data;
    var role = isCoachRole(d) ? 'coach' : 'athlete';
    if (filters.role !== 'all' && role !== filters.role) return false;
    if (filters.coach === 'unassigned' && (role === 'coach' || hasLiveCoach(d))) return false;
    if (filters.coach === 'awaiting' && !isAwaiting(u)) return false;
    if (filters.coach !== 'all' && filters.coach !== 'unassigned' && filters.coach !== 'awaiting' && d.coachUid !== filters.coach) return false;
    if (filters.strava && !d.stravaConnected) return false;
    if (filters.search) {
      var hay = ((d.displayName || '') + ' ' + (d.email || '')).toLowerCase();
      if (hay.indexOf(filters.search) === -1) return false;
    }
    return true;
  });

  out.sort(function (a, b) {
    var va = sortValue(a), vb = sortValue(b);
    if (va < vb) return sort.dir === 'asc' ? -1 : 1;
    if (va > vb) return sort.dir === 'asc' ? 1 : -1;
    return 0;
  });
  return out;
}

function sortValue(u) {
  var d = u.data;
  switch (sort.key) {
    case 'role':     return isCoachRole(d) ? 'coach' : 'athlete';
    case 'coach':    return (coachMap[d.coachUid] || '￿').toLowerCase(); // unassigned sorts last
    case 'strava':   return d.stravaConnected ? 0 : 1; // connected sorts first (asc)
    case 'joined':   return createdSeconds(d.createdAt) || 0;
    case 'name':
    default:         return (d.displayName || d.email || '').toLowerCase();
  }
}

function setSort(key) {
  if (sort.key === key) {
    sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sort.key = key;
    sort.dir = 'asc';
  }
  render();
  var b = document.querySelector('.mu-sort-btn[data-sort="' + key + '"]');
  if (b) b.focus();
}
window.muSetSort = setSort;

document.getElementById('mu-head-row').addEventListener('click', function (e) {
  var b = e.target.closest('.mu-sort-btn[data-sort]');
  if (b) setSort(b.getAttribute('data-sort'));
});

// ── Render ───────────────────────────────────────────────────────
function render() {
  if (!loaded) return;
  renderStats();
  renderHead();
  renderBody();
}

function renderStats() {
  var total = allUsers.length;
  var coaches = 0, athletes = 0, awaiting = 0, strava = 0;
  allUsers.forEach(function (u) {
    if (isCoachRole(u.data)) coaches++;
    else athletes++;
    if (isAwaiting(u)) awaiting++;
    if (u.data.stravaConnected) strava++;
  });
  var noFilter = !filters.search && filters.role === 'all' && filters.coach === 'all' && !filters.strava;
  var stravaCls = strava >= STRAVA_ATHLETE_CAP ? ' at-cap' : (strava >= STRAVA_ATHLETE_CAP - 2 ? ' near-cap' : '');
  document.getElementById('mu-stats').innerHTML =
      stat('total', 'total', total, 'Total users', noFilter)
    + stat('coaches', 'coach', coaches, 'Coaches', filters.role === 'coach')
    + stat('athletes', 'athlete', athletes, 'Athletes', filters.role === 'athlete')
    + stat('awaiting', 'awaiting', awaiting, 'Awaiting a coach', filters.coach === 'awaiting', awaiting ? 'has-some' : '')
    + stat('strava' + stravaCls, 'strava', strava + '<span class="mu-stat-of"> / ' + STRAVA_ATHLETE_CAP + '</span>', 'Strava connected', filters.strava, '',
        strava + ' of ' + STRAVA_ATHLETE_CAP + ' Strava connections used');
}
function stat(cls, filter, num, label, pressed, numCls, ariaLabel) {
  return '<button type="button" class="mu-stat ' + cls + '" data-stat-filter="' + filter + '" aria-pressed="' + (pressed ? 'true' : 'false') + '"'
       + (ariaLabel ? ' aria-label="' + esc(ariaLabel) + '"' : '') + '>'
       + '<span class="mu-stat-label">' + label + '</span>'
       + '<span class="mu-stat-num' + (numCls ? ' ' + numCls : '') + '">' + num + '</span></button>';
}

function renderHead() {
  var row = document.getElementById('mu-head-row');
  row.innerHTML = COLUMNS.map(function (c) {
    if (!c.sortable) return '<th scope="col">' + c.label + '</th>';
    var on = sort.key === c.key;
    var ariaSort = on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    var arrow = on ? '<span class="sort-arrow" aria-hidden="true">' + (sort.dir === 'asc' ? '▲' : '▼') + '</span>' : '';
    return '<th scope="col" class="sortable" aria-sort="' + ariaSort + '"><button type="button" class="mu-sort-btn" data-sort="' + c.key + '">' + c.label + arrow + '</button></th>';
  }).join('');
}

function renderBody() {
  var body = document.getElementById('mu-body');
  var users = visibleUsers();
  document.getElementById('mu-count').textContent = 'Showing ' + users.length + ' of ' + allUsers.length + ' users';

  if (users.length === 0) {
    body.innerHTML = '<tr><td colspan="' + NCOLS + '"><div class="esl-empty">'
      + (allUsers.length === 0 ? 'No users found.' : 'No users match these filters.')
      + '</div></td></tr>';
    return;
  }

  var coaches = sortedCoaches();

  body.innerHTML = users.map(function (u) {
    var d = u.data;
    var uid = u.id;
    var role = isCoachRole(d) ? 'coach' : 'athlete';
    var isSelf = uid === esLabs.ADMIN_UID;
    var name = d.displayName || d.email || '(no name)';
    var initials = (d.displayName || d.email || '?').split(/\s+/).map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);

    // User cell
    var tags = '';
    if (isSelf) tags += '<span class="esl-badge esl-badge--accent">You</span>';
    if (d.hasDoc === false) tags += '<span class="esl-badge esl-badge--warn" title="Signed in but has no profile doc yet — created on first change">No profile</span>';
    if (d.disabled) tags += '<span class="esl-badge esl-badge--bad" title="Account disabled in Firebase Auth">Disabled</span>';
    var actAsBtn = isSelf ? '' : '<button type="button" class="mu-actas-btn esl-btn esl-btn--outline esl-btn--sm" data-uid="' + esc(uid) + '" '
      + 'data-name="' + esc(d.displayName || '') + '" data-email="' + esc(d.email || '') + '" '
      + 'title="Browse the site as this user to enter data on their behalf">Act as &rarr;</button>';
    var deleteBtn = isSelf ? '' : '<button type="button" class="mu-delete-btn esl-btn esl-btn--danger esl-btn--sm" data-uid="' + esc(uid) + '" '
      + 'aria-label="Delete ' + esc(name) + '" title="Permanently delete this user and all their data">Delete</button>';
    var userCell = '<div class="mu-user">'
      + '<div class="mu-avatar" aria-hidden="true">' + esc(initials) + '</div>'
      + '<div class="mu-user-main">'
      + '<div class="mu-user-line"><span class="mu-user-name">' + esc(name) + '</span>' + tags + '</div>'
      + '<div class="mu-user-email">' + esc(d.email || '') + '</div>'
      + (isSelf ? '' : '<div class="mu-row-actions">' + actAsBtn + deleteBtn + '</div>')
      + '</div></div>';

    // Role cell — button toggles athlete <-> coach; your own role is fixed
    var roleLabel = role === 'coach' ? 'Coach' : 'Athlete';
    var roleCell = isSelf
      ? '<span class="mu-role-pill ' + role + ' is-static" data-uid="' + esc(uid) + '" title="You can’t change your own role">' + roleLabel + '</span>'
      : '<button type="button" class="mu-role-pill ' + role + '" data-uid="' + esc(uid) + '" aria-label="Role: ' + roleLabel + '. Change role for ' + esc(name) + '">'
        + roleLabel + ' <span class="swap" aria-hidden="true">⇄</span></button>';

    // Coach cell — assignment dropdown (coaches don't get a coach)
    var coachCell;
    if (role === 'coach') {
      coachCell = '<span class="mu-coach-na">— (coach)</span>';
    } else {
      var cellStatus = statusChips(u);
      var cur = d.coachUid || '';
      var dangling = !!cur && !coachMap[cur];
      var opts = '<option value=""' + (cur ? '' : ' selected') + '>— Unassigned —</option>';
      if (dangling) opts += '<option value="' + esc(cur) + '" selected>Unknown coach (' + esc(cur.slice(0, 6)) + '…)</option>';
      coaches.forEach(function (c) {
        opts += '<option value="' + esc(c.uid) + '"' + (c.uid === cur ? ' selected' : '') + '>' + esc(c.label) + '</option>';
      });
      coachCell = '<select class="mu-coach-select esl-select esl-select--sm' + (cur && !dangling ? '' : ' unassigned') + '" '
        + 'data-uid="' + esc(uid) + '" aria-label="Coach for ' + esc(name) + '">' + opts + '</select>'
        + (cellStatus ? '<div class="mu-status" aria-label="Coaching status">' + cellStatus + '</div>' : '');
    }

    // Access-grant chips
    var featsCell = '<div class="mu-feats">' + FEATURE_LIST.map(function (f) {
      var on = !!(d.features && d.features[f] === true);
      return '<button type="button" class="mu-feat ' + (on ? 'on' : 'off') + '" '
        + 'data-uid="' + esc(uid) + '" data-feat="' + f + '" aria-pressed="' + on + '" '
        + 'aria-label="' + FEATURE_LABELS[f] + ' access for ' + esc(name) + '">'
        + '<span class="mu-feat-dot" aria-hidden="true"></span>' + FEATURE_LABELS[f] + '</button>';
    }).join('') + '</div>';
    var via = d.coachingTier === 'premium' ? 'Coaching, esFormLab and esMetabolicLab via Full Access subscription'
      : d.coachingTier === 'standard' ? 'Coaching via Standard subscription' : '';
    if (via) featsCell += '<div class="mu-feats-note">' + via + '</div>';

    // Strava cell — connection badge + admin unlink (calls deauthorizeStrava
    // on the athlete's behalf: revokes the token and deletes synced data)
    var stravaCell;
    if (d.stravaConnected) {
      stravaCell = '<div class="mu-strava">'
        + '<span class="esl-badge mu-strava-badge">' + STRAVA_LOGO_SVG + 'Connected</span>'
        + '<button type="button" class="mu-strava-unlink esl-btn esl-btn--outline esl-btn--sm" data-uid="' + esc(uid) + '" '
        + 'aria-label="Unlink Strava for ' + esc(name) + '" title="Revoke this user’s Strava access and delete synced data">Unlink</button>'
        + '</div>';
    } else {
      stravaCell = '<span class="mu-coach-na">—</span>';
    }

    // Joined cell
    var joined = createdSeconds(d.createdAt);
    var joinedCell = '<span class="mu-joined">' + (joined ? fmtDate(joined) : '—') + '</span>';

    return '<tr>'
      + '<td>' + userCell + '</td>'
      + '<td>' + roleCell + '</td>'
      + '<td>' + coachCell + '</td>'
      + '<td>' + featsCell + '</td>'
      + '<td>' + stravaCell + '</td>'
      + '<td>' + joinedCell + '</td>'
      + '</tr>';
  }).join('');
}

// Delegated row controls (no Firestore values in inline handlers).
(function wireBody() {
  var body = document.getElementById('mu-body');
  body.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-mu-retry]'))) { loadUsers(); return; }
    if ((t = e.target.closest('button.mu-feat'))) { muToggleFeature(t); return; }
    if ((t = e.target.closest('button.mu-role-pill'))) { muToggleRole(t); return; }
    if ((t = e.target.closest('.mu-strava-unlink'))) { muUnlinkStrava(t); return; }
    if ((t = e.target.closest('.mu-actas-btn'))) { muActAs(t); return; }
    if ((t = e.target.closest('.mu-delete-btn'))) { muDeleteUser(t); return; }
  });
  body.addEventListener('change', function (e) {
    var sel = e.target.closest('.mu-coach-select');
    if (sel) muAssignCoach(sel);
  });
})();

// ── Mutations ────────────────────────────────────────────────────
function localUser(uid) {
  for (var i = 0; i < allUsers.length; i++) if (allUsers[i].id === uid) return allUsers[i];
  return null;
}

function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

// Users who only ever used the public tools have no users/{uid} doc yet,
// so .update() would reject — we set with merge instead, seeding identity
// fields the first time so the new doc isn't blank.
function seedPayload(u, payload) {
  if (!u.data.hasDoc) {
    if (u.data.email) payload.email = u.data.email;
    if (u.data.displayName) payload.displayName = u.data.displayName;
    payload.createdAt = esLabs.firebase.firestore.FieldValue.serverTimestamp();
  }
  return payload;
}

function persist(uid, u, payload) {
  return db.collection('users').doc(uid).set(seedPayload(u, payload), { merge: true }).then(function () {
    u.data.hasDoc = true;
  });
}

function muToggleFeature(el) {
  var uid = el.dataset.uid, feat = el.dataset.feat;
  var u = localUser(uid);
  if (!u) return;
  var enabled = !(u.data.features && u.data.features[feat] === true);
  var hadFocus = document.activeElement === el;
  el.disabled = true;
  var featObj = {}; featObj[feat] = enabled;
  persist(uid, u, { features: featObj }).then(function () {
    if (!u.data.features) u.data.features = {};
    u.data.features[feat] = enabled;
    // Coaching grants change the Coaching column and "Awaiting a coach".
    if (feat === 'coaching') {
      renderStats();
      renderBody();
      var again = document.querySelector('.mu-feat[data-uid="' + cssEsc(uid) + '"][data-feat="' + feat + '"]');
      if (again) again.focus();
    } else {
      el.className = 'mu-feat ' + (enabled ? 'on' : 'off');
      el.setAttribute('aria-pressed', String(enabled));
      el.disabled = false;
      if (hadFocus) el.focus();
    }
    toast(d_name(u) + ': ' + FEATURE_LABELS[feat] + (enabled ? ' access granted' : ' grant removed'), 'success', {
      undo: function () {
        var t = document.querySelector('.mu-feat[data-uid="' + cssEsc(uid) + '"][data-feat="' + feat + '"]');
        if (t) muToggleFeature(t);
      }
    });
  }).catch(function (e) {
    console.error('Toggle feature failed:', e);
    el.disabled = false;
    if (hadFocus) el.focus();
    toast('Failed to update access: ' + (e.message || e), 'error');
  });
}
window.muToggleFeature = muToggleFeature;

// ── Assign / reassign a coach (D8: admin-run, plans move) ─────────
// One assign action: sets users.coachUid, moves the athlete's existing
// training plan to the new coach, marks a pending coaching request
// accepted (and the admin's request notification), and tells the athlete.
// Moving a plan needs the rules change that lets the admin update
// trainingPlans.coachUid; until that's deployed the batch is refused,
// so we fall back to the old behaviour (coach assignment without the plan)
// and say so.
function gatherAssignContext(uid, newCoach) {
  var ctx = { plans: [], movePlan: null, requests: [], notifs: [] };
  var plansP = db.collection('trainingPlans').where('athleteUid', '==', uid).get().then(function (snap) {
    snap.forEach(function (doc) { ctx.plans.push({ id: doc.id, data: doc.data() || {} }); });
  }).catch(function (e) { console.warn('plans lookup:', e && e.message); });
  var reqP = !newCoach ? Promise.resolve() : db.collection('coachingRequests')
    .where('coachUid', '==', esLabs.ADMIN_UID)
    .where('athleteUid', '==', uid)
    .where('status', '==', 'pending')
    .get().then(function (snap) {
      snap.forEach(function (doc) { ctx.requests.push(doc.id); });
    }).catch(function (e) { console.warn('requests lookup:', e && e.message); });
  return Promise.all([plansP, reqP]).then(function () {
    if (!ctx.requests.length) return ctx;
    return db.collection('notifications')
      .where('recipientUid', '==', esLabs.ADMIN_UID)
      .where('type', '==', 'coaching_request')
      .get().then(function (snap) {
        snap.forEach(function (doc) {
          var n = doc.data() || {};
          if (ctx.requests.indexOf(n.requestId) !== -1) ctx.notifs.push(doc.id);
        });
        return ctx;
      }).catch(function () { return ctx; });
  }).then(function (c) {
    // Move one plan: only when the new coach doesn't already have one for
    // this athlete. Prefer the plan of the current coach, newest first.
    if (newCoach && !c.plans.some(function (p) { return p.data.coachUid === newCoach; })) {
      var cand = c.plans.slice().sort(function (a, b) {
        return (createdSeconds(b.data.updatedAt) || 0) - (createdSeconds(a.data.updatedAt) || 0);
      });
      c.movePlan = cand[0] || null;
    }
    return c;
  });
}

function planLabel(p) {
  var d = p.data || {};
  var races = Array.isArray(d.races) ? d.races : [];
  var next = d.raceName || (races.length ? races[races.length - 1].name : '');
  return next ? '“' + next + '” plan' : 'training plan';
}

function muAssignCoach(sel) {
  var uid = sel.dataset.uid;
  var u = localUser(uid);
  if (!u) return;
  var newCoach = sel.value || null;
  var oldCoach = u.data.coachUid || null;
  var revert = function () { sel.value = oldCoach || ''; };
  if (newCoach === oldCoach) return;
  var name = d_name(u);
  sel.disabled = true;

  gatherAssignContext(uid, newCoach).then(function (ctx) {
    var coachName = newCoach ? (coachMap[newCoach] || 'the coach') : null;
    var msg;
    if (newCoach) {
      msg = 'Assign ' + name + ' to ' + coachName + '?'
        + (ctx.movePlan ? '\n\nTheir ' + planLabel(ctx.movePlan) + ' moves to ' + coachName + ' with all its weeks.'
                        : '\n\n' + coachName + ' starts a new training plan for them.')
        + (ctx.requests.length ? '\n\nTheir pending coaching request will be marked accepted.' : '')
        + '\n\n' + name + ' will get a notification.';
    } else {
      msg = 'Unassign ' + name + (oldCoach && coachMap[oldCoach] ? ' from ' + coachMap[oldCoach] : '') + '?'
        + '\n\nThey’ll have no coach until you assign one. Their training plan isn’t deleted.';
    }
    if (!confirm(msg)) { revert(); sel.disabled = false; sel.focus(); return; }

    var FV = esLabs.firebase.firestore.FieldValue;
    function buildBatch(withPlan) {
      var batch = db.batch();
      batch.set(db.collection('users').doc(uid), seedPayload(u, { coachUid: newCoach }), { merge: true });
      if (withPlan && ctx.movePlan) {
        batch.update(db.collection('trainingPlans').doc(ctx.movePlan.id), { coachUid: newCoach, updatedAt: FV.serverTimestamp() });
      }
      if (newCoach) {
        ctx.requests.forEach(function (id) {
          batch.update(db.collection('coachingRequests').doc(id), { status: 'accepted' });
        });
        ctx.notifs.forEach(function (id) {
          batch.update(db.collection('notifications').doc(id), {
            read: true, status: 'accepted', message: name + ' — assigned to ' + coachName + '.'
          });
        });
        var athleteMsg = ctx.requests.length
          ? 'Your coaching request has been accepted! Your coach is ' + coachName + '.'
          : 'Your coach is now ' + coachName + '.';
        if (withPlan && ctx.movePlan) athleteMsg += ' Your training plan moved with you.';
        batch.set(db.collection('notifications').doc(), {
          recipientUid: uid,
          type: 'coaching_accepted',
          message: athleteMsg,
          read: false,
          createdAt: FV.serverTimestamp()
        });
      }
      return batch.commit();
    }

    // Client-side fallback (callable not deployed yet).
    function clientAssign() {
      if (!(newCoach && ctx.movePlan)) return buildBatch(false);
      return buildBatch(true).then(function () { planMoved = true; }, function (e) {
        var denied = e && (/permission-denied$/.test(e.code || '') || /permission/i.test(e.message || ''));
        if (!denied) throw e;
        // Rules forbid moving the plan from the client: assign without it.
        return buildBatch(false);
      });
    }

    // Preferred path: the admin-only adminAssignCoach callable does it all
    // in one server batch (users.coachUid, plan move, request close, the
    // athlete's notification). Not deployed → not-found/internal → client.
    var planMoved = false;
    var fns = esLabs.firebase.app().functions('us-central1');
    // (A sign-up with no users doc yet has no plan either; the client path
    // seeds the doc, which the callable would refuse as not-found.)
    var attempt = !u.data.hasDoc ? clientAssign() : fns.httpsCallable('adminAssignCoach')({ athleteUid: uid, coachUid: newCoach }).then(function (res) {
      var r = (res && res.data) || {};
      planMoved = (r.plansMoved || 0) > 0;
    }, function (e) {
      var code = String((e && e.code) || '').replace(/^functions\//, '');
      if (code === 'not-found' || code === 'internal' || code === 'unavailable' || code === 'unimplemented') {
        console.warn('adminAssignCoach unavailable, assigning from the client:', e && e.message);
        return clientAssign();
      }
      throw e;
    });

    return attempt.then(function () {
      u.data.hasDoc = true;
      u.data.coachUid = newCoach;
      if (newCoach) { delete pendingReq[uid]; u.data.pendingRequest = false; }
      render();
      var again = document.querySelector('.mu-coach-select[data-uid="' + cssEsc(uid) + '"]');
      if (again) again.focus();
      if (!newCoach) { toast(name + ' unassigned', 'success'); return; }
      if (ctx.movePlan && !planMoved) {
        toast(name + ' assigned to ' + coachName + '. Their existing plan couldn’t move yet (needs the Firestore rules update), so ' + coachName + ' will start a new one.', 'error');
      } else {
        toast(name + ' assigned to ' + coachName + (planMoved ? ' — plan moved' : ''), 'success');
      }
    });
  }).catch(function (e) {
    console.error('Assign coach failed:', e);
    sel.disabled = false;
    revert();
    sel.focus();
    toast('Failed to assign coach: ' + (e.message || e), 'error');
  });
}
window.muAssignCoach = muAssignCoach;

function muToggleRole(el) {
  var uid = el.dataset.uid;
  if (uid === esLabs.ADMIN_UID) return;
  var u = localUser(uid);
  if (!u) return;
  var current = el.classList.contains('coach') ? 'coach' : 'athlete';
  var next = current === 'coach' ? 'athlete' : 'coach';
  var name = d_name(u);
  var affected = next === 'athlete'
    ? allUsers.filter(function (x) { return x.data.coachUid === uid; })
    : [];
  var msg = next === 'coach'
    ? 'Promote ' + name + ' to Coach? They will be able to manage athletes assigned to them, and their own coach assignment (if any) will be cleared.'
    : 'Demote ' + name + ' to Athlete?'
      + (affected.length ? '\n\nThese athletes will become unassigned: ' + affected.map(d_name).join(', ') + '.' : '')
      + '\n\nTheir existing training plans stay as they are.';
  if (!confirm(msg)) return;

  el.disabled = true;
  var payload = { role: next };
  // A coach shouldn't have a coach assigned — clear it on promotion.
  if (next === 'coach') payload.coachUid = null;
  persist(uid, u, payload).then(function () {
    u.data.role = next;
    if (next === 'coach') u.data.coachUid = null;
    if (!affected.length) return null;
    // Demotion: unassign their athletes (this also removes the demoted
    // coach's rules-based access to those athletes' data).
    var batch = db.batch();
    affected.forEach(function (x) { batch.set(db.collection('users').doc(x.id), { coachUid: null }, { merge: true }); });
    return batch.commit().then(function () {
      affected.forEach(function (x) { x.data.coachUid = null; x.data.hasDoc = true; });
      return null;
    }, function (e) { return e; });
  }).then(function (batchErr) {
    rebuildCoachMap();
    populateCoachFilter();
    render();
    var again = document.querySelector('.mu-role-pill[data-uid="' + cssEsc(uid) + '"]');
    if (again) again.focus();
    if (batchErr) {
      toast(name + ' is now an Athlete, but unassigning their athletes failed: ' + (batchErr.message || batchErr), 'error');
    } else {
      toast(name + (next === 'coach' ? ' is now a Coach' : ' is now an Athlete'), 'success');
    }
  }).catch(function (e) {
    console.error('Toggle role failed:', e);
    el.disabled = false;
    toast('Failed to change role: ' + (e.message || e), 'error');
  });
}
window.muToggleRole = muToggleRole;

// Admin-only Strava disconnect. deauthorizeStrava revokes the token with
// Strava, deletes stored tokens, and purges all synced activity data —
// same cleanup the athlete's own Unlink button performs, but on their behalf.
function muUnlinkStrava(el) {
  var uid = el.dataset.uid;
  var u = localUser(uid);
  if (!u) return;
  var name = d_name(u);
  if (!confirm(
    'Disconnect ' + name + '’s Strava and revoke access?\n\n'
    + 'This will:\n'
    + '  • Revoke this app’s access token with Strava\n'
    + '  • Delete all activity data this app has synced from Strava\n\n'
    + 'Their data on Strava itself is unaffected. They can reconnect at any time.'
  )) return;

  el.disabled = true;
  el.textContent = 'Unlinking…';
  var fns = esLabs.firebase.app().functions('us-central1');
  fns.httpsCallable('deauthorizeStrava')({ athleteUid: uid }).then(function (res) {
    var warn = res && res.data && res.data.revokeWarning;
    if (warn) console.warn('Strava revoke warning:', warn);
    u.data.stravaConnected = false;
    render();
    var next = document.querySelector('.mu-actas-btn[data-uid="' + cssEsc(uid) + '"]');
    if (next) next.focus();
    toast(name + '’s Strava disconnected' + (warn ? ' (token revoke reported a warning — data still purged)' : ''), 'success');
  }).catch(function (e) {
    console.error('Strava unlink failed:', e);
    el.disabled = false;
    el.textContent = 'Unlink';
    toast('Failed to unlink Strava: ' + (e.message || e), 'error');
  });
}
window.muUnlinkStrava = muUnlinkStrava;

// Permanent delete via the admin-only adminDeleteUser function. The admin
// must type the user's email (or name, if there is no email) to confirm.
function muDeleteUser(el) {
  var uid = el.dataset.uid;
  var u = localUser(uid);
  if (!u) return;
  var name = d_name(u);
  var expected = (u.data.email || u.data.displayName || uid).trim();
  var typed = prompt(
    'Permanently delete ' + name + '?\n\n'
    + 'This will delete:\n'
    + '  • Their sign-in account\n'
    + '  • Their profile, saved analyses, and run history\n'
    + '  • Their training plans, workouts, and lifting weeks\n'
    + '  • Their notifications and coaching requests\n'
    + '  • Their Strava connection (access is revoked)\n'
    + '  • Their Garmin Connect link (ended with Garmin)\n'
    + (u.data.role === 'coach' ? '  • Their athletes will become unassigned\n' : '')
    + '\nThis cannot be undone. Type ' + expected + ' to confirm.'
  );
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== expected.toLowerCase()) {
    toast('Confirmation did not match — user not deleted.', 'error');
    return;
  }

  el.disabled = true;
  el.textContent = 'Deleting…';
  var fns = esLabs.firebase.app().functions('us-central1');
  fns.httpsCallable('adminDeleteUser')({ uid: uid }).then(function (res) {
    var warn = res && res.data && res.data.stravaWarning;
    if (warn) console.warn('Strava revoke warning:', warn);
    var gWarn = res && res.data && res.data.garminWarning;
    if (gWarn) console.warn('Garmin unlink warning:', gWarn);
    allUsers = allUsers.filter(function (x) { return x.id !== uid; });
    allUsers.forEach(function (x) { if (x.data.coachUid === uid) x.data.coachUid = null; });
    delete pendingReq[uid];
    rebuildCoachMap();
    populateCoachFilter();
    render();
    toast(name + ' deleted', 'success');
    // Acting as the deleted user would leave the session pointing at nothing.
    var act = esLabs.getActAs();
    if (act && act.uid === uid) esLabs.stopActAs();
  }).catch(function (e) {
    console.error('Delete user failed:', e);
    el.disabled = false;
    el.textContent = 'Delete';
    toast('Failed to delete user: ' + (e.message || e), 'error');
  });
}
window.muDeleteUser = muDeleteUser;

// Start an act-as session (site.js layer) and jump to the user's
// account page. Firestore rules — not this button — are what let the
// admin write to the target's users/{uid} doc.
function muActAs(el) {
  var info = {
    uid: el.dataset.uid,
    name: el.dataset.name || null,
    email: el.dataset.email || null
  };
  if (!esLabs.startActAs(info)) {
    toast('Couldn’t start act-as — this browser is blocking site data (cookies and storage) for this site. Allow it and try again.', 'error');
    return;
  }
  window.location.href = '/account/';
}
window.muActAs = muActAs;

// ── Helpers ──────────────────────────────────────────────────────
function d_name(u) { return u.data.displayName || u.data.email || 'User'; }

function createdSeconds(t) {
  if (!t) return null;
  if (typeof t === 'number') return t;
  if (typeof t.seconds === 'number') return t.seconds;
  if (typeof t.toDate === 'function') { try { return Math.floor(t.toDate().getTime() / 1000); } catch (e) { return null; } }
  return null;
}

function fmtDate(sec) {
  try {
    return new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return '—'; }
}

// Toast per the standard: info auto-hides after 5 s, errors stay until
// dismissed; optional Undo.
var toastTimer = null;
function toast(msg, kind, opts) {
  opts = opts || {};
  var host = document.getElementById('mu-toast');
  if (!host) return;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  var err = kind === 'error';
  host.innerHTML = '<div class="esl-toast-box' + (err ? ' err' : '') + '"' + (err ? ' role="alert"' : '') + '><span class="mu-toast-msg"></span>'
    + (opts.undo ? '<button type="button" data-toast-undo>Undo</button>' : '')
    + '<button type="button" data-toast-close aria-label="Dismiss message">✕</button></div>';
  host.querySelector('.mu-toast-msg').textContent = msg;
  var close = function () { if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; } host.innerHTML = ''; };
  host.querySelector('[data-toast-close]').onclick = close;
  if (opts.undo) host.querySelector('[data-toast-undo]').onclick = function () { close(); opts.undo(); };
  if (!err) toastTimer = setTimeout(close, 5000);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
