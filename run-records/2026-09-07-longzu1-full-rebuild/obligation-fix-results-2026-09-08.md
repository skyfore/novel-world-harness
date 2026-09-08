# batch 50 失败恢复协议修复结果

## 已实施

- source/batch scoped、按 proposal identity 分文件的持久化 attempt journal，包含原始提案输入、摘要、状态和诊断。Pi 同步参数预检失败也会被记录；执行开始先记 running，验证成功才记 succeeded。
- 新会话 hydrate 未解决记录。只有同 tool/proposal_id 的成功修正才能关闭对应失败，无关提案和 accounting 不能清除它。原始与修正后的不同输入都失败后停止重试；未返回工具结果的 running 状态要求宿主检查。
- finish 在任何 acceptance/review 写入和 terminate 之前检查 obligations；外层 completion 门禁不再以 world=0 作为拒绝未解决失败的前提。
- 宿主可按精确身份作 unsupported 复核，必须附 reason 和 auditRef，并保留失败历史。该决定不生成 action-schema/binding，不认证可玩性；模型没有该写接口。
- 一次返回所有 selector 的缺失引句、歧义或引用路径诊断，保留原文精确匹配。发现结果附 readArguments.ref，并明确禁止由 logicalId 构造 ref。
- executable prompt 改为按当前切片依赖定向读取，要求 accounting 清零后仍审查机制和 bindings。prompt version 31，pipeline 仍为 34；不清空既有源文审查进度。

## 验证

- `pnpm run check` 通过。
- `pnpm test`：164 个测试文件，947 项测试全部通过。
- 新增回归覆盖会话重启、无关成功提案、参数预检、未返回结果、修正耗尽、宿主复核历史、finish 拒绝时无 review/annotation 副作用和多引句同时诊断。
- 使用审计 run `run-mtsiqp45-33329f86-0903-440a-a2f2-1e1f5f6d208e` 的真实 proposal/finish 输入，在 `/tmp/nwh-real-obligation-replay-Ps4XHy` 的隔离 NWH_HOME 中复制现场重放：
  - 同时诊断 selector 2、3、4。
  - 首次及新会话 finish 都被持久化失败拦住。
  - 被拒绝的 finish 前后 accounting 文件逐字节一致。
  - 对这份跨 scope 的无效提案作显式宿主复核后，36 页 accounting 的正常 finish 验证通过，world=0。
  - 重放没有修改真实 workspace，没有调用模型或手动设置 checkpoint。

## 本地旧运行兼容处置

旧审计发生在 journal 上线前，不能假装它已自动持久化。已在真实 workspace 的 compiler lock 内：

1. 从原审计 input hash `8920450f5990df93cb7ed4860f09911229c6c564962d5c7b956fe74c13414b95` 读取原提案。
2. 重新核对不可变原文 335–692 行：第一条存在，后面三条均不精确匹配；其中两条属于前一切片。
3. 导入该失败，再记录 `unsupported-as-submitted` 的宿主复核，附原 run 的 events 132–133 和分析报告引用。
4. 保留所有原 drafts、accounting、检查点及世界真值；锁正常释放。此具体提案 unresolved=0，不代表交流机制本身永远不成立。

本次未重跑真实 LLM 编译、未新增真实 batch 50 checkpoint。实际进度仍为 50/71，后续可从 batch 50 继续正常审查。

## 实施边界

本提交解决此次失败记录、恢复和完成门禁的直接缺陷。没有以 accounting 数量冒充 executable 成果。完整逐事件 executable 覆盖账本、跨切片机制任务调度、全流程多文件提交 journal，以及按阶段进一步拆分大工具 schema，仍是后续架构工作；它们不是本次已完成的功能。现有 finish 的持久化操作继续依赖既有幂等重放，未宣称跨所有存储原子提交。
