# 第 02 课：`Agent`——一个有状态的 Loop Controller

## 先回答：`Agent` 到底是什么

`Agent` 不是“无状态的模型调用器”，也不等于 `runAgentLoop()` 本身。

更准确地说：

> `Agent` 是一个 **stateful controller**：保存执行状态、准备 Context/Config、管理一次 Run 的生命周期，再把真正的多 Turn / Tool Loop 交给 `runAgentLoop()`。

它的核心状态包括：

```text
Agent
├── state
│   ├── messages
│   ├── model
│   ├── thinkingLevel
│   ├── systemPrompt
│   ├── tools
│   ├── streamingMessage
│   └── pendingToolCalls
├── steeringQueue
├── followUpQueue
├── listeners
└── activeRun
```

所以 `Agent` 有状态，只是它不负责完整的 Session 持久化、Skill/Extension 发现、Compaction 等 Coding-Agent 产品能力。

## 1. 先看类骨架

源码：`packages/agent/src/agent.ts`

把四百多行压缩后，主要就是：

```ts
export class Agent {
  // ① 权威执行状态
  private _state;

  // ② Event 订阅
  private listeners;

  // ③ continuation 队列
  private steeringQueue;
  private followUpQueue;

  // ④ 上层注入的能力
  public convertToLlm;
  public transformContext;
  public streamFn;
  public beforeToolCall;
  public afterToolCall;
  public prepareNextTurn;
  public prepareNextTurnWithContext;

  // ⑤ 当前 Run
  private activeRun;
}
```

构造函数最关键的一句：

```ts
this._state = createMutableAgentState(options.initialState);
```

所以 `Agent.state` 不是旁边挂着的调试信息，而是下一次 Loop 的权威输入。

## 2. `Agent` 依赖的不是 Manager，而是值和函数

构造函数里真正接收的是：

```ts
this.convertToLlm = options.convertToLlm;
this.transformContext = options.transformContext;
this.streamFn = options.streamFn;
this.beforeToolCall = options.beforeToolCall;
this.afterToolCall = options.afterToolCall;
this.prepareNextTurn = options.prepareNextTurn;
this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
```

以及：

```ts
this.sessionId = options.sessionId;
this.transport = options.transport ?? "auto";
this.toolExecution = options.toolExecution ?? "parallel";
```

因此 Agent Core 根本不需要认识：

```text
ResourceLoader
SettingsManager
SessionManager
ModelRuntime
```

上层把这些高层对象收窄成 `state + callback + scalar option` 后再注入 Agent。

## 3. `prompt()` 到真正 Loop 的调用链

入口：

```ts
await agent.prompt("hello");
```

调用链非常清楚：

```text
prompt()
  ↓
normalizePromptInput()
  ↓
runPromptMessages()
  ↓
runWithLifecycle()
  ↓
runAgentLoop()
```

源码骨架：

```ts
async prompt(input) {
  if (this.activeRun) {
    throw new Error("Agent is already processing...");
  }

  const messages = this.normalizePromptInput(input);
  await this.runPromptMessages(messages);
}

private async runPromptMessages(messages) {
  await this.runWithLifecycle(async (signal) => {
    await runAgentLoop(
      messages,
      this.createContextSnapshot(),
      this.createLoopConfig(),
      event => this.processEvents(event),
      signal,
      this.streamFn,
    );
  });
}
```

这里非常重要：

> 真正执行 Turn / Tool Loop 的函数是 `runAgentLoop()`；`Agent` 负责给它准备状态、配置、事件处理和生命周期。

## 4. Context Snapshot：这一轮模型真正看到什么

```ts
private createContextSnapshot() {
  return {
    systemPrompt: this._state.systemPrompt,
    messages: this._state.messages.slice(),
    tools: this._state.tools.slice(),
  };
}
```

因此下一次 Loop 的基础 Context 就是：

```text
systemPrompt
+
messages
+
tools
```

注意这里会复制顶层数组，避免 Loop 与外部代码同时持有同一个可变数组引用。

## 5. Loop Config：这一轮怎样运行

`createLoopConfig()` 把运行策略打包进去：

