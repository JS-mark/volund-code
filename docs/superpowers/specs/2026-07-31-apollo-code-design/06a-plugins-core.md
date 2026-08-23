> ↩ [返回索引 (README)](./README.md) · ← [上一章: §5 Rust 侧车](./05-rust-sidecar.md) · [下一章: §6b PromptComposer + 生命周期 (6.5–6.11)](./06b-prompt-composer.md) →

---

## §6 Skill / Plugin / MCP / Hooks

本节先落地**插件系统**（用户 2026-07-31 追问点），其它三块（Skill/MCP/Hooks 深化）等 §3-§5 后再补。

### 6.1 设计目标

| 目标                       | 具体含义                                                                     |
|----------------------------|------------------------------------------------------------------------------|
| **JS 优先**                | 插件运行时只接受 JS（ESM）。作者可用 TS，自行编译。零工具链门槛。              |
| **能力可声明、可审计**     | manifest.json 静态描述插件能力与权限；用户加载时看得见。                       |
| **JSBridge 受控入口**      | 插件只能通过 `apollo` 全局对象访问 apollo 能力，不允许 `require('fs')` 之类逃逸。 |
| **系统提示词可扩展**       | 插件可贡献 prompt 片段；与 Skill / user PROMPT.md / project AGENT.md 走同一 composer。 |
| **热插拔**                 | 插件可在 session 内 enable / disable，无需重启 apollo。                        |
| **版本可控**               | `engines.apollo` semver 校验，防止老插件跑在新 apollo 上炸。                    |
| **无中央基础设施**         | MVP 阶段用 npm 分发（命名约定 `apollo-plugin-*`），不建 registry。               |

**非目标**：
- 插件间通信（v1 不做，需要通信请用同一插件）
- 插件写 apollo 核心逻辑（Provider / Router / Runner 不给改）
- 插件直接调用 provider（防绕过 router / cost tracking）
- 插件访问其它插件的 storage / manifest

### 6.2 插件形态与目录约定

MVP **单文件 ESM bundle**（类似 VSCode `.vsix`）：

```
~/.apollo/plugins/apollo-plugin-git-helper/
├─ manifest.json           # 必需
├─ index.js                # 必需，ESM，含所有依赖
├─ README.md               # 可选
├─ icon.svg                # 可选，UI 展示
├─ assets/                 # 可选静态资源（prompt 片段等）
└─ data/                   # 运行时数据（apollo 自动建，插件通过 apollo.storage 读写）
```

**安装路径**：
- 全局：`~/.apollo/plugins/<pkg>/`
- 项目：`<cwd>/.apollo/plugins/<pkg>/`（仅当前项目启用）
- 优先级：项目覆盖全局

**安装命令**（`apps/cli`）：
- `apollo plugin install apollo-plugin-<name>` → 内部 `pnpm add` 到全局 plugin 目录
- `apollo plugin install github:user/repo` → 从 release tarball 拉取（v2）
- `apollo plugin install ./local-dir` → 软链接到本地路径（开发模式）

### 6.3 manifest.json 规范

```jsonc
{
  "$schema": "https://apollo-code.dev/schemas/plugin-manifest-v1.json",
  "name": "apollo-plugin-git-helper",           // 命名约定 apollo-plugin-*
  "version": "1.2.0",                            // semver
  "description": "Git-aware tools & prompts",
  "author": "Mark <mark@example.com>",
  "license": "MIT",
  "homepage": "...",

  "engines": { "apollo": "^1.0.0" },             // ★ 必需，semver 校验

  "main": "index.js",                            // 相对路径
  "type": "module",                              // 只支持 ESM

  // 声明式清单：UI 展示 + 静态可审计
  "contributes": {
    "tools":            ["git-status", "git-diff"],
    "commands":         ["/gitlog", "/gitblame"],
    "hooks":            ["preToolUse", "prePrompt"],
    "promptFragments":  ["git-context", "git-conventions"],
    "skills":           []                       // 插件也能捆绑 Skill
  },

  // 权限白名单：加载时用户确认，运行时 bridge 强制
  "permissions": {
    "fs":    { "read": ["**/*.git/**"], "write": [] },
    "bash":  { "allowlist": ["git *"] },
    "net":   false,                              // 或 { "allowlist": ["api.github.com"] }
    "apollo": [                                  // 允许调用哪些 bridge API
      "tools.register",
      "hooks.on",
      "commands.register",
      "prompt.contribute",
      "session.read",
      "ui.confirm"
    ]
  },

  // 可选配置 schema（zod-ish）
  "config": {
    "gitCommand": { "type": "string", "default": "git" }
  }
}
```

