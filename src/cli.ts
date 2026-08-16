#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { resolveConfigPath } from "./config/load.js";
import { auditCommand } from "./commands/audit.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { ingestCommand, ingestContentCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { charactersCommand, instancesCommand, novelsCommand, progressCommand } from "./commands/catalog.js";
import { resumeCommand } from "./commands/resume.js";
import { playCommand } from "./commands/play.js";
import { compileCommand } from "./commands/compile.js";
import { compileSourceCommand } from "./commands/compile-source.js";
import { prepareCommand } from "./commands/prepare.js";
import { prepareAllCommand } from "./commands/prepare-all.js";
import { reparseCommand } from "./commands/reparse.js";
import { activatePreparedCacheRevisionCommand, listPreparedCacheRevisionsCommand } from "./commands/prepared-cache.js";
import { playWorldCommand } from "./commands/play-world.js";
import { acceptAllValidProposalsCommand, acceptProposalCommand, listProposalsCommand, rejectProposalCommand, showProposalCommand } from "./commands/proposals.js";
import {
  worldActorCommand,
  worldCreateCommand,
  worldDiffCommand,
  worldFsckCommand,
  worldForkCommand,
  worldFrontierCommand,
  worldHistoryCommand,
  worldKnowledgeCommand,
  worldMoveCommand,
  worldRenderCommand,
  worldReplayCommand,
  worldShowCommand,
  worldSnapshotCommand,
  worldValidateCommand,
} from "./commands/world.js";
import { choosePlayExperience } from "./world/play-choice.js";
import { playSceneRequestForEntry } from "./world/play-opening.js";
import { askUserQuestion } from "./util/ask-user-question.js";

const program = new Command();
program
  .name("nwh")
  .description("Novel World Harness — compile novels into executable world models")
  .version("0.1.0")
  .option("--root <path>", "local novel workspace", process.cwd())
  .option("--model <model>", "override the Pi model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--tui-mode <mode>", "TUI layout (default: fullscreen; regular uses terminal scrollback)", parseTuiMode)
  .option("--continue", "continue the latest session in this workspace")
  .option("--new-session", "start a fresh terminal transcript while preserving world progress")
  .option("--no-save", "do not persist the interactive session");

function rootFor(options: { root?: string }): string {
  return options.root ?? program.opts().root ?? process.cwd();
}
function configFor(options: { root?: string; config?: string }): string {
  return options.config ? resolveConfigPath(options.config) : path.resolve(rootFor(options), "novel-harness.yaml");
}
async function launchPlayableInstance(
  novel: string | undefined,
  options: {
    root?: string;
    config?: string;
    instance?: string;
    character?: string;
    model?: string;
    tuiMode?: TuiMode;
    continue?: boolean;
    newSession?: boolean;
    save?: boolean;
  },
  instanceMode: "continue" | "switch" | "create",
): Promise<void> {
  const globalOptions = program.opts();
  await resumeCommand({
    root: rootFor(options),
    configPath: configFor(options),
    ...(options.instance ? { branchId: options.instance } : {}),
    ...(options.character ? { character: options.character } : {}),
    ...(novel ? { source: novel } : {}),
    model: options.model ?? globalOptions.model,
    tuiMode: options.tuiMode ?? globalOptions.tuiMode,
    continueSession: options.newSession || globalOptions.newSession ? false : options.continue || globalOptions.continue || undefined,
    saveSession: options.save && globalOptions.save,
    instanceMode,
  });
}
function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
function parseTuiMode(value: string): TuiMode {
  if (value !== "regular" && value !== "fullscreen") throw new Error("--tui-mode must be regular or fullscreen");
  return value;
}

async function readStandardInput(): Promise<Buffer> {
  if (process.stdin.isTTY) throw new Error("--stdin requires piped UTF-8 novel content.");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const content = Buffer.concat(chunks);
  if (!content.length) throw new Error("--stdin received no novel content.");
  return content;
}

program.command("init")
  .argument("[directory]", "target directory")
  .option("--root <path>", "local novel workspace")
  .description("create starter novel-harness.yaml and NOVEL.md files")
  .action(async (directory, options) => initCommand(directory ?? rootFor(options)));
