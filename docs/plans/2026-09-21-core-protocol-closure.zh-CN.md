# 核心协议续做（不含具体小说质量验收）

基线：`b6bab030a55515f4f7a6a64cd71b001bb348726f`，树 `c5372b5ad35176f7df6165ef23095c9c61ec8894`。
本轮范围是已有 P1–P6 的代码与生产接线；不跑具体小说、不修改用户运行记录，不把原创工程夹具当真实模型或人工验收。

## 开发顺序

1. 宿主回合预算、自主角色有界工作集、统计关联。
2. 运行期获知与表达的事件归属、角色识别／称谓隔离。
3. 时间关系、规范作用域、机制与渠道能力的通用实现和消费。
4. 文学引用与原著表达到已提交台词的受控绑定。
5. 对新增类型接回证据、修复、冻结与重放，并执行完整工程回归。

阶段完成只代表这里明确记录的代码和测试，不表示 P1–P7 总方案或任意小说已经通过。

## C1：完整请求预算与自主角色工作集

将无 Pi 依赖的预算核移到 `runtime/model-request-budget.ts`，原 agent 导出兼容。
`withPlayModelBudget` 使用 Node AsyncLocalStorage 在同一宿主操作的 Promise 链中传播共享预算。
Web 用户行动、TUI 用户行动覆盖行动到叙述；直接 `performPlayTurn`／`WorldRuntime.move` 提供无外层调用时的范围。独立 scene／render-only retry 开新只读范围；新的真实用户输入开独立范围，不能与上轮选择菜单的异步调用链混算。

Pi 创建会话前检查继承预算；每次实际模型 step 和经过 Pi 扩展后的 provider payload 同时受局部和宿主预算约束。各 Play 适配器保留独立预算，其内部协议重试／专家会话共享。总预算不替代原局部上限，也不把底层 HTTP 重试次数冒充为 model step。
默认宿主总量为 128 model steps、单次 512,000 UTF-8 bytes、累计 32,000,000 payload bytes；是工程保护参数，不是模型 tokenizer 容量声明。操作结束关闭预算，迟到回调不能复用。超限后原有合法提交保留，不能通过新建子会话绕开限制。

新增 `model.budget` 宿主事件，记录预算 ID、次数、字节数和 provider 实报 token/cache/cost；不记录 payload 或秘密，不把宿主 ID 放入模型输入。原 trace 仍保留各请求独立证据。

自主角色增加同一 actor-safe 快照的 find/read 工具，完整保留 selected goal、character policy、development、活动过程／规范，以及 decision 结构依赖；不引入全局原文或未来 canon。检索缺失不是角色未知，关键依赖超预算不能被相关性排序删除。

依据：固定工具链源码 Pi 0.84.2；Node 22.19 AsyncLocalStorage 官方文档 https://nodejs.org/download/release/v22.19.0/docs/api/async_context.html 。生命周期选择为本项目宿主工程设计，不声明 provider 自动保证。

验证：首轮针对真实 Pi 回调、预算生命周期、并发隔离、适配器、Web 与 TUI 的 10 文件／110 测试通过；服务端类型检查通过。整仓最终结果在后续实施记录中另列，不用这组定向结果替代。

## C2：跨事件区间约束与入口切片

新增端点偏序求解器，统一当前支持的 before/after、during/contains/subevent、overlaps、starts/finishes、coreference 和无自由文本 offset 的相对时间锚。非严格约束中的严格环视为矛盾，能发现经过多个事件传递的包含／重叠冲突。calendar 与 ordinal 数轴独立；不把 cause、解释、披露顺序或未知文本时长转成故事发生顺序。时间候选区间仍是约束而不是捏造精确时长。

编译事件关系 validator 与 deriveEntryCut 共用该图。入口推导可使用包含关系传递证明先后，重放使用稳定拓扑线性扩展，未知顺序仍不能伪装成已经有证据的顺序。图使用迭代 SCC，设置节点／关系安全边界和有限查询缓存。没有实现基于全部世界读写依赖的通用可交换性证明；此项仍保守阻断，不宣称 D5 全部完成。

因实际入口／重放解释发生变化，pipeline 提升至 45、engine 至 0.22.0；旧语义／执行检查点需重验，旧分支由既有版本门明确拒绝不兼容解释，不改写原快照。

验证：服务端类型检查通过；时间关系、入口、历史获知、失能过程和晚角色入口的 6 文件／27 项测试通过。新增两个改名场景及间接矛盾、数轴隔离、contested、自由文本 offset、零长度与 overlap 反例。尚未把定向结果当作全仓最终结果。

## C3：实体引用与角色已获称谓分离

角色上下文不再因位置、物品归属、关系端点或普通 claim 引用而展示 canonicalName。当前角色自身保留所选身份名；其他实体从该角色当前已理解且未拒绝的 `identity-name`／`identity-alias` literal claim 投影称谓。该关系名符合现有 relationId 的 ASCII ID 语法，不另造无法与 Proposition/Acquisition 配对的冒号关系。知晓假名不等于知道真名；多个相冲突主称谓保留 ambiguous 状态，不能最后写入者胜出。未获称谓者仍可用稳定实体身份和匿名展示标签参与合法行动。

生产上下文附带 nameAuthority／knownNames；Runtime source consultation 不再用 Unidentified 字符串前缀推断权限，也不把已知别名升级为全局真名或暴露所有 aliases。玩家自己输入的一个称谓只形成该输入的 turn-reference，输出采用实际命中的称谓而非全局 canonicalName。已知 claim 的摘要使用角色可见称谓；已发生事件使用角色实际 observation 而非全知 readerSummary。锁定台词的 speaker/addressee 展示同样使用角色投影，不因 ID 可引用而泄露真名。编译 prompt 明确要求名称 claim 与独立 Acquisition；compiler 与分支语义 reducer 拒绝该保留词汇的非 literal/空/过长值。

此实现保护结构化称谓和上述补证／台词标签路径，不宣称任意自然语言 observation 已经获得完整语义泄漏证明。原文、实际已提交台词和当前输入不会被全局字符串替换。旧缺名称证据的事实不会迁移成新的识别证据。pipeline 46、engine 0.23.0，沿用既有不兼容版本门。

验证：6 文件／65 项定向测试通过；最后对保留词汇语法与预算 hook 的 2 文件／8 项通过，服务端类型检查通过。两个独立称谓场景通过真实分支提交、获知、冲突、遗忘、重新打开与 fork，验证旁观者隔离和假名不泄真名。新增测试初稿用了不合法汉字 ID 及不存在的 engine fork API，已改用合法稳定 ID 与现有 WorldRuntime.forkBranch；没有修改生产 ID 或 fork 限制。原测试依赖名称来定位 opaque handle 的部分改用宿主编码函数，保留原解码／权限断言；应匿名的旧标签预期已更新。

C1/C2 后首轮全仓为 210 文件通过、1 文件失败，共 1270 项通过、1 项失败；失败仅为新增 model.budget hook 后旧测试的事件总数断言。现分别断言原 play.turn 唯一成功和新增预算事件唯一成功，定向已通过。后续全仓结果仍需按最终 tree 再记录。

C3 冻结 tree 的全仓回归为 1273 项通过、2 项失败；两项旧 fixture 未提供名称获知却仍期望 Ally/Witness 真名。保持原人物 ID、关系与话语字节，改为断言匿名标签及计划不泄全局名，不补造名称证据。后续最终完整检查另记。
