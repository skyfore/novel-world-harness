# Context injection, visibility, and authority audit

Date: 2026-08-25

This is the evidence record for every application-controlled path that can
place data in a model request, every public callback that could be implemented
with a model, and every host path that can turn a model result into persistent
state. It deliberately separates three different questions:

1. what data is constructed on the host;
2. what data actually crosses a model boundary;
3. what authority the returned value has after it comes back.

The governing rule is that compiled canon, committed branch truth, actor
knowledge, and model context are different projections. A value being present
in host memory does not mean it is sent to a model.

## Audit method and complete boundary inventory

The inventory was built by tracing every `PiAgentSession.create`, every direct
`ModelRuntime.create`, every prompt constructor, Pi's lifecycle hooks, and the
exported callback types that accept world data.

There are ten application inference roles. The player-scene path is one host
operation but four isolated inference boundaries:

| Inference role | Construction site | Model-visible input | Available model tools | Persistent authority |
| --- | --- | --- | --- | --- |
| Ordinary TUI/print assistant | `playCommand` | Harness prompt/contract, allowlisted project instructions, projected ordinary transcript, current user input and explicit safe attachments | bounded `list_files`, `search_files`, `read_file`; extension-owned session rename metadata | no file/world write; session title only |
| Compiler | `createPiCompilerSession`, or an explicit compiler turn in the TUI | isolated compiler instructions plus a host-selected structure/source/opening/reconciliation payload and source-owned prior-artifact indexes; a chapter-bounded pass may request one non-citable edge preview, while a separately scheduled pair pass receives both full adjacent segments | scope-specific chapter-rule, exact-retrieval, boundary-deferral, and typed pending-proposal tools | validated chapter workflow metadata, pending/rejected proposal envelopes, non-canonical calibration requests, and a finish handshake; no canonical or branch commit |
| Player-action translator | `createPiPlayerActionTranslator` | one actor-safe projection with opaque turn handles, one untrusted utterance, the latest ten exact presentation messages for the selected embodied actor, and bounded coverage metadata | exact retrieval over the already-safe actor projection, actor/branch-safe related-message retrieval, and one in-memory capture tool | none; the host decodes, validates, and constructs the event proposal |
| Player-world adjudicator | `createPiPlayerWorldAdjudicator` | the typed intended candidate, relevant current committed entity state, applicable active rules, deterministic preview issue codes, actor write capabilities, and the latest ten presentation messages, all with opaque handles and no future canon | branch-safe related-message retrieval and one in-memory resolution-capture tool | none; realization/transformation and its contradiction certificate are revalidated before the host can construct or commit an event |
| Reactive NPC reasoner | `createPiNpcReactionReasoner` | one addressed NPC's actor-safe state/knowledge, exact perceived trigger, latest ten actor-perceived events, effective development/goals/affect, and active rules explicitly marked as private constraints | exact actor-context retrieval, retrieval over only that NPC's perceived event archive, and one in-memory reaction-capture tool | none; the host decodes and validates actor scope, knowledge, space, rules, invariants, head, and causal parent before a separate actor event can commit |
| Player-world response linker | `createPiPlayerWorldResponseResolver` | one already-committed structured player intent, the latest ten presentation messages, and a bounded host-private list of currently eligible world-side developments; stable possibility/entity IDs are replaced or omitted, and this future-facing input never reaches the actor or narrator | branch-safe related-message retrieval and one in-memory selection-capture tool accepting one offered opaque handle or none | none; the host records the offered set, rejects unoffered/stale selections, and submits the selected typed possibility through normal engine validation as a separate event |
| Player-choice specialist | `createPiPlayerOpeningNarrator` | actor-safe current scene, resolved player act/outcomes, effective disposition/motivation, and presentation window; source prose and long-form play prose are omitted | actor-context and branch-safe related-message retrieval plus one in-memory choice-capture tool | none; a selected suggestion enters the separate player-action boundary |
| Literary-style specialist | `createPiPlayerOpeningNarrator` | actor name, exact requested/locked wording, narrator-safe exact source excerpts, and exact bounded play prose, all with explicit non-world authority | one in-memory style-analysis capture tool | none; bounded analysis is advisory only |
| Scene-dramaturgy specialist | `createPiPlayerOpeningNarrator` | actor-safe committed scene/outcomes plus exact play continuity, with source prose omitted | actor-context retrieval plus one in-memory dramaturgy-capture tool | none; bounded analysis is advisory only |
| Final scene narrator | `createPiPlayerOpeningNarrator` | an authority-ranked actor frame, resolved act, narrator-safe source prose, exact play continuity, and successful bounded specialist advisories | exact actor-context and actor/branch-safe related-message retrieval; no choice, analysis, or mutation tool | none; prose is presentation-only and cannot mutate branch truth |

Evidence: [play.ts](../src/commands/play.ts),
[pi-compiler.ts](../src/compiler/pi-compiler.ts),
[pi-player-action.ts](../src/agent/pi-player-action.ts),
[pi-player-world-adjudicator.ts](../src/agent/pi-player-world-adjudicator.ts),
[pi-player-world-response.ts](../src/agent/pi-player-world-response.ts),
and [pi-player-opening.ts](../src/agent/pi-player-opening.ts), plus
[pi-npc-reaction.ts](../src/agent/pi-npc-reaction.ts). The only other
direct `ModelRuntime.create` is `doctorCommand`; it reads provider/authentication
metadata but never constructs a prompt or invokes inference.
[doctor.ts](../src/commands/doctor.ts)

### Public callback inventory

These API seams must not be confused with the built-in Pi roles:

| Callback | Data supplied by the harness | Boundary status and returned-value gate |
| --- | --- | --- |
| `PlayerActionTranslator` | actor-scoped stable IDs, visible state/knowledge/events, and writable capabilities; no commit chronology | safe for a model adapter after that adapter applies its own transport policy. Input is a frozen clone and output must pass `playerActionCandidateSchema` plus scope and grounding. The built-in Pi adapter additionally replaces stable IDs with opaque handles; world realization is a separate boundary. |
| `PlayerWorldAdjudicator` | typed intent/candidate, relevant current committed state, applicable rules, and preview issue codes; no future canon | host-authority callback over current world truth, not actor-safe reasoning. Output is frozen/captured proposal data and must pass the resolution schema, contradiction-certificate checks, replacement scope/grounding/spatial checks, knowledge gates, and engine validation. The built-in adapter uses opaque handles. |
| `NpcReactionReasoner` | one NPC's actor-safe context, perceived trigger/history, effective current development/goals/affect, and active rules marked as host-only constraints | model-safe only after transport applies opaque handles. The response is schema-captured and must pass actor scope, grounding, spatial, knowledge, engine, head, and causal validation. Missing model/goal data never grants access to wider context. |
| `PlayerOpeningNarrator` | `PlayerSceneNarratorFrame`: names and actor-visible semantics, exact resolved act/locked dialogue, narrator-safe style-only source excerpts, exact presentation-only play continuity, and current disposition/motivation, with branch/commit/time/stable/source-storage IDs removed | model-safe frame. The built-in adapter fans it through isolated specialists and a final narrator; the TUI validates narration/choice structure and locked-dialogue preservation. A selected suggestion is interpreted, adjudicated, and deterministically validated like free-form input. |
| `ActorReasoner` | opaque actor view, one currently active goal description/priority/visible targets, active disposition, and committed development | model-safe input snapshot. Output is strict-schema parsed, handle-decoded, and sent through the player capability gates before it can become an actor proposal. |
| `NarrativeAdapter` in actor POV | actor name, visible self state and acquired claims, and participant-visible event summaries | actor-safe and frozen. Adapter output must be a string; rendering is non-authoritative and branch-head immutability is checked. |
| `NarrativeAdapter` in explicit omniscient POV | full projected `WorldState`, commit/branch IDs, and committed history | intentionally **not** model-safe for an untrusted/actor model. This is a diagnostic/host-authority API, selected explicitly by the caller. |

