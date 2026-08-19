import { describe, expect, it } from "vitest";
import { createPlayerSceneChoiceCaptureTool } from "../src/agent/player-scene-choice-tool.js";

describe("player scene choice capture tool", () => {
  it("captures concrete actor actions or dialogue and can reset between narration attempts", async () => {
    const capture = createPlayerSceneChoiceCaptureTool();
    const input = {
      choices: [
        { action: "走到门边，侧耳听外面的脚步声。" },
        { action: "对婶婶说：“我出去买本杂志，一会儿回来。”" },
      ],
    };

    await capture.tool.execute("choices-1", input, undefined, undefined, {} as never);
    expect(capture.getExecutionAttempts()).toBe(1);
    expect(capture.getChoices()).toEqual(input.choices);
    await expect(capture.tool.execute("choices-2", input, undefined, undefined, {} as never))
      .rejects.toThrow("Only one scene-choice set");
    expect(capture.getExecutionAttempts()).toBe(2);

    capture.reset();
    expect(capture.getExecutionAttempts()).toBe(0);
    await capture.tool.execute("choices-3", input, undefined, undefined, {} as never);
    expect(capture.getChoices()).toHaveLength(2);
  });

  it("enforces only structural size, shape, and distinctness independent of language", async () => {
    await expect(createPlayerSceneChoiceCaptureTool().tool.execute("choices-1", {
      choices: [{ action: "走到窗边看看。" }],
    }, undefined, undefined, {} as never)).rejects.toThrow();
    await expect(createPlayerSceneChoiceCaptureTool().tool.execute("choices-2", { choices: [] }, undefined, undefined, {} as never)).rejects.toThrow();
    const semanticCopy = createPlayerSceneChoiceCaptureTool();
    await expect(semanticCopy.tool.execute("choices-3", {
      choices: [
        { action: "离开原地寻找新接触点" },
        { action: "看看系统给了什么选项。" },
      ],
    }, undefined, undefined, {} as never)).resolves.toBeDefined();
    await expect(createPlayerSceneChoiceCaptureTool().tool.execute("choices-4", {
      choices: [
        { action: "观察门外的动静。" },
        { action: "观察门外的动静!" },
      ],
    }, undefined, undefined, {} as never)).rejects.toThrow("distinct");
    await expect(createPlayerSceneChoiceCaptureTool().tool.execute("choices-6", {
      choices: [
        { action: "走到门边听声音。", intent: "observe" },
        { action: "敲两下门板。", intent: "act" },
      ],
    }, undefined, undefined, {} as never)).rejects.toThrow("Unrecognized key");
    await expect(createPlayerSceneChoiceCaptureTool().tool.execute("choices-8", {
      choices: [
        { action: "我把与老唐之间现有的关系作为眼下要处理的事情，先确定一种符合当前处境的接触方式。" },
        { action: "我离开原地，到附近走动，并主动寻找能让当前局势产生变化的人、事或线索。" },
      ],
    }, undefined, undefined, {} as never)).resolves.toBeDefined();
  });
});
