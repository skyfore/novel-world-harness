import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { configSchema, type HarnessConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const absolute = path.resolve(configPath);
  dotenv.config({ path: path.join(path.dirname(absolute), ".env"), quiet: true });
  const raw = await fs.readFile(absolute, "utf8");
  const parsed = YAML.parse(raw) as unknown;
  return configSchema.parse(expandEnvironment(parsed, absolute));
}

export async function loadOptionalConfig(configPath: string): Promise<HarnessConfig | undefined> {
  try {
    return await loadConfig(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function resolveConfigPath(value?: string): string {
  return path.resolve(value ?? "novel-harness.yaml");
}

export function profileForRole(config: HarnessConfig, role: string) {
  if (!config.llm) return { name: undefined, profile: undefined };
  const name = config.llm.routing[role] ?? config.llm.defaultProfile;
  const profile = config.llm.profiles[name];
  if (!profile) throw new Error(`No LLM profile configured for role '${role}'`);
  return { name, profile };
}

function expandEnvironment(value: unknown, configPath: string): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string) => {
      const expanded = process.env[name];
      if (expanded === undefined) {
        throw new Error(`Missing environment variable '${name}' referenced by ${configPath}`);
      }
      return expanded;
    });
  }
  if (Array.isArray(value)) return value.map((item) => expandEnvironment(item, configPath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, expandEnvironment(item, configPath)]),
  );
}
