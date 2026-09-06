import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { RoleRosterStore } from "../src/compiler/role-roster.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

it("requires full source reading and the real finish handshake before persisting a role review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-roster-tools-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero carries a letter.\n");
  await ensureSourceStructure(root, fixture.source);
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: fixture.evidence("Hero") });
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch([], `role-roster-${fixture.source.id}-review-1`, fixture.source.id);
  const call = async (name: string, input: unknown) => withNwhToolRecovery(toolset.tools.find((x) => x.name === name)!).execute(name, input as never, undefined, undefined, {} as ExtensionContext);
  const catalog = await call("read_role_roster", { offset: 0 });
  const data = JSON.parse((catalog.content[0] as { text: string }).text) as { subjectHash: string; candidates: Array<{ id: string }> };
  const premature = call("propose_role_roster_review", { subjectHash: data.subjectHash, entries: [{ candidateId: data.candidates[0]!.id, importance: "major", rationale: "Central action", basisUnitIds: ["guessed"] }] });
  await expect(premature).rejects.toThrow("read_roster_source_page");
  const page = await call("read_roster_source_page", { page: 0 });
  const units = JSON.parse((page.content[0] as { text: string }).text).unitIds as string[];
  await call("propose_role_roster_review", { subjectHash: data.subjectHash, entries: [{ candidateId: data.candidates[0]!.id, importance: "major", rationale: "Central action", basisUnitIds: [units[0]!] }] });
  expect(await new RoleRosterStore(root).read(fixture.source.id)).toBeNull();
  const finished = await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent whole-source character review complete" });
  expect(finished.isError).not.toBe(true);
  expect((await new RoleRosterStore(root).read(fixture.source.id))?.reviews).toHaveLength(1);
  await expect(call("propose_role_roster_review", { subjectHash: data.subjectHash, entries: [] })).rejects.toThrow("Do not retry in this scope");
});
