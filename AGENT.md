# AGENT.md — Apollo Code 工程约定

> 面向所有在本仓库工作的 Agent（Claude Code / Copilot / Cursor / Codex / 人类）。CLAUDE.md 是本文件的镜像 + Claude 特化补充。

## 1. 项目定位

Apollo Code 是 claude-code 的开源平行实现：一个多模型后端的终端 AI 编码 CLI。
不绑定任何 LLM 厂商，Provider 插件化，Rust 承担性能与安全敏感的部分（沙箱、搜索、AST），其余全部 TypeScript + Node ≥ 20。

### 1.1 一等公民架构（不可动摇）

1. **Rust 沙箱是安全基座** —— 所有执行第三方 / 用户 / 未审计代码的路径**默认**走 `apollo-sandbox` 独立进程 + 平台原生 syscall 隔离（macOS sandbox-exec / Linux landlock+seccomp / Windows AppContainer）。Bash 工具与 Plugin 宿主**共用**同一套框架（`exec` 模式与 `--run-plugin` 模式），TS 侧禁止自建 sandbox（`node:vm` / `worker_threads` / 直接 spawn）。绕过 = 破坏项目信任模型。详见 §4.7 + spec §5 / §6.4.3。
2. **TypeScript 是开发效率基座** —— 业务、编排、事件流、UI 全部 TS + Node ≥ 20。Rust **不做**编排、**不做**业务；只暴露原语（`exec` / `runPlugin` / `search` / `diff` / `countTokens`），单点通过 `packages/native-bridge` 出入。任何 TS 包（除 `native-bridge` 与 `auth` 的 keyring 特例）**禁止**直接依赖 `.node` addon 或 `crates/*` 产物。

违反其一 = 架构 breach。

## 2. 技术栈基线

| 领域 | 选型 |
|---|---|
| 主开发语言 | TypeScript（strict）+ Node ≥ 20 |
| 性能/安全内核 | Rust（napi-rs addon + 独立二进制） |
| 包管理 | pnpm workspace + turborepo |
| 构建 | rolldown（业务 bundle）+ Vite 8（docs / playground dev server） |
| 终端 UI | Ink（React for CLI） |
| 存储 | JSONL（会话）+ toml（配置），无 SQLite |
| 分发 | npm 包 + 单文件二进制（Node SEA / bun compile）并行 |

## 3. 依赖版本策略

- **所有依赖使用最新稳定版**。新加依赖时用 `pnpm add pkg@latest`，禁止手动锁旧版本。
- **共享依赖走 pnpm catalog**：`pnpm-workspace.yaml` 里声明 `catalog:` 版本，所有子包用 `"react": "catalog:"` 引用，保证跨包一致。
- **Renovate/Dependabot 每周自动 PR**，minor/patch 自动合并，major 手动 review。
- **peerDependencies 用宽松范围**（`^` 而非固定版），devDependencies 用精确 catalog 版。
- **禁止直接 `npm install`**，只用 pnpm。禁止 `--force`。

## 4. Monorepo 边界规则（强约束）

### 4.1 依赖倒置原则

`packages/core` **仅依赖契约（kits）**，不依赖任何子系统实现。UI / storage / telemetry / hooks **反向订阅** core 的事件与注册表。

