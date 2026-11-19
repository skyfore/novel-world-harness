import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import type { ByteRange, CompileUsage, WorldCompletenessReport } from "./world-completeness.js";

/**
 * Read-only reference pack of a legacy compile (iteration 02, design 6.1).
 *
 * The pack is plain JSON, independent of the storage and bundle formats it
 * was exported from, so it stays readable after the namespace bump. It is a
 * comparison and gold-drafting aid only: nothing in it may be imported into a
 * new compile, put into a prompt or treated as an authoritative ID.
 */
export const REFERENCE_PACK_VERSION = 1 as const;
export const REFERENCE_PACK_NOTICE = "Legacy compile, reference only. Never import, prompt with, or treat these IDs as authoritative (iteration 02, decision D8).";

const range = z.object({ startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative() }).strict();
export const referenceEntitySchema = z.object({
  id: z.string(), kind: z.string(), canonicalName: z.string(), aliases: z.array(z.string()),
  resolvedSurfaces: z.array(z.object({ surface: z.string(), aliasType: z.string().optional(), mentions: z.number().int() }).strict()),
  mentions: z.number().int(), firstMention: range.optional(),
}).strict();
export const referenceEventSchema = z.object({
  id: z.string(), title: z.string(), readerSummary: z.string().optional(),
  mentionRanges: z.array(range), triggers: z.array(z.object({ surface: z.string(), startByte: z.number().int(), endByte: z.number().int() }).strict()),
  participants: z.array(z.object({ entityId: z.string(), role: z.string() }).strict()),
  storyTime: z.unknown(), preconditions: z.number().int(), causalParents: z.array(z.string()), effects: z.array(z.string()),
}).strict();
export type ReferenceEntity = z.infer<typeof referenceEntitySchema>;
export type ReferenceEvent = z.infer<typeof referenceEventSchema>;

export const REFERENCE_PACK_FILES = ["entities.json", "mentions.json", "events.json", "scenes.json", "relations.json", "propositions.json", "characters.json", "quotations.json", "reports.json"] as const;
export const referenceMentionSchema = z.object({ id: z.string(), startByte: z.number().int(), endByte: z.number().int(), surface: z.string(), form: z.string(),
  kindCandidates: z.array(z.string()), entityId: z.string().optional(), status: z.string().optional(), aliasType: z.string().optional() }).strict();
export type ReferenceMention = z.infer<typeof referenceMentionSchema>;
export const referenceQuotationSchema = z.object({ id: z.string(), startByte: z.number().int(), endByte: z.number().int(), mode: z.string(), text: z.string(),
  speakerEntityId: z.string().optional(), speakerSurface: z.string().optional() }).strict();
export type ReferenceQuotation = z.infer<typeof referenceQuotationSchema>;
export type ReferencePackFile = typeof REFERENCE_PACK_FILES[number];

export const referenceManifestSchema = z.object({
  version: z.literal(REFERENCE_PACK_VERSION),
  kind: z.literal("nwh-legacy-reference"),
  notice: z.string(),
  source: z.object({ id: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().positive() }).strict(),
  compiler: z.object({ pipelineVersion: z.number().int().nullable(), promptVersion: z.number().int().nullable(), engineVersion: z.string().nullable(), segmenterVersion: z.number().int() }).strict(),
  bundle: z.object({ origin: z.string(), bundleHash: z.string().optional(), baselineIssues: z.number().int() }).strict(),
  exportedAt: z.string().datetime(),
  /** Artifact counts of the exported candidate (design appendix B). */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  files: z.array(z.object({ name: z.enum(REFERENCE_PACK_FILES), records: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().nonnegative() }).strict()),
}).strict();
export type ReferenceManifest = z.infer<typeof referenceManifestSchema>;

type Operation = Record<string, unknown>;
const text = (source: Uint8Array, item: ByteRange, limit = 160) => {
  const value = Buffer.from(source.buffer, source.byteOffset + item.startByte, Math.max(0, item.endByte - item.startByte)).toString("utf8");
  return Array.from(value).length > limit ? `${Array.from(value).slice(0, limit).join("")}…` : value;
};
const anchorRange = (anchor: { startByte: number; endByte: number }): ByteRange => ({ startByte: anchor.startByte, endByte: anchor.endByte });

function effectSummary(operation: Operation): string {
  const parts = [String(operation.op ?? "?")];
  for (const key of ["entityId", "actorId", "field", "claimId", "relationshipId", "fromActorId", "toActorId"]) if (typeof operation[key] === "string") parts.push(`${key}=${operation[key] as string}`);
  if ("value" in operation) parts.push(`value=${JSON.stringify(operation.value)?.slice(0, 120)}`);
  return parts.join(" ");
}

