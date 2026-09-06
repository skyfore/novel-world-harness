# Implementation status

Date: 2026-09-02

Verified baseline: `pnpm run check`; `pnpm test` (148 test files, 836 tests
passing); `pnpm test:e2e` (production Fastify host + 2 Chromium journeys
passing).

This document describes behavior verified from the code on `agent/local-first-novel-cli`. It intentionally separates engine primitives from user-facing product completion.

## Follow-up implementation — 2026-09-05

The review of `main@b2c010548edc519ea957e0ddc9fffdb47c297a5d` found additional
integration gaps in ordinary player action invocation, branch-knowledge
consumption, and location-change validation. Existing phase completion does
not establish complete extraction of a full novel or playability of every
major character.

The [novel-to-play technical design](novel-to-play-technical-design.zh-CN.md)
defines the next contracts; the
[implementation and acceptance plan](novel-to-play-acceptance-plan.zh-CN.md)
maps them to W0–W8 and explicit regression/quality gates.
[ADR 0010](adr/0010-major-character-play-and-world-closure.md) is partially implemented.
The [implementation record](novel-to-play-implementation-progress.zh-CN.md) and
[core compiler/rebuild guide](novel-world-core-and-rebuild.zh-CN.md) track the actual
changes. Core parser/runtime integration is implemented; complete-work live Pi
certification and the broader entity lifecycle remain outstanding. The historical
baseline and completion assessment below retain their original scope.

## Overall assessment

The branch now implements a constrained end-to-end path from a local novel through reviewed compilation to selecting a character and committing natural-language actions. The authority boundaries are connected and carry repeatable representative denominators plus long-horizon safety scenarios; provider extraction quality across arbitrary novels and broad literary-runtime quality are not yet established.

The code citations, external primary sources, gap analysis, and phased acceptance
plan behind this status are documented in
[Evidence-Grounded Full-Novel Semantic Compilation](novel-semantic-compilation-plan.md)
and its [Chinese research report](novel-semantic-compilation-plan.zh-CN.md).

