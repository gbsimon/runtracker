"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { type ChatSendKey, chatKeyAction, DEFAULT_CHAT_SEND_KEY, sendKeyHint } from "@/lib/chat-send-key";
import { type CoachChatMessage, newestExchangesFirst } from "@/lib/chat-view";
import { clearChatAction } from "@/lib/coach-actions";
import { newestChangeMessageId, planChangesIn, type PlanSnapshot } from "@/lib/plan-change";
import { CoachMessageBody } from "./coach-message";

export type { CoachChatMessage };

/**
 * v1 wrote this greeting into `chatHistory` the first time the tab rendered.
 * Here it is display-only — a page view shouldn't write to the database, and
 * the coach doesn't need to be told what it already said.
 */
const GREETING =
	"Hey! I'm your running coach 🏃 I can see your training plan and logged runs. Ask me anything — pacing, recovery, race day strategy, or how you're feeling.\n\nI can also **adjust your plan** directly. If you're hurt, tired, or want more volume — just tell me and I'll suggest changes you can apply with one click.";

const GREETING_MESSAGE: CoachChatMessage = { id: "greeting", role: "assistant", content: GREETING };

type StreamEvent = { type: "text"; text: string } | { type: "error"; message: string } | { type: "done" };

function localId(): string {
	return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}-${Math.random()}`;
}


export function CoachChat({
	initialMessages,
	plan,
	olderCount = 0,
	sendKey = DEFAULT_CHAT_SEND_KEY,
	apple = true,
}: {
	initialMessages: CoachChatMessage[];
	plan: PlanSnapshot | null;
	/** Messages older than the rendered window — see `CHAT_VIEW_LIMIT`. */
	olderCount?: number;
	/**
	 * A prop rather than state, so saving it on Settings reaches the composer
	 * through the layout revalidation without remounting the thread.
	 */
	sendKey?: ChatSendKey;
	/**
	 * Sniffed server-side from the User-Agent, and only ever the hint's wording:
	 * Ctrl+Enter sends on a Mac too, so getting this wrong costs a label, not a
	 * keystroke.
	 */
	apple?: boolean;
}) {
	// Seeded once: this component owns the thread from here on, so a
	// `router.refresh()` after applying a plan change (which is what makes the
	// `plan` prop below go stale) can't wipe messages out from under it.
	const [messages, setMessages] = useState<CoachChatMessage[]>(() => initialMessages);
	const [streamed, setStreamed] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [clearing, startClearing] = useTransition();

	const threadRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Only the newest suggestion keeps its Apply button. A reply still
	// streaming in takes that role the moment it contains a block, so the
	// previous one goes inert before the new card has even finished arriving.
	const committedNewestId = useMemo(() => newestChangeMessageId(messages), [messages]);
	const streamingHasChange = useMemo(() => (streamed ? planChangesIn(streamed).length > 0 : false), [streamed]);
	const liveChangeId = streamingHasChange ? null : committedNewestId;

	const newestFirst = useMemo(
		() => newestExchangesFirst(messages.length > 0 ? messages : [GREETING_MESSAGE]),
		[messages],
	);

	/**
	 * The newest exchange sits at the top, so that is where the viewport
	 * belongs whenever the thread grows. Nothing is needed mid-stream: a reply
	 * grows *downward* from a point below the anchor, so everything above it
	 * — including the question you just asked — stays exactly where it was.
	 */
	const messageCount = messages.length;
	const previousCount = useRef(messageCount);
	useEffect(() => {
		if (messageCount === previousCount.current) return;
		previousCount.current = messageCount;
		threadRef.current?.scrollTo({ top: 0 });
	}, [messageCount]);

	const append = (role: CoachChatMessage["role"], content: string) => {
		setMessages((current) => [...current, { id: localId(), role, content }]);
	};

	async function send(text: string) {
		append("user", text);
		setSending(true);
		setStreamed("");

		let reply = "";
		let failure = "";

		try {
			const response = await fetch("/api/coach/message", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: text }),
			});

			if (!response.ok || !response.body) {
				throw new Error(
					response.status === 401
						? "Your session expired — reload the page and sign in again."
						: `The coach service is unavailable (${response.status}).`,
				);
			}

			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = "";

			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += value;

				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = JSON.parse(line) as StreamEvent;
					if (event.type === "text") {
						reply += event.text;
						setStreamed(reply);
					} else if (event.type === "error") {
						failure = event.message;
					}
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : "Something went wrong talking to the coach.";
		}

		// Mirrors what the server stored, so a reload shows the same thread.
		const stored = failure ? `${reply}${reply ? "\n\n" : ""}⚠️ ${failure}` : reply;
		if (stored.trim()) append("assistant", stored);
		setStreamed(null);
		setSending(false);
	}

	function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const input = inputRef.current;
		const text = input?.value.trim();
		if (!text || sending) return;
		if (input) {
			input.value = "";
			input.style.height = "auto";
		}
		void send(text);
	}

	function clearChat() {
		if (!window.confirm("Clear the conversation with your coach?")) return;
		startClearing(async () => {
			await clearChatAction();
			setMessages([]);
			setStreamed(null);
		});
	}

	return (
		<div className="card flex flex-col p-4">
			<div className="mb-3 flex flex-shrink-0 items-center justify-between">
				<h2 className="text-base font-bold text-white">Coach</h2>
				<button
					type="button"
					onClick={clearChat}
					disabled={clearing || sending || messages.length === 0}
					className="text-xs text-gray-500 transition hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{clearing ? "Clearing…" : "Clear conversation"}
				</button>
			</div>

			<form onSubmit={onSubmit} className="mb-3 flex-shrink-0">
				<div className="flex items-end gap-2">
					<textarea
						ref={inputRef}
						rows={1}
						name="message"
						aria-label="Message your coach"
						placeholder="Ask your coach anything…"
						maxLength={4000}
						disabled={sending}
						onInput={(event) => {
							// Grows with the text, then `max-h-32` caps it and the
							// textarea scrolls — which is the normal case once Enter
							// writes newlines instead of sending.
							const element = event.currentTarget;
							element.style.height = "auto";
							element.style.height = `${element.scrollHeight}px`;
						}}
						onKeyDown={(event) => {
							if (chatKeyAction(sendKey, event) !== "send") return;
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}}
						className="max-h-32 flex-1 resize-none overflow-y-auto rounded-xl border px-3 py-2 text-sm outline-none"
					/>
					<button
						type="submit"
						disabled={sending}
						className="glow-sm rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{sending ? "…" : "Send"}
					</button>
				</div>
				<p className="mt-1 text-right text-xs text-gray-600">{sendKeyHint(sendKey, apple)}</p>
			</form>

			{/* Newest exchange first, directly under the composer. */}
			<div
				ref={threadRef}
				className="max-h-[55vh] flex-1 space-y-4 overflow-y-auto pr-1 lg:max-h-[calc(100vh-18.25rem)]"
				style={{ overscrollBehavior: "contain" }}
			>
				{newestFirst.map((exchange, index) => (
					<div key={exchange[0].id} className="space-y-2">
						{exchange.map((message) => (
							<div
								key={message.id}
								className={`fade-in rounded-xl border px-4 py-3 text-sm text-gray-300 ${
									message.role === "user"
										? "ml-8 border-brand-500/20 bg-brand-600/15"
										: "mr-8 border-white/10 bg-white/5"
								}`}
							>
								<div
									className={`mb-1 text-xs font-medium ${message.role === "user" ? "text-brand-400" : "text-gray-500"}`}
								>
									{message.role === "user" ? "You" : "Coach"}
								</div>
								<CoachMessageBody content={message.content} plan={plan} live={message.id === liveChangeId} />
							</div>
						))}

						{/* The reply belongs to the newest exchange, under its question. */}
						{index === 0 && streamed !== null ? (
							<div className="fade-in mr-8 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-300">
								<div className="mb-1 text-xs font-medium text-gray-500">Coach</div>
								{streamed ? (
									<CoachMessageBody content={streamed} plan={plan} />
								) : (
									<div className="flex items-center gap-2 text-gray-400">
										<span
											aria-hidden="true"
											className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/10 border-t-brand-500"
										/>
										Coach is thinking…
									</div>
								)}
							</div>
						) : null}
					</div>
				))}

				{olderCount > 0 && messages.length > 0 ? (
					<p className="pt-1 text-center text-xs text-gray-600">
						{olderCount.toLocaleString("en-US")} older message{olderCount === 1 ? "" : "s"} not shown
					</p>
				) : null}
			</div>
		</div>
	);
}