**加载前校验**：
1. Schema 校验 manifest.json
2. `engines.apollo` semver 匹配
3. 静态扫 `index.js` 黑名单（`eval` / `Function` / `require('child_process')` 之类）
4. UI 展示 `contributes` + `permissions` → 用户确认
5. 之后写入 `~/.apollo/plugins.enabled.toml` 记住"已批准 + 版本 + 权限 hash"
6. **升级后权限扩大** → 再次弹窗（类似 Android 应用权限变更）

### 6.4 JSBridge：apollo 全局对象

插件 `index.js` **唯一入口**是 `activate(apollo)`。`apollo` 就是 JSBridge。

**是否合理**：**非常合理，正确 pattern**。VSCode / Figma / Sketch / 浏览器扩展全用这个思路。它把安全边界、能力发现、类型系统集中在一处，是插件系统里最可靠的 API 组织方式。

#### 6.4.1 完整 API 表面（v1）

```ts
export interface ApolloBridge {
  //-------- 元信息 --------
  readonly apiVersion: '1.0'
  readonly plugin: { name: string; version: string; dataDir: string }

  //-------- 工具注册 --------
  tools: {
    register(spec: ToolSpec): Disposable
    unregister(name: string): void
  }

  //-------- Hook 订阅 --------
  hooks: {
    on(event: HookEvent, handler: HookHandler): Disposable
    off(event: HookEvent, handler: HookHandler): void
    /**
     * ★ r9 新增：框架级命名空间 KV store（仅 hook handler 的 ctx 内可用）。
     * 按 (event + 来源 plugin + toolUseId) 命名空间隔离：
     * - 同一 tool_use 的 pipeline 内 handler 串行，前者写入后者可读
     * - 不同 tool_use 之间 kv 不共享（避免 parallelInvoke 竞态）
     * 框架保证命名空间级互斥，作者无需自行加锁。
     */
    kv: {
      get<T = unknown>(key: string): T | undefined
      set(key: string, value: unknown): void
      delete(key: string): void
      clear(): void
    }
  }

  //-------- Slash 命令 --------
  commands: {
    register(spec: CommandSpec): Disposable
  }

  //-------- ★ 系统提示词贡献 --------
  prompt: {
    contribute(fragment: PromptFragment): Disposable
    revoke(id: string): void
  }

  //-------- ★ Provider 注册（仅 kind:'provider' 插件；详见 PLUGIN-PROVIDER-r1） --------
  provider: {
    /** 注册 ProviderClient 实现；普通插件声明此 method 会被拒绝 */
    register(spec: ProviderPluginSpec): Disposable
  }

  //-------- ★ 凭据（受控，仅 provider 插件；不暴露 raw key） --------
  auth: {
    /** header-template 模式：取 main 已渲染的 auth header（不含 raw key） */
    getAuthHeaders(providerName: string): Promise<Record<string, string>>
    /** signing 模式：声明需读的 env key 名（main 已注入 env，本方法只返清单不返值） */
    getSigningEnvKeys(providerName: string): string[]
  }

  //-------- 会话（只读 + 事件） --------
  session: {
    id: string
    cwd: string
    getMessages(range?: { limit?: number }): ReadonlyArray<Message>
    getUsage(): Usage
    on(event: SessionEvent, handler: (payload: any) => void): Disposable
  }

  //-------- 文件 IO（permission-gated + native-bridge） --------
  fs: {
    readFile(path: string, encoding?: 'utf-8' | 'binary'): Promise<string | Uint8Array>
    writeFile(path: string, data: string | Uint8Array): Promise<void>
    exists(path: string): Promise<boolean>
    glob(pattern: string, opts?: GlobOpts): Promise<string[]>
    stat(path: string): Promise<FileStat>
  }

  //-------- 命令执行（sandbox-gated） --------
  exec(command: string, opts?: ExecOpts): Promise<{ stdout: string; stderr: string; code: number }>

  //-------- 网络（http-kit + permission-gated） --------
  http: {
    fetch(url: string, init?: FetchInit): Promise<Response>
  }

  //-------- 与用户交互 --------
  ui: {
    confirm(message: string): Promise<boolean>
    prompt(question: string, opts?: { default?: string; secret?: boolean }): Promise<string | null>
    pick<T>(options: T[], opts?: { label: (t: T) => string }): Promise<T | null>
    notify(message: string, level?: 'info' | 'warn' | 'error'): void
    // ★ r13-D1：非 TTY（--json / CI / pipe）降级语义——
    //   confirm → false（fail-closed，宁可拒绝不可静默放行）
    //   prompt  → null（无输入即无答案）
    //   pick    → null
    //   notify  → 降级为 stderr 一行文本（--json 模式不得污染 stdout NDJSON）
  }

  //-------- 插件私有存储 --------
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }

  //-------- 配置读取（manifest.config 声明的项） --------
  config: {
    get<T = unknown>(key: string): T
  }

  //-------- 日志（写入 telemetry） --------
  log: {
    debug(msg: string, meta?: object): void
    info(msg: string, meta?: object): void
    warn(msg: string, meta?: object): void
    error(msg: string, err?: unknown, meta?: object): void
  }
}
```

