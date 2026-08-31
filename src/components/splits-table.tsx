import type { SplitRow, SplitStats } from "@/lib/run-detail";
import { formatDuration, formatElapsed } from "@/lib/running";

/**
 * Per-kilometre splits, with a bar scaled across the run's own range so the
 * shape of the effort — the fast first kilometre, the hill at nine — reads at a
 * glance instead of having to be decoded from the numbers.
 */

/** The slowest kilometre keeps a stub of a bar; the fastest fills the column. */
const MIN_BAR = 0.22;

function barWidth(paceSPerKm: number, fastest: number, slowest: number): number {
	if (slowest <= fastest) return 1;
	const share = (slowest - paceSPerKm) / (slowest - fastest);
	return MIN_BAR + (1 - MIN_BAR) * Math.min(1, Math.max(0, share));
}

function elevationLabel(delta: number | null): string {
	if (delta === null) return "–";
	const rounded = Math.round(delta);
	return rounded === 0 ? "0 m" : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} m`;
}

export function SplitsTable({ splits, stats }: { splits: SplitRow[]; stats: SplitStats }) {
	if (splits.length === 0) return null;

	const full = splits.filter((split) => split.partial !== true);
	const fastest = stats.fastest?.paceSPerKm ?? Math.min(...splits.map((split) => split.paceSPerKm));
	const slowest = stats.slowest?.paceSPerKm ?? Math.max(...splits.map((split) => split.paceSPerKm));
	const showHr = splits.some((split) => split.avgHr !== null);
	const showElevation = splits.some((split) => split.elevationDeltaM !== null);

	const footnotes: string[] = [];
	if (splits.some((split) => split.partial)) {
		footnotes.push("The last row is the leftover distance; its pace is scaled to a full kilometre.");
	}
	if (splits.some((split) => split.pausedS)) {
		footnotes.push("Paced on moving time — the watch's auto-pauses are noted and not counted.");
	}

	return (
		<div className="card p-4 sm:p-5">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="text-sm font-bold text-gray-300">Splits</h3>
				<p className="text-xs tabular-nums text-gray-400">
					{full.length} km
					{stats.fastest ? ` • fastest ${formatDuration(stats.fastest.paceSPerKm)}/km` : ""}
					{stats.spreadS !== null ? ` • spread ${formatDuration(stats.spreadS)}` : ""}
				</p>
			</div>

			<table className="w-full border-collapse text-xs tabular-nums">
				<thead>
					<tr className="text-[10px] uppercase tracking-wide text-gray-600">
						<th scope="col" className="w-8 pb-1.5 text-left font-medium">
							Km
						</th>
						<th scope="col" className="pb-1.5 text-left font-medium">
							Pace
						</th>
						{/* Cumulative time is the one column a phone can spare — hiding it
						    gives the pace bars room to actually say something. */}
						<th scope="col" className="hidden w-16 pb-1.5 text-right font-medium sm:table-cell">
							Elapsed
						</th>
						{showHr ? (
							<th scope="col" className="w-12 pb-1.5 text-right font-medium">
								BPM
							</th>
						) : null}
						{showElevation ? (
							<th scope="col" className="w-14 pb-1.5 text-right font-medium">
								Elev
							</th>
						) : null}
					</tr>
				</thead>
				<tbody>
					{splits.map((split) => {
						const isFastest = stats.fastest?.km === split.km;
						// One muted line under the pace, carrying whatever this row has to
						// qualify: a short final kilometre, time the watch spent paused.
						const notes: string[] = [];
						if (split.partial) notes.push(`final ${(split.distanceM / 1000).toFixed(2)} km in ${formatDuration(split.splitS)}`);
						if (split.pausedS) notes.push(`+${formatDuration(split.pausedS)} paused`);
						return (
							<tr key={split.km} className="border-t border-white/5">
								<th scope="row" className="py-1.5 text-left font-medium text-gray-400">
									{split.km}
								</th>
								<td className="py-1.5 pr-3">
									<div className="flex items-center gap-2">
										<span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/5">
											<span
												className={`block h-full rounded-full ${isFastest ? "bg-brand-400" : "bg-brand-500/45"}`}
												style={{ width: `${barWidth(split.paceSPerKm, fastest, slowest) * 100}%` }}
											/>
										</span>
										<span className={`w-10 shrink-0 text-right ${isFastest ? "font-semibold text-brand-300" : "text-gray-300"}`}>
											{formatDuration(split.paceSPerKm)}
										</span>
									</div>
									{notes.length > 0 ? <span className="text-[10px] text-gray-600">{notes.join(" • ")}</span> : null}
								</td>
								<td className="hidden py-1.5 text-right text-gray-500 sm:table-cell">{formatElapsed(split.elapsedS)}</td>
								{showHr ? <td className="py-1.5 text-right text-gray-400">{split.avgHr ?? "–"}</td> : null}
								{showElevation ? (
									<td className="py-1.5 text-right text-gray-500">{elevationLabel(split.elevationDeltaM)}</td>
								) : null}
							</tr>
						);
					})}
				</tbody>
			</table>

			{footnotes.length > 0 ? <p className="mt-2 text-[11px] text-gray-600">{footnotes.join(" ")}</p> : null}
		</div>
	);
}
