# esFormLab v2: gait-phase detection

esFormLab (`/esformlab/`) finds the nine phase frames with the v2 detection in this
folder. The UI, copy, report, saving and checkout are the page's own code; v2 changes
only how the phase frames are found and how each card's pose is computed.

The previous detection is still in `esformlab/index.html` (its scan functions are
replaced at load time, not deleted). Add `?detector=v1` to the page URL to run it,
for comparison. `/esformlab/v2/`, where v2 was first tried, redirects to `/esformlab/`.

How the previous detection works, and why it failed, is in `docs/esformlab.md`
(sections 6 and 14). This file covers what v2 does instead.

## Files

| file | what it is |
|---|---|
| `index.html` | A redirect to `/esformlab/` for links to the v2 preview. |
| `build-page.js` | Keeps the v2 script tags in `esformlab/index.html` current: they sit between two marker comments after the inline script and before `initModel()`, and load with `?v=<content hash>` so an edited script is never served stale. After editing a v2 script, run `node esformlab/v2/build-page.js` and commit the page with it. `--check` (run by `npm test`) also fails when the page stops fitting v2: a global the v2 scripts use is no longer declared, or `autoScanAll` changed (`scan-v2.js` holds a copy of its body; update the copy, then `AUTO_SCAN_ALL_SHA`). |
| `pose-v2.js` | `EslPoseV2`: finds the runner in every stored frame and poses a square crop around them, with no state carried between calls. |
| `gait-events.js` | `EslGaitEvents.detect`: picks the phase frames from a whole clip's per-frame pose. Pure maths, no DOM; also runs in node. |
| `scan-v2.js` | Wires the two into the page: replaces `autoScanAll` and routes every later pose (cards, inspector) through the tracked poses. |
| `*.test.js` | Node tests on made-up data; all run by `npm test`. |

## What changed from the previous detection

**Pose (pose-v2.js).** The previous detection shrinks each frame to 400 px wide and passes it to
a MoveNet detector that keeps its crop between calls (and is never reset), so each
pose depends on the previous frame, often from another clip. v2 locates the runner
in every stored frame (duplicate and scene-cut detection, motion and grid seeds,
forward and backward tracking with MoveNet Lightning), then poses a square crop
around them with MoveNet Thunder, statelessly. Small runners are posed at full
model resolution. Bystanders, runners entering and leaving, growth toward the
camera and screen-recording borders are handled by the tracker.

**Phase picking (gait-events.js).** The previous detection samples 150 frames, picks each leg's
"lowest ankle" frame independently and walks a plateau (front/back: about 50
samples scored by which ankle is lower). v2 uses every frame:

- Side view: first contact and toe-off come from each foot's motion relative to the
  hips plus the foot stopping on the ground, with fixed offsets in seconds. Foot
  strike is the frame where the foot first fully contacts the ground (the owner's
  definition, and the moment his elite reference frames were picked at). A shoe,
  thick-soled ones especially, can look grounded a frame or two before it truly is,
  so the detector places foot strike 0.07 s after its earliest-touch estimate, never
  past mid-stance, on the nearest frame. `contacts[].strike` is the earliest-touch
  estimate and `contacts[].load` (the name is historical) is the foot strike.
  Legs are identified by continuity (MoveNet swaps left/right ankle labels on a few
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
has few strides, or when a pick was placed from the surrounding steps. A frame the
user picks where the tracker did not follow the runner (or any frame of a clip
where no runner was tracked) is posed by a single-frame search, as v1 posed any
chosen frame. If the user uploads before Thunder has loaded, the scan waits for
it ("Loading the pose model…") rather than downloading a second copy. On phones
tracking pauses 60 ms every 10 model calls, as v1's phone scan did.

**What v2 writes.** The same documents as before, with one addition: admin
`phase_labels` docs carry `detector: 'v2'` (or `'v1'` under `?detector=v1`; docs
written before v2 shipped have no `detector` field). Saved analyses are not tagged.

**If the page changed under v2.** `scan-v2.js` replaces or wraps `autoScanAll`,
`analyzeCard`, `epReanalyze`, `analyzePoseAtT`, `normalizeAndRetry` and
`initModel` all together or not at all. If one is missing it replaces none, logs
an error, prefixes the tab title with "[v2 NOT ACTIVE]" and the page runs the
previous detection. `npm test` catches this earlier (see `build-page.js`).

## How it was measured

In an offline lab (outside this repo; it holds private athlete clips) every foot
strike and toe-off of real user clips was hand-labelled. Each event was labelled
twice independently, and disagreements were settled on zoomed original frames.
The previous and the v2 detection were then driven headless through upload, scan and card analysis on
the same clips and scored against those labels. A pick counts as correct when it
is within 2 frames of the labelled event on the correct leg; mid-stance counts
when it lies within 30-70% of a labelled stance of the correct leg. The labels mark
the first frame the shoe appears to touch; a foot-strike pick is scored against the
frame nearest that frame + 0.07 s (first full contact). The table below was
measured before that change, when foot strike was the earliest touch.

| | previous | v2 |
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
  4.7 MB; the previous detection loaded it only on phones.
- Front/back mid-stance at 15 fps is covered by synthetic tests only; no real
  15 fps front or back clip was available.
- Side-view leg identity follows MoveNet's majority labels. A clip that MoveNet
  mislabels from start to end gets left and right swapped (the existing Swap L/R
  control fixes it).

## Related

- `reference-data/index.html` (the admin reference tool) has its own copy of the previous
  `findPhases` and `refineLegPlateau`; it does not use v2.
- Saved analyses use the same Firestore schema as before. Admin frame labels
  (`phase_labels`) record `detector: 'v2'` or `'v1'`.
