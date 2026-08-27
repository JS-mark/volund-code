> ↩ [返回索引 (README)](./README.md) · ← [上一章: §1 仓库布局](./01-repo-layout.md) · [下一章: §3 Provider & Router](./03-provider-router.md) →

---

## §2 核心数据模型与 Agent Loop

本节定义 `packages/core` 的对外契约与内部主循环。是全项目最关键的一节，其他所有能力都建立在此之上。

### 2.1 消息模型 (provider-kit)

**核心原则**：内部 Message 是 provider **无关**的中性表示，从 day 1 就是多模态友好的 `ContentPart[]`。

```
Message = {
  id: MessageId              // UUIDv7（有序，便于事件重放）
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ContentPart[]
  createdAt: timestamp
  turnId: TurnId
  meta?: {
    provider?: string        // 生成方（telemetry 用）
    model?: string
    usage?: Usage
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_seq' | 'error'
  }
}

ContentPart =
  | { type: 'text', text: string }
  | { type: 'thinking', text: string, signature?: string }           // Claude/o1/R1 推理内容
  | { type: 'image', source: AttachmentRef, mime: string }
  | { type: 'file',  source: AttachmentRef, mime: string, filename: string }
  | { type: 'tool_use', id: string, name: string, input: JsonValue }
  | { type: 'tool_result', toolUseId: string, content: ContentPart[], isError?: boolean }

AttachmentRef =
  | { kind: 'inline', bytes: Uint8Array }        // 仅允许 < 64 KB
  | { kind: 'path',   absPath: string }          // 磁盘引用，懒读
  | { kind: 'handle', handle: NativeHandle }     // native-bridge 提供，见 §2.1.1

Usage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  costUSD?: number
}
```

#### 2.1.1 附件 handle 生命周期

`AttachmentRef.handle` 由 `native-bridge` 分配，生命周期绑定到 SessionState：

- 附件添加到消息时，由 `native-bridge` 增加引用计数。
- 消息被 context 压缩替换（不再进 prompt）时，Runner 显式调 `native.release(handle)`。
- Session 关闭时统一释放。
- 未释放的 handle 在 Runner 退出时打日志并强制释放，防止 native 内存泄漏。

### 2.2 会话状态 (core)

```
SessionState = {                             // Immutable，每次事件产生新版本
  id: SessionId
  cwd: string
  createdAt: timestamp
  version: number                            // 递增，用于乐观并发

  messages: ReadonlyArray<Message>
  turns: ReadonlyArray<Turn>
  activeTurn: TurnId | null

  cumulativeUsage: Usage & { costUSD: number }

  routerState: RouterPolicyState             // Router 内部维护
  contextBudget: {
    maxTokens: number
    currentTokens: number
    lastCompactedAt?: MessageId
  }

  toolRegistrySnapshot: SnapshotId           // 装载后冻结
  permissionCache: ReadonlyMap<string, PermissionDecision>  // "allow-session"

  pendingInterrupt: boolean
}

Turn = {
  id: TurnId
  startMessageId: MessageId
  endMessageId?: MessageId
  status: 'streaming' | 'awaiting_tool' | 'awaiting_user' | 'done' | 'aborted' | 'error'
  parentTurnId?: TurnId                      // subagent 场景
  parentDepth: number                        // W11: 0=顶层，1=subagent 第一层，...；对齐 hook ctx.depth（W13）
  agentType?: string                          // 'main' / 'task-agent' / user-defined
  stickyProvider?: ProviderName              // B4: turn 内锁定的 provider；tool_use 产生后 set
}
```

**关键决策**：

- **结构化共享**：immutable 不能每次全量拷贝（O(n²)），使用 `immer` 或等价库，改动只重建 root path。
- SessionState 只能通过 Runner 的公开 API 修改（`sendUserMessage` / `interrupt` 等），UI 不能直接改。
- `permissionCache` 支持 "allow-session"：本会话内同一权限项不再弹窗。

### 2.3 事件总线 (core)

事件是**类型化的 discriminated union**，只增不改，为 session replay 铺路。每个事件带 `id` / `type` / `version` / `sessionId` / `turnId?` / `payload` / `at`。

