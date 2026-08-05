# Kinematic Force-Orientation (KFO)

Admin-only analysis in esFormLab. It reports two things from side-view video:

1. **Vertical force magnitude in bodyweights**, estimated from stance and flight
   timing — the headline result (section 2).
2. **The orientation of the support line** across stance, from pose geometry — a
   secondary geometric descriptor (sections 1, 4).

Companion documents:
- `docs/kinematic-force-orientation-refactor.md` — audit, decisions, migration.
- Evidence base: *Running Force Direction, Stride Length, and Form Mechanics*
  (internal synthesis, August 2026).

---

## 1. What it measures

For three windows inside each stance phase, KFO reports the signed angle between
**vertical** and the line running from an **estimated support point** through the
**estimated centre of mass**, aggregated across multiple strides per side, with
uncertainty.

That is the whole claim for the angle. It is a geometric quantity derived from
video, and on its own it says which way the support line points, never how hard
the runner pushes. That is what section 2 is for.

## 2. Vertical force magnitude from timing

`esformlab/kfo-vertical-force.js`. The headline card in the admin panel.

### Why magnitude, and not a vertical/horizontal ratio

The literal request was a vertical-versus-horizontal force percentage. That
number cannot do the job:

- **It does not discriminate athletes.** Clark et al. measured the ratio at
  5.86:1 at 5 m/s and 5.85:1 at each athlete's own top speed — about 5.2% change
  across a runner's entire speed range. Everyone scores roughly 85/15.
- **It is definition-dependent.** The same Clark data reads 85/15 by
  component-sum share, 98.6% by projection on the resultant, or 97.2/2.8 by
  squared-component share. A single "85/15" with no stated convention is not a
  result.

Force **magnitude** does vary between runners (Dorn: peak vertical 2.71 → 3.58 BW
across speed; Weyand: 1.26× greater support force in faster runners), and it is
recoverable from timing alone.

### The physics

Over one complete step at steady state, vertical momentum change is zero, so the
vertical impulse during contact must support bodyweight for the whole step:

```
∫ Fz dt over contact = m·g·T_step
mean Fz / bodyweight = T_step / t_contact = 1 / dutyFactor      EXACT
peak Fz / bodyweight ≈ (π/2) / dutyFactor                       half-sine approx
```

where `dutyFactor = t_contact / T_step` and a **step** is one contact plus the
flight that follows it.

The first line is not a model — it follows from steady-state running. The second
is the spring-mass flight-time method (Morin et al. 2005, refined by Patoz et al.
2023) and is algebraically identical to Morin's `Fmax = mg·(π/2)·(tf/tc + 1)`,
since `tf/tc + 1 = 1/dutyFactor`.

**It needs only timing.** No scale calibration, no body mass, no COM tracking.
That is precisely why it works on video where the COM-acceleration route
(section 13) does not.

### Accuracy against measured force

Checked in `kfo-tests.js` against Dorn et al. 2012's force-plate peak vertical GRF:

| Speed | Duty factor | Predicted peak | Dorn force plate | Ratio |
| --- | --- | --- | --- | --- |
| 3.49 m/s | 0.637 | 2.47 BW | 2.71 BW | 0.910 |
| 5.17 m/s | 0.533 | 2.95 BW | 3.10 BW | 0.951 |
| 6.96 m/s | 0.507 | 3.10 BW | 3.58 BW | 0.865 |
| 8.99 m/s | 0.514 | 3.05 BW | 3.59 BW | 0.850 |

A consistent 5–15% **underestimate**. **No empirical correction is applied, on
purpose** — fitting a factor to four points from one study would manufacture
precision. The bias is disclosed in `peakBiasNote` and shown in the UI, and a
test asserts the mean ratio stays below 0.97 so nobody can quietly add one later.

Honest ceiling: van Oeveren et al. 2021 found duty factor the strongest
spatiotemporal predictor of peak vertical GRF *between* runners at R² ≈ 0.59 —
strong for a timing-only estimate, far from a measurement. Duty factor predicts
peak force but **not loading rate**.

