import fs from "node:fs/promises";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { stateDeltaSchema } from "./model.js";
import { InitialWorldStore } from "./initial.js";
import { openWorkspaceWorld } from "./workspace-runtime.js";

export type CreatedWorldBranch = {
  head: string;
  usedCanonicalInitial: boolean;
  preparedRevisionHash?: string;
};

export async function createWorldBranch(
  root: string,
  branchId: string,
  seedPath?: string,
  sourceId?: string,
  cacheRoot?: string,
): Promise<CreatedWorldBranch> {
  const source = sourceId ? await (await WorkspaceStore.create(root)).getSource(sourceId) : undefined;
  const prepared = source ? await new PreparedNovelCache(root, cacheRoot).loadFreshActive(source) : null;
  const artifacts = prepared ? {
    entities: prepared.bundle.canonical.entities,
    claims: prepared.bundle.canonical.claims,
    events: prepared.bundle.canonical.events,
    rules: prepared.bundle.canonical.rules,
    goals: prepared.bundle.canonical.goals,
    models: prepared.bundle.canonical.models,
    possibilities: prepared.bundle.canonical.possibilities,
  } : undefined;
  const { engine } = await openWorkspaceWorld(root, undefined, {
    ...(sourceId ? { sourceId } : {}),
    ...(prepared ? { preparedRevisionHash: prepared.bundleHash, artifacts } : {}),
  });
  const canonicalInitial = seedPath
    ? null
    : prepared?.bundle.canonical.initialWorld ?? await new InitialWorldStore(root).get();
  if (!seedPath && !canonicalInitial) {
    throw new Error("No accepted initial world. Review and accept an initial-world proposal before creating a playable branch, or pass --seed explicitly.");
  }
  if (sourceId && canonicalInitial && !canonicalInitial.evidence.some((reference) => reference.span.sourceId === sourceId)) {
    throw new Error(`Accepted initial world does not belong to source ${sourceId}.`);
  }
  const seed = seedPath
    ? stateDeltaSchema.parse(JSON.parse(await fs.readFile(seedPath, "utf8")))
    : canonicalInitial!.delta;
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
    branchId,
    seed,
    seedPath ? undefined : canonicalInitial?.knowledge,
    sourceId,
    prepared?.bundleHash,
    seedPath ? [] : canonicalInitial?.evidence,
  );
  return {
    head,
    usedCanonicalInitial: Boolean(canonicalInitial && !seedPath),
    ...(prepared ? { preparedRevisionHash: prepared.bundleHash } : {}),
  };
}
