# Configuration

The default configuration file is `novel-harness.yaml`. A different path can be supplied with `--config`.

Environment references use `${NAME}` syntax and are expanded before YAML validation. Missing variables are errors.

## LLM profiles

```yaml
llm:
  defaultProfile: main
  profiles:
    main:
      provider: anthropic
      model: claude-sonnet-4-6
      apiKeyEnv: ANTHROPIC_API_KEY
      thinkingLevel: high
    fast:
      provider: openai
      model: gpt-5.6-mini
      apiKeyEnv: OPENAI_API_KEY
      thinkingLevel: low
  routing:
    controller: main
    extractor: fast
    verifier: main
```

Profiles make model choice a deployment concern rather than hard-coded worker behavior.

Supported profile fields:

- `provider`
- `model`
- `apiKeyEnv`
- `thinkingLevel`
- `baseUrl` (optional gateway/proxy)
- `apiProtocol` (optional Pi API protocol for custom providers)
- `contextWindow`
- `maxTokens`

Secrets should remain in environment variables or Pi credential storage; never commit them to YAML.

## Database

```yaml
database:
  url: ${DATABASE_URL}
  poolMin: 0
  poolMax: 10
  statementTimeoutMs: 30000
```

PostgreSQL is authoritative. The initial schema intentionally uses JSONB for evolving NWIR payloads while preserving first-class tables for identities, evidence, events, branches and harness jobs.

## Harness

- `maxLoops`: hard safety bound for one compiler run.
- `maxConcurrentWorkers`: worker concurrency cap.
- `batchSize`: default amount of work assigned in a compiler batch.
- `checkpointEvery`: persist/report loop state every N iterations.
- `targetCoverage`: readiness thresholds.

## Runtime

- `defaultPlayerMode`: `canon-character`, `reader-possession`, or `observer`.
- `canonAttractorWeight`: weak canonical prior while divergence is low.
- `divergenceDisableCanonAt`: stop future canon guidance past this divergence.
- `snapshotEveryEvents`: branch snapshot cadence.
