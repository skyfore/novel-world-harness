import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createPiPlayerActionTranslator } from "../agent/pi-player-action.js";
import { createPiPlayerWorldAdjudicator } from "../agent/pi-player-world-adjudicator.js";
import { createPiPlayerWorldResponseResolver } from "../agent/pi-player-world-response.js";
import { createPiNpcReactionReasoner } from "../agent/pi-npc-reaction.js";
import { createPiCanonicalAttachmentResolver } from "../agent/pi-canonical-attachment.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import type { PlayerActionTranslator, PlayerTurnResult, PlayerWorldAdjudicator } from "../world/player-action.js";
import type { PlayerWorldResponseResolver } from "../world/runtime.js";
import type { NpcReactionReasoner } from "../world/npc-reaction.js";
import type { CanonicalAttachmentResolver } from "../world/canonical-adaptation.js";
import { PlayConversationStore } from "../world/play-conversation.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  performPlayTurn,
  type SelectedPlayExperience,
} from "../world/play-experience.js";
import { catalogForSource, choosePlayExperience, choosePlayInstance, choosePlayNovel, createSourcePlayInstance, type AskPlayQuestion } from "../world/play-choice.js";
import { askUserQuestion } from "../util/ask-user-question.js";
import { formatCharacters } from "./catalog.js";

export type PlayWorldCommandOptions = {
  root: string;
  configPath: string;
  branchId?: string;
  character?: string;
  source?: string;
  action?: string;
  listCharacters?: boolean;
  model?: string;
  translator?: PlayerActionTranslator;
  adjudicator?: PlayerWorldAdjudicator;
  worldResponseResolver?: PlayerWorldResponseResolver;
  canonicalAttachmentResolver?: CanonicalAttachmentResolver;
  npcResponseReasoner?: NpcReactionReasoner;
  advanceBackground?: number;
  ask?: AskPlayQuestion;
};

