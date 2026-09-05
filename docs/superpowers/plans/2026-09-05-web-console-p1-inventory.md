# P1-01 Composition Inventory — `createProductionPorts`（2026-09-05）

> **基线 SHA**：`7f6f026`（feat/core-capabilities-r19 HEAD；含 Cordis 内核 S0/S1）
>
> **回归基线**：`pnpm --filter @volund/cli test` = 25 文件 / 293 用例全绿；`pnpm build` 27 任务全绿
>
> **来源**：[Web 实施计划](../plans/2026-08-28-volund-web-console.md) P1-01；对象文件 [runtime.ts](../../../apps/cli/src/runtime.ts)（4606 行，`createProductionPorts` 占 2191–4551）

本文是 §22 P1（抽取 UI-neutral `packages/app-runtime`）的前置盘点：按域列出 `createProductionPorts` 的构造、I/O、host adapter、controller、UI 引用、副作用与 cleanup，并给出 CLI-only / shared 的分类。**任何条目不得在抽取时漏分类。**

## 1. 构造总览（按文件内顺序）

| # | 域 | 构造物 | 生命周期 | 分类 |
|---|---|---|---|---|
| A | 应用级内核 | `appKernel = new Context()` + `UiService`；`liveToolServices: Set<ToolsService>` | 进程级 | shared |
| B | 本地存储 | `BackupStore`、`EvolutionStore`、`LocalMemoryRepository`、`LocalKeywordMemoryIndex`、`FileInputHistoryStore`、`DirectoryTrustStore`、`Telemetry`/`LocalTelemetrySink`/`TelemetryStore`、`TelemetryLogger`、`PermissionRuleStore` | 进程级，home 派生路径 | shared |
| C | 插件生命周期 | `PluginManager`（legacy，deny-only）、`LocalPluginStateStore`（v2 唯一状态源）、`loadedPluginEntries`、`localPluginHub`、market 索引缓存、`activateLocal/unloadPlugin/inventory/inspect/install/approve/enable/disable/uninstall`、`localPlugins` 端口（builtin/dev/market 三源发现） | 进程级；`init()` fire-and-forget；`deactivateAll()` 在 shutdown | shared |
| D | Memory 服务 | `IndexingMemoryService`、`DefaultMemoryRecallService`、`DefaultMemoryMaintenanceService`、`MemoryTransferService` | 进程级；`memory.flush()` 在 session end | shared |
| E | 斜杠命令 | `MutableSlashCommandRegistry`（插件命令 + skill 命令汇入；UI subscribe 热更新） | 进程级 | shared |
| F | 凭据/认证 | `promptSecret` passphrase 闭包（readline）、`EncryptedCredentialStore`、`AuthManager`、`readAuthSection`、`readAnthropicBaseUrl` | 进程级；passphrase 缓存于闭包 | **CLI-only 输入**（passphrase prompt）+ shared store |
| G | 网络/权限策略 | `NodeHttpPort`（HTTPS_PROXY/CONNECT 隧道/h2→h1 回退）、`ProductionPermissionSessionPolicy` | 进程级 | shared |
| H | Skills | `skillsRuntimes: Set`、`skillsDisabled`、`ensureSkillsConfig`（读 user config）、`SkillSlashCommands`、`skillsPanelController`、`skillPort`（CLI 一次性）、`listingSkillsRuntime` | 进程级配置 + 每会话 runtime | shared；`skillPort` 里 `process.cwd()` 需参数化 |
| I | MCP | `mcpDisabled`、`ensureMcpManager`（runtime 级单例 McpManager，惰性连接）、`mcpPort`（CLI 一次性，4s 有界等待 + close）、`mcpPanelController` | 单例常驻；shutdown 时 close | shared；`process.cwd()` 需参数化 |
| J | Subagent | `subagentsPanelController`（dispatcher 背书）、`AgentDefinitionRegistry`（`<home>/agents` + `<cwd>/.volund/agents`） | 进程级 | shared |
| K | 面板注册 | `appKernel.ui.registerPanel('skills'/'mcp'/'subagents')` | 进程级 | shared |
| L | 权限交互管线 | `interactivePermissionPrompt` 可变槽、`streamToStdout` 可变槽 | 进程级可变槽，由 UI adapter 回填 | **界面接缝**（app-runtime 暴露 setter，UI 注册实现） |
| M | `createRunner`（每会话） | 见 §2 | 会话级 | shared，除标注项 |
| N | `RuntimeSessionPort` | 会话 port：sessions 目录持久化 + runnerFactory + status snapshot adapter + background shells | 进程级 | shared |
| O | `VolundPorts` 返回面 | 见 §3 | — | 混合 |

## 2. `createRunner`（每会话组合，~3300–3900）

按装配顺序：

