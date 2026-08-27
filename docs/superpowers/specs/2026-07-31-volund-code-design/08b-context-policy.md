> ↩ [返回索引 (README)](./README.md) · ← [上一章: §8 会话与配置存储](./08-session-config.md) · [下一章: §9 构建 / CI / 分发](./09-build-ci-dist.md) →

---

## §8b 上下文管理（ContextPolicy）

> **本节为 r9 新增**：补齐此前 spec 对「agent 智能层 / context 压缩」规格不足的系统性短板。`packages/context` 提供 `ContextPolicy` 抽象，由 Runner 在 §2.4 主循环每次 provider 调用前询问。

### 8b.1 为什么单独成节

§2.4 Runner 主循环只调 `contextPolicy.shouldCompact(state)` / `contextPolicy.buildPrompt(messages, capabilities)` 两个黑盒方法，但**没有任何算法细节**：什么时候压缩？summary 用哪个模型？压缩后保留哪些消息？token budget 怎么算？对 AI 编码工具，context 管理是成败关键——压缩过早丢上下文导致模型失忆；压缩过晚 token 爆炸导致 429 / 截断 / 烧钱。本节把这套机制完整规格化，并开放给 hook / 插件扩展。

### 8b.2 ContextPolicy 契约（provider-kit）

> 契约归属：`ContextPolicy` 定义在 `packages/provider-kit`（与 `Message` / `ContextPolicy` 概念绑定，对齐 §1.4 决策）；实现放 `packages/context`。

```ts
// packages/provider-kit/src/context-policy.ts
export interface ContextPolicy {
  readonly name: string                              // 'sliding' / 'summary' / 'semantic' / '<plugin>'

  /** Runner 每轮 provider 调用前问：当前 context 是否需要压缩？ */
  shouldCompact(ctx: ContextCtx): boolean

  /** Runner 装配 provider 请求时问：把哪些 messages 发给 provider？ */
  buildPrompt(ctx: ContextCtx): ContextMessages

  /** 触发压缩（shouldCompact=true 后 Runner 调），返回压缩后的快照 */
  compact(ctx: ContextCtx): Promise<ContextSnapshot>

  /** token 估算（buildPrompt 内部用 + UI 展示用） */
  estimateTokens(text: string, model: string): number

  /** 生命周期 */
  init?(config: ContextConfig): Promise<void>
  dispose?(): Promise<void>
}

export interface ContextCtx {
  readonly session: SessionSnapshot                 // 只读，含 messages / cumulativeUsage / contextBudget
  readonly capabilities: ProviderCapabilities       // 当前 provider 的 maxContextTokens 等
  readonly turnId: TurnId
}

/** buildPrompt 输出：交给 provider adapter 的最终 messages */
export interface ContextMessages {
  /** 进 provider request 的 messages（已按 budget 裁剪） */
  messages: ReadonlyArray<Message>
  /** 被裁掉的消息 id（telemetry / hook postCompact 用） */
  removedMessageIds: MessageId[]
  /** 估算的总 token 数（含 system prompt） */
  estimatedTokens: number
  /** 是否已在上一次 compact 中插入过 summary marker */
  hasSummary: boolean
}

/** compact 输出 */
export interface ContextSnapshot {
  /** 压缩后的 messages（含 summary 占位 message，如有） */
  messages: ReadonlyArray<Message>
  /** 被压缩掉的原始消息 id 列表 */
  compactedMessageIds: MessageId[]
  /** 压缩前后 token 数 */
  beforeTokens: number
  afterTokens: number
  /** 用的策略名（telemetry） */
  strategy: string
  /** 压缩过程是否过 hook 介入（telemetry） */
  hookIntercepted: boolean
}
```

**Runner 调用点**（§2.4 主循环）：

```pseudo
loop:
  if contextPolicy.shouldCompact(ctx):
    snapshot = await contextPolicy.compact(ctx)        # emit context.compacted
    state = state.replaceMessages(snapshot.messages)
    hooks.trigger('postCompact', { snapshot })
  contextMessages = contextPolicy.buildPrompt(ctx)
  stream = provider.stream({ system: systemPrompt, messages: contextMessages.messages, ... })
```

### 8b.3 Token 估算

`estimateTokens` 是所有策略的基础。**分层实现**：

