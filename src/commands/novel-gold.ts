import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadReferencePack } from "../compiler/reference-pack.js";
import { draftGoldSliceFromReference, scoreGoldSlice } from "../eval/gold-slice.js";
import { loadNovelCutsBundle } from "./novel-cuts.js";
import { parseByteRange } from "./novel-completeness.js";

/** Write a gold-slice draft from a legacy reference pack. Every record starts unconfirmed. */
export async function novelGoldDraftCommand(options: { reference: string; range: string; name: string; out: string }): Promise<void> {
  const directory = path.resolve(options.reference);
  const pack = await loadReferencePack(directory);
  const manifestSha256 = crypto.createHash("sha256").update(await fs.readFile(path.join(directory, "manifest.json"))).digest("hex");
  const slice = draftGoldSliceFromReference(pack, parseByteRange(options.range), { name: options.name, directory, manifestSha256 });
  const out = path.resolve(options.out);
  await fs.writeFile(out, `${JSON.stringify(slice, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ out, mentions: slice.gold.semantic.mentions.length, quotations: slice.gold.semantic.quotations.length,
    entityClusters: slice.gold.semantic.entityClusters.length, eventClusters: slice.gold.semantic.eventClusters.length, unconfirmed: "all" }, null, 2));
}

/** Score the current candidate (or a revision) on a gold slice. Read-only. */
export async function novelGoldScoreCommand(options: { root: string; file: string; sourceId?: string; revision?: string; allowDraft?: boolean }): Promise<void> {
  const root = path.resolve(options.root);
  const input = JSON.parse(await fs.readFile(path.resolve(options.file), "utf8")) as { source?: { id?: string } };
  const loaded = await loadNovelCutsBundle({ root, sourceId: options.sourceId ?? input.source?.id, ...(options.revision ? { revision: options.revision } : {}) });
  console.log(JSON.stringify(await scoreGoldSlice(root, loaded.bundle, input, { allowDraft: Boolean(options.allowDraft) }), null, 2));
}
