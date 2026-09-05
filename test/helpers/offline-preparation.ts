import { afterEach, beforeEach, vi } from "vitest";
import * as certification from "../../src/compiler/certification.js";
import * as roleReview from "../../src/workflow/role-review.js";
import { PreparedNovelCache } from "../../src/compiler/prepared-cache.js";

/**
 * Component tests with old hand-authored worlds isolate the new certification boundary.
 * No certificate or pi-live result is fabricated, persisted, or counted as release evidence.
 * Certification and public rejection paths have separate tests using the real validator.
 * This module is test-only; production has no bypass option or environment switch.
 */
export function useOfflinePreparationBoundary(): void {
  const restore: Array<() => void> = [];
  beforeEach(() => {
    const review = vi.spyOn(roleReview, "reviewNovelRoles").mockImplementation(async () => undefined);
    const inspection = vi.spyOn(PreparedNovelCache.prototype, "inspectCandidate").mockImplementation(async () => ({ bundle: null, assessment: { fullNovelReady: true, playability: null, issues: [] } }) as never);
    restore.push(() => review.mockRestore(), () => inspection.mockRestore());
    const assertion = vi.spyOn(certification, "assertPreparedReadiness").mockImplementation(() => undefined);
    const assessment = vi.spyOn(certification, "assessNovelClosure").mockImplementation(async () => null as never);
    restore.push(() => assertion.mockRestore(), () => assessment.mockRestore());
    // Archive tests explicitly activate their otherwise uncertified artifact fixture.
    const publish = PreparedNovelCache.prototype.publish;
    const publication = vi.spyOn(PreparedNovelCache.prototype, "publish").mockImplementation(async function (this: PreparedNovelCache, source, options) {
      const result = await publish.call(this, source, options);
      if (options?.allowSemanticDebtForRollback && result.bundleHash) await this.activate(source, result.bundleHash, { allowIncompatibleRollback: true });
      return result;
    });
    const legacy = PreparedNovelCache.prototype.publishLegacyRollbackBaseline;
    const rollback = vi.spyOn(PreparedNovelCache.prototype, "publishLegacyRollbackBaseline").mockImplementation(async function (this: PreparedNovelCache, source, checkpoint) {
      const result = await legacy.call(this, source, checkpoint);
      if (result.bundleHash) await this.activate(source, result.bundleHash, { allowIncompatibleRollback: true });
      return result;
    });
    restore.push(() => publication.mockRestore(), () => rollback.mockRestore());
  });
  afterEach(() => { for (const reset of restore.splice(0).reverse()) reset(); });
}