**明确不暴露**（v1 non-goals）：
- `apollo.native` / `apollo.rust` — 插件不能碰 Rust 原生
- `apollo.core` / `apollo.runner` — 插件不能改内核
- `apollo.provider` 的**直调入口**（`stream` / `complete` / `getCredential`）— 插件不能自己发 LLM 请求绕 Router。**仅** `apollo.provider.register(spec)` 受控开放，让插件**注册** ProviderClient 实现进 Registry（由 Router 经标准路径调用）；详见 [PLUGIN-PROVIDER-r1](./PLUGIN-PROVIDER-r1.md)。
- `apollo.plugins` — 插件不能操作其它插件

**Disposable 契约**：所有 `register/on` 返回 `Disposable`，`deactivate` 时必须调 `dispose()`，`plugin-runtime` 会兜底 dispose 所有插件持有的注册。

#### 6.4.1a 受控 agent dispatch / 后台 job / 状态面板贡献（v1 扩展，L4）

三个新 bridge 命名空间，为 §21 动态反思等"需要一次受控模型推理 / 长任务 / 状态展示"的插件补全 surface。共同原则：**插件永远只声明意图，K0 保留执行权**——预算求交、调度时机、模型路由、渲染边界全部在 K0 侧强制（§19.1.1 各 surface 的内核保留职责不变）。

