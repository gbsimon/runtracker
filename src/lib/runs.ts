import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { runs } from "@/db/schema";
import { todayISOInZone } from "./running";

export type RunRecord = typeof runs.$inferSelect;

export type ManualRunInput = {
	/** Local calendar date, `YYYY-MM-DD`. */
	date: string;
	/** Local `HH:MM`; v1 had no time of day, so midday is the stand-in. */
	time?: string | null;
	distanceKm: number;
	durationS: number;
	effort?: number | null;
	notes?: string | null;
	timezone?: string | null;
};

export const DEFAULT_RUN_TIME = "12:00";

/** Offset of `timeZone` from UTC at that instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
	const asUTC = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
	return asUTC - (at.getTime() - at.getMilliseconds());
}

/**
 * A wall-clock date and time in `timeZone` → the instant it names. Resolved
 * twice so a run logged in the hour a DST change moves still lands right.
 */
export function zonedTimeToUTC(dateISO: string, time: string, timeZone: string): Date {
	const [year, month, day] = dateISO.split("-").map(Number);
	const [hours, minutes] = time.split(":").map(Number);
	const wallClock = Date.UTC(year, month - 1, day, hours, minutes, 0);
	const firstPass = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
	return new Date(wallClock - zoneOffsetMs(new Date(firstPass), timeZone));
}

function resolveTimeZone(value: string | null | undefined): string {
	if (!value) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return value;
	} catch {
		return "UTC";
	}
}

function toRow(input: ManualRunInput) {
	const timezone = resolveTimeZone(input.timezone);
	const notes = input.notes?.trim();
	return {
		startedAt: zonedTimeToUTC(input.date, input.time?.trim() || DEFAULT_RUN_TIME, timezone),
		timezone,
		distanceM: input.distanceKm * 1000,
		durationS: Math.round(input.durationS),
		effort: input.effort ?? null,
		notes: notes ? notes : null,
	};
}

/** The row a manual run becomes — shared with the v1 importer's bulk insert. */
export function manualRunValues(userId: string, input: ManualRunInput) {
	return { userId, source: "manual" as const, ...toRow(input) };
}

export async function listRuns(userId: string): Promise<RunRecord[]> {
	return getDb().select().from(runs).where(eq(runs.userId, userId)).orderBy(desc(runs.startedAt));
}

export async function getRun(userId: string, id: string): Promise<RunRecord | null> {
	const [row] = await getDb()
		.select()
		.from(runs)
		.where(and(eq(runs.userId, userId), eq(runs.id, id)))
		.limit(1);
	return row ?? null;
}

export async function createManualRun(userId: string, input: ManualRunInput): Promise<RunRecord> {
	const [row] = await getDb().insert(runs).values(manualRunValues(userId, input)).returning();
	return row;
}

export async function updateRun(userId: string, id: string, input: ManualRunInput): Promise<RunRecord | null> {
	const [row] = await getDb()
		.update(runs)
		.set(toRow(input))
		.where(and(eq(runs.userId, userId), eq(runs.id, id)))
		.returning();
	return row ?? null;
}

export async function deleteRun(userId: string, id: string): Promise<boolean> {
	const deleted = await getDb()
		.delete(runs)
		.where(and(eq(runs.userId, userId), eq(runs.id, id)))
		.returning({ id: runs.id });
	return deleted.length > 0;
}

type RunLike = Pick<RunRecord, "startedAt" | "timezone" | "distanceM" | "durationS">;

export function runZone(run: Pick<RunRecord, "timezone">, fallback: string): string {
	return resolveTimeZone(run.timezone ?? fallback);
}

/** The calendar date the runner ran on — what plan days are matched against. */
export function runLocalDateISO(run: RunLike, fallbackZone: string): string {
	return todayISOInZone(runZone(run, fallbackZone), run.startedAt);
}

export function runLocalTime(run: RunLike, fallbackZone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: runZone(run, fallbackZone),
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(run.startedAt);
}

export function runDistanceKm(run: Pick<RunRecord, "distanceM">): number {
	return run.distanceM / 1000;
}
