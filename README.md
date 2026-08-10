# Novel World Harness

A local-first CLI for compiling novels into verifiable executable worlds.

The goal is not to build a novel RAG chatbot. The harness compiles a novel into a temporal, evidence-backed world model that can be replayed and then diverged. A user can eventually select a character, enter the timeline at a valid point, make decisions, and let the world continue evolving without being forced back to canon.

## Current direction

Phase 0 now prioritizes a useful terminal harness before production compiler workers:

- `nwh` opens an interactive session in the current novel workspace;
- local `/files`, `/search`, and `/read` commands work without an API key;
- the agent has the same three read-only local tools;
- `@path` attaches a bounded local file excerpt;
- `NOVEL.md` supplies project-level instructions;
- `nwh --continue` resumes the latest local session;
- `nwh -p "..."` supports one-shot use;
- PostgreSQL/NWIR scaffolding remains available for compiler work.

Pi and custom external provider/service endpoints are not part of this phase. Model calls use the official Anthropic SDK. Local retrieval happens on-device, but any excerpt selected by `@path` or a model tool is sent to the configured Anthropic model as conversation context.

## Quick start

```bash
npm install
npm run build
npm link

export ANTHROPIC_API_KEY=your_key
nwh
```

No `novel-harness.yaml` or PostgreSQL instance is needed for the interactive shell.

Useful forms:

```bash
nwh -p "列出这个项目里的主要人物资料"
nwh --continue
nwh --root ./my-novel
nwh play --model claude-sonnet-5
```

Inside a session:

```text
/files chapter
/search 赤壁
/read chapters/12.md 40:100
分析 @chapters/12.md 中曹操的错误判断
/status
/clear
/exit
```

Run `nwh init ./my-novel` to create `novel-harness.yaml` and a starter `NOVEL.md` without overwriting existing files.

## Compiler setup

The compiler skeleton still uses PostgreSQL:

```bash
cp .env.example .env
docker compose up -d postgres
nwh doctor --config novel-harness.yaml
nwh db:migrate --config novel-harness.yaml
nwh ingest ./books/three-kingdoms.txt --config novel-harness.yaml
nwh status --config novel-harness.yaml
```

Production entity/event extraction, state-delta derivation, epistemic/causal builders, canon replay, and the full world simulator are not implemented yet.

## Product architecture

```text
Novel files
  │ local list / search / bounded read
  ▼
Interactive Harness CLI
  │ compiler proposals
  ▼
Compiler Harness Loop
  │ evidence / entities / events / state / knowledge / causality
  ▼
NWIR + World DB
  │ validated state and branches
  ▼
World Runtime
  │ player + NPC + background proposals
  ▼
Narrative renderer
```

The critical invariant is **proposal -> validate -> commit -> render**. An LLM never directly mutates world truth.

The compiler may inspect the complete source. Runtime characters may only receive information visible from their epistemic state.

## CLI commands

```text
nwh [--root <path>] [--continue] [-p <prompt>]
├── init [directory]
├── doctor
├── db:migrate
├── ingest <novel>
├── status
└── play
```

See [local CLI design](docs/local-cli.md), [configuration](docs/configuration.md), and [world-model design](docs/design.md).
