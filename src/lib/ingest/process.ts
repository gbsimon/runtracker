/**
 * The ingest pipeline: raw payload in, runs + streams + plan completions out.
 *
 * The raw `ingest_events` row is written first and never rewritten, so it stays
 * the source of truth — every later pass (a retry, a schema fix, the Reprocess
 * button) replays it, and dedup plus reconciliation make replaying a no-op.
 */

import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { type DbExecutor, getDb } from "@/db";
import { ingestEvents, runStreams, runs } from "@/db/schema";
import { upsertDailyMetrics } from "../daily-metrics";
import { findMatchingWorkout, getPlan, markWorkoutComplete } from "../plan";
import { mergeRunMetrics } from "../run-metrics";
import { listRuns, type RunRecord } from "../runs";
import { fetchRunWeather, mergeWeather, needsRemoteWeather, type RunWeather } from "../weather";
import { type ParsedWorkout, parseHaePayload, workoutRunFields, workoutStreamRows } from "./hae";
import { hasMetrics, parseHaeMetricsPayload } from "./metrics";
import { findReconcileCandidate, type ReconcileRule } from "./reconcile";

export const INGEST_SOURCE = "apple_health";

/**
 * What the Reprocess button replays. `captured` is what the Phase 0 spike wrote
 * before there was a pipeline; `processed` is in the list because a replay is
 * also how an already-imported run picks up something a newer parser has since
 * learned to read — post-run heart-rate recovery, energy, top speed. Replaying
 * is safe by construction: dedup, enrichment and the metrics upsert all
 * converge on the same rows.
 */
const REPROCESSABLE = ["received", "captured", "failed", "processed"] as const;

/** Events that never came through cleanly — what the card counts as "waiting". */
const PENDING = ["received", "captured", "failed"] as const;

export type WorkoutOutcome = {
	externalId: string | null;
	status: "imported" | "reconciled" | "enriched" | "duplicate" | "skipped" | "failed";
	runId?: string;
	/** Why it was skipped, or what went wrong. */
	reason?: string;
	rule?: ReconcileRule;
	localDate?: string;
	distanceKm?: number;
	/** The plan key this run checked off, when it matched one. */
	planKey?: string;
	weatherSource?: string;
	/** Stream kinds and metric fields an enrichment pass added to an existing run. */
	added?: string[];
};

/** Per-metric day counts from a Health Metrics payload. */
export type MetricsSummary = {
	/** Rows written — the same number on a replay, since each one upserts. */
	entries: number;
	/** kind → days carried, e.g. `{resting_heart_rate: 7, sleep_analysis: 6}`. */
	days: Record<string, number>;
	/** Metric names stored verbatim because this parser doesn't model them yet. */
	unknown?: string[];
	skipped?: { kind: string; reason: string; count: number }[];
	error?: string;
};

export type IngestSummary = {
	workouts: number;
	imported: number;
	reconciled: number;
	enriched: number;
	duplicate: number;
	skipped: number;
	failed: number;
	outcomes: WorkoutOutcome[];
	/** Present only for payloads that carried daily metrics. */
	metrics?: MetricsSummary;
	/** Set when the pass itself broke, rather than a single workout. */
	error?: string;
};

function emptySummary(): IngestSummary {
	return { workouts: 0, imported: 0, reconciled: 0, enriched: 0, duplicate: 0, skipped: 0, failed: 0, outcomes: [] };
}

function record(summary: IngestSummary, outcome: WorkoutOutcome): void {
	summary.outcomes.push(outcome);
	summary[outcome.status] += 1;
}

/** Written before any parsing, so a payload we can't understand is still kept. */
export async function storeIngestEvent(userId: string, raw: unknown): Promise<string> {
	const [event] = await getDb()
		.insert(ingestEvents)
		.values({ userId, source: INGEST_SOURCE, status: "received", raw })
		.returning({ id: ingestEvents.id });
	return event.id;
}

