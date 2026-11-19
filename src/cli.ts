#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { HookCommand as Command } from "./runtime/hook-command.js";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { resolveConfigPath } from "./config/load.js";
import { auditCommand } from "./commands/audit.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { ingestCommand, ingestContentCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { reviewScenesCommand } from "./commands/review-scenes.js";
import { charactersCommand, instancesCommand, novelsCommand, progressCommand } from "./commands/catalog.js";
import { resumeCommand } from "./commands/resume.js";
import { playCommand } from "./commands/play.js";
import { compileNovelCommand, releaseHeldScopesCommand } from "./commands/compile-novel.js";
import { novelCutsCommand } from "./commands/novel-cuts.js";
import { novelCompletenessCommand } from "./commands/novel-completeness.js";
import { novelReferenceCompareCommand, novelReferenceExportCommand, novelReferenceVerifyCommand } from "./commands/novel-reference.js";
import { novelGoldDraftCommand, novelGoldScoreCommand } from "./commands/novel-gold.js";
import { novelProbeCommand } from "./commands/novel-probe.js";
import { compileNovelWithLoop } from "./commands/compile-novel-loop.js";
import { NOVEL_COMPILATION_PHASES, type NovelCompilationPhase } from "./workflow/novel-compilation.js";
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
import { resolveSceneEntryCut, choosePlayExperience } from "./world/play-choice.js";
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

const compileNovel = program.command("compile-novel")
  .description("Compile a novel through the slim pipeline (source, census, observation, identity, scenes, world, roster, opening, gaps, closure), then archive and the certification track to a playable branch (resume by default)")
  .argument("[novel]", "UTF-8 source novel path; omit to continue a registered source");