| 层 | 实现 | 精度 | 何时用 |
|---|---|---|---|
| 1（优先） | `native-bridge.countTokens(text, model)`（tiktoken-rs，见 §5.7） | 精确 | native worker 可用时 |
| 2（fallback） | `gpt-tokenizer` npm 包（JS 实现，见 §5.7 fallback） | 接近（~98%） | native 不可用 / worker 崩溃 |
| 3（兜底） | `text.length / 3.5` 字符近似 | 粗糙（±30%） | 上述都失败，仅 UI 展示用 |

**缓存**：`estimateTokens(text, model)` 以 `hash(text) + model` 为 key 缓存（LRU 5000 条）。同一 turn 内多次调同一 message 不重复算。**★ r13-D1：缓存生命周期 = per-policy 实例**——缓存挂在 ContextPolicy 实例上，policy `dispose()` 即整体丢弃（不进程级共享）：换 model / provider 切换导致 BPE 变化时不会读到旧估算，也防长驻进程缓存无界存活。

**注意**：
- system prompt 的 token 由 PromptComposer 单独算（§6.5），不进 ContextPolicy 的 budget
- tool schema（provider `tools` 字段）的 token 由 provider adapter 估（OpenAI/Anthropic 都有官方算法），从 `maxContextTokens` 里**预扣**
- 实际 budget = `capabilities.maxContextTokens - systemTokens - toolSchemaTokens - reservedOutputTokens`

### 8b.4 SlidingWindowPolicy（L1 唯一落地）

**心智**：按 token budget 滑窗，保留最近 N 条消息，老的直接丢弃（不调 LLM）。零成本、可预测、MVP 够用。

**算法**：

```
shouldCompact(ctx):
  budget = ctx.capabilities.maxContextTokens - systemTokens - toolSchemaTokens - reservedOutput
  current = sum(estimateTokens(m) for m in ctx.session.messages)
  return current >= budget * config.compaction_threshold   # 默认 0.85

compact(ctx):
  budget = ... (同上)
  target = budget * config.target_ratio                     # 默认 0.6，压到 60%
  kept = [all messages from latest turn]                    # 当前 turn 全留
  # 倒序遍历老消息，累计 token 直到 ≤ target
  for m in reversed(older_messages):
    if accumulated + estimateTokens(m) > target: break
    kept.unshift(m)
  # ★ tool_use ↔ tool_result 配对保护：不能留一个 tool_use 却丢它的 tool_result
  kept = repairToolPairings(kept, all_messages)             # 见 8b.9 边界
  # ★ pinned memory / 当前激活 skill 的注入不在此处理（PromptComposer 管）
  return ContextSnapshot { messages: kept, compactedMessageIds: dropped, ... }
```

**保留优先级**（高 → 低）：
1. 当前未完成 turn 的所有消息（streaming 状态）
2. 最近的 `config.sliding_keep_recent` 条（默认 20）
3. tool_use ↔ tool_result 完整配对（不可拆，见 8b.9）
4. 含 pinned memory 引用的消息（虽 pinned 内容在 PromptComposer，但历史 turn 里模型用过它的话保留）
5. 其余老消息按时间倒序填充剩余 budget

**配置**（`config.toml [context]`）：

```toml
[context]
policy = "sliding"                # L1 默认
max_tokens = 180000               # 上限，实际取 min(this, capabilities.maxContextTokens)
compaction_threshold = 0.85       # 达到 85% budget 触发压缩
target_ratio = 0.6                # 压到 60%
reserved_output_tokens = 8192     # 给模型 output 预留

[context.sliding]
keep_recent = 20                  # 至少保留最近 N 条
```

### 8b.5 SummaryPolicy（L2 落地）

**心智**：压缩时不是简单丢弃，而是调一个**小 / 便宜模型**把老消息批量总结成 summary message，summary 进 context 作历史摘要。比 Sliding 保留更多长程信息。

**算法**：

