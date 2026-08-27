> ↩ [返回索引 (README)](./README.md) · 关联章节：[§3 Provider & Router](./03-provider-router.md) · [§6a 插件核心](./06a-plugins-core.md) · [§6b 生命周期](./06b-prompt-composer.md) · [AGENT.md §4.10/§4.12](../../../AGENT.md)

---

# Volund CLI · 插件 Provider 扩展白皮书 (r1)

> **状态**：Approved（2026-08-01）
> **文档类型**：架构决策记录 (ADR) + 扩展规约
> **范围**：`packages/provider-kit` / `packages/router` / `packages/plugin-runtime` / `packages/plugin-sdk` / `VolundBridge.provider`
> **触发**：用户需求——"引入受控的 ProviderRegistry 端口（类似 ToolRegistry），让插件能注册 ProviderClient"

---

## §P1 目标与非目标

### P1.1 目标

1. **受控的 provider 扩展**：允许第三方插件 out-of-tree 注册 `ProviderClient` 实现，填补 volund 扩展性矩阵里唯一的硬缺口（见 [§6.9](./06b-prompt-composer.md) 对比表）。
2. **不破坏一等公民原则**：Rust 沙箱一等公民（§5 / §6.4.3）+ Router 强制（AGENT.md §4.12）+ auth 统一（§4.6）三条红线全部保留；插件 provider 是"在框架内"的扩展，不是"绕过框架"的旁路。
3. **默认看不到 raw key**：凭据由 main 进程注入 HTTP header，插件 provider 子进程拿不到原始 key（签名类降级见 §P5.3，需用户额外确认）。
4. **不自动接管流量**：插件 provider 进 ProviderRegistry 后**不自动**进 Router 候选池；必须用户显式配置（`config.toml` / `@alias`）才参与路由。

### P1.2 非目标（划清边界）

- **不做**：插件 provider 作为默认 provider 而无需高亮确认（v1；v2 评估）。
- **不做**：插件 provider 的 capabilities 运行时变更（注册时锁定，变更需重走信任门）。
- **不做**：插件 provider 之间共享 Router 内部状态（cooldown / retry 计数）——各 provider 独立计数。
- **不做**：stream-over-RPC 通道的 backpressure（专用通道保证不丢，靠子进程 `setrlimit` 兜底 OOM；见 §P4.4）。
- **不承诺**：插件 provider 的 cost/usage 精确对账（接受模型自报，S3 已知限制）。

---

## §P2 与既有约束的张力（决策依据）

### P2.1 vs §6.4.1 "明确不暴露 volund.provider"

**原约束**：`volund.provider` 不存在（插件不能直接调 provider，防绕过 router / cost tracking）。

**张力**：本白皮书**新增** `VolundBridge.provider` 命名空间，让插件**注册** provider。

**消解**：两者语义不同，不冲突——
- 原约束禁止的是"插件**调用** provider.client.stream() 自己发 LLM 请求"（绕过 Router / 不计 cost）。
- 本白皮书允许的是"插件**注册** ProviderClient 实现进 Registry，由 Router/Runner 经标准路径**调用**它"（必经 Router / 计 cost / 受 sticky）。
- 命名空间从"禁止"变"受控开放"：`volund.provider.register(spec)` 是唯一 API，不暴露 `volund.provider.<name>.stream()` 直调入口。
- §6.4.1 表的"明确不暴露"那条改写为"不暴露 provider 直调，但**允许** register（见本白皮书）"。

### P2.2 vs §3.10 "Runner 禁止 import 具体 provider-* 包"

**原约束**：Runner 持有 `RouterPolicy`，不直接持有 `ProviderClient`。

**张力**：插件 provider 是动态注册的 `ProviderClient` 实例，Runner 必须能拿到它。

**消解**：Runner **仍然不 import 具体包**，改为通过 `ProviderRegistry` 拿引用——和 `ToolRegistry` 模式一致。Router 实现从 registry 拿 provider 实例注入 `RouterDecision`。边界修订见 §P11.1。

