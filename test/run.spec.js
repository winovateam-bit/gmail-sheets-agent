import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../src';
import { TOKENS_KV_KEY } from '../src/oauth.js';

const realFetch = globalThis.fetch;

/** Base64url-encode a UTF-8 string the way Gmail does (no padding). */
function toBase64Url(text) {
	const bytes = new TextEncoder().encode(text);
	const binary = String.fromCharCode(...bytes);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A Gmail message resource with a text/plain part. */
function gmailMessage(id, { subject, from, body }) {
	return {
		id,
		payload: {
			mimeType: 'multipart/alternative',
			headers: [
				{ name: 'Subject', value: subject },
				{ name: 'From', value: from },
				{ name: 'Date', value: 'Mon, 10 Aug 2026 09:00:00 +0000' },
			],
			parts: [{ mimeType: 'text/plain', body: { data: toBase64Url(body) } }],
		},
	};
}

/** A Claude Messages API response carrying `lead` as its JSON text block. */
function claudeResponse(lead) {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-4-5-20251001',
		content: [{ type: 'text', text: JSON.stringify(lead) }],
		stop_reason: 'end_turn',
		usage: { input_tokens: 100, output_tokens: 50 },
	};
}

const LEAD = {
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
};

const NOT_A_LEAD = {
	is_lead: false,
	name: null,
	email: null,
	phone: null,
	company: null,
	interest: '',
	budget: null,
	source: null,
	urgency: null,
	lead_score: 0,
	notes: 'Marketing newsletter',
};

/**
 * Stub Gmail + Claude. `messages` maps message id -> Gmail resource;
 * `classify` maps message id -> the lead JSON Claude should return.
 */
function stubUpstream({ messages, classify, onTokenRefresh, sheetsFail = false }) {
	globalThis.fetch = async (input, init) => {
		// fetch() is called with strings, URL objects, and Requests — normalise all three.
		const url = input instanceof Request ? input.url : String(input);

		// Sheets is exercised properly in sheets.spec.js; here it just needs to
		// succeed (or fail) so /run's own wiring can be asserted.
		if (url.startsWith('https://sheets.googleapis.com/')) {
			if (sheetsFail) return new Response('permission denied', { status: 403 });
			if (url.includes('/values:batchGet')) return Response.json({ valueRanges: [{}, {}] });
			if (url.includes(':append')) return Response.json({ updates: { updatedRows: 1 } });
			if (url.includes('/values:batchUpdate')) return Response.json({ totalUpdatedRows: 1 });
			if (url.includes(':batchUpdate')) return Response.json({ replies: [] });
			if (url.includes('/values/')) return Response.json({ updatedCells: 12 });
			return Response.json({ sheets: [{ properties: { title: 'Leads' } }] });
		}

		if (url.startsWith('https://oauth2.googleapis.com/token')) {
			onTokenRefresh?.(new URLSearchParams(init.body));
			return Response.json({ access_token: 'refreshed-token', expires_in: 3599, token_type: 'Bearer' });
		}

		if (url.includes('/gmail/v1/users/me/messages?')) {
			return Response.json({ messages: Object.keys(messages).map((id) => ({ id })) });
		}

		const detail = url.match(/\/messages\/([^?]+)/);
		if (detail) {
			const message = messages[decodeURIComponent(detail[1])];
			if (!message) return new Response('not found', { status: 404 });
			return Response.json(message);
		}

		if (url === 'https://api.anthropic.com/v1/messages') {
			const body = JSON.parse(init.body);
			// Identify the message from the prompt so each can be classified differently.
			const id = Object.keys(messages).find((key) => body.messages[0].content.includes(messages[key].payload.headers[0].value));
			return Response.json(claudeResponse(classify[id]));
		}

		throw new Error(`unexpected fetch to ${url}`);
	};
}

const RUN_TOKEN = 'test-run-token';

