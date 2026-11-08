// Compact activity series for the accounts in GARMIN_SERIES_UIDS (pure, no
// Firebase). The inbox worker builds one from each pushed FIT file it parses
// in memory and stores it at users/{uid}/garminSeries/{activityId}; the FIT
// itself is never kept, and neither are GPS positions. esMcp serves these
// docs to Claude. Shape and units: docs/garmin-series.md.
"use strict";
const lib = require("./garmin-lib");

// Series fields, in the order they are stored.
const FIELDS = ["power", "speed", "hr", "cadence", "alt", "gct", "vo", "stepLen", "gctBalL"];
// Bin widths a series is stored or served at, in seconds.
const STEPS = [5, 10, 30];
// Firestore's limit is 1 MiB a doc; a series above this is binned coarser.
const MAX_DOC_BYTES = 800 * 1024;

// The uids that get the series and all-sport intake, from the
// comma-separated GARMIN_SERIES_UIDS. Empty when it is unset.
function seriesUids(env) {
  return String((env || process.env).GARMIN_SERIES_UIDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

// Garmin activityType -> "running" | "cycling" | "swimming" | the type
// lowercased (e.g. "strength_training"). null when Garmin sent none.
function sportFor(activityType) {
  const t = String(activityType || "").trim().toUpperCase();
  if (!t) return null;
  if (lib.runTypeFor(t) || /RUN/.test(t)) return "running";
  if (/CYCL|BIK|RIDE|BMX/.test(t)) return "cycling";
  if (/SWIM/.test(t)) return "swimming";
  return t.toLowerCase();
}

function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
// Running-form values and heart rate can't be 0, so 0 = absent.
function pos(v) { return typeof v === "number" && isFinite(v) && v > 0 ? v : null; }
function nonNeg(v) { return typeof v === "number" && isFinite(v) && v >= 0 ? v : null; }
function round(v, dp) {
  if (v == null) return null;
  const f = Math.pow(10, dp || 0);
  return Math.round(v * f) / f;
}
function msOf(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  if (typeof t === "string" && t) return new Date(t).getTime();
  return NaN;
}

// One FIT record -> the stored units, or null per field when it is absent.
// fit-file-parser runs with speedUnit "m/s" and lengthUnit "m".
function recordValues(r, running) {
  const cad = nonNeg(r.cadence);
  const spd = nonNeg(r.enhanced_speed != null ? r.enhanced_speed : r.speed);
  const alt = num(r.enhanced_altitude != null ? r.enhanced_altitude : r.altitude);
  const bal = pos(r.stance_time_balance);
  return {
    power: nonNeg(r.power),
    speed: spd == null ? null : spd * 100,
    hr: pos(r.heart_rate),
    // Running cadence is per leg in the FIT, as in dynamicsFromFitSession.
    cadence: cad == null ? null : (cad + (num(r.fractional_cadence) || 0)) * (running ? 2 : 1),
    alt: alt == null ? null : alt * 10,
    gct: pos(r.stance_time),
    vo: pos(r.vertical_oscillation),
    stepLen: pos(r.step_length),
    gctBalL: bal == null ? null : bal * 100,
  };
}

// records (sorted, each with a finite .ms) -> { n, series } at step seconds,
// bin k covering [t0 + k*step, t0 + (k+1)*step). Each value is the rounded
// mean of the records in the bin that carry it (altitude: the last one); a
// bin with no records (a timer pause) is null in every field.
function binRecords(records, step, running, t0) {
  if (!records.length) {
    const empty = {};
    FIELDS.forEach((f) => { empty[f] = []; });
    return { n: 0, series: empty };
  }
  const w = step * 1000;
  // floor + 1, not ceil: the last record always has a bin, also when the
  // elapsed time is an exact multiple of the step.
  const n = Math.floor((records[records.length - 1].ms - t0) / w) + 1;
  const sum = {}, cnt = {}, series = {};
  FIELDS.forEach((f) => { sum[f] = new Float64Array(n); cnt[f] = new Uint32Array(n); });
  const seen = new Uint8Array(n);
  for (const r of records) {
    const k = Math.min(n - 1, Math.max(0, Math.floor((r.ms - t0) / w)));
    seen[k] = 1;
    const v = recordValues(r.rec, running);
    for (const f of FIELDS) {
      if (v[f] == null) continue;
      if (f === "alt") { sum.alt[k] = v.alt; cnt.alt[k] = 1; } else { sum[f][k] += v[f]; cnt[f][k]++; }
    }
  }
  for (const f of FIELDS) {
    const out = new Array(n);
    for (let k = 0; k < n; k++) out[k] = seen[k] && cnt[f][k] ? Math.round(sum[f][k] / cnt[f][k]) : null;
    series[f] = out;
  }
  return { n, series };
}

// A stored series re-binned from fromStep to a coarser toStep (a multiple of
// it): mean of the non-null values in each group (alt: the last), null when
// none. fields limits what is returned (default all). A toStep that is not a
// coarser multiple returns the series as stored.
function rebin(series, fromStep, toStep, fields) {
  const want = (fields && fields.length ? fields : FIELDS).filter((f) => FIELDS.includes(f));
  const src = series || {};
  const factor = toStep / fromStep;
  const coarser = toStep > fromStep && Number.isInteger(factor);
  const out = {};
  let n = 0;
  for (const f of want) {
    const a = Array.isArray(src[f]) ? src[f] : [];
    n = Math.max(n, coarser ? Math.ceil(a.length / factor) : a.length);
    if (!coarser) { out[f] = a.slice(); continue; }
    const b = new Array(Math.ceil(a.length / factor));
    for (let k = 0; k < b.length; k++) {
      let s = 0, c = 0, last = null;
      for (let i = k * factor; i < Math.min(a.length, (k + 1) * factor); i++) {
        if (a[i] == null) continue;
        s += a[i]; c++; last = a[i];
      }
      b[k] = c ? (f === "alt" ? last : Math.round(s / c)) : null;
    }
    out[f] = b;
  }
  return { step: coarser ? toStep : fromStep, n, series: out };
}

function avgSpeedCms(x) {
  const v = nonNeg(x.enhanced_avg_speed != null ? x.enhanced_avg_speed : x.avg_speed);
  return v == null ? null : Math.round(v * 100);
}

// fit-file-parser's profile gives training_load_peak a scale of 1; the FIT
// SDK profile's is 65536, so the raw value is scaled here.
const TRAINING_LOAD_SCALE = 65536;

// FIT session -> the session block. Running cadence, vertical ratio and the
// other running dynamics use dynamicsFromFitSession's rules; vo and step
// length stay in mm, GCT balance in percent. null for anything the FIT lacks.
function sessionFields(s, running) {
  s = s || {};
  const dyn = lib.dynamicsFromFitSession(s);
  const load = num(s.training_load_peak);
  return {
    avgHr: pos(s.avg_heart_rate), maxHr: pos(s.max_heart_rate),
    avgPower: nonNeg(s.avg_power), normPower: pos(s.normalized_power),
    avgSpeedCms: avgSpeedCms(s),
    totalAscentM: num(s.total_ascent), totalDescentM: num(s.total_descent),
    avgCadence: running ? dyn.cadence : round(nonNeg(s.avg_cadence), 1),
    avgGct: round(pos(s.avg_stance_time), 1), avgVo: round(pos(s.avg_vertical_oscillation), 1),
    avgStepLen: round(pos(s.avg_step_length), 1), avgVratio: round(dyn.vratio, 2),
    avgGctBalL: round(pos(s.avg_stance_time_balance), 2),
    aerobicTE: num(s.total_training_effect), anaerobicTE: num(s.total_anaerobic_training_effect),
    trainingLoad: load == null ? null : round(load / TRAINING_LOAD_SCALE, 1),
    intensityFactor: num(s.intensity_factor), thresholdPower: pos(s.threshold_power),
    tss: num(s.training_stress_score),
  };
}

function lapFields(l, t0) {
  const start = msOf(l.start_time);
  return {
    startSec: isFinite(start) && isFinite(t0) ? round((start - t0) / 1000, 1) : null,
    durSec: round(pos(l.total_timer_time != null ? l.total_timer_time : l.total_elapsed_time), 1),
    distM: round(nonNeg(l.total_distance), 1),
    avgHr: pos(l.avg_heart_rate),
    avgSpeedCms: avgSpeedCms(l),
    avgPower: nonNeg(l.avg_power),
  };
}

// Firestore's stored size, roughly: 8 bytes a number, 1 a null, plus the rest
// of the doc as JSON.
function estimateBytes(doc) {
  let b = 0;
  const s = doc.series || {};
  for (const f of FIELDS) for (const v of s[f] || []) b += v == null ? 1 : 8;
  const rest = Object.assign({}, doc, { series: null });
  return b + JSON.stringify(rest).length;
}

function itemFields(item) {
  const title = String(item.activityName || "");
  return {
    activityId: String(item.activityId),
    sport: sportFor(item.activityType),
    subType: item.activityType ? String(item.activityType).toLowerCase() : null,
    title,
    deviceName: lib.cleanDevice(item.deviceName),
  };
}

// The series doc for an activity file: item is the queued activityFiles item,
// fitData fit-file-parser's "list" output ({ records, laps, sessions }). The
// series is binned at step seconds, then at each coarser step in STEPS while
// the doc would be over MAX_DOC_BYTES; if even the coarsest is, the doc keeps
// session and laps only, with series null and seriesOmitted true (the caller
// logs it). null without an activity id or a start time.
function buildSeriesDoc(item, fitData, step) {
  step = step || STEPS[0];
  if (!item || item.activityId == null) return null;
  const data = fitData || {};
  const base = itemFields(item);
  const running = base.sport === "running";
  const records = (data.records || [])
    .map((rec) => ({ rec, ms: msOf(rec && rec.timestamp) }))
    .filter((r) => r.rec && isFinite(r.ms))
    .sort((a, b) => a.ms - b.ms);
  const sessions = data.sessions || [];
  const s = sessions.find((x) => String(x.sport || "").toLowerCase() === base.sport) || sessions[0] || null;
  const t0 = records.length ? records[0].ms
    : s && s.start_time ? msOf(s.start_time) : Number(item.startTimeInSeconds) * 1000;
  if (!isFinite(t0)) return null;

  const doc = Object.assign(base, {
    startTs: t0,
    durSec: s ? round(pos(s.total_timer_time != null ? s.total_timer_time : s.total_elapsed_time), 1) : null,
    distM: s ? round(nonNeg(s.total_distance), 1) : null,
    step: null, n: 0, series: null,
    laps: (data.laps || []).map((l) => lapFields(l, t0)),
    session: sessionFields(s, running),
    fromFile: true,
  });
  for (const st of STEPS.filter((x) => x >= step)) {
    const b = binRecords(records, st, running, t0);
    const candidate = Object.assign({}, doc, { step: st, n: b.n, series: b.series });
    if (estimateBytes(candidate) <= MAX_DOC_BYTES) return candidate;
  }
  return Object.assign(doc, { seriesOmitted: true });
}

// What an activity summary (no file yet) gives the series doc: identity,
// duration and distance, and the session values a summary carries.
function seriesFromSummary(item) {
  if (!item || item.activityId == null) return null;
  const start = Number(item.startTimeInSeconds);
  if (!isFinite(start)) return null;
  const base = itemFields(item);
  const spd = nonNeg(item.averageSpeedInMetersPerSecond);
  return Object.assign(base, {
    startTs: start * 1000,
    durSec: pos(item.durationInSeconds),
    distM: nonNeg(item.distanceInMeters),
    session: {
      avgHr: pos(item.averageHeartRateInBeatsPerMinute), maxHr: pos(item.maxHeartRateInBeatsPerMinute),
      avgSpeedCms: spd == null ? null : Math.round(spd * 100),
      totalAscentM: num(item.totalElevationGainInMeters), totalDescentM: num(item.totalElevationLossInMeters),
      avgCadence: base.sport === "running" ? lib.summaryCadence(item.averageRunCadenceInStepsPerMinute) : null,
    },
  });
}

function empty(v) { return v == null || v === ""; }

// The stored series doc once add is applied to have (the stored doc, or null).
// A file's values replace a summary's, but a value the file lacks keeps the
// summary's; once a file has landed (have.fromFile) a summary only fills what
// is still empty. An empty title never replaces a stored one. Same rule as
// runUpdate in garmin.js.
function mergeSeries(have, add, fromFile) {
  const out = Object.assign({}, have || {});
  const fillOnly = !fromFile && !!(have && have.fromFile);
  for (const k of Object.keys(add)) {
    if (k === "session") continue;
    const v = add[k];
    if (empty(v)) continue;
    if (fillOnly && !empty(out[k])) continue;
    out[k] = v;
  }
  const hs = (have && have.session) || {}, as = add.session || {};
  const session = {};
  for (const k of new Set(Object.keys(hs).concat(Object.keys(as)))) {
    const hv = hs[k] === undefined ? null : hs[k], av = as[k] === undefined ? null : as[k];
    session[k] = av == null || (fillOnly && hv != null) ? hv : av;
  }
  out.session = session;
  out.fromFile = !!(fromFile || (have && have.fromFile));
  return out;
}

module.exports = {
  FIELDS, STEPS, MAX_DOC_BYTES, seriesUids, sportFor, buildSeriesDoc, rebin,
  seriesFromSummary, mergeSeries, estimateBytes,
};
