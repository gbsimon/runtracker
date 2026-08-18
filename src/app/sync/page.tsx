import type { Metadata } from "next";
import { SkippedActivities, type SkippedGroupView } from "@/components/skipped-activities";
import { groupSkippedWorkouts, listSkippedWorkouts } from "@/lib/ingest/skipped";
import { formatMonthDay } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";
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

export default async function SyncPage() {
	const user = await requireUser();

	const [prefs, skipped, timeZone] = await Promise.all([getUserPrefs(user.id), listSkippedWorkouts(user.id), userTimeZone()]);

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
					What Apple Health sent that didn&rsquo;t become a run — and how to change that.
				</p>
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
