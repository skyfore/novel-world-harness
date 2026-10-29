import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { currentConsumerPayload } from "../src/compiler/identity-consumer-revalidation.js";
import { loadCompilerArtifactRecords } from "../src/compiler/artifact-retrieval.js";
import { canonicalEventSchema, characterEntryCheckpointSchema, type CanonicalEvent } from "../src/world/model.js";
import { applyEventExecutions, eventExecutionSchema } from "../src/world/event-execution.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash as hash } from "../src/world/canonical.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

function fixture(withBinding = true) {
  const checkpoint = characterEntryCheckpointSchema.parse({ actorId: "ada", readerSetup: "Ada waits before arrival.",
    actorObservation: "You wait at the gate.", participantPresence: [{ entityId: "ada", mode: "physical" }],
    delta: { version: 1, operations: [] } });
  const event = canonicalEventSchema.parse({ id: "arrival", title: "Arrival", participants: ["ada"],
    participantPresence: checkpoint.participantPresence, characterEntryCheckpoints: [checkpoint],
    storyTime: { kind: "ordinal", label: "arrival", orderHint: 1 }, preconditions: [],
    observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1,
    evidence: [{ span: { sourceId: "src", startByte: 0, endByte: 10, startLine: 1, endLine: 1, quoteHash: hash("Ada waits.") }, strength: "explicit" }] });
  const binding = eventExecutionSchema.parse({ id: "ada-entry", canonicalEventId: event.id, actorId: "ada", evidence: event.evidence,
    entryCheckpoint: { ...checkpoint, actorObservation: "You are about to greet the visitor.",
      projectionSeed: { version: 1, elapsedDays: 7, activeRuleIds: [], semantics: { version: 1, operations: [] },
        processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] } } } });
  const payloads = new Map<string, unknown>([[`canonical-event:${event.id}`, event]]);
  if (withBinding) payloads.set(`event-execution:${binding.id}`, binding);
  const current = { payloads, activeRevisions: new Map([...payloads].map(([key, payload]) => [key, hash(payload)])) };
  const consumer = { ref: "entry/ada/arrival", reason: "typed-consumer", payload: { ...checkpoint, actorObservation: "Frozen earlier observation." } };
  const put = (key: string, payload: unknown) => { payloads.set(key, payload); current.activeRevisions.set(key, hash(payload)); };
  return { event, checkpoint, binding, current, consumer, put };
}

it("resolves an embedded entry from its active event without substituting the frozen consumer", () => {
  const f = fixture(false), before = hash([...f.current.payloads]);
  expect(currentConsumerPayload(f.consumer, f.current)).toBe(f.event.characterEntryCheckpoints![0]);
  expect(currentConsumerPayload(f.consumer, f.current)).not.toEqual(f.consumer.payload);
  expect(hash([...f.current.payloads])).toBe(before);
});

it("uses the same execution overlay as runtime and ignores retired bindings and other actors/events", () => {
  const f = fixture(), before = hash([...f.current.payloads]);
  const expected = applyEventExecutions([f.event], [f.binding])[0]!.characterEntryCheckpoints![0];
  expect(currentConsumerPayload(f.consumer, f.current)).toBe(expected);
  expect(hash([...f.current.payloads])).toBe(before);
  f.current.payloads.set("event-execution:retired-entry", { ...f.binding, id: "retired-entry" });
  f.put("event-execution:another-event", { ...f.binding, id: "another-event", canonicalEventId: "another-event" });
  f.put("event-execution:another-actor", { ...f.binding, id: "another-actor", actorId: "bob", entryCheckpoint: {
    ...f.binding.entryCheckpoint, actorId: "bob", participantPresence: [{ entityId: "bob", mode: "physical" }],
  } });
  expect(currentConsumerPayload(f.consumer, f.current)).toBe(f.binding.entryCheckpoint);
  f.current.activeRevisions.delete("event-execution:ada-entry");
  expect(currentConsumerPayload(f.consumer, f.current)).toBe(f.event.characterEntryCheckpoints![0]);
});

it.each(["missing-owner", "retired-owner", "stale-owner", "wrong-event-id", "missing-binding", "stale-binding",
  "wrong-binding-id", "actor-mismatch", "duplicate-binding", "duplicate-embedded", "missing-entry", "malformed-ref"])(
  "stops on %s without falling back to a frozen or standalone entry", failure => {
    const f = fixture();
    switch (failure) {
      case "missing-owner": f.current.payloads.delete("canonical-event:arrival"); break;
      case "retired-owner": f.current.activeRevisions.delete("canonical-event:arrival"); break;
      case "stale-owner": f.current.activeRevisions.set("canonical-event:arrival", hash("old revision")); break;
      case "wrong-event-id": f.put("canonical-event:arrival", { ...f.event, id: "different-event" }); break;
      case "missing-binding": f.current.payloads.delete("event-execution:ada-entry"); break;
      case "stale-binding": f.current.activeRevisions.set("event-execution:ada-entry", hash("old binding")); break;
      case "wrong-binding-id": f.put("event-execution:ada-entry", { ...f.binding, id: "other-binding" }); break;
      case "actor-mismatch": f.put("event-execution:ada-entry", { ...f.binding, actorId: "bob" }); break;
      case "duplicate-binding": f.put("event-execution:duplicate", { ...f.binding, id: "duplicate" }); break;
      case "duplicate-embedded": f.put("canonical-event:arrival", { ...f.event, characterEntryCheckpoints: [f.checkpoint, f.checkpoint] }); break;
      case "missing-entry":
        f.current.activeRevisions.delete("event-execution:ada-entry");
        f.put("canonical-event:arrival", { ...f.event, characterEntryCheckpoints: [] }); break;
      case "malformed-ref": f.consumer.ref = "entry/ada/arrival/extra"; break;
    }
    f.put("entry:ada/arrival", f.consumer.payload);
    const before = hash({ payloads: [...f.current.payloads], active: [...f.current.activeRevisions] });
    expect(() => currentConsumerPayload(f.consumer, f.current)).toThrow(/ROLE_PREREQUISITE_HOST_REVIEW.*same --source\/--task.*no frozen-payload fallback/);
    expect(hash({ payloads: [...f.current.payloads], active: [...f.current.activeRevisions] })).toBe(before);
  },
);

it("locates a real source-scoped stored entry and its later execution overlay without writing world truth", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-consumer-"));
  try {
    const source = await createEvidenceFixture(root, "Ada waits."), f = fixture(), store = new CanonicalModelStore(root);
    const event: CanonicalEvent = { ...f.event, evidence: source.evidence("Ada waits.") };
    await store.putEvent(event);
    const load = async () => {
      const records = (await loadCompilerArtifactRecords(root, source.source.id)).filter(r => r.status === "canonical");
      const payloads = new Map(records.map(r => [`${r.kind}:${r.logicalId}`, r.payload]));
      expect([...payloads.keys()].some(key => key.startsWith("entry:"))).toBe(false);
      return { payloads, activeRevisions: new Map([...payloads].map(([key, payload]) => [key, hash(payload)])) };
    };
    expect(currentConsumerPayload(f.consumer, await load())).toEqual(event.characterEntryCheckpoints![0]);
    const binding = { ...f.binding, evidence: event.evidence };
    await store.putEventExecution(binding);
    expect(currentConsumerPayload(f.consumer, await load())).toEqual(binding.entryCheckpoint);
    expect(await store.getEvent(event.id)).toEqual(event);
    expect(await store.getEventExecution(binding.id)).toEqual(binding);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
