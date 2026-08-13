import { describe, it, expect, afterEach } from 'vitest';
import { listInboxMessageIds, getMessage, extractMessageContent } from '../src/gmail.js';

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Base64url-encode a UTF-8 string the way Gmail does (no padding). */
function toBase64Url(text) {
	const bytes = new TextEncoder().encode(text);
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('extractMessageContent', () => {
	it('reads headers case-insensitively', async () => {
		const content = extractMessageContent({
			payload: {
				mimeType: 'text/plain',
				headers: [
					{ name: 'SUBJECT', value: 'Quote request' },
					{ name: 'from', value: 'dana@acme.test' },
					{ name: 'DaTe', value: 'Mon, 10 Aug 2026 09:00:00 +0000' },
				],
				body: { data: toBase64Url('Hello') },
			},
		});

		expect(content).toEqual({
			subject: 'Quote request',
			from: 'dana@acme.test',
			date: 'Mon, 10 Aug 2026 09:00:00 +0000',
			body: 'Hello',
		});
	});

	it('falls back to placeholders when headers are absent', () => {
		const content = extractMessageContent({ payload: { headers: [] } });

		expect(content.subject).toBe('(no subject)');
		expect(content.from).toBe('(unknown sender)');
		expect(content.date).toBe('');
		expect(content.body).toBe('');
	});

	it('survives a message with no payload at all', () => {
		expect(extractMessageContent({}).body).toBe('');
	});

	it('prefers a nested text/plain part over the HTML alternative', () => {
		const content = extractMessageContent({
			payload: {
				mimeType: 'multipart/mixed',
				headers: [],
				parts: [
					{
						mimeType: 'multipart/alternative',
						parts: [
							{ mimeType: 'text/html', body: { data: toBase64Url('<p>html version</p>') } },
							{ mimeType: 'text/plain', body: { data: toBase64Url('plain version') } },
						],
					},
				],
			},
		});

		expect(content.body).toBe('plain version');
	});

	it('strips markup when only an HTML part exists', () => {
		const html = '<html><head><style>p { color: red }</style></head><body><p>We need&nbsp;200 seats &amp; a quote.</p><script>evil()</script></body></html>';
		const content = extractMessageContent({
			payload: {
				mimeType: 'multipart/alternative',
				headers: [],
				parts: [{ mimeType: 'text/html', body: { data: toBase64Url(html) } }],
			},
		});

		// Tags, <script>, and <style> contents are gone; entities are decoded.
		expect(content.body).toBe('We need 200 seats & a quote.');
	});

	it('decodes non-ASCII bodies as UTF-8', () => {
		// atob() alone yields a binary string, which mangles anything outside Latin-1.
		const text = 'Café — 200 seats “urgent” 🚀';
		const content = extractMessageContent({
			payload: { mimeType: 'text/plain', headers: [], body: { data: toBase64Url(text) } },
		});

		expect(content.body).toBe(text);
	});

	it('truncates very long bodies', () => {
		const content = extractMessageContent({
			payload: { mimeType: 'text/plain', headers: [], body: { data: toBase64Url('x'.repeat(13_000)) } },
		});

		expect(content.body).toHaveLength(12_000);
	});
});

describe('listInboxMessageIds', () => {
	it('requests the inbox with the caller token and returns the ids', async () => {
		let seen;
		globalThis.fetch = async (input, init) => {
			seen = { url: new URL(input instanceof Request ? input.url : String(input)), init };
			return Response.json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
		};

		const ids = await listInboxMessageIds('token-123', 20);

		expect(ids).toEqual(['m1', 'm2']);
		expect(seen.url.origin + seen.url.pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages');
		expect(seen.url.searchParams.get('maxResults')).toBe('20');
		expect(seen.url.searchParams.get('q')).toBe('in:inbox');
		expect(seen.init.headers.Authorization).toBe('Bearer token-123');
	});

	it('returns an empty list when Gmail omits `messages`', async () => {
		globalThis.fetch = async () => Response.json({ resultSizeEstimate: 0 });

		expect(await listInboxMessageIds('token-123', 20)).toEqual([]);
	});

	it('throws with the status and body on a failure', async () => {
		globalThis.fetch = async () => new Response('insufficient permissions', { status: 403 });

		await expect(listInboxMessageIds('token-123', 20)).rejects.toThrow(/messages\.list failed: HTTP 403 insufficient permissions/);
	});
});

describe('getMessage', () => {
	it('fetches the full message and URL-encodes the id', async () => {
		let seen;
		globalThis.fetch = async (input) => {
			seen = new URL(input instanceof Request ? input.url : String(input));
			return Response.json({ id: 'a/b' });
		};

		const message = await getMessage('token-123', 'a/b');

		expect(message).toEqual({ id: 'a/b' });
		expect(seen.pathname).toBe('/gmail/v1/users/me/messages/a%2Fb');
		expect(seen.searchParams.get('format')).toBe('full');
	});

	it('names the failing message in the error', async () => {
		globalThis.fetch = async () => new Response('not found', { status: 404 });

		await expect(getMessage('token-123', 'm9')).rejects.toThrow(/messages\.get failed for m9: HTTP 404/);
	});
});
