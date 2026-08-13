import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeLeadsToSheet } from '../src/sheets.js';
import { TOKENS_KV_KEY } from '../src/oauth.js';

const realFetch = globalThis.fetch;
const SHEET_ID = 'sheet-123';

function lead(overrides = {}) {
	return {
		message_id: 'm1',
		subject: 'Quote request',
		from: 'dana@acme.test',
		received_at: 'Mon, 10 Aug 2026 09:00:00 +0000',
		is_lead: true,
		name: 'Dana Reyes',
		email: 'dana@acme.test',
		phone: null,
		company: 'Acme',
		interest: 'Wants a quote for 200 seats',
		budget: '$40k',
		source: 'referral',
		urgency: 'high',
		lead_score: 0.9,
		notes: null,
		...overrides,
	};
}

/**
 * Stub the Sheets API and record every call.
 *
 * @param {object} options
 * @param {string[]} [options.tabs] tab titles the spreadsheet reports
 * @param {string[]} [options.headerRow] current contents of row 1
 * @param {string[]} [options.existingIds] Message IDs already in column L, top to bottom
 * @param {(op: string) => Response | undefined} [options.fail] return a Response to fail that operation
 */
function stubSheets({ tabs = ['Leads'], headerRow = [], existingIds = [], fail } = {}) {
	const calls = [];

	globalThis.fetch = async (input, init = {}) => {
		const url = input instanceof Request ? input.url : String(input);
		const body = init.body ? JSON.parse(init.body) : null;

		const record = (op) => {
			calls.push({ op, url, body });
			return fail?.(op);
		};

		if (url.includes('/values:batchGet')) {
			const failure = record('batchGet');
			if (failure) return failure;
			return Response.json({
				valueRanges: [
					headerRow.length ? { values: [headerRow] } : {},
					existingIds.length ? { values: existingIds.map((id) => [id]) } : {},
				],
			});
		}

		if (url.includes('/values:batchUpdate')) {
			const failure = record('values.batchUpdate');
			if (failure) return failure;
			return Response.json({ totalUpdatedRows: body.data.length });
		}

		if (url.includes(':append')) {
			const failure = record('append');
			if (failure) return failure;
			return Response.json({ updates: { updatedRows: body.values.length } });
		}

		if (url.includes(':batchUpdate')) {
			const failure = record('addSheet');
			if (failure) return failure;
			return Response.json({ replies: [{ addSheet: { properties: { title: 'Leads' } } }] });
		}

		if (url.includes('/values/')) {
			const failure = record('values.update');
			if (failure) return failure;
			return Response.json({ updatedCells: 12 });
		}

		// Bare spreadsheet GET — metadata.
		const failure = record('spreadsheets.get');
		if (failure) return failure;
		return Response.json({ sheets: tabs.map((title) => ({ properties: { title } })) });
	};

	return calls;
}

beforeEach(async () => {
	env.GOOGLE_SHEET_ID = SHEET_ID;
	env.GOOGLE_CLIENT_ID = 'test-client-id';
	env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

	await env.AGENT_KV.put(
		TOKENS_KV_KEY,
		JSON.stringify({
			access_token: 'valid-token',
			refresh_token: '1//refresh',
			expiry_date: Date.now() + 3_600_000,
			scope: 'gmail spreadsheets',
			token_type: 'Bearer',
		}),
	);
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await env.AGENT_KV.delete(TOKENS_KV_KEY);
});

describe('writeLeadsToSheet', () => {
	it('makes no API calls when there are no leads', async () => {
		const calls = stubSheets();
		const result = await writeLeadsToSheet(env, []);
		expect(result).toEqual({ written: 0, appended: 0, updated: 0 });
		expect(calls).toHaveLength(0);
	});

	it('throws when GOOGLE_SHEET_ID is missing', async () => {
		stubSheets();
		delete env.GOOGLE_SHEET_ID;
		await expect(writeLeadsToSheet(env, [lead()])).rejects.toThrow('GOOGLE_SHEET_ID is not set');
	});

	it('writes the header row on first run and appends the lead', async () => {
		const calls = stubSheets({ headerRow: [], existingIds: [] });

		const result = await writeLeadsToSheet(env, [lead()]);
		expect(result).toEqual({ written: 1, appended: 1, updated: 0 });

		// Header written because row 1 was empty.
		const headerWrite = calls.find((call) => call.op === 'values.update');
		expect(headerWrite.body.values[0]).toEqual([
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
		]);

		// Row is in column order, nulls flattened to empty cells, ID last.
		const append = calls.find((call) => call.op === 'append');
		expect(append.body.values).toEqual([
			[
				'Mon, 10 Aug 2026 09:00:00 +0000',
				'Dana Reyes',
				'dana@acme.test',
				'',
				'Acme',
				'Wants a quote for 200 seats',
				'$40k',
				'referral',
				'high',
				'0.9',
				'',
				'm1',
			],
		]);
		expect(append.url).toContain('insertDataOption=INSERT_ROWS');
		expect(append.url).toContain('valueInputOption=RAW');
	});

	it('updates in place instead of duplicating a known Message ID', async () => {
		// m1 sits on row 2, m2 on row 3.
		const calls = stubSheets({ headerRow: ['Received At'], existingIds: ['m1', 'm2'] });

		const result = await writeLeadsToSheet(env, [lead({ message_id: 'm2', company: 'Globex' })]);
		expect(result).toEqual({ written: 1, appended: 0, updated: 1 });

		const update = calls.find((call) => call.op === 'values.batchUpdate');
		expect(update.body.data[0].range).toBe('Leads!A3:L3');
		expect(update.body.data[0].values[0][4]).toBe('Globex');

		// Nothing appended.
		expect(calls.some((call) => call.op === 'append')).toBe(false);
	});

	it('splits a mixed batch into updates and appends', async () => {
		const calls = stubSheets({ headerRow: ['Received At'], existingIds: ['m1'] });

		const result = await writeLeadsToSheet(env, [
			lead({ message_id: 'm1' }), // exists -> update row 2
			lead({ message_id: 'm9' }), // new -> append
		]);

		expect(result).toEqual({ written: 2, appended: 1, updated: 1 });
		expect(calls.find((call) => call.op === 'values.batchUpdate').body.data).toHaveLength(1);
		expect(calls.find((call) => call.op === 'append').body.values).toHaveLength(1);
	});

	it('creates the Leads tab when the spreadsheet does not have one', async () => {
		const calls = stubSheets({ tabs: ['Sheet1'] });

		await writeLeadsToSheet(env, [lead()]);

		const addSheet = calls.find((call) => call.op === 'addSheet');
		expect(addSheet.body.requests[0].addSheet.properties.title).toBe('Leads');
	});

	it('does not overwrite a header row that was customised', async () => {
		const calls = stubSheets({ headerRow: ['When', 'Who', 'Contact'] });

		await writeLeadsToSheet(env, [lead()]);

		// Non-empty but mismatched: left alone, only the append happens.
		expect(calls.some((call) => call.op === 'values.update')).toBe(false);
		expect(calls.some((call) => call.op === 'append')).toBe(true);
	});

	it('surfaces an API failure to the caller', async () => {
		stubSheets({
			fail: (op) => (op === 'append' ? new Response('permission denied', { status: 403 }) : undefined),
		});

		await expect(writeLeadsToSheet(env, [lead()])).rejects.toThrow(/values\.append failed: HTTP 403/);
	});
});
