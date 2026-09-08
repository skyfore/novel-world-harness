# 案例修复实施结果：2026-09-08

本轮已完成 T0–T7 的代码、诊断工具、隔离回归和分步提交。最终验证代码为 `4439559`，分支为 `codex/compiler-recovery-fixes`。169 个测试文件、984 项测试全部通过，服务端、Web、E2E 三套 TypeScript 检查通过。

真实小说没有续跑，也没有被手工改写。最终只读状态仍为 **52/71**：observation 23/23、semantic 23/23、executable 6/23、boundary 0/2；403 pending、96 rejected、0 accepted，没有 candidate。p07 的完整覆盖证明已经由新工具只读验证，但未执行 `--apply`，其现场义务仍要求宿主裁定。代码交付完成与现场小说编译完成是两个独立状态。

原始事实、专业资料及论文论证保持在[深度审计](../deep-review-2026-09-08/report.zh-CN.md)。本记录说明该审计之后做了什么，不改写原报告在 `e00eb9d` 上得出的历史结论。[事故记录](../../../docs/incidents/2026-09-08-accounting-obligation-rebase.md)固定原调用链，[实施计划](../../../docs/plans/2026-09-08-compiler-recovery-and-capability.md)记录任务与验收。

## 交付与时间线

时间均为 UTC；提交时间来自 Git committer timestamp。原文行号是不可变原文中的位置，不是现实时间或 branch 的逻辑时间。

| 时间 | 任务／提交 | 结果与上下文 |
| --- | --- | --- |
| 13:51:46–14:00:25 | 原事故，旧代码 | 新规范覆盖旧页 1 单元，p07 失败，p07b 接手 19+1 单元；unresolved=0 后旧义务仍阻止 finish。宿主收到禁止重试后仍创建 recovery session。详见事故记录的 seq 395→404→413→431→665→683→700→753。 |
| 14:32:27 | 历史审计快照 | 固定 source、run、检查点集合、原文位置、持久义务与研究依据。 |
| 15:53:46 | T0，`867a887` | 保存案例、原始深度报告与八步实施计划，区分旧 guardian 约束和新用户授权。 |
| 15:58:52 | T1，`3572811` | 宿主读取结构化／旧 tagged recovery 结果和持久 journal；host fatal 不再因已有成功草稿而恢复模型会话。 |
| 16:05:40 | T2，`135ad1f` | accounting 页持久回执、精确 coverage 差分、同 proposal ID 的一次修正 SOP。失败不部分 staging。 |
| 16:18:42 | T3 真实只读预览 | 用原 trace 验证旧 20 单元：19 来自 p07b，1 来自 freedom-day norm。没有执行裁定或世界写入。 |
| 16:21:35 | T3，`48dcb19` | 宿主覆盖裁定及依赖失效重阻塞；保留原始失败，验证 legacy discovery/call/result 链。 |
| 16:29:48 | T4 真实状态检查 | 从有效检查点集合推导出 52/71，无 candidate；状态读取不初始化 trace、不运行 closure、不修改世界。 |
| 16:32:10 | T4，`013a7c2` | 提交共享 batch plan 和 `status --json`。 |
| 16:47:23 | T5 来源独立预期／真实评估 | 从原文确定 5 项场景预期，绑定精确 anchors；结果为 2 blocked、2 unsupported、1 unknown。 |
| 16:48:21 | T5，`2076d62` | 提交 `review-scenes`、有限状态／知识探针及限定阶段的返修诊断。 |
| 17:06:08 | T6，`1251915` | 提交 finish 意图回执、宿主幂等恢复、checkpoint 完成证明，以及 reparse／materialization 回执归档。 |
| 17:06:33 | 首次全量回归 | 982 项中 977 通过、5 失败。暴露旧测试在成功 finish 后改变同批输入，或仍传 `proposal_ids`；进一步复核补齐 TUI 的持久 checkpoint 检查。保留原失败日志。 |
| 17:14:42 | 最终全量回归 | 169 个文件、984 项全通过，耗时 17.47 秒；三套类型检查通过。 |
| 17:16:11 | T7 集成，`4439559` | 提交 TUI 宿主恢复、特殊阶段停止时保留现场、显式迁移回执，以及场景效果顺序与知识状态检查。 |
| 17:18:06 | 最终完整性记录 | 基线指纹集的 7 个原文／用户状态文件全部不变；两项历史义务的状态、输入哈希、诊断和 host review 投影不变。详见 JSON 的精确捕获时间与比较范围。 |

