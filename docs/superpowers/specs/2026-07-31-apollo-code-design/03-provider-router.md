> ↩ [返回索引 (README)](./README.md) · ← [上一章: §2 Agent Loop](./02-agent-loop.md) · [下一章: §4 工具与权限](./04-tools-permissions.md) →

---

## §3 Provider 抽象层 & Router 策略

本节定义 `packages/provider-kit`（契约）、`packages/provider-*`（实现）、`packages/router`（路由策略）之间的边界。

### 3.1 设计目标

| 目标                   | 具体含义                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| **中性优先**           | 内部 `Message` / `ContentPart` provider 无关；跨 provider 切换无需改业务代码。  |
| **能力可探测**         | `ProviderCapabilities` 让 Runner / Router 知道 provider 能做什么、不能做什么。  |
| **原生特性可用**       | 允许 provider 特殊字段通过 **RawMeta 逃生舱** 传递，不污染中性模型。            |
| **流式一等**           | Stream 是主 API，非流式退化为收集流。                                           |
| **可路由**             | Router 层夹在 Runner 与 provider 之间，负责选择 / 降级 / 切换。                 |
| **可组合能力检测**     | Runner 询问 capabilities 决定行为（并行 tool / 是否发 thinking / 视觉压缩等）。 |
| **Auth / http 强路由** | 所有 provider 走 `auth` + `http-kit`，不允许自建 fetch。                        |

### 3.2 ProviderClient 契约（provider-kit）

```ts
export interface ProviderClient {
  readonly name: string // 'anthropic' / 'openai' / 'gemini' / 'ollama'
  readonly capabilities: ProviderCapabilities

  /** 主 API：流式请求 */
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>

  /** 可选：非流式便捷方法（默认由 base class 用 stream 收集实现） */
  complete?(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>

  /** 可选：token 计数（用于 context 预算），未实现时降级到 tiktoken 近似 */
  countTokens?(messages: Message[], tools?: ToolSchema[]): Promise<number>

  /** 可选：列出该 provider 支持的模型（动态目录，UI 展示用） */
  listModels?(): Promise<ModelDescriptor[]>

  /** 关闭连接、释放资源 */
  dispose(): Promise<void>
}
```

```ts
export interface ProviderRequest {
  model: string // 具体模型 id
  messages: ReadonlyArray<Message> // 中性 Message[]
  system?: string // 由 PromptComposer 提供，见 §6.5
  tools?: ToolSchema[] // 由 tool-kit 序列化
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  responseFormat?: 'text' | 'json' // 简单 JSON 模式；结构化输出用 tool
  reasoning?: {
    // 显式思考开关
    enabled: boolean
    budgetTokens?: number // Anthropic thinking / OpenAI reasoning_effort 换算
  }
  cache?: {
    // 由 provider 适配转成 provider-specific 缓存指令
    strategy: 'ephemeral' | 'persistent' | 'off'
    ttlSeconds?: number
  }
  rawMeta?: RawMeta // 逃生舱，见 §3.4
}
```

```ts
export type ProviderChunk =
  | { kind: 'message.start'; messageId: string }
  | { kind: 'text.delta'; text: string }
  | { kind: 'thinking.delta'; text: string; signature?: string }
  | { kind: 'tool_use.start'; id: string; name: string }
  | { kind: 'tool_use.delta'; id: string; argsFragment: string } // JSON 片段流
  | { kind: 'tool_use.end'; id: string }
  | { kind: 'usage'; usage: Usage } // 中间或结束时到达
  | { kind: 'message.stop'; stopReason: StopReason }
  | {
      kind: 'message.interrupted'
      reason: string
      partial?: { text?: string; toolUseIds?: string[] }
    } // ★ 异常终止，见 §3.9a；与 message.stop 互斥
  | { kind: 'error'; error: ProviderError }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'
```

**关键约定**：

- **`stream` 是主 API**。所有 provider 实现都必须提供 stream；`complete` 只是包装糖。
- **★ tool_use 流式聚合规则（r13-I1，v1 钉死）**——多 tool_use 交错流式时 Runner 按以下规则聚合：
  1. Runner 维护 `Map<toolUseId, string[]>`；`tool_use.delta.argsFragment` 按 `id` 追加；`tool_use.end` 时合并全文一次性 `JSON.parse`。
  2. parse 失败 → 构造 tool_result：`isError: true`，content = `` Invalid JSON arguments for tool <name> (stream truncated?): <first 200 chars>... ``（截断附原文，供模型自纠）。**失败的 tool_use 不执行，直接以该 error tool_result 返模型**——不存在"parse 失败仍尝试执行"的路径。
  3. v1 **不做**流式部分校验（不在 delta 阶段验证 JSON 合法性）。
  4. `message.interrupted` 到达时，所有未 `end` 的聚合 entry **作废**（连同所在 message，见 §3.9a）。
  - 强制点：core 单测——双 tool_use 交错 delta + 破损 JSON 用例；断言破损 tool 不执行且 error tool_result 形状正确。
