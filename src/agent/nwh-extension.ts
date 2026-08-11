import path from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { expandFileMentions } from "./file-mentions.js";
import { createNwhWelcomeHeader, isFreshConversation, NWH_WORKING_FRAMES } from "./nwh-welcome.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";

export type NwhInteractionMode = "assistant" | "compiler";

export type NwhExtensionOptions = {
  workspace: LocalFileWorkspace;
  saveSession: boolean;
  mode: NwhInteractionMode;
  onSessionShutdown?: () => Promise<void>;
};

const COMMAND_HELP = `NWH commands:
  /files [path filter]       list safe workspace files
  /search <text>             search local files for fixed text
  /read <path> [start:end]   read a bounded line range
  /status                    show workspace, model and session
  /clear                     start a new conversation
  /help                      show this help
  /exit                      end the session

Provider and model:
  /login                     sign in to a provider (subscription/OAuth or API key)
  /logout                    remove provider authentication
  /model                     select a model after signing in

TUI shortcuts:
  Enter send · Shift+Enter newline · Esc interrupt · Ctrl+O expand tools
  /hotkeys shows every shortcut. Prefix ! runs a user shell command.`;

export function splitCommandArguments(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

function modelLabel(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unresolved";
}

export function createNwhExtension(options: NwhExtensionOptions): ExtensionFactory {
  const { workspace, saveSession, mode } = options;
  return (pi: ExtensionAPI) => {
    pi.on("session_shutdown", async () => options.onSessionShutdown?.());

    pi.on("input", async (event, ctx) => {
      try {
        await expandFileMentions(event.text, workspace);
        return { action: "continue" };
      } catch (error) {
        ctx.ui.notify(`Cannot attach local file: ${error instanceof Error ? error.message : String(error)}`, "error");
        return { action: "handled" };
      }
    });

    pi.on("before_agent_start", async (event) => {
      const expanded = await expandFileMentions(event.prompt, workspace);
      if (expanded === event.prompt) return;
      return {
        message: {
          customType: "nwh-file-context",
          content: expanded.slice(event.prompt.length).trim(),
          display: false,
        },
      };
    });

    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      const modeLabel = mode === "compiler" ? "compiler proposals" : "read-only assistant";
      const terminalTitle = `NWH — ${path.basename(workspace.root)}`;
      ctx.ui.setTitle(terminalTitle);
      const titleTimer = setTimeout(() => ctx.ui.setTitle(terminalTitle), 0);
      titleTimer.unref();
      ctx.ui.setWorkingMessage(mode === "compiler" ? "Building evidence-backed proposals..." : "Consulting local evidence...");
      ctx.ui.setWorkingIndicator({ frames: NWH_WORKING_FRAMES, intervalMs: 180 });
      ctx.ui.setHiddenThinkingLabel("Reasoning");
      ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${modeLabel}`));
      const freshConversation = isFreshConversation(ctx.sessionManager.getEntries());
      ctx.ui.setHeader((tui, theme) => createNwhWelcomeHeader(tui, theme, { mode, freshConversation }));
    });

    pi.registerCommand("files", {
      description: "List safe local workspace files",
      handler: async (args, ctx) => {
        const files = await workspace.listFiles({ pattern: args.trim() || undefined });
        ctx.ui.notify(files.length ? files.join("\n") : "No matching files.", "info");
      },
    });

    pi.registerCommand("search", {
      description: "Search local files for fixed text",
      handler: async (args, ctx) => {
        const query = args.trim();
        if (!query) throw new Error("Usage: /search <text>");
        const matches = await workspace.searchFiles({ query });
        ctx.ui.notify(matches.length ? matches.join("\n") : "No matches.", "info");
      },
    });

    pi.registerCommand("read", {
      description: "Read a bounded local file range",
      handler: async (args, ctx) => {
        const [filePath, range] = splitCommandArguments(args);
        if (!filePath) throw new Error("Usage: /read <path> [start:end]");
        const rangeMatch = range?.match(/^(\d+)(?::(\d+))?$/);
        if (range && !rangeMatch) throw new Error("Line range must use start:end, for example 40:80.");
        const startLine = rangeMatch ? Number(rangeMatch[1]) : undefined;
        const endLine = rangeMatch?.[2] ? Number(rangeMatch[2]) : undefined;
        ctx.ui.notify(await workspace.readFile({ path: filePath, startLine, endLine }), "info");
      },
    });

    pi.registerCommand("status", {
      description: "Show NWH workspace and session status",
      handler: async (_args, ctx) => {
        ctx.ui.notify([
          `workspace: ${workspace.root}`,
          `mode: ${mode}`,
          `model: ${modelLabel(ctx.model)}`,
          `session: ${ctx.sessionManager.getSessionId()}`,
          `entries: ${ctx.sessionManager.getEntries().length}`,
          `persistence: ${saveSession ? "on" : "off"}`,
        ].join("\n"), "info");
      },
    });

    pi.registerCommand("clear", {
      description: "Start a new NWH conversation",
      handler: async (_args, ctx) => {
        const result = await ctx.newSession();
        if (!result.cancelled) ctx.ui.notify("Conversation history cleared.", "info");
      },
    });

    pi.registerCommand("help", {
      description: "Show NWH commands and key hints",
      handler: async (_args, ctx) => ctx.ui.notify(COMMAND_HELP, "info"),
    });

    pi.registerCommand("exit", {
      description: "Exit NWH",
      handler: async (_args, ctx) => ctx.shutdown(),
    });
  };
}
