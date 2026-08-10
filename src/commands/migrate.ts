import { loadConfig } from "../config/load.js";
import { withDb } from "../db/client.js";
import { runInitialMigration } from "../db/migrate.js";

export async function migrateCommand(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  await withDb(config, async (db) => runInitialMigration(db));
  console.log("Database migration complete.");
}
