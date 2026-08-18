"use client";

import { useState, useTransition } from "react";
import { runSweepNowAction, type SweepActionState } from "@/app/settings/sweep-actions";

/**
 * The owner's window onto the nightly sweep: when it last ran, what it found,
 * and a button for not waiting until tonight.
 *
 * Members never see this — the sweep is installation-wide maintenance, not a
 * per-account setting, and there is nothing here they could act on.
 */

export type SweepView = {
	/** Formatted on the server, like every other stamp on this page. */
	ranAt: string;
	summary: string;
	trigger: string;
	durationS: string;
};

export function MaintenanceSweep({ sweep }: { sweep: SweepView | null }) {
	const [state, setState] = useState<SweepActionState>({ status: "idle" });
	const [running, startSweep] = useTransition();

	return (
		<div className="space-y-3">
			<div>
				<h3 className="text-sm font-semibold text-white">Nightly maintenance</h3>
				<p className="mt-1 text-sm text-gray-400">
					Once a night the server fills in weather for runs that synced while Open-Meteo was unreachable, and checks that the
					coach&rsquo;s Claude model is still being served — swapping to the current one before anyone meets the error.
				</p>
			</div>

			<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
				{sweep ? (
					<div className="space-y-1">
						<p className="text-sm text-gray-200">
							Last sweep {sweep.ranAt} <span className="text-gray-600">· {sweep.trigger}</span>
						</p>
						<p className="text-xs text-gray-400">{sweep.summary}</p>
						<p className="text-[11px] text-gray-600">Took {sweep.durationS}</p>
					</div>
				) : (
					<p className="text-sm text-gray-500">
						Not run yet — it starts within the hour of a deploy, or press the button below.
					</p>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={running}
					onClick={() => startSweep(async () => setState(await runSweepNowAction()))}
					className="rounded-xl border border-white/10 px-4 py-2 text-sm text-gray-300 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
				>
					{running ? "Sweeping…" : "Run sweep now"}
				</button>
				<p className="text-xs text-gray-500">Safe to press twice — a second press waits for the first to finish.</p>
			</div>

			{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}
			{state.status === "busy" ? <p className="text-xs text-amber-400">{state.message}</p> : null}
			{state.status === "done" ? <p className="fade-in text-xs text-emerald-400">Done — {state.message}</p> : null}
		</div>
	);
}
