# Repository guidance

## Product intent
This repository builds a CLI-first novel world compiler and runtime. The source novel is compiled into a verifiable executable world model. The runtime then allows a user to inhabit a character and drive an alternate timeline without railroading back to canon.

## Architectural invariants
- Original source evidence is the ground truth boundary.
- LLM output is always a proposal until validated and committed.
- Narrative rendering never writes world truth directly.
- Dynamic facts belong in temporal state/event data, not static entity records.
- Character knowledge is isolated from world truth and future canon.
- Compiler and runtime remain separate subsystems.
- Canon is a baseline/structural attractor, not a mandatory script.

## Engineering defaults
- TypeScript, ESM, Node >= 22.19.
- PostgreSQL is the source of truth.
- Prefer deterministic code for time, state, inventory, identity, locations, and invariants.
- Use Pi SDK for LLM runtime, model/provider integration, sessions, and terminal interaction.
- Avoid forking Pi unless a hard SDK limitation is proven.
