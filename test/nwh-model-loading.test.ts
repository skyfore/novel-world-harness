import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseNwhModelLoadingMessage,
  createNwhModelLoadingIndicator,
} from "../src/agent/nwh-model-loading.js";

afterEach(() => vi.useRealTimers());

describe("model loading indicator", () => {
  it("chooses bounded random copy without immediately repeating it", () => {
    const first = chooseNwhModelLoadingMessage("waiting", () => 0);
    const second = chooseNwhModelLoadingMessage("waiting", () => 0, first);

    expect(first).not.toBe(second);
  });

  it("animates the NWH pet above the editor throughout the model lifecycle", () => {
    vi.useFakeTimers();
    const widgets: Array<{ content: string[] | undefined; placement?: string }> = [];
    const ui = {
      setWidget: (_key: string, content: string[] | undefined, options?: { placement?: string }) => {
        widgets.push({ content, placement: options?.placement });
      },
      theme: {
        fg: (_color: string, text: string) => text,
      },
    } as unknown as Pick<ExtensionContext["ui"], "setWidget" | "theme">;
    const indicator = createNwhModelLoadingIndicator(ui, {
      random: () => 0,
      intervalMs: 180,
      messageTicks: 2,
    });

    expect(widgets.at(-1)).toMatchObject({ placement: "aboveEditor" });
    expect(widgets.at(-1)?.content?.[0]).toContain("(o,o)");
    expect(widgets.at(-1)?.content?.[0]).toContain("模型正在思考");

    vi.advanceTimersByTime(180);
    expect(widgets.at(-1)?.content?.[0]).toContain("(O,o)");

    indicator.setPhase("streaming");
    expect(widgets.at(-1)?.content?.[0]).toContain("模型正在输出");
    expect(widgets.at(-1)?.content?.[0]).toContain("Esc 可中止");

    indicator.stop();
    expect(widgets.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });
  });
});
