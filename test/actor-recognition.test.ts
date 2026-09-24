import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldRuntime } from "../src/world/runtime.js";
import { WorldEngine } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { buildActorScopedActionContext, createPlayerActionModelBoundary } from "../src/world/player-action.js";
import { projectActorEntityNames, validateIdentityName } from "../src/world/actor-recognition.js";
import { propositionSchema, type Entity, type Claim } from "../src/world/model.js";
import type { ActorWorldView } from "../src/world/knowledge.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("actor-recognition contract", () => {
  it.each([
    { actor: "ada", secret: "Secret Chancellor", reported: "The Gardener", alternate: "The Courier" },
    { actor: "ning", secret: "隐姓的君主", reported: "看门人", alternate: "旅客" },
  ])("keeps reference, learned name, competing belief, forget and fork separate: $actor", async ({ actor, secret, reported, alternate }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-recognition-")); roots.push(root);
    const entities: Entity[] = [
      { id: actor, kind: "character", canonicalName: actor, aliases: [], evidence: [] },
      { id: "person", kind: "character", canonicalName: secret, aliases: ["Secret Alias"], evidence: [] },
      { id: "bystander", kind: "character", canonicalName: "Unrelated", aliases: [], evidence: [] },
      { id: "hall", kind: "location", canonicalName: "Secret Hall", aliases: [], evidence: [] },
    ];
    const claims: Claim[] = [
      { id: "presence", subject: "person", predicate: "stands-in", object: "hall", epistemicType: "explicit-fact", evidence: [] },
      { id: "reported-name", subject: "person", predicate: "identity-name", object: reported, epistemicType: "character-claim", evidence: [] },
      { id: "alternate-name", subject: "person", predicate: "identity-name", object: alternate, epistemicType: "rumor", evidence: [] },
    ];
    const context = { entities: new Map(entities.map(x => [x.id, x])), claims: new Map(claims.map(x => [x.id, x])), rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) };
    const engine = new WorldEngine(root, context);
    const before = await engine.createBranch("main", "Main", { version: 1, operations: [
      { op: "set", entityId: actor, field: "character.alive", value: true },
      { op: "set", entityId: actor, field: "character.location", value: "hall" },
      { op: "set", entityId: "person", field: "character.location", value: "hall" },
    ] }, { version: 1, operations: [{ op: "learn", actorId: actor, claimId: "presence", status: "knows", confidence: 1 }] });
    const anonymous = await buildActorScopedActionContext(engine, actor, before);
    expect(anonymous.referenceableEntities).toContainEqual(expect.objectContaining({ id: "person", nameAuthority: "unidentified" }));
    expect(JSON.stringify(createPlayerActionModelBoundary(anonymous).context)).not.toContain(secret);
    expect(JSON.stringify(anonymous)).not.toContain("Secret Alias");
    await new WorldRuntime(engine, () => []).forkBranch("main", before, "quiet", "Quiet");
    const change = async (id: string, operation: { op: "learn" | "forget"; claimId: string }) => {
      const result = await engine.commitProposal({ proposalId: id, branchId: "main", expectedParentCommit: await engine.branches.readHead("main"), source: "background", title: id, participants: [actor], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, proposedKnowledge: { version: 1, operations: [operation.op === "learn" ? { ...operation, actorId: actor, status: "heard", confidence: 0.5 } : { ...operation, actorId: actor }] }, causalParents: [], evidence: [] });
      expect(result.report.accepted).toBe(true); return result.newHead;
    };
    const learned = await change("heard-name", { op: "learn", claimId: "reported-name" });
    const named = await buildActorScopedActionContext(engine, actor, learned);
    expect(named.referenceableEntities).toContainEqual(expect.objectContaining({ id: "person", name: reported, nameAuthority: "acquired", knownNames: [reported] }));
    expect(JSON.stringify(named)).not.toContain(secret);
    const conflicting = await change("another-name", { op: "learn", claimId: "alternate-name" });
    expect((await buildActorScopedActionContext(engine, actor, conflicting)).referenceableEntities).toContainEqual(expect.objectContaining({ id: "person", nameAuthority: "ambiguous", knownNames: expect.arrayContaining([reported, alternate]) }));
    const forgot = await change("discard-rumor", { op: "forget", claimId: "alternate-name" });
    const reopened = new WorldEngine(root, context);
    expect((await buildActorScopedActionContext(reopened, actor, forgot)).referenceableEntities).toEqual(named.referenceableEntities);
    expect((await buildActorScopedActionContext(reopened, actor, before)).referenceableEntities).toEqual(anonymous.referenceableEntities);
    expect(await engine.branches.readHead("quiet")).toBe(before);
    expect((await buildActorScopedActionContext(reopened, "bystander", forgot)).referenceableEntities).not.toContainEqual(expect.objectContaining({ name: reported }));
  });

  it("does not upgrade negative, uncomprehended, foreign or rejected claims", () => {
    const entities: Entity[] = [{ id: "person", kind: "character", canonicalName: "Hidden", aliases: [], evidence: [] }];
    const entry: ActorWorldView["knowledge"][number] = { fact: { actorId: "observer", claimId: "name", status: "heard", confidence: 1, acquiredAtCommit: "cut" }, claim: { id: "name", subject: "person", predicate: "identity-name", object: "Known Label", epistemicType: "character-claim", evidence: [] } };
    for (const item of [
      { ...entry, fact: { ...entry.fact, actorId: "other" } },
      { ...entry, fact: { ...entry.fact, status: "disbelieves" as const } },
      { ...entry, fact: { ...entry.fact, reception: { received: true as const, understood: false, belief: "undecided" as const } } },
      { ...entry, proposition: { id: "p", subjectEntityId: "person", relationId: "identity-name", object: { kind: "literal" as const, value: "Known Label" }, polarity: "negative" as const, modality: "asserted" as const, evidence: [] } },
    ]) expect(projectActorEntityNames("observer", entities, [item])[0]?.nameAuthority).toBe("unidentified");
    expect(projectActorEntityNames("observer", entities, [{ ...entry, claim: { ...entry.claim!, predicate: "identity-alias" } }])[0]).toMatchObject({ name: "Known Label", nameAuthority: "acquired" });
  });

  it("reserves exact typed name relations without guessing from prose or malformed literals", () => {
    for (const value of ["", "   ", 42, { entityId: "person" }, "x".repeat(401)]) expect(validateIdentityName("identity-name", value)).toHaveLength(1);
    expect(validateIdentityName("identity-alias", "A")).toEqual([]);
    expect(propositionSchema.parse({ id: "p-name", subjectEntityId: "person", relationId: "identity-name", object: { kind: "literal", value: "A" }, polarity: "positive", modality: "asserted", evidence: [] }).relationId).toBe("identity-name");
    expect(validateIdentityName("looks like the king", "")).toEqual([]);
  });
});
