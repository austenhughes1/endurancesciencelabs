# esFormLab: how it works today

This is the reference for esFormLab, the running form analysis tool served at
`/esformlab/`. It records what the tool does now: who can use what, every screen in
the order a user meets it, the processing pipeline from uploaded clip to PDF, exactly
how each gait phase is detected, the measurements and rules behind the report, what
is stored, and where phase detection goes wrong.

**Phase detection now runs the v2 code in `esformlab/v2/`** (see
`esformlab/v2/README.md`): it replaces the scan and per-frame pose functions at
load time. Sections 5.2-5.4, 6, 13 and 14 describe the previous detection, which is
still in `index.html` and runs when the page URL has `?detector=v1`. Everything else
here (UI, metrics, rules, report, data) is unchanged.

How this was produced: everything is read from the code
at commit `01274f4`. Nothing here was run in a browser, and esFormLab has no test
suite. Behaviour of the pose library was checked against the un-minified source of
the exact version the page loads (`@tensorflow-models/pose-detection@2.1.3`).
Section 16 lists what the code cannot tell us.

Citations: `index.html:1410` means `esformlab/index.html` line 1410. Other files in
`esformlab/` are cited by bare name (`gait-engine.js:73`). Files elsewhere carry their
path from the repo root (`shared/site.js:417`).

Contents

1. What esFormLab is and who can do what
2. File map and load order
3. Terms
4. UI flow, screen by screen
5. Processing pipeline, end to end
6. The nine phases and how each is detected
7. Measurements and formulas
8. The six issue rules
9. Reference ranges
10. Report, save and PDF
11. Data written and read
12. Admin-only features
13. The contract between detection and the rest of the page
14. Known limits of phase detection
15. Other behaviour worth knowing
16. Not established from the code

---

## 1. What esFormLab is and who can do what

A runner uploads three short video clips of themselves running: one from the side,
one from the front, one from the back. The page decodes each clip into still frames
in the browser, runs a pose model (MoveNet) over a sample of those frames, and picks
one frame for each of nine gait phases (moments in the stride, listed in section 6).
On each picked frame it measures joint angles. The user reviews the nine frames,
corrects any that are wrong, and presses Complete analysis. Six rules then turn the
measurements into findings (overstriding, hip drop, arms crossing, torso position,
arm angle, knee valgus), shown as an on-page report and available as a PDF.

The videos never leave the browser. What does leave it:

- the numbers of a saved session (Firestore, section 11);
- up to nine downscaled JPEG frames attached to a PDF request, which the server uses
  for that PDF and does not store (`functions/index.js:1360-1447`);
- feedback messages typed into the feedback form;
- admin frame labels (admin account only).

### Access

The scan is free to try with an account. The report is paid.

| Who | What they get |
|---|---|
| Signed out | The nav and a full-page sign-in gate. The gate covers the upload screen, so nothing can be uploaded (`index.html:698-713`, `shared/site.js:1175-1205`). |
| Signed in, no pass | Upload, scan, the whole review screen and frame inspector, Complete analysis, saving sessions, My Sessions, viewing saved sessions, the on-screen comparison of two sessions. Of the report they see a one-line teaser of how many issues were found and a paywall card; the report body, the measurement tables and the coaching call-to-action are blurred. No PDF. |
| Pass holder | Everything above plus the full report on screen, the report PDF and the comparison PDF. |
| Admin | A frame-labelling panel in the inspector (section 12) and the site-wide "act as" another user. For PDFs the server treats the admin uid as always holding a pass (`functions/index.js:1302`). The on-page blur follows the admin account's own pass state, also while acting as someone else, because the pass watchers follow the real signed-in uid (`shared/site.js:386`); the page has no admin bypass (`shared/site.js:417-429`). |

A pass is "unlocked" when any of these holds (`shared/site.js:417-429`, mirrored
server-side in `verifyActivePass`, `functions/index.js:1301-1350`):

- a Full Access (premium) coaching subscription with status `active` or `trialing`;
- `users/{uid}.features.esFormLab === true` (admin grant);
- `users/{uid}.formAnalyzerPassUntil` in the future (admin grant with an end date);
- a succeeded payment for the esFormLab pass price within the last 90 days.

The pass sold on the page is $90 for 90 days of unlimited analyses, one payment, no
subscription (`index.html:313-323`).

The on-page report is gated in the browser (`esformlab.css:59-62`); the PDFs are
enforced on the server.

---

## 2. File map and load order

Plain HTML, CSS and JavaScript, no build step, no modules. Every script shares one
global scope.

