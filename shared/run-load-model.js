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
  kPace:      1.5,   // pace (intensity) exponent
  kImpact:    1.0,   // per-step impact exponent — peak vGRF ∝ 1/duty factor (Morin 2005; Patoz 2023)
  useGrade:   false, // enable grade surcharge (needs ascent/descent metres)
  acuteN:     7,     // acute EWMA window (days)
  chronicN:   28,    // chronic EWMA window (days)
  refWeight:  1.0,   // reference weight; = athlete weight for clean eq-miles
  basePaceSec: 420,  // easy-run baseline pace (s/mi) — fallback
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
  // Pace speedup per unit body-weight offload: a Lever run holds a faster pace at the same effort,
  // so we convert its pace to a road-equivalent P/(1−offloadPaceK·offload) before the pace term.
  // Calibrated at easy pace (~11.4% speedup at 15% offload); ~effort-independent so one coefficient
  // is correct from easy to threshold. Tunable.
  offloadPaceK: 0.76
};

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
  var dM = r.distMi * 1609.34;
  var ag = (r.ascentM  > 0 ? r.ascentM  : 0) / dM;
  var dg = (r.descentM > 0 ? r.descentM : 0) / dM;
  return r.paceSec / Math.max(1 + p.gapUp * ag - p.gapDown * dg, 0.7);
}
function meanTotalGrade(r) {
  if (!(r.distMi > 0)) return 0;
  return ((r.ascentM > 0 ? r.ascentM : 0) + (r.descentM > 0 ? r.descentM : 0)) / (r.distMi * 1609.34);
}

// Per-athlete, per-device baseline from their easy-run history (grade-adjusted pace at
// or slower than the easy/workout cutoff). Falls back to all runs, then to DEFAULTS,
// when there aren't enough easy runs. Normalising every factor to this baseline makes
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
    basePaceSec: basePace || DEFAULTS.basePaceSec,
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
  // normal runs. Clamped to 95% so load can't go to zero.
  var off   = run.offload != null ? run.offload : (run.lever ? (p.offload || 0) : 0);
  off = off > 0 ? Math.min(off, 0.95) : 0;
  // The offload enters in TWO places, because bodyweight support both (a) lets a given effort hold a
  // faster pace AND (b) cuts ground reaction force. For (a) we convert the Lever run's pace to its
  // ROAD-equivalent — P / (1 − offloadPaceK·O) — before the pace term, rather than shifting the
  // baseline. The speedup coefficient is ~effort-independent (≈11% at 15% offload, easy AND
  // threshold), so this one correction is right across the whole intensity range; shifting the
  // baseline only worked at easy pace. E.g. a 6:30 Lever mile at 15% offload → ~7:20 road-equivalent.
  var eqPace = off > 0 ? run.paceSec / (1 - p.offloadPaceK * off) : run.paceSec;
  var paceF = Math.pow(p.basePaceSec / eqPace, p.kPace);
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
  // (b) less ground reaction force → the weight term is also multiplied by (1 − O).
  // Require weight > 0: a negative weight (garbage) would otherwise flow through as a
  // negative load; missing/zero falls back to refWeight (→ 1). Matches the lever-iq port.
  var wF    = ((run.weight > 0 ? run.weight : p.refWeight)) / p.refWeight;
  var mods = paceF * dfF * wF;
  if (p.useGrade && run.distMi) {
    var distM = run.distMi * 1609.34;
    var dg = (run.descentM || 0) / distM;   // mean descent grade (fraction)
    var ag = (run.ascentM  || 0) / distM;   // mean ascent grade (fraction)
    mods *= Math.min(1 + p.kDescent * dg * dg + p.kAscent * ag * ag, p.gradeCap);
  }
  // FLOOR: at full bodyweight, a mile is never less than a mile of impact. Slower-than-
  // baseline pace, soft form, or a light-day weight ratio lower PEAK force per step,
  // but you take more steps per mile — the distance itself is the irreducible impact,
  // so the pace × form × weight × grade modifier product can't discount below 1. ONLY
  // the Lever offload sits outside the floor: body-weight support genuinely removes
  // ground reaction force, so a Lever run's floor is distance × (1 − O), not distance.
  var il = run.distMi * (off > 0 ? 1 - off : 1) * Math.max(mods, 1);
  // Final belt-and-braces: never let a non-finite value escape into the load series.
  return Number.isFinite(il) ? il : null;
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

