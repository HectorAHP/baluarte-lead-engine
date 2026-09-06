/**
 * Fase 7C spec §9 -- deterministic backoff schedule and error classification for the HubSpot
 * outbox. Pure, side-effect-free -- no I/O, no repository access, easy to assert on in isolation.
 */

/** Index 0 = delay before attempt 2 (attempt 1 is always immediate, at write time). Index i =
 * delay before attempt i+2. Past the end of this array, MAX_ATTEMPTS below is what actually stops
 * retries -- never an infinite loop, and never a delay beyond the last entry. */
const BACKOFF_SCHEDULE_MS: readonly number[] = [
  60_000, // attempt 2: +1 min
  5 * 60_000, // attempt 3: +5 min
  15 * 60_000, // attempt 4: +15 min
  60 * 60_000, // attempt 5: +1 h
  6 * 60 * 60_000, // attempt 6: +6 h
];

export const DEFAULT_MAX_ATTEMPTS = 6;

/** `attemptCount` is the number of attempts ALREADY made (0 before the first try). Returns the
 * delay in ms before the NEXT attempt is eligible. Never negative, never unbounded -- clamps to
 * the schedule's last entry for any attemptCount beyond it (a caller should have already stopped
 * retrying by MAX_ATTEMPTS, but this never produces a nonsensical value if called anyway). */
export function computeNextAttemptDelayMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0; // first attempt -- immediate
  const index = Math.min(attemptCount - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[index];
}

export function computeNextAttemptAt(attemptCount: number, now: Date): Date {
  return new Date(now.getTime() + computeNextAttemptDelayMs(attemptCount));
}

export type HubSpotSyncErrorClassification = "RETRYABLE" | "PERMANENT";

/**
 * Fase 7C spec §9 -- retryable: network/timeout, 429, 5xx. Permanent: bad payload/schema (4xx
 * other than 429), auth failure (401/403 -- a config problem, not a per-submission one, but
 * retrying THIS row won't fix it either way; the operator must fix the token/scope and the row
 * stays inspectable in FAILED_PERMANENT rather than retried forever). `undefined` httpStatus (a
 * thrown network/timeout error, never reaching HTTP) is always RETRYABLE.
 */
export function classifyHubSpotSyncError(httpStatus: number | undefined): HubSpotSyncErrorClassification {
  if (httpStatus === undefined) return "RETRYABLE"; // network failure / timeout -- no response at all
  if (httpStatus === 429) return "RETRYABLE";
  if (httpStatus >= 500) return "RETRYABLE";
  return "PERMANENT"; // 400/401/403/404/422/... -- retrying the exact same payload will not help
}

/**
 * Fase 7C.1 §9 -- 401/403 are PERMANENT at the job level (retrying the same row will not help),
 * but unlike a genuinely bad/invalid lead (400/404/422), a 401/403 almost always means the
 * HubSpot private-app token/scope is wrong or expired -- a config problem affecting the WHOLE
 * batch, not one bad row. The processor uses this to emit a distinct, more actionable log outcome
 * ("failed_permanent_auth_error") instead of the generic "failed_permanent", so this never gets
 * silently read as "just an invalid lead" during on-call triage.
 */
export function isAuthErrorStatus(httpStatus: number | undefined): boolean {
  return httpStatus === 401 || httpStatus === 403;
}