### P2.3 vs AGENT.md §4.12 "Runner 禁止直接持有 ProviderClient，必须持有 RouterPolicy"

**张力**：同 P2.2。

**消解**：Runner 仍持有 `RouterPolicy`；RouterPolicy 内部从 `ProviderRegistry` 解析 provider 名 → 实例。Runner 不感知来源（核心包 vs 插件）。§4.12 加一句"Router 实现从 ProviderRegistry 拿 ProviderClient 实例；registry 兼纳核心 provider 与插件 provider"。

### P2.4 vs plugin-sdk "运行时零依赖"

**原约束**：`plugin-sdk` 只依赖 `shared`（type-only），运行时零副作用。

**张力**：provider plugin 作者需要 `ProviderClient` / `ProviderChunk` / `ProviderCapabilities` 类型来声明实现。

**消解**：`plugin-sdk` 新增 **type-only** 依赖 `provider-kit`（不引入运行时代码，`import type` 编译消除）。`provider-kit` 本就是纯契约包（§1.2），type-only 依赖不破坏"零运行时副作用"。plugin-sdk re-export 这些类型。

---

## §P3 三大架构决策（用户拍板）

| 决策 | 选择 | 拒绝的方案 | 拒绝理由 |
|---|---|---|---|
| **D1 stream 跑在哪** | **sandbox 子进程 + 专用 stream 通道** | 主进程内加载 / 只支持 complete() | 主进程内破坏隔离一等公民；只支持 complete() 体验降级且仍需定义收协议 |
| **D2 凭据怎么给** | **main 注入 header，插件默认看不到 raw key**（签名类降级，§P5.3） | 插件子进程可读 key / 插件自管凭据 | 前者 S1 凭据外泄风险高；后者绕过 §4.6 verify-first-store-second |
| **D3 怎么进 Router** | **用户显式配置才进，不能 default** | 自动进候选池 / 可设 default | 隐式接管流量违背"可预测"原则；显式配置安全且 DX 可接受 |

---

## §P4 ProviderRegistry 端口（核心新增）

### P4.1 端口定义

放 `packages/provider-kit`（契约归属，对齐 §1.4 "ProviderClient 定义在 provider-kit"）：

```ts
// packages/provider-kit/src/provider-registry.ts
export interface ProviderRegistry {
  /** 注册一个 ProviderClient 实现来源 */
  register(client: ProviderClient, source: ProviderSource, meta: ProviderMeta): Disposable
  /** 按名取实例（Router 用） */
  get(name: string): ProviderClient | undefined
  /** 列全部已注册 provider（Router 候选池构建 / UI model list 用） */
  list(): ReadonlyArray<RegisteredProvider>
}
export type ProviderSource =
  | { kind: 'core' }                                    // 内置 provider-anthropic 等
  | { kind: 'plugin', plugin: string }

export interface ProviderMeta {
  /** manifest 声明的能力快照，注册时冻结，运行时不变 */
  capabilities: Readonly<ProviderCapabilities>
  /** display name（UI） */
  displayName: string
  /** 该 provider 支持的模型列表（静态或 listModels 动态） */
  models?: ModelDescriptor[]
}
export interface RegisteredProvider {
  name: string
  source: ProviderSource
  meta: ProviderMeta
  client: ProviderClient
}
```

### P4.2 注册时机

- **core**：`apps/cli` 启动时按用户已装的 `provider-*` 包注册（走 require.resolve，失败静默）。
- **plugin**：`plugin-runtime` 加载 `kind: 'provider'` 插件、`activate()` 内调 `volund.provider.register(spec)` 时注册。
- **重名拒绝**：`register` 遇同名（含 core 与 plugin 撞名）→ 拒绝 + emit `error.raised { code: 'provider_name_conflict' }`。插件名建议前缀 `plugin-` 避免撞核心（如 `plugin-vllm`）。

### P4.3 ProviderRegistry ≠ ToolRegistry 的关键差异

