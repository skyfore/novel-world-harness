# 编译恢复与独立能力验收实施计划

起点：2026-09-08 深度审计，`e00eb9d`；[事故记录](../incidents/2026-09-08-accounting-obligation-rebase.md)。

本轮交付是可提交的宿主协议修复、审计工具和回归验收。每个步骤单独提交，使用真实事故的调用顺序在隔离 fixture 中复现。全书模型续跑、发布 candidate、模型对比实验是后续执行工作，不能用本轮测试结果替代其真实运行结果。

## 任务与验收

| ID | 依赖 | 技术任务 | 完成条件 | 状态 |
| --- | --- | --- | --- | --- |
| T0 | — | 固定案例、原始审计与技术计划 | timeline 与证据可追溯，历史和实施结果分离 | 完成，`867a887` |
| T1 | T0 | 将需要宿主裁定的错误传递到调度器 | 工具结果或持久 journal 任一表明禁止重试，均不新建 recovery session；一次可修正失败仍可恢复 | 完成 |
| T2 | T1 | 持久化账本页身份并诊断 coverage 变化 | 返回精确差分、同作用域 discovery、原 proposal ID 和一次修正 SOP；失败无部分 staging | 完成 |
| T3 | T2 | 基于完整覆盖证明消解旧 accounting 义务 | 宿主验证每个旧单元和依赖；保留失败历史；跨源/跨批/缺单元/撤回依赖均不能通过 | 待实施 |
| T4 | T3 | 从实际工件生成编译状态 | source hash、版本、有效 completed set、stage counts、持久 blocker、run 与 candidate/closure 分别可见 | 待实施 |
| T5 | T0 | 增加来源独立的场景能力验收及受限返修诊断 | 入学 agency、空效果、规范适用域和知识 cut 分别检查；不足明确 blocked/unknown；不能由 schema 自证正确 | 待实施 |
| T6 | T3 | 给 finish 跨文件副作用增加恢复回执 | 指纹绑定一次 finish；中断后幂等恢复 acceptance/review，checkpoint 必须有完成证明 | 待实施 |
| T7 | T1–T6 | 集成回归、现场只读复核与实施结果记录 | 类型检查和相关/全量测试通过，提交逐项可审查；如实记录实际小说状态 | 待实施 |

## 设计边界

- 模型继续只产生窄类型 proposals，不获得通用文件写入或 host review 工具。
- 义务状态是操作协议状态，不是世界真值。覆盖消解只证明 source-accounting 工作已由其他有效工作覆盖。
- 合法无效果事件仍允许；独立验收必须给出来源、预期与判定范围，不用关键词猜测枪击死亡或角色知识。
- 返修诊断必须指出应回到的 semantic/executable 阶段、具体实体/事件、缺失证据或机制。不能为了当前阶段通过而静默改写先前阶段。
- 继续沿用内容寻址的原文和本地文件存储、现有 compiler 锁和事件投影模型。
- 不通过删除 checkpoint、清空 staging、放宽 exact selector 或手写正式小说世界来解除问题。

## 实施日志

- 开始：确认分支 `codex/compiler-recovery-fixes`，当前 HEAD 与审计一致。未提交改动只有本案例的审计报告、证据快照、历史 guardian 原文与 issues 更新。
- T0：写入案例与本计划；保存前一轮审计作为历史记录。
- T1：宿主读取结构化 recovery 与旧 Pi tagged JSON；创建会话、处理报告、处理网络异常时均检查持久义务。修正 source/prompt recovery 中错误建议换 proposal ID 的文字。6 个相关测试文件、74 项测试通过；服务端 TypeScript 检查通过。回归直接确认原有 blocker 创建 0 次会话，运行中新 blocker 只创建 1 次，可纠正失败仍能创建第 2 次并完成。
- T2：保存单次使用页回执并添加 `coverage-changed` 差分与同身份 SOP。21 句隔离 fixture 重现旧 20 单元中 1 个新增证据覆盖、新页 19+1 的顺序；验证零部分 staging、跨 session 正确修复及消费后的 token 不可复用。3 个相关文件、34 项测试通过；服务端类型检查通过。
