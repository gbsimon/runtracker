"use client";

import { useState, useTransition } from "react";
import { type AllowState, allowRunTypeAction } from "@/app/sync/actions";

/** One grouped row, with every date already formatted on the server. */
export type SkippedGroupView = {
	key: string;
	name: string | null;
	count: number;
	/** "14 Aug", or `null` when the payload's start was unreadable. */
	date: string | null;
	received: string;
	/** The short human version of the skip reason. */
	reason: string;
	allowable: boolean;
};

function Row({
	group,
	pending,
	busy,
	onAllow,
}: {
	group: SkippedGroupView;
	/** This row is the one being imported. */
	pending: boolean;
	/** Some row is — every button waits, so two replays can't overlap. */
	busy: boolean;
	onAllow: () => void;
}) {
	return (
		<li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
			<div className="min-w-0">
				<p className="text-sm text-gray-200">
					{group.name ?? "Unnamed workout"}
					{group.count > 1 ? <span className="ml-2 text-xs text-gray-500">×{group.count}</span> : null}
				</p>
				<p className="mt-0.5 text-xs text-gray-500">
					{group.date ? `Latest ${group.date} · ` : ""}
					{group.reason} · synced {group.received}
				</p>
			</div>

			{group.allowable && group.name ? (
				<button
					type="button"
					disabled={busy}
					onClick={onAllow}
					className="shrink-0 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-gray-300 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
				>
					{pending ? "Importing…" : `Allow “${group.name}” as a run`}
				</button>
			) : null}
		</li>
	);
}

/**
 * Allowing a type replays every stored payload, so the answer can take a few
 * seconds and arrives as a count of what it imported. Only one row can be in
 * flight at a time — a second replay running alongside the first would fight it
 * for the same rows.
 *
 * The result sits above the list rather than inside the row that produced it:
 * a successful allow is exactly what makes that row disappear, and the answer
 * has to outlive it.
 */
export function SkippedActivities({ groups, allowed }: { groups: SkippedGroupView[]; allowed: string[] }) {
	const [result, setResult] = useState<AllowState | null>(null);
	const [running, setRunning] = useState<string | null>(null);
	const [pending, startAllow] = useTransition();

	function allow(group: SkippedGroupView): void {
		const name = group.name;
		if (!name) return;

		setResult(null);
		setRunning(group.key);
		startAllow(async () => {
			setResult(await allowRunTypeAction(name));
			setRunning(null);
		});
	}

	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-sm font-semibold text-white">Not imported as runs</h3>
				<p className="mt-1 text-sm text-gray-400">
					Health Auto Export forwards every workout your watch records — walks, rides, yoga. RunTracker imports the ones it
					can recognise as runs and lists the rest here.
				</p>
			</div>

			{result?.message ? (
				<p
					role="status"
					className={`fade-in rounded-xl border px-4 py-3 text-sm ${
						result.status === "error"
							? "border-red-500/30 bg-red-500/5 text-red-300"
							: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
					}`}
				>
					{result.message}
				</p>
			) : null}

			{groups.length === 0 ? (
				<p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-gray-500">
					Nothing filtered out. Every workout your phone has sent was imported or already known.
				</p>
			) : (
				<ul className="divide-y divide-white/5 rounded-xl border border-white/10">
					{groups.map((group) => (
						<Row
							key={group.key}
							group={group}
							pending={pending && running === group.key}
							busy={pending}
							onAllow={() => allow(group)}
						/>
					))}
				</ul>
			)}

			{allowed.length > 0 ? (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-gray-500">Also counted as runs:</span>
					{allowed.map((fragment) => (
						<span key={fragment} className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-xs text-gray-300">
							{fragment}
						</span>
					))}
				</div>
			) : null}

			<p className="text-xs text-gray-500">
				Nothing here is lost. Every payload your phone sent is kept, so allowing a type imports the ones already stored —
				with their route, heart rate and pace — as well as the ones still to come.
			</p>
		</div>
	);
}