| 维度 | ToolRegistry | ProviderRegistry |
|---|---|---|
| 注册对象 | 无状态 spec（name + handler 引用） | **有状态 long-lived 实例**（持 HTTP 连接池 / 缓存） |
| 调用方 | Runner 直接调 `tool.invoke` | **Router 先 pick**，Runner 调 Router 返回的实例 |
| 热路径 | tool.invoke 偶发（每 turn 几次） | **stream() 高频（100Hz delta）** |
| 卸载复杂度 | dispose handler 即可 | **必须 graceful dispose**（关连接池 / 等在途 stream） |

差异决定 ProviderRegistry 不能简单复用 ToolRegistry 实现，需独立设计（尤其 dispose 时序，见 §P6 B8）。

### P4.4 专用 stream 通道（不复用普通 event queue）

> 解决 [§6.4.3](./06a-plugins-core.md) 出站 event queue 会 drop 的问题——provider delta **绝对不能 drop**。

**契约**：plugin 子进程内 `ProviderClient.stream()` 返回的 `AsyncIterable<ProviderChunk>`，由 plugin-host 序列化为**独立的 long-lived RPC 流**回 main，**不进** §6.4.3 的有界 event queue（capacity 256 / drop_oldest）。

**协议**（NDJSON 上的 stream 子协议）：
```
main → child:  {"jsonrpc":"2.0","id":7,"method":"volund.provider.stream.open",
                "params":{"providerName":"plugin-vllm","req":{...}}}
child → main:  {"jsonrpc":"2.0","method":"volund.provider.stream.chunk",
                "streamId":"s_7","params":{"chunk":{"kind":"text.delta","text":"H"}}}
child → main:  {"jsonrpc":"2.0","method":"volund.provider.stream.chunk",
                "streamId":"s_7","params":{"chunk":{"kind":"text.delta","text":"i"}}}
...
child → main:  {"jsonrpc":"2.0","method":"volund.provider.stream.end",
                "streamId":"s_7"}                      // 正常结束
                // 或 {"...","method":"volund.provider.stream.error","params":{"err":{...}}}
main → child:  {"jsonrpc":"2.0","method":"volund.provider.stream.abort",
                "streamId":"s_7"}                      // main 端 Ctrl+C / turnAbort
```

- **不丢保证**：main 侧为每个 streamId 维护接收缓冲，`router.switched` / UI throttle 之前**全部缓存**；UI throttle 丢的是显示帧（§7.3），不是 chunk。
- **背压**：若 main 缓冲超过 `max_stream_buffer_bytes`（默认 4 MB，可配）→ main 发 `stream.abort` + 视为 `stream_truncated`（§3.9a）；不无限堆积。这是"异常时显式截断"而非"正常时丢 delta"。
- **延迟**：~1-5ms/chunk（IPC + JSON 序列化）；100Hz 下每秒 ~100-500ms 开销，对交互式 CLI 可接受。
- **abort 传播**：main 收到 `turnAbort` → 发 `stream.abort` → 子进程 ProviderClient 实现必须响应（关 HTTP 连接、停 yield chunk）。

---

## §P5 凭据注入分层（S1 凭据外泄的核心防线）

> 用户选 D2"main 注入，插件看不到 raw key"。但不同 provider 认证方式差异大，无法一刀切。分两层。

### P5.1 manifest 凭据声明

`kind: 'provider'` 插件的 manifest 必须声明 `provider.auth`：

```jsonc
{
  "kind": "provider",
  "provider": {
    "name": "plugin-vllm",                    // ProviderClient.name，建议 plugin- 前缀
    "displayName": "vLLM (local server)",
    "auth": {
      "mode": "header-template",              // "header-template"（默认/推荐）| "signing"
      "credentialScope": "plugin-vllm",       // auth 包的 scope key
      "headerTemplate": "Authorization: Bearer {{key}}",  // mode=header-template 必填
      // 或 mode="signing"：
      "signing": {
        "algorithm": "aws-sigv4",             // 声明签名算法（v1 支持 aws-sigv4 / acs3 / custom）
        "envKeys": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]
                                              // 声明需要哪些 key 进子进程 env
      }
    },
    "models": [                                // 静态模型清单（或实现 listModels 动态）
      { "id": "llama-3.1-70b", "maxContext": 131072 }
    ]
  }
}
```