Evidence: [player-action.ts](../src/world/player-action.ts),
[play-opening.ts](../src/world/play-opening.ts),
[model-actor-policy.ts](../src/world/model-actor-policy.ts),
[narrative.ts](../src/world/narrative.ts), and tests in
[player-action.test.ts](../test/player-action.test.ts),
[model-actor-policy.test.ts](../test/model-actor-policy.test.ts), and
[narrative.test.ts](../test/narrative.test.ts).

The following are trusted host-authority callbacks, not actor/model-safe
interfaces: `PossibilitySource` and `NarrativeRender` receive full derived
world state; `ActorProposalSource` returns commit candidates; `PlayerTurnRender`
receives branch/commit/actor/source identity; `PlayerCanonResolver` receives the
fully constructed scoped proposal; compiler `promptTransform` may rewrite the
complete compiler prompt; and low-level `PiAgentSessionOptions` may add tools or
replace the system prompt. Inputs are cloned/frozen and structured callback
outputs are schema checked where the host consumes them as world candidates,
but arbitrary host code can always use its closure to access more data. These
interfaces therefore require trusted implementations.

Evidence: [runtime.ts](../src/world/runtime.ts),
[player-action.ts](../src/world/player-action.ts),
[batches.ts](../src/compiler/batches.ts),
[pi-session.ts](../src/agent/pi-session.ts), and mutation/output regression
tests in [world-runtime.test.ts](../test/world-runtime.test.ts) and
[player-action.test.ts](../test/player-action.test.ts).

## 1. TUI startup and ordinary assistant injection

### System prompt contents

`buildSystemPrompt` admits only these application-controlled sections:

- the hard-coded NWH evidence/proposal/commit rules;
- a machine-readable `nwh-context-contract` containing the selected mode,
  trust classes, disabled Pi resources, active tool names, tool authority and
  lifecycle policy;
- project instruction files explicitly named in
  `project.instructions`;
- an explicit host-supplied mode appendix.

If a trusted low-level caller supplies `systemPromptOverride`, it replaces the
hard-coded base and the contract/project instructions/appendix are appended.
The application prompt tells the model to use workspace-relative paths and does
not serialize the root. Pi itself appends an absolute current-working-directory
line after accepting a custom prompt, so an always-on hidden privacy extension
runs last at `before_agent_start` and redacts that root from the fully assembled
provider-bound system prompt. That interceptor is also installed in nested
player/narrator sessions where the domain/workflow NWH extension is disabled.
Provider credentials and API keys are given to Pi's runtime, not serialized
into the prompt.

Evidence: `buildNwhContextContract`, `buildSystemPrompt`,
`createNwhPromptPrivacyExtension`, and `createModelRuntime` in
[pi-session.ts](../src/agent/pi-session.ts), config validation in
[schema.ts](../src/config/schema.ts), and the intermediate- and final-prompt
path tests in [pi-session.test.ts](../test/pi-session.test.ts).

### Trusted project instructions

Project prose is trusted only after explicit configuration. The loader:

- accepts at most eight workspace-relative paths;
- loads at most 64,000 total characters and fails rather than silently
  truncating instructions;
- applies UTF-8, binary, real-path, workspace-containment, and sensitive-path
  checks;
- compares real paths against every registered novel source and rejects a
  source/instruction collision.

The inverse check runs during CLI ingest and TUI path ingest, so a configured
instruction file cannot later be registered as novel evidence through a normal
workflow. No conventional filename such as `NOVEL.md`, `AGENTS.md`, or
`.novel-harness/instructions.md` is implicitly trusted by NWH.

Evidence: `loadProjectInstructions` in
[pi-session.ts](../src/agent/pi-session.ts),
`assertSourceIsNotProjectInstruction` in
[instruction-trust.ts](../src/workspace/instruction-trust.ts), call sites in
[ingest.ts](../src/commands/ingest.ts) and
[source-loop.ts](../src/compiler/source-loop.ts), and instruction/source tests
in [pi-session.test.ts](../test/pi-session.test.ts),
[ingest.test.ts](../test/ingest.test.ts), and
[source-loop.test.ts](../test/source-loop.test.ts).

### Harness/Pi capability injection

Session initialization sets the project as untrusted and disables Pi extension
discovery, skills, prompt templates, themes, context files, and built-in model
tools. NWH then supplies only the explicitly assembled custom tools. The
ordinary set is `list_files`, `search_files`, and `read_file`; the hidden NWH
extension contributes only its separately classified metadata/workflow
capabilities. Pi tool schemas, descriptions, and prompt guidelines are part of
the provider context, and their exact names/authority are repeated in the
context contract.

The filesystem tools are read-only. They enforce real-path containment, reject
symlink escape, exclude harness state, Git internals, dependencies/build output,
common credential directories/files and private-key extensions, require valid
UTF-8, and cap list/search/read results. This is a concrete denylist and size
boundary, not a claim of general secret-content detection.

Evidence: session resource and tool assembly in
[pi-session.ts](../src/agent/pi-session.ts), filesystem enforcement in
[local-files.ts](../src/workspace/local-files.ts), and
[local-files.test.ts](../test/local-files.test.ts).

### User prompts and attachments

Ordinary user text is untrusted user content. Only an explicit `@path` in that
text creates an attachment. Expansion reuses the safe workspace reader, allows
at most eight files and 128,000 attachment characters, escapes tag attributes,
and embeds file contents as a JSON string. `promptJson` escapes angle brackets
while preserving valid JSON, so source text cannot manufacture the surrounding
XML-like control delimiters.

Automatic compiler turns disable generic attachment expansion because it
would bypass their selected source slice. Explicit standalone manual compiler
conversation retains ordinary file attachment behavior by design.

Evidence: [file-mentions.ts](../src/agent/file-mentions.ts),
[prompt-data.ts](../src/util/prompt-data.ts), the `input` and
`before_agent_start` hooks in [nwh-extension.ts](../src/agent/nwh-extension.ts),
and attachment/delimiter tests in [nwh-extension.test.ts](../test/nwh-extension.test.ts)
and [compiler-batches.test.ts](../test/compiler-batches.test.ts).

### Startup restoration is host state, not general-assistant context

