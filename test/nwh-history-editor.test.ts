import { describe, expect, it } from "vitest";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { NwhHistoryEditor } from "../src/agent/nwh-history-editor.js";

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
});
