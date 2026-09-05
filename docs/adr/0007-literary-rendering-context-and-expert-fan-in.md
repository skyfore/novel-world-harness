# ADR 0007: Literary rendering uses authority-ranked context and isolated expert fan-in

- **Status:** Accepted; narrative-person detail partially superseded by ADR 0008
- **Date:** 2026-08-25
- **Scope:** Player turns, committed dialogue, scene narration, source-prose admission, play continuity, and model-session orchestration

## Context

The runtime already separates player intent translation, world adjudication,
deterministic validation, event commitment, NPC reaction, and narrative
rendering. The old narrator session nevertheless combined two incompatible
jobs: it first generated next-action choices and then wrote the visible scene.
Its prompt also imposed a short 120–350-character target.

That arrangement preserved world safety, but it biased the model toward compact
utility copy. Choice analysis occupied the same provider transcript and
attention budget as the literary result, while event observations retained the
meaning of spoken exchanges but not necessarily their exact wording. A final
narrator also needs different kinds of context with different authority:

1. the user's exact act and words;
2. related source-novel prose, including its syntax, diction, cadence, and tone;
3. exact prose already rendered on the active play branch;
4. the actor-visible committed world result that determines what actually
   happened.

Simply concatenating these records would be unsafe. A requested act is not a
committed result, prior rendering is not world truth, and source prose can
contain future canon. Literary analysis must improve expression without
becoming another mutation path.

## Decision

### 1. Maintain two loops with one authority boundary

The **world-semantic loop** remains authoritative:

```text
exact player act
  -> typed intent proposal
  -> world adjudication
  -> deterministic validation
  -> committed player/NPC/background events
  -> actor-visible state and observations
```

The **literary loop** begins only after that boundary:

```text
authority-ranked narrative packet
  -> isolated choice/style/dramaturgy specialists (parallel)
  -> bounded advisory fan-in
  -> fresh final literary narrator
  -> presentation-only scene prose
```

Neither specialist analyses nor final prose can mutate branch truth. A
narrator suggestion selected by the user re-enters the ordinary player-action
pipeline as untrusted input.

### 2. Inject four explicitly ranked context channels

The final narrator receives the following channels in descending authority:

1. **Committed actor frame.** Actor-visible state, knowledge, present and
   referenceable identities, visible event observations, active pressures, and
   current committed consequences. This is the sole factual authority.
2. **Resolved act.** The exact player utterance is retained as requested wording;
   `actualOutcomes` says what was committed. If they differ, the committed
   outcomes win. Exact committed speech is carried separately as locked
   utterances.
3. **Source prose references.** Exact source bytes are admitted only from
   evidence already attached to actor-visible committed events. They have
   `style-only` authority and may influence grammar, diction, cadence, tone,
   dialogue treatment, and narrative distance, but never current facts or
   future developments.
4. **Play continuity.** Bounded exact player/scene prose from the selected actor,
   branch lineage, and commit ancestry. It preserves local voice, pronouns,
   spatial language, unfinished gestures, and discourse continuity, but remains
   presentation-only memory. Its prior pronouns do not override the host's
   focalized third-person narrative contract.

Specialist output is a fifth, lower-priority advisory layer. The final narrator
must discard any advisory suggestion that conflicts with the four channels.
All strings remain untrusted data rather than instructions.

### 3. Preserve spoken wording in committed history

Committed events may contain `spokenUtterances`, recording speaker,
addressees, audible channel, and exact content. Speaker and addressees must be
character participants and must pass normal entity validation.

This record does not replace `KnowledgeDelta` or actor observations. Knowledge
transfer remains semantic and actor-scoped; `spokenUtterances` exists so replay
and literary rendering do not have to reconstruct dialogue from summaries. A
turn rendering must contain its actor-visible locked utterances verbatim.

### 4. Admit source prose through a narrator-specific safety gate

The narrator never receives compiler-wide source search. Its source-reference
builder:

- reads immutable registered source bytes;
- accepts only evidence attached to actor-visible committed history;
- verifies the evidence quote hash and byte/line bounds;
- limits each excerpt, total characters, and reference count;
- crops oversized spans only around a literal actor-safe anchor;
- omits excerpts that name unavailable source-owned entities;
- replaces storage/source coordinates with opaque turn-local references before
  crossing the model boundary.

Source references are optional and fail closed. Missing literary evidence must
not hide an otherwise valid committed scene.

### 5. Isolate and fan in specialist calls

Three private sessions run concurrently:

- a next-action expert emits only 2–4 capture-only action suggestions;
- a style expert emits a bounded schema covering prose mode, syntax, diction,
  cadence, dialogue handling, continuity cues, and style failures to avoid;
- a dramaturgy expert emits a bounded schema covering pressure, ordered beats,
  sensory anchors, dialogue placement, continuity obligations, closing beat,
  and factual/agency failures to avoid.

They do not share transcripts. Capture tools have no world, file, or commit
capability. An omitted, malformed, timed-out, or failed specialist call degrades
only that advisory channel. It cannot discard valid final prose.

The final narrator runs in a new session with no choice or analysis capture
tools. It receives the authority-ranked packet, successful bounded advisories,
and only actor-safe read-only retrieval. Thus the visible text is composed for
the novel rather than being the compressed residue of tool planning.

### 6. Let literary length follow the beat

The final prompt no longer requests 2–5 compact paragraphs or a 120–350-character
target. It asks for fully shaped image, rhythm, bodily response, subtext,
dialogue, and dramatic pressure while remaining inside one immediate playable
beat. Host validation retains only broad safety limits, a minimum scene floor,
a generous maximum, repeated-paragraph detection, and exact locked-dialogue
preservation.

The prose must still preserve player agency, avoid choice menus, and stop on a
supported present signal. Literary richness does not authorize time advance or
new persistent facts.

### 7. Retry only the final prose boundary

The three specialists run once per scene request. If final prose is structurally
invalid or omits locked dialogue, one fresh final-narrator session receives the
same immutable fan-in packet. It receives neither the rejected draft nor its
provider transcript. Only the final narrator streams player-facing text and
events, so private analysis cannot leak into the UI.

## Consequences

### Positive

- Exact player and NPC lines survive semantic adjudication and can be rendered
  without paraphrase.
- Long-term source style and short-term branch prose continuity have explicit,
  auditable roles.
- World truth remains stronger than requested action, source canon, prior prose,
  and model analysis.
- Choice generation cannot compress or contaminate the final literary session.
- Specialist disagreement is resolved under a deterministic authority order,
  while missing experts fail softly.
- Retry cost is bounded to final composition rather than repeating the entire
  reasoning fan-out.

### Costs

- A normal scene can require four provider calls, although the three specialist
  calls run concurrently.
- Context construction and source admission require additional validation and
  tests.
- Exact dialogue becomes part of the committed event contract and therefore of
  event hashing and replay compatibility.
- Literary quality still needs model/evaluation work; architecture removes a
  compression bias but cannot guarantee excellent prose by schema alone.

## Evaluation direction

Scene evaluations should score factual fidelity and literary realization
separately. At minimum, fixtures should measure exact locked-dialogue recall,
requested-versus-actual outcome handling, future-canon leakage, local prose
continuity, source-sentence copying, agency violations, repeated summary prose,
and specialist-failure degradation.
