import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { identityContextRecoverySchema } from "../src/compiler/identity-context-recovery.js";
import { identityEngineeringHistory, identityEngineeringLineage } from "../src/runtime/compile-loop/identity-engineering-accounting.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";
import { digest } from "../src/runtime/compile-loop/workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nwh-engineering-history-")); roots.push(root);
  const engineering = path.join(root, "original"); fs.mkdirSync(engineering);
  const stop = { phase: "BREAK", childPid: null, workerDispatches: 0, commands: 1, engineeringTurns: 1 };
  write(path.join(engineering, "state.json"), stop);
  const proof = identityContextRecoverySchema.options[1].parse({ version: 2, policy: "identity-context-reconstruction/v1",
    sourceId: "same-source", taskId: contentHash("same-task"), originalSpecHash: contentHash("same-spec"), intentHash: contentHash("intent"),
    engineeringStateHash: digest(stop), retainedEngineeringFiles: captureRecordTree(engineering), failedTraceHash: contentHash("failed trace"),
    mode: "reread-immutable-evidence-with-remaining-budget", authorizedAt: new Date().toISOString(), authorizationRef: "explicit later authorization", engineeringHistory: [] });
  const append = (mode: "local" | "cumulative", commands: number, engineeringTurns = 0) => {
    const previous = identityEngineeringHistory(proof, engineering), directory = path.join(root, `attempt-${proof.engineeringHistory.length}`);
    fs.mkdirSync(directory);
    const total = { commands: previous.usage.commands + commands, engineeringTurns: previous.usage.engineeringTurns + engineeringTurns };
    const state = { phase: "BREAK", childPid: null, workerDispatches: 0, ...(mode === "cumulative" ? total : { commands, engineeringTurns }),
      budgetLineage: { ...identityEngineeringLineage(proof, previous.head, previous.usage, total), mode } };
    write(path.join(directory, "state.json"), state);
    proof.engineeringHistory.push({ directory, stateFile: "state.json", accounting: mode, files: captureRecordTree(directory) });
    return state;
  };
  return { proof, engineering, append };
}

it("derives every charge once from scoped local deltas and verifies cumulative totals", () => {
  const f = fixture(); f.append("local", 2); f.append("cumulative", 4); f.append("local", 1, 1);
  expect(identityEngineeringHistory(f.proof, f.engineering).usage).toEqual({ commands: 8, engineeringTurns: 2 });
  const before = captureRecordTree(f.engineering); identityEngineeringHistory(f.proof, f.engineering);
  expect(captureRecordTree(f.engineering)).toEqual(before);
});

it.each(["label", "scope", "inherited", "local", "predecessor", "total", "unknown"] as const)("rejects %s accounting even when an importer pins its bytes", failure => {
  const f = fixture(), state = f.append("cumulative", 2), receipt = f.proof.engineeringHistory[0]!;
  if (failure === "label") receipt.accounting = "local";
  if (failure === "scope") state.budgetLineage.scope.taskId = contentHash("foreign task");
  if (failure === "inherited") state.budgetLineage.inherited.commands = 0;
  if (failure === "local") state.budgetLineage.local.commands = 0;
  if (failure === "predecessor") state.budgetLineage.predecessorHash = contentHash("missing prefix");
  if (failure === "total") state.commands--;
  if (failure === "unknown") delete (state as Partial<typeof state>).budgetLineage;
  write(path.join(receipt.directory, receipt.stateFile), state); receipt.files = captureRecordTree(receipt.directory);
  expect(() => identityEngineeringHistory(f.proof, f.engineering)).toThrow(/accounting lineage/);
});

it.each(["omit", "reorder", "duplicate", "change", "delete"] as const)("rejects %s of an imported attempt without guessing or renewing counters", failure => {
  const f = fixture(); f.append("local", 1); f.append("cumulative", 2);
  if (failure === "omit") f.proof.engineeringHistory.shift();
  if (failure === "reorder") f.proof.engineeringHistory.reverse();
  if (failure === "duplicate") f.proof.engineeringHistory.push(f.proof.engineeringHistory[0]!);
  const first = f.proof.engineeringHistory[0]!;
  if (failure === "change") fs.appendFileSync(path.join(first.directory, first.stateFile), " ");
  if (failure === "delete") fs.unlinkSync(path.join(first.directory, first.stateFile));
  expect(() => identityEngineeringHistory(f.proof, f.engineering)).toThrow();
});
