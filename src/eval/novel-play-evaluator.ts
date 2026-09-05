import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LlmProfile } from "../config/schema.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { validateFrozenAccounting } from "../compiler/certification.js";
import { assessSemanticSupport } from "../compiler/semantic-support.js";
import { buildSceneExecutionContracts } from "../compiler/scene-execution-contracts.js";
import { probeMajorRoleEntries } from "../compiler/playability.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { TraceRecorder } from "../trace/recorder.js";
import { TraceStore } from "../trace/store.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { WorldContextStore } from "../world/context.js";
import { WorldEngine } from "../world/engine.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import { KnowledgeProjector } from "../world/knowledge.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import { performPlayTurn } from "../world/play-experience.js";
import { buildActorScopedActionContext, playerActionToKnowledgeAwareAction, validatePlayerActionGrounding, validatePlayerActionScope, validatePlayerActionSpatialScope } from "../world/player-action.js";
import type { WorldProjectionBundle } from "../world/projection-service.js";
import { evaluatePredicateTruth } from "../world/state.js";
import { fsckWorld } from "../world/fsck.js";
import { createPiPlayerActionTranslator } from "../agent/pi-player-action.js";
import { createPiPlayerWorldAdjudicator } from "../agent/pi-player-world-adjudicator.js";
import { createPiNpcReactionReasoner } from "../agent/pi-npc-reaction.js";
import { createPiActorReasoner } from "../agent/pi-actor-reasoner.js";
import { createPiPlayerWorldResponseResolver } from "../agent/pi-player-world-response.js";
import { createPiCanonicalAttachmentResolver } from "../agent/pi-canonical-attachment.js";
import { evaluateCompilerAgainstGold } from "./compiler-eval.js";
import { BENCHMARK_SEMANTIC_LAYERS } from "./benchmark-corpus.js";
import { NovelEvaluationPlanStore, validateEvaluationPlan, type NovelEvaluationPlan } from "./novel-evaluation-plan.js";
import { NOVEL_VALIDATOR_FINGERPRINT, NovelPlayQualityStore, novelPlayQualitySchema, proportion95, validateNovelPlayQuality, type NovelPlayQuality } from "./novel-play-quality.js";

/** Stable substantive projection: prose, clocks, planning and replay bookkeeping are not material effects. */
export function materialProjectionHash(projection: WorldProjectionBundle): string {
  return contentHash({
    values: Object.fromEntries(Object.entries(projection.state.values).map(([id, values]) => [id, Object.fromEntries(Object.entries(values).filter(([field]) => !["character.plan", "character.momentum", "character.ageYears", "character.lifeStage"].includes(field)))])),
    rules: projection.state.activeRuleIds,
    knowledge: Object.fromEntries(Object.entries(projection.knowledge.actors).map(([actor, claims]) => [actor, Object.fromEntries(Object.entries(claims).map(([claim, fact]) => [claim, { status: fact.status, confidence: fact.confidence }]))])),
    relationships: Object.values(projection.semantics.relationships).map((relation) => ({ from: relation.fromActorId, to: relation.toActorId, dimensions: relation.dimensions })),
    obligations: Object.values(projection.semantics.obligations).map((duty) => ({ debtor: duty.debtorActorId, creditor: duty.creditorActorId, kind: duty.kindId, status: duty.status })),
    processes: Object.values(projection.processes.instances).map((process) => ({ template: process.templateId, owners: process.ownerBindings, phase: process.phaseId, progress: process.progress, status: process.status })),
    norms: Object.values(projection.norms.instances).map((norm) => ({ template: norm.templateId, subject: norm.subjectActorId, status: norm.status })),
  });
}

