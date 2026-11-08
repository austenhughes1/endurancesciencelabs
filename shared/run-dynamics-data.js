// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-data.js
//
// The data side of the Training Analysis view (window.RunData). The view,
// shared/run-dynamics.js, renders; everything here decides a number, reads
// a file, or reads and writes Firestore:
//   - formats and small parsers (dates are local days, paces m:ss)
//   - the FIT and .zip import (COROS export, Garmin account export)
//   - stored runs: load, upload with dedupe, delete all
//   - profile saves: one key (verified, rolled back on failure) or one list
//     (transactional, queued per field)
//   - per-run notes: Lever marks and detection, exclusions, bad-run flags
//   - load parameters, events, dismissed gaps, Strava sync, the per-athlete cache
//   - the Today card's numbers (heroModel), frozen by owner decision
// One athlete at a time: open() starts a mount (see "the athlete on screen").
// Pinned by shared/run-dynamics-data.test.js and the archive, format and
// Garmin suites. Node can require() it for tests.
//
// Depends on window.RunLoad (shared/run-load-model.js). Load order on a
// host page: run-load-model.js, injury-patterns.js, device-matrix.js,
// run-dynamics-data.js, run-dynamics.js.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

/* ---------- the athlete on screen ----------
   One athlete at a time, like the view. open() starts a new mount: it bumps the generation (S.gen),
   so async loads and late save results for the previous athlete are dropped instead of landing in
   this one's state, and resets the per-mount state. The write queue (listQ) and the cache are keyed
   by uid and survive mounts: a write still in flight for athlete A finishes against A's doc.
   hooks.notify(msg, {kind, undo}) reports saves (the view's toast); hooks.onRevert(key, isList)
   re-renders after a failed write put one profile key back. */
var S={ db:null, uid:null, gen:0, profile:{}, profileErr:null, saveSeq:{}, stravaLever:[], sync:{}, listQ:{}, cache:{}, hooks:{} };
function open(o){
  S.db=o.db; S.uid=o.uid; S.gen++;
  S.profile={}; S.profileErr=null; S.saveSeq={}; S.stravaLever=[]; S.sync={};
  S.hooks={ notify:o.notify||null, onRevert:o.onRevert||null };
  return S.gen;
}
function notify(msg, o){ if(S.hooks.notify) S.hooks.notify(msg, o); }

var DAY=864e5;
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// What's-included defaults: the header names any control that differs ("Filtered: …") with a Reset.
var FILTER_DEFAULTS={intensity:'all',cutoff:'6:40',mindist:'0.5'};
// Injuries and illnesses (incl. non-running injuries) can't be dated ahead; races and planned breaks can.
var EV_NO_FUTURE={injury:1, illness:1, nonrun:1};

