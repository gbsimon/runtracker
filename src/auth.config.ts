import type { NextAuthConfig } from "next-auth";

/**
 * Paths that stay reachable without a session:
 * - `/login` and Auth.js's own routes, or sign-in could never happen;
 * - `/api/ingest/*`, which is authenticated by device tokens (Health Auto
 *   Export posts from a phone, it has no cookie jar).
 */
export const PUBLIC_PATHS = ["/login", "/api/auth", "/api/ingest"];

/** Request header `proxy.ts` uses to tell layouts which path is being rendered. */
export const PATHNAME_HEADER = "x-runtracker-pathname";

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * The half of the Auth.js config that carries no database dependency, so it
 * can be instantiated inside `proxy.ts` to verify the session JWT. `auth.ts`
 * spreads this and adds the Drizzle adapter, the Resend provider, and the
 * invite gating.
 */
export const authConfig = {
	providers: [],
	// JWT sessions: `proxy.ts` runs on every request and Next's docs are
	// explicit that proxy should not do data fetching, so the session check
	// has to be verifiable from the cookie alone. Role changes need a
	// re-login to reach the token; anything authoritative (the /invites
	// gate) re-reads the user row instead of trusting the claim.
	session: { strategy: "jwt" },
	pages: {
		signIn: "/login",
		// Auth.js appends `?<incoming search>` / `?error=<type>` to these, so
		// they must not carry a query string of their own.
		verifyRequest: "/login",
		error: "/login",
	},
	callbacks: {
		jwt({ token, user }) {
			// `user` is only present on the sign-in call; it is the row the
			// adapter just read/created, so it already carries `role`.
			if (user) token.role = user.role ?? "member";
			return token;
		},
		session({ session, token }) {
			if (token.sub) session.user.id = token.sub;
			// `JWT` is an open record, so the claim is validated rather than cast —
			// a token minted before a role rename shouldn't smuggle a bad value in.
			session.user.role = token.role === "owner" ? "owner" : "member";
			return session;
		},
	},
} satisfies NextAuthConfig;
