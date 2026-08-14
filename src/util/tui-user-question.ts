import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { UserQuestion } from "./ask-user-question.js";

export type AskTuiUserQuestion = <T extends string>(question: UserQuestion<T>) => Promise<T | undefined>;

export function createTuiUserQuestion(ui: ExtensionUIContext): AskTuiUserQuestion {
  return async <T extends string>(question: UserQuestion<T>): Promise<T | undefined> => {
    const labels = question.options.map((option) =>
      `${option.label}${option.recommended ? " (recommended)" : ""} — ${option.description}`);
    const customLabel = question.customInput
      ? `${question.customInput.label}… — ${question.customInput.description}`
      : undefined;
    const selected = await ui.select(question.question, [
      ...labels,
      ...(customLabel ? [customLabel] : []),
    ]);
    if (!selected) return undefined;
    const selectedIndex = labels.indexOf(selected);
    if (selectedIndex >= 0) return question.options[selectedIndex]?.value;
    if (selected !== customLabel || !question.customInput) return undefined;

    while (true) {
      const input = (await ui.input(question.customInput.prompt, question.customInput.placeholder))?.trim();
      if (!input) return undefined;
      const resolved = await question.customInput.resolve(input);
      if (resolved !== undefined) return resolved;
      ui.notify(question.customInput.invalidMessage ?? "That value does not match an available choice.", "warning");
    }
  };
}
