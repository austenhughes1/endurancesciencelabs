// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-data.test.js
//
// Pins for the data side of the Training Analysis view
// (shared/run-dynamics-data.js). Run with plain node:
//
//   node shared/run-dynamics-data.test.js
//
// The Today card's math is frozen by owner decision: its thresholds,
// headlines, target ranges and flat/hilly/Lever conversions may not move.
// These pins were taken from the model as it stood when it was lifted out
// of run-dynamics.js (the card's markup was checked identical in the render
// harness for every role and demo preset). A failure here means a number on
// the Today card changed. All athletes are made up.
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var win = {};
var ctx = { window: win, Number: Number, Math: Math, Date: Date, Set: Set, Object: Object, Array: Array, String: String, console: console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'run-load-model.js'), 'utf8'), ctx);
ctx.RunLoad = win.RunLoad;
vm.runInContext(fs.readFileSync(path.join(__dirname, 'run-dynamics-data.js'), 'utf8'), ctx);
var D = win.RunData;

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  if (got !== want) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function section(name, fn) { console.log(name); fn(); }

// Made-up athletes, built in local time relative to a fixed "now".
var NOW = new Date(2026, 5, 15, 18, 0);
function run(k, mi, pace, hour) { var d = new Date(2026, 5, 15 - k, hour == null ? 7 : hour); return { id: 'r' + k + '_' + mi, ts: d.getTime(), date: d, distMi: mi, paceSec: pace || 540, type: 'Running' }; }
function days(n, fn) { var out = []; for (var k = n - 1; k >= 0; k--) { var r = fn(k); if (r) out = out.concat(r); } return out; }
function fourDays(k) { return [1, 3, 5, 6].indexOf(k % 7) < 0; }
function ramp(L, g) { return days(70, function (k) { return run(k, k >= L ? 5 : 5 * (1 + g * (L - k))); }); }
function buildCases(D, RL) {
  var P = Object.assign({}, RL.DEFAULTS, { basePaceSec: 540 });
  var S = {
    'steady, ran today': days(70, function (k) { return fourDays(k) ? run(k, 6) : null; }),
    'longer run today': days(70, function (k) { return fourDays(k) ? run(k, k === 0 ? 8 : 6) : null; }),
    'a bit longer today': days(70, function (k) { return fourDays(k) ? run(k, k === 0 ? 7 : 6) : null; }),
    'huge run today': days(70, function (k) { return k === 0 ? run(0, 20, 480) : (fourDays(k) ? run(k, 6) : null); }),
    'ten days off': days(70, function (k) { return k >= 10 && fourDays(k) ? run(k, 6) : null; }),
    'two runs today': days(70, function (k) { return k === 0 ? [run(0, 3, 540, 6), run(0, 4, 540, 17)] : (fourDays(k) ? run(k, 6) : null); }),
    'gentle steady ramp': ramp(17, 0.02),
    'short steep ramp': ramp(5, 0.06),
    'short very steep ramp': ramp(5, 0.14),
    'one run only': [run(0, 5)]
  };
  var out = [];
  Object.keys(S).forEach(function (k) {
    [false, true].forEach(function (coach) {
      out.push({ name: k + (coach ? ' (coach)' : ''), model: D.heroModel({ runs: S[k], params: P, now: NOW, demo: null, leverPct: 85, coach: coach }) });
    });
  });
  out.push({ name: 'steady at 70% BW Lever support', model: D.heroModel({ runs: S['longer run today'], params: P, now: NOW, demo: null, leverPct: 70, coach: false }) });
  Object.keys(D.DEMO_PRESETS).forEach(function (k) {
    out.push({ name: 'demo ' + k, model: D.heroModel({ runs: S['steady, ran today'], params: P, now: NOW, demo: D.DEMO_PRESETS[k], leverPct: 80, coach: true }) });
  });
  return out;
}