### P5.2 layer A：header-template 模式（默认/推荐，覆盖 ~90% provider）

**流程**：
1. 用户 `volund login plugin-vllm --api-key-stdin` → key 进 auth（keychain / enc / env），scope = `plugin-vllm`。
2. Router 决定用 `plugin-vllm` → Runner 取 registry 实例 → 调 `stream(req)`。
3. **main 进程**在调子进程 `provider.stream.open` 前，先 `auth.getCredential('plugin-vllm')` 拿 raw key → 按 `headerTemplate` 渲染（`{{key}}` 替换）→ 把**渲染后的 header** 放进 RPC `req.authHeaders` 传给子进程。
4. 子进程内 ProviderClient 实现收到 `req.authHeaders`，直接塞进 fetch header，**全程不接触 raw key**。
5. raw key **绝不**出现在 RPC params / 子进程 env / 子进程日志 / telemetry。

**强制**：ESLint + code review 守"main 才能读 raw key"；子进程内 ProviderClient 代码拿不到 `auth` bridge 的 getCredential（`volund.auth` 不对 provider plugin 暴露 raw 读取，见 §P7.1）。

### P5.3 layer B：signing 模式（SigV4 / ACS3 / 自定义，降级口子）

**为什么需要**：AWS SigV4 要用 secret key 对**每个请求的 body + headers + timestamp** 算 HMAC 签名。main 不知道插件想用什么 region / service / 自定义签名规则，无法代签。

**流程**：
1. 用户 `volund login plugin-vllm --signing` → main 把 secret 存 auth。
2. 每次 stream 前，main 把 `envKeys` 声明的 key 注入子进程**临时 env**（**不落 dataDir**，子进程退出即消失）。
3. 子进程内 ProviderClient 实现 `signing` 算法，读 env key 签名后发请求。
4. **插件可见 key**（在子进程 env）—— S1 残留。

**降级保护**：
- manifest 声明 `mode: 'signing'` 时，**首次注册信任门文案升级**：
  > ⚠️⚠️ This provider plugin uses request signing. Your API secret **will be injected into the plugin's process memory** to sign each request. The plugin author can read it. Install only if you fully trust the author, or if the signing algorithm is open-source and you've audited it.
- signing 类插件的 sandbox profile **额外禁** `fs.write`（除 dataDir 外）/ `net`（除声明 endpoint 外）—— 即便拿到 key 也难外传。
- telemetry 强制记 `provider.signing.key_injected { plugin, algorithm }`（本地，每次注入）。
- 子进程退出时 main 主动 `kill -9` 确保 env 不残留（虽子进程退出 env 自然消失，双保险）。

**用户决策点**：若你认为 signing 类这个降级口子不可接受（宁可不支持 AWS/阿里云 类 provider 也要 key 绝不进插件），告诉我删掉 §P5.3，只做 header-template。我按"两层"写是因为不支持 SigV4 会挡掉 Bedrock/Vertex/阿里通义等主流场景，但这是你的风险偏好决定。

### P5.4 auth bridge 对 provider plugin 的受控暴露

`VolundBridge` 新增 `auth`（**只读、scope 限定、不暴露 raw key**）：

```ts
volund.auth: {
  /** 取已渲染的 auth header（仅 header-template 模式有效；main 已代填 {{key}}） */
  getAuthHeaders(providerName: string): Promise<Record<string, string>>
  /** signing 模式下，子进程 env 里已有 key（见 §P5.3）；本方法返回声明清单，不返回值 */
  getSigningEnvKeys(providerName: string): string[]
}
```

- **不暴露** `auth.getCredential` 的 raw 返回（S1 防线）。
- header-template 模式：`getAuthHeaders` 返回 main 已渲染好的 header，插件直接用。
- signing 模式：插件从 `process.env` 读 `getSigningEnvKeys()` 列出的 key（main 已注入）。

---

## §P6 边界情况处置（B1-B8）

