/**
 * How the thread is arranged for reading. Pure and database-free — the chat
 * renders in the browser, and this is the part of it worth pinning down with
 * tests rather than eyeballing.
 */

export type CoachChatMessage = { id: string; role: "user" | "assistant"; content: string };

/**
 * Groups the flat thread into exchanges: a question and every reply that
 * followed it. Assistant messages with no question ahead of them — the
 * greeting, or an imported thread that opens on the coach — lead their own
 * group, as do consecutive replies, which stay with the question they answer.
 *
 * The feed reads newest-first, but reversing individual rows would put every
 * answer above the question that prompted it. Reversing whole exchanges keeps
 * each one reading top-to-bottom the way it was said.
 */
export function toExchanges(messages: readonly CoachChatMessage[]): CoachChatMessage[][] {
	const exchanges: CoachChatMessage[][] = [];
	for (const message of messages) {
		if (message.role === "user" || exchanges.length === 0) exchanges.push([message]);
		else exchanges[exchanges.length - 1].push(message);
	}
	return exchanges;
}

/** Newest exchange first; within an exchange, the original order. */
export function newestExchangesFirst(messages: readonly CoachChatMessage[]): CoachChatMessage[][] {
	return toExchanges(messages).reverse();
}