```
apps/cli   ← 唯一 "什么都知道" 的组装层
   │
   ├──→ core           （依赖：provider-kit + tool-kit + shared）
   │
   ├──→ router         （依赖：provider-kit + shared）
   │
   ├──→ provider-kit   （依赖：shared 仅） ★ kit 是纯契约
   ├──→ tool-kit       （依赖：permission + shared）
   ├──→ context        （依赖：provider-kit + shared） ★ ContextPolicy 属于 provider-kit
   │
   ├──→ provider-*     （依赖：provider-kit + http-kit + auth + shared）
   ├──→ tools          （依赖：tool-kit + native-bridge + subagent + shared）
   ├──→ subagent       （依赖：core + provider-kit + tool-kit + shared；接受 RunnerFactory 注入）
   ├──→ mcp-client     （依赖：tool-kit + shared）
   ├──→ plugin-runtime （依赖：tool-kit + permission + hooks + native-bridge + shared）
   ├──→ skills-runtime （依赖：core[type-only] + shared）  ★ 向 PromptComposer 注册 contributor，见 spec §6.7
   ├──→ memory-runtime （依赖：core[type-only] + permission + hooks + native-bridge + shared）
   │
   ├──→ ui             （订阅 core 事件 + 提供 permission prompt handler；依赖：core / permission[type-only] / shared）
   ├──→ storage        （订阅 core 事件；依赖：core[type-only] + shared）
   ├──→ telemetry      （订阅 core 事件；依赖：core[type-only] + shared）
   ├──→ hooks          （通过 core.HookRegistry 注册；依赖：core[type-only] + shared）
   │
   ├──→ auth           （依赖：native-bridge + shared）
   ├──→ http-kit       （依赖：shared）
   ├──→ permission     （依赖：shared；暴露 setPromptHandler 端口）
   └──→ native-bridge  （依赖：shared；运行时 dynamic require platform packages）
                            │
                            ▼
                         shared          ← 所有包地基，零依赖
```

**Type-only 约定**：标注 `[type-only]` 的依赖必须用 `import type { X } from '@apollo-code/core'` 形式，tsc 编译时消除，运行时零引入。ESLint 规则 `import/consistent-type-specifier-style` + `import/no-unresolved` 联合把关。

**具体规则**：
- `apps/*` 只能依赖 `packages/*`，不能反向。
- **`packages/core` 禁止 import**：ui / storage / telemetry / hooks / mcp-client / plugin-runtime / skills-runtime / subagent / 任何 provider-\* / 任何具体 tool。
- **兄弟包禁止横向 import**：例如 `provider-openai` 不能 import `provider-anthropic`；`tools` 不能 import `hooks`。
- Provider 实现包只允许 import `provider-kit` + `shared`。
- Tool 实现包只允许 import `tool-kit` + `native-bridge` + `subagent`（限于 Task tool）+ `shared`。
- 所有横切能力（auth / http-kit / permission / context / native-bridge）**只暴露给主动调用方**，不允许反向依赖。
- 违反通过 `eslint-plugin-import` 的 `no-restricted-paths` 规则在 CI 阻断。

### 4.2 契约定义归属

抽象接口的**唯一定义位置**（避免同名类型多处定义）：

| 抽象 | 定义位置 |
|---|---|
| Message / ContentPart / Attachment / Usage | `provider-kit` |
| ProviderClient / ProviderCapabilities | `provider-kit` |
| **ContextPolicy**（属于消息概念域） | `provider-kit` |
| RouterPolicy / RouterDecision | `router` |
| Tool / ToolRegistry / ToolResult / ToolResultMeta | `tool-kit` |
| Runner / SessionState / EventBus / HookRegistry | `core` |
| PermissionSpec / PermissionRequest / PermissionDecision | `permission` |
| ApolloError / Logger / Config schema (zod) | `shared` |

其他包**只消费不重定义**。

### 4.3 Rust 单点接入

- **所有 Rust 能力必须通过 `packages/native-bridge` 暴露**，其他 TS 包禁止直接 import `.node` 文件或 `crates/*` 产物。
- `native-bridge` 必须提供纯 JS fallback：Rust addon 加载失败（不支持的平台/架构）时降级到 JS 实现，保证 CLI 可用。
- 唯一例外：`packages/auth` 可以 import `@napi-rs/keyring`（属于 native 依赖但不是 apollo 自研 crate）。

### 4.4 单入口原则

- 仓库只有 **一个 bin**：`apps/cli`（命令名 `apollo`）。
- 所有 `packages/*` 的 `package.json` **禁止声明 `bin` 字段**。
- 内部 CLI 工具（脚本、代码生成）走 `pnpm -w run <script>`，不产生 bin。
- **`apps/docs` 强制 `"private": true`**，不发布到 npm；只做 GitHub Pages / Vercel 部署。CI 中的 release job 必须跳过 apps/docs。

