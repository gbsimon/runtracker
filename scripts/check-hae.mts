/**
 * Unit checks for the Health Auto Export parser, the reconciliation rules and
 * the weather merge.
 *
 *   pnpm check:hae
 *
 * Two kinds of section live here. Most build their payload inline and run
 * anywhere. The rest are backed by the real captured payload, which is
 * gitignored (real GPS on a public repo) and therefore absent on a fresh
 * clone — those go through `withFixture`, which skips them with a note rather
 * than taking the whole script down. Either way this prints aggregates and
 * never a coordinate.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	foldRunName,
	isRunName,
	MAX_EXTRA_RUN_FRAGMENTS,
	normalizeRunFragments,
	type ParsedPayload,
	type ParsedWorkout,
	parseHaePayload,
	parseHaeTimestamp,
	RUN_NAME_FRAGMENTS,
	type Split,
	workoutRunFields,
	workoutStreamRows,
} from "../src/lib/ingest/hae.ts";
import { findReconcileCandidate, type ReconcileCandidate } from "../src/lib/ingest/reconcile.ts";
import { generateIngestToken, hashIngestToken } from "../src/lib/ingest/tokens.ts";
import { energyKcal, maxSpeedPaceSPerKm, mergeRunMetrics, readRunMetrics } from "../src/lib/run-metrics.ts";
import { fetchRunWeather, mergeWeather, needsRemoteWeather, type RunWeather } from "../src/lib/weather.ts";

const FIXTURE = "fixtures/hae/real-payload-2026-08-17.json";

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

/** The real capture and what the parser makes of it — the two runs it holds. */
type Fixture = {
	/** The raw JSON, typed only as far as the checks below actually read it. */
	payload: { data: { workouts: { name: string }[] } };
	parsed: ParsedPayload;
	/** Aug 15, 15.7 km. */
	long: ParsedWorkout;
	/** Aug 12, 6.3 km, no native weather. */
	tempo: ParsedWorkout;
};

const fixture: Fixture | null = (() => {
	if (!existsSync(FIXTURE)) return null;
	const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));
	const parsed = parseHaePayload(payload);
	const byId = new Map(parsed.workouts.map((workout) => [workout.externalId, workout]));
	return {
		payload,
		parsed,
		long: byId.get("B69495E1-8768-49D3-9CBD-B32599863E13") as ParsedWorkout,
		tempo: byId.get("8F8D735F-6B42-4815-9057-1C3FA052762B") as ParsedWorkout,
	};
})();

let skippedSections = 0;

/**
 * A section that can only run against the real capture. Absent, it is announced
 * as skipped and the run carries on — a fresh clone still gets every synthetic
 * check, and only a genuine failure sets the exit code.
 */
function withFixture(title: string, body: (fixture: Fixture) => void): void {
	section(title);
	if (!fixture) {
		skippedSections += 1;
		console.log(`  · skipped — ${FIXTURE} is gitignored and not present`);
		return;
	}
	body(fixture);
}

section("Timestamp parsing (HAE's non-ISO format)");
{
	const start = parseHaeTimestamp("2026-08-15 14:19:19 -0400");
	eq("start instant", start?.at.toISOString(), "2026-08-15T18:19:19.000Z");
	eq("offset string", start?.offset, "-04:00");
	eq("offset minutes", start?.offsetMinutes, -240);

	eq("positive offset", parseHaeTimestamp("2026-01-02 03:04:05 +0530")?.offset, "+05:30");
	eq("colon offset accepted", parseHaeTimestamp("2026-01-02 03:04:05 +05:30")?.at.toISOString(), "2026-01-01T21:34:05.000Z");
	eq("Z accepted", parseHaeTimestamp("2026-01-02T03:04:05Z")?.at.toISOString(), "2026-01-02T03:04:05.000Z");
	eq("no offset is UTC", parseHaeTimestamp("2026-01-02 03:04:05")?.offsetMinutes, 0);
	eq("garbage rejected", parseHaeTimestamp("15/08/2026 2:19 PM"), null);
	eq("non-string rejected", parseHaeTimestamp(1_755_282_000), null);
}

withFixture("Parsing the real 2-workout payload", ({ parsed }) => {
	eq("workouts accepted", parsed.workouts.length, 2);
	eq("workouts skipped", parsed.skipped.length, 0);
});

withFixture("Aug 15 long run — scalars from tasks/hae-schema.md", ({ long }) => {
	eq("started_at", long.startedAt.toISOString(), "2026-08-15T18:19:19.000Z");
	eq("timezone (offset stands in for the IANA zone)", long.timezone, "-04:00");
	eq("local date", long.localDate, "2026-08-15");
	eq("local time", long.localTime, "14:19");
	close("distance_m", long.distanceM, 15_709.37, 0.01);
	close("duration_s (raw)", long.durationS, 6304.06, 0.01);
	eq("duration_s (row)", workoutRunFields(long).durationS, 6304);
	close("avg_hr", long.avgHr, 164.4798, 0.001);
	eq("avg_hr (row, integer column)", workoutRunFields(long).avgHr, 164);
	eq("max_hr", long.maxHr, 177);
	close("avg_cadence", long.avgCadence, 161.92, 0.01);
	close("elevation_gain_m", long.elevationGainM, 66.67, 0.01);
	close("apple temperature", long.weather?.tempC ?? null, 22.78, 0.01);
	close("apple humidity", long.weather?.humidityPct ?? null, 50, 0.01);
	eq("weather source", long.weather?.source, "apple");
	eq("indoor flag", long.isIndoor, false);
	check("first GPS point captured", long.firstPoint !== null, long.firstPoint ? "redacted" : "missing");
});