```ts
export interface ApolloBridge {
  // ... §6.4.1 既有命名空间不变 ...

  //-------- ★ 受控 agent dispatch（subagent-profile surface 的运行时 API）--------
  agents: {
    /**
     * 请求 K0 Runner 以声明的 subagent-profile 跑一次有界 agent run。
     * 不是 provider 直调（§6.4.1 non-goals 不变）：模型调用由 K0 Runner 经 Router 发出。
     * manifest 必须声明 `permissions.agents.run = true`。
     * K0 强制：budget = 请求值 ∩ profile 上限 ∩ 调用方 session 硬顶；depth+1 隔离（§2.7 全规则）；
     * tools 白名单取 profile 声明（v1 reflector 恒为 []）；usage 打调用方归因标记。
     */
    run(spec: {
      profileId: string                 // 必须是本 bundle manifest 声明的 subagent-profile
      input: {
        turns?: number                  // 给 K0 的构造提示：取最近 N 个 turn（默认 10）
        includeThinking?: boolean       // 默认 false
        promptPrefix?: string           // ≤ 2 KiB；仅作任务说明，与 K0 构造的 transcript digest 拼接
      }
      budget?: { costUSDMax?: number; tokenMax?: number; timeMsMax?: number }  // 只能收窄
      role?: string                     // 默认 'reflection'；未知 role 回落当前会话模型（§3.9）
    }): Promise<AgentRunResult>         // { runId, output: string, usage: Usage, stopReason }
  }

  //-------- ★ 后台 job 调度（hook 5s 同步语义之外的长任务通道，§2.6）--------
  jobs: {
    /**
     * 注册一个 idle-only job。K0 调度器：Runner idle 时才执行（无活动 turn / 无流式 / 无进行中 job）；
     * per-plugin single-flight，同名 job 合并；新 turn.started 抢占（AbortSignal）；job 超时 90s。
     * 无 manifest 门槛；配额 K0 强制：队列深 ≤ 8/plugin，超即拒（schedule reject）。
     */
    schedule(spec: {
      name: string
      when: 'idle'                      // v1 只有 idle
      run: (ctx: { signal: AbortSignal }) => Promise<void>
    }): Disposable
  }

  //-------- ★ /status 面板 section 贡献（ui-surface surface 的运行时 API）--------
  ui: {
    // ... §6.4.1 既有 confirm/prompt/pick/notify 不变 ...
    /**
     * 向 /status 面板贡献一个只读 section（§11.3.14 数据契约、§7.10 渲染）。
     * 纯数据渲染：返回值只允许 string/number/boolean；K0 做 control-character guard；
     * 单 section ≤ 20 行；面板打开时与各事件后重取。manifest 必须声明 `permissions.ui.status = true`。
     */
    status: {
      registerSection(spec: {
        id: string                      // 面板内唯一；冲突拒绝
        title: string
        render(): { rows: [string, string | number | boolean][] } | null  // null = 本 session 不渲染
      }): Disposable
    }
  }
}
```

**边界**：

- `agents.run` 的返回文本是**模型生成的不可信内容**：消费方（含 §21 的 JSON 契约校验）必须自行校验，K0 不保证其结构。
- `jobs` 不是通用 worker 池：`run` 里仍只能调 bridge API，受全部既有权限约束；job 不得阻塞等待用户输入（非 TTY 下降级语义同 §6.4.1 `ui`）。
- `ui.status.registerSection` 不能注入交互组件、不能渲染 ANSI escape、不能读写其他 section；K0 渲染器把值当纯文本。
- 三个 API 在 ABI v2（§19.6）下的对应 surface：`subagent-profile` / `hook` 调度语义 / `ui-surface`；v1 声明缺失对应 permission 时调用直接 reject（deny-by-default）。

#### 6.4.2 完整插件示例

```js
// index.js — 纯 ESM，无 import 其它 Node API
export default {
  name: 'git-helper',
  version: '1.2.0',

  async activate(apollo) {
    // 1. 注册工具
    apollo.tools.register({
      name: 'git-status',
      description: 'Show git status of current repo',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      permission: { bash: { command: 'git status --porcelain' } },
      async handler(_input, ctx) {
        const { stdout } = await apollo.exec('git status --porcelain')
        return { content: [{ type: 'text', text: stdout || '(clean)' }] }
      }
    })

    // 2. 注册 hook：阻止危险 rm
    apollo.hooks.on('preToolUse', async (event) => {
      if (event.tool === 'Bash' && /\brm\s+-rf\b/.test(event.input.command)) {
        return { veto: true, reason: 'blocked by git-helper: rm -rf detected' }
      }
    })

    // 3. ★ 贡献系统提示词
    apollo.prompt.contribute({
      id: 'git-context',
      priority: 50,
      when: async () => apollo.fs.exists('.git'),
      text: async () => {
        const { stdout: branch } = await apollo.exec('git rev-parse --abbrev-ref HEAD')
        return `You are in a git repository. Current branch: ${branch.trim()}.
