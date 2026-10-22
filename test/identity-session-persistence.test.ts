import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { ModelRequestBudget } from "../src/runtime/model-request-budget.js";
import { identityRecoveredUsageMatches } from "../src/compiler/identity-requirement-trace.js";
import { mockPiProvider, piRuntime } from "./helpers/pi-provider.js";

it("persists and reopens opaque provider continuation data without substituting the redacted observation trace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-identity-session-"));
  let session: PiAgentSession | undefined, restored: PiAgentSession | undefined;
  try {
    const options = { workspace: await LocalFileWorkspace.create(root), runtimeDir: path.join(root, "task-session"),
      piAgentDir: path.join(root, "pi"), saveSession: true, trackLastOpenedSession: false, autoCompaction: false,
      includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false, interactionMode: "compiler" as const };
    session = await PiAgentSession.create({ ...options, requestBudget: new ModelRequestBudget() });
    await mockPiProvider(session, { response: () => fauxAssistantMessage([
      { ...fauxThinking("synthetic test state"), thinkingSignature: "opaque-provider-continuation-fixture" },
      fauxText("retained read-only result"),
    ]) });
    await session.promptWithReport("synthetic bounded identity task");
    const sessionId = session.id, sessionFile = session.sessionFile!;
    await session.dispose(); session = undefined;
    const saved = await fs.readFile(sessionFile, "utf8");
    expect(saved).toContain("opaque-provider-continuation-fixture");
    restored = await PiAgentSession.create({ ...options, sessionId, requestBudget: new ModelRequestBudget() });
    expect(restored.id).toBe(sessionId);
    expect(JSON.stringify(piRuntime(restored).session.messages)).toContain("opaque-provider-continuation-fixture");
    expect(restored.sessionFile).toBe(sessionFile);
  } finally { await session?.dispose(); await restored?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

it("verifies recovered trace deltas without forgetting or double-counting failed paid usage", () => {
  const inherited = { modelCalls: 5, payloads: 5, totalPayloadBytes: 1000, largestRequestBytes: 300 };
  const total = { modelCalls: 7, payloads: 7, totalPayloadBytes: 1400, largestRequestBytes: 350 };
  expect(identityRecoveredUsageMatches(total, inherited, [150, 250], 2)).toBe(true);
  expect(identityRecoveredUsageMatches({ ...total, modelCalls: 2 }, inherited, [150, 250], 2)).toBe(false);
  expect(identityRecoveredUsageMatches({ ...total, totalPayloadBytes: 400 }, inherited, [150, 250], 2)).toBe(false);
  expect(identityRecoveredUsageMatches({ ...total, totalPayloadBytes: 2400 }, inherited, [150, 250], 2)).toBe(false);
  expect(identityRecoveredUsageMatches({ ...total, largestRequestBytes: 200 }, inherited, [150, 250], 2)).toBe(false);
});
