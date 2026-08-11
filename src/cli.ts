#!/usr/bin/env node
import { Command } from "commander";
import { resolveConfigPath } from "./config/load.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { ingestCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { playCommand } from "./commands/play.js";
import { compileCommand } from "./commands/compile.js";
import { acceptProposalCommand, listProposalsCommand, rejectProposalCommand } from "./commands/proposals.js";
import {
  worldCreateCommand,
  worldForkCommand,
  worldFrontierCommand,
  worldHistoryCommand,
  worldKnowledgeCommand,
  worldRenderCommand,
  worldReplayCommand,
  worldShowCommand,
} from "./commands/world.js";

const program = new Command();
program
  .name("nwh")
  .description("Novel World Harness — compile novels into executable world models")
  .version("0.1.0")
  .option("--root <path>", "local novel workspace", process.cwd())
  .option("--model <model>", "override the Pi model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--continue", "continue the latest session in this workspace")
  .option("--no-save", "do not persist the interactive session");

function rootFor(options: { root?: string }): string {
  return options.root ?? program.opts().root ?? process.cwd();
}

program.command("init").argument("[directory]", "target directory", process.cwd()).description("create starter novel-harness.yaml and NOVEL.md files").action(initCommand);

program.command("doctor").option("-c, --config <path>", "configuration file").description("validate runtime, credentials and local file tooling").action(async (options) => doctorCommand(resolveConfigPath(options.config)));

program
  .command("ingest")
  .argument("<novel>", "UTF-8 source novel path")
  .option("-c, --config <path>", "configuration file")
  .option("--no-loop", "register source and queue jobs without running compiler loop")
  .description("register a novel and start the compiler harness")
  .action(async (novel, options) => ingestCommand(novel, resolveConfigPath(options.config), options.loop));

program.command("status").option("-c, --config <path>", "configuration file").description("show build metrics and job state").action(async (options) => statusCommand(resolveConfigPath(options.config)));

program
  .command("compile")
  .argument("[prompt]", "compiler instruction")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "override compiler model")
  .option("--no-save", "do not persist compiler session")
  .description("open an explicit compiler session with typed proposal tools")
  .action(async (prompt, options) => {
    const globalOptions = program.opts();
    await compileCommand({
      root: rootFor(options),
      configPath: resolveConfigPath(options.config),
      allowMissingConfig: !options.config,
      model: options.model ?? globalOptions.model,
      saveSession: options.save && globalOptions.save,
      ...(prompt ? { prompt } : {}),
    });
  });

const proposals = program.command("proposals").description("review compiler proposals before canonical commit");
proposals.command("list").option("--root <path>", "local novel workspace").option("--status <status>", "pending, accepted or rejected", "pending").action(async (options) => {
  if (!["pending", "accepted", "rejected"].includes(options.status)) throw new Error(`Unknown proposal status: ${options.status}`);
  await listProposalsCommand(rootFor(options), options.status);
});
proposals.command("accept").argument("<kind>").argument("<id>").option("--root <path>", "local novel workspace").action(async (kind, id, options) => acceptProposalCommand(rootFor(options), kind, id));
proposals.command("reject").argument("<id>").option("--root <path>", "local novel workspace").action(async (id, options) => rejectProposalCommand(rootFor(options), id));

const world = program.command("world").description("inspect and execute committed novel-world branches");
world.command("create").argument("[branch]", "branch id", "main").option("--root <path>", "local novel workspace").option("--seed <json>", "StateDelta JSON seed").action(async (branch, options) => worldCreateCommand(rootFor(options), branch, options.seed));
world.command("show").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (options) => worldShowCommand(rootFor(options), options.branch));
world.command("history").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (options) => worldHistoryCommand(rootFor(options), options.branch));
world.command("frontier").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (options) => worldFrontierCommand(rootFor(options), options.branch));
world.command("knowledge").argument("<actor>").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").action(async (actor, options) => worldKnowledgeCommand(rootFor(options), options.branch, actor));
world.command("fork").argument("<new-branch>").option("--root <path>", "local novel workspace").option("--branch <id>", "parent branch", "main").option("--from <commit>", "fork commit; defaults to parent head").action(async (newBranch, options) => worldForkCommand(rootFor(options), options.branch, newBranch, options.from));
world.command("render").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").option("--actor <id>", "actor point of view").option("--tone <tone>", "rendering tone label").action(async (options) => worldRenderCommand(rootFor(options), options.branch, options.actor, options.tone));
world.command("replay").argument("<checkpoints>", "checkpoint JSON file").option("--root <path>", "local novel workspace").option("--branch <id>", "branch id", "main").option("--max-moves <n>", "move limit", "100").action(async (checkpoints, options) => {
  const maxMoves = Number(options.maxMoves);
  if (!Number.isInteger(maxMoves) || maxMoves <= 0) throw new Error("--max-moves must be a positive integer");
  await worldReplayCommand(rootFor(options), options.branch, checkpoints, maxMoves);
});

program
  .command("play")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "override the Pi model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--continue", "continue the latest session in this workspace")
  .option("--no-save", "do not persist the interactive session")
  .description("open the local-first terminal session")
  .action(async (options) => {
    const globalOptions = program.opts();
    await playCommand({
      configPath: resolveConfigPath(options.config),
      allowMissingConfig: !options.config,
      root: rootFor(options),
      model: options.model ?? globalOptions.model,
      printPrompt: options.print ?? globalOptions.print,
      continueSession: options.continue || globalOptions.continue,
      saveSession: options.save && globalOptions.save,
    });
  });

program.action(async () => {
  const options = program.opts();
  await playCommand({
    configPath: resolveConfigPath(undefined),
    allowMissingConfig: true,
    root: options.root,
    model: options.model,
    printPrompt: options.print,
    continueSession: options.continue,
    saveSession: options.save,
  });
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
