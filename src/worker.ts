import type { Pool } from "./db.js";
import { config, type Config } from "./config.js";
import { sign } from "./signing.js";
import { backoffMs } from "./backoff.js";

export interface ClaimedDelivery {
  id: string;
  attemptCount: number;
  eventId: string;
  type: string;
  payload: unknown;
  eventCreatedAt: Date;
  url: string;
  secret: string;
}

type FetchFn = typeof fetch;

/**
 * Claim due deliveries.
 *
 * - FOR UPDATE SKIP LOCKED: several workers can run at once; each row is
 *   claimed by exactly one of them and nobody waits on another's locks.
 * - The claim sets a lease (locked_until). If the worker dies, the lease
 *   expires and the row becomes claimable again (status in_flight, expired).
 * - attempt_count is incremented at claim time, so a delivery that keeps
 *   crashing its worker still runs out of attempts instead of looping forever.
 */
export async function claimDue(
  pool: Pool,
  cfg: Config = config,
): Promise<ClaimedDelivery[]> {
  const { rows } = await pool.query(
    `WITH due AS (
       SELECT id FROM deliveries
        WHERE (status = 'pending'   AND next_attempt_at <= now())
           OR (status = 'in_flight' AND locked_until < now())
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE deliveries d
          SET status = 'in_flight',
              attempt_count = d.attempt_count + 1,
              locked_until = now() + ($2 * interval '1 millisecond'),
              updated_at = now()
         FROM due
        WHERE d.id = due.id
        RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count
     )
     SELECT c.id,
            c.attempt_count AS "attemptCount",
            ev.id           AS "eventId",
            ev.type,
            ev.payload,
            ev.created_at   AS "eventCreatedAt",
            ep.url,
            ep.secret
       FROM claimed c
       JOIN events ev    ON ev.id = c.event_id
       JOIN endpoints ep ON ep.id = c.endpoint_id`,
    [cfg.batchSize, cfg.leaseMs],
  );
  return rows;
}

interface AttemptOutcome {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

export async function sendRequest(
  d: ClaimedDelivery,
  cfg: Config,
  fetchFn: FetchFn,
): Promise<AttemptOutcome> {
  // The body is identical on every retry; the event id is the stable key a
  // receiver can use to detect a repeat.
  const body = JSON.stringify({
    id: d.eventId,
    type: d.type,
    createdAt: d.eventCreatedAt,
    data: d.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  try {
    const res = await fetchFn(d.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": d.eventId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sign(d.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      statusCode: res.status,
      error: ok ? null : `HTTP ${res.status}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    // fetch reports a refused/reset connection as "fetch failed"; the
    // underlying code (ECONNREFUSED, ECONNRESET, ...) is what an operator needs.
    const code = e.cause?.code;
    return {
      ok: false,
      statusCode: null,
      error:
        e.name === "TimeoutError" ? "timeout" : code ? `${e.message} (${code})` : e.message,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Record the attempt and move the delivery to its next state.
 *
 * Every UPDATE is fenced on attempt_count: if this worker's lease expired and
 * another worker re-claimed the delivery (bumping attempt_count), this stale
 * result must not overwrite the newer claim. The attempt itself is still
 * logged, because the HTTP request really was sent.
 */
export async function settle(
  pool: Pool,
  d: ClaimedDelivery,
  outcome: AttemptOutcome,
  cfg: Config,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO attempts (delivery_id, status_code, error, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [d.id, outcome.statusCode, outcome.error, outcome.durationMs],
    );

    if (outcome.ok) {
      await client.query(
        `UPDATE deliveries
            SET status = 'succeeded', locked_until = NULL, last_error = NULL,
                updated_at = now()
          WHERE id = $1 AND status = 'in_flight' AND attempt_count = $2`,
        [d.id, d.attemptCount],
      );
    } else if (d.attemptCount >= cfg.maxAttempts) {
      await client.query(
        `UPDATE deliveries
            SET status = 'dead', locked_until = NULL, last_error = $2,
                updated_at = now()
          WHERE id = $1 AND status = 'in_flight' AND attempt_count = $3`,
        [d.id, outcome.error, d.attemptCount],
      );
    } else {
      const delay = backoffMs(d.attemptCount, cfg.baseDelayMs, cfg.maxDelayMs);
      await client.query(
        `UPDATE deliveries
            SET status = 'pending', locked_until = NULL, last_error = $2,
                next_attempt_at = now() + ($3 * interval '1 millisecond'),
                updated_at = now()
          WHERE id = $1 AND status = 'in_flight' AND attempt_count = $4`,
        [d.id, outcome.error, delay, d.attemptCount],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Claim a batch, deliver it concurrently, settle each. Returns batch size. */
export async function processBatch(
  pool: Pool,
  cfg: Config = config,
  fetchFn: FetchFn = fetch,
): Promise<number> {
  const claimed = await claimDue(pool, cfg);
  await Promise.all(
    claimed.map(async (d) => {
      const outcome = await sendRequest(d, cfg, fetchFn);
      await settle(pool, d, outcome, cfg);
    }),
  );
  return claimed.length;
}

export function startWorker(
  pool: Pool,
  cfg: Config = config,
  fetchFn: FetchFn = fetch,
): { stop: () => Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const n = await processBatch(pool, cfg, fetchFn);
        if (n === 0) await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
      } catch (err) {
        console.error("worker error", err);
        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
