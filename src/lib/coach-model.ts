import { COACH_MODEL, getAnthropic } from "./anthropic";
import { readAppConfig, writeAppConfig } from "./app-config";

/**
 * Which Claude model the coach talks to, and what happens the day that model
 * is retired.
 *
 * Anthropic deprecates model ids on a published schedule; a build pinned to one
 * eventually starts answering every chat with a 404. Rather than have the
 * runner discover that, the coach recovers: on a model-not-found error it asks
 * `GET /v1/models` which Sonnets exist now, takes the newest, writes it to
 * `app_config` so the next request starts there, and retries once.
 *
 * Resolution order — `COACH_MODEL` env var, then the stored override, then the
 * code default. The env var wins so an operator can pin a model and have the
 * auto-update stop overruling them; the stored override outranks the default
 * because it is, by construction, newer information than the source code.
 *
 * Everything below takes its side effects through `CoachModelDeps`, which is
 * how `pnpm check:coach-context` exercises the whole recovery path against a
 * fake client and an in-memory store.
 */

export const COACH_MODEL_CONFIG_KEY = "coach_model";

/** Only ids in this family are candidates — see `pickNewestSonnet`. */
const SONNET_PREFIX = "claude-sonnet-";

export type CoachModelSource = "env" | "config" | "default";

/** What an auto-update records, so Settings can explain itself later. */
export type CoachModelOverride = {
	model: string;
	/** The id that 404'd, kept for the notice ("auto-updated from X"). */
	previous: string;
	/** ISO-8601, stamped when the swap happened. */
	updatedAt: string;
};

export type CoachModelResolution = {
	model: string;
	source: CoachModelSource;
	override: CoachModelOverride | null;
};

/** The subset of a `/v1/models` entry this module reads. */
export type ModelListing = { id: string; created_at?: string | null; display_name?: string | null };

export type CoachModelDeps = {
	envModel: () => string | undefined;
	readOverride: () => Promise<CoachModelOverride | null>;
	writeOverride: (override: CoachModelOverride) => Promise<void>;
	listModels: () => Promise<ModelListing[]>;
	log: (message: string) => void;
	now: () => Date;
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** A stored row is whatever an older build wrote — shape-check, never cast. */
export function parseCoachModelOverride(raw: unknown): CoachModelOverride | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const stored = raw as Partial<CoachModelOverride>;
	if (typeof stored.model !== "string" || stored.model.length === 0) return null;
	return {
		model: stored.model,
		previous: typeof stored.previous === "string" ? stored.previous : "",
		updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
	};
}

/**
 * `claude-sonnet-4-6` → `[4, 6]`, `claude-sonnet-5` → `[5]`. Parsing stops at
 * the first non-numeric segment, so an id carrying a suffix still yields the
 * version in front of it. A dated snapshot (`claude-sonnet-4-5-20250929`) does
 * parse its date as a third number, which only ever decides between two ids
 * whose version numbers already tie — and `created_at` has decided by then.
 */
function versionOf(id: string): number[] {
	const parts = id.slice(SONNET_PREFIX.length).split("-");
	const version: number[] = [];
	for (const part of parts) {
		if (!/^\d+$/.test(part)) break;
		version.push(Number(part));
	}
	return version;
}

