import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".novel-harness",
  ".aws",
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
  ".terraform",
  ".terragrunt",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
]);

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".envrc",
  ".htpasswd",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".dockerconfigjson",
  ".git-credentials",
  "application_default_credentials.json",
  "auth.json",
  "client_secret.json",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
  "token.json",
]);
const SENSITIVE_FILE_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 32_000;
const MAX_LIST_RESULTS = 10_000;
const MAX_SEARCH_RESULTS = 100;

export type ListFilesInput = {
  path?: string;
  pattern?: string;
  maxResults?: number;
};

export type ReadFileInput = {
  path: string;
  startLine?: number;
  endLine?: number;
};

export type SearchFilesInput = {
  query: string;
  path?: string;
  pattern?: string;
  maxResults?: number;
};

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/") || ".";
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Result limits must be positive integers.");
  return Math.min(value, maximum);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_000).includes(0);
}

function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`File is not valid UTF-8: ${label}`);
  }
}

function isExcludedRelative(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized === ".") return false;
  const parts = normalized.split("/");
  if (parts.some((part) => DEFAULT_IGNORED_DIRECTORIES.has(part.toLocaleLowerCase()))) return true;
  const name = (parts.at(-1) ?? "").toLocaleLowerCase();
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  if (name.startsWith("client_secret_") && name.endsWith(".json")) return true;
  if (/^(?:credentials|service-account)[._-].*\.json$/u.test(name)) return true;
  if (name.startsWith(".env.") && !name.endsWith(".example") && !name.endsWith(".template")) return true;
  return SENSITIVE_FILE_EXTENSIONS.has(path.extname(name).toLocaleLowerCase());
}

