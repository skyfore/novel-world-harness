# Technical Design: Executable Novel World Engine

- **Status:** Proposed implementation blueprint
- **Date:** 2026-08-11
- **Applies to:** Phase 1–3 world compiler/runtime work
- **Architecture decisions:** [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md), [ADR 0003](adr/0003-world-time-character-development-and-divergence.md), [ADR 0004](adr/0004-model-first-player-intent-and-world-adjudication.md)
- **Semantic compiler follow-up:** [中文技术计划](novel-semantic-compilation-plan.zh-CN.md) / [English technical plan](novel-semantic-compilation-plan.md)

## 1. Purpose

This document turns ADR 0001 into an implementable technical plan.

The system is not primarily a full-book parser, a RAG application, or a mutable world-state JSON file. It is an executable world engine built around evidence-backed compilation, immutable committed history, deterministic state projection, temporal rules, actor-scoped knowledge, and an explicit possibility frontier for the future.

The immediate objective is a **small executable vertical slice** of one novel that can:

1. compile a constrained source slice into evidence-backed canonical artifacts;
2. deterministically reconstruct world state from committed history;
3. replay the canonical slice without hard-coding future events;
4. fork at one high-impact event;
5. invalidate or transform downstream canonical possibilities when their conditions no longer hold;
6. continue the divergent branch while preserving engine invariants and actor knowledge boundaries;
7. render either the canonical or divergent history without allowing narrative output to mutate world truth.

Broad parser coverage comes after this loop is stable.

## 2. Design constraints

The implementation MUST preserve these boundaries:

- **World before narrative.** Narrative is evidence or rendering, not mutation authority.
- **Events before state.** Branch truth is committed history; state is a projection.
- **Possibility is not fact.** Uncommitted future candidates never enter world truth.
- **Canon is evidence and an attractor, not a scheduler.**
- **Rules may be temporal.** In-world rules are data; engine invariants remain code.
- **Knowledge is actor-scoped.** Compiler omniscience never becomes actor knowledge implicitly.
- **Proposal -> validate -> commit -> render.** No LLM output bypasses the commit boundary.
- **Local-first remains the default.** Phase 1–3 must not require PostgreSQL, a vector database, or a RAG service.
- **Model tools remain narrow.** Do not introduce a general `write_file` or shell capability as the mechanism for world mutation.

## 3. System planes

The system has four planes with different authority.

```text
┌────────────────────────────────────────────────────────────┐
│ Source / Evidence Plane                                    │
│ novel files, SourceSpan, narrator/character claims         │
└───────────────────────┬────────────────────────────────────┘
                        │ typed compiler proposals
                        ▼
┌────────────────────────────────────────────────────────────┐
│ Canonical Model Plane                                      │
│ entities, canonical events, claims, rules, causality, meta │
│ complete source-observed trajectory                        │
└───────────────────────┬────────────────────────────────────┘
                        │ runtime seed / evaluation reference
                        ▼
┌────────────────────────────────────────────────────────────┐
│ Branch Truth Plane                                         │
│ immutable commits -> committed events -> StateDelta        │
│ WorldState(branch, t) is projected from this plane         │
└───────────────────────┬────────────────────────────────────┘
                        │ derive / evaluate
                        ▼
┌────────────────────────────────────────────────────────────┐
│ Possibility + Narrative Plane                              │
│ frontier, scheduler candidates, actor proposals, renderer  │
│ non-authoritative until an event is validated + committed  │
└────────────────────────────────────────────────────────────┘
```

The canonical model is allowed to know the end of the book. The branch truth plane is not.

## 4. Authority model

### 4.1 Authoritative data

The following data is authoritative:

- source files as compilation evidence;
- committed canonical artifacts after compiler validation;
- immutable branch commit objects;
- immutable committed event objects;
- immutable deterministic state delta objects;
- engine invariant implementation for the engine version referenced by a commit.

### 4.2 Derived/cache data

The following data is rebuildable and MUST NOT become semantic truth:

- `WorldSnapshot`;
- search indexes;
- entity lookup indexes;
- possibility frontier materializations;
- scheduler scores;
- branch divergence metrics;
- corpus evaluation reports with explicit denominators;
- rendered prose;
- LLM session transcripts.

A cache may be deleted without changing world semantics.

## 5. Core type model

Exact TypeScript names can evolve, but the semantic contracts should remain stable.

### 5.1 Identifiers

Use opaque IDs for logical identity and hashes for immutable content.

```ts
type ProjectId = string;
type EntityId = string;
type ClaimId = string;
type CanonicalEventId = string;
type RuleId = string;
type BranchId = string;
type ProposalId = string;
type CommitId = string;      // content hash
type ObjectHash = string;    // sha256 of canonical serialized content
```

Rules:

- entity identity must survive source re-segmentation;
- immutable commit/event/delta objects use content hashes where practical;
- path names are not IDs;
- human-readable names are labels, never identity keys.

### 5.2 Evidence

```ts
type SourceSpan = {
  sourceId: string;
  startByte?: number;
  endByte?: number;
  startLine: number;
  endLine: number;
  quoteHash: string;
};

type EvidenceRef = {
  span: SourceSpan;
  strength: "explicit" | "strong-inference" | "weak-inference";
};

type TextAnchor = {
  version: 1;
  sourceId: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  exactHash: string;
  prefixHash: string;
  suffixHash: string;
  contextBytes: 64;
  normalization: "source-bytes-v1";
};

type EvidenceAssertion = {
  version: 1;
  id: string;
  target: { artifactKind: string; artifactId: string; jsonPointer: string };
  anchors: TextAnchor[];
  relation: "supports" | "contradicts" | "contextualizes";
  strength: "explicit" | "strong-inference" | "weak-inference";
  interpretation?: string;
  derivation: { runId: string; worker: string; ontologyVersion: "evidence-v1" };
};
```

