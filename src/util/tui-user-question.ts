import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { UserQuestion } from "./ask-user-question.js";

export type AskTuiUserQuestion = <T extends string>(question: UserQuestion<T>) => Promise<T | undefined>;

const PAGE_SIZE = 6;

export function createTuiUserQuestion(ui: ExtensionUIContext): AskTuiUserQuestion {
  return async <T extends string>(question: UserQuestion<T>): Promise<T | undefined> => {
    const entries = question.options.map((option, index) => ({
      option,
      label: `${index + 1}. ${option.label}${option.recommended ? " (recommended)" : ""} — ${option.description}`,
      search: normalize(`${option.value} ${option.label} ${option.description}`),
    }));
    const customLabel = question.customInput
      ? `${question.customInput.label}… — ${question.customInput.description}`
      : undefined;
    let query = "";
    let page = 0;

    while (true) {
      const filtered = query ? entries.filter((entry) => entry.search.includes(normalize(query))) : entries;
      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      page = Math.min(page, pageCount - 1);
      const pageEntries = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const previousLabel = page > 0 ? `← Previous page (${page}/${pageCount})` : undefined;
      const nextLabel = page + 1 < pageCount ? `Next page (${page + 2}/${pageCount}) →` : undefined;
      const filterLabel = entries.length > PAGE_SIZE || query
        ? `${query ? "Change filter" : "Filter choices"}…${query ? ` — current: ${query}` : ""}`
        : undefined;
      const title = pageCount > 1 || query
        ? `${question.question} · page ${page + 1}/${pageCount}${query ? ` · filter: ${query}` : ""}`
        : question.question;
      const selected = await ui.select(title, [
        ...pageEntries.map((entry) => entry.label),
        ...(previousLabel ? [previousLabel] : []),
        ...(nextLabel ? [nextLabel] : []),
        ...(filterLabel ? [filterLabel] : []),
        ...(customLabel ? [customLabel] : []),
      ]);
      if (!selected) return undefined;
      const selectedEntry = pageEntries.find((entry) => entry.label === selected);
      if (selectedEntry) return selectedEntry.option.value;
      if (selected === previousLabel) {
        page -= 1;
        continue;
      }
      if (selected === nextLabel) {
        page += 1;
        continue;
      }
      if (selected === filterLabel) {
        const input = await ui.input(`Filter ${question.header}`, query || "Type part of a name, id, or description");
        if (input === undefined) continue;
        const nextQuery = input.trim();
        if (nextQuery && !entries.some((entry) => entry.search.includes(normalize(nextQuery)))) {
          ui.notify(`No ${question.header.toLocaleLowerCase()} choices match '${nextQuery}'.`, "warning");
          continue;
        }
        query = nextQuery;
        page = 0;
        continue;
      }
      if (selected !== customLabel || !question.customInput) return undefined;
      while (true) {
        const input = (await ui.input(question.customInput.prompt, question.customInput.placeholder))?.trim();
        if (!input) return undefined;
        const resolved = await question.customInput.resolve(input);
        if (resolved !== undefined) return resolved;
        ui.notify(question.customInput.invalidMessage ?? "That value does not match an available choice.", "warning");
      }
    }
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
