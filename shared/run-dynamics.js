// ════════════════════════════════════════════════════════════════
// shared/run-dynamics.js
//
// The ONE Training Analysis view. The standalone /training-analysis/ page and
// the coaching dashboard's "Training Analysis" and "Injury Patterns" tabs all
// mount this; there is no second copy. It renders; every number, file read
// and Firestore read or write goes through RunData (run-dynamics-data.js).
//
//   RunDynamics.mount(containerEl, { db, uid, role, view, admin })
//     db    : firebase firestore instance
//     uid   : the athlete whose data to show / write
//     role  : 'athlete' (self) | 'coach' (viewing an athlete): copy only
//     view  : 'training' (Today, Load, Form) | 'injury' (what came before
//             each setback, the athlete's events, training gaps). Both have
//             the status strip, the Data and Settings sheets and About.
//     admin : the real admin: adds the Today card's demo scenarios
//   RunDynamics.reload(uid) / RunDynamics.forget(uid): see the bottom.
//
// Layout (Direction A, owner-approved 2026-11-08): each section answers one
// question and owns its controls. Today is always now. Load has its own
// range and counts every run. Form has one period, compared with the period
// before, and a visible "Counts:" line for its run filters. Data holds the
// import and the cleanup of stored runs; Settings holds how runs are scored.
//
// Depends on globals: RunData, RunLoad (run-load-model.js), InjuryPatterns
// (injury-patterns.js), RunDevices (device-matrix.js); esLabs when present.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

/* ---------- CSS: injected once, scoped under .rdx; tokens come from /shared/site.css ---------- */
var CSS = `
.rdx{font-family:var(--ui,'Inter',system-ui,sans-serif);color:var(--text);font-size:14px;line-height:1.5}
.rdx *{box-sizing:border-box}
.rdx [hidden]{display:none!important}
.rdx :focus-visible{outline:2px solid var(--accent-ink,var(--cyan));outline-offset:2px}
.rdx{--rdx-good-ink:var(--good-ink,var(--good));--rdx-warn-ink:var(--warn-ink,var(--warn));--rdx-bad-ink:var(--bad-ink,var(--bad));--rdx-gold-ink:var(--gold-ink,var(--gold,#f5c842));--rdx-accent-ink:var(--accent-ink,var(--cyan));
  --rdx-s1:var(--rdx-accent-ink);--rdx-s2:var(--purple-ink,var(--purple,#8b7cf8));--rdx-hot:var(--rdx-gold-ink);--rdx-spike:var(--rdx-bad-ink);
  --rdx-band:color-mix(in srgb,var(--good,#22c78a) 16%,transparent);--rdx-band-line:color-mix(in srgb,var(--good,#22c78a) 30%,transparent);
  --rdx-inset:0px}
/* text inks (light-mode --*-ink, --muted2 #8590ae in dark) come from /shared/site.css; the view no longer overrides them */
@keyframes rdx-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes rdx-spin{to{transform:rotate(360deg)}}
.rdx-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--border2);border-top-color:var(--cyan);border-radius:50%;animation:rdx-spin .7s linear infinite;vertical-align:-2px;margin-right:6px}

/* form fields — :where() keeps these at element weight so the modal/gap-form rules below still win */
:where(.rdx) :is(select,input[type=text],input[type=date],input[type=number]){height:36px;padding:0 12px;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-family:var(--ui);font-size:13px;outline:none;min-width:0}
:where(.rdx) :is(input)::placeholder{color:var(--placeholder,var(--muted2))}
:where(.rdx) select{cursor:pointer}
:where(.rdx) :is(select,input):focus{border-color:var(--rdx-accent-ink);box-shadow:var(--focus-ring,0 0 0 3px rgba(0,229,200,.18))}
.rdx input[type=date]{color-scheme:dark}
html[data-theme="light"] .rdx input[type=date]{color-scheme:light}
.rdx-ctl{display:flex;flex-direction:column;gap:6px;min-width:0}
.rdx-ctl>label,.rdx-lbl{font-size:12px;font-weight:600;color:var(--muted2);line-height:1.3}
.rdx-inunit{display:flex;align-items:center;gap:6px}
.rdx-inunit span{font-size:12px;color:var(--muted2)}
.rdx-df-err{border-color:var(--bad)!important}
.rdx-field-err{font-weight:600;color:var(--rdx-bad-ink)}
/* label + ⓘ on one 16px line (the 24px button overflows it, so the row keeps the label's height) */
.rdx-check{display:inline-flex;align-items:center;gap:8px;min-height:36px;font-size:13px;color:var(--text);cursor:pointer}
.rdx-check input{width:16px;height:16px;margin:0;accent-color:var(--cyan)}
.rdx-drop.busy{opacity:.6;cursor:progress}

/* buttons: filled = the one primary action (+ add, Save event, Mark as Lever); outline = secondary; ghost = quiet */
.rdx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:7px 16px;background:var(--cyan);color:var(--on-accent,#000);font-family:inherit;font-weight:700;font-size:13px;line-height:1.2;border:1px solid transparent;border-radius:8px;cursor:pointer;white-space:nowrap;transition:opacity .15s,border-color .15s,color .15s,background .15s}
.rdx-btn:hover{opacity:.86}
.rdx-btn:disabled{opacity:.4;cursor:not-allowed}
.rdx-btn-sm{min-height:30px;padding:5px 12px;font-size:12px;font-weight:600}
.rdx-btn-outline{background:transparent;color:var(--text);border-color:var(--border2);font-weight:600}
.rdx-btn-outline:hover:not(:disabled){opacity:1;border-color:var(--accent-ink,var(--cyan));color:var(--rdx-accent-ink)}
.rdx-btn-outline[aria-expanded="true"]{border-color:var(--accent-ink,var(--cyan));background:var(--hover)}   /* open: border + fill carry the state, the label stays --text */
.rdx-btn-ghost{background:transparent;color:var(--muted2);border-color:transparent;font-weight:600}
.rdx-btn-ghost:hover:not(:disabled){opacity:1;color:var(--text);background:var(--hover)}
.rdx-btn-danger{background:transparent;color:var(--rdx-bad-ink);border-color:var(--bad);font-weight:600}
.rdx-btn-danger:hover:not(:disabled){opacity:1;background:var(--bad-wash,rgba(245,80,80,.10))}
.rdx-linkbtn{background:none;border:none;padding:0;font:inherit;color:var(--muted2);text-decoration:underline dotted;text-underline-offset:3px;cursor:pointer}
.rdx-linkbtn:hover{color:var(--text)}
.rdx-link{background:none;border:none;padding:0;font:inherit;color:var(--rdx-accent-ink);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;cursor:pointer}
.rdx-link:hover{text-decoration-thickness:2px}
.rdx-chip{font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;border:1px solid var(--border2);background:var(--panel2);color:var(--muted2);cursor:pointer;user-select:none;transition:all .12s}
.rdx-chip.on{background:rgba(0,229,200,.1);border-color:rgba(0,229,200,.35);color:var(--rdx-accent-ink)}
.rdx button.rdx-chip{font-family:inherit;line-height:1.3}
.rdx-types{display:flex;flex-wrap:wrap;gap:7px}
.rdx-ctl>.rdx-types{min-height:36px;align-items:center}   /* a chip row lines up with the 36px inputs beside it */

/* disclosures: no box, a rotating chevron */
.rdx-more>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:baseline;gap:8px;padding:6px 0;font-size:14px;font-weight:600;line-height:1.45;color:var(--text)}   /* baseline: a wrapped summary keeps its chevron on line 1 */
.rdx-more>summary::-webkit-details-marker{display:none}
.rdx-more>summary::before{content:"▸";display:inline-block;color:var(--muted2);transition:transform .15s}
.rdx-more[open]>summary::before{transform:rotate(90deg)}
.rdx-more>summary:hover{color:var(--rdx-accent-ink)}
.rdx-more-body{padding:12px 0 0;font-size:14px;color:var(--muted2);line-height:1.6}
.rdx-more-body p{margin:0 0 10px}
.rdx-more-body ol{margin:0 0 12px 20px;padding:0}
.rdx-more-body li{margin-bottom:6px}
.rdx-more-body b{color:var(--text)}
.rdx-more-body a{color:var(--rdx-accent-ink);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
/* methodology (RunLoad.methodologyHTML) */
.rdx-meth-h{display:block;margin:16px 0 6px;font:600 12px/1.3 var(--ui);color:var(--muted2)}
.rdx-meth-eq{font:400 12px/1.6 var(--mono);white-space:pre;overflow-x:auto;background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);margin:0 0 4px}
.rdx-meth-p{max-width:var(--w-prose,760px);margin:8px 0;line-height:1.6}
.rdx-meth-muted{color:var(--muted2)}
.rdx-meth-k{font-family:var(--mono);font-weight:700;color:var(--text)}
.rdx-meth-list{margin:4px 0 8px 18px;padding:0;max-width:760px;color:var(--text)}
.rdx-meth-list li{margin-bottom:2px}
.rdx-more-body ol.rdx-meth-refs{margin:4px 0 0;padding-left:18px;max-width:760px;line-height:1.65;color:var(--muted2)}
.rdx-more-body code{font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--border);border-radius:var(--r-sm,6px);padding:1px 6px;color:var(--text)}
.rdx-note,.rdx-more-body .rdx-note{font-size:13px;color:var(--muted2);line-height:1.55;max-width:760px;margin:10px 0 0}   /* beats .rdx-more-body p's margin */


.rdx-wtl{font-size:13px;color:var(--muted2);line-height:1.55}
.rdx-wtl ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:3px}
.rdx-wtl li{display:flex;align-items:baseline;gap:8px}
.rdx-wtl li .rdx-ev-dot{transform:translateY(-1px)}
.rdx-wtl b{color:var(--text);font-weight:600;white-space:nowrap}
.rdx-wtl p{margin:6px 0 0}
.rdx-ev-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.rdx-import{display:flex;flex-direction:column;gap:12px}
.rdx-drop{flex:1 1 280px;border:1.5px dashed var(--border2);border-radius:8px;padding:16px 18px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
.rdx-drop:hover,.rdx-drop.over{border-color:var(--accent-ink,var(--cyan));background:var(--accent-wash,rgba(0,229,200,.08))}
.rdx-drop b{font-size:14px;font-weight:600;color:var(--text)}
.rdx-drop span{font-size:12px;color:var(--muted2);display:block;margin-top:2px}
.rdx-imp-note{margin:0;font-size:13px;line-height:1.5;color:var(--muted2)}

/* sections */
.rdx-section,.rdx-more,.rdx #rdxGaps{scroll-margin-top:72px}   /* clear the sticky site nav (58px) */
.rdx-sec-hd{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 20px;margin-bottom:12px}
.rdx-sec-hd-txt{flex:1 1 320px;min-width:0}
.rdx-sec-title{font-family:var(--ui);font-size:17px;font-weight:700;letter-spacing:-.2px;line-height:1.3;color:var(--text);margin:0}
.rdx-sec-title:focus{outline:none}
.rdx-sec-sub{font-size:13px;line-height:1.5;color:var(--muted2);max-width:760px;margin:3px 0 0}
.rdx-garmin-credit{font-size:12px;line-height:1.4;color:var(--muted2);margin:4px 0 0}
.rdx-modal-intro .rdx-garmin-credit{margin:0 0 4px}
.rdx-sec-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.rdx-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.rdx-empty{padding:32px 16px;text-align:center;color:var(--muted2);font-size:13px}
.rdx-empty-card{max-width:var(--w-prose,760px)}
.rdx-empty-card .rdx-sec-sub{margin-bottom:16px}
.rdx-gapchip{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:4px 12px;font:inherit;font-size:12px;font-weight:600;color:var(--text);background:var(--panel2);border:1px solid var(--border2);border-radius:999px;cursor:pointer}
.rdx-gapchip::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--warn)}

/* tables (volume + all metrics); the sticky first column needs an opaque fill */
.rdx-tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--panel)}
.rdx-table{border-collapse:collapse;width:100%;font-size:13px}
.rdx-table th,.rdx-table td{padding:10px 14px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--border)}
.rdx-table tr>:first-child{text-align:left;position:sticky;left:0;background:var(--panel)}
.rdx-table thead th{font-size:12px;font-weight:600;line-height:1.35;color:var(--muted2);vertical-align:bottom}
.rdx-table thead th,.rdx-table thead th:first-child{background:var(--panel2)}
.rdx-table tbody th{font-weight:600;color:var(--text)}
.rdx-table tbody tr:last-child>*{border-bottom:none}
.rdx-table tbody tr:hover>*{background:var(--hover)}
.rdx-table tbody tr:hover>:first-child{background:var(--panel2)}
.rdx-table .rdx-grp>th,.rdx-table tbody tr.rdx-grp:hover>th{padding-top:16px;padding-bottom:6px;font-size:12px;color:var(--muted2);background:var(--panel)}
.rdx-th-sub{display:block;margin-top:2px;font-weight:400;font-size:12px;color:var(--muted2)}
.rdx-mname{font-weight:600;color:var(--text)}
.rdx-munit{font:600 12px/1 var(--ui);color:var(--muted2);margin-left:4px}
.rdx-mdesc{font-size:12px;color:var(--muted2);font-weight:400;line-height:1.4;margin-top:2px;white-space:normal;max-width:340px}
.rdx-val{font-family:var(--mono);font-weight:700;color:var(--text)}
.rdx-val.na{color:var(--muted2);font-weight:400}
.rdx-delta{font-family:var(--mono);font-size:12px;white-space:nowrap}
.rdx-delta.up{color:var(--rdx-good-ink)}.rdx-delta.down{color:var(--rdx-bad-ink)}.rdx-delta.flat{color:var(--muted2)}
.rdx-delta.same{font-family:var(--ui)}

/* 3. chart */
.rdx-seg{display:inline-flex;gap:2px;padding:2px;background:var(--panel2);border:1px solid var(--border2);border-radius:9px}
.rdx-seg button{min-height:30px;padding:0 12px;font:inherit;font-size:12px;font-weight:600;color:var(--muted2);background:transparent;border:1px solid transparent;border-radius:7px;cursor:pointer;white-space:nowrap}
.rdx-seg button:hover{color:var(--text)}
.rdx-seg button.on{background:var(--panel);border-color:var(--border2);color:var(--rdx-accent-ink)}
.rdx-chartwrap{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 14px 8px}
.rdx-chart-svg{display:block;width:100%;height:auto}
/* axis text and grid take theme tokens (SVG drawn at the box's real width, so 11px is 11px) */
.rdx-chart-svg text{font-family:var(--mono);font-size:11px;fill:var(--muted2)}
.rdx-chart-svg .rdx-ax-lbl{font-family:var(--ui)}
.rdx-chart-svg .rdx-ax2{fill:var(--purple-ink,var(--purple,#8b7cf8))}
.rdx-chart-svg .rdx-grid{stroke:var(--border)}
.rdx-chart-svg .rdx-today{stroke:var(--muted2);stroke-width:1;stroke-dasharray:3 3}
.rdx-chart-svg .rdx-today-lbl{fill:var(--text);font-weight:600}
.rdx-chart-svg .rdx-today-dot{stroke:var(--panel);stroke-width:2}
.rdx-chart-empty{padding:34px;text-align:center;color:var(--muted2);font-size:13px}
.rdx-ev-cap{font-size:12px;color:var(--muted2);margin:6px 0 2px}
.rdx-ev-cap:empty{display:none}
.rdx #chartBox{position:relative}
.rdx-hit{cursor:pointer}
@media(pointer:coarse){.rdx-hit{r:11px}}   /* finger-sized tap target (CSS r overrides the attribute) */
.rdx-chart-tip{position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:30;min-width:120px;max-width:250px;padding:8px 10px;background:var(--panel);border:1px solid var(--border2);border-radius:8px;box-shadow:var(--shadow-pop,0 8px 32px rgba(0,0,0,.45));font-size:12px;line-height:1.5;color:var(--text)}
.rdx-chart-tip.on{display:block}
.rdx-load-tip{white-space:nowrap;max-width:none}
.rdx-load-svg{cursor:crosshair}
.rdx-load-svg:focus{outline:none}
.rdx-load-svg:focus-visible{outline:2px solid var(--focus-ring,var(--cyan));outline-offset:2px;border-radius:4px}
.rdx-chart-svg .rdx-xh-ln{stroke:var(--muted2);stroke-width:1}
.rdx-chart-svg .rdx-xh-dot{stroke:var(--panel);stroke-width:2}
.rdx-tip-top{font-size:12px;color:var(--muted2);margin-bottom:3px;display:flex;align-items:center;gap:6px}
.rdx-tip-chip{font-family:var(--ui);font-size:11px;font-weight:600;border:1px solid;border-radius:999px;padding:0 6px}
.rdx-tip-val b{font-family:var(--mono);color:var(--rdx-accent-ink)}
.rdx-tip-ctx{color:var(--muted2);font-size:12px;margin-top:3px;overflow-wrap:anywhere}
.rdx-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:8px;padding-left:2px}
.rdx-legend:empty{display:none}
.rdx-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.4;color:var(--muted2)}
.rdx-legend-sw{width:14px;height:3px;border-radius:2px;flex-shrink:0}
.rdx-legend-band{height:10px;background:var(--rdx-band);border:1px solid var(--rdx-band-line)}
.rdx-legend-ev{width:10px;height:12px;flex-shrink:0;border-left:2px dashed var(--c);background:color-mix(in srgb,var(--c) 22%,transparent)}
.rdx-legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.rdx-legend-ring{width:9px;height:9px;border:1.6px solid var(--rdx-hot);border-radius:50%;flex-shrink:0}

/* 2. hero */
.rdx-demobar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:12px;padding:9px 12px;border:1px dashed var(--gold);border-radius:12px;background:color-mix(in srgb,var(--gold,#f5c842) 5%,transparent)}
.rdx-demobar .lbl{font:600 12px/1.3 var(--ui);letter-spacing:0;text-transform:none;color:var(--rdx-gold-ink);margin-right:2px}
.rdx-demobar .rdx-chip{font-size:12px;padding:4px 10px}
.rdx-demobar .rdx-chip.on{background:color-mix(in srgb,var(--gold,#f5c842) 16%,transparent);border-color:var(--gold);color:var(--rdx-gold-ink)}
/* #sec-hero is the hero's size container — never ROOT: containment would trap the fixed toast/modal */
.rdx #sec-hero{container:rdx-hero/inline-size}
.rdx-hero{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 20px;border-left:4px solid var(--muted2)}
/* Today card: headline + date, one instruction line, two numbers, then a closed "Details" disclosure */
.rdx-today-top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px}
.rdx-today-top>.rdx-hero-head{flex:1 1 260px;min-width:0}
.rdx-today-date{font-size:12px;font-weight:600;line-height:1.3;color:var(--muted2);white-space:nowrap}
.rdx-hero-head{display:flex;align-items:flex-start;gap:10px;font-family:var(--ui);font-size:22px;font-weight:800;letter-spacing:-.3px;line-height:1.25;color:var(--text);margin:0}
.rdx-hero-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;margin-top:calc(.625em - 5px)}   /* centred on the first line */
.rdx-today-do{margin:6px 0 0 20px;font-size:15px;line-height:1.55;color:var(--text);max-width:640px}   /* 20px = dot + gap: aligns under the headline text */
.rdx-today-top~.rdx-hero-notes{margin:4px 0 0 20px}
.rdx-today-nums{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 32px;margin:16px 0 0 20px;max-width:640px}
.rdx-today-num{min-width:0}
.rdx-today-num .k{font-size:12px;font-weight:600;line-height:1.3;color:var(--muted2)}
.rdx-today-num .v{margin-top:4px;font-family:var(--mono);font-size:24px;font-weight:700;line-height:1.2;color:var(--text);white-space:nowrap}
.rdx-today-num .v small{font-family:var(--ui);font-size:12px;font-weight:600;color:var(--muted2);margin-left:6px}
.rdx-today-num .x{margin-top:4px;font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-today-num .x>span{white-space:nowrap}
.rdx-today-ran .v{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 14px}
.rdx-today-ran .v .iad{font-size:16px}
.rdx-today-num .x b{font-family:var(--mono);font-weight:700;color:var(--text)}
.rdx-today-num .x b.lever{color:var(--rdx-accent-ink)}
.rdx-band{position:relative;height:6px;margin-top:8px;max-width:200px;border-radius:3px;background:var(--panel2)}
.rdx-band-safe{position:absolute;top:0;bottom:0;border-radius:3px;background:color-mix(in srgb,var(--good) 30%,transparent)}
.rdx-band i{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;box-sizing:border-box;border-radius:50%;border:2px solid var(--panel)}
.rdx-today-trend{margin:12px 0 0 20px;max-width:640px}
.rdx-today-more{margin:14px 0 0 20px}
.rdx-today-more>.rdx-more-body{max-width:760px}
.rdx-today-foot{margin:12px 0 0;font-size:13px;line-height:1.55;color:var(--muted2)}
.rdx-hero-cap{font-size:12px;color:var(--muted2);line-height:1.4;margin:0 0 8px}
.rdx-today-more .rdx-do-opts+*,.rdx-today-more .rdx-trend+.rdx-hero-cap{margin-top:14px}
.rdx-do-opts{list-style:none;margin:0 0 2px;padding:0;max-width:440px}
.rdx-do-opts li{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:baseline;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px;line-height:1.45;color:var(--text)}
.rdx-do-opts li:last-child{border-bottom:none}
.rdx-do-opts li b{font-family:var(--mono);font-size:13px;color:var(--text)}
.rdx-do-opts .lever-opt b{color:var(--rdx-accent-ink)}
.rdx-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.rdx-stat,.rdx-trend{background:var(--panel2);border-radius:8px;padding:10px 12px;min-width:0}
.rdx-stat .k,.rdx-trend .k{font-size:12px;font-weight:600;color:var(--muted2);line-height:1.3}
.rdx-stat .v,.rdx-trend .v{font-family:var(--mono);font-size:20px;font-weight:700;line-height:1.2;color:var(--text);white-space:nowrap}
.rdx-stat .v{margin-top:4px}
.rdx-stat .v small{font-family:var(--ui);font-size:12px;font-weight:600;color:var(--muted2);margin-left:4px}
.rdx-stat .x{display:flex;align-items:baseline;gap:6px;margin-top:3px;font-size:12px;line-height:1.35;color:var(--muted2)}
.rdx-hero-notes{margin:0 0 8px;font-size:12px;line-height:1.4;color:var(--muted2)}
/* "today so far" under the Last day label: generated content */
.rdx-stat-grid>.rdx-stat:first-child>.k::after{content:" · today so far";font-weight:400}
.rdx-tile-prev{font:400 12px/1.35 var(--ui);color:var(--muted2)}
.rdx-stat .x i{width:6px;height:6px;border-radius:50%;flex-shrink:0;transform:translateY(-1px)}
.rdx-trend{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;margin-top:8px}
.rdx-trend .x{font-size:12px;color:var(--muted2);line-height:1.35}
.rdx-hero-help{margin:8px 0 0;font-size:13px;line-height:1.55;color:var(--muted2);max-width:760px}
/* narrow card (phone, or the coaching column): numbers at 20, no 20px indent */
@container rdx-hero (max-width:520px){
  .rdx-today-do,.rdx-today-top~.rdx-hero-notes,.rdx-today-nums,.rdx-today-trend,.rdx-today-more{margin-left:0}
  .rdx-today-nums{gap:12px 16px}
  .rdx-today-num .v{font-size:20px}
}

/* 4. injury & illness history — event dots and the --warn gaps border are the only accents; no red text */
.rdx-pat-lead{font-size:15px;line-height:1.55;color:var(--text);margin:0 0 14px;max-width:760px}
.rdx-pat-lead b{font-weight:700}
.rdx-pat-act{margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px}
.rdx-sb-grid{max-width:var(--w-block,920px);display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px;align-items:start}
.rdx-sb-card{min-width:0;padding:16px 18px;background:var(--panel);border:1px solid var(--border);border-radius:12px}
.rdx-sb-card:focus,.rdx-sb-also li:focus{outline:none}
.rdx-sb-hd{display:flex;align-items:center;gap:8px;margin:0;font-size:12px;font-weight:600;line-height:1.4;color:var(--muted2)}
.rdx-sb-note{margin:6px 0 0;font-size:15px;font-weight:600;line-height:1.4;color:var(--text);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.rdx-sb-note.is-open{display:block;-webkit-line-clamp:unset;overflow:visible}
.rdx-sb-note-more{margin-top:2px;font-size:13px}
.rdx-sb-lbl{margin:14px 0 6px;font-size:12px;font-weight:600;color:var(--muted2)}
.rdx-sb-flags{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.rdx-sb-flags b{display:block;font-size:14px;font-weight:600;line-height:1.35;color:var(--text)}
.rdx-sb-flags .v{display:block;margin-top:1px;font-size:14px;line-height:1.45;color:var(--text)}
.rdx-sb-flags .r,.rdx-sb-ill{display:block;margin:2px 0 0;font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-sb-ill{margin-top:12px}
.rdx-sb-more{grid-column:1/-1;font-size:13px}
.rdx-sb-also{min-width:0;grid-column:1/-1;padding:6px 0 0}
.rdx-sb-also-hd{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--muted2)}
.rdx-sb-also ul{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));column-gap:24px}
.rdx-sb-also .t{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:14px;line-height:1.45;color:var(--text);overflow-wrap:anywhere}
.rdx-sb-also .t .rdx-ev-dot{transform:translateY(-1px)}
.rdx-sb-also .s{padding-left:16px;font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-sb-also .rdx-linkbtn{margin:10px 0 0 16px;font-size:13px}
.rdx-pat-more{display:block;margin-top:20px}
.rdx-pat-more .rdx-more-body>p{max-width:760px}
.rdx-pt-wrap{max-width:var(--w-block,920px);margin-top:4px;border:1px solid var(--border);border-radius:12px;background:var(--panel);overflow-x:auto}
.rdx-pt{width:100%;border-collapse:collapse;font-size:13px;line-height:1.45;color:var(--text);font-variant-numeric:tabular-nums}
.rdx-pt th{padding:10px 14px;text-align:left;font-size:12px;font-weight:600;line-height:1.35;color:var(--muted2);background:var(--panel2);border-bottom:1px solid var(--border);vertical-align:bottom}
.rdx-pt td{padding:12px 14px;vertical-align:top;border-bottom:1px solid var(--border)}
.rdx-pt tbody tr:last-child td{border-bottom:none}
.rdx-pt .c-rate{width:22%;min-width:150px}
.rdx-pt .c-x{width:17%;min-width:140px;text-align:right;white-space:nowrap}
.rdx-pt .nm{display:block;font-weight:600}
.rdx-pt .d{display:block;margin-top:2px;font-size:12px;color:var(--muted2)}
/* a rate: the % with its count, over a thin 0–100% bar (one scale across both columns) */
.rdx-pt .r{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.rdx-pt .r b{font-family:var(--mono);font-size:14px;font-weight:700}
.rdx-pt .r small{font-size:12px;color:var(--muted2)}
.rdx-pt .bar{display:block;height:6px;margin-top:7px;border-radius:3px;background:var(--panel2);overflow:hidden}
.rdx-pt .bar i{display:block;height:100%;min-width:2px;border-radius:3px;background:var(--muted2)}
.rdx-pt .bar.case i{background:var(--rdx-accent-ink)}
.rdx-pt .x{font-family:var(--mono);font-size:14px;font-weight:700}
.rdx-pt .x-na{color:var(--muted2)}
.rdx-pt .m{display:block;margin-top:2px;font-size:12px;color:var(--muted2);white-space:nowrap}
.rdx-pt .grp td{padding:16px 14px 6px;font-size:12px;font-weight:600;color:var(--muted2);background:var(--panel)}
.rdx-pt .lbl{display:none}
.rdx-pt-cav{margin:10px 0 0!important;font-size:13px}
/* training gaps: a fill + warn left border, not another bordered card */
.rdx #sec-patterns{container:rdx-pat/inline-size}
.rdx-gaps.is-clear{border-left-color:var(--border2)}
.rdx-gaps{margin-top:24px;max-width:var(--w-block,920px);padding:14px 16px;background:var(--panel2);border-left:4px solid var(--warn);border-radius:12px}
.rdx-gaps-hd{margin:0;font-size:14px;font-weight:600;line-height:1.35;color:inherit}
.rdx-gaps>summary{display:flex;width:100%;padding:0}
.rdx-gaps:not([open]){padding-top:10px;padding-bottom:10px}
.rdx-gaps-body{padding-top:2px}
.rdx-gaps-intro{margin:4px 0 0;max-width:760px;font-size:14px;line-height:1.55;color:var(--muted2)}
.rdx-gap-list{list-style:none;margin:12px 0 0;padding:0}   /* the block's 920px cap keeps a row's actions near its dates */
.rdx-gap-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 0;border-top:1px solid var(--border)}
.rdx-gap-main{flex:1 1 240px;min-width:0}
.rdx-gap-when{font-size:14px;font-weight:600;line-height:1.4;color:var(--text)}
.rdx-gap-ico{margin-right:7px;font-size:10px;vertical-align:1px;color:var(--rdx-warn-ink)}
.rdx-gap-stats{font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-gap-acts{display:flex;gap:6px;flex-shrink:0}
.rdx-gap-form{flex-basis:100%;min-width:0;padding:14px 16px;background:var(--panel);border-radius:8px;animation:rdx-fade .2s}
.rdx-gap-form-past{max-width:920px;margin:-8px 0 16px;border:1px solid var(--border2)}
.rdx-gf-fields{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.rdx-gf-note{flex:1 1 200px}
.rdx-gf-note input{width:100%}
.rdx-gf-hint{margin:8px 0 0;font-size:13px;line-height:1.5;color:var(--muted2)}
.rdx-gf-hint:empty{display:none}
.rdx-gf-acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px}
.rdx-dis{margin-top:12px;font-size:12px;color:var(--muted2)}
.rdx-dis .rdx-linkbtn{padding:6px 4px;margin:-6px 0}   /* touch-sized hit area, same line height */
.rdx-dis-list{list-style:none;margin:6px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,auto);justify-content:start;align-items:center;column-gap:10px}
.rdx-dis-list[hidden]{display:none}
.rdx-dis-item{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center;font-size:13px}   /* rows share the list's columns, so the Restore buttons line up */
.rdx-dis-when{color:var(--text)}
.rdx-pat-foot{margin-top:16px}

.rdx-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.rdx-tile{min-width:0;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.rdx-tile-lbl{font-size:12px;font-weight:600;line-height:1.3;color:var(--muted2)}
.rdx-tile-val{font-size:24px;font-weight:700;font-family:var(--mono);margin-top:8px;line-height:1.1;color:var(--text);white-space:nowrap}
.rdx-tile-unit{font-family:var(--ui);font-size:12px;font-weight:600;color:var(--muted2);margin-left:4px}
.rdx-tile-delta{margin-top:6px;line-height:1.35}
.rdx-tiles-note{grid-column:1/-1;margin:0}

/* 6. about */
.rdx-foot{font-size:13px;color:var(--muted2);line-height:1.6;max-width:760px;margin:16px 0 0}
.rdx-strava{display:block;margin-top:10px;line-height:0}
.rdx-strava img{height:15px;width:auto}
.rdx-strava-w{display:inline-block}
.rdx-strava-o{display:none}
html[data-theme="light"] .rdx-strava-w{display:none}
html[data-theme="light"] .rdx-strava-o{display:inline-block}

/* 7. toast — #rdxToast is the always-present live region; the box inside it is the visible toast.
   Above the sticky site nav (300), below the Lever modal (1000). */
.rdx-toast-box{pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:min(480px,100%);padding:9px 10px 9px 16px;background:var(--text);color:var(--bg);font-size:14px;line-height:1.4;border-radius:12px;box-shadow:var(--shadow-pop,0 8px 32px rgba(0,0,0,.45));animation:rdx-fade .18s ease-out}
.rdx-toast-box.err{border-left:4px solid var(--bad)}
.rdx-toast-msg{flex:1;min-width:0}
/* ghost buttons on the inverted box: no border, a --bg wash on hover */
.rdx-toast-box button{flex-shrink:0;min-height:36px;padding:3px 10px;font:inherit;font-weight:700;color:inherit;background:transparent;border:none;border-radius:8px;cursor:pointer}
.rdx-toast-box button:hover{background:color-mix(in srgb,var(--bg) 16%,transparent)}
.rdx-toast-box .rdx-toast-x{min-width:36px;padding:3px 8px}
.rdx-toast-box button:focus-visible{outline-color:var(--bg)}

/* Lever modal */
.rdx-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px 24px calc(24px + var(--esl-bottom-inset,var(--rdx-inset,0px)));background:var(--scrim,rgba(3,5,10,.6));animation:rdx-fade .15s}
.rdx-modal[hidden]{display:none}
.rdx-modal-panel{display:flex;flex-direction:column;width:100%;max-width:920px;max-height:100%;background:var(--panel);color:var(--text);border:1px solid var(--border2);border-radius:16px;box-shadow:var(--shadow-modal,0 22px 60px rgba(0,0,0,.45));outline:none;overflow:hidden}
.rdx-modal-hd{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px 6px;background:var(--panel)}
.rdx-modal-intro{padding:0 20px 14px;border-bottom:1px solid var(--border)}
.rdx-modal-title{font-size:17px;font-weight:800;letter-spacing:-.2px;margin:0}
.rdx-modal-sub{font-size:13px;color:var(--muted2);line-height:1.55;margin:0;max-width:660px}
.rdx-modal-x{flex-shrink:0;width:36px;height:36px;background:transparent;border:1px solid var(--border2);border-radius:8px;color:var(--muted2);font-family:inherit;font-size:13px;cursor:pointer}
.rdx-modal-x:hover{color:var(--text);border-color:var(--muted2)}
.rdx-lv-bar{display:flex;flex-wrap:wrap;gap:12px 26px;align-items:flex-start;padding:12px 20px;border-bottom:1px solid var(--border)}
.rdx-lv-bar input{width:62px;height:auto;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;padding:7px 9px;color:var(--text);font-family:var(--mono);font-size:13px;outline:none}
.rdx-lv-bar input:focus{border-color:var(--rdx-accent-ink);box-shadow:var(--focus-ring,0 0 0 3px rgba(0,229,200,.18))}
.rdx-lv-cap{font:400 12px/1.4 var(--ui);color:var(--muted2);min-height:17px}
.rdx-lv-cap.err{color:var(--rdx-bad-ink)}
.rdx-lv-note{flex-basis:100%;font-size:12px;color:var(--muted2);line-height:1.5}
.rdx-lv-bar .rdx-chip.on{color:var(--rdx-accent-ink)}
.rdx-lv-list{flex:1;overflow-y:auto;overscroll-behavior:contain;min-height:140px}
.rdx-lv-row{display:grid;grid-template-columns:16px 128px minmax(0,1fr) 54px 46px 46px 158px 50px;gap:10px;align-items:center;padding:8px 20px;border-bottom:1px solid var(--border);font-size:13px;cursor:pointer}
.rdx-lv-row:hover{background:var(--hover)}
.rdx-lv-row.on{background:var(--accent-wash,rgba(0,229,200,.08))}
.rdx-lv-row input{width:16px;height:16px;margin:0;accent-color:var(--cyan);cursor:pointer}
.rdx-lv-head{position:sticky;top:0;z-index:1;background:var(--panel2);cursor:default;font:600 12px/1.3 var(--ui);letter-spacing:0;text-transform:none;color:var(--muted2)}
.rdx-lv-head:hover{background:var(--panel2)}
.rdx-lv-head .r{text-align:right}
.rdx-lv-head .c-all{display:none;cursor:pointer;font-size:12px;letter-spacing:0}
.rdx-lv-date{font:600 13px/1.3 var(--ui);color:var(--text);white-space:nowrap}
.rdx-lv-date small{font-size:12px;font-weight:400;color:var(--muted2);margin-left:6px}
.rdx-lv-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rdx-lv-num{font-family:var(--mono);font-size:12px;color:var(--muted2);text-align:right;white-space:nowrap}
.rdx-lv-meta{display:none}
.rdx-lv-badge{justify-self:start;font-family:var(--mono);font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;border:1px solid var(--border2);color:var(--muted2);white-space:nowrap}
.rdx-lv-badge.lever{color:var(--rdx-accent-ink);border-color:var(--accent-line,rgba(0,229,200,.30));background:var(--accent-wash,rgba(0,229,200,.08))}
.rdx-lv-badge.not{color:var(--rdx-warn-ink);border-color:var(--warn-line,rgba(245,166,35,.32))}
.rdx-lv-iad{font-family:var(--mono);font-size:13px;font-weight:700;text-align:right;white-space:nowrap}
.rdx-lv-iad small{display:none;font:600 12px var(--ui);color:var(--muted2)}
.rdx-lv-empty{padding:34px 20px;text-align:center;color:var(--muted2);font-size:13px}
.rdx-modal-ft{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:12px 20px;border-top:1px solid var(--border2);background:var(--panel2)}
.rdx-lv-sum{font:400 13px/1.45 var(--ui);color:var(--muted2);flex-basis:100%}
.rdx-lv-sum b{color:var(--text)}
.rdx-lv-acts{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}
.rdx-lv-toast{flex-basis:100%;font:400 13px/1.45 var(--ui);color:var(--rdx-good-ink)}
.rdx-lv-toast.err{color:var(--rdx-bad-ink)}
.rdx-lv-toast:empty{display:none}
@media(max-width:599px),(max-height:560px){
  .rdx-modal{padding:0 0 var(--esl-bottom-inset,var(--rdx-inset,0px))}   /* sheet footer sits above the act-as banner */
  /* phone, or any short viewport (landscape phone, zoomed laptop): the whole sheet scrolls (title
     bar + action footer stay pinned) — a fixed-height panel would push the footer out of reach */
  .rdx-modal-panel{max-width:none;height:100%;border:none;border-radius:0;overflow-y:auto;overscroll-behavior:contain}
  .rdx-modal-panel>*{flex-shrink:0}
  .rdx-modal-hd{position:sticky;top:0;z-index:3;padding-bottom:10px;border-bottom:1px solid var(--border)}
  .rdx-modal-intro{padding-top:10px}
  .rdx-lv-list{flex:none;overflow:visible;min-height:0}
  .rdx-lv-head{position:static}
  .rdx-modal-ft{position:sticky;bottom:0;z-index:3}
}
@media(max-height:560px){
  /* landscape phone: clamp the intro + note to one line so run rows show above the pinned footer (full text stays in aria-describedby) */
  .rdx-modal-sub,.rdx-lv-note{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
  .rdx-modal-hd{padding-top:10px;padding-bottom:8px}
  .rdx-modal-intro{padding-top:6px;padding-bottom:6px}
  .rdx-lv-bar{padding-top:8px;padding-bottom:8px;row-gap:4px}
  .rdx-modal-ft{padding-top:8px;padding-bottom:8px;row-gap:4px}
}
@media(max-width:599px){
  .rdx-modal-hd,.rdx-modal-intro,.rdx-lv-bar,.rdx-modal-ft{padding-left:16px;padding-right:16px}
  .rdx-lv-bar input{font-size:16px}   /* iOS Safari zooms into any focused input under 16px */
  .rdx-lv-row{grid-template-columns:16px minmax(0,1fr) auto;grid-template-areas:"cb date badge" "cb title title" "cb meta iad";gap:3px 10px;padding:10px 16px}
  .rdx-lv-row>input{grid-area:cb;align-self:start;margin-top:1px}
  .rdx-lv-date{grid-area:date}.rdx-lv-title{grid-area:title}.rdx-lv-badge{grid-area:badge;justify-self:end}.rdx-lv-iad{grid-area:iad}
  .rdx-lv-num{display:none}
  .rdx-lv-meta{display:block;grid-area:meta;font-family:var(--mono);font-size:12px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rdx-lv-iad small{display:inline}
  .rdx-lv-head{grid-template-areas:"cb date date"}
  .rdx-lv-head span{display:none}
  .rdx-lv-head .c-all{display:block;grid-area:date}
  .rdx-lv-acts{width:100%}
  .rdx-lv-acts .rdx-btn{flex:1;padding-left:8px;padding-right:8px}
}
@media(max-width:599px){
  .rdx-card{padding:14px 16px}
  :where(.rdx) :is(select,input[type=text],input[type=date],input[type=number]){height:40px;font-size:16px}   /* iOS zooms into inputs under 16px */
  /* hero: the narrow-card container query handles the layout */
  .rdx-hero{padding:14px 16px}
  .rdx-hero-head{font-size:20px}
  .rdx-do-opts{max-width:none}
  .rdx-seg button{flex:1;padding:0 6px}
  .rdx-chartwrap{padding:10px 8px 6px}
  /* injury: gap rows → dates, stats, then a full-width action row; the gap form goes to one column
     (the stats table stacks by the section's own width — @container rdx-pat below) */
  .rdx-gaps{padding:14px}
  .rdx-dis-list{display:block}
  .rdx-dis-item{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"w b" "a b";column-gap:10px;padding:3px 0}
  .rdx-dis-when{grid-area:w}
  .rdx-dis-at{grid-area:a;font-size:12px}
  .rdx-dis-at>span{display:none}
  .rdx-dis-item .rdx-btn{grid-area:b}
  .rdx-gap-acts{width:100%}
  .rdx-gap-acts .rdx-btn{flex:1;min-height:40px}
  .rdx-gap-form{padding:12px}
  .rdx-gf-fields{display:grid;grid-template-columns:minmax(0,1fr)}
  .rdx-gf-fields :is(select,input){width:100%}
  .rdx-gf-acts{flex-direction:column-reverse}
  .rdx-gf-acts .rdx-btn{width:100%;min-height:40px}
  .rdx-tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .rdx-tile{padding:12px 14px}
  .rdx-tile-val{font-size:22px}
}
@media(max-width:560px){
  .rdx-table{font-size:12px}
  .rdx-table th,.rdx-table td{padding:7px 8px}
}
/* touch: every control at least 40px tall (spec §5). Last, so it beats the base sizes above; a summary
   grows by padding, keeping its baseline-aligned chevron on line 1 when it wraps */
/* injury stats table → stacked rows ("1 of 1 injury · 22% of normal weeks") whenever the section itself is
   narrow (coaching side panel, tablet), not only on a phone viewport */
@container rdx-pat (max-width:620px){
  .rdx-pt,.rdx-pt tbody{display:block}
  .rdx-pt thead{display:none}
  .rdx-pt tr{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;padding:14px;border-bottom:1px solid var(--border)}
  .rdx-pt tbody tr:last-child{border-bottom:none}
  .rdx-pt td,.rdx-pt .c-rate,.rdx-pt .c-x{display:block;width:auto;min-width:0;padding:0;border:none}
  .rdx-pt td:first-child,.rdx-pt .c-x{grid-column:1/-1}
  .rdx-pt .c-x{text-align:left}
  .rdx-pt .c-x .x,.rdx-pt .c-x .m{display:inline;margin:0}
  .rdx-pt .c-x .lbl{display:inline;margin-right:6px}
  .rdx-pt .c-x .m::before{content:" · "}
  .rdx-pt .lbl{display:block;margin-bottom:3px;font-size:12px;font-weight:600;color:var(--muted2)}
  .rdx-pt .grp{display:block;padding:0}
  .rdx-pt .grp td{display:block;padding:9px 14px}
}
@media(pointer:coarse){
  .rdx-btn,.rdx-seg button,.rdx-gapchip,.rdx-toast-box button{min-height:40px}
  .rdx-more>summary{padding:10px 0;min-height:40px}
  .rdx-dis .rdx-linkbtn{padding:11px 6px;margin:-11px -2px}
  .rdx-link,.rdx-linkbtn{padding:11px 4px;margin:-11px -4px}   /* text buttons: 40px hit area, same line box */
  .rdx-sb-also .rdx-linkbtn{margin:-1px 0 -11px 12px}              /* keeps its 10px gap and 16px indent */
  /* fields too, on any touch screen (a landscape phone is wider than the 599px phone block): iOS zooms under 16px */
  :where(.rdx) :is(select,input[type=text],input[type=date],input[type=number]){height:40px;font-size:16px}
  .rdx-lv-bar input{font-size:16px;min-height:40px}
}
@media(prefers-reduced-motion:reduce){.rdx *,.rdx{animation:none!important;transition:none!important}}

/* ── Direction A additions ───────────────────────────────────────────── */
/* status strip: freshness + import status, the gaps chip, Data (with a count of runs to review) and Settings */
.rdx-strip{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;margin-top:16px;scroll-margin-top:72px}
.rdx-status{flex:1 1 320px;min-width:0;font-size:13px;line-height:1.5;color:var(--muted2)}
.rdx-status .ok,.rdx-imp-note .ok{color:var(--rdx-good-ink)}
.rdx-status .err,.rdx-imp-note .err{color:var(--rdx-bad-ink)}
.rdx-status .warn{color:var(--rdx-warn-ink)}
.rdx #importStatus:not(:empty)::before{content:"·";margin:0 7px}
.rdx #rdxFresh:empty+#importStatus::before{content:none}
.rdx-strip-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rdx-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;margin-left:2px;padding:0 5px;font:700 11px/1 var(--mono);color:var(--on-accent,#000);background:var(--warn,#f5a623);border-radius:999px}
.rdx-perr{margin:8px 0 0;font-size:13px;line-height:1.5;color:var(--rdx-bad-ink)}

/* sections: always laid out; the view decides which exist */
.rdx-section{margin-top:36px;scroll-margin-top:72px}
.rdx #sec-hero,.rdx #sec-empty{margin-top:16px}
.rdx #gcToday .rdx-garmin-credit{margin:0 0 8px}

/* Load: range control and custom dates */
.rdx-dates{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 12px}

/* Form: period, the Counts line and its filters, the trend controls */
.rdx-period{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 12px}
.rdx-period-more{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 16px;margin:0 0 12px}
.rdx-scope{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 12px;padding:8px 12px;font-size:13px;line-height:1.5;color:var(--muted2);background:var(--panel2);border:1px solid var(--border);border-radius:8px}
.rdx-scope b{font-weight:600;color:var(--text)}
.rdx-scope .warn{font-weight:600;color:var(--rdx-warn-ink)}
.rdx-scope-panel{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 20px;margin-top:6px;padding:10px 0 4px;border-top:1px solid var(--border)}
.rdx-trend-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:16px 0 10px}
.rdx-trend-ctl>label{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--muted2)}
.rdx-trend-ctl>.rdx-types{margin-left:auto}
.rdx-chart-svg .rdx-shade{fill:var(--panel2)}
.rdx-chart-svg .rdx-shade-lbl{font-family:var(--ui);fill:var(--muted2)}
.rdx-all{display:block;margin-top:12px}
.rdx-all .rdx-tablewrap{max-width:var(--w-block,920px)}
.rdx-chartbox{position:relative}

/* Your setbacks and events (Injury Patterns) */
.rdx #sec-events{container:rdx-ev/inline-size}
.rdx-wtl-line{margin:10px 0 12px;max-width:760px;font-size:13px;line-height:1.55;color:var(--muted2)}
.rdx-wtl-line b{font-weight:600;color:var(--text)}
.rdx-evlist{list-style:none;margin:0;padding:0;max-width:var(--w-block,920px);background:var(--panel);border:1px solid var(--border);border-radius:12px}
.rdx-evlist li{display:grid;grid-template-columns:170px 200px minmax(0,1fr) auto;align-items:center;gap:4px 16px;padding:8px 14px;border-bottom:1px solid var(--border);font-size:13px}
.rdx-evlist li:last-child{border-bottom:none}
.rdx-evlist li.editing{background:var(--accent-wash,rgba(0,229,200,.08))}
.rdx-ev-t{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--text)}
.rdx-ev-w{font-family:var(--mono);font-size:12px;color:var(--muted2);white-space:nowrap}
.rdx-ev-n{min-width:0;color:var(--text);overflow-wrap:anywhere}
.rdx-ev-acts{display:flex;gap:4px}
.rdx-ev-none{margin:0;font-size:13px;color:var(--muted2)}
.rdx-evmore{margin:8px 0 0;font-size:13px}
@container rdx-ev (max-width:640px){
  .rdx-evlist li{grid-template-columns:minmax(0,1fr) auto}
  .rdx-ev-w,.rdx-ev-n{grid-column:1}
  .rdx-ev-acts{grid-column:2;grid-row:1/span 3}
}
.rdx-gap-form.rdx-evform-list{max-width:var(--w-block,920px);margin:0 0 12px;border:1px solid var(--accent-line,rgba(0,229,200,.3))}
.rdx-modal-body .rdx-gap-form{padding:0;background:transparent}

/* sheets (Data, Settings): a panel from the right edge over a scrim */
.rdx-ov{position:fixed;inset:0;z-index:950;display:flex;justify-content:flex-end;background:var(--scrim,rgba(3,5,10,.6));animation:rdx-fade .15s}
.rdx-sheet{display:flex;flex-direction:column;width:min(480px,100%);height:100%;background:var(--panel);color:var(--text);border-left:1px solid var(--border2);box-shadow:var(--shadow-modal,0 22px 60px rgba(0,0,0,.45));outline:none;overflow-y:auto;overscroll-behavior:contain;padding-bottom:calc(16px + var(--esl-bottom-inset,var(--rdx-inset,0px)))}
.rdx-sheet-hd{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;background:var(--panel);border-bottom:1px solid var(--border)}
.rdx-sheet-title{margin:0;font-size:17px;font-weight:800;letter-spacing:-.2px}
.rdx-sheet .rdx-garmin-credit{margin:0;padding:12px 20px 0}
.rdx-sgrp{padding:14px 20px;border-bottom:1px solid var(--border)}
.rdx-sgrp:last-of-type{border-bottom:none}
.rdx-sgrp-hd{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--muted2)}
.rdx-sfields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.rdx-sfields .full{grid-column:1/-1}
.rdx-sfields .rdx-inunit input{width:96px}
.rdx-sfields select{width:100%}
.rdx-hint{margin:0;font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-inline-field{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--text)}
.rdx-inline-field input{width:72px}
.rdx-import>.rdx-drop{flex:none}
.rdx-sheet .rdx-drop{padding:12px 14px}
.rdx-lv-bar input[type=checkbox]{width:16px;height:16px;padding:0}
.rdx-sheet .rdx-import{gap:10px}
.rdx-imp-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.rdx-imp-note{margin:0;font-size:13px;line-height:1.5;color:var(--muted2)}
.rdx-imp-note:empty{display:none}
.rdx-stored{margin:0;font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-clean{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 8px;padding:10px 12px;background:var(--panel2);border:1px solid var(--border);border-radius:10px}
.rdx-clean.warn{border-left:4px solid var(--warn,#f5a623)}
.rdx-clean-txt{flex:1 1 220px;min-width:0}
.rdx-clean-txt b{display:block;font-size:13px;font-weight:600;line-height:1.4;color:var(--text)}
.rdx-clean-txt span{display:block;font-size:12px;line-height:1.45;color:var(--muted2)}
.rdx-clean-acts{display:flex;flex-wrap:wrap;gap:6px}
.rdx-clean-list{flex-basis:100%;list-style:none;margin:2px 0 0;padding:0;display:grid;gap:4px}
.rdx-clean-list li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 10px;font-size:12px;line-height:1.45;color:var(--text)}
.rdx-clean-ok{margin:0 0 8px;font-size:13px;color:var(--muted2)}
.rdx-del-cap{margin:6px 0 0;font-size:12px;color:var(--muted2)}

/* small modal (Log an event) */
.rdx-modal-panel.rdx-modal-sm{max-width:640px}
.rdx-modal-body{padding:16px 20px;overflow-y:auto}
.rdx-lv-def{flex-basis:100%;min-height:0}
.rdx-still,.rdx-still>*{animation:none!important}
.rdx-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#sec-empty .rdx-imp-note{display:none}
.rdx-field-err:empty{display:none}
.rdx-toast{position:fixed;left:0;right:0;bottom:calc(16px + env(safe-area-inset-bottom) + var(--esl-bottom-inset,var(--rdx-inset,0px)));z-index:1100;display:flex;justify-content:center;padding:0 16px;pointer-events:none}

@media(max-width:599px){
  .rdx-strip{flex-direction:column;align-items:stretch;gap:8px}
  .rdx-status{flex:none;font-size:12px}
  .rdx-strip-acts .rdx-btn{flex:1;min-height:40px}
  .rdx-section{margin-top:28px}
  .rdx-sec-ctl,.rdx-sec-ctl .rdx-seg{width:100%}
  .rdx-sec-ctl .rdx-seg{display:flex}
  .rdx-period,.rdx-period .rdx-ctl,.rdx-period select{width:100%}
  .rdx-dates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
  .rdx-dates input,.rdx-period-more input{width:100%}
  .rdx-trend-ctl>label{flex:1 1 100%}
  .rdx-trend-ctl select{flex:1;min-width:0}
  .rdx-trend-ctl>.rdx-types{margin-left:0}
  .rdx-sheet{width:100%;border-left:none}
  .rdx-sfields{grid-template-columns:minmax(0,1fr)}
  .rdx-sgrp,.rdx-sheet-hd{padding-left:16px;padding-right:16px}
  .rdx-modal-body{padding:12px 16px}
}
@media(pointer:coarse){
  .rdx-types>.rdx-chip,.rdx-demobar .rdx-chip{display:inline-flex;align-items:center;min-height:40px}
  .rdx-toast-box .rdx-toast-x,.rdx-modal-x{width:40px;min-width:40px;height:40px}
}
`;
function injectCSS(){
  if(document.getElementById('rdx-styles')) return;
  var s=document.createElement('style'); s.id='rdx-styles'; s.textContent=CSS;
  document.head.appendChild(s);
}

