import Link from "next/link";
import { isWeekFinished, type PlanRecord } from "@/lib/plan";
import { toggleSkipAction, toggleWorkoutAction } from "@/lib/plan-actions";
import { type PlanDay, workoutKey } from "@/lib/plan-types";
import { type RunRecord, runDistanceKm, runLocalDateISO } from "@/lib/runs";
import {
	addDaysISO,
	formatDuration,
	formatKm,
	formatMonthDay,
	formatPace,
	getWorkoutPace,
	paceSeconds,
	parsePace,
	weekDateRange,
	weekMondayISO,
	workoutDateISO,
} from "@/lib/running";
import { PlanDayEditor } from "./plan-day-editor";
import { RunStatChips } from "./run-stat-chips";

const PHASE_COLORS: Record<string, string> = {
	"Base Building": "bg-blue-500/15 text-blue-400 border border-blue-500/20",
	"Building Volume": "bg-purple-500/15 text-purple-400 border border-purple-500/20",
	"Peak Training": "bg-orange-500/15 text-orange-400 border border-orange-500/20",
	Taper: "bg-amber-500/15 text-amber-400 border border-amber-500/20",
	"Race Week Prep": "bg-rose-500/15 text-rose-400 border border-rose-500/20",
	"Race Week!": "bg-rose-500/15 text-rose-400 border border-rose-500/20",
};

const TYPE_COLORS: Record<string, string> = {
	"Easy Run": "text-emerald-400",
	"Long Run": "text-blue-400",
	"Tempo Run": "text-purple-400",
	"Easy Tempo": "text-purple-400",
	Intervals: "text-orange-400",
	"Race Pace": "text-rose-400",
	Shakeout: "text-amber-400",
	Rest: "text-gray-500",
};

const TAG = "rounded-md border border-white/10 bg-white/10 px-2 py-0.5 text-[11px] font-medium text-gray-400";

function logHref(week: number, dayIdx: number, date: string, day: PlanDay, pace: string): string {
	const params = new URLSearchParams({
		week: String(week),
		day: String(dayIdx),
		date,
		distance: String(day.distance),
		type: day.type,
	});
	if (pace) params.set("pace", pace);
	return `/log?${params}`;
}

