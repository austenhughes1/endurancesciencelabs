# Kinematic Force-Orientation (KFO) refactor — implementation note

Internal note covering the refactor of the admin "Force-Vector Analysis" prototype
into the versioned, scientifically-scoped **Kinematic Force-Orientation** system.

Status: V2 implemented behind feature flags, admin-only. V1 retained as legacy.

---

## 1. What the audit found

### Stack

Vanilla browser JavaScript, ES5-flavoured, no build step, no module system, no
package manager at the repo root. Scripts are plain `<script src>` tags in
`esformlab/index.html`. Firebase 10.7.1 compat SDK. Pose estimation is
TensorFlow.js 4.10.0 + `@tensorflow-models/pose-detection` 2.1.3 (MoveNet).

Consequence for Phase 1 ("use strong domain types where the language permits"):
the language does not permit. Delivered equivalent = `Object.freeze`d enum
objects + JSDoc `@typedef` blocks + a hand-rolled assertion test harness. No
TypeScript, no Jest, no new runtime dependencies.

### Pose / video pipeline

- `esformlab/index.html` `startAllVideos()` drives everything.
- Side clip is scanned at **N = 150** sampled frames (75 on mobile), seeking by
  timestamp — *not* decoding every native frame. On a 6 s clip that is ~25 Hz
  effective sampling.
- MoveNet Thunder on desktop; Lightning for the mobile scan pass.
- COCO-17 keypoints, `MIN_CONF = 0.25` (`gait-data.js`).
- Each sampled frame pushes a record into a local `samples` array containing
  `{t, lAnkleY, rAnkleY, lAnkleX, rAnkleX, hipMidX, lHipExt, rHipExt, lKnAngle,
  rKnAngle, conf, scale, kps}` — **including full keypoints** (`index.html:1265`).
- `samples` is then filtered by body scale (≥55% of median, rejects
  too-far/too-small frames) and passed to `findPhases()`.
- **`samples` was a function-local variable and was discarded after phase
  detection.** This was the single most important audit finding: the data needed
  for multi-stride analysis was already being computed and then thrown away.

### Event detection (reused, not reinvented)

`findPhases()` (`index.html:1529`) already contains exactly the primitives
multi-stride aggregation needs:

- `localPeaks(key, minSpacing)` — all local maxima of a signal. Ankle-Y maxima =
  stance (ankle at its lowest point in image coordinates).
- `prominenceFilter(peaks, key, pct)` — keeps peaks above a percentile.
- `findStancePlateau(key, peakIdx)` — walks both directions from a peak while
  ankle-Y stays within `plateauTol` (5% of trunk height, scale-normalized),
  tolerating one noisy sample. Returns `{lo, hi}` = **the stance interval**.

The production code then *discards all but the single best-scoring peak per side*
and keeps only the plateau edges as `l_foot`/`l_toe`/`r_foot`/`r_toe`.
`refineLegPlateau()` re-scans at ~30 Hz in a ±0.20 s window to sharpen those
edges only.

So stance intervals for *every* clean stride were already derivable. V2 recovers
them instead of collapsing to one.

### COM estimation

`force-vector.js` `computeCOM()` — Winter segment-mass weighted whole-body COM
over 10 segments, renormalized across visible segments, falling back to hip
midpoint when < 40% of body mass is visible. Head uses nose as proxy (only
landmark above the shoulders in COCO-17). This is sound and is carried into V2
unchanged.

### Support / contact point

V1 used **the ankle keypoint** as the contact point for every phase. COCO-17 has
no foot, heel, or toe landmark, so a true phase-specific support point is not
directly observable. V2 keeps the ankle as the anchor but applies a documented
phase-specific longitudinal offset (see `kfo-core.js` `SUPPORT_POINT_MODEL`) and
labels it *estimated support point*, never COP.

### Existing force-vector calculation (V1)

`esformlab/force-vector.js` + `force-vector-admin.js`:

- θ = signed angle from vertical of the contact→COM line, via `atan2`.
- Computed at exactly `l_foot`, `r_foot`, `mid`, `l_toe`, `r_toe`.
- Elite target θ derived from the elite **foot-offset** distribution via
  `getCombinedStats()` and `θ = atan2(-footOffset, R)`, `R = 1.6`.
- Gaussian similarity score per phase; arithmetic mean presented as
  "Mean alignment n/100".
- Rendered by `renderForceVectorReport()`, gated on `isAdmin()`.

### Reference data