```
compact(ctx):
  # 1. 决定哪些消息要被 summarize（同 Sliding 的"老消息"划分）
  toSummarize, toKeep = partition(ctx.session.messages, target)
  # 2. 调 summary provider（可能不是当前主 provider）
  summaryPrompt = buildSummaryPrompt(toSummarize, ctx.session.cwd)
  summaryProvider = registry.get(config.summary_provider)   # 默认用主 provider 的便宜 model
  summaryText = await summaryProvider.complete({
    model: config.summary_model,
    system: SUMMARY_SYSTEM_PROMPT,                          # 见 8b.5.1
    messages: [{ role: 'user', content: summaryPrompt }],
    maxTokens: config.summary_max_tokens,                   # 默认 2000
  })
  # 3. 构造 summary 占位 message
  summaryMsg = {
    role: 'user',
    content: [{ type: 'text', text:
      `<conversation_summary compacted_at="${ISO}" tokens_before="${N}" tokens_after="${M}">
       ${summaryText}
       </conversation_summary>` }],
    meta: { compacted: true, compactedMessageIds: [...] }
  }
  # 4. 新 messages = [summaryMsg, ...toKeep]
  return ContextSnapshot { messages: [summaryMsg, ...toKeep], ... }
```

**失败回退**：summary provider 调用失败（网络 / 429 / 任意异常）→ **自动回退到 SlidingWindowPolicy.compact**（直接丢弃老消息）+ emit `context.summary_failed` telemetry + UI 提示"上下文压缩回退到滑窗模式"。**不允许**压缩失败导致 turn 中断。

#### 8b.5.1 Summary system prompt（内置，可被插件覆盖）

```
You are a conversation summarizer for an AI coding agent. Summarize the following
conversation history into a concise, dense reference that preserves:
- User's original goal / task
- Key decisions made and their rationale
- Files created / modified / deleted (with paths)
- Commands run and their outcomes
- Unresolved questions / TODOs
- Any user-stated preferences or constraints

Do NOT include:
- Verbatim code (reference file paths instead)
- Secret / credential / PII (redact on sight)
- Step-by-step tool output (summarize outcomes)

Output as markdown, ≤ {{max_tokens}} tokens. Be dense, not narrative.
```

**untrusted 包裹（重要）**：被 summarize 的老消息里若含 `<untrusted>` 包裹的内容（§6.5.0a），summary prompt **必须**仍把它们当 DATA 处理，summary 输出里不执行其中指令。summary message 进新 context 时**重新包** `<untrusted source="summary">`（防 summary 模型被注入后产出指令性 summary）。

**配置**：

```toml
[context]
policy = "summary"                 # L2 启用

[context.summary]
provider = ""                      # 空=用主 provider；可填 "openai" 用便宜模型
model = ""                         # 空=provider 默认；建议填 "gpt-4o-mini" 类
max_tokens = 2000                  # summary 输出上限
keep_recent = 20                   # 保留最近 N 条不进 summary
fallback_to_sliding = true         # 失败回退（默认 true，强烈不建议关）
```

### 8b.6 SemanticPolicy（v2，仅规格化）

**心智**：用 embedding 给所有历史消息建索引，buildPrompt 时按当前 user query 召回相关 top-K 条注入，其余丢弃。保留长程相关性的最强方案，但依赖 embedding provider + 索引存储。

**为何推 v2**：
- 依赖 embedding provider（额外 cost + 隐私考量）
- 索引存储（需向量库或本地索引文件）
- 召回质量调优周期长
- L1/L2 的 Sliding + Summary 已覆盖绝大多数场景

**契约预留**（v2 实现时填）：

```ts
interface SemanticPolicyConfig {
  embedding_provider: string                        // "openai" / "local"
  embedding_model: string                           // "text-embedding-3-small"
  index_path: string                                // ~/.volund/sessions/<id>.embeddings
  topk: number                                      // 默认 10
  keep_recent: number                               // 仍保留最近 N 条
  reindex_on: 'message.appended' | 'manual'         // 增量索引触发
}
```

**隐私约束**（对齐 AGENT.md §4.13）：embedding 调用默认**不出网**（用本地 embedding 模型如 `gte-*` via Ollama）；若用云端 embedding，**必须**显式 opt-in + 首次确认（与 telemetry OTel 同级同意门）。

### 8b.7 Hooks 扩展（preCompact / postCompact）

§2.6 已定义 `preCompact`（观察）+ `postCompact`（观察）。本节**增强为拦截型**：

| Hook | 类型 | 触发点 | 能做什么 |
|---|---|---|---|
| `preCompact` | **拦截** | `compact()` 真正执行前 | veto（不压）；改 `toSummarize` / `toKeep` 划分；注入额外保留消息；改 summary prompt（Summary 策略） |
| `postCompact` | 观察 | `compact()` 返回后 | 记录压缩量；备份被压缩的原文（插件可塞自己 storage）；触发外部索引更新 |

