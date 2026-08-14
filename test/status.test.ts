import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusCommand } from "../src/commands/status.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("status command", () => {
  it("reports an empty fresh workspace without requiring a config file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-status-"));
    roots.push(root);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => lines.push(String(value)));
    vi.spyOn(console, "table").mockImplementation(() => undefined);

    await expect(statusCommand(path.join(root, "novel-harness.yaml"))).resolves.toBeUndefined();

    expect(lines.join("\n")).toContain("no config or NWH state");
    expect(lines.join("\n")).toContain("State:");
    expect(lines.join("\n")).toContain("readiness is not inferred");
    expect(lines.join("\n")).toContain("Preparation: needs-source");
    expect(lines.join("\n")).toContain("Next: nwh prepare <novel-path>");
  });
});