function compareVersions(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (b[i] ?? -1) - (a[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

function createdMs(model: ModelListing): number {
	const parsed = model.created_at ? Date.parse(model.created_at) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : -1;
}

/**
 * The newest Sonnet in a `/v1/models` listing, or `null` when the account can't
 * see one.
 *
 * The rule, in order: keep only ids beginning `claude-sonnet-` (so an Opus or
 * Haiku is never substituted for a Sonnet — they are different money and a
 * different latency profile, and silently switching tiers is not a repair);
 * drop `exclude`, which is the id that just failed; then newest first by
 * `created_at`, with the version numbers in the id as the tie-break for
 * listings that share a timestamp or omit one, and the id itself last so the
 * choice is deterministic.
 */
export function pickNewestSonnet(models: ModelListing[], exclude?: string): string | null {
	const candidates = models.filter(
		(model) => typeof model.id === "string" && model.id.startsWith(SONNET_PREFIX) && model.id !== exclude,
	);
	if (candidates.length === 0) return null;

	candidates.sort((a, b) => {
		const byDate = createdMs(b) - createdMs(a);
		if (byDate !== 0) return byDate;
		const byVersion = compareVersions(versionOf(a.id), versionOf(b.id));
		if (byVersion !== 0) return byVersion;
		return b.id.localeCompare(a.id);
	});

	return candidates[0].id;
}

/** The resolution order, without the I/O — env, then stored override, then code. */
export function resolveFrom(
	envModel: string | undefined,
	override: CoachModelOverride | null,
	fallback: string = COACH_MODEL,
): CoachModelResolution {
	const trimmed = envModel?.trim();
	if (trimmed) return { model: trimmed, source: "env", override };
	// An override with no model is a row an older build wrote, or a partial
	// write — either way the code default is better than an empty model id.
	if (override?.model) return { model: override.model, source: "config", override };
	return { model: fallback, source: "default", override: null };
}

/**
 * Whether an error means "that model id doesn't exist".
 *
 * Duck-typed rather than an `instanceof` check: the SDK's `NotFoundError`
 * satisfies it, and so does a plain object in the checks. A 404 from
 * `/v1/messages` is about the model in practice, but the message is still
 * required to name one so an unrelated 404 can never trigger a model swap.
 */
export function isModelNotFoundError(error: unknown, model?: string): boolean {
	if (error === null || typeof error !== "object") return false;
	const raw = error as { status?: unknown; message?: unknown; error?: { error?: { type?: unknown; message?: unknown } } };
	if (raw.status !== 404) return false;

	const inner = raw.error?.error;
	if (inner?.type !== undefined && inner.type !== "not_found_error") return false;

	const message = [raw.message, inner?.message].filter((part): part is string => typeof part === "string").join(" ");
	return /\bmodel\b/i.test(message) || (model !== undefined && model.length > 0 && message.includes(model));
}

// ---------------------------------------------------------------------------
// Wired up
// ---------------------------------------------------------------------------

/** How many pages of `/v1/models` to walk before giving up; the list is short. */
const MODEL_PAGE_LIMIT = 200;

const PRODUCTION: CoachModelDeps = {
	envModel: () => process.env.COACH_MODEL,
	readOverride: async () => parseCoachModelOverride((await readAppConfig(COACH_MODEL_CONFIG_KEY))?.value),
	writeOverride: (override) => writeAppConfig(COACH_MODEL_CONFIG_KEY, override),
	listModels: async () => {
		const models: ModelListing[] = [];
		for await (const model of getAnthropic().models.list({ limit: 100 })) {
			models.push({ id: model.id, created_at: model.created_at, display_name: model.display_name });
			if (models.length >= MODEL_PAGE_LIMIT) break;
		}
		return models;
	},
	log: (message) => console.log(message),
	now: () => new Date(),
};

function deps(overrides: Partial<CoachModelDeps>): CoachModelDeps {
	return { ...PRODUCTION, ...overrides };
}

export async function resolveCoachModel(injected: Partial<CoachModelDeps> = {}): Promise<CoachModelResolution> {
	const d = deps(injected);
	// A stored override is a nicety; an unreachable database on this read would
	// otherwise take down a chat that the code default could have served.
	const override = await d.readOverride().catch(() => null);
	return resolveFrom(d.envModel(), override);
}

export type CoachModelRecovery = {
	from: string;
	to: string | null;
	/** Why nothing was written, when `to` is null. */
	reason?: string;
};

/**
 * Finds a live replacement for `missing`, records it, and returns it.
 *
 * Writing the override is what makes this a one-time cost rather than a 404 on
 * every request until someone deploys. The write is best-effort: a swap that
 * can't be persisted still lets the current request through on the new id.
 */
export async function recoverCoachModel(
	missing: string,
	injected: Partial<CoachModelDeps> = {},
): Promise<CoachModelRecovery> {
	const d = deps(injected);

	let models: ModelListing[];
	try {
		models = await d.listModels();
	} catch (error) {
		return { from: missing, to: null, reason: `could not list models (${(error as Error)?.message ?? "unknown"})` };
	}

	const replacement = pickNewestSonnet(models, missing);
	if (!replacement) return { from: missing, to: null, reason: "no Sonnet model available on this account" };

	const override: CoachModelOverride = { model: replacement, previous: missing, updatedAt: d.now().toISOString() };
	try {
		await d.writeOverride(override);
	} catch (error) {
		d.log(`[coach] model auto-update could not be saved: ${(error as Error)?.message ?? "unknown"}`);
	}

	d.log(`[coach] model auto-updated ${missing} → ${replacement}`);
	return { from: missing, to: replacement };
}

/**
 * Runs `call` with the resolved model, and once more on a new model if the
 * resolved one no longer exists.
 *
 * `canRetry` is the streaming guard: once a token has reached the browser the
 * request is no longer replayable, so a late failure is reported rather than
 * silently restarted under the reader.
 */
export async function withCoachModel<T>(
	call: (model: string) => Promise<T>,
	options: { canRetry?: () => boolean } = {},
	injected: Partial<CoachModelDeps> = {},
): Promise<T> {
	const { model } = await resolveCoachModel(injected);

	try {
		return await call(model);
	} catch (error) {
		if (!isModelNotFoundError(error, model)) throw error;
		if (options.canRetry && !options.canRetry()) throw error;

		const recovery = await recoverCoachModel(model, injected);
		if (!recovery.to) throw error;
		return await call(recovery.to);
	}
}

export type CoachModelCheck = {
	model: string;
	source: CoachModelSource;
	/** `false` means the id is absent from `/v1/models`. `null` means we couldn't tell. */
	present: boolean | null;
	recovery?: CoachModelRecovery;
	reason?: string;
};

/**
 * Proactive version of the same repair, for the nightly cron (item 20): checks
 * the configured id against the live listing and swaps it before a runner ever
 * meets the error. An env-pinned model is reported on but never overridden —
 * that pin is an explicit instruction.
 */
export async function revalidateCoachModel(injected: Partial<CoachModelDeps> = {}): Promise<CoachModelCheck> {
	const d = deps(injected);
	const { model, source } = await resolveCoachModel(injected);

	let models: ModelListing[];
	try {
		models = await d.listModels();
	} catch (error) {
		return { model, source, present: null, reason: `could not list models (${(error as Error)?.message ?? "unknown"})` };
	}

	if (models.some((entry) => entry.id === model)) return { model, source, present: true };
	if (source === "env") {
		return { model, source, present: false, reason: "COACH_MODEL is pinned to a model that no longer exists" };
	}

	const recovery = await recoverCoachModel(model, injected);
	return { model: recovery.to ?? model, source: recovery.to ? "config" : source, present: false, recovery };
}

/**
 * The owner-visible line on Settings, or `null` when there is nothing to say —
 * no override, an override that agrees with the code default (the build caught
 * up), or an env pin that makes the stored value moot.
 */
export async function coachModelNotice(injected: Partial<CoachModelDeps> = {}): Promise<CoachModelOverride | null> {
	const { source, override } = await resolveCoachModel(injected);
	if (source !== "config" || !override) return null;
	return override.model === COACH_MODEL ? null : override;
}