program.command("doctor").option("-c, --config <path>", "configuration file").option("--root <path>", "local novel workspace").description("validate runtime, credentials and local file tooling").action(async (options) => doctorCommand(configFor(options)));
program.command("ingest")
  .argument("[novel]", "UTF-8 source novel path")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--stdin", "read exact UTF-8 novel content from standard input")
  .option("--content <text>", "use exact inline UTF-8 novel content")
  .option("--title <name>", "title for stdin or inline content", "pasted-novel.txt")
  .description("archive a novel in the user-level material store and build its evidence index")
  .action(async (novel, options) => {
    const selected = Number(Boolean(novel)) + Number(Boolean(options.stdin)) + Number(options.content !== undefined);
    if (selected !== 1) throw new Error("Choose exactly one source: [novel], --stdin, or --content <text>.");
    if (novel) return ingestCommand(novel, configFor(options));
    const content = options.stdin ? await readStandardInput() : options.content;
    return ingestContentCommand(content, options.title, configFor(options));
  });
program.command("status").option("-c, --config <path>", "configuration file").option("--root <path>", "local novel workspace").description("show inventory and the next safe preparation step").action(async (options) => statusCommand(configFor(options)));
program.command("novels")
  .option("--root <path>", "local novel workspace")
  .description("list registered novels in the current workspace")
  .action(async (options) => novelsCommand(rootFor(options)));
program.command("instances")
  .option("--root <path>", "local novel workspace")
  .description("list playable world instances and committed progress")
  .action(async (options) => instancesCommand(rootFor(options)));
program.command("characters")
  .argument("[novel]", "registered source id, title or path")
  .option("--root <path>", "local novel workspace")
  .option("--branch <id>", "playable instance id")
  .description("list committed characters for a novel at an instance head")
  .action(async (novel, options) => charactersCommand(rootFor(options), options.branch, novel));
program.command("progress")
  .argument("[instance]", "playable instance id")
  .option("--root <path>", "local novel workspace")
  .description("show committed progress for the current or named instance")
  .action(async (instance, options) => progressCommand(rootFor(options), instance));
program.command("resume")
  .argument("[instance]", "playable instance id")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--character <id-or-name>", "character to inhabit")
  .option("--novel <id-or-title>", "registered novel source to enter")
  .option("--model <model>", "override the Pi model for player actions")
  .option("--tui-mode <mode>", "TUI layout (default: fullscreen; regular uses terminal scrollback)", parseTuiMode)
  .option("--continue", "continue the latest TUI transcript")
  .option("--new-session", "start a fresh TUI transcript while preserving world progress")
  .option("--no-save", "do not persist the TUI transcript")
  .description("resume a novel, character and playable instance in the full TUI")
  .action(async (instance, options) => {
    const globalOptions = program.opts();
    await resumeCommand({
      root: rootFor(options),
      configPath: configFor(options),
      ...(instance ? { branchId: instance } : {}),
      ...(options.character ? { character: options.character } : {}),
      ...(options.novel ? { source: options.novel } : {}),
      model: options.model ?? globalOptions.model,
      tuiMode: options.tuiMode ?? globalOptions.tuiMode,
      continueSession: options.newSession || globalOptions.newSession ? false : options.continue || globalOptions.continue || undefined,
      saveSession: options.save && globalOptions.save,
    });
  });
for (const command of [
  { name: "continue", mode: "continue" as const, description: "continue the latest instance for a novel" },
  { name: "switch", mode: "switch" as const, description: "switch to a novel, instance or character" },
  { name: "create", mode: "create" as const, description: "create and enter a fresh instance for a novel" },
]) {
  const configured = program.command(command.name)
    .argument("[novel]", "registered novel source id, title or path")
    .option("-c, --config <path>", "configuration file")
    .option("--root <path>", "local novel workspace")
    .option("--instance <id>", "playable instance id")
    .option("--character <id-or-name>", "character to inhabit")
    .option("--model <model>", "override the Pi model for player actions")
    .option("--tui-mode <mode>", "TUI layout (default: fullscreen; regular uses terminal scrollback)", parseTuiMode)
    .option("--continue", "continue the latest TUI transcript")
    .option("--new-session", "start a fresh TUI transcript while preserving world progress")
    .option("--no-save", "do not persist the TUI transcript")
    .description(command.description)
    .action(async (novel, options) => launchPlayableInstance(novel, options, command.mode));
  if (command.name === "create") configured.alias("create-instance");
}
program.command("audit")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "audit only one registered novel source")
  .description("audit compiler sources, evidence and canonical consistency")
  .action(async (options) => auditCommand(rootFor(options), options.source));

