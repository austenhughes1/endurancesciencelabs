# Dynamic Knee Valgus from 2D Video: A Literature-Supported Measurement Framework

## Four things called "knee valgus" — know which one you're measuring

Any framework for knee valgus has to start here, because these four constructs give different numbers and carry different clinical meanings:

**a) Frontal Plane Projection Angle (FPPA).** A 2D angle measured from a single posterior or anterior video frame, using a proximal landmark (ASIS or mid-thigh), the knee center, and a distal landmark (mid-ankle). This is what a clinician or coach actually measures from video. It is fundamentally a *projected* angle of the whole lower limb segment, not a joint-specific rotation.

**b) 3D knee abduction/adduction angle.** The true frontal-plane rotation of the tibia relative to the femur, calculated from 3D motion capture. In healthy running, the adduction/abduction range of motion is small (often only a few degrees) — smaller than the range seen in walking (Zhang et al., 2020, Sports Biomechanics).

**c) Hip adduction angle.** The thigh moving toward the midline relative to the pelvis. Powers (2010) and a long body of running-injury literature argue this is the *dominant driver* of what clinicians visually call "knee valgus" during running. When a 2D FPPA looks valgus, most of that apparent valgus comes from hip adduction, some from contralateral pelvic drop, and only a small portion from true tibiofemoral abduction (Willson & Davis 2008, JOSPT; Maykut et al. 2015, IJSPT).

**d) Knee abduction moment (KAM).** A *kinetic* variable — the external moment tending to abduct the knee, in N·m or N·m/kg — not an angle. KAM is the variable prospectively tied to ACL injury risk in the landmark Hewett et al. (2005) study of female drop-jump landings (n = 205 uninjured vs 9 subsequent ACL injuries; sensitivity 78%, specificity 73%). **KAM cannot be measured from an angle and cannot be estimated from a 2D video screenshot.** If you need KAM, you need 3D motion capture with force plates. An angle-based screen is simply the wrong tool for that question.

The ranges and cutoffs below are given separately for FPPA and for 3D knee abduction. Most of the famous thresholds in the literature come from single-leg squat (SLS), single-leg landing (SLL), or drop-vertical-jump (DVJ) tasks, not running. Those task-specific numbers are reported here *with* the task flagged, and are **not transferred** into the running table — SLS and DVJ involve much greater knee flexion, very different loading, and different neuromuscular demands than running.

---

## 1. Measurement Protocol for 2D FPPA from Running Video

### 1.1 Anatomical landmarks

The "classic" FPPA method, established by Willson & Davis (2008, JOSPT) and replicated by many groups since (Munro et al., Herrington, Gwynne & Curran):

- **Proximal landmark: ASIS** (anterior superior iliac spine) — preferred when filming anteriorly. On a posterior-view video, use the mid-point between the greater trochanter and the iliac crest, or the mid-thigh, depending on visibility.
- **Knee landmark: midpoint of femoral condyles** (center of the knee joint). Approximates the radiographic joint center. On posterior view, use the midpoint of the popliteal crease. Center of the patella is a common alternative on anterior view.
- **Distal landmark: midpoint of the malleoli** (center of the ankle joint). On posterior view, center of the Achilles tendon at ankle height.

**Landmark choice changes the angle.** This is a real, measurable source of disagreement:
- ASIS-based FPPA tends to be larger than mid-thigh-based FPPA, because the ASIS moves contralaterally during pelvic drop, which *adds* hip-adduction/pelvic-drop contributions into the angle. This is not a bug — it's why 2D FPPA correlates more strongly with *hip* kinematics than with *knee* kinematics (Willson & Davis 2008: FPPA during SLS reflected only 23–30% of the variance in 3D knee kinematics but correlated r = 0.32–0.55 with hip adduction and knee external rotation).
- Mid-thigh-based FPPA isolates the thigh-shank relationship slightly better but still cannot resolve true tibiofemoral rotation.
- **Pick one method and use it consistently.** Mixing ASIS- and mid-thigh-based measurements across sessions will introduce several degrees of bias that looks like a real change.