`EvidenceRef` remains compatibility context for a bounded source segment. New
field- and relation-level grounding uses `EvidenceAssertion`: its JSON Pointer
identifies the supported semantic target, while its exact and adjacent-context
hashes make the citation independently reviewable. Models submit only exact
text selectors, context for disambiguation, target paths, relations, and
strength; the host resolves byte/line ranges and every trusted hash from the
immutable archived source. Inferred strengths require an interpretation.

Exact assertions are immutable revisions stored separately from semantic world
artifacts. On commit, an atomic binding connects the active artifact content
hash to its current assertion revisions. This lets provenance change without
manufacturing a new world-model revision, while audit and retrieval can reject
stale bindings.

#### 5.2.1 Source-observation structure and accounting

Canonical artifacts are not a valid denominator for source coverage. Before
canonicalization, the host materializes a source-observation tree with one
`work` root, deterministic `paragraph` containers, and `sentence` / `non-scene`
leaf units. The leaf anchors are a gap-free, non-overlapping byte partition of
the immutable source. Their IDs are derived from source identity, structure
version, kind, and byte range, so prompt batching never becomes semantic
identity.

Scene and discourse annotations are a separate overlapping layer. A memory,
frame, embedded document, or narrator comment may overlap structural units or
another discourse span; it never changes textual order or the base partition.

At the successful batch finish handshake, reviewed segment ranges are projected
onto base units:

- a unit overlapping an exact semantic assertion or committed observation is
  `represented`;
- an explicitly reviewed no-artifact unit is `background-only`;
- whitespace/non-scene bytes are classified deterministically;
- a unit in a proposal-bearing segment without exact coverage is `unresolved`,
  not silently counted as extracted.

Accepted accounting proposals are immutable review history and can repair a
missing finish marker on retry. If the retry adds exact semantics, host-derived
`represented` coverage deterministically supersedes only the overlapping
accepted dispositions; all other decisions replay unchanged. A newly staged
pending disposition still conflicts with overlapping exact semantics, and the
diagnostic names its exact proposal ID for withdrawal.

Boundary-calibration requests are transient workflow state and are not part of
an immutable prepared revision. Materializing a revision clears that queue and
restores only its stable batch checkpoints; a reparse that performs recovery
then derives its selected batches again from the restored state.

Audit reports both unit and byte denominators. Missing reviews remain
`unknown`; fully reviewed unresolved/deferred units are `not-ready`; only full
accounting without blockers is `ready`.

#### 5.2.2 Source-annotation lifecycle

`src/compiler/annotations.ts` is the authority for four non-canonical source
observations:

- `EntityMention` stores exact source surface (or an explicitly interpreted
  zero anaphor), mention form, and entity-kind candidates. It deliberately has
  no `entityId`, canonical name, or alias field.
- `EventMention` stores an exact trigger, one or more possibly discontinuous
  extent anchors, event-type candidates, participant *mention IDs*, enclosing
  discourse references, and major/supporting/minor salience. It deliberately
  has no canonical event ID, truth status, state delta, or causal edge: a
  remembered, dreamed, hypothetical, denied, or summarized event is still only
  a textual observation at this layer.
- `Quotation` stores direct/indirect/free-indirect mode and refers to speaker
  and addressee *mention IDs*. Attribution therefore remains auditable before
  identity resolution.
- `DiscourseObservation` stores one or more possibly overlapping anchors for a
  scene, summary, flashback, frame, recollection, hypothetical, dream,
  embedded document, or narrator commentary. Viewpoint also refers to a
  mention ID, so discourse analysis cannot grant canonical identity.

Models submit exact text selectors only. `src/compiler/text-anchors.ts`
resolves each selector against a host-validated source segment and constructs
the trusted `TextAnchor`. Repeated text without context or an explicit
one-based occurrence is rejected as ambiguous.

Annotations use a distinct pending/accepted/rejected proposal history. A
successful `finish_compiler_batch` first validates the complete source-local
reference graph, then writes an immutable content-addressed annotation revision
and atomically moves its current ref. Retrying the same compiler batch restores
both pending proposals and annotations already committed by a partially
completed finish. Rejecting that batch restores the preceding current revision
without deleting immutable history.

`find_source_annotations` returns bounded, source-scoped summaries;
`read_source_annotation` pages the exact payload. Neither tool exposes another
novel's observations. Audit verifies all committed anchors, reports annotation
counts and pending closure failures. Entity resolution has an explicit M3a
denominator; event mentions remain visibly unresolved until M3b adds event
identity records.

#### 5.2.3 Entity identity resolution

`src/compiler/entity-resolution.ts` separates textual occurrence from stable
identity. Each `IdentityResolution` addresses exactly one `EntityMention` and
has one explicit status:

- `resolved` selects an already-canonical entity;
- `new-entity` selects an entity proposal included in the same finish
  handshake;
- `ambiguous` retains at least two compatible canonical candidates;
- `unresolved` records that no safe selection is available.

Candidate generation is deterministic and source-scoped. It compares the exact
and NFKC-normalized mention surface with compatible canonical/pending entity
names and aliases, filters by the mention's candidate kinds, and returns a
stable rank. A lexical match is only a candidate; the model must still propose
the decision, cite its basis mention IDs, and may preserve uncertainty.

Current resolution refs are keyed by `mentionId`. Payloads are immutable,
content-addressed revisions. Changing a decision requires a new resolution ID
whose `supersedesResolutionId` names the current revision. This makes merging
several mentions into one entity, or splitting one mention back out, explicit
and reversible. Failed-batch cleanup restores the preceding current ref while
retaining revision history.

Recovery keeps current identity separate from creation provenance. A
superseded accepted `new-entity` revision is never replayed or rebound as the
current ref, but it may continue to prove how a still-pending entity was
created when the current resolution for that same mention still selects the
same identity. Rejected or identity-changing history cannot satisfy this
check.

The finish handshake validates mention existence, source locality, kind
compatibility, candidate/evidence IDs, status-specific target authority, and
the supersession chain. When a source has activated mention inventory, a new
canonical entity proposal must trace its canonical name to a selected mention;
every proposed alias needs a separately alias-classified selected mention. The
same trace is rechecked by `CompilerCommitService`, so a caller cannot bypass
the finish gate by invoking canonical acceptance directly. Legacy sources with
no mention inventory remain readable until explicit reparse.