### Aggregation, and why per-step

`1/dutyFactor` is **convex**, so by Jensen's inequality the force computed from a
mean duty factor is systematically lower than the mean of the per-step forces.
Force is therefore computed **per step and then aggregated**. A test asserts the
ordering on a fixture with deliberately variable contact times, and the export's
per-step columns are taken from the step records rather than re-derived from the
aggregate.

### Uncertainty

`timingUncertainty()` treats each stance edge as uniform within one sample period
(sd = period/√12), with two independent edges per contact. At the ~25 Hz scan rate
that is roughly **7% per step**, falling as 1/√n to roughly **2–3% over 10 steps**.

This is the **random** part only. Systematic bias in plateau-edge detection does
not average out, is not modelled, and is the reason force-plate validation is
still required. The two statements are emitted together as a single caveat string
so a shrinking random error can never be quoted on its own as precision.

### What is refused

| Condition | Result |
| --- | --- |
| Overlapping stances (double support) | `double_support_detected_not_running` — walking, no force reported |
| Fewer than 3 usable steps | `insufficient_steps` |
| Consecutive stances on the same side | that pair skipped, `missed_opposite_stance` |
| No flight, or duty factor outside 0.20–0.75 | step rejected with a reason |

Duty factor bounds, contact 0.07–0.50 s, flight ≥ 0.005 s and step ≤ 0.90 s are
in `LIMITS`. Rejections are itemised, never silently dropped.

### The horizontal half is unavailable, not unimplemented

`horizontal.availability` is always `unavailable`, with
`reason: "net_horizontal_impulse_is_near_zero_at_steady_speed"`.

At constant average speed the braking and propulsive impulses cancel (Munro et al.
observed both rising together with speed), so there is **no net horizontal force
to report**. The quantity that would discriminate runners is braking impulse
*magnitude*, which needs either force measurement or a speed estimate
(`Jbrake/BW = ΔVx/g`). Speed is captured nowhere in this pipeline — the same
reason `speed_unknown` fires on every KFO analysis. No value is fabricated.

### Consistency with the Impact Load model

`shared/run-load-model.js` already uses `peak vGRF ∝ 1/duty factor` with the same
citations (`kImpact: 1.0`), expressing duty factor as the proxy
`cadence(spm) × GCT(ms)` with `baseDF: 42408` as the easy-run fallback. The
identity is:

```
dfProxy = 60000 × dutyFactor
```

`runLoadDfProxy` is emitted in exactly that convention so a video-derived duty
factor and a device-derived one are directly comparable. A test asserts both the
identity and that `baseDF` implies a duty factor inside this module's accepted
running range, so the two definitions cannot drift apart unnoticed.

### Framing rules

- Never called a measured force. `isValidated: false`,
  `provenance: kinematic_estimate`.
- Not colour-banded and never labelled good, bad, high, low, optimal or ideal. A
  larger peak vertical force is a larger **load**, not a fault, and not an injury
  claim. A copy-audit test enforces this on the rendered card.
- Every occurrence of the word "measured" in the force card must be negated; a
  test walks the rendered HTML and checks each one.

## 3. What it does **not** measure

- **Not measured ground-reaction force**, neither the angle nor the magnitude.
  The support-line angle is geometry: the spring-mass approximation says stance
  GRF acts roughly along the support line, so the two may correlate, but true GRF
  also depends on COM acceleration, centre-of-pressure migration and segmental
  angular dynamics, none of which are recovered here. The vertical magnitude of
  section 2 is a timing-derived estimate with a disclosed 5–15% low bias.
- **Not horizontal force, at all.** See section 2 — this is a property of steady
  running, not a gap in the implementation.
- **Not an impulse.** `forceMetrics` stays `unavailable`: impulses need a
  force-time series, and a stride-averaged magnitude does not supply one.
- **Not a loading rate.** Duty factor predicts peak force but not the rate at
  which it arrives (van Oeveren et al. 2021).
- **Not centre of pressure.** COCO-17 has no foot, heel or toe landmark. The
  support point is ankle-anchored with a modelled phase offset.
