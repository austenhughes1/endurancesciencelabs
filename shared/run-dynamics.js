// ════════════════════════════════════════════════════════════════
// shared/run-dynamics.js
//
// The ONE Run Dynamics view. Both the standalone /running-dynamics/
// page and the coaching dashboard's "Run Dynamics" tab mount this —
// there is no second copy. Imports a Garmin Connect activities export
// (Activities.csv) OR a Coros export (.zip of per-activity .fit files),
// stores it under users/{uid}/garminActivities (de-duped by start
// time), and renders the actionable hero + unified load/metric chart +
// form tiles + volume, with all athlete/device/filter settings behind
// a gear button.
//
// Pure view layer. Depends on globals: RunLoad (shared/run-load-model.js)
// and RunDevices (shared/device-matrix.js). The host page provides a
// container, a Firestore handle, the athlete uid, and a role.
//
//   RunDynamics.mount(containerEl, { db, uid, role, title, sub })
//     db    : firebase firestore instance
//     uid   : the athlete whose data to show / write
//     role  : 'athlete' (self) | 'coach' (viewing an athlete) — copy only
//     title : optional heading shown above the tool (standalone page)
//     sub   : optional sub-line under the title
//
// Metric/load math lives in run-load-model.js; the math is identical
// across both surfaces because there is only one renderer.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

/* ============================================================
   CSS — injected once, scoped under .rdx, rdx- prefixed so it can
   never collide with a host page's classes. Design tokens
   (--panel, --cyan, …) come from the host page so light/dark
   theming keeps working.
   ============================================================ */
var CSS = `
.rdx{font-family:var(--ui,'Inter',system-ui,sans-serif);color:var(--text);font-size:15px;line-height:1.5}
.rdx *{box-sizing:border-box}
.rdx-topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
.rdx-h1{font-size:22px;font-weight:800;letter-spacing:-.3px;margin:0 0 4px}
.rdx-sub{font-size:13px;color:var(--muted2);max-width:760px;line-height:1.6;margin:0}
.rdx-sub code{font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--text)}
.rdx-gear{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.3px;color:var(--muted2);background:var(--panel);border:1px solid var(--border2);border-radius:9px;padding:8px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .14s;white-space:nowrap}
.rdx-gear:hover{border-color:var(--cyan);color:var(--cyan)}
.rdx-gear.on{border-color:var(--cyan);color:var(--cyan);background:rgba(0,229,200,.06)}

.rdx-help{margin-bottom:16px;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.rdx-help summary{cursor:pointer;list-style:none;padding:12px 16px;font-size:12px;font-weight:700;font-family:var(--mono);letter-spacing:.3px;text-transform:uppercase;color:var(--cyan);display:flex;align-items:center;gap:8px}
.rdx-help summary::-webkit-details-marker{display:none}
.rdx-help summary::before{content:"▸";transition:transform .15s}
.rdx-help[open] summary::before{transform:rotate(90deg)}
.rdx-help-body{padding:4px 18px 16px;font-size:13px;color:var(--muted2);line-height:1.7}
.rdx-help-body ol{margin:6px 0 0 18px;padding:0}
.rdx-help-body li{margin-bottom:7px}
.rdx-help-body code{font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--text)}
.rdx-help-body b{color:var(--text)}
.rdx-help-note{margin-top:10px;padding:9px 12px;background:rgba(245,166,35,.07);border:1px solid rgba(245,166,35,.22);border-radius:8px;color:var(--warn);font-size:12px;line-height:1.6}

.rdx-importbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:8px;padding:14px 16px;background:var(--panel);border:1px solid var(--border);border-radius:13px}
.rdx-drop{flex:1;min-width:280px;border:1.5px dashed var(--border2);border-radius:11px;padding:14px 18px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
.rdx-drop:hover,.rdx-drop.over{border-color:var(--cyan);background:rgba(0,229,200,.04)}
.rdx-drop b{font-size:13.5px;font-weight:700}
.rdx-drop span{font-size:11.5px;color:var(--muted2);display:block;margin-top:2px}
.rdx-status{font-size:12px;color:var(--muted2);font-family:var(--mono);line-height:1.6;min-width:200px;flex:1}
.rdx-status .ok{color:var(--good)}
.rdx-status .err{color:var(--bad)}
.rdx-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--border2);border-top-color:var(--cyan);border-radius:50%;animation:rdx-spin .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes rdx-spin{to{transform:rotate(360deg)}}

.rdx-settings{margin-top:14px;animation:rdx-fade .25s}
.rdx-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:stretch}
.rdx-group{display:flex;flex-direction:column;gap:11px;padding:13px 16px;background:var(--panel);border:1px solid var(--border);border-radius:13px}
.rdx-group-grow{flex:1;min-width:300px}
.rdx-group-hd{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);font-family:var(--mono);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rdx-group-sub{font-weight:400;letter-spacing:0;text-transform:none;color:var(--muted2);font-family:inherit;font-size:11.5px}
.rdx-group-body{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
.rdx-ctl-grow{flex:1;min-width:120px}
.rdx-controls-meta{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:8px;min-height:14px}
.rdx-inunit{display:flex;align-items:center;gap:6px}
.rdx-inunit span{font-size:12px;color:var(--muted2);font-family:var(--mono)}
.rdx-btn-sm{padding:8px 14px;align-self:flex-end;line-height:1.2}
.rdx-ctl{display:flex;flex-direction:column;gap:6px}
.rdx-ctl label{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono)}
.rdx-types{display:flex;flex-wrap:wrap;gap:7px}
.rdx-chip{font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;border:1px solid var(--border2);background:var(--panel2);color:var(--muted2);cursor:pointer;user-select:none;transition:all .12s}
.rdx-chip.on{background:rgba(0,229,200,.1);border-color:rgba(0,229,200,.35);color:var(--cyan)}
.rdx-events{display:flex;flex-wrap:wrap;gap:8px}
.rdx-ev-empty{font-size:11px;color:var(--muted2);font-family:var(--mono)}
.rdx-ev-guide{font-size:11.5px;color:var(--muted2);line-height:1.55}
.rdx-ev-guide b{color:var(--text)}
.rdx-ev-chip{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;padding:5px 9px;border-radius:20px;border:1px solid var(--border2);background:var(--panel2)}
.rdx-ev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.rdx-ev-chip b{font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-family:var(--mono)}
.rdx-ev-date{font-family:var(--mono);color:var(--muted2);font-size:10.5px}
.rdx-ev-note{color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rdx-ev-del{background:transparent;border:none;color:var(--muted2);cursor:pointer;font-size:12px;padding:0 0 0 2px;line-height:1}
.rdx-ev-del:hover{color:var(--bad)}
.rdx-ctl input[type=date]{background:var(--panel2);border:1px solid var(--border2);border-radius:8px;padding:8px 11px;color:var(--text);font-family:var(--mono);font-size:12.5px;color-scheme:dark}
.rdx-ctl select,.rdx-ctl input[type=text]{background:var(--panel2);border:1px solid var(--border2);border-radius:8px;padding:8px 11px;color:var(--text);font-family:var(--mono);font-size:12.5px;cursor:pointer;outline:none}
.rdx-ctl input[type=text]{cursor:text}
.rdx-drop-form{margin-top:10px;padding-top:10px;border-top:1px solid var(--border2);display:flex;flex-direction:column;gap:8px}
.rdx-df-field{display:flex;flex-direction:column;gap:4px}
.rdx-df-field label{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono)}
.rdx-drop-form select,.rdx-drop-form input{width:100%;box-sizing:border-box;background:var(--panel2);border:1px solid var(--border2);border-radius:7px;padding:7px 9px;color:var(--text);font-family:var(--mono);font-size:12px;outline:none;min-width:0}
.rdx-df-err{border-color:var(--bad)!important}
.rdx-btn{padding:9px 16px;background:var(--cyan);color:#000;font-weight:700;font-size:12.5px;border:none;border-radius:8px;cursor:pointer;transition:opacity .15s}
.rdx-btn:hover{opacity:.85}
.rdx-btn-danger{background:transparent;color:var(--bad);border:1px solid var(--bad);font-weight:600}
.rdx-btn-danger:disabled{opacity:.5;cursor:default}
.rdx-filenote{font-size:11px;color:var(--muted2);font-family:var(--mono)}

.rdx-section{display:none;margin-top:26px}
.rdx-section.show{display:block;animation:rdx-fade .3s}
@keyframes rdx-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.rdx-section h2{font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono);margin:0 0 13px;display:flex;align-items:center;gap:10px}
.rdx-section h2 .rdx-note{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)}
.rdx-section h2::after{content:"";flex:1;height:1px;background:var(--border)}

.rdx-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.rdx-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:15px 16px}
.rdx-card .rdx-win{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--cyan);font-family:var(--mono);margin-bottom:10px}
.rdx-card .rdx-row{display:flex;justify-content:space-between;font-size:12.5px;padding:3px 0;color:var(--muted2)}
.rdx-card .rdx-row b{color:var(--text);font-weight:700;font-family:var(--mono)}

.rdx-tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--panel)}
.rdx-table{border-collapse:collapse;width:100%;font-size:13px}
.rdx-table th,.rdx-table td{padding:10px 14px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--border)}
.rdx-table th:first-child,.rdx-table td:first-child{text-align:left;position:sticky;left:0;background:var(--panel)}
.rdx-table thead th{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono);background:var(--panel2)}
.rdx-table thead th:first-child{background:var(--panel2)}
.rdx-table tbody tr:last-child td{border-bottom:none}
.rdx-table tbody tr:hover td{background:var(--hover)}
.rdx-table tbody tr:hover td:first-child{background:var(--panel2)}
.rdx-mname{font-weight:600;color:var(--text)}
.rdx-munit{font-size:10px;color:var(--muted);font-family:var(--mono);margin-left:5px}
.rdx-mdesc{font-size:10.5px;color:var(--muted2);font-weight:400;margin-top:2px}
.rdx-val{font-family:var(--mono);font-weight:700;color:var(--text)}
.rdx-val.na{color:var(--muted);font-weight:400}
.rdx-delta{font-family:var(--mono);font-size:10.5px;margin-left:7px}
.rdx-delta.up{color:var(--good)}.rdx-delta.down{color:var(--bad)}.rdx-delta.flat{color:var(--muted)}

.rdx-rangebar{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:14px;padding:16px 18px;background:var(--panel);border:1px solid var(--border);border-radius:12px}
.rdx-hint{font-size:11.5px;color:var(--muted2);line-height:1.6;margin-top:10px;font-family:var(--mono)}
.rdx-empty{padding:40px;text-align:center;color:var(--muted2);font-size:13px}
.rdx-chartwrap{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 14px 8px}
.rdx-chart-svg{display:block;width:100%;height:auto}
.rdx-chart-empty{padding:34px;text-align:center;color:var(--muted2);font-size:12px;font-family:var(--mono)}
#rdx-chartBox{position:relative}
.rdx-hit{cursor:pointer}
.rdx-chart-tip{position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:30;min-width:120px;max-width:250px;padding:8px 10px;background:rgba(13,18,30,.97);border:1px solid var(--border2);border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.45);font-size:11.5px;line-height:1.5;color:var(--text)}
.rdx-chart-tip.on{display:block}
.rdx-tip-top{font-family:var(--mono);font-size:11px;color:var(--muted2);margin-bottom:3px;display:flex;align-items:center;gap:6px}
.rdx-tip-chip{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;border:1px solid;border-radius:10px;padding:1px 6px}
.rdx-tip-val b{color:var(--cyan)}
.rdx-tip-ctx{color:var(--muted2);font-size:10.5px;margin-top:3px}
.rdx-legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;padding-left:2px}
.rdx-legend-item{display:flex;align-items:center;gap:6px;font-size:10px;font-family:var(--mono);color:var(--muted2);font-weight:700}
.rdx-legend-sw{width:14px;height:3px;border-radius:2px}
.rdx-legend-ring{display:inline-block;width:9px;height:9px;border:1.6px solid #f5c842;border-radius:50%;margin-right:4px;vertical-align:middle}

#rdx-rangeChips .rdx-chip.on{background:rgba(0,229,200,.1);border-color:rgba(0,229,200,.35);color:var(--cyan)}

.rdx-demobar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:12px;padding:9px 12px;border:1px dashed var(--gold);border-radius:10px;background:rgba(245,200,66,.05)}
.rdx-demobar .lbl{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--gold);margin-right:2px}
.rdx-demobar .rdx-chip{font-size:11px;padding:4px 10px}
.rdx-demobar .rdx-chip.on{background:rgba(245,200,66,.16);border-color:var(--gold);color:var(--gold)}
.rdx-hero{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px 22px;border-left:4px solid var(--muted2)}
.rdx-hero-badge{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:12px}
.rdx-hero-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.rdx-hero-read{font-size:15.5px;line-height:1.55;color:var(--text);margin-bottom:12px}
.rdx-hero-read b{font-family:var(--mono);font-weight:700}
.rdx-hero-stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.rdx-hero-stat{background:var(--panel2);border:1px solid var(--border);border-radius:9px;padding:8px 13px;min-width:96px}
.rdx-hero-stat .k{font-size:9.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono)}
.rdx-hero-stat .v{font-size:19px;font-weight:800;font-family:var(--mono);margin-top:3px}
.rdx-hero-stat .x{font-size:9.5px;font-weight:700;font-family:var(--mono);margin-top:2px;letter-spacing:.2px}
.rdx-hero-do{font-size:14px;line-height:1.6;color:var(--muted2);background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:13px 15px}
.rdx-hero-do b{color:var(--text);font-weight:700}
.rdx-hero-do .lever{color:var(--cyan);font-weight:700}
.rdx-hero-do .do-hd{display:block;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--cyan);margin-bottom:6px}
.rdx-do-line{color:var(--text);margin-bottom:10px}
.rdx-do-vol{margin-bottom:4px}
.rdx-do-opts{list-style:none;margin:9px 0 4px;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.rdx-do-opts li{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:8px 12px;font-size:13px;color:var(--text)}
.rdx-do-opts li b{font-family:var(--mono);color:var(--text)}
.rdx-do-opts .lever-opt{border-color:rgba(0,229,200,.4);background:rgba(0,229,200,.06)}
.rdx-do-opts .lever-opt b{color:var(--cyan)}
.rdx-do-lever{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}

.rdx-pat-intro{font-size:13px;color:var(--muted2);line-height:1.6;margin-bottom:12px}
.rdx-pat-intro b{color:var(--text);font-family:var(--mono)}
.rdx-pat-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:8px}
.rdx-pat-main{display:flex;flex-direction:column;gap:2px;min-width:220px;flex:1}
.rdx-pat-name{font-weight:700;font-size:13.5px}
.rdx-pat-desc{font-size:11px;color:var(--muted2)}
.rdx-pat-stats{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.rdx-pat-stat{font-size:11.5px;color:var(--muted2);font-family:var(--mono)}
.rdx-pat-stat b{color:var(--text)}
.rdx-pat-lift{font-family:var(--mono);font-size:10.5px;font-weight:700;border:1px solid;border-radius:20px;padding:3px 10px;white-space:nowrap}
.rdx-pat-sub{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono);margin:18px 0 10px}
.rdx-pat-flag{font-size:12px;padding:4px 0;color:var(--muted2);line-height:1.45}
.rdx-pat-flag b{display:block;color:var(--text);font-size:12px}
.rdx-pat-flagval{font-size:11.5px;color:var(--muted2);line-height:1.5}
.rdx-pat-dropintro{font-size:12px;color:var(--muted2);margin-bottom:10px;line-height:1.6}
.rdx-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.rdx-tile{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.rdx-tile-lbl{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted2);font-family:var(--mono)}
.rdx-tile-val{font-size:24px;font-weight:800;font-family:var(--mono);margin-top:8px;line-height:1}
.rdx-tile-unit{font-size:11px;font-weight:600;color:var(--muted2);margin-left:4px}
.rdx-tile-delta{margin-top:7px;min-height:14px}
.rdx-tile-delta .rdx-delta{margin-left:0;font-size:11.5px}

.rdx-info{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;border:1px solid var(--muted2);color:var(--muted2);font-size:9px;font-weight:700;font-style:normal;cursor:help;margin-left:4px;position:relative;vertical-align:middle}
.rdx-info:hover{color:var(--cyan);border-color:var(--cyan)}
.rdx-foot{margin-top:40px;font-size:11px;color:var(--muted);font-family:var(--mono);line-height:1.7;border-top:1px solid var(--border);padding-top:18px}
@media(max-width:560px){
  .rdx-table{font-size:12px}
  .rdx-table th,.rdx-table td{padding:7px 10px}
  .rdx-table th:first-child,.rdx-table td:first-child{white-space:normal;max-width:42vw}
  .rdx-mname{display:block}
  .rdx-mdesc{display:none}
}
`;
function injectCSS(){
  if (document.getElementById('rdx-styles')) return;
  var s = document.createElement('style'); s.id = 'rdx-styles'; s.textContent = CSS;
  document.head.appendChild(s);
}

