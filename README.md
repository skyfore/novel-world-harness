# Novel World Harness

A local-first, Pi-backed terminal harness for compiling novels into evidence-backed executable worlds.

The target is not a novel RAG chatbot. Source text is compiled into a canonical model; runtime branches then evolve through validated events without forcing a divergent branch back onto the book's future plot.

## Current status

The repository contains a tested engine vertical slice, not yet a finished role-playing product.

Implemented:

- Claude Code-style TUI with a persistent transcript, streaming responses, rendered tool calls, a multiline editor, status/footer information, and bounded local `list_files`, `search_files`, and `read_file` tools;
- local state under `.novel-harness/`, with no PostgreSQL, vector database, or RAG service;
- deterministic source registration, hashing, segmentation, and resumable compiler batches;
- Pi compiler sessions that can only create typed pending proposals;
- cryptographic evidence verification before canonical or possibility acceptance;
- logical canonical IDs backed by immutable content-addressed revisions;
- event-sourced branch history, deterministic state projection, temporal rules, knowledge isolation, snapshots, and integrity checks;
- canonical and non-canonical possibilities, counterfactual branches, checkpoint replay, and deterministic actor-goal policies.

Not implemented as an end-user loop yet:

- one command that takes a novel from ingest through reviewed world creation;
- natural-language player actions translated into validated event proposals;
- a Pi/LLM actor reasoner connected to the CLI runtime;
- model-backed literary narration connected to `world render`;
- an interactive “select a character and inhabit the world” session;
- corpus-backed proof that model extraction is reliable across full novels and genres.

The governing invariant is:

```text
proposal -> validate -> commit -> render
```

See [ADR 0001](docs/adr/0001-world-truth-history-and-possibility-space.md) for the temporal model and [implementation status](docs/implementation-status.md) for the detailed completion assessment.

## Install

```bash
npm ci
npm run build
npm link
```

Node 22.19 or newer is required.

## Local terminal assistant

```bash
export ANTHROPIC_API_KEY=your_key
nwh
nwh -p "列出这个工作区中的主要人物资料"
nwh --continue
nwh --root ./my-novel
nwh --tui-mode fullscreen
```

`nwh` and `nwh play` open the TUI in `regular` mode by default, preserving terminal scrollback. `--tui-mode fullscreen` uses an alternate-screen layout. `-p` remains the non-interactive path for scripts and pipelines.

The model in the ordinary session is read-only. Inside the TUI:

```text
/files chapter
/search 赤壁
/read chapters/12.md 40:100
分析 @chapters/12.md 中曹操的错误判断
/status
/clear
/exit
```

The TUI also supports multiline editing, interrupt/queue shortcuts, session navigation, and expandable tool output; use `/hotkeys` for the current key map. A leading `!` is an explicit user-run shell command provided by the terminal UI. It is not exposed to the model as a tool.

Selected excerpts are sent to the configured model provider. “Local-first” describes discovery, access control, and persistence; it is not an offline-model guarantee.

Pi may also perform startup metadata checks or obtain its optional `fd` autocomplete helper. Set `PI_OFFLINE=1` to suppress those startup operations; model prompts still require the configured provider unless that provider is local.

## Compile a source

```bash
nwh init ./my-novel
cd ./my-novel
export ANTHROPIC_API_KEY=your_key

nwh doctor
nwh ingest ./books/novel.txt
nwh compile-source
nwh proposals list
nwh proposals accept-all
nwh audit
nwh status
```

`ingest` stores a content-addressed source manifest and deterministic evidence segments. It does not copy the novel into a database. `compile-source` sends bounded evidence batches to the selected model, and model tools can only write pending typed proposals. `accept-all` revalidates structure and source evidence before moving valid canonical and possibility proposals into revisioned stores.

For guided compiler work, `nwh compile` opens the same TUI in compiler mode and starts a small evidence-backed proposal batch. `nwh compile "<instruction>"` preserves the one-shot form.

## Execute a compiled world

```bash
nwh world create main
nwh world show --branch main
nwh world frontier --branch main
nwh world move --branch main
nwh world history --branch main
nwh world render --branch main
```

Player actions currently use an explicit `EventProposal` JSON file:

```bash
nwh world validate ./player-action.json --branch main
nwh world move --branch main --player ./player-action.json
```

Branch and integrity workflows:

```bash
nwh world fork alternate --branch main
nwh world diff main alternate
nwh world replay ./checkpoints.json --branch main
nwh world snapshot --branch main
nwh world fsck
```

Actor inspection is available, but it is not yet an interactive embodiment loop:

```bash
nwh world knowledge hero --branch main
nwh world actor hero --branch main
```

## Architecture

```text
Novel files
  -> deterministic evidence index
  -> bounded Pi compiler batches
  -> typed pending proposals
  -> evidence + structural validation
  -> revisioned canonical model / possibility templates
  -> immutable branch events and StateDelta objects
  -> WorldState(branch, t) projection
  -> possibility + actor + player proposals
  -> validate / adjudicate / commit
  -> narrative frame and renderer
```

The compiler may inspect the complete canonical trajectory. A runtime branch treats only its own committed history as truth; later canon is evidence and an evaluation reference, not an automatic schedule.

Further reading: [local CLI](docs/local-cli.md), [Pi integration](docs/pi-integration.md), [configuration](docs/configuration.md), [world-model design](docs/design.md), and [technical design](docs/technical-design.md).