Audit now has a real entity-resolution denominator. Missing, pending,
ambiguous, unresolved, or invalid decisions are `not-ready`; all observed
entity mentions selected through valid resolutions are `ready`; sources with no
mention inventory remain `unknown` rather than receiving synthetic coverage.

#### 5.2.4 Event identity and cluster resolution

`src/compiler/event-resolution.ts` keeps textual event presentation separate
from canonical occurrence. An `EventResolution` owns one or more event mention
IDs and records one of four explicit outcomes:

- `resolved` links the cluster to an existing canonical event;
- `new-event` links it to a canonical-event proposal in the same finish
  handshake;
- `ambiguous` retains at least two event/relation candidates;
- `unresolved` records that no safe event identity is available.

A selected candidate also declares `coreference` or `subevent`.
Coreference says the cluster describes the canonical event itself; subevent
says it describes only a proper component and therefore cannot, by itself,
ground the canonical event. Candidate generation is deterministic and
source-scoped. It ranks exact-evidence overlap, normalized title/trigger
similarity, and already-resolved participant overlap, but these signals never
auto-merge events or assert that an event occurred.

Current refs are keyed by event mention while immutable payloads may cover a
cluster. A merge names all current `supersedesResolutionIds`; a split emits
multiple non-overlapping new clusters that collectively cover every mention in
the superseded cluster. Finish validation rejects dropped members, overlapping
new clusters, in-place revision IDs, unknown candidates, unresolved
participants, and cross-source evidence. Failed-batch cleanup restores the
prior partition without deleting revision history.

As with entity identity, recovery does not reactivate a superseded accepted
`new-event` cluster. Its immutable revision may prove the creation origin only
while a current coreferential resolution still affirms at least one of the
same event mentions and the same canonical event.

When a source has event mentions, every new canonical-event proposal must have
a same-finish coreferential `new-event` trace. Every canonical participant must
also trace through a participant entity mention whose identity resolution
selects that entity. `CompilerCommitService` repeats the event trace check, so
direct acceptance cannot bypass the finish gate. Sources compiled before event
mention inventory remain readable until explicit reparse.

`find_event_resolution_candidates`, `find_event_resolutions`, and
`read_event_resolution` provide bounded source-local candidate, unresolved,
merge/split, and exact-payload retrieval. Audit reports all event-resolution
states and computes `majorEventResolution` from event mentions explicitly
marked `major`; ambiguous, unresolved, pending, invalid, or absent decisions
block resolution readiness.

### 5.3 Entity

An entity contains stable identity and classification only.

```ts
type Entity = {
  id: EntityId;
  kind: "character" | "location" | "faction" | "artifact" | "institution" | "concept" | "other";
  canonicalName: string;
  aliases: string[];
  evidence: EvidenceRef[];
};
```

Mutable properties such as location, health, title, allegiance, ownership, inventory, permissions, and relationship status do not belong here.

### 5.4 Claims

```ts
type Claim = {
  id: ClaimId;
  subject: EntityId | string;
  predicate: string;
  object: unknown;
  epistemicType: "explicit-fact" | "narrator-claim" | "character-claim" | "rumor" | "inference" | "interpretation";
  speaker?: EntityId;
  evidence: EvidenceRef[];
};
```

Claims are evidence artifacts. A claim is not automatically branch state.

### 5.5 Time: semantic time vs commit order

Novel time is often vague. Runtime replay cannot be vague about commit order. Therefore time has two layers.

```ts
type StoryTime =
  | { kind: "exact"; value: string; precision: "second" | "minute" | "hour" | "day" | "month" | "year" }
  | { kind: "range"; earliest: string; latest: string }
  | { kind: "relative"; anchorEventId: string; relation: "before" | "after" | "during"; offset?: string }
  | { kind: "ordinal"; label: string; orderHint?: number }
  | { kind: "unknown" };

type LogicalTime = {
  step: number;
  storyTime?: StoryTime;
  elapsedDays?: number;
};
```

`LogicalTime.step` gives every committed branch event a deterministic total order. `StoryTime` preserves the source's semantic uncertainty. `elapsedDays` is cumulative branch time for deterministic ageing and temporal predicates. Textual frame/flashback order belongs to `NarrativeContext`, never to these clocks.

A compiler may know only that A occurs before B. The runtime still assigns deterministic commit steps while retaining the weaker story-time semantics.

### 5.6 State schema

Different novels need different mutable attributes. Avoid both extremes: a giant hard-coded schema and arbitrary untyped JSON.

Use a small **State Schema Registry**.

```ts
type ValueType = "boolean" | "number" | "string" | "entity-ref" | "entity-ref-set" | "json-scalar";

type StateFieldSpec = {
  key: string;                 // e.g. character.alive, character.location, artifact.owner
  appliesTo: Entity["kind"][];
  valueType: ValueType;
  cardinality: "one" | "many";
  required?: boolean;
};
```

Phase 1 should begin with a deliberately small registry, for example:

- `character.alive`
- `character.location`
- `character.faction`
- `character.title`
- `artifact.owner`
- `faction.leader`
- `institution.permission.*`

New fields require a typed schema proposal/validation path; workers must not silently create arbitrary state keys.

### 5.7 World state

```ts
type StateValue = boolean | number | string | EntityId | EntityId[] | null;

type WorldState = {
  atCommit: CommitId;
  logicalTime: LogicalTime;
  values: Record<EntityId, Record<string, StateValue>>;
  activeRuleIds: RuleId[];
};
```

`WorldState` is returned by a projector. It is never mutated in place as the authority.

### 5.8 Predicate DSL

Preconditions, blockers, and temporal world rules must be deterministic and inspectable. Do not encode them as prompts or arbitrary JavaScript.

Start with a constrained predicate AST:

