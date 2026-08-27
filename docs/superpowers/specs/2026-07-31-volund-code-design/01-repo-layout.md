> ↩ [返回索引 (README)](./README.md) · — · [下一章: §2 Agent Loop](./02-agent-loop.md) →

---

## §1 仓库布局 (v3, review 修正版)

采用 pnpm + turborepo monorepo，TypeScript 与 Rust 双 workspace。

### 1.1 目录结构

```
volund-code/
├─ apps/
│  ├─ cli/                        # 唯一可执行入口 → bin: volund
│  └─ docs/                       # VitePress 8 文档站
│
├─ packages/                      # 所有可发布 TS 包
│  │
│  ├─ ── 内核 (kernel) ──
│  ├─ core/                       # Runner / EventBus / SessionState / HookRegistry
│  │                              # 仅依赖 provider-kit + tool-kit + shared
│  │
│  ├─ ── 契约层 (kits, 只含接口，零实现依赖) ──
│  ├─ provider-kit/               # Message/ContentPart/ProviderClient/Capabilities/
│  │                              # ContextPolicy/Attachment/Usage 等（仅依赖 shared）
│  ├─ tool-kit/                   # Tool/ToolRegistry/ToolResult（仅依赖 permission + shared）
│  │
│  ├─ ── 路由层 (v1.1 只做 SingleProviderRouter，接口先立) ──
│  ├─ router/                     # RouterPolicy 实现集合（Single/Fallback/Role/...）
│  │
│  ├─ ── Provider 实现 ──
│  ├─ provider-anthropic/         # Anthropic Messages
│  ├─ provider-openai/            # OpenAI Chat Completions
│  ├─ provider-gemini/            # Gemini
│  ├─ provider-ollama/            # 本地模型
│  │
│  ├─ ── 工具实现 ──
│  ├─ tools/                      # 内置工具（Read/Write/Edit/Bash/Grep/Glob/Todo/Task…）
│  │
│  ├─ ── 横切能力 ──
│  ├─ auth/                       # OS keychain + 加密文件 + env 三级 fallback
│  ├─ http-kit/                   # undici + proxy + retry + tracing
│  ├─ permission/                 # 权限决策 + setPromptHandler 端口
│  ├─ context/                    # ContextPolicy 策略集合（sliding / summary / semantic）
│  ├─ native-bridge/              # Rust 能力唯一入口 + 平台包解析 + JS fallback
│  ├─ storage/                    # JSONL 会话 + toml 配置（订阅 core 事件）
│  ├─ telemetry/                  # 日志/metrics/cost tracking（默认本地，OTel opt-in）
│  ├─ hooks/                      # user hooks 加载器 + 官方内置 hook
│  │
│  ├─ ── 扩展装载器 ──
│  ├─ mcp-client/                 # MCP 客户端（stdio/http/sse），加载后注册到 tool-kit
│  ├─ skills-runtime/             # Skill 装载器 + progressive disclosure
│  ├─ plugin-runtime/             # Plugin 装载器（volund-sandbox --run-plugin 子进程 + JSON-RPC bridge + manifest 权限）
│  ├─ plugin-sdk/                 # 【发布 npm】插件作者用的类型 + define helpers（零运行时依赖）
│  ├─ memory-runtime/             # 长期记忆存储 + 召回索引 + memory bridge server（v2+）
│  ├─ subagent/                   # 子 Agent runtime（接受 RunnerFactory 注入）
│  │
│  ├─ ── UI ──
│  ├─ ui/                         # Ink 组件库（订阅 core 事件 + 提供 permission prompt）
│  │
│  └─ ── 基础 ──
│     └─ shared/                  # 类型/常量/logger/VolundError/config schema (zod)
│
├─ crates/                        # Rust workspace（r9: 三产物均为独立二进制）
│  ├─ volund-sandbox/             # 独立二进制：syscall 隔离执行器 + 插件宿主
│  ├─ volund-search/              # 独立二进制 worker：ripgrep + tree-sitter（常驻 IPC）
│  ├─ volund-fs/                  # 独立二进制 worker：大文件 diff / tokenize（常驻 IPC）
│  └─ xtask/                      # Rust 侧构建/发布脚本
│
├─ platforms/                     # 各平台 prebuild 二进制的独立发布包（见 §1.6；产物均为独立二进制；L1 12 包 = 4 target × 3 crate，L2 扩 24 包 = 8 target × 3 crate）
│  ├─ native-sandbox-{darwin-arm64,darwin-x64,             # volund-sandbox 二进制
│  │                   linux-x64-gnu,linux-arm64-gnu,      # ← L1 这 4 target
│  │                   linux-x64-musl,linux-arm64-musl,
│  │                   win32-x64-msvc,win32-arm64-msvc}/    # ← L2 补这 4 target
│  ├─ native-search-{同上 8 triple}/                        # volund-search worker 二进制
│  ├─ native-fs-{同上 8 triple}/                            # volund-fs worker 二进制
│  └─ native-fs-common/                                       # 跨平台 BPE 表（非平台包，fs worker 启动时读）
│                                                              # 可选：native-sandbox-darwin-universal（universal2 合并包）
│
├─ examples/                      # 示例 Skill / Plugin / MCP server
├─ .github/workflows/             # CI: TS build / Rust matrix / release
├─ AGENT.md
├─ CLAUDE.md
├─ turbo.json
├─ pnpm-workspace.yaml
├─ Cargo.toml
└─ package.json
```

