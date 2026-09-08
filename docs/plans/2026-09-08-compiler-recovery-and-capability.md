# 编译恢复与独立能力验收实施计划

起点：2026-09-08 深度审计，`e00eb9d`；[事故记录](../incidents/2026-09-08-accounting-obligation-rebase.md)。

本轮交付是可提交的宿主协议修复、审计工具和回归验收。每个步骤单独提交，使用真实事故的调用顺序在隔离 fixture 中复现。全书模型续跑、发布 candidate、模型对比实验是后续执行工作，不能用本轮测试结果替代其真实运行结果。

## 任务与验收

| ID | 依赖 | 技术任务 | 完成条件 | 状态 |
| --- | --- | --- | --- | --- |
| T0 | — | 固定案例、原始审计与技术计划 | timeline 与证据可追溯，历史和实施结果分离 | 完成，`867a887` |
| T1 | T0 | 将需要宿主裁定的错误传递到调度器 | 工具结果或持久 journal 任一表明禁止重试，均不新建 recovery session；一次可修正失败仍可恢复 | 完成 |
| T2 | T1 | 持久化账本页身份并诊断 coverage 变化 | 返回精确差分、同作用域 discovery、原 proposal ID 和一次修正 SOP；失败无部分 staging | 完成 |
| T3 | T2 | 基于完整覆盖证明消解旧 accounting 义务 | 宿主验证每个旧单元和依赖；保留失败历史；跨源/跨批/缺单元/撤回依赖均不能通过 | 完成 |
| T4 | T3 | 从实际工件生成编译状态 | source hash、版本、有效 completed set、stage counts、持久 blocker、run 与 candidate/closure 分别可见 | 完成 |
| T5 | T0 | 增加来源独立的场景能力验收及受限返修诊断 | 入学 agency、空效果、规范适用域和知识 cut 分别检查；不足明确 blocked/unknown；不能由 schema 自证正确 | 完成 |
| T6 | T3 | 给 finish 跨文件副作用增加恢复回执 | 指纹绑定一次 finish；中断后幂等恢复 acceptance/review，checkpoint 必须有完成证明 | 完成 |
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
- T3：增加默认只读、显式 `--apply` 且持有 compiler 锁的 host accounting review。证明逐项绑定源哈希、原始失败输入、原单元、依赖内容和审计链；原失败不删除，依赖失效会重新阻塞。补纯读取 Workspace/Trace 入口，防止审计读取触发初始化和运行中断标记。6 个相关文件、51 项测试通过；服务端类型检查通过。
- 2026-09-08 16:18:42.222 UTC：在 T3 工作树上只读运行真实 p07 review，已从原审计 seq 395→412→413 验证完整 20 单元：19 来自 `acct-00007-p07b`，1 来自 `prop-norm-freedom-day-00007`。预览保存在 `run-records/2026-09-07-longzu1-full-rebuild/remediation-2026-09-08/coverage-preview.json`；未对真实小说使用 `--apply`，无新模型调用、checkpoint 或 candidate。
- T4：增加 `nwh status --json --source <id>`；状态与编译器共享分组、批次身份和阶段顺序，检查原文与 segment manifest 是否一致，只统计当前版本/计划中的 checkpoint。候选归档、既存 closure、全书 readiness 分开显示。类型检查通过；状态、批次与分段的 53 项回归通过，另验证 candidate 存在但无 assessment 时明确输出 not-run。
- 2026-09-08 16:29:48.422 UTC：实际 `status --json` 确认为 52/71、observation 23/23、semantic 23/23、executable 6/23、boundary 0/2；仅 p07 当前义务需要 host review。原文校验通过，无 compiler lock，无 candidate。只读状态保存在同一 remediation 目录的 `compiler-status.json`。
- T5：新增只读 `review-scenes --spec <JSON>`。预期文件绑定独立来源审查身份、原文哈希和 exact anchors；事件效果与机制分别对照预期，使用真实范式解释器执行显式状态探针、规范时限和角色知识 cut。诊断生成限定阶段/工件/原文的返修任务，不提交世界事实。4 个相关测试文件共 18 项通过，类型检查通过；包含空 schema 自证陷阱、agency、合法无变化、未知状态、不存在的效果映射和知识隔离。
- 2026-09-08 16:47 UTC：完成 5 项真实场景只读检查并保存 spec 与 review。入学和规范范围为 blocked，两起枪击为 unsupported（暂时失能概念需本体设计），知识 cut 为 unknown（缺获知操作及已确认 claim 身份）；命令按设计退出 2。独立审查由本次 Codex 原文阅读建立，尚无人类复核；规范时间是显式合成探针，不冒充实际 branch 时间。
- T6：在所有带 source/batch 作用域的 finish 校验之后、首个跨文件副作用之前保存 prepared 回执，绑定输入、pipeline、原文/segments、工件内容和标题/章节/角色复核元数据。宿主恢复重跑同一次 finish 校验及幂等 acceptance/review，完成回执后才允许生产 source-batch checkpoint。模型不能修改冻结草稿或通过重启续写 finish。只读 status 增加回执时间与恢复状态。
- T6 验证：10 个相关测试文件、102 项通过，服务端类型检查通过；另新增章节 manifest 已写而 split plan 未写的中断测试后，该文件 5 项通过。故障注入覆盖 annotation acceptance、accounting acceptance、review 写入、完成回执前、checkpoint 前和标题已接受的窗口；重复恢复不重排 review 时间，不增加接受记录，改输入/撤回依赖不能恢复。正常章节和角色复核也能幂等恢复。显式 reparse、resume=false 与缓存 materialization 归档被替换回执及原因，保留历史；legacy 无回执恢复输入仍受原有校验。本轮不声称提供断电级多文件事务。
- T7 集成补齐：全量测试首先检出 5 个使用旧 finish 协议的用例，进一步复核后将 TUI source-loop 也接入宿主恢复与持久 checkpoint 校验；仅有模型成功消息不能前进，host fatal 或 prepared 回执不能触发特殊阶段草稿清空。显式迁移旧批次时归档回执，测试确认不重新激活被后续解析替代的身份/事件决议。场景验收进一步要求完整操作顺序，知识 cut 保持有序历史前缀，并区分 knows 与 believes/heard 等状态。
- 2026-09-08 17:14:42 UTC：最终全量回归开始，169 个测试文件、984 项测试全部通过（17.47 秒）；服务端、Web、E2E 三套 TypeScript 检查通过。Playwright 浏览器执行和真实模型全书续跑不在本次验证范围。原始审计指纹集包含代码文件，因此实现涉及的 5 个代码哈希按预期改变；集内 7 个原文/用户状态文件全部保持原哈希。
