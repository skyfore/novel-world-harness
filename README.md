# Novel World Harness

A local-first, Pi-backed terminal harness for compiling novels into evidence-backed executable worlds.

The target is not a novel RAG chatbot. Source text is compiled into a canonical model; runtime branches then evolve through validated events without forcing a divergent branch back onto the book's future plot.

## Current status

The repository contains a tested, constrained end-to-end novel-player vertical slice. It is not yet evidence that arbitrary full novels compile reliably or that the runtime is a finished role-playing product.

Implemented:

- Claude Code-style TUI with a persistent transcript, streaming responses, rendered tool calls, a multiline editor, status/footer information, and bounded local `list_files`, `search_files`, and `read_file` tools;
- local state under `.novel-harness/`, with no PostgreSQL, vector database, or RAG service;
- deterministic source registration, hashing, segmentation, and resumable compiler batches;
- Pi compiler sessions that can only create typed pending proposals;
- an explicit compiler-batch finish handshake, so failed or partial tool runs remain retryable instead of being checkpointed;
- cryptographic evidence verification before canonical or possibility acceptance;
- logical canonical IDs backed by immutable content-addressed revisions;
- event-sourced branch history pinned to immutable canonical snapshots, deterministic state projection, temporal rules, knowledge isolation, snapshots, and integrity checks;
- canonical and non-canonical possibilities, counterfactual branches, checkpoint replay, and deterministic actor-goal policies.
- a derived `prepare` workflow that guides ingest, bounded compilation, explicit review, audit, and branch creation without automatically accepting model output;
- `play-world`, which selects a committed character and translates natural-language actions through an actor-scoped, capture-only model tool before deterministic scope, knowledge, engine, and commit gates;

Still intentionally limited:

- a Pi/LLM actor reasoner connected to the CLI runtime;
- model-backed literary narration connected to `world render`;
- player actions can change the selected actor and currently owned artifacts, but broader physical/social simulation is not yet modeled;
- corpus-backed proof that model extraction is reliable across full novels and genres.

The governing invariant is:

```text
proposal -> validate -> commit -> render
```

See [ADR 0001](docs/adr/0001-world-truth-history-and-possibility-space.md) for the temporal model and [implementation status](docs/implementation-status.md) for the detailed completion assessment.

