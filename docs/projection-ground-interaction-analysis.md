# Projection & Ground Interaction (PGI)

The esFormLab mechanics analysis that supersedes the Force-Vector / Kinematic
Force-Orientation product direction. It answers:

> **"How is this runner creating stride length and interacting with the ground?"**

through five linked domains along the mechanical chain:

```
PROJECT → PREPARE → LAND / LOAD → REBOUND → FLIGHT / STRIDE OUTCOME
```

Since schema v4 the stride timeline is anchored on the **minimum-COM landmark**
(the four-phase model, §4):

```
TOUCHDOWN PREPARATION → TOUCHDOWN → LOADING / COMPRESSION → MINIMUM COM
  → REBOUND / PROJECTION → TOE-OFF → FLIGHT / STRIDE OUTCOME
```

The central coaching question this makes easy to answer: *how did the athlete
receive the incoming stride, reach maximum compression, and then organise the
body from minimum COM through toe-off to create the outgoing stride?*

It deliberately does **not** produce a single efficiency score, does not match
runners against elite angle templates, does not treat any single metric
(vertical oscillation included) as good or bad on its own — and does not call
minimum COM the onset of propulsive force (§4).

Technical disclaimer shown in the UI: *"This analysis is derived from video
kinematics. It does not directly measure ground-reaction force."*

Companion documents:
- `docs/kinematic-force-orientation.md` — the KFO system whose computational
  modules PGI builds on (support geometry, timing-derived vertical force).
- `docs/kinematic-force-orientation-refactor.md` — the earlier V1 → KFO audit.

---

## 1. Phase 0 audit — what existed before PGI

### Stack

Vanilla browser JavaScript, ES5-flavoured, no build step, no package manager at
the repo root. Scripts are plain `<script src>` tags in `esformlab/index.html`.
Firebase 10.7.1 compat. Pose estimation is TensorFlow.js MoveNet (Thunder on
desktop, Lightning for the mobile scan pass), COCO-17 keypoints, `MIN_CONF 0.25`.

### Pose / video pipeline

- `startAllVideos()` → `autoScanAll()` in `esformlab/index.html` drives everything.
- Side clip scanned at **N = 150 sampled frames** (75 mobile), seeking by
  timestamp — ~25 Hz effective on a 6 s clip. Each sample records
  `{t, lAnkleY/rAnkleY, lAnkleX/rAnkleX, hipMidX, hip/knee angles, conf, scale, kps}`
  **including full keypoints**.
- Samples are body-scale filtered, then retained on `window.__kfoSamples` when
  the admin force-orientation feature is capturing (`KFOApp.shouldCapture()`).
- A dense-refinement helper already exists: `_denseRefinePoseForAnkle()` +
  `refineLegPlateau()` re-scan ±0.20 s around the best stance per side at ~30 Hz
  to sharpen the four foot-strike/toe-off phase picks.

### Event detection

- `findPhases()` (production stride cards) and `KFOAnalysis.detectStanceIntervals()`
  (multi-stride) share one algorithm: ankle-Y maxima → prominence filter →
  plateau walk. `detectStanceIntervals` returns **every** clean stance interval
  per side with per-stance samples, duration, pose confidence, and itemised
  rejections.
- `KFOVerticalForce.buildSteps()` pairs alternating-side stance intervals into
  steps: contact time, flight time, step time, duty factor, cadence — with
  double-support (walking) refusal and plausibility limits.

### Calculations already present (preserved as inputs to PGI)

| Quantity | Where | Status in PGI |
| --- | --- | --- |
| Whole-body COM (Winter segments, hip fallback) | `KFO.computeCOM` | reused everywhere |
| Signed support-line angle, three stance windows (10–15 / 45–55 / 85–90 %) | `KFO.computeSupportLine`, `KFOAnalysis.analyzeSide` | kept as **secondary descriptive geometry** |
| COM-to-leg divergence | same | kept, descriptive |
| Running direction + mirroring detection | `KFO.inferRunningDirection` | reused |
| GCT, flight, step time, duty factor, cadence per step | `KFOVerticalForce.buildSteps` | now primary timing source |
| Mean vertical force = 1/duty factor; peak ≈ (π/2)/DF | `KFOVerticalForce` | reused as "timing-derived mean vertical support" |
| Robust aggregation (median/SD/IQR/t-based CI95, Tukey outlier flagging) | `KFO.aggregate` | reused for every PGI metric |
| Uncertainty model + display-precision guard | `KFO.computeConfidence`, `formatAngle` | reused |
| Savitzky–Golay-equivalent local-polynomial smoothing + derivatives | `KFOEstimators.localPolyDerivatives` | now user-facing-adjacent: smooths COM and foot trajectories before differentiation |
| Steady-speed / perpendicularity / occlusion checks | `KFOAnalysis` | reused |
| Height-assumption scale calibration | `KFOEstimators.calibrationFromAssumedHeight` | reused as one calibration source |
| Research export CSV machinery, force-plate import, validation gate | `KFOExport` | pattern reused; PGI has its own export |

### What did NOT exist (new in PGI)

- Any analysis of the foot **before** contact (late-swing trajectory,
  retraction, arrival velocity).
- COM vertical trajectory through the stride; VO decomposition.
- COM vertical velocity and the flight-time cross-check.
- Speed / treadmill speed / surface anywhere in the pipeline.
- Stride length / step length / flight distance.
- Arm-carriage metrics.
- Pre/post condition comparison.
- A pattern-combination interpretation engine (KFO had only the coupled
  braking/propulsion classifier).

