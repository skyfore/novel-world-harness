# Configuration

The interactive CLI can start without a configuration file. Its defaults are:

- workspace: current directory;
- Pi provider/model: `anthropic/claude-sonnet-5`;
- credential: `ANTHROPIC_API_KEY`;
- state and sessions: `.novel-harness/`.

`init`, `doctor`, `ingest`, and `status` use `novel-harness.yaml`. Supply a different path with `--config`. `${NAME}` references are expanded before YAML validation; a missing environment variable is an error.

## Pi model profiles

```yaml
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
    verifier: main
    narrator: main
```

Pi, rather than Novel Harness, owns provider transport. A custom OpenAI-compatible endpoint can be described without changing CLI code:

```yaml
profiles:
  local:
    provider: local-openai
    model: novel-model
    baseUrl: http://127.0.0.1:8080/v1
    apiProtocol: openai-completions
    apiKeyEnv: LOCAL_LLM_API_KEY
    contextWindow: 131072
    maxTokens: 8192
```

`apiKeyEnv` is optional for Pi-managed authentication and, when present, must name an `*_API_KEY` variable. Secrets stay in environment variables and must not be committed to YAML.

## Local workspace state

There is no database configuration. Phase 0 state is stored locally:

```text
.novel-harness/
├── project.json
├── metrics.json
├── sources/<content-id>.json
├── jobs/<job-id>.json
├── sessions/<pi-session>.jsonl
└── instructions.md
```

JSON writes use a temporary file plus atomic rename. Source manifests record the workspace-relative path, hash, size, and registration time; source content remains in its original file. `.novel-harness/` is excluded from model file discovery, except that `instructions.md` is loaded explicitly as trusted project guidance.

## Harness and runtime

- `maxLoops`: hard safety bound for one compiler run.
- `maxConcurrentWorkers`: future worker concurrency cap.
- `batchSize`: future compiler batch size.
- `checkpointEvery`: report cadence.
- `targetCoverage`: readiness thresholds.
- `defaultPlayerMode`: `canon-character`, `reader-possession`, or `observer`.
- `canonAttractorWeight`: weak canonical prior while divergence is low.
- `divergenceDisableCanonAt`: stop future canon guidance past this divergence.
- `snapshotEveryEvents`: branch snapshot cadence.
