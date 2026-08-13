/**
 * GET /run — scan the inbox and extract sales leads.
 *
 * Pipeline per run:
 *   1. load Google tokens from KV, refreshing them if expired
 *   2. list the most recent inbox messages (see MAX_MESSAGES)
 *   3. skip any message already marked `processed:<id>` in KV
 *   4. fetch the rest in full, extract subject/from/date/plaintext body
 *   5. ask Claude whether each is a sales lead and pull the details out
 *   6. mark every message processed — leads and non-leads alike
 *   7. write the leads to the "Leads" tab of the target spreadsheet
 *
 * A failure on one message is recorded and the run continues; only a failure
 * that affects the whole run (bad credentials, Gmail list failure) aborts it.
 * A Sheets failure is reported but never discards extracted leads.
 */

import { getValidAccessToken } from './oauth.js';
import { listInboxMessageIds, getMessage, extractMessageContent } from './gmail.js';
import { extractLead } from './leads.js';
import { writeLeadsToSheet } from './sheets.js';

/**
 * How many recent inbox messages to look at per run.
 *
 * Sized for the Workers *free* plan, which allows 50 subrequests per
 * invocation — and KV operations count against that budget alongside fetch.
 * Ten messages costs roughly: 1 Gmail list + 10 Gmail gets + 10 Claude calls
 * + 10 KV reads + 10 KV writes + ~2 for the token + ~5 for Sheets, which lands
 * just under the ceiling. A run that also refreshes the access token and both
 * appends and updates sheet rows sits right at it, and the Claude SDK's
 * automatic retries can push a failing run over.
 *
 * On the paid plan the limit is 1000, so raise this to 20+ there — see the
 * deployment section of the README.
 */
const MAX_MESSAGES = 10;

/** Remember processed message IDs for 30 days, so a re-run never double-reports a lead. */
const PROCESSED_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Messages handled at once.
 *
 * Workers allow only 6 simultaneous outgoing connections awaiting response
 * headers, and KV operations count against that budget alongside fetch. Three
 * keeps well clear of the ceiling while still cutting run time roughly 3x
 * versus processing one at a time.
 */
const CONCURRENCY = 3;

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the returned array.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	let cursor = 0;

	// Each worker pulls the next index until the queue is drained.
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});

	await Promise.all(workers);
	return results;
}

/**
 * @param {object} body
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}
/**
 * @param {Env} env
 * @returns {Promise<Response>}
 */
export async function handleRun(env) {
	/** @type {string} */
	let accessToken;
	/** @type {string[]} */
	let messageIds;

	// Credentials and the inbox listing gate the whole run: without either there is
	// nothing to report, so these are the only failures that abort with an error.
	try {
		accessToken = await getValidAccessToken(env);
		messageIds = await listInboxMessageIds(accessToken, MAX_MESSAGES);
	} catch (error) {
		console.error('[run] aborted:', error.message);
		return jsonResponse({ error: error.message, processed: 0, skipped: 0, new_leads: [], failed: [] }, 502);
	}

	// Anything already handled by an earlier run is dropped before it costs a
	// Gmail fetch or a Claude call.
	const seen = await mapWithConcurrency(messageIds, CONCURRENCY, (id) => env.AGENT_KV.get(`processed:${id}`));
	const pending = messageIds.filter((_, index) => seen[index] === null);
	const skipped = messageIds.length - pending.length;

	// One bad message must not sink the run, so failures are captured per message.
	const results = await mapWithConcurrency(pending, CONCURRENCY, async (messageId) => {
		try {
			const email = extractMessageContent(await getMessage(accessToken, messageId));
			const lead = await extractLead(env, email);
			return {
				messageId,
				lead: {
					message_id: messageId,
					subject: email.subject,
					from: email.from,
					received_at: email.date,
					...lead,
				},
			};
		} catch (error) {
			console.error(`[run] message ${messageId} failed:`, error.message);
			return { messageId, error: error.message };
		}
	});

	const processed = results.filter((result) => !result.error);
	const failed = results.filter((result) => result.error).map(({ messageId, error }) => ({ messageId, error }));
	const newLeads = processed.map((result) => result.lead).filter((lead) => lead.is_lead);

	// Mark leads and non-leads alike — a message that is not a lead is still
	// answered, and re-classifying it next run would just pay for the same answer.
	// Failed messages are deliberately left unmarked so the next run retries them.
	await mapWithConcurrency(processed, CONCURRENCY, (result) =>
		env.AGENT_KV.put(`processed:${result.messageId}`, '1', { expirationTtl: PROCESSED_TTL_SECONDS }),
	);

	// The leads are already extracted and paid for at this point, so a spreadsheet
	// failure is reported alongside them rather than throwing the run away. Writes
	// are keyed on Message ID, so a later manual re-run repairs the sheet in place.
	let writtenToSheet = 0;
	let sheetError;
	if (newLeads.length) {
		try {
			({ written: writtenToSheet } = await writeLeadsToSheet(env, newLeads));
		} catch (error) {
			console.error('[run] sheet write failed:', error.message);
			sheetError = error.message;
		}
	}

	console.log(`[run] processed ${processed.length}, skipped ${skipped}, leads ${newLeads.length}, failed ${failed.length}`);

	return jsonResponse({
		processed: processed.length,
		skipped,
		new_leads: newLeads,
		failed,
		written_to_sheet: writtenToSheet,
		// Omitted entirely on a clean run: JSON.stringify drops undefined values.
		sheet_error: sheetError,
	});
}
