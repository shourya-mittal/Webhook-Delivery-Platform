/**
 * Exponential backoff with "full jitter".
 * attempt 1 failed -> wait up to base, attempt 2 -> up to 2*base, 4*base, ...
 * capped at maxDelayMs. Jitter spreads retries so a recovering receiver is not
 * hit by every failed delivery at the same instant.
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}
