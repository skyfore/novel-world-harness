# Technical Plan: Evidence-Grounded Full-Novel Semantic Compilation

- **Status:** In progress — M0 through M4, M5a, and M5b-1 implemented; M5b-2, M5c through M7 remain
- **Date:** 2026-08-25
- **Scope:** Novel ingest, structural segmentation, semantic annotation, identity resolution, canonical compilation, audit, reconciliation, and reparse
- **Preserves:** [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md), [ADR 0002](adr/0002-user-level-content-addressed-storage.md), and [ADR 0003](adr/0003-world-time-character-development-and-divergence.md)
- **Builds on:** [Technical Design](technical-design.md) and [Implementation Status](implementation-status.md)
- **Chinese version:** [可溯源的全书小说语义编译](novel-semantic-compilation-plan.zh-CN.md)

## 1. Executive summary

The repository already has the right authority model for an executable novel
world:

- source bytes are immutable evidence;
- model output is a proposal, not truth;
- validation and explicit acceptance precede canonical commitment;
- branch truth is committed event history;
- world state and character development are deterministic projections;
- actor knowledge is isolated from compiler omniscience and future canon.

The principal weakness is the semantic distance between a source segment and a
canonical artifact. The current compiler asks one model pass to discover a
mention, resolve identity, decide event boundaries, infer relationships, assign
causes, map effects into state, and summarize character development. Only the
final artifact and a whole-segment evidence reference survive. The intermediate
decisions are neither inspectable nor independently repairable.

This plan adds a non-authoritative semantic annotation and resolution plane
between source segmentation and canonical proposals:

```text
immutable source bytes
        |
        v
structural units + prompt windows
        |
        v
mentions + quotations + propositions + event mentions
        |
        v
identity/event/time/relation resolution
        |
        v
typed canonical proposals
        |
        v
validate -> accept -> immutable canonical revisions
        |
        v
committed history -> projected world state -> runtime
```

The change is additive. It does not introduce a database, embeddings, a vector
store, or a second source of world truth. Annotation artifacts remain proposals
or derived compiler records. Only the existing canonical and branch commit
boundaries can establish truth.

## 2. Scope and non-goals

### 2.1 In scope

1. Separate prompt context windows from precise source citations.
2. Add field- and relation-level evidence with compilation provenance.
3. Add hierarchical structural units and scene/discourse annotations.
4. Add entity mentions, event mentions, quotations, and explicit resolution
   records.
5. Replace bare causal parent semantics with typed, evidenced event relations
   while retaining a compatibility projection for the runtime.
6. Refine propositions, attribution, factuality, and knowledge acquisition.
7. Make character traits, goals, relationships, and development changes
   contextual, versioned, and evidence-backed.
8. Add source accounting and explicit semantic coverage denominators.
9. Make reconciliation and reparse dependency-aware.
10. Establish a layered evaluation corpus and publication gates.

### 2.2 Non-goals

- Replacing committed event history with a mutable knowledge graph.
- Treating annotation records as branch truth.
- Adding PostgreSQL, a graph database, a vector database, or remote RAG.
- Performing an exhaustive literary-theory encoding before the vertical slice
  is measurable.
- Automatically treating model-inferred psychology or causality as explicit
  source fact.
- Breaking existing branches or silently moving them to newly compiled
  revisions.

## 3. Research findings

### 3.1 The authority and storage foundation is strong

