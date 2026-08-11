import { stdout } from "node:process";
import { auditCompiler } from "../compiler/audit.js";

export async function auditCommand(root: string): Promise<void> {
  const report = await auditCompiler(root);
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.sources.changedSinceIngest.length || report.evidence.invalidReferences || report.consistency.causalGraphValid === false) {
    process.exitCode = 5;
  }
}
