import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { createEndpoint, ingestEvent, replayDelivery } from "../src/events.js";
import { claimDue, processBatch, settle } from "../src/worker.js";
import { verify } from "../src/signing.js";
import { backoffMs } from "../src/backoff.js";
import {
  deliveryStatus,
  drainUntil,
  resetDb,
  setupDb,
  startReceiver,
  testConfig,
} from "./helpers.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await setupDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

describe("happy path", () => {
  it("delivers a signed request the receiver can verify", async () => {
    const rcv = await startReceiver();
    const ep = await createEndpoint(pool, { url: rcv.url });
    await ingestEvent(pool, { type: "order.paid", payload: { orderId: 42 } });

    await drainUntil(pool, async () => (await deliveryStatus(pool)).status === "succeeded");

    expect(rcv.received).toHaveLength(1);
    const { headers, body } = rcv.received[0]!;
    expect(JSON.parse(body).data).toEqual({ orderId: 42 });
    expect(
      verify(
        ep.secret,
        Number(headers["webhook-timestamp"]),
        body,
        String(headers["webhook-signature"]),
      ),
    ).toBe(true);
    // A tampered body must fail verification.
    expect(
      verify(ep.secret, Number(headers["webhook-timestamp"]), body + " ", String(headers["webhook-signature"])),
    ).toBe(false);
    await rcv.close();
  });

  it("only fans out to endpoints subscribed to the event type", async () => {
    const a = await startReceiver();
    const b = await startReceiver();
    await createEndpoint(pool, { url: a.url, eventTypes: ["bus.arrived"] });
    await createEndpoint(pool, { url: b.url, eventTypes: ["order.paid"] });
    const res = await ingestEvent(pool, { type: "bus.arrived", payload: {} });
    expect(res.deliveriesCreated).toBe(1);
    await a.close();
    await b.close();
  });
});

