import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentStore, readSegmentText, segmentSource } from "../src/compiler/segments.js";
import type { SourceDocument } from "../src/storage/workspace-store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(content: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-segments-"));
  roots.push(root);
  const sourcePath = "book.txt";
  const absolute = path.join(root, sourcePath);
  const buffer = Buffer.from(content, "utf8");
  await fs.writeFile(absolute, buffer);
  const source: SourceDocument = {
    version: 1,
    id: crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 20),
    title: "book.txt",
    sourcePath,
    contentSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.byteLength,
    registeredAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return { root, source, buffer };
}

describe("source segmentation", () => {
  it("uses chapter headings while preserving exact CRLF byte slices", async () => {
    const { root, source, buffer } = await fixture("序言\r\n第一章 开端\r\n曹操进入大厅。\r\n\r\n第二章 转折\r\n曹操离开。\r\n");
    const manifest = await segmentSource(root, source);
    expect(manifest.segmenterVersion).toBe(2);
    expect(manifest.segments.length).toBeGreaterThanOrEqual(3);
    expect(manifest.segments.some((segment) => segment.title?.startsWith("第一章"))).toBe(true);
    expect(manifest.segments.some((segment) => segment.title?.startsWith("第二章"))).toBe(true);
    for (const segment of manifest.segments) {
      const text = await readSegmentText(root, segment);
      expect(Buffer.from(text, "utf8")).toEqual(buffer.subarray(segment.startByte, segment.endByte));
      expect(segment.startLine).toBeLessThanOrEqual(segment.endLine);
    }
    await new SegmentStore(root).write(manifest);
    await expect(new SegmentStore(root).readManifest(source.id)).resolves.toEqual(manifest);
  });

  it("recognizes Chinese act headings with punctuation as structural sections", async () => {
    const { root, source } = await fixture("标题\n\n第一幕：开端\n人物登场。\n\n第二幕：转折\n人物行动。\n");
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.map((segment) => segment.title)).toEqual([
      "标题",
      "第一幕：开端",
      "第二幕：转折",
    ]);
  });

  it("detects source mutation after ingest before producing evidence spans", async () => {
    const { root, source } = await fixture("Chapter 1\nOriginal\n");
    await fs.writeFile(path.join(root, source.sourcePath), "Chapter 1\nChanged\n", "utf8");
    await expect(segmentSource(root, source)).rejects.toThrow("changed after ingest");
  });

  it("falls back to bounded blocks when no structural headings exist", async () => {
    const paragraphs = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");
    const { root, source } = await fixture(paragraphs);
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.length).toBeGreaterThan(1);
    expect(manifest.segments.every((segment) => segment.kind === "block")).toBe(true);
    expect(manifest.segments.every((segment) => segment.endLine - segment.startLine + 1 <= 160)).toBe(true);
  });
});
