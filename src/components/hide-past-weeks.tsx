"use client";

import { useOptimistic, useTransition } from "react";
import { setHidePastWeeksAction } from "@/lib/plan-actions";

export function HidePastWeeksToggle({ hidden }: { hidden: boolean }) {
	const [checked, setChecked] = useOptimistic(hidden);
	const [, startTransition] = useTransition();

	return (
		<label className="flex cursor-pointer select-none items-center gap-2 text-xs text-gray-400 transition hover:text-gray-300">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => {
					const next = event.target.checked;
					startTransition(async () => {
						setChecked(next);
						await setHidePastWeeksAction(next);
					});
				}}
				className="h-3.5 w-3.5"
			/>
			Hide past weeks
		</label>
	);
}
