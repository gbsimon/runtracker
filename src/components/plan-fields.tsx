"use client";

import { useState } from "react";
import { MIN_PLAN_WEEKS, type PlanSettings, RACE_PRESETS } from "@/lib/plan-types";
import { weeksBetween } from "@/lib/running";

const INPUT = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
const LABEL = "mb-1 block text-sm font-medium text-gray-300";

function isPreset(distance: number): boolean {
	return RACE_PRESETS.some((preset) => preset.value === distance);
}

/** The race fields shared by the first-run setup card and the settings panel. */
export function PlanFields({ settings }: { settings: PlanSettings }) {
	const [startDate, setStartDate] = useState(settings.startDate);
	const [raceDate, setRaceDate] = useState(settings.raceDate);
	const [raceDistance, setRaceDistance] = useState(isPreset(settings.raceDistance) ? String(settings.raceDistance) : "custom");

	const weeks = startDate && raceDate ? weeksBetween(startDate, raceDate) : 0;
	const tooShort = weeks > 0 && weeks < MIN_PLAN_WEEKS;
	const hint = !weeks
		? "Set both dates to generate a plan."
		: tooShort
			? `${weeks} week${weeks > 1 ? "s" : ""} — need at least ${MIN_PLAN_WEEKS} weeks for a training plan.`
			: `${weeks}-week training plan. ${weeks >= 16 ? "Great timeline!" : weeks >= 10 ? "Doable but intense." : "Aggressive — plan will be compressed."}`;

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-3">
				<div>
					<label className={LABEL} htmlFor="startDate">
						Start Date
					</label>
					<input
						id="startDate"
						name="startDate"
						type="date"
						required
						value={startDate}
						onChange={(event) => setStartDate(event.target.value)}
						className={INPUT}
					/>
				</div>
				<div>
					<label className={LABEL} htmlFor="raceDate">
						Race Date
					</label>
					<input
						id="raceDate"
						name="raceDate"
						type="date"
						required
						value={raceDate}
						onChange={(event) => setRaceDate(event.target.value)}
						className={INPUT}
					/>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div>
					<label className={LABEL} htmlFor="raceDistance">
						Race Distance
					</label>
					<select
						id="raceDistance"
						name="raceDistance"
						value={raceDistance}
						onChange={(event) => setRaceDistance(event.target.value)}
						className={INPUT}
					>
						{RACE_PRESETS.map((preset) => (
							<option key={preset.value} value={preset.value}>
								{preset.label}
							</option>
						))}
						<option value="custom">Custom</option>
					</select>
				</div>
				{raceDistance === "custom" ? (
					<div>
						<label className={LABEL} htmlFor="customDistance">
							Distance (km)
						</label>
						<input
							id="customDistance"
							name="customDistance"
							type="number"
							step="0.1"
							min="1"
							required
							defaultValue={isPreset(settings.raceDistance) ? "" : settings.raceDistance}
							placeholder="15"
							className={INPUT}
						/>
					</div>
				) : null}
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div>
					<label className={LABEL} htmlFor="targetPace">
						Target Race Pace
					</label>
					<input
						id="targetPace"
						name="targetPace"
						type="text"
						inputMode="numeric"
						pattern="[0-9]+:[0-5][0-9]"
						defaultValue={settings.targetPace}
						placeholder="6:00"
						className={INPUT}
					/>
					<p className="mt-1 text-xs text-gray-500">min/km goal pace</p>
				</div>
			</div>

			<p className={`text-xs ${tooShort ? "text-red-400" : "text-gray-500"}`}>{hint}</p>
		</div>
	);
}
