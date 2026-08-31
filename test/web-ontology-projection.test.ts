import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OntologyProjectionService } from "../src/application/ontology-projection-service.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { ontologyGraphSchema, ontologyNodeDetailSchema } from "../src/web/contracts.js";
import { WebApplicationError } from "../src/web/errors.js";
import { createWebHost } from "../src/web/host.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createWebHost>>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function ontologyFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-ontology-"));
  roots.push(root);
  const first = await createEvidenceFixture(
    root,
    "Mara entered the Hall. The Hall contains the Vault. Later Mara left. The Hall permits no flame. A Witness watched.\n",
    "mara.txt",
  );
  const second = await createEvidenceFixture(root, "Orin waited beside the Sea.\n", "orin.txt");
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({
    id: "mara",
    kind: "character",
    canonicalName: "Mara",
    aliases: [],
    evidence: first.evidence("Mara"),
  });
  await canon.putEntity({
    id: "hall",
    kind: "location",
    canonicalName: "Hall",
    aliases: [],
    evidence: first.evidence("Hall"),
  });
  await canon.putEntity({
    id: "vault",
    kind: "location",
    canonicalName: "Vault",
    aliases: [],
    evidence: first.evidence("Vault"),
  });
  await canon.putEntity({
    id: "orin",
    kind: "character",
    canonicalName: "Orin",
    aliases: [],
    evidence: second.evidence("Orin"),
  });
  await canon.putEntity({
    id: "sea",
    kind: "location",
    canonicalName: "Sea",
    aliases: [],
    evidence: second.evidence("Sea"),
  });
  await canon.putClaim({
    id: "mara-waits-in-hall",
    subject: "mara",
    predicate: "waits-in",
    object: "hall",
    epistemicType: "explicit-fact",
    evidence: first.evidence("Mara entered the Hall"),
  });
  await canon.putEvent({
    id: "mara-arrives",
    title: "Mara enters the Hall",
    participants: ["mara", "hall"],
    storyTime: { kind: "ordinal", label: "arrival", orderHint: 1 },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "mara", field: "character.location", value: "hall" }] },
    evidence: first.evidence("Mara entered the Hall"),
    causalParents: [],
    confidence: 1,
  });
  await canon.putEvent({
    id: "mara-leaves",
    title: "Mara leaves the Hall",
    participants: ["mara", "hall"],
    storyTime: { kind: "ordinal", label: "departure", orderHint: 2 },
    preconditions: [],
    observedOutcome: { version: 1, operations: [] },
    evidence: first.evidence("Later Mara left"),
    causalParents: ["mara-arrives"],
    confidence: 1,
  });
  await canon.putSpatialRelation({
    ontologyVersion: "spatial-v1",
    id: "hall-contains-vault",
    kind: "contains",
    containerLocationId: "hall",
    containedLocationId: "vault",
    basis: "explicit",
    visibility: "public",
    knownByClaimIds: [],
    establishedByEventIds: [],
    retiredByEventIds: [],
    requires: [],
    blockedWhen: [],
    status: "supported",
    confidence: 1,
    evidence: first.evidence("The Hall contains the Vault"),
  });
  await canon.putRule({
    id: "no-flame",
    name: "No flame in the Hall",
    scope: "location",
    appliesWhen: [],
    forbids: [{ op: "fact-equals", entityId: "hall", field: "location.flame", value: true }],
    evidence: first.evidence("The Hall permits no flame"),
  });
  await new CompilerProposalService(root).submit("entity", {
    proposalId: "pending-witness",
    payload: {
      id: "witness",
      kind: "character",
      canonicalName: "Witness",
      aliases: [],
      evidence: first.evidence("Witness"),
    },
    generatedBy: { worker: "ontology-test", provider: "test", model: "test-model" },
  });

  const { engine } = await openWorkspaceWorld(root, undefined, { sourceId: first.source.id });
  const head = await engine.createBranch(
    "mara-main",
    "Mara main",
    {
      version: 1,
      operations: [
        { op: "set", entityId: "mara", field: "character.location", value: "hall" },
        { op: "activate-rule", ruleId: "no-flame" },
      ],
    },
    undefined,
    first.source.id,
    undefined,
    first.evidence("Mara entered the Hall"),
    { storyTime: { kind: "ordinal", label: "arrival", orderHint: 1 } },
    { realizesCanonicalEventIds: ["mara-arrives"] },
  );
  return { root, first, second, head, service: new OntologyProjectionService(root) };
}

function expectNoDanglingEdges(graph: Awaited<ReturnType<OntologyProjectionService["project"]>>) {
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    expect(ids.has(edge.source), `missing source ${edge.source}`).toBe(true);
    expect(ids.has(edge.target), `missing target ${edge.target}`).toBe(true);
  }
}

