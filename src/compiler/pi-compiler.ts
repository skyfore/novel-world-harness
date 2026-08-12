import { PiAgentSession, type PiLiveTestOptions } from "../agent/pi-session.js";
import type { LlmProfile } from "../config/schema.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";

export type PiCompilerOptions = {
  root: string;
  profile?: LlmProfile;
  model?: string;
  saveSession?: boolean;
  onText?: (delta: string) => void;
  onTool?: (name: string, input: unknown) => void;
  liveTest?: PiLiveTestOptions;
  segmentIds?: readonly string[];
  includeLocalTools?: boolean;
};

export const DEFAULT_COMPILER_LIVE_MAX_REQUESTS = 64;
export const DEFAULT_COMPILER_LIVE_MAX_OUTPUT_TOKENS = 16_384;

export function compilerLiveTestOptions(options?: PiLiveTestOptions): PiLiveTestOptions | undefined {
  return options ? {
    ...options,
    maxRequests: options.maxRequests ?? DEFAULT_COMPILER_LIVE_MAX_REQUESTS,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_COMPILER_LIVE_MAX_OUTPUT_TOKENS,
  } : undefined;
}

export async function createPiCompilerSession(options: PiCompilerOptions): Promise<PiAgentSession> {
  const workspace = await LocalFileWorkspace.create(options.root);
  const generatedBy: { provider?: string; model?: string } = {};
  if (options.profile?.provider) generatedBy.provider = options.profile.provider;
  if (options.model ?? options.profile?.model) generatedBy.model = options.model ?? options.profile?.model;
  const proposalToolset = createCompilerProposalToolset(workspace.root, generatedBy);
  proposalToolset.beginBatch(options.segmentIds);
  const liveTest = compilerLiveTestOptions(options.liveTest);
  const includeLocalTools = options.includeLocalTools ?? true;
  return PiAgentSession.create({
    workspace,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    saveSession: options.saveSession ?? true,
    ...(options.onText ? { onText: options.onText } : {}),
    ...(options.onTool ? { onTool: options.onTool } : {}),
    ...(liveTest ? { liveTest } : {}),
    interactionMode: "compiler",
    includeLocalTools,
    additionalTools: proposalToolset.tools,
    resetCompilerProposalTools: proposalToolset.beginBatch,
    systemPromptAppendix: includeLocalTools
      ? `Compiler mode is enabled. Use read-only local evidence tools to inspect the novel, then use only the typed propose_* tools for candidate structured artifacts. A proposal is not canonical truth and must not be described as committed. Prefer small evidence-backed proposals over broad unsupported extraction. Never use future canonical events as actor knowledge or runtime branch truth.`
      : `Compiler batch mode is enabled. The host has supplied the complete allowed evidence slice in the user context. Do not list, search, or read workspace files and do not use facts outside that slice. Use only the typed propose_* tools for candidate structured artifacts. A proposal is not canonical truth and must not be described as committed. Prefer small evidence-backed proposals over broad unsupported extraction. Never use future canonical events as actor knowledge or runtime branch truth.`,
  });
}
