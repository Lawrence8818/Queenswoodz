#!/usr/bin/env node
/**
 * Meta Lead Ads -> Google Sheet importer
 * --------------------------------------
 * Pulls new leads from your Facebook Page's lead forms and appends them to the
 * CRM Google Sheet, so the daily send-lead-events.mjs run has fresh rows to push
 * back to the dataset. This is the *first leg* of the pipeline:
 *
 *   Meta Lead Center  ->  [pull-leads.mjs]  ->  Google Sheet  ->  [send-lead-events.mjs]  ->  Meta CAPI
 *
 * Zero dependencies. Requires Node 18+ (native fetch). Writes the sheet via the
 * service account, which must have *Editor* access (read-only is enough for the
 * send step, but appending needs write).
 *
 * Usage:
 *   node pull-leads.mjs            # fetch new leads and append them
 *   node pull-leads.mjs --dry-run  # fetch + print what would be appended, write nothing
 *
 * Configuration (env, see .env.example):
 *   META_CAPI_TOKEN     (required)  token with `leads_retrieval` + access to the Page
 *   META_PAGE_ID        (required)  Facebook Page id that owns the lead forms
 *   META_API_VERSION    (optional)  default v23.0
 *   LEAD_LOOKBACK_DAYS  (optional)  how far back to consider leads, default 30
 *   GOOGLE_SERVICE_ACCOUNT_JSON     path to service-account key JSON
 *   SHEET_ID                        spreadsheet id (single id; first id if comma-list)
 *   SHEET_RANGE         (optional)  A1 range, default "A:R"
 */

import { readSheet, appendRows } from './sheets.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const cfg = {
  // Pulling leads needs `leads_retrieval` + Page access, which the send-only
  // CAPI token usually lacks. Use a dedicated META_LEADS_TOKEN if provided, and
  // fall back to META_CAPI_TOKEN (handy if you make one token with all scopes).
  token: process.env.META_LEADS_TOKEN || process.env.META_CAPI_TOKEN,
  pageId: process.env.META_PAGE_ID,
  apiVersion: process.env.META_API_VERSION || 'v23.0',
  lookbackDays: Number(process.env.LEAD_LOOKBACK_DAYS || '30'),
  credentialsPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  sheetId: (process.env.SHEET_ID || '').split(',').map((s) => s.trim()).filter(Boolean)[0],
  range: process.env.SHEET_RANGE || 'A:R',
};

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

