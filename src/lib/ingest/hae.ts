/**
 * Health Auto Export → `ParsedWorkout`. Pure: no database, no network, no
 * clock — feed it a payload and it hands back rows and streams.
 *
 * The payload's field *names* are the only stable contract. Names and units
 * strings come out localized (`"Extérieur Course"`, `"pas"` for steps) and are
 * sometimes plain wrong (`avgSpeed.units: "km"` on a km/h value), so no *value*
 * here is read out of a `units` string or a `name`. The single exception is the
 * workout's type — see `RUN_NAME_FRAGMENTS`, which HAE only ever states in the
 * phone's language. See `tasks/hae-schema.md` for the verified shape this
 * follows.
 */

import type { RunMetrics } from "../run-metrics";
import type { RunWeather } from "../weather";

/** `2026-08-15 14:19:19 -0400` — not ISO-8601, so it gets its own parse. */
const HAE_DATE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

const MS = 1000;

/**
 * The automation forwards every workout type it can see, and HealthKit's type
 * reaches us only as the localized display `name` — `"Extérieur Course"` for a
 * run, `"Marche"` for a walk, with no other field separating them. Detecting the
 * type is therefore the one decision this parser takes from `name`, deliberately
 * against the rule the rest of the file keeps. It is safe to do here and nowhere
 * else: guessing wrong only ever skips a workout, the skip is reported with the
 * offending name, and the raw payload is stored forever, so a missing locale is
 * one entry below plus a Reprocess away from being fixed.
 *
 * Matching is on *fragments* of the accent-stripped, lowercased name rather than
 * whole words, so compounded and inflected names ("Trail Running", "Jogging",
 * "Course à pied") are covered by the stem. Adding a language is one line — and
 * a user who doesn't want to wait for one adds their own fragment from the Sync
 * tab, which merges into this list for their payloads only.
 */
export const RUN_NAME_FRAGMENTS = [
	"run", // en — "Outdoor Run", "Indoor Run", "Trail Running"
	"jog", // en — "Jogging"
	"course", // fr — "Extérieur Course", "Course à pied"; also means "race", still a run
	"trail", // en/fr — "Trail Running", "Course de trail"
] as const;

/**
 * Bounds on a fragment a *user* adds from the Sync tab. One character would
 * match half the alphabet's worth of workout names; forty is longer than any
 * localized name HealthKit hands out.
 */
export const RUN_FRAGMENT_MIN = 2;
export const RUN_FRAGMENT_MAX = 40;

/** A person owns a handful of workout types, not hundreds — a cap on the stored list. */
export const MAX_EXTRA_RUN_FRAGMENTS = 40;

/**
 * Lowercased with the accents peeled off and the spacing regularized, so
 * `"Extérieur  Course"` reads as `"exterieur course"`. Both sides of every
 * comparison go through it, which is what lets a fragment a user typed match a
 * name a phone wrote.
 */
export function foldRunName(name: string): string {
	return name
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A user's own additions to the allowlist, cleaned for storage: folded, length
 * checked, deduped and capped. Anything that isn't a usable fragment is
 * dropped rather than rejected — this normalizes rows written by an older
 * build as readily as it does a fresh click.
 */
export function normalizeRunFragments(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];

	const fragments: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const fragment = foldRunName(entry);
		if (fragment.length < RUN_FRAGMENT_MIN || fragment.length > RUN_FRAGMENT_MAX) continue;
		if (!fragments.includes(fragment)) fragments.push(fragment);
		if (fragments.length === MAX_EXTRA_RUN_FRAGMENTS) break;
	}
	return fragments;
}

/**
 * Whether a workout's localized name says it is a run — the built-in fragments
 * plus whatever this user has allowed from the Sync tab, which is how a locale
 * or an activity the core list never anticipated gets imported without a
 * deploy. The extras are folded here too, so passing raw names works.
 */
