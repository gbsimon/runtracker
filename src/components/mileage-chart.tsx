import { type RunRecord, runDistanceKm, runLocalDateISO } from "@/lib/runs";
import { daysBetweenISO, planWeekOfISO, weekdaySunday0ISO } from "@/lib/running";

const MAX_BAR_PX = 160;
const MAX_BARS = 12;

/** v1's fallback bucket when there is no plan to count weeks from. */
function calendarWeekKey(iso: string): { key: string; week: number } {
	const year = iso.slice(0, 4);
	const jan1 = `${year}-01-01`;
	const week = Math.ceil((daysBetweenISO(jan1, iso) + weekdaySunday0ISO(jan1) + 1) / 7);
	return { key: `${year}-W${week}`, week };
}

export function MileageChart({
	runs,
	planStart,
	viewerZone,
}: {
	runs: RunRecord[];
	planStart?: string;
	viewerZone: string;
}) {
	const totals = new Map<string, { week: number; km: number }>();

	for (const run of runs) {
		const iso = runLocalDateISO(run, viewerZone);
		const planWeek = planStart ? planWeekOfISO(planStart, iso) : null;
		const { key, week } = planWeek !== null ? { key: `W${planWeek}`, week: planWeek } : calendarWeekKey(iso);
		const bucket = totals.get(key);
		totals.set(key, { week, km: (bucket?.km ?? 0) + runDistanceKm(run) });
	}

	const weeks = [...totals.entries()]
		.sort(([keyA, a], [keyB, b]) => (a.week !== b.week ? a.week - b.week : keyA.localeCompare(keyB)))
		.slice(-MAX_BARS);
	const maxKm = Math.max(...weeks.map(([, value]) => value.km), 0);

	return (
		<div className="card p-5">
			<h3 className="mb-3 text-sm font-bold text-gray-300">Weekly Mileage</h3>
			{weeks.length === 0 ? (
				<p className="py-4 text-center text-xs text-gray-400">Log some runs to see your weekly mileage</p>
			) : (
				<div className="flex items-end gap-1">
					{weeks.map(([key, value]) => (
						<div key={key} className="flex flex-1 flex-col items-center justify-end">
							<div className="mb-1 text-xs font-medium text-gray-400">{value.km.toFixed(1)}</div>
							<div
								title={`${value.km.toFixed(1)} km`}
								className="w-full rounded-t-md bg-brand-500/60 shadow-[0_0_8px_rgb(51_144_255_/_0.2)]"
								style={{ height: `${maxKm > 0 ? Math.max(3, Math.round((value.km / maxKm) * MAX_BAR_PX)) : 3}px` }}
							/>
							<div className="mt-1 text-xs text-gray-600">{key.includes("-") ? key.split("-")[1] : key}</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
