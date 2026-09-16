import { expect, it } from "vitest";
import { buildRoleRoster, type RoleRosterReview } from "../src/compiler/role-roster.js";
import { probeMajorRoleEntries } from "../src/compiler/playability.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import type { Entity } from "../src/world/model.js";
import { describePreparedRoles, requireCertifiedEntry } from "../src/world/play-roles.js";
import { entryDriverWitnessIssues } from "../src/compiler/entry-driver-probe.js";
import { preparedPlayRoleSchema } from "../src/world/play-role-schema.js";

const evidence = [{ span: { sourceId: "source", startByte: 0, endByte: 4, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" as const }];
const entities: Entity[] = ["hero", "regent", "courier"].map((id) => ({ id, kind: "character", canonicalName: id, aliases: [], evidence }));
entities.push({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence });

function fixture() {
  const roster = buildRoleRoster({ sourceId: "source", sourceSha256: "b".repeat(64), unitIds: ["unit"], entities, annotations: [], resolutions: [] });
  const review = (runId: string): RoleRosterReview => ({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: ["unit"], entries: roster.candidates.map((x) => ({ candidateId: x.id, importance: x.id === roster.candidates.find(candidate => candidate.entityId === "courier")!.id ? "supporting" : "major", rationale: "Central causal role", basisUnitIds: ["unit"] })) });
  roster.reviews = [review("review-1"), review("review-2")];
  const bundle = {
    version: 4, segmenterVersion: 1, batchIds: [], compilerSnapshot: { roleRoster: roster },
    source: { id: "source", contentMd5: "a".repeat(32), contentSha256: "b".repeat(64) },
    canonical: { entities, propositions: [], attributions: [], claims: [], events: [], eventParticipations: [], eventRelations: [], spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], goals: [{ id: "courier-goal", actorId: "courier", description: "Deliver the letter", priority: 1, requiresKnowledge: [], evidence,
        candidateAction: { title: "Courier chooses the next delivery", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "courier", field: "character.plan", value: "deliver the letter" }] } },
      }], models: [], possibilities: [],
      initialWorld: { version: 1, evidence, participantPresence: [{ entityId: "hero", mode: "physical" }, { entityId: "courier", mode: "physical" }], actorObservations: [{ actorId: "hero", summary: "The hall lies before you" }],
        delta: { version: 1, operations: [{ op: "set", entityId: "courier", field: "character.alive", value: true }, { op: "set", entityId: "courier", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.plan", value: "Carry a letter" }] },
        projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 },
      },
    },
  } as PreparedNovelBundle;
  return { bundle, roster };
}

it("probes the real engine per major character and retains an unplayable major as blocked", async () => {
  const { bundle, roster } = fixture();
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  expect(manifest.issues).toEqual([]);
  expect(manifest.majorTotal).toBe(2);
  expect(manifest.readyTotal).toBe(1);
  const hero = manifest.roles.find((x) => x.actorId === "hero")!;
  expect(hero.issues).toEqual([]);
  expect(hero.driverWitness).toMatchObject({ lane: "actor", excludedActorId: "hero", events: [{ event: { actorId: "courier" } }] });
  const scope = { sourceId: bundle.source.id, subjectSnapshotHash: "c".repeat(64), entryCutHash: hero.entryCutHash!, actorId: "hero" };
  expect(entryDriverWitnessIssues(hero.driverWitness, scope)).toEqual([]);
  expect(entryDriverWitnessIssues(undefined, scope)).toContain("ENTRY_DRIVER_NOT_EVALUATED");
  const forged = structuredClone(hero.driverWitness!);
  forged.events[0]!.event.actorId = "hero";
  expect(entryDriverWitnessIssues(forged, scope)).toEqual(expect.arrayContaining(["ENTRY_DRIVER_EVENT_HASH_MISMATCH", "ENTRY_DRIVER_PLAYER_ACTION"]));
  const brokenEffects = structuredClone(hero.driverWitness!);
  brokenEffects.events[0]!.effects.stateDelta!.operations = [];
  expect(entryDriverWitnessIssues(brokenEffects, scope)).toEqual(expect.arrayContaining(["ENTRY_DRIVER_EFFECT_HASH_MISMATCH", "ENTRY_DRIVER_PROGRESS_INVALID"]));
  expect(entryDriverWitnessIssues(hero.driverWitness, { ...scope, entryCutHash: "d".repeat(64) })).toContain("ENTRY_DRIVER_SCOPE_STALE");
  expect(hero.probes.map((x) => x.kind)).toEqual(["genesis", "decision", "driver", "intent", "wait", "resume", "fork"]);
  expect(manifest.roles.find((x) => x.actorId === "regent")).toMatchObject({ status: "blocked", issues: [expect.objectContaining({ code: "MAJOR_ROLE_ENTRY_BLOCKED" })] });
  roster.reviews[1]!.missingMajorCharacters = [{ name: "Unresolved queen", rationale: "Determines the ending", basisUnitIds: ["unit"] }];
  const roles = describePreparedRoles(bundle);
  expect(roles).toHaveLength(4);
  expect(roles.find((role) => role.canonicalName === "Unresolved queen")).toMatchObject({ status: "unresolved-identity", major: true });
  expect(roles.every((role) => role.status !== "ready")).toBe(true);
  expect(() => requireCertifiedEntry(bundle, "hero")).toThrow("WORLD_CLOSURE_BLOCKED");
  expect(preparedPlayRoleSchema.safeParse({ ...roles[0], status: "ready", actorId: undefined }).success).toBe(false);
});


it.each(["static-goal", "player-only", "guard-blocked", "dead-npc", "same-value"])("does not certify %s as an autonomous driver", async kind => {
  const { bundle, roster } = fixture();
  const goal = bundle.canonical.goals[0]!;
  if (kind === "static-goal") delete goal.candidateAction;
  if (kind === "player-only") {
    goal.actorId = "hero";
    goal.candidateAction!.proposedDelta.operations = [{ op: "set", entityId: "hero", field: "character.plan", value: "deliver" }];
  }
  if (kind === "guard-blocked") goal.candidateAction!.preconditions = [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: false }];
  if (kind === "dead-npc") bundle.canonical.initialWorld!.delta.operations[0] = { op: "set", entityId: "courier", field: "character.alive", value: false };
  if (kind === "same-value") bundle.canonical.initialWorld!.delta.operations.push({ op: "set", entityId: "courier", field: "character.plan", value: "deliver the letter" });
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  const hero = manifest.roles.find(role => role.actorId === "hero")!;
  expect(hero.status).toBe("blocked");
  expect(hero.driverWitness).toBeUndefined();
  expect(hero.issues.map(issue => issue.message).join()).toContain("ENTRY_DRIVER_UNPROVEN");
});


