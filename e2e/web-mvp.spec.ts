import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { PreparationApplicationService } from "../src/application/preparation-service.js";
import { PlayApplicationService } from "../src/application/play-service.js";
import type { PlayerOpeningNarrator } from "../src/agent/pi-player-opening.js";
import type { CompileSourceOptions } from "../src/commands/compile-source.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../src/storage/workspace-store.js";
import { contextSnapshotSchema, type ContextPart } from "../src/trace/schema.js";
import { TraceStore } from "../src/trace/store.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import {
  deterministicPlayerIntentCandidate,
  type PlayerActionTranslationInput,
  type PlayerActionTranslator,
} from "../src/world/player-action.js";
import type { EvidenceRef, WorldRule } from "../src/world/model.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { createWebHost, type NwhWebHost } from "../src/web/host.js";
import { OperationManager } from "../src/web/operation-manager.js";

const SOURCE_TEXT = [
  "Mara waits in the Hall and listens to the rain.",
  "The Garden lies beyond the Hall, whose outer door must remain closed.",
  "Later, Mara considers crossing into the Garden.",
].join("\n");
const TRACE_CANARY = "playwright-provider-canary";

let workspaceRoot: string;
let app: NwhWebHost;
let origin: string;
let traceStore: TraceStore;
let previousNwhHome: string | undefined;

test.beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-e2e-"));
  previousNwhHome = process.env.NWH_HOME;
  process.env.NWH_HOME = path.join(workspaceRoot, "runtime");
  const events = new WebEventBroker();
  const operations = new OperationManager(events, { workspaceRoot });
  traceStore = new TraceStore(workspaceRoot);
  const preparation = new PreparationApplicationService({
    root: workspaceRoot,
    operations,
    events,
    traceStore,
    dependencies: {
      compileSource: seedBrowserCompilation,
    },
  });
  const play = new PlayApplicationService({
    root: workspaceRoot,
    operations,
    events,
    traceStore,
    translator: tracedTranslator(traceStore),
    narrator: tracedNarrator(traceStore),
    advanceBackground: 0,
  });
  app = await createWebHost({
    root: workspaceRoot,
    staticRoot: path.resolve("dist/web-ui"),
    eventBroker: events,
    operationManager: operations,
    traceStore,
    preparationService: preparation,
    playService: play,
    modelCatalogService: { read: async () => ({ providers: [], models: [] }) },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await app?.close();
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  if (previousNwhHome === undefined) delete process.env.NWH_HOME;
  else process.env.NWH_HOME = previousNwhHome;
});

