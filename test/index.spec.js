import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src';
import { TOKENS_KV_KEY } from '../src/oauth.js';

beforeAll(() => {
	// The real values live in Wrangler secrets; tests only need them to be present.
	env.GOOGLE_CLIENT_ID = 'test-client-id';
	env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
});

beforeEach(() => {
	// `.dev.vars` may define RUN_TOKEN locally, and the gate tests set it
	// themselves — clear it so no test depends on a gitignored file.
	delete env.RUN_TOKEN;
});

/** Run a GET through the worker without following redirects. */
async function get(path, init) {
	const request = new Request(`http://localhost:8787${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe('GET /oauth/start', () => {
	it('redirects to Google with the right scopes and offline access', async () => {
		const response = await get('/oauth/start');
		expect(response.status).toBe(302);

		const location = new URL(response.headers.get('location'));
		expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(location.searchParams.get('client_id')).toBe('test-client-id');
		expect(location.searchParams.get('response_type')).toBe('code');
		expect(location.searchParams.get('access_type')).toBe('offline');
		expect(location.searchParams.get('prompt')).toBe('consent');
		expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:8787/oauth/callback');
		expect(location.searchParams.get('scope')).toBe(
			'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets',
		);
	});

	it('stores the state so the callback can verify it', async () => {
		const response = await get('/oauth/start');
		const state = new URL(response.headers.get('location')).searchParams.get('state');
		expect(state).toMatch(/^[0-9a-f]{32}$/);
		expect(await env.AGENT_KV.get(`oauth_state:${state}`)).toBe('1');
	});
});

describe('GET /oauth/callback', () => {
	it('rejects a callback with an unknown state', async () => {
		const response = await get('/oauth/callback?code=abc&state=not-a-real-state');
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid or expired state');
	});

	it('reports a denied consent screen', async () => {
		const response = await get('/oauth/callback?error=access_denied&state=x');
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Authorization declined');
	});

	it('rejects a callback missing the code', async () => {
		const response = await get('/oauth/callback?state=x');
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid callback');
	});

	it('exchanges the code and stores tokens in KV', async () => {
		// Issue a real state, then stub Google's token endpoint for the exchange.
		const startResponse = await get('/oauth/start');
		const state = new URL(startResponse.headers.get('location')).searchParams.get('state');

		const realFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url === 'https://oauth2.googleapis.com/token') {
				const body = new URLSearchParams(init.body);
				expect(body.get('grant_type')).toBe('authorization_code');
				expect(body.get('code')).toBe('the-code');
				expect(body.get('client_secret')).toBe('test-client-secret');
				expect(body.get('redirect_uri')).toBe('http://localhost:8787/oauth/callback');
				return Response.json({
					access_token: 'ya29.access',
					refresh_token: '1//refresh',
					expires_in: 3599,
					scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets',
					token_type: 'Bearer',
				});
			}
			return realFetch(input, init);
		};

		try {
			const response = await get(`/oauth/callback?code=the-code&state=${state}`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('Connected to Google');
		} finally {
			globalThis.fetch = realFetch;
		}

		const tokens = await env.AGENT_KV.get(TOKENS_KV_KEY, 'json');
		expect(tokens.access_token).toBe('ya29.access');
		expect(tokens.refresh_token).toBe('1//refresh');
		expect(tokens.expiry_date).toBeGreaterThan(Date.now());

		// The state is single-use.
		expect(await env.AGENT_KV.get(`oauth_state:${state}`)).toBeNull();
	});
});

describe('routing', () => {
	it('404s unknown paths', async () => {
		const response = await SELF.fetch('http://localhost:8787/nope');
		expect(response.status).toBe(404);
	});

	it('405s non-GET requests', async () => {
		const response = await SELF.fetch('http://localhost:8787/oauth/start', { method: 'POST' });
		expect(response.status).toBe(405);
	});

	it('turns an unexpected error into a clean JSON 500', async () => {
		// Break a binding the handler depends on to force a failure no route catches.
		const realKv = env.AGENT_KV;
		env.AGENT_KV = {
			get: () => Promise.reject(new Error('kv exploded')),
			put: () => Promise.reject(new Error('kv exploded')),
			delete: () => Promise.reject(new Error('kv exploded')),
		};

		try {
			const response = await get('/oauth/start');
			expect(response.status).toBe(500);
			expect(response.headers.get('content-type')).toContain('application/json');

			// The internal message must not reach the caller.
			const body = await response.json();
			expect(body).toEqual({ error: 'Internal Server Error' });
		} finally {
			env.AGENT_KV = realKv;
		}
	});
});

describe('RUN_TOKEN gate', () => {
	const TOKEN = 'super-secret-token';

	it('401s the protected paths when the token is missing', async () => {
		env.RUN_TOKEN = TOKEN;

		for (const path of ['/oauth/start', '/run']) {
			const response = await get(path);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: 'Unauthorized' });
		}
	});

	it('401s a wrong token', async () => {
		env.RUN_TOKEN = TOKEN;
		const response = await get('/oauth/start', { headers: { 'x-run-token': 'not-the-token' } });
		expect(response.status).toBe(401);
	});

	it('accepts the token as a header or a query parameter', async () => {
		env.RUN_TOKEN = TOKEN;

		const viaHeader = await get('/oauth/start', { headers: { 'x-run-token': TOKEN } });
		expect(viaHeader.status).toBe(302);

		const viaQuery = await get(`/oauth/start?token=${TOKEN}`);
		expect(viaQuery.status).toBe(302);
	});

	it('never gates the OAuth callback — Google calls it without a token', async () => {
		env.RUN_TOKEN = TOKEN;
		const response = await get('/oauth/callback?code=abc&state=not-a-real-state');
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid or expired state');
	});

	it('leaves the endpoints open when no token is configured', async () => {
		// RUN_TOKEN is unset here (see afterEach) — the gate is opt-in.
		const response = await get('/oauth/start');
		expect(response.status).toBe(302);
	});
});
