#!/usr/bin/env node
import path from "node:path";
import { HookCommand as Command } from "./runtime/hook-command.js";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { resolveConfigPath } from "./config/load.js";
import { auditCommand } from "./commands/audit.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { ingestCommand, ingestContentCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { reviewAccountingObligation } from "./compiler/accounting-review.js";
import { CompilerProposalObligations } from "./compiler/proposal-obligations.js";
import { reviewScenesCommand, inspectRequirementsCommand, registerCoreRoleRequirementsCommand, beginCoreRoleReviewCommand } from "./commands/review-scenes.js";
import { charactersCommand, instancesCommand, novelsCommand, progressCommand } from "./commands/catalog.js";
import { resumeCommand } from "./commands/resume.js";
import { playCommand } from "./commands/play.js";
import { compileCommand } from "./commands/compile.js";
import { compileSourceCommand } from "./commands/compile-source.js";
import { prepareCommand } from "./commands/prepare.js";
import { prepareAllCommand } from "./commands/prepare-all.js";
import { reparseCommand } from "./commands/reparse.js";
import { repairExistingCommand } from "./commands/repair-existing.js";
import { rebuildCommand } from "./commands/rebuild.js";
import { WorkspaceOperationLock } from "./util/workspace-lock.js";
import { withCompilerSignals, CompilerInterruptedError } from "./util/compiler-signals.js";
import { activatePreparedCacheRevisionCommand, inspectNovelClosureCommand, listPreparedCacheRevisionsCommand } from "./commands/prepared-cache.js";
import { evaluateNovelCommand, freezeNovelEvaluationCommand } from "./commands/novel-evaluation.js";
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
import { parseWebPort, webCommand } from "./commands/web.js";

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
  .option("--session <id>", "resume an exact saved TUI session in this workspace")
  .option("--new-session", "start a fresh terminal transcript while preserving world progress")
  .option("--no-save", "do not persist the interactive session");

const compilerLock = program.command("compiler-lock").description("Inspect or explicitly recover the workspace compiler lock on its owning host");
compilerLock.command("inspect").action(async () => {
  console.log(JSON.stringify(await WorkspaceOperationLock.inspect(rootFor({})), null, 2));
});
compilerLock.command("recover")
  .requiredOption("--owner-token <token>", "exact owner.token returned by compiler-lock inspect")
  .option("--legacy-owner-host-verified", "attest that a legacy owner PID was checked on its original host, outside sandbox PID views")
  .action(async (options) => {
    console.log(JSON.stringify(await WorkspaceOperationLock.recover(rootFor({}), options.ownerToken, options.legacyOwnerHostVerified), null, 2));
  });

function rootFor(options: { root?: string }): string {
  return options.root ?? program.opts().root ?? process.cwd();
}

const compilerObligations = program.command("compiler-obligations").description("Inspect durable compiler failures and review exact accounting coverage on the host");
program.command("review-scenes").requiredOption("--spec <path>", "independent source-review JSON with exact evidence anchors")
  .option("--register <set-id>", "register persistent mandatory requirements using the canonical catalog under the compiler lock")
  .option("--predecessor <hash>", "exact definitions[].revisionHash from requirements inspect when revising a registered set")
  .description("check pending/canonical scene capabilities without writing world truth; exits 2 for unresolved checks")
  .action(async (options) => {
    if (options.predecessor && !options.register) throw new Error("--predecessor requires --register; do not retry unchanged.");
    await reviewScenesCommand(rootFor({}), options.spec, options.register ? { id: options.register, predecessorRevision: options.predecessor } : undefined);
  });
const requirementsCommand = program.command("requirements").description("Inspect persistent capability definitions and evaluation history");
requirementsCommand.command("inspect").requiredOption("--source <id>", "registered source ID")
  .action(async options => inspectRequirementsCommand(rootFor({}), options.source));
