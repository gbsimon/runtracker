"use server";

import { revalidatePath } from "next/cache";
import { CHAT_VIEW_LIMIT, clearChatMessages, listChatMessages } from "@/lib/chat";
import { applyPlanChange } from "@/lib/plan";
import { revalidatePlanViews } from "@/lib/plan-actions";
import {
	newestChangeMessageId,
	parsePlanChange,
	planChangeKey,
	planChangesIn,
	planChangeWeeks,
} from "@/lib/plan-change";
import { requireUser } from "@/lib/session";

export type CoachActionState = { status: "applied" | "error"; message: string };

/** v1 reset the chat from the settings modal; v2 puts it on the coach page. */
export async function clearChatAction(): Promise<void> {
	const user = await requireUser();
	await clearChatMessages(user.id);
	// The coach panel lives in the root layout now, so it has to be
	// invalidated everywhere rather than on `/coach` alone.
	revalidatePath("/", "layout");
}

/**
 * The raw block comes from the client, so it is re-parsed and re-validated
 * here — and it can only ever rewrite the caller's own plan, the same
 * authority the day editor already has.
 */
export async function applyPlanChangeAction(raw: string): Promise<CoachActionState> {
	const user = await requireUser();

	const change = parsePlanChange(raw);
	if (!change) return { status: "error", message: "Couldn't read that plan change — ask the coach to resend it." };

	// Defense in depth. The thread only draws a live button on the newest
	// suggestion, but a tab left open since before the coach's next reply would
	// still be holding one — so the rule is re-derived here, from the same
	// helper and the same `CHAT_VIEW_LIMIT` window the thread renders.
	const history = await listChatMessages(user.id, CHAT_VIEW_LIMIT);
	const newest = history.find((message) => message.id === newestChangeMessageId(history));
	const key = planChangeKey(change);

	if (!newest || !planChangesIn(newest.content).some((candidate) => planChangeKey(candidate) === key)) {
		return {
			status: "error",
			message: "That suggestion has been superseded — ask the coach again if you still want it.",
		};
	}

	if (!(await applyPlanChange(user.id, change))) {
		return { status: "error", message: "Those weeks aren't in your plan any more." };
	}

	await revalidatePlanViews();
	// The coach panel lives in the root layout now, so it has to be
	// invalidated everywhere rather than on `/coach` alone.
	revalidatePath("/", "layout");

	const plural = change.changes.length > 1 ? "s" : "";
	return { status: "applied", message: `Plan updated — Week${plural} ${planChangeWeeks(change)}` };
}
