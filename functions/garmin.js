// Garmin Connect link for Running Dynamics: OAuth (PKCE), push intake, the
// inbox worker, disconnect, token upkeep and purge. Garmin runs land in
// users/{uid}/garminActivities with source "garmin".
"use strict";
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
const lib = require("./garmin-lib");

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const SITE_URL = "https://endurancesciencelabs.com/coaching/";
const GARMIN_REDIRECT_URI = "https://us-central1-es-form-labs.cloudfunctions.net/garminCallback";
const GARMIN_AUTH_URL = "https://connect.garmin.com/oauth2Confirm";
const GARMIN_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const GARMIN_USER_URL = "https://apis.garmin.com/partner-gateway/rest/user";
const AUTH_TTL_MS = 15 * 60 * 1000;
const TOKEN_MARGIN_MS = 10 * 60 * 1000;
const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function creds() {
  const clientId = process.env.GARMIN_CLIENT_ID, clientSecret = process.env.GARMIN_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function privRef(uid) { return db.collection("users").doc(uid).collection("private").doc("garmin"); }

// Token endpoint call; stores nothing. Throws on failure.
async function garminToken(params) {
  const c = creds();
  if (!c) throw new Error("garmin credentials not configured");
  const body = new URLSearchParams(Object.assign({ client_id: c.clientId, client_secret: c.clientSecret }, params));
  const r = await fetch(GARMIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`garmin token HTTP ${r.status}`);
  return r.json();
}

function tokenFields(tok) {
  const now = Date.now();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: now + Number(tok.expires_in || 0) * 1000,
    refreshExpiresAt: now + Number(tok.refresh_token_expires_in || 0) * 1000,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function userApi(method, pathName, accessToken) {
  return fetch(`${GARMIN_USER_URL}/${pathName}`, { method, headers: { Authorization: `Bearer ${accessToken}` } });
}

// A usable access token for uid, refreshing when it is near expiry. null when
// there is no link or the refresh token has lapsed.
async function getValidAccessToken(uid) {
  const snap = await privRef(uid).get();
  if (!snap.exists) return null;
  const p = snap.data();
  if (p.accessToken && p.expiresAt - TOKEN_MARGIN_MS > Date.now()) return p.accessToken;
  if (!p.refreshToken || !(p.refreshExpiresAt > Date.now())) return null;
  try {
    const tok = await garminToken({ grant_type: "refresh_token", refresh_token: p.refreshToken });
    await privRef(uid).set(tokenFields(tok), { merge: true });
    return tok.access_token;
  } catch (e) {
    console.warn(`garmin refresh failed for uid ${uid}: ${e.message}`);
    return null;
  }
}

exports.createGarminAuthUrl = onCall({ cors: true }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to connect Garmin Connect.");
  const c = creds();
  if (!c) {
    console.error("createGarminAuthUrl: Garmin credentials not configured");
    throw new HttpsError("unavailable", "Garmin Connect is unavailable right now. Try again later.");
  }
  const { verifier, challenge } = lib.pkcePair();
  const state = crypto.randomBytes(24).toString("base64url");
  await db.collection("garminAuth").doc(state).set({ uid, verifier, exp: Date.now() + AUTH_TTL_MS });
  const q = new URLSearchParams({
    response_type: "code", client_id: c.clientId, code_challenge: challenge,
    code_challenge_method: "S256", redirect_uri: GARMIN_REDIRECT_URI, state,
  });
  return { url: `${GARMIN_AUTH_URL}?${q.toString()}` };
});

// Every outcome redirects to /coaching/?garmin=<result>[&reason=...]:
//   connected · denied · scope · error&reason=params|state|user|config|exchange|inuse
exports.garminCallback = onRequest({ cors: false }, async (req, res) => {
  const back = (qs) => res.redirect(`${SITE_URL}?garmin=${qs}`);
  const state = req.query.state ? String(req.query.state) : "";
  if (!state) return back("error&reason=params");
  try {
    const authRef = db.collection("garminAuth").doc(state);
    const authSnap = await authRef.get();
    if (!authSnap.exists) return back("error&reason=state");
    await authRef.delete();
    const { uid, verifier, exp } = authSnap.data();
    if (!(exp > Date.now())) return back("error&reason=state");
    if (!req.query.code) return back("denied");
    if (!creds()) return back("error&reason=config");

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return back("error&reason=user");

    const tok = await garminToken({
      grant_type: "authorization_code", code: String(req.query.code),
      code_verifier: verifier, redirect_uri: GARMIN_REDIRECT_URI,
    });

    const idRes = await userApi("GET", "id", tok.access_token);
    if (!idRes.ok) throw new Error(`garmin user id HTTP ${idRes.status}`);
    const garminUserId = String((await idRes.json()).userId || "");
    if (!garminUserId) throw new Error("garmin user id missing");

    // One Garmin account links to one ESL account. Refuse without deregistering:
    // the registration is shared with the other account's live link.
    const linkSnap = await db.collection("garminUsers").doc(garminUserId).get();
    if (linkSnap.exists && linkSnap.get("uid") !== uid) {
      console.warn(`garminCallback: Garmin user already linked elsewhere; refused for uid ${uid}`);
      return back("error&reason=inuse");
    }

    // Activity sharing is the whole point; without it, undo the link.
    const permRes = await userApi("GET", "permissions", tok.access_token);
    if (!permRes.ok || !lib.hasActivityExport(await permRes.json())) {
      await userApi("DELETE", "registration", tok.access_token).catch(() => {});
      return back("scope");
    }

    // Switching Garmin accounts: drop the old link and its runs first.
    const prev = await privRef(uid).get();
    if (prev.exists && prev.get("garminUserId") && prev.get("garminUserId") !== garminUserId) {
      await deregisterGarmin(uid);
      const n = await purgeGarminData(uid);
      console.log(`garminCallback: uid ${uid} switched Garmin accounts; purged ${n} runs`);
    }

    await privRef(uid).set(Object.assign(tokenFields(tok), { garminUserId }));
    await db.collection("garminUsers").doc(garminUserId).set({ uid, linkedAt: FieldValue.serverTimestamp() });
    await userRef.update({
      garminConnected: true, garminSharing: true,
      garminConnectedAt: FieldValue.serverTimestamp(),
      garminDisconnectedAt: FieldValue.delete(),
    });
    return back("connected");
  } catch (e) {
    console.error("garminCallback error:", e.message);
    return back("error&reason=exchange");
  }
});
