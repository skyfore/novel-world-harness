import { describe, expect, it } from "vitest";
import { styleNwhThinkingMarkdown } from "../src/agent/nwh-tui-style.js";

describe("NWH TUI transcript styling", () => {
  it("puts thinking in a labeled quote without changing assistant answers", () => {
    expect(styleNwhThinkingMarkdown("inspect evidence\nthen validate", {
      messageType: "assistant-thinking",
      isStreaming: false,
      availableWidth: 80,
    })).toBe("> **Thinking** · Ctrl+O toggles details\n>\n> inspect evidence\n> then validate");

    expect(styleNwhThinkingMarkdown("Committed answer", {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 80,
    })).toBe("Committed answer");
  });

  it("marks a streaming thinking block as active", () => {
    expect(styleNwhThinkingMarkdown("working", {
      messageType: "assistant-thinking",
      isStreaming: true,
      availableWidth: 80,
    })).toContain("**Thinking…**");
  });
});
