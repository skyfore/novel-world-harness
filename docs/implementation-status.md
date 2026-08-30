# Implementation status

Date: 2026-08-30

Verified baseline: `pnpm run check`; `pnpm test` (127 test files, 721 tests
passing); `pnpm test:e2e` (production Fastify host + Chromium journey passing).

This document describes behavior verified from the code on `agent/local-first-novel-cli`. It intentionally separates engine primitives from user-facing product completion.

## Overall assessment

The branch now implements a constrained end-to-end path from a local novel through reviewed compilation to selecting a character and committing natural-language actions. The authority boundaries are connected; extraction quality across arbitrary novels and a rich literary runtime are not yet established.

The code citations, external primary sources, gap analysis, and phased acceptance
plan behind this status are documented in
[Evidence-Grounded Full-Novel Semantic Compilation](novel-semantic-compilation-plan.md)
and its [Chinese research report](novel-semantic-compilation-plan.zh-CN.md).

| Area | Status | What is actually usable |
| --- | --- | --- |
| Terminal hub | Implemented | Claude Code-style TUI, workspace catalogs, committed progress, durable world resume, local lexical discovery, and bounded reads; general model tools remain read-only |
| Local Web UI | MVP implemented | Loopback-first React/Fastify workbench for source ingest, preparation/review, instance lifecycle, Pi-backed play/resume, append-only run/LLM/tool/context traces, and branch/time-scoped model/event/place/rule/provenance graphs; long operations and short mutations retain idempotency/recovery state across restart; no product login or remote multi-user deployment |
| Source ingest | Implemented | Exact file/stdin/inline bytes archived globally by SHA-256, source manifest, widened deterministic evidence segments, plus finish-gated declarative chapter discovery when built-in headings are insufficient |
| Model compilation | Implemented as a mechanism | Bounded/resumable Pi batches produce source-exclusive typed pending proposals, recover drafts across retries, allow narrow withdrawal, and use host-owned finish and total-tool-call circuit breakers |
| Source observations | M2 + M3b-1 implemented | Immutable-source paragraph/sentence partition, exact entity/event mention, quotation, and discourse annotations, source-local closure, accounting, audit, batch recovery, and paged retrieval; event mentions carry no truth or canonical-event authority |
| Entity resolution | M3a implemented | Deterministic source-scoped lexical candidates, explicit resolved/new/ambiguous/unresolved decisions, immutable superseding revisions, unresolved audit queues, and canonical name/alias trace gates |
| Event resolution | M3b implemented | Source-scoped evidence/title/participant candidates, explicit coreference vs subevent clusters, resolved/new/ambiguous/unresolved decisions, merge/split revisions, major-event coverage, participant trace, and canonical-event commit gates |
| Proposition, attribution, and knowledge acquisition | M4a implemented | Reusable proposition content is separated from narrator/character/document attitudes; quotation IDs trace holders to resolved speakers, and additive knowledge provenance records proposition, attribution, and acquisition mode without breaking legacy claim-keyed replay |
| Event participation semantics | M4b-1 implemented | Versioned event/entity/semantic-role records keep character presence independent from agency, require a complete lossless projection to legacy `participants`/`participantPresence`, participate in compiler closure and prepared-publication gates, and are pinned in runtime snapshot V5 |
| Event relation semantics | M4b-2 implemented | Independently evidenced temporal, causal, explanatory, identity/subevent, and narrative-continuation records have deterministic closure, contradiction, cycle, and legacy-projection validation; only non-contested `causes`/`enables` relations project to `causalParents`, and runtime snapshot V6 pins their revisions |
| Character semantics | M5a implemented | Versioned behavioral dimensions separate contextual dispositions, event appraisals, and event-gated development episodes; stable inference and counter-evidence rules fail closed, legacy free-form keys are explicitly namespaced, and actor-facing projections remain future-canon and visibility safe |
| Spatial semantics | M5b-2a implemented | Exact-evidence-backed containment, adjacency, and route artifacts are source-scoped, graph-validated, revision-pinned in snapshot V7, and actor-safe; compiled travel requires an active direction/mode-compatible route and respects known minimum duration, while adjacency never proves passage |
| World-rule semantics | M5b-2b implemented | Controlled kind/scope, authority, jurisdiction, applicability, per-clause requirements/prohibitions, exceptions, visibility, defeasibility, and explicit superiority are exact-evidence-backed and catalog-validated; contested semantics never execute, priority alone never resolves conflict, and hidden rules enforce without actor leakage |
| Reparse invalidation | Direct dependencies implemented | Whole/selected-chapter reparse uses byte/line containment for exact quote subspans and covers propositions, attributions, participation, event relations, nested spatial/rule evidence, and character ontology; cross-chapter artifacts and pinned branches remain intact, while transitive impact closure is not yet implemented |
| Canonical acceptance | Implemented | Structural and cryptographic evidence validation, evidence-grounded entity names/aliases, and dependency-ordered acceptance |
| Canonical revisions | Implemented | Logical IDs point to immutable content-addressed revisions |
| World engine | Implemented vertical slice | Immutable commits/events/deltas, projection, branch CAS, rules, knowledge, frontier |
| Canon replay and branching | Implemented vertical slice | Predicate checkpoints, fork, diff, divergent possibility eligibility |
| Actor behavior | Partial | Direct typed player interactions invoke a Pi-backed, actor-scoped NPC response lane with perceived-history retrieval, development/goals/affect context, and validated causal commits; unrelated proactive behavior still uses deterministic candidates |
| Narrative | Implemented vertical slice | Actor-scoped Pi scene narrator receives a bounded actor-safe frame plus exact retrieval, streams native provider/model, thinking, text, retry, and capture-tool events; accepted prose cannot mutate world truth |
| Preparation workflow | Implemented vertical slice | `prepare` remains one-batch/review-first; authorized `prepare-all` compiles all, accepts valid artifacts, quarantines invalid drafts, seeds an opening, and creates a branch |
| Prepared revisions | Implemented with evidence-portability gap | MD5 lookup with SHA-256 verification, immutable bundle revisions, atomic active pointer, origin-independent whole/selected-chapter reparse, rollback and explicit activation; canonical `EvidenceRef`s travel, but exact assertion revisions/bindings are not yet serialized in the bundle |
| Local persistence | Implemented | Source, compiler, branch, and session data live below `$NWH_HOME`; new runs do not create workspace `.novel-harness/`, and legacy state is copied without deletion |
| Player experience | Implemented vertical slice | Restricted Pi translation into a host-owned player event, exact bounded continuity, reactive NPC responses, validated immediate developments, bounded post-divergence canonical scaffold recovery, merged model suggestions plus host-preflighted exits, stagnation detection, and an explicit material-progress wait route |
| Character embodiment | Implemented vertical slice | Role-before-branch selection, spoiler-free opening setup, reader-only complete prior-event recaps, source-backed first-embodied-scene checkpoints for later roles, actor-scoped perception, sibling entry branches, and durable active resume |
| Model token policy | User/provider controlled | NWH does not impose an application token or request-count budget; provider/model output metadata remains authoritative |
| Corpus quality | Not established | No annotated multi-novel benchmark demonstrates semantic reliability |

