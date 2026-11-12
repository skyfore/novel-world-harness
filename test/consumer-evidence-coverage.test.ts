import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { contentHash as h } from "../src/world/canonical.js";
import { CONSUMER_EVIDENCE_COVERAGE, consumerEvidenceCoverage, consumerEvidenceSubjects, assertConsumerEvidenceRead,
  consumerEvidenceReads } from "../src/compiler/consumer-evidence-coverage.js";
import { createConsumerWorkPlan, consumerWorkDirectory, consumerWorkInput, consumerWorkProviderDirectory, type ConsumerWorkBaseInput } from "../src/compiler/consumer-work-plan.js";
import { entryRepairParentContext, resolveEntryRepairEvidence } from "../src/compiler/consumer-work-evidence.js";
import { segmentSource } from "../src/compiler/segments.js";
import { inspectConsumerEvidenceGap } from "../src/compiler/consumer-evidence-correction.js";
import { consumerRevalidationDirectory, type ConsumerRevalidationScope, type ConsumerRevalidationRecord } from "../src/compiler/identity-consumer-revalidation-model.js";
import { identityRequirementDirectory } from "../src/compiler/identity-requirements.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { consumerArtifactPages, type ConsumerArtifact } from "../src/compiler/identity-consumer-artifacts.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(kind = "event-execution") {
  const pieces = ["Opening.\n", "Ada enters.\n", "She sees the door.\n", "Unrelated ending.\n"], bytes = Buffer.from(pieces.join(""));
  let offset = 0;
  const segments = pieces.map((text, i) => { const startByte = offset; offset += Buffer.byteLength(text); return { id: `segment-${i}`, startByte, endByte: offset }; });
  const span = (start = 1, end = start) => ({ sourceId: "src", startByte: segments[start]!.startByte, endByte: segments[end]!.endByte,
    startLine: start + 1, endLine: end + 1, quoteHash: sha(bytes.subarray(segments[start]!.startByte, segments[end]!.endByte)) });
  const payload = { id: "subject", entry: { evidence: [{ span: span(1, 2), strength: "explicit" }] } };
  const scope = { sourceId: "src", sourceHash: sha(bytes), ref: `${kind}/subject`, authorizationRef: "original" } as ConsumerRevalidationScope;
  const input = { scope: { ref: scope.ref }, scopeHash: h(scope), requiredSourceSegmentIds: [segments[0]!.id], artifactReadRefs: [],
    currentConsumer: { payload, revisionHash: h(payload) }, denominator: { total: 1, refs: [scope.ref], candidateIds: [], sourcePages: [0], originalQuestionIds: [] } } as unknown as ConsumerWorkBaseInput;
  return { bytes, segments, span, payload, args: { scope, stage: "consumer-revalidation" as const, input,
    catalog: [] as ConsumerArtifact[], bytes, segments, priorUsage: { modelCalls: 7, totalPayloadBytes: 1000 } } };
}

it.each(["event-execution", "event-relation", "rule", "annotation"])("delivers all referenced source for %s without changing its semantics or historical plan", kind => {
  const f = fixture(kind), before = h(f.args), old = createConsumerWorkPlan(f.args);
  expect(old.sources.map(s => s.id)).toEqual(["segment-0"]);
  const plan = createConsumerWorkPlan({ ...f.args, evidencePolicy: CONSUMER_EVIDENCE_COVERAGE });
  expect(plan.sources.map(s => s.id)).toEqual(["segment-0", "segment-1", "segment-2"]);
  expect(consumerWorkInput(plan).requiredSourceSegmentIds).toEqual(plan.sources.map(s => s.id));
  expect(consumerWorkInput(plan).currentConsumer).toEqual(f.args.input.currentConsumer);
  expect(plan.evidenceCoverage!.subjects[0]!.ranges[0]).toMatchObject({ segmentIds: ["segment-1", "segment-2"] });
  expect(() => assertConsumerEvidenceRead(plan.evidenceCoverage!, new Set(["segment-0"]))).toThrow(/CONSUMER_EVIDENCE_UNREAD/);
  expect(() => assertConsumerEvidenceRead(plan.evidenceCoverage!, new Set(plan.sources.map(s => s.id)))).not.toThrow();
  expect(h(createConsumerWorkPlan(f.args))).toBe(h(old)); expect(h(f.args)).toBe(before);
});