### Persistence / compatibility constraints found

- Saved analyses: `users/{uid}/analyses/{id}`; **no keypoints stored**, so no
  historical analysis can be recomputed. KFO stores an aggregate-only `kfo`
  block with `schemaVersion` inside the block (v2 = KFO, v3 = +impulse
  accounting); absence = v1 (pre-KFO).
- `KFOApp.storedFields()` / `renderSaved()` are called from
  `saved-analyses.js` and `auth-paywall.js`.
- Manual frame adjustment (`epStep`/`epReanalyze`) exists on the stride cards
  and is untouched by this feature.
- Tests are a hand-rolled harness (`node esformlab/kfo-tests.js`), no framework,
  no root `package.json` — convention preserved.

---

## 2. Decisions

**D1 — KFO becomes a library, PGI becomes the product surface.** The KFO
modules (stance detection, support geometry, timing force, aggregation,
smoothing) are sound and are reused as inputs. The standalone KFO panel is
demoted: `kinematicForceOrientationV2` now defaults **off** even for admins and
is labelled superseded. The V1 force-vector panel remains reachable only via
`legacyForceVectorV1`, unchanged. Nothing scientific in KFO regressed — its
rules (no "under-propulsive" labels, coupled braking/propulsion, no measured-GRF
claims, timing force per-step-then-aggregate) are inherited wholesale.

**D2 — Schema.** New saves write a `pgi` block only:
`analysisType: "projection_ground_interaction"`, `schemaVersion: 4`. The version
counts generations of this analysis surface (1 = pre-KFO prototype era,
2 = `kfo` block, 3 = `pgi` block, 4 = the four-phase / minimum-COM stride
model) so a document's vintage is unambiguous. v3 `pgi` documents still render;
the four-phase cards read as unavailable on them.
Read-time migration: `pgi` present → render PGI; only `kfo` → render the stored
KFO aggregate through the legacy KFO renderer, tagged legacy; neither →
explicit unavailable. **No stored KFO/V1 value is reinterpreted as a PGI
metric.** Old documents are never rewritten.

**D3 — "Foot" means the ankle landmark.** COCO-17 has no heel/toe/foot point.
Every foot-trajectory metric is ankle-anchored and labelled
`footRepresentation: "ankle"`. This under-measures true foot-to-COM offset for
heel strikers; the limitation is disclosed rather than modelled away.

**D4 — Velocity metrics are FPS-gated, never fabricated.** Pre-contact foot
velocity and COM vertical velocity require adequate sampling. The window used
(final 40/60/80/120 ms) is chosen from the effective sample rate; below
~15 Hz effective, pre-contact velocity reports
`unavailable: video_frame_rate_insufficient`. Presence/absence of retraction is
only asserted when the window contains enough samples to support it.

**D5 — Optional dense pre-contact rescan.** When PGI capture is active,
`autoScanAll()` runs a bounded extra pass (~30 Hz, `[td−0.18 s, td+0.12 s]`,
up to 3 stances per side, desktop by default) around detected touchdowns,
retained on `window.__pgiDenseWindows`. Touchdown-preparation metrics prefer
dense windows and fall back to the coarse scan. Failure of this pass can never
break the main scan.

**D6 — Spatial calibration is explicit and provenance-tagged.** Sources, in
order of preference: `user_height` (entered height → nose-to-ankle model),
`ballistic_flight` (median implied px/m from pose take-off velocity vs flight
time), `none`. COM excursions are always reported in **normalized units**
(fraction of leg length); centimetres appear only with a calibration and carry
its source. When calibration is `ballistic_flight`, the flight-time cross-check
(Phase 12) is **not independent** and is flagged as such.

**D7 — Speed is a first-class, honest input.** `speedMps`, `speedSource`
(`user_entered` | `estimated_translation` | `unknown`), `speedConfidence`.
Overground with meaningful hip translation + calibration → speed estimated from
the hip-drift slope. Treadmill: `footGroundVelocityX` needs both belt speed and
calibration; otherwise COM-relative retraction metrics stand in and
ground-relative velocity reports unavailable. Speed-dependent judgments
(stride length "for speed") are withheld when speed is unknown.

**D8 — Patterns are combinations, with alternatives.** Every emitted pattern
carries observations, interpretation, confidence, alternative explanations, and
the supporting metrics. No pattern fires off a single metric. Increased VO is
never penalized by itself; the productive-projection pattern (VO↑ GCT↓ flight↑
stride↑) and the unproductive counterpart are explicit rule combinations.

**D9 — No global efficiency score.** The summary is six domain readings
(touchdown preparation, braking indicators, vertical projection, rebound
timing, stride outcome, data confidence). Internal numeric scores exist only
for ordering and are not rendered as scores.

---

## 3. Architecture