/* ============================================================
   METRIC DEFINITIONS — computed PER RUN, then averaged across a window.
   ============================================================ */
var METRICS = [
  { key:'load',   label:'Load Factor',         unit:'',    dec:1, better:'lower', needs:'gct',
    desc:'cadence × GCT ÷ 1000 — cumulative ground-contact loading proxy',
    calc:function(r){ return (r.cadence!=null&&r.gct!=null)? r.cadence*r.gct/1000 : null; } },
  { key:'duty',   label:'Duty Factor',         unit:'%',   dec:1, better:'lower', needs:'gct',
    desc:'share of the stride spent on the ground = GCT × cadence ÷ 1200',
    calc:function(r){ return (r.cadence!=null&&r.gct!=null)? r.gct*r.cadence/1200 : null; } },
  { key:'vgrf',   label:'Peak vGRF',           unit:'BW',  dec:2, better:'lower', needs:'gct',
    desc:'estimated peak vertical impact force in body-weights (Morin method, from contact + flight time)',
    calc:function(r){ return RunLoad.vgrfBW(r); } },
  { key:'force',  label:'Peak Force',          unit:'N',   dec:0, better:'lower', needs:'gct', needsWeight:true,
    desc:'estimated peak vertical impact force in Newtons — needs body weight',
    calc:function(r){ return RunLoad.vgrfN(r, weightKg()); } },
  { key:'gct',    label:'Ground Contact Time', unit:'ms',  dec:0, better:'lower', needs:'gct',
    desc:'time the foot is on the ground each step',
    calc:function(r){ return r.gct; } },
  { key:'vo',     label:'Vertical Oscillation',unit:'cm',  dec:1, better:'lower', needs:'vo',
    desc:'how much the torso bounces vertically each step',
    calc:function(r){ return r.vo; } },
  { key:'vratio', label:'Vertical Ratio',      unit:'%',   dec:1, better:'lower', needs:'vratio',
    desc:'bounce ÷ stride length — overall efficiency (lower is better)',
    calc:function(r){ return r.vratio; } },
  { key:'cad',    label:'Cadence',             unit:'spm', dec:0, better:'higher', needs:null,
    desc:'steps per minute',
    calc:function(r){ return r.cadence; } },
  { key:'stride', label:'Stride Length',       unit:'m',   dec:2, better:null, needs:'stride',
    desc:'distance covered per step',
    calc:function(r){ return r.stride; } },
  { key:'asym',   label:'GCT Balance Asym.',   unit:'%',   dec:1, better:'lower', needs:'gctBalance',
    desc:'L/R contact-time imbalance = |left% − 50|',
    calc:function(r){ return r.gctBalL!=null? Math.abs(r.gctBalL-50) : null; } },
  { key:'eff',    label:'Form Efficiency',     unit:'m/cm',dec:2, better:'higher', needs:'vo',
    desc:'stride length ÷ vertical oscillation — distance per unit of bounce',
    calc:function(r){ return (r.stride!=null&&r.vo)? r.stride/r.vo : null; } },
  { key:'pace',   label:'Avg Pace',            unit:'/mi', dec:0, better:null, pace:true, needs:null,
    desc:'average pace',
    calc:function(r){ return r.paceSec; } },
  { key:'hr',     label:'Avg HR',              unit:'bpm', dec:0, better:'lower', needs:null,
    desc:'average heart rate',
    calc:function(r){ return r.avgHr; } },
  { key:'impact', label:'Impact Load',         unit:'IAD mi',  dec:1, better:null, needs:null,
    desc:'modeled mechanical load in Impact Adjusted Distance (distance × pace × duty-factor impact + grade)',
    calc:function(r){ return window.RunLoad ? RunLoad.impactLoad(r, LOAD_PARAMS) : null; } },
];
var RUN_WINDOWS = [
  {days:7,   label:'7 days'},
  {days:30,  label:'30 days'},
  {days:90,  label:'90 days'},
  {days:365, label:'365 days'},
  {days:null,label:'All time'},
];
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- per-mount state ---------- */
var ROOT=null, DB=null, UID=null, ROLE='athlete', ADMIN=false, STRAVA_SYNC={};
var RAW=[], ACTIVE_TYPES=new Set(), KNOWN_TYPES=new Set();
var ANCHOR=null, LOAD_PARAMS=null, STD_PROFILE={}, STRAVA_LEVER=[];
var DAY=864e5;

/* Admin-only demo switcher: forces the hero's 1/3/7-day-vs-28 ratios to a fixed
   scenario so each recommendation card can be shown on demand. DEMO=null = live.
   Real run data is never touched — only the hero's displayed windows are overridden. */
var DEMO=null;
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

// Scoped element lookup — IDs live inside the mount container only.
function $(id){ return ROOT ? ROOT.querySelector('#'+id) : null; }
function $all(sel){ return ROOT ? ROOT.querySelectorAll(sel) : []; }
function actCol(){ return DB.collection('users').doc(UID).collection('garminActivities'); }

/* ---------- CSV parsing ---------- */
function parseCSV(text){
  text = text.replace(/^﻿/,'');
  var rows=[], row=[], cur='', q=false;
  for(var i=0;i<text.length;i++){
    var c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; }
      else cur+=c;
    } else {
      if(c==='"') q=true;
      else if(c===','){ row.push(cur); cur=''; }
      else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; }
      else if(c==='\r'){ /* skip */ }
      else cur+=c;
    }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(function(r){return r.length>1;});
}
function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function buildColMap(header){ var m={}; header.forEach(function(h,i){ var n=norm(h); if(!(n in m)) m[n]=i; }); return m; }
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
function gctBalLeft(v){ if(v==null) return null; var mm=String(v).match(/([\d.]+)\s*%?\s*L/i); return mm?parseFloat(mm[1]):null; }
function parseDate(v){ if(!v) return null; var d=new Date(String(v).trim().replace(' ','T')); return isNaN(d)?null:d; }

/* Parse a Garmin export into candidate run docs keyed by a stable id. */
function parseExport(text){
  var rows=parseCSV(text);
  if(rows.length<2) throw new Error('No data rows found.');
  var col=buildColMap(rows[0]);
  // Fingerprint on the columns every Garmin activities export has. Do NOT
  // require running-form columns (GCT etc.) — Garmin only exports what's on
  // screen, so they're often absent; missing fields just parse as null and
  // the load model falls back to its no-dynamics path.
  ['activitytype','date'].forEach(function(k){
    if(!(k in col)) throw new Error('Not a Garmin activities export (missing "'+k+'").');
  });
  var get=function(r,k){ return col[k]!=null ? r[col[k]] : null; };
  var byId={};
  for(var i=1;i<rows.length;i++){
    var r=rows[i];
    var rawDate=get(r,'date');
    var date=parseDate(rawDate);
    if(!date) continue;
    var type=String(get(r,'activitytype')||'').trim();
    if(!/run/i.test(type)) continue;                 // run-focused tool
    var isTrack=/track/i.test(type);
    var distRaw=num(get(r,'distance'));
    var digits=String(rawDate).replace(/\D/g,'');     // stable id from start datetime
    var id=digits+'_'+norm(type);
    var title=String(get(r,'title')||'').trim();
    byId[id]={
      id:id, type:type, title:title,
      leverTitle:/lever/i.test(title),
      ts:date.getTime(), dateISO:date.toISOString(),
      distMi: distRaw==null?null:(isTrack?distRaw/1609.34:distRaw),
      durSec: hmsToSec(get(r,'time')),
      avgHr:num(get(r,'avghr')), maxHr:num(get(r,'maxhr')), aerobicTE:num(get(r,'aerobicte')),
      cadence:num(get(r,'avgruncadence')), stride:num(get(r,'avgstridelength')),
      vratio:num(get(r,'avgverticalratio')), vo:num(get(r,'avgverticaloscillation')),
      gct:num(get(r,'avggroundcontacttime')), gctBalL:gctBalLeft(get(r,'avggctbalance')),
      paceSec:hmsToSec(get(r,'avgpace')), gapSec:hmsToSec(get(r,'avggap')),
      ascentM:num(get(r,'totalascent')), descentM:num(get(r,'totaldescent')), steps:num(get(r,'steps')),
    };
  }
  var runs=Object.keys(byId).map(function(k){return byId[k];});
  var units=detectCsvUnits(runs);
  runs.forEach(function(c){
    if(units==='metric'){
      // Distance column is km and pace is s/km; elevation is already meters.
      if(c.distMi!=null && !/track/i.test(c.type)) c.distMi=c.distMi/1.60934;
      if(c.paceSec!=null) c.paceSec=c.paceSec*1.60934;
      if(c.gapSec!=null)  c.gapSec =c.gapSec *1.60934;
    } else {
      // Statute: distance/pace are per-mile as assumed; elevation is FEET.
      if(c.ascentM!=null)  c.ascentM =c.ascentM *0.3048;
      if(c.descentM!=null) c.descentM=c.descentM*0.3048;
    }
  });
  runs.csvUnits=units;
  return runs;
}

/* Garmin exports every column in the account's display units (statute:
   miles & feet, metric: km & meters) with no units metadata in the file, so
   the system has to be inferred from the data. Steps × stride length is the
   unit-free ground truth: stride is exported in meters under BOTH systems,
   so steps×stride ≈ the run's true distance in meters. Each row votes for
   whichever reading of its Distance column (miles or km) lands closer to
   that truth — the two readings differ by 1.61×, so votes are unambiguous;
   rows missing steps/stride, track runs (distance column is meters in both
   systems), and rows where neither reading is close (bad pod data) abstain.
   With no votes the file stays statute — the assumption this parser always
   made. (A plausibility fallback, e.g. "median grade too steep to be
   meters", was rejected: a genuinely flat statute export would be misread
   as metric and get its distance AND pace corrupted, a far worse failure
   than the elevation one being fixed. Metric exports without a Steps
   column remain unsupported, as they always were.) */
function detectCsvUnits(runs){
  var mi=0, km=0;
  runs.forEach(function(c){
    if(c.distMi==null||!(c.steps>0)||!(c.stride>0)||/track/i.test(c.type)) return;
    var trueM=c.steps*c.stride;
    var dMi=Math.abs(Math.log((c.distMi*1609.34)/trueM));
    var dKm=Math.abs(Math.log((c.distMi*1000)/trueM));
    if(Math.min(dMi,dKm)>Math.log(1.25)) return;
    if(dMi<dKm) mi++; else km++;
  });
  return km>mi?'metric':'statute';
}