```ts
type Predicate =
  | { op: "fact-equals"; entityId: EntityId; field: string; value: StateValue }
  | { op: "fact-exists"; entityId: EntityId; field: string }
  | { op: "entity-in"; entityId: EntityId; field: string; member: EntityId }
  | { op: "rule-active"; ruleId: RuleId }
  | { op: "after-step"; step: number }
  | { op: "before-step"; step: number }
  | { op: "all"; items: Predicate[] }
  | { op: "any"; items: Predicate[] }
  | { op: "not"; item: Predicate };
```

The evaluator is pure and deterministic.

### 5.9 StateDelta

State changes are explicit typed operations.

```ts
type StateOperation =
  | { op: "set"; entityId: EntityId; field: string; value: StateValue }
  | { op: "unset"; entityId: EntityId; field: string }
  | { op: "add-member"; entityId: EntityId; field: string; member: EntityId }
  | { op: "remove-member"; entityId: EntityId; field: string; member: EntityId }
  | { op: "activate-rule"; ruleId: RuleId }
  | { op: "deactivate-rule"; ruleId: RuleId };

type StateDelta = {
  version: 1;
  operations: StateOperation[];
};
```

The reducer validates each operation against `StateFieldSpec` before applying it.

### 5.10 CanonicalEvent

```ts
type CanonicalEvent = {
  id: CanonicalEventId;
  title: string;
  participants: EntityId[];
  storyTime: StoryTime;
  preconditions: Predicate[];
  observedOutcome: StateDelta;
  evidence: EvidenceRef[];
  causalParents: CanonicalEventId[];
  confidence: number;
};
```

A canonical event records what the source trajectory says happened. It does not imply that the same event is scheduled on every branch.

### 5.11 WorldRule

```ts
type WorldRule = {
  id: RuleId;
  name: string;
  scope: "global" | "entity" | "location" | "faction" | "institution";
  appliesWhen: Predicate[];
  forbids?: Predicate[];
  requires?: Predicate[];
  evidence: EvidenceRef[];
};
```

`WorldRule` models in-world constraints. Engine invariants remain code and are not represented by this type.

### 5.12 Event proposal

```ts
type EventProposal = {
  proposalId: ProposalId;
  branchId: BranchId;
  expectedParentCommit: CommitId;
  source: "player" | "actor" | "background" | "canon-candidate" | "compiler";
  actorId?: EntityId;
  title: string;
  participants: EntityId[];
  proposedTime: StoryTime;
  preconditions: Predicate[];
  proposedDelta: StateDelta;
  causalParents: string[];
  evidence: EvidenceRef[];
  possibilityId?: string;
};
```

`expectedParentCommit` provides optimistic concurrency protection. A proposal against an old branch head must be re-evaluated.

### 5.13 CommittedEvent

```ts
type CommittedEvent = {
  version: 1;
  eventId: ObjectHash;
  branchId: BranchId;
  logicalTime: LogicalTime;
  proposalId?: ProposalId;
  participants: EntityId[];
  deltaHash: ObjectHash;
  evidence: EvidenceRef[];
  causalParents: string[];
};
```

### 5.14 Branch and world commit

A branch points to an immutable commit chain.

```ts
type Branch = {
  id: BranchId;
  name: string;
  parentBranchId?: BranchId;
  forkCommitId?: CommitId;
  headCommitId: CommitId;
};

type WorldCommit = {
  version: 1;
  parentCommitId?: CommitId;
  branchId: BranchId;
  logicalTime: LogicalTime;
  eventHashes: ObjectHash[];
  canonicalSnapshotHash?: ObjectHash; // required on new commits; optional only for legacy v1 reads
  engineVersion: string;
  schemaVersion: number;
};
```

`CommitId = sha256(canonicalSerialize(WorldCommit))`.

This Git-like structure makes local commits crash-safe: immutable objects are written first; the only authoritative mutable operation is atomically replacing the branch head pointer.

### 5.15 Possibility

```ts
type Possibility = {
  id: string;
  branchId: BranchId;
  evaluatedAtCommit: CommitId;
  kind: "canon-analogue" | "actor-plan" | "obligation" | "causal-consequence" | "background-pressure" | "environmental" | "generated";
  title: string;
  candidateWindow?: StoryTime;
  preconditions: Predicate[];
  blockers: Predicate[];
  expiry?: Predicate[];
  participants: EntityId[];
  causalParents: string[];
  canonicalEventId?: CanonicalEventId;
  pressure: number;
  relevance: number;
  proposedDelta?: StateDelta;
  evidence: EvidenceRef[];
};
```

A possibility is always evaluated against one specific branch head. After a commit, the frontier must be refreshed or revalidated.

Probability is optional policy metadata and never authority.

### 5.16 Actor knowledge

Phase 2 introduces actor-scoped knowledge:

```ts
type KnowledgeFact = {
  actorId: EntityId;
  claimId: ClaimId;
  status: "knows" | "believes" | "suspects" | "heard" | "disbelieves";
  confidence: number;
  acquiredAtCommit: CommitId;
  sourceActorId?: EntityId;
};
```

Actor proposal generation receives `WorldView(actor, branch, commit)`, not omniscient `WorldState` plus future canon.

## 6. Local storage architecture

Keep human-readable control-plane and world files below `$NWH_HOME`. Exact
source bytes are shared immutable objects keyed by SHA-256; each workspace gets
an isolated state namespace keyed by the resolved workspace-path identity.
World data remains a separate namespace rather than expanding `WorkspaceStore`
into a monolith.

```text
$NWH_HOME/
├── sources/v1/<sha256>/{manifest.json,source.utf8}
├── prepared-novels/v2/<md5>/
├── sessions/<workspace-id>/
└── workspaces/v1/<workspace-id>/
    ├── project.json
    ├── sources/
    └── world/
      └── v2/
        ├── compiler/batches/
        ├── canon/
        │   ├── entities/{refs,revisions}/
        │   ├── claims/{refs,revisions}/
        │   ├── events/{refs,revisions}/
        │   ├── rules/{refs,revisions}/
        │   ├── snapshots/<sha256>.json
        │   ├── actors/
        │   └── possibilities/{refs,revisions}/
        ├── objects/
        │   ├── events/<sha256>.json
        │   ├── deltas/<sha256>.json
        │   ├── knowledge/<sha256>.json
        │   └── commits/<sha256>.json
        ├── branches/
        │   └── <branch-id>/
        │       ├── branch.json
        │       ├── head.json
        │       └── lock
        ├── proposals/
        │   ├── pending/
        │   ├── accepted/
        │   └── rejected/
        ├── snapshots/
        │   └── <commit-sha>.json
        └── frontier/
            └── <branch-id>/<commit-sha>.json
```

