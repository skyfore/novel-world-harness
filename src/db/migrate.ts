import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runInitialMigration(db: Db): Promise<void> {
  const migration = path.resolve(here, "../../migrations/0001_initial.sql");
  const sql = await fs.readFile(migration, "utf8");
  await db.query(sql);
}
