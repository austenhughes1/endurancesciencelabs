// ════════════════════════════════════════════════════════════════
// shared/injury-patterns.js
//
// Injury-pattern analysis for the Run Dynamics tool: what did the
// training look like in the window LEADING UP TO each logged injury,
// and how unusual was it vs the rest of the athlete's history?
//
// Pure functions only — no DOM, no Firebase. Depends on window.RunLoad
// (shared/run-load-model.js) for per-run Impact Load and the daily
// acute/chronic timeline. Exposed as window.InjuryPatterns.
//
// Method (retrospective, correlational — NEVER a prediction):
//   1. A registry of pattern detectors (PATTERNS) — each looks at the
//      trailing training window ending on a given date and answers
//      "did this pattern fire here?" (sustained ramp, ACWR spike,
//      long-run jump, intensity spike, monotony, downhill spike).
//   2. Every logged injury is evaluated at its date (case windows).
//   3. The SAME detectors run on control windows sampled every 7 days
//      across the rest of the history (excluding pre-injury windows
//      and post-injury recovery), giving each pattern a base rate.
//      A pattern is "correlated" when it fires before injuries far
//      more often than its base rate (the lift).
//   4. Big unexplained volume drops — not near a race / hard effort
//      (taper or recovery = planned) and not after a logged injury —
//      are surfaced as possible unlogged setbacks, each with the same
//      pattern analysis at its onset.
//
// Small-sample honesty: most athletes log 1–5 injuries. The report
// always shows raw counts (2 of 2, not "100%"), the control base
// rate, and a low-confidence marker when controls are scarce.
// Every threshold is a tunable heuristic default in OPTS.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

var DAY = 864e5;

var OPTS = {
  acuteWinDays:   14,   // "leading up to" window scored by most detectors
  minHistoryDays: 70,   // need this much daily history to analyze at all
  minLeadDays:    42,   // an eval date needs this much history before it (EWMA warm-up)
  // ramp: consecutive week-over-week climbs
  rampWkRise:     0.08, // a week counts as "climbing" at ≥ +8% over the previous
  rampMinWeeks:   3,    // fired at ≥ 3 straight climbing weeks…
  rampMinCum:     1.30, // …AND ≥ +30% total over the climb
  rampMinWeekLoad:2,    // ignore climbs off a near-zero base week (IAD mi)
  // acwr: acute:chronic spike in the window
  acwrFire:       1.40,
  acwrMinChronic: 0.5,  // IAD mi/day — below this the ratio is noise
  // long-run jump: biggest single run vs the typical weekly long run
  longRunRatio:   1.35,
  longRunMinGap:  2,    // and at least +2 IAD mi absolute
  longRunBaseWks: 4,    // need ≥ this many baseline weeks with a long run
  // intensity: share of load from hard sessions, recent vs typical
  hardRatio:      1.25, // a run is "hard" when its IAD ÷ distance ≥ this (pace/form/hills driven)
  hardHrFrac:     0.90, // …or avg HR ≥ 90% of observed max
  intShareFire:   0.25, // recent hard share must be ≥ 25% of load…
  intShareLift:   1.75, // …and ≥ 1.75× the athlete's typical share
  intMinRecent:   5,    // IAD mi in the window, else too little to judge
  intMinBase:     20,   // IAD mi in the 8-wk baseline, else too little to judge
  // monotony / no rest (21-day window)
  monoWinDays:    21,
  monoFire:       2.0,  // Foster monotony = mean(daily) / sd(daily)
  monoMinRunDays: 15,
  streakFire:     10,   // consecutive run days
  // downhill spike
  descRatio:      1.6,  // recent 14-d descent vs 2× typical weekly descent
  descMinM:       300,  // and at least this much absolute descent (m)
  // unplanned volume drops (weekly series)
  dropMinBase:    10,   // IAD mi/wk — only meaningful bases can "drop"
  dropStart:      0.50, // a week ≤ 50% of the trailing 4-wk mean starts a drop
  dropCont:       0.70, // …and it continues while weeks stay ≤ 70% of that base
  dropMaxWeeks:   8,    // cap: a return at a lower NEW normal is a regime change, not a drop —
                        //      without this a post-setback rebuild extends the drop forever and
                        //      swallows genuinely separate later drops
  raceExplainDays:10,   // a race/hard effort within ±10 d of the drop explains it
  injExplainPre:  14,   // a logged injury up to 14 d before the drop explains it
  injExplainPost: 21,   // …or up to 21 d into it
  // control sampling
  ctrlStepDays:   7,
  ctrlExclPreInj: 28,   // days before an injury excluded from controls
  ctrlExclPostInj:56,   // days after an injury excluded (recovery pollutes the base rate)
  ctrlExclDropPre:21,   // same exclusions around unexplained drops
  ctrlExclDropPost:28,
  lowConfCtrls:   8     // fewer controls than this ⇒ mark base rates low-confidence
};

