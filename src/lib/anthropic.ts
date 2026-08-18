import Anthropic from "@anthropic-ai/sdk";

/**
 * The model this build was written against. v1 pinned
 * `claude-sonnet-4-5-20250929` from the browser.
 *
 * It is the *last* of three answers to "which model": a `COACH_MODEL` env var
 * and a stored `app_config` override both outrank it, so a retired id repairs
 * itself without a deploy. `coach-model.ts` owns that resolution — call
 * `withCoachModel()` rather than reading this constant.
 */
export const COACH_MODEL = "claude-sonnet-5";

/**
 * Sonnet 5 runs adaptive thinking whenever `thinking` is omitted, which would
 * spend tokens (and eat into `max_tokens`) that a coach reply doesn't need —
 * v1 had no thinking at all. Disabling it keeps the daily cap meaningful.
 * `effort` is the remaining spend dial; the default is `high`.
 */
const THINKING = { type: "disabled" } as const;
const EFFORT = { effort: "medium" } as const;

export const COACH_REQUEST_DEFAULTS = {
	model: COACH_MODEL,
	thinking: THINKING,
	output_config: EFFORT,
} as const;

/** Thrown when the server has no key configured — surfaced as chat text, not a 500. */
export class MissingApiKeyError extends Error {
	constructor() {
		super("The coach isn't configured on this server yet (no ANTHROPIC_API_KEY).");
		this.name = "MissingApiKeyError";
	}
}

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
	if (client) return client;
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new MissingApiKeyError();
	client = new Anthropic({ apiKey });
	return client;
}

/**
 * What the user sees when a call fails. Never leaks the key or a stack — the
 * SDK's typed errors carry a usable message, everything else gets a generic one.
 */
export function coachErrorMessage(error: unknown): string {
	if (error instanceof MissingApiKeyError) return error.message;
	if (error instanceof Anthropic.RateLimitError) return "The coach is rate limited right now — try again in a minute.";
	if (error instanceof Anthropic.AuthenticationError) return "The server's Anthropic key was rejected. Check ANTHROPIC_API_KEY.";
	if (error instanceof Anthropic.APIError) return `The coach service returned an error (${error.status ?? "unknown"}). Try again.`;
	if (error instanceof Error && error.message) return error.message;
	return "Something went wrong talking to the coach.";
}
