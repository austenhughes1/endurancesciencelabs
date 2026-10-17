// ════════════════════════════════════════════════════════════════
// shared/run-load-model.js
//
// Transparent mechanical-load model for the Run Dynamics tool.
// Per-run Impact Load, in Impact Adjusted Distance (IAD miles) + acute/chronic load
// tracking and ACWR, per the ESL Mechanical Load Management spec.
//
// Pure functions only — no DOM, no Firebase. Exposed as window.RunLoad
// so both the coaching dashboard tab and the standalone page can share
// one implementation (the rendering differs per page; the math does not).
//
// Every parameter is exposed and tunable — transparency is the product
// differentiator vs a black-box model. Modeled outputs are an
// individual-relative trend/estimate, NOT a measured force.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// Tunable defaults. basePaceSec / baseVO are normally overridden per
// athlete by calibrateBaseline() so a baseline easy mile scores ~1.0.
var DEFAULTS = {
  // Pace (intensity) exponent. 0.5 prices TISSUE load, not training stress. The old 1.5 was
  // tuned so the number "reflects force & metabolic cost rising faster than speed" — a stress
  // score that made a 5K race cost 1.79× an easy 5K per mile. Measured peak vertical GRF rises
  // only ~1.17× from easy pace to 5K pace (Nilsson & Thorstensson 1989, ~2.4 → ~2.8 BW between
  // 3.7 and 5.5 m/s), which fits an exponent of 0.40; loading rate, the better bone-stress
  // predictor, climbs ~1.0. 0.5 sits between: a 5K race costs ~1.21× an easy mile, a mile race
  // ~1.27×. The bone-fatigue counterpoint (damage/cycle ∝ strain^5–10, which would land near
  // 2×/mile) was considered and rejected as a tuning basis because living-bone strain-to-force
  // is not pinned down well enough to tune from. Mirrors the Lever IQ model (commit 28f0dd6).
  kPace:      0.5,
  kImpact:    1.0,   // per-step impact exponent — peak vGRF ∝ 1/duty factor (Morin 2005; Patoz 2023)
  // Grade surcharge ON by default. It used to ship false with the only call site
  // (run-dynamics.js computeLoadParams) flipping it true; the Lever IQ port copied the
  // defaults, lost the override, and the whole grade term was dead in production for
  // months. Runs with no elevation degrade to a neutral 1.0 on their own and indoor runs
  // are excluded by impactLoad regardless, so the only reason to turn it off is to
  // isolate the other terms in a test.
  useGrade:   true,
  acuteN:     7,     // acute EWMA window (days)
  chronicN:   28,    // chronic EWMA window (days)
  // Per-athlete reference weight, in the SAME UNIT as run.weight. null (the default) means
  // unconfigured: the weight term stays neutral (1.0) and any stored run weight is IGNORED.
  // The old default of 1.0 meant any run doc that ever carried a `weight` field scored
  // weight× (a 70 kg runner at 70×, which poisoned Lever IQ's ACWR curve once). No ESL
  // importer (parseExport, runFromFitSession, stravaRunDoc) writes a run weight today.
  refWeight:  null,
  // The athlete's baseline easy pace (s/mi) that the pace term scores each run against.
  // null (the default) means unconfigured: the pace factor stays neutral (1.0) and a run
  // scores its distance, exactly as an unset refWeight neutralises the weight term. There is
  // deliberately NO default number: the 420 (7:00/mi) constant this replaced was level-blind,
  // so it silently surcharged every runner faster than it and went inert for everyone
  // slower — raised to an exponent, a guessed baseline is a wrong one, not a conservative
  // one. calibrateBaseline() fills it from the athlete's own easy runs; a caller may seed it
  // (e.g. from a runner-entered easy pace on the profile) before calibration overwrites it.
  basePaceSec: null,
  baseDF:     42408, // easy-run baseline duty-factor proxy = cadence(spm) × GCT(ms) — fallback (~186×228)
  // Grade surcharge: convex (quadratic) in MEAN grade, descent weighted ~3× ascent, capped.
  // Load rises super-linearly with downhill steepness (Gottschall & Kram 2005; descent drives
  // impact + eccentric damage; uphill is lower-impact but adds muscular/propulsive cost that the
  // pace term under-counts). Tuned so a 10 mi run with 100→300 ft is ~flat, 500 ft a nudge,
  // 1000 ft a clear bump. CAVEAT: mean grade from totals is a lower-bound — it cannot see whether
  // elevation came from one steep descent vs rolling terrain; per-segment grade (FIT) is the fix.
  kDescent:   330,
  kAscent:    110,
  gradeCap:   2.5,
  // Baseline-calibration grade adjustment (GAP). Used ONLY inside calibrateBaseline —
  // hilly runs at honest slow paces were diluting the easy-pace median, inflating flat
  // runs' scores. ~3.5% pace cost per 1% mean ascent grade, downhill gives back about
  // half (Daniels/Minetti first-order). The per-run IL pace term stays RAW pace — the
  // convex grade surcharge already prices the hill; adjusting both would double-count.
  gapUp:      3.5,
  gapDown:    1.8,
  // Duty factor can't be grade-adjusted, so the baseDF median instead uses only runs
  // flatter than this mean total grade ((ascent+descent)/distance). Slow long-contact
  // trail steps otherwise inflate baseDF and surcharge normal flat running (+14% for
  // a real 77%-trail athlete). Falls back to all runs when < 5 flat samples exist.
  dfFlatGrade: 0.02,
  offload:    0,     // Lever body-weight-support offload fraction (0–1) applied to Lever runs
  // How much impact each unit of Lever offload removes: a run at offload O is discounted by
  // (1 − kOffload·O), not by (1 − O). 0.85 means a mile at 80% body weight counts 0.83 IAD miles.
  // Taking weight off the runner does not take force off one-for-one. On the Lever, peak vertical
  // GRF falls ~0.7× the offload (University of Memphis, Paquette 2021, N=16, 7–9 min/mi: −9.1% at
  // 90% BW, −13.7% at 80%; CU Boulder pilot, Penasso & Grabowski: −6.9% per 10% removed), while
  // loading rate (−12.7% / −19.0%) and vertical impulse fall ~1.0× (impulse is a physics identity:
  // averaged over a stride, vertical force equals the weight left on the runner). 0.85 is the
  // midpoint of the peak-force and loading-rate slopes, so speed (kPace 0.5) and support are
  // priced on one definition of load. There is deliberately NO road-equivalent pace conversion
  // for Lever runs any more (the old offloadPaceK = 0.76): that is an effort idea that belongs
  // to a training-stress score, and tissue sees the belt — Memphis shows a 7:00 mile at 80% BW
  // still hits 2.10 BW peak force vs 2.01 at 9:00, with loading rate up 23%, so converting the
  // pace discounted a fast Lever run twice. Known limits of one linear slope: the measured slope
  // is not constant (Memphis 0.91 over the first 10% of support, 0.46 over the next), the belt
  // scale showed ~3.4% more support than the dial, individual runners ranged −3% to −26% at 80%
  // BW, and there is no Lever data above ~27% offload. Mirrors Lever IQ PR #130 (67162d7).
  kOffload:   0.85
};

