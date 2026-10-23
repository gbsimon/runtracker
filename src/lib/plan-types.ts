/**
 * The plan shapes v1 kept in localStorage, preserved verbatim: the coach's
 * `:::plan-change` protocol and the v1 importer both read them as-is.
 * Pure — safe to import from client components.
 */

export const DAY_ABBRS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type DayAbbr = (typeof DAY_ABBRS)[number];

export const DAY_OFFSETS: Record<DayAbbr, number> = {
	Mon: 0,
	Tue: 1,
	Wed: 2,
	Thu: 3,
	Fri: 4,
	Sat: 5,
	Sun: 6,
};

export type PlanDay = {
	day: DayAbbr;
	type: string;
	distance: number;
	notes: string;
	pace?: string;
};

export type PlanWeek = {
	week: number;
	phase: string;
	days: PlanDay[];
};

/**
 * `"race"` is the plan v1 always built: dated weeks counting down to race day.
 * `"open"` is a rolling plan with no target race, extended a block at a time.
 */
export type GoalMode = "race" | "open";

export type PlanSettings = {
	startDate: string;
	/** In open mode these two describe the *last* race, kept for the coach. */
	raceDate: string;
	raceDistance: number;
	targetPace: string;
	hidePastWeeks: boolean;
	/**
	 * Optional because rows and exports from before open mode don't carry
	 * them. `normalizePlanSettings` always fills both, so a missing key only
	 * ever means "race" and "".
	 */
	goalMode?: GoalMode;
	/** The runner's free-text objective in open mode. */
	goal?: string;
};

/** `"<week>-<dayIdx>"` → true, exactly as v1 stored it. */
export type WorkoutMap = Record<string, true>;

export const DEFAULT_RACE_DISTANCE = 21.1;

export const RACE_PRESETS = [
	{ value: 5, label: "5K" },
	{ value: 10, label: "10K" },
	{ value: 21.1, label: "Half Marathon (21.1K)" },
	{ value: 42.2, label: "Marathon (42.2K)" },
] as const;

export const MIN_PLAN_WEEKS = 4;

/** Weeks an open-mode plan grows by at a time. */
export const OPEN_BLOCK_WEEKS = 4;

/** Long enough for "sub-25 5K by spring, 4 days a week, mind the left knee"; short enough for every prompt. */
export const MAX_GOAL_LENGTH = 500;

export function workoutKey(week: number, dayIdx: number): string {
	return `${week}-${dayIdx}`;
}

export function isDayAbbr(value: unknown): value is DayAbbr {
	return typeof value === "string" && (DAY_ABBRS as readonly string[]).includes(value);
}

export function raceLabel(distance: number): string {
	if (distance === 5) return "5K";
	if (distance === 10) return "10K";
	if (distance === 21.1) return "Half Marathon";
	if (distance === 42.2) return "Marathon";
	return `${distance}K`;
}

export function planSettingsDefaults(): PlanSettings {
	return {
		startDate: "",
		raceDate: "",
		raceDistance: DEFAULT_RACE_DISTANCE,
		targetPace: "",
		hidePastWeeks: true,
		goalMode: "race",
		goal: "",
	};
}

export function normalizeGoalMode(value: unknown): GoalMode {
	return value === "open" ? "open" : "race";
}

export function normalizeGoal(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, MAX_GOAL_LENGTH).trim() : "";
}

/** Reads the optional key, so a settings object from before open mode is a race plan. */
export function isOpenMode(settings: Pick<PlanSettings, "goalMode"> | null | undefined): boolean {
	return settings?.goalMode === "open";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Tolerant of anything a v1 export or an AI response can hold. */
export function normalizePlanSettings(raw: unknown): PlanSettings {
	const source = asRecord(raw);
	const distance = Number(source.raceDistance);
	return {
		startDate: asString(source.startDate),
		raceDate: asString(source.raceDate),
		raceDistance: Number.isFinite(distance) && distance > 0 ? distance : DEFAULT_RACE_DISTANCE,
		targetPace: asString(source.targetPace),
		// Absent means hidden — v1 data saved before the toggle existed.
		hidePastWeeks: source.hidePastWeeks !== false,
		// Absent means race — everything saved before open mode existed.
		goalMode: normalizeGoalMode(source.goalMode),
		goal: normalizeGoal(source.goal),
	};
}

export function normalizePlanDay(raw: unknown): PlanDay | null {
	const source = asRecord(raw);
	if (!isDayAbbr(source.day)) return null;
	const distance = Number(source.distance);
	const day: PlanDay = {
		day: source.day,
		type: asString(source.type) || "Easy Run",
		distance: Number.isFinite(distance) ? distance : 0,
		notes: asString(source.notes),
	};
	const pace = asString(source.pace);
	if (pace) day.pace = pace;
	return day;
}

export function normalizePlanWeeks(raw: unknown): PlanWeek[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((entry, index) => {
		const source = asRecord(entry);
		const week = Number(source.week);
		const days = Array.isArray(source.days) ? source.days : [];
		return {
			week: Number.isInteger(week) && week > 0 ? week : index + 1,
			phase: asString(source.phase) || "Training",
			days: days.map(normalizePlanDay).filter((day): day is PlanDay => day !== null),
		};
	});
}

/**
 * The order the plan list shows weeks in: the current week and everything
 * after it first, ascending, then the past, most recent first — so the week
 * you're in is always at the top and history reads backwards from it.
 */
export function orderWeeksForDisplay<T extends Pick<PlanWeek, "week">>(weeks: readonly T[], currentWeek: number): T[] {
	const upcoming = weeks.filter((week) => week.week >= currentWeek).sort((a, b) => a.week - b.week);
	const past = weeks.filter((week) => week.week < currentWeek).sort((a, b) => b.week - a.week);
	return [...upcoming, ...past];
}

export function normalizeWorkoutMap(raw: unknown): WorkoutMap {
	const map: WorkoutMap = {};
	for (const [key, value] of Object.entries(asRecord(raw))) {
		if (value) map[key] = true;
	}
	return map;
}
