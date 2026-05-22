// ════════════════════════════════════════════════════════════════
// Gait data + ranges + sex-card helpers for esFormLab.
//
// Extracted from the main esformlab/index.html inline <script>.
// Owns the static data tables (DEFAULTS, METRIC_BIO, PHASE_DEFS,
// PHASE_GROUPS, SUMMARY_COL_ORDER, GROUP_STARTS, METRIC_ROWS,
// PHASE_METRICS) plus the range/stats lookup helpers (getRange,
// positionLabel, positionSymbol, getRangeStats, getCombinedStats,
// getPooledStats, isRelevant), pose-detection constants (LEFT_KPS,
// RIGHT_KPS, MIN_CONF, SKELETON, MIN_N), and the sex-card UI
// helpers (setSex, updateRangesStatus). State (liveRanges,
// selectedSex) becomes window-global so the rest of the inline
// script can still read it.
//
// Referenced globals that stay in the main inline script:
// updateSummaryCol (in report-render.js), phases, the DOM.
// ════════════════════════════════════════════════════════════════

const MIN_N = 5;

// -- Ranges state --
const liveRanges = { male: null, female: null, combined: null };
let selectedSex  = null; // 'male' | 'female' | null

// Hardcoded defaults
const DEFAULTS = {
  trunk: {green:[5,20],   warn:[-10,30]},
  lKnee: {green:[120,175],warn:[90,185]},
  rKnee: {green:[120,175],warn:[90,185]},
  lHip:  {green:[140,185],warn:[110,200]},
  rHip:  {green:[140,185],warn:[110,200]},
  lElbow:{green:[50,110], warn:[20,130]},
  rElbow:{green:[50,110], warn:[20,130]},
  lFoot: {green:[-0.15,0.15],warn:[-0.3,0.3]},
  rFoot: {green:[-0.15,0.15],warn:[-0.3,0.3]},
  plantKnee: {green:[120,175], warn:[90,185]},
  plantHip: {green:[140,185], warn:[110,200]},
  leadKnee: {green:[120,175], warn:[90,185]},
  leadHip: {green:[140,185], warn:[110,200]},
  leadFoot: {green:[-0.15,0.15], warn:[-0.3,0.3]},
  trailHip: {green:[140,185], warn:[110,200]},
  nearElbow: {green:[50,110], warn:[20,130]},
};

function getRange(phaseKey, metricKey) {
  var sexRanges = selectedSex ? liveRanges[selectedSex] : null;
  if (sexRanges) {
    var r = sexRanges[phaseKey] ? sexRanges[phaseKey][metricKey] : null;
    if (r && r.reliable && r.n >= MIN_N && r.green && r.warn) {
      return {green:r.green, warn:r.warn, source:'live', n:r.n};
    }
  }
  var d = DEFAULTS[metricKey] || {green:[0,0],warn:[0,0]};
  return {green:d.green, warn:d.warn, source:'default', n:0};
}

function positionLabel(val, metricKey, phaseKey) {
  if (val===undefined||val===null||!isFinite(val)) return '';
  var rng = getRange(phaseKey||'mid', metricKey||'trunk');
  var green = rng.green;
  if (val>=green[0]&&val<=green[1]) return 'Within range';
  if (val<green[0]) return 'Below range';
  return 'Above range';
}
function positionSymbol(val, metricKey, phaseKey) {
  var p = positionLabel(val, metricKey, phaseKey);
  if (p==='Within range') return '\u25b8';
  if (p==='Below range')  return '\u25be';
  if (p==='Above range')  return '\u25b4';
  return '';
}