| File | Lines | Role |
|---|---|---|
| `esformlab/index.html` | 3461 | Markup for every screen and overlay (lines 1-650) and the main inline script (lines 674-3459): boot, global state, model loading, upload, scan orchestration, phase detection, review cards, frame inspector, admin labelling, examples, guided tour, PDF request, re-scan and reset, feedback. |
| `esformlab/frame-store.js` | 477 | `FrameStore.prime` and `FrameStore.extract`: plays each clip once and caches its frames as JPEGs. Every frame the tool shows or poses comes from here. |
| `esformlab/gait-data.js` | 246 | Data: `PHASE_DEFS` (the nine phases and their guide text), `PHASE_GROUPS`, `METRIC_ROWS`, `PHASE_METRICS`, `DEFAULTS` (reference ranges), `METRIC_BIO` (the inspector's one-sentence metric explanations), range lookups, `setSex`, `MIN_CONF`, and the keypoint side sets and `SKELETON` used for drawing. |
| `esformlab/gait-engine.js` | 751 | Maths and drawing: `isSideView`, `drawPose`, `calcAngle`, `computeMetrics`, `computeFrontBackMetrics`, `normalizeAndRetry`, `isWeakDetection`, `addFunctionalMetrics`, `REPORT_DATA` (report copy), `detectIssues` (the six rules). |
| `esformlab/report-render.js` | 406 | On-screen report: issue cards and breakdowns, the teaser banner for unpaid users, the side-view summary table, the front/back table. |
| `esformlab/saved-analyses.js` | 653 | Save, My Sessions, viewing a saved session, comparing two sessions, comparison PDF request, `startNewSession`. |
| `esformlab/auth-paywall.js` | 290 | Paywall blur, pass chip, checkout with autosave and resume, sign-in UI toggles, fetch of the live reference ranges, profile gender preselect. |
| `esformlab/esformlab.css` | 1256 | Page styles. Colours and shared components come from `shared/site.css`. |

Outside the folder:

| File | What esFormLab uses it for |
|---|---|
| `shared/site.js`, `shared/site.css` | `window.esLabs`: nav, sign-in gate, auth and pass state, checkout, dialogs, toast, `ADMIN_UID`, act-as. |
| `functions/index.js` | Callable Cloud Functions `generateFormReport` and `generateComparisonReport`, and `verifyActivePass`. |
| `functions/report-renderer.js`, `functions/comparison-renderer.js` | Server-side PDF rendering. They hold their own copies of the phase and metric definitions, so phase keys and metric keys are shared vocabulary between page and server. |
| `reference-data/index.html` | Admin page that builds the live reference ranges (`computed_ranges`) and reads the admin frame labels. It contains its own copies of `findPhases` (line 1663) and `refineLegPlateau` (line 1924). |
| `firestore.rules.txt` | Rules for `users/{uid}/analyses`, `computed_ranges`, `phase_labels`, `notifications`. |
| `images/gait-helpers/` | The 16 example photos used in the inspector's "correct vs wrong frame" helper. |

### Load order (`index.html:653-674`)

All scripts are classic blocking tags at the end of `<body>`:

1. Firebase compat 10.7.1: app, firestore, auth, functions.
2. `/shared/site.js`.
3. TensorFlow.js 4.10.0 (`tf.min.js`) and pose-detection 2.1.3, both from jsDelivr.
   No separate WASM or WebGPU backend script is loaded.
4. `frame-store.js`, `report-render.js`, `saved-analyses.js`, `auth-paywall.js`,
   `gait-data.js`, `gait-engine.js`.
5. The inline script, whose last statement is `initModel()` (`index.html:3458`).

The model weights are fetched at runtime by the pose library. There is no analytics
script and no Stripe.js; checkout is a full-page redirect.

`auth-paywall.js` registers its auth and pass listeners as it loads
(`auth-paywall.js:73`, `:86`), before the inline script has declared its state. The
inline script re-seeds `currentUser` and re-runs the profile load to cover that
(`index.html:766-773`).

---

## 3. Terms

| Term | Meaning here |
|---|---|
| Clip, view | One of the three uploaded videos: `side`, `front`, `back`. |
| Phase | One of nine named moments in the stride, each tied to one clip (section 6). Phase keys: `l_foot`, `r_foot`, `l_toe`, `r_toe`, `mid`, `mid_front_l`, `mid_front_r`, `mid_back_l`, `mid_back_r`. |
| Frame store | The object `FrameStore.extract` returns for a clip: its frames as JPEG blobs keyed by presentation time. Held in `videoEls.side/front/back`. Despite the variable's name these are not `<video>` elements. |
| Stored frame | A frame kept in the frame store. Smaller and possibly sparser than the source video: longest side capped at 1280 px (960 on phones), at most 60 frames per second (30 on phones). "One frame" in the UI means one stored frame. |
| Keypoints (`kps`) | MoveNet's 17 body points, each `{x, y, score}`: 0 nose, 1/2 eyes, 3/4 ears, 5/6 shoulders, 7/8 elbows, 9/10 wrists, 11/12 hips, 13/14 knees, 15/16 ankles. Odd index is left, even is right. There are no heel or toe points; the ankle is the lowest point the code sees. `x`, `y` are pixels of whatever canvas was posed. |
| `MIN_CONF` | 0.25. A keypoint scoring below this is treated as missing everywhere (`gait-data.js:192`). |
| Thunder, Lightning | The two MoveNet single-pose models. Thunder is larger and more accurate (256 px input); Lightning is faster (192 px input). |
| Coarse scan | The first pass over a clip: a fixed number of evenly spaced samples posed on a small canvas. |
| Dense refinement | A second pass around each leg's coarse foot strike and toe-off at 33 ms steps on full stored frames. |
| Detected | `phases[key].detected === true`: the scan (or the user) assigned a frame to the phase. It does not mean the frame is right. |
| Analyzed | The phase has `metrics`: a pose was found on its frame and measurements computed. |
| Card | A phase's tile on the review screen. |
| Inspector | The dialog that opens from a card to check and change the frame (`#expand-overlay`). |
| Commit | Making a frame the phase's frame. Only a successful "Analyze this frame" in the inspector commits. |
| Detection quality | Strong, Fair or Weak: a grade of keypoint confidence on a frame. It says nothing about whether the frame is the right moment. |
| Phone | `IS_MOBILE_RUNNER`: the user agent contains `Mobi`, `Android`, `iPhone`, `iPad` or `iPod` (`index.html:723`). Behaviour differences key off this. Layout differences key off viewport width instead, so the two can disagree (section 4.14). |
| Sex | The grading sex chosen on the upload screen: `'male'`, `'female'` or `null`. The UI calls it gender. |

---

## 4. UI flow, screen by screen

There is no router. The page has three screen containers, `#screen-upload`,
`#screen-scanning` and `#screen-phases`, and each transition sets their
`style.display` directly. There is no separate report screen: the report, tables,
save form and paywall are children of `#screen-phases` and appear below the phase
cards. Overlays (inspector, examples, tour, My Sessions, Compare, feedback) are
siblings of `<main>` shown by adding class `open`.

### 4.1 Page load

1. `#loader` covers the whole page (`z-index:2000`): spinner, "Loading pose estimation
   model", "MoveNet Thunder · runs entirely in your browser" (`index.html:15-19`). It is
   hidden when the Thunder model is ready (`index.html:1133-1134`). Nothing else gates
   the Analyze button on the model being loaded.
2. If the model fails to load, the loader becomes an error panel under the nav:
   "Couldn't load the pose model", a "Reload page" button and the error text in a
   details element (`index.html:1135-1145`). The tool is unusable in that state.
3. The sign-in gate (`#esfl-gate`) shows a spinner while auth restores, the sign-in
   card when there is no user, and hides when there is one. Its copy: eyebrow
   "◉ Free to try", headline "Try esFormLab on your run", four bullets (upload and scan
   at no cost with all 9 gait phases scanned; gender-specific reference data; save your
   sessions; videos never leave your browser), and a footer saying the full report and
   PDF unlock with a one-time 90-day pass, plus "Not medical advice"
   (`index.html:698-713`).
4. The nav is the shared site nav with four esFormLab extras (`index.html:680-696`): a
   pass chip ("Pass active · Full Access", "Pass active · until <date>" or "Pass
   active"), "My Sessions" (signed in only), "↩ New analysis" (only while a session
   exists), and a file-name span that is permanently hidden by CSS. At 1140 px and
   below, My Sessions and New analysis move into the hamburger menu and the pass chip
   is not shown at all; the chip is also hidden at 1279 px and below while a session
   exists (`esformlab.css:74-77`).
5. In the background the page fetches the live reference ranges (section 9) and, for
   a signed-in user, the saved sessions list and the profile gender. If the profile
   has `gender` of `male` or `female` and nothing is selected yet, that sex is
   preselected (`auth-paywall.js:40-55`).

A footer with "Contact Endurance Science Labs" and "Report a bug" buttons and
Privacy and Terms links is present on every screen (`index.html:632-636`).

### 4.2 Upload screen (`#screen-upload`, `index.html:29-169`)

What the user sees, top to bottom:

1. "Analyze your running form" and "Upload a side, front and back clip. The scan runs
   in your browser — nothing is uploaded."
2. On viewports 700 px wide or less, a notice: "Works on your phone — desktop is a
   little more precise", explaining that phones check fewer frames and step 60 fps
   clips two frames at a time.
3. Step 1, "Select athlete gender for grading ranges": Male, Female, or "Skip — use
   general defaults". Optional; nothing checks it before a scan. A "Why pick your
   gender?" paragraph explains that angles are graded against runners of the same
   gender. A status line reports "✓ Live <sex> ranges loaded" or that defaults are in
   use.
4. Step 2, "Upload videos (all three required)":
   - a must-read box: keep each clip to 8 seconds or less; the camera must be at the
     correct angle for the entire clip;
   - three drop zones (Side view, Front view, Back view), each with filming guidance.
     A zone accepts a click, Enter or Space, or a dropped file;
   - "Analyze all three →", disabled until all three zones hold a file, with the line
     "MP4 / MOV / WebM · fully private · no data uploaded" under it;
   - seven recording tips and a privacy note.
5. Below the upload card, a banner linking to the metabolic power profile tool
   (`/esmetaboliclab/power-profile/`, `index.html:158-168`).

What happens on a pick (`acceptPickedFile`, `index.html:1156-1164`; `loadFile`,
`:1192-1207`):

- A file is accepted when its MIME type starts with `video/` or its name ends in
  `.mp4`, `.mov`, `.m4v` or `.webm`. Anything else shows "That file isn't a video —
  choose the <view>-view clip (MP4, MOV or WebM)." in that zone.
- An accepted file turns the zone green with a check mark, the file name and "Click to
  replace".
- If another zone already holds a file with the same name and size, a non-blocking
  warning appears: "This looks like the same file as the <other>-view clip — each view
  needs its own video."

That is all the validation at this point. There is no size, duration, codec or
resolution check, and the file is not opened until the scan starts. The 8-second rule
is advice only. There is no single-view mode: all three clips are required.

### 4.3 Scanning screen (`#screen-scanning`, `index.html:172-190`)

Pressing Analyze (`startAllVideos`, `index.html:1215-1229`) hides the upload screen,
shows the scanning card, adds the "New analysis" nav button, primes the shared
`<video>` element inside the click (needed on iOS), and starts loading then scanning.

The card shows a title ("Scanning stride phases"), a stage line, a static hint, a
16:9 preview box, a progress bar, a step line, a "Cancel scan" button, live warnings,
a list of the nine phases and a diagnostics line.

| Stage | Stage line | Preview | Step line | Bar |
|---|---|---|---|---|
| Load frames | "Loading your videos frame by frame..." | each clip plays through once | "Side video: loading frames (1 of 3)..." | 0 to 30% (10% per clip) |
| Side scan | "Scanning side view for 5 gait phases…" | sampled frames with a small skeleton drawn on each | "Side view: scanning frame 37 of 150 at 2.43s" | 30 to 75% |
| Refinement | unchanged | last scanned frame | "Side view: refining foot-strike + toe-off edges..." | stays near 75% |
| Phones only | "Brief cool-down between scans…" | | "Pausing briefly between scans…" | 1.5 s pause |
| Front scan | "Scanning front view for L and R mid-stance frames..." | sampled frames with skeletons | "Front view: frame 12 of 50" | 75 to 87% |
| Phones only | cool-down again | | | 1.5 s pause |
| Back scan | "Scanning back view for L and R mid-stance frames..." | sampled frames with skeletons | "Back view: frame 12 of 50" | 87 to 100% |
| Finish | "Scan complete" | | "Done — all 3 videos scanned" | 100% |

The phase list starts with every row showing "--". After the side scan and
refinement the five side rows update together: a detected phase turns green with its
time ("3.47s"); an undetected one turns amber and reads "manual". The front and back
rows update after their scans.

Warnings that can appear here, each repeated on the review screen under "Check these
before you review":

| Warning | Trigger |
|---|---|
| "<Views> video(s) couldn't be decoded by this browser (phone clips are often HEVC / H.265). Re-export as H.264 .mp4 or try Safari / Chrome — scanning continues with whatever loaded." | a frame store has no frames (`index.html:1359-1373`) |
| "The <view> clip is very short (N s) — a few seconds of steady running gives the scan full strides to work with." | fewer than 45 stored frames, or duration under 2 s (`:1382-1389`) |
| "The side clip's first poses look front- or back-facing — side-view angles need a dead-on side view." | the first pose found in the side clip fails the side-view test (`:1437-1439`) |
| "Only part of the <view> (N% of frames) video could be loaded — re-exporting as H.264 .mp4 usually fixes this." | a clip's frame coverage is under 90% (`:1541-1547`) |

None of these stops the scan.

After "Scan complete" there is a fixed 700 ms pause, then the review screen replaces
the scanning card (`index.html:1549-1553`).

Cancel: "Cancel scan" sets a flag that the scan checks between samples and between
stages. The button is disabled and reads "Cancelling…", and the step line reads
"Stopping the scan…", until the scan unwinds; then the page returns
to the upload screen with the three files still selected, a toast "Scan cancelled —
your videos are still selected.", and the decoded frames dropped
(`index.html:1242-1277`). A clip that has started loading finishes loading first, and
both leg refinements finish first; those are the longest waits. Pressing Analyze
again decodes every clip from scratch.

### 4.4 Review screen (`#screen-phases`, `index.html:193-276`)

Top to bottom:

1. Instruction banner: "Before you finish: review every card below", "Open each card,
   check the frame matches its description and aim for Strong detection — then press
   Complete analysis.", a line announcing the walkthrough (first visit only), a "Show
   me how this works (guided tour)" button, a collapsed "How this works" with four
   steps, and a colour legend (left side, right side, trunk lean, within / above /
   below range).
2. "Check these before you review": the scan warnings, if any.
3. "⟳ Re-scan videos" (desktop only).
4. A collapsed "Scan details · D of 9 auto-detected" line with each clip's source
   size (or "failed"), the side clip's duration, "Side poses: found/N", the
   auto-detected count and which ranges are in use. It opens by default, flagged
   "check these", when a clip failed or fewer than 15 side poses were found; a failed
   clip also adds a line repeating the HEVC / H.264 advice (`index.html:1559-1578`). D
   is counted from `detected` before any card is analysed.
5. The nine phase cards in three groups (`gait-data.js:207-211`):

   | Group | Cards |
   |---|---|
   | Stride & propulsion | 1 L foot strike, 2 R foot strike, 3 L toe-off, 4 R toe-off |
   | Posture & trunk | 5 Mid-stance |
   | Hip & lateral mechanics | 6 L mid-stance (front), 7 R mid-stance (front), 8 L mid-stance (back), 9 R mid-stance (back) |

6. The fixed "Complete analysis" bar at the bottom of the viewport (section 4.7).

Each card shows its number, name, one-line description, a Side / Front / Back tag, a
status badge, "Detects: …", then a frame or a placeholder, the frame time, a hint, and
up to three measurements. A card is built in one of three forms
(`buildPhaseGroups`, `index.html:2058-2104`):

| Condition | Card body | Badge | Hint |
|---|---|---|---|
| The clip did not decode | "Video couldn't be loaded / Re-export as H.264 .mp4 and start a new analysis" | "no video" | "↗ Details" |
| Phase detected | the frame at the picked time | "pending" | "↗ Click to adjust" |
| Phase not detected | "Not auto-detected / Click to manually select a frame" (amber pulsing border) | "manual" | "↗ Select frame" |

The screen appears first; then each detected card is analysed one at a time in card
order (section 5.5), so the user watches badges go "pending", "analyzing", then one
of:

| Badge | Meaning |
|---|---|
| Strong / Fair / Weak | Keypoint confidence on that frame (thresholds in section 7.5). |
| Needs side view | A side-clip frame whose pose does not look side-on. No angle measurements; the card shows "⚠ Side view required for angle analysis". |
| no pose | The full-size pose pass found nobody on the picked frame. The card turns amber and the hint reads "Pose not found — open to pick another frame". |

An analysed side card can also carry a line "⚠ Possible wrong leg — open to check"
(section 7.7). The measurements on a side card are the first three of its relevant
metrics, each with a ▸ ▴ ▾ symbol for within, above or below the reference range. A
front or back card shows hip drop with the measured stance side, "Arm crossing:
detected" (front only, when either wrist crosses by more than 5% of shoulder width),
stance knee valgus when above 3°, or the average confidence if none of those apply
(`index.html:2174-2199`).

Clicking a card, or pressing Enter or Space on it, opens the inspector.

### 4.5 Guided tour (`#tour-overlay`, `index.html:2640-2959`)

Starts by itself 600 ms after the cards finish analysing, once per browser, unless a
saved session is on screen (`index.html:1599-1602`). It can be replayed from the
banner button. Ending it any way (finishing, "Skip walkthrough ×", Escape, or
starting another flow) sets `localStorage['esfl-tour-done'] = '1'`.

It darkens the page except a spotlight around one element and shows a bubble with
"Step N of 6", progress dots, Back (hidden on step 1) and Next (reading "Got it ✓"
on step 6). The right and left arrow keys also move forward and back when focus is not
on a control. The dark mask is visual only; the page under it stays clickable
(`esformlab.css:1037-1039`). When the tour ends it closes the inspector if the tour
opened it, and hides the Complete analysis bar again if step 6 forced it into view.

| Step | Title | Spotlight |
|---|---|---|
| 1 | Review every card before you finish | the first phase card |
| 2 | Step to a better frame | the inspector's frame-step buttons (the tour opens the first detected phase, or phase 1 if none is detected) |
| 3 | Compare to correct vs. wrong reference frames | the example photos in the inspector |
| 4 | Click Analyze as many times as needed | "↻ Analyze this frame" |
| 5 | Jump between phases without closing the card | the "jump to" pills |
| 6 | When every card looks right, complete the analysis | the Complete analysis button (the tour closes the inspector and shows the bar even if fewer than three phases are analysed) |

Step 4 tells users: "Pose detection has some randomness, so a second or third pass on
the same frame can sometimes bump detection quality from Fair to Strong."
Section 14.1 explains where that variation comes from.

While the tour runs, leaving the inspector on a moved frame does not ask whether to
keep it; the moved position is dropped.

### 4.6 Frame inspector (`#expand-overlay`, `index.html:459-566`)

The inspector is where a user checks a phase's frame and replaces it. On desktop it
is a two-column dialog; at 700 px wide or less, and in any wider window 500 px tall
or less (landscape phones), it is a full-screen single column
(`esformlab.css:403`, `:684`, `:1229`).

Left column:

- the frame canvas, with the pose overlay;
- "Frame adjustment": a quality pill (Strong / Fair / Weak detection), then six step
  buttons around a time readout: `−1s  −5f  −1f  [0.00s]  +1f  +5f  +1s`. There is no
  slider and no keyboard shortcut for stepping; these buttons are the only way to
  move;
- "↻ Analyze this frame", "⇄ Swap L/R", "✕ Clear overlay";
- "jump to:" nine pills, one per phase, the open one highlighted and undetected ones
  in orange;
- the admin label panel (admin only).

Right column:

- the detection quality card: the level, "Good to use" (Strong) or "Usually fine to
  use" (Fair), and the sentence "This is how clearly the model saw your joints in this
  frame. Separate from whether you picked the right gait moment.", with expandable tips
  under "What does this mean?". A Weak card has no "fine to use" line and adds
  "Measurements from this frame may be unreliable." Clicking the quality pill in the
  left column scrolls to this card;
- a wrong-leg warning when one applies;
- "What to look for": the phase's description, four "Confirm this frame shows" checks
  and a tip, from `PHASE_DEFS[].guide`. Side phases add a warning that the runner must
  be dead-on side;
- "Did this catch the right moment? Compare to these.": one correct example photo and
  the wrong ones, with "See full annotated guide ↗" opening a larger examples overlay;
- the overlay colour key;
- "Angle measurements" (open by default): on a side phase, each relevant metric with a
  one-sentence explanation (`METRIC_BIO`), the measured value and Within / Above /
  Below range, or "⚠ Side view required for angle analysis" when the pose is not
  side-on; on a front or back phase, hip drop with the stance side and which hip is
  lower, L and R wrist crossing as a percentage of shoulder width (front only),
  stance-knee valgus (FPPA) and the average keypoint confidence, with no range grading
  (`renderExpandMetricsFrontBack`, `index.html:3109-3148`).

Opening (`openExpand`, `index.html:2215-2293`) shows the phase's committed frame at
`ph.t` with its stored keypoints. No pose estimation runs on open. For a phase that
was not detected, the inspector opens at a placeholder time (mid-clip for side
phases; 35% or 65% through the clip for front and back phases) with the notice "We
couldn't find this moment automatically / We've started you mid-clip. Step to the
right moment with the frame buttons, then press ↻ Analyze this frame." For a "no
pose" card the notice is "No pose found on this frame". For a clip that failed to
decode, the frame-step, Analyze and Swap L/R buttons are disabled (the jump pills and
Clear overlay stay active) and the notice explains the HEVC problem
(`index.html:2242-2248`).

Stepping (`epStep`, `epStepSeconds`, `epScrub`, `index.html:2974-3008`):

- `±1f` and `±5f` move by stored frames and clamp at the clip ends. `±1s` moves by a
  second and snaps to a stored frame.
- The frame redraws after a 100 ms debounce, without a skeleton.
- Stepping changes only what is displayed. The phase, its card and its measurements
  keep the committed frame.
- Once the displayed frame differs from the analysed one, the measurements and
  quality grey out, the Analyze button glows, and a note reads "Frame changed — press
  ↻ Analyze this frame to use it. Until then the card keeps the X.XX s frame, and the
  angles and quality below are from that frame."

Analyze (`epReanalyze`, `index.html:3010-3092`) is the only way a user corrects a
phase:

1. The displayed frame is posed with Thunder at full stored size. If the result is
   weak, one retry runs on a contrast-stretched copy and is used only if it is not
   weak (section 7.6).
2. No pose: the measurements panel shows "No pose detected — try a different frame"
   and nothing is committed.
3. A pose, even a weak one: the frame is committed. `ph.t`, `ph.kps`, `ph.metrics`
   and the other fields are overwritten; there is no undo. The card gets the new
   thumbnail, time, badge and measurements; an undetected card is rebuilt into a normal
   one; the side-view summary column updates (side-on side phases only); the Complete
   analysis bar is re-evaluated. A report already on screen is not touched
   (section 4.7).

Leaving with a moved, un-analysed frame (close button, backdrop click, Escape, or a
jump pill) opens a prompt, "Use this new frame?", with "↻ Analyze this frame" (commits
if a pose is found, then leaves) and "Keep the previous frame" (`index.html:2463-2497`).

Swap L/R (`swapLegs`, `index.html:984-1030`) exchanges every left/right keypoint pair
in the committed pose (not only the legs), recomputes the measurements and redraws. It
runs no pose estimation and is undone by pressing it again or by the next Analyze. It
is disabled while the phase has no pose. It redraws the committed pose over whatever
frame is displayed, so after stepping away the skeleton sits on a different frame from
the one it was measured on.

Clear overlay redraws the frame without the skeleton and changes nothing else.

The examples overlay (`openExamples`, `index.html:2596-2630`) shows, per phase type,
the tool's own definition of the target frame:

| Phases | Instruction shown |
|---|---|
| Foot strike | "Scrub to the **first** frame where the foot touches the ground. If you go back one frame, that foot should still be in the air. Don't pick a frame where the foot has already rolled onto mid-foot or where the runner is fully loaded into stance." |
| Toe-off | "Scrub to the **last** frame where the trail foot is still touching the ground. The correct frame shows the forefoot in contact with the ground; the very next frame should show that foot fully in the air." |
| Mid-stance (side) | "Pick the frame where the supporting foot is **directly under your center of mass** — not in front of the body (still loading) and not behind it (starting to push off)." |
| Mid-stance (front) | "Pick a frame where the foot is firmly **planted directly underneath the body**. Avoid frames where the foot has just touched down, or where the runner is rolling onto the toes about to leave the ground." |
| Mid-stance (back) | The same, ending "...or where the runner is starting to toe off the ground." |

Side phases also get "Step 1 — Make sure the runner is dead-on side" with two
wrong-camera-angle photos among the wrong examples. Front and back phases have one
wrong-camera-angle photo among theirs.

Escape closes the topmost thing: the examples overlay if it is open, else the "Use
this new frame?" prompt, else the inspector. While the tour is running the tour
handles Escape instead. Tab is trapped inside the dialog (inside the prompt while it
is open), except while the tour runs. Focus returns to the card on close.

### 4.7 Complete analysis

The fixed bar at the bottom (`#complete-analysis-bar`) appears as soon as three of
the nine phases are analysed (`checkAllAnalyzed`, `index.html:1037-1057`). Its text:

- "All 9 phases analyzed — ready to build your report", or "D of 9 phases analyzed — N
  still need a frame";
- "S of 9 have strong detection · press Complete analysis to build your report".

Nothing requires all nine phases or any quality level. A side phase showing "Needs
side view" and a phase with a weak pose both count as analysed. The bar is hidden by
CSS while the inspector is open.

"◉ Complete analysis →" (`completeAnalysis`, `index.html:1059-1097`) ends the tour if
it is running, closes the inspector, runs the six issue rules, renders the report, shows the save form, the
report, the measurement tables, the coaching call-to-action and the footnotes below
the cards, applies the paywall, scrolls to the report, and hides the bar. The cards
stay on the page above; the user can scroll up and change a frame. Doing so brings
the bar back, and the report is rebuilt only when it is pressed again (section 15).

### 4.8 The report on screen

In page order:

1. Save form (section 4.10). It sits above the report so an unpaid user can still
   reach it.
2. "Your running form report".
3. Teaser banner and paywall card (unpaid users only, section 4.9).
4. "⬇ Download full report as PDF". A second PDF button, "Or download the PDF for the
   full deep dive →", sits in the principles card (item 8).
5. Six issue cards, one per rule, in this order: Overstriding, Hip drop, Arms
   crossing midline, Torso position, Arm angle too open, Knee valgus. Each has a chip:
   Notable, Mild, ✓ Clear, or Not measured (the rule had no input at all). Detected
   issues can carry a tag "Left side only", "Right side only" or "Both sides" ("arm" /
   "arms" for arms crossing) and a link to their breakdown.
6. "Detailed breakdowns": one collapsible block per detected issue with What this
   means, Why it matters, Why this might be happening, Form cues, and a confidence
   note. The copy is `REPORT_DATA` in `gait-engine.js:325-491`.
7. A panel above the cards when nothing was detected: "No major gait-pattern flags
   detected", or "N of 6 checks couldn't be run" when some rules had no input.
8. "Four universal principles": a static card with an expandable deep dive.
9. "Side view measurements": a table with one column per side phase and one row per
   metric, each cell showing the value, a range symbol and Within / Above / Below
   range. Column headers open that phase in the inspector (plain text in a saved
   session); an undetected phase's header carries ⚠.
10. "Front/back view measurements", inside the same section as item 9 and shown only
    when at least one front or back phase has measurements: stance side, hip drop,
    stance-knee FPPA and left/right wrist crossing for the four front and back phases
    (`renderFrontBackTable`, `report-render.js:319-351`).
11. Coaching call-to-action (swapped for "You have a coach" copy when the user has an
    active or trialing Standard or Full Access coaching subscription,
    `auth-paywall.js:111-126`).
12. Two footnotes that are never blurred: "Not medical advice", and "A value looks
    wildly out of range?", which says this almost always means the wrong gait phase
    was selected or the camera was off-axis and tells the user to re-analyze that card.

Browser print gives a compact light version of the report; blurred sections are
removed from print.

### 4.9 Paywall and checkout (`auth-paywall.js:150-263`)

`applyPaywallState()` runs when a report is shown and on every pass-state change.

Unlocked: nothing is blurred; no banner; no paywall card.

Locked:

- the report body, the measurements section (both tables) and the coaching
  call-to-action get the blur;
- the report's intro line becomes "Unlock your full report to see what each finding
  means, why it might matter, and the form cues to work on.";
- a teaser banner shows how many issues were found without naming them ("N issues
  detected in your form"), or "Clean run — but there's more behind that result", or
  "Your scan is incomplete — N of 9 phases have no usable frame" with a link back to
  the cards (`report-render.js:96-146`);
- the paywall card shows "Unlock your full report", $90, "90-DAY PASS · UNLIMITED
  ANALYSES" and an "Unlock pass" button.

"Unlock pass" (`startPassCheckout`):

1. The button reads "Saving and opening checkout...". The current analysis is saved to
   the user's sessions as "Pre-checkout autosave" (`autosave: true`, dated today) and
   its id stored in `localStorage['esformlab_resume_id']`. When a saved session is
   already open, nothing is saved and that session's id is stored instead. Nothing is
   saved, and no id stored, when no phase has measurements or the autosave write
   fails; checkout goes ahead anyway. The autosave exists because checkout is a
   full-page redirect that discards the videos and all in-memory state.
2. Redirects to Stripe with success URL `/esformlab/?paid=1` and cancel URL the
   current page. If starting checkout fails, an alert "Could not start checkout: …"
   shows and the button resets.
3. On return to `?paid=1`, a toast reads "Pass unlocked — finishing setup…" until the
   pass state arrives, then "Pass unlocked — your full report is ready." and `paid` is
   removed from the URL.
4. On any page load where the stored id is present, whether or not payment went
   through (a cancelled checkout returns to a fresh page too), the session with that
   id opens in saved view once the sessions list has loaded, and the localStorage key
   is removed (`maybeResumeAfterCheckout`, `auth-paywall.js:252-263`). The live cards
   and videos are gone at that point.

### 4.10 Save, My Sessions, saved view, Compare (`saved-analyses.js`)

Save form: session name, date (defaults to today), "Save analysis". Both fields are
required. The save writes one document (schema in section 11), shows "Saved
successfully!", and re-enables the button after 3 s; each further press writes
another document, so the same analysis can be saved more than once. A note "No pass
yet? Save it anyway." shows for unpaid users. Under the form, "Start a new analysis"
does the same as the nav's New analysis (section 4.12).

My Sessions (nav button) lists saved sessions newest first by save time: name, date,
sex, "N issues detected" (or "No issues detected"), View and Delete (Delete asks
"Delete this analysis? This cannot be undone."), and a checkbox for comparing. The
compare bar appears only when there are two or more sessions; ticking a third box
unticks the earliest-ticked one. Pre-checkout autosaves appear here as ordinary
sessions; nothing filters or removes them.

Viewing a saved session (`viewSavedAnalysis`, `saved-analyses.js:299-387`):

- asks first if live work (a report or analysed phases) would be replaced, unless it
  was saved during this run;
- shows a sticky "Saved session" banner with the name and date and buttons "All
  sessions" and "New analysis";
- shows the report, the measurement tables, the coaching call-to-action and the
  footnotes, and hides the instruction banner, scan warnings, Re-scan, scan details,
  cards, Complete bar and save form;
- rebuilds `phases` from the saved numbers with no keypoints. The cards are hidden and
  the column headers are plain text, so there is no way into the inspector. The live
  session's decoded frames are not released;
- switches the grading sex to the saved session's sex (the live choice is restored
  when the user leaves through New analysis);
- renders the report from the saved `issues` object as stored; the rules are not
  re-run.

Compare: tick two sessions, press "Compare selected sessions". The overlay puts the
earlier session (by entered date, then save time) as Session A. Two pickers, "Session
A (earlier)" and "Session B (later)", let the user choose any two saved sessions; a
pair picked the wrong way round is swapped with the note "Swapped so Session A is the
earlier one". It shows a six-row "Issue changes" grid (severity in A and in B, and
Improved / Same / Worsened, from the saved `issues`), and a collapsed "Angle
measurements detail" table of side-view measurements with the change coloured green
when B moved closer to the middle of the reference range, amber when further, grey
when the change is under 0.5. The range used is the one for the sex currently
selected on the page, not either session's saved sex (`saved-analyses.js:582`). The
on-screen comparison is not blurred for unpaid users; its PDF button shows "Requires
an active 90-day pass" under it for them and is server-gated. Printing with Compare
open prints the comparison instead of the report.