/* ---------- Coros .fit / .zip parsing ----------
   Coros Connect exports a .zip of per-activity binary .fit files (no CSV).
   Every running-dynamics metric lives in standard FIT `session` fields
   (verified against a real Coros export — no developer/custom fields), so
   each session maps onto the SAME run-doc shape parseExport produces and
   flows through the identical backfill/dedup path. Units differ from
   Garmin's CSV: cadence is per-leg (×2), oscillation is mm (÷10 → cm),
   step length is mm (÷1000 → m). The two parser libs are loaded from CDN
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
// never legitimately be 0. Coros writes a literal 0 (not a blank, unlike
// Garmin's CSV) on runs recorded WITHOUT a running-dynamics pod/strap. A stored
// 0 GCT later divides into the load model → Infinity, so treat 0 as "absent".
function fitPos(v){ return (typeof v==='number'&&isFinite(v)&&v>0)?v:null; }

/* One FIT `session` message -> the same candidate run doc parseExport emits. */
function runFromFitSession(s){
  if(!s||!s.start_time) return null;
  var sport=String(s.sport||'').toLowerCase();
  if(sport && !/run/.test(sport)) return null;            // run-focused tool
  var start=new Date(s.start_time);
  if(isNaN(start)) return null;
  var type=s.sport?(s.sport.charAt(0).toUpperCase()+s.sport.slice(1)):'Running';
  var id=start.toISOString().replace(/\D/g,'').slice(0,14)+'_'+norm(type);
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
/* Parse a Coros .zip (or bare .fit) ArrayBuffer into deduped run candidates. */
function parseCorosArchive(arrayBuffer, fileName, onProgress){
  return loadFitLibs().then(function(L){
    var lower=String(fileName||'').toLowerCase();
    if(/\.fit$/.test(lower)) return parseFitBuffer(L.FitParser, arrayBuffer);
    return L.JSZip.loadAsync(arrayBuffer).then(function(zip){
      var entries=[];
      zip.forEach(function(path,entry){ if(!entry.dir && /\.fit$/i.test(path)) entries.push(entry); });
      if(!entries.length) throw new Error('No .fit files found inside the .zip.');
      var done=0, candidates=[], chain=Promise.resolve();
      entries.forEach(function(entry){
        chain=chain.then(function(){
          return entry.async('arraybuffer').then(function(ab){
            return parseFitBuffer(L.FitParser, ab).then(function(runs){
              candidates=candidates.concat(runs);
              done++; if(onProgress) onProgress(done, entries.length);
            });
          });
        });
      });
      return chain.then(function(){ return candidates; });
    });
  }).then(function(list){
    var byId={}; list.forEach(function(c){ byId[c.id]=c; });   // dedup within the archive
    return Object.keys(byId).map(function(k){return byId[k];});
  });
}

/* ---------- Firestore: load + backfill ---------- */
function docToRun(d){ var o=Object.assign({},d); o.date=new Date(d.ts); return o; }
function loadFromFirestore(){
  return actCol().get().then(function(snap){
    RAW=[]; snap.forEach(function(doc){ RAW.push(docToRun(doc.data())); });
    RAW.sort(function(a,b){ return a.ts-b.ts; });
  });
}
function localDayKey(ts){ var d=new Date(ts); return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate(); }
function backfill(candidates){
  return actCol().get().then(function(snap){
    var candIds=new Set(candidates.map(function(c){return c.id;}));
    var candDays=new Set(candidates.map(function(c){return localDayKey(c.ts);}));
    var existing=new Set(), replace=[];
    snap.forEach(function(d){
      existing.add(d.id);
      var x=d.data();
      // A watch export is the richer record (GCT, oscillation, descent) — drop
      // any Strava-synced doc on a day this import now covers. Same-id docs
      // need no delete: the set() below overwrites them wholesale. The server
      // sync skips device-covered days, so these never come back.
      if(x.source==='strava' && !candIds.has(d.id) && candDays.has(localDayKey(x.ts))) replace.push(d.ref);
    });
    var added=0; candidates.forEach(function(c){ if(!existing.has(c.id)) added++; });
    var ops=candidates.slice();
    replace.forEach(function(ref){ ops.push({del:ref}); });
    var chunks=[]; for(var i=0;i<ops.length;i+=450) chunks.push(ops.slice(i,i+450));
    var p=Promise.resolve();
    chunks.forEach(function(chunk){
      p=p.then(function(){
        var batch=DB.batch();
        chunk.forEach(function(op){ if(op.del) batch.delete(op.del); else batch.set(actCol().doc(op.id), op); });
        return batch.commit();
      });
    });
    return p.then(function(){ return {added:added, updated:candidates.length-added, replaced:replace.length}; });
  });
}
/* Delete every stored activity doc. Escape hatch for a bad import: backfill
   upserts by start-time id, so a mislabeled activity that was re-exported
   under the same id can never be fixed by re-uploading — wipe and re-import
   is the only clean path. Profile, races/injuries live on the user doc and
   are untouched. Resolves with the number of docs deleted. */
function deleteAllRuns(){
  return actCol().get().then(function(snap){
    var refs=[]; snap.forEach(function(d){ refs.push(d.ref); });
    var chunks=[]; for(var i=0;i<refs.length;i+=450) chunks.push(refs.slice(i,i+450));
    var p=Promise.resolve();
    chunks.forEach(function(chunk){
      p=p.then(function(){
        var batch=DB.batch();
        chunk.forEach(function(ref){ batch.delete(ref); });
        return batch.commit();
      });
    });
    return p.then(function(){ return refs.length; });
  });
}

/* ---------- aggregation ---------- */
function minDist(){ var el=$('mindist'); var v=el?parseFloat(el.value):NaN; return (v>=0)?v:0.5; }
function analyzable(r){ return r.distMi!=null && r.distMi>=minDist(); }
function runsIn(start,end){ return RAW.filter(function(r){ return ACTIVE_TYPES.has(effType(r)) && analyzable(r) && r.date>start && r.date<=end; }); }
function metricMean(runs,m){
  var vals=runs.map(m.calc).filter(function(v){ return v!=null && !isNaN(v); });
  if(!vals.length) return null;
  return vals.reduce(function(a,b){return a+b;},0)/vals.length;
}
function summarize(runs){
  var dist=runs.reduce(function(a,r){return a+(r.distMi||0);},0);
  var dur=runs.reduce(function(a,r){return a+(r.durSec||0);},0);
  var pv=runs.map(function(r){return r.paceSec;}).filter(function(v){return v!=null;});
  var pace=pv.length?pv.reduce(function(a,b){return a+b;},0)/pv.length:null;
  return {n:runs.length,dist:dist,dur:dur,pace:pace};
}

/* ---------- formatting ---------- */
function fmtVal(v,m){
  if(v==null) return '<span class="rdx-val na">–</span>';
  if(m.pace) return '<span class="rdx-val">'+fmtPace(v)+'</span>';
  return '<span class="rdx-val">'+v.toFixed(m.dec)+'</span>';
}
function fmtPace(s){ if(s==null) return '–'; var mm=Math.floor(s/60), ss=Math.round(s%60); return mm+':'+String(ss).padStart(2,'0'); }
function fmtDur(s){ var h=Math.floor(s/3600), mm=Math.round((s%3600)/60); return h>0?h+'h '+mm+'m':mm+'m'; }
function deltaHTML(cur,prev,m){
  if(cur==null||prev==null) return '';
  var diff=cur-prev;
  if(Math.abs(diff)<1e-9) return '<span class="rdx-delta flat">→ 0</span>';
  var dir=diff>0?'▲':'▼', cls='flat';
  if(m.better==='lower') cls=diff<0?'up':'down';
  else if(m.better==='higher') cls=diff>0?'up':'down';
  var txt=m.pace?((diff>0?'+':'−')+fmtPace(Math.abs(diff))):((diff>0?'+':'−')+Math.abs(diff).toFixed(m.dec));
  return '<span class="rdx-delta '+cls+'">'+dir+' '+txt+'</span>';
}
function ymd(d){ return d.toISOString().slice(0,10); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------- rendering helpers ---------- */
function summaryCard(label,s){
  return '<div class="rdx-card"><div class="rdx-win">'+label+'</div>'+
    '<div class="rdx-row">Runs <b>'+s.n+'</b></div>'+
    '<div class="rdx-row">Distance <b>'+s.dist.toFixed(1)+' mi</b></div>'+
    '<div class="rdx-row">Time <b>'+(s.dur?fmtDur(s.dur):'–')+'</b></div>'+
    '<div class="rdx-row">Avg pace <b>'+fmtPace(s.pace)+'</b></div></div>';
}
function filterIntensity(runs,mode,cutoffSec){
  if(mode==='workout') return runs.filter(function(r){return r.paceSec!=null && r.paceSec<cutoffSec;});
  if(mode==='easy') return runs.filter(function(r){return r.paceSec!=null && r.paceSec>=cutoffSec;});
  return runs;
}
function intensityState(){
  var sel=$('intensity'), cut=$('cutoff');
  return { mode: sel?sel.value:'all', cutoff: (cut?hmsToSec(cut.value):null)||400 };
}
function runsInF(s,e){ var it=intensityState(); return filterIntensity(runsIn(s,e),it.mode,it.cutoff); }
function typeRuns(){ return RAW.filter(function(r){return ACTIVE_TYPES.has(effType(r))&&analyzable(r);}); }
function offloadFrac(){ var v=parseFloat(STD_PROFILE.runLeverPctBW); var pct=(v>0&&v<100)?v:85; return 1-pct/100; }
function leverPct(){ var v=parseFloat(STD_PROFILE.runLeverPctBW); return (v>0&&v<100)?v:85; }

// Strava titles only: athletes rename runs on Strava (never in Garmin), so a Strava activity whose
// name contains "lever" is a strong manual Lever flag. We pull ONLY the title from Strava and match
// it to the Garmin run by date (+distance); every metric still comes from Garmin.
function fetchStravaLever(){
  if(!UID) return Promise.resolve();
  return DB.collection('trainingPlans').where('athleteUid','==',UID).limit(1).get().then(function(ps){
    if(ps.empty){ STRAVA_LEVER=[]; return; }
    return DB.collection('trainingPlans').doc(ps.docs[0].id).collection('stravaActivities').get().then(function(snap){
      var out=[]; snap.forEach(function(d){ var a=d.data(); if(a&&a.name&&/lever/i.test(a.name)&&a.date) out.push({ date:a.date, distMi:(a.distance||0)/1609.34 }); });
      STRAVA_LEVER=out;
    });
  }).catch(function(){ STRAVA_LEVER=[]; });
}
function stravaLever(r){
  if(!STRAVA_LEVER.length) return false;
  return STRAVA_LEVER.some(function(s){ var n=Date.parse(s.date+'T12:00:00'); if(isNaN(n)) return false;
    if(Math.abs(r.ts-n) > 1.2*864e5) return false;
    if(r.distMi!=null && s.distMi>0 && Math.abs(s.distMi-r.distMi) > Math.max(0.2,0.05*r.distMi)) return false;
    return true; });
}
function annotateLever(){ var ids=RunLoad.detectLeverIds(RAW); RAW.forEach(function(r){ r.lever = !!r.leverTitle || stravaLever(r) || ids.has(r.id); }); }
function effType(r){ return r.lever ? 'Lever' : r.type; }
function computeLoadParams(){ var it=intensityState(); return Object.assign({}, RunLoad.DEFAULTS, RunLoad.calibrateBaseline(typeRuns(), it.cutoff), { useGrade:true, offload:offloadFrac() }); }

/* ---------- profile (weight + device), stored on the user doc ---------- */
function weightKg(){ var lb=STD_PROFILE.weightLb; return lb ? lb*0.453592 : null; }
function deviceId(){ return STD_PROFILE.runDevice||''; }
function hasAccessory(){ return !!STD_PROFILE.runHasAccessory; }
function metricVisible(m){ return RunDevices.status(m.needs, deviceId(), hasAccessory())==='native'; }
function saveProfile(patch){
  Object.assign(STD_PROFILE, patch);
  var el=$('savedNote');
  var show=function(txt,ok){ if(!el)return; el.style.color=ok?'var(--good)':'var(--bad)'; el.textContent=txt; el.style.opacity='1'; if(ok) setTimeout(function(){ el.style.opacity='0'; },1500); };
  if(!UID){ show('⚠ no athlete',false); return; }
  var ref=DB.collection('users').doc(UID), key=Object.keys(patch)[0];
  ref.set(patch,{merge:true})
    .then(function(){ return ref.get(); })
    .then(function(d){ var data=d.data()||{}; var ok=JSON.stringify(data[key])===JSON.stringify(patch[key]);
      show(ok?'✓ saved':'⚠ wrote but not stored',ok);
      if(!ok) console.warn('RunDynamics: profile did not persist',{uid:UID,key:key,got:data[key],sent:patch[key]}); })
    .catch(function(e){ console.error('profile save',e); show('⚠ '+(e&&e.code||'save failed'),false); });
}
function loadProfile(){ if(!UID) return Promise.resolve(); return DB.collection('users').doc(UID).get().then(function(d){ var x=d.exists?d.data():{}; STD_PROFILE={ weightLb:x.weightLb, runDevice:x.runDevice, runHasAccessory:x.runHasAccessory, runLeverPctBW:x.runLeverPctBW, runEvents:Array.isArray(x.runEvents)?x.runEvents:[] }; STRAVA_SYNC={ connected:!!x.stravaConnected, last:x.stravaLastSyncedAt||null }; }).catch(function(){ STD_PROFILE={}; STRAVA_SYNC={}; }); }

/* ---------- performance/injury/downtime history events ---------- */
// runEvents[] entry: { id, type:'race'|'injury'|'timeoff', ts, endTs?, note }.
// endTs (injury & planned downtime only) makes the event a span — drawn as a
// faint band on the charts instead of a single marker line.
var EV_META={ injury:['Injury','var(--bad)'], race:['Race','var(--good)'], timeoff:['Planned Downtime','#5b9cf5'] };
function events(){ return Array.isArray(STD_PROFILE.runEvents)?STD_PROFILE.runEvents:[]; }
function evWarn(msg){ var el=$('savedNote'); if(el){el.style.color='var(--bad)';el.textContent=msg;el.style.opacity='1';} }
function evAdd(){
  var d=parseDate($('evDate').value);
  if(!d){ evWarn('⚠ pick a date'); return; }
  var type=$('evType').value; if(!EV_META[type]) type='race';
  var note=($('evNote').value||'').trim();
  var e={ id:Date.now(), type:type, ts:d.getTime(), note:note };
  if(type!=='race'){
    var end=parseDate($('evEndDate').value);
    if(end){
      if(end.getTime()<=d.getTime()){ evWarn('⚠ end date must be after the start'); return; }
      e.endTs=end.getTime();
    }
  }
  var evs=events().slice(); evs.push(e);
  saveProfile({ runEvents:evs });
  $('evNote').value=''; $('evEndDate').value='';
  renderEventsList(); refresh();
}
function evDelete(id){ var evs=events().filter(function(e){return e.id!==id;}); saveProfile({ runEvents:evs }); renderEventsList(); refresh(); }
function renderEventsList(){
  var el=$('eventsList'); if(!el) return;
  var evs=events().slice().sort(function(a,b){return b.ts-a.ts;});
  el.style.display='flex';
  if(!evs.length){ el.innerHTML='<span class="rdx-ev-empty">No races, injuries or planned downtime logged yet — add one to overlay it on the chart.</span>'; return; }
  el.innerHTML=evs.map(function(e){ var m=EV_META[e.type]||EV_META.race, col=m[1];
    var when=new Date(e.ts).toISOString().slice(0,10)+(e.endTs?' → '+new Date(e.endTs).toISOString().slice(0,10):'');
    return '<span class="rdx-ev-chip"><span class="rdx-ev-dot" style="background:'+col+'"></span><b style="color:'+col+'">'+m[0]+'</b><span class="rdx-ev-date">'+when+'</span>'+(e.note?'<span class="rdx-ev-note">'+esc(e.note)+'</span>':'')+'<button class="rdx-ev-del" data-id="'+e.id+'" title="Remove">✕</button></span>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('.rdx-ev-del'),function(b){ b.onclick=function(){ evDelete(+this.getAttribute('data-id')); }; });
}
function populateMetricSelects(){
  var v1=$('chartView'), v2=$('chartView2'); if(!v1) return;
  var prev1=v1.value, prev2=v2.value;
  var opts=METRICS.map(function(m,i){return metricVisible(m)?'<option value="'+i+'">'+m.label+'</option>':'';}).join('');
  v1.innerHTML='<option value="load">Load (acute vs chronic)</option>'+opts;
  v2.innerHTML='<option value="">None</option>'+opts;
  var has=function(sel,v){return Array.prototype.some.call(sel.options,function(o){return o.value===v;});};
  v1.value=has(v1,prev1)?prev1:'load';
  v2.value=has(v2,prev2)?prev2:'';
}

/* ---------- chart math helpers ---------- */
function acwrColor(a){ if(a==null)return 'var(--muted2)'; if(a>1.5)return 'var(--bad)'; if(a>1.3)return 'var(--gold)'; if(a<0.8)return 'var(--warn)'; return 'var(--good)'; }
function acwrLabel(a){ if(a==null)return 'building baseline'; if(a>1.5)return 'spike · injury-risk zone'; if(a>1.3)return 'approaching ceiling'; if(a<0.8)return 'detraining / taper'; return 'in the safe band'; }
function spanDays(){ return RAW.length ? Math.round((RAW[RAW.length-1].ts - RAW[0].ts)/DAY)+1 : 0; }
function axisTicks(t0,t1){
  var months=(t1-t0)/(30.44*DAY);
  var steps=[1,2,3,6,12], step=12;
  for(var i=0;i<steps.length;i++){ if(months/steps[i]<=12){ step=steps[i]; break; } }
  var out=[], y0=new Date(t0).getFullYear(), y1=new Date(t1).getFullYear();
  for(var y=y0;y<=y1;y++) for(var m=0;m<12;m+=step){ var t=new Date(y,m,1).getTime(); if(t>=t0&&t<=t1) out.push(t); }
  return out.length>=2 ? out : [t0,t1];
}
function axisLabel(ts,idx){ var d=new Date(ts); return MONTHS[d.getMonth()]+((d.getMonth()===0||idx===0)?" '"+String(d.getFullYear()).slice(2):''); }
function smoothArr(vals,w){ var half=Math.floor(w/2); return vals.map(function(_,i){ var s=0,c=0; for(var j=Math.max(0,i-half);j<=Math.min(vals.length-1,i+half);j++){ s+=vals[j]; c++; } return s/c; }); }
function coloredPath(xs,ys,cs,width){ var out='',cur=[],cc=null;
  for(var i=0;i<xs.length;i++){ var p=xs[i].toFixed(1)+','+ys[i].toFixed(1);
    if(cc===null){cc=cs[i];cur=[p];}
    else if(cs[i]===cc){cur.push(p);}
    else { cur.push(p); out+='<polyline points="'+cur.join(' ')+'" fill="none" stroke="'+cc+'" stroke-width="'+width+'" stroke-linejoin="round" stroke-linecap="round"/>'; cur=[p]; cc=cs[i]; } }
  if(cur.length>1) out+='<polyline points="'+cur.join(' ')+'" fill="none" stroke="'+cc+'" stroke-width="'+width+'" stroke-linejoin="round" stroke-linecap="round"/>';
  return out;
}
function acuteSegColor(acwr){ if(acwr==null) return '#00e5c8'; if(acwr>1.5) return '#f55050'; if(acwr>1.3) return '#f5a623'; if(acwr>1.0) return '#22c78a'; return '#00e5c8'; }
function tickFmt(m,v){ if(m.pace)return fmtPace(v); if(Math.abs(v)>=100)return Math.round(v); return v.toFixed(m.dec===0?0:(m.dec>=2?2:1)); }
function quantile(sorted,q){ var pos=(sorted.length-1)*q, base=Math.floor(pos), rest=pos-base; return sorted[base+1]!==undefined ? sorted[base]+rest*(sorted[base+1]-sorted[base]) : sorted[base]; }
function smoothPts(pts){ var w=Math.max(3,Math.min(21,Math.round(pts.length/8))), half=Math.floor(w/2); return pts.map(function(p,i){ var s=0,c=0; for(var j=Math.max(0,i-half);j<=Math.min(pts.length-1,i+half);j++){ s+=pts[j].v; c++; } return {ts:p.ts,v:s/c}; }); }

/* ---------- hero recommendation ---------- */
// Mean daily load over the last n calendar days (rest days count as 0).
// loadTimeline exposes each day's load as `.daily`.
function avgLast(tl,n){ var s=tl.slice(-n); if(!s.length) return 0; var sum=0; for(var i=0;i<s.length;i++) sum+=s[i].daily; return sum/s.length; }
// Round to a clean mileage (nearest 0.5), no trailing .0.
function fmtMi(x){ var r=Math.round(x*2)/2; return (r%1===0)?String(r):r.toFixed(1); }
function renderHero(){
  var el=$('hero'); if(!el) return;
  var tl=RunLoad.loadTimeline(typeRuns(), LOAD_PARAMS);
  if(tl.length<2){
    el.style.borderLeftColor='var(--muted2)';
    el.innerHTML='<div class="rdx-hero-badge" style="color:var(--muted2)"><span class="rdx-hero-dot" style="background:var(--muted2)"></span>Building your baseline</div>'+
      '<div class="rdx-hero-read">Not enough run history yet to model your training load. Import a few more weeks of activities and your day-to-day guidance will show up here.</div>';
    return;
  }
  var pct=leverPct();
  // 1-, 3-, 7-day load averages vs the 28-day baseline. The short windows weight
  // the recent days heavily: one big day spikes the 1-day, a hard block the
  // 3-day, a sustained ramp the 7-day — each compared to the 28-day base rate.
  var d1=avgLast(tl,1), d3=avgLast(tl,3), d7=avgLast(tl,7), d28=avgLast(tl,28);
  var base = d28>0 ? d28 : null;
  var r1=base?d1/base:null, r3=base?d3/base:null, r7=base?d7/base:null;
  var demoOn=false;
  // Admin demo override: swap in a fixed scenario's windows (real data untouched).
  if(DEMO && DEMO_PRESETS[DEMO]){
    demoOn=true; var sc=DEMO_PRESETS[DEMO];
    if(sc.nullBase){ base=null; d1=d3=d7=d28=0; r1=r3=r7=null; }
    else { base=sc.base; d28=sc.base; r1=sc.r1; r3=sc.r3; r7=sc.r7; d1=r1*base; d3=r3*base; d7=r7*base; }
  }
  var col1=acwrColor(r1), col3=acwrColor(r3), col7=acwrColor(r7);

  // Typical single-run Impact Load (median of the last ~6 weeks of runs) — used to turn the daily
  // load budget into a concrete session size. Falls back to the 28-day daily base × 1.4 (a rough
  // per-run figure) when there isn't enough per-run data or a demo scenario is forcing the windows.
  var lastTs=tl[tl.length-1].ts;
  var loads = demoOn ? [] : typeRuns().filter(function(r){ return r.ts>=lastTs-42*864e5; })
    .map(function(r){ return RunLoad.impactLoad(r, LOAD_PARAMS); }).filter(function(v){ return v!=null && v>0; });
  var typical = loads.length>=3 ? RunLoad.median(loads) : (base?base*1.4:6);

  // Acute-curve trajectory: how fast the 7-day EWMA acute load is climbing, as a fractional change
  // per week. A steep, sustained rise is a leading injury-risk signal the point-in-time ACWR misses —
  // acute can rocket up from below chronic, blow past it and keep climbing while the ratio still reads
  // "in band." We flag it as "climbing hot" once acute is also at/above chronic (not just rebuilding
  // from a low base, where a fast ramp is expected and healthy).
  var last=tl[tl.length-1];
  var acuteNow=last.acute||0, chronicNow=last.chronic||0;
  var bk=Math.min(7, tl.length-1);
  var aPast=(!demoOn && bk>=4) ? (tl[tl.length-1-bk].acute||0) : 0;
  var rampPerWk = aPast>0 ? (Math.pow(acuteNow/aPast, 7/bk)-1) : null;
  var acwrNow = chronicNow>0 ? acuteNow/chronicNow : null;
  var climbingHot = rampPerWk!=null && rampPerWk>=0.15 && acwrNow!=null && acwrNow>=0.95;

  var head, accent, doHtml;
  if(base==null){
    head='Building your baseline'; accent='var(--muted2)';
    doHtml='<div class="rdx-do-line">While we learn your baseline, easy <span class="lever">Lever runs</span> at '+pct+'% body-weight support are a great way to bank low-impact volume — add a couple and your day-to-day guidance sharpens up fast.</div>';
  } else {
    // Recovery state from the recent-load ratios → session volume band (× typical run), an intensity
    // call, and how hard we lean on the Lever. Driven by the MAX of the 1/3/7-day ratios so a loaded
    // recent block counts even when the weekly average looks flat. Volume band is anchored to the
    // chronic base (the 0.8–1.3 safe band) and shifted by how loaded the last few days have been.
    var loMult, hiMult, intensity, leverNote;
    var maxR=Math.max(r1,r3,r7);
    var rampWkTxt = rampPerWk!=null ? Math.round(rampPerWk*100)+'%' : '';
    if(maxR>=1.5 || (climbingHot && rampPerWk>=0.25 && acwrNow>=1.2)){
      accent='var(--bad)'; head='Overreaching — recover next'; loMult=0.3; hiMult=0.6;
      intensity='<b>Recovery day.</b> Your recent load has pushed past your safe range'+(climbingHot?' and is still climbing fast (about +'+rampWkTxt+'/week)':'')+' — keep it truly easy, or take the day off.';
      leverNote='<b>Strongly suggest the Lever today.</b> At '+pct+'% support you keep the full aerobic stimulus while your legs rebuild at a fraction of the impact.';
    } else if(maxR>=1.3){
      accent='var(--gold)'; head='At your ceiling — ease off'; loMult=0.6; hiMult=0.9;
      intensity='<b>Keep it easy today.</b> You’re at the top of your safe range'+(climbingHot?', and your acute load is still rising fast (about +'+rampWkTxt+'/week)':'')+' — no more hard efforts until it settles.';
      leverNote='<b>Great day for the Lever.</b> At '+pct+'% support you hold onto the volume while the per-step impact comes off your legs.';
    } else if(climbingHot){
      accent='var(--gold)'; head='Climbing fast — ease the ramp'; loMult=0.6; hiMult=0.9;
      intensity='<b>Ease the rate of climb.</b> Your acute load is rising fast — about <b>+'+rampWkTxt+'/week</b> — and has climbed above your chronic base. The ratio is still in range, but a steep, sustained ramp like this is what typically precedes overreaching. Flatten the curve for a few days before you add more.';
      leverNote='<b>Prime time for the Lever.</b> At '+pct+'% support you can hold your volume flat — or even keep it climbing — while the impact your legs actually absorb stops rising.';
    } else if(maxR>=1.15){
      accent='var(--gold)'; head='Approaching your ceiling'; loMult=0.7; hiMult=1.0;
      intensity='<b>Hold steady — keep it easy.</b> You’ve stacked a few solid days and you’re near the top of your range. An easy run fits, but hold off on another hard effort until the load settles.';
      leverNote='<b>A Lever day fits well here</b> — at '+pct+'% support you keep the volume coming without adding to the impact you’re already carrying.';
    } else if(r7<0.8){
      accent='var(--warn)'; head='Room to build'; loMult=0.9; hiMult=1.3;
      intensity='<b>Room to build.</b> Your load has eased off — an easy run, a longer run, or a workout all fit today.';
      leverNote='The <span class="lever">Lever</span> at '+pct+'% support is a low-impact way to add sessions as you ramp back up.';
    } else {
      accent='var(--good)'; head='In the safe band'; loMult=0.8; hiMult=1.15;
      intensity='<b>You’re recovered.</b> An easy run or a workout both fit today — you’re right in your safe zone.';
      leverNote='Lever optional — a <span class="lever">Lever session</span> at '+pct+'% support is a nice way to bank extra easy volume with almost no impact cost.';
    }
    var lo=typical*loMult, hi=typical*hiMult;
    // Translate the top-end budget (hi, in IAD miles) into concrete run options:
    //   flat easy outside ≈ 1 impact mi/mi · rolling/hilly inflates ~25% · Lever offloads, so more
    //   actual miles fit under the same impact budget (lever mi = budget ÷ %BW-on-legs).
    var flat=hi, hilly=hi/1.25, lever=hi/(pct/100);
    doHtml='<div class="rdx-do-line">'+intensity+'</div>'+
      '<div class="rdx-do-vol">Aim for <b>'+fmtMi(lo)+'–'+fmtMi(hi)+' impact-adjusted miles</b> today. At the top end, that’s about:</div>'+
      '<ul class="rdx-do-opts">'+
        '<li><b>'+fmtMi(flat)+' mi</b> flat easy outside</li>'+
        '<li><b>'+fmtMi(hilly)+' mi</b> hilly outside</li>'+
        '<li class="lever-opt"><b>'+fmtMi(lever)+' mi</b> on the Lever · '+pct+'% BW</li>'+
      '</ul>'+
      '<div class="rdx-do-lever">'+leverNote+'</div>';
  }

  // The four tiles carry the numbers (1-/3-/7-day load vs the 28-day base, each
  // tinted by how it compares); the recommendation below weighs all three.
  var statTile=function(k,val,c,sub){ return '<div class="rdx-hero-stat"><div class="k">'+k+'</div><div class="v" style="color:'+c+'">'+val.toFixed(1)+'</div>'+(sub?'<div class="x" style="color:'+c+'">'+sub+'</div>':'')+'</div>'; };
  // Acute-trend tile: weekly rate of rise of the acute curve, tinted by how steep (rising fast is a
  // leading risk even when the ratio is still in band). '—' when there isn't enough history.
  var rampTxt = rampPerWk==null ? '—' : (rampPerWk>=0?'+':'')+Math.round(rampPerWk*100)+'%';
  var rampCol = rampPerWk==null ? 'var(--muted2)' : rampPerWk>=0.20 ? 'var(--bad)' : rampPerWk>=0.10 ? 'var(--gold)' : rampPerWk<=-0.05 ? 'var(--good)' : 'var(--muted2)';
  var rampTile='<div class="rdx-hero-stat"><div class="k">Acute trend</div><div class="v" style="color:'+rampCol+';font-size:16px">'+rampTxt+'</div><div class="x" style="color:'+rampCol+'">per week</div></div>';
  // Easy-baseline-pace tile: the P₀ every run's Impact Load pace term is scored against —
  // NOT an average of recent runs. Median grade-adjusted (flat-equivalent) easy-run pace.
  var baseTile=LOAD_PARAMS&&LOAD_PARAMS.basePaceSec?
    '<div class="rdx-hero-stat" title="Your Impact Load baseline: the median grade-adjusted (flat-equivalent) pace of your easy runs. Every run’s pace is compared against this in the load equation — it is a calibration anchor, not your recent average pace.">'+
      '<div class="k">Easy base pace</div>'+
      '<div class="v" style="color:var(--cyan)">'+fmtPace(LOAD_PARAMS.basePaceSec)+'</div>'+
      '<div class="x" style="color:var(--muted2)">/mi · grade-adj · load baseline</div>'+
    '</div>':'';
  el.style.borderLeftColor=accent;
  el.innerHTML=
    '<div class="rdx-hero-badge" style="color:'+accent+'"><span class="rdx-hero-dot" style="background:'+accent+'"></span>'+head+'</div>'+
    '<div class="rdx-hero-stats">'+
      statTile('Last day', d1, col1, r1!=null?r1.toFixed(1)+'× base':'')+
      statTile('3-day avg', d3, col3, r3!=null?r3.toFixed(1)+'× base':'')+
      statTile('7-day avg', d7, col7, r7!=null?r7.toFixed(1)+'× base':'')+
      statTile('28-day base', d28, 'var(--muted2)', 'IAD mi/day')+
      rampTile+
      baseTile+
    '</div>'+
    '<div class="rdx-hero-do"><span class="do-hd">What to do next</span>'+doHtml+'</div>';
}
// Admin-only scenario switcher above the hero (demo control).
function renderDemoBar(){
  if(!ADMIN) return; var el=$('demobar'); if(!el) return;
  var items=[{key:'',label:'● Live'}].concat(DEMO_LIST);
  el.innerHTML='<span class="lbl">Demo</span>'+items.map(function(it){
    var on=(DEMO||'')===it.key;
    return '<span class="rdx-chip'+(on?' on':'')+'" data-demo="'+it.key+'">'+it.label+'</span>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('.rdx-chip'),function(c){
    c.onclick=function(){ DEMO=this.getAttribute('data-demo')||null; renderHero(); renderDemoBar(); };
  });
}

/* ---------- unified chart: load (default) or metric trend ---------- */
var LOAD_HINT='Load is in <b>Impact Adjusted Distance (IAD miles)</b> — distance weighted by pace and by per-step impact (duty factor = cadence × ground-contact time vs your baseline). One easy flat mile = 1 IAD mile; a hard or hilly mile counts as more. <b>Acute (7d)</b> and <b>chronic (28d)</b> are rolling daily averages in IAD mi/day. This is a <b>load measure, not an injury prediction</b> — auto-calibrated from your easy runs; 0.8–1.3 is the commonly cited safe band.';
function renderChart(){
  var sel=$('chartView'); if(!sel) return;
  var v=sel.value, isLoad=(v==='load');
  $('chartView2Wrap').style.display=isLoad?'none':'flex';
  $('dispWrap').style.display=isLoad?'none':'flex';
  if(isLoad) renderLoadChart(); else renderMetricChart();
}
function renderLoadChart(){
  var legEl=$('chartLegend'), chartEl=$('chartBox'), hintEl=$('chartHint');
  if(!chartEl) return;
  if(hintEl) hintEl.innerHTML=LOAD_HINT;
  var full=RunLoad.loadTimeline(typeRuns(), LOAD_PARAMS);
  if(full.length<2){ legEl.innerHTML=''; chartEl.innerHTML='<div class="rdx-chart-empty">Not enough history to model load yet.</div>'; return; }
  var from=parseDate($('tFrom').value), to=parseDate($('tTo').value);
  var f0=from?from.getTime():full[0].ts, f1=to?to.getTime():full[full.length-1].ts;
  var tl=full.filter(function(d){return d.ts>=f0&&d.ts<=f1;});
  if(tl.length<2) tl=full;                    // window too narrow — show everything
  var last=tl[tl.length-1];
  var W=720,H=210,padL=40,padR=12,padT=12,padB=24,innerW=W-padL-padR,innerH=H-padT-padB;
  var t0=tl[0].ts,t1=last.ts,span=Math.max(1,t1-t0);
  var ymax=Math.max.apply(null,tl.map(function(d){return Math.max(d.acute,d.chronic*1.3);}))*1.05||1;
  var xOf=function(ts){return padL+((ts-t0)/span)*innerW;};
  var yOf=function(v){return padT+innerH-(v/ymax)*innerH;};
  var acuteS=smoothArr(tl.map(function(d){return d.acute;}),5), chronicS=smoothArr(tl.map(function(d){return d.chronic;}),5);
  var xs=tl.map(function(d){return xOf(d.ts);});
  var bandTop=tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]*1.3).toFixed(1);});
  var bandBot=tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]*0.8).toFixed(1);}).reverse();
  var band='<polygon points="'+bandTop.concat(bandBot).join(' ')+'" fill="rgba(34,199,138,0.16)" stroke="rgba(34,199,138,0.3)" stroke-width="0.5"/>';
  var chronicLn='<polyline points="'+tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]).toFixed(1);}).join(' ')+'" fill="none" stroke="#8b7cf8" stroke-width="2.2" stroke-linejoin="round"/>';
  var acuteLn=coloredPath(xs, acuteS.map(yOf), tl.map(function(d){return acuteSegColor(d.acwr);}), 2.6);
  var grid='';
  var gridStroke=getComputedStyle(document.documentElement).getPropertyValue('--border').trim()||'rgba(255,255,255,0.06)';
  for(var g=0;g<=3;g++){ var f=g/3, yy=(padT+innerH-f*innerH).toFixed(1);
    grid+='<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'" stroke="'+gridStroke+'"/>';
    grid+='<text x="'+(padL-6)+'" y="'+(parseFloat(yy)+3).toFixed(1)+'" text-anchor="end" font-size="9" font-family="ui-monospace,monospace" fill="#6e7a9a">'+(ymax*f).toFixed(0)+'</text>'; }
  var xlab='';
  axisTicks(t0,t1).forEach(function(ts,idx){ xlab+='<text x="'+xOf(ts).toFixed(1)+'" y="'+(H-7)+'" text-anchor="middle" font-size="8.5" font-family="ui-monospace,monospace" fill="#6e7a9a">'+axisLabel(ts,idx)+'</text>'; });
  legEl.innerHTML='<span class="rdx-legend-item"><span class="rdx-legend-sw" style="background:#00e5c8"></span>Acute (7d)</span><span class="rdx-legend-item"><span class="rdx-legend-sw" style="background:#8b7cf8"></span>Chronic (28d)</span><span class="rdx-legend-item"><span class="rdx-legend-sw" style="background:rgba(34,199,138,0.5)"></span>Safe band</span><span class="rdx-legend-item" style="color:var(--muted)">acute shifts green above chronic, amber/red above the band</span>';
  chartEl.innerHTML='<svg class="rdx-chart-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Mechanical load timeline">'+grid+band+chronicLn+acuteLn+xlab+RunLoad.eventOverlaySVG(events(),t0,t1,padL,innerW,padT,innerH)+'</svg>';
}
function renderMetricChart(){
  var chart=$('chartBox'), legend=$('chartLegend'), hintEl=$('chartHint');
  if(!chart) return;
  if(hintEl) hintEl.innerHTML='Per-run values over the selected range. <b>Smooth</b> draws the trend line; <b>Hide outliers</b> drops glitch values (keeps logged races/injuries and detected hard efforts); <b>Points</b> shows every run.';
  var i1=$('chartView').value, i2=$('chartView2').value;
  var from=parseDate($('tFrom').value), to=parseDate($('tTo').value);
  var series=[];
  if(i1!=='') series.push({m:METRICS[+i1],color:'#00e5c8'});
  if(i2!==''&&i2!==i1) series.push({m:METRICS[+i2],color:'#f5c842'});
  var evMap=new Map(); events().forEach(function(e){ if(e.type==='timeoff') return; evMap.set(new Date(e.ts).toISOString().slice(0,10), e.type==='injury'?'injury':'race'); });
  var evType=function(p){ return evMap.get(p.date.toISOString().slice(0,10))||null; };
  var maxIds=RunLoad.maxEffortIds(typeRuns());
  var legHtml=series.map(function(s){return '<span class="rdx-legend-item"><span class="rdx-legend-sw" style="background:'+s.color+'"></span>'+s.m.label+(s.m.unit?' ('+s.m.unit+')':'')+'</span>';}).join('');
  if(evMap.size||maxIds.size) legHtml+='<span class="rdx-legend-item" style="color:var(--muted)"><span class="rdx-legend-sw" style="background:#22c78a"></span>race<span class="rdx-legend-sw" style="background:#f55050;margin-left:8px"></span>injury<span class="rdx-legend-ring" style="margin-left:8px"></span>hard effort</span>';
  legend.innerHTML=legHtml;
  if(!series.length){ chart.innerHTML='<div class="rdx-chart-empty">Select a metric to plot.</div>'; return; }
  if(!from||!to||to.getTime()<=from.getTime()){ chart.innerHTML='<div class="rdx-chart-empty">Pick a valid date range.</div>'; return; }
  var hideOut=$('hideOutliers').classList.contains('on');
  var smooth=$('smooth').classList.contains('on');
  var showPts=$('points').classList.contains('on');
  var runs=runsInF(new Date(from.getTime()-DAY),to);
  var evColor=function(t){ return t==='injury'?'#f55050':'#22c78a'; };
  series.forEach(function(s){
    var all=runs.map(function(r){return {ts:r.ts,v:s.m.calc(r),date:r.date,id:r.id,dist:r.distMi,pace:r.paceSec,title:r.title};}).filter(function(p){return p.v!=null&&!isNaN(p.v);}).sort(function(a,b){return a.ts-b.ts;});
    var flo=-Infinity, fhi=Infinity;
    if(all.length>=5){ var vals=all.map(function(p){return p.v;}).slice().sort(function(a,b){return a-b;}); var q1=quantile(vals,0.25), q3=quantile(vals,0.75), iqr=q3-q1; if(iqr>0){ flo=q1-1.5*iqr; fhi=q3+1.5*iqr; } }
    var inF=function(p){ return p.v>=flo&&p.v<=fhi; };
    s.line = hideOut ? all.filter(inF) : all;
    s.dots = hideOut ? all.filter(function(p){return inF(p)||evType(p)||maxIds.has(p.id);}) : all;
    var scaleSrc = s.dots.length ? s.dots : all;
    if(scaleSrc.length){ var mn=Math.min.apply(null,scaleSrc.map(function(p){return p.v;})), mx=Math.max.apply(null,scaleSrc.map(function(p){return p.v;})); if(mn===mx){mn-=1;mx+=1;} var pad=(mx-mn)*0.08; s.lo=mn-pad; s.hi=mx+pad; }
  });
  var have=series.filter(function(s){return s.dots.length;});
  if(!have.length){ chart.innerHTML='<div class="rdx-chart-empty">No runs with this metric in range.</div>'; return; }
  var W=720,H=240,padL=42,padR=series.length>1?46:12,padT=12,padB=26,innerW=W-padL-padR,innerH=H-padT-padB;
  var t0=from.getTime(),t1=to.getTime();
  var xOf=function(ts){return padL+((ts-t0)/(t1-t0))*innerW;};
  var yOf=function(v,s){return padT+innerH-((v-s.lo)/(s.hi-s.lo))*innerH;};
  var grid='';
  var gridStroke=getComputedStyle(document.documentElement).getPropertyValue('--border').trim()||'rgba(255,255,255,0.06)';
  for(var g=0;g<=4;g++){
    var f=g/4, yy=(padT+innerH-f*innerH).toFixed(1);
    grid+='<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'" stroke="'+gridStroke+'" stroke-width="1"/>';
    grid+='<text x="'+(padL-6)+'" y="'+(parseFloat(yy)+3).toFixed(1)+'" text-anchor="end" font-size="9" font-family="ui-monospace,monospace" fill="#6e7a9a">'+tickFmt(have[0].m,have[0].lo+(have[0].hi-have[0].lo)*f)+'</text>';
    if(series.length>1&&series[1].dots.length) grid+='<text x="'+(W-padR+6)+'" y="'+(parseFloat(yy)+3).toFixed(1)+'" text-anchor="start" font-size="9" font-family="ui-monospace,monospace" fill="#f5c842">'+tickFmt(series[1].m,series[1].lo+(series[1].hi-series[1].lo)*f)+'</text>';
  }
  var xlab='';
  axisTicks(t0,t1).forEach(function(ts,idx){ if(ts<t0||ts>t1) return; xlab+='<text x="'+xOf(ts).toFixed(1)+'" y="'+(H-7)+'" text-anchor="middle" font-size="8.5" font-family="ui-monospace,monospace" fill="#6e7a9a">'+axisLabel(ts,idx)+'</text>'; });
  var ea=function(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var lines='', hits='';
  var haloStroke=document.documentElement.getAttribute('data-theme')==='light'?'rgba(0,0,0,0.30)':'rgba(255,255,255,0.85)';
  have.forEach(function(s){
    var lineSrc=smooth?smoothPts(s.line):s.line;
    if(lineSrc.length>1){ var pts=lineSrc.map(function(p){return xOf(p.ts).toFixed(1)+','+yOf(p.v,s).toFixed(1);});
      lines+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+s.color+'" stroke-width="'+(smooth?2.6:2)+'" stroke-linejoin="round" stroke-linecap="round"/>'; }
    lines+=s.dots.map(function(p){
      var t=evType(p), isMax=!t&&maxIds.has(p.id), cx=xOf(p.ts).toFixed(1), cy=yOf(p.v,s).toFixed(1);
      if(t) return '<circle cx="'+cx+'" cy="'+cy+'" r="3.8" fill="'+evColor(t)+'" stroke="'+haloStroke+'" stroke-width="1.2"/>';
      if(isMax) return showPts ? '<circle cx="'+cx+'" cy="'+cy+'" r="3.8" fill="none" stroke="#f5c842" stroke-width="1.6"/>' : '';
      return showPts ? '<circle cx="'+cx+'" cy="'+cy+'" r="2.4" fill="'+s.color+'" fill-opacity="'+(smooth?'0.5':'1')+'"/>' : '';
    }).join('');
    hits+=s.dots.map(function(p){
      var t=evType(p), kind=t||(maxIds.has(p.id)?'max':''), cx=xOf(p.ts).toFixed(1), cy=yOf(p.v,s).toFixed(1);
      var val=tickFmt(s.m,p.v)+(s.m.unit?' '+s.m.unit:'');
      var ctx=(p.dist!=null?p.dist.toFixed(1)+' mi':''); if(p.pace){ ctx+=(ctx?' · ':'')+fmtPace(p.pace)+'/mi'; } if(p.title){ ctx+=(ctx?' · ':'')+p.title; }
      return '<circle class="rdx-hit" cx="'+cx+'" cy="'+cy+'" r="7" fill="rgba(0,0,0,0)" data-date="'+ea(p.date.toISOString().slice(0,10))+'" data-kind="'+kind+'" data-metric="'+ea(s.m.label)+'" data-val="'+ea(val)+'" data-ctx="'+ea(ctx)+'"/>';
    }).join('');
  });
  chart.innerHTML='<svg class="rdx-chart-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Run metric trend">'+grid+xlab+lines+RunLoad.eventOverlaySVG(events(),t0,t1,padL,innerW,padT,innerH)+hits+'</svg>';
  wireChartTip(chart);
}
function chartTipHTML(c){
  var k=c.dataset.kind, m={race:['Race','#22c78a'],injury:['Injury','#f55050'],max:['Hard Effort','#f5c842']}[k];
  return '<div class="rdx-tip-top">'+c.dataset.date+(m?' <span class="rdx-tip-chip" style="color:'+m[1]+';border-color:'+m[1]+'">'+m[0]+'</span>':'')+'</div>'
    +'<div class="rdx-tip-val">'+c.dataset.metric+' · <b>'+c.dataset.val+'</b></div>'
    +(c.dataset.ctx?'<div class="rdx-tip-ctx">'+c.dataset.ctx+'</div>':'');
}
function wireChartTip(chart){
  var tip=document.createElement('div'); tip.className='rdx-chart-tip'; chart.appendChild(tip);
  chart.onmousemove=function(e){ var c=e.target.closest&&e.target.closest('.rdx-hit'); if(!c){ tip.classList.remove('on'); return; }
    tip.innerHTML=chartTipHTML(c); tip.classList.add('on');
    var r=chart.getBoundingClientRect(), x=e.clientX-r.left+14, y=e.clientY-r.top+14;
    if(x+tip.offsetWidth>r.width) x=e.clientX-r.left-tip.offsetWidth-14;
    if(y+tip.offsetHeight>r.height) y=e.clientY-r.top-tip.offsetHeight-14;
    tip.style.left=Math.max(0,x)+'px'; tip.style.top=Math.max(0,y)+'px'; };
  chart.onmouseleave=function(){ tip.classList.remove('on'); };
}

/* ---------- injury pattern report ---------- */
// Renders InjuryPatterns.analyze() (shared/injury-patterns.js): every logged
// injury's lead-up window scored against the pattern registry, each pattern's
// base rate from control windows across the rest of the history, and big
// UNexplained volume drops (not near a race / logged injury / logged time
// off) offered as possible unlogged setbacks with a one-click "log as injury".
function renderPatterns(){
  var box=$('patternsBox'); if(!box) return;
  if(!window.InjuryPatterns || !LOAD_PARAMS){ box.innerHTML=''; return; }
  var res=InjuryPatterns.analyze(typeRuns(), events(), LOAD_PARAMS);
  var nInj=events().filter(function(e){return e.type==='injury';}).length;
  if(!res.ok){
    box.innerHTML='<div class="rdx-chart-empty">'+(res.reason==='history'
      ? 'Not enough continuous run history to analyze injury patterns yet — about 10 weeks of data unlocks this report.'
      : 'Import run history to unlock the injury pattern report.')+'</div>';
    return;
  }
  var drops=res.drops.filter(function(d){return !d.explained;});
  if(!res.meta.nEval && !drops.length){
    box.innerHTML='<div class="rdx-chart-empty">'+(nInj
      ? 'The logged injuries fall outside the stored run history, so there is no training window to analyze — import the runs from the weeks before each injury.'
      : 'No injuries logged yet. Add past injuries under ⚙ Settings → Performance &amp; injury history, and this report analyzes the training that led up to each one. Log <b>overuse injuries</b> (and, optionally, significant illnesses that stopped training) — leave out acute injuries that didn’t come from running, so they don’t skew the analysis.')+'</div>';
    return;
  }
  var html='';
  if(res.meta.nEval){
    html+='<div class="rdx-pat-intro">Compared the '+res.meta.acuteWinDays+' days (and trailing weeks) leading into '+
      '<b>'+res.meta.nEval+'</b> logged injur'+(res.meta.nEval>1?'ies':'y')+' against <b>'+res.meta.nControls+
      '</b> control windows sampled from the rest of the stored history. A pattern matters when it fired before injuries far more often than its normal-week base rate.</div>';
    var hit=res.patterns.filter(function(p){return p.injHits>0;});
    if(hit.length){
      html+=hit.map(function(p){
        var liftTxt=p.lift==null?'—':'×'+(p.lift>=10?Math.round(p.lift):p.lift.toFixed(1));
        var col=(p.lift!=null&&p.lift>=2)?'var(--bad)':(p.lift!=null&&p.lift>=1.2)?'var(--gold)':'var(--muted2)';
        return '<div class="rdx-pat-row">'+
          '<div class="rdx-pat-main"><span class="rdx-pat-name">'+p.name+'</span><span class="rdx-pat-desc">'+p.desc+'</span></div>'+
          '<div class="rdx-pat-stats">'+
            '<span class="rdx-pat-stat">before <b>'+p.injHits+' of '+p.injEval+'</b> injuries</span>'+
            '<span class="rdx-pat-stat">'+(p.ctrlRate==null?'—':Math.round(p.ctrlRate*100)+'% of normal weeks')+'</span>'+
            '<span class="rdx-pat-lift" style="color:'+col+';border-color:'+col+'">'+liftTxt+' vs normal'+(p.lowConf?' · few controls':'')+'</span>'+
          '</div></div>';
      }).join('');
    } else {
      html+='<div class="rdx-chart-empty">None of the current pattern set fired before the logged injuries — the lead-ups looked like typical training weeks. As the pattern registry grows this may change.</div>';
    }
    var co=res.combos.filter(function(c){return c.injHits>0;});
    if(co.length){
      html+='<div class="rdx-pat-sub">Combinations</div>'+co.slice(0,4).map(function(c){
        var liftTxt=c.lift==null?'—':'×'+(c.lift>=10?Math.round(c.lift):c.lift.toFixed(1));
        return '<div class="rdx-pat-row"><div class="rdx-pat-main"><span class="rdx-pat-name">'+c.names.join(' + ')+'</span><span class="rdx-pat-desc">both fired in the same lead-up</span></div>'+
          '<div class="rdx-pat-stats"><span class="rdx-pat-stat">before <b>'+c.injHits+' of '+c.injEval+'</b> injuries</span>'+
          '<span class="rdx-pat-stat">'+(c.ctrlRate==null?'—':Math.round(c.ctrlRate*100)+'% of normal weeks')+'</span>'+
          '<span class="rdx-pat-lift" style="color:var(--bad);border-color:var(--bad)">'+liftTxt+' vs normal</span></div></div>';
      }).join('');
    }
    html+='<div class="rdx-pat-sub">Each injury, up close</div><div class="rdx-cards">'+res.injuries.map(function(c){
      var d=ymd(new Date(c.event.ts))+(c.event.endTs?' → '+ymd(new Date(c.event.endTs)):'');
      var inner;
      if(!c.ok) inner='<div class="rdx-pat-flagval">outside the stored run history — no training window to analyze</div>';
      else{
        var fired=c.flags.filter(function(f){return f.fired;});
        inner=fired.length
          ? fired.map(function(f){return '<div class="rdx-pat-flag"><b>'+f.name+'</b><span>'+f.value+'</span></div>';}).join('')
          : '<div class="rdx-pat-flagval">no flagged pattern — the lead-up looked like typical training</div>';
      }
      return '<div class="rdx-card"><div class="rdx-win" style="color:var(--bad)">⚠ '+d+(c.event.note?' · '+esc(c.event.note):'')+'</div>'+inner+'</div>';
    }).join('')+'</div>';
  }
  if(drops.length){
    html+='<div class="rdx-pat-sub">Unexplained training drops · possible unlogged setbacks</div>'+
      '<div class="rdx-pat-dropintro">Sharp volume drops with no race, logged injury or planned downtime nearby — a forced reduction is often an unlogged setback. Logging one adds its lead-up to the analysis above; if it was a planned break, log it as Planned Downtime instead and it disappears from this list.</div>'+
      '<div class="rdx-cards">'+drops.map(function(d){
        var fired=(d.flags||[]).filter(function(f){return f.fired;});
        return '<div class="rdx-card">'+
          '<div class="rdx-win" style="color:var(--warn)">▼ '+ymd(new Date(d.t0))+' → '+(d.ongoing?'now':ymd(new Date(d.t1)))+'</div>'+
          '<div class="rdx-row">Volume drop <b>−'+Math.round(d.pct*100)+'%</b></div>'+
          '<div class="rdx-row">Duration <b>'+d.weeks+(d.capped?'+':'')+' wk'+(d.weeks>1?'s':'')+(d.ongoing?' · ongoing':'')+'</b></div>'+
          (fired.length?'<div class="rdx-pat-flagval" style="margin-top:6px">in its lead-up: '+fired.map(function(f){return f.name;}).join(' · ')+'</div>':'')+
          '<button class="rdx-btn rdx-btn-sm rdx-drop-log" style="margin-top:10px">+ log as event</button>'+
          '<div class="rdx-drop-form" style="display:none">'+
            '<div class="rdx-df-field"><label>Type</label><select class="rdx-df-type"><option value="injury">Injury</option><option value="race">Race</option><option value="timeoff">Planned Downtime</option></select></div>'+
            '<div class="rdx-df-field"><label>Start</label><input type="date" class="rdx-df-start" value="'+ymd(new Date(d.t0))+'"></div>'+
            '<div class="rdx-df-field rdx-df-endf"><label>End (optional)</label><input type="date" class="rdx-df-end" value="'+(d.ongoing?'':ymd(new Date(d.t1)))+'"></div>'+
            '<div class="rdx-df-field"><label>Note</label><input type="text" class="rdx-df-note" placeholder="e.g. calf strain / off-season break"></div>'+
            '<button class="rdx-btn rdx-btn-sm rdx-df-save">save</button>'+
          '</div>'+
        '</div>';
      }).join('')+'</div>';
  }
  html+='<p class="rdx-hint">Retrospective and correlational — these are load patterns that showed up before logged injuries, not causes and not an injury prediction. With a handful of injuries the sample is small; every added injury, logged setback and month of history sharpens the report. Log only <b>overuse injuries</b> (plus, optionally, significant illnesses) — acute injuries that didn’t come from running would skew these base rates. Detectors and thresholds are transparent, tunable heuristics in <code>shared/injury-patterns.js</code>.</p>';
  box.innerHTML=html;
  Array.prototype.forEach.call(box.querySelectorAll('.rdx-drop-log'),function(b){
    b.onclick=function(){
      var form=this.nextElementSibling, open=form.style.display==='none';
      form.style.display=open?'':'none';
      this.textContent=open?'cancel':'+ log as event';
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll('.rdx-drop-form'),function(form){
    var type=form.querySelector('.rdx-df-type'), start=form.querySelector('.rdx-df-start'), end=form.querySelector('.rdx-df-end'), endF=form.querySelector('.rdx-df-endf');
    type.onchange=function(){ endF.style.display=this.value==='race'?'none':''; if(this.value==='race') end.value=''; };
    form.querySelector('.rdx-df-save').onclick=function(){
      start.classList.remove('rdx-df-err'); end.classList.remove('rdx-df-err');
      var s=parseDate(start.value);
      if(!s){ start.classList.add('rdx-df-err'); return; }
      var note=(form.querySelector('.rdx-df-note').value||'').trim();
      var e={ id:Date.now(), type:type.value, ts:s.getTime(),
              note:note||(type.value==='injury'?'Setback — unexplained training drop':'') };
      if(type.value!=='race'){
        var en=parseDate(end.value);
        if(en){
          if(en.getTime()<=s.getTime()){ end.classList.add('rdx-df-err'); return; }
          e.endTs=en.getTime();
        }
      }
      var evs=events().slice(); evs.push(e);
      saveProfile({ runEvents:evs });
      renderEventsList(); refresh();
    };
  });
}

/* ---------- volume + form ---------- */
function renderAll(){
  var cards=$('cards'); if(!cards) return;
  cards.innerHTML=RUN_WINDOWS.map(function(w){
    var end=ANCHOR, start = w.days==null ? new Date(0) : new Date(end.getTime()-w.days*DAY);
    var lbl = w.days==null ? ('Stored · '+spanDays()+'d') : w.label;
    return summaryCard(lbl, summarize(runsInF(start,end)));
  }).join('');
}
function renderForm(){
  var tbl=$('ftable'); if(!tbl) return;
  var it=intensityState();
  var compare=$('formCompare').classList.contains('on');
  var cols;
  if(compare){
    var af=parseDate($('faFrom').value), at=parseDate($('faTo').value);
    var bf=parseDate($('fbFrom').value), bt=parseDate($('fbTo').value);
    var A=(af&&at)?filterIntensity(runsIn(new Date(af.getTime()-DAY),at),it.mode,it.cutoff):[];
    var B=(bf&&bt)?filterIntensity(runsIn(new Date(bf.getTime()-DAY),bt),it.mode,it.cutoff):[];
    cols=[{label:'Range A',runs:A},{label:'Range B',runs:B}];
  } else {
    cols=[{label:'Stored ('+spanDays()+' d)', runs:filterIntensity(runsIn(new Date(0), new Date(8.64e15)),it.mode,it.cutoff)}];
  }
  var visible=METRICS.filter(metricVisible);
  var head='<thead><tr><th>Metric</th>'+cols.map(function(c){return '<th>'+c.label+' <span class="rdx-munit">n='+c.runs.length+'</span></th>';}).join('')+(compare?'<th>Δ</th>':'')+'</tr></thead>';
  var body='<tbody>';
  visible.forEach(function(m){
    var vals=cols.map(function(c){return metricMean(c.runs,m);});
    body+='<tr><td><span class="rdx-mname">'+m.label+'</span>'+(m.unit?'<span class="rdx-munit">'+m.unit+'</span>':'')+'<div class="rdx-mdesc">'+m.desc+'</div></td>';
    vals.forEach(function(v){ body+='<td>'+fmtVal(v,m)+'</td>'; });
    if(compare) body+='<td>'+deltaHTML(vals[0],vals[1],m)+'</td>';
    body+='</tr>';
  });
  tbl.innerHTML=head+body+'</tbody>';

  var hidden=METRICS.filter(function(m){return !metricVisible(m);});
  var note=compare
    ? 'Comparing two date ranges (Δ = Range A − Range B). n = runs in each range after filters.'
    : 'Showing stored-history averages. Toggle “compare two ranges” to compare periods (Δ = Range A − Range B).';
  if(hidden.length){ var dev=RunDevices.byId(deviceId()); note+=' · Hidden for '+(dev?dev.label:'this device')+': '+hidden.map(function(m){return m.label;}).join(', ')+' (needs a chest strap/pod or not captured).'; }
  if(visible.some(function(m){return m.needsWeight;}) && weightKg()==null){ note+=' · Enter body weight in settings to show Peak Force in Newtons.'; }
  var hintEl=$('formHint'); if(hintEl) hintEl.textContent=note;
}
function renderTiles(){
  var el=$('formTiles'); if(!el) return;
  var it=intensityState(), end=ANCHOR||new Date();
  var cur =filterIntensity(runsIn(new Date(end.getTime()-90*DAY),end),it.mode,it.cutoff);
  var prev=filterIntensity(runsIn(new Date(end.getTime()-180*DAY),new Date(end.getTime()-90*DAY)),it.mode,it.cutoff);
  var pri=['cad','gct','vo','vratio','asym','stride','pace'];
  var byKey={}; METRICS.forEach(function(m){ byKey[m.key]=m; });
  var html=pri.map(function(k){
    var m=byKey[k]; if(!m||!metricVisible(m)) return '';
    var cv=metricMean(cur,m); if(cv==null) return '';
    var pv=metricMean(prev,m);
    var val=m.pace?fmtPace(cv):cv.toFixed(m.dec);
    return '<div class="rdx-tile"><div class="rdx-tile-lbl">'+m.label+'</div>'+
      '<div class="rdx-tile-val">'+val+(m.unit?'<span class="rdx-tile-unit">'+m.unit+'</span>':'')+'</div>'+
      '<div class="rdx-tile-delta">'+(deltaHTML(cv,pv,m)||'<span class="rdx-delta flat">— no prior</span>')+'</div></div>';
  }).join('');
  el.innerHTML=html||'<div class="rdx-chart-empty">No form metrics available for this device.</div>';
}

/* ---------- type filter ---------- */
function buildTypeChips(){
  var counts={};
  RAW.forEach(function(r){ var t=effType(r); counts[t]=(counts[t]||0)+1; });
  var types=Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];});
  types.forEach(function(t){ if(!KNOWN_TYPES.has(t)){ KNOWN_TYPES.add(t); ACTIVE_TYPES.add(t); } });
  var wrap=$('types'); if(!wrap) return; wrap.innerHTML='';
  types.forEach(function(tp){
    var c=document.createElement('span');
    c.className='rdx-chip'+(ACTIVE_TYPES.has(tp)?' on':''); c.textContent=tp+' ('+counts[tp]+')';
    c.onclick=function(){
      if(ACTIVE_TYPES.has(tp)){ACTIVE_TYPES.delete(tp);c.classList.remove('on');}
      else{ACTIVE_TYPES.add(tp);c.classList.add('on');}
      refresh();
    };
    wrap.appendChild(c);
  });
}

