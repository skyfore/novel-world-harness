import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { ModelRequestBudget } from "../src/runtime/model-request-budget.js";
import { contentHash as h } from "../src/world/canonical.js";
import { identityUpstreamSessionContract, sealIdentityUpstreamSession, verifyIdentityUpstreamSession } from "../src/compiler/identity-upstream-session.js";
import { mockPiProvider } from "./helpers/pi-provider.js";

it("seals actual Pi staging with its one corrected attempt and detects a changed request journal without redispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-identity-upstream-session-")), stage = "unknown", contract = identityUpstreamSessionContract("entity");
  const requests = path.join(root, `${stage}.requests.jsonl`), messages = path.join(root, `${stage}.messages.jsonl`);
  let session: PiAgentSession | undefined;
  try {
    await fs.writeFile(requests, ""); await fs.writeFile(messages, ""); let sequence = 0;
    const input = { task: "synthetic staging fixture", target: "unknown" }, prompt = JSON.stringify(input), budget = new ModelRequestBudget({ maxModelCalls: 4, maxRequestBytes: 512000, maxTotalPayloadBytes: 2048000 });
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
    const tools = [defineTool({ name: "read_upstream_repair_context", label: "Read fixture", description: "Read fixture ids", parameters: Type.Object({}),
      async execute() { return result({ readable: [{ id: "unknown", payload: { id: "unknown", canonicalName: "Someone" } }] }); } }),
    defineTool({ name: "propose_entity", label: "Stage fixture", description: "Copy exact discovered ID for one correction", parameters: Type.Object({ proposal_json: Type.String() }),
      async execute(_id, input) { if (JSON.parse(input.proposal_json).id !== "unknown") throw new Error("Read read_upstream_repair_context and copy readable[].id once; no unchanged retry.");
        return { ...result({ staged: true }), terminate: true }; } })];
    const observe = (phase: string, value: unknown) => fs.appendFile(requests, JSON.stringify({ phase, value }) + "\n");
    session = await PiAgentSession.create({ workspace: await LocalFileWorkspace.create(root), piAgentDir: path.join(root, "pi"), runtimeDir: path.join(root, "sessions", stage),
      saveSession: true, trackLastOpenedSession: false, autoCompaction: false, includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false,
      interactionMode: "compiler", requestBudget: budget, additionalTools: tools, losslessJsonReadTools: [...contract.readTools],
      onLosslessContext: value => observe("original-context", value), onRequestObservation: ({ phase, value }) => observe(phase, value),
      onEvent: event => { if (event.type === "message_end") appendFileSync(messages, JSON.stringify({ sequence: ++sequence, message: event.message }) + "\n"); } });
    const provider = await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
      if (index > 2) throw Error("Unexpected retry");
      return fauxAssistantMessage([index === 1 ? fauxToolCall("read_upstream_repair_context", {}, { id: "discover" })
        : fauxToolCall("propose_entity", { proposal_json: JSON.stringify({ id: index === 0 ? "wrong" : "unknown" }) }, { id: `stage-${index}` })], { stopReason: "toolUse" });
    } });
    await fs.writeFile(path.join(root, `${stage}.input.json`), JSON.stringify(input));
    await session.promptWithReport(prompt); await session.dispose(); budget.close();
    const planHash = h("same-plan"), checkpoint = await sealIdentityUpstreamSession(root, root, stage, { planHash, sessionId: session.id,
      sessionFile: session.sessionFile!, traceRunId: "fixture-trace", contract, prompt, usage: budget.snapshot(), providerUsage: budget.report().providerUsage });
    await fs.writeFile(path.join(root, `${stage}.budget.json`), JSON.stringify({ state: { usage: budget.snapshot(), blocked: false } }));
    const record = { planHash, sessionId: session.id, traceRunId: "fixture-trace", sessionCheckpointHash: h(checkpoint) };
    await expect(verifyIdentityUpstreamSession(root, root, stage, record, contract)).resolves.toMatchObject({ usage: { modelCalls: 3 } });
    expect(provider.contexts).toHaveLength(3);
    const saved = await fs.readFile(requests, "utf8"); await fs.writeFile(requests, saved.replace("unknown", "changed"));
    await expect(verifyIdentityUpstreamSession(root, root, stage, record, contract)).rejects.toThrow(/changed/);
    expect(provider.contexts).toHaveLength(3);
  } finally { await session?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
