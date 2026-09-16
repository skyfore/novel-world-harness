import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ensureSourceStructure, baseStructuralUnits } from "../src/compiler/structure.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { buildRoleRoster, type RoleRoster } from "../src/compiler/role-roster.js";
import { characterModelSchema } from "../src/world/actors.js";
import { contentHash } from "../src/world/canonical.js";
import { evaluateCoreRoleCapabilities, coreRoleResultIssues } from "../src/compiler/core-role-capabilities.js";
import { probeMajorRoleEntries } from "../src/compiler/playability.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";

const roots: string[] = [];
const subject = "f".repeat(64);
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-core-roles-")); roots.push(root);
  const text = "Ada distrusts strangers. Bo plans to help Ada. Bo rescues Ada. Ada learns to trust strangers.";
  const source = await createEvidenceFixture(root, text), bytes = Buffer.from(text);
  const structure = await ensureSourceStructure(root, source.source), units = baseStructuralUnits(structure);
  const entities = ["ada", "bo"].map(id => ({ id, kind: "character" as const, canonicalName: id === "ada" ? "Ada" : "Bo", aliases: [], evidence: source.evidence(id === "ada" ? "Ada distrusts strangers." : "Bo plans to help Ada.") }));
  const roster = buildRoleRoster({ sourceId: source.source.id, sourceSha256: source.source.contentSha256, unitIds: structure.baseUnitIds, entities, annotations: [], resolutions: [] });
  roster.reviews = ["reader-one", "reader-two"].map(runId => ({ version: 2, runId, subjectHash: roster.subjectHash,
    reviewedUnitIds: roster.unitIds, entries: roster.candidates.map(candidate => ({ candidateId: candidate.id,
      importance: candidate.entityId === "ada" ? "major" : "supporting", rationale: "Independent source role review", basisUnitIds: [units[0]!.id],
      developmentExpectation: candidate.entityId === "ada" ? { kind: "changes", rationale: "Trust develops after rescue", changes: [{
        dimensionId: "trust-readiness", direction: "increase", rationale: "Changed behavior", beforeUnitIds: [units[0]!.id], afterUnitIds: [units[3]!.id],
      }] } : { kind: "stable", rationale: "Consistent help", basisUnitIds: [units[1]!.id] },
    })),
  } satisfies RoleRoster["reviews"][number]));
  const model = characterModelSchema.parse({ actorId: "ada", ontologyVersion: "character-v1", traits: {}, decisionBiases: {}, evidence: source.evidence(text),
    dispositions: [
      { id: "distrust", actorId: "ada", dimensionId: "trust-readiness", value: -0.6, scope: { kind: "global" }, stability: "stable", basis: "explicit-characterization", status: "supported", confidence: 1, evidence: source.evidence("Ada distrusts strangers.") },
      { id: "trust", actorId: "ada", dimensionId: "trust-readiness", value: 0.6, scope: { kind: "global" }, stability: "stable", basis: "explicit-characterization", status: "supported", confidence: 1, evidence: source.evidence("Ada learns to trust strangers.") },
    ],
    developmentEpisodes: [{ id: "rescue-development", actorId: "ada", triggerMode: "experienced", triggerEventIds: ["rescue"], beforeDispositionIds: ["distrust"], afterDispositionIds: ["trust"],
      mechanism: "Experienced rescue changes trust", startsAt: { kind: "relative", anchorEventId: "rescue", relation: "after" }, decay: { kind: "none" }, evidenceStatus: "supported", confidence: 1, evidence: source.evidence("Bo rescues Ada.") }],
  });
  const bundle = {
    version: 4, segmenterVersion: 1, batchIds: [], source: source.source,
    compilerSnapshot: { structure, roleRoster: roster, evidenceBindings: [] },
    canonical: { entities: [...entities, { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: source.evidence(text) }],
      propositions: [], attributions: [], claims: [], eventParticipations: [], eventRelations: [], spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], eventExecutions: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], possibilities: [], models: [model],
      events: [{ id: "rescue", title: "Bo rescues Ada", participants: ["ada", "bo"], participantPresence: [{ entityId: "ada", mode: "physical" }, { entityId: "bo", mode: "physical" }],
        storyTime: { kind: "ordinal", label: "rescue", orderHint: 1 }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence: source.evidence("Bo rescues Ada.") }],
      goals: [{ id: "help-ada", actorId: "bo", description: "Help Ada", priority: 1, requiresKnowledge: [], evidence: source.evidence("Bo plans to help Ada."),
        candidateAction: { title: "Bo prepares to help", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "bo", field: "character.plan", value: "help Ada" }] } } }],
      initialWorld: { version: 1, evidence: source.evidence(text), participantPresence: [{ entityId: "ada", mode: "physical" }, { entityId: "bo", mode: "physical" }],
        checkpoint: { mode: "chronological", rationale: "Before rescue", storyTime: { kind: "ordinal", label: "opening", orderHint: 0 } },
        delta: { version: 1, operations: [...entities.flatMap(entity => [{ op: "set", entityId: entity.id, field: "character.alive", value: true }, { op: "set", entityId: entity.id, field: "character.location", value: "hall" }]), { op: "set", entityId: "ada", field: "character.plan", value: "stay safe" }] },
        projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 },
      },
    },
  } as unknown as PreparedNovelBundle;
  const bind = () => {
    bundle.compilerSnapshot.evidenceBindings = [{ artifactKind: "character-model", artifactId: model.actorId, artifactHash: contentHash(model),
      assertions: (["dispositions", "developmentEpisodes"] as const).flatMap(field => (model[field] ?? []).map((record, index) => ({ version: 1 as const,
        id: `${field}-${index}`, target: { artifactKind: "character-model", artifactId: model.actorId, jsonPointer: `/${field}/${index}` },
        anchors: record.evidence.map(ref => textAnchorForByteRange(source.source.id, bytes, ref.span.startByte!, ref.span.endByte!)), relation: "supports" as const, strength: "explicit" as const,
        derivation: { runId: "compiled-model", worker: "fixture", ontologyVersion: "evidence-v1" as const },
      }))),
    }];
  };
  bind();
  const playability = await probeMajorRoleEntries(bundle, roster, subject);
  const evaluate = () => evaluateCoreRoleCapabilities(bundle, roster, playability, subject);
  const state = (capability: string) => evaluate().requirements.find(item => item.id.endsWith(`:${capability}`))!;
  return { bundle, roster, model, bind, playability, evaluate, state, source };
}

