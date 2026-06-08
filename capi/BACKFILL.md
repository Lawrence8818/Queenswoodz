# One-time historical backfill (~1,140 leads)

Goal: seed Meta with your 15 months of history in one shot, so your Lookalike source
and the conversion-leads model start full instead of empty. After this, your day-to-day
stage updates (in the Google Sheet) keep it fresh.

## Step 1 — Export your history

From **Privyr** (or *Meta Business Suite → All tools → Instant Forms → Download leads*),
export every lead you have. You need, per lead:

- **`lead_id`** — the 15–16 digit Meta lead id (the match key). Privyr stores this even for
  old leads. If a few don't have it, leave blank — email + phone will match instead.
- **email**, **phone** (with country code, e.g. `+60…`), name — for matching.
- the **date** the lead reached its stage.

## Step 2 — Fill in `backfill-template.csv`

Open `backfill-template.csv`, keep the header row, and put **one row per lead at its
HIGHEST stage reached**. Apply this classification exactly:

| Your leads | `stage` column | `value` |
|---|---|---|
| 38 deals **you** closed (your area) | `deal signed` | the deal price in MYR |
| 51 deals closed **elsewhere** in KV | `qualified` | leave blank |
| ~50 genuine qualified | `qualified` | blank |
| anyone who booked a viewing but didn't close | `viewing booked` | blank |
| 1,000+ dead / low-quality | `lead` | blank |

Two rules that matter:
- **Keep every dead lead in the file as `lead`.** They are the contrast pool — deleting them
  weakens the signal.
- **One row per lead.** For backfill you only need each lead's deepest stage (not its whole
  history). The 1,140 rows then form your funnel snapshot: ~1,140 `lead`, ~101 `qualified`,
  38 `deal signed`.
- The `notes` column is for your own reference — it's ignored by the uploader and never sent
  to Meta.
- Stage words are flexible: `Deal Signed`, `deal signed`, `deal_signed` all work.

## Step 3 — Load it into Meta

Two ways — pick one:

### Option A — Through the Google Sheet (no token, simplest)
Paste the filled rows into your **CRM upload sheet** (the one connected in Events Manager
Step 3). Meta ingests them on its next sync. Nothing technical, no access token.

### Option B — One-shot API push with the script (needs one access token)
Faster for 1,140 rows in a single go. You generate **one** access token (Events Manager →
dataset `523313347359817` → Settings → Conversions API → Generate access token), then:

```bash
cd capi
cp .env.example .env          # paste META_CAPI_TOKEN, keep META_DATASET_ID=523313347359817

# 1) Preview — builds everything, sends nothing:
node --env-file=.env send-lead-events.mjs backfill-template.csv --dry-run

# 2) Verify a handful land correctly (set META_TEST_EVENT_CODE first):
node --env-file=.env send-lead-events.mjs backfill-template.csv --test

# 3) Push the full history:
node --env-file=.env send-lead-events.mjs backfill-template.csv
```

The uploader hashes all PII, sends `lead_id` as the match key, and gives each row a stable
`event_id` — so if you re-run it, Meta de-duplicates and nothing doubles up.

## Step 4 — Tell me

Once it's loaded, I'll read your dataset through the live Meta connection and confirm:
match quality (EMQ), how many events matched, and your real per-stage volumes — then I'll
help you build the Lookalike audience and set the right geo + optimisation.

> Note on dates: historical events older than 7 days won't *attribute* to past ad spend
> (that's expected), but Meta still uses them to seed the Lookalike source and the
> conversion-leads model — which is the whole point of the backfill.
