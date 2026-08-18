/**
 * The `:::plan-change` protocol the coach speaks, ported from v1's
 * `formatMarkdown()` / `isPlanChangeApplied()` / `applyPlanChange()`.
 *
 * Pure on purpose: the chat thread renders a streaming reply in the browser,
 * so the same parser and the same "already applied?" check have to run there.
 * The write half lives in `plan.ts` with the rest of the data layer.
 */

import { type DayAbbr, DAY_ABBRS, isDayAbbr, type PlanDay, type PlanWeek, type WorkoutMap, workoutKey } from "./plan-types";

export type PlanChangeDay = {
	day: DayAbbr;
	type: string;
	distance: number;
	notes: string;
	pace?: string;
};

export type PlanChangeSkip = { day: DayAbbr; skipped: boolean };

export type PlanChangeEntry = {
	week: number;
	days?: PlanChangeDay[];
	skips?: PlanChangeSkip[];
};

export type PlanChange = { changes: PlanChangeEntry[]; summary: string };

/** Only the parts of a plan the protocol reads — keeps this module DB-free. */
export type PlanSnapshot = { weeks: PlanWeek[]; skipped: WorkoutMap };

export type MessageSegment =
	| { kind: "text"; text: string; truncated: boolean }
	| { kind: "change"; raw: string; change: PlanChange | null };

const BLOCK = /:::plan-change\n?([\s\S]*?)\n?:::/g;
const OPENER = ":::plan-change";

/**
 * The model sometimes writes full weekday names even though the prompt asks
 * for abbreviations. v1 stored whatever came back, which silently broke the
 * plan's date maths; mapping them keeps that tolerance without the corruption.
 */
const DAY_ALIASES: Record<string, DayAbbr> = {
	monday: "Mon",
	tuesday: "Tue",
	wednesday: "Wed",
	thursday: "Thu",
	friday: "Fri",
	saturday: "Sat",
	sunday: "Sun",
	tues: "Tue",
	thur: "Thu",
	thurs: "Thu",
};

function toDayAbbr(value: unknown): DayAbbr | null {
	if (isDayAbbr(value)) return value;
	if (typeof value !== "string") return null;
	const key = value.trim().toLowerCase();
	if (DAY_ALIASES[key]) return DAY_ALIASES[key];
	return DAY_ABBRS.find((abbr) => abbr.toLowerCase() === key) ?? null;
}

function toNumber(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeDay(raw: unknown): PlanChangeDay | null {
	const source = asRecord(raw);
	if (!source) return null;
	const day = toDayAbbr(source.day);
	const distance = toNumber(source.distance);
	if (!day || distance === null || distance < 0) return null;

	const result: PlanChangeDay = {
		day,
		type: typeof source.type === "string" && source.type.trim() ? source.type.trim() : "Easy Run",
		distance,
		notes: typeof source.notes === "string" ? source.notes : "",
	};
	if (typeof source.pace === "string" && source.pace.trim()) result.pace = source.pace.trim();
	return result;
}

function normalizeSkip(raw: unknown): PlanChangeSkip | null {
	const source = asRecord(raw);
	if (!source) return null;
	const day = toDayAbbr(source.day);
	if (!day) return null;
	return { day, skipped: source.skipped !== false };
}

/**
 * Strips the ```json fence the model sometimes wraps the payload in (v1 did
 * the same), then validates. A block that fails any check returns `null` so
 * the UI can ask for a resend rather than half-apply a malformed change.
 */
export function parsePlanChange(raw: string): PlanChange | null {
	const json = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "");

	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}

	const source = asRecord(data);
	if (!source || !Array.isArray(source.changes) || source.changes.length === 0) return null;

	const changes: PlanChangeEntry[] = [];
	for (const raw of source.changes) {
		const entry = asRecord(raw);
		if (!entry) return null;

		const week = toNumber(entry.week);
		if (week === null || !Number.isInteger(week) || week < 1) return null;

		const result: PlanChangeEntry = { week };

		if (entry.days !== undefined) {
			if (!Array.isArray(entry.days)) return null;
			const days = entry.days.map(normalizeDay);
			if (days.some((day) => day === null)) return null;
			result.days = days as PlanChangeDay[];
		}

		if (entry.skips !== undefined) {
			if (!Array.isArray(entry.skips)) return null;
			const skips = entry.skips.map(normalizeSkip);
			if (skips.some((skip) => skip === null)) return null;
			result.skips = skips as PlanChangeSkip[];
		}

		if (!result.days && !result.skips) return null;
		changes.push(result);
	}

	return { changes, summary: typeof source.summary === "string" ? source.summary : "" };
}