- **`usage` 可多次到达**（有的 provider 中间报 cache_read，结束报 output）。累计规则：以 `message.stop` 前的最后一次为准，中间的用于 UI 实时显示。
- **`AbortSignal` 必须传递**：Runner 通过它实现 Ctrl+C 立即中断。
- **`error` chunk 不重复 throw**：底层实现要么发 `error` chunk 要么 throw，二选一。

### 3.3 ProviderCapabilities

```ts
export interface ProviderCapabilities {
  //-------- 上下文与费用 --------
  maxContextTokens: number // 输入上限（不含 output）
  maxOutputTokens: number
  pricing?: {
    inputPerM: number
    outputPerM: number
    cacheReadPerM?: number
    cacheWritePerM?: number
  }

  //-------- 工具能力 --------
  toolUse: 'none' | 'sequential' | 'parallel' // Runner 用来决定并行度
  toolResultSchema: 'anthropic' | 'openai' | 'gemini' | 'json-string'

  //-------- 内容形态 --------
  vision: false | { formats: string[]; maxSizeMB: number }
  files: false | { formats: string[]; maxSizeMB: number }
  audio?: false | { formats: string[] }
  thinking: false | { budgetTokens: boolean } // 支持思考 + 是否支持 budget 控制

  //-------- 流式 --------
  streaming: boolean // 理论上都得是 true
  streamingReasoning: boolean // 是否支持思考流

  //-------- 缓存 --------
  cache: 'none' | 'ephemeral' | 'persistent'

  //-------- 结构化输出 --------
  jsonMode: boolean
  structuredOutput: boolean // schema-constrained

  //-------- 特殊 --------
  systemPromptLocation: 'system-field' | 'first-user-message' // Gemini 是后者
  toolChoiceRequired: boolean // OpenAI 才有 'required'
  interleavedThinking: boolean // 允许思考与工具交错
}
```

**用途**：

- Runner 检查 `toolUse` 决定并行度（§2.5）
- context 层根据 `maxContextTokens` 计算是否要压缩
- ui 根据 `vision` 决定用户能否粘图
- Router 根据 `pricing` 做 cost-aware 选择（v2）
- provider 适配器根据 `systemPromptLocation` 决定往哪塞 system prompt

### 3.4 RawMeta 逃生舱（重要）

**问题**：provider 独有字段（Anthropic `cache_control` breakpoint、OpenAI `logprobs`、Gemini `safetySettings`）如果强塞进中性 `Message`，会污染类型；如果不支持，用户只能改包。

**方案**：在 `ProviderRequest` 上加一个 `rawMeta` 字段，**按 provider 命名 key**，各家适配器只读自己的 key：

```ts
export interface RawMeta {
  anthropic?: {
    cacheControl?: { type: 'ephemeral' }[] // 每条 message 一个位点
    metadata?: { user_id?: string }
    computerUse?: { displayWidth: number; displayHeight: number }
  }
  openai?: {
    logprobs?: boolean
    seed?: number
    reasoningEffort?: 'low' | 'medium' | 'high'
    modalities?: ('text' | 'audio')[]
  }
  gemini?: {
    safetySettings?: Array<{ category: string; threshold: string }>
    candidateCount?: number
  }
  ollama?: {
    keepAlive?: string
    numCtx?: number
  }
}
```

**规则**：

- 中性 `Message` **绝对不含** provider 特殊字段
- 只有需要 provider 特殊行为的调用者（少数）会填 `rawMeta`
- Provider 适配器**只读自己命名空间的 key**，未知 key 忽略（跨 provider 切换时静默降级）
- `rawMeta` 由**调用点显式传**（比如某个 skill/plugin 想让 anthropic 打 cache breakpoint），Runner 不主动填

**"cache" 字段 vs "rawMeta.anthropic.cacheControl"**：`request.cache` 是**通用抽象**（策略 + TTL），provider 适配器翻译成各家实现；`rawMeta.anthropic.cacheControl` 是**逐消息精细控制**，只在需要人工插缓存 breakpoint 时用。二者可共存，rawMeta 优先级更高。

