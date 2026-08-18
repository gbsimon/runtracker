/**
 * Unit checks for the daily-metrics parser, the day-keyed read shape and the
 * computed training signals, run against the two real captured payloads.
 *
 *   pnpm check:metrics
 *
 * Both fixtures are gitignored (real GPS and real health data on a public
 * repo), so this prints aggregates and never a coordinate.
 */

import { existsSync, readFileSync } from "node:fs";
import { type DailyMetricRow, formatHours, toDailyMetricsView } from "../src/lib/daily-metrics.ts";
import { type ParsedWorkout, parseHaePayload } from "../src/lib/ingest/hae.ts";
import { hasMetrics, parseHaeMetricsPayload, type SleepValue } from "../src/lib/ingest/metrics.ts";
import {
	aerobicDecoupling,
	efficiencyTrend,
	hrRecoveryStats,
	hrZone,
	isoWeekKey,
	paceVariationPct,
	type TrainingRun,
	weeklyLoad,
} from "../src/lib/training-metrics.ts";

const WORKOUTS = "fixtures/hae/real-payload-2026-08-17.json";
const METRICS = "fixtures/hae/metrics-payload-2026-08-17.json";

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

function close(label: string, actual: number | null, expected: number, tolerance: number): void {
	const ok = actual !== null && Math.abs(actual - expected) <= tolerance;
	check(label, ok, `got ${actual}, want ${expected} ±${tolerance}`);
}

function section(title: string): void {
	console.log(`\n${title}`);
}

for (const fixture of [WORKOUTS, METRICS]) {
	if (!existsSync(fixture)) {
		console.error(`Missing ${fixture} — the real captures are gitignored; copy them in before running these checks.`);
		process.exit(1);
	}
}

const metricsPayload = JSON.parse(readFileSync(METRICS, "utf8"));
const workoutPayload = JSON.parse(readFileSync(WORKOUTS, "utf8"));

// ---------------------------------------------------------------------------

section("Telling the two automations apart");
{
	eq("the metrics payload carries metrics", hasMetrics(metricsPayload), true);
	eq("the workouts payload does not", hasMetrics(workoutPayload), false);
	eq("neither does junk", hasMetrics({ data: { metrics: [] } }), false);
	eq("nor null", hasMetrics(null), false);
	eq("a metrics payload holds no workouts", parseHaePayload(metricsPayload).workouts.length, 0);
}

section("Parsing the real Health Metrics payload (7 days, Aug 11–17)");
const parsed = parseHaeMetricsPayload(metricsPayload);
{
	eq("vo2_max days (sparse — outdoor runs only)", parsed.days.vo2_max, 4);
	eq("resting_heart_rate days", parsed.days.resting_heart_rate, 7);
	eq("heart_rate_variability days", parsed.days.heart_rate_variability, 7);
	eq("sleep_analysis days (Aug 15 never recorded)", parsed.days.sleep_analysis, 6);
	eq("rows in total", parsed.entries.length, 24);
	eq("nothing unmodelled in this payload", parsed.unknown.length, 0);
	eq("nothing skipped", parsed.skipped.length, 0);

	const days = parsed.entries.filter((entry) => entry.kind === "sleep_analysis").map((entry) => entry.day);
	eq("sleep days are the wake days", days.join(","), "2026-08-11,2026-08-12,2026-08-13,2026-08-14,2026-08-16,2026-08-17");
	check("the missing night is simply absent", !days.includes("2026-08-15"));
}

section("Quantity metrics — stored as {qty}");
{
	const rhr = parsed.entries.filter((entry) => entry.kind === "resting_heart_rate");
	eq("value shape", Object.keys(rhr[0].value).join(","), "qty");
	eq("Aug 11 resting heart rate", (rhr[0].value as { qty: number }).qty, 61);
	eq("Aug 17 resting heart rate", (rhr.at(-1)!.value as { qty: number }).qty, 61);

	const hrv = parsed.entries.filter((entry) => entry.kind === "heart_rate_variability");
	close("Aug 11 HRV is rounded, not truncated", (hrv[0].value as { qty: number }).qty, 57.67, 0.001);

	const vo2 = parsed.entries.filter((entry) => entry.kind === "vo2_max");
	eq("VO₂max days", vo2.map((entry) => entry.day).join(","), "2026-08-11,2026-08-12,2026-08-15,2026-08-17");
	close("latest VO₂max", (vo2.at(-1)!.value as { qty: number }).qty, 42.98, 0.001);
}