## 关键修复的含义

### 持久义务与 source coverage 分开闭合

`unresolved=0` 只说明当前 source-accounting 投影没有未处理单元。它不能证明每个历史调用身份都成功，也不能证明空效果事件拥有执行机制。现在调度器在会话创建前、报告返回后和异常恢复时读取义务状态；TUI 也在提供下一回合前检查。一个可修正失败仍允许按 SOP 修正；中断 mutation、耗尽纠正机会或 host fatal 阻止新模型会话。

旧页 token 现在绑定 source hash、batch、segment 集合、原始有序单元集合和消费身份。覆盖在 discovery 与 account 之间变化时，整次 account 被拒绝并返回 represented/accounted/remaining 差分。模型必须重新发现同一批次的页、复制新 token、保留原 proposal ID，最多修正一次。新身份成功不能悄悄抹去旧身份失败。

宿主 review 将旧义务标为 `superseded-by-coverage`，需要完整证明每个原始单元已被当前批次有效证据、annotation 或非阻塞的后继 accounting 覆盖。证明绑定全部失败输入哈希、原始单元哈希、依赖内容及审计引用；缺单元、跨 scope、猜测 token 或撤回依赖均不能通过。裁定不接受世界提案、不写 checkpoint，也不认证规范或动作语义正确。

真实 p07 的[coverage-preview.json](coverage-preview.json)证实这种证明可以建立。它是只读预览，现场仍保存原来的失败状态；预览成功不能在报告中写成“batch 53 已恢复”。

### finish 成为可恢复的宿主操作

原 finish 顺序跨越标题、章节 manifest/plan、annotations、resolutions、accounting acceptance、review marker 和 checkpoint。任何两个文件写入之间都可能中断。现在验证全部通过后，宿主先保存 `prepared` 回执，再执行原有提交操作，最后保存 `completed` 回执；生产 source-batch checkpoint 要求回执完成。

回执绑定原始 finish 输入、pipeline、不可变原文与 segment、各类草稿内容和元数据。prepared 期间冻结模型 mutation，连改变 finish summary 都不能当成同一次恢复。宿主重跑原来的闭合、来源、身份和 accounting 校验，然后恢复幂等 acceptance/review；正常恢复不会进入模型会话，不会重新激活被后续批次替代的解析决议。review 内容不变时保留原时间，避免重试改变覆盖优先次序。

特别覆盖了两个历史窗口：标题已经接受但 annotation 尚未提交，以及新章节 manifest 已写但 split plan 尚未写。角色复核的重复恢复不会再追加一份相同 review。显式 reparse、`resume=false` 和准备版本 materialization 会把被替换回执连同原因归档；模型没有归档或删除回执的工具。旧 checkpoint 仍可读取，新生产提交遵循新协议。

这是受 compiler lock 保护的进程中断恢复协议，仍依赖现有本地文件和原子 rename；没有引入数据库，也不宣称实现断电级多文件事务。

### 独立场景检查不再由候选 schema 自证

预期来自单独的原文审查文件，保留审查者、时间、来源哈希和 exact anchors。完整预期 delta 要匹配事件操作与顺序，机制还必须能产生相应效果；额外追加反向操作不能靠“包含预期操作”通过。明确有来源理由的无变化事件仍合法。暂时失能没有获准映射时保持 unsupported，不能用死亡或任意字段代替。

知识检查只投影指定历史，before 必须是 after 的有序前缀。默认检查 `knows`，不会把 believes、suspects 或 heard 自动当成知道；其他状态须明确指定。动作探针使用三值前置条件，false/unknown 不施加效果。规范探针调用真实模板适用性解释器，但不冒充完整权限裁定。

