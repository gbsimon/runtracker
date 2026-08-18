"use client";

import { useActionState } from "react";
import { createRunAction, type RunFormState } from "@/lib/run-actions";
import { EffortSlider } from "./effort-slider";
import { SubmitButton } from "./submit-button";

const INPUT = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
const LABEL = "mb-1 block text-xs font-medium text-gray-400";

export type RunPrefill = {
	week: number;
	dayIdx: number;
	plannedDate: string;
	distance: string;
	notes: string;
};

/**
 * v1's log form. A "Log" click on a plan day arrives as `prefill`, which also
 * carries the workout to check off; the save reports the prefill back as
 * `consumed` — the same job v1's `pendingLogOrigin` did — and the form
 * remounts to its blank defaults.
 */
export function RunForm({
	defaultDate,
	serverZone,
	prefill,
}: {
	defaultDate: string;
	serverZone: string;
	prefill?: RunPrefill;
}) {
	const [state, formAction] = useActionState<RunFormState, FormData>(createRunAction, { status: "idle" });
	const signature = prefill ? `${prefill.week}-${prefill.dayIdx}-${prefill.plannedDate}` : "";
	const origin = signature && signature !== state.consumed ? prefill : undefined;

	return (
		<div className="card p-5">
			<h2 className="mb-3 text-base font-bold text-white">Log a Run</h2>

			<form
				key={`${signature}-${state.token ?? 0}`}
				action={(formData) => {
					formData.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || serverZone);
					formAction(formData);
				}}
				className="space-y-3"
			>
				{origin ? (
					<>
						<input type="hidden" name="originWeek" value={origin.week} />
						<input type="hidden" name="originDayIdx" value={origin.dayIdx} />
						<input type="hidden" name="plannedDate" value={origin.plannedDate} />
					</>
				) : null}

				<div className="grid grid-cols-2 gap-3">
					<div>
						<label className={LABEL} htmlFor="run-date">
							Date
						</label>
						<input
							id="run-date"
							name="date"
							type="date"
							required
							defaultValue={origin?.plannedDate ?? defaultDate}
							className={INPUT}
						/>
					</div>
					<div>
						<label className={LABEL} htmlFor="run-time">
							Time of day (optional)
						</label>
						<input id="run-time" name="time" type="time" className={INPUT} />
					</div>
				</div>

				<div className="grid grid-cols-2 gap-3">
					<div>
						<label className={LABEL} htmlFor="run-distance">
							Distance (km)
						</label>
						<input
							id="run-distance"
							name="distance"
							type="text"
							inputMode="decimal"
							pattern="[0-9]+([.,][0-9]*)?"
							required
							defaultValue={origin?.distance ?? ""}
							placeholder="5.0"
							className={INPUT}
						/>
					</div>
					<div>
						<label className={LABEL} htmlFor="run-duration">
							Duration (mm:ss)
						</label>
						<input
							id="run-duration"
							name="duration"
							type="text"
							inputMode="numeric"
							pattern="[0-9]+:[0-5][0-9]"
							required
							placeholder="30:00"
							className={INPUT}
						/>
					</div>
				</div>

				<EffortSlider id="run-effort" />

				<div>
					<label className={LABEL} htmlFor="run-notes">
						Notes (optional)
					</label>
					<input
						id="run-notes"
						name="notes"
						type="text"
						defaultValue={origin?.notes ?? ""}
						placeholder="How did it feel?"
						className={INPUT}
					/>
				</div>

				<SubmitButton
					pendingLabel="Saving…"
					className="glow-sm w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
				>
					Save Run
				</SubmitButton>
			</form>

			{state.status === "error" ? <p className="mt-2 text-xs text-red-400">{state.message}</p> : null}
			{state.status === "saved" ? <p className="fade-in mt-2 text-xs text-brand-400">{state.message}</p> : null}
		</div>
	);
}