**★ W9：`event.id` 采用 UUIDv7**（时间前缀 + 单调，可排序 + 全局唯一）。由 core emit 侧生成，subscriber 侧 **必须** 在 process-local 内存 seen-set 里做去重（LRU 上限 10k）：
- 场景：subscriber 崩溃后 replay 重发部分事件时可能重复；EventBus 内如果未来引入 async fan-out 也可能重发。
- 语义：subscriber 收到 `event.id` 已在 seen-set 中的事件 → 静默丢弃，不重复副作用。
- storage 侧特殊：session JSONL 写入以 `event.id` 为 idempotency key，写入前查 tail 若已存在则跳过（`stream.completed` / `message.appended` 幂等 write）。
- 幂等要求：所有 subscriber 副作用（storage 落盘 / telemetry 计数 / hooks trigger）**必须** 通过 seen-set 保护，无 subscriber 例外。
- ★ **LRU 驱逐风险（NEW-P3-3）**：10k 上限对绝大多数会话够；超长会话（数百 turn × 高频事件）可能把老 id 驱逐出 LRU，之后若同一 id 被 replay 重发会被当新事件 → 幂等降级为 best-effort（极端场景可能重复副作用）。缓解：(a) storage 的 idempotency **额外** 以 JSONL tail 最近 N 行（N=1000）作二级查重，不完全依赖内存 LRU；(b) telemetry 计数容忍 ±误差，不依赖精确去重。若未来 session 规模常态超 10k 事件，把 LRU 上限提到 100k。

| 事件                    | 触发时机                                  | 主要订阅者                                    |
|-------------------------|-------------------------------------------|-----------------------------------------------|
| `session.started`       | Runner 启动                               | ui / storage / telemetry / hooks              |
| `session.ended`         | Runner 关闭                               | all                                           |
| `turn.started`          | 新 turn 开始                              | ui / storage / telemetry / hooks              |
| `turn.completed`        | turn 正常结束                             | ui / storage / telemetry / hooks              |
| `turn.aborted`          | Ctrl+C / error                            | ui / storage / telemetry                      |
| `message.appended`      | 新消息落盘                                | ui / storage / telemetry                      |
| `stream.started`        | provider 开始流式                         | ui                                            |
| `stream.delta`          | 增量 token / thinking / tool_use fragment | ui（throttled）                                 |
| `stream.completed`      | provider 流结束                           | ui / telemetry                                |
| `tool.requested`        | assistant 输出 tool_use                   | ui / hooks(PreToolUse)                        |
| `tool.permission_asked` | 需要权限确认                              | ui（弹窗）                                      |
| `tool.started`          | 权限通过，开始执行                         | ui / telemetry                                |
| `tool.completed`        | 工具完成（含错误）                          | ui / storage / telemetry / hooks(PostToolUse) |
| `shell.background_started` | Bash `runInBackground:true` 创建后台 shell（r13-G2） | ui / telemetry                       |
| `shell.background_exited`  | 后台 shell 结束（正常/被 kill/超限）        | ui / telemetry                                |
| `context.compacted`     | 上下文压缩发生                            | ui / telemetry                                |
| `router.switched`       | Router 切换 provider                      | ui / telemetry                                |
| `error.raised`          | 任何异常                                  | ui / telemetry / hooks                        |
| `session.resumed`       | storage.loadSession 恢复（§8.2 W10，冷启动不发，恢复时替代 session.started） | ui / telemetry / hooks   |
| `reflection.scheduled`  | 反思 trigger 命中并入队（§21.3/§21.5）       | ui / storage / telemetry                |
| `reflection.started`    | reflector run 开始（§21.4）                  | ui / storage / telemetry                |
| `reflection.completed`  | 反思输出校验通过并入库（§21.4/§21.6）        | ui / storage / telemetry                |
| `reflection.failed`     | 反思模型错误/输出非法/超时（§21.4）          | ui / storage / telemetry                |
| `reflection.skipped`    | 预算耗尽/抢占/无新内容/disabled（§21.3）     | ui / storage / telemetry                |
| `reflection.promoted`   | lesson 提升写入长期 Memory 成功（§21.7）     | ui / storage / telemetry                |

**订阅原则**：

