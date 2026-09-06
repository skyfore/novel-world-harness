# PR #3 深度 Review 修复记录

本次针对上一轮 review 的 R1–R7 修复核心编译、角色运行和 rebuild 链路。对应设计为 [小说到 Play 技术方案](novel-to-play-technical-design.zh-CN.md)，研究与设计提出的完整世界模型目标仍以来源证据、角色知识隔离、因果前态、宿主裁决和不可变提交为边界。

## 修复对照

| Finding | 已落实的行为 | 主要代码 | 回归证据 |
| --- | --- | --- | --- |
| R1：过程所有权直接授权推进 | actor/player 的过程效果先通过模板 `actorControls`，再进入 reducer。检查动作模式、实际经过时间、前后态、阶段、结果、每回合累计推进上限。默认只能接受零进度任务，不能任意推进、完成或加速时间表。 | `process-authority.ts`、`process-ontology.ts`、`engine.ts` | 合法完成；无耗时、无后态、错误动作、拆分推进、非零初始进度拒绝；失败不改变分支，成功可 fresh replay。 |
| R2：首次动作因未亲历示例事件而不可用 | `supportingEventIds` 仅证明编译归纳依据。公开且来源正确的机制在第一次事件前即可进入能力视图；秘密能力使用显式 `visibility=knowledge` 和 `knownByClaimIds`。引擎也检查角色是否已获得所调用机制。 | `mechanism-visibility.ts`、`actor-decision-view.ts`、`engine.ts` | 首次公开动作通过 scope 和 engine；未知秘密机制拒绝；不同角色的知识门槛互不共享。 |
| R3：集合成员漏入依赖图 | 对 StateOperation、Predicate 按类型穷尽遍历；add/remove-member 和 entity-in 的 member 均为实体引用；entity-ref/set 值按字段类型提取。 | `state-references.ts`、`compiler/closure.ts` | 成员实体变化传播至初始世界和后续事件；删除产生 dangling issue；普通文本不被误判为实体引用。 |
| R4：场景检查仅验证动作形状 | 每个场景事件构造自己的历史 cut，使用其完整 checkpoint 或从开篇重放到前态；复用引擎 `validateEventProposal` 的真实前置条件、状态规则、动作约束、空间和效果检查，并验证场景 entry/exit；历史重放中的事件及其同指别名仅在实际执行后一起进入已发生集合。 | `compiler/scene-state.ts`、`scene-execution-contracts.ts` | 连续两个场景获得不同 cut；余额不足的 source-bound 动作无法认证；路线、耗时和额外效果检查仍生效；未来建路事件的别名不能提前开放路线。 |
| R5：角色上下文缺少可执行规则 | 注入动作前置条件、过程控制与 cadence、规范动作/适用条件/例外/补救，以及世界规则和动作约束。隐藏条件按完整布尔子表达式保留为未知，不拆解 NOT/OR；用 `hostChecksRequired` 标记视图不完整。 | `actor-contracts.ts`、`actor-decision-view.ts`、`pi-player-action.ts` | 条件与规范条款可见；隐藏实体/私人字段/engine 规则不泄漏；嵌套 schema、rule、entity 引用正确映射为 opaque handles；玩家、NPC、自主角色适配通过。 |
| R6：规范确认身份自相矛盾 | 手动 satisfy 由独立受益人或声明的 authority 确认。宿主记录履行者 `byActorId` 与确认者 `acknowledgedByActorId`；模型不能设置后者。省略或显式填写当前确认者时行为一致。履行者可执行模板定义且实际通过动作/状态校验的 reparation。 | `actor-outcome.ts`、`norm-ontology.ts`、`norm-effects.ts` | 显式/省略身份均可 preview；债务人两种写法均不能自签回执；提交和回放保留双方身份；既有合法补救仍通过。 |
| R7：候选 rebuild 阻断已发布世界 | Play 从已发布不可变 revision 读取；候选编译区的实体、批次布局或 checkpoint 修改不再让旧 publication 被判断为 staging stale。只有显式 publish 切换已发布 revision。 | `compiler/prepared-cache.ts` | staging 内容变化、候选 archive、checkpoint restore 均保持旧 publication 可读；显式 publish 才切换。 |

## 过程控制与规范确认的契约

过程模板可以为 start/advance/pause/resume/finish 分别声明控制。`requiresBefore`、`requiresAfter` 的 `entity.kind=role` 绑定到 **process ownerRoles**；动作模式单独与已验证的 action invocation 匹配。推进使用同一个 process 在同一回合的累计 amount，与 `maximumAdvance` 比较，拆成多条操作不会增加预算。时间依据是经过引擎时间处理后的 before/after 差值，模型写在描述中的“已经过了一天”不产生时间。

旧模板没有 actorControls 时，角色可以接受一个零进度任务；其他过程操作需要补齐控制依据。`onDue` 保持由宿主调度。过程 reducer 保持确定性回放职责；新的 actor 权限检查在提交前进行，所有五类效果仍共同接受或拒绝。

规范满足存在两条有区别的路径：宿主自动检查履行者的实际动作；或者独立受益人/authority 提交确认。模型提议里的 `byActorId` 若填写，必须是当前提议者；宿主在手动确认入账时将履行身份规范化为 norm subject，并单独记录确认者。回放不再把受益人的合法回执误当作“非 subject 执行了履行行为”。规范补救不能只靠一句描述，必须有具名动作或可执行后态条件。

## 编译和上下文边界

Pi 编译工具说明和批次指令已补充可见性、知识获得、过程控制的证据要求。finish 依赖检查覆盖新 knowledge gate、actorControls 引用的动作和实体；过程 owner role 和 action schema 引用同时进入编译器与运行时 catalog 校验。原有独立机制证据审查按 executable leaves 工作，因此新控制字段也必须获得字段级证据支持，不能仅引用模板名称。

角色上下文里的规则是**可见定义**。出现某条规则不表示它当前适用，也不表示例外已被排除。隐藏字段、未获得的知识和未公开机制继续由宿主执行检查；`hostChecksRequired` 不授予绕过权限。原著中的未来事件继续只是候选，公开机制的可用性不会将原著结果或未来角色知识注入当前分支。

场景执行检查是确定性编译认证的一部分，使用引擎的纯验证路径和实际前态，不调用模型或提交运行分支。它不替代真实整本抽取质量评估或持续运行的 live Play 认证。

## 版本与验证

- engine：`0.4.0`；compiler pipeline：`33`；prompt：`29`。
- 更新 validator fingerprint 的 closure、sceneContract、effectMechanism、actorOutcome、actorView、predicateTruth，以及 publishedReadModel 契约项。
- 保持 world schema V3、prepared V4、storage v3、cache V3、canonical snapshot V9。新增提交字段为可选字段；没有改写不可变历史。
- 版本兼容性检查仍生效。候选 staging 隔离不允许读取不兼容引擎/语义版本；旧评估必须按新契约重新运行，不能自动续签。
- `pnpm exec vitest run --exclude 'test/web-*.test.ts'`：**149 个文件、848 项测试通过**。
- `pnpm run build:server`：通过。

测试使用确定性隔离 fixture；Web UI/浏览器回归按优先级暂缓。本次未运行真实 Pi provider 的整本解析与所有 major 角色长程 Play，也不据此声称任意小说已获得“完全解析/完全可玩”认证。通用实体 create/identify/retire、统一冲突投影和多作品 gold 评测仍按原技术方案作为后续能力，不属于这七项缺陷修复的完成证明。
