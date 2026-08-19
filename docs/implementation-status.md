# Implementation status

Date: 2026-08-17

This document describes behavior verified from the code on `agent/local-first-novel-cli`. It intentionally separates engine primitives from user-facing product completion.

## Overall assessment

The branch now implements a constrained end-to-end path from a local novel through reviewed compilation to selecting a character and committing natural-language actions. The authority boundaries are connected; extraction quality across arbitrary novels and a rich literary runtime are not yet established.

| Area | Status | What is actually usable |
| --- | --- | --- |
| Terminal hub | Implemented | Claude Code-style TUI, workspace catalogs, committed progress, durable world resume, local lexical discovery, and bounded reads; general model tools remain read-only |
| Source ingest | Implemented | Exact file/stdin/inline bytes archived globally by SHA-256, source manifest, widened deterministic evidence segments, plus finish-gated declarative chapter discovery when built-in headings are insufficient |
| Model compilation | Implemented as a mechanism | Bounded/resumable Pi batches produce source-exclusive typed pending proposals, recover drafts across retries, allow narrow withdrawal, and use host-owned finish and total-tool-call circuit breakers |
| Canonical acceptance | Implemented | Structural and cryptographic evidence validation, evidence-grounded entity names/aliases, and dependency-ordered acceptance |
| Canonical revisions | Implemented | Logical IDs point to immutable content-addressed revisions |
| World engine | Implemented vertical slice | Immutable commits/events/deltas, projection, branch CAS, rules, knowledge, frontier |
| Canon replay and branching | Implemented vertical slice | Predicate checkpoints, fork, diff, divergent possibility eligibility |
| Actor behavior | Partial | Deterministic goal actions are connected; model reasoner exists only as an adapter/API |
| Narrative | Implemented vertical slice | Actor-scoped Pi scene narrator receives a bounded actor-safe frame plus exact retrieval, streams native provider/model, thinking, text, retry, and capture-tool events; accepted prose cannot mutate world truth |
| Preparation workflow | Implemented vertical slice | `prepare` remains one-batch/review-first; authorized `prepare-all` compiles all, accepts valid artifacts, quarantines invalid drafts, seeds an opening, and creates a branch |
| Prepared revisions | Implemented | MD5 lookup with SHA-256 verification, immutable bundle revisions, atomic active pointer, origin-independent whole/selected-chapter reparse, rollback and explicit activation |
| Local persistence | Implemented | Source, compiler, branch, and session data live below `$NWH_HOME`; new runs do not create workspace `.novel-harness/`, and legacy state is copied without deletion |
| Player experience | Implemented vertical slice | Restricted Pi translation into a host-owned player event, separately validated immediate world responses, and narrator choices with preflighted host fallback |
| Character embodiment | Implemented vertical slice | Character listing/selection, actor-scoped perception, repeatable actions, per-instance character memory, and durable active resume |
| Model token policy | User/provider controlled | NWH does not impose an application token or request-count budget; provider/model output metadata remains authoritative |
| Corpus quality | Not established | No annotated multi-novel benchmark demonstrates semantic reliability |

## Verified architecture

### Evidence and compilation

- Exact source bytes are copied to the private user-level material store and registered by origin label, size, MD5, and SHA-256; the origin may be deleted after ingest.
- Segments preserve source line and byte ranges.
- Built-in author headings are preferred. A longer heading-free source first gets a bounded, non-citable structure sample; the model may choose a literal prefix/number-style/suffix rule through `configure_chapter_split`, but cannot submit executable code or regex. The host requires exact sampled examples, validates all source-line matches, and persists the plan only inside a successful finish handshake. Prepared revisions retain that plan.
- Evidence segments are bounded at 96 KiB / 1,000 lines. Up to eight continuation segments from the same detected chapter may share a compiler batch, subject to 128 KiB serialized-source and byte limits; batches never merge different chapters.
- The full segment manifest is rederived from immutable source bytes and deep-compared before model context is built; a scoped compiler turn captures its selected slice before inference, so stale or mid-turn metadata cannot widen the evidence boundary.
- `compile-source` processes bounded batches and checkpoints only after active proposal calls form a closed graph, the model stops cleanly, and `finish_compiler_batch` succeeds. Stable batch provenance supplies exact active proposal IDs to recovery turns; ordinary source passes defer genesis to the dedicated opening pass. The host owns the active proposal set, executes proposal writes sequentially, caps it at 24, reserves the final finish handshake, rejects concurrent CLI compiler writers, and terminates finish failures or excessive compiler tool loops without checkpointing.
- Automated source/opening compiler sessions expose no generic workspace file
  tools. Reconciliation receives exact read-only raw-evidence tools bound to one
  active source; explicit manual compiler sessions may opt into local reads.
