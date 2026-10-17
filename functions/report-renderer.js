// ════════════════════════════════════════════════════════════════
//  Server-side PDF renderer for the esFormLab gait-analysis report.
//
//  This is a Node port of the in-browser downloadReport() function
//  previously in esformlab/index.html. Moved server-side so that
//  the paywall can be enforced — the client no longer holds the
//  rendering code, so a non-paying user cannot bypass the gate by
//  calling downloadReport() from DevTools.
//
//  Anything coupled to the on-screen renderer (REPORT_DATA copy,
//  PHASE_DEFS, METRIC_ROWS, METRIC_BIO, DEFAULTS, PHASE_METRICS,
//  SUMMARY_COL_ORDER, MIN_N) is duplicated here intentionally — the
//  on-screen rendering still uses the originals. Keep the two in
//  sync when changing report copy or metric definitions.
// ════════════════════════════════════════════════════════════════

const { jsPDF } = require("jspdf");

const MIN_N = 5;

const DEFAULTS = {
  trunk: { green: [5, 20], warn: [-10, 30] },
  lKnee: { green: [120, 175], warn: [90, 185] },
  rKnee: { green: [120, 175], warn: [90, 185] },
  lHip: { green: [140, 185], warn: [110, 200] },
  rHip: { green: [140, 185], warn: [110, 200] },
  lElbow: { green: [50, 110], warn: [20, 130] },
  rElbow: { green: [50, 110], warn: [20, 130] },
  lFoot: { green: [-0.15, 0.15], warn: [-0.3, 0.3] },
  rFoot: { green: [-0.15, 0.15], warn: [-0.3, 0.3] },
  plantKnee: { green: [120, 175], warn: [90, 185] },
  plantHip: { green: [140, 185], warn: [110, 200] },
  leadKnee: { green: [120, 175], warn: [90, 185] },
  leadHip: { green: [140, 185], warn: [110, 200] },
  leadFoot: { green: [-0.15, 0.15], warn: [-0.3, 0.3] },
  trailHip: { green: [140, 185], warn: [110, 200] },
  nearElbow: { green: [50, 110], warn: [20, 130] },
};

const PHASE_DEFS = [
  { key: "l_foot", label: "L foot strike", desc: "Left initial contact with ground" },
  { key: "r_foot", label: "R foot strike", desc: "Right initial contact with ground" },
  { key: "l_toe", label: "L toe-off", desc: "Left foot leaving the ground" },
  { key: "r_toe", label: "R toe-off", desc: "Right foot leaving the ground" },
  { key: "mid", label: "Mid-stance", desc: "Body directly over support foot" },
  { key: "mid_front_l", label: "L mid-stance (front)", desc: "Left foot planted under body, front view" },
  { key: "mid_front_r", label: "R mid-stance (front)", desc: "Right foot planted under body, front view" },
  { key: "mid_back_l", label: "L mid-stance (back)", desc: "Left foot planted under body, rear view" },
  { key: "mid_back_r", label: "R mid-stance (back)", desc: "Right foot planted under body, rear view" },
];

const SUMMARY_COL_ORDER = ["l_foot", "r_foot", "l_toe", "r_toe", "mid"];

// Formatters return strings, matching the in-browser METRIC_ROWS.fmt closures.
const METRIC_ROWS = [
  { key: "trunk", label: "Trunk lean", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + "°" },
  { key: "lKnee", label: "L knee", fmt: (v) => v.toFixed(0) + "°" },
  { key: "rKnee", label: "R knee", fmt: (v) => v.toFixed(0) + "°" },
  { key: "lHip", label: "L hip", fmt: (v) => v.toFixed(0) + "°" },
  { key: "rHip", label: "R hip", fmt: (v) => v.toFixed(0) + "°" },
  { key: "lElbow", label: "L elbow", fmt: (v) => v.toFixed(0) + "°" },
  { key: "rElbow", label: "R elbow", fmt: (v) => v.toFixed(0) + "°" },
  { key: "lFoot", label: "L foot off.", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(2) },
  { key: "rFoot", label: "R foot off.", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(2) },
  { key: "plantKnee", label: "Stance knee", fmt: (v) => v.toFixed(0) + "°" },
  { key: "plantHip", label: "Stance hip", fmt: (v) => v.toFixed(0) + "°" },
  { key: "leadKnee", label: "Lead knee", fmt: (v) => v.toFixed(0) + "°" },
  { key: "leadHip", label: "Lead hip", fmt: (v) => v.toFixed(0) + "°" },
  { key: "leadFoot", label: "Lead foot off.", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(2) },
  { key: "trailHip", label: "Trail hip", fmt: (v) => v.toFixed(0) + "°" },
  { key: "nearElbow", label: "Elbow", fmt: (v) => v.toFixed(0) + "°" },
];

const PHASE_METRICS = {
  l_foot: ["trunk", "leadKnee", "leadHip", "leadFoot", "nearElbow"],
  r_foot: ["trunk", "leadKnee", "leadHip", "leadFoot", "nearElbow"],
  l_toe: ["trunk", "leadHip", "trailHip", "nearElbow"],
  r_toe: ["trunk", "leadHip", "trailHip", "nearElbow"],
  mid: ["trunk", "plantKnee", "plantHip", "nearElbow"],
  mid_front_l: [],
  mid_front_r: [],
  mid_back_l: [],
  mid_back_r: [],
};

function isRelevant(phaseKey, metricKey) {
  const pm = PHASE_METRICS[phaseKey];
  return !pm || pm.length === 0 || pm.includes(metricKey);
}

const METRIC_BIO = {
  trunk: "Trunk lean affects load transfer to the glutes and braking force at foot strike. A moderate forward lean is typical of efficient running.",
  lKnee: "Left knee angle reflects shock absorption at contact and drive during push-off. It varies significantly by gait phase.",
  rKnee: "Right knee angle reflects shock absorption at contact and drive during push-off. It varies significantly by gait phase.",
  lHip: "Left hip angle indicates stride length and the extent of hip extension during propulsion. Full extension contributes to forward drive.",
  rHip: "Right hip angle indicates stride length and the extent of hip extension during propulsion. Full extension contributes to forward drive.",
  lElbow: "Left elbow angle reflects arm carriage. A compact arm swing reduces rotational energy cost and helps maintain cadence.",
  rElbow: "Right elbow angle reflects arm carriage. A compact arm swing reduces rotational energy cost and helps maintain cadence.",
  lFoot: "Left foot offset describes where the foot lands relative to the hip. Landing closer to under the hip reduces braking forces.",
  rFoot: "Right foot offset describes where the foot lands relative to the hip. Landing closer to under the hip reduces braking forces.",
  plantKnee: "Stance knee angle at this phase. Reflects shock absorption and support during single-leg stance.",
  plantHip: "Stance hip angle. Indicates pelvic position and hip extension during the support phase.",
  leadKnee: "Lead leg knee angle. Reflects how extended or flexed the forward leg is at this moment.",
  leadHip: "Lead leg hip angle. Shows hip flexion of the forward-reaching leg.",
  leadFoot: "Lead leg foot offset relative to the hip. A larger positive value means the foot is landing further ahead.",
  trailHip: "Trailing leg hip angle. Shows how much hip extension the push-off leg has achieved.",
  nearElbow: "Elbow angle of the camera-side arm. Reflects arm carriage compactness.",
};

