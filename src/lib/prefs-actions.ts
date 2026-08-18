"use server";

import { revalidatePath } from "next/cache";
import { type ChatSendKey, normalizeChatSendKey } from "@/lib/chat-send-key";
import { requireUser } from "@/lib/session";
import { setChatSendKey } from "@/lib/user-prefs";

/**
 * The composer is mounted in the root layout, so the whole layout has to be
 * invalidated for a new binding to reach it — the same reason `clearChatAction`
 * does. On desktop that is what makes the change visible in the sidebar chat
 * sitting next to this very page.
 *
 * The mode is re-normalized here: it arrives from the client.
 */
export async function setChatSendKeyAction(mode: ChatSendKey): Promise<void> {
	const user = await requireUser();
	await setChatSendKey(user.id, normalizeChatSendKey(mode));
	revalidatePath("/", "layout");
}
