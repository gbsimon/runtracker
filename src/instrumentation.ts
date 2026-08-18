/**
 * Next's server-startup hook: `register` runs once per server instance, before
 * the first request is served.
 *
 * The one thing it starts is the maintenance sweep's timer
 * (`lib/sweep-scheduler.ts`) — item 20's answer to the nightly cron, which lives
 * in this process because the process is already awake at 3am. The import is
 * inside the function and behind the runtime check so the Edge build never
 * pulls in the database client, and it must not block: `register` gates the
 * server becoming ready, and arming a timer is all this does.
 */

export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { startSweepScheduler } = await import("./lib/sweep-scheduler");
	startSweepScheduler();
}