describe("failure paths", () => {
  it("retries a failing receiver and succeeds once it recovers", async () => {
    const rcv = await startReceiver((n) => (n < 3 ? 500 : 200));
    await createEndpoint(pool, { url: rcv.url });
    await ingestEvent(pool, { type: "t", payload: {} });

    await drainUntil(pool, async () => (await deliveryStatus(pool)).status === "succeeded");

    expect(rcv.received).toHaveLength(3);
    const s = await deliveryStatus(pool);
    expect(s.attemptCount).toBe(3);
    const { rows } = await pool.query(`SELECT status_code FROM attempts ORDER BY id`);
    expect(rows.map((r) => r.status_code)).toEqual([500, 500, 200]);
    await rcv.close();
  });

  it("dead-letters after max attempts, then replay delivers it", async () => {
    let healthy = false;
    const rcv = await startReceiver(() => (healthy ? 200 : 503));
    await createEndpoint(pool, { url: rcv.url });
    await ingestEvent(pool, { type: "t", payload: {} });

    await drainUntil(pool, async () => (await deliveryStatus(pool)).status === "dead");
    expect(rcv.received).toHaveLength(testConfig.maxAttempts);

    // Dead deliveries are not picked up again on their own.
    expect(await processBatch(pool, testConfig)).toBe(0);

    healthy = true;
    const { rows } = await pool.query(`SELECT id FROM deliveries`);
    expect(await replayDelivery(pool, rows[0].id)).toBe(true);
    await drainUntil(pool, async () => (await deliveryStatus(pool)).status === "succeeded");
    // Replaying a delivery that is not dead is refused.
    expect(await replayDelivery(pool, rows[0].id)).toBe(false);
    await rcv.close();
  });

  it("treats a request timeout as a failed attempt", async () => {
    const rcv = await startReceiver(() => "hang");
    await createEndpoint(pool, { url: rcv.url });
    await ingestEvent(pool, { type: "t", payload: {} });

    await processBatch(pool, testConfig);

    const { rows } = await pool.query(`SELECT error, status_code FROM attempts`);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBe("timeout");
    expect(rows[0].status_code).toBeNull();
    expect((await deliveryStatus(pool)).status).toBe("pending");
    await rcv.close();
  });

  it("recovers a delivery whose worker died mid-flight (lease expiry)", async () => {
    const rcv = await startReceiver();
    await createEndpoint(pool, { url: rcv.url });
    await ingestEvent(pool, { type: "t", payload: {} });

    // Worker A claims the delivery and then "crashes": it never settles it.
    const claimedByA = await claimDue(pool, testConfig);
    expect(claimedByA).toHaveLength(1);
    expect((await deliveryStatus(pool)).status).toBe("in_flight");

    // While the lease is valid, worker B must not take it.
    expect(await claimDue(pool, testConfig)).toHaveLength(0);

    // After the lease expires, another worker picks it up and delivers it.
    await new Promise((r) => setTimeout(r, testConfig.leaseMs + 50));
    await drainUntil(pool, async () => (await deliveryStatus(pool)).status === "succeeded");
    expect(rcv.received).toHaveLength(1);
    await rcv.close();
  });

  it("ignores a late result from a worker whose lease expired", async () => {
    await createEndpoint(pool, { url: "http://127.0.0.1:1/unused" });
    await ingestEvent(pool, { type: "t", payload: {} });

    // Worker A claims, then stalls past its lease; worker B re-claims.
    const [stale] = await claimDue(pool, testConfig);
    await new Promise((r) => setTimeout(r, testConfig.leaseMs + 50));
    const [fresh] = await claimDue(pool, testConfig);
    expect(fresh!.attemptCount).toBe(2);

    // A's late failure must not reset B's claim to pending...
    await settle(pool, stale!, { ok: false, statusCode: 500, error: "HTTP 500", durationMs: 1 }, testConfig);
    expect((await deliveryStatus(pool)).status).toBe("in_flight");

    // ...so B's success still lands.
    await settle(pool, fresh!, { ok: true, statusCode: 200, error: null, durationMs: 1 }, testConfig);
    expect((await deliveryStatus(pool)).status).toBe("succeeded");
    // Both requests were really sent, so both are logged.
    const { rows } = await pool.query(`SELECT status_code FROM attempts ORDER BY id`);
    expect(rows.map((r) => r.status_code)).toEqual([500, 200]);
  });

  it("dead-letters a delivery whose workers keep dying instead of looping forever", async () => {
    await createEndpoint(pool, { url: "http://127.0.0.1:1/unused" });
    await ingestEvent(pool, { type: "t", payload: {} });

    // Every worker claims it and "crashes": nobody ever settles it.
    for (let i = 0; i < testConfig.maxAttempts; i++) {
      expect(await claimDue(pool, testConfig)).toHaveLength(1);
      await new Promise((r) => setTimeout(r, testConfig.leaseMs + 50));
    }

    expect(await claimDue(pool, testConfig)).toHaveLength(0);
    expect((await deliveryStatus(pool)).status).toBe("dead");
  });

  it("does not follow redirects, and counts them as failures", async () => {
    const target = await startReceiver();
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: target.url });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const port = (redirector.address() as AddressInfo).port;
    await createEndpoint(pool, { url: `http://127.0.0.1:${port}/hook` });
    await ingestEvent(pool, { type: "t", payload: {} });

    await processBatch(pool, testConfig);

    expect(target.received).toHaveLength(0);
    const { rows } = await pool.query(`SELECT status_code FROM attempts`);
    expect(rows[0].status_code).toBe(302);
    expect((await deliveryStatus(pool)).status).toBe("pending");
    await new Promise((r) => redirector.close(r));
    await target.close();
  });

  it("treats a receiver that is down (connection refused) as a failed attempt", async () => {
    // Bind a port, then close it so nothing is listening there.
    const rcv = await startReceiver();
    const url = rcv.url;
    await rcv.close();
    await createEndpoint(pool, { url });
    await ingestEvent(pool, { type: "t", payload: {} });

    await processBatch(pool, testConfig);

    const { rows } = await pool.query(`SELECT error, status_code FROM attempts`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status_code).toBeNull();
    expect(rows[0].error).toContain("ECONNREFUSED");
    expect((await deliveryStatus(pool)).status).toBe("pending");
  });
});

