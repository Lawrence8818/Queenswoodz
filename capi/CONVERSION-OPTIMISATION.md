# Wiring up "Pass 3" — make cost-per-SALE optimise itself

This connects the ad analysis in
[`../analysis/bukit-jalil-winning-ads-2025.md`](../analysis/bukit-jalil-winning-ads-2025.md)
to this CAPI pipeline, so the **cost-per-closed-unit ranking you did by hand stops being a
manual exercise** and becomes something Meta optimises toward automatically.

## The idea in one line

You currently rank ads three ways — spend, cost-per-lead, and (by hand) **cost-per-sale**.
Passes 1–2 are free from Meta. **Pass 3 only becomes automatic once Meta knows which leads
turned into buyers** — which is exactly what feeding `deal_signed` back through this pipeline
does. Then Meta's own reporting shows **cost-per-`DealSigned` per ad**, and the algorithm
stops chasing cheap leads that never close (your `QW Video 1` problem).

```
Lead Ad → lead_id → [your sheet: stage progresses to deal_signed + source_ad]
        → send-lead-events.mjs → DealSigned event (carries lead_id + value)
        → Meta ties the sale back to the exact ad
        → cost-per-DealSigned per ad = Pass 3, computed automatically, daily
        → campaign optimises toward BUYERS, not form-fills
```

## Why this matters (from the analysis)

The 3-pass analysis proved cheap leads ≠ buyers:
- `QW Video 1` — RM60/lead (looked great) → **0 sales** on RM3,360. Optimising for *leads*
  kept funding it. Optimising for *DealSigned* would have starved it.
- `Vela` (RM512/sale, 6 units) and `6_pic_Golf View` (RM324/sale, 2 big units) were
  **under-funded** — a sale-optimised campaign would have pushed budget toward them.

Automating Pass 3 is how you stop repeating that.

## Steps

### 1. Seed the deals (re-activates the silent dataset)
The dataset `523313347359817` has had **zero `DealSigned` events ever** — so sale-optimisation
can't start. Backfill your closed units first:
- Open [`backfill-template.csv`](./backfill-template.csv) — now has a **`source_ad`** column.
- One row per closed unit: `stage = deal signed`, `value = price (MYR)`, `source_ad =` the
  winning ad (e.g. `QW_Vid 1_Site`, `Vela`, `6_pic_Golf View`). Fill `lead_id` **or**
  `email`+`phone` from your CRM/Privyr (a row with none of these is skipped — see uploader).
- Use the 29 units from §B3 of the analysis as your starting list.
- Send it (see [`BACKFILL.md`](./BACKFILL.md) Step 3). Deals older than 7 days won't
  *attribute* to past spend, but they seed the model + your Lookalike — that's expected.

### 2. Keep the sheet flowing (the daily engine)
- Add a **`source_ad`** column to your Google Sheet; tag each lead with the ad it came from.
- The included GitHub Action (`.github/workflows/meta-capi-leads.yml`, 09:00 MYT daily)
  replays the sheet to Meta. Deterministic `event_id` makes re-sends safe. Nothing to run by hand.

### 3. Map + confirm in Events Manager
- *Events Manager → dataset `523313347359817` → Test Events* — confirm `DealSigned` (and
  `Qualified`) arrive with **Good/Great EMQ**.
- Map the order: `Lead → ViewingBooked → Qualified → DealSigned`.

### 4. Switch the campaign to optimise for outcomes
On your always-on lead-gen campaign, change optimisation **Leads → Conversion Leads**:
- **Now:** optimise for **`Qualified`** (you have ~100+ — enough to exit learning;
  `DealSigned` at ~29/9-months is too sparse to optimise on directly yet).
- **Later:** move to **`DealSigned`** once weekly volume supports it. Until then, deals still
  power **value optimisation** and a **buyers Lookalike** (build from the `deal_signed` rows).

### 5. Reallocate budget to what actually sells (from §B3)
| Action | Ad(s) | Why |
|---|---|---|
| **Scale up** | `6_pic_Golf View`, `Vela` | cheapest cost-per-SALE (RM324 / RM512), under-funded |
| **Keep scaling** | `QW_Vid 1_Site` (Hero) | 9 units, RM1,220 CAC — your volume engine |
| **Test up** | investor / passive-income angle | closed units on pocket change |
| **Cut / rework** | `QW Video 1` | 0 sales on RM3,360 |
| **Retargeting only** | `QW_Vid 3_VR` | worst CAC, small units |

## Reading "Pass 3" once it's live
- **Ads Manager** → set result column to **cost per `DealSigned`** (or `Qualified`) →
  that column *is* your CAC ranking, refreshed daily, no spreadsheet.
- **Breakdown by `lead_source_ad`** (the field this pipeline now sends) cross-checks Meta's
  attribution against your own sales log.
- Ask me to pull it through the live Meta connection any time and I'll regenerate the §B3
  table from real attributed data.

---
*Pairs with `../analysis/bukit-jalil-winning-ads-2025.md`. The pipeline already sends
`DealSigned` with value; this doc + the new `source_ad` field are what make the cost-per-sale
loop close on its own.*