async function existingSyncedRun(userId: string, externalId: string): Promise<RunRecord | null> {
	const [row] = await getDb()
		.select()
		.from(runs)
		.where(and(eq(runs.userId, userId), eq(runs.source, INGEST_SOURCE), eq(runs.externalId, externalId)))
		.limit(1);
	return row ?? null;
}

/**
 * Weather is fetched before the transaction opens: a network call has no
 * business holding a write lock, and a run without weather is still a run.
 */
async function resolveWeather(workout: ParsedWorkout, existing: unknown): Promise<RunWeather | null> {
	const apple = workout.weather;
	const current = (existing ?? null) as RunWeather | null;
	const known = apple ?? current;

	if (!workout.firstPoint || !needsRemoteWeather(known)) return known;

	const remote = await fetchRunWeather(workout.startedAt, workout.firstPoint.lat, workout.firstPoint.lng);
	return mergeWeather(known, remote);
}

/** Replaces the stored series wholesale, so reprocessing can't stack duplicates. */
async function writeStreams(tx: DbExecutor, runId: string, workout: ParsedWorkout): Promise<void> {
	const rows = workoutStreamRows(workout);
	await tx.delete(runStreams).where(eq(runStreams.runId, runId));
	if (rows.length > 0) {
		await tx.insert(runStreams).values(rows.map((row) => ({ runId, kind: row.kind, data: row.data })));
	}
}

/**
 * A workout we already have, replayed after the parser learned something new.
 *
 * Only additions: a stream kind the run is missing is inserted, a metrics field
 * it is missing is filled, and nothing already stored is touched — not the
 * existing series, not the weather, and above all not the effort and notes the
 * runner typed. That makes this safe to run over every stored payload, which is
 * exactly what the Reprocess button now does.
 */
async function enrichExistingRun(userId: string, run: RunRecord, workout: ParsedWorkout): Promise<string[]> {
	const stored = await getDb()
		.select({ kind: runStreams.kind })
		.from(runStreams)
		.where(eq(runStreams.runId, run.id));

	const present = new Set(stored.map((row) => row.kind));
	const missing = workoutStreamRows(workout).filter((row) => !present.has(row.kind));
	const { metrics, added: metricFields } = mergeRunMetrics(run.metrics, workout.metrics);

	if (missing.length === 0 && metricFields.length === 0) return [];

	await getDb().transaction(async (tx) => {
		if (missing.length > 0) {
			await tx.insert(runStreams).values(missing.map((row) => ({ runId: run.id, kind: row.kind, data: row.data })));
		}
		if (metricFields.length > 0) {
			await tx
				.update(runs)
				.set({ metrics })
				.where(and(eq(runs.id, run.id), eq(runs.userId, userId)));
		}
	});

	return [...missing.map((row) => row.kind), ...metricFields];
}

/**
 * The plan day this run finishes, marked inside the same transaction as the
 * run itself — a completion without its run would be a lie. `findMatchingWorkout`
 * ignores days already ticked, so a second pass simply finds nothing.
 */
async function completePlanDay(tx: DbExecutor, userId: string, localDate: string): Promise<string | undefined> {
	const plan = await getPlan(userId, tx);
	if (!plan) return undefined;

	const key = findMatchingWorkout(plan, localDate);
	if (!key) return undefined;

	await markWorkoutComplete(userId, key, tx);
	return key;
}