- Core **只发不订**（唯一 emitter）。
- 所有 subscriber 幂等（可重放）。
- **★ r13-I8：每个事件的 payload 有 per-event zod schema**（`packages/shared/events/<event>.ts`，CI 强制：事件表新增行而无对应 schema 文件 → fail）。payload 字段表（字段/类型/必选/来源章节）集中登记于[附录 D](./APPENDIX-D-event-payloads.md)；replay、§8.2 迁移、`--json` 外部消费都以附录 D 为稳定契约，实现不得自创 payload 形状（如 delta 塞整 chunk、快照自创字段）。
- **Stream backpressure**：`stream.delta` 频率高，UI 侧 throttle 到 30fps（**结论：ui 是消费者、自 throttle；上游流不做背压，避免复杂化**）。
- 大 payload（附件二进制）**不进事件**，只传引用。
- Node 单线程保证事件天然有序。

### 2.4 Runner 主循环（伪代码）

```
async runner.run(userInput):
  turnId = newTurn()
  turnAbort = new AbortController()              // B3: turn 级 abort，interrupt 时统一广播
  loopCount = 0                                   // B2: tool_use 迭代计数
  stickyProvider = null                           // B4: turn 内 provider 粘性
  emit turn.started

  appendMessage({role: 'user', content: normalize(userInput)})
  emit message.appended

  loop:                                          # 单 turn 内可能多轮 provider 调用
    // B2: turn 内 tool_use 循环上限（默认 25，config: runner.maxToolLoopsPerTurn）
    if loopCount >= state.config.maxToolLoopsPerTurn:
      emit error.raised { code: 'tool_loop_exhausted', turnId, loopCount }
      appendMessage(systemNote("Aborted: exceeded maxToolLoopsPerTurn"))
      break
    loopCount += 1

    hint = hooks.trigger('prePrompt', ctx)       # 可能塞入 @model 提示等

    if contextPolicy.shouldCompact(state):
      await compact()                            # emit context.compacted
    contextMessages = contextPolicy.buildPrompt(state.messages, capabilities)

    // B1: 组合 system prompt（PromptComposer）
    // - compose 输入：state（含 cwd/model/激活的 skills/AGENT.md 集合）+ capabilities
    // - compose 输出：单一 string，按 §6.5 fragment 优先级拼接
    // - 每轮都 compose：允许 skill activate/deactivate 生效；实现上做 memoize（fragment 集合未变则复用）
    systemPrompt = promptComposer.compose(state, capabilities)

    hooks.trigger('preProviderCall', ctx)

    // B4: turn 内 provider sticky：一旦产生 tool_use，后续 loop 强制同 provider
    provider = stickyProvider ?? router.pick(state, hint)
    stream = provider.stream({
      system: systemPrompt,                       // B1: provider 侧 system 字段（provider-kit 契约）
      messages: contextMessages,
      tools: toolRegistry.forProvider(provider),
      signal: turnAbort.signal                    // B3: provider stream 也接 abortSignal
    })
    emit stream.started

    assistantMsg = { role: 'assistant', content: [] }
    for chunk in stream:
      if state.pendingInterrupt:
        turnAbort.abort()                         // B3: 广播到 provider stream + tool.invoke
        stream.abort(); emit turn.aborted; return
      assistantMsg = mergeChunk(assistantMsg, chunk)
      // B4 早锁：第一个 tool_use.start chunk 抵达即 set stickyProvider（不等 message 装配完）
      if chunk.kind === 'tool_use.start' && stickyProvider == null:
        stickyProvider = provider
      // 流式中断处理（见 §3.9a）：作废进行中 message，不落盘
      if chunk.kind === 'message.interrupted':
        emit error.raised { code: 'stream_interrupted', turnId, reason: chunk.reason,
                            hadPartialToolUse: assistantMsg.content.some(isToolUse) }
        # 交 router.onError(stream_truncated) 决策重试/fallback/give-up（受 sticky 约束）
        decision = router.onError(toStreamTruncated(chunk), ctx)
        if decision === 'give-up':
          emit turn.aborted; return
        provider = (decision.provider === stickyProvider || stickyProvider == null) ? decision.provider : stickyProvider
        # r9 优化：重跑时复用已落盘的 tool_result / user message（不重新执行已完成 tool）；
        # 只重发 provider.stream；loopCount 不重置（占额度，防死循环）；不支持 byte-offset 续传（v2）
        continue outer loop
      emit stream.delta                          # UI throttled
    emit stream.completed

    appendMessage(assistantMsg); emit message.appended
    hooks.trigger('postProviderCall', ctx)

    toolUses = assistantMsg.content.filter(isToolUse)
    if toolUses.empty:
      break

    // B4: sticky 已在第一个 tool_use.start chunk 抵达时设置（见上方 loop 内），此处不再设

    toolResults = await parallelInvoke(toolUses, turnAbort.signal)  // § 2.5
    for tr in toolResults:
      appendMessage({role: 'tool', content: [tr]})
      emit message.appended
    # continue loop：模型基于 tool_result 生成下一轮

  hooks.trigger('stop', ctx)                     # 可拦截强制继续
  emit turn.completed


// interrupt 入口（供 UI 层 Ctrl+C 调用）
runner.interrupt():
  state.pendingInterrupt = true
  turnAbort.abort()                              // B3: 立即广播到当前 turn 的所有异步（stream / tool.invoke）
```

