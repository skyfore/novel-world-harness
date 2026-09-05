import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

const roots: string[] = [];
const envKeys = ["NWH_TEST_PROJECT", "NWH_TEST_MODEL"] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  for (const key of envKeys) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

it("interpolates environment values after YAML parsing", async () => {
  const root = await tempRoot();
  const configPath = path.join(root, "novel-harness.yaml");
  process.env.NWH_TEST_PROJECT = "Safe Project";
  process.env.NWH_TEST_MODEL = "claude: sonnet # literal scalar";
  await fs.writeFile(
    configPath,
    [
      "version: 1",
      "project:",
      "  name: ${NWH_TEST_PROJECT}",
      "llm:",
      "  defaultProfile: default",
      "  profiles:",
      "    default:",
      "      provider: anthropic",
      "      model: ${NWH_TEST_MODEL}",
      "  routing: {}",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(configPath);
  expect(config.project.name).toBe("Safe Project");
  expect(config.llm?.profiles.default?.model).toBe("claude: sonnet # literal scalar");
});

it("loads .env from the configuration directory instead of process cwd", async () => {
  const root = await tempRoot();
  const configPath = path.join(root, "novel-harness.yaml");
  delete process.env.NWH_TEST_PROJECT;
  await fs.writeFile(path.join(root, ".env"), "NWH_TEST_PROJECT=Config Directory Project\n", "utf8");
  await fs.writeFile(
    configPath,
    [
      "version: 1",
      "project:",
      "  name: ${NWH_TEST_PROJECT}",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(configPath);
  expect(config.project.name).toBe("Config Directory Project");
});