export type ReferencePackContent = { files: Record<ReferencePackFile, unknown[] | Record<string, unknown>>; counts: Record<string, number> };

/** Flatten one compiled candidate into reference records. Deterministic for a given bundle. */
export function buildReferencePack(bundle: PreparedNovelBundle, source: Uint8Array, extras: {
  completeness?: WorldCompletenessReport; usage?: CompileUsage | null;
} = {}): ReferencePackContent {
  const { canonical, compilerSnapshot: snapshot } = bundle;
  const annotations = snapshot.annotations;
  const superseded = new Set(snapshot.entityResolutions.flatMap((item) => item.supersedesResolutionId ? [item.supersedesResolutionId] : []));
  const resolutionOf = new Map(snapshot.entityResolutions.filter((item) => !superseded.has(item.id)).map((item) => [item.mentionId, item]));
  const mentionEntity = new Map([...resolutionOf.entries()].flatMap(([mentionId, item]) => item.entityId && ["resolved", "new-entity"].includes(item.status) ? [[mentionId, item.entityId] as const] : []));
  const entityMentions = annotations.filter((item) => item.annotationType === "entity-mention");
  const eventMentions = new Map(annotations.flatMap((item) => item.annotationType === "event-mention" ? [[item.id, item] as const] : []));
  const quotations = annotations.filter((item) => item.annotationType === "quotation");

  const surfaces = new Map<string, Map<string, { aliasType?: string; mentions: number }>>();
  const firstMention = new Map<string, ByteRange>();
  const mentionCount = new Map<string, number>();
  for (const mention of [...entityMentions].sort((a, b) => a.anchor.startByte - b.anchor.startByte)) {
    const entityId = mentionEntity.get(mention.id);
    if (!entityId) continue;
    mentionCount.set(entityId, (mentionCount.get(entityId) ?? 0) + 1);
    if (!firstMention.has(entityId)) firstMention.set(entityId, anchorRange(mention.anchor));
    const surface = (mention.surface ?? "").trim();
    if (!surface) continue;
    const bySurface = surfaces.get(entityId) ?? new Map();
    const entry = bySurface.get(surface) ?? { mentions: 0, ...(resolutionOf.get(mention.id)?.aliasType ? { aliasType: resolutionOf.get(mention.id)!.aliasType } : {}) };
    entry.mentions += 1;
    bySurface.set(surface, entry);
    surfaces.set(entityId, bySurface);
  }
  const entities: ReferenceEntity[] = canonical.entities.map((entity) => ({
    id: entity.id, kind: entity.kind, canonicalName: entity.canonicalName, aliases: [...entity.aliases],
    resolvedSurfaces: [...(surfaces.get(entity.id) ?? new Map()).entries()].map(([surface, item]) => ({ surface, ...item })).sort((a, b) => b.mentions - a.mentions || a.surface.localeCompare(b.surface)),
    mentions: mentionCount.get(entity.id) ?? 0, ...(firstMention.get(entity.id) ? { firstMention: firstMention.get(entity.id)! } : {}),
  }));

  const supersededEvents = new Set(snapshot.eventResolutions.flatMap((item) => item.supersedesResolutionIds ?? []));
  const eventMentionIds = new Map<string, string[]>();
  for (const item of snapshot.eventResolutions) {
    if (supersededEvents.has(item.id) || !item.canonicalEventId) continue;
    eventMentionIds.set(item.canonicalEventId, [...(eventMentionIds.get(item.canonicalEventId) ?? []), ...item.eventMentionIds]);
  }
  const participants = new Map<string, Array<{ entityId: string; role: string }>>();
  for (const item of canonical.eventParticipations) participants.set(item.eventId, [...(participants.get(item.eventId) ?? []), { entityId: item.entityId, role: item.role }]);
  const events: ReferenceEvent[] = canonical.events.map((event) => {
    const mentions = (eventMentionIds.get(event.id) ?? []).flatMap((id) => eventMentions.get(id) ? [eventMentions.get(id)!] : []);
    return {
      id: event.id, title: event.title, ...(event.readerSummary ? { readerSummary: event.readerSummary } : {}),
      mentionRanges: mentions.flatMap((mention) => mention.extentAnchors.map(anchorRange)).sort((a, b) => a.startByte - b.startByte),
      triggers: mentions.map((mention) => ({ surface: mention.trigger, startByte: mention.triggerAnchor.startByte, endByte: mention.triggerAnchor.endByte })),
      participants: participants.get(event.id) ?? event.participants.map((entityId) => ({ entityId, role: "participant" })),
      storyTime: event.storyTime, preconditions: event.preconditions.length, causalParents: [...event.causalParents],
      effects: [...event.observedOutcome.operations, ...(event.observedKnowledge?.operations ?? [])].map((operation) => effectSummary(operation as Operation)),
    };
  });

  const discourse = new Map(annotations.flatMap((item) => item.annotationType === "discourse-segment" ? [[item.id, item.anchors] as const] : []));
  const scenes = canonical.sceneOccurrences.map((scene) => ({
    id: scene.id,
    ranges: [...scene.discourseSegmentIds.flatMap((id) => (discourse.get(id) ?? []).map(anchorRange)),
      ...scene.evidence.flatMap(({ span }) => span.startByte !== undefined && span.endByte !== undefined ? [{ startByte: span.startByte, endByte: span.endByte }] : [])].sort((a, b) => a.startByte - b.startByte),
    ...(scene.locationId ? { locationId: scene.locationId } : {}), ...(scene.locationUnknown ? { locationUnknown: scene.locationUnknown.reason } : {}),
    presentActorIds: [...scene.presentActorIds], viewpointActorIds: [...scene.viewpointActorIds], eventIds: [...scene.eventIds],
  }));
  const relations = [
    ...canonical.eventRelations.map((relation) => ({ kind: "event" as const, id: relation.id, from: relation.fromEventId, to: relation.toEventId, type: relation.type, status: relation.status })),
    ...canonical.spatialRelations.map((relation) => ({ kind: "spatial" as const, ...(relation as unknown as Record<string, unknown>) })),
  ];
  const propositions = [
    ...canonical.propositions.map((item) => ({ kind: "proposition" as const, ...item })),
    ...canonical.claims.map((item) => ({ kind: "claim" as const, ...item, evidence: undefined })),
    ...canonical.attributions.map((item) => ({ kind: "attribution" as const, ...(item as unknown as Record<string, unknown>), evidence: undefined })),
  ];
  const characters = {
    models: canonical.models, goals: canonical.goals, norms: canonical.normTemplates, processes: canonical.processTemplates,
    actionSchemas: canonical.actionSchemas, rules: canonical.rules,
  };
  const quotationRecords = quotations.map((item) => {
    const speakerEntityId = item.speakerMentionId ? mentionEntity.get(item.speakerMentionId) : undefined;
    const speaker = item.speakerMentionId ? entityMentions.find((mention) => mention.id === item.speakerMentionId) : undefined;
    return { id: item.id, startByte: item.anchor.startByte, endByte: item.anchor.endByte, mode: item.mode, text: text(source, item.anchor),
      ...(speakerEntityId ? { speakerEntityId } : {}), ...(speaker?.surface ? { speakerSurface: speaker.surface } : {}) };
  }).sort((a, b) => a.startByte - b.startByte);
  const mentionRecords: ReferenceMention[] = entityMentions.map((mention) => {
    const resolution = resolutionOf.get(mention.id);
    return { id: mention.id, startByte: mention.anchor.startByte, endByte: mention.anchor.endByte, surface: mention.surface ?? "", form: mention.form,
      kindCandidates: [...mention.kindCandidates], ...(mentionEntity.get(mention.id) ? { entityId: mentionEntity.get(mention.id)! } : {}),
      ...(resolution ? { status: resolution.status } : {}), ...(resolution?.aliasType ? { aliasType: resolution.aliasType } : {}) };
  }).sort((a, b) => a.startByte - b.startByte);
  const reports = {
    ...(extras.completeness ? { completeness: extras.completeness } : {}),
    ...(canonical.timeline ? { timeline: canonical.timeline } : {}),
    ...(bundle.readiness ? { closure: bundle.readiness } : {}),
    ...(bundle.admission ? { admission: bundle.admission } : {}),
    ...(extras.usage ? { usage: extras.usage } : {}),
    accounting: Object.entries((snapshot.accounting?.records ?? []).reduce<Record<string, number>>((counts, record) => ({ ...counts, [record.status]: (counts[record.status] ?? 0) + 1 }), {})),
  };
  const counts = {
    entities: canonical.entities.length, events: canonical.events.length, eventParticipations: canonical.eventParticipations.length,
    eventRelations: canonical.eventRelations.length, spatialRelations: canonical.spatialRelations.length, scenes: canonical.sceneOccurrences.length,
    propositions: canonical.propositions.length, claims: canonical.claims.length, attributions: canonical.attributions.length,
    models: canonical.models.length, goals: canonical.goals.length, norms: canonical.normTemplates.length, processes: canonical.processTemplates.length,
    actionSchemas: canonical.actionSchemas.length, rules: canonical.rules.length,
    entityMentions: entityMentions.length, eventMentions: eventMentions.size, quotations: quotations.length,
    discourseSegments: discourse.size, entityResolutions: snapshot.entityResolutions.length, eventResolutions: snapshot.eventResolutions.length,
  };
  return { files: { "entities.json": entities, "mentions.json": mentionRecords, "events.json": events, "scenes.json": scenes, "relations.json": relations, "propositions.json": propositions,
    "characters.json": characters, "quotations.json": quotationRecords, "reports.json": reports }, counts };
}

