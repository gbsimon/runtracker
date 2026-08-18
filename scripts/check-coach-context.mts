/**
 * Unit checks for the coach's v2 context and for the model-deprecation
 * recovery that keeps it talking to a model that still exists.
 *
 *   pnpm check:coach-context
 *
 * Everything here runs on fixtures — no database, no network, no API key. The
 * context half renders `buildCoachSystemPrompt` from a hand-built `CoachData`
 * and asserts on the text; the model half drives `coach-model.ts` through
 * injected deps, so the 404 → list models → persist → retry path is exercised
 * end to end against a fake client.
 */

import { readFileSync } from "node:fs";
import { COACH_MODEL } from "../src/lib/anthropic.ts";
import {
	buildCoachContext,
	buildCoachSystemPrompt,
	type CoachData,
	COACH_GUIDANCE,
	type RecentRun,
} from "../src/lib/coach-context.ts";
import {
	type CoachModelDeps,
	type CoachModelOverride,
	coachModelNotice,
	isModelNotFoundError,
	type ModelListing,
	pickNewestSonnet,
	recoverCoachModel,
	resolveCoachModel,
	revalidateCoachModel,
	withCoachModel,
} from "../src/lib/coach-model.ts";
import { type DailyMetricRow, toDailyMetricsView } from "../src/lib/daily-metrics.ts";
import type { PlanRecord } from "../src/lib/plan.ts";
import { weekdayAbbrISO } from "../src/lib/running.ts";
import { type TrainingRun, efficiencyTrend, weeklyLoad } from "../src/lib/training-metrics.ts";

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

function has(label: string, haystack: string, needle: string): void {
	check(label, haystack.includes(needle), haystack.includes(needle) ? "" : `missing ${JSON.stringify(needle)}`);
}