**hook ctx 扩展**：

```ts
interface CompactHookCtx extends HookCtx {
  strategy: 'sliding' | 'summary' | 'semantic' | string
  toSummarize: Message[]                            // preCompact 可改
  toKeep: Message[]                                 // preCompact 可改
  summaryPrompt?: string                            # 仅 summary 策略；preCompact 可改
}
interface CompactHookResult {
  veto?: boolean                                    # preCompact 返回 → 不压
  reason?: string
  modifiedToSummarize?: Message[]                   # 改划分
  modifiedToKeep?: Message[]
  modifiedSummaryPrompt?: string
  extraKeep?: MessageId[]                           # 额外强制保留的消息 id（如"永远保留 PR description"）
}
```

**典型用例**：
- 项目 hook：`preCompact` 强制保留 cwd 的 `AGENT.md` 引用消息（防压缩后丢失项目规则上下文）
- 安全 hook：`preCompact` 扫描 toSummarize 里的 secret，发现则 veto + 提示用户（防 secret 进 summary）
- 插件：`preCompact` 改 summaryPrompt 加领域专属摘要指引（如"这是 React 项目，重点保留 hooks 依赖关系"）

### 8b.8 插件扩展点（自定义 ContextPolicy）

插件可注册**自定义 ContextPolicy**：

```ts
// VolundBridge 新增（plugin-sdk 类型）
volund.context: {
  /** 注册自定义 ContextPolicy 实现 */
  contributePolicy(policy: ContextPolicySpec): Disposable
}

interface ContextPolicySpec {
  name: string                                       # 如 "plugin-git-stash-aware"
  policy: ContextPolicy                              # 实现（子进程内 RPC 代理）
  priority: number                                   # 多个插件 policy 时的选择优先级
  when?: (ctx: ContextCtx) => boolean                # 何时启用
}
```

**选择逻辑**：Runner 启动时收集所有已注册 policy（builtin + 插件），按 `config [context] policy = "<name>"` 显式选定；未指定时按优先级 + when 谓词选。**同一 session 内 policy 冻结**（切换需重启）。

**权限**：`manifest.permissions.volund` 必须含 `context.contribute` 才允许注册。policy 实现经沙箱执行（与 plugin tool 一样），其内部对 messages 的访问经 `volund.session.getMessages()` RPC（只读快照）。

**典型插件 policy**：
- `git-stash-aware`：按 git stash 边界分块压缩，每个 stash 是一个 summary 单元
- `pr-focused`：永远完整保留 PR description message + 相关 review comment
- `test-run-aware`：永远保留最近一次失败测试的完整输出

### 8b.9 边界与安全清单

| 规则 | 强制点 |
|---|---|
| **tool_use ↔ tool_result 配对不可拆**：任何策略的 compact 输出，若保留了某 tool_use，必须也保留对应 tool_result（反之亦然） | context 包单元测试（构造含 tool 配对的 messages，assert 压缩后配对完整） |
| **pinned memory 不可压缩**：pinned 内容由 PromptComposer 注入（§6.12.8），不进 messages 流，天然不受影响；但历史 turn 里模型用过 pinned 的消息保留优先级高 | context 单元测试 |
| **summary prompt 不可含 untrusted 内容的指令语义**：被 summarize 的老消息里的 `<untrusted>` 内容，summary 模型必须当 DATA；summary 输出重新包 `<untrusted source="summary">` | context 集成测试（注入含指令的 untrusted 老消息，assert summary 不执行指令） |
| **压缩不可丢失 turn 边界**：compact 输出的 messages 必须保持 turn 完整性（不能把一个 turn 的 user message 留下却丢掉它的 assistant 响应） | context 单元测试 |
| **summary provider 失败必须回退**：SummaryPolicy 的 summary 调用失败 → 自动回退 SlidingWindowPolicy，不允许压缩失败中断 turn | context 集成测试（mock summary provider 抛异常，assert 回退 + turn 存活） |
| **插件 policy 经沙箱执行**：自定义 policy 的实现跑在 plugin 子进程，对 messages 只读，不能直接改 SessionState | plugin-runtime + context 集成测试 |
| **token 估算缓存命中不可跨 model**：`estimateTokens` 缓存 key 必须含 model，否则不同 model BPE 不同导致预算错算 | context 单元测试 |
| **budget 预扣**：system + tool schema + reserved output 必须从 maxContextTokens 预扣，再算 messages budget | context 单元测试 |
| **preCompact hook veto 必须尊重**：hook 返回 veto → compact 不执行，buildPrompt 用原 messages（可能超限 → 由 provider 返 context_length 错 → 紧急压缩重试，见 §3.6） | context + hooks 集成测试 |
| **compact 是异步的**：Runner await compact 完成才继续 buildPrompt；compact 期间 turn 状态 = 'compacting'（UI 提示） | core 集成测试 |
| **`volund context keep` 的 pinned-to-context 标记必须可清除**（`unkeep`），不可永久锁住消息 | context 单元测试 |
| **手动 `volund context compact` 必须尊重 preCompact hook veto**（hook 否决则不压 + 报错，不强压） | context + hooks 集成测试 |