program
  .command("compile")
  .argument("[prompt]", "compiler instruction")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "override compiler model")
  .option("--tui-mode <mode>", "TUI layout (default: fullscreen; regular uses terminal scrollback)", parseTuiMode)
  .option("--no-save", "do not persist compiler session")
  .description("open an explicit compiler session with typed proposal tools")
  .action(async (prompt, options) => {
    const globalOptions = program.opts();
    await compileCommand({
      root: rootFor(options),
      configPath: configFor(options),
      allowMissingConfig: !options.config,
      model: options.model ?? globalOptions.model,
      tuiMode: options.tuiMode ?? globalOptions.tuiMode,
      saveSession: options.save && globalOptions.save,
      ...(prompt ? { prompt } : {}),
    });
  });

program
  .command("compile-source")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id; required when more than one source exists")
  .option("--model <model>", "override compiler model")
  .option("--max-batches <n>", "run at most N unfinished source batches")
  .option("--no-resume", "restart source batch progress from the beginning")
  .description("compile an ingested source through bounded, resumable evidence batches")
  .action(async (options) => {
    const globalOptions = program.opts();
    const maxBatches = options.maxBatches === undefined ? undefined : nonNegativeInteger(options.maxBatches, "--max-batches");
    await compileSourceCommand({
      root: rootFor(options),
      configPath: configFor(options),
      allowMissingConfig: !options.config,
      sourceId: options.source,
      model: options.model ?? globalOptions.model,
      ...(maxBatches !== undefined ? { maxBatches } : {}),
      resume: options.resume,
    });
  });

program
  .command("reparse")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id; required when more than one source exists")
  .option("--all", "reparse the entire novel into a new prepared revision")
  .option("--chapters <selection>", "reparse detected chapter ordinals, for example 1,3-5")
  .option("--model <model>", "override compiler model")
  .description("explicitly rebuild all or selected chapters while retaining prior prepared revisions")
  .action(async (options) => {
    const globalOptions = program.opts();
    await reparseCommand({
      root: rootFor(options),
      configPath: configFor(options),
      sourceId: options.source,
      all: Boolean(options.all),
      chapters: options.chapters,
      model: options.model ?? globalOptions.model,
    });
  });

const preparedCache = program.command("prepared-cache").description("inspect or activate versioned prepared-novel revisions");
preparedCache.command("list")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id")
  .action(async (options) => listPreparedCacheRevisionsCommand(rootFor(options), options.source));
preparedCache.command("activate")
  .argument("<bundle-hash>", "prepared revision bundle hash")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id")
  .action(async (bundleHash, options) => activatePreparedCacheRevisionCommand(rootFor(options), bundleHash, options.source));

const proposals = program.command("proposals").description("review compiler proposals before canonical commit");
proposals.command("list").option("--root <path>", "local novel workspace").option("--status <status>", "pending, accepted or rejected", "pending").action(async (options) => {
  if (!["pending", "accepted", "rejected"].includes(options.status)) throw new Error(`Unknown proposal status: ${options.status}`);
  await listProposalsCommand(rootFor(options), options.status);
});
proposals.command("accept").argument("<kind>").argument("<id>").option("--root <path>", "local novel workspace").action(async (kind, id, options) => acceptProposalCommand(rootFor(options), kind, id));
proposals.command("show").argument("<id>").option("--root <path>", "local novel workspace").option("--status <status>", "pending, accepted or rejected", "pending").action(async (id, options) => {
  if (!["pending", "accepted", "rejected"].includes(options.status)) throw new Error(`Unknown proposal status: ${options.status}`);
  await showProposalCommand(rootFor(options), id, options.status);
});
proposals.command("accept-all").option("--root <path>", "local novel workspace").description("accept every valid canonical and possibility proposal in dependency order").action(async (options) => acceptAllValidProposalsCommand(rootFor(options)));
proposals.command("reject").argument("<id>").option("--root <path>", "local novel workspace").action(async (id, options) => rejectProposalCommand(rootFor(options), id));

