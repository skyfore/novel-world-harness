import crypto from "node:crypto";
import { expect, it } from "vitest";
import { evaluateSceneCapabilities, type SceneReviewCatalog } from "../src/eval/scene-capabilities.js";
import { canonicalEventSchema, entitySchema } from "../src/world/model.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";

const bytes = Buffer.from("Ada waits. Nothing changes.");
const sourceId = "independent-scene";
const anchor = textAnchorForByteRange(sourceId, bytes, 0, bytes.length);
const evidence = [{ span: { sourceId, startByte: anchor.startByte, endByte: anchor.endByte,
  startLine: anchor.startLine, endLine: anchor.endLine, quoteHash: anchor.exactHash }, strength: "explicit" as const }];
function catalog(): SceneReviewCatalog {
  return {
    entities: new Map([["ada", entitySchema.parse({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence })]]),
    events: new Map([["wait", canonicalEventSchema.parse({ id: "wait", title: "Wait", participants: ["ada"],
      storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence })]]),
    eventParticipations: new Map(), eventExecutions: new Map(), actionSchemas: new Map(), normTemplates: new Map(),
    rules: new Map(), claims: new Map(), propositions: new Map(), attributions: new Map(),
  };
}
function review(changes: Record<string, unknown> = {}) {
  const c = catalog();
  const before = JSON.stringify([...c.events.values()]);
  const result = evaluateSceneCapabilities({ version: 1, sourceId,
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    review: { method: "independent-source-review", reviewer: "fixture-author", reviewedAt: "2026-09-16T00:00:00Z", auditRef: "original-fixture" },
    cases: [{ id: "case", kind: "event-effects", scene: "Waiting", rationale: "Independent expected observation", evidence: [anchor],
      eventId: "wait", requiresMechanism: false, expectation: { kind: "no-change", justification: "The source explicitly describes no change" }, ...changes }],
  }, bytes, c);
  expect(JSON.stringify([...c.events.values()])).toBe(before);
  return result;
}

it("reports independently reviewed no-change without manufacturing effects", () => {
  const report = review();
  expect(report.verified).toBe(true);
  expect(report.requirements.complete).toBe(true);
  expect(report.requirements.authority).toBe("diagnostic-only");
  expect(report.requirements.context.specHash).toBe(report.specHash);
  expect(report.requirementRepairPlan.tasks).toEqual([]);
});
it("retains partial success while missing agency and mechanism remain separate requirements", () => {
  const report = review({ initiatorId: "ada", requiresMechanism: true });
  expect(report.verified).toBe(false);
  expect(report.requirements.requirements.find(r => r.capability === "state-effect")?.state).toBe("satisfied");
  expect(report.requirements.requirements.find(r => r.capability === "agency")?.state).toBe("blocked");
  expect(report.requirements.requirements.find(r => r.capability === "mechanism")?.blockedBy).toContain("case:agency");
  expect(report.requirementRepairPlan.tasks.every(t => t.requiresHostAuthorization)).toBe(true);
});
it("preserves an unmapped source concept and blocks executable certification", () => {
  const report = review({ expectation: { kind: "unmapped", concept: "temporary incapacity", affectedEntityIds: ["ada"] } });
  const requirement = report.requirements.requirements.find(r => r.capability === "state-effect");
  expect(requirement?.state).toBe("unmapped");
  expect(requirement?.expectation).toMatchObject({ concept: "temporary incapacity", affectedEntityIds: ["ada"] });
  expect(report.verified).toBe(false);
  expect(report.requirementRepairPlan.tasks.some(t => t.action === "host-design-review")).toBe(true);
});