requirementsCommand.command("inspect-upstream").requiredOption("--source <id>", "registered source ID")
  .description("Read retained upstream repair plans and attempts without authorizing or retrying them")
  .action(async options => {
    const { UpstreamRepairLedger } = await import("./compiler/upstream-repair-ledger.js");
    console.log(JSON.stringify(await new UpstreamRepairLedger(rootFor({}), options.source).inspect(), null, 2));
  });
requirementsCommand.command("plan-bound-upstream-repair").requiredOption("--request <path>", "current binding snapshot and selected findings JSON")
  .description("Derive original scene requirement IDs and freeze every supported dependency path before host authorization")
  .action(async options => {
    const { planBoundUpstreamRepairCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await planBoundUpstreamRepairCommand(rootFor({}), options.request), null, 2));
  });
requirementsCommand.command("bind-upstream-repairs").requiredOption("--source <id>", "registered source ID")
  .description("Bind current structural findings to unresolved scene requirements through exact typed dependency paths")
  .action(async options => {
    const { bindUpstreamRepairCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await bindUpstreamRepairCommand(rootFor({}), options.source), null, 2));
  });
requirementsCommand.command("discover-upstream-repairs").requiredOption("--source <id>", "registered source ID")
  .description("Discover actual missing source dependencies without guessing identities or granting write authority")
  .action(async options => {
    const { discoverUpstreamRepairCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await discoverUpstreamRepairCommand(rootFor({}), options.source), null, 2));
  });
requirementsCommand.command("plan-upstream-repair").requiredOption("--review <path>", "typed host-reviewed diagnostic JSON")
  .description("Derive a bounded frozen plan from actual source dependencies; never register or authorize it")
  .action(async options => {
    const { planUpstreamRepairCommand } = await import("./commands/upstream-repair.js");
    const result = await planUpstreamRepairCommand(rootFor({}), options.review);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "needs-host-review") process.exitCode = 2;
  });
requirementsCommand.command("register-upstream-plan").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--file <path>", "exact frozen host plan JSON, including planHash")
  .option("--predecessor <hash>", "exact predecessor plans[].plan.planHash when revising host dependencies")
  .description("Validate and retain frozen host policy without authorizing mutation")
  .action(async options => {
    const { registerUpstreamRepairPlanCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await registerUpstreamRepairPlanCommand(rootFor({}), options.source, options.file, options.predecessor ?? null), null, 2));
  });
requirementsCommand.command("authorize-upstream-plan").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--plan <hash>", "exact registered plans[].plan.planHash")
  .description("Recheck current source and dependencies, then authorize the frozen bounded host plan")
  .action(async options => {
    const { authorizeUpstreamRepairPlanCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await authorizeUpstreamRepairPlanCommand(rootFor({}), options.source, options.plan), null, 2));
  });
requirementsCommand.command("finish-upstream-plan").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--plan <hash>", "exact plans[].plan.planHash")
  .option("--input <path>", "host finish review JSON; required only before the original input is frozen")
  .description("Validate and commit exact authorized drafts, or recover the original frozen finish without a model call")
  .action(async options => {
    const { finishUpstreamRepairPlanCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await finishUpstreamRepairPlanCommand(rootFor({}), options.source, options.plan, options.input), null, 2));
  });
requirementsCommand.command("stop-upstream-plan").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--plan <hash>", "exact plans[].plan.planHash")
  .requiredOption("--reason <text>", "host diagnostic or review reason; preserves original drafts and budgets")
  .description("Stop the original repair for host review without erasing history")
  .action(async options => {
    const { stopUpstreamRepairPlanCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await stopUpstreamRepairPlanCommand(rootFor({}), options.source, options.plan, options.reason), null, 2));
  });