const REPORT_DATA = {
  overstriding: {
    title: "Overstriding",
    clear: "No significant overstriding detected",
    summary: {
      notable: "Your foot is landing well ahead of your hip at contact, which acts like a brake with every stride.",
      mild: "Your foot is landing slightly ahead of your hip at contact. This is common but can increase braking forces over time.",
    },
    whatThisMeans:
      "Your foot is landing too far in front of your body at initial contact, often with a reaching pattern and a less vertical shin upon landing. This can result in a strong heel-first contact farther in front of the body than is ideal.",
    whyItMatters:
      "Landing with the foot far ahead of the hip is linked to greater braking forces, higher knee demands, and a less energy-efficient stride. These higher loading patterns have been associated with several running injury profiles, though the relationship is not perfectly consistent across all studies.",
    whyItMattersRef: "https://pubmed.ncbi.nlm.nih.gov/26538175/",
    possibleReasons: [
      { text: "Low cadence relative to speed -- not enough flight time between steps, often because the trailing leg is not generating enough vertical force at push-off to let the lead leg naturally land more underneath the body before contact.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6883353/" },
      { text: "Reaching forward from the hip or knee in terminal swing instead of letting the body travel over the foot, potentially due to not enough push-off from the trailing leg.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4714754/" },
      { text: "Running too upright, which increases the leg angle at contact.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4714754/" },
      { text: "Fatigue, downhill running, or pushing pace faster than is well controlled.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10818105/" },
      { text: "Measurement note: the selected foot-strike frame may be slightly before or after actual contact, or the side camera may not be perfectly perpendicular.", ref: "" },
    ],
    formCues: [
      { text: 'Increase cadence by not "reaching" with the lead leg. This is the most well-supported first cue for overstriding -- it usually shortens step length and reduces lower-body loading.', ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10761631/" },
      { text: "Take shorter, quicker steps. Decreasing step length has been shown to reduce musculoskeletal loads and tibial strain.", ref: "https://pubmed.ncbi.nlm.nih.gov/37488528/" },
      { text: "Land closer underneath your body with a more vertical shin. A relatively vertical shin at landing is tied to lower braking forces. This can be achieved by producing more vertical force with the trailing leg push-off, giving yourself more time in the air to get the leg back underneath you.", ref: "https://pubmed.ncbi.nlm.nih.gov/26538175/" },
      { text: "Run softer and quieter. Soft-landing cues can reduce impact-related forces and work well when paired with cadence feedback.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10939780/" },
    ],
    confidence: "This can be flagged with relatively high confidence when it repeats across multiple left and right foot strikes from the side view.",
  },
  hipDrop: {
    title: "Hip drop",
    clear: "No significant hip drop detected",
    summary: {
      notable: "Your hip is dropping significantly on the swing side during stance, which increases stress on the knee and IT band.",
      mild: "Your hip is dropping slightly on the swing side during stance -- a sign that your glute medius could be working harder.",
    },
    whatThisMeans:
      "During stance, your pelvis tilts so the swing-leg side drops below horizontal instead of staying level. Healthy recreational runners typically sit in the 3–8° range; values above ~10° are consistent with higher injury risk per Bramah et al. 2018. 2D video carries roughly ±3–5° of measurement uncertainty vs 3D motion capture, so a single value near a threshold is a prompt for further assessment, not a diagnosis. A left–right asymmetry of 3° or more is itself clinically meaningful, even when both sides are within the healthy range.",
    whyItMatters:
      "Greater pelvic drop and related hip mechanics are commonly observed in runners with patellofemoral pain, ITBS, MTSS, and other lower-chain overload patterns (Bramah 2018: each 1° increase raises the odds of injured classification by ~80%). Not every runner with pelvic drop will have symptoms, but persistent elevation with marked asymmetry warrants a closer look.",
    whyItMattersRef: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3984468/",
    possibleReasons: [
      { text: "Hip abductor or glute medius strength may not be sufficient to hold the pelvis level under the demands of single-leg stance.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9528670/" },
      { text: "Decreased knee drive and vertical force at push-off, resulting in longer ground contact times -- the longer the foot is on the ground, the more time the pelvis has to hold position under load.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9629574/" },
      { text: "Fatigue or pain-related compensation.", ref: "https://pubmed.ncbi.nlm.nih.gov/30503256/" },
      { text: "Coordination issue rather than pure weakness -- strength alone does not fully explain pelvic control in all runners.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8628027/" },
      { text: "Measurement note: camera not perfectly centered, pelvis obscured by clothing, or phase selected outside true mid-stance.", ref: "" },
    ],
    formCues: [
      { text: "Improve knee drive and vertical force at push-off. A compact, relaxed arm carriage -- shoulders dropped, shoulder blades not squeezed together -- supports this by reducing rotational drag through the trunk. The combined effect can lower ground contact time and reduce the time the pelvis needs to stabilize.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9629574/" },
      { text: "Strengthen the glute medius with side planks, banded clamshells, monster walks, and similar exercises.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3201064/" },
      { text: "Run tall through the stance hip. This is a simplified cue for reducing collapse over the support leg -- best paired with visual feedback.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3501612/" },
      { text: "Consider a slight cadence increase. A modest increase often reduces hip and knee loading and can help runners who collapse into stance. Most useful if you are also overstriding or have a low cadence (under 165 spm for most runners, possibly under 160 for taller runners).", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3022995/" },
    ],
    confidence: "This often responds to hip and pelvic control work, but should be confirmed across several mid-stance frames before drawing strong conclusions.",
  },
  torsoUpright: {
    title: "Torso position (too upright)",
    clear: "No significant trunk position issues detected",
    summary: {
      notable: "You are running very upright or even leaning slightly backward, which works against forward momentum.",
      mild: "You are running quite upright, which can reduce the natural forward momentum from a slight lean.",
    },
    whatThisMeans:
      "Your trunk shows very little forward lean, especially at contact and during stance. You may be running very upright or even leaning slightly backward.",
    whyItMatters:
      "A more upright or backward trunk posture increases the leg angle at contact and can increase knee loading. A modest forward lean can reduce patellofemoral loading and improve economy -- but too much or too little lean can work against you.",
    whyItMattersRef: "https://pubmed.ncbi.nlm.nih.gov/33257431/",
    possibleReasons: [
      { text: "Overstriding and low cadence often pair with an upright posture.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4714754/" },
      { text: "Natural posture preference or habitual standing posture carrying into running.", ref: "" },
      { text: "Overcorrecting against slouching, or a fear of falling forward.", ref: "" },
      { text: "Pain avoidance strategy.", ref: "" },
      { text: "Measurement note: wrong phase frame, side camera not level, or treadmill handrail or background affecting the vertical reference.", ref: "" },
    ],
    formCues: [
      { text: "Lean slightly from the ankles, not the waist.", ref: "https://pubmed.ncbi.nlm.nih.gov/34537800/" },
      { text: '"Fall" into the next step. This is a practical cue for creating a small whole-body lean without bending at the hips.', ref: "" },
      { text: "Quicker feet under you. Increasing cadence can reduce the need to reach in front and may indirectly improve trunk posture.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3022995/" },
      { text: "Keep your ribcage stacked over your pelvis, then tip the whole unit slightly forward. Reduce the space between the front of your ribs and your pelvis in a natural way -- do not actively crunch or tuck. This helps distinguish a beneficial lean from bending at the waist.", ref: "https://pubmed.ncbi.nlm.nih.gov/34537800/" },
    ],
    confidence: "A mild increase in whole-body forward lean may reduce braking and knee load, but excessive lean is not the goal.",
  },
  torsoLean: {
    title: "Torso position (excessive lean)",
    clear: "No significant trunk position issues detected",
    summary: {
      notable: "Your trunk is leaning significantly forward during stance, which can overload the lower back and hamstrings.",
      mild: "Your forward lean is slightly more than typical for efficient running.",
    },
    whatThisMeans: "Your trunk shows more forward lean than is typical during stance.",
    whyItMatters: "Excessive forward lean can shift load to the lower back and hamstrings and reduce running economy.",
    whyItMattersRef: "https://pubmed.ncbi.nlm.nih.gov/33257431/",
    possibleReasons: [
      { text: "Bending at the waist rather than leaning from the ankles.", ref: "" },
      { text: "Fatigue causing loss of core stability.", ref: "" },
      { text: "Measurement note: wrong phase frame or camera not level.", ref: "" },
    ],
    formCues: [
      { text: "Make sure the lean comes from the ankles rather than the waist. A slight forward lean is good -- but too much shifts load to the lower back.", ref: "https://pubmed.ncbi.nlm.nih.gov/34537800/" },
      { text: "Engage your core to maintain a neutral spine -- keep your ribcage stacked over your pelvis.", ref: "" },
    ],
    confidence: "A mild increase in whole-body forward lean may reduce braking and knee load, but excessive lean is not the goal.",
  },
  armAngle: {
    title: "Arm angle too open",
    clear: "No significant arm angle issues detected",
    summary: {
      notable: "Your hands are dropping well below the ideal range during the swing phase, which makes the arm swing larger and less efficient, and may increase energy cost.",
      mild: "Your hands are dropping lower than ideal, which makes the arm swing larger and less efficient, and may increase energy cost.",
    },
    whatThisMeans:
      "Your elbows are more extended than expected during running, with hands dropping low and traveling in a wider arc than may be beneficial.",
    whyItMatters:
      "A very open elbow angle tends to produce a longer, lower arm lever -- which can drag the trunk forward, increase rotational drag through the torso, and reduce running economy. An ideal elbow angle is not precisely defined in the literature, but this is flagged when the elbow angles are well outside the typical range.",
    whyItMattersRef: "https://pubmed.ncbi.nlm.nih.gov/31289110/",
    possibleReasons: [
      { text: "Natural style -- this may not be a problem on its own for every runner.", ref: "" },
      { text: "Fatigue leading to a longer arm lever or less compact carriage.", ref: "" },
      { text: "Pace mismatch: faster running tends to produce a more compact arm swing.", ref: "" },
      { text: "Measurement note: elbow partially occluded, or the phase captured at the end of swing.", ref: "" },
    ],
    formCues: [
      { text: "Keep your hands relaxed and let the swing originate at the shoulder, not the hands. Think of driving forward from the elbow, rather than pumping the hands up and down. Palms should face the torso (not the ground, not pointed away).", ref: "https://pubmed.ncbi.nlm.nih.gov/31289110/" },
      { text: "Use the arms to support a strong, vertical push-off rather than to drag yourself forward with a wide, low swing. A more compact arm path keeps the trunk quiet so the legs can do the work of lengthening stride and adding flight time.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4887549/" },
    ],
    confidence: "Arm swing is very individual. The goal is an efficient, natural-feeling, compact arm carriage that supports a strong push-off rather than dragging you forward with a wide, low swing.",
  },
  kneeValgus: {
    title: "Knee valgus",
    clear: "No significant knee valgus detected",
    summary: {
      notable: "Your knee is collapsing noticeably inward during stance, which increases stress on the ACL and patellofemoral joint.",
      mild: "There is slight inward movement of the knee during stance. This is very common and often responds well to targeted exercises.",
    },
    whatThisMeans:
      'Your knee collapses inward from the hip–ankle line during stance (measured as 2D Frontal Plane Projection Angle (FPPA) at peak knee flexion). Healthy recreational runners typically sit in the 2–6° range; values above ~10° are uncommon in uninjured cohorts. 2D video carries roughly ±3–5° of measurement uncertainty vs 3D motion capture, and FPPA is a composite that captures hip adduction and pelvic drop alongside true knee motion -- so an elevated FPPA usually indicates upstream hip control issues, not isolated knee dysfunction. A left–right asymmetry of 3° or more is itself clinically meaningful even when both sides look "OK".',
    whyItMatters:
      'Visible medial knee collapse is associated with patellofemoral pain (PFP), iliotibial band syndrome (ITBS), and medial tibial stress syndrome in runners (Powers 2010; Bramah 2018). Most of that association runs through hip adduction and pelvic drop -- "knee valgus" in running is largely a downstream expression of hip/glute control. A runner with elevated FPPA should also look at their hip drop result, since strengthening hips/core is usually higher-yield than knee-focused work.',
    whyItMattersRef: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9818693/",
    possibleReasons: [
      { text: "Hip strength and control may not be sufficient to keep the knee tracking straight.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9818693/" },
      { text: "Pelvic drop upstream can contribute to knee collapse.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3501612/" },
      { text: "Narrow step width -- widening it can reduce hip adduction and knee loading.", ref: "https://pubmed.ncbi.nlm.nih.gov/40095991/" },
      { text: "Fatigue.", ref: "" },
      { text: "Measurement note: front or back camera misalignment, foot angle making a neutral knee appear valgus in 2D, or analyzing a stride with pelvic rotation.", ref: "" },
    ],
    formCues: [
      { text: "Strengthen the glute medius with side planks, banded clamshells, monster walks, and similar exercises.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3201064/" },
      { text: "Slightly increase step width. Try running on a surface with a visible line -- ideally, the feet should land to either side of the line, rather than both landing on top of it or crossing to the opposite side.", ref: "https://pubmed.ncbi.nlm.nih.gov/40095991/" },
      { text: "Slightly increase cadence. Increasing step rate reduces hip and knee loading and tends to reduce peak hip adduction.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3022995/" },
    ],
    confidence: "2D running valgus can be noisy from stride to stride. Confirm with multiple frame analyses. You can further confirm by doing loaded or single-leg squats and checking if the knee tracks inward during the squat.",
  },
  armsCrossing: {
    title: "Arms crossing midline",
    clear: "No significant arm crossing detected",
    summary: {
      notable: "Your arms are clearly crossing your body centerline, which creates rotational force your core has to counteract with every step.",
      mild: "Your arms are occasionally crossing your body centerline, which creates slight rotational forces.",
    },
    whatThisMeans:
      "Your hands swing across the body past the midline (halfway between your shoulders) instead of staying on their own side. When only one arm crosses, that asymmetry can reflect compensatory trunk rotation -- often pointing back to a lower-body issue (asymmetric hip drop, foot strike, or stride length) rather than an arm-swing problem in isolation.",
    whyItMatters:
      "Arm swing helps control whole-body angular momentum. Active arm swing can reduce torso rotation and metabolic cost. Excessive arm crossing is commonly described as a potential economy issue, though there is not strong evidence proving a specific amount of midline crossing is harmful in otherwise healthy runners. Asymmetric crossing (one arm only) is a stronger signal than symmetric crossing -- look at your hip drop and overstriding results too if one arm is flagged.",
    whyItMattersRef: "https://pubmed.ncbi.nlm.nih.gov/25031455/",
    possibleReasons: [
      { text: "Elbows too far from the body, causing the direction of arm swing to be at an angle rather than straight forward and back.", ref: "" },
      { text: "Compensation for trunk rotation, narrow step width, or asymmetry elsewhere.", ref: "" },
      { text: "Measurement note: front or back camera not centered, shoulder landmarks obscured, or the stride captured during a turn or head movement.", ref: "" },
    ],
    formCues: [
      { text: 'Swing "chin to hip" -- not across your zipper. The arm swing should focus on the path of the elbow, not the hands. An effective arm swing reduces torso rotation.', ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11929735/" },
      { text: "Let the arms swing naturally -- do not force a big drive or suppress arm motion. The evidence favors preserving a natural arm swing rather than over-manipulating it.", ref: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4887549/" },
      { text: "Relax the shoulders and hands. This is more of a coaching heuristic than a directly studied intervention, but it helps.", ref: "" },
    ],
    confidence: "Arm crossing is typically not a large issue unless it is a strong, excessive crossing of the midline that causes extra torso rotation.",
  },
};

// ────────────────────────────────────────────────────────────────
//  Helpers parameterized over liveRanges + selectedSex (no globals).
// ────────────────────────────────────────────────────────────────

function makeHelpers(liveRanges, selectedSex) {
  function getRange(phaseKey, metricKey) {
    const sexRanges = selectedSex ? liveRanges[selectedSex] : null;
    if (sexRanges) {
      const r = sexRanges[phaseKey] ? sexRanges[phaseKey][metricKey] : null;
      if (r && r.reliable && r.n >= MIN_N && r.green && r.warn) {
        return { green: r.green, warn: r.warn, source: "live", n: r.n };
      }
    }
    const d = DEFAULTS[metricKey] || { green: [0, 0], warn: [0, 0] };
    return { green: d.green, warn: d.warn, source: "default", n: 0 };
  }

  function positionLabel(val, metricKey, phaseKey) {
    if (val === undefined || val === null || !isFinite(val)) return "";
    const rng = getRange(phaseKey || "mid", metricKey || "trunk");
    const green = rng.green;
    if (val >= green[0] && val <= green[1]) return "Within range";
    if (val < green[0]) return "Below range";
    return "Above range";
  }

  function getRangeStats(phaseKey, metricKey) {
    const sexRanges = selectedSex ? liveRanges[selectedSex] : null;
    if (sexRanges) {
      const r = sexRanges[phaseKey] ? sexRanges[phaseKey][metricKey] : null;
      if (r && r.reliable && r.n >= MIN_N) {
        if (r.center != null && r.spread != null && r.spread > 0) {
          return { mean: r.center, sd: r.spread, source: "live", n: r.n };
        }
        if (r.mean != null && r.sd != null && r.sd > 0) {
          return { mean: r.mean, sd: r.sd, source: "live", n: r.n };
        }
      }
    }
    const d = DEFAULTS[metricKey] || { green: [0, 0] };
    const mean = (d.green[0] + d.green[1]) / 2;
    const sd = (d.green[1] - d.green[0]) / 3;
    return { mean, sd: sd || 1, source: "default", n: 0 };
  }

  return { getRange, getRangeStats, positionLabel };
}

function metricSideLabel(key, m) {
  if (!m) return "";
  if (key === "nearElbow" && m.nearElbowSide) return " (" + m.nearElbowSide + ")";
  if ((key === "leadKnee" || key === "leadHip" || key === "leadFoot") && m.leadSide) return " (" + m.leadSide + ")";
  if (key === "trailHip" && m.trailSide) return " (" + m.trailSide + ")";
  if ((key === "plantKnee" || key === "plantHip") && m.plantSide) return " (" + m.plantSide + ")";
  return "";
}

// ────────────────────────────────────────────────────────────────
//  PDF design tokens. Paper is a light surface, so these are the
//  light-theme tokens of shared/site.css (DESIGN-STANDARD §1.2).
//  Every colour in both renderers comes from here.
// ────────────────────────────────────────────────────────────────

const PAGE_W = 215.9;
const PAGE_H = 279.4;

const PDF_COLORS = {
  text: [51, 51, 51],
  muted: [88, 96, 114],        // --muted2 light
  accent: [6, 117, 102],       // --accent-ink light
  white: [255, 255, 255],
  rule: [230, 230, 230],       // row hairlines
  ruleStrong: [214, 214, 214], // outer + header rules
  headFill: [238, 241, 245],   // --panel2 light
  boxFill: [246, 247, 249],    // --bg light (callouts, example boxes)
  bad: [198, 40, 40],
  badWash: [254, 238, 238],
  badLine: [252, 199, 199],
  warn: [147, 86, 10],
  warnWash: [254, 244, 229],
  warnLine: [252, 227, 185],
  warnBar: [245, 166, 35],
  good: [11, 122, 80],
  goodLine: [189, 238, 220],
  band: [220, 236, 234],       // reference band under the curve
  curveFill: [238, 241, 245],
  curveStroke: [150, 160, 178],
};

// ────────────────────────────────────────────────────────────────
//  pdfSafe: the standard Helvetica/Courier fonts only encode
//  WinAnsi (cp1252). Anything else prints as garbage, so every
//  string is transliterated or dropped before it reaches jsPDF.
//  Idempotent; arrays map element-wise; non-strings pass through.
// ────────────────────────────────────────────────────────────────

const CP1252_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const PDF_CHAR_MAP = {
  "→": "->", "←": "<-", "Ł": "L", "ł": "l", "−": "-", "≈": "~",
  "‐": "-", "‑": "-", "✓": "", "✔": "",
};

function pdfSafeStr(s) {
  s = s.replace(/ -- /g, " — ");
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\n" || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRAS.has(ch)) {
      out += ch;
    } else if (Object.prototype.hasOwnProperty.call(PDF_CHAR_MAP, ch)) {
      out += PDF_CHAR_MAP[ch];
    } else {
      const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      if (/^[\x20-\x7e]+$/.test(base)) out += base; // otherwise drop (emoji, CJK, …)
    }
  }
  return out;
}

function pdfSafe(v) {
  if (Array.isArray(v)) return v.map(pdfSafe);
  return typeof v === "string" ? pdfSafeStr(v) : v;
}

// One choke point: every string drawn or measured goes through pdfSafe,
// so measuring and drawing always see the same text.
function makePdfDoc() {
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  ["text", "splitTextToSize", "getTextWidth", "textWithLink"].forEach((fn) => {
    const orig = doc[fn].bind(doc);
    doc[fn] = (first, ...rest) => orig(pdfSafe(first), ...rest);
  });
  return doc;
}

// '2026-08-02' -> 'Aug 2, 2026'. No Date parsing, so no timezone shift.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return "";
  const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return MONTHS[mo - 1] + " " + d + ", " + m[1];
}

// ────────────────────────────────────────────────────────────────
//  Text + heading helpers (3 heading levels; each returns new y).
// ────────────────────────────────────────────────────────────────

function pdfSetText(doc, size, style, color, family) {
  doc.setFont(family || "helvetica", style || "normal");
  doc.setFontSize(size);
  doc.setTextColor(...(color || PDF_COLORS.text));
}

// H1: 16pt bold accent + 0.4mm accent rule. `decorate(xAfterText, y)` draws
// inline extras (badge, side tag) on the heading line before the font resets.
function pdfH1(doc, text, y, margins, decorate) {
  pdfSetText(doc, 16, "bold", PDF_COLORS.accent);
  doc.text(text, margins.left, y);
  const xAfter = margins.left + doc.getTextWidth(text);
  doc.setDrawColor(...PDF_COLORS.accent);
  doc.setLineWidth(0.4);
  doc.line(margins.left, y + 3, PAGE_W - margins.right, y + 3);
  if (decorate) decorate(xAfter, y);
  doc.setFont("helvetica", "normal");
  return y + 11;
}

function pdfH2(doc, text, y, margins) {
  pdfSetText(doc, 12, "bold", PDF_COLORS.text);
  doc.text(text, margins.left, y);
  doc.setFont("helvetica", "normal");
  return y + 6;
}

function pdfH3(doc, text, y, margins) {
  pdfSetText(doc, 10, "bold", PDF_COLORS.accent);
  doc.text(String(text).toUpperCase(), margins.left, y);
  doc.setFont("helvetica", "normal");
  return y + 5;
}

// Wrap `text` to at most `maxLines` lines in the current font; the last kept
// line ends with "…" when text was cut.
function pdfFitLines(doc, text, maxW, maxLines) {
  let lines = doc.splitTextToSize(text, maxW);
  if (lines.length <= maxLines) return lines;
  lines = lines.slice(0, maxLines);
  let last = lines[maxLines - 1];
  while (last.length && doc.getTextWidth(last + "…") > maxW) last = last.slice(0, -1);
  lines[maxLines - 1] = last.replace(/\s+$/, "") + "…";
  return lines;
}

// Wrapped paragraph with a page check per line. Returns the new y.
function pdfWrapped(doc, text, x, y, maxW, opts, margins) {
  const o = opts || {};
  const size = o.size || 9;
  pdfSetText(doc, size, o.style, o.color);
  const lines = doc.splitTextToSize(text, maxW);
  const lh = o.lh || size * 0.45;
  for (let i = 0; i < lines.length; i++) {
    y = pdfCheckPage(doc, y, lh, margins);
    doc.text(lines[i], x, y);
    y += lh;
  }
  return y;
}

// Callout (§3.4): neutral fill, hairline border, left bar in the status
// colour, optional title in the status ink. kind: "info" | "warn".
function pdfCallout(doc, opts, y, margins) {
  const C = PDF_COLORS;
  const contentW = PAGE_W - margins.left - margins.right;
  pdfSetText(doc, 9, "normal", C.text);
  const lines = doc.splitTextToSize(opts.body, contentW - 12);
  const lh = 4;
  const titleH = opts.title ? 5.5 : 0;
  const h = 6 + titleH + (lines.length - 1) * lh + 4;
  y = pdfCheckPage(doc, y, h, margins);
  doc.setFillColor(...C.boxFill);
  doc.setDrawColor(...C.rule);
  doc.setLineWidth(0.2);
  doc.roundedRect(margins.left, y, contentW, h, 1.5, 1.5, "FD");
  doc.setFillColor(...(opts.kind === "warn" ? C.warnBar : C.accent));
  doc.rect(margins.left, y, 1.2, h, "F");
  let ty = y + 6;
  if (opts.title) {
    pdfSetText(doc, 10, "bold", opts.kind === "warn" ? C.warn : C.accent);
    doc.text(opts.title, margins.left + 6, ty);
    ty += titleH;
  }
  pdfSetText(doc, 9, "normal", C.text);
  for (let i = 0; i < lines.length; i++) doc.text(lines[i], margins.left + 6, ty + i * lh);
  return y + h;
}

// ────────────────────────────────────────────────────────────────
//  Low-level page drawing helpers.
// ────────────────────────────────────────────────────────────────

// Brand masthead at the top of page 1 (both PDFs). Returns the new y.
function pdfDrawMasthead(doc, y, margins) {
  const C = PDF_COLORS;
  doc.setFillColor(...C.accent);
  doc.roundedRect(margins.left, y, 16, 16, 3, 3, "F");
  pdfSetText(doc, 10, "bold", C.white);
  doc.text("ESLabs", margins.left + 8, y + 10, { align: "center" });
  pdfSetText(doc, 14, "bold", C.text);
  doc.text("Endurance Science Labs", margins.left + 20, y + 7);
  pdfSetText(doc, 11, "bold", C.accent);
  doc.text("esFormLab", margins.left + 20, y + 13.5);
  y += 22;
  doc.setDrawColor(...C.accent);
  doc.setLineWidth(0.5);
  doc.line(margins.left, y, PAGE_W - margins.right, y);
  doc.setFont("helvetica", "normal");
  return y + 10;
}

// Footer rule + brand line. "Page X of N" is drawn once, at the end, by
// pdfDrawPageNumbers. Saves and restores the caller's text state so a page
// break in the middle of a paragraph doesn't change the paragraph's style.
function pdfDrawFooter(doc, margins) {
  const f = doc.getFont(), fs = doc.getFontSize(), tc = doc.getTextColor();
  const dc = doc.getDrawColor(), lw = doc.getLineWidth();
  doc.setDrawColor(...PDF_COLORS.accent);
  doc.setLineWidth(0.3);
  doc.line(margins.left, PAGE_H - 12, PAGE_W - margins.right, PAGE_H - 12);
  pdfSetText(doc, 8, "normal", PDF_COLORS.muted);
  doc.text("esFormLab — Endurance Science Labs", margins.left, PAGE_H - 8);
  doc.setFont(f.fontName, f.fontStyle);
  doc.setFontSize(fs);
  doc.setTextColor(tc);
  doc.setDrawColor(dc);
  doc.setLineWidth(lw);
}

function pdfDrawPageNumbers(doc, margins) {
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    pdfSetText(doc, 8, "normal", PDF_COLORS.muted);
    doc.text("Page " + p + " of " + total, PAGE_W - margins.right, PAGE_H - 8, { align: "right" });
  }
}

