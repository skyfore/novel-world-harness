# compiler-recovery-fixes 就绪复核与本轮实施

核查起点：`aa1979f3f3b52b44d9aff6fb551b3687f6bd67a9`。目标分支：`codex/compiler-recovery-fixes`。

## 结论

不能将该分支或 P1–P7 总方案标记为全部完成。原分支有真实 CI 阻断；本轮修复此阻断，并继续落地 P5 的一段生产路径：玩家行动/NPC 回应的可见决策依赖包、完整请求大小和调用次数门禁。工程测试通过不替代真实 provider 语义质量和独立体验验收。

基线依据为 [能力闭环设计](../plans/2026-09-16-review-to-capability-closure.zh-CN.md)、[逐阶段实施记录](../plans/2026-09-16-capability-closure-implementation.zh-CN.md) 的最新 P3f/P4h 段，以及源码；前部历史进度表不能覆盖后续实现事实。没有重跑具体小说、修改用户运行记录、重解释旧历史或改动编译接受门禁。

## A. 原 CI 阻断与修复

GitHub Actions run `35430313890` 在 `test:semantic-contracts` 失败；后面的 check/test/build 被跳过。使用该 run 保存的源码、Node 22.19.0 和锁定依赖归档复现。源码归档重建 tree 为 `c9ef440a1088f60dfc9f0e49fd34449c15e9e59d`，与核查 commit 完全一致。

`test/contracts/content-support.native.mjs` 仍导入 `src/compiler/content-support.ts`，后者已变成指向 `../world/expression-content-support.js` 的兼容转导出。Node 原生类型剥离不将该 `.js` 路径解析成源码 `.ts`，所以文件在加载时失败，不能把它解释为语义断言失败。

改为直接导入依赖无关的生产内核 `src/world/expression-content-support.ts`。原断言全部保留，未降级 Node、跳过测试或改变 CI 门禁；兼容入口仍由依赖完整的集成测试覆盖。修复提交 `9786003`。

## B. P5 增量：可见决策依赖包

原 `selectRecords` 只按 section priority/关键词选取，玩家/NPC 的 requiredSections 不包含 `decision`。因此在合法的初始上下文大小边界内，行动契约/规则/目标可以被裁掉，或者保留契约而丢掉其引用的当前可见状态。检索工具存在不等于宿主已保证关键依赖完整。

`src/agent/decision-context.ts` 和 `actor-context-retrieval.ts` 现在执行：

- 对已有 actor-safe、opaque 决策视图进行 schema 校验；不读取原文、全局世界状态或未来 canon。
- 将完整已披露 decision、self/scene、引用实体词表、owned state、spatial relations 和写能力一并保留；按 typed contract 的 field 集合保留 `state:<field>` 知识记录。字段采用现有 NFKC/trim 规则，不靠自由文本猜依赖。
- 所有关键记录先于可选相关性排序；最终 JSON 大小包含 coverage。关键包过大时以 `DecisionContextBudgetError` 在创建 Pi 会话前停止；不删除前置条件来伪装可执行。关键包采用精确最终大小检查，不能被可选记录的保守预留错误拒绝。
- 生成 host-only `DecisionContextManifest`，保存可见快照 hash、必需记录引用、实际字符数和 retained/blocked 状态。玩家/NPC 的启用 trace 接入此清单；不把清单或宿主 chronology 送进模型。
- `hostChecksRequired` 原样保留。retained 只表示已披露结构依赖未丢失，不表示隐藏条件满足、动作合法、命题为真或全局能力已认证。

此实现有意保守地保留整个已披露契约集合，尚非每个候选动作的最小 DAG。大量实体/契约超过边界时，宿主应拆分任务或显式调整预算；本轮未添加自动缩小任务算法。快照 hash 绑定隔离可见投影，不替代独立 branch/head/candidate 的持久证明；自然语言动机/回忆的完整依赖也没有被声明为自动证明。依赖包提交 `aabc020`。

## C. P5 增量：完整请求门禁

初始 actor context 的 32,000 字符上限不包含系统提示、工具 schema、额外消息及逐轮工具返回，不能充当整次请求预算。

新增 `ModelRequestBudget`，由 `PiAgentSessionOptions.requestBudget` 接线。玩家行动每次适配器调用创建一个预算；NPC 的两次协议尝试共享同一实例。Pi 宿主重建会话继续使用原实例，不能清空已耗尽状态。

