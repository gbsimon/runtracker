import { type DailyMetricsDay, type DailyMetricsView, formatHours } from "@/lib/daily-metrics";
import { addDaysISO, daysBetweenISO, formatMonthDay } from "@/lib/running";

/**
 * The recovery half of the picture, on the page where the training half already
 * lives: how the runner has been sleeping and what the heart has been doing
 * between runs.
 *
 * Three numbers each — the latest reading, a seven-day mean, and the shape of
 * the fortnight — because a resting heart rate only means something next to the
 * one before it. Absent days are the normal case (the watch comes off, the
 * phone doesn't sync), so nothing here interpolates: a day without a reading is
 * a gap in the line, and every average states how many readings it is made of.
 *
 * Server-rendered and dependency-free, like the app's other charts.
 */

const WINDOW_DAYS = 14;
const AVERAGE_DAYS = 7;

/** The sparkline's own pixel grid — small and fixed, so the dots stay round. */
const SPARK_W = 96;
const SPARK_H = 22;
const SPARK_PAD = 3;

type Reading = { day: string; value: number };

type MetricSpec = {
	label: string;
	color: string;
	pick: (day: DailyMetricsDay) => number | null;
	format: (value: number) => string;
};

const METRICS: MetricSpec[] = [
	{
		label: "Resting HR",
		color: "#f87171",
		pick: (day) => day.restingHrBpm,
		format: (value) => `${Math.round(value)} bpm`,
	},
	{
		label: "HRV",
		color: "#38bdf8",
		pick: (day) => day.hrvMs,
		format: (value) => `${Math.round(value)} ms`,
	},
	{
		label: "Sleep",
		color: "#a78bfa",
		pick: (day) => day.sleep?.totalSleep ?? null,
		format: (value) => formatHours(value) ?? "–",
	},
];

function mean(values: number[]): number | null {
	return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

type Plotted = { x: number; y: number; day: string };

/**
 * The fortnight in a hundred pixels.
 *
 * Two rules keep it honest. The x axis is the whole window, not just the days
 * that reported, so a line hugging the right-hand side is visibly "nothing
 * before Wednesday" rather than a fortnight of data — the track behind it is
 * what makes that legible. And the line breaks wherever a day is missing
 * instead of running straight through it, because a stroke across the gap is
 * an interpolation, and a night the watch was off is not a measurement.
 */
function Sparkline({ readings, window, color }: { readings: Reading[]; window: { from: string; span: number }; color: string }) {
	if (readings.length === 0) return null;

	const values = readings.map((reading) => reading.value);
	const low = Math.min(...values);
	const high = Math.max(...values);
	// A fortnight of identical readings still has to draw somewhere; the middle
	// is the only honest place for it.
	const range = high - low;

	const points: Plotted[] = readings.map((reading) => {
		const offset = Math.min(window.span - 1, Math.max(0, daysBetweenISO(window.from, reading.day)));
		return {
			x: SPARK_PAD + (offset / (window.span - 1)) * (SPARK_W - 2 * SPARK_PAD),
			y: range === 0 ? SPARK_H / 2 : SPARK_H - SPARK_PAD - ((reading.value - low) / range) * (SPARK_H - 2 * SPARK_PAD),
			day: reading.day,
		};
	});

	const segments: Plotted[][] = [];
	for (const point of points) {
		const current = segments[segments.length - 1];
		const previous = current?.[current.length - 1];
		if (previous && daysBetweenISO(previous.day, point.day) === 1) current.push(point);
		else segments.push([point]);
	}

	const last = points[points.length - 1];
	return (
		<svg
			viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
			width={SPARK_W}
			height={SPARK_H}
			className="shrink-0"
			role="presentation"
			aria-hidden="true"
		>
			<rect x="0" y="0" width={SPARK_W} height={SPARK_H} rx="3" fill="#ffffff" fillOpacity="0.03" />
			{segments.map((segment) =>
				segment.length > 1 ? (
					<polyline
						key={segment[0].day}
						points={segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
						fill="none"
						stroke={color}
						strokeOpacity="0.7"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				) : (
					// A day on its own either side of a gap would draw nothing at all.
					<circle key={segment[0].day} cx={segment[0].x.toFixed(1)} cy={segment[0].y.toFixed(1)} r="1.4" fill={color} fillOpacity="0.7" />
				),
			)}
			<circle cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="2" fill={color} />
		</svg>
	);
}

export function RecoveryPanel({ metrics }: { metrics: DailyMetricsView }) {
	// `to` is the newest day with any reading rather than today: a phone that has
	// been offline since Tuesday should show Tuesday's fortnight, not an empty one.
	const to = metrics.to;
	if (!to || metrics.days.length === 0) return null;

	const windowFrom = addDaysISO(to, -(WINDOW_DAYS - 1));
	const averageFrom = addDaysISO(to, -(AVERAGE_DAYS - 1));
	const inWindow = metrics.days.filter((day) => day.day >= windowFrom);

	const rows = METRICS.map((metric) => {
		const readings: Reading[] = [];
		for (const day of inWindow) {
			const value = metric.pick(day);
			if (value !== null) readings.push({ day: day.day, value });
		}

		const latest = readings[readings.length - 1] ?? null;
		const recent = readings.filter((reading) => reading.day >= averageFrom);
		const average = mean(recent.map((reading) => reading.value));
		return { metric, readings, latest, average, sampleCount: recent.length };
	}).filter((row) => row.latest !== null);

	if (rows.length === 0) return null;

	const vo2 = metrics.latest.vo2Max;

	return (
		<div className="card p-5">
			<div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="text-sm font-bold text-gray-300">Recovery</h3>
				<p className="text-[11px] text-gray-600">
					last {WINDOW_DAYS} days · {formatMonthDay(windowFrom)} – {formatMonthDay(to)}
				</p>
			</div>

			<ul className="divide-y divide-white/5">
				{rows.map(({ metric, readings, latest, average, sampleCount }) => (
					<li key={metric.label} className="flex items-center gap-3 py-2.5">
						<div className="min-w-0 flex-1">
							<p className="text-[11px] uppercase tracking-wide text-gray-600">{metric.label}</p>
							<p className="text-sm font-semibold tabular-nums text-gray-200">
								{metric.format((latest as Reading).value)}
								<span className="ml-1.5 text-[11px] font-normal text-gray-600">
									{formatMonthDay((latest as Reading).day)}
								</span>
							</p>
						</div>

						<Sparkline readings={readings} window={{ from: windowFrom, span: WINDOW_DAYS }} color={metric.color} />

						<p
							className="w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-gray-500"
							title={`Mean of ${sampleCount} reading${sampleCount === 1 ? "" : "s"} in the last ${AVERAGE_DAYS} days`}
						>
							{average === null ? "–" : `7d ${metric.format(average)}`}
						</p>
					</li>
				))}
			</ul>

			{vo2 ? (
				<p className="mt-2.5 border-t border-white/5 pt-2.5 text-[11px] text-gray-500">
					VO₂max <span className="font-semibold tabular-nums text-gray-300">{vo2.value.toFixed(1)}</span>{" "}
					<span className="text-gray-600">ml/kg/min · {formatMonthDay(vo2.day)}</span>
				</p>
			) : null}
		</div>
	);
}
