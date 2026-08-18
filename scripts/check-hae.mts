/**
 * Unit checks for the Health Auto Export parser, the reconciliation rules and
 * the weather merge, run against the real captured payload.
 *
 *   pnpm check:hae
 *
 * The fixture is gitignored (real GPS on a public repo), so this prints
 * aggregates and never a coordinate.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	type ParsedWorkout,
	parseHaePayload,
	parseHaeTimestamp,
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

if (!existsSync(FIXTURE)) {
	console.error(`Missing ${FIXTURE} — the real capture is gitignored; copy it in before running these checks.`);
	process.exit(1);
}

const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));

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

section("Parsing the real 2-workout payload");
const parsed = parseHaePayload(payload);
eq("workouts accepted", parsed.workouts.length, 2);
eq("workouts skipped", parsed.skipped.length, 0);

const byId = new Map(parsed.workouts.map((workout) => [workout.externalId, workout]));
const long = byId.get("B69495E1-8768-49D3-9CBD-B32599863E13") as ParsedWorkout;
const tempo = byId.get("8F8D735F-6B42-4815-9057-1C3FA052762B") as ParsedWorkout;

section("Aug 15 long run — scalars from tasks/hae-schema.md");
{
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
}

section("Aug 12 tempo run — the workout with no native weather");
{
	eq("started_at", tempo.startedAt.toISOString(), "2026-08-12T13:13:50.000Z");
	eq("local date", tempo.localDate, "2026-08-12");
	close("distance_m", tempo.distanceM, 6311.44, 0.01);
	close("duration_s (raw)", tempo.durationS, 2332.95, 0.01);
	eq("duration_s (row)", workoutRunFields(tempo).durationS, 2333);
	close("elevation_gain_m", tempo.elevationGainM, 26.07, 0.01);
	eq("weather absent", tempo.weather, null);
	eq("max_hr", tempo.maxHr, 163);
}

section("Streams — thinned shapes and counts");
{
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
}

section("Heart-rate recovery — the tail after the run stops (item 21c)");
{
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
}

section("Energy and top speed → runs.metrics (item 21c)");
{
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

	// Reading back what the jsonb column holds.
	eq("an empty object is not data", readRunMetrics({}), null);
	eq("garbage is not data", readRunMetrics("nope"), null);
	eq("a partial value survives", readRunMetrics({ energyKj: 12 })?.maxSpeedMs, null);

	// The enrichment pass only ever fills gaps.
	const filled = mergeRunMetrics(null, long.metrics);
	eq("enrichment adds both fields to a bare run", filled.added.join(","), "energyKj,maxSpeedMs");
	const kept = mergeRunMetrics({ energyKj: 1, maxSpeedMs: 2 }, long.metrics);
	eq("stored values are never overwritten", kept.added.length, 0);
	eq("…and keep their value", kept.metrics?.energyKj, 1);
	const gap = mergeRunMetrics({ energyKj: 1 }, long.metrics);
	eq("only the missing field is written", gap.added.join(","), "maxSpeedMs");
	eq("nothing to add is a no-op", mergeRunMetrics({ energyKj: 1 }, null).added.length, 0);
}

section("Splits — derived per kilometre");
{
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
	check(
		"split seconds add up to elapsed",
		Math.abs(splits.reduce((sum, split) => sum + split.splitS, 0) - elapsed) <= 2,
	);
	check(
		"paces are plausible for a 6:41/km average",
		splits.every((split) => split.paceSPerKm > 200 && split.paceSPerKm < 900),
	);

	const tempoTotal = tempo.streams.splits.reduce((sum, split) => sum + split.distanceM, 0);
	close("Aug 12 splits sum ≈ its distance", tempoTotal, tempo.distanceM, tempo.distanceM * 0.01);
}

section("Localized units and names can't change the result");
{
	// A French device sends `"pas"` for steps and mislabels km/h as `"km"`.
	// Rewriting every units string and every name to nonsense must be a no-op.
	const scrambled = JSON.parse(
		JSON.stringify(payload, (key, value) => {
			if (key === "units") return "≪unité inconnue≫";
			if (key === "name" || key === "location" || key === "source") return "≪localisé≫";
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
	eq("localized name carried through, not matched on", rerun.workouts[0].name, "≪localisé≫");
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

section("Reconciliation against Simon's real manual rows");
{
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
}

section("Weather");
{
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

	const offline = await fetchRunWeather(long.startedAt, 45.5, -73.6, {
		fetchImpl: () => Promise.reject(new Error("network down")),
	});
	eq("a failed fetch resolves to null instead of throwing", offline, null);

	const wrongShape = await fetchRunWeather(long.startedAt, 45.5, -73.6, {
		fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
	});
	eq("an unusable response resolves to null", wrongShape, null);

	const notFound = await fetchRunWeather(long.startedAt, 45.5, -73.6, {
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

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
