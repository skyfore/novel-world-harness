import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".novel-harness",
  ".aws",
  ".ssh",
  "coverage",
  "dist",
  "node_modules",
]);

const SENSITIVE_FILE_NAMES = new Set([".env", ".netrc", ".npmrc", ".pypirc"]);
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

function isExcludedRelative(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized === "." || normalized === ".novel-harness/instructions.md") return false;
  const parts = normalized.split("/");
  if (parts.some((part) => DEFAULT_IGNORED_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1) ?? "";
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
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
        if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
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
    const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
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

  async searchFiles(input: SearchFilesInput): Promise<string[]> {
    const query = input.query.trim();
    if (!query) throw new Error("Search query cannot be empty.");
    const limit = clamp(input.maxResults, 20, MAX_SEARCH_RESULTS);
    const files = await this.listFiles({
      path: input.path,
      pattern: input.pattern,
      maxResults: MAX_LIST_RESULTS,
    });
    const normalizedQuery = query.toLocaleLowerCase();
    const matches: string[] = [];

    for (const relative of files) {
      if (matches.length >= limit) break;
      const absolute = await this.resolveInside(relative);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(absolute);
      if (looksBinary(buffer)) continue;
      const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index] ?? "";
        if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;
        const preview = line.trim().replace(/\s+/g, " ").slice(0, 240);
        matches.push(`${relative}:${index + 1}: ${preview}`);
      }
    }
    return matches;
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
