# Contralateral Pelvic Drop (Hip Drop) from 2D Video: A Literature-Supported Measurement Framework

## 1. Measurement Protocol

### 1.1 Anatomical landmarks

Contralateral pelvic drop (CPD) is a frontal-plane angle that describes obliquity of the pelvis relative to horizontal at midstance. In 3D motion capture studies (including Bramah et al., 2018, AJSM), the pelvis segment is typically defined by markers on the bilateral ASIS and PSIS. For 2D video analysis from the **posterior** view, the most commonly used surface landmarks are:

- **Primary: bilateral PSIS** (posterior superior iliac spines). These are the most reliable posterior-view landmarks and are the ones used in most 2D clinical running assessments, e.g., the implementation protocol described by a US orthopedic PT clinic network (IJSPT, 2022), which placed markers on C7, bilateral PSIS, greater trochanters, lateral knee joint lines, lateral malleoli, and heel counters.
- **Secondary: bilateral iliac crests** (most superior aspect). Used in many 3D validation studies (e.g., the ijspt.scholasticahq.com validity study, 2022) but harder to see clearly on a clothed runner from behind.

**Finding PSIS on a clothed runner.** The PSIS sits under the "dimples of Venus" at roughly the S2 level. The most accurate workflow is:
1. Have the runner stand still, camera on, and ideally mark the PSIS with tape or dots before running. If that isn't possible:
2. Identify the superior margin of the sacrum at the midline, then move laterally ~3–4 cm bilaterally.
3. Cross-check with the iliac crest line (top edge of the pelvis) — the PSIS line should be roughly parallel to it in a level standing frame.
4. Clothing bias: compression shorts or a tight waistband is best. A loose waistband of shorts or a fanny pack is a common confounder — the waistband is **not** a pelvic landmark; it tilts with shorts ride-up and will bias the angle.

If you cannot see the PSIS at all (loose top hanging over the pelvis), the measurement should be flagged as unreliable rather than improvised from the shirt hem or the top of the shorts.

### 1.2 Frame selection — identifying midstance

Peak CPD occurs at or very near **midstance** of the stance limb, which is the kinematic event virtually all injury literature references (Bramah et al., 2018; Noehren et al., 2012; Willson & Davis, 2008).

Operational definitions of midstance from 2D video in descending order of practicality:

1. **Peak knee flexion of the stance limb during stance** — the standard surrogate in 2D clinical analysis (used in the 2022 IJSPT validity study and the Dingenen 2D validation work).
2. **Tibia vertical** — the moment the tibia of the stance leg is perpendicular to the ground. This is simple to score from the sagittal view but approximate from posterior.
3. **Swing-leg passing the stance leg** — the swing thigh crosses vertical past the stance thigh. Useful when you only have the posterior view.

On a 30–60 fps phone recording, you will typically have 2–4 candidate frames per stance; pick the one where the stance leg is most vertical and the swing thigh is just past it. Measure both left and right stance phases across at least 3–5 steps per side and average.

### 1.3 Camera view and setup

The reference setup across nearly all 2D clinical protocols (e.g., the IJSPT 2022 implementation paper; Maykut et al., 2015; Dingenen et al., 2018):

