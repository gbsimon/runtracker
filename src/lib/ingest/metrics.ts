/**
 * Health Auto Export's *Health Metrics* payload → `daily_metrics` rows. Pure:
 * no database, no network, no clock.
 *
 * This is the second automation on the phone, aggregated daily, posting to the
 * same endpoint as the workouts. Its envelope is `{data: {metrics: [...]}}`
 * where the workouts one is `{data: {workouts: [...]}}`, which is the only
 * thing that tells the two apart. See the "Health Metrics payload" section of
 * `tasks/hae-schema.md` for the verified shape.
 *
 * Names are the contract, values are SI-ish already, and units strings are as
 * untrustworthy here as they are on workouts — a metric's unit is implied by
 * its `kind` and documented in `src/lib/daily-metrics.ts`, never read off the
 * payload.
 */

import { parseHaeTimestamp } from "./hae";

/** Metrics that reduce to a single number — stored as `{qty}`. */
export const QUANTITY_METRICS = ["vo2_max", "resting_heart_rate", "heart_rate_variability"] as const;

export const SLEEP_METRIC = "sleep_analysis";

export type QuantityMetric = (typeof QUANTITY_METRICS)[number];

export type QuantityValue = { qty: number };

/**
 * Hours per stage, plus when the night started and ended. `inBed`/`asleep`
 * arrive as 0 from this HAE version — a quirk, not a night without sleep — so
 * they are dropped rather than stored as a lie; `totalSleep` and the stages
 * carry the night.
 */
export type SleepValue = {
	totalSleep: number | null;
	rem: number | null;
	core: number | null;
	deep: number | null;
	awake: number | null;
	/** `2026-08-16T23:19:33-04:00` — the runner's own clock, offset kept. */
	sleepStart: string | null;
	sleepEnd: string | null;
};

export type MetricValue = QuantityValue | SleepValue | Record<string, number | string>;

export type DailyMetricEntry = {
	/** Local calendar day, `YYYY-MM-DD`. */
	day: string;
	/** The metric's own name — modelled or not. */
	kind: string;
	value: MetricValue;
};

export type ParsedMetricsPayload = {
	entries: DailyMetricEntry[];
	/** kind → number of days carried, which is what the event summary reports. */
	days: Record<string, number>;
	/** Metric names this parser doesn't model; stored verbatim, listed here so a new one is visible. */
	unknown: string[];
	skipped: { kind: string; reason: string; count: number }[];
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

function round(value: number | null, digits: number): number | null {
	if (value === null) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/** Does this payload carry daily metrics? Both branches can be true at once. */
export function hasMetrics(raw: unknown): boolean {
	if (!isRow(raw) || !isRow(raw.data)) return false;
	return Array.isArray(raw.data.metrics) && raw.data.metrics.length > 0;
}

/** `2026-08-11 00:00:00 -0400` → `2026-08-11`, the day in the runner's own zone. */
function localDay(value: unknown): string | null {
	const parsed = parseHaeTimestamp(value);
	if (!parsed) return null;
	return new Date(parsed.at.getTime() + parsed.offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Keeps the instant *and* the wall clock: `23:19` the night before and `00:37`
 * the same night read very differently to a coach, and a plain UTC instant
 * would hide which one it was.
 */
function localTimestamp(value: unknown): string | null {
	const parsed = parseHaeTimestamp(value);
	if (!parsed) return null;
	const wallClock = new Date(parsed.at.getTime() + parsed.offsetMinutes * 60_000).toISOString().slice(0, 19);
	return `${wallClock}${parsed.offset}`;
}

function quantityValue(entry: Row): QuantityValue | null {
	const qty = round(num(entry.qty), 2);
	return qty === null ? null : { qty };
}

function sleepValue(entry: Row): SleepValue | null {
	const value: SleepValue = {
		totalSleep: round(num(entry.totalSleep), 2),
		rem: round(num(entry.rem), 2),
		core: round(num(entry.core), 2),
		deep: round(num(entry.deep), 2),
		awake: round(num(entry.awake), 2),
		sleepStart: localTimestamp(entry.sleepStart),
		sleepEnd: localTimestamp(entry.sleepEnd),
	};
	return value.totalSleep === null && value.rem === null && value.core === null && value.deep === null ? null : value;
}

/**
 * A metric name we haven't modelled. Storing it verbatim costs one row and
 * means turning a new one on in the phone app never loses a day of history
 * while the parser catches up — `date` and the localized `source` are the only
 * fields dropped.
 */
function passthroughValue(entry: Row): Record<string, number | string> | null {
	const qty = num(entry.qty);
	if (qty !== null) return { qty: round(qty, 3) as number };

	const value: Record<string, number | string> = {};
	for (const [key, raw] of Object.entries(entry)) {
		if (key === "date" || key === "source") continue;
		const amount = num(raw);
		if (amount !== null) value[key] = round(amount, 3) as number;
		else if (typeof raw === "string" && raw.length <= 120) value[key] = raw;
	}
	return Object.keys(value).length > 0 ? value : null;
}

export function parseHaeMetricsPayload(raw: unknown): ParsedMetricsPayload {
	const envelope = isRow(raw) && isRow(raw.data) ? raw.data : null;
	const metrics = envelope ? rows(envelope.metrics) : [];

	// Last write wins inside one payload: HAE has no reason to send a day twice,
	// and if it does, the later entry is the fresher reading.
	const byKey = new Map<string, DailyMetricEntry>();
	const unknown = new Set<string>();
	const skipped = new Map<string, { kind: string; reason: string; count: number }>();

	const skip = (kind: string, reason: string) => {
		const key = `${kind}|${reason}`;
		const existing = skipped.get(key);
		if (existing) existing.count += 1;
		else skipped.set(key, { kind, reason, count: 1 });
	};

	for (const metric of metrics) {
		const kind = typeof metric.name === "string" ? metric.name.trim() : "";
		if (!kind) {
			skip("<unnamed>", "metric has no name");
			continue;
		}

		const known = kind === SLEEP_METRIC || (QUANTITY_METRICS as readonly string[]).includes(kind);
		if (!known) unknown.add(kind);

		for (const entry of rows(metric.data)) {
			const day = localDay(entry.date);
			if (!day) {
				skip(kind, "unreadable date");
				continue;
			}

			const value =
				kind === SLEEP_METRIC ? sleepValue(entry) : known ? quantityValue(entry) : passthroughValue(entry);
			if (!value) {
				skip(kind, "no usable value");
				continue;
			}

			byKey.set(`${day}|${kind}`, { day, kind, value });
		}
	}

	const entries = [...byKey.values()].sort((a, b) => (a.kind === b.kind ? a.day.localeCompare(b.day) : a.kind.localeCompare(b.kind)));

	const days: Record<string, number> = {};
	for (const entry of entries) days[entry.kind] = (days[entry.kind] ?? 0) + 1;

	return { entries, days, unknown: [...unknown].sort(), skipped: [...skipped.values()] };
}
