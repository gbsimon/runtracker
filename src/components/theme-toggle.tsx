"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { normalizeTheme, THEME_COLOR, THEME_COOKIE, THEME_OPTIONS, type ThemeMode } from "@/lib/theme";

/**
 * Writes the cookie the server reads (see `lib/theme.ts`), then repaints
 * straight away: `data-theme` on <html> and the browser-chrome colour are
 * updated in place so there is no wait for the refresh that re-syncs the
 * server-rendered markup.
 */
function applyTheme(mode: ThemeMode) {
	document.cookie = `${THEME_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
	document.documentElement.dataset.theme = mode;

	for (const meta of document.head.querySelectorAll('meta[name="theme-color"]')) meta.remove();
	const add = (color: string, media?: string) => {
		const meta = document.createElement("meta");
		meta.name = "theme-color";
		meta.content = color;
		if (media) meta.media = media;
		document.head.appendChild(meta);
	};
	if (mode === "auto") {
		add(THEME_COLOR.light, "(prefers-color-scheme: light)");
		add(THEME_COLOR.dark, "(prefers-color-scheme: dark)");
	} else {
		add(THEME_COLOR[mode]);
	}
}

function currentTheme(initial: ThemeMode): ThemeMode {
	if (typeof document === "undefined") return initial;
	return normalizeTheme(document.documentElement.dataset.theme);
}

function Icon({ mode }: { mode: ThemeMode }) {
	const common = {
		width: 14,
		height: 14,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		"aria-hidden": true,
	};
	if (mode === "light")
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
			</svg>
		);
	if (mode === "dark")
		return (
			<svg {...common}>
				<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
			</svg>
		);
	return (
		<svg {...common}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
		</svg>
	);
}

/**
 * `compact` is the header control (three icon buttons); the default is the
 * labelled radio cards used on the Settings page, matching the chat-key one.
 */
export function ThemeToggle({ initial, compact = false }: { initial: ThemeMode; compact?: boolean }) {
	const router = useRouter();
	const [mode, setMode] = useState<ThemeMode>(() => currentTheme(initial));

	function choose(next: ThemeMode) {
		setMode(next);
		applyTheme(next);
		router.refresh();
	}

	if (compact) {
		return (
			<div role="radiogroup" aria-label="Colour theme" className="flex rounded-lg border border-white/10 p-0.5">
				{THEME_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={mode === option.value}
						aria-label={`${option.label} theme`}
						title={`${option.label} (${option.hint})`}
						onClick={() => choose(option.value)}
						className={`flex h-6 w-6 items-center justify-center rounded-md transition ${
							mode === option.value ? "bg-brand-600/20 text-brand-300" : "text-gray-500 hover:text-white"
						}`}
					>
						<Icon mode={option.value} />
					</button>
				))}
			</div>
		);
	}

	return (
		<fieldset>
			<legend className="text-sm font-semibold text-white">Theme</legend>
			<p className="mt-1 text-sm text-gray-400">Dark by default. Auto follows your device&apos;s appearance setting.</p>

			<div className="mt-3 flex flex-col gap-2 sm:flex-row">
				{THEME_OPTIONS.map((option) => (
					<label key={option.value} className="flex-1 cursor-pointer">
						<input
							type="radio"
							name="theme"
							value={option.value}
							checked={mode === option.value}
							onChange={() => choose(option.value)}
							className="peer sr-only"
						/>
						<span className="block rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-center text-gray-300 transition hover:border-white/20 peer-checked:border-brand-500/40 peer-checked:bg-brand-600/15 peer-checked:text-white peer-focus-visible:border-brand-400">
							<span className="block text-sm font-semibold">{option.label}</span>
							<span className="mt-0.5 block text-xs text-gray-500">{option.hint}</span>
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
