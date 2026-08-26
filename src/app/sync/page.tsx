import type { Metadata } from "next";
import { headers } from "next/headers";
import { SkippedActivities, type SkippedGroupView } from "@/components/skipped-activities";
import { SyncNow } from "@/components/sync-now";
import { groupSkippedWorkouts, listSkippedWorkouts } from "@/lib/ingest/skipped";
import { formatMonthDay } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { isIosUserAgent, parseSyncReturn } from "@/lib/sync-now";
import { userTimeZone } from "@/lib/today";
import { requestOrigin } from "@/lib/urls";
import { getUserPrefs, setSkippedSeenAt } from "@/lib/user-prefs";

export const metadata: Metadata = { title: "Sync · RunTracker" };

/**
 * The stored reason, said shorter. The long form names the workout — `workout
 * type "Marche" is not a run` — which reads as a stutter next to the name it
 * sits beside on the row.
 */
function shortReason(reason: string): string {
	if (reason.startsWith("workout type ")) return "not a run type";
	if (reason.startsWith("unnamed workout")) return "your phone sent no workout type";
	return reason;
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** A repeated key reads as its first value; the rest is whoever edited the URL. */
function first(value: string | string[] | undefined): string | null {
	return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export default async function SyncPage({ searchParams }: { searchParams: SearchParams }) {
	const user = await requireUser();

	const [prefs, skipped, timeZone, origin, params, headerList] = await Promise.all([
		getUserPrefs(user.id),
		listSkippedWorkouts(user.id),
		userTimeZone(),
		requestOrigin(),
		searchParams,
		headers(),
	]);

	// Shortcuts lands here through the callback URLs the button built; the
	// card reads them to pick up where the tap left off. The message on an
	// error is Shortcuts' own wording — shown, not trusted, and truncated in
	// case a hand-edited URL tries to make a paragraph of it.
	const synced = parseSyncReturn(first(params.synced));
	const since = first(params.since);
	const errorMessage = first(params.errorMessage)?.slice(0, 200) ?? null;

	// Visiting is what clears the badge. Stamping the newest event that was
	// actually rendered — rather than the clock — keeps a sync that lands while
	// the page is open unseen, and skips the write when there is nothing new.
	const seenAt = prefs.skippedSeenAt ? new Date(prefs.skippedSeenAt) : null;
	if (skipped.latestReceivedAt && (!seenAt || skipped.latestReceivedAt > seenAt)) {
		await setSkippedSeenAt(user.id, skipped.latestReceivedAt);
	}

	const stamp = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const groups: SkippedGroupView[] = groupSkippedWorkouts(skipped.items, prefs.extraRunFragments).map((group) => ({
		key: group.key || "unnamed",
		name: group.name,
		count: group.count,
		date: group.latestDate ? formatMonthDay(group.latestDate) : null,
		received: stamp.format(group.receivedAt),
		reason: shortReason(group.reason),
		allowable: group.allowable,
	}));

	return (
		<section className="fade-in space-y-5">
			<div>
				<h2 className="text-lg font-bold text-white">Sync</h2>
				<p className="mt-1 text-sm text-gray-400">
					Pull the latest from Apple Health, and see what it sent that didn&rsquo;t become a run — and how to change that.
				</p>
			</div>

			<div className="card p-5">
				<SyncNow
					origin={origin}
					shortcutName={prefs.syncShortcutName}
					ios={isIosUserAgent(headerList.get("user-agent") ?? "")}
					title="Sync now"
					initial={synced}
					initialSince={since}
					initialError={errorMessage}
				/>
			</div>

			<div className="card p-5">
				<SkippedActivities groups={groups} allowed={prefs.extraRunFragments} />
			</div>

			{skipped.truncated ? (
				<p className="text-xs text-gray-500">Showing the most recent syncs only. Older ones are still stored.</p>
			) : null}
		</section>
	);
}
