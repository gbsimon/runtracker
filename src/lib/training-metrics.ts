/**
 * Training signals computed from what is already stored — no new sensors, no
 * database, no clock. Every function here takes plain values and returns plain
 * values, so `pnpm check:metrics` can run them against the real captured
 * streams and the coach can call them without a round trip.
 *
 * The shapes are built to be read out loud in a prompt: small, labelled, units
 * in the field names, and an explicit `null` wherever the data doesn't support
 * an answer. Nothing here guesses — a run without heart rate contributes its
 * kilometres and abstains from the load, and a week the runner didn't run is a
 * zero rather than a gap.
 */

import type { HeartRateSample, RoutePoint, Split } from "./ingest/hae";
import { addDaysISO, daysBetweenISO, mondayISO } from "./running";

/** What every function here needs to know about a run. */
export type TrainingRun = {
	id?: string;
	/** Local calendar date, `YYYY-MM-DD` — the day the runner ran. */
	day: string;
	distanceM: number;
	durationS: number;
	avgHr: number | null;
	maxHr?: number | null;
};

const MIN_PER_S = 1 / 60;
const EARTH_RADIUS_M = 6_371_008.8;

// ---------------------------------------------------------------------------
// Weekly load
// ---------------------------------------------------------------------------

/**
 * Edwards' five zones, as fractions of maximum heart rate, each worth its
 * ordinal in minutes: an hour at 85% of max is four times the load of an hour
 * below 60%. Edwards times each zone from the heart-rate trace; with one
 * average per run the whole run is weighted by the zone its average sits in,
 * which is the standard simplification and is stable enough to compare weeks.
 */
const ZONE_FLOORS = [0.6, 0.7, 0.8, 0.9] as const;

/** Fallback maximum heart rate when neither the caller nor the data supplies one. */
const DEFAULT_HR_MAX = 190;

export type WeekLoad = {
	/** ISO-8601 week, `2026-W33`. */
	week: string;
	/** Monday of that week, `YYYY-MM-DD`. */
	weekStart: string;
	runs: number;
	km: number;
	durationS: number;
	/** Edwards-style load in weighted minutes; `0` for a week without running. */
	load: number;
	/** Share of the week's minutes that had heart rate behind them, 0–1. */
	loadCoverage: number;
};

export type WeeklyLoadReport = {
	/** Oldest week first, with the weeks nobody ran included as zeros. */
	weeks: WeekLoad[];
	hrMax: number;
	hrMaxSource: "given" | "observed" | "assumed";
	/** Load units, spelled out for whoever reads this next. */
	loadUnit: "weighted minutes (Edwards TRIMP, zone 1–5)";
};

export function hrZone(avgHr: number, hrMax: number): number {
	const fraction = avgHr / hrMax;
	let zone = 1;
	for (const floor of ZONE_FLOORS) if (fraction >= floor) zone += 1;
	return zone;
}

/** `2026-08-15` → `2026-W33`. The week's Thursday decides which year owns it. */
export function isoWeekKey(day: string): string {
	const monday = mondayISO(day);
	const thursday = addDaysISO(monday, 3);
	const year = thursday.slice(0, 4);
	const firstMonday = mondayISO(`${year}-01-04`);
	const week = Math.round(daysBetweenISO(firstMonday, monday) / 7) + 1;
	return `${year}-W${String(week).padStart(2, "0")}`;
}

function resolveHrMax(runs: TrainingRun[], given?: number): { hrMax: number; hrMaxSource: WeeklyLoadReport["hrMaxSource"] } {
	if (given && given > 0) return { hrMax: given, hrMaxSource: "given" };

	const observed = runs.reduce((peak, run) => Math.max(peak, run.maxHr ?? 0, run.avgHr ?? 0), 0);
	return observed > 0 ? { hrMax: observed, hrMaxSource: "observed" } : { hrMax: DEFAULT_HR_MAX, hrMaxSource: "assumed" };
}

