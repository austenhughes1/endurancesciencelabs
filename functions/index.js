const { onRequest } = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { renderReport } = require("./report-renderer");
const { renderComparisonReport } = require("./comparison-renderer");

admin.initializeApp();
const db = admin.firestore();
// Garmin Connect (functions/garmin.js); its functions are re-exported at the end.
const garmin = require("./garmin");

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const SITE_URL = "https://endurancesciencelabs.com/coaching/";
const ADMIN_UID = "2z9Z3K5ZwShvadUuqZmwMv0s1Od2";

// Pass-duration / price-id constants mirror the client-side pass logic.
// Keep these in sync with the same constants at the top of shared/site.js.
const PASS_DURATION_SEC = 90 * 24 * 60 * 60;
// Full Access coaching: monthly ($275/mo) and 4-month block ($1000 / 4 mo).
// Either one bundles esFormLab access. Keep in sync with shared/site.js.
const COACHING_PREMIUM_PRICE_IDS = [
  "price_1UOlXBIFO8pppwnFMym4W83P", // $275 / mo
  "price_1UPoiIIFO8pppwnFyugPYaSf", // $1000 every 4 months
];
// Price(s) the esFormLab 90-day pass sells under. Metabolic and coaching
// payments land in the same customers/{uid}/payments collection, so a
// payment only counts as a pass if it was for one of these. If the pass
// price ever changes after people have bought it, keep the old ID here.
const ESFORMLAB_PASS_PRICE_IDS = [
  "price_1UPp34IFO8pppwnFSpUiY96l", // $90 90-day pass
];
// esMetabolicLab in-person lactate test (one-time). Keep in sync with
// METLAB_INPERSON_PRICE_ID in shared/site.js.
const METLAB_INPERSON_PRICE_ID = "price_1TahCGIFO8pppwnFHqaaKbwW";

// ═══════════════════════════════════════════════════════════
//  Signed OAuth state. The client asks createStravaOAuthState for a
//  short-lived state bound to the caller's REAL uid (act-as callables
//  run with the admin's own auth, so an admin acting as an athlete
//  gets the admin's uid and can't link their Strava to the athlete).
//  Format: "uid:exp:sig", sig = base64url(HMAC-SHA256(key, uid:exp)).
// ═══════════════════════════════════════════════════════════
const STRAVA_STATE_TTL_SEC = 15 * 60;

function stravaStateKey() {
  return process.env.STRAVA_STATE_SECRET || process.env.STRAVA_CLIENT_SECRET || "";
}

function signStravaState(uid, exp) {
  return crypto.createHmac("sha256", stravaStateKey()).update(uid + ":" + exp).digest("base64url");
}

// Returns the uid the state was issued for, or null when it is forged,
// expired or malformed.
function verifyStravaState(state) {
  if (typeof state !== "string") return null;
  const parts = state.split(":");
  if (parts.length === 3) {
    const [uid, exp, sig] = parts;
    if (!uid || !/^\d+$/.test(exp) || Number(exp) <= Math.floor(Date.now() / 1000) || !stravaStateKey()) return null;
    const expected = Buffer.from(signStravaState(uid, exp));
    const given = Buffer.from(sig || "");
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    return uid;
  }
  // Transition (phase 1): the old unsigned "uid:nonce" state is still
  // accepted until the client that requests signed states is live.
  // Phase 2 deletes this branch (see plan server.deploy.md).
  if (parts.length === 2 && parts[0]) {
    console.warn("legacy Strava state");
    return parts[0];
  }
  return null;
}

exports.createStravaOAuthState = onCall({ cors: true }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to connect Strava.");
  if (!stravaStateKey()) {
    console.error("createStravaOAuthState: Strava credentials not configured");
    throw new HttpsError("unavailable", "Strava connections are unavailable right now. Try again later.");
  }
  const exp = String(Math.floor(Date.now() / 1000) + STRAVA_STATE_TTL_SEC);
  return { state: uid + ":" + exp + ":" + signStravaState(uid, exp) };
});

