# Local-first terminal UI design

NWH keeps source material, compiler state, executable world evidence, committed
history, and terminal sessions under `~/.novel-harness/` (or `NWH_HOME` when
explicitly set). Workspace state is isolated by a stable path identity below
`workspaces/v1/`; exact source bytes are shared by SHA-256 below `sources/v1/`.
Running the CLI does not create `.novel-harness/` in the current project.

## Decision

Phase 0 is a Novel World Harness terminal application backed by Pi. The default interaction deliberately resembles Claude Code rather than a `readline` prompt:

- `nwh` opens a continuously rendered TUI in the current directory;
- `nwh -p "..."` runs one prompt and exits;
- interactive `nwh` and `nwh play` resume the last workspace-local Pi transcript the user opened, using an explicit workspace pointer rather than JSONL `mtime`; a plain `--new-session` starts an unbound Harness transcript without deleting committed world progress, while explicit player-entry commands may attach their selected world to that fresh transcript;
- `--session <id>` resumes one exact saved transcript; NWH prints this exact command after an interactive exit;
- Pi's viewport-based `fullscreen` layout is the default; it opens at the newest transcript content with a fixed editor/status dock, while `--tui-mode regular` remains the terminal-native scrollback fallback;
- `@path` attaches local file context without changing the displayed user message;
- a standalone quoted, unquoted, absolute, or workspace-relative novel path starts
  the durable source compiler loop;
- `/files`, `/search`, and `/read` work without a model request;
- `/prepare-content <text>` archives exact pasted text and starts its compiler loop;
- `/prepare-all [source-id] [branch-id]` completes guided preparation in the current TUI;
- `/reparse --chapters 2,37 --source <id>` (or `/reparse --all`) runs the same revision-safe rebuild service as the CLI, with native novel/chapter selection when flags are omitted;
- `/tasks` brings the current long-running NWH task back to its live foreground panel. A reparse opens there first and shows host lifecycle events, tool calls, provider reasoning activity, and streamed model text. Model prose is visibly marked unverified because only validated proposals can become world truth. `←` or `Esc` collapses the panel without cancelling the request, leaving a compact progress widget below the editor; the panel's cancel key propagates to the nested Pi session, while settled output remains inspectable;
- `/audit [--source <id>]` and `/prepared-cache [list|activate]` expose the same novel diagnostics and prepared-revision lifecycle in the TUI;
- `/novels`, `/instances`, `/characters`, and `/progress` inspect compiled content without a model request;
- `/remove [instance|analysis|all] [target]` provides a confirmed debugging reset: remove one leaf instance, reset only a novel's mutable analysis while preserving its pinned instances, or remove the novel registration plus all owned instances; immutable archived source evidence is retained;
- `/continue [novel] [character]` resumes that novel's latest source-owned instance, `/switch [novel] [instance] [character]` selects another save, and `/create-instance [novel] [instance] [character]` starts a fresh save from the active prepared revision;
- `/play [character] [instance] [novel]` opens height-aware, natively scrolling and filterable instance/character selection (with free-form id/name/alias input); `/world-resume` remains a compatibility alias for durable resume;
- `/scene` asks the isolated narrator to render the current committed moment again without advancing the world;
- only files explicitly listed in `project.instructions` are loaded as trusted
  workspace guidance (the generated default is `NWH.md`);
- novel sources and conventionally named files such as `NOVEL.md` are evidence,
  never implicitly promoted to system instructions; one physical file cannot be
  both a configured instruction and a registered source.

The TUI has a transcript, incremental assistant rendering, explicit tool-call/result rows, a multiline editor, working state, queued messages, a footer, slash-command completion, and keyboard shortcuts. During every main-agent run, an animated NWH owl and randomly rotating phase copy are mounted above the editor from `agent_start` through `agent_settled`; thinking, text streaming, and tool execution receive distinct labels, and shutdown/cancellation always removes the widget. In fullscreen, PageUp/PageDown scroll the transcript, Ctrl+Shift+Up/Down jump between prompts, and Ctrl+Shift+F searches. Pi's native editor owns `↑`/`↓` prompt history, including history restored with a resumed session. Ctrl+O expands tool output and Ctrl+T toggles provider thinking, following Pi's native keybinding and saved-visibility behavior. The first Ctrl+C clears pending input or stops the active model/scene/foreground task and shows a two-second confirmation; the second exits, after which the restored terminal prints the exact current-session resume command. Thinking display defaults to `auto`: the active block remains visible while streaming and collapses on `thinking_end`, with text-start and message-end fallbacks for providers that omit the boundary. Foreground `/reparse` tasks retain only a focused NWH lifecycle/paging shell; their model text, thinking, tools, key hints, and theme use Pi's exported TUI components and the same block-completion behavior. Claude Code is an interaction reference, not a runtime dependency. NWH uses Pi's public `AgentSessionRuntime`, `InteractiveMode`, and TUI components instead of maintaining terminal control sequences itself.