export class LocalFileWorkspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root = process.cwd()): Promise<LocalFileWorkspace> {
    const realRoot = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
    return new LocalFileWorkspace(realRoot);
  }

  static async hasRipgrep(): Promise<boolean> {
    try {
      await execFileAsync("rg", ["--version"], { timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(input: ListFilesInput = {}): Promise<string[]> {
    const start = await this.resolveInside(input.path ?? ".");
    const pattern = input.pattern?.toLocaleLowerCase();
    const limit = clamp(input.maxResults, 200, MAX_LIST_RESULTS);
    const files: string[] = [];

    const visit = async (absolute: string): Promise<void> => {
      if (files.length >= limit) return;
      const current = await fs.stat(absolute);
      if (current.isFile()) {
        const relative = normalizeRelative(path.relative(this.root, absolute));
        if (isExcludedRelative(relative)) return;
        if (!pattern || relative.toLocaleLowerCase().includes(pattern)) files.push(relative);
        return;
      }
      if (!current.isDirectory()) return;

      const entries = await fs.readdir(absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        await visit(path.join(absolute, entry.name));
      }
    };

    await visit(start);
    return files;
  }

  async readFile(input: ReadFileInput): Promise<string> {
    const absolute = await this.resolveInside(input.path);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`Not a file: ${input.path}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes: ${input.path}`);
    }

    const buffer = await fs.readFile(absolute);
    if (looksBinary(buffer)) throw new Error(`Binary files are not supported: ${input.path}`);
    const lines = decodeUtf8(buffer, input.path).replace(/\r\n/g, "\n").split("\n");
    const startLine = input.startLine ?? 1;
    if (!Number.isInteger(startLine) || startLine <= 0) throw new Error("startLine must be a positive integer.");
    if (startLine > lines.length) throw new Error(`startLine ${startLine} is past the end of ${input.path} (${lines.length} lines).`);
    const requestedEnd = input.endLine ?? startLine + MAX_READ_LINES - 1;
    if (!Number.isInteger(requestedEnd) || requestedEnd < startLine) {
      throw new Error("endLine must be an integer greater than or equal to startLine.");
    }
    const cappedEnd = Math.min(requestedEnd, startLine + MAX_READ_LINES - 1);
    const endLine = Math.min(cappedEnd, lines.length);
    const relative = normalizeRelative(path.relative(this.root, absolute));
    const output = [`${relative}:${startLine}-${endLine} (${lines.length} lines total)`];
    let chars = output[0].length;
    let truncated = cappedEnd < requestedEnd;

    for (let index = startLine - 1; index < endLine; index += 1) {
      const rendered = `${index + 1}: ${lines[index] ?? ""}`;
      if (chars + rendered.length + 1 > MAX_READ_CHARS) {
        truncated = true;
        break;
      }
      output.push(rendered);
      chars += rendered.length + 1;
    }
    if (truncated) output.push("[truncated; request a narrower line range to continue]");
    return output.join("\n");
  }

  /**
   * Host-only exact read for a path the user explicitly promoted to trusted
   * project guidance. This is intentionally not exposed as a model tool.
   */
  async readProjectInstruction(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Project instruction paths must be workspace-relative: ${relativePath}`);
    }
    const absolute = await this.resolveInside(relativePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes: ${relativePath}`);
    }
    const buffer = await fs.readFile(absolute);
    if (looksBinary(buffer)) throw new Error(`Binary files are not supported: ${relativePath}`);
    let decoded: string;
    try {
      decoded = decodeUtf8(buffer, relativePath);
    } catch {
      throw new Error(`Project instruction is not valid UTF-8: ${relativePath}`);
    }
    return decoded.replace(/\r\n/g, "\n");
  }

  async searchFiles(input: SearchFilesInput): Promise<string[]> {
    const query = input.query.trim();
    if (!query) throw new Error("Search query cannot be empty.");
    const limit = clamp(input.maxResults, 20, MAX_SEARCH_RESULTS);
    const ripgrep = await this.searchWithRipgrep({ ...input, query }, limit);
    if (ripgrep !== null) return ripgrep;
    return this.searchWithNode({ ...input, query }, limit);
  }

  private async searchWithNode(input: SearchFilesInput, limit: number): Promise<string[]> {
    const files = await this.listFiles({
      path: input.path,
      pattern: input.pattern,
      maxResults: MAX_LIST_RESULTS,
    });
    const normalizedQuery = input.query.toLocaleLowerCase();
    const matches: string[] = [];

    for (const relative of files) {
      if (matches.length >= limit) break;
      const absolute = await this.resolveInside(relative);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(absolute);
      if (looksBinary(buffer)) continue;
      let decoded: string;
      try {
        decoded = decodeUtf8(buffer, relative);
      } catch {
        continue;
      }
      const lines = decoded.replace(/\r\n/g, "\n").split("\n");
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index] ?? "";
        if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;
        const preview = line.trim().replace(/\s+/g, " ").slice(0, 240);
        matches.push(`${relative}:${index + 1}: ${preview}`);
      }
    }
    return matches;
  }

  private async searchWithRipgrep(input: SearchFilesInput, limit: number): Promise<string[] | null> {
    const absoluteStart = await this.resolveInside(input.path ?? ".");
    const relativeStart = normalizeRelative(path.relative(this.root, absoluteStart));
    const excludedGlobs = [...DEFAULT_IGNORED_DIRECTORIES]
      .flatMap((directory) => [`!${directory}/**`, `!**/${directory}/**`]);
    const sensitiveGlobs = [
      ...[...SENSITIVE_FILE_NAMES].map((name) => `!**/${name}`),
      "!**/.env.*",
      ...[...SENSITIVE_FILE_EXTENSIONS].map((extension) => `!**/*${extension}`),
    ];
    const args = [
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--max-filesize",
      `${MAX_FILE_BYTES}`,
      ...excludedGlobs.flatMap((glob) => ["--glob", glob]),
      ...sensitiveGlobs.flatMap((glob) => ["--glob", glob]),
      "--",
      input.query,
      relativeStart,
    ];

    return new Promise<string[] | null>((resolve, reject) => {
      const child = spawn("rg", args, {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const matches: string[] = [];
      const pattern = input.pattern?.toLocaleLowerCase();
      let pending = "";
      let errorOutput = "";
      let settled = false;
      let stoppedAtLimit = false;

      const finish = (value: string[] | null): void => {
        if (settled) return;
        settled = true;
        value?.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
        resolve(value);
      };

      const consume = (line: string): void => {
        if (!line || matches.length >= limit) return;
        let event: {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          return;
        }
        if (event.type !== "match") return;
        const rawFile = event.data?.path?.text?.split(path.sep).join("/");
        const file = rawFile?.startsWith("./") ? rawFile.slice(2) : rawFile;
        const lineNumber = event.data?.line_number;
        if (!file || !lineNumber || isExcludedRelative(file)) return;
        if (pattern && !file.toLocaleLowerCase().includes(pattern)) return;
        const preview = (event.data?.lines?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 240);
        matches.push(`${file}:${lineNumber}: ${preview}`);
        if (matches.length >= limit) {
          stoppedAtLimit = true;
          child.kill();
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) consume(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        errorOutput += chunk;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") finish(null);
        else if (!settled) reject(error);
      });
      child.on("close", (code) => {
        consume(pending);
        if (stoppedAtLimit || code === 0 || code === 1) finish(matches);
        else if (!settled) reject(new Error(`ripgrep search failed${errorOutput.trim() ? `: ${errorOutput.trim()}` : ` (exit ${code})`}`));
      });
    });
  }

  private async resolveInside(value: string): Promise<string> {
    const candidate = path.resolve(this.root, value);
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the workspace: ${value}`);
    }
    if (isExcludedRelative(relative)) throw new Error(`Path is excluded from local tools: ${value}`);
    const real = await fs.realpath(candidate);
    const realRelative = path.relative(this.root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Path resolves outside the workspace: ${value}`);
    }
    if (isExcludedRelative(realRelative)) throw new Error(`Path is excluded from local tools: ${value}`);
    return real;
  }
}
