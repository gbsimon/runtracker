/**
 * Unit checks for the run detail view's data assembly — the downsampling that
 * keeps a 6,315-point GPS trace out of the browser, the stream parsers, the
 * per-split enrichment and the weather-code map.
 *
 *   pnpm check:run-detail
 *
 * A synthetic run is generated here rather than read from the real capture, so
 * the checks run on any machine and never touch a real coordinate. The one
 * fixture-backed check (route point counts) is skipped when the gitignored
 * payload isn't present.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	buildCadenceSeries,
	buildElevationSeries,
	buildHeartRateSeries,
	buildRouteDisplay,
	type ChartPoint,
	douglasPeucker,
	elevationStats,
	enrichSplits,
	everyNth,
	haversineM,
	lttb,
	movingAverage,
	parseCadence,
	parseHeartRate,
	parseRoute,
	parseSplits,
	quantile,
	type RoutePoint,
	simplifyRoute,
	type Split,
	splitStats,
	stabilizeBands,
} from "../src/lib/run-detail.ts";
import { readWeather, weatherCodeLabel } from "../src/lib/weather.ts";

const ROUTE_BUDGET = 800;
const CHART_BUDGET = 300;

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
	check(label, actual !== null && Math.abs(actual - expected) <= tolerance, `got ${actual}, want ${expected} ±${tolerance}`);
}

function section(title: string): void {
	console.log(`\n${title}`);
}

/**
 * A 6,000-second run: a loop out and back with a hill in the middle, one HR
 * spike, and a deliberate GPS dropout. Shaped like the real thing so the checks
 * exercise the same code paths.
 */
const START_T = 1_786_817_960;
const RAW_ROUTE: RoutePoint[] = Array.from({ length: 6000 }, (_, i) => {
	const phase = (i / 6000) * Math.PI * 2;
	return {
		t: START_T + i,
		lat: 45.767 + Math.sin(phase) * 0.02 + Math.sin(i / 37) * 0.00004,
		lng: -73.8216 + Math.cos(phase) * 0.03 + Math.cos(i / 41) * 0.00004,
		alt: 60 + Math.sin(phase) * 25,
		// Five minutes with no usable speed — a tunnel, not a red light. A brief
		// stop would be smoothed away, and rightly: running slowly is still a pace.
		v: i > 2000 && i < 2300 ? null : 2.7 + Math.sin(i / 300) * 0.6,
	};
});

const RAW_HR = Array.from({ length: 1200 }, (_, i) => ({
	t: START_T + i * 5,
	// One sharp 190 bpm spike an LTTB reduction must keep.
	bpm: i === 700 ? 190 : 140 + Math.round(Math.sin(i / 90) * 18),
}));

const RAW_CADENCE = Array.from({ length: 100 }, (_, i) => ({ t: START_T + i * 60, spm: 160 + (i % 7) }));

const RAW_SPLITS: Split[] = Array.from({ length: 16 }, (_, i) => {
	const partial = i === 15;
	const splitS = partial ? 290 : 380 + (i % 5) * 12;
	const elapsedS = 390 * (i + 1);
	return {
		km: i + 1,
		t: START_T + elapsedS,
		elapsedS,
		splitS,
		distanceM: partial ? 719 : 1000,
		paceSPerKm: partial ? Math.round((splitS / 719) * 1000) : splitS,
		...(partial ? { partial: true as const } : {}),
	};
});

/** Distance from a point to a polyline segment — not to its nearest vertex: a
 * straight stretch keeps vertices hundreds of metres apart and still describes
 * the path exactly. */
function distanceToSegment(point: RoutePoint, from: RoutePoint, to: RoutePoint): number {
	const scale = Math.cos((from.lat * Math.PI) / 180);
	const dx = (to.lng - from.lng) * scale;
	const dy = to.lat - from.lat;
	if (dx === 0 && dy === 0) return haversineM(point, from);
	const px = (point.lng - from.lng) * scale;
	const py = point.lat - from.lat;
	const along = Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy)));
	return haversineM(point, { lat: from.lat + along * dy, lng: from.lng + (along * dx) / scale });
}

