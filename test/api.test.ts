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
