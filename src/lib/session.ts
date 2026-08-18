import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/db";
import { users } from "@/db/schema";

export type AppUser = typeof users.$inferSelect;

/**
 * The session JWT carries id and role, but it outlives a role change or a
 * deleted account, so the user is always re-read. `hasSession` distinguishes
 * "signed out" from "holds a token whose account is gone" — the caller has to
 * treat the second case as signed out too.
 */
export async function resolveUser(): Promise<{ hasSession: boolean; user: AppUser | null }> {
	const session = await auth();
	const id = session?.user?.id;
	if (!id) return { hasSession: false, user: null };

	const [user] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
	return { hasSession: true, user: user ?? null };
}

export async function currentUser(): Promise<AppUser | null> {
	return (await resolveUser()).user;
}

export async function requireUser(): Promise<AppUser> {
	const user = await currentUser();
	if (!user) redirect("/login");
	return user;
}

/** Members get a 404 rather than a hint that the page exists. */
export async function requireOwner(): Promise<AppUser> {
	const user = await requireUser();
	if (user.role !== "owner") notFound();
	return user;
}