function pdfCheckPage(doc, y, needed, margins) {
  if (y + needed > PAGE_H - margins.bottom) {
    doc.addPage();
    pdfDrawFooter(doc, margins);
    return margins.top;
  }
  return y;
}

// Severity badge (§3.7): tinted wash + line + dark ink; CLEAR is a quiet
// outline. Returns x + width + 2.
function pdfDrawBadge(doc, severity, x, y) {
  const C = PDF_COLORS;
  let label, fill, line, ink;
  if (severity === "notable") { label = "NOTABLE"; fill = C.badWash; line = C.badLine; ink = C.bad; }
  else if (severity === "mild") { label = "MILD"; fill = C.warnWash; line = C.warnLine; ink = C.warn; }
  else { label = "CLEAR"; fill = null; line = C.goodLine; ink = C.good; }
  pdfSetText(doc, 7.5, "bold", ink);
  const tw = doc.getTextWidth(label) + 4;
  const bh = 4.8;
  doc.setLineWidth(0.25);
  doc.setDrawColor(...line);
  if (fill) {
    doc.setFillColor(...fill);
    doc.roundedRect(x, y - 3.5, tw, bh, 1.2, 1.2, "FD");
  } else {
    doc.roundedRect(x, y - 3.5, tw, bh, 1.2, 1.2, "S");
  }
  doc.text(label, x + 2, y);
  doc.setFont("helvetica", "normal");
  return x + tw + 2;
}