| # | 边界情况 | 处置（写入 spec 位置） |
|---|---|---|
| B1 | sticky provider + 插件 disable | §6.11.2 加 L8：`kind:'provider'` 插件 disable/卸载**延迟到 turn 边界**（`turn.completed/aborted` 后才真卸载）；进行中 turn 的 sticky 锁定该 provider 时不允许 disable |
| B2 | 插件子进程崩溃 mid-stream | §3.9a 已覆盖（`stream.error` → `stream_truncated`）；sticky 期间崩溃**不自动 fallback**，只 give-up；telemetry 标 `provider.plugin.crashed_mid_stream` |
| B3 | `streaming: false` provider | 允许；main 用 `complete()` 收集后转 single chunk 流；capabilities 注册时锁定；UI 标"non-streaming" |
| B4 | countTokens / listModels 缺失 | countTokens 缺 → tiktoken 近似（§3.2 已有）；listModels 缺 → UI 不列模型，用户用 `@<alias>` 显式 |
| B5 | maxContextTokens 谎报 | 不强制验证（自伤型）；docs 标注"capabilities 是声明值"；telemetry 记实际 context_length 错误率 |
| B6 | Router 核心切插件 mid-turn | sticky 约束（§3.7.1）覆盖：tool_use 在途禁切；插件 provider 要么承接完整 turn，要么不参与 |
| B7 | rawMeta 命名空间 | 插件 provider 只读 `rawMeta.<provider-name>`；核心 rawMeta（anthropic/openai/gemini/ollama）对它不透明（§3.4 规则延伸） |
| B8 | dispose 时机 | §P4.3 + AGENT.md §4.10.1：registry 持 Disposable；disable 时序 = (1) 标记不再路由到它 → (2) 等在途 stream 结束或 5s 超时 abort → (3) 调 `client.dispose()` → (4) SIGTERM/SIGKILL 子进程 |

---

## §P7 VolundBridge.provider 命名空间（新增 API）

```ts
// §6.4.1 VolundBridge 表新增
volund.provider: {
  /**
   * 注册一个 ProviderClient 实现。
   * @param spec.providerName  ProviderClient.name（建议 plugin- 前缀）
   * @param spec.client        ProviderClient 实例（由 plugin-host 在子进程内构造为 RPC 代理）
   * @param spec.capabilities  注册时冻结的能力快照
   * @param spec.models        静态模型清单（可选；缺则调 client.listModels 动态）
   * @returns Disposable       卸载时反注册
   */
  register(spec: ProviderPluginSpec): Disposable
}

interface ProviderPluginSpec {
  providerName: string
  client: ProviderClient                    // 子进程内：RPC 代理；main 侧：RPC 服务端转发
  capabilities: ProviderCapabilities
  models?: ModelDescriptor[]
  displayName?: string
}
```

- **唯一入口**：只有 `register`，没有 `stream / complete / getCredential` 直调（防插件自己发请求绕 Router）。
- **Disposable**：disable/卸载时反注册（时序见 B8）。
- **capabilities 冻结**：register 后 `meta.capabilities` 不可变；插件想改 = 反注册 + 重新 register + 重走信任门。

---

## §P8 manifest `kind: 'provider'`（特殊插件类别）

```jsonc
{
  "kind": "provider",                        // ★ 触发 provider plugin 装载路径
  "name": "volund-plugin-provider-vllm",
  "version": "1.0.0",
  "engines": { "volund": "^1.0.0" },
  "main": "index.js",
  "type": "module",

  "provider": {                              // §P5.1 的 provider 段
    "name": "plugin-vllm",
    "displayName": "vLLM (local server)",
    "auth": { "mode": "header-template", "credentialScope": "plugin-vllm",
              "headerTemplate": "Authorization: Bearer {{key}}" },
    "models": [{ "id": "llama-3.1-70b", "maxContext": 131072 }]
  },

  "permissions": {
    "net": { "allowlist": ["localhost:8000", "vllm.example.internal:8000"] },
                                              // ★ provider plugin 必须声明 net 白名单
    "volund": ["provider.register", "auth.getAuthHeaders", "log"]
                                              // ★ 必含 provider.register + auth.getAuthHeaders
  }
}
```

