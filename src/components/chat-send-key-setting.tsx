"use client";

import { useOptimistic, useTransition } from "react";
import { type ChatSendKey } from "@/lib/chat-send-key";
import { setChatSendKeyAction } from "@/lib/prefs-actions";

const OPTIONS: { value: ChatSendKey; label: string; hint: string }[] = [
	{ value: "enter", label: "Enter sends", hint: "Shift ↵ for a new line" },
	{ value: "cmd-enter", label: "⌘ / Ctrl + Enter sends", hint: "↵ starts a new line" },
];

/**
 * Optimistic like the hide-past-weeks toggle: the choice is a preference, not a
 * transaction, so the control should follow the click and let the write catch
 * up. `revalidatePath` inside the action is what carries it to the composer.
 */
export function ChatSendKeySetting({ value }: { value: ChatSendKey }) {
	const [mode, setMode] = useOptimistic(value);
	const [, startTransition] = useTransition();

	return (
		<fieldset>
			<legend className="text-sm font-semibold text-white">Coach chat send key</legend>
			<p className="mt-1 text-sm text-gray-400">
				Which keystroke sends your message. ⌘ / Ctrl + Enter always sends, whichever you pick.
			</p>

			<div className="mt-3 flex flex-col gap-2 sm:flex-row">
				{OPTIONS.map((option) => (
					<label key={option.value} className="flex-1 cursor-pointer">
						<input
							type="radio"
							name="chatSendKey"
							value={option.value}
							checked={mode === option.value}
							onChange={() => {
								startTransition(async () => {
									setMode(option.value);
									await setChatSendKeyAction(option.value);
								});
							}}
							className="peer sr-only"
						/>
						{/* Colour lives on this span: `peer-checked` only reaches the input's own siblings. */}
						<span className="block rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-center text-gray-300 transition hover:border-white/20 peer-checked:border-brand-500/40 peer-checked:bg-brand-600/15 peer-checked:text-white peer-focus-visible:border-brand-400">
							<span className="block text-sm font-semibold">{option.label}</span>
							<span className="mt-0.5 block text-xs text-gray-500">{option.hint}</span>
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