describe("Web ontology projection", () => {
  it("projects all five views through one source-isolated graph contract", async () => {
    const { service, first, second } = await ontologyFixture();
    for (const view of ["model", "events", "places", "rules", "provenance"] as const) {
      const graph = await service.project({ sourceId: first.source.id, view });
      expect(graph.scope).toMatchObject({ sourceId: first.source.id, view });
      expect(graph.nodes.length).toBeGreaterThan(0);
      expectNoDanglingEdges(graph);
      expect(JSON.stringify(graph)).not.toContain(second.source.id);
      expect(graph.nodes.map((node) => node.artifactId)).not.toContain("orin");
      expect(graph.nodes.map((node) => node.artifactId)).not.toContain("sea");
    }
  });

  it("filters a complete semantic kind family without mixing other model nodes", async () => {
    const { service, first } = await ontologyFixture();
    const entities = await service.project({
      sourceId: first.source.id,
      view: "model",
      kind: "entity:*",
      limit: 500,
    });
    expect(entities.nodes.map((node) => node.artifactId).sort()).toEqual(["hall", "mara", "vault"]);
    expect(entities.nodes.every((node) => node.kind.startsWith("entity:"))).toBe(true);
    expect(entities.totalNodes).toBe(3);

    const characters = await service.project({
      sourceId: first.source.id,
      view: "model",
      kind: "entity:character",
    });
    expect(characters.nodes.map((node) => node.artifactId)).toEqual(["mara"]);
  });

  it("keeps future canon outside branch truth unless it is explicitly requested", async () => {
    const { service, first, head } = await ontologyFixture();
    const scoped = await service.project({
      sourceId: first.source.id,
      view: "events",
      branchId: "mara-main",
      atCommit: head,
    });
    expect(scoped.scope).toMatchObject({ branchId: "mara-main", atCommit: head, branchHead: head });
    expect(scoped.nodes).toContainEqual(expect.objectContaining({ id: "canonical-event:mara-arrives", status: "canonical" }));
    expect(scoped.nodes).not.toContainEqual(expect.objectContaining({ id: "canonical-event:mara-leaves" }));
    expect(scoped.nodes).toContainEqual(expect.objectContaining({ kind: "committed-event", status: "branch-committed" }));
    expectNoDanglingEdges(scoped);

    const withFuture = await service.project({
      sourceId: first.source.id,
      view: "events",
      branchId: "mara-main",
      atCommit: head,
      includeCanonicalFuture: true,
    });
    expect(withFuture.nodes).toContainEqual(expect.objectContaining({
      id: "canonical-event:mara-leaves",
      status: "possibility",
      layer: "possibility",
      summary: expect.objectContaining({ futureCanonicalReference: true }),
    }));

    await expect(service.project({
      sourceId: first.source.id,
      view: "events",
      branchId: "mara-main",
      atCommit: "missing-commit",
    })).rejects.toMatchObject<WebApplicationError>({
      statusCode: 409,
      detail: { code: "ONTOLOGY_COMMIT_NOT_IN_BRANCH" },
    });
  });

  it("exposes proposal provenance and source excerpts in node detail", async () => {
    const { root, service, first, head } = await ontologyFixture();
    const provenance = await service.project({ sourceId: first.source.id, view: "provenance" });
    expect(provenance.nodes).toContainEqual(expect.objectContaining({ id: "proposal:pending-witness", layer: "proposal" }));
    expect(provenance.nodes).toContainEqual(expect.objectContaining({ id: "validation:pending:pending-witness", kind: "validation" }));
    expect(provenance.edges).toContainEqual(expect.objectContaining({ kind: "validated-by" }));
    expect(provenance.edges).toContainEqual(expect.objectContaining({ kind: "supports", target: "proposal:pending-witness" }));

    const detail = await service.getNode({ sourceId: first.source.id, view: "model" }, "entity:mara");
    expect(detail.node).toMatchObject({ id: "entity:mara", artifactId: "mara", description: "waits in · Hall" });
    expect(detail.evidence).toContainEqual(expect.objectContaining({
      sourceId: first.source.id,
      excerpt: "Mara",
    }));
    expect(detail.associations).toContainEqual(expect.objectContaining({
      node: expect.objectContaining({ id: "entity:hall", label: "Hall" }),
      relationLabels: ["waits in"],
    }));
    expect(JSON.stringify(detail.payload)).not.toContain("orin");

    const places = await service.project({ sourceId: first.source.id, view: "places", branchId: "mara-main", atCommit: head });
    expect(places.edges).toContainEqual(expect.objectContaining({
      kind: "spatial",
      status: "active",
      label: "contains",
    }));
    const placeDetail = await service.getNode({ sourceId: first.source.id, view: "places", branchId: "mara-main", atCommit: head }, "entity:hall");
    expect(placeDetail.relatedNodes).toContainEqual(expect.objectContaining({ id: "entity:vault", label: "Vault" }));
    expect(placeDetail.outgoing).toContainEqual(expect.objectContaining({ target: "entity:vault", label: "contains" }));
    const rules = await service.project({ sourceId: first.source.id, view: "rules", branchId: "mara-main", atCommit: head });
    expect(rules.nodes).toContainEqual(expect.objectContaining({ id: "rule:no-flame", status: "active" }));

    expect((await new CompilerCommitService(root).accept("entity", "pending-witness")).accepted).toBe(true);
    const pinnedProvenance = await service.project({ sourceId: first.source.id, view: "provenance", branchId: "mara-main", atCommit: head });
    expect(pinnedProvenance.nodes).toContainEqual(expect.objectContaining({
      id: "entity:witness",
      status: "proposal",
      layer: "proposal",
      summary: expect.objectContaining({ validationStatus: "accepted", absentFromSelectedSnapshot: true }),
    }));
    expect(pinnedProvenance.nodes).not.toContainEqual(expect.objectContaining({ id: "entity:witness", layer: "canonical" }));
  });

  it("pages a topology as a stable prefix with complete closed relationships", async () => {
    const { root, service, first } = await ontologyFixture();
    const compiler = new CompilerProposalService(root);
    for (let index = 0; index < 60; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await compiler.submit("entity", {
        proposalId: `paged-witness-${suffix}`,
        payload: {
          id: `paged-witness-${suffix}`,
          kind: "character",
          canonicalName: `Paged witness ${suffix}`,
          aliases: [],
          evidence: first.evidence("Witness"),
        },
        generatedBy: { worker: "ontology-page-test" },
      });
    }
    const bounded = await service.project({ sourceId: first.source.id, view: "provenance" });
    expect(bounded.totalNodes).toBeGreaterThan(180);
    expect(bounded.nodes).toHaveLength(180);
    expect(bounded.page.remainingEdges).toBeGreaterThan(0);
    await expect(service.project({ sourceId: first.source.id, view: "provenance", cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ detail: { code: "ONTOLOGY_PAGE_CURSOR_INVALID", retry: { copyField: "page.nextCursor", maxAttempts: 1 } } });

    const loadedNodes = new Set<string>();
    const loadedEdges = new Map<string, { source: string; target: string }>();
    let cursor: string | undefined;
    let snapshotId: string | undefined;
    let totalNodes = 0;
    let totalEdges = 0;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await service.project({ sourceId: first.source.id, view: "provenance", limit: 25, ...(cursor ? { cursor } : {}) });
      snapshotId ??= page.page.snapshotId;
      expect(page.page.snapshotId).toBe(snapshotId);
      for (const node of page.nodes) loadedNodes.add(node.id);
      expect(page.page.requiredNodeIds.every((nodeId) => loadedNodes.has(nodeId))).toBe(true);
      for (const edge of page.edges) loadedEdges.set(edge.id, edge);
      for (const edge of loadedEdges.values()) {
        expect(loadedNodes.has(edge.source), `missing paged source ${edge.source}`).toBe(true);
        expect(loadedNodes.has(edge.target), `missing paged target ${edge.target}`).toBe(true);
      }
      expect(page.page.loadedNodes).toBe(loadedNodes.size);
      expect(page.page.loadedEdges).toBe(loadedEdges.size);
      totalNodes = page.totalNodes;
      totalEdges = page.totalEdges;
      cursor = page.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(loadedNodes.size).toBe(totalNodes);
    expect(loadedEdges.size).toBe(totalEdges);

    const firstPage = await service.project({ sourceId: first.source.id, view: "model", limit: 1 });
    expect(firstPage.page.nextCursor).toBeTruthy();
    await new CanonicalModelStore(root).putEntity({
      id: "late-arrival",
      kind: "character",
      canonicalName: "Late arrival",
      aliases: [],
      evidence: first.evidence("Witness"),
    });
    await expect(service.project({
      sourceId: first.source.id,
      view: "model",
      limit: 1,
      cursor: firstPage.page.nextCursor!,
    })).resolves.toMatchObject({ page: { snapshotId: firstPage.page.snapshotId } });
    const restartedService = new OntologyProjectionService(root);
    await expect(restartedService.project({
      sourceId: first.source.id,
      view: "model",
      limit: 1,
      cursor: firstPage.page.nextCursor!,
    })).rejects.toMatchObject({ detail: { code: "ONTOLOGY_PAGE_CURSOR_STALE" } });
  });

  it("serves strict graph and node-detail HTTP contracts", async () => {
    const { root, first } = await ontologyFixture();
    const app = await createWebHost({
      root,
      serveStatic: false,
      modelCatalogService: { read: async () => ({ providers: [], models: [] }) },
    });
    apps.push(app);

    const graphResponse = await app.inject({
      method: "GET",
      url: `/api/v1/novels/${first.source.id}/ontology?view=model&layers=canonical,branch`,
    });
    expect(graphResponse.statusCode).toBe(200);
    const graph = ontologyGraphSchema.parse(graphResponse.json());
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "entity:mara" }));

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/ontology/nodes/${encodeURIComponent("entity:mara")}?sourceId=${first.source.id}&view=model`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(ontologyNodeDetailSchema.parse(detailResponse.json())).toMatchObject({
      node: { id: "entity:mara", description: "waits in · Hall" },
      evidence: [expect.objectContaining({ excerpt: "Mara" })],
      relatedNodes: [expect.objectContaining({ id: "claim:mara-waits-in-hall" })],
      associations: [expect.objectContaining({ node: expect.objectContaining({ id: "entity:hall" }) })],
    });

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/novels/${first.source.id}/ontology?view=model&includeCanonicalFuture=maybe`,
    });
    expect(invalid.statusCode).toBe(400);
  });
});