### 4.5 Provider / Tool 隔离

- Core 层不 import 任何具体 provider 或具体 tool，全部通过注册表拿。
- 用户按需装：`apollo install-provider openai`，未装的 provider 不进 bundle。
- Provider 的原生请求/响应类型**不允许泄漏到 core**，必须在 provider 包内完成到 provider-kit 定义的内部 Message 的转换。
- Provider 必须声明 `ProviderCapabilities`（是否支持 toolUse / vision / thinking / streaming / parallel tool calls / max context tokens 等）。Core 根据 capabilities 降级（如无 tool_use 时 fallback 到 ReAct prompt）。

### 4.6 认证与网络

- 所有 provider **禁止**直接读环境变量或从 config 明文取 key，必须通过 `packages/auth` 的 `getCredential(providerId)`。
- Auth 实现四级 fallback：**OS keychain → 加密文件（AES-256-GCM，主密码派生）→ 环境变量 → 用户级 config `[auth] <provider>_api_key`**（显式 opt-in 明文 key；项目级 config forbidden）。`[auth] skipAuth = true`（仅用户级 config）完全跳过凭据解析，请求不带凭据头（企业网关/本地代理场景，配合 `provider.<name>.baseUrl`）。
- `apollo login <provider>` 遵循 **verify-first-store-second**：先调 provider 的最小验证接口（如 `/v1/models`），2xx + body schema 合法**才**写 auth；4xx / 5xx **不落盘**。`--skip-verify` 需 `--dangerous`。
- MCP transport 凭据也走 auth，`mcp.toml` 里只留 `keyref://mcp.<name>.<field>` 占位；发现老配置里的明文凭据必须一次性迁移。
- 所有 HTTPS 请求**必须**通过 `packages/http-kit` 提供的 fetch，不允许直接用 `undici` / global fetch。理由：统一 proxy / CA / retry / tracing / rate limit。
- **auth 事件上报（本地 telemetry，见 spec §8.4.1）**：
  - `auth` 包内每一条 login / verify / store / getCredential / keychain error / encfile unlock / migration / logout 分支**必须**发对应事件（见 spec §8.4.1 事件表）。
  - Payload **必须**过 `packages/shared.sanitize()`：禁止任何 raw key / token / passphrase / OAuth code / Authorization header / URL userinfo 入日志。
  - Sink 默认本地 `~/.apollo/telemetry/*.jsonl`（§4.13），**禁止**自动出网。
  - 用途：后期用户可 `apollo telemetry export` 导出诊断 / 反馈；OTel opt-in 用户走 §4.13 显式配置上报。

### 4.7 权限与副作用（Rust 沙箱 = 一等公民）

**核心心智**：Rust 沙箱（`apollo-sandbox` 独立二进制）是本项目**一等公民架构决策**，与 TS 开发效率同为立项前提。凡涉及执行第三方代码 / 用户命令 / 未审计脚本的路径，**默认**都走 sandbox，不搞例外。这条规则一旦被绕过，就等于**整个信任模型都失效**。

**权限决策链**：任何**写文件、跑命令、发网络请求**的代码路径必须经过 `packages/permission` 决策。工具实现禁止直接调 `fs.writeFile` / `child_process.spawn`，必须调 `permission.requestAndExecute(...)`。

**Rust 沙箱适用范围（v3 修正后）**：

| 场景 | 执行方式 | 一等公民规则 |
|---|---|---|
| **Bash 工具** | `apollo-sandbox exec` 独立进程 | 不允许 Node 直接 `spawn('/bin/sh')` |
| **Plugin 宿主** | `apollo-sandbox --run-plugin` 独立进程 + JSON-RPC bridge | 不允许 `node:vm` / `worker_threads` / plugin-runtime 内部 `spawn(node)` |
| **MCP stdio server** | 走 permission（v2 起考虑同样纳入 sandbox） | 用户信任 MCP 装载，v1 允许直连 |
| **Hook shell 脚本** | 用户自己的机器权限（用户 hook 是显式副作用契约） | 不纳入 sandbox，但要记 telemetry |

