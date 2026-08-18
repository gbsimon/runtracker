import { isOverDailyLimit, limitReachedMessage, recordMessageUsage } from "@/lib/ai-usage";
import { COACH_REQUEST_DEFAULTS, coachErrorMessage, getAnthropic } from "@/lib/anthropic";
import { appendChatMessage, CHAT_HISTORY_LIMIT, listChatMessages, toApiMessages } from "@/lib/chat";
import { buildCoachSystemPrompt, loadCoachData } from "@/lib/coach-context";
import { withCoachModel } from "@/lib/coach-model";
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
/** v1's chat ceiling. Streaming means the long ones don't risk an HTTP timeout. */
const MAX_TOKENS = 8192;

type StreamEvent = { type: "text"; text: string } | { type: "error"; message: string } | { type: "done" };

type ApiMessage = { role: "user" | "assistant"; content: string };

function streamResponse(pump: (send: (event: StreamEvent) => void) => Promise<void>): Response {
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
				await pump(send);
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

	return streamResponse(async (send) => {
		let reply = "";
		let failure = "";

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
				async (model) => {
					const stream = getAnthropic().messages.stream({
						...COACH_REQUEST_DEFAULTS,
						model,
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
			await recordMessageUsage(user.id, today, final.usage);

			if (final.stop_reason === "refusal") {
				failure = "The coach declined that one. Try rephrasing it.";
			} else if (final.stop_reason === "max_tokens" && !reply) {
				failure = "The reply came back empty. Try asking again.";
			}
		} catch (error) {
			failure = coachErrorMessage(error);
		}

		// One stored assistant turn, whatever happened — a partial reply plus
		// its error keeps the thread honest about where it stopped.
		const stored = failure ? `${reply}${reply ? "\n\n" : ""}⚠️ ${failure}` : reply;
		if (stored.trim()) await appendChatMessage(user.id, "assistant", stored);

		if (failure) send({ type: "error", message: failure });
		send({ type: "done" });
	});
}