**Finding landmarks on a clothed runner:**
- ASIS: locate the bony prominence ~2 fingerbreadths below and medial to the iliac crest. Compression shorts / tight waistband help; loose shirts are the main obstacle.
- Knee center: easier to see from the front (patella center) than from the back. Use tight-fitting shorts so the thigh-shank interface is visible.
- Ankle center: midway between medial and lateral malleoli; with shoes, use the midpoint of the ankle at sock height. Shoes with high collars obscure this; be consistent.

Marking ASIS, knee center, and ankle center with tape dots *before* filming improves reliability substantially (Olsen & Karlsson; Herrington 2014 methods).

### 1.2 Frame selection — identifying peak knee flexion during stance

The FPPA literature consistently samples at **peak knee flexion during stance**, which in running occurs around midstance. Method:

1. Scroll frame-by-frame through the stance phase of the limb of interest.
2. Find the frame where the stance-leg knee is most flexed (visually the shortest vertical distance between hip and ankle markers on that side).
3. Measure FPPA at that frame. Repeat for 3–5 stance phases per side and report the mean (and asymmetry).

**Running peak knee flexion is much less than in single-leg squat or drop-jump tasks.** In running it's typically ~40–45° (An Evidence-Based Videotaped Running Biomechanics Analysis, Souza 2016). In SLS it is explicitly set to 45° or 60° by protocol. In DVJ it can exceed 80°. This is why cutoffs don't transfer: the amount of knee flexion dictates the geometric opportunity for the limb to drift into valgus.

### 1.3 Camera view and setup

- **View: posterior is the default for running gait analysis**, because posterior view shows the knee window, popliteal crease orientation, and stance-limb alignment with less occlusion from contralateral leg swing than the anterior view. However, the majority of published FPPA validation studies use the **anterior view** with ASIS as the proximal landmark. Pick one per the literature you're benchmarking against; do not mix.
- Anterior view is better for visualizing patellar tracking and the ASIS marker.
- Posterior view is better for simultaneous visualization of contralateral pelvic drop and knee alignment, which is why it's the standard in running-injury clinical protocols (IJSPT 2022 implementation study).
- **Camera height:** lens at the height of the runner's knee during midstance (roughly 50–60 cm above the treadmill belt for most adults). A camera that is too high or too low systematically biases the measured angle.
- **Distance:** 2–5 m from the runner; far enough that the full lower limb stays in frame across stance.
- **Level:** tripod-mounted with verified level (phone built-in level is sufficient). Camera roll of 1° = ~1° of FPPA bias on every frame.
- **Frame rate:** 60 fps minimum; 120–240 fps preferred. Running stance lasts ~200–250 ms and peak knee flexion occupies only a narrow window.
- **Runner position:** centered on the treadmill, running in line with the camera. Drift toward one side creates parallax that inflates apparent valgus on that side.

**How framing errors bias the angle:**
- Camera rolled → constant bias in one direction.
- Camera too high or too low → foreshortens the limb vertically, which non-linearly shifts the FPPA (usually toward greater apparent varus when camera is low, greater apparent valgus when camera is high).
- Runner drifting laterally → parallax inflates FPPA on the drift side.
- Runner's pelvic rotation (transverse-plane rotation during running) → projects out-of-plane motion into the 2D frontal plane. This is the single largest source of 2D/3D discrepancy and cannot be fully controlled.

### 1.4 Sign convention

Reported with the Willson & Davis (2008) convention to match the running-injury literature:

- **Positive FPPA = valgus** (knee center medial to the hip–ankle line).
- **Negative FPPA = varus** (knee center lateral to the hip–ankle line).
- **Zero = knee center on the hip–ankle line.**

Note: some papers (including the original Willson & Davis methods section) defined the sign in the opposite direction. Always state the convention in your report; don't assume.