Ingest archives and verifies source material before segmentation
([ingest.ts](../src/commands/ingest.ts#L9)). Source material is UTF-8 validated,
content-addressed, read-only, and revalidated when read
([source-material-store.ts](../src/storage/source-material-store.ts#L26)).
Canonical artifacts already use immutable content-hashed revisions plus mutable
current refs
([canonical-model.ts](../src/world/canonical-model.ts#L49)).

These mechanisms should remain unchanged in authority. The new annotation store
should copy the same immutable revision/ref pattern rather than inventing a
different persistence model.

### 3.2 Current segmentation is safe for batching but too flat for narrative semantics

The segment ontology contains only `section` and `block`
([segments.ts](../src/compiler/segments.ts#L16)). Chapter detection supports
built-in heading patterns or one declarative prefix/number/suffix rule
([chapter-split.ts](../src/compiler/chapter-split.ts#L15)). Oversized sections
are split by byte/line limits and blank-line opportunities
([segments.ts](../src/compiler/segments.ts#L323)).

This is a good transport representation, but chapter and block boundaries are
not reliable event or scene boundaries. Research on fiction scene segmentation
defines scene coherence through time, location, character constellation, and
ongoing action rather than chapter typography
([Detecting Scenes in Fiction](https://aclanthology.org/2021.eacl-main.276/)).
Later work explicitly notes that editorial chapter divisions can split one
scene, including at cliffhangers
([Rethinking Scene Segmentation](https://aclanthology.org/2025.latechclfl-1.8/)).

Finding: retain deterministic chapter/block segmentation, but add semantic
structure above it. Do not make prompt chunks the ontology of the novel.

### 3.3 Evidence integrity is strong, but evidence entailment is weak

`SourceSpan` records line/byte bounds and a quote hash
([model.ts](../src/world/model.ts#L19)). `EvidenceVerifier` verifies immutable
source identity, boundaries, and hashes
([evidence.ts](../src/compiler/evidence.ts#L21)).

However, compiler tools accept only segment IDs. The host converts every cited
segment into a whole-segment evidence reference
([proposal-tools.ts](../src/compiler/proposal-tools.ts#L114),
[segments.ts](../src/compiler/segments.ts#L243)). A segment may contain up to
approximately 1,000 lines or 96 KiB
([segments.ts](../src/compiler/segments.ts#L52)). The compiler path also stamps
the host-created reference as `explicit`, even when the artifact field is a
model interpretation.

The result proves that an artifact was associated with unchanged source bytes,
but not which sentence supports a field, whether the source states it
explicitly, or whether a relation is inferred. Entity grounding additionally
checks name/alias occurrence, but there is no general textual entailment check
for event effects, causal edges, or character traits
([evidence.ts](../src/compiler/evidence.ts#L132)).

The target design follows the selector distinction in the
[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/):
text position identifies a range, while exact/prefix/suffix quote selectors
make the intended text recoverable and robustly reviewable. Compilation
derivation should use the Entity/Activity/Agent distinction from
[W3C PROV-O](https://www.w3.org/TR/prov-o/).

Finding: cryptographic binding and semantic support must become separate
concepts.

### 3.4 A mention and resolution plane is missing

The canonical entity schema contains stable ID, kind, name, aliases, and
artifact-level evidence, but no source mention or resolution object
([model.ts](../src/world/model.ts#L40)). Cross-batch catalogs are intentionally
bounded, and the model must request omitted artifacts when necessary
([batches.ts](../src/compiler/batches.ts#L902),
[artifact-retrieval.ts](../src/compiler/artifact-retrieval.ts#L207)).

This makes a long-book model call responsible for deciding whether a title,
pronoun, nickname, kinship term, or changed office denotes an existing entity.
When that decision is wrong, the system can only revise the final entity/event;
it cannot inspect or relink the underlying mentions.

Long-book coreference remains materially harder than short-document
coreference. BookCoref evaluates book-scale documents averaging more than
200,000 tokens and reports degradation relative to shorter inputs
([BookCoref](https://aclanthology.org/2025.acl-long.1197/)). Multilingual
literary coreference also has language-specific challenges, including Chinese
fiction
([GOLEMcoref](https://aclanthology.org/2026.acl-short.39/)).
The official [BookNLP](https://github.com/booknlp/booknlp) pipeline likewise
keeps proper/common/pronominal mentions, coreference, quotations, entities, and
events as distinguishable outputs.

Finding: canonical identity must be downstream of source mentions and explicit
resolution hypotheses.

### 3.5 Event semantics are compressed too early

A canonical event currently stores participants, time, preconditions, state and
knowledge effects, artifact-level evidence, a confidence value, and
`causalParents`
([model.ts](../src/world/model.ts#L400)). The validator checks that causal
parents exist and do not create definite temporal regression
([validator.ts](../src/compiler/validator.ts#L97)); proposal closure checks
cycles
([proposals.ts](../src/compiler/proposals.ts#L583)).

The relation itself has no type, span, confidence, mechanism, polarity, or
counter-evidence. Consequently temporal continuation, enabling conditions,
motivation, explanation, direct causation, prevention, and subevent structure
can be compressed into the same parent array.

Relations that carry their own attributes should be represented as first-class
objects; this is the n-ary relation case described in the
[W3C N-ary Relations Note](https://www.w3.org/TR/swbp-n-aryRelations/).
Event coreference, temporal, causal, and subevent relations interact and are
jointly annotated in
[MAVEN-ERE](https://aclanthology.org/2022.emnlp-main.60/).
[EventRelBench](https://aclanthology.org/2025.findings-emnlp.482/) further
shows that general LLMs remain unreliable across these event-relation tasks.

Finding: graph validity is not causal validity. Each event relation requires its
own type and evidence.

### 3.6 Claims and knowledge need structured attribution

`Claim` has a free-form predicate, an untyped object, an epistemic category,
and an optional speaker
([model.ts](../src/world/model.ts#L46)). `KnowledgeDelta` correctly separates
what a character knows or believes from world state
([model.ts](../src/world/model.ts#L200)), but cannot fully represent nested
attribution, denial, retraction, deception, observation versus hearsay, or the
time during which a proposition is valid.

Quotation research treats quote span, speaker, addressee, and cue as separate
annotations
([RiQuA](https://aclanthology.org/2020.lrec-1.104/)). Event factuality work also
requires an explicit source or “conceiver” together with certainty
([Event Factuality and Modal Dependency](https://aclanthology.org/2021.acl-long.122/)).
The distinction between a textual event expression and its denoted event is a
core design principle in
[ISO-TimeML](https://aclanthology.org/L10-1027/).

Finding: a claim should be decomposed into proposition, attribution/factuality,
and actor-specific acquisition.

### 3.7 Character development has the right authority but an underspecified ontology

Character goals support knowledge gates, event/time activation, completion,
expiry, milestones, and candidate actions
([actors.ts](../src/world/actors.ts#L26)). Development phases can depend on
state, canonical events, personally experienced events, knowledge, and story
time
([actors.ts](../src/world/actors.ts#L67)). Character development is correctly
projected from committed history and private knowledge rather than stored as a
second mutable timeline
([development.ts](../src/world/development.ts#L61)).

The pre-M5a weak point—and the remaining legacy compatibility path—is the
unrestricted map from arbitrary trait/bias names to scalar values
([actors.ts](../src/world/actors.ts#L115)). Those legacy values have no shared
definition, behavioral anchors, context, target, duration, supporting versus
contradicting evidence, or uncertainty. The runtime projection also exposes only
the last 12 directly participated events as recent lived experience
([development.ts](../src/world/development.ts#L104)).

[PersonaBank](https://aclanthology.org/L16-1163/) combines timeline, character
goals/motivations, and affective impacts;
[Story Commonsense](https://aclanthology.org/P18-1213/) models event-linked
motivation and emotional reaction chains.

Finding: preserve derived development, but replace ungoverned trait labels with
versioned behavioral dimensions and event-linked development episodes.

M5a now implements that finding. `character-v1` registers eight deliberately
behavioral, non-diagnostic dimensions and ten controlled situation contexts
with shared definitions and observable anchors
([character-ontology.ts](../src/world/character-ontology.ts#L14),
[character-ontology.ts](../src/world/character-ontology.ts#L30)). Dispositions
separate scope, stability, evidential basis, validity time, confidence, and
supported versus contested interpretation; stable behavioral inference needs
two distinct spans, while explicit characterization needs explicit evidence
([character-ontology.ts](../src/world/character-ontology.ts#L170)). Appraisals
link an experienced/reported/inferred event to an interpretation proposition,
controlled emotion, affected goals, and resulting intention; development
episodes separately record trigger mode, before/after dispositions, mechanism,
time, decay, and reversal
([character-ontology.ts](../src/world/character-ontology.ts#L223),
[character-ontology.ts](../src/world/character-ontology.ts#L242)).

This is enforced at three boundaries rather than trusted as prompt convention:
V2 schemas reject unregistered free-form keys unless explicitly namespaced
`legacy:` ([actors.ts](../src/world/actors.ts#L112)); prospective and committed
catalog validation rejects dangling actor/event/proposition/goal/disposition
references ([validator.ts](../src/compiler/validator.ts#L570)); exact per-item
support/counter assertions must match the embedded source spans at submit,
closure, commit, audit, and prepared publication boundaries
([character-ontology.ts](../src/world/character-ontology.ts#L390),
[prepared-cache.ts](../src/compiler/prepared-cache.ts#L886)); and runtime
projection activates only non-contested records whose event, experience, and
story-time gates are satisfied
([character-ontology.ts](../src/world/character-ontology.ts#L542)). Actor-facing
model views remove evidence and internal artifact IDs, and suppress
target-specific dispositions when the target is not visible to that actor
([character-ontology.ts](../src/world/character-ontology.ts#L632)).

#### 3.7.1 M5b-1 finding: a relationship is not one symmetric strength

Before M5b-1, the executable layer already had the right identity skeleton:
relationships were stable entities, `relationship.from/to` were directional,
and `character.relationships` stored relationship IDs. The retained legacy
fields nevertheless exposed three lossy shortcuts: free-form
`relationship.kind`, one `relationship.strength` scalar for conceptually
different attitudes, and an untyped `relationship.obligations` entity set
([state.ts](../src/world/state.ts#L160)). CharacterModel had no per-target
stance, obligation content, change mechanism, or event/knowledge gate, so the
runtime could know that a bond existed without a reviewable policy for how one
specific actor regarded the other.

External sources support the modeling principles, not this repository's exact
labels. The W3C [N-ary Relations pattern](https://www.w3.org/TR/swbp-n-aryRelations/)
recommends an addressable relation instance when a relation has confidence,
strength, or other attributes. The Social Relations Model separates actor,
partner, and dyad-specific effects and treats relationship effects as
directional/asymmetric ([Kenny, SRM information](https://davidakenny.net/srm/soremo.htm)).
Computational literary work likewise models relationships as changing through
a book rather than as static lexicon hits
([Feuding Families and Former Friends](https://aclanthology.org/N16-1180/)).
[PersonaBank](https://aclanthology.org/L16-1163/) connects character timelines,
goals/motivations, and the affective impact of events. The implemented design is
therefore a deliberately small engineering subset: stable directed identity,
multidimensional actor policy, and event/knowledge gates. Its six stance
dimensions and nine obligation types are a versioned repository vocabulary,
not a claim of universal psychological measurement.

`relationship-v1` now provides:

- 12 controlled primary relationship types, six behaviorally anchored directed
  stance dimensions, and nine obligation types
  ([relationship-ontology.ts](../src/world/relationship-ontology.ts#L16));
- source/target/relation identity, stability, basis, temporal validity,
  support/contest status, confidence, and item evidence for each stance; stable
  non-explicit inference requires two distinct source spans
  ([relationship-ontology.ts](../src/world/relationship-ontology.ts#L174));
- proposition-backed obligation content with world-event, lived-event,
  knowledge, and story-time activation/resolution; change episodes connect
  same-pair before/after stance or obligation records to trigger events,
  mechanism propositions, time windows, and reversals
  ([relationship-ontology.ts](../src/world/relationship-ontology.ts#L199));
- deterministic entity/event/claim/proposition/pair closure and exact assertion
  equality with embedded evidence
  ([relationship-ontology.ts](../src/world/relationship-ontology.ts#L283),
  [relationship-ontology.ts](../src/world/relationship-ontology.ts#L359));
- fail-closed runtime projection requiring current branch membership, exact
  `from === actor`, exact `to === target`, `active === true`, and a controlled
  type. Future changes wait for committed/experienced/known triggers and a
  reversal restores displaced policy
  ([relationship-ontology.ts](../src/world/relationship-ontology.ts#L434),
  [relationship-ontology.ts](../src/world/relationship-ontology.ts#L582));
- actor-safe grouping by visible target with evidence, proposition/event IDs,
  relationship IDs, and compiler explanations removed. The same view now
  reaches proactive actors, reactive NPCs, player choice, and narration
  ([relationship-ontology.ts](../src/world/relationship-ontology.ts#L528),
  [model-actor-policy.ts](../src/world/model-actor-policy.ts#L181),
  [npc-reaction.ts](../src/world/npc-reaction.ts#L258),
  [play-opening.ts](../src/world/play-opening.ts#L295)).

Relationship existence/direction/type/activity remains branch WorldState derived
from committed events. Stance and perceived obligation remain immutable-version
CharacterModel policy inputs and never write world truth. StateSchema now
deterministically constrains `relationship.type`; kind/strength/untyped
obligations remain compatibility-only
([model.ts](../src/world/model.ts#L297), [state.ts](../src/world/state.ts#L162)).
Audit reports directed/type coverage, legacy operations, semantic inventory,
and closure errors, while prepared publication repeats exact-evidence checks
([audit.ts](../src/compiler/audit.ts#L636),
[prepared-cache.ts](../src/compiler/prepared-cache.ts#L890)). Tests cover schema,
closure, future isolation, wrong-direction fail-closed behavior, reversal,
actor-safe redaction, exact selector injection, and audit coverage
([relationship-ontology.test.ts](../test/relationship-ontology.test.ts#L1),
[proposal-tools.test.ts](../test/proposal-tools.test.ts#L420),
[compiler-audit.test.ts](../test/compiler-audit.test.ts#L263)).

Remaining M5 work is M5b-2 spatial/world-rule domains and M5c deterministic
salience. Goal hierarchy/conflict/commitment should be expanded only from
measured failures.

### 3.8 Current audit cannot measure full-book semantic recall

The compiler prompt explicitly prioritizes a bounded high-leverage graph over
exhaustive mention extraction
([batches.ts](../src/compiler/batches.ts#L638),
[batches.ts](../src/compiler/batches.ts#L659)). Audit ratios are mostly
calculated over artifacts that were already extracted. Entity resolution,
major-event resolution, and epistemic coverage are explicitly `null`
([audit.ts](../src/compiler/audit.ts#L392)).

The semantic publication gate only runs when at least 20 canonical events
already exist
([audit.ts](../src/compiler/audit.ts#L277)). Existing gold evaluation compares
logical ID sets and untyped causal edge pairs
([compiler-eval.ts](../src/eval/compiler-eval.ts#L7)). The long
`三国演义` fixture protects bytes and chapter shape, not semantic accuracy
([corpus README](../fixtures/corpus/README.md#L19),
[corpus-fixture.test.ts](../test/corpus-fixture.test.ts#L8)).

Finding: internal consistency ratios cannot stand in for source-level recall.
The compiler needs a source accounting denominator and an independently
annotated benchmark.

### 3.9 Reconciliation repairs known artifacts, not missing semantics

Bounded reconciliation has two iterations and targets a limited number of known
events and characters
([reconcile-world.ts](../src/compiler/reconcile-world.ts#L15)). Its current
targets are missing summaries, presence, opening checkpoints, time anchors,
typed effects, and coarse character development
([reconcile-world.ts](../src/compiler/reconcile-world.ts#L183)).

Chapter reparse invalidates an artifact only when all its evidence is contained
in the selected spans
([reparse.ts](../src/commands/reparse.ts#L275)). It does not compute a semantic
dependency closure from changed mentions through identity, event relations,
state deltas, goals, and runtime checkpoints.

Finding: repair and reparse need explicit source-accounting gaps and artifact
dependencies.

## 4. Current end-to-end flow after M0-M4, M5a, and M5b-1

```text
nwh ingest
  -> register source metadata
  -> immutable source archive
  -> chapter/block segment manifest
  -> deterministic work/paragraph/sentence/non-scene structure

nwh compile-source / prepare-all
  -> build chapter-bounded batches
  -> create fresh Pi compiler session per batch
  -> provide bounded, paged catalogs and source-scoped lexical read/search
  -> stage exact entity/event mentions, quotations, and discourse observations
  -> stage explicit entity/event resolution decisions
  -> model submits typed proposals plus exact supporting/contradicting selectors
  -> host resolves trusted anchors, EvidenceRefs, and derivation provenance
  -> character-v1 separates disposition, appraisal, and development proposals
  -> relationship-v1 separates directed stance, typed obligation, and relationship change
  -> finish validates source accounting and the prospective semantic graph
  -> pending proposal store

accept / prepare
  -> cryptographic evidence validation
  -> mention-resolution and exact-target trace validation
  -> reference, state-schema, participation, epistemic, event/character/
     relationship-ontology validation
  -> dependency ordering / semantic cycle checks
  -> immutable canonical revision + current ref
  -> prepared publication repeats whole-catalog projection/readiness gates

audit / reconcile
  -> source-accounting denominators and observation/resolution coverage
  -> exact-evidence, participation, epistemic, typed-causality, character, and relationship metrics
  -> bounded repair queues; dependency-aware invalidation remains M6

reparse
  -> invalidate source-backed current artifacts in selected spans
  -> create new immutable revisions
  -> preserve branches pinned to prior prepared revisions

runtime
  -> committed events are branch truth
  -> snapshot V6 pins proposition/attribution/participation/relation revisions
  -> typed semantic records derive compatibility event views, never branch truth
  -> character/relationship policy activates only from committed/experienced/known triggers and actor-safe visibility
  -> deterministic state, knowledge, scenes, and character development
```

The implementation preserves the governing segment -> batch -> proposal ->
validation -> explicit acceptance -> replay sequence
([technical-design.md](technical-design.md#L933)). Source annotations and
resolution records are now non-canonical predecessors of world proposals;
finish-time closure prevents an incomplete prospective graph from being
checkpointed ([proposals.ts](../src/compiler/proposals.ts#L316)). M5a character
and M5b-1 directed-relationship semantics are now compiled, source-scoped,
audited, and projected; M5b-2/M5c still need spatial/rule ontology and salience
selection. M6 needs explicit
dependency-driven invalidation and publication policy, and M7 needs a labeled
multi-novel semantic benchmark.

## 5. Target authority model

| Plane | Data | Authority |
|---|---|---|
| Source | immutable bytes, source manifest | Ground-truth evidence boundary |
| Structure | chapter, paragraph, scene candidates, discourse spans | Derived/proposed; never world truth |
| Annotation | mentions, quotations, proposition/event mentions | Source observations; non-canonical |
| Resolution | identity clusters, event coreference, typed relations | Versioned compiler decisions; still proposals |
| Canonical model | entities, propositions, events, rules, character models | Accepted compilation reference |
| Branch truth | committed event history | Runtime truth |
| Projection | world state, actor knowledge, development, frontier | Deterministically derived |
| Narrative | rendered prose and summaries | Non-authoritative |

Invariants:

1. Every annotation points to one immutable source revision.
2. Every resolution points to the annotations it resolves.
3. Every canonical field or relation has field-level evidence or an explicit
   inference derivation.
4. Annotation and resolution stores cannot write branch state.
5. Runtime state still changes only through validated committed events.
6. Future canon remains outside active branch truth.

## 6. Target ontology

### 6.1 Evidence and provenance

```ts
type TextAnchor = {
  version: 1;
  sourceId: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  exactHash: string;
  prefixHash?: string;
  suffixHash?: string;
  normalization: "source-bytes-v1";
};

type EvidenceAssertion = {
  version: 1;
  id: string;
  target: {
    artifactKind: string;
    artifactId: string;
    jsonPointer: string;
  };
  anchors: TextAnchor[];
  relation: "supports" | "contradicts" | "contextualizes";
  strength: "explicit" | "strong-inference" | "weak-inference";
  interpretation?: string;
  derivation: {
    runId: string;
    compilerBatchId?: string;
    provider?: string;
    model?: string;
    promptHash: string;
    ontologyVersion: string;
    createdAt: string;
  };
};
```

Rules:

- Models never submit byte offsets or hashes as trusted values.
- A model-facing selector supplies a host-issued segment ID plus an exact quote
  and optional prefix/suffix or occurrence discriminator.
- The host resolves the selector inside the validated segment, computes global
  byte/line bounds and hashes, and rejects missing or ambiguous matches.
- `strength` describes the relationship between source and assertion. It is
  not inferred from the fact that the host validated the bytes.
- Required semantic paths are defined per artifact schema. For example, a
  canonical event requires evidence for title/identity, each participant role,
  each state/knowledge effect, each event relation, and each non-unknown time
  anchor.
- Existing `EvidenceRef[]` remains readable. It is classified as
  `legacy-artifact-level` and cannot satisfy the new semantic evidence gate.

### 6.2 Structural units and source accounting

```ts
type StructuralUnitKind =
  | "work"
  | "paratext"
  | "volume"
  | "part"
  | "chapter"
  | "scene"
  | "beat"
  | "paragraph"
  | "sentence"
  | "clause"
  | "non-scene";

type StructuralUnit = {
  id: string;
  sourceId: string;
  kind: StructuralUnitKind;
  parentId?: string;
  anchor: TextAnchor;
  ordinal: number;
  proposedBy: "deterministic" | "model" | "human";
  confidence: number;
  evidenceAssertions: string[];
};

type DiscourseSegment = {
  id: string;
  sourceId: string;
  kind:
    | "scene"
    | "summary"
    | "flashback"
    | "flashforward"
    | "frame"
    | "recollection"
    | "hypothetical"
    | "dream"
    | "embedded-document"
    | "narrator-commentary";
  anchors: TextAnchor[];
  viewpointActorId?: string;
};

type SourceAccountingRecord = {
  unitId: string;
  status:
    | "represented"
    | "background-only"
    | "paratext"
    | "duplicate-description"
    | "unresolved"
    | "intentionally-deferred";
  annotationIds: string[];
  reason?: string;
  reviewedBy: "deterministic" | "model" | "human";
  reviewedAt: string;
};
```

Structural units form a tree. Discourse segments may overlap and need not obey
the structural tree. Prompt batches refer to sets of units but remain a
transport concern.

### 6.3 Entity mentions and identity resolution

```ts
type EntityMention = {
  id: string;
  sourceId: string;
  anchor: TextAnchor;
  surface: string;
  form:
    | "proper"
    | "nominal"
    | "pronoun"
    | "title"
    | "kinship"
    | "collective"
    | "zero-anaphora";
  kindCandidates: EntityKind[];
  sceneId?: string;
};

type IdentityResolution = {
  id: string;
  mentionId: string;
  status: "resolved" | "ambiguous" | "new-entity" | "unresolved";
  entityId?: string;
  candidates: Array<{
    entityId: string;
    confidence: number;
    evidenceAssertionIds: string[];
  }>;
  aliasType?: "name" | "title" | "office" | "kinship" | "nickname" | "other";
  validStoryTime?: StoryTime;
  supersedesResolutionId?: string;
};
```

Rules:

- Mention extraction is source accounting, not canonical identity creation.
- Candidate generation is deterministic lexical lookup first: exact surface,
  normalized aliases, title/kinship patterns, nearby scene participants, and
  typed compatibility.
- The model ranks or proposes candidates; it does not silently merge entities.
- Ambiguity is a valid state.
- Merge and split are immutable resolution revisions.
- Canonical entity aliases are derived from accepted resolved mentions, not
  accepted solely because a model emitted a string.

### 6.4 Quotations, propositions, attribution, and knowledge

```ts
type Quotation = {
  id: string;
  anchor: TextAnchor;
  mode: "direct" | "indirect" | "free-indirect";
  speakerMentionId?: string;
  addresseeMentionIds: string[];
  cueAnchor?: TextAnchor;
  sceneId?: string;
  attributionConfidence: number;
};

type PropositionObject =
  | { kind: "entity"; entityId: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "proposition"; propositionId: string };

type Proposition = {
  id: string;
  subjectEntityId: string;
  relationId: string;
  object: PropositionObject;
  polarity: "positive" | "negative";
  modality: "asserted" | "possible" | "necessary" | "counterfactual";
  validStoryTime?: StoryTime;
  evidenceAssertionIds: string[];
};

type Attribution = {
  id: string;
  propositionId: string;
  holderEntityId?: string;
  holderKind: "narrator" | "character" | "document" | "unknown";
  attitude:
    | "asserts"
    | "knows"
    | "believes"
    | "suspects"
    | "reports"
    | "denies"
    | "questions";
  certainty: number;
  sourceAttributionId?: string;
  quotationIds?: string[];
  evidenceAssertionIds: string[];
};
```

`KnowledgeDelta` should reference accepted proposition/attribution IDs and add
an acquisition mode:

- observed;
- told;
- read;
- inferred;
- remembered;
- deceived/misattributed.

The world-truth decision remains separate. An asserted proposition is not
automatically a state fact.

Implementation note (2026-08-25): M4a is implemented. M4a-1 persists `Proposition` and
`Attribution` as immutable, source-scoped semantic artifacts with proposal,
closure, dependency-order, validator, retrieval, audit, prepared-cache, branch
snapshot, and removal support. Payloads retain compatibility `EvidenceRef[]`;
field-level `EvidenceAssertion` bindings remain in the host-owned assertion
store keyed by artifact revision rather than duplicating assertion IDs inside
the payload. M4a-2 adds quotation IDs to attribution, verifies character
holders against resolved speaker mentions, verifies `told` recipients against resolved
addressees, and carries proposition/attribution/acquisition provenance through
compiler closure, commit, possibility validation, replay, actor projection,
prepared revisions, and audit. `claimId` remains the required runtime key, so
old prepared revisions and event histories remain readable while new semantic
fields are additive. The bridge accepts only positive/asserted propositions
that can be projected losslessly into the legacy claim representation; richer
polarity/modality remains semantic-only until M4b replaces that projection.
Neither proposition nor attribution is promoted to world truth.

M4b-1 is also implemented. `EventParticipation` is now an independently
versioned event/entity/semantic-role assertion; character scene presence is a
separate optional dimension rather than a synonym for agency
([model.ts](../src/world/model.ts#L247)). The catalog validator rejects unknown
references, invalid role/entity combinations, duplicate roles, conflicting
presence, and any typed inventory that cannot project exactly to the legacy
event fields ([event-semantics.ts](../src/world/event-semantics.ts#L18),
[event-semantics.ts](../src/world/event-semantics.ts#L90)). Compiler finish
checks the prospective canonical-plus-pending catalog before checkpointing
([proposals.ts](../src/compiler/proposals.ts#L471)); prepared publication and
runtime snapshot hydration apply the same gate. Snapshot V5 pins participation
revisions and then derives the compatibility event view without mutating world
truth ([context.ts](../src/world/context.ts#L174),
[context.ts](../src/world/context.ts#L298)). Audit coverage counts only real
legacy event/entity slots, so orphan or extra records cannot inflate the metric
([audit.ts](../src/compiler/audit.ts#L514)).

M4b-2 is now implemented. `EventRelation` is a first-class immutable artifact
whose type, evidential status, confidence, mechanism, conditions, supporting
evidence, and counter-evidence are independently reviewable
([model.ts](../src/world/model.ts#L360)). The model-facing compiler schema strips
both supporting and counter-evidence references; models provide exact quote
selectors and the host alone resolves trusted ranges and hashes, including
`contradicts` selectors used as relation counter-evidence
([proposal-tools.ts](../src/compiler/proposal-tools.ts#L215),
[proposal-tools.ts](../src/compiler/proposal-tools.ts#L850)). The deterministic
catalog validator checks endpoint closure, story-time compatibility, inverse
normalization, duplicate/opposite/overlap contradictions, causal/temporal/
subevent cycles, and exact compatibility with legacy causal parents
([event-relations.ts](../src/world/event-relations.ts#L26),
[event-relations.ts](../src/world/event-relations.ts#L71)). Only non-contested
`causes` and `enables` records participate in that compatibility projection;
`narrative-continuation` and contested interpretations remain reviewable but
cannot become runtime causal ancestry
([event-relations.ts](../src/world/event-relations.ts#L22),
[event-relations.ts](../src/world/event-relations.ts#L56)). Same-finish compiler
closure validates the prospective canonical-plus-pending relation graph before
checkpointing ([proposals.ts](../src/compiler/proposals.ts#L392),
[proposals.ts](../src/compiler/proposals.ts#L504)); both single and batch
acceptance also validate the prospective canonical relation catalog before
commit ([validator.ts](../src/compiler/validator.ts#L114)). Prepared publication
repeats the catalog gate, while snapshot V6 pins relation revisions and hydrates
a derived legacy event view without mutating canonical artifacts
([context.ts](../src/world/context.ts#L64),
[context.ts](../src/world/context.ts#L284)). Audit reports relation counts,
validation issues, and coverage against actual legacy causal edges, so extra
relations cannot inflate the denominator
([audit.ts](../src/compiler/audit.ts#L550)).

### 6.5 Events, participation, time, and event relations

```ts
type EventMention = {
  id: string;
  sourceId: string;
  triggerAnchors: TextAnchor[];
  extentAnchors: TextAnchor[];
  eventTypeCandidates: string[];
  sceneId?: string;
  discourseSegmentId?: string;
};

type EventResolution = {
  id: string;
  eventMentionIds: string[];
  status: "resolved" | "ambiguous" | "unresolved";
  canonicalEventId?: string;
  supersedesResolutionId?: string;
};

type EventParticipation = {
  id: string;
  eventId: string;
  entityId: string;
  role:
    | "agent"
    | "patient"
    | "theme"
    | "experiencer"
    | "beneficiary"
    | "instrument"
    | "location"
    | "source"
    | "destination"
    | "other";
  presence?: ParticipantPresence["mode"];
  confidence: number;
  evidence: EvidenceRef[];
};

type EventRelation = {
  id: string;
  fromEventId: string;
  toEventId: string;
  type:
    | "coreference"
    | "subevent"
    | "before"
    | "after"
    | "during"
    | "contains"
    | "overlaps"
    | "starts"
    | "finishes"
    | "causes"
    | "enables"
    | "prevents"
    | "motivates"
    | "explains"
    | "narrative-continuation";
  status: "explicit" | "inferred" | "contested";
  confidence: number;
  mechanism?: string;
  requiredConditions?: Predicate[];
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};
```

As with other migrated semantic artifacts, exact field/relation bindings live
in the host-owned `EvidenceAssertionStore`, keyed by immutable artifact
revision; the payload retains verified `EvidenceRef[]` for compatibility and
source-scope enforcement.

Event relation validation:

1. Referential closure for both endpoints.
2. Temporal compatibility for causal/enabling/preventing relations.
3. Acyclicity only for relation types that require it.
4. Required field-level evidence.
5. Explicit versus inferred status cannot be derived from host byte validation.
6. Coreference is symmetric; subevent is acyclic and non-symmetric.
7. Narrative continuation never satisfies causal ancestry.
8. Contradictory temporal relations produce a blocking validation issue.

Migration compatibility:

- Keep `CanonicalEvent.causalParents` readable during migration.
- New compiles create first-class `EventRelation` records.
- A compatibility projector derives legacy causal parents from accepted
  `causes` and `enables` relations according to a versioned policy.
- Runtime frontier and invalidation code move to typed relations only after
  prepared revisions carry the new compiler fingerprint.

Temporal relations should initially implement a bounded subset of the interval
relations in [W3C OWL-Time](https://www.w3.org/TR/owl-time/): before, after,
during, contains, overlaps, starts, and finishes. No RDF representation is
required.

### 6.6 World state, rules, space, and relationships

The current typed state registry remains the execution boundary. Unsupported
semantics continue to live as propositions rather than being coerced into an
incorrect field.

Add versioned domain modules:

- character physical/status/resource fields;
- artifact identity, custody, quantity, and condition;
- spatial containment, adjacency, route, control, and travel duration;
- institution membership, authority, and procedure;
- faction alignment and control;
- directed relationship stance and obligations.

World rules gain:

```ts
type WorldRuleV2 = {
  id: string;
  name: string;
  kind: "physical" | "social" | "legal" | "magical" | "institutional";
  authorityEntityId?: string;
  jurisdictionEntityIds: string[];
  appliesWhen: Predicate[];
  requires?: Predicate[];
  forbids?: Predicate[];
  effectTemplate?: StateDelta;
  exceptions?: Predicate[];
  priority: number;
  defeasible: boolean;
  validStoryTime?: StoryTime;
  knownByClaimIds?: string[];
  evidenceAssertionIds: string[];
};
```

Use shape-like deterministic validators, inspired by the separation of data and
constraints in [W3C SHACL](https://www.w3.org/TR/shacl/), without adopting an
RDF store.

### 6.7 Character ontology

```ts
type CharacterDimensionDefinition = {
  id: string;
  ontologyVersion: string;
  label: string;
  description: string;
  negativeAnchor: string;
  neutralAnchor: string;
  positiveAnchor: string;
  runtimeUse: "decision" | "relationship" | "rendering" | "analysis";
};

type CharacterDisposition = {
  id: string;
  actorId: string;
  dimensionId: string;
  value: number;
  scope: Global | Context | Target | ContextTarget;
  stability: "stable" | "situational";
  basis: "explicit-characterization" | "repeated-behavior" | "inferred-pattern";
  validStoryTime?: StoryTime;
  status: "supported" | "contested";
  confidence: number;
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};

type AppraisalEpisode = {
  id: string;
  actorId: string;
  eventId: string;
  interpretationPropositionId: string;
  basis: "experienced" | "reported" | "inferred";
  emotion: { label: string; intensity: number };
  affectedGoalIds: string[];
  resultingIntention?: string;
  status: "supported" | "contested";
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};

type DevelopmentEpisode = {
  id: string;
  actorId: string;
  triggerMode: "world" | "experienced";
  triggerEventIds: string[];
  beforeDispositionIds: string[];
  afterDispositionIds: string[];
  mechanism: string;
  startsAt: StoryTime;
  endsAt?: StoryTime;
  decay: None | EventDependent;
  evidenceStatus: "supported" | "contested";
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};
```

Rules:

- Begin with a small, versioned vocabulary needed by actor policy. Do not
  attempt to encode all literary personality theory.
- Context is also a small controlled ID vocabulary; arbitrary prose stays in
  evidenced interpretation fields and never becomes an unbounded policy key.
- A one-off action cannot establish a stable disposition without either
  repeated evidence or explicit narrator characterization.
- Global disposition, current affect, target-specific stance, values, goals,
  and tactics are distinct.
- Existing free-form trait keys migrate to `legacy:<key>`; they are never
  silently mapped to a controlled dimension.
- Development remains a projection over committed history. Development episode
  records describe interpretation policy and evidence; they do not create a
  second authoritative history.
- Active/resolved/reversed runtime status is derived from the branch head, not
  copied from compiler knowledge of the complete canonical arc. Linear decay is
  deferred until trigger events can be mapped to deterministic elapsed time.
- Replace the fixed “last 12 events” context with a deterministic salience
  selector that includes recent, goal-relevant, relationship-changing, and
  high-impact lived events under a hard token budget.

### 6.8 Artifact dependencies

```ts
type ArtifactDependency = {
  from: { kind: string; id: string; revision?: string };
  to: { kind: string; id: string; revision?: string };
  type:
    | "grounded-by"
    | "resolves"
    | "references"
    | "derived-from"
    | "invalidates-with";
};
```

Required paths include:

```text
TextAnchor
  -> StructuralUnit / Mention
  -> IdentityResolution / EventResolution
  -> Proposition / CanonicalEvent / EventRelation
  -> StateDelta / KnowledgeDelta / WorldRule
  -> CharacterGoal / DevelopmentEpisode / Possibility
  -> PreparedRevision / runtime checkpoint
```

The graph is derived from typed records and can be rebuilt. It is not an
independent truth store.

## 7. Target compiler flow

### Stage A: deterministic source structure

Inputs:

- immutable source manifest;
- chapter split plan;
- segment manifest.

Outputs:

- paragraph/sentence boundaries;
- hierarchical chapter/part/paratext candidates;
- stable structural unit IDs based on source identity and byte span;
- prompt windows built from structural units.

Deterministic responsibilities:

- byte/UTF-8 safety;
- hierarchy containment;
- complete non-overlapping base text coverage;
- content hashes;
- stable ordering.

### Stage B: semantic inventory

The compiler reviews every base accounting unit and proposes:

- entity mentions;
- event mentions;
- time/place mentions;
- quotations;
- discourse modes and scene boundaries;
- a source-accounting status.

This pass optimizes recall. It does not create canonical identities, causes,
traits, or state deltas.

Model tools:

- `propose_entity_mentions`;
- `propose_event_mentions`;
- `propose_quotation`;
- `propose_scene_boundary`;
- `account_source_units`.

All tools accept exact quote selectors. The host creates anchors.

### Stage C: identity and event resolution

Inputs:

- all mentions for the active source;
- bounded lexical candidate catalogs;
- exact paged retrieval.

Outputs:

- entity resolution proposals;
- alias classification;
- event coreference/subevent resolution;
- unresolved candidate queues.

The pass can revise prior resolution records but cannot rewrite mention spans.

### Stage D: propositions, time, and event relations

Outputs:

- propositions and attribution;
- quote speaker/addressee;
- event participation roles;
- story-time anchors and typed temporal edges;
- causal/enabling/preventing/motivational/explanatory relations.

Relation-specific evidence is mandatory. Inference is permitted only with an
explicit status and derivation.

### Stage E: executable-world compilation

Inputs are accepted or active resolution artifacts rather than raw text alone.
The compiler proposes:

- canonical entities/events;
- state and knowledge deltas;
- initial world;
- world rules;
- character goals/models;
- possibilities.

Raw source remains accessible to verify interpretation, but canonical proposal
tools reference annotation/resolution IDs and field evidence assertions.

### Stage F: whole-world reconciliation

Reconciliation receives:

- source accounting gaps;
- unresolved mentions;
- relation conflicts;
- events without required field evidence;
- uncovered recurring characters;
- temporal inconsistencies;
- stale dependency closures.

It can propose replacements through normal typed tools only. Missing semantics
become first-class repair targets rather than being invisible.

## 8. Model tool and prompt changes

### 8.1 Exact selector input

Replace `evidence_segment_ids` as the only model-facing evidence mechanism
with:

```ts
type ModelEvidenceSelector = {
  segment_id: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  occurrence?: number;
  target_path: string;
  relation: "supports" | "contradicts" | "contextualizes";
  strength: "explicit" | "strong-inference" | "weak-inference";
  interpretation?: string;
};
```

Compatibility:

- Old tools and tests may continue using `evidence_segment_ids`.
- New compiler fingerprint requires selectors for semantic publication.
- If `exact` occurs more than once and context does not uniquely resolve it,
  the tool rejects the proposal and reports candidate occurrences.
- The host limits exact/prefix/suffix lengths and never trusts model offsets.

### 8.2 Phase-specific tools

Do not expose every mutation tool in every pass. Each compiler phase receives:

- source-scoped read/search;
- phase-specific proposal tools;
- exact artifact retrieval;
- finish/defer/withdraw controls.

This reduces the chance that mention discovery prematurely invents canonical
state or that executable compilation silently creates unresolved identities.

### 8.3 Prompt contracts

Prompts must explicitly distinguish:

- exhaustive source accounting versus selective executable modeling;
- mention versus identity;
- event expression versus canonical occurrence;
- temporal order versus cause;
- narrator assertion versus branch truth;
- stable disposition versus current affect;
- host-validated bytes versus semantic evidence strength.

Prompts remain untrusted policy inputs. Validators enforce the boundaries.

## 9. Storage and schema migration

### 9.1 Proposed layout

```text
$NWH_HOME/workspaces/v1/<workspace-id>/
  sources/
  segments/
  world/v1/
    compiler/
      semantic/v2/
        <source-id>/
          structure/
          annotations/
          resolutions/
          evidence/
          accounting/
          dependencies/
          refs/
          revisions/
    canon/
      entities/
      claims/
      events/
      rules/
      event-relations/
    proposals/
    prepared/
```

Exact directories may follow existing store conventions, but all semantic
records must use:

- canonical JSON serialization;
- immutable revision files;
- atomic current refs;
- safe IDs;
- source-scoped listing;
- content-hash verification.

### 9.2 Compatibility policy

1. Existing `world/v1` canonical records stay readable.
2. Add optional V2 fields or separate V2 stores; do not make old strict schemas
   unreadable.
3. Prepared-revision fingerprints include:
   - annotation schema version;
   - evidence selector version;
   - ontology vocabulary versions;
   - resolver version;
   - prompt policy hashes;
   - state registry and engine version.
4. A legacy prepared revision may continue serving an existing branch.
5. Publishing a V2 prepared revision selects a fresh branch by default.
6. Reparse creates new revisions; it does not mutate old content-hashed objects.
7. Legacy evidence is visible in audits but does not satisfy
   `semanticEvidenceReady`.

### 9.3 Migration sequence

1. Add read/write stores and schemas with no compiler behavior change.
2. Backfill structural units and legacy segment-level evidence descriptors.
3. Enable exact selectors behind a compiler fingerprint flag.
4. Reparse one gold slice into annotations/resolutions.
5. Enable V2 canonical compilation for that slice.
6. Add dual-read compatibility projections.
7. Make V2 the default for new workspaces.
8. Require explicit whole-source reparse to upgrade existing prepared worlds.

## 10. Audit and publication gates

Replace the overloaded `semanticReady` with an explicit three-state report:

```ts
type ReadinessState = "ready" | "not-ready" | "unknown";

type CompilerReadiness = {
  structural: ReadinessState;
  evidence: ReadinessState;
  accounting: ReadinessState;
  resolution: ReadinessState;
  semantic: ReadinessState;
  runtime: ReadinessState;
  publication: ReadinessState;
  unknownDimensions: string[];
  blockingIssues: string[];
};
```

Definitions:

- `structural`: source identity, segmentation, hierarchy, and coverage are
  valid.
- `evidence`: every required field/relation has valid exact anchors or an
  explicit derivation.
- `accounting`: every required base unit has an accounting record.
- `resolution`: unresolved and ambiguous mention rates are below a
  declared, genre-specific threshold; all canonical references resolve.
- `semantic`: events, relations, time, state/knowledge effects, character
  goals/models, and rules satisfy schema and consistency gates.
- `runtime`: initial checkpoint, physical presence, actionability,
  autonomous drivers, replay, and actor isolation pass.
- `publication`: all required readiness dimensions are ready. Unknown is
  blocking, not equivalent to ready.

Audit denominators:

- structural units from deterministic source coverage;
- mentions from the semantic inventory pass;
- recurring characters from resolved mention/event participation;
- events from event-mention clusters, not only canonical events;
- knowledge opportunities from propositions observed/reported in scenes;
- major events from a reviewed benchmark or human major-event inventory.

Inventory counts remain useful diagnostics but are never labeled coverage.

## 11. Evaluation plan

### 11.1 Evaluation layers

| Layer | Gold data | Metrics |
|---|---|---|
| Structure | hierarchy and scene boundaries | exact/fuzzy boundary precision, recall, F1 |
| Evidence | field-to-source spans | exact match, span IoU, unsupported assertion rate |
| Mentions | entity/event/time/place/quote mentions | span and type precision, recall, F1 |
| Coreference | entity and event clusters | MUC, B³, CEAF, CoNLL aggregate |
| Quotations | quote, speaker, addressee, cue | span F1 and attribution accuracy |
| Events | event type and participant roles | trigger/type/role F1 |
| Time | story anchors and typed relations | relation F1, contradiction rate |
| Causality | typed evidenced relations | edge/type F1, evidence support rate |
| Proposition | polarity, modality, holder, certainty | macro F1 and calibration |
| Knowledge | acquisition and actor visibility | operation F1 and leakage failures |
| State | deterministic state/knowledge deltas | operation accuracy and replay invariants |
| Character | goals, appraisals, development changes | expert agreement, evidence support, calibration |
| Relationship | directed type, stance, obligation, change | pair/type F1, change F1, evidence support, future-leakage failures |
| End-to-end | prepared world and branching | determinism, canon replay, divergence, spoiler isolation |

Logical IDs alone are insufficient for matching. Evaluation aligns artifacts by
exact evidence anchors, mention clusters, typed relations, and normalized
semantic content.

### 11.2 Corpus sequence

1. Retain `smoke-world.txt` for fast end-to-end behavior.
2. Create a deeply annotated, multi-chapter gold slice containing:
   - aliases/titles/pronouns;
   - cross-chapter identity;
   - direct and indirect quotation;
   - false or uncertain belief;
   - flashback or recollection;
   - explicit and inferred causality;
   - relationship and character development;
   - a branchable state-changing event.
3. Add a reviewed subset of `三国演义` after edition/provenance questions are
   resolved.
4. Add modern multi-viewpoint and nonlinear fiction fixtures.
5. Run cross-provider/model stability evaluation only after deterministic
   layer metrics are available.

### 11.3 Initial gates

These are starting engineering targets and must be recalibrated after measuring
the first gold slice:

- 100% cryptographic validity for accepted anchors;
- 100% required-field evidence coverage for published canonical artifacts;
- 100% source-accounting coverage, with unresolved/deferred allowed but counted;
- at least 0.90 mention F1 on the constrained gold slice;
- at least 0.80 CoNLL coreference score;
- at least 0.85 event trigger F1 and 0.80 participant-role F1;
- at least 0.80 typed temporal-relation F1;
- at least 0.75 typed causal-relation F1;
- zero deterministic replay failures;
- zero actor-knowledge leakage failures;
- zero silently upgraded legacy prepared revisions.

Metric thresholds are publication policy, not claims of literary fidelity.
Human review remains required for contested interpretation and major-event
coverage.

## 12. Implementation milestones

### M0: Baseline and gold denominator

Objective: make current limitations measurable before changing extraction.

Work:

- freeze current compiler/evaluator reports for the smoke fixture;
- define gold schemas for spans, mentions, clusters, events, roles, relations,
  propositions, knowledge, and state effects;
- annotate the first representative slice;
- add evaluator alignment by anchor and semantic content;
- split audit readiness fields without changing publication behavior yet.

Primary files:

- `src/eval/compiler-eval.ts`;
- `src/compiler/audit.ts`;
- `test/compiler-eval.test.ts`;
- `fixtures/corpus/`.

Exit criteria:

- CI produces layered metrics;
- missing denominators are reported as explicit unknown/blocking values;
- current compiler has a recorded baseline.

### M1: Exact evidence and provenance

Objective: make every semantic assertion reviewable at exact source text.

Work:

- add `TextAnchor`, `EvidenceAssertion`, and derivation schemas;
- implement host-side exact selector resolution;
- add evidence assertion store and verifier;
- add model tool JSON schema for selectors;
- retain legacy segment evidence as compatibility context;
- update proposal envelopes and retrieval output;
- add target-path validation against artifact schemas.

Primary files:

- `src/world/model.ts`;
- `src/compiler/proposal-tools.ts`;
- `src/compiler/evidence.ts`;
- `src/compiler/proposals.ts`;
- `src/world/canonical-model.ts`;
- evidence/retrieval tests.

Exit criteria:

- model cannot submit trusted hashes or offsets;
- duplicate quote matches are rejected unless disambiguated;
- exact source mutations invalidate anchors;
- strength is not automatically `explicit`;
- every new required artifact field has evidence or a typed validation failure.

### M2: Structure, mentions, and source accounting

Objective: insert a source-observation layer before canonicalization.

Implementation status (2026-08-25): complete. Deterministic structure and
accounting are implemented in `src/compiler/structure.ts` and
`src/compiler/source-accounting.ts`; proposal-backed mentions, quotations,
overlapping discourse observations, immutable revisions, closure validation,
batch recovery, audit, removal, and paged retrieval are implemented in
`src/compiler/annotations.ts`, `src/compiler/annotation-retrieval.ts`, and
`src/compiler/proposal-tools.ts`. Identity resolution intentionally remains M3.

Work:

- add structural/discourse schemas and stores;
- deterministically materialize paragraph/sentence units;
- propose scene and discourse spans;
- add mention and quotation proposal tools;
- add accounting records for every base unit;
- expose paged annotation retrieval.

Primary files:

- new `src/compiler/annotations.ts`;
- new `src/compiler/structure.ts`;
- new `src/compiler/source-accounting.ts`;
- `src/compiler/batches.ts`;
- `src/compiler/pi-compiler.ts`;
- `src/compiler/proposal-tools.ts`.

Exit criteria:

- every source byte belongs to a deterministic base structural unit;
- every required unit is accounted;
- mention extraction never writes canonical identity;
- scene/discourse spans may overlap without corrupting source order.

### M3: Identity and event resolution

Objective: make cross-book identity and event fusion explicit and revisable.

Implementation status (2026-08-25): M3a entity resolution is complete.
`src/compiler/entity-resolution.ts` and
`src/compiler/entity-resolution-retrieval.ts` provide deterministic lexical
candidates, explicit resolved/new/ambiguous/unresolved decisions, immutable
superseding revisions, source-scoped paging, audit denominators, and canonical
name/alias trace gates. M3b-1 event mentions are also implemented in the
non-canonical observation layer with exact trigger/extent anchors, participant
mention references, discourse context, salience, closure, paging, and audit
counts. M3b-2 is now implemented in `src/compiler/event-resolution.ts` and
`src/compiler/event-resolution-retrieval.ts`: deterministic evidence/title/
participant candidates, explicit coreference/subevent clusters,
resolved/new-event/ambiguous/unresolved decisions, immutable merge/split
revisions, participant and canonical-event trace gates, paging, recovery, and
major-event audit coverage complete M3.

Work:

- deterministic lexical candidate generation;
- entity resolution proposals and immutable revisions;
- alias typing and story-time validity;
- event coreference/subevent resolution;
- unresolved/ambiguous queues;
- accepted resolution closure checks before canonical proposals.

Primary files:

- new `src/compiler/entity-resolution.ts`;
- new `src/compiler/event-resolution.ts`;
- `src/compiler/artifact-retrieval.ts`;
- `src/compiler/validator.ts`;
- `src/world/canonical-model.ts`.

Exit criteria:

- all canonical entity/event references trace to resolved mentions;
- ambiguous mentions remain visible;
- merge/split creates revisions and dependency impacts;
- long-book resolution is source-scoped and paged.

### M4: Typed event, proposition, and knowledge semantics

Objective: distinguish narrative order, factuality, temporal relations, and
causality.

Implementation status (2026-08-25): M4a, M4b-1, and M4b-2 are complete. Proposition/attribution
identity and quotation-backed knowledge acquisition are implemented with
source, identity-resolution, closure, commit, replay, and audit gates. Typed
event participation now has the same revision, retrieval, closure, prepared,
snapshot, removal, and audit lifecycle, with exact legacy participant/presence
projection. Typed event relations now have independent evidence, status,
confidence, temporal/causal/subevent graph validation, prepared/snapshot/audit
lifecycle support, and a versioned lossless `causalParents` compatibility
projection that excludes contested and narrative-only relations.

Work:

- add quotation/proposition/attribution schemas;
- add event participation and event relation stores;
- add temporal relation validators;
- migrate knowledge acquisition to proposition/attribution IDs;
- provide legacy claim and causal-parent projections;
- update compiler prompts and retrieval catalogs.

Primary files:

- `src/world/model.ts`;
- `src/world/event-semantics.ts`;
- `src/world/context.ts`;
- `src/world/knowledge.ts`;
- `src/compiler/proposals.ts`;
- `src/compiler/validator.ts`;
- `src/compiler/batches.ts`;
- `src/compiler/audit.ts`;
- `src/compiler/prepared-cache.ts`;
- `src/world/frontier.ts`;
- `src/world/canon-runtime.ts`.

Exit criteria:

- temporal continuation cannot satisfy a causal dependency;
- every event relation has independent evidence/confidence;
- quote speaker/addressee are independently reviewable;
- narrator assertion does not automatically become state or actor knowledge;
- runtime compatibility tests pass for old prepared revisions.

### M5: Character, relationship, rule, and spatial ontology

Objective: make agent behavior depend on evidence-backed, contextual
development rather than arbitrary trait names.

Status: **M5a and M5b-1 complete and verified; M5b-2/M5c pending.** Character
and directed-relationship controlled registries, nested host-owned evidence,
prospective/commit/prepared validation, audit metrics, and actor-safe runtime
projection are implemented
([character-ontology.ts](../src/world/character-ontology.ts#L14),
[relationship-ontology.ts](../src/world/relationship-ontology.ts#L16),
[proposal-tools.ts](../src/compiler/proposal-tools.ts#L312),
[audit.ts](../src/compiler/audit.ts#L636)).

Work:

- [implemented M5a] introduce controlled character dimension registry;
- [implemented M5a] add dispositions, appraisals, and development episodes;
- enrich goal hierarchy/conflict/commitment;
- [implemented M5b-1] add directed target-specific identity/type, stance,
  typed obligation, and before/after relationship change;
- add spatial and world-rule domain modules;
- replace fixed recent-event slicing with deterministic salience selection.

Primary files:

- `src/world/actors.ts`;
- `src/world/development.ts`;
- `src/world/state.ts`;
- `src/world/relationship-ontology.ts`;
- `src/world/model-actor-policy.ts`;
- `src/compiler/semantics.ts`;
- related runtime and actor tests.

Exit criteria:

- no new unregistered trait key enters a V2 prepared world;
- every disposition/development change has context and evidence;
- current affect, stable disposition, relationship stance, and goal are
  separate;
- reverse direction cannot reuse forward stance, and future relationship policy
  cannot activate early;
- every relationship semantic record has exact support/counter-evidence;
- actor projection remains deterministic and knowledge-safe.

### M6: Dependency-aware audit, reconciliation, and reparse

Objective: make missing and stale semantics discoverable and repairable.

Work:

- materialize rebuildable artifact dependency graph;
- calculate impact closure from changed anchors;
- mark downstream artifacts stale rather than silently retaining them;
- target reconciliation from accounting gaps and unresolved queues;
- implement new readiness report and publication gates;
- preserve branch pinning and rollback behavior.

Primary files:

- `src/compiler/audit.ts`;
- `src/compiler/reconcile-world.ts`;
- `src/commands/reparse.ts`;
- `src/compiler/prepared-cache.ts`;
- `src/workflow/prepare.ts`.

Exit criteria:

- a source edit identifies all directly and transitively affected artifacts;
- missing major semantic units are repair targets;
- publication cannot pass with unknown required coverage;
- old branches replay against their prior prepared revision.

### M7: Scale, robustness, and default rollout

Objective: prove the pipeline on long books and make V2 the default.

Work:

- full-book resumability and memory profiling;
- cross-chapter stitching tests;
- cross-model/provider stability runs;
- uncertainty-driven human review queue;
- documentation and CLI status output;
- V2 default for new workspaces after gates pass.

Exit criteria:

- bounded memory and resumable progress on the full long-book fixture;
- no loss of exact evidence during catalog paging;
- deterministic outputs are provider-independent;
- semantic variance is reported rather than hidden;
- V1 remains readable and explicitly identified as legacy.

## 13. Delivery order and dependencies

```text
M0 baseline/gold
  |
  v
M1 exact evidence
  |
  v
M2 structure/mentions/accounting
  |
  v
M3 resolution
  |
  v
M4 event/proposition/knowledge
  |
  +------> M5 character/world ontology
  |
  +------> M6 audit/reparse
                  |
                  v
               M7 rollout
```

M0 and M1 are mandatory first. Adding a richer ontology without exact evidence
and a denominator would increase the amount of unverifiable model output.

## 14. Test strategy

### Unit tests

- UTF-8 exact selector resolution, including Chinese multibyte characters;
- repeated exact quotes with prefix/suffix disambiguation;
- line/byte/hash reconstruction;
- target JSON Pointer validation;
- mention and resolution schema closure;
- relation symmetry/acyclicity/temporal compatibility;
- proposition polarity/modality and attribution chains;
- character vocabulary and bounded values;
- source accounting state machine;
- dependency closure.

### Property and mutation tests

- arbitrary valid source anchors round-trip to identical bytes;
- changing one source byte invalidates only affected anchors initially;
- dependency closure contains every derived downstream artifact;
- order-independent canonical JSON produces stable hashes;
- invalid event-relation cycles are rejected;
- unresolved annotations never enter runtime state.

### Integration tests

- ingest -> structure -> annotate -> resolve -> compile -> accept;
- exact evidence retrieval for every accepted field;
- chapter-boundary scene continuation;
- alias/title resolution across distant chapters;
- rumor versus world truth versus character belief;
- explicit versus inferred causality;
- reparse preserves old branch revision and publishes a fresh one;
- V1 prepared worlds remain readable.

### End-to-end tests

- canonical replay;
- divergence invalidates typed causal descendants;
- alternative events produce deterministic state;
- actor knowledge isolation;
- character development changes only after lived/learned triggers;
- no narrative output writes truth.

## 15. Operational observability

Each compiler run should expose:

- source units total/accounted/unresolved/deferred;
- mentions by type and unresolved candidate count;
- exact evidence assertions valid/invalid/missing;
- entities and events with unresolved grounding;
- relation counts by type, status, and confidence band;
- state/knowledge operations with and without field evidence;
- character dimensions and development episodes with counter-evidence;
- stale dependency count;
- readiness dimensions and blocking reasons;
- model/provider/prompt/ontology fingerprints.

CLI output should distinguish:

- “compilation structurally complete”;
- “semantic inventory complete with unresolved items”;
- “runtime-ready vertical slice”;
- “full-book publication-ready”.

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Ontology expansion slows delivery | Implement milestones; begin with evidence and mentions, not every domain type |
| Model produces false precision | Host resolves anchors; explicit/inferred status; relation-level evidence; human contested state |
| Controlled vocab loses literary nuance | Keep propositions and versioned `other`; do not coerce unsupported semantics |
| Full-book cost grows | Separate recall-oriented inventory from selective executable compilation; page catalogs; resumable checkpoints |
| Identity merge corrupts downstream data | Immutable resolution revisions and dependency impact closure |
| Exact quote selector is ambiguous | Require prefix/suffix or occurrence and reject ambiguity |
| Unicode offsets drift | Compute byte/line offsets only from archived source bytes in the host |
| Legacy worlds break | Dual-read schemas, fingerprints, pinned revisions, explicit reparse |
| Audit creates false confidence | Unknown is blocking; counts are inventory, not recall; retain human gold denominator |
| Character model stereotypes actors | Behavioral anchors, context/target/time, counter-evidence, no diagnostic personality claims |

## 17. Final system effect

After this plan is complete, the system changes in observable ways:

| Current behavior | Target behavior |
|---|---|
| Artifact cites a whole prompt segment | Every important field and relation links to exact source text |
| Host marks segment evidence as explicit | Byte validity and semantic inference strength are independent |
| Model creates entity identity directly | Mentions are inventoried, then explicitly resolved or left ambiguous |
| Chapters/blocks stand in for narrative units | Structural hierarchy and overlapping scene/discourse spans coexist |
| Event participants are untyped IDs | Participation roles and presence have independent evidence |
| `causalParents` conflates several relations | Cause, enablement, prevention, motivation, time, subevent, and continuation are distinct |
| Claim predicate/object is largely free-form | Proposition, attribution, factuality, and actor acquisition are separable |
| Trait names are arbitrary scalar keys | Character dimensions are versioned, contextual, temporal, and evidenced |
| Audit measures extracted inventory | Source accounting and gold annotations provide denominators |
| Reconcile repairs known weak events | Reconcile can discover missing/unresolved semantic units |
| Chapter reparse uses evidence containment only | Reparse computes downstream semantic impact while preserving pinned branches |

The final product can answer not only “what world was compiled?” but also:

- which exact source words support each fact, relationship, and state change;
- whether the source states a conclusion or the compiler inferred it;
- which mentions were merged into each stable entity;
- why two events are causally related rather than merely adjacent;
- what a character knew, believed, valued, wanted, and experienced at a given
  branch point;
- which source material remains unresolved;
- which artifacts must be revisited after a source or ontology change.

Most importantly, these improvements preserve the product's governing
architecture: original evidence remains the compilation boundary, model output
remains provisional, committed history remains branch truth, and deterministic
projection remains the only route from accepted events to executable world
state.