export function isRunName(name: string, extraFragments: readonly string[] = []): boolean {
	const folded = foldRunName(name);
	if (!folded) return false;
	if (RUN_NAME_FRAGMENTS.some((fragment) => folded.includes(fragment))) return true;
	return extraFragments.some((fragment) => {
		const extra = foldRunName(fragment);
		return extra.length > 0 && folded.includes(extra);
	});
}

export type ParsedTimestamp = {
	/** The instant, timezone-resolved. */
	at: Date;
	/** Minutes east of UTC — `-240` for `-0400`. */
	offsetMinutes: number;
	/** `-04:00`. The IANA zone name isn't in the payload, so the offset stands in. */
	offset: string;
};

/**
 * Stream sample times are **absolute epoch seconds (UTC)**, one shape for every
 * kind, so a chart can align heart rate against the route without knowing the
 * run's start. Coordinates are rounded to 6 decimals (~0.1 m) and speeds to 2:
 * full float precision triples the stored JSON for accuracy no GPS chip has.
 */
export type RoutePoint = { t: number; lat: number; lng: number; alt: number | null; v: number | null };
export type HeartRateSample = { t: number; bpm: number };
export type CadenceSample = { t: number; spm: number };

/** One per completed kilometre, plus a `partial` entry for the leftover. */
export type Split = {
	km: number;
	/** Epoch seconds when this split ended. */
	t: number;
	/** Wall-clock seconds from the run's start to `t`, auto-pauses included. */
	elapsedS: number;
	/** **Moving** seconds for this kilometre — see `deriveSplits`. */
	splitS: number;
	distanceM: number;
	/** Moving pace, so it reads the same as the watch's own splits. */
	paceSPerKm: number;
	/**
	 * Seconds this split went by at a standstill, excluded from `splitS`.
	 * Absent rather than `0` when the runner never stopped, which is what keeps
	 * such a run serializing exactly as it did before this field existed.
	 */
	pausedS?: number;
	partial?: true;
};

export type ParsedStreams = {
	route: RoutePoint[];
	heart_rate: HeartRateSample[];
	cadence: CadenceSample[];
	splits: Split[];
	/**
	 * The two minutes after the runner stopped, same `{t, bpm}` shape as the
	 * workout's own heart rate. Its samples sit *outside* the run window on
	 * purpose — how fast that curve falls is the measurement.
	 */
	hr_recovery: HeartRateSample[];
};

export type ParsedWorkout = {
	externalId: string;
	/** Localized and trimmed, e.g. `"Extérieur Course"` — never empty, since an
	 * unnamed workout can't clear the run filter. */
	name: string;
	isIndoor: boolean;
	startedAt: Date;
	endedAt: Date | null;
	/** `-04:00` — stored in `runs.timezone`, which Intl accepts as a zone. */
	timezone: string;
	/** The calendar date the runner ran on, in their own offset. */
	localDate: string;
	/** `HH:MM` local. */
	localTime: string;
	distanceM: number;
	durationS: number;
	avgHr: number | null;
	maxHr: number | null;
	avgCadence: number | null;
	elevationGainM: number | null;
	/** Seeded from the watch's own temperature/humidity when it recorded them. */
	weather: RunWeather | null;
	/** Energy and top speed, in SI — see `src/lib/run-metrics.ts`. */
	metrics: RunMetrics | null;
	/** First GPS fix — what the Open-Meteo lookup is anchored to. */
	firstPoint: { lat: number; lng: number } | null;
	streams: ParsedStreams;
};

/**
 * `name` and `localDate` are what makes a skip reviewable weeks later on the
 * Sync tab — "a Marche on 14 Aug", not "one workout, skipped". Both are
 * best-effort: a payload can be missing either, and a skip is recorded anyway.
 */
export type SkippedWorkout = {
	externalId: string | null;
	reason: string;
	/** The localized name HAE stated, trimmed — `null` when it sent none. */
	name: string | null;
	/** The day it happened, in the phone's own offset — `null` when the start was unreadable. */
	localDate: string | null;
};