section("Sleep — hours per stage, and when the night ran");
{
	const nights = parsed.entries.filter((entry) => entry.kind === "sleep_analysis");
	const latest = nights.at(-1)!.value as SleepValue;

	eq("value keys", Object.keys(latest).sort().join(","), "awake,core,deep,rem,sleepEnd,sleepStart,totalSleep");
	eq("inBed/asleep zeros are dropped", "inBed" in latest || "asleep" in latest, false);
	close("Aug 17 total sleep (hours)", latest.totalSleep, 8.16, 0.01);
	close("…of which REM", latest.rem, 2.05, 0.01);
	close("…core", latest.core, 5.24, 0.01);
	close("…deep", latest.deep, 0.87, 0.01);
	close("…awake", latest.awake, 0.13, 0.01);

	const stages = (latest.rem ?? 0) + (latest.core ?? 0) + (latest.deep ?? 0);
	close("stages add up to the total", stages, latest.totalSleep as number, 0.02);

	// The night began the evening before — a UTC instant alone would hide that.
	eq("sleep start keeps the local clock", latest.sleepStart, "2026-08-16T23:19:33-04:00");
	eq("sleep end too", latest.sleepEnd, "2026-08-17T07:37:04-04:00");
	const hours = (new Date(latest.sleepEnd as string).getTime() - new Date(latest.sleepStart as string).getTime()) / 3_600_000;
	close("start→end spans the night in bed", hours, 8.29, 0.02);
	eq("formatted for a person", formatHours(latest.totalSleep), "8h10");
}

section("Re-exports are idempotent, unknown metrics are kept");
{
	const again = parseHaeMetricsPayload(JSON.parse(readFileSync(METRICS, "utf8")));
	eq("parsing twice gives identical rows", JSON.stringify(again.entries), JSON.stringify(parsed.entries));

	// One (user, day, kind) can only hold one row, which is what makes the
	// database upsert a no-op on replay.
	const keys = new Set(parsed.entries.map((entry) => `${entry.day}|${entry.kind}`));
	eq("one row per day per kind", keys.size, parsed.entries.length);

	const duplicated = {
		data: {
			metrics: [
				{ name: "resting_heart_rate", units: "count/min", data: [
					{ date: "2026-08-17 00:00:00 -0400", qty: 61, source: "Apple Watch" },
					{ date: "2026-08-17 00:00:00 -0400", qty: 58, source: "Apple Watch" },
				] },
			],
		},
	};
	const collapsed = parseHaeMetricsPayload(duplicated);
	eq("a day sent twice collapses to one row", collapsed.entries.length, 1);
	eq("…and the later reading wins", (collapsed.entries[0].value as { qty: number }).qty, 58);

	const novel = {
		data: {
			metrics: [
				{ name: "respiratory_rate", units: "count/min", data: [{ date: "2026-08-17 00:00:00 -0400", qty: 14.2, source: "Watch" }] },
				{ name: "blood_pressure", units: "mmHg", data: [{ date: "2026-08-17 00:00:00 -0400", systolic: 118, diastolic: 74, source: "Cuff" }] },
			],
		},
	};
	const forward = parseHaeMetricsPayload(novel);
	eq("an unmodelled metric is still stored", forward.entries.length, 2);
	eq("…under its own name", forward.unknown.join(","), "blood_pressure,respiratory_rate");
	eq("…with its numbers", JSON.stringify(forward.entries.find((e) => e.kind === "blood_pressure")?.value), '{"systolic":118,"diastolic":74}');
	eq("…and a plain qty when it has one", JSON.stringify(forward.entries.find((e) => e.kind === "respiratory_rate")?.value), '{"qty":14.2}');

	const broken = {
		data: {
			metrics: [
				{ name: "resting_heart_rate", data: [{ date: "17/08/2026", qty: 61 }] },
				{ name: "vo2_max", data: [{ date: "2026-08-17 00:00:00 -0400" }] },
				{ data: [{ date: "2026-08-17 00:00:00 -0400", qty: 1 }] },
			],
		},
	};
	const rejected = parseHaeMetricsPayload(broken);
	eq("unreadable rows are dropped, not guessed", rejected.entries.length, 0);
	eq("…and counted by reason", rejected.skipped.length, 3);
}