withFixture("Aug 12 tempo run — the workout with no native weather", ({ tempo }) => {
	eq("started_at", tempo.startedAt.toISOString(), "2026-08-12T13:13:50.000Z");
	eq("local date", tempo.localDate, "2026-08-12");
	close("distance_m", tempo.distanceM, 6311.44, 0.01);
	close("duration_s (raw)", tempo.durationS, 2332.95, 0.01);
	eq("duration_s (row)", workoutRunFields(tempo).durationS, 2333);
	close("elevation_gain_m", tempo.elevationGainM, 26.07, 0.01);
	eq("weather absent", tempo.weather, null);
	eq("max_hr", tempo.maxHr, 163);
});

withFixture("Streams — thinned shapes and counts", ({ long }) => {
	eq("route points", long.streams.route.length, 6315);
	eq("heart-rate samples", long.streams.heart_rate.length, 1263);
	eq("route sample keys", Object.keys(long.streams.route[0]).sort().join(","), "alt,lat,lng,t,v");
	eq("accuracy fields dropped", "horizontalAccuracy" in long.streams.route[0], false);
	eq("heart-rate sample keys", Object.keys(long.streams.heart_rate[0]).sort().join(","), "bpm,t");
	eq("cadence sample keys", Object.keys(long.streams.cadence[0]).sort().join(","), "spm,t");

	const start = Math.round(long.startedAt.getTime() / 1000);
	eq("stream times are epoch seconds", long.streams.route[0].t, start + 1);
	check(
		"streams are sorted",
		long.streams.route.every((point, i, all) => i === 0 || point.t >= all[i - 1].t),
	);

	const minutes = Math.round(long.durationS / 60);
	check(
		"one cadence sample per minute",
		Math.abs(long.streams.cadence.length - minutes) <= 1,
		`${long.streams.cadence.length} samples vs ${minutes} minutes`,
	);
	const meanCadence = long.streams.cadence.reduce((total, s) => total + s.spm, 0) / long.streams.cadence.length;
	close("mean per-minute cadence ≈ reported avg", meanCadence, long.avgCadence as number, 3);

	const kinds = workoutStreamRows(long)
		.map((row) => row.kind)
		.sort()
		.join(",");
	eq("stored stream kinds", kinds, "cadence,heart_rate,hr_recovery,route,splits");
});

withFixture("Heart-rate recovery — the tail after the run stops (item 21c)", ({ long, tempo }) => {
	const recovery = long.streams.hr_recovery;
	eq("Aug 15 recovery samples", recovery.length, 24);
	eq("Aug 12 recovery samples", tempo.streams.hr_recovery.length, 24);
	eq("recovery sample keys", Object.keys(recovery[0]).sort().join(","), "bpm,t");
	check(
		"recovery samples are sorted",
		recovery.every((sample, i, all) => i === 0 || sample.t >= all[i - 1].t),
	);

	const runEnd = Math.round(long.startedAt.getTime() / 1000) + long.durationS;
	check("the tail starts after the run ends", recovery[0].t >= runEnd - 5, `${recovery[0].t - runEnd}s after the finish`);
	check(
		"the tail is about two minutes",
		recovery.at(-1)!.t - recovery[0].t > 90,
		`${recovery.at(-1)!.t - recovery[0].t}s`,
	);
	check(
		"heart rate falls across it",
		recovery.at(-1)!.bpm < recovery[0].bpm,
		`${recovery[0].bpm} → ${recovery.at(-1)!.bpm} bpm`,
	);
	check(
		"every reading is a plausible heart rate",
		recovery.every((sample) => sample.bpm > 40 && sample.bpm < 220),
	);

	// The recovery series is a separate kind, not appended to the workout's own.
	eq("workout heart rate is untouched", long.streams.heart_rate.length, 1263);
	check(
		"the two series don't overlap",
		long.streams.heart_rate.at(-1)!.t <= recovery[0].t,
	);
});

withFixture("Energy and top speed → runs.metrics (item 21c)", ({ long, tempo }) => {
	// `activeEnergyBurned` is kJ; `maxSpeed` is km/h behind a units string
	// reading "km", so the route's own m/s speeds are what pin the unit down.
	close("Aug 15 energy (kJ)", long.metrics?.energyKj ?? null, 5808.82, 0.01);
	close("Aug 12 energy (kJ)", tempo.metrics?.energyKj ?? null, 2116.51, 0.01);
	eq("energy in kcal, for a human", energyKcal(long.metrics), 1388);

	const routePeakMs = Math.max(...long.streams.route.map((point) => point.v ?? 0));
	close("Aug 15 max speed (m/s)", long.metrics?.maxSpeedMs ?? null, 3.27, 0.01);
	close("…agrees with the fastest route sample", long.metrics?.maxSpeedMs ?? null, routePeakMs, 0.01);
	eq("max speed as a pace", maxSpeedPaceSPerKm(long.metrics), 306);
	close("Aug 12 max speed (m/s)", tempo.metrics?.maxSpeedMs ?? null, 3.54, 0.01);

	eq("metrics ride on the run row", JSON.stringify(workoutRunFields(long).metrics), JSON.stringify(long.metrics));
});