## Verified architecture

### Evidence and compilation

- Exact source bytes are copied to the private user-level material store and registered by origin label, size, MD5, and SHA-256; the origin may be deleted after ingest.
- Segments preserve source line and byte ranges.
- A deterministic work/paragraph/sentence/non-scene tree partitions every
  immutable source byte. Mention, quotation, and overlapping discourse records
  live in a separate non-canonical observation store with immutable revisions
  and atomic current refs. Models submit exact text selectors; the host resolves
  offsets and hashes. Mention and quotation relations use mention IDs, so this
  layer cannot silently manufacture canonical entities or aliases.
- Event mentions preserve exact trigger/extent evidence, participant mention
  references, discourse context, type candidates, and salience without
  asserting occurrence, chronology, effects, or causality. Their source-local
  references are finish-gated and their payloads use the same immutable
  observation revision lifecycle.
- Entity identity is a separate versioned decision keyed by mention. Exact and
  normalized name/alias matches generate candidates deterministically, but do
  not auto-merge. Canonical names and aliases from sources with mention
  inventory must pass both finish-time and commit-time resolution trace gates;
  ambiguity remains stored and blocks resolution readiness.
- Event identity is a separate versioned cluster decision. Evidence overlap,
  title/trigger similarity, and participant overlap only rank candidates;
  coreference versus subevent remains explicit. Cluster merge/split revisions
  preserve prior partitions, while canonical events and every participant must
  trace through accepted event/entity mention resolutions.