requirementsCommand.command("stage-upstream-plan").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--plan <hash>", "exact authorized plans[].plan.planHash from inspect-upstream")
  .option("--config <path>", "explicit extractor profile configuration")
  .option("--model <model>", "override the Pi model")
  .option("--timeout-ms <number>", "per-slot timeout, 1–600000 milliseconds", Number)
  .description("Stage the authorized dependency DAG, verifying and reusing original drafts on resume")
  .action(async options => {
    const { stageUpstreamRepairPlanCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await stageUpstreamRepairPlanCommand(rootFor({}), { ...options, model: options.model ?? program.opts().model }), null, 2));
  });
requirementsCommand.command("run-upstream-slot").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--plan <hash>", "exact authorized plans[].plan.planHash from inspect-upstream")
  .requiredOption("--kind <kind>", "exact allowedWrites/allowedCreations kind")
  .requiredOption("--artifact <id>", "exact allowedWrites/allowedCreations id")
  .option("--config <path>", "explicit configuration containing the extractor profile")
  .option("--model <model>", "override the Pi model for this isolated invocation")
  .option("--timeout-ms <number>", "bounded invocation timeout, 1–600000 milliseconds", Number)
  .description("Stage one already authorized upstream slot in an isolated Pi session; never finish or publish")
  .action(async options => {
    const { runUpstreamRepairSlotCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await runUpstreamRepairSlotCommand(rootFor({}), {
      ...options, model: options.model ?? program.opts().model,
    }), null, 2));
  });
requirementsCommand.command("recover-upstream-session").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--session-ref <hash>", "exact modelSessions[].sessionRef from inspect-upstream")
  .description("Recover an original validated draft without another model invocation")
  .action(async options => {
    const { recoverUpstreamRepairSessionCommand } = await import("./commands/upstream-repair.js");
    console.log(JSON.stringify(await recoverUpstreamRepairSessionCommand(rootFor({}), options.source, options.sessionRef), null, 2));
  });
requirementsCommand.command("observe-upstream-convergence").requiredOption("--source <id>", "registered source ID")
  .description("Verify actual committed repair revisions without accepting unrelated pending proposals")
  .action(async options => {
    const { withWorkspaceOperationLock } = await import("./util/workspace-lock.js");
    const { observeUpstreamRepairConvergence } = await import("./compiler/upstream-repair-convergence.js");
    const issues = await withWorkspaceOperationLock(rootFor({}), "compiler", () => observeUpstreamRepairConvergence(rootFor({}), options.source));
    console.log(JSON.stringify({ issues }, null, 2));
    if (issues.length) process.exitCode = 2;
  });
requirementsCommand.command("evaluate-upstream").requiredOption("--source <id>", "registered source ID")
  .description("Evaluate converged upstream repairs against actual independent requirements without model replay")
  .action(async options => {
    const { withWorkspaceOperationLock } = await import("./util/workspace-lock.js");
    const { settleUpstreamRepairRequirements } = await import("./compiler/upstream-repair-evaluation.js");
    const result = await withWorkspaceOperationLock(rootFor({}), "compiler", () => settleUpstreamRepairRequirements(rootFor({}), options.source));
    console.log(JSON.stringify(result, null, 2));
    if (result.issues.length) process.exitCode = 2;
  });
requirementsCommand.command("refresh").requiredOption("--source <id>", "registered source ID")
  .description("Observe current requirement validity without replaying proposals or granting role satisfaction")
  .action(async options => {
    const { withWorkspaceOperationLock } = await import("./util/workspace-lock.js");
    const { observeRequirementValidity } = await import("./compiler/requirement-observation.js");
    const issues = await withWorkspaceOperationLock(rootFor({}), "compiler", () => observeRequirementValidity(rootFor({}), options.source));
    await inspectRequirementsCommand(rootFor({}), options.source);
    if (issues.length) process.exitCode = 2;
  });
