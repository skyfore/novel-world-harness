import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createPiPlayerActionTranslator } from "../src/agent/pi-player-action.js";
import { ModelRequestBudget, ModelRequestBudgetError } from "../src/agent/model-request-budget.js";
import { DecisionContextBudgetError } from "../src/agent/decision-context.js";
import { actorDecisionViewSchema } from "../src/world/actor-decision-view.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import type { PlayerActionTranslationInput } from "../src/world/player-action.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-budget-"));
  roots.push(value);
  return value;
}
function agent(session: PiAgentSession) {
  return (session as unknown as { runtimeHost: { session: AgentSession } }).runtimeHost.session.agent;
}

describe("Pi request budget integration", () => {
  it("installs the guard on real Pi callbacks and preserves it across host session reset", async () => {
    const directory = await root();
    const budget = new ModelRequestBudget({ maxModelCalls: 2, maxRequestBytes: 200, maxTotalPayloadBytes: 300 });
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(directory),
      runtimeDir: path.join(directory, "runtime"), piAgentDir: path.join(directory, "pi"),
      saveSession: false, includeLocalTools: false, includeNwhExtension: false,
      requestBudget: budget,
    });
    try {
      const model = {} as Parameters<NonNullable<AgentSession["agent"]["onPayload"]>>[1];
      await expect(agent(session).onPayload!({ text: "small" }, model)).resolves.toEqual({ text: "small" });
      await expect(agent(session).onPayload!({ text: "中".repeat(100) }, model)).rejects.toThrow(ModelRequestBudgetError);
      await session.clear();
      await expect(agent(session).onPayload!({ text: "small" }, model)).rejects.toThrow("Stop this invocation");
      expect(budget.snapshot().payloads).toBe(1);
    } finally { await session.dispose(); }
  });

  it("rejects an oversized full logical request before a provider can be invoked", async () => {
    const directory = await root();
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(directory),
      runtimeDir: path.join(directory, "runtime"), piAgentDir: path.join(directory, "pi"),
      saveSession: false, includeLocalTools: false, includeNwhExtension: false,
      requestBudget: new ModelRequestBudget({ maxModelCalls: 1, maxRequestBytes: 100, maxTotalPayloadBytes: 100 }),
    });
    try {
      expect(() => agent(session).streamFunction({} as never, {
        systemPrompt: "system", messages: [], tools: [{ name: "schema", description: "x".repeat(200) }],
      } as never)).toThrow("UTF-8 bytes");
    } finally { await session.dispose(); }
  });

  it("does not create a Pi session when disclosed decision dependencies exceed the prompt boundary", async () => {
    const directory = await root();
    const create = vi.spyOn(PiAgentSession, "create");
    const input: PlayerActionTranslationInput = {
      utterance: "Observe", recentMessages: [], relatedMessages: [],
      context: {
        actorId: "hero", selfState: {}, ownedEntityState: {}, knowledge: [],
        presentEntities: [{ id: "hero", kind: "character", name: "Hero" }],
        referenceableEntities: [{ id: "hero", kind: "character", name: "Hero" }],
        writableEntityIds: ["hero"], writableStateFields: [], spatialRelations: [],
        scene: { locationState: {}, presentEntityIds: ["hero"] }, recentVisibleEvents: [], activeThreads: [],
        decision: actorDecisionViewSchema.parse({
          goals: [{ id: "goal", description: "x".repeat(40_000), priority: 1, targetIds: [] }],
          appraisals: [], relationships: [], obligations: [], norms: [], processes: [],
        }),
      },
    };
    await expect(createPiPlayerActionTranslator({ root: directory })(input)).rejects.toThrow(DecisionContextBudgetError);
    expect(create).not.toHaveBeenCalled();
  });
});
