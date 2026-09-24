import { expect, it } from "vitest";
import { upstreamRepairDependencyPath } from "../src/compiler/upstream-repair-binding.js";
import type { ClosureGraph } from "../src/compiler/closure.js";
const revisionHash = "a".repeat(64);
const ref = (kind: "annotation" | "unit" | "event", id: string) => ({ kind, id, revisionHash, uses: [{ pointer: "/typedRef", purpose: "evidence-support" as const }] });
function graph(): ClosureGraph {
  return { version: 1, issues: [], nodes: [
    { kind: "event", id: "speech", revisionHash, dependsOn: [ref("annotation", "quote")] },
    { kind: "event", id: "unrelated", revisionHash, dependsOn: [ref("unit", "shared-text")] },
    { kind: "annotation", id: "quote", revisionHash, dependsOn: [ref("annotation", "speaker"), ref("unit", "shared-text")] },
    { kind: "annotation", id: "speaker", revisionHash, dependsOn: [] },
    { kind: "unit", id: "shared-text", revisionHash, dependsOn: [ref("annotation", "quote")] },
  ] };
}
it("binds only exact directed dependencies, not a common text unit or a guessed role", () => {
  expect(upstreamRepairDependencyPath(graph(), "event:speech", "speaker", revisionHash)?.map(node => node.id)).toEqual(["speech", "quote", "speaker"]);
  expect(upstreamRepairDependencyPath(graph(), "event:unrelated", "speaker", revisionHash)).toBeNull();
  expect(upstreamRepairDependencyPath(graph(), "character:speaker", "speaker", revisionHash)).toBeNull();
  expect(upstreamRepairDependencyPath(graph(), "event:speech", "speaker", "b".repeat(64))).toBeNull();
});
it("handles cycles and rejects rewritten or ambiguous dependency revisions", () => {
  const input = graph(); input.nodes[3]!.dependsOn.push(ref("event", "speech"));
  expect(upstreamRepairDependencyPath(input, "event:speech", "missing", revisionHash)).toBeNull();
  expect(upstreamRepairDependencyPath(input, "event:speech", "speaker", revisionHash)).toHaveLength(3);
  const stale = structuredClone(input); stale.nodes[0]!.dependsOn[0]!.revisionHash = "b".repeat(64);
  expect(() => upstreamRepairDependencyPath(stale, "event:speech", "speaker", revisionHash)).toThrow("stale closure edge");
  input.nodes.push(structuredClone(input.nodes[0]!));
  expect(() => upstreamRepairDependencyPath(input, "event:speech", "speaker", revisionHash)).toThrow("duplicate closure identities");
});
