import type Anthropic from "@anthropic-ai/sdk";
import { isOverDailyLimit, limitReachedMessage, recordMessageUsage } from "./ai-usage";
import { COACH_REQUEST_DEFAULTS, getAnthropic } from "./anthropic";
import { recoverySummary } from "./coach-context";
import { withCoachModel } from "./coach-model";
import { getDailyMetrics } from "./daily-metrics";
import { errorFields, logEvent, usageFields, userTag } from "./log";
import type { OpenBlockRequest } from "./plan";
import { normalizePlanDay, type PlanDay, type PlanSettings, type PlanWeek, raceLabel } from "./plan-types";
import { listRuns, runDistanceKm } from "./runs";
import { formatDuration, formatKm, isISODate, paceSeconds } from "./running";

/**
 * Port of v1's `generateAIPlan()`. Kept out of the `"use server"` action file
 * on purpose: every export there is a callable endpoint, and this function
 * takes a `userId`, so exposing it would let anyone spend another runner's
 * budget. `plan-actions.ts` calls it with an id from `requireUser()`.
 */

/**
 * A long race plan — 20-plus weeks, every day with notes and a pace — runs to
 * roughly 8–10K output tokens; 32K leaves a wide margin. Anything above ~21K
 * must be streamed: this SDK refuses a non-streaming request whose
 * `max_tokens` implies more than ten minutes of generation
 * (`calculateNonstreamingTimeout`). Sonnet 5's own ceiling is 128K, but the
 * plan actions answer one HTTP request, and 32K keeps the slowest case well
 * inside Railway's 15-minute request limit.
 */
const MAX_TOKENS = 32_000;
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

/**
 * The model stopped before the plan was complete. Its message is what the
 * runner reads in front of "Generated the default plan instead", so it says
 * what happened in plain words.
 */
export class PlanTruncatedError extends Error {
	constructor() {
		super("The AI plan was cut off before it finished.");
		this.name = "PlanTruncatedError";
	}
}

type PlanCall = { kind: "race_plan" | "open_block"; userId: string; today: string; system: string; content: string; weeks: number };

/**
 * One AI plan request: budget gate, model fallback, streamed (so a large
 * `max_tokens` is allowed), usage metered, stop reason checked, and exactly
 * one `[plan-ai]` log line whatever happens. Throws on any failure so the
 * callers fall back to the standard plan and say so.
 */
async function requestPlanText(call: PlanCall, parse: (text: string) => PlanWeek[]): Promise<PlanWeek[]> {
	const started = Date.now();
	let model = "";
	let response: Anthropic.Message | null = null;
	let parsed: PlanWeek[] | null = null;

	try {
		if (await isOverDailyLimit(call.userId, call.today)) throw new CoachBudgetError();

		response = await withCoachModel((candidate) => {
			model = candidate;
			return getAnthropic()
				.messages.stream({
					...COACH_REQUEST_DEFAULTS,
					model: candidate,
					max_tokens: MAX_TOKENS,
					system: call.system,
					messages: [{ role: "user", content: call.content }],
				})
				.finalMessage();
		});

		await recordMessageUsage(call.userId, call.today, response.usage);

		if (response.stop_reason === "refusal") throw new Error("The AI declined to write this plan.");
		// A cut-off array can still contain a `]` that closes an inner `days`
		// list, so this is checked before parsing rather than left to JSON.parse.
		if (response.stop_reason === "max_tokens") throw new PlanTruncatedError();

		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		parsed = parse(text);
		return parsed;
	} catch (error) {
		logEvent("plan-ai", call.kind, {
			user: userTag(call.userId),
			model: model || null,
			stopReason: response?.stop_reason ?? null,
			...usageFields(response?.usage),
			durationMs: Date.now() - started,
			weeksRequested: call.weeks,
			outcome: error instanceof CoachBudgetError ? "over_budget" : "failed",
			fallback: true,
			...errorFields(error),
		});
		throw error;
	} finally {
		if (parsed) {
			logEvent("plan-ai", call.kind, {
				user: userTag(call.userId),
				model,
				stopReason: response?.stop_reason ?? null,
				...usageFields(response?.usage),
				durationMs: Date.now() - started,
				weeksRequested: call.weeks,
				weeksReturned: parsed.length,
				outcome: "ok",
			});
		}
	}
}