| Area | Status | What is actually usable |
| --- | --- | --- |
| Terminal hub | Implemented | Claude Code-style TUI, workspace catalogs, committed progress, durable world resume, local lexical discovery, and bounded reads; general model tools remain read-only |
| Local Web UI | MVP implemented | Loopback-first React/Fastify workbench for source ingest, preparation/review, instance lifecycle, Pi-backed play/resume, append-only run/LLM/tool/context traces, and branch/time-scoped model/event/place/rule/provenance graphs; long operations and short mutations retain idempotency/recovery state across restart, and interrupted moves are reconciled against verified audits/commit ancestry without replaying world truth; no product login or remote multi-user deployment |
| Source ingest | Implemented | Exact file/stdin/inline bytes archived globally by SHA-256, source manifest, widened deterministic evidence segments, plus finish-gated declarative chapter discovery when built-in headings are insufficient |
| Model compilation | Implemented as a mechanism | Host-scheduled phase-major observation → semantic → executable Pi batches produce source-exclusive typed pending proposals; prompt/tool activation and execution-time checks enforce stage authority, while recovery, narrow withdrawal, finish handshakes, and total-tool-call circuit breakers remain bounded |
| Source observations | M2 + M3b-1 implemented | Immutable-source paragraph/sentence partition, exact entity/event mention, quotation, and discourse annotations, source-local closure, accounting, audit, batch recovery, and paged retrieval; event mentions carry no truth or canonical-event authority |
| Entity resolution | M3a implemented | Deterministic source-scoped lexical candidates, explicit resolved/new/ambiguous/unresolved decisions, immutable superseding revisions, unresolved audit queues, and canonical name/alias trace gates |
| Event resolution | M3b implemented | Source-scoped evidence/title/participant candidates, explicit coreference vs subevent clusters, resolved/new/ambiguous/unresolved decisions, merge/split revisions, major-event coverage, participant trace, and canonical-event commit gates |
| Proposition, attribution, and knowledge acquisition | M4a implemented | Reusable proposition content is separated from narrator/character/document attitudes; quotation IDs trace holders to resolved speakers, and additive knowledge provenance records proposition, attribution, and acquisition mode without breaking legacy claim-keyed replay |
| Event participation semantics | M4b-1 implemented | Versioned event/entity/semantic-role records keep character presence independent from agency, require a complete lossless projection to legacy `participants`/`participantPresence`, participate in compiler closure and prepared-publication gates, and are pinned in runtime snapshot V5 |
| Event relation semantics | M4b-2 implemented | Independently evidenced temporal, causal, explanatory, identity/subevent, and narrative-continuation records have deterministic closure, contradiction, cycle, and legacy-projection validation; only non-contested `causes`/`enables` relations project to `causalParents`, and runtime snapshot V6 pins their revisions |
| Scene/action/executable policy semantics | T4 + T6 + T9 implemented | Canonical scene occurrences, event frames, source-induced action schemas, action constraints, norm templates, and process templates pass source closure, dependency-ordered validation/commit, artifact retrieval, audit, gold evaluation, prepared-revision portability, and selected-reparse invalidation; host domain modules remain a separate provenance lane |
| Character semantics | M5a implemented | Versioned behavioral dimensions separate contextual dispositions, event appraisals, and event-gated development episodes; stable inference and counter-evidence rules fail closed, legacy free-form keys are explicitly namespaced, and actor-facing projections remain future-canon and visibility safe |
| Spatial semantics | M5b-2a implemented | Exact-evidence-backed containment, adjacency, and route artifacts are source-scoped, graph-validated, revision-pinned in snapshot V7, and actor-safe; compiled travel requires an active direction/mode-compatible route and respects known minimum duration, while adjacency never proves passage |
| World-rule semantics | M5b-2b implemented | Controlled kind/scope, authority, jurisdiction, applicability, per-clause requirements/prohibitions, exceptions, visibility, defeasibility, and explicit superiority are exact-evidence-backed and catalog-validated; contested semantics never execute, priority alone never resolves conflict, and hidden rules enforce without actor leakage |
| Reparse invalidation | Direct dependencies implemented | Whole/selected-chapter reparse uses byte/line containment for exact quote subspans and covers propositions, attributions, participation, event relations, scene/frame/action/constraint/norm/process artifacts, nested spatial/rule evidence, character ontology, and exact bindings; cross-chapter artifacts and pinned branches remain intact, while a general transitive impact planner is not yet implemented |
| Canonical acceptance | Implemented | Structural and cryptographic evidence validation, evidence-grounded entity names/aliases, and dependency-ordered acceptance |
| Canonical revisions | Implemented | Logical IDs point to immutable content-addressed revisions |
| World engine | Implemented vertical slice | Immutable commits/events/typed effect deltas, projection, branch CAS, rules, knowledge, frontier, and host-side per-candidate move decision traces |
| Canon replay and branching | Implemented vertical slice | Shared-history typed reducers, versioned checkpoint-plus-tail replay, full-replay equivalence diagnostics, fork, diff, and divergent possibility eligibility |
| Actor behavior | Implemented vertical slice | Direct interactions use the actor-scoped reactive NPC lane; unrelated initiative uses a bounded hybrid policy that prefers compiled actions, then calls an isolated Pi actor reasoner for host-ranked salient actors and revalidates multi-actor footprints at each new branch head |
| Narrative | Implemented vertical slice | Actor-scoped Pi scene narrator receives a bounded actor-safe frame plus exact retrieval and authority-projected current/prior literary context when a move triggered consultation; choice and narrative channels remain isolated, and accepted prose cannot mutate world truth |
| Preparation workflow | Implemented vertical slice | `prepare` remains one-batch/review-first; authorized `prepare-all` compiles all, accepts valid artifacts, quarantines invalid drafts, seeds an opening, and creates a branch |
| Prepared revisions | Implemented | MD5 lookup with SHA-256 verification, immutable V3 bundle revisions, atomic active pointer, origin-independent whole/selected-chapter reparse, rollback and explicit activation; canonical artifacts plus exact assertion bindings and compiler observation/resolution/accounting snapshots round-trip across workspaces |
| Local persistence | Implemented | Source, compiler, branch, and session data live below `$NWH_HOME`; new runs do not create workspace `.novel-harness/`, and legacy state is copied without deletion |
| Player experience | Implemented vertical slice | Restricted Pi translation into a host-owned player event, typed data-gap escalation with at most one frozen-source consultation and one consumer retry, exact bounded continuity, reactive NPC responses, validated immediate developments, bounded post-divergence canonical scaffold recovery, merged model suggestions plus host-preflighted exits, stagnation detection, and an explicit material-progress wait route |
| Runtime source consultation | Implemented vertical slice | Translation/adjudication may preserve a genuine missing-data result; a fresh isolated specialist can search and fully read only the branch-pinned immutable source units, while host admission excludes future/ambiguous evidence, projects separate translation/adjudication/choice/narrative authority, and records source-only gaps in a non-authoritative compiler inbox |
| Character embodiment | Implemented vertical slice | Role-before-branch selection, spoiler-free opening setup, reader-only complete prior-event recaps, source-backed first-embodied-scene checkpoints for later roles, actor-scoped perception, sibling entry branches, and durable active resume |
| Model token policy | User/provider controlled | NWH does not impose an application token or request-count budget; provider/model output metadata remains authoritative |
| Corpus quality | Evaluation denominator implemented; provider quality not established | Three original CC0 Chinese micro-novels pin exact bytes and selected explicit V2 gold across all 13 implemented evaluator layers; no live-provider result or independently reviewed release threshold is claimed |

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
- `compile-source` processes bounded batches in whole-source phase-major order: observation inventory first, entity/event resolution and canonical semantics second, and executable induction/accounting third. A semantic batch may add only the exact entity/event mention prerequisites that its deterministic canonical trace closure discovers were missed by observation; quotations and discourse segmentation remain observation-owned. Prompt contracts, activated tools, and the tool execution boundary independently enforce the same stage authority. A batch checkpoints only after its active proposal graph closes, the model stops cleanly, and `finish_compiler_batch` succeeds. Stable batch provenance supplies exact active proposal IDs to recovery turns; ordinary source passes defer genesis to the dedicated opening pass. The host owns the active proposal set, executes proposal writes sequentially, hides capacity counters from the model, forbids budget-driven semantic deletion, keeps only high runaway safety fuses (800 proposals / 1,000 calls), reserves the final finish handshake, rejects concurrent CLI compiler writers, and terminates finish failures or pathological compiler tool loops without checkpointing.
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
- Canonical scene/action policy uses separate occurrence, reusable mechanism,
  and branch-instance layers. Source-induced `action-schema-v1`,
  `action-constraint-v1`, `norm-template-v1`, and `process-template-v1`
  proposals must cite supporting canonical events and pass deterministic
  entity/action/event/claim/override closure before commit. Novel compilation
  cannot submit `domain-module` provenance. Audit and gold evaluation expose
  these artifacts instead of treating extraction coverage as runtime fitness.
