import type { Metadata } from "next";
import { MileageChart } from "@/components/mileage-chart";
import { RecoveryPanel } from "@/components/recovery-panel";
import { RunForm, type RunPrefill } from "@/components/run-form";
import { RunHistory } from "@/components/run-history";
import { getDailyMetrics } from "@/lib/daily-metrics";
import { getPlan } from "@/lib/plan";
import { listRuns } from "@/lib/runs";
import { isISODate, todayISOInZone } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";

export const metadata: Metadata = { title: "Log · RunTracker" };

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
	return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** A "Log" click on a plan day arrives here as query params. */
function readPrefill(params: SearchParams): RunPrefill | undefined {
	const week = Number(one(params.week));
	const dayIdx = Number(one(params.day));
	const date = one(params.date);
	if (!Number.isInteger(week) || week < 1 || !Number.isInteger(dayIdx) || dayIdx < 0 || !isISODate(date)) return undefined;

	const type = one(params.type);
	const pace = one(params.pace);
	return {
		week,
		dayIdx,
		plannedDate: date,
		distance: one(params.distance),
		notes: pace ? `${type} @ ${pace}/km` : type,
	};
}

export default async function LogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
	const user = await requireUser();
	const [params, zone, runs, plan, metrics] = await Promise.all([
		searchParams,
		userTimeZone(),
		listRuns(user.id),
		getPlan(user.id),
		getDailyMetrics(user.id, { days: 14 }),
	]);

	const prefill = readPrefill(params);
	const planStart = plan && isISODate(plan.settings.startDate) ? plan.settings.startDate : undefined;

	return (
		<section className="fade-in space-y-4">
			<RunForm defaultDate={todayISOInZone(zone)} serverZone={zone} prefill={prefill} />
			<MileageChart runs={runs} planStart={planStart} viewerZone={zone} />
			<RecoveryPanel metrics={metrics} />
			<RunHistory runs={runs} viewerZone={zone} />
		</section>
	);
}
