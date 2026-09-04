import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentStore, readSegmentText, segmentSource } from "../src/compiler/segments.js";
import type { SourceDocument } from "../src/storage/workspace-store.js";
import { promptJson } from "../src/util/prompt-data.js";

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
    expect(manifest.segmenterVersion).toBe(7);
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

  it("separates title front matter from a Chinese prologue before the first act", async () => {
    const { root, source } = await fixture("龙族\n作者：示例\n\n序幕 白帝城\n序幕中的事件。\n\n第一幕 卡塞尔之门\n主线开始。\n");
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.map((segment) => segment.title)).toEqual([
      "龙族",
      "序幕 白帝城",
      "第一幕 卡塞尔之门",
    ]);
    expect(await readSegmentText(root, manifest.segments[1]!)).toContain("序幕中的事件");
  });

  it.each(["序言", "前言", "引子", "Preface"])("recognizes %s as a prologue boundary", async (heading) => {
    const { root, source } = await fixture(`书名\n作者\n\n${heading}\n开篇上下文。\n\n第一章 正文\n故事开始。\n`);
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.map((segment) => segment.title)).toEqual([
      "书名",
      heading,
      "第一章 正文",
    ]);
  });

  it("detects source mutation after ingest before producing evidence spans", async () => {
    const { root, source } = await fixture("Chapter 1\nOriginal\n");
    await fs.writeFile(path.join(root, source.sourcePath), "Chapter 1\nChanged\n", "utf8");
    await expect(segmentSource(root, source)).rejects.toThrow("changed after ingest");
  });

  it("falls back to bounded blocks when no structural headings exist", async () => {
    const paragraphs = Array.from({ length: 2_400 }, (_, index) => `line ${index + 1}`).join("\n");
    const { root, source } = await fixture(paragraphs);
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.length).toBeGreaterThan(1);
    expect(manifest.segments.every((segment) => segment.kind === "block")).toBe(true);
    expect(manifest.segments.every((segment) => segment.endLine - segment.startLine + 1 <= 1_000)).toBe(true);
  });

  it("splits one physical line by both UTF-8 bytes and escaped prompt size without losing bytes", async () => {
    const { root, source, buffer } = await fixture(`<${"界".repeat(40_000)}>${"<".repeat(40_000)}`);
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.length).toBeGreaterThan(2);
    const pieces: Buffer[] = [];
    for (const segment of manifest.segments) {
      const text = await readSegmentText(root, segment);
      pieces.push(Buffer.from(text, "utf8"));
      expect(promptJson(text).length).toBeLessThanOrEqual(48 * 1024 + 2);
      expect(segment.startLine).toBe(1);
      expect(segment.endLine).toBe(1);
    }
    expect(Buffer.concat(pieces)).toEqual(buffer);
  });

  it("rejects a manifest whose nested segment crosses the source boundary", async () => {
    const { root, source } = await fixture("Chapter 1\nOriginal\n");
    const manifest = await segmentSource(root, source);
    const first = manifest.segments[0]!;
    await expect(new SegmentStore(root).write({
      ...manifest,
      segments: [{ ...first, sourceId: "foreign-source" }],
    })).rejects.toThrow("segment sourceId must equal manifest sourceId");
  });

  it("rejects reordered ordinals and overlapping byte ranges in persisted manifests", async () => {
    const { root, source } = await fixture("Preface\n\nChapter 1\nFirst.\n\nChapter 2\nSecond.\n");
    const manifest = await segmentSource(root, source);
    expect(manifest.segments.length).toBeGreaterThan(1);
    const [first, second] = manifest.segments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await expect(new SegmentStore(root).write({
      ...manifest,
      segments: manifest.segments.map((segment, index) => (
        index === 0 ? { ...segment, ordinal: 1 } : index === 1 ? { ...segment, ordinal: 0 } : segment
      )),
    })).rejects.toThrow("segment ordinal must match its manifest position");

    const overlappingStart = first!.endByte - 1;
    await expect(new SegmentStore(root).write({
      ...manifest,
      segments: manifest.segments.map((segment, index) => index === 1 ? {
        ...segment,
        startByte: overlappingStart,
        bytes: segment.endByte - overlappingStart,
      } : segment),
    })).rejects.toThrow("segment byte ranges must be monotonic and non-overlapping");
  });

  it("refuses to read a hash-shaped segment range beyond the immutable source", async () => {
    const { root, source } = await fixture("Chapter 1\nOriginal\n");
    const manifest = await segmentSource(root, source);
    const first = manifest.segments[0]!;
    await expect(readSegmentText(root, {
      ...first,
      endByte: source.bytes + 1,
      bytes: source.bytes + 1 - first.startByte,
    })).rejects.toThrow("is outside source length");
  });
});
