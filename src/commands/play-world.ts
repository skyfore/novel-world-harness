import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createPiPlayerActionTranslator } from "../agent/pi-player-action.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import type { PlayerActionTranslator, PlayerTurnResult } from "../world/player-action.js";
import {
  listPlayableCharacters,
  performPlayTurn,
  selectPlayExperience,
  type SelectedPlayExperience,
} from "../world/play-experience.js";
import { formatCharacters } from "./catalog.js";

export type PlayWorldCommandOptions = {
  root: string;
  configPath: string;
  branchId?: string;
  character?: string;
  action?: string;
  listCharacters?: boolean;
  model?: string;
  translator?: PlayerActionTranslator;
  advanceBackground?: number;
};

export async function playWorldCommand(options: PlayWorldCommandOptions): Promise<PlayerTurnResult | undefined> {
  if (options.listCharacters) {
    const listed = await listPlayableCharacters(options.root, options.branchId ? { branchId: options.branchId } : {});
    stdout.write(`${formatCharacters(listed.characters, listed.branchId)}\n`);
    if (!options.action) return undefined;
  }
  const selection = await selectPlayExperience(options.root, {
    ...(options.branchId ? { branchId: options.branchId } : {}),
    ...(options.character ? { character: options.character } : {}),
  });

  const config = await loadOptionalConfig(options.configPath);
  const profile = config ? profileForRole(config, "narrator").profile : undefined;
  const translator = options.translator ?? createPiPlayerActionTranslator({
    root: options.root,
    ...(profile ? { profile } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const advanceBackground = options.advanceBackground ?? 1;
  if (!Number.isInteger(advanceBackground) || advanceBackground < 0 || advanceBackground > 100) {
    throw new Error("advanceBackground must be an integer between 0 and 100");
  }
  if (options.action !== undefined) {
    return runAndPrintTurn(options.root, selection, translator, options.action, advanceBackground);
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
      await runAndPrintTurn(options.root, selection, translator, utterance, advanceBackground);
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
  utterance: string,
  advanceBackground: number,
): Promise<PlayerTurnResult> {
  const outcome = await performPlayTurn({
    root,
    branchId: selection.session.branchId,
    actorId: selection.actor.id,
    utterance,
    translator,
    advanceBackground,
  });
  const { result } = outcome;
  if (!result.accepted) {
    stdout.write(`Action rejected at ${result.stage}; world head unchanged (${result.previousHead}).\n`);
    for (const issue of result.issues) stdout.write(`- ${issue.code}: ${issue.message}\n`);
    return result;
  }
  stdout.write(`${result.renderedText}\n`);
  stdout.write(`Committed player action at ${result.newHead}.\n`);
  for (const event of outcome.backgroundEvents) stdout.write(`World advanced: ${event.title}\n`);
  if (outcome.backgroundError) stdout.write(`Background advancement stopped: ${outcome.backgroundError}\n`);
  return result;
}
