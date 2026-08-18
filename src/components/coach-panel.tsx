import { CHAT_VIEW_LIMIT, countChatMessages, listChatMessages } from "@/lib/chat";
import { getPlan } from "@/lib/plan";
import { CoachChat } from "./coach-chat";

/**
 * The coach column. v1 kept the coach permanently on screen at `lg:` and only
 * treated it as a tab on mobile, so this is mounted once in the root layout
 * rather than on a page: the chat then survives navigation between Plan, Log
 * and Settings with its scroll position and any in-flight reply intact.
 */
export async function CoachPanel({ userId }: { userId: string }) {
	const [messages, total, plan] = await Promise.all([
		listChatMessages(userId, CHAT_VIEW_LIMIT),
		countChatMessages(userId),
		getPlan(userId),
	]);

	return (
		<CoachChat
			initialMessages={messages.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
			}))}
			olderCount={Math.max(0, total - messages.length)}
			plan={plan ? { weeks: plan.weeks, skipped: plan.skipped } : null}
		/>
	);
}