// Indoor run: a belt never descends, and its ascent is an incline setting, not a hill.
// ESL writes 'Treadmill Running' for Strava trainer/VirtualRun activities and Garmin CSV
// carries the same label; Coros FIT and other sources may say 'Virtual Run' / 'Indoor'.
function isIndoor(r) { return /treadmill|virtual|indoor/i.test((r && r.type) || ''); }

// Ascent and descent in metres for the grade terms, resolved at READ time, with an ABSENT
// descent mirrored from the ascent on outdoor runs.
//
// Strava's activity summary reports total elevation GAIN and no loss, so a hilly Strava run
// would otherwise be priced as though the athlete climbed and never came back down. That is
// the expensive half to lose: descent is weighted 3× ascent (kDescent) because eccentric
// downhill loading is what actually damages tissue. An outdoor run ends near where it
// started often enough that "you came down what you went up" is the honest prior, and it is
// what real Garmin records show (descent within ~10% of ascent). A RECORDED descent always
// wins, including a recorded 0 — that is a point-to-point climb, not missing data.
//
// A Strava doc's descentM is treated as ABSENT: Strava never sends descent, so whatever the
// doc holds was written as a sync-time mirror (older syncs) or null (current syncs), never
// measured. Reading it as absent means existing outdoor Strava docs resolve to the same
// number they held, treadmill Strava docs stop being surcharged, and no migration is needed.
// A later Garmin/FIT import that replaces the doc (source !== 'strava') still wins.
//
// Nothing is mirrored for an indoor run: a belt never descends. Its ascent is still returned
// honestly, because an incline does legitimately slow the pace that calibPace adjusts.
// Mirrors Lever IQ ImpactLoadModel.elevation (PR #93 e32e478, PR #96 f545a4c).
function elevation(run) {
  var ascent = run.ascentM > 0 ? run.ascentM : 0;
  var recorded = run.source === 'strava' ? null : run.descentM;
  if (recorded != null) return { ascent: ascent, descent: recorded > 0 ? recorded : 0 };
  return { ascent: ascent, descent: isIndoor(run) ? 0 : ascent };
}

function median(arr) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Grade-adjusted (flat-equivalent) pace, for baseline calibration ONLY. A device-
// reported Avg GAP (gapSec, Garmin exports it on some devices) wins; otherwise adjust
// the raw pace by mean ascent/descent grade from the run's totals. Flat runs adjust by
// ~0, so no threshold cliff — every run is comparable on the same footing. Floor the
// divisor so a huge net descent can't flip the adjustment into nonsense.
function calibPace(r, p) {
  if (r.paceSec == null || r.paceSec <= 0) return null;
  if (r.gapSec > 0) return r.gapSec;
  if (!(r.distMi > 0)) return r.paceSec;
  var dM = r.distMi * 1609.34, el = elevation(r);
  var ag = el.ascent / dM;
  var dg = el.descent / dM;
  return r.paceSec / Math.max(1 + p.gapUp * ag - p.gapDown * dg, 0.7);
}
function meanTotalGrade(r) {
  if (!(r.distMi > 0)) return 0;
  var el = elevation(r);
  return (el.ascent + el.descent) / (r.distMi * 1609.34);
}

// Per-athlete, per-device baseline from their easy-run history (grade-adjusted pace at
// or slower than the easy/workout cutoff). Falls back to all runs when there aren't
// enough easy runs; when no pace median can be computed at all, basePaceSec falls back
// to whatever params.basePaceSec the caller seeded (a recorded easy pace) and otherwise
// to null — a neutral pace term, never a guessed constant. baseDF keeps its fallback. Normalising every factor to this baseline makes
// the model self-calibrating and cancels most of the cross-device absolute offset in
// VO/GCT. Trail-heavy athletes: easy pace is calibrated on grade-ADJUSTED pace (so
// slow honest climbing doesn't drag the baseline slower), and easy form (baseDF) on
// FLAT easy runs only (so long-contact trail steps don't inflate it) — otherwise both
// baselines drift and flat easy runs score artificially high.
function calibrateBaseline(runs, cutoffSec, params) {
  var p = Object.assign({}, DEFAULTS, params || {});
  var easy = runs.filter(function (r) { var eq = calibPace(r, p); return eq != null && eq >= cutoffSec; });
  var pool = easy.length >= 5 ? easy : runs;
  var basePace = median(pool.map(function (r) { return calibPace(r, p); }).filter(function (v) { return v != null; }));
  var dfOf = function (r) { return (r.cadence > 0 && r.gct > 0) ? r.cadence * r.gct : null; };
  var flat = pool.filter(function (r) { return dfOf(r) != null && meanTotalGrade(r) <= p.dfFlatGrade; });
  var dfPool = flat.length >= 5 ? flat : pool;
  var baseDF = median(dfPool.map(dfOf).filter(function (v) { return v != null; }));
  return {
    basePaceSec: basePace > 0 ? basePace : (p.basePaceSec > 0 ? p.basePaceSec : null),
    baseDF:      baseDF   || DEFAULTS.baseDF
  };
}

