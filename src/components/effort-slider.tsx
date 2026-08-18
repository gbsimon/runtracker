"use client";

import { useState } from "react";

export function EffortSlider({ id, defaultValue = 5 }: { id: string; defaultValue?: number }) {
	const [effort, setEffort] = useState(defaultValue);

	return (
		<div>
			<label className="mb-1 block text-xs font-medium text-gray-400" htmlFor={id}>
				Effort (1-10)
			</label>
			<input
				id={id}
				name="effort"
				type="range"
				min="1"
				max="10"
				value={effort}
				onChange={(event) => setEffort(Number(event.target.value))}
				className="mt-2 w-full"
			/>
			<div className="text-center text-xs text-gray-500">Level: {effort}/10</div>
		</div>
	);
}