const world = program.command("world").description("inspect and execute committed novel-world branches");
world.command("create").argument("[branch]", "branch id", "main").option("--root <path>", "local novel workspace").option("--seed <json>", "StateDelta JSON seed; canonical initial world is used by default").action(async (branch, options) => worldCreateCommand(rootFor(options), branch, options.seed));
world.command("show").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (options) => worldShowCommand(rootFor(options), options.branch));
world.command("history").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (options) => worldHistoryCommand(rootFor(options), options.branch));
world.command("frontier").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (options) => worldFrontierCommand(rootFor(options), options.branch));
world.command("knowledge").argument("<actor>").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (actor, options) => worldKnowledgeCommand(rootFor(options), options.branch, actor));
world.command("actor").argument("<actor>").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (actor, options) => worldActorCommand(rootFor(options), options.branch, actor));
world.command("validate").argument("<proposal>", "player EventProposal template JSON without branch/head").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (proposal, options) => worldValidateCommand(rootFor(options), options.branch, proposal));
world.command("move").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").option("--player <proposal>", "player EventProposal template JSON without branch/head").option("--max-actors <n>", "maximum non-conflicting actor proposals", "1").option("--max-background <n>", "maximum background/canon possibilities", "1").action(async (options) => worldMoveCommand(rootFor(options), options.branch, options.player, nonNegativeInteger(options.maxActors, "--max-actors"), nonNegativeInteger(options.maxBackground, "--max-background")));
world.command("fork").argument("<new-branch>").option("--root <path>", "local novel workspace").option("--branch <id>", "parent branch", "main").option("--from <commit>", "fork commit; defaults to parent head").action(async (newBranch, options) => worldForkCommand(rootFor(options), options.branch, newBranch, options.from));
world.command("diff").argument("<left-branch>").argument("<right-branch>").option("--root <path>", "local novel workspace").action(async (left, right, options) => worldDiffCommand(rootFor(options), left, right));
world.command("render").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").option("--actor <id>", "actor point of view").option("--tone <tone>", "rendering tone label").action(async (options) => worldRenderCommand(rootFor(options), options.branch, options.actor, options.tone));
world.command("replay").argument("<checkpoints>", "checkpoint JSON file").option("--root <path>", "local novel workspace").option("--branch <id>", "source branch id", "main").option("--output-branch <id>", "new branch that receives replay commits").option("--max-moves <n>", "move limit", "100").action(async (checkpoints, options) => {
  const maxMoves = nonNegativeInteger(options.maxMoves, "--max-moves");
  if (maxMoves === 0) throw new Error("--max-moves must be positive");
  await worldReplayCommand(rootFor(options), options.branch, checkpoints, maxMoves, options.outputBranch);
});
world.command("snapshot").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").description("materialize a derived state snapshot for a branch head").action(async (options) => worldSnapshotCommand(rootFor(options), options.branch));
world.command("fsck").option("--root <path>", "local novel workspace").description("verify branch ancestry, object hashes, replay and snapshots").action(async (options) => worldFsckCommand(rootFor(options)));

program
  .command("prepare")
  .argument("[novel]", "UTF-8 source novel path inside the workspace")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "registered source id")
  .option("--branch <id>", "playable branch id")
  .option("--model <model>", "override compiler model; use provider/model when ambiguous")
  .option("--max-batches <n>", "run at most N unfinished batches", "1")
  .description("advance one safe step from novel ingest toward a reviewed playable world")
  .action(async (novel, options) => {
    await prepareCommand({
      root: rootFor(options),
      configPath: configFor(options),
      ...(novel ? { novelPath: novel } : {}),
      ...(options.source ? { sourceId: options.source } : {}),
      ...(options.branch ? { branchId: options.branch } : {}),
      model: options.model ?? program.opts().model,
      maxBatches: nonNegativeInteger(options.maxBatches, "--max-batches"),
    });
  });

