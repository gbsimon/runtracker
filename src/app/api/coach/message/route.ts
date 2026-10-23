import type Anthropic from "@anthropic-ai/sdk";
import { isOverDailyLimit, limitReachedMessage, recordMessageUsage } from "@/lib/ai-usage";
import { COACH_REQUEST_DEFAULTS, coachErrorMessage, getAnthropic } from "@/lib/anthropic";
import { appendChatMessage, CHAT_HISTORY_LIMIT, listChatMessages, toApiMessages } from "@/lib/chat";
import { buildCoachSystemPrompt, loadCoachData } from "@/lib/coach-context";
import { withCoachModel } from "@/lib/coach-model";
import { errorFields, logEvent, usageFields, userTag } from "@/lib/log";
import {
	hasUnclosedPlanChange,
	planChangeStatus,
	stitchPlanChangeRetry,
	textBeforeUnclosedPlanChange,
} from "@/lib/plan-change";
import { formatWeekdayLong, todayISOInZone } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";

/**
 * The coach proxy. v1 called api.anthropic.com straight from the browser with
 * a key the runner pasted in; here the key never leaves the server, history
 * lives in `chat_messages`, and spend is metered in `ai_usage`.
 *
 * The wire format is newline-delimited JSON rather than SSE: `EventSource`
 * can't POST, so the client reads the body with `fetch` either way, and once
 * you're parsing by hand, `JSON.parse` per line beats SSE's `data:` framing —
 * it carries typed events and needs no escaping for newlines inside a chunk.
 */

const MAX_MESSAGE_LENGTH = 4000;
/**
 * v1 capped a reply at 8192 tokens. Sonnet 5 accepts up to 128K output on a
 * streamed request, and a plan change that rewrites a dozen weeks with notes
 * and paces can approach the old cap. 32K leaves ample room while keeping the
 * slowest possible reply (~5–9 min at Sonnet's output rate) well inside
 * Railway's 15-minute HTTP request limit. It is a ceiling, not a spend: the
 * daily budget only counts what is actually generated.
 */
const MAX_TOKENS = 32_000;
/** The follow-up that re-asks for a cut-off block only ever carries the block. */
const RETRY_MAX_TOKENS = 16_000;

/**
 * Sent when a reply hits `max_tokens` inside its plan-change block. Sonnet 5
 * rejects an assistant prefill, so "carry on from the exact character" isn't
 * available — and stitching half a JSON object to its continuation would be
 * fragile anyway. Re-asking for the block alone, compactly, joins the two
 * halves at a block boundary instead, and the result is validated before it
 * is kept.
 */
const CUT_OFF_RETRY = `[Your previous reply was cut off by the output limit in the middle of its plan-change block, so the runner cannot apply it. Reply with ONLY the complete :::plan-change block — no text before or after it. Keep it compact: short notes, only the weeks that actually change, and no more than the next 4–5 weeks. Later weeks can come in a follow-up.]`;

const CUT_OFF_FAILED = "The plan change was too long to finish in one reply. Ask the coach for a shorter one — e.g. just the next 4 weeks.";

/** `replace` swaps the reply so far — see `coach-chat.tsx`. */
type StreamEvent =
	| { type: "text"; text: string }
	| { type: "replace"; text: string }
	| { type: "error"; message: string }
	| { type: "done" };

type ApiMessage = { role: "user" | "assistant"; content: string };

type Send = (event: StreamEvent) => void;

function streamResponse(pump: (send: Send, delivered: () => boolean) => Promise<void>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const send = (event: StreamEvent) => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				} catch {
					// The reader went away — keep working so the reply still gets stored.
					open = false;
				}
			};

			try {
				await pump(send, () => open);
			} finally {
				open = false;
				try {
					controller.close();
				} catch {
					// Already closed by the disconnect.
				}
			}
		},
	});

	return new Response(body, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
			// Proxies that buffer would defeat the point of streaming.
			"x-accel-buffering": "no",
		},
	});
}

/**
 * v1 stamped the newest user turn with today's date so the coach never lost
 * track of "now" as the thread grew. Stored history stays clean — this only
 * shapes what goes over the wire.
 */
function stampToday(messages: ApiMessage[], today: string): ApiMessage[] {
	const index = messages.findLastIndex((message) => message.role === "user");
	if (index === -1) return messages;
	return messages.map((message, i) =>
		i === index ? { role: "user", content: `[Today is ${today} (${formatWeekdayLong(today)})]\n${message.content}` } : message,
	);
}

type CutOffRecovery = {
	/** The stitched reply, or `null` when the follow-up didn't produce a usable block. */
	text: string | null;
	final: Anthropic.Message | null;
	error?: unknown;
};

/**
 * One bounded follow-up for a reply cut off inside its block: the prose the
 * runner already read stays, the broken half-block is withdrawn from the
 * browser, and the block is re-requested on its own. Never throws — a failed
 * follow-up is reported by the caller as a cut-off, the same as before.
 */
async function recoverCutOffPlanChange(input: {
	model: string;
	system: Anthropic.TextBlockParam[];
	messages: ApiMessage[];
	reply: string;
	send: Send;
}): Promise<CutOffRecovery> {
	const prose = textBeforeUnclosedPlanChange(input.reply);
	input.send({ type: "replace", text: prose ? `${prose}\n\n` : "" });

	let retry = "";
	try {
		const stream = getAnthropic().messages.stream({
			...COACH_REQUEST_DEFAULTS,
			model: input.model,
			max_tokens: RETRY_MAX_TOKENS,
			system: input.system,
			messages: [
				...input.messages,
				{ role: "assistant", content: prose || "(My plan change was cut off.)" },
				{ role: "user", content: CUT_OFF_RETRY },
			],
		});
		for await (const event of stream) {
			if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				retry += event.delta.text;
				input.send({ type: "text", text: event.delta.text });
			}
		}
		const final = await stream.finalMessage();
		const text = stitchPlanChangeRetry(prose, retry);
		// Normalises away anything the model wrote around the block.
		input.send({ type: "replace", text: text ?? prose });
		return { text, final };
	} catch (error) {
		input.send({ type: "replace", text: prose });
		return { text: null, final: null, error };
	}
}

