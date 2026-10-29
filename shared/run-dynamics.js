// ════════════════════════════════════════════════════════════════
// shared/run-dynamics.js
//
// The ONE Run Dynamics view. Both the standalone /running-dynamics/
// page and the coaching dashboard's "Training Analysis" and "Injury
// Patterns" tabs mount this — there is no second copy. Imports a Garmin Connect activities export
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
//   RunDynamics.mount(containerEl, { db, uid, role, view, title, sub })
//     db    : firebase firestore instance
//     uid   : the athlete whose data to show / write
//     role  : 'athlete' (self) | 'coach' (viewing an athlete) — copy only
//     view  : 'training' (Today, load chart, form & volume) | 'injury'
//             (injury & illness history, training gaps). Both keep the
//             header strip, Data & settings, and About these numbers.
//     title : optional heading shown above the tool (standalone page)
//     sub   : optional sub-line under the title
//
// Metric/load math lives in run-load-model.js; the math is identical
// across both surfaces because there is only one renderer.
//
// Athlete annotations live on the USER doc — runEvents, runDismissedDrops
// (drops marked "not a setback"), runLeverMarks (hand-marked Lever runs +
// offload) — never on activity docs, which the importer and the daily
// Strava sync rewrite wholesale.
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
.rdx{font-family:var(--ui,'Inter',system-ui,sans-serif);color:var(--text);font-size:14px;line-height:1.5}
.rdx *{box-sizing:border-box}
.rdx [hidden]{display:none!important}
.rdx :focus-visible{outline:2px solid var(--accent-ink,var(--cyan));outline-offset:2px}
.rdx{--rdx-good-ink:var(--good-ink,var(--good));--rdx-warn-ink:var(--warn-ink,var(--warn));--rdx-bad-ink:var(--bad-ink,var(--bad));--rdx-gold-ink:var(--gold-ink,var(--gold,#f5c842));--rdx-accent-ink:var(--accent-ink,var(--cyan));
  --rdx-s1:var(--rdx-accent-ink);--rdx-s2:var(--purple-ink,var(--purple,#8b7cf8));--rdx-hot:var(--rdx-gold-ink);--rdx-spike:var(--rdx-bad-ink);
  --rdx-band:color-mix(in srgb,var(--good,#22c78a) 16%,transparent);--rdx-band-line:color-mix(in srgb,var(--good,#22c78a) 30%,transparent);
  --rdx-inset:0px}
/* text inks (light-mode --*-ink, --muted2 #8590ae in dark) come from /shared/site.css; the view no longer overrides them */
.rdx-h1{font-size:22px;font-weight:800;letter-spacing:-.3px;margin:0 0 4px}
.rdx-sub{font-size:13px;color:var(--muted2);max-width:760px;line-height:1.6;margin:0}
.rdx-sub code{font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--border);border-radius:var(--r-sm,6px);padding:1px 6px;color:var(--text)}
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
.rdx-inl{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--muted2);white-space:nowrap}
.rdx-df-err{border-color:var(--bad)!important}
.rdx-field-err{font-weight:600;color:var(--rdx-bad-ink)}
/* label + ⓘ on one 16px line (the 24px button overflows it, so the row keeps the label's height) */
.rdx-lblrow{display:flex;align-items:center;gap:6px;height:16px;position:relative}
.rdx-lblrow>label{font-size:12px;font-weight:600;color:var(--muted2);line-height:1.3}
.rdx-tip-btn{position:relative;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;font:700 12px/1 var(--ui);color:var(--muted2);background:transparent;border:1px solid var(--border2);border-radius:50%;cursor:pointer;vertical-align:middle}
.rdx-tip-btn:hover,.rdx-tip-btn[aria-expanded="true"]{color:var(--text);border-color:var(--muted2)}
.rdx-tip-wrap{position:relative;display:inline-flex;align-items:center}
.rdx-tip{position:absolute;top:calc(100% + 6px);left:0;z-index:60;width:max-content;max-width:min(280px,calc(100vw - 32px));padding:8px 10px;font:400 12px/1.45 var(--ui);color:var(--text);background:var(--panel2);border:1px solid var(--border2);border-radius:8px;box-shadow:var(--shadow-pop,0 8px 32px rgba(0,0,0,.45));white-space:normal;text-align:left}
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

/* 0. header strip */
.rdx-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;margin-top:16px;scroll-margin-top:72px}
.rdx-status{flex:1 1 320px;min-width:0;font-size:13px;color:var(--muted2);line-height:1.5}
.rdx-status .ok,.rdx-imp-note .ok{color:var(--rdx-good-ink)}
.rdx-status .err,.rdx-imp-note .err{color:var(--rdx-bad-ink)}
.rdx-status .warn{color:var(--rdx-warn-ink)}
.rdx-flags{margin:10px 0 0;padding:8px 12px;font-size:13px;line-height:1.5;color:var(--text);background:var(--panel);border:1px solid var(--border2);border-left:3px solid var(--rdx-warn-ink);border-radius:8px}
.rdx-flags-k{font-weight:600;color:var(--rdx-warn-ink)}
.rdx-flags .rdx-linkbtn{font-size:inherit;font-weight:600;color:var(--rdx-accent-ink)}
.rdx #importStatus:not(:empty)::before{content:"·";margin:0 7px}
.rdx #rdxFresh:empty+#importStatus::before{content:none}
.rdx-head-acts{display:flex;gap:8px;flex-shrink:0}

/* 1. Data & settings panel */
/* Profile + What's included share a row once the panel is ≥900px wide (2×444 + 12 gap): flex-basis does it
   from the panel's own width — no size container, which (like containment on ROOT) would trap fixed overlays */
.rdx-settings{margin-top:12px;background:var(--panel);border:1px solid var(--border);border-radius:12px;animation:rdx-fade .25s}
/* one sheet: a row per group, its name in a narrow left column, its controls in one wrapping row;
   explanations live in title tooltips, the long lists behind one-line toggles */
.rdx-group{display:grid;grid-template-columns:118px minmax(0,1fr);gap:8px 16px;align-items:start;padding:14px 18px;border-top:1px solid var(--border);scroll-margin-top:72px}
.rdx-group:first-child{border-top:none}
.rdx-group-hd{font-size:13px;font-weight:600;color:var(--text);margin:0;line-height:1.3;padding-top:9px}
.rdx-group:not(#set-events)>.rdx-group-hd{padding-top:27px}   /* level with the inputs under their 18px labels */
.rdx-group-main{display:flex;flex-direction:column;gap:8px;min-width:0}
.rdx-group-body{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:flex-end}
.rdx-ev-form{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center}
.rdx-ev-form .rdx-ev-note-in{flex:1 1 200px;min-width:0}
.rdx-ev-end{display:inline-flex;align-items:center;gap:8px}
.rdx-ev-to{font-size:12px;color:var(--muted2);white-space:nowrap}
.rdx-ev-hint{font-size:13px;color:var(--muted2);margin:0;line-height:1.55}
.rdx-ev-hint .rdx-linkbtn,.rdx-ev-logged .rdx-linkbtn{font-size:inherit;white-space:nowrap}
.rdx-ev-logged{font-size:12px;color:var(--muted2)}
.rdx-ev-logged .rdx-events{margin-top:4px;max-width:760px}
.rdx-wtl-box{max-width:620px}
.rdx-wtl-box .rdx-lbl{display:none}   /* the toggle already says "What to log" */
.rdx-wtl{font-size:13px;color:var(--muted2);line-height:1.55}
.rdx-wtl ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:3px}
.rdx-wtl li{display:flex;align-items:baseline;gap:8px}
.rdx-wtl li .rdx-ev-dot{transform:translateY(-1px)}
.rdx-wtl b{color:var(--text);font-weight:600;white-space:nowrap}
.rdx-wtl p{margin:6px 0 0}
.rdx-events{display:flex;flex-direction:column;margin-top:4px}
.rdx-ev-empty{font-size:12px;color:var(--muted2);margin:0;padding:6px 0}
.rdx-ev-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;padding:2px 0;border-bottom:1px solid var(--border);font-size:13px}
.rdx-ev-row:last-child{border-bottom:none}
.rdx-ev-pick{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;min-height:32px;padding:2px 6px;margin-left:-6px;background:transparent;border:none;border-radius:8px;font:inherit;color:inherit;text-align:left;cursor:pointer}
.rdx-ev-pick:hover{background:var(--hover)}
.rdx-ev-row.editing .rdx-ev-pick{background:var(--accent-wash);box-shadow:inset 2px 0 0 var(--rdx-accent-ink)}
.rdx-ev-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.rdx-ev-type{font-weight:600;color:var(--text);white-space:nowrap}
.rdx-ev-when{color:var(--muted2);white-space:nowrap}
.rdx-ev-note{flex:1 1 180px;min-width:0;color:var(--text);overflow-wrap:anywhere}
.rdx-ev-del{margin-left:auto;flex-shrink:0;width:32px;height:32px;background:transparent;border:none;border-radius:8px;color:var(--muted2);font-family:inherit;font-size:13px;cursor:pointer}
.rdx-ev-del:hover{color:var(--rdx-bad-ink);background:var(--hover)}
.rdx-lv-hint{font-size:12px;color:var(--muted2);line-height:1.4}
.rdx-import{display:flex;flex-direction:column;gap:12px}
.rdx-import-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.rdx-drop{flex:1 1 280px;border:1.5px dashed var(--border2);border-radius:8px;padding:16px 18px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
.rdx-drop:hover,.rdx-drop.over{border-color:var(--accent-ink,var(--cyan));background:var(--accent-wash,rgba(0,229,200,.08))}
.rdx-drop b{font-size:14px;font-weight:600;color:var(--text)}
.rdx-drop span{font-size:12px;color:var(--muted2);display:block;margin-top:2px}
.rdx-filenote{font-size:12px;color:var(--muted2);margin:0}
.rdx-imp-note{margin:0;font-size:13px;line-height:1.5;color:var(--muted2)}
.rdx-imp-note:empty,.rdx #importHome .rdx-imp-note{display:none}   /* onboarding card: the header status sits right above it */
.rdx-data-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px}
.rdx-data-foot .rdx-btn-danger{margin-left:auto}
#importSlot .rdx-import{gap:6px}
#importSlot .rdx-drop{padding:8px 14px;text-align:left}   /* in the sheet the drop zone is one line; the onboarding card keeps it big */
#importSlot .rdx-drop span{display:inline;margin:0 0 0 8px}
#importSlot .rdx-more>summary{padding:2px 0;font-size:12px;font-weight:600;color:var(--muted2)}

/* sections */
.rdx-section{display:none;margin-top:36px}
.rdx-section,.rdx-more,.rdx #rdxGaps{scroll-margin-top:72px}   /* clear the sticky site nav (58px) */
.rdx-section.show{display:block;animation:rdx-fade .3s}
.rdx #sec-hero,.rdx #sec-empty{margin-top:16px}
.rdx-sec-hd{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 20px;margin-bottom:12px}
.rdx-sec-hd-txt{flex:1 1 320px;min-width:0}
.rdx-sec-title{font-family:var(--ui);font-size:17px;font-weight:700;letter-spacing:-.2px;line-height:1.3;color:var(--text);margin:0}
.rdx-sec-title:focus{outline:none}
.rdx-sec-sub{font-size:13px;line-height:1.5;color:var(--muted2);max-width:760px;margin:3px 0 0}
.rdx-garmin-credit{font-size:12px;line-height:1.4;color:var(--muted2);margin:4px 0 0}
.rdx #gcHero .rdx-garmin-credit{margin:0 0 8px}   /* above the Today card, not under a title line */
.rdx-modal-intro .rdx-garmin-credit{margin:0 0 4px}
.rdx #gcSet .rdx-garmin-credit{margin:0;padding:12px 18px 0}   /* atop Data & settings, in line with its groups */
.rdx-gc-grp{flex-basis:100%}   /* a settings group's credit: its own row over the group's controls */
.rdx-gc-grp:empty{display:none}   /* no Garmin runs: no empty row or gap */
.rdx-gc-grp .rdx-garmin-credit{margin:0}
.rdx-sec-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.rdx-sub-hd{font-size:14px;font-weight:600;color:var(--text);margin:22px 0 10px}
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
.rdx-cmpbar{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;margin-bottom:14px}
.rdx-cmpbar>.rdx-chip{min-height:36px}
.rdx-cmp-ranges{display:flex;flex-wrap:wrap;gap:12px 24px}
.rdx-cmp-dates{display:flex;align-items:center;gap:6px}
.rdx-cmp-dates>span{color:var(--muted2)}

/* 3. chart */
.rdx-seg{display:inline-flex;gap:2px;padding:2px;background:var(--panel2);border:1px solid var(--border2);border-radius:9px}
.rdx-seg button{min-height:30px;padding:0 12px;font:inherit;font-size:12px;font-weight:600;color:var(--muted2);background:transparent;border:1px solid transparent;border-radius:7px;cursor:pointer;white-space:nowrap}
.rdx-seg button:hover{color:var(--text)}
.rdx-seg button.on{background:var(--panel);border-color:var(--border2);color:var(--rdx-accent-ink)}
.rdx-chart-row2{display:flex;flex-wrap:wrap;gap:0 16px;align-items:flex-end}
.rdx-custom{display:flex;gap:12px}
.rdx-chart-row2>*{margin-bottom:12px}
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

/* 5. form & volume: 4 tiles a row (2 on phones), then the volume table */
.rdx-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.rdx-tile{min-width:0;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.rdx-tile-lbl{font-size:12px;font-weight:600;line-height:1.3;color:var(--muted2)}
.rdx-tile-val{font-size:24px;font-weight:700;font-family:var(--mono);margin-top:8px;line-height:1.1;color:var(--text);white-space:nowrap}
.rdx-tile-unit{font-family:var(--ui);font-size:12px;font-weight:600;color:var(--muted2);margin-left:4px}
.rdx-tile-delta{margin-top:6px;line-height:1.35}
.rdx-tiles-note{grid-column:1/-1;margin:0}
.rdx-volwrap{max-width:760px}
.rdx-form-more{display:block;margin-top:16px}
.rdx-form-more .rdx-tablewrap{max-width:920px}
.rdx-vol td{font-family:var(--mono);color:var(--text);font-variant-numeric:tabular-nums}

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
.rdx-toast{position:fixed;left:0;right:0;bottom:calc(16px + env(safe-area-inset-bottom) + var(--esl-bottom-inset,var(--rdx-inset,0px)));z-index:900;display:flex;justify-content:center;padding:0 16px;pointer-events:none}
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
  .rdx-section{margin-top:28px}
  .rdx-card{padding:14px 16px}
  .rdx-group{grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 16px}
  .rdx-group-hd,.rdx-group:not(#set-events)>.rdx-group-hd{padding-top:0}
  .rdx #gcSet .rdx-garmin-credit{padding:12px 16px 0}
  #importSlot .rdx-drop span{display:block;margin:2px 0 0}
  /* header: status on its own line, then the settings button */
  .rdx-head{flex-direction:column;align-items:stretch;gap:8px}
  .rdx-status{flex:none;font-size:12px}
  .rdx-head-acts .rdx-btn{flex:1;min-height:40px}
  /* settings: 2-column event form (Type | Date, End | Note), full-width + add */
  .rdx-ev-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
  .rdx-ev-form>.rdx-btn{grid-column:1/-1}
  .rdx-ev-form>.rdx-ev-end,.rdx-ev-form>.rdx-ev-note-in{grid-column:1/-1}   /* Type | Date, then End and Note a row each */
  .rdx-ev-form>:is(select,input){width:100%}
  .rdx-ev-end input{flex:1;min-width:0}
  :where(.rdx) :is(select,input[type=text],input[type=date],input[type=number]){height:40px;font-size:16px}   /* iOS zooms into inputs under 16px */
  .rdx-group-body>.rdx-ctl{flex:1 1 140px}
  .rdx-group-body>.rdx-ctl-wide{flex-basis:100%}   /* chip rows and the Lever button + its count need the whole width */
  .rdx-group-body>.rdx-ctl :is(select,input[type=text]){max-width:100%}
  .rdx-custom{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}
  .rdx-custom input{width:100%}
  /* hero: the narrow-card container query handles the layout */
  .rdx-hero{padding:14px 16px}
  .rdx-hero-head{font-size:20px}
  .rdx-do-opts{max-width:none}
  /* chart: the range segments span the width, then "Show [select]" gets its own full-width row — the select's
     longest option (~290px) can't share a 358px row, and a sideways-scrolling row hid most of it */
  .rdx-chart-ctl{width:100%}
  .rdx-chart-ctl .rdx-seg{display:flex;width:100%}
  .rdx-seg button{flex:1;padding:0 6px}
  .rdx-chart-ctl .rdx-inl{flex:1 1 100%;min-width:0}   /* lets the select shrink on a 320px phone */
  .rdx-chart-ctl select{flex:1}
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
  /* form & volume: 2 tiles a row; each compare range is a From – To pair across the width */
  .rdx-tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .rdx-tile{padding:12px 14px}
  .rdx-tile-val{font-size:22px}
  .rdx-cmp-ranges,.rdx-cmp-ranges>.rdx-ctl{width:100%}
  .rdx-cmp-dates{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr)}
  .rdx-cmp-dates input{width:100%}
}
@media(max-width:560px){
  /* phones: both tables fit the width — "Last" and the header date spans drop (the dates sit in the
     inputs above), metric names may wrap and the descriptions hide */
  .rdx-table{font-size:12px}
  .rdx-table th,.rdx-table td{padding:7px 8px}
  .rdx-table tr>:first-child{white-space:normal;max-width:36vw}
  /* volume: ~270px at its narrowest, so it fits a 320px phone and the standalone page's 26px wrap —
     "(611 days)" drops under "All", "/mi" under "Avg pace", and the headers may wrap */
  .rdx-vol th,.rdx-vol td{padding:7px 4px}
  .rdx-vol thead th{white-space:normal}
  .rdx-vol .rdx-munit,.rdx-vol-n{display:block;margin-left:0}
  .rdx-vol tr>:first-child{white-space:nowrap;max-width:none;padding-left:10px}
  .rdx-vol tr>:last-child{padding-right:10px}
  .rdx-wide,.rdx-mdesc{display:none}
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
  .rdx-types>.rdx-chip,.rdx-cmpbar>.rdx-chip{display:inline-flex;align-items:center;min-height:40px}
  .rdx-ev-del,.rdx-toast-box .rdx-toast-x,.rdx-modal-x{width:40px;min-width:40px;height:40px}
  .rdx-tip-btn::after{content:"";position:absolute;inset:-8px}
  .rdx-more>summary{padding:10px 0;min-height:40px}
  .rdx-dis .rdx-linkbtn{padding:11px 6px;margin:-11px -2px}
  .rdx-link,.rdx-linkbtn{padding:11px 4px;margin:-11px -4px}   /* text buttons: 40px hit area, same line box */
  .rdx-sb-also .rdx-linkbtn{margin:-1px 0 -11px 12px}              /* keeps its 10px gap and 16px indent */
  /* fields too, on any touch screen (a landscape phone is wider than the 599px phone block): iOS zooms under 16px */
  :where(.rdx) :is(select,input[type=text],input[type=date],input[type=number]){height:40px;font-size:16px}
  .rdx-lv-bar input{font-size:16px;min-height:40px}
}
@media(prefers-reduced-motion:reduce){.rdx *,.rdx{animation:none!important;transition:none!important}}
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
  // hide: kept for stable indices (select values are METRICS indices) but left out of the chart and table
  { key:'load',   label:'Load Factor',         unit:'',    dec:1, better:'lower', needs:'gct', hide:true,
    desc:'A ground-contact loading proxy from cadence and contact time',
    calc:function(r){ return (r.cadence!=null&&r.gct!=null)? r.cadence*r.gct/1000 : null; } },
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
var RUN_WINDOWS = [
  {days:7,   label:'7 days'},   // shown as "Last 7 days" ("Last" drops on phones)
  {days:30,  label:'30 days'},
  {days:90,  label:'90 days'},
  {days:365, label:'365 days'},
  {days:null,label:'All'},
];
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- per-mount state ---------- */
var ROOT=null, DB=null, UID=null, ROLE='athlete', ADMIN=false, STRAVA_SYNC={};
// Which tab this mount is: the sections it builds. Everything else (settings, events, toasts, the
// Lever modal) is shared. Renderers no-op when their section's elements aren't in the shell.
var VIEW='training';
var VIEW_SECS={ training:['hero','chart','form','about'], injury:['patterns','about'] };
function inView(sec){ return VIEW_SECS[VIEW].indexOf(sec)>=0; }
var RAW=[], ACTIVE_TYPES=new Set(), KNOWN_TYPES=new Set();
var ANCHOR=null, RANGES_EDITED=false, LOAD_PARAMS=null, STD_PROFILE={}, STRAVA_LEVER=[];
var DAY=864e5;
// Bumped by every mount(). Async loaders and late save callbacks compare it with the value they
// started under and drop their result when a newer mount (a coach switching athletes, a tab
// switch) took over — otherwise athlete A's profile/runs land in athlete B's globals, and the next
// list write saves A's dismissals/marks into B's doc.
var MOUNT=0;
var PROFILE_ERR=null;   // loadProfile failed: the view runs on defaults, so profile writes are blocked
var LIST_Q={};          // uid/key → {tail, n}: that field's serialized transaction chain + writes issued
var DIS_OPEN=false, DIS_T=0, DIS_SEQ=0;   // "N dismissed · show" expanded; last dismiss/restore click; dismiss/restore writes issued (only the newest may revert)
var GAP_FORM=null;      // the open "Log it…" gap form: {t0, type, start, end, note} — re-opened with what was typed after a re-render; t0 'past' = the "+ Log a past injury" form
var EV_EDIT=null;       // id (string) of the logged event loaded into the Events form for editing, or null
var SB_MORE=false, ALSO_ALL=false, PAT_STATS=true, GAPS_OPEN=false;   // injury section: older setback cards shown, all "Also logged" shown, stats disclosure open, training gaps expanded
var TOAST_T=0, TOAST_ARM=null, TOAST_BACK=null;   // page toast: hide timer, its (re)start fn while shown, where focus returns
var SAVE_SEQ={};        // profile key → persist() calls issued: only the newest call to a key may revert it
var HERO_HELP=false;    // hero "How to read these numbers" open — survives refresh() re-renders
var HERO_MORE=false;    // Today card "Details" disclosure open — survives refresh() re-renders
// §15.6: per-athlete view state and data, kept across remounts (a tab switch, a coach switching back).
// VIEWSTATE[uid] = what captureView() saw (chart range/metric/display, Form & volume windows, hero help,
// stats/gaps disclosure, settings open), merged across views. DATA_CACHE[uid] = {raw, profile, lever,
// sync}: a remount renders it at once (no blank shell), then refetches and re-renders — never stale.
var VIEWSTATE={}, DATA_CACHE={};
var EV_SEQ=0;           // runEvents writes issued (only the newest may revert)
var IMPORT_BUSY=false, IMPORT_EXTRA='';   // a file import is running; text appended to its final status
var CUTOFF_LAST='6:40', MINDIST_LAST='0.5';   // last valid What's-included entries (an invalid one is put back)
var TIP_N=0, TIPS_WIRED=false;   // toggletip ids; document-level close listeners added once
var RO=null, RO_T=0, WIN_RS=null, CHART_W=0;   // chart resize watcher (ResizeObserver, or window resize fallback), its debounce, the width last drawn at
var CAP_PIN='';         // event caption under the chart: the default hint, or the band/marker last tapped
// "Mark Lever runs" modal: filter chip, selected run ids, rows on screen (data-i indexes them),
// the element that opened it (focus returns there), confirmation timer
var LV={filter:'all', sel:new Set(), rows:[], trigger:null, toastT:null};

/* Admin-only demo switcher: forces the hero's r1/r3/r7 ratios to a fixed scenario so each
   recommendation card can be shown on demand. DEMO=null = live. Real run data is never
   touched — only the hero's displayed windows are overridden. The presets feed the ratios
   directly and bypass the window math, so read them as the hero does: r1 and r3 are
   PEAK-relative (today vs the biggest single day / biggest 3-day block of the prior 28), r7
   is the 7-day mean vs the 28-day mean day; d1/d3/d7 are derived as r × base for the tiles
   only and are not what the live math would produce for those ratios. */
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

/* Parse a Garmin export into candidate run docs keyed by a stable id. */
function parseExport(text){
  var rows=parseCSV(text);
  if(rows.length<2) throw new Error('This CSV has no activity rows.');
  var col=buildColMap(rows[0]);
  // Fingerprint on the columns every Garmin activities export has. Do NOT
  // require running-form columns (GCT etc.) — Garmin only exports what's on
  // screen, so they're often absent; missing fields just parse as null and
  // the load model falls back to its no-dynamics path.
  ['activitytype','date'].forEach(function(k){
    if(!(k in col)) throw new Error('This CSV isn’t a Garmin Connect activities export (no “'+({activitytype:'Activity Type',date:'Date'})[k]+'” column).');
  });
  var get=function(r,k){ return col[k]!=null ? r[col[k]] : null; };
  // Garmin names the shared cadence/pace columns after the export's FIRST row: with a ride on
  // top they come out "Avg Bike Cadence" / "Avg Speed", yet run rows still hold run cadence and
  // an m:ss pace there. Reading only the run names nulled pace on every run of such a file, and
  // impactLoad scores a pace-less run as nothing (a Sep 2026 upload zeroed ~10 weeks of load).
  // The speed column is taken only as m:ss — a decimal there is a real speed, not a pace.
  var cadenceOf=function(r){ var v=num(get(r,'avgruncadence')); return v!=null?v:num(get(r,'avgbikecadence')); };
  var paceOf=function(r){
    var v=hmsToSec(get(r,'avgpace')); if(v!=null) return v;
    var s=get(r,'avgspeed'); return (s!=null&&/^\s*"?\d+:\d/.test(s))?hmsToSec(s):null;
  };
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
      cadence:cadenceOf(r), stride:num(get(r,'avgstridelength')),
      vratio:num(get(r,'avgverticalratio')), vo:num(get(r,'avgverticaloscillation')),
      gct:num(get(r,'avggroundcontacttime')), gctBalL:gctBalLeft(get(r,'avggctbalance')),
      paceSec:paceOf(r), gapSec:hmsToSec(get(r,'avggap')),
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
  var sportType=s.sport?(s.sport.charAt(0).toUpperCase()+s.sport.slice(1)):'Running';
  // Indoor sessions are sport 'running' + sub_sport treadmill / indoor_running / virtual_activity:
  // type them 'Treadmill Running' like the Garmin CSV and Strava docs, so the treadmill rules (no
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
  var my=MOUNT;
  return actCol().get().then(function(snap){
    if(my!==MOUNT) return;   // a newer mount's athlete owns RAW now
    RAW=[]; snap.forEach(function(doc){ RAW.push(docToRun(doc.data())); });
    RAW.sort(function(a,b){ return a.ts-b.ts; });
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
      // watch-sourced docs by start time: the same run imported from a FIT and from the CSV gets a
      // different id scheme, so a new id within 60 s of a stored watch run is the same run (never re-ids)
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
        var batch=DB.batch();
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
  delete DATA_CACHE[UID];
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
function analyzable(r){ return !r._excl && r.distMi!=null && r.distMi>=minDist(); }
function runsIn(start,end){ return RAW.filter(function(r){ return ACTIVE_TYPES.has(effType(r)) && analyzable(r) && r.date>start && r.date<=end; }); }
function metricMean(runs,m){
  var vals=runs.map(m.calc).filter(function(v){ return v!=null && !isNaN(v); });
  if(!vals.length) return null;
  return vals.reduce(function(a,b){return a+b;},0)/vals.length;
}
function summarize(runs){
  var dist=runs.reduce(function(a,r){return a+(r.distMi||0);},0);
  var dur=runs.reduce(function(a,r){return a+(r.durSec||0);},0);
  // Avg pace = total time ÷ total distance (runs with both), so it agrees with Time ÷ Miles
  var pd=0, pt=0; runs.forEach(function(r){ if(r.durSec>0 && r.distMi>0){ pt+=r.durSec; pd+=r.distMi; } });
  var pace=pd>0?pt/pd:null;
  return {n:runs.length,dist:dist,dur:dur,pace:pace};
}

/* ---------- formatting ---------- */
function fmtVal(v,m){
  if(v==null) return '<span class="rdx-val na">–</span>';
  if(m.pace) return '<span class="rdx-val">'+fmtPace(v)+'</span>';
  return '<span class="rdx-val">'+v.toFixed(m.dec)+'</span>';
}
function fmtPace(s){ if(s==null) return '–'; var t=Math.round(s), mm=Math.floor(t/60), ss=t%60; return mm+':'+String(ss).padStart(2,'0'); }
function fmtDur(s){ var t=Math.round(s/60), h=Math.floor(t/60), mm=t%60; return h>0?h+'h '+mm+'m':mm+'m'; }
// "≈ same" deadband: a change smaller than ordinary run-to-run noise isn't a change. Per metric where
// noise beats display precision; otherwise half the last shown digit (anything that would print as 0).
// The derived metrics carry their inputs' noise (duty = gct×cad, vGRF/force from gct+cad, eff = stride/vo).
var FORM_TOL={cad:1.5, gct:4, vo:0.3, vratio:0.3, asym:0.5, stride:0.02, pace:5, hr:2, duty:0.5, vgrf:0.03, force:20, eff:0.01};
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
// Local calendar date — toISOString() would shift evening runs (and their day keys) to the
// next UTC day for athletes west of UTC.
function ymd(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
// Inclusive end bound for a date-input "To" value: the whole local day, not its midnight.
function dayEnd(d){ var e=new Date(d); e.setHours(23,59,59,999); return e; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Garmin credit under a view's title: "Garmin <model>" per device in the shown runs (plain "Garmin"
// when the model is unknown); derived views (load, patterns) say the insight comes partly from Garmin.
// One line each: shared/run-dynamics-garmin.test.js lifts them out of this file.
function garminLabel(d){ d=String(d==null?'':d).trim().replace(/^garmin(\s+|$)/i,''); return (d&&d.toLowerCase()!=='unknown')?'Garmin '+d:'Garmin'; }
function garminCredit(runs,derived){ var n=[]; (runs||[]).forEach(function(r){ if(r&&r.source==='garmin'){ var l=garminLabel(r.deviceName); if(n.indexOf(l)<0) n.push(l); } }); return n.length?'<p class="rdx-garmin-credit">'+(derived?'Insights derived in part from Garmin device-sourced data · ':'')+esc(n.join(', '))+'</p>':''; }
// Role-aware copy: the coach sees the same view about "this athlete".
function who(k){ var c=ROLE==='coach'; return { your:c?'this athlete’s':'your', Your:c?'This athlete’s':'Your', you:c?'this athlete':'you', 'you have':c?'this athlete has':'you have', their:c?'their':'your' }[k||'your']; }
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

/* ---------- rendering helpers ---------- */
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
// Load side (Today, the load chart, Injury Patterns, IAD calibration) ignores the activity-type chips:
// every run loads the body, a Lever run at its offload discount. Hiding a type only filters the
// form/metric views; min distance and per-run exclusions still apply.
function loadRuns(){ return RAW.filter(analyzable); }
function offloadFrac(){ var v=parseFloat(STD_PROFILE.runLeverPctBW); var pct=(v>0&&v<100)?v:85; return 1-pct/100; }
function leverPct(){ var v=parseFloat(STD_PROFILE.runLeverPctBW); return (v>0&&v<100)?v:85; }

// Strava titles only: athletes rename runs on Strava (never in Garmin), so a Strava activity whose
// name contains "lever" is a strong manual Lever flag. We pull ONLY the title from Strava and match
// it to the Garmin run by date (+distance); every metric still comes from Garmin.
function fetchStravaLever(){
  if(!UID) return Promise.resolve();
  var my=MOUNT;
  return DB.collection('trainingPlans').where('athleteUid','==',UID).limit(1).get().then(function(ps){
    if(my!==MOUNT) return;
    if(ps.empty){ STRAVA_LEVER=[]; return; }
    return DB.collection('trainingPlans').doc(ps.docs[0].id).collection('stravaActivities').get().then(function(snap){
      if(my!==MOUNT) return;
      var out=[]; snap.forEach(function(d){ var a=d.data(); if(a&&a.name&&/lever/i.test(a.name)&&a.date) out.push({ date:a.date, distMi:(a.distance||0)/1609.34 }); });
      STRAVA_LEVER=out;
    });
  }).catch(function(){ if(my===MOUNT) STRAVA_LEVER=[]; });
}
function stravaLever(r){
  if(!STRAVA_LEVER.length) return false;
  return STRAVA_LEVER.some(function(s){ var n=Date.parse(s.date+'T12:00:00'); if(isNaN(n)) return false;
    if(Math.abs(r.ts-n) > 1.2*864e5) return false;
    if(r.distMi!=null && s.distMi>0 && Math.abs(s.distMi-r.distMi) > Math.max(0.2,0.05*r.distMi)) return false;
    return true; });
}
// Manual Lever marks: users/{uid}.runLeverMarks = [{id, lever:true, offload:0.01–0.95, ts, mi} |
// {id, lever:false, ts, mi}]. They live on the USER doc, never on activity docs — the importer and
// the daily Strava sync rewrite activity docs wholesale with set(). Run ids are stable across
// re-imports of the same source (local start digits + type; Garmin CSV and Strava docs agree), so
// a mark survives a wipe + re-import. ts (start epoch) + mi (distance) are a fallback key for a run
// that comes back under a DIFFERENT id — a Coros FIT import (UTC-digit id) replacing the Strava doc
// it was marked on: a mark whose id no stored run has adopts the run starting within 30 min of it.
function leverMarkList(){ return (Array.isArray(STD_PROFILE.runLeverMarks)?STD_PROFILE.runLeverMarks:[]).filter(function(m){ return m&&m.id!=null; }); }
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
function annotateLever(){
  var ids=RunLoad.detectLeverIds(RAW), marks=new Map(), have=new Set(RAW.map(function(r){ return r.id; })), orphans=[];
  leverMarkList().forEach(function(m){ if(have.has(m.id)) marks.set(m.id,m); else if(isFinite(m.ts)) orphans.push(m); });
  RAW.forEach(function(r){
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
function exclList(){ return (Array.isArray(STD_PROFILE.runExcluded)?STD_PROFILE.runExcluded:[]).filter(function(x){ return x&&x.id!=null; }); }
function runFlag(r){
  if(r.distMi>100) return 'over 100 mi';
  if(r.paceSec>0 && r.paceSec<210) return 'faster than 3:30 /mi';
  if(r.durSec>86400) return 'longer than 24 h';
  if(r.ts>dayEnd(new Date()).getTime()) return 'dated ahead';
  return null;
}
function annotateExcluded(){
  var ex=exclList(), ids=new Set(ex.map(function(x){ return String(x.id); }));
  RAW.forEach(function(r){ r._excl=ids.has(String(r.id)) || ex.some(function(x){ return isFinite(x.ts) && Math.abs(x.ts-r.ts)<=6e4; }); });
}
function exclMatch(x,r){ return String(x.id)===String(r.id) || (isFinite(x.ts) && Math.abs(x.ts-r.ts)<=6e4); }
function setExcluded(add, rm, msg, undo){
  var my=MOUNT, prev=STD_PROFILE.runExcluded;
  var p=updateProfileList('runExcluded', function(list){
    list=list.filter(function(x){ return !(x && rm.some(function(r){ return exclMatch(x,r); })); });
    return list.concat(add.filter(function(r){ return !list.some(function(x){ return x&&exclMatch(x,r); }); }).map(function(r){ return {id:r.id, ts:r.ts, at:Date.now()}; }));
  }, refresh, false);
  refresh();
  toast(msg, undo?{undo:undo}:null);
  return p.then(function(r){
    if(r===true || my!==MOUNT) return r;
    STD_PROFILE.runExcluded=Array.isArray(prev)?prev:[]; refresh();
    toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    return r;
  });
}
function renderFlags(){
  var el=$('rdxFlags'); if(!el) return;
  var bad=RAW.filter(function(r){ return !r._excl && runFlag(r); }), ex=RAW.filter(function(r){ return r._excl; });
  el.textContent=''; el.hidden=!bad.length && !ex.length;
  if(el.hidden) return;
  var add=function(cls,txt){ var x=document.createElement('span'); if(cls) x.className=cls; x.textContent=txt; el.appendChild(x); };
  var btn=function(txt,fn,label){ var b=document.createElement('button'); b.type='button'; b.className='rdx-linkbtn'; b.textContent=txt; if(label) b.setAttribute('aria-label',label); b.onclick=fn; el.appendChild(b); };
  var n=function(k){ return k+' run'+(k===1?'':'s'); };
  var exclude=function(runs){ setExcluded(runs, [], 'Excluded '+n(runs.length)+' — no longer counted in load or metrics.', function(){ setExcluded([], runs, 'Included '+n(runs.length)+' again.'); }); };
  if(bad.length){
    add('rdx-flags-k', bad.length===1?'1 run looks wrong: ':bad.length+' runs look wrong: ');
    bad.slice(0,3).forEach(function(r,i){
      if(i) add('',' · ');
      var what=fmtDay(r.ts)+', '+(r.distMi!=null?(r.distMi>=100?Math.round(r.distMi).toLocaleString('en-US'):fmtMi(r.distMi))+' mi':'run')+' ('+runFlag(r)+')';
      add('',what+' ');
      btn('Exclude',function(){ exclude([r]); },'Exclude the '+what);
    });
    if(bad.length>3){ add('',' · +'+(bad.length-3)+' more '); btn('Exclude all '+bad.length,function(){ exclude(bad); }); }
  }
  if(ex.length){
    if(bad.length) add('',' · ');
    add('',n(ex.length)+' excluded ');
    btn('Include again',function(){ setExcluded([], ex, 'Included '+n(ex.length)+' again.', function(){ setExcluded(ex, [], 'Excluded '+n(ex.length)+' again.'); }); },'Include the '+n(ex.length)+' excluded again');
  }
  el.insertAdjacentHTML('beforeend',garminCredit(bad.slice(0,3),false));   // credits the runs named above
}
// Runner-entered easy pace (s/mi, 240–1200) from the profile: the middle rung of the baseline
// chain calibrated median → recorded easy pace → neutral. Null when unset or out of range.
function easyPaceSec(){ var v=parseFloat(STD_PROFILE.runEasyPaceSec); return (v>=240&&v<=1200)?v:null; }
// Baseline chain: the median of the athlete's own easy runs wins; a recorded easy pace from the
// profile fills in until there are runs to calibrate from; otherwise the pace term is neutral
// (no guessed constant). basePaceSource records which rung is in force for the hero tile.
function computeLoadParams(){
  var it=intensityState(), cal=RunLoad.calibrateBaseline(loadRuns(), it.cutoff), profile=easyPaceSec();
  var src = cal.basePaceSec!=null ? 'calibrated' : (profile!=null ? 'profile' : null);
  return Object.assign({}, RunLoad.DEFAULTS, cal, { basePaceSec: cal.basePaceSec!=null?cal.basePaceSec:profile, basePaceSource: src, useGrade:true, offload:offloadFrac() });
}

/* ---------- profile (weight + device), stored on the user doc ---------- */
function weightKg(){ var lb=STD_PROFILE.weightLb; return lb ? lb*0.453592 : null; }
function deviceId(){ return STD_PROFILE.runDevice||''; }
function hasAccessory(){ return !!STD_PROFILE.runHasAccessory; }
function metricVisible(m){ return RunDevices.status(m.needs, deviceId(), hasAccessory())==='native'; }
// Key-order-insensitive JSON for the read-back check: Firestore hands maps back with keys in its
// own order, so a plain stringify of an array of maps (events, marks) reads a good write as lost.
function canonJSON(v){
  if(Array.isArray(v)) return '['+v.map(canonJSON).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).filter(function(k){ return v[k]!==undefined; }).sort().map(function(k){ return JSON.stringify(k)+':'+canonJSON(v[k]); }).join(',')+'}';
  return JSON.stringify(v);
}
/* ---------- page toast (#rdxToast) ----------
   One message at a time; a new one replaces the last. #rdxToast is the always-present live region
   (role=status) — the visible box is rebuilt inside it, so the box's text is what gets announced.
   ok: 4s (7s with Undo); err: stays until ✕ or a newer toast replaces it. Text goes in via textContent, never markup.
   The clock stops while the box is hovered or holds focus (WCAG 2.2.1 — Undo can't vanish under the
   pointer or the keyboard) and while #rdxToast is hidden behind the Lever modal (lvOpenModal/lvClose);
   a box removed while focused hands focus back to where the user came from. */
function toast(msg, o){
  o=o||{}; var el=$('rdxToast'); if(!el) return;
  clearTimeout(TOAST_T);
  var err=o.kind==='err', ms=err?0:o.undo?7000:4000, box=document.createElement('div'), m=document.createElement('span');
  box.className='rdx-toast-box'+(err?' err':''); m.className='rdx-toast-msg'; m.textContent=msg; box.appendChild(m);
  // both no-op once a newer toast replaced this box: the shared timer is the newer box's now
  var hide=function(){ if(box.parentNode!==el) return; clearTimeout(TOAST_T); TOAST_ARM=null; var f=box.contains(document.activeElement); el.innerHTML=''; if(f) toastFocusBack(); };
  var arm=function(){ if(box.parentNode!==el) return; clearTimeout(TOAST_T); if(!el.hidden && ms>0) TOAST_T=setTimeout(hide, ms); };
  var btn=function(cls,txt,label,fn){ var b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=txt; if(label) b.setAttribute('aria-label',label); b.addEventListener('click',fn); box.appendChild(b); };
  if(o.undo) btn('rdx-toast-undo','Undo','',function(e){ hide(); o.undo(e); });
  if(err) btn('rdx-toast-x','✕','Dismiss message',hide);
  box.addEventListener('mouseenter',function(){ clearTimeout(TOAST_T); });
  box.addEventListener('mouseleave',function(){ if(!box.contains(document.activeElement)) arm(); });
  box.addEventListener('focusin',function(e){ clearTimeout(TOAST_T); if(e.relatedTarget && !box.contains(e.relatedTarget)) TOAST_BACK=e.relatedTarget; });
  box.addEventListener('focusout',function(e){ if(!box.contains(e.relatedTarget) && !box.matches(':hover')) arm(); });
  var had=el.firstChild && el.firstChild.contains(document.activeElement);   // replacing a focused toast
  el.innerHTML=''; el.appendChild(box);
  if(had) toastFocusBack(); else TOAST_BACK=null;
  TOAST_ARM=arm; arm();
}
// Where focus goes when a focused toast is removed: the element it was entered from, if that's still on
// the page, else the injury section's heading (the toasts with buttons come from there).
function toastFocusBack(){
  var t=TOAST_BACK; TOAST_BACK=null;
  if(!(t && ROOT && ROOT.contains(t) && t.offsetParent!==null)) t=$('rdxGapsHd')||$('patHead');
  if(t && t.offsetParent!==null) t.focus({preventScroll:true});
}
// A failed profile read leaves STD_PROFILE on defaults — writing from it would overwrite the
// stored values (runEvents wholesale) with what the view never saw. Returns the block reason.
function profileBlocked(){ return PROFILE_ERR ? 'profile didn’t load — reload the page' : null; }
// Applies the patch locally at once, then persists it. Resolves true once the read-back matches,
// else a short reason string. Reports through the toast: okMsg (default "Saved") on success —
// okMsg===false keeps it quiet — and the error on failure. Callers use persist(), which also
// rolls the view back when a write fails.
function saveProfile(patch, okMsg){
  Object.assign(STD_PROFILE, patch);
  var my=MOUNT, uid=UID, show=function(r){ if(my!==MOUNT) return r;
    if(r!==true) toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    else if(okMsg!==false) toast(okMsg||'Saved');
    return r; };
  if(!uid) return Promise.resolve(show('no athlete'));
  var blocked=profileBlocked(); if(blocked) return Promise.resolve(show(blocked));
  var ref=DB.collection('users').doc(uid), key=Object.keys(patch)[0];
  return ref.set(patch,{merge:true})
    .then(function(){ return ref.get(); })
    // a newer save of the same key (quick successive clicks) may land before this read-back
    .then(function(d){ var data=d.data()||{}, got=canonJSON(data[key]); var ok=got===canonJSON(patch[key])||got===canonJSON(STD_PROFILE[key]);
      if(!ok) console.warn('RunDynamics: profile did not persist',{uid:uid,key:key,got:data[key],sent:patch[key]});
      return show(ok||'wrote but not stored'); })
    .catch(function(e){ console.error('profile save',e); return show((e&&e.code)||'save failed'); });
}
// saveProfile + rollback: a failed write puts back its own key — unless a newer persist() of the key
// was issued or the local value moved on (that change owns the field and reports for itself).
function persist(patch, okMsg){
  var key=Object.keys(patch)[0], n=SAVE_SEQ[key]=(SAVE_SEQ[key]||0)+1, sent=canonJSON(patch[key]), prev=STD_PROFILE[key], my=MOUNT;
  return saveProfile(patch, okMsg).then(function(r){
    if(r!==true) revertKey(key, prev, function(){ return my===MOUNT && SAVE_SEQ[key]===n && canonJSON(STD_PROFILE[key])===sent; });
    return r;
  });
}
// Roll ONE profile key back to its stored value, or to prev (its value before the failed write) when the
// doc can't be read either. Never a whole-profile reload: that would drop other keys' in-flight saves
// from the view, and offline — where the read fails too — wipe the view and block every later write.
// mine() is re-checked once the read is back.
function revertKey(key, prev, mine){
  var my=MOUNT, uid=UID;
  if(!uid || !mine()) return Promise.resolve();
  return DB.collection('users').doc(uid).get().then(function(d){ return (d.exists?d.data()||{}:{})[key]; }, function(){ return prev; }).then(function(v){
    if(my!==MOUNT || !mine()) return;
    var list=/^run(Events|DismissedDrops|LeverMarks|Excluded)$/.test(key);
    STD_PROFILE[key]=(list&&!Array.isArray(v))?[]:v;   // list fields stay arrays, as loadProfile keeps them
    if(list) renderEventsList(); else { fillProfileInputs(); if(key==='runIncluded') applyIncluded(); populateMetricSelects(); }
    refresh();
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
  STD_PROFILE[key]=fn(cur(STD_PROFILE[key]));
  var my=MOUNT, uid=UID, fail=function(r){ if(my===MOUNT && okMsg!==false) toast('Couldn’t save ('+r+').',{kind:'err'}); return r; };
  if(!uid) return Promise.resolve(fail('no athlete'));
  var blocked=profileBlocked(); if(blocked) return Promise.resolve(fail(blocked));
  var ref=DB.collection('users').doc(uid), q=LIST_Q[uid+'/'+key]||(LIST_Q[uid+'/'+key]={tail:Promise.resolve(),n:0}), n=++q.n, out;
  var run=function(){ return DB.runTransaction(function(tx){
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
    if(my!==MOUNT) return true;
    if(okMsg!==false) toast(okMsg||'Saved');
    if(n!==q.n) return true;   // a newer write to this field is queued: it adopts the stored copy
    var changed=canonJSON(out)!==canonJSON(STD_PROFILE[key]);
    STD_PROFILE[key]=out; if(changed && rerender) rerender();
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
function loadProfile(){ if(!UID) return Promise.resolve(); var my=MOUNT; return DB.collection('users').doc(UID).get().then(function(d){ if(my!==MOUNT) return; var x=d.exists?d.data():{}; PROFILE_ERR=null; STD_PROFILE={ weightLb:x.weightLb, runDevice:x.runDevice, runHasAccessory:x.runHasAccessory, runLeverPctBW:x.runLeverPctBW, runEasyPaceSec:x.runEasyPaceSec, runEvents:Array.isArray(x.runEvents)?x.runEvents:[], runDismissedDrops:Array.isArray(x.runDismissedDrops)?x.runDismissedDrops:[], runLeverMarks:Array.isArray(x.runLeverMarks)?x.runLeverMarks:[], runExcluded:Array.isArray(x.runExcluded)?x.runExcluded:[], runIncluded:(x.runIncluded&&typeof x.runIncluded==='object')?x.runIncluded:null, runWorkoutPaceSec:x.runWorkoutPaceSec }; STRAVA_SYNC={ connected:!!x.stravaConnected, last:x.stravaLastSyncedAt||null }; }).catch(function(e){ if(my!==MOUNT) return; console.error('profile load',e); PROFILE_ERR=(e&&e.code)||'load failed'; STD_PROFILE={}; STRAVA_SYNC={}; }); }

/* ---------- performance/injury/downtime history events ---------- */
// runEvents[] entry: { id, type:'race'|'injury'|'illness'|'nonrun'|'timeoff', ts, endTs?, note }.
// endTs (every type but race) makes the event a span — drawn as a faint band
// on the charts instead of a single marker line. 'nonrun' = an acute injury
// that didn't come from running: overlaid + explains drops, but NEVER enters
// the pattern analysis (its lead-up says nothing about training load).
var EV_META={ injury:['Injury','var(--bad)'], race:['Race','var(--good)'], illness:['Illness','#f59a4d'], nonrun:['Non-Running Injury','#ef6bab'], timeoff:['Planned Downtime','#5b9cf5'] };
// Events saved before the local-day fix carry UTC-midnight timestamps (the old date parser);
// remap those to local midnight of the same calendar date so they key and display on the day
// the athlete picked. New events store local midnight, which is only an exact UTC midnight for
// UTC±0 viewers — where the remap is the identity.
function evLocalTs(ts){ if(ts%DAY===0){ var d=new Date(ts); return new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()).getTime(); } return ts; }
function events(){
  var raw=Array.isArray(STD_PROFILE.runEvents)?STD_PROFILE.runEvents:[];
  return raw.map(function(e){
    var o=Object.assign({},e,{ts:evLocalTs(e.ts)});
    if(o.endTs!=null) o.endTs=evLocalTs(o.endTs);
    return o;
  });
}
// One-line hint per type, under the settings form and the gap form's type select.
var EV_HINT={
  race:'A race or time trial. Marked on the chart; explains a taper or recovery dip.',
  injury:'An overuse injury that built up from running. Its lead-up is analyzed in this report.',
  illness:'A significant illness that stopped training. Checked against overtraining-type patterns only.',
  nonrun:'An acute injury that didn’t come from running (a basketball ankle, a bike crash). Explains the gap; stays out of the analysis.',
  timeoff:'A planned break (off-season, vacation). Explains the gap; stays out of the analysis.'
};
// Note placeholder per type, short enough for the half-width phone field (Race has no End, so its Note takes the row)
var EV_PH={race:'e.g. Boston Marathon', injury:'e.g. Achilles', illness:'e.g. flu', nonrun:'e.g. bike crash', timeoff:'e.g. vacation'};
// The condensed what-to-log guidance — shared by the settings "Log an event" group and the injury
// section's no-injuries invite, so the two can't drift apart.
function whatToLogHTML(){
  return '<div class="rdx-wtl"><div class="rdx-lbl">What to log</div><ul>'+
    [['injury','overuse injuries that built up from training'],['nonrun','acute injuries that didn’t come from running'],
     ['illness','significant illnesses that stopped training'],['timeoff','planned breaks: off-season, vacation']].map(function(x){
      var m=EV_META[x[0]]; return '<li><span class="rdx-ev-dot" style="background:'+m[1]+'"></span><span><b>'+m[0]+'</b> — '+x[1]+'</span></li>'; }).join('')+
    '</ul><p>Everything but races can take an end date to shade the whole span.</p></div>';
}
function evLabel(e){ return (EV_META[e.type]||EV_META.race)[0]+' · '+fmtSpan(e.ts,e.endTs); }
// Inline field error: red border + aria-invalid, the message in the form's hint line (#evHint, which
// the date fields are described by — no new row), and an error toast as a second cue. Cleared on input.
function evWarn(id,msg){ var f=$(id); if(f){ f.classList.add('rdx-df-err'); f.setAttribute('aria-invalid','true'); f.focus(); }
  var h=$('evHint'); if(h){ h.textContent=msg; h.classList.add('rdx-field-err'); } toast(msg,{kind:'err'}); }
function evClearErr(){ ['evDate','evEndDate'].forEach(function(id){ var f=$(id); if(f){ f.classList.remove('rdx-df-err'); f.removeAttribute('aria-invalid'); } });
  var h=$('evHint'), t=$('evType'); if(h && h.classList.contains('rdx-field-err')){ h.classList.remove('rdx-field-err'); h.textContent=EV_HINT[t?t.value:'race']||''; } }
var EV_END_MSG='The end date can’t be before the start — leave End empty for a one-day event.';
// Injuries and illnesses (incl. non-running injuries) can't be dated ahead; races and planned breaks can.
var EV_NO_FUTURE={injury:1, illness:1, nonrun:1};
var EV_FUTURE_MSG='An injury or illness can’t be dated in the future.';
function evFuture(type, d){ return !!(EV_NO_FUTURE[type] && d && d.getTime()>dayEnd(new Date()).getTime()); }
// date inputs' max follows the type: today for injury/illness/non-running injury, open otherwise
function evDateMax(type, ids){ var mx=EV_NO_FUTURE[type]?ymd(new Date()):''; ids.forEach(function(id){ var f=$(id); if(f){ if(mx) f.max=mx; else f.removeAttribute('max'); } }); }
// Settings inputs (profile + What's included): an invalid entry is never stored — red border +
// aria-invalid, the last good value put back, focus kept, and an error toast. Cleared on next input.
function fieldErr(id,msg,restore){
  var f=$(id); if(f){ f.value=(restore==null)?'':restore; f.classList.add('rdx-df-err'); f.setAttribute('aria-invalid','true'); f.focus(); }
  toast(msg,{kind:'err'});
}
function fieldOk(f){ if(f){ f.classList.remove('rdx-df-err'); f.removeAttribute('aria-invalid'); } }
// Read-modify-write of runEvents on the STORED list inside a transaction (updateProfileList), so a stale
// tab or another device keeps its entries. fn gets the raw stored array — never events(), which re-maps
// legacy UTC timestamps and would rewrite them. Toasts okMsg (+ Undo) at once; on failure an error toast,
// and runEvents rolls back. Resolves true or the failure reason.
function saveEvents(fn, okMsg, undo){
  var my=MOUNT, n=++EV_SEQ, prev=STD_PROFILE.runEvents;
  var p=updateProfileList('runEvents', fn, function(){ renderEventsList(); refresh(); }, false), sent=canonJSON(STD_PROFILE.runEvents);
  if(okMsg) toast(okMsg, undo?{undo:undo}:null);
  return p.then(function(r){
    if(r===true || my!==MOUNT) return r;
    toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    revertKey('runEvents', Array.isArray(prev)?prev:[], function(){ return my===MOUNT && EV_SEQ===n && canonJSON(STD_PROFILE.runEvents)===sent; });
    return r;
  });
}
function evAddFn(e){ return function(list){ return list.some(function(x){ return String(x.id)===String(e.id); })?list:list.concat([e]); }; }
function evAdd(){
  evClearErr();
  var d=parseDate($('evDate').value);
  if(!d){ evWarn('evDate','Pick a date for the event.'); return; }
  var type=$('evType').value; if(!EV_META[type]) type='race';
  if(evFuture(type,d)){ evWarn('evDate',EV_FUTURE_MSG); return; }
  var note=($('evNote').value||'').trim();
  var e={ id:Date.now(), type:type, ts:d.getTime(), note:note };
  if(type!=='race'){
    var end=parseDate($('evEndDate').value);
    if(end){
      if(end.getTime()<d.getTime()){ evWarn('evEndDate',EV_END_MSG); return; }
      if(evFuture(type,end)){ evWarn('evEndDate',EV_FUTURE_MSG); return; }
      if(end.getTime()>d.getTime()) e.endTs=end.getTime();   // End = Start is a one-day event
    }
  }
  if(EV_EDIT!=null){ evSaveEdit(EV_EDIT, e); return; }
  // a failed save rolls the event back (saveEvents): put back what was typed, as the gap form does —
  // unless a new note / end date has been typed since
  var my=MOUNT, typedNote=$('evNote').value, typedEnd=$('evEndDate').value;
  saveEvents(evAddFn(e), 'Logged: '+evLabel(e)).then(function(r){
    if(r===true || my!==MOUNT) return;
    var nt=$('evNote'), en=$('evEndDate');
    if(nt && !nt.value) nt.value=typedNote;
    if(en && !en.value && !$('evEndCtl').hidden) en.value=typedEnd;
  });
  $('evNote').value=''; $('evEndDate').value='';
  renderEventsList(); refresh();
}
// Editing: a logged event's row loads it into the Events form; "+ add" reads "Save" and a Cancel link
// appears. Saving replaces the stored entry by id (keeping the id) inside the same transaction; an
// entry deleted meanwhile (another device) is added back as edited.
function evFormMode(id){
  EV_EDIT=id==null?null:String(id);
  var add=$('evAdd'), cancel=$('evCancel'); if(!add) return;
  add.textContent=EV_EDIT!=null?'Save':'+ add';
  if(cancel) cancel.hidden=EV_EDIT==null;
  Array.prototype.forEach.call($all('#eventsList .rdx-ev-pick'),function(b){
    var on=b.getAttribute('data-id')===EV_EDIT; b.parentNode.classList.toggle('editing',on); b.setAttribute('aria-pressed',String(on)); });
}
function evEdit(id){
  var e=events().filter(function(x){ return String(x.id)===String(id); })[0]; if(!e) return;
  evClearErr();
  var t=$('evType'); t.value=EV_META[e.type]?e.type:'race'; t.onchange();
  $('evDate').value=ymd(new Date(e.ts));
  $('evEndDate').value=(e.endTs!=null && t.value!=='race')?ymd(new Date(e.endTs)):'';
  $('evNote').value=e.note||'';
  evFormMode(e.id);
  $('evDate').focus();
}
function evCancelEdit(focus){
  var id=EV_EDIT; evFormMode(null);
  $('evDate').value=ymd(new Date()); $('evEndDate').value=''; $('evNote').value=''; evClearErr();
  if(focus){ var b=document.querySelector('#eventsList .rdx-ev-pick[data-id="'+id+'"]')||$('evType'); if(b) b.focus(); }
}
function evSaveEdit(id, e){
  var old=events().filter(function(x){ return String(x.id)===String(id); })[0];
  var fn=function(list){
    var hit=false, out=list.map(function(x){
      if(String(x.id)!==String(id)) return x;
      hit=true; var o=Object.assign({},x,{type:e.type, ts:e.ts, note:e.note}); if(e.endTs!=null) o.endTs=e.endTs; else delete o.endTs; return o;
    });
    return hit?out:list.concat([Object.assign({},e,{id:old?old.id:e.id})]);
  };
  evFormMode(null);
  saveEvents(fn, 'Saved: '+evLabel(e));
  $('evNote').value=''; $('evEndDate').value='';
  renderEventsList(); refresh();
  var b=document.querySelector('#eventsList .rdx-ev-pick[data-id="'+id+'"]'); if(b) b.focus();
}
// by String id: data-id comes back as text, stored ids are numbers. A keyboard user's focus moves
// to the next row's ✕ (or the Type select once the list is empty) — the pressed button is gone.
function evDelete(id, kbd){
  var all=events(), e=all.filter(function(x){ return String(x.id)===String(id); })[0]; if(!e) return;
  var rows=Array.prototype.slice.call($all('#eventsList .rdx-ev-del')), at=rows.map(function(b){ return b.getAttribute('data-id'); }).indexOf(String(id));
  // Undo puts back the stored entry as it was (raw ts, not the display-remapped one)
  var raw=(Array.isArray(STD_PROFILE.runEvents)?STD_PROFILE.runEvents:[]).filter(function(x){ return String(x.id)===String(id); })[0]||e;
  if(EV_EDIT===String(id)) evCancelEdit(false);
  saveEvents(function(list){ return list.filter(function(x){ return String(x.id)!==String(id); }); }, 'Removed: '+evLabel(e),
    function(){ saveEvents(evAddFn(raw), 'Restored: '+evLabel(e)); renderEventsList(); refresh(); });
  renderEventsList(); refresh();
  if(!kbd) return;
  rows=$all('#eventsList .rdx-ev-del');
  var t=rows[Math.min(Math.max(at,0),rows.length-1)]||$('evType'); if(t) t.focus();
}
function renderEventsList(){
  var el=$('eventsList'); if(!el) return;
  var evs=events().slice().sort(function(a,b){return b.ts-a.ts;}), cnt=$('evCount'), tog=$('evListTog');
  if(cnt) cnt.textContent=evs.length?evs.length+' logged event'+(evs.length===1?'':'s')+' ·':'No events logged yet — add one to mark it on the chart.';
  if(tog) tog.hidden=!evs.length;
  if(!evs.length){ el.innerHTML=''; return; }
  el.innerHTML=evs.map(function(e){ var m=EV_META[e.type]||EV_META.race, when=fmtSpan(e.ts,e.endTs);
    var on=EV_EDIT===String(e.id);
    return '<div class="rdx-ev-row'+(on?' editing':'')+'"><button type="button" class="rdx-ev-pick" data-id="'+esc(e.id)+'" aria-pressed="'+on+'" aria-label="Edit '+m[0]+' '+when+(e.note?', '+esc(e.note):'')+'">'+
      '<span class="rdx-ev-dot" style="background:'+m[1]+'"></span><span class="rdx-ev-type">'+m[0]+'</span><span class="rdx-ev-when">'+when+'</span>'+
      (e.note?'<span class="rdx-ev-note">'+esc(e.note)+'</span>':'')+'</button>'+
      '<button type="button" class="rdx-ev-del" data-id="'+esc(e.id)+'" aria-label="Remove '+m[0]+' '+when+'">✕</button></div>';
  }).join('');
  // the event being edited was removed elsewhere (another device): drop out of edit mode
  if(EV_EDIT!=null && !evs.some(function(e){ return String(e.id)===EV_EDIT; })) evCancelEdit(false);
}
// Show / Overlay selects, grouped. Values are METRICS indices ('load' = the load chart); hidden
// metrics and ones the athlete's device can't record are left out; an ungrouped metric lands in Derived.
var METRIC_GROUPS=[['Load',['impact']],['Form',['cad','gct','vo','vratio','asym','stride']],['Effort',['pace','hr']],['Derived',['duty','vgrf','force','eff']]];
function metricGroups(){
  var seen={}; METRIC_GROUPS.forEach(function(g){ g[1].forEach(function(k){ seen[k]=1; }); });
  return METRIC_GROUPS.map(function(g){ return [g[0], g[0]==='Derived' ? g[1].concat(METRICS.filter(function(m){ return !seen[m.key]; }).map(function(m){ return m.key; })) : g[1]]; });
}
function populateMetricSelects(){
  var v1=$('chartView'), v2=$('chartView2'); if(!v1) return;
  var prev1=v1.value, prev2=v2.value, idx={}, groups=metricGroups(), rec={};
  METRICS.forEach(function(m,i){ idx[m.key]=i; });
  // a metric no stored run carries is listed disabled "(not recorded)" (Impact Load is always computable)
  METRICS.forEach(function(m){ rec[m.key]=m.key==='impact' || RAW.some(function(r){ var v=m.calc(r); return v!=null&&!isNaN(v); }); });
  var opts=function(withLoad){ return groups.map(function(g){
    var o=g[1].map(function(k){ var i=idx[k], m=METRICS[i]; if(!(m&&!m.hide&&metricVisible(m))) return '';
      return '<option value="'+i+'"'+(rec[k]?'':' disabled')+'>'+(k==='impact'?'Impact Load per run':m.label)+(rec[k]?'':' (not recorded)')+'</option>'; }).join('');
    if(withLoad && g[0]==='Load') o='<option value="load">Load — 7-day vs 28-day base</option>'+o;
    return o?'<optgroup label="'+g[0]+'">'+o+'</optgroup>':'';
  }).join(''); };
  v1.innerHTML=opts(true);
  v2.innerHTML='<option value="">None</option>'+opts(false);
  var has=function(sel,v){return Array.prototype.some.call(sel.options,function(o){return o.value===v&&!o.disabled;});};
  v1.value=has(v1,prev1)?prev1:'load';
  v2.value=has(v2,prev2)?prev2:'';
  syncOverlaySelect();
}
// The overlay can't repeat the main metric: its option is disabled, and a clash resets the overlay to None.
function syncOverlaySelect(){
  var v1=$('chartView'), v2=$('chartView2'); if(!v1||!v2) return;
  Array.prototype.forEach.call(v2.options,function(o){ if(o.value==='') return; var nr=/ \(not recorded\)$/.test(o.textContent); o.disabled=nr||o.value===v1.value; });
  if(v2.value!=='' && v2.value===v1.value) v2.value='';
}

/* ---------- chart math helpers ---------- */
function acwrColor(a){ if(a==null)return 'var(--muted2)'; if(a>1.5)return 'var(--bad)'; if(a>1.3)return 'var(--gold)'; if(a<0.8)return 'var(--warn)'; return 'var(--good)'; }
// Month ticks, at most maxTicks of them (4 on a phone-width chart, 8 otherwise).
function axisTicks(t0,t1,maxTicks){
  if(t1-t0<45*DAY){   // short span: weekly ticks from the first Monday ≥ t0 (month ticks would leave 0–1 labels)
    var wk=[], c=new Date(t0); c.setHours(0,0,0,0); while(c.getDay()!==1 || c.getTime()<t0){ c.setDate(c.getDate()+1); c.setHours(0,0,0,0); }
    for(;c.getTime()<=t1;c.setDate(c.getDate()+7)) wk.push(c.getTime());
    if(wk.length>=2) return wk;
  }
  var months=(t1-t0)/(30.44*DAY), cap=maxTicks||8;
  var steps=[1,2,3,6,12], step=12;
  for(var i=0;i<steps.length;i++){ if(Math.floor(months/steps[i])<=cap){ step=steps[i]; break; } }
  var out=[], y0=new Date(t0).getFullYear(), y1=new Date(t1).getFullYear();
  for(var y=y0;y<=y1;y++) for(var m=0;m<12;m+=step){ var t=new Date(y,m,1).getTime(); if(t>=t0&&t<=t1) out.push(t); }
  return out.length>=2 ? out : [t0,t1];
}
function axisLabel(ts,idx,short){ var d=new Date(ts); if(short) return MONTHS[d.getMonth()]+' '+d.getDate(); return MONTHS[d.getMonth()]+((d.getMonth()===0||idx===0)?" '"+String(d.getFullYear()).slice(2):''); }
function smoothArr(vals,w){ var half=Math.floor(w/2); return vals.map(function(_,i){ var s=0,c=0; for(var j=Math.max(0,i-half);j<=Math.min(vals.length-1,i+half);j++){ s+=vals[j]; c++; } return s/c; }); }
function coloredPath(xs,ys,cs,width){ var out='',cur=[],cc=null;
  for(var i=0;i<xs.length;i++){ var p=xs[i].toFixed(1)+','+ys[i].toFixed(1);
    if(cc===null){cc=cs[i];cur=[p];}
    else if(cs[i]===cc){cur.push(p);}
    else { cur.push(p); out+='<polyline points="'+cur.join(' ')+'" fill="none" style="stroke:'+cc+'" stroke-width="'+width+'" stroke-linejoin="round" stroke-linecap="round"/>'; cur=[p]; cc=cs[i]; } }
  if(cur.length>1) out+='<polyline points="'+cur.join(' ')+'" fill="none" style="stroke:'+cc+'" stroke-width="'+width+'" stroke-linejoin="round" stroke-linecap="round"/>';
  return out;
}
// 7-day line: accent inside the band, gold above it, red past 1.5. Series tokens (.rdx scope) resolve to the
// brand hues in dark and the ≥3:1 inks in light; drawn through style="stroke/fill:…" so var() resolves.
function acuteSegColor(acwr){ if(acwr==null) return 'var(--rdx-s1)'; if(acwr>1.5) return 'var(--rdx-spike)'; if(acwr>1.3) return 'var(--rdx-hot)'; return 'var(--rdx-s1)'; }
// Y gridline step: n steps that cover vmax, on a readable number (…, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, …).
function niceStep(vmax,n){ var raw=vmax/n, p=Math.pow(10,Math.floor(Math.log(raw)/Math.LN10)), f=raw/p;
  return [1,1.5,2,2.5,3,4,5,6,8,10].filter(function(x){ return x>=f-1e-9; })[0]*p; }
// Snap a metric series' [lo,hi] outward to 3 round steps (the chart draws 4 gridlines). Pace steps are
// whole seconds; a flat series pads by one step so an integer metric never prints a label twice.
function niceBounds(s, flat){
  var m=s.m, range=s.hi-s.lo, PACE=[5,10,15,20,30,60,120], st;
  var next=function(x){ if(m.pace){ var n=PACE.filter(function(p){ return p>x; })[0]; return n||x*2; } return niceStep(x*1.0001,1); };
  if(m.pace){ st=PACE.filter(function(p){ return p*3>=range; })[0]||Math.ceil(range/180)*60; }
  else st=niceStep(Math.max(range,3*Math.pow(10,-(m.dec||0))),3);
  var a=Math.floor(s.lo/st+1e-9)*st, guard=0;
  if(flat) a-=st;
  while(a+3*st<s.hi-1e-9 && guard++<30){ st=next(st); a=Math.floor(s.lo/st+1e-9)*st; if(flat) a-=st; }
  if(m.zeroFill && s.lo>=0 && a<0) a=0;
  s.lo=a; s.hi=a+3*st;
}
function tickFmt(m,v){ if(m.pace)return fmtPace(v); if(Math.abs(v)>=100)return Math.round(v); return v.toFixed(m.dec===0?0:(m.dec>=2?2:1)); }
function quantile(sorted,q){ var pos=(sorted.length-1)*q, base=Math.floor(pos), rest=pos-base; return sorted[base+1]!==undefined ? sorted[base]+rest*(sorted[base+1]-sorted[base]) : sorted[base]; }
function smoothPts(pts){ var w=Math.max(3,Math.min(21,Math.round(pts.length/8))), half=Math.floor(w/2); return pts.map(function(p,i){ var s=0,c=0; for(var j=Math.max(0,i-half);j<=Math.min(pts.length-1,i+half);j++){ s+=pts[j].v; c++; } return {ts:p.ts,v:s/c}; }); }

/* ---------- hero recommendation ---------- */
// Mean daily load over the last n calendar days (rest days count as 0). Lives in
// run-load-model.js next to the window math so the node harness pins the same numbers.
function avgLast(tl,n){ return RunLoad.avgLast(tl,n); }
// Round to a clean mileage (nearest 0.5), no trailing .0.
function fmtMi(x){ var r=Math.round(x*2)/2; return (r%1===0)?String(r):r.toFixed(1); }
function renderHero(){
  var el=$('hero'); if(!el) return;
  // Anchor on TODAY, not on the athlete's last run day. loadTimeline ends on the last run, so
  // a runner who has not run for five days would otherwise read their last-run-day state: the
  // acute EWMA has decayed in reality but not on screen. extendTimeline zero-pads through today
  // (decaying acute/chronic per padded day, identical to rebuilding from a zero-padded series),
  // so d1 is 0 on a rest day and the acute-trend lookback sees the real calendar. Chart ranges
  // already include today; this is the hero's equivalent.
  var today=new Date();
  var tl=RunLoad.extendTimeline(RunLoad.loadTimeline(loadRuns(), LOAD_PARAMS), today, LOAD_PARAMS);
  var date='<span class="rdx-today-date">'+DOW[today.getDay()]+', '+MONTHS[today.getMonth()]+' '+today.getDate()+'</span>';
  // D3 notes (renderHeroNotes fills it) sit under the instruction line
  var notesEl='<p class="rdx-hero-notes" id="heroNotes" hidden></p>';
  if(tl.length<2){
    el.style.borderLeftColor='var(--muted2)';
    el.innerHTML='<div class="rdx-today-top"><h2 class="rdx-hero-head"><span class="rdx-hero-dot" style="background:var(--muted2)"></span>Building your baseline</h2>'+date+'</div>'+
      '<p class="rdx-today-do">'+(ROLE==='coach' ? 'Daily guidance shows up here once this athlete has a few more weeks of runs.' : 'Import a few more weeks of runs and your daily guidance shows up here.')+'</p>'+notesEl;
    return;
  }
  var pct=leverPct();
  // 1-, 3-, 7-day load windows. The two short windows are PEAK-relative: r1 = today's load ÷
  // the biggest single day of the prior 28, r3 = the last 3 days ÷ the biggest prior 3-day
  // block (RunLoad.shortRatio). r7 = 7-day mean ÷ 28-day mean day, as before — a 7-day window
  // always holds a full week of anyone's schedule, so it is already schedule-neutral.
  // Dividing d1/d3 by the 28-day mean CALENDAR day (which counts rest days as zero) measured
  // run frequency, not load: a 4-day-a-week runner read 1.75× on every ordinary run.
  var W=RunLoad.loadWindows(tl);
  var d1=W.d1, d3=W.d3, d7=W.d7, d28=W.d28, base=W.base, r1=W.r1, r3=W.r3, r7=W.r7;
  var demoOn=false;
  // Admin demo override: swap in a fixed scenario's windows (real data untouched).
  if(DEMO && DEMO_PRESETS[DEMO]){
    demoOn=true; var sc=DEMO_PRESETS[DEMO];
    if(sc.nullBase){ base=null; d1=d3=d7=d28=0; r1=r3=r7=null; }
    else { base=sc.base; d28=sc.base; r1=sc.r1; r3=sc.r3; r7=sc.r7; d1=r1*base; d3=r3*base; d7=r7*base; }
  }
  // Tile tints: the detraining (< 0.8 → warn) branch only means something against an average.
  // A peak-relative ratio sits below 0.8 on every ordinary weekday — that is what having a
  // biggest day means, not a sign of detraining — so the 1- and 3-day tiles skip it.
  var peakColor=function(r){ return (r!=null && r<0.8) ? 'var(--good)' : acwrColor(r); };
  var col1=peakColor(r1), col3=peakColor(r3), col7=acwrColor(r7);

  // Typical single-run Impact Load (median of the last ~6 weeks of runs, anchored at today) — used
  // to turn the daily load budget into a concrete session size. Falls back to the 28-day daily
  // base × 1.4 (a rough per-run figure) when there isn't enough per-run data or a demo scenario
  // is forcing the windows.
  var todayTs=tl[tl.length-1].ts;
  var loads = demoOn ? [] : loadRuns().filter(function(r){ return r.ts>=todayTs-42*864e5; })
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

  var coach=ROLE==='coach';
  var head, accent, todo, lo=null, hi=null, flat=null, hilly=null, lever=null, leverInTarget=false;
  if(base==null){
    head='Building your baseline'; accent='var(--muted2)';
    todo=coach ? 'Easy runs or Lever runs while we learn their baseline.' : 'Easy runs or Lever runs while we learn your baseline.';
  } else {
    // Recovery state from the recent-load ratios → session volume band (× typical run) and a one-line
    // call. Driven by the MAX of the 1/3/7-day ratios so a loaded recent block counts even when the
    // weekly average looks flat. Volume band is anchored to the chronic base (the 0.8–1.3 safe band)
    // and shifted by how loaded the last few days have been.
    // maxR's three inputs no longer share a denominator: 1.0 means "level with your biggest recent
    // block" when r1/r3 leads and "level with your average day" when r7 leads; the 1.15/1.3/1.5
    // thresholds read as 15/30/50% beyond whichever that is.
    // The thresholds, headlines, accents and loMult/hiMult are the model — copy changes go in `todo` only.
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
    // Translate the top-end budget (hi, in IAD miles) into concrete run options:
    //   flat easy outside ≈ 1 impact mi/mi · rolling/hilly inflates ~25% · Lever offloads, so more
    //   actual miles fit under the same impact budget. The Lever conversion MUST go through
    //   RunLoad.impactPerMileAtLoad (lever mi = budget ÷ (1 − 0.85·offload)) — the same discount
    //   impactLoad scores with — otherwise a prescribed Lever distance no longer earns back its
    //   own budget.
    flat=hi; hilly=hi/1.25; lever=hi/RunLoad.impactPerMileAtLoad(pct, LOAD_PARAMS);
    // The Lever rides on the target line only when the call is to back off (gold/red states).
    leverInTarget = accent==='var(--gold)' || accent==='var(--bad)';
  }

  // ---- markup only from here ----
  // Visible: headline + date, one instruction line, the D3 notes, then two numbers — today's target
  // (with its flat/hilly[/Lever] equivalents) and the 7-day ratio against the 0.8–1.3 safe band. The
  // Acute trend shows on the face only in "Climbing fast"; everything else lives in Details: the 1-/3-day
  // load vs the biggest comparable block of the prior 28 days, the 28-day base, the trend, the full
  // run-equivalents list and the easy-pace anchor.
  var statTile=function(k,val,unit,c,sub){ return '<div class="rdx-stat"><div class="k">'+k+'</div><div class="v">'+val.toFixed(1)+'<small>'+unit+'</small></div>'+
    (sub?'<div class="x"'+(c?' style="color:'+ink(c)+'"><i style="background:'+c+'"></i>':'>')+'<span>'+sub+'</span></div>':'')+'</div>'; };
  // Acute trend: weekly rate of rise of the acute curve, tinted by how steep (rising fast is a
  // leading signal even when the ratio is still in band). '—' when there isn't enough history.
  // A decline reads muted, not green (presentation only; the thresholds are unchanged).
  var rampTxt = rampPerWk==null ? '—' : (rampPerWk>=0?'+':'')+Math.round(rampPerWk*100)+'%';
  var rampCol = rampPerWk==null ? 'var(--muted2)' : rampPerWk>=0.20 ? 'var(--bad)' : rampPerWk>=0.10 ? 'var(--gold)' : 'var(--muted2)';
  var trendRow=function(cls){ return '<div class="rdx-trend'+(cls||'')+'"><span class="k">Acute trend</span><span class="v" style="color:'+ink(rampCol)+'">'+rampTxt+'</span><span class="x">per week · how fast the 7-day load is changing</span></div>'; };
  // Footnote: the easy-pace P₀ every run's pace term is scored against — a calibration anchor, NOT
  // an average of recent runs. Only when a rung is in force (calibrated median or the profile).
  var baseSrc=LOAD_PARAMS&&LOAD_PARAMS.basePaceSource;
  var baseTxt=(LOAD_PARAMS&&LOAD_PARAMS.basePaceSec>0&&baseSrc) ? 'Scored against '+who()+' easy pace, '+fmtPace(LOAD_PARAMS.basePaceSec)+' /mi ('+(baseSrc==='profile'?'from the profile':'grade-adjusted, from easy runs')+').' : '';
  // 7-day position on a 0.4–1.8 track with the 0.8–1.3 safe band shaded (decoration; the ratio is in text)
  var bandPos=function(x){ return (Math.max(0.4,Math.min(1.8,x))-0.4)/1.4*100; };
  var isClimb = head==='Climbing fast — ease the ramp';
  // Runs on today's local calendar day — the same day the Last day tile (d1) covers. Demo scenarios
  // are not the athlete's data, so they always show the target.
  var todayRuns = demoOn ? [] : loadRuns().filter(function(r){ return daysAgo(r.ts)===0; });
  var todayMi = todayRuns.reduce(function(a,r){ return a+(r.distMi||0); },0);
  var nums='';
  if(base!=null){
    nums='<div class="rdx-today-nums">'+
      (todayRuns.length ?
      // Already ran today: report the run(s) — distance plus today's load (d1, the Last day tile's value) —
      // and keep the target as a muted caption. The equivalents only help before running.
      '<div class="rdx-today-num rdx-today-target rdx-today-ran"><div class="k">Today’s run'+(todayRuns.length>1?'s':'')+'</div>'+
        '<div class="v"><span><span data-v="todayMi">'+todayMi.toFixed(1)+'</span><small>mi</small></span>'+
          '<span class="iad"><span data-v="todayIad">'+d1.toFixed(1)+'</span><small>IAD mi</small></span></div>'+
        (todayRuns.length>1?'<div class="x" data-v="todayN">'+todayRuns.length+' runs</div>':'')+
        '<div class="x">target <span data-v="lo">'+fmtMi(lo)+'</span>–<span data-v="hi">'+fmtMi(hi)+'</span> mi</div>'+
      '</div>' :
      '<div class="rdx-today-num rdx-today-target"><div class="k">Today’s target</div>'+
        '<div class="v"><span data-v="lo">'+fmtMi(lo)+'</span>–<span data-v="hi">'+fmtMi(hi)+'</span><small>mi</small></div>'+
        '<div class="x"><span>≈ <b data-v="flat">'+fmtMi(flat)+'</b> mi flat</span> · <span><b data-v="hilly">'+fmtMi(hilly)+'</b> hilly</span>'+
          (leverInTarget?' · <span><b class="lever" data-v="lever">'+fmtMi(lever)+'</b> mi on the Lever</span>':'')+'</div>'+
      '</div>')+
      '<div class="rdx-today-num rdx-today-r7"><div class="k">7-day load</div>'+
        '<div class="v"><span data-v="r7">'+r7.toFixed(1)+'</span>×<small>'+who('their')+' base</small></div>'+
        '<div class="rdx-band" aria-hidden="true"><span class="rdx-band-safe" style="left:'+bandPos(0.8)+'%;width:'+(bandPos(1.3)-bandPos(0.8))+'%"></span>'+
          '<i style="left:'+bandPos(r7)+'%;background:'+col7+'"></i></div>'+
        '<div class="x">Safe band 0.8–1.3×</div>'+
      '</div>'+
    '</div>'+
    (isClimb ? trendRow(' rdx-today-trend') : '');
  }
  var equiv = base!=null ?
    '<p class="rdx-hero-cap">At the top of today’s target ('+fmtMi(hi)+' impact-adjusted miles), that’s about:</p>'+
    '<ul class="rdx-do-opts">'+
      '<li><b>'+fmtMi(flat)+' mi</b> flat easy outside</li>'+
      '<li><b>'+fmtMi(hilly)+' mi</b> hilly outside</li>'+
      '<li class="lever-opt"><b data-v="leverAll">'+fmtMi(lever)+' mi</b> on the Lever · '+pct+'% BW</li>'+
    '</ul>' : '';
  el.style.borderLeftColor=accent;
  el.innerHTML='<div class="rdx-today-top"><h2 class="rdx-hero-head"><span class="rdx-hero-dot" style="background:'+accent+'"></span>'+head+'</h2>'+date+'</div>'+
    '<p class="rdx-today-do">'+todo+'</p>'+notesEl+nums+
    '<details class="rdx-more rdx-today-more" id="heroMore"'+(HERO_MORE?' open':'')+'><summary>Details</summary><div class="rdx-more-body">'+
      '<p class="rdx-hero-cap">Recent load · IAD mi per day, through today</p>'+
      '<div class="rdx-stat-grid">'+
        statTile('Last day', d1, 'IAD mi', d1>0?col1:null, r1!=null?r1.toFixed(1)+'× biggest day (28d)':'')+
        statTile('3-day avg', d3, 'IAD mi/day', col3, r3!=null?r3.toFixed(1)+'× biggest 3-day avg (28d)':'')+
        statTile('28-day base', d28, 'IAD mi/day', null, who()+' average day')+
      '</div>'+
      (isClimb?'':trendRow())+equiv+
      '<p class="rdx-today-foot">'+(baseTxt?baseTxt+' ':'')+'<button type="button" class="rdx-linkbtn" id="heroHelpBtn" aria-expanded="'+HERO_HELP+'" aria-controls="heroHelp">How to read these numbers</button></p>'+
      '<p class="rdx-hero-help" id="heroHelp"'+(HERO_HELP?'':' hidden')+'>IAD (Impact Adjusted Distance): one easy, flat mile = 1 IAD mi. Faster, harder-landing or hillier miles count for more; Lever miles count for less. '+
        'Today’s target is a load budget for the day in IAD mi; the flat, hilly and Lever distances are what fit under its top end. '+
        'Last day (today so far) and 3-day avg are compared with the biggest day and biggest 3-day stretch of the past 28 days. 7-day load is the 7-day average day compared with the 28-day base — '+who()+' average day, rest days included. '+
        'Acute trend is how fast the 7-day load is changing per week. The easy pace is the anchor every run is scored against, not a recent average. A load measure, not an injury prediction.</p>'+
    '</div></details>';
  // HERO_MORE / HERO_HELP keep the disclosure states across refresh() re-renders
  $('heroMore').addEventListener('toggle',function(){ HERO_MORE=this.open; });
  $('heroHelpBtn').addEventListener('click',function(){ HERO_HELP=!HERO_HELP; this.setAttribute('aria-expanded',String(HERO_HELP)); $('heroHelp').hidden=!HERO_HELP; });
}
// Muted D3 notes INSIDE the Today card, under the instruction line (#heroNotes is rendered by renderHero):
// a baseline that is still forming, a week with no runs. The coach view no longer adds "As the athlete
// sees it" — its instruction line is written in the third person. Demo scenarios skip the data notes.
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
// State tint as TEXT: the brand good/warn/bad/gold fail contrast on light surfaces — use the ink tokens.
function ink(c){ return {'var(--good)':'var(--rdx-good-ink)','var(--warn)':'var(--rdx-warn-ink)','var(--bad)':'var(--rdx-bad-ink)','var(--gold)':'var(--rdx-gold-ink)'}[c]||c; }
// Admin-only scenario switcher above the hero (demo control).
function renderDemoBar(){
  if(!ADMIN) return; var el=$('demobar'); if(!el) return;
  var items=[{key:'',label:'● Live'}].concat(DEMO_LIST);
  el.innerHTML='<span class="lbl">Demo</span>'+items.map(function(it){
    var on=(DEMO||'')===it.key;
    return '<span class="rdx-chip'+(on?' on':'')+'" data-demo="'+it.key+'">'+it.label+'</span>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('.rdx-chip'),function(c){
    c.onclick=function(){ DEMO=this.getAttribute('data-demo')||null; renderHero(); renderHeroNotes(); renderDemoBar(); };
  });
}

/* ---------- unified chart: load (default) or metric trend ---------- */
function renderChart(){
  var sel=$('chartView'); if(!sel) return;
  var v=sel.value, isLoad=(v==='load'), m=METRICS[+v];
  $('chartView2Wrap').hidden=isLoad; $('dispWrap').hidden=isLoad;
  var cap=$('chartCapTxt');
  if(cap) cap.textContent=isLoad ? 'A load measure, not an injury prediction. The lines are weighted averages, so they can differ slightly from the plain averages in Today. '
    : 'One easy flat mile = 1 IAD mi; harder or hillier miles count for more. A load measure, not an injury prediction. ';
  $('chartCaption').hidden=!(isLoad||(m&&m.key==='impact'));
  $('chartTitle').textContent=isLoad?'Load over time':(m?m.label:'Metric')+' over time';
  $('chartSub').textContent=isLoad
    ? who('Your')+' 7-day load against '+who('their')+' 28-day base, in IAD mi per day, with the safe band shaded.'
    : m ? m.desc+(m.zeroFill?'. Rest days read 0.':'. One value per run.') : '';
  if(isLoad) renderLoadChart(); else renderMetricChart();
}
// Geometry at the box's real width: the SVG draws 1:1, so 11px axis text stays 11px on a phone.
// CHART_W records the width drawn at, for the resize watcher.
function chartDims(box,padR){
  CHART_W=box.clientWidth;
  var W=Math.max(300,Math.min(1100,CHART_W||720)), H=Math.max(220,Math.min(320,Math.round(W*0.3)));
  return {W:W,H:H,padL:44,padR:padR,padT:24,padB:26,innerW:W-44-padR,innerH:H-50,maxTicks:W<500?4:8};
}
// Month labels along the bottom; one too close to the right edge anchors at its end so it isn't clipped.
function xTicksSVG(t0,t1,D,xOf){
  var short=t1-t0<45*DAY;
  return axisTicks(t0,t1,D.maxTicks).map(function(ts,idx){ if(ts<t0||ts>t1) return ''; var x=xOf(ts);
    return '<text x="'+x.toFixed(1)+'" y="'+(D.H-8)+'" text-anchor="'+(x>D.W-28?'end':'middle')+'">'+axisLabel(ts,idx,short)+'</text>'; }).join('');
}
// Legend entries for the logged-event types drawn in [t0,t1] (same in-range test as the overlay),
// in their locked colours and labels; skip = types already in the legend as a marker.
var EV_HEX={ injury:'#f55050', race:'#22c78a', illness:'#f59a4d', nonrun:'#ef6bab', timeoff:'#5b9cf5' };
function evLegendHTML(t0,t1,skip){
  var have={};
  events().forEach(function(e){ var end=(e.endTs!=null&&e.endTs>e.ts)?e.endTs:null; if(e.ts!=null && (end||e.ts)>=t0 && e.ts<=t1) have[EV_META[e.type]?e.type:'race']=1; });
  return ['race','injury','illness','nonrun','timeoff'].filter(function(t){ return have[t]&&!(skip&&skip[t]); })
    .map(function(t){ return '<span class="rdx-legend-item"><span class="rdx-legend-ev" style="--c:'+EV_HEX[t]+'"></span>'+EV_META[t][0]+'</span>'; }).join('');
}
// The caption under the chart: a tap hint when the overlay drew anything (each band/marker carries a
// <title>), otherwise empty (and hidden). The listeners are wired once in wireEventCap().
// RunLoad's overlay <title>s read "⚠ Injury · 2025-08-11 – …"; swap in the view's own labels ("Injury · Aug 11 – 29,
// 2025 — note"). One <title> per drawn event, in events() order, with the overlay's own range test.
function evOverlaySVG(t0,t1,padL,innerW,padT,innerH){
  var ev=events(), i=0, drawn=ev.filter(function(e){ var end=(e.endTs!=null&&e.endTs>e.ts)?e.endTs:null; return e.ts!=null && (end||e.ts)>=t0 && e.ts<=t1; });
  return RunLoad.eventOverlaySVG(ev,t0,t1,padL,innerW,padT,innerH).replace(/<title>[\s\S]*?<\/title>/g,function(m){ var e=drawn[i++]; return e?'<title>'+esc(evLabel(e)+(e.note?' — '+e.note:''))+'</title>':m; });
}
var RANGE_BAD_MSG='Pick a valid date range — From must be before To.';
function evCapReset(box){ CAP_PIN=box.querySelector('svg title')?(window.matchMedia&&matchMedia('(hover:hover)').matches?'Hover or click a shaded band or marker to see what it was.':'Tap a shaded band or marker to see what it was.'):''; var c=$('chartEvCap'); if(c) c.textContent=CAP_PIN; }
function renderLoadChart(){
  var legEl=$('chartLegend'), chartEl=$('chartBox');
  if(!chartEl) return;
  chartEl.onmousemove=chartEl.onmouseleave=chartEl.onpointerdown=chartEl.onkeydown=null;   // the other chart's tooltip/readout handlers
  // Padded through today like the hero, so the acute curve decays across rest days since the
  // last run instead of stopping on it; the To-date filter below still trims it to the range.
  var full=RunLoad.extendTimeline(RunLoad.loadTimeline(loadRuns(), LOAD_PARAMS), new Date(), LOAD_PARAMS);
  if(full.length<2){ legEl.innerHTML=''; chartEl.innerHTML='<div class="rdx-chart-empty">Not enough history to model load yet.</div>'; evCapReset(chartEl); return; }
  var from=parseDate($('tFrom').value), to=parseDate($('tTo').value);
  if(from&&to&&dayEnd(to).getTime()<from.getTime()){ legEl.innerHTML=''; chartEl.innerHTML='<div class="rdx-chart-empty">'+RANGE_BAD_MSG+'</div>'; evCapReset(chartEl); return; }
  var f0=from?from.getTime():full[0].ts, f1=to?dayEnd(to).getTime():full[full.length-1].ts;
  var tl=full.filter(function(d){return d.ts>=f0&&d.ts<=f1;}), tooShort=false;
  if(tl.length<2){ tl=full; tooShort=true; }   // window too narrow — show everything
  var last=tl[tl.length-1];
  var D=chartDims(chartEl,12), W=D.W, H=D.H, padL=D.padL, padR=D.padR, padT=D.padT, innerW=D.innerW, innerH=D.innerH;
  // one domain rule with the metric chart: the axis starts at the selected From, even when the
  // history starts later (the lines are drawn only where data exists, with a "History starts" mark)
  var t0=(!tooShort && from && f0<tl[0].ts) ? f0 : tl[0].ts, t1=last.ts, span=Math.max(1,t1-t0);
  // 4 gridlines (0 + 3 steps) on round numbers; the top one clears the band's upper edge
  var step=niceStep(Math.max.apply(null,tl.map(function(d){return Math.max(d.acute,d.chronic*1.3);}))*1.05||1, 3), ymax=step*3;
  var xOf=function(ts){return padL+((ts-t0)/span)*innerW;};
  var yOf=function(v){return padT+innerH-(v/ymax)*innerH;};
  var acuteS=smoothArr(tl.map(function(d){return d.acute;}),5), chronicS=smoothArr(tl.map(function(d){return d.chronic;}),5);
  var xs=tl.map(function(d){return xOf(d.ts);});
  var bandTop=tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]*1.3).toFixed(1);});
  var bandBot=tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]*0.8).toFixed(1);}).reverse();
  var band='<polygon points="'+bandTop.concat(bandBot).join(' ')+'" style="fill:var(--rdx-band);stroke:var(--rdx-band-line)" stroke-width="0.5"/>';
  var chronicLn='<polyline points="'+tl.map(function(d,i){return xs[i].toFixed(1)+','+yOf(chronicS[i]).toFixed(1);}).join(' ')+'" fill="none" style="stroke:var(--rdx-s2)" stroke-width="2.2" stroke-linejoin="round"/>';
  var acuteLn=coloredPath(xs, acuteS.map(yOf), tl.map(function(d){return acuteSegColor(d.acwr);}), 2.6);
  var grid='<text class="rdx-ax-lbl" x="2" y="13">IAD mi/day</text>', dec=0;   // as many decimals as the step needs — never "0, 0, 0"
  while(dec<6 && Math.abs(step*Math.pow(10,dec)-Math.round(step*Math.pow(10,dec)))>1e-9) dec++;
  if(t0<tl[0].ts){ var hx=xs[0].toFixed(1);
    grid+='<line class="rdx-today" x1="'+hx+'" y1="'+(padT-4)+'" x2="'+hx+'" y2="'+(padT+innerH)+'"/>'+
      '<text class="rdx-ax-lbl" x="'+hx+'" y="'+(padT-8)+'" text-anchor="'+(xs[0]>W/2?'end':'start')+'">History starts '+fmtMD(tl[0].ts)+'</text>'; }
  for(var g=0;g<=3;g++){ var yy=padT+innerH-g/3*innerH;
    grid+='<line class="rdx-grid" x1="'+padL+'" y1="'+yy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+yy.toFixed(1)+'"/>'+
      '<text x="'+(padL-6)+'" y="'+(yy+4).toFixed(1)+'" text-anchor="end">'+(g===0?'0':String(parseFloat((step*g).toFixed(dec))))+'</text>'; }
  // the range ends today: mark it (the hero reads this same day)
  var todayM='';
  if(ymd(new Date(last.ts))===ymd(new Date())){ var tx=xs[xs.length-1].toFixed(1);
    todayM='<line class="rdx-today" x1="'+tx+'" y1="'+(padT-4)+'" x2="'+tx+'" y2="'+(padT+innerH)+'"/>'+
      '<text class="rdx-ax-lbl rdx-today-lbl" x="'+tx+'" y="'+(padT-8)+'" text-anchor="end">Today</text>'+
      '<circle class="rdx-today-dot" cx="'+tx+'" cy="'+yOf(acuteS[acuteS.length-1]).toFixed(1)+'" r="4.5" style="fill:'+acuteSegColor(last.acwr)+'"/>'; }
  var aMin=Math.min.apply(null,acuteS), aMax=Math.max.apply(null,acuteS);
  var loadAria='Load over time, '+fmtDay(t0)+' – '+fmtDay(t1)+': '+(ymd(new Date(last.ts))===ymd(new Date())?'today':'on '+fmtDay(last.ts))+' 7-day load '+last.acute.toFixed(1)+' vs 28-day base '+last.chronic.toFixed(1)+' IAD mi per day; 7-day load ranged '+aMin.toFixed(1)+'–'+aMax.toFixed(1)+' in this range. Use the left and right arrow keys to read each day.';
  var li=function(sw,txt){ return '<span class="rdx-legend-item">'+sw+txt+'</span>'; };
  legEl.innerHTML=li('<span class="rdx-legend-sw" style="background:var(--rdx-s1)"></span>','7-day load')+
    li('<span class="rdx-legend-sw" style="background:var(--rdx-s2)"></span>','28-day base')+
    li('<span class="rdx-legend-sw rdx-legend-band"></span>','Safe band (0.8–1.3× base)')+
    (tl.some(function(d){ return d.acwr!=null&&d.acwr>1.3; })?li('<span class="rdx-legend-sw" style="background:linear-gradient(90deg,var(--rdx-hot),var(--rdx-spike))"></span>','Above the band'):'')+
    evLegendHTML(t0,t1);
  var xh='<g class="rdx-xh" visibility="hidden"><line class="rdx-xh-ln" y1="'+padT+'" y2="'+(padT+innerH)+'"/><circle class="rdx-xh-dot" r="4.5"/></g>';
  chartEl.innerHTML='<svg class="rdx-chart-svg rdx-load-svg" viewBox="0 0 '+W+' '+H+'" role="img" tabindex="0" aria-label="'+esc(loadAria)+'">'+grid+band+chronicLn+acuteLn+xTicksSVG(t0,t1,D,xOf)+todayM+evOverlaySVG(t0,t1,padL,innerW,padT,innerH)+xh+'</svg>';
  wireLoadReadout(chartEl, tl, xs, acuteS.map(yOf), W, padL, innerW);
  evCapReset(chartEl);
  if(tooShort){ CAP_PIN='Range too short — showing all history.'; var cp=$('chartEvCap'); if(cp) cp.textContent=CAP_PIN; }
}
function renderMetricChart(){
  var chart=$('chartBox'), legend=$('chartLegend');
  if(!chart) return;
  // Smooth draws the trend line; Hide outliers drops glitch values (keeps logged races/injuries, and
  // detected hard efforts while Points is on); Points shows every run and the hard-effort rings. Runs missing a metric leave a gap in its line;
  // Impact Load drops to 0 on rest days and is never outlier-filtered (big days are real training).
  var bail=function(msg){ legend.innerHTML=''; chart.innerHTML='<div class="rdx-chart-empty">'+msg+'</div>'; evCapReset(chart); };
  var i1=$('chartView').value, i2=$('chartView2').value;
  var from=parseDate($('tFrom').value), to=parseDate($('tTo').value);
  var series=[];
  if(i1!=='') series.push({m:METRICS[+i1],color:'var(--rdx-s1)'});
  if(i2!==''&&i2!==i1) series.push({m:METRICS[+i2],color:'var(--rdx-s2)'});
  var evMap=new Map(); events().forEach(function(e){ if(e.type!=='injury'&&e.type!=='race') return; evMap.set(ymd(new Date(e.ts)), e.type); });
  var evType=function(p){ return evMap.get(ymd(p.date))||null; };
  var maxIds=RunLoad.maxEffortIds(typeRuns());
  if(!series.length){ bail('Select a metric to plot.'); return; }
  if(!from||!to||dayEnd(to).getTime()<=from.getTime()){ bail(from&&to?RANGE_BAD_MSG:'Pick a valid date range.'); return; }
  var hideOut=$('hideOutliers').classList.contains('on');
  var smooth=$('smooth').classList.contains('on');
  var showPts=$('points').classList.contains('on');
  // runsIn is exclusive on start and inclusive on end: back the start off by 1ms so runs at
  // exactly local midnight count, and extend the end through the whole To day — otherwise a
  // run logged the morning of the To date (ts past midnight) never plots.
  var runs=runsInF(new Date(from.getTime()-1),dayEnd(to));
  var evColor=function(t){ return t==='injury'?'var(--rdx-spike)':'var(--rdx-good-ink)'; };
  series.forEach(function(s){
    var mapped=runs.map(function(r){return {ts:r.ts,v:s.m.calc(r),date:r.date,id:r.id,dist:r.distMi,pace:r.paceSec,title:r.title};}).sort(function(a,b){return a.ts-b.ts;});
    // A run that exists but lacks this metric (no pod/strap that day, manual entry) splits
    // the line into segments — bridging it would draw continuity the device never measured.
    // Rest days between measured runs still connect, and zero-filled volume metrics keep a
    // single segment (their rest-day zeros cover the gaps; an unmodelable run reads as a
    // 0-load day, matching how the acute/chronic chart's dailyLoads treats it).
    var seg=0, all=[];
    mapped.forEach(function(p){
      if(p.v==null||isNaN(p.v)){ if(!s.m.zeroFill) seg++; return; }
      p.seg=seg; all.push(p);
    });
    var flo=-Infinity, fhi=Infinity;
    // Glitch fence, not a workout fence. At 1.5×IQR, homogeneous training (easy paces
    // clustering tightly) collapses the fence onto the cluster and genuine hard efforts
    // get dropped as "outliers" — and detection can't always rescue them (Strava-synced
    // runs carry no Training Effect). Sensor glitches are order-of-magnitude wrong, so a
    // far-out fence — 3×IQR, never tighter than 25% of the median — still drops them
    // while keeping real workouts visible. Volume metrics (Impact Load) skip the fence
    // entirely: a long run at 3× an easy day is the signal, not a glitch, and the load
    // model already caps glitch leverage (neutral factor for absent dynamics, grade cap,
    // distance floor).
    if(!s.m.zeroFill && all.length>=5){
      var vals=all.map(function(p){return p.v;}).slice().sort(function(a,b){return a-b;});
      var q1=quantile(vals,0.25), q3=quantile(vals,0.75), iqr=q3-q1, med=quantile(vals,0.5);
      if(iqr>0){ var half=Math.max(3*iqr, 0.25*Math.abs(med)); flo=q1-half; fhi=q3+half; }
    }
    var inF=function(p){ return p.v>=flo&&p.v<=fhi; };
    s.line = hideOut ? all.filter(inF) : all;
    s.dots = hideOut ? all.filter(function(p){return inF(p)||evType(p)||(showPts&&maxIds.has(p.id));}) : all;
    // Volume metrics (Impact Load): a day without a run is a real 0, so the line drops to
    // zero on rest days — matching how the acute/chronic chart's daily loads treat them —
    // instead of connecting run to run. Zeros shape the line only: no dot, no hover target.
    if(s.m.zeroFill && all.length>1){
      var has=new Set(all.map(function(p){ var d=new Date(p.ts); d.setHours(0,0,0,0); return d.getTime(); }));
      var zeros=[], cur=new Date(all[0].ts); cur.setHours(0,0,0,0);
      var endDay=new Date(all[all.length-1].ts); endDay.setHours(0,0,0,0);
      while(cur.getTime()<endDay.getTime()){
        if(!has.has(cur.getTime())) zeros.push({ts:cur.getTime()+DAY/2, v:0});
        cur.setDate(cur.getDate()+1); cur.setHours(0,0,0,0);
      }
      s.line=s.line.concat(zeros).sort(function(a,b){return a.ts-b.ts;});
    }
    var scaleSrc = s.dots.length ? s.dots : all;
    if(scaleSrc.length){ var mn=Math.min.apply(null,scaleSrc.map(function(p){return p.v;})), mx=Math.max.apply(null,scaleSrc.map(function(p){return p.v;})); var pad=(mx-mn)*0.08; s.lo=mn-pad; s.hi=mx+pad; if(s.m.zeroFill) s.lo=Math.min(s.lo,0); niceBounds(s, mn===mx); }
  });
  var have=series.filter(function(s){return s.dots.length;});
  if(!have.length){ bail('No runs with this metric in range.'); return; }
  var D=chartDims(chart,series.length>1?46:12), W=D.W, H=D.H, padL=D.padL, padR=D.padR, padT=D.padT, innerW=D.innerW, innerH=D.innerH;
  var t0=from.getTime(),t1=dayEnd(to).getTime();
  var xOf=function(ts){return padL+((ts-t0)/(t1-t0))*innerW;};
  // pace reads faster-on-top (a lower /mi value is the better, higher point)
  var yOf=function(v,s){ var f=(v-s.lo)/(s.hi-s.lo); return s.m.pace ? padT+f*innerH : padT+innerH-f*innerH; };
  var valAt=function(s,f){ return s.m.pace ? s.hi-(s.hi-s.lo)*f : s.lo+(s.hi-s.lo)*f; };   // value at height fraction f
  // 4 gridlines; the left axis (and its unit, top-left) belongs to the first plotted series, the
  // right one (purple) to the overlay
  var s2=series.length>1&&series[1].dots.length?series[1]:null;
  var grid=(have[0].m.unit?'<text class="rdx-ax-lbl" x="2" y="13">'+have[0].m.unit+'</text>':'')+
    (s2&&s2.m.unit?'<text class="rdx-ax-lbl rdx-ax2" x="'+(W-2)+'" y="13" text-anchor="end">'+s2.m.unit+'</text>':'');
  for(var g=0;g<=3;g++){
    var f=g/3, yy=(padT+innerH-f*innerH).toFixed(1);
    grid+='<line class="rdx-grid" x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'"/>';
    grid+='<text x="'+(padL-6)+'" y="'+(parseFloat(yy)+4).toFixed(1)+'" text-anchor="end">'+tickFmt(have[0].m,valAt(have[0],f))+'</text>';
    if(s2) grid+='<text class="rdx-ax2" x="'+(W-padR+6)+'" y="'+(parseFloat(yy)+4).toFixed(1)+'" text-anchor="start">'+tickFmt(s2.m,valAt(s2,f))+'</text>';
  }
  var xlab=xTicksSVG(t0,t1,D,xOf);
  var ea=function(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var lines='', hits='';
  var haloStroke=document.documentElement.getAttribute('data-theme')==='light'?'rgba(0,0,0,0.30)':'rgba(255,255,255,0.85)';
  have.forEach(function(s){
    // Draw each gap-delimited segment as its own polyline (smoothed independently, so the
    // moving average never averages across a gap). A segment reduced to a single point
    // would otherwise vanish when Points is off — give it a dot so the data stays visible.
    var segs=[]; s.line.forEach(function(p){ var k=p.seg||0; (segs[k]=segs[k]||[]).push(p); });
    segs.forEach(function(segPts){
      var lineSrc=smooth?smoothPts(segPts):segPts;
      if(lineSrc.length>1){ var pts=lineSrc.map(function(p){return xOf(p.ts).toFixed(1)+','+yOf(p.v,s).toFixed(1);});
        lines+='<polyline points="'+pts.join(' ')+'" fill="none" style="stroke:'+s.color+'" stroke-width="'+(smooth?2.6:2)+'" stroke-linejoin="round" stroke-linecap="round"/>'; }
      else if(lineSrc.length===1&&!showPts){ lines+='<circle cx="'+xOf(lineSrc[0].ts).toFixed(1)+'" cy="'+yOf(lineSrc[0].v,s).toFixed(1)+'" r="2.4" style="fill:'+s.color+'"/>'; }
    });
    lines+=s.dots.map(function(p){
      var t=evType(p), isMax=!t&&maxIds.has(p.id), cx=xOf(p.ts).toFixed(1), cy=yOf(p.v,s).toFixed(1);
      if(t) return '<circle cx="'+cx+'" cy="'+cy+'" r="3.8" style="fill:'+evColor(t)+'" stroke="'+haloStroke+'" stroke-width="1.2"/>';
      // Hard-effort rings follow the Points toggle (race/injury dots always draw).
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
  // legend: the series, then only the markers actually plotted, then the overlay's other event types
  var mk={};
  have.forEach(function(s){ s.dots.forEach(function(p){ var t=evType(p); if(t) mk[t]=1; else if(showPts&&maxIds.has(p.id)) mk.max=1; }); });
  var li=function(sw,txt){ return '<span class="rdx-legend-item">'+sw+txt+'</span>'; };
  legend.innerHTML=series.map(function(s){ var none=!s.dots.length;
      return li('<span class="rdx-legend-sw" style="background:'+s.color+(none?';opacity:.4':'')+'"></span>', s.m.label+(s.m.unit?' ('+s.m.unit+')':'')+(none?' — no data in this range':'')); }).join('')+
    (mk.race?li('<span class="rdx-legend-dot" style="background:var(--rdx-good-ink)"></span>','Race'):'')+
    (mk.injury?li('<span class="rdx-legend-dot" style="background:var(--rdx-spike)"></span>','Injury'):'')+
    (mk.max?li('<span class="rdx-legend-ring"></span>','Hard effort'):'')+
    evLegendHTML(t0,t1,mk);
  var av=have[0].dots.map(function(p){ return p.v; });
  var metricAria=have[0].m.label+' over time, '+fmtDay(t0)+' – '+fmtDay(t1)+': '+have[0].dots.length+' run'+(have[0].dots.length===1?'':'s')+', '+tickFmt(have[0].m,Math.min.apply(null,av))+'–'+tickFmt(have[0].m,Math.max.apply(null,av))+(have[0].m.unit?' '+have[0].m.unit:'')+'.';
  chart.innerHTML='<svg class="rdx-chart-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(metricAria)+'">'+grid+xlab+lines+evOverlaySVG(t0,t1,padL,innerW,padT,innerH)+hits+'</svg>';
  wireChartTip(chart);
  evCapReset(chart);
}
// dataset values come back attribute-DECODED (ctx holds the run title) — re-escape before innerHTML.
// Load-chart readout (D3): hover, tap or ←/→ (Shift = a week, Home/End) on the focused chart moves a
// crosshair to a day and shows "date · 7-day · base · ratio". Numbers are the model's daily values (the
// EWMA series the legend names, unsmoothed); the crosshair dot sits on the drawn (smoothed) line.
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
// The marker chip keeps its locked hex as the border; its TEXT takes the ink token (the hexes fail on a light tooltip).
function chartTipHTML(c){
  var k=c.dataset.kind, m={race:['Race','#22c78a','var(--rdx-good-ink)'],injury:['Injury','#f55050','var(--rdx-bad-ink)'],max:['Hard Effort','#f5c842','var(--rdx-gold-ink)']}[k];
  return '<div class="rdx-tip-top">'+esc(c.dataset.date)+(m?' <span class="rdx-tip-chip" style="color:'+m[2]+';border-color:'+m[1]+'">'+m[0]+'</span>':'')+'</div>'
    +'<div class="rdx-tip-val">'+esc(c.dataset.metric)+' · <b>'+esc(c.dataset.val)+'</b></div>'
    +(c.dataset.ctx?'<div class="rdx-tip-ctx">'+esc(c.dataset.ctx)+'</div>':'');
}
// Hover shows a point's tooltip; a tap (pointerdown from touch or pen) does the same, and a tap
// anywhere else closes it. Property handlers: each redraw replaces them (renderLoadChart clears them).
function wireChartTip(chart){
  var tip=document.createElement('div'); tip.className='rdx-chart-tip'; chart.appendChild(tip);
  var show=function(e){ var c=e.target.closest&&e.target.closest('.rdx-hit'); if(!c){ tip.classList.remove('on'); return; }
    tip.innerHTML=chartTipHTML(c); tip.classList.add('on');
    var r=chart.getBoundingClientRect(), x=e.clientX-r.left+14, y=e.clientY-r.top+14;
    if(x+tip.offsetWidth>r.width) x=e.clientX-r.left-tip.offsetWidth-14;
    if(y+tip.offsetHeight>r.height) y=e.clientY-r.top-tip.offsetHeight-14;
    tip.style.left=Math.max(0,x)+'px'; tip.style.top=Math.max(0,y)+'px'; };
  chart.onmousemove=show; chart.onkeydown=null;
  chart.onpointerdown=function(e){ if(e.pointerType!=='mouse') show(e); };
  chart.onmouseleave=function(){ tip.classList.remove('on'); };
}
// Event caption: a tap or click on an overlay band/marker pins its <title> text in #chartEvCap;
// mouse hover previews it and leaving restores the pinned text. Wired once per mount on #chartBox
// (it outlives each redraw). textContent only — the titles carry the athlete's own notes.
function wireEventCap(box){
  var title=function(t){ var c=t&&t.firstElementChild; return (c&&c.tagName.toLowerCase()==='title')?c.textContent:null; };
  var set=function(txt){ var c=$('chartEvCap'); if(c) c.textContent=txt; };
  var pin=function(e){ var t=title(e.target); if(t!=null) set(CAP_PIN=t); };
  box.addEventListener('pointerdown',pin);
  box.addEventListener('click',pin);
  box.addEventListener('pointerover',function(e){ if(e.pointerType!=='mouse') return; var t=title(e.target); set(t!=null?t:CAP_PIN); });
  box.addEventListener('pointerleave',function(e){ if(e.pointerType==='mouse') set(CAP_PIN); });
}
// Redraw the chart at its new width when #chartBox resizes (window, sidebar, a hidden tab shown).
// Debounced 150ms; only a ≥8px width change redraws, so a redraw's own height change can't loop.
function watchChartSize(container){
  var box=$('chartBox'); if(!box) return;
  var cb=function(){ clearTimeout(RO_T); RO_T=setTimeout(function(){
    if(ROOT!==container || !RAW.length) return;
    var w=box.clientWidth; if(!w || Math.abs(w-CHART_W)<8) return;
    renderChart();
  },150); };
  if(window.ResizeObserver){ RO=new ResizeObserver(cb); RO.observe(box); }
  else { WIN_RS=cb; window.addEventListener('resize',cb); }
}

/* ---------- injury & illness history ---------- */
// Renders InjuryPatterns.analyze() (shared/injury-patterns.js): each logged injury/illness lead-up
// scored against the pattern registry, each pattern's base rate from normal (control) weeks, and big
// UNexplained volume drops offered as "Training gaps to review" — Log it… (any event type) or
// Dismiss (not a setback: stored on the user doc as runDismissedDrops, matched by InjuryPatterns,
// never flagged again; restorable from the "N dismissed · show" line). Retrospective and
// correlational only, and only patterns that FIRED are listed — never a forecast.
var PATTERN_COPY={ ramp:'Weekly load climbing week after week', acwr:'Recent load well above the usual base', longrun:'One run much longer than the usual long run',
  intensity:'A bigger share of hard sessions than usual', monotony:'Running most days with little variation or rest', downhill:'Far more downhill than usual' };
// "injury/injuries" when only injuries were counted, "illness/illnesses" when only illnesses, else "setback/setbacks".
// Fired patterns in the stats table's order (the cards follow it): most setbacks, then lift, then registry order.
function patOrder(patterns){ var ord={}; InjuryPatterns.PATTERNS.forEach(function(p,i){ ord[p.id]=i; });
  return patterns.filter(function(p){ return p.injHits>0; }).sort(function(a,b){ return b.injHits-a.injHits || (b.lift||0)-(a.lift||0) || ord[a.id]-ord[b.id]; }); }
var DIS_STATUS=[];   // per stored dismissal: {k:'explained',label} | {k:'gone'} | {} (set by renderPatternsBox)
function patNoun(n, inj, ill){ var one=n===1; return (inj&&ill)?(one?'setback':'setbacks'):(ill&&!inj)?(one?'illness':'illnesses'):(one?'injury':'injuries'); }
function casesNoun(cs){ var ill=cs.filter(function(c){ return c.event.type==='illness'; }).length; return patNoun(cs.length, cs.length-ill, ill); }
function pctOf(x){ return Math.round(x*100)+'%'; }
function evDot(t){ return '<span class="rdx-ev-dot" style="background:'+(EV_HEX[t]||EV_HEX.race)+'" aria-hidden="true"></span>'; }
function dismissedDrops(){ return (Array.isArray(STD_PROFILE.runDismissedDrops)?STD_PROFILE.runDismissedDrops:[]).filter(function(x){ return x&&isFinite(x.t0)&&isFinite(x.t1); }); }
function sameDis(y,x){ return !!y && y.t0===x.t0 && y.t1===x.t1 && y.at===x.at; }
function gapWhen(d){ return d.ongoing ? fmtMD(d.t0)+' – now' : fmtSpan(d.t0,d.t1); }

// A. the one-line finding above the cards
function patLeadHTML(res){
  var m=res.meta, noun=patNoun(m.nEval,m.nEvalInj,m.nEvalIll);
  if(!res.cases.some(function(c){ return c.ok&&c.firedIds.length; }))
    return '<p class="rdx-pat-lead">Nothing unusual showed up before '+who()+' logged '+noun+' — the lead-up'+(m.nEval===1?'':'s')+' looked like typical training.</p>';
  if(m.nEval<2) return '';   // one case that fired: its card is the finding
  var rep=res.patterns.filter(function(p){ return p.injHits>=2; });
  if(!rep.length) return '<p class="rdx-pat-lead">Each '+patNoun(1,m.nEvalInj,m.nEvalIll)+' had a different lead-up — no pattern has repeated yet.</p>';
  // headline only a repeated pattern at least 1.5× as common before setbacks as in normal weeks (with
  // enough normal weeks to say so); most repeated first, ties to the one rarer in normal weeks
  var top=rep.filter(function(p){ return !p.lowConf && p.lift!=null && p.lift>=1.5; }).sort(function(a,b){ return b.injHits-a.injHits || (a.ctrlRate==null?1:a.ctrlRate)-(b.ctrlRate==null?1:b.ctrlRate); })[0];
  if(!top) return '<p class="rdx-pat-lead">No pattern stood out from '+who()+' normal weeks.</p>';
  return '<p class="rdx-pat-lead">Seen most often: <b>'+esc(top.name)+'</b> — before '+top.injHits+' of '+top.injEval+' '+patNoun(top.injEval,top.injEval-top.illEval,top.illEval)+
    (top.ctrlRate!=null&&!top.lowConf?', vs '+pctOf(top.ctrlRate)+' of '+who()+' normal weeks':'')+'.</p>';
}
function moreTxt(open,n){ return (open?'Hide ':'Show ')+n+' older'; }
// B + C. a card per case where something fired (newest first, 3 then "Show n older"); "Also logged"
// (nothing fired, or outside the stored history) is the grid's last item
function setbackCardsHTML(res){
  var newest=function(a,b){ return b.event.ts-a.event.ts; }, rank={};
  patOrder(res.patterns).forEach(function(p,i){ rank[p.id]=i; });   // card flags in the stats table's row order
  var hit=res.cases.filter(function(c){ return c.ok&&c.firedIds.length; }).sort(newest);
  var html=hit.map(function(c,i){ var e=c.event;
    return '<article class="rdx-sb-card'+(i>=3?' rdx-sb-old':'')+'" tabindex="-1"'+(i>=3&&!SB_MORE?' hidden':'')+'>'+
      '<h3 class="rdx-sb-hd">'+evDot(e.type)+'<span>'+evLabel(e)+'</span></h3>'+
      (e.note?'<p class="rdx-sb-note">'+esc(e.note)+'</p>':'')+
      '<div class="rdx-sb-lbl">In the weeks before</div><ul class="rdx-sb-flags">'+
      c.flags.filter(function(f){ return f.fired; }).sort(function(a,b){ return (rank[a.id]!=null?rank[a.id]:99)-(rank[b.id]!=null?rank[b.id]:99); }).map(function(f){
        return '<li><b>'+esc(f.name)+'</b><span class="v">'+esc(f.value)+'</span></li>'; }).join('')+
      '</ul>'+(e.type==='illness'?'<p class="rdx-sb-ill">Checked against overtraining-type patterns only.</p>':'')+'</article>';
  }).join('');
  if(hit.length>3) html+='<div class="rdx-sb-more"><button type="button" class="rdx-linkbtn rdx-sb-older" data-f="sbolder" aria-expanded="'+SB_MORE+'">'+moreTxt(SB_MORE,hit.length-3)+'</button></div>';
  return '<div class="rdx-sb-grid">'+html+alsoHTML(res.cases.filter(function(c){ return !(c.ok&&c.firedIds.length); }).sort(newest), res, {nHit:hit.length})+'</div>';
}
// Why a case has no lead-up: dated in the future, before the stored history, past its end, or too early
// in it for the 6-week warm-up ('ok' = it was evaluated).
function whyOf(c, res){ var e=c.event;
  return c.ok?'ok' : e.ts>dayEnd(new Date()).getTime()?'future' : e.ts<res.meta.t0?'before' : e.ts>res.meta.t1+7*DAY?'after' : 'early'; }
function alsoHTML(cs, res, o){
  if(!cs.length) return '';
  o=o||{};
  // no fired cards and nothing but evaluated cases: the lead already says "nothing unusual", so rows skip it
  var quietOk=!o.nHit && cs.every(function(c){ return c.ok; });
  return '<div class="rdx-sb-also"><h3 class="rdx-sb-also-hd">'+(o.nHit?'Also logged':'Logged setbacks')+'</h3><ul>'+cs.map(function(c,i){ var e=c.event;
    // why a case has no lead-up: before the history, past its end, or too early in it for the 6-week warm-up
    var why={ ok:'Nothing unusual in the weeks before.',
      future:'This date is in the future — check it in Data & settings → Events.',
      before:'Before the stored run history — import the weeks before it to include it.',
      after:'After the last stored run — import the newer runs to include it.',
      early:'Too close to the start of the stored run history — import the weeks before it to include it.' }[whyOf(c,res)];
    return '<li'+(i>=5?' class="rdx-also-old"':'')+' tabindex="-1"'+(i>=5&&!ALSO_ALL?' hidden':'')+'><div class="t">'+evDot(e.type)+'<span>'+evLabel(e)+(e.note?' · '+esc(e.note):'')+'</span></div>'+((o.noWhy||(quietOk&&c.ok))?'':'<div class="s">'+why+'</div>')+'</li>';
  }).join('')+'</ul>'+(cs.length>5?'<button type="button" class="rdx-linkbtn rdx-also-all" data-f="alsoall" aria-expanded="'+ALSO_ALL+'">'+(ALSO_ALL?'Show fewer':'Show all')+'</button>':'')+'</div>';
}
// D. the statistics, OPEN by default: fired patterns only, then pairs that co-fired before ≥2 cases.
// A bordered table: each rate is a % + count over a thin bar on one 0–100% scale (cyan = before
// setbacks, grey = normal weeks), then the ratio. No pills, no red: "×N" only with ≥3 cases and
// enough normal weeks to compare. On phones each row stacks into a small card.
function patTableHTML(res){
  var m=res.meta, fired=patOrder(res.patterns);
  if(!fired.length) return '';
  var noun=patNoun(m.nEval,m.nEvalInj,m.nEvalIll), weeks=m.nControls+' normal week'+(m.nControls===1?'':'s');
  var bar=function(r, cls){ return '<span class="bar'+(cls?' '+cls:'')+'" aria-hidden="true"><i style="width:'+Math.min(100,Math.max(0,r*100)).toFixed(1)+'%"></i></span>'; };
  var row=function(name, sub, hits, den, dnoun, rate, lift, low){
    var caseRate=den?hits/den:0;
    // ×N only for a pattern MORE common before setbacks: "×0.3 as often" reads as a finding when it's the opposite
    // ×N only when the pattern preceded ≥2 setbacks out of ≥3 — one coincidence is not a multiple;
    // a pattern never seen in normal weeks says so instead of a multiple built on the 0.5-week floor
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
  // pair denominator = the cases where BOTH patterns could be checked (res.combos counts every case)
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
  return '<details class="rdx-more rdx-pat-more" id="patStats"'+(PAT_STATS?' open':'')+'><summary data-f="patsum">How often each pattern showed up · '+m.nEval+' '+noun+(m.nControls?' vs '+weeks:'')+'</summary><div class="rdx-more-body">'+
    (m.nControls ? '<p>Each lead-up vs '+weeks+' from the rest of '+who()+' history.</p>'
      : '<p>'+who('Your')+' logged setbacks and their recovery cover almost all of the stored history, so there are no normal weeks to compare against.</p>')+
    '<div class="rdx-pt-wrap"><table class="rdx-pt"><thead><tr><th scope="col">Pattern</th><th scope="col" class="c-rate">Before</th><th scope="col" class="c-rate">In normal weeks</th><th scope="col" class="c-x">Ratio</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'+
    '<p class="rdx-pt-cav">'+cav+'</p>'+
  '</div></details>';
}
// E. Training gaps to review: open drops (newest first) + the dismissed line. Rendered on every branch
// that has drops or stored dismissals, so a dismissal always stays restorable.
function gapsHTML(drops, dis){
  if(!drops.length && !dis.length) return '';
  var n=drops.length;
  return '<details class="rdx-more rdx-gaps'+(n?'':' is-clear')+'" id="rdxGaps"'+(GAPS_OPEN?' open':'')+'>'+
    '<summary id="rdxGapsHd"><h3 class="rdx-gaps-hd">'+(n?'Training gaps to review · '+n:'Training gaps · none open')+'</h3></summary><div class="rdx-gaps-body">'+
    (n?'<p class="rdx-gaps-intro">'+who('Your')+' volume fell sharply in these weeks and nothing logged explains it. If one was a setback, log it and it joins this report. A busy week or travel, not a setback? Dismiss it and it won’t be flagged again.</p>'+
      '<ul class="rdx-gap-list">'+drops.map(function(d,i){
        var w=d.weeks+(d.capped?'+':'')+' week'+(d.weeks===1&&!d.capped?'':'s');
        return '<li class="rdx-gap-row" data-t0="'+d.t0+'" data-t1="'+d.t1+'">'+
          '<div class="rdx-gap-main"><div class="rdx-gap-when" id="rdxGapW'+i+'"><span class="rdx-gap-ico" aria-hidden="true">▼</span>'+gapWhen(d)+'</div>'+
            '<div class="rdx-gap-stats">'+w+(d.ongoing?' · ongoing':'')+' · down '+Math.round(d.pct*100)+'% vs the 4 weeks before</div></div>'+
          '<div class="rdx-gap-acts">'+
            '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm rdx-gap-log" data-i="'+i+'" data-f="log'+d.t0+'" aria-expanded="false" aria-describedby="rdxGapW'+i+'">Log it…</button>'+
            '<button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm rdx-gap-dismiss" data-i="'+i+'" data-f="dis'+d.t0+'" title="Not a setback — hide it and don’t flag it again" aria-label="Dismiss: not a setback — hide it and don’t flag it again" aria-describedby="rdxGapW'+i+'">Dismiss</button>'+
          '</div></li>';
      }).join('')+'</ul>':'')+
    dismissedHTML(dis)+'</div></details>';
}
function dismissedHTML(dis){
  if(!dis.length) return '';
  var order=dis.map(function(x,i){ return i; }).sort(function(a,b){ return dis[b].t0-dis[a].t0; });
  return '<div class="rdx-dis">'+dis.length+' dismissed · <button type="button" class="rdx-linkbtn rdx-dis-tog" data-f="distog" aria-expanded="'+DIS_OPEN+'" aria-controls="rdxDisList">'+(DIS_OPEN?'hide':'show')+'</button>'+
    '<ul class="rdx-dis-list" id="rdxDisList"'+(DIS_OPEN?'':' hidden')+'>'+order.map(function(i){ var x=dis[i], when=fmtSpan(x.t0,x.t1);
      var st=DIS_STATUS[i]||{}, meta=st.k==='explained'?'now explained by '+st.label : st.k==='gone'?'no longer detected' : isFinite(x.at)?'dismissed '+fmtMD(x.at):'';
      return '<li class="rdx-dis-item"><span class="rdx-dis-when">'+when+'</span>'+'<span class="rdx-dis-at">'+(meta?'<span aria-hidden="true">· </span>'+meta:'')+'</span>'+
        '<button type="button" class="rdx-btn rdx-btn-ghost rdx-btn-sm rdx-dis-restore" data-i="'+i+'" aria-label="Restore the '+when+' drop">Restore</button></li>';
    }).join('')+'</ul></div>';
}
// F. disclaimer + what-to-log, under every branch that shows findings or gaps
// full: the branch shows findings, so it carries the one disclaimer; the what-to-log line is always there
function patFootHTML(full){
  return (full?'<p class="rdx-note rdx-pat-foot">A look back, not a prediction — correlations, not causes, from a small sample.</p>':'')+
    '<p class="rdx-note">What to log: overuse injuries → Injury · acute injuries not from running → Non-Running Injury · significant illnesses → Illness · planned breaks → Planned Downtime.</p>';
}
// Persist a dismissal change — fn(list) → list, run on the stored copy (updateProfileList) — with a
// toast (o.msg, Undo when o.undo), and re-render. A failed write raises an error toast and rolls the
// list back (revertKey: the stored copy, else the list before this change), unless a newer
// dismiss/restore owns the field by then. A keyboard user
// (o.kbd) gets focus on the "dismissed" toggle — or, for an Undo (o.toDrop) or once no toggle is
// left, on the restored gap's Dismiss button (the button they pressed is gone).
function saveDismissed(fn, o){
  o=o||{};
  var my=MOUNT, n=++DIS_SEQ, prev=STD_PROFILE.runDismissedDrops, p=updateProfileList('runDismissedDrops', fn, refresh, false), sent=canonJSON(STD_PROFILE.runDismissedDrops);
  if(o.msg) toast(o.msg, o.undo?{undo:o.undo}:null);
  p.then(function(r){
    if(r===true || my!==MOUNT) return;
    toast('Couldn’t save ('+r+'). Nothing was changed.',{kind:'err'});
    revertKey('runDismissedDrops', Array.isArray(prev)?prev:[], function(){ return my===MOUNT && DIS_SEQ===n && canonJSON(STD_PROFILE.runDismissedDrops)===sent; });
  });
  if(!dismissedDrops().length) DIS_OPEN=false;
  if(o.restored) GAPS_OPEN=true;
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
// "Log it…" form — one at a time, full width under its row. GAP_FORM holds what was typed, so a
// re-render of the report (a dismissal, a settings change, another device's write) re-opens it as it was.
function gapFormHTML(d, st){
  var opt=function(t){ return '<option value="'+t+'"'+(st.type===t?' selected':'')+'>'+EV_META[t][0]+'</option>'; };
  var mx=EV_NO_FUTURE[st.type]?' max="'+ymd(new Date())+'"':'';
  return '<div class="rdx-gap-form'+(d?'':' rdx-gap-form-past')+'" id="rdxGapForm" role="group" aria-label="'+(d?'Log the '+gapWhen(d)+' gap':'Log a past injury')+'">'+
    '<div class="rdx-gf-fields">'+
      '<div class="rdx-ctl"><label for="gfType">What was it?</label><select id="gfType" required aria-describedby="gfHint">'+
        '<option value="" disabled'+(st.type?'':' selected')+'>Choose a type…</option>'+['injury','illness','nonrun','race','timeoff'].map(opt).join('')+'</select></div>'+
      '<div class="rdx-ctl"><label for="gfStart">Start</label><input type="date" id="gfStart" aria-describedby="gfHint" value="'+esc(st.start)+'"'+mx+'></div>'+
      '<div class="rdx-ctl" id="gfEndCtl"'+(st.type==='race'?' hidden':'')+'><label for="gfEnd">End (optional)</label><input type="date" id="gfEnd" aria-describedby="gfHint" value="'+esc(st.end)+'"'+mx+'></div>'+
      '<div class="rdx-ctl rdx-gf-note"><label for="gfNote">Note</label><input type="text" id="gfNote" placeholder="'+esc(EV_PH[st.type]||'Optional')+'" value="'+esc(st.note)+'"></div>'+
    '</div>'+
    '<p class="rdx-gf-hint" id="gfHint">'+(EV_HINT[st.type]||'')+'</p>'+
    '<div class="rdx-gf-acts"><button type="button" class="rdx-btn rdx-btn-ghost" id="gfCancel">Cancel</button>'+
      '<button type="button" class="rdx-btn" id="gfSave"'+(EV_META[st.type]?'':' disabled')+'>Save event</button></div>'+
  '</div>';
}
// row = the gap row (the form goes inside it, under its buttons), or for the past-injury form
// (d null, st.t0 'past') the "+ Log a past injury" button: the form goes right under its button row.
function openGapForm(row, d, st, focus){
  var box=$('patternsBox'); if(!box||!row) return;
  closeGapForm(false);
  GAP_FORM=st;
  var b;
  if(d){ row.insertAdjacentHTML('beforeend', gapFormHTML(d, st)); b=row.querySelector('.rdx-gap-log'); }
  else { b=row; (row.closest('.rdx-pat-act')||row).insertAdjacentHTML('afterend', gapFormHTML(null, st)); }
  b.setAttribute('aria-expanded','true'); b.setAttribute('aria-controls','rdxGapForm');
  wireGapForm(d);
  if(focus) $(d?'gfType':'gfStart').focus();
}
function gapFormBtn(f){
  return f.classList.contains('rdx-gap-form-past') ? ($('patternsBox')||document).querySelector('.rdx-pat-logpast') : f.parentNode.querySelector('.rdx-gap-log');
}
function closeGapForm(focusBtn){
  GAP_FORM=null;
  var f=$('rdxGapForm'); if(!f) return;
  var b=gapFormBtn(f);
  f.parentNode.removeChild(f);
  if(b){ b.setAttribute('aria-expanded','false'); b.removeAttribute('aria-controls'); if(focusBtn) b.focus(); }
}
function wireGapForm(d){
  var type=$('gfType'), start=$('gfStart'), end=$('gfEnd'), note=$('gfNote'), save=$('gfSave');
  var hint=$('gfHint');
  var clr=function(){ [start,end].forEach(function(f){ f.classList.remove('rdx-df-err'); f.removeAttribute('aria-invalid'); });
    if(hint.classList.contains('rdx-field-err')){ hint.classList.remove('rdx-field-err'); hint.textContent=EV_HINT[type.value]||''; } };
  var bad=function(f,msg){ f.classList.add('rdx-df-err'); f.setAttribute('aria-invalid','true'); f.focus(); hint.textContent=msg; hint.classList.add('rdx-field-err'); toast(msg,{kind:'err'}); };
  type.onchange=function(){ var v=type.value, race=v==='race'; GAP_FORM.type=v; $('gfEndCtl').hidden=race; evDateMax(v,['gfStart','gfEnd']); clr(); if(race){ end.value=''; GAP_FORM.end=''; } hint.classList.remove('rdx-field-err'); hint.textContent=EV_HINT[v]||''; note.placeholder=EV_PH[v]||'Optional'; save.disabled=!EV_META[v]; };
  start.oninput=start.onchange=function(){ GAP_FORM.start=start.value; clr(); };
  end.oninput=end.onchange=function(){ GAP_FORM.end=end.value; clr(); };
  note.oninput=function(){ GAP_FORM.note=note.value; };
  note.onkeydown=function(e){ if(e.key==='Enter' && !save.disabled) save.click(); };
  $('rdxGapForm').onkeydown=function(e){ if(e.key==='Escape'){ e.stopPropagation(); closeGapForm(true); } };
  $('gfCancel').onclick=function(){ closeGapForm(true); };
  save.onclick=function(ev){
    var t=type.value; if(save.disabled || !EV_META[t]) return;
    clr();
    var s=parseDate(start.value); if(!s){ bad(start,'Pick a start date.'); return; }
    if(evFuture(t,s)){ bad(start,EV_FUTURE_MSG); return; }
    var nv=(note.value||'').trim();
    var e={ id:Date.now(), type:t, ts:s.getTime(), note:nv };
    if(t!=='race'){
      var en=parseDate(end.value);
      if(en){ if(en.getTime()<s.getTime()){ bad(end,EV_END_MSG); return; } if(evFuture(t,en)){ bad(end,EV_FUTURE_MSG); return; } if(en.getTime()>s.getTime()) e.endTs=en.getTime(); }
    }
    save.disabled=true;   // double-click guard: the row re-renders away under the pointer
    var st=Object.assign({},GAP_FORM), my=MOUNT;
    GAP_FORM=null;
    // a failed save rolls the event back (saveEvents), which brings the gap back: re-open it as typed
    saveEvents(evAddFn(e), 'Logged: '+evLabel(e)).then(function(r){ if(r!==true && my===MOUNT && !GAP_FORM) GAP_FORM=st; });
    renderEventsList(); refresh();
    if(ev.detail===0){ var h=$('rdxGapsHd')||$('patHead'); if(h) h.focus({preventScroll:true}); }
  };
}
function wireDrops(box, drops){
  var on=function(sel,fn){ Array.prototype.forEach.call(box.querySelectorAll(sel),function(b){ b.onclick=fn; }); };
  // inline past-injury form under the button (type Injury, Start empty); a second click folds it
  on('.rdx-pat-logpast', function(){
    if(GAP_FORM && GAP_FORM.t0==='past'){ closeGapForm(false); return; }
    openGapForm(this, null, { t0:'past', type:'injury', start:'', end:'', note:'' }, true);
  });
  on('.rdx-pat-import', function(){ openSettings('data'); });
  on('.rdx-pat-events', function(){ openSettings('events'); });
  on('.rdx-pat-included', function(){ openSettings('included'); });
  // show/hide in place (no re-render), so the button keeps focus and can fold them back up
  var fold=function(btn, sel, open, txt){ Array.prototype.forEach.call(box.querySelectorAll(sel),function(c){ c.hidden=!open; }); btn.textContent=txt; btn.setAttribute('aria-expanded',String(open)); };
  on('.rdx-sb-older', function(){ SB_MORE=!SB_MORE; fold(this,'.rdx-sb-old',SB_MORE,moreTxt(SB_MORE,box.querySelectorAll('.rdx-sb-old').length)); });
  on('.rdx-also-all', function(){ ALSO_ALL=!ALSO_ALL; fold(this,'.rdx-also-old',ALSO_ALL,ALSO_ALL?'Show fewer':'Show all'); });
  var gd=$('rdxGaps'); if(gd) gd.ontoggle=function(){ GAPS_OPEN=gd.open; };
  var det=$('patStats'); if(det) det.ontoggle=function(){ PAT_STATS=det.open; };
  on('.rdx-gap-log', function(){
    var d=drops[+this.getAttribute('data-i')]; if(!d) return;
    if(GAP_FORM && GAP_FORM.t0===d.t0){ closeGapForm(false); return; }
    openGapForm(this.closest('.rdx-gap-row'), d, { t0:d.t0, type:'', start:ymd(new Date(d.t0)), end:d.ongoing?'':ymd(new Date(d.t1)), note:'' }, true);
  });
  on('.rdx-gap-dismiss', function(e){
    // the rows re-render under the pointer: a double-click's second click would land on the
    // NEXT gap's Dismiss button, so ignore repeats
    if(e.detail>1 || Date.now()-DIS_T<500) return;
    var d=drops[+this.getAttribute('data-i')]; if(!d) return;
    DIS_T=Date.now();
    var rec={ t0:d.t0, t1:d.t1, at:Date.now() }, when=fmtSpan(d.t0,d.t1);
    if(GAP_FORM && GAP_FORM.t0===d.t0) GAP_FORM=null;
    saveDismissed(function(list){ return list.concat([rec]); }, { kbd:e.detail===0, msg:'Dismissed '+when+' — it won’t be flagged again.',
      undo:function(u){ saveDismissed(function(list){ return list.filter(function(y){ return !sameDis(y,rec); }); },
        { kbd:!!u&&u.detail===0, restored:rec, toDrop:true, msg:'Restored '+when+' — it’s back in Training gaps to review.' }); } });
  });
  var tog=box.querySelector('.rdx-dis-tog'), list=box.querySelector('.rdx-dis-list');
  // show/hide in place — a re-render would cost an open form its focus
  if(tog&&list) tog.onclick=function(){ DIS_OPEN=!DIS_OPEN; list.hidden=!DIS_OPEN; tog.textContent=DIS_OPEN?'hide':'show'; tog.setAttribute('aria-expanded',String(DIS_OPEN)); };
  on('.rdx-dis-restore', function(e){
    if(e.detail>1 || Date.now()-DIS_T<500) return;
    var di=+this.getAttribute('data-i'), x=dismissedDrops()[di]; if(!x) return;
    DIS_T=Date.now();
    var st=DIS_STATUS[di]||{}, when=fmtSpan(x.t0,x.t1);
    var msg=st.k==='explained'?'Restored '+when+' — a logged event already explains this drop, so it stays off the list.'
      : st.k==='gone'?'Restored '+when+' — this drop is no longer detected.' : 'Restored '+when+' — it’s back in Training gaps to review.';
    // by value, not index: the stored list may be ordered differently
    saveDismissed(function(list){ return list.filter(function(y){ return !sameDis(y,x); }); },
      { kbd:e.detail===0, restored:x, msg:msg });
  });
  // re-open the form a re-render closed, if its gap is still listed
  if(GAP_FORM && GAP_FORM.t0==='past'){
    var lp=box.querySelector('.rdx-pat-logpast');
    if(!lp) GAP_FORM=null; else openGapForm(lp, null, GAP_FORM, false);
  } else if(GAP_FORM){
    var st=GAP_FORM, k=-1; drops.some(function(d,i){ if(d.t0===st.t0){ k=i; return true; } return false; });
    if(k<0) GAP_FORM=null; else openGapForm(box.querySelector('.rdx-gap-row[data-t0="'+st.t0+'"]'), drops[k], st, false);
  }
}
// Re-render, then put focus (and a text field's caret) back where it was — re-renders happen under
// an open form when another device's write lands or a setting changes.
function renderPatterns(){
  var box=$('patternsBox'); if(!box) return;
  var a=document.activeElement, k=null, sel=null;
  if(a && a!==box && box.contains(a)){
    k=a.id?'#'+a.id:a.getAttribute('data-f')?'[data-f="'+a.getAttribute('data-f')+'"]':null;
    if(k && typeof a.selectionStart==='number') sel=[a.selectionStart,a.selectionEnd];
  }
  renderPatternsBox(box);
  var f=k&&box.querySelector(k);
  if(f && document.activeElement!==f){ f.focus({preventScroll:true}); if(sel) try{ f.setSelectionRange(sel[0],sel[1]); }catch(_){} }
}
function renderPatternsBox(box){
  var chip=$('patGapChip'), drops=[], dis=dismissedDrops(), html;
  DIS_STATUS=[];
  if(!window.InjuryPatterns || !LOAD_PARAMS){ box.innerHTML=''; if(chip) chip.hidden=true; return; }
  var evs=events(), res=InjuryPatterns.analyze(loadRuns(), evs, LOAD_PARAMS, { dismissedDrops:dis });
  var nInj=evs.filter(function(e){ return e.type==='injury'; }).length, nIll=evs.filter(function(e){ return e.type==='illness'; }).length;
  var logPast='<p class="rdx-pat-act"><button type="button" class="rdx-btn rdx-btn-outline rdx-pat-logpast" data-f="logpast">+ Log a past injury</button></p>';
  if(!res.ok){
    var days=res.days||0;
    html=res.reason==='history'
      ? '<p class="rdx-pat-lead">This section needs about 10 weeks of run history — '+who('you have')+' '+(days<7?'under a week':Math.floor(days/7)+' week'+(Math.floor(days/7)===1?'':'s'))+' so far.'+
          (RAW.length&&daysAgo(RAW[RAW.length-1].ts)<=7?' It unlocks around '+fmtDay(Date.now()+Math.max(0,70-days)*DAY)+'.':'')+'</p>'+
        '<p class="rdx-pat-act"><button type="button" class="rdx-btn rdx-btn-outline rdx-pat-logpast" data-f="logpast">+ Log a past injury</button><button type="button" class="rdx-btn rdx-btn-outline rdx-pat-import" data-f="import">Import older runs</button></p>'+
        gapsHTML([],dis)+patFootHTML(false)
      : '<p class="rdx-pat-lead">No runs meet the minimum distance.</p>'+
        '<p class="rdx-pat-act"><button type="button" class="rdx-btn rdx-btn-outline rdx-pat-included" data-f="included">Open What’s included</button></p>'+gapsHTML([],dis);
  } else {
    drops=res.drops.filter(function(d){ return !d.explained; }).sort(function(a,b){ return b.t0-a.t0; });
    // what each stored dismissal now matches: a drop a logged event explains, or no drop at all
    var WHY_LBL={'follows a logged injury':'a logged injury','follows a logged illness':'a logged illness','follows a non-running injury':'a non-running injury','logged planned downtime':'Planned Downtime'};
    DIS_STATUS=dis.map(function(x){ var d=res.drops.filter(function(d){ return InjuryPatterns.dismissOverlaps(d,x); })[0];
      if(!d) return {k:'gone'};
      if(d.why && !d.dismissed) return {k:'explained', label:WHY_LBL[d.why]||(/race/.test(d.why)?'a race':'a logged event')};
      return {}; });
    var m=res.meta, gaps=gapsHTML(drops,dis), foot=patFootHTML(false);
    if(!nInj && !nIll){
      html='<p class="rdx-pat-lead">No injuries or illnesses logged yet. Log past ones and this section shows what '+who()+' training looked like in the weeks before each.</p>'+logPast+
        (drops.length ? gaps+foot : whatToLogHTML()+gaps);
    } else if(!m.nEval){
      // the lead names the shared reason (each row then drops its duplicate reason line); mixed reasons get one phrase
      var n=nInj+nIll, one=n===1, rs=res.cases.map(function(c){ return whyOf(c,res); }), r=rs.every(function(x){ return x===rs[0]; })?rs[0]:null;
      var where={before:'before the stored run history',early:'in the first 6 weeks of the stored run history',after:'after the last stored run',future:'dated in the future'}[r]||'outside the part of the stored run history that can be analysed';
      var act=r==='after'?'Import the newer runs to include '+(one?'it':'them')+'.' : r==='future'?'Check '+(one?'its':'their')+' date in Data & settings → Events.' : 'Import the runs from the weeks before '+(one?'it':'each one')+'.';
      html='<p class="rdx-pat-lead">'+who('Your')+' logged '+patNoun(n,nInj,nIll)+' '+(one?'is':'are')+' '+where+', so there’s no lead-up to look at. '+act+'</p>'+
        '<p class="rdx-pat-act">'+(r==='future'?'<button type="button" class="rdx-btn rdx-btn-outline rdx-pat-events" data-f="events">Open Events</button>':'<button type="button" class="rdx-btn rdx-btn-outline rdx-pat-import" data-f="import">Open Import &amp; data</button>')+'</p>'+
        '<div class="rdx-sb-grid">'+alsoHTML(res.cases.slice().sort(function(a,b){ return b.event.ts-a.event.ts; }), res, {noWhy:!!r})+'</div>'+gaps+foot;
    } else {
      html=patLeadHTML(res)+setbackCardsHTML(res)+patTableHTML(res)+gaps+patFootHTML(true);
    }
  }
  box.innerHTML=html;
  // long setback notes clamp to 3 lines; a clamped one gets a more/less toggle (touch has no hover title)
  Array.prototype.forEach.call(box.querySelectorAll('.rdx-sb-note'),function(n,i){
    if(n.scrollHeight<=n.clientHeight+1) return;
    var b=document.createElement('button'); b.type='button'; b.className='rdx-linkbtn rdx-sb-note-more'; b.setAttribute('aria-expanded','false'); b.setAttribute('data-f','note'+i); b.textContent='more';
    b.onclick=function(){ var open=n.classList.toggle('is-open'); b.textContent=open?'less':'more'; b.setAttribute('aria-expanded',String(open)); };
    n.parentNode.insertBefore(b,n.nextSibling);
  });
  if(chip){ chip.hidden=!drops.length; chip.textContent=drops.length+' gap'+(drops.length===1?'':'s')+' to review'; }
  wireDrops(box, drops);
}

/* ---------- volume + form ---------- */
// Calendar days of stored history up to d, inclusive: the "All" window as of the "as of" date.
function histDays(d){ if(!RAW.length) return 0; var a=new Date(RAW[0].ts), b=new Date(d); a.setHours(0,0,0,0); b.setHours(0,0,0,0); return Math.max(0,Math.round((b-a)/DAY)+1); }
// Volume as of #anchor, one row per window. A window longer than the stored history would only repeat All, so it's left out.
function renderAll(){
  var el=$('cards'); if(!el) return;
  var end=ANCHOR||new Date(), have=histDays(end), notToday=ymd(end)!==ymd(new Date());
  var rows=RUN_WINDOWS.filter(function(w){ return w.days==null || w.days<=have; }).map(function(w){
    var s=summarize(runsInF(w.days==null?new Date(0):new Date(end.getTime()-w.days*DAY), end));
    return '<tr><th scope="row">'+(w.days==null?'All<span class="rdx-vol-n"> ('+have+' day'+(have===1?'':'s')+')</span>':notToday?w.label+'<span class="rdx-wide"> to '+fmtMD(end)+'</span>':'<span class="rdx-wide">Last </span>'+w.label)+'</th><td>'+s.n+'</td><td>'+s.dist.toFixed(1)+'</td><td>'+(s.dur?fmtDur(s.dur):'–')+'</td><td>'+fmtPace(s.pace)+'</td></tr>';
  }).join('');
  el.innerHTML='<div class="rdx-tablewrap rdx-volwrap"><table class="rdx-table rdx-vol" aria-labelledby="volHd"><thead><tr><th scope="col">Window</th><th scope="col">Runs</th><th scope="col">Miles</th><th scope="col">Time</th><th scope="col">Avg pace<span class="rdx-munit">/mi</span></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
// Range A/B defaults: the 90 days to the as-of date vs the 90 before (inclusive date ranges, no shared day).
function seedRanges(){ if(!$('faFrom')) return; var e=ANCHOR||dayEnd(new Date());
  $('faFrom').value=ymd(new Date(e.getTime()-89*DAY)); $('faTo').value=ymd(e);
  $('fbFrom').value=ymd(new Date(e.getTime()-179*DAY)); $('fbTo').value=ymd(new Date(e.getTime()-90*DAY)); }
function renderFormSub(){ var el=$('formSub'); if(!el) return; var e=ANCHOR||new Date();
  el.textContent=(ymd(e)===ymd(new Date())?'Last 90 days':'90 days to '+fmtMD(e.getTime()))+' vs the 90 before · distances are actual miles, not IAD'; }
function setCompare(on){ var b=$('formCompare'); b.classList.toggle('on',on); b.setAttribute('aria-pressed',String(on)); $('cmpRanges').hidden=!on; }
// All metrics: Range A vs Range B (the default: last 90 days vs the 90 before), or every stored run.
// Grouped like the chart's Show select but Form first and Derived last; hidden metrics are skipped.
function renderForm(){
  var tbl=$('ftable'); if(!tbl) return;
  var it=intensityState(), compare=$('formCompare').classList.contains('on'), cols;
  var rng=function(lbl,f,t){ var a=parseDate($(f).value), b=parseDate($(t).value);
    return {label:lbl, sub:(a&&b)?fmtSpan(a.getTime(),b.getTime()):'pick both dates', runs:(a&&b)?filterIntensity(runsIn(new Date(a.getTime()-1),dayEnd(b)),it.mode,it.cutoff):[]}; };
  if(compare) cols=[rng('Range A','faFrom','faTo'), rng('Range B','fbFrom','fbTo')];
  else cols=[{label:'All runs', sub:RAW.length?fmtSpan(RAW[0].ts,RAW[RAW.length-1].ts):'', runs:filterIntensity(runsIn(new Date(0), new Date(8.64e15)),it.mode,it.cutoff)}];
  var byKey={}; METRICS.forEach(function(m){ byKey[m.key]=m; });
  var order=['Form','Effort','Load','Derived'], gs=metricGroups().sort(function(a,b){ return order.indexOf(a[0])-order.indexOf(b[0]); });
  var head='<thead><tr><th scope="col">Metric</th>'+cols.map(function(c){ return '<th scope="col">'+c.label+'<span class="rdx-th-sub"><span class="rdx-wide">'+c.sub+' · </span>'+c.runs.length+' run'+(c.runs.length===1?'':'s')+'</span></th>'; }).join('')+
    (compare?'<th scope="col">Change<span class="rdx-th-sub">A − B</span></th>':'')+'</tr></thead>';
  var body=gs.map(function(g){
    var rows=g[1].map(function(k){
      var m=byKey[k]; if(!m||m.hide||!metricVisible(m)) return '';
      var vals=cols.map(function(c){ return metricMean(c.runs,m); });
      return '<tr><td><span class="rdx-mname">'+m.label+'</span>'+(m.unit?'<span class="rdx-munit">'+m.unit+'</span>':'')+'<div class="rdx-mdesc">'+m.desc+'</div></td>'+
        vals.map(function(v){ return '<td>'+fmtVal(v,m)+'</td>'; }).join('')+(compare?'<td>'+deltaHTML(vals[0],vals[1],m)+'</td>':'')+'</tr>';
    }).join('');
    return rows?'<tbody><tr class="rdx-grp"><th colspan="'+(cols.length+(compare?2:1))+'" scope="rowgroup">'+g[0]+'</th></tr>'+rows+'</tbody>':'';
  }).join('');
  tbl.innerHTML=head+body;

  var hidden=METRICS.filter(function(m){ return !m.hide && !metricVisible(m); });
  var note=compare
    ? 'Each value is the average per run. Change = Range A − Range B: green or red marks a change in the better or worse direction where there is one, and “≈ same” one within normal run-to-run variation.'
    : 'Each value is the average per run over every stored run that matches the filters. Turn on Compare two ranges to compare periods.';
  if(hidden.length){ var dev=RunDevices.byId(deviceId()); note+=' Hidden for '+(dev?dev.label:'this device')+': '+hidden.map(function(m){return m.label;}).join(', ')+' (needs a chest strap or pod, or not recorded).'; }
  if(byKey.force && metricVisible(byKey.force) && weightKg()==null) note+=' Add body weight in Data & settings → Profile to show Peak Force.';
  var hintEl=$('formHint'); if(hintEl) hintEl.textContent=note;
}
// Form tiles: the last 90 days to #anchor vs the 90 before. With no runs in the earlier window there is
// nothing to compare, so one line says so instead of a "no prior" on every tile.
function renderTiles(){
  var el=$('formTiles'); if(!el) return;
  var it=intensityState(), end=ANCHOR||new Date();
  var cur =filterIntensity(runsIn(new Date(end.getTime()-90*DAY),end),it.mode,it.cutoff);
  var prev=filterIntensity(runsIn(new Date(end.getTime()-180*DAY),new Date(end.getTime()-90*DAY)),it.mode,it.cutoff);
  if(!cur.length){ el.innerHTML='<p class="rdx-note rdx-tiles-note">No runs in the 90 days up to '+fmtDay(end)+' that match the filters.</p>'; return; }
  var pri=['cad','gct','vo','vratio','asym','stride','pace'];
  var byKey={}; METRICS.forEach(function(m){ byKey[m.key]=m; });
  var missing=[], fmtM=function(v,m){ return m.pace?fmtPace(v):v.toFixed(m.dec); };
  var html=pri.map(function(k){
    var m=byKey[k]; if(!m||!metricVisible(m)) return '';
    var cv=metricMean(cur,m); if(cv==null){ missing.push(m.label); return ''; }
    var val=fmtM(cv,m), pv=prev.length?metricMean(prev,m):null;
    // the delta says what changed: "≈ same vs 172", "9 s slower vs 7:47"
    var d=prev.length?(pv!=null?deltaHTML(cv,pv,m)+' <span class="rdx-tile-prev">vs '+fmtM(pv,m)+'</span>':'<span class="rdx-delta flat same">no earlier data</span>'):'';
    return '<div class="rdx-tile"><div class="rdx-tile-lbl">'+m.label+'</div>'+
      '<div class="rdx-tile-val">'+val+(m.unit?'<span class="rdx-tile-unit">'+m.unit+'</span>':'')+'</div>'+
      (d?'<div class="rdx-tile-delta">'+d+'</div>':'')+'</div>';
  }).join('');
  var miss=missing.length?'<p class="rdx-note rdx-tiles-note">'+(missing.length>1?missing.slice(0,-1).join(', ')+' and '+missing[missing.length-1]:missing[0])+' weren’t recorded in these runs — they need a running-dynamics pod, strap or compatible watch.</p>':'';
  if(!html){ el.innerHTML=miss||'<p class="rdx-note rdx-tiles-note">No form metrics available for this device.</p>'; return; }
  el.innerHTML=html+(prev.length?'':'<p class="rdx-note rdx-tiles-note">Form changes show here once there are 90 days of runs before this window.</p>')+miss;
}

/* ---------- "Mark Lever runs" modal ----------
   Bulk-marks treadmill runs as Lever runs (or explicitly not) with a per-run offload, stored as
   users/{uid}.runLeverMarks. annotateLever() applies the marks on every refresh, and every IAD
   consumer (hero, load chart, Impact Load metric, injury patterns) reads the per-run offload
   through RunLoad.impactLoad — so a mark change only has to persist, re-annotate, rebuild the
   type chips (Lever is its own chip) and refresh. */
var DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtPct(x){ var v=Math.round(x*10)/10; return (v%1===0)?String(v):v.toFixed(1); }
// Every indoor run (RunLoad's own test), plus anything currently Lever or carrying a manual mark.
function lvRuns(){ return RAW.filter(function(r){ return RunLoad.isIndoor(r)||r.lever||r.leverSrc==='unmarked'; }).sort(function(a,b){ return b.ts-a.ts; }); }
// #lvOff holds the body-weight support (% BW, the convention used everywhere else); marks store offload = 1 − BW.
function lvOffFrac(){ var el=$('lvOff'), v=el?parseFloat(el.value):NaN; return (v>=5&&v<=99)?(100-v)/100:null; }
function lvIL(r){ var v=LOAD_PARAMS?RunLoad.impactLoad(r,LOAD_PARAMS):null; return v>0?v:0; }
function lvBadge(r){
  var dflt='Scored at the profile default: '+fmtPct(leverPct())+'% body weight';
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
  return '<label class="rdx-lv-row">'+
    '<input type="checkbox" class="rdx-lv-cb" data-i="'+i+'">'+
    '<span class="rdx-lv-date">'+fmtMD(r.ts)+'<small>'+DOW[d.getDay()]+'</small></span>'+
    '<span class="rdx-lv-title" title="'+name+'">'+name+'</span>'+
    '<span class="rdx-lv-num">'+dist+'</span><span class="rdx-lv-num">'+pace+'</span><span class="rdx-lv-num">'+hr+'</span>'+
    '<span class="rdx-lv-meta">'+[dist, pace!=='–'?pace+'/mi':'', hr!=='–'?hr+' bpm':''].filter(Boolean).join(' · ')+'</span>'+
    '<span class="rdx-lv-badge '+b[0]+'"'+(b[2]?' title="'+esc(b[2])+'"':'')+'>'+b[1]+'</span>'+
    '<span class="rdx-lv-iad">'+(il!=null?il.toFixed(1):'–')+'<small> IAD</small></span>'+
  '</label>';
}
function renderLeverHint(){
  var el=$('lvHint'); if(!el) return;
  var n=RAW.filter(RunLoad.isIndoor).length, lv=RAW.filter(function(r){ return r.lever; }).length;
  var mk=RAW.filter(function(r){ return r.leverSrc==='marked'||r.leverSrc==='unmarked'; }).length;
  var b=$('lvOpen'); if(b) b.disabled=!lvRuns().length;
  el.textContent=!n&&!lv ? 'No treadmill runs yet' : n+' treadmill run'+(n===1?'':'s')+' · '+lv+' Lever'+(mk?' · '+mk+' marked by hand':'');
}
function renderLeverModal(){
  var m=$('lvModal'); if(!m||m.hidden) return;
  var all=lvRuns(), cnt={all:all.length, not:0, lever:0};
  all.forEach(function(r){ cnt[r.lever?'lever':'not']++; });
  $('lvFilter').innerHTML=[['all','All treadmill'],['not','Not Lever'],['lever','Lever']].map(function(f){
    var on=LV.filter===f[0];
    return '<button type="button" class="rdx-chip'+(on?' on':'')+'" data-f="'+f[0]+'" aria-pressed="'+on+'">'+f[1]+' ('+cnt[f[0]]+')</button>';
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
// Checkbox states, select-all, offload caption/validation, IAD preview and button states.
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
    // each preview names its action: "as Lever" for Mark as Lever, plus "as not Lever" whenever a
    // selected run is Lever now (that's the one Not Lever / Reset would raise)
    var before=0, asLever=0, asNot=0;
    sel.forEach(function(r){ before+=lvIL(r); if(off!=null) asLever+=lvIL(Object.assign({},r,{lever:true,offload:off})); asNot+=lvIL(Object.assign({},r,{lever:false,offload:null})); });
    sum.innerHTML='<b>'+n+'</b> selected · '+(off==null
      ? 'set a valid body-weight support to mark them as Lever'
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
  if(ok) LV.toastT=setTimeout(function(){ el.textContent=''; },5000);
}
function lvApply(kind){
  var off=lvOffFrac();
  if(kind==='mark' && off==null) return;
  var sel=LV.rows.filter(function(r){ return LV.sel.has(r.id); });
  if(!sel.length) return;
  // drop every mark that applies to a selected run — by its id, or the fallback-matched mark of a
  // run re-imported under a new id — then add the new ones (ts + mi = the fallback key)
  var drop=new Set(); sel.forEach(function(r){ drop.add(r.id); if(r._mark) drop.add(r._mark.id); });
  var add=kind==='reset' ? [] : sel.map(function(r){
    var m={ id:r.id, lever:kind==='mark', ts:r.ts, mi:r.distMi!=null?Math.round(r.distMi*100)/100:null };
    if(kind==='mark') m.offload=Math.round(off*1e4)/1e4;
    return m;
  });
  var had=sel.filter(function(r){ return !!r._mark; }).length;
  var n=kind==='reset'?had:sel.length, runs=n+' run'+(n===1?'':'s');
  var msg=kind==='mark'?runs+' marked as Lever at '+fmtPct(100-off*100)+'% body weight':kind==='not'?runs+' marked as not Lever':runs+' reset to auto-detection';
  LV.sel.clear();
  var my=MOUNT, rerender=function(){ annotateLever(); buildTypeChips(); refresh(); };   // refresh re-renders the open modal too
  var saved=updateProfileList('runLeverMarks', function(list){ return list.filter(function(m){ return !(m&&drop.has(m.id)); }).concat(add); }, rerender, false);   // the modal reports in its own #lvToast
  rerender();
  lvToast('✓ '+msg, true);
  saved.then(function(r){ if(r!==true && my===MOUNT) lvToast('⚠ Not saved ('+r+') — '+msg+' for now, but it will be undone on reload.', false); });
  var panel=$('lvModal').querySelector('.rdx-modal-panel');
  if(!panel.contains(document.activeElement) || document.activeElement.disabled) panel.focus();
}
function lvOpenModal(){
  var m=$('lvModal'); if(!m||!RAW.length) return;
  // Safari / macOS Firefox don't focus a clicked button, so activeElement can be <body>
  var a=document.activeElement;
  LV.trigger=(a && a!==document.body && ROOT.contains(a)) ? a : $('lvOpen'); LV.filter='all'; LV.sel.clear();
  $('lvOff').value=fmtPct(leverPct());
  var t=$('lvToast'); if(t) t.textContent='';
  var pt=$('rdxToast'); if(pt){ pt.hidden=true; clearTimeout(TOAST_T); }   // the page toast waits behind the modal, clock stopped
  m.hidden=false;
  renderLeverModal();
  m.querySelector('.rdx-modal-panel').focus();
}
function lvClose(){
  var m=$('lvModal'); if(!m||m.hidden) return;
  m.hidden=true; LV.sel.clear();
  var pt=$('rdxToast'); if(pt){ pt.hidden=false; if(TOAST_ARM) TOAST_ARM(); }
  if(LV.trigger && LV.trigger.focus && ROOT.contains(LV.trigger)) LV.trigger.focus();
}
function wireLeverModal(){
  var m=$('lvModal'), panel=m.querySelector('.rdx-modal-panel'), downOnBack=false;
  $('lvOpen').onclick=lvOpenModal;
  $('lvClose').onclick=lvClose;
  // backdrop: only a press that STARTED on it closes (a text-selection drag out of the panel must not)
  m.onmousedown=function(e){ downOnBack=e.target===m; };
  m.onclick=function(e){ if(e.target===m && downOnBack) lvClose(); downOnBack=false; };
  m.onkeydown=function(e){
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); lvClose(); return; }
    if(e.key!=='Tab') return;   // keep Tab inside the dialog
    var f=Array.prototype.filter.call(panel.querySelectorAll('button,input,select,a[href]'),function(el){ return !el.disabled && el.offsetParent!==null; });
    if(!f.length) return;
    var a=document.activeElement;
    if(e.shiftKey && (a===f[0]||a===panel)){ e.preventDefault(); f[f.length-1].focus(); }
    else if(!e.shiftKey && a===f[f.length-1]){ e.preventDefault(); f[0].focus(); }
  };
  $('lvOff').oninput=lvSync;
  $('lvFilter').onclick=function(e){ var b=e.target.closest('[data-f]'); if(!b) return; LV.filter=b.getAttribute('data-f'); renderLeverModal(); var nb=$('lvFilter').querySelector('[data-f="'+LV.filter+'"]'); if(nb) nb.focus(); };
  $('lvList').onchange=function(e){
    var t=e.target;
    if(t.classList.contains('rdx-lv-all')){ if(t.checked) LV.rows.forEach(function(r){ LV.sel.add(r.id); }); else LV.sel.clear(); }
    else if(t.classList.contains('rdx-lv-cb')){ var r=LV.rows[+t.getAttribute('data-i')]; if(r){ if(t.checked) LV.sel.add(r.id); else LV.sel.delete(r.id); } }
    lvSync();
  };
  $('lvMark').onclick=function(){ lvApply('mark'); };
  $('lvNot').onclick=function(){ lvApply('not'); };
  $('lvReset').onclick=function(){ lvApply('reset'); };
}

/* ---------- type filter ---------- */
function buildTypeChips(){
  var counts={};
  RAW.forEach(function(r){ var t=effType(r); counts[t]=(counts[t]||0)+1; });
  var types=Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];});
  var off=includedPref().off;
  types.forEach(function(t){ if(!KNOWN_TYPES.has(t)){ KNOWN_TYPES.add(t); if(off.indexOf(t)<0) ACTIVE_TYPES.add(t); } });
  var wrap=$('types'); if(!wrap) return; wrap.innerHTML='';
  types.forEach(function(tp){
    var c=document.createElement('button'); c.type='button';
    c.className='rdx-chip'+(ACTIVE_TYPES.has(tp)?' on':''); c.textContent=tp+' ('+counts[tp]+')'; c.setAttribute('aria-pressed',String(ACTIVE_TYPES.has(tp)));
    c.onclick=function(){
      if(ACTIVE_TYPES.has(tp)) ACTIVE_TYPES.delete(tp); else ACTIVE_TYPES.add(tp);
      c.classList.toggle('on',ACTIVE_TYPES.has(tp)); c.setAttribute('aria-pressed',String(ACTIVE_TYPES.has(tp)));
      refresh(); saveIncluded();
    };
    wrap.appendChild(c);
  });
}

/* ---------- orchestration ---------- */
// Garmin credit under each section title and atop the Mark Lever runs modal. Each shows load-derived
// numbers (Form & volume's metric table has Impact Load and estimated forces; the modal lists every
// run's IAD), and the load baseline is calibrated from all runs, outdoor ones included, so each
// credits every stored run and names Garmin as a source of the insight.
// Data & settings shows run counts, the calibrated easy pace and Lever counts: one credit atop the
// panel (also right under the header's run count when it opens), plus one on What's included and
// Import & data, the groups openSettings() scrolls straight to, past the panel's top.
function renderGarminCredit(){ ['gcHero','gcChart','gcPat','gcForm','gcLv','gcSet','gcInc','gcData'].forEach(function(id){ var el=$(id); if(el) el.innerHTML=garminCredit(RAW,true); }); }
function refresh(){ if(RAW.length){ renderGarminCredit(); annotateLever(); annotateExcluded(); renderFlags(); LOAD_PARAMS=computeLoadParams(); renderEasyCaption(); renderHero(); renderHeroNotes(); renderChart(); renderPatterns(); renderTiles(); renderForm(); renderAll(); renderLeverHint(); renderLeverModal(); renderStatus(); } }
// Segmented range control; 'custom' reveals the From/To inputs.
function setRangeChip(active){
  Array.prototype.forEach.call($all('#rdx-rangeChips [data-range]'),function(c){ var on=c.getAttribute('data-range')===active; c.classList.toggle('on',on); c.setAttribute('aria-pressed',String(on)); });
  var cr=$('customRange'); if(cr) cr.hidden=active!=='custom';
}
// Range presets end TODAY, so the chart's right edge is the day the hero reads ('all' starts at the first run).
function setRange(r){
  if(!RAW.length) return;
  var to=new Date(), from=(r==='all')?new Date(RAW[0].ts):new Date(to.getTime()-parseInt(r,10)*30.44*DAY);
  var tf=$('tFrom'), tt=$('tTo'); tf.value=ymd(from); tt.value=ymd(to);
  tf.removeAttribute('max'); tt.removeAttribute('min'); fieldOk(tf); fieldOk(tt);
  setRangeChip(r);
}
function applyRange(r){ setRange(r); renderChart(); }
// "synced today" / "synced yesterday" / "synced Oct 3" from STRAVA_SYNC.last ('' when unknown).
function stravaSyncedTxt(){
  if(!STRAVA_SYNC.last) return '';
  var t=STRAVA_SYNC.last.toDate?STRAVA_SYNC.last.toDate().getTime():new Date(STRAVA_SYNC.last).getTime(), n=daysAgo(t);
  return isFinite(t)?'synced '+(n<=0?'today':n===1?'yesterday':fmtMD(t)):'';
}
// Import & data foot line: "438 runs stored · Feb 22, 2025 – Oct 15, 2026 · Strava connected, synced today".
function renderFileNote(){
  var el=$('filenote'); if(!el || !RAW.length) return;
  var ds=RAW.map(function(r){ return r.date; }).sort(function(a,b){ return a-b; }), sy=stravaSyncedTxt();
  el.textContent=RAW.length+' run'+(RAW.length===1?'':'s')+' stored · '+fmtSpan(ds[0].getTime(), ds[ds.length-1].getTime())+
    ' · '+(STRAVA_SYNC.connected?'Strava connected'+(sy?', '+sy:''):'Strava not connected');
}
// Calibrated easy pace: the Easy pace unit reads "/mi · using 8:10 from easy runs" (same line, no new row).
function renderEasyCaption(){
  var u=$('easypaceUnit'); if(!u) return;
  u.textContent=(LOAD_PARAMS && LOAD_PARAMS.basePaceSource==='calibrated' && LOAD_PARAMS.basePaceSec>0)?'/mi · using '+fmtPace(LOAD_PARAMS.basePaceSec)+' from easy runs':'/mi';
}
// Toggletip: an ⓘ button + a one-sentence popover (aria-expanded/controls). Click or Enter toggles; Escape,
// an outside click or focus leaving the button closes; one open at a time (wireTips).
function tipHTML(text,label){ var id='rdxTip'+(++TIP_N);
  return '<button type="button" class="rdx-tip-btn" aria-expanded="false" aria-controls="'+id+'" aria-label="About '+esc(label)+'">i</button><span class="rdx-tip" id="'+id+'" role="note" hidden>'+esc(text)+'</span>'; }
function closeTips(except){ if(!ROOT) return; Array.prototype.forEach.call(ROOT.querySelectorAll('.rdx-tip-btn[aria-expanded="true"]'),function(b){ if(b===except) return; b.setAttribute('aria-expanded','false'); var t=document.getElementById(b.getAttribute('aria-controls')); if(t) t.hidden=true; }); }
function wireTips(root){
  if(!root || root._rdxTips) return; root._rdxTips=true;   // the host element outlives remounts: listeners once
  root.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('.rdx-tip-btn'); if(!b || !root.contains(b)) return;
    var t=document.getElementById(b.getAttribute('aria-controls')); if(!t) return;
    var open=b.getAttribute('aria-expanded')!=='true';
    closeTips(b); b.setAttribute('aria-expanded',String(open)); t.hidden=!open;
    if(open){ t.style.left=''; var r=t.getBoundingClientRect(), over=r.right-(window.innerWidth-12); if(over>0) t.style.left=(-over)+'px'; }
  });
  root.addEventListener('keydown',function(e){
    if(e.key!=='Escape') return;
    var b=root.querySelector('.rdx-tip-btn[aria-expanded="true"]'); if(!b) return;
    e.stopPropagation(); closeTips(); b.focus();
  });
  root.addEventListener('focusout',function(e){ var b=e.target.closest&&e.target.closest('.rdx-tip-btn'); if(b && b.getAttribute('aria-expanded')==='true') closeTips(); });
  if(!TIPS_WIRED){ TIPS_WIRED=true; document.addEventListener('click',function(e){ if(!(e.target.closest&&e.target.closest('.rdx-tip-btn'))) closeTips(); }); }
}
// What's-included defaults: the header names any control that differs ("Filtered: …") with a Reset.
var FILTER_DEFAULTS={intensity:'all',cutoff:'6:40',mindist:'0.5'};
// D4: What's included is saved per athlete on the user doc — users/{uid}.runIncluded =
// {off:[activity types left out], intensity, mindist} (types are stored as the ones turned OFF, so a
// new type from a later import is included) — and Workout pace is a Profile field
// (users/{uid}.runWorkoutPaceSec, the cutoff between easy runs and workouts; unset = 6:40).
function workoutPaceSec(){ var v=parseFloat(STD_PROFILE.runWorkoutPaceSec); return (v>=180&&v<=1200)?v:null; }
function includedPref(){
  var x=STD_PROFILE.runIncluded||{}, md=parseFloat(x.mindist);
  return { off:Array.isArray(x.off)?x.off.map(String):[], intensity:/^(all|workout|easy)$/.test(x.intensity)?x.intensity:FILTER_DEFAULTS.intensity,
    mindist:(md>=0&&md<=50)?String(x.mindist):FILTER_DEFAULTS.mindist };
}
function saveIncluded(okMsg){
  var off=[]; KNOWN_TYPES.forEach(function(t){ if(!ACTIVE_TYPES.has(t)) off.push(t); });
  var it=$('intensity'), md=$('mindist');
  var v={ off:off, intensity:it?it.value:FILTER_DEFAULTS.intensity, mindist:md?String(md.value).trim():FILTER_DEFAULTS.mindist };
  var dflt=!off.length && v.intensity===FILTER_DEFAULTS.intensity && parseFloat(v.mindist)===parseFloat(FILTER_DEFAULTS.mindist);
  return persist({ runIncluded: dflt?null:v }, okMsg);
}
// re-apply the stored choice (a failed save rolled it back): types, intensity and min distance
function applyIncluded(){
  var off=includedPref().off; ACTIVE_TYPES=new Set(); KNOWN_TYPES.forEach(function(t){ if(off.indexOf(t)<0) ACTIVE_TYPES.add(t); });
  buildTypeChips();
}
function filterParts(){
  var parts=[], off=[];
  KNOWN_TYPES.forEach(function(t){ if(!ACTIVE_TYPES.has(t)) off.push(t); });
  if(off.length===1) parts.push('no '+off[0]);
  else if(off.length>1) parts.push(ACTIVE_TYPES.size+' of '+KNOWN_TYPES.size+' activity types');
  var it=$('intensity'), md=$('mindist');
  if(it && it.value==='workout') parts.push('workouts only');
  else if(it && it.value==='easy') parts.push('easy runs only');
  if(md && parseFloat(md.value)!==parseFloat(FILTER_DEFAULTS.mindist)) parts.push('runs ≥ '+md.value.trim()+' mi');
  return parts;
}
function resetFilters(){
  ACTIVE_TYPES=new Set(KNOWN_TYPES);
  var it=$('intensity'), md=$('mindist');
  if(it) it.value=FILTER_DEFAULTS.intensity; if(md){ md.value=FILTER_DEFAULTS.mindist; fieldOk(md); }
  MINDIST_LAST=FILTER_DEFAULTS.mindist;
  buildTypeChips(); refresh();
  saveIncluded('Filters reset');
}
// Header freshness line: "369 runs · last run today 6:15 AM · Strava synced today". A stale history
// (last run > 3 days) gets a nudge to the import group — also when Strava is connected but stopped adding runs.
// Then: runs with no pace (they score no load), and the What's-included filter clause with Reset.
function renderStatus(){
  var el=$('rdxFresh'); if(!el) return;
  if(!RAW.length){ el.textContent=''; return; }   // the onboarding card's heading already says it
  var last=RAW[RAW.length-1].ts, s=RAW.length+' run'+(RAW.length===1?'':'s')+' · last run '+fmtRel(last);
  if(STRAVA_SYNC.connected && stravaSyncedTxt()) s+=' · Strava '+stravaSyncedTxt();
  el.textContent=s;
  var sep=function(){ el.appendChild(document.createTextNode(' · ')); };
  var link=function(txt,fn){ var b=document.createElement('button'); b.type='button'; b.className='rdx-link'; b.textContent=txt; b.onclick=fn; el.appendChild(b); return b; };
  var span=function(cls,txt){ var x=document.createElement('span'); x.className=cls; x.textContent=txt; el.appendChild(x); return x; };
  if(daysAgo(last)>3){ sep(); link('Import a newer export',function(){ openSettings('data'); }); }
  renderFileNote();
  var tr=typeRuns(), noPace=loadRuns().filter(function(r){ return !(r.paceSec>0); }).length;
  if(noPace){ sep(); span('warn', noPace===1?'1 run has no pace, so it doesn’t count toward load':noPace+' runs have no pace, so they don’t count toward load'); }
  if(!tr.length){ sep(); span('warn','Your filters exclude all '+RAW.length+' run'+(RAW.length===1?'':'s')); sep(); link('Reset',resetFilters); return; }
  var parts=filterParts();
  if(parts.length){ sep(); link('Filtered: '+parts.join(', '),function(){ openSettings('included'); }); sep(); link('Reset',resetFilters); }
}
// Profile inputs from STD_PROFILE — on load, and again after a failed save rolls the view back.
function fillProfileInputs(){
  var byBrand={}; RunDevices.LIST.forEach(function(d){ (byBrand[d.brand]=byBrand[d.brand]||[]).push(d); });
  $('device').innerHTML='<option value="">All metrics (no device set)</option>'+Object.keys(byBrand).map(function(b){return '<optgroup label="'+b+'">'+byBrand[b].map(function(d){return '<option value="'+d.id+'"'+(d.id===deviceId()?' selected':'')+'>'+d.label+'</option>';}).join('')+'</optgroup>';}).join('');
  $('weight').value=STD_PROFILE.weightLb||'';
  $('offload').value=STD_PROFILE.runLeverPctBW||'';
  $('easypace').value=easyPaceSec()!=null?fmtPace(easyPaceSec()):'';
  $('accessory').checked=hasAccessory();
  var wp=workoutPaceSec(); CUTOFF_LAST=$('cutoff').value=wp!=null?fmtPace(wp):FILTER_DEFAULTS.cutoff; fieldOk($('cutoff'));
  var inc=includedPref(), md=$('mindist'), it=$('intensity');
  it.value=inc.intensity; MINDIST_LAST=md.value=inc.mindist; fieldOk(md);
}
// Data & settings panel: open/close keeps the gear button's state in step.
function setPanel(open){
  var p=$('settingsPanel'), g=$('gearBtn'); if(!p) return;
  p.hidden=!open;
  if(g) g.setAttribute('aria-expanded',String(!!open));
}
// Open the panel at one group: 'events' (focus Type, or with {type} preset that type — firing its
// change handler — and focus the date) or 'data' (focus the drop zone).
function openSettings(group, preset){
  setPanel(true);
  var g=$('set-'+group); if(!g) return;
  var reduce=window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  g.scrollIntoView({block:'start', behavior:reduce?'auto':'smooth'});
  var f;
  if(group==='events'){
    f=$('evType');
    if(preset && preset.type && EV_META[preset.type]){ f.value=preset.type; f.onchange(); f=$('evDate'); }
  } else if(group==='data') f=$('drop');
  else if(group==='included') f=document.querySelector('#types .rdx-chip');
  if(f) f.focus({preventScroll:true});
}
// The import block lives in Data & settings → Import & data; with no runs it moves (appendChild keeps
// its listeners) into the onboarding card, with the export steps open.
function showSections(hasData){
  var blk=$('importBlock'), dst=$(hasData?'importSlot':'importHome'), had=false;
  if(blk && dst && blk.parentNode!==dst){ had=blk.contains(document.activeElement); dst.appendChild(blk); var h=$('exportHelp'); if(h) h.open=!hasData && ROLE!=='coach' && VIEW==='training'; }
  var gb=$('gearBtn'); if(gb) gb.hidden=!hasData;
  if(!hasData){ setPanel(false); var fl=$('rdxFlags'); if(fl) fl.hidden=true; }
  // a keyboard import from the onboarding card: the focused drop zone just moved into the closed panel —
  // keep focus on the page, on the button that opens where it went
  if(had && hasData && $('settingsPanel').hidden) $('gearBtn').focus({preventScroll:true});
  var emptyEl=$('sec-empty'); if(emptyEl) emptyEl.classList.toggle('show',!hasData);
  ['sec-hero','sec-chart','sec-patterns','sec-form','sec-about'].forEach(function(id){
    var e=$(id); if(e) e.classList.toggle('show',hasData);
  });
}

function renderLoaded(){
  cacheData();
  if(!RAW.length){ showSections(false); renderStatus(); return; }
  var dates=RAW.map(function(r){return r.date;}).sort(function(a,b){return a-b;});
  var min=dates[0], max=dates[dates.length-1];
  ANCHOR=dayEnd(new Date());   // Form & volume anchor on today (a lapsed athlete's "last 7 days" is really empty)
  annotateLever();
  buildTypeChips();
  showSections(true);
  renderDemoBar();
  var lm=$('loadMethod'); if(lm && window.RunLoad) lm.innerHTML=RunLoad.methodologyHTML();
  renderFileNote();
  if(inView('form')){
    var an=$('anchor'); an.value=ymd(ANCHOR); an.min=ymd(min); an.max=ymd(new Date());
    RANGES_EDITED=false; seedRanges();
    setCompare(true);
    renderFormSub();
  }
  fillProfileInputs();
  $('evDate').value=ymd(max);
  renderEventsList();
  if(inView('chart')){ populateMetricSelects(); setRange('3'); }
  // Strava attribution (API terms): the "Powered by Strava" mark shows whenever Strava runs do —
  // white on the dark theme, orange on light.
  var nStrava=RAW.filter(function(r){return r.source==='strava';}).length;
  var foot=$('foot'); if(foot) foot.innerHTML=   // the run count and span are in the header and settings already
    (nStrava?nStrava+' synced from Strava for runs with no watch import — Strava runs carry pace, distance, heart rate, cadence and ascent but no ground contact or oscillation; outdoor Strava runs are scored as if they came back down what they climbed, and treadmill runs take no hill surcharge. ':'')+
    'Track distances are converted from meters to miles.'+
    (nStrava?'<span class="rdx-strava"><img class="rdx-strava-w" src="/images/strava/api_logo_pwrdBy_strava_horiz_white.svg" alt="Powered by Strava"><img class="rdx-strava-o" src="/images/strava/api_logo_pwrdBy_strava_horiz_orange.svg" alt="Powered by Strava"></span>':'');
  refresh();
}

/* ---------- import ---------- */
// Garmin = one Activities.csv (text); Coros = a .zip of binary .fit files
// (or a single .fit). Both paths produce the same candidate run docs and
// share saveCandidates() for dedup/backfill/status.
// Import / backfill / delete status: the header line (#importStatus) AND #importNote inside the import block,
// since the header is off-screen when the action was taken from Data & settings. A final outcome (done =
// 'ok' | 'err') is also toasted — the announced copy (neither line is a live region, so progress ticks stay
// quiet), visible wherever the page is scrolled.
function impStatus(html, done){
  ['importStatus','importNote'].forEach(function(id){ var e=$(id); if(e) e.innerHTML=html; });
  var st=$('importStatus'); if(done && st) toast(st.textContent, done==='err'?{kind:'err'}:null);
}
// One import at a time: while one runs the drop zone reads busy and new files are refused with a toast.
// extra: appended to the import's final status (several files dropped → only the first is imported).
function readFile(f, extra){
  if(IMPORT_BUSY){ toast('An import is already running — wait for it to finish.'); return; }
  var name=String(f.name||'').toLowerCase(), kind=/\.zip$|\.fit$/.test(name)?'coros':/\.csv$/.test(name)?'csv':null;
  if(!kind){ impStatus('<span class="err">Unsupported file — drop a Garmin Activities.csv, a COROS .zip or a single .fit file.</span>'+(extra||''),'err'); return; }
  setImportBusy(true); IMPORT_EXTRA=extra||'';
  return kind==='coros'?readCorosFile(f):readGarminCsv(f);
}
function setImportBusy(on){
  IMPORT_BUSY=!!on;
  var d=$('drop'); if(d){ d.classList.toggle('busy',IMPORT_BUSY); if(IMPORT_BUSY) d.setAttribute('aria-disabled','true'); else d.removeAttribute('aria-disabled'); }
}
// An import's final outcome: clears the busy guard, adds the several-files note, reports (impStatus).
function impDone(html, kind){ var x=IMPORT_EXTRA; IMPORT_EXTRA=''; setImportBusy(false); impStatus(html+x, kind); }
// A COROS read failure in words the athlete can act on (the raw JSZip/parser text stays in the console).
function corosErrMsg(e){
  var m=String(e&&e.message||'');
  if(/central directory|zip file|Corrupted zip|End of data/i.test(m)) return 'That .zip couldn’t be opened — export it again from COROS Training Hub (choose .FIT).';
  if(m==='No .fit files found inside the .zip.') return 'No .fit files found inside the .zip. A Garmin account export isn’t supported — export Activities.csv from Garmin Connect instead.';
  return m||'Could not read this COROS file.';
}
function readGarminCsv(f){
  impStatus('<span class="rdx-spin"></span>Reading '+esc(f.name)+'…');
  var rd=new FileReader();
  rd.onerror=function(){ impDone('<span class="err">Could not read file.</span>','err'); };
  rd.onload=function(){
    var candidates;
    try{ candidates=parseExport(rd.result); }
    catch(e){ impDone('<span class="err">'+esc(e.message)+'</span>','err'); return; }
    saveCandidates(candidates);
  };
  rd.readAsText(f);
}
function readCorosFile(f){
  impStatus('<span class="rdx-spin"></span>Reading '+esc(f.name)+'…');
  var rd=new FileReader();
  rd.onerror=function(){ impDone('<span class="err">Could not read file.</span>','err'); };
  rd.onload=function(){
    parseCorosArchive(rd.result, f.name, function(done,total){
      impStatus('<span class="rdx-spin"></span>Parsing .fit files… '+done+'/'+total);
    }).then(function(candidates){ saveCandidates(candidates); })
      .catch(function(e){ console.error(e); impDone('<span class="err">'+esc(corosErrMsg(e))+'</span>','err'); });
  };
  rd.readAsArrayBuffer(f);
}
function saveCandidates(candidates){
  if(!candidates||!candidates.length){ impDone('<span class="err">No running activities found in this file.</span>','err'); return; }
  impStatus('<span class="rdx-spin"></span>Saving '+candidates.length+' runs…');
  backfill(candidates).then(function(res){
    return loadFromFirestore().then(function(){
      renderLoaded();
      var sample=candidates.filter(function(c){return c.ascentM!=null;})[0];
      var verify=sample?actCol().doc(sample.id).get().then(function(d){return d.exists&&d.data().ascentM!=null;}).catch(function(){ return null; }):Promise.resolve(null);
      verify.then(function(ok){
        var parts=[], stored=(res.updated||0)+(res.dupes||0); if(stored) parts.push(stored+' already stored'); if(res.replaced) parts.push(res.replaced+' Strava-synced replaced by watch data');
        if(res.replacedGarmin) parts.push(res.replacedGarmin+' sent by Garmin Connect replaced by this upload');
        if(candidates.csvUnits==='metric') parts.push('read as km/m');
        var head=res.added? '✓ '+res.added+' new run'+(res.added===1?'':'s') : '✓ No new runs';
        impDone('<span class="ok">'+head+'</span>'+(parts.length?' · '+parts.join(' · '):''),'ok');
        if(ok===false) console.warn('RunDynamics: elevation did not persist — check Firestore rules', sample&&sample.id);
      });
    });
  }).catch(function(e){
    console.error(e);
    impDone('<span class="err">Save failed: '+esc(e&&e.code||e&&e.message||e)+'</span>','err');
  });
}

/* ---------- shell markup ----------
   Page order: header strip → Data & settings panel (collapsed) → [onboarding card when there are no
   runs] → the view's sections → About these numbers, then the toast and the Lever modal. Training
   view: Today → Load over time → Form & volume. Injury view: Injury & illness history. #importBlock is built once and moved between the panel's
   Import & data group (#importSlot) and the onboarding card (#importHome) by showSections(). */
function shellHTML(opts){
  var your=who();
  var titleHTML = opts.title
    ? '<div class="rdx-title"><h2 class="rdx-h1">'+esc(opts.title)+'</h2>'+(opts.sub?'<p class="rdx-sub">'+opts.sub+'</p>':'')+'</div>'
    : '';
  var evOpts=['race','injury','illness','nonrun','timeoff'].map(function(t){ return '<option value="'+t+'">'+EV_META[t][0]+'</option>'; }).join('');
  var importBlock=
  '<div class="rdx-import" id="importBlock">'+
    '<div class="rdx-import-row">'+
      '<div class="rdx-drop" id="drop" role="button" tabindex="0"><b>Import a Garmin CSV or COROS .zip</b>'+
        '<span>Choose a file or drop it here — re-imports only add what’s new.</span>'+
        '<input type="file" id="file" accept=".csv,text/csv,.zip,.fit,application/zip" hidden></div>'+
      '<button type="button" class="rdx-btn rdx-btn-outline" id="stravaBackfill" hidden>⟲ Backfill Strava history</button>'+
      '<span class="rdx-tip-wrap" id="stravaBackfillTip" hidden>'+tipHTML('Fetches the entire Strava history and adds one run per day for every day with no imported activity.','Backfill Strava history')+'</span>'+
    '</div>'+
    '<p class="rdx-imp-note" id="importNote"></p>'+
    '<details class="rdx-more" id="exportHelp"><summary>How to export '+your+' run history</summary>'+
      '<div class="rdx-more-body">'+
        '<p>Export from '+your+' watch platform with the steps below, then drop the file in the import box above. '+
          'Everything is read in your browser and de-duplicated by start time, so re-uploads only add what is new — and importing from more than one source is fine.</p>'+
        '<p><b>Garmin Connect</b> — one <code>Activities.csv</code>:</p><ol>'+
        '<li>On a computer, open <a href="https://connect.garmin.com/modern/activities" target="_blank" rel="noopener">Garmin Connect → Activities → All Activities</a> and sign in.</li>'+
        '<li>Use the <b>filter</b> controls to set <b>Activity Type → Running</b> (optional) and the <b>date range</b> you want.</li>'+
        '<li><b>Scroll to the bottom</b> so every activity in that range loads on screen — the export only includes what is loaded.</li>'+
        '<li>Click <b>Export CSV</b> (top-right) to download <code>Activities.csv</code>.</li>'+
        '<li>Drop that file in the import box above. Runs are de-duplicated by start time, so re-uploads only add what is new.</li>'+
      '</ol>'+
        '<p><b>COROS Training Hub</b> — a <code>.zip</code> of per-activity <code>.fit</code> files, delivered by email:</p><ol>'+
        '<li>On a computer, open <a href="https://t.coros.com" target="_blank" rel="noopener">COROS Training Hub (t.coros.com)</a> and sign in.</li>'+
        '<li>Open the <b>Activity List</b> tab at the top. To import only part of the history, use the list\'s <b>filter</b> controls to narrow by <b>date range</b> and sport first (optional — re-imports de-dupe, so exporting everything is fine too).</li>'+
        '<li>Click <b>Export Data</b> on the right, choose <b>.FIT</b> as the format, and enter the <b>email address</b> to send the export to.</li>'+
        '<li>COROS emails a <b>download link</b> (usually within a few minutes). Open it and download the <code>.zip</code> — it holds one <code>.fit</code> file per activity.</li>'+
        '<li>Drop that <code>.zip</code> in the import box above (a single <code>.fit</code> works too). Each <code>.fit</code> is unpacked and read right in your browser.</li>'+
      '</ol>'+
        '<p>Running-form metrics (ground contact, vertical oscillation, cadence, stride) need a compatible device or strap — runs recorded without one still import for load and pace, they just skip those fields. Garmin\'s CSV export is capped at ~1,000 rows and only includes what is loaded on screen, so export long Garmin histories in chunks by date range — each chunk merges in automatically.</p>'+
        '<p>Strava connected (via the coaching dashboard)? The last 2 years of Strava runs sync in automatically for runs with no watch import — and <b>Backfill Strava history</b> pulls the entire Strava history at once for the same gap-fill. Strava can\'t provide ground contact, oscillation, or descent, so uploading a watch export for those runs replaces the Strava copy with the full-metric version.</p>'+
      '</div></details>'+
  '</div>';
  return ''+
  titleHTML+
  // 0. header strip: freshness + import status, and the settings button (hidden until runs exist)
  '<div class="rdx-head">'+
    '<div class="rdx-status"><span id="rdxFresh"></span><span id="importStatus"></span></div>'+
    '<div class="rdx-head-acts">'+
      '<button type="button" class="rdx-btn rdx-btn-outline" id="gearBtn" aria-expanded="false" aria-controls="settingsPanel" hidden>⚙ Data &amp; settings</button>'+
    '</div>'+
  '</div>'+
  '<div class="rdx-flags" id="rdxFlags" hidden></div>'+

  // 1. Data & settings
  '<div class="rdx-settings" id="settingsPanel" role="region" aria-label="Data and settings" hidden><div id="gcSet"></div><div class="rdx-set-grid">'+
    '<section class="rdx-group" id="set-events" aria-labelledby="setEventsHd">'+
      '<h3 class="rdx-group-hd" id="setEventsHd">Events</h3>'+
      '<div class="rdx-group-main">'+
        '<div class="rdx-ev-form" role="group" aria-labelledby="setEventsHd">'+
          '<select id="evType" aria-label="Event type" aria-describedby="evHint">'+evOpts+'</select>'+
          '<input type="date" id="evDate" aria-label="Date" aria-describedby="evHint">'+
          '<span class="rdx-ev-end" id="evEndCtl" hidden><span class="rdx-ev-to" aria-hidden="true">to (optional)</span><input type="date" id="evEndDate" aria-label="End date (optional)" aria-describedby="evHint"></span>'+
          '<input type="text" id="evNote" class="rdx-ev-note-in" aria-label="Note" placeholder="'+EV_PH.race+'">'+
          '<button type="button" class="rdx-btn" id="evAdd">+ add</button>'+
          '<button type="button" class="rdx-linkbtn" id="evCancel" hidden>Cancel</button>'+
        '</div>'+
        '<p class="rdx-ev-hint"><span id="evHint">'+EV_HINT.race+'</span> <button type="button" class="rdx-linkbtn" id="wtlTog" aria-expanded="false" aria-controls="wtlBox">What to log?</button></p>'+
        '<div class="rdx-wtl-box" id="wtlBox" hidden>'+whatToLogHTML()+'</div>'+
        '<div class="rdx-ev-logged"><span id="evCount"></span> <button type="button" class="rdx-linkbtn" id="evListTog" aria-expanded="false" aria-controls="eventsList" hidden>show</button>'+
          '<div class="rdx-events" id="eventsList" hidden></div></div>'+
      '</div>'+
    '</section>'+
    '<section class="rdx-group" id="set-profile" aria-labelledby="setProfileHd">'+
      '<h3 class="rdx-group-hd" id="setProfileHd">Profile</h3>'+
      '<div class="rdx-group-body">'+
        '<div class="rdx-ctl"><label for="device">Device</label><select id="device"></select></div>'+
        '<div class="rdx-ctl"><span class="rdx-lbl">Strap / pod</span><label class="rdx-check"><input type="checkbox" id="accessory"> '+(ROLE==='coach'?'Runs with a chest strap or foot pod':'I run with a chest strap or foot pod')+'</label></div>'+
        '<div class="rdx-ctl"><label for="weight">Body weight</label><div class="rdx-inunit"><input type="text" id="weight" inputmode="decimal" placeholder="—" style="width:64px"><span>lb</span></div></div>'+
        '<div class="rdx-ctl"><div class="rdx-lblrow"><label for="offload">Lever support</label>'+tipHTML('The share of body weight run at on the Lever (85% BW = 15% offload) — the default for auto-detected Lever runs and the starting value in Mark Lever runs.','Lever support')+'</div><div class="rdx-inunit"><input type="text" id="offload" inputmode="decimal" placeholder="85" style="width:56px"><span>% BW</span></div></div>'+
        '<div class="rdx-ctl"><div class="rdx-lblrow"><label for="easypace">Easy pace</label>'+tipHTML('Used as the load baseline until there are enough easy runs to calibrate from.','Easy pace')+'</div><div class="rdx-inunit"><input type="text" id="easypace" placeholder="9:00" style="width:64px"><span id="easypaceUnit">/mi</span></div></div>'+
        '<div class="rdx-ctl"><div class="rdx-lblrow"><label for="cutoff">Workout pace</label>'+tipHTML('Runs faster than this count as workouts. Slower runs count as easy, and easy runs set the baseline pace every run is scored against — so changing it can move Today’s numbers.','Workout pace')+'</div><div class="rdx-inunit"><input type="text" id="cutoff" value="6:40" placeholder="6:40" style="width:66px"><span>/mi</span></div></div>'+
        '<div class="rdx-ctl rdx-ctl-wide"><span class="rdx-lbl">Lever runs</span><div class="rdx-inunit"><button type="button" class="rdx-btn rdx-btn-outline" id="lvOpen" aria-haspopup="dialog">Mark Lever runs…</button><span class="rdx-lv-hint" id="lvHint"></span></div></div>'+
      '</div>'+
    '</section>'+
    '<section class="rdx-group" id="set-included" aria-labelledby="setIncludedHd">'+
      '<h3 class="rdx-group-hd" id="setIncludedHd">What’s included</h3>'+
      '<div class="rdx-group-body"><div class="rdx-gc-grp" id="gcInc"></div>'+
        '<div class="rdx-ctl rdx-ctl-wide"><div class="rdx-lblrow"><span class="rdx-lbl" id="typesLbl">Activity types</span>'+tipHTML('Applies to Form & volume and the metric chart only. Today, the load chart and Injury Patterns count every run type (a Lever run at its offload).','Activity types')+'</div><div class="rdx-types" id="types" role="group" aria-labelledby="typesLbl"></div></div>'+
        '<div class="rdx-ctl"><div class="rdx-lblrow"><label for="intensity">Run intensity</label>'+tipHTML('Applies to Form & volume and the metric chart only — not to Today, the load chart or Injury Patterns.','Run intensity')+'</div><select id="intensity"><option value="all">All runs</option><option value="workout">Workouts only</option><option value="easy">Easy only</option></select></div>'+
        '<div class="rdx-ctl"><label for="mindist">Min distance</label><div class="rdx-inunit"><input type="text" id="mindist" value="0.5" inputmode="decimal" style="width:56px"><span>mi</span></div></div>'+
      '</div>'+
    '</section>'+
    '<section class="rdx-group" id="set-data" aria-labelledby="setDataHd">'+
      '<h3 class="rdx-group-hd" id="setDataHd">Import &amp; data</h3>'+
      '<div class="rdx-group-main"><div class="rdx-gc-grp" id="gcData"></div>'+
        '<div id="importSlot">'+importBlock+'</div>'+
        // the delete confirm() spells out what is kept
        '<div class="rdx-data-foot"><p class="rdx-filenote" id="filenote"></p><button type="button" class="rdx-btn rdx-btn-danger rdx-btn-sm" id="resetData">Delete all imported runs</button></div>'+
      '</div>'+
    '</section>'+
  '</div></div>'+

  // no runs: onboarding card (the import block moves in here)
  '<div class="rdx-section" id="sec-empty"><div class="rdx-card rdx-empty-card">'+
    '<h2 class="rdx-sec-title" id="emptyHd" tabindex="-1">Import '+your+' run history to get started</h2>'+
    (VIEW==='injury'?'<p class="rdx-pat-lead">Injury patterns need about 10 weeks of run history. After importing, log past overuse injuries and illnesses here to see what training looked like before each.</p>':'')+
    '<p class="rdx-sec-sub">'+(ROLE==='coach'
      ? 'Drop a Garmin or COROS export below, or ask this athlete to connect Strava from their coaching dashboard — recent runs then fill in automatically.'
      : 'Drop a Garmin or COROS export below, or connect Strava from the <a href="/coaching/">coaching dashboard</a> and recent runs fill in automatically.')+'</p>'+
    '<div id="importHome"></div>'+
  '</div></div>'+

  (inView('hero') ? ''+
  // 2. Today
  '<div class="rdx-section" id="sec-hero">'+(ADMIN?'<div class="rdx-demobar" id="demobar"></div>':'')+'<div id="gcHero"></div><div class="rdx-hero" id="hero"></div></div>'+

  // 3. Load over time
  '<div class="rdx-section" id="sec-chart">'+
    '<div class="rdx-sec-hd">'+
      '<div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="chartTitle">Load over time</h2><p class="rdx-sec-sub" id="chartSub"></p><div id="gcChart"></div></div>'+
      '<div class="rdx-sec-ctl rdx-chart-ctl">'+
        '<div class="rdx-seg" id="rdx-rangeChips" role="group" aria-label="Date range">'+
          [['3','3M'],['6','6M'],['12','1Y'],['all','All'],['custom','Custom']].map(function(r){ return '<button type="button" data-range="'+r[0]+'" aria-pressed="false">'+r[1]+'</button>'; }).join('')+
        '</div>'+
        '<label class="rdx-inl">Show <select id="chartView"></select></label>'+
        '<label class="rdx-inl" id="chartView2Wrap" hidden>vs <select id="chartView2"></select></label>'+
      '</div>'+
    '</div>'+
    '<div class="rdx-chart-row2">'+
      '<div class="rdx-custom" id="customRange" hidden>'+
        '<div class="rdx-ctl"><label for="tFrom">From</label><input type="date" id="tFrom"></div>'+
        '<div class="rdx-ctl"><label for="tTo">To</label><input type="date" id="tTo"></div>'+
      '</div>'+
      '<div class="rdx-inl" id="dispWrap" hidden><span id="dispLbl">Display</span><div class="rdx-types" role="group" aria-labelledby="dispLbl">'+
        [['hideOutliers','Hide outliers',1],['smooth','Smooth',1],['points','Points',0]].map(function(c){ return '<button type="button" class="rdx-chip'+(c[2]?' on':'')+'" id="'+c[0]+'" aria-pressed="'+!!c[2]+'">'+c[1]+'</button>'; }).join('')+
      '</div></div>'+
    '</div>'+
    '<div class="rdx-chartwrap"><div class="rdx-legend" id="chartLegend"></div><div id="chartBox"></div><p class="rdx-ev-cap" id="chartEvCap"></p></div>'+
    '<p class="rdx-note" id="chartCaption"><span id="chartCapTxt"></span><button type="button" class="rdx-link" id="chartHow">How IAD is calculated →</button></p>'+
  '</div>' : '')+

  // 4. Injury & illness history (the Injury Patterns view)
  (inView('patterns') ? ''+
  '<div class="rdx-section" id="sec-patterns">'+
    '<div class="rdx-sec-hd">'+
      '<div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title" id="patHead" tabindex="-1">What came before each setback</h2>'+
        '<p class="rdx-sec-sub">How '+your+' training looked in the weeks before each logged injury or illness.</p><div id="gcPat"></div></div>'+
      '<div class="rdx-sec-ctl"><button type="button" class="rdx-gapchip" id="patGapChip" hidden></button></div>'+
    '</div>'+
    '<div id="patternsBox"></div>'+
  '</div>' : '')+

  // 5. Form & volume — #anchor ("as of") drives the form tiles and the volume windows only
  (inView('form') ? ''+
  '<div class="rdx-section" id="sec-form">'+
    '<div class="rdx-sec-hd">'+
      '<div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title">Form &amp; volume</h2><p class="rdx-sec-sub" id="formSub">Last 90 days vs the 90 before · distances are actual miles, not IAD</p><div id="gcForm"></div></div>'+
      '<div class="rdx-sec-ctl"><label class="rdx-inl">as of <input type="date" id="anchor"></label></div>'+
    '</div>'+
    '<div class="rdx-tiles" id="formTiles"></div>'+
    '<div id="sec-summary"><h3 class="rdx-sub-hd" id="volHd">Volume</h3><div id="cards"></div></div>'+
    '<details class="rdx-more rdx-form-more"><summary>All metrics &amp; compare periods</summary>'+
      '<div class="rdx-more-body">'+
        '<div class="rdx-cmpbar">'+
          '<button type="button" class="rdx-chip on" id="formCompare" aria-pressed="true">⇄ Compare two ranges</button>'+
          '<div class="rdx-cmp-ranges" id="cmpRanges">'+
            [['a','A'],['b','B']].map(function(r){ var f='f'+r[0]; return '<div class="rdx-ctl" role="group" aria-labelledby="'+f+'Lbl"><span class="rdx-lbl" id="'+f+'Lbl">Range '+r[1]+'</span>'+
              '<div class="rdx-cmp-dates"><input type="date" id="'+f+'From" aria-label="Range '+r[1]+' from"><span aria-hidden="true">–</span><input type="date" id="'+f+'To" aria-label="Range '+r[1]+' to"></div></div>'; }).join('')+
          '</div>'+
        '</div>'+
        '<div class="rdx-tablewrap"><table class="rdx-table" id="ftable"></table></div>'+
        '<p class="rdx-note" id="formHint"></p>'+
      '</div>'+
    '</details>'+
  '</div>' : '')+

  // 6. About these numbers (both views — it carries the Strava attribution)
  '<div class="rdx-section" id="sec-about">'+
    '<div class="rdx-sec-hd"><div class="rdx-sec-hd-txt"><h2 class="rdx-sec-title">About these numbers</h2></div></div>'+
    '<details class="rdx-more" id="loadMethodBox"><summary>How Impact Load (IAD) is calculated — equation, variables &amp; sources</summary><div class="rdx-more-body" id="loadMethod"></div></details>'+
    '<p class="rdx-foot" id="foot"></p>'+
  '</div>'+

  '<div class="rdx-toast" id="rdxToast" role="status" aria-live="polite"></div>'+

  '<div class="rdx-modal" id="lvModal" hidden>'+
    '<div class="rdx-modal-panel" role="dialog" aria-modal="true" aria-labelledby="lvTitle" aria-describedby="lvDesc" tabindex="-1">'+
      '<div class="rdx-modal-hd"><h3 class="rdx-modal-title" id="lvTitle">Mark Lever runs</h3>'+
        '<button type="button" class="rdx-modal-x" id="lvClose" aria-label="Close">✕</button></div>'+
      '<div class="rdx-modal-intro"><div id="gcLv"></div><p class="rdx-modal-sub" id="lvDesc">Pick the treadmill runs '+(ROLE==='coach'?'this athlete':'you')+' did on the Lever and set the body-weight support. Their Impact Load (IAD) is recalculated with the offload discount, and the guidance card, load chart and injury patterns update.</p></div>'+
      '<div class="rdx-lv-bar">'+
        '<div class="rdx-ctl"><label for="lvOff">Lever support</label><div class="rdx-inunit"><input type="number" id="lvOff" min="5" max="99" step="any" inputmode="decimal" aria-describedby="lvOffCap"><span>% body weight</span></div><div class="rdx-lv-cap" id="lvOffCap"></div></div>'+
        '<div class="rdx-ctl"><label>Show</label><div class="rdx-types" id="lvFilter" role="group" aria-label="Filter runs"></div></div>'+
        '<div class="rdx-lv-note">Auto-detected = a treadmill run with a heart rate low for its pace. A manual mark always wins over detection and titles; <b>Reset to auto</b> removes it.</div>'+
      '</div>'+
      '<div class="rdx-lv-list" id="lvList"></div>'+
      '<div class="rdx-modal-ft">'+
        '<div class="rdx-lv-sum" id="lvSum"></div>'+
        '<div class="rdx-lv-acts">'+
          '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="lvReset">Reset to auto</button>'+
          '<button type="button" class="rdx-btn rdx-btn-outline rdx-btn-sm" id="lvNot">Not Lever</button>'+
          '<button type="button" class="rdx-btn rdx-btn-sm" id="lvMark">Mark as Lever</button>'+
        '</div>'+
        '<div class="rdx-lv-toast" id="lvToast" role="status" aria-live="polite"></div>'+
      '</div>'+
    '</div>'+
  '</div>';
}

/* ---------- wiring ---------- */
function smoothScroll(el){ var reduce=window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; el.scrollIntoView({block:'start', behavior:reduce?'auto':'smooth'}); }
function wire(){
  var drop=$('drop'), fileInput=$('file');
  var busyMsg=function(){ toast('An import is already running — wait for it to finish.'); };
  var pick=function(){ if(IMPORT_BUSY) busyMsg(); else fileInput.click(); };
  var take=function(files){ var f=files&&files[0]; if(f) readFile(f, files.length>1?' · only the first file was imported — drop the others one at a time':''); };
  drop.onclick=pick;
  drop.onkeydown=function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pick(); } };
  drop.ondragover=function(e){ e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave=function(){ drop.classList.remove('over'); };
  drop.ondrop=function(e){ e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files); };
  fileInput.onchange=function(e){ take(e.target.files); fileInput.value=''; };
  wireTips(ROOT);
  $('gearBtn').onclick=function(){ setPanel($('settingsPanel').hidden); };
  // the two one-line toggles in Events: the what-to-log list and the logged events (in place, no re-render)
  [['wtlTog','wtlBox'],['evListTog','eventsList']].forEach(function(x){ $(x[0]).onclick=function(){
    var box=$(x[1]), open=box.hidden; box.hidden=!open; this.setAttribute('aria-expanded',String(open));
    if(x[0]==='evListTog') this.textContent=open?'hide':'show'; }; });
  $('intensity').onchange=function(){ refresh(); saveIncluded(); };
  $('cutoff').onchange=function(e){ var v=String(e.target.value).trim(), sec=hmsToSec(v);
    if(!v){ CUTOFF_LAST=e.target.value=FILTER_DEFAULTS.cutoff; persist({ runWorkoutPaceSec:null }); refresh(); return; }
    if(!/^\d{1,2}:\d{2}$/.test(v) || !(sec>=180 && sec<=1200)){ fieldErr('cutoff','Workout pace must look like 6:40.',CUTOFF_LAST); return; }
    CUTOFF_LAST=e.target.value=v; persist({ runWorkoutPaceSec: sec===hmsToSec(FILTER_DEFAULTS.cutoff)?null:sec }); refresh(); };
  $('mindist').onchange=function(e){ var v=String(e.target.value).trim(), n=parseFloat(v);
    if(!/^\d*\.?\d+$/.test(v) || !(n>=0 && n<=50)){ fieldErr('mindist','Min distance must be a number of miles, e.g. 0.5.',MINDIST_LAST); return; }
    MINDIST_LAST=e.target.value=v; refresh(); saveIncluded(); };
  ['weight','offload','easypace','cutoff','mindist'].forEach(function(id){ $(id).addEventListener('input',function(){ fieldOk(this); }); });
  if(inView('chart')){
    $('chartView').onchange=function(){ syncOverlaySelect(); renderChart(); };
    $('chartView2').onchange=renderChart;
    // the field just edited carries the error mark when From ends up after To; the other gets a linked limit
    ['tFrom','tTo'].forEach(function(id){ $(id).onchange=function(){
      var f=$('tFrom'), t=$('tTo'); if(id==='tFrom') t.min=f.value; else f.max=t.value;
      fieldOk(f); fieldOk(t);
      var a=parseDate(f.value), b=parseDate(t.value);
      if(a&&b&&dayEnd(b).getTime()<a.getTime()){ this.classList.add('rdx-df-err'); this.setAttribute('aria-invalid','true'); }
      setRangeChip('custom'); renderChart(); }; });
    ['hideOutliers','smooth','points'].forEach(function(id){ $(id).onclick=function(){ this.setAttribute('aria-pressed',String(this.classList.toggle('on'))); renderChart(); }; });
    Array.prototype.forEach.call($all('#rdx-rangeChips [data-range]'),function(c){ c.onclick=function(){
      var r=c.getAttribute('data-range');
      if(r==='custom'){ setRangeChip('custom'); $('tFrom').focus(); } else applyRange(r);   // Custom keeps the current dates until one is edited
    }; });
    wireEventCap($('chartBox'));
    $('chartHow').onclick=function(){ var d=$('loadMethodBox'); d.open=true; smoothScroll(d); d.querySelector('summary').focus({preventScroll:true}); };
  }
  if(inView('form')){
    // as of: empty → back to today; a new date also moves Range A/B unless they were edited by hand
    $('anchor').onchange=function(e){ var d=parseDate(e.target.value); if(!d){ d=new Date(); e.target.value=ymd(d); }
      ANCHOR=dayEnd(d); if(!RANGES_EDITED) seedRanges(); renderFormSub(); refresh(); };
    ['faFrom','faTo','fbFrom','fbTo'].forEach(function(id){ $(id).onchange=function(){ RANGES_EDITED=true; renderForm(); }; });
    $('formCompare').onclick=function(){ setCompare(!this.classList.contains('on')); renderForm(); };
  }
  if(inView('patterns')) $('patGapChip').onclick=function(){ var g=$('rdxGaps'); if(!g) return; GAPS_OPEN=g.open=true; smoothScroll(g); var h=$('rdxGapsHd'); if(h) h.focus({preventScroll:true}); };
  $('device').onchange=function(e){ persist({ runDevice:e.target.value }); populateMetricSelects(); refresh(); };
  $('accessory').onchange=function(){ var on=this.checked; persist({ runHasAccessory:on }); populateMetricSelects(); refresh(); };
  // an empty field clears the stored value; an invalid entry is never stored (fieldErr puts the stored value back)
  $('weight').onchange=function(e){ var v=String(e.target.value).trim();
    if(!v){ persist({ weightLb:null }); refresh(); return; }
    var lb=parseFloat(v);
    if(!/^\d+(\.\d+)?\s*(lb|lbs)?$/i.test(v) || !(lb>=50 && lb<=400)){ fieldErr('weight','Body weight must be a number from 50 to 400 lb.',STD_PROFILE.weightLb||''); return; }
    e.target.value=lb; persist({ weightLb:lb }); refresh(); };
  $('offload').onchange=function(e){ var v=String(e.target.value).trim();
    if(!v){ persist({ runLeverPctBW:null }); refresh(); return; }
    var pct=parseFloat(v);
    if(!/^\d+(\.\d+)?\s*%?\s*(bw)?$/i.test(v) || !(pct>=1 && pct<=99)){ fieldErr('offload','Lever support must be between 1 and 99 % BW.',STD_PROFILE.runLeverPctBW||''); return; }
    e.target.value=pct; persist({ runLeverPctBW:pct }); refresh(); };
  $('easypace').onchange=function(e){ var v=String(e.target.value).trim();
    if(!v){ persist({ runEasyPaceSec:null }); refresh(); return; }
    var sec=hmsToSec(v);
    if(!(sec>=240 && sec<=1200)){ fieldErr('easypace','Easy pace must be between 4:00 and 20:00 /mi.',easyPaceSec()!=null?fmtPace(easyPaceSec()):''); return; }
    e.target.value=fmtPace(sec); persist({ runEasyPaceSec:sec }); refresh(); };
  $('evAdd').onclick=evAdd;
  wireLeverModal();
  $('evCancel').onclick=function(){ evCancelEdit(true); };
  $('evType').onchange=function(){ var race=this.value==='race'; $('evEndCtl').hidden=race; if(race) $('evEndDate').value=''; evDateMax(this.value,['evDate','evEndDate']); evClearErr(); $('evHint').textContent=EV_HINT[this.value]||''; $('evNote').placeholder=EV_PH[this.value]||''; };
  $('evNote').onkeydown=function(e){ if(e.key==='Enter') evAdd(); };
  ['evDate','evEndDate'].forEach(function(id){ $(id).oninput=evClearErr; });
  $('eventsList').onclick=function(e){ var b=e.target.closest&&e.target.closest('.rdx-ev-del'); if(b){ evDelete(b.getAttribute('data-id'), e.detail===0); return; }
    var p=e.target.closest&&e.target.closest('.rdx-ev-pick'); if(p){ if(EV_EDIT===p.getAttribute('data-id')) evCancelEdit(true); else evEdit(p.getAttribute('data-id')); } };
  $('set-events').onkeydown=function(e){ if(e.key==='Escape' && EV_EDIT!=null){ e.stopPropagation(); evCancelEdit(true); } };
  $('resetData').onclick=function(){
    var btn=this, nGarmin=RAW.filter(function(r){ return r.source==='garmin'; }).length;
    if(!confirm('Delete ALL of '+who()+' stored run history ('+RAW.length+' runs)?\n\n'+
      'This clears every imported activity so a fresh export can be re-imported clean — '+
      'use it if a bad activity got stuck in an earlier upload. '+
      'Profile, logged events, dismissed gaps and Lever marks are kept.'+
      (STRAVA_SYNC.connected?'\n\nStrava-synced runs come back automatically within a day.':'')+
      (nGarmin?'\n\n'+nGarmin+(nGarmin===1?' run':' runs')+' sent by Garmin Connect '+(nGarmin===1?'is':'are')+' deleted too, and Garmin Connect won’t send '+(nGarmin===1?'it':'them')+' again.':'')+
      '\n\nThis cannot be undone.')) return;
    btn.disabled=true;
    impStatus('<span class="rdx-spin"></span>Deleting '+RAW.length+' stored runs…');
    deleteAllRuns().then(function(n){
      RAW=[]; KNOWN_TYPES=new Set(); ACTIVE_TYPES=new Set();
      renderLoaded();
      impStatus('<span class="ok">✓ '+n+' runs deleted</span> · import an export below to start fresh.','ok');
      // the panel closed and the page collapsed under the pointer: bring the status line and the
      // onboarding card into view, and put focus on the card (the pressed button is gone)
      var hd=ROOT.querySelector('.rdx-head'), h=$('emptyHd'); if(hd) smoothScroll(hd); if(h) h.focus({preventScroll:true});
    }).catch(function(e){
      console.error(e);
      // A mid-way batch failure leaves a partial history — reload so the view
      // shows what actually remains rather than the pre-delete state.
      return loadFromFirestore().then(renderLoaded).catch(function(){}).then(function(){
        impStatus('<span class="err">Delete failed: '+esc(e&&e.code||e&&e.message||e)+'</span>','err');
      });
    }).then(function(){ btn.disabled=false; });
  };
  // Backfill = the daily Strava gap-fill without the 2-year cutoff: the
  // server pages the athlete's ENTIRE history through Strava's list endpoint
  // (200 activities per request — no per-activity calls) and adds a run doc
  // for every day with no imported activity. Re-runs are cheap: already
  // stored runs are skipped server-side.
  $('stravaBackfill').onclick=function(){
    var btn=this;
    if(DEMO || !(window.firebase && firebase.functions)) return;
    btn.disabled=true;
    impStatus('<span class="rdx-spin"></span>Backfilling from Strava — fetching the full activity history, this can take a minute…');
    var who=syncActor(), payload={backfill:true}; if(who.real && who.real!==UID) payload.athleteUid=UID;   // act for the athlete shown, never the caller by accident
    // The callable SDK's default client timeout is 70s; a full-history
    // backfill (up to 40 sequential Strava page fetches) can outlast it,
    // surfacing as deadline-exceeded while the server keeps working.
    // Match the function's own timeoutSeconds: 300.
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
    }).then(function(){ btn.disabled=false; });
  };
}

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
  var L=window.esLabs, real=(L && ('realUser' in L)) ? ((L.realUser&&L.realUser.uid)||null) : UID, admin=!!real && !!L && real===L.ADMIN_UID;
  return {real:real, admin:admin, canSync:real===UID || admin};
}
var STRAVA_SYNC_MIN_MS=60*60*1000;   // client auto-sync at most once an hour per athlete
function maybeSyncStrava(){
  if(ROLE==='coach' || DEMO) return;   // the coaching page runs its own athlete-scoped sync in the coach view
  if(!STRAVA_SYNC.connected) return;
  var who=syncActor(); if(!who.canSync) return;
  if(!(window.firebase && firebase.functions)) return;
  var last=STRAVA_SYNC.last;
  if(last){
    var d=last.toDate?last.toDate():new Date(last);
    if(Date.now()-d.getTime() < STRAVA_SYNC_MIN_MS) return;   // synced within the hour (webhook covers uploads in between)
  }
  var container=ROOT, my=MOUNT;
  firebase.functions().httpsCallable('syncStravaActivities',{timeout:300000})(who.real!==UID?{athleteUid:UID}:{}).then(function(res){
    if(ROOT!==container || my!==MOUNT) return;
    // the server stamped stravaLastSyncedAt (even with nothing new): the header's "Strava synced" reads this
    STRAVA_SYNC.last=new Date();
    var n=res&&res.data&&res.data.runDocs;
    if(!n){ renderStatus(); return; }
    return loadFromFirestore().then(function(){ if(ROOT===container && my===MOUNT) renderLoaded(); });
  }).catch(function(e){ console.warn('RunDynamics: Strava sync failed', e); });
}

/* ---------- public entry point ---------- */
function mount(container, opts){
  opts=opts||{};
  if(RO){ RO.disconnect(); RO=null; }   // the previous mount's chart box is gone
  if(WIN_RS){ window.removeEventListener('resize',WIN_RS); WIN_RS=null; }
  clearTimeout(RO_T); CHART_W=0;
  if(!container || !opts.db || !opts.uid){
    if(container) container.innerHTML='<div class="rdx rdx-empty">Run Dynamics: missing db/uid.</div>';
    return;
  }
  injectCSS();
  if(ROOT && UID){ var cv=captureView(); if(cv) VIEWSTATE[UID]=Object.assign(VIEWSTATE[UID]||{}, cv); }
  ROOT=container; DB=opts.db; UID=opts.uid; ROLE=opts.role||'athlete'; ADMIN=!!opts.admin; DEMO=null;
  VIEW=VIEW_SECS[opts.view]?opts.view:'training';
  var my=++MOUNT; PROFILE_ERR=null;
  DIS_OPEN=false; DIS_T=0; DIS_SEQ=0; GAP_FORM=null; EV_EDIT=null; SB_MORE=false; ALSO_ALL=false; PAT_STATS=true; GAPS_OPEN=false; HERO_HELP=false; HERO_MORE=false; CAP_PIN=''; clearTimeout(LV.toastT); clearTimeout(TOAST_T); TOAST_ARM=TOAST_BACK=null; SAVE_SEQ={}; LV={filter:'all', sel:new Set(), rows:[], trigger:null, toastT:null};
  IMPORT_BUSY=false; IMPORT_EXTRA=''; CUTOFF_LAST=FILTER_DEFAULTS.cutoff; MINDIST_LAST=FILTER_DEFAULTS.mindist;
  RAW=[]; ACTIVE_TYPES=new Set(); KNOWN_TYPES=new Set(); ANCHOR=null; LOAD_PARAMS=null; STD_PROFILE={}; STRAVA_LEVER=[]; STRAVA_SYNC={};
  container.classList.add('rdx');
  container.innerHTML=shellHTML(opts);
  wire();
  watchChartSize(container);
  var st=$('importStatus'), cache=DATA_CACHE[UID];
  if(cache && cache.raw.length){
    // the last data for this athlete, at once (no blank shell; the host keeps its scroll) — refetched below
    RAW=cache.raw; STD_PROFILE=Object.assign({},cache.profile); STRAVA_LEVER=cache.lever||[]; STRAVA_SYNC=cache.sync||{};
    try{ renderLoaded(); restoreView(VIEWSTATE[UID]); }catch(e){ console.warn('RunDynamics: cached render failed',e); cache=null; }
  } else cache=null;
  if(st && !cache) st.innerHTML='<span class="rdx-spin"></span>Loading stored runs…';
  Promise.all([loadProfile(), loadFromFirestore(), fetchStravaLever()]).then(function(){
    if(ROOT!==container || my!==MOUNT) return;   // a newer mount superseded this one
    var vs=cache?captureView():VIEWSTATE[UID];   // the cached render may have been used meanwhile
    renderLoaded();
    restoreView(vs);
    // the freshness line (#rdxFresh) now says what was loaded; the status only carries a profile error
    if(st) st.innerHTML = PROFILE_ERR?'<span class="err">⚠ Profile settings and logged events didn’t load ('+esc(PROFILE_ERR)+') — showing defaults, and changes are blocked until you reload.</span>':'';
    var bf=$('stravaBackfill'), bft=$('stravaBackfillTip'); if(bf && STRAVA_SYNC.connected && syncActor().canSync){ bf.hidden=false; if(bft) bft.hidden=false; }
    maybeSyncStrava();
  }).catch(function(e){
    console.error(e);
    if(st && my===MOUNT) st.innerHTML='<span class="err">Could not load stored runs: '+esc(e&&e.message||e)+'</span>';
  });
}

// Snapshot of the on-screen view state; fields whose controls aren't in this view are left out.
function captureView(){
  if(!ROOT || !RAW.length) return null;
  var v={}, val=function(id){ var e=$(id); return e?e.value:undefined; };
  if($('tFrom')){
    var rc=ROOT.querySelector('#rdx-rangeChips [aria-pressed="true"]');
    v.range=rc?rc.getAttribute('data-range'):null; v.from=val('tFrom'); v.to=val('tTo');
    v.chartView=val('chartView'); v.chartView2=val('chartView2'); v.disp={};
    ['hideOutliers','smooth','points'].forEach(function(id){ var e=$(id); if(e) v.disp[id]=e.classList.contains('on'); });
  }
  if($('anchor')){
    v.anchor=val('anchor'); v.rangesEdited=RANGES_EDITED; v.compare=$('formCompare').classList.contains('on');
    ['faFrom','faTo','fbFrom','fbTo'].forEach(function(id){ v[id]=val(id); });
  }
  if($('hero')){ v.heroHelp=HERO_HELP; v.heroMore=HERO_MORE; }
  if(inView('patterns')){ v.patStats=PAT_STATS; v.gapsOpen=GAPS_OPEN; }
  var sp=$('settingsPanel'); if(sp) v.panelOpen=!sp.hidden;
  return v;
}
// Put a captureView() snapshot back after renderLoaded(), then re-render once. Range presets re-anchor
// on today; a metric no longer offered falls back to what renderLoaded picked.
function restoreView(v){
  if(!v || !ROOT || !RAW.length) return;
  if(v.heroHelp!=null) HERO_HELP=v.heroHelp;
  if(v.heroMore!=null) HERO_MORE=v.heroMore;
  if(v.patStats!=null) PAT_STATS=v.patStats;
  if(v.gapsOpen!=null) GAPS_OPEN=v.gapsOpen;
  if(v.panelOpen) setPanel(true);
  if(v.from!=null && $('tFrom')){
    if(v.range && v.range!=='custom') setRange(v.range);
    else if(v.from && v.to){ $('tFrom').value=v.from; $('tTo').value=v.to; setRangeChip('custom'); }
    var has=function(sel,x){ return Array.prototype.some.call(sel.options,function(o){ return o.value===x && !o.disabled; }); };
    if(has($('chartView'),v.chartView)) $('chartView').value=v.chartView;
    syncOverlaySelect(); if(has($('chartView2'),v.chartView2) && v.chartView2!==$('chartView').value) $('chartView2').value=v.chartView2;
    Object.keys(v.disp||{}).forEach(function(id){ var e=$(id); if(e){ e.classList.toggle('on',!!v.disp[id]); e.setAttribute('aria-pressed',String(!!v.disp[id])); } });
  }
  if(v.anchor!=null && $('anchor')){
    var d=parseDate(v.anchor); if(d && d.getTime()<=dayEnd(new Date()).getTime()){ $('anchor').value=v.anchor; ANCHOR=dayEnd(d); }
    RANGES_EDITED=!!v.rangesEdited;
    if(RANGES_EDITED) ['faFrom','faTo','fbFrom','fbTo'].forEach(function(id){ if(v[id]!=null) $(id).value=v[id]; }); else seedRanges();
    setCompare(!!v.compare); renderFormSub();
  }
  refresh();
}
// Remember the loaded data for an instant re-render on the next mount of this athlete (skipped
// while the profile failed to load: a cached default profile would hide the error next time).
function cacheData(){
  if(!UID) return;
  if(PROFILE_ERR){ delete DATA_CACHE[UID]; return; }
  DATA_CACHE[UID]={ raw:RAW, profile:STD_PROFILE, lever:STRAVA_LEVER, sync:STRAVA_SYNC };
}
/* Re-read the stored runs + profile of the mounted athlete and re-render in place (no remount), e.g. after
   the coaching page's own Strava sync added runs. No-op unless uid is the athlete on screen; a remount or
   athlete switch in the meantime wins. The chart's range and metric are kept. */
function reload(uid){
  if(!ROOT || !uid || uid!==UID) return Promise.resolve(false);
  var my=MOUNT, container=ROOT;
  return Promise.all([loadProfile(), loadFromFirestore()]).then(function(){
    if(ROOT!==container || my!==MOUNT) return false;
    var keep=captureView();   // taken now, so changes made while the read was in flight are kept
    renderLoaded();
    restoreView(keep);
    return true;
  }).catch(function(e){ console.warn('RunDynamics: reload failed', e); return false; });
}
/* Drop the data remembered for uid's instant re-render (e.g. runs of theirs were deleted elsewhere), so
   their next mount shows only what is stored. */
function forget(uid){ if(uid) delete DATA_CACHE[uid]; }
window.RunDynamics = { mount: mount, reload: reload, forget: forget };
})();