// -- Biomechanical descriptions per metric --
const METRIC_BIO = {
  trunk:  'Trunk lean affects load transfer to the glutes and braking force at foot strike. A moderate forward lean is typical of efficient running.',
  lKnee:  'Left knee angle reflects shock absorption at contact and drive during push-off. It varies significantly by gait phase.',
  rKnee:  'Right knee angle reflects shock absorption at contact and drive during push-off. It varies significantly by gait phase.',
  lHip:   'Left hip angle indicates stride length and the extent of hip extension during propulsion. Full extension contributes to forward drive.',
  rHip:   'Right hip angle indicates stride length and the extent of hip extension during propulsion. Full extension contributes to forward drive.',
  lElbow: 'Left elbow angle reflects arm carriage. A compact arm swing reduces rotational energy cost and helps maintain cadence.',
  rElbow: 'Right elbow angle reflects arm carriage. A compact arm swing reduces rotational energy cost and helps maintain cadence.',
  lFoot:  'Left foot offset describes where the foot lands relative to the hip. Landing closer to under the hip reduces braking forces.',
  rFoot:  'Right foot offset describes where the foot lands relative to the hip. Landing closer to under the hip reduces braking forces.',
  plantKnee: 'Stance knee angle at this phase. Reflects shock absorption and support during single-leg stance.',
  plantHip: 'Stance hip angle. Indicates pelvic position and hip extension during the support phase.',
  leadKnee: 'Lead leg knee angle. Reflects how extended or flexed the forward leg is at this moment.',
  leadHip: 'Lead leg hip angle. Shows hip flexion of the forward-reaching leg.',
  leadFoot: 'Lead leg foot offset relative to the hip. A larger positive value means the foot is landing further ahead.',
  trailHip: 'Trailing leg hip angle. Shows how much hip extension the push-off leg has achieved.',
  nearElbow: 'Elbow angle of the camera-side arm. Reflects arm carriage compactness.',
};

// -- Bell curve SVG builder --
function getRangeStats(phaseKey, metricKey) {
  // Prefer robust stats (median + MAD-based SD) when the reference doc has them.
  // Falls back to classical mean + SD for older docs that pre-date the robust fields.
  var sexRanges = selectedSex ? liveRanges[selectedSex] : null;
  if (sexRanges) {
    var r = sexRanges[phaseKey] ? sexRanges[phaseKey][metricKey] : null;
    if (r && r.reliable && r.n >= MIN_N) {
      if (r.center != null && r.spread != null && r.spread > 0) {
        return {mean: r.center, sd: r.spread, source: 'live', n: r.n};
      }
      if (r.mean != null && r.sd != null && r.sd > 0) {
        return {mean: r.mean, sd: r.sd, source: 'live', n: r.n};
      }
    }
  }
  var d = DEFAULTS[metricKey] || {green:[0,0]};
  var mean = (d.green[0] + d.green[1]) / 2;
  var sd   = (d.green[1] - d.green[0]) / 3;
  return {mean: mean, sd: sd || 1, source: 'default', n: 0};
}

// Pooled stats combine L and R mirror-phase values into one baseline (for symmetric-gait
// anomalies like overstriding). Returns the same shape as getRangeStats; falls back to
// classical per-phase stats if pooled data isn't in the doc yet.
// Sex-combined stats (reads computed_ranges/combined). Used for metrics where there's
// no strong evidence of sex differences, so pooling gives a more stable baseline. Falls
// back to the currently selected sex's stats if the combined doc isn't present.
function getCombinedStats(phaseKey, metricKey) {
  var cRanges = liveRanges.combined;
  if (cRanges) {
    var r = cRanges[phaseKey] ? cRanges[phaseKey][metricKey] : null;
    if (r && r.reliable && r.n >= MIN_N) {
      if (r.center != null && r.spread != null && r.spread > 0) {
        return {mean: r.center, sd: r.spread, source: 'live', n: r.n};
      }
      if (r.mean != null && r.sd != null && r.sd > 0) {
        return {mean: r.mean, sd: r.sd, source: 'live', n: r.n};
      }
    }
  }
  return getRangeStats(phaseKey, metricKey);
}

