const { onRequest } = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const SITE_URL = "http://endurancesciencelabs.com/coaching.html";

// ═══════════════════════════════════════════════════════════
//  stravaCallback — HTTPS endpoint that Strava redirects to
//  after the athlete authorizes. Exchanges code for tokens,
//  stores them securely, redirects back to coaching.html.
// ═══════════════════════════════════════════════════════════
exports.stravaCallback = onRequest({ cors: false }, async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    res.status(400).send("Missing code or state parameter.");
    return;
  }

  // state = "uid:nonce"
  const parts = state.split(":");
  if (parts.length !== 2) {
    res.status(400).send("Invalid state parameter.");
    return;
  }
  const [uid, nonce] = parts;

  // Verify user exists
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    res.status(400).send("User not found.");
    return;
  }

  // Exchange authorization code for tokens
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.status(500).send("Strava credentials not configured.");
    return;
  }

  try {
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
      res.redirect(`${SITE_URL}?strava=error`);
      return;
    }

    const tokenData = await tokenRes.json();

    // Store tokens in a private subcollection (not readable by client)
    await db.collection("users").doc(uid).collection("private").doc("strava").set({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_at,
      athleteId: tokenData.athlete?.id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update public user doc
    await db.collection("users").doc(uid).update({
      stravaConnected: true,
      stravaAthleteId: tokenData.athlete?.id || null,
    });

    res.redirect(`${SITE_URL}?strava=connected`);
  } catch (err) {
    console.error("Strava callback error:", err);
    res.redirect(`${SITE_URL}?strava=error`);
  }
});

// ═══════════════════════════════════════════════════════════
//  syncStravaActivities — Callable function that fetches
//  recent Strava activities and writes them to Firestore.
//  Called by the client after connecting or via a sync button.
// ═══════════════════════════════════════════════════════════
exports.syncStravaActivities = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  // Read stored tokens
  const tokenDoc = await db.collection("users").doc(uid).collection("private").doc("strava").get();
  if (!tokenDoc.exists) {
    throw new HttpsError("not-found", "Strava not connected.");
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
      console.error("Token refresh failed:", await refreshRes.text());
      throw new HttpsError("internal", "Failed to refresh Strava token.");
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

  // Fetch activities from the last 120 days
  const after = Math.floor(Date.now() / 1000) - 120 * 24 * 60 * 60;
  let allActivities = [];
  let page = 1;

  while (page <= 5) {
    const url = `${STRAVA_ACTIVITIES_URL}?after=${after}&per_page=100&page=${page}`;
    const actRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!actRes.ok) {
      console.error("Strava activities fetch failed:", await actRes.text());
      break;
    }

    const activities = await actRes.json();
    if (!activities.length) break;
    allActivities = allActivities.concat(activities);
    page++;
  }

  // Find the user's training plan
  const planSnap = await db.collection("trainingPlans")
    .where("athleteUid", "==", uid)
    .limit(1)
    .get();

  if (planSnap.empty) {
    throw new HttpsError("not-found", "No training plan found.");
  }

  const planId = planSnap.docs[0].id;

  // Fetch descriptions for recent runs (last 7 days only, to limit API calls)
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const recentRunIds = allActivities
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

  const batch = db.batch();
  let count = 0;

  for (const act of allActivities) {
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
    }
  }

  await batch.commit();

  return { synced: count, message: `Synced ${count} activities.` };
});
