# 证据优先的部分世界模型：技术方案与实施顺序

日期：2026-09-16。代码基线：`335cdfe2c8ba3b7c626f978d82c700d6a26ece8b`。目标分支：`codex/compiler-recovery-fixes`。

当前分支 `bdf79b8` 的 review 差异核查和后续执行设计见 [Review 落地设计](2026-09-16-review-to-capability-closure.zh-CN.md)。该文细化持久义务、修复执行器、上下文、文学表达及推进策略；将 T9 中可基于现有类型实现的义务结算提前，不改变本方案其余目标范围。

## 0. 决策与交付边界

目标不是为某一本小说补齐数据，而是把历史运行中的失败转成可复用的语义契约、编译能力和反例测试。保留 `AGENTS.md` 及 ADR 0001 的约束：原文不可变、模型输出先为 proposal、宿主验证后提交、分支历史为运行时真值、角色知识隔离、Pi 管模型执行、本地文件优先。不得运行历史 recovery 脚本，不恢复已删除的 run-records，不执行整书解析，不调整已有发布门槛来制造成功。[C0]

**总方案与实施进度分开。** 下文的目标模型不是已实现功能。先交付可独立验证且接入真实调用链的安全增量，再升级持久化模型；完成一个里程碑不等于完成全部方案。实施结果另记于同目录实施文档，必须区分实际执行的测试、只写入的测试和未验证项。

第一批实现范围：内容字段级证据覆盖、独立场景 requirement 评估、诊断性依赖返修规划、相应回归。它们不能产生世界事实、授予模型写权限或独立发布世界。完整 Observation/Acquisition、暂时状态、主体渠道和迁移属于后续显式里程碑。

## 1. 证据方法

### 1.1 证据等级

- R：历史运行记录。证明该次运行发生过什么，不代表当前状态或跨小说错误率。
- C：固定 SHA 的源码。证明数据结构或控制路径，不自动证明实际抽取正确。
- S：官方规范、作者论文或官方技术文档。支持某个方法，不证明 NWH 已获得对应能力。
- D：本方案的工程推论。必须给出 R/C 动机、S 方法依据、取舍和验收条件。

没有人工标注全集，不报告全书准确率；没有真实 Play 实验，不报告长期角色行为可靠性。历史报告中的测试数字不能作为本次修改的测试结果。

### 1.2 本地证据索引

历史路径均固定在 `1c2ecac565188ea20c1511f8cca5a72400422ac9`，仅通过 Git 历史读取。

| ID | 记录及可核实事实 | 允许推出的结论 |
| --- | --- | --- |
| R1 | `run-records/2026-09-07-longzu1-full-rebuild/remediation-2026-09-08/implementation-results.zh-CN.md`，独立场景检查：接受决策的 agent 角色缺失、两次非致命击中无法表达、规范在活动两日后的合成探针仍有效、解释事件缺知识操作 | 局部 schema/绑定一致不等于原文语义正确；合成两日不是实际故事时间 |
| R2 | `run-records/2026-09-11-codex-compile-loop/README.md`，Attempt 4 把 `launched` 写入数值型 `artifact.condition`，Attempt 7 草案生命周期混淆，Attempt 8 开局驱动目标错人 | 区分表示缺口、工具误用和选错修复目标，不能统称模型能力差 |
| R3 | 同目录 `review-knowledge-dependencies.ts`、`review-dragontext-knowledge.ts`：缺语义依赖/引文不等于原文缺失；听到译文不等于获得语言能力 | 需要类型化依赖修复和获知来源，不能只重试原事件 |
| R4 | 同目录 `review-eva-projected-presence.ts`：两事件、两 participation 的 physical 被修为 represented | 在场、呈现、能动性不是同一维度；同一信息多处维护有一致性成本 |
| R5 | 同目录 `review-nono-entry-checkpoint.ts`：后续回顾支持进门前已存在的准备和意图，不支持提前授予其他角色未来知识 | 区分事实成立时间、揭示位置、角色获知时间 |
| R6 | 同目录 `review-pool-boy-constantin-identity-link.ts`：利用后文证据归一身份但不写角色知识 | 全局身份与角色识别需要不同关系 |
| R7 | 同目录 `correct-cousin-bedroom-trace.ts`：描述性规范名不在原文，需保持身份并补精确提及 | 展示标签不能冒充原文姓名；身份建立与命名策略应分离 |
| R8 | `run-records/2026-09-07-longzu1-full-rebuild/deep-review-2026-09-08/report.zh-CN.md` §5、§8.4：覆盖改变使分页失效；机制归纳所需事件可能来自不同切片 | 生命周期依赖与语义依赖都需版本化；跨事件证据包应由宿主授权 |

