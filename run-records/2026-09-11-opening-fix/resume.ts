import { prepareAllCommand } from "../../src/commands/prepare-all.js";
import { compileCommand } from "../../src/commands/compile.js";
import { PreparedNovelCache } from "../../src/compiler/prepared-cache.js";
import { WorkspaceStore } from "../../src/storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16";
await withWorkspaceOperationLock(root, "compiler", async () => {
  await prepareAllCommand({ root, sourceId, model: "openai-codex/gpt-5.6-terra", yes: true,
    candidateOnly: true, createBranch: false, restoreCache: false, acquireLock: false }, {
    compileInitialWorld: options => compileCommand({ ...options, prompt: `${options.prompt}\n\nHost incident review: The original failed mention p-mention-opening-man is now corrected and pending as annotation mention-opening-man. Reuse it; do not duplicate it. The old envelopes p-mention-opening-man-v2, p-mention-opening-humanworld, p-entity-opening-humanworld, p-resolve-opening-man, p-resolve-opening-humanworld remain rejected history. If their logical artifacts are actually needed, first recheck source evidence and use fresh envelope IDs ending -fix0911, preserving logical IDs. Do not blindly reinstate old interpretations. The invalid initial-world inputs were host-reviewed as unsupported AS SUBMITTED (missing required fields), not as a valid world. Use p-initial-opening-world for the corrected initial proposal after preview_initial_world. Review all preview errors together. Do not guess stance holders, identities, locations, causal premises or future knowledge merely to satisfy schema. The corrected original mention still needs an evidence-supported identity resolution before finish.` }),
  });
  const source = (await (await WorkspaceStore.create(root)).listSources()).find(s => s.id === sourceId)!;
  const candidate = await new PreparedNovelCache(root).archiveCandidate(source);
  console.log(JSON.stringify({ sourceId, candidateBundleHash: candidate.bundleHash }, null, 2));
});
