/**
 * Matching a synced workout to a run the user already logged by hand.
 *
 * Pure — it takes the candidate rows and returns the one to upgrade, so the
 * rules can be exercised without a database.
 */

import { daysBetweenISO } from "../running";
import { type RunRecord, runLocalDateISO, runLocalTime } from "../runs";
import type { ParsedWorkout } from "./hae";

/** Manual runs imported from v1 carry no time of day; the importer parks them here. */
export const NOON = "12:00";

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const DISTANCE_TOLERANCE = 0.1;

export type ReconcileRule = "same-day" | "noon-import";

export type ReconcileCandidate = Pick<RunRecord, "id" | "source" | "startedAt" | "timezone" | "distanceM" | "durationS">;

export type ReconcileMatch = { run: ReconcileCandidate; rule: ReconcileRule; deltaMs: number };

function withinDistance(candidate: ReconcileCandidate, workout: ParsedWorkout): boolean {
	if (!(workout.distanceM > 0)) return false;
	return Math.abs(candidate.distanceM - workout.distanceM) / workout.distanceM <= DISTANCE_TOLERANCE;
}

/**
 * Two ways a manual run can turn out to be the same run the watch recorded:
 *
 * - `same-day`: logged on the day it happened with a real time of day, so the
 *   calendar date matches and the two starts sit within three hours.
 * - `noon-import`: the v1 convention, where every imported run sits at local
 *   noon and its date is whatever the runner remembered — Simon logged his
 *   Friday-afternoon long run as Saturday. Nothing about the time is
 *   trustworthy there, so the date is allowed to be a day out and the distance
 *   has to carry the match instead.
 *
 * Only manual runs are eligible, which is also what stops a run being upgraded
 * twice: the first upgrade turns it into an `apple_health` row.
 */
export function findReconcileCandidate(
	workout: ParsedWorkout,
	candidates: ReconcileCandidate[],
	options: { exclude?: ReadonlySet<string> } = {},
): ReconcileMatch | null {
	const zone = workout.timezone;
	const matches: ReconcileMatch[] = [];

	for (const run of candidates) {
		if (run.source !== "manual") continue;
		if (options.exclude?.has(run.id)) continue;

		const localDate = runLocalDateISO(run, zone);
		const deltaMs = Math.abs(run.startedAt.getTime() - workout.startedAt.getTime());

		if (localDate === workout.localDate && deltaMs <= THREE_HOURS_MS) {
			matches.push({ run, rule: "same-day", deltaMs });
			continue;
		}

		if (
			runLocalTime(run, zone) === NOON &&
			Math.abs(daysBetweenISO(localDate, workout.localDate)) <= 1 &&
			withinDistance(run, workout)
		) {
			matches.push({ run, rule: "noon-import", deltaMs });
		}
	}

	if (matches.length === 0) return null;

	// A same-day match is the stronger signal; ties inside a rule go to the
	// run that started closest to the workout.
	matches.sort((a, b) => (a.rule === b.rule ? a.deltaMs - b.deltaMs : a.rule === "same-day" ? -1 : 1));
	return matches[0];
}
