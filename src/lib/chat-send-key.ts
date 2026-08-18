/**
 * How the coach composer treats Enter.
 *
 * Pure — no database, no React — so the client component, the server action and
 * the check script all decide from the same rules.
 */

export const CHAT_SEND_KEYS = ["enter", "cmd-enter"] as const;

export type ChatSendKey = (typeof CHAT_SEND_KEYS)[number];

/** v2 shipped with Enter sending, so that is what a silent row means. */
export const DEFAULT_CHAT_SEND_KEY: ChatSendKey = "enter";

/** Tolerant of anything a row written before this preference existed can hold. */
export function normalizeChatSendKey(raw: unknown): ChatSendKey {
	return (CHAT_SEND_KEYS as readonly unknown[]).includes(raw) ? (raw as ChatSendKey) : DEFAULT_CHAT_SEND_KEY;
}

/** The parts of a `KeyboardEvent` the decision depends on. */
export type SendKeyChord = {
	key: string;
	shiftKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
};

export type SendKeyAction = "send" | "newline";

/**
 * What a keystroke in the composer means.
 *
 * `"newline"` is the composer standing aside: Enter then inserts a line break
 * and every other key types itself, which is why a key that isn't Enter answers
 * with it too. Cmd/Ctrl+Enter sends under *both* modes — switching mode should
 * never make a habit stop working, only add one.
 */
export function chatKeyAction(mode: ChatSendKey, chord: SendKeyChord): SendKeyAction {
	if (chord.key !== "Enter") return "newline";
	if (chord.metaKey || chord.ctrlKey) return "send";
	if (mode === "cmd-enter") return "newline";
	return chord.shiftKey ? "newline" : "send";
}

/** Apple keyboards send on ⌘; everywhere else the same chord is Ctrl. */
export function isAppleUserAgent(userAgent: string): boolean {
	return /Mac|iPhone|iPad|iPod/i.test(userAgent);
}

/** The muted line under the composer, naming the key that actually sends. */
export function sendKeyHint(mode: ChatSendKey, apple: boolean): string {
	if (mode === "enter") return "↵ to send";
	return apple ? "⌘↵ to send" : "Ctrl ↵ to send";
}