Continuing a session restores its Pi transcript. Restoring a saved playable
world loads and validates the host-side `PlaySessionStore` selection; while
player mode is active, ordinary input is intercepted before the general model.
Scene narration and action translation then run in fresh restricted child
sessions. `nwh-play` and `nwh-narrator` entries are durable display records but
are removed from the general assistant's later model context. New player/scene
text is also recorded in a separate branch/commit-scoped `PlayConversationStore`.
Only its latest ten authority-labelled records enter runtime role prompts; the
complete lineage-safe archive is reachable solely through the bounded
related-message tools. This presentation log is never used to project state or
knowledge and does not retroactively promote legacy display transcripts to
world truth.

Fresh role entry has a second display-only record. At the novel opening,
`InitialWorld.readerSetup` gives an unread human a concise source-grounded,
spoiler-free orientation to where, when, who, the needed premise, and the
immediate unresolved situation. `InitialWorld.participantPresence` separately
proves that an actionable opening role is bodily present. For a later role,
`ReaderEntryContext` lists
every canonical event presented in source discourse before the selected
character's grounded entry checkpoint, including its source-grounded completed-
event recap, named participants, narrative mode/time, and known causal-parent
titles. A later role is not offered if any preceding recap is missing. The
TUI/compact command prints it as
“故事前情” before the first scene when prior beats exist and omits the
empty recap at the novel opening. Player-visible copy never explains this
knowledge boundary or names its internal representation. It is not a `KnowledgeDelta`,
is not persisted as an actor observation, and is not included in narrator,
player-action, adjudicator, NPC, or world-response model frames. A later-role
genesis separately applies deterministic initial/main-timeline effects before
the checkpoint and then only the checkpoint's already-true state/knowledge,
physical presence, and direct actor observation. The reader setup does not enter
that actor observation, and the target entry event remains unrealized. Thus
reader orientation, character knowledge, actor perception, and branch truth are
separate channels.

Evidence: startup/session construction in [play.ts](../src/commands/play.ts)
and [pi-session.ts](../src/agent/pi-session.ts), player interception and
restoration in [nwh-extension.ts](../src/agent/nwh-extension.ts), entry derivation
in [entry-context.ts](../src/world/entry-context.ts), and regressions in
[nwh-extension.test.ts](../test/nwh-extension.test.ts),
[entry-context.test.ts](../test/entry-context.test.ts), and
[character-entry-play.test.ts](../test/character-entry-play.test.ts).

## 2. Novel parsing and compiler injection

### Source identity and segmentation

Ingest archives immutable content-addressed bytes. Before compilation,
`segmentSource` re-reads those bytes, verifies the source SHA-256, rejects empty,
binary, or invalid UTF-8 data, and derives bounded segments by lines, bytes,
and serialized prompt size. A single long physical line is split only at UTF-8
code-point boundaries. Each segment contains source ID/path, byte/line range,
text hash, ordinal and optional heading.

Built-in Markdown, Chinese, and English heading forms remain deterministic. If a
longer source has no recognized section structure, NWH schedules a preliminary
structure-discovery batch containing JSON-escaped line windows near the start,
quarter points, middle, and end plus a bounded set of isolated short-line
candidates. That sample is non-citable and exposes only
`configure_chapter_split` and `finish_compiler_batch`. The model can retain the
builtin fallback or propose a declarative literal-prefix / number-style /
literal-suffix matcher with exact sampled examples. It cannot provide executable
code or regex. The host applies the matcher to immutable source lines, rejects
non-sample examples, long or overly broad matches, and writes the plan and new
manifest only at successful finish. The plan is source-hash-bound and included
in prepared revisions.

The evidence safety limit is 96 KiB / 1,000 lines per segment. Continuation
segments belonging to the same detected author chapter can be joined into one
batch up to eight segments and 128 KiB of both source bytes and serialized source
characters. Grouping never crosses a detected chapter boundary.

Every segment-manifest field can affect model context, including headings and
line ranges. `prepareCompilerBatches` therefore recomputes the whole manifest
from immutable bytes and uses deep equality, not only schema validity or slice
hashes, before constructing a prompt. `beginBatch` repeats this check and
captures cloned selected-segment metadata before the model turn, preventing a
persisted-manifest change from widening the live evidence boundary.

Evidence: [chapter-split.ts](../src/compiler/chapter-split.ts), [segments.ts](../src/compiler/segments.ts),
`prepareCompilerBatches` in [batches.ts](../src/compiler/batches.ts),
`beginBatch` in [proposal-tools.ts](../src/compiler/proposal-tools.ts), and
regressions in [segments.test.ts](../test/segments.test.ts),
[chapter-split.test.ts](../test/chapter-split.test.ts), [compiler-batches.test.ts](../test/compiler-batches.test.ts), and
[proposal-tools.test.ts](../test/proposal-tools.test.ts).

### Ordinary source-batch payload

For each automated source batch the model receives:

- the compiler system prompt and current compiler-turn contract;
- one or more selected source segments, each JSON-encoded with its exact whole
  `EvidenceRef`;
- source ID and relative/content source path, batch/segment IDs, chapter
  metadata, and extraction policy;
- a bounded source-owned identity/index catalog for existing canonical and
  pending entities, claims, events, rules, initial world, goals, character
  models and possibilities;
- exact active proposal IDs for retry recovery.

It does **not** receive ordinary assistant conversation, project instructions,
player/narrator transcript, generic workspace reads, raw staging deltas, or
whole-source evidence retrieval. The current hidden compiler boundary replaces
the model system prompt for that turn; if a compiler turn is active without its
host evidence boundary, context projection returns an empty history rather
than falling back to unrelated conversation.

Evidence: prompt construction/hydration in
[batches.ts](../src/compiler/batches.ts), `before_agent_start` and tool-scope
selection in [nwh-extension.ts](../src/agent/nwh-extension.ts), fail-closed
projection in [context-policy.ts](../src/agent/context-policy.ts), and tests in
[compiler-batches.test.ts](../test/compiler-batches.test.ts),
[nwh-extension.test.ts](../test/nwh-extension.test.ts), and
[context-policy.test.ts](../test/context-policy.test.ts).

### Opening-world payload

The opening pass receives the selected narrative-opening segment, its exact
evidence reference, source-owned prior artifacts, and additional temporal
checkpoint instructions. Its active tool set is restricted to exact artifact
lookup/read, entity, claim and initial-world proposal, withdrawal, and finish.
It cannot use whole-source raw retrieval or propose unrelated events/rules/goals.
The same selected-segment containment check rejects a later-chapter evidence
reference. A deterministic fallback may create only an evidence-backed opening
cast after an incomplete model pass; it still enters the normal proposal and
validation flow.

Evidence: `prepareOpeningWorldCompilerBatch` and
`proposeMinimalOpeningWorld` in [batches.ts](../src/compiler/batches.ts),
`compilerToolNamesForScope` and preparation orchestration in
[nwh-extension.ts](../src/agent/nwh-extension.ts), CLI orchestration in
[prepare-all.ts](../src/commands/prepare-all.ts), and opening-pass tests in
[compiler-batches.test.ts](../test/compiler-batches.test.ts) and
[nwh-extension.test.ts](../test/nwh-extension.test.ts).

### Whole-world reconciliation payload