async function ingestWorkout(
	userId: string,
	workout: ParsedWorkout,
	candidates: RunRecord[],
	claimed: Set<string>,
	options: IngestOptions,
): Promise<WorkoutOutcome> {
	const base: WorkoutOutcome = {
		externalId: workout.externalId,
		status: "imported",
		localDate: workout.localDate,
		distanceKm: Math.round(workout.distanceM) / 1000,
	};

	const duplicate = await existingSyncedRun(userId, workout.externalId);
	if (duplicate) {
		// The live webhook keeps dedup a plain no-op — a phone re-sending the same
		// workout must stay cheap. Filling gaps is the Reprocess pass's job.
		const added = options.enrich ? await enrichExistingRun(userId, duplicate, workout) : [];
		return added.length > 0
			? { ...base, status: "enriched", runId: duplicate.id, added }
			: { ...base, status: "duplicate", runId: duplicate.id, reason: "already synced" };
	}

	const match = findReconcileCandidate(workout, candidates, { exclude: claimed });
	const existingRun = match ? candidates.find((run) => run.id === match.run.id) : undefined;
	const weather = await resolveWeather(workout, existingRun?.weather ?? null);
	const fields = { ...workoutRunFields(workout), weather };

	const written = await getDb().transaction(async (tx) => {
		let id: string;

		if (match) {
			// Upgrade in place: the row keeps its id, its effort and its notes,
			// and gains everything the watch measured.
			const [row] = await tx
				.update(runs)
				.set(fields)
				.where(and(eq(runs.id, match.run.id), eq(runs.userId, userId)))
				.returning({ id: runs.id });
			id = row.id;
		} else {
			const [row] = await tx
				.insert(runs)
				.values({ userId, ...fields })
				.returning({ id: runs.id });
			id = row.id;
		}

		await writeStreams(tx, id, workout);
		const planKey = await completePlanDay(tx, userId, workout.localDate);
		return { id, planKey };
	});

	if (match) claimed.add(match.run.id);

	return {
		...base,
		status: match ? "reconciled" : "imported",
		runId: written.id,
		rule: match?.rule,
		planKey: written.planKey,
		weatherSource: weather?.source,
	};
}

export type IngestOptions = {
	/** Let a workout we already have gain what a newer parser can now read. */
	enrich?: boolean;
};

/**
 * Daily metrics from the second automation. Same endpoint, same stored event —
 * only the envelope differs, so the branch is on `data.metrics` rather than on
 * anything the phone had to be told to send.
 */
async function processMetrics(userId: string, raw: unknown): Promise<MetricsSummary> {
	const parsed = parseHaeMetricsPayload(raw);
	const summary: MetricsSummary = { entries: 0, days: parsed.days };
	if (parsed.unknown.length > 0) summary.unknown = parsed.unknown;
	if (parsed.skipped.length > 0) summary.skipped = parsed.skipped;

	summary.entries = await upsertDailyMetrics(userId, parsed.entries);
	return summary;
}

