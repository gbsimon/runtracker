import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { invites, users } from "@/db/schema";

/** Auth.js lowercases identifiers before the sign-in callback; do the same everywhere else. */
export function normalizeEmail(email: string): string {
	return email.normalize("NFKC").trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@"]+@[^\s@",]+\.[^\s@",]+$/;

export function isValidEmail(email: string): boolean {
	return EMAIL_PATTERN.test(email) && email.length <= 254;
}

export async function findUserByEmail(email: string) {
	const [user] = await getDb()
		.select()
		.from(users)
		.where(eq(users.email, normalizeEmail(email)))
		.limit(1);
	return user ?? null;
}

/** The open (unused, unexpired) invite for an address, oldest first. */
export async function findOpenInvite(email: string) {
	const [invite] = await getDb()
		.select()
		.from(invites)
		.where(
			and(eq(invites.email, normalizeEmail(email)), isNull(invites.usedAt), gt(invites.expiresAt, new Date())),
		)
		.orderBy(asc(invites.createdAt))
		.limit(1);
	return invite ?? null;
}

export async function findOpenInviteByToken(token: string) {
	const [invite] = await getDb()
		.select()
		.from(invites)
		.where(and(eq(invites.token, token), isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
		.limit(1);
	return invite ?? null;
}

/**
 * Invite-only gate. Sign-in is allowed for an address that already has an
 * account, or one holding an open invite. Everything else is refused before
 * Auth.js sends a mail or writes a row.
 */
export async function isSignInAllowed(email: string): Promise<boolean> {
	if (!isValidEmail(normalizeEmail(email))) return false;
	if (await findUserByEmail(email)) return true;
	return Boolean(await findOpenInvite(email));
}

/** Stamps the invite that admitted a brand-new user. No-op if there wasn't one. */
export async function claimInvite(email: string): Promise<void> {
	const invite = await findOpenInvite(email);
	if (!invite) return;
	await getDb().update(invites).set({ usedAt: new Date() }).where(eq(invites.id, invite.id));
}
