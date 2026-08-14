import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTuiUserQuestion } from "../src/util/tui-user-question.js";

const options = Array.from({ length: 14 }, (_, index) => ({
  value: `character-${index + 1}`,
  label: `Character ${index + 1}`,
  description: `Playable character ${index + 1}`,
}));

describe("TUI user questions", () => {
  it("paginates long selections so the extension selector never renders the full list", async () => {
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