export function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Only the real Pi adapters execute here. No injected deterministic reasoner can acquire a pi-live label. */
export async function evaluateNovelPlay(options: {
  root: string; planHash: string; model?: string; profile?: LlmProfile; signal?: AbortSignal; onStatus?: (message: string) => void;
}): Promise<NovelPlayQuality> {
  const plan = await new NovelEvaluationPlanStore(options.root).read(options.planHash);
  const source = await (await WorkspaceStore.create(options.root)).getSource(plan.sourceId);
  if (!source) throw new Error("EVALUATION_SOURCE_MISSING: the frozen source is not registered");
  const bundle = await new PreparedNovelCache(options.root).candidateSnapshot(source);
  validateEvaluationPlan(plan, bundle);
  const roster = bundle.compilerSnapshot.roleRoster!;
  const startedAt = new Date().toISOString();
  const semantic = await evaluateCompilerAgainstGold(options.root, plan.gold, bundle);
  const entries = await probeMajorRoleEntries(bundle, roster, plan.subjectSnapshotHash);
  const preflight = [...assessSemanticSupport(bundle, plan.supportReviews).issues, ...buildSceneExecutionContracts(bundle, roster).issues];
  const report: NovelPlayQuality = {
    version: 1, profile: "novel-play-v1", sourceSha256: plan.sourceSha256, subjectSnapshotHash: plan.subjectSnapshotHash, rosterHash: plan.rosterHash,
    engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION, validatorFingerprint: NOVEL_VALIDATOR_FINGERPRINT,
    sourceBytes: bundle.compilerSnapshot.structure.sourceBytes, sourceUnits: bundle.compilerSnapshot.structure.baseUnitIds.length,
    accountedBytes: validateFrozenAccounting(bundle).length ? 0 : bundle.compilerSnapshot.structure.sourceBytes,
    accountedUnits: validateFrozenAccounting(bundle).length ? 0 : bundle.compilerSnapshot.structure.baseUnitIds.length,
    gold: { hash: options.planHash, frozenAt: plan.frozenAt, reviewerRunIds: plan.reviewerRunIds, extractionRunIds: roster.extractionRunIds,
      majorCandidateIds: plan.roles.map((role) => role.candidateId), criticalCheckIds: plan.criticalChecks.map((check) => check.id), requiredTasks: plan.roles.map((role) => ({ candidateId: role.candidateId, taskIds: role.tasks.map((task) => task.id) })) },
    startedAt, completedAt: startedAt, supportReviews: plan.supportReviews,
    layers: Object.fromEntries(BENCHMARK_SEMANTIC_LAYERS.map((layer) => {
      const exemption = plan.inapplicableLayers.find((entry) => entry.layer === layer);
      if (exemption) return [layer, { status: "not-applicable", reason: exemption.reason, frozenBeforeRun: true }];
      const metric = semantic.semanticLayers[layer];
      return [layer, metric.status === "evaluated" ? { status: "evaluated", expected: metric.expected, actual: metric.actual!, matched: metric.matched! }
        : { status: metric.status, reason: metric.reason ?? "No independent annotation" }];
    })) as NovelPlayQuality["layers"],
    criticalChecks: plan.criticalChecks.map((check) => {
      const actual = pointerValue(bundle, check.jsonPointer);
      return { id: check.id, passed: actual !== undefined && canonicalJson(actual) === canonicalJson(check.expected), evidenceHash: contentHash({ check, actual: actual ?? null, subject: plan.subjectSnapshotHash }) };
    }),
    runs: [], issues: [...validateFrozenAccounting(bundle), ...entries.issues, ...entries.roles.flatMap((role) => role.issues), ...preflight],
  };
  // Every run has its own root, branch, conversation, trace and fresh Pi sessions.
  for (const scenario of plan.roles) for (let repetition = 1; repetition <= 3; repetition += 1) {
    options.signal?.throwIfAborted();
    const id = `novel-eval-${crypto.randomUUID()}`;
    const root = path.join(worldStorageRoot(options.root), "compiler", "evaluation-workspaces", id);
    await fs.mkdir(root, { recursive: true });
    const traces = new TraceStore(root), recorder = await TraceRecorder.start(traces, { kind: "player-move", sourceId: plan.sourceId, branchId: "evaluation", actorId: scenario.actorId, id });
    const run: NovelPlayQuality["runs"][number] = { id, candidateId: scenario.candidateId, actorId: scenario.actorId,
      mode: "not-run", provider: "unavailable", model: "unavailable", configHash: contentHash({ profile: options.profile ?? null, model: options.model ?? null, scenario, validator: NOVEL_VALIDATOR_FINGERPRINT }), invocationIds: [], status: "not-run", commits: [],
      requiredTasks: scenario.tasks.map((task) => ({ id: task.id, passed: false, evidenceHash: contentHash({ task, status: "not-run" }) })), replayEquivalent: false,
      knowledgeViolations: 0, causalViolations: 0, illegalEffectsAccepted: 0, noOps: 0, rejectedProposals: 0, modelFailures: 0,
    };
    report.runs.push(run);
    let failure: string | undefined;
    try {
      const context = await new WorldContextStore(root).capturePrepared(plan.sourceId, plan.subjectSnapshotHash, bundle.canonical);
      const engine = new WorldEngine(root, context);
      const seed = deriveCharacterEntrySeed(bundle, scenario.actorId);
      if (preflight.length || !seed.projectionSeed || !entries.roles.some((role) => role.actorId === scenario.actorId && role.status === "ready")) throw new Error("EVALUATION_ENTRY_BLOCKED: scene closure, independent mechanism support and deterministic entry probes must pass before live execution");
      let head = await engine.createBranch("evaluation", scenario.actorId, seed.delta, seed.knowledge, plan.sourceId, plan.subjectSnapshotHash, seed.evidence,
        { ...(seed.storyTime ? { storyTime: seed.storyTime } : {}), elapsedDays: seed.projectionSeed.elapsedDays },
        { entryActorId: scenario.actorId, projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds, participantPresence: seed.participantPresence, actorObservations: seed.actorObservations });
      let current = await engine.projections.project(head);
      const seen = new Set([materialProjectionHash(current)]), knowledgeChecks = new Set<number>();
      const satisfies = (conditions: NovelEvaluationPlan["roles"][number]["tasks"][number]["conditions"], projection = current) => conditions.every((predicate) => evaluatePredicateTruth(projection.state, predicate, context.stateSchema) === "true");
      const inspectKnowledge = async () => {
        for (const [index, check] of scenario.knowledgeChecks.entries()) if (satisfies(check.when)) {
          knowledgeChecks.add(index);
          const view = await new KnowledgeProjector(engine).view(check.actorId, head);
          if (view.knowledge.some((entry) => entry.fact.claimId === check.claimId)) run.knowledgeViolations += 1;
        }
      };
      await inspectKnowledge();
      for (const probe of scenario.rejectedProbes) {
        const view = await buildActorScopedActionContext(engine, scenario.actorId, head, undefined, plan.sourceId);
        const scope = [...validatePlayerActionScope(probe.candidate, view), ...validatePlayerActionGrounding(probe.candidate, view), ...await validatePlayerActionSpatialScope(engine, probe.candidate, scenario.actorId, head, plan.sourceId)];
        const action = playerActionToKnowledgeAwareAction({ branchId: "evaluation", actorId: scenario.actorId, expectedParentCommit: head, utterance: probe.candidate.title, candidate: probe.candidate });
        if (!scope.length && (await engine.previewProposal(action.proposal)).report.accepted) run.illegalEffectsAccepted += 1;
      }
      const pi = { root, ...(options.model ? { model: options.model } : {}), ...(options.profile ? { profile: options.profile } : {}), signal: options.signal, trace: recorder.rootContext, onStatus: options.onStatus };
      const translator = createPiPlayerActionTranslator(pi), adjudicator = createPiPlayerWorldAdjudicator(pi), npcResponseReasoner = createPiNpcReactionReasoner(pi), actorReasoner = createPiActorReasoner(pi), worldResponseResolver = createPiPlayerWorldResponseResolver(pi), canonicalAttachmentResolver = createPiCanonicalAttachmentResolver(pi);
      for (let turn = 0; turn < scenario.maxTurns; turn += 1) {
        options.signal?.throwIfAborted();
        options.onStatus?.(`${scenario.actorId}: run ${repetition}/3, turn ${turn + 1}, material commits ${run.commits.filter((commit) => commit.material).length}/50`);
        const previous = head;
        const outcome = await performPlayTurn({ root, branchId: "evaluation", actorId: scenario.actorId, sourceId: plan.sourceId, utterance: scenario.utterances[turn % scenario.utterances.length]!, expectedHead: head,
          translator, adjudicator, npcResponseReasoner, actorReasoner, worldResponseResolver, canonicalAttachmentResolver, advanceBackground: 1, advanceActors: 1, runId: id });
        head = outcome.finalHead;
        if (!outcome.result.accepted) run.rejectedProposals += 1;
        current = await engine.projections.project(head);
        const start = current.history.findLastIndex((entry) => entry.commitId === previous) + 1;
        let beforeHead = previous;
        for (const entry of current.history.slice(start)) {
          if (entry.commitId === beforeHead) continue;
          const after = await engine.projections.project(entry.commitId), fingerprint = materialProjectionHash(after);
          const material = entry.event.actorId === scenario.actorId && fingerprint !== materialProjectionHash(await engine.projections.project(beforeHead)) && !seen.has(fingerprint);
          seen.add(fingerprint);
          run.commits.push({ beforeHead, afterHead: entry.commitId, eventHash: entry.eventHash, material });
          beforeHead = entry.commitId;
        }
        if (head === previous || !run.commits.slice(run.commits.findLastIndex((entry) => entry.afterHead === previous) + 1).some((entry) => entry.material)) run.noOps += 1;
        await inspectKnowledge();
        run.requiredTasks = scenario.tasks.map((task) => ({ id: task.id, passed: satisfies(task.conditions), evidenceHash: contentHash({ task, head, state: current.state }) }));
        if (scenario.termination && satisfies(scenario.termination.conditions) && head !== previous) {
          run.termination = { verified: true, predicateHash: contentHash(scenario.termination), atCommit: head, evidenceHash: contentHash(current.state) };
          run.status = "terminated"; break;
        }
        if (run.commits.filter((commit) => commit.material).length >= 50 && run.requiredTasks.every((task) => task.passed)) { run.status = "completed"; break; }
        if (head === previous) { run.status = "failed"; failure = "EVALUATION_NO_PROGRESS: no legal committed continuation; this is not a terminal state"; break; }
      }
      if (run.status === "not-run") { run.status = "failed"; failure = "EVALUATION_HORIZON_EXHAUSTED: requested experiment horizon ended before acceptance"; }
      if (knowledgeChecks.size !== scenario.knowledgeChecks.length) { run.status = "failed"; failure = "EVALUATION_KNOWLEDGE_ORACLE_UNEXERCISED: not all frozen knowledge checks were reached"; }
      run.replayEquivalent = contentHash(current) === contentHash(await engine.projections.project(head, { fresh: true, useCheckpoints: false }));
      const integrity = await fsckWorld(engine);
      run.causalViolations = integrity.issues.filter((issue) => issue.severity === "error").length;
    } catch (error) { run.status = "failed"; failure = error instanceof Error ? error.message : String(error); }
    finally {
      const trace = await traces.readEvents(id);
      const requests = trace.filter((event) => event.type === "llm.request.started");
      const responses = new Set(trace.filter((event) => event.type === "llm.response.completed").map((event) => event.callId));
      run.invocationIds = [...new Set(requests.filter((event) => responses.has(event.callId)).flatMap((event) => event.callId ? [event.callId] : []))];
      run.modelFailures = trace.filter((event) => event.type === "llm.response.failed").length;
      if (run.invocationIds.length) {
        run.mode = "pi-live";
        run.provider = [...new Set(requests.map((event) => String(event.data?.providerId ?? "unknown")))].sort().join(",");
        run.model = [...new Set(requests.map((event) => String(event.data?.modelId ?? "unknown")))].sort().join(",");
      }
      if (failure) report.issues.push({ code: "NOVEL_LIVE_RUN_FAILED", message: `${id}: ${failure}`, path: scenario.candidateId });
      await recorder.finish(run.status === "completed" || run.status === "terminated" ? "succeeded" : "failed", {}, failure ? { code: "NOVEL_EVALUATION_FAILED", message: failure, retryable: false } : undefined);
    }
    // Checkpoint failed as well as successful runs. A partial report cannot pass the release gate.
    report.completedAt = new Date().toISOString();
    await new NovelPlayQualityStore(options.root).write(novelPlayQualitySchema.parse(report));
  }
  validateEvaluationPlan(plan, await new PreparedNovelCache(options.root).candidateSnapshot(source));
  report.issues.push(...validateNovelPlayQuality(report, { sourceSha256: plan.sourceSha256, subjectSnapshotHash: plan.subjectSnapshotHash, roster,
    sourceBytes: bundle.compilerSnapshot.structure.sourceBytes, sourceUnits: bundle.compilerSnapshot.structure.baseUnitIds.length, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION }));
  report.issues = [...new Map(report.issues.map((issue) => [canonicalJson(issue), issue])).values()];
  await new NovelPlayQualityStore(options.root).write(report);
  return report;
}

export function novelQualityIntervals(report: NovelPlayQuality) {
  return Object.fromEntries(Object.entries(report.layers).map(([layer, metric]) => [layer, metric.status === "evaluated"
    ? { precision: proportion95(metric.matched, metric.actual), recall: proportion95(metric.matched, metric.expected) } : { status: metric.status }]));
}
