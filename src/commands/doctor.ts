import process from "node:process";
import { loadConfig } from "../config/load.js";
import { withDb } from "../db/client.js";
import { ok, fail, heading, warn } from "../util/terminal.js";

function nodeVersionOk(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function doctorCommand(configPath: string): Promise<void> {
  let failed = false;
  heading("Novel World Harness doctor");

  if (nodeVersionOk()) ok(`Node ${process.versions.node}`);
  else {
    fail(`Node ${process.versions.node}; Pi 0.82.x requires Node >= 22.19.0`);
    failed = true;
  }

  const config = await loadConfig(configPath);
  ok(`Config valid: ${configPath}`);

  for (const [name, profile] of Object.entries(config.llm.profiles)) {
    if (!profile.apiKeyEnv) {
      warn(`LLM profile '${name}' has no apiKeyEnv; expecting Pi stored auth or provider-specific auth.`);
      continue;
    }
    if (process.env[profile.apiKeyEnv]) ok(`LLM profile '${name}' credential env present (${profile.apiKeyEnv})`);
    else {
      fail(`LLM profile '${name}' missing env ${profile.apiKeyEnv}`);
      failed = true;
    }
  }

  try {
    await withDb(config, async (db) => {
      const result = await db.query("SELECT current_database() AS db, version() AS version");
      ok(`PostgreSQL reachable: ${result.rows[0].db}`);
    });
  } catch (error) {
    fail(`PostgreSQL connection failed: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }

  if (failed) process.exitCode = 1;
}
