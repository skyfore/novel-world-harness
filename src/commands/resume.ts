import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { selectPlayExperience } from "../world/play-experience.js";
import { playCommand } from "./play.js";

export type ResumeCommandOptions = {
  root: string;
  configPath: string;
  branchId?: string;
  character?: string;
  model?: string;
  tuiMode?: TuiMode;
  continueSession?: boolean;
  saveSession?: boolean;
};

export async function resumeCommand(options: ResumeCommandOptions): Promise<void> {
  await selectPlayExperience(options.root, {
    ...(options.branchId ? { branchId: options.branchId } : {}),
    ...(options.character ? { character: options.character } : {}),
  });
  await playCommand({
    root: options.root,
    configPath: options.configPath,
    allowMissingConfig: true,
    ...(options.model ? { model: options.model } : {}),
    ...(options.tuiMode ? { tuiMode: options.tuiMode } : {}),
    continueSession: options.continueSession,
    saveSession: options.saveSession,
  });
}