requirementsCommand.command("begin-core-role-review").requiredOption("--source <id>", "registered source ID")
  .requiredOption("--revision <id>", "stable host review revision ID; reuse the same ID to recover")
  .requiredOption("--roster-hash <hash>", "exact savedRosterHash from requirements inspect")
  .option("--predecessor <hash>", "last coreRoleDefinitions[].revisionHash, if registered")
  .requiredOption("--scope-decision <ref>", "host audit reference authorizing a new independent review")
  .requiredOption("--reason <text>", "reason for reviewing again; this does not approve a reduced role scope")
  .action(async options => beginCoreRoleReviewCommand(rootFor({}), { sourceId: options.source, revisionId: options.revision,
    priorRosterHash: options.rosterHash, predecessorDefinitionRevision: options.predecessor, scopeDecisionRef: options.scopeDecision, reason: options.reason }));
requirementsCommand.command("register-core-roles").requiredOption("--source <id>", "registered source ID")
  .option("--predecessor <hash>", "last coreRoleDefinitions[].revisionHash from requirements inspect")
  .requiredOption("--scope-decision <ref>", "host audit reference for this independent source-review revision")
  .requiredOption("--reason <text>", "explicit reason for changes, including any removed role requirements")
  .action(async options => registerCoreRoleRequirementsCommand(rootFor({}), options.source, {
    predecessorRevision: options.predecessor, scopeDecisionRef: options.scopeDecision, scopeChangeReason: options.reason,
  }));
compilerObligations.command("inspect").requiredOption("--source <id>", "registered source ID").requiredOption("--batch <id>", "exact compiler batch ID")
  .action((options) => {
    const journal = new CompilerProposalObligations(rootFor({}), options.source, options.batch);
    console.log(JSON.stringify({ unresolved: journal.unresolved(), requiringHostReview: journal.requiringHostReview() }, null, 2));
  });
compilerObligations.command("review-accounting")
  .requiredOption("--source <id>", "registered source ID").requiredOption("--batch <id>", "exact executable batch ID")
  .requiredOption("--proposal <id>", "failed account_source_units proposal ID")
  .requiredOption("--reason <text>", "host review rationale").requiredOption("--audit-ref <ref>", "incident or review reference")
  .option("--from-run <id>", "original audit run when legacy page receipts are missing")
  .option("--apply", "record the verified settlement under the compiler lock; default is read-only")
  .action(async (options) => {
    const proof = await reviewAccountingObligation(rootFor({}), { sourceId: options.source, batchId: options.batch, proposalId: options.proposal,
      reason: options.reason, auditRef: options.auditRef, ...(options.fromRun ? { fromRun: options.fromRun } : {}) }, options.apply === true);
    console.log(JSON.stringify({ status: options.apply ? "superseded-by-coverage" : "verified-preview", executableCertification: false, proof }, null, 2));
  });
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
  .description("create starter novel-harness.yaml and NWH.md files")
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
program.command("status").option("-c, --config <path>", "configuration file").option("--root <path>", "local novel workspace")
  .option("--json", "read-only compiler snapshot with current checkpoints, obligations, runs and candidate closure")
  .option("--source <id>", "one exact source ID for --json")
  .description("show inventory and the next safe preparation step").action(async (options) => statusCommand(configFor(options), { json: options.json, sourceId: options.source }));
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
program.command("web")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "override the Pi model for Web play calls")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", parseWebPort, 3080)
  .option("--no-open", "do not open the browser automatically")
  .option("--allow-remote", "allow binding the unauthenticated UI beyond loopback")
  .description("open the local Novel World Harness Web UI")
  .action(async (options) => {
    const globalOptions = program.opts();
    return webCommand({
      root: rootFor(options),
      configPath: configFor(options),
      model: options.model ?? globalOptions.model,
      host: options.host,
      port: options.port,
      open: options.open,
      allowRemote: Boolean(options.allowRemote),
    });
  });
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
  .option("--session <id>", "resume an exact saved compiler session")
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
      sessionId: options.session ?? globalOptions.session,
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
    await withCompilerSignals((signal) => compileSourceCommand({
      root: rootFor(options),
      configPath: configFor(options),
      allowMissingConfig: !options.config,
      sourceId: options.source,
      model: options.model ?? globalOptions.model,
      ...(maxBatches !== undefined ? { maxBatches } : {}),
      resume: options.resume,
      signal,
    }));
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