/* ---------- the metric registry (select values are keys) ---------- */
var METRICS = [
  { key:'duty',   label:'Duty Factor',         unit:'%',   dec:1, better:'lower', needs:'gct',
    desc:'Share of each stride spent on the ground',
    calc:function(r){ return (r.cadence!=null&&r.gct!=null)? r.gct*r.cadence/1200 : null; } },
  { key:'vgrf',   label:'Peak vGRF',           unit:'BW',  dec:2, better:'lower', needs:'gct',
    desc:'Estimated peak vertical impact force, in body weights',
    calc:function(r){ return RunLoad.vgrfBW(r); } },
  { key:'force',  label:'Peak Force',          unit:'N',   dec:0, better:'lower', needs:'gct', needsWeight:true,
    desc:'Estimated peak vertical impact force, in newtons (needs body weight)',
    calc:function(r){ return RunLoad.vgrfN(r, weightKg()); } },
  { key:'gct',    label:'Ground Contact Time', unit:'ms',  dec:0, better:'lower', needs:'gct',
    desc:'Time the foot spends on the ground each step',
    calc:function(r){ return r.gct; } },
  { key:'vo',     label:'Vertical Oscillation',unit:'cm',  dec:1, better:'lower', needs:'vo',
    desc:'How much the body bounces up and down each step',
    calc:function(r){ return r.vo; } },
  { key:'vratio', label:'Vertical Ratio',      unit:'%',   dec:1, better:'lower', needs:'vratio',
    desc:'Bounce relative to stride length — lower is more efficient',
    calc:function(r){ return r.vratio; } },
  { key:'cad',    label:'Cadence',             unit:'spm', dec:0, better:'higher', needs:null,
    desc:'Steps per minute',
    calc:function(r){ return r.cadence; } },
  { key:'stride', label:'Stride Length',       unit:'m',   dec:2, better:null, needs:'stride',
    desc:'Distance covered per step',
    calc:function(r){ return r.stride; } },
  { key:'asym',   label:'L/R contact asymmetry',   unit:'%',   dec:1, better:'lower', needs:'gctBalance',
    desc:'Left/right imbalance in ground contact time',
    calc:function(r){ return r.gctBalL!=null? Math.abs(r.gctBalL-50) : null; } },
  { key:'eff',    label:'Form Efficiency',     unit:'m/cm',dec:2, better:'higher', needs:'vo',
    desc:'Distance covered per unit of bounce — higher is more efficient',
    calc:function(r){ return (r.stride!=null&&r.vo)? r.stride/r.vo : null; } },
  { key:'pace',   label:'Avg Pace',            unit:'/mi', dec:0, better:null, pace:true, needs:null,
    desc:'Average pace',
    calc:function(r){ return r.paceSec; } },
  { key:'hr',     label:'Avg HR',              unit:'bpm', dec:0, better:'lower', needs:null,
    desc:'Average heart rate',
    calc:function(r){ return r.avgHr; } },
  { key:'impact', label:'Impact Load',         unit:'IAD mi',  dec:1, better:null, needs:null, zeroFill:true,
    desc:'Modeled mechanical load of each run, in IAD mi',
    calc:function(r){ return window.RunLoad ? RunLoad.impactLoad(r, LOAD_PARAMS) : null; } },
];
var BY_KEY={}; METRICS.forEach(function(m){ BY_KEY[m.key]=m; });
var METRIC_GROUPS=[['Form',['cad','gct','vo','vratio','asym','stride']],['Effort',['pace','hr']],['Load',['impact']],['Derived',['duty','vgrf','force','eff']]];
var TILE_KEYS=['cad','gct','vo','vratio','asym','stride','pace'];
// Form periods: each compares with the period of the same length before it ('all' compares with nothing)
var PERIODS=[['30','Last 30 days'],['90','Last 90 days'],['365','Last year'],['all','All runs'],['custom','Custom range']];

/* ---------- events: labels, colours, hints (stored type values never change) ---------- */
var EV_META={ injury:['Injury','var(--bad)'], race:['Race','var(--good)'], illness:['Illness','#f59a4d'], nonrun:['Non-Running Injury','#ef6bab'], timeoff:['Planned Downtime','#5b9cf5'] };
var EV_HEX={ injury:'#f55050', race:'#22c78a', illness:'#f59a4d', nonrun:'#ef6bab', timeoff:'#5b9cf5' };
var EV_ORDER=['injury','illness','nonrun','race','timeoff'];
var EV_HINT={
  race:'A race or time trial. Marked on the charts; explains a taper or recovery dip.',
  injury:'An overuse injury that built up from running. Its lead-up is analyzed in the report.',
  illness:'A significant illness that stopped training. Checked against overtraining-type patterns only.',
  nonrun:'An acute injury that didn’t come from running (a basketball ankle, a bike crash). Explains the gap; stays out of the analysis.',
  timeoff:'A planned break (off-season, vacation). Explains the gap; stays out of the analysis.'
};
var EV_PH={race:'e.g. Boston Marathon', injury:'e.g. Achilles', illness:'e.g. flu', nonrun:'e.g. bike crash', timeoff:'e.g. vacation'};
var EV_END_MSG='The end date can’t be before the start — leave End empty for a one-day event.';
var EV_FUTURE_MSG='An injury or illness can’t be dated in the future.';
var WTL_LINE='<b>What to log:</b> overuse injuries → Injury · acute injuries not from running → Non-Running Injury · significant illnesses → Illness · planned breaks → Planned Downtime.';
var PATTERN_COPY={ ramp:'Weekly load climbing week after week', acwr:'Recent load well above the usual base', longrun:'One run much longer than the usual long run',
  intensity:'A bigger share of hard sessions than usual', monotony:'Running most days with little variation or rest', downhill:'Far more downhill than usual' };
var FORM_TOL={cad:1.5, gct:4, vo:0.3, vratio:0.3, asym:0.5, stride:0.02, pace:5, hr:2, duty:0.5, vgrf:0.03, force:20, eff:0.01};
var DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var RANGE_BAD_MSG='Pick a valid date range — From must be before To.';

