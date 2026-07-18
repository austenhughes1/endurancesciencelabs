// ════════════════════════════════════════════════════════════════
// admin/users/app.js
//
// "Manage Users" — admin-only console for the Endurance Science Labs
// site. Lists every user, with search / role / coach filters and
// sortable columns, and lets the admin:
//   - assign an athlete to a coach (users/{uid}.coachUid)
//   - switch a user's role between athlete and coach (users/{uid}.role)
//   - toggle feature access (users/{uid}.features.{feature})
//   - disconnect a user's Strava (deauthorizeStrava with athleteUid —
//     the function only honors athleteUid when the caller is the admin)
//
// Access is gated two ways:
//   1. The shared sign-in gate is mounted with requireAdmin:true, so a
//      non-admin never sees the app shell.
//   2. Firestore rules only allow the admin UID to read the full users
//      collection and write to arbitrary user docs, so this is the real
//      enforcement — the gate is just UX.
// ════════════════════════════════════════════════════════════════
'use strict';

var db = esLabs.db;

var FEATURE_LIST   = ['coaching', 'lifting', 'esFormLab', 'esMetabolicLab'];
var FEATURE_LABELS = { coaching: 'Coaching', lifting: 'Lifting', esFormLab: 'esFormLab', esMetabolicLab: 'esMetabolicLab' };

// Official Strava mountain logo (per Strava brand guidelines — use as-is,
// never recreate). Same asset the coaching dashboard uses.
var STRAVA_LOGO_SVG = '<svg class="strava-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>';

// Sortable columns: key -> how to extract a comparable value from a user.
var COLUMNS = [
  { key: 'name',   label: 'User',     sortable: true },
  { key: 'role',   label: 'Role',     sortable: true },
  { key: 'coach',  label: 'Coach',    sortable: true },
  { key: 'feats',  label: 'Features', sortable: false },
  { key: 'strava', label: 'Strava',   sortable: true },
  { key: 'joined', label: 'Joined',   sortable: true }
];

// ── State ────────────────────────────────────────────────────────
var allUsers = [];          // [{ id, data }]
var coachMap = {};          // uid -> displayName/email (role === 'coach')
var filters = { search: '', role: 'all', coach: 'all' };
var sort = { key: 'name', dir: 'asc' };
var loaded = false;

// ── Auth / gate ──────────────────────────────────────────────────
esLabs.mountNav('#mu-nav', { active: '' });

esLabs.mountAuthGate('#mu-gate', {
  logo: '/images/logo_icon_only_white_clean.png',
  eyebrow: '◉ Admin',
  headline: 'Manage Users',
  sub: 'This console is restricted to the Endurance Science Labs admin account. Sign in to continue.',
  requireAdmin: true,
  emailDefault: 'signin',
  foot: '<a href="/account/" style="color:var(--cyan);text-decoration:none">&larr; Back to my account</a>'
});

esLabs.onAuthChange(function (user) {
  var app = document.getElementById('mu-app');
  if (!app) return;
  if (user && user.uid === esLabs.ADMIN_UID) {
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
function loadUsers() {
  var body = document.getElementById('mu-body');
  body.innerHTML = '<tr><td colspan="6"><div class="mu-loading">Loading users…</div></td></tr>';

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
          stravaConnected: u.stravaConnected === true
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
      toast('Showing Firestore profiles only — deploy listAllUsers to include sign-ups without a profile.', 'error');
    }).catch(function (e2) {
      console.error('Manage Users load failed:', e2);
      body.innerHTML = '<tr><td colspan="6"><div class="mu-empty" style="color:var(--bad)">Failed to load users. ' + esc(e2.message || '') + '</div></td></tr>';
    });
  });
}

