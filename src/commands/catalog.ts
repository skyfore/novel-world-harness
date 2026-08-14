import { stdout } from "node:process";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  type PlayExperienceCatalog,
  type PlayableCharacter,
  type PlayInstanceSummary,
} from "../world/play-experience.js";
import { choosePlayInstance, choosePlayNovel, type AskPlayQuestion } from "../world/play-choice.js";
import { askUserQuestion } from "../util/ask-user-question.js";

export async function novelsCommand(root: string): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  stdout.write(`${formatNovels(catalog)}\n`);
}

export async function instancesCommand(root: string): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  stdout.write(`${formatInstances(catalog.instances)}\n`);
}

export async function charactersCommand(
  root: string,
  branchId?: string,
  source?: string,
  ask: AskPlayQuestion = askUserQuestion,
): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  const sourceId = catalog.novels.length || source
    ? await choosePlayNovel(catalog, source, ask, { preferActive: false })
    : undefined;
  if (catalog.novels.length && !sourceId) return;
  const selectedBranchId = await choosePlayInstance(root, branchId, ask, catalog);
  if (!selectedBranchId) return;
  const result = await listPlayableCharacters(root, { branchId: selectedBranchId, ...(sourceId ? { source: sourceId } : {}) });
  stdout.write(`${formatCharacters(result.characters, result.branchId, result.source?.title)}\n`);
}

export async function progressCommand(
  root: string,
  branchId?: string,
  ask: AskPlayQuestion = askUserQuestion,
): Promise<void> {
  const catalog = await inspectPlayExperience(root);
  const selectedBranchId = await choosePlayInstance(root, branchId, ask, catalog);
  if (!selectedBranchId) return;
  const instance = catalog.instances.find((candidate) => candidate.branchId === selectedBranchId);
  if (!instance) throw new Error(`Unknown instance '${selectedBranchId}'. Use nwh instances.`);
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
      const novel = instance.sourceTitle ? `\tnovel=${instance.sourceTitle} (${instance.sourceId})` : "";
      const sync = instance.sessionAtHead === false ? "\tresume=head-advanced" : "";
      const parent = instance.parentBranchId ? `\tfrom=${instance.parentBranchId}` : "";
      return `${instance.active ? "*" : " "} ${instance.branchId}\tstep=${instance.logicalStep}\tcommits=${instance.commitCount}\tevents=${instance.eventCount}${novel}${actor}${parent}${sync}\thead=${instance.headCommitId.slice(0, 12)}`;
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
    `Novel: ${instance.sourceTitle ? `${instance.sourceTitle} (${instance.sourceId})` : "not selected"}`,
    `Character: ${instance.actorName ? `${instance.actorName} (${instance.actorId})` : "not selected"}`,
    `Last event: ${instance.lastEventTitle ?? "none"}`,
    ...(instance.sessionAtHead === false ? ["Resume state: branch advanced since the last player turn; resume will use the current committed head."] : []),
  ].join("\n");
}