section("runs.metrics, read back and merged");
{
	// The same pair of numbers the Aug 15 run carries, stated here so the merge
	// rules are checked on any machine rather than only where the capture is.
	const measured = { energyKj: 5808.82, maxSpeedMs: 3.27 };

	// Reading back what the jsonb column holds.
	eq("an empty object is not data", readRunMetrics({}), null);
	eq("garbage is not data", readRunMetrics("nope"), null);
	eq("a partial value survives", readRunMetrics({ energyKj: 12 })?.maxSpeedMs, null);

	// The enrichment pass only ever fills gaps.
	const filled = mergeRunMetrics(null, measured);
	eq("enrichment adds both fields to a bare run", filled.added.join(","), "energyKj,maxSpeedMs");
	const kept = mergeRunMetrics({ energyKj: 1, maxSpeedMs: 2 }, measured);
	eq("stored values are never overwritten", kept.added.length, 0);
	eq("…and keep their value", kept.metrics?.energyKj, 1);
	const gap = mergeRunMetrics({ energyKj: 1 }, measured);
	eq("only the missing field is written", gap.added.join(","), "maxSpeedMs");
	eq("nothing to add is a no-op", mergeRunMetrics({ energyKj: 1 }, null).added.length, 0);
}

withFixture("Splits — derived per kilometre", ({ long, tempo }) => {
	const splits = long.streams.splits;
	eq("kilometres covered", splits.length, 16);
	eq("last split is the partial one", splits.at(-1)?.partial, true);
	check(
		"kilometre numbers run 1..n",
		splits.every((split, i) => split.km === i + 1),
	);

	const total = splits.reduce((sum, split) => sum + split.distanceM, 0);
	close("splits sum ≈ workout distance", total, long.distanceM, long.distanceM * 0.01);

	const elapsed = splits.at(-1)?.elapsedS ?? 0;
	check("last split lands inside the run", elapsed <= long.durationS + 60, `${elapsed}s of ${Math.round(long.durationS)}s`);
	// `splitS` is moving time, so it is moving *plus paused* that has to close on
	// the wall clock. With no auto-pause in the capture the two are the same sum.
	const moving = splits.reduce((sum, split) => sum + split.splitS, 0);
	const paused = splits.reduce((sum, split) => sum + (split.pausedS ?? 0), 0);
	check("split seconds add up to elapsed", Math.abs(moving + paused - elapsed) <= 2, `${moving} + ${paused} vs ${elapsed}`);
	check("moving time never exceeds the wall clock", moving <= elapsed + 2, `${moving} of ${elapsed}`);
	check(
		"paces are plausible for a 6:41/km average",
		splits.every((split) => split.paceSPerKm > 200 && split.paceSPerKm < 900),
	);

	const tempoTotal = tempo.streams.splits.reduce((sum, split) => sum + split.distanceM, 0);
	close("Aug 12 splits sum ≈ its distance", tempoTotal, tempo.distanceM, tempo.distanceM * 0.01);
});

