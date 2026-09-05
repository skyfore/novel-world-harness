import { stdout } from "node:process";
import { auditCompiler } from "../compiler/audit.js";

export async function auditCommand(root: string, sourceId?: string): Promise<void> {
  const report = await auditCompiler(root, { sourceId });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.sources.changedSinceIngest.length || report.evidence.invalidReferences || report.consistency.causalGraphValid === false) {
    process.exitCode = 5;
  }
}