Reconciliation is the one compiler role that can inspect the complete selected
novel through exact retrieval. Its initial prompt is a source-exclusive,
200,000-character-bounded audit/index containing bounded semantic issues,
coverage, entity/claim/event indexes, weak event/character targets and opening
metadata. It exposes no generic local file tool.

`find_source_evidence`/`read_source_evidence` bind to one active `sourceId`,
rederive and deep-compare the source segment manifest, return exact text plus
its `EvidenceRef`, and page without splitting Unicode surrogate pairs.
`find_compiler_artifacts`/`read_compiler_artifact` similarly expose only
canonical/pending artifacts whose evidence belongs exclusively to that source.
Compiler retrieval schemas permit up to 200 index results or 120,000 characters
in one requested page while retaining exact offsets and lossless pagination.
Both channels share the compiler tool-call circuit breaker.

Evidence: [reconcile-world.ts](../src/compiler/reconcile-world.ts),
[source-evidence-retrieval.ts](../src/compiler/source-evidence-retrieval.ts),
[artifact-retrieval.ts](../src/compiler/artifact-retrieval.ts), and tests in
[compiler-source-evidence-retrieval.test.ts](../test/compiler-source-evidence-retrieval.test.ts)
and [compiler-artifact-retrieval.test.ts](../test/compiler-artifact-retrieval.test.ts).

### Proposal and lifecycle authority

Before any typed proposal is persisted, the host strict-schema parses it,
requires source evidence where appropriate, rejects mixed-source artifacts,
checks every evidence span against the captured selected slice, validates
stable revision identity and typed field/reference rules. Successful tool results
expose no capacity counters, and the model is explicitly forbidden from semantic
triage based on execution cost. Host-only runaway safety fuses remain at 800
active proposals and 1,000 tool calls plus one final finish call.
Proposal calls are sequential. `finish_compiler_batch` derives the active set
on the host, validates graph closure and exact segment review, and merely
allows the host to checkpoint the batch. Canonical acceptance is a later
deterministic workflow.

Any standalone session constructed through `createPiCompilerSession` with a
source ID, batch ID, segment IDs, or `includeLocalTools:false` is forced fresh
and in-memory; resuming or explicitly persisting it is rejected. TUI compiler
work intentionally remains visible in the assistant transcript, but the
turn-local projection above supplies only its current hidden evidence boundary.
Together these mechanisms prevent an older evidence scope from entering a new
compiler request.

Evidence: [proposal-tools.ts](../src/compiler/proposal-tools.ts), proposal
service/acceptance in [proposals.ts](../src/compiler/proposals.ts) and
[validator.ts](../src/compiler/validator.ts), lifecycle enforcement in
[pi-compiler.ts](../src/compiler/pi-compiler.ts), and
[proposal-tools.test.ts](../test/proposal-tools.test.ts),
[compiler-batches.test.ts](../test/compiler-batches.test.ts), and
[pi-compiler.test.ts](../test/pi-compiler.test.ts).

### Explicit manual-compiler exception

`nwh compile` without a source/batch/slice scope is an administrator-facing
compiler conversation. It may persist and may use bounded read-only workspace
tools. Source/artifact exact-retrieval tools still reject calls until a source
scope is bound, and typed proposals remain pending and individually evidence
validated, but the conversation itself is not a single-source confidentiality
boundary. Automated `compile-source`, opening, reconciliation, reparse and TUI
compiler jobs must use the isolated lifecycle above.

Evidence: `resolvePiCompilerSessionLifecycle` and the default
`includeLocalTools` behavior in [pi-compiler.ts](../src/compiler/pi-compiler.ts),
source requirements in [source-evidence-retrieval.ts](../src/compiler/source-evidence-retrieval.ts)
and [artifact-retrieval.ts](../src/compiler/artifact-retrieval.ts), and
[pi-compiler.test.ts](../test/pi-compiler.test.ts).

## 3. Parsed world context versus runtime model context

An accepted prepared revision captures a content-addressed host snapshot of
source-owned entities, claims, canonical events, world rules, state schema,
character goals, character models, and possibility templates. The branch pins
that snapshot, its source ID and prepared revision hash. Commits store event and
delta hashes plus the snapshot hash; `WorldState(branch, t)` is replayed from
the commit chain and is not a mutable chat memory.

This complete `WorldModelContext` is used by deterministic host code for
validation, projection, frontier evaluation and actor-view derivation. It is
not serialized wholesale into the player-action or narrator requests.
Source-scoped snapshots reject an artifact collection containing another
novel's evidence. Legacy branches infer a source only when genesis/context
evidence has one unambiguous owner; evidence-bearing multi-source ambiguity
fails closed.

Evidence: snapshot capture/hydration in [context.ts](../src/world/context.ts),
immutable artifact revisions in [canonical-model.ts](../src/world/canonical-model.ts),
branch creation/commit/replay in [engine.ts](../src/world/engine.ts), source
resolution in [source-scope.ts](../src/world/source-scope.ts), and source/world
tests in [player-source-isolation.test.ts](../test/player-source-isolation.test.ts),
[initial-world.test.ts](../test/initial-world.test.ts), and
[world-engine.test.ts](../test/world-engine.test.ts).

Participant membership is not scene presence. New canonical/possibility/event
records may classify character participation as `physical`, `remote`,
`mentioned`, `represented`, `dream`, or `memory`; only `physical` establishes
co-presence. Legacy interactive actor events retain a bounded compatibility
path, while legacy canonical/background flat participant lists fail closed.
Role-entry derivation uses the same embodied-scene rule and additionally requires
a source-backed per-character pre-event checkpoint with actionable actor state.
Thus a signature, letter, report, mention, or outcome-only event cannot become
either a playable checkpoint or a room occupant.

Evidence: presence schema/validation in [model.ts](../src/world/model.ts) and
[engine.ts](../src/world/engine.ts), scene projection in
[scene.ts](../src/world/scene.ts), and regressions in
[scene-presence.test.ts](../test/scene-presence.test.ts) and
[entry-context.test.ts](../test/entry-context.test.ts).

Canonical future events are converted host-side into possibility templates.
The frontier marks them latent, blocked, expired, superseded, invalidated,
realized, or eligible according to committed state, causal parents, source
evidence and temporal compatibility. `current-window` refuses later story
windows without explicit advancement, and unsupported disconnected canon roots
do not all become “now.” Background selection excludes player-only choices and
actor plans.

Evidence: [canon-runtime.ts](../src/world/canon-runtime.ts),
[frontier.ts](../src/world/frontier.ts), and temporal/branch regressions in
[world-runtime.test.ts](../test/world-runtime.test.ts).

## 4. Actual play: player-action context

### Host actor scope

`buildActorScopedActionContext` starts from exactly one committed head and its
pinned source. Its host-side schema contains:

- actor ID and current commit ID;
- actor-visible self state;
- state of currently owned artifacts and actor-owned known relationships;
- acquired source-owned knowledge facts and optional claim semantics;
- present and merely referenceable entity identities;
- writable entity IDs and writable field specifications;
- committed scene label/location/public location state/presence;
- at most eight actor-visible event observations and four scene/plan threads.

