import { describe, expect, it } from "vitest";
import { createPlayerSceneChoiceCaptureTool } from "../src/agent/player-scene-choice-tool.js";
import { defaultPlayerSceneChoices } from "../src/agent/pi-player-opening.js";

describe("player scene choice capture tool", () => {
  it("captures only bounded suggested utterances and can reset between narration attempts", async () => {
    const capture = createPlayerSceneChoiceCaptureTool();
    const input = {
      choices: [
        { label: "观察四周", description: "确认眼前的动静。", action: "我先仔细观察四周。" },
        { label: "整理思绪", description: "回想自己已经知道的事。", action: "我先整理此刻掌握的线索。" },
      ],
    };

    await capture.tool.execute("choices-1", input, undefined, undefined, {} as never);
    expect(capture.getChoices()).toEqual(input.choices);
    await expect(capture.tool.execute("choices-2", input, undefined, undefined, {} as never))
      .rejects.toThrow("Only one scene-choice set");

    capture.reset();
    await capture.tool.execute("choices-3", input, undefined, undefined, {} as never);
    expect(capture.getChoices()).toHaveLength(2);
  });

  it("rejects an undersized choice set and supplies bounded host defaults", async () => {
    const capture = createPlayerSceneChoiceCaptureTool();
    await expect(capture.tool.execute("choices-1", {
      choices: [{ label: "观察", description: "看看四周。", action: "我先观察四周。" }],
    }, undefined, undefined, {} as never)).rejects.toThrow();

    expect(defaultPlayerSceneChoices()).toHaveLength(3);
    expect(defaultPlayerSceneChoices().every((choice) => choice.action.length > 0)).toBe(true);
  });
});
