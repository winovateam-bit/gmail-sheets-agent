# Gmail to Google Sheets AI Agent

An automated, serverless agent built on Cloudflare Workers that reads recent Gmail messages, uses Anthropic's Claude to decide which are genuine sales leads and pull the details out of them, and writes those leads to a Google Sheet on a recurring schedule.

## How a run works

Every run (cron or a manual `GET /run`) does the following:

1. Loads the stored Google tokens from KV, refreshing the access token if it has expired.
2. Lists the 10 most recent inbox messages (`MAX_MESSAGES` in `src/run.js`).
3. Drops any message already marked `processed:<id>` in KV, so nothing is classified twice.
4. Fetches the rest in full and extracts subject, sender, date, and plaintext body.
5. Asks Claude Haiku 4.5, with a pinned JSON schema, whether each message is a lead and what the lead details are.
6. Marks every message it successfully classified as processed — leads and non-leads alike.
7. Writes the leads to the **Leads** tab of the target spreadsheet.

A failure on one message is recorded in the response and the run continues. Only a failure affecting the whole run (missing credentials, Gmail listing failure) aborts it. A Sheets failure is reported but never discards leads that were already extracted.

## Tech stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/)
- **AI:** [Claude API](https://platform.claude.com/) (`claude-haiku-4-5`, structured outputs)
- **State:** Cloudflare KV — OAuth tokens and processed-message markers
- **Data:** Google Sheets API v4
- **Mail:** Gmail API v1 (read-only)
- **Tooling:** Wrangler v4, Vitest with `@cloudflare/vitest-pool-workers`

## Endpoints

| Method & path         | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `GET /`               | Plain-text landing page                                                 |
| `GET /oauth/start`    | Redirects to Google's consent screen. Guarded by `RUN_TOKEN` if set.    |
| `GET /oauth/callback` | Google redirects here; exchanges the code and stores tokens in KV       |
| `GET /run`            | Runs the pipeline and returns a JSON summary. Guarded by `RUN_TOKEN` if set. |

Any other path returns `404`; any non-`GET` method returns `405`.

`GET /run` responds with:

```json
{
  "processed": 2,
  "skipped": 0,
  "new_leads": [ { "message_id": "...", "subject": "...", "name": "...", "lead_score": 0.9, "...": "..." } ],
  "failed": [],
  "written_to_sheet": 1
}
```

`sheet_error` is present only when the spreadsheet write failed. A whole-run failure returns `502` with `{ "error": "...", "processed": 0, "skipped": 0, "new_leads": [], "failed": [] }`. An unexpected error returns `500` with `{ "error": "Internal Server Error" }` — the detail goes to the logs, not to the caller.

## Environment variables & secrets

| Name                   | Type           | Required | Description                                                                                                          |
| ---------------------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `AGENT_KV`             | `kv_namespace` | yes      | KV namespace holding OAuth tokens and processed-message markers                                                       |
| `GOOGLE_SHEET_ID`      | `var`          | yes      | Target spreadsheet ID, set in `wrangler.jsonc`                                                                        |
| `GOOGLE_CLIENT_ID`     | `secret`       | yes      | OAuth 2.0 client ID from the Google Cloud console                                                                     |
| `GOOGLE_CLIENT_SECRET` | `secret`       | yes      | OAuth 2.0 client secret                                                                                               |
| `ANTHROPIC_API_KEY`    | `secret`       | yes      | Claude API key                                                                                                        |
| `RUN_TOKEN`            | `secret`       | no       | When set, `/oauth/start` and `/run` require it as an `X-Run-Token` header or `?token=` query parameter. **When unset, both endpoints are open** — set it on any deployment reachable from the internet. |
| `OAUTH_REDIRECT_URI`   | `var`          | no       | Pins the OAuth redirect URI. Defaults to `<current origin>/oauth/callback`; set it only when running behind a proxy.  |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/winovateam-bit/gmail-sheets-agent.git
cd gmail-sheets-agent
npm install
```

### 2. Create a Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. Enable the **Gmail API** and the **Google Sheets API** for your project.
2. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type *Web application*.
3. Add both redirect URIs, exactly:
   - `http://localhost:8787/oauth/callback` (local development)
   - `https://<your-worker>.workers.dev/oauth/callback` (deployed)
4. On the OAuth consent screen, add the two scopes the agent requests:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/spreadsheets`
5. While the app is in *Testing*, add the Google account you intend to connect as a test user.

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create AGENT_KV
```

Put the returned id in `wrangler.jsonc` under `kv_namespaces[0].id`.

### 4. Point at a spreadsheet

Set `vars.GOOGLE_SHEET_ID` in `wrangler.jsonc` to the target spreadsheet's ID — the segment between `/d/` and `/edit` in its URL. The agent creates the **Leads** tab and its header row on first write; the account you connect in step 6 must have edit access to the sheet.

### 5. Provide the secrets

Locally, create `.dev.vars` (gitignored):

```ini
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ANTHROPIC_API_KEY=...
# Optional; when set, /oauth/start and /run require it
RUN_TOKEN=...
```

For a deployed Worker, use Wrangler secrets instead:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RUN_TOKEN
```

### 6. Connect a Google account

Start the dev server and visit `/oauth/start`:

```bash
npm run dev
# then open http://localhost:8787/oauth/start
# with RUN_TOKEN set: http://localhost:8787/oauth/start?token=<RUN_TOKEN>
```

Accept **every** permission on the consent screen — the confirmation page names any scope you declined, and a missing scope surfaces later as a `403`. The tokens land in KV under `google_tokens` and are reused by every later run, including cron.

### 7. Trigger a run

```bash
curl http://localhost:8787/run
# with RUN_TOKEN set:
curl -H "X-Run-Token: <RUN_TOKEN>" http://localhost:8787/run
```

### 8. Deploy

```bash
npm run deploy
```

The deployed Worker keeps its own KV data and secrets, so repeat step 6 against the deployed URL once to connect the account there.

#### Choose a Workers plan before going live

**A Worker invocation may make at most 50 subrequests on the free plan, and 1,000 on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month.)** KV reads and writes count toward that limit alongside every Gmail, Claude, and Sheets call — so the limit, not the schedule, is what caps how much mail a single run can get through.

`MAX_MESSAGES` is set to **10** for this reason. A ten-message run costs roughly 48 subrequests: one Gmail listing, ten message fetches, ten Claude calls, ten KV reads and ten KV writes for the processed markers, a couple for the stored token, and about five for Sheets. That fits the free plan, but only just — a run that also refreshes the access token, or that both appends new rows and updates existing ones, sits at the ceiling, and the Claude SDK retries a failed call twice by default. A run that exceeds the limit fails partway through; the messages it did classify stay marked processed, and the rest are picked up on the next run.

**Upgrade to Workers Paid for any inbox with meaningful volume.** Ten messages per run, every 15 minutes, is a ceiling of 40 messages an hour under perfect conditions — and any mailbox that receives more than ten messages in one interval will push older ones out of the recent-messages window before they are ever looked at, so they are silently never classified. On the paid plan the subrequest budget stops being the constraint: raise `MAX_MESSAGES` in `src/run.js` to 20 or more, and the run is then bounded by the 30-second CPU limit rather than by subrequests.

The other paid-plan limits are generous relative to this workload — 10 million requests and 30 million CPU-milliseconds a month are included, and this agent's spend is dominated by the Claude and Google API calls rather than by Workers itself.

## The Leads tab

Columns are written in this order; the position is what matters, so a renamed header row is left alone (and logged) rather than overwritten.

| A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Received At | Name | Email | Phone | Company | Interest | Budget | Source | Urgency | Lead Score | Notes | Message ID |

**Message ID (column L) is the key.** A lead whose ID already appears there updates that row in place instead of appending a duplicate, so re-processing a message repairs the row rather than doubling it.

## Scheduling

`wrangler.jsonc` sets a cron trigger of `*/15 * * * *` — every 15 minutes. Each run looks at the 10 most recent inbox messages, so a mailbox receiving more than 10 in one interval pushes older ones out of the window before they are ever classified, and they are never picked up. Shorten the interval, or raise `MAX_MESSAGES` in `src/run.js` — but read the plan note under [Deploy](#8-deploy) first, since `MAX_MESSAGES` is bounded by the subrequest limit of the plan you are on.

Processed markers expire after 30 days (`PROCESSED_TTL_SECONDS`). A message older than that which is still in the recent-20 window would be re-classified, and its row updated in place rather than duplicated.

Cron runs bypass the `RUN_TOKEN` check — it guards the HTTP route, not the scheduled handler. Watch a run with:

```bash
npx wrangler tail
```

## Testing

```bash
npx vitest run     # once
npm test           # watch mode
```

Tests run against the real `workerd` runtime via `@cloudflare/vitest-pool-workers`. Gmail, Claude, and Sheets are stubbed at `globalThis.fetch`; no network calls and no API spend. The suite clears `RUN_TOKEN` from the test environment so results don't depend on your local `.dev.vars`.

## Project layout

```
src/
  index.js   routing, RUN_TOKEN gate, error handling, cron entry point
  oauth.js   Google OAuth flow, token storage, refresh
  gmail.js   Gmail client — list, fetch, extract plaintext body
  leads.js   Claude classification against a pinned JSON schema
  sheets.js  Sheets client — tab/header creation, update-or-append
  run.js     the pipeline that ties the above together
test/        one spec per module
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401 {"error":"Unauthorized"}` | `RUN_TOKEN` is set but the request has no matching `X-Run-Token` header or `?token=` |
| `502` naming `/oauth/start` | No tokens in KV yet, or the refresh token was revoked — re-run the consent flow |
| `403` from Gmail or Sheets | A scope was declined during consent, or the connected account cannot edit the sheet |
| `redirect_uri_mismatch` from Google | The redirect URI in the console doesn't exactly match the one the Worker sends |
| `sheet_error` in the response, leads still listed | The spreadsheet write failed; the leads were extracted and are safe to re-run |
| Empty `new_leads` on every run | Messages are already marked processed — clear the `processed:` keys in KV to re-examine them |
