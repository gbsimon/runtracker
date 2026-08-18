"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { type PlanFormState, updatePlanDayAction } from "@/lib/plan-actions";
import { DAY_ABBRS, type PlanDay } from "@/lib/plan-types";
import { Modal } from "./modal";
import { SubmitButton } from "./submit-button";

const INPUT = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
const LABEL = "mb-1 block text-sm font-medium text-gray-300";

export function PlanDayEditor({ week, dayIdx, day }: { week: number; dayIdx: number; day: PlanDay }) {
	const [open, setOpen] = useState(false);
	const [state, formAction] = useActionState<PlanFormState, FormData>(updatePlanDayAction, { status: "idle" });
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
				title="Edit workout"
				className="rounded-lg p-1.5 text-gray-500 transition hover:bg-white/5 hover:text-brand-400"
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
				<Modal title="Edit Workout" onClose={() => setOpen(false)}>
					<form action={formAction} className="space-y-4">
						<input type="hidden" name="week" value={week} />
						<input type="hidden" name="dayIdx" value={dayIdx} />

						<div className="grid grid-cols-2 gap-3">
							<div>
								<label className={LABEL} htmlFor={`day-${week}-${dayIdx}`}>
									Day
								</label>
								<select id={`day-${week}-${dayIdx}`} name="day" defaultValue={day.day} className={INPUT}>
									{DAY_ABBRS.map((abbr) => (
										<option key={abbr} value={abbr}>
											{abbr}
										</option>
									))}
								</select>
							</div>
							<div>
								<label className={LABEL} htmlFor={`distance-${week}-${dayIdx}`}>
									Distance (km)
								</label>
								<input
									id={`distance-${week}-${dayIdx}`}
									name="distance"
									type="number"
									step="0.1"
									min="0"
									defaultValue={day.distance}
									className={INPUT}
								/>
							</div>
						</div>

						<div className="grid grid-cols-2 gap-3">
							<div>
								<label className={LABEL} htmlFor={`type-${week}-${dayIdx}`}>
									Type
								</label>
								<input
									id={`type-${week}-${dayIdx}`}
									name="type"
									type="text"
									defaultValue={day.type}
									placeholder="Easy Run"
									className={INPUT}
								/>
							</div>
							<div>
								<label className={LABEL} htmlFor={`pace-${week}-${dayIdx}`}>
									Pace
								</label>
								<input
									id={`pace-${week}-${dayIdx}`}
									name="pace"
									type="text"
									inputMode="numeric"
									pattern="[0-9]+:[0-5][0-9]"
									defaultValue={day.pace ?? ""}
									placeholder="6:00"
									className={INPUT}
								/>
								<p className="mt-1 text-xs text-gray-500">min/km, optional</p>
							</div>
						</div>

						<div>
							<label className={LABEL} htmlFor={`notes-${week}-${dayIdx}`}>
								Notes
							</label>
							<input
								id={`notes-${week}-${dayIdx}`}
								name="notes"
								type="text"
								defaultValue={day.notes}
								placeholder="Optional notes"
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
