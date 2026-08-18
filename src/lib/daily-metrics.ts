/**
 * Daily recovery metrics — reading them back, and the one write the ingest
 * pipeline needs.
 *
 * `daily_metrics` is deliberately generic (one row per user/day/kind, value in
 * jsonb). This module is where that turns back into something a page or a
 * prompt can use: one entry per day with the four metrics we model beside each
 * other, units stated once, and nothing invented for the days the watch was
 * off. Gaps are real — a missing night is a night not measured, never a zero.
 *
 * `toDailyMetricsView` is pure and carries the whole mapping, so
 * `pnpm check:metrics` exercises it without a database.
 */

import { and, desc, eq, gte, lte, max, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { dailyMetrics } from "@/db/schema";
import type { DailyMetricEntry, SleepValue } from "./ingest/metrics";
import { addDaysISO } from "./running";

export type { SleepValue };

export const METRIC_UNITS = {
	restingHrBpm: "bpm",
	hrvMs: "ms (SDNN)",
	vo2Max: "ml/kg/min",
	sleep: "hours",
} as const;

/** Everything known about one calendar day. Any field may be `null`. */
export type DailyMetricsDay = {
	day: string;
	restingHrBpm: number | null;
	hrvMs: number | null;
	vo2Max: number | null;
	sleep: SleepValue | null;
};

export type LatestMetric<T> = { day: string; value: T } | null;

export type DailyMetricsView = {
	/** The window actually covered, `null` when the user has no metrics at all. */
	from: string | null;
	to: string | null;
	/** Ascending by day; days with nothing recorded are absent, not blank. */
	days: DailyMetricsDay[];
	/** Most recent reading per metric, each with the day it came from. */
	latest: {
		restingHrBpm: LatestMetric<number>;
		hrvMs: LatestMetric<number>;
		vo2Max: LatestMetric<number>;
		sleep: LatestMetric<SleepValue>;
	};
	/**
	 * Means over the days that carry each metric — the denominator is stated so
	 * a "7-day average" from three nights can't read as a full week.
	 */
	averages: {
		restingHrBpm: number | null;
		hrvMs: number | null;
		sleepHours: number | null;
		restingHrDays: number;
		hrvDays: number;
		sleepNights: number;
	};
	units: typeof METRIC_UNITS;
	/** Metric kinds stored but not modelled here, newest first. */
	other: { day: string; kind: string; value: unknown }[];
};

export type DailyMetricRow = { day: string; kind: string; value: unknown };

const DEFAULT_DAYS = 30;

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function qtyOf(value: unknown): number | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? numberOrNull((value as { qty?: unknown }).qty)
		: null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function sleepOf(value: unknown): SleepValue | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const stored = value as Partial<SleepValue>;
	const sleep: SleepValue = {
		totalSleep: numberOrNull(stored.totalSleep),
		rem: numberOrNull(stored.rem),
		core: numberOrNull(stored.core),
		deep: numberOrNull(stored.deep),
		awake: numberOrNull(stored.awake),
		sleepStart: stringOrNull(stored.sleepStart),
		sleepEnd: stringOrNull(stored.sleepEnd),
	};
	const empty = sleep.totalSleep === null && sleep.rem === null && sleep.core === null && sleep.deep === null;
	return empty ? null : sleep;
}

function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100;
}

function emptyDay(day: string): DailyMetricsDay {
	return { day, restingHrBpm: null, hrvMs: null, vo2Max: null, sleep: null };
}

