import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Pool } from "./db.js";
import { createEndpoint, ingestEvent, replayDelivery } from "./events.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["pending", "in_flight", "succeeded", "dead"];

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap =
  (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function createApp(pool: Pool) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Open CORS so the dashboard dev server can call the API.
  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type,idempotency-key");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", wrap(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  }));

  // --- endpoints ---------------------------------------------------------
  app.post("/endpoints", wrap(async (req, res) => {
    const { url, secret, eventTypes } = req.body ?? {};
    if (!isHttpUrl(url)) return res.status(400).json({ error: "url must be http(s)" });
    if (
      eventTypes !== undefined &&
      !(Array.isArray(eventTypes) && eventTypes.every((t) => typeof t === "string"))
    ) {
      return res.status(400).json({ error: "eventTypes must be an array of strings" });
    }
    const endpoint = await createEndpoint(pool, { url, secret, eventTypes });
    res.status(201).json(endpoint);
  }));

  app.get("/endpoints", wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, url, event_types AS "eventTypes", active, created_at AS "createdAt"
         FROM endpoints ORDER BY created_at`,
    );
    res.json(rows);
  }));

  // --- events ------------------------------------------------------------
  app.post("/events", wrap(async (req, res) => {
    const { type, payload } = req.body ?? {};
    const idempotencyKey =
      (req.header("idempotency-key") as string | undefined) ??
      req.body?.idempotencyKey;
    if (typeof type !== "string" || type.length === 0) {
      return res.status(400).json({ error: "type is required" });
    }
    if (payload === undefined) {
      return res.status(400).json({ error: "payload is required" });
    }
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
      return res.status(400).json({ error: "idempotency key must be a string" });
    }
    const result = await ingestEvent(pool, { type, payload, idempotencyKey });
    // 202: accepted for asynchronous delivery. 200 for a repeated key.
    res.status(result.duplicate ? 200 : 202).json(result);
  }));

  app.get("/events/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "bad id" });
    const ev = await pool.query(
      `SELECT id, type, payload, idempotency_key AS "idempotencyKey",
              created_at AS "createdAt" FROM events WHERE id = $1`,
      [id],
    );
    if (ev.rowCount === 0) return res.status(404).json({ error: "not found" });
    const deliveries = await pool.query(
      `SELECT id, endpoint_id AS "endpointId", status,
              attempt_count AS "attemptCount", next_attempt_at AS "nextAttemptAt",
              last_error AS "lastError"
         FROM deliveries WHERE event_id = $1 ORDER BY created_at`,
      [id],
    );
    res.json({ ...ev.rows[0], deliveries: deliveries.rows });
  }));

  // --- deliveries --------------------------------------------------------
  app.get("/deliveries", wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: "bad status" });
    }
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const { rows } = await pool.query(
      `SELECT d.id, d.status, d.attempt_count AS "attemptCount",
              d.next_attempt_at AS "nextAttemptAt", d.last_error AS "lastError",
              d.updated_at AS "updatedAt",
              ev.id AS "eventId", ev.type, ep.url
         FROM deliveries d
         JOIN events ev    ON ev.id = d.event_id
         JOIN endpoints ep ON ep.id = d.endpoint_id
        WHERE ($1::text IS NULL OR d.status = $1)
        ORDER BY d.updated_at DESC
        LIMIT $2`,
      [status ?? null, limit],
    );
    res.json(rows);
  }));

  app.get("/deliveries/:id/attempts", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "bad id" });
    const { rows } = await pool.query(
      `SELECT id, attempted_at AS "attemptedAt", status_code AS "statusCode",
              error, duration_ms AS "durationMs"
         FROM attempts WHERE delivery_id = $1 ORDER BY id`,
      [id],
    );
    res.json(rows);
  }));

  app.post("/deliveries/:id/replay", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "bad id" });
    const ok = await replayDelivery(pool, id);
    if (!ok) {
      return res.status(409).json({ error: "only dead deliveries can be replayed" });
    }
    res.json({ replayed: true });
  }));

  // --- stats for the dashboard ------------------------------------------
  app.get("/stats", wrap(async (_req, res) => {
    const byStatus = await pool.query(
      `SELECT status, count(*)::int AS count FROM deliveries GROUP BY status`,
    );
    const latency = await pool.query(
      `SELECT count(*)::int AS attempts,
              coalesce(round(avg(duration_ms)), 0)::int AS "avgMs",
              coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS "p95Ms"
         FROM attempts WHERE attempted_at > now() - interval '1 hour'`,
    );
    const volume = await pool.query(
      `SELECT date_trunc('minute', created_at) AS minute, count(*)::int AS events
         FROM events WHERE created_at > now() - interval '1 hour'
        GROUP BY 1 ORDER BY 1`,
    );
    const counts: Record<string, number> = {
      pending: 0, in_flight: 0, succeeded: 0, dead: 0,
    };
    for (const r of byStatus.rows) counts[r.status] = r.count;
    res.json({ deliveries: counts, lastHour: latency.rows[0], volume: volume.rows });
  }));

  // Error handler: never leak internals.
  type HttpError = Error & { status?: number; type?: string };
  app.use((err: HttpError, _req: Request, res: Response, _next: NextFunction) => {
    // The JSON body parser flags client mistakes (bad JSON, body too large)
    // with a 4xx status; those are the sender's fault, not a server error.
    if (err.status && err.status >= 400 && err.status < 500) {
      const error =
        err.type === "entity.parse.failed" ? "invalid JSON body"
        : err.type === "entity.too.large" ? "body too large"
        : "bad request";
      return res.status(err.status).json({ error });
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
