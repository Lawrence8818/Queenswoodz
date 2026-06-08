/**
 * Google Sheets reader (service-account auth, zero dependencies).
 * ---------------------------------------------------------------
 * Reads a private sheet via the Sheets API v4 using a service-account JWT,
 * so lead PII never has to be "published to the web". Signs RS256 with native
 * node:crypto, exchanges the JWT for an access token, then pulls the values.
 *
 * Setup (one time):
 *   1. Google Cloud Console → create a project → enable "Google Sheets API".
 *   2. Create a Service Account → add a JSON key → download it.
 *   3. Share your lead sheet with the service account's `client_email`
 *      (Viewer is enough).
 *   4. Point GOOGLE_SERVICE_ACCOUNT_JSON at the downloaded file, set SHEET_ID
 *      and SHEET_RANGE in .env.
 *
 * Returns: array of record objects keyed by the header row, matching the CSV
 * column names used by send-lead-events.mjs (lead_id, email, phone, ...).
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = b64url(createSign('RSA-SHA256').update(signingInput).sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${json.error} ${json.error_description || ''}`);
  return json.access_token;
}

/**
 * @param {object} opts
 * @param {string} opts.credentialsPath  path to the service-account JSON key
 * @param {string} opts.sheetId          spreadsheet id (from its URL)
 * @param {string} opts.range            A1 range, e.g. "Leads!A:I"
 * @returns {Promise<Array<Record<string,string>>>}
 */
export async function readSheet({ credentialsPath, sheetId, range }) {
  if (!credentialsPath) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  if (!sheetId) throw new Error('SHEET_ID is not set.');
  const sa = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  const token = await getAccessToken(sa);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}` +
    `/values/${encodeURIComponent(range || 'A:Z')}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${json.error?.message || JSON.stringify(json)}`);

  const rows = json.values || [];
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? '').trim()])));
}