**Construction:**
1. Mark hip landmark, knee center, ankle center on the peak-knee-flexion frame.
2. Draw a line from hip landmark to ankle center (the "reference line").
3. Draw a line from hip landmark through knee center (or use hip→knee and knee→ankle as the two segments).
4. Angle = 180° − (angle between thigh segment and shank segment), or equivalently the angle of knee-center deviation from the hip–ankle line. Software like Kinovea, Dartfish, or Hudl Technique computes this directly if you place three points.

### 1.5 Error sources — 2D FPPA vs 3D knee abduction

This is the biggest caveat in the framework and it applies to every number below.

**Reliability (agreement between repeated 2D measurements):** Generally good.
- Willson & Davis (2008): within-day ICC = 0.88 for SLS.
- Munro et al. (2012): ICC 0.59–0.88 across tasks, including 0.59 for female SLS.
- Herrington (2014): ICC = 0.72 for SLS FPPA.
- Gwynne & Curran (2014): within-session ICC 0.86, between-session 0.74–0.78 for SLS.
- Technique tablet app (2022): ICC 0.994–0.998 for step-down, SEM 0.44–0.84°.
- Running-specific 2D FPPA (Maykut et al. 2015 analogue, knee abduction angle): intra-rater ICC 0.955–0.976.

**Validity (agreement with 3D gold standard):** Mixed and task-dependent.
- Willson & Davis (2008): 2D FPPA during SLS explained only 23–30% of variance in 3D knee kinematics; correlated more strongly with hip adduction (r = 0.32–0.38) and knee external rotation (r = 0.48–0.55) than with knee abduction itself.
- Munro et al. (2012, Int J Sports Phys Ther): 2D FPPA is reliable but is a *composite* driven primarily by hip motion.
- IJSPT 2022 comprehensive validity study (39 athletes, 6 tasks): FPPA predicts *frontal-plane knee moments* (kinetics) better than it predicts *frontal-plane knee kinematics*, with only weak-to-moderate prediction strength, and task-dependent.
- Sorenson et al. / 2018 reliability & validity review: FPPA shows large correlation with hip adduction (r ≈ −0.51 to 0.53) but only moderate correlation with knee abduction in males (r ≈ 0.43), and weaker in females.
- Multi-directional cutting validation (IJSPT 2022): 2D vs 3D correlation r = 0.45–0.78 depending on cut angle, with 30° cut showing no significant correlation.

**The bottom line: 2D FPPA during running is mostly a measure of combined hip adduction + pelvic drop + tibial motion projected onto the frontal plane. It is a reasonable composite screen for "medial knee collapse" and tracks well with frontal-plane knee *loading*, but it is not an accurate measurement of the true tibiofemoral abduction angle.** Treat any single FPPA value as carrying ±3–5° of uncertainty relative to 3D truth, and larger when camera setup is imperfect.

**Practical implications:**
- Interpret FPPA alongside contralateral pelvic drop and hip adduction, not alone. Powers' framework (2010, JOSPT) treats visible "knee valgus" in runners as the downstream expression of proximal mechanics.
- Track *changes within a runner across sessions* more confidently than absolute cutoffs across runners.
- Do not report 2D FPPA to the nearest tenth of a degree — the underlying uncertainty doesn't support that precision. Report to the nearest degree.

---

## 2. Literature-Supported Ranges

### 2.1 FPPA during running (2D video)

Running-specific FPPA data are sparse compared to SLS/DVJ data. The most useful running numbers:

