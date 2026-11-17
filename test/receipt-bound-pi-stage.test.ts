import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { assertPiSubscription, runReceiptBoundPiStage } from "../src/workflow/receipt-bound-pi-stage.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { piRuntime } from "./helpers/pi-provider.js";

it("requires a saved Pi subscription even when an ambient OpenAI key is present", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-subscription-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("OPENAI_API_KEY", "unused-test-value");
  const network = vi.fn(() => { throw Error("unexpected model request"); });
  vi.stubGlobal("fetch", network);
  try {
    await expect(assertPiSubscription(root)).rejects.toThrow(/Required Pi subscription unavailable/);
    const saved = { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3_600_000 };
    await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ "openai-codex": saved }), { mode: 0o600 });
    await expect(assertPiSubscription(root)).resolves.toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])("isolates a receipt-bound session from saved thinking settings and a caller profile (%s)", async callerProfile => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-receipt-profile-"));
  const agentDir = path.join(root, "pi"), directory = path.join(root, "stage");
  await fs.mkdir(agentDir); await fs.mkdir(directory);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("OPENAI_API_KEY", "unused-test-value");
  const network = vi.fn(() => { throw Error("unexpected model request"); });
  vi.stubGlobal("fetch", network);
  const settings = JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "high" });
  await fs.writeFile(path.join(agentDir, "settings.json"), settings);
  const done = new Error("configuration checked before model dispatch");
  try {
    await expect(runReceiptBoundPiStage({ root, sourceId: "src", directory, stage: "consumer-revalidation",
      scopeHash: "a".repeat(64), originalBudgetHash: "b".repeat(64), priorUsage: { modelCalls: 0, totalPayloadBytes: 0 },
      limits: { maxModelCalls: 2, maxRequestBytes: 512000, maxTotalPayloadBytes: 1024000 },
      contract: { terminalTool: "submit_consumer_revalidation", readTools: [], receipt: "retained" },
      assertOriginal: async () => {},
      run: async factory => {
        const session = await factory({ workspace: await LocalFileWorkspace.create(root),
          ...(callerProfile ? { profile: { provider: "openai", model: "gpt-6.1-sol", thinkingLevel: "high",
            baseUrl: "https://invalid.test/v1", apiKeyEnv: "OPENAI_API_KEY" } as const } : {}) });
        try {
          expect(session.model).toBe("openai-codex/gpt-6.1-sol");
          expect(piRuntime(session).session.thinkingLevel).toBe("medium");
        } finally {
          await session.dispose();
        }
        throw done;
      },
    })).rejects.toBe(done);
    expect(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")).toBe(settings);
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
