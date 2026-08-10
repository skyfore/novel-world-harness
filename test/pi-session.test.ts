import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("PiAgentSession", () => {
  it("uses Pi with an in-memory session without making a model request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-"));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, "NOVEL.md"), "# Test novel\n", "utf8");
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      saveSession: false,
      profile: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        thinkingLevel: "medium",
        maxTokens: 8_192,
      },
    });
    expect(session.model).toBe("anthropic/claude-sonnet-5");
    expect(session.messageCount).toBe(0);
    expect(session.sessionFile).toBeUndefined();
    session.dispose();
  });
});