/* ---------- orchestration ---------- */
function refresh(){ if(RAW.length){ annotateLever(); LOAD_PARAMS=computeLoadParams(); renderHero(); renderChart(); renderPatterns(); renderTiles(); renderForm(); renderAll(); } }
function setRangeChip(active){ Array.prototype.forEach.call($all('#rdx-rangeChips .rdx-chip'),function(c){ c.classList.toggle('on', c.getAttribute('data-range')===active); }); }
function applyRange(r){
  if(!RAW.length) return;
  var max=ANCHOR||new Date(RAW[RAW.length-1].ts);
  var from=(r==='all')?new Date(RAW[0].ts):new Date(max.getTime()-parseInt(r,10)*30.44*DAY);
  $('tFrom').value=ymd(from); $('tTo').value=ymd(max);
  setRangeChip(r); renderChart();
}
function showSections(hasData){
  var gb=$('gearBtn'); if(gb){ gb.style.display=hasData?'inline-flex':'none'; gb.classList.remove('on'); }
  var panel=$('settingsPanel'); if(panel) panel.style.display='none';   // collapsed by default
  var emptyEl=$('sec-empty'); if(emptyEl) emptyEl.classList.toggle('show',!hasData);
  ['sec-hero','sec-chart','sec-patterns','sec-form','sec-summary'].forEach(function(id){
    var e=$(id); if(e) e.classList.toggle('show',hasData);
  });
}

