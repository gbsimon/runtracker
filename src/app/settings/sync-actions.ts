"use server";

import { revalidatePath } from "next/cache";
import { type IngestSummary, reprocessIngestEvents } from "@/lib/ingest/process";
import { createIngestToken, revokeIngestToken } from "@/lib/ingest/tokens";
import { requireUser } from "@/lib/session";
import { setSyncShortcutName } from "@/lib/user-prefs";

/** The plaintext token rides back exactly once — after this it only exists hashed. */
export type TokenState = { status: "idle" | "created" | "error"; token?: string; label?: string; message?: string };

export type ReprocessState = { status: "idle" | "done" | "error"; message?: string; summary?: IngestSummary; claimed?: number };

const MAX_LABEL = 60;

export async function createIngestTokenAction(_previous: TokenState, formData: FormData): Promise<TokenState> {
	const user = await requireUser();
	const label = String(formData.get("label") ?? "")
		.trim()
		.slice(0, MAX_LABEL);

	const { token } = await createIngestToken(user.id, label || null);
	revalidatePath("/settings");
	return { status: "created", token, label: label || "Untitled device" };
}

export async function revokeIngestTokenAction(formData: FormData): Promise<void> {
	const user = await requireUser();
	const id = String(formData.get("id") ?? "");
	if (id) await revokeIngestToken(user.id, id);
	revalidatePath("/settings");
}

/**
 * Replays stored payloads through the pipeline. Owner-only because it also
 * claims the capture-phase events, which carry no user of their own.
 */
export async function reprocessIngestAction(): Promise<ReprocessState> {
	const user = await requireUser();
	if (user.role !== "owner") return { status: "error", message: "Only the owner can reprocess stored syncs." };

	const result = await reprocessIngestEvents(user.id, true);
	revalidatePath("/settings");
	revalidatePath("/");
	revalidatePath("/log");

	return {
		status: "done",
		claimed: result.claimed,
		summary: result.summary,
		message:
			result.events === 0
				? "Nothing waiting — every stored sync has already been processed."
				: `Reprocessed ${result.events} stored sync${result.events === 1 ? "" : "s"}.`,
	};
}

export type ShortcutNameState = { status: "idle" | "saved" | "error"; name?: string; message?: string };

/**
 * The name of the iOS Shortcut the "Sync now" button runs. Saved rather than
 * hard-coded because Shortcuts matches on the name, and someone who called
 * theirs something else would otherwise get a button that opens Shortcuts and
 * silently does nothing.
 */
export async function setSyncShortcutNameAction(
	_previous: ShortcutNameState,
	formData: FormData,
): Promise<ShortcutNameState> {
	const user = await requireUser();
	const name = await setSyncShortcutName(user.id, String(formData.get("name") ?? ""));
	revalidatePath("/settings");
	revalidatePath("/sync");
	return { status: "saved", name };
}
