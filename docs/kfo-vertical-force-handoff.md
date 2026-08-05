# Handoff — KFO vertical force from timing

> **SUPERSEDED — historical.** The work this note asks for was completed in
> `74d7c1a` (vertical force wired in as the headline) and extended in the
> impulse-accounting follow-up (schema v3). Read
> `docs/kinematic-force-orientation.md` sections 2 and 11b and
> `docs/kinematic-force-orientation-refactor.md` section 7 for the current state.
> The "Hard rules", "Traps" and "Flags" sections below are still accurate and
> still binding; the "Remaining work" list is done.

Paste this into a new chat to continue. Repo: `/home/finalforms/endurancesciencelabs`
(Endurance Science Labs, static site, vanilla browser JS, no build step, deploys on
push to `main` via GitHub Pages).

---

## Read these first

1. `docs/kinematic-force-orientation.md` — the feature as shipped
2. `docs/kinematic-force-orientation-refactor.md` — audit, decisions, departures
3. This file

The evidence base is an internal synthesis, *Running Force Direction, Stride
Length, and Form Mechanics* (August 2026), covering Dorn 2012, Clark 2012,
Cavanagh & Lafortune 1980, Nilsson & Thorstensson 1989, Munro 1987, Weyand 2000,
Hamner 2010, Schache 2011, plus form/economy studies. **Ask the user to re-attach
it** — its numbers are load-bearing and are not all reproduced here.

---

## Where things stand

**Shipped and pushed** (`cfd6ad9`, scope-corrected by `505002a`): Kinematic
Force-Orientation (KFO) V2, replacing an earlier "Force-Vector Analysis"
prototype. Admin-only, flag-gated. It estimates the **orientation** of the support
line (support point → COM) at three stance windows, aggregated across strides,
with uncertainty. Files: `esformlab/kfo-{core,reference,estimators,analysis,render,export,app,tests}.js`,
`kfo-tests.html`. 85 tests pass via `node esformlab/kfo-tests.js`.

**The problem with what shipped:** the stakeholder (Paul MacKinnon) wants
something much closer to **vertical vs horizontal force**, not an orientation
angle. Orientation alone says which way the support line points, never how hard
the runner pushes.