NWH loads a hidden inline extension to supply its header, working/status labels,
safe local commands, and invisible `@path` context attachment. User input is kept
verbatim in the transcript; compiler instructions and evidence slices are added as
non-displayed context. Project or user Pi extensions, skills, prompt templates,
context files, and built-in model coding tools remain disabled.

When a standalone text novel path (`.txt`, `.text`, `.novel`, `.md`, or
`.markdown`) is submitted, the extension deterministically registers and
pre-segments that source. Built-in headings are used directly; a longer source
without recognized headings first receives a bounded, non-citable structure
sample and the narrow `configure_chapter_split` tool. Its safe declarative rule
is validated over immutable source lines and becomes active only after the finish
handshake. The extension then injects the next chapter-bounded evidence batch as
hidden model context, and the dynamic compiler toolset exposes the narrow `propose_*` tools plus
`withdraw_compiler_proposal` and `finish_compiler_batch`. The
first batch starts immediately; `/compile-next` advances the same source after a
successful proposal run and explicit `finish_compiler_batch` handshake. The
automated source and opening turns receive only their host-supplied evidence
slice; they have no repository/workspace read tools or whole-source evidence
tools. A bounded reconciliation pass can search exact raw text only through
tools pinned to its active source ID.

## Retrieval boundary: file search, not RAG

The model receives no automatic workspace dump and there is no embedding
pipeline. Before a source compiler loop begins, it can request three read-only
discovery tools:

1. `list_files`
2. `search_files`
3. `read_file`

`search_files` invokes `rg` with fixed-string, case-insensitive, bounded options. If `rg` is absent, a safe Node scanner provides the same result shape. The usual flow is search first, then read a narrow evidence range.

Tool results and explicit `@path` excerpts are included in the configured model provider request. Local-first therefore means local discovery, policy enforcement, and persistence; it does not mean selected text stays on-device when using a remote model.

Pi's TUI may perform startup model/package/version checks and may obtain an optional `fd` helper for path completion. `PI_OFFLINE=1 nwh` suppresses those startup network operations. It does not turn a configured remote model into an offline model.

The access layer enforces:

- workspace-root and real-path confinement;
- rejection of `..` and symbolic-link escapes;
- exclusion of `.git`, `.novel-harness`, dependency, build, and coverage directories;
- denial of common credential and private-key files;
- UTF-8 text only, 2 MiB maximum file size;
- bounded line, character, and result counts;
- no shell, general filesystem write, network, database, or truth-commit tool
  available to the model. A source compiler loop adds only typed writes to the
  pending proposal store.

The TUI accepts `!command` as an explicit user action, matching agent-terminal conventions. That path is handled by the terminal UI and is never registered as an LLM tool. Use `-p` when a non-interactive, shell-free transport is required.

## Sessions and local state

Pi transcripts are stored under `~/.novel-harness/sessions/` unless `--no-save` is used. Each workspace session directory also contains a small `last-opened.json` pointer updated by interactive startup and session switching. When the pointer is missing or invalid, NWH first compares logical visible conversation activity—including player custom messages—while ignoring title/startup metadata that can pollute file `mtime`; Pi's filesystem-based discovery remains the final compatibility fallback. `--session <id>` bypasses those heuristics and opens the exact workspace transcript named by the exit hint. Because tool results become conversation context, retrieved excerpts can be present in a transcript. The main agent can call the metadata-only `rename_session` tool after understanding the concrete target; compiler and player flows also assign a contextual fallback title, so the Pi session selector shows the novel, character, or task instead of an indistinguishable default. Existing manual names are not overwritten by host fallbacks. `/clear` starts a new, unbound Pi runtime session without deleting prior append-only transcripts, compiled novels, or committed world instances. It deliberately does not restore the workspace-global active character; the welcome remains available for `/novels`, `/instances`, or a new `/play` choice. Session replacement is owned by `AgentSessionRuntime`, so `/new`, `/resume`, `/fork`, and `/clear` rebind the TUI and tools to the active session instead of leaving stale event subscriptions.