### 3.5 Provider 适配差异表

四家主要 provider 的适配点，实现时按此表逐项映射：

| 维度          | Anthropic Messages               | OpenAI Chat Completions      | Gemini generateContent                    | Ollama                      |
| ------------- | -------------------------------- | ---------------------------- | ----------------------------------------- | --------------------------- |
| 端点          | `POST /v1/messages`              | `POST /v1/chat/completions`  | `POST /v1/models/*:streamGenerateContent` | `POST /api/chat`            |
| System prompt | 顶层 `system` 字段               | `messages[0].role='system'`  | **无 system 字段**，塞第一条 user         | `messages[0].role='system'` |
| Tool 定义位置 | `tools` 顶层                     | `tools` 顶层                 | `tools[].functionDeclarations[]`          | 视版本，v0.3+ 支持          |
| Tool 结果表达 | user message + `tool_result`     | tool role + `tool_call_id`   | function role + `functionResponse`        | tool role                   |
| 图像          | `content[].type='image'`         | `content[].type='image_url'` | `parts[].inlineData`                      | `images[]` base64           |
| 思考          | `thinking` content type          | `reasoning` field (o1/o3)    | 无原生 field                              | 无                          |
| 缓存          | `cache_control` breakpoint       | 自动（无控制）               | context caching (需 explicit)             | 无                          |
| 并行工具      | ✅                               | ✅                           | ⚠️ 部分模型                               | ⚠️ 视模型                   |
| Stream 帧格式 | SSE `event: content_block_delta` | SSE `data: {...}` 累加 delta | SSE JSON lines                            | NDJSON                      |
| 错误码        | `400 invalid_request_error`      | `429 rate_limit`             | `429 RESOURCE_EXHAUSTED`                  | `500` (通常)                |
| Token 计数    | `/v1/messages/count_tokens`      | tiktoken 近似                | `countTokens` 端点                        | 无                          |

**每个 provider-\* 包必须实现**：

1. Message ↔ provider format 双向转换器（含图像/工具/思考的差异处理）
2. Stream 帧 → `ProviderChunk` 归一化
3. 错误码 → `ProviderError`（含 `retryable: boolean` / `category`）
4. capabilities 描述（静态或按模型动态）
5. Auth 挂载（读 `packages/auth` 拿 credential）
6. `http-kit` 客户端配置（timeout / proxy / retry base）

### 3.6 ProviderError 分类

```ts
export interface ProviderError extends Error {
  provider: string
  model?: string
  status?: number
  category: ProviderErrorCategory
  retryable: boolean
  retryAfterMs?: number // 429 时优先用
  cause?: unknown
}

export type ProviderErrorCategory =
  | 'network' // 连接失败 / 超时 / DNS
  | 'auth' // 401 / 403 → 提示重新 login
  | 'rate_limit' // 429
  | 'quota' // 余额不足
  | 'invalid_request' // 400 → 大概率是我们的 bug
  | 'content_filter' // 被 safety 拦
  | 'model_not_found' // 404
  | 'server' // 5xx
  | 'context_length' // context 超限 → 触发 context 压缩重试
  | 'stream_truncated' // 流式连接中途断（RST / abort / 响应体不完整），见 §3.9a
  | 'unknown'
```

**每类的 Router / Runner 反应**（详见 §3.9）：