Legacy workspace-local `.novel-harness/` trees are copied atomically on first
open and retained as a recovery source. New writes target only the user store.

### 6.1 Immutable-object commit protocol

A branch commit uses this sequence:

1. acquire branch mutation lock;
2. read branch head;
3. require `proposal.expectedParentCommit === head`;
4. project current state;
5. validate proposal;
6. deterministically derive/finalize `StateDelta`;
7. apply delta in memory and run post-state invariants;
8. write immutable delta object;
9. write immutable committed event object;
10. write immutable world commit object referencing parent + objects;
11. fsync/write files as supported;
12. atomically rename a new `head.json` containing the new commit hash;
13. release lock;
14. build snapshots/frontier/indexes asynchronously or lazily because they are caches.

If the process crashes before step 12, immutable orphan objects are harmless. If the head pointer moves, the commit is authoritative.

### 6.2 Concurrency policy

Phase 1 is **single-writer per branch**.

- read-only compiler analysis may run concurrently;
- proposal generation may run concurrently;
- commits to one branch are serialized;
- optimistic parent-commit matching rejects stale proposals;
- a local exclusive lock file prevents same-branch concurrent mutation.
- lock metadata records PID, hostname, and creation time; a dead same-host owner is recoverable and integrity checks surface stale locks.

Do not solve distributed transactions before there is a demonstrated need.

Compiler batch checkpoints record completed bounded batches; they are not a worker queue and provide no multi-process claim coordination. The current compiler command is single-process.

## 7. World projection

Create a pure `WorldProjector`.

```ts
project(branchId, commitId): Promise<WorldState>
```

Algorithm:

1. find the nearest valid snapshot ancestor, if any;
2. verify snapshot schema/engine versions;
3. walk commit ancestry from snapshot to target;
4. load each event delta in deterministic order;
5. evaluate rule activation/deactivation operations;
6. apply each operation through the state schema registry;
7. run lightweight projection invariants;
8. return immutable `WorldState`.

For Phase 1, projection correctness is more important than snapshot performance. A zero-snapshot implementation is acceptable first.

### Projection invariant

For any commit `C`:

```text
project(branch, C) == project(branch, C) from genesis
```

A stored snapshot that violates this equality is discarded as corrupt cache data.

## 8. Validation pipeline

Validation is layered so semantic model work and engine integrity remain distinct.

```text
EventProposal
   ↓
1. schema validation
   ↓
2. identity/reference validation
   ↓
3. parent-head freshness validation
   ↓
4. temporal/order validation
   ↓
5. predicate/precondition evaluation
   ↓
6. active in-world rule evaluation
   ↓
7. actor knowledge/permission validation
   ↓
8. resource/conflict validation
   ↓
9. deterministic delta dry-run
   ↓
10. post-state engine invariants
   ↓
ValidationReport
```

### 8.1 Deterministic checks

The engine should own checks such as:

- referenced entities/rules exist;
- field operations match schema types;
- branch parent is current;
- commit step is monotonic;
- dead actors cannot perform ordinary actions unless the world explicitly models a valid mechanism;
- exclusive ownership cannot produce two owners;
- location constraints are satisfied;
- a rule cannot be active outside its defined applicability;
- knowledge-dependent actions do not use inaccessible future facts;
- event effects are applied only once;
- one proposal cannot mutate immutable canonical artifacts;
- post-state satisfies engine invariants.

### 8.2 Semantic checks

LLMs may help with:

- whether evidence plausibly supports an extracted event;
- ambiguous entity resolution;
- candidate causal relationships;
- character intention interpretation;
- whether two narrative descriptions refer to the same event.

These outputs become evidence/proposals and never replace engine validation.

### 8.3 Validation report

Persist a structured report:

```ts
type ValidationReport = {
  proposalId: ProposalId;
  evaluatedAtCommit: CommitId;
  accepted: boolean;
  errors: { code: string; message: string; path?: string }[];
  warnings: { code: string; message: string }[];
  derivedDeltaHash?: ObjectHash;
};
```

This makes rejected mutations auditable and debuggable.

## 9. Possibility frontier

The frontier is a **derived branch-head view**, not an event queue that guarantees future execution.

### 9.1 Inputs

Frontier construction consumes:

- current projected world state;
- active in-world rules;
- unresolved actor goals/plans/obligations;
- committed causal parents;
- environmental/background processes;
- canonical future events as structural references;
- branch divergence from canonical conditions;
- actor knowledge where the possibility is actor-originated.

### 9.2 Lifecycle

For a given branch head, every candidate evaluates to one of:

- `latent` — not yet eligible;
- `eligible` — conditions hold and it can generate a proposal;
- `blocked` — a blocking condition currently holds;
- `expired` — its window/conditions can no longer be satisfied;
- `superseded` — another committed development replaces it;
- `adapted` — a committed functional analogue fulfills a canonical development without claiming verbatim realization;
- `realized` — linked to a committed event.

These statuses are frontier evaluation results, not authoritative world facts.

### 9.3 Canonical future decomposition

A future canonical event should be compiled into more than one thing:

```text
CanonicalEvent
  ├── source evidence
  ├── observed outcome
  ├── preconditions
  ├── causal parents
  ├── actor intentions / pressures
  ├── blockers
  └── canon-analogue possibility template
```

At runtime, only the conditions and pressures relevant to the current branch are evaluated. The original event ID is a provenance link, not an imperative.

### 9.4 Bounded canonical scaffold recovery after divergence