Project manifests, source indexes, compiler batch checkpoints, proposals, and world objects are also local files. These are inspectable implementation state, not model memory. They remain hidden from general model file search.

Catalog commands are deliberately scoped to the selected `--root`: `nwh novels`
lists every registered source in that novel workspace, and instance/character
commands inspect only branches pinned in the same workspace. The current storage
format has no authoritative cross-workspace library identity, so the CLI does not
pretend that scanning unrelated workspace directories is a safe global resume map.

The origin novel is copied to a mode-`0400`, content-addressed source object
before segmentation. Evidence verification, cache restore, whole-book reparse,
chapter reparse, and runtime reopening use that archived object; changing or
deleting the origin path does not change the registered source. Legacy
workspace-local `.novel-harness/` state is copied into the user store on first
open and deliberately left in place for recoverability.

Completed novel preparation is reusable across workspaces. NWH writes immutable
bundles below `$NWH_HOME/prepared-novels/v1/<content-md5>/revisions/<bundle-hash>/`;
the manifest also binds the full SHA-256 source digest. `active.json` is an atomic
pointer to the revision restored by default. An existing revision is verified and
never updated in place. Restore is allowed only before the target workspace has
pending proposals or branches, and it materializes independent local copies. It
never copies branch commits, branch heads, or play-session state.

Preparation is not permanently frozen. `nwh reparse --all` rebuilds every
detected chapter, while `nwh reparse --chapters 1,4-6` invalidates and recompiles
only those built-in or validated agent-discovered heading sections (or
deterministic blocks when no reliable heading form exists). A
successful run publishes and activates a new revision; a failed run rolls the
current workspace back to its prior active revision. `nwh prepared-cache list`
shows retained revisions and `nwh prepared-cache activate <bundle-hash>` selects
one explicitly. Existing branches keep their captured canonical, actor-policy,
and possibility-template revisions; only later branches use the newly active
preparation.

If a process is interrupted after selected batches are marked incomplete, rerun
the same reparse scope. NWH restores the active immutable prepared revision,
rejects partial proposals from those selected batches, and restarts from that
clean rollback baseline. It will not auto-restore when unfinished batches exist
outside the requested scope; include them explicitly or resume preparation first.
If a workspace completed every batch under an older compiler pipeline before
prepared revisions existed, `reparse --all` first preserves that materialized
world as an explicitly incompatible rollback-only revision. This bootstrap is
allowed only for a complete, versioned legacy checkpoint and a whole-novel
scope; incomplete checkpoints still require preparation to finish first.

## Compiler capability boundary

Compiler mode now adds narrow typed `propose_*` tools. They can create pending candidate artifacts, but cannot accept them, move a branch head, execute a shell, or write arbitrary files. Deterministic code verifies structure and source evidence before explicit acceptance:

```text
proposal -> validate -> commit -> render
```

The general model in `nwh` / `nwh play` starts read-only. Supplying a standalone
novel path temporarily adds the same narrow `propose_*` capability for its source
compiler loop. `nwh prepare` exposes the durable compile/review/audit/branch state
machine without bypassing explicit acceptance. If a saved play selection exists,
startup enters player mode; ordinary input is intercepted before the general model
and routed through the restricted boundary below. `/leave` returns to the read-only
assistant without deleting durable resume state.

`nwh continue|switch|create`, `nwh resume`, TUI player commands, and the compact
`nwh play-world` command share a separate character-embodiment boundary.
Instance lookup is scoped by novel ownership: continue chooses the newest
matching save, switch asks among matching saves, and a missing save is created
from the selected novel's active prepared revision. When a new instance is
needed, NWH asks for a grounded role before creating its branch. An opening role
uses the novel's opening checkpoint; a later role starts immediately before that
character's first source-backed embodied scene. Main-timeline canonical effects
before the checkpoint seed genesis, followed by only the entry checkpoint's
already-true state and knowledge. That checkpoint also supplies physical presence
and a direct actor-visible scene observation; the target event and its outcome
remain unrealized so the player can act. If a step-zero opening instance already
exists—even if it has been viewed or saved—selecting a later role creates a
sibling instance instead of rewriting or jumping the old branch.

