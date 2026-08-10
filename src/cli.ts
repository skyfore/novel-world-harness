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
  .version("0.1.0");

program
  .command("init")
  .argument("[directory]", "target directory", process.cwd())
  .description("create a starter novel-harness.yaml")
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
  .description("open the terminal session; full world runtime arrives after canon replay")
  .action(async (options) => playCommand(resolveConfigPath(options.config)));

program.action(async () => {
  await playCommand(resolveConfigPath(undefined));
});

await program.parseAsync(process.argv);
