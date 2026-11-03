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