/* ---------- Formats and small parsers (also used by the view) ---------- */
function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function num(v){
  if(v==null) return null;
  v=String(v).replace(/[",]/g,'').trim();
  if(v===''||v==='--') return null;
  var f=parseFloat(v); return isNaN(f)?null:f;
}
function hmsToSec(v){
  if(v==null) return null;
  v=String(v).replace(/"/g,'').trim();
  if(v===''||v.indexOf('--')===0) return null;
  var p=v.split(':').map(parseFloat);
  if(p.some(isNaN)) return null;
  if(p.length===3) return p[0]*3600+p[1]*60+p[2];
  if(p.length===2) return p[0]*60+p[1];
  return p[0];
}
function parseDate(v){
  if(!v) return null;
  v=String(v).trim();
  // Bare dates (from <input type="date">) parse as UTC midnight per spec, which lands on the
  // previous local evening west of UTC — parse them as LOCAL midnight so day math stays local.
  var m=v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  var d=new Date(v.replace(' ','T'));
  return isNaN(d)?null:d;
}
// Local calendar date — toISOString() would shift evening runs (and their day keys) to the
// next UTC day for athletes west of UTC.
function ymd(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
// Inclusive end bound for a date-input "To" value: the whole local day, not its midnight.
function dayEnd(d){ var e=new Date(d); e.setHours(23,59,59,999); return e; }
function fmtPace(s){ if(s==null) return '–'; var t=Math.round(s), mm=Math.floor(t/60), ss=t%60; return mm+':'+String(ss).padStart(2,'0'); }
function fmtDur(s){ var t=Math.round(s/60), h=Math.floor(t/60), mm=t%60; return h>0?h+'h '+mm+'m':mm+'m'; }
// User-facing dates (ISO stays in date inputs only): "Aug 10, 2025"; a span drops what its ends
// share — "Aug 10 – 28, 2025", "Mar 3 – Apr 20, 2026", "Dec 25, 2025 – Jan 3, 2026".
function fmtDay(ts){ var d=new Date(ts); return MONTHS[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear(); }
function fmtSpan(t0,t1){
  if(t1==null) return fmtDay(t0);
  var a=new Date(t0), b=new Date(t1);
  if(ymd(a)===ymd(b)) return fmtDay(t0);
  if(a.getFullYear()!==b.getFullYear()) return fmtDay(t0)+' – '+fmtDay(t1);
  return MONTHS[a.getMonth()]+' '+a.getDate()+' – '+(a.getMonth()===b.getMonth()?'':MONTHS[b.getMonth()]+' ')+b.getDate()+', '+b.getFullYear();
}
// "Oct 9", with the year only when it isn't this one.
function fmtMD(ts){ var d=new Date(ts); return MONTHS[d.getMonth()]+' '+d.getDate()+(d.getFullYear()===new Date().getFullYear()?'':', '+d.getFullYear()); }
function fmtClock(ts){ var d=new Date(ts), h=d.getHours(); return (h%12||12)+':'+('0'+d.getMinutes()).slice(-2)+(h<12?' AM':' PM'); }
function daysAgo(ts){ var a=new Date(ts), b=new Date(); a.setHours(0,0,0,0); b.setHours(0,0,0,0); return Math.round((b-a)/DAY); }   // calendar days; round absorbs DST
// Freshness wording: "today 6:15 AM" / "yesterday" / "5 days ago (Oct 9)".
function fmtRel(ts){ var n=daysAgo(ts); return n<0?'in '+(-n)+' day'+(n===-1?'':'s')+' ('+fmtMD(ts)+') — check the watch clock':n===0?'today '+fmtClock(ts):n===1?'yesterday':n+' days ago ('+fmtMD(ts)+')'; }
// Key-order-insensitive JSON for the read-back check: Firestore hands maps back with keys in its
// own order, so a plain stringify of an array of maps (events, marks) reads a good write as lost.
function canonJSON(v){
  if(Array.isArray(v)) return '['+v.map(canonJSON).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).filter(function(k){ return v[k]!==undefined; }).sort().map(function(k){ return JSON.stringify(k)+':'+canonJSON(v[k]); }).join(',')+'}';
  return JSON.stringify(v);
}

/* ---------- FIT and .zip import ---------- */
/* ---------- Coros / Garmin .fit / .zip parsing ----------
   Coros Connect exports a .zip of per-activity binary .fit files. A Garmin
   account export keeps its .fit files in zips inside the .zip
   (fitArchiveRuns opens those too); Garmin's files carry the same session
   fields, mapped the same way as the server's Garmin sync (garmin-lib.js).
   Every running-dynamics metric lives in standard FIT `session` fields
   (verified against a real Coros export — no developer/custom fields), so
   each session maps onto the run-doc shape stored in garminActivities and
   flows through the backfill/dedup path. FIT units differ from the stored
   doc: cadence is per-leg (×2), oscillation is mm (÷10 → cm), step length is
   mm (÷1000 → m). The two parser libs are loaded from CDN
   on demand the first time a .zip/.fit is dropped — nothing is added to
   the host pages, keeping this the one self-contained module. */
var _fitLibs=null;
function loadFitLibs(){
  if(_fitLibs) return _fitLibs;
  _fitLibs=new Promise(function(resolve,reject){
    if(window.JSZip){ importFitParser(resolve,reject); return; }
    var s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.onload=function(){ importFitParser(resolve,reject); };
    s.onerror=function(){ reject(new Error('Could not load the unzip library (check your connection).')); };
    document.head.appendChild(s);
  });
  return _fitLibs;
}
function importFitParser(resolve,reject){
  import('https://cdn.jsdelivr.net/npm/fit-file-parser@3.0.2/+esm')
    .then(function(mod){ resolve({ JSZip:window.JSZip, FitParser:(mod&&mod.default)||mod }); })
    .catch(function(){ reject(new Error('Could not load the .fit parser (check your connection).')); });
}
function fitNum(v){ return (typeof v==='number'&&isFinite(v))?v:null; }
// Running-form fields (GCT, oscillation, ratio, balance, stride, cadence) can
// never legitimately be 0. Coros writes a literal 0 (not a blank) on runs
// recorded WITHOUT a running-dynamics pod/strap. A stored
// 0 GCT later divides into the load model → Infinity, so treat 0 as "absent".
function fitPos(v){ return (typeof v==='number'&&isFinite(v)&&v>0)?v:null; }
/* One FIT `session` message -> one candidate run doc. */
function runFromFitSession(s){
  if(!s||!s.start_time) return null;
  var sport=String(s.sport||'').toLowerCase();
  if(!/run/.test(sport)) return null;                     // runs only: a session with no sport (e.g. one Garmin Connect made) may be anything
  var start=new Date(s.start_time);
  if(isNaN(start)) return null;
  var sportType=s.sport?(s.sport.charAt(0).toUpperCase()+s.sport.slice(1)):'Running';
  // Indoor sessions are sport 'running' + sub_sport treadmill / indoor_running / virtual_activity:
  // type them 'Treadmill Running' like the Strava and Garmin Connect docs, so the treadmill rules (no
  // hill surcharge, Lever detection, Mark Lever runs) apply. The id keeps the sport-only suffix,
  // so a re-import overwrites the docs stored before this mapping instead of duplicating them.
  var type=/treadmill|indoor|virtual/.test(String(s.sub_sport||'').toLowerCase())?'Treadmill Running':sportType;
  var id=start.toISOString().replace(/\D/g,'').slice(0,14)+'_'+norm(sportType);
  var distM=fitPos(s.total_distance);
  var spd=fitPos(s.avg_speed!=null?s.avg_speed:s.enhanced_avg_speed);
  var cadHalf=fitPos(s.avg_running_cadence!=null?s.avg_running_cadence:s.avg_cadence);
  var frac=fitNum(s.avg_fractional_cadence)||0;
  var voMm=fitPos(s.avg_vertical_oscillation);             // FIT: mm (0 = sensor absent)
  var stepMm=fitPos(s.avg_step_length);                    // FIT: mm (0 = sensor absent)
  var vr=fitPos(s.avg_vertical_ratio);
  if(vr==null && voMm!=null && stepMm) vr=voMm/stepMm*100; // derive when absent
  return {
    id:id, type:type, title:'', leverTitle:false,
    ts:start.getTime(), dateISO:start.toISOString(),
    distMi: distM==null?null:distM/1609.34,
    durSec: fitPos(s.total_timer_time!=null?s.total_timer_time:s.total_elapsed_time),
    avgHr:fitPos(s.avg_heart_rate), maxHr:fitPos(s.max_heart_rate),
    aerobicTE:fitNum(s.total_training_effect),                 // 0 = valid "no training effect"
    cadence: cadHalf==null?null:Math.round((cadHalf+frac)*2), // per-leg -> spm
    stride: stepMm==null?null:stepMm/1000,                     // mm -> m
    vratio: vr,
    vo: voMm==null?null:voMm/10,                               // mm -> cm
    gct: fitPos(s.avg_stance_time), gctBalL: fitPos(s.avg_stance_time_balance),
    paceSec: spd?1609.34/spd:null, gapSec:null,
    ascentM:fitNum(s.total_ascent), descentM:fitNum(s.total_descent), steps:fitPos(s.total_strides), // 0 ascent/descent = valid flat run
  };
}
/* Parse one .fit ArrayBuffer -> run candidates (one per running session). */
function parseFitBuffer(FitParser, buf){
  return new Promise(function(resolve){
    var fp=new FitParser({ force:true, mode:'list', speedUnit:'m/s', lengthUnit:'m' });
    fp.parse(buf, function(err,data){
      if(err||!data){ resolve([]); return; }
      var sessions=data.sessions||[];
      resolve(sessions.map(runFromFitSession).filter(Boolean));
    });
  });
}
/* The type in a FIT file's file_id message (4 = activity), or null when it can't be told from the
   first few messages. Read without parsing the file, so the thousands of watch-sync files in a
   Garmin account export (monitoring, metrics) are skipped cheaply. */
function fitFileType(buf){
  var b=new Uint8Array(buf), p=b[0], defs={}, i;
  if(b.length<14 || String.fromCharCode(b[8],b[9],b[10],b[11])!=='.FIT') return null;
  for(var m=0; m<8 && p<b.length; m++){
    var h=b[p++];
    if(h&0x80) return null;                                  // compressed timestamp header: give up
    if(h&0x40){                                              // definition message
      var n=b[p+4], f=[], dev=0;
      var g=b[p+1]===1 ? (b[p+2]<<8|b[p+3]) : (b[p+3]<<8|b[p+2]);
      p+=5;
      for(i=0;i<n;i++) f.push([b[p+3*i], b[p+3*i+1]]);
      p+=3*n;
      if(h&0x20){ var nd=b[p++]; for(i=0;i<nd;i++) dev+=b[p+3*i+1]; p+=3*nd; }
      defs[h&0x0F]={g:g, f:f, dev:dev};
    } else {                                                 // data message
      var d=defs[h&0x0F];
      if(!d) return null;
      for(var off=0, j=0; j<d.f.length; j++){
        if(d.g===0 && d.f[j][0]===0){ var v=b[p+off]; return v==null?null:v; }
        off+=d.f[j][1];
      }
      if(d.g===0) return null;
      p+=off+d.dev;
    }
  }
  return null;
}
/* Every run in the .fit files of a .zip: those in the .zip itself (COROS) and those in the zips
   inside it (a Garmin account export keeps its activity files in zips within the export). The
   inner zips are opened one after another, so only one is held in memory. parseFit(buf) resolves
   to one file's runs; onProgress(done, total, part, parts) counts files within a part, part 0
   being the .zip's own files and parts the number of inner zips. */
function fitArchiveRuns(JSZip, parseFit, arrayBuffer, onProgress){
  var runs=[], found=0;
  function entries(zip, re){ var e=[]; zip.forEach(function(path,entry){ if(!entry.dir && re.test(path)) e.push(entry); }); return e; }
  function readFits(zip, part, parts){
    var fits=entries(zip, /\.fit$/i), done=0;
    found+=fits.length;
    return fits.reduce(function(chain, entry){
      return chain.then(function(){ return entry.async('arraybuffer'); }).then(parseFit).then(function(r){
        runs=runs.concat(r);
        done++; if(onProgress) onProgress(done, fits.length, part, parts);
      });
    }, Promise.resolve());
  }
  return JSZip.loadAsync(arrayBuffer).then(function(zip){
    var inner=entries(zip, /\.zip$/i);
    return inner.reduce(function(chain, entry, i){
      return chain.then(function(){ return entry.async('arraybuffer'); })
        .then(function(ab){ return JSZip.loadAsync(ab); })
        .then(function(z){ return readFits(z, i+1, inner.length); });
    }, readFits(zip, 0, inner.length));
  }).then(function(){
    if(!found) throw new Error('No .fit files found inside the .zip.');
    return runs;
  });
}
/* Parse a COROS .zip, a Garmin account export (.zip) or a bare .fit into deduped run candidates. */
function parseCorosArchive(arrayBuffer, fileName, onProgress){
  return loadFitLibs().then(function(L){
    var lower=String(fileName||'').toLowerCase();
    if(/\.fit$/.test(lower)) return parseFitBuffer(L.FitParser, arrayBuffer);
    return fitArchiveRuns(L.JSZip, function(buf){
      var type=fitFileType(buf);
      return type!=null && type!==4 ? Promise.resolve([]) : parseFitBuffer(L.FitParser, buf);   // only activity files hold runs
    }, arrayBuffer, onProgress);
  }).then(function(list){
    var byId={}; list.forEach(function(c){ byId[c.id]=c; });   // dedup within the archive
    return Object.keys(byId).map(function(k){return byId[k];});
  });
}
// A .zip/.fit read failure in words the athlete can act on (the raw JSZip/parser text stays in the console).
function corosErrMsg(e){
  var m=String(e&&e.message||'');
  if(/central directory|zip file|Corrupted zip|End of data/i.test(m)) return 'That .zip couldn’t be opened — download it again from the Garmin or COROS email.';
  if(m==='No .fit files found inside the .zip.') return 'No .fit files found inside the .zip. Use the .zip from Garmin’s Export Your Data email, or a COROS export saved as .FIT.';
  return m||'Could not read this file.';
}

/* ---------- Stored runs: load, upload, delete ---------- */
function actCol(){ return S.db.collection('users').doc(S.uid).collection('garminActivities'); }
function docToRun(d){ var o=Object.assign({},d); o.date=new Date(d.ts); return o; }
function fetchRuns(){
  var my=S.gen;
  return actCol().get().then(function(snap){
    if(my!==S.gen) return null;   // a newer mount's athlete is on screen now
    var runs=[]; snap.forEach(function(doc){ runs.push(docToRun(doc.data())); });
    runs.sort(function(a,b){ return a.ts-b.ts; });
    return runs;
  });
}
// Same run recorded twice (watch file + Strava): the start→end spans overlap, with a minute of slack
// for clock skew. Two runs on one day (a double) don't overlap, so both are kept.
// Mirrors sameRunSpan in functions/index.js.
function sameRunSpan(aTs,aDur,bTs,bDur){ var slack=60000; return aTs<=bTs+(bDur||0)*1000+slack && bTs<=aTs+(aDur||0)*1000+slack; }
function backfill(candidates){
  return actCol().get().then(function(snap){
    var candIds=new Set(candidates.map(function(c){return c.id;}));
    var existing=new Set(), replace=[], near=[], garmin=[];
    snap.forEach(function(d){
      existing.add(d.id);
      var x=d.data();
      // watch-sourced docs by start time: a run stored under another id scheme (the old Activities.csv
      // importer used local start digits) is the same run when it starts within 60 s (never re-ids)
      if(x.source!=='strava' && x.source!=='garmin'){ var t=x.ts&&x.ts.toMillis?x.ts.toMillis():+x.ts; if(isFinite(t)) near.push(t); }
      // A watch export is the richer record (GCT, oscillation, descent) — drop
      // any Strava-synced doc for a run this import now covers (overlapping
      // span; a second run that day stays). Same-id docs need no delete: the
      // set() below overwrites them wholesale. The server sync skips runs a
      // device doc covers, so these never come back.
      if(x.source==='strava' && !candIds.has(d.id)){ var st=x.ts&&x.ts.toMillis?x.ts.toMillis():+x.ts;
        if(isFinite(st) && candidates.some(function(c){ return sameRunSpan(c.ts,c.durSec,st,x.durSec); })) replace.push(d.ref); }
      if(x.source==='garmin' && !candIds.has(d.id)){ var gt=x.ts&&x.ts.toMillis?x.ts.toMillis():+x.ts; if(isFinite(gt)) garmin.push({ref:d.ref, id:d.id, ts:gt, durSec:x.durSec}); }
    });
    var dupes=0, fresh=candidates.filter(function(c){
      if(existing.has(c.id)) return true;
      if(near.some(function(t){ return Math.abs(t-c.ts)<=60000; })){ dupes++; return false; }   // near-duplicate: no write
      return true;
    });
    // The athlete's own upload wins over the copy of a run Garmin Connect sent: the upload is stored and
    // the Garmin copy deleted (the server never writes it again while an upload holds the run), so
    // disconnecting Garmin, which deletes what Garmin sent, leaves the upload. Lever marks and exclusions
    // made on the Garmin copy move to the upload's run.
    var moved=new Map();
    garmin.forEach(function(g){
      var c=fresh.filter(function(f){ return sameRunSpan(f.ts,f.durSec,g.ts,g.durSec); })[0];
      if(c){ replace.push(g.ref); moved.set(g.id, c.id); }
    });
    var added=0; fresh.forEach(function(c){ if(!existing.has(c.id)) added++; });
    var ops=fresh.slice();
    replace.forEach(function(ref){ ops.push({del:ref}); });
    var chunks=[]; for(var i=0;i<ops.length;i+=450) chunks.push(ops.slice(i,i+450));
    var p=Promise.resolve();
    chunks.forEach(function(chunk){
      p=p.then(function(){
        var batch=S.db.batch();
        chunk.forEach(function(op){ if(op.del) batch.delete(op.del); else batch.set(actCol().doc(op.id), op); });
        return batch.commit();
      });
    });
    return p.then(function(){ return moveRunNotes(moved); }).then(function(){
      return {added:added, updated:fresh.length-added, replaced:replace.length-moved.size, replacedGarmin:moved.size, dupes:dupes};
    });
  });
}
// Lever marks and exclusions on runs that are now stored under another id (moved: old id → new id).
// One already on the new id wins. A failed save is left alone: the old entry still applies through
// the start-time match until it is saved again.
function moveRunNotes(moved){
  if(!moved.size) return Promise.resolve();
  var move=function(list){
    var ids=new Set(list.map(function(m){ return m&&String(m.id); }));
    return list.filter(function(m){ return !(m && moved.has(String(m.id)) && ids.has(moved.get(String(m.id)))); })
      .map(function(m){ return m && moved.has(String(m.id)) ? Object.assign({}, m, {id:moved.get(String(m.id))}) : m; });
  };
  return Promise.all(['runLeverMarks','runExcluded'].map(function(k){ return updateProfileList(k, move, null, false); }));
}
/* Delete every stored activity doc. Escape hatch for a bad import: backfill
   upserts by start-time id, so a mislabeled activity that was re-exported
   under the same id can never be fixed by re-uploading — wipe and re-import
   is the only clean path. Profile, races/injuries live on the user doc and
   are untouched. Resolves with the number of docs deleted. */
function deleteAllRuns(){
  delete S.cache[S.uid];
  return actCol().get().then(function(snap){
    var refs=[]; snap.forEach(function(d){ refs.push(d.ref); });
    var chunks=[]; for(var i=0;i<refs.length;i+=450) chunks.push(refs.slice(i,i+450));
    var p=Promise.resolve();
    chunks.forEach(function(chunk){
      p=p.then(function(){
        var batch=S.db.batch();
        chunk.forEach(function(ref){ batch.delete(ref); });
        return batch.commit();
      });
    });
    return p.then(function(){ return refs.length; });
  });
}

/* ---------- Profile: load and save, one key or one list at a time ---------- */
// A failed profile read leaves S.profile on defaults — writing from it would overwrite the
// stored values (runEvents wholesale) with what the view never saw. Returns the block reason.
function profileBlocked(){ return S.profileErr ? 'profile didn’t load — reload the page' : null; }
// Applies the patch locally at once, then persists it. Resolves true once the read-back matches,
// else a short reason string. Reports through the toast: okMsg (default "Saved") on success —
// okMsg===false keeps it quiet — and the error on failure. Callers use persist(), which also
// rolls the view back when a write fails.
function saveProfile(patch, okMsg){
  Object.assign(S.profile, patch);
  var my=S.gen, uid=S.uid, show=function(r){ if(my!==S.gen) return r;
    if(r!==true) notify('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    else if(okMsg!==false) notify(okMsg||'Saved');
    return r; };
  if(!uid) return Promise.resolve(show('no athlete'));
  var blocked=profileBlocked(); if(blocked) return Promise.resolve(show(blocked));
  var ref=S.db.collection('users').doc(uid), key=Object.keys(patch)[0];
  return ref.set(patch,{merge:true})
    .then(function(){ return ref.get(); })
    // a newer save of the same key (quick successive clicks) may land before this read-back
    .then(function(d){ var data=d.data()||{}, got=canonJSON(data[key]); var ok=got===canonJSON(patch[key])||got===canonJSON(S.profile[key]);
      if(!ok) console.warn('RunDynamics: profile did not persist',{uid:uid,key:key,got:data[key],sent:patch[key]});
      return show(ok||'wrote but not stored'); })
    .catch(function(e){ console.error('profile save',e); return show((e&&e.code)||'save failed'); });
}
// saveProfile + rollback: a failed write puts back its own key — unless a newer persist() of the key
// was issued or the local value moved on (that change owns the field and reports for itself).
function persist(patch, okMsg){
  var key=Object.keys(patch)[0], n=S.saveSeq[key]=(S.saveSeq[key]||0)+1, sent=canonJSON(patch[key]), prev=S.profile[key], my=S.gen;
  return saveProfile(patch, okMsg).then(function(r){
    if(r!==true) revertKey(key, prev, function(){ return my===S.gen && S.saveSeq[key]===n && canonJSON(S.profile[key])===sent; });
    return r;
  });
}
// Roll ONE profile key back to its stored value, or to prev (its value before the failed write) when the
// doc can't be read either. Never a whole-profile reload: that would drop other keys' in-flight saves
// from the view, and offline — where the read fails too — wipe the view and block every later write.
// mine() is re-checked once the read is back.
function revertKey(key, prev, mine){
  var my=S.gen, uid=S.uid;
  if(!uid || !mine()) return Promise.resolve();
  return S.db.collection('users').doc(uid).get().then(function(d){ return (d.exists?d.data()||{}:{})[key]; }, function(){ return prev; }).then(function(v){
    if(my!==S.gen || !mine()) return;
    var list=/^run(Events|DismissedDrops|LeverMarks|Excluded)$/.test(key);
    S.profile[key]=(list&&!Array.isArray(v))?[]:v;   // list fields stay arrays, as loadProfile keeps them
    if(S.hooks.onRevert) S.hooks.onRevert(key, list);
  });
}
// Read-modify-write of one array field on the user doc (runDismissedDrops, runLeverMarks): fn(list)
// → new list runs on the STORED copy inside a transaction, so a stale tab or another device can't
// have its entries overwritten by this tab's old snapshot. fn is applied locally first (the view
// updates at once); once stored, the stored result becomes the local copy and rerender() runs if
// it differs (another session's entries merged in). One tab's writes to a field run in order, each
// on the result of the last. Resolves true, or a short failure reason (the local change stays).
// Toasts okMsg (default "Saved") or the error; okMsg===false = the caller reports both itself.
function updateProfileList(key, fn, rerender, okMsg){
  var cur=function(x){ return Array.isArray(x)?x.slice():[]; };
  S.profile[key]=fn(cur(S.profile[key]));
  var my=S.gen, uid=S.uid, fail=function(r){ if(my===S.gen && okMsg!==false) notify('Couldn’t save ('+r+').',{kind:'err'}); return r; };
  if(!uid) return Promise.resolve(fail('no athlete'));
  var blocked=profileBlocked(); if(blocked) return Promise.resolve(fail(blocked));
  var ref=S.db.collection('users').doc(uid), q=S.listQ[uid+'/'+key]||(S.listQ[uid+'/'+key]={tail:Promise.resolve(),n:0}), n=++q.n, out;
  var run=function(){ return S.db.runTransaction(function(tx){
    return tx.get(ref).then(function(d){
      var stored=cur(d.exists?(d.data()||{})[key]:null), next=fn(stored.slice());
      return goneGarminRuns(tx, ref, key, stored, next).then(function(gone){
        var patch={}; out=patch[key]=gone.size?next.filter(function(m){ return !(m && gone.has(String(m.id))); }):next;
        tx.set(ref,patch,{merge:true});
      });
    });
  }); };
  var p=q.tail.then(run,run);
  q.tail=p.catch(function(){});
  return p.then(function(){
    if(my!==S.gen) return true;
    if(okMsg!==false) notify(okMsg||'Saved');
    if(n!==q.n) return true;   // a newer write to this field is queued: it adopts the stored copy
    var changed=canonJSON(out)!==canonJSON(S.profile[key]);
    S.profile[key]=out; if(changed && rerender) rerender();
    return true;
  }).catch(function(e){ console.error('profile save',e); return fail((e&&e.code)||'save failed'); });
}
// Lever marks and exclusions name runs by id. A new one for a run Garmin Connect sent is stored only
// while that run is: a view opened before Garmin was disconnected still lists the runs the disconnect
// deleted, and must not write them back onto the profile. Resolves with the ids of those gone.
function goneGarminRuns(tx, userRef, key, before, after){
  var gone=new Set();
  if(key!=='runLeverMarks' && key!=='runExcluded') return Promise.resolve(gone);
  var had=new Set(before.map(function(m){ return m&&String(m.id); })), ids=[];
  after.forEach(function(m){ var id=m&&m.id!=null?String(m.id):''; if(/^garmin_/.test(id) && !had.has(id) && ids.indexOf(id)<0) ids.push(id); });
  return Promise.all(ids.map(function(id){
    return tx.get(userRef.collection('garminActivities').doc(id)).then(function(r){ if(!r.exists) gone.add(id); });
  })).then(function(){ return gone; });
}
function loadProfile(){ if(!S.uid) return Promise.resolve(); var my=S.gen; return S.db.collection('users').doc(S.uid).get().then(function(d){ if(my!==S.gen) return; var x=d.exists?d.data():{}; S.profileErr=null; S.profile={ weightLb:x.weightLb, runDevice:x.runDevice, runHasAccessory:x.runHasAccessory, runLeverPctBW:x.runLeverPctBW, runEasyPaceSec:x.runEasyPaceSec, runEvents:Array.isArray(x.runEvents)?x.runEvents:[], runDismissedDrops:Array.isArray(x.runDismissedDrops)?x.runDismissedDrops:[], runLeverMarks:Array.isArray(x.runLeverMarks)?x.runLeverMarks:[], runExcluded:Array.isArray(x.runExcluded)?x.runExcluded:[], runIncluded:(x.runIncluded&&typeof x.runIncluded==='object')?x.runIncluded:null, runWorkoutPaceSec:x.runWorkoutPaceSec }; S.sync={ connected:!!x.stravaConnected, last:x.stravaLastSyncedAt||null }; }).catch(function(e){ if(my!==S.gen) return; console.error('profile load',e); S.profileErr=(e&&e.code)||'load failed'; S.profile={}; S.sync={}; }); }

/* ---------- Profile values ---------- */
function offloadFrac(){ var v=parseFloat(S.profile.runLeverPctBW); var pct=(v>0&&v<100)?v:85; return 1-pct/100; }
function leverPct(){ var v=parseFloat(S.profile.runLeverPctBW); return (v>0&&v<100)?v:85; }
// Runner-entered easy pace (s/mi, 240–1200) from the profile: the middle rung of the baseline
// chain calibrated median → recorded easy pace → neutral. Null when unset or out of range.
function easyPaceSec(){ var v=parseFloat(S.profile.runEasyPaceSec); return (v>=240&&v<=1200)?v:null; }
function weightKg(){ var lb=S.profile.weightLb; return lb ? lb*0.453592 : null; }
function deviceId(){ return S.profile.runDevice||''; }
function hasAccessory(){ return !!S.profile.runHasAccessory; }
// D4: What's included is saved per athlete on the user doc — users/{uid}.runIncluded =
// {off:[activity types left out], intensity, mindist} (types are stored as the ones turned OFF, so a
// new type from a later import is included) — and Workout pace is a Profile field
// (users/{uid}.runWorkoutPaceSec, the cutoff between easy runs and workouts; unset = 6:40).
function workoutPaceSec(){ var v=parseFloat(S.profile.runWorkoutPaceSec); return (v>=180&&v<=1200)?v:null; }
function includedPref(){
  var x=S.profile.runIncluded||{}, md=parseFloat(x.mindist);
  return { off:Array.isArray(x.off)?x.off.map(String):[], intensity:/^(all|workout|easy)$/.test(x.intensity)?x.intensity:FILTER_DEFAULTS.intensity,
    mindist:(md>=0&&md<=50)?String(x.mindist):FILTER_DEFAULTS.mindist };
}

/* ---------- Per-run notes: Lever runs, exclusions; run selection and load parameters ---------- */
// Strava titles only: athletes rename runs on Strava (never in Garmin), so a Strava activity whose
// name contains "lever" is a strong manual Lever flag. We pull ONLY the title from Strava and match
// it to the Garmin run by date (+distance); every metric still comes from Garmin.
function fetchStravaLever(){
  if(!S.uid) return Promise.resolve();
  var my=S.gen;
  return S.db.collection('trainingPlans').where('athleteUid','==',S.uid).limit(1).get().then(function(ps){
    if(my!==S.gen) return;
    if(ps.empty){ S.stravaLever=[]; return; }
    return S.db.collection('trainingPlans').doc(ps.docs[0].id).collection('stravaActivities').get().then(function(snap){
      if(my!==S.gen) return;
      var out=[]; snap.forEach(function(d){ var a=d.data(); if(a&&a.name&&/lever/i.test(a.name)&&a.date) out.push({ date:a.date, distMi:(a.distance||0)/1609.34 }); });
      S.stravaLever=out;
    });
  }).catch(function(){ if(my===S.gen) S.stravaLever=[]; });
}
function stravaLever(r){
  if(!S.stravaLever.length) return false;
  return S.stravaLever.some(function(s){ var n=Date.parse(s.date+'T12:00:00'); if(isNaN(n)) return false;
    if(Math.abs(r.ts-n) > 1.2*864e5) return false;
    if(r.distMi!=null && s.distMi>0 && Math.abs(s.distMi-r.distMi) > Math.max(0.2,0.05*r.distMi)) return false;
    return true; });
}
// Manual Lever marks: users/{uid}.runLeverMarks = [{id, lever:true, offload:0.01–0.95, ts, mi} |
// {id, lever:false, ts, mi}]. They live on the USER doc, never on activity docs — the importer and
// the daily Strava sync rewrite activity docs wholesale with set(). Run ids are stable across
// re-imports of the same source (UTC start digits + sport for FIT, local digits + type for Strava), so
// a mark survives a wipe + re-import. ts (start epoch) + mi (distance) are a fallback key for a run
// that comes back under a DIFFERENT id — a Coros FIT import (UTC-digit id) replacing the Strava doc
// it was marked on: a mark whose id no stored run has adopts the run starting within 30 min of it.
function leverMarkList(){ return (Array.isArray(S.profile.runLeverMarks)?S.profile.runLeverMarks:[]).filter(function(m){ return m&&m.id!=null; }); }
function markOffload(m){ var v=+m.offload; return (v>=0.01&&v<=0.95)?v:null; }
function orphanMark(r, orphans){
  var best=-1, bd=Infinity;
  orphans.forEach(function(m,i){
    var dt=Math.abs(m.ts-r.ts); if(!(dt<=18e5)) return;
    if(m.mi!=null && r.distMi!=null && Math.abs(m.mi-r.distMi)>Math.max(0.2,0.05*r.distMi)) return;
    if(dt<bd){ bd=dt; best=i; }
  });
  return best<0 ? null : orphans.splice(best,1)[0];
}
// A manual mark wins over everything, then title → Strava title → HR-for-pace detection; leverSrc
// records which one for the marking tool (r._mark = the mark applied, for re-marking). A marked
// Lever run carries its own offload (impactLoad prefers run.offload over the profile default); an
// explicit Not-Lever mark clears any offload; otherwise the doc's own value (captured once per
// loaded doc, normally null) stands.
function annotateLever(runs){
  var ids=RunLoad.detectLeverIds(runs), marks=new Map(), have=new Set(runs.map(function(r){ return r.id; })), orphans=[];
  leverMarkList().forEach(function(m){ if(have.has(m.id)) marks.set(m.id,m); else if(isFinite(m.ts)) orphans.push(m); });
  runs.forEach(function(r){
    if(!('_docOffload' in r)) r._docOffload=r.offload!=null?r.offload:null;
    var m=marks.get(r.id)||(orphans.length?orphanMark(r,orphans):null);
    r._mark=m;
    r.leverSrc = m ? (m.lever?'marked':'unmarked') : r.leverTitle ? 'title' : stravaLever(r) ? 'strava' : ids.has(r.id) ? 'auto' : null;
    r.lever = m ? !!m.lever : !!r.leverSrc;
    r.offload = m ? (m.lever?markOffload(m):null) : r._docOffload;
  });
}
function effType(r){ return r.lever ? 'Lever' : r.type; }
// D3 data hygiene: runs that can't be right (a GPS glitch, a wrong watch clock) are flagged in a
// one-line banner; nothing changes until someone presses Exclude. Exclusions live on the USER doc
// (users/{uid}.runExcluded = [{id, ts, at}], like Lever marks — activity docs get rewritten by the
// importer/sync); ts (start epoch) re-finds a run that came back under another id. An excluded run
// stays stored and listed in the banner, but analyzable() drops it from every load and metric.
function exclList(){ return (Array.isArray(S.profile.runExcluded)?S.profile.runExcluded:[]).filter(function(x){ return x&&x.id!=null; }); }
function runFlag(r){
  if(r.distMi>100) return 'over 100 mi';
  if(r.paceSec>0 && r.paceSec<210) return 'faster than 3:30 /mi';
  if(r.durSec>86400) return 'longer than 24 h';
  if(r.ts>dayEnd(new Date()).getTime()) return 'dated ahead';
  return null;
}
function annotateExcluded(runs){
  var ex=exclList(), ids=new Set(ex.map(function(x){ return String(x.id); }));
  runs.forEach(function(r){ r._excl=ids.has(String(r.id)) || ex.some(function(x){ return isFinite(x.ts) && Math.abs(x.ts-r.ts)<=6e4; }); });
}
function exclMatch(x,r){ return String(x.id)===String(r.id) || (isFinite(x.ts) && Math.abs(x.ts-r.ts)<=6e4); }
function filterIntensity(runs,mode,cutoffSec){
  if(mode==='workout') return runs.filter(function(r){return r.paceSec!=null && r.paceSec<cutoffSec;});
  if(mode==='easy') return runs.filter(function(r){return r.paceSec!=null && r.paceSec>=cutoffSec;});
  return runs;
}
// Baseline chain: the median of the athlete's own easy runs wins; a recorded easy pace from the
// profile fills in until there are runs to calibrate from; otherwise the pace term is neutral
// (no guessed constant). basePaceSource records which rung is in force for the hero tile.
function computeLoadParams(runs, cutoffSec){
  var cal=RunLoad.calibrateBaseline(runs, cutoffSec), profile=easyPaceSec();
  var src = cal.basePaceSec!=null ? 'calibrated' : (profile!=null ? 'profile' : null);
  return Object.assign({}, RunLoad.DEFAULTS, cal, { basePaceSec: cal.basePaceSec!=null?cal.basePaceSec:profile, basePaceSource: src, useGrade:true, offload:offloadFrac() });
}

/* ---------- Events and dismissed gaps ---------- */
// Events saved before the local-day fix carry UTC-midnight timestamps (the old date parser);
// remap those to local midnight of the same calendar date so they key and display on the day
// the athlete picked. New events store local midnight, which is only an exact UTC midnight for
// UTC±0 viewers — where the remap is the identity.
function evLocalTs(ts){ if(ts%DAY===0){ var d=new Date(ts); return new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()).getTime(); } return ts; }
function events(){
  var raw=Array.isArray(S.profile.runEvents)?S.profile.runEvents:[];
  return raw.map(function(e){
    var o=Object.assign({},e,{ts:evLocalTs(e.ts)});
    if(o.endTs!=null) o.endTs=evLocalTs(o.endTs);
    return o;
  });
}
function evFuture(type, d){ return !!(EV_NO_FUTURE[type] && d && d.getTime()>dayEnd(new Date()).getTime()); }
function evAddFn(e){ return function(list){ return list.some(function(x){ return String(x.id)===String(e.id); })?list:list.concat([e]); }; }
function dismissedDrops(){ return (Array.isArray(S.profile.runDismissedDrops)?S.profile.runDismissedDrops:[]).filter(function(x){ return x&&isFinite(x.t0)&&isFinite(x.t1); }); }
function sameDis(y,x){ return !!y && y.t0===x.t0 && y.t1===x.t1 && y.at===x.at; }

/* ---------- Strava sync and the per-athlete cache ---------- */
/* Strava auto-sync: if this athlete has Strava connected (coaching dashboard
   flow), top up their stored run history once per local day. The server
   (syncStravaActivities in functions/index.js) pulls 2 years of Strava runs
   but skips every run already covered by a watch import — Strava only fills
   the gaps, and can't provide GCT/oscillation/descent. Coach view skips this:
   the coaching page runs its own athlete-scoped daily sync, and the callable
   syncs the CALLER's account unless invoked with athleteUid by the admin. */
// Who is really signed in (site.js act-as layer: esLabs.user is the effective user, realUser the real one).
// canSync: the athlete themself, or the real admin (acting as them). Without the layer, the caller is the athlete.
function syncActor(){
  var L=window.esLabs, real=(L && ('realUser' in L)) ? ((L.realUser&&L.realUser.uid)||null) : S.uid, admin=!!real && !!L && real===L.ADMIN_UID;
  return {real:real, admin:admin, canSync:real===S.uid || admin};
}
// Remember the loaded runs (raw) and profile for an instant re-render on the next mount of this athlete (skipped
// while the profile failed to load: a cached default profile would hide the error next time).
function remember(raw){
  if(!S.uid) return;
  if(S.profileErr){ delete S.cache[S.uid]; return; }
  S.cache[S.uid]={ raw:raw, profile:S.profile, lever:S.stravaLever, sync:S.sync };
}
/* Drop the data remembered for uid's instant re-render (e.g. runs of theirs were deleted elsewhere), so
   their next mount shows only what is stored. */
function forget(uid){ if(uid) delete S.cache[uid]; }

var STRAVA_SYNC_MIN_MS=60*60*1000;   // client auto-sync at most once an hour per athlete
// The Strava top-up the view runs after a load. Resolves null when it does not run (not connected,
// not the athlete or the admin acting as them, no Functions SDK, synced within the hour, or a newer
// mount took over), else {runDocs}: the runs it added. The view decides the role and demo rules and
// re-reads the runs when runDocs > 0.
function syncStrava(){
  if(!S.sync.connected) return Promise.resolve(null);
  var who=syncActor(); if(!who.canSync) return Promise.resolve(null);
  if(!(window.firebase && firebase.functions)) return Promise.resolve(null);
  var last=S.sync.last;
  if(last){
    var d=last.toDate?last.toDate():new Date(last);
    if(Date.now()-d.getTime() < STRAVA_SYNC_MIN_MS) return Promise.resolve(null);   // synced within the hour (webhook covers uploads in between)
  }
  var my=S.gen;
  return firebase.functions().httpsCallable('syncStravaActivities',{timeout:300000})(who.real!==S.uid?{athleteUid:S.uid}:{}).then(function(res){
    if(my!==S.gen) return null;
    // the server stamped stravaLastSyncedAt (even with nothing new): the header's "Strava synced" reads this
    S.sync.last=new Date();
    return { runDocs:(res&&res.data&&res.data.runDocs)||0 };
  });
}

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
  heroModel: heroModel,
  S: S,
  open: open,
  DAY: DAY,
  MONTHS: MONTHS,
  FILTER_DEFAULTS: FILTER_DEFAULTS,
  EV_NO_FUTURE: EV_NO_FUTURE,
  STRAVA_SYNC_MIN_MS: STRAVA_SYNC_MIN_MS,
  syncStrava: syncStrava,
  fetchRuns: fetchRuns,
  remember: remember,
  norm: norm,
  num: num,
  hmsToSec: hmsToSec,
  parseDate: parseDate,
  ymd: ymd,
  dayEnd: dayEnd,
  fmtPace: fmtPace,
  fmtDur: fmtDur,
  fmtDay: fmtDay,
  fmtSpan: fmtSpan,
  fmtMD: fmtMD,
  fmtClock: fmtClock,
  daysAgo: daysAgo,
  fmtRel: fmtRel,
  canonJSON: canonJSON,
  loadFitLibs: loadFitLibs,
  importFitParser: importFitParser,
  fitNum: fitNum,
  fitPos: fitPos,
  runFromFitSession: runFromFitSession,
  parseFitBuffer: parseFitBuffer,
  fitFileType: fitFileType,
  fitArchiveRuns: fitArchiveRuns,
  parseCorosArchive: parseCorosArchive,
  corosErrMsg: corosErrMsg,
  actCol: actCol,
  docToRun: docToRun,
  sameRunSpan: sameRunSpan,
  backfill: backfill,
  moveRunNotes: moveRunNotes,
  deleteAllRuns: deleteAllRuns,
  profileBlocked: profileBlocked,
  saveProfile: saveProfile,
  persist: persist,
  revertKey: revertKey,
  updateProfileList: updateProfileList,
  goneGarminRuns: goneGarminRuns,
  loadProfile: loadProfile,
  offloadFrac: offloadFrac,
  leverPct: leverPct,
  easyPaceSec: easyPaceSec,
  weightKg: weightKg,
  deviceId: deviceId,
  hasAccessory: hasAccessory,
  workoutPaceSec: workoutPaceSec,
  includedPref: includedPref,
  fetchStravaLever: fetchStravaLever,
  stravaLever: stravaLever,
  leverMarkList: leverMarkList,
  markOffload: markOffload,
  orphanMark: orphanMark,
  annotateLever: annotateLever,
  effType: effType,
  exclList: exclList,
  runFlag: runFlag,
  annotateExcluded: annotateExcluded,
  exclMatch: exclMatch,
  filterIntensity: filterIntensity,
  computeLoadParams: computeLoadParams,
  evLocalTs: evLocalTs,
  events: events,
  evFuture: evFuture,
  evAddFn: evAddFn,
  dismissedDrops: dismissedDrops,
  sameDis: sameDis,
  syncActor: syncActor,
  forget: forget
};
if (typeof window !== 'undefined') window.RunData = RunData;
if (typeof module !== 'undefined' && module.exports) module.exports = RunData;
})();
