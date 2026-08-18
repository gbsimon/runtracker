import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunMap } from "@/components/run-map";
import { SplitsTable } from "@/components/splits-table";
import { StreamChart } from "@/components/stream-chart";
import { loadRunDetail, type RunDetail, type WeatherDisplay } from "@/lib/run-detail";
import { runDistanceKm, runLocalDateISO, runLocalTime } from "@/lib/runs";
import { formatDuration, formatElapsed, formatFullDate, formatKm, formatWeekdayLong } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";

/**
 * One run, in full: where it went, what the heart did, how the kilometres
 * compared. Every series is loaded and reduced on the server (`run-detail.ts`)
 * — the browser only ever receives what it can draw.
 *
 * Deliberately no `loading.tsx`: it would put the route behind a Suspense
 * boundary, and the 200 for the streamed shell goes out before `notFound()`
 * below can run — someone else's run URL would answer OK with a "not found"
 * body. Assembling even the 6,315-point run takes well under a tenth of a
 * second, so there is nothing a skeleton would usefully cover.
 */

const SOURCE_LABELS: Record<string, string> = { manual: "Manual", apple_health: "Apple Health" };

const CHART_COLORS = { elevation: "#a78bfa", heartRate: "#f87171", cadence: "#38bdf8" };

/** Thousands separator, locale pinned so the server's HTML and the tab agree. */
const COUNT_FORMAT = new Intl.NumberFormat("en-GB");

function formatCount(value: number): string {
	return COUNT_FORMAT.format(value);
}

/** `loadRunDetail` is `cache`d, so the page below reuses this read. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
	const [{ id }, user, zone] = await Promise.all([params, requireUser(), userTimeZone()]);
	const detail = await loadRunDetail(user.id, id);
	if (!detail) return { title: "Run · RunTracker" };
	return {
		title: `${formatKm(runDistanceKm(detail.run))} km · ${formatFullDate(runLocalDateISO(detail.run, zone))} · RunTracker`,
	};
}

function Stat({ label, value, hint, title }: { label: string; value: string; hint?: string; title?: string }) {
	return (
		<div title={title}>
			<dt className="text-[10px] uppercase tracking-wide text-gray-600">{label}</dt>
			<dd className="text-sm font-semibold tabular-nums text-gray-200">
				{value}
				{hint ? <span className="ml-1 text-xs font-normal text-gray-500">{hint}</span> : null}
			</dd>
		</div>
	);
}

/** The whole decay curve, for the hover — the grid only has room for one number. */
function recoveryDetail(recovery: NonNullable<RunDetail["hrRecovery"]>): string {
	const marks = [`${recovery.bpmAt60} bpm at 60s`];
	if (recovery.bpmAt120 !== null) marks.push(`${recovery.bpmAt120} at 120s`);
	return `Peaked at ${recovery.peakBpm} bpm after the finish, then ${marks.join(", ")}`;
}

function Hero({ label, value, unit }: { label: string; value: string; unit?: string }) {
	return (
		<div>
			<p className="text-[10px] uppercase tracking-wide text-gray-600">{label}</p>
			<p className="text-xl font-extrabold tabular-nums leading-tight text-white sm:text-2xl">
				{value}
				{unit ? <span className="ml-0.5 text-xs font-semibold text-gray-500">{unit}</span> : null}
			</p>
		</div>
	);
}