// Inner HTML for the "How Impact Load is calculated" methodology panel (equation, plain-language
// equation, per-variable explanation + caveats, and cited literature). Inline-styled with the
// pages' CSS vars so it renders on both the dashboard tab and the standalone page. Drop inside a
// <details> on each page.
function methodologyHTML() {
  var H='display:block;margin:14px 0 5px;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted2)';
  var EQ='font-family:ui-monospace,monospace;font-size:11.5px;line-height:1.7;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;white-space:pre-wrap;overflow-x:auto;color:var(--text);margin:0 0 4px';
  var V='margin:7px 0;line-height:1.55';
  var K='color:var(--text);font-weight:700;font-family:ui-monospace,monospace';
  var A=function(href,txt){ return '<a href="'+href+'" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:none;border-bottom:1px solid rgba(0,229,200,.35)">'+txt+'</a>'; };
  return `<span style="${H}">a · the equation</span>`
+ `<pre style="${EQ}">Impact Load (per run) — measured in Impact Adjusted Distance (IAD miles):

  IL = D · (1−O) · max( (W ⁄ W₀) · (P₀ ⁄ Pᵉ)^1.5 · (DF₀ ⁄ DF)^1.0 · G , 1 )

       The max(…, 1) floor: at full bodyweight a mile is never less
              than a mile of impact — easy pace, soft form, and the
              weight ratio can't discount the distance itself. ONLY
              the Lever offload (1−O), outside the floor, can take
              IL below actual distance.
       DF = cadence × GCT
       O  = Lever body-weight offload (0 when not on the Lever)
       Pᵉ = P ⁄ (1 − 0.76·O)   ← Lever pace → road-equivalent
       The offload enters twice: it speeds the run's pace back to
              its road-equivalent Pᵉ (support lets you hold a faster
              pace) AND discounts the weight term W (support cuts
              ground reaction force). Off the Lever, Pᵉ = P.
       G  = min( 1 + 330·(desc ⁄ L)² + 110·(asc ⁄ L)² , 2.5 )

Load over time:

  EWMAₜ = Lₜ·λ + EWMAₜ₋₁·(1−λ),   λ = 2 ⁄ (N+1)
  Acute = EWMA(N = 7 d)    Chronic = EWMA(N = 28 d)
  ACWR  = Acute ⁄ Chronic</pre>`
+ `<span style="${H}">b · in plain language</span>`
+ `<pre style="${EQ}">Impact Adjusted Distance (IAD miles) = distance
   × (how much faster than your easy pace)^1.5
   × (how much springier than your easy form)
   × (body-weight scale, minus any Lever offload)
   × (hill surcharge)

On the Lever, the body-weight support both softens each step AND
lets you hold a faster pace at the same effort — so we first convert
the Lever pace back to the road pace that effort would have been
(e.g. a 6:30 mile at 15% support ≈ a 7:20 road mile), then score it
normally. This works at any intensity, easy through threshold.

One easy flat mile = 1 IAD mile; a hard or hilly mile counts as
more. A full-bodyweight mile never counts as LESS than one IAD
mile — running slower softens each step but adds steps per mile, so
the distance itself is the floor. Only Lever body-weight support
(which removes ground reaction force) can score below distance.

Acute   = 7-day rolling average of daily IAD miles
Chronic = 28-day rolling average
Acute : Chronic = recent load vs the base you have built</pre>`
+ `<span style="${H}">c · each variable — meaning, measurement, caveats</span>`
+ `<div style="${V}"><span style="${K}">D</span> — run distance (mi), from GPS or foot-pod / treadmill. Track distances arrive in metres and are converted.</div>`
+ `<div style="${V}"><span style="${K}">P, P₀</span> — average pace and your easy-run baseline pace (s/mi), from GPS. Baseline = median <b>grade-adjusted</b> pace of your easy runs (at or slower than the workout-pace cutoff on adjusted pace): each run's pace is first converted to its flat-equivalent (~3.5% per 1% mean ascent grade, downhill credits about half; a device-reported Avg GAP is used directly when present) so honest slow climbing on trail runs doesn't drag the easy baseline slower and inflate flat runs' scores. Only the baseline uses adjusted pace — each run is still scored on its raw pace, since the hill surcharge G already prices the grade. The 1.5 power reflects force &amp; metabolic cost rising faster than speed. On a <b>Lever run</b> the pace P is first converted to its <b>road-equivalent</b> Pᵉ = P ⁄ (1 − 0.76·O) — body-weight support lets you hold a faster pace at the same effort, so we credit that speedup back before comparing to baseline (e.g. a 6:30 mile at 15% support ≈ a 7:20 road mile). The 0.76 coefficient is roughly effort-independent, so it holds from easy to threshold pace. Caveat: pace under-rates uphill effort (hard but slow) — the hill term offsets this.</div>`
+ `<div style="${V}"><span style="${K}">DF, DF₀</span> — duty factor = cadence × ground-contact time, vs your easy baseline (median of <b>flat</b> easy runs only, ≤2% mean total grade when enough exist — slow long-contact trail steps would otherwise inflate the form baseline and surcharge normal flat running). Cadence from the wrist; GCT from a chest strap, foot/waist pod, or wrist running-dynamics. Lower duty factor (shorter contact, more flight) loads each step harder. Caveats: needs a running-dynamics-capable device; GCT is an estimate; duty factor changes with speed, so we only ever compare you to <i>your own</i> baseline.</div>`
+ `<div style="${V}"><span style="${K}">W, W₀</span> — body weight ÷ a reference weight, from the profile. Equals 1 for a single athlete (drops out); only matters when comparing across athletes.</div>`
+ `<div style="${V}"><span style="${K}">O</span> — Lever body-weight offload: on a Lever run part of bodyweight is supported. This enters the load in two places — it speeds the run's pace back to its road-equivalent Pᵉ = P ⁄ (1 − 0.76·O) (support lets you run faster at the same effort) <i>and</i> discounts the weight term by (1 − O) (support cuts ground reaction force); O = 0 for normal runs. Default is <b>85% bodyweight</b> (O = 0.15), set in the profile. Lever runs are detected automatically — a <b>treadmill</b> activity whose <b>HR is lower than expected for its pace</b> (the offload signature) — or by an activity title containing “lever.” Caveat: treadmill pace can be miscalibrated; a dedicated per-run Lever source (tag / device import) can be wired in later for exact offloads.</div>`
+ `<div style="${V}"><span style="${K}">G</span> — hill surcharge from total ascent &amp; descent ÷ distance (mean grade), descent weighted ~3× ascent, capped at 2.5. Caveat: only the totals are recorded, so this is <i>mean</i> grade — it can’t tell one steep descent from rolling terrain with the same total, and under-counts concentrated descents. Per-segment grade (from FIT files) would fix this.</div>`
+ `<div style="${V}"><span style="${K}">Acute / Chronic / ACWR</span> — exponentially-weighted 7- and 28-day averages of daily load; the ratio sits in a 0.8–1.3 “safe band,” and &gt;1.5 flags a spike.</div>`
+ `<span style="${H}">d · why each piece is defensible (sources)</span>`
+ `<div style="${V}"><span style="${K}">Duty factor (impact term)</span> — the strongest spatiotemporal predictor of peak vertical force between runners (R²≈0.59; ${A('https://pmc.ncbi.nlm.nih.gov/articles/PMC7931753/','van Oeveren et al. 2021')}, <i>Scand J Med Sci Sports</i>; ${A('https://pubmed.ncbi.nlm.nih.gov/40197436/','“Duty Factor Dominates Stride Frequency”')}, <i>MSSE</i> 2025), and peak vGRF ∝ 1/duty factor in the ${A('https://doi.org/10.1123/jab.21.2.167','spring-mass model')} (Morin et al. 2005). Cadence <i>alone</i> does not predict peak force — so the model uses the cadence × GCT product, not cadence.</div>`
+ `<div style="${V}"><span style="${K}">Why VO is excluded</span> — vertical oscillation is only a weak running-economy correlate (r≈0.35; ${A('https://link.springer.com/article/10.1007/s40279-024-01997-3','Van Hooren et al. 2024 meta-analysis')}, <i>Sports Medicine</i>) and its claimed link to lower impact was not supported, so it stays an efficiency descriptor, not a load term.</div>`
+ `<div style="${V}"><span style="${K}">Grade surcharge</span> — downhill running raises impact ~+54% and braking/eccentric force ~+73% at −9° and drives eccentric muscle damage (${A('https://pubmed.ncbi.nlm.nih.gov/15652542/','Gottschall &amp; Kram 2005')}, <i>J Biomechanics</i>); load rises super-linearly with steepness, hence a convex, descent-weighted term.</div>`
+ `<div style="${V}"><span style="${K}">Acute/chronic &amp; ACWR</span> — exponentially-weighted moving averages of training load (${A('https://doi.org/10.1136/bjsports-2016-096589','Williams et al. 2017')}, <i>Br J Sports Med</i>) and the acute:chronic workload ratio with its 0.8–1.3 band (${A('https://doi.org/10.1136/bjsports-2015-095788','Gabbett 2016')}, <i>Br J Sports Med</i>) — used as a decision-support flag, not a verdict (ACWR has documented critiques).</div>`
+ `<div style="${V}"><span style="${K}">Modeling choices</span> — the pace exponent (1.5) and grade coefficients (330/110, cap 2.5) are transparent, tunable defaults reflecting super-linear scaling with speed &amp; grade, not values lifted from a single study.</div>`
+ `<div style="${V};color:var(--muted2)"><span style="${K}">Honest limits</span> — a transparent estimate of relative mechanical <b>load</b>, not a measured force and not an injury prediction. Duty factor predicts peak force but <i>not</i> loading rate (${A('https://pmc.ncbi.nlm.nih.gov/articles/PMC7931753/','van Oeveren 2021')}), and loading rate is the metric most tied to bone-stress injury — so load increases are only <i>correlated</i> with injury risk.</div>`
+ `<span style="${H}">e · references</span>`
+ `<ol style="margin:4px 0 0;padding-left:18px;line-height:1.65;color:var(--muted2)">`
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
  var META = { injury: ['#f55050', '⚠ Injury'], race: ['#22c78a', '🏁 Race'], illness: ['#f59a4d', '🤒 Illness'], timeoff: ['#5b9cf5', '⏸ Planned Downtime'] };
  var xOf = function (ts) { return padL + ((ts - t0) / span) * innerW; };
  var day = function (ts) { return new Date(ts).toISOString().slice(0, 10); };
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

function isTreadmill(r) { return /treadmill|indoor/i.test(r.type || ''); }

// Heuristic detection of Lever (body-weight-support) runs. A Lever run is on a treadmill AND shows
// the offload signature: avg HR notably lower than expected for its pace, because supporting part of
// bodyweight makes a given pace feel easier. We fit an HR~speed baseline from the athlete's OUTDOOR
// runs, then flag treadmill runs whose avg HR is ≥ margin bpm below the predicted HR. Returns a Set
// of run ids. Title-based flags (run.leverTitle) are an explicit override handled by the caller.
// CAVEAT: treadmill pace can be miscalibrated, which skews the HR-for-pace signal — this is a
// best-effort interim until an explicit per-run Lever source (tag / device import) is available.
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
  impactLoad: impactLoad,
  vgrfBW: vgrfBW,
  vgrfN: vgrfN,
  dailyLoads: dailyLoads,
  ewma: ewma,
  loadTimeline: loadTimeline,
  methodologyHTML: methodologyHTML
};

})();
