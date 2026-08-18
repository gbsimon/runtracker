/**
 * Lets plain `node --experimental-strip-types` load the app's modules: it
 * resolves the `@/*` alias from `tsconfig.json` and fills in the extensions
 * bundlers add for free but Node insists on. Only used by the check scripts —
 * Next.js resolves both itself.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

function isFile(url) {
	try {
		return statSync(fileURLToPath(url)).isFile();
	} catch {
		return false;
	}
}

export async function resolve(specifier, context, nextResolve) {
	const mapped = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;

	if (mapped.startsWith(".") || mapped.startsWith("/") || mapped.startsWith("file:")) {
		const base = new URL(mapped, context.parentURL ?? import.meta.url).href;
		for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
			if (isFile(candidate)) return nextResolve(candidate, context);
		}
	}

	return nextResolve(mapped, context);
}
