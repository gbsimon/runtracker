/**
 * The skipped half of ingestion, read back for review.
 *
 * Nothing here is a second source of truth: the rows are the `skipped`
 * outcomes the pipeline already wrote into `ingest_events.summary`, and the
 * raw payload behind each one is still stored. That is what lets the Sync tab
 * offer "allow this type" as a *retroactive* action — saying yes edits the
 * allowlist and replays the payloads, and the skips turn into runs.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ingestEvents } from "@/db/schema";
import { getUserPrefs } from "../user-prefs";
import { foldRunName, isRunName } from "./hae";
import { INGEST_SOURCE, type IngestSummary, type WorkoutOutcome } from "./process";

/**
 * How many recent events either query walks. A phone posts one event per sync,
 * so fifty covers weeks; capping it is what keeps the nav badge a single cheap
 * indexed read on every page render instead of a table scan.
 */
const EVENT_SCAN_LIMIT = 50;

/** Rows rendered on the page, before grouping collapses the repeats. */
const ITEM_LIMIT = 100;

/** One filtered-out workout, flattened out of the event that carried it. */
export type SkippedItem = {
	/** Localized workout name — `null` for summaries written before it was recorded, and for genuinely unnamed workouts. */
	name: string | null;
	/** `YYYY-MM-DD` in the phone's own offset, when the start was readable. */
	localDate: string | null;
	reason: string;
	receivedAt: Date;
};

/** Repeats collapsed: one row per workout type, which is how a walker's list stays readable. */
export type SkippedGroup = {
	/** Folded name, or `""` for the unnamed pile. Stable key, and what the allow action is keyed on. */
	key: string;
	/** The name as the phone last wrote it — `null` for the unnamed pile. */
	name: string | null;
	count: number;
	/** Newest workout date in the group. */
	latestDate: string | null;
	/** Newest sync that carried one of them. */
	receivedAt: Date;
	/** The most recent reason — the whole group shares it in practice. */
	reason: string;
	/** Whether allowing this name would import them: only true when the *type* is what stopped it. */
	allowable: boolean;
};

export type SkippedEventCount = { receivedAt: Date; skipped: number };

/**
 * The event's skip count read in SQL, so the badge never ships the outcomes
 * array over the wire. Guarded by `jsonb_typeof` because a hand-edited or
 * pre-schema summary would otherwise fail the cast for the whole query.
 */
function skippedCountSql() {
	return sql<number>`case when jsonb_typeof(${ingestEvents.summary} -> 'skipped') = 'number' then (${ingestEvents.summary} ->> 'skipped')::int else 0 end`;
}

/**
 * Own events only. The capture-phase rows with a NULL `user_id` are claimed by
 * the owner's first reprocess — including the one every "allow this type" runs —
 * so they join the list rather than needing a rule of their own here.
 */
function ownSkippedEvents(userId: string) {
	return and(eq(ingestEvents.userId, userId), eq(ingestEvents.source, INGEST_SOURCE), sql`${skippedCountSql()} > 0`);
}

/** What the nav badge counts, one indexed query, no jsonb payload in the result. */
export async function recentSkippedCounts(userId: string): Promise<SkippedEventCount[]> {
	const rows = await getDb()
		.select({ receivedAt: ingestEvents.receivedAt, skipped: skippedCountSql() })
		.from(ingestEvents)
		.where(ownSkippedEvents(userId))
		.orderBy(desc(ingestEvents.receivedAt))
		.limit(EVENT_SCAN_LIMIT);

	return rows.map((row) => ({ receivedAt: row.receivedAt, skipped: Number(row.skipped) || 0 }));
}

/**
 * Skips the user hasn't looked at yet. Pure, so the badge's arithmetic is
 * testable without a database — and so "seen" stays one comparison rather than
 * a flag written per item.
 */
