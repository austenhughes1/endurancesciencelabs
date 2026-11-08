# Garmin series and the esMcp read path

For the accounts listed in `GARMIN_SERIES_UIDS`, every activity Garmin pushes
(any sport, not just runs) is kept as a compact 5-second series. Claude reads
it through `esMcp`, an MCP server added to claude.ai as a custom connector.
Nothing changes for other athletes.

The FIT file is still parsed in memory and thrown away. Only the binned
series, laps and session values are stored. GPS positions are never stored.
There is no history: Garmin's Activity API only pushes, so the series start
when this is deployed.

Code: `functions/garmin-series.js` (building the doc),
`functions/garmin.js` (push intake, inbox worker, purge) and
`functions/es-mcp.js` (the MCP server).

## Data: `users/{uid}/garminSeries/{activityId}`

```
activityId   "12345" (string)
sport        "running" | "cycling" | "swimming" | Garmin activityType lowercased
subType      Garmin activityType lowercased, e.g. "treadmill_running", "road_biking"
title, deviceName
startTs      ms; the first record's time (the bins are anchored to it)
durSec       session timer time
distM        session distance
step         seconds per bin: 5, or 10 / 30 when the doc would be too big
n            number of bins
series       { power, speed, hr, cadence, alt, gct, vo, stepLen, gctBalL }
             each an array of n integers or null
laps         [{ startSec, durSec, distM, avgHr, avgSpeedCms, avgPower }]
session      { avgHr, maxHr, avgPower, normPower, avgSpeedCms, totalAscentM,
               totalDescentM, avgCadence, avgGct, avgVo, avgStepLen, avgVratio,
               avgGctBalL, aerobicTE, anaerobicTE, trainingLoad,
               intensityFactor, thresholdPower, tss }   null where the FIT lacks it
fromFile     true once the FIT has landed; false while only the summary has
seriesOmitted true when even 30 s bins were too big (series null, n 0)
createdAt    server timestamp
```

Series units:

| field   | unit | from the FIT record |
|---|---|---|
| power   | W | `power` |
| speed   | cm/s | `enhanced_speed`, else `speed` |
| hr      | bpm | `heart_rate` |
| cadence | spm for running (per-leg `cadence` + `fractional_cadence`, doubled); rpm or strokes/min otherwise | `cadence`, `fractional_cadence` |
| alt     | dm | `enhanced_altitude`, else `altitude` |
| gct     | ms | `stance_time` |
| vo      | mm | `vertical_oscillation` |
| stepLen | mm | `step_length` |
| gctBalL | left balance % × 100 (51.12 % is 5112) | `stance_time_balance` |

Binning: bin k covers `[startTs + k·step, startTs + (k+1)·step)`. Each value
is the rounded mean of the records in the bin that carry that field;
altitude takes the last value. A bin with no records at all (a timer pause)
is null in every field and is never zero-filled. Power, speed and cadence of
0 are real values. A heart rate or running-dynamics value of 0 counts as
absent. `n` is the number of whole bins from the first record to the last,
with the last record included.

Session values keep their natural units: vo and step length in mm, GCT
balance in %, running cadence in spm.

A 2-hour activity is about 100–150 KB. If a doc would exceed about 800 KB
(Firestore's limit is 1 MiB), it is binned at 10 s, then at 30 s. If even that
is too big, only the session and laps are kept, and a warning is logged with
the uid.

Summary and file: the activity summary usually arrives before the file. On
its own, a summary writes identity, duration, distance and the session values
it carries (`fromFile: false`, no series). The file's values then replace the
summary's, but a value the file lacks keeps the summary's. Once the file has
landed, a later summary only fills fields that are still empty. An empty
title never replaces a stored one. This is the same rule as for run docs.

Deleting: a disconnect, a Garmin deregistration, or a link Garmin refuses at
renewal deletes the series docs along with the Garmin runs. Account deletion
removes them with `users/{uid}`. Clients have no access (`firestore.rules.txt`,
`garminSeries`); only Cloud Functions read and write them.

## Configuration

Set both in `functions/.env`, next to `GARMIN_PUSH_KEY`. Neither value goes
into the repo.

- `GARMIN_SERIES_UIDS`: comma-separated ESL uids that get the series and the
  all-sport intake. The first one is the account `esMcp` serves.
- `ES_MCP_KEY`: at least 32 random URL-safe characters. Shorter, and `esMcp`
  answers 404 to everything. To make one:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

The functions need redeploying after either changes. The Firestore rules need
deploying once, for the `garminSeries` block.

Optional: Firestore indexes every distinct value in an array field by
default. A single-field index exemption on the `garminSeries` collection
group, field `series`, turns that off; nothing queries it. It is not needed
for the docs to store.

## The MCP server: `esMcp`

URL (the key is the last path segment; anything else gets a 404):

```
https://us-central1-es-form-labs.cloudfunctions.net/esMcp/<ES_MCP_KEY>
```

It is streamable HTTP and stateless: POST only, JSON responses, no sessions.
It serves only the first uid in `GARMIN_SERIES_UIDS`, and no tool argument
can choose another. Limits: 2 instances, 60 s, 256 MiB.

| Tool | Input | Returns |
|---|---|---|
| `list_activities` | `from`, `to` (YYYY-MM-DD, America/Denver, both included, ≤ 92 days), `sport?` | `{activityId, startTs, sport, subType, title, durSec, distM, avgHr, avgPower, normPower, avgSpeedCms, seriesAvailable}`, oldest first. Runs in `garminActivities` that no series doc covers (older runs, own uploads) are included with `seriesAvailable: false` and their `source`. |
| `get_activity` | `activityId` | the whole series doc |
| `get_series` | `activityId`, `fields?`, `step?` (5, 10, 30) | `{step, n, series}`, re-binned on the server (mean; altitude last). A step finer than the stored one returns the stored step. |
| `weekly_summary` | `from`, `to` (≤ 92 days) | per ISO week (Mon–Sun, America/Denver): `sessions`, `hoursBySport`, `runMiles`, `runMilesByPace` (min/mile bands <5:00, 5:00–5:30, 5:30–6:00, 6:00–6:30, 6:30–7:00, >7:00, from speed × step per bin), `runMilesNoSeries`, `longestRunMi`, `lever` {sessions, miles, milesByPace}, `bike` {sessions, hours, avgPowerW, powerHours, tss} |

In `weekly_summary`, Lever runs (titles matching `/lever/i`) are counted
under `lever` only, not in `runMiles`, the pace bands or the longest run.
`runMiles` is each run's session distance, so it can differ slightly from the
sum of the bands. `bike.avgPowerW` is weighted by ride time over the rides
that report power. It reads series docs only, so weeks before the deploy are
empty.

Use `get_series` with a few fields, or `step: 30`, for long activities. A
full `get_activity` on a long ride is a large tool result.

## Adding the connector in claude.ai

1. Settings → Connectors → Add custom connector.
2. Name it (e.g. "ESL Garmin"), paste the URL above with the key, and leave
   OAuth empty. Add it.
3. In a chat, turn the connector on and ask, for example, "list my activities
   from 2026-11-09 to 2026-11-15". The first call confirms the handshake.

The URL is the credential. Anyone holding it can read this account's
training data. To revoke access, change `ES_MCP_KEY` and redeploy, then update
the connector.