it("includes nested dependency anchors and counter-evidence while retaining the full audit roster", () => {
  const f = fixture(), payload = { counterEvidence: [{ span: f.span(3) }], nested: { anchor: { version: 1, ...f.span(2) } } };
  const artifact = { kind: "world-rule", id: "rule", current: true, payload, revisionHash: h(payload) };
  const roster = { kind: "role-roster", id: "roster", current: false, payload, revisionHash: h(payload), evidenceRole: "retained-role-roster" as const };
  const subjects = consumerEvidenceSubjects(f.args.input, [artifact, roster]);
  expect(subjects.map(s => s.ref)).toEqual([f.args.scope.ref, "world-rule:rule"]);
  const coverage = consumerEvidenceCoverage("src", f.bytes, f.segments, subjects);
  expect(coverage.segmentIds).toEqual(["segment-1", "segment-2", "segment-3"]);
  expect(roster.payload).toEqual(payload);
});

it("stops on foreign, invalid, hash-mismatched or partially uncovered references rather than dropping evidence", () => {
  const f = fixture();
  const inspect = (span: unknown, segments = f.segments) => consumerEvidenceCoverage("src", f.bytes, segments,
    [{ ref: "rule/subject", revisionHash: h(span), payload: { evidence: [{ span }] } }]);
  for (const patch of [{ sourceId: "foreign" }, { endByte: f.bytes.length + 1 }, { startByte: -1 }, { endByte: undefined }, { quoteHash: h("wrong") }])
    expect(() => inspect({ ...f.span(), ...patch })).toThrow(/consumer evidence/i);
  expect(() => inspect(f.span(1, 2), f.segments.filter(s => s.id !== "segment-2"))).toThrow(/fully covered/);
  expect(() => inspect(f.span(1, 2), f.segments.filter(s => s.id !== "segment-1"))).toThrow(/missing or invalid/);
  expect(() => inspect(f.span(1, 2), f.segments.map((s, i) => i === 2 ? { ...s, id: "segment-1" } : s))).toThrow(/duplicate/);
  expect(() => inspect(f.span(1, 2), f.segments.map((s, i) => i === 2 ? { ...s, startByte: s.startByte - 1 } : s))).toThrow(/overlapping/);
  const lines = { sourceId: "src", startLine: 2, endLine: 3, quoteHash: "legacy-substring" };
  expect(inspect(lines).segmentIds).toEqual(["segment-1", "segment-2"]);
  expect(() => inspect({ ...lines, endLine: 900 })).toThrow(/line range/);
});

it("counts complete source and artifact receipts, excluding discovery and partial pages", () => {
  const f = fixture(), payload = { evidence: [{ span: f.span(2) }], notes: "x".repeat(250000) };
  const artifact = { kind: "world-rule", id: "extra", payload, current: true, revisionHash: h(payload) }, pages = consumerArtifactPages(artifact);
  const messages: any[] = [];
  const tool = (args: unknown, result: unknown) => {
    const id = String(messages.length);
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read_consumer_revalidation", arguments: args }] },
      { role: "toolResult", toolCallId: id, toolName: "read_consumer_revalidation", isError: false, content: [{ type: "text", text: JSON.stringify(result) }] });
  };
  tool({ collection: "source" }, { items: [{ id: "segment-2" }] });
  expect(consumerEvidenceReads(messages).sourceIds.size).toBe(0);
  tool({ collection: "source", segmentIds: ["segment-2"] }, { segments: [{ id: "segment-2", text: "She sees the door.", complete: true }] });
  for (const [offset, text] of pages.entries()) {
    const nextOffset = offset + 1 < pages.length ? offset + 1 : null;
    tool({ collection: "artifacts", refs: ["world-rule:extra"], offset }, { items: [{ ref: "world-rule:extra", revisionHash: h(payload),
      page: { offset, nextOffset, text }, complete: nextOffset === null }] });
    expect(consumerEvidenceReads(messages).artifacts.completed.has("world-rule:extra")).toBe(nextOffset === null);
  }
  const reads = consumerEvidenceReads(messages);
  expect([...reads.sourceIds]).toEqual(["segment-2"]);
  expect(reads.artifacts.subjects.get("world-rule:extra")!.payload).toEqual(payload);
});

