/**
 * HTTP entry point and cron handler.
 *
 * Routes:
 *   GET /               health/landing text
 *   GET /oauth/start    begin the Google consent flow
 *   GET /oauth/callback Google redirects here with ?code=...&state=...
 *   GET /run            scan the inbox and extract leads
 *
 * /oauth/start and /run require the RUN_TOKEN secret, and refuse to serve at
 * all if it is unset. /oauth/callback is not guarded, because Google calls it;
 * its CSRF protection is the single-use `state` value instead.
 */

import { handleOAuthStart, handleOAuthCallback } from './oauth.js';
import { handleRun } from './run.js';

/** Paths that require RUN_TOKEN. */
const PROTECTED_PATHS = new Set(['/oauth/start', '/run']);

/**
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function jsonError(message, status) {
	return new Response(JSON.stringify({ error: message }, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}

/**
 * Hash a value to a hex digest.
 *
 * @param {string} value
 * @returns {Promise<string>}
 */
async function sha256Hex(value) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Check the shared secret guarding /run and /oauth/start.
 *
 * The gate fails closed. A missing RUN_TOKEN is a deployment mistake, not a
 * decision to run without auth, so it refuses the request outright rather than
 * serving it unauthenticated — /run returns extracted lead data and spends
 * Claude credits on every call, and /oauth/start lets a stranger overwrite the
 * connected Google account.
 *
 * Both sides are hashed before comparison so the comparison runs over
 * fixed-length digests. `===` on a raw secret returns as soon as it finds a
 * differing byte, which leaks the token a character at a time; digests are not
 * invertible, so the same leak reveals nothing usable.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response | null>} a response to send, or null when authorized
 */
async function checkAuthorization(request, env) {
	if (!env.RUN_TOKEN) {
		console.error('[worker] RUN_TOKEN is not configured — refusing to serve a protected endpoint');
		return jsonError('RUN_TOKEN is not configured on this Worker. Set it with: npx wrangler secret put RUN_TOKEN', 500);
	}

	// The query parameter exists so the flow can be started from a browser; it
	// lands in access logs and browser history, so prefer the header where the
	// caller controls it (cron, scripts).
	const url = new URL(request.url);
	const token = request.headers.get('x-run-token') ?? url.searchParams.get('token');
	if (!token) return jsonError('Unauthorized', 401);

	const [supplied, expected] = await Promise.all([sha256Hex(token), sha256Hex(env.RUN_TOKEN)]);
	return supplied === expected ? null : jsonError('Unauthorized', 401);
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function route(request, env) {
	const url = new URL(request.url);

	if (request.method !== 'GET') {
		return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
	}

	if (PROTECTED_PATHS.has(url.pathname)) {
		const refusal = await checkAuthorization(request, env);
		if (refusal) return refusal;
	}

	switch (url.pathname) {
		case '/oauth/start':
			return handleOAuthStart(request, env);

		case '/oauth/callback':
			return handleOAuthCallback(request, env);

		case '/run':
			return handleRun(env);

		case '/':
			return new Response('Gmail Sheets Agent. Visit /oauth/start to connect a Google account.', {
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			});

		default:
			return new Response('Not Found', { status: 404 });
	}
}

export default {
	/**
	 * @param {Request} request
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			// `await` rather than returning the promise directly: a rejection has to
			// settle inside this try block for the catch to see it.
			return await route(request, env);
		} catch (error) {
			// The message may name internal state or credentials, so it goes to the
			// log (`wrangler tail`) rather than to the caller.
			console.error('[worker] unhandled error:', error?.stack ?? error);
			return jsonError('Internal Server Error', 500);
		}
	},

	/**
	 * Cron trigger — same pipeline as GET /run.
	 *
	 * There is no caller to return a Response to, so the outcome is logged
	 * instead. Lead fields are deliberately not logged: they are personal data
	 * and the spreadsheet is where they belong.
	 *
	 * @param {ScheduledController} controller
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 */
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(
			handleRun(env)
				.then(async (response) => {
					const body = await response.json().catch(() => ({}));
					if (response.status !== 200) {
						console.error(`[cron] run failed (HTTP ${response.status}): ${body.error ?? 'unknown error'}`);
						return;
					}
					console.log(
						`[cron] processed ${body.processed}, skipped ${body.skipped}, leads ${body.new_leads?.length ?? 0}, ` +
							`written ${body.written_to_sheet}${body.sheet_error ? `, sheet error: ${body.sheet_error}` : ''}`,
					);
				})
				.catch((error) => {
					console.error('[cron] run threw:', error?.stack ?? error);
				}),
		);
	},
};
