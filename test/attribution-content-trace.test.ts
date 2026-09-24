import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { SourceAnnotationStore, quotationSchema } from "../src/compiler/annotations.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { resolveTextSelectorAnchor } from "../src/compiler/text-anchors.js";
import { contentHash } from "../src/world/canonical.js";
import { attributionContentTraceIssues, validateCommittedAttributionTrace, validateAttributionProposalTrace } from "../src/compiler/attribution-trace.js";
import { evidenceAssertionSchema, propositionSchema, attributionSchema } from "../src/world/model.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it("rejects adjacent content despite same source/speaker, then accepts an evidenced quotation revision through normal finish", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-content-trace-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Note: Help. People are trapped.");
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "note", kind: "artifact", canonicalName: "Note", aliases: [], evidence: fixture.evidence("Note") });
  const makeTools = async (batch: string) => {
    const tools = createCompilerProposalToolset(root); await tools.beginBatch([], batch, fixture.source.id);
    return (name: string, input: unknown) => tools.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  };
  const initial = await makeTools("original-quotation");
  await initial("propose_quotation", { proposal_id: "old-quote", annotation_id: "q", selector: { segment_id: fixture.segmentId, exact: "Help." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  await initial("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Original short quotation" });
  const store = new SourceAnnotationStore(root), before = await store.readProposal(fixture.source.id, "accepted", "old-quote");
  const originalReceipt = await new CompilerFinishReceipts(root, fixture.source.id, "original-quotation").read();
  const proposition = propositionSchema.parse({ id: "p", subjectEntityId: "note", relationId: "reports", object: { kind: "literal", value: "People are trapped." }, polarity: "positive", modality: "asserted", evidence: fixture.evidence("People are trapped.") });
  await canon.putProposition(proposition);
  const manifest = await new SegmentStore(root).readManifest(fixture.source.id);
  const anchor = await resolveTextSelectorAnchor(root, manifest!.segments[0]!, { segment_id: fixture.segmentId, exact: "People are trapped." });
  const assertion = evidenceAssertionSchema.parse({ version: 1, id: "content", target: { artifactKind: "proposition", artifactId: "p", jsonPointer: "/object/value" }, anchors: [anchor], relation: "supports", strength: "explicit", derivation: { runId: "test", worker: "test", ontologyVersion: "evidence-v1" } });
  await new EvidenceAssertionStore(root).replaceForArtifact("proposition", "p", contentHash(proposition), [assertion]);
  const attribution = attributionSchema.parse({ id: "a", propositionId: "p", holderKind: "document", holderEntityId: "note", attitude: "reports", certainty: 1, quotationIds: ["q"], evidence: fixture.evidence("Note: Help. People are trapped.") });
  await canon.putAttribution(attribution);
  expect((await validateCommittedAttributionTrace(root, fixture.source.id, attribution)).join()).toContain("outside its cited quotation content");
  expect((await validateCommittedAttributionTrace(root, fixture.source.id, attribution)).join()).toContain("defective dependency is proposition p at /object");
  const revision = await makeTools("host-quotation-review");
  await expect(revision("finish_compiler_batch", { outcome: "no-artifacts", reviewed_segments: [], summary: "Do not certify invalid trace" })).rejects.toThrow("outside its cited quotation content");
  await revision("propose_quotation", { proposal_id: "reviewed-quote", annotation_id: "q", selector: { segment_id: fixture.segmentId, exact: "Help. People are trapped." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  await revision("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Host reviewed the complete contiguous source utterance" });
  expect(await validateCommittedAttributionTrace(root, fixture.source.id, attribution)).toEqual([]);
  expect(await store.readProposal(fixture.source.id, "accepted", "old-quote")).toEqual(before);
  expect((await new CompilerFinishReceipts(root, fixture.source.id, "original-quotation").read())?.fingerprint).toBe(originalReceipt?.fingerprint);
  const quote = quotationSchema.parse(await store.read(fixture.source.id, "q"));
  expect(attributionContentTraceIssues(attribution, [{ ...assertion, anchors: [anchor, { ...anchor, sourceId: "other" }] }], new Map([["q", quote]]))).not.toEqual([]);
  expect(attributionContentTraceIssues(attribution, [{ ...assertion, target: { ...assertion.target, jsonPointer: "/subjectEntityId" } }], new Map([["q", quote]]))).toEqual([]);
});

it.each([
  { first: "Ada reports the river is rising.", second: "Bo repeats the river is rising." },
  { first: "Neri records the road is blocked.", second: "After a door closes, Venn repeats the road is blocked." },
])("checks persisted nested content and isolates pending correction: $first", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-nested-content-")); roots.push(root);
  const text = `Note: ${scene.first} ${scene.second}`;
  const fixture = await createEvidenceFixture(root, text);
  const tools = createCompilerProposalToolset(root);
  await tools.beginBatch([], "nested-quotation", fixture.source.id);
  const invoke = (name: string, input: unknown) => tools.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  await invoke("propose_quotation", { proposal_id: "quote", annotation_id: "q", selector: { segment_id: fixture.segmentId, exact: scene.first }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Freeze the first report" });
  const quote = quotationSchema.parse(await new SourceAnnotationStore(root).read(fixture.source.id, "q"));
  const manifest = await new SegmentStore(root).readManifest(fixture.source.id);
  const elsewhere = await resolveTextSelectorAnchor(root, manifest!.segments[0]!, { segment_id: fixture.segmentId, exact: scene.second });
  const canon = new CanonicalModelStore(root), exact = new EvidenceAssertionStore(root);
  const base = { subjectEntityId: "note", relationId: "reports", polarity: "positive", modality: "asserted", evidence: fixture.evidence(text) };
  const outer = propositionSchema.parse({ ...base, id: "outer", object: { kind: "proposition", propositionId: "child" } });
  const child = propositionSchema.parse({ ...base, id: "child", object: { kind: "literal", value: scene.first } });
  const assertion = (id: string, pointer: string, anchor: typeof elsewhere) => evidenceAssertionSchema.parse({ version: 1, id: `proof-${id}`, target: { artifactKind: "proposition", artifactId: id, jsonPointer: pointer }, anchors: [anchor], relation: "supports", strength: "explicit", derivation: { runId: "test", worker: "test", ontologyVersion: "evidence-v1" } });
  await canon.putProposition(outer); await canon.putProposition(child);
  await exact.replaceForArtifact("proposition", "outer", contentHash(outer), [assertion("outer", "/object/propositionId", quote.anchor)]);
  await exact.replaceForArtifact("proposition", "child", contentHash(child), [assertion("child", "/object/value", elsewhere)]);
  const attribution = attributionSchema.parse({ id: "a", propositionId: "outer", holderKind: "document", holderEntityId: "note", attitude: "reports", certainty: 1, quotationIds: ["q"], evidence: fixture.evidence(text) });
  await canon.putAttribution(attribution);
  const committedIssues = await validateCommittedAttributionTrace(root, fixture.source.id, attribution);
  expect(committedIssues.join()).toContain("defective dependency is proposition child at /object");
  expect(committedIssues.join()).toContain("child/object/value");
  expect(committedIssues.join()).toContain("find_compiler_artifacts (kind proposition)");
  expect(committedIssues.join()).toContain("find_source_annotations (annotation_type quotation)");
  expect(committedIssues.join()).toContain("results[].readArguments.ref into read_source_annotation.ref");
  const corrected = assertion("child", "/object/value", quote.anchor);
  await new ProposalStore(root).writePending({ id: "correct-child", kind: "proposition", schemaVersion: 1, payload: child, evidence: child.evidence, evidenceAssertions: [corrected], generatedBy: { worker: "test" }, createdAt: new Date().toISOString() }, propositionSchema);
  expect(await validateAttributionProposalTrace(root, fixture.source.id, ["correct-child"], [], [])).toEqual([]);
  expect(await validateCommittedAttributionTrace(root, fixture.source.id, attribution)).toEqual(committedIssues);
  expect(await canon.getProposition("child")).toEqual(child);
  expect(await new SourceAnnotationStore(root).read(fixture.source.id, "q")).toEqual(quote);
  // A committed binding update is a separate authority transition from pending validation.
  await exact.replaceForArtifact("proposition", "child", contentHash(child), [corrected]);
  expect(await validateCommittedAttributionTrace(root, fixture.source.id, attribution)).toEqual([]);
  expect(await canon.getProposition("outer")).toEqual(outer);
});