// "Left side only" / "Right arm only" / "Both sides" (ported from
// esformlab/report-render.js so the PDF matches the screen).
function pdfSideTagText(issue) {
  if (!issue || !issue.detected || !issue.sideSev) return "";
  const noun = issue.sideTagLabel || "side";
  const plural = noun === "arm" ? "arms" : "sides";
  const sL = issue.sideSev.L, sR = issue.sideSev.R;
  if (sL && !sR) return "Left " + noun + " only";
  if (sR && !sL) return "Right " + noun + " only";
  if (sL && sR) return "Both " + plural;
  return "";
}

function pdfDrawSideTag(doc, issue, x, y) {
  const label = pdfSideTagText(issue);
  if (!label) return x;
  pdfSetText(doc, 7.5, "normal", PDF_COLORS.muted);
  const tw = doc.getTextWidth(label) + 4;
  doc.setLineWidth(0.2);
  doc.setDrawColor(...PDF_COLORS.ruleStrong);
  doc.roundedRect(x, y - 3.5, tw, 4.8, 1.2, 1.2, "S");
  doc.text(label, x + 2, y);
  return x + tw + 2;
}

// ────────────────────────────────────────────────────────────────
//  "Four universal principles" (form report section; comparison
//  appendix). Copy differs only in what it points back to.
// ────────────────────────────────────────────────────────────────

const PRINCIPLES = [
  { title: "Stride length should come from push-off, not from reaching ahead", desc: "When stride length is generated by pushing strongly off the back foot to create vertical force, rather than by reaching forward with the lead leg, three things tend to happen at once: your foot lands more underneath your body instead of out in front (less braking, less knee load), ground contact time drops (less load on muscles and tendons), and vertical oscillation goes up -- but productively, because the extra airtime is what is lengthening your stride and allows more time for you to move through the gait cycle efficiently. Reaching with the lead leg lengthens the stride on paper but adds braking force and loads the knee." },
  { title: "A cadence that fits your body", desc: "Not too low (heavy, plodding steps) and not too high (spinning or scuffing without covering ground). Most runners do well somewhere in the 165-185 range, but taller runners may naturally settle lower. Cadence rarely needs to be a direct target on its own -- when push-off improves and stride length lengthens, cadence often improves as well. For one runner, improvement might be an increase in cadence, as they are now landing more underneath the body rather than reaching out in front; for another, it might be a drop in cadence, as they now have enough time for the leg to move through the full gait cycle, without rushing to get the lead foot back on the ground." },
  { title: "Forward lean, from the ankles", desc: "A slight forward lean from the ankles -- not from the waist -- lets you work with gravity rather than against it. This should run through the body as a single line: lean at ankles, neutral pelvis (neither tipped forward into a lower-back arch nor tucked under), ribs stacked over the hips (not flared out), head over the shoulders. When the lean bends at the waist, or the back is arched, you lose the gravity assist and load up the lower back." },
  { title: "Relaxed, compact arms -- without forcing them tight", desc: "Arm carriage affects shoulder tension, breathing, and how much rotational drag your trunk has to absorb every step. Aim for compact, efficient, and relaxed: shoulders dropped (not pulled back), shoulder blades not squeezed together." },
];

/**
 * Draws the principles section starting at the top of a fresh page.
 * @param {object} opts { heading, flaggedWhere, pointsBackTo }
 */
