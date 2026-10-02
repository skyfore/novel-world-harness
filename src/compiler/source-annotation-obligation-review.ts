import { jsonArguments } from "../agent/json-arguments.js";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { z } from "zod";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { contentHash } from "../world/canonical.js";
import { ProposalStore } from "../world/canonical-model.js";
import { idSchema } from "../world/model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { compilerScopePlan } from "./batch-plan.js";
import { BoundaryCalibrationStore } from "./boundary-calibration.js";
import { ChapterSplitPlanStore } from "./chapter-split.js";
import { EventResolutionStore } from "./event-resolution.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import {
  annotationSelectorCorrectionSchema,
  CompilerProposalObligations,
  sourceAnnotationInputSelectors,
  sourceAnnotationProposalToolSchema,
  type AnnotationSelectorCorrection,
} from "./proposal-obligations.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { SegmentStore } from "./segments.js";
import { SourceAccountingStore } from "./source-accounting.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { COMPILER_PIPELINE_VERSION } from "./batch-progress.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const sourceAnnotationObligationReviewSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: sourceAnnotationProposalToolSchema,
  proposalId: idSchema,
  failedInputHashes: z.array(sha256Schema).min(2)
    .refine(values => new Set(values).size === values.length, "Duplicate failed annotation input hash"),
  reason: z.string().trim().min(1),
  auditRef: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expectedPreviewHash: sha256Schema.optional(),
}).strict();

export type SourceAnnotationObligationReview = z.infer<typeof sourceAnnotationObligationReviewSchema>;

export type SourceAnnotationObligationPreview = {
  status: "verified-preview";
  executableCertification: false;
  pipelineVersion: number;
  previewHash: string;
  sourceSha256: string;
  batchScopeHash: string;
  batchSegmentIds: string[];
  binding: AnnotationSelectorCorrection;
  evidencePreview: Array<{
    path: string;
    segmentId: string;
    exactHash: string;
    startByte: number;
    endByte: number;
  }>;
};

export type SourceAnnotationObligationResult = SourceAnnotationObligationPreview | (
  Omit<SourceAnnotationObligationPreview, "status"> & { status: "staged"; proposal: unknown }
);

/**
 * Read-only by default. Applying requires the preview hash and acquires the
 * workspace compiler lock before revalidating the same source, scope, history,
 * input, and absence of any finish receipt or prior proposal output.
 */
export async function reviewSourceAnnotationObligation(
  root: string,
  raw: unknown,
  apply = false,
): Promise<SourceAnnotationObligationResult> {
  const review = sourceAnnotationObligationReviewSchema.parse(raw);
  if (!apply) return buildSourceAnnotationObligationPreview(root, review);
  if (!review.expectedPreviewHash) {
    throw new Error("Applying a source-annotation correction requires expectedPreviewHash from a fresh read-only preview.");
  }
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const preview = await buildSourceAnnotationObligationPreview(root, review);
    const toolset = createCompilerProposalToolset(root, {}, { hostObligationCorrection: true });
    await toolset.beginBatch(preview.batchSegmentIds, review.batchId, review.sourceId);
    const tool = toolset.tools.find(candidate => candidate.name === review.tool);
    if (!tool) throw new Error(`Host annotation correction tool ${review.tool} is unavailable.`);
    const journal = new CompilerProposalObligations(root, review.sourceId, review.batchId);
    const proposal = await journal.withHostAnnotationSelectorCorrection(
      review.tool,
      review.input,
      preview.binding,
      review.reason,
      review.auditRef,
      async () => {
        const prepared = tool.prepareArguments ? await tool.prepareArguments(review.input) : review.input;
        return tool.execute("host-source-annotation-selector-correction", prepared as never, undefined, undefined, {} as never);
      },
    );
    return { ...preview, status: "staged", proposal };
  });
}

