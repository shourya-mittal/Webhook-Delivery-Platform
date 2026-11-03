import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { migrate } from "../src/migrate.js";
import { config, type Config } from "../src/config.js";
import { processBatch } from "../src/worker.js";

const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5433/postgres";
const TEST_DB = "webhook_test";

export const testConfig: Config = {
  ...config,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
  requestTimeoutMs: 300,
  leaseMs: 250,
  pollIntervalMs: 5,
  batchSize: 10,
};

export async function setupDb(): Promise<pg.Pool> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEST_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const pool = new pg.Pool({
    connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`),
    max: 10,
  });
  await migrate(pool);
  return pool;
}

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE attempts, deliveries, events, endpoints CASCADE`);
}

export interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A controllable fake receiver. `respond` decides each reply; returning
 * "hang" never answers (used to trigger the request timeout).
 */
export async function startReceiver(
  respond: (n: number) => number | "hang" = () => 200,
) {
  const received: Received[] = [];
  const hung: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const r = respond(received.length);
      if (r === "hang") {
        hung.push(res);
        return;
      }
      res.statusCode = r;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: async () => {
      hung.forEach((r) => r.destroy());
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Run worker batches until `done()` is true or we time out. */
export async function drainUntil(
  pool: pg.Pool,
  done: () => Promise<boolean>,
  cfg: Config = testConfig,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await processBatch(pool, cfg, fetchFn);
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("drainUntil timed out");
}

export async function deliveryStatus(pool: pg.Pool, id?: string) {
  const { rows } = await pool.query(
    id
      ? `SELECT status, attempt_count AS "attemptCount" FROM deliveries WHERE id = $1`
      : `SELECT status, attempt_count AS "attemptCount" FROM deliveries LIMIT 1`,
    id ? [id] : [],
  );
  return rows[0] as { status: string; attemptCount: number };
}