When making changes, prefer atomic commits and clear commit messages.`
      }
    })

    // 4. Slash 命令
    apollo.commands.register({
      name: '/gitlog',
      description: 'Show recent commits',
      async handler(_args, ctx) {
        const { stdout } = await apollo.exec('git log --oneline -20')
        ctx.output.text(stdout)
      }
    })

    apollo.log.info('git-helper activated')
  },

  async deactivate() {
    // Disposable 会被兜底释放；这里做插件自己的清理
  }
}
```

#### 6.4.3 沙箱：Rust 子进程 + JSON-RPC Bridge

**心智**：插件是第三方 JS 代码，与 Bash 命令**同属"用户信任但需要真实隔离"的类别**。§5 的 `apollo-sandbox` 已为 Bash 建立 Rust 沙箱基础设施；插件复用同一套框架，避免"最需要沙箱的地方反而没沙箱"的自相矛盾。

**架构总览**：

```
apollo 主进程 (Node)                        apollo-sandbox 子进程 (Rust bin)
                                            └─ execve Node w/ sandbox profile
┌──────────────────────┐  JSON-RPC (fd 3)   ┌──────────────────────┐
│ plugin-runtime       │◄──────────────────►│ plugin-host.mjs      │
│  ├─ 生命周期管理     │                    │  ├─ 建立 RPC 连接    │
│  ├─ RPC 服务端       │                    │  ├─ 构造 apollo 代理  │
│  ├─ permission/quota │                    │  ├─ import(index.js) │
│  ├─ zod 参数校验      │                    │  └─ 调 activate      │
│  └─ 每插件一进程     │                    └──────────────────────┘
└──────────────────────┘                    sandbox profile：
        │                                    - fs: 只读 pluginDir + rw dataDir
        ▼                                    - net: 依 manifest 白名单
   permission / native-bridge / core         - no execve / no ptrace / no mmap-w+x
```

**为什么每插件一子进程**（而不是所有插件共享一个 host 进程）：
- 隔离最强：一个插件失控/崩溃/OOM 只影响自己
- profile 精细化：每插件的 sandbox permissions 独立生成
- 资源守护实现直接：可以对进程用 `setrlimit`（cpu / mem / fd）+ 强制 `kill`

**代价**：每插件 ~30-50MB Node RSS。可接受（正常用户 < 10 个插件），且相比"vm 不是真沙箱"的安全叙事漏洞，这是值得付出的代价。

**加载流程**：

```
plugin-runtime.load(pluginDir):
  1. 读 manifest.json → schema + engines + 权限校验
  2. UI 展示 contributes + permissions → 用户确认（首次或权限变更时）
  3. 从 manifest.permissions 生成 sandbox profile（复用 §5.3 规则）
  4. 通过 native-bridge 启动子进程：
       apollo-sandbox --run-plugin \
         --entry <pluginDir>/index.js \
         --data-dir <dataDir> \
         --sandbox-profile <profile-json> \
         --bridge-fd 3
     apollo-sandbox 内部：应用 landlock/sandbox-exec profile 后 execve node
  5. 子进程内 plugin-host.mjs 通过 fd 3 建立 NDJSON JSON-RPC 通道
  6. plugin-host 动态 import(index.js) → default export
  7. plugin-host 构造 apollo 代理对象（每方法调用转成 RPC request）
  8. 调 activate(apollo)，超时 10s；失败/超时 → 主进程 SIGKILL + 卸载
  9. 主进程收到 RPC 请求 → manifest.permissions.apollo 白名单校验 →
     zod 参数校验 → permission/quota → 转发到 core/tool-kit/hooks
```

