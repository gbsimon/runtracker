"use server";

import { revalidatePath } from "next/cache";
import { findMatchingWorkout, getPlan, markWorkoutComplete, movePlanDay } from "@/lib/plan";
import { workoutKey } from "@/lib/plan-types";
import { createManualRun, deleteRun, type ManualRunInput, updateRun } from "@/lib/runs";
import { isISODate, parseDuration, planWeekOfISO, weekdayAbbrISO } from "@/lib/running";
import { requireUser } from "@/lib/session";

export type RunFormState = {
	status: "idle" | "saved" | "error";
	message?: string;
	token?: number;
	/** Which plan-day prefill this save used up, so the form stops reusing it. */
	consumed?: string;
};

const TIME = /^\d{2}:\d{2}$/;

function field(formData: FormData, name: string): string {
	return String(formData.get(name) ?? "").trim();
}

function revalidateRunViews(): void {
	revalidatePath("/");
	revalidatePath("/log");
}

function readRun(formData: FormData): ManualRunInput | string {
	const date = field(formData, "date");
	if (!isISODate(date)) return "Pick the date you ran.";

	const time = field(formData, "time");
	if (time && !TIME.test(time)) return "Time of day must look like 07:30.";

	const distanceKm = Number.parseFloat(field(formData, "distance").replace(",", "."));
	if (!Number.isFinite(distanceKm) || distanceKm <= 0) return "Distance must be a number of kilometres.";

	const durationS = parseDuration(field(formData, "duration"));
	if (!durationS) return "Duration must look like 30:00 (mm:ss).";

	const effortRaw = field(formData, "effort");
	const effort = effortRaw ? Number(effortRaw) : null;
	if (effort !== null && (!Number.isInteger(effort) || effort < 1 || effort > 10)) return "Effort runs from 1 to 10.";

	return { date, time, distanceKm, durationS, effort, notes: field(formData, "notes"), timezone: field(formData, "timezone") };
}

/** Identifies the plan day a prefilled form came from; empty when it didn't. */
function prefillSignature(formData: FormData): string {
	const week = field(formData, "originWeek");
	const dayIdx = field(formData, "originDayIdx");
	const plannedDate = field(formData, "plannedDate");
	return week && dayIdx && plannedDate ? `${week}-${dayIdx}-${plannedDate}` : "";
}

/**
 * Port of v1's `logRun`: a run logged from a plan day completes that exact
 * workout (and moves the planned day if it slid within the same week);
 * otherwise any uncompleted workout already sitting on that date is checked
 * off.
 */
async function completePlanDay(userId: string, formData: FormData, date: string): Promise<boolean> {
	const plan = await getPlan(userId);
	if (!plan) return false;

	const week = Number(field(formData, "originWeek"));
	const dayIdx = Number(field(formData, "originDayIdx"));
	const plannedDate = field(formData, "plannedDate");
	const origin = Number.isInteger(week) && Number.isInteger(dayIdx) ? plan.weeks.find((w) => w.week === week) : undefined;

	if (origin?.days[dayIdx]) {
		await markWorkoutComplete(userId, workoutKey(week, dayIdx));
		if (date !== plannedDate && planWeekOfISO(plan.settings.startDate, date) === week) {
			await movePlanDay(userId, week, dayIdx, weekdayAbbrISO(date));
		}
		return true;
	}

	const key = findMatchingWorkout(plan, date);
	if (!key) return false;
	await markWorkoutComplete(userId, key);
	return true;
}

export async function createRunAction(_previous: RunFormState, formData: FormData): Promise<RunFormState> {
	const user = await requireUser();
	const input = readRun(formData);
	if (typeof input === "string") return { status: "error", message: input };

	await createManualRun(user.id, input);
	const matched = await completePlanDay(user.id, formData, input.date);

	revalidateRunViews();
	return {
		status: "saved",
		message: matched ? "Run logged & workout checked off! 🎉" : "Run logged! 🎉",
		token: Date.now(),
		consumed: prefillSignature(formData),
	};
}

export async function updateRunAction(_previous: RunFormState, formData: FormData): Promise<RunFormState> {
	const user = await requireUser();
	const id = field(formData, "id");
	const input = readRun(formData);
	if (typeof input === "string") return { status: "error", message: input };

	if (!(await updateRun(user.id, id, input))) return { status: "error", message: "That run is gone." };

	revalidateRunViews();
	return { status: "saved", message: "Run updated", token: Date.now() };
}

export async function deleteRunAction(formData: FormData): Promise<void> {
	const user = await requireUser();
	const id = field(formData, "id");
	if (!id) return;
	await deleteRun(user.id, id);
	revalidateRunViews();
}