async function run() {
	const request = new Request('http://localhost:8787/run', { headers: { 'x-run-token': RUN_TOKEN } });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeEach(async () => {
	env.GOOGLE_CLIENT_ID = 'test-client-id';
	env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
	env.ANTHROPIC_API_KEY = 'sk-ant-test';
	env.GOOGLE_SHEET_ID = 'sheet-123';

	// /run refuses to serve without this; pin it rather than inheriting whatever
	// a local (gitignored) .dev.vars defines. The gate itself is covered in
	// index.spec.js — run() below always authenticates.
	env.RUN_TOKEN = RUN_TOKEN;

	// Clear state left by other tests in this isolate.
	await env.AGENT_KV.delete(TOKENS_KV_KEY);
	for (const key of ['processed:m1', 'processed:m2', 'processed:m3']) {
		await env.AGENT_KV.delete(key);
	}
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Store credentials that are valid for another hour. */
async function storeFreshTokens() {
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
}

describe('GET /run', () => {
	it('502s when no tokens are stored', async () => {
		const response = await run();
		expect(response.status).toBe(502);
		const body = await response.json();
		expect(body.error).toContain('/oauth/start');
		expect(body.processed).toBe(0);
		expect(body.new_leads).toEqual([]);
	});

	it('extracts leads and marks every message processed', async () => {
		await storeFreshTokens();
		stubUpstream({
			messages: {
				m1: gmailMessage('m1', { subject: 'Quote request', from: 'dana@acme.test', body: 'We need 200 seats.' }),
				m2: gmailMessage('m2', { subject: 'Weekly digest', from: 'news@example.test', body: 'Top stories.' }),
			},
			classify: { m1: LEAD, m2: NOT_A_LEAD },
		});

		const response = await run();
		expect(response.status).toBe(200);

		const body = await response.json();
		// Both were processed; only the genuine inquiry is reported as a lead.
		expect(body.processed).toBe(2);
		expect(body.new_leads).toHaveLength(1);
		expect(body.new_leads[0]).toMatchObject({
			message_id: 'm1',
			subject: 'Quote request',
			company: 'Acme',
			lead_score: 0.9,
		});

		// Non-leads are still marked so they aren't re-examined next run.
		expect(await env.AGENT_KV.get('processed:m1')).toBe('1');
		expect(await env.AGENT_KV.get('processed:m2')).toBe('1');

		// The lead reached the spreadsheet; the non-lead did not.
		expect(body.written_to_sheet).toBe(1);
		expect(body.sheet_error).toBeUndefined();
	});

	it('still returns leads when the Sheets write fails', async () => {
		await storeFreshTokens();
		stubUpstream({
			messages: { m1: gmailMessage('m1', { subject: 'Quote request', from: 'dana@acme.test', body: 'We need 200 seats.' }) },
			classify: { m1: LEAD },
			sheetsFail: true,
		});

		const response = await run();
		// A spreadsheet problem must not discard work already paid for.
		expect(response.status).toBe(200);

		const body = await response.json();
		expect(body.new_leads).toHaveLength(1);
		expect(body.written_to_sheet).toBe(0);
		expect(body.sheet_error).toContain('403');
	});

	it('skips messages already in KV', async () => {
		await storeFreshTokens();
		await env.AGENT_KV.put('processed:m1', '1');
		stubUpstream({
			messages: { m1: gmailMessage('m1', { subject: 'Quote request', from: 'dana@acme.test', body: 'Hi' }) },
			classify: { m1: LEAD },
		});

		const body = await (await run()).json();
		expect(body.processed).toBe(0);
		expect(body.skipped).toBe(1);
		expect(body.new_leads).toEqual([]);
	});

	it('refreshes an expired access token before calling Gmail', async () => {
		await env.AGENT_KV.put(
			TOKENS_KV_KEY,
			JSON.stringify({
				access_token: 'stale-token',
				refresh_token: '1//refresh',
				expiry_date: Date.now() - 1000, // already expired
				scope: 'gmail spreadsheets',
				token_type: 'Bearer',
			}),
		);

		let refreshBody = null;
		stubUpstream({
			messages: { m1: gmailMessage('m1', { subject: 'Quote request', from: 'dana@acme.test', body: 'Hi' }) },
			classify: { m1: LEAD },
			onTokenRefresh: (params) => {
				refreshBody = params;
			},
		});

		const body = await (await run()).json();
		expect(refreshBody?.get('grant_type')).toBe('refresh_token');
		expect(refreshBody?.get('refresh_token')).toBe('1//refresh');
		expect(body.new_leads).toHaveLength(1);

		// The refreshed token is written back, keeping the existing refresh_token.
		const stored = await env.AGENT_KV.get(TOKENS_KV_KEY, 'json');
		expect(stored.access_token).toBe('refreshed-token');
		expect(stored.refresh_token).toBe('1//refresh');
		expect(stored.expiry_date).toBeGreaterThan(Date.now());
	});

	it('keeps going when one message fails', async () => {
		await storeFreshTokens();
		const messages = {
			m1: gmailMessage('m1', { subject: 'Quote request', from: 'dana@acme.test', body: 'Hi' }),
			m2: gmailMessage('m2', { subject: 'Broken', from: 'x@example.test', body: 'Hi' }),
		};
		stubUpstream({ messages, classify: { m1: LEAD, m2: NOT_A_LEAD } });

		// Make only m2's Claude call fail.
		const stubbed = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			// fetch() is called with strings, URL objects, and Requests — normalise all three.
		const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.anthropic.com/v1/messages' && init.body.includes('Broken')) {
				return Response.json({ type: 'error', error: { type: 'api_error', message: 'boom' } }, { status: 500 });
			}
			return stubbed(input, init);
		};

		const body = await (await run()).json();
		// m1 still produced a lead despite m2 blowing up.
		expect(body.new_leads).toHaveLength(1);
		expect(body.processed).toBe(1);
		expect(body.failed).toHaveLength(1);
		expect(body.failed[0].messageId).toBe('m2');

		// The failed message is NOT marked processed, so the next run retries it.
		expect(await env.AGENT_KV.get('processed:m2')).toBeNull();
	});

	it('reports an empty run when the inbox has no matches', async () => {
		await storeFreshTokens();
		stubUpstream({ messages: {}, classify: {} });

		const body = await (await run()).json();
		expect(body).toMatchObject({ processed: 0, new_leads: [], skipped: 0 });
	});
});