- **View:** Posterior frontal plane, camera directly behind the runner.
- **Height:** Camera lens at mid-pelvis height (roughly ASIS/PSIS height). A camera that is too high or too low introduces vertical perspective error in the frontal plane.
- **Distance:** Far enough that the full pelvis and lower limbs stay in frame throughout stance, typically 3–5 m on a treadmill.
- **Level:** Camera must be **level** in roll (use the phone's built-in level or a tripod bubble). Any roll of the camera adds a constant bias to every CPD measurement. A 2° camera roll *is* a 2° CPD error.
- **Framing:** The runner must stay centered laterally. When the runner drifts toward one edge of the treadmill, parallax artificially inflates pelvic obliquity on that side.
- **Frame rate:** 60 fps minimum; 120–240 fps is preferable because stance is only ~200–250 ms and low frame rate aliasing often causes you to "miss" true midstance by several degrees.

**Framing errors and their direction of bias:**
- Camera tilted (rolled) left → every frame shows artificial left pelvic drop by the same amount.
- Camera too low, tilted up → foreshortens the pelvis and exaggerates obliquity non-linearly.
- Runner off-center on treadmill → parallax inflates apparent pelvic drop on the side the runner has drifted toward.
- Runner's rotation (transverse-plane pelvis rotation during running) → projects the true 3D pelvic tilt onto the 2D frontal plane, which is the single largest source of 2D/3D disagreement in the literature.

### 1.4 Angle construction and sign convention

1. On the chosen midstance frame, mark the two PSIS points (or iliac crest points).
2. Draw a line through both points — this is the **pelvis line**.
3. Draw a second line that is **horizontal** in the image (parallel to the ground, not to the treadmill handrail unless you've verified the handrail is level and the camera isn't rolled).
4. Measure the angle between the pelvis line and the horizontal reference.

**Sign convention used here (matches Bramah et al., 2018 and most running literature):**
- **Positive CPD = the swing-side (non-stance, non-weight-bearing) hemi-pelvis drops below horizontal.**
- A value of 0° means a perfectly level pelvis at midstance.
- Report each stance separately: e.g., "Right-stance CPD = 7°" means the left (swing) side dropped 7° during right-foot stance. Report left and right separately; do not average across sides because asymmetry itself is clinically meaningful.

Software options that give consistent angle measurement: Kinovea (free, used in the 2024 MTSS RCT and the 2025 IJSPT reliability study), Dartfish, Hudl Technique, CoachNow, or Ochy.

### 1.5 Error sources — 2D video vs. 3D motion capture

This is the single most important caveat in the whole framework. **2D posterior-view CPD is reliable between repeated measures of the same video, but its agreement with 3D motion capture of the same run is mixed.**

Key findings from the validation literature:

- **Dingenen et al. (2018)** reported excellent intra- and inter-rater reliability (ICC 0.90–0.99) for 2D CPD and hip adduction during running, and significant relationships with 3D kinematic profiles — generally taken as the most favorable evidence for 2D clinical use.
- **Maykut et al. (2015), IJSPT**, studied 24 collegiate cross-country runners. 2D intra-rater reliability was excellent for CPD (ICC 0.958–0.966), but **no statistically significant correlation was found between 2D and 3D CPD**. 2D CPD instead correlated strongly with 2D hip adduction (r = 0.75–0.80), suggesting the 2D "CPD" angle is partly picking up thigh adduction rather than pelvis motion alone.
- A 2022 IJSPT validity study of 2D vs 3D frontal-plane pelvis angles across athletic tasks found Pearson correlations r = 0.54–0.73 but Bland-Altman 95% limits of agreement as wide as about ±17° on some tasks — meaning two valid measurement systems can disagree by more than 10° on a single trial.
- A 2025 IJSPT reliability study of **categorical** 2D visual rating (33 amateur runners, 3 raters) found pelvic drop had the **lowest** inter-rater agreement of all running variables assessed (κ as low as 0.047–0.597), even worse than rearfoot eversion.

**Practical implications for the framework:**
- Treat any single 2D CPD value as carrying an uncertainty of roughly **±3–5°** relative to a 3D gold standard, and larger when camera setup is imperfect.
- Use differences and trends **within the same runner across sessions** more than absolute cutoffs between runners.
- Report left vs right from the **same video** rather than comparing across videos shot at different times or setups.
- Flag the measurement as low-confidence if the camera wasn't verifiably level, if PSIS landmarks were not visible, or if the runner was drifting on the treadmill.

---

## 2. Literature-Supported Ranges for Peak CPD at Midstance

### 2.1 Healthy, uninjured recreational runners

There is no single consensus "normal" number. Representative values from 3D lab studies:

- **Bramah et al. (2018), AJSM** — healthy controls (n = 36) at a controlled treadmill speed showed peak CPD roughly in the **4–7°** range (read from group mean ± 1 SD figures; the paper does not tabulate the exact mean, but their injured group fell in roughly the 7–11° range and the healthy group was approximately 3–4° lower).
- **Bazett-Jones / Willson & Davis (2008)** style data on uninjured female recreational runners commonly falls in the **5–8°** range for peak CPD.
- **Isometric GM torque & pelvic drop study (PMC3761484)** — 21 healthy recreational runners, 3D data averaged over 30 minutes of treadmill running: left-side peak CPD 10.9° ± 1.7°, right-side 7.6° ± 1.2°. The large left–right asymmetry and the fact that "healthy" subjects were at ~10° on one side is a useful reality check that "normal" can sit well above 5°.
- **Dingenen et al. (2019)** 2D video data on uninjured recreational runners: peak CPD roughly in the **5–7°** range.

**A defensible composite "healthy" range for peak CPD at midstance in uninjured adult recreational runners: ~3–8°,** with asymmetry between sides typically under ~2°. Values in elite runners can be higher on one side with no injury (see Modifiers).

### 2.2 Elevated but not strongly injury-linked

Values in the **~8–10°** range are above most healthy-group means but overlap heavily with the healthy distribution. Some authors flag this region as "movement impairment" worth coaching, though there is no hard prospective evidence that 9° causes injury if the runner is asymptomatic. This zone is best treated as **monitor and consider retraining if other risk factors are present** (recent training spike, history of PFP/ITBS, noticeable asymmetry, new symptoms).

### 2.3 Problematic / injury-associated

The strongest claim about injury association is from **Bramah et al. (2018, AJSM)**: in a sample of 72 injured runners (ITBS, PFP, MTSS, Achilles tendinopathy) vs. 36 healthy controls, CPD was the single variable that most strongly discriminated injured from healthy, and for every 1° increase in CPD the odds of being classified as injured rose by roughly 80%. The injured group's mean peak CPD was approximately 3–4° higher than controls and typically fell in the **~8–12°** range across subgroups.

Injury-specific notes:

- **ITBS** — Retrospective case-control studies (Ferber, Noehren, others) consistently show greater CPD and hip adduction in ITBS runners versus controls, with ITBS means often around 9–12°. Mechanism: lateral shift of the pelvis increases hip adduction, which increases IT-band strain on the lateral femoral condyle.
- **PFPS** — Evidence is mixed. Willson & Davis (2008), Dierks et al. (2008), and Bramah et al. (2018) reported greater CPD in PFP runners. Noehren et al. (2012, Clin Biomech, n = 32) found greater hip adduction and internal rotation in female PFP runners but **no significant difference in CPD**, and actually a trend toward *less* contralateral trunk lean — interpreted as a possible compensation. A 2022 musculoskeletal-simulation study (Applied Sciences) found greater CPD **range of motion** in PFP runners (3.64° vs 1.88°) but similar peak values. Noehren et al. (2013, MSSE), the largest prospective study (400 female runners, 15 incident PFP cases), found **greater hip adduction** in those who developed PFP but did **not** identify CPD as a prospective risk factor.
- **MTSS** — Bramah et al. (2018) included MTSS in their injured group that showed elevated CPD. A 2024 RCT (Lashien et al.) found that strengthening hip abductors reduced CPD and symptoms in MTSS runners. A 2020 systematic review listed "higher pelvic tilt in the frontal plane" as a risk factor for MTSS in novice and recreational runners, though evidence was graded as limited.
- **Achilles tendinopathy** — Included in the Bramah (2018) injured cohort with elevated CPD. The association is weaker and more inconsistent than for ITBS.
- **Gluteal tendinopathy** — Mechanistically, higher CPD increases tensile and compressive load at the greater trochanter, and clinical expert consensus links excessive CPD to gluteal tendinopathy, but prospective running-specific biomechanical data is sparse.
- **Tibial stress injury/fracture** — More consistently associated with reduced pelvic rotation in the transverse plane than with CPD itself (Frontiers in Sports & Active Living, 2025; Pohl, Mullineaux, Milner et al. literature). CPD elevation is a plausible contributor via increased hip adduction but is not the strongest predictor.
- **Low back pain** — Associated with altered pelvic kinematics, though the literature emphasizes transverse-plane rotation range more than frontal-plane CPD.

**A defensible "problematic" threshold**: peak CPD **≥ ~10°** at midstance, particularly with marked asymmetry (≥3° side-to-side difference) and/or symptoms, is consistent with the injured-group values in Bramah (2018) and with commonly cited clinical cutoffs. This is not a diagnostic cutoff — it is a threshold at which the literature supports looking more carefully.

---

## 3. Modifiers and Caveats

### 3.1 Sex

Females show, on average, slightly greater peak pelvic obliquity during running than males, and a more pronounced increase in pelvic motion with speed (Frontiers in Sports & Active Living, 2025). Chumanov et al. found a ~0.7° increase in peak pelvic obliquity from 9.7 → 13 km/h in a mixed-sex cohort; the 2025 female-only study found ~1.4° over a similar speed range. This partly reflects anatomy (wider hip:thigh ratio) and partly hip-abductor strength differences.

Practical implication: a given absolute CPD (e.g., 9°) is more common in the healthy female distribution than in the healthy male distribution. Do not use male-derived thresholds unchanged on female runners.

### 3.2 Running speed

CPD and pelvic obliquity range generally increase with speed. This matters because a runner measured at 6:00/km may legitimately show a different CPD than the same runner at 4:00/km. Standardize speed across repeat measurements if possible, and report the pace used.

### 3.3 Fatigue

The 30-minute treadmill study (PMC3761484) found left-side peak CPD rose from 9.5° ± 3.3° at minute 0 to 11.9° ± 4.4° at minute 30 (moderate effect size ~0.61) while the right side stayed essentially unchanged. Interpretation: fatigue increases CPD and can reveal asymmetries that aren't present fresh. Post-workout or late-run video is more sensitive for injury-risk screening; start-of-run video is more standardized.

### 3.4 Footwear and surface

Footwear effects on CPD specifically are not well established. Stability shoes that alter rearfoot motion may modestly change pelvic mechanics through the kinetic chain but the effect is small compared to abductor strength and motor control. A single 2022 study in Frontiers in Bioengineering and Biotechnology examined flat shoes and hip kinematics. Softer surfaces (grass, trail) generally dampen impact but haven't been shown to systematically change peak CPD.

### 3.5 Treadmill vs. overground

Schache et al. (2001) found **pelvic kinematics were broadly similar** between treadmill and overground running; only three of many parameters differed, and those were in anterior pelvic tilt, not obliquity. CPD measured on a treadmill is generally transferable to overground running, with the important caveat that belt speed regulation and treadmill stiffness matter.

### 3.6 Novice vs. trained vs. elite runners

Published thresholds were almost entirely derived from recreational adult runners (typically 16–80 km/week, ~20–40 years old). They do not generalize cleanly to:
- **Elite distance runners**, who may show high CPD without injury (as noted in clinical case discussions of elite runners like Kim Smith, who runs with visibly large pelvic drop while remaining world-class).
- **Novices**, whose motor control is typically poorer and whose CPD may be elevated without strength deficits — retraining/education applies rather than strength-based thresholds.
- **Youth runners**, for whom published CPD normative data are sparse.

### 3.7 Validated scoring systems and cutoffs

There is no widely validated, formally credentialed clinical scoring system for CPD that has prospective injury-prediction performance metrics published. Commonly cited clinical cutoffs:

- **"<5° normal, ≥5° notable"** — appears in some physiotherapy teaching materials (e.g., Health HP, Doctors of Running blog, Ochy documentation). This is a reasonable *screening* threshold but is looser than the healthy group means in the research literature and will over-flag.
- **"≥10° pathological"** — appears frequently as a rule of thumb. It is *consistent* with Bramah (2018) injured group means but is not a formal, prospectively validated cutoff. Use it as a flag, not a diagnosis.
- **Asymmetry ≥3°** — clinically meaningful; supported by the fatigue study showing a 3.3° left-right difference in healthy runners developed over 30 min of running.

### 3.8 Confidence levels for the headline claims

- **Strong evidence**: CPD is associated cross-sectionally with common running injuries as a group (Bramah 2018 is large and well-designed; consistent across ITBS, PFP, MTSS, AT subgroups).
- **Moderate evidence**: gait retraining that reduces CPD improves pain and function in PFP and MTSS (Noehren 2011; Willy et al.; Lashien 2024).
- **Weak / inconsistent evidence**: CPD as a *prospective* (predictive) risk factor for specific injuries in previously uninjured runners. The largest prospective study (Noehren 2013) found hip adduction but not CPD predictive of incident PFP.
- **Weak evidence**: absolute numerical cutoffs (5°, 10°) as diagnostic thresholds. These are clinical heuristics consistent with cross-sectional data, not prospectively validated decision rules.
- **Weak evidence**: 2D video CPD absolute value equaling 3D truth. Reliability is good; validity vs 3D is mixed.

---

## 4. Quick-Reference Table

| Peak CPD at midstance | Category | Clinical interpretation | Associated injuries (if elevated) | Key citations |
|---|---|---|---|---|
| **0–4°** | Well-controlled | Typical of uninjured controls; consistent with strong hip-abductor/core control | — | Bramah 2018 (healthy mean ~3–4°); Dingenen 2019 |
| **4–8°** | Within normal range | Most uninjured recreational runners sit here, especially females and at faster speeds | — | Willson & Davis 2008 (controls); most "healthy" 3D datasets |
| **8–10°** | Elevated, monitor | Above healthy mean but overlapping healthy distribution; consider retraining if other risk factors or symptoms present | Overlaps injured group distributions | Bramah 2018; PMC3761484 (healthy left side hit 10.9°) |
| **≥10°** | Problematic | Consistent with injured-group means; warrants gait retraining, hip abductor strengthening, cadence manipulation | ITBS (strongest link), PFP, MTSS, Achilles tendinopathy, gluteal tendinopathy, low back pain | Bramah 2018 (1° increase → 80% higher odds of injured classification); Ferber/Noehren ITBS work; Willson & Davis 2008 |
| **Asymmetry ≥3° L vs R** | Clinically notable regardless of absolute value | Often reflects unilateral abductor weakness, previous injury, or leg-length difference | Any of the above, on the side opposite to the dropping hemi-pelvis | PMC3761484 fatigue asymmetry; clinical consensus |

**Reminders when using this table:**
1. These are *framework* ranges, not diagnostic cutoffs. A single CPD value above 10° in an asymptomatic runner is a prompt for further assessment, not a diagnosis.
2. The ranges were derived primarily from 3D motion capture. A 2D screenshot estimate carries roughly ±3–5° of additional uncertainty versus 3D, and more if camera setup is imperfect.
3. Context matters more than the number. A symptomatic ITBS runner with 8° CPD and visible asymmetry may warrant intervention before an asymptomatic elite with 11° CPD.

---

## Primary References

- Bramah C, Preece SJ, Gill N, Herrington L. Is There a Pathological Gait Associated With Common Soft Tissue Running Injuries? *Am J Sports Med.* 2018;46(12):3023–3031. doi:10.1177/0363546518793657
- Noehren B, Pohl MB, Sanchez Z, Cunningham T, Lattermann C. Proximal and distal kinematics in female runners with patellofemoral pain. *Clin Biomech (Bristol, Avon).* 2012;27(4):366–371.
- Noehren B, Hamill J, Davis I. Prospective evidence for a hip etiology in patellofemoral pain. *Med Sci Sports Exerc.* 2013;45(6):1120–1124.
- Willson JD, Davis IS. Lower extremity mechanics of females with and without patellofemoral pain across activities with progressively greater task demands. *Clin Biomech.* 2008;23(2):203–211.
- Dierks TA, Manal KT, Hamill J, Davis IS. Proximal and distal influences on hip and knee kinematics in runners with patellofemoral pain during a prolonged run. *J Orthop Sports Phys Ther.* 2008.
- Maykut JN, Taylor-Haas JA, Paterno MV, DiCesare CA, Ford KR. Concurrent validity and reliability of 2D kinematic analysis of frontal plane motion during running. *Int J Sports Phys Ther.* 2015;10(2):136–146.
- Dingenen B, Barton C, Janssen T, Benoit A, Malliaras P. Test-retest reliability of two-dimensional video analysis during running. *Phys Ther Sport.* 2018.
- Dingenen B, Malliaras P, Janssen T, Ceyssens L, Vanelderen R, Barton CJ. Two-dimensional video analysis can discriminate differences in running kinematics between recreational runners with and without running-related knee injury. *Phys Ther Sport.* 2019;38:184–191.
- Schache AG, Blanch PD, Rath DA, et al. A comparison of overground and treadmill running for measuring the three-dimensional kinematics of the lumbo–pelvic–hip complex. *Clin Biomech.* 2001;16(8):667–680.
- Ferber R, Noehren B, Hamill J, Davis I. Competitive female runners with a history of iliotibial band syndrome demonstrate atypical hip and knee kinematics. *J Orthop Sports Phys Ther.* 2010.
- Souza RB, Powers CM. Differences in hip kinematics, muscle strength, and muscle activation between subjects with and without patellofemoral pain. *J Orthop Sports Phys Ther.* 2009;39(1):12–19.
- Noehren B, Scholz J, Davis I. The effect of real-time gait retraining on hip kinematics, pain and function in subjects with patellofemoral pain syndrome. *Br J Sports Med.* 2011;45(9):691–696.
- Lashien SA, Abdelnaeem AO, Gomaa EF. Effect of hip abductors training on pelvic drop and knee valgus in runners with medial tibial stress syndrome: a randomized controlled trial. *J Orthop Surg Res.* 2024.
- Bazett-Jones DM, Cobb SC, Huddleston WE, et al. Effect of Patellofemoral Pain on Strength and Mechanics after an Exhausting Run in Women. *Med Sci Sports Exerc.* 2013.