**特殊约束（vs 普通 plugin）**：
- `kind: 'provider'` → 装载路径走 `plugin-runtime` 的 provider 分支（先校验 manifest.provider schema → 再 activate）。
- **net 权限必需**：provider 不发网就不是 provider；manifest 无 `permissions.net.allowlist` → 拒绝加载。
- **信任门文案升级**（比普通 plugin 严）：
  > ⚠️ This plugin wants to act as a **model provider**. Once enabled, it can request to handle your conversations. It will see your prompts and code. The author declares auth mode: `<header-template|signing>`. Install only if you trust the author.
  - signing 模式额外加 §P5.3 的 ⚠️⚠️ 文案。
- **capabilities 注册校验**：`ProviderCapabilities` 必填字段缺失（maxContextTokens / toolUse / streaming 等）→ 拒绝注册。
- **model id 冲突**：插件的 model id 与核心 provider 撞名 → 拒绝（建议插件 model id 加 provider 前缀，如 `plugin-vllm/llama-3.1-70b`）。

---

## §P9 Router 集成（D3：显式配置才进）

### P9.1 不自动进候选池

插件 provider 进 ProviderRegistry 后，**不**自动出现在任何 RouterPolicy 的候选列表。核心 provider（anthropic/openai/...）是默认候选；插件 provider 必须**用户显式配置**：

```toml
# ~/.volund/config.toml
[router]
type = "fallback"                             # 或 single / role

# 方式 A：作为 fallback 候选
[[router.chain]]
provider = "plugin-vllm"
model = "llama-3.1-70b"
priority = 10                                 # 低于核心 provider

# 方式 B：role 路由
[router.roles.coder]
provider = "plugin-vllm"
model = "llama-3.1-70b"
```

或运行时 `@plugin-vllm/llama-3.1-70b 帮我...`（`@alias` 显式调用，§3.9）。

### P9.2 不能设为 default（v1）

- `volund model use plugin-vllm/llama-3.1-70b`（设默认）→ **v1 拒绝** + 提示"插件 provider 不能设为默认（v1），可用 `@alias` 单次调用或 config fallback"。
- v2 评估放开（届时加高亮确认）。
- 理由：default provider 隐式接管**所有**对话流量，是最高风险位置；v1 先让插件 provider 只在显式调用 / fallback 链尾出现。

### P9.3 Router 实现义务

- `SingleProviderRouter`：`pick` 时若 `hint.explicitModel` 指向插件 provider → 从 registry 取实例；否则用构造时注入的核心 provider。
- `FallbackRouter`：候选链构建时，从 config 读 plugin provider 名 → registry 解析；registry 无此名 → 配置错误报错（不静默跳过）。
- `RoleRouter`：role 映射的 provider 名经 registry 解析。
- 所有 Router 实现**必须**通过 registry 拿实例，不直接 import 插件包（§3.10 修订）。

---

## §P10 安全风险汇总（S1-S5 + 处置）

| # | 风险 | 处置 | 残留 |
|---|---|---|---|
| S1 凭据外泄 | header-template 模式 main 注入,插件看不到 raw key;signing 模式降级+严信任门+sandbox 禁 fs.write/net 白名单 | header-template 基本消除;**signing 残留**（用户选 D2 时的固有限制） |
| S2 prompt/代码外泄 | 信任门高亮告知"会看到所有 prompt";untrusted 包裹(§6.5.0a)仍适用;docs 治理页说明 | **固有**,不可消除（核心 provider 也一样） |
| S3 cost 谎报 | L1-L3 无 CostAwareRouter 影响有限;v2 起可对账(响应大小估算,不精确) | **接受为已知限制** |
| S4 降级攻击 | capabilities 注册锁定;telemetry 记实际行为;自伤型用户自卸载 | 低 |
| S5 net 权限扩大 | `kind:'provider'` 是特殊类别,net 必需但走白名单(`permissions.net.allowlist`);非 provider 插件仍默认 net=false | 中（已最小化） |

---

