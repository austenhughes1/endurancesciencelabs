# Strava API Compliance — Extended Access Tier Request

Audit date: **July 9, 2026**, against the **June 1, 2026** [API Agreement](https://www.strava.com/legal/api), the [API Policy](https://www.strava.com/legal/api_policy), and the [Brand Guidelines](https://developers.strava.com/guidelines/).

## What changed in Strava's June 2026 developer program

- Two tiers: **Standard** (self-service, max **10 athletes**, requires an active Strava subscription on the developer's account from June 30, 2026) and **Extended Access** (case-by-case approval, higher limits, no subscription requirement). Growing past 10 athletes requires Extended — that is this request.
- Deprecations on **September 1, 2026**: Club Activities / Club Admins / Club Members and Segments Explore endpoints. *(We use none of these — only `/athlete/activities` and `/activities/{id}`.)*
- Coming **June 1, 2027**: tokens must move to request headers (we already send `Authorization: Bearer` headers) and base URL changes to `https://www.api-v3.strava.com` (**TODO when Strava opens the new host**: update `STRAVA_*_URL` constants in `functions/index.js`).
- Apps routing data through intermediary platforms are not supported. *(We integrate directly.)*

## Our use case (what to write on the form)

Private 1-coach coaching platform. An athlete explicitly authorizes the app via OAuth (`activity:read_all`) so their own coach can see their training. Strava data (last ~120 days of activities: name, type, date, distance, time, elevation, HR, pace, recent descriptions) is shown **only to the athlete themself and their assigned coach**. No leaderboards, no cross-athlete visibility, no public display, no analytics products, no AI/ML, no data resale.

## Compliance checklist

| Requirement | Status |
|---|---|
| Data shown only to the authorizing user (+ their coach, the consented coaching use case Strava's FAQ allows) | ✅ Firestore rules scope `stravaActivities` reads to the plan's `athleteUid`, `coachUid`, and admin only |
| No leaderboards / cross-athlete sharing | ✅ None anywhere in the app |
| No analytics products / aggregated insights from Strava data (API Policy §5.4) | ✅ esFormLab and esMetabolicLab do not touch Strava data; Run Dynamics runs on Garmin/Coros file uploads (Strava is only used to match "lever" titles on the athlete's own runs, displayed to the same athlete + coach) |
| No AI/ML use of Strava data (API Policy §5.3) | ✅ None |
| Tokens inaccessible to clients | ✅ Stored in `users/{uid}/private/strava`; rules deny all client access |
| Deletion on disconnect (API Policy §7.4, ≤30 days) | ✅ Immediate: in-app disconnect, the deauthorization **webhook** (`stravaWebhook`), and revoked-token detection during sync all call `purgeStravaData()` (tokens + all synced activities) |
| Respect athlete's Strava edits/deletes | ✅ Webhook applies activity `update`/`delete` events to our copies |
| Official "Connect with Strava" button, unmodified, 48px | ✅ Official SVG asset at `images/strava/btn_strava_connect_with_orange.svg` |
| Official "Powered by Strava" logo where Strava data appears | ✅ Official horizontal SVG on every dashboard card footer |
| Correct brand orange | ✅ `#FC5200` (was `#FC4C02`, fixed) |
| "View on Strava" link-backs on displayed activities | ✅ Each activity row links to `strava.com/activities/{id}` in brand orange |
| No Strava name/logo in our branding, no imitation of Strava's look | ✅ |
| GDPR/UK-GDPR privacy policy, prominently linked (API Policy §7.3) | ✅ `/privacy/`, linked from the site footer and the Strava connect prompt |
| Correct OAuth endpoint (`strava.com/oauth/authorize`) | ✅ |

## One-time setup still required (not code)

1. **Deploy functions** (`firebase deploy --only functions`) — adds `stravaWebhook`.
2. **Set `STRAVA_VERIFY_TOKEN`** in `functions/.env` (any random string).
3. **Create the push subscription** (single POST, one subscription per app):
   ```bash
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id=$STRAVA_CLIENT_ID \
     -F client_secret=$STRAVA_CLIENT_SECRET \
     -F callback_url=https://us-central1-es-form-labs.cloudfunctions.net/stravaWebhook \
     -F verify_token=$STRAVA_VERIFY_TOKEN
   ```
4. **Strava subscription**: until Extended Access is granted, the developer's own Strava account needs an active subscription (Standard-tier requirement effective June 30, 2026).
5. **Submission screenshots**: the form requires screenshots of every place Strava data appears plus the Connect with Strava button — capture the coaching dashboard (athlete + coach views), the connect prompt, and the recent-runs table with its "View on Strava" links after deploying.