section("The day-keyed read shape (src/lib/daily-metrics.ts)");
const view = toDailyMetricsView(parsed.entries.map((entry): DailyMetricRow => ({ day: entry.day, kind: entry.kind, value: entry.value })));
{
	eq("days covered", view.days.length, 7);
	eq("window start", view.from, "2026-08-11");
	eq("window end", view.to, "2026-08-17");
	check("days ascend", view.days.every((day, i, all) => i === 0 || day.day > all[i - 1].day));

	const aug15 = view.days.find((day) => day.day === "2026-08-15");
	eq("Aug 15 has a resting heart rate", aug15?.restingHrBpm, 66);
	eq("…and no sleep, because none was recorded", aug15?.sleep, null);

	eq("latest resting heart rate", view.latest.restingHrBpm?.value, 61);
	eq("…dated", view.latest.restingHrBpm?.day, "2026-08-17");
	close("latest HRV", view.latest.hrvMs?.value ?? null, 87.81, 0.01);
	eq("latest VO₂max carries its own (older) day", view.latest.vo2Max?.day, "2026-08-17");
	eq("latest night", view.latest.sleep?.day, "2026-08-17");

	close("7-day mean resting heart rate", view.averages.restingHrBpm, 67.57, 0.01);
	eq("…over 7 days", view.averages.restingHrDays, 7);
	eq("sleep averages only count the nights measured", view.averages.sleepNights, 6);
	close("mean sleep", view.averages.sleepHours, 7.46, 0.01);
	eq("units are stated, not assumed", view.units.hrvMs, "ms (SDNN)");

	const sparse = toDailyMetricsView([{ day: "2026-08-17", kind: "vo2_max", value: { qty: 43 } }]);
	eq("a single metric still maps", sparse.latest.vo2Max?.value, 43);
	eq("…without inventing the others", sparse.latest.hrvMs, null);
	eq("no rows at all is an empty view", toDailyMetricsView([]).days.length, 0);
	eq("…with no window", toDailyMetricsView([]).from, null);

	const unmodelled = toDailyMetricsView([{ day: "2026-08-17", kind: "respiratory_rate", value: { qty: 14.2 } }]);
	eq("an unmodelled kind lands in `other`", unmodelled.other[0]?.kind, "respiratory_rate");
	eq("…and not in a day", unmodelled.days.length, 0);
}

// ---------------------------------------------------------------------------
// Training signals, against the real streams
// ---------------------------------------------------------------------------

const workouts = parseHaePayload(workoutPayload);
const byId = new Map(workouts.workouts.map((workout) => [workout.externalId, workout]));
const long = byId.get("B69495E1-8768-49D3-9CBD-B32599863E13") as ParsedWorkout;
const tempo = byId.get("8F8D735F-6B42-4815-9057-1C3FA052762B") as ParsedWorkout;

