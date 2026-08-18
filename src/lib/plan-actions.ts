"use server";

import { revalidatePath } from "next/cache";
import { coachErrorMessage } from "@/lib/anthropic";
import { generateAIPlanWeeks } from "@/lib/coach-plan";
import {
	regeneratePlan,
	savePlan,
	setHidePastWeeks,
	toggleWorkoutComplete,
	toggleWorkoutSkip,
	updatePlanDay,
	updatePlanSettings,
} from "@/lib/plan";
import { isDayAbbr, MIN_PLAN_WEEKS, type PlanDay, type PlanSettings } from "@/lib/plan-types";
import { isISODate, parsePace, weeksBetween } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { todayISO } from "@/lib/today";

export type PlanFormState = { status: "idle" | "saved" | "error"; message?: string; token?: number };

const WORKOUT_KEY = /^\d+-\d+$/;

function field(formData: FormData, name: string): string {
	return String(formData.get(name) ?? "").trim();
}

function saved(message: string): PlanFormState {
	return { status: "saved", message, token: Date.now() };
}

function failed(message: string): PlanFormState {
	return { status: "error", message };
}

export async function revalidatePlanViews(): Promise<void> {
	revalidatePath("/");
	revalidatePath("/log");
}

/** Shared by the setup form and the plan-settings panel. */
function readSettings(formData: FormData): PlanSettings | string {
	const startDate = field(formData, "startDate");
	const raceDate = field(formData, "raceDate");
	if (!isISODate(startDate) || !isISODate(raceDate)) return "Pick both a start date and a race date.";

	const weeks = weeksBetween(startDate, raceDate);
	if (weeks < MIN_PLAN_WEEKS) return `Set start and race dates at least ${MIN_PLAN_WEEKS} weeks apart.`;

	const selected = field(formData, "raceDistance");
	const raw = selected === "custom" ? field(formData, "customDistance") : selected;
	const raceDistance = Number.parseFloat(raw);
	if (!Number.isFinite(raceDistance) || raceDistance <= 0) return "Enter a race distance in kilometres.";

	const targetPace = field(formData, "targetPace");
	if (targetPace && parsePace(targetPace) <= 0) return "Target pace must look like 6:00 (min/km).";

	return {
		startDate,
		raceDate,
		raceDistance,
		targetPace,
		hidePastWeeks: formData.get("hidePastWeeks") !== "0",
	};
}

/**
 * v1's AI branch of `triggerGeneratePlan()`: when the model fails, fall back
 * to the default plan and say so, rather than leaving the runner with nothing.
 */
async function generatePlanWithAI(userId: string, settings: PlanSettings): Promise<PlanFormState> {
	try {
		const weeks = await generateAIPlanWeeks(userId, settings, weeksBetween(settings.startDate, settings.raceDate), await todayISO());
		await savePlan(userId, { settings, weeks });
		await revalidatePlanViews();
		return saved(`AI generated a ${weeks.length}-week plan`);
	} catch (error) {
		const weeks = await regeneratePlan(userId, settings);
		await revalidatePlanViews();
		return failed(`AI error: ${coachErrorMessage(error)} Generated the default ${weeks.length}-week plan instead.`);
	}
}

export async function createPlanAction(_previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
	const user = await requireUser();
	const settings = readSettings(formData);
	if (typeof settings === "string") return failed(settings);

	if (field(formData, "intent") === "ai") return generatePlanWithAI(user.id, settings);

	const weeks = await regeneratePlan(user.id, settings);
	await revalidatePlanViews();
	return saved(`Generated ${weeks.length}-week plan`);
}

/**
 * `intent=regenerate` rebuilds the plan from the saved settings and clears
 * completions, which is what v1's Settings → Regenerate Plan did.
 */
export async function savePlanSettingsAction(_previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
	const user = await requireUser();
	const settings = readSettings(formData);
	if (typeof settings === "string") return failed(settings);

	if (field(formData, "intent") === "regenerate") {
		const weeks = await regeneratePlan(user.id, settings);
		await revalidatePlanViews();
		return saved(`Plan regenerated for ${weeks.length} weeks`);
	}

	const updated = await updatePlanSettings(user.id, settings);
	if (!updated) return failed("No plan to update yet.");

	await revalidatePlanViews();
	return saved(updated.pacesUpdated ? "Paces updated across plan" : "Settings saved");
}

export async function toggleWorkoutAction(formData: FormData): Promise<void> {
	const user = await requireUser();
	const key = field(formData, "key");
	if (!WORKOUT_KEY.test(key)) return;
	await toggleWorkoutComplete(user.id, key);
	await revalidatePlanViews();
}

export async function toggleSkipAction(formData: FormData): Promise<void> {
	const user = await requireUser();
	const key = field(formData, "key");
	if (!WORKOUT_KEY.test(key)) return;
	await toggleWorkoutSkip(user.id, key);
	await revalidatePlanViews();
}

export async function setHidePastWeeksAction(hide: boolean): Promise<void> {
	const user = await requireUser();
	await setHidePastWeeks(user.id, hide === true);
	await revalidatePlanViews();
}

export async function updatePlanDayAction(_previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
	const user = await requireUser();

	const week = Number(field(formData, "week"));
	const dayIdx = Number(field(formData, "dayIdx"));
	const abbr = field(formData, "day");
	if (!Number.isInteger(week) || !Number.isInteger(dayIdx) || !isDayAbbr(abbr)) return failed("That workout is gone.");

	const distance = Number.parseFloat(field(formData, "distance").replace(",", "."));
	if (!Number.isFinite(distance) || distance < 0) return failed("Distance must be a non-negative number");

	const pace = field(formData, "pace");
	if (pace && parsePace(pace) <= 0) return failed("Pace must look like 6:00 (min/km).");

	const day: PlanDay = {
		day: abbr,
		type: field(formData, "type") || "Easy Run",
		distance,
		notes: field(formData, "notes"),
	};
	if (pace) day.pace = pace;

	if (!(await updatePlanDay(user.id, week, dayIdx, day))) return failed("That workout is gone.");

	await revalidatePlanViews();
	return saved("Workout updated");
}
