# 小说到 Play 实施记录

本记录对应 [技术设计](novel-to-play-technical-design.zh-CN.md) 与 [验收计划](novel-to-play-acceptance-plan.zh-CN.md)。仅有明确代码和验证记录的项目才标记完成。

## W0：反例基线

- 主线基准：`b2c010548edc519ea957e0ddc9fffdb47c297a5d`；设计提交：`12d9bb39d75ed2d17d841f7d18e941d09f8966ad`。
- 新增 `test/novel-to-play-regressions.test.ts`，从真实玩家转换、最终角色上下文和引擎提交三个入口验证 F1/F2/F3。
- 修复前运行：`pnpm exec vitest run test/novel-to-play-regressions.test.ts`，3 项按预期失败。F1/F3 接受了应拒绝的效果；F2 投影有 1 条知识、最终角色上下文为 0。
- 测试使用有真实 sourceId 归属的隔离 fixture；不构成真实小说抽取质量证据。身份、时空或实体等更广版本契约随首次不兼容实现一起提交。

## W1/W2：三个接口反例修复

- 人物提议统一规范化动作；玩家 action 在匿名句柄边界编码／解码，普通玩家不再跳过 any-action 约束。
- 引擎对实际 character.location 差分执行路线、方式和耗时检查；action.travelMode 保存在事件动作内，省略／伪造 arrive 不放行。
- 分支知识凭 projector 生成且校验完整内容的进程内 provenance 准入；模型布尔值、复制条目、别来源条目不能冒充已验证知识。角色获取与祖先范围由共享投影决定。
- 首轮相关回归：7 文件／50 项通过。补充了合法足时、过快、错误方式和缺方式的直接引擎对照。
- 引擎契约切换到 0.3.0，旧引擎历史按已有版本校验拒绝混读；世界状态和 prepared 格式在对应后续工作包切换。并未声称所有机制授权、角色视图和五类效果已全部完成。

## 待完成

## W2：统一决策视图

- `actor-decision-view.ts` 派生当前角色的目标、评估、关系、义务、规范及过程，接入玩家、直接 NPC 与自主角色的共同上下文。
- 角色仅自动读取自身的关系态度；被指向的人不会因此获得对方的私有态度。活动目标包含已提交的 branch goals，修复 NPC 仅读 canonical goals 的问题。
- 新引用在 Pi 模型边界使用 semantic 临时句柄，保留人物与 head 隔离。
- 验证：`pnpm run check`；玩家、NPC、Pi 边界、自主角色与新增回归共 6 文件／57 项通过。

W1–W8 的实现与完整验收仍在进行；不能以本记录或基准单测代替整本主要人物认证。
