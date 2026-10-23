/**
 * The `:::plan-change` protocol the coach speaks, ported from v1's
 * `formatMarkdown()` / `isPlanChangeApplied()` / `applyPlanChange()`.
 *
 * Pure on purpose: the chat thread renders a streaming reply in the browser,
 * so the same parser and the same "already applied?" check have to run there.
 * The write half lives in `plan.ts` with the rest of the data layer.
 */

import {
	type DayAbbr,
	DAY_ABBRS,
	type GoalMode,
	isDayAbbr,
	normalizeGoal,
	type PlanDay,
	type PlanSettings,
	type PlanWeek,
	type WorkoutMap,
	workoutKey,
} from "./plan-types";

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
	/**
	 * Only read when the entry appends a week past the end of the plan; an
	 * existing week keeps its phase, exactly as before this field existed.
	 */
	phase?: string;
};

/**
 * `goal` is additive: it is only set when the block carried one, so a block
 * written before open mode parses — and keys — exactly as it always did.
 */
export type PlanChange = { changes: PlanChangeEntry[]; summary: string; goal?: { text: string } };

/**
 * Only the parts of a plan the protocol reads — keeps this module DB-free.
 * The goal fields are optional so a snapshot without them still works; it
 * simply never reports a goal as applied.
 */
export type PlanSnapshot = { weeks: PlanWeek[]; skipped: WorkoutMap; goalMode?: GoalMode; goal?: string };

export type MessageSegment =
	| {
			kind: "text";
			text: string;
			truncated: boolean;
			/**
			 * Only on a truncated segment: the "⚠️ …" note the server appended after
			 * the broken block (a dropped connection, an API error). Without this it
			 * would be swallowed with the half-written JSON it follows.
			 */
			note?: string;
	  }
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
	if (!source || !Array.isArray(source.changes)) return null;

	// An optional objective. Malformed is rejected like any other bad field
	// rather than silently dropped, so the runner never applies half a block.
	let goal: { text: string } | null = null;
	if (source.goal !== undefined && source.goal !== null) {
		const raw = asRecord(source.goal);
		const text = normalizeGoal(typeof source.goal === "string" ? source.goal : raw?.text);
		if (!text) return null;
		goal = { text };
	}

	// v1's rule — a block has to change something — with an objective now
	// counting as something.
	if (source.changes.length === 0 && !goal) return null;

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
		if (typeof entry.phase === "string" && entry.phase.trim()) result.phase = entry.phase.trim();
		changes.push(result);
	}

	const change: PlanChange = { changes, summary: typeof source.summary === "string" ? source.summary : "" };
	if (goal) change.goal = goal;
	return change;
}

/**
 * Week numbers a change adds to the end of the plan: entries past the last
 * week that carry a `phase` and `days`, contiguous from the week after it.
 * Anything past a hole is not appended — it stays what it always was, a week
 * that isn't in the plan — so a stale block still reports itself as stale.
 */
export function appendedWeeks(weeks: readonly Pick<PlanWeek, "week">[], change: PlanChange): number[] {
	const last = weeks.reduce((max, week) => Math.max(max, week.week), 0);
	const candidates = new Set(
		change.changes.filter((entry) => entry.week > last && entry.phase && entry.days).map((entry) => entry.week),
	);

	const result: number[] = [];
	for (let week = last + 1; candidates.has(week); week++) result.push(week);
	return result;
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
			if (cut === -1) {
				if (text) segments.push({ kind: "text", text, truncated: false });
			} else {
				const segment: MessageSegment = { kind: "text", text, truncated: true };
				const note = trailingNote(part.slice(cut));
				if (note) segment.note = note;
				segments.push(segment);
			}
		} else {
			segments.push({ kind: "change", raw: part, change: parsePlanChange(part) });
		}
	});

	return segments;
}

const NOTE_MARK = "\n\n⚠️ ";

/** The server's "⚠️ …" failure note at the end of a cut-off block, if it left one. */
function trailingNote(afterOpener: string): string | undefined {
	const at = afterOpener.lastIndexOf(NOTE_MARK);
	if (at === -1) return undefined;
	const note = afterOpener.slice(at + 2).trim();
	return note || undefined;
}

/** True when the reply opens a `:::plan-change` block that never closes. */
export function hasUnclosedPlanChange(content: string): boolean {
	return splitMessage(content).some((segment) => segment.kind === "text" && segment.truncated);
}

/**
 * What a reply carries, for logs: no block, only complete blocks, a block
 * that never closed, or a closed block that doesn't parse.
 */
export type PlanChangeStatus = "none" | "complete" | "truncated" | "invalid";

