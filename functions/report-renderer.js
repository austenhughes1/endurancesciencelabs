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
//  Low-level page drawing helpers.
// ────────────────────────────────────────────────────────────────

function pdfDrawFooter(doc, margins) {
  const pageH = 279.4;
  const pageW = 215.9;
  doc.setDrawColor(0, 137, 123);
  doc.setLineWidth(0.3);
  doc.line(margins.left, pageH - 12, pageW - margins.right, pageH - 12);
  doc.setFontSize(8);
  doc.setTextColor(119, 119, 119);
  doc.text("esFormLab -- Endurance Science Labs", margins.left, pageH - 8);
  const pageNum = doc.internal.getNumberOfPages();
  doc.text("Page " + pageNum, pageW - margins.right, pageH - 8, { align: "right" });
}

function pdfCheckPage(doc, y, needed, margins) {
  if (y + needed > 279.4 - margins.bottom) {
    doc.addPage();
    pdfDrawFooter(doc, margins);
    return margins.top;
  }
  return y;
}

function pdfDrawBadge(doc, severity, x, y) {
  let label = "";
  let bgR = 0, bgG = 0, bgB = 0;
  const txtR = 255, txtG = 255, txtB = 255;
  if (severity === "notable") {
    label = "NOTABLE";
    bgR = 216; bgG = 67; bgB = 21;
  } else if (severity === "mild") {
    label = "MILD";
    bgR = 239; bgG = 108; bgB = 0;
  } else {
    label = "CLEAR";
    bgR = 34; bgG = 199; bgB = 138;
  }
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  const tw = doc.getTextWidth(label) + 4;
  const bh = 4.5;
  doc.setFillColor(bgR, bgG, bgB);
  doc.roundedRect(x, y - 3.2, tw, bh, 1.5, 1.5, "F");
  doc.setTextColor(txtR, txtG, txtB);
  doc.text(label, x + 2, y);
  doc.setFont("helvetica", "normal");
  return x + tw + 2;
}

// ════════════════════════════════════════════════════════════════
//  Main render
// ════════════════════════════════════════════════════════════════

/**
 * @param {object} input
 * @param {string} input.athleteName
 * @param {'male'|'female'|null} input.selectedSex
 * @param {object} input.phases    Map phaseKey -> { metrics, frontBackMetrics, ... }
 * @param {object} input.lastIssues  Map issueKey -> { detected, severity, cueKey?, ... }
 * @param {object} input.liveRanges  { male, female, combined } from Firestore computed_ranges
 * @returns {Buffer} PDF bytes
 */