function getPooledStats(metricKey) {
  var sexRanges = selectedSex ? liveRanges[selectedSex] : null;
  var p = sexRanges && sexRanges.pooled ? sexRanges.pooled[metricKey] : null;
  if (p && p.reliable && p.n >= MIN_N) {
    if (p.center != null && p.spread != null && p.spread > 0) {
      return {mean: p.center, sd: p.spread, source: 'live', n: p.n};
    }
    if (p.mean != null && p.sd != null && p.sd > 0) {
      return {mean: p.mean, sd: p.sd, source: 'live', n: p.n};
    }
  }
  // Fallback: average of per-phase stats when pooled section isn't present.
  if (metricKey === 'leadFoot') {
    var L = getRangeStats('l_foot', 'leadFoot');
    var R = getRangeStats('r_foot', 'leadFoot');
    return {mean: (L.mean + R.mean) / 2, sd: (L.sd + R.sd) / 2, source: L.source, n: L.n + R.n};
  }
  var d = DEFAULTS[metricKey] || {green:[0,0]};
  var mean = (d.green[0] + d.green[1]) / 2;
  var sd   = (d.green[1] - d.green[0]) / 3;
  return {mean: mean, sd: sd || 1, source: 'default', n: 0};
}



// -- Sex selection --
function setSex(sex) {
  selectedSex = sex;
  document.getElementById('sex-card-male').className   = 'sex-card' + (sex==='male'?   ' active-male':'');
  document.getElementById('sex-card-female').className = 'sex-card' + (sex==='female'? ' active-female':'');
  updateRangesStatus();
  PHASE_DEFS.forEach(function(def) { if (phases[def.key] && phases[def.key].metrics) { updateSummaryCol(def.key); } });
}

function updateRangesStatus() {
  var el = document.getElementById('ranges-status');
  if (!el) return;
  if (!selectedSex) { el.className='sex-range-note'; el.textContent='Selecting a gender loads the relevant reference dataset for angle grading.'; return; }
  var r = liveRanges[selectedSex];
  if (r) {
    el.className='sex-range-note';
    el.innerHTML = '<span style="color:var(--good)">&#10003;</span> Live ' + selectedSex + ' ranges loaded';
  } else {
    el.className='sex-range-note';
    el.textContent = selectedSex.charAt(0).toUpperCase()+selectedSex.slice(1) + ' ranges selected -- using defaults until reference data is collected.';
  }
  var srcLabel = document.getElementById('range-source-label');
  if (srcLabel && selectedSex) srcLabel.textContent = selectedSex + ' elite';
}

// ==============================================================
//  GAIT ENGINE
// ==============================================================
const LEFT_KPS  = new Set([1,3,5,7,9,11,13,15]);
const RIGHT_KPS = new Set([2,4,6,8,10,12,14,16]);
const MIN_CONF  = 0.25;
const SKELETON  = [[5,7],[7,9],[6,8],[8,10],[5,6],[11,12],[5,11],[6,12],[11,13],[13,15],[12,14],[14,16],[0,5],[0,6]];