**平台机制**：macOS `sandbox-exec` + sbpl / Linux `landlock` + `seccomp` / Windows AppContainer（v2）。sandbox profile 由 `packages/native-bridge` 从 `PermissionSpec`（Bash）或 `manifest.permissions`（Plugin）**单向映射**生成，Rust 侧只见最终 profile-json，**不解析** shell 也**不解析** JS。

**降级策略**：
- Kernel 不支持 landlock / Windows 无 AppContainer → 副作用工具 + 插件系统**默认拒绝执行**，用户可 `--dangerously-no-sandbox` 覆盖（触发 UI 红条 + `security.event` telemetry）
- sandbox binary 缺失 → 同上

**MVP 例外（收敛清单）**：sandbox 未接入前，允许工具直连 `spawn`，但需在代码里加 `// TODO(sandbox)` 标记，CI 统计数量以监控收敛。**插件系统不享受此例外**：sandbox 未 ready 前插件系统不开门（见 spec §6.10 依赖 §5.9-L2）。

**永远禁止**：
- 在 `plugin-runtime` 用 `node:vm` / `worker_threads` 或直接 `child_process.spawn(node)` 跑插件
- 在业务代码里手动生成 sandbox profile（必须通过 `native-bridge`）
- 用 sandbox profile 放宽 `PermissionSpec` 已声明的权限（Rust 侧单元测试兜底）

### 4.8 多模态与附件

- 内部 Message.content 从第一天起就是 `ContentPart[]` 联合类型：`text / image / file / tool_use / tool_result / thinking`。
- 附件读入后**不内联进 core 事件流**（避免大对象在事件总线里传递），改传 `Attachment` 引用 + `native-bridge` 提供的懒加载 handle。
- Provider 各自决定如何序列化附件到自家 API（base64 内联 / 上传 / 引用）。

### 4.9 上下文与成本

- 每个 provider 响应必须返回 `usage: { input, output, cache_read?, cache_write? }` 和 `cost?: number`。
- 累计成本由 `core.SessionState` 维护，`telemetry` 订阅并写盘，`ui` 订阅并渲染底栏。
- 上下文压缩由 `ContextPolicy` 接口负责，默认策略由 `packages/context` 提供（sliding + summary），可替换。

### 4.10 Skill / Plugin 严格分工

- **Skill** = Prompt + 资源。**不执行代码**。放在 `~/.apollo/skills/<name>/SKILL.md`，frontmatter 声明 `apolloVersion: ^1.0.0`。由 `skills-runtime` 装载。
- **Plugin** = 代码（tools / slash commands / hooks / prompt fragments）。放在 `~/.apollo/plugins/<name>/`，必须有 `manifest.json` 声明 `engines.apollo: ^1.0.0` + 所需权限。由 `plugin-runtime` 装载。
- 版本不匹配：Skill 警告继续，Plugin 拒绝加载。
- 二者**不共享目录、不共享装载器、不共享类型**。

#### 4.10.1 Plugin 硬约束（细则）

- **语言**：插件运行时**只接受 JS（ESM）**，作者可用 TS 但必须自行编译。禁止在 `plugin-runtime` 里跑 TS 编译器。
- **形态**：MVP 只支持**单文件 `index.js` bundle**（作者用 esbuild/tsdown 打包所有依赖）。不允许运行时 npm install / 拉取 node_modules。
- **JSBridge**：插件唯一入口是 `activate(apollo)`。`apollo` 对象由 `plugin-host.mjs` 构造为 JSON-RPC 客户端代理，是插件访问 apollo 能力的**唯一途径**。禁止扩展 bridge 之外的旁路 API。
- **沙箱（v3 修正后：一等公民 Rust 沙箱）**：
  - 插件**不跑在** apollo 主进程内。plugin-runtime 通过 `native-bridge.runPlugin()` 启动 `apollo-sandbox --run-plugin` 独立 Node 子进程，走 JSON-RPC 2.0 over NDJSON (fd 3) 与主进程通信。
  - **禁止** `node:vm` / `worker_threads` / plugin-runtime 内部直接 `child_process.spawn(node)`。
  - sandbox profile 由 `native-bridge` 从 `manifest.permissions` 生成：`pluginDir` 只读 / `dataDir` 读写 / `net` 白名单 / clear_env + 最小白名单；额外禁 `ptrace` / `mmap w+x`。
  - AST 静态检查（禁 `eval` / `new Function` / 顶层 `process` 引用）保留，但**降级为作者友好检查**——真正的隔离靠 Rust sandbox + RPC 白名单 + manifest 三层，不再是 AST 单靠。
