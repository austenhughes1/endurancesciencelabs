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
// Each call to Garmin's token and user endpoints gives up after this long, so
// a request Garmin never answers can't hold up a disconnect or the daily job.
const GARMIN_API_TIMEOUT_MS = 15 * 1000;

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
    signal: AbortSignal.timeout(GARMIN_API_TIMEOUT_MS),
  });
  if (!r.ok) {
    const e = new Error(`garmin token HTTP ${r.status}`);
    // The OAuth error code (e.g. invalid_grant) only, never the rest of the body.
    e.oauthError = "";
    try { e.oauthError = String(((await r.json()) || {}).error || ""); } catch (x) { /* not JSON */ }
    throw e;
  }
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
  return fetch(`${GARMIN_USER_URL}/${pathName}`, {
    method, headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GARMIN_API_TIMEOUT_MS),
  });
}

// A usable access token from an ending link's token fields, refreshing when it
// is near expiry. The new tokens are not stored: the link is ending. null when
// the refresh token has lapsed or the refresh fails.
async function accessTokenFrom(uid, p) {
  if (p.accessToken && p.expiresAt - TOKEN_MARGIN_MS > Date.now()) return p.accessToken;
  if (!p.refreshToken || !(p.refreshExpiresAt > Date.now())) return null;
  try {
    const tok = await garminToken({ grant_type: "refresh_token", refresh_token: p.refreshToken });
    return tok.access_token;
  } catch (e) {
    console.warn(`garmin refresh failed for uid ${uid}: ${e.message}`);
    return null;
  }
}