- Exact evidence assertions are immutable and artifact-hash-bound in the
  compiling workspace and are exposed by artifact retrieval. Prepared V3
  bundles serialize hash-bound assertion bindings together with source
  annotations, entity/event resolutions, source structure, and accounting;
  restore verifies source identity and materializes the same compiler snapshot
  without relying on an upload filename or the originating workspace.
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
- A player move may invoke at most one fresh, non-persisted source-context
  specialist after an explicit model request or a pure deterministic data-gap
  failure. Retrieval is lexical, paged, tool-call bounded, and locked to the
  branch's source SHA-256 and prepared revision; every cited source unit must be
  completely read in that same attempt.
- Source findings remain proposals. The host independently verifies passage-to-
  artifact linkage, committed history, active rules, actor visibility, and the
  unchanged branch head. Any cited passage linked to an unrealized canonical
  event or uncommitted possibility is withheld even if the model omits that
  future-bearing reference or calls it current. Ambiguous/source-only findings
  cannot authorize a retry or commit.
- Admitted material is split by consumer: actor-visible or one-turn referent
  facts may help translation, committed-current facts may help adjudication,
  actor-visible facts may help choices, and current/prior literary explanation
  may help narration only as presentation. One-turn referents neither grant a
  name to the character nor enter adjudication. Stable evidence/artifact IDs are
  removed before presentation models.
- Structural source-only findings are stored as immutable, idempotent compiler
  repair hints outside branch truth. The inbox does not publish artifacts,
  upgrade a frozen base, or migrate an existing branch.
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
source-backed embodied checkpoint plus a reader-only recap of every preceding
discourse event. The final step-zero opening renderer may weave that recap into
continuous third-person novel prose, but it never enters actor knowledge, the
player-action/choice model, NPC reasoning, adjudication, or world state. Every
modern instance exposes one checked frozen-base identity made from its source,
prepared revision, and canonical snapshot hashes; each intentional new Play
creates a separate branch and conversation.

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

A genuine missing-data outcome now has a separate bounded path: the host may
consult the exact frozen source once and retry only the translator or
adjudicator that requested it. Known contradictions, capability failures,
hidden character knowledge, mixed validation failures, future canon, and
ambiguous evidence cannot use this path. A source-only explanation may enrich
the current scene as presentation or become a compiler repair hint, but never a
state/knowledge delta.

### 3. Proactive actor behavior is connected but still corpus-limited

The product now connects a separate reactive Pi lane for NPCs directly
addressed by typed player speech, gesture, or physical interaction. That lane
receives only the NPC's perceived history, knowledge, current
development/goals/affect and bounded capabilities, and commits explicit speech,
gesture, refusal, or silence through normal deterministic gates with the player
event as causal parent.

`modelActorProposalSource` is now the shared proactive policy used by the CLI,
TUI, and Web play composition roots. The host ranks active actors before any
model call, prefers a valid compiled action, and spends a separately bounded Pi
fallback call only when no compiled action is executable. The isolated reasoner
receives turn-local opaque handles, actor-visible state/knowledge, one active
goal, effective dispositions and branch character semantics, plus only visible
active norms/processes. Inactive/future policy phases, goal IDs/triggers,
canonical IDs, evidence, engine chronology, hidden rules, and other actors'
private knowledge remain excluded.

