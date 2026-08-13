/**
 * Minimal Gmail API client — list inbox messages, fetch one, and pull out the
 * fields the lead extractor cares about.
 *
 * Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Longest plaintext body we hand to Claude. Long forwarded threads and
 * newsletters add cost and latency without improving the extraction, and the
 * lead details are essentially always near the top.
 */
const MAX_BODY_CHARS = 12_000;

/**
 * List the most recent inbox message IDs, newest first.
 *
 * @param {string} accessToken
 * @param {number} maxResults
 * @returns {Promise<string[]>} message IDs (empty if the inbox has no matches)
 */
export async function listInboxMessageIds(accessToken, maxResults) {
	const url = new URL(`${GMAIL_API_BASE}/messages`);
	url.search = new URLSearchParams({ maxResults: String(maxResults), q: 'in:inbox' }).toString();

	const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!response.ok) {
		throw new Error(`Gmail messages.list failed: HTTP ${response.status} ${await safeErrorText(response)}`);
	}

	const payload = await response.json();
	// Gmail omits `messages` entirely when nothing matches the query.
	return (payload.messages ?? []).map((message) => message.id);
}

/**
 * Fetch one message in full (headers + body payload).
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @returns {Promise<object>} the raw Gmail message resource
 */
export async function getMessage(accessToken, messageId) {
	const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`);
	url.search = new URLSearchParams({ format: 'full' }).toString();

	const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!response.ok) {
		throw new Error(`Gmail messages.get failed for ${messageId}: HTTP ${response.status} ${await safeErrorText(response)}`);
	}

	return await response.json();
}

/**
 * Pull the subject, sender, date, and plaintext body out of a Gmail message.
 *
 * @param {object} message a message resource from {@link getMessage}
 * @returns {{ subject: string, from: string, date: string, body: string }}
 */
export function extractMessageContent(message) {
	const headers = message.payload?.headers ?? [];

	return {
		subject: findHeader(headers, 'Subject') ?? '(no subject)',
		from: findHeader(headers, 'From') ?? '(unknown sender)',
		date: findHeader(headers, 'Date') ?? '',
		body: extractPlainTextBody(message.payload).slice(0, MAX_BODY_CHARS),
	};
}

/**
 * Look up a header by name. Gmail's header casing is not guaranteed, so match
 * case-insensitively.
 *
 * @param {Array<{ name: string, value: string }>} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function findHeader(headers, name) {
	const target = name.toLowerCase();
	return headers.find((header) => header.name?.toLowerCase() === target)?.value;
}

/**
 * Walk a message payload and return the best available plaintext body.
 *
 * Preference order:
 *   1. the first `text/plain` part anywhere in the MIME tree
 *   2. the top-level `payload.body.data` (single-part messages)
 *   3. the first `text/html` part with tags stripped — many senders ship
 *      HTML-only mail, and without this those messages reach Claude empty
 *
 * @param {object | undefined} payload
 * @returns {string} decoded body, or '' when nothing usable was found
 */
function extractPlainTextBody(payload) {
	if (!payload) return '';

	const plain = findPartByMimeType(payload, 'text/plain');
	if (plain?.body?.data) return decodeBase64Url(plain.body.data);

	// Single-part message: the body hangs directly off the payload.
	if (payload.body?.data) return decodeBase64Url(payload.body.data);

	const html = findPartByMimeType(payload, 'text/html');
	if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

	return '';
}

/**
 * Depth-first search of the MIME tree for the first part with a given type.
 * Parts nest arbitrarily (multipart/mixed wrapping multipart/alternative, etc.).
 *
 * @param {object} part
 * @param {string} mimeType
 * @returns {object | null}
 */
function findPartByMimeType(part, mimeType) {
	if (part.mimeType === mimeType && part.body?.data) return part;

	for (const child of part.parts ?? []) {
		const match = findPartByMimeType(child, mimeType);
		if (match) return match;
	}

	return null;
}

/**
 * Decode Gmail's base64url payloads into a UTF-8 string.
 *
 * `atob` yields a binary string, so the bytes have to be re-decoded as UTF-8 or
 * any non-ASCII character (curly quotes, accents, emoji) comes out mangled.
 *
 * @param {string} data base64url-encoded, usually without padding
 * @returns {string}
 */
function decodeBase64Url(data) {
	const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * Crude HTML-to-text for the HTML-only fallback above. Claude tolerates rough
 * text fine — this only needs to drop markup and scripts, not render properly.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
	return html
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Read an error body without letting a malformed response mask the real failure.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function safeErrorText(response) {
	try {
		return (await response.text()).slice(0, 500);
	} catch {
		return '';
	}
}
