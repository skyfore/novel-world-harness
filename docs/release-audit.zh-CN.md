# Executable World MVP 发布验收审计

- 日期：2026-09-02
- 范围：`World/Prepared/Event` 唯一 MVP schema；不验证旧数据迁移
- 技术里程碑：T0–T10
- 产品结论：工程安全门与合成长程场景可重复验证；真实模型的人工质量阈值尚未冻结，
  因而本文不把 synthetic fixture 的满分冒充任意小说上的抽取质量。

## 1. 可重复语料分母

`fixtures/corpus/representative/` 包含三篇为本仓库原创并以 CC0-1.0 发布的中文
微型小说。它们不是三份同构 happy path，而是分别隔离三组高风险语义：

| Work | Bytes | 主要语义 | 固定证据 |
| --- | ---: | --- | --- |
| 玻璃账簿 | 563 | 欺骗、错误信念、秘密、引语归属 | SHA-256 + exact UTF-8 byte spans |
| 灰庭审判 | 798 | hidden rule、物理/规范分离、deadline/process | SHA-256 + exact UTF-8 byte spans |
| 潮汐同盟 | 846 | 背叛、关系/目标/义务变化、独占资源 | SHA-256 + exact UTF-8 byte spans |

[`benchmark-corpus.test.ts`](../test/benchmark-corpus.test.ts) 通过
`inspectBenchmarkCorpus` 验证：

1. manifest 中的 bytes 与 SHA-256 必须和 source 完全一致；
2. source 必须是 canonical UTF-8；
3. gold 必须通过 V2 reference closure；
4. 每个 evidence selector 必须落在所属 source 内、不得切断多字节字符；
5. mention、entity/event resolution、quotation、participation、relation、proposition、
   knowledge、state effect、scene、action、executable policy、character assertion 共
   13 层必须都有独立非空 denominator；
6. 该套件只声明 selected explicit annotations，不定义模型质量阈值。

## 2. 安全硬门槛

| ID | 验收项 | 直接测试证据 | 结果 |
| --- | --- | --- | --- |
| S1 | 相同 commit 的全部 typed projection hash 一致 | [`long-horizon-executable-world.test.ts`](../test/long-horizon-executable-world.test.ts) checkpoint/full replay | PASS |
| S2 | fork 后 state/knowledge/semantic/process/norm 隔离 | 同上 full-channel fork scenario | PASS |
| S3 | dangling/forged effect ref 不能产生部分 projection | [`projection-service.test.ts`](../test/projection-service.test.ts)、[`world-integrity.test.ts`](../test/world-integrity.test.ts) | PASS |
| S4 | hidden rule、他人知识、future canon 不进入 actor input | [`model-actor-policy.test.ts`](../test/model-actor-policy.test.ts)、[`player-action.test.ts`](../test/player-action.test.ts) | PASS |
| S5 | model 只能提交 capture-only proposal | [`proposal-tools.test.ts`](../test/proposal-tools.test.ts)、[`actor-action-tool.test.ts`](../test/actor-action-tool.test.ts) | PASS |
| S6 | stable ID、progress、constraint token 伪造被拒绝 | [`player-action.test.ts`](../test/player-action.test.ts)、[`world-engine.test.ts`](../test/world-engine.test.ts)、[`constraint-token.test.ts`](../test/constraint-token.test.ts) | PASS |
| S7 | empty NPC/model action 不提交 | [`hybrid-actor-runtime.test.ts`](../test/hybrid-actor-runtime.test.ts)、[`npc-reaction.test.ts`](../test/npc-reaction.test.ts) | PASS |
| S8 | EngineInvariant 与 resource conservation 失败不移动 head | [`executable-rules-processes.test.ts`](../test/executable-rules-processes.test.ts)、[`world-engine.test.ts`](../test/world-engine.test.ts) | PASS |
| S9 | renderer 不能修改 branch truth | [`world-runtime.test.ts`](../test/world-runtime.test.ts)、[`player-action.test.ts`](../test/player-action.test.ts) | PASS |

## 3. Compiler semantic matrix

V2 evaluator 和 representative gold 的对应关系如下。这里的 `PASS` 表示“有真实 scorer、
有独立 denominator、空 actual 会得到 recall=0”，不表示某个未运行的模型已经达到质量线。