| File | Module | Responsibility |
| --- | --- | --- |
| `esformlab/pgi-core.js` | `PGI` | schema/versions/enums, quality flags, calibration + speed models, ballistic formulas, smoothing wrapper, normalization helpers |
| `esformlab/pgi-timing.js` | `PGITiming` | StrideTimingAnalyzer + VerticalProjectionAnalyzer (wraps `KFOVerticalForce`) |
| `esformlab/pgi-com.js` | `PGICom` | COMTrajectoryAnalyzer + ReboundAnalyzer + flight cross-check |
| `esformlab/pgi-touchdown.js` | `PGITouchdown` | TouchdownPreparationAnalyzer + braking-pattern classification |
| `esformlab/pgi-outcome.js` | `PGIOutcome` | StrideOutcomeAnalyzer + ArmCarriageAnalyzer |
| `esformlab/pgi-phases.js` | `PGIPhases` | four-phase stride model: joint-angle series, loading/compression + rebound/projection blocks, outcome chain, movement summary |
| `esformlab/pgi-patterns.js` | `PGIPatterns` | MechanicsPatternInterpreter + domain summary |
| `esformlab/pgi-compare.js` | `PGICompare` | ConditionComparisonAnalyzer (pre/post) |
| `esformlab/pgi-analysis.js` | `PGIAnalysis` | orchestration, envelope assembly, `toStoredForm`, migration |
| `esformlab/pgi-render.js` | `PGIRender` | panel UI, foot-trajectory + COM-trajectory SVGs, comparison view |
| `esformlab/pgi-export.js` | `PGIExport` | stride-level + frame-level research export |
| `esformlab/pgi-app.js` | `PGIApp` | flags (`esl-pgi-*`), capture gating, inputs, render/saved/stored dispatch |
| `esformlab/pgi-tests.js` / `pgi-tests.html` | `PGITests` | fixtures + suites (node + browser) |

Script load order (after the `kfo-*` scripts they depend on):
`pgi-core → pgi-timing → pgi-com → pgi-touchdown → pgi-outcome → pgi-phases →
pgi-patterns → pgi-compare → pgi-analysis → pgi-render → pgi-export → pgi-app`.

---

## 4. Formulas and conventions

### Sign conventions

Horizontal quantities are positive **in the direction of travel**, normalised by
the inferred running direction, so right-to-left and mirrored clips read
identically for identical mechanics. Vertical quantities are positive **upward**
(image `+y` is down, so height is `−y`).

| Quantity | Positive means |
| --- | --- |
| `forwardOffset = (footX − comX)·dirSign` | foot is **ahead** of the COM |
| horizontal foot velocity | foot travelling **forward** with the runner |
| vertical foot velocity | foot **rising** |
| approach angle | `0°` = purely forward, `+90°` = straight down, negative = rising |
| COM vertical velocity | COM **rising** |
| support-line angle | support point **behind** the COM (propulsive-oriented) |

### Stride timing (`pgi-timing.js`)

All from directly detected events, never algebraic reconstruction:

```
stepTime       = time between consecutive opposite-foot contacts
flightTime     = toe-off → opposite-foot touchdown
dutyFactor     = GCT / stepTime
flightFraction = flightTime / stepTime
```

### Timing-derived mean vertical support

```
meanVerticalSupportBW = stepTime / GCT = 1 / dutyFactor      EXACT at steady state
peakVerticalSupportBW ≈ (π/2) / dutyFactor                   half-sine approximation
```

