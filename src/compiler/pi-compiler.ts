import { PiAgentSession, type PiAgentSessionOptions } from "../agent/pi-session.js";
import type { LlmProfile } from "../config/schema.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";

export const SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS = new Set(["propose_world_rule"]);

export type PiCompilerOptions = {
  root: string;
  profile?: LlmProfile;
  model?: string;
  saveSession?: boolean;
  onText?: (delta: string) => void;
  onTool?: (name: string, input: unknown) => void;
  onRetry?: PiAgentSessionOptions["onRetry"];
  segmentIds?: readonly string[];
  includeLocalTools?: boolean;
};

export async function createPiCompilerSession(options: PiCompilerOptions): Promise<PiAgentSession> {
  const workspace = await LocalFileWorkspace.create(options.root);
  const generatedBy: { provider?: string; model?: string } = {};
  if (options.profile?.provider) generatedBy.provider = options.profile.provider;
  if (options.model ?? options.profile?.model) generatedBy.model = options.model ?? options.profile?.model;
  const proposalToolset = createCompilerProposalToolset(workspace.root, generatedBy);
  proposalToolset.beginBatch(options.segmentIds);
  const includeLocalTools = options.includeLocalTools ?? true;
  return PiAgentSession.create({
    workspace,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    saveSession: options.saveSession ?? true,
    ...(options.onText ? { onText: options.onText } : {}),
    ...(options.onTool ? { onTool: options.onTool } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    interactionMode: "compiler",
    includeLocalTools,
    additionalTools: options.segmentIds
      ? proposalToolset.tools.filter((tool) => !SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS.has(tool.name))
      : proposalToolset.tools,
    resetCompilerProposalTools: proposalToolset.beginBatch,
    systemPromptAppendix: includeLocalTools
      ? `Compiler mode is enabled. Use read-only local evidence tools to inspect the novel, then use only the typed propose_* tools for candidate structured artifacts. A proposal is not canonical truth and must not be described as committed. Prefer small evidence-backed proposals over broad unsupported extraction. Never use future canonical events as actor knowledge or runtime branch truth.`
      : `Compiler batch mode is enabled. The host has supplied the complete allowed evidence slice in the user context. Do not list, search, or read workspace files and do not use facts outside that slice. Use only the typed propose_* tools for candidate structured artifacts. A proposal is not canonical truth and must not be described as committed. Prefer small evidence-backed proposals over broad unsupported extraction. Never use future canonical events as actor knowledge or runtime branch truth.`,
  });
}