It does not contain raw `WorldState`, future canonical events, the frontier,
compiler evidence text, unacquired claims, inactive goals/models, or another
actor's general state.

Evidence: the schema and builder in
[player-action.ts](../src/world/player-action.ts), branch knowledge replay in
[knowledge.ts](../src/world/knowledge.ts), committed-scene derivation in
[scene.ts](../src/world/scene.ts), and the “contains only self state...” test in
[player-action.test.ts](../test/player-action.test.ts).

### State, knowledge, identity, event and time visibility

Every state field is classified `public`, `self`, `owner`, `knowledge`, or
`engine`. Undeclared/custom fields and engine fields fail closed. A
knowledge-gated field becomes visible only through an acquired claim whose
predicate is exactly `state:<field>`; prose predicates are not guessed into
schema authority.

Knowledge is reconstructed from committed `KnowledgeDelta` history for the
selected actor. Event participation permits an observation but never reveals
the omniscient event title; only an explicit actor observation is used,
otherwise the actor receives a neutral summary. Scene presence is derived from
committed history and location, not from a model's name mention.

Co-location also does not prove identity knowledge. A present but unknown
identity is exposed as `Unidentified <kind> N`; canonical names are used only
for self, owner-visible references or acquired knowledge. The host scope has
commit step and story time for deterministic work, but the translator view
removes commit ID, event steps, scene beat and event dates. Time crosses the
model boundary only if it is already an actor-visible state value or acquired
claim.

Evidence: [actor-visible.ts](../src/world/actor-visible.ts),
[knowledge.ts](../src/world/knowledge.ts), `observeCommittedEvent` and scene
projection in [scene.ts](../src/world/scene.ts), callback projection/anonymity
in [player-action.ts](../src/world/player-action.ts), and
[actor-visible.test.ts](../test/actor-visible.test.ts) plus identity/time tests
in [player-action.test.ts](../test/player-action.test.ts).

### Built-in Pi action boundary

The public translator callback receives the already-safe stable actor scope,
as a frozen clone. The built-in Pi adapter then removes host-only chronology
and replaces every admitted entity/claim ID, including references nested in
state and claims, with turn-local handles such as `actor-self`, `entity-001`
and `claim-001`. Only the host retains the reverse map. If the model submits an
admitted stable ID directly instead of its supplied handle, decoding replaces
it with a guaranteed-invalid sentinel; a guessed hidden world ID remains
outside the referenceable set and is rejected.

The initial projection is capped at 32,000 characters. Required actor, state,
scene and capability sections must fit or the turn fails visibly. Optional
records are relevance-ranked, omissions are declared in `contextCoverage`, and
two exact tools search/page only the complete already-safe corpus. The corpus
has record/serialized-size and retrieval-call circuit breakers.

The nested Pi session is fresh/in-memory, excludes project instructions,
local tools and the domain/workflow NWH extension (the prompt-path privacy
interceptor remains), and has only actor-context retrieval plus one capture-only
`propose_player_action`. The untrusted result cannot supply
branch, parent commit, source, actor authority, event identity, time, causal
ancestry, evidence or commitment status.

Evidence: [pi-player-action.ts](../src/agent/pi-player-action.ts), opaque
mapping/decoding in [player-action.ts](../src/world/player-action.ts), bounded
retrieval in [actor-context-retrieval.ts](../src/agent/actor-context-retrieval.ts),
capture schema in [player-action-tool.ts](../src/agent/player-action-tool.ts),
and [player-action.test.ts](../test/player-action.test.ts) plus
[actor-context-retrieval.test.ts](../test/actor-context-retrieval.test.ts).

### Return path and commit authority

The host strict-schema parses the captured typed intent without reparsing the
utterance. The typed intent distinguishes the actor-controlled act from a
desired effect that depends on the world. A separate fresh world-adjudication
session receives the relevant
current committed state, applicable active rules, and deterministic preview
issues but no future canon. It must propose either ordinary realization or a
direct-contradiction transformation. Transformations carry a certificate citing
an existing state field, applicable active rule, exact preview issue, or explicit
ordinary causal/capability principle; host code verifies every checkable citation.
The proposed consequence is then subjected to the same reference/write scope,
actor-visible predicate grounding, physical co-location, knowledge authority,
world-rule, invariant, time, and optimistic parent-head checks. Open destinations
use described targets and branch-local structural scene IDs rather than guessed
canonical IDs or labels recovered from text. A canon resolver receives an
immutable proposal snapshot and its result is strict-schema parsed. Only
`commitKnowledgeAwareAction`/the engine can append the event and move the branch
head.

If the adjudicator returns no valid capture, its adapter retries once with a new
in-memory session. A repeated protocol miss does not turn desired-effect prose
into truth. The host can commit only its own write-free current-scene
observe/stay primitive when all deterministic checks are already clean; the
model-authored controlled-act copy and desired effect remain audit evidence.
Every other miss leaves the branch head unchanged, and none can add character
knowledge or world rules.

Evidence: `PlayerTurnService` and validation functions in
[player-action.ts](../src/world/player-action.ts), the isolated adapter in
[pi-player-world-adjudicator.ts](../src/agent/pi-player-world-adjudicator.ts),
the capture-only schema in
[player-world-outcome-tool.ts](../src/agent/player-world-outcome-tool.ts), engine
validation in [engine.ts](../src/world/engine.ts), and regressions in
[player-action.test.ts](../test/player-action.test.ts),
[player-world-outcome-tool.test.ts](../test/player-world-outcome-tool.test.ts),
and [world-engine.test.ts](../test/world-engine.test.ts).

## 5. Actual play: scene-narrator context

### Host frame versus model frame

`buildPlayOpeningFrame` constructs a rich host frame containing branch/commit
identity, logical/story time, elapsed days, stable actor/entity/claim IDs,
actor-visible state and knowledge, committed visible events, scene key/beat/
signature, derived development, current effective character policy,
host-internal threads and preflighted affordances. The host frame retains those
affordances for internal direction, post-narration UI assembly, and low-level
callers; they are not copied into the scene model input.

`playerSceneModelFrame` is the only narrator callback/model projection. It
contains exactly:

- actor name;
- visible self state with admitted entity references replaced by names;
- visible age/life stage and committed experience summaries, without event or
  commit IDs/times;
- named owned entities and visible state;
- acquired claim semantics expressed through names, without claim IDs;
- named present and referenceable identities;
- actor-visible event titles without steps/dates;
- scene label/public location state and actor-visible public threads;
- effective current-head traits, decision biases, and active goal descriptions
  as non-factual behavioral guidance used only to shape plausible alternatives;
- an optional actor-visible blocked/recovery summary.

It omits branch/commit/event hashes, logical steps, host story time and elapsed
duration, stable entity/claim IDs, scene key/beat/signature, evidence refs,
candidate deltas, knowledge authorization, scores, internal thread/progress
IDs, all public/internal affordance copy, inactive goals/model phases, and future
canon effects. Prompts forbid exposing the behavioral-guidance metadata or using
it as evidence for narration.

