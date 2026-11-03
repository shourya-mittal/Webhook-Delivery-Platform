import pg from "pg";
import { config } from "./config.js";

export function createPool(connectionString = config.databaseUrl): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export type Pool = pg.Pool;
