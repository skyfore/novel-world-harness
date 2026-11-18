import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestWorkspaceSource } from "../../src/commands/ingest.js";
import { ScriptedStageAgent, type ScriptedCall, type StageAgentInput } from "../../src/compiler/pipeline/agent.js";
import type { StageContext } from "../../src/compiler/pipeline/runner.js";
import { PipelineStore } from "../../src/compiler/pipeline/store.js";

/** Original micro novel (no third-party text). */
export const BELL_TOWER = [
  "第一章 钟楼",
  "",
  "林岐站在钟楼下。“第七声钟就要响了。”林岐说。",
  "墨砚跑过来。“银钥在哪里？”墨砚问。",
  "“在我这里。”林岐说，“你拿去吧。”",
  "墨砚接过银钥。“谢谢你。”墨砚说。",
  "他们一起走向北门。",
  "“快走！”林岐说。“好。”墨砚说。",
  "",
].join("\n");

export async function pipelineWorkspace(text = BELL_TOWER) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pipeline-"));
  const file = path.join(root, "novel.txt");
  await fs.writeFile(file, text);
  const { document } = await ingestWorkspaceSource(root, file);
  return { root, source: document, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export function stageContext(root: string, sourceId: string, script: (input: StageAgentInput, call: ScriptedCall) => Promise<void>, limit = Number.MAX_SAFE_INTEGER): StageContext & { agent: ScriptedStageAgent } {
  return { root, sourceId, limit, agent: new ScriptedStageAgent(script), store: new PipelineStore(root, sourceId), runId: "run-test", generatedBy: { provider: "test", model: "scripted" }, report: () => undefined };
}

/** Call a tool and fail loudly if it errors or reports item failures. */
export async function must(call: ScriptedCall, name: string, input: unknown): Promise<any> {
  const result = await call(name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.text}`);
  const failed = (result.details as { failed?: unknown[] } | null)?.failed;
  if (failed?.length) throw new Error(`${name} item failures: ${JSON.stringify(failed)}`);
  return result.details;
}
