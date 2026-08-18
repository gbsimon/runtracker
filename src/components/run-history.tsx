import Link from "next/link";
import { deleteRunAction } from "@/lib/run-actions";
import { type RunRecord, runDistanceKm, runLocalDateISO, runLocalTime, runZone } from "@/lib/runs";
import { formatDuration, formatKm, formatWeekdayDate, paceSeconds } from "@/lib/running";
import { RunEditor } from "./run-editor";
import { RunStatChips } from "./run-stat-chips";

const SOURCE_LABELS: Record<string, string> = { manual: "manual", apple_health: "Apple Health" };

export function RunHistory({ runs, viewerZone }: { runs: RunRecord[]; viewerZone: string }) {
	const totalKm = runs.reduce((sum, run) => sum + runDistanceKm(run), 0);

	return (
		<div className="card p-5">
			<div className="mb-3 flex items-center justify-between">
				<h3 className="text-sm font-bold text-gray-300">Run History</h3>
				<span className="text-xs text-gray-400">
					{runs.length} runs • {totalKm.toFixed(1)} km total
				</span>
			</div>

			{runs.length === 0 ? (
				<p className="py-4 text-center text-sm text-gray-400">No runs logged yet. Get out there! 💪</p>
			) : (
				<div className="space-y-2">
					{runs.map((run) => {
						const distance = runDistanceKm(run);
						const pace = paceSeconds(distance, run.durationS);
						const date = runLocalDateISO(run, viewerZone);
						const time = runLocalTime(run, viewerZone);

						return (
							<div key={run.id} className="flex items-center gap-3 border-b border-white/5 py-2 last:border-0">
								{/* The row's own controls are buttons, so only the read-only half becomes the link. */}
								<Link
									href={`/runs/${run.id}`}
									className="-mx-2 min-w-0 flex-1 rounded-lg px-2 py-1 transition hover:bg-white/5"
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium text-white">{formatKm(distance)} km</span>
										<span className="text-xs text-gray-400">{formatDuration(run.durationS)}</span>
										{pace ? <span className="text-xs text-gray-400">{formatDuration(pace)} /km</span> : null}
										<span
											className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
												run.source === "manual"
													? "border-white/10 bg-white/5 text-gray-500"
													: "border-brand-500/30 bg-brand-600/15 text-brand-300"
											}`}
										>
											{SOURCE_LABELS[run.source] ?? run.source}
										</span>
									</div>
									<div className="mt-0.5 flex flex-wrap items-center gap-2">
										<span className="text-xs text-gray-400">
											{formatWeekdayDate(date)} · {time}
										</span>
										{run.effort ? <span className="text-xs text-gray-400">Effort: {run.effort}/10</span> : null}
										{run.notes ? <span className="truncate text-xs text-gray-400">– {run.notes}</span> : null}
									</div>
									<RunStatChips run={run} className="mt-1" />
								</Link>

								<RunEditor
									run={{
										id: run.id,
										date,
										time,
										distance: formatKm(distance),
										duration: formatDuration(run.durationS),
										effort: run.effort ?? 5,
										notes: run.notes ?? "",
										timezone: runZone(run, viewerZone),
									}}
								/>

								<form action={deleteRunAction}>
									<input type="hidden" name="id" value={run.id} />
									<button type="submit" title="Delete" className="p-1 text-gray-600 transition hover:text-red-400">
										<svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth="2"
												d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
											/>
										</svg>
									</button>
								</form>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
