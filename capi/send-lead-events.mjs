#!/usr/bin/env node
/**
 * Meta Conversions API — CRM lead-stage event uploader
 * ----------------------------------------------------
 * Sends deep-funnel lead-stage events (viewing booked, qualified, deal signed)
 * from your CRM back into a Meta CRM dataset, so lead-gen campaigns can optimise
 * for real outcomes instead of raw form fills ("Conversion Leads" optimisation).
 *
 * Zero dependencies. Requires Node 18+ (uses native fetch + crypto).
 *
 * Usage:
 *   node send-lead-events.mjs leads.csv
 *   node send-lead-events.mjs leads.csv --dry-run        # build + print payload, send nothing
 *   node send-lead-events.mjs leads.csv --test           # route to Test Events tab (needs META_TEST_EVENT_CODE)
 *
 * Configuration is read from environment variables (see .env.example):
 *   META_DATASET_ID      (required)  e.g. 1072574217502347  ("Lawrence Property CRM")
 *   META_CAPI_TOKEN      (required)  System-user / dataset access token with ads_management
 *   META_API_VERSION     (optional)  default v23.0
 *   META_TEST_EVENT_CODE (optional)  e.g. TEST12345 — only used with --test
 *   LEAD_EVENT_SOURCE    (optional)  name of your CRM, default "Queenswoodz CRM"
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. Funnel stage -> Meta event name mapping
// ---------------------------------------------------------------------------
// The CSV `stage` column maps to a Meta event_name here. In Events Manager you
// then map each event_name to a lead-funnel stage and pick which one your
// campaign optimises toward. Keep these names stable once live — renaming
// resets learning.
const STAGE_TO_EVENT = {
  form_lead: 'Lead',            // initial form submission (Meta usually already has this)
  viewing_booked: 'ViewingBooked',
  qualified: 'Qualified',
  deal_signed: 'DealSigned',    // value-bearing — the deepest signal
};

// Stages that should carry a monetary value (enables value optimisation later).
const VALUE_STAGES = new Set(['deal_signed']);

// ---------------------------------------------------------------------------
// 2. Config
// ---------------------------------------------------------------------------
const cfg = {
  datasetId: process.env.META_DATASET_ID,
  token: process.env.META_CAPI_TOKEN,
  apiVersion: process.env.META_API_VERSION || 'v23.0',
  testEventCode: process.env.META_TEST_EVENT_CODE || '',
  leadEventSource: process.env.LEAD_EVENT_SOURCE || 'Queenswoodz CRM',
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const csvPath = args.find((a) => !a.startsWith('--'));
const DRY_RUN = flags.has('--dry-run');
const TEST_MODE = flags.has('--test');

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!csvPath) die('Provide a CSV path, e.g. `node send-lead-events.mjs leads.csv`');
if (!cfg.datasetId) die('META_DATASET_ID is not set.');
if (!cfg.token && !DRY_RUN) die('META_CAPI_TOKEN is not set (required unless --dry-run).');
if (TEST_MODE && !cfg.testEventCode) die('--test requires META_TEST_EVENT_CODE to be set.');

// ---------------------------------------------------------------------------
// 3. Helpers — hashing & normalisation per Meta spec
// ---------------------------------------------------------------------------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Email: trim + lowercase. Phone: keep digits only, including country code (E.164 without '+').
const normEmail = (v) => (v ? sha256(v.trim().toLowerCase()) : undefined);
const normPhone = (v) => {
  if (!v) return undefined;
  const digits = v.replace(/[^0-9]/g, '').replace(/^0+/, ''); // strip leading local zeros
  return digits ? sha256(digits) : undefined;
};
const normName = (v) => (v ? sha256(v.trim().toLowerCase()) : undefined);

// Deterministic event_id for dedup: same lead + same stage => same id, so re-runs
// never double-count.
const eventId = (leadId, stage, key) => sha256(`${leadId || key}|${stage}`).slice(0, 32);

// ---------------------------------------------------------------------------
// 4. Minimal RFC-4180-ish CSV parser (handles quoted fields & commas)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// 5. Build CAPI events from CSV rows
// ---------------------------------------------------------------------------
function toUnixSeconds(v) {
  if (!v) return Math.floor(Date.now() / 1000);
  // accept unix seconds, unix ms, or ISO date
  if (/^\d{10}$/.test(v)) return Number(v);
  if (/^\d{13}$/.test(v)) return Math.floor(Number(v) / 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000);
}

function buildEvent(rec, lineNo) {
  const stage = (rec.stage || '').toLowerCase();
  const eventName = STAGE_TO_EVENT[stage];
  if (!eventName) {
    console.warn(`  ⚠ line ${lineNo}: unknown stage "${rec.stage}" — skipped. ` +
      `Valid: ${Object.keys(STAGE_TO_EVENT).join(', ')}`);
    return null;
  }

  // lead_id is the Meta-generated leadgen id from your Instant Form — the strongest
  // match key for lead-ads attribution. Sent UNHASHED inside user_data.
  const user_data = {};
  if (rec.lead_id) user_data.lead_id = String(rec.lead_id).replace(/[^0-9]/g, '');
  const em = normEmail(rec.email);   if (em) user_data.em = [em];
  const ph = normPhone(rec.phone);   if (ph) user_data.ph = [ph];
  const fn = normName(rec.first_name); if (fn) user_data.fn = [fn];
  const ln = normName(rec.last_name);  if (ln) user_data.ln = [ln];

  if (!user_data.lead_id && !user_data.em && !user_data.ph) {
    console.warn(`  ⚠ line ${lineNo}: no lead_id / email / phone — unmatchable, skipped.`);
    return null;
  }

  const custom_data = {
    // These two fields are what make Meta treat this as a CRM lead event.
    event_source: 'crm',
    lead_event_source: cfg.leadEventSource,
  };
  if (VALUE_STAGES.has(stage) && rec.value) {
    custom_data.value = Number(rec.value);
    custom_data.currency = rec.currency || 'MYR';
  }
  if (rec.stage) custom_data.lead_stage = rec.stage; // human-readable, for reporting

  return {
    event_name: eventName,
    event_time: toUnixSeconds(rec.event_time),
    action_source: 'system_generated',           // required for CRM/back-end events
    event_id: eventId(user_data.lead_id, stage, rec.email || rec.phone || lineNo),
    user_data,
    custom_data,
  };
}

// ---------------------------------------------------------------------------
// 6. Send (batched up to 1000/request)
// ---------------------------------------------------------------------------
async function send(events) {
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.datasetId}/events`;
  const body = { data: events, access_token: cfg.token };
  if (TEST_MODE) body.test_event_code = cfg.testEventCode;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    die(`Meta API ${res.status}: ${e.message || JSON.stringify(json)} ` +
      `(type=${e.type} code=${e.code} fbtrace_id=${e.fbtrace_id || 'n/a'})`);
  }
  return json;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------
(async () => {
  const records = parseCsv(readFileSync(csvPath, 'utf8'));
  if (!records.length) die(`No data rows found in ${csvPath}.`);

  const events = records
    .map((rec, i) => buildEvent(rec, i + 2)) // +2: header is line 1
    .filter(Boolean);

  console.log(`\nDataset : ${cfg.datasetId}`);
  console.log(`API     : ${cfg.apiVersion}`);
  console.log(`Source  : ${cfg.leadEventSource}`);
  console.log(`Mode    : ${DRY_RUN ? 'DRY RUN (nothing sent)' : TEST_MODE ? `TEST (${cfg.testEventCode})` : 'LIVE'}`);
  console.log(`Events  : ${events.length} valid of ${records.length} rows\n`);

  if (!events.length) die('Nothing to send.');

  if (DRY_RUN) {
    console.log(JSON.stringify({ data: events }, null, 2));
    console.log('\n✔ Dry run complete — no request was made.\n');
    return;
  }

  let received = 0;
  for (const batch of chunk(events, 1000)) {
    const r = await send(batch);
    received += r.events_received || 0;
    if (r.messages?.length) r.messages.forEach((m) => console.warn(`  ⚠ ${m}`));
    console.log(`  → batch sent: events_received=${r.events_received} fbtrace_id=${r.fbtrace_id}`);
  }
  console.log(`\n✔ Done. Meta accepted ${received} event(s).`);
  if (TEST_MODE) console.log('  Check Events Manager → your dataset → Test Events to see them live.');
  else console.log('  Check Events Manager → your dataset → Overview (web + offline) within ~20 min.\n');
})().catch((e) => die(e.stack || String(e)));