function renderLoaded(){
  if(!RAW.length){ showSections(false); return; }
  var dates=RAW.map(function(r){return r.date;}).sort(function(a,b){return a-b;});
  var min=dates[0], max=dates[dates.length-1];
  ANCHOR=new Date(max);
  annotateLever();
  buildTypeChips();
  showSections(true);
  renderDemoBar();
  var lm=$('loadMethod'); if(lm && window.RunLoad) lm.innerHTML=RunLoad.methodologyHTML();
  $('filenote').textContent=RAW.length+' runs stored · '+ymd(min)+' → '+ymd(max);
  $('anchor').value=ymd(max);
  $('faFrom').value=ymd(new Date(max.getTime()-90*DAY));
  $('faTo').value=ymd(max);
  $('fbFrom').value=ymd(new Date(max.getTime()-180*DAY));
  $('fbTo').value=ymd(new Date(max.getTime()-90*DAY));
  var byBrand={}; RunDevices.LIST.forEach(function(d){ (byBrand[d.brand]=byBrand[d.brand]||[]).push(d); });
  $('device').innerHTML='<option value="">Device: all metrics</option>'+Object.keys(byBrand).map(function(b){return '<optgroup label="'+b+'">'+byBrand[b].map(function(d){return '<option value="'+d.id+'"'+(d.id===deviceId()?' selected':'')+'>'+d.label+'</option>';}).join('')+'</optgroup>';}).join('');
  $('weight').value=STD_PROFILE.weightLb||'';
  $('offload').value=STD_PROFILE.runLeverPctBW||'';
  $('accessory').classList.toggle('on', hasAccessory());
  $('evDate').value=ymd(max);
  renderEventsList();
  populateMetricSelects();
  $('tTo').value=ymd(max);
  $('tFrom').value=ymd(new Date(max.getTime()-91*DAY));
  setRangeChip('3');
  var nStrava=RAW.filter(function(r){return r.source==='strava';}).length;
  var foot=$('foot'); if(foot) foot.innerHTML='Reading '+RAW.length+' stored runs.'+
    (nStrava?(' '+nStrava+' synced from Strava on days with no watch import — Strava runs carry pace, distance, HR, cadence and ascent, but no ground-contact or oscillation data. <img src="/images/strava/api_logo_pwrdBy_strava_horiz_orange.svg" alt="Powered by Strava" style="height:15px;vertical-align:-4px">'):'')+
    ' Track-running distances are converted from meters to miles. Load and form math live in <code>shared/run-load-model.js</code>; this view in <code>shared/run-dynamics.js</code>.';
  refresh();
}