- Built-in author headings are preferred. A longer heading-free source first gets a bounded, non-citable structure sample; the model may choose a literal prefix/number-style/suffix rule through `configure_chapter_split`, but cannot submit executable code or regex. The host requires exact sampled examples, validates all source-line matches, and persists the plan only inside a successful finish handshake. Prepared revisions retain that plan.
- Evidence segments are bounded at 96 KiB / 1,000 lines. Up to eight continuation segments from the same detected chapter may share a compiler batch, subject to 128 KiB serialized-source and byte limits; batches never merge different chapters.
- The full segment manifest is rederived from immutable source bytes and deep-compared before model context is built; a scoped compiler turn captures its selected slice before inference, so stale or mid-turn metadata cannot widen the evidence boundary.
- `compile-source` processes bounded batches and checkpoints only after active proposal calls form a closed graph, the model stops cleanly, and `finish_compiler_batch` succeeds. Stable batch provenance supplies exact active proposal IDs to recovery turns; ordinary source passes defer genesis to the dedicated opening pass. The host owns the active proposal set, executes proposal writes sequentially, hides capacity counters from the model, forbids budget-driven semantic deletion, keeps only high runaway safety fuses (800 proposals / 1,000 calls), reserves the final finish handshake, rejects concurrent CLI compiler writers, and terminates finish failures or pathological compiler tool loops without checkpointing.
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
- Proposition content and epistemic/speech attribution are accepted as separate
  immutable semantic artifacts. Proposition polarity/modality never implies
  world truth; attribution records who asserts, knows, believes, suspects,
  reports, denies, or questions that content. Subject/object, holder kind,
  nested proposition, source-attribution, and dependency-cycle validation all
  fail closed. These artifacts are retained in prepared bundles and branch
  snapshots but do not enter state projection automatically.
- Quotation-backed attribution is independently traceable through source-local
  quotation IDs and entity-resolution decisions. Character holders must match
  resolved speakers; narrator/unknown holder rules fail closed. `told` and
  `read` knowledge acquisition additionally require an attributed quotation,
  and `told` recipients must match a resolved addressee.
- Knowledge remains keyed by `claimId` for old prepared revisions and runtime
  compatibility. New operations may add `propositionId`, `attributionId`, and
  one of six acquisition modes. The validator proves a lossless positive,
  asserted claim/proposition projection and source/holder coherence before commit; actor projection
  preserves this provenance without exposing global state or compiler
  omniscience. Audit reports semantic-operation coverage, modes, and broken
  quotation/acquisition traces.
- Event relations are immutable semantic artifacts, separate from both event
  records and discourse order. Models submit exact supporting/contradicting
  text selectors; trusted evidence ranges and hashes are host-generated.
  Deterministic catalog validation rejects dangling endpoints, incompatible
  story-time order, duplicate/inverse contradictions, and relevant graph
  cycles. Only non-contested `causes` and `enables` relations can reproduce the
  legacy causal-parent projection; narrative continuation never does.