var cases = buildCases(D, win.RunLoad);
var PINS = {
  "steady, ran today": {
    "short": false,
    "head": "In the safe band",
    "accent": "var(--good)",
    "todo": "Easy run or workout. Both fit today.",
    "lo": 4.8,
    "hi": 6.9,
    "flat": 6.9,
    "hilly": 5.52,
    "lever": 7.9083,
    "leverInTarget": false,
    "r1": 1,
    "r3": 1,
    "r7": 1,
    "base": 2.5714,
    "d1": 6,
    "d3": 4,
    "d28": 2.5714,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "0%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 6
  },
  "steady, ran today (coach)": {
    "short": false,
    "head": "In the safe band",
    "accent": "var(--good)",
    "todo": "Easy run or workout. Both fit today.",
    "lo": 4.8,
    "hi": 6.9,
    "flat": 6.9,
    "hilly": 5.52,
    "lever": 7.9083,
    "leverInTarget": false,
    "r1": 1,
    "r3": 1,
    "r7": 1,
    "base": 2.5714,
    "d1": 6,
    "d3": 4,
    "d28": 2.5714,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "0%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 6
  },
  "longer run today": {
    "short": false,
    "head": "At your ceiling — ease off",
    "accent": "var(--gold)",
    "todo": "At your ceiling: easy only, no hard efforts.",
    "lo": 3.6,
    "hi": 5.4,
    "flat": 5.4,
    "hilly": 4.32,
    "lever": 6.1891,
    "leverInTarget": true,
    "r1": 1.3333,
    "r3": 1.1667,
    "r7": 1.0811,
    "base": 2.6429,
    "d1": 8,
    "d3": 4.6667,
    "d28": 2.6429,
    "typical": 6,
    "col1": "var(--gold)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+15%",
    "rampCol": "var(--gold)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 8
  },
  "longer run today (coach)": {
    "short": false,
    "head": "At your ceiling — ease off",
    "accent": "var(--gold)",
    "todo": "At their ceiling: easy only, no hard efforts.",
    "lo": 3.6,
    "hi": 5.4,
    "flat": 5.4,
    "hilly": 4.32,
    "lever": 6.1891,
    "leverInTarget": true,
    "r1": 1.3333,
    "r3": 1.1667,
    "r7": 1.0811,
    "base": 2.6429,
    "d1": 8,
    "d3": 4.6667,
    "d28": 2.6429,
    "typical": 6,
    "col1": "var(--gold)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+15%",
    "rampCol": "var(--gold)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 8
  },
  "a bit longer today": {
    "short": false,
    "head": "Approaching your ceiling",
    "accent": "var(--gold)",
    "todo": "Near your ceiling: easy only today.",
    "lo": 4.2,
    "hi": 6,
    "flat": 6,
    "hilly": 4.8,
    "lever": 6.8768,
    "leverInTarget": true,
    "r1": 1.1667,
    "r3": 1.0833,
    "r7": 1.0411,
    "base": 2.6071,
    "d1": 7,
    "d3": 4.3333,
    "d28": 2.6071,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+8%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 7
  },
  "a bit longer today (coach)": {
    "short": false,
    "head": "Approaching your ceiling",
    "accent": "var(--gold)",
    "todo": "Near their ceiling: easy only today.",
    "lo": 4.2,
    "hi": 6,
    "flat": 6,
    "hilly": 4.8,
    "lever": 6.8768,
    "leverInTarget": true,
    "r1": 1.1667,
    "r3": 1.0833,
    "r7": 1.0411,
    "base": 2.6071,
    "d1": 7,
    "d3": 4.3333,
    "d28": 2.6071,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+8%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 7
  },
  "huge run today": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over your range: recovery day or rest.",
    "lo": 1.8,
    "hi": 3.6,
    "flat": 3.6,
    "hilly": 2.88,
    "lever": 4.1261,
    "leverInTarget": true,
    "r1": 3.5355,
    "r3": 2.2678,
    "r7": 1.5233,
    "base": 3.1148,
    "d1": 21.2132,
    "d3": 9.0711,
    "d28": 3.1148,
    "typical": 6,
    "col1": "var(--bad)",
    "col3": "var(--bad)",
    "col7": "var(--bad)",
    "rampTxt": "+117%",
    "rampCol": "var(--bad)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 20
  },
  "huge run today (coach)": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over their range: recovery day or rest.",
    "lo": 1.8,
    "hi": 3.6,
    "flat": 3.6,
    "hilly": 2.88,
    "lever": 4.1261,
    "leverInTarget": true,
    "r1": 3.5355,
    "r3": 2.2678,
    "r7": 1.5233,
    "base": 3.1148,
    "d1": 21.2132,
    "d3": 9.0711,
    "d28": 3.1148,
    "typical": 6,
    "col1": "var(--bad)",
    "col3": "var(--bad)",
    "col7": "var(--bad)",
    "rampTxt": "+117%",
    "rampCol": "var(--bad)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 20
  },
  "ten days off": {
    "short": false,
    "head": "Room to build",
    "accent": "var(--warn)",
    "todo": "You have room: easy, long or a workout all fit.",
    "lo": 5.4,
    "hi": 7.8,
    "flat": 7.8,
    "hilly": 6.24,
    "lever": 8.9398,
    "leverInTarget": false,
    "r1": 0,
    "r3": 0,
    "r7": 0,
    "base": 1.5,
    "d1": 0,
    "d3": 0,
    "d28": 1.5,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--warn)",
    "rampTxt": "-87%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "ten days off (coach)": {
    "short": false,
    "head": "Room to build",
    "accent": "var(--warn)",
    "todo": "Athlete has room: easy, long or a workout all fit.",
    "lo": 5.4,
    "hi": 7.8,
    "flat": 7.8,
    "hilly": 6.24,
    "lever": 8.9398,
    "leverInTarget": false,
    "r1": 0,
    "r3": 0,
    "r7": 0,
    "base": 1.5,
    "d1": 0,
    "d3": 0,
    "d28": 1.5,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--warn)",
    "rampTxt": "-87%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "two runs today": {
    "short": false,
    "head": "Approaching your ceiling",
    "accent": "var(--gold)",
    "todo": "Near your ceiling: easy only today.",
    "lo": 4.2,
    "hi": 6,
    "flat": 6,
    "hilly": 4.8,
    "lever": 6.8768,
    "leverInTarget": true,
    "r1": 1.1667,
    "r3": 1.0833,
    "r7": 1.0411,
    "base": 2.6071,
    "d1": 7,
    "d3": 4.3333,
    "d28": 2.6071,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+8%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 2,
    "todayMi": 7
  },
  "two runs today (coach)": {
    "short": false,
    "head": "Approaching your ceiling",
    "accent": "var(--gold)",
    "todo": "Near their ceiling: easy only today.",
    "lo": 4.2,
    "hi": 6,
    "flat": 6,
    "hilly": 4.8,
    "lever": 6.8768,
    "leverInTarget": true,
    "r1": 1.1667,
    "r3": 1.0833,
    "r7": 1.0411,
    "base": 2.6071,
    "d1": 7,
    "d3": 4.3333,
    "d28": 2.6071,
    "typical": 6,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+8%",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 2,
    "todayMi": 7
  },
  "gentle steady ramp": {
    "short": false,
    "head": "Approaching your ceiling",
    "accent": "var(--gold)",
    "todo": "Near your ceiling: easy only today.",
    "lo": 3.5,
    "hi": 5,
    "flat": 5,
    "hilly": 4,
    "lever": 5.7307,
    "leverInTarget": true,
    "r1": 1.0152,
    "r3": 1.0154,
    "r7": 1.1539,
    "base": 5.5464,
    "d1": 6.7,
    "d3": 6.6,
    "d28": 5.5464,
    "typical": 5,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+12%",
    "rampCol": "var(--gold)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 6.7
  },
  "gentle steady ramp (coach)": {
    "short": false,
    "head": "Approaching your ceiling",
    "accent": "var(--gold)",
    "todo": "Near their ceiling: easy only today.",
    "lo": 3.5,
    "hi": 5,
    "flat": 5,
    "hilly": 4,
    "lever": 5.7307,
    "leverInTarget": true,
    "r1": 1.0152,
    "r3": 1.0154,
    "r7": 1.1539,
    "base": 5.5464,
    "d1": 6.7,
    "d3": 6.6,
    "d28": 5.5464,
    "typical": 5,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+12%",
    "rampCol": "var(--gold)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 6.7
  },
  "short steep ramp": {
    "short": false,
    "head": "Climbing fast — ease the ramp",
    "accent": "var(--gold)",
    "todo": "Load rising +16%/wk: hold volume flat.",
    "lo": 3,
    "hi": 4.5,
    "flat": 4.5,
    "hilly": 3.6,
    "lever": 5.1576,
    "leverInTarget": true,
    "r1": 1.0484,
    "r3": 1.0508,
    "r7": 1.0934,
    "base": 5.1607,
    "d1": 6.5,
    "d3": 6.2,
    "d28": 5.1607,
    "typical": 5,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+16%",
    "rampCol": "var(--gold)",
    "isClimb": true,
    "todayRuns": 1,
    "todayMi": 6.5
  },
  "short steep ramp (coach)": {
    "short": false,
    "head": "Climbing fast — ease the ramp",
    "accent": "var(--gold)",
    "todo": "Load rising +16%/wk: hold volume flat.",
    "lo": 3,
    "hi": 4.5,
    "flat": 4.5,
    "hilly": 3.6,
    "lever": 5.1576,
    "leverInTarget": true,
    "r1": 1.0484,
    "r3": 1.0508,
    "r7": 1.0934,
    "base": 5.1607,
    "d1": 6.5,
    "d3": 6.2,
    "d28": 5.1607,
    "typical": 5,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+16%",
    "rampCol": "var(--gold)",
    "isClimb": true,
    "todayRuns": 1,
    "todayMi": 6.5
  },
  "short very steep ramp": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over your range: recovery day or rest.",
    "lo": 1.5,
    "hi": 3,
    "flat": 3,
    "hilly": 2.4,
    "lever": 3.4384,
    "leverInTarget": true,
    "r1": 1.0897,
    "r3": 1.0986,
    "r7": 1.2093,
    "base": 5.375,
    "d1": 8.5,
    "d3": 7.8,
    "d28": 5.375,
    "typical": 5,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+38%",
    "rampCol": "var(--bad)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 8.5
  },
  "short very steep ramp (coach)": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over their range: recovery day or rest.",
    "lo": 1.5,
    "hi": 3,
    "flat": 3,
    "hilly": 2.4,
    "lever": 3.4384,
    "leverInTarget": true,
    "r1": 1.0897,
    "r3": 1.0986,
    "r7": 1.2093,
    "base": 5.375,
    "d1": 8.5,
    "d3": 7.8,
    "d28": 5.375,
    "typical": 5,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+38%",
    "rampCol": "var(--bad)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 8.5
  },
  "one run only": {
    "short": true,
    "todo": "Import a few more weeks of runs and your daily guidance shows up here."
  },
  "one run only (coach)": {
    "short": true,
    "todo": "Daily guidance shows up here once this athlete has a few more weeks of runs."
  },
  "steady at 70% BW Lever support": {
    "short": false,
    "head": "At your ceiling — ease off",
    "accent": "var(--gold)",
    "todo": "At your ceiling: easy only, no hard efforts.",
    "lo": 3.6,
    "hi": 5.4,
    "flat": 5.4,
    "hilly": 4.32,
    "lever": 7.2483,
    "leverInTarget": true,
    "r1": 1.3333,
    "r3": 1.1667,
    "r7": 1.0811,
    "base": 2.6429,
    "d1": 8,
    "d3": 4.6667,
    "d28": 2.6429,
    "typical": 6,
    "col1": "var(--gold)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "+15%",
    "rampCol": "var(--gold)",
    "isClimb": false,
    "todayRuns": 1,
    "todayMi": 8
  },
  "demo bigday": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over their range: recovery day or rest.",
    "lo": 3.36,
    "hi": 6.72,
    "flat": 6.72,
    "hilly": 5.376,
    "lever": 8.0964,
    "leverInTarget": true,
    "r1": 2.3,
    "r3": 1.5,
    "r7": 1.15,
    "base": 8,
    "d1": 18.4,
    "d3": 12,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--bad)",
    "col3": "var(--gold)",
    "col7": "var(--good)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo hardday": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over their range: recovery day or rest.",
    "lo": 3.36,
    "hi": 6.72,
    "flat": 6.72,
    "hilly": 5.376,
    "lever": 8.0964,
    "leverInTarget": true,
    "r1": 1.6,
    "r3": 1.15,
    "r7": 1.05,
    "base": 8,
    "d1": 12.8,
    "d3": 9.2,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--bad)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo heavy3": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over their range: recovery day or rest.",
    "lo": 3.36,
    "hi": 6.72,
    "flat": 6.72,
    "hilly": 5.376,
    "lever": 8.0964,
    "leverInTarget": true,
    "r1": 1.2,
    "r3": 1.65,
    "r7": 1.25,
    "base": 8,
    "d1": 9.6,
    "d3": 13.2,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--good)",
    "col3": "var(--bad)",
    "col7": "var(--good)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo bigweek": {
    "short": false,
    "head": "Overreaching — recover next",
    "accent": "var(--bad)",
    "todo": "Over their range: recovery day or rest.",
    "lo": 3.36,
    "hi": 6.72,
    "flat": 6.72,
    "hilly": 5.376,
    "lever": 8.0964,
    "leverInTarget": true,
    "r1": 1.1,
    "r3": 1.35,
    "r7": 1.6,
    "base": 8,
    "d1": 8.8,
    "d3": 10.8,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--good)",
    "col3": "var(--gold)",
    "col7": "var(--bad)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo ceiling": {
    "short": false,
    "head": "At your ceiling — ease off",
    "accent": "var(--gold)",
    "todo": "At their ceiling: easy only, no hard efforts.",
    "lo": 6.72,
    "hi": 10.08,
    "flat": 10.08,
    "hilly": 8.064,
    "lever": 12.1446,
    "leverInTarget": true,
    "r1": 1,
    "r3": 1.2,
    "r7": 1.35,
    "base": 8,
    "d1": 8,
    "d3": 9.6,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--gold)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo building": {
    "short": false,
    "head": "Room to build",
    "accent": "var(--warn)",
    "todo": "Athlete has room: easy, long or a workout all fit.",
    "lo": 10.08,
    "hi": 14.56,
    "flat": 14.56,
    "hilly": 11.648,
    "lever": 17.5422,
    "leverInTarget": false,
    "r1": 0.6,
    "r3": 0.65,
    "r7": 0.7,
    "base": 8,
    "d1": 4.8,
    "d3": 5.2,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--warn)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo safe": {
    "short": false,
    "head": "In the safe band",
    "accent": "var(--good)",
    "todo": "Easy run or workout. Both fit today.",
    "lo": 8.96,
    "hi": 12.88,
    "flat": 12.88,
    "hilly": 10.304,
    "lever": 15.5181,
    "leverInTarget": false,
    "r1": 1.05,
    "r3": 1,
    "r7": 0.95,
    "base": 8,
    "d1": 8.4,
    "d3": 8,
    "d28": 8,
    "typical": 11.2,
    "col1": "var(--good)",
    "col3": "var(--good)",
    "col7": "var(--good)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  },
  "demo baseline": {
    "short": false,
    "head": "Building your baseline",
    "accent": "var(--muted2)",
    "todo": "Easy runs or Lever runs while we learn their baseline.",
    "lo": null,
    "hi": null,
    "flat": null,
    "hilly": null,
    "lever": null,
    "leverInTarget": false,
    "r1": null,
    "r3": null,
    "r7": null,
    "base": null,
    "d1": 0,
    "d3": 0,
    "d28": 0,
    "typical": 6,
    "col1": "var(--muted2)",
    "col3": "var(--muted2)",
    "col7": "var(--muted2)",
    "rampTxt": "—",
    "rampCol": "var(--muted2)",
    "isClimb": false,
    "todayRuns": 0,
    "todayMi": 0
  }
};

