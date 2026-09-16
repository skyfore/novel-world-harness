import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import crypto from "node:crypto";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { contentHash } from "../world/canonical.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { SegmentStore, segmentSource } from "./segments.js";
import { upstreamRepairHostError } from "./upstream-repair-preflight.js";
import { textAnchorForByteRange } from "./text-anchors.js";

/** Structural absence only. No inferred quotation boundaries, identity match or requirement satisfaction. */
export async function discoverUpstreamRepairDiagnostics(root: string, sourceId: string) {
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw upstreamRepairHostError("Discovery source is missing; use the registered source ID, never guess a storage path");
  const bytes = await readSourceMaterial(root, source), manifest = await new SegmentStore(root).readManifest(sourceId);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== source.contentSha256 || !manifest || contentHash(manifest) !== contentHash(await segmentSource(root, source))) throw upstreamRepairHostError("Discovery requires immutable source bytes and the current original segment layout");
  const [annotations, entities, events, records] = await Promise.all([
    new SourceAnnotationStore(root).list(sourceId), new EntityResolutionStore(root).list(sourceId), new EventResolutionStore(root).list(sourceId), loadCompilerArtifactRecords(root, sourceId),
  ]);
  const findings = [];
  for (const annotation of annotations) {
    let diagnostic;
    if (annotation.annotationType === "quotation" && annotation.speakerMentionId && !annotations.some(item => item.id === annotation.speakerMentionId)) {
      diagnostic = { code: "QUOTATION_SPEAKER_MENTION_MISSING" as const, quotationId: annotation.id, revisionHash: contentHash(annotation) };
    } else if (annotation.annotationType === "entity-mention" && !entities.some(item => item.mentionId === annotation.id)) {
      diagnostic = { code: "ENTITY_RESOLUTION_MISSING" as const, mentionId: annotation.id, revisionHash: contentHash(annotation) };
    } else if (annotation.annotationType === "event-mention" && !events.some(item => item.eventMentionIds.includes(annotation.id))) {
      diagnostic = { code: "EVENT_RESOLUTION_MISSING" as const, mentionId: annotation.id, revisionHash: contentHash(annotation) };
    }
    if (!diagnostic) continue;
    const anchors = annotation.annotationType === "event-mention" ? [annotation.triggerAnchor, ...annotation.extentAnchors]
      : annotation.annotationType === "discourse-segment" ? annotation.anchors : [annotation.anchor];
    if (anchors.some(anchor => anchor.sourceId !== sourceId || contentHash(anchor) !== contentHash(textAnchorForByteRange(sourceId, bytes, anchor.startByte, anchor.endByte)))) throw upstreamRepairHostError("Discovery annotation evidence differs from immutable source bytes");
    const sourceSegmentIds = manifest.segments.filter(segment => anchors.some(anchor => segment.startByte <= anchor.startByte && segment.endByte >= anchor.endByte)).map(segment => segment.id);
    findings.push({ findingId: contentHash({ sourceSha256: source.contentSha256, diagnostic }), diagnostic, sourceSegmentIds });
  }
  return { version: 1 as const, authority: "diagnostic-only" as const, sourceId, sourceSha256: source.contentSha256,
    candidateRefs: records.filter(item => item.status === "canonical" && ["entity", "canonical-event"].includes(item.kind))
      .map(item => ({ kind: item.kind, id: item.logicalId, revisionHash: contentHash(item.payload), readArguments: { ref: item.ref } })),
    findings: findings.sort((a, b) => a.findingId.localeCompare(b.findingId)),
    recovery: "Copy findings[].diagnostic exactly into a host review, bind its independent requirementId and explicit source scope; resolution candidates require the exact candidateRefs[].id and candidateRefs[].revisionHash for the correct kind; readArguments.ref permits original artifact inspection. Discovery never authorizes a repair or guesses identity. Existing unresolved resolutions require separate host review, not duplicate creation." };
}