/**
 * The last `weeks` calendar weeks of volume and load, Monday to Sunday.
 *
 * The window ends on the week containing `endDay`, or the newest run when the
 * caller doesn't say — so this reads the same whether it is called on Sunday
 * night or the following Tuesday.
 */
export function weeklyLoad(
	runs: TrainingRun[],
	weeks = 8,
	options: { hrMax?: number; endDay?: string } = {},
): WeeklyLoadReport {
	const span = Math.max(1, Math.floor(weeks));
	const { hrMax, hrMaxSource } = resolveHrMax(runs, options.hrMax);
	const report: WeeklyLoadReport = {
		weeks: [],
		hrMax,
		hrMaxSource,
		loadUnit: "weighted minutes (Edwards TRIMP, zone 1–5)",
	};

	const days = runs.map((run) => run.day).sort();
	const endDay = options.endDay ?? days.at(-1);
	if (!endDay) return report;

	const lastMonday = mondayISO(endDay);
	const firstMonday = addDaysISO(lastMonday, -7 * (span - 1));

	const buckets = new Map<string, { runs: number; distanceM: number; durationS: number; load: number; hrDurationS: number }>();
	for (let i = 0; i < span; i++) {
		buckets.set(addDaysISO(firstMonday, i * 7), { runs: 0, distanceM: 0, durationS: 0, load: 0, hrDurationS: 0 });
	}

	for (const run of runs) {
		const monday = mondayISO(run.day);
		const bucket = buckets.get(monday);
		if (!bucket) continue;

		bucket.runs += 1;
		bucket.distanceM += run.distanceM;
		bucket.durationS += run.durationS;
		if (run.avgHr !== null && run.avgHr > 0) {
			bucket.hrDurationS += run.durationS;
			bucket.load += run.durationS * MIN_PER_S * hrZone(run.avgHr, hrMax);
		}
	}

	report.weeks = [...buckets.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([weekStart, bucket]) => ({
			week: isoWeekKey(weekStart),
			weekStart,
			runs: bucket.runs,
			km: Math.round(bucket.distanceM / 10) / 100,
			durationS: Math.round(bucket.durationS),
			load: Math.round(bucket.load),
			loadCoverage: bucket.durationS > 0 ? Math.round((bucket.hrDurationS / bucket.durationS) * 100) / 100 : 1,
		}));

	return report;
}

// ---------------------------------------------------------------------------
// Aerobic decoupling
// ---------------------------------------------------------------------------

export type DecouplingHalf = {
	distanceM: number;
	durationS: number;
	paceSPerKm: number;
	avgHr: number;
	/** Metres per second per beat per minute — speed bought with each unit of heart rate. */
	ratio: number;
	hrSamples: number;
};

export type AerobicDecoupling = {
	available: boolean;
	reason?: string;
	/**
	 * Positive means the second half cost more heart rate for the same speed —
	 * the aerobic system fading. Under ~5% is the usual "well within aerobic
	 * capacity" reading for a steady run.
	 */
	driftPct: number | null;
	first: DecouplingHalf | null;
	second: DecouplingHalf | null;
	/**
	 * Whether the effort held still enough for the number to mean anything —
	 * see `isSteady`. A drift figure from an interval session measures the
	 * intervals, not the runner.
	 */
	steady: boolean;
	/** Spread of the full-kilometre paces, as a coefficient of variation in %. */
	paceVariationPct: number | null;
	source: "splits" | "route" | null;
};

/** Cumulative distance at a moment, the shape both splits and routes reduce to. */
type DistancePoint = { t: number; m: number };