An exact canonical-derived possibility keeps the original participants and
effects. For selected source events, compilation may additionally accept a
separate `canon-analogue` template with `canonicalScaffold`. This does not make
canon a scheduler. It declares up to four source-backed **functional roles**
whose participants may be rebound if the exact event no longer fits the branch.
An attachment must change at least one declared role; canonical-self execution
stays on the exact-event path and cannot be relabeled as an adaptation.

The accepted scaffold must preserve the referenced canonical event's
participants, participant presence, story time, time advance, preconditions,
typed state effect, knowledge effect, and causal parents exactly. Role gates may
only make it more restrictive through entity kind, branch availability,
`active-scene` presence, state predicates, and actor knowledge. Identity-bound
roles such as a named victim, heir, spouse, prophesied person, or private
secret-holder are not valid functional substitutions. If an opaque string in a
locked predicate, effect, or knowledge claim contains the role entity's stable
ID, canonical name, or alias, compilation fails closed because only typed
entity references can be substituted safely.

```text
player event supersedes one currently eligible canonical event
  ↓ grants one bounded progression slot
scan accepted scaffolds in comparable story-time/evidence order
  ├─ hard causal dependency superseded/expired → trace and skip
  ├─ exact event + canonical-self role binding eligible
  │                                              → exact event takes precedence
  ├─ no branch-present role binding satisfies
  │  state + knowledge + scene gates            → trace and skip
  └─ one or more bindings survive
       ↓
     isolated LLM selects one opaque binding or none
     and may add only title + participant observation/affect
       ↓
     engine reloads the pinned scaffold, rebinds structural entity refs,
     compares every locked field, rechecks causal/state/knowledge/presence,
     then commits through the ordinary event boundary
```

The committed event records `canonicalAdaptation` lineage, including source
event, scaffold, scene anchor, role bindings, and a core-effect hash. It realizes
the scaffold, but it does **not** claim `realizesCanonicalEventIds` for the exact
source event. The frontier instead marks that exact possibility `adapted`: this
prevents duplicate execution and satisfies downstream causal dependencies while
preserving the historical fact that canon did not happen verbatim.

The model never receives stable entity IDs, branch/commit IDs, unrestricted
tools, or effect-writing authority in this lane. Binding enumeration and all
persistent state/knowledge changes remain deterministic host work. A failed or
declined attachment leaves the branch unchanged; the private turn audit retains
the scan traces, exact-candidate exclusions, and offered-decision result. An
exact event that passes only its weaker base predicates but fails the scaffold's
functional role gates is excluded from that progression move, so the ordinary
scheduler cannot bypass the stronger check.

### 9.5 Frontier refresh

After every commit:

1. invalidate the frontier cache for the old head;
2. resolve active rules and state for the new head;
3. retire impossible candidates;
4. re-evaluate latent/blocked candidates;
5. create new causal/background candidates;
6. recompute canon-analogue candidates from surviving preconditions;
7. persist the derived frontier keyed by new commit hash.

## 10. Scheduler and Move engine

The scheduler decides **what to evaluate next**, not what becomes true.

### 10.1 Move API

```ts
type MoveInput = {
  branchId: BranchId;
  playerProposal?: EventProposal;
  maxBackgroundCandidates?: number;
};

type MoveResult = {
  previousHead: CommitId;
  newHead: CommitId;
  committedEvents: ObjectHash[];
  rejectedProposals: ProposalId[];
  renderedText?: string;
};
```

### 10.2 Move pipeline

```text
branch head
  ↓
project world state
  ↓
resolve active rules + actor views
  ↓
refresh possibility frontier
  ↓
collect player / actor / background candidate proposals
  ↓
validate individually
  ↓
adjudicate conflicts
  ↓
commit zero or more compatible events
  ↓
project new state
  ↓
propagate knowledge + refresh frontier
  ↓
render
```

### 10.3 Scheduling score

Avoid pretending that one numeric probability is objective truth. Use an explainable policy score for shortlist ranking.

A first implementation may use:

```text
score =
  urgency
  × causal_support
  × actor_pressure
  × runtime_relevance
  × condition_strength
  × canon_affinity
```

Each factor must be inspectable. `canon_affinity` goes to zero when required canonical preconditions are destroyed; it is never an unconditional boost that forces the plot.

### 10.4 Time advancement

The runtime advances to meaningful changes rather than fixed ticks.

Rules:

- explicit player actions happen at the branch's current logical step unless they imply a validated duration;
- background scheduling may advance story time to the earliest relevant eligible window;
- commit order remains a monotonic logical sequence even when story-time precision is coarse;
- events with uncertain source order must not be falsely given precise semantic timestamps merely to satisfy storage.

## 11. Adjudication

Multiple valid proposals may conflict.

Phase 1 uses deterministic conflict classes before any LLM adjudication:

- same exclusive resource;
- incompatible location transitions;
- mutually exclusive state writes;
- actor cannot perform concurrent incompatible actions;
- rule activation conflicts;
- parent proposal invalidated by another accepted proposal.

Adjudication output is a chosen compatible set plus reasons.

LLM adjudication may later rank semantically plausible alternatives, but it receives only already-valid candidates and its selection is rechecked deterministically before commit.

## 12. Canon replay

Canon replay is a test harness, not a script executor.

### 12.1 Replay fixture

For a constrained canonical slice, compile:

- initial state;
- entities;
- canonical event evidence;
- rules;
- actor goals/knowledge needed by the slice;
- possibility templates;
- expected checkpoints.

### 12.2 Replay procedure

At each checkpoint:

1. project current state;
2. build frontier without directly scheduling the next canonical event;
3. provide canonical actor decisions only where the source actually supplies a decision;
4. let conditions, rules, and pressures generate eligible proposals;
5. validate and commit;
6. compare projected state with expected canonical checkpoint.

A mismatch should produce a diagnostic classification:

- missing precondition;
- incorrect event delta;
- missing rule;
- incorrect actor knowledge;
- missing causal pressure;
- bad scheduler policy;
- entity resolution error;
- temporal model error.