### 4.11 PDF (`downloadReport`, `index.html:3190-3275`)

Requires a completed analysis and a signed-in user. For an unpaid user the buttons
sit inside the blurred block and cannot be clicked; if the call is made anyway the
server returns `permission-denied`.

The PDF buttons read "Generating PDF…" while the request runs. The page captures one
JPEG per detected phase that has keypoints (at most 640 px wide, quality 0.62, the
committed frame with its overlay), then calls `generateFormReport` with the save
form's session name (sent as both `athleteName` and `sessionName`, empty if the field
is empty) and date (today if empty), the selected sex, `{metrics}` for each phase that
has `metrics`, the current issues object and the images. It sends no `tzOffsetMin`.
In a saved session the name and date come from the saved document instead. The PDF
comes back base64-encoded and is downloaded. Failures show an alert: a pass message
for `permission-denied`, a sign-in message for `unauthenticated`, otherwise "Could not
generate the PDF…".

From a saved session the PDF has no frame images, because no keypoints were saved. It
also has no front/back measurements: the saved front and back phases hold their
numbers in `frontBackMetrics`, not `metrics`, and the payload carries only `metrics`,
although `functions/report-renderer.js:730-733` would read `frontBackMetrics`. The
PDF downloaded right after checkout is in this state, because it is produced from
the autosaved session.

The comparison PDF (`downloadComparisonPDF`, `saved-analyses.js:606-653`) sends only
the two session ids (plus the athlete's uid as `ownerUid` when the admin is acting as
them); the server reads both documents itself.

### 4.12 Re-scan, New analysis

