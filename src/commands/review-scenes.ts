import fs from "node:fs/promises";
import { sceneCapabilitySpecSchema, evaluateSceneCapabilities, type SceneReviewCatalog } from "../eval/scene-capabilities.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { CompilerValidator } from "../compiler/validator.js";
import { compilerProposalSchemas, type CompilerProposalKind } from "../compiler/proposals.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";

export async function reviewScenes(root: string, specInput: unknown) {
  const spec = sceneCapabilitySpecSchema.parse(specInput);
  const source = await WorkspaceStore.openReadOnly(root).getSource(spec.sourceId);
  if (!source || source.contentSha256 !== spec.sourceSha256) throw new Error("Independent scene review does not match a registered immutable source.");
  const bytes = await new SourceMaterialStore().read(source);
  if (!bytes) throw new Error("Archived source bytes are missing; scene review cannot repair storage.");
  const catalog = await new CompilerValidator(new CanonicalModelStore(root)).loadCatalog();
  const mapping: Partial<Record<CompilerProposalKind, keyof SceneReviewCatalog>> = { entity: "entities", proposition: "propositions", attribution: "attributions", claim: "claims",
    "canonical-event": "events", "event-participation": "eventParticipations", "event-execution": "eventExecutions", "action-schema": "actionSchemas", "norm-template": "normTemplates", "world-rule": "rules" };
  for (const key of Object.values(mapping)) {
    const values = catalog[key] as Map<string, { evidence: Array<{ span: { sourceId: string } }> }> | undefined;
    for (const [id, value] of values ?? []) if (value.evidence.length && value.evidence.some((ref) => ref.span.sourceId !== source.id)) values!.delete(id);
  }
  const proposals = new ProposalStore(root), seen = new Set<string>();
  const pendingRevisions: Array<{ proposalId: string; kind: string; artifactId: string; createdAt: string; compilerBatchId?: string }> = [];
  for (const item of await proposals.list("pending", source.id)) {
    const kind = item.kind as CompilerProposalKind, target = mapping[kind];
    if (!target) continue;
    const envelope = await proposals.readEnvelope("pending", item.id);
    const payload = compilerProposalSchemas[kind].parse(envelope.payload) as { id: string };
    const identity = `${target}:${payload.id}`;
    if (seen.has(identity)) throw new Error(`Ambiguous pending scene dependency ${identity}; review exact proposal revisions before evaluation.`);
    seen.add(identity);
    (catalog[target] as Map<string, unknown>).set(payload.id, payload);
    pendingRevisions.push({ proposalId: item.id, kind, artifactId: payload.id, createdAt: item.createdAt,
      ...((envelope.generatedBy as { compilerBatchId?: string } | undefined)?.compilerBatchId ? { compilerBatchId: (envelope.generatedBy as { compilerBatchId: string }).compilerBatchId } : {}) });
  }
  return { ...evaluateSceneCapabilities(spec, bytes, catalog), catalogMode: "pending-overlay-on-canonical", pendingRevisions };
}

export async function reviewScenesCommand(root: string, specFile: string) {
  const result = await reviewScenes(root, JSON.parse(await fs.readFile(specFile, "utf8")));
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) process.exitCode = 2;
}