Before an opening-role scene, NWH displays the initial world's source-grounded,
spoiler-free reader setup: where, when, who, the premise needed to understand the
scene, and its immediate unresolved situation. The opening role must also have
explicit physical presence plus grounded location, plan, or momentum. Before a later-role scene, NWH
displays the complete ordered source-event synopsis preceding that role entry as
**reader context**. Every beat includes its
source-grounded recap, participants, narrative mode/time, and available causal
links; a later role is not offered if any prior recap is missing. Reader context
is explicitly not character knowledge and is never sent to the narrator,
translator, NPC reasoner, or world state. The scene timing then follows player intent: `play` renders the selected
character's current scene, `create` opens the new story, and a real `switch`
re-orients the player at the selected head. `continue`, `resume`, and an ordinary
restart preserve the existing time/conversation context without inserting
another narrator message. Player-only custom transcript entries count as
existing context, including when the launch command carried an automatic scene
request. A fresh transcript created by an explicit player-entry command renders
one orientation because no prior screen context exists; a plain `--new-session`,
`/new`, or `/clear` stays unbound and renders no scene.

Startup never waits for an optional narrator before letting Pi render the
transcript. Private choice, style, and dramaturgy specialists run without
streaming; the fresh final literary narrator is mounted as one assistant stream
in Pi's scrollable transcript, while its provider/model, read-only retrieval,
and retry phases use compact footer status. The accepted text must match the observed stream before
that same native component is committed as the durable scene; no duplicate
narrator message is mounted. Thinking and current-head choice metadata are
stored with it outside parent-model context and restore with the transcript. A
rejected underspecified, repetitive, or locked-dialogue-dropping attempt is
removed before one fresh final-narrator retry streams; private specialists are
not repeated. The action dialog merges choice-specialist suggestions with bounded, current-head
host-preflighted exits and free-form input. It therefore retains an executable
route even when choice capture is empty or malformed. Current-contract choices
restore only when branch, actor, commit, and choice contract still match. Older
unmarked choice records are not restored or rebuilt. A final provider failure is
shown explicitly with `/scene`, `/login`, and `/model` recovery guidance instead
of masquerading as generic story prose. None of these rendering paths moves the
branch head. Each natural-language
action receives only an actor-scoped view plus entities explicitly named by the
player and artifacts currently owned by that actor. Scene presence is carried
separately from merely referenceable identities, so a known name no longer
pretends to prove co-location. New revisions distinguish physical, remote,
mentioned, represented, dream, and memory participation; only physical presence
makes a canonical/background participant co-present. Legacy interactive actor
events remain usable when an older prepared revision lacks location fields,
while legacy flat canonical/background participant lists fail closed. Unknown
co-present identities remain anonymous. Before the view reaches Pi, stable
entity and claim IDs become turn-local opaque handles. A bounded initial
projection carries coverage metadata, and exact read-only retrieval can recover
omitted records only from that same actor-safe corpus. Its fresh Pi session has no
file tools, project instructions, compiler extension, source text, future canon,
or mutation tool. A single capture-only candidate is passed to deterministic
scope, knowledge, world-rule, invariant, and optimistic-head validation before the
host may commit it. Missing sparse-state fields are treated as unknown and cannot
be fabricated into positive preconditions. The private choice specialist proposes 2-4 concrete
actor actions or exact spoken lines from the committed scene, lived development,
and effective disposition. The selector displays only those action/line texts,
without host rationale or a recommendation badge. They remain unvalidated
suggestions until selected; selection then enters the ordinary typed
interpretation, current-world adjudication, and deterministic gates. The choice
model supplies action text only and cannot choose a privileged host intent or
bypass interpretation. Choice capture is a separate tool-only session running
concurrently with private literary-style and dramaturgy analysis. A fresh final
narrator then composes only prose from the committed frame, exact resolved act
and locked speech, narrator-safe style-only source excerpts, exact prior play
prose, and whichever bounded analyses succeeded. If the choice call is absent
or malformed, the host does not retry it; accepted prose is kept and the dialog
still includes bounded current-head host-preflighted actions. The same animated working indicator is used while
interpreting, adjudicating, validating, and rendering.

