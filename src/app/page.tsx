import type { Metadata } from "next";
import { HidePastWeeksToggle } from "@/components/hide-past-weeks";
import { PlanSettingsPanel } from "@/components/plan-settings-panel";
import { PlanSetup } from "@/components/plan-setup";
import { PlanWeekList } from "@/components/plan-week-list";
import { getPlan } from "@/lib/plan";
import { planSettingsDefaults, raceLabel, workoutKey } from "@/lib/plan-types";
import { listRuns, runDistanceKm } from "@/lib/runs";
import { currentWeekNumber, formatFullDate, formatTotalTime, isISODate, todayISOInZone, weekDateRange } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";

export const metadata: Metadata = { title: "Plan · RunTracker" };

export default async function PlanPage() {
	const user = await requireUser();
	const [zone, plan, runs] = await Promise.all([userTimeZone(), getPlan(user.id), listRuns(user.id)]);
	const today = todayISOInZone(zone);

	const totalKm = runs.reduce((sum, run) => sum + runDistanceKm(run), 0);
	const totalSeconds = runs.reduce((sum, run) => sum + run.durationS, 0);

	if (!plan || plan.weeks.length === 0 || !isISODate(plan.settings.startDate)) {
		return (
			<section className="fade-in space-y-4">
				<h2 className="text-lg font-bold text-white">Training Plan</h2>
				<PlanSetup settings={plan?.settings ?? { ...planSettingsDefaults(), startDate: today }} />
			</section>
		);
	}

	const currentWeek = currentWeekNumber(plan.settings.startDate, plan.weeks.length, today);
	const totalWorkouts = plan.weeks.reduce((sum, week) => sum + week.days.length, 0);
	const completed = plan.weeks.reduce(
		(sum, week) => sum + week.days.filter((_, i) => plan.completed[workoutKey(week.week, i)]).length,
		0,
	);
	const percent = totalWorkouts > 0 ? Math.round((completed / totalWorkouts) * 100) : 0;

	return (
		<section className="fade-in space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="text-lg font-bold text-white">Training Plan</h2>
					<p className="text-sm text-gray-400">
						{raceLabel(plan.settings.raceDistance)} • Week {currentWeek} of {plan.weeks.length} •{" "}
						{weekDateRange(plan.settings.startDate, currentWeek)}
						{isISODate(plan.settings.raceDate) ? ` • Race: ${formatFullDate(plan.settings.raceDate)}` : ""}
					</p>
				</div>
				<div className="flex gap-2">
					{runs.length > 0 ? (
						<span className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-gray-400">
							{totalKm.toFixed(1)} km • {formatTotalTime(totalSeconds)}
						</span>
					) : null}
					<span className="glow-sm rounded-lg border border-brand-500/20 bg-brand-600/20 px-3 py-1 text-xs font-semibold text-brand-400">
						{percent}% complete
					</span>
				</div>
			</div>

			<div className="flex items-center justify-end">
				<HidePastWeeksToggle hidden={plan.settings.hidePastWeeks} />
			</div>

			<PlanWeekList plan={plan} runs={runs} today={today} currentWeek={currentWeek} viewerZone={zone} />

			<PlanSettingsPanel settings={plan.settings} weekCount={plan.weeks.length} />
		</section>
	);
}
