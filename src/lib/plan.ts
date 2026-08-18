import { eq, sql } from "drizzle-orm";
import { type DbExecutor, getDb } from "@/db";
import { plans } from "@/db/schema";
import { type PlanChange, toPlanDays } from "./plan-change";
import { applyTargetPace, generateDefaultPlan } from "./plan-generator";
import {
	normalizePlanSettings,
	normalizePlanWeeks,
	normalizeWorkoutMap,
	type PlanDay,
	type PlanSettings,
	type PlanWeek,
	type WorkoutMap,
	workoutKey,
} from "./plan-types";
import { isISODate, weeksBetween, workoutDateISO } from "./running";

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

/**
 * Builds the default plan for the given settings and clears completions —
 * v1's "Regenerate Plan", which also reset `completedWorkouts`.
 */
export async function regeneratePlan(userId: string, settings: PlanSettings): Promise<PlanWeek[]> {
	const weeks = generateDefaultPlan(weeksBetween(settings.startDate, settings.raceDate), settings);
	await savePlan(userId, { settings, weeks });
	return weeks;
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

	let weeks = plan.weeks;
	const completed = { ...plan.completed };
	const skipped = { ...plan.skipped };
	let touched = false;

	for (const entry of change.changes) {
		const index = weeks.findIndex((week) => week.week === entry.week);
		if (index === -1) continue;
		touched = true;

		if (entry.days) {
			const days = toPlanDays(entry.days);
			weeks = weeks.map((week, i) => (i === index ? { ...week, days } : week));
		}

		for (const skip of entry.skips ?? []) {
			const dayIdx = weeks[index].days.findIndex((day) => day.day === skip.day);
			if (dayIdx === -1) continue;
			const key = workoutKey(entry.week, dayIdx);
			if (skip.skipped) {
				skipped[key] = true;
				delete completed[key];
			} else {
				delete skipped[key];
			}
		}
	}

	if (!touched) return false;

	await savePlan(userId, { settings: plan.settings, weeks, completed, skipped });
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
