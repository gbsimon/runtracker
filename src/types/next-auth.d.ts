import type { DefaultSession } from "next-auth";
import type { UserRole } from "@/db/schema";

declare module "next-auth" {
	interface Session {
		user: {
			id: string;
			role: UserRole;
		} & DefaultSession["user"];
	}

	interface User {
		role?: UserRole;
	}
}
