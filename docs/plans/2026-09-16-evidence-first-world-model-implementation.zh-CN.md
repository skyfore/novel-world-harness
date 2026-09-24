# 证据优先世界模型：首批实施记录

日期：2026-09-16。起点 `335cdfe2c8ba3b7c626f978d82c700d6a26ece8b`。分支 `codex/compiler-recovery-fixes`。

对应[技术方案](2026-09-16-evidence-first-world-model.zh-CN.md)。这是实施与验证范围说明，不是某部小说的运行记录。未解析具体小说、未执行历史补修脚本、未修改用户 NWH_HOME、未恢复 run-records。

后续核验：基于 `bdf79b8` 的本地工具链检查及集成测试结果见 [Review 落地设计 §9](2026-09-16-review-to-capability-closure.zh-CN.md#9-本次核验与方案完成边界)。下文保留首次实施时的环境与证据，不以历史未运行状态代替最新检查，也不因测试通过宣称 T4–T10 已实现。

## 1. 已提交内容

| 提交 | 内容 | 状态 |
| --- | --- | --- |
| `cc3e803954c01c2980d0159402aa4d0bed73b9e8` | 完整技术方案，8 组历史依据、10 组源码依据、8 组一手资料、D1–D9 决策、T0–T10 顺序及迁移/验收要求 | 已推送 |
| `3cdf785131912684185f66cff2a12efe891c53ea` | 字段级引文覆盖内核，接入原 attribution validator；15 个 native 测试，1 个 Vitest 生产入口回归 | 已推送；native 通过，Vitest 未运行 |
| `821c7ca5cc23e74e977dd5c646f2bde41e52040f` | requirement 内核、场景适配器、接入 evaluateSceneCapabilities；29 个 native 测试，3 个 Vitest 集成用例 | 已推送；native 和转译后适配器检查通过，Vitest 未运行 |
| 本文所在提交 | 独立测试命令、使用/恢复协议、验收边界及后续里程碑说明 | 不改变依赖版本或 lockfile |

通过 GitHub Git data/contents 接口创建提交并以 `force=false` 更新现有分支；没有新建分支、强推或覆盖历史。

## 2. 真实接入点

`src/compiler/attribution-trace.ts` → `assessQuotationContentSupport()`：现有 proposal trace 与 committed attribution trace 复用的新检查。保留真实错误和原同作用域检索/一次纠正指导。结构字段不能替内容字段；没有精确对象证据的历史兼容路径仍不被宣称为已证实。

`src/eval/scene-capabilities.ts` → `buildSceneRequirementAssessment()` → `assessSemanticRequirements()` / `planRequirementRepairs()`：在原文哈希和锚点验证、独立场景探针之后生成额外报告。旧 `verified` 条件仍保留并与新完整性条件取合取，不放宽。独立 expectation 被保留，部分成功和依赖阻塞分别报告。

当前 requirement 是**只读诊断**，不是持久全局 ledger 或修复执行器。它不消费/清除原 finish receipt、proposal obligation、accounting 或 source-wide deferral；不能被当作新发布许可。

## 3. 实际执行的验证

| 检查 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `node --experimental-strip-types --test test/contracts/*.native.mjs` | 44 tests，44 pass，0 fail；重复执行仍通过 | 15 个内容覆盖测试 + 29 个 requirement/修复规划测试，直接加载真实纯函数源码，无世界引擎 mock |
| 严格 TypeScript 检查两个内核，开启 `strict`、`noUncheckedIndexedAccess` | 通过 | `content-support.ts` 与 `semantic-requirements.ts`，不是全仓检查 |
| TypeScript `transpileModule` 语法/转译检查 | 4 文件通过 | 两个内核、scene-requirements 适配器、scene-requirements Vitest 文件；不是依赖解析后的类型检查 |
| 执行转译后的生产 scene-requirements 适配器 | 通过 | 部分成功、缺结果、unmapped 保留、诊断权限和未知结果拒绝；不等于执行完整 scene-capabilities 引擎 |
| 读取 GitHub 已提交文件 blob SHA | 三个生产新模块与本地已测文本一致 | 内容覆盖内核、requirement 内核、scene 适配器 |
| 查看提交 diff | 归因入口的修改局限在 import 和原内容检查；其余生产逻辑保留 | 防止全文替换时意外改动不相关代码 |

执行环境实际为 Node `v22.16.0`、TypeScript `5.8.3`。项目要求 Node `>=22.19.0`，锁定 TypeScript `~5.9.3`。因此离线结果只是内核级证据，**不构成符合项目指定工具链的 release 验收**。没有修改项目引擎约束来迁就本次环境。

本地 `git clone` 对 github.com 的 DNS 解析失败；npm registry 也返回 EAI_AGAIN，无法安装本项目完整依赖。因此以下项目明确未完成：`pnpm test`、`pnpm check`、两个新增 Vitest 文件的 4 个集成用例、全量 build、Playwright、真实 Pi/LLM、整书 rebuild 和 Play 分歧实验。没有引用历史 1026/984 项通过记录来冒充本次结果。

### 3.1 可复核 blob 哈希

- `src/compiler/content-support.ts`：`1444153d5c4881f9fc75d8a66a2316004450ae5d`
- `src/compiler/semantic-requirements.ts`：`8b4b0dd6d31839e1635cde5cb97946bdfa1ae650`
- `src/eval/scene-requirements.ts`：`640a37642a9792927cfb887afebee538940a921a`

这些是 Git blob SHA，不是 source 文本 SHA-256、编译回执或世界认证指纹。

## 4. 里程碑结论

T0：方案完成。T1：代码接入完成，内核已验证，集成待验证。T2：诊断性 requirement 与修复计划接入完成，内核/适配器已验证，完整 evaluator 集成待验证。T3：测试入口和固定用例已提交，离线检查已完成，**全仓验收尚未完成**。

T4–T10 仍是明确规划，未实现：持久 SemanticEffect 全链路、Expression/Perception/Acquisition、临时状态和规范范围模块、非物理主体渠道、统一时间与机制归纳、持久 requirement ledger 与通用受限执行器、schema/pipeline 迁移及真实 rebuild/Play 验收。首批代码没有通过增加几个字段宣称这些能力已经存在。

本轮也没有顺带修复上一轮报告中的所有其他问题，例如覆盖证明对 active revision 的完整绑定、所有 reconciliation 的语义修订保护、跨会话重试预算。它们由后续受限修订/失效协议统一处理，不能从本次通过的测试外推为已经解决。

## 5. 下一阶段的硬性条件

首先在项目规定的 Node/pnpm/TypeScript 版本下运行 `pnpm test:semantic-contracts`、`pnpm test`、`pnpm check`，修复任何集成回归后再把首批代码标为可发布。此处是实施待办，不代表已创建后台任务。

随后按 T4 做 SemanticEffect 的最小纵向链：原文受支持但未执行化的概念 → 窄类型 proposal → evidence/identity 验证 → finish/convergence → compilerSnapshot/closure → rebuild 保留 → runtime 对 unmapped 明确拒绝执行。使用原创短片段，不读取特定小说补数据。

只有这条链通过后，才推进获知关系、状态过程和主体渠道迁移。不得先批量新增未接入的 schema，也不得以降低 publication gate 替代验证。