- **权限**：manifest.json 的 `permissions.apollo` 是 **RPC method** 白名单（未声明的 method 直接 `-32601 Method not found`）；`permissions.fs/bash/net` 是资源级白名单。所有敏感操作通过 bridge RPC 转发到 `permission` 决策，敏感副作用（`apollo.exec`）再套内层 `apollo-sandbox exec`。
- **首次装载**：必须弹权限确认对话框，展示 `contributes` + `permissions`。用户批准后写入 `~/.apollo/plugins.enabled.toml` 记住权限 hash。
- **升级权限扩容**：任何 `permissions` 变化 → 必须再次弹窗确认。禁止静默继承旧批准。
- **能力边界（红线）**：插件**禁止**通过任何手段：
  - 直接访问 `ProviderClient` / 内部 Router / Runner（`apollo.core` 不存在）
  - 直接访问 `native-bridge` / Rust 原生（`apollo.native` 不存在）
  - 读写其它插件的 storage / 引用其它插件对象（每插件独立子进程 + 独立 `dataDir`，物理隔离）
  - 修改 `SessionState`（`apollo.session` 走 RPC 序列化，天然只读快照）

#### 4.10.1a Provider Plugin 例外（`kind: 'provider'`）

> 详见 spec [PLUGIN-PROVIDER-r1](./docs/superpowers/specs/2026-07-31-apollo-code-design/PLUGIN-PROVIDER-r1.md)。普通插件**不能**扩展 Provider；只有 `kind: 'provider'` 特殊插件类别可以，且受最严约束：

- **唯一入口**：`apollo.provider.register(spec)` 注册 `ProviderClient` 实现进 `ProviderRegistry`；**不暴露** provider 直调入口（`stream` / `complete` / `getCredential`）—— 调用必经 Router。
- **manifest `kind: 'provider'`**：声明 `provider.auth`（header-template 默认 / signing 降级）+ `permissions.net.allowlist`（net 必需）+ capabilities 注册时冻结。
- **凭据注入分层**（S1 防线）：
  - **header-template 模式**（推荐，~90% provider）：main 进程读 key → 渲染 header → 传渲染后 header 给子进程；**插件全程不接触 raw key**。
  - **signing 模式**（SigV4/ACS3，降级口子）：main 把 key 注入子进程**临时 env**（不落 dataDir）；**插件内存可见 key**，走 ⚠️⚠️ 升级信任门 + sandbox 额外禁 fs.write/net 白名单。
- **不自动接管流量**：插件 provider 进 Registry 后**不自动**进 Router 候选池；必须用户显式 config / `@alias`。**v1 不能设 default**。
- **专用 stream 通道**：plugin 子进程的 stream chunk 走独立 long-lived RPC 流（不复用普通 event queue，保证不丢 delta）。
- **延迟卸载**：disable 延迟到 turn 边界（sticky 锁定期不卸载）；dispose 必须 graceful（等在途 stream / 5s 超时 abort）。
- **信任门升级文案**："⚠️ This plugin wants to act as a model provider. It will see all your prompts and code..."；signing 模式额外 ⚠️⚠️ 告知 key 会进插件进程。
- **Disposable 契约**：所有 `register` / `on` 必须返回 `Disposable`；`plugin-runtime` 在 disable/卸载/异常时兜底释放（含 `SIGKILL` 子进程）。
- **超时**：`activate` 超时 10s → 视为失败，`SIGKILL` 子进程并卸载。
- **资源守护**：`apollo-sandbox` 通过 `setrlimit` 施加 CPU / RSS / NPROC / NOFILE 上限；bridge 调用超时 5s；每 turn 500 次 bridge call 上限；心跳 60s 无响应 → SIGKILL（详见 spec §6.11.2）。
- **异常隔离**：插件子进程崩溃 / OOM 仅触发 `error.raised`，主进程 100% 不受影响。

