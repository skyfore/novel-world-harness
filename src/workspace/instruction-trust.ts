import fs from "node:fs/promises";
import path from "node:path";
import { LocalFileWorkspace } from "./local-files.js";

/**
 * One physical workspace file cannot simultaneously be trusted harness
 * guidance and untrusted novel evidence. Compare real paths so aliases and
 * symlinks cannot cross the boundary.
 */
export async function assertSourceIsNotProjectInstruction(
  workspaceRoot: string,
  sourcePath: string,
  configuredInstructionPaths: readonly string[] = [],
): Promise<void> {
  if (!configuredInstructionPaths.length) return;
  const workspace = await LocalFileWorkspace.create(workspaceRoot);
  const sourceRealPath = await fs.realpath(path.resolve(sourcePath));
  for (const instructionPath of configuredInstructionPaths) {
    // Reuse the exact host-only path policy used when loading instructions.
    await workspace.readProjectInstruction(instructionPath);
    const instructionRealPath = await fs.realpath(path.resolve(workspace.root, instructionPath));
    if (instructionRealPath === sourceRealPath) {
      throw new Error(
        `Cannot register '${instructionPath}' as novel evidence because it is configured as trusted project guidance. Remove it from project.instructions or choose a different source file.`,
      );
    }
  }
}
