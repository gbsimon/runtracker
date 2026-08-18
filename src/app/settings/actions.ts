"use server";

import { revalidatePath } from "next/cache";
import { type DeletionCounts, deleteAllUserData, importV1Backup } from "@/lib/backup";
import { type ImportSummary, MAX_IMPORT_BYTES, readV1BackupText } from "@/lib/import-v1";
import { requireUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";

export type ImportState =
	| { status: "idle" }
	| { status: "error"; message: string }
	| { status: "imported"; summary: ImportSummary };

export type DeleteState = { status: "idle" | "error" | "deleted"; message?: string; counts?: DeletionCounts };

function revalidateEverything(): void {
	revalidatePath("/");
	revalidatePath("/log");
	revalidatePath("/coach");
	revalidatePath("/settings");
}

/**
 * The browser already parsed the file to draw the preview, but it posts the
 * text and the server reads it again — the preview is a courtesy, not the
 * thing that decides what gets written.
 */
export async function importV1Action(text: string): Promise<ImportState> {
	const user = await requireUser();

	if (typeof text !== "string" || text.trim().length === 0) return { status: "error", message: "Pick a backup file first." };
	if (text.length > MAX_IMPORT_BYTES) return { status: "error", message: "That file is over 10 MB — it isn't a RunTracker backup." };

	const backup = readV1BackupText(text);
	if (typeof backup === "string") return { status: "error", message: backup };

	const summary = await importV1Backup(user.id, backup, await userTimeZone());
	revalidateEverything();
	return { status: "imported", summary };
}

/** Typing the account's own email is the confirmation — the server holds the answer. */
export async function deleteAllDataAction(_previous: DeleteState, formData: FormData): Promise<DeleteState> {
	const user = await requireUser();
	const typed = String(formData.get("confirm") ?? "")
		.trim()
		.toLowerCase();

	if (typed !== user.email.toLowerCase()) {
		return { status: "error", message: "Type your email address exactly to confirm." };
	}

	const counts = await deleteAllUserData(user.id);
	revalidateEverything();
	return { status: "deleted", counts };
}
