/**
 * Google OAuth 2.0 authorization-code flow for the Gmail Sheets Agent.
 *
 * Flow:
 *   1. GET /oauth/start    -> 302 to Google's consent screen
 *   2. user grants access  -> Google redirects back with ?code=...&state=...
 *   3. GET /oauth/callback -> exchanges the code for tokens, saves them in KV
 *
 * Tokens live in the AGENT_KV binding under the key `google_tokens` as JSON:
 *   { access_token, refresh_token, expiry_date, scope, token_type }
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** KV key holding the current Google credentials. */
export const TOKENS_KV_KEY = 'google_tokens';

/** KV key prefix for short-lived CSRF `state` values. */
const STATE_KV_PREFIX = 'oauth_state:';

/** How long (seconds) a pending `state` stays valid. Google's consent screen rarely takes longer. */
const STATE_TTL_SECONDS = 600;

/** Scopes the agent needs: read mail, read/write spreadsheets. */
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/spreadsheets'];

/**
 * Assumed lifetime (seconds) when Google omits `expires_in`.
 *
 * It is always present in practice, but a missing value would make the computed
 * expiry NaN, and every later comparison against it false — so the token would
 * be treated as valid forever. One hour is Google's standard lifetime.
 */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Resolve the redirect URI registered with Google.
 *
 * Defaults to `<current origin>/oauth/callback`, which yields
 * http://localhost:8787/oauth/callback under `wrangler dev` and the real
 * workers.dev / custom-domain URL once deployed. Set the OAUTH_REDIRECT_URI
 * var in wrangler.jsonc to pin it explicitly (e.g. when running behind a proxy).
 *
 * Whatever this returns must be listed verbatim as an "Authorized redirect URI"
 * on the OAuth client in the Google Cloud console.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {string}
 */
function getRedirectUri(request, env) {
	if (env.OAUTH_REDIRECT_URI) return env.OAUTH_REDIRECT_URI;
	return new URL('/oauth/callback', new URL(request.url).origin).toString();
}

/**
 * Generate an unguessable `state` value to tie the callback back to this browser.
 * @returns {string} 32 hex characters
 */
function generateState() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * GET /oauth/start — send the user to Google's consent screen.
 *
 * `access_type=offline` + `prompt=consent` guarantee a refresh_token comes back,
 * even if this Google account has already authorized the app before.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
export async function handleOAuthStart(request, env) {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return htmlResponse(
			renderPage({
				ok: false,
				title: 'Configuration error',
				message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.',
				detail: 'Set them with: npx wrangler secret put GOOGLE_CLIENT_ID',
			}),
			500,
		);
	}

	// Remember the state so /oauth/callback can verify the response is ours.
	const state = generateState();
	await env.AGENT_KV.put(STATE_KV_PREFIX + state, '1', { expirationTtl: STATE_TTL_SECONDS });

	const authUrl = new URL(GOOGLE_AUTH_URL);
	authUrl.search = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: getRedirectUri(request, env),
		response_type: 'code',
		scope: SCOPES.join(' '),
		access_type: 'offline', // issue a refresh_token
		prompt: 'consent', // force the consent screen so the refresh_token is re-issued
		include_granted_scopes: 'true',
		state,
	}).toString();

	return Response.redirect(authUrl.toString(), 302);
}

/**
 * GET /oauth/callback — exchange the authorization code for tokens and store them.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
export async function handleOAuthCallback(request, env) {
	const params = new URL(request.url).searchParams;

	// The user denied consent, or Google rejected the request outright.
	const oauthError = params.get('error');
	if (oauthError) {
		return htmlResponse(
			renderPage({
				ok: false,
				title: 'Authorization declined',
				message: 'Google did not grant access.',
				detail: `error=${oauthError}`,
			}),
			400,
		);
	}

	const code = params.get('code');
	const state = params.get('state');
	if (!code || !state) {
		return htmlResponse(
			renderPage({
				ok: false,
				title: 'Invalid callback',
				message: 'Missing `code` or `state` query parameter.',
				detail: 'Start over at /oauth/start.',
			}),
			400,
		);
	}

	// CSRF check: the state must be one we issued (and not already spent).
	const knownState = await env.AGENT_KV.get(STATE_KV_PREFIX + state);
	if (knownState === null) {
		return htmlResponse(
			renderPage({
				ok: false,
				title: 'Invalid or expired state',
				message: 'This callback did not match a pending authorization request.',
				detail: 'Start over at /oauth/start.',
			}),
			400,
		);
	}
	// Single-use: burn it so the code cannot be replayed.
	await env.AGENT_KV.delete(STATE_KV_PREFIX + state);

	// Exchange the one-time code for an access/refresh token pair.
	const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: getRedirectUri(request, env), // must match the value sent to /oauth/start
			grant_type: 'authorization_code',
		}).toString(),
	});

	const payload = await tokenResponse.json().catch(() => null);

	if (!tokenResponse.ok || !payload?.access_token) {
		// Google returns { error, error_description } on failure.
		const detail = payload?.error ? `${payload.error}: ${payload.error_description ?? ''}` : `HTTP ${tokenResponse.status}`;
		return htmlResponse(
			renderPage({
				ok: false,
				title: 'Token exchange failed',
				message: 'Google rejected the authorization code.',
				detail,
			}),
			502,
		);
	}

	// Google omits refresh_token when it has already issued one for this client+user.
	// prompt=consent should prevent that, but keep any token we already hold just in case.
	let refreshToken = payload.refresh_token ?? null;
	if (!refreshToken) {
		const existing = await getStoredTokens(env);
		refreshToken = existing?.refresh_token ?? null;
	}

	/** Absolute expiry (ms since epoch) so callers can compare against Date.now(). */
	const expiryDate = Date.now() + (payload.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;

	// A user can untick individual scopes on the consent screen. Without this the
	// run fails much later with an opaque 403 from Gmail or Sheets.
	const grantedScopes = (payload.scope ?? '').split(' ').filter(Boolean);
	const missingScopes = SCOPES.filter((scope) => !grantedScopes.includes(scope));
	if (missingScopes.length) {
		console.warn(`[oauth] consent granted without required scope(s): ${missingScopes.join(', ')}`);
	}

	await env.AGENT_KV.put(
		TOKENS_KV_KEY,
		JSON.stringify({
			access_token: payload.access_token,
			refresh_token: refreshToken,
			expiry_date: expiryDate,
			scope: payload.scope ?? SCOPES.join(' '),
			token_type: payload.token_type ?? 'Bearer',
		}),
	);

	return htmlResponse(
		renderPage({
			ok: true,
			title: 'Connected to Google',
			message: missingScopes.length
				? `Tokens saved, but these scopes were not granted: ${missingScopes.join(', ')}. Re-run /oauth/start and accept every permission, or the run will fail with a 403.`
				: refreshToken
					? 'Tokens saved. The agent can now read Gmail and write Sheets.'
					: 'Access token saved, but Google did not return a refresh token — the agent will lose access when it expires. Revoke the app at myaccount.google.com/permissions and try again.',
			detail: `Stored in AGENT_KV under "${TOKENS_KV_KEY}". Access token expires ${new Date(expiryDate).toISOString()}.`,
		}),
	);
}