/* ---------- the data side (shared/run-dynamics-data.js) ---------- */
var RD=RunData.S, DAY=RunData.DAY, MONTHS=RunData.MONTHS, FILTER_DEFAULTS=RunData.FILTER_DEFAULTS, EV_NO_FUTURE=RunData.EV_NO_FUTURE;
var hmsToSec=RunData.hmsToSec, parseDate=RunData.parseDate, ymd=RunData.ymd, dayEnd=RunData.dayEnd, fmtPace=RunData.fmtPace, fmtDay=RunData.fmtDay,
  fmtSpan=RunData.fmtSpan, fmtMD=RunData.fmtMD, daysAgo=RunData.daysAgo, fmtRel=RunData.fmtRel, canonJSON=RunData.canonJSON,
  parseCorosArchive=RunData.parseCorosArchive, corosErrMsg=RunData.corosErrMsg, actCol=RunData.actCol, backfill=RunData.backfill,
  deleteAllRuns=RunData.deleteAllRuns, persist=RunData.persist, revertKey=RunData.revertKey, updateProfileList=RunData.updateProfileList,
  loadProfile=RunData.loadProfile, fetchStravaLever=RunData.fetchStravaLever, leverPct=RunData.leverPct, easyPaceSec=RunData.easyPaceSec,
  weightKg=RunData.weightKg, deviceId=RunData.deviceId, hasAccessory=RunData.hasAccessory, workoutPaceSec=RunData.workoutPaceSec,
  includedPref=RunData.includedPref, effType=RunData.effType, runFlag=RunData.runFlag, exclMatch=RunData.exclMatch,
  filterIntensity=RunData.filterIntensity, events=RunData.events, evFuture=RunData.evFuture, evAddFn=RunData.evAddFn,
  dismissedDrops=RunData.dismissedDrops, sameDis=RunData.sameDis, syncActor=RunData.syncActor, acwrColor=RunData.acwrColor;
function loadFromFirestore(){ return RunData.fetchRuns().then(function(runs){ if(runs) RAW=runs; }); }
function annotate(){ RunData.annotateLever(RAW); RunData.annotateExcluded(RAW); }
function computeLoadParams(){ return RunData.computeLoadParams(loadRuns(), intensity().cutoff); }

/* ---------- per-mount state ---------- */
var ROOT=null, DB=null, UID=null, ROLE='athlete', ADMIN=false, VIEW='training';
var MOUNT=0;            // bumped by every mount(): async results for an older mount are dropped
var RAW=[], LOAD_PARAMS=null, DEMO=null;
// UI: everything the athlete chose on screen. Serialisable, so a remount (tab switch, a coach switching
// athletes and back) puts it back as it was: VIEWSTATE[uid] keeps it per athlete, across both views.
function uiDefaults(){ return {
  range:'3', from:'', to:'',                                     // Load
  period:'90', aFrom:'', aTo:'', cmp:'prev', bFrom:'', bTo:'',   // Form period and what it's compared with
  metric:'', metric2:'', smooth:true, points:false, hideOut:true, scopeOpen:false, allOpen:false,
  heroMore:false, heroHelp:false, aboutOpen:false,
  patStats:true, gapsOpen:false, sbMore:false, alsoAll:false, disOpen:false, evMore:false, noPaceOpen:false
}; }
var UI=uiDefaults(), VIEWSTATE={};
var EVF=null;           // the open event form: {where:'list'|'past'|'gap'|'dialog', t0, editId, type, start, end, note} — re-opened as typed after a re-render
var LAYER={sheet:null, modal:null, trigger:null, modalTrigger:null};   // the open side sheet and the modal over it, and where focus returns
var LV={filter:'all', sel:new Set(), rows:[], toastT:null};
var DIS_T=0, DIS_SEQ=0, EV_SEQ=0, DIS_STATUS=[];
var TOAST_T=0, TOAST_BACK=null;
var IMPORT_BUSY=false, IMPORT_EXTRA='';
var RO=null, RO_T=0, CHART_W={};
var LAST_GOOD={};
var DOC_KEYS=false;     // the document-level key listener is added once
var BACKFILL_BUSY=false, DELETING=false;   // a Strava backfill / delete-all is running: their buttons stay disabled across re-renders
var KEEP_SHEET=false;    // refresh() leaves the open Settings sheet as it is (a field just saved; focus may be moving to the next one)        // the last valid text of each Settings field, put back after an invalid entry

/* ---------- small helpers ---------- */
function $(id){ return ROOT ? ROOT.querySelector('#'+id) : null; }
function $all(sel){ return ROOT ? ROOT.querySelectorAll(sel) : []; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Garmin credit under a view's title: "Garmin <model>" per device in the shown runs (plain "Garmin"
// when the model is unknown); derived views (load, patterns) say the insight comes partly from Garmin.
// One line each: shared/run-dynamics-garmin.test.js lifts them out of this file.
function garminLabel(d){ d=String(d==null?'':d).trim().replace(/^garmin(\s+|$)/i,''); return (d&&d.toLowerCase()!=='unknown')?'Garmin '+d:'Garmin'; }
function garminCredit(runs,derived){ var n=[]; (runs||[]).forEach(function(r){ if(r&&r.source==='garmin'){ var l=garminLabel(r.deviceName); if(n.indexOf(l)<0) n.push(l); } }); return n.length?'<p class="rdx-garmin-credit">'+(derived?'Insights derived in part from Garmin device-sourced data · ':'')+esc(n.join(', '))+'</p>':''; }
// Every slot sits over numbers derived in part from every stored run (the load baseline is calibrated from all of them).
function renderGarminCredit(){ ['gcToday','gcLoad','gcForm','gcPat','gcLv','gcData','gcSet'].forEach(function(id){ var el=$(id); if(el) el.innerHTML=garminCredit(RAW,true); }); }
// Role-aware copy: the coach sees the same view about "this athlete".
function who(k){ var c=ROLE==='coach'; return { your:c?'this athlete’s':'your', Your:c?'This athlete’s':'Your', you:c?'this athlete':'you', 'you have':c?'this athlete has':'you have', their:c?'their':'your' }[k||'your']; }
function plural(n,one,many){ return n+' '+(n===1?one:(many||one+'s')); }
function fmtMi(x){ var r=Math.round(x*2)/2; return (r%1===0)?String(r):r.toFixed(1); }
function fmtPct(x){ var v=Math.round(x*10)/10; return (v%1===0)?String(v):v.toFixed(1); }
function evLabel(e){ return (EV_META[e.type]||EV_META.race)[0]+' · '+fmtSpan(e.ts,e.endTs); }
function evDot(t){ return '<span class="rdx-ev-dot" style="background:'+(EV_HEX[t]||EV_HEX.race)+'" aria-hidden="true"></span>'; }
// State tint as TEXT: brand good/warn/bad/gold fail contrast on light surfaces, so text takes the ink tokens.
function ink(c){ return {'var(--good)':'var(--rdx-good-ink)','var(--warn)':'var(--rdx-warn-ink)','var(--bad)':'var(--rdx-bad-ink)','var(--gold)':'var(--rdx-gold-ink)'}[c]||c; }
function smoothScroll(el){ var reduce=window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; el.scrollIntoView({block:'start', behavior:reduce?'auto':'smooth'}); }
// Re-render fn's part of the page, then put focus (and a text field's caret) back where it was: re-renders
// happen under an open form when another device's write lands or a setting changes.
function withFocus(fn){
  var a=document.activeElement, k=null, sel=null;
  if(a && ROOT && ROOT.contains(a)){
    k=a.id?'#'+a.id:a.getAttribute('data-f')?'[data-f="'+a.getAttribute('data-f')+'"]':null;
    if(k && typeof a.selectionStart==='number') try{ sel=[a.selectionStart,a.selectionEnd]; }catch(_){}
  }
  fn();
  var f=k&&ROOT.querySelector(k);
  if(f && document.activeElement!==f){ f.focus({preventScroll:true}); if(sel) try{ f.setSelectionRange(sel[0],sel[1]); }catch(_){} }
}

/* ---------- which runs count where ---------- */
// Min distance and per-run exclusions apply everywhere. The activity types and intensity on the Form
// "Counts:" line apply to Form only: the load side (Today, Load, Injury Patterns, the IAD baseline) counts
// every run, a Lever run at its offload (owner decision 2026-10-22).
function minDist(){ var v=parseFloat(includedPref().mindist); return (v>=0)?v:0.5; }
function analyzable(r){ return !r._excl && r.distMi!=null && r.distMi>=minDist(); }
function loadRuns(){ return RAW.filter(analyzable); }
function intensity(){ return { mode:includedPref().intensity, cutoff:workoutPaceSec()||hmsToSec(FILTER_DEFAULTS.cutoff) }; }
function knownTypes(){ var c={}; RAW.forEach(function(r){ var t=effType(r); c[t]=(c[t]||0)+1; }); return c; }
function typeOn(t){ return includedPref().off.indexOf(t)<0; }
function typeRuns(){ return RAW.filter(function(r){ return typeOn(effType(r)) && analyzable(r); }); }
// Form's runs between two instants (start exclusive, end inclusive), with the intensity filter.
function formRuns(t0,t1){ var it=intensity(); return filterIntensity(typeRuns().filter(function(r){ return r.ts>t0 && r.ts<=t1; }), it.mode, it.cutoff); }
function metricMean(runs,m){
  var vals=runs.map(m.calc).filter(function(v){ return v!=null && !isNaN(v); });
  if(!vals.length) return null;
  return vals.reduce(function(a,b){return a+b;},0)/vals.length;
}
function metricVisible(m){ return RunDevices.status(m.needs, deviceId(), hasAccessory())==='native'; }
function fmtVal(v,m){
  if(v==null) return '<span class="rdx-val na">–</span>';
  if(m.pace) return '<span class="rdx-val">'+fmtPace(v)+'</span>';
  return '<span class="rdx-val">'+v.toFixed(m.dec)+'</span>';
}
// "≈ same" deadband: a change smaller than ordinary run-to-run noise isn't a change.
function deltaHTML(cur,prev,m){
  if(cur==null||prev==null) return '';
  var diff=cur-prev, tol=FORM_TOL[m.key]!=null?FORM_TOL[m.key]:0.5*Math.pow(10,-m.dec);
  if(Math.abs(diff)<tol) return '<span class="rdx-delta flat same">≈ same</span>';
  var dir=diff>0?'▲':'▼', cls='flat';
  if(m.better==='lower') cls=diff<0?'up':'down';
  else if(m.better==='higher') cls=diff>0?'up':'down';
  if(m.pace){ var g=Math.round(Math.abs(diff)), gap=g<60?g+' s':fmtPace(g);   // pace in words: no ▲/▼ (up = slower reads backwards)
    return '<span class="rdx-delta '+cls+'">'+gap+(diff>0?' slower':' faster')+'</span>'; }
  var txt=(diff>0?'+':'−')+Math.abs(diff).toFixed(m.dec);
  return '<span class="rdx-delta '+cls+'"><span aria-hidden="true">'+dir+'</span> '+txt+'</span>';
}

/* ---------- page toast (#rdxToast) ----------
   One message at a time; a new one replaces the last. #rdxToast is the always-present live region
   (role=status); the visible box is rebuilt inside it, so its text is what gets announced. ok: 4s (7s with
   Undo); err: stays until ✕ or a newer toast. Text goes in via textContent, never markup. The clock stops
   while the box is hovered or holds focus (WCAG 2.2.1: Undo can't vanish under the pointer or the keyboard);
   a box removed while focused hands focus back to where the user came from. It sits above the sheets and
   dialogs, and their focus trap lets Tab reach it. */
function toast(msg, o){
  o=o||{}; var el=$('rdxToast'); if(!el) return;
  clearTimeout(TOAST_T);
  var err=o.kind==='err', ms=err?0:o.undo?7000:4000, box=document.createElement('div'), m=document.createElement('span');
  box.className='rdx-toast-box'+(err?' err':''); m.className='rdx-toast-msg'; m.textContent=msg; box.appendChild(m);
  var hide=function(){ if(box.parentNode!==el) return; clearTimeout(TOAST_T); var f=box.contains(document.activeElement); el.innerHTML=''; if(f) toastFocusBack(); };
  var arm=function(){ if(box.parentNode!==el) return; clearTimeout(TOAST_T); if(ms>0) TOAST_T=setTimeout(hide, ms); };
  var btn=function(cls,txt,label,fn){ var b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=txt; if(label) b.setAttribute('aria-label',label); b.addEventListener('click',fn); box.appendChild(b); };
  if(o.undo) btn('rdx-toast-undo','Undo','',function(e){ hide(); o.undo(e); });
  if(err) btn('rdx-toast-x','✕','Dismiss message',hide);
  box.addEventListener('mouseenter',function(){ clearTimeout(TOAST_T); });
  box.addEventListener('mouseleave',function(){ if(!box.contains(document.activeElement)) arm(); });
  box.addEventListener('focusin',function(e){ clearTimeout(TOAST_T); if(e.relatedTarget && !box.contains(e.relatedTarget)) TOAST_BACK=e.relatedTarget; });
  box.addEventListener('focusout',function(e){ if(!box.contains(e.relatedTarget) && !box.matches(':hover')) arm(); });
  var had=el.firstChild && el.firstChild.contains(document.activeElement);
  el.innerHTML=''; el.appendChild(box);
  // content outside an aria-modal dialog may be inert to a screen reader: an open sheet or dialog repeats the message
  var live=$(LAYER.modal?'modalLive':'sheetLive'); if(live && (LAYER.modal||LAYER.sheet)){ live.textContent=''; setTimeout(function(){ live.textContent=msg; },30); }
  if(had) toastFocusBack(); else TOAST_BACK=null;
  arm();
}
// Where focus goes when a focused toast is removed: where it came from if still on the page, else the open
// dialog, else the section heading the toasts with buttons come from.
function toastFocusBack(){
  var t=TOAST_BACK; TOAST_BACK=null;
  if(!(t && ROOT && ROOT.contains(t) && t.offsetParent!==null)) t=topPanel()||$('rdxGapsHd')||$('patHead')||$('evHead');
  if(t && t.offsetParent!==null) t.focus({preventScroll:true});
}

/* ---------- sheets and dialogs ----------
   Data and Settings are side sheets; Mark Lever runs and Log an event are dialogs, which may open over a
   sheet. role=dialog + aria-modal, focus moves in, Tab stays inside (and may reach the toast), Escape or a
   press that starts on the scrim closes the top one, and focus returns to the control that opened it. */
function topPanel(){ var id=LAYER.modal?'rdxModal':LAYER.sheet?'rdxSheet':null; var o=id&&$(id); return o?o.querySelector('[role=dialog]'):null; }
function activeTrigger(){ var a=document.activeElement; return (a && a!==document.body && ROOT && ROOT.contains(a)) ? a : null; }
// a selector for the element, so focus can return to its re-rendered copy
function keyOf(el){ return !el?null : el.id?'#'+el.id : el.getAttribute('data-f')?'[data-f="'+el.getAttribute('data-f')+'"]' : null; }
function focusKey(k){ var el=k&&ROOT&&ROOT.querySelector(k); if(el && el.offsetParent!==null){ el.focus({preventScroll:true}); return true; } return false; }
function openSheet(which, focusSel){
  if(!RAW.length) return;
  if(LAYER.sheet!==which){ LAYER.trigger=keyOf(activeTrigger())||(which==='data'?'#btnData':'#btnSettings'); LAYER.sheet=which; }
  renderLayer();
  var p=$('rdxSheet'), f=focusSel&&p&&p.querySelector(focusSel);
  if(f){ f.focus({preventScroll:false}); smoothScroll(f.closest('.rdx-sgrp')||f); }
  else if(p) p.querySelector('[role=dialog]').focus();
}
function closeSheet(){
  if(!LAYER.sheet) return;
  if(LAYER.modal) closeModal(false);
  LAYER.sheet=null; renderLayer();
  var t=LAYER.trigger; LAYER.trigger=null;
  if(!focusKey(t)) focusKey('#btnData');
}
function openModal(which){
  LAYER.modalTrigger=keyOf(activeTrigger()); LAYER.modal=which;
  if(which==='lever'){ LV.filter='all'; LV.sel.clear(); }
  renderLayer();
  var p=$('rdxModal'); if(!p) return;
  var f=which==='event'?p.querySelector('#evType'):null;
  (f||p.querySelector('[role=dialog]')).focus();
}
function closeModal(focusBack){
  if(!LAYER.modal) return;
  if(LAYER.modal==='event' && EVF && EVF.where==='dialog') EVF=null;
  LAYER.modal=null; LV.sel.clear(); renderLayer();
  var t=LAYER.modalTrigger; LAYER.modalTrigger=null;
  if(focusBack!==false && !focusKey(t)){ var p=topPanel(); if(p) p.focus(); }
}
function closeTop(){ if(LAYER.modal) closeModal(); else if(LAYER.sheet) closeSheet(); }
function trapTab(e){
  var panel=topPanel(); if(!panel) return;
  var f=Array.prototype.filter.call(panel.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]'),function(el){ return !el.disabled && el.offsetParent!==null; });
  Array.prototype.forEach.call($all('#rdxToast button'),function(b){ f.push(b); });
  if(!f.length){ e.preventDefault(); panel.focus(); return; }
  var a=document.activeElement, i=f.indexOf(a);
  if(e.shiftKey && (i<=0)){ e.preventDefault(); f[f.length-1].focus(); }
  else if(!e.shiftKey && (i===f.length-1 || i<0 && a!==panel)){ e.preventDefault(); f[0].focus(); }
}

/* ---------- saves that report through the toast ---------- */
// runEvents: read-modify-write on the STORED list (RunData.updateProfileList), so a stale tab or another
// device keeps its entries. fn gets the raw stored array — never events(), which re-maps legacy UTC
// timestamps and would rewrite them. Toasts okMsg (+ Undo) at once; on failure an error toast, and
// runEvents rolls back unless a newer events write owns the field. Resolves true or the reason.
function saveEvents(fn, okMsg, undo){
  var my=MOUNT, n=++EV_SEQ, prev=RD.profile.runEvents;
  var p=updateProfileList('runEvents', fn, refresh, false), sent=canonJSON(RD.profile.runEvents);
  if(okMsg) toast(okMsg, undo?{undo:undo}:null);
  return p.then(function(r){
    if(r===true || my!==MOUNT) return r;
    toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    revertKey('runEvents', Array.isArray(prev)?prev:[], function(){ return my===MOUNT && EV_SEQ===n && canonJSON(RD.profile.runEvents)===sent; });
    return r;
  });
}
// Dismissed training gaps, same pattern; o.msg / o.undo toast, and a keyboard user (o.kbd) gets focus on the
// "dismissed" toggle — or, for an Undo (o.toDrop) or once no toggle is left, on the restored gap's Dismiss.
function saveDismissed(fn, o){
  o=o||{};
  var my=MOUNT, n=++DIS_SEQ, prev=RD.profile.runDismissedDrops, p=updateProfileList('runDismissedDrops', fn, refresh, false), sent=canonJSON(RD.profile.runDismissedDrops);
  if(o.msg) toast(o.msg, o.undo?{undo:o.undo}:null);
  p.then(function(r){
    if(r===true || my!==MOUNT) return;
    toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    revertKey('runDismissedDrops', Array.isArray(prev)?prev:[], function(){ return my===MOUNT && DIS_SEQ===n && canonJSON(RD.profile.runDismissedDrops)===sent; });
  });
  if(!dismissedDrops().length) UI.disOpen=false;
  if(o.restored) UI.gapsOpen=true;
  refresh();
  var box=$('patternsBox'); if(!o.kbd||!box) return;
  var t=null, back=function(){ Array.prototype.some.call(box.querySelectorAll('.rdx-gap-row'),function(c){
    var d={t0:+c.getAttribute('data-t0'), t1:+c.getAttribute('data-t1')};
    return InjuryPatterns.dismissOverlaps(d,o.restored) && (t=c.querySelector('.rdx-gap-dismiss'));
  }); };
  if(o.restored && o.toDrop) back();
  if(!t) t=box.querySelector('.rdx-dis-tog');
  if(!t && o.restored) back();
  if(!t) t=$('rdxGapsHd')||$('patHead');
  if(t) t.focus({preventScroll:true});
}
// Exclude / include runs (users/{uid}.runExcluded = [{id, ts, at}]); a failed save puts the list back.
function setExcluded(add, rm, msg, undo){
  var my=MOUNT, prev=RD.profile.runExcluded;
  var p=updateProfileList('runExcluded', function(list){
    list=list.filter(function(x){ return !(x && rm.some(function(r){ return exclMatch(x,r); })); });
    return list.concat(add.filter(function(r){ return !list.some(function(x){ return x&&exclMatch(x,r); }); }).map(function(r){ return {id:r.id, ts:r.ts, at:Date.now()}; }));
  }, refresh, false);
  refresh();
  toast(msg, undo?{undo:undo}:null);
  return p.then(function(r){
    if(r===true || my!==MOUNT) return r;
    RD.profile.runExcluded=Array.isArray(prev)?prev:[]; refresh();
    toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    return r;
  });
}
// The Form filters and min distance: users/{uid}.runIncluded = {off:[types left out], intensity, mindist};
// types are stored as the ones turned OFF, so a type from a later import is included; all-default stores null.
function saveIncluded(patch, okMsg){
  var cur=includedPref(), v={ off:cur.off.slice(), intensity:cur.intensity, mindist:cur.mindist };
  Object.keys(patch||{}).forEach(function(k){ v[k]=patch[k]; });
  var known=knownTypes(); v.off=v.off.filter(function(t){ return t in known; });
  var dflt=!v.off.length && v.intensity===FILTER_DEFAULTS.intensity && parseFloat(v.mindist)===parseFloat(FILTER_DEFAULTS.mindist);
  var p=persist({ runIncluded: dflt?null:v }, okMsg);
  refresh();
  return p;
}
// A failed profile write put one key back (RunData.revertKey): re-render what shows it.
function onRevertKey(){ refresh(); }

/* ---------- Settings fields: an invalid entry is never stored ---------- */
// Red border + aria-invalid, the last good value put back, focus kept, and an error toast. Cleared on input.
function fieldErr(id,msg,restore){
  var f=$(id); if(f){ f.value=(restore==null)?'':restore; f.classList.add('rdx-df-err'); f.setAttribute('aria-invalid','true'); f.focus(); }
  var p=$(id+'Err'); if(p){ p.textContent=msg; p.hidden=false; }
  toast(msg,{kind:'err'});
}
function fieldOk(f){ if(f){ f.classList.remove('rdx-df-err'); f.removeAttribute('aria-invalid'); var p=f.id&&$(f.id+'Err'); if(p){ p.hidden=true; p.textContent=''; } } }

/* ---------- the shell ---------- */
function shellHTML(){
  var your=who(), training=VIEW==='training';
  return ''+
  // status strip: freshness + import status, then the buttons (shown once runs exist)
  '<div class="rdx-strip" id="rdxStrip">'+
    '<div class="rdx-status"><span id="rdxFresh"></span><span id="importStatus"></span></div>'+
    '<div class="rdx-strip-acts" id="stripActs" hidden>'+
      (training?'':'<button type="button" class="rdx-gapchip" id="patGapChip" data-act="gaps-jump" hidden></button>')+
      '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="btnData" data-act="open-data" aria-haspopup="dialog">Data<span class="rdx-count" id="dataCount" hidden></span></button>'+
      '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="btnSettings" data-act="open-settings" aria-haspopup="dialog">Settings</button>'+
    '</div>'+
  '</div>'+
  '<p class="rdx-perr" id="profileErr" role="alert" hidden></p>'+
  '<div class="rdx-section" id="sec-empty" hidden></div>'+
  '<div id="secMain" hidden>'+
  (training ?
    '<div class="rdx-section" id="sec-hero">'+(ADMIN?'<div class="rdx-demobar" id="demobar" role="group" aria-label="Demo scenarios"></div>':'')+'<div id="gcToday"></div><div class="rdx-hero" id="hero"></div></div>'+
    '<section class="rdx-section" id="sec-load" aria-labelledby="loadHd"></section>'+
    '<section class="rdx-section" id="sec-form" aria-labelledby="formHd"></section>'
  :
    '<section class="rdx-section" id="sec-patterns" aria-labelledby="patHead">'+
      '<div class="rdx-sec-hd"><div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="patHead" tabindex="-1">What came before each setback</h2>'+
        '<p class="rdx-sec-sub">How '+your+' training looked in the weeks before each logged injury or illness.</p><div id="gcPat"></div></div></div>'+
      '<div id="patternsBox"></div></section>'+
    '<section class="rdx-section" id="sec-events" aria-labelledby="evHead"></section>'+
    '<div class="rdx-section" id="sec-gaps"></div>'
  )+
  '<section class="rdx-section" id="sec-about" aria-labelledby="aboutHd"></section>'+
  '</div>'+
  '<div id="rdxSheet"></div><div id="rdxModal"></div>'+
  '<div class="rdx-toast" id="rdxToast" role="status" aria-live="polite"></div>';
}

/* ---------- status strip ---------- */
// "369 runs · last run today 6:15 AM · Strava synced today". A stale history (last run > 3 days) gets a
// nudge to Data's import; the Data button counts the runs that look wrong (they count in the load numbers
// until excluded), and on Injury Patterns the chip counts the training gaps to review.
function stravaSyncedTxt(){
  if(!RD.sync.last) return '';
  var t=RD.sync.last.toDate?RD.sync.last.toDate().getTime():new Date(RD.sync.last).getTime(), n=daysAgo(t);
  return isFinite(t)?'synced '+(n<=0?'today':n===1?'yesterday':fmtMD(t)):'';
}
function badRuns(){ return RAW.filter(function(r){ return !r._excl && runFlag(r); }); }
function renderStrip(){
  var el=$('rdxFresh'); if(!el) return;
  var acts=$('stripActs'); if(acts) acts.hidden=!RAW.length;
  if(!RAW.length){ el.textContent=''; return; }   // the onboarding card's heading already says it
  var last=RAW[RAW.length-1].ts, s=plural(RAW.length,'run')+' · last run '+fmtRel(last);
  if(RD.sync.connected && stravaSyncedTxt()) s+=' · Strava '+stravaSyncedTxt();
  el.textContent=s;
  if(daysAgo(last)>3){ el.appendChild(document.createTextNode(' · ')); var b=document.createElement('button'); b.type='button'; b.className='rdx-link'; b.textContent='Import a newer export'; b.setAttribute('data-act','import-newer'); el.appendChild(b); }
  var n=badRuns().length, c=$('dataCount'), bd=$('btnData');
  if(c){ c.hidden=!n; c.textContent=n; }
  if(bd) bd.setAttribute('aria-label', n?'Data, '+plural(n,'run')+' to review':'Data');
}

/* ---------- Today ---------- */
// The numbers and the verdict come from RunData.heroModel (frozen math, pinned by run-dynamics-data.test.js);
// this only renders them. Wording and layout as approved 2026-10-19.
function renderHero(){
  var el=$('hero'); if(!el) return;
  var today=new Date();
  var M=RunData.heroModel({ runs:loadRuns(), params:LOAD_PARAMS, now:today, demo:(DEMO&&RunData.DEMO_PRESETS[DEMO])||null, leverPct:leverPct(), coach:ROLE==='coach' });
  var date='<span class="rdx-today-date">'+DOW[today.getDay()]+', '+MONTHS[today.getMonth()]+' '+today.getDate()+'</span>';
  var notesEl='<p class="rdx-hero-notes" id="heroNotes" hidden></p>';
  if(M.short){
    el.style.borderLeftColor='var(--muted2)';
    el.innerHTML='<div class="rdx-today-top"><h2 class="rdx-hero-head"><span class="rdx-hero-dot" style="background:var(--muted2)"></span>Building your baseline</h2>'+date+'</div>'+
      '<p class="rdx-today-do">'+M.todo+'</p>'+notesEl;
    renderHeroNotes(); return;
  }
  var pct=M.pct, d1=M.d1, d3=M.d3, d28=M.d28, base=M.base, r1=M.r1, r3=M.r3, r7=M.r7, col1=M.col1, col3=M.col3, col7=M.col7;
  var lo=M.lo, hi=M.hi, flat=M.flat, hilly=M.hilly, lever=M.lever;
  var statTile=function(k,val,unit,c,sub){ return '<div class="rdx-stat"><div class="k">'+k+'</div><div class="v">'+val.toFixed(1)+'<small>'+unit+'</small></div>'+
    (sub?'<div class="x"'+(c?' style="color:'+ink(c)+'"><i style="background:'+c+'"></i>':'>')+'<span>'+sub+'</span></div>':'')+'</div>'; };
  var trendRow=function(cls){ return '<div class="rdx-trend'+(cls||'')+'"><span class="k">Acute trend</span><span class="v" style="color:'+ink(M.rampCol)+'">'+M.rampTxt+'</span><span class="x">per week · how fast the 7-day load is changing</span></div>'; };
  var baseSrc=LOAD_PARAMS&&LOAD_PARAMS.basePaceSource;
  var baseTxt=(LOAD_PARAMS&&LOAD_PARAMS.basePaceSec>0&&baseSrc) ? 'Scored against '+who()+' easy pace, '+fmtPace(LOAD_PARAMS.basePaceSec)+' /mi ('+(baseSrc==='profile'?'from the profile':'grade-adjusted, from easy runs')+').' : '';
  var bandPos=function(x){ return (Math.max(0.4,Math.min(1.8,x))-0.4)/1.4*100; };
  var nums='';
  if(base!=null){
    nums='<div class="rdx-today-nums">'+
      (M.todayRuns ?
      '<div class="rdx-today-num rdx-today-target rdx-today-ran"><div class="k">Today’s run'+(M.todayRuns>1?'s':'')+'</div>'+
        '<div class="v"><span><span data-v="todayMi">'+M.todayMi.toFixed(1)+'</span><small>mi</small></span>'+
          '<span class="iad"><span data-v="todayIad">'+d1.toFixed(1)+'</span><small>IAD mi</small></span></div>'+
        (M.todayRuns>1?'<div class="x" data-v="todayN">'+M.todayRuns+' runs</div>':'')+
        '<div class="x">target <span data-v="lo">'+fmtMi(lo)+'</span>–<span data-v="hi">'+fmtMi(hi)+'</span> mi</div>'+
      '</div>' :
      '<div class="rdx-today-num rdx-today-target"><div class="k">Today’s target</div>'+
        '<div class="v"><span data-v="lo">'+fmtMi(lo)+'</span>–<span data-v="hi">'+fmtMi(hi)+'</span><small>mi</small></div>'+
        '<div class="x"><span>≈ <b data-v="flat">'+fmtMi(flat)+'</b> mi flat</span> · <span><b data-v="hilly">'+fmtMi(hilly)+'</b> hilly</span>'+
          (M.leverInTarget?' · <span><b class="lever" data-v="lever">'+fmtMi(lever)+'</b> mi on the Lever</span>':'')+'</div>'+
      '</div>')+
      '<div class="rdx-today-num rdx-today-r7"><div class="k">7-day load</div>'+
        '<div class="v"><span data-v="r7">'+r7.toFixed(1)+'</span>×<small>'+who('their')+' base</small></div>'+
        '<div class="rdx-band" aria-hidden="true"><span class="rdx-band-safe" style="left:'+bandPos(0.8)+'%;width:'+(bandPos(1.3)-bandPos(0.8))+'%"></span>'+
          '<i style="left:'+bandPos(r7)+'%;background:'+col7+'"></i></div>'+
        '<div class="x">Safe band 0.8–1.3×</div>'+
      '</div>'+
    '</div>'+
    (M.isClimb ? trendRow(' rdx-today-trend') : '');
  }
  var equiv = base!=null ?
    '<p class="rdx-hero-cap">At the top of today’s target ('+fmtMi(hi)+' impact-adjusted miles), that’s about:</p>'+
    '<ul class="rdx-do-opts">'+
      '<li><b>'+fmtMi(flat)+' mi</b> flat easy outside</li>'+
      '<li><b>'+fmtMi(hilly)+' mi</b> hilly outside</li>'+
      '<li class="lever-opt"><b data-v="leverAll">'+fmtMi(lever)+' mi</b> on the Lever · '+pct+'% BW</li>'+
    '</ul>' : '';
  el.style.borderLeftColor=M.accent;
  el.innerHTML='<div class="rdx-today-top"><h2 class="rdx-hero-head"><span class="rdx-hero-dot" style="background:'+M.accent+'"></span>'+M.head+'</h2>'+date+'</div>'+
    '<p class="rdx-today-do">'+M.todo+'</p>'+notesEl+nums+
    '<details class="rdx-more rdx-today-more" id="heroMore" data-ui="heroMore"'+(UI.heroMore?' open':'')+'><summary data-f="heromore">Details</summary><div class="rdx-more-body">'+
      '<p class="rdx-hero-cap">Recent load · IAD mi per day, through today</p>'+
      '<div class="rdx-stat-grid">'+
        statTile('Last day', d1, 'IAD mi', d1>0?col1:null, r1!=null?r1.toFixed(1)+'× biggest day (28d)':'')+
        statTile('3-day avg', d3, 'IAD mi/day', col3, r3!=null?r3.toFixed(1)+'× biggest 3-day avg (28d)':'')+
        statTile('28-day base', d28, 'IAD mi/day', null, who()+' average day')+
      '</div>'+
      (M.isClimb?'':trendRow())+equiv+
      '<p class="rdx-today-foot">'+(baseTxt?baseTxt+' ':'')+'<button type="button" class="rdx-linkbtn" id="heroHelpBtn" data-act="hero-help" aria-expanded="'+UI.heroHelp+'" aria-controls="heroHelp">How to read these numbers</button></p>'+
      '<p class="rdx-hero-help" id="heroHelp"'+(UI.heroHelp?'':' hidden')+'>IAD (Impact Adjusted Distance): one easy, flat mile = 1 IAD mi. Faster, harder-landing or hillier miles count for more; Lever miles count for less. '+
        'Today’s target is a load budget for the day in IAD mi; the flat, hilly and Lever distances are what fit under its top end. '+
        'Last day (today so far) and 3-day avg are compared with the biggest day and biggest 3-day stretch of the past 28 days. 7-day load is the 7-day average day compared with the 28-day base — '+who()+' average day, rest days included. '+
        'Acute trend is how fast the 7-day load is changing per week. The easy pace is the anchor every run is scored against, not a recent average. A load measure, not an injury prediction.</p>'+
    '</div></details>';
  renderHeroNotes();
}
// Muted notes under the instruction line: a baseline still forming, a week with no runs. Demo scenarios skip them.
function renderHeroNotes(){
  var el=$('heroNotes'); if(!el) return;
  var notes=[], runs=RAW.length?loadRuns():[];
  if(!DEMO && runs.length){
    var first=Infinity, recent=false;
    runs.forEach(function(r){ if(r.ts<first) first=r.ts; var a=daysAgo(r.ts); if(a>=0 && a<7) recent=true; });
    var days=daysAgo(first)+1;
    if(days>=1 && days<28) notes.push('Baseline still forming — '+days+' of 28 days');
    if(!recent) notes.push('No runs in the last 7 days');
  }
  el.textContent=notes.join(' · '); el.hidden=!notes.length;
}
// Admin-only scenario switcher above the Today card: forces its ratios to a preset; real runs untouched.
function renderDemoBar(){
  var el=$('demobar'); if(!ADMIN || !el) return;
  var items=[{key:'',label:'● Live'}].concat(RunData.DEMO_LIST);
  el.innerHTML='<span class="lbl">Demo</span>'+items.map(function(it){
    var on=(DEMO||'')===it.key;
    return '<button type="button" class="rdx-chip'+(on?' on':'')+'" data-act="demo" data-k="'+it.key+'" data-f="demo'+it.key+'" aria-pressed="'+on+'">'+it.label+'</button>';
  }).join('');
}

/* ---------- Load ---------- */
function renderLoadSec(){
  var sec=$('sec-load'); if(!sec) return;
  var custom=UI.range==='custom';
  sec.innerHTML='<div class="rdx-sec-hd"><div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="loadHd">Load</h2>'+
      '<p class="rdx-sec-sub">'+who('Your')+' 7-day load against '+who('their')+' 28-day base, in IAD mi per day, with the safe band shaded. Counts every run.</p><div id="gcLoad"></div></div>'+
      '<div class="rdx-sec-ctl"><div class="rdx-seg" role="group" aria-label="Load range">'+
        [['3','3M'],['6','6M'],['12','1Y'],['all','All'],['custom','Custom']].map(function(r){ var on=UI.range===r[0];
          return '<button type="button" data-act="range" data-r="'+r[0]+'" data-f="range'+r[0]+'" class="'+(on?'on':'')+'" aria-pressed="'+on+'">'+r[1]+'</button>'; }).join('')+
      '</div></div></div>'+
    (custom?'<div class="rdx-dates"><div class="rdx-ctl"><label for="tFrom">From</label><input type="date" id="tFrom" value="'+esc(UI.from)+'"'+(UI.to?' max="'+esc(UI.to)+'"':'')+'></div>'+
      '<div class="rdx-ctl"><label for="tTo">To</label><input type="date" id="tTo" value="'+esc(UI.to)+'"'+(UI.from?' min="'+esc(UI.from)+'"':'')+'></div></div>':'')+
    '<div class="rdx-chartwrap"><div class="rdx-legend" id="loadLegend"></div><div class="rdx-chartbox" id="loadBox"></div><p class="rdx-ev-cap" id="loadEvCap"></p></div>'+
    '<p class="rdx-note">A load measure, not an injury prediction. The lines are weighted averages, so they can differ slightly from the plain averages in Today. '+
      '<button type="button" class="rdx-link" data-act="how-iad">How IAD is calculated</button> · <button type="button" class="rdx-link" data-act="log-event" data-f="logevent">Log an event</button></p>';
  renderLoadChart();
}
// Range presets end TODAY, so the chart's right edge is the day Today reads ('all' starts at the first run).
function setRange(r){
  UI.range=r;
  if(r==='custom'){ if(!UI.from||!UI.to){ var t=new Date(); UI.to=ymd(t); UI.from=ymd(new Date(t.getTime()-91*DAY)); } return; }
  var to=new Date(), from=(r==='all')?new Date(RAW[0].ts):new Date(to.getTime()-parseInt(r,10)*30.44*DAY);
  UI.from=ymd(from); UI.to=ymd(to);
}
// Geometry at the box's real width: the SVG draws 1:1, so 11px axis text stays 11px on a phone.
function chartDims(box,padR){
  CHART_W[box.id]=box.clientWidth;
  var W=Math.max(300,Math.min(1100,box.clientWidth||720)), H=Math.max(220,Math.min(320,Math.round(W*0.3)));
  return {W:W,H:H,padL:44,padR:padR,padT:24,padB:26,innerW:W-44-padR,innerH:H-50,maxTicks:W<500?4:8};
}
function axisTicks(t0,t1,maxTicks){
  if(t1-t0<45*DAY){   // short span: weekly ticks from the first Monday ≥ t0
    var wk=[], c=new Date(t0); c.setHours(0,0,0,0); while(c.getDay()!==1 || c.getTime()<t0){ c.setDate(c.getDate()+1); c.setHours(0,0,0,0); }
    for(;c.getTime()<=t1;c.setDate(c.getDate()+7)) wk.push(c.getTime());
    if(wk.length>=2) return wk;
  }
  var months=(t1-t0)/(30.44*DAY), cap=maxTicks||8, steps=[1,2,3,6,12], step=12;
  for(var i=0;i<steps.length;i++){ if(Math.floor(months/steps[i])<=cap){ step=steps[i]; break; } }
  var out=[], y0=new Date(t0).getFullYear(), y1=new Date(t1).getFullYear();
  for(var y=y0;y<=y1;y++) for(var m=0;m<12;m+=step){ var t=new Date(y,m,1).getTime(); if(t>=t0&&t<=t1) out.push(t); }
  return out.length>=2 ? out : [t0,t1];
}
function axisLabel(ts,idx,short){ var d=new Date(ts); if(short) return MONTHS[d.getMonth()]+' '+d.getDate(); return MONTHS[d.getMonth()]+((d.getMonth()===0||idx===0)?" '"+String(d.getFullYear()).slice(2):''); }
function xTicksSVG(t0,t1,D,xOf){
  var short=t1-t0<45*DAY;
  return axisTicks(t0,t1,D.maxTicks).map(function(ts,idx){ if(ts<t0||ts>t1) return ''; var x=xOf(ts);
    return '<text x="'+x.toFixed(1)+'" y="'+(D.H-8)+'" text-anchor="'+(x>D.W-28?'end':'middle')+'">'+axisLabel(ts,idx,short)+'</text>'; }).join('');
}
function smoothArr(vals,w){ var half=Math.floor(w/2); return vals.map(function(_,i){ var s=0,c=0; for(var j=Math.max(0,i-half);j<=Math.min(vals.length-1,i+half);j++){ s+=vals[j]; c++; } return s/c; }); }
function coloredPath(xs,ys,cs,width){ var out='',cur=[],cc=null;
  for(var i=0;i<xs.length;i++){ var p=xs[i].toFixed(1)+','+ys[i].toFixed(1);
    if(cc===null){cc=cs[i];cur=[p];}
    else if(cs[i]===cc){cur.push(p);}
    else { cur.push(p); out+='<polyline points="'+cur.join(' ')+'" fill="none" style="stroke:'+cc+'" stroke-width="'+width+'" stroke-linejoin="round" stroke-linecap="round"/>'; cur=[p]; cc=cs[i]; } }
  if(cur.length>1) out+='<polyline points="'+cur.join(' ')+'" fill="none" style="stroke:'+cc+'" stroke-width="'+width+'" stroke-linejoin="round" stroke-linecap="round"/>';
  return out;
}
// 7-day line: accent inside the band, gold above it, red past 1.5.
function acuteSegColor(acwr){ if(acwr==null) return 'var(--rdx-s1)'; if(acwr>1.5) return 'var(--rdx-spike)'; if(acwr>1.3) return 'var(--rdx-hot)'; return 'var(--rdx-s1)'; }
// Legend entries for the logged-event types drawn in [t0,t1], in their locked colours; skip = already listed.
function evLegendHTML(t0,t1,skip){
  var have={};
  events().forEach(function(e){ var end=(e.endTs!=null&&e.endTs>e.ts)?e.endTs:null; if(e.ts!=null && (end||e.ts)>=t0 && e.ts<=t1) have[EV_META[e.type]?e.type:'race']=1; });
  return ['race','injury','illness','nonrun','timeoff'].filter(function(t){ return have[t]&&!(skip&&skip[t]); })
    .map(function(t){ return '<span class="rdx-legend-item"><span class="rdx-legend-ev" style="--c:'+EV_HEX[t]+'"></span>'+EV_META[t][0]+'</span>'; }).join('');
}
// RunLoad's overlay <title>s get the view's labels ("Injury · Aug 11 – 29, 2025 — note"), one per drawn event.
function evOverlaySVG(t0,t1,padL,innerW,padT,innerH){
  var ev=events(), i=0, drawn=ev.filter(function(e){ var end=(e.endTs!=null&&e.endTs>e.ts)?e.endTs:null; return e.ts!=null && (end||e.ts)>=t0 && e.ts<=t1; });
  return RunLoad.eventOverlaySVG(ev,t0,t1,padL,innerW,padT,innerH).replace(/<title>[\s\S]*?<\/title>/g,function(m){ var e=drawn[i++]; return e?'<title>'+esc(evLabel(e)+(e.note?' — '+e.note:''))+'</title>':m; });
}
// The caption under a chart: a hover/tap hint when the overlay drew anything; a tapped band or marker pins its text.
function evCapReset(box,capId,msg){ box._pin=msg!=null?msg:(box.querySelector('svg title')?(window.matchMedia&&matchMedia('(hover:hover)').matches?'Hover or click a shaded band or marker to see what it was.':'Tap a shaded band or marker to see what it was.'):''); var c=$(capId); if(c) c.textContent=box._pin; }
function wireEventCap(box,capId){
  var title=function(t){ var c=t&&t.firstElementChild; return (c&&c.tagName.toLowerCase()==='title')?c.textContent:null; };
  var set=function(txt){ var c=$(capId); if(c) c.textContent=txt; };
  var pin=function(e){ var t=title(e.target); if(t!=null) set(box._pin=t); };
  box.addEventListener('pointerdown',pin);
  box.addEventListener('click',pin);
  box.addEventListener('pointerover',function(e){ if(e.pointerType!=='mouse') return; var t=title(e.target); set(t!=null?t:box._pin||''); });
  box.addEventListener('pointerleave',function(e){ if(e.pointerType==='mouse') set(box._pin||''); });
}
function renderLoadChart(){
  var legEl=$('loadLegend'), chartEl=$('loadBox'); if(!chartEl) return;
  chartEl.onmousemove=chartEl.onmouseleave=chartEl.onpointerdown=chartEl.onkeydown=null;
  if(!chartEl._cap){ chartEl._cap=true; wireEventCap(chartEl,'loadEvCap'); }
  // Padded through today like Today, so the acute curve decays across rest days since the last run.
  var full=RunLoad.extendTimeline(RunLoad.loadTimeline(loadRuns(), LOAD_PARAMS), new Date(), LOAD_PARAMS);
  if(full.length<2){ legEl.innerHTML=''; chartEl.innerHTML='<div class="rdx-chart-empty">Not enough history to model load yet.</div>'; evCapReset(chartEl,'loadEvCap'); return; }
  var from=parseDate(UI.from), to=parseDate(UI.to);
  if(from&&to&&dayEnd(to).getTime()<from.getTime()){ legEl.innerHTML=''; chartEl.innerHTML='<div class="rdx-chart-empty">'+RANGE_BAD_MSG+'</div>'; evCapReset(chartEl,'loadEvCap'); return; }
  var f0=from?from.getTime():full[0].ts, f1=to?dayEnd(to).getTime():full[full.length-1].ts;
  var tl=full.filter(function(d){return d.ts>=f0&&d.ts<=f1;}), tooShort=false;
  if(tl.length<2){ tl=full; tooShort=true; }   // window too narrow: show everything
  var last=tl[tl.length-1];
  var D=chartDims(chartEl,12), W=D.W, H=D.H, padL=D.padL, padR=D.padR, padT=D.padT, innerW=D.innerW, innerH=D.innerH;
  // the axis starts at the selected From even when the history starts later ("History starts" mark)
  var t0=(!tooShort && from && f0<tl[0].ts) ? f0 : tl[0].ts, t1=last.ts, span=Math.max(1,t1-t0);
  var acuteS=smoothArr(tl.map(function(d){return d.acute;}),5), chronicS=smoothArr(tl.map(function(d){return d.chronic;}),5);
  // 0 to exactly the highest thing drawn (the 7-day line or the band's top); gridlines at thirds
  var ymax=Math.max.apply(null, acuteS.concat(chronicS.map(function(c){return c*1.3;})))||1;
  var xOf=function(ts){return padL+((ts-t0)/span)*innerW;};
  var yOf=function(v){return padT+innerH-(v/ymax)*innerH;};
  var xs=tl.map(function(d){return xOf(d.ts);});
  var bandTop=tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]*1.3).toFixed(1);});
  var bandBot=tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]*0.8).toFixed(1);}).reverse();
  var band='<polygon points="'+bandTop.concat(bandBot).join(' ')+'" style="fill:var(--rdx-band);stroke:var(--rdx-band-line)" stroke-width="0.5"/>';
  var chronicLn='<polyline points="'+tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]).toFixed(1);}).join(' ')+'" fill="none" style="stroke:var(--rdx-s2)" stroke-width="2.2" stroke-linejoin="round"/>';
  var acuteLn=coloredPath(xs, acuteS.map(yOf), tl.map(function(d){return acuteSegColor(d.acwr);}), 2.6);
  var grid='<text class="rdx-ax-lbl" x="2" y="13">IAD mi/day</text>';
  var loadTick=function(v){ return v>=100 ? String(Math.round(v)) : v.toFixed(1); };
  if(t0<tl[0].ts){ var hx=xs[0].toFixed(1);
    grid+='<line class="rdx-today" x1="'+hx+'" y1="'+(padT-4)+'" x2="'+hx+'" y2="'+(padT+innerH)+'"/>'+
      '<text class="rdx-ax-lbl" x="'+hx+'" y="'+(padT-8)+'" text-anchor="'+(xs[0]>W/2?'end':'start')+'">History starts '+fmtMD(tl[0].ts)+'</text>'; }
  for(var g=0;g<=3;g++){ var yy=padT+innerH-g/3*innerH;
    grid+='<line class="rdx-grid" x1="'+padL+'" y1="'+yy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+yy.toFixed(1)+'"/>'+
      '<text x="'+(padL-6)+'" y="'+(yy+4).toFixed(1)+'" text-anchor="end">'+(g===0?'0':loadTick(ymax*g/3))+'</text>'; }
  var todayM='';
  if(ymd(new Date(last.ts))===ymd(new Date())){ var tx=xs[xs.length-1].toFixed(1);
    todayM='<line class="rdx-today" x1="'+tx+'" y1="'+(padT-4)+'" x2="'+tx+'" y2="'+(padT+innerH)+'"/>'+
      '<text class="rdx-ax-lbl rdx-today-lbl" x="'+tx+'" y="'+(padT-8)+'" text-anchor="end">Today</text>'+
      '<circle class="rdx-today-dot" cx="'+tx+'" cy="'+yOf(acuteS[acuteS.length-1]).toFixed(1)+'" r="4.5" style="fill:'+acuteSegColor(last.acwr)+'"/>'; }
  var aMin=Math.min.apply(null,acuteS), aMax=Math.max.apply(null,acuteS);
  var loadAria='Load, '+fmtDay(t0)+' – '+fmtDay(t1)+': '+(ymd(new Date(last.ts))===ymd(new Date())?'today':'on '+fmtDay(last.ts))+' 7-day load '+last.acute.toFixed(1)+' vs 28-day base '+last.chronic.toFixed(1)+' IAD mi per day; 7-day load ranged '+aMin.toFixed(1)+'–'+aMax.toFixed(1)+' in this range. Use the left and right arrow keys to read each day.';
  var li=function(sw,txt){ return '<span class="rdx-legend-item">'+sw+txt+'</span>'; };
  legEl.innerHTML=li('<span class="rdx-legend-sw" style="background:var(--rdx-s1)"></span>','7-day load')+
    li('<span class="rdx-legend-sw" style="background:var(--rdx-s2)"></span>','28-day base')+
    li('<span class="rdx-legend-sw rdx-legend-band"></span>','Safe band (0.8–1.3× base)')+
    (tl.some(function(d){ return d.acwr!=null&&d.acwr>1.3; })?li('<span class="rdx-legend-sw" style="background:linear-gradient(90deg,var(--rdx-hot),var(--rdx-spike))"></span>','Above the band'):'')+
    evLegendHTML(t0,t1);
  var xh='<g class="rdx-xh" visibility="hidden"><line class="rdx-xh-ln" y1="'+padT+'" y2="'+(padT+innerH)+'"/><circle class="rdx-xh-dot" r="4.5"/></g>';
  chartEl.innerHTML='<svg class="rdx-chart-svg rdx-load-svg" viewBox="0 0 '+W+' '+H+'" role="img" tabindex="0" aria-label="'+esc(loadAria)+'">'+grid+band+chronicLn+acuteLn+xTicksSVG(t0,t1,D,xOf)+todayM+evOverlaySVG(t0,t1,padL,innerW,padT,innerH)+xh+'</svg>';
  wireLoadReadout(chartEl, tl, xs, acuteS.map(yOf), W, padL, innerW);
  evCapReset(chartEl,'loadEvCap', tooShort?'Range too short — showing all history.':null);
}
// Readout: hover, tap or ←/→ (Shift = a week, Home/End) on the focused chart moves a crosshair to a day and
// shows "date · 7-day · base · ratio" (the model's daily values; the dot sits on the drawn, smoothed line).
function loadBandTxt(r){ if(r==null) return 'base still forming'; return r>1.5?'well above the band':r>1.3?'above the band':r<0.8?'below the band':'in the safe band'; }
function wireLoadReadout(chart, tl, xs, ys, W, padL, innerW){
  var svg=chart.querySelector('.rdx-load-svg'), g=svg&&svg.querySelector('.rdx-xh'); if(!g) return;
  var ln=g.querySelector('line'), dot=g.querySelector('circle'), cur=-1;
  var tip=document.createElement('div'); tip.className='rdx-chart-tip rdx-load-tip'; tip.setAttribute('role','status'); chart.appendChild(tip);
  var near=function(x){ var b=0, bd=Infinity; for(var i=0;i<xs.length;i++){ var dd=Math.abs(xs[i]-x); if(dd<bd){ bd=dd; b=i; } } return b; };
  var hide=function(){ cur=-1; g.setAttribute('visibility','hidden'); tip.classList.remove('on'); };
  var show=function(i){
    i=Math.max(0,Math.min(tl.length-1,i)); cur=i; var d=tl[i], x=xs[i].toFixed(1);
    ln.setAttribute('x1',x); ln.setAttribute('x2',x); dot.setAttribute('cx',x); dot.setAttribute('cy',ys[i].toFixed(1));
    dot.style.fill=acuteSegColor(d.acwr); g.setAttribute('visibility','visible');
    tip.innerHTML='<div class="rdx-tip-top">'+esc(fmtDay(d.ts))+'</div>'+
      '<div class="rdx-tip-val">7-day load <b>'+d.acute.toFixed(1)+'</b> · base <b>'+d.chronic.toFixed(1)+'</b> IAD mi/day</div>'+
      '<div class="rdx-tip-ctx">'+(d.acwr!=null?d.acwr.toFixed(2)+'× base · ':'')+loadBandTxt(d.acwr)+'</div>';
    tip.classList.add('on');
    var r=chart.getBoundingClientRect(), sr=svg.getBoundingClientRect(), px=sr.left-r.left+xs[i]*sr.width/W, left=px+12;
    if(left+tip.offsetWidth>r.width) left=px-tip.offsetWidth-12;
    tip.style.left=Math.max(0,left)+'px'; tip.style.top=Math.max(0,sr.top-r.top+8)+'px';
  };
  var at=function(e){ var sr=svg.getBoundingClientRect(); if(!sr.width) return -1;
    var x=(e.clientX-sr.left)*W/sr.width; return (x<padL-8||x>padL+innerW+8)?-1:near(x); };
  chart.onmousemove=function(e){ var i=at(e); if(i<0) hide(); else if(i!==cur) show(i); };
  chart.onmouseleave=hide;
  chart.onpointerdown=function(e){ if(e.pointerType==='mouse') return; var i=at(e); if(i<0) hide(); else show(i); };
  chart.onkeydown=function(e){
    if(e.target!==svg) return;
    var k=e.key, step=e.shiftKey?7:1, i=cur<0?tl.length-1:cur;
    if(k==='ArrowLeft') i=cur<0?i:i-step; else if(k==='ArrowRight') i=cur<0?i:i+step;
    else if(k==='Home') i=0; else if(k==='End') i=tl.length-1;
    else if(k==='Escape'){ if(cur>=0){ e.stopPropagation(); hide(); } return; }
    else return;
    e.preventDefault(); show(i);
  };
  svg.addEventListener('blur',hide);
}