1. **权限链**：`permissionPolicy.snapshotFor(state)` → `permissionRules.ready()` → `createProductionToolPermissionChain`（每 Runner 一个 PermissionManager，子会话不继承父缓存）；顶层会话挂 `activePermissionControl`（/mode）与 `activeSkillGrants`（回合级 ephemeral grant）。
2. **会话内核**：`kernel = new Context()` + `ModelService` + `BusService(events)` + `SessionService(state)`；`turn.completed/aborted` 清空 ephemeral grant。
3. **配置/调优**：`loadProductionContextTuning`（用户 config.toml + EvolutionEngine 值）；`skipAuth` 判定；provider 段读取（anthropic/openai/gemini/ollama）；`preferences.model`（含 `[models.aliases]` 解析）与 `preferences.language`。
4. **Prompt 组装**：`SlidingWindowPolicy`（tuned 值）、`DefaultPromptComposer` + builtin fragment + **已激活插件 prompt（H3，id 命名空间 `plugin:<name>:`）** + language fragment + `registerRuntimeMemoryPrompts` + `PromptLoader`（项目 prompt）+ agent 定义正文（untrusted 包裹）。
5. **Skills**：`SkillsRuntime`（sources 惰性含插件捆绑 skills 目录——SM-08b）；`skillsRuntimes.add`；discover/registerIndex/activateAutomatic；`syncSkillSlashCommands`。
6. **Provider**：`AttachmentStore`；`AnthropicClient`（凭据经 AuthManager，skipAuth 旁路）+ **`streamToStdout` 包装（CLI-only：text.delta 直写 stdout）**；`kernel.model.registry` 注册 anthropic + 可选 openai/gemini/ollama（回环判定）。
7. **Router**：`SingleProviderRouter`（options.model ?? configuredModel ?? 默认）→ `[router] type=fallback` 换 `FallbackRouter` → `type=role` 换 `RoleRouter` → agent 定义指定 provider/model 再覆盖。
8. **工具**：`kernel.plugin(ToolsService)` + `liveToolServices.add`；`session.ended` 摘除 + H5 生命周期事件广播给插件 hooks；`builtinToolDomains`（F1 域门控 `builtinToolsDisabled`）→ memory 工具 + `createSkillTool`（orchestration 域）→ **插件工具经 `registerPluginTool` 注册（G）** → `ensureMcpManager(state.cwd).attach(registry)`。
9. **沙箱与执行**：`createSandboxNativeBridge`（`runner.state.cwd` 闭包）→ `kernel.plugin(SandboxService, native)`；`createPluginHookDispatcher`（H1 pre/postToolUse）→ `permissionChain.bindExecutor`（context 含 `ui.requestInput: promptLine`——**CLI-only**）。
10. **Runner**：`RunnerToolPort`（agent tools 白名单双过滤）→ `new Runner(...)`（agent maxTurns 映射 maxToolLoopsPerTurn）。

**`createRunner` 内的 CLI-only 点**：`streamToStdout` 读取（#6）、`promptLine` 进 ToolContext.ui（#9）。两者都应成为 app-runtime 的显式 host port。

## 3. `VolundPorts` 返回面分类

| 键 | 内容 | 分类 |
|---|---|---|
| `identity`/`version` | 产品身份 | shared |
| `session` | `RuntimeSessionPort`（list/create/resume/submit/interrupt/end/undo/快照） | **shared — SessionController 前身** |
| `history` | 会话档案只读检视 | shared |
| `ui` | `renderInteractiveApp`（Ink）、`renderDirectoryTrustPrompt`、`renderSessionPicker` | **CLI-only** |
| `trust` | `DirectoryTrustStore` | shared — WorkspaceController 前身 |
| `restore`/`evolution` | 备份恢复 / 自演化审计 | shared |
| `memory`/`memoryRecall`/`memoryMaintenance`/`memoryTransfer` | Memory 四服务 | shared — MemoryController 前身 |
| `plugin` | legacy deny-only 端口 | shared（语义冻结，Web 只读展示 contained） |
| `localPlugins` | 本地插件 v2 生命周期 | shared — PluginController 前身 |
| `skill`/`mcp` | CLI 一次性管理端口 | shared — SkillController/McpController 前身 |
| `telemetry` | securityEvent/summary/export/clear/health | shared — TelemetryController 前身 |
| `confirmation` | `confirmDangerousNoSandbox`（`promptLine`） | **CLI-only 输入** |
| `auth` | health/login/logout（login 含 `promptSecret`） | shared，login 的交互输入需 host port 化 |
| `config` | applyEnv/health/status/updatePreference/listMerged/setValue/unsetValue/filePaths | shared — ConfigController 前身 |
| `native` | available/startProbes/probe/health | shared — StatusController 数据源 |
| `shutdown` | `localPlugins.deactivateAll()` + `mcpManager.close()` | shared — RuntimeShutdown 前身 |