describe("concurrency and duplicates", () => {
  it("never lets two workers claim the same delivery", async () => {
    const rcv = await startReceiver();
    await createEndpoint(pool, { url: rcv.url });
    for (let i = 0; i < 30; i++) {
      await ingestEvent(pool, { type: "t", payload: { i } });
    }
    // Four workers claim at the same moment, small batches.
    const cfg = { ...testConfig, batchSize: 10 };
    const batches = await Promise.all([1, 2, 3, 4].map(() => claimDue(pool, cfg)));
    const ids = batches.flat().map((d) => d.id);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    await rcv.close();
  });

  it("ignores a repeated idempotency key", async () => {
    const rcv = await startReceiver();
    await createEndpoint(pool, { url: rcv.url });
    const first = await ingestEvent(pool, { type: "t", payload: { n: 1 }, idempotencyKey: "k-1" });
    const second = await ingestEvent(pool, { type: "t", payload: { n: 2 }, idempotencyKey: "k-1" });

    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    const events = await pool.query(`SELECT count(*)::int AS n FROM events`);
    const deliveries = await pool.query(`SELECT count(*)::int AS n FROM deliveries`);
    expect(events.rows[0].n).toBe(1);
    expect(deliveries.rows[0].n).toBe(1);
    await rcv.close();
  });

  it("handles simultaneous submissions of the same idempotency key", async () => {
    await createEndpoint(pool, { url: "http://127.0.0.1:1/unused" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ingestEvent(pool, { type: "t", payload: {}, idempotencyKey: "same" }),
      ),
    );
    expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
  });
});

describe("dashboard stats", () => {
  it("reports status counts, per-endpoint health and a gap-free timeline", async () => {
    const good = await startReceiver();
    const bad = await startReceiver(() => 503);
    await createEndpoint(pool, { url: good.url, name: "good" });
    await createEndpoint(pool, { url: bad.url, name: "bad" });
    await ingestEvent(pool, { type: "t", payload: {} });
    await drainUntil(pool, async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM deliveries WHERE status IN ('succeeded','dead')`,
      );
      return rows[0].n === 2;
    });

    const server = createApp(pool).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
    await new Promise((r) => server.close(r));

    expect(stats.deliveries).toMatchObject({ succeeded: 1, dead: 1 });
    expect(stats.endpoints).toEqual([
      expect.objectContaining({ name: "good", succeeded: 1, retrying: 0, dead: 0 }),
      expect.objectContaining({ name: "bad", succeeded: 0, retrying: 0, dead: 1 }),
    ]);
    expect(stats.timeline).toHaveLength(30);
    // Summed, so the test holds even if it straddles a minute boundary.
    const sum = (k: string) =>
      stats.timeline.reduce((n: number, m: Record<string, number>) => n + m[k]!, 0);
    expect(sum("events")).toBe(1);
    expect(sum("okAttempts")).toBe(1);
    expect(sum("failedAttempts")).toBe(testConfig.maxAttempts);
    await good.close();
    await bad.close();
  });
});

describe("backoff", () => {
  it("grows exponentially, stays within the cap and applies jitter", () => {
    // random() = 0.999... gives (almost) the ceiling for each attempt.
    const top = (a: number) => backoffMs(a, 5000, 40000, () => 0.9999);
    expect(top(1)).toBeLessThan(5000);
    expect(top(2)).toBeGreaterThan(top(1));
    expect(top(3)).toBeGreaterThan(top(2));
    expect(top(10)).toBeLessThan(40000); // capped
    expect(backoffMs(3, 5000, 40000, () => 0)).toBe(0); // full jitter can be 0
  });
});
