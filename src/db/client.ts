import pg from "pg";
import type { HarnessConfig } from "../config/schema.js";

const { Pool } = pg;

export type Db = pg.Pool;

export function createDb(config: HarnessConfig): Db {
  return new Pool({
    connectionString: config.database.url,
    min: config.database.poolMin,
    max: config.database.poolMax,
    statement_timeout: config.database.statementTimeoutMs,
    application_name: "novel-world-harness",
  });
}

export async function withDb<T>(config: HarnessConfig, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb(config);
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}
