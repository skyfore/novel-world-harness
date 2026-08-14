import type { UserQuestion } from "../util/ask-user-question.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  resolveCharacter,
  selectPlayExperience,
  type PlayExperienceCatalog,
  type PlayInstanceSummary,
  type SelectedPlayExperience,
} from "./play-experience.js";

export type AskPlayQuestion = (question: UserQuestion<string>) => Promise<string | undefined>;

export async function choosePlayInstance(
  root: string,
  requested: string | undefined,
  ask: AskPlayQuestion,
  providedCatalog?: PlayExperienceCatalog,
): Promise<string | undefined> {
  const catalog = providedCatalog ?? await inspectPlayExperience(root);
  if (!catalog.instances.length) throw new Error("No playable instances exist. Run nwh prepare-all first.");
  if (requested) {
    const resolved = resolvePlayInstance(catalog.instances, requested);
    if (resolved) return resolved.branchId;
  }
  if (!requested) {
    const active = catalog.instances.find((instance) => instance.active);
    if (active) return active.branchId;
    if (catalog.instances.length === 1) return catalog.instances[0]!.branchId;
  }

  return ask({
    header: "Instance",
    question: requested
      ? `No unique instance matches '${requested}'. Which novel-world instance do you want to use?`
      : "Which novel-world instance do you want to use?",
    options: catalog.instances.map((instance, index) => ({
      value: instance.branchId,
      label: `${instance.name} (${instance.branchId})`,
      description: `step ${instance.logicalStep}; ${instance.eventCount} committed event(s)${instance.actorName ? `; last played as ${instance.actorName}` : ""}`,
      recommended: index === 0,
    })),
    customInput: {
      label: "Enter an instance",
      description: "Type an instance id or name.",
      prompt: "Instance id or name",
      placeholder: catalog.instances[0]?.branchId,
      invalidMessage: "No unique playable instance matches that value.",
      resolve: (value) => resolvePlayInstance(catalog.instances, value)?.branchId,
    },
    nonInteractiveHint: requested
      ? `Instance '${requested}' is not uniquely playable. Pass a valid --branch <id> (or instance argument).`
      : "Multiple playable instances exist. Pass --branch <id> (or an instance argument) explicitly.",
  });
}

export async function choosePlayExperience(
  root: string,
  options: { branchId?: string; character?: string },
  ask: AskPlayQuestion,
): Promise<SelectedPlayExperience | undefined> {
  const catalog = await inspectPlayExperience(root);
  const branchId = await choosePlayInstance(root, options.branchId, ask, catalog);
  if (!branchId) return undefined;
  const listed = await listPlayableCharacters(root, { branchId });
  const playable = listed.characters.filter((character) => character.alive !== false);
  if (!playable.length) throw new Error(`No living committed characters are playable on '${branchId}'.`);
  const saved = catalog.savedSessions.find((session) => session.branchId === branchId);
  const requestedCharacter = options.character;
  let character = requestedCharacter ? resolveCharacter(playable, requestedCharacter)?.id : undefined;
  if (!requestedCharacter && saved && playable.some((candidate) => candidate.id === saved.actorId)) character = saved.actorId;
  if (!requestedCharacter && !character && playable.length === 1) character = playable[0]!.id;
  if (!character) {
    character = await ask({
      header: "Character",
      question: requestedCharacter
        ? `No unique living character matches '${requestedCharacter}'. Who do you want to play on '${branchId}'?`
        : `Who do you want to play on '${branchId}'?`,
      options: playable.map((candidate, index) => ({
        value: candidate.id,
        label: `${candidate.canonicalName} (${candidate.id})`,
        description: [
          candidate.aliases.length ? `aliases: ${candidate.aliases.join(", ")}` : undefined,
          candidate.locationName ? `location: ${candidate.locationName}` : undefined,
        ].filter(Boolean).join("; ") || "committed playable character",
        recommended: index === 0,
      })),
      customInput: {
        label: "Enter a character",
        description: "Type a character id, canonical name, or alias.",
        prompt: "Character id, name, or alias",
        placeholder: playable[0]?.canonicalName,
        invalidMessage: `No unique living character on '${branchId}' matches that value.`,
        resolve: (value) => resolveCharacter(playable, value)?.id,
      },
      nonInteractiveHint: requestedCharacter
        ? `Character '${requestedCharacter}' is not uniquely playable on '${branchId}'. Pass a valid --character <id-or-name>.`
        : `Multiple playable characters exist on '${branchId}'. Pass --character <id-or-name> explicitly.`,
    });
  }
  if (!character) return undefined;
  return selectPlayExperience(root, { branchId, character });
}

export function resolvePlayInstance(
  instances: readonly PlayInstanceSummary[],
  value: string,
): PlayInstanceSummary | undefined {
  const exact = instances.find((instance) => instance.branchId === value);
  if (exact) return exact;
  const normalized = normalize(value);
  const matches = instances.filter((instance) =>
    normalize(instance.branchId) === normalized || normalize(instance.name) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