section("Heart-rate recovery stats — Aug 15 and Aug 12 tails");
{
	const stats = hrRecoveryStats(long.streams.hr_recovery);
	eq("available", stats.available, true);
	eq("samples", stats.samples, 24);
	eq("peak at the finish", stats.peakBpm, 169);
	eq("window (s)", stats.windowS, 111);
	check("one-minute drop is a real number", stats.drop60 !== null, `${stats.drop60} bpm (${stats.peakBpm} → ${stats.bpmAt60})`);
	check("…and plausible", (stats.drop60 as number) > 0 && (stats.drop60 as number) < 80);
	eq("two minutes is null — the watch stopped first", stats.drop120, null);

	const tempoStats = hrRecoveryStats(tempo.streams.hr_recovery);
	check("Aug 12 one-minute drop", tempoStats.drop60 !== null, `${tempoStats.drop60} bpm (${tempoStats.peakBpm} → ${tempoStats.bpmAt60})`);
	check(
		"the harder day recovers less",
		(tempoStats.drop60 as number) !== (stats.drop60 as number),
		`Aug 12 ${tempoStats.drop60} vs Aug 15 ${stats.drop60}`,
	);

	eq("no samples is not an answer", hrRecoveryStats([]).available, false);
	eq("…and says so", hrRecoveryStats([]).reason, "no recovery samples");
	const shortTail = hrRecoveryStats([{ t: 0, bpm: 170 }, { t: 20, bpm: 160 }]);
	eq("a 20-second tail can't answer for a minute", shortTail.drop60, null);
	const clean = hrRecoveryStats([{ t: 0, bpm: 180 }, { t: 60, bpm: 150 }, { t: 120, bpm: 132 }]);
	eq("a full tail gives both drops (60s)", clean.drop60, 30);
	eq("…and 120s", clean.drop120, 48);
	eq("the mark is interpolated between samples", hrRecoveryStats([{ t: 0, bpm: 180 }, { t: 80, bpm: 140 }]).bpmAt60, 150);
}

section("Aerobic decoupling — the real Aug 15 long run");
{
	const drift = aerobicDecoupling({ splits: long.streams.splits }, long.streams.heart_rate);
	eq("available", drift.available, true);
	eq("computed from the derived splits", drift.source, "splits");
	console.log(
		`    Aug 15: first half ${drift.first?.paceSPerKm}s/km @ ${drift.first?.avgHr}bpm · ` +
			`second half ${drift.second?.paceSPerKm}s/km @ ${drift.second?.avgHr}bpm · ` +
			`drift ${drift.driftPct}% · pace CV ${drift.paceVariationPct}% · steady ${drift.steady}`,
	);
	check("drift is a real number", drift.driftPct !== null, `${drift.driftPct}%`);
	check("…and inside a believable range", Math.abs(drift.driftPct as number) < 30);
	check("both halves cover about half the run", Math.abs((drift.first?.distanceM ?? 0) - (drift.second?.distanceM ?? 0)) < 2000);
	check("both halves are timed equally", Math.abs((drift.first?.durationS ?? 0) - (drift.second?.durationS ?? 0)) <= 2);
	// The halves span the distance series; the heart-rate trace starts a moment
	// earlier and outlives the last split, so a few samples sit outside on purpose.
	const covered = (drift.first?.hrSamples ?? 0) + (drift.second?.hrSamples ?? 0);
	check("nearly every heart-rate sample lands in a half", covered / 1263 > 0.95, `${covered} of 1263`);
	eq("a 105-minute steady long run reads as steady", drift.steady, true);

	// The same run walked from GPS instead of the splits must agree.
	const fromRoute = aerobicDecoupling({ route: long.streams.route }, long.streams.heart_rate);
	eq("route is the fallback source", fromRoute.source, "route");
	close("…and lands on the same drift", fromRoute.driftPct, drift.driftPct as number, 1.5);

	const tempoDrift = aerobicDecoupling({ splits: tempo.streams.splits }, tempo.streams.heart_rate);
	console.log(
		`    Aug 12: drift ${tempoDrift.driftPct}% · pace CV ${tempoDrift.paceVariationPct}% · steady ${tempoDrift.steady}`,
	);
	check("the tempo run also computes", tempoDrift.available, `${tempoDrift.driftPct}%`);

	eq("no distance series, no answer", aerobicDecoupling({}, long.streams.heart_rate).available, false);
	eq("…with a reason", aerobicDecoupling({}, []).reason, "no distance series");
	eq("no heart rate, no answer", aerobicDecoupling({ splits: long.streams.splits }, []).available, false);
	eq(
		"a ten-minute run is too short to drift",
		aerobicDecoupling({ splits: long.streams.splits.slice(0, 2) }, long.streams.heart_rate).available,
		false,
	);

	// Steadiness comes off the kilometre paces, so an interval session fails it.
	const intervals = long.streams.splits.map((split, i) => ({ ...split, paceSPerKm: i % 2 === 0 ? 300 : 480 }));
	check("interval paces are not steady", (paceVariationPct(intervals) as number) > 12, `CV ${paceVariationPct(intervals)}%`);
	eq(
		"…so the drift comes back flagged",
		aerobicDecoupling({ splits: intervals }, long.streams.heart_rate).steady,
		false,
	);
	eq("under three kilometres there is no CV", paceVariationPct(long.streams.splits.slice(0, 2)), null);
}

