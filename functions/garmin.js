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

function authLive(a) { return !!(a && a.expireAt && a.expireAt.toMillis() > Date.now()); }

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Connect attempts nobody finished (tab closed, Connect clicked twice) are
// swept on each new attempt. expireAt is a Timestamp so a TTL policy on
// garminAuth can do the same job.
async function sweepExpiredAuth() {
  try {
    const old = await db.collection("garminAuth").where("expireAt", "<", admin.firestore.Timestamp.now()).limit(200).get();
    if (old.empty) return;
    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (e) {
    console.warn("garminAuth sweep failed:", e.message);
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
  await sweepExpiredAuth();
  const { verifier, challenge } = lib.pkcePair();
  const state = crypto.randomBytes(24).toString("base64url");
  await db.collection("garminAuth").doc(state).set({
    uid, verifier, expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + AUTH_TTL_MS),
  });
  const q = new URLSearchParams({
    response_type: "code", client_id: c.clientId, code_challenge: challenge,
    code_challenge_method: "S256", redirect_uri: GARMIN_REDIRECT_URI, state,
  });
  return { url: `${GARMIN_AUTH_URL}?${q.toString()}` };
});

// Garmin sends the browser here once the athlete has answered. The code is
// parked on the state doc, unused, and the browser goes back to the coaching
// page with a one-time key; that page finishes the link with finishGarminLink
// as the signed-in account. Every outcome redirects to /coaching/?garmin=...:
//   finish&state=..&key=.. · denied · error&reason=params|state|exchange
exports.garminCallback = onRequest({ cors: false }, async (req, res) => {
  const back = (qs) => res.redirect(`${SITE_URL}?garmin=${qs}`);
  const state = req.query.state ? String(req.query.state) : "";
  if (!state) return back("error&reason=params");
  try {
    const authRef = db.collection("garminAuth").doc(state);
    const authSnap = await authRef.get();
    if (!authSnap.exists || authSnap.get("code")) return back("error&reason=state");
    if (!authLive(authSnap.data())) { await authRef.delete(); return back("error&reason=state"); }
    if (!req.query.code) { await authRef.delete(); return back("denied"); }
    const key = crypto.randomBytes(24).toString("base64url");
    await authRef.update({ code: String(req.query.code), key });
    return back(`finish&state=${encodeURIComponent(state)}&key=${key}`);
  } catch (e) {
    console.error("garminCallback error:", e.message);
    return back("error&reason=exchange");
  }
});

// Second half of the link, called by the coaching page the callback returns
// to. Only the signed-in account that started the link can finish it, and only
// with the key handed to the browser that approved it, so approving a Connect
// link someone else started never sends your Garmin data to their account.
// Returns { result: "connected" | "scope" | "error", reason? }, reason being
// params|state|account|user|config|exchange|inuse.
exports.finishGarminLink = onCall({ cors: true, timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to finish linking Garmin Connect.");
  const data = request.data || {};
  const state = typeof data.state === "string" ? data.state : "";
  const key = typeof data.key === "string" ? data.key : "";
  if (!state || !key) return { result: "error", reason: "params" };
  try {
    const authRef = db.collection("garminAuth").doc(state);
    const authSnap = await authRef.get();
    if (!authSnap.exists) return { result: "error", reason: "state" };
    // One try per approval, whoever makes it.
    await authRef.delete();
    const a = authSnap.data();
    if (!a.code || !sameSecret(a.key, key) || !authLive(a)) return { result: "error", reason: "state" };
    if (a.uid !== uid) {
      console.warn(`finishGarminLink: link was started by another account; refused for uid ${uid}`);
      return { result: "error", reason: "account" };
    }
    return await linkGarmin(uid, a.code, a.verifier);
  } catch (e) {
    console.error("finishGarminLink error:", e.message);
    return { result: "error", reason: "exchange" };
  }
});

// True when uid's stored link is to this Garmin account.
async function holdsGarminLink(uid, garminUserId) {
  const p = await privRef(uid).get();
  return p.exists && String(p.get("garminUserId") || "") === String(garminUserId);
}