it("settles the independent denominator and three separate capabilities using exact bindings and real driver commits", async () => {
  const f = await fixture();
  expect(f.playability.roles[0]!.issues).toEqual([]);
  const result = f.evaluate();
  expect(result.requirements).toHaveLength(4);
  expect(result.requirements.every(item => item.state === "satisfied")).toBe(true);
  expect(coreRoleResultIssues(f.bundle, f.roster, f.playability, subject, result)).toEqual([]);
  f.bundle.canonical.models = [];
  expect(f.state("ontology").state).toBe("blocked");
  expect(f.state("development").state).toBe("blocked");
  expect(f.state("opening-driver").state).toBe("satisfied");
  expect(coreRoleResultIssues(f.bundle, f.roster, f.playability, subject, result)).toContain("CORE_ROLE_REQUIREMENT_RESULT_STALE_OR_MISMATCH");
});

it.each(["wrong-direction", "wrong-evidence", "missing-episode", "unexperienced", "wrong-scope", "temporary-only", "wrong-trigger"])("rejects %s despite the presence of a development model", async failure => {
  const f = await fixture();
  if (failure === "wrong-trigger") {
    f.bundle.canonical.events.push({ ...f.bundle.canonical.events[0]!, id: "plan", title: "Bo plans", evidence: f.source.evidence("Bo plans to help Ada."), storyTime: { kind: "ordinal", label: "plan", orderHint: 0.5 } });
    f.model.developmentEpisodes![0]!.triggerEventIds = ["plan"];
    f.model.developmentEpisodes![0]!.startsAt = { kind: "relative", anchorEventId: "plan", relation: "after" };
  }
  if (failure === "wrong-direction") f.model.dispositions![1]!.value = -0.9;
  if (failure === "wrong-evidence") f.model.dispositions![1]!.evidence = f.source.evidence("Ada distrusts strangers.");
  if (failure === "missing-episode") f.model.developmentEpisodes = [];
  if (failure === "unexperienced") f.bundle.canonical.events[0]!.participantPresence![0]!.mode = "mentioned";
  if (failure === "temporary-only") f.model.dispositions![1]!.stability = "situational";
  if (failure === "wrong-scope") f.model.dispositions![1]!.scope = { kind: "target", targetEntityId: "bo" };
  f.bind();
  expect(f.state("development").state).toBe("blocked");
  if (failure === "wrong-trigger") {
    expect(f.state("ontology").state).toBe("satisfied");
    expect(f.state("opening-driver").diagnostics).toContain("ENTRY_DRIVER_SCOPE_STALE");
  } else expect(f.state("opening-driver").state).toBe("satisfied");
});

it("accepts independently reviewed stability without inventing growth and rejects conflicting temporal policy", async () => {
  const f = await fixture();
  for (const review of f.roster.reviews) for (const entry of review.entries) entry.developmentExpectation = { kind: "stable", rationale: "Independent continuity review", basisUnitIds: f.roster.unitIds };
  expect(f.state("development").state).toBe("blocked");
  f.model.dispositions = [f.model.dispositions![0]!]; f.model.developmentEpisodes = []; f.bind();
  expect(f.state("ontology").state).toBe("satisfied");
  expect(f.state("development").state).toBe("satisfied");
  f.model.dispositions!.push({ ...f.model.dispositions![0]!, id: "temporary-caution", stability: "situational", validStoryTime: { kind: "relative", anchorEventId: "rescue", relation: "before" } });
  f.bind();
  expect(f.state("development").state).toBe("satisfied");
  delete f.roster.reviews[0]!.version;
  expect(f.state("development").state).toBe("unknown");
});

it("retains omitted roles and rejects stale exact evidence bindings and forged success", async () => {
  const f = await fixture();
  f.bundle.compilerSnapshot.evidenceBindings[0]!.assertions[0]!.target.artifactId = "bo";
  expect(f.state("ontology").diagnostics).toContain("CORE_CHARACTER_ASSERTION_SCOPE_INVALID");
  f.bind();
  f.bundle.compilerSnapshot.evidenceBindings[0]!.artifactHash = "0".repeat(64);
  expect(f.state("ontology").state).toBe("blocked");
  const forged = f.evaluate(); forged.requirements.forEach(item => { item.state = "satisfied"; item.diagnostics = []; item.blockedBy = []; });
  expect(coreRoleResultIssues(f.bundle, f.roster, f.playability, subject, forged)).toContain("CORE_ROLE_REQUIREMENT_RESULT_STALE_OR_MISMATCH");
  f.roster.reviews[0]!.missingMajorCharacters = [{ name: "The Queen", rationale: "Missing causal actor", basisUnitIds: [f.roster.unitIds[0]!] }];
  expect(f.evaluate().requirements).toHaveLength(7);
  expect(f.evaluate().requirements.find(item => item.id === "core-roles:source-review")!.state).toBe("satisfied");
  expect(f.evaluate().requirements.filter(item => item.id.startsWith("omitted-role-")).every(item => item.state !== "satisfied")).toBe(true);
});