section("Weekly load");
{
	const runs: TrainingRun[] = [
		{ id: "a", day: "2026-08-03", distanceM: 10_000, durationS: 3600, avgHr: 140, maxHr: 170 },
		{ id: "b", day: "2026-08-05", distanceM: 5000, durationS: 1800, avgHr: 160, maxHr: 175 },
		{ id: "c", day: "2026-08-12", distanceM: 6311, durationS: 2333, avgHr: 156, maxHr: 163 },
		{ id: "d", day: "2026-08-15", distanceM: 15_709, durationS: 6304, avgHr: 164, maxHr: 177 },
		{ id: "e", day: "2026-08-16", distanceM: 8000, durationS: 2700, avgHr: null },
	];

	// The newest run is Sunday Aug 16, so the window ends on the week of Aug 10.
	const report = weeklyLoad(runs, 4, { hrMax: 180 });
	eq("weeks returned", report.weeks.length, 4);
	eq("oldest first", report.weeks[0].weekStart, "2026-07-20");
	eq("newest last", report.weeks.at(-1)!.weekStart, "2026-08-10");
	eq("ISO week keys", report.weeks.map((week) => week.week).join(","), "2026-W30,2026-W31,2026-W32,2026-W33");
	eq("a week nobody ran is a zero, not a gap", report.weeks[0].runs, 0);
	eq("…with zero load", report.weeks[0].load, 0);

	const week32 = report.weeks[2];
	eq("Aug 3 week runs", week32.runs, 2);
	eq("…kilometres", week32.km, 15);
	// 60 min in zone 3 (140/180 = 78%) + 30 min in zone 4 (160/180 = 89%).
	eq("…Edwards load", week32.load, 60 * 3 + 30 * 4);
	eq("…all of it heart-rate backed", week32.loadCoverage, 1);

	const week33 = report.weeks[3];
	eq("Aug 10 week runs", week33.runs, 3);
	close("…kilometres", week33.km, 30.02, 0.01);
	check("…load is dominated by the long run", week33.load > 300, `${week33.load} weighted minutes`);
	check("…and the HR-less run is declared, not counted", week33.loadCoverage < 1, `coverage ${week33.loadCoverage}`);

	eq("zone 1 under 60%", hrZone(100, 180), 1);
	eq("zone 3 at 78%", hrZone(140, 180), 3);
	eq("zone 5 at 95%", hrZone(171, 180), 5);
	eq("HRmax can be observed from the runs", weeklyLoad(runs, 1).hrMaxSource, "observed");
	eq("…or assumed when nothing carries HR", weeklyLoad([{ day: "2026-08-15", distanceM: 5000, durationS: 1800, avgHr: null }], 1).hrMaxSource, "assumed");
	eq("no runs, no weeks", weeklyLoad([], 4).weeks.length, 0);
	eq("the window can be anchored to today", weeklyLoad(runs, 2, { endDay: "2026-08-24" }).weeks.at(-1)!.weekStart, "2026-08-24");

	eq("ISO week of a Monday", isoWeekKey("2026-08-10"), "2026-W33");
	eq("…and of the Sunday that ends it", isoWeekKey("2026-08-16"), "2026-W33");
	eq("a January date belongs to the week its Thursday does", isoWeekKey("2027-01-01"), "2026-W53");
}

