import crypto from "node:crypto";
import { SOURCE_ANNOTATION_ONTOLOGY_VERSION, SourceAnnotationStore, sourceAnnotationSchema, type EventMentionType, type SourceAnnotation } from "../annotations.js";
import type { EntityKind } from "../../world/model.js";
import type { ByteRange } from "../world-completeness.js";
import type { StageContext } from "./runner.js";
import type { CensusClass } from "./store.js";
import type { ScopeText } from "./text.js";
import { stageOnce } from "./tooling.js";

export const HOST_LEXICAL_WORKER = "host-lexical-v1";
export const PIPELINE_OBSERVATION_WORKER = "pipeline-observation";

export const KIND_FOR_CLASS: Record<CensusClass, EntityKind[]> = {
  person: ["character"], location: ["location"], organization: ["faction", "institution"], object: ["artifact"], lore: ["concept"], time: ["other"], "non-entity": ["other"],
};

/** Annotation IDs are derived from type and exact bytes, so a re-review rewrites rather than duplicates. */
export const annotationId = (prefix: "em" | "q" | "ev" | "ds", range: ByteRange) => `${prefix}-${range.startByte}-${range.endByte}`;

/**
 * Writes observations for one scope. Every annotation is host-anchored
 * (exact bytes, lines, hashes) and committed through the annotation store's
 * proposal path; the worker records whether a host candidate or the model
 * produced it.
 */
export class AnnotationWriter {
  private readonly store: SourceAnnotationStore;
  constructor(private readonly ctx: StageContext, private readonly scopeId: string, private readonly text: ScopeText) {
    this.store = new SourceAnnotationStore(ctx.root);
  }

  private derivation(worker: string) {
    return { runId: this.ctx.runId, worker, compilerBatchId: this.scopeId, ...(this.ctx.generatedBy.provider ? { provider: this.ctx.generatedBy.provider } : {}),
      ...(this.ctx.generatedBy.model && worker !== HOST_LEXICAL_WORKER ? { model: this.ctx.generatedBy.model } : {}), ontologyVersion: SOURCE_ANNOTATION_ONTOLOGY_VERSION };
  }

  async commit(annotation: SourceAnnotation): Promise<SourceAnnotation> {
    const payload = sourceAnnotationSchema.parse(annotation);
    const existing = await this.store.read(this.ctx.sourceId, payload.id).catch(() => null);
    if (existing && JSON.stringify(existing) === JSON.stringify(payload)) return payload;
    const id = await stageOnce((proposalId) => this.store.stage(this.ctx.sourceId, { version: 1, id: proposalId, annotationType: payload.annotationType, payload,
      generatedBy: { worker: payload.derivation.worker, compilerBatchId: this.scopeId, ...(payload.derivation.provider ? { provider: payload.derivation.provider } : {}), ...(payload.derivation.model ? { model: payload.derivation.model } : {}) },
      createdAt: new Date().toISOString() }), `pp-${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`);
    await this.store.commitProposals(this.ctx.sourceId, [id]);
    return payload;
  }

  entityMention(input: { range: ByteRange; form: "proper" | "nominal" | "pronoun" | "title" | "kinship" | "collective"; kinds: EntityKind[]; worker: string; interpretation?: string }): SourceAnnotation {
    return { version: 1, id: annotationId("em", input.range), sourceId: this.ctx.sourceId, derivation: this.derivation(input.worker), annotationType: "entity-mention",
      anchor: this.text.anchor(input.range), surface: this.text.text(input.range), form: input.form, kindCandidates: [...new Set(input.kinds)], confidence: input.worker === HOST_LEXICAL_WORKER ? 0.9 : 0.8,
      ...(input.interpretation ? { interpretation: input.interpretation } : {}) };
  }

  quotation(input: { range: ByteRange; mode: "direct" | "indirect" | "free-indirect"; speakerMentionId?: string; cue?: ByteRange; worker: string; interpretation?: string }): SourceAnnotation {
    return { version: 1, id: annotationId("q", input.range), sourceId: this.ctx.sourceId, derivation: this.derivation(input.worker), annotationType: "quotation",
      anchor: this.text.anchor(input.range), mode: input.mode, ...(input.speakerMentionId ? { speakerMentionId: input.speakerMentionId } : {}), addresseeMentionIds: [],
      ...(input.cue ? { cueAnchor: this.text.anchor(input.cue) } : {}), attributionConfidence: input.speakerMentionId ? 0.8 : 0, ...(input.interpretation ? { interpretation: input.interpretation } : {}) };
  }

  eventMention(input: { trigger: ByteRange; extents: ByteRange[]; types: EventMentionType[]; participantMentionIds: string[]; salience: "major" | "supporting" | "minor"; interpretation?: string }): SourceAnnotation {
    return { version: 1, id: annotationId("ev", input.trigger), sourceId: this.ctx.sourceId, derivation: this.derivation(PIPELINE_OBSERVATION_WORKER), annotationType: "event-mention",
      triggerAnchor: this.text.anchor(input.trigger), trigger: this.text.text(input.trigger), extentAnchors: input.extents.map((range) => this.text.anchor(range)),
      eventTypeCandidates: [...new Set(input.types)], participantMentionIds: [...new Set(input.participantMentionIds)], salience: input.salience, confidence: 0.8,
      ...(input.interpretation ? { interpretation: input.interpretation } : {}) };
  }

  discourse(input: { extents: ByteRange[]; kind: "scene" | "summary" | "flashback" | "flashforward" | "frame" | "recollection" | "hypothetical" | "dream" | "embedded-document" | "narrator-commentary" | "unclassified"; interpretation?: string }): SourceAnnotation {
    return { version: 1, id: annotationId("ds", input.extents[0]!), sourceId: this.ctx.sourceId, derivation: this.derivation(PIPELINE_OBSERVATION_WORKER), annotationType: "discourse-segment",
      kind: input.kind, anchors: input.extents.map((range) => this.text.anchor(range)), confidence: 0.8, ...(input.interpretation ? { interpretation: input.interpretation } : {}) };
  }
}
