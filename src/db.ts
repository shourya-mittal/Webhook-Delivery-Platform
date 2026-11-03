import pg from "pg";
import { config } from "./config.js";

export function createPool(connectionString = config.databaseUrl): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Fail rather than hang: a stuck connection must not freeze the worker loop.
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
    keepAlive: true,
  });
  // Hosted Postgres can close idle connections. Without a listener, that error
  // on an idle client would crash the process; the pool just opens a new one.
  pool.on("error", (err) => console.error("idle database client error", err.message));
  return pool;
}

export type Pool = pg.Pool;