Evidence: the two frame types and `playerSceneModelFrame` in
[play-opening.ts](../src/world/play-opening.ts), public projection helpers in
[narrative-director.ts](../src/world/narrative-director.ts) and
[development.ts](../src/world/development.ts), and frame tests in
[play-opening.test.ts](../test/play-opening.test.ts) and
[pi-player-opening.test.ts](../test/pi-player-opening.test.ts).

### Future canon, actor policy, and affordance handling

The deterministic scene director may use an eligible canon analogue or an
active compiler-authored goal as host-only ranking pressure. `publicNarrativeThread`
drops both `canon-pressure` and `goal` threads. Canon-analogue deltas are never
materialized as a player-facing action. Every public affordance removes its
candidate delta, authorized claims, progress object, score and internal IDs;
the executable candidate stays on the host and is preflighted through the same
scope/knowledge/engine gates as free-form input.

The scene narrator does not receive those generic affordances. Instead it
receives only the actor's effective current-head
disposition and active motivations alongside actor-visible scene data, then
suggests concrete acts or exact spoken lines. This does not turn policy into
world truth: inactive/future phases stay excluded, the guidance may not be
stated in prose, and a suggestion has no capability status until the player
selects it and the ordinary translator and deterministic gates accept it. After
the narrator returns, the host merges bounded public action text from the
retained, preflighted affordances into the selector. Hidden deltas, claims,
scores, progress metadata, and internal IDs still never enter the narrator. A
selected host route is re-resolved by its opaque ID at the current head and must
pass the normal deterministic gates; stale routes fail closed.

Narration and suggestions are separate inference sessions and output channels.
The choice specialist owns `propose_player_choices`; the final narrator never
receives that tool. Host validation enforces broad narration limits, repeated-
paragraph rejection, exact locked-dialogue preservation, and structural choice
shape/count/distinctness. It does not search Chinese or English prose for
semantic handoff phrases. This keeps style guidance in the model layer instead
of turning a fixed vocabulary into world or rendering authority.

Evidence: `buildNarrativeDirection`, `addCanonicalAffordances`,
`publicNarrativeThread`, and `publicPlayerAffordance` in
[narrative-director.ts](../src/world/narrative-director.ts), with regressions in
[narrative-director.test.ts](../test/narrative-director.test.ts).

### Built-in Pi literary fan-out and return path

The scene path uses fresh, in-memory Pi sessions with no project guidance,
local files, compiler tools, domain/workflow NWH extension, ordinary Pi
transcript, or arbitrary future canon. Three private specialists run in
parallel. The choice specialist sees actor-safe current context but no source
excerpts and owns the one choice-capture tool. The style specialist sees only
the exact resolved wording, style-only source excerpts, and presentation-only
play prose, then captures a bounded style analysis. The dramaturgy specialist
sees actor-safe committed results and play continuity but no source prose, then
captures a bounded immediate-beat analysis. These calls do not stream into the
player UI and their sessions are never joined as conversation history.

The final narrator runs in a fourth fresh session. It receives the actor-safe
committed frame, resolved requested-versus-actual act, narrator-safe exact
source excerpts, exact play continuity, and whichever bounded specialist
analyses succeeded. The authority order is explicit: committed state and
outcomes, then exact locked wording, then style-only source prose, then
presentation-only play prose, then advisory analysis. Its only tools retrieve
records from the already actor-safe frame and actor/branch-safe message archive;
it has no choice, analysis, proposal, file, or commit tool.

Narrator-safe source retrieval is separate from compiler evidence search. It
starts only from evidence attached to actor-visible committed events, verifies
immutable quote hashes and bounds, crops oversized evidence around a literal
safe anchor, rejects excerpts naming unavailable source-owned identities, and
applies per-reference/count/total limits. Storage coordinates and source IDs are
replaced by opaque turn-local references before the model boundary. Excerpts
are optional and have `style-only` authority: they can guide syntax, diction,
cadence, tone, and narrative distance but cannot activate canon or establish a
current fact.

Player and NPC speech is also recorded as exact `spokenUtterances` on committed
events, independently of semantic actor observations and knowledge transfer.
The resolved-act packet identifies these as locked wording. A turn draft that
omits or changes a locked utterance is invalid.

The structural choice schema accepts only 2-4 distinct action-only objects; it
does not classify their natural-language semantics with a host phrase list.
There is no model-authored label, description, intent, recommendation,
candidate, or outcome field. A missing, malformed, timed-out, or failed private
specialist degrades only that advisory channel and does not discard otherwise
valid final prose.

A structurally invalid final draft gets one retry in a brand-new final-narrator
session with the same immutable fan-in packet, so the rejected draft and its
provider transcript do not enter attempt two and the three specialists do not
run again. The final prompt has no compact 120-350-character target; it asks the
model to develop one immediate beat as literature while broad host limits bound
runaway output. Only final-narrator provider text/events are streamed.

The host merges up to four distinct options, beginning with one current-head
preflighted action, followed by model suggestions and remaining host exits;
free-form input remains available. A custom narrator injected into the TUI
passes the same structural validation. Rendering and all capture tools never
advance the branch; selecting a suggestion starts the separate player-action
interpretation/adjudication/validation path.

Evidence: [pi-player-opening.ts](../src/agent/pi-player-opening.ts),
`playScenePrompt`/`assertPlaySceneNarration` in
[play-opening.ts](../src/world/play-opening.ts), TUI binding in
[nwh-extension.ts](../src/agent/nwh-extension.ts), and tests in
[pi-player-opening.test.ts](../test/pi-player-opening.test.ts),
[narrative-source.test.ts](../test/narrative-source.test.ts),
[player-scene-choice-tool.test.ts](../test/player-scene-choice-tool.test.ts),
and [nwh-extension.test.ts](../test/nwh-extension.test.ts).

### Material progress without automatic canon scheduling

An accepted event is not counted as material progress merely because it has a
title or progress label. The host checks effective state operations, learned
knowledge, explicit time advance, and a non-`stay` scene transition. Repeated
actor events with none of those effects increase a trailing stagnation depth;
the deterministic director then ranks structural movement, stateful action, and
waiting above another empty exchange. NPC reasoning receives its own bounded
repetition depth and must choose a source-grounded new claim, concrete permitted
decision, refusal/disengagement, or exchange termination instead of paraphrasing
the same answer.

Ordinary turns still schedule zero unrelated canon/background events. The
explicit wait route advances five minutes and opts into at most one currently
eligible autonomous obligation, causal consequence, background pressure,
environmental process, or generated process. Its background allowlist excludes
canon analogues and stays in the current temporal window. If none is eligible,
the committed five-minute time advance still constitutes material progress. A
pressure remains subject to its compiled conditions, source scope, and engine
validation. This permits autonomous world motion while preserving the invariant
that future canon is a possibility frontier rather than an active branch
scheduler.

Evidence: progress certification in [player-action.ts](../src/world/player-action.ts),
stagnation-aware direction in [narrative-director.ts](../src/world/narrative-director.ts),
wait execution in [play-experience.ts](../src/world/play-experience.ts), and NPC
repetition policy in [npc-reaction.ts](../src/world/npc-reaction.ts), with
regressions in [open-world-progression.test.ts](../test/open-world-progression.test.ts)
and [pi-npc-reaction.test.ts](../test/pi-npc-reaction.test.ts).