program
  .command("prepare-all")
  .argument("[novel]", "UTF-8 source novel path inside the workspace")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "registered source id")
  .option("--branch <id>", "playable branch id")
  .option("--model <model>", "override compiler model; use provider/model when ambiguous")
  .option("-y, --yes", "accept every recommended preparation decision without prompting")
  .description("guide full compilation, validation and playable-branch preparation")
  .action(async (novel, options) => {
    await prepareAllCommand({
      root: rootFor(options),
      configPath: configFor(options),
      ...(novel ? { novelPath: novel } : {}),
      ...(options.source ? { sourceId: options.source } : {}),
      ...(options.branch ? { branchId: options.branch } : {}),
      model: options.model ?? program.opts().model,
      yes: Boolean(options.yes),
    });
  });

program
  .command("play-world")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--branch <id>", "playable branch id")
  .option("--character <id-or-name>", "character to inhabit")
  .option("--novel <id-or-title>", "registered novel source to enter")
  .option("-a, --action <text>", "perform one natural-language action and exit")
  .option("--advance-background <n>", "maximum background/canon events after an accepted action", "1")
  .option("--list-characters", "list committed playable characters")
  .option("--model <model>", "override action translator model; use provider/model when ambiguous")
  .description("choose a novel, inhabit a committed character and drive a validated alternate timeline")
  .action(async (options) => {
    const result = await playWorldCommand({
      root: rootFor(options),
      configPath: configFor(options),
      ...(options.branch ? { branchId: options.branch } : {}),
      ...(options.character ? { character: options.character } : {}),
      ...(options.novel ? { source: options.novel } : {}),
      ...(options.action !== undefined ? { action: options.action } : {}),
      advanceBackground: nonNegativeInteger(options.advanceBackground, "--advance-background"),
      listCharacters: Boolean(options.listCharacters),
      model: options.model ?? program.opts().model,
    });
    if (result && !result.accepted) process.exitCode = 2;
  });

program
  .command("play")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--branch <id>", "playable instance to enter")
  .option("--character <id-or-name>", "character to inhabit")
  .option("--novel <id-or-title>", "registered novel source to enter")
  .option("--model <model>", "override the Pi model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--tui-mode <mode>", "TUI layout (default: fullscreen; regular uses terminal scrollback)", parseTuiMode)
  .option("--continue", "continue the latest session in this workspace")
  .option("--new-session", "start a fresh terminal transcript while preserving world progress")
  .option("--no-save", "do not persist the interactive session")
  .description("open the local-first terminal session")
  .action(async (options) => {
    const globalOptions = program.opts();
    const explicitlySelectedWorld = Boolean(options.branch || options.character || options.novel);
    if (explicitlySelectedWorld) {
      await choosePlayExperience(rootFor(options), {
        ...(options.branch ? { branchId: options.branch } : {}),
        ...(options.character ? { character: options.character } : {}),
        ...(options.novel ? { source: options.novel } : {}),
        preferActiveSource: false,
        preferSavedCharacter: false,
        instanceMode: "continue",
      }, askUserQuestion);
    }
    await playCommand({
      configPath: configFor(options),
      allowMissingConfig: !options.config,
      root: rootFor(options),
      model: options.model ?? globalOptions.model,
      printPrompt: options.print ?? globalOptions.print,
      tuiMode: options.tuiMode ?? globalOptions.tuiMode,
      continueSession: options.newSession || globalOptions.newSession ? false : options.continue || globalOptions.continue || undefined,
      saveSession: options.save && globalOptions.save,
      ...(explicitlySelectedWorld ? { activeWorldScene: playSceneRequestForEntry("play") } : {}),
    });
  });

program.action(async () => {
  const options = program.opts();
  await playCommand({
    configPath: path.resolve(options.root, "novel-harness.yaml"),
    allowMissingConfig: true,
    root: options.root,
    model: options.model,
    printPrompt: options.print,
    tuiMode: options.tuiMode,
    continueSession: options.newSession ? false : options.continue || undefined,
    saveSession: options.save,
  });
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