const sha256 = (bytes: Uint8Array | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const records = (value: unknown) => Array.isArray(value) ? value.length : Object.keys(value as object).length;

/** Write a pack into a new directory. Refuses an existing directory: a pack is immutable once written. */
export async function writeReferencePack(directory: string, content: ReferencePackContent, meta: Omit<ReferenceManifest, "version" | "kind" | "notice" | "files" | "counts" | "exportedAt"> & { exportedAt?: string }): Promise<ReferenceManifest> {
  try {
    await fs.access(directory);
    throw new Error(`REFERENCE_PACK_EXISTS: ${directory} already exists; verify it with \`compile-novel reference verify\` instead of exporting over it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = `${directory}.${process.pid}.${Date.now()}.partial`;
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const files: ReferenceManifest["files"] = [];
    for (const name of REFERENCE_PACK_FILES) {
      const body = `${JSON.stringify(content.files[name], null, 1)}\n`;
      await fs.writeFile(path.join(staging, name), body, { mode: 0o400 });
      files.push({ name, records: records(content.files[name]), sha256: sha256(body), bytes: Buffer.byteLength(body) });
    }
    const manifest = referenceManifestSchema.parse({ version: REFERENCE_PACK_VERSION, kind: "nwh-legacy-reference", notice: REFERENCE_PACK_NOTICE,
      ...meta, exportedAt: meta.exportedAt ?? new Date().toISOString(), counts: content.counts, files });
    await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await fs.rename(staging, directory);
    return manifest;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export type ReferencePackVerification = { directory: string; manifest: ReferenceManifest | null; issues: string[]; ok: boolean };

/** Recompute every file hash and record count against the manifest; with `expected`, also check artifact counts. */
export async function verifyReferencePack(directory: string, expected?: Record<string, number>): Promise<ReferencePackVerification> {
  const issues: string[] = [];
  let manifest: ReferenceManifest | null = null;
  try { manifest = referenceManifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"))); }
  catch (error) { return { directory, manifest: null, issues: [`manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}`], ok: false }; }
  for (const name of REFERENCE_PACK_FILES) if (!manifest.files.some((file) => file.name === name)) issues.push(`${name} missing from manifest`);
  for (const file of manifest.files) {
    let body: string;
    try { body = await fs.readFile(path.join(directory, file.name), "utf8"); }
    catch { issues.push(`${file.name} missing`); continue; }
    if (sha256(body) !== file.sha256) issues.push(`${file.name} hash mismatch`);
    if (Buffer.byteLength(body) !== file.bytes) issues.push(`${file.name} size mismatch`);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { issues.push(`${file.name} is not JSON`); continue; }
    if (records(parsed) !== file.records) issues.push(`${file.name} has ${records(parsed)} records, manifest says ${file.records}`);
    if (file.name === "entities.json") { const result = z.array(referenceEntitySchema).safeParse(parsed); if (!result.success) issues.push(`entities.json schema: ${result.error.issues[0]?.message}`); }
    if (file.name === "events.json") { const result = z.array(referenceEventSchema).safeParse(parsed); if (!result.success) issues.push(`events.json schema: ${result.error.issues[0]?.message}`); }
  }
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (manifest.counts[key] !== value) issues.push(`count ${key}: pack has ${manifest.counts[key] ?? "none"}, expected ${value}`);
  }
  return { directory, manifest, issues, ok: issues.length === 0 };
}

export type LoadedReferencePack = { manifest: ReferenceManifest; entities: ReferenceEntity[]; events: ReferenceEvent[]; mentions: ReferenceMention[]; quotations: ReferenceQuotation[] };

export async function loadReferencePack(directory: string): Promise<LoadedReferencePack> {
  const verification = await verifyReferencePack(directory);
  if (!verification.ok || !verification.manifest) throw new Error(`REFERENCE_PACK_INVALID: ${verification.issues.join("; ")}`);
  return {
    manifest: verification.manifest,
    entities: z.array(referenceEntitySchema).parse(JSON.parse(await fs.readFile(path.join(directory, "entities.json"), "utf8"))),
    events: z.array(referenceEventSchema).parse(JSON.parse(await fs.readFile(path.join(directory, "events.json"), "utf8"))),
    mentions: z.array(referenceMentionSchema).parse(JSON.parse(await fs.readFile(path.join(directory, "mentions.json"), "utf8"))),
    quotations: z.array(referenceQuotationSchema).parse(JSON.parse(await fs.readFile(path.join(directory, "quotations.json"), "utf8"))),
  };
}

export type ReferenceComparison = {
  scope: ByteRange;
  /** A review list, never a gate or a denominator (design 6.3). */
  interpretation: string;
  entities: { reference: number; reproduced: number; missing: Array<{ id: string; kind: string; name: string; mentions: number; firstMention?: ByteRange }> };
  events: { reference: number; reproduced: number; missing: Array<{ id: string; title: string; ranges: ByteRange[] }> };
};

const overlaps = (left: ByteRange, right: ByteRange) => left.startByte < right.endByte && right.startByte < left.endByte;

/**
 * Within the range the new compile covers, list legacy entities (by name) and
 * events (by mention-extent overlap) the new candidate does not reproduce.
 */
export function compareWithReference(bundle: PreparedNovelBundle, pack: LoadedReferencePack, scope?: ByteRange): ReferenceComparison {
  if (pack.manifest.source.id !== bundle.source.id) throw new Error(`REFERENCE_SOURCE_MISMATCH: pack belongs to ${pack.manifest.source.id}, candidate to ${bundle.source.id}.`);
  const window = scope ?? { startByte: 0, endByte: pack.manifest.source.bytes };
  const names = new Set(bundle.canonical.entities.flatMap((entity) => [entity.canonicalName, ...entity.aliases].map((name) => name.trim())));
  const referenceEntities = pack.entities.filter((entity) => entity.firstMention && overlaps(entity.firstMention, window));
  const reproducedEntity = (entity: ReferenceEntity) => [entity.canonicalName, ...entity.aliases, ...entity.resolvedSurfaces.map((item) => item.surface)].some((name) => names.has(name.trim()));
  const { compilerSnapshot: snapshot } = bundle;
  const mentionExtents = new Map(snapshot.annotations.flatMap((item) => item.annotationType === "event-mention" ? [[item.id, item.extentAnchors.map(anchorRange)] as const] : []));
  const newRanges: ByteRange[] = [];
  const canonicalEvents = new Set(bundle.canonical.events.map((event) => event.id));
  for (const item of snapshot.eventResolutions) if (item.canonicalEventId && canonicalEvents.has(item.canonicalEventId)) for (const id of item.eventMentionIds) newRanges.push(...(mentionExtents.get(id) ?? []));
  for (const event of bundle.canonical.events) for (const { span } of event.evidence) if (span.startByte !== undefined && span.endByte !== undefined) newRanges.push({ startByte: span.startByte, endByte: span.endByte });
  const referenceEvents = pack.events.filter((event) => event.mentionRanges.some((item) => overlaps(item, window)));
  const reproducedEvent = (event: ReferenceEvent) => event.mentionRanges.some((item) => newRanges.some((other) => overlaps(item, other)));
  const missingEntities = referenceEntities.filter((entity) => !reproducedEntity(entity));
  const missingEvents = referenceEvents.filter((event) => !reproducedEvent(event));
  return {
    scope: window,
    interpretation: "Legacy artifacts in scope the new candidate does not reproduce. Each needs a reproduction or a reviewed note; the legacy compile had known false entities, so this is a review list, not a gate.",
    entities: { reference: referenceEntities.length, reproduced: referenceEntities.length - missingEntities.length,
      missing: missingEntities.map((entity) => ({ id: entity.id, kind: entity.kind, name: entity.canonicalName, mentions: entity.mentions, ...(entity.firstMention ? { firstMention: entity.firstMention } : {}) })) },
    events: { reference: referenceEvents.length, reproduced: referenceEvents.length - missingEvents.length,
      missing: missingEvents.map((event) => ({ id: event.id, title: event.title, ranges: event.mentionRanges })) },
  };
}
