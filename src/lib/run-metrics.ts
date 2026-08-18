/**
 * `runs.metrics` — the watch measurements that ride in one jsonb rather than a
 * column each. Pure: a shape, a reader for the stored value and the merge the
 * enrichment pass uses.
 *
 * Everything here is SI, whatever the payload said. Health Auto Export reports
 * energy in kilojoules and speeds in km/h while labelling them `"km"`, so the
 * conversion happens once, at parse time, and nothing downstream has to ask
 * which unit it is holding.
 */

export type RunMetrics = {
	/** Active energy burned during the workout, kilojoules (÷ 4.184 for kcal). */
	energyKj: number | null;
	/** Fastest instantaneous speed the watch recorded, metres per second. */
	maxSpeedMs: number | null;
};

export const RUN_METRIC_KEYS = ["energyKj", "maxSpeedMs"] as const;

const KJ_PER_KCAL = 4.184;

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `null` when the stored jsonb holds nothing usable, so an empty object never reads as data. */
export function readRunMetrics(raw: unknown): RunMetrics | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const stored = raw as Partial<RunMetrics>;

	const metrics: RunMetrics = {
		energyKj: finiteOrNull(stored.energyKj),
		maxSpeedMs: finiteOrNull(stored.maxSpeedMs),
	};
	return RUN_METRIC_KEYS.some((key) => metrics[key] !== null) ? metrics : null;
}

/**
 * Fills the gaps in what is already stored, and only the gaps: a value the
 * database holds wins over a value re-derived from the raw payload, so
 * replaying an event can add a field but never rewrite one.
 */
export function mergeRunMetrics(existing: unknown, incoming: RunMetrics | null): { metrics: RunMetrics | null; added: (keyof RunMetrics)[] } {
	const current = readRunMetrics(existing);
	if (!incoming) return { metrics: current, added: [] };

	const merged: RunMetrics = { energyKj: current?.energyKj ?? null, maxSpeedMs: current?.maxSpeedMs ?? null };
	const added: (keyof RunMetrics)[] = [];

	for (const key of RUN_METRIC_KEYS) {
		if (merged[key] === null && incoming[key] !== null) {
			merged[key] = incoming[key];
			added.push(key);
		}
	}

	return { metrics: readRunMetrics(merged), added };
}

export function energyKcal(metrics: RunMetrics | null): number | null {
	return metrics?.energyKj === null || metrics === null ? null : Math.round(metrics.energyKj / KJ_PER_KCAL);
}

/** Max speed as a pace, seconds per kilometre — how a runner reads it. */
export function maxSpeedPaceSPerKm(metrics: RunMetrics | null): number | null {
	const speed = metrics?.maxSpeedMs ?? null;
	if (speed === null || speed <= 0) return null;
	return Math.round(1000 / speed);
}
