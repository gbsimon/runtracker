"use server";

import { revalidatePath } from "next/cache";
import { coachErrorMessage } from "@/lib/anthropic";
import { generateAIOpenBlock, generateAIPlanWeeks } from "@/lib/coach-plan";
import { appendWeeks, OPEN_PHASES, planExtension } from "@/lib/plan-generator";
import {
	extendPlan,
	getPlan,
	recentWeeklyKm,
	regeneratePlan,
	savePlan,
	setHidePastWeeks,
	toggleWorkoutComplete,
	toggleWorkoutSkip,
	updatePlanDay,
	updatePlanSettings,
} from "@/lib/plan";
import {
	DEFAULT_RACE_DISTANCE,
	isDayAbbr,
	isOpenMode,
	MIN_PLAN_WEEKS,
	normalizeGoal,
	normalizeGoalMode,
	OPEN_BLOCK_WEEKS,
	type PlanDay,
	type PlanSettings,
	type PlanWeek,
	raceLabel,
} from "@/lib/plan-types";
import { formatPace, isISODate, parsePace, todayISOInZone, weeksBetween } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { todayISO, userTimeZone } from "@/lib/today";

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

/**
 * Shared by the setup form and the plan-settings panel. The goal fields are
 * read from the form when it posts them and otherwise kept from `current`,
 * so a form that doesn't carry them can never quietly reset them.
 */
function readSettings(formData: FormData, current: PlanSettings | null = null): PlanSettings | string {
	const goalMode = normalizeGoalMode(formData.has("goalMode") ? field(formData, "goalMode") : current?.goalMode);
	const goal = normalizeGoal(formData.has("goal") ? field(formData, "goal") : current?.goal);
	if (goalMode === "open") return readOpenSettings(formData, goal, current);

	const race = readRaceSettings(formData);
	if (typeof race === "string") return race;
	return { ...race, goalMode, goal };
}

/** Race mode's rules, unchanged from before open mode existed. */
function readRaceSettings(formData: FormData): PlanSettings | string {
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
		targetPace: targetPace ? formatPace(parsePace(targetPace)) : targetPace,
		hidePastWeeks: formData.get("hidePastWeeks") !== "0",
	};
}

/**
 * Open mode needs a start date (week 1's anchor) and nothing else. The race
 * fields become the optional "last race" the coach is told about, and are
 * kept rather than wiped when left blank.
 */
function readOpenSettings(formData: FormData, goal: string, current: PlanSettings | null): PlanSettings | string {
	const startDate = field(formData, "startDate");
	if (!isISODate(startDate)) return "Pick a start date.";

	const raceDate = field(formData, "raceDate");
	if (raceDate && !isISODate(raceDate)) return "Pick a valid date for your last race, or leave it empty.";

	const selected = field(formData, "raceDistance");
	const raw = selected === "custom" ? field(formData, "customDistance") : selected;
	const parsed = Number.parseFloat(raw);
	const raceDistance =
		Number.isFinite(parsed) && parsed > 0 ? parsed : (current?.raceDistance ?? DEFAULT_RACE_DISTANCE);

	const targetPace = field(formData, "targetPace");
	if (targetPace && parsePace(targetPace) <= 0) return "Target pace must look like 6:00 (min/km).";

	return {
		startDate,
		raceDate,
		raceDistance,
		targetPace: targetPace ? formatPace(parsePace(targetPace)) : targetPace,
		hidePastWeeks: formData.get("hidePastWeeks") !== "0",
		goalMode: "open",
		goal,
	};
}

/**
 * v1's AI branch of `triggerGeneratePlan()`: when the model fails, fall back
 * to the default plan and say so, rather than leaving the runner with nothing.
 */
