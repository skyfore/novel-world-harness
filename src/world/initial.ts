import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { worldStorageRoot } from "./paths.js";
import {
  actorEventObservationSchema,
  evidenceRefSchema,
  idSchema,
  knowledgeDeltaSchema,
  participantPresenceSchema,
  stateDeltaSchema,
  storyTimeSchema,
  type EvidenceAssertion,
  type ValidationIssue,
} from "./model.js";

export const openingReaderFactKindSchema = z.enum([
  "focal-identity",
  "time-place",
  "entity-identity",
  "relationship",
  "causal-premise",
  "actor-stance",
  "social-stakes",
  "immediate-pressure",
  "completed-prior-beat",
]);
export type OpeningReaderFactKind = z.infer<typeof openingReaderFactKindSchema>;

export const openingReaderFactSchema = z
  .object({
    id: idSchema,
    kind: openingReaderFactKindSchema,
    /** Presentation semantic backed by an exact field-level evidence assertion. */
    summary: z.string().trim().min(1).max(1_000),
    temporalClass: z.enum([
      "at-checkpoint",
      "before-checkpoint",
      "later-discourse-preexisting",
    ]),
    basis: z.enum([
      "checkpoint-state",
      "completed-before-checkpoint",
      "source-narrator-established",
      "focal-knowledge",
    ]),
    entityIds: z.array(idSchema).max(32).default([]),
    /** Required for actor-stance/social-stakes so pressure is not silently assigned to the focal actor. */
    holderEntityId: idSchema.optional(),
    stance: z.enum(["positive", "negative", "neutral", "ambivalent", "indifferent"]).optional(),
    /** These claims must also be present in the focal actor's initial KnowledgeDelta. */
    focalKnowledgeClaimIds: z.array(idSchema).max(32).default([]),
    dependsOnFactIds: z.array(idSchema).max(32).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === "actor-stance" || value.kind === "social-stakes") && !value.holderEntityId) {
      ctx.addIssue({
        code: "custom",
        path: ["holderEntityId"],
        message: `${value.kind} must name the character or institution that holds the stance or stakes`,
      });
    }
    if (value.kind === "actor-stance" && !value.stance) {
      ctx.addIssue({ code: "custom", path: ["stance"], message: "actor-stance must classify its direction" });
    }
    if (value.holderEntityId && !value.entityIds.includes(value.holderEntityId)) {
      ctx.addIssue({
        code: "custom",
        path: ["entityIds"],
        message: "The stance/stakes holder must also be included in entityIds so first-use gloss validation cannot be bypassed",
      });
    }
    if (value.basis === "focal-knowledge" && !value.focalKnowledgeClaimIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["focalKnowledgeClaimIds"],
        message: "focal-knowledge facts must reference at least one seeded knowledge claim",
      });
    }
  });
export type OpeningReaderFact = z.infer<typeof openingReaderFactSchema>;

export const openingEntityGlossSchema = z.object({
  entityId: idSchema,
  /** Who this entity is in relation to the focal actor. */
  relationshipToFocal: z.string().trim().min(1).max(500),
  /** Why an unread reader needs this identity at this exact checkpoint. */
  whyRelevantNow: z.string().trim().min(1).max(500),
  factIds: z.array(idSchema).min(1).max(32),
}).strict();
export type OpeningEntityGloss = z.infer<typeof openingEntityGlossSchema>;

