import { ThemeToggle } from "@/components/theme-toggle";
import type { ThemeMode } from "@/lib/theme";
import { signOutAction } from "@/lib/auth-actions";

export function UserMenu({ email, theme }: { email: string; theme: ThemeMode }) {
	return (
		<div className="flex items-center gap-3">
			{/* Below `sm:` the address ran into the wordmark; Sign out stays. */}
			<span className="hidden max-w-[10rem] truncate text-xs text-gray-400 sm:block sm:max-w-none" title={email}>
				{email}
			</span>
			<ThemeToggle initial={theme} compact />
			<form action={signOutAction}>
				<button
					type="submit"
					className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-gray-300 transition hover:border-white/20 hover:text-white"
				>
					Sign out
				</button>
			</form>
		</div>
	);
}
