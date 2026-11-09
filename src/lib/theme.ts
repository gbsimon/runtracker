/**
 * Colour-mode plumbing with no server dependency, so the client toggle can use
 * it too. The choice lives in a cookie (not the database) so the server can
 * put the right `data-theme` on `<html>` before first paint, and so it works
 * on /login where nobody is signed in.
 */

export const THEME_COOKIE = "theme";

export type ThemeMode = "auto" | "light" | "dark";

/** What nothing-set means. Dark is the app's original look. */
export const DEFAULT_THEME: ThemeMode = "dark";

export const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
	{ value: "auto", label: "Auto", hint: "Follows your device" },
	{ value: "light", label: "Light", hint: "Jour" },
	{ value: "dark", label: "Dark", hint: "Nuit" },
];

export function normalizeTheme(value: string | null | undefined): ThemeMode {
	return value === "auto" || value === "light" || value === "dark" ? value : DEFAULT_THEME;
}

/** Browser chrome colours: the dark body's base, and the light page background. */
export const THEME_COLOR = { dark: "#0a0a1a", light: "#f4f6fb" } as const;