## Install

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
```

Node 22.19 or newer is required.

## Local terminal assistant

```bash
pnpm dev
```

No API key is required to open the TUI. To use an existing provider subscription,
authenticate and select a model inside the session:

```text
/login
/model
```

Pi supports subscription sign-in for ChatGPT Plus/Pro (Codex), Claude Pro/Max,
and GitHub Copilot. `/model` switches models but does not authenticate a provider,
so run `/login` first. NWH reuses Pi's native authentication, model catalog, and
default model selection in `~/.pi/agent/`; a user who has already configured Pi
does not need to authenticate again. An explicit `--model` or configured role
profile overrides Pi's default for that invocation. NWH conversations are stored
separately under `~/.novel-harness/`, while compiled world data remains in the
workspace's `.novel-harness/` directory.

API keys remain supported as an alternative:

```bash
export ANTHROPIC_API_KEY=your_key
pnpm dev
pnpm dev -p "列出这个工作区中的主要人物资料"
pnpm dev --continue
pnpm dev --root ./my-novel
pnpm dev --tui-mode fullscreen
```

Paste or drag a standalone UTF-8 novel path (`.txt`, `.text`, `.novel`, `.md`, or
`.markdown`) into the TUI to begin the compiler workflow immediately. NWH
registers the source, builds bounded evidence segments,
dynamically enables the typed pending-proposal tools, and processes the first
compiler batch without first exploring the repository or explaining the CLI:

```text
'/absolute/path/to/novel.txt'
/compile-next
```

Each successful batch is checkpointed under `.novel-harness/`. `/compile-next`
continues the active novel from the next unfinished batch. The loop is deliberately
one batch per user action so importing a long novel cannot silently trigger an
unbounded sequence of model requests. Generated artifacts remain pending proposals
until deterministic validation and explicit acceptance.

Run `/prepare-all [source-id] [branch-id]` inside the TUI to finish the remaining
batches in the current session, review guided acceptance choices, generate a
missing opening state, and create a playable branch. Its internal continuation
messages stay hidden from the visible transcript.

`nwh` and `nwh play` open the TUI in `regular` mode by default, preserving terminal scrollback. `--tui-mode fullscreen` uses an alternate-screen layout. `-p` remains the non-interactive path for scripts and pipelines.

Ordinary conversation starts with read-only discovery tools. Starting a source
compiler loop adds only the narrow typed tools that can create pending proposals;
it still cannot commit world truth or write arbitrary files. Inside the TUI:

```text
/files chapter
/search 赤壁
/read chapters/12.md 40:100
分析 @chapters/12.md 中曹操的错误判断
/compile-next
/prepare-all
/status
/clear
/exit
```

The TUI also supports multiline editing, interrupt/queue shortcuts, session navigation, and expandable tool output; use `/hotkeys` for the current key map. A leading `!` is an explicit user-run shell command provided by the terminal UI. It is not exposed to the model as a tool.

Selected excerpts are sent to the configured model provider. “Local-first” describes discovery, access control, and persistence; it is not an offline-model guarantee.

Pi may also perform startup metadata checks or obtain its optional `fd` autocomplete helper. Set `PI_OFFLINE=1` to suppress those startup operations; model prompts still require the configured provider unless that provider is local.

## Prepare and enter a world

To authorize one command to compile all remaining batches, automatically accept
every proposal that passes deterministic validation, create the initial world,
and open a playable branch:

```bash
nwh prepare-all ./books/novel.txt
nwh play-world --list-characters
```

`prepare-all` asks focused multiple-choice questions before running all model
batches, accepting validated proposals, generating a missing opening state, and
creating the playable branch. Choose the review/pause option at any question to
retain the current durable progress. For scripts and CI, `--yes` accepts every
recommended choice without prompting:

```bash
nwh prepare-all ./books/novel.txt --yes
```

`prepare-all` never force-accepts a blocked proposal. It stops with diagnostics
when evidence, dependencies, audit checks, or staging-only artifacts still need
attention. The existing `prepare` flow below remains the review-first path.

```bash
nwh init ./my-novel
cd ./my-novel
nwh doctor
nwh prepare ./books/novel.txt
nwh proposals list
nwh proposals show <proposal-id>
nwh proposals accept <kind> <proposal-id>   # or: nwh proposals reject <proposal-id>
nwh audit
nwh prepare --source <source-id>
nwh status
nwh play-world --list-characters
nwh play-world --character <id-or-name> --action "我前往藏书楼。"
```

`init` is provider-neutral. Use the TUI's `/login` and `/model`, an existing workspace-local Pi authorization, or an explicit optional `llm` profile. `prepare` derives the next safe stage from durable artifacts, runs at most one unfinished compiler batch by default, and always prints `Next:`. It stops at the review barrier and never accepts model output. Once every proposal is explicitly accepted or rejected and the audit is clean, rerunning `prepare` creates the canonical-initialized branch exactly once.

`ingest` and `compile-source` remain available as lower-level commands. Ingest stores a content-addressed source manifest and deterministic evidence segments; it does not copy the novel into a database. Compiler tools can only write pending typed proposals. `proposals accept-all` remains an automation helper that revalidates dependencies and evidence, but individual `show` plus `accept`/`reject` is the recommended review path.

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

The low-level runtime also accepts an explicit `EventProposal` JSON file:

```bash
nwh world validate ./player-action.json --branch main
nwh world move --branch main --player ./player-action.json
```

The safer natural-language path is `play-world`. Every action uses a fresh Pi session with no novel-file tools, project instructions, compiler extension, future canon, or branch-write capability. The model can only capture one candidate in memory; the host supplies branch/head/source/actor identity and commits only after deterministic validation. Rejections print concrete issue codes and leave the branch head unchanged. Omitting `--action` in a terminal opens a repeatable action prompt, and the active branch/character is persisted locally.

Branch and integrity workflows:

```bash
nwh world fork alternate --branch main
nwh world diff main alternate
nwh world replay ./checkpoints.json --branch main --output-branch replay-main
nwh world snapshot --branch main
nwh world fsck
```

`world diff` reports state, committed-history, and actor-knowledge divergence. `world replay` always forks a new output branch (or generates one when `--output-branch` is omitted), so replay success or failure never advances the source branch.

Actor inspection remains available alongside the embodiment loop:

```bash
nwh world knowledge hero --branch main
nwh world actor hero --branch main
```

NWH does not impose a token budget, request-count ceiling, or smaller output cap
on Pi model calls. Transient provider failures use Pi's automatic retry policy;
the CLI reports retry progress and only returns a failure after retries are
exhausted.

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