## 6. Model-driven non-player actors and low-level rendering

`modelActorProposalSource` evaluates all goals/models on the host, selects only
a source-owned currently active and phase-supported goal, projects committed
development, and gives the reasoner opaque actor handles. The reasoner sees the
active goal's description/priority and only referenceable target handles; it
does not see goal IDs, activation/completion predicates, future goal templates,
canonical event triggers, evidence, inactive model phases, commit/time IDs or
omniscient state. Its input is an immutable clone. Output is strict-schema
parsed, decoded and rechecked through actor scope, grounding and spatial gates
before a host-authored proposal is produced.

Evidence: [model-actor-policy.ts](../src/world/model-actor-policy.ts), goal/model
phase evaluation in [actors.ts](../src/world/actors.ts), development projection
in [development.ts](../src/world/development.ts), and
[model-actor-policy.test.ts](../test/model-actor-policy.test.ts).

`NarrativeRenderer` is a lower-level rendering API, not the TUI Pi narrator.
Actor POV supplies only actor-visible state/knowledge and neutral/explicit
event observations, removes the actor ID from adapter style, freezes the frame,
requires a string result, and checks the branch head before and after rendering.
Explicit omniscient POV intentionally supplies full state and committed history
and must be treated as a trusted diagnostic boundary. The separate
`WorldRuntime` render callback is likewise a full-state host-authority API: its
snapshot is immutable, its result must be a string or `undefined`, and a stale
or changed branch head aborts the call. `PlayerTurnRender` receives only frozen
branch/commit/actor/source identity, requires a string, and has the same
before/after branch-head check.

Evidence: [narrative.ts](../src/world/narrative.ts),
[runtime.ts](../src/world/runtime.ts), [player-action.ts](../src/world/player-action.ts),
[narrative.test.ts](../test/narrative.test.ts), and
[world-runtime.test.ts](../test/world-runtime.test.ts).

## 7. Transcript continuation, compaction, and tree summaries

Every persisted session is pinned to `assistant` or `compiler` mode with an
NWH marker. Reopening in the other mode is rejected. An old unmarked transcript
containing any model-visible or private history also fails closed because its
role cannot be inferred safely; an empty legacy session may receive a marker.

`context-policy.ts` treats compiler boundary/result spans as turn-local and
`nwh-play`/`nwh-narrator` as display-only. It removes them from:

- every live provider context;
- both history and turn-prefix inputs to compaction;
- raw entries supplied to branch/tree summarization.

Both Pi persistence shapes, `custom_message` and native-stream `custom`, are
recognized. Each safe compaction/tree summary receives a persisted policy-v2
marker. If a session ever contained private NWH entries, an unmarked legacy
compaction or current branch summary is discarded instead of being trusted as
already sanitized. A current compiler turn without its host boundary returns
no prior transcript.

Evidence: role binding in [pi-session.ts](../src/agent/pi-session.ts), policy
implementation in [context-policy.ts](../src/agent/context-policy.ts), Pi hooks
in [nwh-extension.ts](../src/agent/nwh-extension.ts), and exhaustive regression
coverage in [context-policy.test.ts](../test/context-policy.test.ts),
[pi-session.test.ts](../test/pi-session.test.ts), and
[nwh-extension.test.ts](../test/nwh-extension.test.ts).

## Resolved findings