#### 4.10.2 PromptComposer 强制路径

- 系统提示词的**唯一组装点**是 `core.PromptComposer.compose(ctx)`。Runner 在构造 provider 请求前调用一次。
- 允许的 contributor（按 priority 默认值）：
  - `builtin` (1000) — apollo 自身，`core` 启动自注册
  - `skill:<name>` (800) — `skills-runtime` 激活时注册
  - `project` (600) — `<cwd>/AGENT.md`，`storage` 启动时读取
  - `user` (400) — `~/.apollo/PROMPT.md`，`storage` 启动时读取
  - `plugin:<name>` (50) — 插件通过 `apollo.prompt.contribute` 注册
- 禁止在 `provider-*` / `router` / `tools` 里直接拼接 system prompt。所有来源必须走 composer。
- `SessionState.systemPromptSnapshot` 是唯一缓存；contributor register/dispose 时由 composer 主动失效。

#### 4.10.3 plugin-sdk 包约束

- `packages/plugin-sdk` **必须**运行时零依赖（只依赖 `packages/shared` type-only）。
- **发布到 npm** 供外部插件作者使用；`private: false`。
- 只导出类型 + `definePlugin` / `defineTool` / `defineHook` / `defineCommand` 等 helper（helper 只是 `<T>(x: T) => T` 类型收敛，运行时无逻辑）。
- 版本策略：apollo 主版本升级导致 bridge breaking change 时，plugin-sdk 同步 major，且 apollo 支持 semver 兼容多个旧 sdk major。

### 4.11 Rust 原生分发（平台包 pattern）

- 每个 Rust 产物 × 每个 target = 一个独立 npm 平台包，放在 `platforms/native-<name>-<triple>/`（产物均为独立二进制，r9: search/fs 从 napi addon 改 worker 二进制）。
- `packages/native-bridge` 通过 `optionalDependencies` 声明所有平台包（**L1: 12 个 = 3 产物 × 4 target；L2: 24 个 = 3 产物 × 8 target**），另含跨平台 `native-fs-common`（BPE 表，fs worker 启动时读）。
- 运行时通过 `process.platform + process.arch + libc` 拼包名（含 gnu/musl/msvc 后缀），`require.resolve` 拿平台包目录 → 读 `bin` 字段拿二进制路径 → `WorkerPool.spawn`（search/fs worker）或子进程（sandbox）。
- 找不到时：search/fs worker 降级到 JS fallback；`apollo-sandbox` 类 tier=none 并提示 `--dangerous-no-sandbox` 覆盖。
- **Target 矩阵（r9 分层硬约束，见 spec §5.9 / SANDBOX-COMPAT §S1）**：
  - **L1（4 target）**：darwin-arm64 / darwin-x64 / linux-x64-gnu / linux-arm64-gnu
  - **L2 补（4 target）**：linux-x64-musl / linux-arm64-musl / win32-x64-msvc / win32-arm64-msvc

### 4.12 模型路由层强制

- Runner **禁止**直接持有 `ProviderClient`，必须持有 `RouterPolicy` 实例。
- RouterPolicy 从 `ProviderRegistry` 解析 provider 名 → `ProviderClient` 实例；registry 兼纳核心 provider（`provider-anthropic` 等）与插件 provider（`kind:'provider'` 插件注册，见 [PLUGIN-PROVIDER-r1](./docs/superpowers/specs/2026-07-31-apollo-code-design/PLUGIN-PROVIDER-r1.md)）。
- MVP：`SingleProviderRouter`（配置里指定唯一 provider）。
- v1.1+：`FallbackRouter` / `RoleRouter` 等策略。
- Router 内部按需调 auth / http-kit，业务代码不感知具体 provider 切换。
- 插件 provider **必须**用户显式配置才进 Router 候选池（不自动接管流量）；v1 **不能**设为 default。

