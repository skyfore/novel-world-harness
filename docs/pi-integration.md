# Pi integration boundary

Pi remains in the design because it solves the generic agent-runtime problems that Novel World Harness should not reimplement:

- provider and model selection;
- streaming assistant and tool-call events;
- multi-turn agent execution;
- append-only sessions and continuation;
- terminal transcript, editor, tool-call rendering, status, and keyboard interaction;
- thinking-level handling and future compaction support.

Novel World Harness owns the parts specific to executable fiction:

- the evidence-first system prompt;
- trusted `NOVEL.md` and local instruction loading;
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

For safety, the Pi session disables built-in model coding tools and external extension discovery. Ordinary sessions expose only Novel Harness's three custom read-only local tools. Explicit compiler sessions add typed compiler tools, which can write pending proposal envelopes, move a defective current-batch envelope to rejected history, and explicitly finish a validated batch. They cannot write arbitrary files, execute a shell as a model tool, access the network as a tool, accept canonical truth, or commit world state. Repeated unchanged finish failures terminate the current tool loop without checkpointing the batch. The TUI's `!command` path is a deliberate user terminal action, not an agent capability.

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
Hidden `/prepare-all` continuation turns carry their complete evidence payload
directly because Pi custom-message turns do not run ordinary user-prompt hooks.
Artifact catalogs are source-scoped, size-bounded, and hydrated only for the
currently executing batch, so a full-book run does not pre-expand every future prompt.