`reference_sessions` (Firestore) stores per-phase **scalar metrics only** —
trunk lean, L/R knee, L/R hip, L/R elbow, L/R foot offset — plus athlete
metadata. **No keypoints.** `computed_ranges/{male,female,combined}` holds
`{center, spread, mean, sd, n, reliable}` per phase/metric; `MIN_N = 5`.
`phase_labels` does store full `kps`, but only for hand-labelled side-view
frames — sparse, not a population.

Therefore θ cannot be recomputed on elite poses, and no speed is recorded
anywhere. Both facts constrain Phase 7.

### Persistence / API shape

Saved analyses: `users/{uid}/analyses/{id}` =
`{name, date, createdAt, sex, phases:{key:{t, metrics, frontBackMetrics,
quality}}, issues}`.

- **No `schemaVersion` field.**
- **No keypoints stored**, so KFO cannot be back-computed for historical
  analyses.

### Tests / flags

No test infrastructure anywhere in the repo. Admin gating is
`esLabs.isAdmin()` (`shared/site.js`, UID compare) with a `requireAdmin` option
on `mountAuthGate`. No feature-flag system existed; only `localStorage`
precedent is `esl-theme`.

Manual event adjustment exists and matters: `epStep()` / `epReanalyze()` let a
reviewer move a phase to a different frame, and `analyzeCard()` re-runs
detection and re-renders. Admin-only "Correct frame" labelling writes to
`phase_labels`.

---

## 2. Decisions taken, including departures from the brief

The brief invited disagreement on first-principles grounds. Departures:

