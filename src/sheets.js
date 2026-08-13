/**
 * Google Sheets v4 client — writes extracted leads to the "Leads" tab.
 *
 * Message ID is the natural key: a lead whose ID is already in column L updates
 * that row in place, anything else is appended. That keeps the sheet idempotent
 * even if the same message is re-processed (e.g. after clearing the
 * `processed:` keys in KV).
 *
 * Subrequest cost is flat regardless of how many leads are written:
 *   metadata (1) + batchGet (1) + optional header write (1)
 *   + at most one batchUpdate (existing rows) + one append (new rows)
 *
 * Docs: https://developers.google.com/sheets/api/reference/rest
 */

import { getValidAccessToken } from './oauth.js';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Tab the agent owns. */
const TAB = 'Leads';

/** Column headers, in order. Index here == column position in the sheet. */
const HEADERS = [
	'Received At',
	'Name',
	'Email',
	'Phone',
	'Company',
	'Interest',
	'Budget',
	'Source',
	'Urgency',
	'Lead Score',
	'Notes',
	'Message ID',
];

/** Last column letter — 12 headers => A..L. */
const LAST_COLUMN = 'L';

/** Column holding Message ID, used to find the row for an existing lead. */
const MESSAGE_ID_COLUMN = 'L';

/** Data starts on row 2; row 1 is the header. */
const FIRST_DATA_ROW = 2;

/**
 * Write leads to the spreadsheet, updating rows that already exist.
 *
 * @param {Env} env
 * @param {object[]} leads lead records as produced by /run
 * @returns {Promise<{ written: number, appended: number, updated: number }>}
 * @throws {Error} if the spreadsheet is not configured or the API rejects a call
 */
export async function writeLeadsToSheet(env, leads) {
	if (!leads?.length) {
		return { written: 0, appended: 0, updated: 0 };
	}

	const spreadsheetId = env.GOOGLE_SHEET_ID;
	if (!spreadsheetId) {
		throw new Error('GOOGLE_SHEET_ID is not set — add it to wrangler.jsonc vars (or .dev.vars for local runs).');
	}

	const accessToken = await getValidAccessToken(env);

	await ensureTabExists(accessToken, spreadsheetId);

	// One call fetches both the header row and every Message ID already present.
	const [headerRow, messageIdRows] = await batchGetValues(accessToken, spreadsheetId, [
		`${TAB}!A1:${LAST_COLUMN}1`,
		`${TAB}!${MESSAGE_ID_COLUMN}${FIRST_DATA_ROW}:${MESSAGE_ID_COLUMN}`,
	]);

	await ensureHeaderRow(accessToken, spreadsheetId, headerRow[0] ?? []);

	// Map existing Message ID -> its 1-based row number.
	const rowByMessageId = new Map();
	messageIdRows.forEach((row, index) => {
		const messageId = row[0];
		if (messageId) rowByMessageId.set(messageId, FIRST_DATA_ROW + index);
	});

	/** @type {{ range: string, values: string[][] }[]} */
	const updates = [];
	/** @type {string[][]} */
	const appends = [];

	for (const lead of leads) {
		const row = toRow(lead);
		const existingRow = rowByMessageId.get(lead.message_id);
		if (existingRow) {
			updates.push({ range: `${TAB}!A${existingRow}:${LAST_COLUMN}${existingRow}`, values: [row] });
		} else {
			appends.push(row);
		}
	}

	if (updates.length) {
		await batchUpdateValues(accessToken, spreadsheetId, updates);
		console.log(`[sheets] updated ${updates.length} existing row(s)`);
	}

	if (appends.length) {
		await appendValues(accessToken, spreadsheetId, appends);
		console.log(`[sheets] appended ${appends.length} new row(s)`);
	}

	return { written: updates.length + appends.length, appended: appends.length, updated: updates.length };
}

/**
 * Flatten a lead into a sheet row, in HEADERS order.
 *
 * Nulls become empty cells rather than the string "null", and everything is
 * written as text so Sheets does not reinterpret values like "+1 555..." or
 * "$40k" as formulas or dates.
 *
 * @param {object} lead
 * @returns {string[]}
 */
function toRow(lead) {
	return [
		lead.received_at,
		lead.name,
		lead.email,
		lead.phone,
		lead.company,
		lead.interest,
		lead.budget,
		lead.source,
		lead.urgency,
		lead.lead_score,
		lead.notes,
		lead.message_id,
	].map((value) => (value === null || value === undefined ? '' : String(value)));
}

