// A deliberately unreliable receiver for demos: fails the first N requests per
// event, then succeeds. Verifies the HMAC signature like a real receiver would.
import http from "node:http";
import { verify } from "../src/signing.js";

const port = Number(process.env.PORT ?? 4000);
const secret = process.env.WEBHOOK_SECRET ?? "";
const failFirst = Number(process.env.FAIL_FIRST ?? 2);
const seen = new Map<string, number>();

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = String(req.headers["webhook-id"]);
      const ts = Number(req.headers["webhook-timestamp"]);
      const sig = String(req.headers["webhook-signature"]);
      if (secret && !verify(secret, ts, body, sig)) {
        console.log(`[receiver] ${id} BAD SIGNATURE`);
        res.statusCode = 401;
        return res.end();
      }
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      const fail = n <= failFirst;
      console.log(`[receiver] ${id.slice(0, 8)} attempt ${n} -> ${fail ? 503 : 200}`);
      res.statusCode = fail ? 503 : 200;
      res.end();
    });
  })
  .listen(port, () => console.log(`flaky receiver on :${port}, failing first ${failFirst}`));
