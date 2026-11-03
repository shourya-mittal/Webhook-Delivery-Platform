export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://postgres@localhost:5433/postgres",
  port: Number(process.env.PORT ?? 3000),
  // When set, POST /events and POST /endpoints require this key. Required when
  // NODE_ENV=production; left unset for local development.
  apiKey: process.env.API_KEY || undefined,
  // Replay is public on the hosted demo, so it is capped across all callers.
  replayPerMinute: Number(process.env.REPLAY_PER_MINUTE ?? 30),
  // Delivery policy
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 5),
  baseDelayMs: Number(process.env.BASE_DELAY_MS ?? 5000),
  maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 15 * 60 * 1000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 10000),
  // A claimed delivery is invisible to other workers until this lease expires.
  // If a worker dies mid-delivery, the lease expires and another worker retries.
  leaseMs: Number(process.env.LEASE_MS ?? 30000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1000),
  batchSize: Number(process.env.BATCH_SIZE ?? 10),
};

export type Config = typeof config;
