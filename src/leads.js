/**
 * Lead extraction via the Claude API.
 *
 * One email in, one structured lead record out. The response shape is pinned
 * with structured outputs (`output_config.format`), so the model cannot wrap
 * the JSON in a markdown fence or add commentary around it — the text block is
 * always parseable.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Claude Haiku 4.5 — fast and cheap, which suits a per-message classifier. */
const MODEL = 'claude-haiku-4-5-20251001';

/** The JSON contract is fixed and small, so the response never needs much room. */
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
	'You extract sales lead data from incoming business inquiry emails. ' +
	'Determine if this email is a genuine lead (someone interested in buying/hiring/inquiring) ' +
	'or something else (newsletter, spam, notification, personal). Return JSON only, no markdown.';

/**
 * Schema enforced by the API on every response.
 *
 * Structured outputs require `additionalProperties: false` and every key listed
 * in `required`, so optional fields are modelled as explicit `null` unions
 * rather than by omitting them. Numeric ranges (`minimum`/`maximum`) are not
 * supported by the schema subset, so `lead_score` is bounded in the prompt and
 * clamped below.
 */
const LEAD_SCHEMA = {
	type: 'object',
	properties: {
		is_lead: { type: 'boolean', description: 'True only for a genuine buying/hiring/service inquiry.' },
		name: nullableString('Full name of the person making the inquiry.'),
		email: nullableString('Best reply-to email address for the lead.'),
		phone: nullableString('Phone number if one is given.'),
		company: nullableString('Company or organisation the lead represents.'),
		interest: { type: 'string', description: 'Short summary of what they want. Empty string if not a lead.' },
		budget: nullableString('Stated budget or price range, verbatim.'),
		source: nullableString('How they found us, if mentioned (referral, Google, event, ...).'),
		urgency: {
			anyOf: [{ type: 'string', enum: ['low', 'medium', 'high'] }, { type: 'null' }],
			description: 'How soon they want to move.',
		},
		lead_score: { type: 'number', description: 'Confidence/quality from 0 to 1 inclusive.' },
		notes: nullableString('Anything else worth passing to sales.'),
	},
	required: ['is_lead', 'name', 'email', 'phone', 'company', 'interest', 'budget', 'source', 'urgency', 'lead_score', 'notes'],
	additionalProperties: false,
};

/**
 * A string field that the model may leave unset.
 * @param {string} description
 */
function nullableString(description) {
	return { anyOf: [{ type: 'string' }, { type: 'null' }], description };
}

/**
 * Classify one email and extract lead details from it.
 *
 * @param {Env} env
 * @param {{ subject: string, from: string, date: string, body: string }} email
 * @returns {Promise<object>} a record matching {@link LEAD_SCHEMA}
 * @throws {Error} if the API call fails or returns unparseable content
 */
export async function extractLead(env, email) {
	if (!env.ANTHROPIC_API_KEY) {
		throw new Error('ANTHROPIC_API_KEY is not set — add it with: npx wrangler secret put ANTHROPIC_API_KEY');
	}

	// Construct per request: Workers only expose bindings inside the handler.
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

	const userPrompt = [
		'Analyse this email and return the lead data as JSON.',
		'',
		`From: ${email.from}`,
		`Date: ${email.date}`,
		`Subject: ${email.subject}`,
		'',
		'Body:',
		email.body || '(empty body)',
		'',
		'Rules:',
		'- is_lead is true only for a genuine buying, hiring, or service inquiry.',
		'- Use null for any field the email does not state. Do not invent details.',
		'- lead_score is a number from 0 to 1 reflecting how strong the lead is.',
		'- urgency is one of "low", "medium", "high", or null.',
	].join('\n');

	let response;
	try {
		response = await client.messages.create({
			model: MODEL,
			max_tokens: MAX_TOKENS,
			system: SYSTEM_PROMPT,
			output_config: { format: { type: 'json_schema', schema: LEAD_SCHEMA } },
			messages: [{ role: 'user', content: userPrompt }],
		});
	} catch (error) {
		// Typed SDK errors: distinguish retryable from permanent for the caller's logs.
		if (error instanceof Anthropic.AuthenticationError) {
			throw new Error('Claude API rejected ANTHROPIC_API_KEY.');
		}
		if (error instanceof Anthropic.RateLimitError) {
			throw new Error('Claude API rate limited this request.');
		}
		if (error instanceof Anthropic.APIConnectionError) {
			throw new Error(`Could not reach the Claude API: ${error.message}`);
		}
		if (error instanceof Anthropic.APIError) {
			throw new Error(`Claude API error ${error.status}: ${error.message}`);
		}
		throw error;
	}

	// A refusal or a token cutoff means the schema was not honoured.
	if (response.stop_reason === 'refusal') {
		throw new Error('Claude declined to process this email.');
	}
	if (response.stop_reason === 'max_tokens') {
		throw new Error('Claude response hit max_tokens before completing the JSON.');
	}

	const text = response.content.find((block) => block.type === 'text')?.text;
	if (!text) {
		throw new Error('Claude returned no text content.');
	}

	return normaliseLead(JSON.parse(text));
}

/**
 * Coerce the model's output into the exact shape downstream code expects.
 *
 * Structured outputs guarantee the types, but not that `lead_score` sits inside
 * 0..1 — the schema subset has no numeric bounds — so clamp it here.
 *
 * @param {object} lead
 * @returns {object}
 */
function normaliseLead(lead) {
	return {
		...lead,
		lead_score: Math.min(1, Math.max(0, Number(lead.lead_score) || 0)),
	};
}
