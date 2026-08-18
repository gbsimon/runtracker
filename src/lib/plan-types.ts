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

export type PlanSettings = {
	startDate: string;
	raceDate: string;
	raceDistance: number;
	targetPace: string;
	hidePastWeeks: boolean;
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
	return { startDate: "", raceDate: "", raceDistance: DEFAULT_RACE_DISTANCE, targetPace: "", hidePastWeeks: true };
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

export function normalizeWorkoutMap(raw: unknown): WorkoutMap {
	const map: WorkoutMap = {};
	for (const [key, value] of Object.entries(asRecord(raw))) {
		if (value) map[key] = true;
	}
	return map;
}