### 8b.10 事件（telemetry）

| 事件 | 说明 |
|---|---|
| `context.compacted` | `{ strategy, before_tokens, after_tokens, compacted_count, hook_intercepted, duration_ms }` |
| `context.summary_requested` | Summary 策略调小模型（`{ provider, model, input_tokens }`） |
| `context.summary_failed` | summary 调用失败 → 回退（`{ error_class, fallback_to: 'sliding' }`） |
| `context.estimated` | token 估算（采样：每 100 次发 1 次，`{ layer: 'native'|'js'|'approx', cache_hit }`） |
| `context.policy_switched` | 用户切换 policy（`{ from, to }`） |
| `context.keep_added` | 用户 `volund context keep` 加 pinned-to-context 标记（r10，`{ target: 'message'\|'turn', id }`） |
| `context.manual_compact` | 用户手动触发压缩（r10，`{ strategy, before_tokens, after_tokens }`） |

### 8b.11 里程碑

- **L1（MVP）**：`SlidingWindowPolicy` 完整 + token 估算（native 优先 + JS fallback）+ `preCompact`/`postCompact` hooks（拦截型）+ budget 预扣 + tool 配对保护
- **L2**：`SummaryPolicy`（含失败回退）+ summary system prompt（untrusted 安全）+ 插件 `volund.context.contributePolicy` 扩展点
- **v2**：`SemanticPolicy`（embedding 索引 + 召回）+ 本地 embedding 支持 + 索引存储

### 8b.12 跨节落地（差量）

- **§1.2 依赖表**：`context → provider-kit / shared`（context 实现依赖 provider-kit 的 ContextPolicy 契约 + Message 类型）
- **§1.4 契约归属**：`ContextPolicy / ContextMessages / ContextSnapshot` 定义在 provider-kit（已对齐）
- **§2.4 Runner 主循环**：`contextPolicy.shouldCompact` / `buildPrompt` / `compact` 调用点已存在，本节填实语义
- **§6.7 差量**：`packages/context` 责任 = 提供 ContextPolicy 实现集合（Sliding / Summary / Semantic）+ token 估算 + compact 执行器
- **§6.5 PromptComposer**：system prompt 的 token 由 composer 算，从 budget 预扣；pinned memory 由 composer 注入，不进 messages 流，不受 compact 影响
- **§6.11.1 hook priority**：`preCompact` / `postCompact` 走同一 priority pipeline（builtin 900-1000 / project 500-899 / plugin 0-499 / user -1000--1）

### 8b.13 透明可控（Transparency & Control，r10 新增）

> 响应用户原则「context 管理需要更加透明可控」。压缩不能是黑箱——用户必须能看到当前 context 状态、强制保留重要消息、手动触发压缩、查看压缩移除了什么。

**CLI 命令族**（`volund context ...`，详见 §11.3）：

| 命令 | 作用 |
|---|---|
| `volund context show [--json]` | 当前 token 占用 / 各来源占比（system / skill / memory:pinned / messages）/ 距下次压缩剩余预算 / 当前策略名 + 参数 |
| `volund context diff` | 上次压缩移除了哪些消息（messageId + 摘要首行 + turnId），用户可核对是否误删重要信息 |
| `volund context keep <messageId \| turnId>` | 给消息/turn 打 **pinned-to-context** 标记 → 压缩时**强制保留**（独立于 Memory 的 pinned，这是 context 级保留，session 结束失效） |
| `volund context unkeep <messageId \| turnId>` | 清除 pinned-to-context 标记 |
| `volund context compact [--strategy sliding\|summary]` | 手动触发压缩（可指定策略，否则用当前策略）；尊重 preCompact hook veto（hook 返回 veto 则不压 + 报错） |
| `volund context policy <get\|set>` | 查/改当前 ContextPolicy（`set` 走配置校验，立即生效下一轮） |