Do not fix replay by adding `if canonEvent then force event`.

## 13. Branching and counterfactual rewrite

Forking is cheap because history is immutable.

```ts
forkBranch(parentBranchId, forkCommitId, newBranchId)
```

The new branch initially points at the fork commit. It shares all immutable ancestors.

After the first divergent commit:

- canonical future remains available to the compiler/evaluator;
- the branch frontier is rebuilt from the new head;
- invalid canonical possibilities expire or transform;
- actor knowledge is copied only as of the fork commit;
- snapshots are branch/commit keyed caches;
- divergence metrics are derived and never used as authority.

### Narrative retelling vs counterfactual rewrite

Expose these as separate APIs:

```text
render(history, style/options)         // no world mutation
fork + propose + validate + commit     // actual world rewrite
```

This distinction should also exist in future CLI commands and model tools.

## 14. Compiler architecture

The current compiler is source-batch-driven: one chapter-bounded evidence batch is analyzed at a time and produces explicit artifact proposals rather than arbitrary JSON blobs. Built-in heading detection remains deterministic. When a longer source lacks recognized headings, one preliminary agentic pass sees only a bounded structural sample and can submit a non-executable declarative chapter rule; deterministic host validation and the finish handshake gate persistence. A future gap-driven refinement loop may schedule targeted follow-up batches, but it is not implemented today.

### 14.1 Proposal envelope

```ts
type ArtifactProposal<T> = {
  id: ProposalId;
  kind: string;
  schemaVersion: number;
  payload: T;
  evidence: EvidenceRef[];
  generatedBy: {
    worker: string;
    provider?: string;
    model?: string;
    promptHash?: string;
  };
  createdAt: string;
};
```

### 14.2 Current compiler sequence

```text
segment-source
  ↓
validated chapter-structure discovery when needed
  ↓
bounded/resumable evidence batches
  ↓
Pi model + typed propose_* tools
  ↓
pending proposal store
  ↓
evidence + cross-artifact validation
  ↓
explicit canonical/possibility acceptance
  ↓
canon replay evaluation
```

This is currently one general compiler-model pass per batch, not a implemented fleet of independent extractor/resolver workers. Separate workers remain an optimization to justify with corpus evidence.

### 14.3 Model-side mutation tools

The first write-capable tools exposed through Pi should be narrow proposal tools, for example:

- `propose_entity`
- `propose_canonical_event`
- `propose_state_delta`
- `propose_world_rule`
- `propose_possibility`
- `propose_runtime_event`

They write only into proposal storage. None can change branch heads, canonical committed artifacts, or snapshots.

A separate deterministic application service owns acceptance/commit.

## 15. Module layout

Recommended code structure:

```text
src/
├── world/
│   ├── model/
│   │   ├── ids.ts
│   │   ├── evidence.ts
│   │   ├── entity.ts
│   │   ├── time.ts
│   │   ├── state-schema.ts
│   │   ├── event.ts
│   │   ├── rule.ts
│   │   ├── possibility.ts
│   │   ├── branch.ts
│   │   └── knowledge.ts
│   ├── predicate/
│   │   ├── schema.ts
│   │   └── evaluate.ts
│   ├── reducer/
│   │   ├── apply-delta.ts
│   │   └── project.ts
│   ├── validation/
│   │   ├── validate-proposal.ts
│   │   ├── invariants.ts
│   │   ├── rules.ts
│   │   └── conflicts.ts
│   ├── store/
│   │   ├── object-store.ts
│   │   ├── canonical-store.ts
│   │   ├── branch-store.ts
│   │   ├── proposal-store.ts
│   │   └── snapshot-store.ts
│   ├── frontier/
│   │   ├── build-frontier.ts
│   │   └── evaluate-possibility.ts
│   ├── scheduler/
│   │   ├── score.ts
│   │   └── select.ts
│   ├── runtime/
│   │   ├── move.ts
│   │   ├── adjudicate.ts
│   │   └── fork.ts
│   └── replay/
│       ├── history-replay.ts
│       └── canon-replay.ts
├── compiler/
│   ├── proposals/
│   ├── validators/
│   └── workers/
└── storage/
    └── workspace-store.ts     # existing control plane only
```

Do not place world semantics in CLI command handlers or Pi session adapters.

## 16. Schema and engine versioning

Every authoritative object includes a schema version either directly or through its commit.

A `WorldCommit` also records `engineVersion` because deterministic projection semantics are part of replay.

Rules:

- readers must reject unsupported future schema versions;
- snapshots/frontier caches with version mismatch are discarded and rebuilt;
- authoritative object migration must be explicit;
- a new engine version that changes reducer semantics requires replay verification before old branches are silently advanced with it.

## 17. Security and trust boundary

Novel text remains untrusted evidence.

New mutation capabilities must preserve the existing security posture:

- Pi built-in coding tools remain disabled by default;
- proposal tools accept typed JSON only;
- proposal tool schemas reject additional properties;
- all referenced evidence must resolve inside the workspace;
- the model cannot choose storage paths;
- the model cannot set commit hashes, branch head pointers, validation results, or engine versions;
- source text cannot activate tools or rules merely by containing instruction-like prose.

In-world rules are fictional data, not agent instructions.

## 18. Observability and auditability

Every mutation should be traceable:

```text
source evidence
  -> proposal id
  -> validation report
  -> accepted delta/event object hashes
  -> world commit hash
  -> branch head
```

Future debugging commands should expose this chain, for example:

```text
nwh world show <branch>
nwh world history <branch>
nwh world inspect-event <hash>
nwh world explain-state <entity> <field>
nwh world frontier <branch>
nwh world explain-possibility <id>
nwh world replay <checkpoints> --branch <source> [--output-branch <new-branch>]
```

Replay forks the source head before executing moves. The source branch is read-only during evaluation, including when a checkpoint fails. Branch diff output covers state, post-fork committed history, and actor-scoped knowledge rather than comparing final state alone.

These are design targets, not Phase 0 CLI commitments.

