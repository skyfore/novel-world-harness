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
