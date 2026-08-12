import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createPiPlayerActionTranslator } from "../agent/pi-player-action.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import type { Entity } from "../world/model.js";
import { PlayerTurnService, type PlayerActionTranslator, type PlayerTurnResult } from "../world/player-action.js";
import { PlaySessionStore } from "../world/play-session.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import type { PiLiveTestOptions } from "../agent/pi-session.js";

export type PlayWorldCommandOptions = {
  root: string;
  configPath: string;
  branchId?: string;
  character?: string;
  action?: string;
  listCharacters?: boolean;
  model?: string;
  translator?: PlayerActionTranslator;
  liveTest?: PiLiveTestOptions;
};

export async function playWorldCommand(options: PlayWorldCommandOptions): Promise<PlayerTurnResult | undefined> {
  const sessionStore = new PlaySessionStore(options.root);
  const active = await sessionStore.read();
  const branchId = options.branchId ?? active?.branchId ?? "main";
  const { engine } = await openWorkspaceWorld(options.root);
  let head: string;
  try {
    head = await engine.branches.readHead(branchId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Playable branch '${branchId}' does not exist. Run nwh prepare after reviewing proposals.`);
    }
    throw error;
  }
  const context = await engine.contextForCommit(head);
  const characters = [...context.entities.values()]
    .filter((entity) => entity.kind === "character")
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  if (options.listCharacters) {
    printCharacters(characters, active?.actorId);
    if (!options.action) return undefined;
  }
  const requestedActor = options.character ?? active?.actorId ?? (characters.length === 1 ? characters[0]!.id : undefined);
  if (!requestedActor) {
    printCharacters(characters, active?.actorId);
    throw new Error("Choose a character with --character <id-or-name>.");
  }
  const actor = resolveCharacter(characters, requestedActor);
  if (!actor) throw new Error(`Unknown or ambiguous character '${requestedActor}'. Use --list-characters.`);
  await sessionStore.write({ branchId, actorId: actor.id, lastCommitId: head });

  const config = await loadOptionalConfig(options.configPath);
  const profile = config ? profileForRole(config, "narrator").profile : undefined;
  const translator = options.translator ?? createPiPlayerActionTranslator({
    root: options.root,
    ...(profile ? { profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.liveTest ? { liveTest: options.liveTest } : {}),
  });
  const turns = new PlayerTurnService(engine, translator);
  if (options.action !== undefined) {
    return runAndPrintTurn(turns, sessionStore, branchId, actor, options.action);
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Pass --action <text> for non-interactive play.");
  }

  stdout.write(`You are ${actor.canonicalName} (${actor.id}) on branch ${branchId}. Type an action; /exit leaves the world.\n`);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const utterance = (await terminal.question(`${actor.canonicalName}> `)).trim();
      if (!utterance) continue;
      if (utterance === "/exit" || utterance === "/quit") break;
      await runAndPrintTurn(turns, sessionStore, branchId, actor, utterance);
    }
  } finally {
    terminal.close();
  }
  return undefined;
}

async function runAndPrintTurn(
  turns: PlayerTurnService,
  sessionStore: PlaySessionStore,
  branchId: string,
  actor: Entity,
  utterance: string,
): Promise<PlayerTurnResult> {
  const result = await turns.turn({ branchId, actorId: actor.id, utterance });
  if (!result.accepted) {
    stdout.write(`Action rejected at ${result.stage}; world head unchanged (${result.previousHead}).\n`);
    for (const issue of result.issues) stdout.write(`- ${issue.code}: ${issue.message}\n`);
    return result;
  }
  await sessionStore.write({ branchId, actorId: actor.id, lastCommitId: result.newHead });
  stdout.write(`${result.renderedText}\n`);
  stdout.write(`Committed player action at ${result.newHead}.\n`);
  return result;
}

function resolveCharacter(characters: Entity[], value: string): Entity | undefined {
  const exactId = characters.find((character) => character.id === value);
  if (exactId) return exactId;
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const matches = characters.filter((character) =>
    [character.canonicalName, ...character.aliases]
      .some((name) => name.normalize("NFKC").toLocaleLowerCase() === normalized));
  return matches.length === 1 ? matches[0] : undefined;
}

function printCharacters(characters: Entity[], activeActorId?: string): void {
  if (!characters.length) {
    stdout.write("No playable characters are committed. Review compiler proposals first.\n");
    return;
  }
  stdout.write("Playable characters:\n");
  for (const character of characters) {
    stdout.write(`${character.id === activeActorId ? "*" : " "} ${character.id}\t${character.canonicalName}${character.aliases.length ? `\t${character.aliases.join(", ")}` : ""}\n`);
  }
}
