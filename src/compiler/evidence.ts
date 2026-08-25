import crypto from "node:crypto";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import type { Entity, EvidenceRef, SourceSpan, ValidationIssue } from "../world/model.js";

export type EvidenceVerification = {
  valid: boolean;
  issues: ValidationIssue[];
};

export type EvidenceInspection = EvidenceVerification & {
  excerpts: string[];
};

type CachedSource = {
  source: SourceDocument;
  buffer: Buffer;
  lines: Array<{ startByte: number; endByte: number }>;
};

export class EvidenceVerifier {
  private cache?: Map<string, CachedSource>;
  private sourceErrors?: Map<string, string>;

  constructor(private readonly workspaceRoot: string) {}

  async verifyAll(evidence: readonly EvidenceRef[]): Promise<EvidenceVerification> {
    const { excerpts: _excerpts, ...verification } = await this.inspectAll(evidence);
    return verification;
  }

  async inspectAll(evidence: readonly EvidenceRef[]): Promise<EvidenceInspection> {
    const issues: ValidationIssue[] = [];
    const excerpts: string[] = [];
    for (let index = 0; index < evidence.length; index += 1) {
      const result = await this.inspectCached(evidence[index]!);
      for (const issue of result.issues) issues.push({ ...issue, path: issue.path ? `evidence.${index}.${issue.path}` : `evidence.${index}` });
      if (result.excerpt !== undefined) excerpts.push(result.excerpt);
    }
    return { valid: issues.length === 0, issues, excerpts };
  }

  async verify(reference: EvidenceRef): Promise<EvidenceVerification> {
    const { excerpt: _excerpt, ...verification } = await this.inspect(reference);
    return verification;
  }

  async inspect(reference: EvidenceRef): Promise<EvidenceVerification & { excerpt?: string }> {
    return this.inspectCached(reference);
  }

  clearCache(): void {
    this.cache = undefined;
    this.sourceErrors = undefined;
  }

  private async inspectCached(reference: EvidenceRef): Promise<EvidenceVerification & { excerpt?: string }> {
    const span = reference.span;
    const cached = await this.getSource(span.sourceId);
    if (!cached) {
      const sourceError = this.sourceErrors?.get(span.sourceId);
      return {
        valid: false,
        issues: [issue(
          sourceError ? "EVIDENCE_SOURCE_MISSING" : "UNKNOWN_EVIDENCE_SOURCE",
          sourceError ?? `Evidence source ${span.sourceId} is not ingested`,
        )],
      };
    }
    const currentHash = sha256(cached.buffer);
    if (currentHash !== cached.source.contentSha256) {
      return {
        valid: false,
        issues: [issue("EVIDENCE_SOURCE_CHANGED", `Source ${cached.source.sourcePath} changed after ingest; expected ${cached.source.contentSha256}, found ${currentHash}`)],
      };
    }
    if (span.startLine > cached.lines.length || span.endLine > cached.lines.length) {
      return { valid: false, issues: [issue("EVIDENCE_LINE_RANGE", `Evidence lines ${span.startLine}-${span.endLine} exceed ${cached.lines.length} lines`)] };
    }

    const lineStart = cached.lines[span.startLine - 1]?.startByte ?? 0;
    const lineEnd = cached.lines[span.endLine - 1]?.endByte ?? lineStart;
    const hasStart = span.startByte !== undefined;
    const hasEnd = span.endByte !== undefined;
    if (hasStart !== hasEnd) {
      return { valid: false, issues: [issue("EVIDENCE_BYTE_RANGE", "startByte and endByte must be supplied together")] };
    }
    const startByte = span.startByte ?? lineStart;
    const endByte = span.endByte ?? lineEnd;
    if (startByte < lineStart || endByte > lineEnd || endByte < startByte || endByte > cached.buffer.byteLength) {
      return {
        valid: false,
        issues: [issue("EVIDENCE_BYTE_RANGE", `Evidence bytes ${startByte}-${endByte} are outside declared line range ${lineStart}-${lineEnd}`)],
      };
    }
    const actualHash = sha256(cached.buffer.subarray(startByte, endByte));
    if (actualHash !== span.quoteHash) {
      return {
        valid: false,
        issues: [issue("EVIDENCE_HASH_MISMATCH", `Evidence hash mismatch; provided ${span.quoteHash}, computed ${actualHash}`)],
      };
    }
    return { valid: true, issues: [], excerpt: cached.buffer.subarray(startByte, endByte).toString("utf8") };
  }

