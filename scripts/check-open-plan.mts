/**
 * Unit checks for open-ended ("keep training") plans, and for the backwards
 * compatibility they promise race-mode plans.
 *
 *   pnpm check:open-plan
 *
 * Everything here runs on fixtures — no database, no network, no API key. The
 * DB-bound halves (`extendPlan`, `applyPlanChange`) are thin wrappers around
 * the pure functions exercised here: `planExtension` + `generateOpenBlock` +
 * `appendWeeks`, and `applyChangeToPlan`.
 */

import { buildCoachContext, buildCoachSystemPrompt, type CoachData, openRunnerProfile } from "../src/lib/coach-context.ts";
import { readV1Backup } from "../src/lib/import-v1.ts";
import type { PlanRecord } from "../src/lib/plan.ts";
import {
	appendedWeeks,
	applyChangeToPlan,
	firstCompletePlanChange,
	hasUnclosedPlanChange,
	isPlanChangeApplied,
	parsePlanChange,
	planChangeKey,
	planChangeLabel,
	planChangesIn,
	planChangeStatus,
	type PlanSnapshot,
	splitMessage,
	stitchPlanChangeRetry,
	textBeforeUnclosedPlanChange,
} from "../src/lib/plan-change.ts";
import {
	appendWeeks,
	baselineWeeklyKm,
	generateDefaultPlan,
	generateInitialOpenPlan,
	generateOpenBlock,
	OPEN_PHASES,
	planExtension,
} from "../src/lib/plan-generator.ts";
import {
	MAX_GOAL_LENGTH,
	normalizePlanSettings,
	orderWeeksForDisplay,
	planSettingsDefaults,
	type PlanSettings,
	type PlanWeek,
} from "../src/lib/plan-types.ts";
import { addDaysISO, planWeekOfISO, weekMondayISO } from "../src/lib/running.ts";

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed += 1;
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures.push(label);
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq(label: string, actual: unknown, expected: unknown): void {
	check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** Structural equality through JSON — every value here is plain data. */
function same(label: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	check(label, a === b, a === b ? "" : `got ${a}, want ${b}`);
}

function has(label: string, haystack: string, needle: string): void {
	check(label, haystack.includes(needle), haystack.includes(needle) ? "" : `missing ${JSON.stringify(needle)}`);
}

function lacks(label: string, haystack: string, needle: string): void {
	check(label, !haystack.includes(needle), haystack.includes(needle) ? `unexpected ${JSON.stringify(needle)}` : "");
}

function section(title: string): void {
	console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Fixtures — a 12-week half-marathon plan, race on Sunday 2026-10-18
// ---------------------------------------------------------------------------

const START = "2026-07-27"; // a Monday
const RACE = "2026-10-18";

/** Exactly what a row saved before open mode holds. */
const OLD_SETTINGS = {
	startDate: START,
	raceDate: RACE,
	raceDistance: 21.1,
	targetPace: "6:00",
	hidePastWeeks: false,
};

const RACE_WEEKS = generateDefaultPlan(12, OLD_SETTINGS);
const LAST = RACE_WEEKS.length;

/** The Thursday of plan week `week`. */
function dayInWeek(week: number): string {
	return addDaysISO(weekMondayISO(START, week), 3);
}

// ---------------------------------------------------------------------------

section("Settings: old rows normalise to race mode, unchanged");
{
	const normalized = normalizePlanSettings(OLD_SETTINGS);
	same("every old key keeps its value, the new two are defaults", normalized, { ...OLD_SETTINGS, goalMode: "race", goal: "" });
	for (const key of Object.keys(OLD_SETTINGS) as (keyof typeof OLD_SETTINGS)[]) {
		eq(`…${key} is identical`, normalized[key], OLD_SETTINGS[key]);
	}
	eq("absent hidePastWeeks is still hidden", normalizePlanSettings({ ...OLD_SETTINGS, hidePastWeeks: undefined }).hidePastWeeks, true);
	eq("an invalid goalMode is race", normalizePlanSettings({ ...OLD_SETTINGS, goalMode: "marathon" }).goalMode, "race");
	eq("a non-string goal is empty", normalizePlanSettings({ ...OLD_SETTINGS, goal: 42 }).goal, "");
	eq("defaults are race mode", planSettingsDefaults().goalMode, "race");
	eq("…with an empty objective", planSettingsDefaults().goal, "");
	same("normalising twice is a no-op", normalizePlanSettings(normalized), normalized);
}

section("Settings: open mode");
{
	const open = normalizePlanSettings({ ...OLD_SETTINGS, goalMode: "open", goal: "  Sub-25 5K by March  " });
	eq("open survives", open.goalMode, "open");
	eq("the objective is trimmed", open.goal, "Sub-25 5K by March");
	eq("the last race is kept, not wiped", open.raceDate, RACE);
	eq("…and its distance", open.raceDistance, 21.1);
	eq("an over-long objective is capped", normalizePlanSettings({ goalMode: "open", goal: "x".repeat(900) }).goal?.length, MAX_GOAL_LENGTH);
}

section("Backup round-trip (v1 importer reads v2 exports)");
{
	const openSettings: PlanSettings = { ...OLD_SETTINGS, goalMode: "open", goal: "Build to 40km weeks" };
	const restored = readV1Backup({ settings: openSettings, runLog: [], plan: RACE_WEEKS });
	check("an open export imports", typeof restored !== "string");
	if (typeof restored !== "string") {
		eq("…as open mode", restored.settings.goalMode, "open");
		eq("…with its objective", restored.settings.goal, "Build to 40km weeks");
	}

	const old = readV1Backup({ settings: OLD_SETTINGS, runLog: [] });
	if (typeof old !== "string") {
		eq("an export without the keys imports as race mode", old.settings.goalMode, "race");
		eq("…with no objective", old.settings.goal, "");
	} else {
		check("an export without the keys imports", false, old);
	}
}

section("Week ordering: current + upcoming ascending, then past newest-first");
{
	const weeks = [1, 2, 3, 4, 5, 6].map((week) => ({ week }));
	same("mid-plan", orderWeeksForDisplay(weeks, 3).map((w) => w.week), [3, 4, 5, 6, 2, 1]);
	same("first week is plain ascending", orderWeeksForDisplay(weeks, 1).map((w) => w.week), [1, 2, 3, 4, 5, 6]);
	same("last week puts history after it", orderWeeksForDisplay(weeks, 6).map((w) => w.week), [6, 5, 4, 3, 2, 1]);
	same("input order doesn't matter", orderWeeksForDisplay([{ week: 4 }, { week: 1 }, { week: 3 }, { week: 2 }], 2).map((w) => w.week), [2, 3, 4, 1]);
	eq("nothing is dropped or duplicated", orderWeeksForDisplay(weeks, 4).length, weeks.length);
	same("the input array is left alone", weeks.map((w) => w.week), [1, 2, 3, 4, 5, 6]);
}

section("generateOpenBlock: shape and numbering");
{
	const block = generateOpenBlock({ firstWeek: 13, recentWeeklyKm: [22, 26, 18, 36], targetPace: "6:00" });
	same("four weeks numbered from the first", block.map((w) => w.week), [13, 14, 15, 16]);
	same("three building weeks then a lighter one", block.map((w) => w.phase), [
		OPEN_PHASES.progression,
		OPEN_PHASES.progression,
		OPEN_PHASES.progression,
		OPEN_PHASES.recovery,
	]);
	const km = block.map((w) => w.days.reduce((sum, d) => sum + d.distance, 0));
	check("volume builds over the first three", km[0] < km[1] && km[1] < km[2], km.join(" → "));
	check("…and drops in the fourth", km[3] < km[2], km.join(" → "));
	check("no race day anywhere", block.every((w) => w.days.every((d) => !d.type.includes("RACE"))));
	check("every day has a pace from the target", block.every((w) => w.days.every((d) => Boolean(d.pace))));
	check("no run under 2km", block.every((w) => w.days.every((d) => d.distance >= 2)));
	same("a ~25km base runs Tue/Wed/Fri/Sun when building", block[1].days.map((d) => d.day), ["Tue", "Wed", "Fri", "Sun"]);
	same("…and Tue/Thu/Sun in the lighter week", block[3].days.map((d) => d.day), ["Tue", "Thu", "Sun"]);

	const light = generateOpenBlock({ firstWeek: 1, recentWeeklyKm: [0, 0, 0, 0], targetPace: "" });
	same("no recent running falls back to a small 3-run week", light[0].days.map((d) => d.day), ["Tue", "Thu", "Sun"]);
	check("…with no paces when there's no target", light.every((w) => w.days.every((d) => d.pace === undefined)));
	eq("the fallback base", baselineWeeklyKm([]), 15);
	eq("the base is the mean, zeros included", baselineWeeklyKm([10, 20, 30, 0]), 15);

	const eight = generateOpenBlock({ firstWeek: 5, count: 8, recentWeeklyKm: [30], targetPace: "" });
	same("eight weeks repeat the 3+1 pattern", eight.map((w) => w.phase === OPEN_PHASES.recovery), [false, false, false, true, false, false, false, true]);
	same("…numbered contiguously", eight.map((w) => w.week), [5, 6, 7, 8, 9, 10, 11, 12]);
}

section("Extension: numbering and the calendar gap");
{
	eq("the race plan ends where it should", LAST, 12);
	eq("race week is the week containing race day", planWeekOfISO(START, RACE), LAST);

	const inRaceWeek = planExtension(RACE_WEEKS, START, RACE);
	eq("during the last week, no gap", inRaceWeek.gap.length, 0);
	eq("…and the block starts right after", inRaceWeek.firstWeek, 13);

	const weekAfter = planExtension(RACE_WEEKS, START, dayInWeek(13));
	eq("the week after the race, still no gap", weekAfter.gap.length, 0);
	eq("…block starts at the current calendar week", weekAfter.firstWeek, 13);

	const later = planExtension(RACE_WEEKS, START, dayInWeek(16));
	same("three weeks late, weeks 13-15 fill the gap", later.gap.map((w) => w.week), [13, 14, 15]);
	check("…as empty Off Plan weeks", later.gap.every((w) => w.phase === OPEN_PHASES.gap && w.days.length === 0));
	eq("…and the block starts at the current week", later.firstWeek, 16);

	const block = generateOpenBlock({ firstWeek: later.firstWeek, recentWeeklyKm: [20], targetPace: "" });
	const extended = appendWeeks(RACE_WEEKS, later.gap, block);
	same("week numbers stay contiguous", extended.map((w) => w.week), Array.from({ length: 19 }, (_, i) => i + 1));
	eq("weeks.length is the true count", extended.length, extended.at(-1)?.week);
	check("existing weeks are the same objects — never rewritten", RACE_WEEKS.every((week, i) => extended[i] === week));
	eq("the current calendar week is now inside the plan", planWeekOfISO(START, dayInWeek(16)), block[0].week);

	const empty = planExtension([], START, START);
	eq("an empty plan starts at week 1", empty.firstWeek, 1);
}

section("Fresh open plan (regenerate / setup): placed at the current week");
{
	// The owner's case: start date in July, regenerated in week 14.
	const late = generateInitialOpenPlan({ startDate: START, today: dayInWeek(14), recentWeeklyKm: [25], targetPace: "" });
	same("a past start date gets Off Plan weeks up to now", late.slice(0, 13).map((w) => w.phase === OPEN_PHASES.gap && w.days.length === 0), Array(13).fill(true));
	same("…then the block at the current calendar week", late.slice(13).map((w) => w.week), [14, 15, 16, 17]);
	same("numbering is contiguous from 1", late.map((w) => w.week), Array.from({ length: 17 }, (_, i) => i + 1));
	check("no planned day falls before today's week", late.every((w) => w.days.length === 0 || w.week >= (planWeekOfISO(START, dayInWeek(14)) ?? 0)));

	const fresh = generateInitialOpenPlan({ startDate: START, today: START, recentWeeklyKm: [25], targetPace: "" });
	same("a start date this week begins at week 1, no gap", fresh.map((w) => w.week), [1, 2, 3, 4]);
	check("…with no Off Plan weeks", fresh.every((w) => w.phase !== OPEN_PHASES.gap));

	const future = generateInitialOpenPlan({ startDate: "2026-11-02", today: START, recentWeeklyKm: [25], targetPace: "" });
	same("a future start date also begins at week 1", future.map((w) => w.week), [1, 2, 3, 4]);
}

section("parsePlanChange: old blocks are unchanged");
{
	// The protocol's own v1 example, verbatim.
	const v1 = `{"changes": [
  {"week": 5, "days": [
    {"day": "Tue", "type": "Easy Run", "distance": 2, "pace": "7:15", "notes": "Reduced — recovery from shin pain"},
    {"day": "Thu", "type": "Rest", "distance": 0, "notes": "Extra rest day"},
    {"day": "Sun", "type": "Long Run", "distance": 4, "pace": "7:00", "notes": "Keep it short and easy"}
  ]},
  {"week": 6, "days": [
    {"day": "Tue", "type": "Easy Run", "distance": 2.5, "pace": "7:15", "notes": "Gradual return"}
  ]}
], "summary": "Reduced weeks 5-6 for shin recovery"}`;

	const expected = {
		changes: [
			{
				week: 5,
				days: [
					{ day: "Tue", type: "Easy Run", distance: 2, notes: "Reduced — recovery from shin pain", pace: "7:15" },
					{ day: "Thu", type: "Rest", distance: 0, notes: "Extra rest day" },
					{ day: "Sun", type: "Long Run", distance: 4, notes: "Keep it short and easy", pace: "7:00" },
				],
			},
			{ week: 6, days: [{ day: "Tue", type: "Easy Run", distance: 2.5, notes: "Gradual return", pace: "7:15" }] },
		],
		summary: "Reduced weeks 5-6 for shin recovery",
	};

	const parsed = parsePlanChange(v1);
	same("the v1 example parses to exactly what it always did", parsed, expected);
	check("…with no goal key", parsed !== null && !("goal" in parsed));
	check("…and no phase keys", parsed !== null && parsed.changes.every((entry) => !("phase" in entry)));
	eq("…so its identity key is unchanged", parsed && planChangeKey(parsed), JSON.stringify(expected));
	eq("…and its label too", parsed && planChangeLabel(parsed), "Weeks 5, 6");

	same(
		"a skips-only block is unchanged",
		parsePlanChange(`{"changes": [{"week": 5, "skips": [{"day": "Thu", "skipped": true}]}], "summary": "Travel"}`),
		{ changes: [{ week: 5, skips: [{ day: "Thu", skipped: true }] }], summary: "Travel" },
	);
	eq("an empty change list is still rejected", parsePlanChange(`{"changes": [], "summary": "x"}`), null);
	eq("a week with neither days nor skips is still rejected", parsePlanChange(`{"changes": [{"week": 5}]}`), null);
	eq("…and so is malformed JSON", parsePlanChange(`{"changes": [`), null);

	// Applying the old block to a race plan behaves as before: only the
	// listed weeks change, settings are untouched.
	const state = { settings: normalizePlanSettings(OLD_SETTINGS), weeks: RACE_WEEKS, completed: { "5-0": true as const }, skipped: {} };
	const applied = parsed ? applyChangeToPlan(state, parsed) : null;
	check("it applies", applied !== null);
	if (applied) {
		eq("…the plan keeps its length", applied.weeks.length, LAST);
		same("…settings untouched (still race mode)", applied.settings, state.settings);
		check("…week 4 untouched", applied.weeks[3] === RACE_WEEKS[3]);
		eq("…week 5 replaced", applied.weeks[4].days.length, 3);
		eq("…week 5 keeps its phase", applied.weeks[4].phase, RACE_WEEKS[4].phase);
		check("…and reports applied", isPlanChangeApplied({ weeks: applied.weeks, skipped: applied.skipped }, parsed!));
	}
}

section("parsePlanChange: goal and appended weeks");
{
	const raw = `{"goal": {"text": "Sub-25 5K by March"}, "changes": [
  {"week": 13, "phase": "Recovery", "days": [{"day": "Tue", "type": "Easy Run", "distance": 4, "notes": "Easy"}]},
  {"week": 14, "phase": "Progression", "days": [{"day": "Sun", "type": "Long Run", "distance": 10, "notes": ""}], "skips": [{"day": "Sun", "skipped": true}]}
], "summary": "New objective"}`;
	const change = parsePlanChange(raw);
	check("parses", change !== null);
	if (change) {
		same("the goal comes through", change.goal, { text: "Sub-25 5K by March" });
		eq("phases come through", change.changes.map((entry) => entry.phase).join(","), "Recovery,Progression");
		eq("label names both", planChangeLabel(change), "Objective · Weeks 13, 14");
		same("13 and 14 are appended", appendedWeeks(RACE_WEEKS, change), [13, 14]);

		const before: PlanSnapshot = { weeks: RACE_WEEKS, skipped: {}, goalMode: "race", goal: "" };
		check("not applied before", !isPlanChangeApplied(before, change));

		const state = { settings: normalizePlanSettings(OLD_SETTINGS), weeks: RACE_WEEKS, completed: {}, skipped: {} };
		const applied = applyChangeToPlan(state, change);
		check("applies", applied !== null);
		if (applied) {
			same("weeks appended contiguously", applied.weeks.map((w) => w.week), Array.from({ length: 14 }, (_, i) => i + 1));
			eq("…with the coach's phase", applied.weeks[12].phase, "Recovery");
			check("existing weeks untouched", RACE_WEEKS.every((week, i) => applied.weeks[i] === week));
			eq("goal switches to open mode", applied.settings.goalMode, "open");
			eq("…and saves the objective", applied.settings.goal, "Sub-25 5K by March");
			eq("…keeping the last race", applied.settings.raceDate, RACE);
			eq("skips on an appended week land", applied.skipped["14-0"], true);
			check(
				"reports applied afterwards",
				isPlanChangeApplied(
					{ weeks: applied.weeks, skipped: applied.skipped, goalMode: applied.settings.goalMode, goal: applied.settings.goal },
					change,
				),
			);
			check(
				"…but not against a snapshot without the goal fields",
				!isPlanChangeApplied({ weeks: applied.weeks, skipped: applied.skipped }, change),
			);
			const again = applyChangeToPlan(applied, change);
			eq("applying twice appends nothing more", again?.weeks.length, 14);
		}
	}

	const goalOnly = parsePlanChange(`{"goal": {"text": "Consistency: 3 runs a week"}, "changes": [], "summary": ""}`);
	check("a goal-only block parses", goalOnly !== null);
	if (goalOnly) {
		eq("…labelled as an objective", planChangeLabel(goalOnly), "Objective");
		const applied = applyChangeToPlan({ settings: normalizePlanSettings(OLD_SETTINGS), weeks: RACE_WEEKS, completed: {}, skipped: {} }, goalOnly);
		eq("…and applies", applied?.settings.goal, "Consistency: 3 runs a week");
	}
	eq("an empty goal is rejected", parsePlanChange(`{"goal": {"text": "  "}, "changes": [{"week": 1, "skips": []}]}`), null);
	eq("a goal with no text is rejected", parsePlanChange(`{"goal": {}, "changes": [{"week": 1, "skips": []}]}`), null);

	const day = `"days": [{"day": "Tue", "type": "Easy Run", "distance": 4, "notes": ""}]`;
	const gap = parsePlanChange(`{"changes": [{"week": 13, "phase": "P", ${day}}, {"week": 15, "phase": "P", ${day}}]}`);
	same("appending stops at a hole", gap && appendedWeeks(RACE_WEEKS, gap), [13]);
	const noPhase = parsePlanChange(`{"changes": [{"week": 13, ${day}}]}`);
	same("no phase, no append", noPhase && appendedWeeks(RACE_WEEKS, noPhase), []);

	const stale = parsePlanChange(`{"changes": [{"week": 20, "phase": "P", ${day}}]}`);
	check("a truly stale block parses", stale !== null);
	if (stale) {
		eq("…appends nothing", appendedWeeks(RACE_WEEKS, stale).length, 0);
		eq("…applies nothing (the 'not in your plan' path)", applyChangeToPlan({ settings: normalizePlanSettings(OLD_SETTINGS), weeks: RACE_WEEKS, completed: {}, skipped: {} }, stale), null);
		check("…and isn't reported applied", !isPlanChangeApplied({ weeks: RACE_WEEKS, skipped: {} }, stale));
	}
}

section("Coach context: open-mode profile and onboarding");
{
	const today = dayInWeek(13);
	const gapWeek: PlanWeek = { week: 13, phase: OPEN_PHASES.gap, days: [] };
	const openPlan = (goal: string): PlanRecord => ({
		settings: normalizePlanSettings({ ...OLD_SETTINGS, goalMode: "open", goal }),
		weeks: [...RACE_WEEKS, gapWeek, ...generateOpenBlock({ firstWeek: 14, recentWeeklyKm: [25], targetPace: "6:00" })],
		completed: {},
		skipped: {},
		updatedAt: new Date("2026-10-22T08:00:00Z"),
	});
	const data = (plan: PlanRecord): CoachData => ({ plan, runs: [], today });

	const unset = buildCoachContext(data(openPlan("")));
	has(
		"profile with no objective",
		unset,
		"RUNNER PROFILE: Runner in open-ended training (no target race). Objective: not set yet. Last race: Half Marathon (21.1km) on 2026-10-18. Target pace: 6:00 min/km.",
	);
	lacks("…and no race countdown", unset, "training for a Half Marathon");
	has("a week with no days still renders", unset, "Week 13 (Off Plan) — CURRENT:");

	const set = buildCoachContext(data(openPlan("Sub-25 5K by March.")));
	has("profile with an objective", set, "Objective: Sub-25 5K by March. Last race:");
	eq(
		"the helper agrees",
		openRunnerProfile(normalizePlanSettings({ goalMode: "open", goal: "Volume" })),
		"RUNNER PROFILE: Runner in open-ended training (no target race). Objective: Volume.",
	);

	const onboarding = buildCoachSystemPrompt(data(openPlan("")));
	has("open prompt documents the rolling plan", onboarding, "OPEN-ENDED TRAINING (rolling plan):");
	has("…names where the plan ends", onboarding, "The plan currently ends at Week 17.");
	has("…documents the goal field", onboarding, '"goal": {"text":');
	has("…keeps the v1 protocol", onboarding, "PLAN MODIFICATIONS:");
	has("onboarding when the objective is empty", onboarding, "OBJECTIVE NOT SET YET — ONBOARDING:");
	has("…one or two questions at a time", onboarding, "one or two short questions at a time");
	has("…asks for one compact block", onboarding, "ONE compact plan-change block");
	has("…scoped to the current week through the plan end", onboarding, 'full "days" for Weeks 13–17 only (the current week to the end of the plan)');
	has("…capped in size", onboarding, "never more than 5 weeks");
	has("…defers later blocks", onboarding, '"Plan next 4 weeks" on the Plan page');
	lacks("…no longer asks for every upcoming week plus appended ones", onboarding, "and any new weeks appended after Week");
	has("open mode narrows \"ALL weeks\" to the current week onward", onboarding, '"include ALL weeks" (e.g. when adding paces) means the current week through the end of the plan');

	// Week 16 of a plan ending at 17: two weeks left, so it tops up to four.
	const late = buildCoachSystemPrompt({ plan: openPlan(""), runs: [], today: dayInWeek(16) });
	has("near the plan end the block is topped up to 4 weeks", late, 'full "days" for Weeks 16–17 only (the current week to the end of the plan), plus Weeks 18–19 appended after Week 17 to make a 4-week block');

	const settled = buildCoachSystemPrompt(data(openPlan("Sub-25 5K by March")));
	has("open prompt with a goal still documents the protocol", settled, "OPEN-ENDED TRAINING (rolling plan):");
	lacks("…but drops the onboarding", settled, "OBJECTIVE NOT SET YET");

	const racePlan: PlanRecord = {
		settings: { ...OLD_SETTINGS },
		weeks: RACE_WEEKS,
		completed: {},
		skipped: {},
		updatedAt: new Date("2026-08-17T08:00:00Z"),
	};
	const racePrompt = buildCoachSystemPrompt({ plan: racePlan, runs: [], today: "2026-08-17" });
	has("race mode keeps its profile", racePrompt, "RUNNER PROFILE: Beginner runner training for a Half Marathon (21.1km) on 2026-10-18. Target race pace: 6:00 min/km.");
	lacks("race mode has no open section", racePrompt, "OPEN-ENDED TRAINING");
	lacks("race mode has no onboarding", racePrompt, "OBJECTIVE NOT SET YET");
	eq(
		"race prompt is identical with or without the new keys",
		buildCoachSystemPrompt({ plan: { ...racePlan, settings: normalizePlanSettings(OLD_SETTINGS) }, runs: [], today: "2026-08-17" }),
		racePrompt,
	);
	lacks("…even with a leftover objective", buildCoachSystemPrompt({
		plan: { ...racePlan, settings: { ...OLD_SETTINGS, goalMode: "race", goal: "leftover" } },
		runs: [],
		today: "2026-08-17",
	}), "leftover");
}

// ---------------------------------------------------------------------------
section("Plan-change truncation: detection and retry stitching");
{
	const block = `:::plan-change
{"goal": {"text": "Sub-25 5K"}, "changes": [{"week": 14, "days": [{"day": "Tue", "type": "Easy Run", "distance": 5, "notes": "Easy"}]}], "summary": "s"}
:::`;
	const prose = "Here's the plan for the next block.";
	const complete = `${prose}\n\n${block}\n\nHit Apply!`;
	const cut = `${prose}\n\n:::plan-change\n{"goal": {"text": "Sub-25 5K"}, "changes": [{"week": 14, "days": [{"day": "Tue", "ty`;

	eq("a complete reply has no unclosed block", hasUnclosedPlanChange(complete), false);
	eq("a reply cut inside the block is unclosed", hasUnclosedPlanChange(cut), true);
	eq("plain prose is not unclosed", hasUnclosedPlanChange("Just rest today."), false);
	eq("status: none", planChangeStatus("Just rest today."), "none");
	eq("status: complete", planChangeStatus(complete), "complete");
	eq("status: truncated", planChangeStatus(cut), "truncated");
	eq("status: invalid", planChangeStatus(`${prose}\n\n:::plan-change\n{"changes": "nope"}\n:::`), "invalid");
	eq("a cut block after a complete one still counts as truncated", planChangeStatus(`${complete}\n\n${cut}`), "truncated");

	eq("prose before the cut block", textBeforeUnclosedPlanChange(cut), prose);
	eq("…and a complete reply is returned unchanged", textBeforeUnclosedPlanChange(complete), complete);
	eq("…keeps an earlier complete block", textBeforeUnclosedPlanChange(`${complete}\n\n${cut}`), `${complete}\n\n${prose}`);

	eq("first complete block is found verbatim", firstCompletePlanChange(`noise\n${block}\ntrailing`), block);
	eq("…and an unparseable one is skipped", firstCompletePlanChange(':::plan-change\n{"changes": 1}\n:::'), null);

	const stitched = stitchPlanChangeRetry(prose, `Sure — here it is:\n\n${block}\n\nDone.`);
	eq("retry stitches prose + block only", stitched, `${prose}\n\n${block}`);
	eq("…which renders as one parseable card", stitched ? planChangeStatus(stitched) : null, "complete");
	eq("…and is a block the apply action will accept", stitched ? planChangesIn(stitched).length : 0, 1);
	eq("a retry that is cut off again is rejected", stitchPlanChangeRetry(prose, cut), null);
	eq("a retry with no block is rejected", stitchPlanChangeRetry(prose, "Sorry, here is a summary instead."), null);
	eq("with no prose the block stands alone", stitchPlanChangeRetry("", block), block);

	// The server's "⚠️ …" note after a broken block used to be swallowed with it.
	const noted = `${cut}\n\n⚠️ The coach service returned an error (529). Try again.`;
	const segments = splitMessage(noted);
	const last = segments.at(-1);
	eq("a cut block with a trailing note is still truncated", last?.kind === "text" && last.truncated, true);
	eq("…and the note survives for the renderer", last?.kind === "text" ? last.note : undefined, "⚠️ The coach service returned an error (529). Try again.");
	eq("…while the prose is unchanged", last?.kind === "text" ? last.text : undefined, `${prose}\n\n`);
	eq("a cut block without a note carries none", (() => {
		const tail = splitMessage(cut).at(-1);
		return tail?.kind === "text" ? tail.note : "n/a";
	})(), undefined);
	same("splitMessage on a complete reply is unchanged in shape", splitMessage(complete).map((segment) => segment.kind), ["text", "change", "text"]);
	same("…and its text segments carry no note key", splitMessage(complete).filter((segment) => segment.kind === "text").map((segment) => Object.keys(segment).sort()), [["kind", "text", "truncated"], ["kind", "text", "truncated"]]);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