**D1 — `thetaImpulse = atan(JhAbs / Jv)` is defined but flagged as *not an
angle*.** `JhAbs = Jbrake + Jprop` sums two *opposing* force directions, so an
arctangent of it corresponds to no physically realisable resultant orientation.
This is precisely the error the evidence synthesis warns about ("a ratio made
from non-simultaneous peaks … is not the orientation of a real instantaneous
resultant vector"). Kept in the domain definitions for completeness, named
`foreAftDemandAngleEquivalent`, documented as a scalar demand descriptor with
angle units, and excluded from any UI that draws or describes a vector.

**D2 — Late-stance scoring no longer rewards larger propulsive angle.** V1's
`classify()` returned "Under-propulsive (force too vertical at push-off)" for
θ < 5°, treating vertical orientation as a fault. Dorn A1–A6 make stride length
monotonic in *effective vertical impulse* (`dL/dI = v_x/(gm) > 0`), with no
vertical:horizontal ratio in the equation, and the 45° optimum only appears
under a fixed-launch-speed constraint that steady running does not satisfy. So a
near-vertical late-stance support line is not a deficiency. Late stance is now
reported descriptively and interpreted only *jointly* with early stance.

**D3 — V1's hand-set targets are deleted, not ported.** `l_toe/r_toe ideal =
+18°` had no source. Clark et al. put the phase-average resultant at ~9.7° from
vertical. Rather than substitute one invented number for another, the reference
table ships **empty** and the UI states that no reference is loaded.

**D4 — The reference table contains no seeded values.** The brief's example
record (`mean: -8.9, sd: 4.0, sampleSize: 79`) is illustrative. Seeding it would
manufacture a provenance that does not exist. `kfo-reference.js` ships with an
empty `RECORDS` array plus one clearly-labelled `derived_from_foot_offset`
provider that reuses the existing elite foot-offset stats and is marked
`validationStatus: 'derived_kinematic'`, `provenance: 'derived'`, with its own
`R = 1.6` assumption disclosed in the payload.

**D5 — `speed_unknown` carries a *reduced* confidence penalty for orientation
specifically.** Clark et al. found the vertical:horizontal force ratio nearly
speed-invariant (5.86:1 at 5 m/s vs 5.85:1 at top speed; ~5.2% change across
each runner's range). Orientation is therefore less speed-sensitive than
impulse or stride-length metrics. Encoded as a smaller weight in the uncertainty
model rather than a blanket penalty, with the reasoning cited in code.

**D6 — Multi-stride uses the retained coarse samples, not a new native-fps
pass.** Densifying every stance to native fps would multiply pose inference cost
by roughly an order of magnitude on a feature no user sees yet. V2 instead keeps
the already-computed `samples` array and interpolates within it. At ~25 Hz a
200–250 ms stance yields only ~5–6 samples, so the stance-window percentages are
interpolated between bracketing samples and `sparse_stance_sampling` is raised
whenever a stance has < 6 samples. This is a documented accuracy ceiling, not a
silent one.

**D7 — Sub-degree precision is suppressed at the formatting layer.** Rather than
trusting call sites, `formatAngle()` in `kfo-core.js` takes the uncertainty and
chooses the precision, so a ±2.7° estimate cannot render as "−8.94°".

---

## 3. Files created / changed

Created:

| File | Purpose |
| --- | --- |
| `esformlab/kfo-core.js` | Enums, JSDoc types, support-line math, stance model, aggregation, uncertainty, coupled pattern, impulse definitions |
| `esformlab/kfo-reference.js` | Reference-distribution store + selection with speed/quality fallback |
| `esformlab/kfo-estimators.js` | `ForceEstimator` interface, `GeometryProxyEstimator`, experimental `ComAccelerationEstimator` (Savitzky–Golay) |
| `esformlab/kfo-analysis.js` | Orchestration: stance detection → per-stride sampling → aggregation → result assembly (schema v2) |
| `esformlab/kfo-render.js` | Admin UI: summary cards, detail view, overlay, legacy V1 comparison |
| `esformlab/kfo-export.js` | Research export (JSON + CSV), force-plate import, validation statistics |
| `esformlab/kfo-tests.js` | Unit + integration + copy-audit tests (runs in node and browser) |
| `esformlab/kfo-tests.html` | Admin-only browser test runner |
| `docs/kinematic-force-orientation.md` | Feature documentation (what it measures / does not) |
| `docs/kinematic-force-orientation-refactor.md` | This note |

Changed:

- `esformlab/index.html` — script tags, `window.__kfoSamples` retention, KFO
  render hooks, flag bootstrap.
- `esformlab/saved-analyses.js` / `auth-paywall.js` — persist `schemaVersion`
  and the `kfo` block on new saves.
- `esformlab/force-vector.js`, `force-vector-admin.js` — retained unchanged as
  **legacy V1**, now only reachable with the legacy flag on.

---

## 4. Migration strategy

Historical analyses have neither a version nor keypoints.

**Scope constraint:** this feature must not alter the shared analysis document, so
the version is stored *inside* the `kfo` block rather than at the document root.
A save made without the feature active is byte-identical to a pre-feature save.
(An early revision stamped a root-level `schemaVersion` for every user; that was
out of scope and was reverted. `migrateAnalysis()` still accepts a root-level
version on read, for the few documents written during that window.)

1. Absence of any version ⇒ treated as **version 1**.
2. `kfoMigrate()` (`kfo-core.js`) normalises any stored analysis to the current
   in-memory shape. For v1 input it returns a v2 envelope with
   `kfo.availability = 'unavailable'` and
   `reason = 'analysis_predates_kinematic_force_orientation'`.
3. Rendering is version-aware: a v1 analysis shows an explicit "not available for
   this saved session" state rather than an empty or fabricated panel.
4. No stored document is rewritten or reinterpreted in place. Migration is
   read-time only.
5. When the feature is active, a save adds only the `kfo` aggregate block, which
   carries its own `schemaVersion`. Stride-level detail is not persisted to
   Firestore — it is export-only, to avoid bloating user documents.

---

## 5. Known limitations

- **Effective sampling rate.** ~25 Hz scan, ~5–6 samples per stance. Stance-window
  angles are interpolated. Raises `sparse_stance_sampling`.
- **No speed, grade, or surface anywhere in the pipeline.** All reference
  selection falls back to broad, and `speed_unknown` / `grade_unknown` are
  always raised.
- **No foot/toe landmark.** Support point is ankle-anchored with a modelled
  phase offset. It is not COP.
- **2D sagittal only.** Out-of-plane motion and perspective are unmodelled;
  camera-perpendicularity is inferred, not measured.
- **Reference table is empty by design.** Reference similarity is unavailable
  until real reference data is loaded, or the derived foot-offset provider is
  explicitly enabled.
- **The COM-acceleration estimator is unvalidated.** Double differentiation of a
  ~25 Hz, pixel-quantised COM trajectory is noise-dominated even after
  smoothing, and there is no scale calibration (pixels → metres) or body mass in
  the pipeline, so it emits body-weight-normalised *shape* only. Admin flag,
  never user-facing.
- **No force-plate data exists yet**, so the validation harness is exercised
  only by synthetic fixtures.

---

## 6. Rollout

Flags (see `docs/kinematic-force-orientation.md` for how to set them):

- `kinematicForceOrientationV2` — default **on for admin**, off otherwise.
- `experimentalComForceEstimator` — default **off**.
- `forceValidationTools` — default **off**.
- `legacyForceVectorV1` — default **off**; shows the old panel for comparison.

Progression: admin testing → V1/V2 comparison on the same clips → resolve
regressions → selected users → collect quality data → force-plate validation →
only then consider stronger GRF terminology.

---

## 7. Follow-up: impulse accounting (schema v3)

An incremental follow-up, not a second refactor. The V2 work above is untouched:
same three stance windows, same aggregation, same uncertainty model, same
reference separation, same coupled braking/propulsion interpretation.

### Why

The product discussion had been carrying a single "vertical/horizontal ratio",
originally as 80/20. That quantity does not exist. Reconstructing Clark, Ryan &
Weyand's rounded means at 5 m/s, the *same trial* reads as 85.7%, 71.2% or 55.3%
vertical depending on whether total or effective vertical impulse is used, and
whether the horizontal term is propulsion alone or the full braking + propulsion
turnover. Presenting any one of them as "the" ratio would have been wrong in a way
that is very hard to walk back once it is in a coach's vocabulary.

### Decisions

- **Three named compositions, never reconciled.** `total_support_replacement`,
  `projection_replacement`, `active_projection_turnover`. Every share carries its
  `verticalBasis`, `horizontalBasis` and `shareConvention`. A field named only
  `verticalHorizontalRatio` is banned, and a test asserts it does not exist.
- **Total vs effective vertical impulse are separate fields.** `JvEffective` is
  Dorn's projection quantity; `JvTotal` is dominated by bodyweight support, which
  is why the first composition is identical at 5 m/s and at top speed and
  therefore cannot discriminate athletes.
- **`JxNet` is a quality check, not a metric.** Near-zero is the expected steady
  state, not an achievement. Above a provisional imbalance threshold, normative
  comparison is withheld and every plausible cause is listed rather than one being
  guessed.
- **Thresholds are provisional and labelled as such.** No published cutoff exists
  for "steady enough to compare", so `CONFIG` values are internal working numbers
  carrying `isProvisional: true`.
- **Landing is partitioned, not removed.** No generic impact component is
  subtracted; a test asserts an early half plus a late half sums to the whole
  vertical integral. Vertical impact metrics stay unavailable below 200 Hz.
- **Zero-crossing splitting.** Braking and propulsion integrate with sub-interval
  splitting at `Fx = 0` rather than bucketing whole intervals by mean sign, which
  matters most exactly where the fore-aft trace spends the most time.
- **Shares aggregate per stance, then combine.** Same Jensen's-inequality
  discipline the timing force estimate follows; the pooled value is kept only as a
  diagnostic.
- **Body mass is not required.** Bodyweight-normalised integration yields BW·s
  directly, so the experimental COM estimator no longer needs a mass — only the
  scale calibration, which it already refused to run without.
- **`available` is reserved for criterion-validated force.** A source that merely
  declares itself validated still reads `experimental`, and
  `isEfficiencyValidated` stays `false` even then: validated impulses are not a
  validated efficiency claim.

### Departures from the brief

- **No new efficiency score, and no reference distributions.** The brief allowed
  percentile comparison "if reference data are later available". None is, so none
  is shipped and the momentum-preservation narrative says so rather than banding
  against invented numbers.
- **The unavailable impulse block persists as a two-field marker**, not the full
  tree of nulls the suggested schema implies. On every current path the whole
  structure is null, and ~6 KB per user document to say "nothing here" is not a
  trade worth making. The shape is rebuilt at read time.
- **`estimator_inconsistency` is defined but never emitted.** It needs two
  estimators to disagree, and only one force path exists.
- **Fatigue-zone work is architecture only** — no UI, no storage, no caller —
  because nothing in the repository captures repeated gait windows yet.

### Backwards compatibility

`SCHEMA_VERSION` 2 → 3, with an exact-match v2 adapter. A v2 document keeps every
field it had and gains an explicitly-unavailable impulse block; it is never treated
as pre-KFO, and a stored angle is never reinterpreted as an impulse ratio. Both are
asserted in tests, including that a v2 save still renders its force card and angle
cards without NaN.

### Scope

Unchanged and re-verified. With the feature inactive nothing renders,
`storedFields()` returns `{}`, and the side scan retains no samples. The only
edits outside the `kfo-*` files are two `<script>` tags in `esformlab/index.html`.