const PHASE_DEFS = [
  {key:'l_foot',    label:'L foot strike',      desc:'Left initial contact with ground',         videoKey:'side',  side:'left',   detectsIssue:'Overstriding', guide:{title:'Left foot strike',  desc:'The instant the left foot first contacts the ground.',checks:['Left ankle at or near lowest point','Slight knee bend at contact','Foot lands close to under the hip','Trunk upright or slightly forward'],tip:'If the foot looks extended far in front, scrub slightly forward to the true contact moment.'}},
  {key:'r_foot',    label:'R foot strike',      desc:'Right initial contact with ground',        videoKey:'side',  side:'right',  detectsIssue:'Overstriding', guide:{title:'Right foot strike', desc:'The instant the right foot first contacts the ground.',checks:['Right ankle at or near lowest point','Slight knee bend at contact','Hips level -- watch for excessive drop','Foot lands roughly under the hip'],tip:'Compare with left foot strike for asymmetries.'}},
  {key:'l_toe',     label:'L toe-off',          desc:'Left foot leaving the ground',             videoKey:'side',  side:'left',   detectsIssue:'Hip extension', guide:{title:'Left toe-off',      desc:'The moment the left foot pushes off. Hip extension is at maximum.',checks:['Left leg extended behind the body','Ankle plantarflexed (pushing through toes)','Left heel visibly raised','Opposite leg in mid-swing'],tip:'Toe-off is where propulsive power is generated.'}},
  {key:'r_toe',     label:'R toe-off',          desc:'Right foot leaving the ground',            videoKey:'side',  side:'right',  detectsIssue:'Hip extension', guide:{title:'Right toe-off',     desc:'The moment the right foot pushes off.',checks:['Right leg extended behind the body','Right ankle plantarflexed','Right heel raised','Opposite leg in mid-swing'],tip:'Compare with left toe-off for asymmetries.'}},
  {key:'mid',       label:'Mid-stance',         desc:'Body directly over support foot',          videoKey:'side',  side:'center', detectsIssue:'Trunk position', guide:{title:'Mid-stance',        desc:'The body passes directly over the supporting foot.',checks:['Stance foot roughly under the hip','Swing leg in mid-flight','Trunk vertical or slightly forward','Arms in natural opposite-arm swing'],tip:'Key frame for trunk lean and hip drop.'}},
  {key:'mid_front_l', label:'L mid-stance (front)', desc:'Left foot planted under body, front view', videoKey:'front', side:'left',  detectsIssue:'L hip drop, arm crossing, L knee valgus', guide:{title:'Left foot mid-stance (front view)', desc:'A frontal view at the moment the left foot is planted directly underneath the body.',checks:['Left foot planted flat on the ground','Left foot directly underneath the body -- not ahead or behind','Right leg is in mid-swing','Hips clearly visible for drop measurement'],tip:"Look for the instant the runner's body passes directly over the left stance foot."}},
  {key:'mid_front_r', label:'R mid-stance (front)', desc:'Right foot planted under body, front view', videoKey:'front', side:'right', detectsIssue:'R hip drop, arm crossing, R knee valgus', guide:{title:'Right foot mid-stance (front view)', desc:'A frontal view at the moment the right foot is planted directly underneath the body.',checks:['Right foot planted flat on the ground','Right foot directly underneath the body -- not ahead or behind','Left leg is in mid-swing','Hips clearly visible for drop measurement'],tip:"Look for the instant the runner's body passes directly over the right stance foot."}},
  {key:'mid_back_l',  label:'L mid-stance (back)',  desc:'Left foot planted under body, rear view',  videoKey:'back',  side:'left',  detectsIssue:'L hip drop confirmation', guide:{title:'Left foot mid-stance (back view)', desc:'A rear view at the moment the left foot is planted directly underneath the body. Confirms left-stance hip drop from the front view.',checks:['Left foot planted flat on the ground','Left foot directly underneath the body','Right leg in mid-swing','PSIS / lower back clearly visible'],tip:"Pick the instant the body passes directly over the left stance foot, viewed from behind."}},
  {key:'mid_back_r',  label:'R mid-stance (back)',  desc:'Right foot planted under body, rear view', videoKey:'back',  side:'right', detectsIssue:'R hip drop confirmation', guide:{title:'Right foot mid-stance (back view)', desc:'A rear view at the moment the right foot is planted directly underneath the body. Confirms right-stance hip drop from the front view.',checks:['Right foot planted flat on the ground','Right foot directly underneath the body','Left leg in mid-swing','PSIS / lower back clearly visible'],tip:"Pick the instant the body passes directly over the right stance foot, viewed from behind."}},
];

const PHASE_GROUPS = [
  {label:'Stride & propulsion', keys:['l_foot','r_foot','l_toe','r_toe']},
  {label:'Posture & trunk', keys:['mid']},
  {label:'Hip & lateral mechanics', keys:['mid_front_l','mid_front_r','mid_back_l','mid_back_r']},
];

