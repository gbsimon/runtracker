"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { applyPlanChangeAction } from "@/lib/coach-actions";
import {
	isPlanChangeApplied,
	type PlanChange,
	type PlanSnapshot,
	planChangeWeeks,
	splitMessage,
} from "@/lib/plan-change";

/**
 * The rendering half of v1's `formatMarkdown()`: prose with **bold**,
 * *italic* and `code`, plus the `:::plan-change` blocks turned into an apply
 * card. Line breaks come from `whitespace-pre-wrap` rather than v1's injected
 * `<br>`, and React escapes the text, so v1's manual HTML escaping is gone.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g;

function renderInline(text: string): ReactNode[] {
	return text
		.split(INLINE)
		.filter((part) => part !== "")
		.map((part, index) => {
			const key = `${index}-${part.slice(0, 8)}`;
			if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
				return <strong key={key}>{part.slice(2, -2)}</strong>;
			}
			if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
				return <em key={key}>{part.slice(1, -1)}</em>;
			}
			if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
				return (
					<code key={key} className="rounded bg-white/10 px-1 text-xs text-brand-300">
						{part.slice(1, -1)}
					</code>
				);
			}
			return part;
		});
}

function changeSummary(change: PlanChange): { week: number; detail: string }[] {
	return change.changes.map((entry) => {
		const parts: string[] = [];
		if (entry.days) {
			parts.push(
				entry.days
					.map((day) => `${day.day} ${day.type} ${day.distance}km${day.pace ? ` @${day.pace}/km` : ""}`)
					.join(", "),
			);
		}
		if (entry.skips) {
			parts.push(entry.skips.map((skip) => `${skip.skipped ? "Skip" : "Unskip"} ${skip.day}`).join(", "));
		}
		return { week: entry.week, detail: parts.join("; ") };
	});
}

function PlanChangeCard({
	raw,
	change,
	plan,
	live,
}: {
	raw: string;
	change: PlanChange;
	plan: PlanSnapshot | null;
	live: boolean;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState("");

	const applied = isPlanChangeApplied(plan, change);
	// An older suggestion was written against a plan that has moved on since.
	// The diff stays readable; only the button goes away.
	const superseded = !applied && !live;

	const apply = () => {
		setError("");
		startTransition(async () => {
			const result = await applyPlanChangeAction(raw);
			if (result.status === "error") setError(result.message);
			// The refreshed page prop is what flips the button to "Applied".
			else router.refresh();
		});
	};

	return (
		<div
			className={`mt-3 rounded-xl border p-3 ${
				applied
					? "border-brand-500/30 bg-brand-600/10"
					: superseded
						? "border-white/10 bg-white/5"
						: "border-amber-500/30 bg-amber-500/10"
			}`}
		>
			<div className="mb-2 flex items-center gap-2">
				<span className={`text-sm ${superseded ? "opacity-40" : ""}`}>{applied ? "✅" : "📋"}</span>
				<span
					className={`text-sm font-semibold ${
						applied ? "text-brand-400" : superseded ? "text-gray-500" : "text-amber-400"
					}`}
				>
					Plan Change — Week{change.changes.length > 1 ? "s" : ""} {planChangeWeeks(change)}
				</span>
			</div>

			{change.summary ? <p className="mb-2 text-xs text-gray-400">{change.summary}</p> : null}

			<div className="mb-2 space-y-1 text-xs text-gray-500">
				{changeSummary(change).map((entry) => (
					<div key={entry.week}>
						<strong className="text-gray-400">Week {entry.week}:</strong> {entry.detail}
					</div>
				))}
			</div>

			{applied ? (
				<div className="text-xs font-medium text-brand-400">✓ Applied to your plan</div>
			) : superseded ? (
				<div className="text-xs text-gray-500">Superseded — ask the coach again if you still want this</div>
			) : (
				<button
					type="button"
					onClick={apply}
					disabled={pending}
					className="w-full rounded-lg bg-amber-500/80 py-2 text-sm font-medium text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{pending ? "Applying…" : "Apply Changes"}
				</button>
			)}

			{error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
		</div>
	);
}

export function CoachMessageBody({
	content,
	plan,
	live = true,
}: {
	content: string;
	plan: PlanSnapshot | null;
	/** Whether this message is the newest one carrying a plan-change block. */
	live?: boolean;
}) {
	return (
		<div className="whitespace-pre-wrap">
			{splitMessage(content).map((segment, index) => {
				if (segment.kind === "text") {
					return (
						<span key={`text-${index}`}>
							{renderInline(segment.text)}
							{segment.truncated ? (
								<span className="mt-3 block rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
									⚠️ The coach&apos;s plan change was cut off before it finished. Ask the coach to resend it (e.g.
									&ldquo;resend that plan change&rdquo;).
								</span>
							) : null}
						</span>
					);
				}

				if (!segment.change) {
					return (
						<span key={`change-${index}`} className="mt-2 block text-xs text-red-400">
							⚠️ Couldn&apos;t read the coach&apos;s plan change. Ask it to resend the change.
						</span>
					);
				}

				return (
					<div key={`change-${index}`}>
						<PlanChangeCard raw={segment.raw} change={segment.change} plan={plan} live={live} />
					</div>
				);
			})}
		</div>
	);
}
