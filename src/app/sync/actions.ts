"use server";

import { revalidatePath } from "next/cache";
import { reprocessIngestEvents } from "@/lib/ingest/process";
import { requireUser } from "@/lib/session";
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