section('heroModel: every verdict state, both voices, Lever support and every demo preset', function () {
  eq('scenario count', cases.length, Object.keys(PINS).length);
  cases.forEach(function (c) {
    var want = PINS[c.name];
    if (!want) { eq(c.name + ' is pinned', false, true); return; }
    Object.keys(want).forEach(function (f) {
      var g = c.model[f];
      eq(c.name + ' · ' + f, (typeof g === 'number') ? +g.toFixed(4) : g, want[f]);
    });
  });
});

section('heroModel reaches all seven headlines', function () {
  var heads = {};
  cases.forEach(function (c) { if (c.model.head) heads[c.model.head] = 1; });
  ['Overreaching — recover next', 'At your ceiling — ease off', 'Climbing fast — ease the ramp', 'Approaching your ceiling',
    'Room to build', 'In the safe band', 'Building your baseline'].forEach(function (h) { eq('reached: ' + h, !!heads[h], true); });
});

section('acwrColor: the 0.8–1.3 safe band, gold above, red past 1.5', function () {
  eq('null', D.acwrColor(null), 'var(--muted2)');
  eq('0.79', D.acwrColor(0.79), 'var(--warn)');
  eq('0.8', D.acwrColor(0.8), 'var(--good)');
  eq('1.3', D.acwrColor(1.3), 'var(--good)');
  eq('1.31', D.acwrColor(1.31), 'var(--gold)');
  eq('1.5', D.acwrColor(1.5), 'var(--gold)');
  eq('1.51', D.acwrColor(1.51), 'var(--bad)');
});

