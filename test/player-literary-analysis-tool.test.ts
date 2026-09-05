import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  createPlayerLiteraryStyleAnalysisCaptureTool,
  createPlayerSceneDramaturgyAnalysisCaptureTool,
} from "../src/agent/player-literary-analysis-tool.js";

const style = {
  proseMode: "第二人称限知",
  syntax: ["长短句交替"],
  diction: ["克制具体"],
  cadence: "先缓后紧",
  dialogueHandling: "台词逐字落下",
  continuityCues: ["延续门槛意象"],
  avoid: ["事件摘要"],
};

const dramaturgy = {
  dramaticPressure: "问话已传出，回应仍未确定",
  beats: ["承接呼吸", "放下台词", "停在门后轻响"],
  sensoryAnchors: ["门缝里的风"],
  dialoguePlacement: "动作之后",
  continuityObligations: ["门仍关闭"],
  closingBeat: "门板后传来轻响",
  avoid: ["替对方回答"],
};

describe("literary specialist capture tools", () => {
  it("captures one bounded style proposal without any mutation capability", async () => {
    const capture = createPlayerLiteraryStyleAnalysisCaptureTool();
    const validator = Compile(capture.tool.parameters);
    expect(validator.Check(style)).toBe(true);
    expect(validator.Check({ ...style, worldDelta: { operations: [] } })).toBe(false);

    const result = await capture.tool.execute(
      "style-1",
      style as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(capture.getAnalysis()).toEqual(style);
    expect(result.content).toEqual([expect.objectContaining({
      type: "text",
      text: expect.stringContaining("private specialist call"),
    })]);
    await expect(capture.tool.execute(
      "style-2",
      style as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("Only one literary-style analysis");
  });

  it("captures one bounded dramaturgy proposal without accepting final prose", async () => {
    const capture = createPlayerSceneDramaturgyAnalysisCaptureTool();
    const validator = Compile(capture.tool.parameters);
    expect(validator.Check(dramaturgy)).toBe(true);
    expect(validator.Check({ ...dramaturgy, beats: ["only one"] })).toBe(false);
    expect(validator.Check({ ...dramaturgy, finalProse: "not allowed" })).toBe(false);

    await capture.tool.execute(
      "dramaturgy-1",
      dramaturgy as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(capture.getAnalysis()).toEqual(dramaturgy);
    expect(capture.getExecutionAttempts()).toBe(1);
  });
});
