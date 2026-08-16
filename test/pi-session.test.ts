import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { formatNwhResumeCommand, formatRetryNotice, PiAgentSession, resolveNwhFullscreenExitOutput, resolveNwhTuiMode, resolveSavedWorldStartupRestore, runPromptWithTimeout, withPiVersionCheckSuppressed } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { writeLastOpenedSession } from "../src/agent/last-opened-session.js";
import { workspaceSessionDir } from "../src/agent/runtime-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("PiAgentSession", () => {
  it("defaults to fullscreen while honoring saved and command-line choices", () => {
    expect(resolveNwhTuiMode(undefined, undefined)).toBe("fullscreen");
    expect(resolveNwhTuiMode(undefined, "regular")).toBe("regular");
    expect(resolveNwhTuiMode("fullscreen", "regular")).toBe("fullscreen");
    expect(resolveNwhTuiMode("regular", "fullscreen")).toBe("regular");
    expect(resolveNwhFullscreenExitOutput(undefined)).toBe("resume-hint");
    expect(resolveNwhFullscreenExitOutput("transcript")).toBe("transcript");
  });

  it("attaches a saved world only for transcript continuation or explicit player entry", () => {
    expect(resolveSavedWorldStartupRestore(true, undefined)).toBe(true);
    expect(resolveSavedWorldStartupRestore(false, "opening")).toBe(true);
    expect(resolveSavedWorldStartupRestore(false, undefined)).toBe(false);
  });

  it("formats an exact NWH resume command for assistant and compiler sessions", () => {
    expect(formatNwhResumeCommand("/tmp/Novel World", "session-1"))
      .toBe("nwh --root '/tmp/Novel World' --session session-1");
    expect(formatNwhResumeCommand("/tmp/Novel World", "compiler-1", "compiler"))
      .toBe("nwh --root '/tmp/Novel World' compile --session compiler-1");
  });

  it("suppresses Pi's CLI update check only while the embedded TUI is running", async () => {
    const previous = process.env.PI_SKIP_VERSION_CHECK;
    delete process.env.PI_SKIP_VERSION_CHECK;
    try {
      await expect(withPiVersionCheckSuppressed(async () => {
        expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
        return "done";
      })).resolves.toBe("done");
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
      await expect(withPiVersionCheckSuppressed(async () => {
        throw new Error("TUI stopped");
      })).rejects.toThrow("TUI stopped");
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = previous;
    }
  });

  it("uses Pi with an in-memory session without making a model request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-"));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, "NOVEL.md"), "# Test novel\n", "utf8");
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      runtimeDir: path.join(root, "user-runtime"),
      piAgentDir: path.join(root, "pi-agent"),
      saveSession: false,
      profile: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        thinkingLevel: "medium",
        maxTokens: 8_192,
      },
    });
    expect(session.model).toBe("anthropic/claude-sonnet-5");
    expect(session.messageCount).toBe(0);
    expect(session.sessionFile).toBeUndefined();
    const settings = (session as unknown as {
      runtimeHost: { services: { settingsManager: { getHideThinkingBlock(): boolean; getThinkingDisplayMode(): string; getFullscreenExitOutput(): string } } };
    }).runtimeHost.services.settingsManager;
    expect(settings.getHideThinkingBlock()).toBe(false);
    expect(settings.getThinkingDisplayMode()).toBe("auto");
    expect(settings.getFullscreenExitOutput()).toBe("transcript");
    await session.dispose();
  });

  it("materializes a new transcript when its first response is a committed assistant stream", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-native-scene-workspace-"));
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-native-scene-sessions-"));
    temporaryDirectories.push(root, sessionsDir);
    const manager = SessionManager.create(root, sessionsDir);
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();

    manager.appendCustomEntry("nwh-narrator", {
      __piAssistantStream: 1,
      key: "scene",
      message: fauxAssistantMessage([
        fauxThinking("reasoning survives the scene commit"),
        fauxText("The scene itself is persisted once."),
      ]),
      details: { branchId: "main", choices: [] },
    });

    const persisted = await fs.readFile(sessionFile!, "utf8");
    expect(persisted).toContain("reasoning survives the scene commit");
    expect(persisted).toContain("The scene itself is persisted once.");
    expect(persisted.match(/nwh-narrator/g)).toHaveLength(1);
  });

  it("continues the transcript the interactive user last opened instead of guessing from mtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-last-opened-workspace-"));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-last-opened-runtime-"));
    temporaryDirectories.push(root, runtimeDir);
    const sessionDir = workspaceSessionDir(root, runtimeDir);
    await fs.mkdir(sessionDir, { recursive: true });
    const selected = path.join(sessionDir, "selected.jsonl");
    const newerByMtime = path.join(sessionDir, "newer-by-mtime.jsonl");
    await fs.writeFile(selected, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "selected-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    })}\n`, "utf8");
    await fs.writeFile(newerByMtime, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "newer-session",
      timestamp: "2026-01-02T00:00:00.000Z",
      cwd: root,
    })}\n`, "utf8");
    await fs.utimes(selected, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await fs.utimes(newerByMtime, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
    await writeLastOpenedSession(root, runtimeDir, selected);
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    try {
      const session = await PiAgentSession.create({
        workspace: await LocalFileWorkspace.create(root),
        runtimeDir,
        piAgentDir: path.join(root, "pi-agent"),
        continueSession: true,
        saveSession: true,
        trackLastOpenedSession: true,
        includeNwhExtension: false,
      });
      expect(session.sessionFile).toBe(selected);
      await session.dispose();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it("resumes an explicitly named transcript instead of the last-opened transcript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-explicit-workspace-"));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-explicit-runtime-"));
    temporaryDirectories.push(root, runtimeDir);
    const sessionDir = workspaceSessionDir(root, runtimeDir);
    await fs.mkdir(sessionDir, { recursive: true });
    const lastOpened = path.join(sessionDir, "last-opened-session.jsonl");
    const explicitlySelected = path.join(sessionDir, "explicit-session.jsonl");
    for (const [file, id] of [[lastOpened, "last-opened"], [explicitlySelected, "explicit"]] as const) {
      await fs.writeFile(file, `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: root,
      })}\n`, "utf8");
    }
    await writeLastOpenedSession(root, runtimeDir, lastOpened);
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    try {
      const session = await PiAgentSession.create({
        workspace: await LocalFileWorkspace.create(root),
        runtimeDir,
        piAgentDir: path.join(root, "pi-agent"),
        sessionId: "explicit",
        saveSession: true,
        trackLastOpenedSession: true,
        includeNwhExtension: false,
      });
      expect(session.sessionFile).toBe(explicitlySelected);
      await session.dispose();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it("registers a configured custom provider through Pi", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-custom-"));
    temporaryDirectories.push(root);
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      runtimeDir: path.join(root, "user-runtime"),
      piAgentDir: path.join(root, "pi-agent"),
      saveSession: false,
      profile: {
        provider: "local-openai",
        model: "novel-model",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiProtocol: "openai-completions",
        thinkingLevel: "off",
        contextWindow: 32_768,
        maxTokens: 4_096,
      },
    });
    expect(session.model).toBe("local-openai/novel-model");
    await session.dispose();
  });

  it("does not use profile metadata to cap a native Pi model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-model-override-"));
    temporaryDirectories.push(root);
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      runtimeDir: path.join(root, "user-runtime"),
      piAgentDir: path.join(root, "pi-agent"),
      saveSession: false,
      model: "anthropic/claude-haiku-4-5",
      profile: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        thinkingLevel: "low",
        maxTokens: 2_048,
      },
    });
    expect(session.model).toBe("anthropic/claude-haiku-4-5");
    const internals = session as unknown as {
      runtimeHost: {
        session: { model?: { maxTokens: number } };
        services: { modelRuntime: { getModel(provider: string, model: string): { maxTokens: number } } };
      };
    };
    const catalogModel = internals.runtimeHost.services.modelRuntime.getModel("anthropic", "claude-haiku-4-5");
    expect(internals.runtimeHost.session.model?.maxTokens).toBe(catalogModel.maxTokens);
    expect(internals.runtimeHost.session.model?.maxTokens).toBeGreaterThan(2_048);
    await session.dispose();
  });

  it("formats a visible notice for automatic API retries", () => {
    expect(formatRetryNotice({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "provider unavailable",
    })).toBe("LLM API call failed; retrying 1/3 in 2s: provider unavailable");
  });

  it("aborts a model turn that exceeds its wall-clock deadline", async () => {
    let rejectOperation: ((error: Error) => void) | undefined;
    const abort = vi.fn(async () => rejectOperation?.(new Error("aborted")));
    const operation = new Promise<void>((_resolve, reject) => { rejectOperation = reject; });

    await expect(runPromptWithTimeout(() => operation, abort, 10))
      .rejects.toThrow("exceeded its 10ms wall-clock limit");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("restores the model selected in a previous workspace session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-persisted-model-"));
    temporaryDirectories.push(root);
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    try {
      const first = await PiAgentSession.create({
        workspace: await LocalFileWorkspace.create(root),
        runtimeDir: path.join(root, "user-runtime"),
        piAgentDir: path.join(root, "pi-agent"),
        saveSession: false,
      });
      const internals = first as unknown as {
        runtimeHost: {
          session: { setModel(model: unknown): Promise<void> };
          services: { modelRuntime: { getModel(provider: string, modelId: string): unknown } };
        };
      };
      const selectedModel = internals.runtimeHost.services.modelRuntime.getModel("anthropic", "claude-haiku-4-5");
      expect(selectedModel).toBeDefined();
      await internals.runtimeHost.session.setModel(selectedModel);
      await first.dispose();

      const restarted = await PiAgentSession.create({
        workspace: await LocalFileWorkspace.create(root),
        runtimeDir: path.join(root, "user-runtime"),
        piAgentDir: path.join(root, "pi-agent"),
        saveSession: false,
      });
      expect(restarted.model).toBe("anthropic/claude-haiku-4-5");
      await restarted.dispose();

      const savedSettings = JSON.parse(await fs.readFile(path.join(root, "pi-agent", "settings.json"), "utf8")) as Record<string, unknown>;
      expect(savedSettings).toMatchObject({
        defaultProvider: "anthropic",
        defaultModel: "claude-haiku-4-5",
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });
});
