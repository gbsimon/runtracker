import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * One structured line per event, e.g.
 *
 *   [coach] {"event":"reply","user":"3f9a1c2e","model":"claude-sonnet-5",…}
 *
 * The bracketed prefix matches the `[sweep]` / `[ingest]` lines already in the
 * logs, so a Railway log search on the prefix still finds everything; the JSON
 * body is what makes the line greppable by field. Never pass message content,
 * emails or plan text in `fields` — ids go through `userTag` first.
 */
export function logEvent(prefix: string, event: string, fields: Record<string, unknown> = {}): void {
	let body: string;
	try {
		body = JSON.stringify({ event, ...fields });
	} catch {
		body = JSON.stringify({ event, note: "fields were not serialisable" });
	}
	console.log(`[${prefix}] ${body}`);
}

/** A short, stable, non-reversible tag for a user id — enough to correlate lines, useless for anything else. */
export function userTag(userId: string): string {
	return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

/** The token counts worth keeping from a response's `usage`. */
export function usageFields(usage: Anthropic.Usage | null | undefined): Record<string, number> {
	if (!usage) return {};
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
	};
}

/** Message plus stack, trimmed so one bad request can't flood the log. */
export function errorFields(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const status = (error as { status?: unknown }).status;
		return {
			error: error.message,
			errorName: error.name,
			...(typeof status === "number" ? { errorStatus: status } : {}),
			stack: error.stack?.split("\n").slice(0, 8).join("\n"),
		};
	}
	return { error: String(error) };
}
