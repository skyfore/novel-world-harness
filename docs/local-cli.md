# Local-first terminal UI design

## Decision

Phase 0 is a Novel World Harness terminal application backed by Pi. The default interaction deliberately resembles Claude Code rather than a `readline` prompt:

- `nwh` opens a continuously rendered TUI in the current directory;
- `nwh -p "..."` runs one prompt and exits;
- `nwh --continue` resumes the latest workspace-local Pi session;
- `--tui-mode regular|fullscreen` selects scrollback-friendly or alternate-screen layout;
- `@path` resolves a local file before the model request;
- `/files`, `/search`, and `/read` work without a model request;
- `NOVEL.md` provides checked-in project instructions;
- `.novel-harness/instructions.md` provides local additions.

The TUI has a transcript, incremental assistant rendering, explicit tool-call/result rows, a multiline editor, working state, queued messages, a footer, slash-command completion, and keyboard shortcuts. Claude Code is an interaction reference, not a runtime dependency. NWH uses Pi's public `AgentSessionRuntime` and `InteractiveMode` instead of maintaining terminal control sequences itself.

NWH loads a hidden inline extension to supply its header, working/status labels, safe local commands, and `@path` transformation. Project or user Pi extensions, skills, prompt templates, context files, and built-in model coding tools remain disabled.

## Retrieval boundary: file search, not RAG

The model receives no automatic workspace dump and there is no embedding pipeline. It can request three read-only tools:

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
- no shell, write, network, database, or commit tool available to the model.

The TUI accepts `!command` as an explicit user action, matching agent-terminal conventions. That path is handled by the terminal UI and is never registered as an LLM tool. Use `-p` when a non-interactive, shell-free transport is required.

## Sessions and local state

Pi transcripts are stored under `.novel-harness/sessions/` unless `--no-save` is used. Because tool results become conversation context, retrieved excerpts can be present in a transcript. `/clear` starts a new Pi runtime session without deleting prior append-only files. Session replacement is owned by `AgentSessionRuntime`, so `/new`, `/resume`, `/fork`, and `/clear` rebind the TUI and tools to the active session instead of leaving stale event subscriptions.

Project manifests, source indexes, compiler batch checkpoints, proposals, and world objects are also local files. These are inspectable implementation state, not model memory. They remain hidden from general model file search.

## Compiler capability boundary

Compiler mode now adds narrow typed `propose_*` tools. They can create pending candidate artifacts, but cannot accept them, move a branch head, execute a shell, or write arbitrary files. Deterministic code verifies structure and source evidence before explicit acceptance:

```text
proposal -> validate -> commit -> render
```

The ordinary `nwh` / `nwh play` session remains read-only. World execution is currently exposed through explicit `nwh world ...` commands; an interactive character-embodiment loop is future product work.

`nwh compile` uses the same TUI with narrow `propose_*` tools and starts an evidence-backed batch. Supplying `nwh compile "<instruction>"` keeps the one-shot compiler path for automation. Neither form can accept proposals or mutate canonical/runtime truth.