/** Rows (any order) → the day-keyed view. Pure. */
export function toDailyMetricsView(rows: DailyMetricRow[]): DailyMetricsView {
	const byDay = new Map<string, DailyMetricsDay>();
	const other: { day: string; kind: string; value: unknown }[] = [];

	const dayOf = (day: string) => {
		const existing = byDay.get(day) ?? emptyDay(day);
		byDay.set(day, existing);
		return existing;
	};

	for (const row of rows) {
		switch (row.kind) {
			case "resting_heart_rate":
				dayOf(row.day).restingHrBpm = qtyOf(row.value);
				break;
			case "heart_rate_variability":
				dayOf(row.day).hrvMs = qtyOf(row.value);
				break;
			case "vo2_max":
				dayOf(row.day).vo2Max = qtyOf(row.value);
				break;
			case "sleep_analysis":
				dayOf(row.day).sleep = sleepOf(row.value);
				break;
			default:
				other.push({ day: row.day, kind: row.kind, value: row.value });
		}
	}

	const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
	other.sort((a, b) => b.day.localeCompare(a.day));

	const latestOf = <T>(pick: (day: DailyMetricsDay) => T | null): LatestMetric<T> => {
		for (let i = days.length - 1; i >= 0; i--) {
			const value = pick(days[i]);
			if (value !== null) return { day: days[i].day, value };
		}
		return null;
	};

	const restingHr = days.map((day) => day.restingHrBpm).filter((value): value is number => value !== null);
	const hrv = days.map((day) => day.hrvMs).filter((value): value is number => value !== null);
	const sleepHours = days
		.map((day) => day.sleep?.totalSleep ?? null)
		.filter((value): value is number => value !== null);

	return {
		from: days[0]?.day ?? null,
		to: days.at(-1)?.day ?? null,
		days,
		latest: {
			restingHrBpm: latestOf((day) => day.restingHrBpm),
			hrvMs: latestOf((day) => day.hrvMs),
			vo2Max: latestOf((day) => day.vo2Max),
			sleep: latestOf((day) => day.sleep),
		},
		averages: {
			restingHrBpm: mean(restingHr),
			hrvMs: mean(hrv),
			sleepHours: mean(sleepHours),
			restingHrDays: restingHr.length,
			hrvDays: hrv.length,
			sleepNights: sleepHours.length,
		},
		units: METRIC_UNITS,
		other,
	};
}

/**
 * The last `days` calendar days of metrics. The window ends on `endDay` when
 * the caller knows the runner's today, and otherwise on the newest day stored —
 * which keeps this readable without a timezone and means a phone that has been
 * offline for a week still returns its last week rather than nothing.
 */
export async function getDailyMetrics(
	userId: string,
	options: { days?: number; endDay?: string } = {},
): Promise<DailyMetricsView> {
	const span = Math.max(1, Math.floor(options.days ?? DEFAULT_DAYS));

	let to = options.endDay ?? null;
	if (!to) {
		const [row] = await getDb()
			.select({ day: max(dailyMetrics.day) })
			.from(dailyMetrics)
			.where(eq(dailyMetrics.userId, userId));
		to = row?.day ?? null;
	}
	if (!to) return toDailyMetricsView([]);

	const from = addDaysISO(to, -(span - 1));
	const rows = await getDb()
		.select({ day: dailyMetrics.day, kind: dailyMetrics.kind, value: dailyMetrics.value })
		.from(dailyMetrics)
		.where(and(eq(dailyMetrics.userId, userId), gte(dailyMetrics.day, from), lte(dailyMetrics.day, to)))
		.orderBy(desc(dailyMetrics.day));

	return toDailyMetricsView(rows);
}

/**
 * Idempotent by construction: the same export replayed rewrites the same day
 * with the same value, which is what lets the Reprocess button run twice.
 */
export async function upsertDailyMetrics(userId: string, entries: DailyMetricEntry[]): Promise<number> {
	if (entries.length === 0) return 0;

	const written = await getDb()
		.insert(dailyMetrics)
		.values(entries.map((entry) => ({ userId, day: entry.day, kind: entry.kind, value: entry.value })))
		.onConflictDoUpdate({
			// `excluded` is the row Postgres was about to insert.
			target: [dailyMetrics.userId, dailyMetrics.day, dailyMetrics.kind],
			set: { value: sql`excluded.value`, updatedAt: new Date() },
		})
		.returning({ day: dailyMetrics.day });

	return written.length;
}

/** `7.48` → `7h29`, the way a night's sleep reads on a watch. */
export function formatHours(hours: number | null): string | null {
	if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;
	const total = Math.round(hours * 60);
	return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}`;
}