- Character models may use the `character-v1` controlled ontology. Dispositions
  record global/context/target scope, stable versus situational applicability,
  inference basis, validity time, confidence, and support/contest status.
  Event appraisal and development episodes remain distinct records. Host-owned
  exact selectors supply nested evidence and counter-evidence; catalog closure
  rejects dangling event, proposition, goal, target, and before/after
  disposition references. Exact assertions and embedded spans must agree before
  submit, closure, commit, audit, and prepared publication. Runtime projection
  admits only realized or personally experienced triggers, derives development
  status from the current branch, and strips evidence, internal IDs, and
  unrestricted causal/intent prose before model exposure.
- Character models may independently use the `relationship-v1` directed-policy
  ontology. A relationship is active for one actor only when committed state
  proves that actor's relationship membership, exact `from`/`to` direction,
  `active === true`, and a controlled primary type. Trust, affinity, respect,
  perceived threat, dependence, and influence remain separate stance dimensions;
  proposition-backed typed obligations and same-pair before/after changes have
  their own event, experience, knowledge, time, reversal, confidence, and exact
  evidence gates. These records are immutable policy inputs, never world truth.
  Actor-facing projections remove evidence and compiler identities and omit
  invisible targets. Audit reports directed/type state coverage, legacy
  kind/strength/obligation operations, relationship-policy inventory, and
  reference failures; prepared publication repeats exact-evidence validation.
- Canonical space may use the `spatial-v1` ontology. `contains`, normalized
  symmetric `adjacent`, and directional `route` records keep topology separate
  from dynamic `character.location` and `location.controller` state. Endpoint,
  event/claim/rule/predicate closure, static and active containment graph
  invariants, and exact support/counter-evidence are checked at compiler and
  prepared-publication boundaries. Runtime traversal uses routes only, matches
  explicit travel mode and known minimum duration, and treats containment as a
  possibly shared physical scope without inventing passage. Actor projections
  apply public/observable/knowledge/engine visibility and strip compiler
  evidence/identities before opaque-handle transport. Audit reports topology
  inventory, gates, visibility, conflicts, reference errors, and location
  coverage.
- Canonical rules may use `world-rule-v2`. Rules separate kind/scope,
  authority, jurisdiction, applicability, concrete time validity, disclosure,
  knowledge grounding, defeasibility, and explicit override from independently
  evidenced require/forbid clauses and exceptions. Catalog validation rejects
  dangling or kind-invalid authority/jurisdiction, unbound scope, contradiction,
  illegal superiority, and override cycles. Runtime resolves only committed
  active IDs, checks requirements on pre-state and prohibitions on proposed
  post-state, and omits hidden or actor-unknown rules from prompts without
  weakening engine enforcement. Audit reports controlled/legacy inventory,
  exact evidence, reference failures, and potential cross-rule conflicts.
- Exact evidence assertions are immutable and artifact-hash-bound in the
  compiling workspace and are exposed by artifact retrieval. The prepared
  bundle currently serializes canonical artifacts but not assertion revisions
  or bindings; restoring that bundle elsewhere therefore retains embedded
  `EvidenceRef`s but loses field-level provenance. This is a P0 portability gap,
  not evidence that the original local assertions were invalid.
- Canonical entities, propositions, attributions, claims, events, event
  participations, event relations, spatial relations, and rules use
  logical refs over immutable revisions.
- `proposals accept-all` accepts dependency-valid canonical artifacts and valid generic possibility templates; unsupported `state-delta` proposals remain staging artifacts.
- Automated source preparation does not expose the staging-only raw `state-delta` tool. Its catalogs, review barrier, and convergence are scoped to the selected source.
- Only the active batch is hydrated with a size-bounded artifact index. Exact
  canonical/pending semantics remain available through source-scoped,
  character-offset-paged read-only compiler tools, so truncation cannot silently turn
  into semantic amnesia or cross-novel context.
