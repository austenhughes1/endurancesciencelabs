// Pure helpers for the Garmin Connect import (no Firebase). Turns what Garmin
// sends into the same run-doc shape the CSV, FIT and Strava importers write
// to users/{uid}/garminActivities.
"use strict";
const crypto = require("crypto");

const RUN_TYPES = {
  RUNNING: "Running", STREET_RUNNING: "Running", ULTRA_RUN: "Running", OBSTACLE_RUN: "Running",
  TRAIL_RUNNING: "Trail Running",
  TRACK_RUNNING: "Track Running",
  TREADMILL_RUNNING: "Treadmill Running", INDOOR_RUNNING: "Treadmill Running", VIRTUAL_RUN: "Treadmill Running",
};

function runTypeFor(activityType) {
  return RUN_TYPES[String(activityType || "").toUpperCase()] || null;
}

function challengeFor(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

// Same rules as the browser importer: running-form values can't be 0, so 0 = absent.
function pos(v) { return typeof v === "number" && isFinite(v) && v > 0 ? v : null; }
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

function cleanDevice(d) {
  const s = String(d || "").trim();
  return s && s.toLowerCase() !== "unknown" ? s : null;
}

// Summary cadence arrives per leg on some devices; a running value under 120
// can only be per-leg, so double it (FIT values replace this when the file lands).
function summaryCadence(v) {
  const c = pos(v);
  return c == null ? null : Math.round(c < 120 ? c * 2 : c);
}

function runDocFromSummary(a) {
  const type = runTypeFor(a && a.activityType);
  if (!type) return null;
  const aid = a.activityId != null ? String(a.activityId) : String(a.summaryId || "");
  const start = Number(a.startTimeInSeconds);
  if (!aid || !isFinite(start)) return null;
  const distM = pos(a.distanceInMeters);
  const spd = pos(a.averageSpeedInMetersPerSecond);
  const title = String(a.activityName || "");
  return {
    id: "garmin_" + aid, type, title, leverTitle: /lever/i.test(title),
    ts: start * 1000, dateISO: new Date(start * 1000).toISOString(),
    distMi: distM == null ? null : distM / 1609.34,
    durSec: pos(a.durationInSeconds),
    avgHr: pos(a.averageHeartRateInBeatsPerMinute), maxHr: pos(a.maxHeartRateInBeatsPerMinute),
    aerobicTE: null,
    cadence: summaryCadence(a.averageRunCadenceInStepsPerMinute),
    stride: null, vratio: null, vo: null, gct: null, gctBalL: null,
    paceSec: spd ? 1609.34 / spd : null, gapSec: null,
    ascentM: num(a.totalElevationGainInMeters), descentM: num(a.totalElevationLossInMeters),
    steps: pos(a.steps),
    source: "garmin", garminActivityId: aid,
    deviceName: cleanDevice(a.deviceName),
  };
}

// FIT session -> the fields only the file carries. Conversions match
// runFromFitSession in shared/run-dynamics.js (pinned by the twin test).
function dynamicsFromFitSession(s) {
  if (!s) return {};
  const cadHalf = pos(s.avg_running_cadence != null ? s.avg_running_cadence : s.avg_cadence);
  const frac = num(s.avg_fractional_cadence) || 0;
  const voMm = pos(s.avg_vertical_oscillation);
  const stepMm = pos(s.avg_step_length);
  let vr = pos(s.avg_vertical_ratio);
  if (vr == null && voMm != null && stepMm) vr = voMm / stepMm * 100;
  return {
    aerobicTE: num(s.total_training_effect),
    cadence: cadHalf == null ? null : Math.round((cadHalf + frac) * 2),
    stride: stepMm == null ? null : stepMm / 1000,
    vratio: vr,
    vo: voMm == null ? null : voMm / 10,
    gct: pos(s.avg_stance_time), gctBalL: pos(s.avg_stance_time_balance),
    ascentM: num(s.total_ascent), descentM: num(s.total_descent), steps: pos(s.total_strides),
  };
}

function runDocFromFile(item, s) {
  const type = runTypeFor(item && item.activityType);
  if (!type || !s || item.activityId == null) return null;
  const start = s.start_time ? new Date(s.start_time).getTime() : Number(item.startTimeInSeconds) * 1000;
  if (!isFinite(start)) return null;
  const distM = pos(s.total_distance);
  const spd = pos(s.avg_speed != null ? s.avg_speed : s.enhanced_avg_speed);
  const title = String(item.activityName || "");
  return Object.assign({
    id: "garmin_" + String(item.activityId), type, title, leverTitle: /lever/i.test(title),
    ts: start, dateISO: new Date(start).toISOString(),
    distMi: distM == null ? null : distM / 1609.34,
    durSec: pos(s.total_timer_time != null ? s.total_timer_time : s.total_elapsed_time),
    avgHr: pos(s.avg_heart_rate), maxHr: pos(s.max_heart_rate),
    paceSec: spd ? 1609.34 / spd : null, gapSec: null,
    source: "garmin", garminActivityId: String(item.activityId),
    deviceName: cleanDevice(item.deviceName),
  }, dynamicsFromFitSession(s));
}

function definedOnly(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== null && o[k] !== undefined) out[k] = o[k];
  return out;
}

function hasActivityExport(body) {
  return !!(body && Array.isArray(body.permissions) && body.permissions.includes("ACTIVITY_EXPORT"));
}

// Same run recorded twice: start->end spans overlap, with a minute of slack.
function sameRunSpan(aTs, aDur, bTs, bDur) {
  const slack = 60000;
  return aTs <= bTs + (bDur || 0) * 1000 + slack && bTs <= aTs + (aDur || 0) * 1000 + slack;
}

module.exports = {
  runTypeFor, challengeFor, pkcePair, runDocFromSummary, dynamicsFromFitSession,
  runDocFromFile, definedOnly, hasActivityExport, sameRunSpan,
};