export type ParsedPayload = { workouts: ParsedWorkout[]; skipped: SkippedWorkout[] };

export type ParseOptions = {
	/** This user's own allowed workout-name fragments — see `isRunName`. */
	extraRunFragments?: readonly string[];
};

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown): Row[] {
	return Array.isArray(value) ? value.filter(isRow) : [];
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** HAE wraps every scalar as `{qty, units}`; a bare number shows up too. */
function qty(value: unknown): number | null {
	if (isRow(value)) return num(value.qty);
	return num(value);
}

function round(value: number | null, digits: number): number | null {
	if (value === null) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function parseHaeTimestamp(value: unknown): ParsedTimestamp | null {
	if (typeof value !== "string") return null;
	const match = HAE_DATE.exec(value.trim());
	if (!match) return null;

	const [, year, month, day, hour, minute, second, zone] = match;
	const wallClock = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));

	let offsetMinutes = 0;
	if (zone && zone !== "Z") {
		const sign = zone.startsWith("-") ? -1 : 1;
		const digits = zone.slice(1).replace(":", "");
		offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
	}

	const at = new Date(wallClock - offsetMinutes * 60 * MS);
	if (Number.isNaN(at.getTime())) return null;

	const absolute = Math.abs(offsetMinutes);
	const offset = `${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
	return { at, offsetMinutes, offset };
}

/** Epoch seconds for a sample, or `null` when its date is unreadable. */
function sampleSeconds(value: unknown): number | null {
	const parsed = parseHaeTimestamp(value);
	return parsed ? Math.round(parsed.at.getTime() / MS) : null;
}

function localParts(at: Date, offsetMinutes: number): { date: string; time: string } {
	const shifted = new Date(at.getTime() + offsetMinutes * 60 * MS).toISOString();
	return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function parseRoute(value: unknown): { points: RoutePoint[]; first: { lat: number; lng: number } | null } {
	const points: RoutePoint[] = [];
	let first: { lat: number; lng: number } | null = null;

	for (const point of rows(value)) {
		const lat = num(point.latitude);
		const lng = num(point.longitude);
		const t = sampleSeconds(point.timestamp);
		if (lat === null || lng === null || t === null) continue;

		if (!first) first = { lat, lng };
		points.push({
			t,
			lat: round(lat, 6) as number,
			lng: round(lng, 6) as number,
			alt: round(num(point.altitude), 1),
			v: round(num(point.speed), 2),
		});
	}

	points.sort((a, b) => a.t - b.t);
	return { points, first };
}

/** `heartRateData` capitalizes its keys — `Avg`, not `avg`. */
function parseHeartRate(value: unknown): HeartRateSample[] {
	const samples: HeartRateSample[] = [];
	for (const entry of rows(value)) {
		const bpm = num(entry.Avg) ?? num(entry.avg) ?? qty(entry.qty);
		const t = sampleSeconds(entry.date);
		if (bpm === null || t === null) continue;
		samples.push({ t, bpm: Math.round(bpm) });
	}
	return samples.sort((a, b) => a.t - b.t);
}

type TimedQuantity = { t: number; qty: number };

function timedQuantities(value: unknown): TimedQuantity[] {
	const samples: TimedQuantity[] = [];
	for (const entry of rows(value)) {
		const amount = num(entry.qty);
		const t = sampleSeconds(entry.date);
		if (amount === null || t === null) continue;
		samples.push({ t, qty: amount });
	}
	return samples.sort((a, b) => a.t - b.t);
}

/**
 * How much time one sample stands for. HAE emits per-second series at our
 * settings, but the interval is a user setting, so it's measured rather than
 * assumed — the median gap survives the pauses a run picks up at traffic lights.
 */
function sampleStepSeconds(samples: TimedQuantity[]): number {
	const gaps: number[] = [];
	for (let i = 1; i < samples.length; i++) {
		const gap = samples[i].t - samples[i - 1].t;
		if (gap > 0) gaps.push(gap);
	}
	if (gaps.length === 0) return 1;
	gaps.sort((a, b) => a - b);
	return Math.min(60, Math.max(1, gaps[Math.floor(gaps.length / 2)]));
}

/**
 * `stepCount` is a per-sample step *delta* (units read `"pas"` on a French
 * device — the field name is what says these are steps). Cadence is those
 * steps per minute, bucketed into whole minutes from the run's start; a bucket
 * the watch only partly covered is scaled by the seconds it actually holds, so
 * the final short minute doesn't read as a collapse in turnover.
 */
function deriveCadence(value: unknown, startSeconds: number): CadenceSample[] {
	const samples = timedQuantities(value);
	if (samples.length === 0) return [];

	const step = sampleStepSeconds(samples);
	const buckets = new Map<number, { steps: number; covered: number }>();

	for (const sample of samples) {
		const index = Math.floor((sample.t - startSeconds) / 60);
		const bucket = buckets.get(index) ?? { steps: 0, covered: 0 };
		bucket.steps += sample.qty;
		bucket.covered = Math.min(60, bucket.covered + step);
		buckets.set(index, bucket);
	}

	return [...buckets.entries()]
		.filter(([, bucket]) => bucket.covered > 0)
		.map(([index, bucket]) => ({
			t: startSeconds + index * 60,
			spm: round(bucket.steps / (bucket.covered / 60), 1) as number,
		}))
		.sort((a, b) => a.t - b.t);
}

/**
 * Below this implied speed the runner was standing still rather than moving. It
 * is the same half-a-metre-per-second standstill the map's pace bands use — see
 * `MIN_SPEED_MS` in `src/lib/run-detail.ts`, which can't be imported here
 * without dragging the database into the parser.
 */
const PAUSE_SPEED_MS = 0.5;

/** A stretch of wall clock the runner spent stopped, in absolute epoch seconds. */
type PausedSpan = { from: number; to: number };

/**
 * The stretches of a run that went by at a standstill.
 *
 * HAE's series are health-store-scoped, not workout-scoped, so they usually run
 * straight *through* the watch's auto-pauses: a stoplight arrives as thirty
 * one-second samples carrying no distance, not as a hole in the timestamps.
 * Sometimes the samples stop instead. Both are the same event seen from
 * different ends, so both are read the same way — a maximal run of consecutive
 * samples whose implied speed is under `PAUSE_SPEED_MS`, however many samples
 * that turns out to be.
 *
 * One `step` at the end of each stretch is kept as moving time: the sample that
 * closes it still stands for its own interval, and the allowance is what stops
 * an ordinary slow stretch from bleeding seconds. It is granted once per
 * stretch, not per sample. A lone sample after a long gap is simply the
 * one-sample case, and gives back `gap - step` exactly as it always has.
 */
function pausedSpans(samples: TimedQuantity[], step: number): PausedSpan[] {
	const spans: PausedSpan[] = [];
	/** Start of the stretch being accumulated: the last sample *before* it. */
	let stretchFrom: number | null = null;

	const close = (until: number): void => {
		if (stretchFrom !== null && until - step > stretchFrom) spans.push({ from: stretchFrom, to: until - step });
		stretchFrom = null;
	};

	// From `1`: the run's start to its first sample is the watch getting going,
	// which is not something to charge anyone for.
	for (let i = 1; i < samples.length; i++) {
		const dt = samples[i].t - samples[i - 1].t;
		if (dt > 0 && (samples[i].qty * 1000) / dt < PAUSE_SPEED_MS) {
			if (stretchFrom === null) stretchFrom = samples[i - 1].t;
		} else {
			close(samples[i - 1].t);
		}
	}
	close(samples[samples.length - 1].t);

	return spans;
}

/**
 * Seconds spent standing still before `t`. Spans are disjoint and in time
 * order, which is what makes this 1-Lipschitz: over any window it can never
 * return more paused seconds than the window has seconds.
 */
function pausedSecondsBefore(spans: PausedSpan[], t: number): number {
	let total = 0;
	for (const span of spans) {
		if (span.from >= t) break;
		total += Math.min(t, span.to) - span.from;
	}
	return total;
}

/**
 * `walkingAndRunningDistance` arrives as per-sample distance deltas in km
 * (despite the schema note calling it cumulative — the observed values sum to
 * the workout total). Running them up gives the kilometre marks, with the
 * crossing time interpolated inside the sample that straddles each boundary.
 *
 * Two things separate the *workout* from the series it is drawn out of, both of
 * them because HAE's series belong to the health store rather than to the
 * workout, and so keep recording through everything the watch excludes.
 *
 * **Standstills are taken out of the split times.** Time the runner spent
 * stopped is charged to `pausedS` and kept out of `splitS`, so a traffic light
 * no longer lands on whichever kilometre it was waited out in. `pausedSpans`
 * finds the stretches; they are attributed to splits strictly by time, so a
 * stretch straddling a kilometre mark is divided between the two.
 *
 * **A tail beyond the workout's own distance is dropped.** Press pause and jog
 * home and the series keeps accruing: on the captured 17.01 km run the samples
 * summed to 17.58 km, enough to invent an eighteenth kilometre Apple never
 * counted. `distanceCapM` is the workout's own `distance`, and once the running
 * total reaches it the final partial is interpolated to land exactly there and
 * nothing further is read — neither its distance nor its time reaches a split.
 * With no cap given, or a series that never reaches it, nothing changes.
 *
 * So `splitS` and `paceSPerKm` are **moving** figures, `pausedS` records what
 * was taken out (omitted when nothing was), and `t`/`elapsedS` stay wall-clock:
 * `splitS + pausedS` is always the span from the previous boundary to this one.
 * A boundary crossed inside a standstill is interpolated over that sample's
 * moving tail, which keeps `t` at or after the previous boundary and so keeps
 * the series monotonic. A run that never stopped and never overran its distance
 * comes out byte-for-byte as it did before any of this existed.
 */
function deriveSplits(value: unknown, startSeconds: number, distanceCapM: number | null): Split[] {
	const samples = timedQuantities(value);
	if (samples.length === 0) return [];

	const step = sampleStepSeconds(samples);
	const spans = pausedSpans(samples, step);
	// A missing or nonsensical workout distance simply doesn't cap anything.
	const cap = distanceCapM !== null && distanceCapM > 0 ? distanceCapM : null;

	const splits: Split[] = [];
	let cumulative = 0;
	let previousT = startSeconds;
	let previousBoundaryT = startSeconds;
	/** Paused seconds already charged to earlier splits. */
	let pausedAtBoundary = 0;
	let km = 0;
	let capped = false;

	/**
	 * Closes the window ending at `t` and moves the boundary on: the wall clock
	 * since the last boundary, less however much of it went by at a standstill.
	 * `splitS + pausedS` is that wall clock exactly, by construction.
	 */
	const closeWindow = (t: number): { splitS: number; pausedS: number } => {
		const wallS = Math.max(0, t - previousBoundaryT);
		const pausedS = Math.min(wallS, pausedSecondsBefore(spans, t) - pausedAtBoundary);
		previousBoundaryT = t;
		pausedAtBoundary += pausedS;
		return { splitS: wallS - pausedS, pausedS };
	};

	/** The leftover metres, whether the series ran out or the cap did. */
	const pushPartial = (t: number, leftover: number): void => {
		if (!(leftover >= 1)) return;
		const { splitS, pausedS } = closeWindow(t);
		splits.push({
			km: km + 1,
			t,
			elapsedS: t - startSeconds,
			splitS,
			distanceM: Math.round(leftover),
			paceSPerKm: Math.round(splitS / (leftover / 1000)),
			...(pausedS > 0 ? { pausedS } : {}),
			partial: true,
		});
	};

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i];
		const dt = i > 0 ? sample.t - samples[i - 1].t : 0;
		const slow = dt > 0 && (sample.qty * 1000) / dt < PAUSE_SPEED_MS;

		const before = cumulative;
		cumulative += sample.qty * 1000;
		const covered = cumulative - before;

		// A sample the runner stood still through only moves for its last step, so
		// that tail is what a crossing inside it is interpolated over. Never more
		// than the sample's own interval, which is what keeps `t` from sliding back
		// behind the boundary before it.
		const from = slow ? sample.t - Math.min(step, dt) : previousT;
		const crossing = (at: number): number =>
			Math.round(from + (covered > 0 ? (at - before) / covered : 1) * (sample.t - from));

		while (cumulative >= (km + 1) * 1000 && (cap === null || (km + 1) * 1000 <= cap)) {
			km += 1;
			const t = crossing(km * 1000);
			const { splitS, pausedS } = closeWindow(t);
			splits.push({
				km,
				t,
				elapsedS: t - startSeconds,
				splitS,
				distanceM: 1000,
				paceSPerKm: splitS,
				...(pausedS > 0 ? { pausedS } : {}),
			});
		}

		if (cap !== null && cumulative >= cap) {
			pushPartial(crossing(cap), cap - km * 1000);
			capped = true;
			break;
		}

		previousT = sample.t;
	}

	if (!capped) pushPartial(previousT, cumulative - km * 1000);

	return splits;
}

/**
 * `activeEnergyBurned` is kilojoules and `maxSpeed` is km/h — the latter
 * labelled `"km"`, which is why the units string plays no part. The route's own
 * per-point speeds are m/s and peak within a rounding error of `maxSpeed / 3.6`
 * on the captured runs, which is what pins the unit down.
 */
function workoutMetrics(workout: Row): RunMetrics | null {
	const maxSpeedKmh = qty(workout.maxSpeed);
	const metrics: RunMetrics = {
		energyKj: round(qty(workout.activeEnergyBurned), 2),
		maxSpeedMs: maxSpeedKmh === null ? null : (round(maxSpeedKmh / 3.6, 2) as number),
	};
	return metrics.energyKj === null && metrics.maxSpeedMs === null ? null : metrics;
}

function appleWeather(workout: Row): RunWeather | null {
	const tempC = round(qty(workout.temperature), 2);
	const humidityPct = round(qty(workout.humidity), 1);
	if (tempC === null && humidityPct === null) return null;
	return { tempC, humidityPct, source: "apple" };
}

function parseWorkout(workout: Row, extraRunFragments: readonly string[]): ParsedWorkout | SkippedWorkout {
	// Read before the gates rather than inside them: every skip carries what the
	// workout was called and when it happened, so the Sync tab can list it.
	const name = typeof workout.name === "string" ? workout.name.trim() : "";
	const start = parseHaeTimestamp(workout.start);
	const skip = (externalId: string | null, reason: string): SkippedWorkout => ({
		externalId,
		reason,
		name: name || null,
		localDate: start ? localParts(start.at, start.offsetMinutes).date : null,
	});

	const externalId = typeof workout.id === "string" && workout.id.trim() ? workout.id.trim() : null;
	if (!externalId) return skip(null, "missing workout id");

	// Type first, because the data gate below cannot do this job: a walk records
	// a route and a walkingAndRunningDistance series exactly like a run does.
	// No name means no way to tell, so it is skipped rather than guessed at.
	if (!name) return skip(externalId, "unnamed workout — cannot verify it is a run");
	if (!isRunName(name, extraRunFragments)) return skip(externalId, `workout type "${name}" is not a run`);

	if (!start) return skip(externalId, "unreadable start time");
	const end = parseHaeTimestamp(workout.end);

	const routeRows = rows(workout.route);
	const distanceRows = rows(workout.walkingAndRunningDistance);
	// Second gate: a run the watch recorded nothing for is still nothing to store.
	if (routeRows.length === 0 && distanceRows.length === 0) {
		return skip(externalId, "no route or running distance — not a run");
	}

	const startSeconds = Math.round(start.at.getTime() / MS);
	const { points, first } = parseRoute(workout.route);

	// `distance` is kilometres, and it is the *workout's* — the sample series is
	// the health store's and can outrun it, so this is also what caps the splits.
	// They are in turn the fallback for it, on a workout that states no distance.
	const distanceKm = qty(workout.distance);
	const officialDistanceM = distanceKm === null ? null : (round(distanceKm * 1000, 2) as number);
	const splits = deriveSplits(workout.walkingAndRunningDistance, startSeconds, officialDistanceM);

	const distanceM = officialDistanceM ?? splits.reduce((total, split) => total + split.distanceM, 0);
	if (!(distanceM > 0)) return skip(externalId, "no distance recorded");

	const durationS =
		num(workout.duration) ?? (end ? (end.at.getTime() - start.at.getTime()) / MS : null) ?? splits.at(-1)?.elapsedS ?? 0;
	if (!(durationS > 0)) return skip(externalId, "no duration recorded");

	const heartRate = isRow(workout.heartRate) ? workout.heartRate : {};
	const { date: localDate, time: localTime } = localParts(start.at, start.offsetMinutes);

	return {
		externalId,
		name,
		isIndoor: workout.isIndoor === true,
		startedAt: start.at,
		endedAt: end?.at ?? null,
		timezone: start.offset,
		localDate,
		localTime,
		distanceM,
		durationS,
		avgHr: qty(heartRate.avg) ?? qty(workout.avgHeartRate),
		maxHr: qty(heartRate.max) ?? qty(workout.maxHeartRate),
		avgCadence: round(qty(workout.stepCadence), 2),
		elevationGainM: round(qty(workout.elevationUp), 2),
		weather: appleWeather(workout),
		metrics: workoutMetrics(workout),
		firstPoint: first,
		streams: {
			route: points,
			heart_rate: parseHeartRate(workout.heartRateData),
			cadence: deriveCadence(workout.stepCount, startSeconds),
			splits,
			hr_recovery: parseHeartRate(workout.heartRateRecovery),
		},
	};
}

export function parseHaePayload(raw: unknown, options: ParseOptions = {}): ParsedPayload {
	const envelope = isRow(raw) && isRow(raw.data) ? raw.data : null;
	const list = envelope ? rows(envelope.workouts) : [];
	const extraRunFragments = options.extraRunFragments ?? [];

	const workouts: ParsedWorkout[] = [];
	const skipped: SkippedWorkout[] = [];

	for (const entry of list) {
		const parsed = parseWorkout(entry, extraRunFragments);
		if ("reason" in parsed) skipped.push(parsed);
		else workouts.push(parsed);
	}

	return { workouts, skipped };
}

/**
 * The columns a watch workout owns, shared by the insert of a new run and the
 * in-place upgrade of a manual one — so a reconciled run ends up carrying
 * exactly what a freshly synced one would, minus the effort and notes its
 * owner typed.
 */
export function workoutRunFields(workout: ParsedWorkout) {
	return {
		source: "apple_health" as const,
		externalId: workout.externalId,
		startedAt: workout.startedAt,
		timezone: workout.timezone,
		distanceM: workout.distanceM,
		durationS: Math.round(workout.durationS),
		avgHr: workout.avgHr === null ? null : Math.round(workout.avgHr),
		maxHr: workout.maxHr === null ? null : Math.round(workout.maxHr),
		avgCadence: workout.avgCadence,
		elevationGainM: workout.elevationGainM,
		metrics: workout.metrics,
	};
}

/** Non-empty streams only — an indoor run has no route to store. */
export function workoutStreamRows(workout: ParsedWorkout): { kind: keyof ParsedStreams; data: unknown }[] {
	return (Object.keys(workout.streams) as (keyof ParsedStreams)[])
		.filter((kind) => workout.streams[kind].length > 0)
		.map((kind) => ({ kind, data: workout.streams[kind] }));
}
