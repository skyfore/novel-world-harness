import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createPiCanonicalAttachmentResolver } from "../src/agent/pi-canonical-attachment.js";
import type { CanonicalAttachmentResolverInput } from "../src/world/canonical-adaptation.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function input(): CanonicalAttachmentResolverInput {
  return {
    canonicalEvent: {
      title: "Mo Yan delivers the sealed order",
      readerSummary: "The original messenger carries an order after receiving access.",
    },
    scaffold: {
      title: "A qualified messenger delivers the sealed order",
    },
    bindingOptions: [{
      bindingOptionId: "binding-001",
      stateEffects: ["The sealed order.artifact.owner = The Courier"],
      knowledgeEffects: ["The Courier learns the delivery duty"],
      roles: [{
        roleId: "messenger",
        description: "the present messenger able to accept custody",
        canonicalName: "Mo Yan",
        boundName: "The Courier",
        boundKind: "character",
      }],
    }],
    recentCommittedEvents: [{
      title: "Hero refuses the key transfer",
      participantNames: ["Hero", "Mo Yan"],
    }],
  };
}

describe("Pi canonical attachment resolver", () => {
  it("uses an isolated capture-only call and returns only an offered binding expansion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-canon-attachment-"));
    roots.push(root);
    let prompt = "";
    let disposed = false;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      expect(options.saveSession).toBe(false);
      expect(options.includeProjectInstructions).toBe(false);
      expect(options.includeLocalTools).toBe(false);
      expect(options.includeNwhExtension).toBe(false);
      expect(options.additionalTools?.map((tool) => tool.name)).toEqual(["attach_canonical_scaffold"]);
      const tool = options.additionalTools![0]!;
      return {
        abort: async () => undefined,
        dispose: async () => { disposed = true; },
        promptWithReport: async (value: string) => {
          prompt = value;
          await tool.execute("attach", {
            decision: "attach",
            bindingOptionId: "binding-001",
            title: "The Courier takes custody of the sealed order",
            roleObservations: [{ roleId: "messenger", summary: "The Courier secures the order for delivery." }],
            roleAffects: [{ roleId: "messenger", label: "focused", intensity: 0.5 }],
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiCanonicalAttachmentResolver({ root })(input());

    expect(result).toMatchObject({
      decision: "attach",
      bindingOptionId: "binding-001",
      roleObservations: [{ roleId: "messenger" }],
    });
    expect(prompt).toContain("binding-001");
    expect(prompt).toContain("The Courier");
    expect(prompt).toContain("Hero refuses the key transfer");
    expect(prompt).not.toContain("canon-deliver-order");
    expect(prompt).not.toContain("courier-stable-id");
    expect(disposed).toBe(true);
  });
});