export async function POST(request: Request) {
	// `src/proxy.ts` already 401s unauthenticated API requests, so this only
	// ever resolves a real user.
	const user = await requireUser();

	const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
	const message = typeof body?.message === "string" ? body.message.trim() : "";
	if (!message) return Response.json({ ok: false, error: "empty_message" }, { status: 400 });
	if (message.length > MAX_MESSAGE_LENGTH) {
		return Response.json({ ok: false, error: "message_too_long" }, { status: 413 });
	}

	const zone = await userTimeZone();
	const today = todayISOInZone(zone);

	await appendChatMessage(user.id, "user", message);

	// Over budget: answer in the thread rather than with an HTTP error the
	// chat UI would have to invent a message for.
	if (await isOverDailyLimit(user.id, today)) {
		const text = limitReachedMessage();
		await appendChatMessage(user.id, "assistant", text);
		return streamResponse(async (send) => {
			send({ type: "text", text });
			send({ type: "done" });
		});
	}

	return streamResponse(async (send, delivered) => {
		const started = Date.now();
		let reply = "";
		let failure = "";
		let model = "";
		let first: Anthropic.Message | null = null;
		let firstPlanChange = "none";
		let continuation: "none" | "recovered" | "failed" | "skipped_budget" = "none";
		let recovery: CutOffRecovery | null = null;
		let caught: unknown = null;

		try {
			// Only the tail is ever sent to the model, so only the tail is read —
			// this runs against an imported history hundreds of messages long.
			const [data, history] = await Promise.all([
				loadCoachData(user.id, today, zone),
				listChatMessages(user.id, CHAT_HISTORY_LIMIT),
			]);

			// The v2 prompt runs to tens of thousands of tokens and is byte-identical
			// across a thread's turns, so it gets a cache breakpoint: the first turn
			// pays 1.25x to write it, every turn after pays 0.1x to read it. The
			// `[Today is …]` stamp rides on the last user message, which the API
			// renders after `system` and so cannot invalidate the cached prefix.
			const system = [
				{ type: "text" as const, text: buildCoachSystemPrompt(data), cache_control: { type: "ephemeral" as const } },
			];
			const messages = stampToday(toApiMessages(history), today);

			const final = await withCoachModel(
				async (candidate) => {
					model = candidate;
					const stream = getAnthropic().messages.stream({
						...COACH_REQUEST_DEFAULTS,
						model: candidate,
						max_tokens: MAX_TOKENS,
						system,
						messages,
					});

					for await (const event of stream) {
						if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
							reply += event.delta.text;
							send({ type: "text", text: event.delta.text });
						}
					}

					return await stream.finalMessage();
				},
				// A retired model 404s before the first token, so the retry is free.
				// Once any text has reached the browser the request is no longer
				// replayable — report that failure rather than restart under the reader.
				{ canRetry: () => reply.length === 0 },
			);
			first = final;
			firstPlanChange = planChangeStatus(reply);
			await recordMessageUsage(user.id, today, final.usage);

			if (final.stop_reason === "refusal") {
				failure = "The coach declined that one. Try rephrasing it.";
			} else if (final.stop_reason === "max_tokens" && !reply) {
				failure = "The reply came back empty. Try asking again.";
			} else if (final.stop_reason === "max_tokens" && hasUnclosedPlanChange(reply)) {
				if (await isOverDailyLimit(user.id, today)) {
					continuation = "skipped_budget";
				} else {
					recovery = await recoverCutOffPlanChange({ model, system, messages, reply, send });
					if (recovery.final) await recordMessageUsage(user.id, today, recovery.final.usage);
					if (recovery.text) {
						continuation = "recovered";
						reply = recovery.text;
					} else {
						continuation = "failed";
						reply = textBeforeUnclosedPlanChange(reply);
						failure = CUT_OFF_FAILED;
					}
				}
			}
		} catch (error) {
			caught = error;
			failure = coachErrorMessage(error);
		}

		// One stored assistant turn, whatever happened — a partial reply plus
		// its error keeps the thread honest about where it stopped.
		const stored = failure ? `${reply}${reply ? "\n\n" : ""}⚠️ ${failure}` : reply;
		try {
			if (stored.trim()) await appendChatMessage(user.id, "assistant", stored);
		} catch (error) {
			caught ??= error;
			logEvent("coach", "store_failed", { user: userTag(user.id), ...errorFields(error) });
		}

		logEvent("coach", "reply", {
			user: userTag(user.id),
			model: model || null,
			stopReason: first?.stop_reason ?? null,
			...usageFields(first?.usage),
			durationMs: Date.now() - started,
			replyChars: reply.length,
			planChange: planChangeStatus(reply),
			firstPlanChange,
			continuation,
			...(recovery
				? {
						retryStopReason: recovery.final?.stop_reason ?? null,
						retryOutputTokens: recovery.final?.usage.output_tokens ?? null,
						...(recovery.error ? { retryError: errorFields(recovery.error) } : {}),
					}
				: {}),
			// The browser went away mid-reply: the stored message is complete
			// even though the runner's screen showed a partial one.
			clientGone: !delivered() || request.signal.aborted,
			...(failure ? { failure } : {}),
			...(caught ? errorFields(caught) : {}),
		});

		if (failure) send({ type: "error", message: failure });
		send({ type: "done" });
	});
}