/**
 * Read the stored credentials out of KV.
 *
 * @param {Env} env
 * @returns {Promise<{ access_token: string, refresh_token: string | null, expiry_date: number, scope: string, token_type: string } | null>}
 */
export async function getStoredTokens(env) {
	return await env.AGENT_KV.get(TOKENS_KV_KEY, 'json');
}

/** Refresh this many ms before the token actually expires, to absorb clock skew and request latency. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Return a usable Google access token, refreshing it first if it has expired.
 *
 * Refreshed credentials are written back to KV under the same key, so the next
 * run picks up the new token rather than refreshing again.
 *
 * @param {Env} env
 * @returns {Promise<string>} a valid access token
 * @throws {Error} if no tokens are stored, or the refresh is rejected
 */
export async function getValidAccessToken(env) {
	const tokens = await getStoredTokens(env);
	if (!tokens?.access_token) {
		throw new Error('No Google tokens in KV — visit /oauth/start to connect an account.');
	}

	// Still valid: use it as-is.
	if (typeof tokens.expiry_date === 'number' && Date.now() < tokens.expiry_date - EXPIRY_SKEW_MS) {
		return tokens.access_token;
	}

	if (!tokens.refresh_token) {
		throw new Error('Google access token expired and no refresh_token is stored — re-run /oauth/start.');
	}

	console.log('[oauth] access token expired, refreshing');

	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token: tokens.refresh_token,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			grant_type: 'refresh_token',
		}).toString(),
	});

	const payload = await response.json().catch(() => null);
	if (!response.ok || !payload?.access_token) {
		const detail = payload?.error ? `${payload.error}: ${payload.error_description ?? ''}` : `HTTP ${response.status}`;
		// invalid_grant means the refresh token was revoked or expired — only a fresh consent fixes it.
		throw new Error(`Google refused the token refresh (${detail}). Re-run /oauth/start if this persists.`);
	}

	// A refresh response does not include a new refresh_token — carry the existing one forward.
	const refreshed = {
		access_token: payload.access_token,
		refresh_token: payload.refresh_token ?? tokens.refresh_token,
		expiry_date: Date.now() + (payload.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
		scope: payload.scope ?? tokens.scope,
		token_type: payload.token_type ?? tokens.token_type ?? 'Bearer',
	};

	await env.AGENT_KV.put(TOKENS_KV_KEY, JSON.stringify(refreshed));
	console.log('[oauth] token refreshed, expires', new Date(refreshed.expiry_date).toISOString());

	return refreshed.access_token;
}

/**
 * Escape text for safe interpolation into HTML.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
	);
}

/**
 * Render the minimal success/failure page shown after the callback.
 *
 * @param {{ ok: boolean, title: string, message: string, detail?: string }} result
 * @returns {string} HTML document
 */
function renderPage({ ok, title, message, detail }) {
	const accent = ok ? '#1a7f37' : '#b3261e';
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(title)}</title>
	<style>
		body { font-family: system-ui, -apple-system, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f8fa; color: #1f2328; }
		main { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; padding: 2rem 2.5rem; max-width: 32rem; }
		h1 { margin: 0 0 .5rem; font-size: 1.25rem; color: ${accent}; }
		p { margin: 0 0 .75rem; line-height: 1.5; }
		code { background: #f6f8fa; border-radius: 4px; padding: .1rem .3rem; font-size: .85em; }
	</style>
</head>
<body>
	<main>
		<h1>${ok ? '&#10003;' : '&#10007;'} ${escapeHtml(title)}</h1>
		<p>${escapeHtml(message)}</p>
		${detail ? `<p><code>${escapeHtml(detail)}</code></p>` : ''}
	</main>
</body>
</html>
`;
}

/**
 * @param {string} html
 * @param {number} [status]
 * @returns {Response}
 */
function htmlResponse(html, status = 200) {
	return new Response(html, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}
