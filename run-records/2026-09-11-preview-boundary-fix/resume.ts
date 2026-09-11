import { prepareAllCommand, INITIAL_WORLD_PROMPT } from "../../src/commands/prepare-all.js";
import { compileCommand } from "../../src/commands/compile.js";
import { prepareOpeningWorldCompilerBatch } from "../../src/compiler/batches.js";
import { SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES, EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES } from "../../src/compiler/proposal-tools.js";
import { PreparedNovelCache } from "../../src/compiler/prepared-cache.js";
import { WorkspaceStore } from "../../src/storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16";
await withWorkspaceOperationLock(root, "compiler", async () => {
  const source = (await (await WorkspaceStore.create(root)).listSources()).find(s => s.id === sourceId)!;
  const batch = await prepareOpeningWorldCompilerBatch(root, source);
  // Complete the existing opening scope before converging its partial world drafts.
  await compileCommand({ root, sourceId, compilerBatchId: batch.id, segmentIds: batch.segmentIds,
    configPath: `${root}/novel-harness.yaml`, allowMissingConfig: true,
    model: "openai-codex/gpt-5.6-terra", acquireLock: false, saveSession: false, includeLocalTools: false,
    disabledProposalTools: ["propose_state_delta", ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES.filter(n => n !== "propose_entity_mention"), ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES],
    prompt: `${INITIAL_WORLD_PROMPT}\n\n${batch.prompt}\n\nHost boundary review: The prior run failed before preview execution, first using checkpoint-present/pre-checkpoint and then deleting required temporalClass fields. The exact allowed values are at-checkpoint, before-checkpoint, later-discourse-preexisting. They were present in the provider tool schema. Preserve these required fields with source-supported values. projectionSeed must not contain checkpoint; checkpoint belongs at payload.checkpoint. The host replayed both exact failed inputs in isolation and fixed parameter-stage error reporting and retry accounting. This authorizes a fresh reviewed attempt without modifying any draft. Host continuation review: Preserve and reuse the existing pending opening entity char-opening-man (envelope p-entity-opening-man-fix0911), mention mention-opening-man (p-mention-opening-man), and resolution res-opening-man-fix0911 (p-resolve-opening-man-fix0911); the exact original resolution was host-revalidated after a changed-content replay conflicted. Do not resubmit these drafts with reworded rationales or added optional fields. Inspect current artifacts before any replacement. Previous previews used invalid temporalClass/basis enums and misplaced checkpoint inside projectionSeed; preview now exposes the full submission contract. Read it before calling. The latest stance fact fact-opening-relief-stance was labeled focal-knowledge without seeded claims. The exact source explicitly narrates his relief at hearing the train: source-narrator-established may support reader presentation when accurately scoped. This does not seed character knowledge. If you actually rely on focal-knowledge, first propose and seed a source-supported claim and reference it; never invent a claim ID. character.health is a number in [0,1], so the previous string 冷汗、呼吸急促 is invalid; retain these observations in evidence-backed presentation and do not invent a numerical health score. Recheck all state-field types, narrativeLayerId existence, identity references, and selectors. Use p-initial-opening-world for the initial proposal; preview before submit and finish. After two failed previews stop for host review, never restart automatically. Old rejected envelopes remain history; only replace a draft after a concrete evidence-based diagnosis.` });
  await prepareAllCommand({ root, sourceId, model: "openai-codex/gpt-5.6-terra", yes: true,
    candidateOnly: true, createBranch: false, restoreCache: false, acquireLock: false }, {
    compileInitialWorld: async () => { throw new Error("Completed opening did not establish an initial proposal; preserve state for host review"); },
  });
  const candidate = await new PreparedNovelCache(root).archiveCandidate(source);
  console.log(JSON.stringify({ sourceId, candidateBundleHash: candidate.bundleHash }, null, 2));
});
