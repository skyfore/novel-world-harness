// Offline SDK microbenchmark. Run unchanged against independently installed old/new checkouts.
// node --expose-gc test/manual/pi-upgrade-benchmark.mjs /absolute/checkout
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

assert(global.gc, "Run Node with --expose-gc.");
const root = path.resolve(process.argv[2]);
const moduleUrl = (pkg, file) => pathToFileURL(path.join(root, "node_modules/@earendil-works", pkg, "dist", file)).href;
const measured = operation => {
  const start = performance.now();
  const value = operation();
  return { ms: performance.now() - start, value };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
// WeakRef targets remain alive for their entire JS job, even across explicit GC.
// Observe retained memory after a real event-loop turn, as in streamed terminal use.
const memory = async () => { await nextTurn(); global.gc(); await nextTurn(); return process.memoryUsage(); };
const coldStart = performance.now();
const { SessionManager } = await import(moduleUrl("pi-coding-agent", "index.js"));
const coldImportMs = performance.now() - coldStart;
const warmStart = performance.now();
await import(moduleUrl("pi-coding-agent", "index.js"));
const warmImportMs = performance.now() - warmStart;
const { AssistantMessageComponent } = await import(moduleUrl("pi-coding-agent", "modes/interactive/components/assistant-message.js"));
const { initTheme } = await import(moduleUrl("pi-coding-agent", "modes/interactive/theme/theme.js"));
const search = await import(moduleUrl("pi-tui", "alt-screen-search.js"));
initTheme("dark", false);
const imported = await memory();
const paragraph = index => `### Scene ${index}\n\nMara reads the **world history** in the Hall. 世界事实来自已提交事件，叙述不能改写事实。\n\n- Stable identity\n- Evidence and knowledge\n\n`;
const longText = Array.from({ length: 1000 }, (_, index) => paragraph(index)).join("");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }],
  api: "openai-completions", provider: "fixture", model: "fixture", usage,
  stopReason: "stop", timestamp: 1 });
const manager = SessionManager.inMemory("/synthetic/pi-upgrade-benchmark");
for (let index = 0; index < 100; index++) {
  manager.appendMessage({ role: "user", content: `Read scene ${index}. ` + paragraph(index).repeat(4), timestamp: 1 });
  manager.appendMessage(assistant(paragraph(index).repeat(8)));
}
let payloadBytes = 0;
const assemble = () => {
  const context = manager.buildSessionContext();
  const payload = JSON.stringify({ systemPrompt: "Fixed benchmark prompt", messages: context.messages, tools: [] });
  payloadBytes = Buffer.byteLength(payload);
};
assemble();
const assemblyMs = measured(() => { for (let index = 0; index < 50; index++) assemble(); }).ms / 50;
const retainedBefore = await memory();
const component = new AssistantMessageComponent(assistant(longText), true);
const firstRender = measured(() => component.render(100));
const retainedAfter = await memory();
const cachedRenderMs = measured(() => { for (let index = 0; index < 100; index++) component.render(100); }).ms / 100;
const changedQueryMs = measured(() => {
  for (const query of ["world history", "Mara", "knowledge", "世界事实", "missing-token"])
    search.findAltScreenSearchMatches(firstRender.value, query);
}).ms / 5;
// Follow each version's actual full-screen search path, including 1.0's corpus cache.
const index = search.AltScreenSearchIndex ? new search.AltScreenSearchIndex() : undefined;
const searchSameQuery = () => index ? index.search(firstRender.value, "world history").matches
  : search.findAltScreenSearchMatches(firstRender.value, "world history");
const matches = searchSameQuery().length;
assert.equal(matches, 1000);
const repeatedSearchMs = measured(() => { for (let turn = 0; turn < 20; turn++) searchSameQuery(); }).ms / 20;
const streamed = new AssistantMessageComponent(undefined, true);
let streamingMs = 0;
for (let chunk = 1; chunk <= 40; chunk++) {
  streamingMs += measured(() => {
    streamed.updateContent(assistant(longText.slice(0, Math.floor(longText.length * chunk / 40))), true);
    streamed.render(100);
  }).ms;
  await nextTurn();
}
streamingMs += measured(() => {
  streamed.updateContent(assistant(longText), false);
  streamed.render(100);
}).ms;
const finalMemory = await memory();
const pkg = JSON.parse(await fs.readFile(path.join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
console.log(JSON.stringify({ version: pkg.version, node: process.version,
  workload: { width: 100, transcriptMessages: 200, assemblyIterations: 50, streamingUpdates: 40,
    markdownBytes: Buffer.byteLength(longText), sha256: createHash("sha256").update(longText).digest("hex"),
    payloadBytes, renderedLines: firstRender.value.length, matches },
  coldImportMs, warmImportMs, assemblyMs, firstRenderMs: firstRender.ms, cachedRenderMs,
  changedQueryMs, repeatedSearchMs, streamingMs,
  importedHeapBytes: imported.heapUsed, importedRssBytes: imported.rss,
  longMessageRetainedHeapBytes: retainedAfter.heapUsed - retainedBefore.heapUsed,
  finalHeapBytes: finalMemory.heapUsed, finalRssBytes: finalMemory.rss,
}));
