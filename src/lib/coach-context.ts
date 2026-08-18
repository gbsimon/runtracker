import { type DailyMetricsView, formatHours, getDailyMetrics } from "./daily-metrics";
import type { HeartRateSample, RoutePoint, Split } from "./ingest/hae";
import { getPlan, type PlanRecord } from "./plan";
import { raceLabel, workoutKey } from "./plan-types";
import { enrichSplits } from "./run-detail";
import { loadRunStreams } from "./run-streams";
import { energyKcal, readRunMetrics } from "./run-metrics";
import { listRuns, type RunRecord, runDistanceKm, runLocalDateISO, runLocalTime } from "./runs";
import {
	addDaysISO,
	currentWeekNumber,
	formatDuration,
	formatKm,
	formatMonthDay,
	formatWeekdayLong,
	isISODate,
	paceSeconds,
	weekdayAbbrISO,
	workoutDateISO,
} from "./running";
import {
	aerobicDecoupling,
	efficiencyTrend,
	type EfficiencyTrend,
	hrRecoveryStats,
	type TrainingRun,
	weeklyLoad,
	type WeeklyLoadReport,
} from "./training-metrics";
import { readWeather, type WeatherDisplay } from "./weather";

/**
 * Everything the coach knows, rendered as text.
 *
 * v1 sent the plan and a distance-and-pace line per run. This version sends the
 * physiology too — heart rate, cadence, climb, weather and energy on every
 * recent run, per-kilometre splits for the two that matter most, weekly load,
 * and the recovery metrics the watch records overnight. Simon's brief was
 * "make sure Claude AI receives a lot of information"; the counterweight is
 * that every token is billed on every turn of a multi-turn chat, so older runs
 * summarise into weekly aggregates rather than each getting a paragraph.
 *
 * The two hard constraints on edits here:
 *
 *  1. `buildCoachContext` is a pure function of `CoachData`. All the database
 *     work lives in `loadCoachData` at the bottom, which is what lets
 *     `pnpm check:coach-context` render the whole prompt from fixtures.
 *  2. The `:::plan-change` protocol and the FULL PLAN day lines are the
 *     contract `plan-change.ts` parses back. They are reproduced verbatim from
 *     v1 and the check asserts the protocol byte-for-byte — new material goes
 *     around them, never through them.
 */

/** How far back a run still gets its own fully enriched paragraph. */
const RECENT_DAYS = 14;
/** How many weeks of aggregates stand in for the runs older than that. */
const LOAD_WEEKS = 8;
/** Recovery window. Seven days is what a runner can hold in their head. */
const RECOVERY_DAYS = 7;
/** A split table longer than this is a marathon; the tail stops earning its tokens. */
const MAX_SPLIT_ROWS = 30;
/** Below this a decoupling figure measures the warm-up, not the runner. */
const MIN_DECOUPLING_MINUTES = 20;
/** Drift past this on a steady run is the aerobic-base flag the guidance names. */
export const DECOUPLING_FLAG_PCT = 10;

export type LoggedRun = {
	dateISO: string;
	distanceKm: number;
	durationS: number;
	effort: number | null;
	notes: string | null;
};

/** One per-kilometre row of a highlighted run's split table. */
export type CoachSplit = {
	km: number;
	paceSPerKm: number;
	avgHr: number | null;
	elevationDeltaM: number | null;
	partial: boolean;
};

export type CoachDecoupling = {
	driftPct: number | null;
	steady: boolean;
	reason?: string;
};

/** A run inside the recent window, with everything the watch recorded about it. */
export type RecentRun = LoggedRun & {
	/** Local clock time it started, `HH:MM` — heat and fatigue both track it. */
	time: string | null;
	/** What the plan asked for that day, when the day was planned. */
	plannedType: string | null;
	avgHr: number | null;
	maxHr: number | null;
	avgCadence: number | null;
	elevationGainM: number | null;
	weather: WeatherDisplay | null;
	energyKcal: number | null;
	/** Beats shed in the first minute after stopping, and the second when recorded. */
	hrDrop60: number | null;
	hrDrop120: number | null;
	hrPeakBpm: number | null;
	decoupling: CoachDecoupling | null;
	/** Present only on the two highlighted runs. */
	splits: CoachSplit[] | null;
	splitsTruncated: number;
	/** Why this run got its splits — "long run" / "quality run". */
	highlight: string | null;
};

