# Pi 小说世界编译与 rebuild：本轮实现说明

日期：2026-09-05。对应分支 `design/novel-to-play-closure-20260905`，关联 [PR #3](https://github.com/skyfore/novel-world-harness/pull/3)。

本轮优先交付核心解析、可执行世界结构及可恢复重建。代码提供完整的来源到候选世界路径；“候选完成”与“整本主要人物已获认证”是不同状态。当前没有真实整本 Pi 认证结果。

## 1. Pi 编译的三个阶段

| 阶段 | Pi 提议 | 宿主保证 |
| --- | --- | --- |
| Observation | discourse、引语、实体提及、事件提及 | 原文不可变；精确来源片段；观察层保留歧义，不直接决定客观真相 |
| Semantic | 实体／事件消歧、命题、归因、知识、真实事件、参与角色、事件关系、scene／frame | 稳定逻辑身份；提及与真实发生分开；在场与施事分开；故事时间与叙述顺序分开 |
| Executable | action schema、EventExecution、空间拓扑、限制、规则、规范、过程、人物模型／目标与候选状态 | 机制有来源支持；精确角色／参数绑定；前提与效果可计算；模型不能凭叙述直接写世界 |

仍然使用 Pi 的 provider、会话、流式输出和工具体系。没有新增数据库、向量检索、通用模型写工具或第二套运行时。提议只有经过宿主校验和接受后才进入 canonical；运行时真值仍来自分支已提交历史。

每个批次只有通过 finish barrier 才标为完成。阶段限制继续生效：执行阶段不能回写早先的原始事件。模型遇到 ID 错误必须先用同作用域 finder 查询，复制结果里的逻辑 ID，最多进行一次有实际修正的重试。

## 2. 为什么新增 EventExecution

实际编译次序是先获得事件，再归纳机制。如果只在 CanonicalEvent 内放 action 字段，执行阶段无法补链；如果允许执行阶段随意重写早期事件，又会破坏来源解释及阶段权限。

因此新增独立工件，示意结构如下，省略具体证据内容：

```ts
type EventExecution = {
  id: string;
  canonicalEventId: string;
  actorId: string;
  action?: SchemaBoundActionInvocation;
  entryCheckpoint?: CharacterEntryCheckpointWithProjectionSeed;
  evidence: EvidenceRef[];
};
```

action 与 entryCheckpoint 至少提供一个。入口可引用在 executable 阶段才生成的规范和过程；这解决了“早期事件必须先有晚期机制”的阶段循环。一个事件可以分别给多个亲历人物补齐完整入口，只有一个 action binding；被动参与者可以有入口，但不会因此取得施事权。

Pi 先读取 event、相关模板和 schema 的完整 payload，再调用 `propose_event_execution`。对于 action，宿主检查：

1. 事件、人物和 schema 存在，事件与绑定属于同一小说。
2. actor 是参与人物，而且存在该事件的 typed agent participation。被伤害、收到礼物或仅在场不构成施事资格。
3. action 的 initiatorRoleId 精确绑定到 actor；所有参数和角色满足类型与基数。
4. 事件的 observedOutcome 与机制允许的精确效果一致；重复数值操作不能放大一次授权。
5. 同一事件不能有重复 action 绑定，也不能与事件已明确的 schema 或旅行方式冲突。语义阶段的 ad-hoc 观察可以在不改变 observedOutcome 的前提下补充机制。

绑定有自己的不可变修订。冻结 context 同时固定事件和绑定的哈希，加载时校验后才生成带 action 的运行时事件视图；删除当前编译目录的绑定不会修改旧 branch 的冻结视图。

普通旅行沿用另一条已有机制路径：活动路线、交通方式、前置条件和明确耗时。场景检查重建实际 pre-event 状态并复用引擎差分校验；没有路线、速度不可能或借旅行修改财富都会失败。

## 3. 世界结构与完全性的边界

| 层 | 已接入的检查 | 不能据此推断 |
| --- | --- | --- |
| Source / unit | 字节来源、叶单元 partition、accounting 引用真实存在且覆盖相应单元 | 所有事实已经正确抽取 |
| Identity / epistemics | 身份决议、事件共指、命题、归因、获取路径、知识主体 | 叙述者知道的事实人物也知道 |
| Scene / mechanism | 场景双向关联、入口、退出谓词、所需实体／谓词／机制、实际效果与路线 | 单次事件自动成为可重复的能力 |
| Semantic support | 冻结断言及独立复核；支持、矛盾、未确定分别保存 | 锚点合法等同于语义蕴含成立 |
| Major roster | 不从 ready 列表反推分母；独立全文复核保留漏掉或未解析的人物 | 当前实体目录就是小说的完整人物清单 |
| Entry / Play | 时间切面、完整状态种子、逐角色内核探针、统一角色视图 | 能创建 Genesis 就证明长期角色保真 |

`SupportAssessment` 随候选认证冻结；没有独立复核的断言为 `underdetermined`。机制必须有精确字段证据，而且覆盖所有影响执行的前提、角色、参数、效果、例外和权限。只证明名称、复核一个效果或者把整项 evidence binding 留空，均不能获得机制认证。

小说没有写出的事实不能补成确定事实。当前谓词为 true／false／unknown，`not(unknown)` 仍为 unknown。关键矛盾或缺失会生成阻断诊断；通用四值冲突投影仍在剩余工作中。

## 4. rebuild 如何决定修什么

闭合图的节点是带修订哈希的类型化工件；边保存目标种类、ID、修订，以及使用该引用的 JSON Pointer 和用途。它不是文本中扫描 `id` 后缀生成的关联图。

图包含 discourse、注释、实体／事件决议、语义工件、执行绑定、场景、机制、初态、入口、证据和名单。参数的实体引用按 schema 值类型识别；普通字符串不当实体 ID。入口种子内新引入的局部命题与 claim 不要求同名 canonical 工件，但仍检查其实体和模板依赖。

章节修复从该章节来源叶单元及其工件出发，计算所有传递消费者，再纳入消费者自己的来源依据和必要批次。身份共享或机制依赖可使范围扩展到非相邻章节；单纯属于同一本书不会让每次修复都扩大为全书。新旧图同时参与失效计算，新增与删除引用均被考虑。

`reparse` 沿类型化失效集合重新抽取；`rebuild` 默认复用既有工件，由 Pi 复核和修复选定批次。二者都保留不可变历史，但不把“归档了一个版本”解释为“可以发布”。

## 5. 核心操作路径

以下命令使用实际 CLI 参数。`<source-id>` 应复制已 ingest 的来源 ID；hash 应复制命令输出，不自行拼造。

```bash
# 从原文和现有进度完成全书候选；首次编译也使用此入口
nwh rebuild --root ./novel-workspace --source <source-id>

# 审查当前候选的结构、人物和阻断项
nwh prepared-cache inspect-closure --root ./novel-workspace --source <source-id>

# 查看不可变版本
nwh prepared-cache list --root ./novel-workspace --source <source-id>

# 从指定候选修复章节，并自动纳入依赖消费者
nwh rebuild --root ./novel-workspace --source <source-id> \
  --from-revision <bundle-hash> --chapters 2,5-7
```

省略 `--chapters` 表示全书。章节重建需要完整基底；章节／分段布局不兼容时拒绝定向复用，应走完整重新编译。`--replace-staging` 用于已检查的暂存冲突：被替代的 pending drafts 保存进 rejected history，不覆盖不可变父版本。

重建失败后重新执行相同命令即可恢复。journal 固定 parent hash、开始时的 active hash、候选模式、章节、批次及阶段；恢复不能偷偷更换模式、章节、版本或父版本。Pi 传输失败或取消不会抹掉已接受工件与成功批次。检测到另一次操作移动 active 或写入别的 proposal namespace 时保留进度并给出冲突诊断。

成功输出 candidateBundleHash、parentBundleHash 和 activeBundleHash。candidate 归档是本轮核心编译的交付点；active 保持不变。`prepare-all` 和公开新建 Play 仍要求完整认证。

## 6. 认证与可玩的实际含义

Major 入口建立在真实发生之前的故事时间切面上。当前事件和未来事件效果不会提前注入；同一事件的重复叙述不重复应用；顺序不明的关键效果阻断。晚出场入口保存累计明确耗时；已有社会语义、规范或过程时，需要该时点完整种子，不能静默变为空状态。

玩家、响应 NPC 和自主人物共享同一角色视图、知识准入与五通道效果：state、knowledge、semantic、process、norm。所有通道原子校验，preview 与 commit 使用同一路径。模型叙述不能直接承认新事实，人物也不能自行宣告对方已确认履约。

完整认证需要独立 gold 和真实 Pi 运行；执行工具已经接线：

```bash
nwh prepared-cache freeze-evaluation ./independent-plan.json \
  --root ./novel-workspace --source <source-id>
nwh prepared-cache evaluate <plan-hash> --root ./novel-workspace
```

计划先冻结语义分母、major 名单、入口切面、任务、非法动作反例、知识隔离检查与字段支持复核。每个 major 三次隔离运行；长期进展排除纯台词、计划、时钟、自然年龄变化、无效果和重复状态。只有冻结的真实终止谓词允许提前结束。未执行的模型调用不标为 live，单测替身不产生生产证书。

发布、激活、恢复和新建 Play 共用证书校验；编译 checkpoint 恢复只恢复暂存工件。选择人物后与 Genesis 前再次核对 prepared revision 和 entry cut。旧世界继续固定自己的版本与历史。

## 7. 本轮交付状态

核心接线、可恢复候选重建、类型化依赖、场景机制与证据支持已实现并分批提交。核心检查结果见[实施记录](novel-to-play-implementation-progress.zh-CN.md)。Web 浏览器回归按当前优先级暂缓。

运行契约为 prepared V4、world schema V3、engine 0.3.0、storage v3、cache V3、canonical snapshot V9、pipeline 32、prompt 28。旧语义版本不能仅凭完成批次标记冒充新版本。

当前没有可用 Pi provider 凭据与完整独立 gold，未运行真实整本解析和全体 major 长程认证。通用 branch entity create／identify／retire、统一四值冲突投影及多作品聚合验收也尚未完成。需要这些机制的小说不能被宣布完全可玩；本轮没有通过放宽发布门掩盖这一点。
