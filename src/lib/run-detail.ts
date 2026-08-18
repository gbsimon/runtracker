/**
 * Everything the run detail view draws, assembled on the server.
 *
 * A synced run stores ~6,300 route points and ~1,300 heart-rate samples. Those
 * stay in the database: a map is roughly 900 pixels wide, so shipping the raw
 * trace to the browser would be a megabyte of JSON per run and would hand the
 * client a metre-by-metre record of where the runner lives for no visible gain.
 * This module hands the page a display-sized copy instead — the route thinned
 * with Douglas–Peucker, every chart series thinned with LTTB, which keeps the
 * peaks that a plain stride would step straight over.
 *
 * The maths is exported point by point and pure, both because
 * `pnpm check:run-detail` asserts on it and because the coach context (item 21)
 * needs the same summaries without the rendering.
 */

import { eq } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/db";
import { runStreams } from "@/db/schema";
import type { CadenceSample, HeartRateSample, RoutePoint, Split } from "./ingest/hae";
import { energyKcal, readRunMetrics } from "./run-metrics";
import { getRun, type RunRecord, runDistanceKm } from "./runs";
import { paceSeconds } from "./running";
import { type HrRecoveryStats, hrRecoveryStats } from "./training-metrics";
import { readWeather, type WeatherDisplay } from "./weather";

export type { CadenceSample, HeartRateSample, HrRecoveryStats, RoutePoint, Split };
/** Re-exported so the detail page can type its weather line from one import. */
export type { WeatherDisplay };

/** Points on the drawn polyline. Douglas–Peucker holds the shape well below this. */
const ROUTE_BUDGET = 800;
/** Samples per chart line — about one per two pixels at full desktop width. */
const CHART_BUDGET = 300;
/**
 * Half-width, in samples (≈ seconds), of the moving average that steadies GPS
 * speed and altitude. Speed is smoothed over about a minute and a half —
 * roughly the window a runner means by "my pace along here"; anything shorter
 * and the map's colour bands flicker with GPS noise instead of describing the
 * run.
 */
const SPEED_SMOOTHING = 45;
const ALTITUDE_SMOOTHING = 15;
/** Pace colours on the map. The run is split at these quantiles of its own pace. */
const PACE_QUANTILES = [0.2, 0.4, 0.6, 0.8];
/** Drawn stretches shorter than this are folded into their neighbour. */
const MIN_BAND_RUN = 6;
/** A GPS speed below this is a pause or a lost fix, not a pace worth colouring. */
const MIN_SPEED_MS = 0.5;

const EARTH_RADIUS_M = 6_371_008.8;
const M_PER_DEGREE_LAT = 111_320;

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

/**
 * Exactly `budget` items, evenly spaced, first and last always among them.
 * The fallback whenever a shape-aware reduction can't apply.
 */
export function everyNth<T>(items: T[], budget: number): T[] {
	if (items.length <= budget) return items.slice();
	if (budget <= 0) return [];
	if (budget === 1) return [items[0]];

	const stride = (items.length - 1) / (budget - 1);
	const out: T[] = [];
	for (let i = 0; i < budget; i++) out.push(items[Math.round(i * stride)]);
	return out;
}

export type ChartPoint = { x: number; y: number };

/**
 * Largest-Triangle-Three-Buckets: keeps the sample from each bucket that forms
 * the largest triangle with its neighbours, which is the one that carries the
 * shape. A heart-rate spike survives it; a plain stride would drop it whenever
 * it fell between two strides.
 */
