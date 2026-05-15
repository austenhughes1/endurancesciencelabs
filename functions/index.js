const { onRequest } = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const SITE_URL = "https://endurancesciencelabs.com/coaching/";
const ADMIN_UID = "2z9Z3K5ZwShvadUuqZmwMv0s1Od2";

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
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  // Allow coach to sync on behalf of an athlete (uses module-level ADMIN_UID)
  let uid = callerUid;
  if (request.data?.athleteUid && callerUid === ADMIN_UID) {
    uid = request.data.athleteUid;
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

  // Mark this athlete as auto-sync-fresh for today (used by the client-side
  // once-per-day auto-sync trigger on login / page load).
  await db.collection("users").doc(uid).update({
    stravaLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { synced: count, message: `Synced ${count} activities.` };
});

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
exports.deauthorizeStrava = onCall({ cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  // Allow admin to deauthorize on behalf of an athlete; otherwise self-only
  let uid = callerUid;
  if (request.data?.athleteUid && callerUid === ADMIN_UID) {
    uid = request.data.athleteUid;
  }

  const tokenDocRef = db.collection("users").doc(uid).collection("private").doc("strava");
  const tokenDoc = await tokenDocRef.get();

  let revokeWarning = null;

  // Step 1: Revoke token with Strava (best effort)
  if (tokenDoc.exists) {
    const { accessToken } = tokenDoc.data();
    if (accessToken) {
      try {
        const revokeRes = await fetch(STRAVA_DEAUTHORIZE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!revokeRes.ok) {
          revokeWarning = `Strava deauthorize returned HTTP ${revokeRes.status}`;
          console.warn(revokeWarning, await revokeRes.text());
        }
      } catch (e) {
        revokeWarning = `Strava deauthorize request error: ${e.message}`;
        console.error(revokeWarning);
      }
    }
    // Step 2: Delete stored tokens regardless of revoke outcome
    await tokenDocRef.delete();
  }

  // Step 3: Clear public user-doc flags + record disconnect time for audit
  await db.collection("users").doc(uid).update({
    stravaConnected: false,
    stravaAthleteId: null,
    stravaDisconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Step 4: Delete all synced Strava activity data on the user's training plan
  let deletedActivities = 0;
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
const COACHING_PRICE_IDS = {
  "price_1TVIadIFO8pppwnFuj3vYy9S": "Standard",
  "price_1TVJJuIFO8pppwnF5uECviT3": "Full Access",
};
const COACHING_PRICE_AMOUNTS = {
  "Standard": 145,
  "Full Access": 245,
};

function extractSubscriptionPriceIds(sub) {
  const ids = [];
  if (Array.isArray(sub.items)) {
    for (const item of sub.items) {
      if (item.price && typeof item.price.id === "string") ids.push(item.price.id);
      else if (typeof item.price === "string") ids.push(item.price);
    }
  }
  if (Array.isArray(sub.prices)) {
    for (const p of sub.prices) {
      if (p && typeof p.id === "string") ids.push(p.id);
    }
  }
  return ids;
}

exports.onCoachingSubscription = onDocumentWritten(
  "customers/{uid}/subscriptions/{subId}",
  async (event) => {
    const after = event.data && event.data.after && event.data.after.data();
    if (!after) return;
    if (after.status !== "active" && after.status !== "trialing") return;

    const priceIds = extractSubscriptionPriceIds(after);
    const matchedPriceId = priceIds.find((id) => COACHING_PRICE_IDS[id]);
    if (!matchedPriceId) return;

    const tier = COACHING_PRICE_IDS[matchedPriceId];
    const amount = COACHING_PRICE_AMOUNTS[tier];
    const uid = event.params.uid;
    const subId = event.params.subId;

    // Deterministic notification ID -- create() is exactly-once, so a
    // status change re-firing the trigger won't double-notify.
    const notifId = `coaching_sub_${subId}`;

    let athleteName = "A new user";
    try {
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const u = userSnap.data();
        athleteName = u.displayName || u.email || athleteName;
      }
    } catch (e) {
      // best-effort name lookup
    }

    try {
      await db.collection("notifications").doc(notifId).create({
        recipientUid: ADMIN_UID,
        type: "new_coaching_subscription",
        subscriptionId: subId,
        athleteUid: uid,
        tier,
        message: `${athleteName} just subscribed to ${tier} coaching ($${amount}/mo). Assign them as your athlete to get started.`,
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
