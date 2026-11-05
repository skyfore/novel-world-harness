import { createHash } from "node:crypto";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { ConsumerArtifactReadTracker, artifactRef, type ConsumerArtifact } from "./identity-consumer-artifacts.js";

export const CONSUMER_EVIDENCE_COVERAGE = "consumer-evidence-coverage/v1" as const;
export const consumerEvidenceCorrectionContract = { policy: CONSUMER_EVIDENCE_COVERAGE,
  correction: "Supply the exact original consumer/dependency source ranges omitted from the earlier review. Preserve both negative judgments and all original semantic checks. Evidence delivery is not semantic support; inspect the complete source before deciding. No world write, new allowance or predetermined verdict." };
export type EvidenceSegment = { id: string; startByte: number; endByte: number };
export type EvidenceSubject = { ref: string; revisionHash: string; payload: unknown };
export type ConsumerEvidenceCoverage = { policy: typeof CONSUMER_EVIDENCE_COVERAGE;
  subjects: Array<{ ref: string; revisionHash: string; ranges: Array<{ startByte: number; endByte: number; segmentIds: string[] }> }>; segmentIds: string[] };
export const consumerEvidenceStop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs for the same source/task and copy items[].ref or summary.consumerRevalidation.attempts[].ref once; use --inspect-execution. Source, range or manifest errors need host repair, not a guessed ID or unchanged retry. A completed negative review may use --compiler-correction consumer-evidence-coverage/v1 only when its original omitted reads and remaining allowance are proven; preserve every judgment, trace and charge. No parent resume or certification`);

/** Typed source spans/anchors at any nesting depth are navigation obligations,
 * never proof that the proposed facts follow from that text. Audit roster
 * inventories are background context, not a demand to reread the entire book. */
export function consumerEvidenceSubjects(input: { scope: { ref: string }; currentConsumer: { payload: unknown; revisionHash: string } }, artifacts: readonly ConsumerArtifact[]): EvidenceSubject[] {
  return [{ ref: input.scope.ref, ...input.currentConsumer }, ...artifacts.filter(a => a.evidenceRole !== "retained-role-roster")
    .map(a => ({ ref: artifactRef(a), revisionHash: a.revisionHash, payload: a.payload }))];
}

export function consumerEvidenceCoverage(sourceId: string, bytes: Uint8Array, segments: readonly EvidenceSegment[], subjects: readonly EvidenceSubject[]): ConsumerEvidenceCoverage {
  const buffer = Buffer.from(bytes), ordered = [...segments].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  const all = new Set<string>(), seen = new Set<string>();
  const segmentIds = new Set<string>(); let previousEnd = 0;
  for (const s of ordered) {
    if (!s.id || segmentIds.has(s.id) || !Number.isSafeInteger(s.startByte) || !Number.isSafeInteger(s.endByte)
      || s.startByte < previousEnd || s.endByte <= s.startByte || s.endByte > buffer.length
      || (buffer[s.startByte]! & 0xc0) === 0x80 || (buffer[s.endByte]! & 0xc0) === 0x80)
      throw consumerEvidenceStop("Source manifest has duplicate, overlapping or invalid evidence segments");
    segmentIds.add(s.id); previousEnd = s.endByte;
  }
  let lineStarts: number[] | undefined;
  const lines = () => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = 0; i < buffer.length; i++) if (buffer[i] === 10 || buffer[i] === 13) {
        if (buffer[i] === 13 && buffer[i + 1] === 10) i++;
        lineStarts.push(i + 1);
      }
    }
    return lineStarts;
  };
  const result: ConsumerEvidenceCoverage["subjects"] = [];
  for (const subject of subjects) {
    const key = `${subject.ref}:${subject.revisionHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ranges = new Map<string, ConsumerEvidenceCoverage["subjects"][number]["ranges"][number]>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const v = value as Record<string, unknown>;
      if ("sourceId" in v && ("startByte" in v || "endByte" in v || "startLine" in v || "endLine" in v)) {
        if (v.sourceId !== sourceId) throw consumerEvidenceStop(`Consumer evidence belongs to another source: ${subject.ref}`);
        let start = v.startByte, end = v.endByte;
        const byteBound = start !== undefined || end !== undefined;
        if (!byteBound) {
          const a = v.startLine, b = v.endLine;
          if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (a as number) < 1 || (b as number) < (a as number)
            || (b as number) > lines().length) throw consumerEvidenceStop(`Invalid consumer evidence line range: ${subject.ref}`);
          start = lines()[(a as number) - 1]; end = lines()[b as number] ?? buffer.length;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)
          || (end as number) > buffer.length || (buffer[start as number]! & 0xc0) === 0x80 || (buffer[end as number]! & 0xc0) === 0x80)
          throw consumerEvidenceStop(`Invalid consumer evidence byte range: ${subject.ref}`);
        // A legacy line-only reference selects full lines for navigation. Its
        // quote may be a substring; exact quote validation remains separate.
        if (byteBound && v.quoteHash !== undefined && v.quoteHash !== createHash("sha256").update(buffer.subarray(start as number, end as number)).digest("hex"))
          throw consumerEvidenceStop(`Consumer evidence quote hash changed: ${subject.ref}`);
        let cursor = start as number;
        const matching = ordered.filter(s => s.startByte < (end as number) && (start as number) < s.endByte);
        for (const s of matching) {
          if (!Number.isSafeInteger(s.startByte) || !Number.isSafeInteger(s.endByte) || s.startByte < 0 || s.endByte <= s.startByte
            || s.endByte > buffer.length || s.startByte > cursor || !s.id)
            throw consumerEvidenceStop(`Consumer evidence has a missing or invalid source segment: ${subject.ref}`);
          cursor = Math.max(cursor, s.endByte);
        }
        if (cursor < (end as number)) throw consumerEvidenceStop(`Consumer evidence is not fully covered by the source manifest: ${subject.ref}`);
        const segmentIds = matching.map(s => s.id); segmentIds.forEach(id => all.add(id));
        ranges.set(`${start}:${end}`, { startByte: start as number, endByte: end as number, segmentIds });
        return;
      }
      Object.values(v).forEach(visit);
    };
    visit(subject.payload);
    result.push({ ref: subject.ref, revisionHash: subject.revisionHash,
      ranges: [...ranges.values()].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte) });
  }
  return { policy: CONSUMER_EVIDENCE_COVERAGE, subjects: result.sort((a, b) => a.ref.localeCompare(b.ref)), segmentIds: [...all].sort() };
}