// Per-run Impact Load in Impact Adjusted Distance (IAD miles). Null when distance/pace
// are missing (can't model). VO and grade degrade gracefully to 1.0.
function impactLoad(run, p) {
  p = p || DEFAULTS;
  // Guard the inputs BEFORE any division. A zeroed/negative pace (bad Coros/Garmin
  // imports that write 0 rather than a blank) would divide through to Infinity/NaN,
  // and a single non-finite daily load poisons the entire acute/chronic EWMA + ACWR
  // curve downstream. A negative distance is likewise garbage. Distance 0 stays
  // modelable — it's a valid explicit rest day (IL 0). Mirrors the lever-iq port.
  if (run.distMi == null || run.paceSec == null || run.distMi < 0 || run.paceSec <= 0) return null;
  // Lever body-weight support: a fraction of bodyweight is offloaded on the device. Per-run
  // run.offload wins; otherwise a run flagged run.lever uses the profile-level p.offload; 0 for
  // normal runs. offloadFactor() clamps it (negatives → 0, cap 0.95 so load can't go to zero).
  var off   = run.offload != null ? run.offload : (run.lever ? (p.offload || 0) : 0);
  // Pace term scores the pace the run ACTUALLY held, Lever or not. There is no road-equivalent
  // conversion for a supported run: forces follow the belt speed, so a fast Lever run is priced
  // as fast (see DEFAULTS.kOffload). Neutral (1.0) until this athlete HAS a baseline easy pace:
  // the factor is a ratio against the athlete's own normal, so with no normal to compare to
  // there is nothing to compare — the run scores its distance and waits for real data.
  var paceF = (p.basePaceSec > 0) ? Math.pow(p.basePaceSec / run.paceSec, p.kPace) : 1;
  // Per-step impact from duty factor (cadence × GCT), normalized to the athlete's easy-run
  // baseline. Peak vGRF ∝ 1/duty factor (Morin 2005; Patoz 2023), so a lower duty factor —
  // shorter contact / more flight — loads each step harder ⇒ factor > 1. This is a load term,
  // NOT an injury predictor. Needs cadence + GCT; defaults to 1 on devices that don't report them.
  // Require both > 0: a 0 GCT/cadence (e.g. Coros runs logged without a dynamics
  // pod, which write 0 rather than a blank) would divide to Infinity and poison
  // the whole load curve. Missing dynamics → neutral factor of 1, same as a
  // device that never reports them.
  var dfF   = (run.cadence > 0 && run.gct > 0)
    ? Math.pow(p.baseDF / (run.cadence * run.gct), p.kImpact) : 1;
  // Weight term: neutral unless a per-athlete refWeight is configured (same unit as
  // run.weight) AND the run carries a positive weight. Within one athlete the ratio is meant
  // to cancel to ~1 — dividing a stored raw weight by the old default refWeight of 1.0 scored
  // a 70 kg runner 70×. Unconfigured must mean "ignore run.weight". Matches the lever-iq port.
  var wF    = (p.refWeight > 0 && run.weight > 0) ? run.weight / p.refWeight : 1;
  var mods = paceF * dfF * wF;
  // Indoor runs are excluded outright: an inclined treadmill reports ascent, and with the
  // descent mirrored (or, on older Strava syncs, written) to match, a belt that never produced
  // a single eccentric downhill step was surcharged for the full hill — 11.58 vs the correct
  // 10.00 on a 10 mi / 1000 ft session. ESL has no source that records a signed treadmill
  // grade, so there is no "both directions measured" exception here (Lever IQ has one for its
  // in-app tracker only). The ascent still feeds calibPace, where an incline slows the pace.
  if (p.useGrade && run.distMi && !isIndoor(run)) {
    var distM = run.distMi * 1609.34, el = elevation(run);
    var dg = el.descent / distM;   // mean descent grade (fraction)
    var ag = el.ascent  / distM;   // mean ascent grade (fraction)
    mods *= Math.min(1 + p.kDescent * dg * dg + p.kAscent * ag * ag, p.gradeCap);
  }
  // FLOOR: at full bodyweight, a mile is never less than a mile of impact. Slower-than-
  // baseline pace, soft form, or a light-day weight ratio lower PEAK force per step,
  // but you take more steps per mile — the distance itself is the irreducible impact,
  // so the pace × form × weight × grade modifier product can't discount below 1. ONLY
  // the Lever offload sits outside the floor: body-weight support genuinely removes
  // ground reaction force, so a Lever run's floor is distance × (1 − kOffload·O), not distance.
  var il = run.distMi * offloadFactor(off, p) * Math.max(mods, 1);
  // Final belt-and-braces: never let a non-finite value escape into the load series.
  return Number.isFinite(il) ? il : null;
}

// The highest offload the model credits. Anything above clamps here.
var MAX_OFFLOAD = 0.95;

// The share of a mile's impact left after Lever support removes `offload` (a 0–1 fraction of
// body weight): 1 − kOffload·offload. 1.0 with no support; 0.83 at 20% offload with the
// default slope. This is the ONE place the offload discount is defined: impactLoad scores
// with it, and everything that turns IAD miles back into Lever miles (the hero's lever-mile
// option) must use it too, or a prescription and the score it earns stop agreeing.
// Negatives coerce to 0 and values above MAX_OFFLOAD clamp to it.
function offloadFactor(offload, p) {
  p = p || DEFAULTS;
  var off = offload > 0 ? Math.min(offload, MAX_OFFLOAD) : 0;
  return 1 - p.kOffload * off;
}

// IAD miles earned by one flat, easy-pace mile carried at `loadPercent` of body weight
// (100 = full body weight, no support): offloadFactor in the load-percent terms the hero and
// the Lever profile setting speak. Dividing an IAD-mile budget by this gives the Lever miles
// that deliver it; running that distance faster than easy pace scores more.
function impactPerMileAtLoad(loadPercent, p) {
  return offloadFactor(1 - loadPercent / 100, p);
}

