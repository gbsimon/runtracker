import { eq, sql } from "drizzle-orm";
import { type DbExecutor, getDb } from "@/db";
import { plans } from "@/db/schema";
import { applyChangeToPlan, type PlanChange } from "./plan-change";
import {
	appendWeeks,
	applyTargetPace,
	generateDefaultPlan,
	generateInitialOpenPlan,
	generateOpenBlock,
	planExtension,
} from "./plan-generator";
import {
	isOpenMode,
	normalizePlanSettings,
	normalizePlanWeeks,
	normalizeWorkoutMap,
	OPEN_BLOCK_WEEKS,
	type PlanDay,
	type PlanSettings,
	type PlanWeek,
	type WorkoutMap,
	workoutKey,
} from "./plan-types";
import { listRuns, runLocalDateISO } from "./runs";
import { addDaysISO, isISODate, mondayISO, todayISOInZone, weeksBetween, workoutDateISO } from "./running";
import { weeklyLoad } from "./training-metrics";

export type PlanRecord = {
	settings: PlanSettings;
	weeks: PlanWeek[];
	completed: WorkoutMap;
	skipped: WorkoutMap;
	updatedAt: Date;
};

/**
 * Every function takes the user id explicitly and scopes its query on it —
 * callers get it from `requireUser()` (page/action) or from an ingest token
 * (Phase 3), never from client input.
 */
export async function getPlan(
	userId: string,
	/** Ingest passes its transaction so the plan it reads is the one it marks. */
	db: DbExecutor = getDb(),
): Promise<PlanRecord | null> {
	const [row] = await db.select().from(plans).where(eq(plans.userId, userId)).limit(1);
	if (!row) return null;
	return {
		settings: normalizePlanSettings(row.settings),
		weeks: normalizePlanWeeks(row.weeks),
		completed: normalizeWorkoutMap(row.completed),
		skipped: normalizeWorkoutMap(row.skipped),
		updatedAt: row.updatedAt,
	};
}

export async function savePlan(
	userId: string,
	input: { settings: PlanSettings; weeks: PlanWeek[]; completed?: WorkoutMap; skipped?: WorkoutMap },
	/** The v1 import passes its transaction so the plan lands with the runs. */
	db: DbExecutor = getDb(),
): Promise<void> {
	const values = {
		settings: input.settings,
		weeks: input.weeks,
		completed: input.completed ?? {},
		skipped: input.skipped ?? {},
		updatedAt: new Date(),
	};
	await db
		.insert(plans)
		.values({ userId, ...values })
		.onConflictDoUpdate({ target: plans.userId, set: values });
}

/** Complete weeks an open-mode block is sized from. */
const RECENT_LOAD_WEEKS = 4;

/**
 * Kilometres per complete week over the last few weeks, oldest first — the
 * same Monday-anchored buckets the coach's WEEKLY VOLUME section uses. The
 * week in progress is left out: three days into it, it would read as a dip.
 */
export async function recentWeeklyKm(userId: string, today: string, zone = "UTC"): Promise<number[]> {
	const runs = await listRuns(userId);
	const report = weeklyLoad(
		runs.map((run) => ({
			id: run.id,
			day: runLocalDateISO(run, zone),
			distanceM: run.distanceM,
			durationS: run.durationS,
			avgHr: run.avgHr,
			maxHr: run.maxHr,
		})),
		RECENT_LOAD_WEEKS,
		{ endDay: addDaysISO(mondayISO(today), -1) },
	);
	return report.weeks.map((week) => week.km);
}

/**
 * Builds the default plan for the given settings and clears completions —
 * v1's "Regenerate Plan", which also reset `completedWorkouts`. An open-mode
 * plan has no race to count down to, so it starts over as one block at the
 * current calendar week, with empty "Off Plan" weeks before it when the start
 * date is in the past. `today` places and sizes that block; it defaults to
 * the UTC date.
 */
export async function regeneratePlan(userId: string, settings: PlanSettings, today?: string): Promise<PlanWeek[]> {
	const day = today ?? todayISOInZone("UTC");
	const weeks = isOpenMode(settings)
		? generateInitialOpenPlan({
				startDate: settings.startDate,
				today: day,
				recentWeeklyKm: await recentWeeklyKm(userId, day),
				targetPace: settings.targetPace,
			})
		: generateDefaultPlan(weeksBetween(settings.startDate, settings.raceDate), settings);
	await savePlan(userId, { settings, weeks });
	return weeks;
}