section('calDaysAgo counts calendar days, not 24-hour spans', function () {
  var now = new Date(2026, 5, 15, 0, 30);
  eq('late last night', D.calDaysAgo(new Date(2026, 5, 14, 23, 50).getTime(), now), 1);
  eq('earlier today', D.calDaysAgo(new Date(2026, 5, 15, 0, 5).getTime(), now), 0);
  eq('across the March DST change', D.calDaysAgo(new Date(2026, 2, 7, 12).getTime(), new Date(2026, 2, 9, 12)), 2);
});

section('every demo scenario has a preset', function () {
  D.DEMO_LIST.forEach(function (d) { eq(d.key + ' preset', !!D.DEMO_PRESETS[d.key], true); });
  eq('no preset without a chip', Object.keys(D.DEMO_PRESETS).length, D.DEMO_LIST.length);
});


// ── Run notes, selection, events and formats ──
// L is the same small API over whichever file holds these functions. Each adapter takes the
// state as arguments (runs, profile, Strava Lever titles), so a test never depends on where the
// state lives.
var L = (function () {
  var src = fs.readFileSync(path.join(__dirname, 'run-dynamics.js'), 'utf8');
  function liftFn(name) {
    var at = src.indexOf('\nfunction ' + name + '(');
    if (at < 0) throw new Error(name + ' not found in run-dynamics.js');
    at++;
    var depth = 0;
    for (var i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
  }
  var names = ['norm', 'num', 'hmsToSec', 'parseDate', 'ymd', 'dayEnd', 'daysAgo', 'fmtPace', 'fmtDur', 'fmtDay', 'fmtSpan', 'fmtMD',
    'fmtClock', 'fmtRel', 'canonJSON', 'filterIntensity', 'leverMarkList', 'markOffload', 'orphanMark', 'annotateLever', 'stravaLever',
    'effType', 'exclList', 'runFlag', 'annotateExcluded', 'exclMatch', 'easyPaceSec', 'computeLoadParams', 'offloadFrac', 'leverPct',
    'weightKg', 'evLocalTs', 'events', 'evAddFn', 'evFuture', 'dismissedDrops', 'sameDis', 'workoutPaceSec', 'includedPref', 'syncActor'];
  var c = { RunLoad: win.RunLoad, Math: Math, Date: Date, Set: Set, Map: Map, Object: Object, Array: Array, String: String, JSON: JSON,
    parseFloat: parseFloat, isFinite: isFinite, isNaN: isNaN, DAY: 864e5,
    MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    FILTER_DEFAULTS: { intensity: 'all', cutoff: '6:40', mindist: '0.5' }, EV_NO_FUTURE: { injury: 1, illness: 1, nonrun: 1 },
    RAW: [], STD_PROFILE: {}, STRAVA_LEVER: [], UID: null, window: {} };
  vm.createContext(c);
  vm.runInContext(names.map(liftFn).join('\n'), c);
  var withProfile = function (fn) { return function (profile) { c.STD_PROFILE = profile || {}; return c[fn](); }; };
  return {
    norm: c.norm, num: c.num, hmsToSec: c.hmsToSec, parseDate: c.parseDate, ymd: c.ymd, dayEnd: c.dayEnd, daysAgo: c.daysAgo,
    fmtPace: c.fmtPace, fmtDur: c.fmtDur, fmtDay: c.fmtDay, fmtSpan: c.fmtSpan, fmtMD: c.fmtMD, fmtClock: c.fmtClock, fmtRel: c.fmtRel,
    canonJSON: c.canonJSON, filterIntensity: c.filterIntensity, markOffload: c.markOffload, orphanMark: c.orphanMark,
    effType: c.effType, runFlag: c.runFlag, exclMatch: c.exclMatch, evLocalTs: c.evLocalTs, evAddFn: c.evAddFn, evFuture: c.evFuture,
    sameDis: c.sameDis,
    annotateLever: function (runs, profile, lever) { c.RAW = runs; c.STD_PROFILE = profile || {}; c.STRAVA_LEVER = lever || []; c.annotateLever(); },
    annotateExcluded: function (runs, profile) { c.RAW = runs; c.STD_PROFILE = profile || {}; c.annotateExcluded(); },
    computeLoadParams: function (runs, profile, cutoff) {
      c.STD_PROFILE = profile || {}; c.loadRuns = function () { return runs; }; c.intensityState = function () { return { mode: 'all', cutoff: cutoff }; };
      return c.computeLoadParams();
    },
    events: withProfile('events'), dismissedDrops: withProfile('dismissedDrops'), includedPref: withProfile('includedPref'),
    workoutPaceSec: withProfile('workoutPaceSec'), easyPaceSec: withProfile('easyPaceSec'), leverPct: withProfile('leverPct'),
    offloadFrac: withProfile('offloadFrac'), weightKg: withProfile('weightKg'),
    syncActor: function (uid, esLabs) { c.UID = uid; c.window = esLabs ? { esLabs: esLabs } : {}; return c.syncActor(); }
  };
})();
function same(label, got, want) { eq(label, JSON.stringify(got), JSON.stringify(want)); }
var T0 = new Date(2026, 5, 10, 7, 0).getTime();   // made-up run start, local time
function mk(id, o) { return Object.assign({ id: id, ts: T0, date: new Date(T0), distMi: 5, paceSec: 540, type: 'Running' }, o || {}); }

section('Lever runs: a manual mark wins, then a title, then a Strava title; orphan marks re-attach by time', function () {
  var day = new Date(T0); var ymdT = day.getFullYear() + '-' + ('0' + (day.getMonth() + 1)).slice(-2) + '-' + ('0' + day.getDate()).slice(-2);
  var runs = [
    mk('a', { type: 'Treadmill Running', leverTitle: true }),
    mk('b', { ts: T0 + 864e5 * 2, leverTitle: true }),
    mk('c', { ts: new Date(ymdT + 'T12:00:00').getTime() - 3600e3 * 5, distMi: 6 }),
    mk('d', { ts: T0 + 864e5 * 5 }),
    mk('e', { ts: T0 + 864e5 * 6, offload: 0.2, leverTitle: true }),
    mk('f', { ts: T0 + 864e5 * 7 }),
    mk('g', { ts: T0 + 864e5 * 8 })
  ];
  var profile = { runLeverMarks: [
    { id: 'a', lever: true, offload: 0.3, ts: T0, mi: 5 },
    { id: 'e', lever: false, ts: T0 + 864e5 * 6, mi: 5 },
    { id: 'old_f', lever: true, offload: 0.2, ts: T0 + 864e5 * 7 + 10 * 60e3, mi: 5.1 },
    { id: 'old_g', lever: true, offload: 0.2, ts: T0 + 864e5 * 8 + 31 * 60e3, mi: 5 },
    { lever: true }
  ] };
  L.annotateLever(runs, profile, [{ date: ymdT, distMi: 6.1 }]);
  var got = runs.map(function (r) { return [r.id, r.leverSrc, r.lever, r.offload, r._mark ? r._mark.id : null]; });
  same('sources', got, [
    ['a', 'marked', true, 0.3, 'a'], ['b', 'title', true, null, null], ['c', 'strava', true, null, null], ['d', null, false, null, null],
    ['e', 'unmarked', false, null, 'e'], ['f', 'marked', true, 0.2, 'old_f'], ['g', null, false, null, null]]);
  eq('effType Lever', L.effType(runs[0]), 'Lever');
  eq('effType otherwise the type', L.effType(runs[3]), 'Running');
  // the doc's own offload is captured once, so a mark → unmark cycle puts it back
  var h = [mk('h', { offload: 0.15 })];
  L.annotateLever(h, {}, []); eq('doc offload kept', h[0].offload, 0.15);
  L.annotateLever(h, { runLeverMarks: [{ id: 'h', lever: false }] }, []); eq('not-Lever mark clears it', h[0].offload, null);
  L.annotateLever(h, {}, []); eq('mark removed: doc offload back', h[0].offload, 0.15);
});

section('Lever mark details: offload range, orphan matching by time and distance', function () {
  eq('offload 0.3', L.markOffload({ offload: 0.3 }), 0.3);
  eq('offload below 1%', L.markOffload({ offload: 0.005 }), null);
  eq('offload above 95%', L.markOffload({ offload: 0.96 }), null);
  eq('offload as text', L.markOffload({ offload: '0.5' }), 0.5);
  var orphans = [{ id: 'x', ts: T0 + 20 * 60e3 }, { id: 'y', ts: T0 + 5 * 60e3 }];
  eq('closest orphan wins', L.orphanMark(mk('r'), orphans).id, 'y');
  eq('each orphan is used once', orphans.length, 1);
  eq('within 30 minutes', L.orphanMark(mk('r'), [{ id: 'z', ts: T0 + 30 * 60e3 }]).id, 'z');
  eq('past 30 minutes', L.orphanMark(mk('r'), [{ id: 'z', ts: T0 + 30 * 60e3 + 1 }]), null);
  eq('distance off by more than 5% and 0.2 mi', L.orphanMark(mk('r', { distMi: 10 }), [{ id: 'z', ts: T0, mi: 10.6 }]), null);
  eq('distance within 5%', L.orphanMark(mk('r', { distMi: 10 }), [{ id: 'z', ts: T0, mi: 10.4 }]).id, 'z');
  eq('short run: 0.2 mi slack', L.orphanMark(mk('r', { distMi: 2 }), [{ id: 'z', ts: T0, mi: 2.19 }]).id, 'z');
  eq('short run: past 0.2 mi', L.orphanMark(mk('r', { distMi: 2 }), [{ id: 'z', ts: T0, mi: 2.25 }]), null);
});

section('Runs that cannot be right are flagged; exclusions match by id or start time', function () {
  eq('over 100 mi', L.runFlag(mk('r', { distMi: 100.1 })), 'over 100 mi');
  eq('100 mi is allowed', L.runFlag(mk('r', { distMi: 100 })), null);
  eq('faster than 3:30', L.runFlag(mk('r', { paceSec: 209 })), 'faster than 3:30 /mi');
  eq('3:30 is allowed', L.runFlag(mk('r', { paceSec: 210 })), null);
  eq('longer than 24 h', L.runFlag(mk('r', { durSec: 86401 })), 'longer than 24 h');
  var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 1, 0, 0);
  eq('dated ahead', L.runFlag(mk('r', { ts: tomorrow.getTime() })), 'dated ahead');
  var late = new Date(); late.setHours(23, 59, 0, 0);
  eq('later today is fine', L.runFlag(mk('r', { ts: late.getTime() })), null);
  var runs = [mk('a'), mk('b', { ts: T0 + 864e5 }), mk('c', { ts: T0 + 2 * 864e5 })];
  L.annotateExcluded(runs, { runExcluded: [{ id: 'a' }, { id: 'other', ts: T0 + 864e5 + 60e3 }, { id: 'far', ts: T0 + 2 * 864e5 + 61e3 }, { ts: T0 }] });
  same('excluded by id, by start within 60 s, not past it', runs.map(function (r) { return r._excl; }), [true, true, false]);
  eq('exclMatch by id', L.exclMatch({ id: 7 }, mk('7')), true);
  eq('exclMatch by start', L.exclMatch({ id: 'q', ts: T0 - 60e3 }, mk('r')), true);
});

