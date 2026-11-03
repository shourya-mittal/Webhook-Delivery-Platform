import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPool, type Pool } from "./db.js";

export async function migrate(pool: Pool): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

// Run directly: `npm run migrate`
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  const pool = createPool();
  migrate(pool)
    .then(() => console.log("migrated"))
    .finally(() => pool.end());
}
