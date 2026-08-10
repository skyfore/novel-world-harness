import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { configSchema, type HarnessConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  dotenv.config();
  const absolute = path.resolve(configPath);
  const raw = await fs.readFile(absolute, "utf8");
  const expanded = raw.replace(ENV_PATTERN, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      throw new Error(`Missing environment variable '${name}' referenced by ${absolute}`);
    }
    return value;
  });
  return configSchema.parse(YAML.parse(expanded));
}

export function resolveConfigPath(value?: string): string {
  return path.resolve(value ?? "novel-harness.yaml");
}

export function profileForRole(config: HarnessConfig, role: string) {
  const name = config.llm.routing[role] ?? config.llm.defaultProfile;
  const profile = config.llm.profiles[name];
  if (!profile) throw new Error(`No LLM profile configured for role '${role}'`);
  return { name, profile };
}