// Exchanges the code and links the Garmin account to uid.
async function linkGarmin(uid, code, verifier) {
  const err = (reason) => ({ result: "error", reason });
  if (!creds()) return err("config");
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return err("user");

  const tok = await garminToken({
    grant_type: "authorization_code", code: String(code),
    code_verifier: verifier, redirect_uri: GARMIN_REDIRECT_URI,
  });

  const idRes = await userApi("GET", "id", tok.access_token);
  if (!idRes.ok) throw new Error(`garmin user id HTTP ${idRes.status}`);
  const garminUserId = String((await idRes.json()).userId || "");
  if (!garminUserId) throw new Error("garmin user id missing");

  // One Garmin account links to one ESL account. Refuse without deregistering:
  // the registration is shared with the other account's live link. A mapping
  // whose account no longer holds the link (e.g. a deleted account) is stale
  // and is taken over below.
  const linkSnap = await db.collection("garminUsers").doc(garminUserId).get();
  const mappedUid = linkSnap.exists ? linkSnap.get("uid") : null;
  if (mappedUid && mappedUid !== uid && await holdsGarminLink(mappedUid, garminUserId)) {
    console.warn(`finishGarminLink: Garmin user already linked elsewhere; refused for uid ${uid}`);
    return err("inuse");
  }

  const prev = await privRef(uid).get();
  const prevGarminUserId = prev.exists ? String(prev.get("garminUserId") || "") : "";
  const relink = prevGarminUserId === garminUserId;

  const permRes = await userApi("GET", "permissions", tok.access_token);
  if (!permRes.ok) {
    // Garmin didn't say what was granted, so this is an error, not "scope". A
    // new link is undone; a link this account already held carries on with
    // the fresh tokens.
    if (relink) await privRef(uid).set(tokenFields(tok), { merge: true });
    else await userApi("DELETE", "registration", tok.access_token).catch(() => {});
    return err("exchange");
  }
  if (!lib.hasActivityExport(await permRes.json())) {
    // Activity sharing is the whole point; without it, undo the link. If this
    // account already held it, that link has ended too, so purge it now.
    await userApi("DELETE", "registration", tok.access_token).catch(() => {});
    if (relink) {
      const n = await purgeGarminData(uid);
      console.log(`finishGarminLink: uid ${uid} re-linked without activity sharing; purged ${n} runs`);
    }
    return { result: "scope" };
  }

  // Switching Garmin accounts: drop the old link and its runs first.
  if (prevGarminUserId && !relink) {
    await deregisterGarmin(uid);
    const n = await purgeGarminData(uid);
    console.log(`finishGarminLink: uid ${uid} switched Garmin accounts; purged ${n} runs`);
  }

  await privRef(uid).set(Object.assign(tokenFields(tok), { garminUserId }));
  await db.collection("garminUsers").doc(garminUserId).set({ uid, linkedAt: FieldValue.serverTimestamp() });
  await userRef.update({
    garminConnected: true, garminSharing: true,
    garminConnectedAt: FieldValue.serverTimestamp(),
    garminDisconnectedAt: FieldValue.delete(),
  });
  return { result: "connected" };
}

// Tells Garmin the athlete's link has ended on our side. Best effort: a lapsed
// token still lets us purge locally.
async function deregisterGarmin(uid) {
  const token = await getValidAccessToken(uid);
  if (!token) return false;
  try {
    const r = await userApi("DELETE", "registration", token);
    if (!r.ok) console.warn(`garmin deregister HTTP ${r.status} for uid ${uid}`);
    return r.ok;
  } catch (e) {
    console.warn(`garmin deregister error for uid ${uid}: ${e.message}`);
    return false;
  }
}

// Frees garminUsers/{garminUserId} when it still points at uid.
async function dropGarminUserMapping(uid, garminUserId) {
  if (!garminUserId) return;
  const link = await db.collection("garminUsers").doc(String(garminUserId)).get();
  if (link.exists && link.get("uid") === uid) await link.ref.delete();
}

// Deletes everything Garmin sent for one athlete: tokens, the user mapping,
// every source:"garmin" run, and the link flags. Their own uploads stay.
async function purgeGarminData(uid) {
  const priv = await privRef(uid).get();
  await privRef(uid).delete();
  if (priv.exists) await dropGarminUserMapping(uid, priv.get("garminUserId"));
  const runs = await db.collection("users").doc(uid).collection("garminActivities").where("source", "==", "garmin").get();
  let deleted = 0;
  for (let i = 0; i < runs.docs.length; i += 450) {
    const batch = db.batch();
    runs.docs.slice(i, i + 450).forEach((d) => { batch.delete(d.ref); deleted++; });
    await batch.commit();
  }
  await db.collection("users").doc(uid).update({
    garminConnected: false,
    garminSharing: FieldValue.delete(),
    garminConnectedAt: FieldValue.delete(),
    garminDisconnectedAt: FieldValue.serverTimestamp(),
  });
  return deleted;
}

// Account deletion (adminDeleteUser in index.js) calls this before it deletes
// users/{uid}: telling Garmin needs the stored token, and the user mapping
// lives outside users/{uid}, so it is dropped here to stop runs arriving for
// the deleted account and to let the Garmin account link to a new one.
// Returns a warning for the admin, or null. Not a Cloud Function: deploy skips
// exports without a trigger.
exports.endGarminLinkForDeletion = async function endGarminLinkForDeletion(uid) {
  const priv = await privRef(uid).get();
  if (!priv.exists) return null;
  const told = await deregisterGarmin(uid);
  await dropGarminUserMapping(uid, priv.get("garminUserId"));
  return told ? null : "Garmin could not be told the link ended (no usable token, or Garmin refused); it was dropped on our side.";
};