Re-scan (desktop only, `rescan`, `index.html:3280-3321`): confirms if there is work
to lose ("Re-scan the videos? This replaces every frame you picked and your
report."), clears all phases and the report, and runs the scan again on the frames
already in memory. Clips are not decoded again, so a clip that decoded with holes
keeps them.

New analysis (`startNewSession`, `saved-analyses.js:113-165`; `resetApp`,
`index.html:3324-3381`):

- during a scan, which for this purpose lasts until the cards have finished analysing
  on the review screen: confirms ("Stop the scan and start over? …"), then reloads the
  page;
- on phones: confirms if there is analysed work, then always reloads the page;
- on desktop: confirms if there is analysed work, then resets in place: frames
  released, files cleared, drop zones reset, save form cleared, back to the upload
  screen. The selected sex is kept.
- from a saved session there is no confirmation; leaving restores the sex that was
  selected before the saved session opened.

### 4.13 Feedback (`index.html:3390-3456`)

The two footer buttons open a small modal with a text box ("Contact Endurance Science
Labs" or "Report a bug"). An empty message shows "Please enter a message." Send
writes one document to the `notifications` collection addressed to the admin
(`recipientUid`), with `type` `contact` or `bug_report`, `message` in the form
"[Contact] from <name> (esformlab): <text>" (or "[Bug] …"; the name is the display
name or email), `senderUid`, `read: false` and `createdAt`. Nothing else is attached:
no session, phase or device information. On success it shows "Sent! Thank you." and
closes after 1.5 s; on failure "Failed to send. Try again." The rules accept the write
only when `senderUid` is the caller's own uid (`firestore.rules.txt:210-215`). The
sender is the effective user, so an admin acting as someone sends it under that
user's name and uid, which the rules allow because the caller is the admin.

### 4.14 Phone differences

Behaviour that follows the user-agent test (`IS_MOBILE_RUNNER`):

| Area | Desktop | Phone |
|---|---|---|
| Stored frames | longest side 1280 px, up to 60 fps, up to 900 frames per clip, JPEG quality 0.82 | 960 px, 30 fps, 600 frames, quality 0.8 |
| Frame store limits | up to 300 seek-filled frames, 24 decoded frames cached for scrubbing | 150, 10 (`index.html:728-730`) |
| Frame capture speed | up to 2x playback | 1x |
| TF.js backend | automatic choice | WebGL forced, automatic if that fails (`index.html:1107-1115`) |
| Coarse scan model | Thunder | Lightning (Thunder if Lightning failed to load) |
| Side coarse samples | 150 | 75 |
| Front and back samples | 50 each | 25 each |
| Pauses | none | 60 ms every 10 samples; 1.5 s between views |
| TF.js memory | no scope | one engine scope opened before the scan and closed after the card analysis, releasing the tensors made in between (`index.html:1340-1351`, `:1588-1596`) |
| Refinement, cards, inspector | Thunder | Thunder |
| Re-scan button | shown | hidden |
| New analysis | resets in place | reloads the page |

Layout that follows viewport width (CSS): nav extras in the hamburger at 1140 px and
below; one drop zone per row at 768 px; the phone notice on the upload screen and the
full-screen single-column inspector at 700 px (and in windows 500 px tall or less);
one card per row, and a sticky Analyze button once all three files are chosen, at
600 px; stacked controls at 480 px.

Because one is a user-agent test and the other a width test, a tablet in landscape
gets phone sampling with the desktop layout and without the upload-screen notice,
and a narrow desktop window gets the notice with desktop sampling.

---

## 5. Processing pipeline, end to end

```
three files (uploadedFiles.side / front / back)
  │  FrameStore.extract, one clip at a time on one <video>
  ▼
three frame stores (videoEls.side / front / back)
  │  side coarse scan: 150 samples (75 on phones), canvas at most 400 px wide
  │  body-scale filter, then findPhases
  ▼
l_foot, r_foot, l_toe, r_toe, mid: time + detected flag
  │  refineLegPlateau('left'), then ('right'): 33 ms steps, full stored frame, Thunder
  ▼
l_foot / l_toe and r_foot / r_toe overwritten with refined times
  │  front scan, then back scan: 50 samples each (25 on phones), same small canvas
  ▼
mid_front_l, mid_front_r, mid_back_l, mid_back_r: time + detected flag
  │  review screen built; analyzeCard per detected phase (Thunder, full stored frame)
  ▼
per phase: keypoints, metrics, sideView, frontBackMetrics, quality badge
  │  user review in the inspector: Analyze this frame / Swap L/R
  ▼
per phase: user-committed time, keypoints, metrics
  │  Complete analysis: detectIssues() then renderReport()
  ▼
lastIssues (six findings)  ──►  on-screen report, save, PDF
```

Two separate questions are answered at different points. *Which frame* belongs to a
phase is decided by the scan (sections 6.2 to 6.6) or by the user. *What the body is
doing* in that frame is measured afterwards by `analyzeCard` or `epReanalyze` from a
fresh pose of that one frame. The scan's own poses are not used for measurements.

### 5.1 Frame cache (`frame-store.js`)

Every frame the tool shows or poses is read from a frame store; no code seeks a live
`<video>` to get a frame. Each clip is played through once, muted, on the single
`<video id="capture-video">`, and every presented frame is captured with
`requestVideoFrameCallback` into a size-capped JPEG keyed by its exact presentation
time. Frames that playback missed are filled by seeking. The decoder is then
released, so only one decoder is ever live.

Options the page passes (`FRAME_STORE_OPTS`, `index.html:728-730`):

| Option | Desktop | Phone | Effect |
|---|---|---|---|
| `maxDim` | 1280 | 960 | Longest side of stored frames in px; never upscales. This is the pixel space of every full-size pose. |
| `maxFps` | 60 | 30 | Highest stored frame rate. |
| `maxFrames` | 900 | 600 | Cap per clip; longer clips are stored at a lower rate. |
| `quality` | 0.82 | 0.8 | JPEG quality. |
| `maxRate` | 2 | 1 | Fastest playback rate tried while capturing. |
| `maxSeeks` | 300 | 150 | Cap on seek-filled frames. |
| `cacheMax` | 24 | 10 | Decoded frames kept in memory at once. |

The minimum gap between stored frames is `max(1/maxFps, duration/maxFrames)`
(`frame-store.js:208`, `:410`), and a frame is kept when it is at least 0.9 of that gap
after the last kept one (`:285`). The resulting ceiling on the stored rate:

| Clip length | Desktop | Phone |
|---|---|---|
| up to 15 s | 60 fps | 30 fps |
| 20 s | 45 fps | 30 fps |
| 30 s | 30 fps | 20 fps |
| 60 s | 15 fps | 10 fps |

These are ceilings, not the rates stored. Only whole source frames are kept, so the
stored rate is the source rate divided by a whole number: a 60 fps clip of 20 s on
desktop keeps every second frame (30 fps, not 45), and a 30 fps clip of 30 s on a
phone keeps every second frame (15 fps, not 20). The hole filler (step 4 below) does
not add the skipped frames back, because those gaps are under 1.6 periods. A 60 fps
clip on a phone keeps every second frame up to 20 s, and fewer beyond. At the advised 8
seconds the `maxFrames` cap binds on neither; only `maxFps` limits the rate.

Capture, in order (`frame-store.js:392-448`):

1. Load the file into the `<video>`; wait for metadata (6 s, then a play attempt and
   8 s more), then up to 6 s more for the first frame's data. A decode error gives
   `error: 'unsupported'`; no metadata (no video width) gives `'no-metadata'`.
2. Compute the stored size from `maxDim`.
3. Play at 1x and capture frames in the frame callback. At most six JPEG encodes are
   in flight; frames arriving past that are skipped. Every 0.5 s of media, if fewer
   than 85% of due frames were stored the playback rate halves (floor 0.5x) and the
   halved rate becomes the new ceiling; if more than 97% were, it doubles up to the
   ceiling (`maxRate` until a halving lowers it) (`:290-310`). So once a rate has
   dropped frames, capture never speeds back up. A watchdog checks every second,
   resumes playback if it paused, ends capture after 6 s without a frame, and waits
   while the tab is hidden.
4. Find holes (gaps larger than 1.6 frame periods, including at the start and end)
   and fill them by seeking, up to `maxSeeks`, thinned evenly if there are more
   (`:350-390`). Seek-filling stops early after four failed seeks in a row.
5. If playback gave nothing, or the browser lacks `requestVideoFrameCallback`, fill
   the whole clip by seeking on a grid of at most 30 fps. This needs a known
   duration; without one the store is empty.
6. Wait up to 15 s for encodes to finish, release the decoder, build the store.

`extract` resolves with a store in every case; a clip that could not be decoded
yields a store with `ok: false` and no frames.

What a store exposes (`frame-store.js:110-179`):

| Member | Meaning |
|---|---|
| `ok` | at least one frame |
| `videoWidth`, `videoHeight` | stored frame size in px (0 when not ok) |
| `nativeWidth`, `nativeHeight` | the source clip's size |
| `duration` | seconds, or `NaN` |
| `fps` | estimated source frame rate (from the smallest gap between presented frames), or `null`. Not the stored rate. |
| `coverage` | stored frames divided by expected frames, 0 to 1 |
| `times[]`, `blobs[]` | sorted presentation times and their JPEGs |
| `frameCount()` | number of stored frames |
| `image(t)` | the decoded frame shown at `t`: the last stored frame at or before `t + 0.5 ms`; the first frame if `t` is earlier than it |
| `frameTime(t)` | that frame's own presentation time |
| `step(t, n)` | presentation time of the frame `n` stored frames away, clamped to the clip |
| `release()` | drop all frames |
| `method`, `error`, `extractMs`, `bytes`, `stats` | how the clip was captured (`playback`, `playback+seek`, `seek`), the failure reason, and timings; logged to the console, not read by the page |

`image(t)` keeps the last `cacheMax` decoded frames (least recently used first out)
and closes an evicted frame 1.5 s later, so callers draw it at once.

Things that follow from this and matter downstream:

- Stored frame spacing is not guaranteed uniform. Times are real presentation
  timestamps, thinned by the keep rule, with seek-filled frames inserted.
- `image(t)` never signals a hole. Across a gap, every requested time returns the
  same older frame.
- Poses are always estimated on downscaled JPEG frames, never on the source pixels.
- All frames of all three clips stay in memory as JPEG blobs until a reset or cancel.

Two helpers are the only readers (`index.html:739-748`): `getVideoFrame(store, t)`
and `drawVideoFrame(store, t, ctx, w, h)`.

### 5.2 Pose models (`initModel`, `index.html:1099-1146`)

| Variable | Model | Loaded | Used for |
|---|---|---|---|
| `detector` | MoveNet SINGLEPOSE_THUNDER | always; the loader waits for it | refinement, card analysis, inspector analysis, admin labelling, and the coarse scans on desktop |
| `scanDetector` | MoveNet SINGLEPOSE_LIGHTNING | phones only, in parallel | the coarse scans on phones, falling back to `detector` if it did not load (`index.html:1415`, `:1621`) |

Both are created with `modelType` and nothing else. Every call is
`estimatePoses(canvas)` with no other argument, and only `poses[0]` is read.

Library behaviour that the page depends on (pose-detection 2.1.3, single-pose
MoveNet):

- The model does not see the whole canvas. It sees a square crop of it, resized to
  256 px (Thunder) or 192 px (Lightning).
- The crop is state held by the detector object. On a detector's first call, and
  after a reset, the crop is a centred square whose side is the image's short side.
  After each successful pose, the next crop is a square centred on the hip midpoint
  and sized from that pose, blended with the previous crop (low-pass, alpha 0.9). The
  crop is stored as fractions of the image, so it carries over between canvases of
  different sizes.
- If the pose's score (the mean score of its keypoints that score above 0.2) is
  below 0.25, the detector resets itself and returns no pose. The next call starts
  from the centred square.
- A whole-image crop (padded to a square) is used only when a pose was returned but
  its torso was not visible, or the crop computed from it would be larger than the
  image's long side.
- Keypoint smoothing is on by default but is applied only when a timestamp is
  available. A canvas has none and the page passes none, so keypoints are not
  smoothed between calls. Only the crop carries over.
- Returned keypoints are in pixels of the canvas passed in.

The page never calls `reset()` or `dispose()` on either detector.

Every pose-estimation call site:

| Where | Line | Detector | Input canvas |
|---|---|---|---|
| Side coarse scan | `index.html:1434` | Lightning on phones, else Thunder | `#scan-canvas`, at most 400 px wide |
| Front and back coarse scans | `:1644` | same | same |
| Dense refinement | `:1952` | Thunder | offscreen, full stored frame |
| Card analysis, pass 1 and retry | `:2122`, `:2136` | Thunder | the card's canvas, full stored frame; retry on a contrast-stretched copy |
| Admin labelling | `:2332` | Thunder | offscreen, full stored frame |
| Inspector Analyze, pass 1 and retry | `:3022`, `:3029` | Thunder | `#ep-canvas`, full stored frame; retry as above |

### 5.3 Scan orchestration (`autoScanAll`, `index.html:1325-1604`)

1. Clear warnings. On phones, wait for Lightning if it is still loading and open a
   TF.js engine scope that is closed after the cards are analysed.
2. Warn about clips that did not decode.
3. `initPhases(sideDur / 2)`: every phase becomes
   `{key, label, desc, videoKey, side, detectsIssue, guide, t, detected: false, kps: null, metrics: null, frontBackMetrics: null, sideView: true}`
   with `t` at the middle of the side clip (`index.html:793-798`). The four front and
   back phases are then given `t` at 35% (left) and 65% (right) of their own clip
   (`:1396-1399`). A duration that is not a positive finite number is taken as 30 s
   (for the side clip, after one 500 ms wait and a second read).
   These placeholder times remain on any phase the scan does not detect.
4. Warn about very short clips (fewer than 45 stored frames, or under 2 s).
5. Side coarse scan, body-scale filter, `findPhases` (sections 6.2 to 6.4). On
   phones every coarse loop, here and in step 7, yields 60 ms after each 10 samples.
6. `refineLegPlateau('left')`, then `('right')` (section 6.5).
7. Front scan, then back scan (section 6.6). On phones a 1.5 s pause comes before
   each of them (`index.html:1504-1508`, `:1518-1522`).
8. Diagnostics line and the partial-coverage warning (a decoded clip whose
   `coverage` is under 0.9).
9. 700 ms pause; show the review screen; build the cards and the summary table.
10. For each phase in card order, if `detected`, `await analyzeCard(key)`.
11. Start the tour on a first visit. `scanInProgress = false`.

The cancel flag is checked before each clip is loaded, at the top of every coarse
sample, before and after refinement, before each of the front and back scans, and
around the 700 ms pause. It is not checked inside a clip's frame extraction, inside
refinement, or during card analysis.

`findPhases` and each `refineLegPlateau` call are wrapped in `try/catch` that logs
and continues. Nothing else in the scan is. An exception elsewhere is logged to the
console by `startAllVideos` (`index.html:1225-1228`) and the scan stops where it
was, with `scanInProgress` left `true` and, on phones, the TF.js scope left open.
Before step 9 the scanning screen stays up with no message; during the card loop
the review screen is already showing and the remaining cards stay at "pending".

### 5.4 Card analysis (`analyzeCard`, `index.html:2106-2166`)

Runs once per detected phase, after the review screen is visible, one at a time in
card order: `l_foot, r_foot, l_toe, r_toe, mid, mid_front_l, mid_front_r,
mid_back_l, mid_back_r`. It is called from nowhere else.

1. Draw the stored frame at `ph.t` on the card canvas at full stored size. If no frame
   comes back the canvas is left blank and still posed.
2. Pose it with Thunder.
3. No pose: badge "no pose", `ph.noPose = true`, card marked undetected. `ph.detected`
   and `ph.kps` are left as the scan set them. Stop.
4. Weak pose (section 7.6): pose a contrast-stretched copy once; use that result only
   if it is not weak.
5. `ph.kps = kps`, `ph.analyzedT = ph.t`.
6. Front or back phase: `ph.frontBackMetrics = computeFrontBackMetrics(kps)`,
   `ph.metrics` set to the same object, `ph.sideView = false`. Draw the pose.
7. Side phase: `ph.metrics = computeMetrics(kps)`, `ph.sideView = isSideView(kps)`.
   If side view, `addFunctionalMetrics` adds the lead / trail / stance values, the mini
   metrics and summary column are filled, and the wrong-leg check runs. If not side
   view, the card shows the side-view warning and no angles.
8. Set the quality badge ("Needs side view" for a side phase that failed the
   side-view test). If `lastIssues` is not null, re-run `detectIssues()` and
   `renderReport` (section 15). Re-evaluate the Complete analysis bar.

`analyzeCard` never changes `ph.t` or `ph.detected`, and it does not judge whether
the frame is the right gait moment. The only frame-correctness signals anywhere in
the page are the side-view test and the wrong-leg check, and both only produce a
warning.

### 5.5 Review and correction

The fields of `phases[key]` over its life:

| Field | Set by | Meaning |
|---|---|---|
| `t` | `initPhases` (placeholder), the scan, `epReanalyze`, admin labelling | committed frame time, seconds on that phase's clip |
| `detected` | the scan (`true`), `epReanalyze` (`true`) | a frame has been assigned |
| `kps` | the scan (scan poses), `analyzeCard`, `epReanalyze`, `swapLegs` (in place), admin labelling | pose of the committed frame |
| `metrics` | `analyzeCard`, `epReanalyze`, `swapLegs`, admin labelling | side: the side metrics object; front/back: the same object as `frontBackMetrics` |
| `frontBackMetrics` | `analyzeCard`, `epReanalyze`, `swapLegs` | front and back phases only |
| `sideView` | `analyzeCard`, `epReanalyze` | side phases: result of `isSideView`; front/back: `false` |
| `analyzedT` | `analyzeCard`, `epReanalyze`, admin labelling | time the current pose and metrics belong to (UI only) |
| `noPose` | `analyzeCard` (`true`), `epReanalyze` (`false`) | the card pass found no pose (UI only) |
| `legSwapWarning` | `renderLegSwapWarning` | wrong-leg warning text or `null` (UI only) |

The scan also leaves stray fields on side phases: `findPhases` merges the whole
coarse sample into the phase (`lAnkleY`, `rAnkleY`, `lAnkleX`, `rAnkleX`, `hipMidX`,
`lHipExt`, `rHipExt`, `lKnAngle`, `rKnAngle`, `conf`, `scale`). Nothing reads them
afterwards.

Admin labelling sets `t`, `kps`, `metrics` and `analyzedT` but leaves `detected`,
`noPose`, `sideView` and `frontBackMetrics` as they were (`index.html:2429-2434`).
On a front or back phase `metrics` and `frontBackMetrics` are then different
objects, and on a phase the scan left undetected the labelled frame is committed
while `detected` stays `false`.

How the rest of the page tests a phase:

| Question | Test |
|---|---|
| Auto-detected? | `detected` |
| Analysed? | `metrics` is truthy (the Complete bar also accepts `frontBackMetrics`) |
| Usable pose? | `kps && !noPose` |
| Are the shown numbers from the shown frame? | `abs(epCurrentT − analyzedT) ≤ 0.001` |
| Is the shown frame committed? | `abs(epCurrentT − t) ≤ 0.001` |

The rule for corrections: a phase's frame changes only when "Analyze this frame"
finds a pose on the displayed frame (section 4.6). Stepping, Swap L/R and Clear
overlay never change `t`.

### 5.6 From measurements to report

`detectIssues()` (`gait-engine.js:502-751`) reads `phases` and `selectedSex` and
returns an object with six keys. It runs when Complete analysis is pressed
(`completeAnalysis`, `index.html:1066`). Its result is kept in `lastIssues` and is
what the on-screen report, the save and the PDF all use. Two other call sites exist
and rarely fire (section 15). Changing the selected sex re-grades the
summary table's range symbols but does not re-run the rules. Sections 8 and 10 cover
the rules and the outputs.

---

## 6. The nine phases and how each is detected

### 6.1 The phases (`PHASE_DEFS`, `gait-data.js:195-205`)

| # | Key | Label | Clip | One-line description | Target frame, in the tool's own words |
|---|---|---|---|---|---|
| 1 | `l_foot` | L foot strike | side | Left initial contact with ground | "The instant the left foot first contacts the ground." |
| 2 | `r_foot` | R foot strike | side | Right initial contact with ground | "The instant the right foot first contacts the ground." |
| 3 | `l_toe` | L toe-off | side | Left foot leaving the ground | "The moment the left foot pushes off. Hip extension is at maximum." Checks include "Left heel visibly raised". |
| 4 | `r_toe` | R toe-off | side | Right foot leaving the ground | "The moment the right foot pushes off." |
| 5 | `mid` | Mid-stance | side | Body directly over support foot | "The body passes directly over the supporting foot." |
| 6 | `mid_front_l` | L mid-stance (front) | front | Left foot planted under body, front view | "A frontal view at the moment the left foot is planted directly underneath the body." |
| 7 | `mid_front_r` | R mid-stance (front) | front | Right foot planted under body, front view | mirror of 6 |
| 8 | `mid_back_l` | L mid-stance (back) | back | Left foot planted under body, rear view | "A rear view at the moment the left foot is planted directly underneath the body. Confirms left-stance hip drop from the front view." |
| 9 | `mid_back_r` | R mid-stance (back) | back | Right foot planted under body, rear view | mirror of 8 |

Section 4.6 quotes the stricter frame definitions shown with the example photos
(foot strike is the first frame of ground contact; toe-off is the last).

Image coordinates: x grows to the right, y grows downward. "Ankle lowest in the
frame" therefore means the largest ankle y.

### 6.2 Side clip: coarse sampling (`index.html:1410-1464`)

`N` = 150 samples on desktop, 75 on phones, evenly spaced over the whole clip:
`t = min((i + 0.5) · sideDur / N, sideDur − 0.05)`.

For each sample:

1. Draw the stored frame at `t` onto `#scan-canvas`, sized `min(400, storedWidth)`
   wide with the height following the clip's aspect ratio. A landscape 16:9 clip is
   posed at 400 × 225; a portrait 9:16 clip at 400 × 711.
2. Pose that canvas. No pose, or an error, skips the sample.
3. Record:

| Field | Definition |
|---|---|
| `t` | the requested time (not the stored frame's own timestamp) |
| `lAnkleY`, `rAnkleY`, `lAnkleX`, `rAnkleX` | ankle keypoints 15 and 16 in scan-canvas pixels; `undefined` when the score is under 0.25 |
| `hipMidX` | mean x of the two hips, only when both score at least 0.25 |
| `conf` | mean score of all 17 keypoints, face included |
| `scale` | body scale: vertical distance between shoulder midpoint and hip midpoint (one shoulder or one hip is used if the other is missing); `null` with no shoulder or no hip |
| `kps` | the 17 keypoints in scan-canvas pixels |
| `lHipExt`, `rHipExt`, `lKnAngle`, `rKnAngle` | hip and knee angles; computed and never read |

Sample spacing depends only on clip length:

| Side clip length | Desktop (150) | Phone (75) |
|---|---|---|
| 5 s | 33 ms | 67 ms |
| 8 s | 53 ms | 107 ms |
| 10 s | 67 ms | 133 ms |
| 15 s | 100 ms | 200 ms |
| 20 s | 133 ms | 267 ms |
| 30 s | 200 ms | 400 ms |

### 6.3 Body-scale filter (`index.html:1468-1477`)

If at least 8 samples have a positive `scale`: take the median, and keep only samples
whose `scale` is at least 55% of it. Samples with no scale are dropped too. With
fewer than 8 values nothing is filtered. The stated purpose is to drop frames where
the runner is far from the camera.

### 6.4 Side clip: `findPhases(samples, dur)` (`index.html:1736-1933`)

Returns at once when there are no samples. Samples are sorted by time.

Building blocks:

| Helper | What it does |
|---|---|
| `localPeaks(key, 2)` | A sample is a peak when no sample within 2 positions either side (by index, not time) has a strictly greater value. Missing neighbours are ignored. The first and last samples can never be peaks. |
| `prominenceFilter(peaks, key, 0.55)` | Keeps peaks whose value is at or above the 55th-percentile value of the whole series. Skipped with fewer than 6 values. It is a cut on raw value, not a prominence measure. |
| `pickByScore(cands, ref)` | The one candidate maximising `(value − ref) · (0.5 + 0.5 · conf)`. Ties go to the earliest. |
| `plateauTol` | 5% of the median `scale`, in scan-canvas pixels; 8 px if no sample has a scale. |
| `findStancePlateau(key, peakIdx)` | `threshold = value at the peak − plateauTol`. Walk backwards from the peak: a sample that is missing or below the threshold counts as a miss; two misses in a row stop the walk; any sample at or above the threshold resets the count and becomes the new leading edge `lo`. The same walk forwards gives the trailing edge `hi`. Positions are indices into the surviving samples. |
| `tooClose(t, others)` | True when any other time is within 50 ms. |

Steps:

1. Left strike candidates: local peaks of `lAnkleY` (ankle lowest in the frame) at or
   above that series' 55th percentile. Right candidates likewise from `rAnkleY`.
2. `lPeak`: the single best left candidate in the whole clip, scored against the
   median `lAnkleY`.
3. `rPeak`: the single best right candidate in the whole clip, scored against the
   median `rAnkleY`, after removing candidates within 0.10 s of `lPeak`. Nothing else
   relates the right pick to the left one.
4. For each leg with a peak, find its plateau. If the plateau has more than one
   sample (`lo ≠ hi`): foot strike is the sample at `lo`, toe-off the sample at `hi`.
   Otherwise foot strike is the peak sample itself and there is no coarse toe-off.
5. `l_foot` and `r_foot` are marked detected whenever they exist.
6. `l_toe` is marked detected unless it is within 50 ms of either foot strike.
   `r_toe` is marked detected unless it is within 50 ms of either foot strike or of
   the left toe-off time (which counts even when `l_toe` itself was rejected).
7. Mid-stance, `pickMidStance(stanceSide, startT, endT)`:
   - If both strikes exist and the right one is later: stance side is left, window is
     from `lFoot.t + 0.02` to `rFoot.t − 0.02`. If instead the left one is later:
     stance side is right, window from `rFoot.t + 0.02` to `lFoot.t − 0.02`.
   - Candidates are samples in the window that have the stance ankle's x and
     `hipMidX`. For each, `offsetNorm = |ankleX − hipMidX| / scale`.
   - `band = max(0.04, smallest offsetNorm + 0.03)`. Among candidates within the band,
     the winner is the one with the highest `conf`; offset only breaks ties. (Without
     any scale the same is done in pixels with a band of the smallest offset + 4 px.)
   - If that yields nothing (a strike is missing, the two strikes share a time, or the
     window has no candidates), mid-stance is the middle sample of the clip:
     `samples[floor(length / 2)]`.
   - If the chosen time is within 50 ms of any coarse foot-strike or toe-off time, it
     is replaced by the nearest sample in time that is not.
   - `mid` is marked detected. Whenever at least one sample exists, `mid` is always
     detected.

Each detected phase is written as the phase object merged with the whole sample and
`detected: true`, so its `t` is the sample time and its `kps` are the scan pose in
scan-canvas pixels.

### 6.5 Side clip: dense refinement, `refineLegPlateau(side)` (`index.html:1968-2023`)

Runs for the left leg, then the right. For one leg (`l_foot` + `l_toe` with ankle
15, or `r_foot` + `r_toe` with ankle 16):

1. Skip if neither phase is detected.
2. Window: from 0.20 s before the coarse foot strike (or the toe-off if there is no
   strike) to 0.20 s after the coarse toe-off (or the strike if there is no toe-off),
   clamped to `[0.02, duration − 0.05]`. Skip if the window is under 0.08 s.
3. Step through the window every 0.033 s. At each step draw the stored frame at full
   stored size on an offscreen canvas and pose it with Thunder. A step is dropped,
   not kept as a gap, when there is no frame, no pose, or this ankle scores under
   0.25. Kept steps record `t`, `ankleY`, `scale`, `kps` in stored-frame pixels.
4. Skip if fewer than 4 steps were kept.
5. Peak: the first step with the largest `ankleY` in the window.
6. `tol` = 5% of the median `scale` of the kept steps (8 px with no scale);
   `threshold = peak ankleY − tol`.
7. Walk backwards and forwards from the peak with the same two-misses rule as the
   coarse plateau to get `lo` and `hi`.
8. If `lo = hi`, stop and keep the coarse picks.
9. Otherwise overwrite both phases: foot strike gets the time and keypoints at `lo`,
   toe-off those at `hi`, both `detected: true`.

Consequences visible in the code:

- The step is a fixed 33 ms whatever the stored frame rate. On a clip stored at
  60 fps it reads every second frame. On a clip stored below 30 fps, consecutive
  steps can return the same frame.
- Refinement marks the toe-off detected even when `findPhases` had not found one or
  had rejected it as too close to another event.
- After refinement nothing checks the four events for distinctness or order, and
  `mid` is not recomputed. `mid` keeps its coarse time.
- The times written are grid times (`t0 + k · 0.033`), not stored-frame timestamps.
  The frame store resolves each to the frame at or before it.

### 6.6 Front and back clips: `scanBestStanceFrames` (`index.html:1612-1715`)

The same function runs unchanged for the front clip and for the back clip.

`NFRAMES` = 50 on desktop, 25 on phones, evenly spaced:
`t = min((i + 0.5) · dur / NFRAMES, dur − 0.05)`. The canvas is the same
at-most-400-px scan canvas.

| Clip length | Desktop (50) | Phone (25) |
|---|---|---|
| 5 s | 100 ms | 200 ms |
| 8 s | 160 ms | 320 ms |
| 10 s | 200 ms | 400 ms |
| 20 s | 400 ms | 800 ms |

A sample is unusable when: there is no frame or no pose; either ankle or either hip
scores under 0.25; or the hips are less than 10 scan-canvas pixels apart
horizontally.

For each usable sample, with `hipWidth = |lHip.x − rHip.x|` and
`bodyMidX` the hips' mean x:

```
avgConf        = mean score of all 17 keypoints
heightDiff     = (lAnkle.y − rAnkle.y) / hipWidth          positive = left ankle lower in the image
heightFactorL  = max(0,  heightDiff)
heightFactorR  = max(0, −heightDiff)
midProxL       = max(0, 1 − |lAnkle.x − bodyMidX| / hipWidth)
midProxR       = max(0, 1 − |rAnkle.x − bodyMidX| / hipWidth)
lScore         = avgConf · (0.4 + 0.6 · min(1, 2 · heightFactorL)) · (0.3 + 0.7 · midProxL)
rScore         = avgConf · (0.4 + 0.6 · min(1, 2 · heightFactorR)) · (0.3 + 0.7 · midProxR)
lScore = 0 when heightDiff < 0;   rScore = 0 when heightDiff > 0
```

So a frame can only score for the side whose ankle is lower in the image. The height
term reaches its maximum once that ankle is half a hip-width lower. The proximity
term rewards the lower ankle being close to the hip midline sideways.

Body-scale filter: with at least 8 samples having a scale (here it needs both
shoulders at 0.25 or more), samples whose scale is missing or under 55% of the median
have both scores set to 0.

Pick: `pickBestPeak` looks for local maxima within ±3 samples (±2 on phones) and
returns the highest one. Since the highest score in the clip is always a local
maximum, the result is simply the sample with the highest `lScore` for the left
phase and the highest `rScore` for the right phase, earliest on ties. A side with no
non-zero score gets no frame.

`applyStanceFrame` (`index.html:1717-1730`) writes the time and scan keypoints and
sets `detected: true`, or leaves the phase at its placeholder time.

There is no refinement pass for these four phases.

### 6.7 Summary: where each phase's time comes from

| Phase | Time comes from | Time resolution | If not detected, `t` is |
|---|---|---|---|
| `l_foot` | leading edge of the left-ankle plateau in the dense pass; else the coarse leading edge; else the coarse peak sample | 33 ms grid, or one coarse sample | middle of the side clip |
| `r_foot` | same for the right ankle | same | middle of the side clip |
| `l_toe` | trailing edge in the dense pass; else the coarse trailing edge | same | middle of the side clip |
| `r_toe` | same for the right ankle | same | middle of the side clip |
| `mid` | coarse sample between the two coarse strikes with the stance ankle's x nearest the hip midpoint (highest `conf` within the band); else the middle sample of the clip; moved if within 50 ms of a coarse event | one coarse sample | middle of the side clip |
| `mid_front_l` | highest `lScore` sample of the front clip | one sample | 35% through the front clip |
| `mid_front_r` | highest `rScore` sample of the front clip | one sample | 65% through the front clip |
| `mid_back_l` | highest `lScore` sample of the back clip | one sample | 35% through the back clip |
| `mid_back_r` | highest `rScore` sample of the back clip | one sample | 65% through the back clip |

### 6.8 Every way a phase ends the scan undetected ("manual")

All five side phases together:

- the side clip did not decode;
- no coarse sample returned a pose;
- `findPhases` threw (caught and logged).

Individually:

| Phase | Undetected when |
|---|---|
| `l_foot` | there is no interior local peak of `lAnkleY` at or above the 55th percentile: for example the left ankle scores under 0.25 on nearly all samples, too few samples survive, or the series only rises or only falls (its maximum is at an end of the list) |
| `r_foot` | the same for the right ankle, or every right candidate is within 0.10 s of the chosen left peak |
| `l_toe` | `l_foot` is undetected; or the coarse pass gave no toe-off (one-sample plateau, or within 50 ms of a strike) and refinement did not write one (window under 0.08 s, fewer than 4 dense steps with the ankle at 0.25 or more, a one-step dense plateau, or an exception) |
| `r_toe` | as `l_toe`, with the coarse closeness check also against the left toe-off |
| `mid` | only the three whole-clip cases above |
| each front or back phase | the clip did not decode; or no sample passed the gates, survived the scale filter, and had that side's ankle lower |

A detected phase can still fail at the card: "no pose", "Needs side view", a
wrong-leg warning, or simply the wrong moment. The "D of 9 auto-detected" count
covers only the scan's `detected` flags.

### 6.9 Detection constants

| Constant | Value | Where |
|---|---|---|
| Keypoint confidence floor (`MIN_CONF`) | 0.25 | `gait-data.js:192` |
| Side coarse samples | 150 desktop, 75 phone | `index.html:1410` |
| Front / back samples | 50 desktop, 25 phone | `:1618` |
| Scan canvas width | `min(400, stored width)` | `:1431`, `:1641` |
| Body-scale filter | keep ≥ 0.55 × median; needs ≥ 8 values | `:1468-1477`, `:1682-1694` |
| Local-peak neighbourhood (side) | ±2 samples | `:1830-1831` |
| Strike percentile cut | 0.55; needs ≥ 6 values | `:1776-1781` |
| Candidate score | `(value − median) · (0.5 + 0.5 · conf)` | `:1790-1793` |
| Left/right peak exclusion | 0.10 s | `:1836` |
| Plateau tolerance | 0.05 × median body scale; 8 px fallback | `:1808-1810`, `:1998-2000` |
| Plateau walk stop | 2 consecutive misses | `:1818`, `:1824`, `:2006`, `:2012` |
| Event collision distance | 0.05 s | `:1867-1870` |
| Mid-stance window inset | 0.02 s inside each strike | `:1914`, `:1917` |
| Mid-stance band | `max(0.04, min offset + 0.03)` trunk lengths; `min + 4` px fallback | `:1900`, `:1908` |
| Refinement window | coarse strike − 0.20 s to coarse toe-off + 0.20 s; minimum 0.08 s | `:1975-1980` |
| Refinement step | 0.033 s | `:1985` |
| Refinement minimum steps | 4 | `:1991` |
| Front/back hip-width gate | 10 scan-canvas px | `:1654-1655` |
| Front/back score weights | height 0.4 + 0.6; proximity 0.3 + 0.7; height saturates at 0.5 hip-widths | `:1665-1666` |
| Front/back peak spacing | `max(2, round(NFRAMES / 20))` samples | `:1698` |
| Placeholder times | side: `sideDur / 2`; front/back: 0.35 and 0.65 of the clip | `:1379`, `:1396-1399` |
| Phone pauses | 60 ms per 10 samples; 1500 ms between views | `:1421-1423`, `:1631-1633`, `:1504-1508`, `:1518-1522` |
| Last sample time | `duration − 0.05` s at most | `:1424`, `:1634` |
| Missing or bad duration | 30 s | `:1376-1377`, `:1393-1395`, `:1614` |
| Refinement clamp | window held inside `[0.02, duration − 0.05]` s | `:1978-1979` |

---

## 7. Measurements and formulas

All measurements are 2-D, in the image plane, from the 17 keypoints of one frame. A
keypoint scoring under 0.25 is treated as missing, and a metric whose inputs are
missing is simply absent.

### 7.1 `calcAngle(a, b, c)` (`gait-engine.js:70`)

The interior angle at `b` between the segments to `a` and to `c`, in degrees, 0 to
180, unsigned. Because it is unsigned it cannot tell flexion from extension: a hip
angle of 170° reads the same whether the thigh is 10° in front of or behind the
trunk line.

### 7.2 Side-view metrics, `computeMetrics(kps)` (`gait-engine.js:73-81`)

`shM` and `hiM` are the shoulder and hip midpoints. `dir` is +1 when the nose is
present and to the right of `hiM`, otherwise −1 (so a low-confidence nose means
"facing left" is assumed). `th = |hiM.y − shM.y|` is the vertical torso height.

| Metric | Needs | Formula | Reading |
|---|---|---|---|
| `trunk` | both shoulders, both hips | `dir · atan2(shM.x − hiM.x, hiM.y − shM.y)` in degrees | lean of the hip-to-shoulder line from image vertical; positive = leaning the way the runner faces |
| `lFoot`, `rFoot` | the four torso points and that ankle | `dir · (ankle.x − hiM.x) / th` | horizontal ankle offset from the hip midpoint in torso heights; positive = ankle ahead of the hips |
| `lKnee`, `rKnee` | hip, knee, ankle | `calcAngle(hip, knee, ankle)` | 180 = straight leg |
| `lHip`, `rHip` | shoulder, hip, knee | `calcAngle(shoulder, hip, knee)` | 180 = trunk and thigh in line |
| `lElbow`, `rElbow` | shoulder, elbow, wrist | `calcAngle(shoulder, elbow, wrist)` | 180 = straight arm |

`trunk`, `lFoot` and `rFoot` all need the four torso keypoints, so one
low-confidence far-side shoulder or hip removes all three.

### 7.3 Functional metrics, `addFunctionalMetrics` (`gait-engine.js:258-308`)

Added only for side-clip phases whose frame passed the side-view test. These are
the metrics the UI and the rules actually use.

Near arm: for each arm, the mean score of whichever of its shoulder, elbow and wrist
score 0.25 or more (0 when none do); the arm with the higher mean is taken as the
camera-side arm (ties go to left). `nearElbow` is that arm's elbow angle, absent when
that elbow angle is; `nearElbowSide` is `'L'` or `'R'` and is set either way. The
phase also gets `leadSide` and `trailSide` (foot strikes and toe-offs) or `plantSide`
(`mid`), `'L'` or `'R'`, which label the values on screen and in the PDF.

Lead, trail and stance legs are assigned from the phase key, not from the pose:

| Phase | Assignment | Values copied |
|---|---|---|
| `l_foot` | lead = left | `leadKnee = lKnee`, `leadHip = lHip`, `leadFoot = lFoot` |
| `r_foot` | lead = right | `leadKnee = rKnee`, `leadHip = rHip`, `leadFoot = rFoot` |
| `l_toe` | lead = right, trail = left | `leadHip = rHip`, `trailHip = lHip` |
| `r_toe` | lead = left, trail = right | `leadHip = lHip`, `trailHip = rHip` |
| `mid` | stance = the ankle lower in the image (ties go to left) | `plantKnee`, `plantHip` from that side |

Which metrics each phase shows and saves, by their on-screen labels (`PHASE_METRICS`,
`gait-data.js:235-245`):

| Phase | Metrics |
|---|---|
| `l_foot`, `r_foot` | Trunk lean, Lead knee, Lead hip, Lead foot off., Elbow |
| `l_toe`, `r_toe` | Trunk lean, Lead hip, Trail hip, Elbow |
| `mid` | Trunk lean, Stance knee, Stance hip, Elbow |

Trunk lean shows one decimal with a sign; foot offset two decimals with a sign;
angles whole degrees (`METRIC_ROWS`, `gait-data.js:216-233`). The raw `lKnee`,
`rHip` and so on are computed but never displayed or saved. They are still read: by
the wrong-leg check (7.7), as the fallbacks in the overstriding and arm-angle rules
(section 8), in a live session's PDF request (10.3) and in admin labels (12.1).

A side phase whose frame fails the side-view test keeps the raw metrics from
`computeMetrics` (including `trunk`, `lFoot`, `rFoot` and the elbows) but gets no
functional ones. The rules read those raw values: such a frame still feeds
overstriding, torso position and arm angle, while the card shows "Needs side view"
and the report counts the phase as unusable (10.1).

### 7.4 Front and back metrics, `computeFrontBackMetrics(kps)` (`gait-engine.js:87-216`)

The same function serves front and back clips. It measures relative to the runner's
trunk, not to the image, so camera roll does not change the values. With both
shoulders and both hips present and the torso longer than 10 px: `bodyUp` is the
unit vector from hip midpoint to shoulder midpoint, and `bodyLat` is its
perpendicular, oriented so the keypoint labelled right hip is on the positive side.
Left and right come entirely from the model's labels. The wrist values also need the
shoulder width along `bodyLat` above 10 px, and the valgus values the hip width along
`bodyLat` above 10 px; otherwise they stay `null`.

In a live session `analyzeCard`, `epReanalyze` and `swapLegs` also set a front or
back phase's `metrics` to this same object (as the "analysed" mark), so the live PDF
request carries it under `metrics` (10.3). Saves store it only as
`frontBackMetrics`.

| Output | Formula | Reading |
|---|---|---|
| `hipDropDeg` | `atan2(abs(hhVert), abs(hhLat))` in degrees, where `hhVert` and `hhLat` are the hip-to-hip vector's components along `bodyUp` and `bodyLat`; needs `abs(hhLat) > 10` px | pelvic tilt relative to the trunk; unsigned, 0 = level. It does not say which hip is lower. |
| `hipDrop` | `hhVert / torsoLength` | signed ratio; positive = left hip lower. Shown only as "Left hip lower" / "Right hip lower". |
| `hipDropAbs` | `abs(hipDrop)` | not read by the rules |
| `lWristCross` | `max(0, ((lWrist − shMid) · bodyLat) / shoulderWidth)` | how far the left wrist is on the right side of the trunk midline, as a fraction of shoulder width; 0 = not crossed |
| `rWristCross` | `max(0, −((rWrist − shMid) · bodyLat) / shoulderWidth)` | same for the right wrist |
| `stanceSide` | the ankle farther down the body axis from the hip midpoint (ties go to left) | measured from the frame, independent of the phase's L or R. Stored only when a valgus value is computed. |
| `lKneeValgusDeg`, `rKneeValgusDeg` | for the stance leg only: `180 − calcAngle(hip, knee, ankle)`, positive when the knee is on the same side of the hip-to-ankle line as the opposite hip | frontal plane projection angle (FPPA); positive = valgus (knee inward), negative = varus |
| `lKneeValgus`, `rKneeValgus` | knee's distance from the hip-to-ankle line over hip width, floored at 0 | not read by the rules |
| `avgConfidence` | mean score of all 17 keypoints | used to decide whether the back view is blended into hip drop |

### 7.5 Detection quality, `getDetectionQuality(kps)` (`index.html:809-818`)

Uses the scores of ten keypoints: shoulders, elbows, hips, knees, ankles (5 to 8 and
11 to 16). Wrists and face are ignored. A missing score counts as 0.

| Level | Condition |
|---|---|
| Strong | mean ≥ 0.72 and minimum ≥ 0.4 |
| Fair | mean ≥ 0.5 and minimum ≥ 0.25 |
| Weak | anything else |

Used for the card badge, the inspector's pill and quality card, the "S of 9 have
strong detection" count and the saved `quality` field.

### 7.6 Weak-pose retry (`gait-engine.js:218-256`)

`isWeakDetection` is exactly the Weak condition above. When the first pose of a
frame is weak, `normalizeAndRetry` copies the canvas, samples luminance at every
16th pixel, and if the luminance range is above 5 and below 230 stretches every
pixel linearly to the full 0 to 255 range. The copy is posed once. The second result
replaces the first only if it is not weak. When the range is 230 or more (or 5 or
less) the copy is unchanged, so the second pass sees identical pixels.

Used in `analyzeCard` and `epReanalyze` only. The coarse scans, refinement and admin
labelling do not retry.

### 7.7 Side-view test and wrong-leg check

`isSideView(kps)` (`gait-engine.js:17-30`): with both hips at 0.25 or more, the frame
is side-on when `|lHip.x − rHip.x| / torsoHeight < 0.7`. `torsoHeight` is the
vertical distance between the shoulder and hip midpoints, or, when a shoulder is
missing, twice the vertical gap between the hips (100 px if that is 0). If either hip
is missing it returns true.

`checkLegSwap(key, metrics)` (`index.html:917-945`) compares raw left and right
angles on the four foot-strike and toe-off phases:

| Phase | Warns when | Message |
|---|---|---|
| `l_foot` | `rKnee > lKnee + 20` | "This looks like a right foot strike, not left…" |
| `r_foot` | `lKnee > rKnee + 20` | "This looks like a left foot strike, not right…" |
| `l_toe` | `rHip > lHip + 15` | "This looks like a right-side toe-off, not left…" |
| `r_toe` | `lHip > rHip + 15` | "This looks like a left-side toe-off, not right…" |

It produces a warning on the card and in the inspector and nothing else. There is no
such check for `mid` or the front and back phases.

### 7.8 Pose overlay (`drawPose`, `gait-engine.js:32-67`)

Bones and joints where both ends score at least 0.25: teal for left, orange for
right, purple for cross-body, white for face points. On a frame that passes the
side-view test it adds a dashed gold trunk line and arcs with angle labels at knees,
hips and elbows; otherwise a caption "Front/back view -- pose overlay only". The
trunk label on the overlay is the raw lean without the facing-direction sign, so it
can show the opposite sign to the `trunk` metric when the runner faces left.

---

## 8. The six issue rules (`detectIssues`, `gait-engine.js:502-751`)

Each rule returns `{detected, severity, details}` with `severity` `'mild'`,
`'notable'` or `null`. Detected issues may add `sideSev: {L, R}` (per-side severity),
`sideTagLabel: 'arm'`, or `cueKey`. All comparisons are strict "greater than" unless
stated. "No input" and "measured and clear" both give `detected: false`; the report
separates them (section 10.1). `details` is the rule's clear sentence when nothing
flags, otherwise a text line of the per-side values, z-scores or degrees and the
baseline; it is saved, but nothing on the page or in either PDF displays it.

| # | Rule | Reads | Value graded | Mild | Notable |
|---|---|---|---|---|---|
| 1 | Overstriding | `l_foot`, `r_foot` | each side's `leadFoot` as a z-score against one pooled left+right baseline | z > 1 | z > 2 |
| 2 | Hip drop | `mid_front_l/r`, `mid_back_l/r` | `hipDropDeg` per stance side, front and back blended | > 8° (female > 9°) | > 12° (female > 13°) |
| 3 | Arms crossing midline | `mid_front_l`, `mid_front_r` | each wrist's largest crossing across the two front frames | > 0.05 of shoulder width | > 0.15 |
| 4 | Torso position | all five side phases | mean z-score of `trunk` across phases | mean z beyond ±1 | mean z beyond ±2 |
| 5 | Arm angle too open | `l_toe`, `r_toe` | mean `nearElbow` of the two toe-off frames | > mean + 2 SD | > mean + 4 SD |
| 6 | Knee valgus | `mid_front_l`, `mid_front_r` | signed FPPA of the stance knee per side | > 6° (female > 7°) | > 10° (female > 11°) |

Details per rule:

**1. Overstriding** (`:505-554`). Per side, the value is `leadFoot`, falling back to
the raw `lFoot` / `rFoot` (the case for a frame that failed the side-view test, 7.3).
The baseline is `getPooledStats('leadFoot')` (section 9).
One-directional: only a foot too far ahead flags. Top severity is the worse side.
With the default baseline (0 ± 0.1) mild starts above 0.10 torso heights and notable
above 0.20.

**2. Hip drop** (`:556-618`). Per stance side, `blendCPD(front, back)`: only one
view present gives that view's value; both present gives `(2 · front + back) / 3` if
the back frame's `avgConfidence` is at least 0.4, otherwise the front value alone.
Asymmetry: when both sides exist and differ by 3° or more, the higher side is raised
one level (mild to notable; clear to mild only if its value is above 4°). The
thresholds with no sex selected are the 8° / 12° pair. Because `hipDropDeg` is
unsigned, the rule grades the size of pelvic tilt in that frame whichever way it
tilts.

**3. Arms crossing** (`:620-639`). Front clip only. Graded only when at least one
front phase has `frontBackMetrics`; a missing wrist counts as 0.

**4. Torso position** (`:641-671`). For each side phase with a `trunk` value,
`z = (trunk − mean) / sd` against that phase's own stats (section 9). The mean z
decides: below −1 is "too upright" (`cueKey: 'torsoUpright'`), above +1 is
"excessive lean" (`'torsoLean'`). With the default stats (12.5 ± 5): mild upright
below 7.5° mean lean, notable below 2.5°; mild lean above 17.5°, notable above
22.5°.

**5. Arm angle** (`:673-705`). Per toe-off frame the value is `nearElbow`, falling
back to the mean of whichever raw elbows exist; the two frames are averaged, or the
one that has a value is used alone. The
baseline is the sex-combined `arm_drive` stats (section 9). One-directional. With
the default stats (80 ± 20): mild above 120°, notable above 160°.

**6. Knee valgus** (`:707-748`). Front clip only. The left value is
`mid_front_l`'s `lKneeValgusDeg`; the right value is `mid_front_r`'s
`rKneeValgusDeg`. Each exists only if `computeFrontBackMetrics` judged that same leg
to be the stance leg in that frame; otherwise that side is "no data". Varus never
flags. Asymmetry works as in hip drop (3° gap, 4° floor) on the signed values.

---

## 9. Reference ranges

### 9.1 Defaults (`DEFAULTS`, `gait-data.js:26-43`)

The same for every phase:

| Metric | Green band | Warn band |
|---|---|---|
| `trunk` | 5 to 20 | −10 to 30 |
| knee angles | 120 to 175 | 90 to 185 |
| hip angles | 140 to 185 | 110 to 200 |
| elbow angles | 50 to 110 | 20 to 130 |
| foot offsets | −0.15 to 0.15 | −0.3 to 0.3 |

Only the green band is used on the page: Within, Above or Below range
(`positionLabel`, `gait-data.js:57-64`, inclusive ends), and in Compare, where a
change is coloured by whether session B is closer than session A to the middle of
the green band (`saved-analyses.js:582-588`). The warn band is returned but never
read.

### 9.2 Live ranges

`loadLiveRanges()` (`auth-paywall.js:19-37`) reads three public Firestore documents
at page load, `computed_ranges/male`, `/female` and `/combined`, and keeps each
document's `phases` map. A document that fails to load or does not exist is skipped
without a message; only an unexpected exception logs a warning. Defaults stay in
force for whatever is missing. The sex card's note reads "Live <sex> ranges loaded"
whenever that sex's document exists, whether or not any entry in it is reliable.

Each document is `{sex, sampleCount, lastUpdated, phases}`. Shape, per phase and
metric: `{n, reliable, mean, sd, median, mad, center, spread, green, warn}`, where
`center` is the median, `spread` is MAD × 1.4826 (the sample SD when the MAD is 0),
`green = center ± spread` and `warn = center ± 2 · spread`; entries with fewer than
five values carry only `{n, reliable: false}` (`reference-data/index.html:2759-2866`).
Two virtual phases exist: `pooled.leadFoot` (every `l_foot` and `r_foot` `leadFoot`
value pooled, so up to two per session) and `arm_drive.nearElbow` (per-session mean
of the two toe-off elbows, or the one present).

The documents are built on the admin reference-data page from frames chosen there.
Its phase list is the five side phases plus a `peak_kf` phase that esFormLab does not
have and never reads. Nothing front or back is in them; front and back are graded
with the constants in section 8.

### 9.3 Lookups (`gait-data.js:45-158`)

| Function | Returns | Live when |
|---|---|---|
| `getRange(phase, metric)` | green and warn bands | a sex is selected and that sex's entry is reliable with n ≥ 5 |
| `getRangeStats(phase, metric)` | mean and SD for z-scores | same; prefers `center` / `spread`, else `mean` / `sd`. Default: mean = middle of the green band, SD = a third of its width (trunk 12.5 ± 5, knees 147.5 ± 18.3, hips 162.5 ± 15, elbows 80 ± 20, foot offsets 0 ± 0.1) |
| `getPooledStats('leadFoot')` | pooled baseline for overstriding | the selected sex's `pooled.leadFoot` is reliable; else the average of the left and right foot-strike stats |
| `getCombinedStats('arm_drive', 'nearElbow')` | baseline for arm angle | the `combined` document's entry is reliable (no sex needed); else falls back to `getRangeStats` |

With no sex selected, everything except the arm-angle baseline uses defaults, and
hip drop and knee valgus use the lower (non-female) thresholds.

---

## 10. Report, save and PDF

### 10.1 On-screen report (`report-render.js`)

`renderReport(issues)` draws the six cards from the issues object and the copy in
`REPORT_DATA`. Two display-only helpers decide wording:

- `eflCheckMeasured(key)` (`:67-86`): whether the rule had at least one input. A rule
  with no input shows "Not measured" and "This check couldn't run — <its frames> had
  no usable measurement." instead of "Clear".
- `eflPhaseUsable(def)` (`:57-62`): a phase is usable when it is not `noPose` and has
  metrics (and, for side phases, passed the side-view test). The count of unusable
  phases feeds the anomaly banner, which only a user without a pass sees: with
  nothing flagged it reads "Your scan is incomplete — N of 9 phases have no usable
  frame"; with findings it appends "Note: N of 9 phases have no usable frame".

When nothing is flagged and at least one rule is "Not measured", the cards are
headed "N of 6 checks couldn't be run" instead of "No major gait-pattern flags
detected" (`report-render.js:299-311`).

`buildSummaryTable()` and `updateSummaryCol(key)` (`:378-406`) fill the side-view
table from each phase's `metrics`. `renderFrontBackTable()` (`:319-351`) fills the
front/back table from `frontBackMetrics`. The stance-side row shows the side measured
from the frame when there is one, else the side in the phase's name.

### 10.2 Save

`saveAnalysis()` (`saved-analyses.js:55-111`) writes the document described in
section 11.1. It stores `lastIssues` as they stand, or a fresh `detectIssues()` when
no report has been built. Keypoints, frames and scan
internals are not saved, which is why a saved session cannot be re-inspected.

### 10.3 Report PDF

Client (`downloadReport`, `index.html:3190-3275`) sends to the callable
`generateFormReport` in `us-central1`:

```
{ athleteName, sessionName, sessionDate, selectedSex,
  phases: { [phaseKey]: { metrics } },      every phase with truthy metrics
  lastIssues,
  images: { [phaseKey]: 'data:image/jpeg;base64,…' } }
```

`athleteName` and `sessionName` are the same string: the saved session's `name` when
a saved session is on screen, otherwise the save form's name field (possibly empty).
`sessionDate` is the saved session's `date`, otherwise the save form's date, otherwise
today's local date. In a live session the front and back phases' `metrics` is their
`frontBackMetrics` object (7.4), so they are in `phases`; side phases send their full
`metrics`, raw keys included. Images come from `capturePhaseImages()`
(`:3159-3184`): for each phase with `detected` and `kps` whose clip has a frame
size, the committed frame with the pose drawn over it, scaled to at most 640 px
wide, JPEG quality 0.62. The page sends no `tzOffsetMin`.

Server (`functions/index.js:1360-1447`): rejects unauthenticated callers; requires
`verifyActivePass` (`:1301-1349`: an esFormLab pass payment in
`customers/{uid}/payments` within 90 days, `users/{uid}.features.esFormLab`
or a future `formAnalyzerPassUntil`, or an active or trialing Premium coaching
subscription); requires `lastIssues` to be an object; accepts `selectedSex` only as
`male` or `female`; keeps `sessionName` (trimmed) only if it is 120 characters or
fewer, otherwise uses an empty name; keeps `sessionDate` only if it matches
`YYYY-MM-DD`, otherwise uses none (neither is rejected); keeps at most 12 images, each
a `data:image/jpeg` or `data:image/png` base64 string of at most 400,000 characters;
reads the three `computed_ranges` documents itself, plus the male and female
`sampleCount` for the cover line; renders with `functions/report-renderer.js`;
returns `{pdfBase64, filename}`, the filename being
`esformlab-report-<name slug>-<sessionDate or generated date>.pdf`. It writes
nothing.

### 10.4 Comparison PDF

Client (`downloadComparisonPDF`, `saved-analyses.js:606-653`) sends `{idA, idB}`
(plus `ownerUid` when an admin is acting as another user) to
`generateComparisonReport`. The server checks the pass, rejects a missing or equal
pair, uses `ownerUid` only when the caller is the admin (anyone else gets their own
uid), reads both documents from `users/{ownerUid}/analyses` (not-found if either is
missing), reads the `computed_ranges` documents, and renders with
`functions/comparison-renderer.js` (`functions/index.js:1457-1516`). The filename is
`esformlab-comparison-<dateA>-vs-<dateB>.pdf`. It writes nothing.

---

## 11. Data written and read

### 11.1 Firestore

| Path | Operation | By | Where |
|---|---|---|---|
| `computed_ranges/{male,female,combined}` | read | every visitor (public read) | `auth-paywall.js:19-37` |
| `users/{uid}` | read `gender` | signed-in user | `auth-paywall.js:40-55` |
| `users/{uid}/analyses/{autoId}` | add, list by `createdAt desc`, delete | the user; the admin on the user's behalf | `saved-analyses.js:97`, `:194`, `:292`; `auth-paywall.js:244` |
| `phase_labels/{autoId}` | add | admin only | `index.html:2347-2367` |
| `notifications/{autoId}` | add | signed-in user | `index.html:3431-3438` |

Pass state is read by `shared/site.js` from `users/{uid}` and
`customers/{uid}/payments` and `/subscriptions`; esFormLab only consumes
`esLabs.getPassState()`.

Saved session, `users/{uid}/analyses/{autoId}`:

```
name        string, the session name ('Pre-checkout autosave' for autosaves)
date        'YYYY-MM-DD', user-entered (autosaves: the local date at checkout)
createdAt   server timestamp
sex         'male' | 'female' | null
issues      { overstriding, hipDrop, armsCrossing, torsoPosition, armAngle, kneeValgus }
            each { detected, severity, details, sideSev?, sideTagLabel?, cueKey? }
            (autosaves: {} when no report had been built)
phases      { [phaseKey]: {
                t                 seconds
                detected          true
                metrics           side phases only: that phase's relevant metric keys
                frontBackMetrics  front/back phases: the full object from section 7.4
                quality           'strong' | 'fair' | 'weak' | null
            } }                   phases with detected false are omitted
autosave    true                  pre-checkout autosaves only
```

`saveAnalysis` strips `undefined` values before writing; the autosave path does not.
Rules: the owner can read and write; the admin uid can read and write
(`firestore.rules.txt:99-106`).

Admin label, `phase_labels/{autoId}` (rules: admin only,
`firestore.rules.txt:65-71`):

```
sessionId     random id generated once per page load
phase         phase key
videoView     'side' | 'front' | 'back'
videoW/H      stored frame size (the keypoints' pixel space)
videoDur      clip duration
autoPickedT   the phase's time when the inspector was last opened on it
t             the labelled frame's time
kps           17 keypoints
metrics       metrics object or null (raw and functional keys, or the section 7.4 object)
isCorrect     true for the chosen frame, false for its neighbours
userUid, userEmail, createdAt
```

`userUid` and `userEmail` come from `currentUser`, so while the admin is acting as an
athlete they are the athlete's, not the admin's.

Feedback, `notifications/{autoId}`:
`{recipientUid: <admin>, type: 'bug_report' | 'contact', message, senderUid, read: false, createdAt}`.
`message` is `[Bug] from <name or email> (esformlab): <text>` (or `[Contact]`), with
the sender taken from `esLabs.user`, the acting-as athlete when the admin is acting.
Rules require an authenticated sender whose uid matches `senderUid`, except that the
admin may send anything (`firestore.rules.txt:194-216`). The two footer buttons that
open the form show to everyone; a signed-out visitor's message goes out with
`senderUid: 'anonymous'`, the rules reject it, and the form shows "Failed to send.
Try again."

### 11.2 Browser storage and globals

| Key | Kind | Meaning |
|---|---|---|
| `esl-theme` | localStorage | `'light'` selects the light theme (written by `shared/site.js`) |
| `esfl-tour-done` | localStorage | `'1'` once the tour has ended in any way; per browser, not per account |
| `esformlab_resume_id` | localStorage | id of the session to reopen after returning from checkout |
| `eslActAs` | sessionStorage | the athlete the admin is acting as, per tab (written by `shared/site.js`; honoured only for the admin) |
| `window.__eflSavedThisRun` | global | set after a successful save, cleared by `resetApp`; suppresses the "hasn't been saved" confirm when opening a saved session (the New analysis confirm ignores it) |
| `window.__eflLiveSex` | global | the live sex choice while a saved session is on screen |
| `currentSavedId` | global | id of the saved session on screen, else `null`; picks the PDF's name and date and is the session resumed after checkout |
| `phaseLabels` | global | per phase, the admin labels written this page load (`{good: [], bad: []}`), behind the panel count and the card chip |
| `SESSION_ID` | global | one random id per page load, written into admin labels; not regenerated by re-scan or reset |

### 11.3 Cloud Functions called

`generateFormReport` and `generateComparisonReport`, both callable, region
`us-central1`. Checkout goes through `esLabs.startPassCheckout` in `shared/site.js`.

---

## 12. Admin-only features

"Admin" is `esLabs.isAdmin()`: the real signed-in uid equals `ADMIN_UID`
(`shared/site.js:59`, `:1893`). It stays true while the admin is acting as another
user.

### 12.1 Frame labelling

The inspector shows an "Admin label" panel with one button, "✓ Correct frame
(auto-saves 6 neighbors as bad)", and a count "N good · M bad"
(`index.html:513-519`, `:2295-2305`).

One click (`labelCorrectFrame`, `index.html:2374-2448`) writes up to seven documents
to `phase_labels` in the production database:

1. The displayed frame as `isCorrect: true`. Its pose and metrics are reused from the
   phase when the displayed time is within 5 ms of the last time posed in the
   inspector (`epPoseFreshAt`: the phase's time at open, or the last Analyze) and the
   phase has both `kps` and `metrics`; otherwise the frame is posed fresh with
   Thunder (no weak retry). If no pose is found the click aborts and writes nothing.
2. The frames 3, 2 and 1 stored frames before and after it, each posed fresh and
   written as `isCorrect: false`. A neighbour with no pose, or later than 10 ms
   before the clip's end, is skipped; the status line reports "Saved S/7 frames",
   adding "(F failed)" when any were skipped.

Each document carries `autoPickedT`, the phase's time when the inspector was last
opened on it. That is the scan's pick only if the frame has not been corrected and
the inspector reopened since.

Side effects of a click: the displayed frame is committed to the phase (`t`,
`analyzedT`, `kps`, `metrics`) and the card's time label changes, but the card
thumbnail, badge, mini metrics, summary column, `frontBackMetrics`, `sideView`,
`detected` and the Complete bar are not updated. So a label on an undetected phase
leaves it undetected (and left out of a save), and on a front or back phase the
rules keep reading the old `frontBackMetrics`. Near a clip's ends the neighbour
offsets clamp, so a neighbour can be the same frame as the correct one and is still
written as incorrect. The card gets a small chip, `Ng/Mb` shown in capitals.

The admin reference-data page writes to the same collection with
`source: 'reference-data'` and reads it for a frame-selection diagnostic that
compares `autoPickedT` with the correct `t` per session and phase
(`reference-data/index.html:1015-1029`, `:1169-1188`).

### 12.2 Acting as another user

When the admin acts as an athlete, `currentUser` is the athlete (`index.html:766-768`),
so My Sessions, saves, deletes and the pre-checkout autosave use the athlete's
`analyses` collection, the profile read takes the athlete's `gender`, admin labels
and feedback carry the athlete's uid (11.1), and the comparison PDF request adds
`ownerUid`. The act-as choice is kept per tab in sessionStorage (`eslActAs`).
`isAdmin()` and the pass state still follow the real account.

### 12.3 PDFs

The server treats the admin uid as always holding a pass
(`functions/index.js:1302`). The page has no such rule: `esLabs.getPassState()`
(`shared/site.js:417-451`) unlocks the report only from a Premium coaching
subscription, `features.esFormLab`, a future `formAnalyzerPassUntil` or a paid pass
on the real account. Without one of those the admin sees the paywall, whose blur
(`pointer-events: none`, `esformlab.css:59-62`) also covers the report's two PDF
buttons; the comparison PDF button is outside it and the server accepts the call.

---

## 13. The contract between detection and the rest of the page

"Detection" here means the code that turns three frame stores into a time and a
`detected` flag per phase: the scan part of `autoScanAll`, `findPhases`,
`refineLegPlateau`, `scanBestStanceFrames` and `applyStanceFrame`
(`index.html:1325-2023`). Nothing in that range reads sign-in, pass or admin state.
Its only environment branches are `IS_MOBILE_RUNNER` and one `isViewingSaved` check
before the tour.

### 13.1 What detection is given

| Input | Source |
|---|---|
| `videoEls.side / front / back` | frame stores from `loadAllVideos`; a failed clip is a store with `ok: false`, `videoWidth: 0` and possibly `NaN` duration |
| `detector`, `scanDetector`, `scanDetectorPromise` | `initModel` |
| `PHASE_DEFS`, `MIN_CONF`, `IS_MOBILE_RUNNER`, `LOAD_BAR_PCT` | constants |
| `getVideoFrame`, `drawVideoFrame`, `isSideView`, `calcAngle`, `drawMiniSkeleton` | helpers |
| `eflCheckCancel()` | throws the cancel sentinel; called between units of work |
| `pushScanWarning(msg)` | adds a warning to the scanning card and the review screen |

### 13.2 What detection writes

To `phases[key]`, for all nine keys:

| Field | What the page needs |
|---|---|
| the fields copied by `initPhases` | `key`, `label`, `desc`, `videoKey`, `side`, `detectsIssue`, `guide`, `metrics: null`, `frontBackMetrics: null`, `sideView: true` |
| `t` | a finite time in seconds on that phase's own clip, for every phase, detected or not. For an undetected phase it is where the inspector opens. Any value works; the frame store resolves it to the frame at or before it. |
| `detected` | boolean. `true` builds a card with a canvas and queues the card analysis. `false` builds the "Not auto-detected" placeholder card. |
| `kps` | optional at hand-off. The scan leaves its own poses here: scan-canvas pixels for `mid` and the four front and back phases, stored-frame pixels for refined foot-strike and toe-off phases. `analyzeCard` replaces them when it finds a pose. |

To the DOM, all inside `#screen-scanning`: `#scan-canvas` (resized, drawn and
posed on every coarse sample), `#scan-bar` width, `#scan-sub-text`, `#scan-step`,
`#scan-label`, `#scan-phase-list` rows `spl-<key>` and `spl-t-<key>` with classes
`found` / `not-found`, `#scan-warn-live`, `#scan-diag`, and class `loading` on
`.scan-preview`. The progress bar budget is 0 to 30% loading, 30 to 75% side, 75 to
87% front, 87 to 100% back.

To globals: `scanWarnings`, `scanInProgress` (set false at the end), `eflTfScopeOpen`
on phones.

### 13.3 What happens with it next

Fixed order at hand-off (`index.html:1552-1583`): show the review screen; count
`detected` for "D of 9 auto-detected"; `buildPhaseGroups()`; `buildSummaryTable()`;
then `analyzeCard(key)` for each detected phase in `PHASE_DEFS` order.

Readers of the hand-off fields:

| Field | Read by |
|---|---|
| `t` | card frame (`:2085-2091`), card analysis (`:2119`), inspector open (`:2220-2226`), save, PDF image capture (`:3178`) |
| `detected` | scan phase list, auto-detected count, card form, jump pills, summary-table header warning sign, tour's choice of card to open, save (undetected phases are omitted), PDF image capture |
| `kps` | drawn only after `analyzeCard` has replaced them; see the last coupling below |

### 13.4 Couplings to know

- **The phase key carries the leg.** For the four foot-strike and toe-off phases,
  `addFunctionalMetrics` maps lead and trail to the model's left and right by key
  (`gait-engine.js:282-301`), and the wrong-leg check compares against that. "Left"
  means the leg Thunder labels left in the full-frame pose at `t`.
- **Front and back keys carry the stance side for the rules.** `detectIssues` reads
  `mid_front_l` as the left-stance frame (`gait-engine.js:561-577`, `:713-714`), while
  `computeFrontBackMetrics` works out the stance side from the pose on its own.
- **`analyzeCard` needs the card canvas**, which exists only for detected phases on a
  decoded clip.
- **The pose that is measured is not the scan's pose.** Metrics come from a fresh
  Thunder pass on the full stored frame at `t`.
- **Manual and automatic picks share one measuring path.** A user correction is "the
  frame at the displayed time, one pose (plus one retry), metrics", the same steps as
  the card analysis.
- **Phase keys and metric keys are shared with the server.** The PDF renderers keep
  their own copies of the phase and metric definitions.
- **Saved documents hold only `t`, `detected`, metrics (side) or `frontBackMetrics`
  (front and back) and quality** per detected phase. No detection internals are
  persisted.
- **Admin labels record `autoPickedT`** from `ph.t` at inspector open.
- **Two pixel spaces can sit in `kps`.** When `analyzeCard` finds no pose it leaves
  the scan's keypoints in place and sets `noPose`. Most readers check `noPose`. The
  PDF image capture checks only `detected && kps` and draws at stored-frame scale
  (`index.html:3167-3179`), and both save paths compute `quality` from `kps` without
  checking it (`saved-analyses.js:90`, `auth-paywall.js:238`).
- **Static copy makes statements about detection**: "Phones check fewer frames when
  auto-picking each gait phase (and step 60fps clips two frames at a time)"
  (`index.html:42`); "the scan spreads a fixed number of samples across the whole
  clip, so extra footage means fewer samples per stride" (`:136`); "MoveNet Thunder"
  on the loader; "all 9 gait phases scanned" on the gate; "Review your 9 frames" on
  the bar; and the tour and quality tips saying a repeat Analyze can change the
  result.
- **A second copy of `findPhases` and `refineLegPlateau` lives in
  `reference-data/index.html`** and is not shared code.

---

## 14. Known limits of phase detection

Each item names a mechanism in the code (or in the pose library the code calls) by
which the scan picks a wrong frame or leaves a phase undetected. The code shows that
each can happen; it does not show how often. That needs the pipeline measured on
real footage (section 16).

Two ideas run through the list. First, the scan never models a stride: it does not
find successive ground contacts, alternate legs, or check that events fall in order.
Second, a phase marked detected has had no check that its frame shows the right
moment.

### Pose input and detector state

**14.1 The detector's crop carries over between unrelated frames and is never reset.**
Each `estimatePoses` call crops the image to where the previous call's pose was
(section 5.2). The page uses one long-lived detector for everything and never calls
`reset()`. On desktop the one Thunder instance is called in this order: 150 side
samples spread across the clip, the left refinement window, the right refinement
window, 50 front samples, 50 back samples, then the cards `l_foot, r_foot, l_toe,
r_toe, mid, mid_front_l, mid_front_r, mid_back_l, mid_back_r`, then whatever the
user analyses. So the first refinement frame is cropped where the runner was at the
end of the clip, the first front frame where the side-view runner was, the first
back frame where the front-view runner was, and the first card where the back-view
runner was. On phones Lightning holds one chain (side, front, back) and Thunder
another (refinement, cards, inspector). When the carried crop does not contain the
runner, the pose is wrong or is rejected. The same frame can therefore give
different keypoints depending on what was posed before it. This is the variation
the tour and quality tips describe as randomness, and it is why a re-scan need not
reproduce the first scan.

**14.2 After a rejected pose, the detector looks only at the centre square.** A pose
scoring under 0.25 resets the detector, and a reset detector crops a centred square
with the image's short side: the middle 56% of the width of a 16:9 frame, or the
middle 56% of the height of a 9:16 frame. A runner outside it is cut off. If that
again scores under 0.25 the detector resets again, so a runner near the edge of the
frame can go unposed for a run of samples. In the coarse scan those samples vanish
(side) or become unusable (front, back).

**14.3 The coarse scans pose a canvas at most 400 px wide.** The stored frame (up to
1280 px, or 960 px on phones) is reduced to 400 px wide before the model sees it
(`index.html:1431-1432`, `:1641-1642`). In a landscape clip the whole frame is 225 px
tall, so the runner occupies fewer pixels than the model's own 256 px input. Every
coarse ankle position, the choice of stride, mid-stance's time and all four front
and back times come from this reduced input, and on phones from the smaller
Lightning model. The pixel thresholds in the scan (plateau tolerance, the 10 px
hip-width gate) are in these pixels. Card poses are computed from a different
input: full stored frame, Thunder, a different crop history. A property the scan
relied on (this ankle lowest, this ankle under the hips, this leg labelled left)
is not guaranteed to hold in the card pose of the same frame, and a frame with a
scan pose can come back "no pose" at the card.

**14.4 One person, first result.** Every call reads `poses[0]` from a single-pose
model. Nothing chooses which person to follow when more than one is in frame; with
14.1, whichever body the crop is on stays tracked.

### Side clip

**14.5 A fixed number of samples, so time resolution falls as the clip gets longer.**
150 samples (75 on phones) cover the whole clip (table in section 6.2): 67 ms apart
on a 10 s desktop clip, 133 ms on a phone, and worse beyond that. The code's own
comment assumes 180 steps per minute (`index.html:1615-1617`), which puts successive
landings of one leg 0.67 s apart; the time a foot spends on the ground is a fraction
of that. When only one sample lands on a contact, the plateau has one sample, so the
foot strike is the ankle-lowest sample itself and there is no coarse toe-off
(`:1842-1847`). Coarse edges are always whole samples. Mid-stance is never refined
and keeps this resolution.

**14.6 Neighbourhoods and plateau walks count samples, not time.** `localPeaks`
looks ±2 positions; the plateau walk stops at two consecutive misses
(`index.html:1743-1758`, `:1815-1826`, `:2003-2014`). Samples with no pose and samples
removed by the body-scale filter are deleted from the list first, and in the dense
pass a step whose ankle scores under 0.25 is deleted rather than counted as a miss
(`:1956-1957`). After deletions, neighbours in the list can be far apart in time.
The walk tolerates one miss, so when fewer than two consecutive samples fall in the
gap between two contacts of the same leg (sparse sampling, or deleted samples), the
walk continues into the neighbouring contact. The result is a "plateau" spanning two
contacts: foot strike from one stride, toe-off from another. The refinement window
is then built from that span.

**14.7 One pick per leg for the whole clip, and the two legs are picked
independently.** The left event is the single best-scoring left-ankle peak anywhere
in the clip; the right is chosen the same way with only a 0.10 s exclusion around
the left time (`index.html:1835-1837`). Nothing ties them to the same stride or to
consecutive steps. The five side phases can come from strides seconds apart.
Mid-stance's window runs from the earlier strike to the later one, so it can span
many strides.

**14.8 The stride is chosen by "ankle lowest in the image".** The winning candidate
maximises `(ankleY − median) · (0.5 + 0.5 · conf)` (`index.html:1790-1793`). Anything
that pushes one ankle reading lower in the image wins: one outlying keypoint, the
runner being lower in the frame or closer to the camera at that moment, or camera
movement. The ankle's own score is only gated at 0.25; the weight uses the mean of
all 17 keypoints, face included, and ranges only from 0.5 to 1. On steady footage
where every contact reaches about the same height, the choice among strides is
decided by pixel-level differences.

**14.9 The plateau is anchored to its single highest sample, with a tolerance of a
few pixels.** `threshold = peak − 0.05 × median trunk length`. On the scan canvas a
40 px trunk gives a 2 px tolerance. If the anchor sample is an outlier by more than
the tolerance, every true plateau sample is under the threshold and the walk ends
after two samples. Then either the plateau collapses (coarse: foot strike is the
peak sample and there is no toe-off; dense: refinement is abandoned,
`index.html:2015`), or it has two samples and foot strike and toe-off land one or two
samples apart.

**14.10 The events are defined on the ankle keypoint, not on the foot.** MoveNet has
no heel or toe point. Toe-off is taken as the last sample where the ankle is within
5% of trunk length of its lowest image position. The tool's own target for toe-off
is the last frame with the forefoot on the ground, with the heel "visibly raised"
(section 6.1, section 4.6). A raised heel means a raised ankle, so the detected
trailing edge falls before the described frame whenever the heel lifts the ankle
past the tolerance before the toes leave. For foot strike, the leading edge is the
first sample where the ankle is within tolerance of its lowest position; how that
relates to first ground contact depends on how the foot lands.

**14.11 All ankle logic is in absolute image coordinates.** The 55th-percentile cut,
the median reference and the plateau threshold assume the ground stays at one image
height for the whole clip. The tool's guidance allows both a panning and a stationary
camera (`index.html:2596-2630`). A panning or hand-held camera, zoom, or a runner
moving toward or away from the camera changes ankle y for reasons unrelated to the
stride. The body-scale filter removes only samples under 55% of the median scale.

**14.12 Left and right come from the model, with no consistency check.** The scan
assumes keypoint 15 is the same physical leg in every coarse sample, in every dense
step (a different resolution everywhere, a different model on phones) and again in
the card pose. In a side view one leg passes in front of the other. The page itself
allows for mislabelling: it has a wrong-leg warning and a Swap L/R button. What
follows in the code when it happens:

- If both ankle keypoints sit on the same visible leg, the two series peak together.
  The only guard is the 0.10 s exclusion on the peak time, which does not stop both
  plateaus resolving to the same contact. `l_foot` and `r_foot` then share a time;
  `r_toe` is dropped as too close to the left toe-off; mid-stance falls back to the
  middle sample of the clip because neither strike is later than the other
  (`index.html:1913-1922`); and refinement can mark `r_toe` detected again from the
  same window.
- If the dense pass labels the legs the other way round from the coarse pass, the
  window was built around one leg's contact while the dense ankle series follows the
  other leg. The maximum can then sit at an edge of the window and the plateau is
  cut off by the window.
- If the card pose labels them the other way round, `addFunctionalMetrics` reports
  the wrong leg's knee, hip and foot offset as "lead", with no error. The wrong-leg
  check catches this only when the knee angles differ by more than 20° (hip angles by
  more than 15° at toe-off).

**14.13 Refinement can only repair what the coarse pass roughly found.** Its window
is the coarse contact ± 0.2 s (`index.html:1975-1979`). If the coarse pick is the
wrong stride, the wrong leg or a bridged double plateau, refinement refines that. If
the true edge is outside the window, the result stops at the window boundary. Its
step is 33 ms whatever the stored frame rate. Its peak is the plain maximum in the
window, so 14.9 applies again. Its first frame inherits the crop from the last
coarse sample (14.1).

**14.14 Refinement re-marks toe-offs and skips every cross-check.** A toe-off the
coarse pass rejected as colliding, or never found, is set `detected: true` by
refinement (`index.html:2017-2022`). After refinement nothing checks that the four
events are distinct, in a plausible order, or consistent with mid-stance, which was
chosen from the pre-refinement times.

**14.15 Mid-stance is "detected" even when it is a guess.**

- The fallback is the middle sample of the clip, an arbitrary moment, marked
  detected (`index.html:1919-1922`). It is used whenever a strike is missing, the two
  strikes share a time, or the window has no candidates.
- The test is horizontal only: stance ankle x near hip-midpoint x. Nothing requires
  that ankle to be on the ground. A leg's ankle also passes under the hips while
  swinging forward, and a window spanning more than one step (14.7) contains such
  frames.
- Within the band the winner is the highest whole-body `conf`, not the smallest
  offset (`:1902`).
- The collision rule can move a good pick to the next sample, a full sample spacing
  away (`:1923-1929`).
- The stance side is inferred from the order of the two independently chosen strikes.
- It is never refined, so its resolution is the coarse spacing.

A foot strike from a collapsed plateau is likewise the ankle-lowest sample marked
detected.

**14.16 The side-view check gates nothing in the scan.** Only the first pose of the
side clip is tested, and failing only adds a warning (`index.html:1437-1439`). A
diagonal clip, or a clip dropped in the wrong zone, is scanned as if it were
side-on.

### Front and back clips

**14.17 The score cannot tell which part of stance a frame shows.** "Planted" is
inferred only from which ankle is lower in the image, and "under the body" only from
that ankle's sideways distance to the hip midline (`index.html:1660-1669`). No term
measures where the foot is fore and aft, so nothing separates first contact,
mid-stance and late stance. The height term is at its maximum once the ankle is half
a hip-width lower; among all frames that reach it, the winner is decided by
whole-body confidence and sideways proximity.

**14.18 One sample out of 50 (or 25), with no refinement.** Samples are 160 ms apart
on an 8 s clip on desktop and 320 ms on a phone (section 6.6). The chosen time is
always one of those sample times. `pickBestPeak` is a plain maximum over the clip
(`:1697-1712`).

**14.19 Gates silently discard frames.** A frame is unusable unless both ankles and
both hips score 0.25 or more and the hips are at least 10 px apart on the 400 px
canvas (`:1650-1655`). A small or distant runner fails the hip-width gate on every
frame. The body-scale filter needs both shoulders and zeroes frames under 55% of the
median, which removes the early frames of a runner approaching from far away. When
few frames survive they may all have the same ankle lower, leaving the other side
with no candidate and the card "manual".

**14.20 Left and right are the model's labels in both views, and are decided
twice.** The same function with the same indices serves the front and the back clip.
The scan decides the side from which ankle is lower in the small scan pose. The card
then works out the stance side again from the full-frame pose, independently of the
phase's name. The two can disagree: a card titled "L mid-stance" can display "Hip
drop (right stance)". Hip drop is still read from that card as the left-stance value.
Knee valgus for a side exists only when the two agree; otherwise that side is "no
data".

### After the scan

**14.21 Holes in a frame store look like flat ankle height.** `image(t)` returns the
last frame at or before `t`, so across a gap consecutive sample times return the
same frame and identical keypoints (`frame-store.js:72-83`). The user is warned only
when coverage is under 90% (`index.html:1541`), and the scan does not account for
holes.

**14.22 Nothing after the scan checks the moment.** The card analysis grades
keypoint confidence and applies the side-view test; the wrong-leg check only warns.
A phase with a Strong badge can be the wrong moment, and the quality card says so.
"D of 9 auto-detected" counts `detected` flags before any card is analysed, so it
includes mid-stance fallbacks, re-marked toe-offs and frames that go on to show "no
pose" or "Needs side view".

---

## 15. Other behaviour worth knowing

These are not about phase detection but affect what users see. Each is read from the
cited lines; none was reproduced in a browser.

Report and measurements:

- **A correction made after Complete analysis does not refresh the report.**
  `epReanalyze` and `swapLegs` update the card and the summary table but not
  `lastIssues`. The Complete bar reappears, and the report is rebuilt only when it is
  pressed again. Until then the summary table and the issue cards can disagree, a PDF
  pairs the new metrics and images with the old findings (`index.html:3211-3242`), and
  a save stores the old findings with the new metrics (`saved-analyses.js:72`).
  `analyzeCard` contains a refresh for this (`:2161-2164`), but it is only called
  from the post-scan loop, where `lastIssues` is null unless Complete analysis was
  pressed while the first card pass was still running.
- **Changing the sex after the report is built** re-grades the table symbols but not
  the findings.
- **The Complete bar needs only three analysed phases** and no quality level.
- **A PDF from a saved session** has no frame images, and its payload carries no
  front or back phase data, because those phases' `metrics` are not saved and only
  `metrics` is sent (`index.html:3212-3217`). Front and back findings still arrive
  through the saved issues.
- **The PDF's "Generated" date is UTC**: the server accepts `tzOffsetMin` but the
  page does not send it.

Inspector:

- **`epReanalyze` reads the globals `expandKey` and `epCurrentT` again after its
  awaits** (`index.html:3032`), and only the Analyze button is disabled meanwhile.
  From the code: stepping during an analysis can commit one frame's keypoints with
  another frame's time; jumping to another phase can write the pose to that phase;
  closing the inspector makes line 3032 throw, leaving `epAnalyzing` true so Analyze
  does nothing until the page is reloaded.
- **`swapLegs` redraws the frame at the displayed time**, not the committed time, so
  after stepping without analysing it can paint the committed pose over a different
  frame. It does not update the card badge or the Complete bar.
- **A weak pose still commits** and counts as analysed.

Scan and session:

- **A non-cancel error during a scan has no user-facing handling.** The scanning
  screen stays up; Cancel then changes its label and nothing else. "New analysis"
  (confirm, reload) is the way out.
- **Opening a saved session is not blocked while a scan is running.** The scan would
  carry on and then show the review screen over the saved view.
- **`resetApp` does not reset the scan bar, phase list or step text**, so a second
  analysis on desktop opens the scanning card showing the previous run's state until
  it is overwritten.
- **An invalid file picked on a zone that already holds a valid file** shows the
  error but keeps the earlier file.
- **Pre-checkout autosaves accumulate** in My Sessions.
- **The tour's per-frame repositioning loop stops after the first tour ends**;
  replays reposition on step change, scroll and resize only. Arrow keys do nothing
  while focus is on the Next button, which every step focuses.

Comments in the code that do not match the code: "all 11 phases" and "7 side phases"
(`index.html:1401`, `:1406`, `:3277`; there are 9, 5 from the side); "native fps" for
the 33 ms refinement step (`:1482`); "best LOCAL peak per side" for a global maximum
(`:1623-1624`); "Scan ~20 frames" (`:1606`); "avoids … mixed phases from unrelated
strides" (`:1733-1735`); the `phaseLabels` shape (`:777`; the code uses
`{good: [], bad: []}`); "loaded after the inline block" in `report-render.js:11` and
`saved-analyses.js:10`; "execute nothing at top level" (`index.html:662-666`).

Defined and never used: `lHipExt`, `rHipExt`, `lKnAngle`, `rKnAngle` on scan samples;
`localTroughs`, `prominenceFilterMin` and the `dur` parameter of `findPhases`;
`GROUP_STARTS`; `buildBellCurveSVG` (the page draws no bell curves; the PDF does);
`epAutoKps`, `epAutoMetrics`; the `note` text from `getDetectionQuality`; the
`METRIC_ROWS` hints; `#hdr-file` and `.ep-undetected-badge` (both hidden by CSS at
every width).

---

## 16. Not established from the code

- How often each mechanism in section 14 occurs on real clips, which phases fail
  most, and how often a phase ends "manual" versus detected but wrong. The admin
  labels in `phase_labels` and the frame-selection diagnostic on the reference-data
  page are the existing means of measuring this.
- How much MoveNet's ankle keypoint moves from frame to frame relative to the plateau
  tolerance, and how often it swaps or merges legs in a side view.
- Typical runner size and position in users' frames, which decides how much 14.2,
  14.3 and 14.19 matter.
- Whether stored-frame timestamps on real phones are regular enough for the 33 ms
  refinement grid.
- Which TF.js backend desktop browsers end up on. The page only logs it.
- Real-device behaviour of frame capture (`FrameStore.prime`, playback capture,
  seek fill).
- How the page looks and behaves in a browser. Nothing in this document was run.
