import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiActorReasoner } from "../src/agent/pi-actor-reasoner.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import type { ActorReasoningInput } from "../src/world/model-actor-policy.js";
import { DEFAULT_STATE_FIELDS } from "../src/world/state.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function reasoningInput(): ActorReasoningInput {
  return {
    actor: {
      actorId: "actor-self",
      selfState: { "character.alive": true, "character.location": "entity-001" },
      ownedEntityState: {},
      knowledge: [],
      presentEntities: [{ id: "actor-self", kind: "character", name: "Self" }],
      referenceableEntities: [
        { id: "actor-self", kind: "character", name: "Self" },
        { id: "entity-001", kind: "location", name: "Hall" },
      ],
      spatialRelations: [],
      writableEntityIds: ["actor-self"],
      writableStateFields: DEFAULT_STATE_FIELDS.filter((field) => field.appliesTo.includes("character")),
      scene: { locationId: "entity-001", locationState: {}, presentEntityIds: ["actor-self"] },
      recentVisibleEvents: [{ summary: "A bell rang." }],
      activeThreads: [],
      activeNorms: [{ name: "Keep the promise", modality: "obligation", role: "subject", status: "active", dueInDays: 0 }],
      activeProcesses: [{ name: "Journey", phase: "On the road", status: "running", progress: 0.5, dueInDays: 0 }],
    },
    goal: { description: "Reach safety", priority: 1, targetIds: [] },
    model: { traits: { courage: 0.4 }, decisionBiases: { caution: 0.3 } },
    development: { recentExperiences: [] },
  };
}

describe("Pi autonomous actor reasoner", () => {
  it("runs one isolated capture-only session and returns its proposal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-actor-"));
    roots.push(root);
    const prompts: string[] = [];
    const sessionOptions: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      sessionOptions.push(options as unknown as Record<string, unknown>);
      const capture = options.additionalTools?.find((tool) => tool.name === "propose_actor_action");
      if (!capture) throw new Error("missing actor capture tool");
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          prompts.push(prompt);
          await capture.execute("actor-action", {
            title: "Move the plan forward",
            participants: [],
            preconditions: [],
            proposedDelta: {
              version: 1,
              operations: [{ op: "set", entityId: "actor-self", field: "character.plan", value: "seek-safety" }],
            },
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiActorReasoner({ root })(reasoningInput());

    expect(result).toMatchObject({
      title: "Move the plan forward",
      proposedDelta: { operations: [{ entityId: "actor-self", field: "character.plan", value: "seek-safety" }] },
    });
    expect(sessionOptions[0]).toMatchObject({
      saveSession: false,
      includeProjectInstructions: false,
      includeLocalTools: false,
      includeNwhExtension: false,
    });
    expect((sessionOptions[0]?.additionalTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["propose_actor_action"]);
    expect(prompts[0]).toContain("Keep the promise");
    expect(prompts[0]).toContain("Journey");
    expect(prompts[0]).not.toContain("expectedParentCommit");
    expect(prompts[0]).not.toContain("branchId");
  });

  it("returns no proposal when the isolated model makes no tool call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-actor-silent-"));
    roots.push(root);
    vi.spyOn(PiAgentSession, "create").mockResolvedValue({
      abort: async () => undefined,
      dispose: async () => undefined,
      promptWithReport: async () => ({ text: "No justified action." }),
    } as unknown as PiAgentSession);

    await expect(createPiActorReasoner({ root })(reasoningInput())).resolves.toBeNull();
  });
});
