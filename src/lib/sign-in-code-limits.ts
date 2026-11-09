/**
 * The sign-in code's limits, apart from the crypto in `sign-in-code.ts` so the
 * login UI can quote them without pulling `node:crypto` into the client bundle.
 */

export const CODE_LENGTH = 6;
/** Much shorter than the link's 24 hours: a code is guessable, a link token isn't. */
export const CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_TTL_MINUTES = CODE_TTL_MS / 60_000;
/** Wrong guesses a code survives before it is burnt. */
export const MAX_CODE_ATTEMPTS = 5;
