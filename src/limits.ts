/**
 * Platform limits that both sides of the wire have to agree on. Its own module
 * because the API enforces them and the admin form has to print the same
 * numbers, and importing `src/admin.ts` into the client would pull Hono and zod
 * into the browser bundle to read one integer.
 */

/** The cron trigger cannot fire faster than once a minute. */
export const MIN_INTERVAL_SECONDS = 60;

/** D1 Free: rows written per day. */
export const WRITE_LIMIT_PER_DAY = 100_000;

/** Workers Free: external subrequests per invocation, which is one cron tick. */
export const SUBREQUEST_LIMIT = 50;
