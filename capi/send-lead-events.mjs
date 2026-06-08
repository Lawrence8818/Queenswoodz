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
 * Input is either a CSV file or a Google Sheet (--sheet).
 *
 * Usage:
 *   node send-lead-events.mjs leads.csv               # from a CSV file
 *   node send-lead-events.mjs --sheet                 # from the Google Sheet in .env
 *   node send-lead-events.mjs --sheet --dry-run       # build + print payload, send nothing
 *   node send-lead-events.mjs --sheet --test          # route to Test Events tab (needs META_TEST_EVENT_CODE)
 *
 * Configuration is read from environment variables (see .env.example):
 *   META_DATASET_ID      (required)  e.g. 523313347359817  ("New KL Property CRM")
 *   META_CAPI_TOKEN      (required)  System-user / dataset access token with ads_management
 *   META_API_VERSION     (optional)  default v23.0
 *   META_TEST_EVENT_CODE (optional)  e.g. TEST12345 — only used with --test
 *   LEAD_EVENT_SOURCE    (optional)  name of your CRM, default "Queenswoodz CRM"
 * Google Sheet input (--sheet) additionally needs:
 *   GOOGLE_SERVICE_ACCOUNT_JSON      path to service-account key JSON
 *   SHEET_ID                         spreadsheet id from its URL
 *   SHEET_RANGE          (optional)  A1 range, default "A:Z"
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readSheet } from './sheets.mjs';

// ---------------------------------------------------------------------------
// 1. Funnel stage -> Meta event name mapping
// ---------------------------------------------------------------------------
// The CSV `stage` column maps to a Meta event_name here. In Events Manager you
// then map each event_name to a lead-funnel stage and pick which one your
// campaign optimises toward. Keep these names stable once live — renaming
// resets learning.
// Keys are normalised: lower-cased, spaces -> underscores. So "Deal Signed",
// "deal signed" and "deal_signed" all match. `lead` and `form_lead` are aliases
// for the raw-lead stage.
const STAGE_TO_EVENT = {
  lead: 'Lead',                 // raw lead — every lead from the form (the whole pool)
  form_lead: 'Lead',            // alias for `lead`
  viewing_booked: 'Viewing Booked',
  qualified: 'Qualified',
  deal_signed: 'Deal Signed',   // value-bearing — the deepest signal
};

// Normalise a stage string to a STAGE_TO_EVENT key.
const stageKey = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, '_');

// Stages that should carry a monetary value (enables value optimisation later).
const VALUE_STAGES = new Set(['deal_signed']);

// Column-name aliases — so the same tool reads a hand-made CSV *or* the
// Meta-delivered sheet (which uses phone_number, full name, lead_status, etc.)
// without renaming anything. Matched case-insensitively.
const FIELD_ALIASES = {
  lead_id: ['lead_id', 'leadid', 'id', 'leadgen_id'],
  email: ['email', 'em', 'email_address', 'e-mail'],
  phone: ['phone', 'phone_number', 'ph', 'mobile', 'contact_number'],
  first_name: ['first_name', 'firstname', 'fn'],
  last_name: ['last_name', 'lastname', 'ln'],
  full_name: ['full_name', 'full name', 'name', 'fullname'],
  stage: ['stage', 'lead_status', 'status', 'lead stage'],
  event_time: ['event_time', 'created_time', 'created', 'date', 'event_date', 'timestamp'],
  value: ['value', 'deal_value', 'amount', 'price'],
  currency: ['currency'],
};

// Read a logical field from a row by trying its aliases (case-insensitive).
function field(rec, key) {
  if (!rec.__lc) {
    rec.__lc = {};
    for (const k of Object.keys(rec)) rec.__lc[k.toLowerCase().trim()] = rec[k];
  }
  for (const alias of FIELD_ALIASES[key] || [key]) {
    const v = rec.__lc[alias];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

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
const USE_SHEET = flags.has('--sheet');
const DRY_RUN = flags.has('--dry-run');
const TEST_MODE = flags.has('--test');

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!USE_SHEET && !csvPath) die('Provide a CSV path or pass --sheet to read the Google Sheet.');
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
  const now = Math.floor(Date.now() / 1000);
  const SEVEN_DAYS = 7 * 24 * 3600;
  let t;
  if (!v) t = now;
  else if (/^\d{10}$/.test(v)) t = Number(v);              // unix seconds
  else if (/^\d{13}$/.test(v)) t = Math.floor(Number(v) / 1000); // unix ms
  else { const p = Date.parse(v); t = Number.isNaN(p) ? now : Math.floor(p / 1000); }
  // Meta's /events endpoint rejects event_time more than 7 days old or in the
  // future. We don't track the exact moment a stage changed, so clamp anything
  // outside that window to "now" (dedup is by event_id, so re-sends still
  // collapse correctly).
  if (t > now || t < now - SEVEN_DAYS) t = now;
  return t;
}

