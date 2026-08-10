#!/usr/bin/env node
import { Command } from "commander";
import { resolveConfigPath } from "./config/load.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { migrateCommand } from "./commands/migrate.js";
import { ingestCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { playCommand } from "./commands/play.js";

const program = new Command();
program
  .name("nwh")
  .description("Novel World Harness — compile novels into executable world models")
  .version("0.1.0")
  .option("--root <path>", "local novel workspace", process.cwd())
  .option("--model <model>", "Anthropic model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--continue", "continue the latest session in this workspace")
  .option("--no-save", "do not persist the interactive session");

program
  .command("init")
  .argument("[directory]", "target directory", process.cwd())
  .description("create starter novel-harness.yaml and NOVEL.md files")
  .action(initCommand);

program
  .command("doctor")
  .option("-c, --config <path>", "configuration file")
  .description("validate runtime, credentials and PostgreSQL connectivity")
  .action(async (options) => doctorCommand(resolveConfigPath(options.config)));

program
  .command("db:migrate")
  .option("-c, --config <path>", "configuration file")
  .description("apply the initial PostgreSQL schema")
  .action(async (options) => migrateCommand(resolveConfigPath(options.config)));

program
  .command("ingest")
  .argument("<novel>", "UTF-8 source novel path")
  .option("-c, --config <path>", "configuration file")
  .option("--no-loop", "register source and queue jobs without running compiler loop")
  .description("register a novel and start the compiler harness")
  .action(async (novel, options) => ingestCommand(novel, resolveConfigPath(options.config), options.loop));

program
  .command("status")
  .option("-c, --config <path>", "configuration file")
  .description("show build metrics and job state")
  .action(async (options) => statusCommand(resolveConfigPath(options.config)));

program
  .command("play")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "Anthropic model for the interactive session")
  .option("-p, --print <prompt>", "run one prompt and exit")
  .option("--continue", "continue the latest session in this workspace")
  .option("--no-save", "do not persist the interactive session")
  .description("open the local-first terminal session")
  .action(async (options) => {
    const globalOptions = program.opts();
    await playCommand({
      configPath: resolveConfigPath(options.config),
      allowMissingConfig: !options.config,
      root: options.root ?? globalOptions.root,
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
