# Runtime hooks

NWH 的宿主进程可以订阅统一的完成事件。Pi 继续负责模型调用、工具执行、重试、流式输出和会话；NWH 在 Pi extension 及真实业务边界上发出只读通知，不让 hook 返回值参与模型上下文或世界提交。

```ts
import { runtimeHooks } from "novel-world-harness";

const unsubscribe = runtimeHooks.subscribe(async (event) => {
  if (event.type === "compilation" && event.status === "succeeded") {
    console.log("编译版本已通过校验并发布", event.metadata.sourceId, event.metadata.bundleHash);
  }
  if (event.type === "play.response") {
    console.log("场景回应结束", event.status, event.metadata.branchId);
  }
  if (event.status === "failed") {
    console.error(event.type, event.name, event.error);
  }
});
// 在宿主停止监听时调用 unsubscribe()。
```

这个注册接口用于同一 Node 进程中的可信宿主代码。目前不从小说、项目文件或 YAML 自动加载回调脚本，也不自动执行 shell 命令。

| type | 边界与状态含义 |
| --- | --- |
| `command` | Commander 实际执行的 CLI action，以及 NWH 通过 Pi 注册的斜杠命令 handler 返回或抛错。解析错误、未执行的命令、Pi 自带命令不在此范围。异步后台任务的启动命令结束不表示任务已完成。 |
| `llm.response` | Pi `message_end` 中的一条 assistant 消息；`stopReason=error/aborted` 对应失败/取消。一次 prompt 可以包含多条响应，自动重试前的失败也会通知。 |
| `tool` | Pi `tool_execution_end`，用 `isError` 判断成功/失败；包含 `toolCallId`。覆盖抛错和工具返回的错误结果。 |
| `session.turn` | Pi `agent_settled`，等待自动重试、压缩和排队续跑结束，每个活动周期只通知一次，状态取最后一条 assistant 响应。TUI 与非交互模式共用该 extension。 |
| `llm.prompt` | NWH `promptWithReport()` 的完整调用，包括超时、模型错误检查和 trace 收尾。它与 Pi settled 的边界不同，可能在 Pi 已停止后因宿主收尾失败而报告失败。 |
| `compiler.batches` | 一次 `compileSourceCommand()` 完成或失败，锁与 trace 的内部递归不会重复通知。不等同于整本小说准备完成。 |
| `compilation` | `PreparedNovelCache.publish()` 完成校验并发布可用版本，或这次发布失败。成功包含 `sourceId`、`bundleHash`。未认证候选和回滚归档不发出这个事件，缓存恢复也不视为重新编译。 |
| `play.turn` | 共享的 `performPlayTurn()` 完成，包含确定性裁决及世界回应处理。正常返回的拒绝仍是执行成功，用 `metadata.accepted` 判断是否获准；`metadata.degraded` 标识附带步骤的部分失败。 |
| `play.response` | TUI/Web 场景叙述经过校验并交付，或叙述失败/取消。包含 `purpose` 区分 opening、turn、recovery 等。失败后展示恢复界面不改写失败事件。 |
| `user.input` | TUI/Web 一次 play 输入处理结束，包括后续叙述流程。正常返回表示输入处理结束；是否提交、叙述是否成功分别查看 `play.turn` 和 `play.response`。普通 Pi 对话使用 `session.turn`。 |

`status` 为 `succeeded`、`failed` 或 `cancelled`；抛出的 `AbortError` 视为取消，其他异常视为失败。命令自己捕获并正常返回的业务拒绝不会被重新解释成异常。

所有事件包含唯一 `id`、`timestamp`、`name` 和冻结的标量 `metadata`；被观测的异步操作还包含 `durationMs`。通过 `run()` 嵌套执行时，`parentId` 关联父操作。Pi 事件另带 `sessionId`；不要把不同业务会话或不同 Pi 实例的 ID 混为一谈。事件不传递小说正文、prompt、模型全文或可修改的业务结果；错误摘要保留真实异常的名称与消息。

## 独立宿主或并发请求

全局 `runtimeHooks` 适合进程级观察。需要隔离订阅时，为整个操作生命周期建立作用域，包括 Pi session 的创建、prompt/TUI 运行及 dispose。嵌套调用自动继承同一总线；不要只包住某个回调的注册。

```ts
import { RuntimeHooks, withRuntimeHooks, currentRuntimeHooks } from "novel-world-harness";

const hooks = new RuntimeHooks({
  timeoutMs: 2_000,
  onError: ({ event, error }) => console.error("hook 失败", event.id, error),
});
hooks.subscribe(async (event) => { /* 写入宿主日志或更新界面 */ });

await withRuntimeHooks(hooks, async () => {
  await currentRuntimeHooks().run("command", "host-operation", { workspaceRoot: root }, async () => {
    // 在这里创建并运行 Pi session，或调用 NWH 业务 API。
  });
});
```

监听器可异步执行；同一事件的监听器并发运行，事件生产者等待它们结束。默认每个监听器最多等待 5 秒；报错或超时走 `onError`，未配置时发出 Node warning，后续监听器和原业务结果不受影响。错误报告器同样有超时保护。超时只能停止等待，不能强制终止已经运行的 JavaScript，因此 hook 应自行控制外部 I/O 超时。

这是进程内观察接口，不是持久化消息队列：不承诺跨进程重启的投递、重放或 exactly-once。重复业务调用会产生独立事件，消费者需要时可用版本哈希等业务键去重。hook 没有世界写入接口；已有的工具恢复协议、验证、提交与 trace 职责保持在原边界内。
