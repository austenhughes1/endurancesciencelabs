// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-data.js
//
// The data side of the Training Analysis view: everything that decides a
// number or the meaning of a stored field, with no DOM and no Firebase.
// shared/run-dynamics.js (the view) renders from it. Pinned by
// shared/run-dynamics-data.test.js.
//
// Depends on window.RunLoad (shared/run-load-model.js). Load order on a
// host page: run-load-model.js, injury-patterns.js, device-matrix.js,
// run-dynamics-data.js, run-dynamics.js.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

var DAY = 864e5;

// 7-day ratio colour: the safe band is 0.8–1.3× the 28-day base.
function acwrColor(a){ if(a==null)return 'var(--muted2)'; if(a>1.5)return 'var(--bad)'; if(a>1.3)return 'var(--gold)'; if(a<0.8)return 'var(--warn)'; return 'var(--good)'; }

// Whole calendar days from ts to now; rounding absorbs DST.
function calDaysAgo(ts, now){ var a=new Date(ts), b=new Date(now); a.setHours(0,0,0,0); b.setHours(0,0,0,0); return Math.round((b-a)/DAY); }

/* Admin-only demo scenarios for the Today card. Each forces the hero's r1/r3/r7 ratios; real run
   data is never touched. r1 and r3 are PEAK-relative (today vs the biggest single day / biggest 3-day
   block of the prior 28), r7 is the 7-day mean vs the 28-day mean day; d1/d3/d7 are derived as
   r × base for the tiles only. */
var DEMO_LIST=[
  {key:'bigday',   label:'Big day'},
  {key:'hardday',  label:'Hard day'},
  {key:'heavy3',   label:'Heavy 3-day'},
  {key:'bigweek',  label:'Big week'},
  {key:'ceiling',  label:'Near ceiling'},
  {key:'building', label:'Room to build'},
  {key:'safe',     label:'Safe band'},
  {key:'baseline', label:'No data'},
];
var DEMO_PRESETS={
  bigday:  {base:8.0, r1:2.3, r3:1.5,  r7:1.15},
  hardday: {base:8.0, r1:1.6, r3:1.15, r7:1.05},
  heavy3:  {base:8.0, r1:1.2, r3:1.65, r7:1.25},
  bigweek: {base:8.0, r1:1.1, r3:1.35, r7:1.6 },
  ceiling: {base:8.0, r1:1.0, r3:1.2,  r7:1.35},
  building:{base:8.0, r1:0.6, r3:0.65, r7:0.7 },
  safe:    {base:8.0, r1:1.05,r3:1.0,  r7:0.95},
  baseline:{nullBase:true},
};

/* The Today card's numbers and verdict. FROZEN by owner decision: thresholds, headlines, accents,
   loMult/hiMult and the flat/hilly/Lever conversions are the model — copy changes go in `todo` only.
   opts: { runs: every analyzable run (load side ignores the type chips), params: load params,
           now: Date, demo: a DEMO_PRESETS entry or null, leverPct: Lever support % BW, coach: bool }
   Returns {short:true, todo} when there are fewer than 2 days of timeline. */
