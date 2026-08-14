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
- `nwh --continue` resumes the latest workspace-local Pi session;
- Pi's viewport-based `fullscreen` layout is the default; it opens at the newest transcript content with a fixed editor/status dock, while `--tui-mode regular` remains the terminal-native scrollback fallback;
- `@path` attaches local file context without changing the displayed user message;
- a standalone quoted, unquoted, absolute, or workspace-relative novel path starts
  the durable source compiler loop;
- `/files`, `/search`, and `/read` work without a model request;
- `/prepare-content <text>` archives exact pasted text and starts its compiler loop;
- `/prepare-all [source-id] [branch-id]` completes guided preparation in the current TUI;
- `/reparse --chapters 2,37 --source <id>` (or `/reparse --all`) runs the same revision-safe rebuild service as the CLI, with native novel/chapter selection when flags are omitted;
- `/tasks` brings the current long-running NWH task back to its live foreground panel. A reparse opens there first and shows host lifecycle events, tool calls, provider reasoning activity, and streamed model text. Model prose is visibly marked unverified because only validated proposals can become world truth. `←` or `Esc` collapses the panel without cancelling the request, leaving a compact progress widget below the editor;
- `/audit [--source <id>]` and `/prepared-cache [list|activate]` expose the same novel diagnostics and prepared-revision lifecycle in the TUI;
- `/novels`, `/instances`, `/characters`, and `/progress` inspect compiled content without a model request;
- `/play [character] [instance] [novel]` selects the novel first, then opens height-aware, natively scrolling and filterable instance/character selection (with free-form id/name/alias input); `/world-resume` restores the durable novel/instance/character selection;
- `NOVEL.md` provides checked-in project instructions;
- `.novel-harness/instructions.md` provides local additions.

The TUI has a transcript, incremental assistant rendering, explicit tool-call/result rows, a multiline editor, working state, queued messages, a footer, slash-command completion, and keyboard shortcuts. In fullscreen, PageUp/PageDown scroll the transcript, Ctrl+Shift+Up/Down jump between prompts, and Ctrl+Shift+F searches. Pi's native editor owns `↑`/`↓` prompt history, including history restored with a resumed session. Ctrl+O expands tool output and Ctrl+T toggles provider thinking, following Pi's native keybinding and saved-visibility behavior. Foreground `/reparse` tasks retain only a focused NWH lifecycle/paging shell; their model text, thinking, tools, key hints, and theme use Pi's exported TUI components. Live task thinking is visible while streaming and collapses when that assistant message completes. Claude Code is an interaction reference, not a runtime dependency. NWH uses Pi's public `AgentSessionRuntime`, `InteractiveMode`, and TUI components instead of maintaining terminal control sequences itself.

NWH loads a hidden inline extension to supply its header, working/status labels,
safe local commands, and invisible `@path` context attachment. User input is kept
verbatim in the transcript; compiler instructions and evidence slices are added as
non-displayed context. Project or user Pi extensions, skills, prompt templates,
context files, and built-in model coding tools remain disabled.

When a standalone text novel path (`.txt`, `.text`, `.novel`, `.md`, or
`.markdown`) is submitted, the extension deterministically registers and segments
that source, injects the next bounded evidence batch as hidden model context, and
dynamic compiler toolset exposes the narrow `propose_*` tools plus
`withdraw_compiler_proposal` and `finish_compiler_batch`. The
first batch starts immediately; `/compile-next` advances the same source after a
successful proposal run and explicit `finish_compiler_batch` handshake. Repository code remains available as secondary read-only
context, but prompts and tool guidance keep the novel world as the primary subject.

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

Pi transcripts are stored under `~/.novel-harness/sessions/` unless `--no-save` is used. Because tool results become conversation context, retrieved excerpts can be present in a transcript. `/clear` starts a new Pi runtime session without deleting prior append-only files. Session replacement is owned by `AgentSessionRuntime`, so `/new`, `/resume`, `/fork`, and `/clear` rebind the TUI and tools to the active session instead of leaving stale event subscriptions.

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
only those heading sections (or deterministic blocks for heading-free text). A
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

`nwh resume`, TUI `/play`, and the compact `nwh play-world` command share a separate character-embodiment boundary. Each natural-language
action receives only an actor-scoped view plus entities explicitly named by the
player and artifacts currently owned by that actor. Its fresh Pi session has no
file tools, project instructions, compiler extension, source text, future canon,
or mutation tool. A single capture-only candidate is passed to deterministic
scope, knowledge, world-rule, invariant, and optimistic-head validation before the
host may commit it. Rejected turns do not move branch truth.

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
or failed model-generated opening state falls back to an evidence-backed empty
delta, which asserts no unsupported facts but still permits genesis.

The TUI `/prepare-all` command presents the same decisions with Pi-native
selection dialogs. Remaining compiler batches execute sequentially in the current
session, but each model request sees only the current compiler-batch boundary and
its evidence/tool exchange. Earlier batch transcripts remain available to the
human UI without being replayed into later model context. Model-written completion
claims are replaced with a neutral host-verification message; only the successful
finish handshake and persisted batch checkpoint determine completion. Internal
continuation instructions are hidden, so they do not replace or masquerade as
user input. Other prompts, `/compile-next`, and `/clear` are held
back while full preparation is active to prevent interleaved state machines.