function pdfDrawPrinciples(doc, margins, opts) {
  const C = PDF_COLORS;
  const contentW = PAGE_W - margins.left - margins.right;
  doc.addPage();
  pdfDrawFooter(doc, margins);
  let y = pdfH1(doc, opts.heading, margins.top, margins);

  y = pdfWrapped(doc,
    "Optimize for these -- even if no issues were flagged. The four principles below are universal: every runner benefits from optimizing for them, regardless of which issues were flagged " + opts.flaggedWhere + ", or whether any were flagged at all. Whether your analysis came back clean or flagged a long list, this section is the lens for interpreting your numbers, the framework for separating signal from noise, and where you will figure out what to actually work on.",
    margins.left, y, contentW, { size: 10, style: "bold", color: C.accent, lh: 4 }, margins) + 4;

  y = pdfWrapped(doc,
    "Every runner's stride is highly individual, shaped by body proportions, joint mobility, sporting history, injury history, age, and many other factors. What is optimal for one person may be quite different for another -- whether that is stride length, knee angle at toe-off, or any of the dozens of metrics that can be analyzed. There is no single \"perfect\" number for any of these.",
    margins.left, y, contentW, { size: 10, lh: 4 }, margins) + 2;

  y = pdfWrapped(doc,
    "That said, there are a handful of principles that -- optimized within what is natural for your gait -- will make almost anyone a more efficient, more resilient athlete. Think of them less as a checklist and more as a feedback loop: getting one closer to optimal almost always moves the others in the right direction on its own. The four below are where the highest leverage usually lives, and they are what the " + opts.pointsBackTo + " trying to point you toward.",
    margins.left, y, contentW, { size: 10, lh: 4 }, margins) + 4;

  PRINCIPLES.forEach((sp) => {
    y = pdfCheckPage(doc, y, 14, margins);
    doc.setFillColor(...C.accent);
    doc.circle(margins.left + 2, y - 1, 1.2, "F");
    pdfSetText(doc, 10, "bold", C.text);
    doc.text(sp.title, margins.left + 6, y);
    y += 4;
    y = pdfWrapped(doc, sp.desc, margins.left + 6, y, contentW - 6, { size: 10, color: C.muted, lh: 4 }, margins) + 4;
  });

  y = pdfCheckPage(doc, y, 30, margins);
  y += 2;
  y = pdfH2(doc, "Tracking your progress with wearable data", y, margins);
  y = pdfWrapped(doc,
    "If you have a running watch or wearable that measures stride length, ground contact time, and vertical oscillation, those numbers are how you will know whether a form change is actually working. (Many heart rate straps measure this accurately, such as the Garmin Pro+). A real improvement to metrics discussed above, for example, should show up as a longer stride length, a lower ground contact time, and a stable or improving vertical ratio (vertical oscillation divided by stride length). The data does not have to move on every metric every time, but the direction should match the cue. If you make a change you think is helping and the data flatly does not move -- or moves the wrong way -- it is probably not the right change for your body, and worth trying something else rather than forcing it.",
    margins.left, y, contentW, { size: 10, lh: 4 }, margins) + 4;

  y = pdfCheckPage(doc, y, 60, margins);
  y = pdfH2(doc, "Why small changes add up", y, margins);
  y = pdfWrapped(doc,
    "When a form change strengthens push-off, lengthens stride, or shifts cadence closer to your optimal range, the cumulative effect over an hour of running can be surprisingly large. Consider these examples:",
    margins.left, y, contentW, { size: 10, lh: 4 }, margins) + 3;

  const boxW = (contentW - 6) / 2;
  const boxH = 22;
  const boxY = y;
  [
    { x: margins.left, label: "EXAMPLE A: HIGH CADENCE RUNNER", l1: "Cadence: 190 to 185 spm", l2: "Ground contact: 230 to 225 ms" },
    { x: margins.left + boxW + 6, label: "EXAMPLE B: LOW CADENCE RUNNER", l1: "Cadence: 165 to 170 spm", l2: "Ground contact: 250 to 230 ms" },
  ].forEach((b) => {
    doc.setFillColor(...C.boxFill);
    doc.setDrawColor(...C.rule);
    doc.setLineWidth(0.2);
    doc.roundedRect(b.x, boxY, boxW, boxH, 2, 2, "FD");
    pdfSetText(doc, 8, "bold", C.accent);
    doc.text(b.label, b.x + 4, boxY + 5.5);
    pdfSetText(doc, 9, "normal", C.muted);
    doc.text(b.l1, b.x + 4, boxY + 11.5);
    doc.text(b.l2, b.x + 4, boxY + 16);
  });
  y = boxY + boxH + 6;

  y = pdfWrapped(doc,
    "Both of these scenarios result in over 2 minutes less ground contact time per hour of running. That is 2 fewer minutes of your body needing to stabilize while the foot is planted, with load going through your muscles and tendons -- and 2 more minutes spent in the air, traveling forward without exerting force into the ground. While not a linear relationship (e.g., a 3% improvement in flight time like the examples above doesn't necessarily mean exactly 3% faster or 3% less energy used), efficiency improvements and injury risk reduction from that kind of shift can be meaningful.",
    margins.left, y, contentW, { size: 10, style: "bold", lh: 4 }, margins) + 4;
  return y;
}

// ────────────────────────────────────────────────────────────────
//  Front/back-view measurements (display only; values come from the
//  engine's frontBackMetrics, sent as phases[k].metrics by live
//  sessions or phases[k].frontBackMetrics by saved ones).
// ────────────────────────────────────────────────────────────────

const FRONT_BACK_KEYS = ["mid_front_l", "mid_front_r", "mid_back_l", "mid_back_r"];