export type CoachSignals = {
	efficiency: EfficiencyTrend;
	/** Oldest first, so the direction reads off the page. */
	hrRecovery: { dateISO: string; drop60: number | null; drop120: number | null }[];
};

export type CoachData = {
	plan: PlanRecord | null;
	runs: LoggedRun[];
	today: string;
	/** All four are optional so a caller with only a plan still renders. */
	recent?: RecentRun[];
	weekly?: WeeklyLoadReport | null;
	recovery?: DailyMetricsView | null;
	signals?: CoachSignals | null;
};

export function toLoggedRuns(runs: RunRecord[], zone: string): LoggedRun[] {
	return runs.map((run) => ({
		dateISO: runLocalDateISO(run, zone),
		distanceKm: runDistanceKm(run),
		durationS: run.durationS,
		effort: run.effort,
		notes: run.notes,
	}));
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function paceLabel(run: LoggedRun): string {
	const seconds = paceSeconds(run.distanceKm, run.durationS);
	return seconds > 0 ? formatDuration(seconds) : "?";
}

/** "5km in 30:00 (6:00/km, effort 5/10)" — v1's inline actuals. */
function actuals(run: LoggedRun): string {
	const effort = run.effort ? `, effort ${run.effort}/10` : "";
	return `${formatKm(run.distanceKm)}km in ${formatDuration(run.durationS)} (${paceLabel(run)}/km${effort})`;
}

function signed(value: number, digits = 1): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function signedInt(value: number): string {
	return `${value >= 0 ? "+" : ""}${Math.round(value)}`;
}

function round(value: number, digits = 1): string {
	return value.toFixed(digits);
}

/** `"a · b · c"`, skipping the parts that had nothing to say. */
function joinParts(parts: (string | null)[]): string {
	return parts.filter((part): part is string => part !== null && part.length > 0).join(" · ");
}

function weatherLine(weather: WeatherDisplay | null): string | null {
	if (!weather) return null;
	return joinParts([
		weather.condition ? `${weather.condition.emoji} ${weather.condition.label}` : null,
		weather.tempC === null ? null : `${round(weather.tempC)}°C`,
		weather.humidityPct === null ? null : `${Math.round(weather.humidityPct)}% humidity`,
		weather.windKmh === null ? null : `wind ${Math.round(weather.windKmh)}km/h`,
		weather.precipMm === null || weather.precipMm <= 0 ? null : `rain ${round(weather.precipMm)}mm`,
	]);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderSplits(run: RecentRun): string {
	if (!run.splits || run.splits.length === 0) return "";

	let out = `    Per-km splits (km · pace · avg HR · net climb):\n`;
	for (const split of run.splits) {
		const label = split.partial ? `${split.km}(part)` : `${split.km}`;
		out += `      ${label} ${formatDuration(split.paceSPerKm)}/km ${
			split.avgHr === null ? "no HR" : `${split.avgHr}bpm`
		} ${split.elevationDeltaM === null ? "climb n/a" : `${signedInt(split.elevationDeltaM)}m`}\n`;
	}
	if (run.splitsTruncated > 0) out += `      …${run.splitsTruncated} further splits omitted\n`;
	return out;
}

function renderRecentRun(run: RecentRun): string {
	const heading = joinParts([
		`${run.dateISO} ${weekdayAbbrISO(run.dateISO)}`,
		run.time,
		run.plannedType ? `planned: ${run.plannedType}` : null,
		run.highlight ? `[${run.highlight}]` : null,
	]);

	let out = `  ${heading}\n`;
	out += `    ${actuals(run)}\n`;

	const body = joinParts([
		run.avgHr === null ? null : `HR ${run.avgHr}avg${run.maxHr === null ? "" : `/${run.maxHr}max`} bpm`,
		run.avgCadence === null ? null : `cadence ${Math.round(run.avgCadence)}spm`,
		run.elevationGainM === null ? null : `climb ${Math.round(run.elevationGainM)}m`,
		run.energyKcal === null ? null : `${run.energyKcal}kcal`,
	]);
	if (body) out += `    ${body}\n`;

	const weather = weatherLine(run.weather);
	if (weather) out += `    Weather: ${weather}\n`;

	if (run.hrDrop60 !== null) {
		// A negative drop means heart rate rose after the finish — "--11bpm" reads as a typo.
		const drop = (d: number) => (d >= 0 ? `-${d}bpm` : `rose ${-d}bpm`);
		out += `    HR recovery: ${drop(run.hrDrop60)} in the first minute${
			run.hrDrop120 === null ? "" : `, ${drop(run.hrDrop120)} by two minutes`
		}${run.hrPeakBpm === null ? "" : ` (from ${run.hrPeakBpm}bpm)`}\n`;
	}

	if (run.decoupling) {
		out +=
			run.decoupling.driftPct === null
				? `    Aerobic decoupling: not measurable — ${run.decoupling.reason ?? "insufficient data"}\n`
				: `    Aerobic decoupling: ${signed(run.decoupling.driftPct)}%${
						run.decoupling.steady ? " over a steady effort" : " (effort varied — read with caution)"
					}\n`;
	}

	if (run.notes) out += `    Notes: "${run.notes}"\n`;
	out += renderSplits(run);
	return out;
}

function renderRecentRuns(recent: RecentRun[]): string {
	let out = `\nRECENT RUNS (last ${RECENT_DAYS} days, newest first — everything the watch recorded):\n`;
	if (recent.length === 0) {
		out += `  No runs in the last ${RECENT_DAYS} days.\n`;
		return out;
	}
	for (const run of recent) out += renderRecentRun(run);
	return out;
}

function renderWeekly(report: WeeklyLoadReport): string {
	let out = `\nWEEKLY VOLUME & LOAD (last ${report.weeks.length} weeks; load is ${report.loadUnit}, HR max ${report.hrMax} ${report.hrMaxSource}):\n`;
	for (const week of report.weeks) {
		if (week.runs === 0) {
			out += `  ${week.week} (from ${week.weekStart}): no runs\n`;
			continue;
		}
		const coverage =
			week.loadCoverage >= 1
				? `load ${week.load}`
				: week.loadCoverage <= 0
					? `load not computable (no HR)`
					: `load ${week.load} (from the ${Math.round(week.loadCoverage * 100)}% of minutes with HR)`;
		out += `  ${week.week} (from ${week.weekStart}): ${week.runs} run${week.runs === 1 ? "" : "s"}, ${round(week.km)}km, ${formatDuration(week.durationS)}, ${coverage}\n`;
	}
	return out;
}

function sleepDetail(view: DailyMetricsView["days"][number]): string | null {
	const sleep = view.sleep;
	if (!sleep) return null;
	const total = formatHours(sleep.totalSleep);
	const stages = joinParts([
		sleep.rem === null ? null : `REM ${formatHours(sleep.rem)}`,
		sleep.core === null ? null : `core ${formatHours(sleep.core)}`,
		sleep.deep === null ? null : `deep ${formatHours(sleep.deep)}`,
		sleep.awake === null || sleep.awake <= 0 ? null : `awake ${formatHours(sleep.awake)}`,
	]);
	if (!total && !stages) return null;
	return `sleep ${total ?? "?"}${stages ? ` (${stages})` : ""}`;
}

/**
 * The recovery window, day by day.
 *
 * Days the watch wasn't worn are printed as "not recorded" rather than left
 * out: a gap the model can see is a gap it won't read as a rest day, and the
 * averages below carry their own denominators for the same reason.
 */
function renderRecovery(recovery: DailyMetricsView, today: string): string {
	let out = `\nRECOVERY — last ${RECOVERY_DAYS} days (${METRIC_LEGEND}):\n`;

	const byDay = new Map(recovery.days.map((day) => [day.day, day]));
	for (let i = RECOVERY_DAYS - 1; i >= 0; i--) {
		const iso = addDaysISO(today, -i);
		const day = byDay.get(iso);
		const label = `${iso} ${weekdayAbbrISO(iso)}`;

		if (!day) {
			out += `  ${label}: not recorded\n`;
			continue;
		}
		const line = joinParts([
			day.restingHrBpm === null ? null : `resting HR ${Math.round(day.restingHrBpm)}bpm`,
			day.hrvMs === null ? null : `HRV ${Math.round(day.hrvMs)}ms`,
			sleepDetail(day),
			day.vo2Max === null ? null : `VO2max ${round(day.vo2Max)}`,
		]);
		out += `  ${label}: ${line || "not recorded"}\n`;
	}

	const { latest, averages } = recovery;
	const latestLine = joinParts([
		latest.restingHrBpm ? `resting HR ${Math.round(latest.restingHrBpm.value)}bpm (${formatMonthDay(latest.restingHrBpm.day)})` : null,
		latest.hrvMs ? `HRV ${Math.round(latest.hrvMs.value)}ms (${formatMonthDay(latest.hrvMs.day)})` : null,
		latest.sleep && formatHours(latest.sleep.value.totalSleep)
			? `sleep ${formatHours(latest.sleep.value.totalSleep)} (${formatMonthDay(latest.sleep.day)})`
			: null,
		latest.vo2Max ? `VO2max ${round(latest.vo2Max.value)} (${formatMonthDay(latest.vo2Max.day)})` : null,
	]);
	if (latestLine) out += `  Latest reading: ${latestLine}\n`;

	const averageLine = joinParts([
		averages.restingHrBpm === null ? null : `resting HR ${round(averages.restingHrBpm)}bpm over ${averages.restingHrDays} day${averages.restingHrDays === 1 ? "" : "s"}`,
		averages.hrvMs === null ? null : `HRV ${round(averages.hrvMs)}ms over ${averages.hrvDays} day${averages.hrvDays === 1 ? "" : "s"}`,
		averages.sleepHours === null ? null : `sleep ${formatHours(averages.sleepHours)} over ${averages.sleepNights} night${averages.sleepNights === 1 ? "" : "s"}`,
	]);
	out += averageLine
		? `  Window average: ${averageLine}\n`
		: `  Window average: nothing recorded in this window.\n`;

	// The comparison the runner would make themselves, done once so the model
	// doesn't have to subtract in its head and get it subtly wrong.
	const deltas = joinParts([
		latest.hrvMs && averages.hrvMs !== null
			? `HRV ${Math.round(latest.hrvMs.value)}ms vs ${round(averages.hrvMs)}ms average (${signed(latest.hrvMs.value - averages.hrvMs)})`
			: null,
		latest.restingHrBpm && averages.restingHrBpm !== null
			? `resting HR ${Math.round(latest.restingHrBpm.value)}bpm vs ${round(averages.restingHrBpm)}bpm average (${signed(latest.restingHrBpm.value - averages.restingHrBpm)})`
			: null,
		latest.sleep?.value.totalSleep != null && averages.sleepHours !== null
			? `sleep ${formatHours(latest.sleep.value.totalSleep)} vs ${formatHours(averages.sleepHours)} average (${signed((latest.sleep.value.totalSleep - averages.sleepHours) * 60, 0)}min)`
			: null,
	]);
	if (deltas) out += `  Latest vs average: ${deltas}\n`;

	return out;
}

const METRIC_LEGEND = "HRV is SDNN in ms; absent days were not measured, never zero";

function renderEfficiency(trend: EfficiencyTrend): string {
	if (trend.direction === null || trend.changePer30Days === null) {
		return `  Aerobic efficiency: no trend yet — ${trend.reason ?? "not enough comparable runs"}.\n`;
	}
	const band = trend.band ? ` across ${trend.points.length} runs at ${trend.band.loBpm}-${trend.band.hiBpm}bpm` : "";
	const pct = trend.changePctPer30Days === null ? "" : ` (${signed(trend.changePctPer30Days)}%)`;
	return `  Aerobic efficiency: ${trend.direction} — ${signed(trend.changePer30Days, 2)} ${trend.unit} per 30 days${pct}${band}. Latest ${round(
		trend.points.at(-1)?.metresPerBeat ?? 0,
		2,
	)} m/beat.\n`;
}

function renderSignals(signals: CoachSignals, recent: RecentRun[]): string {
	let out = `\nTRAINING SIGNALS:\n`;
	out += renderEfficiency(signals.efficiency);

	const steady = recent.filter((run) => run.decoupling?.steady && run.decoupling.driftPct !== null);
	if (steady.length === 0) {
		out += `  Aerobic decoupling: no steady run long enough to measure in this window.\n`;
	} else {
		out += `  Aerobic decoupling on steady runs (over ${DECOUPLING_FLAG_PCT}% suggests the aerobic base is still developing): ${steady
			.map((run) => `${run.dateISO} ${signed(run.decoupling?.driftPct ?? 0)}%`)
			.join(" · ")}\n`;
	}

	const drops = signals.hrRecovery.filter((entry) => entry.drop60 !== null);
	out +=
		drops.length === 0
			? `  HR recovery: no post-run recovery recorded yet.\n`
			: `  HR recovery, first-minute drop (higher is fitter), oldest first: ${drops
					.map((entry) => `${entry.dateISO} -${entry.drop60}bpm`)
					.join(" · ")}\n`;

	return out;
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export function buildCoachContext({ plan, runs, today, recent, weekly, recovery, signals }: CoachData): string {
	const weeks = plan?.weeks ?? [];
	const settings = plan?.settings;
	const hasPlan = weeks.length > 0 && isISODate(settings?.startDate);
	const startDate = settings?.startDate ?? "";

	const currentWeek = hasPlan ? currentWeekNumber(startDate, weeks.length, today) : 0;
	const currentPlan = weeks.find((week) => week.week === currentWeek);

	const runsByDate = new Map<string, LoggedRun[]>();
	for (const run of runs) {
		runsByDate.set(run.dateISO, [...(runsByDate.get(run.dateISO) ?? []), run]);
	}

	const completedThisWeek = currentPlan
		? currentPlan.days.filter((_, i) => plan?.completed[workoutKey(currentWeek, i)]).length
		: 0;
	const totalThisWeek = currentPlan ? currentPlan.days.length : 0;

	const raceDistance = settings?.raceDistance ?? 21.1;
	const raceDate = settings?.raceDate || "TBD";
	const targetPace = settings?.targetPace ?? "";
	const paceInfo = targetPace ? ` Target race pace: ${targetPace} min/km.` : "";
	const totalKm = runs.reduce((sum, run) => sum + run.distanceKm, 0);

	let ctx = `TODAY: ${today} (${formatWeekdayLong(today)}). All dates in this context are ISO YYYY-MM-DD. "Last week" = before ${today}, "next week" = after ${today}.\n`;
	ctx += `RUNNER PROFILE: Beginner runner training for a ${raceLabel(raceDistance)} (${raceDistance}km) on ${raceDate}.${paceInfo}\n`;
	ctx += hasPlan
		? `PLAN: ${weeks.length} weeks total. CURRENT STATUS: Week ${currentWeek} of ${weeks.length}. ${completedThisWeek}/${totalThisWeek} workouts completed this week.\n`
		: `PLAN: none set up yet — the runner has not generated a training plan.\n`;
	ctx += `TOTAL LOGGED: ${runs.length} runs, ${totalKm.toFixed(1)} km total.\n`;

	// The measurements, before the plan table: this is the state the runner is
	// in right now, and the plan below is the reference it gets read against.
	if (recent) ctx += renderRecentRuns(recent);
	if (weekly) ctx += renderWeekly(weekly);
	if (recovery) ctx += renderRecovery(recovery, today);
	if (signals) ctx += renderSignals(signals, recent ?? []);

	ctx += `\n`;

	const plannedDates = new Set<string>();

	if (hasPlan) {
		ctx += `FULL PLAN (each day shows: date • planned • [logged actuals if any]):\n`;
		for (const week of weeks) {
			let marker: string;
			if (week.week < currentWeek) marker = "PAST";
			else if (week.week === currentWeek) marker = "CURRENT";
			else if (week.week === currentWeek + 1) marker = "NEXT";
			else marker = "FUTURE";

			ctx += `\nWeek ${week.week} (${week.phase}) — ${marker}:\n`;
			week.days.forEach((day, i) => {
				const dateISO = workoutDateISO(startDate, week.week, day.day);
				plannedDates.add(dateISO);
				const planned = `${day.type} ${day.distance}km${day.pace ? ` @${day.pace}/km` : ""}`;
				const logged = runsByDate.get(dateISO) ?? [];

				let status: string;
				if (plan?.skipped[workoutKey(week.week, i)]) status = "SKIPPED";
				else if (dateISO < today) status = plan?.completed[workoutKey(week.week, i)] || logged.length ? "DONE" : "MISSED";
				else if (dateISO === today) status = "TODAY";
				else status = "UPCOMING";

				let line = `  ${day.day} ${dateISO} [${status}]: ${planned}`;
				if (logged.length) {
					line += ` → LOGGED: ${logged
						.map((run) => `${actuals(run)}${run.notes ? ` — "${run.notes}"` : ""}`)
						.join("; ")}`;
				}
				ctx += `${line}\n`;
			});
		}
	}

	const orphans = runs.filter((run) => !plannedDates.has(run.dateISO)).sort((a, b) => b.dateISO.localeCompare(a.dateISO));
	if (orphans.length) {
		ctx += `\nUNPLANNED LOGGED RUNS (not on a plan day):\n`;
		for (const run of orphans) {
			ctx += `${run.dateISO}: ${actuals(run)}${run.notes ? ` — ${run.notes}` : ""}\n`;
		}
	}

	return ctx;
}

/**
 * How to read the numbers above — kept separate from the plan-change protocol
 * so the two can be edited without disturbing each other.
 */
export const COACH_GUIDANCE = `USING THE PHYSIOLOGY DATA:
The data sections in this context are the live, current state of the runner's data, rebuilt for every message. They are authoritative and override anything earlier in the conversation — including your own previous replies claiming data was unavailable, which predate the data connection. Never tell the runner you lack access to runs, heart rate, cadence, sleep, HRV, weather or splits when the sections above carry them.
The context below carries real measurements, not estimates. Ground your advice in them and cite the specific numbers you reasoned from ("your HRV is 88ms against a 7-day average of 83") — a recommendation the runner can trace back to their own data is one they will act on. Where the data doesn't support a conclusion, say so rather than filling the gap; absent days in the recovery block mean the watch wasn't worn, not that the value was zero.
- Recovery: a low HRV, a short or broken night, and a resting heart rate above its recent average arriving together is the signal to make the next session easier or move it. Any one of them alone is normal variation — say which of the three you are seeing before recommending a change.
- Aerobic decoupling: on a run marked steady, drift above ${DECOUPLING_FLAG_PCT}% means heart rate climbed while pace held, i.e. the aerobic base is still developing — the answer is more easy volume, not harder sessions. Ignore the figure on runs not marked steady; there it measures the intervals rather than the runner.
- HR recovery: the first-minute drop after stopping trends upward as fitness improves. Read it as a trend across runs, never off a single number.
- Efficiency: metres per heartbeat rising at a matched heart rate is genuine aerobic progress; treat a "no trend yet" reason as missing data, not as stagnation.
- Weather, cadence and climb explain a pace that looks slow on paper. Check them before suggesting that a run went badly — 28°C and 300m of climb are worth roughly a minute per kilometre.
- Weekly load is Edwards TRIMP in weighted minutes. Big week-on-week jumps matter more than the absolute number; note the HR coverage before leaning on a week's load.
When the data says the training should change, action it with a plan-change block using the protocol above.`;

export function buildCoachSystemPrompt(data: CoachData): string {
	const raceDistance = data.plan?.settings.raceDistance ?? 21.1;
	const targetPace = data.plan?.settings.targetPace ?? "";

	return `You are an experienced, encouraging running coach helping a beginner train for their ${raceLabel(raceDistance)} (${raceDistance}km). You have access to their training plan and recent activity data below.

Be concise, practical, and supportive. Give specific advice based on their actual data. If they report pain or injury, always err on the side of caution. Adjust recommendations based on their perceived effort and progress.

PLAN MODIFICATIONS:
When you recommend changing the training plan (due to injury, fatigue, extra energy, schedule changes, etc.), include a plan change block so the runner can apply it with one click. Use this exact format:

:::plan-change
{"changes": [
  {"week": 5, "days": [
    {"day": "Tue", "type": "Easy Run", "distance": 2, "pace": "7:15", "notes": "Reduced — recovery from shin pain"},
    {"day": "Thu", "type": "Rest", "distance": 0, "notes": "Extra rest day"},
    {"day": "Sun", "type": "Long Run", "distance": 4, "pace": "7:00", "notes": "Keep it short and easy"}
  ]},
  {"week": 6, "days": [
    {"day": "Tue", "type": "Easy Run", "distance": 2.5, "pace": "7:15", "notes": "Gradual return"},
    {"day": "Thu", "type": "Easy Run", "distance": 2, "pace": "7:15", "notes": "Easy pace"},
    {"day": "Sun", "type": "Long Run", "distance": 5, "pace": "7:00", "notes": "Build back slowly"}
  ]}
], "summary": "Reduced weeks 5-6 for shin recovery"}
:::

Each change entry can also carry an optional "skips" list to mark specific days as skipped (deliberately not doing them) without editing their planned type/distance — e.g. when the runner says they can't make a specific run this week:

:::plan-change
{"changes": [
  {"week": 5, "skips": [{"day": "Thu", "skipped": true}]}
], "summary": "Skipped Thursday's run — you're traveling"}
:::

"days" and "skips" can appear together in the same week entry ("days" is applied first, then "skips" — so skip days by their NEW position if you're also changing that week's days). A change entry may include only "skips" and no "days" at all.

Rules for plan changes:
- CRITICAL: Use the FULL PLAN above (each day has its ISO date) to find the correct week number for any calendar date the user mentions. Anchor all relative dates ("today", "this week", "next week", "last week") to the TODAY value at the top of the context — never guess from training data
- Only include weeks that actually change
- When you change a week's "days", include EVERY day of that week — applying a change replaces that week's days, so any day you omit is removed. This does not apply to "skips", which only touches the days you list
- Day abbreviations: Mon, Tue, Wed, Thu, Fri, Sat, Sun
- Valid types: Easy Run, Long Run, Tempo Run, Intervals, Race Pace, Shakeout, Rest, or any custom type (e.g. "🏁 10K Race", "🏁 5K Race")
- When adding a tune-up race: adjust the week before (lighter) and after (recovery) too
- Always explain your reasoning in the message text BEFORE the plan-change block
- You can modify multiple weeks at once
- You can change distances, swap workout types, add rest days, or add extra runs
- Include a "pace" field (string, format "M:SS" e.g. "6:00") for each workout with a suggested pace in min/km${targetPace ? `. The runner's target race pace is ${targetPace} min/km` : ""}
- When asked to add paces to the plan, include ALL weeks in the plan-change block with appropriate paces for each workout type
- Use "skips" (set skipped: true) when the runner can't do a specific planned workout but the plan itself shouldn't change — e.g. a one-off missed day from travel or a minor scheduling conflict. Use "skipped: false" in a "skips" entry to undo a previous skip
- Days marked [SKIPPED] in the FULL PLAN below were deliberately skipped by the runner or coach — treat them as intentional, not as missed or a sign of poor adherence

${COACH_GUIDANCE}

${buildCoachContext(data)}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Plan day types that count as a hard session when choosing the second split table. */
const QUALITY_TYPES = ["tempo", "interval", "race pace", "threshold", "speed", "fartlek", "race"];

function isQualityType(type: string | null): boolean {
	if (!type) return false;
	const lower = type.toLowerCase();
	return QUALITY_TYPES.some((quality) => lower.includes(quality));
}

/** ISO date → the workout the plan asked for that day. */
function plannedTypesByDate(plan: PlanRecord | null): Map<string, string> {
	const byDate = new Map<string, string>();
	const startDate = plan?.settings.startDate;
	if (!plan || !isISODate(startDate)) return byDate;

	for (const week of plan.weeks) {
		for (const day of week.days) {
			byDate.set(workoutDateISO(startDate, week.week, day.day), day.type);
		}
	}
	return byDate;
}

function toTrainingRuns(runs: RunRecord[], zone: string): TrainingRun[] {
	return runs.map((run) => ({
		id: run.id,
		day: runLocalDateISO(run, zone),
		distanceM: run.distanceM,
		durationS: run.durationS,
		avgHr: run.avgHr,
		maxHr: run.maxHr,
	}));
}

function toCoachSplits(splits: Split[], route: RoutePoint[], heartRate: HeartRateSample[]): { rows: CoachSplit[]; truncated: number } {
	const enriched = enrichSplits(splits, route, heartRate);
	const rows = enriched.slice(0, MAX_SPLIT_ROWS).map((split) => ({
		km: split.km,
		paceSPerKm: Math.round(split.paceSPerKm),
		avgHr: split.avgHr,
		elevationDeltaM: split.elevationDeltaM === null ? null : Math.round(split.elevationDeltaM),
		partial: split.partial === true,
	}));
	return { rows, truncated: Math.max(0, enriched.length - rows.length) };
}

/**
 * Loads the runner's plan, runs and recovery, enriches the recent window, and
 * hands back everything `buildCoachSystemPrompt` renders.
 *
 * Two deliberate economies. Streams are fetched by kind, so the ~500 kB route
 * of every recent run stays in the database — only the two runs that get a
 * split table pay for their route, because that is where the per-kilometre
 * climb comes from. And only the recent window is enriched at all; older runs
 * reach the prompt as weekly aggregates.
 */
export async function loadCoachData(userId: string, today: string, zone: string): Promise<CoachData> {
	const [plan, runs, recovery] = await Promise.all([
		getPlan(userId),
		listRuns(userId),
		getDailyMetrics(userId, { days: RECOVERY_DAYS, endDay: today }).catch(() => null),
	]);

	const trainingRuns = toTrainingRuns(runs, zone);
	const weekly = weeklyLoad(trainingRuns, LOAD_WEEKS, { endDay: today });
	const efficiency = efficiencyTrend(trainingRuns);

	const since = addDaysISO(today, -(RECENT_DAYS - 1));
	const window = runs
		.filter((run) => {
			const day = runLocalDateISO(run, zone);
			return day >= since && day <= today;
		})
		.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

	// Splits and the recovery tail are ~2 kB a run; the route is not, so it is
	// left out of this read entirely.
	const streams = await loadRunStreams(
		window.map((run) => run.id),
		["splits", "heart_rate", "hr_recovery"],
	);

	const planned = plannedTypesByDate(plan);

	// The two runs worth a per-kilometre table: the longest, and the most
	// recent hard session the plan named.
	const longest = window.reduce<RunRecord | null>(
		(best, run) => (best === null || run.distanceM > best.distanceM ? run : best),
		null,
	);
	const quality =
		window.find(
			(run) => run.id !== longest?.id && isQualityType(planned.get(runLocalDateISO(run, zone)) ?? null),
		) ?? null;

	const highlightIds = [longest?.id, quality?.id].filter((id): id is string => typeof id === "string");
	const routes = highlightIds.length > 0 ? await loadRunStreams(highlightIds, ["route"]) : new Map();

	const recent: RecentRun[] = window.map((run) => {
		const dateISO = runLocalDateISO(run, zone);
		const series = streams.get(run.id) ?? {};
		const heartRate = series.heart_rate ?? [];
		const splits = series.splits ?? [];
		const metrics = readRunMetrics(run.metrics);

		const recoveryStats = hrRecoveryStats(series.hr_recovery ?? []);

		let decoupling: CoachDecoupling | null = null;
		if (run.durationS >= MIN_DECOUPLING_MINUTES * 60 && heartRate.length > 0) {
			const computed = aerobicDecoupling({ splits }, heartRate);
			decoupling = { driftPct: computed.driftPct, steady: computed.steady, reason: computed.reason };
		}

		const highlight = run.id === longest?.id ? "long run" : run.id === quality?.id ? "quality run" : null;
		const table =
			highlight && splits.length > 0
				? toCoachSplits(splits, (routes.get(run.id) ?? {}).route ?? [], heartRate)
				: null;

		return {
			dateISO,
			distanceKm: runDistanceKm(run),
			durationS: run.durationS,
			effort: run.effort,
			notes: run.notes,
			time: runLocalTime(run, zone),
			plannedType: planned.get(dateISO) ?? null,
			avgHr: run.avgHr,
			maxHr: run.maxHr,
			avgCadence: run.avgCadence,
			elevationGainM: run.elevationGainM,
			weather: readWeather(run.weather),
			energyKcal: energyKcal(metrics),
			hrDrop60: recoveryStats.drop60,
			hrDrop120: recoveryStats.drop120,
			hrPeakBpm: recoveryStats.peakBpm,
			decoupling,
			splits: table?.rows ?? null,
			splitsTruncated: table?.truncated ?? 0,
			highlight,
		};
	});

	const hrRecovery = [...recent]
		.reverse()
		.filter((run) => run.hrDrop60 !== null)
		.map((run) => ({ dateISO: run.dateISO, drop60: run.hrDrop60, drop120: run.hrDrop120 }));

	return {
		plan,
		runs: toLoggedRuns(runs, zone),
		today,
		recent,
		weekly,
		recovery,
		signals: { efficiency, hrRecovery },
	};
}

/**
 * A three-line recovery summary for the plan generator, which needs to know
 * whether the runner is currently rested — not their whole physiology.
 */
export function recoverySummary(recovery: DailyMetricsView | null): string {
	if (!recovery || recovery.days.length === 0) return "";

	const { latest, averages } = recovery;
	const parts = joinParts([
		latest.restingHrBpm ? `resting HR ${Math.round(latest.restingHrBpm.value)}bpm` : null,
		latest.hrvMs ? `HRV ${Math.round(latest.hrvMs.value)}ms` : null,
		latest.sleep && formatHours(latest.sleep.value.totalSleep)
			? `sleep ${formatHours(latest.sleep.value.totalSleep)}`
			: null,
		latest.vo2Max ? `VO2max ${round(latest.vo2Max.value)}` : null,
	]);
	if (!parts) return "";

	const context = joinParts([
		averages.hrvMs === null ? null : `HRV ${round(averages.hrvMs)}ms over ${averages.hrvDays} days`,
		averages.restingHrBpm === null ? null : `resting HR ${round(averages.restingHrBpm)}bpm over ${averages.restingHrDays} days`,
		averages.sleepHours === null ? null : `sleep ${formatHours(averages.sleepHours)} over ${averages.sleepNights} nights`,
	]);

	return `\nCurrent recovery — latest: ${parts}.${context ? ` Recent average: ${context}.` : ""} Scale early weeks down if these show the runner is under-recovered.`;
}
