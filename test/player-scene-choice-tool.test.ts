import { describe, expect, it } from "vitest";
import { createPlayerSceneChoiceCaptureTool } from "../src/agent/player-scene-choice-tool.js";
import { bindPlayerSceneChoices, defaultPlayerSceneChoices } from "../src/agent/pi-player-opening.js";
import type { PlayerAffordance } from "../src/world/narrative-director.js";

describe("player scene choice capture tool", () => {
  it("captures only bounded suggested utterances and can reset between narration attempts", async () => {
    const capture = createPlayerSceneChoiceCaptureTool();
    const input = {
      choices: [
        { affordanceId: "aff-observe", label: "观察四周", description: "确认眼前的动静。", action: "我先仔细观察四周。" },
        { affordanceId: "aff-plan", label: "整理思绪", description: "回想自己已经知道的事。", action: "我先整理此刻掌握的线索。" },
      ],
    };

    await capture.tool.execute("choices-1", input, undefined, undefined, {} as never);
    expect(capture.getChoices()).toEqual(input.choices.map((choice) => ({ ...choice, intent: "act", recommended: false })));
    await expect(capture.tool.execute("choices-2", input, undefined, undefined, {} as never))
      .rejects.toThrow("Only one scene-choice set");

    capture.reset();
    await capture.tool.execute("choices-3", input, undefined, undefined, {} as never);
    expect(capture.getChoices()).toHaveLength(2);
  });

  it("allows one recovery choice, rejects an empty set, and binds only host affordances", async () => {
    const capture = createPlayerSceneChoiceCaptureTool();
    await capture.tool.execute("choices-1", {
      choices: [{ affordanceId: "aff-open", label: "观察", description: "看看四周。", action: "我先观察四周。" }],
    }, undefined, undefined, {} as never);
    expect(capture.getChoices()).toHaveLength(1);
    capture.reset();
    await expect(capture.tool.execute("choices-2", { choices: [] }, undefined, undefined, {} as never)).rejects.toThrow();

    const affordances: PlayerAffordance[] = [
      { id: "aff-open", label: "开门", description: "试着打开门。", action: "我试着打开门。", intent: "act", progressChannels: ["scene"], threadIds: ["thread-a"], recommended: true },
      { id: "aff-knock", label: "敲门", description: "先敲一敲门。", action: "我先敲门。", intent: "act", progressChannels: ["consequence"], threadIds: ["thread-a"], recommended: false },
    ];
    expect(defaultPlayerSceneChoices()).toEqual([]);
    expect(defaultPlayerSceneChoices(affordances)).toHaveLength(2);
    expect(bindPlayerSceneChoices([
      { affordanceId: "aff-knock", label: "篡改", description: "篡改", action: "篡改", intent: "wait", recommended: true },
    ], affordances)).toEqual([
      expect.objectContaining({ affordanceId: "aff-knock", label: "敲门", intent: "act", recommended: false }),
      expect.objectContaining({ affordanceId: "aff-open", label: "开门", recommended: true }),
    ]);
  });
});
