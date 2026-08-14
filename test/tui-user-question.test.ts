import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTuiUserQuestion } from "../src/util/tui-user-question.js";

const options = Array.from({ length: 14 }, (_, index) => ({
  value: `character-${index + 1}`,
  label: `Character ${index + 1}`,
  description: `Playable character ${index + 1}`,
}));

describe("TUI user questions", () => {
  it("uses Pi's native scrolling window for long TUI selections", async () => {
    const rendered: string[][] = [];
    let renderRequests = 0;
    const ui = {
      custom(factory: (...args: unknown[]) => unknown) {
        return new Promise((resolve) => {
          const tui = {
            terminal: { rows: 16 },
            requestRender: () => { renderRequests += 1; },
          };
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const component = factory(tui, theme, {}, resolve) as {
            render(width: number): string[];
            handleInput(data: string): void;
          };
          rendered.push(component.render(100));
          for (let index = 0; index < 7; index += 1) component.handleInput("\x1b[B");
          rendered.push(component.render(100));
          component.handleInput("\r");
        });
      },
      notify: () => undefined,
    } as unknown as ExtensionUIContext;

    await expect(createTuiUserQuestion(ui)({
      header: "Character",
      question: "Who do you want to play?",
      options,
    })).resolves.toBe("character-8");
    expect(rendered[0]?.join("\n")).toContain("(1/15)");
    expect(rendered[0]?.join("\n")).not.toContain("Character 14");
    expect(rendered[1]?.join("\n")).toContain("Character 8");
    expect(renderRequests).toBe(8);
  });

  it("paginates when native custom TUI components are unavailable", async () => {
    const rendered: string[][] = [];
    const ui = {
      async select(_title: string, choices: string[]) {
        rendered.push(choices);
        if (rendered.length === 1) return choices.find((choice) => choice.startsWith("Next page"));
        return choices.find((choice) => choice.includes("Character 8 —"));
      },
      notify: () => undefined,
    } as unknown as ExtensionUIContext;

    await expect(createTuiUserQuestion(ui)({
      header: "Character",
      question: "Who do you want to play?",
      options,
    })).resolves.toBe("character-8");
    expect(rendered).toHaveLength(2);
    expect(Math.max(...rendered.map((choices) => choices.length))).toBeLessThanOrEqual(9);
  });

  it("opens filtering directly from the native selector with slash", async () => {
    let customCalls = 0;
    const ui = {
      custom(factory: (...args: unknown[]) => unknown) {
        customCalls += 1;
        return new Promise((resolve) => {
          const tui = { terminal: { rows: 16 }, requestRender: () => undefined };
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const component = factory(tui, theme, {}, resolve) as { handleInput(data: string): void };
          component.handleInput(customCalls === 1 ? "/" : "\r");
        });
      },
      async input() { return "character 14"; },
      notify: () => undefined,
    } as unknown as ExtensionUIContext;

    await expect(createTuiUserQuestion(ui)({
      header: "Character",
      question: "Who do you want to play?",
      options,
    })).resolves.toBe("character-14");
    expect(customCalls).toBe(2);
  });

  it("filters a long selection before choosing", async () => {
    let selects = 0;
    const ui = {
      async select(_title: string, choices: string[]) {
        selects += 1;
        if (selects === 1) return choices.find((choice) => choice.startsWith("Filter choices"));
        return choices.find((choice) => choice.includes("Character 14 —"));
      },
      async input() { return "character 14"; },
      notify: () => undefined,
    } as unknown as ExtensionUIContext;

    await expect(createTuiUserQuestion(ui)({
      header: "Character",
      question: "Who do you want to play?",
      options,
    })).resolves.toBe("character-14");
  });
});