function heroModel(opts){
  var runs=opts.runs, P=opts.params, today=opts.now, sc=opts.demo||null, pct=opts.leverPct, coach=!!opts.coach;
  // Anchor on TODAY, not on the athlete's last run day: extendTimeline zero-pads through today
  // (decaying acute/chronic per padded day), so d1 is 0 on a rest day and the acute-trend lookback
  // sees the real calendar.
  var tl=RunLoad.extendTimeline(RunLoad.loadTimeline(runs, P), today, P);
  if(tl.length<2){
    return { short:true, todo: coach ? 'Daily guidance shows up here once this athlete has a few more weeks of runs.' : 'Import a few more weeks of runs and your daily guidance shows up here.' };
  }
  // 1-, 3-, 7-day windows. r1/r3 are PEAK-relative (RunLoad.shortRatio); r7 = 7-day mean ÷ 28-day mean day.
  var W=RunLoad.loadWindows(tl);
  var d1=W.d1, d3=W.d3, d7=W.d7, d28=W.d28, base=W.base, r1=W.r1, r3=W.r3, r7=W.r7;
  var demoOn=false;
  if(sc){
    demoOn=true;
    if(sc.nullBase){ base=null; d1=d3=d7=d28=0; r1=r3=r7=null; }
    else { base=sc.base; d28=sc.base; r1=sc.r1; r3=sc.r3; r7=sc.r7; d1=r1*base; d3=r3*base; d7=r7*base; }
  }
  // Tile tints: a peak-relative ratio below 0.8 is an ordinary day, not detraining.
  var peakColor=function(r){ return (r!=null && r<0.8) ? 'var(--good)' : acwrColor(r); };
  var col1=peakColor(r1), col3=peakColor(r3), col7=acwrColor(r7);

  // Typical single-run Impact Load: median of the last ~6 weeks of runs, anchored at today; else the
  // 28-day daily base × 1.4, or 6 with no base.
  var todayTs=tl[tl.length-1].ts;
  var loads = demoOn ? [] : runs.filter(function(r){ return r.ts>=todayTs-42*864e5; })
    .map(function(r){ return RunLoad.impactLoad(r, P); }).filter(function(v){ return v!=null && v>0; });
  var typical = loads.length>=3 ? RunLoad.median(loads) : (base?base*1.4:6);

  // Acute-curve trajectory: weekly fractional rise of the 7-day EWMA. "Climbing hot" once acute is
  // also at/above chronic (a rebuild from a low base is expected to ramp fast).
  var last=tl[tl.length-1];
  var acuteNow=last.acute||0, chronicNow=last.chronic||0;
  var bk=Math.min(7, tl.length-1);
  var aPast=(!demoOn && bk>=4) ? (tl[tl.length-1-bk].acute||0) : 0;
  var rampPerWk = aPast>0 ? (Math.pow(acuteNow/aPast, 7/bk)-1) : null;
  var acwrNow = chronicNow>0 ? acuteNow/chronicNow : null;
  var climbingHot = rampPerWk!=null && rampPerWk>=0.15 && acwrNow!=null && acwrNow>=0.95;

  var head, accent, todo, lo=null, hi=null, flat=null, hilly=null, lever=null, leverInTarget=false;
  if(base==null){
    head='Building your baseline'; accent='var(--muted2)';
    todo=coach ? 'Easy runs or Lever runs while we learn their baseline.' : 'Easy runs or Lever runs while we learn your baseline.';
  } else {
    // Driven by the MAX of the 1/3/7-day ratios; 1.15/1.3/1.5 read as 15/30/50% beyond whichever leads.
    var loMult, hiMult;
    var maxR=Math.max(r1,r3,r7);
    var rampWkTxt = rampPerWk!=null ? Math.round(rampPerWk*100)+'%' : '';
    if(maxR>=1.5 || (climbingHot && rampPerWk>=0.25 && acwrNow>=1.2)){
      accent='var(--bad)'; head='Overreaching — recover next'; loMult=0.3; hiMult=0.6;
      todo=coach ? 'Over their range: recovery day or rest.' : 'Over your range: recovery day or rest.';
    } else if(maxR>=1.3){
      accent='var(--gold)'; head='At your ceiling — ease off'; loMult=0.6; hiMult=0.9;
      todo=coach ? 'At their ceiling: easy only, no hard efforts.' : 'At your ceiling: easy only, no hard efforts.';
    } else if(climbingHot){
      accent='var(--gold)'; head='Climbing fast — ease the ramp'; loMult=0.6; hiMult=0.9;
      todo='Load rising +'+rampWkTxt+'/wk: hold volume flat.';
    } else if(maxR>=1.15){
      accent='var(--gold)'; head='Approaching your ceiling'; loMult=0.7; hiMult=1.0;
      todo=coach ? 'Near their ceiling: easy only today.' : 'Near your ceiling: easy only today.';
    } else if(r7<0.8){
      accent='var(--warn)'; head='Room to build'; loMult=0.9; hiMult=1.3;
      todo=coach ? 'Athlete has room: easy, long or a workout all fit.' : 'You have room: easy, long or a workout all fit.';
    } else {
      accent='var(--good)'; head='In the safe band'; loMult=0.8; hiMult=1.15;
      todo='Easy run or workout. Both fit today.';
    }
    lo=typical*loMult; hi=typical*hiMult;
    // Top-end budget (hi, IAD mi) as run options: flat ≈ 1:1, hilly ÷1.25, Lever through
    // RunLoad.impactPerMileAtLoad (the same discount impactLoad scores with).
    flat=hi; hilly=hi/1.25; lever=hi/RunLoad.impactPerMileAtLoad(pct, P);
    // The Lever rides on the target line only when the call is to back off (gold/red states).
    leverInTarget = accent==='var(--gold)' || accent==='var(--bad)';
  }
  // Acute trend tint: rising fast is a leading signal even in band; a decline reads muted.
  var rampTxt = rampPerWk==null ? '—' : (rampPerWk>=0?'+':'')+Math.round(rampPerWk*100)+'%';
  var rampCol = rampPerWk==null ? 'var(--muted2)' : rampPerWk>=0.20 ? 'var(--bad)' : rampPerWk>=0.10 ? 'var(--gold)' : 'var(--muted2)';
  // Runs on today's local calendar day (the day d1 covers). Demo scenarios always show the target.
  var todayRuns = demoOn ? [] : runs.filter(function(r){ return calDaysAgo(r.ts, today)===0; });
  var todayMi = todayRuns.reduce(function(a,r){ return a+(r.distMi||0); },0);
  return {
    short:false, demo:demoOn, head:head, accent:accent, todo:todo,
    d1:d1, d3:d3, d7:d7, d28:d28, base:base, r1:r1, r3:r3, r7:r7, col1:col1, col3:col3, col7:col7,
    typical:typical, lo:lo, hi:hi, flat:flat, hilly:hilly, lever:lever, leverInTarget:leverInTarget, pct:pct,
    rampPerWk:rampPerWk, rampTxt:rampTxt, rampCol:rampCol, climbingHot:climbingHot, isClimb: head==='Climbing fast — ease the ramp',
    todayRuns:todayRuns.length, todayMi:todayMi
  };
}

var RunData = {
  acwrColor: acwrColor,
  calDaysAgo: calDaysAgo,
  DEMO_LIST: DEMO_LIST,
  DEMO_PRESETS: DEMO_PRESETS,
  heroModel: heroModel
};
if (typeof window !== 'undefined') window.RunData = RunData;
if (typeof module !== 'undefined' && module.exports) module.exports = RunData;
})();
