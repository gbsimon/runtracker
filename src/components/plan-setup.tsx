"use client";

import { useActionState } from "react";
import { createPlanAction, type PlanFormState } from "@/lib/plan-actions";
import type { PlanSettings } from "@/lib/plan-types";
import { PlanFields } from "./plan-fields";
import { SubmitButton } from "./submit-button";

export function PlanSetup({ settings }: { settings: PlanSettings }) {
	const [state, formAction] = useActionState<PlanFormState, FormData>(createPlanAction, { status: "idle" });

	return (
		<div className="card glow p-6 sm:p-8">
			<div className="mb-5 text-center">
				<div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600/20 text-2xl">
					📋
				</div>
				<h3 className="mb-1 font-bold text-white">Generate Your Training Plan</h3>
				<p className="text-sm text-gray-400">Set your dates and race distance — we&apos;ll build the weeks.</p>
			</div>

			<form action={formAction} className="mx-auto max-w-md space-y-5">
				<PlanFields settings={settings} />

				{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}

				<div className="space-y-2">
					<SubmitButton
						pendingLabel="Generating…"
						className="glow-sm w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
					>
						Generate Plan
					</SubmitButton>
					{/* Same fields, same action — `intent` picks the AI branch, as v1's second button did. */}
					<SubmitButton
						name="intent"
						value="ai"
						pendingLabel="Asking the coach…"
						title="Ask the AI coach to write the plan around your logged runs"
						className="w-full rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-semibold text-gray-300 hover:border-brand-400/40 hover:text-white"
					>
						✨ Generate with AI
					</SubmitButton>
				</div>
			</form>
		</div>
	);
}
