import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

export class NwhHistoryEditor extends CustomEditor {
  private readonly entries: string[] = [];
  private readonly nwhKeybindings: KeybindingsManager;
  private historyCursor = -1;
  private nwhHistoryDraft = "";
  private toolsExpanded = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    initialHistory: readonly string[] = [],
    options?: EditorOptions,
    private thinkingHidden = false,
  ) {
    super(tui, theme, keybindings, options);
    this.nwhKeybindings = keybindings;
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
    // Pi assigns Ctrl+O to tool expansion and Ctrl+T to thinking visibility.
    // NWH treats the former as a Claude-style details toggle while preserving
    // Ctrl+T as an independent reasoning-only control.
    if (this.nwhKeybindings.matches(data, "app.tools.expand")) {
      this.toggleDetails();
      return;
    }
    if (this.nwhKeybindings.matches(data, "app.thinking.toggle")) {
      this.actionHandlers.get("app.thinking.toggle")?.();
      this.thinkingHidden = !this.thinkingHidden;
      return;
    }
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

  private toggleDetails(): void {
    const showDetails = !this.toolsExpanded;
    const toolHandler = this.actionHandlers.get("app.tools.expand");
    if (toolHandler) {
      toolHandler();
      this.toolsExpanded = showDetails;
    }

    const thinkingVisible = !this.thinkingHidden;
    if (thinkingVisible !== showDetails) {
      this.actionHandlers.get("app.thinking.toggle")?.();
      this.thinkingHidden = !this.thinkingHidden;
    }
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