历史材料入口：[R1](https://github.com/skyfore/novel-world-harness/blob/1c2ecac565188ea20c1511f8cca5a72400422ac9/run-records/2026-09-07-longzu1-full-rebuild/remediation-2026-09-08/implementation-results.zh-CN.md)、[R2](https://github.com/skyfore/novel-world-harness/blob/1c2ecac565188ea20c1511f8cca5a72400422ac9/run-records/2026-09-11-codex-compile-loop/README.md)、[R8](https://github.com/skyfore/novel-world-harness/blob/1c2ecac565188ea20c1511f8cca5a72400422ac9/run-records/2026-09-07-longzu1-full-rebuild/deep-review-2026-09-08/report.zh-CN.md)。其余文件使用同一 SHA 和上述完整路径定位，不依赖已清理的工作树。

| ID | 基线代码路径/符号 | 现有能力与边界 |
| --- | --- | --- |
| C0 | `AGENTS.md`、`docs/adr/0001-world-truth-history-and-possibility-space.md` | 项目权威边界，不因本方案改变 |
| C1 | `src/world/model.ts`：Proposition、Attribution、KnowledgeOperation、EventRelation | 已有命题、归因、获取模式和关系；不要重复发明平行系统 |
| C2 | `src/world/state.ts`：DEFAULT_STATE_FIELDS、StateSchemaRegistry | health/condition 为数值；类型正确不等于字段含义正确 |
| C3 | `src/compiler/attribution-trace.ts`：attributionContentTraceIssues | 当前把 /object 子字段合在一次 some 检查，结构字段可替代内容字段；无精确内容证据存在 legacy 兼容路径 |
| C4 | `src/compiler/knowledge-repair.ts`：knowledgeRepairScopeIssues | 非知识字段保持 hash、旧知识保留、依赖可达性；direct-observation 只是范围限制 |
| C5 | `src/eval/scene-capabilities.ts`：evaluateSceneCapabilities | 独立 spec、状态/知识/规范/动作探针；诊断不等于发布证书 |
| C6 | `src/world/entry-context.ts`、`src/world/entry-cut.ts` | 已分故事时间与叙述顺序；入口仍偏 physical，读者前文完整性与入口耦合 |
| C7 | `src/world/action-ontology.ts`、`process-ontology.ts`、`norm-ontology.ts` | 已有领域模块与 source-pattern；permission 的有效期不同于 obligation 的履行期限 |
| C8 | `src/compiler/reconciliation-review.ts`、`reconciliation-review-ledger.ts` | event/character 级 proposed 不等于每项要求都满足 |
| C9 | `src/compiler/finish-receipts.ts`、`accounting-coverage-proof.ts`、`prepared-cache.ts`、`certification.ts` | 持久回执、覆盖证明和快照认证各有作用域，不得相互替代 |

代码引用统一固定在 [335cdfe2](https://github.com/skyfore/novel-world-harness/tree/335cdfe2c8ba3b7c626f978d82c700d6a26ece8b)，后续修改须记录新的提交。

## 2. 一手资料与适用范围

| ID | 资料 | 支持什么 | 不支持什么 |
| --- | --- | --- | --- |
| S1 | [W3C PROV-O，§3.3 qualified terms](https://www.w3.org/TR/prov-o/#description-qualified-terms) | 关系可以带活动、角色、时间及来源等限定信息 | provenance 不证明命题为真；不要求引入 RDF/图数据库 |
| S2 | [W3C Web Annotation Data Model，Selectors/States/Multiplicity](https://www.w3.org/TR/annotation-model/) | 精确文本定位与资源版本是独立信息；复杂标注有明确组合语义 | 不能把本项目 UTF-8 字节偏移宣称为规范中的 Unicode 字符偏移；多 selector 并不天然表示不连续话语 |
| S3 | [W3C OWL-Time，§4.2 interval relations](https://www.w3.org/TR/owl-time/) | 时间点、区间、先后/重叠/包含等关系 | 不提供小说获知时间算法，也不保证故事具有全序 |
| S4 | [MLIR Toy 第五章：Partial Lowering](https://mlir.llvm.org/docs/Tutorials/Toy/Ch-5/) | 高层信息可在部分 lowering 时保留，再逐步转为低层表示 | 这里只借用编译分层方法；不引入 MLIR，不把自然语言处理类比成语义已确定的程序编译 |
| S5 | Guan 等，NeurIPS 2023，[Leveraging Pre-trained LLMs to Construct and Utilize World Models for Model-based Task Planning](https://proceedings.neurips.cc/paper_files/paper/2023/hash/f9f54762cbb4fe4dbffdd4f792c31221-Abstract.html) | 显式领域模型、纠错与后续规划分离的可行方法 | 有限动作域结果不能证明整书世界或任意反事实正确 |
| S6 | Riedl & Young，[Narrative Planning: Balancing Plot and Character](https://arxiv.org/abs/1401.3841) | 因果可行性与角色意图可信是不同设计目标 | 给定领域理论的叙事规划不证明小说自动归纳可靠；作者终局不得成为强制调度目标 |
| S7 | Mokhov/Mitchell/Peyton Jones，[Build Systems à la Carte，ICFP 2018](https://simon.peytonjones.org/build-systems-a-la-carte/) | 构建系统可按调度和重建等职责分解、比较 | NWH 的语义修改是否正确仍需自己的验证，不能只套依赖算法 |
| S8 | [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)、[RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) | JSON Pointer 的精确路径与 JSON Patch 的条件式局部修改 | JSON Patch 本身不提供授权、世界语义或跨文件事务 |

访问日期：2026-09-16。表中的 NWH 迁移方案均为本项目工程决策，不伪称规范要求或论文已证明的本项目收益。

## 3. 目标模型：五种承诺，禁止互相代替

1. **SourceObservation**：可定位的原文观察。原文锚点正确，不等于其中所述事件真实发生。
2. **SemanticAssertion / SemanticEffect**：原文支持的身份、内容、状态变化或解释；带证据地位、时间和适用域，不因暂无 reducer 而丢失。
3. **ExecutableBinding**：将已确认语义映射到已有 state/process/norm/action 通道，明确映射版本和限制。
4. **BranchEvent**：只在当前分支前置条件及裁决通过后提交；原著未来不是分支已发生事实。
5. **CapabilityAssessment**：基于独立预期验证某项用途；有出处、有定义、可执行、已认证分别报告。

D1 依据 R1/C1/C2/C5/S4/S5：语义结果先保留，再 lowering。不是新增一个任意 JSON 绕过验证的袋子。没有受控 semantic kind 的现象只能作为有证据的 unmapped requirement，不进入运行状态。

### 3.1 SemanticEffect 目标契约（后续持久模型升级）

字段：稳定 effectId、eventId、subject refs、受控 effectKind、typed arguments、validTime、evidence bindings、interpretation status。执行化单独记录 `unreviewed | no-change | represented-unmapped | lowered | blocked`，并绑定 effect revision、mapping/module version、lowered artifact revisions。

`no-change` 必须有独立审阅理由；不能由空 StateDelta 推导。`represented-unmapped` 保留原概念与影响对象，禁止填入无依据 health 数值或把失能写成死亡。`lowered` 只证明映射通过自己的后置条件，仍不等于全书可玩。

前期复用独立场景 spec 的 `delta/no-change/unmapped`，在评估输出中保留原 expectation 和每项结果。持久 canonical schema 升级前不注入新世界字段。

## 4. 命题、表达行为、获知关系

D2 依据 R3/C1/C3/C4/S1/S2：Proposition 是可复用内容，UtteranceExpression 是某次话语表达该内容，Acquisition 是某角色在某事件接收到该表达或观察。三者拥有不同证据。

### 4.1 先修当前内容覆盖边界

内容承载指针为 `/object` 或当前 proposition object 的 `/object/value`、`/object/entityId`、`/object/propositionId`。`/object/kind` 不得替代内容证明。对同一内容字段可以有替代证据；一次 assertion 的多个 anchors 是合取，必须全部被本次引用的有效话语片段覆盖。整体 `/object` 的完整证据可覆盖各内容字段。不要把所有命题在全书的支持证据都强制塞入每次话语。

返回 supported/unsupported/unverified，明确没有证据不等于支持。已有 legacy 数据的无精确内容证据路径先保持可读，但不升级为语义认证；只有结构证据的新检查不得假通过。端到端升级后的表达边须用本次表达的证据，不再借全局 proposition anchors 充当全部来源。

### 4.2 表达与获取目标结构

- `UtteranceExpression`：utterance revision、proposition revision、content field bindings、speaker/addressee refs、context/event refs。
- `PerceptionObservation`：observer、event/cut、channel、可见对象/现象、精确证据、推断解释。
- `Acquisition` 用判别联合：observed 指向 perception；told 指向 expression 和接收者；read 指向文档表达与读取事件；inferred 指向 actor 已知前提及推断依据；remembered 指向既有经历；deceived 保留实际与误认来源。
- `received/understood/believed` 不合并，语言能力、世界事实真实性和编译置信度不由获取模式自动推出。不得因 sourceActorId 删除而将转述变成直观观察。

证据连接必须经过已有 source hash、锚点、身份与事件作用域验证。仅有 ID 存在不证明角色在那个时点有访问能力。

### 4.3 不连续话语

先保持每段 TextAnchor 逐字精确，再用显式、有序的片段列表构成一次话语；叙述插入语属于 cue/context，不拼成不存在的逐字引文。去重、同 source、顺序、重叠与话语归属由宿主验证。与 W3C 字符坐标转换只在明确 adapter 中进行，内部继续使用不可变 UTF-8 byte ranges。[R2/R3/C1/S2]

## 5. 身份、主体、呈现与视角

D3 依据 R4/R6/R7/C1/C6/S1：实体身份、角色能动性、呈现方式与动作渠道分开。

保持稳定 Entity ID。新增 capability profile 时不把照片中的人物升级为活主体。实时投影可通过受支持的通信渠道交流；只有经机制授权的设备才能改变物理世界。入口以 viewpoint + perception/action channels + supported cut 为条件，而非将所有入口都改成接受 represented。

全局 mention→entity 可利用后文；actor-recognition 必须有该角色的 acquisition。角色显示名从该视角可用的称谓中投影，最终 canonicalName 不得自动泄露秘密身份。无名字但有确定指代的对象允许稳定 ID 和明确标为派生的展示标签；派生标签不是原文证据，不进入 exact-name 校验。

迁移顺序：先补 capability profile 与诊断，只读投影；再接 action adjudication；最后扩展入口。继续保留 physical 旧入口，直到新渠道路径具有独立验证，不能只放宽一个 enum。

## 6. 状态、过程、时间与规范

### 6.1 状态模块

D4 依据 R1/R2/C2/C7/S4：分开物理完好程度、生命周期、运动阶段、控制权和暂时能力限制。临时状态实例需类型、主体、起止/解除条件与来源。复用 ProcessTemplate，不增加平行过程引擎。新字段必须通过版本化宿主模块登记，包含类型、适用主体、可见性、开放世界假设、可用操作和不变量。

源只支持失能而不支持精确恢复时长时，保留未知时长；运行时恢复必须来自允许的过程/事件，不让渲染层自行恢复状态。

### 6.2 时间契约

D5 依据 R5/C1/C6/S3：区分 validTime、disclosurePosition、actor acquired cut、compiler recorded revision。分支 commit 总序只约束实际运行历史，不为全部原著事件强造全序。

统一 time relation catalog；关系扩展须覆盖 before/after/during/contains/overlaps 的一致性。对当前入口，只有会影响其状态/知识/过程依赖的未知顺序才需要阻塞；该优化必须证明无依赖的事件可交换，不能仅凭不同角色 ID 跳过约束。后文回顾可支持已存在事实，不能提前引入后来才学到的知识。

### 6.3 规范作用域

D6 依据 R1/C7/S3：Norm applicability 必须描述 subjects、jurisdiction、activity/time window、action categories、authority 和 exceptions。区分 permission 有效期与 obligation 履行期限。规范后果与物理效果分离：免除某校规处罚，不等于免伤或免除其他权威的约束。

空 appliesWhen 只有在明确审查为无条件时才允许晋升为全局适用；缺失作用域必须保持 unknown。先定义语义范围，再 lowering 为 predicates/activation events。验证活动前/中/后、成员/非成员、辖域内/外、被豁免/未豁免行为及三值未知。

## 7. 机制归纳、因果与人物

D7 依据 R8/C7/S5：MechanismInduction 分为 source-statement、observed-pattern、domain-module。明确陈述仍需归因可信性审阅；两个发生实例不是通用规律的充分证明。pattern 需支持实例、条件差异、反例、未知范围。宿主为非相邻支持事件提供 citable evidence package，保留上下文可读与可引用权限的区别。

D8 依据 R2/C1/C6/S6：保留 causes/enables/motivates/explains/narrative-continuation 区别，图连通率不是补 causes 的理由。人物目标由当下知识、处境、价值偏好和亲历边界驱动；不强制每个角色都成长。开局目标属于入口主体，而不是全书最高频人物。原著未来可用于候选和评测，不作为必达终点。

## 8. requirement 与受限依赖返修

D9 依据 R1/R3/R8/C4/C5/C8/C9/S7/S8：完成单位从 event/character ID 下沉到具有独立后置条件的 requirement。

### 8.1 requirement 身份与结果

定义包含 id、sourceId、targetRef、capability、stage、独立 expectation、证据引用及 dependsOn。评估包含 sourceSha256、specHash、catalogHash、evaluatorVersion 和逐项结果。状态采用 satisfied/blocked/unknown/unmapped/stale；不把 proposed 当作 satisfied。解释文本不是唯一状态载体。

同一事件可分别满足状态结果与 agency，但机制仍未满足。未提供结果时保持 unknown；缺少当前版本结果不能当完成。结果与源/spec/catalog/evaluator 任一版本不匹配必须 stale；重复 ID、越域、未知依赖、循环依赖应明确报错，禁止 last-write-wins。

第一步在独立 `review-scenes` 报告增加 requirement assessment，不替代既有逐目标回执、账本或 publication gate。语义结果 expectation 原样保留，不从候选 delta 决定测试答案。

### 8.2 依赖图与权限

返修计划先作为只读诊断：给出 requirement IDs、目标、证据和阶段，按依赖排序。输出明确 `authority=diagnostic-only`、`requiresHostAuthorization=true`；没有隐式重试或创建模型会话。限制计划大小必须报告 remaining IDs，不得静默丢目标。ontology unmapped 必须回宿主设计审阅，不自动创建字段。

后续执行器才在 compiler lock 内将一个任务变成窄类型授权：基线 revisions、允许改动的 JSON Pointers、只读依赖、可引用锚点、失败身份、后置条件、依赖有效性。原 payload 的不相关字段保留；错误旧语义通过显式撤销/修订，不用单调性禁止纠错。JSON Patch 只作修改表达，宿主另做权限和语义验证。

### 8.3 增量失效与回执

索引必须同时记录 logical identity、active revision、proposal history 和 evaluator fingerprint。旧 accepted envelope 仍存在不代表当前 ref 仍生效。变更从受影响节点向派生依赖传播，原 finish 历史不改，必要时创建显式新验证轮次；禁止旋转 namespace 洗掉义务。新 revision 激活前重验 closure/cut，旧分支固定旧 bundle。

## 9. 存储、工具与兼容策略

新增诊断输出不改变世界目录布局，也不把日志放回仓库。持久模型升级拟采用 `world/.../semantic-effects`、`expressions`、`acquisitions` 等按 source/revision 内容寻址的 store，具体路径在实施迁移 ADR 中确定，避免先落一套与现有 compilerSnapshot 平行的未纳管存储。

模型只提交窄类型语义提案；新 mutation 每个都要完成：Zod/工具 schema、source/evidence 验证、staging、finish dependency binding、convergence、snapshot、closure、rebuild、runtime reducer 和反例测试。任何一环未接通，不得把新增 schema 标为可用能力。

先 additive read diagnostics，后 dual-read 显式迁移，再启用新 compilation pipeline 版本。不得把旧 empty delta 自动迁成 no-change，不得给旧 knowledge 自动补观察来源，不得将旧 physical 人物自动转为任意全能主体。旧快照保留旧 fingerprint；新评估不重写历史。

## 10. 实施里程碑及逐步提交

| ID | 依赖 | 交付和主要文件 | 验收/退出条件 |
| --- | --- | --- | --- |
| T0 | — | 本计划、R/C/S 决策矩阵 | 每个 D 决策有依据和验收；范围与进度区分 |
| T1 | T0 | `compiler/content-support.ts`，接入 `attribution-trace.ts` | kind 不能盖过 value；替代证据可用；多 anchor、跨源、零长度、legacy 未证实均测试 |
| T2 | T0 | `compiler/semantic-requirements.ts`，`eval/scene-requirements.ts`，接入 `scene-capabilities.ts` | 保留 expectation；部分成功不清除其他要求；stale/缺结果/重复/循环有确定行为；诊断计划无写权限 |
| T3 | T1,T2 | 原创反例、离线 native runner、Vitest 集成测试、实施记录 | 实际运行内核测试；明确未运行的全仓测试；源文件静态检查与远程内容核对 |
| T4 | T2 | SemanticEffect proposal/store/validator/snapshot/closure 全链路 | no-change 与 unmapped 不混淆；未执行化语义可读但不能运行 |
| T5 | T1,T4 | Expression/Perception/Acquisition、知识投影与 evidence trace | 重复命题独立表达；直接观察不接受改标转述；获知 cut 与渠道闭合 |
| T6 | T4,T5 | 暂时状态模块、ProcessTemplate 映射、Norm scope lowering | 失能/恢复、生命周期、规范边界及 unknown 反例 |
| T7 | T5 | Entity agency/channel profiles、actor recognition、入口和行动验证 | 远程主体可交流但不能无机制搬物；照片无能动性；名字不泄漏身份 |
| T8 | T4,T5,T6 | 统一时间约束、跨事件证据包、mechanism induction 来源 | 局部顺序、回顾、重叠事件、后文知识隔离；不强造规律 |
| T9 | T2,T4–T8 | requirement ledger、受限修订执行器、反向依赖失效 | 中断恢复、版本冲突、旧 ref、缩小计划、部分成功均不丢义务 |
| T10 | T4–T9 | compiler fingerprint 升级、migration、rebuild、Play 集成 | 不含人工个案补丁的 fresh synthetic fixture 全链路；replay/fork/resume/divergence；全仓测试与类型检查 |

T0–T3 是首个可验证代码批次，不等价于 T4–T10。未经真实模型实验，不宣称新模型抽取泛化率提高。

每个提交使用现有分支、基于明确 parent，更新 ref 禁止 force。提交中只放源码、原创固定预期和维护文档；运行输出不入库。最后重新读取分支和关键文件，核对提交链及内容。

## 11. 验收矩阵

| 用例 | 独立预期 | 不允许的假成功 |
| --- | --- | --- |
| 暂时失能，时长未说明 | 语义保留、时长未知、无执行映射则 unmapped | health 随机赋值、死亡、empty delta 当无变化 |
| 同内容由两人分场景表达 | 命题可复用，各表达边单独证据 | 全局 proposition evidence 偷换本次引文 |
| 引文内 kind、引文外 value | 内容不支持 | some 命中结构字段即通过 |
| 叙述插入语打断一句话 | 多片段逐字证据 | 拼造连续 exact 引文 |
| 听到翻译，仍不懂原语 | 获取译文，不获得语言能力 | 一次 learn 同时升级所有能力 |
| 全息通信主体和照片 | 前者仅有受支持渠道，后者无当前能动性 | represented 等价 physical |
| 后文回忆先前准备 | 事实 validTime 可早于 disclosure | 别的角色提前知道后来对话 |
| 活动期间豁免一种处罚 | 只在主体/时域/辖域/行为类别内适用 | 永久全局许可或物理免伤 |
| 一个目标三项要求只修一项 | 一项 satisfied、其他仍有状态和依赖 | proposed 清掉整个人物所有义务 |
| 已评估后 catalog/spec 改变 | stale，需要新评估 | 旧成功回执冒充新版本结果 |
| 依赖图循环/未知边/重复结果 | 明确拒绝或阻塞，零调度 | 静默丢失目标、按输入最后一条覆盖 |
| 改名字、重排独立句、加入干扰对话 | 保持语义约束与授权边界 | 针对某个书名/角色名硬编码 |

## 12. 风险与不采用的方案

不采用自由 JSON 世界状态：它会使类型、可见性和 reducer 契约失效。[C0/C2]

不采用强制每事件非空效果、所有角色成长或全图 causes：这会把评测指标变成伪造事实的压力。[R1/R2/C1/S6]

不采用模型直接跨阶段写 store：保留权限边界，补上受限依赖调度。[R3/R8/C4/S7]

不采用所有来源都同一置信度：区分原文出现、角色相信、编译推断和世界事实；数值置信度不赋予权限。[C1/S1]

不因本方案引入外部数据库、向量服务、MLIR 或 RDF 运行时。借鉴其概念，不增加未经必要性证明的基础设施。[C0/S1/S4]

最大的实施风险是增加大量未接入的 schema。每个持久模型变更必须通过 §9 的完整接入清单；首批内核应被真实 evaluator/validator 调用，纯诊断能力如实标明范围。另一个风险是新严格校验暴露旧数据问题；保留原 revision 和 source，报告迁移要求，不静默补值或放宽发布。