const SUMMARY_COL_ORDER = ['l_foot','r_foot','l_toe','r_toe','mid'];
const GROUP_STARTS       = new Set(['l_foot','l_toe','mid']);

const METRIC_ROWS = [
  {key:'trunk', label:'Trunk lean',  dot:'var(--gold)',  fmt:function(v){return (v>0?'+':'')+v.toFixed(1)+'\u00b0';}, hint:'Elite: 5-20 fwd'},
  {key:'lKnee', label:'L knee',     dot:'var(--left)',  fmt:function(v){return v.toFixed(0)+'\u00b0';},               hint:'Phase-dependent'},
  {key:'rKnee', label:'R knee',     dot:'var(--right)', fmt:function(v){return v.toFixed(0)+'\u00b0';},               hint:'Phase-dependent'},
  {key:'lHip',  label:'L hip',      dot:'var(--left)',  fmt:function(v){return v.toFixed(0)+'\u00b0';},               hint:'Stance: 160-180'},
  {key:'rHip',  label:'R hip',      dot:'var(--right)', fmt:function(v){return v.toFixed(0)+'\u00b0';},               hint:'Stance: 160-180'},
  {key:'lElbow',label:'L elbow',    dot:'var(--left)',  fmt:function(v){return v.toFixed(0)+'\u00b0';},               hint:'Elite: 80-110'},
  {key:'rElbow',label:'R elbow',    dot:'var(--right)', fmt:function(v){return v.toFixed(0)+'\u00b0';},               hint:'Elite: 80-110'},
  {key:'lFoot', label:'L foot off.',dot:'var(--left)',  fmt:function(v){return (v>0?'+':'')+v.toFixed(2);},           hint:'+ = under body'},
  {key:'rFoot', label:'R foot off.',dot:'var(--right)', fmt:function(v){return (v>0?'+':'')+v.toFixed(2);},           hint:'+ = under body'},
  {key:'plantKnee', label:'Stance knee', dot:'var(--cyan)', fmt:function(v){return v.toFixed(0)+'\u00b0';}, hint:'Stance phase'},
  {key:'plantHip', label:'Stance hip', dot:'var(--cyan)', fmt:function(v){return v.toFixed(0)+'\u00b0';}, hint:'Stance phase'},
  {key:'leadKnee', label:'Lead knee', dot:'var(--cyan)', fmt:function(v){return v.toFixed(0)+'\u00b0';}, hint:'Lead leg'},
  {key:'leadHip', label:'Lead hip', dot:'var(--cyan)', fmt:function(v){return v.toFixed(0)+'\u00b0';}, hint:'Lead leg'},
  {key:'leadFoot', label:'Lead foot off.', dot:'var(--cyan)', fmt:function(v){return (v>0?'+':'')+v.toFixed(2);}, hint:'Lead leg'},
  {key:'trailHip', label:'Trail hip', dot:'var(--cyan)', fmt:function(v){return v.toFixed(0)+'\u00b0';}, hint:'Trailing leg'},
  {key:'nearElbow', label:'Elbow', dot:'var(--cyan)', fmt:function(v){return v.toFixed(0)+'\u00b0';}, hint:'Camera-side arm'},
];

const PHASE_METRICS = {
  l_foot:    ['trunk','leadKnee','leadHip','leadFoot','nearElbow'],
  r_foot:    ['trunk','leadKnee','leadHip','leadFoot','nearElbow'],
  l_toe:     ['trunk','leadHip','trailHip','nearElbow'],
  r_toe:     ['trunk','leadHip','trailHip','nearElbow'],
  mid:         ['trunk','plantKnee','plantHip','nearElbow'],
  mid_front_l: [],
  mid_front_r: [],
  mid_back_l:  [],
  mid_back_r:  [],
};
function isRelevant(phaseKey, metricKey){ var pm=PHASE_METRICS[phaseKey]; return !pm || pm.length===0 || pm.includes(metricKey); }
