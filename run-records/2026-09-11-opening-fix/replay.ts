import fs from "node:fs/promises";
import { initialWorldInputIssues } from "../../src/compiler/initial-world-preflight.js";
import { inspectCompilerStatus } from "../../src/compiler/status.js";
const base = new URL("../2026-09-11-opening-block-review/initial-world-attempts.json", import.meta.url);
const ledger = JSON.parse(await fs.readFile(base, "utf8"));
const attempts = ledger.attempts.filter((a: any) => a.status === "failed").map((a: any) => ({ inputHash: a.inputHash, issues: initialWorldInputIssues(a.input) }));
const status = await inspectCompilerStatus(process.cwd(), ledger.sourceId);
await fs.writeFile(new URL("validation.json", import.meta.url), JSON.stringify({ attempts, status }, null, 2) + "\n");
console.log(JSON.stringify({ attempts, progress: status.sources.map(s => ({ completed: s.completedBatches, total: s.totalBatches, supplemental: s.supplementalBatches })) }, null, 2));
