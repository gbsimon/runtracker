"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { invites } from "@/db/schema";
import { findOpenInvite, findUserByEmail, isValidEmail, normalizeEmail } from "@/lib/auth-access";
import { sendInviteEmail } from "@/lib/invite-email";
import { inviteExpiry, inviteLink } from "@/lib/invites";
import { currentUser } from "@/lib/session";
import { requestOrigin } from "@/lib/urls";

export type InviteFormState = {
	status: "idle" | "created" | "error";
	message?: string;
	email?: string;
	link?: string;
};

export async function createInvite(_previous: InviteFormState, formData: FormData): Promise<InviteFormState> {
	const owner = await currentUser();
	if (owner?.role !== "owner") return { status: "error", message: "Only the owner can create invites." };

	const email = normalizeEmail(String(formData.get("email") ?? ""));
	if (!isValidEmail(email)) return { status: "error", message: "Enter a valid email address.", email };

	if (await findUserByEmail(email)) {
		return { status: "error", message: "That address already has an account.", email };
	}

	const invitedBy = owner.name?.trim() || owner.email;

	const existing = await findOpenInvite(email);
	if (existing) {
		const link = inviteLink(await requestOrigin(), existing.token);
		return {
			status: "created",
			message: (await deliverInvite({ email, link, invitedBy }))
				? "That address already had an open invite — the email was re-sent."
				: "That address already had an open invite, but the email could not be sent — share this link instead.",
			email,
			link,
		};
	}

	const token = randomBytes(32).toString("base64url");
	await getDb().insert(invites).values({
		token,
		email,
		invitedBy: owner.id,
		expiresAt: inviteExpiry(),
	});

	revalidatePath("/invites");
	const link = inviteLink(await requestOrigin(), token);
	return {
		status: "created",
		message: (await deliverInvite({ email, link, invitedBy }))
			? `Invite emailed to ${email}.`
			: "Invite created, but the email could not be sent — share this link instead.",
		email,
		link,
	};
}

async function deliverInvite(input: { email: string; link: string; invitedBy: string }): Promise<boolean> {
	try {
		await sendInviteEmail(input);
		return true;
	} catch {
		return false;
	}
}
