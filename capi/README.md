# Meta CAPI — CRM Lead-Stage Events (Queenswoodz)

Feed deep-funnel lead signals — **viewing booked → qualified → deal signed** — from your
CRM back into Meta via the Conversions API, so your always-on lead-gen ads can optimise for
*outcomes* instead of raw form fills. This is the "Conversion Leads" setup.

> **Why this matters for you right now.** Your dataset **"Lawrence Property CRM"
> (`1072574217502347`)** already exists but has **never received a single event** — no
> events configured, zero signal quality, never fired. Meta has nothing deep-funnel to learn
> from, which is why higher-funnel optimisation stays locked. This pipeline fills that gap.

---

## The model in one picture

```
Meta Lead Ad (Instant Form)
        │  lead arrives, carries a `lead_id` (15–16 digit Meta leadgen id)
        ▼
   Your CRM / sheet  ──►  lead moves through stages over days/weeks
        │                    viewing_booked → qualified → deal_signed
        ▼
  send-lead-events.mjs  ──►  Conversions API  ──►  "Lawrence Property CRM" dataset
        │                                              │
        │  action_source: system_generated             ▼
        │  custom_data.event_source: crm        Events Manager: map each event
        │  user_data.lead_id (+ hashed em/ph)   to a funnel stage, then set the
        ▼                                       campaign to optimise for it
  Campaign optimises toward "deal signed" leads, not form fills
```

The **`lead_id`** is the magic key. Because it comes straight off the Instant Form, Meta can
tie a "deal signed" weeks later back to the exact ad/audience that produced it — no cookies,
no pixel, fully attributable.

---

## One-time Meta setup (do this once)

1. **Pick the dataset.** Use **`1072574217502347` ("Lawrence Property CRM")**. In
   *Events Manager → Settings*, confirm it's connected to the **Facebook Page** running your
   Queenswoodz lead ads (CRM events match to leads through the Page).
2. **Generate an access token.** *Events Manager → dataset → Settings → Conversions API →
   Generate access token* (or a Business **system user** with `ads_management`). Paste it
   into `.env` as `META_CAPI_TOKEN`. Treat it like a password.
3. **Send a few test events** (see below) so the event names register.
4. **Map the funnel stages.** In *Events Manager → dataset → Custom Conversions / Lead
   stages*, map each event name to a stage and order them:
   `Lead → ViewingBooked → Qualified → DealSigned`.
5. **Switch the campaign.** On your lead-gen campaign, change optimisation from
   *"Leads"* to **"Conversion leads"** and pick the deepest stage you have enough volume for
   (start at `ViewingBooked` or `Qualified`; move to `DealSigned` once volume allows —
   Meta needs roughly tens of conversions/week per ad set to exit learning).

---

## Daily / weekly run

1. Export your leads to a CSV (columns below). Keep the **`lead_id`** column populated from
   your Lead Ads — it's the strongest match key.
2. `cp .env.example .env` and fill in `META_CAPI_TOKEN`.
3. Send:

```bash
cd capi

# 1) See exactly what will be sent — no request made:
node send-lead-events.mjs leads.csv --dry-run

# 2) Route to the Test Events tab to eyeball matching (set META_TEST_EVENT_CODE first):
node --env-file=.env send-lead-events.mjs leads.csv --test

# 3) Go live:
node --env-file=.env send-lead-events.mjs leads.csv
# or:  npm run send
```

Re-running is safe: each event gets a **deterministic `event_id`** (`lead_id` + stage), so
Meta de-duplicates — you can re-send the whole file daily without double-counting.

---

## CSV format

| column        | required | notes |
|---------------|----------|-------|
| `lead_id`     | strongly recommended | Meta leadgen id from the Instant Form. Best match key. |
| `email`       | recommended | hashed (SHA-256) before sending |
| `phone`       | recommended | E.164 preferred (`+60…`); hashed before sending |
| `first_name`  | optional | hashed |
| `last_name`   | optional | hashed |
| `stage`       | **yes** | one of `form_lead`, `viewing_booked`, `qualified`, `deal_signed` |
| `event_time`  | optional | ISO (`2026-06-07T11:00:00+08:00`) or unix seconds; defaults to now |
| `value`       | for `deal_signed` | deal value, enables value optimisation later |
| `currency`    | optional | default `MYR` |

At least one of `lead_id` / `email` / `phone` must be present or the row is skipped.
See `leads.sample.csv`. Only PII is hashed — `lead_id` is sent in the clear (that's correct;
it's not personal data, it's Meta's own id).

---

## Stage → event name mapping

Edit `STAGE_TO_EVENT` at the top of `send-lead-events.mjs` to match your pipeline wording.
Defaults:

| CSV `stage`      | Meta `event_name` | carries value? |
|------------------|-------------------|----------------|
| `form_lead`      | `Lead`            | no |
| `viewing_booked` | `ViewingBooked`   | no |
| `qualified`      | `Qualified`       | no |
| `deal_signed`    | `DealSigned`      | yes (`value` + `currency`) |

Keep names stable once live — renaming an event resets Meta's learning.

---

## Verifying it's "clean signal"

- *Events Manager → dataset → Test Events* — confirm events arrive and **Event Match Quality
  (EMQ)** is "Good"/"Great". Low EMQ = add more identifiers (email + phone + lead_id).
- *Events Manager → dataset → Overview* — event counts should climb within ~20 min of a live
  run.
- The uploader prints `events_received` and an `fbtrace_id` per batch — if `events_received`
  is lower than what you sent, check the `⚠` messages it prints.

---

## Automating later

This CSV runner is the manual baseline. To make it continuous, swap the CSV read for a pull
from wherever your pipeline lives (Notion, Google Sheet, or a real CRM webhook) and run it on
a schedule (cron / GitHub Action). The `buildEvent()` function is the only piece you need to
feed — everything downstream stays the same.

---

## Sources

- [Conversions API for CRM — Meta for Developers](https://developers.facebook.com/docs/marketing-api/conversions-api/guides/conversions-api-crm-for-platforms/)
- [Conversions API for CRM Integration](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration)
- [Conversions API parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters)
- [Marketing API versioning](https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/versioning)