// Collapse runs into a dense per-day Impact Load series (0 on rest days).
// Iterates by CALENDAR day (setDate), not a fixed 86,400,000 ms step — otherwise
// daylight-saving transitions drift the cursor off local-midnight day keys and
// inject spurious zero-load days for ~half of every year.
function dailyLoads(runs, p) {
  var byDay = {}, stamps = [];
  runs.forEach(function (r) {
    var il = impactLoad(r, p); if (il == null) return;
    var d = new Date(r.ts); d.setHours(0, 0, 0, 0);
    var k = d.getTime();
    byDay[k] = (byDay[k] || 0) + il;
    stamps.push(k);
  });
  if (!stamps.length) return [];
  var cur = new Date(Math.min.apply(null, stamps)); cur.setHours(0, 0, 0, 0);
  var end = Math.max.apply(null, stamps), out = [];
  while (cur.getTime() <= end) {
    out.push({ ts: cur.getTime(), load: byDay[cur.getTime()] || 0 });
    cur.setDate(cur.getDate() + 1);   // advance one calendar day (DST-safe)
    cur.setHours(0, 0, 0, 0);         // re-normalize to local midnight across DST flips
  }
  return out;
}

// ── Estimated ground-reaction force (Morin "sine" method) ──────────
// Peak vertical GRF from contact time + flight time. In body-weights it
// needs only cadence + GCT (mass cancels); Newtons needs body mass.
//   Fmax = (π/2) · mg · (step_time / contact_time)
// Validated field method (Morin et al. 2005); best for steady level
// running. Returns null when the inputs aren't present.
var GRAVITY = 9.80665;
function flightContact(run) {
  if (run.cadence == null || run.gct == null || run.cadence <= 0) return null;
  var step = 60 / run.cadence;     // seconds between consecutive footfalls
  var tc = run.gct / 1000;         // contact time (s)
  if (tc <= 0 || tc >= step) return null;
  return { step: step, tc: tc, tf: step - tc };
}
function vgrfBW(run) {              // peak vertical GRF in body-weights (no mass needed)
  var fc = flightContact(run);
  return fc ? (Math.PI / 2) * (fc.step / fc.tc) : null;
}
function vgrfN(run, weightKg) {     // peak vertical GRF in Newtons (needs body mass)
  if (!weightKg) return null;
  var bw = vgrfBW(run);
  return bw == null ? null : bw * weightKg * GRAVITY;
}

function ewma(series, N) {
  var lam = 2 / (N + 1), prev = series.length ? series[0].load : 0;
  return series.map(function (d) { prev = d.load * lam + prev * (1 - lam); return prev; });
}

// Full daily timeline: daily load, acute/chronic EWMAs, ACWR, and a flag.
function loadTimeline(runs, params) {
  var p = Object.assign({}, DEFAULTS, params || {});
  var series = dailyLoads(runs, p);
  var acute = ewma(series, p.acuteN), chronic = ewma(series, p.chronicN);
  return series.map(function (d, i) {
    var a = acute[i], c = chronic[i], r = c > 0 ? a / c : null;
    return {
      ts: d.ts, daily: d.load, acute: a, chronic: c, acwr: r,
      flag: c > 0 ? (r > 1.5 ? 'spike' : r < 0.8 ? 'low' : 'ok') : null
    };
  });
}

// Extend a timeline with zero-load days through `through` (a Date; calendar days, local
// midnight), decaying the acute/chronic EWMAs by (1 − λ) per padded day — identical to
// rebuilding the timeline from a zero-padded daily series. Days an athlete didn't run still
// move their load state, so anything anchored on "today" must not read a stale last-run day
// as current. No-op when the timeline is empty or already reaches `through`.
// Mirrors Lever IQ ImpactLoadModel.extendTimeline.
function extendTimeline(tl, through, params) {
  if (!tl || !tl.length) return tl;
  var p = Object.assign({}, DEFAULTS, params || {});
  var target = new Date(through); target.setHours(0, 0, 0, 0);
  var lamA = 2 / (p.acuteN + 1), lamC = 2 / (p.chronicN + 1);
  var out = tl.slice(), prev = out[out.length - 1];
  var cur = new Date(prev.ts); cur.setHours(0, 0, 0, 0);
  while (cur.getTime() < target.getTime()) {
    cur.setDate(cur.getDate() + 1); cur.setHours(0, 0, 0, 0);   // DST-safe, as dailyLoads
    var a = prev.acute * (1 - lamA), c = prev.chronic * (1 - lamC), r = c > 0 ? a / c : null;
    prev = { ts: cur.getTime(), daily: 0, acute: a, chronic: c, acwr: r,
             flag: c > 0 ? (r > 1.5 ? 'spike' : r < 0.8 ? 'low' : 'ok') : null };
    out.push(prev);
  }
  return out;
}

// ── Hero windows: 1-, 3-, 7-day load vs the 28-day base ─────────────
// Mean daily load over the last n timeline days (rest days count as 0).
function avgLast(tl, n) {
  if (!tl.length) return 0;
  var s = tl.slice(-n), sum = 0;
  for (var i = 0; i < s.length; i++) sum += s[i].daily;
  return sum / s.length;
}

// The largest n-day window sum among windows that END BEFORE today (the last timeline
// day), within the trailing 28 days, and how many of those windows carried any load.
// The loop stops one day short of today because today's own window is the one being
// judged — nothing may be its own yardstick. Earlier windows may still OVERLAP today's
// span (the 3-day window ending yesterday shares two days with it), and that is intended:
// the question is "what is the biggest block you finished before today?", not "what
// disjoint blocks have you done?". Mirrors Lever IQ GuidanceEngine._peakWindow.
function peakWindow(tl, n) {
  var firstStart = Math.max(0, tl.length - 1 - 28), peak = 0, nonZero = 0;
  for (var end = tl.length - 2; end - n + 1 >= firstStart; end--) {
    var sum = 0;
    for (var i = end - n + 1; i <= end; i++) sum += tl[i].daily;
    if (sum > 0) nonZero++;
    if (sum > peak) peak = sum;
  }
  return { peak: peak, nonZero: nonZero };
}

