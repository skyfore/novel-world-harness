import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../src/commands/doctor.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;

afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("doctor command", () => {
  it("recognizes Pi's default auth store without exposing the credential", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-doctor-"));
    roots.push(root);
    const piAgentDir = path.join(root, "pi-agent");
    await fs.mkdir(piAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(piAgentDir, "auth.json"),
      `${JSON.stringify({ anthropic: { type: "api_key", key: "doctor-test-secret" } })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => messages.push(String(value)));
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => messages.push(String(value)));
    process.exitCode = undefined;

    await doctorCommand(path.join(root, "novel-harness.yaml"), piAgentDir);

    const output = messages.join("\n");
    expect(output).toContain("Pi-managed authentication available for anthropic");
    expect(output).not.toContain("doctor-test-secret");
    expect(process.exitCode).toBeUndefined();
  });
});