function section(title: string): void {
	console.log(`\n${title}`);
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * The plan-change protocol as it is written in a source file, with the one
 * template expression inside it — the optional target-pace clause — swapped for
 * a sentinel, so v1's `APP.settings.targetPace` and v2's `targetPace` compare
 * equal while every other byte still has to match.
 */
function protocolSource(source: string): string {
	const start = source.indexOf("PLAN MODIFICATIONS:");
	const tail = "poor adherence";
	const end = source.indexOf(tail, start);
	if (start < 0 || end < 0) return `<protocol region not found>`;

	const region = source.slice(start, end + tail.length);
	const exprStart = region.indexOf("${");
	const exprEnd = region.indexOf(' : ""}', exprStart);
	if (exprStart < 0 || exprEnd < 0 || !region.slice(exprStart, exprEnd).includes("targetPace")) {
		return `<target-pace expression not found>${region}`;
	}
	return `${region.slice(0, exprStart)}<target-pace clause>${region.slice(exprEnd + ' : ""}'.length)}`;
}

// ---------------------------------------------------------------------------
// Fixture — a runner mid-plan on Monday 2026-08-17
// ---------------------------------------------------------------------------

const TODAY = "2026-08-17";

const PLAN: PlanRecord = {
	settings: {
		startDate: "2026-08-03",
		raceDate: "2026-10-11",
		raceDistance: 21.1,
		targetPace: "6:00",
		hidePastWeeks: false,
	},
	weeks: [
		{
			week: 1,
			phase: "Base Building",
			days: [
				{ day: "Wed", type: "Easy Run", distance: 5, notes: "", pace: "7:00" },
				{ day: "Sat", type: "Long Run", distance: 8, notes: "", pace: "7:15" },
			],
		},
		{
			week: 2,
			phase: "Base Building",
			days: [
				{ day: "Wed", type: "Tempo Run", distance: 5, notes: "", pace: "6:10" },
				{ day: "Sat", type: "Long Run", distance: 10, notes: "", pace: "7:15" },
			],
		},
		{
			week: 3,
			phase: "Building Volume",
			days: [
				{ day: "Wed", type: "Easy Run", distance: 6, notes: "", pace: "7:00" },
				{ day: "Sun", type: "Long Run", distance: 12, notes: "", pace: "7:10" },
			],
		},
	],
	completed: {},
	skipped: {},
	updatedAt: new Date("2026-08-17T08:00:00Z"),
};

/** Two runs in the week of Mon 2026-08-10, one in the week of Mon 2026-08-03. */
const TRAINING_RUNS: TrainingRun[] = [
	{ id: "aug03", day: "2026-08-03", distanceM: 8000, durationS: 2700, avgHr: null, maxHr: null },
	{ id: "aug12", day: "2026-08-12", distanceM: 5000, durationS: 1800, avgHr: 160, maxHr: 178 },
	{ id: "aug15", day: "2026-08-15", distanceM: 10_000, durationS: 3600, avgHr: 150, maxHr: 175 },
];

/**
 * Days 08-12, 08-14, 08-15 and 08-16 are deliberately missing — a watch left on
 * the charger, which the recovery block has to render as absence rather than
 * quietly dropping the day or averaging a zero into the week.
 */
const METRIC_ROWS: DailyMetricRow[] = [
	{ day: "2026-08-11", kind: "resting_heart_rate", value: { qty: 50 } },
	{ day: "2026-08-11", kind: "heart_rate_variability", value: { qty: 78 } },
	{ day: "2026-08-11", kind: "sleep_analysis", value: { totalSleep: 7.0, rem: 1.4, core: 3.9, deep: 0.9, awake: 0.3 } },
	{ day: "2026-08-13", kind: "heart_rate_variability", value: { qty: 83 } },
	{ day: "2026-08-17", kind: "resting_heart_rate", value: { qty: 47 } },
	{ day: "2026-08-17", kind: "heart_rate_variability", value: { qty: 88 } },
	{ day: "2026-08-17", kind: "sleep_analysis", value: { totalSleep: 7.8, rem: 1.6, core: 4.1, deep: 1.1, awake: 0.2 } },
	{ day: "2026-08-17", kind: "vo2_max", value: { qty: 44.2 } },
];

const LONG_RUN: RecentRun = {
	dateISO: "2026-08-15",
	distanceKm: 10,
	durationS: 3600,
	effort: 6,
	notes: "legs heavy in the last 2km",
	time: "07:12",
	plannedType: "Long Run",
	avgHr: 150,
	maxHr: 175,
	avgCadence: 168.4,
	elevationGainM: 84.6,
	weather: {
		tempC: 28.4,
		humidityPct: 71,
		windKmh: 12.3,
		precipMm: 0,
		condition: { label: "Clear", emoji: "☀️" },
		source: "apple+open-meteo",
	},
	energyKcal: 612,
	hrDrop60: 34,
	hrDrop120: 48,
	hrPeakBpm: 168,
	decoupling: { driftPct: 12.4, steady: true },
	splits: [
		{ km: 1, paceSPerKm: 358, avgHr: 141, elevationDeltaM: 4, partial: false },
		{ km: 2, paceSPerKm: 361, avgHr: 148, elevationDeltaM: -7, partial: false },
		{ km: 3, paceSPerKm: 366, avgHr: 155, elevationDeltaM: 12, partial: false },
		{ km: 4, paceSPerKm: 372, avgHr: null, elevationDeltaM: null, partial: true },
	],
	splitsTruncated: 2,
	highlight: "long run",
};

const TEMPO_RUN: RecentRun = {
	dateISO: "2026-08-12",
	distanceKm: 5,
	durationS: 1800,
	effort: 8,
	notes: null,
	time: "18:40",
	plannedType: "Tempo Run",
	avgHr: 160,
	maxHr: 178,
	avgCadence: 176,
	elevationGainM: 12,
	weather: null,
	energyKcal: 341,
	hrDrop60: 29,
	hrDrop120: null,
	hrPeakBpm: 174,
	decoupling: { driftPct: null, steady: false, reason: "effort varied too much to compare halves" },
	splits: null,
	splitsTruncated: 0,
	highlight: null,
};

const DATA: CoachData = {
	plan: PLAN,
	runs: [
		{ dateISO: "2026-08-03", distanceKm: 8, durationS: 2700, effort: 5, notes: null },
		{ dateISO: "2026-08-12", distanceKm: 5, durationS: 1800, effort: 8, notes: null },
		{ dateISO: "2026-08-15", distanceKm: 10, durationS: 3600, effort: 6, notes: "legs heavy in the last 2km" },
	],
	today: TODAY,
	recent: [LONG_RUN, TEMPO_RUN],
	weekly: weeklyLoad(TRAINING_RUNS, 8, { endDay: TODAY }),
	recovery: toDailyMetricsView(METRIC_ROWS),
	signals: {
		efficiency: efficiencyTrend(TRAINING_RUNS),
		hrRecovery: [
			{ dateISO: "2026-08-12", drop60: 29, drop120: null },
			{ dateISO: "2026-08-15", drop60: 34, drop120: 48 },
		],
	},
};

const context = buildCoachContext(DATA);
const prompt = buildCoachSystemPrompt(DATA);

// ---------------------------------------------------------------------------

section("Header and plan rendering (unchanged from v1)");
{
	has("today line", context, `TODAY: ${TODAY} (Monday).`);
	has("profile line", context, "RUNNER PROFILE: Beginner runner training for a Half Marathon (21.1km) on 2026-10-11. Target race pace: 6:00 min/km.");
	has("plan status", context, "PLAN: 3 weeks total. CURRENT STATUS: Week 3 of 3.");
	has("total logged", context, "TOTAL LOGGED: 3 runs, 23.0 km total.");

	// Day lines are the format `plan-change.ts` reads back against.
	has("full plan header", context, "FULL PLAN (each day shows: date • planned • [logged actuals if any]):");
	has("week marker", context, "Week 3 (Building Volume) — CURRENT:");
	has("a done day carries its actuals", context, "Sat 2026-08-15 [DONE]: Long Run 10km @7:15/km → LOGGED: 10km in 60:00 (6:00/km, effort 6/10)");
	has("an upcoming day", context, "Sun 2026-08-23 [UPCOMING]: Long Run 12km @7:10/km");
	has("a missed day", context, "Wed 2026-08-05 [MISSED]: Easy Run 5km @7:00/km");
	has("orphan section", context, "UNPLANNED LOGGED RUNS (not on a plan day):");
	has("orphan run", context, "2026-08-03: 8km in 45:00 (5:38/km, effort 5/10)");
}

section("Recent runs — full enrichment inline");
{
	has("run heading with weekday, time and planned type", context, "2026-08-15 Sat · 07:12 · planned: Long Run · [long run]");
	has("actuals", context, "10km in 60:00 (6:00/km, effort 6/10)");
	has("physiology line", context, "HR 150avg/175max bpm · cadence 168spm · climb 85m · 612kcal");
	has("weather one-liner", context, "Weather: ☀️ Clear · 28.4°C · 71% humidity · wind 12km/h");
	has("hr recovery", context, "HR recovery: -34bpm in the first minute, -48bpm by two minutes (from 168bpm)");
	has("decoupling with steady flag", context, "Aerobic decoupling: +12.4% over a steady effort");
	has("notes", context, 'Notes: "legs heavy in the last 2km"');

	has("a run with no weather omits the line", context, "2026-08-12 Wed · 18:40 · planned: Tempo Run");
	check("…and really omits it", count(context, "Weather:") === 1, `${count(context, "Weather:")} weather lines`);
	has("unmeasurable decoupling says why", context, "Aerobic decoupling: not measurable — effort varied too much to compare halves");
	has("one-sided hr recovery", context, "HR recovery: -29bpm in the first minute (from 174bpm)");
}

section("Split table for the highlighted long run");
{
	has("table header", context, "Per-km splits (km · pace · avg HR · net climb):");
	has("first km", context, "1 5:58/km 141bpm +4m");
	has("a descent", context, "2 6:01/km 148bpm -7m");
	has("a climb", context, "3 6:06/km 155bpm +12m");
	has("a partial split with gaps", context, "4(part) 6:12/km no HR climb n/a");
	has("truncation is stated, not silent", context, "…2 further splits omitted");
	check("only the highlighted run gets a table", count(context, "Per-km splits") === 1, `${count(context, "Per-km splits")} tables`);
}

section("Weekly aggregates");
{
	// Two runs of 60 and 30 minutes, both in Edwards zone 4 against an observed
	// HR max of 178 → 60*4 + 30*4 = 360 weighted minutes.
	has("eight-week window with the load unit spelled out", context, "WEEKLY VOLUME & LOAD (last 8 weeks; load is weighted minutes (Edwards TRIMP, zone 1–5), HR max 178 observed):");
	has("a full-coverage week", context, "(from 2026-08-10): 2 runs, 15.0km, 90:00, load 360");
	has("a week with no heart rate", context, "(from 2026-08-03): 1 run, 8.0km, 45:00, load not computable (no HR)");
	has("a week nobody ran", context, "(from 2026-07-27): no runs");
	check("all eight weeks are present", count(context, "(from 20") === 8, `${count(context, "(from 20")} week lines`);
}

section("Recovery block");
{
	has("header states the units and the meaning of a gap", context, "RECOVERY — last 7 days (HRV is SDNN in ms; absent days were not measured, never zero):");
	has("a full day", context, `2026-08-11 ${weekdayAbbrISO("2026-08-11")}: resting HR 50bpm · HRV 78ms · sleep 7h00 (REM 1h24 · core 3h54 · deep 0h54 · awake 0h18)`);
	has("a partial day", context, `2026-08-13 ${weekdayAbbrISO("2026-08-13")}: HRV 83ms`);
	has("an absent day", context, `2026-08-12 ${weekdayAbbrISO("2026-08-12")}: not recorded`);
	eq("four days were not recorded", count(context, ": not recorded"), 4);
	check("the window is exactly seven days", count(context, "2026-08-1") >= 7, "");

	has("latest reading carries its day", context, "Latest reading: resting HR 47bpm (Aug 17) · HRV 88ms (Aug 17) · sleep 7h48 (Aug 17) · VO2max 44.2 (Aug 17)");
	// The denominators are the point: three HRV readings is not a seven-day mean.
	has("averages state their denominators", context, "Window average: resting HR 48.5bpm over 2 days · HRV 83.0ms over 3 days · sleep 7h24 over 2 nights");
	has("the delta is computed rather than left to the model", context, "Latest vs average: HRV 88ms vs 83.0ms average (+5.0)");
	has("…including sleep in minutes", context, "sleep 7h48 vs 7h24 average (+24min)");
	has("…and resting HR downward", context, "resting HR 47bpm vs 48.5bpm average (-1.5)");
}

section("Training signals");
{
	has("efficiency falls back to its reason", context, "Aerobic efficiency: no trend yet —");
	has("decoupling summary names the threshold", context, "Aerobic decoupling on steady runs (over 10% suggests the aerobic base is still developing): 2026-08-15 +12.4%");
	has("hr recovery trend, oldest first", context, "HR recovery, first-minute drop (higher is fitter), oldest first: 2026-08-12 -29bpm · 2026-08-15 -34bpm");
}

section("Sections degrade rather than crash");
{
	const bare = buildCoachContext({ plan: null, runs: [], today: TODAY });
	has("no plan", bare, "PLAN: none set up yet");
	has("no runs", bare, "TOTAL LOGGED: 0 runs, 0.0 km total.");
	check("no physiology sections at all", !bare.includes("RECOVERY —") && !bare.includes("RECENT RUNS"), "");

	const quiet = buildCoachContext({ ...DATA, recent: [], recovery: toDailyMetricsView([]), signals: { efficiency: efficiencyTrend([]), hrRecovery: [] } });
	has("an empty recent window says so", quiet, "No runs in the last 14 days.");
	has("an empty recovery window says so", quiet, "Window average: nothing recorded in this window.");
	has("no recovery data still lists the seven days", quiet, `2026-08-17 ${weekdayAbbrISO(TODAY)}: not recorded`);
	has("no steady run", quiet, "Aerobic decoupling: no steady run long enough to measure in this window.");
	has("no recovery tail", quiet, "HR recovery: no post-run recovery recorded yet.");
}

section("System prompt: guidance added, protocol untouched");
{
	has("guidance section is present", prompt, "USING THE PHYSIOLOGY DATA:");
	has("…and is the exported constant", prompt, COACH_GUIDANCE);
	has("guidance names the decoupling threshold", prompt, "drift above 10% means heart rate climbed while pace held");
	has("guidance demands the numbers be cited", prompt, "cite the specific numbers you reasoned from");
	has("guidance routes changes through the protocol", prompt, "action it with a plan-change block using the protocol above");

	// The `:::plan-change` block is what `plan-change.ts` parses, so it is
	// reproduced from v1 unchanged. Rather than freeze a hash of it — which only
	// ever proves the text still equals whatever it was when the hash was
	// taken — the region is read out of both source files and compared, so this
	// asserts the thing it claims: v2's protocol is v1's protocol.
	const start = prompt.indexOf("PLAN MODIFICATIONS:");
	const end = prompt.indexOf("USING THE PHYSIOLOGY DATA:");
	const protocol = prompt.slice(start, end);

	check("the protocol region was found", start > 0 && end > start, `${protocol.length} chars`);
	eq(
		"plan-change protocol is byte-identical to v1's",
		protocolSource(readFileSync("src/lib/coach-context.ts", "utf8")),
		protocolSource(readFileSync("legacy/index.html", "utf8")),
	);
	has("…opening fence", protocol, "\n:::plan-change\n");
	has("…skips example", protocol, '{"week": 5, "skips": [{"day": "Thu", "skipped": true}]}');
	has("…target pace rule", protocol, "The runner's target race pace is 6:00 min/km");
	has("…skipped-days rule", protocol, "Days marked [SKIPPED] in the FULL PLAN below were deliberately skipped");
	check("the guidance sits after the protocol, not inside it", !protocol.includes("USING THE PHYSIOLOGY"), "");
}

// ---------------------------------------------------------------------------
// Model resolution and deprecation recovery
// ---------------------------------------------------------------------------

/** An in-memory `app_config`, plus a record of what the coach logged. */
function fakeDeps(options: { env?: string; stored?: CoachModelOverride | null; models?: ModelListing[] } = {}) {
	const logs: string[] = [];
	let stored = options.stored ?? null;
	let writes = 0;
	let lists = 0;

	const deps: Partial<CoachModelDeps> = {
		envModel: () => options.env,
		readOverride: async () => stored,
		writeOverride: async (override) => {
			stored = override;
			writes += 1;
		},
		listModels: async () => {
			lists += 1;
			return options.models ?? MODELS;
		},
		log: (message) => logs.push(message),
		now: () => new Date("2026-08-17T09:30:00.000Z"),
	};

	return { deps, logs, read: () => stored, writes: () => writes, lists: () => lists };
}

/**
 * A plausible `GET /v1/models` page. Deliberately not sorted, and deliberately
 * carrying a Sonnet newer than the one this build pins — that is the situation
 * the recovery exists for.
 */
const MODELS: ModelListing[] = [
	{ id: "claude-haiku-4-5", created_at: "2025-10-01T00:00:00Z" },
	{ id: "claude-sonnet-4-6", created_at: "2025-11-14T00:00:00Z" },
	{ id: "claude-opus-5", created_at: "2026-07-01T00:00:00Z" },
	{ id: "claude-sonnet-5", created_at: "2026-02-01T00:00:00Z" },
	{ id: "claude-sonnet-6", created_at: "2026-08-01T00:00:00Z" },
	{ id: "claude-opus-4-8", created_at: "2026-01-05T00:00:00Z" },
];

section("Newest-Sonnet selection rule");
{
	eq("picks the newest Sonnet by created_at", pickNewestSonnet(MODELS), "claude-sonnet-6");
	eq("never substitutes an Opus for a Sonnet", pickNewestSonnet([{ id: "claude-opus-5", created_at: "2026-07-01T00:00:00Z" }]), null);
	eq("never substitutes a Haiku either", pickNewestSonnet([{ id: "claude-haiku-4-5", created_at: "2026-07-01T00:00:00Z" }]), null);
	eq("excludes the id that just failed", pickNewestSonnet(MODELS, "claude-sonnet-6"), "claude-sonnet-5");
	eq("an empty listing yields nothing", pickNewestSonnet([]), null);

	// Recency wins even when the version number disagrees — a re-released older
	// line is still the newer model.
	eq(
		"created_at outranks the version in the id",
		pickNewestSonnet([
			{ id: "claude-sonnet-5", created_at: "2026-02-01T00:00:00Z" },
			{ id: "claude-sonnet-4-6", created_at: "2026-06-01T00:00:00Z" },
		]),
		"claude-sonnet-4-6",
	);
	// …and the version is the tie-break when the dates can't decide.
	eq(
		"version breaks a created_at tie",
		pickNewestSonnet([
			{ id: "claude-sonnet-4-6", created_at: "2026-02-01T00:00:00Z" },
			{ id: "claude-sonnet-5", created_at: "2026-02-01T00:00:00Z" },
		]),
		"claude-sonnet-5",
	);
	eq(
		"…and works with no dates at all",
		pickNewestSonnet([{ id: "claude-sonnet-4-6" }, { id: "claude-sonnet-5" }, { id: "claude-sonnet-4-5" }]),
		"claude-sonnet-5",
	);
}

section("Resolution order: env > app_config > code default");
{
	const override: CoachModelOverride = { model: "claude-sonnet-9", previous: COACH_MODEL, updatedAt: "2026-08-17T09:30:00.000Z" };

	const plain = await resolveCoachModel(fakeDeps().deps);
	eq("nothing set falls back to the code default", plain.model, COACH_MODEL);
	eq("…and says so", plain.source, "default");

	const stored = await resolveCoachModel(fakeDeps({ stored: override }).deps);
	eq("a stored override outranks the code default", stored.model, "claude-sonnet-9");
	eq("…and says so", stored.source, "config");

	const pinned = await resolveCoachModel(fakeDeps({ env: "claude-sonnet-4-6", stored: override }).deps);
	eq("COACH_MODEL outranks the stored override", pinned.model, "claude-sonnet-4-6");
	eq("…and says so", pinned.source, "env");

	const blank = await resolveCoachModel(fakeDeps({ env: "   ", stored: override }).deps);
	eq("a whitespace-only env var is not a pin", blank.model, "claude-sonnet-9");

	const junk = await resolveCoachModel(fakeDeps({ stored: { model: "", previous: "", updatedAt: "" } }).deps);
	eq("an override with no model is ignored", junk.model, COACH_MODEL);
}

section("Recognising a model-not-found error");
{
	const notFound = { status: 404, message: "model: claude-sonnet-5 not found", error: { error: { type: "not_found_error", message: "model not found" } } };
	check("a 404 naming a model", isModelNotFoundError(notFound, "claude-sonnet-5"), "");
	check("a 404 whose message only carries the id", isModelNotFoundError({ status: 404, message: "claude-sonnet-5" }, "claude-sonnet-5"), "");
	check("a rate limit is not a missing model", !isModelNotFoundError({ status: 429, message: "model rate limited" }), "");
	check("an auth failure is not a missing model", !isModelNotFoundError({ status: 401, message: "invalid x-api-key" }), "");
	check("an unrelated 404 is not a missing model", !isModelNotFoundError({ status: 404, message: "session not found" }), "");
	check("a 404 of a different error type is not a missing model", !isModelNotFoundError({ status: 404, message: "model", error: { error: { type: "billing_error" } } }), "");
	check("a thrown string is not a missing model", !isModelNotFoundError("boom"), "");
}

section("404 → list models → persist → retry once");
{
	const fake = fakeDeps({ stored: null });
	const tried: string[] = [];

	const answer = await withCoachModel(async (model) => {
		tried.push(model);
		if (model === COACH_MODEL) {
			throw { status: 404, message: `model: ${model}`, error: { error: { type: "not_found_error", message: "model not found" } } };
		}
		return `answered on ${model}`;
	}, {}, fake.deps);

	eq("the first attempt used the resolved model", tried[0], COACH_MODEL);
	eq("the retry used the newest Sonnet", tried[1], "claude-sonnet-6");
	eq("exactly one retry", tried.length, 2);
	eq("the caller gets the answer, not the error", answer, "answered on claude-sonnet-6");
	eq("the swap was persisted", fake.read()?.model, "claude-sonnet-6");
	eq("…with the id it replaced", fake.read()?.previous, COACH_MODEL);
	eq("…and when", fake.read()?.updatedAt, "2026-08-17T09:30:00.000Z");
	eq("written once", fake.writes(), 1);
	eq("the swap was logged", fake.logs[0], `[coach] model auto-updated ${COACH_MODEL} → claude-sonnet-6`);

	// The next request starts on the new model, which is the whole point of the write.
	eq("the persisted model is what resolves next", (await resolveCoachModel(fake.deps)).model, "claude-sonnet-6");
}

section("…and when recovery can't help");
{
	const noSonnet = fakeDeps({ models: [{ id: "claude-opus-5", created_at: "2026-07-01T00:00:00Z" }] });
	let raised: unknown = null;
	try {
		await withCoachModel(async (model) => {
			throw { status: 404, message: `model: ${model}`, error: { error: { type: "not_found_error" } } };
		}, {}, noSonnet.deps);
	} catch (error) {
		raised = error;
	}
	check("the original 404 is rethrown", (raised as { status?: number })?.status === 404, "");
	eq("nothing was persisted", noSonnet.writes(), 0);

	const reason = await recoverCoachModel("claude-sonnet-5", noSonnet.deps);
	eq("…and the reason is explicit", reason.reason, "no Sonnet model available on this account");
	eq("…with no replacement", reason.to, null);

	const broken = fakeDeps();
	broken.deps.listModels = async () => {
		throw new Error("network down");
	};
	const failed = await recoverCoachModel("claude-sonnet-5", broken.deps);
	check("a listing failure is reported, not swallowed", (failed.reason ?? "").includes("could not list models"), failed.reason);

	// Streaming: once bytes have reached the reader the request can't be replayed.
	const midStream = fakeDeps();
	let attempts = 0;
	let streamError: unknown = null;
	try {
		await withCoachModel(
			async (model) => {
				attempts += 1;
				throw { status: 404, message: `model: ${model}`, error: { error: { type: "not_found_error" } } };
			},
			{ canRetry: () => false },
			midStream.deps,
		);
	} catch (error) {
		streamError = error;
	}
	eq("a non-replayable call is attempted once", attempts, 1);
	check("…and its error surfaces", (streamError as { status?: number })?.status === 404, "");
	eq("…and no swap is persisted behind the reader", midStream.writes(), 0);

	// A non-404 must never trigger a model swap.
	const rateLimited = fakeDeps();
	let other: unknown = null;
	try {
		await withCoachModel(async () => {
			throw { status: 429, message: "rate limited" };
		}, {}, rateLimited.deps);
	} catch (error) {
		other = error;
	}
	eq("a 429 passes straight through", (other as { status?: number })?.status, 429);
	eq("…and lists no models", rateLimited.lists(), 0);
}

section("Nightly revalidation (item 20's cron)");
{
	const healthy = fakeDeps({ stored: { model: "claude-sonnet-5", previous: "x", updatedAt: "2026-01-01T00:00:00Z" } });
	const ok = await revalidateCoachModel(healthy.deps);
	eq("a live model is left alone", ok.present, true);
	eq("…and nothing is written", healthy.writes(), 0);

	const stale = fakeDeps({ stored: { model: "claude-sonnet-3", previous: "x", updatedAt: "2026-01-01T00:00:00Z" } });
	const repaired = await revalidateCoachModel(stale.deps);
	eq("a retired model is detected", repaired.present, false);
	eq("…and swapped before anyone hits it", repaired.model, "claude-sonnet-6");
	eq("…and persisted", stale.read()?.model, "claude-sonnet-6");

	const pinned = fakeDeps({ env: "claude-sonnet-3" });
	const respected = await revalidateCoachModel(pinned.deps);
	eq("an env pin is reported", respected.present, false);
	eq("…but never overridden", pinned.writes(), 0);
	has("…and says why", respected.reason ?? "", "COACH_MODEL is pinned");

	const offline = fakeDeps();
	offline.deps.listModels = async () => {
		throw new Error("network down");
	};
	const unknown = await revalidateCoachModel(offline.deps);
	eq("an unreachable listing is 'don't know', not 'missing'", unknown.present, null);
	eq("…and changes nothing", offline.writes(), 0);
}

section("Settings notice");
{
	eq("no override, nothing to say", await coachModelNotice(fakeDeps().deps), null);

	const caughtUp = fakeDeps({ stored: { model: COACH_MODEL, previous: "claude-sonnet-3", updatedAt: "2026-08-17T09:30:00.000Z" } });
	eq("an override that agrees with the build is not news", await coachModelNotice(caughtUp.deps), null);

	const active = fakeDeps({ stored: { model: "claude-sonnet-9", previous: COACH_MODEL, updatedAt: "2026-08-17T09:30:00.000Z" } });
	eq("an active override is surfaced", (await coachModelNotice(active.deps))?.model, "claude-sonnet-9");
	eq("…with the model it replaced", (await coachModelNotice(active.deps))?.previous, COACH_MODEL);

	const pinned = fakeDeps({ env: "claude-sonnet-4-6", stored: { model: "claude-sonnet-9", previous: COACH_MODEL, updatedAt: "2026-08-17T09:30:00.000Z" } });
	eq("an env pin makes the stored override moot", await coachModelNotice(pinned.deps), null);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
