import { describe, expect, it } from "vitest";
import {
  inferredTitleOccursInEvidence,
  normalizeModelInferredNovelTitle,
  novelTitleIdStem,
} from "../src/storage/novel-title.js";

describe("model-inferred novel titles", () => {
  it("normalizes a title selected semantically by the model without parsing source layout", () => {
    expect(normalizeModelInferredNovelTitle("  The   Second\nChronicle  ")).toBe("The Second Chronicle");
    expect(() => normalizeModelInferredNovelTitle("Unsafe\u200bTitle")).toThrow("safe display line");
  });

  it("leaves title-vs-author semantics to the model while enforcing source containment", () => {
    expect(inferredTitleOccursInEvidence("活着", "《活着》\n作者：余华")).toBe(true);
    expect(inferredTitleOccursInEvidence("余华", "《活着》\n作者：余华")).toBe(true);
    expect(inferredTitleOccursInEvidence("许三观卖血记", "《活着》\n作者：余华")).toBe(false);
  });

  it("builds ASCII-safe branch stems only after a title has been accepted", () => {
    expect(novelTitleIdStem("The Second Chronicle")).toBe("the-second-chronicle");
    expect(novelTitleIdStem("活着")).toBe("");
  });
});
