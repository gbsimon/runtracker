"use client";

import { useActionState } from "react";
import { type PlanFormState, savePlanSettingsAction } from "@/lib/plan-actions";
import type { PlanSettings } from "@/lib/plan-types";
import { weeksBetween } from "@/lib/running";
import { PlanFields } from "./plan-fields";
import { SubmitButton } from "./submit-button";

export function PlanSettingsPanel({ settings, weekCount }: { settings: PlanSettings; weekCount: number }) {
	const [state, formAction] = useActionState<PlanFormState, FormData>(savePlanSettingsAction, { status: "idle" });
	const scheduledWeeks = weeksBetween(settings.startDate, settings.raceDate);

	return (
		<details className="card group p-0">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-gray-400 transition hover:bg-white/5">
				<span className="text-xs text-gray-500 group-open:hidden">▸</span>
				<span className="hidden text-xs text-gray-500 group-open:inline">▾</span>
				Plan settings
			</summary>

			<form action={formAction} className="space-y-4 border-t border-white/5 px-4 py-4">
				<PlanFields settings={settings} />
				<input type="hidden" name="hidePastWeeks" value={settings.hidePastWeeks ? "1" : "0"} />

				{scheduledWeeks !== weekCount ? (
					<p className="text-xs text-amber-400">
						Your dates now span {scheduledWeeks} weeks but the plan has {weekCount}. Regenerate to rebuild it.
					</p>
				) : null}

				{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}
				{state.status === "saved" ? <p className="text-xs text-brand-400">{state.message}</p> : null}

				<div className="flex flex-col gap-2 sm:flex-row">
					<SubmitButton
						name="intent"
						value="save"
						pendingLabel="Saving…"
						className="glow-sm flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
					>
						Save settings
					</SubmitButton>
					<SubmitButton
						name="intent"
						value="regenerate"
						pendingLabel="Regenerating…"
						onClick={(event) => {
							if (!confirm("Regenerate the plan? This clears completed and skipped workouts.")) {
								event.preventDefault();
							}
						}}
						className="flex-1 rounded-xl border border-amber-500/30 py-2.5 text-sm font-medium text-amber-400 hover:bg-amber-500/10"
					>
						Regenerate plan
					</SubmitButton>
				</div>
			</form>
		</details>
	);
}
