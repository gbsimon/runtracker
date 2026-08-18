/**
 * The nightly maintenance sweep: the housekeeping that has no request to hang
 * off.
 *
 * Two jobs today. Weather, because Open-Meteo can be down at the moment a run
 * arrives and ingest deliberately shrugs that off rather than losing the run —
 * so someone has to come back for it. And the coach model, because Anthropic
 * retires ids on a schedule and `revalidateCoachModel()` would rather find that
 * out at 3am than have a runner meet it mid-conversation.
 *
 * There is no cron service. The web process runs 24/7 (it must, or it would
 * miss webhooks), so `sweep-scheduler.ts` ticks it from inside — and because a
 * deploy may run more than one instance, the whole sweep sits behind a Postgres
 * advisory lock. The `last_sweep` row in `app_config` is both the record shown
 * on Settings and the "have we done this today" gate.
 *
 * Every side effect goes through `SweepDeps`, which is how `pnpm check:sweep`
 * exercises the weather pass against a seeded run and a fake Open-Meteo.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, getSql } from "@/db";
import { runs, runStreams } from "@/db/schema";
import { readAppConfig, writeAppConfig } from "./app-config";
import { type CoachModelCheck, revalidateCoachModel } from "./coach-model";
import { fetchRunWeather, mergeWeather, needsRemoteWeather, type RunWeather } from "./weather";

export const SWEEP_CONFIG_KEY = "last_sweep";

/**
 * How stale the recorded sweep must be before a tick starts another. Twenty
 * hours rather than twenty-four so a sweep that ran at 03:10 yesterday is
 * eligible again by the next night's tick instead of drifting an hour later
 * every day until it skips one.
 */
export const SWEEP_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * Runs whose weather is fetched per sweep. Each one is a separate Open-Meteo
 * request made in series; fifty is a couple of minutes of polite traffic and
 * clears a normal backlog in one night, while a first run over a large import
 * simply continues tomorrow.
 */
const WEATHER_BATCH = 50;

/**
 * Arbitrary but fixed, and unique to this application: `pg_advisory_lock`
 * shares one namespace per database, so the number itself carries no meaning
 * beyond "not the number some other system picked".
 */
const SWEEP_LOCK_KEY = 4_113_907;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export type SweepTrigger = "scheduled" | "manual";

/** What one sweep did, as stored in `app_config.last_sweep`. */
export type SweepRecord = {
	/** ISO-8601, stamped when the sweep finished. */
	ranAt: string;
	durationMs: number;
	trigger: SweepTrigger;
	/** Runs that were missing weather and had a GPS fix to look it up with. */
	weatherCandidates: number;
	weatherFilled: number;
	weatherFailed: number;
	/** One line about the coach model — "ok", an auto-update, or why neither. */
	modelStatus: string;
	model: string | null;
};

function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A row written by an older build is the normal case — shape-check, never cast. */
export function parseSweepRecord(raw: unknown): SweepRecord | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const stored = raw as Partial<SweepRecord>;
	if (typeof stored.ranAt !== "string" || stored.ranAt.length === 0) return null;

	return {
		ranAt: stored.ranAt,
		durationMs: finiteOrZero(stored.durationMs),
		trigger: stored.trigger === "manual" ? "manual" : "scheduled",
		weatherCandidates: finiteOrZero(stored.weatherCandidates),
		weatherFilled: finiteOrZero(stored.weatherFilled),
		weatherFailed: finiteOrZero(stored.weatherFailed),
		modelStatus: typeof stored.modelStatus === "string" ? stored.modelStatus : "unknown",
		model: typeof stored.model === "string" ? stored.model : null,
	};
}

/**
 * Whether a tick should start a sweep. `lastRunAt` is the `app_config` row's
 * own `updated_at`, so the comparison is against a stamp Postgres wrote rather
 * than one an instance claimed.
 *
 * A stamp more than one interval in the *future* can only be a clock that has
 * since moved backwards; sweeping is the recovery, because the alternative is
 * waiting out the skew.
 */
export function sweepIsDue(lastRunAt: Date | null, now: Date, intervalMs: number = SWEEP_INTERVAL_MS): boolean {
	if (!lastRunAt) return true;
	const age = now.getTime() - lastRunAt.getTime();
	return age >= intervalMs || age <= -intervalMs;
}

/** The Settings line, and the one the manual button echoes back. */
export function describeSweepRecord(record: SweepRecord): string {
	const weather =
		record.weatherCandidates === 0
			? "no runs were missing weather"
			: `${record.weatherFilled} of ${record.weatherCandidates} runs given weather${
					record.weatherFailed > 0 ? ` (${record.weatherFailed} unavailable)` : ""
				}`;
	return `${weather} · coach model ${record.modelStatus}`;
}