export function lttb<T extends ChartPoint>(points: T[], budget: number): T[] {
	if (points.length <= budget) return points.slice();
	if (budget < 3) return everyNth(points, budget);

	const out: T[] = [points[0]];
	const bucketSize = (points.length - 2) / (budget - 2);
	let anchor = 0;

	for (let bucket = 0; bucket < budget - 2; bucket++) {
		// Mean of the *next* bucket is the triangle's third corner.
		const nextStart = Math.floor((bucket + 1) * bucketSize) + 1;
		const nextEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, points.length);
		let sumX = 0;
		let sumY = 0;
		for (let i = nextStart; i < nextEnd; i++) {
			sumX += points[i].x;
			sumY += points[i].y;
		}
		const count = Math.max(1, nextEnd - nextStart);
		const avgX = nextEnd > nextStart ? sumX / count : points[points.length - 1].x;
		const avgY = nextEnd > nextStart ? sumY / count : points[points.length - 1].y;

		const start = Math.floor(bucket * bucketSize) + 1;
		const end = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, points.length - 1);
		const { x: ax, y: ay } = points[anchor];

		let best = start;
		let bestArea = -1;
		for (let i = start; i < end; i++) {
			const area = Math.abs((ax - avgX) * (points[i].y - ay) - (ax - points[i].x) * (avgY - ay));
			if (area > bestArea) {
				bestArea = area;
				best = i;
			}
		}
		out.push(points[best]);
		anchor = best;
	}

	out.push(points[points.length - 1]);
	return out;
}

/** Metres per degree of longitude at this latitude — the local flat-earth scale. */
function metresPerDegreeLng(latDeg: number): number {
	return M_PER_DEGREE_LAT * Math.cos((latDeg * Math.PI) / 180);
}

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const toRad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * toRad;
	const dLng = (b.lng - a.lng) * toRad;
	const s =
		Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Douglas–Peucker over a lat/lng path, `epsilonM` being how far the line may
 * stray from a dropped point. Iterative: a 6,000-point trace can otherwise
 * recurse deep enough to matter.
 */
export function douglasPeucker<T extends { lat: number; lng: number }>(points: T[], epsilonM: number): T[] {
	if (points.length <= 2) return points.slice();

	const scaleLng = metresPerDegreeLng(points[Math.floor(points.length / 2)].lat);
	const px = (p: T) => p.lng * scaleLng;
	const py = (p: T) => p.lat * M_PER_DEGREE_LAT;

	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;

	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length > 0) {
		const [first, last] = stack.pop() as [number, number];
		if (last - first < 2) continue;

		const x1 = px(points[first]);
		const y1 = py(points[first]);
		const dx = px(points[last]) - x1;
		const dy = py(points[last]) - y1;
		const span = Math.hypot(dx, dy);

		let farthest = -1;
		let maxDistance = 0;
		for (let i = first + 1; i < last; i++) {
			const x = px(points[i]) - x1;
			const y = py(points[i]) - y1;
			// A closed loop collapses the chord; fall back to radial distance.
			const distance = span === 0 ? Math.hypot(x, y) : Math.abs(dx * y - dy * x) / span;
			if (distance > maxDistance) {
				maxDistance = distance;
				farthest = i;
			}
		}

		if (farthest > 0 && maxDistance > epsilonM) {
			keep[farthest] = 1;
			stack.push([first, farthest], [farthest, last]);
		}
	}

	return points.filter((_, i) => keep[i] === 1);
}

/**
 * The tightest Douglas–Peucker that fits the budget, found by bisecting the
 * tolerance: a fixed epsilon would either waste the budget on a city block or
 * blow through it on a trail run.
 */
export function simplifyRoute<T extends { lat: number; lng: number }>(points: T[], budget = ROUTE_BUDGET): T[] {
	if (points.length <= budget) return points.slice();

	let tooSmall = 0;
	let large = 1;
	// Widen until some tolerance actually fits, so bisection has a bracket.
	for (let i = 0; i < 12 && douglasPeucker(points, large).length > budget; i++) large *= 4;

	let best = douglasPeucker(points, large);
	if (best.length > budget) return everyNth(points, budget);

	for (let i = 0; i < 16; i++) {
		const mid = (tooSmall + large) / 2;
		const kept = douglasPeucker(points, mid);
		if (kept.length > budget) {
			tooSmall = mid;
		} else {
			large = mid;
			best = kept;
		}
	}
	return best;
}

/** Centred moving average, `half` samples either side. Length is preserved. */
export function movingAverage(values: (number | null)[], half: number): (number | null)[] {
	return values.map((_, i) => {
		let sum = 0;
		let count = 0;
		for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
			const value = values[j];
			if (value !== null && Number.isFinite(value)) {
				sum += value;
				count += 1;
			}
		}
		return count > 0 ? sum / count : null;
	});
}

