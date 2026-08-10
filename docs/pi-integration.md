# Pi integration strategy

Current compatibility target: `@earendil-works/pi-coding-agent 0.84.1` on Node.js `>=22.19.0`.

## Decision

**Embed Pi through its SDK. Do not fork Pi core for the initial implementation.**

Pi already exposes the pieces this project needs:

- `ModelRuntime` for provider/model/auth management
- `createAgentSession()` for programmable agent sessions
- custom tools and extensions
- session persistence and branching
- SDK, RPC and interactive run modes
- terminal UI components
- model/provider overrides and custom endpoints

Novel World Harness should own all domain-specific orchestration and treat Pi as the LLM/agent execution substrate.

## Why SDK instead of a Pi package only

A Pi extension/package is excellent for adding commands/tools to the stock `pi` CLI, but this project needs to own:

- the compiler loop lifecycle
- Postgres transactions
- world-build scheduling
- runtime branch ownership
- command semantics (`ingest`, `status`, `play`)
- future server/API process boundaries

Embedding the SDK allows the project to keep its own executable (`nwh`) while still using Pi's provider/runtime/session machinery.

## Why not fork

Forking immediately would couple world-model development to Pi internals and upgrades. Current Pi extension/SDK surfaces are broad enough that a fork is only justified if a proven blocker appears in:

1. terminal lifecycle control,
2. model runtime isolation,
3. session replacement/branching,
4. tool/event interception, or
5. custom rendering.

Until then, keep Pi behind `src/llm/pi-session.ts`.

## Configuration mapping

Harness model profiles map onto Pi models:

```yaml
llm:
  defaultProfile: main
  profiles:
    main:
      provider: anthropic
      model: claude-sonnet-4-6
      apiKeyEnv: ANTHROPIC_API_KEY
      thinkingLevel: high
```

At runtime:

1. create `ModelRuntime`;
2. optionally write a project-local Pi model override for `baseUrl`;
3. inject API key with `setRuntimeApiKey()` from the configured environment variable;
4. resolve model through `modelRuntime.getModel(provider, model)`;
5. create a dedicated `AgentSession` for a worker invocation or long-lived interactive role.

Worker roles route to named profiles, so extraction can use a faster/cheaper model while verification or simulation uses a stronger one.

## Session policy

Compiler workers should default to short-lived or tightly scoped sessions. Their durable memory is the database, not chat history.

Runtime/player sessions can be long-lived, but context must be rebuilt from world state and character memory rather than relying on an indefinitely growing transcript.

## TUI path

Phase 0 uses a minimal terminal shell around Pi sessions. Later phases can adopt Pi's TUI components/InteractiveMode for:

- build progress
- coverage/readiness dashboard
- character selection
- timeline/branch status
- model/tool visibility
- compact event rendering

A future browser UI should talk to the same application/runtime layer, not reimplement the harness.
