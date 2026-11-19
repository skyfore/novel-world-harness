import { describe, expect, it } from "vitest";
import { attributeIssues, GLOBAL_ISSUE_CODES, issueAttributionCatalog, issueNodeKey, partitionIssueAttribution } from "../src/compiler/issue-attribution.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";

const bundle = {
  source: { id: "src" },
  canonical: {
    events: [{ id: "ev-meeting" }, { id: "ev-escape" }], sceneOccurrences: [{ id: "scene-hall" }], actionSchemas: [{ id: "schema-reform" }],
    eventExecutions: [{ id: "exec-1" }], semanticEffects: [], entities: [{ id: "hero" }, { id: "hall" }], goals: [{ id: "goal-explore-city" }],
    rules: [], normTemplates: [], processTemplates: [{ id: "process-sleep" }],
  },
  compilerSnapshot: { structure: { units: [{ id: "unit-sentence-abc" }] } },
} as unknown as PreparedNovelBundle;
const catalog = issueAttributionCatalog(bundle);

describe("issue node attribution", () => {
  it.each([
    ["SCENE_EXECUTION_INVALID", "scene/scene-hall", "ev-meeting/hero: Error", "scene/scene-hall"],
    ["SCENE_ACTION_INITIATOR_MISSING", "scene/scene-hall/event/ev-meeting", "no initiator", "scene/scene-hall"],
    ["SCENE_EXECUTION_COVERAGE_MISSING", "event/ev-escape", "Major-character event ev-escape has no package", "event/ev-escape"],
    ["CLOSURE_DANGLING_REFERENCE", "roster/src", "roster/src requires missing entity-resolution/res-1", "roster/src"],
    ["SOURCE_UNIT_UNACCOUNTED", "unit-sentence-abc", "Source unit unit-sentence-abc is missing or unresolved", "unit/unit-sentence-abc"],
    ["MECHANISM_SUPPORT_MISSING", "/visibility", "action-schema/schema-reform/visibility has no field support target", "action/schema-reform"],
    ["MECHANISM_SUPPORT_UNREVIEWED", "/preconditions/0", "Executable field process-template/process-sleep/preconditions/0 requires independent mechanism review", "process/process-sleep"],
    ["SOURCE_ISOLATED_BASELINE_INVALID", undefined, "Cannot cache source-isolated baseline: character-goal 'goal-explore-city' depends on omitted or invalid data", "goal/goal-explore-city"],
    ["ENTRY_TIME_CONFLICT", undefined, "Conflicting chronology for ev-escape", "event/ev-escape"],
    ["MAJOR_ROLE_ENTRY_BLOCKED", undefined, "Character 'hero' has no grounded playable entry", "entity/hero"],
    ["CUT_PREFIX_REPLAY_FAILED", undefined, "ev-meeting failed while hero waited in hall", "event/ev-meeting"],
    ["SOURCE_ISOLATED_BASELINE_INVALID", undefined, "initial-world 'initial-world' depends on omitted data (Entity hero is unknown)", "initial/src"],
  ])("%s attributes to its node", (code, path, message, node) => {
    expect(issueNodeKey({ code, message, ...(path ? { path } : {}) }, catalog)).toBe(node);
  });

  it("keeps novel-wide issues unattributed even when they mention an artifact", () => {
    expect(GLOBAL_ISSUE_CODES.has("ROSTER_REVIEW_INCOMPLETE")).toBe(true);
    expect(issueNodeKey({ code: "ROSTER_REVIEW_INCOMPLETE", message: "Two independent reviews of hero are required" }, catalog)).toBeUndefined();
    expect(issueNodeKey({ code: "CORE_ROLE_REQUIREMENT_NOT_CERTIFIED", message: "ev-meeting" }, catalog)).toBeUndefined();
    expect(issueNodeKey({ code: "SOMETHING_ELSE", message: "nothing identifiable here" }, catalog)).toBeUndefined();
  });

  it("fills only missing paths and partitions attributed from global issues", () => {
    const issues = [
      { code: "ENTRY_TIME_CONFLICT", message: "Conflicting chronology for ev-escape" },
      { code: "MECHANISM_SUPPORT_MISSING", message: "action-schema/schema-reform/x has no field support target", path: "/x" },
      { code: "ROSTER_NO_MAJOR_CHARACTERS", message: "No major character" },
    ];
    expect(attributeIssues(issues, catalog).map((issue) => issue.path)).toEqual(["event/ev-escape", "/x", undefined]);
    const { attributed, global } = partitionIssueAttribution(issues, catalog);
    expect(attributed.map((issue) => issue.node)).toEqual(["event/ev-escape", "action/schema-reform"]);
    expect(global.map((issue) => issue.code)).toEqual(["ROSTER_NO_MAJOR_CHARACTERS"]);
  });
});
