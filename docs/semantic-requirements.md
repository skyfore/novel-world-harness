# Independent scene requirements

The existing `evaluateSceneCapabilities()` / `review-scenes` path now returns two additional diagnostic fields:

- `requirements`: independent definitions, current evidence/catalog fingerprints, per-requirement state and dependency blockers.
- `requirementRepairPlan`: a bounded, dependency-ordered recommendation for host review, including `remainingRequirementIds` when its limit is reached.

The existing case results, legacy repair tasks and source verification are retained. `verified` additionally requires the requirement assessment to be complete; it is never relaxed. No publication certificate, branch state, schema field, compiler session or repair authorization is created by these outputs.

## What is being assessed

An event-effects case is separated into a state-effect requirement, an agency requirement when the independent spec names an initiator, and a mechanism requirement when the spec requires a mechanism. The mechanism depends on the semantic requirements. A case-validation requirement preserves all original diagnostics, including failures not assigned to a specialized channel. Knowledge-cut, norm-scope and action-probe cases retain their complete independent case as a requirement.

The denominator comes from the independently supplied specification, not the candidate's nonempty fields or proposed artifacts. Original `delta`, `no-change` and `unmapped` expectations are copied into the report. A modeled state effect may pass while a missing mechanism remains blocked. A supported but unmapped source concept remains visible; a success label cannot silently lower it into an empty state delta.

`ownState` records a requirement's own check. `state` incorporates dependency blockers. `blockedBy` identifies the unsatisfied prerequisites. The states are:

| State | Meaning |
| --- | --- |
| satisfied | This exact independently specified check succeeded in the named context, without diagnostics, and its prerequisites succeeded |
| blocked | A check failed or a prerequisite is unsatisfied |
| unknown | No current result or the evaluator cannot determine the result |
| unmapped | The source expectation has no authorized executable representation |
| stale | Source hash, spec hash, catalog hash or evaluator version differs from the evaluated context |

These meanings are restricted to the supplied finite checks. They do not measure whole-book recall or certify long-running Play behavior.

## Recovery protocol

A requirement ID is not a proposal ID, artifact read handle or source read handle. Keep the reported target and source scope. The `source-anchor:` strings in `evidenceRefs` are diagnostic provenance addresses, not arguments for `read_source_evidence`; source tools still require their own discovered read handles. The original case evidence contains the exact anchors.

Do not retry `stale` results unchanged: obtain the current independent spec and source-scoped catalog and reevaluate. Do not rename IDs to bypass duplicate/scope/cycle errors; inspect and correct the definition under host review. An `unmapped` result requests ontology design review, never an arbitrary new state field or a fabricated value. A downstream check whose own result succeeded must be revalidated after upstream changes, not rewritten blindly.

Every repair task has `requiresHostAuthorization: true` and the plan has `authority: diagnostic-only`. `readyForHostReview` means its unsatisfied prerequisites are absent, not that a model may execute it. The host must still create an evidence-bounded, revision-bound repair scope under the compiler lock. Existing proposal obligations, finish receipts and reconciliation deferral gates remain authoritative and are not cleared by this report.

A bounded plan reports every unreturned requirement ID. It does not automatically paginate, execute later work or silently discard remaining obligations. Full persistent requirement accounting and the generic repair executor are later milestones in the [technical plan](plans/2026-09-16-evidence-first-world-model.zh-CN.md).

## Quotation content support

The attribution validator uses `assessQuotationContentSupport()`. `/object/kind` does not establish the object's value, entity or nested proposition. Alternative assertions for the same content field are allowed; anchors within a single assertion are conjunctive. Each anchor must fit within one cited source fragment, so a gap between quotations cannot be treated as quoted content.

The pure helper distinguishes unsupported from unverified. The existing no-object-evidence legacy path remains readable and is not newly certified. Structural-only object evidence is rejected. This is a field-level coverage safeguard, not the full future Expression/Perception/Acquisition model and not a natural-language entailment checker.