/** The furthest any original point sits from the line that replaced it. */
function worstDeviationM(original: RoutePoint[], simplified: RoutePoint[]): number {
	let worst = 0;
	let cursor = 0;
	for (const point of original) {
		while (cursor < simplified.length - 2 && simplified[cursor + 1].t < point.t) cursor += 1;
		worst = Math.max(worst, distanceToSegment(point, simplified[cursor], simplified[cursor + 1]));
	}
	return worst;
}

section("everyNth");
{
	const items = Array.from({ length: 1000 }, (_, i) => i);
	const reduced = everyNth(items, 250);
	eq("hits the budget exactly", reduced.length, 250);
	eq("keeps the first point", reduced[0], 0);
	eq("keeps the last point", reduced[reduced.length - 1], 999);
	check(
		"indices stay strictly increasing",
		reduced.every((value, i) => i === 0 || value > reduced[i - 1]),
	);
	eq("a series under budget is returned whole", everyNth(items, 5000).length, 1000);
	eq("a budget of one keeps the first point", everyNth(items, 1).length, 1);
	eq("an empty series stays empty", everyNth([], 10).length, 0);
}

section("LTTB");
{
	const points: ChartPoint[] = RAW_HR.map((sample, i) => ({ x: i, y: sample.bpm }));
	const reduced = lttb(points, CHART_BUDGET);
	eq("hits the budget exactly", reduced.length, CHART_BUDGET);
	eq("keeps the first sample", reduced[0].x, points[0].x);
	eq("keeps the last sample", reduced[reduced.length - 1].x, points[points.length - 1].x);
	check(
		"x stays monotone",
		reduced.every((point, i) => i === 0 || point.x > reduced[i - 1].x),
	);
	check(
		"the 190 bpm spike survives",
		reduced.some((point) => point.y === 190),
		`peak kept = ${Math.max(...reduced.map((point) => point.y))}`,
	);
	check(
		"a plain stride would have dropped it",
		!everyNth(points, CHART_BUDGET).some((point) => point.y === 190),
	);
	eq("a series under budget is returned whole", lttb(points.slice(0, 100), CHART_BUDGET).length, 100);
}

section("Route simplification");
{
	const simplified = simplifyRoute(RAW_ROUTE, ROUTE_BUDGET);
	check("respects the budget", simplified.length <= ROUTE_BUDGET, `${RAW_ROUTE.length} → ${simplified.length} points`);
	check("uses most of it", simplified.length > ROUTE_BUDGET * 0.5, `${simplified.length} of ${ROUTE_BUDGET}`);
	eq("keeps the start", simplified[0].t, RAW_ROUTE[0].t);
	eq("keeps the finish", simplified[simplified.length - 1].t, RAW_ROUTE[RAW_ROUTE.length - 1].t);
	check(
		"time stays monotone",
		simplified.every((point, i) => i === 0 || point.t > simplified[i - 1].t),
	);

	// Budget alone proves nothing: a line through 800 arbitrary points also fits.
	// The simplified path has to still describe the run.
	const worst = worstDeviationM(RAW_ROUTE, simplified);
	check("no point strays far from the drawn line", worst < 15, `worst deviation ${worst.toFixed(3)} m`);

	const tight = douglasPeucker(RAW_ROUTE, 0.0001);
	check("a near-zero tolerance keeps nearly everything", tight.length > RAW_ROUTE.length * 0.9, `${tight.length} points`);
	eq("a two-point path is left alone", douglasPeucker(RAW_ROUTE.slice(0, 2), 5).length, 2);
	eq("a route already under budget is untouched", simplifyRoute(RAW_ROUTE.slice(0, 300), ROUTE_BUDGET).length, 300);
}