- **Maykut et al. (2015), IJSPT** — 24 healthy collegiate cross-country runners, 2D video + 3D capture. Used peak knee abduction angle (KABD), measured with the same landmark approach as FPPA but at the knee center. Reported excellent intra-rater reliability (ICC 0.955–0.976). Group means for healthy runners were modest — peak KABD in the few-degree range. No significant 2D-vs-3D correlation for CPD, but moderate for HADD (r = 0.54–0.62).
- **Running cadence & frontal plane knee deviation study (2024, Clinics & Practice)** — 10 asymptomatic recreational runners, 2D posterior video at midstance. Baseline peak knee valgus averaged **~4.5° ± ~1.5°** at preferred cadence, dropping to **~2.4° ± ~1.1°** at +10% cadence. Values were similar left and right. This is a small sample but the setup (posterior view, midstance, Dartfish) is typical of what a clinician would do.
- **Bramah et al. (2018, AJSM)** injured vs healthy 3D kinematics — injured runners showed greater hip adduction and pelvic drop but peak knee abduction itself was not the headline variable. The "visible valgus" signal was dominated by the proximal contributions.

**A defensible running-specific FPPA range:**
- Uninjured recreational runners at self-selected treadmill speed: **peak FPPA typically 2–6°** at midstance, with symmetry between sides usually within ~2°.
- Running FPPA is much lower than SLS or landing FPPA because running involves less knee flexion and a shorter stance.

**Where the evidence is weakest:** there is no large-sample prospective study that has established a specific running FPPA cutoff for injury risk. The cross-sectional evidence linking visible "knee valgus" to PFP, ITBS, and MTSS in runners is mostly via elevated hip adduction and pelvic drop rather than via directly measured elevated 2D FPPA during running.

### 2.2 3D knee abduction angle during running

- **Healthy recreational runners:** peak knee abduction angle during stance is typically small, commonly **2–6°**, and often the knee is briefly *adducted* (varus) at initial contact before moving into slight abduction during loading.
- **PFP runners:** some studies show greater peak knee valgus angle in PFP vs controls during running (e.g., trunk/pelvis/knee running kinematics study in females with PFP, Gait & Posture 2021, found significantly greater knee frontal-plane range of motion in PFP runners, but peak values did not always differ). Results are inconsistent across studies and are more dependent on study methodology than on a clean, reproducible threshold.
- **ITBS runners:** more consistently show greater hip adduction than greater knee abduction. The knee's frontal-plane motion is downstream of hip adduction.
- A 2022 musculoskeletal-simulation study (Applied Sciences) reported female PFP runners with peak hip adduction of 11.3° vs 7.6° in male PFP, but knee abduction angle differences between PFP and controls were small and variable.

**A defensible range for 3D peak knee abduction during running in uninjured adult recreational runners: ~0–6°.** Values above ~8° in running (not landing) are uncommon in healthy cohorts and are worth investigating in context.

### 2.3 FPPA during single-leg squat (for context only — NOT to be used to screen running)

Included here because SLS/DVJ thresholds are frequently (mis-)cited in running contexts, and you should know the actual numbers to avoid misapplying them.

- **Herrington (2014), *The Knee*, n = 12 female unilateral PFP + 30 female controls:**
 - Control SLS: FPPA **8.4° ± 5.1°** (range 2.5–20.5°).
 - Control single-leg landing (SLL): FPPA **13.5° ± 5.7°**.
 - PFP SLS: FPPA **16.8° ± 5.4°**.
 - PFP SLL: FPPA **21.7° ± 3.6°**.
 - Differences between groups were significant for both tasks (p < 0.01).