program
  .command("rebuild")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "immutable ingested source to rebuild")
  .option("--chapters <selection>", "rebuild selected chapters and their dependent consumers; omit for the whole novel")
  .option("--from-revision <bundle-hash>", "start from an exact immutable compiler candidate")
  .option("--replace-staging", "preserve displaced drafts in rejected history before replacing conflicting staging")
  .option("--model <model>", "override the Pi compiler model")
  .description("resume or rebuild the core novel world into an immutable candidate without publishing Play")
  .action(async (options) => withCompilerSignals((signal) => rebuildCommand({ root: rootFor(options), configPath: configFor(options), sourceId: options.source, chapters: options.chapters,
    fromRevision: options.fromRevision, replaceStaging: options.replaceStaging, model: options.model ?? program.opts().model, signal })));

program
  .command("repair-existing")
  .option("-c, --config <path>", "configuration file")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id; required when more than one source exists")
  .option("--from-revision <bundle-hash>", "immutable prepared revision to fork; defaults to the active revision")
  .option("--replace-staging", "replace conflicting compiler staging after preserving pending drafts in rejected history")
  .option("--model <model>", "override compiler model")
  .description("fork a prepared revision, repair it in place with reusable artifacts, and publish a new current revision")
  .action(async (options) => {
    const globalOptions = program.opts();
    await repairExistingCommand({
      root: rootFor(options),
      configPath: configFor(options),
      sourceId: options.source,
      fromRevision: options.fromRevision,
      replaceStaging: Boolean(options.replaceStaging),
      model: options.model ?? globalOptions.model,
    });
  });

const preparedCache = program.command("prepared-cache").description("inspect or activate versioned prepared-novel revisions");
preparedCache.command("freeze-evaluation")
  .argument("<plan-json>", "independent semantic gold and per-major scenarios")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id")
  .action(async (planFile, options) => freezeNovelEvaluationCommand(rootFor(options), planFile, options.source));
preparedCache.command("evaluate")
  .argument("<plan-hash>", "previously frozen independent evaluation plan")
  .option("--root <path>", "local novel workspace")
  .option("--model <model>", "Pi provider/model override")
  .action(async (planHash, options) => evaluateNovelCommand(rootFor(options), planHash, configFor(options), options.model ?? program.opts().model));
preparedCache.command("inspect-closure")
  .description("inspect current candidate closure, major roles and missing evaluation evidence without publication")
  .option("--root <path>", "local novel workspace")
  .option("--source <id>", "ingested source id")
  .action(async (options) => inspectNovelClosureCommand(rootFor(options), options.source));
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
world.command("create")
  .argument("[branch]", "branch id", "main")
  .option("--root <path>", "local novel workspace")
  .option("--seed <json>", "StateDelta JSON seed; canonical initial world is used by default")
  .option("--source <id>", "registered source id; required when more than one source exists")
  .action(async (branch, options) => worldCreateCommand(rootFor(options), branch, options.seed, options.source));
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
  .option("--candidate-only", "continue compilation and archive a candidate without publishing Play or creating a branch")
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
      ...(options.candidateOnly ? { candidateOnly: true, createBranch: false, restoreCache: false } : {}),
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
  .option("--advance-background <n>", "opt in to at most n temporally safe background/canon events after an accepted action", "0")
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
  .option("--session <id>", "resume an exact saved TUI session in this workspace")
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
      sessionId: options.session ?? globalOptions.session,
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
    sessionId: options.session,
    saveSession: options.save,
  });
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CompilerInterruptedError ? error.exitCode : 1;
}