if (!cfg.token) die('META_LEADS_TOKEN / META_CAPI_TOKEN is not set.');
if (!cfg.pageId) die('META_PAGE_ID is not set.');
if (!cfg.credentialsPath) die('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
if (!cfg.sheetId) die('SHEET_ID is not set.');

const GRAPH = `https://graph.facebook.com/${cfg.apiVersion}`;

// ---------------------------------------------------------------------------
// Graph helpers (with paging + readable errors)
// ---------------------------------------------------------------------------
async function graphGet(node, params = {}, token = cfg.token) {
  const url = new URL(`${GRAPH}/${node}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    const hint = e.code === 200 || e.code === 10 || /permission/i.test(e.message || '')
      ? ' — the token is missing the `leads_retrieval` permission or lacks access to this Page.'
      : '';
    throw new Error(`Graph ${res.status} on ${node}: ${e.message || JSON.stringify(json)} ` +
      `(code=${e.code} fbtrace_id=${e.fbtrace_id || 'n/a'})${hint}`);
  }
  return json;
}

async function graphGetAll(node, params = {}, token = cfg.token) {
  let out = [];
  let json = await graphGet(node, { ...params, limit: '100' }, token);
  out = out.concat(json.data || []);
  while (json.paging?.next) {
    const res = await fetch(json.paging.next);
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Graph paging error: ${JSON.stringify(json.error || json)}`);
    out = out.concat(json.data || []);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------
// Meta's standard lead-form field names. Anything *not* in here is treated as a
// custom question (your "interested_in" property-type question).
const STANDARD_FIELDS = new Set([
  'full_name', 'first_name', 'last_name', 'email', 'work_email', 'phone_number',
  'city', 'state', 'province', 'country', 'post_code', 'zip', 'street_address',
  'company_name', 'job_title', 'gender', 'dob', 'date_of_birth',
  'marital_status', 'relationship_status', 'military_status',
]);

function answersOf(lead) {
  const a = {};
  for (const f of lead.field_data || []) a[f.name] = (f.values || []).join(', ');
  return a;
}

function customAnswer(lead) {
  for (const f of lead.field_data || []) {
    if (!STANDARD_FIELDS.has(f.name)) return (f.values || []).join(', ');
  }
  return '';
}

// created_time arrives as ISO 8601 with offset ("2026-05-27T09:30:00+0800").
// Keep just the local datetime to match the existing sheet's formatting.
const trimTime = (t) => (t ? String(t).replace(/[+-]\d{4}$/, '').replace(/Z$/, '') : '');

// Build a sheet row (columns A..R) from a Meta lead. Mirrors the prefixes the
// original connector used ("l:", "ag:", "as:", "c:", "f:", "p:") so new rows are
// visually identical to existing ones and the send step parses them the same.
function leadToRow(lead, formName) {
  const a = answersOf(lead);
  return [
    `l:${lead.id}`,                                   // A id
    trimTime(lead.created_time),                      // B created_time
    lead.ad_id ? `ag:${lead.ad_id}` : '',             // C ad_id
    lead.ad_name || '',                               // D ad_name
    lead.adset_id ? `as:${lead.adset_id}` : '',       // E adset_id
    lead.adset_name || '',                            // F adset_name
    lead.campaign_id ? `c:${lead.campaign_id}` : '',  // G campaign_id
    lead.campaign_name || '',                         // H campaign_name
    lead.form_id ? `f:${lead.form_id}` : '',          // I form_id
    formName || '',                                   // J form_name
    lead.is_organic ? 'TRUE' : 'FALSE',               // K is_organic
    lead.platform || '',                              // L platform
    customAnswer(lead),                               // M interested_in
    a.phone_number ? `p:${a.phone_number}` : '',      // N phone_number
    a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' '), // O full name
    a.city || '',                                     // P city
    '',                                               // Q inbox_url (set elsewhere)
    '',                                               // R lead_status (set manually)
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  // 1. Existing lead ids already in the sheet (strip the "l:" prefix to digits).
  const existing = await readSheet({
    credentialsPath: cfg.credentialsPath,
    sheetId: cfg.sheetId,
    range: cfg.range,
  });
  const have = new Set(
    existing.map((r) => String(r.id || '').replace(/[^0-9]/g, '')).filter(Boolean)
  );
  console.log(`Sheet has ${have.size} existing lead(s).`);

  // 2. Exchange the system-user token for a Page access token — the
  // leadgen_forms / leads endpoints must be called with a Page token, not a
  // user token (Graph error #190 otherwise).
  const pageToken = (await graphGet(cfg.pageId, { fields: 'access_token' })).access_token;
  if (!pageToken) {
    die('Could not obtain a Page access token — confirm the system user has the ' +
      'Page assigned with full control and the token includes pages_show_list / pages_read_engagement.');
  }

  // 3. The Page's lead forms (gives us each form's name too).
  const forms = await graphGetAll(`${cfg.pageId}/leadgen_forms`, { fields: 'id,name' }, pageToken);
  console.log(`Page ${cfg.pageId}: ${forms.length} lead form(s).`);
  if (!forms.length) die('No lead forms found on this Page (check META_PAGE_ID and token access).');

  // 4. Pull recent leads per form, keep only new ones inside the lookback window.
  const cutoff = Math.floor(Date.now() / 1000) - cfg.lookbackDays * 86400;
  const leadFields =
    'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,' +
    'form_id,is_organic,platform,field_data';

  const newRows = [];
  let scanned = 0;
  for (const form of forms) {
    const leads = await graphGetAll(`${form.id}/leads`, { fields: leadFields }, pageToken);
    for (const lead of leads) {
      scanned++;
      const created = Math.floor(Date.parse(lead.created_time) / 1000);
      if (Number.isFinite(created) && created < cutoff) continue;     // too old
      if (have.has(String(lead.id))) continue;                        // already in sheet
      have.add(String(lead.id));                                      // guard dupes within this run
      newRows.push(leadToRow(lead, form.name));
    }
  }

  console.log(`Scanned ${scanned} lead(s) across forms; ${newRows.length} new within ${cfg.lookbackDays} days.\n`);

  if (!newRows.length) {
    console.log('✔ Nothing new to add — sheet is up to date.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — rows that would be appended:');
    for (const r of newRows) console.log('  ' + JSON.stringify(r));
    console.log('\n✔ Dry run complete — nothing written.');
    return;
  }

  const added = await appendRows({
    credentialsPath: cfg.credentialsPath,
    sheetId: cfg.sheetId,
    range: cfg.range,
    rows: newRows,
  });
  console.log(`✔ Appended ${added} new lead(s) to the sheet.`);
})().catch((e) => die(e.message || String(e)));