- **Munro et al. (2012), Int J Sports Phys Ther**, the most commonly cited classification:
 - **Normal DKV in female athletes: FPPA 7–13°** during DVJ / SLS.
 - **Excessive DKV: FPPA > 13°**.
 - This classification is widely used in subsequent literature (e.g., the 2022 Malaysian JMHS study used Munro's cutoff to define groups).
- **Dawson & Herrington**: 6-week glute-strength or mirror-biofeedback training reduced SLS FPPA from 12.76° ± 4.44° to 7.28° ± 5.10° (strength group) and from 13.34° ± 4.46° to 8.81° ± 4.22° (skill group).

**Important:** the Munro 7–13° normal / >13° excessive classification is for **SLS and DVJ**, not running. Running FPPAs in uninjured runners commonly sit *below* the lower bound of Munro's "normal" (i.e., 2–6°). Applying the >13° threshold to running would miss virtually all runners with clinically meaningful valgus.

### 2.4 Hewett KAM ACL threshold — what it actually means and where it doesn't apply

- **Hewett et al. (2005), Am J Sports Med** — 205 uninjured high school female athletes, prospective; 9 went on to sustain non-contact ACL injuries. Peak knee abduction moment during drop-vertical-jump landing was significantly higher in future-injured. Sensitivity 78%, specificity 73% at the classification threshold.
- Subsequent prospective work has been mixed. Krosshaug et al. (2016) and Leppänen et al. (2017) did not replicate the KAM-ACL prediction; a 2020 meta-analysis (Cronström) contested the single-variable prediction.
- Clinical trial thresholds based on the Hewett framework (e.g., KAM > 25.25 Nm during drop jump in the Mechanical Perturbation Training trial) are tied specifically to DVJ landing, not running.

**Applicability to running:** KAM in running is much lower and serves a different biomechanical role than KAM in landing. **The Hewett 2005 drop-jump KAM threshold does not transfer to running.** ACL injuries in runners are rare and not primarily driven by steady-state running kinematics. Use KAM thresholds only for the tasks they were derived for.

### 2.5 Problematic / injury-associated ranges (running)

Because running-specific prospective thresholds are weak, the most defensible approach is:

- **Elevated peak running FPPA (~6–10°)** in a symptomatic runner with PFP, ITBS, or MTSS is consistent with cross-sectional injured-group profiles and is worth intervening on, especially when paired with elevated contralateral pelvic drop (>10°) and/or elevated hip adduction.
- **Peak running FPPA >10°** is uncommon in uninjured runners and generally indicates meaningful medial knee collapse. It does not, by itself, diagnose any specific injury.
- **Asymmetry ≥3° L vs R** in FPPA is clinically meaningful regardless of absolute magnitude, particularly if it aligns with a symptomatic side.

**Injury-specific notes:**
- **PFPS:** cross-sectional studies are inconsistent on whether peak knee valgus angle is greater during running. Hip adduction and hip internal rotation are more consistently elevated. The 2022 Applied Sciences simulation study found greater contralateral pelvic drop ROM and greater hip adduction in female PFP runners. Willson & Davis (2008) found FPPA during SLS was greater in PFP than controls by ~1.6°.
- **ITBS:** greater hip adduction during running stance is the most consistent finding (Ferber, Noehren). Peak knee abduction itself is less specifically elevated in ITBS.
- **Tibial stress injury/fracture:** more strongly linked to impact loading rates and reduced pelvic transverse-plane rotation than to peak knee valgus.
- **ACL injury:** vanishingly rare in steady-state running; KAM during cutting and landing, not running FPPA, is the relevant variable.

---

## 3. Modifiers and Caveats

### 3.1 Sex

Females run with greater mean FPPA than males at the same speeds and during the same tasks. They also show greater hip adduction, greater pelvic drop, and a ~2–4× higher prevalence of PFP and ACL injury. In SLS studies (Nakagawa et al. 2012, JOSPT, n = 80), females showed significantly greater knee abduction than males (mean difference 3.9°). This means:

- A 5° running FPPA in a male may be atypical, while the same 5° in a female is near the population mean. Do not apply male-derived thresholds to females or vice versa without stating the source population.

### 3.2 Running speed

Faster running increases peak ground reaction forces and generally tends to increase frontal-plane motion at the hip and pelvis (Chumanov et al.; Frontiers in Sports & Active Living, 2025, female cohort). Standardize speed across comparisons.

### 3.3 Fatigue

Fatigue generally increases pelvic drop, hip adduction, and downstream knee valgus, with effects that are more pronounced on one side in many runners. Post-run or late-run videos will show greater FPPA than fresh-state videos.

### 3.4 Cadence

Increasing cadence by 5–10% is one of the most robustly supported interventions for reducing running FPPA:
- A 2024 study showed +10% cadence reduced peak knee valgus from ~4.5° to ~2.4° (a ~2° reduction, both sides).
- Peterson et al. (2024) reported ~2° reduction in dynamic valgus with +10% cadence under laboratory conditions.
- A 2022 systematic review and meta-analysis (Anderson et al., Sports Med Open) concluded that increased step rate reduces peak hip adduction and peak knee flexion, with small but consistent effects on frontal-plane variables.

### 3.5 Footwear and surface

Stability shoes can modestly alter rearfoot and tibial kinematics, which indirectly affects knee FPPA, but published effects on peak running FPPA specifically are small. Minimalist/barefoot running and harder surfaces generally increase loading rates more than they change FPPA. Do not expect shoe changes alone to produce meaningful FPPA changes in most runners.

### 3.6 Novice vs trained vs elite runners

Most published FPPA thresholds come from collegiate or recreational runners aged 18–40. Novices show higher FPPA on average with poorer motor control; elites can show surprisingly low FPPA despite large training volumes. Some elite runners also show elevated FPPA without injury — confirming that FPPA alone is not sufficient to stratify risk.

### 3.7 Validated scoring systems and cutoffs — with their original populations

| Threshold | Task | Source population | Value | Notes |
|---|---|---|---|---|
| Munro 7–13° normal / >13° excessive | DVJ + SLS | Female athletes | FPPA | **Not for running** — SLS/DVJ involves much more knee flexion |
| Herrington PFP vs control | SLS & SLL | Female unilateral PFP | SLS: 16.8° PFP vs 8.4° control; SLL: 21.7° vs 13.5° | **Not for running** |
| Hewett KAM ACL threshold | DVJ landing | Female high-school athletes | Peak KAM, threshold varies by study | **Not for running** — different task, different loading |
| Powers "medial knee collapse" clinical observation | Running + functional | Mixed | Qualitative | Used in combination with hip/pelvis screens |
| ~5° "notable" running FPPA rule of thumb | Running | Clinical convention | Peak FPPA | Heuristic — over-flags; use with symptoms/context |

### 3.8 Confidence levels

- **Strong evidence:** 2D FPPA is reliable between repeated measurements of the same video/session.
- **Strong evidence:** 2D FPPA correlates with hip adduction more strongly than with true knee abduction.
- **Moderate evidence:** Elevated dynamic valgus (visible medial knee collapse) is associated with PFP and ITBS in runners, primarily via hip adduction/pelvic drop.
- **Weak evidence:** Specific running-FPPA numerical cutoffs for injury risk or diagnosis.
- **Weak evidence:** 2D FPPA absolute value equals 3D knee abduction; they don't.
- **Inappropriate transfer:** Using DVJ KAM thresholds (Hewett 2005) or SLS FPPA thresholds (Munro, Herrington) to screen running videos. These are different tasks with different geometry.

### 3.9 Interpret FPPA alongside hip adduction and pelvic drop, not alone

This is the central operational point from the Powers (2010) body of work: visible knee valgus in a runner is almost always a downstream expression of proximal control. The right clinical package is:

1. Peak contralateral pelvic drop (from the hip-drop framework).
2. Hip adduction (estimated from the same posterior-view video if the thigh segment is visible).
3. Knee FPPA at peak knee flexion.
4. Foot/ankle behavior (rearfoot eversion, pronation).

A runner with 12° pelvic drop, 15° hip adduction, and 6° knee FPPA has a clear proximal problem that will not respond to "knee strengthening" but to hip and core work. A runner with 3° pelvic drop, 6° hip adduction, and 8° FPPA may have a distal contributor (foot/ankle) worth investigating.

---

## 4. Quick-Reference Tables

### Table A — 2D FPPA during running (posterior view, peak knee flexion at midstance)

| Peak running FPPA | Category | Interpretation | Associated injuries (if elevated alongside hip/pelvis findings) | Key citations |
|---|---|---|---|---|
| ≤3° | Well-controlled | Typical of uninjured recreational runners at comfortable pace | — | 2024 cadence-valgus study baseline ~4.5°; Maykut 2015 healthy runners |
| 3–6° | Within normal range | Most uninjured runners sit here; females and higher speeds trend toward the upper end | — | Willson & Davis 2008 context; Bramah 2018 healthy group |
| 6–10° | Elevated, monitor | Above healthy mean; consider retraining if other proximal risk factors (pelvic drop, hip adduction) or symptoms are present | Overlap with injured distributions for PFP, ITBS, MTSS | Bramah 2018; Dingenen 2019 |
| >10° | Problematic | Uncommon in uninjured runners; warrants proximal retraining, hip strengthening, and/or cadence manipulation | PFP, ITBS, MTSS, sometimes gluteal tendinopathy | Bramah 2018; Powers 2010 framework; running cadence literature |
| Asymmetry ≥3° L vs R | Clinically notable regardless of magnitude | Often reflects unilateral hip/core weakness or prior injury | Any of the above on the higher-FPPA side | Clinical consensus |

### Table B — 3D peak knee abduction angle during running (gold standard)

| Peak 3D knee abduction | Category | Interpretation | Key citations |
|---|---|---|---|
| 0–3° | Well-controlled | Typical of uninjured runners | Zhang et al. 2020; general 3D running kinematics |
| 3–6° | Within normal range | Common in healthy recreational runners | Maykut 2015; Noehren et al. 2012 |
| 6–10° | Elevated | Less common in uninjured cohorts; evaluate alongside hip kinematics | Willson & Davis 2008 (SLS data); PFP running studies |
| >10° | Uncommon/problematic | Warrants full kinematic workup; often coexists with elevated hip adduction | Applied Sciences 2022 musculoskeletal simulation; Gait & Posture 2021 |

### Table C — SLS FPPA thresholds (for the SLS test, NOT for running video)

| SLS FPPA | Category | Source | Associated conditions |
|---|---|---|---|
| <7° | Below "normal" range | Munro et al. 2012 | — |
| 7–13° | Normal DKV | Munro et al. 2012 | Control means ~8.4° in Herrington 2014 |
| >13° | Excessive DKV | Munro et al. 2012 | PFP means ~16.8° (Herrington 2014); female ACL risk patterns |
| >16° | Markedly elevated | Herrington 2014 | Aligns with female PFP group mean |

**Reminders when using these tables:**
1. The running FPPA table (A) is the one to apply to a posterior-view running video screenshot at peak knee flexion during stance.
2. The SLS table (C) is a related but distinct clinical test; don't compare a running FPPA value to Munro's thresholds.
3. 2D FPPA is a *composite* driven by hip adduction, pelvic drop, tibial motion, and a small portion of true knee abduction. Always interpret alongside a pelvic drop measurement and a hip adduction estimate — the accompanying hip drop framework covers those.
4. Absolute numerical thresholds in running are not prospectively validated; use them as flags, not diagnoses.
5. Do not transfer Hewett (2005) drop-jump KAM thresholds to running — KAM is a moment, not an angle, and requires 3D motion capture with force plates.

---

## Primary References

- Willson JD, Davis IS. Utility of the frontal plane projection angle in females with patellofemoral pain. *J Orthop Sports Phys Ther.* 2008;38(10):606–615.
- Willson JD, Davis IS. Lower extremity mechanics of females with and without patellofemoral pain across activities with progressively greater task demands. *Clin Biomech.* 2008;23(2):203–211.
- Hewett TE, Myer GD, Ford KR, et al. Biomechanical measures of neuromuscular control and valgus loading of the knee predict anterior cruciate ligament injury risk in female athletes: a prospective study. *Am J Sports Med.* 2005;33(4):492–501.
- Munro A, Herrington L, Carolan M. Reliability of 2-dimensional video assessment of frontal-plane dynamic knee valgus during common athletic screening tasks. *J Sport Rehabil.* 2012;21(1):7–11.
- Herrington L. Knee valgus angle during single leg squat and landing in patellofemoral pain patients and controls. *Knee.* 2014;21(2):514–517.
- Powers CM. The influence of abnormal hip mechanics on knee injury: a biomechanical perspective. *J Orthop Sports Phys Ther.* 2010;40(2):42–51.
- Nakagawa TH, Moriya ETU, Maciel CD, Serrão FV. Trunk, pelvis, hip, and knee kinematics, hip strength, and gluteal muscle activation during a single-leg squat in males and females with and without patellofemoral pain syndrome. *J Orthop Sports Phys Ther.* 2012;42(6):491–501.
- Maykut JN, Taylor-Haas JA, Paterno MV, DiCesare CA, Ford KR. Concurrent validity and reliability of 2D kinematic analysis of frontal plane motion during running. *Int J Sports Phys Ther.* 2015;10(2):136–146.
- Noehren B, Pohl MB, Sanchez Z, Cunningham T, Lattermann C. Proximal and distal kinematics in female runners with patellofemoral pain. *Clin Biomech.* 2012;27(4):366–371.
- Noehren B, Hamill J, Davis I. Prospective evidence for a hip etiology in patellofemoral pain. *Med Sci Sports Exerc.* 2013;45(6):1120–1124.
- Dierks TA, Manal KT, Hamill J, Davis IS. Proximal and distal influences on hip and knee kinematics in runners with patellofemoral pain during a prolonged run. *J Orthop Sports Phys Ther.* 2008.
- Bramah C, Preece SJ, Gill N, Herrington L. Is There a Pathological Gait Associated With Common Soft Tissue Running Injuries? *Am J Sports Med.* 2018;46(12):3023–3031.
- Dingenen B, Malliaras P, Janssen T, Ceyssens L, Vanelderen R, Barton CJ. Two-dimensional video analysis can discriminate differences in running kinematics between recreational runners with and without running-related knee injury. *Phys Ther Sport.* 2019;38:184–191.
- Boling M, Padua D, Marshall S, Guskiewicz K, Pyne S, Beutler A. Gender differences in the incidence and prevalence of patellofemoral pain syndrome. *Scand J Med Sci Sports.* 2010.
- Myer GD, Ford KR, Hewett TE. Rationale and clinical techniques for anterior cruciate ligament injury prevention among female athletes. *J Athl Train.* 2004;39(4):352–364.
- Souza RB. An evidence-based videotaped running biomechanics analysis. *Phys Med Rehabil Clin N Am.* 2016.
- Anderson LM, Martin JF, Barton CJ, Bonanno DR. What is the effect of changing running step rate on injury, performance and biomechanics? A systematic review and meta-analysis. *Sports Med Open.* 2022;8:112.
- Heiderscheit BC, Chumanov ES, Michalski MP, Wille CM, Ryan MB. Effects of step rate manipulation on joint mechanics during running. *Med Sci Sports Exerc.* 2011;43(2):296–302.
- Willy RW, Scholz JP, Davis IS. Mirror gait retraining for the treatment of patellofemoral pain in female runners. *Clin Biomech.* 2012;27(10):1045–1051.
- Krosshaug T, Steffen K, Kristianslund E, et al. The vertical drop jump is a poor screening test for ACL injuries in female elite soccer and handball players: a prospective cohort study of 710 athletes. *Am J Sports Med.* 2016;44(4):874–883.
- Cronström A, Creaby MW, Ageberg E. Do knee abduction kinematics and kinetics predict future anterior cruciate ligament injury risk? A systematic review and meta-analysis of prospective studies. *BMC Musculoskelet Disord.* 2020.
