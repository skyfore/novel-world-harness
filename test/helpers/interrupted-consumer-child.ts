import fs from "node:fs/promises";
import path from "node:path";
import { PiAgentSession } from "../../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../../src/workspace/local-files.js";
import { runReceiptBoundPiStage } from "../../src/workflow/receipt-bound-pi-stage.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
import { contentHash } from "../../src/world/canonical.js";
import { consumerWorkContract, consumerWorkInput, workBudgetPolicy } from "../../src/compiler/consumer-work-plan.js";
import { mockPiProvider } from "./pi-provider.js";

const [root, directory] = process.argv.slice(2) as [string, string];
const stage = "consumer-revalidation", plan = JSON.parse(await fs.readFile(path.join(directory, `${stage}.plan.json`), "utf8"));
const scope = JSON.parse(await fs.readFile(path.join(path.dirname(directory), "scope.json"), "utf8"));
const original = PiAgentSession.create;
PiAgentSession.create = async options => {
  const session = await original({ ...options, model: undefined, piAgentDir: path.join(root, "pi") });
  await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: async () => {
    await fs.writeFile(path.join(root, "request-sent"), "ready");
    // Keep the provider request outstanding until the parent kills this host.
    await new Promise(() => { setInterval(() => {}, 1000); });
    throw new Error("unreachable");
  } });
  return session;
};
await withWorkspaceOperationLock(root, "compiler", () => runReceiptBoundPiStage({ root, sourceId: scope.sourceId, directory, stage,
  scopeHash: contentHash(scope), originalBudgetHash: scope.originalBudgetHash, priorUsage: plan.priorUsage,
  limits: plan.limits, contract: consumerWorkContract, executionPlanHash: contentHash(plan), workBudgetPolicy: workBudgetPolicy(plan),
  assertOriginal: async () => {}, run: async factory => {
    const session = await factory({ workspace: await LocalFileWorkspace.create(root), interactionMode: "compiler", systemPromptOverride: "Read the supplied fixture evidence." });
    return session.promptWithReport(JSON.stringify(consumerWorkInput(plan)));
  } }));