/**
 * Splits an assistant reply into prose and plan-change blocks. A leftover
 * `:::plan-change` opener in a text segment means the block never closed —
 * v1 showed a "cut off" notice there instead of dumping raw JSON, and so
 * does the renderer that consumes `truncated`.
 */
export function splitMessage(content: string): MessageSegment[] {
	const parts = content.split(BLOCK);
	const segments: MessageSegment[] = [];

	parts.forEach((part, index) => {
		if (index % 2 === 0) {
			const cut = part.indexOf(OPENER);
			const text = cut === -1 ? part : part.slice(0, cut);
			if (text || cut !== -1) segments.push({ kind: "text", text, truncated: cut !== -1 });
		} else {
			segments.push({ kind: "change", raw: part, change: parsePlanChange(part) });
		}
	});

	return segments;
}

/** Every parseable block in one assistant message, in order. */
export function planChangesIn(content: string): PlanChange[] {
	return splitMessage(content).flatMap((segment) =>
		segment.kind === "change" && segment.change ? [segment.change] : [],
	);
}

/**
 * Identity for "the coach proposed exactly this". Parsing normalises field
 * order and defaults, so the canonical JSON of a parsed change is stable
 * across reformatting of the raw block.
 */
export function planChangeKey(change: PlanChange): string {
	return JSON.stringify(change);
}

type ThreadMessage = { id: string; role: string; content: string };

/**
 * Id of the last assistant message carrying a parseable block — the only
 * suggestion that stays applicable.
 *
 * v1 left every historical block's button live, so a block from months back
 * could still be clicked and would rewrite the plan it was written against
 * rather than the plan as it stands. Blocks proposed together in one message
 * all stay live; anything older is superseded.
 *
 * Shared by the thread and the server action so both judge "newest" from the
 * same code, over the same `CHAT_VIEW_LIMIT` window.
 */
export function newestChangeMessageId(messages: readonly ThreadMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (planChangesIn(message.content).length > 0) return message.id;
	}
	return null;
}

/**
 * v1's `isPlanChangeApplied()`: every listed week must already match. Notes
 * are deliberately not compared — the coach rewords them freely, and the
 * button flipping back to "Apply" on a reworded note would be noise.
 */
export function isPlanChangeApplied(plan: PlanSnapshot | null, change: PlanChange): boolean {
	if (!plan) return false;

	return change.changes.every((entry) => {
		const week = plan.weeks.find((candidate) => candidate.week === entry.week);
		if (!week) return false;

		if (entry.days) {
			if (week.days.length !== entry.days.length) return false;
			const match = entry.days.every(
				(day, i) =>
					week.days[i] &&
					week.days[i].day === day.day &&
					week.days[i].type === day.type &&
					week.days[i].distance === day.distance &&
					(week.days[i].pace ?? "") === (day.pace ?? ""),
			);
			if (!match) return false;
		}

		if (entry.skips) {
			const match = entry.skips.every((skip) => {
				const index = week.days.findIndex((day) => day.day === skip.day);
				if (index === -1) return false;
				return Boolean(plan.skipped[workoutKey(entry.week, index)]) === skip.skipped;
			});
			if (!match) return false;
		}

		return true;
	});
}

/** Days a change writes into a week, in the plan's own shape. */
export function toPlanDays(days: PlanChangeDay[]): PlanDay[] {
	return days.map((day) => {
		const result: PlanDay = { day: day.day, type: day.type, distance: day.distance, notes: day.notes };
		if (day.pace) result.pace = day.pace;
		return result;
	});
}

export function planChangeWeeks(change: PlanChange): string {
	return change.changes.map((entry) => entry.week).join(", ");
}