section("Route display");
{
	const display = buildRouteDisplay(RAW_ROUTE, ROUTE_BUDGET);
	if (!display) {
		check("route display built", false);
	} else {
		eq("reports the raw point count", display.rawPointCount, RAW_ROUTE.length);
		check("ships far fewer points than it read", display.pointCount <= ROUTE_BUDGET, `${display.pointCount} points`);
		eq(
			"segments cover every drawn point",
			display.segments.reduce((sum, segment, i) => sum + segment.points.length - (i > 0 ? 1 : 0), 0),
			display.pointCount,
		);
		check(
			"consecutive segments share an edge",
			display.segments.every((segment, i) => {
				if (i === 0) return true;
				const previous = display.segments[i - 1].points;
				return segment.points[0][0] === previous[previous.length - 1][0];
			}),
		);
		check(
			"bands stay inside the ramp",
			display.segments.every((segment) => segment.band === null || (segment.band >= 0 && segment.band <= 4)),
		);
		eq("four boundaries split five bands", display.bandBounds.length, 4);
		check(
			"boundaries ascend",
			display.bandBounds.every((bound, i) => i === 0 || bound >= display.bandBounds[i - 1]),
			display.bandBounds.map((bound) => Math.round(bound)).join(" < "),
		);
		check(
			"a long GPS dropout is drawn as unknown pace",
			display.segments.some((segment) => segment.band === null),
		);
		check(
			"colour changes stay readable, not confetti",
			display.segments.length < 60,
			`${display.segments.length} segments over ${display.pointCount} points`,
		);
		const [[south, west], [north, east]] = display.bounds;
		check("bounds contain the start", display.start[0] >= south && display.start[0] <= north);
		check("bounds contain the finish", display.finish[1] >= west && display.finish[1] <= east);
		eq("route with one point has nothing to draw", buildRouteDisplay(RAW_ROUTE.slice(0, 1)), null);
	}
}

section("Band stabilising");
{
	const noisy = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
	eq("a lone crossing is absorbed", stabilizeBands(noisy, 4).filter((band) => band === 1).length, 0);

	const real = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
	eq("a sustained change survives", stabilizeBands(real, 4).filter((band) => band === 1).length, 11);
	eq("length is preserved", stabilizeBands(noisy, 4).length, noisy.length);
	eq("the opening stretch is never absorbed", stabilizeBands([2, 0, 0, 0, 0, 0], 4)[0], 2);
	eq("a null stretch can be absorbed too", stabilizeBands([0, 0, 0, 0, null, 0, 0, 0, 0], 4)[4], 0);
	eq("minRun of 1 changes nothing", stabilizeBands(noisy, 1).join(","), noisy.join(","));
}

section("Chart series");
{
	const hr = buildHeartRateSeries(RAW_HR, START_T, CHART_BUDGET);
	if (!hr) {
		check("heart-rate series built", false);
	} else {
		check("respects the budget", hr.points.length <= CHART_BUDGET, `${RAW_HR.length} → ${hr.points.length}`);
		eq("x is elapsed seconds from zero", hr.points[0].x, 0);
		eq("max comes from the full series", hr.max, 190);
		close("avg comes from the full series", hr.avg, RAW_HR.reduce((sum, s) => sum + s.bpm, 0) / RAW_HR.length, 0.001);
		check("xMax is the last sample", hr.xMax === RAW_HR[RAW_HR.length - 1].t - START_T, `${hr.xMax}s`);
	}

	const elevation = buildElevationSeries(RAW_ROUTE, CHART_BUDGET);
	if (!elevation) {
		check("elevation series built", false);
	} else {
		check("respects the budget", elevation.points.length <= CHART_BUDGET, `${elevation.points.length} points`);
		eq("starts at zero distance", elevation.points[0].x, 0);
		check(
			"distance climbs along the route",
			elevation.points.every((point, i) => i === 0 || point.x >= elevation.points[i - 1].x),
		);
		check("x is kilometres, not metres", elevation.xMax > 1 && elevation.xMax < 100, `${elevation.xMax.toFixed(2)} km`);
		close("smoothing keeps the hill's height", elevation.max - elevation.min, 50, 2);
	}

	const cadence = buildCadenceSeries(RAW_CADENCE, START_T, CHART_BUDGET);
	eq("a series under budget is left whole", cadence?.points.length, RAW_CADENCE.length);
	eq("a single sample is not a chart", buildHeartRateSeries(RAW_HR.slice(0, 1), START_T), null);
	eq("no samples is not a chart", buildCadenceSeries([], START_T), null);
}