function finishLoad() {
  loaded = true;
  rebuildCoachMap();
  populateCoachFilter();
  render();
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
  var coaches = Object.keys(coachMap)
    .map(function (uid) { return { uid: uid, label: coachMap[uid] }; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });
  var html = '<option value="all">All</option><option value="unassigned">Unassigned</option>';
  coaches.forEach(function (c) {
    html += '<option value="' + esc(c.uid) + '">' + esc(c.label) + '</option>';
  });
  sel.innerHTML = html;
  // Keep the current selection if still valid, else reset.
  if (filters.coach !== 'all' && filters.coach !== 'unassigned' && !coachMap[filters.coach]) {
    filters.coach = 'all';
  }
  sel.value = filters.coach;
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
document.getElementById('mu-clear-btn').addEventListener('click', function () {
  filters = { search: '', role: 'all', coach: 'all' };
  document.getElementById('mu-search-input').value = '';
  document.getElementById('mu-role-filter').value = 'all';
  document.getElementById('mu-coach-filter').value = 'all';
  render();
});

// ── Filtering + sorting ──────────────────────────────────────────
function visibleUsers() {
  var out = allUsers.filter(function (u) {
    var d = u.data;
    var role = d.role === 'coach' ? 'coach' : 'athlete';
    if (filters.role !== 'all' && role !== filters.role) return false;
    if (filters.coach === 'unassigned' && d.coachUid) return false;
    if (filters.coach !== 'all' && filters.coach !== 'unassigned' && d.coachUid !== filters.coach) return false;
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
    case 'role':   return d.role === 'coach' ? 'coach' : 'athlete';
    case 'coach':  return (coachMap[d.coachUid] || '￿').toLowerCase(); // unassigned sorts last
    case 'strava': return d.stravaConnected ? 0 : 1; // connected sorts first (asc)
    case 'joined': return createdSeconds(d.createdAt) || 0;
    case 'name':
    default:       return (d.displayName || d.email || '').toLowerCase();
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
}
window.muSetSort = setSort;

// ── Render ───────────────────────────────────────────────────────
function render() {
  renderStats();
  renderHead();
  renderBody();
}

function renderStats() {
  var total = allUsers.length;
  var coaches = 0, athletes = 0, unassigned = 0;
  allUsers.forEach(function (u) {
    if (u.data.role === 'coach') { coaches++; }
    else {
      athletes++;
      if (!u.data.coachUid) unassigned++;
    }
  });
  document.getElementById('mu-stats').innerHTML =
      stat('total', total, 'Total users')
    + stat('coaches', coaches, 'Coaches')
    + stat('athletes', athletes, 'Athletes')
    + stat('unassigned', unassigned, 'Unassigned athletes');
}
function stat(cls, num, label) {
  return '<div class="mu-stat ' + cls + '"><div class="mu-stat-num">' + num + '</div>'
       + '<div class="mu-stat-label">' + label + '</div></div>';
}

function renderHead() {
  var row = document.getElementById('mu-head-row');
  row.innerHTML = COLUMNS.map(function (c) {
    if (!c.sortable) return '<th>' + c.label + '</th>';
    var arrow = sort.key === c.key ? ('<span class="sort-arrow">' + (sort.dir === 'asc' ? '▲' : '▼') + '</span>') : '';
    return '<th class="sortable" onclick="muSetSort(\'' + c.key + '\')">' + c.label + arrow + '</th>';
  }).join('');
}

function renderBody() {
  var body = document.getElementById('mu-body');
  var users = visibleUsers();

  if (users.length === 0) {
    body.innerHTML = '<tr><td colspan="6"><div class="mu-empty">'
      + (allUsers.length === 0 ? 'No users found.' : 'No users match these filters.')
      + '</div></td></tr>';
    return;
  }

  var coaches = Object.keys(coachMap)
    .map(function (uid) { return { uid: uid, label: coachMap[uid] }; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });

  body.innerHTML = users.map(function (u) {
    var d = u.data;
    var uid = u.id;
    var role = d.role === 'coach' ? 'coach' : 'athlete';
    var isSelf = uid === esLabs.ADMIN_UID;
    var initials = (d.displayName || d.email || '?').split(/\s+/).map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);

    // User cell
    var tags = '';
    if (isSelf) tags += '<span class="mu-you-tag">YOU</span>';
    if (d.hasDoc === false) tags += '<span class="mu-flag-tag noprofile" title="Signed in but has no profile doc yet — created on first change">NO PROFILE</span>';
    if (d.disabled) tags += '<span class="mu-flag-tag disabled" title="Account disabled in Firebase Auth">DISABLED</span>';
    var userCell = '<div class="mu-user">'
      + '<div class="mu-avatar">' + esc(initials) + '</div>'
      + '<div style="min-width:0">'
      + '<div class="mu-user-name">' + esc(d.displayName || d.email || '(no name)') + tags + '</div>'
      + '<div class="mu-user-email">' + esc(d.email || '') + '</div>'
      + '</div></div>';

    // Role cell — pill toggles athlete <-> coach
    var roleCell = '<span class="mu-role-pill ' + role + '" data-uid="' + esc(uid) + '" '
      + 'onclick="muToggleRole(this)" title="Click to switch role">'
      + role + ' <span class="swap">⇄</span></span>';

    // Coach cell — assignment dropdown (coaches don't get a coach)
    var coachCell;
    if (role === 'coach') {
      coachCell = '<span class="mu-coach-na">— (coach)</span>';
    } else {
      var cur = d.coachUid || '';
      var opts = '<option value=""' + (cur ? '' : ' selected') + '>— Unassigned —</option>';
      coaches.forEach(function (c) {
        opts += '<option value="' + esc(c.uid) + '"' + (c.uid === cur ? ' selected' : '') + '>' + esc(c.label) + '</option>';
      });
      coachCell = '<select class="mu-coach-select' + (cur ? '' : ' unassigned') + '" '
        + 'data-uid="' + esc(uid) + '" onchange="muAssignCoach(this)">' + opts + '</select>';
    }

    // Features cell
    var featsCell = '<div class="mu-feats">' + FEATURE_LIST.map(function (f) {
      var on = d.features && d.features[f] === true;
      return '<div class="mu-feat ' + (on ? 'on' : 'off') + '" '
        + 'data-uid="' + esc(uid) + '" data-feat="' + f + '" '
        + 'onclick="muToggleFeature(this)"><span class="mu-feat-dot"></span>' + FEATURE_LABELS[f] + '</div>';
    }).join('') + '</div>';

    // Strava cell — connection badge + admin unlink (calls deauthorizeStrava
    // on the athlete's behalf: revokes the token and deletes synced data)
    var stravaCell;
    if (d.stravaConnected) {
      stravaCell = '<div class="mu-strava">'
        + '<span class="mu-strava-badge">' + STRAVA_LOGO_SVG + ' CONNECTED</span>'
        + '<button class="mu-strava-unlink" data-uid="' + esc(uid) + '" '
        + 'onclick="muUnlinkStrava(this)" title="Revoke this user\'s Strava access and delete synced data">Unlink</button>'
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

// ── Mutations ────────────────────────────────────────────────────
function localUser(uid) {
  for (var i = 0; i < allUsers.length; i++) if (allUsers[i].id === uid) return allUsers[i];
  return null;
}

// Create-or-merge a write. Users who only ever used the public tools
// have no users/{uid} doc yet, so .update() would reject — we set with
// merge instead, seeding identity fields the first time so the new doc
// isn't blank.
function persist(uid, u, payload) {
  if (!u.data.hasDoc) {
    if (u.data.email) payload.email = u.data.email;
    if (u.data.displayName) payload.displayName = u.data.displayName;
    payload.createdAt = esLabs.firebase.firestore.FieldValue.serverTimestamp();
  }
  return db.collection('users').doc(uid).set(payload, { merge: true }).then(function () {
    u.data.hasDoc = true;
  });
}

function muToggleFeature(el) {
  var uid = el.dataset.uid, feat = el.dataset.feat;
  var u = localUser(uid);
  if (!u) return;
  var enabled = !(u.data.features && u.data.features[feat] === true);
  el.setAttribute('disabled', 'true');
  var featObj = {}; featObj[feat] = enabled;
  persist(uid, u, { features: featObj }).then(function () {
    if (!u.data.features) u.data.features = {};
    u.data.features[feat] = enabled;
    el.className = 'mu-feat ' + (enabled ? 'on' : 'off');
    el.removeAttribute('disabled');
    toast(d_name(u) + ': ' + FEATURE_LABELS[feat] + (enabled ? ' enabled' : ' disabled'), 'success');
  }).catch(function (e) {
    console.error('Toggle feature failed:', e);
    el.removeAttribute('disabled');
    toast('Failed to update feature: ' + (e.message || e), 'error');
  });
}
window.muToggleFeature = muToggleFeature;

function muAssignCoach(sel) {
  var uid = sel.dataset.uid;
  var u = localUser(uid);
  if (!u) return;
  var newCoach = sel.value || null;
  sel.disabled = true;
  persist(uid, u, { coachUid: newCoach }).then(function () {
    u.data.coachUid = newCoach;
    sel.disabled = false;
    sel.classList.toggle('unassigned', !newCoach);
    var coachName = newCoach ? (coachMap[newCoach] || 'coach') : null;
    toast(d_name(u) + (coachName ? ' assigned to ' + coachName : ' unassigned'), 'success');
    renderStats();
  }).catch(function (e) {
    console.error('Assign coach failed:', e);
    sel.disabled = false;
    sel.value = u.data.coachUid || '';
    toast('Failed to assign coach: ' + (e.message || e), 'error');
  });
}
window.muAssignCoach = muAssignCoach;

function muToggleRole(el) {
  var uid = el.dataset.uid;
  var u = localUser(uid);
  if (!u) return;
  var current = el.classList.contains('coach') ? 'coach' : 'athlete';
  var next = current === 'coach' ? 'athlete' : 'coach';
  var name = d_name(u);
  var msg = next === 'coach'
    ? 'Promote ' + name + ' to Coach? They will be able to manage athletes assigned to them, and their own coach assignment (if any) will be cleared.'
    : 'Demote ' + name + ' to Athlete? Athletes assigned to them will become unassigned.';
  if (!confirm(msg)) return;

  el.setAttribute('disabled', 'true');
  var payload = { role: next };
  // A coach shouldn't have a coach assigned — clear it on promotion.
  if (next === 'coach') payload.coachUid = null;
  persist(uid, u, payload).then(function () {
    u.data.role = next;
    if (next === 'coach') u.data.coachUid = null;
    rebuildCoachMap();
    populateCoachFilter();
    render();
    toast(name + (next === 'coach' ? ' is now a Coach' : ' is now an Athlete'), 'success');
  }).catch(function (e) {
    console.error('Toggle role failed:', e);
    el.removeAttribute('disabled');
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

  el.setAttribute('disabled', 'true');
  el.textContent = 'Unlinking…';
  var fns = esLabs.firebase.app().functions('us-central1');
  fns.httpsCallable('deauthorizeStrava')({ athleteUid: uid }).then(function (res) {
    var warn = res && res.data && res.data.revokeWarning;
    if (warn) console.warn('Strava revoke warning:', warn);
    u.data.stravaConnected = false;
    render();
    toast(name + '’s Strava disconnected' + (warn ? ' (token revoke reported a warning — data still purged)' : ''), 'success');
  }).catch(function (e) {
    console.error('Strava unlink failed:', e);
    el.removeAttribute('disabled');
    el.textContent = 'Unlink';
    toast('Failed to unlink Strava: ' + (e.message || e), 'error');
  });
}
window.muUnlinkStrava = muUnlinkStrava;

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

var toastTimer = null;
function toast(msg, kind) {
  var el = document.getElementById('mu-toast');
  el.textContent = msg;
  el.className = 'mu-toast show' + (kind ? ' ' + kind : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'mu-toast'; }, 2600);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