it.each([false, true])("checks actual environmental commits without treating future canon as a driver (canonical=%s)", async canonical => {
  const { bundle, roster } = fixture();
  bundle.canonical.goals = [];
  bundle.canonical.initialWorld!.delta.operations.push({ op: "set", entityId: "hall", field: "location.open", value: true });
  const delta = { version: 1 as const, operations: [{ op: "set" as const, entityId: "hall", field: "location.open", value: false }] };
  bundle.canonical.possibilities = [{ id: "gate-closes", kind: canonical ? "canon-analogue" : "environmental", title: "Wind closes the hall gate",
    ...(canonical ? { canonicalEventId: "future-close" } : {}),
    preconditions: [{ op: "fact-equals", entityId: "hall", field: "location.open", value: true }], blockers: [], participants: ["hall"], causalParents: [], pressure: 1, relevance: 1,
    proposedDelta: delta, evidence,
  }];
  bundle.canonical.initialWorld!.checkpoint = { mode: "chronological", rationale: "Before the gate closes", storyTime: { kind: "ordinal", label: "opening", orderHint: 0 } };
  if (canonical) bundle.canonical.events.push({ id: "future-close", title: "The gate closes later", participants: ["hall"], storyTime: { kind: "ordinal", label: "later", orderHint: 1 },
    preconditions: [], observedOutcome: delta, causalParents: [], confidence: 1, evidence,
  });
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  const hero = manifest.roles.find(role => role.actorId === "hero")!;
  if (canonical) {
    expect(hero.driverWitness).toBeUndefined();
    expect(hero.issues.map(issue => issue.message).join()).toContain("ENTRY_DRIVER_UNPROVEN");
  } else {
    expect(hero.issues).toEqual([]);
    expect(hero.driverWitness).toMatchObject({ lane: "background", events: [{ event: { possibilityId: "gate-closes", progressCertificate: { channels: expect.arrayContaining(["state"]) } } }] });
  }
});