**RPC 协议**：JSON-RPC 2.0 over NDJSON (fd 3, 双向)

- request（child → parent）：`{"jsonrpc":"2.0","id":1,"method":"apollo.tools.register","params":{...}}`
- response（parent → child）：`{"jsonrpc":"2.0","id":1,"result":{...}}` 或 `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}`
- notification（parent → child）：`{"jsonrpc":"2.0","method":"session.turn.started","params":{...}}` —— 用于事件推送（`apollo.session.on` / `apollo.plugin.on`）

**★ 出站（main → plugin）事件背压（REVIEW-r6 P0-4）**：入站方向有 §6.11.2 L3 的 500 calls/turn 上限，但**出站事件推送**也必须有界，否则插件若慢消费 / 不消费，主进程发送缓冲堆积反压回主进程 EventBus。契约：
- 主进程对**每个插件**维护一个**有界事件队列**（默认 capacity 256，可配 `manifest.permissions.apollo` 的 `max_event_queue` 覆盖）。
- 队列满时按**丢弃策略**处理（默认 `drop_oldest`，可配 `drop_newest` / `block`）：丢弃前 emit `plugin.event.dropped` telemetry（含 plugin 名 + event 类型 + 队列深度）。
- 高频事件（`stream.delta` 已默认不推给插件；若插件显式订阅 `message.appended` / `tool.requested` 等较高频事件）受队列约束；插件订阅时主进程给一个 rate hint（`max_events_per_sec`，默认 50）。
- `block` 策略仅用于插件声明 `permissions.apollo` 含 `event.blocking` 时（罕见，主进程会暂停该事件源，可能拖慢 turn —— 需用户显式 opt-in）。
- 子进程侧 plugin-host 收到 notification 后分发到已注册 handler；handler 慢 → 子进程自己的 NDJSON 解析缓冲堆积 → 由子进程的 `setrlimit(RLIMIT_AS)` 兜底 OOM kill（§6.11.2 L4），不反压主进程。

**附件传递**（handle-token 模式）：
- 主进程持有 `AttachmentRef.handle`（native pointer 绝对不出主进程）
- 传给插件的 Message 里 handle 被 strip 成不透明 token（`att_${uuid}`）
- 插件调 `apollo.fs.readAttachment(token)` → 主进程解 token → permission 校验 → 通过 RPC response 回传 bytes
- 大附件（> 8MB）走分片：`apollo.fs.readAttachment(token, { chunk: 64_000 })` 返回 AsyncIterable

**bridge 服务端**（主进程 `plugin-runtime`）实现要点：
- 每个 RPC 方法是一个 async handler，签名 `(pluginId, params) => result`
- 白名单：`manifest.permissions.apollo` 未声明的 method → 直接 `-32601` Method not found
- 参数：全部走 zod schema（`packages/plugin-sdk` 里定义的类型对应的 schema）
- 敏感操作（fs.write / exec / http）二次转发到 `permission` → `apollo-sandbox exec` 或 `http-kit`
- 记 telemetry：`plugin:<name>:<method>` + duration + result kind + error class

**bridge 客户端**（子进程 `plugin-host.mjs`）实现要点：
- 提供 `apollo` proxy，接口面与 §6.4.1 `ApolloBridge` 一致
- 每方法：生成 request id → 写 NDJSON 到 fd 3 → 用 Map<id, resolver> 等待响应
- notification 分发到已注册的 `on(event, handler)` 监听器
- 无 `require` / `process` / `global` / `Buffer` / `fetch` 顶层暴露 —— 靠 **Rust sandbox 的 syscall 过滤**（主防线）+ **Node ESM 起步**（次防线）+ **plugin-host 用 IIFE 包一层 delete globals**（辅助），任一都不是安全底线
- 崩溃 → apollo-sandbox 感知子进程退出 → 通知主进程 → 主进程 emit `error.raised` + 触发 disable 策略（见 §6.11.2）