### 4.13 遥测隐私强约束

- `telemetry` **默认 sink 是本地文件**：`~/.apollo/telemetry/*.jsonl`（对齐 spec §8.1 存储树），**绝不发送任何网络请求**。
- OpenTelemetry / 云上报 sink 属于**显式 opt-in**：只有用户在 `~/.apollo/config.toml` 明确写入 `[telemetry.otel] endpoint = "..."` 才启用。
- 首次运行**不弹**"是否发送匿名统计"引导（避免误勾）。
- 任何添加自动上报网络的 PR 必须被拒绝，属于安全 breach。
- 违反此条视为严重合规问题。

### 4.14 Memory 系统硬约束（spec §6.12）

- **存储位置固定**：全局 `~/.apollo/memory/*.md`，项目 `<cwd>/.apollo/memory/*.md`；路径可通过 `[memory].paths.global/project` 覆写，但 **必须** canonicalize + escape 检测，禁止穿越到白名单外。
- **单文件形态固定**：Markdown + 合法 YAML frontmatter（`id / scope / title / tags / pinned / created / updated / source / model / version`）。缺失任一必填字段 → 写入拒绝。
- **200 行 body 上限**：`[memory].max_body_lines` 默认 200。分层降级：
  1. 系统提示词 soft prompt 告知模型主动分片
  2. `memory-runtime.write` 硬校验超限抛错（`APOLLO_MEMORY_TOO_LARGE`）
  3. hook `memory.preWrite` 允许用户/插件放宽或强制拆分
  4. 模型连续 3 次超限 → runtime 自动按 heading 切分保存
  - 修改此限制**必须**同时更新 memory-guide 提示词，否则模型会不自知地反复超限。
- **模型主导**：apollo 内置 `memory-guide` 提示词（priority 950）教模型**何时写 / 写什么 / 怎么写**；插件通过 `apollo.memory.contributePrompt` 追加片段。禁止在 provider / router / tools 里另起 memory 提示词。
- **召回路径唯一**：模型通过 `apollo.memory.recall(query)` 工具主动召回；pinned 条目走 PromptComposer priority 700 自动注入，注入行数受 `[memory].pinned_inject_max_lines` 硬限（默认 400，防炸上下文）。
- **权限门**：所有 `apollo.memory.*` bridge 调用**必须**过 `manifest.permissions.memory`（`read` / `write` / `contributePrompt`）声明 + `packages/permission` 决策；未声明的 method 直接 `-32601`。
- **禁止**：
  - 绕过 `memory-runtime` 直接读写 memory 目录（`storage` / `tools` 不允许）
  - 在 memory md 里再嵌套 memory（`@include` 展开会被 memory-runtime 拒绝，防递归污染）
  - 把 credentials / API key / raw token 写入 memory（`memory.preWrite` hook 内置 `shared.sanitize()` 扫描器兜底）

### 4.15 `@include` 机制硬约束（spec §6.5.6）

- **仅适用于 apollo 内部 prompt 装载管线**：PromptComposer contributor（skills / project AGENT.md / user PROMPT.md / plugin fragments / memory md）读入 md 时递归展开。**不作用**于工具 `Read`、`Grep`、用户业务代码。
- **实现单点**：`packages/core/src/prompt-loader.ts` 是唯一实现；其他包读 md 走 `core.PromptLoader.load()`，禁止各自实现 `@include`。
- **语法**：行首 `@include <path>`，`path` 支持相对当前文件目录、`~/` 前缀。**只允许 `.md` 文件**，其它扩展名直接报错 + 保留占位注释。
- **双白名单**：路径必须落在 `<cwd>/**` 或 `~/.apollo/**` 内（canonicalize 后判定，symlink 逃逸即拒绝）。
- **原子 open + fstat（防 TOCTOU）**：路径校验禁止 stat-then-open 两步，必须单次 `open()` 拿 fd 后 `fstat` 同一 fd 判定 canonical prefix（Linux `openat2(RESOLVE_NO_SYMLINKS)` / macOS `openat(O_NOFOLLOW)` / Windows `CreateFileW` + handle stat）。
- **敏感文件名黑名单**：即便落在双白名单内，`credentials*` / `~/.ssh` / `id_*` / `*.pem` / `.env*` 仍拒绝展开 + `security.event`。
- **递归安全**：
  - 默认深度上限 8（可通过 `[prompt.include].max_depth` 提升到 32）
  - seen-set 环检测
  - 单次 compose 展开次数硬上限 64
