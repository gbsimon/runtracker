/**
 * Lets a button elsewhere on the page start a conversation with the coach.
 *
 * The chat is mounted once in the root layout and owns its thread from then
 * on, so a server-inserted message would never reach a thread that is already
 * on screen. A window event reaches it directly, and the message then goes
 * through the normal `/api/coach/message` path — budget check included — as
 * if the runner had typed it. Client-only.
 */

export const COACH_SEND_EVENT = "runtracker:coach-send";

export function sendToCoach(text: string): void {
	window.dispatchEvent(new CustomEvent<string>(COACH_SEND_EVENT, { detail: text }));
}