function WeatherLine({ weather }: { weather: WeatherDisplay }) {
	const parts: string[] = [];
	if (weather.tempC !== null) parts.push(`${weather.tempC.toFixed(1)}°C`);
	if (weather.humidityPct !== null) parts.push(`${Math.round(weather.humidityPct)}% humidity`);
	if (weather.windKmh !== null) parts.push(`${weather.windKmh.toFixed(1)} km/h wind`);
	if (weather.precipMm !== null && weather.precipMm > 0) parts.push(`${weather.precipMm.toFixed(1)} mm rain`);

	return (
		<p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/5 pt-3 text-xs text-gray-400">
			{weather.condition ? (
				<span className="font-medium text-gray-300">
					<span aria-hidden="true">{weather.condition.emoji}</span> {weather.condition.label}
				</span>
			) : null}
			{parts.map((part) => (
				<span key={part} className="tabular-nums">
					{part}
				</span>
			))}
		</p>
	);
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const [{ id }, user, zone] = await Promise.all([params, requireUser(), userTimeZone()]);
	const detail = await loadRunDetail(user.id, id);
	if (!detail) notFound();

	const { run, stats, route, elevation, heartRate, cadence, splits, weather, energyKcal, hrRecovery } = detail;
	const dateISO = runLocalDateISO(run, zone);
	const isSynced = run.source !== "manual";

	return (
		<section className="fade-in space-y-4">
			<Link href="/log" className="inline-flex items-center gap-1.5 text-xs text-gray-500 transition hover:text-gray-300">
				<span aria-hidden="true">←</span> Back to log
			</Link>

			<header className="card p-5">
				<div className="mb-4 flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 className="text-base font-bold text-white">
							{formatWeekdayLong(dateISO)}, {formatFullDate(dateISO)}
						</h2>
						<p className="text-xs text-gray-500">Started {runLocalTime(run, zone)}</p>
					</div>
					<span
						className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
							isSynced ? "border-brand-500/30 bg-brand-600/15 text-brand-300" : "border-white/10 bg-white/5 text-gray-500"
						}`}
					>
						{SOURCE_LABELS[run.source] ?? run.source}
					</span>
				</div>

				<div className="grid grid-cols-3 gap-3 border-b border-white/5 pb-4">
					<Hero label="Distance" value={formatKm(stats.distanceKm)} unit="km" />
					<Hero label="Duration" value={formatElapsed(stats.durationS)} />
					<Hero label="Pace" value={stats.paceSPerKm ? formatDuration(stats.paceSPerKm) : "–"} unit="/km" />
				</div>

				<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
					{stats.avgHr !== null ? (
						<Stat label="Avg HR" value={`${stats.avgHr}`} hint={stats.maxHr !== null ? `max ${stats.maxHr}` : undefined} />
					) : null}
					{hrRecovery !== null && hrRecovery.drop60 !== null ? (
						<Stat label="HR recovery" value={`−${hrRecovery.drop60} bpm`} hint="in 60s" title={recoveryDetail(hrRecovery)} />
					) : null}
					{stats.avgCadence !== null ? <Stat label="Cadence" value={`${Math.round(stats.avgCadence)}`} hint="spm" /> : null}
					{energyKcal !== null ? <Stat label="Energy" value={formatCount(energyKcal)} hint="kcal" /> : null}
					{stats.elevation.gainM !== null ? (
						<Stat
							label="Elevation"
							value={`+${Math.round(stats.elevation.gainM)} m`}
							hint={
								stats.elevation.minM !== null && stats.elevation.maxM !== null
									? `${Math.round(stats.elevation.minM)}–${Math.round(stats.elevation.maxM)} m`
									: undefined
							}
						/>
					) : null}
					{stats.splits.fastest ? (
						<Stat
							label="Fastest km"
							value={`${formatDuration(stats.splits.fastest.paceSPerKm)}`}
							hint={`km ${stats.splits.fastest.km}`}
						/>
					) : null}
					{run.effort ? <Stat label="Effort" value={`${run.effort}/10`} /> : null}
					{stats.splits.negativeSplit !== null ? (
						<Stat label="Second half" value={stats.splits.negativeSplit ? "Faster" : "Slower"} />
					) : null}
				</dl>

				{weather ? <WeatherLine weather={weather} /> : null}
			</header>

			{route ? <RunMap route={route} /> : null}

			{elevation ? (
				<StreamChart
					title="Elevation"
					series={elevation}
					color={CHART_COLORS.elevation}
					valueFormat="metres"
					axisFormat="km"
					summary={`${Math.round(elevation.min)}–${Math.round(elevation.max)} m${
						stats.elevation.gainM !== null ? ` • +${Math.round(stats.elevation.gainM)} m climbed` : ""
					}`}
				/>
			) : null}

			{heartRate ? (
				<StreamChart
					title="Heart rate"
					series={heartRate}
					color={CHART_COLORS.heartRate}
					valueFormat="bpm"
					axisFormat="elapsed"
					markers={[
						{ y: heartRate.avg, label: `avg ${Math.round(heartRate.avg)}` },
						{ y: heartRate.max, label: `max ${Math.round(heartRate.max)}` },
					]}
					summary={`avg ${Math.round(heartRate.avg)} • max ${Math.round(heartRate.max)} bpm`}
				/>
			) : null}

			{cadence ? (
				<StreamChart
					title="Cadence"
					series={cadence}
					color={CHART_COLORS.cadence}
					valueFormat="spm"
					axisFormat="elapsed"
					markers={[{ y: cadence.avg, label: `avg ${Math.round(cadence.avg)}` }]}
					summary={`avg ${Math.round(cadence.avg)} spm`}
				/>
			) : null}

			<SplitsTable splits={splits} stats={stats.splits} />

			{run.notes ? (
				<div className="card p-5">
					<h3 className="mb-2 text-sm font-bold text-gray-300">Notes</h3>
					<p className="whitespace-pre-wrap text-sm text-gray-400">{run.notes}</p>
				</div>
			) : null}

			{detail.hasStreams ? null : (
				<div className="card p-5 text-center">
					<p className="text-sm text-gray-400">
						{isSynced
							? "This run synced without its detailed streams."
							: "This run was logged by hand, so there is no route or heart rate to show."}
					</p>
					<Link
						href="/settings"
						className="mt-2 inline-block text-sm font-semibold text-brand-400 transition hover:text-brand-300"
					>
						Sync from Apple Health to see maps and heart rate →
					</Link>
				</div>
			)}
		</section>
	);
}
