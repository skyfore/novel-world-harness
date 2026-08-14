import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { UserQuestion } from "./ask-user-question.js";

export type AskTuiUserQuestion = <T extends string>(question: UserQuestion<T>) => Promise<T | undefined>;

const PAGE_SIZE = 6;
const MAX_VISIBLE_CHOICES = 10;
const RESERVED_DIALOG_ROWS = 6;
const NATIVE_UNAVAILABLE = Symbol("native-tui-unavailable");

type QuestionEntry<T extends string> = {
  option: UserQuestion<T>["options"][number];
  index: number;
  label: string;
  search: string;
};

type NativeSelection<T extends string> =
  | { kind: "choice"; value: T }
  | { kind: "filter" }
  | { kind: "custom" }
  | { kind: "cancel" };

export function createTuiUserQuestion(ui: ExtensionUIContext): AskTuiUserQuestion {
  return async <T extends string>(question: UserQuestion<T>): Promise<T | undefined> => {
    const entries = question.options.map((option, index) => ({
      option,
      index,
      label: `${index + 1}. ${option.label}${option.recommended ? " (recommended)" : ""} — ${option.description}`,
      search: normalize(`${option.value} ${option.label} ${option.description}`),
    }));
    const nativeResult = await askWithNativeSelectList(ui, question, entries);
    if (nativeResult !== NATIVE_UNAVAILABLE) return nativeResult;
    return askWithPagedFallback(ui, question, entries);
  };
}

async function askWithNativeSelectList<T extends string>(
  ui: ExtensionUIContext,
  question: UserQuestion<T>,
  entries: readonly QuestionEntry<T>[],
): Promise<T | undefined | typeof NATIVE_UNAVAILABLE> {
  if (typeof ui.custom !== "function") return NATIVE_UNAVAILABLE;
  let query = "";

  while (true) {
    const filtered = filterEntries(entries, query);
    const result = await ui.custom<NativeSelection<T> | undefined>((tui, theme, _keybindings, done) => {
      const items: SelectItem[] = [
        ...filtered.map((entry) => ({
          value: `choice:${entry.index}`,
          label: `${entry.index + 1}. ${entry.option.label}${entry.option.recommended ? " (recommended)" : ""}`,
          description: entry.option.description,
        })),
        ...(entries.length > PAGE_SIZE || query
          ? [{ value: "control:filter", label: query ? "Change filter…" : "Filter choices…", description: query ? `Current: ${query}` : "Search by name, id, or description" }]
          : []),
        ...(question.customInput
          ? [{ value: "control:custom", label: `${question.customInput.label}…`, description: question.customInput.description }]
          : []),
      ];
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold(
        query ? `${question.question} · filter: ${query}` : question.question,
      )), 1, 0));
      container.addChild(new Spacer(1));
      const availableRows = Math.max(1, tui.terminal.rows - RESERVED_DIALOG_ROWS);
      const selectList = new SelectList(items, Math.min(items.length, availableRows, MAX_VISIBLE_CHOICES), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) => {
        if (item.value === "control:filter") return done({ kind: "filter" });
        if (item.value === "control:custom") return done({ kind: "custom" });
        const index = Number(item.value.slice("choice:".length));
        const entry = entries.find((candidate) => candidate.index === index);
        if (entry) done({ kind: "choice", value: entry.option.value });
      };
      selectList.onCancel = () => done({ kind: "cancel" });
      container.addChild(selectList);
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate · / filter · enter select · esc cancel"), 1, 0));
      return {
        render: (width: number) => container.render(width),
        handleInput: (data: string) => {
          if (data === "/" && (entries.length > PAGE_SIZE || query)) {
            done({ kind: "filter" });
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => container.invalidate(),
      };
    });

    // RPC implements custom() as an unsupported undefined result. Fall back to
    // portable dialogs there while keeping cancellation explicit in the TUI.
    if (result === undefined) return NATIVE_UNAVAILABLE;
    if (result.kind === "cancel") return undefined;
    if (result.kind === "choice") return result.value;
    if (result.kind === "filter") {
      const nextQuery = await askForFilter(ui, question, entries, query);
      if (nextQuery !== undefined) query = nextQuery;
      continue;
    }
    const custom = await askForCustomValue(ui, question);
    if (custom !== undefined) return custom;
    return undefined;
  }
}

async function askWithPagedFallback<T extends string>(
  ui: ExtensionUIContext,
  question: UserQuestion<T>,
  entries: readonly QuestionEntry<T>[],
): Promise<T | undefined> {
  const customLabel = question.customInput
    ? `${question.customInput.label}… — ${question.customInput.description}`
    : undefined;
  let query = "";
  let page = 0;

  while (true) {
    const filtered = filterEntries(entries, query);
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
      const nextQuery = await askForFilter(ui, question, entries, query);
      if (nextQuery === undefined) continue;
      query = nextQuery;
      page = 0;
      continue;
    }
    if (selected !== customLabel || !question.customInput) return undefined;
    return askForCustomValue(ui, question);
  }
}

async function askForFilter<T extends string>(
  ui: ExtensionUIContext,
  question: UserQuestion<T>,
  entries: readonly QuestionEntry<T>[],
  query: string,
): Promise<string | undefined> {
  const input = await ui.input(`Filter ${question.header}`, query || "Type part of a name, id, or description");
  if (input === undefined) return undefined;
  const nextQuery = input.trim();
  if (nextQuery && filterEntries(entries, nextQuery).length === 0) {
    ui.notify(`No ${question.header.toLocaleLowerCase()} choices match '${nextQuery}'.`, "warning");
    return undefined;
  }
  return nextQuery;
}

async function askForCustomValue<T extends string>(
  ui: ExtensionUIContext,
  question: UserQuestion<T>,
): Promise<T | undefined> {
  if (!question.customInput) return undefined;
  while (true) {
    const input = (await ui.input(question.customInput.prompt, question.customInput.placeholder))?.trim();
    if (!input) return undefined;
    const resolved = await question.customInput.resolve(input);
    if (resolved !== undefined) return resolved;
    ui.notify(question.customInput.invalidMessage ?? "That value does not match an available choice.", "warning");
  }
}

function filterEntries<T extends string>(entries: readonly QuestionEntry<T>[], query: string): readonly QuestionEntry<T>[] {
  return query ? entries.filter((entry) => entry.search.includes(normalize(query))) : entries;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
