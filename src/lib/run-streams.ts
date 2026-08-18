/**
 * Loading stored series for many runs at once.
 *
 * `run-detail.ts` reads one run's streams and thins them for the browser; the
 * training signals in `training-metrics.ts` want the full series for a handful
 * of runs and no rendering at all. This is that read: kinds the caller names,
 * runs the caller has already established belong to the user.
 *
 * The rows were written by our own parser, so the jsonb is trusted to hold the
 * shape its kind promises — only "is it an array" is re-checked, because a
 * hand-edited row shouldn't take a page down.
 */

import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { runStreams } from "@/db/schema";
import type { StreamKind } from "@/db/schema";
import type { CadenceSample, HeartRateSample, RoutePoint, Split } from "./ingest/hae";

export type RunStreamSet = {
	route: RoutePoint[];
	heart_rate: HeartRateSample[];
	cadence: CadenceSample[];
	splits: Split[];
	/** The post-run tail — feed it to `hrRecoveryStats`. */
	hr_recovery: HeartRateSample[];
};

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Streams for the given runs, keyed by run id. Ownership is the caller's to
 * settle first — pass ids that came from `listRuns(userId)`.
 *
 * Naming `kinds` matters: a route is ~500 kB per run, where splits and the
 * recovery tail are under two. Asking for `["splits", "heart_rate"]` across a
 * training block is cheap; asking for everything is not.
 */
export async function loadRunStreams(
	runIds: string[],
	kinds?: readonly StreamKind[],
): Promise<Map<string, Partial<RunStreamSet>>> {
	const byRun = new Map<string, Partial<RunStreamSet>>();
	if (runIds.length === 0) return byRun;

	const rows = await getDb()
		.select({ runId: runStreams.runId, kind: runStreams.kind, data: runStreams.data })
		.from(runStreams)
		.where(inArray(runStreams.runId, runIds));

	for (const row of rows) {
		if (kinds && !kinds.includes(row.kind)) continue;

		const streams = byRun.get(row.runId) ?? {};
		switch (row.kind) {
			case "route":
				streams.route = asArray<RoutePoint>(row.data);
				break;
			case "heart_rate":
				streams.heart_rate = asArray<HeartRateSample>(row.data);
				break;
			case "cadence":
				streams.cadence = asArray<CadenceSample>(row.data);
				break;
			case "splits":
				streams.splits = asArray<Split>(row.data);
				break;
			case "hr_recovery":
				streams.hr_recovery = asArray<HeartRateSample>(row.data);
				break;
			default:
				// `altitude` rides inside the route; anything newer is a row this
				// version predates, and skipping it is the forward-compatible move.
				break;
		}
		byRun.set(row.runId, streams);
	}

	return byRun;
}