/** The array can arrive wrapped in prose or a code fence. */
function parseWeeksArray(text: string): unknown {
	const match = text.match(/\[[\s\S]*\]/);
	if (!match) throw new Error("Could not parse plan from AI response");
	try {
		return JSON.parse(match[0]);
	} catch {
		throw new Error("Could not parse plan from AI response");
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
	const content = `Create a ${numWeeks}-week ${raceLabel(settings.raceDistance)} training plan for a beginner runner.\n\n${await runnerContext(userId, today)}`;

	return requestPlanText(
		{ kind: "race_plan", userId, today, system: systemPrompt(numWeeks, settings), content, weeks: numWeeks },
		(text) => {
			const weeks = normalizeWeeks(parseWeeksArray(text));
			if (weeks.length === 0 || weeks.every((week) => week.days.length === 0)) {
				throw new Error("The AI returned an empty plan");
			}
			return weeks;
		},
	);
}

// ---------------------------------------------------------------------------
// Open mode — the next block of a rolling plan
// ---------------------------------------------------------------------------

/** A few weeks of the existing plan is enough for the model to continue it. */
const PLAN_TAIL_WEEKS = 4;

function openBlockSystemPrompt(request: OpenBlockRequest): string {
	const { firstWeek, count, settings } = request;
	const lastWeek = firstWeek + count - 1;
	const paceRule = settings.targetPace
		? `\n- The runner's reference pace is ${settings.targetPace} min/km. Include a "pace" field (string, format "M:SS" e.g. "6:00") for each workout with the suggested pace. Easy runs ~60-90s slower than that pace, long runs ~45-75s slower, tempo ~10s slower, intervals ~20s faster.`
		: "";

	return `You are an expert running coach. Output ONLY a valid JSON array, no other text, no markdown.

The runner is in open-ended training: there is no target race. Write the NEXT ${count} weeks of their rolling plan, continuing from where the current plan ends. The array has EXACTLY ${count} entries, numbered ${firstWeek} to ${lastWeek}.

Each entry: {"week": <${firstWeek}-${lastWeek}>, "phase": "<phase>", "days": [{"day": "<Day>", "type": "<type>", "distance": <km>, "notes": "<note>"}]}

RULES:
- Day values MUST be: Mon, Tue, Wed, Thu, Fri, Sat, or Sun
- Do NOT include any calendar dates — only day-of-week abbreviations
- Phase names: "Recovery", "Progression", "Recovery Week", "Maintenance"
- Workout types: "Easy Run", "Long Run", "Tempo Run", "Intervals", "Race Pace", "Shakeout", "Rest"
- No race day and no taper — this block builds fitness toward the runner's objective
- In each run of 4 weeks, build for 3 weeks and make the 4th lighter ("Recovery Week")
- Size week 1 from the runner's recent actual weekly volume, then grow no more than ~10% a week
- If the runner raced in the last two weeks, start with an easy "Recovery" week
- 3-4 runs a week unless the objective or the runner's history says otherwise
- Distances in km, numbers only (no units in the value)${paceRule}`;
}

function planTail(weeks: PlanWeek[]): string {
	const tail = weeks.slice(-PLAN_TAIL_WEEKS);
	if (tail.length === 0) return "";
	return `\nLast weeks of the current plan:\n${tail
		.map(
			(week) =>
				`Week ${week.week} (${week.phase}): ${
					week.days.length === 0
						? "nothing planned"
						: week.days.map((day) => `${day.day} ${day.type} ${day.distance}km`).join(", ")
				}`,
		)
		.join("\n")}`;
}

/**
 * The AI branch of an open-mode extension. Same budget gate, same model
 * fallback and same tolerant parsing as `generateAIPlanWeeks`; the race-mode
 * prompt above is left exactly as it was. Throws on any failure so
 * `extendPlan` can drop back to the standard block.
 */
export async function generateAIOpenBlock(userId: string, request: OpenBlockRequest): Promise<PlanWeek[]> {
	const { settings, today } = request;

	const objective = settings.goal ? `Objective: ${settings.goal}` : "Objective: not set yet — build general fitness.";
	const lastRace = isISODate(settings.raceDate)
		? `Last race: ${raceLabel(settings.raceDistance)} (${settings.raceDistance}km) on ${settings.raceDate}.`
		: "";
	const volume = request.recentWeeklyKm.length
		? `Recent weekly volume, oldest first: ${request.recentWeeklyKm.map((km) => `${km.toFixed(1)}km`).join(", ")}.`
		: "";

	const content = `Write weeks ${request.firstWeek}-${request.firstWeek + request.count - 1} of an open-ended training plan. Today is ${today}.
${objective}
${lastRace}
${volume}${planTail(request.weeks)}

${await runnerContext(userId, today)}`;

	return requestPlanText(
		{ kind: "open_block", userId, today, system: openBlockSystemPrompt(request), content, weeks: request.count },
		(text) => {
			// Renumbered from the block's first week, so a model that counted from 1
			// still lands in the right place.
			const weeks = normalizeWeeks(parseWeeksArray(text)).map((week, i) => ({ ...week, week: request.firstWeek + i }));
			if (weeks.length === 0 || weeks.every((week) => week.days.length === 0)) {
				throw new Error("The AI returned an empty plan");
			}
			return weeks;
		},
	);
}
