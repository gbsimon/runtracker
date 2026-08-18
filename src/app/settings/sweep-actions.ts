"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { describeSweepRecord, runMaintenanceSweep } from "@/lib/sweep";

export type SweepActionState = { status: "idle" | "done" | "busy" | "error"; message?: string };

/**
 * The manual trigger for the nightly sweep — for when weather has just come
 * back up, or the owner wants to see the model check run rather than wait for
 * 3am. Owner-only and checked here on the server: the button is simply absent
 * for members, which stops nobody from replaying the action.
 */
export async function runSweepNowAction(): Promise<SweepActionState> {
	const user = await requireUser();
	if (user.role !== "owner") return { status: "error", message: "Only the owner can run the maintenance sweep." };

	try {
		const outcome = await runMaintenanceSweep("manual");
		if (outcome.status !== "done") {
			return { status: "busy", message: "A sweep is already running — give it a minute and reload." };
		}

		revalidatePath("/settings");
		// Weather lands on runs, which both of these render.
		revalidatePath("/log");
		revalidatePath("/");
		return { status: "done", message: describeSweepRecord(outcome.record) };
	} catch (error) {
		return { status: "error", message: error instanceof Error ? error.message : "The sweep could not be started." };
	}
}
