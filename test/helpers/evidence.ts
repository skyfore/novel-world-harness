import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceStore, type SourceDocument } from "../../src/storage/workspace-store.js";
import type { EvidenceRef } from "../../src/world/model.js";

export async function createEvidenceFixture(root: string, content: string, fileName = "novel.txt"): Promise<{
  source: SourceDocument;
  evidence: (quote: string, occurrence?: number) => EvidenceRef[];
}> {
  const absolute = path.join(root, fileName);
  await fs.writeFile(absolute, content, "utf8");
  const store = await WorkspaceStore.create(root);
  const source = await store.registerSource(absolute);
  const buffer = Buffer.from(content, "utf8");

  return {
    source,
    evidence(quote: string, occurrence = 0): EvidenceRef[] {
      const needle = Buffer.from(quote, "utf8");
      let startByte = -1;
      let searchFrom = 0;
      for (let index = 0; index <= occurrence; index += 1) {
        startByte = buffer.indexOf(needle, searchFrom);
        if (startByte < 0) throw new Error(`Quote not found in evidence fixture: ${quote}`);
        searchFrom = startByte + needle.length;
      }
      const endByte = startByte + needle.length;
      const prefix = buffer.subarray(0, startByte).toString("utf8");
      const selected = buffer.subarray(startByte, endByte).toString("utf8");
      const startLine = prefix.split(/\r\n|\r|\n/).length;
      const endLine = startLine + selected.split(/\r\n|\r|\n/).length - 1;
      return [{
        span: {
          sourceId: source.id,
          startByte,
          endByte,
          startLine,
          endLine,
          quoteHash: crypto.createHash("sha256").update(needle).digest("hex"),
        },
        strength: "explicit",
      }];
    },
  };
}
