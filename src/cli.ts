#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import type { PiLiveTestOptions } from "./agent/pi-session.js";
import { LIVE_TOKEN_BUDGET_HARD_LIMIT } from "./agent/live-token-ledger.js";
import { resolveConfigPath } from "./config/load.js";
import { auditCommand } from "./commands/audit.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { ingestCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { playCommand } from "./commands/play.js";
import { compileCommand } from "./commands/compile.js";
import { compileSourceCommand } from "./commands/compile-source.js";
import { prepareCommand } from "./commands/prepare.js";
import { playWorldCommand } from "./commands/play-world.js";
import {
  liveBudgetLockCommand,
  liveBudgetRepairLockCommand,
  liveBudgetStatusCommand,
} from "./commands/live-budget.js";
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

const program = new Command();
program
  .name("nwh")
  .description("Novel World Harness — compile novels into executable world models")
  .version("0.1.0")
  .option("--root <path>", "local novel workspace", process.cwd())
  .option("--model <model>", "override the Pi model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--tui-mode <mode>", "TUI layout: regular or fullscreen", parseTuiMode)
  .option("--continue", "continue the latest session in this workspace")
  .option("--no-save", "do not persist the interactive session")
  .option("--live-test", "explicitly enable metered real-provider white-box testing")
  .option("--live-ledger <path>", "shared live-test token ledger")
  .option("--live-token-budget <n>", "campaign token ceiling (maximum 100000000)")
  .option("--live-max-requests <n>", "maximum provider requests per model session")
  .option("--live-max-output-tokens <n>", "maximum output tokens per provider request")
  .option("--live-request-timeout-ms <n>", "provider request timeout in milliseconds");

function rootFor(options: { root?: string }): string {
  return options.root ?? program.opts().root ?? process.cwd();
}
function configFor(options: { root?: string; config?: string }): string {
  return options.config ? resolveConfigPath(options.config) : path.resolve(rootFor(options), "novel-harness.yaml");
}
function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}
function liveTestFor(root: string): PiLiveTestOptions | undefined {
  const options = program.opts();
  const enabled = options.liveTest === true || process.env.NWH_LIVE_TESTS === "1";
  const configured = options.liveLedger ?? options.liveTokenBudget ?? options.liveMaxRequests
    ?? options.liveMaxOutputTokens ?? options.liveRequestTimeoutMs
    ?? process.env.NWH_LIVE_LEDGER ?? process.env.NWH_LIVE_TOKEN_BUDGET
    ?? process.env.NWH_LIVE_MAX_REQUESTS ?? process.env.NWH_LIVE_MAX_OUTPUT_TOKENS
    ?? process.env.NWH_LIVE_REQUEST_TIMEOUT_MS;
  if (!enabled) {
    if (configured !== undefined) throw new Error("Live-test limits require --live-test or NWH_LIVE_TESTS=1.");
    return undefined;
  }
  const tokenBudget = positiveInteger(String(options.liveTokenBudget ?? process.env.NWH_LIVE_TOKEN_BUDGET ?? LIVE_TOKEN_BUDGET_HARD_LIMIT), "--live-token-budget");
  if (tokenBudget > LIVE_TOKEN_BUDGET_HARD_LIMIT) throw new Error(`--live-token-budget cannot exceed ${LIVE_TOKEN_BUDGET_HARD_LIMIT}`);
  return {
    ledgerPath: path.resolve(options.liveLedger ?? process.env.NWH_LIVE_LEDGER ?? path.join(root, ".novel-harness", "live-tests", "token-budget-v1.json")),
    tokenBudget,
    ...(options.liveMaxRequests ?? process.env.NWH_LIVE_MAX_REQUESTS
      ? { maxRequests: positiveInteger(String(options.liveMaxRequests ?? process.env.NWH_LIVE_MAX_REQUESTS), "--live-max-requests") }
      : {}),
    ...(options.liveMaxOutputTokens ?? process.env.NWH_LIVE_MAX_OUTPUT_TOKENS
      ? { maxOutputTokens: positiveInteger(String(options.liveMaxOutputTokens ?? process.env.NWH_LIVE_MAX_OUTPUT_TOKENS), "--live-max-output-tokens") }
      : {}),
    ...(options.liveRequestTimeoutMs ?? process.env.NWH_LIVE_REQUEST_TIMEOUT_MS
      ? { requestTimeoutMs: positiveInteger(String(options.liveRequestTimeoutMs ?? process.env.NWH_LIVE_REQUEST_TIMEOUT_MS), "--live-request-timeout-ms") }
      : {}),
  };
}
function liveTestArgument(root: string): { liveTest: PiLiveTestOptions } | Record<string, never> {
  const liveTest = liveTestFor(root);
  return liveTest ? { liveTest } : {};
}
function parseTuiMode(value: string): TuiMode {
  if (value !== "regular" && value !== "fullscreen") throw new Error("--tui-mode must be regular or fullscreen");
  return value;
}