**Uncommitted-then-committed WIP:** `esformlab/kfo-vertical-force.js` — written,
self-validated, and **deliberately NOT wired into the app** (it is absent from
`index.html`'s script tags, so it is completely inert). This is the piece to
finish.

---

## The task

Finish integrating `kfo-vertical-force.js` so the MVP reports **vertical force
magnitude in bodyweights** as its headline, with the support-line angle demoted to
a secondary geometric descriptor.

### Why this approach (do not re-litigate without reading the synthesis)

The literal ask — a vertical/horizontal percentage — is a trap. Clark et al.
measured the ratio at 5.86:1 at 5 m/s and 5.85:1 at each athlete's top speed:
~5.2% change across a runner's whole speed range. **Everyone scores ~85/15**, so
it cannot discriminate athletes, and it is definition-dependent (the same Clark
data is 85/15 by component-sum share, 98.6% by projection on the resultant, 97.2/2.8
by squared-component). What *does* vary between runners is force **magnitude**.

Magnitude is recoverable from timing alone. Over one complete step at steady
state, vertical momentum change is zero, so:

```
integral(Fz dt) over contact = m*g*T_step
mean Fz / bodyweight = T_step / t_contact = 1 / dutyFactor     [EXACT]
peak Fz / bodyweight ~= (pi/2) / dutyFactor                    [half-sine approx]
```

The second is the spring-mass flight-time method (Morin et al. 2005; Patoz et al.
2023). **No scale calibration, no body mass, no COM tracking** — only timing. That
is why it works on video where the COM-acceleration route does not.

Already validated in-repo against Dorn 2012's measured peak vertical GRF:

| Speed | Duty factor | Predicted peak | Dorn measured | Ratio |
|---|---|---|---|---|
| 3.49 m/s | 0.637 | 2.47 BW | 2.71 BW | 0.910 |
| 5.17 m/s | 0.533 | 2.95 BW | 3.10 BW | 0.951 |
| 6.96 m/s | 0.507 | 3.10 BW | 3.58 BW | 0.865 |
| 8.99 m/s | 0.514 | 3.05 BW | 3.59 BW | 0.850 |

A consistent 5–15% **underestimate**. No empirical correction is applied on
purpose — fitting a fudge factor to four points from one study would manufacture
precision. The bias is disclosed in `peakBiasNote`.

### Consistency requirement (important)

`shared/run-load-model.js` **already** uses `peak vGRF ∝ 1/duty factor` with the
same citations (see `kImpact: 1.0` at line ~23, and the references block ~line
295). It expresses duty factor as the proxy `cadence(spm) × GCT(ms)`, with
`baseDF: 42408` as the easy-run fallback. The identity is
`dfProxy = 60000 × dutyFactor`, and `kfo-vertical-force.js` already emits
`runLoadDfProxy` in exactly that convention. **Keep these two in agreement** — a
video-derived duty factor and a device-derived one must be comparable. Do not
introduce a second, different duty-factor definition.

---

## Remaining work

1. **Wire it in.** Add `<script src="kfo-vertical-force.js"></script>` to
   `esformlab/index.html` (after `kfo-core.js`, before `kfo-analysis.js`).
2. **Call it from `kfo-analysis.js` `analyze()`.** It needs
   `left.stanceIntervals`, `right.stanceIntervals` (both already produced) and
   `videoMetadata.effectiveSampleRateHz`. Attach the result as
   `envelope.verticalForce`.
3. **Render it as the headline** in `kfo-render.js`: a card showing peak and mean
   Fz in BW with uncertainty, duty factor, contact/flight time, cadence. Demote
   the three support-line angle cards to a secondary row.
4. **Persist it** via `KFOAnalysis.toStoredForm()` (aggregate only — no per-step
   detail in Firestore).
5. **Export it** — add per-step columns to `kfo-export.js` stride rows.
6. **Tests.** Add a suite to `kfo-tests.js`: the Dorn validation table above as
   assertions, duty-factor recovery from fixtures, walking/double-support refusal,
   Jensen's-inequality ordering (see traps), and a copy-audit test that the
   rendered force value is never called a *measured* force.
7. **Docs.** New section in `docs/kinematic-force-orientation.md`.
8. **Commit and push** (the user wants every completed change pushed).

### Verify with

```bash
cd /home/finalforms/endurancesciencelabs/esformlab
node kfo-tests.js                 # must stay green; 85 tests before your changes
```

There is no test framework and no root `package.json` — do not add either. Tests
are a hand-rolled assertion harness that also runs in the browser via
`kfo-tests.html`.

---

## Hard rules — violating these is the main risk

**SCOPE: force-vector MVP only.** The user was explicit after an earlier
overreach: *no other part of the gait analysis may change.* Concretely, with the
feature inactive:
- nothing renders,
- `KFOApp.storedFields()` returns `{}` so a save is byte-identical to a
  pre-feature save (**do not add root-level fields to the analysis document** —
  the schema version lives inside the `kfo` block),
- the side scan retains no samples (`KFOApp.shouldCapture()` gates
  `window.__kfoSamples`).

An earlier commit broke the first two; `505002a` fixed it. Don't regress it.
Do **not** touch detection rules, angles, reference ranges, report copy, or stride
cards.

**Known out-of-scope item, deliberately left alone:** three strings in
`gait-engine.js` (lines ~369, ~430, ~440) and two in `index.html` (~328, ~353)
claim arm carriage affects "rotational drag" and vertical push-off. That claim is
not supported — Hamner et al. found arms contribute **<1% of peak COM
acceleration**, and Arellano & Kram found restricting arm swing *increases*
metabolic cost because arms balance angular momentum rather than propel the COM.
It is a real defect, but it is in the main gait report, not this MVP. Leave it
unless the user asks.

**Scientific rules that must not regress:**
- Never call any of this a measured ground-reaction force. `isValidated: false`.
- A near-vertical late stance is **not** a deficiency. Dorn A1–A6 make stride
  length monotonic in effective *vertical* impulse with no V:H ratio in the
  equation; the 45° optimum needs a fixed-launch-speed constraint that steady
  running does not satisfy. The old prototype's "under-propulsive" label was wrong.
- Braking and propulsion are **coupled**. Larger fore-aft excursion = more braking
  and re-propulsion demand, never "better drive".
- Reference similarity ≠ efficiency or economy. The reference store ships
  **empty** on purpose; do not seed invented numbers.
- Vertical/horizontal "shares" are **scalar-sum shares**, not direction cosines.
  `atan(JhAbs/Jv)` is **not** a vector angle (JhAbs sums opposing directions).
- Never use exact foot-strike/toe-off as force events (force ≈ 0 there).

---

## Traps

- **Jensen's inequality.** `1/DF` is convex, so compute force **per step and then
  aggregate** — never from the mean duty factor. `kfo-vertical-force.js` already
  does this; keep it that way, and assert it in a test.
- **Sampling resolution is the binding constraint.** Stance edges come from the
  ~25 Hz scan (150 samples per clip), not native fps, so per-step contact time
  carries roughly 7% error; multi-stride averaging is what makes it usable
  (~2–3% over 10 steps). `timingUncertainty()` models the **random** part only —
  systematic plateau-edge bias does not average out and is the reason force-plate
  validation is still required. Say so in any UI.
- **The horizontal half is genuinely unavailable, not merely unimplemented.** Net
  horizontal impulse ≈ 0 at steady speed (Munro saw braking and propulsive
  impulses rise together), so there is no net horizontal force to report. The
  discriminating quantity is braking impulse magnitude, needing either force
  measurement or a speed estimate (`Jbrake/BW = ΔVx/g`). **Speed is captured
  nowhere in the pipeline** — this is also why `speed_unknown` fires on every KFO
  analysis. `kfo-vertical-force.js` returns this explicitly in `horizontal`; do
  not fabricate a value.
- **Steady state is assumed.** Acceleration or grade breaks the impulse identity.
  KFO already has an `acceleration_detected` flag; wire it in as a caveat.
- Duty factor predicts peak force but **not loading rate** (van Oeveren 2021),
  and its between-runner ceiling is R² ≈ 0.59 — strong for timing-only, far from
  a measurement.

---

## Flags

`localStorage`, prefix `esl-kfo-`; `KFOApp.help()` lists state. All additionally
gated on `esLabs.isAdmin()`, which is the hard gate.

| Flag | Admin default |
|---|---|
| `kinematicForceOrientationV2` | on |
| `experimentalComForceEstimator` | off |
| `forceValidationTools` | off |
| `legacyForceVectorV1` | off |

One-off override: append `?esl-kfo-<flag>=1` to the URL.