function finiteOrNull(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function frontBackMetricsOf(phase) {
  if (!phase || typeof phase !== "object") return null;
  const m = phase.frontBackMetrics || phase.metrics;
  return m && typeof m === "object" ? m : null;
}

function stanceSideOf(m, phaseKey) {
  if (m && (m.stanceSide === "left" || m.stanceSide === "right")) return m.stanceSide;
  return /_l$/.test(phaseKey) ? "left" : "right";
}

const FRONT_BACK_ROWS = [
  { label: "Hip drop", short: "Hip drop", get: (m) => finiteOrNull(m.hipDropDeg), fmt: (v) => v.toFixed(1) + "°" },
  { label: "Stance knee FPPA", short: "Knee FPPA", get: (m, pk) => finiteOrNull(stanceSideOf(m, pk) === "left" ? m.lKneeValgusDeg : m.rKneeValgusDeg), fmt: (v) => v.toFixed(1) + "°" },
  { label: "L wrist crossing", short: "L wrist", frontOnly: true, get: (m) => finiteOrNull(m.lWristCross), fmt: (v) => (v * 100).toFixed(1) + "%" },
  { label: "R wrist crossing", short: "R wrist", frontOnly: true, get: (m) => finiteOrNull(m.rWristCross), fmt: (v) => (v * 100).toFixed(1) + "%" },
];

function frontBackValue(row, phases, pk) {
  if (row.frontOnly && !/^mid_front_/.test(pk)) return null;
  const m = frontBackMetricsOf(phases[pk]);
  return m ? row.get(m, pk) : null;
}

// ════════════════════════════════════════════════════════════════
//  Main render
// ════════════════════════════════════════════════════════════════

/**
 * @param {object} input
 * @param {string} [input.sessionName]   Saved/entered session name (cover title)
 * @param {string} [input.athleteName]   Legacy title field (old clients)
 * @param {string} [input.sessionDate]   YYYY-MM-DD
 * @param {string} [input.generatedISO]  YYYY-MM-DD in the caller's local time
 * @param {object} [input.rangeMeta]     { male, female } reference sampleCount
 * @param {'male'|'female'|null} input.selectedSex
 * @param {object} input.phases    Map phaseKey -> { metrics, frontBackMetrics, ... }
 * @param {object} input.lastIssues  Map issueKey -> { detected, severity, cueKey?, ... }
 * @param {object} input.liveRanges  { male, female, combined } from Firestore computed_ranges
 * @returns {Buffer} PDF bytes
 */
function renderReport(input) {
  const { athleteName, sessionName, sessionDate, generatedISO, rangeMeta, selectedSex, liveRanges, images } = input;
  const phases = input.phases && typeof input.phases === "object" ? input.phases : {};
  const lastIssues = input.lastIssues && typeof input.lastIssues === "object" ? input.lastIssues : {};
  const imgs = images && typeof images === "object" ? images : {};
  const { getRange, getRangeStats, positionLabel } = makeHelpers(liveRanges || {}, selectedSex);
  const C = PDF_COLORS;

  const doc = makePdfDoc();
  const pageW = PAGE_W;
  const pageH = PAGE_H;
  const margins = { top: 20, bottom: 20, left: 20, right: 20 };
  const contentW = pageW - margins.left - margins.right;
  let y = margins.top;

  function newPage() {
    doc.addPage();
    pdfDrawFooter(doc, margins);
    y = margins.top;
  }

  function drawWrapped(text, x, yStart, maxW, fontSize, fontStyle, color, lineH) {
    return pdfWrapped(doc, text, x, yStart, maxW, { size: fontSize, style: fontStyle, color, lh: lineH }, margins);
  }

  function drawBulletList(items, x, yStart, maxW, fontSize) {
    const lh = fontSize * 0.45;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = item.text || item;
      pdfSetText(doc, fontSize, "normal", C.text);
      const lines = doc.splitTextToSize(text, maxW - 6);
      yStart = pdfCheckPage(doc, yStart, lh + 2, margins);
      doc.setFillColor(...C.text);
      doc.circle(x + 1.5, yStart - 1, 0.7, "F");
      for (let j = 0; j < lines.length; j++) {
        yStart = pdfCheckPage(doc, yStart, lh, margins);
        doc.text(lines[j], x + 5, yStart);
        yStart += lh;
      }
      if (item.ref) {
        yStart = pdfCheckPage(doc, yStart, lh, margins);
        pdfSetText(doc, fontSize - 1, "normal", C.accent);
        doc.textWithLink("Source", x + 5, yStart, { url: item.ref });
        yStart += lh;
      }
      yStart += 1;
    }
    return yStart;
  }

  // ====== PAGE 1: Cover ======

  pdfDrawFooter(doc, margins);
  y = pdfDrawMasthead(doc, y, margins);

  const cleanName = (s) => (typeof s === "string" ? s.trim() : "");
  const sName = cleanName(sessionName);
  const title = sName || cleanName(athleteName) || "Running form report";
  if (sName) {
    pdfSetText(doc, 10, "bold", C.accent);
    doc.text("RUNNING FORM REPORT", margins.left, y);
    y += 8;
  }
  pdfSetText(doc, 20, "bold", C.text);
  const titleLines = pdfFitLines(doc, title, contentW, 2);
  titleLines.forEach((line, i) => doc.text(line, margins.left, y + i * 8.5));
  y += (titleLines.length - 1) * 8.5 + 7.5;

  const sexLabel = selectedSex ? selectedSex.charAt(0).toUpperCase() + selectedSex.slice(1) : "";
  const genISO = typeof generatedISO === "string" && fmtDate(generatedISO) ? generatedISO : new Date().toISOString().slice(0, 10);
  const metaParts = [];
  if (fmtDate(sessionDate)) metaParts.push("Session date: " + fmtDate(sessionDate));
  if (sexLabel) metaParts.push("Sex: " + sexLabel);
  metaParts.push("Generated: " + fmtDate(genISO));
  pdfSetText(doc, 10, "normal", C.muted);
  doc.text(metaParts.join("  ·  "), margins.left, y);
  y += 5.5;

  const refN = selectedSex && rangeMeta && typeof rangeMeta[selectedSex] === "number" ? rangeMeta[selectedSex] : null;
  let refLine;
  if (!selectedSex) refLine = "Reference set: general default ranges (no sex selected).";
  else if (refN === null) refLine = "Reference set: " + sexLabel + " elite runners where enough samples exist. Metrics with too few samples fall back to general default ranges.";
  else if (refN >= MIN_N) refLine = "Reference set: " + sexLabel + " elite runners (" + refN + " sessions). Metrics with too few samples fall back to general default ranges.";
  else refLine = "Reference set: general default ranges (too few " + selectedSex + " reference sessions so far).";
  y = drawWrapped(refLine, margins.left, y, contentW, 9, "normal", C.muted, 4) + 1;

  pdfSetText(doc, 8, "normal", C.muted);
  doc.text("Generated by esFormLab -- endurancesciencelabs.com", margins.left, y);
  y += 4;
  doc.text("Educational information only -- not a medical evaluation. The full note is at the end of this report.", margins.left, y);
  y += 12;

  // ====== What we found (summary) ======
  y = pdfH1(doc, "What we found", y, margins);

  const issueList = [
    { key: "overstriding", dataKey: "overstriding" },
    { key: "hipDrop", dataKey: "hipDrop" },
    { key: "armsCrossing", dataKey: "armsCrossing" },
    { key: "torsoPosition", dataKey: null },
    { key: "armAngle", dataKey: "armAngle" },
    { key: "kneeValgus", dataKey: "kneeValgus" },
  ];

  // Classify first so an all-clear headline can lead, above the rows.
  const summaryRows = [];
  for (let ii = 0; ii < issueList.length; ii++) {
    const item = issueList[ii];
    const issue = lastIssues[item.key];
    if (!issue) continue;
    let dk = item.dataKey;
    if (item.key === "torsoPosition" && issue.cueKey) dk = issue.cueKey;
    if (!dk) dk = "torsoUpright";
    const rd = REPORT_DATA[dk];
    if (!rd) continue;
    summaryRows.push({ issueItem: item, issueData: issue, reportData: rd, dataKey: dk });
  }
  const detectedIssues = summaryRows.filter((r) => r.issueData.detected);
  const anyDetected = detectedIssues.length > 0;

  if (!anyDetected) {
    y = pdfCheckPage(doc, y, 25, margins);
    y = pdfH2(doc, "No major gait-pattern flags detected", y, margins);
    y = drawWrapped("Your stride did not show meaningful signs of overstriding, hip drop, excessive arm crossover, overly upright torso position, overly open arm angle, or knee valgus in the analyzed clips. Most measured angles fell within the reference ranges used by this tool.",
      margins.left, y, contentW, 9, "normal", C.muted, 4) + 3;
    y = drawWrapped('This does not mean your running form is "perfect" or that no improvement is possible. It means this analysis did not detect clear issues in these specific categories from the selected videos and frames.',
      margins.left, y, contentW, 9, "normal", C.muted, 4) + 6;
  }

  summaryRows.forEach((row) => {
    const issue = row.issueData;
    const rd = row.reportData;
    const detected = issue.detected;
    const severity = issue.severity;
    let summaryText = "";
    if (detected && severity && rd.summary[severity]) summaryText = rd.summary[severity];
    else if (!detected) summaryText = rd.clear;

    y = pdfCheckPage(doc, y, 12, margins);
    pdfSetText(doc, 10, "bold", C.text);
    doc.text(rd.title, margins.left, y);
    const nextX = pdfDrawBadge(doc, detected ? severity : "clear", margins.left + doc.getTextWidth(rd.title) + 3, y);
    pdfDrawSideTag(doc, issue, nextX, y);
    y += 4.5;
    y = drawWrapped(summaryText, margins.left, y, contentW, 9, "normal", C.muted, 4) + 3;
  });

  // ====== Detailed breakdowns (one per detected issue) ======
  for (let di = 0; di < detectedIssues.length; di++) {
    const dItem = detectedIssues[di];
    const drd = dItem.reportData;
    const dsev = dItem.issueData.severity;

    y = pdfCheckPage(doc, y, 40, margins);
    if (y > margins.top + 20) newPage();

    y = pdfH1(doc, drd.title, y, margins, (xAfter, baseY) => {
      const nx = pdfDrawBadge(doc, dsev, xAfter + 3, baseY);
      pdfDrawSideTag(doc, dItem.issueData, nx, baseY);
    });

    y = pdfCheckPage(doc, y, 10, margins);
    y = pdfH3(doc, "What this means", y, margins);
    y = drawWrapped(drd.whatThisMeans, margins.left, y, contentW, 9, "normal", C.text, 4) + 4;

    y = pdfCheckPage(doc, y, 10, margins);
    y = pdfH3(doc, "Why it matters", y, margins);
    y = drawWrapped(drd.whyItMatters, margins.left, y, contentW, 9, "normal", C.text, 4);
    if (drd.whyItMattersRef) {
      y = pdfCheckPage(doc, y, 5, margins);
      pdfSetText(doc, 8, "normal", C.accent);
      doc.textWithLink("Source: " + drd.whyItMattersRef, margins.left, y, { url: drd.whyItMattersRef });
      y += 5;
    }
    y += 3;

    y = pdfCheckPage(doc, y, 10, margins);
    y = pdfH3(doc, "Why this might be happening", y, margins);
    y = drawBulletList(drd.possibleReasons, margins.left, y, contentW, 9) + 3;

    y = pdfCheckPage(doc, y, 10, margins);
    y = pdfH3(doc, "Form cues to improve " + drd.title, y, margins);
    y = drawBulletList(drd.formCues, margins.left, y, contentW, 9) + 3;

    if (drd.confidence) {
      y = pdfCheckPage(doc, y, 10, margins);
      y = pdfH3(doc, "Confidence note", y, margins);
      y = drawWrapped(drd.confidence, margins.left, y, contentW, 9, "italic", C.muted, 4) + 6;
    }
  }

  // ====== Four universal principles (screen order: after the breakdowns) ======
  y = pdfDrawPrinciples(doc, margins, {
    heading: "Four universal principles",
    flaggedWhere: "above",
    pointsBackTo: "breakdowns above are",
  });

  // ====== Measurements tables ======
  newPage();
  y = pdfH1(doc, "Side-view measurements", y, margins);
  y = drawWrapped("Only the angles relevant to each gait phase are reported. A dash (–) means the metric is not measured at that phase. A column marked “not detected” had no usable frame for that phase.",
    margins.left, y, contentW, 9, "normal", C.muted, 3.8) + 4;

  // Shared table frame: header fill + rules; outer rules strong, inner light.
  function drawTableRules(x, top, h, colEdges, totalW) {
    doc.setLineWidth(0.2);
    doc.setDrawColor(...C.rule);
    for (let i = 1; i < colEdges.length; i++) doc.line(x + colEdges[i], top, x + colEdges[i], top + h);
    doc.setDrawColor(...C.ruleStrong);
    doc.line(x, top, x, top + h);
    doc.line(x + totalW, top, x + totalW, top + h);
  }

  function pdfDrawAngleTable(tableTitle, colKeys) {
    y = pdfCheckPage(doc, y, 40, margins);
    if (tableTitle) {
      pdfSetText(doc, 11, "bold", C.text);
      doc.text(tableTitle, margins.left, y);
      y += 6;
    }

    const activeRows = [];
    for (let mi = 0; mi < METRIC_ROWS.length; mi++) {
      const mr = METRIC_ROWS[mi];
      if (!colKeys.some((pk) => isRelevant(pk, mr.key))) continue;
      let hasData = false;
      for (let ci = 0; ci < colKeys.length; ci++) {
        const pk = colKeys[ci];
        if (!isRelevant(pk, mr.key)) continue;
        const pm = phases[pk] && phases[pk].metrics ? phases[pk].metrics : null;
        if (pm && pm[mr.key] != null) { hasData = true; break; }
      }
      if (hasData) activeRows.push(mr);
    }
    if (activeRows.length === 0) return;

    const labelColW = 28;
    const dataCellW = (contentW - labelColW) / colKeys.length;
    const cellH = 7;
    const headerH = 12;
    const tableX = margins.left;
    const colEdges = [0, labelColW].concat(colKeys.slice(1).map((_, i) => labelColW + (i + 1) * dataCellW));
    const notDetected = colKeys.map((pk) => !phases[pk] || !phases[pk].metrics);
    const colAbbrevs = colKeys.map((k) => {
      const def = PHASE_DEFS.find((d) => d.key === k);
      const l = def ? def.label : k;
      return l.replace("foot strike", "foot str.").replace("Mid-stance", "Mid-st.");
    });

    function drawHeader() {
      doc.setFillColor(...C.headFill);
      doc.rect(tableX, y, contentW, headerH, "F");
      drawTableRules(tableX, y, headerH, colEdges, contentW);
      doc.setDrawColor(...C.ruleStrong);
      doc.line(tableX, y, tableX + contentW, y);
      doc.line(tableX, y + headerH, tableX + contentW, y + headerH);
      pdfSetText(doc, 8, "bold", C.text);
      doc.text("Metric", tableX + 2, y + 4.8);
      for (let ch = 0; ch < colAbbrevs.length; ch++) {
        const cx = tableX + labelColW + ch * dataCellW;
        pdfSetText(doc, 8, "bold", C.text);
        const hLines = doc.splitTextToSize(colAbbrevs[ch], dataCellW - 2).slice(0, notDetected[ch] ? 1 : 2);
        hLines.forEach((hl, i) => doc.text(hl, cx + 1.5, y + 4.8 + i * 3.4));
        if (notDetected[ch]) {
          pdfSetText(doc, 7.5, "normal", C.warn);
          doc.text("not detected", cx + 1.5, y + 8.6);
        }
      }
      y += headerH;
    }

    drawHeader();
    for (let ri = 0; ri < activeRows.length; ri++) {
      const ny = pdfCheckPage(doc, y, cellH + 1, margins);
      if (ny < y) { y = ny; drawHeader(); }
      const row = activeRows[ri];

      drawTableRules(tableX, y, cellH, colEdges, contentW);
      if (ri > 0) {
        doc.setDrawColor(...C.rule);
        doc.line(tableX, y, tableX + contentW, y);
      }
      pdfSetText(doc, 8.5, "normal", C.text);
      doc.text(row.label, tableX + 2, y + cellH - 2.2);

      for (let cj = 0; cj < colKeys.length; cj++) {
        const cx = tableX + labelColW + cj * dataCellW + dataCellW / 2;
        const cpk = colKeys[cj];
        let cellText = null;
        if (!notDetected[cj] && isRelevant(cpk, row.key)) {
          const cpm = phases[cpk].metrics;
          const v = finiteOrNull(cpm[row.key]);
          if (v !== null) cellText = row.fmt(v) + metricSideLabel(row.key, cpm);
        }
        if (cellText === null) {
          pdfSetText(doc, 8.5, "normal", C.muted);
          doc.text("–", cx, y + cellH - 2.2, { align: "center" });
        } else {
          pdfSetText(doc, 8.5, "normal", C.text, "courier");
          doc.text(cellText, cx, y + cellH - 2.2, { align: "center" });
        }
      }
      y += cellH;
    }
    doc.setDrawColor(...C.ruleStrong);
    doc.setLineWidth(0.2);
    doc.line(tableX, y, tableX + contentW, y);
    y += 6;
  }

  pdfDrawAngleTable(null, SUMMARY_COL_ORDER);

  // Front/back-view measurements: hip drop, stance-knee FPPA, wrist crossing.
  const fbCols = FRONT_BACK_KEYS.filter((pk) => FRONT_BACK_ROWS.some((r) => frontBackValue(r, phases, pk) !== null));
  if (fbCols.length) {
    const fbRows = FRONT_BACK_ROWS.filter((r) => FRONT_BACK_KEYS.some((pk) => frontBackValue(r, phases, pk) !== null));
    y = pdfCheckPage(doc, y + 4, 70, margins);
    y = pdfH1(doc, "Front/back-view measurements", y, margins);
    y = drawWrapped("Hip drop and stance-knee FPPA (frontal plane projection angle: positive = medial (valgus), negative = lateral (varus)) are in degrees. Wrist crossing is how far each wrist crosses the body midline, as a % of shoulder width (front view only). A dash (–) means it was not measured in that frame.",
      margins.left, y, contentW, 9, "normal", C.muted, 3.8) + 4;

    const labelColW = 36;
    const dataCellW = (contentW - labelColW) / FRONT_BACK_KEYS.length;
    const cellH = 7;
    const headerH = 9;
    const tableX = margins.left;
    const colEdges = [0, labelColW].concat(FRONT_BACK_KEYS.slice(1).map((_, i) => labelColW + (i + 1) * dataCellW));
    const fbHeaders = ["L stance (front)", "R stance (front)", "L stance (back)", "R stance (back)"];

    function drawFbHeader() {
      doc.setFillColor(...C.headFill);
      doc.rect(tableX, y, contentW, headerH, "F");
      drawTableRules(tableX, y, headerH, colEdges, contentW);
      doc.setDrawColor(...C.ruleStrong);
      doc.line(tableX, y, tableX + contentW, y);
      doc.line(tableX, y + headerH, tableX + contentW, y + headerH);
      pdfSetText(doc, 8, "bold", C.text);
      doc.text("Measure", tableX + 2, y + 5.8);
      fbHeaders.forEach((h, i) => doc.text(h, tableX + labelColW + i * dataCellW + dataCellW / 2, y + 5.8, { align: "center" }));
      y += headerH;
    }

    drawFbHeader();
    fbRows.forEach((row, ri) => {
      const ny = pdfCheckPage(doc, y, cellH + 1, margins);
      if (ny < y) { y = ny; drawFbHeader(); }
      drawTableRules(tableX, y, cellH, colEdges, contentW);
      if (ri > 0) {
        doc.setDrawColor(...C.rule);
        doc.line(tableX, y, tableX + contentW, y);
      }
      pdfSetText(doc, 8.5, "normal", C.text);
      doc.text(row.label, tableX + 2, y + cellH - 2.2);
      FRONT_BACK_KEYS.forEach((pk, ci) => {
        const cx = tableX + labelColW + ci * dataCellW + dataCellW / 2;
        const v = frontBackValue(row, phases, pk);
        if (v === null) {
          pdfSetText(doc, 8.5, "normal", C.muted);
          doc.text("–", cx, y + cellH - 2.2, { align: "center" });
        } else {
          pdfSetText(doc, 8.5, "normal", C.text, "courier");
          doc.text(row.fmt(v), cx, y + cellH - 2.2, { align: "center" });
        }
      });
      y += cellH;
    });
    doc.setDrawColor(...C.ruleStrong);
    doc.setLineWidth(0.2);
    doc.line(tableX, y, tableX + contentW, y);
    y += 6;
  }

  // ====== CAPTURED FRAME SCREENSHOTS ======
  // The exact frame analyzed for each detected phase, with the pose/angle
  // overlays baked in client-side. Side-view (landscape) frames get the full
  // cell width with their angles listed underneath; front/back frames start a
  // new row, with their measurements beside the frame. Row height comes from
  // the real images. Images arrive in the request payload (never persisted);
  // a phase with no image is skipped (graceful fallback for older sessions).
  const shotKeys = PHASE_DEFS.map((d) => d.key).filter((k) => typeof imgs[k] === "string");
  if (shotKeys.length) {
    newPage();
    y = pdfH1(doc, "Captured frames", y, margins);
    y = drawWrapped("The exact frame analyzed for each phase, with the pose and angle overlays drawn at capture time. The angles used for that phase are listed with each frame.",
      margins.left, y, contentW, 9, "normal", C.muted, 3.8) + 4;

    const gap = 8;
    const cellW = (contentW - gap) / 2;
    const maxImgH = 60;
    const labelH = 5;
    const listLH = 3.6;

    const cellLayout = (pk) => {
      const dataUrl = imgs[pk];
      let props = null;
      try { props = doc.getImageProperties(dataUrl); } catch (e) { props = null; }
      const aspect = (props && props.width && props.height) ? props.height / props.width : 9 / 16;
      const side = SUMMARY_COL_ORDER.includes(pk);
      const lines = [];
      if (side) {
        const pm = phases[pk] && phases[pk].metrics ? phases[pk].metrics : null;
        if (pm) {
          for (let mi = 0; mi < METRIC_ROWS.length; mi++) {
            const mr = METRIC_ROWS[mi];
            const v = finiteOrNull(pm[mr.key]);
            if (!isRelevant(pk, mr.key) || v === null) continue;
            lines.push(mr.label + " " + mr.fmt(v) + metricSideLabel(mr.key, pm));
          }
        }
        let dispW = cellW, dispH = cellW * aspect;
        if (dispH > maxImgH) { dispH = maxImgH; dispW = maxImgH / aspect; }
        const twoCol = lines.length > 3;
        const listRows = twoCol ? Math.ceil(lines.length / 2) : lines.length;
        return { pk, dataUrl, side, lines, dispW, dispH, twoCol, listRows, h: labelH + dispH + 2 + listRows * listLH };
      }
      FRONT_BACK_ROWS.forEach((r) => {
        const v = frontBackValue(r, phases, pk);
        if (v !== null) lines.push(r.short + " " + r.fmt(v));
      });
      let dispW = cellW * 0.5, dispH = dispW * aspect;
      if (dispH > maxImgH) { dispH = maxImgH; dispW = maxImgH / aspect; }
      return { pk, dataUrl, side, lines, dispW, dispH, h: labelH + Math.max(dispH, lines.length * 4) };
    };

    const drawCell = (c, cellX, rowTop) => {
      const def = PHASE_DEFS.find((d) => d.key === c.pk);
      pdfSetText(doc, 9, "bold", C.text);
      doc.text(def ? def.label : c.pk, cellX, rowTop + 3.5);
      const imgY = rowTop + labelH;
      try {
        doc.addImage(c.dataUrl, "JPEG", cellX, imgY, c.dispW, c.dispH);
      } catch (e) {
        // Unreadable image -- skip the picture but keep the label + angles.
      }
      doc.setDrawColor(...C.ruleStrong);
      doc.setLineWidth(0.2);
      doc.rect(cellX, imgY, c.dispW, c.dispH);

      pdfSetText(doc, 8, "normal", C.text, "courier");
      if (c.side) {
        const listTop = imgY + c.dispH + 2 + 2.8;
        c.lines.forEach((line, i) => {
          const col = c.twoCol && i >= c.listRows ? 1 : 0;
          const r = col ? i - c.listRows : i;
          doc.text(line, cellX + col * (cellW / 2), listTop + r * listLH);
        });
      } else {
        c.lines.forEach((line, i) => doc.text(line, cellX + c.dispW + 4, imgY + 3 + i * 4));
      }
    };

    let rowTop = y;
    const groups = [
      shotKeys.filter((k) => SUMMARY_COL_ORDER.includes(k)),
      shotKeys.filter((k) => !SUMMARY_COL_ORDER.includes(k)),
    ];
    groups.forEach((group) => {
      for (let i = 0; i < group.length; i += 2) {
        const cells = group.slice(i, i + 2).map(cellLayout);
        const rowH = Math.max(...cells.map((c) => c.h)) + 6;
        rowTop = pdfCheckPage(doc, rowTop, rowH, margins);
        cells.forEach((c, col) => drawCell(c, margins.left + col * (cellW + gap), rowTop));
        rowTop += rowH;
      }
    });
  }

  // ====== BELL CURVE DETAIL PAGES ======
  newPage();
  y = pdfH1(doc, "Angle measurements by phase", y, margins);

  const refNoteLead = selectedSex
    ? "The bell curves and ranges in the following pages are based on data from elite-level marathoners."
    : "No sex was selected for this analysis, so the ranges on the following pages are general default bands, not elite reference data.";
  y = pdfCallout(doc, {
    kind: "info",
    title: "A note about these reference ranges",
    body: refNoteLead + " Very few recreational runners will match these ranges across every metric, and that is completely normal. A value outside the elite range does not mean something is wrong or needs to be changed. Running mechanics are highly individual, and what matters most is efficiency and comfort within your own body. This data is provided for informational context only -- not as a target to chase or a diagnosis of a problem.",
  }, y, margins) + 6;

  y = pdfCallout(doc, {
    kind: "warn",
    title: "Not medical advice",
    body: "This running form analysis is provided for educational and informational purposes only. It is not a medical evaluation and is not intended to diagnose, treat, cure, or prevent any disease, injury, or other health condition. The results -- including any flagged issues, joint angles, severity grades, and coaching cues -- do not constitute a medical diagnosis. Use of this tool, the report, or any related content does not create a doctor-patient or healthcare-provider relationship between you and Endurance Science Labs, its coaches, or its contributors. Always consult a qualified healthcare professional before starting a new exercise program or changing your training based on these results. Use of this tool is at your own risk.",
  }, y, margins) + 6;

  y = pdfCallout(doc, {
    kind: "warn",
    title: "If a measurement looks wildly out of range",
    body: 'If a measurement looks wildly out of range, first check that the right frame was picked for that phase. The most common cause of an extreme outlier is the wrong gait phase being selected (e.g. a frame partway between foot-strike and mid-stance) or a side-view frame where the runner was at an angle to the camera instead of dead-on side. Re-open that phase in the analyzer, click "Show example frames for this phase", scrub until your frame matches the helper photo as closely as possible, and click Analyze again. A clean frame almost always brings extreme values back into a sensible range.',
  }, y, margins) + 8;

  y = drawWrapped("The following pages show each measured angle for every analyzed gait phase, with a bell curve showing where your value falls relative to the reference population. The shaded band represents the reference range, and the dashed line marks your measured value.",
    margins.left, y, contentW, 10, "normal", C.text, 4) + 4;

  SUMMARY_COL_ORDER.forEach((pk) => {
    const phaseDef = PHASE_DEFS.find((d) => d.key === pk);
    if (!phaseDef) return;
    const phaseData = phases[pk];
    if (!phaseData || !phaseData.metrics) return;
    const pm = phaseData.metrics;

    const relevantRows = METRIC_ROWS.filter((r) => isRelevant(pk, r.key) && finiteOrNull(pm[r.key]) !== null);
    if (relevantRows.length === 0) return;

    newPage();
    const headY = y;
    pdfH1(doc, phaseDef.label, y, margins);
    pdfSetText(doc, 9, "normal", C.muted);
    doc.text(phaseDef.desc, margins.left, headY + 8);
    y = headY + 17;

    relevantRows.forEach((mr) => {
      const val = pm[mr.key];

      // Never leave a metric orphaned on a page without its phase heading.
      if (y + 52 > pageH - margins.bottom) {
        newPage();
        y = pdfH2(doc, phaseDef.label + " (continued)", y, margins) + 4;
      }

      const labelY = y;
      pdfH2(doc, (mr.label || mr.key) + metricSideLabel(mr.key, pm), labelY, margins);
      const fmtVal = mr.fmt ? mr.fmt(val) : val.toFixed(1);
      const posLabel = positionLabel(val, mr.key, pk);
      pdfSetText(doc, 10, "bold", C.text, "courier");
      doc.text(fmtVal + (posLabel ? "  (" + posLabel + ")" : ""), pageW - margins.right, labelY, { align: "right" });
      y = labelY + 5;

      const bio = METRIC_BIO[mr.key] || "";
      if (bio) {
        pdfSetText(doc, 9, "normal", C.muted);
        const bioLines = doc.splitTextToSize(bio, contentW);
        bioLines.forEach((line, i) => doc.text(line, margins.left, y + i * 3.6));
        y += bioLines.length * 3.6 + 2;
      }

      const stats = getRangeStats(pk, mr.key);
      const rng = getRange(pk, mr.key);
      const curveMean = stats.mean;
      const curveSD = stats.sd;
      const greenLo = rng.green[0];
      const greenHi = rng.green[1];

      const curveW = contentW * 0.7;
      const curveH = 18;
      const curveX = margins.left + (contentW - curveW) / 2;
      const curveBaseY = y + curveH + 2;
      const xMin = curveMean - 3.5 * curveSD;
      const xRange = 7 * curveSD;

      const toXmm = (v) => curveX + ((v - xMin) / xRange) * curveW;
      const rawLo = toXmm(greenLo), rawHi = toXmm(greenHi);
      const bandLo = Math.max(rawLo, curveX);
      const bandHi = Math.min(rawHi, curveX + curveW);

      const curvePts = [];
      for (let ci = 0; ci <= 80; ci++) {
        const xVal = xMin + ((xRange * ci) / 80);
        const z = (xVal - curveMean) / curveSD;
        const gY = Math.exp(-0.5 * z * z);
        curvePts.push({ px: curveX + (ci / 80) * curveW, py: curveBaseY - gY * curveH });
      }

      // Fill under the curve; strips inside the reference range take the band wash.
      const stripW = curveW / 80;
      let stripFill = null;
      for (let si = 0; si < curvePts.length - 1; si++) {
        const stripH = curveBaseY - curvePts[si].py;
        if (stripH <= 0.1) continue;
        const mid = curvePts[si].px + stripW / 2;
        const fill = bandHi > bandLo && mid >= bandLo && mid <= bandHi ? C.band : C.curveFill;
        if (fill !== stripFill) { doc.setFillColor(...fill); stripFill = fill; }
        doc.rect(curvePts[si].px, curvePts[si].py, stripW + 0.1, stripH, "F");
      }

      doc.setDrawColor(...C.curveStroke);
      doc.setLineWidth(0.35);
      for (let cl = 1; cl < curvePts.length; cl++) {
        doc.line(curvePts[cl - 1].px, curvePts[cl - 1].py, curvePts[cl].px, curvePts[cl].py);
      }

      const rawVal = toXmm(val);
      const offLeft = rawVal < curveX, offRight = rawVal > curveX + curveW;
      const valXmm = Math.max(curveX, Math.min(curveX + curveW, rawVal));
      doc.setDrawColor(...C.text);
      doc.setLineWidth(0.4);
      const dashLen = 1.2, gapLen = 0.8;
      let dashY = y + 1;
      while (dashY < curveBaseY) {
        const dashEnd = Math.min(dashY + dashLen, curveBaseY);
        doc.line(valXmm, dashY, valXmm, dashEnd);
        dashY = dashEnd + gapLen;
      }

      pdfSetText(doc, 7.5, "bold", C.text);
      doc.text(fmtVal, valXmm, y, { align: "center" });
      if (offLeft || offRight) {
        // Off the drawn scale: an outward-pointing triangle + "off scale" label.
        const halfW = doc.getTextWidth(fmtVal) / 2;
        doc.setFillColor(...C.text);
        if (offLeft) {
          const bx = valXmm - halfW - 1;
          doc.triangle(bx - 2.4, y - 1.1, bx, y - 2.3, bx, y + 0.1, "F");
          pdfSetText(doc, 7.5, "normal", C.muted);
          doc.text("off scale", valXmm + halfW + 1.5, y);
        } else {
          const bx = valXmm + halfW + 1;
          doc.triangle(bx + 2.4, y - 1.1, bx, y - 2.3, bx, y + 0.1, "F");
          pdfSetText(doc, 7.5, "normal", C.muted);
          doc.text("off scale", valXmm - halfW - 1.5, y, { align: "right" });
        }
      }

      const meanXmm = toXmm(curveMean);
      const centreLabel = stats.source === "live" ? "Elite avg" : "Default center";
      pdfSetText(doc, 7.5, "normal", C.muted);
      doc.text(centreLabel, meanXmm, curveBaseY + 3.5, { align: "center" });
      const centreHalf = doc.getTextWidth(centreLabel) / 2;
      doc.setDrawColor(...C.muted);
      doc.setLineWidth(0.2);
      doc.line(meanXmm, curveBaseY - 0.5, meanXmm, curveBaseY + 0.5);

      if (bandHi > bandLo) {
        // Band limits (reference values) under the band edges, unless clipped
        // by the drawn scale or colliding with the centre label.
        if (rawLo >= curveX) {
          const t = mr.fmt(greenLo);
          if (bandLo + doc.getTextWidth(t) + 1.5 < meanXmm - centreHalf) doc.text(t, bandLo, curveBaseY + 3.5);
        }
        if (rawHi <= curveX + curveW) {
          const t = mr.fmt(greenHi);
          if (bandHi - doc.getTextWidth(t) - 1.5 > meanXmm + centreHalf) doc.text(t, bandHi, curveBaseY + 3.5, { align: "right" });
        }
        doc.text("Reference range", (bandLo + bandHi) / 2, curveBaseY + 7.5, { align: "center" });
      }

      y = curveBaseY + 12;

      doc.setDrawColor(...C.rule);
      doc.setLineWidth(0.15);
      doc.line(margins.left + 10, y, pageW - margins.right - 10, y);
      y += 8;
    });
  });

  pdfDrawPageNumbers(doc, margins);
  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = {
  renderReport,
  // Shared constants + helpers re-used by comparison-renderer.js.
  // Exported so the comparison renderer can stay parameter-driven
  // without duplicating the same tables and pdf helpers.
  PAGE_W,
  PAGE_H,
  PHASE_DEFS,
  METRIC_ROWS,
  isRelevant,
  metricSideLabel,
  makeHelpers,
  PDF_COLORS,
  pdfSafe,
  makePdfDoc,
  fmtDate,
  pdfSetText,
  pdfH1,
  pdfH2,
  pdfH3,
  pdfFitLines,
  pdfWrapped,
  pdfCallout,
  pdfDrawMasthead,
  pdfDrawFooter,
  pdfDrawPageNumbers,
  pdfCheckPage,
  pdfDrawBadge,
  pdfDrawSideTag,
  pdfDrawPrinciples,
};