  private async getSource(sourceId: string): Promise<CachedSource | undefined> {
    if (!this.cache) await this.loadSources();
    let cached = this.cache!.get(sourceId);
    if (!cached) {
      await this.loadSources();
      cached = this.cache!.get(sourceId);
    }
    return cached;
  }

  private async loadSources(): Promise<void> {
    const store = await WorkspaceStore.create(this.workspaceRoot);
    const sources = await store.listSources();
    this.cache = new Map();
    this.sourceErrors = new Map();
    for (const source of sources) {
      try {
        const buffer = await readSourceMaterial(this.workspaceRoot, source);
        this.cache.set(source.id, { source, buffer, lines: lineRanges(buffer.toString("utf8")) });
      } catch (error) {
        this.sourceErrors.set(source.id, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

export function validateEntityNameEvidence(entity: Entity, excerpts: readonly string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!excerpts.some((excerpt) => containsEvidenceName(excerpt, entity.canonicalName, entity.kind === "character"))) {
    issues.push({
      code: "UNSUPPORTED_ENTITY_CANONICAL_NAME",
      message: `Entity ${entity.id} canonical name '${entity.canonicalName}' does not occur in its verified source evidence`,
      path: "canonicalName",
    });
  }
  entity.aliases.forEach((alias, index) => {
    if (excerpts.some((excerpt) => containsEvidenceName(excerpt, alias, false))) return;
    issues.push({
      code: "UNSUPPORTED_ENTITY_ALIAS",
      message: `Entity ${entity.id} alias '${alias}' does not occur in its verified source evidence`,
      path: `aliases.${index}`,
    });
  });
  return issues;
}

function containsEvidenceName(excerpt: string, name: string, allowExplicitPersonalName = false): boolean {
  const haystack = excerpt.normalize("NFKC").toLowerCase();
  const needle = name.normalize("NFKC").toLowerCase();
  if (!needle) return false;
  const asciiWord = /[a-z0-9]/i;
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = offset > 0 ? haystack[offset - 1] : undefined;
    const after = haystack[offset + needle.length];
    const startBound = !asciiWord.test(needle[0]!) || before === undefined || !asciiWord.test(before);
    const endBound = !asciiWord.test(needle.at(-1)!) || after === undefined || !asciiWord.test(after);
    if (startBound && endBound) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return allowExplicitPersonalName && containsExplicitChinesePersonalName(haystack, needle);
}

function containsExplicitChinesePersonalName(excerpt: string, name: string): boolean {
  if (!/^\p{Script=Han}{2,4}$/u.test(name)) return false;
  for (const surnameLength of [1, 2]) {
    if (surnameLength >= name.length) continue;
    const surname = escapeRegExp(name.slice(0, surnameLength));
    const givenName = escapeRegExp(name.slice(surnameLength));
    const pattern = new RegExp(`(?:复姓|覆姓|姓)\\s*${surname}\\s*[，,、；;：:\\s]*名\\s*${givenName}`, "u");
    if (pattern.test(excerpt)) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineRanges(text: string): Array<{ startByte: number; endByte: number }> {
  const ranges: Array<{ startByte: number; endByte: number }> = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  let offset = 0;
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1] ?? "";
    const eol = match[2] ?? "";
    if (!body && !eol && match.index === text.length) break;
    const bytes = Buffer.byteLength(body + eol, "utf8");
    ranges.push({ startByte: offset, endByte: offset + bytes });
    offset += bytes;
    if (!eol) break;
  }
  if (!ranges.length) ranges.push({ startByte: 0, endByte: 0 });
  return ranges;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function issue(code: string, message: string): ValidationIssue {
  return { code, message };
}