/** Parses and writes one payload. Never throws for a single bad workout. */
export async function processHaePayload(userId: string, raw: unknown, options: IngestOptions = {}): Promise<IngestSummary> {
	const summary = emptySummary();

	if (hasMetrics(raw)) {
		try {
			summary.metrics = await processMetrics(userId, raw);
		} catch (error) {
			console.error("[ingest] metrics failed", error);
			const message = error instanceof Error ? error.message : String(error);
			summary.metrics = { entries: 0, days: {}, error: message };
			summary.error = message;
		}
	}

	const parsed = parseHaePayload(raw);
	summary.workouts = parsed.workouts.length + parsed.skipped.length;

	for (const skipped of parsed.skipped) {
		record(summary, { externalId: skipped.externalId, status: "skipped", reason: skipped.reason });
	}

	if (parsed.workouts.length === 0) return summary;

	const candidates = (await listRuns(userId)).filter((run) => run.source === "manual");
	const claimed = new Set<string>();

	// Oldest first, so an earlier workout can't steal a later one's manual run.
	const ordered = [...parsed.workouts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

	for (const workout of ordered) {
		try {
			record(summary, await ingestWorkout(userId, workout, candidates, claimed, options));
		} catch (error) {
			console.error("[ingest] workout failed", workout.externalId, error);
			record(summary, {
				externalId: workout.externalId,
				status: "failed",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return summary;
}

/**
 * Processes a stored event and stamps the result on it. A failure here is
 * recorded rather than thrown: the raw payload survives, so the run can be
 * recovered by pressing Reprocess once the cause is fixed.
 */
export async function processIngestEvent(
	eventId: string,
	userId: string,
	raw: unknown,
	options: IngestOptions = {},
): Promise<IngestSummary> {
	let summary: IngestSummary;
	let status: "processed" | "failed" = "processed";

	try {
		summary = await processHaePayload(userId, raw, options);
		if (summary.failed > 0 || summary.error) status = "failed";
	} catch (error) {
		console.error("[ingest] processing failed", eventId, error);
		summary = { ...emptySummary(), error: error instanceof Error ? error.message : String(error) };
		status = "failed";
	}

	await getDb().update(ingestEvents).set({ status, summary, userId }).where(eq(ingestEvents.id, eventId));
	return summary;
}

export type ReprocessResult = {
	events: number;
	claimed: number;
	summary: IngestSummary;
};

/**
 * Re-runs every stored event, not only the ones that never completed: the raw
 * payload is the source of truth, so replaying it is how runs imported by an
 * older parser gain fields a newer one reads. The capture-phase rows predate
 * per-user attribution and sit with a NULL `user_id`; the owner claims them,
 * which is the migration rule for the two payloads Simon's phone posted during
 * the schema spike. Members only ever see their own.
 */
export async function reprocessIngestEvents(userId: string, isOwner: boolean): Promise<ReprocessResult> {
	const ownership = isOwner ? or(eq(ingestEvents.userId, userId), isNull(ingestEvents.userId)) : eq(ingestEvents.userId, userId);

	const pending = await getDb()
		.select({ id: ingestEvents.id, userId: ingestEvents.userId, raw: ingestEvents.raw })
		.from(ingestEvents)
		.where(and(eq(ingestEvents.source, INGEST_SOURCE), inArray(ingestEvents.status, [...REPROCESSABLE]), ownership))
		.orderBy(ingestEvents.receivedAt);

	const total = emptySummary();
	let claimed = 0;

	for (const event of pending) {
		if (event.userId === null) claimed += 1;
		const summary = await processIngestEvent(event.id, userId, event.raw, { enrich: true });
		total.workouts += summary.workouts;
		total.imported += summary.imported;
		total.reconciled += summary.reconciled;
		total.enriched += summary.enriched;
		total.duplicate += summary.duplicate;
		total.skipped += summary.skipped;
		total.failed += summary.failed;
		total.outcomes.push(...summary.outcomes);

		if (summary.metrics) {
			const metrics = total.metrics ?? { entries: 0, days: {} };
			metrics.entries += summary.metrics.entries;
			for (const [kind, days] of Object.entries(summary.metrics.days)) {
				metrics.days[kind] = (metrics.days[kind] ?? 0) + days;
			}
			if (summary.metrics.unknown) metrics.unknown = [...new Set([...(metrics.unknown ?? []), ...summary.metrics.unknown])];
			total.metrics = metrics;
		}
	}

	return { events: pending.length, claimed, summary: total };
}

export type LastSync = {
	receivedAt: Date;
	status: string;
	summary: IngestSummary | null;
};

/** What the Settings card shows as "last synced". */
export async function lastIngestEvent(userId: string): Promise<LastSync | null> {
	const [row] = await getDb()
		.select({ receivedAt: ingestEvents.receivedAt, status: ingestEvents.status, summary: ingestEvents.summary })
		.from(ingestEvents)
		.where(eq(ingestEvents.userId, userId))
		.orderBy(desc(ingestEvents.receivedAt))
		.limit(1);

	if (!row) return null;
	return { receivedAt: row.receivedAt, status: row.status, summary: (row.summary as IngestSummary | null) ?? null };
}

/** Events that have never been processed cleanly — the backlog, not the replay set. */
export async function pendingIngestEventCount(userId: string, isOwner: boolean): Promise<number> {
	const ownership = isOwner ? or(eq(ingestEvents.userId, userId), isNull(ingestEvents.userId)) : eq(ingestEvents.userId, userId);
	const rows = await getDb()
		.select({ id: ingestEvents.id })
		.from(ingestEvents)
		.where(and(eq(ingestEvents.source, INGEST_SOURCE), inArray(ingestEvents.status, [...PENDING]), ownership));
	return rows.length;
}
