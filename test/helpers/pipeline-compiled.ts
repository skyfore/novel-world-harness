import { PipelineStore } from "../../src/compiler/pipeline/store.js";
import { prepareSourceStage } from "../../src/compiler/pipeline/source-stage.js";
import { SourceStructureStore, baseStructuralUnits } from "../../src/compiler/structure.js";
import type { SourceDocument } from "../../src/storage/workspace-store.js";

/**
 * Hand-authored fixtures skip the model stages. Record the source as compiled
 * through the whole text and close every narrative unit without an
 * annotation as reviewed background, so the candidate builder and the cut
 * horizon accept the fixture exactly as they accept a compiled source.
 */
export async function markPipelineCompiled(root: string, source: SourceDocument): Promise<void> {
  await prepareSourceStage(root, source);
  const store = new PipelineStore(root, source.id);
  const now = new Date().toISOString();
  await store.writeRun({ version: 1, sourceId: source.id, limit: source.bytes, startedAt: now, updatedAt: now });
  const structure = await new SourceStructureStore(root).read(source.id);
  if (!structure) return;
  await store.recordUnitAccounts(baseStructuralUnits(structure).filter((unit) => unit.kind !== "non-scene")
    .map((unit) => ({ unitId: unit.id, status: "background-only" as const, rationale: "Hand-authored fixture: no observation pass.", scopeId: "fixture" })));
}