function renderReport(input) {
  const { athleteName, selectedSex, phases, lastIssues, liveRanges } = input;
  const { getRange, getRangeStats, positionLabel } = makeHelpers(liveRanges || {}, selectedSex);

  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const pageW = 215.9;
  const pageH = 279.4;
  const margins = { top: 20, bottom: 20, left: 20, right: 20 };
  const contentW = pageW - margins.left - margins.right;
  let y = margins.top;

  const accentR = 0, accentG = 137, accentB = 123;
  const bodyR = 51, bodyG = 51, bodyB = 51;
  const mutedR = 119, mutedG = 119, mutedB = 119;

  function drawWrapped(text, x, yStart, maxW, fontSize, fontStyle, colorR, colorG, colorB, lineH) {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", fontStyle || "normal");
    doc.setTextColor(colorR, colorG, colorB);
    const lines = doc.splitTextToSize(text, maxW);
    const lh = lineH || fontSize * 0.45;
    for (let i = 0; i < lines.length; i++) {
      yStart = pdfCheckPage(doc, yStart, lh, margins);
      doc.text(lines[i], x, yStart);
      yStart += lh;
    }
    return yStart;
  }

  function drawBulletList(items, x, yStart, maxW, fontSize) {
    const lh = fontSize * 0.45;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = item.text || item;
      doc.setFontSize(fontSize);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(bodyR, bodyG, bodyB);
      const lines = doc.splitTextToSize(text, maxW - 6);
      yStart = pdfCheckPage(doc, yStart, lh + 2, margins);
      doc.setFillColor(bodyR, bodyG, bodyB);
      doc.circle(x + 1.5, yStart - 1, 0.7, "F");
      for (let j = 0; j < lines.length; j++) {
        yStart = pdfCheckPage(doc, yStart, lh, margins);
        doc.text(lines[j], x + 5, yStart);
        yStart += lh;
      }
      if (item.ref) {
        yStart = pdfCheckPage(doc, yStart, lh, margins);
        doc.setTextColor(accentR, accentG, accentB);
        doc.setFontSize(fontSize - 1);
        doc.textWithLink("Source", x + 5, yStart, { url: item.ref });
        yStart += lh;
      }
      yStart += 1;
    }
    return yStart;
  }

  // ====== PAGE 1: Cover / Header + Issue Summary ======

  doc.setFillColor(accentR, accentG, accentB);
  doc.roundedRect(margins.left, y, 16, 16, 3, 3, "F");
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("ESL", margins.left + 8, y + 10, { align: "center" });

  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Endurance Science Labs", margins.left + 20, y + 7);
  doc.setFontSize(12);
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("esFormLab", margins.left + 20, y + 14);
  y += 22;

  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.5);
  doc.line(margins.left, y, pageW - margins.right, y);
  y += 8;

  const displayName = (athleteName && athleteName.trim()) ? athleteName.trim() : "Gait Analysis Report";
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text(displayName, margins.left, y);
  y += 6;

  const dateStr = new Date().toISOString().slice(0, 10);
  let sessionLine = "Date: " + dateStr;
  if (selectedSex) {
    sessionLine += "    Sex: " + selectedSex.charAt(0).toUpperCase() + selectedSex.slice(1);
  }
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text(sessionLine, margins.left, y);
  y += 5;
  doc.setFontSize(8);
  doc.text("Generated by esFormLab -- endurancesciencelabs.com", margins.left, y);
  y += 12;

  // ====== Results Summary ======
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("Results Summary", margins.left, y);
  y += 8;

  const issueList = [
    { key: "overstriding", dataKey: "overstriding" },
    { key: "hipDrop", dataKey: "hipDrop" },
    { key: "armsCrossing", dataKey: "armsCrossing" },
    { key: "torsoPosition", dataKey: null },
    { key: "armAngle", dataKey: "armAngle" },
    { key: "kneeValgus", dataKey: "kneeValgus" },
  ];

  const detectedIssues = [];
  let anyDetected = false;

  for (let ii = 0; ii < issueList.length; ii++) {
    const item = issueList[ii];
    const issue = lastIssues[item.key];
    if (!issue) continue;

    let dk = item.dataKey;
    if (item.key === "torsoPosition" && issue.cueKey) dk = issue.cueKey;
    if (!dk) dk = "torsoUpright";
    const rd = REPORT_DATA[dk];
    if (!rd) continue;

    const detected = issue.detected;
    const severity = issue.severity;

    let summaryText = "";
    if (detected && severity && rd.summary[severity]) {
      summaryText = rd.summary[severity];
    } else if (!detected) {
      summaryText = rd.clear;
    }

    y = pdfCheckPage(doc, y, 12, margins);

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text(rd.title, margins.left, y);
    const titleW = doc.getTextWidth(rd.title);

    const badgeX = margins.left + titleW + 3;
    const sevLabel = detected ? severity : "clear";
    pdfDrawBadge(doc, sevLabel, badgeX, y);

    y += 4;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(mutedR, mutedG, mutedB);
    const sumLines = doc.splitTextToSize(summaryText, contentW);
    for (let sl = 0; sl < sumLines.length; sl++) {
      doc.text(sumLines[sl], margins.left, y);
      y += 4;
    }
    y += 3;

    if (detected) {
      anyDetected = true;
      detectedIssues.push({ issueItem: item, issueData: issue, reportData: rd, dataKey: dk });
    }
  }

  if (!anyDetected) {
    y = pdfCheckPage(doc, y, 25, margins);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text("No major gait-pattern flags detected", margins.left, y);
    y += 6;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(mutedR, mutedG, mutedB);
    const noFlagText = "Your stride did not show meaningful signs of overstriding, hip drop, excessive arm crossover, overly upright torso position, overly open arm angle, or knee valgus in the analyzed clips. Most measured angles fell within the reference ranges used by this tool.";
    const nfLines = doc.splitTextToSize(noFlagText, contentW);
    for (let nf = 0; nf < nfLines.length; nf++) {
      doc.text(nfLines[nf], margins.left, y);
      y += 4;
    }
    y += 4;
    const disclaimerText = 'This does not mean your running form is "perfect" or that no improvement is possible. It means this analysis did not detect clear issues in these specific categories from the selected videos and frames.';
    const dLines = doc.splitTextToSize(disclaimerText, contentW);
    for (let dl = 0; dl < dLines.length; dl++) {
      doc.text(dLines[dl], margins.left, y);
      y += 4;
    }
  }

  pdfDrawFooter(doc, margins);

  // ====== PAGE 2: Understanding Your Stride ======
  doc.addPage();
  pdfDrawFooter(doc, margins);
  y = margins.top;

  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("How to read your stride", margins.left, y);
  y += 8;

  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.4);
  doc.line(margins.left, y, pageW - margins.right, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  const readRegardless = doc.splitTextToSize(
    "Optimize for these -- even if no issues were flagged. The four principles below are universal: every runner benefits from optimizing for them, regardless of which issues were flagged above, or whether any were flagged at all. Whether your analysis came back clean or flagged a long list, this section is the lens for interpreting your numbers, the framework for separating signal from noise, and where you will figure out what to actually work on.",
    contentW
  );
  doc.text(readRegardless, margins.left, y);
  y += readRegardless.length * 4 + 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const strideIntro1 = doc.splitTextToSize(
    "Every runner's stride is highly individual, shaped by body proportions, joint mobility, sporting history, injury history, age, and many other factors. What is optimal for one person may be quite different for another -- whether that is stride length, knee angle at toe-off, or any of the dozens of metrics that can be analyzed. There is no single \"perfect\" number for any of these.",
    contentW
  );
  doc.text(strideIntro1, margins.left, y);
  y += strideIntro1.length * 4 + 4;

  const strideIntro2 = doc.splitTextToSize(
    "That said, there are a handful of principles that -- optimized within what is natural for your gait -- will make almost anyone a more efficient, more resilient athlete. Think of them less as a checklist and more as a feedback loop: getting one closer to optimal almost always moves the others in the right direction on its own. The four below are where the highest leverage usually lives, and they are what the cards above are trying to point you toward.",
    contentW
  );
  doc.text(strideIntro2, margins.left, y);
  y += strideIntro2.length * 4 + 6;

  const stridePrinciples = [
    { title: "Stride length should come from push-off, not from reaching ahead", desc: "When stride length is generated by pushing strongly off the back foot to create vertical force, rather than by reaching forward with the lead leg, three things tend to happen at once: your foot lands more underneath your body instead of out in front (less braking, less knee load), ground contact time drops (less load on muscles and tendons), and vertical oscillation goes up -- but productively, because the extra airtime is what is lengthening your stride and allows more time for you to move through the gait cycle efficiently. Reaching with the lead leg lengthens the stride on paper but adds braking force and loads the knee." },
    { title: "A cadence that fits your body", desc: "Not too low (heavy, plodding steps) and not too high (spinning or scuffing without covering ground). Most runners do well somewhere in the 165-185 range, but taller runners may naturally settle lower. Cadence rarely needs to be a direct target on its own -- when push-off improves and stride length lengthens, cadence often improves as well. For one runner, improvement might be an increase in cadence, as they are now landing more underneath the body rather than reaching out in front; for another, it might be a drop in cadence, as they now have enough time for the leg to move through the full gait cycle, without rushing to get the lead foot back on the ground." },
    { title: "Forward lean, from the ankles", desc: "A slight forward lean from the ankles -- not from the waist -- lets you work with gravity rather than against it. This should run through the body as a single line: lean at ankles, neutral pelvis (neither tipped forward into a lower-back arch nor tucked under), ribs stacked over the hips (not flared out), head over the shoulders. When the lean bends at the waist, or the back is arched, you lose the gravity assist and load up the lower back." },
    { title: "Relaxed, compact arms -- without forcing them tight", desc: "Arm carriage affects shoulder tension, breathing, and how much rotational drag your trunk has to absorb every step. Aim for compact, efficient, and relaxed: shoulders dropped (not pulled back), shoulder blades not squeezed together." },
  ];

  stridePrinciples.forEach((sp) => {
    y = pdfCheckPage(doc, y, 14, margins);
    doc.setFillColor(accentR, accentG, accentB);
    doc.circle(margins.left + 2, y - 1, 1.2, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text(sp.title, margins.left + 6, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(mutedR, mutedG, mutedB);
    const descLines = doc.splitTextToSize(sp.desc, contentW - 6);
    doc.text(descLines, margins.left + 6, y);
    y += descLines.length * 4 + 4;
  });

  y = pdfCheckPage(doc, y, 30, margins);
  y += 4;
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Tracking your progress with wearable data", margins.left, y);
  y += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const trackingText = doc.splitTextToSize(
    "If you have a running watch or wearable that measures stride length, ground contact time, and vertical oscillation, those numbers are how you will know whether a form change is actually working. (Many heart rate straps measure this accurately, such as the Garmin Pro+). A real improvement to metrics discussed above, for example, should show up as a longer stride length, a lower ground contact time, and a stable or improving vertical ratio (vertical oscillation divided by stride length). The data does not have to move on every metric every time, but the direction should match the cue. If you make a change you think is helping and the data flatly does not move -- or moves the wrong way -- it is probably not the right change for your body, and worth trying something else rather than forcing it.",
    contentW
  );
  doc.text(trackingText, margins.left, y);
  y += trackingText.length * 4 + 6;

  y = pdfCheckPage(doc, y, 45, margins);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Why small changes add up", margins.left, y);
  y += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const smallChangesIntro = doc.splitTextToSize(
    "When a form change strengthens push-off, lengthens stride, or shifts cadence closer to your optimal range, the cumulative effect over an hour of running can be surprisingly large. Consider these examples:",
    contentW
  );
  doc.text(smallChangesIntro, margins.left, y);
  y += smallChangesIntro.length * 4 + 5;

  const boxW = (contentW - 6) / 2;
  const boxH = 22;
  const boxY = y;

  doc.setFillColor(245, 248, 252);
  doc.roundedRect(margins.left, boxY, boxW, boxH, 2, 2, "F");
  doc.setDrawColor(210, 215, 225);
  doc.setLineWidth(0.2);
  doc.roundedRect(margins.left, boxY, boxW, boxH, 2, 2, "S");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("EXAMPLE A: HIGH CADENCE RUNNER", margins.left + 4, boxY + 5);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text("Cadence: 190 to 185 spm", margins.left + 4, boxY + 11);
  doc.text("Ground contact: 230 to 225 ms", margins.left + 4, boxY + 15);

  const boxBx = margins.left + boxW + 6;
  doc.setFillColor(245, 248, 252);
  doc.roundedRect(boxBx, boxY, boxW, boxH, 2, 2, "F");
  doc.setDrawColor(210, 215, 225);
  doc.roundedRect(boxBx, boxY, boxW, boxH, 2, 2, "S");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("EXAMPLE B: LOW CADENCE RUNNER", boxBx + 4, boxY + 5);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text("Cadence: 165 to 170 spm", boxBx + 4, boxY + 11);
  doc.text("Ground contact: 250 to 230 ms", boxBx + 4, boxY + 15);

  y = boxY + boxH + 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const punchline = doc.splitTextToSize(
    "Both of these scenarios result in over 2 minutes less ground contact time per hour of running. That is 2 fewer minutes of your body needing to stabilize while the foot is planted, with load going through your muscles and tendons -- and 2 more minutes spent in the air, traveling forward without exerting force into the ground. While not a linear relationship (e.g., a 3% improvement in flight time like the examples above doesn't necessarily mean exactly 3% faster or 3% less energy used), efficiency improvements and injury risk reduction from that kind of shift can be meaningful.",
    contentW
  );
  doc.text(punchline, margins.left, y);
  y += punchline.length * 4 + 4;

  // ====== PAGES 3+: Detailed Breakdowns ======
  for (let di = 0; di < detectedIssues.length; di++) {
    const dItem = detectedIssues[di];
    const drd = dItem.reportData;
    const dsev = dItem.issueData.severity;

    y = pdfCheckPage(doc, y, 40, margins);
    if (y <= margins.top + 1) {
      // already on a fresh page
    } else if (y > margins.top + 20) {
      doc.addPage();
      pdfDrawFooter(doc, margins);
      y = margins.top;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(accentR, accentG, accentB);
    doc.text(drd.title, margins.left, y);
    const dtitleW = doc.getTextWidth(drd.title);
    pdfDrawBadge(doc, dsev, margins.left + dtitleW + 3, y);
    y += 8;

    y = pdfCheckPage(doc, y, 10, margins);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(accentR, accentG, accentB);
    doc.text("WHAT THIS MEANS", margins.left, y);
    y += 5;
    y = drawWrapped(drd.whatThisMeans, margins.left, y, contentW, 9, "normal", bodyR, bodyG, bodyB, 4);
    y += 4;

    y = pdfCheckPage(doc, y, 10, margins);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(accentR, accentG, accentB);
    doc.text("WHY IT MATTERS", margins.left, y);
    y += 5;
    y = drawWrapped(drd.whyItMatters, margins.left, y, contentW, 9, "normal", bodyR, bodyG, bodyB, 4);
    if (drd.whyItMattersRef) {
      y = pdfCheckPage(doc, y, 5, margins);
      doc.setFontSize(8);
      doc.setTextColor(accentR, accentG, accentB);
      doc.textWithLink("Source: " + drd.whyItMattersRef, margins.left, y, { url: drd.whyItMattersRef });
      y += 5;
    }
    y += 3;

    y = pdfCheckPage(doc, y, 10, margins);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(accentR, accentG, accentB);
    doc.text("WHY THIS MIGHT BE HAPPENING", margins.left, y);
    y += 5;
    y = drawBulletList(drd.possibleReasons, margins.left, y, contentW, 9);
    y += 3;

    y = pdfCheckPage(doc, y, 10, margins);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(accentR, accentG, accentB);
    doc.text("FORM CUES TO IMPROVE " + drd.title.toUpperCase(), margins.left, y);
    y += 5;
    y = drawBulletList(drd.formCues, margins.left, y, contentW, 9);
    y += 3;

    if (drd.confidence) {
      y = pdfCheckPage(doc, y, 10, margins);
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(accentR, accentG, accentB);
      doc.text("CONFIDENCE NOTE", margins.left, y);
      y += 5;
      y = drawWrapped(drd.confidence, margins.left, y, contentW, 9, "italic", mutedR, mutedG, mutedB, 4);
      y += 6;
    }
  }

  // ====== FINAL PAGE: Angle Measurements Tables (split) ======
  doc.addPage();
  pdfDrawFooter(doc, margins);
  y = margins.top;

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("Side View Measurements", margins.left, y);
  y += 7;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  const angleNote = doc.splitTextToSize(
    "Only the angles relevant for each gait phase are reported. A dash indicates the metric is not applicable for that phase.",
    contentW
  );
  doc.text(angleNote, margins.left, y);
  y += angleNote.length * 3.5 + 4;

  function pdfDrawAngleTable(tableTitle, colKeys) {
    y = pdfCheckPage(doc, y, 40, margins);

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text(tableTitle, margins.left, y);
    y += 6;

    const colLabels = colKeys.map((k) => {
      const def = PHASE_DEFS.find((d) => d.key === k);
      return def ? def.label : k;
    });

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

    const colAbbrevs = colLabels.map((l) =>
      l.replace("foot strike", "foot str.").replace("Mid-stance", "Mid-st.").replace("Peak knee flex", "Peak KF").replace("Terminal swing", "Term. swing")
    );

    doc.setFillColor(240, 240, 240);
    doc.rect(tableX, y, contentW, headerH, "F");

    doc.setDrawColor(204, 204, 204);
    doc.setLineWidth(0.2);
    doc.line(tableX, y, tableX + contentW, y);
    doc.line(tableX, y + headerH, tableX + contentW, y + headerH);

    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text("Metric", tableX + 2, y + headerH - 3);

    const colX = tableX + labelColW;
    doc.line(tableX, y, tableX, y + headerH);
    doc.line(colX, y, colX, y + headerH);
    for (let ch = 0; ch < colAbbrevs.length; ch++) {
      const cx = colX + ch * dataCellW;
      doc.line(cx, y, cx, y + headerH);
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "bold");
      const hLines = doc.splitTextToSize(colAbbrevs[ch], dataCellW - 2);
      let hTextY = y + 4;
      for (let hl = 0; hl < hLines.length; hl++) {
        doc.text(hLines[hl], cx + 1, hTextY);
        hTextY += 3;
      }
    }
    doc.line(tableX + contentW, y, tableX + contentW, y + headerH);

    y += headerH;

    for (let ri = 0; ri < activeRows.length; ri++) {
      y = pdfCheckPage(doc, y, cellH + 1, margins);
      const row = activeRows[ri];

      if (ri % 2 === 0) {
        doc.setFillColor(250, 250, 250);
        doc.rect(tableX, y, contentW, cellH, "F");
      }

      doc.setDrawColor(204, 204, 204);
      doc.setLineWidth(0.2);
      doc.line(tableX, y, tableX + contentW, y);
      doc.line(tableX, y, tableX, y + cellH);
      doc.line(tableX + labelColW, y, tableX + labelColW, y + cellH);

      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(bodyR, bodyG, bodyB);
      doc.text(row.label, tableX + 2, y + cellH - 2);

      for (let cj = 0; cj < colKeys.length; cj++) {
        const dcx = colX + cj * dataCellW;
        doc.line(dcx, y, dcx, y + cellH);

        const cpk = colKeys[cj];
        let cellText = "--";
        if (isRelevant(cpk, row.key)) {
          const cpm = phases[cpk] && phases[cpk].metrics ? phases[cpk].metrics : null;
          if (cpm && cpm[row.key] != null) {
            cellText = row.fmt(cpm[row.key]) + metricSideLabel(row.key, cpm);
          }
        }
        doc.setFontSize(8);
        doc.setFont("courier", "normal");
        doc.setTextColor(cellText === "--" ? 170 : bodyR, cellText === "--" ? 170 : bodyG, cellText === "--" ? 170 : bodyB);
        doc.text(cellText, dcx + dataCellW / 2, y + cellH - 2, { align: "center" });
      }

      doc.line(tableX + contentW, y, tableX + contentW, y + cellH);
      y += cellH;
    }

    doc.setDrawColor(204, 204, 204);
    doc.setLineWidth(0.2);
    doc.line(tableX, y, tableX + contentW, y);
    y += 6;
  }

  pdfDrawAngleTable("Side view measurements", SUMMARY_COL_ORDER);

  // ====== BELL CURVE DETAIL PAGES ======
  doc.addPage();
  pdfDrawFooter(doc, margins);
  y = margins.top;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("Angle measurements by phase", margins.left, y);
  y += 8;

  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.4);
  doc.line(margins.left, y, pageW - margins.right, y);
  y += 10;

  doc.setFillColor(245, 248, 252);
  doc.setDrawColor(210, 215, 225);
  doc.setLineWidth(0.3);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const disclaimerLines = doc.splitTextToSize(
    "The bell curves and ranges in the following pages are based on data from elite-level marathoners. Very few recreational runners will match these ranges across every metric, and that is completely normal. A value outside the elite range does not mean something is wrong or needs to be changed. Running mechanics are highly individual, and what matters most is efficiency and comfort within your own body. This data is provided for informational context only -- not as a target to chase or a diagnosis of a problem.",
    contentW - 12
  );
  const disclaimerH = disclaimerLines.length * 4.2 + 12;
  doc.roundedRect(margins.left, y, contentW, disclaimerH, 2, 2, "FD");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.setFont("helvetica", "bold");
  doc.text("A note about these reference ranges:", margins.left + 6, y + 7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text(disclaimerLines, margins.left + 6, y + 13);
  y += disclaimerH + 10;

  doc.setFillColor(255, 244, 230);
  doc.setDrawColor(245, 166, 35);
  doc.setLineWidth(0.4);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const medLines = doc.splitTextToSize(
    "This running form analysis is provided for educational and informational purposes only. It is not a medical evaluation and is not intended to diagnose, treat, cure, or prevent any disease, injury, or other health condition. The results -- including any flagged issues, joint angles, severity grades, and coaching cues -- do not constitute a medical diagnosis. Use of this tool, the report, or any related content does not create a doctor-patient or healthcare-provider relationship between you and Endurance Science Labs, its coaches, or its contributors. Always consult a qualified healthcare professional before starting a new exercise program or changing your training based on these results. Use of this tool is at your own risk.",
    contentW - 12
  );
  const medH = medLines.length * 4.2 + 12;
  doc.roundedRect(margins.left, y, contentW, medH, 2, 2, "FD");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.setFont("helvetica", "bold");
  doc.text("Not medical advice:", margins.left + 6, y + 7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text(medLines, margins.left + 6, y + 13);
  y += medH + 10;

  doc.setFillColor(255, 248, 230);
  doc.setDrawColor(245, 166, 35);
  doc.setLineWidth(0.4);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const outlierLines = doc.splitTextToSize(
    'If a measurement looks wildly out of range, first check that the right frame was picked for that phase. The most common cause of an extreme outlier is the wrong gait phase being selected (e.g. a frame partway between foot-strike and mid-stance) or a side-view frame where the runner was at an angle to the camera instead of dead-on side. Re-open that phase in the analyzer, click "Show example frames for this phase", scrub until your frame matches the helper photo as closely as possible, and click Analyze again. A clean frame almost always brings extreme values back into a sensible range.',
    contentW - 12
  );
  const outlierH = outlierLines.length * 4.2 + 12;
  doc.roundedRect(margins.left, y, contentW, outlierH, 2, 2, "FD");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.setFont("helvetica", "bold");
  doc.text("If a measurement looks wildly out of range:", margins.left + 6, y + 7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text(outlierLines, margins.left + 6, y + 13);
  y += outlierH + 10;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const bellIntro = doc.splitTextToSize(
    "The following pages show each measured angle for every analyzed gait phase, with a bell curve showing where your value falls relative to the elite reference population. The shaded band represents the reference range, and the dashed line marks your measured value.",
    contentW
  );
  doc.text(bellIntro, margins.left, y);
  y += bellIntro.length * 4 + 4;

  const sidePhaseKeys2 = SUMMARY_COL_ORDER;
  sidePhaseKeys2.forEach((pk) => {
    const phaseDef = PHASE_DEFS.find((d) => d.key === pk);
    if (!phaseDef) return;
    const phaseData = phases[pk];
    if (!phaseData || !phaseData.metrics) return;
    const pm = phaseData.metrics;

    const relevantRows = METRIC_ROWS.filter((r) => isRelevant(pk, r.key) && pm[r.key] != null);
    if (relevantRows.length === 0) return;

    doc.addPage();
    pdfDrawFooter(doc, margins);
    y = margins.top;

    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(accentR, accentG, accentB);
    doc.text(phaseDef.label, margins.left, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(mutedR, mutedG, mutedB);
    doc.text(phaseDef.desc, margins.left, y);
    y += 8;

    doc.setDrawColor(accentR, accentG, accentB);
    doc.setLineWidth(0.4);
    doc.line(margins.left, y, pageW - margins.right, y);
    y += 10;

    relevantRows.forEach((mr) => {
      const val = pm[mr.key];
      if (val == null) return;

      y = pdfCheckPage(doc, y, 52, margins);

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(bodyR, bodyG, bodyB);
      doc.text((mr.label || mr.key) + metricSideLabel(mr.key, pm), margins.left, y);

      const fmtVal = mr.fmt ? mr.fmt(val) : val.toFixed(1);
      const posLabel = positionLabel(val, mr.key, pk);
      doc.setFontSize(10);
      doc.setFont("courier", "bold");
      doc.text(fmtVal + (posLabel ? "  (" + posLabel + ")" : ""), pageW - margins.right, y, { align: "right" });
      y += 5;

      const bio = METRIC_BIO[mr.key] || "";
      if (bio) {
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(mutedR, mutedG, mutedB);
        const bioLines = doc.splitTextToSize(bio, contentW);
        doc.text(bioLines, margins.left, y);
        y += bioLines.length * 3.5 + 2;
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

      const bandLo = Math.max(toXmm(greenLo), curveX);
      const bandHi = Math.min(toXmm(greenHi), curveX + curveW);
      if (bandHi > bandLo) {
        doc.setFillColor(200, 215, 230);
        doc.rect(bandLo, y + 2, bandHi - bandLo, curveH, "F");
      }

      const curvePts = [];
      for (let ci = 0; ci <= 80; ci++) {
        const xVal = xMin + ((xRange * ci) / 80);
        const z = (xVal - curveMean) / curveSD;
        const gY = Math.exp(-0.5 * z * z);
        curvePts.push({
          px: curveX + (ci / 80) * curveW,
          py: curveBaseY - gY * curveH,
        });
      }

      doc.setFillColor(230, 235, 245);
      const stripW = curveW / 80;
      for (let si = 0; si < curvePts.length - 1; si++) {
        const stripH = curveBaseY - curvePts[si].py;
        if (stripH > 0.1) {
          doc.rect(curvePts[si].px, curvePts[si].py, stripW + 0.1, stripH, "F");
        }
      }

      doc.setDrawColor(150, 165, 185);
      doc.setLineWidth(0.35);
      for (let cl = 1; cl < curvePts.length; cl++) {
        doc.line(curvePts[cl - 1].px, curvePts[cl - 1].py, curvePts[cl].px, curvePts[cl].py);
      }

      const valXmm = Math.max(curveX, Math.min(curveX + curveW, toXmm(val)));
      doc.setDrawColor(bodyR, bodyG, bodyB);
      doc.setLineWidth(0.4);
      const dashLen = 1.2, gapLen = 0.8;
      let dashY = y + 1;
      while (dashY < curveBaseY) {
        const dashEnd = Math.min(dashY + dashLen, curveBaseY);
        doc.line(valXmm, dashY, valXmm, dashEnd);
        dashY = dashEnd + gapLen;
      }

      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(bodyR, bodyG, bodyB);
      doc.text(fmtVal, valXmm, y, { align: "center" });

      const meanXmm = toXmm(curveMean);
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(mutedR, mutedG, mutedB);
      doc.text("Elite avg", meanXmm, curveBaseY + 3.5, { align: "center" });

      doc.setDrawColor(mutedR, mutedG, mutedB);
      doc.setLineWidth(0.2);
      doc.line(meanXmm, curveBaseY - 0.5, meanXmm, curveBaseY + 0.5);

      if (bandHi > bandLo) {
        const bandCenterX = (bandLo + bandHi) / 2;
        doc.setFontSize(6);
        doc.setTextColor(140, 155, 175);
        doc.text("Reference range", bandCenterX, curveBaseY + 7, { align: "center" });
      }

      y = curveBaseY + 12;

      doc.setDrawColor(230, 230, 230);
      doc.setLineWidth(0.15);
      doc.line(margins.left + 10, y, pageW - margins.right - 10, y);
      y += 8;
    });
  });

  // ====== Update all page footers with total page count ======
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(119, 119, 119);
    doc.setFillColor(255, 255, 255);
    doc.rect(pageW - margins.right - 30, pageH - 11, 30, 6, "F");
    doc.text("Page " + p + " of " + totalPages, pageW - margins.right, pageH - 8, { align: "right" });
  }

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { renderReport };