it("discovers an original delivery gap but refuses to relabel a check that actually read the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-consumer-evidence-"));
  try {
    const f = fixture(), file = path.join(root, "novel.txt"); await fs.writeFile(file, f.bytes);
    const source = await (await WorkspaceStore.create(root)).registerSource(file);
    const scope = { ...f.args.scope, sourceId: source.id, taskId: h("task"), receiptFingerprint: h("receipt"), executionPolicy: "consumer-work/v1" } as ConsumerRevalidationScope;
    const payload = { evidence: [{ span: { ...f.span(2), sourceId: source.id } }] };
    const input = { ...f.args.input, scope, scopeHash: h(scope), currentConsumer: { payload, revisionHash: h(payload) } } as ConsumerWorkBaseInput;
    const contextDir = identityRequirementDirectory(root, source.id, scope.taskId), directory = path.join(consumerRevalidationDirectory(root, scope), "execution-v1");
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(contextDir, "context.json"), JSON.stringify({ manifest: { segments: f.segments } }));
    const records: ConsumerRevalidationRecord[] = [];
    for (const stage of ["consumer-revalidation", "consumer-revalidation-check"] as const) {
      const plan = createConsumerWorkPlan({ ...f.args, scope, input, stage });
      const wire = consumerWorkInput(plan), messages = JSON.stringify({ sequence: 1, message: { role: "user", content: "retained fixture" } }) + "\n";
      await fs.writeFile(path.join(directory, `${stage}.plan.json`), JSON.stringify(plan));
      await fs.writeFile(path.join(directory, `${stage}.input.json`), JSON.stringify(wire));
      await fs.writeFile(path.join(directory, `${stage}.messages.jsonl`), messages);
      records.push({ scope, executionPlanHash: h(plan), inputHash: h(wire), output: { phase: stage, disposition: "blocked", verdict: "supported" } } as unknown as ConsumerRevalidationRecord);
    }
    expect((await inspectConsumerEvidenceGap(root, scope, records))?.stages.map(s => s.missingSegmentIds)).toEqual([["segment-2"], ["segment-2"]]);
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "read", name: "read_consumer_revalidation", arguments: { collection: "source", segmentIds: ["segment-2"] } }] },
      { role: "toolResult", toolName: "read_consumer_revalidation", toolCallId: "read", content: [{ type: "text", text: JSON.stringify({ segments: [{ id: "segment-2", complete: true }] }) }] },
    ];
    await fs.writeFile(path.join(directory, "consumer-revalidation-check.messages.jsonl"), messages.map((message, i) => JSON.stringify({ sequence: i + 1, message })).join("\n") + "\n");
    expect(await inspectConsumerEvidenceGap(root, scope, records)).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("restores the resumed proposal and the complete source delivered to either entry-repair parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-parent-evidence-"));
  try {
    const bytes = Buffer.from("Chapter 1\nAda arrives.\nChapter 2\nZoë opens the door.\nChapter 3\nThe bell rings.\nChapter 4\nUnrelated.\n");
    const file = path.join(root, "novel.txt");
    await fs.writeFile(file, bytes);
    const source = await (await WorkspaceStore.create(root)).registerSource(file);
    const manifest = await segmentSource(root, source);
    const [opening, door, bell] = manifest.segments;
    expect(manifest.segments).toHaveLength(4);
    const f = fixture();
    const scope = { ...f.args.scope, sourceId: source.id, sourceHash: source.contentSha256,
      taskId: h("task"), receiptFingerprint: h("receipt"), executionPolicy: "consumer-work/v1" } as ConsumerRevalidationScope;
    const input = { ...f.args.input, scope, scopeHash: h(scope), requiredSourceSegmentIds: [opening!.id] };
    const contextDirectory = identityRequirementDirectory(root, source.id, scope.taskId);
    const baseDirectory = consumerWorkDirectory(consumerRevalidationDirectory(root, scope));
    await fs.mkdir(baseDirectory, { recursive: true });
    await fs.writeFile(path.join(contextDirectory, "context.json"), JSON.stringify({ manifest }));
    const records: ConsumerRevalidationRecord[] = [];
    for (const stage of ["consumer-revalidation", "consumer-revalidation-check"] as const) {
      const proposal = stage === "consumer-revalidation";
      const plan = createConsumerWorkPlan({ ...f.args, scope, stage, input, bytes, segments: manifest.segments,
        extraSources: proposal ? [] : [bell!.id] });
      const directory = proposal ? consumerWorkProviderDirectory(baseDirectory, stage) : baseDirectory;
      if (proposal) {
        plan.providerResumptionHash = h("resumption");
        plan.providerResumption = { originalSessionId: "original", requiredSourceSegmentIds: [door!.id], requiredArtifactRefs: [] };
        await fs.writeFile(path.join(baseDirectory, `${stage}.input.json`), JSON.stringify({ abandoned: true }));
      }
      const wire = consumerWorkInput(plan);
      const messages = proposal ? [
        { role: "assistant", content: [{ type: "toolCall", id: "read", name: "read_consumer_revalidation",
          arguments: { collection: "source", segmentIds: [door!.id] } }] },
        { role: "toolResult", toolCallId: "read", toolName: "read_consumer_revalidation", content: [{ type: "text",
          text: JSON.stringify({ segments: [{ id: door!.id, text: bytes.subarray(door!.startByte, door!.endByte).toString(), complete: true }] }) }] },
      ] : [{ role: "user", content: "independent check" }];
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${stage}.plan.json`), JSON.stringify(plan));
      await fs.writeFile(path.join(directory, `${stage}.input.json`), JSON.stringify(wire));
      await fs.writeFile(path.join(directory, `${stage}.messages.jsonl`),
        messages.map((message, i) => JSON.stringify({ sequence: i + 1, message })).join("\n") + "\n");
      records.push({ scope, executionPlanHash: h(plan), inputHash: h(wire),
        ...(proposal ? { providerResumptionHash: plan.providerResumptionHash } : {}),
        predecessorRecordHash: proposal ? null : h(records[0]), output: { phase: stage } } as ConsumerRevalidationRecord);
    }
    const context = await entryRepairParentContext(root, records);
    expect(h(context.originalInput)).toBe(records[0]!.inputHash);
    expect(context.additionalSources).toEqual([door!, bell!].map(({ id, startByte, endByte }) => {
      const text = bytes.subarray(startByte, endByte).toString("utf8");
      return { id, startByte, endByte, text, textHash: h(text) };
    }));
    expect(context.negativeJudgments).toEqual(records.map(r => r.output));
    const stop = (reason: string) => new Error(reason);
    const [found] = await resolveEntryRepairEvidence(root, scope, context, [{ segment_id: door!.id, exact: "Zoë" }], stop);
    expect(found!.anchor).toMatchObject({ sourceId: source.id, exactHash: sha(Buffer.from("Zoë")) });
    await expect(resolveEntryRepairEvidence(root, scope, context, [{ segment_id: manifest.segments[3]!.id, exact: "Unrelated" }], stop))
      .rejects.toThrow(/escaped the supplied original evidence/);
    const resumed = consumerWorkProviderDirectory(baseDirectory, "consumer-revalidation");
    await fs.writeFile(path.join(resumed, "consumer-revalidation.input.json"), "{}");
    await expect(entryRepairParentContext(root, records)).rejects.toThrow(/exact input/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
