# Configuration

The interactive TUI can start without a configuration file. Defaults are:

- workspace: current directory;
- Pi provider/model: the user's Pi selection, otherwise Pi's first available authenticated model;
- authentication: Pi `/login`, a Pi-managed credential, or an optional profile environment variable;
- world data: the workspace's `.novel-harness/` directory;
- terminal sessions: the user's `~/.novel-harness/` directory.

The TUI can open without credentials. NWH directly uses Pi's native user-level
authentication, model catalog, and default model settings from `~/.pi/agent/` (or
Pi's configured agent directory). Existing Pi login and model selection therefore
work without a second NWH setup. Inside NWH, `/login` and `/model` update that same
Pi state. An explicit `--model` or configured role profile overrides the default
selection for that invocation.

`nwh init` writes only a provider-neutral project section; `llm` is optional. `init`, `doctor`, `ingest`, and `status` use `novel-harness.yaml` when present. Supply a different path with `--config`. `${NAME}` references are expanded before YAML validation; a missing referenced variable is an error.

## Pi model profiles

```yaml
version: 1

project:
  name: demo-world
  language: zh-CN

llm:
  defaultProfile: main
  profiles:
    main:
      provider: anthropic
      model: claude-sonnet-5
      apiKeyEnv: ANTHROPIC_API_KEY
      thinkingLevel: medium
      maxTokens: 8192
    fast:
      provider: anthropic
      model: claude-haiku-4-5
      apiKeyEnv: ANTHROPIC_API_KEY
      thinkingLevel: low
      maxTokens: 4096
  routing:
    controller: main
    extractor: fast
    narrator: main
```

The current terminal harness consumes three role routes:

- `controller`: guided `nwh compile` sessions;
- `extractor`: bounded `compile-source` batches;
- `narrator`: ordinary `nwh` / `nwh play` sessions and the restricted `play-world` action translator.

Unknown routes are allowed for future adapters, but they have no effect until code asks for that role.

Pi owns provider transport. A custom compatible endpoint can be described without changing CLI code:

```yaml
llm:
  defaultProfile: local
  profiles:
    local:
      provider: local-openai
      model: novel-model
      baseUrl: http://127.0.0.1:8080/v1
      apiProtocol: openai-completions
      apiKeyEnv: LOCAL_LLM_API_KEY
      contextWindow: 131072
      maxTokens: 8192
  routing: {}
```

`apiKeyEnv` is optional. Omit it when using Pi-managed `/login` authentication;
when present, it must name an `*_API_KEY` variable. Secrets stay in environment
variables or the private Pi auth store and must not be committed to YAML.

## Local workspace state

There is no database configuration. Current state is stored locally:

```text
.novel-harness/
├── project.json
├── sources/<content-id>.json
├── segments/<source-id>.json
├── live-tests/token-budget-v1.json
├── instructions.md
└── world/v1/
    ├── compiler/batches/<source-id>.json
    ├── proposals/{pending,accepted,rejected}/
    ├── canon/
    ├── objects/
    ├── branches/
    ├── play/active.json
    ├── frontier/
    └── snapshots/
```

JSON control files use a temporary file plus atomic rename. Source manifests record the workspace-relative path, hash, size, and registration time; source content remains in its original file.

`.novel-harness/` is excluded from normal model file discovery. Only `.novel-harness/instructions.md` is loaded explicitly as trusted project guidance. Retrieved source excerpts may appear in persisted Pi transcripts.

Synthetic readiness thresholds and unused runtime tuning fields are intentionally not configuration. Inventory is reported by `nwh status`; evidence and consistency are checked by `nwh audit`; semantic quality must be measured against an explicit annotated corpus.
