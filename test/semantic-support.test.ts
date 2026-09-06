import { expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { assessSemanticSupport } from "../src/compiler/semantic-support.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";

it("separates an exact extraction anchor from independently supported mechanism applicability", () => {
  const assertion = { version: 1, id: "transfer-support", target: { artifactKind: "action-schema", artifactId: "transfer", jsonPointer: "/stateEffects" }, anchors: [{ sourceId: "book", startByte: 0, endByte: 10 }], relation: "supports", strength: "explicit", derivation: { runId: "extraction" } };
  const bundle = { source: { id: "book" }, canonical: { eventExecutions: [], actionSchemas: [{ id: "transfer", stateEffects: [{ effect: "transfer" }] }], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [] }, compilerSnapshot: { structure: { units: [], baseUnitIds: [] }, evidenceBindings: [{ artifactKind: "action-schema", artifactId: "transfer", assertions: [assertion] }] } } as unknown as PreparedNovelBundle;
  expect(assessSemanticSupport(bundle).assessments[0]).toMatchObject({ decision: "underdetermined", method: "unreviewed-extraction" });
  const review = { assertionId: assertion.id, assertionHash: contentHash(assertion), decision: "supports" as const, scope: "mechanism" as const, rationale: "Independently verified ownership preconditions and the transfer effect." };
  expect(assessSemanticSupport(bundle, [review]).issues).toEqual([]);
  expect(assessSemanticSupport(bundle, [{ ...review, scope: "occurrence" }]).issues[0]!.code).toBe("MECHANISM_SUPPORT_UNREVIEWED");
  expect(assessSemanticSupport(bundle, [{ ...review, decision: "contradicts" }]).issues[0]!.code).toBe("MECHANISM_SUPPORT_CONFLICT");
  expect(assessSemanticSupport(bundle, [{ ...review, assertionHash: "f".repeat(64) }]).issues[0]!.code).toBe("SUPPORT_REVIEW_STALE");
  bundle.canonical.actionSchemas[0]!.preconditions = [];
  expect(assessSemanticSupport(bundle, [review]).issues).toContainEqual(expect.objectContaining({ code: "MECHANISM_SUPPORT_MISSING", path: "/preconditions" }));
  bundle.compilerSnapshot.evidenceBindings = [];
  expect(assessSemanticSupport(bundle).issues).toContainEqual(expect.objectContaining({ code: "MECHANISM_SUPPORT_MISSING" }));
});