section('Events: legacy UTC-midnight dates read as the local day; adds are idempotent; no future injuries', function () {
  var utcMid = Date.UTC(2026, 2, 3), local = new Date(2026, 2, 3).getTime(), noon = new Date(2026, 2, 3, 12).getTime();
  eq('UTC midnight → local midnight of that date', L.evLocalTs(utcMid), local);
  eq('other times unchanged', L.evLocalTs(noon), noon);
  var raw = [{ id: '1', type: 'injury', ts: utcMid, endTs: Date.UTC(2026, 2, 9), note: 'n' }];
  var ev = L.events({ runEvents: raw });
  same('display copy remapped', [ev[0].ts, ev[0].endTs], [local, new Date(2026, 2, 9).getTime()]);
  eq('stored entry untouched', raw[0].ts, utcMid);
  same('no events', L.events({}), []);
  var add = L.evAddFn({ id: 5, type: 'race', ts: noon });
  eq('adds once', add([]).length, 1);
  eq('same id (as text) not added twice', add([{ id: '5' }]).length, 1);
  var t = new Date(); t.setDate(t.getDate() + 1);
  eq('injury tomorrow refused', L.evFuture('injury', t), true);
  eq('illness tomorrow refused', L.evFuture('illness', t), true);
  eq('non-running injury tomorrow refused', L.evFuture('nonrun', t), true);
  eq('race tomorrow allowed', L.evFuture('race', t), false);
  eq('planned downtime tomorrow allowed', L.evFuture('timeoff', t), false);
  var tonight = new Date(); tonight.setHours(23, 0, 0, 0);
  eq('injury tonight allowed', L.evFuture('injury', tonight), false);
});

