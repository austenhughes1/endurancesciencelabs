# esFormLab v2: new gait-phase detection

`/esformlab/v2/` is the esFormLab analyzer with rebuilt phase detection. The UI,
copy, report, saving and checkout are the main page's own code; only how the nine
phase frames are found, and how each card's pose is computed, is new. The page is
not linked from anywhere and asks search engines not to index it
(`<meta name="robots" content="noindex, nofollow">`). The live tool at `/esformlab/`
is untouched.

How today's detection works, and why it fails, is in `docs/esformlab.md`
(sections 6 and 14). This file covers what v2 does instead.

## Files

| file | what it is |
|---|---|
| `index.html` | GENERATED from `../index.html` by `build-page.js`. Never edit it by hand. |
| `build-page.js` | Makes `index.html`: the main page with `../` paths, a "v2" tab title, noindex, and the three scripts below loaded after the inline script and before `initModel()`. `--check` (run by `npm test`) fails if `index.html` is out of date. After any change to `esformlab/index.html`, run `node esformlab/v2/build-page.js` and commit both. |
| `pose-v2.js` | `EslPoseV2`: finds the runner in every stored frame and poses a square crop around them, with no state carried between calls. |
| `gait-events.js` | `EslGaitEvents.detect`: picks the phase frames from a whole clip's per-frame pose. Pure maths, no DOM; also runs in node. |
| `scan-v2.js` | Wires the two into the page: replaces `autoScanAll` and routes every later pose (cards, inspector) through the tracked poses. |
| `*.test.js` | Node tests on made-up data; all run by `npm test`. |

## What changed from the main page

**Pose (pose-v2.js).** The main page shrinks each frame to 400 px wide and passes it to
a MoveNet detector that keeps its crop between calls (and is never reset), so each
pose depends on the previous frame, often from another clip. v2 locates the runner
in every stored frame (duplicate and scene-cut detection, motion and grid seeds,
forward and backward tracking with MoveNet Lightning), then poses a square crop
around them with MoveNet Thunder, statelessly. Small runners are posed at full
model resolution. Bystanders, runners entering and leaving, growth toward the
camera and screen-recording borders are handled by the tracker.

**Phase picking (gait-events.js).** The main page samples 150 frames, picks each leg's
"lowest ankle" frame independently and walks a plateau (front/back: about 50
samples scored by which ankle is lower). v2 uses every frame:

- Side view: foot strike and toe-off come from each foot's motion relative to the
  hips plus the foot stopping on the ground, with fixed offsets in seconds. Legs
  are identified by continuity (MoveNet swaps left/right ankle labels on a few
  percent of frames), and anatomical left/right comes from the inferred facing
  direction. When a clip has several strides, the stride whose frame lands closest
  to the true event time is preferred. Two phases never share a frame.
- Front and back views: mid-stance instants come from the trunk's vertical bounce,
  with the stance leg decided by leg evidence around each instant, so both legs
  are always picked.
- A phase is left "manual" only when the clip has no usable runner.

**Leg labels on cards.** The page computes lead/trail metrics from the pose's
left/right labels, so `scan-v2.js` relabels hips, knees and ankles on every frame
where the detector found MoveNet's labels on the wrong leg (`diag.legSwap`).

**User-visible differences.** The scan step text names the new stages ("finding the
runner", "posing frame k of n"); the preview shows frames about once a second
while posing; "Side poses" in scan details counts posed stored frames; cards
analyse almost instantly because poses are cached; Rescan reuses the cached poses.
New scan warnings appear when another moving person is in the clip, when a clip
has few strides, or when a pick was placed from the surrounding steps.

## How it was measured

In an offline lab (outside this repo; it holds private athlete clips) every foot
strike and toe-off of real user clips was hand-labelled. Each event was labelled
twice independently, and disagreements were settled on zoomed original frames.
Both pages were then driven headless through upload, scan and card analysis on
the same clips and scored against those labels. A pick counts as correct when it
is within 2 frames of the labelled event on the correct leg; mid-stance counts
when it lies within 30-70% of a labelled stance of the correct leg.

| | main page | v2 |
|---|---|---|
| phase picks correct, desktop (11 clip sets, 99 picks) | 41% | 94% (90% within 1 frame) |
| phase picks correct, phone emulation (3 sets, 27 picks) | 30% | 93% |
| phases not picked ("manual") | 19 of 99 | 0 |
| toe-offs correct | 36-55% | 100% |
| front/back mid-stance correct | 9-45% | 91-100% |

The detector was designed on six clip sets and checked on ten clips it never saw
(96% of picks correct). Seven of those ten are scored only on events where both
labellers agreed, which makes them a somewhat easier test.

## Known limits

- Speed on real GPUs and phones is not measured. Headless runs use software
  WebGL. The estimate is 20-35 s per 600 frames on a desktop GPU and 30-60 s per
  300 frames on a phone. Phones now pose with Thunder; v1 scanned with Lightning.
- On desktop, Lightning (used to locate the runner) is an extra download of about
  4.7 MB; the main page loads it only on phones.
- Front/back mid-stance at 15 fps is covered by synthetic tests only; no real
  15 fps front or back clip was available.
- Side-view leg identity follows MoveNet's majority labels. A clip that MoveNet
  mislabels from start to end gets left and right swapped (the existing Swap L/R
  control fixes it).

## Before v2 replaces the main page

- Paying from v2 returns to `/esformlab/?paid=1` (the main page), because
  `auth-paywall.js` hard-codes that URL.
- `reference-data/index.html` has its own copy of the old `findPhases` and
  `refineLegPlateau`. Porting v2 there is a separate decision.
- Saved analyses use the same Firestore schema, so sessions saved from either page
  open in both.
