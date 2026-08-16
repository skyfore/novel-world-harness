import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  InteractiveMode,
  SettingsManager,
  type TransientAssistantStream,
  type TransientAssistantStreamOptions,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => initTheme("dark", false));

describe("Pi-native NWH stream rendering", () => {
  it("shows active thinking, collapses it when the block ends, and lets the user expand it", () => {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      "Thinking hidden",
      1,
      [],
      "auto",
      "Thinking complete · Ctrl+T to expand",
    );
    const liveThinking = fauxAssistantMessage([fauxThinking("inspect the actor-visible evidence")]);
    component.updateContent(liveThinking, true);

    expect(component.render(100).join("\n")).toContain("inspect the actor-visible evidence");

    component.setThinkingBlockComplete(0);
    const collapsed = component.render(100).join("\n");
    expect(collapsed).toContain("Thinking complete");
    expect(collapsed).not.toContain("inspect the actor-visible evidence");

    component.setThinkingDisplayMode("expanded");
    expect(component.render(100).join("\n")).toContain("inspect the actor-visible evidence");
  });

  it("collapses only completed thinking while a later thinking block remains live", () => {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      "Thinking hidden",
      1,
      [],
      "auto",
      "Thinking complete",
    );
    component.updateContent(fauxAssistantMessage([
      fauxThinking("completed private reasoning"),
      fauxText("Public bridge."),
      fauxThinking("currently streaming reasoning"),
    ]), true);
    component.setThinkingBlockComplete(0);

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Thinking complete");
    expect(rendered).not.toContain("completed private reasoning");
    expect(rendered).toContain("currently streaming reasoning");
    expect(rendered).toContain("Public bridge.");
  });

  it("uses text start and message completion as collapse fallbacks", () => {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      "Thinking hidden",
      1,
      [],
      "auto",
      "Thinking complete",
    );
    const message = fauxAssistantMessage([
      fauxThinking("provider omitted thinking_end"),
      fauxText("Visible answer."),
    ]);
    component.updateContent(message, true);
    component.completeThinkingBlocksBefore(1);
    expect(component.render(100).join("\n")).not.toContain("provider omitted thinking_end");
    expect(component.render(100).join("\n")).toContain("Visible answer.");

    const completionFallback = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      "Thinking hidden",
      1,
      [],
      "auto",
      "Thinking complete",
    );
    completionFallback.updateContent(message, false);
    expect(completionFallback.render(100).join("\n")).not.toContain("provider omitted thinking_end");
  });

  it("mounts extension-owned streams in the native transcript rather than the editor dock", () => {
    const chatContainer = new Container();
    const widgetContainerAbove = new Container();
    const requestRender = vi.fn();
    type InteractiveModeInternals = {
      transientAssistantStreams: Map<string, unknown>;
      thinkingDisplayMode: "auto" | "expanded" | "hidden";
      hideThinkingBlock: boolean;
      chatContainer: Container;
      widgetContainerAbove: Container;
      ui: { requestRender(): void };
      runtimeHost: {
        session: {
          settingsManager: { setThinkingDisplayMode(mode: string): void };
          sessionManager: { appendCustomEntry(customType: string, data: unknown): string };
        };
      };
      hiddenThinkingLabel: string;
      outputPad: number;
      getMarkdownThemeWithSettings(): ReturnType<typeof getMarkdownTheme>;
      getMarkdownTransformers(): [];
      applyAssistantThinkingEvent: (component: AssistantMessageComponent, event: unknown) => void;
      openTransientAssistantStream(key: string, options?: TransientAssistantStreamOptions): TransientAssistantStream;
      rebuildChatFromMessages(): void;
      reattachTransientAssistantStreams(): void;
      showStatus(message: string): void;
      toggleThinkingBlockVisibility(): void;
      addCustomEntryToChat(entry: unknown): void;
    };
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];
    const sessionManager = {
      appendCustomEntry(customType: string, data: unknown) {
        appendedEntries.push({ customType, data: structuredClone(data) });
        return "scene-entry";
      },
    };
    const mode = Object.create(InteractiveMode.prototype) as InteractiveModeInternals;
    Object.assign(mode, {
      transientAssistantStreams: new Map(),
      thinkingDisplayMode: "auto",
      hideThinkingBlock: false,
      chatContainer,
      widgetContainerAbove,
      ui: { requestRender },
      runtimeHost: {
        session: {
          settingsManager: { setThinkingDisplayMode: vi.fn() },
          sessionManager,
        },
      },
      hiddenThinkingLabel: "Thinking hidden",
      outputPad: 1,
      getMarkdownThemeWithSettings: () => getMarkdownTheme(),
      getMarkdownTransformers: () => [],
      rebuildChatFromMessages: () => undefined,
      showStatus: () => undefined,
    });
    const stream = mode.openTransientAssistantStream("scene", {
      completedThinkingLabel: "Thinking complete",
    });
    const message = fauxAssistantMessage([
      fauxThinking("transient child-session reasoning"),
      fauxText("The actual scene stream remains visible."),
    ]);
    stream.update(message, {
      type: "thinking_end",
      contentIndex: 0,
      content: "transient child-session reasoning",
    });

    expect(chatContainer.children).toHaveLength(1);
    expect(widgetContainerAbove.children).toHaveLength(0);
    expect(chatContainer.render(80).join("\n")).toContain("The actual scene stream remains visible.");
    expect(chatContainer.render(80).join("\n")).not.toContain("transient child-session reasoning");

    mode.toggleThinkingBlockVisibility();
    expect(chatContainer.children).toHaveLength(1);
    expect(chatContainer.render(80).join("\n")).toContain("transient child-session reasoning");

    stream.complete(message);
    stream.commit("nwh-narrator", { branchId: "main", choices: [] });
    expect(appendedEntries).toHaveLength(1);
    expect(appendedEntries[0]).toMatchObject({
      customType: "nwh-narrator",
      data: {
        __piAssistantStream: 1,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "transient child-session reasoning" },
            { type: "text", text: "The actual scene stream remains visible." },
          ],
        },
        details: { branchId: "main", choices: [] },
      },
    });
    stream.dispose();
    expect(chatContainer.children).toHaveLength(1);

    chatContainer.removeChild(stream.component);
    mode.thinkingDisplayMode = "auto";
    mode.addCustomEntryToChat({
      type: "custom",
      customType: appendedEntries[0]!.customType,
      data: appendedEntries[0]!.data,
    });
    expect(chatContainer.children).toHaveLength(1);
    expect(chatContainer.render(80).join("\n")).toContain("The actual scene stream remains visible.");
    expect(chatContainer.render(80).join("\n")).not.toContain("transient child-session reasoning");
    expect(requestRender).toHaveBeenCalled();
  });

  it("defaults new settings to auto-collapse while migrating legacy visibility choices", () => {
    expect(SettingsManager.inMemory().getThinkingDisplayMode()).toBe("auto");
    expect(SettingsManager.inMemory({ hideThinkingBlock: false }).getThinkingDisplayMode()).toBe("expanded");
    expect(SettingsManager.inMemory({ hideThinkingBlock: true }).getThinkingDisplayMode()).toBe("hidden");
  });
});