| Gold dimension | Evaluator/fixture evidence | 结果 |
| --- | --- | --- |
| mention + entity/event coreference | `compiler-eval.test.ts` + representative V2 gold | PASS |
| quotation speaker/addressee | 同上 | PASS |
| proposition/attribution/acquisition | 同上；错误信念与 observed truth 分开标注 | PASS |
| event frame/roles/presence | participation + scene + frame compiler tests | PASS |
| scene/viewpoint/story time | scene gold + `scene-occurrence.test.ts` | PASS |
| temporal/causal relation + operationality | relation gold + `typed-causal-scheduler.test.ts` | PASS |
| state effects | event-bound operation scorer | PASS |
| action applicability/effect envelope | action gold + `action-ontology.test.ts` | PASS |
| rule/constraint/norm/process | 四种 policy kind 均有 denominator | PASS |
| goal/appraisal/relationship/obligation | character assertion gold + exact binding tests | PASS |

首次真实 provider/corpus 试运行之后，必须由人工审阅 false positive/negative 再冻结质量阈值；
禁止用本仓库原创文本上的 synthetic exact-match 结果自动设置 release threshold。

## 4. Runtime scenario matrix

| # | 场景 | 直接测试证据 | 结果 |
| ---: | --- | --- | --- |
| 1 | canonical replay | [`canon-replay.test.ts`](../test/canon-replay.test.ts) | PASS |
| 2 | 玩家破坏 necessary canonical precondition | [`world-runtime.test.ts`](../test/world-runtime.test.ts) forked destroyed future | PASS |
| 3 | schema 外但允许的 ad-hoc action | [`executable-rules-processes.test.ts`](../test/executable-rules-processes.test.ts) balanced transfer | PASS |
| 4 | 一人相信假消息、另一人知道真相 | long-horizon full-channel scenario | PASS |
| 5 | 秘密只进入观察/接收者知识 | long-horizon full-channel scenario + `knowledge.test.ts` | PASS |
| 6 | 违规动作物理成功，随后产生 norm consequence | `executable-rules-processes.test.ts` legal violation/prohibition | PASS |
| 7 | process/deadline 与大跨度时间推进 | [`typed-causal-scheduler.test.ts`](../test/typed-causal-scheduler.test.ts)、[`open-world-progression.test.ts`](../test/open-world-progression.test.ts) | PASS |
| 8 | NPC 主动追求 branch goal | [`hybrid-actor-runtime.test.ts`](../test/hybrid-actor-runtime.test.ts) | PASS |
| 9 | 背叛/结盟改变 relationship 与后续选择 | long-horizon branch actor-policy scenario | PASS |
| 10 | 多 actor 争夺同一资源 | long-horizon resource conflict trace + hybrid conflict tests | PASS |
| 11 | hidden physical/magic rule 阻止但不泄文案 | `player-action.test.ts` disclosure gate + `hybrid-actor-runtime.test.ts` hidden constraint revalidation | PASS |
| 12 | fork 后知识、关系、目标、过程、规范与未来全部分化 | long-horizon full-channel scenario | PASS |

## 5. 性能与可观测性

`ProjectionService.projectWithDiagnostics` 返回实际归约计划，不把 in-memory cache hit
伪装成 replay 性能。52 个 post-genesis event 的场景在第 40 个事件写 checkpoint；最终
projection 报告 53 个 ancestry commit、checkpoint 内 41 个 history event、只归约 12 个
tail commit/event。checkpoint projection 与禁用 checkpoint 的全量 replay 在 state、knowledge、
semantics、processes、norms、scenes、causality、history 八个 channel 上逐项 hash 相同。

`WorldRuntime.move` 的 host-private `WorldMoveTrace` 对每个实际尝试的 candidate 记录：

- player/actor/background lane 与 candidate source；
- materiality/conflict/validation/commit gates 及接受/拒绝原因；
- action/canonical role bindings；
- read/write/resource/participant footprint；
- background scheduler gates、causal resolution 与稳定 tuple；
- committed event effect refs；
- before/after head、event hash 与 atomic commit boundary。

`actorSafeWorldMoveTrace` 只保留 lane、status、是否 committed 和聚合计数；proposal/entity ID、
gate detail、footprint、scheduler、effect refs 与 commit ID 全部删除。完整 trace 仅保留在宿主侧
turn outcome 与持久化 player-turn audit 中，CLI/Web player response contract 不返回它。

Compiler batch recovery/accounting 由 `compiler-batches.test.ts`、
`source-accounting-tools.test.ts`、`repair-existing.test.ts` 验证；actor/model call 的 deterministic
budget 由 `hybrid-actor-runtime.test.ts` 与 `model-actor-policy.test.ts` 验证。

## 6. Release commands

发布候选必须在同一提交上完成：

```text
pnpm run check
pnpm test
pnpm test:e2e
git diff --check
```

具体文件数、测试数和 E2E 结果记录在
[`implementation-status.md`](implementation-status.md) 与 T10 完成说明中。
