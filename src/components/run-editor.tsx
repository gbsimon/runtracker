"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { type RunFormState, updateRunAction } from "@/lib/run-actions";
import { EffortSlider } from "./effort-slider";
import { Modal } from "./modal";
import { SubmitButton } from "./submit-button";

const INPUT = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
const LABEL = "mb-1 block text-xs font-medium text-gray-400";

export type EditableRun = {
	id: string;
	date: string;
	time: string;
	distance: string;
	duration: string;
	effort: number;
	notes: string;
	timezone: string;
};

export function RunEditor({ run }: { run: EditableRun }) {
	const [open, setOpen] = useState(false);
	const [state, formAction] = useActionState<RunFormState, FormData>(updateRunAction, { status: "idle" });
	const handled = useRef<number | undefined>(undefined);

	useEffect(() => {
		if (state.status === "saved" && state.token !== handled.current) {
			handled.current = state.token;
			setOpen(false);
		}
	}, [state]);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				title="Edit run"
				className="p-1 text-gray-600 transition hover:text-brand-400"
			>
				<svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="2"
						d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
					/>
				</svg>
			</button>

			{open ? (
				<Modal title="Edit Run" onClose={() => setOpen(false)}>
					<form action={formAction} className="space-y-3">
						<input type="hidden" name="id" value={run.id} />
						<input type="hidden" name="timezone" value={run.timezone} />

						<div className="grid grid-cols-2 gap-3">
							<div>
								<label className={LABEL} htmlFor={`edit-date-${run.id}`}>
									Date
								</label>
								<input
									id={`edit-date-${run.id}`}
									name="date"
									type="date"
									required
									defaultValue={run.date}
									className={INPUT}
								/>
							</div>
							<div>
								<label className={LABEL} htmlFor={`edit-time-${run.id}`}>
									Time of day
								</label>
								<input id={`edit-time-${run.id}`} name="time" type="time" defaultValue={run.time} className={INPUT} />
							</div>
						</div>

						<div className="grid grid-cols-2 gap-3">
							<div>
								<label className={LABEL} htmlFor={`edit-distance-${run.id}`}>
									Distance (km)
								</label>
								<input
									id={`edit-distance-${run.id}`}
									name="distance"
									type="text"
									inputMode="decimal"
									required
									defaultValue={run.distance}
									className={INPUT}
								/>
							</div>
							<div>
								<label className={LABEL} htmlFor={`edit-duration-${run.id}`}>
									Duration (mm:ss)
								</label>
								<input
									id={`edit-duration-${run.id}`}
									name="duration"
									type="text"
									inputMode="numeric"
									required
									defaultValue={run.duration}
									className={INPUT}
								/>
							</div>
						</div>

						<EffortSlider id={`edit-effort-${run.id}`} defaultValue={run.effort} />

						<div>
							<label className={LABEL} htmlFor={`edit-notes-${run.id}`}>
								Notes
							</label>
							<input
								id={`edit-notes-${run.id}`}
								name="notes"
								type="text"
								defaultValue={run.notes}
								placeholder="How did it feel?"
								className={INPUT}
							/>
						</div>

						{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}

						<SubmitButton
							pendingLabel="Saving…"
							className="glow-sm w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
						>
							Save Changes
						</SubmitButton>
					</form>
				</Modal>
			) : null}
		</>
	);
}
