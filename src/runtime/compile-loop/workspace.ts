import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const excluded = new Set([".git", "node_modules", "dist", "coverage", "test-results", "playwright-report", "run-records"]);
export const fixedTests = ["test/compile-loop.test.ts", "test/compiler-finish-recovery.test.ts",
  "test/compiler-prompt-recovery.test.ts", "test/compiler-host-review-recovery.test.ts"];
export const protectedPaths = ["src/cli.ts", "src/runtime/compile-loop/", "src/commands/compile-novel-loop.ts",
  "src/runtime/model-request-budget.ts", "src/workflow/role-validated-progress.ts", "src/compiler/status.ts",
  "src/compiler/certification.ts", "src/compiler/novel-certification.ts", ...fixedTests];

/** Hash the actual working tree, including pre-existing edits. Never use HEAD as a repair baseline. */
export function captureWorkspace(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const file = path.posix.join(relative, entry.name), absolute = path.join(root, file);
      if (entry.isSymbolicLink()) files[file] = `symlink:${readlinkSync(absolute)}`;
      else if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[file] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  };
  visit(""); return files;
}
export function changes(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).sort();
}
export function assertPatchScope(files: string[], before: Record<string, string>, after: Record<string, string>) {
  const invalid = files.filter(file => !(file.startsWith("src/") || file.startsWith("test/") || file === "docs/agent-tool-recovery.md")
    || protectedPaths.some(p => p.endsWith("/") ? file.startsWith(p) : file === p)
    || before[file]?.startsWith("symlink:") || after[file]?.startsWith("symlink:"));
  if (invalid.length) throw new Error(`COMPILE_LOOP_PATCH_SCOPE: ${invalid.join(", ")}; preserve the diff for host review; do not retry or revert user work.`);
}
export function baselineContents(root: string, files: Record<string, string>) {
  const result: Record<string, string> = {}; let bytes = 0;
  for (const [file, hash] of Object.entries(files)) {
    if (hash.startsWith("symlink:") || !(file.startsWith("src/") || file.startsWith("test/") || file === "docs/agent-tool-recovery.md")) continue;
    const content = readFileSync(path.join(root, file)); bytes += content.length;
    if (bytes > 32_000_000) throw new Error("COMPILE_LOOP_BASELINE_TOO_LARGE: retain state and narrow the repair scope before continuing.");
    result[file] = content.toString("base64");
  }
  return result;
}
