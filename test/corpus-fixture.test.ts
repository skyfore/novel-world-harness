import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const THREE_KINGDOMS = new URL("../fixtures/corpus/三国演义.txt", import.meta.url);
const EXPECTED_SHA256 = "91303f95c1522556bac9420b8c5dc0efdd09a438b636f05a214e296b9bb38027";

describe("long-form corpus fixture", () => {
  it("preserves the checked-in Three Kingdoms source bytes and chapter shape", async () => {
    const source = await fs.readFile(THREE_KINGDOMS);
    const text = source.toString("utf8");
    const chapterHeadings = text.match(/^第[^\r\n]{1,12}回/gmu) ?? [];

    expect(source.byteLength).toBe(1_785_397);
    expect(createHash("sha256").update(source).digest("hex")).toBe(EXPECTED_SHA256);
    expect(chapterHeadings).toHaveLength(120);
  });
});