**Node runtime 的选择**：
- 复用系统 Node（apollo 本身运行的那个 Node，一定可用）
- apollo-sandbox 在 sandbox profile 内 execve `process.execPath`
- profile 需允许：读 Node 二进制 + 读 Node 内置模块路径 + 读 pluginDir + 读写 dataDir + 读 IPC fd

**用户插件的 index.js 形态**：
- 单文件 ESM，作者用 `tsdown` / `esbuild` pre-bundle（不含 npm 依赖拉取）
- 允许纯计算的 npm 依赖（bundle 到 index.js 里）
- 禁止运行时 `import('some-npm-pkg')` —— 子进程内没有 node_modules 可读
- SDK 层 `@apollo-code/plugin-sdk` 只是**编译期类型辅助 + `definePlugin/defineTool` 身份函数**，运行时零依赖

**"静态 AST 检查"降级说明**：从 v1 起，AST 扫描（拒绝 `eval` / `new Function` 等）**不再是安全底线**，降级为**"作者友好检查"**（拦低级错误 + typo）。真正的隔离靠：
1. **Rust sandbox 进程 + syscall 过滤** —— 主防线
2. **JSON-RPC bridge 白名单** —— 能力面
3. **manifest.permissions 用户显式批准** —— 用户面

**决策对照**：

| 维度 | Rust sandbox 子进程（选） | node:vm | worker_threads |
|---|---|---|---|
| 隔离强度 | ✅ 进程 + syscall + 与 Bash 同框架 | ❌ 同 heap，仅能力控制 | ⚠️ 同进程 v8 isolate |
| 崩溃影响 | ✅ 主进程无感 | ❌ 主进程崩 | ⚠️ 内存共享有波及 |
| CPU/mem 限制 | ✅ setrlimit + kill | ❌ 无 | ⚠️ resourceLimits 粗粒度 |
| 附件传递 | handle token（一次 RPC） | 直接传引用 | postMessage 序列化 |
| bridge 延迟 | ~1-5ms/call | ~1µs | ~ms |
| Rust 一致性 | ✅ 与 §5 沙箱统一 | ❌ 割裂 | ❌ 割裂 |
| 实现复杂度 | 中（复用 apollo-sandbox） | 低 | 中 |

**延迟评估**：插件 hook / bridge 调用不在热路径（`stream.delta` 不跨 RPC，只有插件订阅的高层事件才推 notification）。一个 turn 的 bridge 调用通常 <20 次，5ms/次 完全接受。真正的热路径（provider 流式增量分发）仍在主进程内。

**Windows 支持策略**（r9 调整：Windows Tier 推 L2）：与 §5.4.3 Tier 阶梯一致 ——
- **L1（mac/linux only）**：Windows 上插件宿主**不可用**（`--run-plugin` 在 Windows L1 未交付，sandbox 二进制未发 Windows target）。Windows 用户 L1 阶段无法加载插件。
- **Tier 1（Job + Restricted Token，L2 起交付）**：插件可在 `apollo-sandbox --run-plugin` 子进程内跑，profile 受 Tier 1 能力限制（资源上限 + 特权剥离，**无 fs/syscall 细粒度隔离**）；UI 走 §14.3b Weak Tier 披露（首屏 + 每次弹窗红条）。
- **Tier 2（AppContainer + ACL，L2 起）**：插件子进程获得 fs 白名单隔离（`pluginDir` 只读 / `dataDir` 独占），与 mac/Linux 行为对齐。
- **Tier 3（WFP net，L3 起）**：再加网络白名单，达到 Full。

> 旧表述"L1-L4 Windows 无原生沙箱，插件默认拒绝加载"**作废**（r7/r8 沙箱硬约束 + r9 平台范围调整：Windows Tier 1 从 L1 推到 **L2** 起交付，见 SANDBOX-COMPAT §S6.2 / §10 L2）。Windows 上**无 `--dangerous-no-sandbox` 时不再整体拒载插件**（L2 起），仅按当前 Tier 限制 profile 强度并显式披露。