section("Splits — pause-aware");
{
	/** A fixed morning start; every sample below is stated as seconds into it. */
	const START = "2026-08-20 06:00:00 -0400";
	const START_SEC = Math.round((parseHaeTimestamp(START) as { at: Date }).at.getTime() / 1000);

	/** Back to HAE's own stamp: a wall clock in the phone's offset, not ISO. */
	function stamp(offsetS: number): string {
		const shifted = new Date((START_SEC + offsetS - 4 * 3600) * 1000).toISOString();
		return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} -0400`;
	}

	/**
	 * One synthetic run through the whole parser, `t` handed back as seconds in.
	 * `officialKm` is what the workout *declares* it covered, which is what caps
	 * the splits: left out it agrees with the samples, `null` omits the field
	 * altogether so nothing caps at all.
	 */
	function splitsFor(samples: { at: number; km: number }[], officialKm?: number | null): Split[] {
		const declared = officialKm === undefined ? samples.reduce((sum, sample) => sum + sample.km, 0) : officialKm;
		const parsed = parseHaePayload({
			data: {
				workouts: [
					{
						id: "pause-1",
						name: "Outdoor Run",
						start: START,
						end: stamp(samples.at(-1)?.at ?? 0),
						duration: samples.at(-1)?.at ?? 0,
						...(declared === null ? {} : { distance: { qty: declared, units: "km" } }),
						walkingAndRunningDistance: samples.map((sample) => ({ date: stamp(sample.at), qty: sample.km, units: "km" })),
					},
				],
			},
		});
		return (parsed.workouts[0]?.streams.splits ?? []).map((split) => ({ ...split, t: split.t - START_SEC }));
	}

	/** `qty` for a metre count, and a run of one-second samples at a fixed pace. */
	const M = (metres: number) => metres / 1000;
	const steady = (fromS: number, toS: number, offsetS = 0, metres = 3) =>
		Array.from({ length: toS - fromS + 1 }, (_, i) => ({ at: fromS + i + offsetS, km: M(metres) }));

	const total = (splits: Split[], pick: (split: Split) => number) => splits.reduce((sum, split) => sum + pick(split), 0);
	const moving = (splits: Split[]) => total(splits, (split) => split.splitS);
	const stopped = (splits: Split[]) => total(splits, (split) => split.pausedS ?? 0);

	/**
	 * The whole contract in one line: every split's moving time plus what it gave
	 * back to pauses is the wall clock from the previous boundary to this one,
	 * boundaries never go backwards, and no split runs negative.
	 */
	function invariants(label: string, splits: Split[]): void {
		let previous = 0;
		let ok = splits.length > 0;
		for (const split of splits) {
			const wall = split.t - previous;
			if (wall < 0 || split.splitS < 0 || split.splitS + (split.pausedS ?? 0) !== wall) ok = false;
			previous = split.t;
		}
		check(label, ok, splits.map((s) => `${s.km}:${s.t}=${s.splitS}+${s.pausedS ?? 0}`).join(" "));
	}

	// 1. No gaps at all — the algorithm as it has always behaved, stated exactly.
	//    700 s at a flat 3 m/s is 2.1 km: two full splits and a 100 m leftover.
	{
		const splits = splitsFor(steady(1, 700));
		eq("continuous run: three splits", splits.length, 3);
		eq(
			"…km 1 verbatim",
			JSON.stringify(splits[0]),
			'{"km":1,"t":333,"elapsedS":333,"splitS":333,"distanceM":1000,"paceSPerKm":333}',
		);
		eq(
			"…km 2 verbatim",
			JSON.stringify(splits[1]),
			'{"km":2,"t":667,"elapsedS":667,"splitS":334,"distanceM":1000,"paceSPerKm":334}',
		);
		eq(
			"…the partial verbatim",
			JSON.stringify(splits[2]),
			'{"km":3,"t":700,"elapsedS":700,"splitS":33,"distanceM":100,"paceSPerKm":330,"partial":true}',
		);
		check("no pausedS key anywhere", splits.every((split) => !("pausedS" in split)));
		eq("moving time is the whole wall clock", splits.reduce((sum, split) => sum + split.splitS, 0), 700);
		invariants("invariants hold", splits);
	}

	// The same 30 s standstill told two ways: the samples stop dead (a hole in the
	// timestamps), or they keep arriving at 1/s carrying nothing. HAE's series are
	// health-store-scoped, so the second is what a real stoplight usually looks
	// like — and both have to read identically. Cases 2 and 6.
	const gapPause = [...steady(1, 200), { at: 230, km: 0 }, ...steady(1, 500, 230)];
	const samplePause = [...steady(1, 200), ...steady(1, 30, 200, 0), ...steady(1, 500, 230)];

	// 2. A 30 s standstill mid-kilometre: the samples stop, the clock doesn't.
	//    Only the excess over one sample step is paused — the gap still stands
	//    for one step of (zero-distance) moving time.
	{
		const splits = splitsFor(gapPause);
		eq("paused run: three splits", splits.length, 3);
		eq("km 1 ends at the same wall clock as always", splits[0].t, 363);
		eq("…elapsed stays wall-clock", splits[0].elapsedS, 363);
		eq("…the standstill is taken out of the split", splits[0].splitS, 334);
		eq("…and recorded", splits[0].pausedS, 29);
		eq("…so pace is the moving pace", splits[0].paceSPerKm, 334);
		eq("km 1 spans boundary to boundary", splits[0].splitS + (splits[0].pausedS ?? 0), splits[0].t);
		eq("km 2 saw no pause, so carries no field", "pausedS" in splits[1], false);
		eq("…and times exactly as the unpaused run did", splits[1].splitS, 334);
		eq("the partial is untouched too", splits[2].splitS, 33);
		eq("total moving time is the clock less the pause", splits.reduce((sum, split) => sum + split.splitS, 0), 730 - 29);
		invariants("invariants hold", splits);
	}

	// 3. The same 30 s gap, but the next sample carries 90 m — HAE dropped
	//    samples while the runner kept going at 3 m/s, which is not a pause.
	{
		const splits = splitsFor([...steady(1, 200), { at: 230, km: M(90) }, ...steady(1, 500, 230)]);
		check("a moving dropout is never paused", splits.every((split) => !("pausedS" in split)));
		eq("km 1 times as if the samples had arrived", splits[0].splitS, 333);
		eq("km 2 likewise", splits[1].splitS, 334);
		eq("moving time is the whole wall clock", splits.reduce((sum, split) => sum + split.splitS, 0), 730);
		invariants("invariants hold", splits);
	}

	// 4. A pause straddling the kilometre mark: 999 m in, then 30 s during which
	//    3 m go by, which crosses 1 km inside the gap.
	{
		const splits = splitsFor([...steady(1, 333), { at: 363, km: M(3) }, ...steady(1, 367, 363)]);
		eq("straddling pause: three splits", splits.length, 3);
		check("boundaries stay in order", splits.every((split, i) => i === 0 || split.t > splits[i - 1].t), splits.map((s) => s.t).join(","));
		check("no split runs negative", splits.every((split) => split.splitS >= 0));
		eq("the boundary lands in the gap's moving tail", splits[0].t, 362);
		eq("…the pause is charged to the split it fell in", splits[0].pausedS, 29);
		eq("…leaving the moving time the run deserved", splits[0].splitS, 333);
		eq("the next split starts clean", "pausedS" in splits[1], false);
		invariants("invariants hold", splits);
	}

	// 5. Two pauses over one run: the sums close on the wall clock exactly.
	{
		const splits = splitsFor([
			...steady(1, 150),
			{ at: 180, km: 0 },
			...steady(1, 220, 180),
			{ at: 460, km: 0 },
			...steady(1, 340, 460),
		]);
		eq("both pauses are found", stopped(splits), 29 + 59);
		eq("moving time is the clock less both", moving(splits), 800 - stopped(splits));
		eq("…and the two add back up to it", moving(splits) + stopped(splits), splits.at(-1)?.t);
		invariants("invariants hold", splits);
	}

	// 6. The same standstill with the samples still arriving — thirty one-second
	//    rows carrying no distance, no hole in the timestamps at all. This is the
	//    shape a real stoplight takes, and it has to read as the gap did.
	{
		const splits = splitsFor(samplePause);
		eq("a standstill with no gap is still a standstill", splits[0].pausedS, 29);
		eq("…the split shrinks by it", splits[0].splitS, 334);
		eq("…and the wall clock is untouched", splits[0].t, 363);
		eq(
			"stopped samples and stopped clock give the very same splits",
			JSON.stringify(splits),
			JSON.stringify(splitsFor(gapPause)),
		);
		eq("one allowance for the whole stretch, not one per sample", moving(splits), 730 - 29);
		invariants("invariants hold", splits);
	}

	// 7. A standstill stretch straddling the kilometre mark: 999 m in, then thirty
	//    seconds shuffling at 0.3 m/s, which drifts over 1 km partway through.
	//    The stretch is split between the two kilometres strictly by time.
	{
		const splits = splitsFor([...steady(1, 333), ...steady(1, 30, 333, 0.3), ...steady(1, 367, 363)]);
		eq("straddling standstill: three splits", splits.length, 3);
		check("boundaries stay in order", splits.every((split, i) => i === 0 || split.t > splits[i - 1].t), splits.map((s) => s.t).join(","));
		check("no split runs negative", splits.every((split) => split.splitS >= 0));
		eq("km 1 is charged only the seconds before the mark", splits[0].pausedS, 3);
		eq("…and keeps the running it actually did", splits[0].splitS, 333);
		eq("km 2 is charged the rest", splits[1].pausedS, 26);
		eq("…and is not billed twice for it", splits[1].splitS, 332);
		eq("the stretch is neither lost nor doubled", stopped(splits), 29);
		eq("moving time is the clock less the standstill", moving(splits), 730 - 29);
		invariants("invariants hold", splits);
	}

	// 8. Pressed pause and jogged home: the series keeps accruing past the
	//    distance the workout claims. Everything after the workout's own distance
	//    is health-store noise and must not reach a split — on the real 17.01 km
	//    capture this surplus invented an eighteenth kilometre.
	const jogHome = [...steady(1, 700), ...steady(1, 500, 700, 2.2)];
	{
		const plain = splitsFor(steady(1, 700));
		const capped = splitsFor(jogHome, 2.1);
		eq("the surplus buys no extra split", capped.length, 3);
		eq("…and no time after the cap", capped.at(-1)?.t, 700);
		eq("…the leftover is the declared distance's, not the samples'", capped.at(-1)?.distanceM, 100);
		eq("…so the splits sum to what the workout says", total(capped, (split) => split.distanceM), 2100);
		eq("1100 m of jogging home changes nothing at all", JSON.stringify(capped), JSON.stringify(plain));

		// The cap only ever trims: a workout that never reaches its own distance,
		// or declares one far beyond the samples, is left exactly as it was.
		eq("a distance the run never reaches caps nothing", JSON.stringify(splitsFor(steady(1, 700), 5)), JSON.stringify(plain));
	}

	// 9. No declared distance, no cap — the old behaviour, phantom kilometre and
	//    all. That is the right answer here: with nothing to measure against, the
	//    samples are all the parser has.
	{
		const uncapped = splitsFor(jogHome, null);
		eq("without a distance the surplus stands", uncapped.length, 4);
		eq("…as a phantom third kilometre", uncapped[2].km, 3);
		eq("…running to the last sample", uncapped.at(-1)?.t, 1200);
		eq("…covering every sampled metre", total(uncapped, (split) => split.distanceM), 3200);
		eq("a declared distance that agrees with the samples caps nothing either", JSON.stringify(splitsFor(jogHome)), JSON.stringify(uncapped));
		invariants("invariants hold", uncapped);
	}
}

withFixture("Localized units can't change the result", ({ payload, parsed }) => {
	// A French device sends `"pas"` for steps and mislabels km/h as `"km"`.
	// Rewriting every units string, location and source to nonsense must be a
	// no-op. `name` is deliberately left alone — it is the one localized string
	// the parser reads, and only to decide the workout's type.
	const scrambled = JSON.parse(
		JSON.stringify(payload, (key, value) => {
			if (key === "units") return "≪unité inconnue≫";
			if (key === "location" || key === "source") return "≪localisé≫";
			return value;
		}),
	);

	const rerun = parseHaePayload(scrambled);
	const sameScalars =
		JSON.stringify(rerun.workouts.map(workoutRunFields)) === JSON.stringify(parsed.workouts.map(workoutRunFields));
	check("run columns identical", sameScalars);
	eq(
		"streams identical",
		JSON.stringify(rerun.workouts.map((w) => w.streams)) === JSON.stringify(parsed.workouts.map((w) => w.streams)),
		true,
	);
	eq("localized name carried through verbatim", rerun.workouts[0].name, "Extérieur Course");
});

section("Run-type filter — the localized name is the only thing that states the type");
{
	/** One workout with a route and a distance series: everything but the type says "run". */
	const typed = (name: unknown) => ({
		data: {
			workouts: [
				{
					...(name === undefined ? {} : { name }),
					id: "typed-1",
					start: "2026-08-14 07:00:00 -0400",
					end: "2026-08-14 07:45:00 -0400",
					duration: 2700,
					distance: { qty: 5, units: "km" },
					route: [{ latitude: 45.5, longitude: -73.6, altitude: 30, speed: 2.5, timestamp: "2026-08-14 07:00:01 -0400" }],
					walkingAndRunningDistance: [{ qty: 5, date: "2026-08-14 07:44:00 -0400", units: "km" }],
				},
			],
		},
	});
	const verdict = (name: unknown) => {
		const result = parseHaePayload(typed(name));
		return { accepted: result.workouts.length === 1, reason: result.skipped[0]?.reason ?? "" };
	};

	// Accepted — English and French, indoor and out, accented and not.
	for (const name of [
		"Extérieur Course", // what Simon's own watch actually sends
		"Course en extérieur",
		"Course à pied",
		"Course de trail",
		"Outdoor Run",
		"Indoor Run",
		"Trail Running",
		"Jogging",
		"COURSE À PIED", // shouting is still running
		"course a pied", // …and so is an unaccented keyboard
	]) {
		eq(`accepted: ${name}`, verdict(name).accepted, true);
	}

	// Rejected — every one of these is a workout type the automation forwards.
	for (const name of [
		"Marche",
		"Outdoor Walk",
		"Vélo",
		"Cycling",
		"Randonnée",
		"Randonnee", // the same hike with the accent stripped, still not a run
		"Hiking",
		"Yoga",
		"Natation",
		"Swimming",
		"Exercice de respiration",
	]) {
		const { accepted, reason } = verdict(name);
		eq(`rejected: ${name}`, accepted, false);
		eq(`…and the reason names it`, reason, `workout type "${name}" is not a run`);
	}

	// A walk carries a route and a distance series exactly like a run does — this
	// is the case the old route-or-distance gate could never catch.
	const walk = verdict("Marche");
	eq("a walk with a full GPS track is still skipped", walk.accepted, false);

	// No name, no verdict: skipped rather than guessed at. The raw payload is
	// stored, so a name we can't read is recoverable by reprocessing.
	for (const [label, name] of [
		["missing", undefined],
		["empty", ""],
		["whitespace", "   "],
		["non-string", 42],
	] as const) {
		const { accepted, reason } = verdict(name);
		eq(`skipped when the name is ${label}`, accepted, false);
		eq(`…with the unnamed reason`, reason, "unnamed workout — cannot verify it is a run");
	}

	// The type gate runs first, so a walk is reported as a walk rather than as
	// missing data — but a genuine run with nothing recorded still hits the
	// second gate, unchanged.
	eq("the type gate reports the type, not the missing data", parseHaePayload({
		data: { workouts: [{ id: "w1", name: "Marche", start: "2026-08-14 07:00:00 -0400", duration: 2700 }] },
	}).skipped[0]?.reason, 'workout type "Marche" is not a run');
	eq("a run with no route or distance keeps the old reason", parseHaePayload({
		data: { workouts: [{ id: "r1", name: "Outdoor Run", start: "2026-08-14 07:00:00 -0400", duration: 2700 }] },
	}).skipped[0]?.reason, "no route or running distance — not a run");

	// The allowlist itself, exported so adding a locale is one edit.
	eq("run fragments are lowercase and accent-free", RUN_NAME_FRAGMENTS.every((f) => f === f.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()), true);
	eq("isRunName folds accents", isRunName("Extérieur Course") && isRunName("Exterieur Course"), true);
	eq("isRunName rejects a hike either way", isRunName("Randonnée") || isRunName("Randonnee"), false);
}

withFixture("…and the same filter over the real capture", ({ payload, parsed }) => {
	// The real capture, end to end: French names, two workouts, nothing skipped.
	const fixtureNames: string[] = payload.data.workouts.map((workout: { name: string }) => workout.name);
	eq("the real payload's names are the French ones", [...new Set(fixtureNames)].join(","), "Extérieur Course");
	eq("…all clear the type filter", fixtureNames.every((name) => isRunName(name)), true);
	eq("…and none of the two is skipped", parsed.skipped.length, 0);
});

section("Per-user run-name allowlist (the Sync tab's 'allow this type')");
{
	// The merge itself: the built-in fragments, plus this user's own.
	eq("a walk is not a run by default", isRunName("Marche"), false);
	eq("…and is once its owner allows it", isRunName("Marche", ["marche"]), true);
	eq("…without letting the next activity through", isRunName("Vélo", ["marche"]), false);
	eq("an extra matches as a fragment too", isRunName("Marche rapide", ["marche"]), true);
	eq("an extra is folded before it is matched", isRunName("Randonnée", ["Randonnée"]), true);
	eq("…so accents fall on either side", isRunName("Randonnee", ["Randonnée"]) && isRunName("Randonnée", ["randonnee"]), true);
	eq("the built-ins still stand on their own", isRunName("Outdoor Run", []), true);
	eq("an empty fragment can't match everything", isRunName("Marche", [""]), false);
	eq("a blank fragment can't either", isRunName("Marche", ["   "]), false);

	// What actually gets stored on the user's row.
	eq("names are folded, trimmed and lowercased", normalizeRunFragments(["  Marche  ", "RANDONNÉE"]).join(","), "marche,randonnee");
	eq("inner whitespace is regularized", normalizeRunFragments(["Outdoor   Walk"])[0], "outdoor walk");
	eq("the same name three ways collapses to one", normalizeRunFragments(["Marche", "marche", "MARCHÉ"]).length, 1);
	eq("a one-character fragment is dropped", normalizeRunFragments(["a", "ab"]).join(","), "ab");
	eq("an absurdly long one is dropped", normalizeRunFragments(["x".repeat(41)]).length, 0);
	eq("…and the boundary itself is kept", normalizeRunFragments(["x".repeat(40)]).length, 1);
	eq("non-strings are dropped", normalizeRunFragments([1, null, {}, "Marche"]).join(","), "marche");
	eq("a non-array reads as empty", normalizeRunFragments("marche").length, 0);
	eq("undefined reads as empty", normalizeRunFragments(undefined).length, 0);
	eq(
		"the list is capped",
		normalizeRunFragments(Array.from({ length: 60 }, (_, index) => `type-${index}`)).length,
		MAX_EXTRA_RUN_FRAGMENTS,
	);
	eq("folding is idempotent", foldRunName(foldRunName("Extérieur  Course")), foldRunName("Extérieur  Course"));

	// End to end through the parser: one payload, two users.
	const walk = {
		data: {
			workouts: [
				{
					id: "walk-1",
					name: "Marche",
					start: "2026-08-16 07:00:00 -0400",
					end: "2026-08-16 07:30:00 -0400",
					duration: 1800,
					distance: { qty: 3.2, units: "km" },
					walkingAndRunningDistance: [
						{ date: "2026-08-16 07:00:01 -0400", qty: 1.6 },
						{ date: "2026-08-16 07:15:00 -0400", qty: 1.6 },
					],
				},
			],
		},
	};

	eq("the walk is skipped for a user with no extras", parseHaePayload(walk).skipped.length, 1);
	const allowed = parseHaePayload(walk, { extraRunFragments: ["marche"] });
	eq("…and imported for the one who allowed it", allowed.workouts.length, 1);
	eq("…as an ordinary workout", allowed.workouts[0]?.distanceM, 3200);
	eq("…keeping its own name", allowed.workouts[0]?.name, "Marche");

	// What the Sync tab lists a skip by: its name and the day it happened.
	const skipped = parseHaePayload(walk).skipped[0];
	eq("a skip records the workout's name", skipped?.name, "Marche");
	eq("…and its local date", skipped?.localDate, "2026-08-16");

	const unnamed = parseHaePayload({ data: { workouts: [{ id: "u1", start: "2026-08-16 07:00:00 -0400" }] } }).skipped[0];
	eq("an unnamed workout records a null name", unnamed?.name, null);
	eq("…but still records the date it happened", unnamed?.localDate, "2026-08-16");

	const undated = parseHaePayload({ data: { workouts: [{ id: "u2", name: "Yoga" }] } }).skipped[0];
	eq("an unreadable start records a null date", undated?.localDate, null);
	eq("…and keeps the name that was skipped", undated?.name, "Yoga");

	const anonymous = parseHaePayload({ data: { workouts: [{ name: "Marche" }] } }).skipped[0];
	eq("a workout with no id is skipped as before", anonymous?.reason, "missing workout id");
	eq("…and still carries its name", anonymous?.name, "Marche");
}

section("Workout filtering");
{
	const nonRun = {
		data: {
			workouts: [
				{ id: "yoga-1", name: "Yoga", start: "2026-08-14 07:00:00 -0400", end: "2026-08-14 07:45:00 -0400", duration: 2700 },
			],
		},
	};
	const result = parseHaePayload(nonRun);
	eq("workout without route or distance is skipped", result.workouts.length, 0);
	check("skip carries a reason", (result.skipped[0]?.reason ?? "").includes("not a run"), result.skipped[0]?.reason);

	eq("payload without an envelope yields nothing", parseHaePayload({ nope: true }).workouts.length, 0);
	eq("null payload yields nothing", parseHaePayload(null).workouts.length, 0);
}

withFixture("Reconciliation against Simon's real manual rows", ({ long, tempo }) => {
	const manual = (id: string, startedAt: string, distanceM: number): ReconcileCandidate => ({
		id,
		source: "manual",
		startedAt: new Date(startedAt),
		timezone: "America/Toronto",
		distanceM,
		durationS: 0,
	});

	// The two rows that came out of the v1 import, at the local-noon convention.
	const aug16Noon = manual("aug16", "2026-08-16T16:00:00.000Z", 15_700);
	const aug12Noon = manual("aug12", "2026-08-12T16:00:00.000Z", 6310);

	const longMatch = findReconcileCandidate(long, [aug16Noon, aug12Noon]);
	eq("Aug 15 workout matches the Aug 16 manual row", longMatch?.run.id, "aug16");
	eq("…by the noon-import rule", longMatch?.rule, "noon-import");

	const tempoMatch = findReconcileCandidate(tempo, [aug16Noon, aug12Noon]);
	eq("Aug 12 workout matches the Aug 12 manual row", tempoMatch?.run.id, "aug12");
	eq("…by the same-day rule (09:13 vs noon is inside ±3h)", tempoMatch?.rule, "same-day");

	eq(
		"a claimed run is not upgraded twice",
		findReconcileCandidate(long, [aug16Noon], { exclude: new Set(["aug16"]) }),
		null,
	);
	eq(
		"an already-synced row is never a candidate",
		findReconcileCandidate(long, [{ ...aug16Noon, source: "apple_health" }]),
		null,
	);

	// Noon-import needs the distances to agree: 12 km logged is not this 15.7 km run.
	eq(
		"noon-import rejected when distance is >10% out",
		findReconcileCandidate(long, [{ ...aug16Noon, distanceM: 12_000 }]),
		null,
	);
	eq(
		"noon-import rejected two days out",
		findReconcileCandidate(long, [{ ...aug16Noon, startedAt: new Date("2026-08-17T16:00:00.000Z") }]),
		null,
	);

	// Same-day with a real time of day: the normal case once runs are logged live.
	const sameDay = manual("live", "2026-08-15T17:30:00.000Z", 9000);
	eq("same-day match ignores distance", findReconcileCandidate(long, [sameDay])?.rule, "same-day");
	eq(
		"same-day rejected beyond ±3h",
		findReconcileCandidate(long, [{ ...sameDay, startedAt: new Date("2026-08-15T04:00:00.000Z") }]),
		null,
	);

	const both = findReconcileCandidate(long, [aug16Noon, sameDay]);
	eq("a same-day candidate wins over a noon-import one", both?.run.id, "live");
});

section("Weather");
{
	/** The Aug 15 start — only ever handed to a stubbed fetch, never a real one. */
	const runStart = new Date("2026-08-15T18:19:19.000Z");
	const apple: RunWeather = { tempC: 22.78, humidityPct: 50, source: "apple" };
	const remote: RunWeather = { tempC: 24.1, humidityPct: 61, windKmh: 12.3, precipMm: 0, weatherCode: 3, source: "open-meteo" };

	const merged = mergeWeather(apple, remote);
	eq("apple temperature wins", merged?.tempC, 22.78);
	eq("apple humidity wins", merged?.humidityPct, 50);
	eq("open-meteo fills the wind", merged?.windKmh, 12.3);
	eq("merged source is recorded", merged?.source, "apple+open-meteo");
	eq("apple-only weather still wants a lookup", needsRemoteWeather(apple), true);
	eq("merged weather does not", needsRemoteWeather(merged), false);
	eq("no weather at all wants a lookup", needsRemoteWeather(null), true);
	eq("apple alone survives a failed lookup", mergeWeather(apple, null)?.source, "apple");

	const offline = await fetchRunWeather(runStart, 45.5, -73.6, {
		fetchImpl: () => Promise.reject(new Error("network down")),
	});
	eq("a failed fetch resolves to null instead of throwing", offline, null);

	const wrongShape = await fetchRunWeather(runStart, 45.5, -73.6, {
		fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
	});
	eq("an unusable response resolves to null", wrongShape, null);

	const notFound = await fetchRunWeather(runStart, 45.5, -73.6, {
		fetchImpl: () => Promise.resolve(new Response("nope", { status: 500 })),
	});
	eq("a 500 resolves to null", notFound, null);
}

section("Ingest tokens");
{
	const token = generateIngestToken();
	check("token is prefixed", token.startsWith("rt_"), token.slice(0, 3) + "…");
	check("token has 256 bits of entropy", token.length >= 40, `${token.length} chars`);
	eq("hashing is deterministic", hashIngestToken(token), hashIngestToken(token));
	eq("hash is sha-256 hex", /^[0-9a-f]{64}$/.test(hashIngestToken(token)), true);
	check("two tokens differ", generateIngestToken() !== generateIngestToken());
	check("the hash is not the token", !hashIngestToken(token).includes(token.slice(3)));
}

const skipNote = skippedSections > 0 ? `, ${skippedSections} sections skipped (no ${FIXTURE})` : "";
console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed${skipNote}`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