async function generatePlanWithAI(userId: string, settings: PlanSettings): Promise<PlanFormState> {
	if (isOpenMode(settings)) return generateOpenPlanWithAI(userId, settings);
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

/**
 * Open mode's first block, with the same fall-back-and-say-so as above. It is
 * placed like the standard one: at the current calendar week, after empty
 * "Off Plan" weeks when the start date is in the past.
 */
async function generateOpenPlanWithAI(userId: string, settings: PlanSettings): Promise<PlanFormState> {
	const today = await todayISO();
	try {
		const recent = await recentWeeklyKm(userId, today, await userTimeZone());
		const { gap, firstWeek } = planExtension([], settings.startDate, today);
		const block = await generateAIOpenBlock(userId, {
			settings,
			weeks: [],
			firstWeek,
			count: OPEN_BLOCK_WEEKS,
			recentWeeklyKm: recent,
			today,
		});
		const weeks = appendWeeks([], gap, block.slice(0, OPEN_BLOCK_WEEKS));
		await savePlan(userId, { settings, weeks });
		await revalidatePlanViews();
		return saved(`AI generated a ${block.length}-week block`);
	} catch (error) {
		await regeneratePlan(userId, settings, today);
		await revalidatePlanViews();
		return failed(`AI error: ${coachErrorMessage(error)} Generated the standard ${OPEN_BLOCK_WEEKS}-week block instead.`);
	}
}

/** `weeks.length` would count the empty "Off Plan" weeks too, so name the block instead. */
function openBlockMessage(verb: string, weeks: PlanWeek[]): string {
	const block = weeks.filter((week) => week.days.length > 0 || week.phase !== OPEN_PHASES.gap);
	return `${verb} a ${block.length}-week block from week ${block[0]?.week ?? 1}`;
}

export async function createPlanAction(_previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
	const user = await requireUser();
	const settings = readSettings(formData);
	if (typeof settings === "string") return failed(settings);

	if (field(formData, "intent") === "ai") return generatePlanWithAI(user.id, settings);

	const weeks = await regeneratePlan(user.id, settings, await todayISO());
	await revalidatePlanViews();
	if (isOpenMode(settings)) return saved(openBlockMessage("Generated", weeks));
	return saved(`Generated ${weeks.length}-week plan`);
}

/**
 * `intent=regenerate` rebuilds the plan from the saved settings and clears
 * completions, which is what v1's Settings → Regenerate Plan did.
 */
export async function savePlanSettingsAction(_previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
	const user = await requireUser();
	const settings = readSettings(formData, (await getPlan(user.id))?.settings ?? null);
	if (typeof settings === "string") return failed(settings);

	if (field(formData, "intent") === "regenerate") {
		const weeks = await regeneratePlan(user.id, settings, await todayISO());
		await revalidatePlanViews();
		if (isOpenMode(settings)) return saved(openBlockMessage("Regenerated", weeks));
		return saved(`Plan regenerated for ${weeks.length} weeks`);
	}

	const updated = await updatePlanSettings(user.id, settings);
	if (!updated) return failed("No plan to update yet.");

	await revalidatePlanViews();
	return saved(updated.pacesUpdated ? "Paces updated across plan" : "Settings saved");
}

/**
 * Open mode's "Plan next 4 weeks". Appends only — `extendPlan` never rewrites
 * a week that's already there — and, like plan creation, falls back to the
 * standard block when the AI fails and says so.
 */
export async function extendPlanAction(_previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
	const user = await requireUser();
	const plan = await getPlan(user.id);
	if (!plan || !isOpenMode(plan.settings)) return failed("Switch the plan to “Keep training” first.");

	const zone = await userTimeZone();
	const useAI = field(formData, "intent") === "ai";
	const result = await extendPlan(user.id, OPEN_BLOCK_WEEKS, {
		today: todayISOInZone(zone),
		zone,
		ai: useAI ? (request) => generateAIOpenBlock(user.id, request) : undefined,
	});
	if (!result) return failed("No plan to extend yet.");

	await revalidatePlanViews();
	const first = result.added[0]?.week;
	const last = result.added.at(-1)?.week;
	const range = first === last ? `week ${first}` : `weeks ${first}–${last}`;
	if (result.aiError) {
		return failed(`AI error: ${coachErrorMessage(result.aiError)} Added the standard block (${range}) instead.`);
	}
	return saved(`${useAI ? "AI planned" : "Added"} ${range}`);
}

export type KeepTrainingState = { status: "ok"; kickoff: string } | { status: "error"; message: string };

/** "I finished my half marathon!" / "I finished my 10K!" */
function kickoffMessage(settings: PlanSettings): string {
	const label = raceLabel(settings.raceDistance);
	const race = /K$/.test(label) ? label : label.toLowerCase();
	return `I finished my ${race}! Help me set up what's next.`;
}

/**
 * The post-race "Keep training" button: flips the plan to open mode without
 * regenerating anything — every past week, completion and skip stays — and
 * appends a first standard block so there is something to train on while
 * the coach and the runner settle the objective. Pressed twice, the second
 * press finds the plan already open and adds nothing.
 */
export async function startOpenTrainingAction(): Promise<KeepTrainingState> {
	const user = await requireUser();
	const plan = await getPlan(user.id);
	if (!plan || plan.weeks.length === 0) return { status: "error", message: "There's no plan to continue yet." };

	if (!isOpenMode(plan.settings)) {
		const zone = await userTimeZone();
		await updatePlanSettings(user.id, { goalMode: "open" });
		await extendPlan(user.id, OPEN_BLOCK_WEEKS, { today: todayISOInZone(zone), zone });
	}

	await revalidatePlanViews();
	// The coach panel reads the mode from the root layout.
	revalidatePath("/", "layout");
	return { status: "ok", kickoff: kickoffMessage(plan.settings) };
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
	if (pace) day.pace = formatPace(parsePace(pace));

	if (!(await updatePlanDay(user.id, week, dayIdx, day))) return failed("That workout is gone.");

	await revalidatePlanViews();
	return saved("Workout updated");
}