Every returned action is a capture-only proposal. The host decodes opaque
handles, checks capability/spatial grounding and materiality, detects
write/write, read/write, resource, exclusivity, consent, authority, and temporal
overlap, then revalidates each winner against the new branch head before commit.
The remaining gap is behavioral quality and recall across representative novel
genres—not connection or mutation authority.

### 4. The low-level renderer remains diagnostic

`NarrativeRenderer` still provides deterministic event-title rendering for low-level CLI/API inspection. The TUI player path now adds an isolated Pi narrator over a bounded committed actor frame, exact actor-frame and related-message retrieval, a capture-only choice tool, and a separately admitted current/prior literary-context channel when a player move exposes a sparse referent or relationship. Broader prose-quality, runtime-consultation precision/latency, parametric-canon recall, and epistemic-leakage evaluation across representative novels is still required.

### 5. A representative denominator exists; provider quality is not frozen

The repeatable semantic evaluator now scores mention detection, entity/event
coreference, quotation attribution, typed participation and event relations
including operationality, propositions, knowledge acquisition, state effects,
scenes, action schemas/effect envelopes, executable policies, and character
goal/appraisal/development/relationship/obligation evidence. Three checked-in,
original CC0 Chinese micro-novels now provide hash-pinned selected explicit V2
gold with a non-empty denominator for every implemented evaluator layer. The
corpus loader rejects source-byte drift, malformed UTF-8 boundaries, cross-source
spans, and broken reference closure. This proves that scoring and regression
denominators are real; it does not prove extraction quality on arbitrary novels.
The first representative live-provider results still require independent human
false-positive/false-negative review before a release threshold can be frozen.

### 6. General transitive repair planning is incomplete

Prepared revisions now retain exact field-level assertion bindings and compiler
metadata. Selected-chapter reparse invalidates every directly supported semantic
collection—including scene/action/policy artifacts—using exact subspan
containment, but it does not yet calculate a general mention-to-runtime
transitive impact plan or offer `--dry-run`. Cross-chapter aggregate models
cannot mark one nested semantic item stale without replacing the aggregate.

### 7. Executable semantic induction lacks a reviewed provider baseline

Scene occurrences now join discourse, location, story interval, viewpoint,
physical presence, and canonical event membership. Typed causal operationality
drives the frontier, while hybrid actors use deterministic goal/obligation/
relationship-aware salience before any bounded model call. What remains
unestablished is whether a model reliably induces the right reusable action,
constraint, norm, and process abstractions across genres without overgeneralizing
one-off events.

### 8. Long-running evolution still needs broader evaluation

Material-progress certification, stagnation-aware exits, and an explicit
five-minute autonomous wait path are connected. The scheduler remains
deterministic and explainable. A 52-event post-genesis history now proves that a
checkpoint after event 40 reduces only the 12-commit tail while matching a full
replay across state, knowledge, branch semantics, processes, norms, scenes,
causality, and history. Fork scenarios cover false belief, isolated knowledge,
betrayal/alliance divergence, goals, relationships, obligations, process/norm
state, future eligibility, and actor policy; a separate multi-actor scenario
proves deterministic exclusive-resource conflict and new-head commitment.
Full-book-scale latency, memory, pressure calibration, background cadence, and
genre-diverse behavioral quality still need live profiling.

Canonical scaffold recovery is implemented and covered by constrained fixtures,
including dependency skipping, participant remapping, downstream causal
continuation, locked-effect forgery rejection, scene-presence rejection, and
future-entity rejection; opaque role-specific strings are also rejected rather
than textually rewritten. What remains unestablished is live-provider compiler
recall and precision: the checked-in denominator can measure functional-role
errors, but no independently reviewed provider baseline yet shows whether models
avoid treating identity-bound roles as substitutable across genres.

## Recommended next milestone

With T0–T10 complete, the next evidence-driven milestone should be:

1. run pinned live providers against the representative corpus, conduct
   independent human false-positive/false-negative review, and freeze
   model/version-specific baselines without turning them into universal scores;
2. add a typed `reparse --dry-run` transitive dependency-impact plan and verify
   it on the failures revealed by those baselines;
3. profile full-book histories and sustained autonomous play for latency,
   checkpoint cadence, memory, and bounded model-call behavior;
4. expand licensed/original genre coverage and add domain modules only when
   repeated benchmark failures demonstrate a missing mechanic rather than a
   prompting or evidence-resolution error.

This order tests reliability and observability while preserving
[ADR 0001](adr/0001-world-truth-history-and-possibility-space.md).