默认上限为 32 次 agent model calls、单次 512,000 UTF-8 字节、累计 8,000,000 已观察 provider payload 字节。它们是工程保护参数，不是 tokenizer/context-window 估算、输出 token 限额或费用报价。

宿主在 `agent.streamFunction` 检查完整逻辑请求，在原 `agent.onPayload` 变换之后检查实际 provider JSON。不能仅放在 `before_provider_request` 扩展里：锁定 Pi 0.84.2 的 ExtensionRunner 会捕获扩展异常并继续。这里的拒绝位于该捕获层之外，通过正常失败路径传播；不替换供应商 API 或篡改请求内容。

超限状态不可逆，后续更小请求和新建协议会话仍被拒；错误明确要求宿主缩小任务或审阅预算，不允许删关键证据、盲重试或提交半成品。统计仅保存计数与字节量，不复制请求秘密。该计数不是每一次底层 HTTP 重试次数：SDK/provider 内部复用 payload 的重试可能不产生新的回调。

当前生产接线明确限于玩家行动/NPC 回应；叙述、选择、世界裁决、编译等其他调用及整个用户回合跨适配器的统一总预算仍不在本轮完成声明中。现有 timeout、只读检索范围、单次捕获和 proposal→validate→commit 保持不变。

## D. 验证

使用 GitHub 保存的锁定依赖与 Node 22.19.0；终端不能联网安装包，故通过 npm/direct binaries 调用与 package.json 相同的脚本，未改 lockfile。测试在隔离 NWH_HOME 中进行。

| 检查 | 当前本地结果 |
| --- | --- |
| 原生语义契约 | 44 项通过；保留原断言 |
| 基线全仓 Vitest | 206 文件、1,244 项通过 |
| 新增依赖包、预算、真实 Pi 接线及既有适配器定向检查 | 6 文件、21 项通过 |
| 修改后全仓 Vitest，`--maxWorkers=2` | 209 文件、1,258 项通过，190.30 秒 |
| `check`：服务端/Web/E2E TypeScript | 全部通过 |
| clean + build:server + build:web | 全部通过；Web 保留大 chunk 提示，没有掩盖警告 |
| diff whitespace | 通过 |

新增 14 项测试覆盖高优先级干扰不能挤掉依赖、关键包超限、快照变化、精确最终大小、坏 schema、UTF-8/系统与工具 schema、累计工具返回、跨实例调用预算、payload 变换、不可序列化数据、实际 Pi 回调和 clear() 后不重置，以及依赖超限时根本不创建 Pi 会话。

真实 Pi 接线测试不调用外部模型；全仓场景测试不能充当真实小说体验。未执行浏览器端 Playwright E2E、真实 provider 实验或新增独立人工评分。上述本地结果也不冒充后续 GitHub Actions 的完成状态。

## E. 仍开放的总方案边界

| 范围 | 不能声明全部完成的原因 |
| --- | --- |
| P1/P2 | 已有持久义务、授权 DAG、冻结恢复和调度实现；仍需按原退出矩阵逐项结算，不能从测试总数反推全部修复根因/主体自动授权已支持 |
| P3 | 已实现多种 Acquisition 与冻结历史入口；分支临时获知的完整新协议、legacy 获知迁移/退出审计仍开放 |
| P4 | 已实现失能、scene 消费、晚入口原时钟及显式恢复；远程渠道/照片、身份保密与命名能力等扩展及完整生命周期矩阵仍开放 |
| P5 | 本轮补齐一段硬依赖和请求门禁；最小候选依赖图、完整回合预算、LiteraryReferenceIndex、原著表达与已提交话语绑定等仍开放 |
| P6 | 已有合法候选过滤、前沿/压力分离和宿主驱动；完整退出矩阵仍需要独立审计，不能仅凭这些增量标记完成 |
| P7 | 真实 provider 多场景、长回合、多角色与独立人工体验验收未执行 |

下一步不能以清空义务、自动升级 legacy、扩大可见性、放宽真实状态验证或追加虚构人工分数来“完成”这些项。本轮改动只作用于模型输入和调用边界，没有改变世界记录格式或重放语义，因此不修改 compiler pipeline/engine 版本。