function haversineM(a: RoutePoint, b: RoutePoint): number {
	const toRad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * toRad;
	const dLng = (b.lng - a.lng) * toRad;
	const lat1 = a.lat * toRad;
	const lat2 = b.lat * toRad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cumulativeFromSplits(splits: Split[]): DistancePoint[] {
	const ordered = [...splits].sort((a, b) => a.t - b.t);
	if (ordered.length < 2) return [];

	// Back to the wall-clock start: `splitS` excludes any auto-paused seconds.
	const start = ordered[0].t - ordered[0].splitS - (ordered[0].pausedS ?? 0);
	const points: DistancePoint[] = [{ t: start, m: 0 }];
	let cumulative = 0;
	for (const split of ordered) {
		cumulative += split.distanceM;
		points.push({ t: split.t, m: cumulative });
	}
	return points;
}

function cumulativeFromRoute(route: RoutePoint[]): DistancePoint[] {
	const ordered = [...route].sort((a, b) => a.t - b.t);
	if (ordered.length < 2) return [];

	const points: DistancePoint[] = [{ t: ordered[0].t, m: 0 }];
	let cumulative = 0;
	for (let i = 1; i < ordered.length; i++) {
		cumulative += haversineM(ordered[i - 1], ordered[i]);
		points.push({ t: ordered[i].t, m: cumulative });
	}
	return points;
}

/** Metres covered by time `t`, interpolated inside the sample that straddles it. */
function distanceAt(points: DistancePoint[], t: number): number {
	if (t <= points[0].t) return points[0].m;
	const last = points.at(-1) as DistancePoint;
	if (t >= last.t) return last.m;

	for (let i = 1; i < points.length; i++) {
		if (points[i].t < t) continue;
		const span = points[i].t - points[i - 1].t;
		const fraction = span > 0 ? (t - points[i - 1].t) / span : 0;
		return points[i - 1].m + fraction * (points[i].m - points[i - 1].m);
	}
	return last.m;
}

function meanHr(samples: HeartRateSample[], from: number, to: number): { avgHr: number | null; count: number } {
	let total = 0;
	let count = 0;
	for (const sample of samples) {
		if (sample.t < from || sample.t >= to) continue;
		total += sample.bpm;
		count += 1;
	}
	return { avgHr: count > 0 ? total / count : null, count };
}

/** Coefficient of variation of the full-kilometre paces, in %. `null` under three of them. */
export function paceVariationPct(splits: Split[]): number | null {
	const paces = splits.filter((split) => !split.partial && split.paceSPerKm > 0).map((split) => split.paceSPerKm);
	if (paces.length < 3) return null;

	const mean = paces.reduce((total, pace) => total + pace, 0) / paces.length;
	if (mean <= 0) return null;
	const variance = paces.reduce((total, pace) => total + (pace - mean) ** 2, 0) / paces.length;
	return Math.round((Math.sqrt(variance) / mean) * 1000) / 10;
}

const MIN_DECOUPLING_MINUTES = 20;
const MIN_HR_SAMPLES_PER_HALF = 10;
/** Above this spread of kilometre paces the run was a workout, not a steady effort. */
const MAX_STEADY_PACE_VARIATION_PCT = 12;

/**
 * Heart-rate drift at steady pace: how much more heart rate the second half of
 * a run cost for the same speed. The halves are equal *time* (Friel's Pa:HR),
 * each half's ratio is speed ÷ average heart rate, and the drift is the fall
 * from the first ratio to the second, in per cent.
 *
 * "Steady" means the effort held still enough for that comparison to be about
 * the runner rather than the session: at least 20 minutes long, at least ten
 * heart-rate samples in each half, and full-kilometre paces spread no more than
 * 12% (coefficient of variation). An interval workout fails the last test.
 * The number is still returned when a run isn't steady — `steady: false` says
 * how much to trust it.
 *
 * Splits are the preferred distance source since they're already derived;
 * a route is walked with haversine when they're missing.
 */
export function aerobicDecoupling(
	series: { splits?: Split[] | null; route?: RoutePoint[] | null },
	heartRate: HeartRateSample[],
	options: { minMinutes?: number; maxPaceVariationPct?: number } = {},
): AerobicDecoupling {
	const minMinutes = options.minMinutes ?? MIN_DECOUPLING_MINUTES;
	const maxVariation = options.maxPaceVariationPct ?? MAX_STEADY_PACE_VARIATION_PCT;

	const empty: AerobicDecoupling = {
		available: false,
		driftPct: null,
		first: null,
		second: null,
		steady: false,
		paceVariationPct: series.splits ? paceVariationPct(series.splits) : null,
		source: null,
	};

	const splits = series.splits ?? [];
	const points = splits.length >= 2 ? cumulativeFromSplits(splits) : cumulativeFromRoute(series.route ?? []);
	const source = splits.length >= 2 ? "splits" : series.route && series.route.length >= 2 ? "route" : null;
	if (points.length < 2 || !source) return { ...empty, reason: "no distance series" };

	const start = points[0].t;
	const end = (points.at(-1) as DistancePoint).t;
	const durationS = end - start;
	if (durationS < minMinutes * 60) {
		return { ...empty, source, reason: `run is under ${minMinutes} minutes of samples` };
	}

	const mid = start + durationS / 2;
	const midDistance = distanceAt(points, mid);
	const totalDistance = (points.at(-1) as DistancePoint).m;

	const halves = [
		{ from: start, to: mid, distanceM: midDistance },
		{ from: mid, to: end + 1, distanceM: totalDistance - midDistance },
	].map((half) => {
		const { avgHr, count } = meanHr(heartRate, half.from, half.to);
		const seconds = half.to === end + 1 ? end - half.from : half.to - half.from;
		return { ...half, avgHr, count, durationS: seconds };
	});

	if (halves.some((half) => half.avgHr === null || half.count < MIN_HR_SAMPLES_PER_HALF)) {
		return { ...empty, source, reason: "not enough heart-rate samples in both halves" };
	}
	if (halves.some((half) => !(half.distanceM > 0) || !(half.durationS > 0))) {
		return { ...empty, source, reason: "a half covered no ground" };
	}

	const summarise = (half: (typeof halves)[number]): DecouplingHalf => {
		const avgHr = half.avgHr as number;
		const speed = half.distanceM / half.durationS;
		return {
			distanceM: Math.round(half.distanceM),
			durationS: Math.round(half.durationS),
			paceSPerKm: Math.round(half.durationS / (half.distanceM / 1000)),
			avgHr: Math.round(avgHr * 10) / 10,
			ratio: Math.round((speed / avgHr) * 100_000) / 100_000,
			hrSamples: half.count,
		};
	};

	const first = summarise(halves[0]);
	const second = summarise(halves[1]);
	const variation = paceVariationPct(splits);

	return {
		available: true,
		driftPct: Math.round(((first.ratio - second.ratio) / first.ratio) * 1000) / 10,
		first,
		second,
		steady: variation !== null && variation <= maxVariation,
		paceVariationPct: variation,
		source,
	};
}

// ---------------------------------------------------------------------------
// Efficiency trend
// ---------------------------------------------------------------------------

export type EfficiencyPoint = {
	day: string;
	runId?: string;
	km: number;
	paceSPerKm: number;
	avgHr: number;
	/** Metres covered per heartbeat — higher is fitter at the same effort. */
	metresPerBeat: number;
};

export type EfficiencyTrend = {
	/** Comparable runs only, oldest first. */
	points: EfficiencyPoint[];
	/** The heart-rate window the comparison held to. */
	band: { medianHr: number; loBpm: number; hiBpm: number } | null;
	/** Least-squares change in metres per beat over 30 days. */
	changePer30Days: number | null;
	changePctPer30Days: number | null;
	direction: "improving" | "flat" | "declining" | null;
	/** Runs that had heart rate and were long enough, before the band narrowed them. */
	considered: number;
	reason?: string;
	unit: "metres per heartbeat";
};

const MIN_EFFICIENCY_KM = 3;
const MIN_EFFICIENCY_MINUTES = 20;
/** How far either side of the median an "equally hard" run may sit. */
const HR_BAND_PCT = 6;
const MIN_EFFICIENCY_POINTS = 3;
/** Under this much change over a month, the trend is noise. */
const FLAT_PCT = 1;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Pace at a given heart rate over time, expressed as metres per heartbeat
 * (distance ÷ total beats). Rising means the same heart rate is buying more
 * ground, which is what getting fitter looks like from the outside.
 *
 * "Comparable" is the hard part, because a runner's zones aren't in the
 * database. The definition used here needs nothing but the runs: keep those
 * with heart rate that went at least 3 km and 20 minutes, then keep only the
 * ones whose average heart rate sits within 6% of the *median* of that set.
 * Most of any runner's volume is easy running, so the median run is an easy
 * run, and the band compares like with like without ever naming a zone. Runs
 * on either side — the parkrun, the recovery shuffle — drop out rather than
 * dragging the line.
 */
export function efficiencyTrend(
	runs: TrainingRun[],
	options: { minKm?: number; minMinutes?: number; hrBandPct?: number; minPoints?: number } = {},
): EfficiencyTrend {
	const minKm = options.minKm ?? MIN_EFFICIENCY_KM;
	const minMinutes = options.minMinutes ?? MIN_EFFICIENCY_MINUTES;
	const bandPct = options.hrBandPct ?? HR_BAND_PCT;
	const minPoints = options.minPoints ?? MIN_EFFICIENCY_POINTS;

	const empty: EfficiencyTrend = {
		points: [],
		band: null,
		changePer30Days: null,
		changePctPer30Days: null,
		direction: null,
		considered: 0,
		unit: "metres per heartbeat",
	};

	const eligible = runs.filter(
		(run) =>
			run.avgHr !== null &&
			run.avgHr > 0 &&
			run.durationS >= minMinutes * 60 &&
			run.distanceM >= minKm * 1000,
	);
	if (eligible.length === 0) return { ...empty, reason: "no runs with heart rate long enough to compare" };

	const medianHr = median(eligible.map((run) => run.avgHr as number));
	const loBpm = Math.round(medianHr * (1 - bandPct / 100) * 10) / 10;
	const hiBpm = Math.round(medianHr * (1 + bandPct / 100) * 10) / 10;
	const band = { medianHr: Math.round(medianHr * 10) / 10, loBpm, hiBpm };

	const points: EfficiencyPoint[] = eligible
		.filter((run) => (run.avgHr as number) >= loBpm && (run.avgHr as number) <= hiBpm)
		.map((run) => {
			const avgHr = run.avgHr as number;
			const beats = avgHr * (run.durationS * MIN_PER_S);
			return {
				day: run.day,
				runId: run.id,
				km: Math.round(run.distanceM / 10) / 100,
				paceSPerKm: Math.round(run.durationS / (run.distanceM / 1000)),
				avgHr: Math.round(avgHr * 10) / 10,
				metresPerBeat: Math.round((run.distanceM / beats) * 1000) / 1000,
			};
		})
		.sort((a, b) => a.day.localeCompare(b.day));

	const trend: EfficiencyTrend = { ...empty, points, band, considered: eligible.length };
	if (points.length < minPoints) {
		return { ...trend, reason: `${points.length} comparable run${points.length === 1 ? "" : "s"}; ${minPoints} needed for a trend` };
	}

	// Least squares over days-since-the-first-point.
	const xs = points.map((point) => daysBetweenISO(points[0].day, point.day));
	const ys = points.map((point) => point.metresPerBeat);
	const meanX = xs.reduce((total, x) => total + x, 0) / xs.length;
	const meanY = ys.reduce((total, y) => total + y, 0) / ys.length;
	const varianceX = xs.reduce((total, x) => total + (x - meanX) ** 2, 0);
	if (varianceX === 0) return { ...trend, reason: "every comparable run is on the same day" };

	const covariance = xs.reduce((total, x, i) => total + (x - meanX) * (ys[i] - meanY), 0);
	const slopePerDay = covariance / varianceX;
	const changePer30Days = Math.round(slopePerDay * 30 * 1000) / 1000;
	const changePctPer30Days = meanY > 0 ? Math.round(((slopePerDay * 30) / meanY) * 1000) / 10 : null;

	return {
		...trend,
		changePer30Days,
		changePctPer30Days,
		direction:
			changePctPer30Days === null || Math.abs(changePctPer30Days) < FLAT_PCT
				? "flat"
				: changePctPer30Days > 0
					? "improving"
					: "declining",
	};
}

// ---------------------------------------------------------------------------
// Heart-rate recovery
// ---------------------------------------------------------------------------

export type HrRecoveryStats = {
	available: boolean;
	/** Highest reading in the first seconds after stopping — the curve's start. */
	peakBpm: number | null;
	bpmAt60: number | null;
	bpmAt120: number | null;
	/** Beats per minute shed in the first minute; the usual "HRR1". */
	drop60: number | null;
	/** Only present when the watch kept recording past two minutes. */
	drop120: number | null;
	/** How long the recorded tail runs, in seconds. */
	windowS: number;
	samples: number;
	reason?: string;
};

/**
 * How far past the last sample a mark may sit and still be answered. Apple's
 * tail is dense but ends where it ends; five seconds of a decay curve is under
 * a beat or two of error, where stretching to ten would quietly invent the
 * two-minute figure out of a 111-second recording.
 */
const RECOVERY_TOLERANCE_S = 5;
/** The peak is taken from the first seconds, not the single first reading. */
const PEAK_WINDOW_S = 15;

function bpmAt(samples: HeartRateSample[], t: number, tolerance = RECOVERY_TOLERANCE_S): number | null {
	const first = samples[0];
	const last = samples.at(-1) as HeartRateSample;
	if (t < first.t - tolerance || t > last.t + tolerance) return null;
	if (t <= first.t) return first.bpm;
	if (t >= last.t) return last.bpm;

	for (let i = 1; i < samples.length; i++) {
		if (samples[i].t < t) continue;
		const span = samples[i].t - samples[i - 1].t;
		const fraction = span > 0 ? (t - samples[i - 1].t) / span : 0;
		return Math.round(samples[i - 1].bpm + fraction * (samples[i].bpm - samples[i - 1].bpm));
	}
	return last.bpm;
}

/**
 * How fast the heart came down once the run stopped, from the `hr_recovery`
 * stream. A bigger one-minute drop is the fitter, fresher reading; watching it
 * fall week over week at the same session type is a fatigue signal.
 *
 * Apple's tail runs about two minutes, so the two-minute figure is `null`
 * whenever the watch stopped first rather than being reported as a smaller drop.
 */
export function hrRecoveryStats(samples: HeartRateSample[]): HrRecoveryStats {
	const empty: HrRecoveryStats = {
		available: false,
		peakBpm: null,
		bpmAt60: null,
		bpmAt120: null,
		drop60: null,
		drop120: null,
		windowS: 0,
		samples: samples.length,
	};
	if (samples.length < 2) return { ...empty, reason: "no recovery samples" };

	const ordered = [...samples].sort((a, b) => a.t - b.t);
	const start = ordered[0].t;
	const windowS = (ordered.at(-1) as HeartRateSample).t - start;

	const peakBpm = ordered.filter((sample) => sample.t <= start + PEAK_WINDOW_S).reduce((peak, sample) => Math.max(peak, sample.bpm), 0);
	const bpmAt60 = bpmAt(ordered, start + 60);
	const bpmAt120 = bpmAt(ordered, start + 120);

	return {
		available: bpmAt60 !== null,
		peakBpm,
		bpmAt60,
		bpmAt120,
		drop60: bpmAt60 === null ? null : peakBpm - bpmAt60,
		drop120: bpmAt120 === null ? null : peakBpm - bpmAt120,
		windowS,
		samples: ordered.length,
		...(bpmAt60 === null ? { reason: `recovery tail is only ${windowS}s` } : {}),
	};
}
