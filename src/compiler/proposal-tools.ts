import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CompilerProposalService, type CompilerProposalKind } from "./proposals.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

const labels: Record<CompilerProposalKind, { name: string; label: string; description: string }> = {
  entity: { name: "propose_entity", label: "Propose entity", description: "Submit a typed entity candidate backed by source evidence. This creates a pending proposal only." },
  claim: { name: "propose_claim", label: "Propose claim", description: "Submit an evidence-backed claim candidate. This does not commit canonical truth." },
  "canonical-event": { name: "propose_canonical_event", label: "Propose canonical event", description: "Submit a source-observed canonical event candidate with preconditions and deterministic outcome delta." },
  "world-rule": { name: "propose_world_rule", label: "Propose world rule", description: "Submit a temporal in-world rule candidate. Engine invariants cannot be modified through this tool." },
  "state-delta": { name: "propose_state_delta", label: "Propose state delta", description: "Submit a deterministic state-delta candidate for later validation. This never moves a branch head." },
  possibility: { name: "propose_possibility", label: "Propose possibility", description: "Submit an uncommitted future possibility template with conditions, blockers and optional candidate effects." },
};

export function createCompilerProposalTools(workspaceRoot: string, generatedBy: { provider?: string; model?: string } = {}): ToolDefinition[] {
  const service = new CompilerProposalService(workspaceRoot);
  return (Object.keys(labels) as CompilerProposalKind[]).map((kind) => {
    const metadata = labels[kind];
    return defineTool({
      name: metadata.name,
      label: metadata.label,
      description: metadata.description,
      promptSnippet: metadata.description,
      promptGuidelines: [
        "Search/read source evidence before proposing.",
        "Never claim a proposal is committed world truth.",
        "Use stable logical IDs and include precise evidence in the payload where the schema requires it.",
      ],
      parameters: Type.Object(
        {
          proposal_id: Type.String({ minLength: 1 }),
          payload: Type.Any({ description: `Payload validated against the ${kind} runtime schema.` }),
          evidence: Type.Optional(Type.Array(Type.Any(), { description: "Additional SourceSpan evidence for the proposal envelope." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        const accepted = await service.submit(kind, {
          proposalId: input.proposal_id,
          payload: input.payload,
          evidence: input.evidence,
          generatedBy: { worker: metadata.name, ...generatedBy },
        });
        return textResult(`Pending ${accepted.kind} proposal ${accepted.proposalId} recorded. It is not committed truth.`);
      },
    });
  });
}