export function PlanWeekList({
	plan,
	runs,
	today,
	currentWeek,
	viewerZone,
}: {
	plan: PlanRecord;
	runs: RunRecord[];
	today: string;
	currentWeek: number;
	viewerZone: string;
}) {
	const { startDate, targetPace, hidePastWeeks } = plan.settings;
	const racePaceSec = parsePace(targetPace);

	const runsByDate = new Map<string, RunRecord[]>();
	for (const run of runs) {
		const date = runLocalDateISO(run, viewerZone);
		runsByDate.set(date, [...(runsByDate.get(date) ?? []), run]);
	}

	const visible = plan.weeks.filter((week) => {
		if (!hidePastWeeks || week.week === currentWeek) return true;
		return addDaysISO(weekMondayISO(startDate, week.week), 6) >= today;
	});

	if (visible.length === 0) {
		return <p className="card p-6 text-center text-sm text-gray-500">Every week is in the past — untick “Hide past weeks”.</p>;
	}

	return (
		<div className="space-y-2">
			{visible.map((week) => {
				const isCurrent = week.week === currentWeek;
				const isPast = week.week < currentWeek;
				const completedDays = week.days.filter((_, i) => plan.completed[workoutKey(week.week, i)]);
				const weekCompleted = week.days.length > 0 && completedDays.length === week.days.length;
				const skippedCount = week.days.filter((_, i) => plan.skipped[workoutKey(week.week, i)]).length;
				const weekFinished = !weekCompleted && isWeekFinished(plan, week);
				const weekTotal = week.days.reduce(
					(sum, day, i) => sum + (plan.skipped[workoutKey(week.week, i)] ? 0 : day.distance),
					0,
				);

				return (
					<details
						key={week.week}
						open={isCurrent}
						className={`card group overflow-hidden ${isCurrent ? "week-current" : ""} ${
							isPast && (weekCompleted || weekFinished) ? "opacity-40" : ""
						}`}
					>
						<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-left transition hover:bg-white/5">
							<span className="w-3 text-xs text-gray-500 group-open:hidden">▸</span>
							<span className="hidden w-3 text-xs text-gray-500 group-open:inline">▾</span>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm font-bold text-white">Week {week.week}</span>
									<span
										className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
											PHASE_COLORS[week.phase] ?? "border border-white/10 bg-white/10 text-gray-400"
										}`}
									>
										{week.phase}
									</span>
									{weekCompleted ? <span className="text-sm text-brand-400">✓</span> : null}
									{weekFinished ? (
										<span className={TAG}>Finished{skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}</span>
									) : null}
									{isCurrent ? (
										<span className="glow-sm rounded-md bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">
											Current
										</span>
									) : null}
								</div>
								<span className="mt-0.5 block text-xs text-gray-400">
									{weekDateRange(startDate, week.week)} • {weekTotal.toFixed(1)} km
								</span>
							</div>
						</summary>

						<div className="space-y-1 px-4 pb-3">
							{week.days.map((day, dayIdx) => {
								const key = workoutKey(week.week, dayIdx);
								const done = Boolean(plan.completed[key]);
								const skipped = Boolean(plan.skipped[key]);
								const dateISO = workoutDateISO(startDate, week.week, day.day);
								const logged = runsByDate.get(dateISO) ?? [];
								const displayPace = day.pace || (racePaceSec > 0 ? formatPace(getWorkoutPace(day.type, racePaceSec)) : "");
								const struck = skipped ? "line-through" : "";

								return (
									<div
										key={key}
										className={`flex items-start gap-3 border-t border-white/5 py-2 ${
											(done && logged.length === 0) || skipped ? "opacity-35" : ""
										}`}
									>
										<form action={toggleWorkoutAction} className="mt-0.5 flex-shrink-0">
											<input type="hidden" name="key" value={key} />
											<button
												type="submit"
												aria-label={done ? `Mark ${day.type} not done` : `Mark ${day.type} done`}
												className={`flex h-5 w-5 items-center justify-center rounded-md border-2 transition ${
													done ? "border-brand-500 bg-brand-500 text-white" : "border-white/15 hover:border-brand-400"
												}`}
											>
												{done ? (
													<svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
														<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
													</svg>
												) : null}
											</button>
										</form>

										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className={`w-24 text-xs font-medium text-gray-400 ${struck}`}>
													{day.day} {formatMonthDay(dateISO)}
												</span>
												<span className={`text-sm font-semibold ${TYPE_COLORS[day.type] ?? "text-gray-400"} ${struck}`}>
													{day.type}
												</span>
												{day.distance > 0 ? (
													<span className={`text-xs font-medium text-gray-400 ${struck}`}>{day.distance} km</span>
												) : null}
												{displayPace ? (
													<span className="text-xs font-medium text-gray-500">@ {displayPace}/km</span>
												) : null}
												{skipped ? <span className={TAG}>Skipped</span> : null}
											</div>
											{day.notes ? <p className={`mt-0.5 text-xs text-gray-500 ${struck}`}>{day.notes}</p> : null}

											{logged.map((run) => {
												const distance = runDistanceKm(run);
												const pace = paceSeconds(distance, run.durationS);
												const delta = distance - day.distance;
												return (
													<Link
														key={run.id}
														href={`/runs/${run.id}`}
														title="See this run"
														className="-mx-1 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-0.5 text-xs text-emerald-400/90 transition hover:bg-emerald-400/10"
													>
														<span className="font-medium">✓ Logged</span>
														<span className="font-semibold text-emerald-300">{formatKm(distance)} km</span>
														<span>{formatDuration(run.durationS)}</span>
														{pace ? <span>{formatDuration(pace)}/km</span> : null}
														{run.effort ? <span className="text-gray-500">effort {run.effort}/10</span> : null}
														{day.distance > 0 ? (
															<span className="text-gray-600">
																({delta >= 0 ? "+" : ""}
																{delta.toFixed(1)} km)
															</span>
														) : null}
														<RunStatChips run={run} />
													</Link>
												);
											})}
										</div>

										<div className="flex flex-shrink-0 items-center gap-0.5">
											{!done && !skipped && day.distance > 0 ? (
												<Link
													href={logHref(week.week, dayIdx, dateISO, day, displayPace)}
													title="Log this workout"
													className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-400 transition hover:bg-brand-600/15 hover:text-brand-300"
												>
													Log
												</Link>
											) : null}

											<form action={toggleSkipAction}>
												<input type="hidden" name="key" value={key} />
												<button
													type="submit"
													title={skipped ? "Undo skip" : "Skip"}
													className={`rounded-lg p-1.5 transition hover:bg-white/5 ${
														skipped ? "text-amber-400 hover:text-amber-300" : "text-gray-500 hover:text-amber-400"
													}`}
												>
													{skipped ? (
														<svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth="2"
																d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"
															/>
														</svg>
													) : (
														<svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth="2"
																d="M18.364 18.364A9 9 0 105.636 5.636a9 9 0 0012.728 12.728zM5.636 5.636l12.728 12.728"
															/>
														</svg>
													)}
												</button>
											</form>

											<PlanDayEditor week={week.week} dayIdx={dayIdx} day={day} />
										</div>
									</div>
								);
							})}
						</div>
					</details>
				);
			})}
		</div>
	);
}