function median(a){ return window.RunLoad.median(a); }
function mean(a){ if(!a.length) return null; var s=0; for(var i=0;i<a.length;i++) s+=a[i]; return s/a.length; }
function sd(a){ var m=mean(a); if(m==null||a.length<2) return null; var s=0; for(var i=0;i<a.length;i++) s+=(a[i]-m)*(a[i]-m); return Math.sqrt(s/(a.length-1)); }
function dayFloor(ts){ var d=new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function pctTxt(x){ return Math.round(x*100)+'%'; }

/* ---------- prep: dense per-day aggregates the detectors slice ---------- */
function prep(runs, params, o){
  var RL=window.RunLoad;
  var tl=RL.loadTimeline(runs, params);
  if(!tl.length) return null;
  var maxIds=RL.maxEffortIds(runs);
  var hrs=runs.map(function(r){return r.maxHr;}).filter(function(v){return v>0;}).sort(function(a,b){return a-b;});
  var estMax=hrs.length?hrs[Math.floor(0.95*(hrs.length-1))]:null;
  var byDay={}, hardDays=[];
  runs.forEach(function(r){
    var il=RL.impactLoad(r, params); if(il==null) return;
    var k=dayFloor(r.ts);
    var d=byDay[k]||(byDay[k]={maxRunIL:0,hardLoad:0,descentM:0,hasDesc:false,nRuns:0});
    d.nRuns++;
    if(il>d.maxRunIL) d.maxRunIL=il;
    var hard=(r.distMi>0.5 && il/r.distMi>=o.hardRatio) || maxIds.has(r.id) || (estMax!=null && r.avgHr!=null && r.avgHr>=o.hardHrFrac*estMax);
    if(hard) d.hardLoad+=il;
    if(r.descentM!=null){ d.descentM+=r.descentM; d.hasDesc=true; }
    if(maxIds.has(r.id)) hardDays.push(k);
  });
  var anyDesc=false, idx={};
  var days=tl.map(function(t,i){
    var d=byDay[t.ts]||{};
    if(d.hasDesc) anyDesc=true;
    idx[t.ts]=i;
    return { ts:t.ts, load:t.daily, acute:t.acute, chronic:t.chronic, acwr:t.acwr,
             maxRunIL:d.maxRunIL||0, hardLoad:d.hardLoad||0, descentM:d.descentM||0, ran:(d.nRuns||0)>0 };
  });
  return { days:days, idx:idx, anyDesc:anyDesc, hardDays:hardDays };
}
function winStats(days, i0, i1){
  var s={load:0,hardLoad:0,descentM:0,maxRun:0,runDays:0,n:0,vals:[]};
  for(var i=Math.max(0,i0); i<=Math.min(i1,days.length-1); i++){
    var d=days[i];
    s.load+=d.load; s.hardLoad+=d.hardLoad; s.descentM+=d.descentM;
    if(d.maxRunIL>s.maxRun) s.maxRun=d.maxRunIL;
    if(d.ran) s.runDays++;
    s.vals.push(d.load); s.n++;
  }
  return s;
}
/* n trailing 7-day blocks ending at endIdx, oldest first; null when off the front. */
function weeksEnding(days, endIdx, n){
  var out=[];
  for(var w=n-1; w>=0; w--){
    var i1=endIdx-w*7, i0=i1-6;
    out.push(i0>=0 ? winStats(days,i0,i1) : null);
  }
  return out;
}

/* ---------- the pattern registry ----------
   Each detector gets ctx = {days, endIdx, weeks (12 trailing, oldest first),
   acute (14-d window stats), prepd, o} and returns null (can't evaluate here)
   or {fired, value} where value is the plain-language evidence string.
   Add new patterns here — the case/control machinery picks them up automatically. */
var PATTERNS=[
  { id:'ramp', name:'Volume ramping too fast, too long',
    desc:'weekly load climbing ≥8% week-over-week for 3+ straight weeks',
    detect:function(ctx){
      var w=ctx.weeks.filter(function(x){return x!=null;});
      if(w.length<5) return null;
      var count=0, last=w.length-1;
      for(var i=last; i>=1; i--){
        var prev=w[i-1].load;
        if(prev>=ctx.o.rampMinWeekLoad && w[i].load>=prev*(1+ctx.o.rampWkRise)) count++;
        else break;
      }
      var fired=false, value='no sustained week-over-week climb';
      if(count>=1){
        var cum=w[last-count].load>0 ? w[last].load/w[last-count].load : null;
        fired = count>=ctx.o.rampMinWeeks && cum!=null && cum>=ctx.o.rampMinCum;
        value = count+' straight climbing week'+(count>1?'s':'')+(cum?', +'+Math.round((cum-1)*100)+'% total':'');
      }
      return {fired:fired, value:value};
    } },
  { id:'acwr', name:'Load spike vs your base (ACWR)',
    desc:'acute:chronic ratio reached ≥1.4 inside the window',
    detect:function(ctx){
      var best=null;
      for(var i=Math.max(0,ctx.endIdx-ctx.o.acuteWinDays+1); i<=ctx.endIdx; i++){
        var d=ctx.days[i];
        if(d.chronic>=ctx.o.acwrMinChronic && d.acwr!=null && (best==null||d.acwr>best)) best=d.acwr;
      }
      if(best==null) return null;
      return {fired:best>=ctx.o.acwrFire, value:'peaked at '+best.toFixed(2)+'× your chronic base'+(best>=1.5?' (spike zone)':'')};
    } },
  { id:'longrun', name:'Long-run jump',
    desc:'biggest single run well above your typical weekly long run',
    detect:function(ctx){
      var base=[];
      // typical long run = median weekly max over the weeks BEFORE the acute window
      for(var i=0;i<ctx.weeks.length-2;i++){ var w=ctx.weeks[i]; if(w&&w.maxRun>0) base.push(w.maxRun); }
      if(base.length<ctx.o.longRunBaseWks) return null;
      var typ=median(base), big=ctx.acute.maxRun;
      if(!(big>0)) return null;
      return { fired: big>=typ*ctx.o.longRunRatio && (big-typ)>=ctx.o.longRunMinGap,
               value:'biggest run '+big.toFixed(1)+' IAD mi vs typical long run '+typ.toFixed(1) };
    } },
  { id:'intensity', name:'Intensity spike',
    desc:'share of load from hard sessions well above your norm',
    detect:function(ctx){
      var rec=ctx.acute;
      var baseW=winStats(ctx.days, ctx.endIdx-ctx.o.acuteWinDays-56+1, ctx.endIdx-ctx.o.acuteWinDays);
      if(rec.load<ctx.o.intMinRecent || baseW.load<ctx.o.intMinBase) return null;
      var sR=rec.hardLoad/rec.load, sB=baseW.hardLoad/baseW.load;
      return { fired: sR>=ctx.o.intShareFire && sR>=Math.max(sB*ctx.o.intShareLift, sB+0.15),
               value: pctTxt(sR)+' of load from hard sessions vs '+pctTxt(sB)+' typical' };
    } },
  { id:'monotony', name:'No easy days / no rest',
    desc:'day-after-day loading with little variation or rest',
    detect:function(ctx){
      var s=winStats(ctx.days, ctx.endIdx-ctx.o.monoWinDays+1, ctx.endIdx);
      if(s.n<ctx.o.monoWinDays || s.load/s.n<0.5) return null;
      var m=mean(s.vals), dev=sd(s.vals);
      var mono=(dev!=null&&dev>0)?m/dev:null;
      var streak=0,best=0;
      for(var i=ctx.endIdx-ctx.o.monoWinDays+1;i<=ctx.endIdx;i++){ if(ctx.days[i].ran){streak++; if(streak>best)best=streak;} else streak=0; }
      var monoHit=mono!=null&&mono>=ctx.o.monoFire&&s.runDays>=ctx.o.monoMinRunDays;
      var streakHit=best>=ctx.o.streakFire;
      var bits=[];
      if(mono!=null) bits.push('monotony '+mono.toFixed(1));
      bits.push(best+'-day run streak'); bits.push(s.runDays+'/'+ctx.o.monoWinDays+' days run');
      return {fired:monoHit||streakHit, value:bits.join(' · ')};
    } },
  { id:'downhill', name:'Downhill volume spike',
    desc:'descent in the window far above your typical amount',
    detect:function(ctx){
      if(!ctx.prepd.anyDesc) return null;
      var base=[];
      for(var i=0;i<ctx.weeks.length-2;i++){ var w=ctx.weeks[i]; if(w) base.push(w.descentM); }
      if(base.length<4) return null;
      var typWk=median(base);
      var rec=ctx.acute.descentM;
      var fired = rec>=ctx.o.descMinM && typWk>=0 && rec>=ctx.o.descRatio*(2*typWk+1);
      return {fired:fired, value:Math.round(rec*3.28084)+' ft of descent in '+ctx.o.acuteWinDays+' days vs ~'+Math.round(2*typWk*3.28084)+' ft typical'};
    } }
];

/* Evaluate every detector at one end date. Returns null when the date has too
   little history before it (or is outside the data), else {ts, flags, firedIds}. */
function evaluateAt(prepd, ts, o){
  var k=dayFloor(ts), days=prepd.days;
  var endIdx=prepd.idx[k];
  if(endIdx==null){
    // an event logged up to a week past the last run day still gets analyzed on the data edge
    if(k>days[days.length-1].ts && k-days[days.length-1].ts<=7*DAY) endIdx=days.length-1;
    else return null;
  }
  if(endIdx<o.minLeadDays) return null;
  var ctx={ days:days, endIdx:endIdx, prepd:prepd, o:o,
            weeks:weeksEnding(days,endIdx,12),
            acute:winStats(days,endIdx-o.acuteWinDays+1,endIdx) };
  var flags=[], firedIds=[];
  PATTERNS.forEach(function(p){
    var r=p.detect(ctx);
    if(!r) return;
    flags.push({id:p.id,name:p.name,fired:!!r.fired,value:r.value});
    if(r.fired) firedIds.push(p.id);
  });
  return {ts:days[endIdx].ts, flags:flags, firedIds:firedIds};
}

/* ---------- unplanned volume drops ---------- */
function detectDrops(prepd, o){
  var days=prepd.days, last=days.length-1;
  var wks=[];
  for(var i1=last; i1-6>=0; i1-=7) wks.unshift({i0:i1-6,i1:i1,load:winStats(days,i1-6,i1).load});
  var out=[], i=4;
  while(i<wks.length){
    var base=(wks[i-1].load+wks[i-2].load+wks[i-3].load+wks[i-4].load)/4;
    if(base>=o.dropMinBase && wks[i].load<=o.dropStart*base){
      var j=i, lows=[wks[i].load];
      while(j+1<wks.length && (j-i+1)<o.dropMaxWeeks && wks[j+1].load<=o.dropCont*base){ j++; lows.push(wks[j].load); }
      out.push({ t0:days[wks[i].i0].ts, t1:days[wks[j].i1].ts, weeks:j-i+1,
                 capped:(j-i+1)>=o.dropMaxWeeks,
                 pct:1-mean(lows)/base, ongoing:wks[j].i1>=last-3 });
      i=j+1;
    } else i++;
  }
  return out;
}

/* ---------- the full analysis ---------- */
function analyze(runs, events, params, opts){
  var o=Object.assign({}, OPTS, opts||{});
  if(!window.RunLoad || !runs || !runs.length) return {ok:false, reason:'no-data'};
  var prepd=prep(runs, params, o);
  if(!prepd || prepd.days.length<o.minHistoryDays) return {ok:false, reason:'history', days:prepd?prepd.days.length:0};
  var days=prepd.days;
  var evs=(events||[]).filter(function(e){return e&&e.ts!=null;});
  var injuries=evs.filter(function(e){return e.type==='injury';}).sort(function(a,b){return a.ts-b.ts;});
  var raceTs=evs.filter(function(e){return e.type==='race';}).map(function(e){return dayFloor(e.ts);})
    .concat(prepd.hardDays);

  // drops + planned/explained classification
  var drops=detectDrops(prepd,o).map(function(d){
    var why=null;
    if(injuries.some(function(e){ var t=dayFloor(e.ts); return t>=d.t0-o.injExplainPre*DAY && t<=d.t1+o.injExplainPost*DAY; }))
      why='follows a logged injury';
    if(!why && raceTs.some(function(t){ return t>=d.t0-o.raceExplainDays*DAY && t<=d.t1+o.raceExplainDays*DAY; }))
      why='around a race / max effort — taper or recovery';
    d.explained=!!why; d.why=why;
    if(!d.explained){
      var ev=evaluateAt(prepd, d.t0-DAY, o);   // the training BEFORE the drop began
      d.flags=ev?ev.flags:[]; d.firedIds=ev?ev.firedIds:[];
    }
    return d;
  });
  var openDrops=drops.filter(function(d){return !d.explained;});

  // case windows: one per logged injury
  var cases=injuries.map(function(e){
    var ev=evaluateAt(prepd, e.ts, o);
    return {event:e, ok:!!ev, flags:ev?ev.flags:[], firedIds:ev?ev.firedIds:[]};
  });
  var evalCases=cases.filter(function(c){return c.ok;});

  // control windows: every ctrlStepDays across the history, away from
  // injuries and unexplained drops
  var excl=[];
  injuries.forEach(function(e){ var t=dayFloor(e.ts); excl.push([t-o.ctrlExclPreInj*DAY, t+o.ctrlExclPostInj*DAY]); });
  openDrops.forEach(function(d){ excl.push([d.t0-o.ctrlExclDropPre*DAY, d.t1+o.ctrlExclDropPost*DAY]); });
  var controls=[];
  for(var i=o.minLeadDays; i<days.length; i+=o.ctrlStepDays){
    var t=days[i].ts;
    if(excl.some(function(x){return t>=x[0]&&t<=x[1];})) continue;
    var ev=evaluateAt(prepd, t, o);
    if(ev) controls.push(ev);
  }

  // per-pattern case-vs-control report
  var patterns=PATTERNS.map(function(p){
    var cs=evalCases.map(function(c){return c.flags.find(function(f){return f.id===p.id;});}).filter(Boolean);
    var ct=controls.map(function(c){return c.flags.find(function(f){return f.id===p.id;});}).filter(Boolean);
    var injHits=cs.filter(function(f){return f.fired;}).length;
    var ctrlHits=ct.filter(function(f){return f.fired;}).length;
    var ctrlRate=ct.length?ctrlHits/ct.length:null;
    var lift=null;
    if(cs.length&&ct.length) lift=(injHits/cs.length)/Math.max(ctrlHits/ct.length, 0.5/ct.length);
    return { id:p.id, name:p.name, desc:p.desc,
             injHits:injHits, injEval:cs.length, ctrlRate:ctrlRate, ctrlEval:ct.length,
             lift:lift, lowConf:ct.length<o.lowConfCtrls };
  }).filter(function(p){return p.injEval>0;})
    .sort(function(a,b){ return (b.injHits/b.injEval)-(a.injHits/a.injEval) || (b.lift||0)-(a.lift||0); });

  // combinations: flag pairs that co-fired before injuries, with control base rates
  var pairCount={};
  evalCases.forEach(function(c){
    for(var a=0;a<c.firedIds.length;a++) for(var b=a+1;b<c.firedIds.length;b++){
      var k=[c.firedIds[a],c.firedIds[b]].sort().join('+');
      pairCount[k]=(pairCount[k]||0)+1;
    }
  });
  var nameOf={}; PATTERNS.forEach(function(p){nameOf[p.id]=p.name;});
  var combos=Object.keys(pairCount).map(function(k){
    var ids=k.split('+');
    var ctrlHits=controls.filter(function(c){ return ids.every(function(id){return c.firedIds.indexOf(id)>=0;}); }).length;
    return { ids:ids, names:ids.map(function(id){return nameOf[id];}),
             injHits:pairCount[k], injEval:evalCases.length,
             ctrlRate:controls.length?ctrlHits/controls.length:null,
             lift:(evalCases.length&&controls.length)?(pairCount[k]/evalCases.length)/Math.max(ctrlHits/controls.length,0.5/controls.length):null };
  }).sort(function(a,b){return b.injHits-a.injHits||(b.lift||0)-(a.lift||0);});

  return { ok:true,
    meta:{ nInjuries:injuries.length, nEval:evalCases.length, nControls:controls.length,
           acuteWinDays:o.acuteWinDays, historyDays:days.length, t0:days[0].ts, t1:days[days.length-1].ts },
    injuries:cases, patterns:patterns, combos:combos, drops:drops };
}

window.InjuryPatterns = { analyze:analyze, PATTERNS:PATTERNS, OPTS:OPTS };

})();