```text
model
thinkingLevel
sessionId
transport
toolExecution
beforeToolCall / afterToolCall
prepareNextTurn
convertToLlm
transformContext
getSteeringMessages
getFollowUpMessages
```

因此可以把调用画成：

```text
Agent.state
   │
   ├── createContextSnapshot()
   │       └── prompt/messages/tools
   │
   ├── createLoopConfig()
   │       └── model/hooks/queue/policy
   │
   └── streamFn
           ↓
      runAgentLoop(...)
```

## 6. `activeRun` 为什么不是布尔值

一次 Run 需要的不只是 `isRunning = true`。

概念上：

```ts
type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};
```

三个字段分别解决：

- `promise`：外部可以 `waitForIdle()`；
- `resolve`：Runtime 自己决定真正 settlement 的时刻；
- `abortController`：本次 Run 有独立取消信号。

所以：

```text
Idle
 ↓ prompt
Running
 ↓ agent_end emitted
Settling
 ↓ awaited listeners finished + finishRun
Idle
```

`agent_end` 是最后一个 Loop Event，但不代表这一瞬间所有监听器都已经完成。

## 7. 为什么 `prompt()` 不允许并发

```ts
if (this.activeRun) {
  throw new Error(
    "Agent is already processing a prompt. Use steer() or followUp()..."
  );
}
```

原因不是“作者比较保守”，而是 transcript ownership：

> 同一个 Agent 的 `messages` 在同一时刻只允许一个 Run 作为 writer。

如果用户在 Agent 忙的时候又发消息，应该明确表达语义：

```text
steer    = 当前任务中途改方向
followUp = 当前任务结束后继续做
```

而不是启动第二个并发 `prompt()`。

## 8. Event 怎样归约回 State

Loop 发出 Event 后，Agent 先修改自己的状态：

```ts
case "message_end":
  this._state.streamingMessage = undefined;
  this._state.messages.push(event.message);
  break;

case "tool_execution_start":
  pendingToolCalls.add(event.toolCallId);
  break;

case "tool_execution_end":
  pendingToolCalls.delete(event.toolCallId);
  break;
```

然后再按订阅顺序 `await` listeners。

```text
runAgentLoop
   ↓ event
processEvents
   ↓
reduce Agent.state
   ↓
await listener 1
   ↓
await listener 2
   ↓
继续 Loop / settlement
```

这意味着 Event 不只是日志；它也是 Agent 内部状态机的输入。

## 9. 失败也要合成完整事件序列

如果 executor 抛错或被 abort，Agent 会合成一个失败的 AssistantMessage，并补齐：

```text
message_start
→ message_end
→ turn_end
→ agent_end
```

这样 Session、UI、持久化和遥测不用为异常再维护第二套协议。

## 10. `Agent`、`AgentSession`、`runAgentLoop()` 三者关系

最后一定要分清：

```text
runAgentLoop()
= 真正执行 model → tool → model 的 Loop 函数

Agent
= 持有 state、queue、activeRun，控制和观察 Loop

AgentSession
= 在 Agent 外面加入持久化、Extension、Compaction、Retry、Tool registry 等 Coding-Agent 能力
```

一句话：

> **Loop 做计算，Agent 管一次执行，AgentSession 管一个真正可用的 Coding Agent 会话。**

## 练习题

1. 为什么说 `Agent` 是 stateful，而不是 stateless wrapper？
2. `Agent` 为什么不直接依赖 `SettingsManager`、`SessionManager`？
3. `prompt()` 到 `runAgentLoop()` 中间经过哪三个步骤？
4. `createContextSnapshot()` 和 `createLoopConfig()` 为什么要拆开？
5. `agent_end` 已经发出了，为什么此时仍可能还不是 idle？
6. 同一个 Agent 为什么不能同时执行两个 `prompt()`？

## 完成标准

能不看源码画出：

```text
prompt
→ normalize
→ runWithLifecycle
→ createContextSnapshot + createLoopConfig
→ runAgentLoop
→ processEvents
→ state + listeners
→ finishRun
```

并能准确解释：`Agent` 是 **有状态的 Loop Controller**，不是完整 Session，也不是 Loop 函数本身。

下一课：[模型 Turn 与 Tool Loop](../03-model-turn-and-tool-loop/README.md)
