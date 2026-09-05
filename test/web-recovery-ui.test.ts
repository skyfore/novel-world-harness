import { describe, expect, it } from "vitest";
import { canRetrySameRequest, recoveryInstruction, webErrorDetail } from "../apps/web/src/recovery.js";

describe("Web recovery copy", () => {
  it("renders bounded instructions for refresh, user-action, and no-retry contracts", () => {
    expect(recoveryInstruction({
      code: "BRANCH_HEAD_MOVED",
      message: "The branch head changed.",
      retry: {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/play-sessions/play-main",
        copyField: "headCommitId",
        maxAttempts: 1,
      },
    })).toBe("Refresh /api/v1/play-sessions/play-main and copy headCommitId; then make at most one corrected attempt.");

    expect(recoveryInstruction({
      code: "PLAY_SESSION_ARCHIVED",
      message: "Restore the session.",
      retry: { kind: "after-user-action", discoveryEndpoint: "/api/v1/play-sessions/play-main/restore" },
    })).toBe("Use /api/v1/play-sessions/play-main/restore; then issue one new request.");

    expect(recoveryInstruction({
      code: "MUTATION_INTERRUPTED",
      message: "The outcome is unknown.",
      retry: { kind: "none" },
    })).toBe("Do not retry this request unchanged.");
  });

  it("recognizes structured API errors and only offers unchanged retry when authorized", () => {
    const refresh = Object.assign(new Error("Head moved"), {
      detail: {
        code: "BRANCH_HEAD_MOVED",
        message: "Head moved",
        retry: { kind: "after-refresh", maxAttempts: 1 },
      },
    });
    expect(webErrorDetail(refresh)).toMatchObject({ code: "BRANCH_HEAD_MOVED", retry: { kind: "after-refresh" } });
    expect(canRetrySameRequest(refresh)).toBe(false);
    expect(canRetrySameRequest(new Error("network disconnected"))).toBe(true);
  });
});