The interpreter explicitly separates what the selected character can do from
the result they hope the world will provide. If world adjudication omits its
structured response, NWH retries once in a fresh isolated session. A second
failure can still commit a pure current-scene observation with no state,
knowledge, time, or movement effect; the hoped-for result stays uncommitted and
the new observation becomes part of replayable character context. Broader acts
remain at the prior head and use an explicitly out-of-character recovery notice
instead of being dramatized as resistance. A protocol failure never creates a
world rule.

Narration and choices are separate sessions and channels. The final narrator is
instructed to render rather than summarize, preserve every committed locked
utterance verbatim, keep prose inside one current actor-visible beat, and end on
a concrete fact or in-world signal. It has no compact 120-350-character target.
The host validates broad structural limits, repetition, and exact locked
dialogue but does not otherwise
match language-specific “what next” or handoff phrases. Possible actions normally
appear in the choice selector; missing/malformed auxiliary choices leave valid
prose intact and retain at least one preflighted host action, with no choice
retry. Missing actor/location fields remain available
as readiness diagnostics but do not produce a yellow player-facing warning. Only actionable
instance conditions, such as a pinned revision differing from the active prepared
revision, enter that warning surface.
Use `/ooc <question>` for an explicit actor-visible timeline/status query that
must not advance the world. Ordinary prose is never reclassified as meta by a
language-specific phrase matcher.
After an accepted commit, a separate isolated narrator streams the actor-visible
consequence from the final committed head. Between the player event and that
narration, a fresh isolated host-private causal linker receives the structured
intent and a bounded set of currently eligible world-side developments. It may
select one opaque offered handle or none; selection is rechecked and committed as
a distinct typed event. This handles direct triggers such as opening/reading an
offered letter without making every eligible canonical event automatic. The
offered set, decision, event, and errors are persisted in the private turn audit,
but are never actor or narrator context. Deterministic commit metadata and
invisible background events are not presented as story prose. Ordinary player
turns default to zero automatic unrelated background/canon events. Selecting the
explicit wait affordance advances five minutes and permits at most one currently
eligible autonomous obligation, causal consequence, background pressure, or
environmental process to commit; it does not schedule a forward canon analogue.
If none is eligible, elapsed time still changes. This is an opt-in to world
motion, not an automatic canon scheduler. `play-world
--advance-background <n>` is an explicit opt-in, and the frontier rejects temporal
regression and orders forward candidates by their story window. If rendering
fails, NWH states that the action is already committed and tells the player to use
`/scene` instead of repeating it. Rejected proposals do not move branch truth,
but they no longer end the interaction: NWH renders/re-establishes the unchanged
scene and offers another action. Candidate, proposal, validation, timing, and
issue details are persisted in the workspace runtime state under
`world/v1/play/turns/` for diagnosis rather than dumped into story prose.

`nwh compile` uses the same TUI with narrow `propose_*` tools and starts an evidence-backed batch. Supplying `nwh compile "<instruction>"` keeps the one-shot compiler path for automation. Neither form can accept proposals or mutate canonical/runtime truth.

`nwh prepare-all [novel]` is the guided full-preparation path. Invoking it
opens AskUserQuestion-style choices before NWH compiles every unfinished source
batch, accepts canonical and possibility proposals that pass deterministic
validation, requests an opening-state proposal, or creates the selected playable
branch. Multiple registered sources are also presented as a choice. Choosing a
pause/review answer preserves progress. `--yes` is the explicit non-interactive
form and selects each recommended answer. Validation-blocked and staging-only
proposals are never forced into world truth: full preparation preserves them in
rejected history and continues with validated artifacts. Source batches hide the
staging-only raw state-delta tool, recover active drafts by stable batch identity,
and let the host supply the active proposal set to the finish handshake. A missing
or failed model-generated opening state may use an alive-only fallback only for
a source with exactly one accepted character. Multi-character novels fail closed
until the compiler supplies an evidence-backed location, plan, or momentum for
an actionable opening role.

The TUI `/prepare-all` command presents the same decisions with Pi-native
selection dialogs. Remaining compiler batches execute sequentially in the current
session, but each model request sees only the current compiler-batch boundary and
its evidence/tool exchange. Earlier batch transcripts remain available to the
human UI without being replayed into later model context or summaries. Settled
model prose remains visible unchanged, while a separate host notification reports
verification; only the successful finish handshake and persisted batch checkpoint
determine completion. Internal
continuation instructions are hidden, so they do not replace or masquerade as
user input. Other prompts, `/compile-next`, and `/clear` are held
back while full preparation is active to prevent interleaved state machines.
