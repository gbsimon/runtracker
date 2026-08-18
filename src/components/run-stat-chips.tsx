import type { RunRecord } from "@/lib/runs";
import { readWeather } from "@/lib/weather";

/**
 * The line of physiology a synced run carries and a hand-logged one doesn't —
 * shared by the Log history and the Plan page's logged line so the two never
 * drift apart.
 *
 * A manual run renders nothing at all. In a 62-row list, an "—" where the heart
 * rate would be is noise: the absence is already the signal, and the run detail
 * page is where the missing data gets explained.
 */

export function RunStatChips({
	run,
	className = "",
}: {
	run: Pick<RunRecord, "avgHr" | "avgCadence" | "elevationGainM" | "weather">;
	className?: string;
}) {
	const weather = readWeather(run.weather);
	// Humidity and wind belong on the detail page; a list row gets the two
	// things that change how a run felt.
	const showWeather = weather !== null && (weather.tempC !== null || weather.condition !== null);

	if (run.avgHr === null && run.avgCadence === null && run.elevationGainM === null && !showWeather) return null;

	return (
		<div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-gray-500 ${className}`}>
			{run.avgHr !== null ? (
				<span title="Average heart rate">
					<span className="text-rose-400/70" aria-hidden="true">
						♥
					</span>{" "}
					{run.avgHr}
				</span>
			) : null}

			{run.elevationGainM !== null ? (
				<span title="Elevation gain">
					<span className="text-emerald-400/70" aria-hidden="true">
						↗
					</span>{" "}
					{Math.round(run.elevationGainM)} m
				</span>
			) : null}

			{run.avgCadence !== null ? <span title="Average cadence">{Math.round(run.avgCadence)} spm</span> : null}

			{showWeather ? (
				<span title={weather.condition?.label ?? "Weather"}>
					{weather.condition ? <span aria-hidden="true">{weather.condition.emoji} </span> : null}
					{weather.tempC !== null ? `${Math.round(weather.tempC)}°C` : weather.condition?.label}
				</span>
			) : null}
		</div>
	);
}
