import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { choosePlayExperience, type AskPlayQuestion } from "../world/play-choice.js";
import { askUserQuestion } from "../util/ask-user-question.js";
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
  ask?: AskPlayQuestion;
};

export async function resumeCommand(options: ResumeCommandOptions): Promise<void> {
  const selection = await choosePlayExperience(options.root, {
    ...(options.branchId ? { branchId: options.branchId } : {}),
    ...(options.character ? { character: options.character } : {}),
  }, options.ask ?? askUserQuestion);
  if (!selection) return;
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
