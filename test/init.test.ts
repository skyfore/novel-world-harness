import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../src/commands/init.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("init command", () => {
  it("creates a provider-neutral config named for the workspace", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-init-"));
    roots.push(parent);
    const root = path.join(parent, "my-novel-world");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initCommand(root);

    const raw = await fs.readFile(path.join(root, "novel-harness.yaml"), "utf8");
    expect(YAML.parse(raw)).toEqual({
      version: 1,
      project: { name: "my-novel-world", language: "zh-CN" },
    });
    expect(raw).not.toContain("provider:");
    expect(raw).not.toContain("apiKeyEnv:");
    await expect(fs.readFile(path.join(root, "NOVEL.md"), "utf8")).resolves.toContain("Source evidence is authoritative");
  });

  it("does not overwrite an existing config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-init-existing-"));
    roots.push(root);
    const configPath = path.join(root, "novel-harness.yaml");
    await fs.writeFile(configPath, "user-owned\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initCommand(root);

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe("user-owned\n");
  });
});
