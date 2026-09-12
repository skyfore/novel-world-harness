# 龙族编译 → 当前 Codex 任务回调

目标任务：`01a0912b-5872-75b0-a118-813e3e32d2be`。原文 `a28585b1cf867f3e3a16`。起点 71/71 批次完成，但 bounded-v3-2 人物模型义务阻塞，未发布完整可用版本。

宿主复核在 `host-review.json`：两次输入含违反结构化人物模型约束的旧字段；未暂存任何对应提案。保留历史，并由模型在原提案 ID 上通过正常校验修正。schema 重放仅验证字段约束，使用现有证据载体补足宿主注入形状，不认证新语义。

运行模型沿用 `openai-codex/gpt-5.6-terra`，所有工作持有原编译锁。`worker.ts` 先恢复原补充批次，再执行 prepare-all 的验证及版本发布，`createBranch=false`。成功必须完成后续验证，不以 71/71 或候选归档冒充整体100%。

后台服务 `nwh-codex-compile-loop.service` 执行 `run.sh`：先运行编译，进程退出后运行 `notify.ts`。回调使用实测可用的 `codex queue --thread <精确任务UUID> --message ...`，不新建任务、不使用 --last，不让 Codex 活跃会话轮询编译。失败回调要求 Codex 查明并修复问题，相关测试通过后 `systemctl start nwh-codex-compile-loop.service` 后台续编并立即结束回复。

- `state.json`：当前尝试、终止状态、失败指纹、回调送达回执。
- `hooks.jsonl`：Pi/业务 hook 日志；`worker.log`：后台日志；`status-after.json`：退出时快照。
- 硬额度耗尽：停止当前调用，由回调脚本安装 systemd 一次性定时器，唤醒同一 Codex 任务。用户给定锚点为北京时间 2026-09-12 04:08（2026-09-11 20:08 UTC），后续按 5h 递增，选未来时间；实际 provider 若返回不同窗口须重新核实。
- 同一问题在修复后再次出现：`repeated-failure`，回调只报告停止，不再编译。
- 完整编译校验和版本发布成功：`completed`，回调核验并报告结束。
- 回调自身失败写入 `state.callback`，不伪装成送达。未配置应用内 automation；定时恢复使用当前 Linux 主机的 systemd。

查看服务：`systemctl status nwh-codex-compile-loop.service`。停止后台编译：`systemctl stop nwh-codex-compile-loop.service`。收到回调先检查服务状态，避免重复启动；不要绕过义务、校验或检查点。配置 Restart=no，不进行无诊断重试。

## Attempt 1 回调后的修复

人物模型恢复成功，accepted 提案 445→458；后续 bounded-v3-4 因 /participants 引文多出一个“着”字失败。第二次输入仍保留同一错误引文、却修改无关字段。`host-review-event-selector.json` 保存原失败输入、生产不可变源锚点解析器的复现诊断、正确逐字原文及锚点。没有直接修订事件或清空义务历史。

修复 reconciliation 提示：修正命名的 selector，从 find 的 ref 经 read 的 chunk/evidence_segment_id 复制原文与句柄；同一失败提案 ID 只能纠正重试一次。移除旧提示中“失败纠正可换新 envelope ID”的矛盾说法。后台 worker 在进入后续准备前恢复原 bounded-v3-4 批次，保留四个其他成功草案。10 个相关测试、完整类型检查及 worker/review 脚本类型检查通过。

## Attempt 2 回调后的修复

引文恢复成功，accepted=466，pending=0，无未解决义务；整体仍在 repair。发现每次 prepare-all 都重新写 iteration 1 的计划，但 compilerBatchId 使用固定 v3；前序完成回执因此让新计划的前几个批次直接返回。当前完整语义缺口不等于71/71审查完成。

修复：默认计划恢复时保留已有目标与身份；显式新修复轮次按 proposalIdSuffixTail 分文件保存，并使用对应的独立 finish 作用域；图校验读取同一作用域计划；空目标 shard 跳过 LLM。回归覆盖在原计划后新增目标、原计划恢复身份不变、新轮次可见新目标且不覆盖旧计划，以及空 shard 判定。36项相关测试通过。

下一轮使用固定 semanticRunId=codex-semantic-plan-fix-20260911，跨恢复保持该值。开始前必须确认无未解决义务；后续若出现义务必须先恢复其原始作用域，不能更换此ID绕过失败。语义阈值、原文、检查点与既有回执不改动。

## Attempt 4 回调后的修复

额度恢复，accepted=483、pending=4。新的阻塞是 bounded-codex-semantic-plan-fix-20260911-4 的鱼雷发射事件：两次输入都把 launched 字符串写入 artifact.condition，第二次仅改引文。`host-review-artifact-condition.json` 保存生产 StateSchemaRegistry 的类型错误复现、实际字段规格及原始失败输入；没有给出或写入替代数值。

reconciliation context 现在携带从 DEFAULT_STATE_FIELDS 克隆的完整宿主状态字段表，含类型、适用实体、基数和范围；提示明确不把生命周期字符串任意转成数值，不通过删除既有效果或发明字段绕过校验。保留当前 semanticRunId、目标计划及批次，原 ID 正常校验重试。7项 reconciliation 测试及完整类型检查通过，宿主复核脚本类型检查通过。

## Attempt 5 宿主停止决定

本轮 accepted=491、pending=0、无未解决义务，五个非空 bounded shard 均已有完成回执。独立 audit-attempt-5.json 仍显示开局自主驱动覆盖为0、受控人物模型覆盖为20%，与计划修复前相同。事件效果和时间锚点有所改善，因此整体错误指纹不同；此次是宿主对重复具体语义阻塞的停止判断，不是假称整体指纹相等。详见 host-review-attempt-5.json。state 标记 repeated-failure，阻止自动续编；服务未启动，无待执行 reset timer。未改动世界产物、原计划、检查点、义务或发布校验。整体尚未完成。

## 用户要求修复后恢复循环：逐目标验收协议

Attempt 5 的 repeated-failure 是宿主根据局部汇总指标作出的过早判断，非相同失败指纹自动匹配。现修复 finish：新语义计划每个目标必须有 target_reviews，宿主自动关联提案并检查证据句柄作用域；提交后独立审计记录未解决目标，模型 unsupported/capability-gap 在不可变回执中保留，跨重启、跨 namespace 发布前均需原文宿主复核。新增 reviewReconciliationDeferrals 是只供宿主在 compiler lock 下调用的审计登记入口，不认证新世界语义。

人物迁移和开局驱动要求独立明确，提供受控维度/上下文表及只读开局状态和知识。循环仅在 state.appliedRepair 记录的具体失败指纹经针对性修复后再次出现时自动 repeated-failure；不同提案不再归一成同一失败对象。回调禁止仅因汇总指标不变手动停止。

用户明确授权本次修复后 rerun。旧 semanticRunId、计划和回执不改；通过 fresh audit、原完成回执及无未解决义务检查后，建立有前驱记录的新协议修复轮次。下一轮 namespace 固定为 codex-target-review-v1-20260912，后续恢复保持同一值。具体宿主复核与验证证据见 host-review-target-protocol.json。
