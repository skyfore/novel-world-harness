# Implementation status

Date: 2026-08-11

This document describes behavior verified from the code on `agent/local-first-novel-cli`. It intentionally separates engine primitives from user-facing product completion.

## Overall assessment

The branch now implements a constrained end-to-end path from a local novel through reviewed compilation to selecting a character and committing natural-language actions. The authority boundaries are connected; extraction quality across arbitrary novels and a rich literary runtime are not yet established.

| Area | Status | What is actually usable |
| --- | --- | --- |
| Local file assistant | Implemented | Claude Code-style TUI, streaming/tool rendering, local lexical discovery, bounded reads, Pi sessions; model tools are read-only |
| Source ingest | Implemented | Content hash, source manifest, deterministic evidence segments |
| Model compilation | Implemented as a mechanism | Bounded/resumable Pi batches produce typed pending proposals and require an explicit finish handshake |
| Canonical acceptance | Implemented | Structural and cryptographic evidence validation; dependency-ordered acceptance |
| Canonical revisions | Implemented | Logical IDs point to immutable content-addressed revisions |
| World engine | Implemented vertical slice | Immutable commits/events/deltas, projection, branch CAS, rules, knowledge, frontier |
| Canon replay and branching | Implemented vertical slice | Predicate checkpoints, fork, diff, divergent possibility eligibility |
| Actor behavior | Partial | Deterministic goal actions are connected; model reasoner exists only as an adapter/API |
| Narrative | Partial | Immutable narrative frames and deterministic text exist; no Pi narration adapter is connected |
| Preparation workflow | Implemented vertical slice | Derived ingest/compile/review/audit/branch stages; one batch per invocation; never auto-accepts proposals |
| Player experience | Implemented vertical slice | Restricted Pi translation of natural language into a host-owned validated player event |
| Character embodiment | Implemented vertical slice | Character listing/selection, actor-scoped perception, repeatable actions, durable branch and resume selection |
| Live-test budget | Implemented | Persistent pre-request reservation and usage reconciliation under a 100M hard ceiling |
| Corpus quality | Not established | No annotated multi-novel benchmark demonstrates semantic reliability |

## Verified architecture

### Evidence and compilation

- Source files remain in the workspace and are registered by path, size, and SHA-256.
- Segments preserve source line and byte ranges.
- `compile-source` processes bounded batches and checkpoints only after successful proposal calls, a clean model stop, and `finish_compiler_batch`.
- Pi compiler sessions expose read-only file tools plus narrow `propose_*` tools.
- Proposals remain pending until explicit acceptance.
- Acceptance verifies that the registered source still has its ingest hash and that evidence byte/line ranges and quote hashes match.
- Canonical entities, claims, events, and rules use logical refs over immutable revisions.
- `proposals accept-all` accepts dependency-valid canonical artifacts and valid generic possibility templates; unsupported `state-delta` proposals remain staging artifacts.

Model interpretation is still probabilistic. These checks can reject unsupported or structurally invalid output, but cannot prove that an ambiguous passage was interpreted correctly.

### Runtime authority

- Branch truth is an immutable commit chain.
- Every new branch pins the exact canonical entity, claim, event, rule, and state-schema revisions used by its commits; later canonical edits do not change historical replay or actor views.
- State is deterministically projected from committed deltas.
- Branch heads use expected-parent checks and a local exclusive mutation lock; dead same-host lock owners are recovered and `world fsck` reports stale or active locks.
- Temporal world rules are evaluated against pre-state and proposed post-state.
- Canonical future events and generic background pressures enter the same possibility frontier.
- Possibility selection alone does not create truth; the resulting event proposal must pass the commit boundary.
- Knowledge is reconstructed per actor and per commit.
- Omniscient narrative rendering receives immutable projected state/history; actor rendering receives only the actor view and participant-visible events, and both paths check that rendering did not move the branch head.
- Snapshots are derived caches. `world fsck` verifies ancestry, hashes, replay, and snapshot drift.
- `world diff` compares projected state, divergent committed events, and actor knowledge. `world replay` always writes to a newly forked output branch.

### CLI paths now connected

```text
nwh ingest <novel>
nwh prepare [novel]
nwh compile-source
nwh proposals list|show|accept|accept-all|reject
nwh audit
nwh status

nwh world create|show|history|frontier
nwh world validate|move
nwh world knowledge|actor
nwh world fork|diff|replay|render
nwh world snapshot|fsck
nwh play-world --list-characters|--character|--action
nwh live-budget status
```

The ordinary `nwh` / `nwh play` session remains intentionally read-only and does not mutate the world.

Its terminal shell is a real Pi-backed TUI rather than a `readline` loop: regular/fullscreen rendering, transcript history, streaming state, tool rows, multiline editing, command completion, queue/interrupt shortcuts, status/footer data, and session replacement are connected. Character embodiment intentionally uses a separate restricted session boundary so a player action cannot inherit compiler omniscience or source access.

## Removed obsolete scaffold

The initial generic harness job queue, synthetic readiness metrics, unused runtime configuration, and placeholder worker settings were removed. They had been superseded by concrete source segments, compiler batch checkpoints, proposals, compiler audit, and world integrity checks.

Readiness is no longer inferred from artifact counts or arbitrary percentages. `nwh status` reports inventory; `nwh audit` reports evidence and consistency facts. Semantic coverage requires an explicit annotated denominator.

## Remaining product gaps

### 1. Preparation still requires human semantic review

`nwh prepare` derives and advances the safe state machine, but intentionally stops whenever pending proposals require semantic judgment. It points to `proposals show`; the user must accept or reject candidates. Repair suggestions are still coarse rather than proposal-specific.

### 2. Player action semantics are deliberately narrow

`play-world` connects natural language to deterministic commitment, but the current capability closure allows changes only to the selected actor and artifacts the actor owns. Explicitly named entities may be referenced but other characters cannot be directly rewritten. Rich physical affordances, dialogue consequences, combat, and social mechanics need dedicated deterministic rules rather than broader model authority.

### 3. Model actor policy is not connected to the product CLI

`modelActorProposalSource` correctly limits its input to `ActorWorldView + CharacterGoal + CharacterModel`, but no Pi-backed `ActorReasoner` is constructed by `world move`. The CLI uses deterministic pre-authored candidate actions only.

### 4. Rendering is still a debug renderer

`NarrativeRenderer` enforces the correct authority boundary, but its default adapter only lists committed event titles. A model-backed renderer must be added behind the same immutable frame contract and tested for epistemic leakage.

### 5. Compilation quality has no representative benchmark

The repository includes an evaluator API, but not a checked-in annotated corpus or a repeatable model evaluation command. Full-source batching proves bounded processing, not complete or correct world extraction.

### 6. Long-running evolution is still simplistic

The scheduler is deterministic and explainable, but pressure scoring, expiry, actor relevance, background cadence, and conflict policy have only small-fixture coverage. Large branch histories and multi-actor scenes have not been profiled.

## Recommended next milestone

Build one complete, constrained “novel player” vertical slice before broadening the schemas:

1. turn the checked-in synthetic smoke fixture into a repeatable opt-in live evaluation with expected artifact and player-turn assertions;
2. connect one Pi actor reasoner and one Pi narrative adapter behind the existing safe contracts;
3. add deterministic affordance/interaction rules for dialogue, transfer, travel, and conflict without granting a general write capability;
4. expose proposal-specific repair guidance in the preparation session;
5. run the same workflow on several licensed or user-provided annotated genres and use measured failures to refine prompts and schemas.

That milestone directly tests the product promise while preserving the architecture already established by [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md).