/* ---------- import ---------- */
// Garmin = one Activities.csv (text); Coros = a .zip of binary .fit files
// (or a single .fit). Both paths produce the same candidate run docs and
// share saveCandidates() for dedup/backfill/status.
function readFile(f){
  var name=String(f.name||'').toLowerCase();
  if(/\.zip$/.test(name)||/\.fit$/.test(name)) return readCorosFile(f);
  return readGarminCsv(f);
}
function readGarminCsv(f){
  var st=$('importStatus');
  st.innerHTML='<span class="rdx-spin"></span>Reading '+esc(f.name)+'…';
  var rd=new FileReader();
  rd.onerror=function(){ st.innerHTML='<span class="err">Could not read file.</span>'; };
  rd.onload=function(){
    var candidates;
    try{ candidates=parseExport(rd.result); }
    catch(e){ st.innerHTML='<span class="err">'+esc(e.message)+'</span>'; return; }
    saveCandidates(candidates);
  };
  rd.readAsText(f);
}
function readCorosFile(f){
  var st=$('importStatus');
  st.innerHTML='<span class="rdx-spin"></span>Reading '+esc(f.name)+'…';
  var rd=new FileReader();
  rd.onerror=function(){ st.innerHTML='<span class="err">Could not read file.</span>'; };
  rd.onload=function(){
    parseCorosArchive(rd.result, f.name, function(done,total){
      if(st) st.innerHTML='<span class="rdx-spin"></span>Parsing .fit files… '+done+'/'+total;
    }).then(function(candidates){ saveCandidates(candidates); })
      .catch(function(e){ console.error(e); st.innerHTML='<span class="err">'+esc(e&&e.message||'Could not read this Coros file.')+'</span>'; });
  };
  rd.readAsArrayBuffer(f);
}
function saveCandidates(candidates){
  var st=$('importStatus');
  if(!candidates||!candidates.length){ if(st) st.innerHTML='<span class="err">No running activities found in this file.</span>'; return; }
  var elev=candidates.filter(function(c){return c.ascentM!=null;}).length;
  if(st) st.innerHTML='<span class="rdx-spin"></span>Saving '+candidates.length+' runs…';
  backfill(candidates).then(function(res){
    return loadFromFirestore().then(function(){
      renderLoaded();
      var sample=candidates.filter(function(c){return c.ascentM!=null;})[0];
      var verify=sample?actCol().doc(sample.id).get().then(function(d){return d.exists&&d.data().ascentM!=null;}):Promise.resolve(null);
      verify.then(function(ok){
        var unitsNote=candidates.csvUnits?' · '+(candidates.csvUnits==='metric'?'km/m':'mi/ft')+' export detected':'';
        if(st) st.innerHTML='<span class="ok">✓ '+res.added+' new'+(res.updated?(', '+res.updated+' updated'):'')+(res.replaced?(', '+res.replaced+' Strava-synced replaced by watch data'):'')+'</span> · '+RAW.length+' total · '+elev+'/'+candidates.length+' w/ elevation'+unitsNote+(ok===false?' <span class="err">(elevation did NOT persist — check rules)</span>':'');
      });
    });
  }).catch(function(e){
    console.error(e);
    if(st) st.innerHTML='<span class="err">Save failed: '+(e&&e.code||e&&e.message||e)+'</span>';
  });
}