- **Not efficiency, economy, or optimality.** Reference similarity is distance
  from a distribution. The evidence is explicit that a force-direction result
  cannot identify the metabolically optimal amount of vertical oscillation, and
  that trained runners' self-selected mechanics already sit near their own
  oxygen-cost minimum.
- **Not validated.** `isValidated` is `false` for every currently shipping
  method. It stays false until force-plate agreement criteria are met.

## 4. Angle sign convention

Degrees from **true vertical**, in the sagittal plane:

| Sign | Meaning |
| --- | --- |
| negative | braking orientation — support point ahead of the COM along the direction of travel |
| positive | propulsive orientation — support point behind the COM |
| zero | vertically aligned support |

Signs are **normalised for the direction of travel**, so right-to-left and
mirrored footage read identically for identical mechanics. The convention is
defined once, at the top of `kfo-core.js`, and carried on every angle as
metadata (`units`, `referenceAxis`, `signConvention`, `phase`, `side`, `method`,
`provenance`) — a bare number is never passed between modules.

## 5. How the phases are selected

Stance is normalised 0–100%. Three windows:

| Phase | Window | Intent |
| --- | --- | --- |
| Early stance | 10–15% (target 12.5%) | Braking-oriented geometry, after meaningful force has developed |
| Central stance | 45–55% (target 50%) | Vertical support alignment |
| Late stance | 85–90% (target 87.5%) | Propulsive-oriented geometry, before force falls near zero |

**Exact foot strike and toe-off are deliberately excluded.** Force magnitude
approaches zero at those instants, so the resultant's direction there is both
ill-conditioned and mechanically uninformative. Those events remain on the normal
stride-analysis cards, where they are useful for their own reasons.

The central window is not arbitrary: Munro et al. (1987) located the fore-aft
force zero crossing at ~48% of stance — the instant the resultant is closest to
pure vertical support.

Window angles are **interpolated** between bracketing samples rather than snapped
to the nearest frame. Each result carries `selectionMethod`, `targetPercent`,
`actualPercent`, `timestampMs` and `eventConfidence`.

When a validated kinetic estimator exists, `EVENT_SELECTION` already defines the
better anchors: peak braking force, peak vertical force, AP-force zero crossing,
peak propulsive force.

## 6. How the COM is estimated

Winter segment-mass weighted whole-body COM over 10 segments, renormalised across
whichever segments are visible. Falls back to the hip midpoint when less than 40%
of body mass is resolvable. The head uses the nose as a proxy, as COCO-17 has no
cranial landmark. `massCoverage` is reported so a degraded estimate is visible.

## 7. How the support point is estimated

Ankle-anchored, with a longitudinal offset as a fraction of shank length applied
along the direction of travel, walking the estimated contact region posterior →
central → anterior across stance:

| Phase | Offset (shank lengths) |
| --- | --- |
| Early stance | −0.06 |
| Central stance | +0.04 |
| Late stance | +0.18 |

Every result carries `isCentreOfPressure: false`.

## 8. Multi-stride aggregation

Stance intervals are found per side from ankle-Y maxima and their plateaus — the
same algorithm the production phase detector uses, so KFO and the stride cards
cannot disagree about where stance is.

- Minimum 3 strides, recommended 8, maximum 20 (configurable).
- Per phase per side: mean, median, SD, IQR, min, max, quartiles, SEM and a 95%
  confidence interval using a **small-sample t multiplier** (not a flat 1.96).
- Strides are rejected for low pose confidence, implausible stance duration, too
  few samples, or incomplete phase coverage. Counts and reasons are reported.
- Statistical outliers are **flagged, never silently dropped** (1.5×IQR Tukey
  fence); `n`, `min` and `max` still include them.
- Medians lead in user-facing summaries.

## 9. Confidence model

Angular uncertainty is combined in quadrature from independent contributors, all
expressed in degrees: pose-landmark confidence, stance-window interpolation,
perspective/out-of-plane error, occlusion, and stride-to-stride SEM.