it("commits a due world process at the entry cut without inventing a player wait", async () => {
  const { bundle, roster } = fixture();
  bundle.canonical.goals = [];
  bundle.canonical.processTemplates = [{ ontologyVersion: "process-template-v1", id: "storm", name: "Storm arrival",
    ownerRoles: [{ id: "witness", label: "Witness", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
    phases: [{ id: "gathering", label: "Gathering", terminal: false }, { id: "arrived", label: "Arrived", terminal: true }],
    initialPhaseId: "gathering", transitions: [{ fromPhaseId: "gathering", toPhaseId: "arrived", minimumProgress: 1, onDue: { advanceBy: 1, outcomeId: "arrived" } }],
    cadence: { kind: "elapsed-days", intervalDays: 1 }, outcomeIds: ["arrived"], visibility: "observable",
    induction: { kind: "domain-module", moduleId: "weather", moduleVersion: "1" }, evidence: [],
  }];
  bundle.canonical.initialWorld!.projectionSeed!.processes.operations = [{ op: "start-process", process: {
    id: "opening-storm", templateId: "storm", ownerBindings: [{ roleId: "witness", entityIds: ["hero"] }], phaseId: "gathering", progress: 0, dueAtElapsedDays: 0,
  } }];
  const before = structuredClone(bundle);
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  expect(manifest.issues).toEqual([]);
  const hero = manifest.roles.find(role => role.actorId === "hero")!;
  expect(hero.issues).toEqual([]);
  expect(hero.driverWitness).toMatchObject({ lane: "background", events: [{ event: { progressCertificate: { channels: expect.arrayContaining(["process"]) } } }] });
  expect(hero.driverWitness!.events[0]!.effects.processDelta!.operations).toContainEqual(expect.objectContaining({ op: "finish-process", processId: "opening-storm" }));
  expect(bundle).toEqual(before);
});

it("excludes the focal actor before spending the driver alternative-search budget", async () => {
  const { bundle, roster } = fixture();
  const original = bundle.canonical.goals[0]!;
  original.priority = 0.1;
  for (let index = 0; index < 65; index++) bundle.canonical.goals.push({ ...original,
    id: `focal-noop-${index}`, actorId: "hero", priority: 1,
    candidateAction: { title: "Repeat the focal plan", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Carry a letter" }] } },
  });
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  const hero = manifest.roles.find(role => role.actorId === "hero")!;
  expect(hero.issues).toEqual([]);
  expect(hero.driverWitness).toMatchObject({ lane: "actor", excludedActorId: "hero", events: [{ event: { actorId: "courier" } }] });
});

it.each([false, true])("keeps actor search exhaustion distinct from an independent background witness (environment=%s)", async environment => {
  const { bundle, roster } = fixture();
  const base = bundle.canonical.goals[0]!;
  bundle.canonical.goals = Array.from({ length: 65 }, (_, index) => ({ ...base, id: `courier-noop-${index}`,
    candidateAction: { title: "Repeat the courier plan", preconditions: [], proposedDelta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "courier", field: "character.plan", value: "old plan" }] } },
  }));
  bundle.canonical.initialWorld!.delta.operations.push({ op: "set", entityId: "courier", field: "character.plan", value: "old plan" }, { op: "set", entityId: "hall", field: "location.open", value: true });
  if (environment) bundle.canonical.possibilities = [{ id: "wind-closes-gate", kind: "environmental", title: "Wind closes the gate", preconditions: [{ op: "fact-equals", entityId: "hall", field: "location.open", value: true }], blockers: [], participants: ["hall"], causalParents: [], pressure: 1, relevance: 1, proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hall", field: "location.open", value: false }] }, evidence }];
  const before = structuredClone(bundle);
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  const hero = manifest.roles.find(role => role.actorId === "hero")!;
  if (environment) {
    expect(hero.issues).toEqual([]);
    expect(hero.driverWitness).toMatchObject({ lane: "background", events: [{ event: { possibilityId: "wind-closes-gate" } }] });
  } else {
    expect(hero.driverWitness).toBeUndefined();
    expect(hero.issues.map(issue => issue.message).join()).toContain("ENTRY_DRIVER_SEARCH_INCOMPLETE");
  }
  expect(bundle).toEqual(before);
});