export function planChangeStatus(content: string): PlanChangeStatus {
	const segments = splitMessage(content);
	if (segments.some((segment) => segment.kind === "text" && segment.truncated)) return "truncated";
	const changes = segments.filter((segment) => segment.kind === "change");
	if (changes.length === 0) return "none";
	return changes.every((segment) => segment.change) ? "complete" : "invalid";
}

/**
 * The reply up to (not including) the block that never closed — the prose the
 * runner has already read. Returns the content unchanged when nothing is open.
 */
export function textBeforeUnclosedPlanChange(content: string): string {
	if (!hasUnclosedPlanChange(content)) return content;
	return content.slice(0, content.lastIndexOf(OPENER)).trimEnd();
}

/** The first complete, parseable block in `text`, verbatim, or `null`. */
export function firstCompletePlanChange(text: string): string | null {
	for (const match of text.matchAll(BLOCK)) {
		if (parsePlanChange(match[1])) return match[0];
	}
	return null;
}

/**
 * Joins the prose of a reply that was cut off inside its block with the block
 * a follow-up request produced. Only a complete, parseable block is accepted;
 * anything else returns `null` so the caller reports the cut-off honestly
 * instead of storing a second broken block.
 */
export function stitchPlanChangeRetry(prose: string, retry: string): string | null {
	const block = firstCompletePlanChange(retry);
	if (!block) return null;
	const head = prose.trimEnd();
	return head ? `${head}\n\n${block}` : block;
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

	// An objective is applied once the plan is open-ended and carries it. An
	// appended week needs no special case: once added it is a week like any
	// other, and the per-week comparison below finds it.
	if (change.goal && !(plan.goalMode === "open" && (plan.goal ?? "") === change.goal.text)) return false;

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

/** The parts of a stored plan a change rewrites. */
export type PlanState = { settings: PlanSettings; weeks: PlanWeek[]; completed: WorkoutMap; skipped: WorkoutMap };

/**
 * The write half of `applyPlanChange`, minus the database: returns the plan as
 * it stands after the change, or `null` when nothing in it matched — the
 * "those weeks aren't in your plan any more" case. Never mutates `plan`.
 */
export function applyChangeToPlan(plan: PlanState, change: PlanChange): PlanState | null {
	let weeks = plan.weeks;
	let settings = plan.settings;
	const completed = { ...plan.completed };
	const skipped = { ...plan.skipped };
	let touched = false;

	// Open mode: weeks past the end are added first, in order, so the loop
	// below finds them like any other week and applies their skips the same
	// way. Nothing here runs for a block that only edits existing weeks.
	for (const number of appendedWeeks(weeks, change)) {
		const entry = change.changes.find((candidate) => candidate.week === number);
		if (!entry?.days || !entry.phase) continue;
		weeks = [...weeks, { week: number, phase: entry.phase, days: toPlanDays(entry.days) }];
	}

	if (change.goal) {
		settings = { ...settings, goalMode: "open", goal: normalizeGoal(change.goal.text) };
		touched = true;
	}

	for (const entry of change.changes) {
		const index = weeks.findIndex((week) => week.week === entry.week);
		if (index === -1) continue;
		touched = true;

		if (entry.days) {
			const days = toPlanDays(entry.days);
			weeks = weeks.map((week, i) => (i === index ? { ...week, days } : week));
		}

		for (const skip of entry.skips ?? []) {
			const dayIdx = weeks[index].days.findIndex((day) => day.day === skip.day);
			if (dayIdx === -1) continue;
			const key = workoutKey(entry.week, dayIdx);
			if (skip.skipped) {
				skipped[key] = true;
				delete completed[key];
			} else {
				delete skipped[key];
			}
		}
	}

	if (!touched) return null;
	return { settings, weeks, completed, skipped };
}

/** Days a change writes into a week, in the plan's own shape. */
export function toPlanDays(days: PlanChangeDay[]): PlanDay[] {
	return days.map((day) => {
		const result: PlanDay = { day: day.day, type: day.type, distance: day.distance, notes: day.notes };
		if (day.pace) result.pace = day.pace;
		return result;
	});
}

/** The card / toast label for a change that may carry an objective, weeks, or both. */
export function planChangeLabel(change: PlanChange): string {
	const plural = change.changes.length > 1 ? "s" : "";
	const weeks = change.changes.length > 0 ? `Week${plural} ${planChangeWeeks(change)}` : "";
	if (!change.goal) return weeks;
	return weeks ? `Objective · ${weeks}` : "Objective";
}

export function planChangeWeeks(change: PlanChange): string {
	return change.changes.map((entry) => entry.week).join(", ");
}