export async function buildSourceAnnotationObligationPreview(
  root: string,
  raw: unknown,
): Promise<SourceAnnotationObligationPreview> {
  const review = sourceAnnotationObligationReviewSchema.parse(raw);
  const identity = CompilerProposalObligations.identity(review.tool, review.input);
  if (identity.proposalId !== review.proposalId) {
    throw new Error("Host annotation correction must retain the exact failed proposal ID.");
  }
  const journal = new CompilerProposalObligations(root, review.sourceId, review.batchId);
  const binding = annotationSelectorCorrectionSchema.parse(
    journal.inspectAnnotationSelectorCorrection(review.tool, review.input),
  );
  if (contentHash([...binding.failedInputHashes].sort()) !== contentHash([...review.failedInputHashes].sort())) {
    throw new Error("Host annotation correction must bind every distinct failed input hash.");
  }
  if (await new CompilerFinishReceipts(root, review.sourceId, review.batchId).read()) {
    throw new Error("A compiler finish receipt already exists; annotation mutation is frozen and must not be corrected in place.");
  }
  const existingOutputs = await proposalOutputLocations(root, review.sourceId, review.proposalId);
  if (existingOutputs.length) {
    throw new Error(`The failed annotation identity already has proposal output (${existingOutputs.join(", ")}); stop for host inspection.`);
  }

  const workspace = WorkspaceStore.openReadOnly(root);
  const source = await workspace.getSource(review.sourceId);
  if (!source) throw new Error(`Unknown source ${review.sourceId}; host correction cannot infer another source.`);
  const sourceBytes = await new SourceMaterialStore().read(source);
  if (!sourceBytes) throw new Error("Archived source bytes are missing; source-annotation correction cannot proceed.");
  const manifest = await new SegmentStore(root).readManifest(review.sourceId);
  if (!manifest) throw new Error("Source segment manifest is missing; source-annotation correction cannot proceed.");
  const [chapterSplit, boundaries] = await Promise.all([
    new ChapterSplitPlanStore(root).read(review.sourceId),
    new BoundaryCalibrationStore(root).list(review.sourceId),
  ]);
  const scope = compilerScopePlan(source, manifest.segments, Boolean(chapterSplit), boundaries)
    .find(candidate => candidate.id === review.batchId);
  if (!scope || !scope.segmentIds.length || scope.stage === "structure") {
    throw new Error("The failed annotation batch is absent from the current source-scoped compiler plan.");
  }
  const byId = new Map(manifest.segments.map(segment => [segment.id, segment]));
  const batchSegments = scope.segmentIds.map(segmentId => {
    const segment = byId.get(segmentId);
    if (!segment) throw new Error(`Compiler batch references missing source segment ${segmentId}.`);
    return segment;
  });
  const selectors = sourceAnnotationInputSelectors(review.tool, review.input);
  if (selectors.some(entry => !scope.segmentIds.includes(entry.selector.segment_id))) {
    throw new Error("Host annotation correction cannot widen or replace the original compiler batch source scope.");
  }

  const toolset = createCompilerProposalToolset(root);
  const tool = toolset.tools.find(candidate => candidate.name === review.tool);
  if (!tool) throw new Error(`Source-annotation proposal tool ${review.tool} is unavailable.`);
  validateToolArguments(
    { name: tool.name, description: tool.description, parameters: tool.parameters },
    { type: "toolCall", id: "host-source-annotation-preview", name: tool.name, arguments: jsonArguments(review.input) },
  );

  const evidencePreview = [];
  const anchors = new Map<string, Awaited<ReturnType<typeof resolveTextSelectorAnchor>>>();
  for (const entry of selectors) {
    const segment = byId.get(entry.selector.segment_id)!;
    let anchor: Awaited<ReturnType<typeof resolveTextSelectorAnchor>>;
    try {
      anchor = await resolveTextSelectorAnchor(root, segment, entry.selector);
    } catch (error) {
      throw new Error(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    anchors.set(entry.path, anchor);
    evidencePreview.push({
      path: entry.path,
      segmentId: segment.id,
      exactHash: anchor.exactHash,
      startByte: anchor.startByte,
      endByte: anchor.endByte,
    });
  }
  validateAnnotationSelectorSemantics(review.tool, review.input, selectors, anchors);

  const batchScopeHash = contentHash({
    pipelineVersion: COMPILER_PIPELINE_VERSION,
    sourceId: source.id,
    sourceSha256: source.contentSha256,
    batchId: review.batchId,
    stage: scope.stage,
    segments: batchSegments,
  });
  const authority = {
    pipelineVersion: COMPILER_PIPELINE_VERSION,
    sourceSha256: source.contentSha256,
    batchScopeHash,
    batchSegmentIds: [...scope.segmentIds],
    binding,
    evidencePreview,
  };
  const previewHash = contentHash(authority);
  if (review.expectedPreviewHash && review.expectedPreviewHash !== previewHash) {
    throw new Error("Source-annotation correction preview changed; inspect the current history and scope before applying.");
  }
  return {
    status: "verified-preview",
    executableCertification: false,
    ...authority,
    previewHash,
  };
}

function validateAnnotationSelectorSemantics(
  tool: z.infer<typeof sourceAnnotationProposalToolSchema>,
  input: Record<string, unknown>,
  selectors: ReturnType<typeof sourceAnnotationInputSelectors>,
  anchors: ReadonlyMap<string, Awaited<ReturnType<typeof resolveTextSelectorAnchor>>>,
) {
  if (tool === "propose_entity_mention" && input.form !== "zero-anaphora"
    && input.surface !== selectors[0]!.selector.exact) {
    throw new Error("A non-zero entity mention surface must exactly equal selector.exact.");
  }
  if (tool !== "propose_event_mention") return;
  const trigger = selectors.find(entry => entry.path === "/trigger_selector")!;
  if (input.trigger !== trigger.selector.exact) {
    throw new Error("An event mention trigger must exactly equal trigger_selector.exact.");
  }
  const triggerAnchor = anchors.get(trigger.path)!;
  const containsTrigger = selectors.filter(entry => entry.path.startsWith("/extent_selectors/"))
    .map(entry => anchors.get(entry.path)!)
    .some(anchor => anchor.sourceId === triggerAnchor.sourceId
      && anchor.startByte <= triggerAnchor.startByte && anchor.endByte >= triggerAnchor.endByte);
  if (!containsTrigger) throw new Error("An event mention trigger must be contained by at least one extent selector.");
}

async function proposalOutputLocations(root: string, sourceId: string, proposalId: string): Promise<string[]> {
  const locations: string[] = [];
  const statuses = ["pending", "accepted", "rejected"] as const;
  const world = new ProposalStore(root);
  const annotations = new SourceAnnotationStore(root);
  const entities = new EntityResolutionStore(root);
  const events = new EventResolutionStore(root);
  const accounting = new SourceAccountingStore(root);
  for (const status of statuses) {
    if ((await world.list(status)).some(item => item.id === proposalId)) locations.push(`world:${status}`);
    if ((await annotations.listProposals(sourceId, status)).some(item => item.id === proposalId)) locations.push(`annotation:${status}`);
    if ((await entities.listProposals(sourceId, status)).some(item => item.id === proposalId)) locations.push(`entity-resolution:${status}`);
    if ((await events.listProposals(sourceId, status)).some(item => item.id === proposalId)) locations.push(`event-resolution:${status}`);
    if ((await accounting.listProposals(sourceId, status)).some(item => item.id === proposalId)) locations.push(`accounting:${status}`);
  }
  return locations;
}