export async function playWorldCommand(options: PlayWorldCommandOptions): Promise<PlayerTurnResult | undefined> {
  const ask = options.ask ?? askUserQuestion;
  let branchId = options.branchId;
  let source = options.source;
  if (options.listCharacters) {
    const catalog = await inspectPlayExperience(options.root);
    source = catalog.novels.length || source
      ? await choosePlayNovel(catalog, source, ask, { preferActive: false })
      : undefined;
    if (catalog.novels.length && !source) return undefined;
    let instanceCatalog = source ? catalogForSource(catalog, source) : catalog;
    if (source && !instanceCatalog.instances.length) {
      await createSourcePlayInstance(options.root, catalog, source);
      instanceCatalog = catalogForSource(await inspectPlayExperience(options.root), source);
    }
    branchId = await choosePlayInstance(options.root, branchId, ask, instanceCatalog);
    if (!branchId) return undefined;
    const listed = await listPlayableCharacters(options.root, { branchId, ...(source ? { source } : {}) });
    stdout.write(`${formatCharacters(listed.characters, listed.branchId)}\n`);
    if (!options.action) return undefined;
  }
  const selection = await choosePlayExperience(options.root, {
    ...(branchId ? { branchId } : {}),
    ...(options.character ? { character: options.character } : {}),
    ...(source ? { source } : {}),
    preferActiveSource: false,
    preferSavedCharacter: false,
    instanceMode: "continue",
  }, ask);
  if (!selection) return undefined;
  const config = await loadOptionalConfig(options.configPath);
  const profile = config ? profileForRole(config, "narrator").profile : undefined;
  const translator = options.translator ?? createPiPlayerActionTranslator({
    root: options.root,
    ...(profile ? { profile } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const adjudicator = options.adjudicator ?? (!options.translator
    ? createPiPlayerWorldAdjudicator({
        root: options.root,
        ...(profile ? { profile } : {}),
        ...(options.model ? { model: options.model } : {}),
      })
    : undefined);
  const worldResponseResolver = options.worldResponseResolver ?? (!options.translator
    ? createPiPlayerWorldResponseResolver({
        root: options.root,
        ...(profile ? { profile } : {}),
        ...(options.model ? { model: options.model } : {}),
      })
    : undefined);
  const npcResponseReasoner = options.npcResponseReasoner ?? (!options.translator
    ? createPiNpcReactionReasoner({
        root: options.root,
        ...(profile ? { profile } : {}),
        ...(options.model ? { model: options.model } : {}),
      })
    : undefined);
  const canonicalAttachmentResolver = options.canonicalAttachmentResolver ?? (!options.translator
    ? createPiCanonicalAttachmentResolver({
        root: options.root,
        ...(profile ? { profile } : {}),
        ...(options.model ? { model: options.model } : {}),
      })
    : undefined);
  const advanceBackground = options.advanceBackground ?? 0;
  if (!Number.isInteger(advanceBackground) || advanceBackground < 0 || advanceBackground > 100) {
    throw new Error("advanceBackground must be an integer between 0 and 100");
  }
  if (options.action !== undefined) {
    return runAndPrintTurn(options.root, selection, translator, adjudicator, worldResponseResolver, canonicalAttachmentResolver, npcResponseReasoner, options.action, advanceBackground);
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Pass --action <text> for non-interactive play.");
  }

  stdout.write(`You are ${selection.actor.canonicalName} (${selection.actor.id}) on branch ${selection.session.branchId}. Type an action; /exit leaves the world.\n`);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const utterance = (await terminal.question(`${selection.actor.canonicalName}> `)).trim();
      if (!utterance) continue;
      if (utterance === "/exit" || utterance === "/quit") break;
      await runAndPrintTurn(options.root, selection, translator, adjudicator, worldResponseResolver, canonicalAttachmentResolver, npcResponseReasoner, utterance, advanceBackground);
    }
  } finally {
    terminal.close();
  }
  return undefined;
}

async function runAndPrintTurn(
  root: string,
  selection: SelectedPlayExperience,
  translator: PlayerActionTranslator,
  adjudicator: PlayerWorldAdjudicator | undefined,
  worldResponseResolver: PlayerWorldResponseResolver | undefined,
  canonicalAttachmentResolver: CanonicalAttachmentResolver | undefined,
  npcResponseReasoner: NpcReactionReasoner | undefined,
  utterance: string,
  advanceBackground: number,
): Promise<PlayerTurnResult> {
  const outcome = await performPlayTurn({
    root,
    branchId: selection.session.branchId,
    actorId: selection.actor.id,
    utterance,
    translator,
    ...(adjudicator ? { adjudicator } : {}),
    ...(worldResponseResolver ? { worldResponseResolver } : {}),
    ...(canonicalAttachmentResolver ? { canonicalAttachmentResolver } : {}),
    ...(npcResponseReasoner ? { npcResponseReasoner } : {}),
    advanceBackground,
    origin: "cli",
  });
  const { result } = outcome;
  if (!result.accepted) {
    stdout.write(`The requested effect was not committed (${result.stage}); the current scene and world head remain available (${result.previousHead}). Choose another immediate action to continue.\n`);
    for (const issue of result.issues) stdout.write(`- ${issue.code}: ${issue.message}\n`);
    return result;
  }
  stdout.write(`${result.renderedText}\n`);
  try {
    await new PlayConversationStore(root).append({
      branchId: selection.session.branchId,
      actorId: selection.actor.id,
      atCommit: result.newHead,
      role: "scene",
      status: "rendered",
      text: result.renderedText,
    });
  } catch (error) {
    stdout.write(`Scene memory could not be persisted: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  stdout.write(`Committed player action at ${result.newHead}.\n`);
  for (const event of outcome.worldResponseEvents) stdout.write(`Immediate world response: ${event.title}\n`);
  for (const event of outcome.canonicalRecoveryEvents) stdout.write(`Canon scaffold adapted: ${event.title}\n`);
  for (const event of outcome.reactionEvents) stdout.write(`World responded: ${event.title}\n`);
  for (const event of outcome.backgroundEvents) stdout.write(`World advanced: ${event.title}\n`);
  if (outcome.backgroundError) stdout.write(`Background advancement stopped: ${outcome.backgroundError}\n`);
  if (outcome.worldResponseError) stdout.write(`Immediate world response stopped: ${outcome.worldResponseError}\n`);
  if (outcome.canonicalRecoveryError) stdout.write(`Canonical scaffold recovery stopped: ${outcome.canonicalRecoveryError}\n`);
  if (outcome.npcResponseError) stdout.write(`NPC response stopped (not treated as in-world silence): ${outcome.npcResponseError}\n`);
  if (outcome.conversationError) stdout.write(`Conversation memory could not be persisted: ${outcome.conversationError}\n`);
  return result;
}