- Standalone source-, batch-, slice-, and tool-bounded Pi compiler jobs are
  fresh in-memory sessions and reject transcript resume/persistence. TUI
  compiler work stays human-visible in its assistant transcript but receives a
  turn-local projected evidence boundary. Only the explicit unscoped manual
  compiler conversation remains persistable as compiler model context.
- Proposals remain pending until explicit acceptance.
- Acceptance verifies the immutable archived source hash, evidence byte/line ranges and quote hashes, and that every canonical entity name and alias occurs in its verified evidence excerpt. Empty alias lists are valid.
- Canonical entities, claims, events, and rules use logical refs over immutable revisions.
- `proposals accept-all` accepts dependency-valid canonical artifacts and valid generic possibility templates; unsupported `state-delta` proposals remain staging artifacts.
- Automated source preparation does not expose the staging-only raw `state-delta` tool. Its catalogs, review barrier, and convergence are scoped to the selected source.
- Only the active batch is hydrated with a size-bounded artifact index. Exact
  canonical/pending semantics remain available through source-scoped,
  character-offset-paged read-only compiler tools, so truncation cannot silently turn
  into semantic amnesia or cross-novel context.
- Each source/opening proposal is rejected before storage when its evidence lies
  outside the host-supplied segment. Reconciliation can page the whole source,
  but cannot address another registered novel or general workspace files.
- Guided `prepare-all` quarantines uncommittable drafts in rejected history and uses a conservative evidence-backed opening-cast proposal only when the dedicated opening model pass produces no valid initial world; the fallback still passes normal validation.

Model interpretation is still probabilistic. These checks can reject unsupported or structurally invalid output, but cannot prove that an ambiguous passage was interpreted correctly.

### Runtime authority

- Branch truth is an immutable commit chain.
- Every new branch pins the exact canonical entity, claim, event, rule, state-schema, actor-policy, and possibility-template revisions used by its commits; later preparation edits do not change historical replay, actor behavior, or frontier inputs. Reparse pins a supplemental policy snapshot for legacy branch snapshots before changing current refs.
- State is deterministically projected from committed deltas.
- Branch heads use expected-parent checks and a local exclusive mutation lock; dead same-host lock owners are recovered and `world fsck` reports stale or active locks.
- Temporal world rules are evaluated against pre-state and proposed post-state.
- Canonical future events and generic background pressures enter the same possibility frontier.
- Possibility selection alone does not create truth; the resulting event proposal must pass the commit boundary.
- An accepted player event may causally select one currently eligible offered development through an isolated host-private linker; the response is a separate validated event, while unrelated background advancement remains opt-in.
- Knowledge is reconstructed per actor and per commit.
- A director-generated observation cannot learn a claim merely because its
  source citation overlaps a recent event; character knowledge changes require
  an explicit validated knowledge delta.
- Omniscient narrative rendering receives immutable projected state/history; actor rendering receives only the actor view and participant-visible events, and both paths check that rendering did not move the branch head.
- Snapshots are derived caches. `world fsck` verifies ancestry, hashes, replay, and snapshot drift.
- `world diff` compares projected state, divergent committed events, and actor knowledge. `world replay` always writes to a newly forked output branch.

### CLI paths now connected

```text
nwh ingest <novel>
nwh ingest --stdin|--content <text>
nwh prepare [novel]
nwh compile-source
nwh reparse --all|--chapters <selection>
nwh prepared-cache list|activate
nwh proposals list|show|accept|accept-all|reject
nwh audit
nwh status
nwh novels|instances|characters|progress
nwh resume [instance] --character <id-or-name>
nwh continue|switch|create [novel] [--instance <id>] [--character <id-or-name>]

nwh world create|show|history|frontier
nwh world validate|move
nwh world knowledge|actor
nwh world fork|diff|replay|render
nwh world snapshot|fsck
nwh play-world --list-characters|--character|--action
```

