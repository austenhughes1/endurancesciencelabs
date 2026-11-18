// ════════════════════════════════════════════════════════════════
// esformlab/detect-issues.test.js
//
// Checks of the optional front clip: the phase helpers in gait-data.js,
// detectIssues() in gait-engine.js, and the on-screen report in
// report-render.js, with and without a front clip. Run with plain node:
//
//   node esformlab/detect-issues.test.js
//
// The three files are classic browser scripts sharing globals, so they run
// in one node vm with a fake document. Every measurement here is made up.
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var failures = 0, checks = 0;
function ok(label, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL ' + label + (extra !== undefined ? ': ' + JSON.stringify(extra) : '')); }
}
function eq(label, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { failures++; console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function has(label, text, part) { ok(label, String(text).indexOf(part) >= 0, { missing: part, in: String(text).slice(0, 300) }); }
function lacks(label, text, part) {
  var hit = part instanceof RegExp ? part.test(text) : String(text).indexOf(part) >= 0;
  ok(label, !hit, { found: String(part) });
}

// ── the page: a fake document and the globals the scripts read at call time ──
var els = {};
function fakeEl(id) {
  return {
    id: id, innerHTML: '', textContent: '', hidden: false, className: '', attrs: {},
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    querySelector: function () { return fakeEl(id + '-child'); }
  };
}
var document = {
  getElementById: function (id) { return els[id] || (els[id] = fakeEl(id)); },
  createElement: function (tag) { return fakeEl(tag); }
};
var ctx = { console: console, document: document, phases: {}, isViewingSaved: false, lastIssues: null };
vm.createContext(ctx);
['gait-data.js', 'gait-engine.js', 'report-render.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
});
function run(code) { return vm.runInContext(code, ctx); }
function noFront(v) { run('eflNoFront = ' + (v ? 'true' : 'false') + ';'); }
function sex(s) { run('selectedSex = ' + JSON.stringify(s) + ';'); }
function html(id) { return els[id] ? els[id].innerHTML : ''; }
function fresh() { els = {}; }

var DEFS_BEFORE = JSON.stringify(run('PHASE_DEFS'));
var GROUPS_BEFORE = JSON.stringify(run('PHASE_GROUPS'));
var ALL_KEYS = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid', 'mid_front_l', 'mid_front_r', 'mid_back_l', 'mid_back_r'];
var NO_FRONT_KEYS = ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid', 'mid_back_l', 'mid_back_r'];

// ── made-up phases ──
function fb(o) {
  return Object.assign({ hipDropDeg: null, lKneeValgusDeg: null, rKneeValgusDeg: null, lWristCross: null, rWristCross: null,
    stanceSide: null, avgConfidence: 0.8 }, o);
}
function sidePhase(m) { return { metrics: Object.assign({ trunk: 12.5 }, m), sideView: true }; }
// Side phases that grade clear against the default ranges (z = 0 everywhere).
function cleanSide() {
  return { l_foot: sidePhase({ leadFoot: 0 }), r_foot: sidePhase({ leadFoot: 0 }),
    l_toe: sidePhase({ nearElbow: 80 }), r_toe: sidePhase({ nearElbow: 80 }), mid: sidePhase({}) };
}
function back(l, r) {
  var p = {};
  if (l) p.mid_back_l = { frontBackMetrics: fb(Object.assign({ stanceSide: 'left' }, l)) };
  if (r) p.mid_back_r = { frontBackMetrics: fb(Object.assign({ stanceSide: 'right' }, r)) };
  return p;
}
function front(l, r) {
  var p = {};
  if (l) p.mid_front_l = { frontBackMetrics: fb(Object.assign({ stanceSide: 'left' }, l)) };
  if (r) p.mid_front_r = { frontBackMetrics: fb(Object.assign({ stanceSide: 'right' }, r)) };
  return p;
}
function setPhases() { ctx.phases = Object.assign.apply(null, [{}].concat([].slice.call(arguments))); }
function issues() { return ctx.detectIssues(); }

// ── 1. phase helpers ──
function helperChecks() {
  noFront(false);
  eq('helpers, front clip: all 9 phases', run('eflActivePhaseDefs().map(function(d){return d.key;})'), ALL_KEYS);
  ok('helpers, front clip: the phase list is PHASE_DEFS itself', run('eflActivePhaseDefs() === PHASE_DEFS'));
  eq('helpers, front clip: numbers', ALL_KEYS.map(ctx.eflPhaseNum), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  eq('helpers, front clip: L back is 8', ctx.eflPhaseNum('mid_back_l'), 8);
  ok('helpers, front clip: the groups are PHASE_GROUPS itself', run('eflActivePhaseGroups() === PHASE_GROUPS'));
  var backL = run('PHASE_DEFS.find(function(d){return d.key==="mid_back_l";})');
  var c = ctx.eflPhaseCopy(backL);
  eq('helpers, front clip: L back card copy unchanged', c.detectsIssue, 'Hip drop (L), confirms the front view');
  ok('helpers, front clip: L back guide unchanged', c.guide === backL.guide);

  noFront(true);
  eq('helpers, no front clip: 7 phases', run('eflActivePhaseDefs().map(function(d){return d.key;})'), NO_FRONT_KEYS);
  ok('helpers, no front clip: no front-view phase', run('eflActivePhaseDefs().every(function(d){return d.videoKey !== "front";})'));
  eq('helpers, no front clip: side phases keep 1-5', ['l_foot', 'r_foot', 'l_toe', 'r_toe', 'mid'].map(ctx.eflPhaseNum), [1, 2, 3, 4, 5]);
  eq('helpers, no front clip: L back is 6', ctx.eflPhaseNum('mid_back_l'), 6);
  eq('helpers, no front clip: R back is 7', ctx.eflPhaseNum('mid_back_r'), 7);
  eq('helpers, no front clip: L front has no number', ctx.eflPhaseNum('mid_front_l'), 0);
  eq('helpers, no front clip: R front has no number', ctx.eflPhaseNum('mid_front_r'), 0);
  var groups = run('eflActivePhaseGroups()');
  eq('helpers, no front clip: group labels', groups.map(function (g) { return g.label; }), ['Stride & propulsion', 'Posture & trunk', 'Hip & lateral mechanics']);
  eq('helpers, no front clip: hip group is the back phases', groups[2].keys, ['mid_back_l', 'mid_back_r']);
  ok('helpers, no front clip: no front key in any group', groups.every(function (g) { return g.keys.every(function (k) { return !/^mid_front_/.test(k); }); }));
  ok('helpers, no front clip: no empty group', groups.every(function (g) { return g.keys.length > 0; }));
  run('PHASE_GROUPS.push({label: "Front only", keys: ["mid_front_l", "mid_front_r"]});');
  eq('helpers, no front clip: a group of only front phases is dropped', run('eflActivePhaseGroups().length'), 3);
  run('PHASE_GROUPS.pop();');
  c = ctx.eflPhaseCopy(backL);
  eq('helpers, no front clip: L back card names what it measures', c.detectsIssue, 'Hip drop (L), knee valgus (L)');
  has('helpers, no front clip: L back guide says it measures knee valgus', c.guide.desc, 'Measures left-stance hip drop and knee valgus');
  lacks('helpers, no front clip: L back guide does not mention the front view', c.guide.desc, 'front view');
  eq('helpers, no front clip: L back guide title and checks kept', [c.guide.title, c.guide.checks], [backL.guide.title, backL.guide.checks]);
  var backR = run('PHASE_DEFS.find(function(d){return d.key==="mid_back_r";})');
  eq('helpers, no front clip: R back card names what it measures', ctx.eflPhaseCopy(backR).detectsIssue, 'Hip drop (R), knee valgus (R)');
  var lFoot = run('PHASE_DEFS[0]');
  c = ctx.eflPhaseCopy(lFoot);
  ok('helpers, no front clip: a side phase keeps its copy', c.detectsIssue === lFoot.detectsIssue && c.guide === lFoot.guide);

  eq('helpers: PHASE_DEFS unchanged', JSON.stringify(run('PHASE_DEFS')), DEFS_BEFORE);
  eq('helpers: PHASE_GROUPS unchanged', JSON.stringify(run('PHASE_GROUPS')), GROUPS_BEFORE);
  noFront(false);
}

// ── 2. knee valgus: per leg, front reading when it exists, else back ──
function kneeValgusChecks() {
  sex('male');
  noFront(false);
  setPhases(front({ lKneeValgusDeg: 12 }), back({ lKneeValgusDeg: 2 }, null));
  var kv = issues().kneeValgus;
  eq('valgus, front 12 + back 2: graded from the front', [kv.detected, kv.severity, kv.sideSev], [true, 'notable', { L: 'notable', R: null }]);
  eq('valgus, front 12 + back 2: details name the front view', kv.details, 'L-stance: 12.0° notable (front view) · R-stance: no data');

  setPhases(front({ lKneeValgusDeg: null, hipDropDeg: 3 }), back({ lKneeValgusDeg: 12 }, null));
  kv = issues().kneeValgus;
  eq('valgus, front none + back 12: graded from the back', [kv.detected, kv.severity, kv.sideSev], [true, 'notable', { L: 'notable', R: null }]);
  eq('valgus, front none + back 12: details name the back view', kv.details, 'L-stance: 12.0° notable (back view) · R-stance: no data');

  setPhases(front({ lKneeValgusDeg: NaN }), back({ lKneeValgusDeg: 8 }, null));
  kv = issues().kneeValgus;
  eq('valgus, front NaN + back 8: graded from the back', [kv.severity, kv.sideSev], ['mild', { L: 'mild', R: null }]);
  has('valgus, front NaN + back 8: back view', kv.details, '8.0° mild (back view)');

  setPhases(front({ lKneeValgusDeg: 0 }), back({ lKneeValgusDeg: 12 }, null));
  eq('valgus, front 0 + back 12: a front 0 is a reading, so clear', issues().kneeValgus.detected, false);

  setPhases(front({ lKneeValgusDeg: 12 }, { rKneeValgusDeg: null }), back(null, { rKneeValgusDeg: 8 }));
  kv = issues().kneeValgus;
  eq('valgus, L front + R back: each leg its own view', kv.sideSev, { L: 'notable', R: 'mild' });
  eq('valgus, L front + R back: details', kv.details,
    'L-stance: 12.0° notable (front view) · R-stance: 8.0° mild (back view) · asymmetry 4.0°');

  setPhases(front({ lKneeValgusDeg: 3 }, { rKneeValgusDeg: 2 }), back({ lKneeValgusDeg: 12 }, { rKneeValgusDeg: 12 }));
  eq('valgus, both fronts clear: back readings ignored', issues().kneeValgus.detected, false);

  noFront(true);
  setPhases(cleanSide(), back({ lKneeValgusDeg: 8 }, { rKneeValgusDeg: 7 }));
  kv = issues().kneeValgus;
  eq('valgus, no front clip: graded from the back', [kv.detected, kv.severity, kv.sideSev], [true, 'mild', { L: 'mild', R: 'mild' }]);
  eq('valgus, no front clip: details', kv.details, 'L-stance: 8.0° mild (back view) · R-stance: 7.0° mild (back view)');
  lacks('valgus, no front clip: never says front view', kv.details, 'front view');

  setPhases(cleanSide(), back({ lKneeValgusDeg: 10.5 }, null));
  eq('valgus, no front clip, male 10.5: notable', issues().kneeValgus.severity, 'notable');
  sex('female');
  eq('valgus, no front clip, female 10.5: mild', issues().kneeValgus.severity, 'mild');
  sex('male');

  setPhases(cleanSide(), back({ lKneeValgusDeg: 3 }, { rKneeValgusDeg: 2 }));
  kv = issues().kneeValgus;
  eq('valgus, no front clip, low back readings: clear', [kv.detected, kv.details], [false, 'No significant knee valgus detected']);

  setPhases(cleanSide(), back({ lKneeValgusDeg: 4 }, { rKneeValgusDeg: 8 }));
  eq('valgus, no front clip: asymmetry upgrades the higher leg', issues().kneeValgus.sideSev, { L: null, R: 'notable' });
  noFront(false);
}

// ── 3. arms crossing: gone with no front clip, "not measured" when the front failed ──
function armsCrossingChecks() {
  sex('male');
  noFront(true);
  setPhases(cleanSide(), back({ hipDropDeg: 4, lKneeValgusDeg: 3 }, { hipDropDeg: 5, rKneeValgusDeg: 2 }));
  var iss = issues();
  eq('arms, no front clip: no armsCrossing key', 'armsCrossing' in iss, false);
  eq('arms, no front clip: the five other checks', Object.keys(iss).sort(), ['armAngle', 'hipDrop', 'kneeValgus', 'overstriding', 'torsoPosition']);
  setPhases(cleanSide(), front({ rWristCross: 0.2 }), back({ hipDropDeg: 4 }, null));
  eq('arms, no front clip: left out even if front frames were set', 'armsCrossing' in issues(), false);

  noFront(false);
  setPhases(cleanSide(), back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  iss = issues();
  ok('arms, front clip not decoded: armsCrossing present', 'armsCrossing' in iss);
  eq('arms, front clip not decoded: not detected', [iss.armsCrossing.detected, iss.armsCrossing.severity], [false, null]);

  setPhases(cleanSide(), front({ lWristCross: 0, rWristCross: 0.2 }, { lWristCross: 0.1, rWristCross: 0.05 }), back({}, {}));
  var ac = issues().armsCrossing;
  eq('arms, three clips, crossing 0.2: notable', [ac.detected, ac.severity, ac.sideSev, ac.sideTagLabel], [true, 'notable', { L: 'mild', R: 'notable' }, 'arm']);
  eq('arms, three clips: details', ac.details, 'L arm: 10.0% mild · R arm: 20.0% notable');

  setPhases(cleanSide(), front({ lWristCross: 0.02 }, { rWristCross: 0.01 }));
  eq('arms, three clips, small crossing: clear', issues().armsCrossing.detected, false);
}

// ── 4. hip drop from the back view alone ──
function hipDropChecks() {
  sex('male');
  noFront(true);
  setPhases(cleanSide(), back({ hipDropDeg: 13 }, { hipDropDeg: 5 }));
  var hd = issues().hipDrop;
  eq('hip drop, no front clip: graded from the back', [hd.detected, hd.severity, hd.sideSev], [true, 'notable', { L: 'notable', R: null }]);
  eq('hip drop, no front clip: details', hd.details, 'L-stance: 13.0° notable · R-stance: 5.0° clear · asymmetry 8.0°');

  setPhases(cleanSide(), back({ hipDropDeg: 10, avgConfidence: 0.1 }, { hipDropDeg: 9.5, avgConfidence: 0.1 }));
  eq('hip drop, no front clip, low back confidence: still the back value', issues().hipDrop.sideSev, { L: 'mild', R: 'mild' });

  setPhases(cleanSide(), back({ hipDropDeg: 12.5 }, null));
  eq('hip drop, no front clip, male 12.5: notable', issues().hipDrop.severity, 'notable');
  sex('female');
  eq('hip drop, no front clip, female 12.5: mild', issues().hipDrop.severity, 'mild');
  sex('male');

  setPhases(cleanSide(), back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  eq('hip drop, no front clip, low values: clear', issues().hipDrop.detected, false);

  noFront(false);
  setPhases(front({ hipDropDeg: 7 }), back({ hipDropDeg: 13 }, null));
  hd = issues().hipDrop;
  eq('hip drop, three clips: front and back blended 2:1', [hd.severity, hd.details], ['mild', 'L-stance: 9.0° mild · R-stance: no data']);
  setPhases(front({ hipDropDeg: 7 }), back({ hipDropDeg: 13, avgConfidence: 0.3 }, null));
  eq('hip drop, three clips, low back confidence: front alone', issues().hipDrop.detected, false);
}

// ── 5. the on-screen report ──
function headers(h) {
  var out = [], re = /<th(?: [^>]*)?>([^<]*)<\/th>/g, m;
  while ((m = re.exec(h))) out.push(m[1]);
  return out;
}
function cardTitles(h) {
  var out = [], re = /<h3 class="issue-card-title">([^<]*)<\/h3>/g, m;
  while ((m = re.exec(h))) out.push(m[1]);
  return out;
}
function rowCount(h) { return (h.split('<tbody>')[1] || '').split('<tr>').length - 1; }
function tdCounts(h) {
  return (h.split('<tbody>')[1] || '').split('<tr>').slice(1).map(function (r) { return r.split('<td').length - 1; });
}
var FIVE_TITLES = ['Overstriding', 'Hip drop', 'Torso position (too upright)', 'Arm angle too open', 'Knee valgus'];
var SIX_TITLES = ['Overstriding', 'Hip drop', 'Arms crossing midline', 'Torso position (too upright)', 'Arm angle too open', 'Knee valgus'];
var CROSS_WORDS = /arms? cross|crossover|wrist cross/i;

function reportChecks() {
  sex('male');

  // coverage helpers
  noFront(true);
  setPhases(cleanSide(), back({ lKneeValgusDeg: 3 }, { rKneeValgusDeg: null }));
  var kvBack = issues().kneeValgus;
  eq('report: the result names the view that graded each leg', kvBack.views, { L: 'back', R: null });
  ok('report: knee valgus measured from back readings alone', ctx.eflCheckMeasured('kneeValgus', kvBack));
  setPhases(cleanSide(), back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  var kvNone = issues().kneeValgus;
  eq('report: no reading on either leg names no view', kvNone.views, { L: null, R: null });
  ok('report: knee valgus not measured when the back has no reading', !ctx.eflCheckMeasured('kneeValgus', kvNone));
  ok('report: hip drop measured from the back alone', ctx.eflCheckMeasured('hipDrop'));

  // an older saved result (no views): graded from the front frames only, so back readings don't count
  noFront(false);
  var legacyKv = { detected: false, severity: null, details: 'No significant knee valgus detected' };
  setPhases(cleanSide(), { mid_front_l: {}, mid_front_r: {} }, back({ lKneeValgusDeg: 14 }, { rKneeValgusDeg: 13 }));
  ok('report, older saved result: back readings alone are not measured', !ctx.eflCheckMeasured('kneeValgus', legacyKv));
  setPhases(cleanSide(), front({ lKneeValgusDeg: 3 }, { rKneeValgusDeg: 2 }), back({ lKneeValgusDeg: 14 }, { rKneeValgusDeg: 13 }));
  ok('report, older saved result: front readings are measured', ctx.eflCheckMeasured('kneeValgus', legacyKv));
  fresh();
  setPhases(cleanSide(), front({ lKneeValgusDeg: 3 }, { rKneeValgusDeg: 2 }), back({ lKneeValgusDeg: 14 }, { rKneeValgusDeg: 13 }));
  ctx.renderFrontBackTable({ kneeValgus: legacyKv });
  lacks('fb table, older saved result: no back-fallback clause', html('fb-summary'), 'or the back view for a leg');
  fresh();
  ctx.renderFrontBackTable({ kneeValgus: issues().kneeValgus });
  has('fb table, new result: back-fallback clause', html('fb-summary'), 'or the back view for a leg');
  noFront(true);
  eq('report, no front clip: knee valgus reads the back frames', ctx.eflCheckInputs('kneeValgus'), 'the back mid-stance frames');
  eq('report, no front clip: hip drop reads the back frames', ctx.eflCheckInputs('hipDrop'), 'the back mid-stance frames');
  eq('report, no front clip: overstriding copy unchanged', ctx.eflCheckInputs('overstriding'), 'the L and R foot-strike frames');
  noFront(false);
  eq('report, three clips: knee valgus reads front and back', ctx.eflCheckInputs('kneeValgus'), 'the front and back mid-stance frames');
  eq('report, three clips: arms crossing reads the front', ctx.eflCheckInputs('armsCrossing'), 'the front mid-stance frames');

  // front/back table, no front clip
  fresh();
  noFront(true);
  setPhases(cleanSide(), back({ hipDropDeg: 4.2, lKneeValgusDeg: 8 }, { hipDropDeg: 5, rKneeValgusDeg: 2.5 }));
  ctx.renderFrontBackTable();
  var t = html('fb-summary');
  eq('fb table, no front clip: two back columns', headers(t), ['Metric', '6. L mid-stance (back)', '7. R mid-stance (back)']);
  has('fb table, no front clip: back view title', t, '<h3 class="report-subhead fb-title">Back view measurements</h3>');
  lacks('fb table, no front clip: no wrist crossing rows', t, /wrist crossing/i);
  eq('fb table, no front clip: three rows of three cells', tdCounts(t), [3, 3, 3]);
  has('fb table, no front clip: the L back FPPA shown', t, '8.0&deg;');
  eq('fb table, no front clip: shown', els['fb-summary'].hidden, false);

  // front/back table, three clips
  fresh();
  noFront(false);
  setPhases(cleanSide(), front({ hipDropDeg: 4, lKneeValgusDeg: 3, lWristCross: 0.2 }, { hipDropDeg: 5, rKneeValgusDeg: 2, rWristCross: 0 }),
    back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  ctx.renderFrontBackTable();
  t = html('fb-summary');
  eq('fb table, three clips: four columns', headers(t),
    ['Metric', '6. L mid-stance (front)', '7. R mid-stance (front)', '8. L mid-stance (back)', '9. R mid-stance (back)']);
  has('fb table, three clips: title', t, '<h3 class="report-subhead fb-title">Front/back view measurements</h3>');
  has('fb table, three clips: L wrist row', t, 'L wrist crossing (% of shoulder width)');
  has('fb table, three clips: R wrist row', t, 'R wrist crossing (% of shoulder width)');
  eq('fb table, three clips: five rows of five cells', tdCounts(t), [5, 5, 5, 5, 5]);
  has('fb table, three clips: front wrist value', t, '20.0%');
  has('fb table, three clips: back wrist cells say front view only', t, 'title="Front view only"');

  // front clip uploaded but not decoded: front phases exist with nothing measured
  fresh();
  setPhases(cleanSide(), { mid_front_l: {}, mid_front_r: {} }, back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  ctx.renderFrontBackTable();
  eq('fb table, front not decoded: still four columns', headers(html('fb-summary')).length, 5);

  fresh();
  setPhases(cleanSide());
  ctx.renderFrontBackTable();
  eq('fb table, no front/back readings: hidden', [html('fb-summary'), els['fb-summary'].hidden], ['', true]);

  // full report, no front clip, all clear
  fresh();
  noFront(true);
  setPhases(cleanSide(), back({ hipDropDeg: 4, lKneeValgusDeg: 3 }, { hipDropDeg: 5, rKneeValgusDeg: 2 }));
  var iss = issues();
  ok('report, no front clip: every check clear', Object.keys(iss).every(function (k) { return !iss[k].detected; }));
  ctx.renderReport(iss);
  var g = html('report-issues-grid');
  eq('report, no front clip: five cards', cardTitles(g), FIVE_TITLES);
  lacks('report, no front clip: no arms crossing card', g, 'Arms crossing');
  has('report, no front clip: all-clear copy', g, 'No major gait-pattern flags detected');
  has('report, no front clip: all-clear list without arm crossover', g,
    'signs of overstriding, hip drop, overly upright torso position, overly open arm angle, or knee valgus');
  lacks('report, no front clip: no crossing words anywhere',
    g + html('report-details') + html('fb-summary') + html('anomaly-banner'), CROSS_WORDS);
  lacks('report, no front clip: nothing "Not measured"', g, 'Not measured');
  eq('report, no front clip: back table drawn too', headers(html('fb-summary')).length, 3);

  // no front clip, knee valgus unmeasured
  fresh();
  setPhases(cleanSide(), back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  ctx.renderReport(issues());
  g = html('report-issues-grid');
  has('report, no front clip, one check unmeasured: of 5 checks', g, '1 of 5 checks couldn&rsquo;t be run');
  has('report, no front clip, one check unmeasured: back frames named', g,
    'This check couldn&rsquo;t run &mdash; the back mid-stance frames had no usable measurement.');
  eq('report, no front clip, one check unmeasured: one Not measured badge', g.split('>Not measured<').length - 1, 1);

  // no front clip, a detected issue
  fresh();
  setPhases(cleanSide(), back({ hipDropDeg: 4, lKneeValgusDeg: 12 }, { hipDropDeg: 5, rKneeValgusDeg: 3 }));
  ctx.renderReport(issues());
  g = html('report-issues-grid');
  eq('report, no front clip, valgus found: still five cards', cardTitles(g).length, 5);
  has('report, no front clip, valgus found: left side tag', g, 'Left side only');
  lacks('report, no front clip, valgus found: no crossing words', g + html('report-details'), CROSS_WORDS);

  // three clips, all clear: as before
  fresh();
  noFront(false);
  setPhases(cleanSide(), front({ hipDropDeg: 4, lKneeValgusDeg: 3, lWristCross: 0, rWristCross: 0.02 }, { hipDropDeg: 5, rKneeValgusDeg: 2, lWristCross: 0.01, rWristCross: 0 }),
    back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  ctx.renderReport(issues());
  g = html('report-issues-grid');
  eq('report, three clips: six cards', cardTitles(g), SIX_TITLES);
  has('report, three clips: all-clear copy mentions arm crossover', g,
    'signs of overstriding, hip drop, excessive arm crossover, overly upright torso position, overly open arm angle, or knee valgus');
  has('report, three clips: arms crossing clear', g, 'No significant arm crossing detected');

  // three clips, front not decoded: arms crossing "Not measured"
  fresh();
  setPhases(cleanSide(), { mid_front_l: {}, mid_front_r: {} }, back({ hipDropDeg: 4, lKneeValgusDeg: 3 }, { hipDropDeg: 5, rKneeValgusDeg: 2 }));
  ctx.renderReport(issues());
  g = html('report-issues-grid');
  eq('report, front not decoded: six cards', cardTitles(g), SIX_TITLES);
  has('report, front not decoded: of 6 checks', g, '1 of 6 checks couldn&rsquo;t be run');
  has('report, front not decoded: arms crossing not measured', g,
    'This check couldn&rsquo;t run &mdash; the front mid-stance frames had no usable measurement.');
  has('report, front not decoded: banner counts 9 phases', html('anomaly-banner'), '<em>2</em> of 9 phases have no usable frame');
}

// ── 6. the banner's phase count ──
function bannerChecks() {
  sex('male');
  noFront(true);
  fresh();
  setPhases(cleanSide(), back({ hipDropDeg: 4, lKneeValgusDeg: 3 }, { hipDropDeg: 5, rKneeValgusDeg: 2 }));
  eq('banner, no front clip, 7 usable: none unusable', ctx.eflUnusablePhaseCount(), 0);
  ctx.renderAnomalyBanner(issues());
  var b = html('anomaly-banner');
  lacks('banner, no front clip, 7 usable: not incomplete', b, 'incomplete');
  has('banner, no front clip, 7 usable: clean run', b, 'Clean run');
  eq('banner, no front clip, 7 usable: tone', els['anomaly-banner'].className, 'anomaly-banner clear');
  eq('banner: marked populated', els['anomaly-banner'].attrs['data-populated'], '1');

  fresh();
  var p = cleanSide();
  p.l_toe = { metrics: null, sideView: true };
  setPhases(p, back({ hipDropDeg: 4, lKneeValgusDeg: 3 }, null), { mid_back_r: { noPose: true } });
  eq('banner, no front clip, 2 unusable: count', ctx.eflUnusablePhaseCount(), 2);
  ctx.renderAnomalyBanner(issues());
  has('banner, no front clip, 2 unusable: of 7', html('anomaly-banner'), 'Your scan is incomplete &mdash; <em>2</em> of 7 phases have no usable frame');

  fresh();
  setPhases(cleanSide(), back({ hipDropDeg: 4, lKneeValgusDeg: 12 }, null), { mid_back_r: { noPose: true } });
  ctx.renderAnomalyBanner(issues());
  b = html('anomaly-banner');
  has('banner, no front clip, issue + 1 unusable: headline', b, '<em>1</em> issue detected in your form');
  has('banner, no front clip, issue + 1 unusable: note of 7', b, 'Note: 1 of 7 phases have no usable frame');

  noFront(false);
  fresh();
  setPhases(cleanSide(), front({ hipDropDeg: 4 }, { hipDropDeg: 5 }), back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  eq('banner, three clips, 9 usable: none unusable', ctx.eflUnusablePhaseCount(), 0);
  setPhases(cleanSide(), front({ hipDropDeg: 4 }, null), back({ hipDropDeg: 4 }, { hipDropDeg: 5 }));
  eq('banner, three clips, no R front: one unusable', ctx.eflUnusablePhaseCount(), 1);
  ctx.renderAnomalyBanner(issues());
  has('banner, three clips, 1 unusable: of 9', html('anomaly-banner'), '<em>1</em> of 9 phases have no usable frame');
}

try {
  helperChecks();
  kneeValgusChecks();
  armsCrossingChecks();
  hipDropChecks();
  reportChecks();
  bannerChecks();
  eq('end: PHASE_DEFS unchanged', JSON.stringify(run('PHASE_DEFS')), DEFS_BEFORE);
} catch (e) {
  console.log('  FAIL threw: ' + (e && e.stack || e));
  process.exit(1);
}
console.log('detect-issues: ' + (checks - failures) + ' of ' + checks + ' checks passed');
if (failures) process.exit(1);
