# Novel World Harness

A CLI-first **executable narrative world compiler and runtime**.

The goal is not to build a novel RAG chatbot. The harness compiles a novel into a temporal, evidence-backed world model that can be replayed and then diverged. A user can select a character, enter the timeline at a valid point, make decisions, and let the world continue evolving until that character exits the story.

## Why Pi

The project embeds the Pi SDK instead of forking Pi. Pi already provides a compact agent runtime, provider/model abstraction, persistent sessions, extension hooks, terminal-oriented interaction, and programmatic SDK/RPC modes. Novel World Harness owns the domain loop, database, world state, causality, and runtime invariants.

Current target: `@earendil-works/pi-coding-agent 0.84.1`.

## Status

**Phase 0 / foundation**

Implemented in this initial scaffold:

- CLI entry point (`nwh`)
- YAML + environment based configuration
- model profiles and per-worker model routing
- PostgreSQL connection layer and initial schema
- compiler loop state machine and readiness metrics
- Pi SDK adapter boundary
- commands: `init`, `doctor`, `db:migrate`, `ingest`, `status`, `play`
- design docs for compiler, NWIR, world runtime, and Pi integration

Not yet implemented:

- production entity/event extraction workers
- state-delta derivation workers
- epistemic and causal graph builders
- canon replay evaluator
- full NPC/world simulator
- polished Pi-style TUI

## Quick start

```bash
cp config.example.yaml novel-harness.yaml
cp .env.example .env
docker compose up -d postgres
npm install
npm run build

nwh doctor --config novel-harness.yaml
nwh db:migrate --config novel-harness.yaml
nwh ingest ./books/three-kingdoms.txt --config novel-harness.yaml
nwh status --config novel-harness.yaml
```

For development:

```bash
npm run dev -- doctor --config config.example.yaml
```

## CLI shape

```text
nwh
├── init
├── doctor
├── db:migrate
├── ingest <novel>
├── status
└── play [--character <id>] [--at <time>]
```

Long term, invoking `nwh` with no subcommand should open the interactive terminal runtime, similar in spirit to Claude Code/Pi.

## Configuration

The harness never requires API keys inside YAML. Profiles reference environment variables:

```yaml
llm:
  profiles:
    main:
      provider: anthropic
      model: claude-sonnet-4-6
      apiKeyEnv: ANTHROPIC_API_KEY
```

A profile can optionally override `baseUrl`/`apiProtocol` for gateways or compatible providers. Worker roles route independently to profiles.

See [docs/configuration.md](docs/configuration.md).

## Architecture

```text
Novel
  │
  ▼
Compiler Harness Loop
  │
  ├─ evidence / segmentation
  ├─ entities / aliases
  ├─ events / timeline
  ├─ state deltas
  ├─ knowledge states
  ├─ causality
  └─ verification / replay
  │
  ▼
NWIR + World DB
  │
  ▼
World Runtime
  │
  ├─ player action
  ├─ NPC proposals
  ├─ background events
  ├─ validation/adjudication
  ├─ event commit
  └─ state transition
  │
  ▼
Narrative renderer
```

The critical invariant is **proposal -> validate -> commit -> render**. The LLM does not directly mutate world truth.

See [docs/design.md](docs/design.md).
