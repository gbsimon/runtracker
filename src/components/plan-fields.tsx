"use client";

import { useState } from "react";
import { type GoalMode, MAX_GOAL_LENGTH, MIN_PLAN_WEEKS, normalizeGoalMode, type PlanSettings, RACE_PRESETS } from "@/lib/plan-types";
import { weeksBetween } from "@/lib/running";

const INPUT = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
const LABEL = "mb-1 block text-sm font-medium text-gray-300";

function isPreset(distance: number): boolean {
	return RACE_PRESETS.some((preset) => preset.value === distance);
}

const MODES: { value: GoalMode; label: string; detail: string }[] = [
	{ value: "race", label: "Race", detail: "Count down to a race date" },
	{ value: "open", label: "Keep training (no race)", detail: "A rolling plan, 4 weeks at a time" },
];

/**
 * The plan fields shared by the first-run setup card and the settings panel.
 * `onModeChange` lets the settings panel drop its race-only warning as soon as
 * the choice flips, before anything is saved.
 */
export function PlanFields({
	settings,
	onModeChange,
}: {
	settings: PlanSettings;
	onModeChange?: (mode: GoalMode) => void;
}) {
	const [mode, setMode] = useState<GoalMode>(normalizeGoalMode(settings.goalMode));
	const open = mode === "open";
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
			<fieldset>
				<legend className={LABEL}>Goal</legend>
				<div className="grid grid-cols-2 gap-2">
					{MODES.map((option) => (
						<label
							key={option.value}
							className={`cursor-pointer rounded-lg border px-3 py-2 text-sm transition ${
								mode === option.value
									? "border-brand-500/50 bg-brand-600/15 text-white"
									: "border-white/10 text-gray-400 hover:border-white/20"
							}`}
						>
							<input
								type="radio"
								name="goalMode"
								value={option.value}
								checked={mode === option.value}
								onChange={() => {
									setMode(option.value);
									onModeChange?.(option.value);
								}}
								className="sr-only"
							/>
							<span className="block font-medium">{option.label}</span>
							<span className="block text-xs text-gray-500">{option.detail}</span>
						</label>
					))}
				</div>
			</fieldset>

			{open ? (
				<div>
					<label className={LABEL} htmlFor="goal">
						Objective <span className="font-normal text-gray-500">(optional)</span>
					</label>
					<textarea
						id="goal"
						name="goal"
						rows={2}
						maxLength={MAX_GOAL_LENGTH}
						defaultValue={settings.goal ?? ""}
						placeholder="e.g. Get my 5K under 25 minutes, 4 runs a week"
						className={`${INPUT} resize-y`}
					/>
					<p className="mt-1 text-xs text-gray-500">Leave it empty and the coach will help you pick one.</p>
				</div>
			) : (
				// Carried through a race-mode save so an objective set earlier survives.
				<input type="hidden" name="goal" value={settings.goal ?? ""} />
			)}

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
						{open ? "Last Race Date" : "Race Date"}
						{open ? <span className="font-normal text-gray-500"> (optional)</span> : null}
					</label>
					<input
						id="raceDate"
						name="raceDate"
						type="date"
						required={!open}
						value={raceDate}
						onChange={(event) => setRaceDate(event.target.value)}
						className={INPUT}
					/>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div>
					<label className={LABEL} htmlFor="raceDistance">
						{open ? "Last Race Distance" : "Race Distance"}
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
							required={!open}
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
						{open ? "Target Pace" : "Target Race Pace"}
					</label>
					<input
						id="targetPace"
						name="targetPace"
						type="text"
						inputMode="decimal"
						pattern="[0-9]+[:.,][0-5][0-9]"
						title="e.g. 6:00 or 6.00"
						defaultValue={settings.targetPace}
						placeholder="6:00"
						className={INPUT}
					/>
					<p className="mt-1 text-xs text-gray-500">min/km goal pace</p>
				</div>
			</div>

			{open ? (
				<p className="text-xs text-gray-500">Weeks count from the start date; the first block starts this week, then add 4 weeks at a time.</p>
			) : (
				<p className={`text-xs ${tooShort ? "text-red-400" : "text-gray-500"}`}>{hint}</p>
			)}
		</div>
	);
}
