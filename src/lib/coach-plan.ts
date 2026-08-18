import { isOverDailyLimit, limitReachedMessage, recordMessageUsage } from "./ai-usage";
import { COACH_REQUEST_DEFAULTS, getAnthropic } from "./anthropic";
import { recoverySummary } from "./coach-context";
import { withCoachModel } from "./coach-model";
import { getDailyMetrics } from "./daily-metrics";
import { normalizePlanDay, type PlanDay, type PlanSettings, type PlanWeek, raceLabel } from "./plan-types";
import { listRuns, runDistanceKm } from "./runs";
import { formatDuration, formatKm, paceSeconds } from "./running";

/**
 * Port of v1's `generateAIPlan()`. Kept out of the `"use server"` action file
 * on purpose: every export there is a callable endpoint, and this function
 * takes a `userId`, so exposing it would let anyone spend another runner's
 * budget. `plan-actions.ts` calls it with an id from `requireUser()`.
 */

const MAX_TOKENS = 16000;
const RECENT_RUNS = 10;
/** Enough recovery history to tell "rested" from "run down" without a whole physiology dump. */
const RECOVERY_DAYS = 7;

/** Distinguishes "you're out of budget" from a genuine API failure. */
export class CoachBudgetError extends Error {
	constructor() {
		super(limitReachedMessage());
		this.name = "CoachBudgetError";
	}
}

async function runnerContext(userId: string, today: string): Promise<string> {
	// The recovery read is a nicety on top of the plan inputs — a metrics table
	// that isn't there yet must not stop a runner generating their first plan.
	const [runs, recovery] = await Promise.all([
		listRuns(userId),
		getDailyMetrics(userId, { days: RECOVERY_DAYS, endDay: today }).catch(() => null),
	]);
	const totalKm = runs.reduce((sum, run) => sum + runDistanceKm(run), 0);
	let context = `Beginner runner. ${runs.length} total runs logged, ${totalKm.toFixed(1)} km total.`;

	// `listRuns` is newest-first; v1 read the tail of its append-ordered log.
	const recent = runs.slice(0, RECENT_RUNS).reverse();
	if (recent.length > 0) {
		context += `\nRecent runs:\n${recent
			.map((run) => {
				const distance = runDistanceKm(run);
				const pace = paceSeconds(distance, run.durationS);
				const effort = run.effort ?? 5;
				return `${run.startedAt.toISOString().slice(0, 10)}: ${formatKm(distance)}km in ${formatDuration(run.durationS)} (${
					pace > 0 ? formatDuration(pace) : "?"
				} /km, effort ${effort}/10)`;
			})
			.join("\n")}`;
	}

	return context + recoverySummary(recovery);
}

function systemPrompt(numWeeks: number, settings: PlanSettings): string {
	const distance = settings.raceDistance;
	const label = raceLabel(distance);
	const paceRule = settings.targetPace
		? `\n- The runner's target race pace is ${settings.targetPace} min/km. Include a "pace" field (string, format "M:SS" e.g. "6:00") for each workout with the suggested pace. Easy runs ~60-90s slower than race pace, long runs ~45-75s slower, tempo ~10s slower, intervals ~20s faster, race pace = exact target.`
		: "";

	return `You are an expert running coach. Output ONLY a valid JSON array, no other text, no markdown.

Create a ${label} (${distance}km) training plan with EXACTLY ${numWeeks} entries in the array (one per week, numbered 1 to ${numWeeks}).

Each entry: {"week": <1-${numWeeks}>, "phase": "<phase>", "days": [{"day": "<Day>", "type": "<type>", "distance": <km>, "notes": "<note>"}]}

RULES:
- Day values MUST be: Mon, Tue, Wed, Thu, Fri, Sat, or Sun
- Do NOT include any calendar dates — only day-of-week abbreviations
- Phase names: "Base Building", "Building Volume", "Peak Training", "Taper", "Race Week!"
- Workout types: "Easy Run", "Long Run", "Tempo Run", "Intervals", "Race Pace", "Shakeout", "Rest"
- Week ${numWeeks} is race week. Its last workout MUST be: {"day": "Sun", "type": "🏁 RACE DAY", "distance": ${distance}, "notes": "${label}! Trust your training."}
- 3 runs/week in base building, 3-4 in build/peak, 2-3 in taper
- Long run peaks around ${Math.round(distance * 0.9)}km before tapering
- Scale all distances appropriately for a ${distance}km race
- Distances in km, numbers only (no units in the value)${paceRule}`;
}

/**
 * Force-renumbers the weeks and drops days whose abbreviation the model
 * invented — v1's post-processing, which is why a slightly off response still
 * produces a usable plan instead of an error.
 */
function normalizeWeeks(raw: unknown): PlanWeek[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((entry, index) => {
		const source = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
		const days = Array.isArray(source.days) ? source.days : [];
		return {
			week: index + 1,
			phase: typeof source.phase === "string" && source.phase ? source.phase : "Training",
			days: days.map(normalizePlanDay).filter((day): day is PlanDay => day !== null),
		};
	});
}

export async function generateAIPlanWeeks(
	userId: string,
	settings: PlanSettings,
	numWeeks: number,
	today: string,
): Promise<PlanWeek[]> {
	if (await isOverDailyLimit(userId, today)) throw new CoachBudgetError();

	const content = `Create a ${numWeeks}-week ${raceLabel(settings.raceDistance)} training plan for a beginner runner.\n\n${await runnerContext(userId, today)}`;

	const response = await withCoachModel((model) =>
		getAnthropic().messages.create({
			...COACH_REQUEST_DEFAULTS,
			model,
			max_tokens: MAX_TOKENS,
			system: systemPrompt(numWeeks, settings),
			messages: [{ role: "user", content }],
		}),
	);

	await recordMessageUsage(userId, today, response.usage);

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");

	// The array can arrive wrapped in prose or a code fence.
	const match = text.match(/\[[\s\S]*\]/);
	if (!match) throw new Error("Could not parse plan from AI response");

	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		throw new Error("Could not parse plan from AI response");
	}

	const weeks = normalizeWeeks(parsed);
	if (weeks.length === 0 || weeks.every((week) => week.days.length === 0)) {
		throw new Error("The AI returned an empty plan");
	}

	return weeks;
}