// A short-window ratio: the last n days' load against the biggest comparable block the
// runner has actually done in the prior 28 days. 1.0 means "matching your biggest"; the
// hero's thresholds then read as 15 / 30 / 50% beyond it.
//
// Why not n × (28-day mean day): that denominator counts rest days as zero, so dividing a
// run-day quantity by it measures run FREQUENCY, not load — a runner going 4 of 7 days read
// r1 ≈ 1.75 on every ordinary run (3/wk 2.33, 2/wk 3.50) and her genuine 3× spike read the
// same 1.75. Not a median either: a 3/3/3/8 runner has a median run of 3, so her weekly long
// run would read 2.67× and say "recover" every Sunday — the same bug in disguise. Max
// self-normalises to her own schedule; sustained ramps are r7's and climbingHot's job.
//
// Fewer than three comparable prior windows is not a pattern yet, so the ratio falls back
// to the old calendar base (n × base) — cold start is unchanged.
// Mirrors Lever IQ GuidanceEngine._shortRatio (PR #112, b4aefa6).
function shortRatio(tl, n, base) {
  var span = Math.min(n, tl.length), sum = 0;
  for (var i = tl.length - span; i < tl.length; i++) sum += tl[i].daily;
  var prior = peakWindow(tl, n);
  var denom = (prior.nonZero >= 3 && prior.peak > 0) ? prior.peak : span * base;
  return denom > 0 ? sum / denom : 0;
}

// The hero's windows in one place so the page and the tests read the same numbers:
// d1/d3/d7/d28 are mean daily loads over the trailing 1/3/7/28 days; base is d28 (null
// while it is 0); r1 and r3 are PEAK-relative (shortRatio), r7 is d7 ÷ base (a 7-day window
// always holds a full week of anyone's schedule, so it is already schedule-neutral).
// NOTE maxR = max(r1, r3, r7) no longer shares a denominator across the three: 1.0 means
// "level with your biggest recent block" when r1/r3 leads and "level with your average
// day" when r7 leads.
function loadWindows(tl) {
  var d1 = avgLast(tl, 1), d3 = avgLast(tl, 3), d7 = avgLast(tl, 7), d28 = avgLast(tl, 28);
  var base = d28 > 0 ? d28 : null;
  return {
    d1: d1, d3: d3, d7: d7, d28: d28, base: base,
    r1: base ? shortRatio(tl, 1, base) : null,
    r3: base ? shortRatio(tl, 3, base) : null,
    r7: base ? d7 / base : null
  };
}