program.command("init").argument("[directory]", "target directory", process.cwd()).description("create starter novel-harness.yaml and NOVEL.md files").action(initCommand);
program.command("doctor").option("-c, --config <path>", "configuration file").option("--root <path>", "local novel workspace").description("validate runtime, credentials and local file tooling").action(async (options) => doctorCommand(configFor(options)));
program.command("ingest").argument("<novel>", "UTF-8 source novel path").option("-c, --config <path>", "configuration file").option("--root <path>", "local novel workspace").description("register a novel and build its deterministic evidence index").action(async (novel, options) => ingestCommand(novel, configFor(options)));
program.command("status").option("-c, --config <path>", "configuration file").option("--root <path>", "local novel workspace").description("show inventory and the next safe preparation step").action(async (options) => statusCommand(configFor(options)));
program.command("audit").option("--root <path>", "local novel workspace").description("audit compiler sources, evidence and canonical consistency").action(async (options) => auditCommand(rootFor(options)));

program
  .command("compile")
  .argument("[prompt]", "compiler instruction")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "override compiler model")
  .option("--tui-mode <mode>", "TUI layout: regular or fullscreen", parseTuiMode)
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
      ...liveTestArgument(rootFor(options)),
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
      ...liveTestArgument(rootFor(options)),
    });
  });

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

const liveBudget = program.command("live-budget").description("inspect the persistent real-provider white-box token budget");
function liveLedgerPath(options: { root?: string; ledger?: string }): string {
  const globalOptions = program.opts();
  const root = rootFor(options);
  return path.resolve(
    options.ledger
      ?? globalOptions.liveLedger
      ?? process.env.NWH_LIVE_LEDGER
      ?? path.join(root, ".novel-harness", "live-tests", "token-budget-v1.json"),
  );
}
liveBudget.command("status").option("--root <path>", "local novel workspace").option("--ledger <path>", "token ledger path").action(async (options) => {
  const globalOptions = program.opts();
  const tokenBudget = positiveInteger(String(globalOptions.liveTokenBudget ?? process.env.NWH_LIVE_TOKEN_BUDGET ?? LIVE_TOKEN_BUDGET_HARD_LIMIT), "--live-token-budget");
  await liveBudgetStatusCommand({
    ledgerPath: liveLedgerPath(options),
    tokenBudget,
  });
});
liveBudget.command("lock").option("--root <path>", "local novel workspace").option("--ledger <path>", "token ledger path").description("inspect a ledger lock before any repair").action(async (options) => {
  await liveBudgetLockCommand(liveLedgerPath(options));
});
liveBudget.command("repair-lock").requiredOption("--owner <id>", "exact owner id returned by live-budget lock").option("--root <path>", "local novel workspace").option("--ledger <path>", "token ledger path").description("remove only a verified dead local lock owner").action(async (options) => {
  await liveBudgetRepairLockCommand(liveLedgerPath(options), options.owner);
});

program
  .command("prepare")
  .argument("[novel]", "UTF-8 source novel path inside the workspace")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "registered source id")
  .option("--branch <id>", "playable branch id", "main")
  .option("--model <model>", "override compiler model; use provider/model when ambiguous")
  .option("--max-batches <n>", "run at most N unfinished batches", "1")
  .description("advance one safe step from novel ingest toward a reviewed playable world")
  .action(async (novel, options) => {
    await prepareCommand({
      root: rootFor(options),
      configPath: configFor(options),
      ...(novel ? { novelPath: novel } : {}),
      ...(options.source ? { sourceId: options.source } : {}),
      branchId: options.branch,
      model: options.model ?? program.opts().model,
      maxBatches: nonNegativeInteger(options.maxBatches, "--max-batches"),
      ...liveTestArgument(rootFor(options)),
    });
  });

program
  .command("play-world")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--branch <id>", "playable branch id")
  .option("--character <id-or-name>", "character to inhabit")
  .option("-a, --action <text>", "perform one natural-language action and exit")
  .option("--advance-background <n>", "maximum background/canon events after an accepted action", "1")
  .option("--list-characters", "list committed playable characters")
  .option("--model <model>", "override action translator model; use provider/model when ambiguous")
  .description("inhabit a committed character and drive a validated alternate timeline")
  .action(async (options) => {
    const result = await playWorldCommand({
      root: rootFor(options),
      configPath: configFor(options),
      ...(options.branch ? { branchId: options.branch } : {}),
      ...(options.character ? { character: options.character } : {}),
      ...(options.action !== undefined ? { action: options.action } : {}),
      advanceBackground: nonNegativeInteger(options.advanceBackground, "--advance-background"),
      listCharacters: Boolean(options.listCharacters),
      model: options.model ?? program.opts().model,
      ...liveTestArgument(rootFor(options)),
    });
    if (result && !result.accepted) process.exitCode = 2;
  });

program
  .command("play")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "override the Pi model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--tui-mode <mode>", "TUI layout: regular or fullscreen", parseTuiMode)
  .option("--continue", "continue the latest session in this workspace")
  .option("--no-save", "do not persist the interactive session")
  .description("open the local-first terminal session")
  .action(async (options) => {
    const globalOptions = program.opts();
    await playCommand({
      configPath: configFor(options),
      allowMissingConfig: !options.config,
      root: rootFor(options),
      model: options.model ?? globalOptions.model,
      printPrompt: options.print ?? globalOptions.print,
      tuiMode: options.tuiMode ?? globalOptions.tuiMode,
      continueSession: options.continue || globalOptions.continue,
      saveSession: options.save && globalOptions.save,
      ...liveTestArgument(rootFor(options)),
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
    continueSession: options.continue,
    saveSession: options.save,
    ...liveTestArgument(options.root),
  });
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
