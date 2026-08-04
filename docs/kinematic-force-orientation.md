# Kinematic Force-Orientation (KFO)

Admin-only analysis in esFormLab that estimates the **orientation of a runner's
support line** across stance from side-view pose geometry.

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

That is the whole claim. It is a geometric quantity derived from video.

## 2. What it does **not** measure

- **Not ground-reaction force.** Not magnitude, not direction. The spring-mass
  approximation says stance GRF acts roughly along the support line, so the two
  may correlate — but true GRF also depends on COM acceleration, centre-of-pressure
  migration, segmental angular dynamics and force magnitude, none of which are
  recovered here.
- **Not centre of pressure.** COCO-17 has no foot, heel or toe landmark. The
  support point is ankle-anchored with a modelled phase offset.
- **Not efficiency, economy, or optimality.** Reference similarity is distance
  from a distribution. The evidence is explicit that a force-direction result
  cannot identify the metabolically optimal amount of vertical oscillation, and
  that trained runners' self-selected mechanics already sit near their own
  oxygen-cost minimum.
- **Not validated.** `isValidated` is `false` for every currently shipping
  method. It stays false until force-plate agreement criteria are met.

## 3. Angle sign convention

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

## 4. How the phases are selected

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

## 5. How the COM is estimated

Winter segment-mass weighted whole-body COM over 10 segments, renormalised across
whichever segments are visible. Falls back to the hip midpoint when less than 40%
of body mass is resolvable. The head uses the nose as a proxy, as COCO-17 has no
cranial landmark. `massCoverage` is reported so a degraded estimate is visible.

## 6. How the support point is estimated

Ankle-anchored, with a longitudinal offset as a fraction of shank length applied
along the direction of travel, walking the estimated contact region posterior →
central → anterior across stance:

| Phase | Offset (shank lengths) |
| --- | --- |
| Early stance | −0.06 |
| Central stance | +0.04 |
| Late stance | +0.18 |

Every result carries `isCentreOfPressure: false`.

## 7. Multi-stride aggregation

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

## 8. Confidence model

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

## 9. Reference model

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

## 10. Coupled braking / propulsion

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

## 11. Formula definitions

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

Under `geometry_proxy` every force field is `null` with
`reason: "geometry_proxy_has_no_force_magnitude"`.

## 12. Methods

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

## 13. Data model and versions

- `analysisType: "kinematic_force_orientation"`, `schemaVersion: 2`.
- `MODEL_VERSION` in `kfo-core.js`; `REFERENCE_VERSION` in `kfo-reference.js`;
  `EXPORT_VERSION` in `kfo-export.js`.
- Saved analyses are stamped with `schemaVersion`. **Absence of the field means
  version 1**, forever.
- `migrateAnalysis()` is read-time only and never mutates or rewrites a stored
  document. A v1 analysis becomes an explicit `availability: "unavailable"`
  envelope with reason `analysis_predates_kinematic_force_orientation`.
- Only the **aggregate** block is persisted. Stride-level detail is export-only,
  to keep user documents small.
- Saved sessions are **never recomputed** at view time: they hold no keypoints,
  and the retained sample buffer may belong to a different clip.

## 14. Research export and validation

`kfo-export.js` produces stride-level and frame-level JSON and CSV, with
optional embedded landmarks so any geometry can be re-derived offline. CSV cells
are quoted and leading `=+-@` is neutralised against spreadsheet formula
injection.

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

## 15. Feature flags

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

Everything is additionally gated on `esLabs.isAdmin()`. With all flags off,
nothing renders and no behaviour changes for any user.

## 16. Tests

`node esformlab/kfo-tests.js`, or open `esformlab/kfo-tests.html` (admin-gated)
and click **Run all tests**. 82 tests covering angle math and sign convention,
mirroring and direction normalisation, stance interpolation, robust aggregation,
uncertainty, reference selection, schema migration, force-metric availability,
impulse formulas, coupled-pattern classification, estimators, the full analysis
pipeline on synthetic fixtures, export/CSV safety, and the validation harness.

A **copy audit** suite asserts on the rendered HTML that no user-visible text
claims a measured ground-reaction force or validated efficiency, that uncertainty
is displayed, that method and model version are accessible, and that the
reframed vocabulary is used.

Fixtures are physically faithful rather than tuned to the expected answer: a
synthetic runner plants the foot at a fixed ground position while the body
translates forward, so the support line sweeps braking → vertical → propulsive
for the right mechanical reason.

## 17. Known limitations

- ~25 Hz effective scan rate gives ~5–6 samples per stance on a real clip;
  window angles are interpolation-dominated and `sparse_stance_sampling` is
  raised. This is the dominant accuracy ceiling.
- No speed, grade or surface anywhere in the pipeline.
- No foot landmark, so the support point is modelled.
- 2D sagittal only; camera perpendicularity is inferred from shoulder/hip overlap,
  not measured.
- Reference store empty by design.
- COM-acceleration estimator unvalidated and uncalibrated by default.
- No force-plate data exists yet, so the validation harness is exercised only by
  synthetic fixtures.

## 18. Next steps toward validation

1. Collect synchronised force-plate or instrumented-treadmill data with
   side-view video, ≥10 subjects, several speeds, both sides.
2. Export stride-level data, import the force trace, establish the sync offset.
3. Run `validationStats` + `interpretValidation`, stratified by speed and side,
   with per-subject holdout.
4. If agreement fails, the most likely culprits in order: stance-window
   sampling resolution, the support-point offset model, and out-of-plane error.
5. Only after the criteria pass may terminology move beyond "estimate", and only
   then should `validated_grf` be implemented.