// Inner HTML for the "How Impact Load is calculated" methodology panel (equation, plain-language
// equation, per-variable explanation + caveats, and cited literature). Inline-styled with the
// pages' CSS vars so it renders on both the dashboard tab and the standalone page. Drop inside a
// <details> on each page.
function methodologyHTML() {
  // Presentation lives in classes (rdx-meth-*) styled by the Run Dynamics module, not inline styles.
  var A=function(href,txt){ return '<a href="'+href+'" target="_blank" rel="noopener">'+txt+'</a>'; };
  return `<span class="rdx-meth-h">a · The equation</span>`
+ `<pre class="rdx-meth-eq">Impact Load (per run) — measured in Impact Adjusted Distance (IAD miles):

  IL = D · (1−0.85·O) · max( (W ⁄ W₀) · (P₀ ⁄ P)^0.5 · (DF₀ ⁄ DF)^1.0 · G , 1 )

       The max(…, 1) floor: at full bodyweight a mile is never less
              than a mile of impact — easy pace, soft form, and the
              weight ratio can't discount the distance itself. ONLY
              the Lever offload (1−0.85·O), outside the floor, can
              take IL below actual distance.
       DF = cadence × GCT
       O  = Lever body-weight offload (0 when not on the Lever)
       P  = the pace the run actually held — on the Lever, the
              belt pace. Support is priced ONLY through (1−0.85·O):
              each unit of body weight removed takes ~0.85 of its
              share of impact off (peak force falls ~0.7×, loading
              rate ~1.0×).
       G  = min( 1 + 330·(desc ⁄ L)² + 110·(asc ⁄ L)² , 2.5 )

Load over time:

  EWMAₜ = Lₜ·λ + EWMAₜ₋₁·(1−λ),   λ = 2 ⁄ (N+1)
  Acute = EWMA(N = 7 d)    Chronic = EWMA(N = 28 d)
  ACWR  = Acute ⁄ Chronic</pre>`
+ `<span class="rdx-meth-h">b · In plain language</span>`
+ `<ul class="rdx-meth-list"><li>Impact Adjusted Distance (IAD miles) = distance</li><li>× (how much faster than your easy pace)^0.5</li><li>× (how much springier than your easy form)</li><li>× (body-weight scale)</li><li>× (hill surcharge)</li><li>× (1 − 0.85 × Lever offload)</li></ul>`
+ `<p class="rdx-meth-p">On the Lever, body-weight support takes force off each step — but not one-for-one: removing 15% of your weight removes about 13% of the impact (0.85 × 15%). The pace is scored as the belt ran it; a fast Lever mile is still a fast mile to your tissue.</p>`
+ `<p class="rdx-meth-p">One easy flat mile = 1 IAD mile; a hard or hilly mile counts as more. A full-bodyweight mile never counts as LESS than one IAD mile — running slower softens each step but adds steps per mile, so the distance itself is the floor. Only Lever body-weight support (which removes ground reaction force) can score below distance: a Lever mile at offload O scores (1 − 0.85·O) IAD miles at easy pace.</p>`
+ `<pre class="rdx-meth-eq">Acute   = 7-day rolling average of daily IAD miles
Chronic = 28-day rolling average
Acute : Chronic = recent load vs the base you have built</pre>`
+ `<span class="rdx-meth-h">c · Each variable — meaning, measurement, caveats</span>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">D</span> — run distance (mi), from GPS or foot-pod / treadmill. Track distances arrive in meters and are converted.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">P, P₀</span> — average pace and your easy-run baseline pace (s/mi), from GPS. Baseline = median <b>grade-adjusted</b> pace of your easy runs (at or slower than the workout-pace cutoff on adjusted pace): each run's pace is first converted to its flat-equivalent (~3.5% per 1% mean ascent grade, downhill credits about half; a device-reported Avg GAP is used directly when present) so honest slow climbing on trail runs doesn't drag the easy baseline slower and inflate flat runs' scores. Only the baseline uses adjusted pace — each run is still scored on its raw pace, since the hill surcharge G already prices the grade. Until a baseline exists (no easy runs to take a median from and no easy pace entered in the profile) the pace term is neutral and a run scores its distance — there is no guessed default pace, because a level-blind constant surcharges every faster runner and goes inert for every slower one. The 0.5 power prices <b>tissue load</b>, not training stress: measured peak vertical ground-reaction force rises only ~1.17× from easy pace to 5K pace (an exponent of ~0.4), while loading rate — the better bone-stress predictor — climbs about linearly (~1.0); 0.5 sits between, so a 5K-pace mile costs ~1.21 IAD miles and a mile-race mile ~1.27. On a <b>Lever run</b> P is the <b>belt pace</b>, with no road-equivalent conversion: support lets you hold a faster pace at the same effort, but tissue does not see effort, it sees the belt — at 80% body weight a 7:00 mile still produces more peak force and ~23% more loading rate than a 9:00 mile (Paquette 2021), so crediting the speedup back would discount a fast Lever run twice. Caveat: pace under-rates uphill effort (hard but slow) — the hill term offsets this.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">DF, DF₀</span> — duty factor = cadence × ground-contact time, vs your easy baseline (median of <b>flat</b> easy runs only, ≤2% mean total grade when enough exist — slow long-contact trail steps would otherwise inflate the form baseline and surcharge normal flat running). Cadence from the wrist; GCT from a chest strap, foot/waist pod, or wrist running-dynamics. Lower duty factor (shorter contact, more flight) loads each step harder. Caveats: needs a running-dynamics-capable device; GCT is an estimate; duty factor changes with speed, so we only ever compare you to <i>your own</i> baseline.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">W, W₀</span> — body weight ÷ a reference weight. Neutral (1) unless a per-athlete reference weight is configured; for a single athlete it drops out, and only matters when comparing across athletes.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">O</span> — Lever body-weight offload: on a Lever run part of bodyweight is supported, and the run is discounted by (1 − 0.85·O), not (1 − O). Taking weight off does not take force off one-for-one: on the Lever, peak vertical force falls ~0.7× the offload (−9% at 90% body weight, −14% at 80%; Paquette 2021, N = 16) while loading rate and vertical impulse fall ~1.0×, so 0.85 is the midpoint of the two slopes — the same tissue-load definition the 0.5 pace exponent uses. O = 0 for normal runs. Known limits: the measured slope is not constant (steeper over the first 10% of support than the next), individual runners ranged −3% to −26% at 80% body weight, and there is no Lever data above ~27% offload. Default is <b>85% bodyweight</b> (O = 0.15), set in the profile. Lever runs are detected automatically — a <b>treadmill</b> activity whose <b>HR is lower than expected for its pace</b> (the offload signature) — or by an activity title containing “lever,” and they can also be <b>marked by hand</b> (Data &amp; settings → Profile → Mark Lever runs…) with a <b>per-run offload</b>; a manual mark always wins over detection and titles, and an auto-detected or titled run uses the profile default. Caveat: treadmill pace can be miscalibrated, which skews the HR-for-pace detection — marking the runs by hand avoids it.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">G</span> — hill surcharge from total ascent &amp; descent ÷ distance (mean grade), descent weighted ~3× ascent, capped at 2.5. When a source records no descent (Strava reports only gain), descent is assumed equal to ascent for outdoor runs — runs almost always end where they started — while a recorded descent, including 0, is used as is. Treadmill / indoor runs take no hill surcharge at all: a belt never descends, so an incline's reported ascent would otherwise price a downhill that never happened. Caveat: only the totals are recorded, so this is <i>mean</i> grade — it can’t tell one steep descent from rolling terrain with the same total, and under-counts concentrated descents. Per-segment grade (from FIT files) would fix this.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">Acute / Chronic / ACWR</span> — exponentially-weighted 7- and 28-day averages of daily load; the ratio sits in a 0.8–1.3 “safe band,” and &gt;1.5 flags a spike.</div>`
+ `<span class="rdx-meth-h">d · Why each piece is defensible (sources)</span>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">Duty factor (impact term)</span> — the strongest spatiotemporal predictor of peak vertical force between runners (R²≈0.59; ${A('https://pmc.ncbi.nlm.nih.gov/articles/PMC7931753/','van Oeveren et al. 2021')}, <i>Scand J Med Sci Sports</i>; ${A('https://pubmed.ncbi.nlm.nih.gov/40197436/','“Duty Factor Dominates Stride Frequency”')}, <i>MSSE</i> 2025), and peak vGRF ∝ 1/duty factor in the ${A('https://doi.org/10.1123/jab.21.2.167','spring-mass model')} (Morin et al. 2005). Cadence <i>alone</i> does not predict peak force — so the model uses the cadence × GCT product, not cadence.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">Why VO is excluded</span> — vertical oscillation is only a weak running-economy correlate (r≈0.35; ${A('https://link.springer.com/article/10.1007/s40279-024-01997-3','Van Hooren et al. 2024 meta-analysis')}, <i>Sports Medicine</i>) and its claimed link to lower impact was not supported, so it stays an efficiency descriptor, not a load term.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">Grade surcharge</span> — downhill running raises impact ~+54% and braking/eccentric force ~+73% at −9° and drives eccentric muscle damage (${A('https://pubmed.ncbi.nlm.nih.gov/15652542/','Gottschall &amp; Kram 2005')}, <i>J Biomechanics</i>); load rises super-linearly with steepness, hence a convex, descent-weighted term.</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">Acute/chronic &amp; ACWR</span> — exponentially-weighted moving averages of training load (${A('https://doi.org/10.1136/bjsports-2016-096589','Williams et al. 2017')}, <i>Br J Sports Med</i>) and the acute:chronic workload ratio with its 0.8–1.3 band (${A('https://doi.org/10.1136/bjsports-2015-095788','Gabbett 2016')}, <i>Br J Sports Med</i>) — used as a decision-support flag, not a verdict (ACWR has documented critiques).</div>`
+ `<div class="rdx-meth-p"><span class="rdx-meth-k">Modeling choices</span> — the pace exponent (0.5) is set between the measured scaling of peak force (~0.4) and loading rate (~1.0) with speed, so the number tracks what tissue sees rather than metabolic cost; the grade coefficients (330/110, cap 2.5) are transparent, tunable defaults reflecting super-linear scaling with grade, not values lifted from a single study.</div>`
+ `<div class="rdx-meth-p rdx-meth-muted"><span class="rdx-meth-k">Honest limits</span> — a transparent estimate of relative mechanical <b>load</b>, not a measured force and not an injury prediction. Duty factor predicts peak force but <i>not</i> loading rate (${A('https://pmc.ncbi.nlm.nih.gov/articles/PMC7931753/','van Oeveren 2021')}), and loading rate is the metric most tied to bone-stress injury — so load increases are only <i>correlated</i> with injury risk.</div>`
+ `<span class="rdx-meth-h">e · References</span>`
+ `<ol class="rdx-meth-refs">`
+ `<li>${A('https://pmc.ncbi.nlm.nih.gov/articles/PMC7931753/','van Oeveren et al. (2021)')} — duty factor as the dominant determinant of peak vertical GRF and peak joint forces. <i>Scand J Med Sci Sports</i>.</li>`
+ `<li>${A('https://pubmed.ncbi.nlm.nih.gov/40197436/','“Duty Factor Dominates Stride Frequency …” (2025)')} — raising cadence alone does not lower peak force. <i>Med Sci Sports Exerc</i>.</li>`
+ `<li>${A('https://doi.org/10.1111/sms.14252','Patoz et al. (2023)')} — estimating peak vertical GRF from duty factor and contact/flight time. <i>Scand J Med Sci Sports</i>.</li>`
+ `<li>${A('https://doi.org/10.1123/jab.21.2.167','Morin et al. (2005)')} — “A simple method for measuring stiffness during running” (spring-mass sine model; peak GRF from flight &amp; contact time). <i>J Appl Biomech</i>.</li>`
+ `<li>${A('https://link.springer.com/article/10.1007/s40279-024-01997-3','Van Hooren et al. (2024)')} — biomechanics &amp; running-economy meta-analysis (vertical oscillation is only a weak economy correlate). <i>Sports Medicine</i>.</li>`
+ `<li>${A('https://pubmed.ncbi.nlm.nih.gov/15652542/','Gottschall &amp; Kram (2005)')} — “Ground reaction forces during downhill and uphill running” (impact &amp; braking rise super-linearly with grade). <i>J Biomechanics</i>.</li>`
+ `<li>${A('https://doi.org/10.1136/bjsports-2015-095788','Gabbett (2016)')} — “The training–injury prevention paradox” (acute:chronic workload ratio and its safe band). <i>Br J Sports Med</i>.</li>`
+ `<li>${A('https://doi.org/10.1136/bjsports-2016-096589','Williams et al. (2017)')} — “Better way to determine the acute:chronic workload ratio?” (EWMA vs rolling averages). <i>Br J Sports Med</i>.</li>`
+ `</ol>`;
}