// Tells Garmin that a link has ended on our side. Logs the uid and the HTTP
// status or error only. Returns whether Garmin accepted it.
async function sendDeregistration(uid, accessToken) {
  try {
    const r = await userApi("DELETE", "registration", accessToken);
    if (!r.ok) console.warn(`garmin deregister HTTP ${r.status} for uid ${uid}`);
    return r.ok;
  } catch (e) {
    console.warn(`garmin deregister error for uid ${uid}: ${e.message}`);
    return false;
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
// params|state|account|user|config|exchange|inuse|busy (busy: another tab
// linked this account to a different Garmin account first, or ended the link
// this one was renewing).
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

// A link that fails after Garmin approved it (the code is exchanged) and before
// its tokens are stored is undone with Garmin, unless the approval may belong
// to a link that stays: one this account holds to the same Garmin account (a
// re-link, or one another tab made meanwhile), or another account's live link
// to it. Without the Garmin user id, any link this account holds may be that
// one. Nothing is sent when the checks themselves fail.
async function undoUnstoredLink(uid, garminUserId, accessToken) {
  try {
    const prev = await privRef(uid).get();
    if (garminUserId ? String(prev.get("garminUserId") || "") === garminUserId : prev.exists) return;
    if (garminUserId) {
      const other = await uidForGarminUser(garminUserId);
      if (other && other !== uid && await holdsGarminLink(other, garminUserId)) return;
    }
  } catch (e) {
    console.warn(`finishGarminLink: uid ${uid} link failed and could not be checked; Garmin not told: ${e.message}`);
    return;
  }
  console.warn(`finishGarminLink: uid ${uid} link failed before it was stored; undone with Garmin`);
  await sendDeregistration(uid, accessToken);
}

// Exchanges the code and links the Garmin account to uid.
async function linkGarmin(uid, code, verifier) {
  if (!creds()) return { result: "error", reason: "config" };
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return { result: "error", reason: "user" };

  const tok = await garminToken({
    grant_type: "authorization_code", code: String(code),
    code_verifier: verifier, redirect_uri: GARMIN_REDIRECT_URI,
  });
  const ids = { garminUserId: "" };
  try {
    return await linkApproved(uid, userRef, tok, ids);
  } catch (e) {
    await undoUnstoredLink(uid, ids.garminUserId, tok.access_token);
    throw e;
  }
}

// The rest of the link, once Garmin has approved it and issued tok. Sets
// ids.garminUserId as soon as it is known.
async function linkApproved(uid, userRef, tok, ids) {
  const err = (reason) => ({ result: "error", reason });
  const idRes = await userApi("GET", "id", tok.access_token);
  if (!idRes.ok) throw new Error(`garmin user id HTTP ${idRes.status}`);
  const garminUserId = String((await idRes.json()).userId || "");
  if (!garminUserId) throw new Error("garmin user id missing");
  ids.garminUserId = garminUserId;

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
    // new link is undone, unless another tab has linked this Garmin account
    // since: the registration is that link's too, so Garmin is not told. A
    // link this account already held carries on with the fresh tokens, unless
    // another tab has switched or ended it since this one checked: then that
    // tab's outcome stays and this link is undone.
    if (!relink) {
      if (await holdsGarminLink(uid, garminUserId)) {
        console.warn(`finishGarminLink: uid ${uid} linked this Garmin account in another tab meanwhile; that link kept`);
      } else {
        await userApi("DELETE", "registration", tok.access_token).catch(() => {});
      }
      return err("exchange");
    }
    const kept = await db.runTransaction(async (t) => {
      const cur = await t.get(privRef(uid));
      if (!cur.exists || String(cur.get("garminUserId") || "") !== garminUserId) return false;
      t.set(privRef(uid), tokenFields(tok), { merge: true });
      return true;
    });
    if (kept) return err("exchange");
    console.warn(`finishGarminLink: uid ${uid} switched or ended its Garmin link meanwhile; this link undone`);
    await sendDeregistration(uid, tok.access_token);
    return err("busy");
  }
  if (!lib.hasActivityExport(await permRes.json())) {
    // Activity sharing is the whole point; without it, undo the link. If this
    // account already held it, that link has ended too, so purge it now. A link
    // to another account made meanwhile stays.
    await userApi("DELETE", "registration", tok.access_token).catch(() => {});
    if (relink) {
      const n = await purgeGarminData(uid, garminUserId);
      if (n != null) console.log(`finishGarminLink: uid ${uid} re-linked without activity sharing; purged ${n} runs`);
    }
    return { result: "scope" };
  }

  // Switching Garmin accounts: drop the old link and its runs first. A mapping
  // to another account, left by a switch whose purge failed part-way after the
  // old tokens were gone, is an old link too.
  const switching = !relink && (prevGarminUserId !== "" ||
    (await garminUsersMappedTo(uid)).some((id) => id !== garminUserId));
  if (switching) {
    const n = await purgeGarminData(uid);
    console.log(`finishGarminLink: uid ${uid} switched Garmin accounts; purged ${n} runs`);
  }

  // The token doc goes first: a purge still running for the old account checks
  // it before it touches the flags. sharingChangedAt: what was granted was
  // checked just now, so sharing changes that reached us earlier are older.
  // If another tab has linked a different Garmin account since this one
  // checked, that link stays and this one is undone with Garmin.
  const stored = await db.runTransaction(async (t) => {
    const cur = await t.get(privRef(uid));
    const held = cur.exists ? String(cur.get("garminUserId") || "") : "";
    if (held && held !== garminUserId) return false;
    t.set(privRef(uid), Object.assign(tokenFields(tok), { garminUserId, sharingChangedAt: Date.now() }));
    return true;
  });
  if (!stored) {
    console.warn(`finishGarminLink: uid ${uid} linked another Garmin account meanwhile; this link undone`);
    await sendDeregistration(uid, tok.access_token);
    return err("busy");
  }
  await db.collection("garminUsers").doc(garminUserId).set({ uid, linkedAt: FieldValue.serverTimestamp() });
  await userRef.update({
    garminConnected: true, garminSharing: true,
    garminConnectedAt: FieldValue.serverTimestamp(),
    garminDisconnectedAt: FieldValue.delete(),
  });
  return { result: "connected" };
}

// Ends the athlete's link on our side and tells Garmin. The token doc is taken
// out first, in one transaction, so a daily renewal finishing meanwhile finds
// the link gone and tells Garmin itself with the tokens it was given (see
// refreshGarminTokens), and a token doc written while Garmin is being told
// belongs to a new link. Best effort: a lapsed token still lets us purge locally.
async function deregisterGarmin(uid) {
  const p = await db.runTransaction(async (t) => {
    const snap = await t.get(privRef(uid));
    if (!snap.exists) return null;
    t.delete(privRef(uid));
    return snap.data();
  });
  if (!p) return false;
  const token = await accessTokenFrom(uid, p);
  if (!token) return false;
  return sendDeregistration(uid, token);
}

// Frees garminUsers/{garminUserId} when it still points at uid, unless uid's
// token doc holds that Garmin account: a link to it made meanwhile keeps its
// mapping. Both are read in one transaction, so a link finishing at the same
// moment is either seen here or writes its mapping afterwards.
async function dropGarminUserMapping(uid, garminUserId) {
  if (!garminUserId) return;
  const ref = db.collection("garminUsers").doc(String(garminUserId));
  await db.runTransaction(async (t) => {
    const link = await t.get(ref);
    const priv = await t.get(privRef(uid));
    if (!link.exists || link.get("uid") !== uid) return;
    if (priv.exists && String(priv.get("garminUserId") || "") === String(garminUserId)) return;
    t.delete(ref);
  });
}

// The user-doc lists that keep a run's id, start and distance (Lever marks,
// exclusions), with the entries made on Garmin runs taken out. Only the lists
// that change are returned.
function withoutGarminRunNotes(user) {
  const out = {};
  for (const k of ["runLeverMarks", "runExcluded"]) {
    const list = user[k];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((m) => !(m && String(m.id).startsWith("garmin_")));
    if (kept.length !== list.length) out[k] = kept;
  }
  return out;
}

// Queued runs and files for a Garmin account that the worker never finished.
// Deregistrations and permission changes carry no activity data.
async function dropQueuedGarminData(garminUserId) {
  const queued = await db.collection("garminInbox").where("item.userId", "==", String(garminUserId)).get();
  const data = queued.docs.filter((d) => d.get("kind") === "activities" || d.get("kind") === "activityFiles");
  for (let i = 0; i < data.length; i += 450) {
    const batch = db.batch();
    data.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// Every Garmin account whose mapping still points at uid.
async function garminUsersMappedTo(uid) {
  const snap = await db.collection("garminUsers").where("uid", "==", uid).get();
  return snap.docs.map((d) => d.id);
}

// Deletes everything Garmin sent for one athlete: tokens, every source:"garmin"
// run, the Lever marks and exclusions made on those runs, the link flags,
// queued items and the user mapping. Their own uploads stay. The tokens go
// first: the worker writes a run only while they still name this Garmin
// account, checked inside its transaction, so no run lands after the sweep
// below. The mappings go last, so a deregistration that fails part-way still
// finds the account when it is retried.
// With garminUserId (a deregistration from Garmin, or a link we have just
// undone with Garmin), only a link to that account ends: if uid holds a link to
// another account by the time the tokens are checked, that link stays, only
// the old mapping is freed, and null is returned. Without it, uid's link ends
// here and deregisterGarmin tells Garmin; every mapping still pointing at uid
// is freed, which also finds one that an earlier purge, failing after the
// tokens were gone, left behind. Either way, a link made after the tokens were
// taken keeps its tokens, flags, mapping and queued items.
async function purgeGarminData(uid, garminUserId) {
  const only = garminUserId != null ? String(garminUserId) : null;
  if (!only) {
    await deregisterGarmin(uid);
  } else {
    const ended = await db.runTransaction(async (t) => {
      const priv = await t.get(privRef(uid));
      const held = String((priv.exists && priv.get("garminUserId")) || "");
      if (held && held !== only) return false;
      t.delete(privRef(uid));
      return true;
    });
    if (!ended) {
      await dropGarminUserMapping(uid, only);
      return null;
    }
  }
  const runs = await runsCol(uid).where("source", "==", "garmin").get();
  let deleted = 0;
  for (let i = 0; i < runs.docs.length; i += 450) {
    const batch = db.batch();
    runs.docs.slice(i, i + 450).forEach((d) => { batch.delete(d.ref); deleted++; });
    await batch.commit();
  }
  // A link made while this ran (an account switch) has set its own flags.
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (t) => {
    const priv = await t.get(privRef(uid));
    const user = await t.get(userRef);
    if (!user.exists) return;
    const patch = withoutGarminRunNotes(user.data());
    if (!priv.exists) {
      Object.assign(patch, {
        garminConnected: false,
        garminSharing: FieldValue.delete(),
        garminConnectedAt: FieldValue.delete(),
        garminDisconnectedAt: FieldValue.serverTimestamp(),
      });
    }
    if (Object.keys(patch).length) t.update(userRef, patch);
  });
  // A link made while this ran keeps its queued items; dropGarminUserMapping
  // checks the token doc again for the mapping itself.
  const cur = await privRef(uid).get();
  const held = cur.exists ? String(cur.get("garminUserId") || "") : "";
  for (const gid of only ? [only] : await garminUsersMappedTo(uid)) {
    if (gid === held) continue;
    await dropQueuedGarminData(gid);
    await dropGarminUserMapping(uid, gid);
  }
  return deleted;
}

// Account deletion (adminDeleteUser in index.js) calls this before it deletes
// users/{uid}: telling Garmin needs the stored token, and the user mapping
// lives outside users/{uid}, so it is dropped here to stop runs arriving for
// the deleted account and to let the Garmin account link to a new one. Every
// mapping still pointing at uid is freed, which also finds one that an earlier
// switch or disconnect, failing after the tokens were gone, left behind.
// Returns a warning for the admin, or null. Not a Cloud Function: deploy skips
// exports without a trigger.
exports.endGarminLinkForDeletion = async function endGarminLinkForDeletion(uid) {
  const linked = (await privRef(uid).get()).exists;
  const told = linked ? await deregisterGarmin(uid) : true;
  for (const gid of await garminUsersMappedTo(uid)) {
    await dropQueuedGarminData(gid);
    await dropGarminUserMapping(uid, gid);
  }
  return told ? null : "Garmin could not be told the link ended (no usable token, or Garmin refused); it was dropped on our side.";
};

// The fields the worker reads from each kind of item. Nothing else is stored.
const INBOX_FIELDS = {
  activities: [
    "userId", "summaryId", "activityId", "activityName", "activityType", "startTimeInSeconds",
    "durationInSeconds", "distanceInMeters", "averageSpeedInMetersPerSecond",
    "averageHeartRateInBeatsPerMinute", "maxHeartRateInBeatsPerMinute",
    "averageRunCadenceInStepsPerMinute", "steps", "totalElevationGainInMeters",
    "totalElevationLossInMeters", "deviceName",
  ],
  activityFiles: [
    "userId", "summaryId", "activityId", "activityName", "activityType", "startTimeInSeconds",
    "deviceName", "fileType", "callbackURL",
  ],
  deregistrations: ["userId"],
  userPermissionsChange: ["userId", "permissions"],
};
const HANDLED = new Set(Object.keys(INBOX_FIELDS));
// Queued items carry expireAt, a Timestamp, so a TTL policy on garminInbox can
// remove any the worker never finished.
const INBOX_TTL_MS = 24 * 60 * 60 * 1000;

function inboxItem(kind, item) {
  const out = {};
  for (const k of INBOX_FIELDS[kind]) if (item[k] !== undefined) out[k] = item[k];
  out.userId = String(item.userId);
  return out;
}

// Garmin's push target. Only filters (non-run activities are never stored) and
// queues; the worker below does everything else, so the reply is immediate.
exports.garminPush = onRequest({ cors: false }, async (req, res) => {
  const key = process.env.GARMIN_PUSH_KEY;
  if (req.method !== "POST" || !key || !sameSecret(req.query.k, key)) { res.status(404).send("Not found"); return; }
  try {
    const body = req.body || {};
    const items = [];
    for (const kind of Object.keys(body)) {
      if (!HANDLED.has(kind) || !Array.isArray(body[kind])) continue;
      for (const item of body[kind]) {
        if (!item || !item.userId) continue;
        if ((kind === "activities" || kind === "activityFiles") && !lib.runTypeFor(item.activityType)) continue;
        items.push({ kind, item: inboxItem(kind, item) });
      }
    }
    for (let i = 0; i < items.length; i += 450) {
      const batch = db.batch();
      for (const it of items.slice(i, i + 450)) {
        batch.set(db.collection("garminInbox").doc(), Object.assign(it, {
          receivedAt: FieldValue.serverTimestamp(),
          expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + INBOX_TTL_MS),
        }));
      }
      await batch.commit();
    }
  } catch (e) {
    // Not stored: an error status lets Garmin send it again. Items stored by
    // an earlier batch come again too; the worker handles each one once more.
    console.error("garminPush error:", e.message);
    res.status(503).send("Try again");
    return;
  }
  res.status(200).send("OK");
});

let fitParserP = null;
function loadFitParser() {
  if (!fitParserP) {
    fitParserP = import("fit-file-parser").then((m) => {
      let P = m.default || m;
      if (P && P.default) P = P.default;
      return P;
    });
  }
  return fitParserP;
}

// Parses in memory and returns sessions only. GPS records are never kept.
async function parseFitSessions(buf) {
  const FitParser = await loadFitParser();
  return new Promise((resolve) => {
    const fp = new FitParser({ force: true, mode: "list", speedUnit: "m/s", lengthUnit: "m" });
    fp.parse(buf, (err, data) => resolve(err || !data ? [] : (data.sessions || [])));
  });
}

async function uidForGarminUser(garminUserId) {
  const snap = await db.collection("garminUsers").doc(String(garminUserId)).get();
  return snap.exists ? snap.get("uid") : null;
}

function runsCol(uid) { return db.collection("users").doc(uid).collection("garminActivities"); }

// What a summary or a file adds to a run already stored: defined values only,
// and never an empty title over a stored one, so neither erases the other's
// fields. The file's values are the exact ones, so once it has landed
// (fromFile) a summary only fills fields still empty.
function runUpdate(have, doc, fromFile) {
  const add = lib.definedOnly(doc);
  if (!add.title && have.title) { delete add.title; delete add.leverTitle; }
  if (fromFile) return Object.assign(add, { fromFile: true });
  if (!have.fromFile) return add;
  const fill = {};
  for (const k of Object.keys(add)) if (have[k] == null || have[k] === "") fill[k] = add[k];
  if ("title" in fill) fill.leverTitle = add.leverTitle;
  return fill;
}

// Write one Garmin run, but only while uid still holds the link to this Garmin
// account. The link is read inside the transaction, so a purge (which ends the
// link before it collects runs) either finds this run or stops it. An
// overlapping Strava run is replaced. A new run is skipped if the athlete's own
// watch upload already covers it; an existing one is updated by runUpdate. One
// transaction, so a summary and a file for the same run handled at the same
// moment can't both write it as new.
async function upsertGarminRun(uid, garminUserId, doc, fromFile) {
  const ref = runsCol(uid).doc(doc.id);
  const link = db.collection("garminUsers").doc(String(garminUserId));
  const day = 24 * 60 * 60 * 1000;
  const near = runsCol(uid).where("ts", ">=", doc.ts - day).where("ts", "<=", doc.ts + day);
  await db.runTransaction(async (t) => {
    const mapped = await t.get(link);
    const priv = await t.get(privRef(uid));
    if (mapped.get("uid") !== uid || String(priv.get("garminUserId") || "") !== String(garminUserId)) return;
    const snap = await t.get(ref);
    const found = await t.get(near);
    const strava = [];
    let ownUpload = false;
    for (const d of found.docs) {
      const x = d.data();
      if (!lib.sameRunSpan(doc.ts, doc.durSec, Number(x.ts), x.durSec)) continue;
      if (x.source === "strava") strava.push(d.ref);
      else if (x.source !== "garmin") ownUpload = true;
    }
    if (!snap.exists && ownUpload) return;
    strava.forEach((r) => t.delete(r));
    if (snap.exists) t.set(ref, runUpdate(snap.data(), doc, fromFile), { merge: true });
    else t.set(ref, Object.assign({}, doc, fromFile ? { fromFile: true } : {}, { syncedAt: FieldValue.serverTimestamp() }));
  });
}

const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

// A failure worth another try: onGarminInbox hands it back to the trigger.
function retryLater(message) {
  const e = new Error(message);
  e.retry = true;
  return e;
}

// One activity file's bytes, or null when it can't be had. A busy (429),
// failing (5xx) or unreachable file server is retried later. Logs carry the
// HTTP status or the error's name only, never the URL: it holds a token.
async function downloadGarminFile(uid, url) {
  let usable = false;
  try { usable = new URL(url).protocol === "https:"; } catch (e) { usable = false; }
  if (!usable) { console.warn(`garmin file URL rejected for uid ${uid}`); return null; }
  let r, buf = null;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (r.ok) buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn(`garmin file download failed for uid ${uid}: ${e.name}`);
    throw retryLater("garmin file download failed");
  }
  if (r.ok) return buf;
  console.warn(`garmin file HTTP ${r.status} for uid ${uid}`);
  if (r.status === 429 || r.status >= 500) throw retryLater(`garmin file HTTP ${r.status}`);
  return null;
}