- Each source/opening proposal is rejected before storage when its evidence lies
  outside the host-supplied segment. Reconciliation can page the whole source,
  but cannot address another registered novel or general workspace files.
- Guided `prepare-all` quarantines uncommittable drafts in rejected history. If the dedicated opening model pass produces no valid initial world, the deterministic alive-only fallback is restricted to a genuinely single-character source; multi-character novels fail closed until the compiler supplies an evidence-backed actionable opening role.

Model interpretation is still probabilistic. These checks can reject unsupported or structurally invalid output, but cannot prove that an ambiguous passage was interpreted correctly.

### Runtime authority

- Branch truth is an immutable commit chain.
- Every new branch pins the exact canonical entity, claim, event, spatial-relation, rule, state-schema, actor-policy, and possibility-template revisions used by its commits; later preparation edits do not change historical replay, actor behavior, movement validation, or frontier inputs. Snapshot V7 carries spatial revisions; V1-V6 contexts load without retroactive spatial-v1 enforcement. Reparse pins a supplemental policy snapshot for legacy branch snapshots before changing current refs.
- State is deterministically projected from committed deltas.
- Branch heads use expected-parent checks and a local exclusive mutation lock; dead same-host lock owners are recovered and `world fsck` reports stale or active locks.
- Active controlled world rules resolve committed activation, time,
  applicability, supported exceptions, and explicit overrides; requirements
  are evaluated against pre-state and prohibitions against proposed post-state.
  Priority is not an implicit conflict resolver.
- Canonical future events and generic background pressures enter the same possibility frontier.
- Possibility selection alone does not create truth; the resulting event proposal must pass the commit boundary.
- An accepted player event may causally select one currently eligible offered development through an isolated host-private linker; the response is a separate validated event, while unrelated background advancement remains opt-in.
- When the accepted player event directly conflicts with and supersedes a currently eligible canonical event, that turn receives one bounded progression slot. The runtime scans accepted canonical scaffolds in story-time/evidence order, records and skips candidates with failed hard dependencies, and prefers an exact event only when its canonical-self role binding also passes the stronger scaffold gates.
- A scaffold exposes at most four explicitly compiled functional roles. The host enumerates only branch-present, non-dead, kind-compatible bindings satisfying the pinned state, knowledge, causal, time, blocker, and active-scene gates. An isolated capture-only Pi call may select one opaque binding and add title/participant observation/affect; it cannot propose participants, time, dependencies, state, knowledge, or evidence.
- The engine independently reloads the pinned scaffold and compares all locked fields before commitment, then rechecks branch availability, scene presence, required knowledge, and causal parents at the current head. An exact candidate that fails only the stronger role gates is denied for that move and recorded in the turn audit. A committed analogue is tracked as `adapted`, not exact canon: it prevents duplicate canon and can satisfy downstream causal dependencies without writing `realizesCanonicalEventIds`.
- Explicit waiting advances committed time by five minutes and may schedule at most one eligible autonomous non-canon process in the current temporal window. With no eligible process, time still advances; forward canon analogues are excluded.
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

For a new instance, the role is resolved before genesis. An opening role uses the
accepted opening cut; a later role receives a sibling branch at its first
source-backed embodied checkpoint plus a display-only recap of every preceding
discourse event. That reader recap never enters actor knowledge, the player-action
model, NPC reasoning, or scene narration input.

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

### 3. Proactive model actor policy is not connected to the product CLI

The product now connects a separate reactive Pi lane for NPCs directly
addressed by typed player speech, gesture, or physical interaction. That lane
receives only the NPC's perceived history, knowledge, current
development/goals/affect and bounded capabilities, and commits explicit speech,
gesture, refusal, or silence through normal deterministic gates with the player
event as causal parent.