- **frontmatter 处理**：被 include 的文件 YAML frontmatter 必须**剥离**后再拼接，避免污染宿主文档。
- **错误处理不中断 compose**：找不到 / 非 md / 越权 / 超深度 / 环 → 保留 `<!-- @include failed: <reason> -->` 占位注释，emit `prompt.include.failed` 事件，**不**抛异常。
- **debug 可观测**：`apollo debug prompt` dump 出的合并结果里必须保留 `<!-- include: <path> depth=N -->` / `<!-- /include -->` 边界标记。
- **禁止**：
  - `@include` 引入非 md 文件（json / toml / 代码文件一律拒绝）
  - 在工具输出、模型消息、用户对话文本里做 `@include` 展开（防注入攻击）
  - 展开阶段执行任何模板/代码求值（纯字符串拼接）

## 5. 代码规范

- ESLint（antfu preset）+ Prettier + TypeScript strict + `verbatimModuleSyntax`。
- 所有导出必须显式类型注解，禁止依赖推导（对 public API）。
- 错误类型继承 `packages/shared` 的 `ApolloError`，禁止裸 `throw new Error(...)`。
- 日志走 `packages/shared/logger`，禁止 `console.log`（除 CLI 入口的用户可见输出）。
- 异步优先，禁止 `sync` 版本的 fs API（除启动期一次性读取）。

## 6. 测试规范

- 单元测试：Vitest。
- E2E：node:test 驱动 CLI，捕获终端输出对齐 snapshot。
- Rust：`cargo test` + `cargo insta`。
- **PR 合并门槛**：单元测试覆盖率 ≥ 70%，E2E 冒烟通过。

## 7. 提交规范

- Conventional Commits：`feat(core): ...` / `fix(provider-openai): ...`。
- scope 必须是 monorepo 包名（不带前缀）。
- 主分支 `main` 保护，走 PR。
- 每个 commit **必须** DCO 签署（`git commit -s`），仓库不接受 CLA。
- 破坏性变更必须先走 RFC（见 `CONTRIBUTING.md` § RFC process）。

## 8. 目录新增流程

新增一个 `packages/xxx` 时：
1. 复制 `packages/_template` 骨架
2. 声明依赖时严格遵守 §4.1 单向依赖
3. 在 `AGENT.md` §4.1 依赖图中补一笔
4. 在 `apps/docs` 增加对应说明页
5. Turbo 会自动识别，无需改 `turbo.json`

## 9. AI Agent 特别提醒

- 当你要修改跨多个包的行为，先读本文件 §4 边界。
- 当你要加依赖，先看 `pnpm-workspace.yaml` 的 catalog 有没有；有就用 `catalog:`，没有再 add。
- 当你要 `spawn` / `writeFile`，停下来查是不是应该走 permission + sandbox。
- 当你不确定新代码放哪个包，问用户或选就近的 `*-kit`。
- 修改 `AGENT.md` 或 `CLAUDE.md` 必须同步修改另一份。
- 触及 CLI 命令、系统提示词、权限模型、遥测默认行为、开源治理文件（`LICENSE` / `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md`）时，必须先读设计 spec 的 §6-§6.5 / §11 / §12 / §14。

## 10. 关联文档

- 设计 spec: `docs/superpowers/specs/2026-07-31-apollo-code-design.md`（内容真源）
- 贡献流程: `CONTRIBUTING.md`
- 安全响应: `SECURITY.md`
- 行为守则: `CODE_OF_CONDUCT.md`
- 许可协议: `LICENSE`（Apache-2.0）
