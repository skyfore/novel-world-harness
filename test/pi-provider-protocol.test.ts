import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { ModelRequestBudget } from "../src/agent/model-request-budget.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function openaiStream(tool: boolean) {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "fixture-response", object: "chat.completion.chunk", model: "fixture", created: 1,
    choices: [{ index: 0, delta, finish_reason }] });
  const chunks = tool ? [chunk({ role: "assistant", reasoning_content: "fixture thinking" }),
    chunk({ tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "read_source_evidence", arguments: '{"ref":"fixture-ref"}' } }] }),
    chunk({}, "tool_calls")] : [chunk({ role: "assistant", content: "PROTOCOL_OK" }), chunk({}, "stop")];
  return chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("")
    + `data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`;
}

function anthropicStream(tool: boolean) {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "fixture-response", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null,
      usage: { input_tokens: 7, output_tokens: 0 } } },
  ];
  if (tool) events.push(
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "fixture thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "fixture-call", name: "read_source_evidence", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ref":"fixture-ref"}' } },
    { type: "content_block_stop", index: 1 },
  );
  else events.push(
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROTOCOL_OK" } },
    { type: "content_block_stop", index: 0 },
  );
  events.push({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }, { type: "message_stop" });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe.each(["openai-completions", "anthropic-messages"] as const)("real Pi %s adapter", api => {
  it.each([false, true])("streams thinking, executes a typed tool and replays its result (error=%s)", async toolError => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-protocol-"));
    roots.push(root);
    vi.stubEnv("NWH_FIXTURE_API_KEY", "fixture-key-not-a-credential");
    const payloads: unknown[] = [];
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      urls.push(request.url);
      payloads.push(JSON.parse(await request.text()));
      const first = payloads.length === 1;
      return new Response(api === "openai-completions" ? openaiStream(first) : anthropicStream(first),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const events: AgentSessionEvent[] = [];
    const called = vi.fn(async (_id: string, input: { ref: string }) => {
      expect(input).toEqual({ ref: "fixture-ref" });
      if (toolError) throw new Error("Unknown source evidence ref fixture-ref");
      return { content: [{ type: "text" as const, text: "FIXTURE_EVIDENCE" }], details: {} };
    });
    const budget = new ModelRequestBudget({ maxModelCalls: 3, maxRequestBytes: 500_000, maxTotalPayloadBytes: 1_000_000 });
    const session = await PiAgentSession.create({ workspace: await LocalFileWorkspace.create(root),
      piAgentDir: path.join(root, "pi"), runtimeDir: path.join(root, "runtime"), saveSession: false,
      includeLocalTools: false, includeNwhExtension: false, requestBudget: budget,
      profile: { provider: "protocol-fixture", model: "fixture", baseUrl: "https://provider.invalid/v1", apiProtocol: api,
        apiKeyEnv: "NWH_FIXTURE_API_KEY", maxTokens: 1000, contextWindow: 100_000, thinkingLevel: "off" },
      additionalTools: [defineTool({ name: "read_source_evidence", label: "Evidence", description: "Read fixture evidence", parameters: Type.Object({ ref: Type.String() }),
        executionMode: "sequential", execute: called })],
      onEvent: event => { events.push(event); },
    });
    try {
      expect(await session.prompt("read fixture evidence")).toBe("PROTOCOL_OK");
      expect(called).toHaveBeenCalledOnce();
      expect(payloads).toHaveLength(2);
      expect(urls.every(url => url.startsWith("https://provider.invalid/v1/"))).toBe(true);
      expect(JSON.stringify(payloads)).not.toContain(root);
      expect(JSON.stringify(payloads[1])).toContain(toolError ? "<nwh-tool-recovery>" : "FIXTURE_EVIDENCE");
      expect(events.some(event => event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta")).toBe(true);
      expect(events.find(event => event.type === "tool_execution_end")).toMatchObject({ isError: toolError });
      expect(budget.snapshot()).toMatchObject({ modelCalls: 2, payloads: 2 });
      expect(budget.report().providerUsage).toMatchObject({ reports: 2, input: 14, output: 6 });
    } finally { await session.dispose(); }
  });
});