### 1.2 依赖方向（v3 修正后）

```
                          apps/cli
                              │  组装
       ┌───────────────┬──────┴──────┬──────────────┐
       ▼               ▼             ▼              ▼
     core          router      provider-*        tools
       │             │             │               │
       │             │             │               ▼
       │             │             ▼           tool-kit ─→ permission
       │             ▼         provider-kit        │
       │         provider-kit      │               │
       │             │             │               ▼
       └─────────────┴─────────────┴──→ shared ←──┘

  订阅 core 事件（core 完全不感知）：
    ui / storage / telemetry / hooks

  通过 tool-kit 注入工具（core 完全不感知）：
    mcp-client / plugin-runtime / memory-runtime(via volund.memory bridge) / subagent(via Task tool)

  运行时端口注入（无 import 依赖）：
    permission.setPromptHandler(uiPrompt)   ← apps/cli 组装时注入
    subagent.configure(runnerFactory)        ← apps/cli 组装时注入

  横切能力：
    auth (被 provider-* 主动调用)
    http-kit (被 provider-* 主动调用)
    context (提供 ContextPolicy 实现，被 apps/cli 选一个注入 Runner)
    native-bridge (被 tools / auth / plugin-runtime 主动调用)
```

**依赖表格**（CI 强制）：

| 包                 | 允许依赖                                            |
|--------------------|-----------------------------------------------------|
| **apps/cli**       | packages/* 任意                                     |
| **apps/docs**      | 无（build 时 typedoc 读源码，非 npm 依赖）             |
| **core**           | provider-kit / tool-kit / shared                    |
| **router**         | provider-kit / shared                               |
| **provider-kit**   | **shared 仅**                                       |
| **provider-\***    | provider-kit / http-kit / auth / shared             |
| **tool-kit**       | permission / shared                                 |
| **tools**          | tool-kit / native-bridge / subagent / shared        |
| **subagent**       | core（`Runner` 类）/ provider-kit / tool-kit / shared |
| **mcp-client**     | tool-kit / shared                                   |
| **plugin-runtime** | core（type-only）/ tool-kit / permission / hooks / native-bridge / shared |
| **plugin-sdk**     | shared（type-only）                                   |
| **skills-runtime** | core（type-only）/ shared                             |
| **memory-runtime** | core（type-only）/ permission / hooks / native-bridge / shared |
| **hooks**          | core（type-only） / shared                            |
| **storage**        | core（type-only）/ shared                             |
| **telemetry**      | core（type-only）/ shared                             |
| **ui**             | core（type-only）/ permission（type-only）/ shared      |
| **context**        | provider-kit / shared                               |
| **auth**           | native-bridge / shared                              |
| **http-kit**       | shared                                              |
| **permission**     | shared                                              |
| **native-bridge**  | shared + 运行时 dynamic require platform packages   |
| **shared**         | 无                                                  |

**说明**：

- 表格里标注 "type-only" 的依赖必须用 `import type { ... }`，编译时消除，运行时不引入。CI ESLint 强制。
- `ui → permission` 是 type-only：ui 需要知道 `PermissionRequest` 类型来渲染弹窗；ui 通过 `permission.setPromptHandler(...)` 注册回调，反向不 import。
- `auth → native-bridge` 是**运行时可选**依赖（不是 type-only）：仅 L4 加密凭据文件的 AES-256-GCM 操作走 Rust（`volund-fs` 的 `encrypt/decrypt` 导出）。L1-L3 只用 Node `crypto`，`native-bridge` 缺失时 auth 自动 fallback。CI 允许该依赖，但 `auth` 内所有 native-bridge 调用必须包 try/catch fallback。

### 1.3 关键约束

- **`apps/cli` 是唯一 bin**，`packages/*` 禁止声明 `bin` 字段
- **`apps/docs` 用 VitePress 8**，`"private": true`，**不发布到 npm**，只做 GitHub Pages / Vercel 部署
- **Provider 每家一个包**，用户按需装
- **`native-bridge` 是 Rust 唯一入口**，通过 optionalDependencies 平台包分发（见 §1.6）
- **`crates/` 独立 Cargo workspace**

### 1.4 契约定义的唯一归属

| 抽象                                                    | 定义位置                                    |
|---------------------------------------------------------|---------------------------------------------|
| Message / ContentPart / Attachment / Usage              | provider-kit                                |
| ProviderClient / ProviderCapabilities                   | provider-kit                                |
| **ContextPolicy**                                       | provider-kit（**改自 v2**，随 Message 概念走） |
| RouterPolicy / RouterDecision                           | router（接口内置）                            |
| Tool / ToolRegistry / ToolResult / ToolResultMeta       | tool-kit                                    |
| Runner / SessionState / EventBus / HookRegistry         | core                                        |
| **PromptComposer / PromptFragment**                     | **core**（v3.1 新增，见 §6.5）                  |
| **VolundBridge / Plugin / ToolSpec 等 SDK 类型**         | **plugin-sdk**（发布 npm，作者依赖）            |
| PermissionSpec / PermissionRequest / PermissionDecision | permission                                  |
| VolundError / Logger / Config schema (zod)              | shared                                      |

### 1.5 关键运行时端口（依赖注入）

避免循环依赖的注入点，由 `apps/cli` 在启动时装配：

```
1. permission.setPromptHandler(uiPermissionDialog)
   └ ui 提供实现，permission 消费，不产生反向依赖

2. subagent.configure({ runnerFactory, defaultBudget, ... })
   └ apps/cli 组装 runnerFactory 后注入 subagent

3. core.Runner(new RouterAdapter(router), toolRegistry, contextPolicy, hookRegistry)
   └ 所有能力通过构造函数注入 Runner

4. telemetry.setSink(localFileSink | otelSink)
   └ 默认 localFileSink，用户显式配置才用 otelSink（见 [AGENT.md §4.13](../../../AGENT.md#413-遥测隐私强约束) + spec [§8.7](./08-session-config.md#87-telemetry默认本地)）
```

### 1.6 Rust 原生分发模型（业界标准 pattern）

参考 esbuild / biome / swc 做法：

**每个 Rust 产物 × 每个 target = 一个独立 npm 包**

```
platforms/
  native-sandbox-<triple>/       → 打包 volund-sandbox 可执行二进制
  native-search-<triple>/        → 打包 volund-search worker 二进制（r9: 原 napi .node 作废）
  native-fs-<triple>/            → 打包 volund-fs worker 二进制（r9: 原 napi .node 作废）
```

> `<triple>` 用 npm 包名约定：`darwin-arm64` / `darwin-x64` / `linux-x64-gnu` / `linux-arm64-gnu` / `linux-x64-musl` / `linux-arm64-musl` / `win32-x64-msvc` / `win32-arm64-msvc`。权威矩阵见 [§5.9](./05-rust-sidecar.md) 与 [SANDBOX-COMPAT-r1 §S2](./SANDBOX-COMPAT-r1.md)。

**共 3 crate × 8 target = 24 个平台包**（L2 全平台口径；产物均为独立二进制）。**L1 先发 12 包（4 target × 3 crate：darwin-arm64/darwin-x64/linux-x64-gnu/linux-arm64-gnu）**，L2 扩 24 包（补 Windows + musl）。另含跨平台共享的 `@volund/native-fs-common`（BPE 表，非平台包，fs worker 启动时读）与可选的 universal2 合并包（sandbox/search/fs 各一，Homebrew 用；r9 后 search/fs 也可 lipo 合并，napi-rs universal 限制已解除）。

`packages/native-bridge/package.json`：

```json
{
  "optionalDependencies": {
    "@volund/native-sandbox-darwin-arm64": "workspace:*",
    "@volund/native-sandbox-darwin-x64": "workspace:*",
    "@volund/native-sandbox-linux-x64-gnu": "workspace:*",
    "@volund/native-sandbox-linux-arm64-gnu": "workspace:*",
    "...（L1 共 12 项 = 上述 4 target × 3 crate）": "workspace:*",
    "@volund/native-sandbox-linux-x64-musl": "workspace:*",
    "@volund/native-sandbox-linux-arm64-musl": "workspace:*",
    "@volund/native-sandbox-win32-x64-msvc": "workspace:*",
    "@volund/native-sandbox-win32-arm64-msvc": "workspace:*",
    "...（L2 补齐至 24 项 = 8 target × 3 crate）": "workspace:*"
  }
}
```

**运行时解析（r9 改造）**：`native-bridge` 通过 `process.platform + process.arch + libc` 拼出目标包名（含 gnu/musl 后缀），`require.resolve` 拿到平台包目录 → 读 `package.json.bin` 字段拿到二进制路径 → `WorkerPool.spawn`（search/fs）或子进程调用（sandbox）。找不到就回落：search/fs → JS fallback（`volund-search` fallback = fast-glob + JS 正则）；sandbox → tier=none + 提示 `--dangerous-no-sandbox`。详见 §5.8。

**Target 支持矩阵**（8 native target；L1 前 4，L2 全 8；对齐 §5.9 / SANDBOX-COMPAT §S1 硬约束）：

- **L1（4 target）**：darwin-arm64 / darwin-x64（macOS）/ linux-x64-gnu / linux-arm64-gnu（Linux glibc）
- **L2 补（4 target）**：linux-x64-musl / linux-arm64-musl（Linux musl / Alpine）/ win32-x64-msvc / win32-arm64-msvc（Windows）

### 1.7 Skill vs Plugin 边界（不变，扩充版本兼容）

|          | Skill                                          | Plugin                                          |
|----------|------------------------------------------------|-------------------------------------------------|
| 本质     | Prompt + 资源                                  | 代码（tools / commands / hooks）                  |
| 存放     | `~/.volund/skills/<name>/SKILL.md`             | `~/.volund/plugins/<name>/`                     |
| 装载     | 冷启动扫 metadata，按需读全文                   | 显式 install + manifest 声明能力                |
| 隔离     | 不执行代码                                     | permission + manifest + 静态检查                |
| 版本     | `SKILL.md` frontmatter `volundVersion: ^1.0.0` | `manifest.json` `engines.volund: ^1.0.0`        |
| 首次装载 | 无提示（无风险）                                 | **弹权限确认**（"该插件声明需要 fs.write / net"） |
| 运行时   | `skills-runtime`                               | `plugin-runtime`                                |

---
