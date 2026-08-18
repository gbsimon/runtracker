/**
 * The server side of Settings: writing an imported v1 backup, reading a full
 * v2 export, and wiping a user's data. Every function takes the user id
 * explicitly and scopes its queries on it, like the rest of the data layer.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, plans, runStreams, runs } from "@/db/schema";
import { listChatMessages } from "./chat";
import { type ImportSummary, summarizeBackup, type V1Backup } from "./import-v1";
import { getPlan, savePlan } from "./plan";
import { type PlanSettings, planSettingsDefaults, type PlanWeek, type WorkoutMap } from "./plan-types";
import { listRuns, manualRunValues, runDistanceKm, runLocalDateISO, runLocalTime } from "./runs";
import { todayISOInZone } from "./running";
import { isValidTimeZone } from "./timezone";

export const EXPORT_FORMAT = "runtracker-v2";

/** v1 wrote chat messages with no timestamps, so the import spaces them out. */
const CHAT_STEP_MS = 1000;

function resolveZone(timeZone: string): string {
	return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/**
 * v1's import was a wholesale replace of `localStorage`, and this keeps that
 * meaning: the plan, the chat and every manually logged run are replaced by
 * the file's. Runs that came from a device sync are left alone — a re-import
 * must not throw away workouts the phone pushed since the backup was taken —
 * and the delete-then-insert makes re-running the same file a no-op rather
 * than a way to double every row.
 */
export async function importV1Backup(userId: string, backup: V1Backup, timeZone: string): Promise<ImportSummary> {
	const zone = resolveZone(timeZone);
	// Ends at the import instant, so the newest imported message is the newest
	// message and a reply typed afterwards still sorts last.
	const chatStart = Date.now() - (backup.chat.length - 1) * CHAT_STEP_MS;

	await getDb().transaction(async (tx) => {
		await tx.delete(runs).where(and(eq(runs.userId, userId), eq(runs.source, "manual")));
		await tx.delete(chatMessages).where(eq(chatMessages.userId, userId));

		await savePlan(
			userId,
			{ settings: backup.settings, weeks: backup.weeks, completed: backup.completed, skipped: backup.skipped },
			tx,
		);

		if (backup.runs.length > 0) {
			await tx.insert(runs).values(
				backup.runs.map((run) =>
					manualRunValues(userId, {
						date: run.date,
						distanceKm: run.distanceKm,
						durationS: run.durationS,
						effort: run.effort,
						notes: run.notes,
						timezone: zone,
					}),
				),
			);
		}

		if (backup.chat.length > 0) {
			await tx.insert(chatMessages).values(
				backup.chat.map((message, index) => ({
					userId,
					role: message.role,
					content: message.content,
					createdAt: new Date(chatStart + index * CHAT_STEP_MS),
				})),
			);
		}
	});

	return summarizeBackup(backup);
}

export type ExportedRun = {
	id: string;
	/** v1 keys first: a v2 export is still a valid v1 backup file. */
	date: string;
	distance: number;
	duration: number;
	effort: number | null;
	notes: string | null;
	time: string;
	source: string;
	externalId: string | null;
	startedAt: string;
	timezone: string | null;
	avgHr: number | null;
	maxHr: number | null;
	avgCadence: number | null;
	elevationGainM: number | null;
	weather: unknown;
	streams?: { kind: string; data: unknown }[];
};

export type ExportPayload = {
	_format: typeof EXPORT_FORMAT;
	_exportedAt: string;
	_durationInSeconds: true;
	_includesStreams: boolean;
	settings: PlanSettings;
	plan: PlanWeek[];
	completedWorkouts: WorkoutMap;
	skippedWorkouts: WorkoutMap;
	runLog: ExportedRun[];
	chatHistory: { role: string; content: string; createdAt: string }[];
};

/**
 * Everything the user owns, under v1's key names wherever v1 had one — so this
 * file imports straight back through the v1 importer, enrichment fields and
 * all (they ride along and are ignored). Streams are opt-in: a single run's
 * GPS trace runs to tens of thousands of points.
 */
export async function collectBackup(
	userId: string,
	options: { timeZone: string; includeStreams?: boolean },
): Promise<ExportPayload> {
	const zone = resolveZone(options.timeZone);
	const [plan, newestFirst, chat] = await Promise.all([getPlan(userId), listRuns(userId), listChatMessages(userId)]);

	// v1's runLog grew by appending, so it read oldest-first.
	const rows = [...newestFirst].reverse();
	const streams = options.includeStreams ? await streamsByRun(rows.map((run) => run.id)) : null;

	return {
		_format: EXPORT_FORMAT,
		_exportedAt: new Date().toISOString(),
		_durationInSeconds: true,
		_includesStreams: streams !== null,
		settings: plan?.settings ?? planSettingsDefaults(),
		plan: plan?.weeks ?? [],
		completedWorkouts: plan?.completed ?? {},
		skippedWorkouts: plan?.skipped ?? {},
		runLog: rows.map((run) => {
			const entry: ExportedRun = {
				id: run.id,
				date: runLocalDateISO(run, zone),
				distance: runDistanceKm(run),
				duration: run.durationS,
				effort: run.effort,
				notes: run.notes,
				time: runLocalTime(run, zone),
				source: run.source,
				externalId: run.externalId,
				startedAt: run.startedAt.toISOString(),
				timezone: run.timezone,
				avgHr: run.avgHr,
				maxHr: run.maxHr,
				avgCadence: run.avgCadence,
				elevationGainM: run.elevationGainM,
				weather: run.weather,
			};
			if (streams) entry.streams = streams.get(run.id) ?? [];
			return entry;
		}),
		chatHistory: chat.map((message) => ({
			role: message.role,
			content: message.content,
			createdAt: message.createdAt.toISOString(),
		})),
	};
}

async function streamsByRun(runIds: string[]): Promise<Map<string, { kind: string; data: unknown }[]>> {
	const grouped = new Map<string, { kind: string; data: unknown }[]>();
	if (runIds.length === 0) return grouped;

	const rows = await getDb()
		.select({ runId: runStreams.runId, kind: runStreams.kind, data: runStreams.data })
		.from(runStreams)
		.where(inArray(runStreams.runId, runIds));

	for (const row of rows) {
		const list = grouped.get(row.runId) ?? [];
		list.push({ kind: row.kind, data: row.data });
		grouped.set(row.runId, list);
	}
	return grouped;
}

export function exportFilename(timeZone: string): string {
	return `runtracker-v2-backup-${todayISOInZone(resolveZone(timeZone))}.json`;
}

export type DeletionCounts = { runs: number; streams: number; chatMessages: number; plans: number };

/**
 * The danger zone: every run (synced ones included), their streams, the plan
 * and the chat. The account itself survives, and so does `ai_usage` — the
 * daily AI cap is accounting, not the user's data, and wiping runs must not
 * hand back a fresh quota.
 */
export async function deleteAllUserData(userId: string): Promise<DeletionCounts> {
	return getDb().transaction(async (tx) => {
		const runIds = await tx.select({ id: runs.id }).from(runs).where(eq(runs.userId, userId));
		const streams =
			runIds.length > 0
				? await tx
						.delete(runStreams)
						.where(
							inArray(
								runStreams.runId,
								runIds.map((row) => row.id),
							),
						)
						.returning({ id: runStreams.id })
				: [];

		const deletedRuns = await tx.delete(runs).where(eq(runs.userId, userId)).returning({ id: runs.id });
		const deletedChat = await tx.delete(chatMessages).where(eq(chatMessages.userId, userId)).returning({ id: chatMessages.id });
		const deletedPlans = await tx.delete(plans).where(eq(plans.userId, userId)).returning({ id: plans.id });

		return {
			runs: deletedRuns.length,
			streams: streams.length,
			chatMessages: deletedChat.length,
			plans: deletedPlans.length,
		};
	});
}

/** What Settings shows about the data an import would replace. */
export async function dataCounts(userId: string) {
	const [plan, rows, chat] = await Promise.all([getPlan(userId), listRuns(userId), listChatMessages(userId)]);
	return {
		manualRuns: rows.filter((run) => run.source === "manual").length,
		syncedRuns: rows.filter((run) => run.source !== "manual").length,
		planWeeks: plan?.weeks.length ?? 0,
		chatMessages: chat.length,
	};
}