/* ---------- shell markup ---------- */
function shellHTML(opts){
  var who = ROLE==='coach' ? "this athlete's" : 'your';
  var titleHTML = opts.title
    ? '<div><h2 class="rdx-h1">'+esc(opts.title)+'</h2>'+(opts.sub?'<p class="rdx-sub">'+opts.sub+'</p>':'')+'</div>'
    : '<span></span>';
  return ''+
  '<div class="rdx-topbar">'+titleHTML+'<button class="rdx-gear" id="gearBtn" style="display:none">⚙ Settings &amp; filters</button></div>'+

  '<details class="rdx-help"><summary>How to export your run history and import it here</summary>'+
    '<div class="rdx-help-body">'+
      '<p>Export from your watch platform below, then drop the file in the box. '+
        'Everything is read in your browser and de-duplicated by start time, so re-uploads only add what is new — and importing from more than one source is fine.</p>'+
      '<p><b>Garmin Connect</b> — one <code>Activities.csv</code>:</p><ol>'+
      '<li>On a computer, open <a href="https://connect.garmin.com/modern/activities" target="_blank" rel="noopener">Garmin Connect → Activities → All Activities</a> and sign in.</li>'+
      '<li>Use the <b>filter</b> controls to set <b>Activity Type → Running</b> (optional) and the <b>date range</b> you want.</li>'+
      '<li><b>Scroll to the bottom</b> so every activity in that range loads on screen — the export only includes what is loaded.</li>'+
      '<li>Click <b>Export CSV</b> (top-right) to download <code>Activities.csv</code>.</li>'+
      '<li>Drop that file below. Runs are de-duplicated by start time, so re-uploads only add what is new.</li>'+
    '</ol>'+
      '<p><b>COROS Training Hub</b> — a <code>.zip</code> of per-activity <code>.fit</code> files, delivered by email:</p><ol>'+
      '<li>On a computer, open <a href="https://t.coros.com" target="_blank" rel="noopener">COROS Training Hub (t.coros.com)</a> and sign in.</li>'+
      '<li>Open the <b>Activity List</b> tab at the top. To import only part of your history, use the list\'s <b>filter</b> controls to narrow by <b>date range</b> and sport first (optional — re-imports de-dupe, so exporting everything is fine too).</li>'+
      '<li>Click <b>Export Data</b> on the right, choose <b>.FIT</b> as the format, and enter the <b>email address</b> to send the export to.</li>'+
      '<li>COROS emails a <b>download link</b> (usually within a few minutes). Open it and download the <code>.zip</code> — it holds one <code>.fit</code> file per activity.</li>'+
      '<li>Drop that <code>.zip</code> below (a single <code>.fit</code> works too). We unpack and read each <code>.fit</code> right in your browser.</li>'+
    '</ol>'+
    '<div class="rdx-help-note">Running-form metrics (ground contact, vertical oscillation, cadence, stride) require a compatible device or strap — runs recorded without one still import for load and pace, they just skip those fields. Garmin\'s CSV export is also capped at ~1,000 rows and only includes what is loaded on screen, so export long Garmin histories in chunks by date range — each chunk merges in automatically.</div>'+
    '<div class="rdx-help-note">Strava connected (via the coaching dashboard)? The last 2 years of Strava runs sync in automatically, once a day, for days with no watch import — and the <b>Backfill Strava history</b> button pulls your entire Strava history at once for the same gap-fill. Strava can\'t provide ground contact, oscillation, or descent, so uploading a watch export for those days replaces the Strava copy with the full-metric version.</div>'+
    '</div></details>'+

  '<div class="rdx-importbar">'+
    '<div class="rdx-drop" id="drop"><b>Import Garmin <code>Activities.csv</code> or a Coros <code>.zip</code></b>'+
      '<span>Drag &amp; drop, or click to choose — backfills '+who+' run history.</span>'+
      '<input type="file" id="file" accept=".csv,text/csv,.zip,.fit,application/zip" hidden></div>'+
    '<div class="rdx-status" id="importStatus"></div>'+
    '<button class="rdx-btn rdx-btn-sm" id="stravaBackfill" style="display:none;align-self:center" title="Fetch '+who+' entire Strava history — one run per day is added for every day with no imported activity">⟲ Backfill Strava history</button>'+
  '</div>'+

  '<div class="rdx-settings" id="settingsPanel" style="display:none">'+
    '<div class="rdx-controls">'+
      '<div class="rdx-group">'+
        '<div class="rdx-group-hd">Filters</div>'+
        '<div class="rdx-group-body">'+
          '<div class="rdx-ctl rdx-ctl-grow"><label>Activity types</label><div class="rdx-types" id="types"></div></div>'+
          '<div class="rdx-ctl"><label>Runs</label><select id="intensity"><option value="all">All runs</option><option value="workout">Workouts only</option><option value="easy">Easy only</option></select></div>'+
          '<div class="rdx-ctl"><label>Workout cutoff /mi</label><input type="text" id="cutoff" value="6:40" style="width:66px"></div>'+
          '<div class="rdx-ctl"><label>Min distance</label><div class="rdx-inunit"><input type="text" id="mindist" value="0.5" style="width:46px"><span>mi</span></div></div>'+
          '<div class="rdx-ctl"><label>Window end</label><input type="date" id="anchor"></div>'+
        '</div>'+
      '</div>'+
      '<div class="rdx-group">'+
        '<div class="rdx-group-hd">Athlete</div>'+
        '<div class="rdx-group-body">'+
          '<div class="rdx-ctl"><label>Device</label><select id="device"></select></div>'+
          '<div class="rdx-ctl"><label>Strap / pod</label><div class="rdx-types"><span class="rdx-chip" id="accessory">chest strap / pod</span></div></div>'+
          '<div class="rdx-ctl"><label>Body weight</label><div class="rdx-inunit"><input type="text" id="weight" placeholder="—" style="width:54px"><span>lb</span></div></div>'+
          '<div class="rdx-ctl"><label>Lever support</label><div class="rdx-inunit"><input type="text" id="offload" placeholder="85" style="width:42px"><span>% BW</span></div></div>'+
        '</div>'+
      '</div>'+
      '<div class="rdx-group rdx-group-grow">'+
        '<div class="rdx-group-hd">Performance &amp; injury history <span class="rdx-group-sub">marks races, injuries &amp; downtime on the chart</span></div>'+
        '<div class="rdx-group-body">'+
          '<div class="rdx-ctl"><label>Type</label><select id="evType"><option value="race">Race</option><option value="injury">Injury</option><option value="timeoff">Planned Downtime</option></select></div>'+
          '<div class="rdx-ctl"><label>Date</label><input type="date" id="evDate"></div>'+
          '<div class="rdx-ctl" id="evEndCtl" style="display:none"><label>End (opt.)</label><input type="date" id="evEndDate"></div>'+
          '<div class="rdx-ctl rdx-ctl-grow"><label>Note</label><input type="text" id="evNote" placeholder="e.g. Boston Marathon / left Achilles" style="width:100%"></div>'+
          '<button class="rdx-btn rdx-btn-sm" id="evAdd">+ add</button>'+
        '</div>'+
        '<div class="rdx-ev-guide">Log <b>overuse injuries</b> — the kind that build up from training — and, optionally, significant illnesses that stopped training. Don’t log acute injuries that didn’t come from running (a basketball ankle, a bike crash): their lead-up says nothing about training load and skews the pattern analysis. Log <b>planned downtime</b> (off-season break, vacation) so the volume drop reads as planned rather than a possible setback. Injuries and downtime take an optional end date and shade the whole span on the chart.</div>'+
        '<div class="rdx-events" id="eventsList" style="display:none"></div>'+
      '</div>'+
    '</div>'+
    '<div class="rdx-controls-meta">'+
      '<span class="rdx-filenote" id="savedNote" style="color:var(--good);opacity:0;transition:opacity .2s"></span>'+
      '<span class="rdx-filenote" id="filenote"></span>'+
      '<button class="rdx-btn rdx-btn-sm rdx-btn-danger" id="resetData">Delete all imported runs</button>'+
    '</div>'+
  '</div>'+

  '<div class="rdx-empty rdx-section" id="sec-empty">No running activities stored '+(ROLE==='coach'?'for this athlete ':'')+'yet. Import a Garmin <code>Activities.csv</code> or a Coros <code>.zip</code> above to get started — or connect Strava on the coaching dashboard and recent run history fills in automatically.</div>'+

  '<div class="rdx-section" id="sec-hero">'+(ADMIN?'<div class="rdx-demobar" id="demobar"></div>':'')+'<div class="rdx-hero" id="hero"></div></div>'+

  '<div class="rdx-section" id="sec-chart">'+
    '<h2>Training load &amp; trends</h2>'+
    '<div class="rdx-rangebar">'+
      '<div class="rdx-ctl"><label>View</label><select id="chartView"></select></div>'+
      '<div class="rdx-ctl" id="chartView2Wrap" style="display:none"><label>Overlay 2nd</label><select id="chartView2"></select></div>'+
      '<div class="rdx-ctl"><label>From</label><input type="date" id="tFrom"></div>'+
      '<div class="rdx-ctl"><label>To</label><input type="date" id="tTo"></div>'+
      '<div class="rdx-ctl"><label>Range</label><div class="rdx-types" id="rdx-rangeChips">'+
        '<span class="rdx-chip" data-range="3">3M</span>'+
        '<span class="rdx-chip" data-range="6">6M</span>'+
        '<span class="rdx-chip" data-range="12">1Y</span>'+
        '<span class="rdx-chip" data-range="all">All</span>'+
      '</div></div>'+
      '<div class="rdx-ctl" id="dispWrap" style="display:none"><label>Display</label><div class="rdx-types"><span class="rdx-chip on" id="hideOutliers">Hide outliers</span><span class="rdx-chip on" id="smooth">Smooth</span><span class="rdx-chip" id="points">Points</span></div></div>'+
    '</div>'+
    '<div class="rdx-chartwrap"><div class="rdx-legend" id="chartLegend"></div><div id="chartBox"></div></div>'+
    '<p class="rdx-hint" id="chartHint"></p>'+
    '<details class="rdx-help" style="margin-top:12px"><summary>How Impact Load is calculated — equation, variables &amp; sources</summary><div class="rdx-help-body" id="loadMethod"></div></details>'+
  '</div>'+

  '<div class="rdx-section" id="sec-patterns">'+
    '<h2>Injury patterns <span class="rdx-note">· the training that preceded each logged injury</span></h2>'+
    '<div id="patternsBox"></div>'+
  '</div>'+

  '<div class="rdx-section" id="sec-form">'+
    '<h2>Form metrics <span class="rdx-note">· recent 90 days vs prior 90</span></h2>'+
    '<div class="rdx-tiles" id="formTiles"></div>'+
    '<details class="rdx-help" style="margin-top:14px"><summary>Show all metrics &amp; compare ranges</summary>'+
      '<div class="rdx-help-body" style="padding-top:14px">'+
        '<div class="rdx-rangebar" style="margin-bottom:14px">'+
          '<span class="rdx-chip" id="formCompare">⇄ compare two ranges</span>'+
          '<div class="rdx-ctl" id="faFromWrap" style="display:none"><label>Range A — from</label><input type="date" id="faFrom"></div>'+
          '<div class="rdx-ctl" id="faToWrap" style="display:none"><label>to</label><input type="date" id="faTo"></div>'+
          '<div class="rdx-ctl" id="fbFromWrap" style="display:none"><label>Range B — from</label><input type="date" id="fbFrom"></div>'+
          '<div class="rdx-ctl" id="fbToWrap" style="display:none"><label>to</label><input type="date" id="fbTo"></div>'+
        '</div>'+
        '<div class="rdx-tablewrap"><table class="rdx-table" id="ftable"></table></div>'+
        '<p class="rdx-hint" id="formHint">Showing stored-history averages. Toggle “compare two ranges” to compare periods (Δ = Range A − Range B).</p>'+
      '</div>'+
    '</details>'+
  '</div>'+

  '<div class="rdx-section" id="sec-summary"><h2>Volume by window</h2><div class="rdx-cards" id="cards"></div></div>'+

  '<div class="rdx-foot" id="foot"></div>';
}