/** `revalidateCoachModel`'s four outcomes, in a phrase Settings can print. */
export function describeModelCheck(check: CoachModelCheck): string {
	if (check.present === true) return `ok (${check.model})`;
	if (check.present === null) return `unverified — ${check.reason ?? "unknown"}`;
	if (check.recovery?.to) return `auto-updated ${check.recovery.from} → ${check.recovery.to}`;
	return `missing — ${check.reason ?? check.recovery?.reason ?? "no replacement found"}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Weather backfill
// ---------------------------------------------------------------------------

export type WeatherCandidate = { id: string; startedAt: Date; weather: unknown; lat: number; lng: number };

function coordinate(value: unknown, limit: number): number | null {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/**
 * Runs that want weather and can be given it: no usable weather stored, and a
 * route whose first fix says where to ask about.
 *
 * The first point is extracted in SQL (`data -> 0`) rather than by loading the
 * stream — a route is around half a megabyte, and fifty of them is not a payload
 * to move across the wire for two numbers. `-> 0` on anything that isn't an
 * array is NULL, which doubles as the "this row has points" test.
 */
export async function selectWeatherCandidates(limit: number = WEATHER_BATCH): Promise<WeatherCandidate[]> {
	const rows = await getDb()
		.select({
			id: runs.id,
			startedAt: runs.startedAt,
			weather: runs.weather,
			firstPoint: sql<unknown>`${runStreams.data} -> 0`,
		})
		.from(runs)
		.innerJoin(runStreams, and(eq(runStreams.runId, runs.id), eq(runStreams.kind, "route")))
		.where(
			and(
				sql`(${runs.weather} is null or ${runs.weather} ->> 'source' = 'apple')`,
				sql`(${runStreams.data} -> 0) is not null`,
			),
		)
		.orderBy(desc(runs.startedAt))
		.limit(limit);

	const candidates: WeatherCandidate[] = [];
	for (const row of rows) {
		// The SQL filter is a cheap approximation of this one; `needsRemoteWeather`
		// stays the single answer to "would a fetch add anything".
		if (!needsRemoteWeather(row.weather)) continue;

		const point = row.firstPoint;
		if (point === null || typeof point !== "object" || Array.isArray(point)) continue;
		const lat = coordinate((point as { lat?: unknown }).lat, 90);
		const lng = coordinate((point as { lng?: unknown }).lng, 180);
		if (lat === null || lng === null) continue;

		candidates.push({ id: row.id, startedAt: row.startedAt, weather: row.weather, lat, lng });
	}
	return candidates;
}

export type WeatherSweep = { candidates: number; filled: number; failed: number };

async function backfillWeather(deps: SweepDeps, limit: number): Promise<WeatherSweep> {
	const candidates = await deps.selectCandidates(limit);
	let filled = 0;
	let failed = 0;

	for (const candidate of candidates) {
		// Best-effort per run: one refusal from Open-Meteo must not cost the other
		// forty-nine, nor the model check that follows.
		let merged: RunWeather | null = null;
		try {
			const remote = await deps.fetchWeather(candidate.startedAt, candidate.lat, candidate.lng);
			merged = remote === null ? null : mergeWeather((candidate.weather ?? null) as RunWeather | null, remote);
		} catch (error) {
			deps.log(`[sweep] weather lookup threw for run ${candidate.id}: ${errorMessage(error)}`);
		}

		if (!merged) {
			failed += 1;
			continue;
		}

		try {
			await getDb().update(runs).set({ weather: merged }).where(eq(runs.id, candidate.id));
			filled += 1;
		} catch (error) {
			failed += 1;
			deps.log(`[sweep] could not save weather for run ${candidate.id}: ${errorMessage(error)}`);
		}
	}

	return { candidates: candidates.length, filled, failed };
}

// ---------------------------------------------------------------------------
// Wired up
// ---------------------------------------------------------------------------

export type SweepDeps = {
	now: () => Date;
	selectCandidates: (limit: number) => Promise<WeatherCandidate[]>;
	fetchWeather: (startedAt: Date, lat: number, lng: number) => Promise<RunWeather | null>;
	revalidateModel: () => Promise<CoachModelCheck>;
	readStatus: () => Promise<SweepStatus>;
	writeRecord: (record: SweepRecord) => Promise<void>;
	log: (message: string) => void;
	weatherLimit: number;
};

const PRODUCTION: SweepDeps = {
	now: () => new Date(),
	selectCandidates: (limit) => selectWeatherCandidates(limit),
	fetchWeather: (startedAt, lat, lng) => fetchRunWeather(startedAt, lat, lng),
	revalidateModel: () => revalidateCoachModel(),
	readStatus: () => readSweepStatus(),
	writeRecord: (record) => writeAppConfig(SWEEP_CONFIG_KEY, record),
	log: (message) => console.log(message),
	weatherLimit: WEATHER_BATCH,
};

function deps(overrides: Partial<SweepDeps>): SweepDeps {
	return { ...PRODUCTION, ...overrides };
}

/**
 * Runs `body` while holding the sweep's advisory lock, or returns `null`
 * without running it when another instance already holds it.
 *
 * The lock is session-level and therefore tied to one connection, so the
 * connection is reserved out of the pool for the whole sweep — a pooled unlock
 * would land on whichever connection was free and leave the real one locked
 * until that backend died.
 */
async function withSweepLock<T>(body: () => Promise<T>): Promise<T | null> {
	const connection = await getSql().reserve();
	try {
		const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(${SWEEP_LOCK_KEY}) as locked`;
		if (!row?.locked) return null;

		try {
			return await body();
		} finally {
			await connection`select pg_advisory_unlock(${SWEEP_LOCK_KEY})`;
		}
	} finally {
		connection.release();
	}
}