section("Moving average and quantiles");
{
	const smoothed = movingAverage([1, 2, 3, 4, 5], 1);
	eq("length is preserved", smoothed.length, 5);
	eq("the first value averages the edge", smoothed[0], 1.5);
	eq("the middle averages both sides", smoothed[2], 3);
	eq("nulls are skipped, not counted", movingAverage([2, null, 4], 1)[1], 3);
	eq("an all-null window stays null", movingAverage([null, null], 1)[0], null);

	const sorted = [1, 2, 3, 4, 5];
	eq("the median is the middle", quantile(sorted, 0.5), 3);
	eq("q0 is the smallest", quantile(sorted, 0), 1);
	eq("q1 is the largest", quantile(sorted, 1), 5);
	eq("quantiles interpolate", quantile([0, 10], 0.25), 2.5);
	eq("an empty set has no quantile", quantile([], 0.5), 0);
}

section("Stream parsing (jsonb is untrusted)");
{
	eq("a non-array is no route", parseRoute({ lat: 1 }).length, 0);
	eq("a null stream is no route", parseRoute(null).length, 0);
	eq("points missing coordinates are dropped", parseRoute([{ t: 1, lat: 45 }, { t: 2, lat: 45, lng: -73 }]).length, 1);
	eq("impossible coordinates are dropped", parseRoute([{ t: 1, lat: 995, lng: -73 }]).length, 0);
	eq("a missing altitude survives as null", parseRoute([{ t: 1, lat: 45, lng: -73 }])[0].alt, null);
	eq("strings are not numbers", parseHeartRate([{ t: 1, bpm: "150" }]).length, 0);
	eq("a valid sample is kept", parseHeartRate([{ t: 1, bpm: 150 }])[0].bpm, 150);
	eq("cadence reads its own key", parseCadence([{ t: 1, spm: 168 }])[0].spm, 168);

	const splits = parseSplits([
		{ km: 2, t: 2, elapsedS: 800, splitS: 400, distanceM: 1000, paceSPerKm: 400 },
		{ km: 1, t: 1, elapsedS: 400, splitS: 400, distanceM: 1000, paceSPerKm: 400 },
		{ km: 3 },
	]);
	eq("incomplete splits are dropped", splits.length, 2);
	eq("splits come back in order", splits[0].km, 1);
	eq("partial is only set when it is true", splits[0].partial, undefined);
	eq("partial survives", parseSplits([{ km: 1, splitS: 1, distanceM: 1, paceSPerKm: 1, partial: true }])[0].partial, true);

	// `pausedS` arrived after the first runs were stored, so a row without it has
	// to come back exactly as it went in — and one with it has to keep it.
	const legacy = { km: 1, t: 500, elapsedS: 500, splitS: 500, distanceM: 1000, paceSPerKm: 500 };
	eq("a row written before pausedS round-trips byte-identical", JSON.stringify(parseSplits([legacy])[0]), JSON.stringify(legacy));
	const paused = { ...legacy, splitS: 471, paceSPerKm: 471, pausedS: 29 };
	eq("pausedS survives the reader", parseSplits([paused])[0].pausedS, 29);
	eq("a zero is dropped rather than stored", "pausedS" in parseSplits([{ ...paused, pausedS: 0 }])[0], false);
	eq("so is a non-number", "pausedS" in parseSplits([{ ...paused, pausedS: "lots" }])[0], false);
	eq("…and the split still parses without it", parseSplits([{ ...paused, pausedS: "lots" }])[0].splitS, 471);
}

section("Split stats and enrichment");
{
	const stats = splitStats(RAW_SPLITS);
	eq("the partial split is not the fastest", stats.fastest?.partial, undefined);
	eq("fastest is the lowest full pace", stats.fastest?.paceSPerKm, Math.min(...RAW_SPLITS.slice(0, 15).map((s) => s.paceSPerKm)));
	eq("slowest is the highest full pace", stats.slowest?.paceSPerKm, Math.max(...RAW_SPLITS.slice(0, 15).map((s) => s.paceSPerKm)));
	eq("spread is their difference", stats.spreadS, (stats.slowest?.paceSPerKm ?? 0) - (stats.fastest?.paceSPerKm ?? 0));
	check("a negative-split verdict is reached", stats.negativeSplit !== null);
	eq("no splits means no stats", splitStats([]).fastest, null);
	eq("a lone partial split yields nothing", splitStats([RAW_SPLITS[15]]).fastest, null);

	const enriched = enrichSplits(RAW_SPLITS, RAW_ROUTE, RAW_HR);
	eq("every split is returned", enriched.length, RAW_SPLITS.length);
	check(
		"each split gets a heart rate",
		enriched.every((split) => split.avgHr !== null && split.avgHr > 100 && split.avgHr < 200),
	);
	check(
		"each split gets a net climb",
		enriched.every((split) => split.elevationDeltaM !== null),
	);
	check(
		"the climb reverses on the way back",
		enriched.some((split) => (split.elevationDeltaM ?? 0) > 1) && enriched.some((split) => (split.elevationDeltaM ?? 0) < -1),
	);
	eq("no streams means no enrichment", enrichSplits(RAW_SPLITS, [], [])[0].avgHr, null);

	const elevation = elevationStats({ elevationGainM: 66.7 }, RAW_ROUTE);
	eq("gain comes from the run row", elevation.gainM, 66.7);
	close("the altitude range is the route's", (elevation.maxM ?? 0) - (elevation.minM ?? 0), 50, 0.5);
	eq("a route-less run has no range", elevationStats({ elevationGainM: null }, []).maxM, null);
}

