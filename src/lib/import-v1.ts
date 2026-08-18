/**
 * Reads a v1 `exportData()` backup into the shapes v2 stores.
 *
 * Pure and client-safe on purpose: the Settings page parses the picked file in
 * the browser to show the preview, then posts the same text to the server,
 * which reads it again here rather than trusting what the browser reported.
 * The writes live in `backup.ts`, which needs the database.
 */

import {
	normalizePlanSettings,
	normalizePlanWeeks,
	normalizeWorkoutMap,
	type PlanSettings,
	type PlanWeek,
	type WorkoutMap,
} from "./plan-types";
import { isISODate } from "./running";

/** Big enough for any real backup — Simon's 62-run export is 215 KB. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export type ImportedRun = {
	/** Local calendar date; v1 stored no time of day. */
	date: string;
	distanceKm: number;
	durationS: number;
	effort: number | null;
	notes: string | null;
};

export type ImportedChatMessage = { role: "user" | "assistant"; content: string };

export type V1Backup = {
	settings: PlanSettings;
	weeks: PlanWeek[];
	completed: WorkoutMap;
	skipped: WorkoutMap;
	runs: ImportedRun[];
	chat: ImportedChatMessage[];
	/** `runLog` rows with no usable date, distance or duration. */
	droppedRuns: number;
	/** Rows a v2 export marked as device-synced; the import leaves those runs alone. */
	syncedRuns: number;
};

export type ImportSummary = {
	runs: number;
	chatMessages: number;
	planWeeks: number;
	completed: number;
	skipped: number;
	droppedRuns: number;
	syncedRuns: number;
	firstRun: string | null;
	lastRun: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * v1 logged durations in minutes until the `_durationInSeconds` migration, and
 * rewrote the flag on load — so a backup taken before that release still holds
 * minutes and needs the same conversion here.
 */
function readRunLogEntry(raw: unknown, durationsInSeconds: boolean): ImportedRun | null {
	const source = asRecord(raw);
	if (!isISODate(source.date)) return null;

	const distanceKm = Number(source.distance);
	const duration = Number(source.duration);
	if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null;
	if (!Number.isFinite(duration) || duration <= 0) return null;

	const effort = Number(source.effort);
	const notes = typeof source.notes === "string" ? source.notes.trim() : "";

	return {
		date: source.date,
		distanceKm,
		durationS: Math.round(durationsInSeconds ? duration : duration * 60),
		effort: Number.isInteger(effort) && effort >= 1 && effort <= 10 ? effort : null,
		notes: notes || null,
	};
}

function readChatMessage(raw: unknown): ImportedChatMessage | null {
	const source = asRecord(raw);
	const content = typeof source.content === "string" ? source.content : "";
	if (!content) return null;
	if (source.role !== "user" && source.role !== "assistant") return null;
	return { role: source.role, content };
}

/**
 * v1's `importData()` accepted anything holding `settings` and `runLog`, and
 * every other key was optional — a file from before the skip feature has no
 * `skippedWorkouts`, one from before the pace backfill has days without a
 * `pace`. Same tolerance here; the `normalize*` readers absorb the rest, and
 * `settings.apiKey` is dropped because v2 never takes a key from a user.
 */
export function readV1Backup(raw: unknown): V1Backup | string {
	const source = asRecord(raw);
	if (!source.settings || typeof source.settings !== "object" || source.runLog === undefined) {
		return "That doesn't look like a RunTracker backup — it needs `settings` and `runLog`.";
	}

	const runLog = Array.isArray(source.runLog) ? source.runLog : [];
	const durationsInSeconds = source._durationInSeconds === true;

	// A v2 export lists synced runs in `runLog` too. Those rows survive the
	// import untouched in their own table, so re-importing your own backup
	// must not copy them back in as manual runs. v1 files have no `source`.
	const manualLog = runLog.filter((entry) => {
		const value = asRecord(entry).source;
		return typeof value !== "string" || value === "manual";
	});
	const runs = manualLog
		.map((entry) => readRunLogEntry(entry, durationsInSeconds))
		.filter((run): run is ImportedRun => run !== null);

	const chatHistory = Array.isArray(source.chatHistory) ? source.chatHistory : [];

	return {
		settings: normalizePlanSettings(source.settings),
		weeks: normalizePlanWeeks(source.plan),
		completed: normalizeWorkoutMap(source.completedWorkouts),
		skipped: normalizeWorkoutMap(source.skippedWorkouts),
		runs,
		chat: chatHistory.map(readChatMessage).filter((message): message is ImportedChatMessage => message !== null),
		droppedRuns: manualLog.length - runs.length,
		syncedRuns: runLog.length - manualLog.length,
	};
}

export function readV1BackupText(text: string): V1Backup | string {
	if (text.length > MAX_IMPORT_BYTES) return "That file is over 10 MB — it isn't a RunTracker backup.";

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return "That file isn't valid JSON.";
	}
	return readV1Backup(raw);
}

/** What the preview shows before committing, and what the action reports after. */
export function summarizeBackup(backup: V1Backup): ImportSummary {
	const dates = backup.runs.map((run) => run.date).sort();
	return {
		runs: backup.runs.length,
		chatMessages: backup.chat.length,
		planWeeks: backup.weeks.length,
		completed: Object.keys(backup.completed).length,
		skipped: Object.keys(backup.skipped).length,
		droppedRuns: backup.droppedRuns,
		syncedRuns: backup.syncedRuns,
		firstRun: dates[0] ?? null,
		lastRun: dates[dates.length - 1] ?? null,
	};
}