section("Efficiency trend");
{
	// Six weeks of easy running at a steady heart rate, gradually faster.
	const easy: TrainingRun[] = [
		{ id: "1", day: "2026-07-06", distanceM: 10_000, durationS: 3900, avgHr: 150 },
		{ id: "2", day: "2026-07-13", distanceM: 10_000, durationS: 3860, avgHr: 152 },
		{ id: "3", day: "2026-07-20", distanceM: 10_000, durationS: 3820, avgHr: 149 },
		{ id: "4", day: "2026-07-27", distanceM: 10_000, durationS: 3780, avgHr: 151 },
		{ id: "5", day: "2026-08-03", distanceM: 10_000, durationS: 3740, avgHr: 150 },
	];
	const withOutliers: TrainingRun[] = [
		...easy,
		{ id: "race", day: "2026-08-09", distanceM: 10_000, durationS: 2700, avgHr: 178 },
		{ id: "shakeout", day: "2026-08-10", distanceM: 2000, durationS: 900, avgHr: 120 },
		{ id: "manual", day: "2026-08-11", distanceM: 9000, durationS: 3600, avgHr: null },
	];

	const trend = efficiencyTrend(withOutliers);
	eq("only comparable runs become points", trend.points.length, 5);
	eq("the race is outside the heart-rate band", trend.points.some((point) => point.runId === "race"), false);
	eq("the 2 km shakeout is too short to compare", trend.points.some((point) => point.runId === "shakeout"), false);
	eq("a run without heart rate can't be compared at all", trend.considered, 6);
	close("band centre", trend.band?.medianHr ?? null, 150.5, 0.6);
	close("metres per beat on the first run", trend.points[0].metresPerBeat, 10_000 / (150 * 65), 0.01);
	eq("improving", trend.direction, "improving");
	check("…by a stated amount", (trend.changePctPer30Days as number) > 0, `${trend.changePctPer30Days}% per 30 days`);
	eq("units are named", trend.unit, "metres per heartbeat");

	const flat = efficiencyTrend(easy.map((run) => ({ ...run, durationS: 3800 })));
	eq("no real change reads as flat", flat.direction, "flat");

	const declining = efficiencyTrend(easy.map((run, i) => ({ ...run, durationS: 3700 + i * 60 })));
	eq("a slowing runner at the same heart rate declines", declining.direction, "declining");

	const thin = efficiencyTrend(easy.slice(0, 2));
	eq("two points are not a trend", thin.direction, null);
	check("…and it says why", (thin.reason ?? "").includes("needed"), thin.reason);
	eq("no heart rate anywhere is not a trend", efficiencyTrend([{ day: "2026-08-01", distanceM: 10_000, durationS: 3600, avgHr: null }]).reason, "no runs with heart rate long enough to compare");

	// The two real synced runs: too few and too far apart in effort for a trend,
	// which is exactly what it should say rather than drawing a line through two dots.
	const real: TrainingRun[] = [
		{ id: "aug12", day: "2026-08-12", distanceM: tempo.distanceM, durationS: tempo.durationS, avgHr: tempo.avgHr },
		{ id: "aug15", day: "2026-08-15", distanceM: long.distanceM, durationS: long.durationS, avgHr: long.avgHr },
	];
	const realTrend = efficiencyTrend(real);
	console.log(
		`    real runs: ${realTrend.points.map((point) => `${point.day} ${point.metresPerBeat} m/beat @ ${point.avgHr}bpm`).join(" · ")}`,
	);
	eq("both real runs are comparable", realTrend.points.length, 2);
	eq("…but two is still not a trend", realTrend.direction, null);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