section('Dismissed gaps and saved filters read safely from the profile', function () {
  same('dismissed: only entries with both dates', L.dismissedDrops({ runDismissedDrops: [{ t0: 1, t1: 2, at: 3 }, { t0: 1 }, null, { t0: 'x', t1: 2 }] }), [{ t0: 1, t1: 2, at: 3 }]);
  eq('same dismissal needs t0, t1 and at', L.sameDis({ t0: 1, t1: 2, at: 3 }, { t0: 1, t1: 2, at: 3 }), true);
  eq('different stamp is another dismissal', L.sameDis({ t0: 1, t1: 2, at: 4 }, { t0: 1, t1: 2, at: 3 }), false);
  same('included: defaults', L.includedPref({}), { off: [], intensity: 'all', mindist: '0.5' });
  same('included: stored', L.includedPref({ runIncluded: { off: ['Treadmill Running', 3], intensity: 'easy', mindist: 1.5 } }), { off: ['Treadmill Running', '3'], intensity: 'easy', mindist: '1.5' });
  same('included: bad values fall back', L.includedPref({ runIncluded: { off: 'x', intensity: 'fast', mindist: 51 } }), { off: [], intensity: 'all', mindist: '0.5' });
  eq('workout pace 2:59 refused', L.workoutPaceSec({ runWorkoutPaceSec: 179 }), null);
  eq('workout pace 3:00', L.workoutPaceSec({ runWorkoutPaceSec: 180 }), 180);
  eq('workout pace 20:01 refused', L.workoutPaceSec({ runWorkoutPaceSec: 1201 }), null);
  eq('easy pace 3:59 refused', L.easyPaceSec({ runEasyPaceSec: 239 }), null);
  eq('easy pace 20:00', L.easyPaceSec({ runEasyPaceSec: 1200 }), 1200);
  eq('Lever support default 85', L.leverPct({}), 85);
  eq('Lever support 100 refused', L.leverPct({ runLeverPctBW: 100 }), 85);
  eq('Lever support 70', L.leverPct({ runLeverPctBW: 70 }), 70);
  eq('offload at 70% BW', +L.offloadFrac({ runLeverPctBW: 70 }).toFixed(4), 0.3);
  eq('weight 150 lb in kg', +L.weightKg({ weightLb: 150 }).toFixed(3), 68.039);
  eq('no weight', L.weightKg({}), null);
});