test("runs the complete browser harness and exposes a verifiable play trace", async ({ page }) => {
  const browserDiagnostics: string[] = [];
  page.on("console", (message) => browserDiagnostics.push(message.text()));
  page.on("pageerror", (error) => browserDiagnostics.push(error.message));

  await page.addInitScript(() => window.localStorage.setItem("novel-world-harness.locale", "en"));
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "World control room" })).toBeVisible();
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "世界控制台" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("heading", { name: "World control room" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/sidebar-open/);
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/sidebar-open/);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("link", { name: /Register novel/ }).first().click();
  await page.getByPlaceholder("novel.txt").fill("browser-mvp.txt");
  await page.getByPlaceholder("Paste the complete novel text here…").fill(SOURCE_TEXT);
  await page.getByRole("button", { name: "Register and inspect" }).click();
  await expect(page).toHaveURL(/\/novels\/[a-f0-9]{20}\/compile$/);
  const sourceId = sourceIdFrom(page);
  await expect(page.getByText("Compile evidence", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Compile all remaining" }).click();
  await expect(page.getByText("Review proposals", { exact: true })).toBeVisible();
  await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
  await expect(page.getByText(/proposal-hero-/).first()).toBeVisible();
  await page.getByRole("button", { name: "Validate and accept" }).click();
  await expect(page.getByText("Ready to publish", { exact: true })).toBeVisible();

  const branchInput = page.getByLabel("New instance branch ID");
  await expect(branchInput).toHaveValue("main");
  await page.getByRole("button", { name: "Create world instance" }).click();
  await expect(page).toHaveURL(/\/instances\/main$/);
  await expect(page.getByText("Prepared revision", { exact: true })).toBeVisible();

  await page.goto(`${origin}/novels/${sourceId}/compile`);
  const compiledEntities = page.getByRole("table", { name: "Compiled entities" });
  await expect(compiledEntities).toContainText("Mara");
  await compiledEntities.getByRole("row").filter({ hasText: "Mara" }).first().click();
  await expect(page.locator(".compiled-entity-inspector")).toContainText("Canonical identity");
  await expect(page.locator(".compiled-entity-inspector")).toContainText("Complete entity record");

  await page.goto(`${origin}/instances/main`);

  await page.getByRole("link", { name: "Inspect ontology" }).click();
  await expect(page.getByRole("heading", { name: "Events" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Ontology projection" }).getByRole("link")).toHaveCount(5);
  await page.getByText("Show future canon as possibility").click();
  await expect(page.getByRole("table", { name: "Ontology nodes" })).toContainText("Mara considers the Garden");
  await page.getByRole("link", { name: "World model" }).click();
  const maraRow = page.locator(".ontology-table-row").filter({ hasText: "Mara" }).first();
  await expect(maraRow).toBeVisible();
  await maraRow.click();
  await expect(page.locator(".ontology-inspector")).toContainText("Source evidence");
  await expect(page.locator(".ontology-inspector blockquote").first()).toContainText("Mara waits in the Hall");

  await page.goto(`${origin}/novels/${sourceId}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const playLauncher = page.getByRole("dialog", { name: /Enter / });
  await expect(playLauncher).toBeVisible();
  await expect(playLauncher).toContainText("Frozen world base");
  const playableMara = playLauncher.getByRole("radio", { name: /Mara/ });
  await expect(playableMara).toBeChecked();
  await expect(playLauncher).toContainText("Every new instance starts from this immutable revision");
  await playableMara.click();
  await playLauncher.getByRole("button", { name: "Start an independent instance as Mara" }).click();
  await expect(page).toHaveURL(/\/play\/play-[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Play status")).toContainText("step 0");
  const nestedSessionNavigation = page.locator(".nav-tree-session-link").filter({ hasText: "Mara" }).first();
  await expect(nestedSessionNavigation).toBeVisible();
  await expect(nestedSessionNavigation.locator("xpath=ancestor::li[contains(@class, 'nav-tree-instance')]").locator(":scope > .nav-tree-instance-link")).toBeVisible();
  await expect(nestedSessionNavigation.locator("xpath=ancestor::li[contains(@class, 'nav-tree-novel')]").locator(".nav-tree-novel-link").first()).toContainText("browser-mvp");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(nestedSessionNavigation).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.locator(".message-scene").last()).toContainText("斑驳的窗影");
  await expect(page.getByRole("button", { name: "Re-establish scene" })).toHaveCount(0);
  await expect(page.locator(".operation-panel")).toContainText("succeeded");
  await page.reload();
  await expect(page.locator(".transcript-panel > header")).toContainText("1 message");
  await expect(page.locator(".message-scene")).toHaveCount(1);

  const suggestedChoice = page.locator(".choice-strip button").first();
  await expect(suggestedChoice).toBeVisible();
  const suggestedAction = (await suggestedChoice.locator("span").innerText()).trim();
  await suggestedChoice.click();
  await expect(page.getByPlaceholder("Describe one immediate action, observation, thought, or wait…")).toHaveValue(suggestedAction);
  await submitMove(page, suggestedAction, 1);
  await page.reload();
  await expect(page.locator(".transcript-panel > header")).toContainText("3 messages");
  await expect(page.getByText(suggestedAction, { exact: true })).toBeVisible();
  await submitMove(page, "我再等片刻，确认大厅里的动静。", 2);
  await expect(page.locator(".transcript-panel > header")).toContainText("5 messages");

  const messageTraceTriggers = page.getByRole("button", { name: "Open trace details for this message" });
  await expect(messageTraceTriggers).toHaveCount(3);
  await expect(page.locator(".message-player").getByRole("button", { name: "Open trace details for this message" })).toHaveCount(0);
  const playUrl = page.url();
  await messageTraceTriggers.last().click();
  const traceDrawer = page.getByRole("dialog", { name: "Message-linked execution trajectory" });
  await expect(traceDrawer).toBeVisible();
  await expect(page).toHaveURL(playUrl);
  await expect(traceDrawer.getByRole("heading", { name: "player-move trajectory" })).toBeVisible();
  const fullTraceLink = traceDrawer.getByRole("link", { name: /Open full trajectory/ });
  const traceHref = await fullTraceLink.getAttribute("href");
  const runId = traceHref?.split("/").at(-1);
  expect(runId).toBeTruthy();
  await expect(traceMetric(page, "LLM requests")).toContainText("2");
  await expect(traceMetric(page, "Tool calls")).toContainText("1");
  await expect(page.locator(".trace-truth-strip")).toContainText("step 1");
  await expect(page.locator(".trace-truth-strip")).toContainText("step 2");
  await expect(page.locator(".context-part-scroll")).toContainText("Player utterance");
  await expect(page.locator(".context-part-scroll")).toContainText("Committed actor state");
  await expect(page.locator(".context-part-scroll")).toContainText("Exact source evidence");

  await traceDrawer.getByRole("tab", { name: "Messages" }).click();
  await expect(page.locator(".trace-inspector-body")).toContainText("我再等片刻");
  await traceDrawer.getByRole("tab", { name: "Provider Payload" }).click();
  await expect(page.locator(".trace-inspector-body")).toContainText("[REDACTED]");
  await expect(page.locator("body")).not.toContainText(TRACE_CANARY);
  await traceDrawer.getByRole("tab", { name: "Tools" }).click();
  await expect(page.locator(".trace-inspector-body")).toContainText("propose_player_action");
  await traceDrawer.getByRole("tab", { name: "Response" }).click();
  await expect(page.locator(".trace-inspector-body")).toContainText("Synthetic player-action response");
  await traceDrawer.getByRole("tab", { name: "World Effects" }).click();
  await expect(page.locator(".trace-inspector-body")).toContainText("world.commit.completed");

  const apiTrace = await page.evaluate(async (selectedRunId) => {
    const run = await fetch(`/api/v1/runs/${encodeURIComponent(selectedRunId)}`).then((response) => response.json());
    const call = await fetch(`/api/v1/calls/${encodeURIComponent(run.callIds[0])}/context?runId=${encodeURIComponent(selectedRunId)}`).then((response) => response.json());
    return JSON.stringify({ run, call });
  }, runId!);
  expect(apiTrace).not.toContain(TRACE_CANARY);
  expect(apiTrace).toContain("[REDACTED]");

  await page.keyboard.press("Escape");
  await expect(traceDrawer).toBeHidden();
  await expect(page).toHaveURL(playUrl);
  await messageTraceTriggers.last().click();
  await page.getByRole("dialog", { name: "Message-linked execution trajectory" }).getByRole("link", { name: /Open full trajectory/ }).click();
  await expect(page.getByRole("heading", { name: "player-move trajectory" })).toBeVisible();
  expect(runIdFrom(page)).toBe(runId);
  await page.getByRole("link", { name: "Back to play" }).click();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  const sessionNavigation = page.locator(".nav-world-tree");
  await expect(sessionNavigation.locator(".nav-tree-session-link")).toHaveCount(0);
  await page.getByRole("button", { name: /Show archived/ }).click();
  await expect(sessionNavigation.locator(".nav-tree-session-link")).toHaveCount(1);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Make active" })).toBeVisible();
  await page.getByRole("button", { name: "Make active" }).click();
  await expect(page.getByText("Active writer", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Clear transcript" }).click();
  await expect(page.locator(".transcript-panel > header")).toContainText("0 messages");
  await expect(page.getByText("The scene has not been rendered", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-establish scene" })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page).toHaveURL(/\/instances\/novel-[a-f0-9]{8}$/);
  await expect(page.locator(".metric").filter({ hasText: "Story step" })).toContainText("2");

  await page.getByRole("button", { name: "Preview instance removal" }).click();
  const preview = page.getByRole("dialog", { name: "Remove world instance" });
  await expect(preview).toContainText("Exact effect manifest");
  await expect(preview).toContainText("Effect hash");
  await expect(preview.getByRole("button", { name: "Remove exact instance" })).toBeDisabled();
  await preview.getByRole("button", { name: "Cancel" }).click();

  expect(browserDiagnostics.join("\n")).not.toContain(TRACE_CANARY);
  const persisted = await readDirectoryTree(traceStore.root);
  expect(persisted).not.toContain(TRACE_CANARY);
  expect(sourceId).toMatch(/^[a-f0-9]{20}$/);
});

test("opens LLM response traces in a side drawer", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("novel-world-harness.locale", "en"));
  await page.goto(`${origin}/novels/new`);
  await page.getByPlaceholder("novel.txt").fill("trace-drawer-fixture.txt");
  await page.getByPlaceholder("Paste the complete novel text here…").fill(`${SOURCE_TEXT}\nThis source exists to verify message-scoped trace inspection.`);
  await page.getByRole("button", { name: "Register and inspect" }).click();
  await expect(page).toHaveURL(/\/novels\/[a-f0-9]{20}\/compile$/);
  const sourceId = sourceIdFrom(page);
  await page.getByRole("button", { name: "Compile all remaining" }).click();
  await expect(page.getByText("Review proposals", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Validate and accept" }).click();
  await expect(page.getByText("Ready to publish", { exact: true })).toBeVisible();

  await page.getByLabel("New instance branch ID").fill("trace-drawer");
  await page.getByRole("button", { name: "Create world instance" }).click();
  await expect(page).toHaveURL(/\/instances\/trace-drawer$/);
  await page.goto(`${origin}/novels/${sourceId}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const playLauncher = page.getByRole("dialog", { name: /Enter / });
  await expect(playLauncher).toContainText("Frozen world base");
  await expect(playLauncher.getByRole("radio", { name: /Mara/ })).toBeChecked();
  await playLauncher.getByRole("button", { name: "Start an independent instance as Mara" }).click();
  await expect(page).toHaveURL(/\/play\/play-[0-9a-f-]{36}$/);

  await expect(page.locator(".message-scene").last()).toContainText("斑驳的窗影");
  await submitMove(page, "我继续听雨。", 1);
  await expect(page.locator(".transcript-panel > header")).toContainText("3 messages");
  await expect(page.getByText("Live executable world", { exact: true })).toHaveCount(0);
  await expect(page.locator(".choice-deck")).toBeVisible();
  const immersiveLayout = await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>(".page")!;
    const story = document.querySelector<HTMLElement>(".play-story-panel")!;
    const composer = document.querySelector<HTMLElement>(".composer-area")!;
    return {
      bodyOverflow: getComputedStyle(document.body).overflowY,
      pageOverflow: getComputedStyle(pageElement).overflowY,
      transcriptOverflow: getComputedStyle(document.querySelector<HTMLElement>(".transcript")!).overflowY,
      transcriptScrollbarWidth: getComputedStyle(document.querySelector<HTMLElement>(".transcript")!).scrollbarWidth,
      bottomGap: Math.abs(story.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom),
    };
  });
  expect(immersiveLayout.bodyOverflow).toBe("hidden");
  expect(immersiveLayout.pageOverflow).toBe("hidden");
  expect(immersiveLayout.transcriptOverflow).toBe("auto");
  expect(immersiveLayout.transcriptScrollbarWidth).toBe("thin");
  expect(immersiveLayout.bottomGap).toBeLessThanOrEqual(2);

  const triggers = page.getByRole("button", { name: "Open trace details for this message" });
  await expect(triggers).toHaveCount(2);
  await expect(page.locator(".message-player").getByRole("button", { name: "Open trace details for this message" })).toHaveCount(0);
  const playUrl = page.url();
  await triggers.last().click();

  const drawer = page.getByRole("dialog", { name: "Message-linked execution trajectory" });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(playUrl);
  await expect(drawer.getByRole("heading", { name: "player-move trajectory" })).toBeVisible();
  await expect(drawer.locator(".trace-ledger-panel")).toContainText("Trajectory ledger");
  await expect(drawer.getByRole("tab")).toHaveCount(7);
  await drawer.getByRole("tab", { name: "Tools" }).click();
  await expect(drawer.locator(".trace-inspector-body")).toContainText("propose_player_action");
  await drawer.getByRole("tab", { name: "World Effects" }).click();
  await expect(drawer.locator(".trace-inspector-body")).toContainText("world.commit.completed");

  await drawer.getByRole("button", { name: "Close trace details" }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(playUrl);

  await page.setViewportSize({ width: 390, height: 844 });
  const openSessionControls = page.getByRole("button", { name: "Open session controls" });
  await expect(openSessionControls).toBeVisible();
  await openSessionControls.click();
  await expect(page.locator(".play-edge-panel")).toBeInViewport();
  await page.getByRole("button", { name: "Close session controls" }).last().click();
  await expect(openSessionControls).toHaveAttribute("aria-expanded", "false");
});

async function submitMove(page: Page, text: string, expectedStep: number): Promise<void> {
  await page.getByPlaceholder("Describe one immediate action, observation, thought, or wait…").fill(text);
  await page.getByRole("button", { name: "Commit action" }).click();
  await expect(page.locator(".operation-result")).toContainText("Committed");
  await expect(page.getByLabel("Play status")).toContainText(`step ${expectedStep}`);
}

function sourceIdFrom(page: Page): string {
  const match = new URL(page.url()).pathname.match(/^\/novels\/([^/]+)\/compile$/u);
  if (!match) throw new Error(`Could not recover source ID from ${page.url()}`);
  return decodeURIComponent(match[1]!);
}

function runIdFrom(page: Page): string {
  const match = new URL(page.url()).pathname.match(/\/trace\/([^/]+)$/u);
  if (!match) throw new Error(`Could not recover run ID from ${page.url()}`);
  return decodeURIComponent(match[1]!);
}

function traceMetric(page: Page, label: string) {
  return page.locator(".trace-metric-grid > article").filter({ hasText: label });
}

async function seedBrowserCompilation(options: CompileSourceOptions): Promise<void> {
  options.signal?.throwIfAborted();
  if (!options.sourceId) throw new Error("The browser compiler fixture requires an exact source ID.");
  const workspace = await WorkspaceStore.create(options.root);
  const source = await workspace.getSource(options.sourceId);
  if (!source) throw new Error(`Unknown source ${options.sourceId}`);
  const material = await new SourceMaterialStore().read(source);
  if (!material) throw new Error(`Missing immutable source ${source.id}`);
  const evidence = wholeSourceEvidence(source, material);
  const suffix = source.id.slice(0, 8);
  const heroId = `hero-${suffix}`;
  const hallId = `hall-${suffix}`;
  const gardenId = `garden-${suffix}`;
  const eventId = `event-garden-${suffix}`;
  const ruleId = `rule-no-flame-${suffix}`;
  const proposalId = `proposal-hero-${suffix}`;

  options.onStatus?.("Running deterministic browser acceptance compiler adapter");
  options.onProgress?.("Materializing one source-scoped proposal and canonical fixture artifacts.");
  options.onModelText?.("Typed proposal ready for deterministic validation.");
  options.onModelToolCall?.("propose_entity", { id: heroId });

  const canonical = new CanonicalModelStore(options.root);
  await canonical.putEntity({ id: hallId, kind: "location", canonicalName: "Hall", aliases: [], evidence });
  await canonical.putEntity({ id: gardenId, kind: "location", canonicalName: "Garden", aliases: [], evidence });
  const rulePhrase = Buffer.from("outer door must remain closed", "utf8");
  const ruleStartByte = material.indexOf(rulePhrase);
  if (ruleStartByte < 0) throw new Error("The browser compiler fixture is missing its rule evidence phrase.");
  const ruleAnchor = textAnchorForByteRange(
    source.id,
    material,
    ruleStartByte,
    ruleStartByte + rulePhrase.byteLength,
  );
  const ruleEvidence: EvidenceRef[] = [{
    span: {
      sourceId: source.id,
      startByte: ruleAnchor.startByte,
      endByte: ruleAnchor.endByte,
      startLine: ruleAnchor.startLine,
      endLine: ruleAnchor.endLine,
      quoteHash: ruleAnchor.exactHash,
    },
    strength: "explicit",
  }];
  const hallDoorRule: WorldRule = {
    ontologyVersion: "world-rule-v2",
    id: ruleId,
    name: "The Hall door remains closed",
    kind: "physical",
    scope: "global",
    jurisdictionEntityIds: [],
    appliesWhen: [],
    visibility: "public",
    knownByClaimIds: [],
    priority: 0,
    defeasible: false,
    overridesRuleIds: [],
    clauses: [{
      id: `${ruleId}-clause`,
      modality: "forbid",
      predicate: { op: "fact-equals", entityId: hallId, field: "location.open", value: true },
      basis: "explicit",
      status: "supported",
      confidence: 1,
      evidence: ruleEvidence,
    }],
    exceptions: [],
    basis: "explicit",
    status: "supported",
    confidence: 1,
    evidence: ruleEvidence,
  };
  await canonical.putRule(hallDoorRule);
  await new EvidenceAssertionStore(options.root).replaceForArtifact(
    "world-rule",
    ruleId,
    contentHash(hallDoorRule),
    ["/name", "/clauses/0/predicate"].map((jsonPointer, index) => ({
      version: 1 as const,
      id: `${ruleId}-evidence-${index}`,
      target: { artifactKind: "world-rule", artifactId: ruleId, jsonPointer },
      anchors: [ruleAnchor],
      relation: "supports" as const,
      strength: "explicit" as const,
      derivation: {
        runId: "playwright-browser-compiler",
        worker: "playwright-browser-compiler",
        ontologyVersion: "evidence-v1" as const,
      },
    })),
  );
  await canonical.putEvent({
    id: eventId,
    title: "Mara considers the Garden",
    readerSummary: "Mara considers leaving the Hall for the Garden.",
    participants: [heroId, hallId, gardenId],
    participantPresence: [{ entityId: heroId, mode: "physical" }],
    storyTime: { kind: "ordinal", label: "later", orderHint: 1 },
    narrativeContext: { layerId: "main", discourseOrder: 1, mode: "scene", viewpointActorId: heroId },
    preconditions: [{ op: "fact-equals", entityId: heroId, field: "character.location", value: hallId }],
    observedOutcome: {
      version: 1,
      operations: [{ op: "set", entityId: heroId, field: "character.plan", value: "cross into the Garden" }],
    },
    evidence,
    causalParents: [],
    confidence: 1,
  });
  await new InitialWorldStore(options.root).put({
    version: 1,
    readerSetup: "Mara waits inside the rain-darkened Hall before deciding whether to approach the closed Garden door.",
    participantPresence: [{ entityId: heroId, mode: "physical" }],
    delta: {
      version: 1,
      operations: [
        { op: "set", entityId: heroId, field: "character.alive", value: true },
        { op: "set", entityId: heroId, field: "character.location", value: hallId },
        { op: "set", entityId: heroId, field: "character.plan", value: "listen to the rain" },
        { op: "set", entityId: hallId, field: "location.open", value: false },
        { op: "activate-rule", ruleId },
      ],
    },
    checkpoint: {
      mode: "chronological",
      storyTime: { kind: "ordinal", label: "opening", orderHint: 0 },
      beforeCanonicalEventId: eventId,
      rationale: "The browser fixture begins before Mara decides whether to leave the Hall.",
    },
    evidence,
  });
  const proposals = new ProposalStore(options.root);
  const exists = (await Promise.all(["pending", "accepted", "rejected"].map((status) =>
    proposals.list(status as "pending" | "accepted" | "rejected", source.id))))
    .flat()
    .some((proposal) => proposal.id === proposalId);
  if (!exists) {
    await new CompilerProposalService(options.root).submit("entity", {
      proposalId,
      payload: { id: heroId, kind: "character", canonicalName: "Mara", aliases: [], evidence },
      generatedBy: { worker: "playwright-browser-compiler", provider: "fixture", model: "typed-fixture" },
    });
  }
  const batches = await prepareCompilerBatches(options.root, source);
  await new CompilerBatchStore(options.root).replaceCompleted(source.id, batches.map((batch) => batch.id));
  options.onModelToolResult?.("propose_entity", { proposalId }, false);
  options.onProgress?.("Compiler checkpoint persisted; browser proposal review is now required.");
}

function wholeSourceEvidence(source: SourceDocument, content: Buffer): EvidenceRef[] {
  const text = content.toString("utf8");
  return [{
    span: {
      sourceId: source.id,
      startByte: 0,
      endByte: content.byteLength,
      startLine: 1,
      endLine: text.split(/\r\n|\r|\n/u).length,
      quoteHash: crypto.createHash("sha256").update(content).digest("hex"),
    },
    strength: "explicit",
  }];
}

function tracedTranslator(store: TraceStore): PlayerActionTranslator {
  return async (input: PlayerActionTranslationInput) => {
    await recordSyntheticModelCall(store, {
      invocationName: "interpret-player-action",
      playerText: input.utterance,
      actorState: input.context.selfState,
      responseText: "Synthetic player-action response: wait and listen.",
      withTool: true,
    });
    return deterministicPlayerIntentCandidate("wait", input, { amount: 5, unit: "minute" });
  };
}

function tracedNarrator(store: TraceStore): PlayerOpeningNarrator {
  return async (frame, purpose, observer) => {
    const narration = `${frame.actor.name}站在大厅斑驳的窗影里，雨声从檐角缓慢落下，空气里有潮湿木料与泥土的气味。他听见自己的呼吸，也看见通往花园的门仍然关闭。此刻世界没有替他作出决定，只有已经发生的${purpose}场景仍在眼前铺开，门边的微光随风轻轻一颤。`;
    await recordSyntheticModelCall(store, {
      invocationName: "render-player-scene",
      playerText: `Render ${purpose} narration from committed actor-visible state.`,
      actorState: { purpose },
      responseText: narration,
      withTool: false,
    });
    observer?.onAttempt?.(1);
    for (let index = 0; index < 320; index += 1) {
      observer?.signal?.throwIfAborted();
      observer?.onText?.("·");
      if (index % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { narration, choices: [{ action: "继续听雨" }, { action: "观察通往花园的门" }] };
  };
}

let syntheticCallOrdinal = 0;

async function recordSyntheticModelCall(store: TraceStore, input: {
  invocationName: string;
  playerText: string;
  actorState: unknown;
  responseText: string;
  withTool: boolean;
}): Promise<void> {
  const run = (await store.listRuns({ status: "running", limit: 50 }))
    .find((candidate) => candidate.kind === "player-move" || candidate.kind === "scene-narration" || candidate.kind === "narration-retry");
  if (!run) throw new Error("No running play trace exists for the synthetic Pi conformance adapter.");
  syntheticCallOrdinal += 1;
  const suffix = `${syntheticCallOrdinal}`;
  const spanId = `span-playwright-${suffix}`;
  const callId = `call-playwright-${suffix}`;
  const toolCallId = `tool-playwright-${suffix}`;
  const sourceId = run.sourceId ?? "browser-source";
  const system = "You are the Pi-backed Novel World Harness adapter. World mutations require typed host validation.";
  const sourceExcerpt = SOURCE_TEXT;
  const logicalMessages = [
    { role: "system", content: system },
    { role: "user", content: [{ type: "text", text: sourceExcerpt }, { type: "text", text: input.playerText }] },
  ];
  const [systemRef, playerRef, stateRef, sourceRef, messagesRef, toolParametersRef] = await Promise.all([
    store.putBlob(system, "text/plain; charset=utf-8"),
    store.putBlob(input.playerText, "text/plain; charset=utf-8"),
    store.putBlob(input.actorState),
    store.putBlob(sourceExcerpt, "text/plain; charset=utf-8"),
    store.putBlob(logicalMessages),
    store.putBlob({ type: "object", properties: { action: { type: "string" } }, required: ["action"] }),
  ]);
  const providerPayload = await store.putBlob({
    model: "fixture/pi-browser-model",
    authorization: `Bearer ${TRACE_CANARY}`,
    messages: logicalMessages,
    tools: input.withTool ? [{ name: "propose_player_action" }] : [],
  });
  const parts: ContextPart[] = [
    {
      id: `${callId}.system`,
      label: "Harness system policy",
      kind: "system.core",
      role: "system",
      authority: "trusted-system",
      sourceRefs: [],
      contentRef: systemRef,
      charCount: system.length,
      estimatedTokens: Math.ceil(system.length / 4),
      disposition: "included",
      logicalMessageIndexes: [0],
    },
    {
      id: `${callId}.player`,
      label: "Player utterance",
      kind: "player.utterance",
      role: "user",
      authority: "untrusted-player",
      sourceRefs: [],
      contentRef: playerRef,
      charCount: input.playerText.length,
      estimatedTokens: Math.ceil(input.playerText.length / 4),
      disposition: "included",
      logicalMessageIndexes: [1],
    },
    {
      id: `${callId}.state`,
      label: "Committed actor state",
      kind: "actor.state",
      role: "user",
      authority: "actor-visible",
      sourceRefs: [],
      contentRef: stateRef,
      charCount: JSON.stringify(input.actorState).length,
      estimatedTokens: Math.ceil(JSON.stringify(input.actorState).length / 4),
      disposition: "included",
      logicalMessageIndexes: [1],
    },
    {
      id: `${callId}.source`,
      label: "Exact source evidence",
      kind: "source.excerpt",
      role: "user",
      authority: "untrusted-source",
      sourceRefs: [{ sourceId, startByte: 0, endByte: Buffer.byteLength(sourceExcerpt), label: "browser fixture source" }],
      contentRef: sourceRef,
      charCount: sourceExcerpt.length,
      estimatedTokens: Math.ceil(sourceExcerpt.length / 4),
      disposition: "included",
      logicalMessageIndexes: [1],
    },
  ];
  const snapshot = contextSnapshotSchema.parse({
    version: 1,
    callId,
    invocationName: input.invocationName,
    assemblyVersion: "playwright-pi-conformance/v1",
    providerId: "fixture",
    modelId: "pi-browser-model",
    thinkingLevel: "off",
    parts,
    tools: input.withTool ? [{ name: "propose_player_action", description: "Return one typed player-action candidate.", parametersRef: toolParametersRef }] : [],
    logicalMessagesRef: messagesRef,
    providerPayloadRef: providerPayload,
    logicalContextHash: messagesRef.sha256,
    providerPayloadHash: providerPayload.sha256,
    estimatedInputTokens: 48,
  });
  const snapshotRef = await store.putBlob(snapshot);
  await store.appendEvent(run.id, {
    type: "stage.started",
    spanId,
    parentSpanId: run.rootSpanId,
    data: { label: input.invocationName, kind: "pi-invocation" },
  });
  await store.appendEvent(run.id, {
    type: "context.assembled",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: { invocationName: input.invocationName, semanticPartCount: parts.length },
  });
  await store.appendEvent(run.id, {
    type: "llm.request.started",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: { invocationName: input.invocationName, providerId: "fixture", modelId: "pi-browser-model", requestAttempt: 1 },
  });
  await store.appendEvent(run.id, {
    type: "llm.request.payload",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: { requestAttempt: 1, providerPayloadHash: providerPayload.sha256, redactionPolicy: "nwh-trace-secrets/v1" },
    blobRef: providerPayload,
  });
  await store.appendEvent(run.id, {
    type: "context.finalized",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: { invocationName: input.invocationName, requestAttempt: 1, logicalContextHash: messagesRef.sha256, providerPayloadHash: providerPayload.sha256 },
    blobRef: snapshotRef,
  });
  await store.appendEvent(run.id, {
    type: "llm.response.started",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: { requestAttempt: 1, httpStatus: 200, responseHeadersRedacted: true },
  });
  if (input.withTool) {
    const toolInput = await store.putBlob({ action: input.playerText });
    const toolResult = await store.putBlob({ accepted: true, kind: "typed-player-action-proposal" });
    await store.appendEvent(run.id, {
      type: "tool.call.started",
      spanId,
      parentSpanId: run.rootSpanId,
      callId,
      toolCallId,
      data: { toolName: "propose_player_action" },
      blobRef: toolInput,
    });
    await store.appendEvent(run.id, {
      type: "tool.call.completed",
      spanId,
      parentSpanId: run.rootSpanId,
      callId,
      toolCallId,
      data: { toolName: "propose_player_action", isError: false },
      blobRef: toolResult,
    });
  }
  const deltaRef = await store.putBlob(input.responseText, "text/plain; charset=utf-8");
  const responseRef = await store.putBlob({
    role: "assistant",
    content: [{ type: "text", text: input.responseText }],
    provider: "fixture",
    model: "pi-browser-model",
    stopReason: "stop",
  });
  await store.appendEvent(run.id, {
    type: "llm.response.delta",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: { charCount: input.responseText.length },
    blobRef: deltaRef,
  });
  await store.appendEvent(run.id, {
    type: "llm.response.completed",
    spanId,
    parentSpanId: run.rootSpanId,
    callId,
    data: {
      providerId: "fixture",
      modelId: "pi-browser-model",
      stopReason: "stop",
      durationMs: 12,
      usage: { input: 48, output: 16, cacheRead: 0, cacheWrite: 0, totalTokens: 64, cost: 0 },
    },
    blobRef: responseRef,
  });
  await store.appendEvent(run.id, {
    type: "stage.finished",
    spanId,
    parentSpanId: run.rootSpanId,
    data: { label: input.invocationName, kind: "pi-invocation", status: "succeeded", callCount: 1 },
  });
}

async function readDirectoryTree(root: string): Promise<string> {
  const values: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else values.push(await fs.readFile(target, "utf8"));
    }
  }
  await visit(root);
  return values.join("\n");
}
