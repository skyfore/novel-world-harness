import { expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { findConsumerArtifact, discoverConsumerArtifacts } from "../src/compiler/identity-consumer-revalidation.js";
import { consumerDependencyCatalog, consumerArtifactPages, consumerArtifactReadHint, ConsumerArtifactReadTracker,
  encodeConsumerArtifact, decodeConsumerArtifact, type ConsumerArtifact } from "../src/compiler/identity-consumer-artifacts.js";
import { identityFixture } from "./helpers/identity-fixture.js";

it("maps exact source-owned graph dependencies and distinguishes retained roster evidence from active world data", () => {
  const { inventory } = identityFixture(), source = { sourceId: "src", sourceHash: contentHash("source") };
  const roster = { sourceId: source.sourceId, sourceSha256: source.sourceHash, unitIds: ["unit-a"], candidates: [] };
  const catalog: ConsumerArtifact[] = ["initial-world:singleton", "canonical-event:arrival", "norm-template:rule", "entity-mention:mention"].map(ref => {
    const [kind, id] = ref.split(":") as [string, string], payload = { id }; return { kind, id, payload, revisionHash: contentHash(payload), current: true };
  });
  inventory.consumers = ["initial/src", "event/arrival", "norm/rule", "annotation/mention", "roster/src"].map(ref => {
    const payload: any = ref.startsWith("roster/") ? roster : { id: ref, annotationType: "entity-mention" };
    return { ref, payload, revisionHash: contentHash(payload), reason: "typed-consumer", dependencies: [] };
  });
  const before = contentHash({ catalog, inventory, roster }), bound = consumerDependencyCatalog(catalog, source, inventory, roster);
  for (const [ref, kind, id] of [["initial/src", "initial-world", "singleton"], ["event/arrival", "canonical-event", "arrival"],
    ["norm/rule", "norm-template", "rule"], ["annotation/mention", "entity-mention", "mention"], ["roster/src", "role-roster", "src"]]) {
    expect(findConsumerArtifact(bound, ref!)).toMatchObject({ kind, id });
    expect(findConsumerArtifact(bound, ref!.replace("/", ":"))).toBe(findConsumerArtifact(bound, ref!));
    expect(discoverConsumerArtifacts(bound, ref)).toEqual([findConsumerArtifact(bound, ref!)]);
  }
  expect(findConsumerArtifact(bound, "roster/src")).toMatchObject({ current: false, evidenceRole: "retained-role-roster", payload: roster });
  expect(findConsumerArtifact(bound, "initial/other-source")).toBeUndefined();
  expect(findConsumerArtifact(bound, "roster/other-source")).toBeUndefined();
  expect(findConsumerArtifact(bound, "norm/guessed-rule")).toBeUndefined();
  expect(() => consumerDependencyCatalog(catalog, source, inventory, { ...roster, candidates: ["changed"] })).toThrow(/Retained roster dependency/);
  expect(() => consumerDependencyCatalog([...catalog, { kind: "event", id: "arrival", payload: {}, revisionHash: contentHash({}), current: true }], source, inventory, roster)).toThrow(/Ambiguous dependency/);
  expect(contentHash({ catalog, inventory, roster })).toBe(before);
});

it("reads an oversized complete roster losslessly in ordered bounded pages, including every opaque unit ID", () => {
  const payload = { sourceId: "src", unitIds: Array.from({ length: 11000 }, (_, i) => `unit-sentence-${contentHash(i).slice(0, 24)}`),
    candidates: [{ id: "role-ada", text: "原文😀，包含标点及空白\n".repeat(1800) }],
    reserved: [["$nwh.prefixed-strings", [["unit-", 2, "abcd"]]], ["$nwh.literal-array", []]],
    ...JSON.parse('{"__proto__":{"untrusted":true}}') };
  expect(decodeConsumerArtifact(encodeConsumerArtifact(payload))).toEqual(payload);
  expect(Object.prototype).not.toHaveProperty("untrusted");
  const c: ConsumerArtifact = { kind: "role-roster", id: "src", payload, revisionHash: contentHash(payload), current: false, evidenceRole: "retained-role-roster" };
  const pages = consumerArtifactPages(c), tracker = new ConsumerArtifactReadTracker();
  expect(consumerArtifactReadHint(c)).toMatchObject({ readMode: "paged", pageCount: pages.length, readArguments: { refs: ["role-roster:src"], offset: 0 } });
  expect(Buffer.byteLength(pages.join(""))).toBeLessThan(Buffer.byteLength(JSON.stringify(payload)) - 150000);
  const item = (index: number) => ({ ref: "role-roster:src", revisionHash: c.revisionHash,
    page: { offset: index, nextOffset: index + 1 < pages.length ? index + 1 : null, text: pages[index]! }, complete: index === pages.length - 1 });
  expect(() => tracker.accept(item(pages.length - 1))).toThrow(/missing, reordered/);
  for (let i = 0; i < pages.length; i++) {
    expect(tracker.completed.size).toBe(0);
    expect(Buffer.byteLength(JSON.stringify({ items: [item(i)] }))).toBeLessThan(200000);
    tracker.accept(item(i));
  }
  expect(tracker.completed).toEqual(new Set(["role-roster:src"]));
  expect(decodeConsumerArtifact(JSON.parse(pages.join("")))).toEqual(payload);
  const changed = new ConsumerArtifactReadTracker();
  for (let i = 0; i < pages.length - 1; i++) changed.accept(item(i));
  const last = item(pages.length - 1); last.page.text = last.page.text.replace("unit-sentence-", "unit-foreign--");
  // Corrupt a guaranteed literal at the end while preserving JSON shape.
  last.page.text = last.page.text.replace(/([a-f0-9])(?=[^a-f0-9]*$)/u, "X");
  expect(() => changed.accept(last)).toThrow();
  expect(changed.completed.size).toBe(0);
  expect(() => decodeConsumerArtifact(["$nwh.prefixed-strings", [["unit-", 0, "abc"]]])).toThrow(/Invalid packed/);
});
