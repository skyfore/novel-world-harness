import { describe, expect, it } from "vitest";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { NwhHistoryEditor } from "../src/agent/nwh-history-editor.js";

function actionKeybindings(bindings: Record<string, string>): KeybindingsManager {
  return {
    matches: (data: string, action: string) => bindings[action] === data,
  } as unknown as KeybindingsManager;
}

describe("NWH prompt history editor", () => {
  it("recalls submitted commands with up/down and restores the draft", () => {
    const editor = new NwhHistoryEditor(
      { requestRender() {} } as unknown as TUI,
      { borderColor: (text) => text, selectList: {} } as unknown as EditorTheme,
      { matches: () => false } as unknown as KeybindingsManager,
      ["/novels", "/reparse --chapters 2,37"],
    );

    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("/reparse --chapters 2,37");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("/novels");
    editor.handleInput("\x1b[B");
    expect(editor.getText()).toBe("/reparse --chapters 2,37");
    editor.handleInput("\x1b[B");
    expect(editor.getText()).toBe("");
  });

  it("keeps only one copy of consecutive duplicate commands", () => {
    const editor = new NwhHistoryEditor(
      { requestRender() {} } as unknown as TUI,
      { borderColor: (text) => text, selectList: {} } as unknown as EditorTheme,
      { matches: () => false } as unknown as KeybindingsManager,
    );
    editor.addToHistory("/status");
    editor.addToHistory("/status");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("/status");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("/status");
  });

  it("uses the tool expansion key as a unified details toggle", () => {
    const editor = new NwhHistoryEditor(
      { requestRender() {} } as unknown as TUI,
      { borderColor: (text) => text, selectList: {} } as unknown as EditorTheme,
      actionKeybindings({
        "app.tools.expand": "ctrl+o",
        "app.thinking.toggle": "ctrl+t",
      }),
    );
    let toolToggles = 0;
    let thinkingToggles = 0;
    editor.onAction("app.tools.expand", () => { toolToggles += 1; });
    editor.onAction("app.thinking.toggle", () => { thinkingToggles += 1; });

    editor.handleInput("ctrl+o");
    expect({ toolToggles, thinkingToggles }).toEqual({ toolToggles: 1, thinkingToggles: 0 });
    editor.handleInput("ctrl+o");
    expect({ toolToggles, thinkingToggles }).toEqual({ toolToggles: 2, thinkingToggles: 1 });
  });

  it("keeps the reasoning-only key independent and resynchronizes details", () => {
    const editor = new NwhHistoryEditor(
      { requestRender() {} } as unknown as TUI,
      { borderColor: (text) => text, selectList: {} } as unknown as EditorTheme,
      actionKeybindings({
        "app.tools.expand": "ctrl+o",
        "app.thinking.toggle": "ctrl+t",
      }),
    );
    let toolToggles = 0;
    let thinkingToggles = 0;
    editor.onAction("app.tools.expand", () => { toolToggles += 1; });
    editor.onAction("app.thinking.toggle", () => { thinkingToggles += 1; });

    editor.handleInput("ctrl+t");
    editor.handleInput("ctrl+o");
    expect({ toolToggles, thinkingToggles }).toEqual({ toolToggles: 1, thinkingToggles: 2 });
  });
});
