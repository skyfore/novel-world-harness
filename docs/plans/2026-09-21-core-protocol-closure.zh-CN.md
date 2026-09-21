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