## §P11 §1 / §3 / §6 差量（落地变更）

### P11.1 §3.10 边界修订

| 原文 | 改为 |
|---|---|
| `Runner` 禁止 import 任何具体 `provider-*` 包 | `Runner` 禁止 import 任何具体 `provider-*` 包；**通过 `ProviderRegistry` 拿 `ProviderClient` 引用**（registry 兼纳核心与插件 provider） |
| `Runner` 只持有 `RouterPolicy` 引用，不直接持有 `ProviderClient` | `Runner` 只持有 `RouterPolicy`；RouterPolicy 从 `ProviderRegistry` 解析 provider 名→实例（Runner 仍不直接持 ProviderClient） |

### P11.2 §6.4.1 VolundBridge 新增 provider 命名空间

表末追加 `provider` 行（API 见 §P7），并把"明确不暴露"段 `volund.provider` 那条改为：
> - `volund.provider` 的**直调入口**（如 `stream`/`complete`/`getCredential`）不暴露；**仅** `volund.provider.register(spec)` 受控开放（见 [PLUGIN-PROVIDER-r1](./PLUGIN-PROVIDER-r1.md)）

### P11.3 §6.7 差量补

- **`packages/provider-kit`** 责任扩充：新增 `ProviderRegistry` 端口定义。
- **`packages/router`** 责任扩充：RouterPolicy 实现从 `ProviderRegistry` 解析 provider。
- **`packages/plugin-runtime`** 责任扩充：`kind:'provider'` 装载分支（manifest.provider 校验 + capabilities 冻结 + 专用 stream RPC 通道）。
- **`packages/plugin-sdk`** 依赖扩充：**新增 `provider-kit` type-only 依赖**（re-export ProviderClient/ProviderChunk/ProviderCapabilities 类型），仍运行时零副作用。
- **`apps/cli`** 装配：启动时实例化 `ProviderRegistry`，注册核心 provider，注入 Router + Runner。

### P11.4 §1.2 依赖表补

| 包 | 允许依赖（新增/修订） |
|---|---|
| **provider-kit** | shared（+ 新增 ProviderRegistry 端口，仍纯契约） |
| **router** | provider-kit / shared（**+ 运行时从 ProviderRegistry 取实例**） |
| **plugin-sdk** | shared（type-only）**+ provider-kit（type-only）** |
| **plugin-runtime** | （已有）**+ provider-kit（type-only，provider 装载分支）** |

### P11.5 AGENT.md / CLAUDE.md 修订

- AGENT.md §4.10.1 Plugin 硬约束：新增"`kind:'provider'` 例外"小段（manifest 声明 / 信任门升级 / net 必需 / 凭据注入分层 / 不能 default）。
- AGENT.md §4.12 Router 强制：补"Router 实现从 ProviderRegistry 拿 ProviderClient 实例；registry 兼纳核心与插件 provider"。
- CLAUDE.md §C4 禁令：原"禁止暴露 `volund.provider`"改写为"禁止暴露 provider **直调**入口；`volund.provider.register` 受控开放（见 PLUGIN-PROVIDER-r1）"。

---

## §P12 里程碑（r9 调整：header-template 提前到 L3）

