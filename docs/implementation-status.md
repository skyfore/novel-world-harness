# Implementation status: executable novel world engine

Date: 2026-08-11

This document maps the implementation on `agent/local-first-novel-cli` to [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md) and [Technical Design](technical-design.md).

## Executive status

The architecture is no longer only a Phase 0 CLI scaffold. The branch now contains a tested executable vertical slice from source evidence through canonical compilation, deterministic world execution, canon replay, branch divergence, actor-scoped knowledge/policy, and narrative rendering.

The remaining uncertainty is primarily **semantic model quality and corpus coverage**, not the authority/commit/runtime architecture. That distinction matters: no amount of deterministic code can prove that an ambiguous literary interpretation is correct, but deterministic code can ensure that unsupported or structurally invalid model output does not silently become world truth.

## Milestone mapping

### M1 — world contracts and immutable storage: implemented

- strict Zod/TypeScript contracts for entities, claims, times, predicates, events, deltas, rules, branches, possibilities, knowledge, proposals, commits, and state;
- canonical serialization/content hashing;
- immutable content-addressed runtime delta/event/knowledge/commit objects;
- atomic branch metadata/head writes;
- stale-parent compare-and-swap protection;
- single-writer branch lock semantics.

### M2 — deterministic reducer and validation: implemented

- registered state fields with type/domain constraints;
- deterministic predicate evaluator;
- deterministic `StateDelta` reducer;
- replayable `WorldProjector`;
- precondition validation;
- engine invariants;
- temporal in-world rule evaluation;
- dry-run post-state rule prohibition checks;
- stale-parent rejection at commit boundary.

### M3 — evidence-backed canonical compiler: implemented as a bounded model pipeline

- deterministic source registration and hashing;
- deterministic source segmentation preserving original UTF-8 byte/line spans;
- source mutation detection after ingest;
- bounded/resumable source compiler batches;
- explicit Pi compiler mode with typed proposal tools and no general file write/shell capability;
- pending/accepted/rejected proposal lifecycle;
- deterministic cross-artifact validation;
- cryptographic EvidenceRef verification against ingested source bytes;
- dependency-ordered batch acceptance;
- canonical initial-world seed;
- actor goal/model artifacts.

The semantic extractor is intentionally model-backed rather than a deterministic parser. Its quality must be evaluated against novels/fixtures; model output remains non-authoritative until validation.

### M4 — canon replay: implemented

- replay checkpoints are predicates over projected world state;
- runtime does not receive a forced list of next canonical event IDs;
- mismatch returns diagnostics rather than patching the history;
- golden tests verify the runtime can reach canonical checkpoints through eligible possibilities.

### M5 — possibility frontier and scheduler: implemented

- lifecycle: latent / eligible / blocked / expired / superseded / realized;
- preconditions/blockers/expiry;
- explainable scheduler factor/score output;
- canonical-event analogues are ordinary uncommitted possibilities;
- canonical causal parents gate downstream eligibility;
- realized possibility IDs are derived from committed history, preventing replay loops;
- frontier materialization is a cache, not truth.

### M6 — counterfactual branching: implemented

- branches share immutable history at fork points;
- new branch heads diverge independently;
- future canonical events become latent when changed state destroys their preconditions;
- branch state diff command exposes durable downstream differences;
- golden E2E test verifies a high-impact intervention does not silently snap back to canon.

### M7 — actor knowledge and policy: implemented for deterministic goal actions

- knowledge deltas are immutable objects referenced by committed events;
- `KnowledgeProjector` reconstructs actor-scoped knowledge per commit;
- `ActorWorldView` exposes self state + known claims, not compiler omniscience;
- character goals can require/block on actor knowledge;
- actor action candidates are generated only from the actor's current view;
- concurrent actor candidates use deterministic write-set conflict adjudication;
- selected actor proposals are still revalidated against the current head before commit.

The policy layer is deliberately simple and inspectable today. Frontier-model LLM actor reasoning can be added behind the same `ActorWorldView -> EventProposal` contract without changing world truth semantics.

### M8 — narrative separation: implemented

- rendering consumes immutable/projected history frames;
- actor POV uses actor-scoped views;
- renderer checks that branch head did not move;
- the same committed history can be rendered in different styles without changing truth.

Long-horizon literary quality remains a model/prompt evaluation problem rather than a mutation-authority problem.

### M9 — full-source expansion: implementation framework complete; quality evaluation ongoing

- whole sources are segmented deterministically;
- compiler batches are bounded by size/count;
- successful batches checkpoint and resume;
- failed batches remain unfinished and retryable;
- evidence references are supplied with source slices;
- proposal review/acceptance remains separate from extraction.

"Full-source support" here means the pipeline can process a complete source incrementally without changing the authority model. It does **not** mean every entity/event/theme in every genre is already extracted perfectly. That is an empirical model-quality target.

## Reliability and operations

Implemented:

- derived snapshot cache that is never used as semantic authority;
- `world fsck` traversal of branch heads and immutable object graph;
- content-hash validation on reads;
- replay determinism checks;
- causal/fork ancestry checks;
- unreachable immutable objects reported as warnings rather than silently deleted;
- compiler audit reports source/proposal/canonical/evidence/causal inventory;
- coverage dimensions without a trustworthy denominator remain `null` rather than being fabricated.

## User workflows

### Compile

```text
nwh ingest <novel>
nwh compile-source [--source <id>] [--max-batches N]
nwh proposals list
nwh proposals accept-all
```

### Execute

```text
nwh world create main
nwh world show --branch main
nwh world frontier --branch main
nwh world validate <player-proposal.json> --branch main
nwh world move --branch main [--player <proposal.json>]
```

### Inspect actors

```text
nwh world knowledge <actor> --branch main
nwh world actor <actor> --branch main
```

### Diverge and evaluate

```text
nwh world fork alternate --branch main
nwh world move --branch alternate --player <different-action.json>
nwh world diff main alternate
nwh world replay <checkpoints.json> --branch main
```

### Operate

```text
nwh world snapshot --branch main
nwh world fsck
```

## Test strategy now represented in the repository

The suite covers, among other cases:

- immutable object/hash behavior;
- branch CAS semantics;
- state replay/invariants;
- rule enforcement on proposed post-state;
- possibility lifecycle and non-repetition;
- canonical causal ordering without chapter scripting;
- actor knowledge isolation and branch divergence;
- actor policy knowledge gating and conflict adjudication;
- narrative rendering purity;
- canonical initial world;
- source segmentation including CRLF byte offsets;
- source mutation detection;
- bounded/resumable compiler batches;
- cryptographically verified compiler evidence;
- canonical proposal validation;
- snapshot/fsck behavior;
- compiler-to-canon-to-replay-to-counterfactual-world E2E behavior.

## What should be optimized next

The next engineering work should be driven by corpus experiments, not by adding another storage abstraction prematurely:

1. create golden annotated slices across multiple genres;
2. measure entity identity stability, event/state-delta fidelity, temporal/causal accuracy, and epistemic leakage;
3. improve compiler prompts and adjudication based on those failures;
4. add richer non-authoritative narrative/meta observation artifacts;
5. add LLM actor policy behind the existing actor-view contract where deterministic goal policies are insufficient;
6. profile very large histories before introducing snapshot-assisted authoritative replay or a database;
7. improve terminal UX only after model/runtime semantics remain stable.

A future database remains an implementation option behind storage boundaries if concurrency/scale data justifies it. It is not required for source discovery or current runtime semantics.
