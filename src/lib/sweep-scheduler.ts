/**
 * The clock behind the maintenance sweep (`sweep.ts`).
 *
 * Railway runs this web service with sleep off — it has to, or it would miss a
 * webhook — so there is a process available all night and no reason to pay for
 * a second one just to hold a cron entry. `instrumentation.ts` starts this at
 * server boot; it ticks hourly and lets `maybeRunSweep()` decide, which keeps
 * the scheduling rule ("has it been twenty hours") in the database rather than
 * in a timer that a restart would reset.
 *
 * Nothing here may throw. A tick that fails takes the log line and waits for
 * the next hour; a maintenance job is never worth a 500 on someone's run.
 */

import { maybeRunSweep } from "./sweep";

const TICK_MS = 60 * 60 * 1000;

/**
 * Delay before the first tick. Boot is the busiest the process ever is —
 * migrations have just run, the first requests are arriving — and the sweep has
 * waited all night, so it can wait another minute.
 */
const FIRST_TICK_MS = 60_000;

const globalForScheduler = globalThis as typeof globalThis & { __runtrackerSweepTimer?: boolean };

async function tick(): Promise<void> {
	try {
		const outcome = await maybeRunSweep();
		if (outcome.status === "busy") console.log("[sweep] another instance is sweeping — leaving it to them");
		if (outcome.status === "skipped") {
			console.log(`[sweep] not due (last ran ${outcome.lastRunAt ? outcome.lastRunAt.toISOString() : "never"})`);
		}
	} catch (error) {
		console.log(`[sweep] tick failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Idempotent, because a dev server that reloads this module must not end up
 * with two sets of timers. Both timers are `unref`'d: they should never be the
 * reason the process stays alive.
 */
export function startSweepScheduler(): void {
	if (globalForScheduler.__runtrackerSweepTimer) return;

	if (!process.env.DATABASE_URL) {
		console.log("[sweep] scheduler not started — DATABASE_URL is not set");
		return;
	}

	globalForScheduler.__runtrackerSweepTimer = true;
	setTimeout(() => void tick(), FIRST_TICK_MS).unref();
	setInterval(() => void tick(), TICK_MS).unref();
	console.log("[sweep] scheduler armed — hourly tick, sweeping when the last one is over 20h old");
}
