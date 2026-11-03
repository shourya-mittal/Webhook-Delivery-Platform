import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import type { Pool } from "../src/db.js";

// These requests are rejected before any query runs, so no database is needed.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp({} as Pool).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe("API key and rate limit", () => {
  let locked: Server;
  let url: string;

  beforeAll(async () => {
    locked = createApp({} as Pool, { apiKey: "test-key", replayPerMinute: 2 }).listen(0, "127.0.0.1");
    await new Promise((r) => locked.once("listening", r));
    url = `http://127.0.0.1:${(locked.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => locked.close(r));
  });

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });

  it.each(["/events", "/endpoints"])("refuses POST %s without the right key", async (path) => {
    expect((await post(path)).status).toBe(401);
    expect((await post(path, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it.each(["/events", "/endpoints"])("lets POST %s through with the key", async (path) => {
    // 400: past the auth check, stopped by validation before any query runs.
    expect((await post(path, { authorization: "Bearer test-key" })).status).toBe(400);
  });

  it("caps replays per minute across all callers", async () => {
    const replay = () => post("/deliveries/not-a-uuid/replay");
    expect((await replay()).status).toBe(400);
    expect((await replay()).status).toBe(400);
    expect((await replay()).status).toBe(429);
  });
});

describe("hardening", () => {
  const withApp = async (
    pool: unknown,
    options: Parameters<typeof createApp>[1],
    run: (url: string) => Promise<void>,
  ) => {
    const s = createApp(pool as Pool, options).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    try {
      await run(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    } finally {
      await new Promise((r) => s.close(r));
    }
  };
  const json = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects over-long fields", async () => {
    const long = "x".repeat(256);
    expect((await json(`${base}/events`, { type: long, payload: {} })).status).toBe(400);
    expect((await json(`${base}/events`, { type: "t", payload: {}, idempotencyKey: long })).status).toBe(400);
    expect((await json(`${base}/endpoints`, { url: "http://a.example/", name: long })).status).toBe(400);
    expect((await json(`${base}/endpoints`, { url: `http://a.example/${"x".repeat(2048)}` })).status).toBe(400);
    expect((await json(`${base}/endpoints`, { url: "http://a.example/", secret: 123 })).status).toBe(400);
  });

  it("clamps a bad limit instead of sending it to the database", async () => {
    const limits: unknown[] = [];
    const pool = { query: async (_sql: string, params: unknown[]) => (limits.push(params[1]), { rows: [] }) };
    await withApp(pool, {}, async (url) => {
      for (const q of ["-5", "0", "abc", "99999", "1.5"]) {
        expect((await fetch(`${url}/deliveries?limit=${q}`)).status).toBe(200);
      }
    });
    expect(limits).toEqual([1, 50, 50, 200, 1]);
  });

  it("sets security headers and hides the framework", async () => {
    const res = await fetch(`${base}/live`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("caps total requests but keeps the liveness check available", async () => {
    await withApp({ query: async () => ({ rows: [] }) }, { requestsPerMinute: 1 }, async (url) => {
      expect((await fetch(`${url}/endpoints`)).status).toBe(200);
      const limited = await fetch(`${url}/endpoints`);
      expect(limited.status).toBe(429);
      // Browsers must be able to read the 429, so it still carries CORS headers.
      expect(limited.headers.get("access-control-allow-origin")).toBe("*");
      expect((await fetch(`${url}/live`)).status).toBe(200);
    });
  });

  it("shares one stats query between concurrent viewers", async () => {
    let queries = 0;
    const pool = {
      query: async () => {
        queries++;
        return { rows: [{}] };
      },
    };
    await withApp(pool, {}, async (url) => {
      const all = await Promise.all([1, 2, 3, 4, 5].map(() => fetch(`${url}/stats`)));
      expect(all.every((r) => r.status === 200)).toBe(true);
    });
    expect(queries).toBe(4); // the four queries of one stats read, not 5 x 4
  });

  it("retries stats after a failure instead of caching the error", async () => {
    let fail = true;
    const pool = {
      query: async () => {
        if (fail) throw new Error("db down");
        return { rows: [{}] };
      },
    };
    await withApp(pool, {}, async (url) => {
      expect((await fetch(`${url}/stats`)).status).toBe(500);
      fail = false;
      expect((await fetch(`${url}/stats`)).status).toBe(200);
    });
  });

  it("never leaks internal error details", async () => {
    const pool = { query: async () => { throw new Error("password=hunter2 at db.internal"); } };
    await withApp(pool, {}, async (url) => {
      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("hunter2");
    });
  });
});

describe("request validation", () => {
  it("answers malformed JSON with 400, not 500", async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("answers an oversized body with 413", async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "t", payload: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