**说明**：

- `hint` 是 hook 或用户显式指令（比如 `@gpt-4 帮我...`）产生的 router 提示，可能为 undefined。
- **B1**：system prompt 由 `PromptComposer.compose(state, capabilities)` 生成，作为 provider-kit `ProviderRequest.system` 字段传给 provider（Anthropic 有独立 `system` 参数；OpenAI/Gemini 会被 adapter 转成 `messages[0]={role:'system'}`）。多个 fragment 之间以 `\n\n---\n\n` 分隔，来源以 HTML 注释形式嵌入（§6.5.5）。
- **B2**：`maxToolLoopsPerTurn` 默认 25，可在 `config.toml` 覆盖；触顶后 emit `error.raised{code:'tool_loop_exhausted'}`，写入一条 system role 消息告知模型"已达上限"，然后 break（避免死循环烧钱）。
- **B3**：`turnAbort: AbortController` 在 turn 开始时创建，传播链为 `runner.interrupt() → turnAbort.abort() → provider stream + tool.invoke(abortSignal) → sandbox 子进程 SIGTERM`；tool 实现**必须**响应 abortSignal（否则超时兜底 60s 生效）。
- **B4**：`stickyProvider` 语义 — **第一个 `tool_use.start` chunk 抵达时即锁定**（不等 message 装配完，消除 REVIEW-r6 P0-2 的竞态窗口），后续所有 loop 迭代**必须**用同一 provider（tool_use_id 是 provider-specific 格式，切换会导致 tool_result 无法匹配）；fallback 只能发生在**首轮或纯文本轮**（含 sticky 锁定前的流式中断，见 [§3.9a](./03-provider-router.md#39a-流式中断处理-stream-resilience)）；违反语义 emit `error.raised{code:'provider_sticky_violation'}`。
- **B6（流式中断）**：provider stream 异常终止时适配器 emit `message.interrupted`（非 `message.stop`），Runner 作废进行中 message（不落盘）、不调已 emit 的 tool_use、交 `router.onError(stream_truncated)` 决策（受 sticky 约束）；整个 turn 从头重跑，不支持 resume-from-offset（v1）。详见 [§3.9a](./03-provider-router.md#39a-流式中断处理-stream-resilience)。
- **B7（截断续写，r13-G5）**：`stopReason === 'max_tokens'` 时——
  1. UI 在被截断的 assistant 消息尾部渲染 `[truncated: max_tokens reached]` + 提示"输入 continue 可继续"；
  2. 用户输入 `continue` → 走正常 `sendUserMessage` 路径；Runner 复用 sticky provider（防换 provider 导致风格/编码断裂）；
  3. **不自动续写循环**（防失控烧钱）：只提示，不自动重发。
  - 强制点：ui 单测（截断标记渲染）；core 单测（B7 路径不新建 turn 语义——continue 是新 user message，非隐式续传）。
- `router.pick` 只在 `stickyProvider == null` 时才调用；后续轮直接复用。

### 2.5 并行 Tool 调用

```
async parallelInvoke(toolUses, turnAbortSignal):
  concurrency = provider.capabilities.parallelToolCalls ? Infinity : 1
  return runConcurrent(toolUses, concurrency, async (tu) => {

    // B5: 每个 tool_use 各自独立跑 preToolUse pipeline
    //     N 个 tool_use 之间 pipeline 并行；同一 tool_use 内多个 handler 串行 pipeline（§6.11.1）
    //     hook 作者约定：handler 必须无副作用/幂等；跨 tool 共享状态由作者自行加锁
    tu = await hooks.triggerPipeline('preToolUse', tu, {
      toolUseId: tu.id,
      turnId,
      depth: ctx.depth,                          // 见 W13：subagent 内为 1+
    })
    if hook returned { veto: true, reason }:
      emit tool.completed { blocked: true, by: 'hook' }
      return { toolUseId: tu.id, isError: true, content: `blocked by hook: ${reason}` }

    tool = toolRegistry.get(tu.name)
    permReq = tool.permissionSpec(tu.input)
    decision = await permission.request(permReq) // 通过 promptHandler
    emit tool.permission_asked → tool.started_or_denied

    if decision === 'deny':
      return { toolUseId, isError: true, content: 'permission denied by user' }

    emit tool.started
    // B3: tool 级 abortSignal 来自 turnAbortSignal，interrupt 时统一 abort
    toolAbort = AbortSignal.any([turnAbortSignal, AbortSignal.timeout(tool.timeoutMs ?? 60_000)])
    try:
      result = await tool.invoke(tu.input, {
        abortSignal: toolAbort,
        session, native,
      })
    catch e:
      if e.name === 'AbortError':
        result = { isError: true, content: 'aborted by user or timeout' }
      else:
        result = errorToContent(e)
    emit tool.completed

    result = await hooks.triggerPipeline('postToolUse', tu, result, {
      toolUseId: tu.id, turnId, depth: ctx.depth,
    })
    return result
  })
```

**关键决策**：

- 默认并行执行 tool_use（除非 provider 说不支持并行）。
- **B5 并行语义**（明确）：
  - N 个 tool_use → N 条独立的 `preToolUse` pipeline 并行执行；
  - 同一 tool_use 内多个 handler → **串行 pipeline**（§6.11.1），前者返回作为后者 input；
  - ★ **r9 新增：框架级 `ctx.kv` 命名空间 store**——hook handler 若需跨调用共享状态，**优先用 `ctx.kv`**（框架保证命名空间级互斥）而非自管全局可变状态。`ctx.kv` 按 (event + 来源 plugin/toolUseId) 命名空间隔离：同一 tool_use 的 pipeline 内 handler 可见共享；不同 tool_use 之间 kv 不共享（避免 parallelInvoke 竞态）。API 见 §6.4.1 `volund.hook.kv`。作者若仍坚持自管全局状态，须自行加锁（框架不兜底）。
  - veto 只影响**当前 tool_use**，不打断其它并行 tool。
- Permission 内部**串行弹窗**：多个并行 tool 同时请求权限时，permission 内部维护队列一次显示一个（避免刷屏）。
- 单 tool 失败**不影响其他** tool（各自返回 error content）。
- **B3 abort 传播**：`turnAbortSignal` 与 `AbortSignal.timeout(tool.timeoutMs)` 用 `AbortSignal.any([...])` 合并；任一触发即中止该 tool；tool 实现必须响应 `abortSignal`（sandbox binary 收到 SIGTERM；纯 JS tool 检查 signal）。
- Task tool 就是耗时长的普通 tool，不特殊路径。

### 2.6 Hook 拦截点

| Hook               | 类型 | 触发点                    | 能做什么                 |
|--------------------|------|---------------------------|--------------------------|
| `sessionStart`     | 观察 | Runner 启动后             | 注入初始 system prompt   |
| `sessionEnd`       | 观察 | Runner 关闭               | 清理                     |
| `prePrompt`        | 拦截 | 用户输入后，构造 prompt 前 | 改写用户消息 / 返回 hint |
| `preProviderCall`  | 拦截 | 调 provider 前            | 修改 messages / tools    |
| `postProviderCall` | 观察 | provider 返回后           | 记录 usage               |
| `preToolUse`       | 拦截 | tool_use 执行前           | 改 input / 拒绝          |
| `postToolUse`      | 拦截 | tool 执行后               | 改 result                |
| `preCompact`       | 观察 | 压缩前                    | 备份                     |
| `postCompact`      | 观察 | 压缩后                    | 记录压缩量               |
| `stop`             | 拦截 | turn 结束时               | 可强制继续               |

**执行语义**：

- 同一 hook 点多个 handler **串行执行**，前者输出作为后者输入。
- 拦截型 hook 必须同步或短异步返回，超时 **5 秒**——超时后果**按 hook 域分治**（r13-I10，安全设计修正）：
  - **builtin 域（priority 900–1000，安全 hook）**：超时 → **fail-closed**——视为 veto，阻断当前操作，emit `error.raised { code: 'builtin_hook_timeout', hook, event }` + UI 红条"安全检查超时，操作已阻断（可重试）"。理由：memory 脱敏（priority=1000）/ 注入扫描等安全 hook 若"超时跳过"，恶意 payload 只需让扫描器卡 5 秒即可绕过全部防护——拦截型 hook 的 fail-open 是可主动利用的旁路。
  - **project / plugin / user 域**：超时 → fail-open（跳过该 handler，继续 pipeline），记录 telemetry。可用性优先。
  - **防“喂爆扫描器”且禁止截断漏扫**：每个 builtin handler 调用前，runtime 对当前完整 payload 做 strict canonical JSON-v1 UTF-8 计量与 SHA-256；plain JSON 使用排序 key，inline `Uint8Array` 使用保留的 base64 typed tag 并规范化为 tight copy（不得复制/暴露 view 之外的 backing bytes），accessor、cycle、non-JSON prototype/值、共享可变 bytes，或 depth（512）/node（200,000）/canonical work（16 MiB）预算超限均作为 `builtin_hook_error` fail-closed，且资源失败不得制造 digest。serialized bytes **≤ 1 MiB** 时 handler 收到完整 payload；**> 1 MiB** 时 handler 不调用、扫描不开始，立即 veto，并 emit `error.raised { code:'builtin_hook_payload_too_large', context:{ domain:'builtin',hook,event,limitBytes,rawBytes,rawDigest,scanStatus:'not_started',scannedBytes:0,scannedDigest:null,decision:'veto' } }` 与本地 telemetry `hook.payload_rejected`。禁止截断后扫描，禁止把未扫描伪装成 raw/scanned 相等。builtin 的每次 non-veto completion（包括原地 mutation、显式 rewrite 或返回 void）在交给下一个 handler/返回 pipeline 前都用同一闸复检，并以 fresh measured clone 继续以切断 retained-reference mutation；project/plugin/user 的既有超限、timeout、error、rewrite 语义不变。
  - 域顺序固定为 builtin → project → plugin → user；因此后置非 builtin rewrite 不获得“已被 builtin 扫描”的 attestation，也不会在本 P0 中回流复扫。需要最终态安全证明的受限 profile 必须禁用这些后置 rewrite，或另设 base-owned terminal validator，不能把本尺寸闸误称为全 pipeline 最终验证。
  - `preToolUse` 的上述 veto 发生在 permission/native invoke 前；`postToolUse` 的 veto 只能封锁/替换将要返回的结果，tool 副作用已经发生，日志和 UI 不得声称已回滚。
- Hook 抛异常默认**不阻断主流程**（记录到 telemetry），可配置 fail-hard（builtin 域安全 hook 的异常语义同超时：fail-closed）。
- ★ **hook 必须轻量（2026-08-23 钉死）**：hook handler 内**禁止**发起模型调用、重计算或任何可能超过 5s 超时的工作；此类长任务必须经 `volund.jobs.schedule` 的空闲调度执行（§6.4.1a / §21.5）。hook 只发信号（如"调度一次反思"），不在 pipeline 内干活。
- 强制点：core 单测 ×2——builtin 域 hook 卡 6s → 当前 tool 被阻断；plugin 域 hook 卡 6s → 放行 + warning。
- ★ **r9 新增 `ctx.kv` 命名空间隔离**：每个 hook handler 的 `ctx.kv` 按 (event 类型 + 来源 plugin/project/user + toolUseId) 命名空间隔离。同一 hook 点的串行 pipeline 内，前者 handler 写入的 kv 后者可读（pipeline 共享）；`parallelInvoke` 的不同 tool_use 之间 kv 不共享（避免竞态）。详见 §6.4.1 `volund.hook.kv`。

### 2.7 Subagent 生命周期

由 `Task` tool 触发，通过 `subagent.dispatch(parentCtx, prompt, opts)`。

```
subagent.dispatch:
  1. TaskTool 收到 { prompt, agentType, budget }
  2. subagent 用注入的 RunnerFactory 造新 Runner：
     - 独立 SessionState（不共享 messages 和 permissionCache）
     - 复用父的：toolRegistry / router / hookRegistry / native
     - agentType 决定 system prompt
  3. 事件转发：subagent EventBus 事件加 { parentTurnId, parentDepth } tag 冒泡到父 EventBus
     // r13-D1：冒泡事件**保留原 event.id**（不重发新 id）——seen-set 去重与 JSONL 重放
     // 幂等都以 event.id 为键，换 id 重发会让同一逻辑事件被记两次
  4. 完成后 Task tool 从最后一条 assistant message 提取 text 作为 tool_result
```

**关键决策**：

- 嵌套硬上限**默认 3 层**（可配置），防止 agent 递归失控。
- **★ r13-D1：同 turn Task 并发上限默认 4**（config `[subagent] max_concurrent = 4`）。同一 turn 内模型并行发出多个 Task tool_use 时，超出上限的排队执行（不是拒绝）；达到嵌套上限的深层的 Task 直接 isError 返回。
- Subagent **不能** import 父 messages / permissionCache（隔离）。
- Subagent 事件走同一 EventBus 加 tag（**保留原 event.id**，见上），UI 折叠渲染 ("🤖 Subagent 正在执行...")。
- Budget（token / cost / time）用完强制 abort。
- **★ r13-D1：budget 生效范围与维度（钉死）**：budget **默认仅对 subagent Runner 生效**；顶层 Runner 可选启用（config `[runner] top_level_budget = false` 缺省关）。维度定为**三维**（cost / token / time）——迭代次数不进 budget，由 §2.4 B2 `maxToolLoopsPerTurn`（顶层与 subagent 各自生效）承担，不在 budget 里重复设第四维。
- **★ Budget 执行点（REVIEW-r7 NEW-P1-D）**：subagent Runner 在**每个 loop 迭代前**（provider stream 发起前）检查 budget，三阈值任一命中即终止：
  - `cumulativeUsage.costUSD ≥ budget.costUSDMax`（dispatch 时 `Task` 工具注入）
  - `cumulativeUsage.input + output token ≥ budget.tokenMax`
  - `now - turnStartedAt ≥ budget.timeMsMax`
  - 命中 → emit `error.raised { code: 'subagent_budget_exhausted', dimension: 'cost'|'token'|'time', consumed: {...}, budget: {...} }` + 调子 turn 的 `turnAbort.abort()`；子 Runner 从**最后一条已完成的 assistant message** 提取 text 作为 tool_result 返父（标注 `[budget exhausted, partial result]`），而非空结果。
  - budget 阈值来源：`Task` 工具 input 的 `budget?` 字段（缺省走 `[subagent] default_budget` config：cost $1 / token 200k / time 10min）。
  - 与 §2.4 `maxToolLoopsPerTurn` 正交：budget 是"钱/时间"上限，loop 是"迭代次数"上限，两者都触发各自终止。
- **★ W8：Subagent 内 permission 决策收窄**。父上下文里的 `allow-project` / `allow-forever` 白名单**不下传**到 subagent 的 `permissionCache`；subagent 请求权限时用户可选项**只有** `allow-once` / `allow-session`（session 指该 subagent 生命期，不含父）/ `deny`。**降级档位枚举（r13-D1 钉死）**：`depth > 0` 的 Runner 的可授权档位 = `['allow-once', 'allow-session', 'deny']`——UI/permission 层据此隐藏 `allow-project` / `allow-forever` 选项。同时若父 turn 的当前 tool_use 已经 hit 到白名单直接放行，subagent 内**重新弹窗**（不复用父决策）。原因：subagent 的 prompt 来自模型生成，攻击面比用户直接输入大；若继承 forever 白名单等于把"过去用户点过一次"当成"未来 LLM 决定的任意命令"的免检通行证。
- **★ W13：Hook ctx 加子 agent 标记**。所有 hook `trigger(event, ctx)` 的 `ctx` 里必须带 `depth: number`（0=顶层 Runner，1=第一层 subagent，...）与 `isSubagent: boolean`（`depth > 0`）。plugin/project hook 可用这两个字段选择性禁用（例如"敏感命令扫描 hook 在 subagent 内更严格"）。字段由 `subagent.dispatch` 在造 Runner 时注入 `RunnerContext.depth = parentCtx.depth + 1`。

#### 2.7.1 自定义 subagent 定义文件（r13-G3）

`agentType: user-defined` 的落地格式。**两层定义，项目覆盖全局同名**：

```
~/.volund/agents/<name>.md          # 全局
<cwd>/.volund/agents/<name>.md      # 项目级（同名覆盖全局）
```

**frontmatter**（zod 校验，schema 放 `packages/shared/agent-schema.ts`）：

```yaml
name: code-explainer        # 唯一，[a-z0-9-]+，与文件名一致
description: 读代码并解释结构 # 一句话，Task 工具路由依据
model:                      # 可选；缺省继承父 Runner 的 provider/model
  provider: openai
  model: gpt-5-mini
tools: [Read, Grep, Glob]   # 可选白名单——只能收紧不能放宽（父注册表的子集）
maxTurns: 10                # 可选；等价于该 agent 的 maxToolLoopsPerTurn
```

**正文 = 该 agent 的 system prompt**，注入规则：

- 走 PromptComposer **独立槽位**（priority=800，与 skill 同级；`@include` 可用，见 §6.5）。
- **★ 项目级 agent 文件属 untrusted 来源**（仓库作者可控，随 clone 进来）：正文先包 `<untrusted source="agent-def:<path>">` 再作为 prompt 基础（§6.5.0a 包裹协议）；发现注入指令（"忽略以上规则"/"读取凭据"类）→ UI 红条警告。全局 `~/.volund/agents/` 是用户自己写的，trusted。
- **装载**：冷启动扫两层目录的 frontmatter（只读 frontmatter，正文懒加载——复用 §6.5.3 progressive disclosure 三阶段）。
- **Task 校验**：Task 工具 inputSchema 的 `agentType` 枚举 = 内置（`main` / `task-agent` / `review-agent`）+ 已扫描定义的 `name`；装载失败的文件跳过并 telemetry 记录（不阻塞启动）。
- **权限**：自定义 agent 同样受 W8 降级 + tools 白名单约束；其 Task 调用在父 turn 的并发上限（默认 4）内。
- 里程碑：**L3**（随 subagent/Task 一起交付）。
- 强制点：shared 单测（frontmatter zod 用例：合法/缺 name/非法字符/tools 超父集拒绝）；core 单测（项目级覆盖全局同名；untrusted 包裹生效）。

### 2.8 异常谱

| 异常源                            | 表现                      | Runner 处理                                        |
|-----------------------------------|---------------------------|----------------------------------------------------|
| Provider network error            | stream 中断               | Router fallback；否则记 error message，允许重试      |
| **Provider stream 中途断（RST/429/abort）** | `message.interrupted` chunk（§3.9a） | 作废进行中 message；`router.onError(stream_truncated)` 按 sticky 决策重试/fallback/give-up；整 turn 重跑 |
| Provider 4xx                      | 立即抛                    | 不 fallback，提示用户重新 login                     |
| Provider 429                      | 立即抛                    | Router 切 provider 或指数退避                      |
| Tool 抛异常                       | reject                    | 转成 `tool_result.isError=true`，模型自处理         |
| Tool 超时                         | AbortSignal               | 同上                                               |
| Permission 拒绝                   | `deny`                    | 转成 `tool_result` "user denied"                   |
| Ctrl+C                            | pendingInterrupt=true     | stream abort，turn.aborted，session 存活             |
| Context 超限                      | contextPolicy 强制压缩    | preCompact → 压缩 → postCompact；失败报错           |
| Hook 异常                         | 记录跳过（默认）            | 可配置 fail-hard                                   |
| **Rust addon 崩溃**               | native-bridge catch       | 降级到 JS fallback + `error.raised`                |
| **Sandbox binary 缺失**           | native-bridge 探测阶段    | 副作用工具拒绝执行，除非 `--dangerous-no-sandbox`   |
| **磁盘满（storage 写 JSONL 失败）** | storage 订阅端异常        | 降级到 in-memory 模式，UI 提示，session 存活         |
| **OS keychain 锁定 / 无访问权限** | auth.getCredential reject | 降级到加密文件或 env，最终失败则中断 provider 调用  |
| 未知异常                          | catch-all                 | emit error.raised，turn.status='error'，session 存活 |

**统一语义**：Runner 尽最大努力**不让整个 session 崩**，除非 SessionState 本身损坏或磁盘完全失能。
