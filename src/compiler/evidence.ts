import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import type { EvidenceRef, SourceSpan, ValidationIssue } from "../world/model.js";

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

  constructor(private readonly workspaceRoot: string) {}

  async verifyAll(evidence: readonly EvidenceRef[]): Promise<EvidenceVerification> {
    const { excerpts: _excerpts, ...verification } = await this.inspectAll(evidence);
    return verification;
  }

  async inspectAll(evidence: readonly EvidenceRef[]): Promise<EvidenceInspection> {
    this.cache = undefined;
    const issues: ValidationIssue[] = [];
    const excerpts: string[] = [];
    try {
      for (let index = 0; index < evidence.length; index += 1) {
        const result = await this.inspectCached(evidence[index]!);
        for (const issue of result.issues) issues.push({ ...issue, path: issue.path ? `evidence.${index}.${issue.path}` : `evidence.${index}` });
        if (result.excerpt !== undefined) excerpts.push(result.excerpt);
      }
      return { valid: issues.length === 0, issues, excerpts };
    } finally {
      this.cache = undefined;
    }
  }

  async verify(reference: EvidenceRef): Promise<EvidenceVerification> {
    const { excerpt: _excerpt, ...verification } = await this.inspect(reference);
    return verification;
  }

  async inspect(reference: EvidenceRef): Promise<EvidenceVerification & { excerpt?: string }> {
    this.cache = undefined;
    try {
      return await this.inspectCached(reference);
    } finally {
      this.cache = undefined;
    }
  }

  private async inspectCached(reference: EvidenceRef): Promise<EvidenceVerification & { excerpt?: string }> {
    const span = reference.span;
    const cached = await this.getSource(span.sourceId);
    if (!cached) {
      return { valid: false, issues: [issue("UNKNOWN_EVIDENCE_SOURCE", `Evidence source ${span.sourceId} is not ingested`)] };
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
        issues: [issue("EVIDENCE_HASH_MISMATCH", `Evidence hash mismatch; expected ${span.quoteHash}, found ${actualHash}`)],
      };
    }
    return { valid: true, issues: [], excerpt: cached.buffer.subarray(startByte, endByte).toString("utf8") };
  }

  private async getSource(sourceId: string): Promise<CachedSource | undefined> {
    if (!this.cache) {
      const store = await WorkspaceStore.create(this.workspaceRoot);
      const sources = await store.listSources();
      this.cache = new Map();
      for (const source of sources) {
        const absolute = path.resolve(this.workspaceRoot, source.sourcePath);
        const relative = path.relative(this.workspaceRoot, absolute);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const buffer = await fs.readFile(absolute);
        this.cache.set(source.id, { source, buffer, lines: lineRanges(buffer.toString("utf8")) });
      }
    }
    return this.cache.get(sourceId);
  }
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