const parsePositive = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got ${value}.`);
  return parsed;
};
const novelOptions = (command: Command) => command
  .option("--root <path>", "local novel workspace")
  .option("-c, --config <path>", "configuration file")
  .option("--source <id>", "registered source ID")
  .option("--model <model>", "model override for compiler and evaluation")
  .option("--branch <id>", "new playable branch ID; existing revision-pinned histories are preserved")
  .option("--through-chapter <n>", "prefix compile: only chapters 1..n (the limit is saved for later stages)", parsePositive)
  .option("--through-byte <n>", "prefix compile: only source bytes before n", parsePositive)
  .option("--evaluation-plan <path>", "independent evaluation input JSON; otherwise generate/reuse a source-reviewed plan")
  .option("--plan-hash <hash>", "exact previously frozen independent evaluation plan");
novelOptions(compileNovel)
  .option("--no-loop", "run one compiler invocation without the engineering supervisor")
  .option("--engineer-model <model>", "Codex model for repair and independent review (default: gpt-5.6-sol)")
  .option("--loop-history <path>", "adopt a settled legacy supervisor record without resetting its counters")
  .option("--loop-resume <hash>", "resume a resolved host stop using the exact supervision.stateHash; counters remain charged")
  .option("--loop-new-run <hash>", "start one new generation from an exact completed supervision.stateHash")
  .option("--loop-host-patch <hash>", "independently verify an exact host source repair without renewing exhausted engineering rounds")
  .option("--loop-resolution <text>", "concrete host review authorizing migration of the legacy supervisor");
const runCompileNovel = async (command: Command, novel?: string, phase?: NovelCompilationPhase | "status" | "plan") => {
  // Commander optsWithGlobals lets the root's default cwd overwrite --root
  // on a subcommand. Explicit options nearer the selected action win here.
  const options = { ...program.opts(), ...compileNovel.opts(), ...command.opts() };
  await withCompilerSignals(signal => compileNovelWithLoop({
    root: rootFor(options), configPath: options.config ? path.resolve(options.config) : undefined,
    novelPath: novel, sourceId: options.source, branchId: options.branch, model: options.model, phase,
    ...(options.throughChapter ? { throughChapter: options.throughChapter } : {}), ...(options.throughByte ? { throughByte: options.throughByte } : {}),
    evaluationPlanFile: options.evaluationPlan, evaluationPlanHash: options.planHash, signal, loop: options.loop,
    engineerModel: options.engineerModel, loopHistory: options.loopHistory, loopResolution: options.loopResolution, loopResume: options.loopResume, loopHostPatch: options.loopHostPatch, loopNewRun: options.loopNewRun,
  }));
};
compileNovel.action(async (novel, _options, command) => runCompileNovel(command, novel));
const phaseDescriptions: Record<NovelCompilationPhase, string> = {
  source: "Verify/register the immutable source and derive segments, structure and chapters (no model)",
  census: "Classify host census candidates: names, places, organisations, objects, setting terms",
  observation: "Review host speech and name candidates per 16 KiB window; add mentions, quotations, events, discourse segments",
  identity: "Decide each lexicon surface once (host expands to every mention); resolve pronouns, titles and collisions",
  scenes: "Per discourse segment: scene record, beats with typed participants and effects or a reviewed no-change",
  world: "Answer whole-source work items: lore, space, relations, characters, conditions, autonomy, knowledge paths",
  roster: "One bounded independent roster review from source statistics",
  opening: "Compile the evidence-backed initial world at the first scene",
  gaps: "Gap loop: bounded repairs from the completeness queues until no progress",
  closure: "Check structure and evidence, the completeness report and per-cut admission",
  archive: "Archive an immutable candidate without activation",
  admit: "Freeze the candidate with per-cut admission (publishable when a cut admits an entry); activation stays separate",
  "evaluation-plan": "Generate/reuse or import and freeze independent gold, support reviews and scenarios",
  evaluate: "Run/resume independent live Pi experiments against the frozen candidate",
  certify: "Certify and archive the current candidate without activating it",
  activate: "Activate the current certified or admitted revision",
  branch: "Create/reuse a playable branch pinned to the current active revision",
};
for (const phase of NOVEL_COMPILATION_PHASES) {
  const command = novelOptions(compileNovel.command(phase).description(phaseDescriptions[phase]));
  if (phase === "source") command.argument("[novel]", "UTF-8 source novel path")
    .action(async (novel, _options, child) => runCompileNovel(child, novel, phase));
  else command.action(async (_options, child) => runCompileNovel(child, undefined, phase));
}
novelOptions(compileNovel.command("status").description("Read pipeline scopes by stage, held scopes, usage and cost per source KB, and run receipts; no models or writes"))
  .action(async (_options, child) => runCompileNovel(child, undefined, "status"));
novelOptions(compileNovel.command("release").description("Host review: re-open held pipeline scopes so the next stage run or gap loop attempts them again (no model; the release is kept on the receipt)"))
  .option("--scope <id...>", "held scope IDs (from compile-novel status)")
  .option("--stage <stage>", "every held scope of one stage (census, observation, identity, scenes, world, roster, opening, gaps)")
  .option("--all", "every held scope of this source")
  .option("--note <text>", "what the host review found or changed")
  .action(async (_options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await releaseHeldScopesCommand({ root: rootFor(options), sourceId: options.source, ...(options.scope ? { scopeIds: options.scope } : {}), ...(options.stage ? { stage: options.stage } : {}),
      ...(options.all ? { all: true } : {}), ...(options.note ? { note: options.note } : {}) });
  });
novelOptions(compileNovel.command("plan").description("Alias of status"))
  .action(async (_options, child) => runCompileNovel(child, undefined, "plan"));
novelOptions(compileNovel.command("cuts").description("Read-only cut diagnostics: canonical timeline, per-cut admission tiers and first blocking causes (default: current workspace candidate)"))
  .option("--revision <hash>", "inspect an exact cached prepared revision instead of the workspace candidate")
  .option("--no-admission", "print only the timeline")
  .option("--no-probe", "skip the deterministic entry probes (cut tiers stop at replayable)")
  .action(async (_options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await novelCutsCommand({ root: rootFor(options), sourceId: options.source, revision: options.revision, admission: options.admission, probe: options.probe,
      configPath: options.config ? path.resolve(options.config) : undefined });
  });
novelOptions(compileNovel.command("completeness").description("Read-only world-model completeness against the end-state content contract: per-layer coverage with source-derived denominators and repair queues (default: current workspace candidate)"))
  .option("--revision <hash>", "measure an exact cached prepared revision instead of the workspace candidate")
  .option("--admission", "compute per-cut admission with entry probes when the bundle carries none (measures agency; slower)")
  .option("--brief", "print the measure table instead of the full JSON report")
  .option("--range <start-end>", "limit every measure to one source byte range (stage gate / slice view)")
  .option("--no-usage", "skip the trace-derived cost summary")
  .action(async (_options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await novelCompletenessCommand({ root: rootFor(options), sourceId: options.source, revision: options.revision, admission: Boolean(options.admission), brief: Boolean(options.brief),
      ...(options.range ? { range: options.range } : {}), usage: options.usage !== false });
  });
const reference = compileNovel.command("reference").description("Legacy reference packs: read-only JSON exports of an old compile for comparison and gold drafting; never imported into a new compile");
novelOptions(reference.command("export").description("Export the current candidate (or --revision) to $NWH_HOME/archives/<workspace>/legacy-reference/<source>-<date>/ and verify it"))
  .option("--revision <hash>", "export an exact cached prepared revision instead of the workspace candidate")
  .option("--out <dir>", "write the pack to this new directory instead of the default archive path")
  .action(async (_options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await novelReferenceExportCommand({ root: rootFor(options), sourceId: options.source, revision: options.revision, out: options.out });
  });
reference.command("verify").argument("<dir>", "reference pack directory").option("--expect <counts>", "comma-separated key=count artifact counts to check, e.g. entities=135,events=79")
  .description("Recompute file hashes and record counts against the pack manifest")
  .action(async (directory, options) => novelReferenceVerifyCommand({ directory, expect: options.expect }));
novelOptions(compileNovel.command("compare").description("Review list: legacy reference entities (by name) and events (by mention overlap) the current candidate does not reproduce; not a gate"))
  .requiredOption("--reference <dir>", "reference pack directory")
  .option("--revision <hash>", "compare an exact cached prepared revision instead of the workspace candidate")
  .option("--range <start-end>", "limit to the source byte range the new compile covers")
  .action(async (_options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await novelReferenceCompareCommand({ root: rootFor(options), sourceId: options.source, revision: options.revision, reference: options.reference, range: options.range });
  });
compileNovel.command("inventory").argument("<file>", "UTF-8 source text (no workspace or compile needed)")
  .option("--range <start-end>", "limit to one byte range")
  .option("--threshold <n>", "quoted-term occurrence threshold", (value) => Number.parseInt(value, 10))
  .description("Source-only denominators: direct speech by quotation convention, speaker cues, time expressions and frequent quoted terms")
  .action(async (file, options) => {
    const [{ summarizeSourceInventory }, { parseByteRange }, fs] = await Promise.all([import("./compiler/lexical-inventory.js"), import("./commands/novel-completeness.js"), import("node:fs/promises")]);
    console.log(JSON.stringify(summarizeSourceInventory(await fs.readFile(path.resolve(file)), { ...(options.range ? { range: parseByteRange(options.range) } : {}), ...(options.threshold ? { termThreshold: options.threshold } : {}) }), null, 2));
  });
const gold = compileNovel.command("gold").description("Gold slices: hand-checked semantic gold over one source range, scored by the 13-layer compiler scorer");
gold.command("draft").requiredOption("--reference <dir>", "legacy reference pack").requiredOption("--range <start-end>", "slice byte range")
  .requiredOption("--name <name>", "slice name").requiredOption("--out <file>", "new JSON file to write")
  .description("Draft a gold slice from a legacy reference pack; every record must then be confirmed against the source")
  .action(async (options) => novelGoldDraftCommand(options));
novelOptions(gold.command("score").argument("<file>", "gold slice JSON").description("Precision and recall of the current candidate on a gold slice (read-only)"))
  .option("--revision <hash>", "score an exact cached prepared revision instead of the workspace candidate")
  .option("--allow-draft", "score a slice that still has unconfirmed drafted records (provisional)")
  .action(async (file, _options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await novelGoldScoreCommand({ root: rootFor(options), file, sourceId: options.source, revision: options.revision, allowDraft: Boolean(options.allowDraft) });
  });
novelOptions(compileNovel.command("probe").description("Act probe: scripted player turns on every admitted cut x actor of the active revision (fake reasoners by default; --live uses the configured model)"))
  .option("--cut <id>", "probe one admitted cut")
  .option("--live", "use the configured Pi model instead of deterministic fake reasoners")
  .option("--turns <n>", "turns per intent class (1-3)", (value) => Number.parseInt(value, 10))
  .action(async (_options, child) => {
    const options = { ...program.opts(), ...compileNovel.opts(), ...child.opts() };
    await withCompilerSignals(signal => novelProbeCommand({ root: rootFor(options), sourceId: options.source, cutId: options.cut, live: Boolean(options.live), turns: options.turns,
      configPath: options.config ? path.resolve(options.config) : undefined, model: options.model, signal }));
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

const maintenance = program.command("maintenance").description("Workspace and runtime maintenance");
maintenance.command("purge-legacy")
  .option("--confirm <plan-hash>", "execute exactly the previewed plan (copy planHash from the preview)")
  .description("Preview (default) or purge legacy data: old world namespaces, old prepared caches, engineering-loop records, pre-cutover traces and leftover temporary workspaces. Never touches sources/ or archives/.")
  .action(async (options) => {
    const { executeLegacyPurge, planLegacyPurge } = await import("./application/legacy-purge.js");
    if (!options.confirm) {
      const plan = await planLegacyPurge();
      const human = (bytes: number) => bytes > 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GiB` : bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
      for (const item of plan.items) console.log(`${item.kind.padEnd(20)} ${human(item.bytes).padStart(10)}  ${item.path}  (${item.detail})`);
      console.log(`Total ${human(plan.totalBytes)} in ${plan.items.length} item(s). Nothing was deleted.`);
      console.log(`To purge exactly this plan: nwh maintenance purge-legacy --confirm ${plan.planHash}`);
      return;
    }
    const result = await executeLegacyPurge(options.confirm);
    console.log(JSON.stringify({ removed: result.removed.map((item) => ({ kind: item.kind, path: item.path })), freedBytes: result.freedBytes }, null, 2));
  });

program.command("review-scenes").requiredOption("--spec <path>", "independent source-review JSON with exact evidence anchors")
  .description("check pending/canonical scene capabilities without writing world truth; exits 2 for unresolved checks")
  .action(async (options) => reviewScenesCommand(rootFor({}), options.spec));

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
      configPath: options.config ? configFor(options) : undefined,
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
  .option("--scene <scene-id-or-cut-id>", "start a fresh instance at an admitted scene cut (requires --character)")
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
    const explicitlySelectedWorld = Boolean(options.branch || options.character || options.novel || options.scene);
    if (options.scene) {
      if (!options.character) throw new Error("--scene requires --character: choose who enters at that scene.");
      const { sourceId, cutId } = await resolveSceneEntryCut(rootFor(options), { scene: options.scene, ...(options.novel ? { source: options.novel } : {}) });
      await choosePlayExperience(rootFor(options), {
        source: sourceId, character: options.character, entryCutId: cutId,
        preferActiveSource: false, preferSavedCharacter: false, instanceMode: "create",
      }, askUserQuestion);
    } else if (explicitlySelectedWorld) {
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