export function assertConsumerEvidenceRead(coverage: ConsumerEvidenceCoverage, sourceRead: ReadonlySet<string>) {
  const missing = coverage.segmentIds.filter(id => !sourceRead.has(id));
  if (missing.length) throw new Error(`CONSUMER_EVIDENCE_UNREAD: Referenced original text has not been read: ${JSON.stringify(missing)}. Call read_consumer_revalidation collection=source with these exact segmentIds, offset=0; read all of them in batches below 240000 bytes, then correct the preview once. Do not label unread text as absent or unsupported source. If discovery is needed, use the same source/task collection=source and copy items[].id; never guess IDs or retry unchanged. Host/scope/budget/consumed failures stop.`);
}

export const additionalConsumerEvidenceSubjects = (reads: ConsumerArtifactReadTracker) =>
  [...reads.subjects.values()].filter(s => s.evidenceRole !== "retained-role-roster");

export type ConsumerEvidenceMessage = { role: string; content?: any; toolName?: string; toolCallId?: string; isError?: boolean };
export type ConsumerReadRequest = { collection?: string; segmentIds?: string[]; refs?: string[] };
export const createConsumerEvidenceReads = () => ({ sourceIds: new Set<string>(), artifacts: new ConsumerArtifactReadTracker(), consumerRefs: new Set<string>() });
export type ConsumerEvidenceReads = ReturnType<typeof createConsumerEvidenceReads>;

/** The same receipt reduction serves live tools, verified journals and traces.
 * Only complete source/results count; ordered artifact pages accumulate until
 * their full revision is verified. Failed calls and discovery grant no reads. */
export function acceptConsumerEvidenceRead(reads: ConsumerEvidenceReads, request: ConsumerReadRequest, result: any,
  canonicalRef?: (ref: string) => string) {
  if (request.collection === "source" && request.segmentIds) {
    if (!Array.isArray(result.segments) || result.segments.length !== request.segmentIds.length
      || new Set(result.segments.map((s: { id: string }) => s.id)).size !== new Set(request.segmentIds).size)
      throw consumerEvidenceStop("A source read lost its complete requested segments");
    for (const s of result.segments) {
      if (s.complete !== true || !request.segmentIds.includes(s.id)) throw consumerEvidenceStop("A source read is incomplete or differs from its request");
      reads.sourceIds.add(s.id);
    }
  }
  if (request.collection === "artifacts" && request.refs) {
    if (!Array.isArray(result.items) || result.items.length !== request.refs.length)
      throw consumerEvidenceStop("An artifact read lost its requested results");
    for (const item of result.items) {
      if (canonicalRef && !request.refs.some(ref => canonicalRef(ref) === item.ref))
        throw consumerEvidenceStop("Consumer artifact response changed the requested dependency");
      reads.artifacts.accept(item);
    }
  }
  if (request.collection === "consumer" && request.refs) {
    if (!Array.isArray(result.items) || result.items.length !== request.refs.length
      || result.items.some((item: { ref: string }) => !request.refs!.includes(item.ref)))
      throw consumerEvidenceStop("A consumer read differs from its original request");
    result.items.forEach((item: { ref: string }) => reads.consumerRefs.add(item.ref));
  }
}

/** Replay only a journal whose owning session has been verified before it is
 * used for registration. A fresh provider continuation starts with empty reads. */
export function consumerEvidenceReads(messages: readonly ConsumerEvidenceMessage[], reads = createConsumerEvidenceReads(), canonicalRef?: (ref: string) => string) {
  const calls = new Map<string, ConsumerReadRequest>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall") calls.set(c.id, c.arguments);
    if (m.role !== "toolResult" || m.isError || m.toolName !== "read_consumer_revalidation") continue;
    const request = calls.get(m.toolCallId!), text = m.content?.find((c: any) => c.type === "text")?.text;
    if (!request || !text) throw consumerEvidenceStop("A completed consumer read lost its original request or result");
    acceptConsumerEvidenceRead(reads, request, JSON.parse(text), canonicalRef);
  }
  return reads;
}
