# 小说全流程编译命令

`nwh compile-novel` 从不可变原文一直执行到独立评估、认证、激活和可玩分支交付。默认继续已有编译进度；`--rebuild` 明确启动全量重编。完成标准遵循[小说编译流程与完整性验收规范](novel-compilation-protocol.zh-CN.md)。

```sh
# 首次编译：登记原文并执行全流程
nwh compile-novel fixtures/corpus/longzu_1.txt

# 已登记小说：默认续编
nwh compile-novel --source a28585b1cf867f3e3a16

# 全量重编。若该次重编已中断，则继续同一次重编。
nwh compile-novel --source a28585b1cf867f3e3a16 --rebuild

# 只读查看各阶段、历史回执、实际缺口和独立评估状态
nwh compile-novel status --source a28585b1cf867f3e3a16
```

各入口支持 `--root`、`--config`、`--source` 和 `--model`。全流程自动执行常规步骤，无需逐阶段确认；模型提案仍必须经过原有验证和提交屏障。`--branch` 可指定交付分支，已有分支固定的历史版本不能被覆盖。

## 可单独执行的阶段

全流程与阶段命令使用相同实现。单独执行一个阶段只声明该阶段完成，不声明整部小说可用。

| 子命令 | 工作与交付 |
| --- | --- |
| `source [novel]` | 登记／校验不可变来源，准备当前结构计划 |
| `recover` | 新模型工作开始前恢复原始 finish 回执及已授权的上游修复 |
| `batches` | 继续结构发现、观察、身份与语义、可执行建模、跨片段边界批次 |
| `structure`、`observation`、`semantic`、`executable`、`boundary` | 只执行所选批次阶段；前序依赖仍须完成 |
| `converge` | 验证并提交待处理提案，保留被拒草稿和未解决义务 |
| `opening` | 建立有来源证据的初始世界 |
| `roles` | 独立全文角色复核，登记主要角色能力要求 |
| `repair` | 恢复已授权的上游修复，执行图关系和世界语义修复 |
| `requirements` | 重验已登记要求、关键延后项及全局闭合条件 |
| `archive` | 归档不可变候选；不改变 active 指针，不授予认证 |
| `evaluation-plan` | 生成／复用／导入并冻结独立 gold、字段支持复核和逐主要角色场景规格 |
| `evaluate` | 执行独立真实 Pi 实验，复用相同候选和规格下已完成的实验 |
| `certify` | 检查全部认证门禁，归档带认证的候选，尚不激活 |
| `activate` | 验证候选仍对应当前编译输入，再切换 active 指针 |
| `branch` | 创建或复用固定到当前认证版本的可玩分支 |
| `status` | 只读快照；不调用模型、不迁移、不重验、不激活 |

例如修正角色复核后继续后续流程：

```sh
nwh compile-novel roles --source <source-id>
nwh compile-novel --source <source-id>
```

默认续编会重新核对每个阶段的当前证据：复用批次检查点、原 finish 回执、已完成角色审阅、同候选的冻结评估规格及有效实验结果。历史调度记录中的 `completed` 不能替代当前版本的认证。

## 独立规格与评估

没有适用规格时，`evaluation-plan` 使用独立 Pi 会话读取整部不可变原文、分项提交 gold 和场景草稿、复核可执行字段的来源支持。它没有修改世界真值的工具。草稿、原文阅读页偏移、真实审阅 trace ID、纠正次数和停止条件均持久化。完成冻结前检查全文阅读范围、规格引用、主要角色分母及入口切面。

也可提供人工或外部独立审阅后的 JSON，格式为 `novelEvaluationPlanInputSchema`：

```sh
nwh compile-novel --source <source-id> --evaluation-plan reviews/novel-evaluation.json
nwh compile-novel evaluation-plan --source <source-id> --evaluation-plan reviews/novel-evaluation.json
nwh compile-novel evaluate --source <source-id> --plan-hash <frozen-plan-hash>
```

完整通过仍要求现有 `novel-play-v1` 策略：独立语义指标、关键检查、机制支持、全部主要角色的入口探针，以及每个主要角色三次独立真实 Pi 实验；每次须达到 50 个实质提交或验证的合法终止，并通过任务、知识隔离和重放要求。单元测试和确定性测试夹具不能取得真实 Pi 认证。

候选变化后旧评估失效，重新冻结并执行相应评估。确定性预检失败时先返回具体缺口；失败或写入状态不确定的真实实验保留原 ID、trace 与分支，要求按诊断恢复，不通过生成新实验或更换规格清掉失败。

## 重编、阻塞与恢复

全量重编先检查原有未解决义务、待恢复 finish、待处理提案及其他修复任务；存在这些状态时保留原任务并明确停止。可归档的当前候选先作为不可变基底保留，然后失效本来源的当前编译产物和批次完成标记。历史失败、要求账本、归档版本、active 与已有分支历史保留。初始化完成后，中断恢复不再清空已完成的新批次。

失败信息给出实际阶段、原始诊断和可单独执行的阶段命令。已有授权的上游修复可用 `--upstream-plan <hash>` 继续；需要原始宿主 finish 审阅时配合 `--upstream-finish <path>`。本命令不把诊断计划自动变成写权限，也不绕过宿主审查、来源不足、未映射能力或持久化熔断。

只有最后的认证、激活和分支交付全部通过，才输出 `Novel compilation complete`。出现阻塞会以非零状态退出；72/72 批次、零执行义务或候选归档均不能触发该完成声明。

旧的 `compile-source`、`prepare-all`、`rebuild`、`reparse`、`repair-existing`、`requirements` 和 `prepared-cache` 入口保留兼容。其中 `prepare-all --candidate-only` 仍只负责候选准备；完整交付请使用 `compile-novel`。