section('Load parameters: calibrated easy pace wins, then the profile, else neutral', function () {
  var easy = []; for (var i = 0; i < 12; i++) easy.push(mk('e' + i, { ts: T0 - i * 864e5, paceSec: 560 + i }));
  var p = L.computeLoadParams(easy, { runEasyPaceSec: 500, runLeverPctBW: 80 }, 400);
  same('calibrated', [p.basePaceSource, p.basePaceSec != null && p.basePaceSec !== 500, p.useGrade, +p.offload.toFixed(4)], ['calibrated', true, true, 0.2]);
  p = L.computeLoadParams([], { runEasyPaceSec: 500 }, 400);
  same('profile', [p.basePaceSource, p.basePaceSec, +p.offload.toFixed(4)], ['profile', 500, 0.15]);
  p = L.computeLoadParams([], {}, 400);
  same('neutral', [p.basePaceSource, p.basePaceSec], [null, null]);
  same('intensity filter', [L.filterIntensity([mk('w', { paceSec: 399 }), mk('e', { paceSec: 400 }), mk('n', { paceSec: null })], 'workout', 400).length,
    L.filterIntensity([mk('w', { paceSec: 399 }), mk('e', { paceSec: 400 }), mk('n', { paceSec: null })], 'easy', 400).length,
    L.filterIntensity([1, 2, 3], 'all', 400).length], [1, 1, 3]);
});

