/**
 * Pace, duration and plan-calendar maths. Pure — safe in client components.
 *
 * v1 ran these in the browser, so `new Date("2026-04-01T00:00:00")` landed on
 * the runner's local midnight. On the server that would follow the server's
 * timezone instead, so every plan date is computed on `YYYY-MM-DD` strings
 * through `Date.UTC`, which is timezone-independent.
 */

import { type DayAbbr, DAY_ABBRS, DAY_OFFSETS } from "./plan-types";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: unknown): value is string {
	return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(isoToUTC(value));
}

function isoToUTC(iso: string): number {
	const [year, month, day] = iso.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

function utcToISO(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
	return utcToISO(isoToUTC(iso) + days * DAY_MS);
}

export function daysBetweenISO(from: string, to: string): number {
	return Math.round((isoToUTC(to) - isoToUTC(from)) / DAY_MS);
}

/** Mon=0 … Sun=6, matching the order plan days are written in. */
export function weekdayIndexISO(iso: string): number {
	return (new Date(isoToUTC(iso)).getUTCDay() + 6) % 7;
}

export function weekdayAbbrISO(iso: string): DayAbbr {
	return DAY_ABBRS[weekdayIndexISO(iso)];
}

/** Sun=0 … Sat=6, the numbering v1's calendar-week fallback counted with. */
export function weekdaySunday0ISO(iso: string): number {
	return (weekdayIndexISO(iso) + 1) % 7;
}

/** The Monday on or before `iso`. */
export function mondayISO(iso: string): string {
	return addDaysISO(iso, -weekdayIndexISO(iso));
}

export function todayISOInZone(timeZone: string, now = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	return parts;
}

/** Whole weeks from the plan's first Monday to race day, as v1 counted them. */
export function weeksBetween(startISO: string, raceISO: string): number {
	if (!isISODate(startISO) || !isISODate(raceISO)) return 0;
	return Math.max(1, Math.ceil(daysBetweenISO(mondayISO(startISO), raceISO) / 7));
}

export function weekMondayISO(startISO: string, week: number): string {
	return addDaysISO(mondayISO(startISO), (week - 1) * 7);
}

export function workoutDateISO(startISO: string, week: number, day: DayAbbr): string {
	return addDaysISO(weekMondayISO(startISO, week), DAY_OFFSETS[day] ?? 0);
}

/** Which plan week (1-based) a date falls in, relative to the plan start. */
export function planWeekOfISO(startISO: string, iso: string): number | null {
	if (!isISODate(startISO) || !isISODate(iso)) return null;
	return Math.floor(daysBetweenISO(mondayISO(startISO), iso) / 7) + 1;
}

export function currentWeekNumber(startISO: string, totalWeeks: number, todayISO: string): number {
	const week = planWeekOfISO(startISO, todayISO) ?? 1;
	return Math.max(1, Math.min(week, Math.max(totalWeeks, 1)));
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const FULL_DATE = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "long",
	day: "numeric",
	year: "numeric",
});
const WEEKDAY_MONTH_DAY = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	weekday: "short",
	month: "short",
	day: "numeric",
});
const WEEKDAY_LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });

export function formatMonthDay(iso: string): string {
	return MONTH_DAY.format(new Date(isoToUTC(iso)));
}

export function formatFullDate(iso: string): string {
	return FULL_DATE.format(new Date(isoToUTC(iso)));
}

export function formatWeekdayDate(iso: string): string {
	return WEEKDAY_MONTH_DAY.format(new Date(isoToUTC(iso)));
}

/** "Monday" — what the coach context stamps next to TODAY. */
export function formatWeekdayLong(iso: string): string {
	return WEEKDAY_LONG.format(new Date(isoToUTC(iso)));
}

export function weekDateRange(startISO: string, week: number): string {
	const monday = weekMondayISO(startISO, week);
	return `${formatMonthDay(monday)} – ${formatMonthDay(addDaysISO(monday, 6))}`;
}

/** "30:00" or "1:12:30" → seconds. `null` when it isn't a duration. */
export function parseDuration(value: string): number | null {
	const parts = value.trim().split(":");
	if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) return null;
	const [hours, minutes, seconds] = parts.length === 3 ? parts : ["0", ...parts];
	const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
	return total > 0 ? total : null;
}

export function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "M:SS" pace → seconds per km; 0 when unset or unparseable. */
export function parsePace(value: string | null | undefined): number {
	if (!value) return 0;
	const parts = value.split(":");
	if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part.trim()))) return 0;
	return Number(parts[0]) * 60 + Number(parts[1]);
}

export function formatPace(seconds: number): string {
	if (!seconds || seconds <= 0) return "";
	const rounded = Math.round(seconds);
	return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

/** Suggested pace (s/km) for a workout type, given the target race pace. */
export function getWorkoutPace(type: string, racePaceSec: number): number {
	if (!racePaceSec) return 0;
	switch (type) {
		case "Easy Run":
			return racePaceSec + 75;
		case "Long Run":
			return racePaceSec + 60;
		case "Tempo Run":
		case "Easy Tempo":
			return racePaceSec + 10;
		case "Intervals":
			return racePaceSec - 20;
		case "Race Pace":
			return racePaceSec;
		case "Shakeout":
			return racePaceSec + 90;
		default:
			return type.includes("RACE") ? racePaceSec : 0;
	}
}

/** Pace is always derived from distance and duration, never stored. */
export function paceSeconds(distanceKm: number, durationS: number): number {
	if (!distanceKm || !durationS) return 0;
	return Math.round(durationS / distanceKm);
}

export function formatKm(distanceKm: number): string {
	return Number(distanceKm.toFixed(2)).toString();
}

/** "8:24" under the hour, "1:45:11" over it — how a watch shows elapsed time. */
export function formatElapsed(totalSeconds: number): string {
	const total = Math.max(0, Math.round(totalSeconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total / 60) % 60;
	const seconds = String(total % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "2h05" / "45m", as the v1 plan header showed total training time. */
export function formatTotalTime(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}` : `${minutes}m`;
}