| Finding | Implemented repair | Code evidence | Regression evidence |
| --- | --- | --- | --- |
| Conventional project files could be confused with instructions or novel data | explicit instruction allowlist, real-path source collision checks in both workflow directions | [pi-session.ts](../src/agent/pi-session.ts), [instruction-trust.ts](../src/workspace/instruction-trust.ts) | [pi-session.test.ts](../test/pi-session.test.ts), [ingest.test.ts](../test/ingest.test.ts) |
| Pi could discover unrelated extensions/resources/tools | all ambient resources and built-in model tools disabled; exact custom tool contract injected | [pi-session.ts](../src/agent/pi-session.ts) | [pi-session.test.ts](../test/pi-session.test.ts) |
| Pi's fully assembled prompt disclosed the absolute workspace path | root removed from the application prompt and Pi's appended cwd redacted by a last, always-on `before_agent_start` privacy interceptor | [pi-session.ts](../src/agent/pi-session.ts) | [pi-session.test.ts](../test/pi-session.test.ts) |
| File/source strings could imitate prompt delimiters | JSON serialization escapes angle brackets and attachment attributes | [prompt-data.ts](../src/util/prompt-data.ts), [file-mentions.ts](../src/agent/file-mentions.ts) | [compiler-batches.test.ts](../test/compiler-batches.test.ts), [nwh-extension.test.ts](../test/nwh-extension.test.ts) |
| Compiler spans could leak into later assistant turns or summaries | live, compaction and tree projections plus persistent summary markers | [context-policy.ts](../src/agent/context-policy.ts), [nwh-extension.ts](../src/agent/nwh-extension.ts) | [context-policy.test.ts](../test/context-policy.test.ts) |
| A transcript could be reopened under a different authority role | persisted role pin; ambiguous unmarked legacy transcripts rejected | [pi-session.ts](../src/agent/pi-session.ts) | [pi-session.test.ts](../test/pi-session.test.ts) |
| Missing current compiler boundary could fall back to ordinary chat history | active compiler context now fails closed to an empty projection | [context-policy.ts](../src/agent/context-policy.ts) | [context-policy.test.ts](../test/context-policy.test.ts) |
| Model-generated split code or a broad pattern could execute against the novel | no code/regex input; a literal declarative DSL, exact sampled examples, whole-source match limits, source-hash/version binding, and finish-time persistence | [chapter-split.ts](../src/compiler/chapter-split.ts), [proposal-tools.ts](../src/compiler/proposal-tools.ts) | [chapter-split.test.ts](../test/chapter-split.test.ts) |
| Persisted/stale segment metadata could widen or mislabel evidence | full manifest rederivation/deep equality and captured live slice | [segments.ts](../src/compiler/segments.ts), [batches.ts](../src/compiler/batches.ts), [proposal-tools.ts](../src/compiler/proposal-tools.ts) | [segments.test.ts](../test/segments.test.ts), [proposal-tools.test.ts](../test/proposal-tools.test.ts) |
| Whole-world compiler retrieval could cross novels | active-source binding and source-exclusive artifact/evidence checks | [source-evidence-retrieval.ts](../src/compiler/source-evidence-retrieval.ts), [artifact-retrieval.ts](../src/compiler/artifact-retrieval.ts) | [compiler-source-evidence-retrieval.test.ts](../test/compiler-source-evidence-retrieval.test.ts), [compiler-artifact-retrieval.test.ts](../test/compiler-artifact-retrieval.test.ts) |
| Scoped compiler jobs could inherit or persist a differently scoped transcript | source/batch/slice jobs forced fresh and ephemeral | [pi-compiler.ts](../src/compiler/pi-compiler.ts) | [pi-compiler.test.ts](../test/pi-compiler.test.ts) |
| Runtime branch could silently mix parsed novels | source-owned snapshots/branches, commit evidence checks, fail-closed legacy inference | [context.ts](../src/world/context.ts), [source-scope.ts](../src/world/source-scope.ts), [engine.ts](../src/world/engine.ts) | [player-source-isolation.test.ts](../test/player-source-isolation.test.ts), [initial-world.test.ts](../test/initial-world.test.ts) |
| An unread player lacked opening/prior-story orientation, while giving it to the actor would leak knowledge | display-only spoiler-free opening setup plus complete prior-discourse recaps; actor knowledge and model frames remain unchanged | [initial.ts](../src/world/initial.ts), [entry-context.ts](../src/world/entry-context.ts), [play-choice.ts](../src/world/play-choice.ts) | [entry-context.test.ts](../test/entry-context.test.ts), [character-entry-play.test.ts](../test/character-entry-play.test.ts) |
| A supporting character could start before appearing, or a mentioned/represented character could look co-present | grounded per-character entry checkpoints plus explicit participation mode; later entry creates a sibling branch and flat legacy background presence fails closed | [entry-context.ts](../src/world/entry-context.ts), [scene.ts](../src/world/scene.ts), [instance.ts](../src/world/instance.ts) | [character-entry-play.test.ts](../test/character-entry-play.test.ts), [scene-presence.test.ts](../test/scene-presence.test.ts) |
| Valid no-op dialogue could loop forever while optional narrator choices removed every exit | material-progress/stagnation certificates, retained preflighted host actions, explicit bounded wait pressure, and NPC repetition policy | [player-action.ts](../src/world/player-action.ts), [narrative-director.ts](../src/world/narrative-director.ts), [nwh-extension.ts](../src/agent/nwh-extension.ts), [npc-reaction.ts](../src/world/npc-reaction.ts) | [open-world-progression.test.ts](../test/open-world-progression.test.ts), [nwh-extension.test.ts](../test/nwh-extension.test.ts), [pi-npc-reaction.test.ts](../test/pi-npc-reaction.test.ts) |
| Player model could receive hidden state, future canon, stable IDs or engine chronology | state/knowledge/source projection, anonymous identities, opaque handles, chronology stripping and bounded safe retrieval | [actor-visible.ts](../src/world/actor-visible.ts), [player-action.ts](../src/world/player-action.ts), [actor-context-retrieval.ts](../src/agent/actor-context-retrieval.ts) | [actor-visible.test.ts](../test/actor-visible.test.ts), [player-action.test.ts](../test/player-action.test.ts), [actor-context-retrieval.test.ts](../test/actor-context-retrieval.test.ts) |
| Narrator could receive host frame IDs/time, inactive/future policy, affordance copy, or an arbitrary replacement record | typed name-based narrator frame; only current effective disposition/active motivation is admitted as non-factual choice guidance; no affordances or third prompt override | [play-opening.ts](../src/world/play-opening.ts), [narrative-director.ts](../src/world/narrative-director.ts) | [play-opening.test.ts](../test/play-opening.test.ts), [pi-player-opening.test.ts](../test/pi-player-opening.test.ts) |
| Rejected narrator attempt could contaminate retry | independent in-memory session per attempt | [pi-player-opening.ts](../src/agent/pi-player-opening.ts) | [pi-player-opening.test.ts](../test/pi-player-opening.test.ts), [nwh-extension.test.ts](../test/nwh-extension.test.ts) |
| Model actor could see inactive future goals/model phases or submit stable IDs | host phase activation, minimal active policy view, opaque handles and player capability gates | [model-actor-policy.ts](../src/world/model-actor-policy.ts) | [model-actor-policy.test.ts](../test/model-actor-policy.test.ts) |
| Public callbacks could mutate retained host objects or return unvalidated candidates | immutable snapshots and strict output schemas at candidate/resolver boundaries | [immutable.ts](../src/util/immutable.ts), [runtime.ts](../src/world/runtime.ts), [player-action.ts](../src/world/player-action.ts) | [world-runtime.test.ts](../test/world-runtime.test.ts), [player-action.test.ts](../test/player-action.test.ts) |
| General rendering callbacks could return malformed values or move branch truth during rendering | runtime return-type checks plus stale/pre-post branch-head checks reject the render result if the supported branch store changed; render inputs remain frozen snapshots | [runtime.ts](../src/world/runtime.ts), [narrative.ts](../src/world/narrative.ts), [player-action.ts](../src/world/player-action.ts) | [world-runtime.test.ts](../test/world-runtime.test.ts), [narrative.test.ts](../test/narrative.test.ts), [player-action.test.ts](../test/player-action.test.ts) |

## Mechanical guarantees versus assurance limits

Mechanically enforced properties are: active tool availability, resource
discovery shutdown, filesystem/path/size bounds, transcript projection, session
role/lifecycle isolation, source/segment identity, source-exclusive artifacts,
state-field visibility, actor knowledge replay, stable-ID opacity in built-in
model adapters, strict candidate schemas, validation order, proposal status,
commit CAS/invariants, and branch-head stability checks around rendering.

The following are explicit limits, not hidden guarantees:

- A probabilistic model can still misunderstand ambiguous literary prose.
  Compiler output remains a proposal because schema/evidence validation cannot
  prove semantic interpretation.
- Prompt injection in novel/tool strings is classified and delimited, but no
  prompt can mathematically force a model to obey. The authority gates ensure a
  disobedient response cannot directly commit canonical or branch truth.
- A narrator may make a semantically unsupported implication in prose. Prose
  is non-authoritative, length/repetition checked, and actor-scoped, but full
  literary factuality needs representative evaluations.
- A pretrained provider may recognize a famous novel from visible names or
  facts. The harness withholds its own future-canon records; it cannot erase
  provider pretraining.
- Explicitly configured project instructions are intentionally trusted and are
  sent to the ordinary assistant. A malicious instruction allowlisted by the
  user has that authority.
- Ordinary read tools are a bounded local workspace capability, not a semantic
  DLP scanner. Files not matching the credential/path denylist may be read when
  the model calls the tool.
- Provider requests necessarily transmit the admitted context to the selected
  provider/custom endpoint. NWH has no model-side network tool, but the provider
  API itself is an external trust decision.
- Trusted host-authority callbacks and explicit omniscient rendering may access
  full truth through their closures or documented inputs. They must not be
  wired directly to an untrusted actor model without an additional projection.
  These callbacks are in-process trusted code, not a sandbox: frozen inputs and
  post-call head checks reject retained-reference or supported-store misuse,
  but cannot undo arbitrary filesystem/process side effects performed through a
  malicious closure.
- The standalone manual compiler conversation is deliberately broader than
  automated source-scoped jobs. It is an administrator boundary, not a proof of
  single-source confidentiality.
- A local operating-system user who can edit runtime/session files remains
  inside the local trust boundary. Content hashes and schemas detect many forms
  of drift, but NWH is not an adversarial filesystem sandbox.

Within those limits, the central architectural claim is code-enforced: no
built-in player, narrator, or model-actor request receives the compiler's full
canon or raw world truth, and no model prose/tool result becomes world truth
without deterministic validation and a committed event.