section('Dates and numbers: local days, human spans, freshness wording', function () {
  eq('bare date is local midnight', L.parseDate('2026-03-08').getTime(), new Date(2026, 2, 8).getTime());
  eq('date with time', L.parseDate('2026-03-08 07:30').getTime(), new Date(2026, 2, 8, 7, 30).getTime());
  eq('empty', L.parseDate(''), null);
  eq('garbage', L.parseDate('soon'), null);
  eq('ymd local', L.ymd(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
  eq('dayEnd', L.dayEnd(new Date(2026, 0, 5, 8)).getTime(), new Date(2026, 0, 5, 23, 59, 59, 999).getTime());
  eq('fmtDay', L.fmtDay(new Date(2025, 7, 10, 9).getTime()), 'Aug 10, 2025');
  eq('span: one day', L.fmtSpan(new Date(2025, 7, 10, 9).getTime(), new Date(2025, 7, 10, 18).getTime()), 'Aug 10, 2025');
  eq('span: same month', L.fmtSpan(new Date(2025, 7, 10).getTime(), new Date(2025, 7, 28).getTime()), 'Aug 10 – 28, 2025');
  eq('span: two months', L.fmtSpan(new Date(2026, 2, 3).getTime(), new Date(2026, 3, 20).getTime()), 'Mar 3 – Apr 20, 2026');
  eq('span: two years', L.fmtSpan(new Date(2025, 11, 25).getTime(), new Date(2026, 0, 3).getTime()), 'Dec 25, 2025 – Jan 3, 2026');
  eq('span: open end', L.fmtSpan(new Date(2025, 7, 10).getTime(), null), 'Aug 10, 2025');
  eq('clock past midnight', L.fmtClock(new Date(2026, 0, 1, 0, 5).getTime()), '12:05 AM');
  eq('clock afternoon', L.fmtClock(new Date(2026, 0, 1, 13, 7).getTime()), '1:07 PM');
  var now = new Date(), at = function (d, h) { var x = new Date(now); x.setDate(x.getDate() + d); x.setHours(h, 15, 0, 0); return x.getTime(); };
  eq('today', L.fmtRel(at(0, 6)), 'today 6:15 AM');
  eq('yesterday', L.fmtRel(at(-1, 6)), 'yesterday');
  eq('days ago', L.fmtRel(at(-5, 6)), '5 days ago (' + L.fmtMD(at(-5, 6)) + ')');
  eq('dated ahead', L.fmtRel(at(1, 6)), 'in 1 day (' + L.fmtMD(at(1, 6)) + ') — check the watch clock');
  eq('daysAgo', L.daysAgo(at(-3, 23)), 3);
  eq('fmtMD this year has no year', L.fmtMD(new Date(now.getFullYear(), 0, 9).getTime()), 'Jan 9');
  eq('fmtMD other year', L.fmtMD(new Date(2019, 0, 9).getTime()), 'Jan 9, 2019');
  eq('pace text', L.hmsToSec('6:40'), 400);
  eq('h:mm:ss', L.hmsToSec('1:02:03'), 3723);
  eq('no pace', L.hmsToSec('--'), null);
  eq('number with commas', L.num('1,234.5'), 1234.5);
  eq('dash is no number', L.num('--'), null);
  eq('norm', L.norm('Treadmill Running'), 'treadmillrunning');
  eq('fmtPace', L.fmtPace(479.6), '8:00');
  eq('fmtDur', L.fmtDur(3599), '1h 0m');
  eq('canonJSON ignores key order and undefined', L.canonJSON([{ b: 1, a: [2, { d: 1, c: undefined }] }]), L.canonJSON([{ a: [2, { d: 1 }], b: 1 }]));
});

section('Strava sync: the athlete, or the real admin acting as them; never a coach', function () {
  same('no act-as layer: the athlete', L.syncActor('ath', null), { real: 'ath', admin: false, canSync: true });
  same('the athlete signed in', L.syncActor('ath', { realUser: { uid: 'ath' }, ADMIN_UID: 'adm' }), { real: 'ath', admin: false, canSync: true });
  same('admin acting as the athlete', L.syncActor('ath', { realUser: { uid: 'adm' }, ADMIN_UID: 'adm' }), { real: 'adm', admin: true, canSync: true });
  same('a coach', L.syncActor('ath', { realUser: { uid: 'coach' }, ADMIN_UID: 'adm' }), { real: 'coach', admin: false, canSync: false });
  same('signed out', L.syncActor('ath', { realUser: null, ADMIN_UID: 'adm' }), { real: null, admin: false, canSync: false });
});

console.log('\n' + checks + ' checks, ' + failures + ' failed');
if (failures) process.exit(1);