/* ---------- Form ----------
   One period (Last 30 / 90 days, Last year, All runs, or a custom range) drives the tiles, the trend chart
   and All metrics; each compares with the period of the same length before it, or a second custom range. */
// {a:[t0,t1], b:[t0,t1]|null, aLabel, bLabel, adjacent}: t0 exclusive, t1 inclusive (whole local days).
function periodRanges(){
  var end=dayEnd(new Date()), p=UI.period;
  if(p==='all') return { a:[-Infinity,end.getTime()], b:null, aLabel:'All runs', bLabel:'', adjacent:false };
  if(p==='custom'){
    var af=parseDate(UI.aFrom), at=parseDate(UI.aTo);
    if(!af||!at||dayEnd(at).getTime()<af.getTime()) return { bad:true };
    var a0=af.getTime()-1, a1=dayEnd(at).getTime(), len=a1-a0, b;
    if(UI.cmp==='custom'){ var bf=parseDate(UI.bFrom), bt=parseDate(UI.bTo); b=(bf&&bt&&dayEnd(bt).getTime()>=bf.getTime())?[bf.getTime()-1,dayEnd(bt).getTime()]:[0,0]; }
    else b=[a0-len,a0];
    return { a:[a0,a1], b:b, aLabel:fmtSpan(af.getTime(),at.getTime()), bLabel:b[1]?fmtSpan(b[0]+1,b[1]):'pick both dates', adjacent:UI.cmp!=='custom' };
  }
  var n=+p, e=end.getTime();
  return { a:[e-n*DAY,e], b:[e-2*n*DAY,e-n*DAY], aLabel:n===365?'Last year':'Last '+n+' days', bLabel:n===365?'The year before':'The '+n+' days before', adjacent:true };
}
function formSub(R){
  if(R.bad) return 'Pick a valid date range — From must be before To.';
  return 'How '+who()+' running form in '+(UI.period==='custom'?R.aLabel:R.aLabel.toLowerCase())+(R.b?' compares with '+(UI.cmp==='custom'||UI.period==='custom'?R.bLabel:R.bLabel.toLowerCase()):'')+'.';
}
// A custom date changed: redraw what it drives, not the inputs (a date is still being typed), and mark a
// pair that runs backwards.
function refreshFormData(id){
  var R=periodRanges();
  [['aFrom','aTo'],['bFrom','bTo']].forEach(function(p){ var f=$(p[0]), t=$(p[1]); fieldOk(f); fieldOk(t);
    var a=parseDate(UI[p[0]]), z=parseDate(UI[p[1]]);
    if(a&&z&&dayEnd(z).getTime()<a.getTime()){ var x=$(id===p[1]?p[1]:p[0]); if(x){ x.classList.add('rdx-df-err'); x.setAttribute('aria-invalid','true'); } } });
  var sub=$('formSub'); if(sub) sub.textContent=formSub(R);
  renderTiles(R); renderTrendChart(R); renderAllMetrics(R);
}
function renderFormSec(){
  var sec=$('sec-form'); if(!sec) return;
  var R=periodRanges();
  sec.innerHTML='<div class="rdx-sec-hd"><div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="formHd">Form</h2><p class="rdx-sec-sub" id="formSub">'+esc(formSub(R))+'</p><div id="gcForm"></div></div>'+
      '<div class="rdx-sec-ctl rdx-period"><div class="rdx-ctl"><label for="fPeriod">Period</label><select id="fPeriod">'+
        PERIODS.map(function(p){ return '<option value="'+p[0]+'"'+(UI.period===p[0]?' selected':'')+'>'+p[1]+'</option>'; }).join('')+'</select></div></div></div>'+
    (UI.period==='custom' ? (function(){ var lim=' min="'+(RAW.length?ymd(new Date(RAW[0].ts)):'')+'" max="'+ymd(new Date())+'"'; return '<div class="rdx-period-more">'+
      '<div class="rdx-ctl"><label for="aFrom">From</label><input type="date" id="aFrom" value="'+esc(UI.aFrom)+'"'+lim+'></div>'+
      '<div class="rdx-ctl"><label for="aTo">To</label><input type="date" id="aTo" value="'+esc(UI.aTo)+'"'+lim+'></div>'+
      '<div class="rdx-ctl"><label for="fCmp">Compare with</label><select id="fCmp"><option value="prev"'+(UI.cmp!=='custom'?' selected':'')+'>The same length before</option><option value="custom"'+(UI.cmp==='custom'?' selected':'')+'>Another range</option></select></div>'+
      (UI.cmp==='custom'?'<div class="rdx-ctl"><label for="bFrom">Compare from</label><input type="date" id="bFrom" value="'+esc(UI.bFrom)+'"'+lim+'></div>'+
        '<div class="rdx-ctl"><label for="bTo">Compare to</label><input type="date" id="bTo" value="'+esc(UI.bTo)+'"'+lim+'></div>':'')+
    '</div>'; })() : '')+
    scopeHTML()+
    '<div class="rdx-tiles" id="formTiles"></div>'+
    '<div class="rdx-trend-ctl"><label for="trMetric">Trend<select id="trMetric"></select></label><label for="trMetric2">vs<select id="trMetric2"></select></label>'+
      '<div class="rdx-types" role="group" aria-label="Display">'+[['smooth','Smooth'],['points','Points'],['hideOut','Hide outliers']].map(function(c){ var on=!!UI[c[0]];
        return '<button type="button" class="rdx-chip'+(on?' on':'')+'" data-act="disp" data-k="'+c[0]+'" data-f="disp'+c[0]+'" aria-pressed="'+on+'">'+c[1]+'</button>'; }).join('')+'</div></div>'+
    '<div class="rdx-chartwrap"><div class="rdx-legend" id="trendLegend"></div><div class="rdx-chartbox" id="trendBox"></div><p class="rdx-ev-cap" id="trendEvCap"></p></div>'+
    '<details class="rdx-more rdx-all" id="allMetrics" data-ui="allOpen"'+(UI.allOpen?' open':'')+'><summary data-f="allsum">All metrics, '+(R.b?'this period vs the one before':'every stored run')+'</summary><div class="rdx-more-body">'+
      '<div class="rdx-tablewrap"><table class="rdx-table" id="ftable"></table></div><p class="rdx-note" id="formHint"></p></div></details>';
  populateMetricSelects();
  renderTiles(R); renderTrendChart(R); renderAllMetrics(R);
}
// "Counts: Running, Treadmill Running, Lever · all intensities · runs from 0.5 mi  Edit" — which runs Form
// uses, in words. Edit opens the type chips and intensity in place; min distance lives in Settings.
function scopeHTML(){
  var known=knownTypes(), types=Object.keys(known).sort(function(a,b){ return known[b]-known[a]; }), inc=includedPref();
  var on=types.filter(typeOn), none=!typeRuns().length;
  var itTxt={all:'all intensities', workout:'workouts only', easy:'easy runs only'}[inc.intensity];
  var filtered=on.length<types.length || inc.intensity!=='all', mdOff=parseFloat(inc.mindist)!==parseFloat(FILTER_DEFAULTS.mindist);
  return '<div class="rdx-scope" id="formScope">'+
    (none ? '<span class="warn">These filters leave out all '+plural(RAW.length,'run')+'.</span>'
      : '<span><b>Counts:</b> '+esc(on.join(', '))+' · '+itTxt+' · runs from '+esc(inc.mindist)+' mi</span>')+
    '<button type="button" class="rdx-link" data-act="scope-toggle" data-f="scopetog" aria-expanded="'+UI.scopeOpen+'" aria-controls="scopePanel">'+(UI.scopeOpen?'Done':'Edit')+'</button>'+
    (filtered?'<button type="button" class="rdx-link" data-act="filters-reset" data-f="freset">Reset</button>':'')+
    ((mdOff||none)?'<button type="button" class="rdx-link" data-act="open-settings" data-f="scopesettings">Min distance is in Settings</button>':'')+
    '<div class="rdx-scope-panel" id="scopePanel"'+(UI.scopeOpen?'':' hidden')+'>'+
      '<div class="rdx-ctl"><span class="rdx-lbl" id="typesLbl">Activity types</span><div class="rdx-types" role="group" aria-labelledby="typesLbl">'+
        types.map(function(t){ var o=typeOn(t); return '<button type="button" class="rdx-chip'+(o?' on':'')+'" data-act="type" data-t="'+esc(t)+'" data-f="type'+esc(t)+'" aria-pressed="'+o+'">'+esc(t)+' ('+known[t]+')</button>'; }).join('')+'</div></div>'+
      '<div class="rdx-ctl"><label for="fIntensity">Run intensity</label><select id="fIntensity"><option value="all">All runs</option><option value="workout">Workouts only</option><option value="easy">Easy only</option></select></div>'+
      '<p class="rdx-hint" style="flex-basis:100%">Today, Load and Injury Patterns count every run. Workouts are runs faster than the workout pace in Settings.</p>'+
    '</div></div>';
}
// Trend metric selects, grouped; metrics the device can't record are left out, ones no stored run carries are
// listed disabled "(not recorded)". The overlay can't repeat the main metric.
function populateMetricSelects(){
  var v1=$('trMetric'), v2=$('trMetric2'); if(!v1) return;
  var rec={};
  METRICS.forEach(function(m){ rec[m.key]=m.key==='impact' || RAW.some(function(r){ var v=m.calc(r); return v!=null&&!isNaN(v); }); });
  var opts=function(){ return METRIC_GROUPS.map(function(g){
    var o=g[1].map(function(k){ var m=BY_KEY[k]; if(!(m&&metricVisible(m))) return '';
      return '<option value="'+k+'"'+(rec[k]?'':' disabled')+'>'+(k==='impact'?'Impact Load per run':m.label)+(rec[k]?'':' (not recorded)')+'</option>'; }).join('');
    return o?'<optgroup label="'+g[0]+'">'+o+'</optgroup>':''; }).join(''); };
  v1.innerHTML=opts(); v2.innerHTML='<option value="">None</option>'+opts();
  var ok=function(sel,v){ return Array.prototype.some.call(sel.options,function(o){ return o.value===v&&!o.disabled; }); };
  if(!ok(v1,UI.metric)){ var first=['gct','cad','pace','impact'].filter(function(k){ return ok(v1,k); })[0]; UI.metric=first||''; }
  v1.value=UI.metric;
  Array.prototype.forEach.call(v2.options,function(o){ if(o.value==='') return; if(o.value===UI.metric) o.disabled=true; });
  if(!ok(v2,UI.metric2)||UI.metric2===UI.metric) UI.metric2='';
  v2.value=UI.metric2;
  var it=$('fIntensity'); if(it) it.value=includedPref().intensity;
}
// Tiles: the period vs the one before. With no runs in the earlier period there's nothing to compare, so one
// line says so instead of a "no prior" on every tile.
function renderTiles(R){
  var el=$('formTiles'); if(!el) return;
  if(R.bad){ el.innerHTML='<p class="rdx-note rdx-tiles-note">'+RANGE_BAD_MSG+'</p>'; return; }
  var cur=formRuns(R.a[0],R.a[1]), prev=R.b?formRuns(R.b[0],R.b[1]):[];
  if(!cur.length){ el.innerHTML='<p class="rdx-note rdx-tiles-note">No runs in this period that match the Counts line.</p>'; return; }
  var missing=[], fmtM=function(v,m){ return m.pace?fmtPace(v):v.toFixed(m.dec); };
  var html=TILE_KEYS.map(function(k){
    var m=BY_KEY[k]; if(!m||!metricVisible(m)) return '';
    var cv=metricMean(cur,m); if(cv==null){ missing.push(m.label); return ''; }
    var pv=prev.length?metricMean(prev,m):null;
    var d=prev.length?(pv!=null?deltaHTML(cv,pv,m)+' <span class="rdx-tile-prev">vs '+fmtM(pv,m)+'</span>':'<span class="rdx-delta flat same">no earlier data</span>'):'';
    return '<div class="rdx-tile"><div class="rdx-tile-lbl">'+m.label+'</div>'+
      '<div class="rdx-tile-val">'+fmtM(cv,m)+(m.unit?'<span class="rdx-tile-unit">'+m.unit+'</span>':'')+'</div>'+
      (d?'<div class="rdx-tile-delta">'+d+'</div>':'')+'</div>';
  }).join('');
  var miss=missing.length?'<p class="rdx-note rdx-tiles-note">'+(missing.length>1?missing.slice(0,-1).join(', ')+' and '+missing[missing.length-1]:missing[0])+' weren’t recorded in these runs — they need a running-dynamics pod, strap or compatible watch.</p>':'';
  if(!html){ el.innerHTML=miss||'<p class="rdx-note rdx-tiles-note">No form metrics available for this device.</p>'; return; }
  el.innerHTML=html+(R.b&&!prev.length?'<p class="rdx-note rdx-tiles-note">Changes show here once there are runs in the period before.</p>':'')+miss;
}
function dataBounds(s, mn, mx){
  var m=s.m, unit=m.pace?1:Math.pow(10,-(m.dec||0));
  if(m.zeroFill){ mn=Math.min(mn,0); if(mx<=mn) mx=mn+unit; }
  else if(mx-mn<1e-9){ mn-=unit; mx+=unit; }
  s.lo=mn; s.hi=mx;
}
function tickFmt(m,v){ if(m.pace)return fmtPace(v); if(v===0)return '0'; if(Math.abs(v)>=100)return Math.round(v); return v.toFixed(m.dec===0?0:(m.dec>=2?2:1)); }
function quantile(sorted,q){ var pos=(sorted.length-1)*q, base=Math.floor(pos), rest=pos-base; return sorted[base+1]!==undefined ? sorted[base]+rest*(sorted[base+1]-sorted[base]) : sorted[base]; }
function smoothPts(pts){ var w=Math.max(3,Math.min(21,Math.round(pts.length/8))), half=Math.floor(w/2); return pts.map(function(p,i){ var s=0,c=0; for(var j=Math.max(0,i-half);j<=Math.min(pts.length-1,i+half);j++){ s+=pts[j].v; c++; } return {ts:p.ts,v:s/c}; }); }
// The trend chart: the chosen metric (and an overlay) per run across the period and the one before it, the
// earlier one shaded. Smooth draws the trend line; Hide outliers drops glitch values (keeps logged races and
// injuries, and hard efforts while Points is on); Points shows every run and the hard-effort rings. A run
// missing the metric leaves a gap; Impact Load drops to 0 on rest days and is never outlier-filtered.
function renderTrendChart(R){
  var chart=$('trendBox'), legend=$('trendLegend'); if(!chart) return;
  chart.onmousemove=chart.onmouseleave=chart.onpointerdown=chart.onkeydown=null;
  if(!chart._cap){ chart._cap=true; wireEventCap(chart,'trendEvCap'); }
  var bail=function(msg){ legend.innerHTML=''; chart.innerHTML='<div class="rdx-chart-empty">'+msg+'</div>'; evCapReset(chart,'trendEvCap'); };
  if(R.bad){ bail(RANGE_BAD_MSG); return; }
  var series=[];
  if(UI.metric) series.push({m:BY_KEY[UI.metric],color:'var(--rdx-s1)'});
  if(UI.metric2&&UI.metric2!==UI.metric) series.push({m:BY_KEY[UI.metric2],color:'var(--rdx-s2)'});
  if(!series.length){ bail('Choose a metric to plot.'); return; }
  var shade=R.b&&R.adjacent, t0=shade?R.b[0]:R.a[0], t1=R.a[1];
  if(!isFinite(t0)){ var tr=typeRuns(); t0=tr.length?tr[0].ts-DAY:t1-90*DAY; }
  var evMap=new Map(); events().forEach(function(e){ if(e.type!=='injury'&&e.type!=='race') return; evMap.set(ymd(new Date(e.ts)), e.type); });
  var evType=function(p){ return evMap.get(ymd(p.date))||null; };
  var maxIds=RunLoad.maxEffortIds(typeRuns());
  var runs=formRuns(t0,t1), hideOut=UI.hideOut, smooth=UI.smooth, showPts=UI.points;
  var evColor=function(t){ return t==='injury'?'var(--rdx-spike)':'var(--rdx-good-ink)'; };
  series.forEach(function(s){
    var mapped=runs.map(function(r){return {ts:r.ts,v:s.m.calc(r),date:r.date,id:r.id,dist:r.distMi,pace:r.paceSec,title:r.title};}).sort(function(a,b){return a.ts-b.ts;});
    var seg=0, all=[];
    mapped.forEach(function(p){ if(p.v==null||isNaN(p.v)){ if(!s.m.zeroFill) seg++; return; } p.seg=seg; all.push(p); });
    // a far-out glitch fence (3×IQR, never tighter than 25% of the median): sensor glitches are order-of-
    // magnitude wrong, real workouts are not; volume metrics skip it (a long run is the signal)
    var flo=-Infinity, fhi=Infinity;
    if(!s.m.zeroFill && all.length>=5){
      var vals=all.map(function(p){return p.v;}).slice().sort(function(a,b){return a-b;});
      var q1=quantile(vals,0.25), q3=quantile(vals,0.75), iqr=q3-q1, med=quantile(vals,0.5);
      if(iqr>0){ var half=Math.max(3*iqr, 0.25*Math.abs(med)); flo=q1-half; fhi=q3+half; }
    }
    var inF=function(p){ return p.v>=flo&&p.v<=fhi; };
    s.line = hideOut ? all.filter(inF) : all;
    s.dots = hideOut ? all.filter(function(p){return inF(p)||evType(p)||(showPts&&maxIds.has(p.id));}) : all;
    if(s.m.zeroFill && all.length>1){
      var has=new Set(all.map(function(p){ var d=new Date(p.ts); d.setHours(0,0,0,0); return d.getTime(); }));
      var zeros=[], cur=new Date(all[0].ts); cur.setHours(0,0,0,0);
      var endDay=new Date(all[all.length-1].ts); endDay.setHours(0,0,0,0);
      while(cur.getTime()<endDay.getTime()){ if(!has.has(cur.getTime())) zeros.push({ts:cur.getTime()+DAY/2, v:0}); cur.setDate(cur.getDate()+1); cur.setHours(0,0,0,0); }
      s.line=s.line.concat(zeros).sort(function(a,b){return a.ts-b.ts;});
    }
    var src=s.dots.length ? s.dots : all;
    if(src.length) dataBounds(s, Math.min.apply(null,src.map(function(p){return p.v;})), Math.max.apply(null,src.map(function(p){return p.v;})));
  });
  var have=series.filter(function(s){return s.dots.length;});
  if(!have.length){ bail('No runs with this metric in the period.'); return; }
  var D=chartDims(chart,series.length>1?46:12), W=D.W, H=D.H, padL=D.padL, padR=D.padR, padT=D.padT, innerW=D.innerW, innerH=D.innerH;
  var xOf=function(ts){return padL+((ts-t0)/(t1-t0))*innerW;};
  var yOf=function(v,s){ var f=(v-s.lo)/(s.hi-s.lo); return s.m.pace ? padT+f*innerH : padT+innerH-f*innerH; };   // pace: faster on top
  var valAt=function(s,f){ return s.m.pace ? s.hi-(s.hi-s.lo)*f : s.lo+(s.hi-s.lo)*f; };
  var s2=series.length>1&&series[1].dots.length?series[1]:null;
  var grid='';
  if(shade){ var sx=xOf(R.a[0]);
    grid+='<rect class="rdx-shade" x="'+padL+'" y="'+padT+'" width="'+Math.max(0,sx-padL).toFixed(1)+'" height="'+innerH+'"/>'+
      '<text class="rdx-shade-lbl" x="'+(padL+6)+'" y="'+(padT-8)+'">'+esc(R.bLabel)+'</text>'+
      '<text class="rdx-shade-lbl" x="'+(sx+6).toFixed(1)+'" y="'+(padT-8)+'">'+esc(R.aLabel)+'</text>'; }
  grid+=(have[0].m.unit?'<text class="rdx-ax-lbl" x="2" y="13">'+have[0].m.unit+'</text>':'')+
    (s2&&s2.m.unit?'<text class="rdx-ax-lbl rdx-ax2" x="'+(W-2)+'" y="13" text-anchor="end">'+s2.m.unit+'</text>':'');
  for(var g=0;g<=3;g++){
    var f=g/3, yy=(padT+innerH-f*innerH).toFixed(1);
    grid+='<line class="rdx-grid" x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'"/>';
    grid+='<text x="'+(padL-6)+'" y="'+(parseFloat(yy)+4).toFixed(1)+'" text-anchor="end">'+tickFmt(have[0].m,valAt(have[0],f))+'</text>';
    if(s2) grid+='<text class="rdx-ax2" x="'+(W-padR+6)+'" y="'+(parseFloat(yy)+4).toFixed(1)+'" text-anchor="start">'+tickFmt(s2.m,valAt(s2,f))+'</text>';
  }
  var ea=function(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var lines='', hits='', halo=document.documentElement.getAttribute('data-theme')==='light'?'rgba(0,0,0,0.30)':'rgba(255,255,255,0.85)';
  have.forEach(function(s){
    var segs=[]; s.line.forEach(function(p){ var k=p.seg||0; (segs[k]=segs[k]||[]).push(p); });
    segs.forEach(function(segPts){
      var src=smooth?smoothPts(segPts):segPts;
      if(src.length>1) lines+='<polyline points="'+src.map(function(p){return xOf(p.ts).toFixed(1)+','+yOf(p.v,s).toFixed(1);}).join(' ')+'" fill="none" style="stroke:'+s.color+'" stroke-width="'+(smooth?2.6:2)+'" stroke-linejoin="round" stroke-linecap="round"/>';
      else if(src.length===1&&!showPts) lines+='<circle cx="'+xOf(src[0].ts).toFixed(1)+'" cy="'+yOf(src[0].v,s).toFixed(1)+'" r="2.4" style="fill:'+s.color+'"/>';
    });
    lines+=s.dots.map(function(p){
      var t=evType(p), isMax=!t&&maxIds.has(p.id), cx=xOf(p.ts).toFixed(1), cy=yOf(p.v,s).toFixed(1);
      if(t) return '<circle cx="'+cx+'" cy="'+cy+'" r="3.8" style="fill:'+evColor(t)+'" stroke="'+halo+'" stroke-width="1.2"/>';
      if(isMax&&showPts) return '<circle cx="'+cx+'" cy="'+cy+'" r="3.8" fill="none" style="stroke:var(--rdx-hot)" stroke-width="1.6"/>';
      return showPts ? '<circle cx="'+cx+'" cy="'+cy+'" r="2.4" style="fill:'+s.color+'" fill-opacity="'+(smooth?'0.5':'1')+'"/>' : '';
    }).join('');
    hits+=s.dots.map(function(p){
      var t=evType(p), kind=t||(maxIds.has(p.id)?'max':''), cx=xOf(p.ts).toFixed(1), cy=yOf(p.v,s).toFixed(1);
      var val=tickFmt(s.m,p.v)+(s.m.unit?' '+s.m.unit:'');
      var ctx=(p.dist!=null?p.dist.toFixed(1)+' mi':''); if(p.pace){ ctx+=(ctx?' · ':'')+fmtPace(p.pace)+'/mi'; } if(p.title){ ctx+=(ctx?' · ':'')+p.title; }
      return '<circle class="rdx-hit" cx="'+cx+'" cy="'+cy+'" r="7" fill="rgba(0,0,0,0)" data-date="'+ea(fmtDay(p.ts))+'" data-kind="'+kind+'" data-metric="'+ea(s.m.label)+'" data-val="'+ea(val)+'" data-ctx="'+ea(ctx)+'"/>';
    }).join('');
  });
  var mk={};
  have.forEach(function(s){ s.dots.forEach(function(p){ var t=evType(p); if(t) mk[t]=1; else if(showPts&&maxIds.has(p.id)) mk.max=1; }); });
  var li=function(sw,txt){ return '<span class="rdx-legend-item">'+sw+txt+'</span>'; };
  legend.innerHTML=series.map(function(s){ var none=!s.dots.length;
      return li('<span class="rdx-legend-sw" style="background:'+s.color+(none?';opacity:.4':'')+'"></span>', s.m.label+(s.m.unit?' ('+s.m.unit+')':'')+(none?' — no data in this period':'')); }).join('')+
    (mk.race?li('<span class="rdx-legend-dot" style="background:var(--rdx-good-ink)"></span>','Race'):'')+
    (mk.injury?li('<span class="rdx-legend-dot" style="background:var(--rdx-spike)"></span>','Injury'):'')+
    (mk.max?li('<span class="rdx-legend-ring"></span>','Hard effort'):'')+
    evLegendHTML(t0,t1,mk);
  var av=have[0].dots.map(function(p){ return p.v; });
  var aria=have[0].m.label+', '+fmtDay(t0+1)+' – '+fmtDay(t1)+(shade?' ('+R.bLabel+' shaded)':'')+': '+plural(have[0].dots.length,'run')+', '+tickFmt(have[0].m,Math.min.apply(null,av))+'–'+tickFmt(have[0].m,Math.max.apply(null,av))+(have[0].m.unit?' '+have[0].m.unit:'')+'.';
  chart.innerHTML='<svg class="rdx-chart-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(aria)+'">'+grid+xTicksSVG(t0,t1,D,xOf)+lines+evOverlaySVG(t0,t1,padL,innerW,padT,innerH)+hits+'</svg>';
  wireChartTip(chart);
  evCapReset(chart,'trendEvCap');
}
// A point's tooltip on hover; a tap (touch or pen) does the same and a tap elsewhere closes it. Dataset values
// come back attribute-decoded (ctx holds the run title), so they're re-escaped.
function chartTipHTML(c){
  var k=c.dataset.kind, m={race:['Race','#22c78a','var(--rdx-good-ink)'],injury:['Injury','#f55050','var(--rdx-bad-ink)'],max:['Hard Effort','#f5c842','var(--rdx-gold-ink)']}[k];
  return '<div class="rdx-tip-top">'+esc(c.dataset.date)+(m?' <span class="rdx-tip-chip" style="color:'+m[2]+';border-color:'+m[1]+'">'+m[0]+'</span>':'')+'</div>'
    +'<div class="rdx-tip-val">'+esc(c.dataset.metric)+' · <b>'+esc(c.dataset.val)+'</b></div>'
    +(c.dataset.ctx?'<div class="rdx-tip-ctx">'+esc(c.dataset.ctx)+'</div>':'');
}
function wireChartTip(chart){
  var tip=document.createElement('div'); tip.className='rdx-chart-tip'; chart.appendChild(tip);
  var show=function(e){ var c=e.target.closest&&e.target.closest('.rdx-hit'); if(!c){ tip.classList.remove('on'); return; }
    tip.innerHTML=chartTipHTML(c); tip.classList.add('on');
    var r=chart.getBoundingClientRect(), x=e.clientX-r.left+14, y=e.clientY-r.top+14;
    if(x+tip.offsetWidth>r.width) x=e.clientX-r.left-tip.offsetWidth-14;
    if(y+tip.offsetHeight>r.height) y=e.clientY-r.top-tip.offsetHeight-14;
    tip.style.left=Math.max(0,x)+'px'; tip.style.top=Math.max(0,y)+'px'; };
  chart.onmousemove=show;
  chart.onpointerdown=function(e){ if(e.pointerType!=='mouse') show(e); };
  chart.onmouseleave=function(){ tip.classList.remove('on'); };
}
// All metrics: every metric's average per run, the period vs the one before (with the change), or every
// stored run when the period is All runs. Form first, Derived last; device-hidden metrics are named below.
function renderAllMetrics(R){
  var tbl=$('ftable'); if(!tbl) return;
  if(R.bad){ tbl.innerHTML=''; $('formHint').textContent=RANGE_BAD_MSG; return; }
  var cols=[{label:R.aLabel, runs:formRuns(R.a[0],R.a[1])}], cmp=!!R.b;
  if(cmp) cols.push({label:R.bLabel, runs:formRuns(R.b[0],R.b[1])});
  var head='<thead><tr><th scope="col">Metric</th>'+cols.map(function(c){ return '<th scope="col">'+esc(c.label)+'<span class="rdx-th-sub">'+plural(c.runs.length,'run')+'</span></th>'; }).join('')+
    (cmp?'<th scope="col">Change</th>':'')+'</tr></thead>';
  var body=METRIC_GROUPS.map(function(g){
    var rows=g[1].map(function(k){
      var m=BY_KEY[k]; if(!m||!metricVisible(m)) return '';
      var vals=cols.map(function(c){ return metricMean(c.runs,m); });
      return '<tr><td><span class="rdx-mname">'+m.label+'</span>'+(m.unit?'<span class="rdx-munit">'+m.unit+'</span>':'')+'<div class="rdx-mdesc">'+m.desc+'</div></td>'+
        vals.map(function(v){ return '<td>'+fmtVal(v,m)+'</td>'; }).join('')+(cmp?'<td>'+deltaHTML(vals[0],vals[1],m)+'</td>':'')+'</tr>';
    }).join('');
    return rows?'<tbody><tr class="rdx-grp"><th colspan="'+(cols.length+(cmp?2:1))+'" scope="rowgroup">'+g[0]+'</th></tr>'+rows+'</tbody>':'';
  }).join('');
  tbl.innerHTML=head+body;
  var hidden=METRICS.filter(function(m){ return !metricVisible(m); });
  var note=cmp ? 'Each value is the average per run. Change = this period − the one before: green or red marks a change in the better or worse direction where there is one, and “≈ same” one within normal run-to-run variation.'
    : 'Each value is the average per run over every stored run on the Counts line.';
  if(hidden.length){ var dev=RunDevices.byId(deviceId()); note+=' Hidden for '+(dev?dev.label:'this device')+': '+hidden.map(function(m){return m.label;}).join(', ')+' (needs a chest strap or pod, or not recorded).'; }
  if(BY_KEY.force && metricVisible(BY_KEY.force) && weightKg()==null) note+=' Add body weight in Settings to show Peak Force.';
  $('formHint').textContent=note;
}

/* ---------- Injury Patterns ----------
   Renders InjuryPatterns.analyze() (shared/injury-patterns.js): each logged injury/illness lead-up scored
   against the pattern registry, each pattern's base rate from normal (control) weeks, and big UNexplained
   volume drops offered as "Training gaps to review" — Log it (any event type) or Dismiss (not a setback:
   users/{uid}.runDismissedDrops, never flagged again; restorable). Retrospective and correlational only,
   and only patterns that FIRED are listed. */
function patOrder(patterns){ var ord={}; InjuryPatterns.PATTERNS.forEach(function(p,i){ ord[p.id]=i; });
  return patterns.filter(function(p){ return p.injHits>0; }).sort(function(a,b){ return b.injHits-a.injHits || (b.lift||0)-(a.lift||0) || ord[a.id]-ord[b.id]; }); }
// "injury/injuries" when only injuries were counted, "illness/illnesses" when only illnesses, else "setback/setbacks".
function patNoun(n, inj, ill){ var one=n===1; return (inj&&ill)?(one?'setback':'setbacks'):(ill&&!inj)?(one?'illness':'illnesses'):(one?'injury':'injuries'); }
function casesNoun(cs){ var ill=cs.filter(function(c){ return c.event.type==='illness'; }).length; return patNoun(cs.length, cs.length-ill, ill); }
function pctOf(x){ return Math.round(x*100)+'%'; }
function gapWhen(d){ return d.ongoing ? fmtMD(d.t0)+' – now' : fmtSpan(d.t0,d.t1); }
// the one-line finding above the cards (owner decision D1: headline only a repeated pattern ≥1.5× as common)
function patLeadHTML(res){
  var m=res.meta, noun=patNoun(m.nEval,m.nEvalInj,m.nEvalIll);
  if(!res.cases.some(function(c){ return c.ok&&c.firedIds.length; }))
    return '<p class="rdx-pat-lead">Nothing unusual showed up before '+who()+' logged '+noun+' — the lead-up'+(m.nEval===1?'':'s')+' looked like typical training.</p>';
  if(m.nEval<2) return '';
  var rep=res.patterns.filter(function(p){ return p.injHits>=2; });
  if(!rep.length) return '<p class="rdx-pat-lead">Each '+patNoun(1,m.nEvalInj,m.nEvalIll)+' had a different lead-up — no pattern has repeated yet.</p>';
  var top=rep.filter(function(p){ return !p.lowConf && p.lift!=null && p.lift>=1.5; }).sort(function(a,b){ return b.injHits-a.injHits || (a.ctrlRate==null?1:a.ctrlRate)-(b.ctrlRate==null?1:b.ctrlRate); })[0];
  if(!top) return '<p class="rdx-pat-lead">No pattern stood out from '+who()+' normal weeks.</p>';
  return '<p class="rdx-pat-lead">Seen most often: <b>'+esc(top.name)+'</b> — before '+top.injHits+' of '+top.injEval+' '+patNoun(top.injEval,top.injEval-top.illEval,top.illEval)+
    (top.ctrlRate!=null&&!top.lowConf?', vs '+pctOf(top.ctrlRate)+' of '+who()+' normal weeks':'')+'.</p>';
}
function moreTxt(open,n){ return (open?'Hide ':'Show ')+n+' older'; }
// a card per case where something fired (newest first, 3 then "Show n older"); "Also logged" last
function setbackCardsHTML(res){
  var newest=function(a,b){ return b.event.ts-a.event.ts; }, rank={};
  patOrder(res.patterns).forEach(function(p,i){ rank[p.id]=i; });
  var hit=res.cases.filter(function(c){ return c.ok&&c.firedIds.length; }).sort(newest);
  var html=hit.map(function(c,i){ var e=c.event;
    return '<article class="rdx-sb-card'+(i>=3?' rdx-sb-old':'')+'" tabindex="-1"'+(i>=3&&!UI.sbMore?' hidden':'')+'>'+
      '<h3 class="rdx-sb-hd">'+evDot(e.type)+'<span>'+evLabel(e)+'</span></h3>'+
      (e.note?'<p class="rdx-sb-note">'+esc(e.note)+'</p>':'')+
      '<div class="rdx-sb-lbl">In the weeks before</div><ul class="rdx-sb-flags">'+
      c.flags.filter(function(f){ return f.fired; }).sort(function(a,b){ return (rank[a.id]!=null?rank[a.id]:99)-(rank[b.id]!=null?rank[b.id]:99); }).map(function(f){
        return '<li><b>'+esc(f.name)+'</b><span class="v">'+esc(f.value)+'</span></li>'; }).join('')+
      '</ul>'+(e.type==='illness'?'<p class="rdx-sb-ill">Checked against overtraining-type patterns only.</p>':'')+'</article>';
  }).join('');
  if(hit.length>3) html+='<div class="rdx-sb-more"><button type="button" class="rdx-linkbtn" data-act="sb-older" data-f="sbolder" aria-expanded="'+UI.sbMore+'">'+moreTxt(UI.sbMore,hit.length-3)+'</button></div>';
  return '<div class="rdx-sb-grid">'+html+alsoHTML(res.cases.filter(function(c){ return !(c.ok&&c.firedIds.length); }).sort(newest), res, {nHit:hit.length})+'</div>';
}
// Why a case has no lead-up: dated in the future, before the stored history, past its end, or too early in it.
function whyOf(c, res){ var e=c.event;
  return c.ok?'ok' : e.ts>dayEnd(new Date()).getTime()?'future' : e.ts<res.meta.t0?'before' : e.ts>res.meta.t1+7*DAY?'after' : 'early'; }
function alsoHTML(cs, res, o){
  if(!cs.length) return '';
  o=o||{};
  var quietOk=!o.nHit && cs.every(function(c){ return c.ok; });
  return '<div class="rdx-sb-also"><h3 class="rdx-sb-also-hd">'+(o.nHit?'Also logged':'Logged setbacks')+'</h3><ul>'+cs.map(function(c,i){ var e=c.event;
    var why={ ok:'Nothing unusual in the weeks before.',
      future:'This date is in the future — check it under '+who('Your')+' setbacks and events.',
      before:'Before the stored run history — import the weeks before it to include it.',
      after:'After the last stored run — import the newer runs to include it.',
      early:'Too close to the start of the stored run history — import the weeks before it to include it.' }[whyOf(c,res)];
    return '<li'+(i>=5?' class="rdx-also-old"':'')+' tabindex="-1"'+(i>=5&&!UI.alsoAll?' hidden':'')+'><div class="t">'+evDot(e.type)+'<span>'+evLabel(e)+(e.note?' · '+esc(e.note):'')+'</span></div>'+((o.noWhy||(quietOk&&c.ok))?'':'<div class="s">'+why+'</div>')+'</li>';
  }).join('')+'</ul>'+(cs.length>5?'<button type="button" class="rdx-linkbtn" data-act="also-all" data-f="alsoall" aria-expanded="'+UI.alsoAll+'">'+(UI.alsoAll?'Show fewer':'Show all')+'</button>':'')+'</div>';
}
// The statistics, OPEN by default (owner decision): fired patterns only, then pairs that co-fired before ≥2
// cases. A bordered table: each rate a % + count over a thin bar on one 0–100% scale (accent = before
// setbacks, grey = normal weeks), then the ratio. No pills, no red: "×N" only with ≥2 hits of ≥3 cases.
function patTableHTML(res){
  var m=res.meta, fired=patOrder(res.patterns);
  if(!fired.length) return '';
  var noun=patNoun(m.nEval,m.nEvalInj,m.nEvalIll), weeks=plural(m.nControls,'normal week');
  var bar=function(r, cls){ return '<span class="bar'+(cls?' '+cls:'')+'" aria-hidden="true"><i style="width:'+Math.min(100,Math.max(0,r*100)).toFixed(1)+'%"></i></span>'; };
  var row=function(name, sub, hits, den, dnoun, rate, lift, low){
    var caseRate=den?hits/den:0;
    var x=low?'<span class="x x-na">—</span><span class="m">few normal weeks</span>'
      :(rate===0&&hits>0)?'<span class="x x-na">—</span><span class="m">not seen in normal weeks</span>'
      :(hits>=2&&den>=3&&lift!=null&&lift>=1.05)?'<span class="x">×'+(lift>=10?Math.round(lift):lift.toFixed(1))+'</span><span class="m">as often</span>'
      :'<span class="x x-na">—</span><span class="m">'+(den<3?'needs 3+ setbacks':hits<2?'seen only once':'no more often')+'</span>';
    return '<tr><td><span class="nm">'+name+'</span>'+(sub?'<span class="d">'+sub+'</span>':'')+'</td>'+
      '<td class="c-rate"><span class="lbl">Before '+dnoun+'</span><span class="r"><b>'+pctOf(caseRate)+'</b><small>'+hits+' of '+den+' '+dnoun+'</small></span>'+bar(caseRate,'case')+'</td>'+
      '<td class="c-rate"><span class="lbl">Normal weeks</span>'+(low?'<span class="r"><b class="x-na">—</b><small>too few normal weeks</small></span>':rate==null?'<span class="r"><b class="x-na">—</b></span>':'<span class="r"><b>'+pctOf(rate)+'</b><small>of weeks</small></span>'+bar(rate))+'</td>'+
      '<td class="c-x"><span class="lbl">Ratio</span>'+x+'</td></tr>';
  };
  var rows=fired.map(function(p){ return row(esc(p.name), esc(PATTERN_COPY[p.id]||p.desc), p.injHits, p.injEval, patNoun(p.injEval,p.injEval-p.illEval,p.illEval), p.ctrlRate, p.lift, p.lowConf); });
  var ord={}, ev=res.cases.filter(function(c){ return c.ok; }), lowAll=m.nControls<InjuryPatterns.OPTS.lowConfCtrls;
  InjuryPatterns.PATTERNS.forEach(function(p,i){ ord[p.id]=i; });
  var pairs=res.combos.filter(function(c){ return c.injHits>=2; }).slice(0,2);
  if(pairs.length) rows.push('<tr class="grp"><td colspan="4">Showed up together</td></tr>');
  pairs.forEach(function(c){
    var nm={}; c.ids.forEach(function(id,i){ nm[id]=c.names[i]; });
    var ids=c.ids.slice().sort(function(a,b){ return ord[a]-ord[b]; });
    var den=ev.filter(function(cs){ return ids.every(function(id){ return cs.flags.some(function(f){ return f.id===id; }); }); }), n=den.length;
    var lift=(n&&m.nControls&&c.ctrlRate!=null)?(c.injHits/n)/Math.max(c.ctrlRate,0.5/m.nControls):null;
    rows.push(row(esc(nm[ids[0]])+' + '+esc(nm[ids[1]]), '', c.injHits, n, casesNoun(den), c.ctrlRate, lift, lowAll));
  });
  var injOnly={longrun:1,downhill:1}, mixed=m.nEvalIll>0 && fired.some(function(p){ return injOnly[p.id]; });
  var cav=(m.nEval<3?'Based on '+m.nEval+' '+noun+' — treat these as clues, not trends. ':'')+'Normal weeks skip the weeks around each setback.'+
    (m.nEvalIll?' Illnesses are checked only against overtraining-type patterns: ramp, load spike, intensity and monotony.':'')+
    (mixed?' Long-run jump and downhill are checked on injuries only, so their % is out of injuries.':'');
  return '<details class="rdx-more rdx-pat-more" id="patStats" data-ui="patStats"'+(UI.patStats?' open':'')+'><summary data-f="patsum">How often each pattern showed up · '+m.nEval+' '+noun+(m.nControls?' vs '+weeks:'')+'</summary><div class="rdx-more-body">'+
    (m.nControls ? '<p>Each lead-up vs '+weeks+' from the rest of '+who()+' history.</p>'
      : '<p>'+who('Your')+' logged setbacks and their recovery cover almost all of the stored history, so there are no normal weeks to compare against.</p>')+
    '<div class="rdx-pt-wrap"><table class="rdx-pt"><thead><tr><th scope="col">Pattern</th><th scope="col" class="c-rate">Before</th><th scope="col" class="c-rate">In normal weeks</th><th scope="col" class="c-x">Ratio</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'+
    '<p class="rdx-pt-cav">'+cav+'</p>'+
  '</div></details>';
}
// Training gaps to review: open drops (newest first) + the dismissed line. Rendered whenever there are drops
// or stored dismissals, so a dismissal always stays restorable. Collapsed by default (owner decision D2).
function gapsHTML(drops, dis){
  if(!drops.length && !dis.length) return '';
  var n=drops.length;
  return '<details class="rdx-more rdx-gaps'+(n?'':' is-clear')+'" id="rdxGaps" data-ui="gapsOpen"'+(UI.gapsOpen?' open':'')+'>'+
    '<summary id="rdxGapsHd" data-f="gapssum"><h3 class="rdx-gaps-hd">'+(n?'Training gaps to review · '+n:'Training gaps · none open')+'</h3></summary><div class="rdx-gaps-body">'+
    (n?'<p class="rdx-gaps-intro">'+who('Your')+' volume fell sharply in these weeks and nothing logged explains it. If one was a setback, log it and it joins the report. A busy week or travel, not a setback? Dismiss it and it won’t be flagged again.</p>'+
      '<ul class="rdx-gap-list">'+drops.map(function(d,i){
        var w=d.weeks+(d.capped?'+':'')+' week'+(d.weeks===1&&!d.capped?'':'s'), open=EVF&&EVF.where==='gap'&&EVF.t0===d.t0;
        return '<li class="rdx-gap-row" data-t0="'+d.t0+'" data-t1="'+d.t1+'">'+
          '<div class="rdx-gap-main"><div class="rdx-gap-when" id="rdxGapW'+i+'"><span class="rdx-gap-ico" aria-hidden="true">▼</span>'+gapWhen(d)+'</div>'+
            '<div class="rdx-gap-stats">'+w+(d.ongoing?' · ongoing':'')+' · down '+Math.round(d.pct*100)+'% vs the 4 weeks before</div></div>'+
          '<div class="rdx-gap-acts">'+
            '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm rdx-gap-log" data-act="gap-log" data-i="'+i+'" data-f="log'+d.t0+'" aria-expanded="'+!!open+'"'+(open?' aria-controls="evForm"':'')+' aria-describedby="rdxGapW'+i+'">Log it…</button>'+
            '<button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm rdx-gap-dismiss" data-act="gap-dismiss" data-i="'+i+'" data-f="dis'+d.t0+'" title="Not a setback — hide it and don’t flag it again" aria-label="Dismiss: not a setback — hide it and don’t flag it again" aria-describedby="rdxGapW'+i+'">Dismiss</button>'+
          '</div>'+(open?evFormHTML():'')+'</li>';
      }).join('')+'</ul>':'')+
    dismissedHTML(dis)+'</div></details>';
}
function dismissedHTML(dis){
  if(!dis.length) return '';
  var order=dis.map(function(x,i){ return i; }).sort(function(a,b){ return dis[b].t0-dis[a].t0; });
  return '<div class="rdx-dis">'+dis.length+' dismissed · <button type="button" class="rdx-linkbtn rdx-dis-tog" data-act="dis-tog" data-f="distog" aria-expanded="'+UI.disOpen+'" aria-controls="rdxDisList">'+(UI.disOpen?'hide':'show')+'</button>'+
    '<ul class="rdx-dis-list" id="rdxDisList"'+(UI.disOpen?'':' hidden')+'>'+order.map(function(i){ var x=dis[i], when=fmtSpan(x.t0,x.t1);
      var st=DIS_STATUS[i]||{}, meta=st.k==='explained'?'now explained by '+st.label : st.k==='gone'?'no longer detected' : isFinite(x.at)?'dismissed '+fmtMD(x.at):'';
      return '<li class="rdx-dis-item"><span class="rdx-dis-when">'+when+'</span><span class="rdx-dis-at">'+(meta?'<span aria-hidden="true">· </span>'+meta:'')+'</span>'+
        '<button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm rdx-dis-restore" data-act="dis-restore" data-i="'+i+'" data-f="res'+x.t0+'" aria-label="Restore the '+when+' drop">Restore</button></li>';
    }).join('')+'</ul></div>';
}
var GAP_DROPS=[];   // the open drops on screen (Log it / Dismiss index into it)
function renderInjury(){
  var box=$('patternsBox'); if(!box) return;
  withFocus(function(){ renderInjuryNow(box); });
}
function renderInjuryNow(box){
  var chip=$('patGapChip'), drops=[], dis=dismissedDrops(), html, gaps;
  DIS_STATUS=[];
  if(!window.InjuryPatterns || !LOAD_PARAMS){ box.innerHTML=''; if(chip) chip.hidden=true; return; }
  var evs=events(), res=InjuryPatterns.analyze(loadRuns(), evs, LOAD_PARAMS, { dismissedDrops:dis });
  var nInj=evs.filter(function(e){ return e.type==='injury'; }).length, nIll=evs.filter(function(e){ return e.type==='illness'; }).length;
  var pastOpen=EVF&&EVF.where==='past';
  var logPast='<p class="rdx-pat-act"><button type="button" class="rdx-btn rdx-btn-outline" data-act="logpast" data-f="logpast" aria-expanded="'+!!pastOpen+'"'+(pastOpen?' aria-controls="evForm"':'')+'>+ Log a past injury</button></p>'+(pastOpen?evFormHTML():'');
  var full=false;
  if(!res.ok){
    var days=res.days||0;
    html=res.reason==='history'
      ? '<p class="rdx-pat-lead">This section needs about 10 weeks of run history — '+who('you have')+' '+(days<7?'under a week':plural(Math.floor(days/7),'week'))+' so far.'+
          (RAW.length&&daysAgo(RAW[RAW.length-1].ts)<=7?' It unlocks around '+fmtDay(Date.now()+Math.max(0,70-days)*DAY)+'.':'')+'</p>'+
        '<p class="rdx-pat-act"><button type="button" class="rdx-btn rdx-btn-outline" data-act="logpast" data-f="logpast" aria-expanded="'+!!pastOpen+'"'+(pastOpen?' aria-controls="evForm"':'')+'>+ Log a past injury</button><button type="button" class="rdx-btn rdx-btn-outline" data-act="open-import" data-f="patimport">Import older runs</button></p>'+(pastOpen?evFormHTML():'')
      : '<p class="rdx-pat-lead">No runs meet the minimum distance.</p>'+
        '<p class="rdx-pat-act"><button type="button" class="rdx-btn rdx-btn-outline" data-act="open-settings" data-f="patsettings">Open Settings</button></p>';
  } else {
    drops=res.drops.filter(function(d){ return !d.explained; }).sort(function(a,b){ return b.t0-a.t0; });
    var WHY_LBL={'follows a logged injury':'a logged injury','follows a logged illness':'a logged illness','follows a non-running injury':'a non-running injury','logged planned downtime':'Planned Downtime'};
    DIS_STATUS=dis.map(function(x){ var d=res.drops.filter(function(d){ return InjuryPatterns.dismissOverlaps(d,x); })[0];
      if(!d) return {k:'gone'};
      if(d.why && !d.dismissed) return {k:'explained', label:WHY_LBL[d.why]||(/race/.test(d.why)?'a race':'a logged event')};
      return {}; });
    var m=res.meta;
    if(!nInj && !nIll){
      html='<p class="rdx-pat-lead">No injuries or illnesses logged yet. Log past ones and this section shows what '+who()+' training looked like in the weeks before each.</p>'+logPast+
        '<p class="rdx-wtl-line">'+WTL_LINE+'</p>';
    } else if(!m.nEval){
      var n=nInj+nIll, one=n===1, rs=res.cases.map(function(c){ return whyOf(c,res); }), r=rs.every(function(x){ return x===rs[0]; })?rs[0]:null;
      var where={before:'before the stored run history',early:'in the first 6 weeks of the stored run history',after:'after the last stored run',future:'dated in the future'}[r]||'outside the part of the stored run history that can be analysed';
      var act=r==='after'?'Import the newer runs to include '+(one?'it':'them')+'.' : r==='future'?'Check '+(one?'its':'their')+' date below.' : 'Import the runs from the weeks before '+(one?'it':'each one')+'.';
      html='<p class="rdx-pat-lead">'+who('Your')+' logged '+patNoun(n,nInj,nIll)+' '+(one?'is':'are')+' '+where+', so there’s no lead-up to look at. '+act+'</p>'+
        '<p class="rdx-pat-act">'+(r==='future'?'<button type="button" class="rdx-btn rdx-btn-outline" data-act="go-events" data-f="goevents">Go to the events</button>':'<button type="button" class="rdx-btn rdx-btn-outline" data-act="open-import" data-f="patimport">Open Data</button>')+'</p>'+
        '<div class="rdx-sb-grid">'+alsoHTML(res.cases.slice().sort(function(a,b){ return b.event.ts-a.event.ts; }), res, {noWhy:!!r})+'</div>';
    } else {
      html=patLeadHTML(res)+setbackCardsHTML(res)+patTableHTML(res); full=true;
    }
  }
  box.innerHTML=html;
  // long setback notes clamp to 3 lines; a clamped one gets a more/less toggle (touch has no hover title)
  Array.prototype.forEach.call(box.querySelectorAll('.rdx-sb-note'),function(n,i){
    if(n.scrollHeight<=n.clientHeight+1) return;
    var b=document.createElement('button'); b.type='button'; b.className='rdx-linkbtn rdx-sb-note-more'; b.setAttribute('aria-expanded','false'); b.setAttribute('data-act','note-more'); b.setAttribute('data-f','note'+i); b.textContent='more';
    n.parentNode.insertBefore(b,n.nextSibling);
  });
  GAP_DROPS=drops;
  if(EVF && EVF.where==='gap' && !drops.some(function(d){ return d.t0===EVF.t0; })) EVF=null;   // its gap is gone (logged or dismissed elsewhere)
  if(EVF && EVF.where==='past' && !box.querySelector('[data-act="logpast"]')) EVF=null;
  gaps=$('sec-gaps');
  if(gaps) gaps.innerHTML=gapsHTML(drops,dis)+(full?'<p class="rdx-note rdx-pat-foot">A look back, not a prediction — correlations, not causes, from a small sample.</p>':'');
  if(chip){ chip.hidden=!drops.length; chip.textContent=plural(drops.length,'gap')+' to review'; }
  renderEventsSec();
}

/* ---------- Your setbacks and events ----------
   The one place events are logged, listed, edited and removed. Stored as users/{uid}.runEvents[] =
   { id, type:'race'|'injury'|'illness'|'nonrun'|'timeoff', ts, endTs?, note }; endTs (any type but race)
   makes the event a span. The same form opens here, under "+ Log a past injury", inside a gap row (dates
   prefilled) and in the Log an event dialog — one at a time, re-opened as typed after a re-render. */
function renderEventsSec(){
  var sec=$('sec-events'); if(!sec) return;
  var evs=events().slice().sort(function(a,b){ return b.ts-a.ts; }), n=evs.length, shown=UI.evMore?evs:evs.slice(0,5);
  if(EVF && EVF.editId!=null && !evs.some(function(e){ return String(e.id)===EVF.editId; })) EVF=null;   // removed elsewhere
  var listOpen=EVF&&EVF.where==='list';
  sec.innerHTML='<div class="rdx-sec-hd"><div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="evHead" tabindex="-1">'+who('Your')+' setbacks and events</h2>'+
      '<p class="rdx-sec-sub">What the report above is built from. Races and planned breaks also explain dips in load.</p></div>'+
      '<div class="rdx-sec-ctl"><button type="button" class="rdx-btn rdx-btn-sm" data-act="ev-new" data-f="evnew" aria-expanded="'+!!(listOpen&&EVF.editId==null)+'"'+(listOpen&&EVF.editId==null?' aria-controls="evForm"':'')+'>+ Log an event</button></div></div>'+
    (listOpen?evFormHTML():'')+
    '<p class="rdx-wtl-line">'+WTL_LINE+' Everything but races can take an end date to shade the whole span.</p>'+
    (n ? '<ul class="rdx-evlist">'+shown.map(function(e){ var m=EV_META[e.type]||EV_META.race, when=fmtSpan(e.ts,e.endTs), id=esc(e.id), on=EVF&&EVF.editId===String(e.id);
        return '<li'+(on?' class="editing"':'')+'><span class="rdx-ev-t"><span class="rdx-ev-dot" style="background:'+m[1]+'"></span>'+m[0]+'</span><span class="rdx-ev-w">'+when+'</span>'+
          '<span class="rdx-ev-n">'+esc(e.note||'')+'</span><span class="rdx-ev-acts">'+
          '<button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm" data-act="ev-edit" data-id="'+id+'" data-f="evedit'+id+'" aria-pressed="'+!!on+'" aria-label="Edit '+m[0]+' '+when+(e.note?', '+esc(e.note):'')+'">Edit</button>'+
          '<button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm rdx-ev-rm" data-act="ev-del" data-id="'+id+'" data-f="evdel'+id+'" aria-label="Remove '+m[0]+' '+when+'">Remove</button></span></li>'; }).join('')+'</ul>'+
        (n>5?'<p class="rdx-evmore"><button type="button" class="rdx-linkbtn" data-act="ev-more" data-f="evmore" aria-expanded="'+UI.evMore+'">'+(UI.evMore?'Show the newest 5':'Show '+(n-5)+' more')+'</button></p>':'')
      : '<p class="rdx-ev-none">No events logged yet — log one to mark it on the charts.</p>');
}
function evFormHTML(){
  var f=EVF, edit=f.editId!=null, mx=EV_NO_FUTURE[f.type]?' max="'+ymd(new Date())+'"':'';
  var gap=f.where==='gap'?GAP_DROPS.filter(function(d){ return d.t0===f.t0; })[0]:null;
  var label=edit?'Edit the event':gap?'Log the '+gapWhen(gap)+' gap':f.where==='past'?'Log a past injury':'Log an event';
  var opt=function(t){ return '<option value="'+t+'"'+(f.type===t?' selected':'')+'>'+EV_META[t][0]+'</option>'; };
  return '<div class="rdx-gap-form'+(f.where==='list'?' rdx-evform-list':f.where==='past'?' rdx-gap-form-past':'')+'" id="evForm" role="group" aria-label="'+esc(label)+'">'+
    '<div class="rdx-gf-fields">'+
      '<div class="rdx-ctl"><label for="evType">What was it?</label><select id="evType" required aria-describedby="evHint">'+
        '<option value="" disabled'+(f.type?'':' selected')+'>Choose a type…</option>'+EV_ORDER.map(opt).join('')+'</select></div>'+
      '<div class="rdx-ctl"><label for="evStart">Start</label><input type="date" id="evStart" aria-describedby="evHint" value="'+esc(f.start)+'"'+mx+'></div>'+
      '<div class="rdx-ctl" id="evEndCtl"'+(f.type==='race'?' hidden':'')+'><label for="evEnd">End (optional)</label><input type="date" id="evEnd" aria-describedby="evHint" value="'+esc(f.end)+'"'+mx+'></div>'+
      '<div class="rdx-ctl rdx-gf-note"><label for="evNote">Note</label><input type="text" id="evNote" placeholder="'+esc(EV_PH[f.type]||'Optional')+'" value="'+esc(f.note)+'"></div>'+
    '</div>'+
    '<p class="rdx-gf-hint'+(f.err?' rdx-field-err':'')+'" id="evHint">'+esc(f.err||EV_HINT[f.type]||'')+'</p>'+
    '<div class="rdx-gf-acts"><button type="button" class="rdx-btn rdx-btn-ghost" data-act="ev-cancel" id="evCancel">Cancel</button>'+
      '<button type="button" class="rdx-btn" data-act="ev-save" id="evSave"'+(EV_META[f.type]?'':' disabled')+'>'+(edit?'Save changes':'Save event')+'</button></div>'+
  '</div>';
}
// Open the form where it was asked for; a second click on the same opener folds it.
function openEvForm(o){
  if(EVF && EVF.where===o.where && EVF.t0===o.t0 && EVF.editId==o.editId && o.where!=='dialog'){ closeEvForm(true); return; }
  var dflt=(o.where==='list'||o.where==='dialog')&&o.editId==null&&RAW.length?ymd(new Date(RAW[RAW.length-1].ts)):'';   // a new event starts on the latest run's day
  EVF={ where:o.where, t0:o.t0==null?null:o.t0, editId:o.editId==null?null:String(o.editId), type:o.type||'', start:o.start||dflt, end:o.end||'', note:o.note||'', err:'' };
  if(o.where==='dialog'){ openModal('event'); return; }
  renderInjury();
  var f=$(o.type&&o.where!=='gap'?'evStart':'evType'); if(f) f.focus();
}
// Close it and hand focus back to what opened it (the pressed button, else the section heading).
function closeEvForm(focusBack){
  var f=EVF; EVF=null; if(!f) return;
  if(f.where==='dialog'){ closeModal(focusBack); return; }
  renderInjury();
  if(!focusBack) return;
  var sel=f.editId!=null?'[data-f="evedit'+f.editId+'"]':f.where==='gap'?'[data-f="log'+f.t0+'"]':f.where==='past'?'[data-f="logpast"]':'[data-f="evnew"]';
  var b=ROOT.querySelector(sel)||$('evHead'); if(b) b.focus();
}
function evFormWarn(id,msg){ EVF.err=msg; var h=$('evHint'); if(h){ h.textContent=msg; h.classList.add('rdx-field-err'); } var f=$(id); if(f){ f.classList.add('rdx-df-err'); f.setAttribute('aria-invalid','true'); f.focus(); } toast(msg,{kind:'err'}); }
function evFormClearErr(){ if(!EVF) return; EVF.err=''; ['evStart','evEnd'].forEach(function(id){ fieldOk($(id)); }); var h=$('evHint'); if(h){ h.classList.remove('rdx-field-err'); h.textContent=EV_HINT[EVF.type]||''; } }
function evFormSave(kbd){
  var f=EVF, save=$('evSave'); if(!f || !save || save.disabled || !EV_META[f.type]) return;
  evFormClearErr();
  var t=f.type, s=parseDate(f.start);
  if(!s){ evFormWarn('evStart','Pick a start date.'); return; }
  if(evFuture(t,s)){ evFormWarn('evStart',EV_FUTURE_MSG); return; }
  var e={ id:Date.now(), type:t, ts:s.getTime(), note:(f.note||'').trim() };
  if(t!=='race'){
    var en=parseDate(f.end);
    if(en){ if(en.getTime()<s.getTime()){ evFormWarn('evEnd',EV_END_MSG); return; } if(evFuture(t,en)){ evFormWarn('evEnd',EV_FUTURE_MSG); return; } if(en.getTime()>s.getTime()) e.endTs=en.getTime(); }
  }
  save.disabled=true;   // double-click guard: the row re-renders away under the pointer
  var st=Object.assign({},f), my=MOUNT;
  EVF=null;
  if(f.editId!=null){
    var id=f.editId, old=events().filter(function(x){ return String(x.id)===id; })[0];
    saveEvents(function(list){
      var hit=false, out=list.map(function(x){
        if(String(x.id)!==id) return x;
        hit=true; var o=Object.assign({},x,{type:e.type, ts:e.ts, note:e.note}); if(e.endTs!=null) o.endTs=e.endTs; else delete o.endTs; return o;
      });
      return hit?out:list.concat([Object.assign({},e,{id:old?old.id:e.id})]);   // deleted meanwhile on another device: added back as edited
    }, 'Saved: '+evLabel(e));
  } else {
    // a failed save rolls the event back (saveEvents): re-open the form as typed, unless another is open by then
    saveEvents(evAddFn(e), 'Logged: '+evLabel(e)).then(function(r){ if(r!==true && my===MOUNT && !EVF){ EVF=st; refresh(); } });
  }
  if(st.where==='dialog'){ LAYER.modal=null; var t2=LAYER.modalTrigger; LAYER.modalTrigger=null; refresh(); focusKey(t2); return; }
  refresh();
  if(kbd){ var h=(st.editId!=null&&ROOT.querySelector('[data-f="evedit'+st.editId+'"]'))||(st.where==='gap'?($('rdxGapsHd')||$('patHead')):$('evHead')); if(h) h.focus({preventScroll:true}); }
}
// by String id: data-id comes back as text, stored ids are numbers. A keyboard user's focus moves to the next
// row's Remove (or the "+ Log an event" button once the list is empty): the pressed button is gone.
function evDelete(id, kbd){
  var all=events(), e=all.filter(function(x){ return String(x.id)===String(id); })[0]; if(!e) return;
  var rows=Array.prototype.slice.call($all('.rdx-ev-rm')), at=rows.map(function(b){ return b.getAttribute('data-id'); }).indexOf(String(id));
  // Undo puts back the stored entry as it was (raw ts, not the display-remapped one)
  var raw=(Array.isArray(RD.profile.runEvents)?RD.profile.runEvents:[]).filter(function(x){ return String(x.id)===String(id); })[0]||e;
  if(EVF && EVF.editId===String(id)) EVF=null;
  saveEvents(function(list){ return list.filter(function(x){ return String(x.id)!==String(id); }); }, 'Removed: '+evLabel(e),
    function(){ saveEvents(evAddFn(raw), 'Restored: '+evLabel(e)); refresh(); });
  refresh();
  if(!kbd) return;
  rows=$all('.rdx-ev-rm');
  var t=rows[Math.min(Math.max(at,0),rows.length-1)]||ROOT.querySelector('[data-f="evnew"]'); if(t) t.focus();
}
function dismissGap(i, e){
  // the rows re-render under the pointer: a double-click's second click would land on the NEXT gap's Dismiss
  if(e.detail>1 || Date.now()-DIS_T<500) return;
  var d=GAP_DROPS[i]; if(!d) return;
  DIS_T=Date.now();
  var rec={ t0:d.t0, t1:d.t1, at:Date.now() }, when=fmtSpan(d.t0,d.t1);
  if(EVF && EVF.where==='gap' && EVF.t0===d.t0) EVF=null;
  saveDismissed(function(list){ return list.concat([rec]); }, { kbd:e.detail===0, msg:'Dismissed '+when+' — it won’t be flagged again.',
    undo:function(u){ saveDismissed(function(list){ return list.filter(function(y){ return !sameDis(y,rec); }); },
      { kbd:!!u&&u.detail===0, restored:rec, toDrop:true, msg:'Restored '+when+' — it’s back in Training gaps to review.' }); } });
}
function restoreGap(i, e){
  if(e.detail>1 || Date.now()-DIS_T<500) return;
  var x=dismissedDrops()[i]; if(!x) return;
  DIS_T=Date.now();
  var st=DIS_STATUS[i]||{}, when=fmtSpan(x.t0,x.t1);
  var msg=st.k==='explained'?'Restored '+when+' — a logged event already explains this drop, so it stays off the list.'
    : st.k==='gone'?'Restored '+when+' — this drop is no longer detected.' : 'Restored '+when+' — it’s back in Training gaps to review.';
  // by value, not index: the stored list may be ordered differently
  saveDismissed(function(list){ return list.filter(function(y){ return !sameDis(y,x); }); }, { kbd:e.detail===0, restored:x, msg:msg });
}

/* ---------- the open sheet and dialog ---------- */
function renderLayer(){
  var s=$('rdxSheet'), m=$('rdxModal'); if(!s||!m) return;
  // what a rebuild would lose: the sheet's and the run list's scroll, the dialog's own message, its fade-in
  var sh=s.querySelector('.rdx-sheet'), ls=m.querySelector('.rdx-lv-list'), lt=$('lvToast');
  var keep={ sheetTop:sh?sh.scrollTop:0, listTop:ls?ls.scrollTop:0, lvMsg:lt?lt.textContent:'', lvCls:lt?lt.className:'', sheetWas:s.getAttribute('data-was'), modalWas:m.getAttribute('data-was') };
  var was=document.activeElement, wasIn=!!was && (s.contains(was)||m.contains(was));   // focus inside a sheet/dialog this rebuild may remove
  withFocus(function(){
    var sk=LAYER.sheet&&RAW.length?LAYER.sheet:'';
    if(!(KEEP_SHEET && sk==='settings' && keep.sheetWas==='settings'))
      s.innerHTML=sk ? '<div class="rdx-ov'+(keep.sheetWas===sk?' rdx-still':'')+'" data-ov="sheet"><div class="rdx-sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">'+
        (sk==='data'?dataSheetHTML():settingsSheetHTML())+'<div class="rdx-sr" role="status" aria-live="polite" id="sheetLive"></div></div></div>' : '';
    s.setAttribute('data-was',sk);
    var mk=LAYER.modal==='lever'&&RAW.length?'lever':LAYER.modal==='event'&&EVF?'event':'';
    if(mk==='lever') m.innerHTML=leverModalHTML(keep.modalWas==='lever');
    else if(mk==='event') m.innerHTML='<div class="rdx-modal'+(keep.modalWas==='event'?' rdx-still':'')+'" data-ov="modal"><div class="rdx-modal-panel rdx-modal-sm" role="dialog" aria-modal="true" aria-labelledby="evDlgTitle" tabindex="-1">'+
      '<div class="rdx-modal-hd"><h3 class="rdx-modal-title" id="evDlgTitle">Log an event</h3><button type="button" class="rdx-modal-x" data-act="modal-close" aria-label="Close">✕</button></div>'+
      '<div class="rdx-modal-body">'+evFormHTML()+'<p class="rdx-wtl-line">'+WTL_LINE+'</p></div><div class="rdx-sr" role="status" aria-live="polite" id="modalLive"></div></div></div>';
    else m.innerHTML='';
    m.setAttribute('data-was',mk);
    if(mk==='lever'){ renderLeverList(); var nl=m.querySelector('.rdx-lv-list'); if(nl && keep.modalWas==='lever') nl.scrollTop=keep.listTop;
      var nt=$('lvToast'); if(nt && keep.modalWas==='lever' && keep.lvMsg){ nt.textContent=keep.lvMsg; nt.className=keep.lvCls; } }
    var ns=s.querySelector('.rdx-sheet'); if(ns && keep.sheetWas===sk) ns.scrollTop=keep.sheetTop;
    renderGarminCredit();
  });
  // an open sheet or dialog keeps focus inside it when the rebuild removed the focused element (not while the
  // browser is mid-way moving focus, e.g. a field's change event on Tab: taking focus then would cancel the Tab)
  var panel=topPanel();
  if(panel && wasIn && !document.contains(was) && !panel.contains(document.activeElement)) panel.focus({preventScroll:true});
}

/* ---------- Data: what's stored and how to fix it ---------- */
function importHTML(open){
  var sync=RD.sync.connected && syncActor().canSync;
  return '<div class="rdx-import" id="importBlock">'+
    '<div class="rdx-drop'+(IMPORT_BUSY?' busy':'')+'" id="drop" role="button" tabindex="0" data-act="pick-file"'+(IMPORT_BUSY?' aria-disabled="true"':'')+'><b>Import a Garmin or COROS export</b>'+
      '<span>Choose a file or drop it here — re-imports only add what’s new.</span>'+
      '<input type="file" id="file" accept=".zip,.fit,application/zip" hidden></div>'+
    (sync?'<div class="rdx-imp-acts"><button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="stravaBackfill" data-act="backfill"'+(BACKFILL_BUSY?' disabled':'')+'>⟲ Backfill Strava history</button>'+
      '<span class="rdx-hint">Adds one run per day from the whole Strava history, for every day with no imported activity.</span></div>':'')+
    '<p class="rdx-imp-note" id="importNote"></p>'+
    '<details class="rdx-more" id="exportHelp"'+(open?' open':'')+'><summary>How to export '+who()+' run history</summary>'+
      '<div class="rdx-more-body">'+
        '<p>Export from '+who()+' watch platform with the steps below, then drop the file in the import box above. '+
          'Everything is read in your browser and de-duplicated by start time, so re-uploads only add what is new — and importing from more than one source is fine.</p>'+
        '<p><b>Garmin, whole history</b> — one <code>.zip</code>, delivered by email:</p><ol>'+
        '<li>Open <a href="https://www.garmin.com/en-US/account/datamanagement/exportdata" target="_blank" rel="noopener">Garmin Account → Data Management → Export Your Data</a> and sign in.</li>'+
        '<li>Click <b>Request Data Export</b>. Garmin emails a <b>download link</b> when the export is ready (this can take a few days).</li>'+
        '<li>Download the <code>.zip</code> and drop it in the import box above as it is — no need to unzip it. Only the runs are imported; nothing else in the export leaves your computer.</li>'+
        '<li>If your computer unzipped the download for you (Safari does), open the folder, go to <b>DI_CONNECT › DI-Connect-Uploaded-Files</b> and drop each <code>UploadedFiles</code> .zip there, one at a time.</li>'+
      '</ol>'+
        '<p><b>COROS Training Hub</b> — a <code>.zip</code> of per-activity <code>.fit</code> files, delivered by email:</p><ol>'+
        '<li>On a computer, open <a href="https://t.coros.com" target="_blank" rel="noopener">COROS Training Hub (t.coros.com)</a> and sign in.</li>'+
        '<li>Open the <b>Activity List</b> tab at the top. To import only part of the history, use the list\'s <b>filter</b> controls to narrow by <b>date range</b> and sport first (optional — re-imports de-dupe, so exporting everything is fine too).</li>'+
        '<li>Click <b>Export Data</b> on the right, choose <b>.FIT</b> as the format, and enter the <b>email address</b> to send the export to.</li>'+
        '<li>COROS emails a <b>download link</b> (usually within a few minutes). Open it and download the <code>.zip</code> — it holds one <code>.fit</code> file per activity.</li>'+
        '<li>Drop that <code>.zip</code> in the import box above (a single <code>.fit</code> works too). Each <code>.fit</code> is unpacked and read right in your browser.</li>'+
      '</ol>'+
        '<p>Running-form metrics (ground contact, vertical oscillation, cadence, stride) need a compatible device or strap — runs recorded without one still import for load and pace, they just skip those fields. Garmin Connect’s Activities.csv is no longer imported: it carries no time zone, so runs recorded away from home were stored at the wrong time — the account export’s .fit files are exact.</p>'+
        '<p>Strava connected (via the coaching dashboard)? The last 2 years of Strava runs sync in automatically for runs with no watch import — and <b>Backfill Strava history</b> pulls the entire Strava history at once for the same gap-fill. Strava can\'t provide ground contact, oscillation, or descent, so uploading a watch export for those runs replaces the Strava copy with the full-metric version.</p>'+
      '</div></details>'+
  '</div>';
}
function storedTxt(){
  if(!RAW.length) return '';
  var sy=stravaSyncedTxt();
  return plural(RAW.length,'run')+' stored · '+fmtSpan(RAW[0].ts, RAW[RAW.length-1].ts)+' · '+(RD.sync.connected?'Strava connected'+(sy?', '+sy:''):'Strava not connected');
}
// Every indoor run (RunLoad's own test), plus anything currently Lever or carrying a manual mark.
function lvRuns(){ return RAW.filter(function(r){ return RunLoad.isIndoor(r)||r.lever||r.leverSrc==='unmarked'; }).sort(function(a,b){ return b.ts-a.ts; }); }
function leverHint(){
  var n=RAW.filter(RunLoad.isIndoor).length, lv=RAW.filter(function(r){ return r.lever; }).length;
  var mk=RAW.filter(function(r){ return r.leverSrc==='marked'||r.leverSrc==='unmarked'; }).length;
  return !n&&!lv ? 'No treadmill runs yet' : plural(n,'treadmill run')+' · '+lv+' Lever'+(mk?' · '+mk+' marked by hand':'');
}
function runLine(r){ return fmtDay(r.ts)+', '+(r.distMi!=null?(r.distMi>=100?Math.round(r.distMi).toLocaleString('en-US'):fmtMi(r.distMi))+' mi':'run'); }
function dataSheetHTML(){
  var bad=badRuns(), ex=RAW.filter(function(r){ return r._excl; }), noPace=loadRuns().filter(function(r){ return !(r.paceSec>0); });
  var yours=ROLE==='coach'?'this athlete’s':'your';
  var rows='';
  if(bad.length) rows+='<div class="rdx-clean warn"><div class="rdx-clean-txt"><b>'+(bad.length===1?'1 run looks wrong':bad.length+' runs look wrong')+'</b><span>'+(bad.length===1?'It counts':'They count')+' in '+yours+' load until '+(bad.length===1?'it’s':'they’re')+' excluded. Nothing changes until you press Exclude.</span></div>'+
    (bad.length>1?'<div class="rdx-clean-acts"><button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" data-act="exclude-all" data-f="exall">Exclude all '+bad.length+'</button></div>':'')+
    '<ul class="rdx-clean-list">'+bad.slice(0,6).map(function(r){ var what=runLine(r)+' ('+runFlag(r)+')';
      return '<li><span>'+esc(what)+'</span><button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm" data-act="exclude" data-id="'+esc(r.id)+'" data-f="ex'+esc(r.id)+'" aria-label="Exclude the '+esc(what)+'">Exclude</button></li>'; }).join('')+
      (bad.length>6?'<li><span>+'+(bad.length-6)+' more</span></li>':'')+'</ul>'+garminCredit(bad.slice(0,6),false)+'</div>';
  if(ex.length) rows+='<div class="rdx-clean"><div class="rdx-clean-txt"><b>'+plural(ex.length,'run')+' excluded</b><span>Still stored, but not counted in load or metrics.</span></div>'+
    '<div class="rdx-clean-acts"><button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm" data-act="include-all" data-f="inall" aria-label="Include the '+plural(ex.length,'excluded run')+' again">Include again</button></div></div>';
  if(noPace.length) rows+='<div class="rdx-clean"><div class="rdx-clean-txt"><b>'+(noPace.length===1?'1 run has no pace':noPace.length+' runs have no pace')+'</b><span>So '+(noPace.length===1?'it doesn’t':'they don’t')+' count toward load. Importing the watch file for '+(noPace.length===1?'it':'them')+' fixes it.</span></div>'+
    '<div class="rdx-clean-acts"><button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm" data-act="nopace-tog" data-f="nopace" aria-expanded="'+UI.noPaceOpen+'">'+(UI.noPaceOpen?'Hide':'Show')+'</button></div>'+
    (UI.noPaceOpen?'<ul class="rdx-clean-list">'+noPace.slice(-12).reverse().map(function(r){ return '<li><span>'+esc(runLine(r))+' · '+esc(r.type||'Run')+'</span></li>'; }).join('')+(noPace.length>12?'<li><span>+'+(noPace.length-12)+' older</span></li>':'')+'</ul>':'')+'</div>';
  var lv=lvRuns().length;
  rows+='<div class="rdx-clean"><div class="rdx-clean-txt"><b>Lever runs</b><span id="lvHint">'+esc(leverHint())+'</span></div>'+
    '<div class="rdx-clean-acts"><button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="lvOpen" data-act="lv-open" data-f="lvopen" aria-haspopup="dialog"'+(lv?'':' disabled')+'>Mark Lever runs…</button></div></div>';
  return '<div class="rdx-sheet-hd"><h2 class="rdx-sheet-title" id="sheetTitle">Data</h2><button type="button" class="rdx-modal-x" data-act="sheet-close" aria-label="Close Data">✕</button></div>'+
    '<div id="gcData"></div>'+
    '<section class="rdx-sgrp" id="dataImport" aria-labelledby="dataImportHd"><h3 class="rdx-sgrp-hd" id="dataImportHd">Import</h3>'+importHTML(false)+'<p class="rdx-stored" id="filenote">'+esc(storedTxt())+'</p></section>'+
    '<section class="rdx-sgrp" id="dataClean" aria-labelledby="dataCleanHd"><h3 class="rdx-sgrp-hd" id="dataCleanHd">Cleanup</h3>'+
      (bad.length||ex.length||noPace.length?'':'<p class="rdx-clean-ok">Every stored run looks right.</p>')+rows+'</section>'+
    '<section class="rdx-sgrp" aria-label="Delete"><button type="button" class="rdx-btn rdx-btn-danger rdx-btn-sm" id="resetData" data-act="delete-all"'+(DELETING?' disabled':'')+'>Delete all imported runs</button>'+
      '<p class="rdx-del-cap">Keeps '+yours+' settings, logged events, dismissed gaps and Lever marks.</p></section>';
}

/* ---------- Settings: how runs are scored ---------- */
function easyHint(){ var cal=LOAD_PARAMS && LOAD_PARAMS.basePaceSource==='calibrated' && LOAD_PARAMS.basePaceSec>0;
  return cal?'Using '+fmtPace(LOAD_PARAMS.basePaceSec)+' from '+(ROLE==='coach'?'their':'your')+' easy runs.':'Used until there are enough easy runs to calibrate from.'; }
// an inline error line under a Settings field (the toast repeats it); fieldErr fills it, fieldOk empties it
function errP(id){ return '<p class="rdx-hint rdx-field-err" id="'+id+'Err" hidden></p>'; }
function settingsSheetHTML(){
  var byBrand={}; RunDevices.LIST.forEach(function(d){ (byBrand[d.brand]=byBrand[d.brand]||[]).push(d); });
  var wp=workoutPaceSec(), ep=easyPaceSec(), inc=includedPref();
  if(!KEEP_SHEET) LAST_GOOD={ sWeight:RD.profile.weightLb||'', sEasy:ep!=null?fmtPace(ep):'', sCutoff:wp!=null?fmtPace(wp):FILTER_DEFAULTS.cutoff, sMinDist:inc.mindist };
  return '<div class="rdx-sheet-hd"><h2 class="rdx-sheet-title" id="sheetTitle">Settings</h2><button type="button" class="rdx-modal-x" data-act="sheet-close" aria-label="Close Settings">✕</button></div>'+
    '<div id="gcSet"></div>'+
    '<section class="rdx-sgrp" aria-labelledby="setDevHd"><h3 class="rdx-sgrp-hd" id="setDevHd">'+(ROLE==='coach'?'Their device':'Your device')+'</h3><div class="rdx-sfields">'+
      '<div class="rdx-ctl full"><label for="sDevice">Device</label><select id="sDevice"><option value="">All metrics (no device set)</option>'+Object.keys(byBrand).map(function(b){ return '<optgroup label="'+esc(b)+'">'+byBrand[b].map(function(d){ return '<option value="'+esc(d.id)+'"'+(d.id===deviceId()?' selected':'')+'>'+esc(d.label)+'</option>'; }).join('')+'</optgroup>'; }).join('')+'</select></div>'+
      '<label class="rdx-check full"><input type="checkbox" id="sAccessory"'+(hasAccessory()?' checked':'')+'> '+(ROLE==='coach'?'Runs with a chest strap or foot pod':'I run with a chest strap or foot pod')+'</label>'+
      '<p class="rdx-hint full">Decides which form metrics show.</p></div></section>'+
    '<section class="rdx-sgrp" aria-labelledby="setScoreHd"><h3 class="rdx-sgrp-hd" id="setScoreHd">How runs are scored</h3><div class="rdx-sfields">'+
      '<div class="rdx-ctl"><label for="sWeight">Body weight</label><div class="rdx-inunit"><input type="text" id="sWeight" inputmode="decimal" placeholder="—" aria-describedby="sWeightErr" value="'+esc(LAST_GOOD.sWeight)+'"><span>lb</span></div><p class="rdx-hint">For Peak Force.</p>'+errP('sWeight')+'</div>'+
      '<div class="rdx-ctl"><label for="sEasy">Easy pace</label><div class="rdx-inunit"><input type="text" id="sEasy" placeholder="9:00" aria-describedby="sEasyHint sEasyErr" value="'+esc(LAST_GOOD.sEasy)+'"><span>/mi</span></div>'+
        '<p class="rdx-hint" id="sEasyHint">'+esc(easyHint())+'</p>'+errP('sEasy')+'</div>'+
      '<div class="rdx-ctl full"><label for="sCutoff">Workout pace</label><div class="rdx-inunit"><input type="text" id="sCutoff" placeholder="6:40" aria-describedby="sCutoffHint sCutoffErr" value="'+esc(LAST_GOOD.sCutoff)+'"><span>/mi</span></div>'+
        '<p class="rdx-hint" id="sCutoffHint">Faster runs count as workouts everywhere, and the easy runs set the pace every run is scored against, so changing it can move Today’s numbers.</p>'+errP('sCutoff')+'</div>'+
      '<div class="rdx-inline-field full"><label for="sMinDist">Ignore runs shorter than</label><input type="text" id="sMinDist" inputmode="decimal" aria-describedby="sMinDistErr" value="'+esc(LAST_GOOD.sMinDist)+'"><span>mi</span>'+errP('sMinDist')+'</div>'+
    '</div></section>';
}
// Settings fields commit on change; an empty field clears the stored value; an invalid entry is never stored.
function settingsChange(id, v){
  KEEP_SHEET=true;
  try{ settingsCommit(id, v); } finally { KEEP_SHEET=false; }
  // the one line in the sheet that depends on what changed: the calibrated easy pace
  var h=$('sEasyHint'); if(h) h.textContent=easyHint();
}
function settingsCommit(id, v){
  v=String(v).trim(); var f=$(id);
  if(id==='sDevice'){ persist({ runDevice:v }); refresh(); return; }
  if(id==='sWeight'){
    if(!v){ LAST_GOOD[id]=''; persist({ weightLb:null }); refresh(); return; }
    var lb=parseFloat(v);
    if(!/^\d+(\.\d+)?\s*(lb|lbs)?$/i.test(v) || !(lb>=50 && lb<=400)){ fieldErr(id,'Body weight must be a number from 50 to 400 lb.',LAST_GOOD[id]); return; }
    f.value=lb; LAST_GOOD[id]=String(lb); persist({ weightLb:lb }); refresh(); return;
  }
  if(id==='sEasy'){
    if(!v){ LAST_GOOD[id]=''; persist({ runEasyPaceSec:null }); refresh(); return; }
    var sec=hmsToSec(v);
    if(!(sec>=240 && sec<=1200)){ fieldErr(id,'Easy pace must be between 4:00 and 20:00 /mi.',LAST_GOOD[id]); return; }
    f.value=fmtPace(sec); LAST_GOOD[id]=f.value; persist({ runEasyPaceSec:sec }); refresh(); return;
  }
  if(id==='sCutoff'){
    if(!v){ LAST_GOOD[id]=FILTER_DEFAULTS.cutoff; persist({ runWorkoutPaceSec:null }); refresh(); return; }
    var c=hmsToSec(v);
    if(!/^\d{1,2}:\d{2}$/.test(v) || !(c>=180 && c<=1200)){ fieldErr(id,'Workout pace must look like 6:40.',LAST_GOOD[id]); return; }
    LAST_GOOD[id]=v; persist({ runWorkoutPaceSec: c===hmsToSec(FILTER_DEFAULTS.cutoff)?null:c }); refresh(); return;
  }
  if(id==='sMinDist'){
    var n=parseFloat(v);
    if(!/^\d*\.?\d+$/.test(v) || !(n>=0 && n<=50)){ fieldErr(id,'Min distance must be a number of miles, e.g. 0.5.',LAST_GOOD[id]); return; }
    LAST_GOOD[id]=v; saveIncluded({ mindist:v });
  }
}

/* ---------- Mark Lever runs ----------
   Bulk-marks treadmill runs as Lever runs (or explicitly not) with a per-run offload, stored as
   users/{uid}.runLeverMarks. The Lever support % here is also the default for auto-detected Lever runs
   (users/{uid}.runLeverPctBW) while "Use as the default" is ticked. */
function lvOffFrac(){ var el=$('lvOff'), v=el?parseFloat(el.value):NaN; return (v>=5&&v<=99)?(100-v)/100:null; }
function lvIL(r){ var v=LOAD_PARAMS?RunLoad.impactLoad(r,LOAD_PARAMS):null; return v>0?v:0; }
function lvBadge(r){
  var dflt='Scored at the default: '+fmtPct(leverPct())+'% body weight';
  switch(r.leverSrc){
    case 'marked':   var o=r.offload!=null?r.offload*100:100-leverPct();
                     return ['lever','Lever · '+fmtPct(100-o)+'% BW · marked','Marked by hand: runs at '+fmtPct(100-o)+'% body weight ('+fmtPct(o)+'% offload)'];
    case 'title':    return ['lever','Lever · title',dflt];
    case 'strava':   return ['lever','Lever · Strava title',dflt];
    case 'auto':     return ['lever','Lever · auto-detected',dflt];
    case 'unmarked': return ['not','Not Lever · marked','Marked by hand as not a Lever run — scored at full body weight'];
  }
  return ['tm','Treadmill'];
}
function lvRowHTML(r,i){
  var d=new Date(r.ts), b=lvBadge(r), il=LOAD_PARAMS?RunLoad.impactLoad(r,LOAD_PARAMS):null, name=esc(r.title||r.type||'Run');
  var dist=r.distMi!=null?r.distMi.toFixed(1)+' mi':'–', pace=r.paceSec>0?fmtPace(r.paceSec):'–', hr=r.avgHr>0?String(Math.round(r.avgHr)):'–';
  return '<label class="rdx-lv-row"><input type="checkbox" class="rdx-lv-cb" data-i="'+i+'">'+
    '<span class="rdx-lv-date">'+fmtMD(r.ts)+'<small>'+DOW[d.getDay()]+'</small></span>'+
    '<span class="rdx-lv-title" title="'+name+'">'+name+'</span>'+
    '<span class="rdx-lv-num">'+dist+'</span><span class="rdx-lv-num">'+pace+'</span><span class="rdx-lv-num">'+hr+'</span>'+
    '<span class="rdx-lv-meta">'+[dist, pace!=='–'?pace+'/mi':'', hr!=='–'?hr+' bpm':''].filter(Boolean).join(' · ')+'</span>'+
    '<span class="rdx-lv-badge '+b[0]+'"'+(b[2]?' title="'+esc(b[2])+'"':'')+'>'+b[1]+'</span>'+
    '<span class="rdx-lv-iad">'+(il!=null?il.toFixed(1):'–')+'<small> IAD</small></span></label>';
}
function leverModalHTML(still){
  var off=$('lvOff'), val=off?off.value:fmtPct(leverPct()), def=$('lvDef'), defOn=def?def.checked:true;
  return '<div class="rdx-modal'+(still?' rdx-still':'')+'" data-ov="modal"><div class="rdx-modal-panel" role="dialog" aria-modal="true" aria-labelledby="lvTitle" aria-describedby="lvDesc" tabindex="-1">'+
    '<div class="rdx-modal-hd"><h3 class="rdx-modal-title" id="lvTitle">Mark Lever runs</h3><button type="button" class="rdx-modal-x" data-act="modal-close" aria-label="Close">✕</button></div>'+
    '<div class="rdx-modal-intro"><div id="gcLv"></div><p class="rdx-modal-sub" id="lvDesc">Pick the treadmill runs '+(ROLE==='coach'?'this athlete':'you')+' did on the Lever and set the body-weight support. Their Impact Load (IAD) is recalculated with the offload discount, and Today, the charts and Injury Patterns update.</p></div>'+
    '<div class="rdx-lv-bar">'+
      '<div class="rdx-ctl"><label for="lvOff">Lever support</label><div class="rdx-inunit"><input type="number" id="lvOff" min="5" max="99" step="any" inputmode="decimal" aria-describedby="lvOffCap" value="'+esc(val)+'"><span>% body weight</span></div><div class="rdx-lv-cap" id="lvOffCap"></div></div>'+
      '<div class="rdx-ctl"><span class="rdx-lbl" id="lvFilterLbl">Show</span><div class="rdx-types" id="lvFilter" role="group" aria-labelledby="lvFilterLbl"></div></div>'+
      '<label class="rdx-check rdx-lv-def"><input type="checkbox" id="lvDef"'+(defOn?' checked':'')+'> Use as the default for auto-detected Lever runs</label>'+
      '<div class="rdx-lv-note">Auto-detected = a treadmill run with a heart rate low for its pace. A manual mark always wins over detection and titles; <b>Reset to auto</b> removes it.</div>'+
    '</div>'+
    '<div class="rdx-lv-list" id="lvList"></div>'+
    '<div class="rdx-modal-ft"><div class="rdx-lv-sum" id="lvSum"></div><div class="rdx-lv-acts">'+
      '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="lvReset" data-act="lv-apply" data-k="reset">Reset to auto</button>'+
      '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="lvNot" data-act="lv-apply" data-k="not">Not Lever</button>'+
      '<button type="button" class="rdx-btn rdx-btn-sm" id="lvMark" data-act="lv-apply" data-k="mark">Mark as Lever</button></div>'+
      '<div class="rdx-lv-toast" id="lvToast" role="status" aria-live="polite"></div></div><div class="rdx-sr" role="status" aria-live="polite" id="modalLive"></div></div></div>';
}
function renderLeverList(){
  var all=lvRuns(), cnt={all:all.length, not:0, lever:0};
  all.forEach(function(r){ cnt[r.lever?'lever':'not']++; });
  $('lvFilter').innerHTML=[['all','All treadmill'],['not','Not Lever'],['lever','Lever']].map(function(f){
    var on=LV.filter===f[0];
    return '<button type="button" class="rdx-chip'+(on?' on':'')+'" data-act="lv-filter" data-k="'+f[0]+'" data-f="lvf'+f[0]+'" aria-pressed="'+on+'">'+f[1]+' ('+cnt[f[0]]+')</button>';
  }).join('');
  LV.rows=all.filter(function(r){ return LV.filter==='all' || (LV.filter==='lever')===!!r.lever; });
  var vis=new Set(LV.rows.map(function(r){ return r.id; }));
  LV.sel.forEach(function(id){ if(!vis.has(id)) LV.sel.delete(id); });   // selection = visible rows only
  $('lvList').innerHTML = LV.rows.length
    ? '<div class="rdx-lv-row rdx-lv-head"><input type="checkbox" class="rdx-lv-all" id="lvAll" aria-label="Select all shown runs">'+
        '<label class="c-all" for="lvAll">Select all shown</label><span>Date</span><span>Run</span><span class="r">Dist</span><span class="r">Pace</span><span class="r">Avg HR</span><span>Status</span><span class="r">IAD mi</span></div>'+
      LV.rows.map(lvRowHTML).join('')
    : '<div class="rdx-lv-empty">'+(all.length?'No runs match this filter.':'No treadmill or indoor runs stored yet — they show up here once imported or synced.')+'</div>';
  lvSync();
}
// Checkbox states, select-all, the support caption/validation, the IAD preview and the button states.
function lvSync(){
  var list=$('lvList'); if(!list) return;
  Array.prototype.forEach.call(list.querySelectorAll('.rdx-lv-cb'),function(cb){
    var r=LV.rows[+cb.getAttribute('data-i')], on=!!r&&LV.sel.has(r.id);
    cb.checked=on; cb.parentNode.classList.toggle('on',on);
  });
  var n=LV.sel.size, allCb=list.querySelector('.rdx-lv-all');
  if(allCb){ allCb.checked=n>0&&n===LV.rows.length; allCb.indeterminate=n>0&&n<LV.rows.length; }
  var off=lvOffFrac(), inp=$('lvOff'), cap=$('lvOffCap');
  inp.classList.toggle('rdx-df-err',off==null); inp.setAttribute('aria-invalid',off==null?'true':'false');
  cap.className='rdx-lv-cap'+(off==null?' err':'');
  cap.textContent=off==null?'Enter a number from 5 to 99':'= '+fmtPct(off*100)+'% offload';
  var sel=LV.rows.filter(function(r){ return LV.sel.has(r.id); }), sum=$('lvSum');
  if(!n) sum.textContent='Select runs to change · '+LV.rows.length+' shown';
  else {
    var before=0, asLever=0, asNot=0;
    sel.forEach(function(r){ before+=lvIL(r); if(off!=null) asLever+=lvIL(Object.assign({},r,{lever:true,offload:off})); asNot+=lvIL(Object.assign({},r,{lever:false,offload:null})); });
    sum.innerHTML='<b>'+n+'</b> selected · '+(off==null ? 'set a valid body-weight support to mark them as Lever'
      : 'as Lever at '+fmtPct(100-off*100)+'% BW: <b>'+before.toFixed(1)+' → '+asLever.toFixed(1)+'</b> IAD mi')+
      (sel.some(function(r){ return r.lever; })?' · as not Lever: <b>'+before.toFixed(1)+' → '+asNot.toFixed(1)+'</b>':'');
  }
  var hasMark=sel.some(function(r){ return r.leverSrc==='marked'||r.leverSrc==='unmarked'; });
  $('lvMark').disabled=!n||off==null; $('lvNot').disabled=!n; $('lvReset').disabled=!hasMark;
  $('lvReset').title=(n&&!hasMark)?'None of the selected runs has a manual mark':'Remove the manual mark — back to title / auto-detection';
}
function lvToast(msg,ok){
  var el=$('lvToast'); if(!el) return;
  clearTimeout(LV.toastT); el.className='rdx-lv-toast'+(ok?'':' err'); el.textContent=msg;
  if(ok) LV.toastT=setTimeout(function(){ var e2=$('lvToast'); if(e2) e2.textContent=''; },5000);
}
// The support % as the default: saved on change while "Use as the default" is ticked (and when it's ticked).
function lvSaveDefault(){
  var def=$('lvDef'), off=lvOffFrac(); if(!def||!def.checked||off==null) return;
  var pct=Math.round((100-off*100)*10)/10;
  if(pct===leverPct()) return;
  persist({ runLeverPctBW:pct }, 'Default Lever support: '+fmtPct(pct)+'% body weight');
  refresh();
}
function lvApply(kind){
  var off=lvOffFrac();
  if(kind==='mark' && off==null) return;
  var sel=LV.rows.filter(function(r){ return LV.sel.has(r.id); });
  if(!sel.length) return;
  // drop every mark that applies to a selected run — by its id, or the fallback-matched mark of a run
  // re-imported under a new id — then add the new ones (ts + mi = the fallback key)
  var drop=new Set(); sel.forEach(function(r){ drop.add(r.id); if(r._mark) drop.add(r._mark.id); });
  var add=kind==='reset' ? [] : sel.map(function(r){
    var m={ id:r.id, lever:kind==='mark', ts:r.ts, mi:r.distMi!=null?Math.round(r.distMi*100)/100:null };
    if(kind==='mark') m.offload=Math.round(off*1e4)/1e4;
    return m;
  });
  var had=sel.filter(function(r){ return !!r._mark; }).length;
  var n=kind==='reset'?had:sel.length, runs=plural(n,'run');
  var msg=kind==='mark'?runs+' marked as Lever at '+fmtPct(100-off*100)+'% body weight':kind==='not'?runs+' marked as not Lever':runs+' reset to auto-detection';
  LV.sel.clear();
  var my=MOUNT;
  var saved=updateProfileList('runLeverMarks', function(list){ return list.filter(function(m){ return !(m&&drop.has(m.id)); }).concat(add); }, refresh, false);   // the dialog reports in its own #lvToast
  refresh();
  lvToast('✓ '+msg, true);
  saved.then(function(r){ if(r!==true && my===MOUNT) lvToast('⚠ Not saved ('+r+') — '+msg+' for now, but it will be undone on reload.', false); });
  var panel=topPanel(); if(panel && (!panel.contains(document.activeElement) || document.activeElement.disabled)) panel.focus();
}

/* ---------- import ----------
   Garmin = the account export (.zip); COROS = a .zip of .fit files (or one .fit). One path: candidate run
   docs → RunData.backfill (dedupe, Strava/Garmin copies replaced) → reload → status. Progress goes to the
   strip's status line and the import box's note; the final outcome is also toasted. One import at a time. */
function impStatus(html, done){
  ['importStatus','importNote'].forEach(function(id){ var e=$(id); if(e) e.innerHTML=html; });
  var st=$('importStatus'); if(done && st) toast(st.textContent, done==='err'?{kind:'err'}:null);
}
function readFile(f, extra){
  if(IMPORT_BUSY){ toast('An import is already running — wait for it to finish.'); return; }
  var name=String(f.name||'').toLowerCase();
  if(!/\.zip$|\.fit$/.test(name)){ impStatus('<span class="err">Unsupported file — drop a Garmin or COROS .zip or a single .fit file.'+(/\.csv$/.test(name)?' Activities.csv is no longer imported: use Garmin’s whole-history export (steps below).':'')+'</span>'+(extra||''),'err'); return; }
  setImportBusy(true); IMPORT_EXTRA=extra||'';
  impStatus('<span class="rdx-spin"></span>Reading '+esc(f.name)+'…');
  var rd=new FileReader();
  rd.onerror=function(){ impDone('<span class="err">Could not read file.'+(f.size>1e9?' This export may be too large to open in a browser — unzip it and drop the .zip files inside it one at a time.':'')+'</span>','err'); };
  rd.onload=function(){
    parseCorosArchive(rd.result, f.name, function(done,total,part,parts){
      impStatus('<span class="rdx-spin"></span>Parsing .fit files… '+done+'/'+total+(part?' (part '+part+' of '+parts+')':''));
    }).then(function(candidates){ saveCandidates(candidates); })
      .catch(function(e){ console.error(e); impDone('<span class="err">'+esc(corosErrMsg(e))+'</span>','err'); });
  };
  rd.readAsArrayBuffer(f);
}
function setImportBusy(on){
  IMPORT_BUSY=!!on;
  var d=$('drop'); if(d){ d.classList.toggle('busy',IMPORT_BUSY); if(IMPORT_BUSY) d.setAttribute('aria-disabled','true'); else d.removeAttribute('aria-disabled'); }
}
function impDone(html, kind){ var x=IMPORT_EXTRA; IMPORT_EXTRA=''; setImportBusy(false); impStatus(html+x, kind); }
function saveCandidates(candidates){
  if(!candidates||!candidates.length){ impDone('<span class="err">No running activities found in this file.</span>','err'); return; }
  impStatus('<span class="rdx-spin"></span>Saving '+plural(candidates.length,'run')+'…');
  var my=MOUNT, focusedDrop=!!($('drop')&&$('drop').contains(document.activeElement));
  backfill(candidates).then(function(res){
    return loadFromFirestore().then(function(){
      if(my!==MOUNT) return;
      renderLoaded();
      // a keyboard import from the onboarding card: the drop zone is gone, so focus the Data button
      if(focusedDrop && !$('drop')){ var b=$('btnData'); if(b) b.focus({preventScroll:true}); }
      var sample=candidates.filter(function(c){return c.ascentM!=null;})[0];
      var verify=sample?actCol().doc(sample.id).get().then(function(d){return d.exists&&d.data().ascentM!=null;}).catch(function(){ return null; }):Promise.resolve(null);
      verify.then(function(ok){
        var parts=[], stored=(res.updated||0)+(res.dupes||0); if(stored) parts.push(stored+' already stored'); if(res.replaced) parts.push(res.replaced+' Strava-synced replaced by watch data');
        if(res.replacedGarmin) parts.push(res.replacedGarmin+' sent by Garmin Connect replaced by this upload');
        var head=res.added? '✓ '+plural(res.added,'new run') : '✓ No new runs';
        impDone('<span class="ok">'+head+'</span>'+(parts.length?' · '+parts.join(' · '):''),'ok');
        if(ok===false) console.warn('RunDynamics: elevation did not persist — check Firestore rules', sample&&sample.id);
      });
    });
  }).catch(function(e){
    console.error(e);
    impDone('<span class="err">Save failed: '+esc(e&&e.code||e&&e.message||e)+'</span>','err');
  });
}
// Backfill = the daily Strava gap-fill without the 2-year cutoff (the server pages the whole history, 200
// activities per request, and skips stored runs). The callable gets the function's own 300 s timeout.
function stravaBackfill(btn){
  if(DEMO || BACKFILL_BUSY || !(window.firebase && firebase.functions)) return;
  btn.disabled=true; BACKFILL_BUSY=true;
  impStatus('<span class="rdx-spin"></span>Backfilling from Strava — fetching the full activity history, this can take a minute…');
  var a=syncActor(), payload={backfill:true}; if(a.real && a.real!==UID) payload.athleteUid=UID;   // act for the athlete shown, never the caller by accident
  firebase.functions().httpsCallable('syncStravaActivities',{timeout:300000})(payload).then(function(res){
    var d=(res&&res.data)||{};
    return loadFromFirestore().then(function(){
      renderLoaded();
      impStatus('<span class="ok">✓ '+(d.runDocs||0)+' Strava runs added</span> · '+(d.runSkipped||0)+' already stored or covered by watch imports'+
        (d.rateLimited?' · <span class="err">Strava’s rate limit paused the fetch — run backfill again in ~15 minutes to pull the rest</span>':''), 'ok');
    });
  }).catch(function(e){
    console.error(e);
    impStatus('<span class="err">Backfill failed: '+esc(e&&e.message||e)+'</span>','err');
  }).then(function(){ BACKFILL_BUSY=false; var b=$('stravaBackfill'); if(b) b.disabled=false; });
}
function confirmDeleteAll(btn){
  var nGarmin=RAW.filter(function(r){ return r.source==='garmin'; }).length;
  if(!confirm('Delete ALL of '+who()+' stored run history ('+plural(RAW.length,'run')+')?\n\n'+
    'This clears every imported activity so a fresh export can be re-imported clean — '+
    'use it if a bad activity got stuck in an earlier upload. '+
    'Settings, logged events, dismissed gaps and Lever marks are kept.'+
    (RD.sync.connected?'\n\nStrava-synced runs come back automatically within a day.':'')+
    (nGarmin?'\n\n'+nGarmin+(nGarmin===1?' run':' runs')+' sent by Garmin Connect '+(nGarmin===1?'is':'are')+' deleted too, and Garmin Connect won’t send '+(nGarmin===1?'it':'them')+' again.':'')+
    '\n\nThis cannot be undone.')) return;
  if(DELETING) return;
  btn.disabled=true; DELETING=true;
  var n0=RAW.length;
  impStatus('<span class="rdx-spin"></span>Deleting '+plural(n0,'stored run')+'…');
  deleteAllRuns().then(function(n){
    RAW=[]; LAYER.sheet=null; LAYER.modal=null;
    renderLoaded();
    impStatus('<span class="ok">✓ '+plural(n,'run')+' deleted</span> · import an export below to start fresh.','ok');
    var hd=$('rdxStrip'), h=$('emptyHd'); if(hd) smoothScroll(hd); if(h) h.focus({preventScroll:true});
  }).catch(function(e){
    console.error(e);
    // a mid-way batch failure leaves a partial history: reload so the view shows what actually remains
    return loadFromFirestore().then(renderLoaded).catch(function(){}).then(function(){
      impStatus('<span class="err">Delete failed: '+esc(e&&e.code||e&&e.message||e)+'</span>','err');
    });
  }).then(function(){ DELETING=false; var b=$('resetData'); if(b) b.disabled=false; });
}

/* ---------- no runs yet ---------- */
function renderEmpty(){
  var el=$('sec-empty'); if(!el) return;
  el.innerHTML='<div class="rdx-card rdx-empty-card">'+
    '<h2 class="rdx-sec-title" id="emptyHd" tabindex="-1">Import '+who()+' run history to get started</h2>'+
    (VIEW==='injury'?'<p class="rdx-pat-lead">Injury patterns need about 10 weeks of run history. After importing, log past overuse injuries and illnesses here to see what training looked like before each.</p>':'')+
    '<p class="rdx-sec-sub">'+(ROLE==='coach'
      ? 'Drop a Garmin or COROS export below, or ask this athlete to connect Strava from their coaching dashboard — recent runs then fill in automatically.'
      : 'Drop a Garmin or COROS export below, or connect Strava from the <a href="/coaching/">coaching dashboard</a> and recent runs fill in automatically.')+'</p>'+
    importHTML(ROLE!=='coach' && VIEW==='training')+'</div>';
}

/* ---------- About these numbers (both views: it carries the Strava attribution) ---------- */
function renderAbout(){
  var sec=$('sec-about'); if(!sec) return;
  var nStrava=RAW.filter(function(r){return r.source==='strava';}).length;
  sec.innerHTML='<div class="rdx-sec-hd"><div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="aboutHd">About these numbers</h2></div></div>'+
    '<details class="rdx-more" id="loadMethodBox" data-ui="aboutOpen"'+(UI.aboutOpen?' open':'')+'><summary data-f="aboutsum">How Impact Load (IAD) is calculated — equation, variables &amp; sources</summary><div class="rdx-more-body">'+(window.RunLoad?RunLoad.methodologyHTML():'')+'</div></details>'+
    '<p class="rdx-foot">'+
      (nStrava?nStrava+' synced from Strava for runs with no watch import — Strava runs carry pace, distance, heart rate, cadence and ascent but no ground contact or oscillation; outdoor Strava runs are scored as if they came back down what they climbed, and treadmill runs take no hill surcharge. ':'')+
      'Track distances are converted from meters to miles.'+
      // Strava attribution (API terms): the official mark shows whenever Strava runs do — white on dark, orange on light
      (nStrava?'<span class="rdx-strava"><img class="rdx-strava-w" src="/images/strava/api_logo_pwrdBy_strava_horiz_white.svg" alt="Powered by Strava"><img class="rdx-strava-o" src="/images/strava/api_logo_pwrdBy_strava_horiz_orange.svg" alt="Powered by Strava"></span>':'')+'</p>';
}

/* ---------- rendering ---------- */
function refresh(){
  if(!ROOT) return;
  if(!RAW.length){ renderLayer(); renderStrip(); return; }
  annotate();
  LOAD_PARAMS=computeLoadParams();
  withFocus(function(){
    renderStrip();
    if(VIEW==='training'){ renderDemoBar(); renderHero(); renderLoadSec(); renderFormSec(); }
    renderAbout();
  });
  if(VIEW==='injury') renderInjury();
  renderLayer();
  renderGarminCredit();
  var pe=$('profileErr'); if(pe){ pe.hidden=!RD.profileErr; pe.textContent=RD.profileErr?'⚠ Settings and logged events didn’t load ('+RD.profileErr+') — showing defaults, and changes are blocked until you reload.':''; }
}
// After runs (re)load: the empty state or the sections, then everything from state.
function renderLoaded(){
  RunData.remember(RAW);
  var has=RAW.length>0, main=$('secMain'), empty=$('sec-empty');
  if(main) main.hidden=!has;
  if(empty){ empty.hidden=has; if(has) empty.innerHTML=''; else renderEmpty(); }
  if(!has){ LAYER.sheet=null; LAYER.modal=null; refresh(); return; }
  if(!UI.from||!UI.to||UI.range!=='custom') setRange(UI.range);
  if(UI.period==='custom' && (!UI.aFrom||!UI.aTo)){ var t=new Date(); UI.aTo=ymd(t); UI.aFrom=ymd(new Date(t.getTime()-89*DAY)); }
  refresh();
}

/* ---------- one set of handlers on the mount container (it outlives remounts: wired once) ---------- */
function wireRoot(root){
  if(root._rdxWired) return; root._rdxWired=true;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  // focus can sit on <body> (a re-render under it, a click on the scrim): Escape and the Tab trap still apply
  if(!DOC_KEYS){ DOC_KEYS=true; document.addEventListener('keydown', function(e){ if(ROOT && (LAYER.sheet||LAYER.modal) && !ROOT.contains(e.target)) onKey(e); }); }
  root.addEventListener('toggle', onToggle, true);   // <details> toggles don't bubble; capture sees them
  root.addEventListener('mousedown', function(e){ root._downOv=e.target.getAttribute&&e.target.getAttribute('data-ov'); });
  root.addEventListener('dragover', function(e){ var d=e.target.closest&&e.target.closest('#drop'); if(d){ e.preventDefault(); d.classList.add('over'); } });
  root.addEventListener('dragleave', function(e){ var d=e.target.closest&&e.target.closest('#drop'); if(d) d.classList.remove('over'); });
  root.addEventListener('drop', function(e){ var d=e.target.closest&&e.target.closest('#drop'); if(!d) return; e.preventDefault(); d.classList.remove('over'); takeFiles(e.dataTransfer.files); });
}
function takeFiles(files){ var f=files&&files[0]; if(f) readFile(f, files.length>1?' · only the first file was imported — drop the others one at a time':''); }
function onToggle(e){
  var d=e.target, k=d.getAttribute&&d.getAttribute('data-ui'); if(!k || !(k in UI)) return;
  UI[k]=d.open;
}
function onClick(e){
  var ov=e.target.getAttribute&&e.target.getAttribute('data-ov');
  if(ov && ROOT._downOv===ov){ closeTop(); return; }   // a press that started AND ended on the scrim
  var b=e.target.closest&&e.target.closest('[data-act]'); if(!b || !ROOT.contains(b) || b.disabled) return;
  var act=b.getAttribute('data-act'), k=b.getAttribute('data-k'), kbd=e.detail===0;
  switch(act){
    case 'open-data': openSheet('data'); break;
    case 'open-settings': openSheet('settings', /^(patsettings|scopesettings)$/.test(b.getAttribute('data-f')||'')?'#sMinDist':null); break;
    case 'open-import': case 'import-newer': openSheet('data','#drop'); break;
    case 'sheet-close': closeSheet(); break;
    case 'modal-close': if(LAYER.modal==='event') closeEvForm(true); else closeModal(); break;
    case 'gaps-jump': UI.gapsOpen=true; renderInjury(); var g=$('rdxGaps'); if(g){ smoothScroll(g); var h=$('rdxGapsHd'); if(h) h.focus({preventScroll:true}); } break;
    case 'demo': DEMO=k||null; withFocus(function(){ renderHero(); renderDemoBar(); }); break;
    case 'hero-help': UI.heroHelp=!UI.heroHelp; b.setAttribute('aria-expanded',String(UI.heroHelp)); var hh=$('heroHelp'); if(hh) hh.hidden=!UI.heroHelp; break;
    case 'range': var r=b.getAttribute('data-r'); setRange(r); withFocus(renderLoadSec); if(r==='custom'){ var tf=$('tFrom'); if(tf) tf.focus(); } break;
    case 'how-iad': UI.aboutOpen=true; var mb=$('loadMethodBox'); if(mb){ mb.open=true; smoothScroll(mb); mb.querySelector('summary').focus({preventScroll:true}); } break;
    case 'log-event': openEvForm({ where:'dialog' }); break;
    case 'scope-toggle': UI.scopeOpen=!UI.scopeOpen; withFocus(renderFormSec); break;
    case 'type': var t=b.getAttribute('data-t'), off=includedPref().off.slice(), i=off.indexOf(t); if(i<0) off.push(t); else off.splice(i,1); saveIncluded({ off:off }); break;
    case 'filters-reset': saveIncluded({ off:[], intensity:FILTER_DEFAULTS.intensity }, 'Filters reset'); break;
    case 'disp': UI[k]=!UI[k]; withFocus(renderFormSec); break;
    case 'sb-older': UI.sbMore=!UI.sbMore; Array.prototype.forEach.call($all('.rdx-sb-old'),function(c){ c.hidden=!UI.sbMore; }); b.textContent=moreTxt(UI.sbMore,$all('.rdx-sb-old').length); b.setAttribute('aria-expanded',String(UI.sbMore)); break;
    case 'also-all': UI.alsoAll=!UI.alsoAll; Array.prototype.forEach.call($all('.rdx-also-old'),function(c){ c.hidden=!UI.alsoAll; }); b.textContent=UI.alsoAll?'Show fewer':'Show all'; b.setAttribute('aria-expanded',String(UI.alsoAll)); break;
    case 'note-more': var n=b.previousElementSibling, open=n.classList.toggle('is-open'); b.textContent=open?'less':'more'; b.setAttribute('aria-expanded',String(open)); break;
    case 'logpast': openEvForm({ where:'past', type:'injury' }); break;
    case 'go-events': var ev=$('sec-events'); if(ev){ smoothScroll(ev); $('evHead').focus({preventScroll:true}); } break;
    case 'gap-log': var d=GAP_DROPS[+b.getAttribute('data-i')]; if(d) openEvForm({ where:'gap', t0:d.t0, start:ymd(new Date(d.t0)), end:d.ongoing?'':ymd(new Date(d.t1)) }); break;
    case 'gap-dismiss': dismissGap(+b.getAttribute('data-i'), e); break;
    case 'dis-tog': UI.disOpen=!UI.disOpen; var l=$('rdxDisList'); if(l) l.hidden=!UI.disOpen; b.textContent=UI.disOpen?'hide':'show'; b.setAttribute('aria-expanded',String(UI.disOpen)); break;
    case 'dis-restore': restoreGap(+b.getAttribute('data-i'), e); break;
    case 'ev-new': if(EVF&&EVF.where==='list'&&EVF.editId==null){ closeEvForm(true); } else openEvForm({ where:'list' }); break;
    case 'ev-edit': var id=b.getAttribute('data-id'), ex=events().filter(function(x){ return String(x.id)===id; })[0]; if(!ex) break;
      if(EVF&&EVF.editId===id){ closeEvForm(true); break; }
      openEvForm({ where:'list', editId:id, type:EV_META[ex.type]?ex.type:'race', start:ymd(new Date(ex.ts)), end:(ex.endTs!=null&&ex.type!=='race')?ymd(new Date(ex.endTs)):'', note:ex.note||'' }); break;
    case 'ev-del': evDelete(b.getAttribute('data-id'), kbd); break;
    case 'ev-more': UI.evMore=!UI.evMore; withFocus(renderEventsSec); break;
    case 'ev-cancel': closeEvForm(true); break;
    case 'ev-save': evFormSave(kbd); break;
    case 'pick-file': if(IMPORT_BUSY){ toast('An import is already running — wait for it to finish.'); break; } var fi=$('file'); if(fi) fi.click(); break;
    case 'backfill': stravaBackfill(b); break;
    case 'exclude': var rr=RAW.filter(function(x){ return String(x.id)===b.getAttribute('data-id'); }); if(rr.length) excludeRuns(rr); break;
    case 'exclude-all': excludeRuns(badRuns()); break;
    case 'include-all': var exr=RAW.filter(function(x){ return x._excl; }); setExcluded([], exr, 'Included '+plural(exr.length,'run')+' again.', function(){ setExcluded(exr, [], 'Excluded '+plural(exr.length,'run')+' again.'); }); break;
    case 'nopace-tog': UI.noPaceOpen=!UI.noPaceOpen; renderLayer(); break;
    case 'lv-open': if(lvRuns().length) openModal('lever'); break;
    case 'lv-filter': LV.filter=k; renderLeverList(); var nb=ROOT.querySelector('[data-f="lvf'+k+'"]'); if(nb) nb.focus(); break;
    case 'lv-apply': lvApply(k); break;
    case 'delete-all': confirmDeleteAll(b); break;
  }
}
function excludeRuns(runs){ var n=plural(runs.length,'run');
  setExcluded(runs, [], 'Excluded '+n+' — no longer counted in load or metrics.', function(){ setExcluded([], runs, 'Included '+n+' again.'); }); }
function onChange(e){
  var t=e.target, id=t.id;
  if(id==='file'){ takeFiles(t.files); t.value=''; return; }
  if(/^s(Device|Weight|Easy|Cutoff|MinDist)$/.test(id)){ settingsChange(id, t.value); return; }
  if(id==='sAccessory'){ persist({ runHasAccessory:t.checked }); refresh(); return; }
  if(id==='tFrom'||id==='tTo'){ UI[id==='tFrom'?'from':'to']=t.value; UI.range='custom';
    var tf=$('tFrom'), tt=$('tTo'); if(id==='tFrom') tt.min=t.value; else tf.max=t.value; fieldOk(tf); fieldOk(tt);
    var a=parseDate(UI.from), z=parseDate(UI.to); if(a&&z&&dayEnd(z).getTime()<a.getTime()){ t.classList.add('rdx-df-err'); t.setAttribute('aria-invalid','true'); }
    renderLoadChart(); return; }
  if(id==='fPeriod'){ UI.period=t.value; if(t.value==='custom' && (!UI.aFrom||!UI.aTo)){ var now=new Date(); UI.aTo=ymd(now); UI.aFrom=ymd(new Date(now.getTime()-89*DAY)); } withFocus(renderFormSec); return; }
  if(id==='fCmp'){ UI.cmp=t.value; if(t.value==='custom' && (!UI.bFrom||!UI.bTo)){ var a0=parseDate(UI.aFrom)||new Date(); UI.bTo=ymd(new Date(a0.getTime()-DAY)); UI.bFrom=ymd(new Date(a0.getTime()-90*DAY)); } withFocus(renderFormSec); return; }
  if(/^(aFrom|aTo|bFrom|bTo)$/.test(id)){ UI[id]=t.value; refreshFormData(id); return; }
  if(id==='fIntensity'){ saveIncluded({ intensity:t.value }); return; }
  if(id==='trMetric'){ UI.metric=t.value; if(UI.metric2===UI.metric) UI.metric2=''; withFocus(renderFormSec); return; }
  if(id==='trMetric2'){ UI.metric2=t.value; withFocus(renderFormSec); return; }
  if(id==='evType' && EVF){ EVF.type=t.value; if(t.value==='race') EVF.end=''; EVF.err=''; if(LAYER.modal==='event') renderLayer(); else renderInjury(); return; }
  if(id==='lvOff'){ lvSaveDefault(); return; }
  if(id==='lvDef'){ lvSaveDefault(); return; }
  if(t.classList.contains('rdx-lv-all')){ if(t.checked) LV.rows.forEach(function(r){ LV.sel.add(r.id); }); else LV.sel.clear(); lvSync(); return; }
  if(t.classList.contains('rdx-lv-cb')){ var r=LV.rows[+t.getAttribute('data-i')]; if(r){ if(t.checked) LV.sel.add(r.id); else LV.sel.delete(r.id); } lvSync(); }
}
function onInput(e){
  var t=e.target, id=t.id;
  if(EVF && (id==='evStart'||id==='evEnd'||id==='evNote')){ EVF[{evStart:'start',evEnd:'end',evNote:'note'}[id]]=t.value; if(id!=='evNote') evFormClearErr(); return; }
  if(/^s(Weight|Easy|Cutoff|MinDist)$/.test(id)) fieldOk(t);
  if(id==='lvOff') lvSync();
}
function onKey(e){
  if(e.key==='Tab' && (LAYER.modal||LAYER.sheet)){ trapTab(e); return; }
  if(e.key==='Escape'){
    if(EVF && EVF.where!=='dialog' && $('evForm') && $('evForm').contains(e.target)){ e.stopPropagation(); closeEvForm(true); return; }
    if(LAYER.modal||LAYER.sheet){ e.preventDefault(); e.stopPropagation(); if(LAYER.modal==='event') closeEvForm(true); else closeTop(); }
    return;
  }
  if(e.key==='Enter' && e.target.id==='evNote'){ e.preventDefault(); evFormSave(true); return; }
  if((e.key==='Enter'||e.key===' ') && e.target.id==='drop'){ e.preventDefault(); e.target.click(); }
}

/* ---------- Strava auto-sync ----------
   Once the runs are loaded: the athlete themself (or the real admin acting as them), at most once an hour
   (RunData.syncStrava decides). The coach view skips it: the coaching page runs its own athlete-scoped sync. */
function maybeSyncStrava(){
  if(ROLE==='coach' || DEMO) return;
  var container=ROOT, my=MOUNT;
  RunData.syncStrava().then(function(r){
    if(!r || ROOT!==container || my!==MOUNT) return;
    if(!r.runDocs){ renderStrip(); return; }
    return loadFromFirestore().then(function(){ if(ROOT===container && my===MOUNT) renderLoaded(); });
  }).catch(function(e){ console.warn('RunDynamics: Strava sync failed', e); });
}

/* ---------- charts follow their box's width ---------- */
// Debounced 150ms; only a ≥8px width change redraws, so a redraw's own height change can't loop.
function watchSize(container){
  var cb=function(){ clearTimeout(RO_T); RO_T=setTimeout(function(){
    if(ROOT!==container || !RAW.length) return;
    var lb=$('loadBox'), tb=$('trendBox');
    if(lb && Math.abs(lb.clientWidth-(CHART_W.loadBox||0))>=8) renderLoadChart();
    if(tb && Math.abs(tb.clientWidth-(CHART_W.trendBox||0))>=8) renderTrendChart(periodRanges());
  },150); };
  if(window.ResizeObserver){ RO=new ResizeObserver(cb); RO.observe(container); }
  else { RO={ disconnect:function(){ window.removeEventListener('resize',cb); } }; window.addEventListener('resize',cb); }
}

/* ---------- public entry point ---------- */
function mount(container, opts){
  opts=opts||{};
  if(RO){ RO.disconnect(); RO=null; }
  clearTimeout(RO_T); CHART_W={};
  if(!container || !opts.db || !opts.uid){
    if(container) container.innerHTML='<div class="rdx rdx-empty">Training Analysis: missing db/uid.</div>';
    return;
  }
  injectCSS();
  if(ROOT && UID && RAW.length){ VIEWSTATE[UID]=JSON.parse(JSON.stringify(UI)); VIEWSTATE[UID].__sheet=LAYER.sheet; }   // the athlete we're leaving
  ROOT=container; DB=opts.db; UID=opts.uid; ROLE=opts.role||'athlete'; ADMIN=!!opts.admin; DEMO=null;
  VIEW=opts.view==='injury'?'injury':'training';
  var my=++MOUNT; RunData.open({ db:DB, uid:UID, notify:toast, onRevert:onRevertKey });
  UI=Object.assign(uiDefaults(), VIEWSTATE[UID]||{}); var reopen=UI.__sheet||null; delete UI.__sheet;
  EVF=null; LAYER={sheet:null, modal:null, trigger:null, modalTrigger:null}; LV={filter:'all', sel:new Set(), rows:[], toastT:null};
  DIS_T=0; DIS_SEQ=0; DIS_STATUS=[]; GAP_DROPS=[]; clearTimeout(TOAST_T); TOAST_BACK=null; IMPORT_BUSY=false; IMPORT_EXTRA='';
  RAW=[]; LOAD_PARAMS=null;
  container.classList.add('rdx');
  container.innerHTML=shellHTML();
  wireRoot(container);
  watchSize(container);
  var st=$('importStatus'), cache=RD.cache[UID];
  if(cache && cache.raw.length){
    // the last data for this athlete, at once (no blank shell; the host keeps its scroll) — refetched below
    RAW=cache.raw; RD.profile=Object.assign({},cache.profile); RD.stravaLever=cache.lever||[]; RD.sync=cache.sync||{};
    try{ renderLoaded(); }catch(e){ console.warn('RunDynamics: cached render failed',e); cache=null; }
  } else cache=null;
  if(st && !cache) st.innerHTML='<span class="rdx-spin"></span>Loading stored runs…';
  Promise.all([loadProfile(), loadFromFirestore(), fetchStravaLever()]).then(function(){
    if(ROOT!==container || my!==MOUNT) return;   // a newer mount superseded this one
    if(st) st.innerHTML='';
    renderLoaded();
    if(reopen && RAW.length && !LAYER.sheet) openSheet(reopen);   // a sheet open before a tab or athlete switch opens again
    maybeSyncStrava();
  }).catch(function(e){
    console.error(e);
    if(st && my===MOUNT) st.innerHTML='<span class="err">Could not load stored runs: '+esc(e&&e.message||e)+'</span>';
  });
}
/* Re-read the stored runs + profile of the mounted athlete and re-render in place (no remount), e.g. after
   the coaching page's own Strava sync added runs. No-op unless uid is the athlete on screen; a remount or
   athlete switch in the meantime wins. Everything chosen on screen stays (it lives in UI). */
function reload(uid){
  if(!ROOT || !uid || uid!==UID) return Promise.resolve(false);
  var my=MOUNT, container=ROOT;
  return Promise.all([loadProfile(), loadFromFirestore()]).then(function(){
    if(ROOT!==container || my!==MOUNT) return false;
    renderLoaded();
    return true;
  }).catch(function(e){ console.warn('RunDynamics: reload failed', e); return false; });
}
/* Drop the data remembered for uid's instant re-render (e.g. runs of theirs were deleted elsewhere), so
   their next mount shows only what is stored. */
function forget(uid){ RunData.forget(uid); }
window.RunDynamics = { mount: mount, reload: reload, forget: forget };
})();
