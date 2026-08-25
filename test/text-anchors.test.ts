import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceVerifier } from "../src/compiler/evidence.js";
import { resolveTextAnchor } from "../src/compiler/text-anchors.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("host-resolved text anchors", () => {
  it("computes UTF-8 byte offsets, line ranges, and context hashes from archived source bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-text-anchor-utf8-"));
    roots.push(root);
    const content = "序章\n曹操，字孟德。\n众人肃立。\n";
    const fixture = await createEvidenceFixture(root, content);
    const segment = (await new SegmentStore(root).list(fixture.source.id))[0]!;

    const anchor = await resolveTextAnchor(root, segment, {
      segment_id: segment.id,
      exact: "曹操，字孟德",
      target_path: "/canonicalName",
      relation: "supports",
      strength: "explicit",
    });

    expect(anchor).toMatchObject({
      sourceId: fixture.source.id,
      startByte: Buffer.byteLength("序章\n", "utf8"),
      endByte: Buffer.byteLength("序章\n曹操，字孟德", "utf8"),
      startLine: 2,
      endLine: 2,
      contextBytes: 64,
      normalization: "source-bytes-v1",
    });
    await expect(new EvidenceVerifier(root).inspectAnchor(anchor)).resolves.toMatchObject({
      valid: true,
      issues: [],
      excerpt: "曹操，字孟德",
    });
  });

  it("rejects repeated quotes unless prefix, suffix, or occurrence disambiguates them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-text-anchor-duplicate-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "甲说：“去。”\n乙说：“去。”\n");
    const segment = (await new SegmentStore(root).list(fixture.source.id))[0]!;
    const selector = {
      segment_id: segment.id,
      exact: "去",
      target_path: "/title",
      relation: "supports" as const,
      strength: "explicit" as const,
    };

    await expect(resolveTextAnchor(root, segment, selector)).rejects.toThrow("ambiguous");
    await expect(resolveTextAnchor(root, segment, { ...selector, prefix: "甲说：“" }))
      .resolves.toMatchObject({ startLine: 1 });
    await expect(resolveTextAnchor(root, segment, { ...selector, occurrence: 2 }))
      .resolves.toMatchObject({ startLine: 2 });
  });

  it("invalidates an anchor when the immutable archived source bytes are corrupted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-text-anchor-corrupt-"));
    roots.push(root);
    const original = "AnchorCorruptionUnique-20260825 enters.\n";
    const fixture = await createEvidenceFixture(root, original);
    const segment = (await new SegmentStore(root).list(fixture.source.id))[0]!;
    const anchor = await resolveTextAnchor(root, segment, {
      segment_id: segment.id,
      exact: "AnchorCorruptionUnique-20260825 enters",
      target_path: "/canonicalName",
      relation: "supports",
      strength: "explicit",
    });
    const archived = path.join(
      new SourceMaterialStore().root,
      fixture.source.contentSha256,
      "source.utf8",
    );
    await fs.chmod(archived, 0o600);
    await fs.writeFile(archived, "AnchorCorruptionUnique-20260825 leaves.\n", "utf8");

    const inspected = await new EvidenceVerifier(root).inspectAnchor(anchor);
    expect(inspected.valid).toBe(false);
    expect(inspected.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_SOURCE_MISSING" }),
    ]));
  });
});
