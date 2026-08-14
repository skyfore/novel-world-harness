import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isFreshConversation, NWH_WORKING_FRAMES, renderNwhWelcome } from "../src/agent/nwh-welcome.js";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as Pick<Theme, "bold" | "fg">;

describe("NWH welcome header", () => {
  it("gives a fresh user three lightweight next steps", () => {
    const lines = renderNwhWelcome(theme, { mode: "assistant", freshConversation: true }, 0, 100);
    const output = lines.join("\n");

    expect(output).toContain("(o,o)");
    expect(output).toContain("/login");
    expect(output).toContain("/model");
    expect(output).toContain("novel path");
    expect(output).toContain("/instances");
    expect(output).toContain("/play");
  });

  it("uses a shorter message for an existing conversation and narrow terminals", () => {
    const lines = renderNwhWelcome(theme, { mode: "assistant", freshConversation: false }, 2, 40);

    expect(lines.join("\n")).toContain("(-,-)");
    expect(lines.join("\n")).toContain("Welcome back");
    expect(lines).toHaveLength(3);
  });

  it("keeps compiler-mode onboarding focused on evidence batches", () => {
    const output = renderNwhWelcome(theme, { mode: "compiler", freshConversation: true }, 0, 100).join("\n");

    expect(output).toContain("/compile-next");
    expect(output).not.toContain("/play <character>");
  });

  it("uses the mascot as the working animation", () => {
    expect(NWH_WORKING_FRAMES).toEqual(["(o,o)", "(O,o)", "(o,O)", "(o,o)"]);
  });

  it("ignores startup metadata when deciding whether onboarding is needed", () => {
    expect(isFreshConversation([
      { type: "model_change" },
      { type: "thinking_level_change" },
    ])).toBe(true);
    expect(isFreshConversation([
      { type: "model_change" },
      { type: "message", message: { role: "user" } },
    ])).toBe(false);
  });
});