export type SweepOutcome =
	| { status: "done"; record: SweepRecord }
	/** Another instance (or another tab's button press) is mid-sweep. */
	| { status: "busy" }
	/** Only from `maybeRunSweep`: the last sweep is still recent. */
	| { status: "skipped"; lastRunAt: Date | null };

/**
 * The two jobs, once the lock is held. Neither may throw out of here: a sweep
 * that died on the coach model would lose the weather it had already fetched,
 * and would leave nothing recorded for tomorrow's tick to skip.
 */
async function sweepBody(trigger: SweepTrigger, d: SweepDeps): Promise<SweepRecord> {
	const startedAt = d.now();
	d.log(`[sweep] started (${trigger})`);

	let weather: WeatherSweep = { candidates: 0, filled: 0, failed: 0 };
	try {
		weather = await backfillWeather(d, d.weatherLimit);
	} catch (error) {
		d.log(`[sweep] weather pass failed: ${errorMessage(error)}`);
	}

	let modelStatus = "not checked";
	let model: string | null = null;
	try {
		const check = await d.revalidateModel();
		model = check.model;
		modelStatus = describeModelCheck(check);
	} catch (error) {
		modelStatus = `check failed — ${errorMessage(error)}`;
	}

	const finishedAt = d.now();
	const record: SweepRecord = {
		ranAt: finishedAt.toISOString(),
		durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
		trigger,
		weatherCandidates: weather.candidates,
		weatherFilled: weather.filled,
		weatherFailed: weather.failed,
		modelStatus,
		model,
	};

	// The write is what stops the next tick repeating this, so a failure here is
	// worth a loud line even though the work itself succeeded.
	try {
		await d.writeRecord(record);
	} catch (error) {
		d.log(`[sweep] could not record the result: ${errorMessage(error)}`);
	}

	d.log(`[sweep] finished in ${record.durationMs}ms — ${describeSweepRecord(record)}`);
	return record;
}

async function sweepUnderLock(trigger: SweepTrigger, d: SweepDeps, requireDue: boolean): Promise<SweepOutcome> {
	const result = await withSweepLock(async (): Promise<SweepRecord | { skipped: Date | null }> => {
		// Re-read inside the lock. Two instances can both find the sweep overdue
		// and queue up on it; without this the second would sweep again the
		// instant the first let go.
		if (requireDue) {
			const { lastRunAt } = await d.readStatus();
			if (!sweepIsDue(lastRunAt, d.now())) return { skipped: lastRunAt };
		}
		return sweepBody(trigger, d);
	});

	if (result === null) return { status: "busy" };
	if ("skipped" in result) return { status: "skipped", lastRunAt: result.skipped };
	return { status: "done", record: result };
}

/**
 * Does the work, unconditionally — the owner pressing "Run sweep now" has
 * already answered the "is it due" question.
 */
export function runMaintenanceSweep(
	trigger: SweepTrigger = "manual",
	injected: Partial<SweepDeps> = {},
): Promise<SweepOutcome> {
	return sweepUnderLock(trigger, deps(injected), false);
}

export type SweepStatus = { record: SweepRecord | null; lastRunAt: Date | null };

/** What Settings shows, and what the tick's gate reads. */
export async function readSweepStatus(): Promise<SweepStatus> {
	const row = await readAppConfig(SWEEP_CONFIG_KEY);
	return { record: parseSweepRecord(row?.value), lastRunAt: row?.updatedAt ?? null };
}

/**
 * The scheduled path: sweep only if the recorded one has gone stale. The gate
 * is checked twice — here, so the common hourly tick costs one small read and
 * never reserves a connection, and again under the lock, where it is decisive.
 */
export async function maybeRunSweep(injected: Partial<SweepDeps> = {}): Promise<SweepOutcome> {
	const d = deps(injected);
	const { lastRunAt } = await d.readStatus();
	if (!sweepIsDue(lastRunAt, d.now())) return { status: "skipped", lastRunAt };

	return sweepUnderLock("scheduled", d, true);
}
