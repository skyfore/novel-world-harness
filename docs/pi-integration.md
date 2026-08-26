# Pi integration boundary

Pi remains in the design because it solves the generic agent-runtime problems that Novel World Harness should not reimplement:

- provider and model selection;
- streaming assistant and tool-call events;
- multi-turn agent execution;
- append-only sessions and continuation;
- terminal transcript, editor, tool-call rendering, status, and keyboard interaction;
- thinking-level handling, compaction, and branch/tree summarization hooks.

Novel World Harness owns the parts specific to executable fiction:

- the evidence-first system prompt;
- explicitly configured trusted workspace instruction loading; novel evidence is
  never promoted to instructions by filename;
- safe local list/search/read tools;
- bounded compiler batches, typed proposal semantics, and evidence verification;
- proposal/validation/commit boundaries;
- future canon replay and world invariants.

The previous direct Anthropic SDK implementation coupled the CLI to one provider and duplicated session/tool-loop behavior already available in Pi. The current adapter resolves the configured profile through Pi and can register a custom provider endpoint when `baseUrl` and `apiProtocol` are supplied. Interactive use is hosted by Pi's public `AgentSessionRuntime` and `InteractiveMode`; an NWH inline extension supplies branding, safe local commands, and guarded file mentions.

The pinned Pi package carries a reproducible pnpm patch that adds a generic
TUI-only transient assistant stream for extension-owned child sessions. The
stream is mounted in Pi's transcript rather than an editor widget, uses Pi's
assistant component and Ctrl+T visibility control, and defaults thinking to
live-while-active/auto-collapsed-on-completion. This is presentation state only:
it does not add the child session to the parent model context or relax NWH's
actor-scoped narrator boundary.

“Remove external services” applies to the external persistence layer in Phase 0: PostgreSQL and other attached databases are removed. It does not require removing Pi or forcing the official Claude API. A remote model is still optional infrastructure selected by the user; all harness state and retrieval stay file-based.

For safety, the Pi session disables built-in model coding tools, external
extension discovery, skills, prompt templates, context files and ambient
themes. Ordinary sessions expose only Novel Harness's three custom read-only
local tools. The application system prompt includes an exact capability/trust
contract but not the host's absolute workspace path. Because Pi appends its cwd
after a custom prompt, a last, always-on `before_agent_start` privacy interceptor
also redacts that path from the fully assembled provider-bound prompt, including
isolated player and narrator sessions. Explicit compiler
sessions add typed compiler tools, which can write pending proposal envelopes,
move a defective current-batch envelope to rejected history, and explicitly
finish a validated batch. Automated source/opening turns have no generic
workspace read tools. Whole-world reconciliation uses exact evidence
search/read tools bound to one active source instead. Compiler tools cannot
write arbitrary files, execute a shell as a model tool, access the network as
a tool, accept canonical truth, or commit world state. Repeated unchanged
finish failures terminate the current tool loop without checkpointing the
batch. The TUI's `!command` path is a deliberate user terminal action, not an
agent capability.

Source compiler proposals carry a stable compiler-batch ID. A retry reloads the
batch's pending proposals and receives their exact proposal IDs, so it can repair
or withdraw a defective draft instead of duplicating logical artifacts across
sessions. Ordinary source-review sessions do not expose the initial-world tool;
that singleton is reserved for the dedicated opening pass. `finish_compiler_batch` derives the active proposal
set on the host and only asks the model to account for supplied evidence segments;
this keeps the handshake bounded even for dense chapters. Active drafts are capped
at 24, proposal calls execute sequentially, successful tool results report the
remaining budget, and a 40-call general compiler-tool budget also terminates
proposal loops that keep changing just enough to evade an
identical-failure detector. One additional final finish call is reserved for the
checkpoint protocol. CLI compiler
commands share a workspace lock so interrupted or concurrent invocations cannot
race proposal files. Non-interactive compiler turns have a ten-minute wall-clock
deadline in addition to provider idle timeouts and abort without checkpointing when
that deadline expires. Automated source turns
also omit raw staging-only state deltas, and supplemental opening-state turns are
given the real opening segment and exact EvidenceRef rather than an ungrounded prompt.
An ordinary chapter-bounded source turn may contain several continuation evidence
segments from that same author chapter and may read at most one bounded,
context-only preview from each immediate batch neighbor. That preview deliberately carries no
EvidenceRef and cannot expand the turn's proposal evidence authority. If it
confirms that an artifact crosses the deterministic split, the model records a
non-canonical boundary deferral. The host then schedules a fresh isolated
two-segment calibration batch after ordinary source batches and before proposal
review. Both complete segments are citable only in that pair pass. A pair pass
may replace an earlier partial pending proposal only by first recording a new
same-kind, same-logical-identity candidate; the host then preserves the partial
envelope in rejected history. It cannot rewrite accepted canon.
Hidden `/prepare-all` continuation turns carry their complete evidence payload
directly because Pi custom-message turns do not run ordinary user-prompt hooks.
Artifact catalogs are source-scoped, size-bounded, and hydrated only for the
currently executing batch, so a full-book run does not pre-expand every future prompt.
The bounded catalog is an index rather than a semantic memory boundary: compiler
turns can search source-scoped canonical/pending artifacts and page one exact
payload by stable ref. Reconciliation can likewise search/page exact raw evidence,
but only from its bound source; ordinary source/opening turns cannot use that
whole-source channel. Retrieval calls share the 40-call compiler circuit-breaker
budget. Cross-source lookup and evidence outside a supplied source-batch segment
fail closed.

Any standalone job constructed through `createPiCompilerSession` with a source
ID, compiler-batch ID, segment IDs, or an explicit no-local-tools boundary is
forced into a fresh in-memory session and cannot resume or persist a transcript.
TUI compiler work remains in the human transcript but uses the turn-local
context projection described below. The standalone unscoped `nwh compile`
conversation is the intentional administrator exception: it may persist and
use bounded local reads, while its proposals still remain pending and
evidence-validated.

Player action and narrator sessions are separate in-memory Pi sessions. Each
receives a bounded actor-safe initial projection plus two exact read-only
retrieval tools over the same already-projected corpus and one capture-only tool.
The action boundary replaces stable entity/claim IDs with turn-local opaque
handles and the host decodes them before deterministic validation. Neither
nested session inherits the ordinary transcript, project instructions, local
tools, compiler context, or future canon.

All NWH model-facing tools, including tools in isolated sessions that disable the
main NWH extension, pass through a common failure-recovery boundary. Pi retains
`isError=true` for validation and execution failures, while the host appends a
bounded SOP that names any safe paired discovery tool, distinguishes retrieval
refs from domain IDs, and allows only one retry after a concrete correction.
Single-use, scope, host-repair, and circuit-breaker failures explicitly prohibit
same-turn retries. See `agent-tool-recovery.md` for the development contract.

Persisted sessions are pinned to one NWH context role. Player/narrator entries
are display-only and compiler spans are turn-local; live provider context,
compaction inputs, and branch/tree summarization all use the same projection.
Safe summaries carry a persistent policy marker, and an unmarked legacy
summary or transcript with private history fails closed instead of being
silently reused under a new role.