**TUI `/context` 面板**（L2，交互 REPL 内）：

```
┌─ Context ─────────────────────────────────────────┐
│ Strategy: sliding   Budget: 142300 / 180000 (79%) │
│ ▰▰▰▰▰▰▰▰▰▰▱▱▱▱  距压缩: 6% (到 85% 触发)          │
│                                                   │
│ 来源占比:                                          │
│   system    ▰▰▰▰▰▰▰▰▱  32%  (含 builtin+skill)   │
│   memory    ▰▱  4%  (pinned)                       │
│   messages  ▰▰▰▰▰▰▰▰▰▰▰▰▱  64%  (最近 18 条)     │
│                                                   │
│ 最近压缩:                                          │
│   12:34  removed 5 msgs (turn 3-5)  [diff]        │
│   11:20  removed 3 msgs (turn 1)    [diff]        │
│                                                   │
│ [K] keep 选中的  [C] 手动压缩  [Esc] 关闭         │
└───────────────────────────────────────────────────┘
```

- 实时更新（订阅 `context.compacted` / `message.appended` 事件）
- 选中某条消息按 K → 等价 `volund context keep`
- 按 C → 手动压缩（二次确认）

**TUI 内 hook 联动**：压缩前若 `preCompact` hook 标记了 `extraKeep`，UI 在压缩预览（`/context` 后按 C）里**高亮"将被保留"**的消息（绿色）；用户可在预览里额外勾选保留（勾选项作为 `extraKeep` 补充传给 compact）。

**与 §8.2b JSONL 分段的关系**：`volund context diff` 读的是 SessionState 的 messages 与上次压缩前的快照对比；大 session 走分段加载（§8.2b）只读最近窗口，diff 也只覆盖窗口内。

### 8b.14 自我进化接入点（r10 新增）

ContextPolicy 是**首个接入自我进化框架**（[§15](./15-self-evolution.md)）的能力节点。

| 可调参数（Layer B） | 默认值 | 观察信号（Layer B） | 调整策略 |
|---|---|---|---|
| `compaction_threshold` | 0.85 | 压缩后用户重复信息频率（post_compact_repeat_rate） | repeat_rate > 0.2 → 提高 threshold（减少压缩）；context_length 错误率高 → 降低 |
| `target_ratio` | 0.6 | 压缩后立即又触发的频率（压不够） | 频繁连环压缩 → 降低 target_ratio（压得更狠） |
| `keep_recent` | 20 | 用户手动 `context keep` 的消息常落在窗口外 → 窗口太小 | 常落窗外 → 增大 keep_recent |
| `summary_keep_recent` | 20 | summary 后用户抱怨丢失近期上下文 | 增大 summary_keep_recent |

**接入方式**：
- 参数当前值优先从 `~/.volund/tuning/context.jsonl` 读（§15.2 Layer B）；未调过则用 `config.toml [context]` 值；config 未设则用内置默认。
- 进化引擎（§15.3）周期性扫描 context namespace 信号，按 §15.4 矩阵策略调整。
- 调整经 §15.5 护栏（步长 ±0.05 / 恶化回滚 / 审计）。
- 学到的**模式**（如"该用户常在 React 项目工作，context 里 hooks 相关消息应优先保留"）进 Memory（scope=tuning，§15.2 Layer A），模型召回后影响 buildPrompt 的保留优先级（soft，非强制）。

**里程碑**：L2 起接入（随 EvolutionEngine L2 落地）。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | §8b v1（r9） | 新增「上下文管理」整节：补齐此前 spec 对 context 压缩规格不足的系统性短板。ContextPolicy 契约（provider-kit）+ 三策略全规格化（Sliding L1 / Summary L2 / Semantic v2）+ token 估算三层 + tool 配对保护 + pinned 不可压 + summary untrusted 安全 + preCompact/postCompact 拦截型 hook + 插件 contributePolicy 扩展点 + 失败回退 + 边界清单 + 跨节落地。响应用户需求「补齐上下文管理 + 自动压缩 + hook/插件扩展」。 |