/** What an AI block generator is handed; it returns the weeks, any numbering. */
export type OpenBlockRequest = {
	settings: PlanSettings;
	weeks: PlanWeek[];
	firstWeek: number;
	count: number;
	recentWeeklyKm: number[];
	today: string;
};

export type ExtendResult = {
	weeks: PlanWeek[];
	added: PlanWeek[];
	/** Empty "Off Plan" weeks inserted because the calendar had run past the plan. */
	gapWeeks: number;
	/** Set when the AI generator failed and the standard block was used instead. */
	aiError: unknown;
};

/**
 * Appends `count` weeks to the end of the plan and never rewrites one that is
 * already there — completions, skips and edits all stay put. The AI generator
 * is injected rather than imported so this data layer stays free of the
 * Anthropic client; when it throws, the standard block goes in instead and
 * the error is handed back for the caller to report.
 */
export async function extendPlan(
	userId: string,
	count = OPEN_BLOCK_WEEKS,
	options: { ai?: (request: OpenBlockRequest) => Promise<PlanWeek[]>; today?: string; zone?: string } = {},
): Promise<ExtendResult | null> {
	const plan = await getPlan(userId);
	if (!plan || !isISODate(plan.settings.startDate)) return null;

	const zone = options.zone ?? "UTC";
	const today = options.today ?? todayISOInZone(zone);
	const size = Math.max(1, Math.floor(count));
	const { gap, firstWeek } = planExtension(plan.weeks, plan.settings.startDate, today);
	const recent = await recentWeeklyKm(userId, today, zone);

	const standard = () =>
		generateOpenBlock({ firstWeek, count: size, recentWeeklyKm: recent, targetPace: plan.settings.targetPace });

	let block: PlanWeek[];
	let aiError: unknown = null;
	if (options.ai) {
		try {
			const generated = await options.ai({
				settings: plan.settings,
				weeks: plan.weeks,
				firstWeek,
				count: size,
				recentWeeklyKm: recent,
				today,
			});
			// Renumbered here whatever the model wrote, so the block always lands
			// exactly where `planExtension` said it would.
			block = generated.slice(0, size).map((week, i) => ({ ...week, week: firstWeek + i }));
			if (block.length === 0) throw new Error("The AI returned an empty block");
		} catch (error) {
			aiError = error;
			block = standard();
		}
	} else {
		block = standard();
	}

	const weeks = appendWeeks(plan.weeks, gap, block);
	// Weeks only: completions and skips are keyed by week number, and every
	// existing number keeps its meaning, so neither map needs touching.
	await getDb().update(plans).set({ weeks, updatedAt: new Date() }).where(eq(plans.userId, userId));

	return { weeks, added: block, gapWeeks: gap.length, aiError };
}

/**
 * v1 backfilled suggested paces across the whole plan whenever the target
 * pace changed, and left the plan alone otherwise.
 */
export async function updatePlanSettings(
	userId: string,
	patch: Partial<PlanSettings>,
): Promise<{ plan: PlanRecord; pacesUpdated: boolean } | null> {
	const plan = await getPlan(userId);
	if (!plan) return null;

	const settings: PlanSettings = { ...plan.settings, ...patch };
	const pacesUpdated = settings.targetPace !== plan.settings.targetPace;
	const weeks = pacesUpdated ? applyTargetPace(plan.weeks, settings.targetPace) : plan.weeks;

	await getDb().update(plans).set({ settings, weeks, updatedAt: new Date() }).where(eq(plans.userId, userId));

	return { plan: { ...plan, settings, weeks }, pacesUpdated };
}

/** Single-key write so toggling the view can't clobber a concurrent edit. */
export async function setHidePastWeeks(userId: string, hide: boolean): Promise<void> {
	await getDb()
		.update(plans)
		.set({
			settings: sql`jsonb_set(${plans.settings}, '{hidePastWeeks}', ${hide ? "true" : "false"}::jsonb)`,
			updatedAt: new Date(),
		})
		.where(eq(plans.userId, userId));
}

/**
 * Completing clears a skip and vice versa — v1's `toggleWorkout` /
 * `toggleSkip`. Both maps move in one statement so a double-click can't leave
 * a day marked done *and* skipped.
 */