// Applies a sharing change pushed for garminUserId to uid's link. Items are
// handled in no particular order, so the change is applied only when it
// reached us no earlier than the last one applied (or the link itself).
// Returns "other" when uid's link is to another Garmin account: the mapping
// is left over. A link that has ended, or is ending, is left to its purge.
async function applyGarminSharing(uid, garminUserId, sharing, at) {
  const ref = privRef(uid), userRef = db.collection("users").doc(uid);
  return db.runTransaction(async (t) => {
    const priv = await t.get(ref);
    if (!priv.exists) return "ended";
    if (String(priv.get("garminUserId") || "") !== String(garminUserId)) return "other";
    if (Number(priv.get("sharingChangedAt")) > at) return "older";
    t.update(ref, { sharingChangedAt: at });
    t.update(userRef, { garminSharing: sharing });
    return "applied";
  });
}

async function handleGarminItem(kind, item, receivedAt) {
  const uid = await uidForGarminUser(item.userId);
  if (!uid) return;
  if (kind === "deregistrations") {
    // A mapping left over for an account that now holds a different Garmin
    // link is only freed; that other link and its runs stay.
    const n = await purgeGarminData(uid, item.userId);
    if (n != null) console.log(`garmin deregistration: purged ${n} runs for uid ${uid}`);
    return;
  }
  if (kind === "userPermissionsChange") {
    const at = receivedAt && receivedAt.toMillis ? receivedAt.toMillis() : 0;
    const r = await applyGarminSharing(uid, item.userId, lib.hasActivityExport(item), at);
    if (r === "other") await dropGarminUserMapping(uid, item.userId);
    return;
  }
  const user = await db.collection("users").doc(uid).get();
  if (user.get("garminSharing") === false) return;
  if (kind === "activities") {
    const doc = lib.runDocFromSummary(item);
    if (doc) await upsertGarminRun(uid, item.userId, doc, false);
    return;
  }
  if (kind === "activityFiles") {
    if (String(item.fileType || "").toUpperCase() !== "FIT" || !item.callbackURL) return;
    const buf = await downloadGarminFile(uid, item.callbackURL);
    if (!buf) return;
    const sessions = await parseFitSessions(buf);
    const s = sessions.find((x) => /run/i.test(String(x.sport || ""))) || sessions[0];
    const doc = lib.runDocFromFile(item, s);
    if (doc) await upsertGarminRun(uid, item.userId, doc, true);
  }
}