// SVG overlay for performance/injury events on a time-axis chart. Draws a dashed vertical line
// (red = injury, green = race) with a top marker and a transparent wide hit-line carrying a
// <title> tooltip. Only events whose ts falls within [t0,t1] are drawn. geom is the plot area.
function eventOverlaySVG(events, t0, t1, padL, innerW, padT, innerH) {
  if (!events || !events.length || !(t1 > t0)) return '';
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var span = t1 - t0, top = padT, bot = padT + innerH, out = '';
  var META = { injury: ['#f55050', '⚠ Injury'], race: ['#22c78a', '🏁 Race'], illness: ['#f59a4d', '🤒 Illness'], nonrun: ['#ef6bab', '🩹 Non-Running Injury'], timeoff: ['#5b9cf5', '⏸ Planned Downtime'] };
  var xOf = function (ts) { return padL + ((ts - t0) / span) * innerW; };
  var day = function (ts) { var d = new Date(ts); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
  events.forEach(function (e) {
    if (e.ts == null) return;
    var m = META[e.type] || META.race, col = m[0];
    var end = (e.endTs != null && e.endTs > e.ts) ? e.endTs : null;
    if ((end || e.ts) < t0 || e.ts > t1) return;
    if (end) {
      var x0 = xOf(Math.max(e.ts, t0)), x1 = xOf(Math.min(end, t1));
      var label = m[1] + ' · ' + day(e.ts) + ' – ' + day(end) + (e.note ? ' — ' + e.note : '');
      out += '<rect x="' + x0.toFixed(1) + '" y="' + top + '" width="' + (x1 - x0).toFixed(1) + '" height="' + innerH + '" fill="' + col + '" opacity="0.12"/>';
      if (e.ts >= t0) out += '<line x1="' + x0.toFixed(1) + '" y1="' + top + '" x2="' + x0.toFixed(1) + '" y2="' + bot + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="5 3" opacity="0.55"/>';
      if (end <= t1) out += '<line x1="' + x1.toFixed(1) + '" y1="' + top + '" x2="' + x1.toFixed(1) + '" y2="' + bot + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="5 3" opacity="0.55"/>';
      out += '<rect x="' + x0.toFixed(1) + '" y="' + top + '" width="' + Math.max(x1 - x0, 12).toFixed(1) + '" height="' + innerH + '" fill="rgba(0,0,0,0)"><title>' + esc(label) + '</title></rect>';
    } else {
      var x = xOf(e.ts);
      var label1 = m[1] + ' · ' + day(e.ts) + (e.note ? ' — ' + e.note : '');
      out += '<line x1="' + x.toFixed(1) + '" y1="' + top + '" x2="' + x.toFixed(1) + '" y2="' + bot + '" stroke="' + col + '" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.85"/>'
        + '<polygon points="' + (x - 3.5).toFixed(1) + ',' + top + ' ' + (x + 3.5).toFixed(1) + ',' + top + ' ' + x.toFixed(1) + ',' + (top + 6) + '" fill="' + col + '"/>'
        + '<line x1="' + x.toFixed(1) + '" y1="' + top + '" x2="' + x.toFixed(1) + '" y2="' + bot + '" stroke="rgba(0,0,0,0)" stroke-width="12"><title>' + esc(label1) + '</title></line>';
    }
  });
  return out;
}

// Detect maximal efforts (races / time trials / all-out PRs) from the run set. Returns a Set of
// run ids. A run is flagged if ANY of:
//   • Garmin Aerobic Training Effect ≥ 4.0 (its own "hard/maximal session" score), or
//   • it sits on the athlete's speed–duration frontier (no other run is both longer-or-equal AND
//     faster on grade-adjusted pace) — the critical-speed curve, which catches PRs at any distance, or
//   • avg HR ≥ 92% of the athlete's observed max, sustained ≥ 20 min.
// All signals are individual-relative and degrade gracefully when a field is missing.
// Short reps/sprints are excluded (distMi ≥ 1) so strides don't masquerade as race efforts.
function maxEffortIds(runs, opts) {
  var ids = new Set();
  if (!runs || !runs.length) return ids;
  var minDist = (opts && opts.minDist) || 1, ateThresh = (opts && opts.ate) || 4.0;
  var hasATE = runs.some(function (r) { return r.aerobicTE != null; });
  var hrs = runs.map(function (r) { return r.maxHr; }).filter(function (v) { return v != null && v > 0; }).sort(function (a, b) { return a - b; });
  var estMax = hrs.length ? hrs[Math.floor(0.95 * (hrs.length - 1))] : null;
  // speed–duration Pareto frontier (lower pace = faster); only sustained efforts (≥ minDist)
  var cand = runs.filter(function (r) { return r.durSec > 0 && (r.gapSec || r.paceSec) > 0 && r.distMi != null && r.distMi >= minDist; });
  cand.forEach(function (r) {
    var rp = r.gapSec || r.paceSec, dominated = false;
    for (var i = 0; i < cand.length; i++) {
      var q = cand[i]; if (q === r) continue;
      if (q.durSec >= r.durSec && (q.gapSec || q.paceSec) < rp) { dominated = true; break; }
    }
    if (!dominated) ids.add(r.id);
  });
  runs.forEach(function (r) {
    if (r.distMi == null || r.distMi < minDist) return;
    if (hasATE && r.aerobicTE != null && r.aerobicTE >= ateThresh) ids.add(r.id);
    if (estMax && r.avgHr != null && r.avgHr >= 0.92 * estMax && r.durSec >= 1200) ids.add(r.id);
  });
  return ids;
}

var isTreadmill = isIndoor;

// Heuristic detection of Lever (body-weight-support) runs. A Lever run is on a treadmill AND shows
// the offload signature: avg HR notably lower than expected for its pace, because supporting part of
// bodyweight makes a given pace feel easier. We fit an HR~speed baseline from the athlete's OUTDOOR
// runs, then flag treadmill runs whose avg HR is ≥ margin bpm below the predicted HR. Returns a Set
// of run ids. Title-based flags (run.leverTitle) are an explicit override handled by the caller.
// CAVEAT: treadmill pace can be miscalibrated, which skews the HR-for-pace signal — this is a
// best-effort default; a manual per-run mark (run-dynamics.js runLeverMarks) overrides it.
function detectLeverIds(runs, opts) {
  var ids = new Set();
  if (!runs || !runs.length) return ids;
  var margin = (opts && opts.hrMargin) || 6;
  var ref = runs.filter(function (r) { return r.avgHr > 0 && r.paceSec > 0 && !isTreadmill(r); });
  if (ref.length < 8) return ids;                       // too little outdoor HR data to model reliably
  var n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
  ref.forEach(function (r) { var x = 3600 / r.paceSec, y = r.avgHr; n++; sx += x; sy += y; sxy += x * y; sxx += x * x; });
  var den = n * sxx - sx * sx; if (Math.abs(den) < 1e-9) return ids;
  var b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;   // HR ≈ a + b·speed(mph)
  runs.forEach(function (r) {
    if (!isTreadmill(r) || r.avgHr == null || r.paceSec == null) return;
    var exp = a + b * (3600 / r.paceSec);
    if (r.avgHr <= exp - margin) ids.add(r.id);
  });
  return ids;
}

window.RunLoad = {
  detectLeverIds: detectLeverIds,
  DEFAULTS: DEFAULTS,
  GRAVITY: GRAVITY,
  eventOverlaySVG: eventOverlaySVG,
  maxEffortIds: maxEffortIds,
  median: median,
  calibrateBaseline: calibrateBaseline,
  calibPace: calibPace,
  meanTotalGrade: meanTotalGrade,
  elevation: elevation,
  isIndoor: isIndoor,
  impactLoad: impactLoad,
  offloadFactor: offloadFactor,
  impactPerMileAtLoad: impactPerMileAtLoad,
  vgrfBW: vgrfBW,
  vgrfN: vgrfN,
  dailyLoads: dailyLoads,
  ewma: ewma,
  loadTimeline: loadTimeline,
  extendTimeline: extendTimeline,
  avgLast: avgLast,
  peakWindow: peakWindow,
  shortRatio: shortRatio,
  loadWindows: loadWindows,
  methodologyHTML: methodologyHTML
};

})();