section("Weather, read back for display");
{
	eq("code 0 is clear", weatherCodeLabel(0)?.label, "Clear");
	eq("code 3 is overcast", weatherCodeLabel(3)?.label, "Overcast");
	eq("code 63 is rain", weatherCodeLabel(63)?.label, "Rain");
	eq("code 95 is a thunderstorm", weatherCodeLabel(95)?.label, "Thunderstorm");
	eq("an unknown code has no label", weatherCodeLabel(4242), null);
	eq("a null code has no label", weatherCodeLabel(null), null);
	check(
		"every code carries an emoji",
		[0, 1, 2, 3, 45, 48, 51, 61, 65, 71, 80, 95, 99].every((code) => (weatherCodeLabel(code)?.emoji.length ?? 0) > 0),
	);

	const full = readWeather({ tempC: 22.78, humidityPct: 50, windKmh: 7.6, precipMm: 0, weatherCode: 0, source: "apple+open-meteo" });
	eq("temperature is read", full?.tempC, 22.78);
	eq("the code becomes a condition", full?.condition?.label, "Clear");
	eq("the source rides along", full?.source, "apple+open-meteo");
	eq("null weather is null", readWeather(null), null);
	eq("a JSON string is not weather", readWeather("sunny"), null);
	eq("an all-null row is not worth a line", readWeather({ tempC: null, humidityPct: null, source: "open-meteo" }), null);
	eq("a temperature alone is worth a line", readWeather({ tempC: 12 })?.tempC, 12);
	eq("NaN is not a temperature", readWeather({ tempC: "12" }), null);
}

section("Against the real capture");
{
	const FIXTURE = "fixtures/hae/real-payload-2026-08-17.json";
	if (!existsSync(FIXTURE)) {
		console.log(`  · skipped — ${FIXTURE} is gitignored and not present`);
	} else {
		const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const workouts = payload?.data?.workouts ?? [];
		const longest = workouts.reduce(
			(best: Record<string, unknown> | null, workout: Record<string, unknown>) =>
				(Array.isArray(workout.route) ? workout.route.length : 0) >
				(best && Array.isArray(best.route) ? best.route.length : 0)
					? workout
					: best,
			null,
		);
		const raw = (longest?.route ?? []) as Record<string, unknown>[];
		const route: RoutePoint[] = raw.map((point, i) => ({
			t: START_T + i,
			lat: Number(point.latitude),
			lng: Number(point.longitude),
			alt: Number(point.altitude),
			v: Number(point.speed),
		}));
		check("the real trace is the big one", route.length > 6000, `${route.length} points`);
		const display = buildRouteDisplay(route, ROUTE_BUDGET);
		check(
			"it ships under the budget",
			(display?.pointCount ?? Infinity) <= ROUTE_BUDGET,
			`${route.length} → ${display?.pointCount} points (${(((display?.pointCount ?? 0) / route.length) * 100).toFixed(1)}%)`,
		);
		const worstReal = worstDeviationM(route, simplifyRoute(route, ROUTE_BUDGET));
		check("and still traces the real path", worstReal < 15, `worst deviation ${worstReal.toFixed(2)} m`);
		const elevation = buildElevationSeries(route, CHART_BUDGET);
		check("its elevation profile fits too", (elevation?.points.length ?? Infinity) <= CHART_BUDGET);
	}
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
