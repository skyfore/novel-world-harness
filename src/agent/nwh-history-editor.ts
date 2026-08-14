import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

export class NwhHistoryEditor extends CustomEditor {
  private readonly entries: string[] = [];
  private historyCursor = -1;
  private nwhHistoryDraft = "";

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    initialHistory: readonly string[] = [],
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    for (const item of initialHistory) this.addToHistory(item);
  }

  override addToHistory(text: string): void {
    super.addToHistory(text);
    const value = text.trim();
    if (!value) return;
    if (this.entries[0] !== value) this.entries.unshift(value);
    if (this.entries.length > 100) this.entries.pop();
    this.historyCursor = -1;
    this.nwhHistoryDraft = "";
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.up) && (this.getText() === "" || this.historyCursor >= 0)) {
      this.navigateNwhHistory(-1);
      return;
    }
    if (matchesKey(data, Key.down) && this.historyCursor >= 0) {
      this.navigateNwhHistory(1);
      return;
    }
    if (this.historyCursor >= 0) this.historyCursor = -1;
    super.handleInput(data);
  }

  private navigateNwhHistory(direction: -1 | 1): void {
    if (!this.entries.length) return;
    if (direction === -1) {
      if (this.historyCursor === -1) this.nwhHistoryDraft = this.getText();
      if (this.historyCursor + 1 >= this.entries.length) return;
      this.historyCursor += 1;
      this.setText(this.entries[this.historyCursor]!);
      return;
    }
    this.historyCursor -= 1;
    this.setText(this.historyCursor >= 0 ? this.entries[this.historyCursor]! : this.nwhHistoryDraft);
  }
}
