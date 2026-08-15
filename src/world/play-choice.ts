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
import type { SourceDocument } from "../storage/workspace-store.js";

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
  options: {
    branchId?: string;
    character?: string;
    source?: string;
    preferActiveSource?: boolean;
    preferSavedCharacter?: boolean;
  },
  ask: AskPlayQuestion,
): Promise<SelectedPlayExperience | undefined> {
  const catalog = await inspectPlayExperience(root);
  let sourceId: string | undefined;
  if (catalog.novels.length) {
    sourceId = await choosePlayNovel(catalog, options.source, ask, {
      preferActive: options.preferActiveSource ?? true,
    });
    if (!sourceId) return undefined;
  } else if (options.source) {
    throw new Error(`Unknown novel '${options.source}'. Use nwh novels to list registered sources.`);
  }
  const instanceCatalog = sourceId ? catalogForSource(catalog, sourceId) : catalog;
  if (!instanceCatalog.instances.length) {
    const source = catalog.novels.find((novel) => novel.id === sourceId);
    throw new Error(`No playable instances exist for '${source?.title ?? sourceId}'. Run nwh prepare-all for that novel first.`);
  }
  if (options.branchId) {
    const requested = resolvePlayInstance(catalog.instances, options.branchId);
    if (requested?.sourceId && requested.sourceId !== sourceId) {
      const assigned = catalog.novels.find((novel) => novel.id === requested.sourceId);
      throw new Error(`Instance '${requested.branchId}' belongs to '${assigned?.title ?? requested.sourceId}', not the selected novel.`);
    }
  }
  const branchId = await choosePlayInstance(root, options.branchId, ask, instanceCatalog);
  if (!branchId) return undefined;
  const listed = await listPlayableCharacters(root, { branchId, ...(sourceId ? { source: sourceId } : {}) });
  const playable = listed.characters.filter((character) => character.alive !== false);
  if (!playable.length) throw new Error(`No living committed characters are playable on '${branchId}'.`);
  const saved = catalog.savedSessions.find((session) => session.branchId === branchId);
  const requestedCharacter = options.character;
  let character = requestedCharacter ? resolveCharacter(playable, requestedCharacter)?.id : undefined;
  if (
    !requestedCharacter
    && (options.preferSavedCharacter ?? true)
    && saved
    && playable.some((candidate) => candidate.id === saved.actorId)
  ) character = saved.actorId;
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
  return selectPlayExperience(root, { branchId, character, ...(sourceId ? { source: sourceId } : {}) });
}

export function catalogForSource(catalog: PlayExperienceCatalog, sourceId: string): PlayExperienceCatalog {
  const matching = catalog.instances.filter((instance) => instance.sourceId === sourceId);
  return {
    ...catalog,
    instances: matching.length
      ? matching
      : catalog.instances.filter((instance) => !instance.sourceId),
  };
}

export async function choosePlayNovel(
  catalog: Pick<PlayExperienceCatalog, "novels" | "activeSession">,
  requested: string | undefined,
  ask: AskPlayQuestion,
  options: { preferActive?: boolean } = {},
): Promise<string | undefined> {
  if (!catalog.novels.length) {
    if (requested) throw new Error(`Unknown novel '${requested}'. No novel sources are registered.`);
    return undefined;
  }
  if (requested) {
    const resolved = resolvePlayNovel(catalog.novels, requested);
    if (resolved) return resolved.id;
  }
  if (!requested) {
    if (catalog.novels.length === 1) return catalog.novels[0]!.id;
    if (options.preferActive ?? true) {
      const active = catalog.activeSession?.sourceId
        ? catalog.novels.find((novel) => novel.id === catalog.activeSession?.sourceId)
        : undefined;
      if (active) return active.id;
    }
  }
  return ask({
    header: "Novel",
    question: requested
      ? `No unique novel matches '${requested}'. Which novel do you want to enter?`
      : "Which novel do you want to enter?",
    options: catalog.novels.map((novel, index) => ({
      value: novel.id,
      label: novel.title,
      description: `${novel.sourcePath} (${novel.id})`,
      recommended: index === 0,
    })),
    customInput: {
      label: "Enter a novel",
      description: "Type a registered source id, title, or path.",
      prompt: "Novel id, title, or path",
      placeholder: catalog.novels[0]?.title,
      invalidMessage: "No unique registered novel matches that value.",
      resolve: (value) => resolvePlayNovel(catalog.novels, value)?.id,
    },
    nonInteractiveHint: requested
      ? `Novel '${requested}' is not registered uniquely. Pass a valid --novel <id-or-title>.`
      : "Multiple novels are registered. Pass --novel <id-or-title> explicitly.",
  });
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

export function resolvePlayNovel(
  novels: readonly SourceDocument[],
  value: string,
): SourceDocument | undefined {
  const exact = novels.find((novel) => novel.id === value);
  if (exact) return exact;
  const normalized = normalize(value);
  const matches = novels.filter((novel) =>
    normalize(novel.title) === normalized || normalize(novel.sourcePath) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