| 场景与原文上下文 | 相关历史工件 | 最终结果／应返修的位置 |
| --- | --- | --- |
| 入学选择，L765–767 | `event-accept-00005-v2` 于 09-07 11:35:43.606 建立计划变化；`part-accept-lu-00005` 于 11:37:48.806 仍记录 experiencer | **blocked**。计划变化已有；semantic 需修复有证据的 initiator/agent 参与关系，随后 executable 补机制。此处不提前声称电话确认后的正式生效。 |
| 恺撒被击中，L1115；非致命解释，L1144–1147 | `event-lu-shoot-caesar-00007-v2` 于 09-07 11:57:26.835；之后的 rifle binding 可与空效果 schema 形式匹配 | **unsupported**，并报告 source outcome 为空。需要明确的暂时失能／恢复表示，再修复 semantic 效果与 executable 机制；不能推断死亡。 |
| 楚子航被击中，L1128；同一弹药上下文 | `event-lu-shoot-chu-00007-v2` 于 09-07 11:57:26.840 | **unsupported**，同样缺少可表示且可执行的实质性后果。 |
| 自由一日许可，L1142 | `prop-norm-freedom-day-00007` 于 09-08 13:52:09.141；正是导致旧页 coverage 变化的同一工件 | **blocked**。当前模板在合成“活动两日后”仍适用；活动时间、主体／辖域、行为类别与例外须来源支持。这里的 0/2 日是显式探针假设，不是实际 branch 时间。 |
| 弹药解释前后的角色认知，L1137–1146 | `event-medical-reveal-00007-v2` 于 09-07 11:57:26.845，摘要包含获知，但无 observedKnowledge 操作 | **unknown**，另报告获取路径缺失。semantic 需发现准确 claim/proposition、建立对应 acquisition；编译器知道未来解释不等于角色在开枪前知道。 |

以上预期由本次 Codex 原文阅读建立，尚无人类复核。它们独立于待测机制的效果定义，但仍是可审查的有限判例，不能换算成全书准确率或完整 branch 可玩性。最终结果及所有 pending revision 的时间／batch 来源见 [scene-capability-review-final.json](scene-capability-review-final.json)，固定预期见 [scene-capability-spec.json](scene-capability-spec.json)。

## 验证与现场完整性

[validation.json](validation.json)记录命令、退出码、测试数量、代码 HEAD 和未执行项目；[最终测试日志](validation-final-tests.log)、[类型检查日志](validation-final-check.log)及[首次失败日志](validation-initial-tests.log)均已保存。最终验证覆盖恢复会话次数、19+1 页重排、覆盖证明失效、跨文件中断、TUI 伪成功消息、身份／事件 supersession、状态只读、独立效果和知识隔离等实际行为。

[compiler-status-final.json](compiler-status-final.json)是在最终实现上的只读输出。实际小说没有 compiler lock、没有新 finish 回执，没有 candidate，p07 仍是唯一当前计划中的 host-review blocker。未运行 Playwright 浏览器、真实 provider 全书续跑、真实角色反事实分支评估。

[final-integrity-check.json](final-integrity-check.json)共比较原审计的 24 个指纹项目：19 个未变，5 个代码文件因本次修复而按预期改变。其中 7 个原文／用户状态文件全部保持原 SHA-256。原报告列出的 remote-communication 与 p07 两项历史义务，也保持相同的 attempt 数量及关键字段投影。后两项并非原始整文件哈希比较；本记录明确保存该限制，不能把有限比较说成全工作区未变化证明。

## 现场下一次执行的前置条件

工程工具与验收已交付。若后续要恢复真实小说，应先重新运行 p07 coverage preview，在 compiler lock 内应用宿主裁定，然后从保存草稿重新验证并完成该批 finish。这个旧现场尚无 finish 意图回执，不能冒用新协议的 completed receipt。覆盖裁定只能解除操作协议阻塞，不能作为跳过场景语义问题的理由。

入学 agency 与知识获取应回到受限 semantic 返修；暂时失能需要先确定可验证的本体表示；规范要补来源约束与正反例。返修必须保留原修订与依赖关系，并重新验证受影响的 executable 工件。完成这些有限场景能力后，再安排全书 continuation、boundary 校准和 candidate/closure 验收；本轮没有用绿色单测代替这些真实运行结果。
