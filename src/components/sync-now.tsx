"use client";

import { useCallback, useEffect, useState } from "react";
import { pollSyncAction, type SyncPoll } from "@/app/sync/actions";
import { buildSyncShortcutUrl, type SyncReturn } from "@/lib/sync-now";

/** How long a tap keeps the card watching before it stops promising anything. */
const POLL_WINDOW_MS = 90_000;
const POLL_INTERVAL_MS = 2_500;
/**
 * How long to keep looking after the first payload lands. The shortcut sends
 * two — workouts, then health metrics — a few seconds apart, and whichever
 * comes second would otherwise go unreported.
 */
const SETTLE_MS = 12_000;

/** Added to the home screen: iOS would open a callback URL in Safari instead. */
function isStandalone(): boolean {
	return (
		window.matchMedia?.("(display-mode: standalone)").matches ||
		("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true)
	);
}

type Phase = "idle" | "waiting" | "arrived" | "timeout" | "error" | "cancelled";

function Spinner() {
	return (
		<span
			aria-hidden
			className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-400/30 border-t-brand-300"
		/>
	);
}

export function SyncNow({
	origin,
	shortcutName,
	ios,
	title,
	initial,
	initialSince,
	initialError,
}: {
	origin: string;
	shortcutName: string;
	/** Decided on the server from the user agent — see `isIosUserAgent`. */
	ios: boolean;
	/** Rendered as a heading when this card stands on its own. */
	title?: string;
	/** How the last round trip through Shortcuts ended, off the query string. */
	initial: SyncReturn | null;
	initialSince: string | null;
	initialError: string | null;
}) {
	// A tap doesn't unload the page — a custom scheme hands off to another app
	// and leaves this one running — so the usual path is that polling starts at
	// the tap and is already ahead by the time Shortcuts hands control back.
	// `initial` is the other path: iOS discarded the page while Shortcuts was in
	// front, and the callback URL is all that survived.
	const [phase, setPhase] = useState<Phase>(() => {
		if (initial === "done" && initialSince) return "waiting";
		if (initial === "error") return "error";
		if (initial === "cancel") return "cancelled";
		return "idle";
	});
	const [since, setSince] = useState<string | null>(initialSince);
	const [message, setMessage] = useState<string | null>(
		initial === "error"
			? initialError || `Shortcuts couldn’t run “${shortcutName}”. Check the name matches the shortcut on your phone.`
			: null,
	);
	const [failed, setFailed] = useState(false);
	// Polling runs while this is set, which outlives the "waiting" phase by the
	// settle window once something has arrived.
	const [watching, setWatching] = useState(initial === "done" && Boolean(initialSince));

	const start = useCallback(() => {
		const at = new Date();
		setSince(at.toISOString());
		setMessage(null);
		setFailed(false);
		setPhase("waiting");
		setWatching(true);
		window.location.href = buildSyncShortcutUrl({ name: shortcutName, origin, at, callbacks: !isStandalone() });
	}, [origin, shortcutName]);

	useEffect(() => {
		if (!watching || !since) return;

		let cancelled = false;
		const deadline = Date.now() + POLL_WINDOW_MS;
		let settleUntil: number | null = null;
		let shown: string | null = null;

		const tick = async () => {
			if (cancelled) return;

			let result: SyncPoll;
			try {
				result = await pollSyncAction(since, shown);
			} catch {
				// A dropped request while the phone is switching apps is not a
				// failed sync — keep waiting rather than reporting one.
				result = { status: "waiting" };
			}
			if (cancelled) return;

			if (result.status === "arrived") {
				if (result.at !== shown) {
					shown = result.at;
					setMessage(result.message);
					setFailed(result.failed);
					setPhase("arrived");
				}
				settleUntil ??= Date.now() + SETTLE_MS;
				if (Date.now() >= settleUntil) {
					setWatching(false);
					return;
				}
			} else if (result.status === "expired") {
				// A stale URL, not a slow phone: say nothing rather than
				// "nothing arrived" about a tap from another day.
				setPhase("idle");
				setWatching(false);
				return;
			} else if (Date.now() >= deadline) {
				setPhase("timeout");
				setWatching(false);
				return;
			}
			timer = setTimeout(tick, POLL_INTERVAL_MS);
		};

		let timer = setTimeout(tick, 0);

		// Coming back from Shortcuts is exactly when there is something new to
		// find, and it is the one moment a fixed interval is guaranteed to miss.
		const onVisible = () => {
			if (document.visibilityState !== "visible" || cancelled) return;
			clearTimeout(timer);
			timer = setTimeout(tick, 0);
		};
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			cancelled = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [watching, since]);

	const waiting = phase === "waiting";

	return (
		<div className="space-y-3">
			{title ? (
				<div>
					<h3 className="text-sm font-semibold text-white">{title}</h3>
					<p className="mt-1 text-sm text-gray-400">
						Pulls whatever Apple Health has been holding onto — runs, sleep and recovery — without waiting for the
						automatic export to get a turn.
					</p>
				</div>
			) : null}

			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					onClick={start}
					disabled={waiting}
					className="glow-sm inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{waiting ? <Spinner /> : null}
					{waiting ? "Syncing…" : "Sync now"}
				</button>

				{waiting ? (
					<p className="text-xs text-gray-400">Health Auto Export is exporting — this updates on its own.</p>
				) : null}
			</div>

			{phase === "arrived" && message ? (
				<p className={`fade-in text-sm ${failed ? "text-amber-300" : "text-emerald-400"}`}>{message}</p>
			) : null}

			{phase === "timeout" ? (
				<p className="fade-in text-sm text-gray-400">
					Nothing has arrived yet. A big export can outlast this card — reload in a moment, or open Health Auto Export and
					check the automation ran.
				</p>
			) : null}

			{phase === "error" && message ? <p className="fade-in text-sm text-red-400">{message}</p> : null}

			{phase === "cancelled" ? <p className="fade-in text-sm text-gray-400">Sync cancelled — nothing was sent.</p> : null}

			{!ios ? (
				<p className="text-xs text-gray-500">
					This opens the Shortcuts app, so it only does anything on the iPhone that has Health Auto Export installed. Open
					RunTracker there and press it.
				</p>
			) : null}
		</div>
	);
}