The general model inside `nwh` / `nwh play` remains read-only with respect to files and world truth; its only metadata mutation is the narrow `rename_session` tool used to give transcripts target-specific selector titles. The host TUI can enter player mode through `/continue`, `/switch`, `/create-instance`, `/play`, a natural character-selection request, `nwh resume`, or a saved active selection. Instances persist their owning source and prepared revision; new genesis snapshots are source-scoped, and legacy branches are inferred only when their genesis has one unambiguous source. `/remove` supports confirmed removal of one leaf instance, a novel's mutable analysis, or both the novel registration and all owned instances while retaining immutable archived source evidence. Interactive CLI startup continues the last transcript explicitly recorded as opened; first-run migration derives logical conversation activity without counting metadata-only touches, and Pi's recent-file lookup remains a final fallback. Exact `--session <id>` restoration is available and is printed after exit. Ctrl+C uses a visible two-press, two-second exit gate while retaining first-press cancellation/clear behavior. A plain `--new-session`, `/new`, or `/clear` preserves compiled and committed world progress but starts an unbound conversation; explicit player-entry commands can still open their selected world in a fresh transcript. Main-agent requests show an animated, randomly worded owl indicator above the editor until the run fully settles, so provider thinking, text streaming, and tool waits never resemble a frozen CLI. While player mode is active, ordinary input is intercepted before the general agent and delegated to a fresh restricted player-action session; it therefore cannot inherit compiler omniscience, source access, or local-file context. The action model receives turn-local opaque IDs and a bounded actor-safe projection with exact retrieval over that same corpus.

## Removed obsolete scaffold

The initial generic harness job queue, synthetic readiness metrics, unused runtime configuration, and placeholder worker settings were removed. They had been superseded by concrete source segments, compiler batch checkpoints, proposals, compiler audit, and world integrity checks.

Readiness is no longer inferred from artifact counts or arbitrary percentages. `nwh status` reports inventory; `nwh audit` reports evidence and consistency facts. Semantic coverage requires an explicit annotated denominator.

## Remaining product gaps

### 1. Preparation still requires human semantic review

`nwh prepare` derives and advances the safe state machine, but intentionally stops whenever pending proposals require semantic judgment. It points to `proposals show`; the user must accept or reject candidates. Repair suggestions are still coarse rather than proposal-specific.

### 2. Player mutation capabilities are deliberately narrow

The TUI player mode and `play-world` now interpret free-form input into typed
intent and pass it through an isolated current-world adjudicator before
deterministic commitment. The host no longer derives movement, destination,
duration, or consequence from language-specific text patterns. Direct
contradictions become model-proposed, contradiction-certified in-world
consequences rather than canned invalid-action results. The capability closure
still allows direct state changes only to the selected actor and artifacts the
actor owns. Explicitly named entities may be targeted or referenced, but other
characters cannot be directly rewritten. Rich physical, combat, and social
effects still need validated consequence proposals and stronger domain evals,
not broader mutation authority.

The interpreter also separates an actor-controlled act from its desired world
effect. World-resolution protocol misses receive one fresh isolated retry. If
both attempts fail, only a deterministic, write-free `observe`/`stay` primitive
may be committed; its desired discovery remains audit-only. All wider intents
remain uncommitted and recover out of character rather than masquerading as an
in-world blockage. This fallback never writes knowledge or active rules.

### 3. Model actor policy is not connected to the product CLI

`modelActorProposalSource` limits a reasoner to turn-local opaque actor handles,
actor-visible state/knowledge, one currently active goal's description,
priority and visible targets, the active disposition, and committed development.
Inactive/future policy phases, goal IDs/triggers, canonical IDs, evidence and
engine chronology are excluded, and the returned action crosses the normal
actor capability gates. No Pi-backed `ActorReasoner` is constructed by
`world move`; the CLI still uses deterministic pre-authored candidates only.

### 4. The low-level renderer remains diagnostic

`NarrativeRenderer` still provides deterministic event-title rendering for low-level CLI/API inspection. The TUI player path now adds an isolated Pi narrator over a bounded committed actor frame, two exact read-only retrieval tools, and a capture-only choice tool. Broader prose-quality, parametric-canon recall, and epistemic-leakage evaluation across representative novels is still required.

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