Computed **per step then aggregated** — `1/DF` is convex, so aggregating duty
factor first biases the result (Jensen's inequality). Assumptions: steady speed,
level surface, periodic gait. Withheld as `insufficient_quality` when
acceleration is detected. Labelled *"Timing-derived mean vertical support"*,
`isValidated: false`, never called a measured force. The peak carries the
disclosed 5–15% low bias against Dorn et al. 2012.

### Vertical projection (ballistic, `g = 9.80665 m/s²`)

```
verticalTakeoffVelocity        = g · t_flight / 2                [m/s]
effectiveVerticalImpulse/mass  = 2 · v_takeoff = g · t_flight    [N·s/kg]
aerialRise (ballistic)         = g · t_flight² / 8               [m]
predictedFlightTime            = 2 · v_takeoff / g               [s]
```

These need no spatial calibration, which is why they are the *primary*
projection metrics.

### COM trajectory decomposition (`pgi-com.js`)

```
stanceCompression  = COM_touchdown − COM_minimum
stanceRebound      = COM_toeoff    − COM_minimum
aerialRiseMeasured = COM_apex      − COM_toeoff
verticalOscillation = COM_max − COM_min over the step
```

Derived on a smoothed trajectory (local-polynomial / Savitzky–Golay-equivalent,
window 7, order 2); raw points retained alongside. Velocities are **fitted first
derivatives**, never frame-to-frame differences.

```
verticalVelocityReversal = v_y(toe-off) − v_y(touchdown)
verticalReversalRate     = reversal / GCT
```

The reversal rate is normalised by leg length (`leg lengths/s²`) so it is
thresholdable without calibration, and converted to `m/s²` when one exists. It
is a **kinematic proxy**; it is never multiplied by a mass and never called a
force.

### The four-phase stride model (minimum COM) — schema v4

The stride timeline is organised around four functional windows:

```
TOUCHDOWN PREPARATION   ~150 ms before contact → touchdown        (pgi-touchdown)
LOADING / COMPRESSION   touchdown → minimum COM                   (pgi-com + pgi-phases)
REBOUND / PROJECTION    minimum COM → toe-off                     (pgi-com + pgi-phases)
FLIGHT / STRIDE OUTCOME toe-off → next touchdown                  (pgi-timing + pgi-outcome)
```

**Why minimum COM.** The lowest point of the smoothed whole-body COM trajectory
within stance is the kinematic reversal point of vertical COM motion: the COM
descends, upward force decelerates the descent, vertical COM velocity passes
through approximately zero, and the COM rises to toe-off. That makes it an
excellent, robustly detectable landmark for summarising how the runner
organises the outgoing stride.

**What minimum COM is NOT.** It is *not* the exact start of propulsive force,
*not* the start of positive vertical force, and *not* the braking-to-propulsion
transition. Upward force is already being produced **before** the minimum in
order to decelerate the descending COM. The fore-aft (AP) force reversal —
`Fx` crossing from braking to propulsion — is a *separate* event that is not
guaranteed to coincide with the vertical reversal, and this video-only pipeline
does not observe it. The architecture keeps the two distinct: minimum COM is
described as the *vertical COM reversal* / *start of the rebound–projection
window*, never as a force event. The phase after it is named
**rebound/projection**, never "propulsive phase".

**Detection** (`PGICom.detectMinimumCom`). Runs on the smoothed trajectory,
never a single raw frame. Candidates are the smoothed samples inside the stance
plus the interpolated stance endpoints. A broad flat bottom (region within 5%
of the excursion range of the minimum, wider than 30% of stance — above the
~22% a parabolic minimum shows at that epsilon) is reported as a **region**
with its centre chosen and the bounds retained
(`window: {startPercent, endPercent}`, `detectionMethod:
'smoothed_com_flat_region_center'`). Each detection carries a confidence and
flags rather than failing silently:

| Flag | Trigger |
| --- | --- |
| `minimum_com_flat_region` | flat bottom wider than 30% of stance |
| `minimum_com_multiple_local_extrema` | >1 comparable local minimum |
| `minimum_com_near_touchdown` / `_near_toeoff` | minimum within 12% of a stance edge |
| `com_trajectory_noisy` | >3 fitted-velocity sign changes within stance |
| `minimum_com_velocity_inconsistent` | \|v_y\| at the minimum > 0.35 × peak stance \|v_y\| |
| `minimum_com_low_confidence` | combined confidence < 0.5 |

The clip-level flag `minimum_com_unreliable` is raised when the median
per-step confidence falls below 0.5, and **stance-organization patterns are
withheld** in that case.

**Phase metrics** (per step, then aggregated; all on the smoothed series):

```
loadingCompressionDuration = t_minCOM − t_touchdown
reboundTime                = t_toeoff − t_minCOM
compressionFraction        = loadingDuration / GCT
reboundFraction            = reboundTime / GCT           (sum ≈ 1)
compressionToReboundRatio  = loadingDuration / reboundTime
stanceCompression          = COM_touchdown − COM_min      (up-positive)
reboundRise                = COM_toeoff − COM_min
loadingHorizontalTravel    = (COM_x(minCOM) − COM_x(TD)) · dirSign
reboundHorizontalTravel    = (COM_x(TO) − COM_x(minCOM)) · dirSign
meanReboundVelocity        = reboundRise / reboundTime    "mean COM rise velocity"
verticalVelocityGain       = v_y(TO) − v_y(minCOM)        (v_y(minCOM) ≈ 0)
meanVerticalAccelProxy     = velocityGain / reboundTime   (quality-gated, see below)
```

`meanReboundVelocity` is always worded as a *motion* quantity ("mean COM rise
velocity during rebound") — never a force. The acceleration proxy is emitted
**only** when the fitted COM velocity passed its flight cross-check (median
relative error ≤ 0.35) and the frame rate supports velocities at all; otherwise
it is `unavailable` with `com_velocity_quality_insufficient`.

**Toe-off velocity: two estimates, never averaged.** `v_y(TO)` exists both as
the fitted pose derivative (needs a calibration) and as the ballistic
`g·t_flight/2`. They are cross-checked (`toeoffVelocityAgreement`); the
flight-derived value leads every user-facing summary
(`preferredSource: 'ballistic_flight_time'`), and both values plus their
disagreement are exposed in the admin/research output.

**Joint-angle summaries** (`pgi-phases.js`) at touchdown, minimum COM and
toe-off, aggregated per phase with change and (frame-rate-gated) mean angular
velocity:

| Angle | Definition | Positive means |
| --- | --- | --- |
| hip | trunk–thigh interior angle at the hip | larger = more extended |
| knee | thigh–shank interior angle at the knee | larger = straighter |
| trunk | shoulder-mid→hip-mid lean from vertical | forward lean |
| shank | knee→ankle inclination from vertical | knee ahead of ankle |
| support | COM→stance-ankle line from vertical | support point behind COM |
| ankle | **permanently unavailable** — COCO-17 has no heel/toe/foot landmark, so no foot segment exists to measure plantarflexion against | — |
| pelvis | **permanently unavailable** — two near-collinear sagittal hip points cannot resolve pelvis orientation | — |

No single joint is credited with creating propulsion; the movement summary
describes coordinated whole-body movement, descriptively, with no grading
vocabulary.

**Outcome chain.** One object links the temporal sequence
`minimum COM → rebound rise → rebound time → v_y(toe-off) → flight →
aerial rise → stride length` for the UI and export, with an explicit note that
it is a temporal sequence, not a full causal chain.

### Flight-time cross-check

Ballistic flight predicts `t_flight ≈ 2·v_toeoff/g`, so pose-derived toe-off
velocity is checked against observed flight time.
`flightPredictionError = observed − predicted`, aggregated, plus a
`comVelocityConfidence` that falls to 0 at ≥60% median relative error.

**Independence is tracked explicitly.** With a `user_height` calibration the
check is genuine. With the `ballistic_flight` calibration it is *circular* by
construction — `isIndependent: false`, `comVelocityConfidence: null`, and the
note says so. The spread of implied scale across steps is the meaningful
consistency signal in that case.

### Spatial calibration

Sources, in preference order, always provenance-tagged and never invented:

| Source | Method | `isMeasured` |
| --- | --- | --- |
| `user_height` | entered height → nose-to-ankle = 0.87 × height | false |
| `ballistic_flight` | `ppm = v_takeoff_px / (g·t_flight/2)`, median across steps, rejected if CV > 0.35 | false |
| `none` | — | — |

Without a calibration, lengths are reported **only** in leg lengths and
`no_spatial_calibration` is raised. Centimetres never appear without a scale.

### Ground-relative foot velocity

```
OVERGROUND (fixed camera):  footGround = footWorld            (ground velocity = 0)
TREADMILL:                  footGround = footWorld + beltSpeed
```

The treadmill form follows from the belt moving at `−beltSpeed` in the direction
of travel: a foot exactly matching belt speed reads **zero** mismatch. Without a
belt speed the value is `unavailable` with reason `treadmill_speed_unknown` —
never fabricated — and COM-relative retraction metrics stand in.

### Stride outcome

```
stepLength     = speed · stepTime            }  route 1: speed × time
flightDistance = speed · flightTime          }
stanceDistance = speed · contactTime         }

stepLength     = |COM_x(t+stepTime) − COM_x(t)|   route 2: COM translation
                                                  (calibrated OVERGROUND only)
```

Where both exist they are cross-checked — their agreement is the best available
test of the speed input, the calibration and the event timing. Dimensionless
descriptors: `stepLength/legLength`, `stepLength/height`, and Froude number
`v²/(g·L)`.

---

## 5. Output schema

`analysisType: "projection_ground_interaction"`, `schemaVersion: 4`.

```jsonc
{
  "analysisType": "projection_ground_interaction",
  "schemaVersion": 4,
  "modelVersion": "projection-ground-interaction-v1.1.0",
  "isValidated": false,
  "availability": "available|unavailable|insufficient_quality",
  "conditionLabel": "Post cue",

  "video": { "fps", "effectiveSampleRateHz", "durationSeconds",
             "runningDirection", "mirroredSuspected",
             "surfaceType", "surfaceTypeSource", "treadmillSpeedMps",
             "speedMps", "speedSource", "speedConfidence",
             "calibration": { "source", "pixelsPerMeter", "isMeasured" },
             "legLengthPx" },

  "quality": { "flags", "flagLabels", "confidence", "confidenceBand",
               "occlusion", "perpendicularity", "steadySpeed",
               "stancesDetected", "stepsAnalyzed", "medianSamplesPerStance" },

  "touchdownPreparation": {
    "footRepresentation": "ankle", "preContactWindowMs": 150,
    "velocityWindow", "densePreContactSampling",
    "left":  { "aggregate": {...}, "brakingPattern": {...}, "meanPath": {...} },
    "right": { ... },
    "asymmetry": {...}
  },

  "supportGeometry": {          // SECONDARY descriptive geometry
    "role": "secondary_descriptive_geometry",
    "vocabulary": { "early_stance": "braking-oriented support geometry", ... },
    "left": { "phases": { "early_stance": { "angle", "comLegDivergence" }, ... } },
    "right": {...}, "symmetry": {...}, "coupledPattern": {...}
  },

  "strideTiming":       { "overall", "left", "right", "stepsAnalyzed", "gaitValidity" },
  "verticalProjection": { "overall", "verticalSupport": {...} },
  "comTrajectory":      { "decomposition", "velocity", "flightCrossCheck", "meanPath" },
  "rebound":            { "stanceCompression", "stanceRebound", "comVelocity*", "reversalRate*" },

  // Four-phase model (schema v4). Per side: overall / left / right.
  "minimumCom": {        // the landmark: vertical COM reversal, NOT force onset
    "overall": { "stancePercent", "confidence", "flagCounts", "detectionMethod" },
    "left": {...}, "right": {...}, "reliability": { "medianConfidence", "unreliable" }
  },
  "loadingCompression": { // touchdown -> minimum COM
    "overall": { "durationMs", "fractionOfStance", "compression", "horizontalTravel",
                 "jointChanges": { "hip", "knee", "trunk", "shank",
                                   "ankle": "unavailable (no foot landmark)",
                                   "pelvis": "unavailable" },
                 "supportGeometry" },
    "left": {...}, "right": {...}
  },
  "reboundProjection": {  // minimum COM -> toe-off
    "overall": { "durationMs", "fractionOfStance", "comRise", "horizontalTravel",
                 "meanComRiseVelocity", "comVelocityAtMinimum",
                 "verticalVelocityAtToeoff": { "poseDerived", "ballisticFromFlightMps",
                                               "agreement", "preferredSource" },
                 "meanVerticalAccelerationProxy",   // quality-gated
                 "compressionToReboundRatio", "jointChanges", "supportGeometry" },
    "left": {...}, "right": {...},
    "outcomeChain": { "minimumComStancePercent", "reboundRise*", "reboundDurationMs",
                      "verticalVelocityAtToeoffMps", "flightSeconds",
                      "aerialRiseBallisticMeters", "strideLengthMeters" },
    "movementSummary": { "text", "patternNote" }   // descriptive, stored verbatim
  },
  "strideOutcome":      { "stepLengthMeters", "flightDistanceMeters", "normalized", "interpretation" },
  "armCarriage":        { "left", "right", "armLegPhase", "asymmetry", "handToMidlineDistance" },

  "patterns": [ { "pattern", "domain", "confidence", "observations",
                  "interpretation", "alternatives", "supportingMetrics",
                  "evidenceClasses", "isValidated": false } ],
  "domains":  { "touchdownPreparation", "brakingIndicators", "verticalProjection",
                "reboundTiming", "strideOutcome", "dataConfidence" },
  "symmetry": {...},
  "comparison": null,
  "limitations": [...]
}
```

### Stored form (~22 KB, budget 24 KB asserted in tests)

Schema **v4** added three stored blocks — `minimumCom`, `loadingCompression`,
`reboundProjection` (with `outcomeChain` and the verbatim `movementSummary`) —
which raised the budget from 20 KB. Historical v3 documents are untouched and
still render; the phase cards simply read as unavailable on them.

Dropped: per-step and per-contact records (including the four-phase
`stepPhases` joint samples), raw/smoothed series, stance sample buffers,
anything holding keypoints, duplicate-unit metrics (derivable from the stored
calibration and leg length), and `ci95` on metrics the comparison reads as bare
scalars. Per-side phase blocks store only the compact core (duration,
depth/rise, rise velocity) — side-to-side deltas persist once, in
`symmetry.stancePhases`.

Stripped and rebuilt by `rehydrateStatic()`: the disclaimer, standing
limitations, support-geometry vocabulary/sign-convention/window bounds/labels,
all `note` fields, coupled-pattern interpretation strings, pattern
`alternatives`, the minimum-COM definition, the ankle/pelvis refusal markers,
the outcome-chain sequence/note and `preferredSource`.

Kept verbatim: pattern `observations` and `interpretation`, and the rebound
`movementSummary` text — these are built from computed values with conditional
caveats and could not be faithfully reconstructed; they are the record of what
the analysis told the user.

Trajectory paths persist as **parallel arrays** downsampled to 13 points, so a
saved session can still draw its charts.

---

## 6. Interpretation rules

### Independent evidence

Within a step there are only **three** independent timing quantities: contact
time, flight time, and — since schema v4 — the **minimum-COM timing within
stance**. Step time, duty factor, cadence, mean vertical support (`1/DF`),
take-off velocity (`g·t_f/2`), effective vertical impulse (`g·t_f`) and
ballistic aerial rise (`g·t_f²/8`) are algebra on the first two; compression
and rebound durations, both phase fractions and the compression:rebound ratio
are algebra on GCT and the minimum-COM timing, and mean rebound velocity is
rise over rebound time. Rules therefore fire on the independent quantities; the
derived ones appear under `supportingMetrics.derivedFromTiming` /
`supportingMetrics.derivedFromLandmark` with notes stating they are not
independent evidence. Measured aerial rise (COM) vs ballistic aerial rise
(flight time) is a genuine cross-check, not two findings.

Evidence classes: `timing`, `com`, `touchdown`, `outcome`,
`minimum_com_landmark`.

### Braking patterns (position × velocity)

| Pattern | Position evidence | Velocity evidence |
| --- | --- | --- |
| `positional_overstride` | elevated | not elevated |
| `velocity_mismatch_touchdown` | not elevated | elevated |
| `combined_braking` | elevated | elevated |
| `well_prepared_touchdown` | moderate/low | clear retraction, low mismatch |
| `indeterminate` | — | insufficient evidence |

No pattern is assigned from a single metric; a test asserts that a good position
alone cannot earn `well_prepared_touchdown`.

### Vertical mechanics patterns

`low_projection`, `slow_projection`, `productive_projection`, `collision_heavy`,
`excessive_vertical_excursion`, `elastic_rapid_rebound`, plus the always-on
`vertical_oscillation_composition` which names whether the excursion comes
mainly from aerial rise or stance motion and states that neither is good or bad.

### Stance-organization patterns (four-phase model)

Combinations of compression depth, rebound duration/rise and the resulting
flight, anchored at the minimum-COM landmark. **All are withheld when
`minimum_com_unreliable`** — no strong rebound interpretation from a landmark
that could not be located.

| Pattern | Compression | Rebound | Flight |
| --- | --- | --- | --- |
| `rapid_rebound` | contained (< large) | short, rise ≥ meaningful | > short |
| `slow_rebound` | — | long (≥ 140 ms) | ≤ short |
| `high_compression_low_rebound` | ≥ large | rise ≤ limited | ≤ short |
| `high_compression_strong_rebound` | ≥ large | rise ≥ meaningful | > short |
| `low_compression_rapid_rebound` | ≤ small | short | ≥ short |

**No compression or stiffness strategy is ranked as universally superior** —
each pattern is a description of how stance is organised, and the
high-compression/strong-rebound interpretation says so explicitly. The
compression:rebound ratio is emitted for left/right, pre/post, fatigue and
within-runner comparison only; no ideal-value thresholds exist for it.

### Productive vs unproductive vertical oscillation

**Vertical oscillation is never penalised on its own.** Both readings require a
combination:

| | VO | GCT | Flight | Stride | Reading |
| --- | --- | --- | --- | --- | --- |
| Productive | ↑ | ↓ or = | ↑ | ↑ or = | *"contributing to useful aerial time rather than simply increasing bounce"* |
| Unproductive | ↑ | ↑ or = | = | = | *"increased without a corresponding improvement in flight or stride outcome"* |

Cross-sectionally, high VO is only called `excessive_vertical_excursion` when it
is **not** buying flight — long contact, short flight, or an excursion that is
mostly stance motion.

### Provisional thresholds

| Threshold | Value |
| --- | --- |
| `gctLongSeconds` / `gctShortSeconds` | 0.265 / 0.225 |
| `flightShortSeconds` / `flightAmpleSeconds` | 0.105 / 0.135 |
| `voHighLegLengths` / `voLowLegLengths` | 0.105 / 0.070 |
| `stanceCompressionLargeLegLengths` | 0.075 |
| `reversalRapid` / `reversalSlow` (leg lengths/s²) | 8.5 / 5.0 |
| `offsetModerate` / `offsetElevated` (leg lengths) | 0.28 / 0.38 |
| `forwardFootGroundMps` | 0.40 |
| `reboundShortMs` / `reboundLongMs` | 105 / 140 |
| `compressionSmallLegLengths` | 0.05 |
| `reboundRiseMeaningful` / `reboundRiseLimited` (leg lengths) | 0.05 / 0.03 |

All carry `isProvisional: true`. **The timing bands must be reachable inside the
accepted running range**: since `DF = GCT/(GCT+flight)`, requiring long contact
*and* short flight implies `DF ≥ 0.72`, and the step validator rejects anything
above 0.75 as not-running. A stricter pair would define a `low_projection`
pattern that could never fire on accepted data — a test asserts the fixture
stays inside the range.

### Domain summary — no global score

Six independently-rated domains: touchdown preparation (good/moderate/needs
review), braking indicators (low/moderate/elevated), vertical projection
(low/moderate/strong), rebound timing (slow/moderate/rapid), stride outcome
(short/appropriate/long for speed — currently always `unknown`), data confidence
(high/moderate/low). Internal `sortWeight` orders the pattern list and is never
rendered as a score.

**Stride outcome is deliberately `unknown`** even when speed is known: judging a
stride short or long needs a speed-matched reference distribution, none is
loaded, and substituting a plausible number would manufacture a provenance that
does not exist. This follows the KFO precedent of shipping the reference store
empty rather than seeding invented values.

---

## 7. Quality and uncertainty

Flags inherited from KFO (`low_frame_rate`, `sparse_stance_sampling`,
`camera_not_perpendicular`, `excessive_perspective`, `landmark_occlusion`,
`low_pose_confidence`, `uncertain_contact_frame`, `insufficient_strides`,
`speed_unknown`, `acceleration_detected`, `grade_unknown`, `mirrored_video`,
`unstable_running_direction`, `high_stride_variability`) plus PGI's own:

| Flag | Meaning |
| --- | --- |
| `treadmill_speed_unknown` | ground-relative foot velocity unavailable |
| `no_spatial_calibration` | lengths in normalised units only |
| `velocity_sampling_insufficient` | frame rate too low for pre-contact velocity |
| `calibration_is_ballistic_implied` | scale implied from flight, not measured |
| `dense_precontact_sampling_unavailable` | dense pass requested but not used |
| `speed_mismatch_between_conditions` | comparison is speed-confounded |
| `minimum_com_unreliable` | minimum COM not reliably located on most steps; phase splits low-confidence, stance-organization patterns withheld |

Per-step minimum-COM flags (`minimum_com_flat_region`,
`minimum_com_multiple_local_extrema`, `minimum_com_near_touchdown`/`_near_toeoff`,
`com_trajectory_noisy`, `minimum_com_velocity_inconsistent`,
`minimum_com_low_confidence`) are carried on each detection and aggregated as
`flagCounts` per side — see §4.

**No false precision.** Below ~15 Hz effective, pre-contact velocity reports
*"Pre-contact velocity estimate unavailable: video frame rate insufficient."*
rather than a degraded number. Speed-unknown reduces every pattern confidence by
20% and blocks absolute stride-length judgements.

---

## 8. Comparison mode

`PGICompare.compare(conditionA, conditionB)` over ~40 metrics in six groups
(touchdown preparation, **loading/compression**, **rebound/projection**,
projection, outcome, ground interaction). Each delta carries absolute change,
percentage change, both stride distributions, and `exceedsVariability` — a
**CI-non-overlap** test, falling back to a pooled standardised difference
≥ 0.8. A change inside the noise is reported as *unchanged* with its numbers
still visible.

The four-phase groups prominently compare minimum-COM timing, compression
duration/fraction/depth, rebound duration/fraction/rise, mean rebound velocity,
the compression:rebound ratio, and the hip/knee changes during rebound. When
rebound duration or rise changes meaningfully, `rebound_organization_change`
describes it ("a faster and larger COM rebound from minimum COM to toe-off,
followed by greater aerial time") — descriptively, without ranking either
condition.

Speed is checked first: differences beyond 5% relative or 0.15 m/s set
`speedComparable: false`, scale every pattern confidence to 0.6×, and render a
prominent, non-collapsible warning. An unknown speed in either condition is
called out rather than assumed. A legacy `kfo` analysis cannot be compared
against a `pgi` one — the stored quantities are not the same measurements.

Neither condition is ranked. Overall comparison confidence is bounded by the
weaker of the two analyses.

---

## 9. Tests

`node esformlab/pgi-tests.js` — **143 tests, all passing**. Browser runner at
`esformlab/pgi-tests.html` (admin-gated). `node esformlab/kfo-tests.js` still
passes 172/172 after the demotion.

Fixtures are **physically constructed**, not tuned to the expected answer. The
synthetic runner has a COM that falls during stance and follows a ballistic arc
through flight, and a swing foot that really reaches forward and then either
retracts before contact or does not. The KFO fixtures could not be reused: they
hold the body at constant height and snap the swing foot to its plant position,
so every clip would read as zero retraction and near-zero vertical oscillation.

Coverage maps to the Phase 28 cases: positional overstride, forefoot overstride,
rushed/velocity-mismatch touchdown, combined braking, well-prepared retracting
touchdown, ground-bound runner, slow projection, productive projection,
excessive vertical excursion, collision-heavy, left/right asymmetry, before/after
comparison, low frame rate, unknown treadmill speed, calibrated overground,
right-to-left running, mirrored footage.

Four-phase coverage: clean/parabolic minimum, **inverted image-Y coordinates**
(the visually lowest COM is the detected minimum), broad flat minimum (region +
centre + reduced confidence), multiple local extrema, edge-adjacent minimum,
noisy trajectory, non-zero velocity at the minimum, phase-partition identities
(durations sum to GCT, fractions to 1, velocity = rise/time), deep vs shallow
compression, forward-positive horizontal travel, per-side compression and
rebound-timing asymmetry (skewed fixtures), joint deltas with the ankle/pelvis
refusals, frame-rate gating of angular velocities, the two toe-off velocity
estimates and their cross-check gate, the outcome chain, the descriptive
movement summary, all five stance-organization patterns on physically
constructed fixtures, the unreliable-minimum withholding gate, the rebound
comparison pattern, storage/rehydration of the v4 blocks, v3-document
compatibility, and copy audits asserting minimum COM is never described as the
onset of propulsion and the rebound phase is never named "propulsive phase".

**Copy audits work by negation checking, not word banning.** Words like
"better", "efficiency" and "measure" appear legitimately — always inside a
denial ("a longer stride is not automatically better"). Each occurrence is
checked against surrounding context for a negation. Banning the words outright
would push the copy into vagueness; requiring the denial is what enforces the
rule. **Do not "fix" a copy-audit failure by deleting the word.**

---

## 10. Limitations and validation path

### Known limitations

- **Nothing here is validated** against force-plate or metabolic measurement.
  Every force-adjacent quantity is a timing- or kinematics-derived estimate.
- ~25 Hz coarse scan gives ~5–6 samples per stance. The dense pre-contact pass
  lifts the pre-contact region to ~30 Hz but only around detected touchdowns, on
  desktop, for up to 3 stances per side.
- **Stance-edge resolution bounds every timing quantity.** In the internal
  validation run a modelled 15 ms GCT difference was not resolved — both
  conditions read 233 ms. Changes smaller than roughly one sample period are
  below the detector's resolution and will read as unchanged.
- The ankle is the foot proxy; for a heel-first contact this understates
  foot-to-COM offset.
- **Minimum COM is a kinematic landmark, not a force event.** Its alignment
  with the AP GRF zero crossing is unknown until force-plate validation; flat
  minima limit its temporal precision (disclosed via the region window and
  reduced confidence); ~5–6 stance samples bound how finely the phase split can
  be located.
- Ankle plantarflexion and pelvis orientation are permanently unavailable from
  COCO-17 sagittal pose; the shank angle carries the distal-segment motion.
- 2D sagittal only; camera perpendicularity is inferred, not measured.
- Interpretation thresholds are provisional and speed-dependent.
- Grade is captured nowhere, so "level surface" remains an assumption.
- Arm metrics degrade with far-side occlusion; hand-to-midline is permanently
  unavailable on sagittal video.
- The ballistic-implied calibration makes the flight-time cross-check circular;
  this is flagged, not hidden.

### What still requires force-plate validation

Braking impulse, propulsive impulse, vertical impulse, effective vertical
impulse, peak vertical force, GRF angle, loading rate, COP trajectory — and the
relationship between the timing-derived mean vertical support and measured mean
vertical force. `pgi-export.js` exists to make that study possible: stride-level
and frame-level rows with raw *and* smoothed trajectories, stance-state and
event labels, and full provenance.

**Minimum COM vs the force events.** The four-phase model adds a specific
force-plate question: how closely does the video-detected minimum-COM timing
align with (a) the AP GRF zero crossing (braking → propulsion), (b) peak
vertical GRF, (c) peak braking and peak propulsion? The export carries
`minimumComTimeSeconds`/`minimumComStancePercent` per stride precisely so those
alignments can be quantified against synchronized force-plate data. Until then,
minimum COM stays labelled the *vertical COM reversal*, never the
braking-to-propulsion transition.

### Recommended next internal validation step

A **matched before/after pair** at the same speed, where the observed direction
is known: after = lower cadence, shorter GCT, longer stride, higher vertical
oscillation, cleaner touchdown and rebound.

The goal is **not** to force the algorithm to label the second condition
"better". It is to verify the software accurately describes *why* the two
conditions are mechanically different.

Status of that check on synthetic fixtures reproducing those directions:

```
PRE   GCT 233ms | flight 117ms | DF 0.667 | cadence 171 | VO  9.7cm | step 1.225m | support 1.50BW
POST  GCT 233ms | flight 133ms | DF 0.636 | cadence 164 | VO 11.9cm | step 1.283m | support 1.57BW

productive_projection (80%)
  "Greater vertical excursion appears to be contributing to useful aerial time
   rather than simply increasing bounce. Contact time did not lengthen and
   flight time increased alongside the larger excursion."

improved_touchdown_preparation (70%)
  "The foot had more time to organise before contact in the second condition."
```

A naive "lower vertical oscillation is better" rule would have preferred the PRE
condition. A test asserts this explicitly, including that no language penalising
the increase appears anywhere in the output.

**Still required with real video:** the same pair shot on the same day at
matched speed, with the runner's height entered so lengths are calibrated, and
ideally on a treadmill with a known belt speed so ground-relative foot velocity
becomes available — that is the single metric most likely to distinguish the
"scuffing" pre-change contact from the post-change one, and it is exactly the
metric the current pipeline most often has to withhold.