export function countUnseenSkipped(events: readonly SkippedEventCount[], seenAt: Date | null): number {
	const seen = seenAt ? seenAt.getTime() : null;
	return events.reduce((total, event) => {
		if (seen !== null && event.receivedAt.getTime() <= seen) return total;
		return total + Math.max(0, event.skipped);
	}, 0);
}

/**
 * The nav badge, rendered on every page — two parallel indexed reads and no
 * jsonb on the wire, which is the budget this is allowed to cost.
 */
export async function unseenSkippedCount(userId: string): Promise<number> {
	const [prefs, events] = await Promise.all([getUserPrefs(userId), recentSkippedCounts(userId)]);
	return countUnseenSkipped(events, prefs.skippedSeenAt ? new Date(prefs.skippedSeenAt) : null);
}

export type SkippedList = {
	items: SkippedItem[];
	/** Newest event carrying a skip — what a visit stamps as seen. `null` when there are none. */
	latestReceivedAt: Date | null;
	/** True when the scan limit cut the list short, so the page can say so. */
	truncated: boolean;
};

/** Newest first, flattened out of the recent events' stored summaries. */
export async function listSkippedWorkouts(userId: string): Promise<SkippedList> {
	const events = await getDb()
		.select({ receivedAt: ingestEvents.receivedAt, summary: ingestEvents.summary })
		.from(ingestEvents)
		.where(ownSkippedEvents(userId))
		.orderBy(desc(ingestEvents.receivedAt))
		.limit(EVENT_SCAN_LIMIT);

	const items: SkippedItem[] = [];
	for (const event of events) {
		const outcomes = ((event.summary as IngestSummary | null)?.outcomes ?? []) as WorkoutOutcome[];
		const skipped = outcomes
			.filter((outcome) => outcome.status === "skipped")
			// Within one sync, newest workout first; the events themselves are already ordered.
			.sort((a, b) => (b.localDate ?? "").localeCompare(a.localDate ?? ""));

		for (const outcome of skipped) {
			items.push({
				name: outcome.name ?? null,
				localDate: outcome.localDate ?? null,
				reason: outcome.reason ?? "skipped",
				receivedAt: event.receivedAt,
			});
		}
	}

	return {
		items: items.slice(0, ITEM_LIMIT),
		latestReceivedAt: events[0]?.receivedAt ?? null,
		truncated: items.length > ITEM_LIMIT || events.length === EVENT_SCAN_LIMIT,
	};
}

/**
 * One row per workout type instead of forty identical "Marche" rows.
 *
 * `allowable` is derived rather than sniffed out of the reason string: a named
 * workout the run filter still rejects was stopped by the *type* gate, and is
 * exactly the case allowing the name would fix. A name that already passes —
 * a run skipped for carrying no distance, or a type allowed since the summary
 * was written — gets no button, because a button there would do nothing.
 */
export function groupSkippedWorkouts(items: readonly SkippedItem[], extraRunFragments: readonly string[]): SkippedGroup[] {
	const groups = new Map<string, SkippedGroup>();

	for (const item of items) {
		const key = item.name ? foldRunName(item.name) : "";
		const existing = groups.get(key);

		if (!existing) {
			groups.set(key, {
				key,
				name: item.name,
				count: 1,
				latestDate: item.localDate,
				receivedAt: item.receivedAt,
				reason: item.reason,
				allowable: item.name !== null && !isRunName(item.name, extraRunFragments),
			});
			continue;
		}

		existing.count += 1;
		if (item.localDate && (!existing.latestDate || item.localDate > existing.latestDate)) existing.latestDate = item.localDate;
		if (item.receivedAt > existing.receivedAt) existing.receivedAt = item.receivedAt;
	}

	// Most recently synced first; a tie breaks on the newer workout, then on size.
	return [...groups.values()].sort(
		(a, b) =>
			b.receivedAt.getTime() - a.receivedAt.getTime() ||
			(b.latestDate ?? "").localeCompare(a.latestDate ?? "") ||
			b.count - a.count,
	);
}