> **r9 决策**：header-template 模式从「整体归 v2」提前到 **L3**（随 plugin-runtime L3 上线）。理由：开源 CLI 的差异化卖点正是「非四大厂 provider」（vLLM / DeepSeek / 自托管），若 L1-L4 阶段对这类 provider 无解，会流失核心用户。header-template 覆盖 ~90% provider 场景（[§P5.2](#p52-layer-a-header-template-模式默认推荐覆盖-90-provider)），实现成本可控（plugin-runtime L3 已在跑，provider 装载分支复用同一进程模型）。signing 模式（SigV4/ACS3）仍推 v2（触及凭据注入降级口子，需更严审计）。

**分里程碑落地**：

- **L3（header-template，r9 提前）**：
  - ProviderRegistry 端口（[§P4](#p4-providerregistry-端口核心新增)）
  - header-template 凭据注入（[§P5.2](#p52-layer-a-header-template-模式默认推荐覆盖-90-provider)，main 注入渲染后 header，插件看不到 raw key）
  - `@alias` 显式调用（[§P9.1](#p91-不自动进候选池)，不自动进 Router 候选池）
  - sandbox 子进程专用 stream 通道（[§P4.4](#p44-专用-stream-通道不复用普通-event-queue)）
  - manifest `kind: 'provider'` 装载分支（[§P8](#p8-manifest-kindprovider特殊插件类别)）
  - **参考实现**：至少 1 个 header-template provider plugin（如 plugin-vllm 或 plugin-deepseek）随 L3 发版，验证端到端流程
- **v2-β（signing 模式）**：SigV4 / ACS3 签名 + 凭据注入降级口子（[§P5.3](#p53-layer-b-signing-模式sigv4--acs3--自定义降级口子)）+ capabilities 动态 listModels + Router fallback/role 集成
- **v2-GA**：docs 治理页"如何写 provider plugin"完整指南 + signing 参考实现（plugin-bedrock / plugin-vertex）+ 安全审计

**对 §6.10 / §10 的影响**：plugin-runtime 在 §10 L3 已上线（`plugin-runtime + plugin-sdk 发 npm`）；本节补充 L3 含 provider-plugin（header-template）子项。§6.10 插件里程碑映射表的 plugin-L1/L2/L3 不变，仅 L3 条目补注「含 provider-plugin（header-template 模式）」。

---

## §P13 边界与安全清单（强制点）

| 规则 | 强制点 |
|---|---|
| 插件 provider **必须**经 `volund.provider.register` 进 Registry，禁止任何直调 stream/complete 的旁路 | plugin-runtime RPC dispatch 白名单 |
| 插件 provider **必须**经 Router 才能被调用（Runner 不直持插件 ProviderClient） | core 单元测试 |
| header-template 模式下 raw key **绝不**进 RPC params / 子进程 env / 日志 / telemetry | ESLint + 单元测试（assert 子进程拿不到 raw key） |
| signing 模式 key 进子进程 env **必须**临时（不落 dataDir）+ 子进程退出 kill -9 | plugin-runtime 生命周期 + 单元测试 |
| `kind:'provider'` 插件 **必须**声明 `permissions.net.allowlist`，否则拒绝加载 | manifest schema 校验 |
| capabilities 注册时冻结，运行时变更 **必须**反注册 + 重走信任门 | ProviderRegistry 单元测试 |
| 插件 provider disable **必须**延迟到 turn 边界（sticky 锁定期不卸载） | plugin-runtime + core 集成测试 |
| 插件 provider dispose **必须** graceful（等在途 stream / 5s 超时 abort） | plugin-runtime 单元测试 |
| 专用 stream 通道 **不**复用普通 event queue，**不丢** chunk（超 buffer 显式 stream_truncated） | plugin-runtime 集成测试 |
| 插件 provider **不能**设为 default（v1） | `volund model use` 校验 |
| 插件 provider 的 rawMeta **只**读自己命名空间 | provider-kit 类型约束 + 单元测试 |
| 信任门文案对 provider plugin **必须**升级（含 auth mode 披露） | plugin-runtime + UI 集成测试 |
| telemetry `provider.signing.key_injected`（signing 模式每次注入）**必须**本地写 | plugin-runtime + telemetry assertion |

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | r1 | 初稿：用户需求"引入受控 ProviderRegistry 端点，让插件注册 ProviderClient"。三大决策（用户拍板）：D1 sandbox 子进程 + 专用 stream 通道 / D2 main 注入凭据（header-template 默认 + signing 降级）/ D3 显式配置才进 Router 不能 default。13 节：目标/张力消解/Registry 端口/stream-over-RPC/凭据分层/VolundBridge.provider/manifest kind/边界B1-B8/风险S1-S5/Router集成/§1§3§6差量/里程碑(v2)/清单。逆转 §6.4.1 "不暴露 volund.provider" 与 §3.10 "Runner 禁 import provider-*" 两条原绝对约束为"受控开放"。归 v2 候选里程碑。 |
