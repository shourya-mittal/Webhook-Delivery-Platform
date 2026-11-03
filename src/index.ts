import { config } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { createApp } from "./server.js";
import { startWorker } from "./worker.js";

// Fail closed: never run a production API with its write endpoints open.
if (process.env.NODE_ENV === "production" && !config.apiKey) {
  console.error("API_KEY is required when NODE_ENV=production");
  process.exit(1);
}

const pool = createPool();
await migrate(pool);

const app = createApp(pool);
const server = app.listen(config.port, () =>
  console.log(`API listening on :${config.port}`),
);

// In one process for simplicity. Workers only talk to Postgres, so they can
// also be run as separate processes (more workers = more throughput).
const worker = startWorker(pool);

async function shutdown() {
  console.log("shutting down");
  server.close();
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
