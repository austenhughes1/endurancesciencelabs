// esMcp: a read-only MCP server (streamable HTTP, stateless) that serves the
// garminSeries docs of one account to Claude as a custom connector. The URL
// ends in ES_MCP_KEY (.../esMcp/<key>); anything else gets a 404. The account
// served is the first uid in GARMIN_SERIES_UIDS, fixed here: no request can
// name another. Setup: docs/garmin-series.md.
"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const lib = require("./garmin-lib");
const gs = require("./garmin-series");

const db = admin.firestore();

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
const MIN_KEY_LENGTH = 32;
const MILE_M = 1609.34;
const TZ = "America/Denver";
// Pace bands in seconds per mile, each [lo, hi).
const PACE_BANDS = [
  ["<5:00", 0, 300], ["5:00-5:30", 300, 330], ["5:30-6:00", 330, 360],
  ["6:00-6:30", 360, 390], ["6:30-7:00", 390, 420], [">7:00", 420, Infinity],
];
const LEVER = /lever/i;
const LIST_FIELDS = ["activityId", "startTs", "sport", "subType", "title", "durSec", "distM", "n", "session"];
const RUN_FIELDS = ["id", "ts", "type", "title", "durSec", "distMi", "avgHr", "paceSec", "source", "garminActivityId"];
const WEEK_FIELDS = ["startTs", "sport", "title", "durSec", "distM", "step", "series.speed", "session.avgPower", "session.tss"];

function servedUid() { return gs.seriesUids()[0] || null; }

// A failure the caller can act on; its message goes back to Claude.
class ToolError extends Error {}

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
// The America/Denver calendar date of a time, "YYYY-MM-DD".
function localDate(ms) { return dayFormat.format(new Date(ms)); }

function isoDate(s) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || ""));
  if (!m) return null;
  const t = Date.parse(m[1] + "T00:00:00Z");
  return isFinite(t) && new Date(t).toISOString().slice(0, 10) === m[1] ? m[1] : null;
}

// from/to (local dates, both included) -> the dates, and a startTs window
// wide enough to hold every activity on them; callers filter by localDate.
function dateRange(from, to) {
  const f = isoDate(from), t = isoDate(to);
  if (!f || !t) throw new ToolError("from and to must be dates, YYYY-MM-DD.");
  const days = (Date.parse(t) - Date.parse(f)) / DAY + 1;
  if (days < 1) throw new ToolError("to is before from.");
  if (days > MAX_RANGE_DAYS) throw new ToolError(`That range is ${days} days; ask for at most ${MAX_RANGE_DAYS} at a time.`);
  return { from: f, to: t, lo: Date.parse(f) - DAY, hi: Date.parse(t) + 2 * DAY };
}

function round(v, dp) {
  if (v == null || !isFinite(v)) return null;
  const f = Math.pow(10, dp || 0);
  return Math.round(v * f) / f;
}