// One item per instance and at most five instances, so at most five items, and
// five file downloads, run at once. A deregistration that fails, or a download
// marked retryLater, keeps its item and throws, so the trigger retries it with
// backoff; any other failure is logged and the item dropped.
exports.onGarminInbox = onDocumentCreated(
  { document: "garminInbox/{id}", timeoutSeconds: 120, memory: "512MiB", maxInstances: 5, concurrency: 1, retry: true },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    // A retried event still carries the item; skip it once it is handled or purged.
    if (!(await snap.ref.get()).exists) return;
    const { kind, item, receivedAt } = snap.data();
    try {
      await handleGarminItem(kind, item, receivedAt);
    } catch (e) {
      if (kind === "deregistrations" || e.retry) {
        console.error(`onGarminInbox ${kind} failed, will retry:`, e.message);
        throw e;
      }
      console.error(`onGarminInbox ${kind} error:`, e.message);
    }
    await snap.ref.delete();
  }
);

exports.disconnectGarmin = onCall({ cors: true, timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to manage Garmin Connect.");
  const deleted = await purgeGarminData(uid);
  console.log(`disconnectGarmin: purged ${deleted} runs for uid ${uid}`);
  return { deleted };
});

// Daily: renews every link whose refresh token lapses within 30 days, so a
// later disconnect can still tell Garmin the link ended. The new tokens are
// stored only while the link still holds the token that was renewed: a
// disconnect or a re-link made meanwhile keeps the last word, so a purge's
// deleted tokens never come back. If the link this renewal was for has ended
// meanwhile (no token doc, or one for another Garmin account), its disconnect
// may have been unable to tell Garmin, since its own renewal of the same token
// can fail, so the new token tells Garmin here.
exports.refreshGarminTokens = onSchedule({ schedule: "every day 04:00", timeZone: "America/Denver", timeoutSeconds: 540 }, async () => {
  const links = await db.collection("garminUsers").get();
  let renewed = 0;
  for (const link of links.docs) {
    const uid = link.get("uid");
    const priv = await privRef(uid).get();
    if (!priv.exists) continue;
    const p = priv.data();
    if (!p.refreshToken || p.refreshExpiresAt - Date.now() > REFRESH_WINDOW_MS) continue;
    try {
      const tok = await garminToken({ grant_type: "refresh_token", refresh_token: p.refreshToken });
      const outcome = await db.runTransaction(async (t) => {
        const cur = await t.get(privRef(uid));
        if (!cur.exists || String(cur.get("garminUserId") || "") !== String(p.garminUserId || "")) return "ended";
        if (cur.get("refreshToken") !== p.refreshToken) return "newer";
        t.set(privRef(uid), tokenFields(tok), { merge: true });
        return "stored";
      });
      if (outcome === "stored") renewed++;
      if (outcome === "ended") await sendDeregistration(uid, tok.access_token);
    } catch (e) {
      console.warn(`refreshGarminTokens: uid ${uid} failed: ${e.message}`);
      if (e.oauthError === "invalid_grant") await endRefusedLink(uid, p);
    }
  }
  console.log(`refreshGarminTokens: renewed ${renewed} of ${links.size}`);
});

// Garmin refusing a link's own stored refresh token as invalid means the link
// has ended on Garmin's side (removed in Garmin Connect without its
// deregistration reaching us) or has lapsed. It is ended here as a
// deregistration would end it, unless the link has been renewed, re-made or
// ended since it was read.
async function endRefusedLink(uid, p) {
  try {
    const cur = await privRef(uid).get();
    if (!p.garminUserId || !cur.exists || cur.get("refreshToken") !== p.refreshToken ||
        String(cur.get("garminUserId") || "") !== String(p.garminUserId || "")) return;
    const n = await purgeGarminData(uid, String(p.garminUserId));
    if (n != null) console.log(`refreshGarminTokens: Garmin refused the link of uid ${uid}; purged ${n} runs`);
  } catch (e) {
    console.warn(`refreshGarminTokens: ending the refused link of uid ${uid} failed: ${e.message}`);
  }
}
