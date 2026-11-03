import { randomBytes } from "node:crypto";
import type { Pool } from "./db.js";

export interface IngestInput {
  type: string;
  payload: unknown;
  idempotencyKey?: string;
}

export interface IngestResult {
  eventId: string;
  deliveriesCreated: number;
  duplicate: boolean;
}

/**
 * Persist an event and fan it out to every subscribed endpoint in ONE
 * transaction. The API only answers after COMMIT, so an event that was
 * accepted can never be lost before delivery is attempted.
 *
 * If the sender repeats an idempotency key, we return the original event and
 * create nothing new (safe sender-side retries).
 */
export async function ingestEvent(
  pool: Pool,
  input: IngestInput,
): Promise<IngestResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO events (idempotency_key, type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.idempotencyKey ?? null, input.type, JSON.stringify(input.payload)],
    );

    if (inserted.rowCount === 0) {
      // Same idempotency key seen before: return the original event.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM events WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      await client.query("COMMIT");
      return {
        eventId: existing.rows[0]!.id,
        deliveriesCreated: 0,
        duplicate: true,
      };
    }

    const eventId = inserted.rows[0]!.id;

    const fanout = await client.query(
      `INSERT INTO deliveries (event_id, endpoint_id)
       SELECT $1, e.id FROM endpoints e
       WHERE e.active
         AND (cardinality(e.event_types) = 0 OR $2 = ANY(e.event_types))`,
      [eventId, input.type],
    );

    await client.query("COMMIT");
    return {
      eventId,
      deliveriesCreated: fanout.rowCount ?? 0,
      duplicate: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface EndpointInput {
  url: string;
  secret?: string;
  eventTypes?: string[];
}

export async function createEndpoint(pool: Pool, input: EndpointInput) {
  const secret = input.secret ?? `whsec_${randomBytes(24).toString("hex")}`;
  const { rows } = await pool.query(
    `INSERT INTO endpoints (url, secret, event_types)
     VALUES ($1, $2, $3)
     RETURNING id, url, secret, event_types AS "eventTypes", active, created_at AS "createdAt"`,
    [input.url, secret, input.eventTypes ?? []],
  );
  return rows[0];
}

/** Put a dead-lettered delivery back in the queue. */
export async function replayDelivery(
  pool: Pool,
  deliveryId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE deliveries
        SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
            locked_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'dead'`,
    [deliveryId],
  );
  return (rowCount ?? 0) > 0;
}