function mondayOf(date) {
  const d = Date.parse(date + "T00:00:00Z");
  return new Date(d - ((new Date(d).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}
function isoWeek(monday) {
  const thu = Date.parse(monday + "T00:00:00Z") + 3 * DAY;
  const y = new Date(thu).getUTCFullYear();
  return `${y}-W${String(Math.floor((thu - Date.UTC(y, 0, 1)) / (7 * DAY)) + 1).padStart(2, "0")}`;
}
function addDays(date, n) { return new Date(Date.parse(date + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10); }

function bandFor(paceSec) {
  const b = PACE_BANDS.find((x) => paceSec >= x[1] && paceSec < x[2]);
  return b ? b[0] : PACE_BANDS[PACE_BANDS.length - 1][0];
}
function zeroBands() {
  const o = {};
  PACE_BANDS.forEach((b) => { o[b[0]] = 0; });
  return o;
}

// Firestore Timestamps -> ISO text, so a doc goes out as plain JSON.
function plain(doc) {
  const out = {};
  for (const k of Object.keys(doc)) {
    const v = doc[k];
    out[k] = v && typeof v.toMillis === "function" ? new Date(v.toMillis()).toISOString() : v;
  }
  return out;
}

// The tools over one account's data. db and uid come from the server, never
// from a tool's arguments.
function makeTools(fdb, uid) {
  const userRef = fdb.collection("users").doc(uid);
  const seriesCol = userRef.collection("garminSeries");
  const runsCol = userRef.collection("garminActivities");

  async function seriesIn(r, fields) {
    const q = seriesCol.where("startTs", ">=", r.lo).where("startTs", "<", r.hi);
    const snap = await q.select(...fields).get();
    return snap.docs.map((d) => d.data())
      .filter((x) => { const day = localDate(x.startTs); return day >= r.from && day <= r.to; })
      .sort((a, b) => a.startTs - b.startTs);
  }

  async function seriesDoc(activityId) {
    const id = String(activityId == null ? "" : activityId);
    if (!id || id.includes("/")) throw new ToolError("activityId is required.");
    const snap = await seriesCol.doc(id).get();
    if (!snap.exists) throw new ToolError(`No activity ${id}.`);
    return snap.data();
  }

  // list_activities: series docs in the range, plus the runs in
  // garminActivities that no series doc covers (seriesAvailable false).
  async function listActivities(args) {
    const a = args || {};
    const r = dateRange(a.from, a.to);
    const sport = a.sport ? String(a.sport).trim().toLowerCase() : null;
    const docs = await seriesIn(r, LIST_FIELDS);
    const out = docs.map((d) => {
      const s = d.session || {};
      return {
        activityId: d.activityId, startTs: d.startTs, sport: d.sport, subType: d.subType, title: d.title,
        durSec: d.durSec, distM: d.distM,
        avgHr: s.avgHr == null ? null : s.avgHr, avgPower: s.avgPower == null ? null : s.avgPower,
        normPower: s.normPower == null ? null : s.normPower, avgSpeedCms: s.avgSpeedCms == null ? null : s.avgSpeedCms,
        seriesAvailable: d.n > 0,
      };
    });
    const runs = await runsCol.where("ts", ">=", r.lo).where("ts", "<", r.hi).select(...RUN_FIELDS).get();
    for (const snap of runs.docs) {
      const x = snap.data();
      const day = localDate(Number(x.ts));
      if (day < r.from || day > r.to) continue;
      const covered = docs.some((d) => (x.garminActivityId != null && String(x.garminActivityId) === d.activityId) ||
        lib.sameRunSpan(Number(x.ts), x.durSec, d.startTs, d.durSec));
      if (covered) continue;
      out.push({
        activityId: x.garminActivityId != null ? String(x.garminActivityId) : snap.id,
        startTs: Number(x.ts), sport: "running",
        subType: x.type ? String(x.type).toLowerCase().replace(/\s+/g, "_") : null,
        title: x.title || "", durSec: x.durSec == null ? null : x.durSec,
        distM: x.distMi == null ? null : round(x.distMi * MILE_M, 1),
        avgHr: x.avgHr == null ? null : x.avgHr, avgPower: null, normPower: null,
        avgSpeedCms: x.paceSec ? Math.round(MILE_M / x.paceSec * 100) : null,
        source: x.source || "upload", seriesAvailable: false,
      });
    }
    const list = out.filter((x) => !sport || x.sport === sport).sort((p, q) => p.startTs - q.startTs);
    return { from: r.from, to: r.to, timeZone: TZ, count: list.length, activities: list };
  }

  async function getActivity(args) {
    return plain(await seriesDoc((args || {}).activityId));
  }

  // get_series: the stored series, re-binned when a coarser step is asked for.
  // A step finer than the stored one returns the stored step.
  async function getSeries(args) {
    const a = args || {};
    const d = await seriesDoc(a.activityId);
    if (!d.series || !d.step) throw new ToolError(`Activity ${d.activityId} has no series stored (summary only, or too large to keep).`);
    if (a.step != null && !gs.STEPS.includes(Number(a.step))) throw new ToolError(`step must be one of ${gs.STEPS.join(", ")}.`);
    const fields = Array.isArray(a.fields) && a.fields.length ? a.fields : gs.FIELDS;
    const bad = fields.filter((f) => !gs.FIELDS.includes(f));
    if (bad.length) throw new ToolError(`Unknown field ${bad.join(", ")}; fields are ${gs.FIELDS.join(", ")}.`);
    return gs.rebin(d.series, d.step, a.step != null ? Number(a.step) : d.step, fields);
  }

  // weekly_summary: per ISO week (Mon-Sun, America/Denver) from the series
  // docs. Run miles are the activity's distance; pace-band miles come from
  // the speed series (speed x step per bin). Lever runs (title matching
  // /lever/i) are counted apart from runMiles, the bands and the longest run.
  async function weeklySummary(args) {
    const a = args || {};
    const r = dateRange(a.from, a.to);
    const docs = await seriesIn(r, WEEK_FIELDS);
    const weeks = new Map();
    for (let m = mondayOf(r.from); m <= r.to; m = addDays(m, 7)) {
      weeks.set(m, {
        week: isoWeek(m), weekStart: m, weekEnd: addDays(m, 6),
        sessions: 0, hoursBySport: {},
        runMiles: 0, runMilesByPace: zeroBands(), runMilesNoSeries: 0, longestRunMi: 0,
        lever: { sessions: 0, miles: 0, milesByPace: zeroBands() },
        bike: { sessions: 0, hours: 0, avgPowerW: null, powerHours: 0, tss: null },
        _pw: 0,
      });
    }
    for (const d of docs) {
      const w = weeks.get(mondayOf(localDate(d.startTs)));
      if (!w) continue;
      const hours = (Number(d.durSec) || 0) / 3600;
      const sport = d.sport || "other";
      w.sessions++;
      w.hoursBySport[sport] = (w.hoursBySport[sport] || 0) + hours;
      if (sport === "running") {
        const speed = d.series && Array.isArray(d.series.speed) ? d.series.speed : null;
        const step = Number(d.step) || 0;
        const bands = zeroBands();
        let seriesM = 0;
        if (speed && step) {
          for (const v of speed) {
            if (!(v > 0)) continue;
            const m = v / 100 * step;
            seriesM += m;
            bands[bandFor(MILE_M / (v / 100))] += m / MILE_M;
          }
        }
        const miles = (d.distM != null ? Number(d.distM) : seriesM) / MILE_M;
        const bucket = LEVER.test(String(d.title || "")) ? w.lever : null;
        if (bucket) {
          bucket.sessions++;
          bucket.miles += miles;
          for (const k of Object.keys(bands)) bucket.milesByPace[k] += bands[k];
        } else {
          w.runMiles += miles;
          for (const k of Object.keys(bands)) w.runMilesByPace[k] += bands[k];
          if (!(speed && step)) w.runMilesNoSeries += miles;
          w.longestRunMi = Math.max(w.longestRunMi, miles);
        }
      } else if (sport === "cycling") {
        const s = d.session || {};
        w.bike.sessions++;
        w.bike.hours += hours;
        if (s.avgPower != null && hours > 0) { w._pw += s.avgPower * hours; w.bike.powerHours += hours; }
        if (s.tss != null) w.bike.tss = (w.bike.tss || 0) + s.tss;
      }
    }
    const out = [];
    for (const w of weeks.values()) {
      for (const k of Object.keys(w.hoursBySport)) w.hoursBySport[k] = round(w.hoursBySport[k], 2);
      for (const k of Object.keys(w.runMilesByPace)) {
        w.runMilesByPace[k] = round(w.runMilesByPace[k], 2);
        w.lever.milesByPace[k] = round(w.lever.milesByPace[k], 2);
      }
      w.runMiles = round(w.runMiles, 2);
      w.runMilesNoSeries = round(w.runMilesNoSeries, 2);
      w.longestRunMi = round(w.longestRunMi, 2);
      w.lever.miles = round(w.lever.miles, 2);
      w.bike.avgPowerW = w.bike.powerHours > 0 ? Math.round(w._pw / w.bike.powerHours) : null;
      w.bike.hours = round(w.bike.hours, 2);
      w.bike.powerHours = round(w.bike.powerHours, 2);
      w.bike.tss = round(w.bike.tss, 1);
      delete w._pw;
      out.push(w);
    }
    return {
      from: r.from, to: r.to, timeZone: TZ,
      paceBands: PACE_BANDS.map((b) => b[0]), paceUnit: "min/mile",
      notes: "runMiles is distance from each run's session; runMilesByPace sums its speed series, so the two can differ slightly. " +
        "runMilesNoSeries: run miles with no speed series (summary only). Lever runs (title matches /lever/i) are under lever, not in runMiles, runMilesByPace or longestRunMi. " +
        "bike.avgPowerW is weighted by ride time over rides that report power (bike.powerHours).",
      weeks: out,
    };
  }

  return { listActivities, getActivity, getSeries, weeklySummary };
}

const DESCRIPTIONS = {
  list_activities: "List Garmin activities between two dates (YYYY-MM-DD, America/Denver, both included, at most 92 days), " +
    "oldest first, with session averages. sport filters by running, cycling, swimming or another Garmin type. " +
    "Runs from before the series began come from the run log with seriesAvailable false.",
  get_activity: "One activity's full stored doc: identity, session values, laps and its series at the stored step " +
    "(power W, speed cm/s, hr bpm, cadence spm (running) or rpm, alt dm, gct ms, vo mm, stepLen mm, gctBalL percent x100; null = no data, e.g. a timer pause).",
  get_series: "An activity's series only, optionally a subset of fields and re-binned to step 10 or 30 seconds (mean per bin, altitude last value). " +
    "Use this over get_activity for long activities.",
  weekly_summary: "Per ISO week (Mon-Sun, America/Denver) between two dates, at most 92 days: sessions, hours by sport, run miles and run miles " +
    "by pace band (min/mile, from the speed series), Lever runs apart, longest run, and bike hours, time-weighted average power and TSS.",
};

function buildServer(uid) {
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const { z } = require("zod");
  const t = makeTools(db, uid);
  const server = new McpServer({ name: "endurance-science-labs", version: "1.0.0" });
  const date = (what) => z.string().describe(`${what} date, YYYY-MM-DD (America/Denver)`);
  const id = z.string().describe("The activity's activityId, from list_activities");
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const wrap = (fn) => async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(args)) }] };
    } catch (e) {
      if (e instanceof ToolError) return { isError: true, content: [{ type: "text", text: e.message }] };
      console.error("esMcp tool error:", e.message);
      return { isError: true, content: [{ type: "text", text: "The tool failed; try again." }] };
    }
  };
  server.registerTool("list_activities", {
    description: DESCRIPTIONS.list_activities, annotations: readOnly,
    inputSchema: { from: date("First"), to: date("Last"), sport: z.string().optional().describe("e.g. running, cycling, swimming") },
  }, wrap(t.listActivities));
  server.registerTool("get_activity", {
    description: DESCRIPTIONS.get_activity, annotations: readOnly, inputSchema: { activityId: id },
  }, wrap(t.getActivity));
  server.registerTool("get_series", {
    description: DESCRIPTIONS.get_series, annotations: readOnly,
    inputSchema: {
      activityId: id,
      fields: z.array(z.enum(gs.FIELDS)).optional().describe("Default: all"),
      step: z.union([z.literal(5), z.literal(10), z.literal(30)]).optional().describe("Seconds per bin; default the stored step"),
    },
  }, wrap(t.getSeries));
  server.registerTool("weekly_summary", {
    description: DESCRIPTIONS.weekly_summary, annotations: readOnly,
    inputSchema: { from: date("First"), to: date("Last") },
  }, wrap(t.weeklySummary));
  return server;
}

exports.esMcp = onRequest({ cors: false, maxInstances: 2, timeoutSeconds: 60, memory: "256MiB" }, async (req, res) => {
  const key = process.env.ES_MCP_KEY || "";
  const uid = servedUid();
  if (key.length < MIN_KEY_LENGTH || !uid || !lib.sameSecret(lib.lastPathSegment(req.path), key)) {
    res.status(404).send("Not found");
    return;
  }
  // Stateless: no sessions, so no GET stream and no DELETE.
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").send("Method not allowed");
    return;
  }
  try {
    const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const server = buildServer(uid);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("esMcp error:", e.message);
    if (!res.headersSent) res.status(500).send("Server error");
  }
});

// For the tests; not a Cloud Function (index.js exports esMcp only).
exports.makeTools = makeTools;
exports.MAX_RANGE_DAYS = MAX_RANGE_DAYS;