// Best-effort revoke of one just-issued access token (no stored doc yet).
async function revokeAccessToken(accessToken) {
  if (!accessToken) return;
  try {
    const r = await fetch(STRAVA_DEAUTHORIZE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) console.warn(`Strava deauthorize returned HTTP ${r.status}`);
  } catch (e) {
    console.warn("Strava deauthorize request error:", e && e.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  stravaCallback — HTTPS endpoint that Strava redirects to
//  after the athlete authorizes. Exchanges code for tokens,
//  stores them securely, redirects back to /coaching/. Every
//  outcome redirects back with ?strava=<result>[&reason=…]
//  (never a bare text page):
//    connected · denied (cancelled on Strava) · scope (activity
//    access not granted) · error&reason=params|state|user|config|
//    exchange|inuse
// ═══════════════════════════════════════════════════════════
exports.stravaCallback = onRequest({ cors: false }, async (req, res) => {
  const back = (qs) => res.redirect(`${SITE_URL}?strava=${qs}`);
  const { code, state } = req.query;

  // Strava sends ?error=access_denied (and no code) when the athlete cancels.
  if (req.query.error === "access_denied") return back("denied");
  if (!code || !state) return back("error&reason=params");

  const uid = verifyStravaState(String(state));
  if (!uid) return back("error&reason=state");

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("stravaCallback: Strava credentials not configured");
    return back("error&reason=config");
  }

  try {
    // Verify user exists
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return back("error&reason=user");

    // Exchange authorization code for tokens
    const tokenRes = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Strava token exchange failed:", err);
      return back("error&reason=exchange");
    }

    const tokenData = await tokenRes.json();
    const athleteId = (tokenData.athlete && tokenData.athlete.id) || null;
    const privRef = userRef.collection("private").doc("strava");
    const privSnap = await privRef.get();
    const storedAthleteId = (privSnap.exists && privSnap.data().athleteId) || userDoc.data().stravaAthleteId || null;

    // One Strava athlete links to one ESL account. Nothing is revoked here:
    // the authorization is shared with the other account's live link.
    if (athleteId != null) {
      const dupSnap = await db.collection("users").where("stravaAthleteId", "==", athleteId).get();
      if (dupSnap.docs.some((d) => d.id !== uid)) {
        console.warn(`stravaCallback: athlete ${athleteId} is already linked to another user; refused for uid ${uid}`);
        return back("error&reason=inuse");
      }
    }

    // Activity access is required. When Strava reports the granted scopes and
    // neither activity scope is among them, undo the half-authorization and
    // store nothing. (No scope param at all keeps the old behaviour.)
    if (req.query.scope !== undefined) {
      const granted = String(req.query.scope || "").split(",").map((x) => x.trim());
      if (!granted.some((x) => x === "activity:read" || x === "activity:read_all")) {
        await revokeAccessToken(tokenData.access_token);
        // Deauthorizing ends this athlete's authorization for the app; if this
        // user already held it, purge now rather than waiting for the webhook.
        if (storedAthleteId != null && String(storedAthleteId) === String(athleteId)) {
          await purgeStravaData(uid);
        }
        return back("scope");
      }
    }

    // Switching Strava accounts: revoke the old account and delete the runs
    // synced from it before storing the new one, so the two never mix and a
    // later deauth by the old account can't strand data.
    if (storedAthleteId != null && athleteId != null && String(storedAthleteId) !== String(athleteId)) {
      await revokeStravaToken(uid);
      const deleted = await purgeStravaData(uid);
      console.log(`stravaCallback: uid ${uid} switched Strava ${storedAthleteId} -> ${athleteId}; purged ${deleted} activities`);
    }

    // Store tokens in a private subcollection (not readable by client)
    await privRef.set({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_at,
      athleteId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update public user doc
    await userRef.update({
      stravaConnected: true,
      stravaAthleteId: athleteId,
    });

    return back("connected");
  } catch (err) {
    console.error("Strava callback error:", err);
    return back("error&reason=exchange");
  }
});

// How far back a sync pulls run history for Run Dynamics (the athlete's
// full chart history), vs. the short coach-view mirror on the training plan.
const STRAVA_LOOKBACK_DAYS = 730;
const STRAVA_MIRROR_DAYS = 120;

// One Strava SummaryActivity -> the run-doc shape the client importers in
// shared/run-dynamics.js produce (parseExport / runFromFitSession), stored
// under users/{uid}/garminActivities. Strava's API never exposes running
// dynamics (GCT, vertical oscillation, stride), so those stay null and the
// load model falls back to its no-dynamics path. It also omits total
// descent, so descentM is written as null and the model resolves it at
// READ time (shared/run-load-model.js `elevation`): an outdoor run mirrors
// its ascent (nearly every run ends where it started), a treadmill run gets
// 0 (a belt never descends). Writing the mirror here used to surcharge
// treadmill runs for a descent that never happened, and made a mirrored
// value indistinguishable from a measured one; the model therefore treats
// ANY Strava doc's descentM as absent, so older docs that still carry the
// mirror need no migration. A later watch import replaces the doc anyway.
// Cadence is per-leg -> ×2 for spm. Returns null for non-runs.
// Same run recorded twice (watch file + Strava): the start→end spans overlap,
// with a minute of slack for clock skew. Mirrors sameRunSpan in
// shared/run-dynamics.js.
function sameRunSpan(aTs, aDur, bTs, bDur) {
  const slack = 60000;
  return aTs <= bTs + (bDur || 0) * 1000 + slack &&
    bTs <= aTs + (aDur || 0) * 1000 + slack;
}

function stravaRunDoc(act) {
  const sport = String(act.sport_type || act.type || "");
  if (!/run/i.test(sport)) return null;
  const start = new Date(act.start_date);
  if (isNaN(start)) return null;
  const type =
    sport === "TrailRun" ? "Trail Running" :
    (sport === "VirtualRun" || act.trainer) ? "Treadmill Running" :
    "Running";
  // Same id scheme as the client importers (local start-time digits + type),
  // so the same run arriving later in a Garmin CSV lands on the same doc id.
  const digits = String(act.start_date_local || act.start_date).replace(/\D/g, "").slice(0, 14);
  const id = digits + "_" + type.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pos = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
  const distM = pos(act.distance);
  const durSec = pos(act.moving_time);
  const title = String(act.name || "");
  return {
    id, type, title,
    leverTitle: /lever/i.test(title),
    ts: start.getTime(),
    dateISO: start.toISOString(),
    distMi: distM == null ? null : distM / 1609.34,
    durSec,
    avgHr: pos(act.average_heartrate), maxHr: pos(act.max_heartrate),
    aerobicTE: null,
    cadence: pos(act.average_cadence) == null ? null : Math.round(act.average_cadence * 2),
    stride: null, vratio: null, vo: null, gct: null, gctBalL: null,
    paceSec: distM && durSec ? (durSec / distM) * 1609.34 : null,
    gapSec: null,
    ascentM: (typeof act.total_elevation_gain === "number" && isFinite(act.total_elevation_gain))
      ? act.total_elevation_gain : null,
    descentM: null,
    steps: null,
    source: "strava",
    stravaId: act.id,
  };
}

// ═══════════════════════════════════════════════════════════
//  syncStravaActivities — Callable function that fetches
//  recent Strava activities and writes them to Firestore:
//  a 2-year run-history supplement for Run Dynamics
//  (users/{uid}/garminActivities) plus the short coach-view
//  mirror (trainingPlans/{plan}/stravaActivities).
//  Called by the client after connecting or via a sync button.
// ═══════════════════════════════════════════════════════════
// May `callerUid` sync another athlete's Strava? The admin always; a
// coach only for an athlete whose coach of record they are (the same
// relationship the Firestore rules use for garminActivities).
async function mayManageAthleteStrava(callerUid, athleteUid) {
  if (callerUid === ADMIN_UID) return true;
  try {
    const [athleteSnap, callerSnap] = await Promise.all([
      db.collection("users").doc(athleteUid).get(),
      db.collection("users").doc(callerUid).get(),
    ]);
    return athleteSnap.exists && callerSnap.exists &&
      athleteSnap.data().coachUid === callerUid &&
      callerSnap.data().role === "coach";
  } catch (e) {
    console.warn("mayManageAthleteStrava lookup failed:", e && e.message);
    return false;
  }
}

exports.syncStravaActivities = onCall({ cors: true, timeoutSeconds: 300 }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Sign in to sync Strava.");
  }

  // Sync on behalf of an athlete: the admin, or the athlete's coach of
  // record. Anyone else asking for another athlete is refused outright —
  // never fall back to syncing the caller's own account.
  let uid = callerUid;
  const targetUid = request.data?.athleteUid;
  if (typeof targetUid === "string" && targetUid && targetUid !== callerUid) {
    if (!(await mayManageAthleteStrava(callerUid, targetUid))) {
      throw new HttpsError("permission-denied", "Only the athlete can sync this Strava account.");
    }
    uid = targetUid;
  }

  return runStravaSync(uid, { backfill: request.data?.backfill === true });
});

// The sync itself, for one athlete whose access has already been checked.
// Shared by the syncStravaActivities callable and the webhook-driven
// onStravaSyncQueued trigger. Throws HttpsError on the same conditions the
// callable always reported (not connected, revoked access, Strava down) and
// returns the same result objects (incl. the rateLimited one).
async function runStravaSync(uid, opts = {}) {
  // Read stored tokens
  const tokenDoc = await db.collection("users").doc(uid).collection("private").doc("strava").get();
  if (!tokenDoc.exists) {
    throw new HttpsError("not-found", "Strava isn't connected. Connect Strava first.");
  }

  let { accessToken, refreshToken, expiresAt } = tokenDoc.data();

  // Refresh token if expired (Strava tokens expire every 6 hours)
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt && now >= expiresAt - 300) {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;

    const refreshRes = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!refreshRes.ok) {
      const errText = await refreshRes.text();
      console.error("Token refresh failed:", errText);
      // 400/401 means the athlete revoked access on Strava's side — purge
      // everything we hold so stored data doesn't outlive the authorization.
      if (refreshRes.status === 400 || refreshRes.status === 401) {
        const deleted = await purgeStravaData(uid);
        console.log(`Strava token revoked for uid ${uid} — purged tokens + ${deleted} activities`);
        throw new HttpsError("failed-precondition", "Strava access was revoked. Reconnect Strava to keep syncing.");
      }
      throw new HttpsError("unavailable", "Strava didn't respond. Try again in a few minutes.");
    }

    const refreshData = await refreshRes.json();
    accessToken = refreshData.access_token;
    refreshToken = refreshData.refresh_token;
    expiresAt = refreshData.expires_at;

    await db.collection("users").doc(uid).collection("private").doc("strava").update({
      accessToken,
      refreshToken,
      expiresAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Fetch summary activities. The daily sync covers the 2-year lookback
  // window; backfill mode (the "Backfill Strava history" button in Run
  // Dynamics) drops the cutoff and pages through the athlete's entire
  // history. Both use only the list endpoint at Strava's 200/page maximum —
  // the cheapest way to cover a history (1 request per 200 activities, no
  // per-activity detail calls).
  const isBackfill = opts.backfill === true;
  const after = Math.floor(Date.now() / 1000) - STRAVA_LOOKBACK_DAYS * 24 * 60 * 60;
  const maxPages = isBackfill ? 40 : 15; // 8,000 vs 3,000 activities
  let allActivities = [];
  let page = 1;
  let rateLimited = false;
  let pagesOk = 0;

  while (page <= maxPages) {
    const url = `${STRAVA_ACTIVITIES_URL}?${isBackfill ? "" : `after=${after}&`}per_page=200&page=${page}`;
    let actRes;
    try {
      actRes = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      console.error("Strava activities request error:", e && e.message);
      if (page === 1) throw new HttpsError("unavailable", "Strava didn't respond. Try again in a few minutes.");
      break;
    }

    if (actRes.status === 429) {
      // App-level read limit (shared across all athletes, resets every
      // 15 min) — keep what we already fetched and tell the client so the
      // user can rerun the backfill after the window resets.
      rateLimited = true;
      break;
    }
    if (!actRes.ok) {
      console.error("Strava activities fetch failed:", actRes.status, await actRes.text());
      // A failed FIRST page means nothing was read: report it instead of
      // finishing as "synced today" with 0 runs. Later pages keep the
      // partial result.
      if (page === 1) {
        if (actRes.status === 401 || actRes.status === 403) {
          throw new HttpsError("failed-precondition", "Strava isn't sharing your activities with us. Reconnect Strava and leave “View data about your activities” ticked.");
        }
        throw new HttpsError("unavailable", "Strava didn't respond. Try again in a few minutes.");
      }
      break;
    }

    const activities = await actRes.json();
    pagesOk++;
    if (!activities.length) break;
    allActivities = allActivities.concat(activities);
    page++;
  }

  // Rate-limited before any page came back: nothing to write, and
  // stravaLastSyncedAt stays unstamped so today's auto-sync retries.
  if (pagesOk === 0) {
    return {
      backfill: isBackfill,
      rateLimited: true,
      synced: 0,
      runDocs: 0,
      runSkipped: 0,
      message: "Strava's rate limit was reached. Try again in 15 minutes.",
    };
  }

  // ── Run Dynamics supplement ──────────────────────────────
  // Convert Strava runs into run docs for users/{uid}/garminActivities so
  // Run Dynamics is populated even without a manual export upload. Watch
  // imports are the richer record (GCT, oscillation, descent), so a Strava
  // run whose span overlaps a device-imported run is skipped — Strava only
  // fills the gaps. Matching is per run, not per day: a double (watch file
  // for one run, Strava for the other) keeps both. (The reverse direction — a later device
  // upload replacing Strava docs on the days it covers — is handled by
  // backfill() in shared/run-dynamics.js.)
  const runCol = db.collection("users").doc(uid).collection("garminActivities");
  const existingSnap = await runCol.select("ts", "durSec", "source").get();
  const deviceRuns = [];
  const deviceIds = new Set();
  const stravaIds = new Set();
  existingSnap.forEach((d) => {
    if (d.get("source") !== "strava") {
      deviceIds.add(d.id);
      const t = d.get("ts");
      if (Number.isFinite(t)) deviceRuns.push({ ts: t, durSec: d.get("durSec") });
    } else {
      stravaIds.add(d.id);
    }
  });

  const runWrites = [];
  let runSkipped = 0;
  for (const act of allActivities) {
    const doc = stravaRunDoc(act);
    if (!doc) continue;
    // Backfill also skips Strava docs already stored (same id ⇒ same run —
    // no point re-writing thousands of unchanged docs). The daily sync keeps
    // overwriting its 2-year window so Strava-side renames still propagate.
    if (deviceRuns.some((r) => sameRunSpan(r.ts, r.durSec, doc.ts, doc.durSec)) ||
        deviceIds.has(doc.id) ||
        (isBackfill && stravaIds.has(doc.id))) {
      runSkipped++;
      continue;
    }
    runWrites.push(doc);
  }
  for (let i = 0; i < runWrites.length; i += 450) {
    const batch = db.batch();
    runWrites.slice(i, i + 450).forEach((doc) => batch.set(runCol.doc(doc.id), doc));
    await batch.commit();
  }

  // Backfill stops here: the coach mirror + description fetches are the
  // daily sync's job, and stravaLastSyncedAt stays untouched so today's
  // normal auto-sync still runs.
  if (isBackfill) {
    return {
      backfill: true,
      rateLimited,
      runDocs: runWrites.length,
      runSkipped,
      message: `Backfilled ${runWrites.length} runs (${runSkipped} already stored or covered by watch imports).`,
    };
  }

  // ── Coach-view mirror (short window, training plan required) ──
  const planSnap = await db.collection("trainingPlans")
    .where("athleteUid", "==", uid)
    .limit(1)
    .get();

  if (planSnap.empty) {
    // No training plan (standalone Run Dynamics user) — the run-history
    // supplement above is still valid, so finish instead of erroring.
    await db.collection("users").doc(uid).update({
      stravaLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      synced: 0,
      runDocs: runWrites.length,
      runSkipped,
      message: `Synced ${runWrites.length} runs (${runSkipped} already covered by watch imports).`,
    };
  }

  const planId = planSnap.docs[0].id;
  const mirrorCutoff = Date.now() - STRAVA_MIRROR_DAYS * 24 * 60 * 60 * 1000;
  const mirrorActivities = allActivities.filter(
    (a) => a.start_date && new Date(a.start_date).getTime() >= mirrorCutoff
  );

  // Fetch descriptions for recent runs (last 7 days only, to limit API calls)
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const recentRunIds = mirrorActivities
    .filter(a => a.type === "Run" && a.start_date && new Date(a.start_date).getTime() / 1000 > sevenDaysAgo)
    .map(a => a.id);

  const descriptions = {};
  for (const id of recentRunIds) {
    try {
      const detailRes = await fetch(`https://www.strava.com/api/v3/activities/${id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (detailRes.ok) {
        const detail = await detailRes.json();
        if (detail.description) descriptions[id] = detail.description;
      }
    } catch (e) {
      // Skip on error, description is optional
    }
  }

  let batch = db.batch();
  let count = 0;

  for (const act of mirrorActivities) {
    // Convert start_date_local to YYYY-MM-DD for querying
    const dateStr = act.start_date_local
      ? act.start_date_local.substring(0, 10)
      : new Date(act.start_date).toISOString().substring(0, 10);

    // Compute average pace (seconds per mile) for running activities
    let averagePace = null;
    if (act.distance > 0 && act.moving_time > 0 && act.type === "Run") {
      const secPerMeter = act.moving_time / act.distance;
      const paceMin = Math.floor(secPerMeter * 1609.34 / 60);
      const paceSec = Math.round(secPerMeter * 1609.34 % 60);
      averagePace = `${paceMin}:${String(paceSec).padStart(2, "0")} /mi`;
    }

    const docRef = db.collection("trainingPlans")
      .doc(planId)
      .collection("stravaActivities")
      .doc(String(act.id));

    batch.set(docRef, {
      activityId: act.id,
      name: act.name || "",
      type: act.type || "Run",
      date: dateStr,
      distance: act.distance || 0,
      movingTime: act.moving_time || 0,
      elapsedTime: act.elapsed_time || 0,
      totalElevationGain: act.total_elevation_gain || 0,
      averageSpeed: act.average_speed || 0,
      averageHeartrate: act.average_heartrate || null,
      maxHeartrate: act.max_heartrate || null,
      averagePace: averagePace,
      description: descriptions[act.id] || null,
      startDateLocal: act.start_date_local || null,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    count++;
    // Firestore batch limit is 500
    if (count % 450 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }

  await batch.commit();

  // Mark this athlete as auto-sync-fresh for today (used by the client-side
  // once-per-day auto-sync trigger on login / page load).
  await db.collection("users").doc(uid).update({
    stravaLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    synced: count,
    runDocs: runWrites.length,
    runSkipped,
    message: `Synced ${count} activities; ${runWrites.length} runs added to Run Dynamics (${runSkipped} already covered by watch imports).`,
  };
}

// ═══════════════════════════════════════════════════════════
//  purgeStravaData — deletes everything we hold that came from
//  Strava for one athlete: stored tokens, synced activities,
//  and the connection flags on the user doc. Used by the
//  disconnect flow, the deauthorization webhook, and the sync
//  path when it detects a revoked token, so deletion happens
//  immediately (Strava API Agreement requires within 30 days).
// ═══════════════════════════════════════════════════════════
async function purgeStravaData(uid) {
  // Tokens
  await db.collection("users").doc(uid).collection("private").doc("strava").delete();

  // Any webhook-queued import (holds Strava activity ids)
  await db.collection("stravaSyncQueue").doc(uid).delete();

  // Connection flags + disconnect time for audit
  // stravaLastSyncedAt goes too, so a same-day reconnect isn't treated as
  // "already synced today".
  await db.collection("users").doc(uid).update({
    stravaConnected: false,
    stravaAthleteId: null,
    stravaLastSyncedAt: admin.firestore.FieldValue.delete(),
    stravaDisconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Strava-sourced run docs in the athlete's Run Dynamics history
  // (users/{uid}/garminActivities, source == "strava"). Device-imported
  // runs are untouched — they never came from Strava.
  let deletedActivities = 0;
  const runSnap = await db.collection("users").doc(uid)
    .collection("garminActivities")
    .where("source", "==", "strava")
    .get();
  {
    let batch = db.batch();
    let count = 0;
    for (const doc of runSnap.docs) {
      batch.delete(doc.ref);
      count++;
      deletedActivities++;
      if (count % 450 === 0) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
    if (count > 0) await batch.commit();
  }

  // Synced activities on the athlete's training plan
  const planSnap = await db.collection("trainingPlans")
    .where("athleteUid", "==", uid)
    .limit(1)
    .get();

  if (!planSnap.empty) {
    const planId = planSnap.docs[0].id;
    const actSnap = await db.collection("trainingPlans")
      .doc(planId)
      .collection("stravaActivities")
      .get();

    let batch = db.batch();
    let count = 0;
    for (const doc of actSnap.docs) {
      batch.delete(doc.ref);
      count++;
      deletedActivities++;
      // Firestore batch limit is 500
      if (count % 450 === 0) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
    if (count > 0) await batch.commit();
  }

  return deletedActivities;
}

// ═══════════════════════════════════════════════════════════
//  stravaWebhook — Strava push subscription endpoint.
//  GET  = subscription validation handshake (echo hub.challenge).
//  POST = event delivery. We handle:
//    • athlete deauthorization (updates.authorized === "false")
//        → purge all Strava data for that athlete immediately
//    • activity delete → remove our synced copy
//    • activity update (title/type) → update our synced copy
//    • activity create (or re-typed as a run) → queue an import in
//        stravaSyncQueue/{uid}, run by onStravaSyncQueued
//  so stored data always respects the athlete's choices on
//  Strava, per the API Agreement.
//
//  One-time setup after deploy (see docs/strava-compliance.md):
//  create the subscription with callback_url pointing here and
//  verify_token = STRAVA_VERIFY_TOKEN.
// ═══════════════════════════════════════════════════════════
exports.stravaWebhook = onRequest({ cors: false }, async (req, res) => {
  // Subscription validation handshake
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token && token === process.env.STRAVA_VERIFY_TOKEN) {
      res.status(200).json({ "hub.challenge": challenge });
    } else {
      res.status(403).send("Verify token mismatch.");
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method not allowed.");
    return;
  }

  // Always ack quickly with 200 so Strava doesn't retry/disable the
  // subscription; do the work before responding (events are small).
  try {
    const event = req.body || {};
    const athleteId = event.owner_id;

    // Look up every user this Strava athlete id belongs to. A deauth must
    // delete the data everywhere (Strava API Agreement), so no .limit(1).
    const userSnap = await db.collection("users")
      .where("stravaAthleteId", "==", athleteId)
      .get();

    for (const userDocSnap of userSnap.docs) {
      const uid = userDocSnap.id;

      if (event.object_type === "athlete" &&
          event.updates && String(event.updates.authorized) === "false") {
        const deleted = await purgeStravaData(uid);
        console.log(`Webhook: athlete ${athleteId} deauthorized — purged tokens + ${deleted} activities for uid ${uid}`);
      } else if (event.object_type === "activity" && event.object_id) {
        // New upload (or an activity re-typed as a run): queue an import for
        // onStravaSyncQueued instead of syncing here — Strava wants a fast
        // 2xx, and a full sync can take far longer than that.
        const becameRun = event.aspect_type === "update" && event.updates &&
          typeof event.updates.type === "string" && /run/i.test(event.updates.type);
        if ((event.aspect_type === "create" || becameRun) &&
            userDocSnap.get("stravaConnected") === true) {
          await db.collection("stravaSyncQueue").doc(uid).set({
            uid,
            activityIds: admin.firestore.FieldValue.arrayUnion(event.object_id),
            requestedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        const planSnap = await db.collection("trainingPlans")
          .where("athleteUid", "==", uid)
          .limit(1)
          .get();
        if (!planSnap.empty) {
          const actRef = db.collection("trainingPlans")
            .doc(planSnap.docs[0].id)
            .collection("stravaActivities")
            .doc(String(event.object_id));
          if (event.aspect_type === "delete") {
            await actRef.delete();
          } else if (event.aspect_type === "update" && event.updates) {
            const patch = {};
            if (typeof event.updates.title === "string") patch.name = event.updates.title;
            if (typeof event.updates.type === "string") patch.type = event.updates.type;
            if (Object.keys(patch).length) {
              await actRef.set(patch, { merge: true });
            }
          }
        }

        // Run Dynamics doc synced from this activity (keyed by start time,
        // so look it up via the stored stravaId).
        const runQ = await db.collection("users").doc(uid)
          .collection("garminActivities")
          .where("stravaId", "==", event.object_id)
          .limit(1)
          .get();
        if (!runQ.empty) {
          const runRef = runQ.docs[0].ref;
          if (event.aspect_type === "delete") {
            await runRef.delete();
          } else if (event.aspect_type === "update" && event.updates) {
            if (typeof event.updates.type === "string" && !/run/i.test(event.updates.type)) {
              // Re-categorized away from running — no longer belongs here.
              await runRef.delete();
            } else if (typeof event.updates.title === "string") {
              // Renames matter: "Lever" in the title is the manual signal
              // the load model's body-weight-support detection keys off.
              await runRef.set({
                title: event.updates.title,
                leverTitle: /lever/i.test(event.updates.title),
              }, { merge: true });
            }
          }
        }
      }
    }
  } catch (e) {
    // Log but still 200 — a retry storm can get the subscription disabled.
    console.error("stravaWebhook handler error:", e);
  }

  res.status(200).send("EVENT_RECEIVED");
});

// ═══════════════════════════════════════════════════════════
//  onStravaSyncQueued — runs the Strava sync for an athlete
//  whose webhook queued one (stravaSyncQueue/{uid}), so a run
//  uploaded to Strava reaches Run Dynamics / Training Analysis
//  without waiting for the next client-side sync.
//  The queue doc is deleted only if requestedAt is unchanged
//  since we read it: an upload that lands mid-sync re-stamps it
//  and the write fires this trigger again for another pass.
//  A rate-limited sync leaves the doc in place; the next queued
//  event (or client sync) picks the work up.
// ═══════════════════════════════════════════════════════════
exports.onStravaSyncQueued = onDocumentWritten(
  { document: "stravaSyncQueue/{uid}", timeoutSeconds: 300 },
  async (event) => {
    const after = event.data && event.data.after;
    // Deletion (incl. our own cleanup below) — nothing to do; no loop.
    if (!after || !after.exists) return;
    const uid = event.params.uid;
    const queueRef = db.collection("stravaSyncQueue").doc(uid);

    // Re-read now: retries/duplicates may arrive after the doc is gone.
    const snap = await queueRef.get();
    if (!snap.exists) return;
    const requestedAt = snap.get("requestedAt");

    const clearIfUnchanged = () => db.runTransaction(async (tx) => {
      const cur = await tx.get(queueRef);
      if (!cur.exists) return false;
      const t = cur.get("requestedAt");
      const same = (t && requestedAt && typeof t.isEqual === "function")
        ? t.isEqual(requestedAt)
        : t === requestedAt;
      if (!same) return false;
      tx.delete(queueRef);
      return true;
    });

    // Still connected? A deauth/disconnect after queueing means we must not
    // read anything more from Strava for this athlete.
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists || userSnap.get("stravaConnected") !== true) {
      await queueRef.delete();
      return;
    }

    let result;
    try {
      result = await runStravaSync(uid);
    } catch (e) {
      // Not connected / revoked (tokens already purged) / Strava down: drop
      // this request — the client's own sync retries on the next visit.
      console.warn(`onStravaSyncQueued: sync failed for uid ${uid}:`, e && (e.code || ""), e && e.message);
      await clearIfUnchanged();
      return;
    }

    if (result && result.rateLimited && !result.runDocs) {
      console.warn(`onStravaSyncQueued: Strava rate limit for uid ${uid}; leaving queue doc for the next event/sync.`);
      return;
    }

    const cleared = await clearIfUnchanged();
    console.log(`onStravaSyncQueued: uid ${uid} — ${result && result.message}${cleared ? "" : " (re-queued mid-sync; another pass follows)"}`);
  }
);

// ═══════════════════════════════════════════════════════════
//  deauthorizeStrava — Callable function that fully revokes
//  the athlete's Strava connection per Strava API Agreement:
//    1. Calls Strava's /oauth/deauthorize to invalidate the token
//    2. Deletes the stored tokens (private subcollection)
//    3. Deletes all synced activity data on the training plan
//    4. Clears stravaConnected/stravaAthleteId on the user doc
//
//  Best-effort revoke: if Strava's deauth call fails (network,
//  already-revoked, etc.), we still complete local cleanup so
//  the user is never left in a half-disconnected state.
// ═══════════════════════════════════════════════════════════
// Best-effort revoke of a user's Strava token with Strava itself.
// Returns a warning string if the revoke failed, else null. Never
// throws, so callers can always continue with local cleanup.
async function revokeStravaToken(uid) {
  const tokenDoc = await db.collection("users").doc(uid).collection("private").doc("strava").get();
  if (!tokenDoc.exists) return null;
  let { accessToken } = tokenDoc.data();
  const { refreshToken, expiresAt } = tokenDoc.data();
  // Strava rejects an expired access token, which would leave the app
  // authorized; refresh it first (best effort).
  if (refreshToken && expiresAt && Math.floor(Date.now() / 1000) >= expiresAt - 60) {
    try {
      const r = await fetch(STRAVA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d && d.access_token) accessToken = d.access_token;
      }
    } catch (e) {
      console.warn("Strava token refresh before revoke failed:", e && e.message);
    }
  }
  if (!accessToken) return null;
  try {
    const revokeRes = await fetch(STRAVA_DEAUTHORIZE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!revokeRes.ok) {
      const warning = `Strava deauthorize returned HTTP ${revokeRes.status}`;
      console.warn(warning, await revokeRes.text());
      return warning;
    }
  } catch (e) {
    const warning = `Strava deauthorize request error: ${e.message}`;
    console.error(warning);
    return warning;
  }
  return null;
}

exports.deauthorizeStrava = onCall({ cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Sign in to disconnect Strava.");
  }

  // Admin may disconnect on behalf of an athlete; otherwise self-only.
  // Never fall back to disconnecting the caller's own account.
  let uid = callerUid;
  const targetUid = request.data?.athleteUid;
  if (typeof targetUid === "string" && targetUid && targetUid !== callerUid) {
    if (callerUid !== ADMIN_UID) {
      throw new HttpsError("permission-denied", "Only the athlete can disconnect this Strava account.");
    }
    uid = targetUid;
  }

  // Step 1: Revoke token with Strava (best effort)
  const revokeWarning = await revokeStravaToken(uid);

  // Steps 2-4: delete tokens, clear flags, delete synced activities
  const deletedActivities = await purgeStravaData(uid);

  return {
    success: true,
    deletedActivities,
    revokeWarning,
  };
});

// ═══════════════════════════════════════════════════════════
//  onCoachingSubscription -- fires when the Stripe extension
//  writes/updates a subscription doc. If it's an active
//  coaching subscription we haven't notified about yet, write
//  a notification to the admin so they can take the athlete
//  on as a client.
// ═══════════════════════════════════════════════════════════
// Keep in sync with COACHING_PLANS in coaching/index.html. The 4-month
// blocks are recurring (every 4 months) and include a free ESL racing kit.
const COACHING_PRICE_IDS = {
  "price_1TVIadIFO8pppwnFuj3vYy9S": { tier: "Standard", billing: "$175/mo" },
  "price_1UOlXBIFO8pppwnFMym4W83P": { tier: "Full Access", billing: "$275/mo" },
  "price_1UPogpIFO8pppwnFytHL4QA1": { tier: "Standard", billing: "$600 / 4-month block", block: true },
  "price_1UPoiIIFO8pppwnFyugPYaSf": { tier: "Full Access", billing: "$1000 / 4-month block", block: true },
};

// Price IDs on a Stripe-extension subscription or payment doc: `items[].price`
// (line items) and/or `prices[]` (DocumentReferences to products/{p}/prices/{id}).
function extractPriceIds(doc) {
  const ids = [];
  if (Array.isArray(doc.items)) {
    for (const item of doc.items) {
      if (item && item.price && typeof item.price.id === "string") ids.push(item.price.id);
      else if (item && typeof item.price === "string") ids.push(item.price);
    }
  }
  if (Array.isArray(doc.prices)) {
    for (const p of doc.prices) {
      if (p && typeof p.id === "string") ids.push(p.id);
    }
  }
  return ids;
}

// Best-effort display name for admin notifications: the users doc name or
// email, else the Auth account's email, else `fallback`.
async function athleteLabel(uid, fallback) {
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      if (u.displayName || u.email) return u.displayName || u.email;
    }
  } catch (e) {
    // best-effort name lookup
  }
  try {
    const authUser = await admin.auth().getUser(uid);
    if (authUser && (authUser.displayName || authUser.email)) return authUser.displayName || authUser.email;
  } catch (e) {
    // best-effort name lookup
  }
  return fallback;
}

// Firestore Timestamp / seconds / Date -> "Nov 3, 2026" (Mountain time).
function fmtNotifDate(v) {
  let d = null;
  if (v && typeof v.toDate === "function") d = v.toDate();
  else if (typeof v === "number") d = new Date(v * 1000);
  else if (v instanceof Date) d = v;
  if (!d || isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Denver" }).format(d);
}

// Payment-lifecycle change worth an admin bell item, or null. Only real
// transitions count (a doc first written in a bad state is history).
function coachingLifecycleChange(before, after) {
  if (!before || !after) return null;
  const tsKey = (v) => (v && typeof v.seconds === "number" ? v.seconds : typeof v === "number" ? v : "");
  if (after.status !== before.status && ["canceled", "past_due", "unpaid"].includes(after.status)) {
    // past_due/unpaid can recur in a later billing period; alert once per period.
    const period = after.status === "canceled" ? "" : "_" + tsKey(after.current_period_start);
    return { key: after.status + period, status: after.status };
  }
  if (after.cancel_at_period_end === true && before.cancel_at_period_end !== true && after.status !== "canceled") {
    return { key: "cancel_scheduled_" + tsKey(after.current_period_end), status: "cancel_scheduled" };
  }
  return null;
}

exports.onCoachingSubscription = onDocumentWritten(
  "customers/{uid}/subscriptions/{subId}",
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    if (!after) return;

    const priceIds = extractPriceIds(after);
    const matchedPriceId = priceIds.find((id) => COACHING_PRICE_IDS[id]);
    if (!matchedPriceId) return;

    const { tier, billing, block } = COACHING_PRICE_IDS[matchedPriceId];
    const uid = event.params.uid;
    const subId = event.params.subId;

    // Cancellation / failed payment: tell the admin (one bell item per
    // change; deterministic id + create() makes re-fires no-ops).
    const change = coachingLifecycleChange(before, after);
    if (change) {
      const who = await athleteLabel(uid, "An athlete");
      const ends = fmtNotifDate(after.current_period_end);
      let message;
      if (change.status === "cancel_scheduled") {
        message = `${who}'s ${tier} coaching subscription was cancelled` + (ends ? ` — it ends ${ends}.` : ".");
      } else if (change.status === "canceled") {
        message = `${who}'s ${tier} coaching subscription has ended (cancelled).`;
      } else if (change.status === "past_due") {
        message = `${who}'s ${tier} coaching payment failed (past due).`;
      } else {
        message = `${who}'s ${tier} coaching subscription is unpaid — payment attempts have failed.`;
      }
      try {
        await db.collection("notifications").doc(`coaching_sub_${subId}_${change.key}`).create({
          recipientUid: ADMIN_UID,
          type: "coaching_subscription_changed",
          subscriptionId: subId,
          athleteUid: uid,
          tier,
          status: change.status,
          message,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        if (e && e.code !== 6) console.error("Failed to write subscription-change notification:", e);
      }
    }

    if (after.status !== "active" && after.status !== "trialing") return;

    // Deterministic notification ID -- create() is exactly-once, so a
    // status change re-firing the trigger won't double-notify.
    const notifId = `coaching_sub_${subId}`;

    const athleteName = await athleteLabel(uid, "A new user");

    try {
      await db.collection("notifications").doc(notifId).create({
        recipientUid: ADMIN_UID,
        type: "new_coaching_subscription",
        subscriptionId: subId,
        athleteUid: uid,
        tier,
        message: `${athleteName} just subscribed to ${tier} coaching (${billing}). Assign them as your athlete to get started.` +
          (block ? " 4-month block: they get a free ESL racing kit — send them one." : ""),
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // ALREADY_EXISTS -> we've already notified for this subscription
      if (e && e.code !== 6) {
        console.error("Failed to write subscription notification:", e);
      }
    }

    // Sync to MailerLite as a coaching subscriber
    try {
      const userSnap = await db.collection("users").doc(uid).get();
      const u = userSnap.exists ? userSnap.data() : {};
      if (u.email) {
        await mailerliteUpsert({
          email: u.email,
          name: u.displayName || null,
          groups: [process.env.MAILERLITE_GROUP_COACHING].filter(Boolean),
        });
      }
    } catch (e) {
      console.error("MailerLite coaching-subscriber sync failed:", e && e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════
//  MailerLite sync
//  ----------------
//  Capture every signed-up user, then re-tag them when they
//  buy something. Lets us run lifecycle email to free users
//  who never converted, and segment paying users separately.
//
//  Configuration (set via `firebase functions:secrets:set` or
//  `firebase functions:config:set` -> env vars):
//    MAILERLITE_API_KEY          (required to enable sync)
//    MAILERLITE_GROUP_SIGNED_UP  (group id for new accounts)
//    MAILERLITE_GROUP_PASS       (group id for 90-day pass buyers)
//    MAILERLITE_GROUP_COACHING   (group id for coaching subscribers)
//
//  If MAILERLITE_API_KEY is unset the sync is a no-op, so this
//  is safe to deploy before MailerLite is set up.
// ═══════════════════════════════════════════════════════════
const MAILERLITE_BASE = "https://connect.mailerlite.com/api";

async function mailerliteUpsert({ email, name, groups }) {
  const apiKey = process.env.MAILERLITE_API_KEY;
  if (!apiKey) return;
  if (!email) return;

  const fields = {};
  if (name) {
    const parts = name.trim().split(/\s+/);
    fields.name = parts[0];
    if (parts.length > 1) fields.last_name = parts.slice(1).join(" ");
  }

  const body = {
    email,
    status: "active",
    fields,
  };
  if (Array.isArray(groups) && groups.length) body.groups = groups;

  try {
    const res = await fetch(`${MAILERLITE_BASE}/subscribers`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`MailerLite upsert failed (${res.status}) for ${email}:`, txt);
    }
  } catch (e) {
    console.error(`MailerLite upsert error for ${email}:`, e && e.message);
  }
}

// Fires once per new user document. Pushes the email to MailerLite
// tagged as "signed up" so we can re-engage non-purchasers later.
exports.onUserSignup = onDocumentCreated("users/{uid}", async (event) => {
  const u = event.data && event.data.data();
  if (!u || !u.email) return;
  // Skip the admin so internal accounts don't pollute the list
  if (event.params.uid === ADMIN_UID) return;

  await mailerliteUpsert({
    email: u.email,
    name: u.displayName || null,
    groups: [process.env.MAILERLITE_GROUP_SIGNED_UP].filter(Boolean),
  });
});

// Stripe extension writes successful payments to customers/{uid}/payments/{id}.
// When a payment lands in succeeded state, tag the user in MailerLite as a pass buyer.
exports.onPassPayment = onDocumentCreated(
  "customers/{uid}/payments/{paymentId}",
  async (event) => {
    const p = event.data && event.data.data();
    if (!p) return;
    if (p.status !== "succeeded") return;

    const uid = event.params.uid;

    // A paid in-person metabolic test: tell the admin so they can schedule it.
    if (extractPriceIds(p).includes(METLAB_INPERSON_PRICE_ID)) {
      const who = await athleteLabel(uid, "Someone");
      const amount = typeof p.amount === "number" && p.amount > 0
        ? ` ($${(p.amount / 100).toFixed(p.amount % 100 ? 2 : 0)})` : "";
      try {
        await db.collection("notifications").doc(`in_person_paid_${event.params.paymentId}`).create({
          recipientUid: ADMIN_UID,
          type: "in_person_paid",
          athleteUid: uid,
          paymentId: event.params.paymentId,
          message: `${who} paid for an in-person metabolic test${amount}.`,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        if (e && e.code !== 6) console.error("Failed to write in-person payment notification:", e);
      }
    }

    try {
      const userSnap = await db.collection("users").doc(uid).get();
      const u = userSnap.exists ? userSnap.data() : {};
      if (!u.email) return;
      await mailerliteUpsert({
        email: u.email,
        name: u.displayName || null,
        groups: [process.env.MAILERLITE_GROUP_PASS].filter(Boolean),
      });
    } catch (e) {
      console.error("MailerLite pass-payment sync failed:", e && e.message);
    }
  }
);

// YYYY-MM-DD in the caller's local time. tzOffsetMin is the client's
// new Date().getTimezoneOffset() (minutes, positive west of UTC); anything
// invalid falls back to UTC.
function localDateISO(tzOffsetMin) {
  const off = typeof tzOffsetMin === "number" && isFinite(tzOffsetMin) && tzOffsetMin >= -840 && tzOffsetMin <= 840
    ? tzOffsetMin : 0;
  return new Date(Date.now() - off * 60000).toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════
//  Pass verification: mirrors the client-side three-source
//  check (paid Stripe pass / admin grant / Premium coaching
//  subscription) but reads via the admin SDK so it cannot be
//  spoofed from the browser. Used to gate report PDF rendering.
// ═══════════════════════════════════════════════════════════
async function verifyActivePass(uid) {
  if (uid === ADMIN_UID) return true;

  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Paid pass: a succeeded esFormLab pass payment within PASS_DURATION_SEC.
  try {
    const paymentsSnap = await db.collection("customers").doc(uid).collection("payments").get();
    for (const doc of paymentsSnap.docs) {
      const p = doc.data();
      if (p.status !== "succeeded") continue;
      if (!extractPriceIds(p).some((id) => ESFORMLAB_PASS_PRICE_IDS.includes(id))) continue;
      const c = p.created;
      const createdSec = typeof c === "number" ? c : c && typeof c.seconds === "number" ? c.seconds : null;
      if (createdSec === null) continue;
      if (nowSec - createdSec < PASS_DURATION_SEC) return true;
    }
  } catch (e) {
    console.warn("verifyActivePass payments check failed:", e && e.message);
  }

  // 2. Admin grant: users/{uid}.features.esFormLab === true OR formAnalyzerPassUntil > now.
  //    Firestore rules only let the admin set these fields (protectedUserFields).
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      if (u.features && u.features.esFormLab === true) return true;
      const until = u.formAnalyzerPassUntil;
      const untilSec = typeof until === "number" ? until : until && typeof until.seconds === "number" ? until.seconds : null;
      if (untilSec !== null && untilSec > nowSec) return true;
    }
  } catch (e) {
    console.warn("verifyActivePass user-doc check failed:", e && e.message);
  }

  // 3. Premium coaching subscription bundles esFormLab access.
  try {
    const subsSnap = await db.collection("customers").doc(uid).collection("subscriptions").get();
    for (const doc of subsSnap.docs) {
      const sub = doc.data();
      if (sub.status !== "active" && sub.status !== "trialing") continue;
      if (extractPriceIds(sub).some((id) => COACHING_PREMIUM_PRICE_IDS.includes(id))) return true;
    }
  } catch (e) {
    console.warn("verifyActivePass subscription check failed:", e && e.message);
  }

  return false;
}

// ═══════════════════════════════════════════════════════════
//  generateFormReport — server-rendered PDF. The client sends
//  the analysis payload (phases + detected issues + sex +
//  athlete name); we verify the caller has an active pass and
//  render the PDF using a Node port of the old browser
//  downloadReport(). Returns the PDF as base64 for the client
//  to save as a Blob.
// ═══════════════════════════════════════════════════════════
exports.generateFormReport = onCall({ cors: true, memory: "512MiB" }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to download the report.");
  }

  const hasPass = await verifyActivePass(uid);
  if (!hasPass) {
    throw new HttpsError("permission-denied", "An active esFormLab pass is required to download the report.");
  }

  const data = request.data || {};
  const phases = data.phases && typeof data.phases === "object" ? data.phases : {};
  const lastIssues = data.lastIssues && typeof data.lastIssues === "object" ? data.lastIssues : null;
  if (!lastIssues) {
    throw new HttpsError("invalid-argument", "Complete an analysis before downloading the report.");
  }
  const selectedSex = data.selectedSex === "male" || data.selectedSex === "female" ? data.selectedSex : null;
  const athleteName = typeof data.athleteName === "string" ? data.athleteName : "";
  // Optional (newer clients): the saved/entered session name + date, and the
  // caller's timezone offset so "Generated" is the user's local date. Each is
  // validated and ignored when invalid.
  const sessionName = typeof data.sessionName === "string" && data.sessionName.trim().length <= 120
    ? data.sessionName.trim() : "";
  const sessionDate = typeof data.sessionDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.sessionDate)
    ? data.sessionDate : "";
  const generatedISO = localDateISO(data.tzOffsetMin);

  // Optional per-phase captured-frame screenshots (JPEG data URLs), passed in the
  // request payload rather than persisted. Validate shape/size so a malformed or
  // oversized payload can't bloat memory: only base64 image data URLs, capped in
  // count and per-image length.
  const rawImages = data.images && typeof data.images === "object" ? data.images : {};
  const images = {};
  const MAX_IMAGES = 12;
  const MAX_IMG_LEN = 400000; // ~300KB decoded per image
  let imgCount = 0;
  for (const k of Object.keys(rawImages)) {
    if (imgCount >= MAX_IMAGES) break;
    const v = rawImages[k];
    if (typeof v === "string" &&
        /^data:image\/(jpeg|png);base64,/.test(v) &&
        v.length <= MAX_IMG_LEN) {
      images[k] = v;
      imgCount++;
    }
  }

  // Pull the same computed_ranges docs the browser uses, via admin SDK.
  // Anyone can read these (rules allow read:true), but we fetch server-side
  // so the renderer is fully self-contained.
  const liveRanges = { male: null, female: null, combined: null };
  const rangeMeta = { male: null, female: null };
  try {
    const reads = await Promise.all([
      db.collection("computed_ranges").doc("male").get(),
      db.collection("computed_ranges").doc("female").get(),
      db.collection("computed_ranges").doc("combined").get(),
    ]);
    // The computed_ranges docs are structured { phases: { <phaseKey>: { <metricKey>: {...} } } }.
    // The renderer expects the inner `.phases` map, matching how the client populates liveRanges.
    if (reads[0].exists) liveRanges.male = reads[0].data().phases || null;
    if (reads[1].exists) liveRanges.female = reads[1].data().phases || null;
    if (reads[2].exists) liveRanges.combined = reads[2].data().phases || null;
    // Reference-set size for the cover line ("Female elite runners (7 sessions)").
    if (reads[0].exists && typeof reads[0].data().sampleCount === "number") rangeMeta.male = reads[0].data().sampleCount;
    if (reads[1].exists && typeof reads[1].data().sampleCount === "number") rangeMeta.female = reads[1].data().sampleCount;
  } catch (e) {
    console.warn("computed_ranges fetch failed, falling back to defaults:", e && e.message);
  }

  let buf;
  try {
    buf = renderReport({
      athleteName, sessionName, sessionDate, generatedISO, rangeMeta,
      selectedSex, phases, lastIssues, liveRanges, images,
    });
  } catch (e) {
    console.error("renderReport failed:", e);
    throw new HttpsError("internal", "We couldn't create the report PDF. Please try again.");
  }

  const slug = sessionName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return {
    pdfBase64: buf.toString("base64"),
    filename: "esformlab-report-" + slug + (slug ? "-" : "") + (sessionDate || generatedISO) + ".pdf",
  };
});

// ═══════════════════════════════════════════════════════════
//  generateComparisonReport — server-rendered comparison PDF.
//  Caller passes the two analysis IDs (idA, idB) from their
//  own users/{uid}/analyses subcollection. We verify (a) the
//  caller has an active esFormLab pass, and (b) both analyses
//  exist under the caller's uid (admin UID may override by
//  passing ownerUid to compare another user's analyses).
// ═══════════════════════════════════════════════════════════
exports.generateComparisonReport = onCall({ cors: true, memory: "512MiB" }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to download the comparison report.");
  }

  const hasPass = await verifyActivePass(uid);
  if (!hasPass) {
    throw new HttpsError("permission-denied", "An active esFormLab pass is required to download the comparison report.");
  }

  const data = request.data || {};
  const idA = typeof data.idA === "string" ? data.idA : null;
  const idB = typeof data.idB === "string" ? data.idB : null;
  if (!idA || !idB) throw new HttpsError("invalid-argument", "Pick two saved analyses to compare.");
  if (idA === idB) throw new HttpsError("invalid-argument", "Pick two different analyses to compare.");

  // Default to the caller's own subcollection. Admin may pass ownerUid to compare a different user's saved analyses.
  const ownerUid = (uid === ADMIN_UID && typeof data.ownerUid === "string" && data.ownerUid) ? data.ownerUid : uid;

  let aSnap, bSnap;
  try {
    [aSnap, bSnap] = await Promise.all([
      db.collection("users").doc(ownerUid).collection("analyses").doc(idA).get(),
      db.collection("users").doc(ownerUid).collection("analyses").doc(idB).get(),
    ]);
  } catch (e) {
    console.error("comparison analyses fetch failed:", e && e.message);
    throw new HttpsError("internal", "Could not load the selected analyses.");
  }
  if (!aSnap.exists || !bSnap.exists) {
    throw new HttpsError("not-found", "One or both selected analyses were not found.");
  }
  const dA = aSnap.data();
  const dB = bSnap.data();

  const liveRanges = { male: null, female: null, combined: null };
  try {
    const reads = await Promise.all([
      db.collection("computed_ranges").doc("male").get(),
      db.collection("computed_ranges").doc("female").get(),
      db.collection("computed_ranges").doc("combined").get(),
    ]);
    if (reads[0].exists) liveRanges.male = reads[0].data().phases || null;
    if (reads[1].exists) liveRanges.female = reads[1].data().phases || null;
    if (reads[2].exists) liveRanges.combined = reads[2].data().phases || null;
  } catch (e) {
    console.warn("computed_ranges fetch failed, falling back to defaults:", e && e.message);
  }

  let buf;
  try {
    buf = renderComparisonReport({ dA, dB, liveRanges, generatedISO: localDateISO(data.tzOffsetMin) });
  } catch (e) {
    console.error("renderComparisonReport failed:", e);
    throw new HttpsError("internal", "We couldn't create the comparison PDF. Please try again.");
  }

  const isoOr = (v, fb) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fb);
  return {
    pdfBase64: buf.toString("base64"),
    filename: "esformlab-comparison-" + isoOr(dA.date, "a") + "-vs-" + isoOr(dB.date, "b") + ".pdf",
  };
});

// ═══════════════════════════════════════════════════════════
//  listAllUsers — admin-only directory for the Manage Users
//  page. The client SDK cannot enumerate Firebase Auth, and
//  not every Auth account has a users/{uid} Firestore doc
//  (docs are created lazily). This merges every Auth account
//  with its Firestore doc (if any) so the admin sees everyone.
// ═══════════════════════════════════════════════════════════
exports.listAllUsers = onCall({ cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  if (callerUid !== ADMIN_UID) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  // 1. Every Firestore users/{uid} doc, keyed by uid.
  const docsByUid = {};
  const usersSnap = await db.collection("users").get();
  usersSnap.forEach((doc) => { docsByUid[doc.id] = doc.data() || {}; });

  // 2. Every Firebase Auth account (paginated, 1000 per page).
  const authByUid = {};
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    page.users.forEach((u) => { authByUid[u.uid] = u; });
    pageToken = page.pageToken;
  } while (pageToken);

  const toSec = (t) => {
    if (!t) return null;
    if (typeof t === "number") return t;
    if (typeof t.seconds === "number") return t.seconds;
    if (typeof t.toDate === "function") {
      try { return Math.floor(t.toDate().getTime() / 1000); } catch (e) { return null; }
    }
    if (typeof t === "string") {
      const ms = Date.parse(t);
      return isNaN(ms) ? null : Math.floor(ms / 1000);
    }
    return null;
  };

  // Recursively convert Firestore Timestamps to unix seconds so the whole
  // doc is JSON-serializable over the callable transport.
  const sanitize = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v === "object" && typeof v.toMillis === "function" && typeof v.seconds === "number") {
      return Math.floor(v.toMillis() / 1000);
    }
    if (Array.isArray(v)) return v.map(sanitize);
    if (typeof v === "object") {
      const out = {};
      Object.keys(v).forEach((k) => { out[k] = sanitize(v[k]); });
      return out;
    }
    return v;
  };

  // 2b. Coaching status for Manage Users (the admin client can't read
  //     customers/*): the live coaching subscription's tier, and whether a
  //     coaching request is pending. Best-effort; missing → null/false.
  const coachingByUid = {};
  const pendingRequestUids = new Set();
  try {
    const subsSnap = await db.collectionGroup("subscriptions").get();
    subsSnap.forEach((doc) => {
      const parent = doc.ref.parent.parent;
      if (!parent || doc.ref.parent.parent.parent.id !== "customers") return;
      const sub = doc.data() || {};
      if (!["active", "trialing", "past_due"].includes(sub.status)) return;
      const priceId = extractPriceIds(sub).find((id) => COACHING_PRICE_IDS[id]);
      if (!priceId) return;
      const prev = coachingByUid[parent.id];
      // Prefer a healthy subscription over a past-due one.
      if (!prev || (prev.status === "past_due" && sub.status !== "past_due")) {
        coachingByUid[parent.id] = { tier: COACHING_PRICE_IDS[priceId].tier, status: sub.status };
      }
    });
  } catch (e) {
    console.warn("listAllUsers: subscription scan failed:", e && e.message);
  }
  try {
    const reqSnap = await db.collection("coachingRequests").where("status", "==", "pending").get();
    reqSnap.forEach((doc) => { const a = doc.get("athleteUid"); if (a) pendingRequestUids.add(a); });
  } catch (e) {
    console.warn("listAllUsers: pending-request scan failed:", e && e.message);
  }

  // 3. Merge — union of both keyspaces so orphan docs and
  //    profile-less Auth accounts both show up.
  const allUids = new Set([...Object.keys(authByUid), ...Object.keys(docsByUid)]);
  const users = [];
  allUids.forEach((uid) => {
    const a = authByUid[uid] || null;
    const d = docsByUid[uid] || null;
    const authCreated = a && a.metadata ? toSec(a.metadata.creationTime) : null;
    const authLastSignIn = a && a.metadata ? toSec(a.metadata.lastSignInTime) : null;
    // Start from the full Firestore doc so no field (stravaConnected,
    // raceName, raceDate, etc.) is silently dropped, then overlay the
    // normalized identity/auth fields and a serializable createdAt.
    const merged = d ? sanitize(d) : {};
    Object.assign(merged, {
      uid,
      email: (d && d.email) || (a && a.email) || "",
      displayName: (d && d.displayName) || (a && a.displayName) || "",
      photoURL: (a && a.photoURL) || (d && d.photoURL) || "",
      role: d && d.role === "coach" ? "coach" : "athlete",
      coachUid: (d && d.coachUid) || null,
      features: (d && d.features) || {},
      hasDoc: !!d,
      hasAuth: !!a,
      disabled: a ? !!a.disabled : false,
      createdAt: toSec(d && d.createdAt) || authCreated || null,
      lastSignInAt: authLastSignIn,
      // Tier code matches the admin client ("premium" | "standard" | null);
      // the display label rides alongside ("Full Access" | "Standard").
      coachingTier: coachingByUid[uid]
        ? (coachingByUid[uid].tier === "Full Access" ? "premium" : "standard") : null,
      coachingTierLabel: coachingByUid[uid] ? coachingByUid[uid].tier : null,
      coachingStatus: coachingByUid[uid] ? coachingByUid[uid].status : null,   // "active" | "trialing" | "past_due" | null
      pendingRequest: pendingRequestUids.has(uid),
      coachingRequestPending: pendingRequestUids.has(uid),                     // alias of pendingRequest
    });
    users.push(merged);
  });

  return { users };
});

// ═══════════════════════════════════════════════════════════
//  adminAssignCoach — admin-only coach (re)assignment (owner
//  decision D8: admin-run, plans move). One batch:
//    - users/{athlete}.coachUid = coachUid (null = unassign)
//    - when assigning: the athlete's training plans move to the
//      new coach (trainingPlans rules don't let any client change
//      coachUid), pending coaching requests are closed as
//      accepted (and their admin bell items resolved), and the
//      athlete gets a coaching_accepted bell item.
//  Unassigning leaves plans untouched and sends nothing.
//  Clients feature-detect: not-found (not deployed) → keep the
//  old users.coachUid-only write.
// ═══════════════════════════════════════════════════════════
exports.adminAssignCoach = onCall({ cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Sign in first.");
  if (callerUid !== ADMIN_UID) throw new HttpsError("permission-denied", "Only the admin can assign coaches.");

  const athleteUid = request.data?.athleteUid;
  const rawCoach = request.data?.coachUid;
  const coachUid = rawCoach === null || rawCoach === undefined || rawCoach === "" ? null : rawCoach;
  if (typeof athleteUid !== "string" || !athleteUid) throw new HttpsError("invalid-argument", "Pick an athlete.");
  if (coachUid !== null && typeof coachUid !== "string") throw new HttpsError("invalid-argument", "Pick a coach.");
  if (coachUid === athleteUid) throw new HttpsError("invalid-argument", "An athlete can't coach themselves.");

  const athleteRef = db.collection("users").doc(athleteUid);
  const athleteSnap = await athleteRef.get();
  if (!athleteSnap.exists) throw new HttpsError("not-found", "That athlete no longer exists.");
  if (coachUid !== null && coachUid !== ADMIN_UID) {
    const coachSnap = await db.collection("users").doc(coachUid).get();
    if (!coachSnap.exists || coachSnap.data().role !== "coach") {
      throw new HttpsError("failed-precondition", "That account isn't a coach. Make them a coach first.");
    }
  }

  const prevCoach = athleteSnap.data().coachUid || null;
  if (prevCoach === coachUid) return { changed: false, plansMoved: 0, requestsClosed: 0 };

  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.update(athleteRef, { coachUid });
  let plansMoved = 0;
  let requestsClosed = 0;

  if (coachUid !== null) {
    const plansSnap = await db.collection("trainingPlans").where("athleteUid", "==", athleteUid).get();
    plansSnap.docs.forEach((p) => {
      if (p.data().coachUid === coachUid) return;
      batch.update(p.ref, { coachUid, updatedAt: now });
      plansMoved++;
    });

    const reqSnap = await db.collection("coachingRequests").where("athleteUid", "==", athleteUid).get();
    const pendingIds = reqSnap.docs.filter((r) => r.data().status === "pending").map((r) => r.id);
    reqSnap.docs.forEach((r) => {
      if (r.data().status !== "pending") return;
      batch.update(r.ref, { status: "accepted" });
      requestsClosed++;
    });
    for (let i = 0; i < pendingIds.length; i += 30) {
      const nSnap = await db.collection("notifications").where("requestId", "in", pendingIds.slice(i, i + 30)).get();
      nSnap.docs.forEach((n) => batch.update(n.ref, { status: "accepted", read: true }));
    }

    const coachName = await athleteLabel(coachUid, "Your new coach");
    batch.set(db.collection("notifications").doc(), {
      recipientUid: athleteUid,
      type: "coaching_accepted",
      message: requestsClosed
        ? `Your coaching request has been accepted — ${coachName} is your coach. Your training plan is ready.`
        : `${coachName} is now your coach.` + (plansMoved ? " Your training plan moved with you." : ""),
      read: false,
      createdAt: now,
    });
  }

  await batch.commit();
  console.log(`adminAssignCoach: ${athleteUid} ${prevCoach || "-"} -> ${coachUid || "-"} (plans=${plansMoved}, requests=${requestsClosed})`);
  return { changed: true, plansMoved, requestsClosed };
});

// ═══════════════════════════════════════════════════════════
//  adminDeleteUser — admin-only, permanent account deletion
//  for the Manage Users page. Removes everything stored for
//  the user, then the Firebase Auth account itself:
//    - Strava token revoked with Strava (best effort)
//    - Garmin Connect link ended with Garmin (best effort) and
//      its Garmin-user mapping removed
//    - users/{uid} and all its subcollections
//    - training plans where they are the athlete (+ workouts,
//      lifting weeks, synced activities)
//    - notifications addressed to them or sent by them (incl.
//      their coaching-request items)
//    - coaching requests they sent or received
//    - customers/{uid} (Stripe extension mirror)
//    - the Firebase Auth account
//  Athletes coached by a deleted coach are unassigned.
//  Refuses while the user has an active Stripe subscription,
//  since deleting the account would not stop Stripe billing.
// ═══════════════════════════════════════════════════════════
exports.adminDeleteUser = onCall({ cors: true, timeoutSeconds: 300 }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  if (callerUid !== ADMIN_UID) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  const uid = request.data?.uid;
  if (typeof uid !== "string" || !uid) {
    throw new HttpsError("invalid-argument", "A user id is required.");
  }
  if (uid === ADMIN_UID) {
    throw new HttpsError("failed-precondition", "The admin account cannot be deleted.");
  }

  // Block while Stripe would keep charging them.
  const subsSnap = await db.collection("customers").doc(uid)
    .collection("subscriptions")
    .where("status", "in", ["active", "trialing", "past_due"])
    .get();
  if (!subsSnap.empty) {
    throw new HttpsError(
      "failed-precondition",
      "This user has an active Stripe subscription. Cancel it in Stripe first, then delete the user."
    );
  }

  const stravaWarning = await revokeStravaToken(uid);
  // Before users/{uid} goes: ending the Garmin link needs the stored token.
  const garminWarning = await garmin.endGarminLinkForDeletion(uid);

  // Coach being deleted: unassign their athletes.
  const athletesSnap = await db.collection("users").where("coachUid", "==", uid).get();
  for (const doc of athletesSnap.docs) {
    await doc.ref.update({ coachUid: null });
  }

  const queryRefs = async (q) => (await q.get()).docs.map((d) => d.ref);
  const requestRefs = [
    ...await queryRefs(db.collection("coachingRequests").where("athleteUid", "==", uid)),
    ...await queryRefs(db.collection("coachingRequests").where("coachUid", "==", uid)),
  ];
  // coaching_request bell items carry the request id but no senderUid, so
  // find them by requestId (`in` takes up to 30 values per query).
  const reqIds = [...new Set(requestRefs.map((r) => r.id))];
  const requestNotifRefs = [];
  for (let i = 0; i < reqIds.length; i += 30) {
    requestNotifRefs.push(...await queryRefs(
      db.collection("notifications").where("requestId", "in", reqIds.slice(i, i + 30))));
  }
  const byPath = new Map();
  [
    ...await queryRefs(db.collection("trainingPlans").where("athleteUid", "==", uid)),
    ...await queryRefs(db.collection("notifications").where("recipientUid", "==", uid)),
    // bug reports, contact messages and in-person requests they sent
    ...await queryRefs(db.collection("notifications").where("senderUid", "==", uid)),
    ...requestNotifRefs,
    ...requestRefs,
  ].forEach((ref) => byPath.set(ref.path, ref));
  const topLevelRefs = [...byPath.values()];
  // recursiveDelete also removes each doc's subcollections.
  for (const ref of topLevelRefs) {
    await db.recursiveDelete(ref);
  }
  await db.recursiveDelete(db.collection("users").doc(uid));
  await db.recursiveDelete(db.collection("customers").doc(uid));

  let authDeleted = true;
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw new HttpsError("internal", `Data deleted, but the sign-in account could not be: ${e.message}`);
    authDeleted = false;
  }

  console.log(`adminDeleteUser: deleted ${uid} (docs=${topLevelRefs.length}, athletesUnassigned=${athletesSnap.size}, auth=${authDeleted})`);
  return {
    success: true,
    athletesUnassigned: athletesSnap.size,
    stravaWarning,
    garminWarning,
  };
});
Object.assign(exports, garmin);
