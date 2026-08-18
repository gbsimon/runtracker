import { headers } from "next/headers";
import { CHAT_VIEW_LIMIT, countChatMessages, listChatMessages } from "@/lib/chat";
import { isAppleUserAgent } from "@/lib/chat-send-key";
import { getPlan } from "@/lib/plan";
import { getUserPrefs } from "@/lib/user-prefs";
import { CoachChat } from "./coach-chat";

/**
 * The coach column. v1 kept the coach permanently on screen at `lg:` and only
 * treated it as a tab on mobile, so this is mounted once in the root layout
 * rather than on a page: the chat then survives navigation between Plan, Log
 * and Settings with its scroll position and any in-flight reply intact.
 */
export async function CoachPanel({ userId }: { userId: string }) {
	const [messages, total, plan, prefs, headerList] = await Promise.all([
		listChatMessages(userId, CHAT_VIEW_LIMIT),
		countChatMessages(userId),
		getPlan(userId),
		getUserPrefs(userId),
		headers(),
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
			sendKey={prefs.chatSendKey}
			// Sniffed here rather than in the browser: the composer's hint would
			// otherwise have to change wording after hydration.
			apple={isAppleUserAgent(headerList.get("user-agent") ?? "")}
		/>
	);
}
