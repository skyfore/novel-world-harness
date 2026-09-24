# P3：分支获知、legacy 候选迁移与工程退出验收

本次承接 A2–A6 后的三个工作项：让分支临时获知有实际事件来源、提供缺证据即停止的旧记录迁移、汇总两来源验收。新增实现不修改原文，不把叙述、未来 canon 或接收者信念写成世界真值。

## 实现与边界

`branch-acquisition-v1` 是 committed event 的 semanticDelta 中的经历记录；其 host ID 绑定 branch/head/proposal，introducedBy 指向实际提交事件。对应 learn 必须同事件且恰好一次，receipt 的 hash 不含提交 provenance，避免自引用以及预验证和 replay 不一致。原 `acquisition-v1` 继续服务有原文证据的 canonical 获知；两者共用 KnowledgeState、事件历史、fork、checkpoint 和 replay。

- told／deceived-misattributed：绑定本次 spokenUtterances 的精确索引、原话、物理在场接收者和来源 attribution；实际来源与误认来源分别保存，角色视图仅显示其相信的来源。
- observed：目前只执行已有直接视觉能力边界内的 `location.open` 与 `character.location`，检查实际事件末状态、位置和物理在场。不能把晚期报告改名成 observed。
- read：引用已在本分支实现的冻结 writing expression，并证明角色与文书当前同地。此包不新增分支文书创作、本体照片或远程渠道。
- remembered／inferred：只引用该角色在事件前已提交、理解过且修订匹配的经历；记忆保留原命题，推断还要求前提仍被接受。不能用同事件刚制造的收据、别人的知识或另一个分支代替。
- 接收、理解、相信分别记录；新协议只产生 heard／believes／disbelieves，不授予 knows。角色模型只能提出自己的获知，不能决定另一角色的信念。decision.experiences 为当前可用个人知识提供 opaque 引用；没有提供的引用必须停止。

这些确定性检查证明结构、来源与可达性，不声称自动证明任意自然语言原话蕴含某命题，或任意推断 rationale 的逻辑正确性；这些内容仍是待领域判断的提案。旧无 Acquisition 的记录维持未验证兼容读取与既有内部调用；不会因新引擎存在便自动获得新协议认证，已存在显式获知合同的内容不能删除 acquisitionId 绕过检查。

## 迁移入口

```sh
nwh migrate-acquisitions reviewed-migration.json --root /absolute/workspace
```

清单格式为 `version: 1, sourceId, parentBundleHash, entries`。每个 entry 必须包含原 canonical event 的 `eventHash`、零基 `operationIndex`、完整 `acquisition-v1` 输入（不含 host 计算的 revisions/evidence）、`evidence_segment_ids` 和 `evidence_selectors`。selectors 使用已有精确原文协议，并独立覆盖 actor、event、cut、claim、proposition、basis 各字段以及 reception 的三个字段。不存在原文证明时不能凭旧 heard／believes 状态填出理解或信念。

流程读取指定不可变父版本，在独立临时工作区恢复；验证目标 learn、收件人、内容与已有 provenance；只补协议引用，保留旧 status、confidence、已有 sourceActorId 和所有非知识事件字段；旧操作未记来源时，只能从已验证的 Expression／显式误认 basis 补出来源。先固定完整事件修订，再通过真实 propose_acquisition／finish／converge 验证证据与依赖，最后 archiveCandidate 并记录父版本 lineage。返回候选 hash、迁移数量及可复核工作区。不会激活候选、覆盖调用方 staging 或重写运行中的分支。

缺字段证据、错误事件 hash、重复目标／ID、非 legacy learn、改写已有来源或状态不匹配均停止。失败工作区保留供审阅；不自动补造 Expression、Perception 或缺失事件。如果父版本存在其他阻塞闭包／旧编译协议问题，必须先修复，迁移命令不豁免发布门禁。清单只迁移明确列出的操作，未列项仍是 legacy；候选成功也不是全书所有旧获知都已迁移的证明。

## 验收账

| 工程项 | 预期与证据 | 结算 |
| --- | --- | --- |
| 编译语义链 | `semantic-effect.test.ts`：原文 → 提案 → finish → closure → 冻结 → runtime；无可执行映射不授予知识 | 通过 |
| 表达链 | `utterance-expression.test.ts`：英／中文原文；命题复用、多片段、嵌套及多 occurrence；各表达独立内容证据，缺字段与循环拒绝 | 通过 |
| 感知链 | `perception-observation.test.ts`：两来源真实 finish／converge／重建／cut；报告改 observed、能力或可达性不足拒绝 | 通过 |
| 原文获知 | `acquisition.test.ts` 原有矩阵：told/read/observed/inferred/remembered/deceived、未理解、未来 cut、错误经历及修订拒绝 | 通过 |
| 分支新获知 | `branch-acquisition.test.ts`：英／中文两场景，新对话 → 收据 → 记忆 → 推断 → opaque 模型边界往返 → 冷回放；其他角色与兄弟分支隔离 | 通过 |
| 分支负例 | 同测试：缺原话／错接收者、孤立收据、状态不实的观察、knows 升级、重复 cut、文书未发生或不同地拒绝；主分支 head 不前进 | 通过 |
| legacy 迁移 | `acquisition.test.ts` 新增两来源真实清单 → 提案／finish／converge → 新候选 → runtime 收据 → 冷回放；父 bundle、调用方事件和 active pointer 保持原样；删理解证据、旧 hash 拒绝 | 通过 |

这是工程验收。测试使用原创短篇与显式清单，不冒充 fresh provider 编译、独立双人来源评估或真实小说全量迁移。P4 的远程／照片／生命周期扩展、P5 文学表达与工作集以及 P7 外部验收仍独立开放。

engine 升至 0.24.0，knowledge reducer 为 2、semantics reducer 为 3；旧 checkpoint 不当作新 reducer 结果使用，既有历史文件不改写。历史分支的 engine-version 门禁保持，旧引擎分支不会被静默解释成新协议。

验证：全套 Vitest 215 文件、1297 项通过（118.69 秒）；原生契约 15 + 29 项通过；服务端、Web、E2E 三套 TypeScript 检查通过。新增 9 项测试已计入总数。CLI 构建与命令帮助检查通过。