function buildEvent(rec, lineNo) {
  // A blank status means the lead exists but hasn't progressed = raw `lead`.
  // That's the whole unprogressed pool, which Meta needs as the baseline.
  const rawStage = field(rec, 'stage');
  const stage = rawStage ? stageKey(rawStage) : 'lead';
  const eventName = STAGE_TO_EVENT[stage];
  if (!eventName) {
    console.warn(`  ⚠ line ${lineNo}: unknown stage "${rawStage}" — skipped. ` +
      `Valid: lead, viewing booked, qualified, deal signed`);
    return null;
  }

  // Strip any "l:" / "p:" style prefixes by keeping digits only. lead_id is the
  // Meta leadgen id — the strongest match key — and is sent UNHASHED.
  const leadId = field(rec, 'lead_id').replace(/[^0-9]/g, '');
  const email = field(rec, 'email');
  const phone = field(rec, 'phone');

  // Names: use explicit first/last if present, else split a "full name" column.
  let firstName = field(rec, 'first_name');
  let lastName = field(rec, 'last_name');
  if (!firstName && !lastName) {
    const parts = field(rec, 'full_name').split(/\s+/).filter(Boolean);
    firstName = parts.shift() || '';
    lastName = parts.join(' ');
  }

  const user_data = {};
  if (leadId) user_data.lead_id = leadId;
  const em = normEmail(email);     if (em) user_data.em = [em];
  const ph = normPhone(phone);     if (ph) user_data.ph = [ph];
  const fn = normName(firstName);  if (fn) user_data.fn = [fn];
  const ln = normName(lastName);   if (ln) user_data.ln = [ln];

  if (!user_data.lead_id && !user_data.em && !user_data.ph) {
    console.warn(`  ⚠ line ${lineNo}: no lead_id / email / phone — unmatchable, skipped.`);
    return null;
  }

  const custom_data = {
    // These two fields are what make Meta treat this as a CRM lead event.
    event_source: 'crm',
    lead_event_source: cfg.leadEventSource,
  };
  const value = field(rec, 'value');
  if (VALUE_STAGES.has(stage) && value) {
    custom_data.value = Number(value);
    custom_data.currency = field(rec, 'currency') || 'MYR';
  }
  custom_data.lead_stage = rawStage || 'lead'; // human-readable, for reporting

  return {
    event_name: eventName,
    event_time: toUnixSeconds(field(rec, 'event_time')),
    action_source: 'system_generated',           // required for CRM/back-end events
    event_id: eventId(user_data.lead_id, stage, email || phone || lineNo),
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
    // Surface Meta's *detailed* reason — the top-level message is often just
    // "Invalid parameter"; the useful text lives in these sub-fields.
    const detail = [
      e.error_subcode ? `subcode=${e.error_subcode}` : '',
      e.error_user_title ? `title="${e.error_user_title}"` : '',
      e.error_user_msg ? `why="${e.error_user_msg}"` : '',
      e.error_data ? `data=${JSON.stringify(e.error_data)}` : '',
    ].filter(Boolean).join(' ');
    console.error('\n— First event in the failing batch (for debugging) —');
    console.error(JSON.stringify(events[0], null, 2));
    die(`Meta API ${res.status}: ${e.message || JSON.stringify(json)} ` +
      `(type=${e.type} code=${e.code} ${detail} fbtrace_id=${e.fbtrace_id || 'n/a'})`);
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
async function loadRecords() {
  if (USE_SHEET) {
    // SHEET_ID may be a single id or a comma-separated list (one per Facebook
    // page). All are read with the same range and pooled into one dataset;
    // event_id dedup keeps things clean and lead_ids never collide across pages.
    const ids = (process.env.SHEET_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
    const range = process.env.SHEET_RANGE || 'A:Z';
    if (!ids.length) throw new Error('SHEET_ID is not set.');
    let all = [];
    for (const sheetId of ids) {
      console.log(`Reading Google Sheet ${sheetId} (${range})…`);
      const rows = await readSheet({
        credentialsPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        sheetId,
        range,
      });
      console.log(`  ${rows.length} row(s)`);
      all = all.concat(rows);
    }
    return all;
  }
  return parseCsv(readFileSync(csvPath, 'utf8'));
}

(async () => {
  const records = await loadRecords();
  if (!records.length) die(`No data rows found in ${USE_SHEET ? 'the sheet' : csvPath}.`);

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
})().catch((e) => die(e.message || String(e)));
