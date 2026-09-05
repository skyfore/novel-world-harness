import { expect, it } from "vitest";
import { buildRoleRoster, type RoleRosterReview } from "../src/compiler/role-roster.js";
import { probeMajorRoleEntries } from "../src/compiler/playability.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import type { Entity } from "../src/world/model.js";

const evidence = [{ span: { sourceId: "source", startByte: 0, endByte: 4, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" as const }];
const entities: Entity[] = ["hero", "regent"].map((id) => ({ id, kind: "character", canonicalName: id, aliases: [], evidence }));
entities.push({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence });

it("probes the real engine per major character and retains an unplayable major as blocked", async () => {
  const roster = buildRoleRoster({ sourceId: "source", sourceSha256: "b".repeat(64), unitIds: ["unit"], entities, annotations: [], resolutions: [] });
  const review = (runId: string): RoleRosterReview => ({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: ["unit"], entries: roster.candidates.map((x) => ({ candidateId: x.id, importance: "major", rationale: "Central causal role", basisUnitIds: ["unit"] })) });
  roster.reviews = [review("review-1"), review("review-2")];
  const bundle = {
    source: { id: "source", contentMd5: "a".repeat(32), contentSha256: "b".repeat(64) },
    canonical: { entities, propositions: [], attributions: [], claims: [], events: [], eventParticipations: [], eventRelations: [], spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], goals: [], models: [], possibilities: [],
      initialWorld: { version: 1, evidence, participantPresence: [{ entityId: "hero", mode: "physical" }], actorObservations: [{ actorId: "hero", summary: "The hall lies before you" }],
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.plan", value: "Carry a letter" }] },
        projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 },
      },
    },
  } as PreparedNovelBundle;
  const manifest = await probeMajorRoleEntries(bundle, roster, "c".repeat(64));
  expect(manifest.issues).toEqual([]);
  expect(manifest.majorTotal).toBe(2);
  expect(manifest.readyTotal).toBe(1);
  const hero = manifest.roles.find((x) => x.actorId === "hero")!;
  expect(hero.issues).toEqual([]);
  expect(hero.probes.map((x) => x.kind)).toEqual(["genesis", "decision", "intent", "wait", "resume", "fork"]);
  expect(manifest.roles.find((x) => x.actorId === "regent")).toMatchObject({ status: "blocked", issues: [expect.objectContaining({ code: "MAJOR_ROLE_ENTRY_BLOCKED" })] });
});
