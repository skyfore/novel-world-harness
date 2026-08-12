# Local-first terminal UI design

NWH keeps executable world evidence and committed history in the workspace's
`.novel-harness/` directory. Process runtime state is separate: saved terminal
sessions and other NWH runtime files live under `~/.novel-harness/` (or
`NWH_HOME` when explicitly set), so running the CLI does not add session files
to the current project.

## Decision

Phase 0 is a Novel World Harness terminal application backed by Pi. The default interaction deliberately resembles Claude Code rather than a `readline` prompt:

- `nwh` opens a continuously rendered TUI in the current directory;
- `nwh -p "..."` runs one prompt and exits;
- `nwh --continue` resumes the latest workspace-local Pi session;
- `--tui-mode regular|fullscreen` selects scrollback-friendly or alternate-screen layout;
- `@path` attaches local file context without changing the displayed user message;
- a standalone quoted, unquoted, absolute, or workspace-relative novel path starts
  the durable source compiler loop;
- `/files`, `/search`, and `/read` work without a model request;
- `/prepare-all [source-id] [branch-id]` completes guided preparation in the current TUI;
- `NOVEL.md` provides checked-in project instructions;
- `.novel-harness/instructions.md` provides local additions.

The TUI has a transcript, incremental assistant rendering, explicit tool-call/result rows, a multiline editor, working state, queued messages, a footer, slash-command completion, and keyboard shortcuts. Claude Code is an interaction reference, not a runtime dependency. NWH uses Pi's public `AgentSessionRuntime` and `InteractiveMode` instead of maintaining terminal control sequences itself.

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

## Compiler capability boundary

Compiler mode now adds narrow typed `propose_*` tools. They can create pending candidate artifacts, but cannot accept them, move a branch head, execute a shell, or write arbitrary files. Deterministic code verifies structure and source evidence before explicit acceptance:

```text
proposal -> validate -> commit -> render
```

The ordinary `nwh` / `nwh play` session starts read-only. Supplying a standalone
novel path temporarily adds the same narrow `propose_*` capability for its source
compiler loop. `nwh prepare` exposes the durable compile/review/audit/branch state
machine without bypassing explicit acceptance.

`nwh play-world` is a separate character-embodiment boundary. Each natural-language
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
proposals stop either form rather than being forced into world truth.

The TUI `/prepare-all` command presents the same decisions with Pi-native
selection dialogs. Remaining compiler batches execute sequentially in the current
session; internal continuation instructions are hidden, so they do not replace or
masquerade as user input. Other prompts, `/compile-next`, and `/clear` are held
back while full preparation is active to prevent interleaved state machines.