| 类别               | Router 行为                                     | Runner 行为                                                                        |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `network`          | 指数退避后同 provider 重试；3 次失败 fallback   | 中转失败 → 用户可见的 retry 提示                                                   |
| `auth`             | ❌ 不 fallback（换 provider 也没 key）          | 立即报错，提示 `apollo login`                                                      |
| `rate_limit`       | 首选 fallback，无 fallback 时按 retryAfter 退避 | 显示等待时间                                                                       |
| `quota`            | fallback                                        | 无 fallback 时报错                                                                 |
| `invalid_request`  | ❌ 不 fallback（同样会 400）                    | 报错到 telemetry，用户可见错误                                                     |
| `content_filter`   | fallback（不同 provider 尺度不同）              | 用户可见提示                                                                       |
| `model_not_found`  | fallback                                        | 提示模型不可用                                                                     |
| `server`           | 指数退避 + fallback                             | 同 network                                                                         |
| `context_length`   | ❌ 不 fallback（换 provider 也超）              | Runner 触发**紧急压缩** + 重试一次                                                 |
| `stream_truncated` | 见 [§3.9a](#39a-流式中断处理-stream-resilience) | Runner 作废当前 assistant 消息 + 按 sticky 语义决定重试/fallback；不落半截 message |
| `unknown`          | 保守：一次退避 + fallback                       | 报错                                                                               |

### 3.7 Router 契约（packages/router）

```ts
export interface RouterPolicy {
  readonly name: string

  /** 每 turn / 每次 provider 调用前询问 */
  pick(ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision>

  /** provider 报错后询问是否 fallback */
  onError(err: ProviderError, ctx: RouterContext): Promise<RouterDecision | 'give-up'>

  /** 生命周期 */
  init?(config: RouterConfig): Promise<void>
  dispose?(): Promise<void>
}

export interface RouterContext {
  session: SessionSnapshot // 只读，含 cumulativeUsage / lastProvider 等
  turnId: TurnId
  attemptCount: number // 当前 turn 内已尝试次数（用于退避）
  budget?: { costUSDMax?: number; timeMsMax?: number }
}

export interface RouterHint {
  explicitModel?: string // 用户输入 `@gpt-4 ...` 时提取
  role?: 'planner' | 'coder' | 'reviewer' | 'chat' | 'reflection' // hooks/plugins 可以塞角色暗示；'reflection' 为 §21 动态反思（2026-08-23 新增），RoleRouter 未配置该 role 的候选链时回落当前会话模型（合法降级，非错误）
  costPreference?: 'cheap' | 'balanced' | 'quality'
}

export interface RouterDecision {
  provider: ProviderClient // 已实例化
  model: string
  reason: string // 用于 telemetry / UI 展示
  metadata?: Record<string, unknown>
}
```

**关键决策**：

- Router **每次** provider 调用前都被询问，可以在同一 turn 内动态切换 —— **但受 sticky 约束**（见下）。
- Router **不感知具体 provider 实现**，只操作 `ProviderClient` 实例；实例从 `ProviderRegistry` 解析（registry 兼纳核心 provider 与插件 provider，见 [PLUGIN-PROVIDER-r1](./PLUGIN-PROVIDER-r1.md)）。
- Router 状态（哪个 provider 冷却中、剩余重试等）由 `RouterPolicy` 实例内部维护，不放 `SessionState`。
- Runner 只调 `router.pick(ctx, hint)`；错误处理调 `router.onError(err, ctx)`；不直接实例化 provider。
- ★ **自我进化接入（r10）**：Router 参数（fallback 优先级权重 / `cooldownSeconds`）可经 [§15.4](./15-self-evolution.md) 自调优；调整记 `~/.apollo/tuning/router.jsonl`。观察信号：各 provider 失败率 / fallback 后用户中断率。落地里程碑：L3。安全护栏：优先级不可调到让某 provider 永不被选（防进化把流量引偏）。
- `apps/cli` 启动时按用户配置 new 出一个 `RouterPolicy`，注入 Runner。

#### 3.7.1 ★ Turn 内 Provider Sticky（B4）

**问题**：tool_use_id 是 provider-specific 格式（Anthropic 用 `toolu_01...`，OpenAI 用 `call_...`）。一个 turn 内若产生了 tool_use 后 fallback 切 provider，新 provider 无法识别原 tool_use_id → tool_result 匹配失败 → 500 或错答。

> **r13-D1 注记（合成 tool_use id 的合法性）**：Gemini / Ollama 等适配器不回传稳定 tool_use id 时，允许适配器**合成 id**（如 `gemini-call-N`，N 为 turn 内序号）。合成 id 的唯一性要求 = **turn 内唯一**即可；同一 turn 的 tool_result 匹配、§3.2 聚合 Map 都以 turn 为作用域。**不跨 provider / 跨 turn 复用**合成 id（防 replay 与去重冲突）。

**规则**：

1. **首轮 / 纯文本轮可自由切换**：turn 内**尚未产生任何 `tool_use.*` chunk** 的 provider call，Router 可任意切换（fallback / role-route / etc.）。
2. **一旦产生 tool_use → 锁定 provider**：Runner 侧在**收到第一个 `tool_use.start` chunk 时立即**记录 `stickyProvider = <当前 provider>`（见 §2.4 注 B4），**不等 message 装配完**。本 turn 剩余 loop 迭代直接复用 `stickyProvider`，**不再调 `router.pick`**。
   - ★ 早锁原因（REVIEW-r6 P0-2）：若锁发生在 message 装配后，则"tool_use chunk 已 emit 但 lock 未 set"的时间窗内，provider 中途 `rate_limit` 触发 fallback 可能切到 provider B → B 不识别 A 的 tool_use_id。在 chunk 抵达时即锁，消除该窗口。
3. **锁定期内出错走 `onError` 但只能同 provider 重试**：
   - `router.onError` 返回的 `RouterDecision` 若 `provider !== stickyProvider` → Runner 拒绝该 decision，emit `error.raised { code: 'provider_sticky_violation', reason: 'tool_use already in flight, cannot switch provider' }` 并结束 turn（让用户重发，不与 `tool_loop_exhausted` 复用语义，见 NEW-P3-1）；
   - `onError` 也可返回 `'give-up'` → Runner 直接结束 turn。
   - ★ 流式中断（`stream_truncated`，[§3.9a](#39a-流式中断处理-stream-resilience)）特例：若中断发生在 sticky 锁定**之前**（未 emit `tool_use.*`），允许跨 provider fallback 重跑整个 turn；若在 sticky 锁定**之后**，只能同 provider 重试或 give-up。
4. **turn 边界解锁**：`turn.completed` 或 `turn.aborted` 后 `stickyProvider` 清空，下一 turn 从 `pick` 重新决策。
5. **配置逃生舱**：`[router] allow_cross_provider_tool_use = false`（默认）；显式设为 `true` 时 Runner 会在切换 provider 前调 `provider.translateToolUseId(oldId, newProvider)` 尝试转换（provider-kit 契约扩展，v2 才实现）。

**为什么这么严**：设计追求"可预测的失败"。宁可让用户看到"provider 冷却中，请等 30s 再试"，也不要一次 fallback 静默产生错答。

**Router 实现者义务**：`FallbackRouter` / `RoleRouter` 等在 `pick` / `onError` 时须查 `ctx.session.turn.stickyProvider`；若已锁定，直接返回锁定 provider（无视 hint / cost 偏好）。Runner 会兜底校验，但 Router 应主动尊重语义以获得更好 telemetry。

#### 3.7.2 RouterHint 补注（r13-G5 / B7）

\`RouterHint\` 增可选字段 \`preferredProvider?: string\`——上一 turn 的 provider 名。B7 截断续写场景：上一条回复以 \`max_tokens\` 截断时，Runner 对下一条消息（典型：用户输入 \`continue\`）注入该 hint，Router **应优先沿用**同 provider（防续写换 provider 造成风格断裂）；调用方显式 \`explicitModel\` 优先于 B7 推断。hint 是偏好不是硬约束（Router 可因 provider 不可用忽略）。

### 3.8 Router 策略实现

#### 3.8.1 SingleProviderRouter（MVP 必备）

```ts
class SingleProviderRouter implements RouterPolicy {
  constructor(
    private client: ProviderClient,
    private defaultModel: string,
  ) {}

  async pick(_ctx, hint) {
    return {
      provider: this.client,
      model: hint?.explicitModel ?? this.defaultModel,
      reason: 'single-provider',
    }
  }

  async onError(err, ctx) {
    if (!err.retryable) return 'give-up'
    if (ctx.attemptCount < 3 && err.category !== 'context_length') {
      await sleep(backoff(ctx.attemptCount, err.retryAfterMs))
      return { provider: this.client, model: this.defaultModel, reason: 'retry' }
    }
    return 'give-up'
  }
}
```

**用途**：MVP 唯一实现。用户配置 `provider: 'anthropic'` + `model: 'claude-sonnet-4-5'` 即用此策略。

#### 3.8.2 FallbackRouter（v1.1）

按优先级列表串行尝试；当前 provider 报可 fallback 错误时切下一个。冷却期内不重试失败的 provider。

```
config:
  chain:
    - { provider: 'anthropic', model: 'claude-sonnet-4-5', priority: 100 }
    - { provider: 'openai',    model: 'gpt-4o',            priority: 80 }
    - { provider: 'ollama',    model: 'qwen2.5-coder:32b', priority: 10 }
  cooldownSeconds: 60
```

- Cool-down 期内跳过；空闲时优先级最高的候选被选中。
- 一 turn 内切换会 `emit router.switched` 事件（UI 展示"已切换到 GPT-4o"）。
- 上下文差异（比如 Claude → GPT-4 后思考消息处理不同）由 provider 适配器负责归一。

#### 3.8.3 RoleRouter（v1.2）

根据 `hint.role` 分派到不同模型（比如 planner 用便宜模型，coder 用强模型）：

```
config:
  roles:
    planner:  { provider: 'openai',    model: 'gpt-4o-mini' }
    coder:    { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    reviewer: { provider: 'anthropic', model: 'claude-opus-4' }
    default:  { provider: 'anthropic', model: 'claude-sonnet-4-5' }
```

`hint.role` 来源：

- 用户输入前缀（`@planner ...`）
- Hook 注入（用户配置 hook 根据 prompt 分类角色）
- 内置：subagent dispatch 时传入其 agentType

实现组合固定为 `RoleRouter → FallbackRouter → ProviderRegistry`：RoleRouter 只选择 role 对应的显式候选链，重试分类、cooldown、budget 和 sticky retry 全部委托给每条链的 FallbackRouter，不复制安全逻辑。每个 turn 记录实际选中的链以处理 `onError`，记录数量有上限以防长期会话造成无界状态增长；未知 turn 的错误 fail closed 为 `give-up`。

Role 配置中的 provider 名必须在构造时通过 ProviderRegistry 解析成功。插件 provider 只有被 role/fallback 配置点名或本 turn 通过 `provider/model` 显式选择时才会进入候选池；仅注册不会自动获得流量，且 v1 仍禁止作为 default。

#### 3.8.4 CostAwareRouter（v2）

根据 session `cumulativeUsage.costUSD` 与 budget 动态选择：预算未到用强模型，接近上限降级到便宜模型。规则化配置，不做黑箱。

#### 3.8.5 未来（out of scope for MVP）

- SemanticRouter（用小模型分类 prompt）—— 复杂度高、不确定收益，push 到 v2
- Blend / Ensemble —— 多模型投票，实验性

### 3.9a 流式中断处理（Stream Resilience）

> 解决 REVIEW-r6 P0-1：stream 中途断线（network RST / provider 429 / abort / 响应体不完整）时的会话状态一致性。

#### 问题

provider stream 可能在任意 chunk 边界中断。若不定义 resume 语义，三类状态错位会污染 session：

1. **半截 assistant message**：已 emit 给 UI/hook 的 `text.delta` 片段无对应 `message.stop`，落盘成残缺 message。
2. **tool_use JSON 截断**：`tool_use.delta.argsFragment` 流断在 JSON 中间 → 下一步 `JSON.parse` 必失败 → 只落 `tool_result{error}`，但**模型端认为该 tool 已开始执行**，provider 视角与 session 视角错位。
3. **UTF-8 多字节跨 chunk**：Anthropic/OpenAI/Gemini 都可能把一个多字节字符切到两个 chunk；若按 byte 拼接而非 streaming decoder，`String.fromCharCode` 会产出乱码。

#### 契约

**1. ProviderChunk 增 `message.interrupted` kind**（[§3.2](#32-providerclient-契约provider-kit)）：

- provider 适配器在 stream **异常**终止（连接断 / abort / 超时 / 响应体不完整）时，**必须**先 emit 一个 `message.interrupted { reason, partial }` chunk，再结束 iterable；`partial` = 已累计的未提交片段（供 Runner 决策作废 vs 保留）。
- 正常 `message.stop`（含 `end_turn`/`tool_use`/`max_tokens`/`stop_sequence`）**不**发 `interrupted`。
- `message.interrupted` 与 `message.stop` **互斥**（二选一），与 [§3.2](#32-providerclient-契约provider-kit) 的 `error` chunk vs throw 二选一一致。

**2. 强制 streaming UTF-8 decoder**：

- provider 适配器**必须**用 `TextDecoder({ stream: true })`（或等价）跨 chunk 拼接 text；**禁止**逐 chunk `Buffer.toString()` 后字符串拼接（会切坏多字节字符）。
- 单元测试：构造把一个 emoji 切到 byte 边界的 chunk 序列，断言最终文本正确。

**3. Runner 的 turn 作废语义**（[§2.4](./02-agent-loop.md#24-runner-主循环伪代码)）：

- Runner 收到 `message.interrupted` 后，**作废整个进行中的 assistant message**（不落盘、不入 SessionState.messages、不 emit `message.appended`）。
- 已 emit 给 UI 的 `stream.delta` 由 UI 侧标记为"已撤销"（UI 收到 `message.interrupted` → 把当前 streaming block 渲染为 `[stream interrupted: <reason>]` 灰色 + 撤销按钮，**不**提交到 transcript）。
- 已 emit 的 `tool_use.start/delta` **作废**：Runner 不调用任何 tool，不产生 tool_result；模型端若重试，视为全新 tool_use。
- emit `error.raised { code: 'stream_interrupted', turnId, reason, hadPartialToolUse: <bool> }`。

**4. 重试/fallback 决策（与 sticky 正交但受限，r9 优化"复用已完成状态"）**：

- Runner 把 `stream_truncated` 当作可重试错误交给 `router.onError`。
- **若本 turn 尚未产生任何 `tool_use.*` chunk**（`stickyProvider == null`）：`onError` 可自由选择同 provider 重试（指数退避）或 fallback 到别的 provider，**整个 turn 从头重跑**（重新调 `provider.stream`）。
- **若已产生 `tool_use.*` chunk**（`stickyProvider` 已锁定，见 §3.7.1 规则 2a）：`onError` **只能同 provider 重试**或 `give-up`，**禁止跨 provider fallback**（否则 tool_use_id 不匹配）。
- **★ r9 优化：重跑时复用已完成且 provider 无关的状态**（避免重复计费 + 重复执行 tool）：
  - **复用**：已落盘的 `tool_result` message（tool 已执行完毕的结果）、用户原始 message、已压缩的 summary、system prompt（PromptComposer 重新 compose 但内容相同）。
  - **重发**：只重发 provider `stream` 请求（重新调 `provider.stream`），不重新执行已完成的 tool。
  - **不重跑已完成的 tool_use**：若中断发生在 turn 的第 N 个 loop 迭代（前 N-1 个 tool 已执行落盘），重跑时从第 N 个迭代继续（messages 里已含前 N-1 个 tool_result），而非从第 1 个迭代重来。
  - **省的钱**：避免重复执行 tool（Bash/Edit 等副作用工具重复执行可能有害）+ 避免重复发送已落盘的 user/tool_result 的 input token 计费。
- 重试上限：同 provider 最多 2 次（指数退避 1s / 4s）；仍失败 → `give-up`，turn 以 `error` 结束，UI 提示"连接中断，请重发"。
- 边界：重跑若再次中断，累计重试次数仍受本条上限（同 provider 2 次）；`loopCount` 不重置（占额度，防死循环）。

**5. 不做 resume-from-offset（v1 明确）**：

- v1 **不**实现"从断点继续接收剩余 chunk"（byte/token offset 级续传）。理由：(a) 各 provider 无稳定的 byte/token offset resume API；(b) 半截 message + 续传的实现复杂度高于收益。
- **★ r13-D1（streamResume 护栏入契约）**：ProviderCapabilities **不设** `streamResume` 能力位；若未来 provider 插件在 `rawMeta` / capability 里自行声明 offset-resume 能力，Runner **显式拒绝**（fail-fast：emit `error.raised { code: 'stream_resume_unsupported' }`），不静默尝试。防误用护栏从实现约定升级为契约。
- **r9 区分**：上述"不做 resume-from-offset"指**provider stream 的字节级续传**；而规则 4 的"复用已完成 tool_result"是**Runner 侧状态复用**（不需要 provider 支持 offset），两者不同。后者 v1 即做（省 tool 重复执行 + 省 input token），前者推 v2。
- 留 v2：若 provider 提供官方 resume（如 Anthropic 的 stream_id），再评估接入字节级续传。
- ★ **自我进化接入（r10）**：retry 次数 / 退避系数可经 [§15.4](./15-self-evolution.md) 自调优；调整记 `~/.apollo/tuning/retry.jsonl`。观察信号：重试成功率 / 重试后仍失败比例。落地里程碑：L3。安全护栏：retry 次数上限不可超过 5（防进化无限重试烧 token）。

#### 边界与清单（新增到 §3.10）

| 规则                                                                      | 强制点                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| stream 异常终止**必须** emit `message.interrupted`（不发 `message.stop`） | provider 适配器单元测试（模拟 RST / abort / 不完整 body） |
| text 拼接**必须**用 streaming `TextDecoder`                               | provider 适配器单元测试（多字节边界 chunk）               |
| Runner 收到 `message.interrupted` **必须**作废进行中 message（不落盘）    | core 集成测试                                             |
| sticky 期间 `stream_truncated` **禁止**跨 provider fallback               | core 单元测试（assert 不调 `router.pick`）                |
| UI 收到 `message.interrupted` **必须**把 streaming block 标记撤销而非提交 | ui 单元测试                                               |
| `tool_use.*` 已 emit 后中断 → Runner **不**调 tool、**不**产 tool_result  | core 集成测试                                             |

### 3.9 显式路由：`@model` 前缀

用户可在输入首行加 `@<alias> ...` 显式指定模型：

```
@sonnet 帮我重构这段代码
@gpt-4o-mini 简单问一下
```

> **UI 侧触发**（r9 更新）：`@` 是**统一 picker** 入口，在 InputBox 里键入 `@` 会进 alias 置顶 + 文件候选跟后的统一 picker（见 §7.5.3）。选中 alias 候选 → model 分支；用户也可以用 `@!<alias>` 强制 model 模式。落到 model 分支后，剥离规则与本节一致。

**流程**：

1. `apps/cli` 输入解析器识别 `@<alias>` 前缀，剥离后传给 Runner
2. Runner 把 `explicitModel: <alias>` 放进 `RouterHint`
3. Router 优先使用 `explicitModel`（各策略实现自决是否尊重）
4. `SingleProviderRouter` 直接用；`FallbackRouter` / `RoleRouter` 视作 override，忽略角色/优先级
5. 未识别的 alias → 报错列出可用 alias（用户配置里维护 `models.aliases`）

**Alias 配置**（`~/.apollo/config.toml`）：

```toml
[models.aliases]
sonnet       = { provider = "anthropic", model = "claude-sonnet-4-5" }
opus         = { provider = "anthropic", model = "claude-opus-4" }
"gpt-4o"     = { provider = "openai",    model = "gpt-4o" }
"gpt-4o-mini"= { provider = "openai",    model = "gpt-4o-mini" }
"qwen"       = { provider = "ollama",    model = "qwen2.5-coder:32b" }
```

Alias 是**用户面**的短名字，避免记忆 provider 全称。

### 3.10 边界与安全清单

| 规则                                                                                                                                                                                      | 强制点                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `Runner` 禁止 import 任何具体 `provider-*` 包；**通过 `ProviderRegistry` 拿 `ProviderClient` 引用**（registry 兼纳核心与插件 provider，见 [PLUGIN-PROVIDER-r1](./PLUGIN-PROVIDER-r1.md)） | ESLint 依赖规则                         |
| `Runner` 只持有 `RouterPolicy` 引用；RouterPolicy 从 `ProviderRegistry` 解析 provider 名→实例（Runner 仍不直接持 ProviderClient）                                                         | `Runner` 构造函数签名                   |
| `provider-*` 内**禁止** `import { fetch } from 'undici'`，必须走 `http-kit`                                                                                                               | ESLint no-restricted-imports            |
| `provider-*` 内**禁止**直接读 `process.env.XXX_API_KEY`，必须走 `auth`                                                                                                                    | ESLint no-restricted-imports            |
| `provider-*` 内**禁止**拼接 system prompt（该字段由 Runner 从 PromptComposer 拿）                                                                                                         | code review                             |
| 中性 `Message` **禁止**含 provider 独有字段；provider 独有走 `rawMeta.<provider>`                                                                                                         | 类型约束                                |
| provider 适配器**只读**自己命名空间的 `rawMeta` key，未知 key 忽略                                                                                                                        | 单元测试                                |
| `ProviderChunk.error` 与 throw **二选一**，不双发                                                                                                                                         | 单元测试                                |
| `AbortSignal` 传递到底层 http 请求                                                                                                                                                        | 单元测试（发大请求 abort 检查连接断开） |
| `ProviderCapabilities.maxContextTokens` 是**静态**声明，与实际 API 一致                                                                                                                   | provider 包发布前手动核对               |
| Router 错误时**必须**决定 `retry` / `fallback` / `give-up`，不能默默吞异常                                                                                                                | Runner 层强制                           |
| Router 切换时**必须** emit `router.switched` 事件                                                                                                                                         | 单元测试                                |

### 3.11 里程碑

- **L1（MVP）**：`provider-anthropic` + `SingleProviderRouter`；`provider-kit` 完整契约；capability 静态描述；**`@` 统一 picker 的 model 分支（alias 解析）随 §7.8 在 L1 落地**（见 §3.9 + §7.5.3，选 alias 候选 → 切 model；alias 配置经 §3.9 `models.aliases`）
- **L2**：`provider-openai` + 相同 Router；跨 provider 一致性测试
- **L3**：`FallbackRouter`；错误分类完整；冷却机制
- **L4**：`provider-gemini` + `provider-ollama`；`RoleRouter`

> **alias 里程碑澄清（r10 修正）**：早期版本曾把"`@model` alias 解析"列在 L4。r9 引入 `@` 统一 picker（§7.5.3）后，alias 选 model 的能力已随 picker 在 **L1** 落地（用户键入 `@` → alias 候选置顶 → 选 alias → 切 model）。L4 不再有独立的 "alias 解析" 里程碑项。`RoleRouter`（按 `hint.role` 分派）仍在 L4。
