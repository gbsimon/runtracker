import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { authConfig } from "@/auth.config";
import { getDb } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { claimInvite, isSignInAllowed } from "@/lib/auth-access";
import { authEmailFrom, sendMagicLink } from "@/lib/auth-email";

/**
 * Where Auth.js sends the browser after it accepts a magic-link request.
 * Relative, so the `redirect` callback resolves it against the request origin
 * exactly as it does for a real send. `/api/auth` is next-auth's default
 * `basePath`.
 */
const NEUTRAL_SIGN_IN_REDIRECT = "/api/auth/verify-request?provider=resend&type=email";

/**
 * The config is built lazily so importing this module never opens a database
 * connection — `next build` imports it while collecting page data.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
	...authConfig,
	adapter: DrizzleAdapter(getDb(), {
		usersTable: users,
		accountsTable: accounts,
		sessionsTable: sessions,
		verificationTokensTable: verificationTokens,
	}),
	providers: [
		Resend({
			// `sendMagicLink` reads the key itself; this only keeps the
			// provider coherent if the custom sender is ever dropped.
			apiKey: process.env.RESEND_API_KEY ?? "",
			from: authEmailFrom(),
			sendVerificationRequest: sendMagicLink,
		}),
	],
	callbacks: {
		...authConfig.callbacks,
		/**
		 * Runs twice per magic link: once before the mail is sent (with
		 * `email.verificationRequest`) and once when the link is followed.
		 * Refusing the first pass means no mail leaves and no verification
		 * token is written.
		 */
		async signIn({ user, email }) {
			if (user.email && (await isSignInAllowed(user.email))) return true;
			console.info(`[auth] refused sign-in for ${user.email ?? "<no address>"} (no account, no open invite)`);

			// Answering the pre-send refusal with the redirect a successful
			// send produces keeps `/api/auth/signin/resend` from working as an
			// address oracle: both outcomes are byte-identical to the client.
			// At link-click time a string would instead skip the sign-in and
			// redirect, so only this branch may return one.
			return email?.verificationRequest ? NEUTRAL_SIGN_IN_REDIRECT : false;
		},
	},
	events: {
		/** Only fires for a first-time sign-in, i.e. exactly when an invite was spent. */
		async createUser({ user }) {
			if (user.email) await claimInvite(user.email);
		},
	},
}));