/* ---------- wiring ---------- */
function wire(){
  var drop=$('drop'), fileInput=$('file');
  drop.onclick=function(){ fileInput.click(); };
  drop.ondragover=function(e){ e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave=function(){ drop.classList.remove('over'); };
  drop.ondrop=function(e){ e.preventDefault(); drop.classList.remove('over'); var f=e.dataTransfer.files[0]; if(f) readFile(f); };
  fileInput.onchange=function(e){ var f=e.target.files[0]; if(f) readFile(f); fileInput.value=''; };
  $('anchor').onchange=function(e){ var d=parseDate(e.target.value); if(d){ANCHOR=d;refresh();} };
  $('gearBtn').onclick=function(){ var p=$('settingsPanel'), open=p.style.display!=='none'; p.style.display=open?'none':'block'; this.classList.toggle('on',!open); };
  $('intensity').onchange=refresh;
  $('cutoff').onchange=refresh;
  $('mindist').onchange=refresh;
  ['chartView','chartView2'].forEach(function(id){ $(id).onchange=renderChart; });
  ['tFrom','tTo'].forEach(function(id){ $(id).onchange=function(){ setRangeChip(''); renderChart(); }; });
  ['hideOutliers','smooth','points'].forEach(function(id){ $(id).onclick=function(){ this.classList.toggle('on'); renderChart(); }; });
  Array.prototype.forEach.call($all('#rdx-rangeChips .rdx-chip'),function(c){ c.onclick=function(){ applyRange(c.getAttribute('data-range')); }; });
  ['faFrom','faTo','fbFrom','fbTo'].forEach(function(id){ $(id).onchange=renderForm; });
  $('formCompare').onclick=function(){
    this.classList.toggle('on');
    var on=this.classList.contains('on');
    ['faFromWrap','faToWrap','fbFromWrap','fbToWrap'].forEach(function(id){ $(id).style.display=on?'flex':'none'; });
    renderForm();
  };
  $('device').onchange=function(e){ saveProfile({ runDevice:e.target.value }); populateMetricSelects(); refresh(); };
  $('accessory').onclick=function(){ this.classList.toggle('on'); saveProfile({ runHasAccessory:this.classList.contains('on') }); populateMetricSelects(); refresh(); };
  $('weight').onchange=function(e){ var lb=parseFloat(String(e.target.value).replace(/[^0-9.]/g,'')); saveProfile({ weightLb:(lb&&lb>0)?lb:null }); refresh(); };
  $('offload').onchange=function(e){ var pct=parseFloat(String(e.target.value).replace(/[^0-9.]/g,'')); saveProfile({ runLeverPctBW:(pct>0&&pct<100)?pct:null }); refresh(); };
  $('evAdd').onclick=evAdd;
  $('evType').onchange=function(){ $('evEndCtl').style.display=this.value==='race'?'none':''; if(this.value==='race') $('evEndDate').value=''; };
  $('evNote').onkeydown=function(e){ if(e.key==='Enter') evAdd(); };
  $('resetData').onclick=function(){
    var btn=this, st=$('importStatus');
    var who = ROLE==='coach' ? "this athlete's" : 'your';
    if(!confirm('Delete ALL of '+who+' stored run history ('+RAW.length+' runs)?\n\n'+
      'This clears every imported activity so a fresh export can be re-imported clean — '+
      'use it if a bad activity got stuck in an earlier upload. '+
      'Profile settings and race/injury markers are kept.\n\nThis cannot be undone.')) return;
    btn.disabled=true;
    if(st) st.innerHTML='<span class="rdx-spin"></span>Deleting '+RAW.length+' stored runs…';
    deleteAllRuns().then(function(n){
      RAW=[]; KNOWN_TYPES=new Set(); ACTIVE_TYPES=new Set();
      renderLoaded();
      if(st) st.innerHTML='<span class="ok">✓ '+n+' runs deleted</span> · import an export above to start fresh.';
    }).catch(function(e){
      console.error(e);
      // A mid-way batch failure leaves a partial history — reload so the view
      // shows what actually remains rather than the pre-delete state.
      return loadFromFirestore().then(renderLoaded).catch(function(){}).then(function(){
        if(st) st.innerHTML='<span class="err">Delete failed: '+esc(e&&e.code||e&&e.message||e)+'</span>';
      });
    }).then(function(){ btn.disabled=false; });
  };
  // Backfill = the daily Strava gap-fill without the 2-year cutoff: the
  // server pages the athlete's ENTIRE history through Strava's list endpoint
  // (200 activities per request — no per-activity calls) and adds a run doc
  // for every day with no imported activity. Re-runs are cheap: already
  // stored runs are skipped server-side.
  $('stravaBackfill').onclick=function(){
    var btn=this, st=$('importStatus');
    if(DEMO || !(window.firebase && firebase.functions)) return;
    btn.disabled=true;
    if(st) st.innerHTML='<span class="rdx-spin"></span>Backfilling from Strava — fetching the full activity history, this can take a minute…';
    var payload={backfill:true}; if(ROLE==='coach') payload.athleteUid=UID;
    // The callable SDK's default client timeout is 70s; a full-history
    // backfill (up to 40 sequential Strava page fetches) can outlast it,
    // surfacing as deadline-exceeded while the server keeps working.
    // Match the function's own timeoutSeconds: 300.
    firebase.functions().httpsCallable('syncStravaActivities',{timeout:300000})(payload).then(function(res){
      var d=(res&&res.data)||{};
      return loadFromFirestore().then(function(){
        renderLoaded();
        if(st) st.innerHTML='<span class="ok">✓ '+(d.runDocs||0)+' Strava runs added</span> · '+(d.runSkipped||0)+' already stored or covered by watch imports'+
          (d.rateLimited?' · <span class="err">Strava’s rate limit paused the fetch — run backfill again in ~15 minutes to pull the rest</span>':'');
      });
    }).catch(function(e){
      console.error(e);
      if(st) st.innerHTML='<span class="err">Backfill failed: '+esc(e&&e.message||e)+'</span>';
    }).then(function(){ btn.disabled=false; });
  };
}

/* Strava auto-sync: if this athlete has Strava connected (coaching dashboard
   flow), top up their stored run history once per local day. The server
   (syncStravaActivities in functions/index.js) pulls 2 years of Strava runs
   but skips every day already covered by a watch import — Strava only fills
   the gaps, and can't provide GCT/oscillation/descent. Coach view skips this:
   the coaching page runs its own athlete-scoped daily sync, and the callable
   syncs the CALLER's account unless invoked with athleteUid by the admin. */
function maybeSyncStrava(){
  if(ROLE==='coach' || DEMO) return;
  if(!STRAVA_SYNC.connected) return;
  if(!(window.firebase && firebase.functions)) return;
  var last=STRAVA_SYNC.last;
  if(last){
    var d=last.toDate?last.toDate():new Date(last);
    if(d.toDateString()===new Date().toDateString()) return;
  }
  var container=ROOT;
  firebase.functions().httpsCallable('syncStravaActivities',{timeout:300000})({}).then(function(res){
    var n=res&&res.data&&res.data.runDocs;
    if(!n || ROOT!==container) return;
    return loadFromFirestore().then(function(){ if(ROOT===container) renderLoaded(); });
  }).catch(function(e){ console.warn('RunDynamics: Strava sync failed', e); });
}

/* ---------- public entry point ---------- */
function mount(container, opts){
  opts=opts||{};
  if(!container || !opts.db || !opts.uid){
    if(container) container.innerHTML='<div class="rdx rdx-empty">Run Dynamics: missing db/uid.</div>';
    return;
  }
  injectCSS();
  ROOT=container; DB=opts.db; UID=opts.uid; ROLE=opts.role||'athlete'; ADMIN=!!opts.admin; DEMO=null;
  RAW=[]; ACTIVE_TYPES=new Set(); KNOWN_TYPES=new Set(); ANCHOR=null; LOAD_PARAMS=null; STD_PROFILE={}; STRAVA_LEVER=[]; STRAVA_SYNC={};
  container.classList.add('rdx');
  container.innerHTML=shellHTML(opts);
  wire();
  var st=$('importStatus'); if(st) st.innerHTML='<span class="rdx-spin"></span>Loading stored runs…';
  Promise.all([loadProfile(), loadFromFirestore(), fetchStravaLever()]).then(function(){
    if(ROOT!==container) return;   // a newer mount superseded this one
    renderLoaded();
    if(st) st.innerHTML = RAW.length
      ? '<span class="ok">✓ '+RAW.length+' runs loaded</span> · import a newer export to add more'
      : 'No runs stored yet — import a Garmin or Coros export to begin.';
    var bf=$('stravaBackfill'); if(bf && STRAVA_SYNC.connected) bf.style.display='';
    maybeSyncStrava();
  }).catch(function(e){
    console.error(e);
    if(st) st.innerHTML='<span class="err">Could not load stored runs: '+(e&&e.message||e)+'</span>';
  });
}

window.RunDynamics = { mount: mount };
})();