## 19. Testing strategy

### 19.1 Unit tests

- predicate evaluation;
- state field type enforcement;
- delta application;
- engine invariants;
- rule activation/deactivation;
- scheduler scoring;
- possibility lifecycle evaluation;
- canonical serialization/hashing.

### 19.2 Property/invariant tests

- replaying the same commit chain always produces identical state;
- snapshots equal genesis replay;
- branch fork does not mutate parent history;
- stale-parent proposals cannot commit;
- invalid delta never moves branch head;
- commit IDs are stable for identical canonical content;
- active-rule resolution is deterministic;
- future canonical knowledge never appears in actor views without a committed information path.

### 19.3 Crash-safety tests

Inject failure after every commit protocol step and verify:

- branch head is either old or fully new, never half-updated;
- orphan immutable objects do not affect state;
- corrupt cache data can be deleted/rebuilt.

### 19.4 Golden novel fixture

Choose one constrained scene sequence containing at least:

- 3–5 named entities;
- one location transition;
- one exclusive resource or role;
- one actor intention;
- one information transfer;
- one in-world rule or permission;
- one canonical event with a meaningful precondition;
- one divergence that invalidates a later canonical event.

This fixture becomes the first vertical-slice acceptance test.

## 20. Evaluation metrics

Inventory counts are not readiness metrics. Once annotated gold data exists, evaluation should include executable-world correctness dimensions such as:

- `replayDeterminism`
- `invariantPassRate`
- `stateProjectionCoverage`
- `ruleCoverage`
- `knowledgePropagationCoverage`
- `possibilityConditionCoverage`
- `canonReplayCheckpointMatch`
- `divergenceDurability`

A project should not be called runtime-ready solely because entity/event extraction coverage is high.

## 21. Delivery plan

### Milestone 1 — World contracts and immutable object store

Implement:

- IDs and schemas;
- state schema registry;
- predicate AST;
- `StateDelta`;
- content-addressed objects;
- branch + atomic head pointer;
- branch lock;
- schema/engine versions.

Acceptance: create a branch, commit one hand-authored event, reconstruct state from genesis.

### Milestone 2 — Deterministic reducer and validator

Implement:

- projector;
- delta dry-run;
- engine invariants;
- world-rule evaluation;
- validation reports;
- stale-parent rejection.

Acceptance: invalid events never move the branch head; replay is deterministic.

### Milestone 3 — Canonical vertical-slice compiler

Implement typed compiler proposals for:

- entities;
- canonical events;
- preconditions;
- state deltas;
- temporal world rules.

Acceptance: compile the golden fixture with evidence links and no manual edits to committed canonical artifacts.

### Milestone 4 — Canon replay

Implement checkpoints and replay diagnostics.

Acceptance: reproduce the golden fixture's canonical checkpoints without directly forcing future canonical events.

### Milestone 5 — Possibility frontier and scheduler

Implement:

- possibility templates;
- lifecycle evaluation;
- frontier cache;
- explainable scheduler ranking;
- canon-analogue candidates.

Acceptance: the next canonical event appears because its conditions survive, not because its chapter order says it is next.

### Milestone 6 — Counterfactual branch

Fork before a high-impact event and commit a different valid event.

Acceptance:

- parent branch remains unchanged;
- projected state diverges;
- at least one downstream canonical possibility becomes blocked/expired/transformed;
- the scheduler continues with branch-valid possibilities;
- no silent snap-back to canon occurs.

### Milestone 7 — Actor knowledge and policy

Add actor-scoped views, information propagation, goals, and actor proposal generation.

Acceptance: an actor cannot act on future/compiler-only knowledge unless a committed information path exists.

### Milestone 8 — Narrative render/retell separation

Implement rendering from branch history and actor/world views.

Acceptance: style/POV rewrite changes prose without changing branch head or world state.

### Milestone 9 — Expand compiler breadth

Only after the vertical slice is stable:

- broaden corpus coverage for safe declarative chapter discovery;
- improve entity resolution;
- add epistemic extraction;
- add causal extraction;
- add narrative/meta semantics;
- scale to complete novels;
- revisit storage only if measured scale/concurrency requires it.

## 22. Decisions intentionally deferred

Do not prematurely lock these down:

- a universal fictional calendar representation;
- a database backend;
- a graph database;
- embeddings/vector search;
- distributed worker execution;
- a universal probabilistic simulation model;
- fully general predicate/effect programming;
- multi-agent continuous simulation for every character;
- world-specific character/perception/action panels beyond the generic assistant TUI.

Each should be introduced only when a concrete vertical-slice limitation proves the need.

## 23. Immediate implementation backlog

The semantic core and typed compiler proposal boundary now exist. The next milestone should prove the product loop rather than add another storage abstraction:

1. check in one annotated end-to-end novel slice and expose its compiler evaluation as a repeatable command;
2. orchestrate ingest, bounded compile, proposal review summary, audit, and branch creation without bypassing explicit acceptance;
3. evaluate the actor-scoped intent interpreter and current-world adjudicator on multilingual paraphrases, open destinations, direct contradictions, and impossible desired effects without adding host phrase lists;
4. broaden narrow typed consequence capabilities for physical and social effects only where corpus failures show that committed event progress is insufficient;
5. evaluate and refine the connected Pi-backed hybrid actor reasoner on representative long-horizon novel scenarios without widening its opaque actor-safe projection or deterministic commit gates;
6. connect one Pi-backed narrative adapter behind the immutable `NarrativeFrame` contract;
7. measure epistemic leakage, event/state-delta fidelity, divergence durability, and narrative quality on several genres;
8. refine schemas and scheduling only from observed corpus failures.

See [implementation-status.md](implementation-status.md) for the verified current boundary.

## 24. Success criterion

The technical design succeeds when the following statement is true:

> Given the same source-backed initial model and the same committed event history, the engine reconstructs the same world deterministically; given a different valid committed event, downstream state and future possibilities may diverge durably, while canon remains a reference rather than an obligation and narrative rendering remains unable to mutate truth.
