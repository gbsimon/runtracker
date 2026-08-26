"use server";

import { revalidatePath } from "next/cache";
import { lastIngestEvent, reprocessIngestEvents } from "@/lib/ingest/process";
import { requireUser } from "@/lib/session";
import { clampSince, describeSyncOutcome } from "@/lib/sync-now";
import { allowRunName } from "@/lib/user-prefs";

export type AllowState = { status: "idle" | "done" | "error"; message?: string };

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Allow a workout type, retroactively.
 *
 * Two steps, in this order: the folded name joins the user's allowlist, then
 * every stored payload is replayed through a parser that now accepts it. The
 * replay is the whole point — it is what turns months of skipped walks into
 * runs without the phone re-sending anything. Safe for a member as well as the
 * owner: a replay only ever touches events the user owns, and dedup makes
 * re-running it a no-op.
 */
export async function allowRunTypeAction(name: string): Promise<AllowState> {
	const user = await requireUser();

	const allowed = await allowRunName(user.id, name);
	if (!allowed) {
		return { status: "error", message: "That name is too short or too long to use as a run type." };
	}

	const result = await reprocessIngestEvents(user.id, user.role === "owner");
	const imported = result.summary.imported + result.summary.reconciled;

	// The badge lives in the root layout, so the whole layout has to be
	// invalidated for the new count to reach it — the same reason the send-key
	// preference does. It covers this page and the run lists underneath.
	revalidatePath("/", "layout");

	return {
		status: "done",
		message:
			imported > 0
				? `“${name}” now counts as a run — ${plural(imported, "past workout")} imported.`
				: `“${name}” now counts as a run. Nothing stored matched it, so the next one your phone sends will import.`,
	};
}

/**
 * What the "Sync now" card is waiting on.
 *
 * `expired` is not an error — it is the tap having happened longer ago than a
 * sync could plausibly still be in flight, which is also what a reloaded page
 * carrying a stale `since` looks like.
 */
export type SyncPoll =
	| { status: "waiting" }
	| { status: "expired" }
	| { status: "arrived"; at: string; message: string; failed: boolean };

/**
 * Has anything landed since the tap?
 *
 * The webhook is the only writer, so "newer than the moment the button was
 * pressed" is the whole test — no handshake between the phone and this page is
 * needed, and a payload that arrives while the user is still in the Shortcuts
 * app is found on the first poll after they come back.
 *
 * `shown` is the event the card is already displaying, so a second payload —
 * the shortcut sends workouts and health metrics as two posts, seconds apart —
 * is told from the one that was reported on the previous tick.
 */
export async function pollSyncAction(since: string, shown: string | null = null): Promise<SyncPoll> {
	const user = await requireUser();

	const at = clampSince(since, new Date());
	if (!at) return { status: "expired" };

	const last = await lastIngestEvent(user.id);
	if (!last || last.receivedAt.getTime() <= at.getTime()) return { status: "waiting" };

	// The webhook stores first and processes second, and processing can take
	// seconds when it reaches out for weather. A row still marked `received`
	// is that gap, not a payload with nothing in it.
	if (last.status === "received") return { status: "waiting" };

	const arrivedAt = last.receivedAt.toISOString();

	// Only when there is something new to show: the run has to reach the Log
	// list and the nav badge, and those live above this page in the layout —
	// the same reason allowing a run type invalidates the layout rather than
	// this route.
	if (arrivedAt !== shown) revalidatePath("/", "layout");

	return { status: "arrived", at: arrivedAt, message: describeSyncOutcome(last.summary), failed: last.status === "failed" };
}
