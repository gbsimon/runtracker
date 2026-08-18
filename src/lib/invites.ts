/** Invite helpers with no database dependency, so client components can use them. */

export const INVITE_TTL_DAYS = 7;

export function inviteExpiry(from = new Date()): Date {
	return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** The invited address still signs in normally; the token only prefills the form. */
export function inviteLink(origin: string, token: string): string {
	return `${origin}/login?invite=${encodeURIComponent(token)}`;
}

export type InviteStatus = "pending" | "used" | "expired";

export function inviteStatus(invite: { usedAt: Date | null; expiresAt: Date }, now = new Date()): InviteStatus {
	if (invite.usedAt) return "used";
	return invite.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}
