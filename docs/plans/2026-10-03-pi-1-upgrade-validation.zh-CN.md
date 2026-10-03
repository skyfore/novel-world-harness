# Pi 1.0.0 升级验收记录

2026-10-03（北京时间）。实施基线为 `main@0a9fd12`，目标为三个 Pi 直接依赖精确固定 `1.0.0`。交付前再次核对 [上游 latest release](https://github.com/earendil-works/pi/releases/latest)，仍指向 [v1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0)。集成验收通过，可以提交升级 PR；不把该结论扩展为所有平台、provider 或完整小说编译均已验证。

原始计数、合成来源锚点、世界 hash 和五轮性能数据见 [JSON 证据记录](2026-10-03-pi-1-upgrade-evidence.json)。运行环境为 Linux x86_64、Node 22.19.0、pnpm 11.21.0。

## 安装、回归和用户入口

| 检查 | 结果 |
| --- | --- |
| 独立源码副本 `pnpm install --frozen-lockfile --offline` | 通过；补丁可重现 |
| 从三个直接依赖递归解析实际 Pi 包 | ai、coding-agent、tui、agent-core、telemetry、codemode、mcp 均为 1.0.0；新增传递包不代表启用相关能力 |
| `pnpm check` | 服务端、Web、E2E 类型检查通过 |
| `pnpm check:pi-tests` | 改动的 Pi 测试及手动真实验收脚本通过严格类型检查，并纳入 CI |
| `pnpm test --maxWorkers=4` | 235 文件、1538 项全部通过；82.09 秒 |
| `pnpm test:semantic-contracts` | 2 项原生语义契约通过 |
| `pnpm test:e2e` | 服务端/Web 生产构建通过，2 项 Playwright 测试通过；仍有既有 Vite 大 chunk 提示 |
| 100×32 PTY，regular / fullscreen | 均正常启动、恢复旧会话、打开帮助/模型/登录菜单并取消、处理 Ctrl+T 与两次 Ctrl+C；退出码 0，输出含正确 NWH root/session 的恢复命令 |

首次整仓测试为 1537/1538：`proposal-tools` 仍断言 56 个工具，而 main 已增加三个角色复核工具，实际为 59。在未修改的 main + Pi 0.84.2 独立副本中复现同一失败后，修正数量并增加三个工具名称断言；整个文件 55 项与整仓复跑均通过。升级没有新增默认编译工具。

终端探针第一次使用无消息的新会话，没有恢复提示；这符合 Pi 只对持久化会话提供恢复命令的行为。改为真实旧版 fixture 后，两种终端模式均通过。原生子流一次提交、拒绝撤销、首次 custom 场景持久化、thinking 完成折叠/快捷键/鼠标行为另由针对原生组件的自动化测试覆盖。PTY 检查不等同于人工观察 macOS、Windows 或真实鼠标的显示效果。

## 真实 provider 与限定来源

确认已有用户级 Pi 登录，历史记录中的 `openai-codex/gpt-6-luna` 调用也曾成功。认证读取需要锁文件；受限环境返回空快照不能据此诊断“没有凭据”。本轮只在权限为 0700 的临时目录使用该 provider 的认证/模型配置副本，认证文件权限为 0600，不将凭据写入仓库或报告。

固定 provider/model 为 `openai-codex/gpt-6-luna`，thinking 为 `medium`。隔离配置关闭自动重试和自动压缩，以便分别观察手动压缩/取消；缓存保温配置仍为 `streaming`，由 NWH 策略阻止后台请求。用户原始 Pi 设置文件最后修改时间为 2026-09-24，本轮没有改写它。额外的初始 CLI 认证探针返回 `PI_1_NWH_SMOKE_OK`，未计入下面三个预算。

合成来源全文为以下一行，末尾带 LF：

```text
Mara stood alone in the Hall. She was alive. She looked around the Hall without moving or speaking.
```

SHA-256：`4d0a44426d114471904e2f00cc03223869216eed6e3c2b34afe1b670891dc240`。没有读取或发送用户小说。

| 场景 | 模型步骤 / payload | provider 记录的总 tokens | Pi 估算费用 USD | 结果 |
| --- | ---: | ---: | ---: | --- |
| 单个 compiler scope | 2 / 2 | 3,891 | 0.000601 | 唯一允许的 `propose_entity_mention` 成功；宿主校验原文字节 0–4 的 Mara 锚点，提交来源注解 |
| 玩家行动与叙述回合 | 10 / 10 | 54,719 | 0.006879 | 真实 translator、专家和 narrator；引擎接受行动并提交，叙述不改变 head 或投影 |
| 长工具输出、压缩、取消 | 8 / 7 | 49,070 | 0.007281 | 68,489 字节工具结果，压缩前估计 15,782 tokens；摘要长 445 字符；取消后检查点数量不变 |

20 个模型步骤、19 个 payload 均进入同一场景的累计预算。取消路径中一个步骤没有进入 payload；保留该差额和已消耗预算。费用合计约 $0.014761，来自 Pi 的模型价格配置计算，**不是账单**；中断请求可能没有返回用量，不能视为免费。三个场景未发生 provider 自动重试，来源提案工具未报错，narrator 首次尝试通过。

编译范围仅为一个宿主校验后的来源注解：没有调用批次 finish、没有宣告全局语义闭合、没有归档候选世界、没有执行认证或激活。玩家回合使用宿主根据同一合成来源构造的运行时 fixture，验证引擎与模型边界；它不冒充由这一次注解提案自动生成的可执行世界。

真实调用只覆盖上述 OAuth provider 和当前有效登录。OpenAI Chat Completions、Anthropic Messages 的自定义 endpoint、thinking、流事件、成功/错误工具回放及用量，由实际 Pi adapter 加模拟 HTTP SSE 验证；其他真实 provider 和过期 OAuth 刷新未实测。

复现入口为 [手动集成脚本](../../test/manual/pi-upgrade-live.ts)，不进入默认单测，也不自动寻找或复制用户凭据。先在独立临时目录准备有权限的 Pi 配置副本并固定上述模型/thinking，然后执行：

```sh
export PI_UPGRADE_SMOKE_DIR=/absolute/isolated/pi-upgrade
export NWH_HOME="$PI_UPGRADE_SMOKE_DIR/runtime"
export PI_CODING_AGENT_DIR="$PI_UPGRADE_SMOKE_DIR/pi"
node --import tsx test/manual/pi-upgrade-live.ts compiler
node --import tsx test/manual/pi-upgrade-live.ts play
node --import tsx test/manual/pi-upgrade-live.ts compaction
```

该脚本会调用真实模型；各阶段保留结果、预算和失败，不覆盖已有结果文件。出现失败后先读原报告和账本，不能清空记录或更换 ID 来绕过停止条件。

## 性能结果

使用 [同一离线脚本](../../test/manual/pi-upgrade-benchmark.mjs) 在两个独立安装的版本上各跑 5 次，交替顺序，取中位数；没有并行运行测试套件。宽度固定 100，200 条 transcript，169,890 字节中英混合 Markdown，7,000 条渲染行，40 个流式更新，搜索结果均为 1,000 条。请求装配结果均为 247,335 字节。

| 指标 | 0.84.2 | 1.0.0 | 说明 |
| --- | ---: | ---: | --- |
| 新 Node 进程首次 SDK import | 359.74 ms | 266.84 ms | 减少 25.8%；操作系统文件缓存未清空，不是磁盘冷启动 |
| 同进程再次 import | 0.048 ms | 0.058 ms | 绝对差约 0.010 ms |
| session context + JSON 装配 | 0.413 ms | 0.411 ms | 基本持平；不是网络请求延迟 |
| 首次渲染 | 80.91 ms | 63.29 ms | 减少 21.8% |
| 缓存后全组件 render | 0.066 ms | 0.098 ms | 增加约 0.032 ms；仍包含遍历/聚合 7,000 行，不是零成本缓存命中 |
| 变更查询、重新扫描 | 163.28 ms | 33.52 ms | 减少 79.5% |
| 相同 transcript/query 的重复搜索 | 161.34 ms | 0.123 ms | 新版走实际 TUI 索引缓存；包含 O(n) 行一致性检查，不外推为全部搜索的提速 |
| 40 次流更新及最终渲染 | 868.88 ms | 596.88 ms | 减少 31.3% |
| SDK import 后 heap | 41.14 MiB | 31.03 MiB | 减少 24.6% |
| 单条长消息额外保留 heap | 6.38 MiB | 5.56 MiB | 本工作负载减少 12.9%，没有复现上游示例的 80% 降幅 |
| 全探针结束后 heap / RSS | 48.73 / 279.43 MiB | 44.42 / 234.96 MiB | heap 减少 8.8%；RSS 有明显运行间波动，见 JSON 范围 |

原始同步循环会让新版 Markdown 的 `WeakRef` 目标在同一 JavaScript job 内保持存活，即使调用 GC 也不释放，产生不符合实际流式 UI 的高堆读数。最终脚本让每个更新跨 event-loop turn，并在内存采样前等待下一轮，避免将基准自身的保活效应误报为产品内存泄漏。两版采用相同采样流程。

缓存 render 的约 0.032 ms 和 warm import 的约 0.010 ms 增量均保留报告。当前固定工作负载未发现影响实际流式吞吐的退化；不能据此承诺整个应用固定比例的内存、模型费用或端到端速度改善。运行：

```sh
node --expose-gc test/manual/pi-upgrade-benchmark.mjs /absolute/baseline-checkout
node --expose-gc test/manual/pi-upgrade-benchmark.mjs /absolute/upgraded-checkout
```

## 回滚和分支关系

在独立 main 源码副本恢复原 package/lockfile/0.84.2 patch，`pnpm install --frozen-lockfile --offline` 与 `pnpm check` 均通过。停止合成 fixture 写入后复制其 runtime，使用两版分别读取同一已提交分支并追加各自的旧会话工作副本：

- 两版世界 head 均为 `072ee18d826adb8fa8a194a148642933473912a219cc67fd70f488dc8358316f`。
- 两版状态规范化 hash 均为 `645f25e24d563963f6887f14eb18d03164451d2c744021bec3a331c49cfb66f0`。
- 两版从旧 session fixture 的 7 条 entry 追加到 8 条；旧版只续写旧备份的工作副本，没有尝试解释升级后新增 session entry。
- 原始 live runtime 与回滚 runtime 各 24 个文件逐字节 hash 保持一致，包含来源、世界历史和升级后会话；旧 session 原始备份也不变。

真实回滚仍需先停止写入，备份 sessions、last-opened 指针、NWH/Pi 设置，然后恢复旧代码、锁文件与 patch。使用旧会话备份或新的旧版会话，保留升级后历史供诊断；不得删掉新 entry、清空失败账本或回退世界事件。此处验证的是不涉及世界格式迁移的依赖升级。

交付前 `git fetch origin` 后，`origin/main` 仍为 `0a9fd12`。先前保存的 `codex/compiler-recovery-contracts@ccd1b11` 尚未合入 main，本 PR 不包含它。后续合并该工作时，需要重新核对其请求观测包装与当前预算/摘要边界，重跑相应恢复回归。