/** Linear-interpolated quantile of an already-sorted ascending array. */
export function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// ---------------------------------------------------------------------------
// Stream parsing
// ---------------------------------------------------------------------------

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRow(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Streams are jsonb written by the ingest parser, but a run detail page must
 * not blow up on a row an older parser wrote, so each sample is validated and
 * anything malformed is dropped rather than rendered as `NaN`.
 */
export function parseRoute(raw: unknown): RoutePoint[] {
	if (!Array.isArray(raw)) return [];
	const points: RoutePoint[] = [];
	for (const entry of raw) {
		if (!isRow(entry)) continue;
		const t = finiteOrNull(entry.t);
		const lat = finiteOrNull(entry.lat);
		const lng = finiteOrNull(entry.lng);
		if (t === null || lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
		points.push({ t, lat, lng, alt: finiteOrNull(entry.alt), v: finiteOrNull(entry.v) });
	}
	return points;
}

function parseSamples<K extends string>(raw: unknown, key: K): ({ t: number } & Record<K, number>)[] {
	if (!Array.isArray(raw)) return [];
	const samples: ({ t: number } & Record<K, number>)[] = [];
	for (const entry of raw) {
		if (!isRow(entry)) continue;
		const t = finiteOrNull(entry.t);
		const value = finiteOrNull(entry[key]);
		if (t === null || value === null) continue;
		samples.push({ t, [key]: value } as { t: number } & Record<K, number>);
	}
	return samples;
}

export function parseHeartRate(raw: unknown): HeartRateSample[] {
	return parseSamples(raw, "bpm");
}

export function parseCadence(raw: unknown): CadenceSample[] {
	return parseSamples(raw, "spm");
}

export function parseSplits(raw: unknown): Split[] {
	if (!Array.isArray(raw)) return [];
	const splits: Split[] = [];
	for (const entry of raw) {
		if (!isRow(entry)) continue;
		const km = finiteOrNull(entry.km);
		const splitS = finiteOrNull(entry.splitS);
		const distanceM = finiteOrNull(entry.distanceM);
		const paceSPerKm = finiteOrNull(entry.paceSPerKm);
		if (km === null || splitS === null || distanceM === null || paceSPerKm === null) continue;
		splits.push({
			km,
			t: finiteOrNull(entry.t) ?? 0,
			elapsedS: finiteOrNull(entry.elapsedS) ?? 0,
			splitS,
			distanceM,
			paceSPerKm,
			...(entry.partial === true ? { partial: true as const } : {}),
		});
	}
	return splits.sort((a, b) => a.km - b.km);
}

// ---------------------------------------------------------------------------
// Display series
// ---------------------------------------------------------------------------

export type ChartSeries = {
	points: ChartPoint[];
	/** Extremes of the **full** series, so an annotation can't sit off the line it describes. */
	min: number;
	max: number;
	avg: number;
	xMin: number;
	xMax: number;
};

function toSeries(points: ChartPoint[], budget = CHART_BUDGET): ChartSeries | null {
	if (points.length < 2) return null;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let sum = 0;
	for (const point of points) {
		if (point.y < min) min = point.y;
		if (point.y > max) max = point.y;
		sum += point.y;
	}
	const reduced = lttb(points, budget);
	return {
		points: reduced,
		min,
		max,
		avg: sum / points.length,
		xMin: points[0].x,
		xMax: points[points.length - 1].x,
	};
}

export type RouteSegment = {
	/** 0 = fastest band … 4 = slowest; `null` where GPS speed was unusable. */
	band: number | null;
	points: [number, number][];
};

export type RouteDisplay = {
	segments: RouteSegment[];
	bounds: [[number, number], [number, number]];
	start: [number, number];
	finish: [number, number];
	/** The four pace boundaries between the five bands, seconds per km. */
	bandBounds: number[];
	fastestPaceSPerKm: number | null;
	slowestPaceSPerKm: number | null;
	pointCount: number;
	rawPointCount: number;
};

type PacedPoint = RoutePoint & { pace: number | null };

function bandOf(pace: number | null, bounds: number[]): number | null {
	if (pace === null) return null;
	let band = 0;
	while (band < bounds.length && pace > bounds[band]) band += 1;
	return band;
}

/**
 * Folds stretches shorter than `minRun` into the band before them.
 *
 * Even smoothed, pace wanders back and forth across a quantile boundary, and
 * every crossing is another colour change: without this the 15.7 km run draws
 * as 385 two-point segments — confetti that says nothing — instead of the two
 * dozen stretches a runner would recognise.
 */
export function stabilizeBands(bands: (number | null)[], minRun = MIN_BAND_RUN): (number | null)[] {
	const out = bands.slice();
	let start = 0;
	while (start < out.length) {
		let end = start;
		while (end < out.length && out[end] === out[start]) end += 1;
		// The first stretch has nothing behind it to merge into, so it stands.
		if (end - start < minRun && start > 0) {
			for (let i = start; i < end; i++) out[i] = out[start - 1];
		}
		start = end;
	}
	return out;
}

/**
 * The polyline, thinned and cut into runs of one pace band each. Segments
 * repeat their neighbour's last point so the line reads as continuous rather
 * than as dashes.
 */
export function buildRouteDisplay(route: RoutePoint[], budget = ROUTE_BUDGET): RouteDisplay | null {
	if (route.length < 2) return null;

	// Instantaneous GPS speed jitters by a metre per second; the colour bands
	// only mean anything once it is averaged over `SPEED_SMOOTHING`.
	const smoothed = movingAverage(
		route.map((point) => (point.v !== null && point.v >= MIN_SPEED_MS ? point.v : null)),
		SPEED_SMOOTHING,
	);
	const paced: PacedPoint[] = route.map((point, i) => {
		const speed = smoothed[i];
		return { ...point, pace: speed !== null && speed >= MIN_SPEED_MS ? 1000 / speed : null };
	});

	const paces = paced
		.map((point) => point.pace)
		.filter((pace): pace is number => pace !== null)
		.sort((a, b) => a - b);
	const bandBounds = paces.length > 0 ? PACE_QUANTILES.map((q) => quantile(paces, q)) : [];

	const simplified = simplifyRoute(paced, budget);
	const bands = stabilizeBands(
		simplified.map((point) => (bandBounds.length > 0 ? bandOf(point.pace, bandBounds) : null)),
	);

	const segments: RouteSegment[] = [];
	for (let i = 0; i < simplified.length; i++) {
		const band = bands[i];
		const current = segments[segments.length - 1];
		if (current && current.band === band) {
			current.points.push([simplified[i].lat, simplified[i].lng]);
		} else {
			// Start on the previous point so consecutive bands share an edge.
			const bridge: [number, number][] = current ? [current.points[current.points.length - 1]] : [];
			segments.push({ band, points: [...bridge, [simplified[i].lat, simplified[i].lng]] });
		}
	}

	let south = Number.POSITIVE_INFINITY;
	let west = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	for (const point of simplified) {
		south = Math.min(south, point.lat);
		north = Math.max(north, point.lat);
		west = Math.min(west, point.lng);
		east = Math.max(east, point.lng);
	}

	const first = simplified[0];
	const last = simplified[simplified.length - 1];
	return {
		segments,
		bounds: [
			[south, west],
			[north, east],
		],
		start: [first.lat, first.lng],
		finish: [last.lat, last.lng],
		bandBounds,
		fastestPaceSPerKm: paces.length > 0 ? quantile(paces, 0.02) : null,
		slowestPaceSPerKm: paces.length > 0 ? quantile(paces, 0.98) : null,
		pointCount: simplified.length,
		rawPointCount: route.length,
	};
}

/** Altitude against distance covered — the profile a runner reads as "the hill at 8 km". */
export function buildElevationSeries(route: RoutePoint[], budget = CHART_BUDGET): ChartSeries | null {
	if (route.length < 2) return null;

	const smoothed = movingAverage(
		route.map((point) => point.alt),
		ALTITUDE_SMOOTHING,
	);

	const points: ChartPoint[] = [];
	let metres = 0;
	for (let i = 0; i < route.length; i++) {
		if (i > 0) metres += haversineM(route[i - 1], route[i]);
		const altitude = smoothed[i];
		if (altitude !== null) points.push({ x: metres / 1000, y: altitude });
	}
	return toSeries(points, budget);
}

/** Elapsed seconds on x — every time-based chart shares that axis so they line up. */
function elapsedSeries<T extends { t: number }>(
	samples: T[],
	value: (sample: T) => number,
	startedAt: number,
	budget: number,
): ChartSeries | null {
	const points: ChartPoint[] = samples
		.filter((sample) => sample.t >= startedAt)
		.map((sample) => ({ x: sample.t - startedAt, y: value(sample) }));
	return toSeries(points, budget);
}

export function buildHeartRateSeries(
	samples: HeartRateSample[],
	startedAt: number,
	budget = CHART_BUDGET,
): ChartSeries | null {
	return elapsedSeries(samples, (sample) => sample.bpm, startedAt, budget);
}

export function buildCadenceSeries(
	samples: CadenceSample[],
	startedAt: number,
	budget = CHART_BUDGET,
): ChartSeries | null {
	return elapsedSeries(samples, (sample) => sample.spm, startedAt, budget);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** A split with what the other streams were doing while it was run. */
export type SplitRow = Split & { avgHr: number | null; elevationDeltaM: number | null };

/**
 * Heart rate and net climb per kilometre. Both come from the full streams
 * rather than the downsampled series — the table shows numbers, and a number
 * has no reason to inherit the map's point budget.
 */
export function enrichSplits(splits: Split[], route: RoutePoint[], heartRate: HeartRateSample[]): SplitRow[] {
	const altitudes = movingAverage(
		route.map((point) => point.alt),
		ALTITUDE_SMOOTHING,
	);

	return splits.map((split) => {
		const from = split.t - split.splitS;
		const to = split.t;

		let sum = 0;
		let count = 0;
		for (const sample of heartRate) {
			if (sample.t <= from) continue;
			if (sample.t > to) break;
			sum += sample.bpm;
			count += 1;
		}

		let first: number | null = null;
		let last: number | null = null;
		for (let i = 0; i < route.length; i++) {
			if (route[i].t <= from) continue;
			if (route[i].t > to) break;
			const altitude = altitudes[i];
			if (altitude === null) continue;
			if (first === null) first = altitude;
			last = altitude;
		}

		return {
			...split,
			avgHr: count > 0 ? Math.round(sum / count) : null,
			elevationDeltaM: first !== null && last !== null ? last - first : null,
		};
	});
}

export type SplitStats = {
	fastest: Split | null;
	slowest: Split | null;
	/** Slowest full split minus fastest, seconds per km — how evenly it was run. */
	spreadS: number | null;
	/** Second half faster than the first, over full splits only. */
	negativeSplit: boolean | null;
};

/** Partial splits are excluded: 719 m at the end is not a kilometre's pace. */
export function splitStats(splits: Split[]): SplitStats {
	const full = splits.filter((split) => split.partial !== true);
	if (full.length === 0) return { fastest: null, slowest: null, spreadS: null, negativeSplit: null };

	let fastest = full[0];
	let slowest = full[0];
	for (const split of full) {
		if (split.paceSPerKm < fastest.paceSPerKm) fastest = split;
		if (split.paceSPerKm > slowest.paceSPerKm) slowest = split;
	}

	let negativeSplit: boolean | null = null;
	if (full.length >= 4) {
		const half = Math.floor(full.length / 2);
		const mean = (list: Split[]) => list.reduce((sum, split) => sum + split.paceSPerKm, 0) / list.length;
		negativeSplit = mean(full.slice(full.length - half)) < mean(full.slice(0, half));
	}

	return { fastest, slowest, spreadS: slowest.paceSPerKm - fastest.paceSPerKm, negativeSplit };
}

export type ElevationStats = { gainM: number | null; minM: number | null; maxM: number | null };

export function elevationStats(run: Pick<RunRecord, "elevationGainM">, route: RoutePoint[]): ElevationStats {
	let min: number | null = null;
	let max: number | null = null;
	for (const point of route) {
		if (point.alt === null) continue;
		min = min === null ? point.alt : Math.min(min, point.alt);
		max = max === null ? point.alt : Math.max(max, point.alt);
	}
	return { gainM: run.elevationGainM, minM: min, maxM: max };
}

export type RunStats = {
	distanceKm: number;
	durationS: number;
	paceSPerKm: number;
	avgHr: number | null;
	maxHr: number | null;
	avgCadence: number | null;
	elevation: ElevationStats;
	splits: SplitStats;
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type RunDetail = {
	run: RunRecord;
	/** False for a manual run: it has no streams to draw, only its own numbers. */
	hasStreams: boolean;
	route: RouteDisplay | null;
	elevation: ChartSeries | null;
	heartRate: ChartSeries | null;
	cadence: ChartSeries | null;
	splits: SplitRow[];
	stats: RunStats;
	weather: WeatherDisplay | null;
	/** Active energy burned, kcal — `runs.metrics` in the unit a runner reads. */
	energyKcal: number | null;
	/**
	 * How fast the heart came down after the finish. `null` unless the watch's
	 * post-run tail actually reached the one-minute mark, so a truncated
	 * recording says nothing rather than reporting a flatteringly small drop.
	 */
	hrRecovery: HrRecoveryStats | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The run, its streams and every display series — the page's whole payload.
 * `null` covers every way a URL can fail to name a run of this user's: a bad
 * id, someone else's run, a deleted one. The caller turns all three into the
 * same 404, so a member can't probe for the existence of another's runs.
 *
 * `cache` so `generateMetadata` and the page itself share one read: the two run
 * in the same request and neither should pay for the streams twice.
 */
export const loadRunDetail = cache(async function loadRunDetail(
	userId: string,
	runId: string,
): Promise<RunDetail | null> {
	// Postgres raises on a malformed uuid, which would be a 500 where a 404 belongs.
	if (!UUID.test(runId)) return null;

	const run = await getRun(userId, runId);
	if (!run) return null;

	// Ownership is settled above, so the streams can be read by run id alone.
	const rows = await getDb()
		.select({ kind: runStreams.kind, data: runStreams.data })
		.from(runStreams)
		.where(eq(runStreams.runId, run.id));

	const byKind = new Map(rows.map((row) => [row.kind, row.data]));
	const route = parseRoute(byKind.get("route"));
	const heartRate = parseHeartRate(byKind.get("heart_rate"));
	const cadence = parseCadence(byKind.get("cadence"));
	const splits = parseSplits(byKind.get("splits"));
	const recovery = hrRecoveryStats(parseHeartRate(byKind.get("hr_recovery")));

	// Streams carry absolute epoch seconds; charts want seconds into the run.
	// The route's first fix can predate `started_at` by a tick, so the earliest
	// sample of any stream anchors the axis.
	const starts = [Math.floor(run.startedAt.getTime() / 1000)];
	if (route.length > 0) starts.push(route[0].t);
	if (heartRate.length > 0) starts.push(heartRate[0].t);
	if (cadence.length > 0) starts.push(cadence[0].t);
	const startedAt = Math.min(...starts);

	const distanceKm = runDistanceKm(run);
	return {
		run,
		hasStreams: rows.length > 0,
		route: buildRouteDisplay(route),
		elevation: buildElevationSeries(route),
		heartRate: buildHeartRateSeries(heartRate, startedAt),
		cadence: buildCadenceSeries(cadence, startedAt),
		splits: enrichSplits(splits, route, heartRate),
		stats: {
			distanceKm,
			durationS: run.durationS,
			paceSPerKm: paceSeconds(distanceKm, run.durationS),
			avgHr: run.avgHr,
			maxHr: run.maxHr,
			avgCadence: run.avgCadence,
			elevation: elevationStats(run, route),
			splits: splitStats(splits),
		},
		weather: readWeather(run.weather),
		energyKcal: energyKcal(readRunMetrics(run.metrics)),
		hrRecovery: recovery.available ? recovery : null,
	};
});