export const openingReaderContextSchema = z
  .object({
    version: z.literal(1),
    focalActorId: idSchema,
    facts: z.array(openingReaderFactSchema).min(5).max(96),
    entityGlosses: z.array(openingEntityGlossSchema).max(64),
    immediateSituation: z.object({
      summary: z.string().trim().min(1).max(1_000),
      causalFactIds: z.array(idSchema).min(1).max(32),
      pressureFactIds: z.array(idSchema).min(1).max(32),
      unresolvedFactIds: z.array(idSchema).min(1).max(32),
      outcomePolicy: z.literal("withhold-post-checkpoint-outcomes"),
    }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const factIds = new Set<string>();
    for (let index = 0; index < value.facts.length; index += 1) {
      const fact = value.facts[index]!;
      if (factIds.has(fact.id)) {
        ctx.addIssue({ code: "custom", path: ["facts", index, "id"], message: `Duplicate reader fact ${fact.id}` });
      }
      factIds.add(fact.id);
    }
    for (const kind of [
      "focal-identity",
      "time-place",
      "causal-premise",
      "actor-stance",
      "immediate-pressure",
    ] as const) {
      if (!value.facts.some((fact) => fact.kind === kind)) {
        ctx.addIssue({ code: "custom", path: ["facts"], message: `Opening reader context requires one ${kind} fact` });
      }
    }
    if (!value.facts.some((fact) => fact.kind === "focal-identity" && fact.entityIds.includes(value.focalActorId))) {
      ctx.addIssue({
        code: "custom",
        path: ["facts"],
        message: "The focal-identity fact must reference focalActorId",
      });
    }
    const validateFactRef = (factId: string, path: (string | number)[]) => {
      if (!factIds.has(factId)) ctx.addIssue({ code: "custom", path, message: `Unknown reader fact ${factId}` });
    };
    value.facts.forEach((fact, factIndex) => fact.dependsOnFactIds.forEach((factId, dependencyIndex) =>
      validateFactRef(factId, ["facts", factIndex, "dependsOnFactIds", dependencyIndex])));
    value.entityGlosses.forEach((gloss, glossIndex) => gloss.factIds.forEach((factId, factIndex) => {
      validateFactRef(factId, ["entityGlosses", glossIndex, "factIds", factIndex]);
      const fact = value.facts.find((candidate) => candidate.id === factId);
      if (fact && !fact.entityIds.includes(gloss.entityId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entityGlosses", glossIndex, "factIds", factIndex],
          message: `Reader fact ${factId} does not reference glossed entity ${gloss.entityId}`,
        });
      }
    }));
    for (const field of ["causalFactIds", "pressureFactIds", "unresolvedFactIds"] as const) {
      value.immediateSituation[field].forEach((factId, factIndex) =>
        validateFactRef(factId, ["immediateSituation", field, factIndex]));
    }
    for (const [index, factId] of value.immediateSituation.causalFactIds.entries()) {
      const fact = value.facts.find((candidate) => candidate.id === factId);
      if (fact && !["causal-premise", "completed-prior-beat"].includes(fact.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["immediateSituation", "causalFactIds", index],
          message: `Immediate causal fact ${factId} must be a causal-premise or completed-prior-beat`,
        });
      }
    }
    for (const [index, factId] of value.immediateSituation.pressureFactIds.entries()) {
      const fact = value.facts.find((candidate) => candidate.id === factId);
      if (fact && !["immediate-pressure", "social-stakes"].includes(fact.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["immediateSituation", "pressureFactIds", index],
          message: `Immediate pressure fact ${factId} must be an immediate-pressure or social-stakes fact`,
        });
      }
    }
  });
export type OpeningReaderContext = z.infer<typeof openingReaderContextSchema>;

export const openingCheckpointSchema = z
  .object({
    mode: z.enum(["chronological", "textual-frame", "custom"]),
    storyTime: storyTimeSchema.optional(),
    narrativeLayerId: idSchema.optional(),
    beforeCanonicalEventId: idSchema.optional(),
    rationale: z.string().trim().min(1).max(1000),
  })
  .strict();
export type OpeningCheckpoint = z.infer<typeof openingCheckpointSchema>;

