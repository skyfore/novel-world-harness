import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { identityStage } from "../../src/compiler/pipeline/identity.js";
import { runStage } from "../../src/compiler/pipeline/runner.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { DEFAULT_COMPLETENESS_POLICY, measureWorldCompleteness } from "../../src/compiler/world-completeness.js";
import { must, observedWorkspace, stageContext } from "./fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const ENTITIES: Record<string, { id: string; kind: string }> = { 林岐: { id: "char-lin-qi", kind: "character" }, 墨砚: { id: "char-mo-yan", kind: "character" }, 北门: { id: "loc-north-gate", kind: "location" }, 钟楼: { id: "loc-bell-tower", kind: "location" } };

export function identityScript(options: { resolvePronoun?: boolean; genericAttempt?: boolean } = {}) {
  return async (input: { prompt: string; scopeId: string }, call: Parameters<Parameters<typeof stageContext>[2]>[1]) => {
    if (input.scopeId.includes("-lexicon-")) {
      const surfaces = [...input.prompt.matchAll(/^([^\s|]+) \| (\w[\w-]*) \| \d+ \|/gmu)].map((match) => match[1]!);
      if (options.genericAttempt) {
        const refused = await call("propose_entities", { items: [{ id: "char-he", kind: "character", canonicalName: "他" }] });
        expect(refused.details).toMatchObject({ proposed: 0, failed: [{ index: 0 }] });
      }
      const known = surfaces.filter((surface) => ENTITIES[surface]);
      await must(call, "propose_entities", { items: known.map((surface) => ({ id: ENTITIES[surface]!.id, kind: ENTITIES[surface]!.kind, canonicalName: surface })) });
      await must(call, "decide_lexicon_entries", { items: surfaces.map((surface) => ENTITIES[surface]
        ? { surface, verdict: "entity", entity: ENTITIES[surface]!.id, aliasType: "name", rationale: "The text names this one referent." }
        : { surface, verdict: "non-referential", rationale: "Not a name here." }) });
    } else if (options.resolvePronoun !== false) {
      const open = [...input.prompt.matchAll(/^(em-\d+-\d+) \[u\d+\] pronoun "他"/gmu)].map((match) => match[1]!);
      if (open.length) await must(call, "resolve_mentions", { items: open.map((mention) => ({ mention, status: "resolved", entity: "char-lin-qi", rationale: "He leads 墨砚; 林岐 holds the key." })) });
    }
    await call("finish_scope", {});
  };
}

describe("pipeline identity", () => {
  it("expands one decision per surface to every mention, refuses generic names and leaves pronouns to per-mention resolution", async () => {
    const workspace = await observedWorkspace();
    cleanups.push(workspace.cleanup);
    const lazy = stageContext(workspace.root, workspace.source.id, identityScript({ resolvePronoun: false, genericAttempt: true }) as never);
    const first = await runStage(identityStage, lazy, { maxAttempts: 1 });
    expect(first.completed.filter((id) => id.includes("-lexicon-"))).toHaveLength(1);
    // The reference window still holds the unresolved pronoun: the gate refuses it.
    expect(first.held).toHaveLength(1);
    const held = (await lazy.store.receipts()).find((item) => item.status === "held")!;
    expect(held.gate!.checks.find((check) => check.id === "identity.mentions-resolved")!.passed).toBe(false);

    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const resolutions = view.bundle.compilerSnapshot.entityResolutions;
    expect(resolutions.filter((item) => item.derivation.worker === "host-lexicon-v1" && item.entityId === "char-lin-qi").length).toBe(3);
    expect(view.decisions.map((item) => item.surface).sort()).toEqual(expect.arrayContaining(["林岐", "墨砚"]));

    const { releaseHeldScope } = await import("../../src/compiler/pipeline/runner.js");
    await releaseHeldScope(lazy.store, held.id);
    const second = await runStage(identityStage, stageContext(workspace.root, workspace.source.id, identityScript() as never));
    expect(second.held).toEqual([]);
    const report = measureView(await loadPipelineView(workspace.root, workspace.source.id));
    const byId = new Map(report.measures.map((item) => [item.id, item]));
    expect(byId.get("identity.mentions-resolved")!.status).toBe("satisfied");
    expect(byId.get("identity.aliases-attached")!.status).toBe("satisfied");
    expect(byId.get("identity.generic-names")!.numerator).toBe(0);
    expect(byId.get("identity.name-collisions")!.numerator).toBe(0);
    // Speaker cues and quotation speakers now resolve to entities, so speaking characters exist.
    const view2 = await loadPipelineView(workspace.root, workspace.source.id);
    const low = measureWorldCompleteness(view2.bundle, view2.bytes, { ...view2.options, policy: { ...DEFAULT_COMPLETENESS_POLICY, speakingLineThreshold: 1 } });
    expect(low.speakingCharacters.map((item) => [item.actorId, item.lines])).toEqual([["char-lin-qi", 4], ["char-mo-yan", 3]]);
  });
});