## 4. Host I/O 清单（app-runtime 必须显式注入的 ports）

| Host 能力 | 现状位置 | app-runtime 接口 |
|---|---|---|
| stdout 流式回显 | `streamToStdout` 槽 + anthropic client 包装 | `RuntimeHostPorts.streamEcho?: (text) => void` |
| 行输入 | `promptLine`（ToolContext.ui、confirmation） | `RuntimeHostPorts.promptLine` |
| 凭据密语输入 | `promptSecret`（passphrase、login） | `RuntimeHostPorts.secretPrompt` |
| 权限交互 | `interactivePermissionPrompt` 槽 | PermissionController 的 decision source；Web 为队列，TUI 为卡片 |
| 时钟/随机 | 散见 `Date.now()` | 首版可后置（测试缝已存在于 permission chain options） |
| 浏览器打开 | 尚不存在（P2 web-server 新增） | `RuntimeHostPorts.openBrowser` |
| `process.cwd()` | `skillPort`/`mcpPort`/`agentRegistry` | 构造参数 `defaultCwd` |

## 5. 副作用与 cleanup 清单

| 副作用 | 时机 | cleanup |
|---|---|---|
| `plugins.init()` / `localPluginState.init()` | 构造时 fire-and-forget（`void ...catch`） | 无（只读装载） |
| MCP stdio/SSE 连接 | `ensureMcpManager` 惰性；`void mcpManager.connect()` | `shutdown()` → `manager.close()` + `logsFlushed()` |
| 插件宿主 fd3 桥进程 | `activateLocalPlugin` | `shutdown()` → `localPlugins.deactivateAll()`；单个 unload 走 `unloadPlugin` |
| 后台 shell | `BackgroundShells` 进程级 | `session.ended` 统一 kill（RuntimeSessionPort.activate 内挂接） |
| skills Runtimes | 每会话 `skillsRuntimes.add` | 会话结束未显式移除（集合随进程终结；Web 长驻需补 remove）⚠️ |
| permission rules | `permissionRules.ready()` 每 Runner | 进程共享单例，无 cleanup |
| market 索引缓存 | 60s TTL | install/uninstall 失效 |

⚠️ 标注项 = Web 长驻 server 场景的新需求，TUI 单进程生命周期下不暴露。

## 6. 抽取依赖序（P1-02 起）

```text
✅ P1-02 packages/app-runtime 骨架 + RuntimeHostPorts/AppRuntime 类型（cb146dc）
  ✅ P1-02a 内核组装：createAppKernel / createSessionKernel（Cordis 服务形态）
    ✅ P1-03 SessionController：RuntimeSessionPort 迁入 app-runtime（Cordis service），
       turn mutex（session_turn_in_progress）落地；InteractiveSession/权限契约/SessionCandidate
       /SubmitOptions/TranscriptEntry 契约迁入 contracts.ts，ui/ports 以 re-export 兼容。
       偏差记录：start → startSession 改名（Cordis Service 保留 start/stop 生命周期钩子）；
       idempotency/revision 与多会话注册表留待 P2（Web server 起按需加）。
      ✅ P1-04 域 controllers（c6122fe/12e1a57/50314e4/7f2cf81/f9ba386）：
         status-view/welcome/session-stats + memory 全家桶 + skill/mcp/plugin/auth/
         config/native 域工厂（createSkillDomain/createMcpDomain/createPluginDomain/
         createAuthDomain/createConfigDomain/createNativeDomain）；ports.ts 子契约迁入；
         ui 侧 status/skills-panel/mcp-panel/list-picker/tabbed-list/memory-panel 契约
         迁入并留 re-export shim。runtime.ts 4606→1640 行。
         偏差记录：serializeToml 与 preferences 写盘序列化器是两个不同实现（未合并）；
         builtinPluginRoot 锚点留 CLI 包（import.meta.url）+ 位置无关内核在 app-runtime；
         readAuthSection 迁移中曾短暂反转 ENOENT 分支（被 CLI 测试当场抓住，已修）。
        └─ P1-06 ui-model 归属（大头已随 P1-04 落地；余 formatter/ANSI 边界清点）
          └─ P1-07 CLI 改经 app-runtime 组装（本文件退化为 host adapter 接线）
             剩余：createRunner 会话装配（provider/router/tools 接线）、NodeHttpPort/proxy
             网络宿主适配、FileInputHistoryStore、subagents 面板、hook-signal 映射
```

每一步的完成判定：基线（25 文件 / 293 用例）+ 相关包测试全绿，且 `runtime.ts` 只减不增。

## 7. 明确不做（本阶段）

- 不改 `VolundPorts` 的对外形状（cli.ts/commands 零改动）。
- 不把 provider client、tool 实现、storage 实现搬进 app-runtime——它们留在原包，app-runtime 只做组合。
- 不引入 HTTP/SSE 任何东西（P2 才开始）。
