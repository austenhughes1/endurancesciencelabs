# AGENTS.md: endurancesciencelabs

Read this in full before changing anything. It is the project's rules for any
agent working here.

## What this is

endurancesciencelabs.com: a coaching site and athlete tools (esFormLab,
esMetabolicLab, Training Analysis and Injury Patterns). Plain HTML, CSS and
JavaScript with no build step. Behind it is the Firebase project
`es-form-labs`: Auth, Firestore, and Cloud Functions in `functions/` (Strava
sync and webhooks, Garmin Connect link and push intake, PDF reports, user
admin, payment hooks).

## Boundary

Production is the live site, the es-form-labs Firebase project and its
athletes' health and training data: no deploy, no push, and no write to the
real Firestore without an explicit request.

In practice: never run `firebase deploy` or any `firebase` command that
changes the project, never run a script against es-form-labs, never push
(a push to main publishes the site). If a change needs any of these to be
verified, stop and say so in the report.

## Layout

```
index.html, coaching/, shockwave/, privacy/, terms/  public pages
account/, admin/users/                              signed-in account and admin pages
esformlab/          running form analysis (no test suite)
esmetaboliclab/     lactate and power profiles; js/lib/ engines, js/ui/ views,
                    tests/ is a browser validation page
training-analysis/  Training Analysis and Injury Patterns page (?view=injury);
                    the view itself is shared/run-dynamics.js
running-dynamics/   redirect to /training-analysis/ for old links
shared/             modules used across pages: site.js/.css, run-dynamics.js,
                    run-load-model.js (+ .test.js), injury-patterns.js, device-matrix.js
reference-data/     admin reference tables and measurement frameworks
functions/          Cloud Functions, Node 22: index.js, report-renderer.js,
                    comparison-renderer.js, garmin.js, garmin-lib.js
firestore.rules.txt the Firestore rules, kept as text
docs/               design notes
```

## Commands

From the repo root. Nothing to install.

```bash
npm test     # syntax-checks functions/*.js, then runs all seven suites; must exit 0
```

The suites one by one:

```bash
node shared/run-load-model.test.js
node shared/run-dynamics-format.test.js
node shared/run-dynamics-archive.test.js
node shared/run-dynamics-garmin.test.js
node coaching/garmin-connect.test.js
node functions/garmin-lib.test.js
node functions/garmin.test.js
```

There is no lint, typecheck or build. Page behaviour in a browser is not
covered by any test: say what you checked and how, or that you could not.

Baseline (2026-10-30): all green. 267, 17, 17, 55, 132, 64 and 538 checks,
in that order.

## Conventions

- **Tests have no framework.** Each suite is a small assertion harness run
  with plain `node`, dependency-free. New tests follow the same pattern.
- **The Impact Load model has a twin.** The numbers pinned in
  `shared/run-load-model.test.js` are shared with the Lever IQ port. If one
  must change, say so in the report; the other port has to change too.
- **Athlete data is health data.** Never put real athlete data in a test,
  fixture, commit message or log. Use made-up values.
- **Commit messages:** `type(scope): what the user now sees`, for example
  `fix(run-dynamics): load counts every run type`.

Global laws also apply: `/home/finalforms/my-assistant/laws.md`.
