import { stdout } from "node:process";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  type PlayExperienceCatalog,
  type PlayableCharacter,
  type PlayInstanceSummary,
} from "../world/play-experience.js";

export async function novelsCommand(root: string): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  stdout.write(`${formatNovels(catalog)}\n`);
}

export async function instancesCommand(root: string): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  stdout.write(`${formatInstances(catalog.instances)}\n`);
}

export async function charactersCommand(root: string, branchId?: string, source?: string): Promise<void> {
  const result = await listPlayableCharacters(root, { ...(branchId ? { branchId } : {}), ...(source ? { source } : {}) });
  stdout.write(`${formatCharacters(result.characters, result.branchId, result.source?.title)}\n`);
}

export async function progressCommand(root: string, branchId?: string): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  const instance = branchId
    ? catalog.instances.find((candidate) => candidate.branchId === branchId)
    : catalog.instances.find((candidate) => candidate.active)
      ?? (catalog.instances.length === 1 ? catalog.instances[0] : undefined);
  if (!instance) {
    if (branchId) throw new Error(`Unknown instance '${branchId}'. Use nwh instances.`);
    throw new Error("No unambiguous current instance. Use nwh progress <instance> or nwh instances.");
  }
  stdout.write(`${formatProgress(instance)}\n`);
}

export function formatNovels(catalog: Pick<PlayExperienceCatalog, "project" | "novels">): string {
  if (!catalog.novels.length) return "No novels are registered in this workspace. Run nwh ingest <novel> or nwh prepare <novel>.";
  const heading = catalog.project ? `Novels in ${catalog.project.name}:` : "Registered novels:";
  return [
    heading,
    ...catalog.novels.map((source) => `  ${source.id}\t${source.title}\t${source.sourcePath}\t${source.bytes} bytes`),
  ].join("\n");
}

export function formatInstances(instances: readonly PlayInstanceSummary[]): string {
  if (!instances.length) return "No playable instances exist. Run nwh prepare-all first.";
  return [
    "Playable instances (* current):",
    ...instances.map((instance) => {
      const actor = instance.actorName ? `\tactor=${instance.actorName} (${instance.actorId})` : "";
      const sync = instance.sessionAtHead === false ? "\tresume=head-advanced" : "";
      const parent = instance.parentBranchId ? `\tfrom=${instance.parentBranchId}` : "";
      return `${instance.active ? "*" : " "} ${instance.branchId}\tstep=${instance.logicalStep}\tcommits=${instance.commitCount}\tevents=${instance.eventCount}${actor}${parent}${sync}\thead=${instance.headCommitId.slice(0, 12)}`;
    }),
  ].join("\n");
}

export function formatCharacters(
  characters: readonly PlayableCharacter[],
  branchId: string,
  novelTitle?: string,
): string {
  const scope = novelTitle ? ` for ${novelTitle}` : "";
  if (!characters.length) return `No committed characters are available on '${branchId}'${scope}.`;
  return [
    `Characters on '${branchId}'${scope}:`,
    ...characters.map((character) => {
      const aliases = character.aliases.length ? `\taliases=${character.aliases.join(", ")}` : "";
      const location = character.locationName ? `\tlocation=${character.locationName}` : "";
      const availability = character.alive === false ? "\t[not playable: dead]" : "";
      return `  ${character.id}\t${character.canonicalName}${aliases}${location}${availability}`;
    }),
  ].join("\n");
}

export function formatProgress(instance: PlayInstanceSummary): string {
  return [
    `Instance: ${instance.branchId} (${instance.name})${instance.active ? " [current]" : ""}`,
    `Progress: logical step ${instance.logicalStep}; ${instance.commitCount} commits; ${instance.eventCount} committed events`,
    `Head: ${instance.headCommitId}`,
    `Character: ${instance.actorName ? `${instance.actorName} (${instance.actorId})` : "not selected"}`,
    `Last event: ${instance.lastEventTitle ?? "none"}`,
    ...(instance.sessionAtHead === false ? ["Resume state: branch advanced since the last player turn; resume will use the current committed head."] : []),
  ].join("\n");
}