`modelActorProposalSource` limits an unrelated proactive reasoner to turn-local opaque actor handles,
actor-visible state/knowledge, one currently active goal's description,
priority and visible targets, the active disposition, and committed development.
Inactive/future policy phases, goal IDs/triggers, canonical IDs, evidence and
engine chronology are excluded, and the returned action crosses the normal
actor capability gates. No Pi-backed proactive `ActorReasoner` is constructed
by `world move`; unrelated initiative still uses deterministic pre-authored
candidates only.

### 4. The low-level renderer remains diagnostic

`NarrativeRenderer` still provides deterministic event-title rendering for low-level CLI/API inspection. The TUI player path now adds an isolated Pi narrator over a bounded committed actor frame, exact actor-frame and related-message retrieval, and a capture-only choice tool. Broader prose-quality, parametric-canon recall, and epistemic-leakage evaluation across representative novels is still required.

### 5. Compilation quality has no representative benchmark

The repository includes a rich semantic gold schema, but not a checked-in
annotated multi-novel corpus or a complete repeatable semantic evaluator. The
current scorer reads only canonical entity/claim/event/rule/goal/model IDs and
legacy causal-parent pairs; every annotated mention, cluster, quotation,
participation, typed relation, proposition, knowledge, state-effect, and
character layer is reported as `not-implemented`. Full-source batching and
internal source accounting prove bounded/closed processing, not complete or
correct world extraction.

### 6. Exact evidence portability and transitive repair are incomplete

Field-level exact assertions are available and hash-bound in the compiling
workspace, but prepared bundles carry only canonical artifacts. A restored
revision therefore loses assertion bindings. Selected-chapter reparse now
correctly invalidates every directly supported semantic collection using exact
subspan containment, but it does not calculate mention-to-runtime transitive
impact. Cross-chapter aggregate models cannot yet mark one nested semantic item
stale without replacing the aggregate.

### 7. Scene, conditional causality, and actor salience remain partial

Scene/flashback/summary observations exist, but there is no accepted
cross-chapter scene occurrence joining location, story interval, participants,
viewpoint, and canonical event membership. Typed event relations carry
mechanism and required conditions, but the frontier still consumes the legacy
causal-parent projection. Actor lived-experience context still selects the most
recent twelve qualifying events rather than a deterministic goal/obligation/
relationship-aware salience policy.

### 8. Long-running evolution still needs broader evaluation

Material-progress certification, stagnation-aware exits, and an explicit
five-minute autonomous wait path are connected. The scheduler remains
deterministic and explainable, but pressure scoring, expiry, actor relevance,
background cadence, and conflict policy have only small-fixture coverage. Large
branch histories and multi-actor scenes have not been profiled.

Canonical scaffold recovery is implemented and covered by constrained fixtures,
including dependency skipping, participant remapping, downstream causal
continuation, locked-effect forgery rejection, scene-presence rejection, and
future-entity rejection; opaque role-specific strings are also rejected rather
than textually rewritten. What remains unestablished is compiler recall and
precision on real novels: no representative benchmark yet measures whether the
model identifies functional roles without incorrectly treating identity-bound
roles as substitutable. Prepared revisions compiled before pipeline version 9
remain playable but contain no newly inferred scaffolds until reparsed.

## Recommended next milestone

Close publication trust before adding broader ontology:

1. serialize and restore exact assertion revisions/bindings with prepared
   bundles, dual-reading old bundles in explicit legacy-evidence mode;
2. implement each semantic gold scorer and check in a constrained annotated
   slice before expanding to multiple licensed/user-provided genres;
3. add a typed artifact dependency graph and `reparse --dry-run` impact plan,
   preserving immutable revisions and pinned old branches;
4. resolve cross-chapter scene occurrences and event membership;
5. move causal required conditions into deterministic frontier eligibility and
   replace fixed recency with actor-safe deterministic salience;
6. add institution, faction, artifact, or economy modules only when benchmark
   failures repeatedly demonstrate the need.

This order tests portability, measurement, and safe repair first while
preserving [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md).