export const initialWorldSchema = z
  .object({
    version: z.literal(1),
    /** Display-only, source-grounded orientation for an unread human player. */
    readerSetup: z.string().trim().min(1).max(2000).optional(),
    /** Structured presentation authority. It never becomes actor knowledge or branch state. */
    readerContext: openingReaderContextSchema.optional(),
    /** Character appearance mode at the opening checkpoint; only physical roles are playable there. */
    participantPresence: z.array(participantPresenceSchema).max(128).optional(),
    /** Direct checkpoint perception copied into the committed Genesis event. */
    actorObservations: z.array(actorEventObservationSchema).max(128).optional(),
    delta: stateDeltaSchema,
    knowledge: knowledgeDeltaSchema.optional(),
    checkpoint: openingCheckpointSchema.optional(),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type InitialWorld = z.infer<typeof initialWorldSchema>;
export type InitialWorldRevisionRef = { hash: string };

function exactSupportPaths(assertions: readonly EvidenceAssertion[]): Set<string> {
  return new Set(assertions
    .filter((assertion) => assertion.relation === "supports" && assertion.strength !== "weak-inference")
    .map((assertion) => assertion.target.jsonPointer));
}

/** Required field-level provenance for the literary entry contract. */
export function validateInitialWorldEvidenceAssertions(
  initial: InitialWorld,
  assertions: readonly EvidenceAssertion[],
): ValidationIssue[] {
  if (!initial.readerContext && !initial.actorObservations?.length) return [];
  const supported = exactSupportPaths(assertions);
  const issues: ValidationIssue[] = [];
  const requirePath = (path: string) => {
    if (!supported.has(path)) {
      issues.push({
        code: "MISSING_OPENING_FIELD_EVIDENCE",
        message: `Opening literary field ${path} requires an exact explicit or strong-inference supporting evidence assertion.`,
        path,
      });
    }
  };
  if (initial.readerContext && initial.readerSetup) requirePath("/readerSetup");
  initial.readerContext?.facts.forEach((_fact, index) => requirePath(`/readerContext/facts/${index}/summary`));
  initial.readerContext?.entityGlosses.forEach((_gloss, index) => {
    requirePath(`/readerContext/entityGlosses/${index}/relationshipToFocal`);
    requirePath(`/readerContext/entityGlosses/${index}/whyRelevantNow`);
  });
  if (initial.readerContext) requirePath("/readerContext/immediateSituation/summary");
  initial.actorObservations?.forEach((_observation, index) => requirePath(`/actorObservations/${index}/summary`));
  return issues;
}
type StoredInitialWorldRef = { version: 1; hash: string; updatedAt: string };

export class InitialWorldStore {
  readonly filePath: string;
  readonly root: string;
  constructor(workspaceRoot: string) {
    const canonRoot = path.join(worldStorageRoot(workspaceRoot), "canon");
    this.filePath = path.join(canonRoot, "initial-world.json");
    this.root = path.join(canonRoot, "initial-world");
  }

  async put(input: InitialWorld): Promise<void> {
    const value = initialWorldSchema.parse(input);
    await this.migrateLegacy();
    const hash = contentHash(value);
    await writeImmutable(this.revisionPath(hash), value);
    await atomicJson(this.refPath(), { version: 1, hash, updatedAt: new Date().toISOString() } satisfies StoredInitialWorldRef);
  }

  async get(): Promise<InitialWorld | null> {
    const ref = await this.readRef();
    if (ref) return this.getRevision(ref.hash);
    try {
      return initialWorldSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async currentRevision(): Promise<InitialWorldRevisionRef | null> {
    const ref = await this.readRef();
    if (ref) return { hash: ref.hash };
    const legacy = await this.readLegacy();
    return legacy ? { hash: contentHash(legacy) } : null;
  }

  async getRevision(hash: string): Promise<InitialWorld> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid initial-world revision hash: ${hash}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.revisionPath(hash), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = await this.readLegacy();
      if (!legacy || contentHash(legacy) !== hash) {
        throw Object.assign(new Error(`Initial-world revision not found: ${hash}`), { code: "ENOENT" });
      }
      raw = legacy;
    }
    const value = initialWorldSchema.parse(raw);
    if (contentHash(value) !== hash) throw new Error(`Corrupt initial-world revision ${hash}`);
    return value;
  }

  async clear(): Promise<void> {
    await this.migrateLegacy();
    await fs.rm(this.refPath(), { force: true });
  }

  private async migrateLegacy(): Promise<void> {
    const legacy = await this.readLegacy();
    if (!legacy) return;
    await writeImmutable(this.revisionPath(contentHash(legacy)), legacy);
    await fs.rm(this.filePath, { force: true });
  }

  private async readLegacy(): Promise<InitialWorld | null> {
    try { return initialWorldSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async readRef(): Promise<StoredInitialWorldRef | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.refPath(), "utf8")) as StoredInitialWorldRef;
      if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error("Invalid initial-world ref");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private refPath(): string { return path.join(this.root, "current.json"); }
  private revisionPath(hash: string): string { return path.join(this.root, "revisions", `${hash}.json`); }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Initial-world revision collision: ${filePath}`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