/**
 * Create the "Leads" tab if the spreadsheet does not already have one.
 *
 * Checked via metadata rather than by catching a parse error, so a genuinely
 * different failure is not mistaken for a missing tab.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 */
async function ensureTabExists(accessToken, spreadsheetId) {
	const url = new URL(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`);
	url.search = new URLSearchParams({ fields: 'sheets.properties.title' }).toString();

	const metadata = await sheetsRequest(accessToken, url, { method: 'GET' }, 'spreadsheets.get');
	const titles = (metadata.sheets ?? []).map((sheet) => sheet.properties?.title);
	if (titles.includes(TAB)) return;

	console.log(`[sheets] tab "${TAB}" missing, creating it`);
	await sheetsRequest(
		accessToken,
		`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
		{
			method: 'POST',
			body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
		},
		'spreadsheets.batchUpdate(addSheet)',
	);
}

/**
 * Write the header row when the sheet is new.
 *
 * A non-empty but mismatched header row is left alone: the column *positions*
 * are what this module depends on, and silently overwriting labels someone
 * renamed on purpose would be destructive. The mismatch is logged so it is
 * visible in `wrangler tail`.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @param {string[]} existing current contents of row 1
 */
async function ensureHeaderRow(accessToken, spreadsheetId, existing) {
	if (existing.length === 0) {
		console.log('[sheets] writing header row');
		await updateValues(accessToken, spreadsheetId, `${TAB}!A1:${LAST_COLUMN}1`, [HEADERS]);
		return;
	}

	const matches = HEADERS.length === existing.length && HEADERS.every((header, index) => header === existing[index]);
	if (!matches) {
		console.warn(`[sheets] header row differs from the expected columns, leaving it as-is: ${JSON.stringify(existing)}`);
	}
}

/**
 * Read several ranges in one request.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @param {string[]} ranges
 * @returns {Promise<string[][][]>} one 2-D value array per requested range, in order
 */
async function batchGetValues(accessToken, spreadsheetId, ranges) {
	const url = new URL(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
	const params = new URLSearchParams({ majorDimension: 'ROWS' });
	for (const range of ranges) params.append('ranges', range);
	url.search = params.toString();

	const payload = await sheetsRequest(accessToken, url, { method: 'GET' }, 'values.batchGet');
	// Sheets omits `values` for empty ranges — normalise to [] so callers can index freely.
	return ranges.map((_, index) => payload.valueRanges?.[index]?.values ?? []);
}

/**
 * Overwrite a single range.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @param {string} range
 * @param {string[][]} values
 */
async function updateValues(accessToken, spreadsheetId, range, values) {
	const url = new URL(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
	url.search = new URLSearchParams({ valueInputOption: 'RAW' }).toString();

	await sheetsRequest(accessToken, url, { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) }, 'values.update');
}

/**
 * Overwrite several non-contiguous rows in one request.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @param {{ range: string, values: string[][] }[]} data
 */
async function batchUpdateValues(accessToken, spreadsheetId, data) {
	await sheetsRequest(
		accessToken,
		`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
		{ method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) },
		'values.batchUpdate',
	);
}

/**
 * Append rows below the existing data.
 *
 * `INSERT_ROWS` makes Sheets insert new rows rather than overwriting whatever
 * happens to sit beneath the current data block.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @param {string[][]} values
 */
async function appendValues(accessToken, spreadsheetId, values) {
	const range = `${TAB}!A1`;
	const url = new URL(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`);
	url.search = new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }).toString();

	await sheetsRequest(accessToken, url, { method: 'POST', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) }, 'values.append');
}

/**
 * Issue an authenticated Sheets API call and parse the JSON response.
 *
 * @param {string} accessToken
 * @param {string | URL} url
 * @param {RequestInit} init
 * @param {string} operation name used in error messages
 * @returns {Promise<object>}
 * @throws {Error} on any non-2xx response
 */
async function sheetsRequest(accessToken, url, init, operation) {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			...(init.body ? { 'Content-Type': 'application/json' } : {}),
		},
	});

	if (!response.ok) {
		let detail = '';
		try {
			detail = (await response.text()).slice(0, 500);
		} catch {
			// Body already consumed or unreadable — the status alone is enough.
		}
		throw new Error(`Sheets ${operation} failed: HTTP ${response.status} ${detail}`);
	}

	return await response.json().catch(() => ({}));
}
