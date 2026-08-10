import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { PiAgentSession, expandFileMentions } from "../agent/pi-session.js";
import { loadConfig, profileForRole } from "../config/load.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";

export type PlayCommandOptions = {
  configPath: string;
  allowMissingConfig?: boolean;
  root?: string;
  model?: string;
  continueSession?: boolean;
  saveSession?: boolean;
  printPrompt?: string;
};

const HELP = `Local commands:
  /files [path filter]       list local workspace files
  /search <text>             search local files for fixed text
  /read <path> [start:end]   read a bounded line range
  /status                    show workspace, model and session
  /clear                     clear model conversation history
  /help                      show this help
  /exit                      end the session

File references:
  Ask about @chapters/01.md or @"drafts/chapter one.md" to attach a local file.`;

function splitArguments(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

async function optionalConfig(options: PlayCommandOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function runLocalCommand(
  line: string,
  workspace: LocalFileWorkspace,
  session: PiAgentSession,
  saveSession: boolean,
): Promise<"handled" | "exit" | "not-command"> {
  if (!line.startsWith("/")) return "not-command";
  const [command = "", ...args] = splitArguments(line);
  switch (command) {
    case "/exit":
    case "/quit":
      return "exit";
    case "/help":
      output.write(`${HELP}\n`);
      return "handled";
    case "/files": {
      const files = await workspace.listFiles({ pattern: args.join(" ") || undefined });
      output.write(`${files.length ? files.join("\n") : "No matching files."}\n`);
      return "handled";
    }
    case "/search": {
      const query = args.join(" ").trim();
      if (!query) throw new Error("Usage: /search <text>");
      const matches = await workspace.searchFiles({ query });
      output.write(`${matches.length ? matches.join("\n") : "No matches."}\n`);
      return "handled";
    }
    case "/read": {
      const [filePath, range] = args;
      if (!filePath) throw new Error("Usage: /read <path> [start:end]");
      const rangeMatch = range?.match(/^(\d+)(?::(\d+))?$/);
      if (range && !rangeMatch) throw new Error("Line range must use start:end, for example 40:80.");
      const startLine = rangeMatch ? Number(rangeMatch[1]) : undefined;
      const endLine = rangeMatch?.[2] ? Number(rangeMatch[2]) : undefined;
      output.write(`${await workspace.readFile({ path: filePath, startLine, endLine })}\n`);
      return "handled";
    }
    case "/status":
      output.write(`workspace: ${workspace.root}\nmodel: ${session.model}\nsession: ${session.id}\nmessages: ${session.messageCount}\npersistence: ${saveSession ? "on" : "off"}\n`);
      return "handled";
    case "/clear":
      await session.clear();
      output.write("Conversation history cleared.\n");
      return "handled";
    default:
      throw new Error(`Unknown command '${command}'. Use /help.`);
  }
}

export async function playCommand(options: PlayCommandOptions): Promise<void> {
  const workspace = await LocalFileWorkspace.create(options.root ?? process.cwd());
  const config = await optionalConfig(options);
  const profile = config ? profileForRole(config, "narrator").profile : undefined;
  const model = options.model ?? profile?.model;
  const saveSession = options.saveSession ?? true;
  let textStarted = false;
  const session = await PiAgentSession.create({
    workspace,
    profile,
    model,
    continueSession: options.continueSession,
    saveSession,
    onText(delta) {
      textStarted = true;
      output.write(delta);
    },
    onTool(name, toolInput) {
      const details = toolInput as Record<string, unknown>;
      const target = details.path ?? details.query;
      stderr.write(`\n↳ ${name}${target ? ` ${String(target)}` : ""}\n`);
    },
  });

  const ask = async (prompt: string): Promise<void> => {
    textStarted = false;
    const expanded = await expandFileMentions(prompt, workspace);
    await session.prompt(expanded);
    if (textStarted) output.write("\n");
  };

  try {
    if (options.printPrompt) {
      await ask(options.printPrompt);
      return;
    }

    const relativeRoot = path.relative(process.cwd(), workspace.root) || ".";
    const configLabel = config ? path.relative(process.cwd(), options.configPath) || options.configPath : "defaults";
    output.write(`Novel World Harness 0.1\nworkspace ${relativeRoot} · model ${session.model} · config ${configLabel}\nType /help for local commands.\n`);
    const rl = readline.createInterface({ input, output });
    try {
      while (true) {
        const line = (await rl.question("\nnwh › ")).trim();
        if (!line) continue;
        try {
          const local = await runLocalCommand(line, workspace, session, saveSession);
          if (local === "exit") break;
          if (local === "handled") continue;
          await ask(line);
        } catch (error) {
          stderr.write(`! ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    } finally {
      rl.close();
    }
  } finally {
    session.dispose();
  }
}