A separate 0–1 confidence score starts from pose confidence and is reduced
multiplicatively per quality flag.

**Display precision is driven by uncertainty**, enforced in `formatAngle()` so no
call site can leak spurious precision:

| Uncertainty | Rendering |
| --- | --- |
| ≤3° | `-8.4° ± 2.7°` |
| 3–6° | `-9° ± 5°` |
| >6° | `-17° to -1°` |

Quality flags: `low_frame_rate`, `sparse_stance_sampling`,
`camera_not_perpendicular`, `excessive_perspective`, `landmark_occlusion`,
`low_pose_confidence`, `uncertain_contact_frame`, `insufficient_strides`,
`speed_unknown`, `acceleration_detected`, `grade_unknown`, `mirrored_video`,
`unstable_running_direction`, `high_stride_variability`.

Two deliberate calibrations:

- **`speed_unknown` is penalised only lightly.** Clark et al. found the
  vertical:horizontal force ratio nearly speed-invariant (5.86:1 at 5 m/s vs
  5.85:1 at top speed; ~5.2% change across each runner's range), so *orientation*
  is far less speed-sensitive than impulse or stride-length metrics. This
  penalty must not be reused for impulse-derived quantities.
- **Occlusion is assessed per landmark, not just on average.** Losing the stance
  ankle in a third of frames is only ~4% of all landmark observations but
  disables the support point on those frames, so the worst single landmark drives
  the flag.

## 10. Reference model

`kfo-reference.js` holds a queryable distribution store. Every record carries
metric, phase, side applicability, speed band, grade, surface, population
description, sample size, mean, SD, percentiles, source type, provenance,
validation status and reference version.

**The store ships empty.** V1's hand-set late-stance target of +18° had no
source; substituting a literature number would be no better, because a measured
GRF resultant on a force treadmill and a video-derived support-line angle at a
normalised stance percentage are different quantities. Until real support-line
reference data exists, reference similarity reports as unavailable.

Selection rules:
- Speed known and a band matches → `speed_matched`.
- Otherwise → a record explicitly marked `isBroadFallback`, labelled
  *"Broad reference; running speed unavailable"*, with reduced confidence.
- A narrow speed-specific record is **never** silently substituted.
- Similarity is withheld entirely when data confidence < 0.35.

An optional `derivedProvider` (disabled by default) reuses the existing elite
foot-offset distribution via `θ ≈ atan2(−footOffset, R)`, `R = 1.6`. It is emitted
with `provenance: 'derived'`, `validationStatus: 'derived_kinematic'`, and its
assumption disclosed in the payload. Usable for trend and side-to-side
comparison; not for absolute accuracy.

## 11. Coupled braking / propulsion

Braking and propulsion are interpreted as **one pattern**. Neither is scored
favourably for being large.

Why: in the point-mass relation used by Dorn et al., `L = v_x·I_v,eff/(m·g)`, so
`dL/dI_v,eff = v_x/(g·m) > 0` with zero second derivative — modelled stride length
is monotonic in *effective vertical impulse*, and the equation contains no
vertical-to-horizontal force ratio. The familiar 45° optimum appears only once a
fixed-launch-speed constraint is added, which steady running does not satisfy: a
runner enters stance with horizontal velocity already established. Meanwhile net
fore-aft impulse over a steady-speed step is ≈ 0, and Munro et al. observed
braking and propulsive impulses rising *together* with speed.

So a large early angle paired with a large late angle describes **greater braking
and re-propulsion demand**, not better drive.

| Pattern | Reading |
| --- | --- |
| `low_fore_aft_excursion` | May indicate good momentum preservation; force magnitude unavailable |
| `high_fore_aft_excursion` | May indicate greater braking and re-propulsion demand |
| `braking_dominant` | Braking geometry without matching late-stance propulsive orientation; review event detection and speed stability |
| `propulsion_dominant` | Low braking with strong late-stance propulsive geometry; confirm event timing and acceleration state |

`foreAftGeometricExcursion = |earlyAngle| + |lateAngle|`, a kinematic descriptor
only. Components are always reported separately so the total cannot hide
different patterns. No pattern is labelled efficient or inefficient.

## 12. Formula definitions

Support line:

```
dx = comX - supportX
dy = supportY - comY            # image +y is DOWN, so this is the "up" extent
forward = dx * directionSign     # +1 travelling toward +x, -1 toward -x
thetaFromVertical = atan2(forward, dy)
```

`atan2` throughout — never a slope ratio — so vertical alignment and degenerate
vertical extent need no division. A vertical extent below 15% of shank length is
rejected as an implausible stance frame.

Impulse definitions (defined now, populated only by a force-capable estimator):

```
Jv        = ∫ Fz dt
JvEff     = ∫ (Fz − bodyWeight) dt
Jbrake    = −∫ Fx dt   where Fx < 0
Jprop     =  ∫ Fx dt   where Fx > 0
JhAbs     = Jbrake + Jprop
JxNet     = Jprop − Jbrake                 (≈ 0 at steady speed)
FAD       = JhAbs / Jv
VSS       = Jv    / (Jv + JhAbs)           SCALAR-SUM SHARE
HDS       = JhAbs / (Jv + JhAbs)           SCALAR-SUM SHARE
```

**VSS and HDS are scalar-sum shares, not direction cosines.** They require force
magnitude and time weighting, and must never be synthesised by averaging a few
phase angles. An "85/15" figure is only meaningful stated in this convention —
the same Clark data reads as 85.4/14.6 by component-sum share, 98.6% by
projection on the resultant, or 97.2/2.8 by squared-component share.

`foreAftDemandAngleEquivalent = atan(JhAbs / Jv)` exists for completeness but is
**not a vector orientation**: `JhAbs` sums two opposing force directions, so no
instantaneous resultant points that way. It is a scalar demand descriptor and is
excluded from anything that draws or describes a vector.

Under `geometry_proxy` every **impulse** field is `null` with
`reason: "geometry_proxy_has_no_force_magnitude"`. That is unchanged by section 2:
a stride-averaged vertical magnitude is not a force-time series, so it cannot
produce `Jv`, `Jbrake` or any share. The two live in separate blocks —
`forceMetrics` (impulses, unavailable) and `verticalForce` (magnitude, available)
— precisely so neither can be mistaken for the other.

Vertical force from timing:

```
dutyFactor  = t_contact / T_step          T_step = t_contact + t_flight
meanFzBw    = 1 / dutyFactor              EXACT at steady state
peakFzBw    = (π/2) / dutyFactor          half-sine waveform assumption
dfProxy     = 60000 × dutyFactor          run-load-model.js convention
```

Computed per step, then aggregated — never from the mean duty factor (section 2).

## 13. Methods

| Method | Validated | State |
| --- | --- | --- |
| `geometry_proxy` | no | shipping (admin) |
| `com_acceleration_experimental` | no | implemented, flag-gated, unvalidated |
| `learned_grf_experimental` | no | registered stub, refuses to run |
| `validated_grf` | yes | registered stub, refuses to run |

The experimental COM-acceleration estimator implements `Fx = m·ax`,
`Fz = m·(az + g)` over a Savitzky–Golay-equivalent local polynomial fit (window
and order explicit; raw and filtered trajectories both retained). It **refuses to
run without a pixels-per-metre calibration**, because the force angle depends on
`ax/(az + g)` and gravity is physical — an uncalibrated pixel trajectory yields
neither a magnitude nor an angle. Body mass is optional; without it, output is
body-weight-normalised shape only. Double differentiation of a ~25 Hz
pixel-quantised trajectory is noise-dominated even after smoothing, which is why
nothing from it is user-facing.

## 14. Data model and versions

- `analysisType: "kinematic_force_orientation"`, `schemaVersion: 2`.
- `MODEL_VERSION` in `kfo-core.js`; `REFERENCE_VERSION` in `kfo-reference.js`;
  `EXPORT_VERSION` in `kfo-export.js`.
- **The version lives inside the `kfo` block, not at the document root.** This
  feature adds no fields to the shared analysis document, so a save made without
  the feature active is byte-identical to a pre-feature save. A root-level
  `schemaVersion` is still accepted on read, because a small number of documents
  were written that way before the scope was tightened.
- Absence of any version means **version 1**.
- `migrateAnalysis()` is read-time only and never mutates or rewrites a stored
  document. A v1 analysis becomes an explicit `availability: "unavailable"`
  envelope with reason `analysis_predates_kinematic_force_orientation`.
- Only the **aggregate** block is persisted. Stride-level detail is export-only,
  to keep user documents small. The same rule applies to `verticalForce`: duty
  factor, contact/flight time, step rate and the two force aggregates are stored;
  the per-step records and their rejection list are not. A test asserts no step
  record reaches the stored document.
- Saved sessions are **never recomputed** at view time: they hold no keypoints,
  and the retained sample buffer may belong to a different clip.

## 15. Research export and validation

`kfo-export.js` produces stride-level and frame-level JSON and CSV, with
optional embedded landmarks so any geometry can be re-derived offline. CSV cells
are quoted and leading `=+-@` is neutralised against spreadsheet formula
injection.

Stride rows carry per-step timing and force columns — `stepContactMs`,
`stepFlightMs`, `stepDurationMs`, `stepDutyFactor`, `stepCadenceSpm`,
`stepMeanVerticalForceBw`, `stepPeakVerticalForceBw`, `verticalForceMethod` —
matched to the stride by contact side and start time. Both come from the same
stance intervals, so the times are identical rather than merely close. The final
contact in a clip has no following flight and therefore no step, so those cells
are empty rather than guessed.

Manual event corrections are stored **alongside** automatic values
(`autoFrame`, `adjustedFrame`, `adjustmentReason`, `adjustedBy`, `adjustedAt`) —
the difference between them is the training signal for improving event detection.

Force-plate import accepts `timestamp, Fx, Fy, Fz, COPx, COPy, COPz,
contactSide`, segments contacts on a vertical-force threshold, and extracts the
criterion GRF angle at peak braking, peak vertical force and peak propulsion,
plus the AP zero crossing and true impulses.

Validation statistics: MAE, RMSE, bias, SD of differences, calibration slope and
intercept, correlation and R², Bland–Altman bias with limits of agreement,
speed/side stratification, per-subject holdout, and confidence calibration
(does the reported ± actually cover the error?).

`interpretValidation()` is the gate. **Correlation alone can never satisfy it** —
a biased estimate can correlate almost perfectly — so MAE, absolute bias,
calibration slope, limits-of-agreement width, sample size and subject count must
all pass:

| Criterion | Threshold |
| --- | --- |
| Mean absolute error | ≤ 4° |
| Absolute bias | ≤ 2° |
| Calibration slope | 0.85–1.15 |
| Limits-of-agreement width | ≤ 12° |
| Paired observations | ≥ 100 |
| Subjects | ≥ 10 |

## 16. Feature flags

Stored in `localStorage` under the prefix `esl-kfo-`. A URL query parameter
overrides storage for one page load.

| Flag | Admin default | Effect |
| --- | --- | --- |
| `kinematicForceOrientationV2` | **on** | The V2 panel |
| `experimentalComForceEstimator` | off | Experimental COM-acceleration module |
| `forceValidationTools` | off | Research export + force-plate import UI |
| `legacyForceVectorV1` | off | Superseded V1 panel, labelled legacy |

From the browser console on the esFormLab page:

```js
KFOApp.help()                                            // list flags and state
KFOApp.setFlag('forceValidationTools', true); location.reload()
KFOApp.clearFlag('forceValidationTools'); location.reload()
```

One-off, no persistence: append `?esl-kfo-forceValidationTools=1` to the URL.

Everything is additionally gated on `esLabs.isAdmin()`, which is the hard gate: a
non-admin gets nothing even if a flag is forced on.

**Feature scope.** This feature is confined to itself. With it inactive:

- nothing renders;
- no fields are added to a saved analysis (`storedFields()` returns `{}`);
- the side scan does not retain its samples, so no keypoints are held in memory
  after it returns.

No other part of the gait analysis — detection rules, angles, reference ranges,
report copy, or the stride cards — is altered by this feature.

## 17. Tests

`node esformlab/kfo-tests.js`, or open `esformlab/kfo-tests.html` (admin-gated)
and click **Run all tests**. 110 tests covering angle math and sign convention,
mirroring and direction normalisation, stance interpolation, robust aggregation,
uncertainty, reference selection, schema migration, force-metric availability,
impulse formulas, coupled-pattern classification, estimators, the full analysis
pipeline on synthetic fixtures, export/CSV safety, and the validation harness.

The **vertical force** suite asserts the Dorn 2012 agreement table as a band
(0.84–0.96, never over-predicting), that no correction factor has been fitted,
duty-factor recovery both from explicit intervals and end-to-end from a clip,
walking/double-support refusal, the Jensen's-inequality ordering, that timing
uncertainty falls as 1/√n while still disclosing the systematic part, the
`dfProxy = 60000 × dutyFactor` agreement with `run-load-model.js`, and that the
horizontal block stays unavailable.

A **copy audit** suite asserts on the rendered HTML that no user-visible text
claims a measured ground-reaction force or validated efficiency, that uncertainty
is displayed, that method and model version are accessible, and that the
reframed vocabulary is used. The force card is audited separately and more
strictly: every occurrence of "measured" must be negated, the peak bias and the
systematic-bias caveat must both be visible, and no verdict vocabulary
(good/poor/optimal/excessive) or injury language may appear.

Fixtures are physically faithful rather than tuned to the expected answer: a
synthetic runner plants the foot at a fixed ground position while the body
translates forward, so the support line sweeps braking → vertical → propulsive
for the right mechanical reason.

## 18. Known limitations

- ~25 Hz effective scan rate gives ~5–6 samples per stance on a real clip;
  window angles are interpolation-dominated and `sparse_stance_sampling` is
  raised. This is the dominant accuracy ceiling. It binds the force estimate too:
  stance edges come from that scan, not native fps, so per-step contact time
  carries roughly 7% random error and multi-stride averaging is what makes the
  estimate usable at all.
- The vertical force estimate assumes **steady-speed level running**. Acceleration
  or grade breaks the impulse identity outright. `acceleration_detected` and
  `grade_unknown` are surfaced as caveats on the card, but neither is a correction.
- Systematic plateau-edge bias is not modelled and does not average out.
- Peak force assumes a half-sine waveform and runs 5–15% low against Dorn 2012.
- Between-runner ceiling for duty factor as a peak-vGRF predictor is R² ≈ 0.59.
- No speed, grade or surface anywhere in the pipeline.
- No foot landmark, so the support point is modelled.
- 2D sagittal only; camera perpendicularity is inferred from shoulder/hip overlap,
  not measured.
- Reference store empty by design.
- COM-acceleration estimator unvalidated and uncalibrated by default.
- No force-plate data exists yet, so the validation harness is exercised only by
  synthetic fixtures.

## 19. Next steps toward validation

1. Collect synchronised force-plate or instrumented-treadmill data with
   side-view video, ≥10 subjects, several speeds, both sides.
2. Export stride-level data, import the force trace, establish the sync offset.
3. Run `validationStats` + `interpretValidation`, stratified by speed and side,
   with per-subject holdout.
4. If agreement fails, the most likely culprits in order: stance-window
   sampling resolution, the support-point offset model, and out-of-plane error.
5. Only after the criteria pass may terminology move beyond "estimate", and only
   then should `validated_grf` be implemented.

For the **vertical force** estimate specifically, the same data answers two
narrower questions, and they should be settled before any correction is applied:

1. How large is the systematic contact-time bias from plateau-edge detection at
   ~25 Hz, measured against force-plate contact times? That bias, not the
   half-sine assumption, is the likelier dominant error.
2. Does the 5–15% low bias hold across subjects and speeds? If it does, a single
   disclosed correction becomes defensible. Fitting one to the current four points
   from one study would not be.
