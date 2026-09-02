import fs from "node:fs/promises";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { stateDeltaSchema } from "./model.js";
import { InitialWorldStore } from "./initial.js";
import { openWorkspaceWorld } from "./workspace-runtime.js";
import { assertEvidenceExclusiveToSource } from "./source-scope.js";
import { deriveCharacterEntrySeed, type ReaderEntryContext } from "./entry-context.js";

export type CreatedWorldBranch = {
  head: string;
  usedCanonicalInitial: boolean;
  preparedRevisionHash?: string;
  readerContext?: ReaderEntryContext;
};

export async function createWorldBranch(
  root: string,
  branchId: string,
  seedPath?: string,
  sourceId?: string,
  cacheRoot?: string,
  entryActorId?: string,
  expectedPreparedRevisionHash?: string,
): Promise<CreatedWorldBranch> {
  const workspace = await WorkspaceStore.create(root);
  const sources = await workspace.listSources();
  const source = sourceId
    ? await workspace.getSource(sourceId)
    : sources.length === 1
      ? sources[0]!
      : undefined;
  if (sourceId && !source) throw new Error(`Unknown source id: ${sourceId}`);
  if (!sourceId && sources.length > 1) {
    throw new Error(`Multiple sources are registered; specify --source. Available: ${sources.map((item) => item.id).join(", ")}`);
  }
  const effectiveSourceId = source?.id;
  const prepared = source ? await new PreparedNovelCache(root, cacheRoot).loadFreshActive(source) : null;
  if (expectedPreparedRevisionHash && prepared?.bundleHash !== expectedPreparedRevisionHash) {
    throw new Error(
      `Active prepared revision changed from ${expectedPreparedRevisionHash} to ${prepared?.bundleHash ?? "none"}; refresh the frozen base before creating an instance.`,
    );
  }
  const artifacts = prepared ? {
    entities: prepared.bundle.canonical.entities,
    propositions: prepared.bundle.canonical.propositions,
    attributions: prepared.bundle.canonical.attributions,
    claims: prepared.bundle.canonical.claims,
    events: prepared.bundle.canonical.events,
    eventParticipations: prepared.bundle.canonical.eventParticipations,
    eventRelations: prepared.bundle.canonical.eventRelations,
    spatialRelations: prepared.bundle.canonical.spatialRelations,
    sceneOccurrences: prepared.bundle.canonical.sceneOccurrences,
    eventFrames: prepared.bundle.canonical.eventFrames,
    actionSchemas: prepared.bundle.canonical.actionSchemas,
    actionConstraints: prepared.bundle.canonical.actionConstraints,
    normTemplates: prepared.bundle.canonical.normTemplates,
    processTemplates: prepared.bundle.canonical.processTemplates,
    rules: prepared.bundle.canonical.rules,
    goals: prepared.bundle.canonical.goals,
    models: prepared.bundle.canonical.models,
    possibilities: prepared.bundle.canonical.possibilities,
  } : undefined;
  const { engine } = await openWorkspaceWorld(root, undefined, {
    ...(effectiveSourceId ? { sourceId: effectiveSourceId } : {}),
    ...(prepared ? { preparedRevisionHash: prepared.bundleHash, artifacts } : {}),
  });
  const canonicalInitial = seedPath
    ? null
    : prepared?.bundle.canonical.initialWorld ?? await new InitialWorldStore(root).get();
  if (seedPath && entryActorId) throw new Error("A character entry checkpoint cannot be combined with an explicit seed file.");
  if (entryActorId && !prepared) {
    throw new Error("Character-specific entry requires an active prepared novel revision.");
  }
  const entrySeed = entryActorId && prepared
    ? deriveCharacterEntrySeed(prepared.bundle, entryActorId)
    : undefined;
  if (!seedPath && !canonicalInitial) {
    throw new Error("No accepted initial world. Review and accept an initial-world proposal before creating a playable branch, or pass --seed explicitly.");
  }
  if (effectiveSourceId && canonicalInitial) {
    if (!canonicalInitial.evidence.some((reference) => reference.span.sourceId === effectiveSourceId)) {
      throw new Error(`Accepted initial world does not belong to source ${effectiveSourceId}.`);
    }
    assertEvidenceExclusiveToSource(canonicalInitial.evidence, effectiveSourceId, "Accepted initial world");
  }
  const seed = seedPath
    ? stateDeltaSchema.parse(JSON.parse(await fs.readFile(seedPath, "utf8")))
    : entrySeed?.delta ?? canonicalInitial!.delta;
  const checkpointPresence = entrySeed?.participantPresence?.length
    ? entrySeed.participantPresence
    : canonicalInitial?.participantPresence?.length
      ? canonicalInitial.participantPresence
      : undefined;
  const checkpointActorObservations = seedPath
    ? []
    : entrySeed?.actorObservations?.length
      ? entrySeed.actorObservations
      : canonicalInitial?.actorObservations ?? [];
  if (!seedPath) {
    const represented = new Set(seed.operations.flatMap((operation) => "entityId" in operation ? [operation.entityId] : []));
    const explicitlyDead = new Set<string>();
    for (const operation of seed.operations) {
      if (!("entityId" in operation) || operation.field !== "character.alive") continue;
      if (operation.op === "set" && operation.value === false) explicitlyDead.add(operation.entityId);
      else explicitlyDead.delete(operation.entityId);
    }
    for (const operation of canonicalInitial?.knowledge?.operations ?? []) {
      represented.add(operation.actorId);
      if (operation.op === "learn" && operation.sourceActorId) represented.add(operation.sourceActorId);
    }
    if (![...represented].some((entityId) =>
      engine.context.entities.get(entityId)?.kind === "character" && !explicitlyDead.has(entityId))) {
      throw new Error("The accepted opening world is evidence-backed but semantically unplayable: it represents no non-dead character in committed state or knowledge. Rebuild and publish the opening state before creating a branch.");
    }
  }
  const head = await engine.createBranch(
    branchId,
    source?.titleInference?.title ?? branchId,
    seed,
    seedPath ? undefined : entrySeed?.knowledge ?? canonicalInitial?.knowledge,
    effectiveSourceId,
    prepared?.bundleHash,
    seedPath ? [] : entrySeed?.evidence ?? canonicalInitial?.evidence,
    seedPath ? {} : {
      ...(entrySeed?.storyTime
        ? { storyTime: entrySeed.storyTime }
        : canonicalInitial?.checkpoint?.storyTime
          ? { storyTime: canonicalInitial.checkpoint.storyTime }
          : {}),
      elapsedDays: 0,
    },
    seedPath ? {} : {
      ...(entryActorId ? { entryActorId } : {}),
      ...(entrySeed?.realizesCanonicalEventIds.length
        ? { realizesCanonicalEventIds: entrySeed.realizesCanonicalEventIds }
        : {}),
      ...(checkpointPresence ? { participantPresence: checkpointPresence } : {}),
      ...(checkpointActorObservations.length
        ? { actorObservations: checkpointActorObservations }
        : {}),
    },
  );
  return {
    head,
    usedCanonicalInitial: Boolean(canonicalInitial && !seedPath),
    ...(prepared ? { preparedRevisionHash: prepared.bundleHash } : {}),
    ...(entrySeed ? { readerContext: entrySeed.readerContext } : {}),
  };
}
