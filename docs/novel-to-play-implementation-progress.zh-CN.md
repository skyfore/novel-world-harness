# 小说到 Play 实施记录

本记录对应 [技术设计](novel-to-play-technical-design.zh-CN.md) 与 [验收计划](novel-to-play-acceptance-plan.zh-CN.md)。仅有明确代码和验证记录的项目才标记完成。

## W0：反例基线

- 主线基准：`b2c010548edc519ea957e0ddc9fffdb47c297a5d`；设计提交：`12d9bb39d75ed2d17d841f7d18e941d09f8966ad`。
- 新增 `test/novel-to-play-regressions.test.ts`，从真实玩家转换、最终角色上下文和引擎提交三个入口验证 F1/F2/F3。
- 修复前运行：`pnpm exec vitest run test/novel-to-play-regressions.test.ts`，3 项按预期失败。F1/F3 接受了应拒绝的效果；F2 投影有 1 条知识、最终角色上下文为 0。
- 测试使用有真实 sourceId 归属的隔离 fixture；不构成真实小说抽取质量证据。身份、时空或实体等更广版本契约随首次不兼容实现一起提交。

## 待完成

W1–W8 的实现与完整验收仍在进行；不能以本记录或基准单测代替整本主要人物认证。
