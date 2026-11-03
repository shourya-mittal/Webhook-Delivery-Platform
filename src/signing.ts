import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signature scheme: HMAC-SHA256 over `${timestamp}.${body}`.
 * Including the timestamp lets receivers reject replayed old requests.
 */
export function sign(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `v1=${mac}`;
}

/** What a receiver would run to verify a request (also used in our tests). */
export function verify(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
