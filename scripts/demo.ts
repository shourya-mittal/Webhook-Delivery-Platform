// School-bus demo: one command runs the whole story in a single process.
//
//   npm run demo        (then, in another terminal: npm run dashboard)
//
// A simulated bus publishes "bus.arrived" events to the real API on :3000.
// Three receivers are registered as endpoints:
//   - parent notifications: healthy, a little slow
//   - school office log:    healthy, fails ~10% of requests (retries recover)
//   - district SMS gateway: deliberately flaky; it goes through outages where
//     it answers 503 or hangs until the request times out. Deliveries that run
//     out of attempts during an outage are dead-lettered; replay them from the
//     dashboard once the gateway is back up.
//
// Uses its own database (webhook_demo), wiped on every start. All data is
// simulated.
import http from "node:http";
import pg from "pg";
import { config, type Config } from "../src/config.js";
import { createEndpoint } from "../src/events.js";
import { migrate } from "../src/migrate.js";
import { createApp } from "../src/server.js";
import { verify } from "../src/signing.js";
import { startWorker } from "../src/worker.js";

const DEMO_DB = "webhook_demo";
const API_PORT = Number(process.env.PORT ?? 3000);
const OUTAGE_MS = Number(process.env.OUTAGE_MS ?? 40_000);
const UPTIME_MS = Number(process.env.UPTIME_MS ?? 45_000);
const BUS_INTERVAL_MS = Number(process.env.BUS_INTERVAL_MS ?? 4000);

// A tighter retry policy than production so the whole cycle (retry, give up,
// dead-letter) happens in seconds instead of minutes.
const demoConfig: Config = {
  ...config,
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  requestTimeoutMs: 3000,
  leaseMs: 10_000,
  pollIntervalMs: 250,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (who: string, msg: string) =>
  console.log(`${new Date().toLocaleTimeString()}  ${who.padEnd(14)} ${msg}`);

async function demoPool(): Promise<pg.Pool> {
  const admin = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DEMO_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DEMO_DB}`);
  await admin.end();
  const pool = new pg.Pool({
    connectionString: config.databaseUrl.replace(/\/[^/]*$/, `/${DEMO_DB}`),
    max: 10,
  });
  await migrate(pool);
  await pool.query(`TRUNCATE attempts, deliveries, events, endpoints CASCADE`);
  return pool;
}

type Behaviour = () => { status: number; delayMs: number } | "hang";

/** A receiver that verifies the platform's signature, like a real one would. */
function startReceiver(port: number, who: string, behave: Behaviour, getSecret: () => string) {
  const seen = new Set<string>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const id = String(req.headers["webhook-id"]);
      const ok = verify(
        getSecret(),
        Number(req.headers["webhook-timestamp"]),
        body,
        String(req.headers["webhook-signature"]),
      );
      if (!ok) {
        log(who, `rejected ${id.slice(0, 8)}: bad signature`);
        res.statusCode = 401;
        return res.end();
      }
      const b = behave();
      if (b === "hang") {
        log(who, `${id.slice(0, 8)} … hanging (will time out)`);
        return; // never answer; the worker's timeout fires
      }
      await sleep(b.delayMs);
      res.statusCode = b.status;
      res.end();
      if (b.status >= 200 && b.status < 300) {
        // At-least-once delivery: the same event id can arrive twice; a real
        // receiver dedupes on it. We just say so.
        const repeat = seen.has(id);
        seen.add(id);
        const stop = JSON.parse(body).data?.stop?.name ?? "";
        log(who, `${id.slice(0, 8)} ${b.status} ${repeat ? "(repeat, ignored)" : `ok  ${stop}`}`);
      } else {
        log(who, `${id.slice(0, 8)} ${b.status} failed`);
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const STOPS = [
  "Maple St & 3rd Ave", "Oakridge Library", "Pine Grove Apartments", "Cedar Park",
  "Willow Creek Rd", "Lakeside Community Center", "Birch Lane", "Greenfield Elementary",
];

async function main() {
  const pool = await demoPool();

  // The flaky gateway alternates between up and down on a fixed cycle.
  let flakyDown = false;
  const cycle = async () => {
    for (;;) {
      flakyDown = false;
      log("sms-gateway", `UP for ${UPTIME_MS / 1000}s`);
      await sleep(UPTIME_MS);
      flakyDown = true;
      log("sms-gateway", `DOWN for ${OUTAGE_MS / 1000}s (503s and timeouts)`);
      await sleep(OUTAGE_MS);
    }
  };

  const secrets: Record<string, string> = {};
  const receivers = [
    startReceiver(4001, "parent-app", () => ({ status: 200, delayMs: 80 + Math.random() * 120 }), () => secrets.parent!),
    startReceiver(4002, "school-office", () => ({ status: Math.random() < 0.1 ? 500 : 200, delayMs: 20 + Math.random() * 40 }), () => secrets.office!),
    startReceiver(
      4003,
      "sms-gateway",
      () => (flakyDown ? (Math.random() < 0.3 ? "hang" : { status: 503, delayMs: 50 }) : { status: 200, delayMs: 150 + Math.random() * 250 }),
      () => secrets.sms!,
    ),
  ];

  const eps = [
    { key: "parent", name: "Parent notifications", url: "http://127.0.0.1:4001/webhooks/bus" },
    { key: "office", name: "School office log", url: "http://127.0.0.1:4002/hooks" },
    { key: "sms", name: "District SMS gateway (flaky)", url: "http://127.0.0.1:4003/inbound" },
  ];
  for (const e of eps) {
    const created = await createEndpoint(pool, { url: e.url, name: e.name, eventTypes: ["bus.arrived"] });
    secrets[e.key] = created.secret;
  }

  const server = createApp(pool).listen(API_PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const worker = startWorker(pool, demoConfig);
  log("platform", `API on http://localhost:${API_PORT}, worker running, database ${DEMO_DB}`);
  log("platform", `dashboard: run \`npm run dashboard\` and open http://localhost:5173`);
  void cycle();

  // The bus drives its route on a loop, publishing an event at each stop.
  let running = true;
  const bus = (async () => {
    for (let n = 0; running; n++) {
      const stop = STOPS[n % STOPS.length]!;
      const key = `bus-12-trip-${Math.floor(n / STOPS.length)}-stop-${n % STOPS.length}`;
      const event = {
        type: "bus.arrived",
        idempotencyKey: key,
        payload: {
          busId: "bus-12",
          route: "Route 12 (morning)",
          stop: { index: n % STOPS.length, name: stop },
          studentsBoarding: 1 + Math.floor(Math.random() * 6),
          arrivedAt: new Date().toISOString(),
        },
      };
      const post = () =>
        fetch(`http://127.0.0.1:${API_PORT}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(event),
        }).then((r) => r.json() as Promise<{ eventId: string; duplicate: boolean }>);
      const res = await post();
      log("bus-12", `arrived at ${stop} → event ${res.eventId.slice(0, 8)}`);
      // Every so often the bus's flaky uplink resends; the key makes it a no-op.
      if (n % 5 === 4) {
        const again = await post();
        log("bus-12", `resent same event (uplink retry) → duplicate=${again.duplicate}, no new deliveries`);
      }
      await sleep(BUS_INTERVAL_MS);
    }
  })();

  const shutdown = async () => {
    log("platform", "shutting down");
    running = false;
    server.close();
    receivers.forEach((r) => r.closeAllConnections());
    await worker.stop();
    await bus.catch(() => {});
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