export async function toggleWorkoutComplete(userId: string, key: string): Promise<void> {
	const wasComplete = sql`jsonb_exists(${plans.completed}, ${key})`;
	await getDb()
		.update(plans)
		.set({
			completed: sql`case when ${wasComplete} then ${plans.completed} - ${key}::text else ${plans.completed} || jsonb_build_object(${key}::text, true) end`,
			skipped: sql`case when ${wasComplete} then ${plans.skipped} else ${plans.skipped} - ${key}::text end`,
			updatedAt: new Date(),
		})
		.where(eq(plans.userId, userId));
}

export async function toggleWorkoutSkip(userId: string, key: string): Promise<void> {
	const wasSkipped = sql`jsonb_exists(${plans.skipped}, ${key})`;
	await getDb()
		.update(plans)
		.set({
			skipped: sql`case when ${wasSkipped} then ${plans.skipped} - ${key}::text else ${plans.skipped} || jsonb_build_object(${key}::text, true) end`,
			completed: sql`case when ${wasSkipped} then ${plans.completed} else ${plans.completed} - ${key}::text end`,
			updatedAt: new Date(),
		})
		.where(eq(plans.userId, userId));
}

/** Logging a run supersedes a skip, exactly as v1's `logRun` did. */
export async function markWorkoutComplete(
	userId: string,
	key: string,
	/** A synced run marks its plan day in the same transaction that writes it. */
	db: DbExecutor = getDb(),
): Promise<void> {
	await db
		.update(plans)
		.set({
			completed: sql`${plans.completed} || jsonb_build_object(${key}::text, true)`,
			skipped: sql`${plans.skipped} - ${key}::text`,
			updatedAt: new Date(),
		})
		.where(eq(plans.userId, userId));
}

export async function updatePlanDay(userId: string, week: number, dayIdx: number, day: PlanDay): Promise<boolean> {
	const plan = await getPlan(userId);
	if (!plan) return false;
	return writePlanDay(userId, plan, week, dayIdx, () => day);
}

/** Moves a planned day to another weekday without touching anything else. */
export async function movePlanDay(userId: string, week: number, dayIdx: number, day: PlanDay["day"]): Promise<void> {
	const plan = await getPlan(userId);
	if (!plan) return;
	await writePlanDay(userId, plan, week, dayIdx, (existing) => (existing.day === day ? existing : { ...existing, day }));
}

async function writePlanDay(
	userId: string,
	plan: PlanRecord,
	week: number,
	dayIdx: number,
	replace: (existing: PlanDay) => PlanDay,
): Promise<boolean> {
	const existing = plan.weeks.find((entry) => entry.week === week)?.days[dayIdx];
	if (!existing) return false;

	const replacement = replace(existing);
	if (replacement === existing) return true;

	const weeks = plan.weeks.map((entry) =>
		entry.week === week
			? { ...entry, days: entry.days.map((day, i) => (i === dayIdx ? replacement : day)) }
			: entry,
	);

	await getDb().update(plans).set({ weeks, updatedAt: new Date() }).where(eq(plans.userId, userId));
	return true;
}

/**
 * Applies a coach `:::plan-change`. Each listed week's days are replaced
 * wholesale — v1's semantics, so a day the coach omits is a day it deleted —
 * and skips resolve against the *new* day order, which is why they run second.
 *
 * One write rather than a call per key: replacing days and moving skip flags
 * has to land together, and untouched weeks keep their completions.
 */
export async function applyPlanChange(userId: string, change: PlanChange): Promise<boolean> {
	const plan = await getPlan(userId);
	if (!plan) return false;

	const next = applyChangeToPlan(plan, change);
	if (!next) return false;

	await savePlan(userId, next);
	return true;
}

/** First planned day on `dateISO` that isn't already completed — v1's `findMatchingWorkout`. */
export function findMatchingWorkout(plan: PlanRecord, dateISO: string): string | null {
	if (!isISODate(plan.settings.startDate)) return null;
	for (const week of plan.weeks) {
		for (let i = 0; i < week.days.length; i++) {
			const key = workoutKey(week.week, i);
			if (plan.completed[key]) continue;
			if (workoutDateISO(plan.settings.startDate, week.week, week.days[i].day) === dateISO) return key;
		}
	}
	return null;
}

/** A week is "finished" once every day is either completed or deliberately skipped. */
export function isWeekFinished(plan: PlanRecord, week: PlanWeek): boolean {
	return week.days.every((_, i) => plan.completed[workoutKey(week.week, i)] || plan.skipped[workoutKey(week.week, i)]);
}
